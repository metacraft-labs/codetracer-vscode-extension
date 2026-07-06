/**
 * M7 — Value Origin Tracking fixture-discovery + prerequisite helpers
 * for the VS Code WebdriverIO suite.
 *
 * This is the WDIO mirror of the Electron-side helper at
 * `codetracer/src/tests/gui/lib/value-origin-fixtures.ts`. The shape and
 * prerequisite discipline are intentionally identical so the same environment
 * gates both layers cleanly.
 *
 * Three responsibilities:
 *
 * 1. **Fixture path resolution.**  M0 fixtures live in the codetracer
 *    repo at `$CT_REPO/src/db-backend/tests/fixtures/origin/<lang>/<scenario>/`.
 *    The WDIO suite consumes them through a synced local copy under
 *    `test/wdio/fixtures/origin/<lang>/<scenario>/` — populated by the
 *    `syncValueOriginFixtures` hook in `wdio.conf.ts` from the codetracer
 *    repo pointed to by `$CT_REPO`.  The sync hook may symlink (POSIX
 *    dev shells) or rsync (CI) the tree; `originFixturePath(...)` only
 *    cares that the synced layout matches the source layout.
 *
 * 2. **Recorder availability probes.**  Same heuristics the Playwright
 *    helper uses: python3 imports `codetracer_python_recorder`, ruby +
 *    `codetracer-ruby-recorder` on PATH, node + `codetracer-js-recorder`
 *    on PATH.  When a probe fails, the spec fails with a precise reason
 *    instead of throwing a timeout 30s later.
 *
 * 3. **VS Code-specific prerequisite probe.**  The VS Code path needs
 *    the extension's TypeScript compilation AND a `ct` binary on PATH
 *    (or a configured `codetracer.runnablePath`) so that
 *    `vscode.debug.startDebugging({type:"codetracer-debug",...})` can
 *    resolve a DAP server.  `ctBinaryReason()` reports a precise failure
 *    string when neither is available.
 */
import * as childProcess from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

/** Repo root of the VS Code extension repo. */
const repoRoot = path.resolve(__dirname, "..", "..", "..")

/**
 * Local destination of the synced fixture tree. Mirrors the codetracer
 * repo layout one-to-one. Populated by the `syncValueOriginFixtures`
 * `onPrepare` hook in `wdio.conf.ts`.
 */
export const localFixtureRoot = path.join(
  repoRoot,
  "test",
  "wdio",
  "fixtures",
  "origin",
)

/**
 * Source-of-truth fixture root in a sibling codetracer checkout. The
 * env var `CT_REPO` lets CI / contributors point at any checkout (e.g.
 * `~/work/codetracer`); when unset we fall back to the conventional
 * sibling path used by `.envrc` in the codetracer-vscode-extension repo.
 */
export function codetracerFixtureRoot(): string {
  const envPath = process.env.CT_REPO?.trim()
  if (envPath && envPath.length > 0) {
    return path.join(envPath, "src", "db-backend", "tests", "fixtures", "origin")
  }
  // Conventional sibling layout: <parent>/codetracer next to
  // codetracer-vscode-extension.
  return path.join(
    repoRoot,
    "..",
    "codetracer",
    "src",
    "db-backend",
    "tests",
    "fixtures",
    "origin",
  )
}

export function codetracerRepoRoot(): string {
  const envPath = process.env.CT_REPO?.trim()
  if (envPath && envPath.length > 0) {
    return envPath
  }
  return path.join(repoRoot, "..", "codetracer")
}

export type SupportedLanguage = "python" | "ruby" | "javascript" | "rust" | "c" | "cpp" | "nim" | "go" | "d"

/**
 * Absolute path to the fixture's source program inside the locally
 * synced tree.
 */
export function originFixturePath(
  language: SupportedLanguage,
  scenario: string,
): string {
  const fileName = (() => {
    switch (language) {
      case "python":
        return "main.py"
      case "ruby":
        return "main.rb"
      case "javascript":
        return "main.js"
      case "rust":
        return "main.rs"
      case "c":
        return "main.c"
      case "cpp":
        return "main.cpp"
      case "nim":
        return "main.nim"
      case "go":
        return "main.go"
      case "d":
        return "main.d"
    }
  })()
  const fixturePath = path.join(localFixtureRoot, language, scenario, fileName)
  try {
    return fs.realpathSync(fixturePath)
  } catch {
    return fixturePath
  }
}

export function originFixtureTracePath(
  language: SupportedLanguage,
  scenario: string,
): string {
  const traceRoot = path.join(localFixtureRoot, language, scenario, "trace")
  if (traceFolderDirectlyMaterialized(traceRoot)) {
    return traceRoot
  }
  try {
    const child = fs.readdirSync(traceRoot)
      .map((entry) => path.join(traceRoot, entry))
      .filter((candidate) => {
        try {
          return fs.statSync(candidate).isDirectory()
        } catch {
          return false
        }
      })
      .sort()
      .find((candidate) => traceFolderDirectlyMaterialized(candidate))
    if (child) {
      return child
    }
  } catch {
    // The caller's materialization check reports the precise missing path.
  }
  return traceRoot
}

export function crossProcessFixtureRoot(): string {
  return path.join(
    codetracerRepoRoot(),
    "src",
    "db-backend",
    "tests",
    "fixtures",
    "cross_process",
    "account-balance-with-wasm",
  )
}

export function crossProcessTracePath(name: "frontend.ct" | "frontend-wasm.ct" | "backend.ct"): string {
  return path.join(crossProcessFixtureRoot(), name)
}

function traceFolderDirectlyMaterialized(traceFolder: string): boolean {
  try {
    if (!fs.statSync(traceFolder).isDirectory()) {
      return false
    }
  } catch {
    return false
  }
  return (
    fs.existsSync(path.join(traceFolder, "trace.json")) ||
    fs.existsSync(path.join(traceFolder, "trace_metadata.json")) ||
    fs.existsSync(path.join(traceFolder, "trace_db_metadata.json")) ||
    fs.existsSync(path.join(traceFolder, "rr")) ||
    fs.existsSync(path.join(traceFolder, "meta.dat")) ||
    fs.readdirSync(traceFolder).some((entry) => entry.endsWith(".ct"))
  )
}

export function traceFolderMaterialized(traceFolder: string): boolean {
  if (traceFolderDirectlyMaterialized(traceFolder)) {
    return true
  }
  try {
    return fs.readdirSync(traceFolder).some((entry) => {
      const candidate = path.join(traceFolder, entry)
      try {
        return fs.statSync(candidate).isDirectory() &&
          traceFolderDirectlyMaterialized(candidate)
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

/** True when the locally synced fixture exists on disk. */
export function fixtureSynced(
  language: SupportedLanguage,
  scenario: string,
): boolean {
  try {
    return fs.statSync(originFixturePath(language, scenario)).isFile()
  } catch {
    return false
  }
}

/**
 * Probe whether a `ct` binary the M7 specs could use is reachable. The
 * VS Code extension's debug-adapter factory resolves the DAP server
 * either from `codetracer.runnablePath` or from `replay-server`/
 * `db-backend` on PATH (see `src/extension.ts::resolveDapServerPath`).
 * For the M7 specs we additionally need the recorder binary (`ct`) so
 * `ct-vscode.loadCurrentFile` can record the fixture on demand.
 */
export function ctBinaryReason(): string | null {
  const explicit = process.env.CODETRACER_PATH?.trim()
  if (explicit && fs.existsSync(explicit)) {
    return null
  }
  if (findOnPath("ct") !== null) {
    return null
  }
  return (
    "ct binary not on PATH and CODETRACER_PATH not set — " +
    "the extension cannot record/load the fixture trace without it"
  )
}

function findOnPath(binary: string): string | null {
  const r = childProcess.spawnSync("sh", ["-c", `command -v ${binary} 2>/dev/null`], {
    encoding: "utf-8",
    timeout: 5_000,
    windowsHide: true,
  })
  if (r.status !== 0) {
    return null
  }
  const trimmed = (r.stdout ?? "").trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Probe whether `ct record` is likely to succeed for Python. Returns
 * null when prerequisites are met, or a human-readable reason string.
 */
export function pythonRecorderUnavailableReason(): string | null {
  const candidates = [
    process.env.CODETRACER_PYTHON_INTERPRETER?.trim(),
    "python3",
    "python",
    path.join(codetracerRepoRoot(), ".python-recorder-venv", "bin", "python"),
  ].filter((candidate): candidate is string => Boolean(candidate && candidate.length > 0))

  for (const python of candidates) {
    if (
      python.includes(path.sep) &&
      !fs.existsSync(python)
    ) {
      continue
    }
    const r = childProcess.spawnSync(
      python,
      ["-c", "import codetracer_python_recorder"],
      { encoding: "utf-8", timeout: 5_000, windowsHide: true },
    )
    if (r.status === 0) {
      return null
    }
  }

  const r = childProcess.spawnSync(
    "python3",
    ["-c", "import codetracer_python_recorder"],
    { encoding: "utf-8", timeout: 5_000, windowsHide: true },
  )
  if (r.status === 0) {
    return null
  }
  return (
    "codetracer_python_recorder module not importable from python3 " +
    "(install codetracer-python-recorder or activate the .python-recorder-venv shell)"
  )
}

export function rubyRecorderUnavailableReason(): string | null {
  const ruby = childProcess.spawnSync("ruby", ["--version"], {
    encoding: "utf-8",
    timeout: 5_000,
    windowsHide: true,
  })
  if (ruby.status !== 0) {
    return "ruby is not available on PATH"
  }
  const env = process.env.CODETRACER_RUBY_RECORDER_PATH
  if (env && fs.existsSync(env)) {
    return null
  }
  if (findOnPath("codetracer-ruby-recorder") !== null) {
    return null
  }
  return (
    "codetracer-ruby-recorder not on PATH " +
    "(set CODETRACER_RUBY_RECORDER_PATH or install the recorder gem)"
  )
}

export function javascriptRecorderUnavailableReason(): string | null {
  const node = childProcess.spawnSync("node", ["--version"], {
    encoding: "utf-8",
    timeout: 5_000,
    windowsHide: true,
  })
  if (node.status !== 0) {
    return "node is not available on PATH"
  }
  const env = process.env.CODETRACER_JS_RECORDER_PATH
  if (env && fs.existsSync(env)) {
    return null
  }
  if (findOnPath("codetracer-js-recorder") !== null) {
    return null
  }
  return (
    "codetracer-js-recorder not on PATH " +
    "(set CODETRACER_JS_RECORDER_PATH or install the recorder)"
  )
}

/**
 * M11 — RR-backed origin spec probes for natively-compiled languages.
 *
 * The native-backend pipeline drives `rr` for record/replay and
 * `ct-native-replay` (formerly `ct-rr-support`) as the worker. Each
 * per-language spec additionally needs the source compiler on PATH.
 */
export function rrToolchainUnavailableReason(): string | null {
  if (findOnPath("rr") === null) {
    return "rr binary not on PATH (install rr to run RR-backed origin tests)"
  }
  const rrWorkerFallback = path.resolve(
    repoRoot,
    "..",
    "codetracer-native-backend",
    "target",
    "debug",
    "ct-native-replay",
  )
  if (
    findOnPath("ct-native-replay") === null &&
    findOnPath("ct-rr-support") === null &&
    !fs.existsSync(rrWorkerFallback)
  ) {
    return "ct-native-replay not on PATH (M11 RR specs need the native-backend replay worker)"
  }
  return null
}

export function rustRrRecorderUnavailableReason(): string | null {
  const tc = rrToolchainUnavailableReason()
  if (tc !== null) return tc
  if (findOnPath("rustc") === null) {
    return "rustc not on PATH (M11 Rust RR spec needs the Rust compiler)"
  }
  return null
}

export function cRrRecorderUnavailableReason(): string | null {
  const tc = rrToolchainUnavailableReason()
  if (tc !== null) return tc
  if (findOnPath("gcc") === null) {
    return "gcc not on PATH (M11 C RR spec needs a C compiler)"
  }
  return null
}

export function cppRrRecorderUnavailableReason(): string | null {
  const tc = rrToolchainUnavailableReason()
  if (tc !== null) return tc
  if (findOnPath("g++") === null) {
    return "g++ not on PATH (M11 C++ RR spec needs a C++ compiler)"
  }
  return null
}

export function nimRrRecorderUnavailableReason(): string | null {
  const tc = rrToolchainUnavailableReason()
  if (tc !== null) return tc
  if (findOnPath("nim") === null) {
    return "nim not on PATH (M11 Nim RR spec needs the Nim compiler)"
  }
  return null
}

export function goRrRecorderUnavailableReason(): string | null {
  const tc = rrToolchainUnavailableReason()
  if (tc !== null) return tc
  if (findOnPath("go") === null) {
    return "go not on PATH (M11 Go RR spec needs the Go compiler)"
  }
  return null
}

export function dRrRecorderUnavailableReason(): string | null {
  const tc = rrToolchainUnavailableReason()
  if (tc !== null) return tc
  if (findOnPath("ldc2") === null) {
    return "ldc2 not on PATH (M11 D RR spec needs the LDC2 D compiler)"
  }
  return null
}

/**
 * Aggregate prerequisite probe used at the top of every M7 spec. Composes the
 * individual probes in the order a real spec runs them: fixture must be
 * synced first (no point checking recorders otherwise), then ct binary,
 * then language-specific recorder.
 */
export function valueOriginSpecSkipReason(
  language: SupportedLanguage,
  scenario: string,
): string | null {
  if (!fixtureSynced(language, scenario)) {
    return (
      `Origin fixture ${language}/${scenario} not synced into ${localFixtureRoot} ` +
      `(set CT_REPO to a codetracer checkout containing the fixture catalogue)`
    )
  }
  const traceFolder = originFixtureTracePath(language, scenario)
  if (!traceFolderMaterialized(traceFolder)) {
    return `Origin fixture trace ${language}/${scenario} is not materialized at ${traceFolder}`
  }
  const ctReason = ctBinaryReason()
  if (ctReason !== null) {
    return ctReason
  }
  switch (language) {
    case "python":
      return pythonRecorderUnavailableReason()
    case "ruby":
      return rubyRecorderUnavailableReason()
    case "javascript":
      return javascriptRecorderUnavailableReason()
    case "rust":
      return rustRrRecorderUnavailableReason()
    case "c":
      return cRrRecorderUnavailableReason()
    case "cpp":
      return cppRrRecorderUnavailableReason()
    case "nim":
      return nimRrRecorderUnavailableReason()
    case "go":
      return goRrRecorderUnavailableReason()
    case "d":
      return dRrRecorderUnavailableReason()
  }
}
