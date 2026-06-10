import path from 'path'
import fs from 'fs'
import os from 'os'
import { execSync } from 'child_process'

/**
 * Garbage-collect any chromedriver / electron / wdio-vscode-service
 * processes left behind by a previous run.  Self-hosted runners reuse
 * the same machine across jobs, and an electron crash or a forcibly
 * cancelled run leaves the per-run user-data-dir lease in place — the
 * next session-create then fails with
 *   ``session not created: probably user data directory is already in use``
 * even though *this* run's user-data-dir is brand new.  Idempotent on
 * a fresh runner.  We deliberately match by command-line substring
 * rather than process tree because the previous run's parent shell is
 * already gone; only the orphaned children survive.
 *
 * Linux / macOS use ``pkill``; on Windows we use ``taskkill``.  Both
 * are non-fatal when no matching processes exist.
 */
function killLeftoverWdioProcesses(): void {
  const isPosix = process.platform !== 'win32'
  const kill = (pattern: string) => {
    try {
      if (isPosix) {
        execSync(`pkill -9 -f ${JSON.stringify(pattern)}`, { stdio: 'ignore' })
      } else {
        // Windows wmic-style kill: match by command line containing the pattern.
        execSync(
          `wmic process where "CommandLine like '%${pattern.replace(/'/g, "''")}%'" call terminate`,
          { stdio: 'ignore' },
        )
      }
    } catch {
      // No matching processes — that's the steady-state.  Ignore.
    }
  }

  // Order matters: kill the orchestrators (wdio-vscode-service /
  // electron) before chromedriver so chromedriver doesn't try to
  // restart them while we're tearing down.
  kill('wdio-vscode-service')
  kill('--user-data-dir=/tmp/wdio-vscode-ct')
  kill('--user-data-dir=' + path.join(os.tmpdir(), 'wdio-vscode-ct'))
  kill('chromedriver')

  // Reclaim the volatile storage root.  Per-run subdirs from prior
  // pids are dead weight on a long-lived self-hosted runner and they
  // can accumulate gigabytes.  Use ``rm -rf`` semantics that don't
  // explode if the path is missing.
  for (const dir of ['/tmp/wdio-vscode-ct', path.join(os.tmpdir(), 'wdio-vscode-ct')]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore — diagnostics handler will flag persistent failures
    }
  }
}

// Resolve chromedriver binary: prefer Nix-provided, fallback to npm package.
// The npm chromedriver binary won't run on NixOS (dynamically linked), so
// we look for a system chromedriver first.
function resolveChromedriverBinary(): string | undefined {
  // Check environment variable
  if (process.env.CHROMEDRIVER_PATH) return process.env.CHROMEDRIVER_PATH
  // Check PATH
  try {
    const fromPath = execSync('command -v chromedriver', { encoding: 'utf8' }).trim()
    if (fromPath) return fromPath
  } catch { }
  // Fallback to npm chromedriver package (works on non-NixOS)
  try {
    const chromedriver = require('chromedriver')
    return chromedriver.path
  } catch { }
  return undefined
}
const chromedriverBinary = resolveChromedriverBinary()

/// Resolve the VS Code Insiders binary path, handling Nix-managed installations.
function resolveVSCodeInsidersBinary(): string | undefined {
  const fromEnv = process.env.VSCODE_INSIDERS_PATH
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv
  try {
    const whichPath = execSync('command -v code-insiders', { encoding: 'utf8' }).trim()
    if (whichPath) {
      // Resolve symlinks (Nix often symlinks to store paths)
      let resolved = whichPath
      try { resolved = fs.realpathSync(whichPath) } catch { }
      // Nix macOS app bundle path from CLI wrapper
      const nixAppCandidate = resolved.replace(
        /\/bin\/code-insiders$/, '/Applications/Visual Studio Code - Insiders.app'
      )
      if (fs.existsSync(nixAppCandidate)) return nixAppCandidate
      // Directly try to locate Electron inside Nix store
      try {
        const found = execSync('ls -d /nix/store/*-vscode-insiders*/Applications/Visual\\ Studio\\ Code\\ -\\ Insiders.app 2>/dev/null | head -n 1', { encoding: 'utf8' }).trim()
        if (found) return found
      } catch { }
      // Fallback to wrapper if nothing else found
      return whichPath
    }
  } catch { }
  try {
    // macOS Spotlight lookup for the Insiders app
    const appPath = execSync('mdfind "kMDItemCFBundleIdentifier == com.microsoft.VSCodeInsiders" | head -n 1', { encoding: 'utf8' }).trim()
    if (appPath) return `${appPath}/Contents/MacOS/Electron`
  } catch { }
  return undefined
}

// VS Code channel to test against. Defaults to `stable`.
//
// `stable` is the representative target for the suite: no WDIO spec
// exercises the extension's sole proposed API (`editorInsets`, used only
// by the interactive tracepoint / flow-inset commands), so the suite does
// not require the Insiders channel. The renderer-crash investigation also
// confirmed the crash reproduces identically on stable 1.121.0 and
// Insiders 1.122.0, so it is not a pre-release-build instability.
//
// Override with WDIO_VSCODE_VERSION (e.g. `insiders`, or a pinned version
// like `1.96.4`) when a proposed-API run is genuinely needed.
const vscodeChannel = process.env.WDIO_VSCODE_VERSION?.trim() || 'stable'

const vscodeInsidersBinary = vscodeChannel === 'insiders' ? resolveVSCodeInsidersBinary() : undefined
if (vscodeChannel === 'insiders' && vscodeInsidersBinary) {
  console.log(`Using VS Code Insiders binary: ${vscodeInsidersBinary}`)
} else {
  console.log(`Using VS Code channel: ${vscodeChannel} (downloaded by wdio-vscode-service)`)
}

/**
 * Pre-populate ``.wdio-vscode-service/versions.txt`` so the upstream
 * ``VSCodeServiceLauncher`` skips its two HTTP fetches on
 * ``onPrepare``.  Without this, every run hits:
 *
 *   1. ``https://update.code.visualstudio.com/api/releases/stable``
 *      (``_fetchVSCodeVersion``) — usually fine.
 *   2. ``https://raw.githubusercontent.com/Microsoft/vscode/<v>/cgmanifest.json``
 *      (``_fetchChromedriverVersion``) — intermittently returns
 *      non-JSON on our self-hosted runners and surfaces as
 *      ``SevereServiceError: Couldn't fetch Chromedriver version:
 *        Unexpected non-whitespace character after JSON at position 3``.
 *
 * Upstream's cache hit-path (see ``_setupVSCodeDesktop`` in
 * ``wdio-vscode-service/src/launcher.ts``) is taken when:
 *
 *   * ``<cwd>/.wdio-vscode-service/versions.txt`` exists AND parses
 *     to a record keyed by the channel/version, AND
 *   * a sentinel at
 *     ``<cachePath>/vscode-${platform}-${arch}-${vscodeVersion}``
 *     exists.
 *
 * Resolve the two versions ourselves via ``curl`` with retry+backoff
 * before wdio loads, write the cache, then ensure the sentinel dir
 * exists.  When the cache is already populated for our channel, skip
 * (idempotent across runs).
 *
 * If the resolve fails (offline / extended outage), log a warning and
 * fall through — wdio-vscode-service will do its own live fetch and
 * the original SevereServiceError still surfaces.  No behaviour
 * regression.
 */
function prepareVscodeCacheToBypassManifestFetch(): void {
  const cacheDir = path.join(__dirname, '.wdio-vscode-service')
  const versionsPath = path.join(cacheDir, 'versions.txt')
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })

  const ensureSentinel = (vscodeVersion: string): void => {
    const sentinel = path.join(cacheDir, `vscode-${process.platform}-${process.arch}-${vscodeVersion}`)
    if (!fs.existsSync(sentinel)) fs.mkdirSync(sentinel, { recursive: true })
  }

  // Already populated?  Skip.
  if (fs.existsSync(versionsPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(versionsPath, 'utf-8'))
      const cached = existing[vscodeChannel]
      if (cached?.vscode && cached?.chromedriver) {
        ensureSentinel(cached.vscode)
        console.log(`[wdio-cache] versions.txt already populated: ${vscodeChannel}=${cached.vscode}/${cached.chromedriver}`)
        return
      }
    } catch { /* fall through and rewrite */ }
  }

  const fetchWithRetry = (url: string, attempts = 5): string => {
    let lastErr: any
    for (let i = 0; i < attempts; i++) {
      try {
        return execSync(`curl -sSfL --max-time 30 ${JSON.stringify(url)}`, { encoding: 'utf-8' })
      } catch (e: any) {
        lastErr = e
        if (i < attempts - 1) {
          // Backoff: 1s, 2s, 4s, 8s
          execSync(`sleep ${Math.min(2 ** i, 8)}`)
        }
      }
    }
    throw lastErr
  }

  try {
    // Latest VS Code releases for the channel.  Some entries in the
    // releases array don't have a matching cgmanifest.json upstream
    // (point releases sometimes skip the tag-and-publish step) -- e.g.
    // 1.123.2 returns HTTP 404, while 1.123.0 returns HTTP 200.  This
    // is the actual root cause of the upstream
    // ``_fetchChromedriverVersion`` failure: it always uses
    // ``availableVersions[0]``, gets back a 404 HTML page, and chokes
    // on JSON.parse.  Walk the list newest→older until we find a
    // version whose cgmanifest.json fetches.
    const releasesUrl = vscodeChannel === 'insiders'
      ? 'https://update.code.visualstudio.com/api/releases/insider'
      : 'https://update.code.visualstudio.com/api/releases/stable'
    const releases = JSON.parse(fetchWithRetry(releasesUrl)) as string[]
    if (!Array.isArray(releases) || releases.length === 0) {
      throw new Error(`unexpected releases payload: ${JSON.stringify(releases).slice(0, 80)}`)
    }

    const candidates = vscodeChannel === 'insiders'
      ? ['__insiders__'] // insiders always uses the main branch manifest
      : releases.slice(0, 8) // try up to 8 most-recent versions

    let vscodeVersion: string | undefined
    let chromedriverVersion: string | undefined
    let manifest:
      | { registrations: Array<{ component?: { git?: { name?: string } }; version: string }> }
      | undefined
    let lastErr: any

    for (const candidate of candidates) {
      const manifestUrl = candidate === '__insiders__'
        ? 'https://raw.githubusercontent.com/Microsoft/vscode/refs/heads/main/cgmanifest.json'
        : `https://raw.githubusercontent.com/Microsoft/vscode/${candidate}/cgmanifest.json`
      try {
        manifest = JSON.parse(fetchWithRetry(manifestUrl)) as typeof manifest
        const chromium = manifest!.registrations.find((r) => r.component?.git?.name === 'chromium')
        if (!chromium) {
          lastErr = new Error(`chromium registration missing in ${manifestUrl}`)
          continue
        }
        vscodeVersion = candidate === '__insiders__' ? releases[0] : candidate
        chromedriverVersion = chromium.version.split('.')[0]
        break
      } catch (e) {
        lastErr = e
        // 404 / non-JSON / other transient -- try next candidate.
      }
    }

    if (!vscodeVersion || !chromedriverVersion) {
      throw lastErr ?? new Error('no candidate version yielded a parseable cgmanifest')
    }

    fs.writeFileSync(
      versionsPath,
      JSON.stringify({ [vscodeChannel]: { vscode: vscodeVersion, chromedriver: chromedriverVersion } }, null, 2),
    )
    ensureSentinel(vscodeVersion)
    console.log(`[wdio-cache] versions.txt populated: ${vscodeChannel}=${vscodeVersion}/${chromedriverVersion}`)
  } catch (err: any) {
    console.warn(`[wdio-cache] Failed to pre-populate versions.txt (${err.message?.slice(0, 120)}); wdio-vscode-service will fall back to its own live fetch.`)
  }
}

prepareVscodeCacheToBypassManifestFetch()

// Use a short tmp directory to avoid Unix socket path length issues.
// On POSIX, wdio-vscode-service places its IPC socket under TMPDIR and the
// 108-char sun_path limit can be exceeded by deep default temp paths, so we
// pin a short, stable `/tmp` location. On Windows there is no Unix-socket
// path-length limit and `/tmp` is not a valid path, so we base the short
// directory under the OS temp directory instead.
const shortTmpDir = process.platform === 'win32'
  ? path.join(os.tmpdir(), 'wdio-vscode-ct')
  : '/tmp/wdio-vscode-ct'
// Create a unique storage root per run to avoid user-data-dir lock contention
const uniqueStorageRoot = path.join(shortTmpDir, `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
// Pin VS Code's --logsPath to a stable directory inside the diagnostics tree
// so the extension host / renderer logs survive a VS Code crash and a
// post-run storage cleanup (the per-run user-data-dir is volatile).
const vscodeLogsDir = path.resolve(__dirname, 'test', 'wdio', 'diagnostics', 'vscode-logs')
try {
  if (!fs.existsSync(shortTmpDir)) fs.mkdirSync(shortTmpDir, { recursive: true })
  if (!fs.existsSync(uniqueStorageRoot)) fs.mkdirSync(uniqueStorageRoot, { recursive: true })
  fs.rmSync(vscodeLogsDir, { recursive: true, force: true })
  fs.mkdirSync(vscodeLogsDir, { recursive: true })
  process.env.TMPDIR = shortTmpDir
  process.env.TEMP = shortTmpDir
  process.env.TMP = shortTmpDir
} catch { }

/**
 * M7 — Value Origin Tracking fixture-discovery hook.
 *
 * Resolves the codetracer-repo fixture root and exposes it locally under
 * `test/wdio/fixtures/origin/` so the M7 specs can address the fixtures
 * through a stable repo-relative path without having to thread the
 * codetracer-checkout location into every spec.
 *
 * Resolution order (matches the documented `CT_REPO` env contract):
 *   1. `$CT_REPO/src/db-backend/tests/fixtures/origin/` (explicit override).
 *   2. Conventional sibling layout `<this-repo>/../codetracer/src/db-backend/tests/fixtures/origin/`
 *      used by the `.envrc` machinery in both repos.
 *
 * When neither resolves, the function logs a hint and returns — the M7
 * specs SKIP-cleanly with a precise reason via
 * `helpers/value-origin-fixtures.ts::valueOriginSpecSkipReason`.
 *
 * Linking strategy:
 *   - POSIX (Linux, macOS): symlink the catalogue root. Zero-copy and
 *     edits in the codetracer checkout flow through immediately.
 *   - Windows: copy with `fs.cpSync`. Symlinks require admin privileges
 *     on a default Windows install, and CI agents are not admin.
 *
 * Document the new env var alongside the existing `CODETRACER_PATH` used
 * by the smoke tests — both are honored by the helper.
 */
function syncValueOriginFixtures(): void {
  const explicit = process.env.CT_REPO?.trim()
  const candidateRoots: string[] = []
  if (explicit && explicit.length > 0) {
    candidateRoots.push(
      path.join(explicit, 'src', 'db-backend', 'tests', 'fixtures', 'origin'),
    )
  }
  // Conventional sibling layout — same one `.envrc` uses to discover the
  // codetracer checkout when no override is set.
  candidateRoots.push(
    path.resolve(__dirname, '..', 'codetracer', 'src', 'db-backend', 'tests', 'fixtures', 'origin'),
  )

  const sourceRoot = candidateRoots.find((p) => {
    try {
      return fs.statSync(p).isDirectory()
    } catch {
      return false
    }
  })

  const destRoot = path.join(__dirname, 'test', 'wdio', 'fixtures', 'origin')
  // The destination's parent must exist regardless — the helpers introspect
  // it even when no fixtures land (the per-spec SKIP probe then fires).
  try {
    fs.mkdirSync(path.dirname(destRoot), { recursive: true })
  } catch {
    /* ignore — diagnostics handler will flag this */
  }

  if (!sourceRoot) {
    console.warn(
      '[M7] Value Origin fixtures NOT synced — set CT_REPO to a codetracer ' +
      'checkout containing src/db-backend/tests/fixtures/origin/ ' +
      '(or place a sibling codetracer/ checkout next to this repo). ' +
      'M7 specs that need fixtures will SKIP with this reason.',
    )
    return
  }

  try {
    const existing = fs.lstatSync(destRoot)
    if (existing.isSymbolicLink()) {
      const current = fs.readlinkSync(destRoot)
      if (path.resolve(current) === path.resolve(sourceRoot)) {
        console.log(`[M7] Value Origin fixtures symlink already current → ${sourceRoot}`)
        return
      }
    }
    // Remove existing destination so we can replace it atomically. We
    // never delete the source — only the local mirror.
    fs.rmSync(destRoot, { recursive: true, force: true })
  } catch {
    // not present yet — fine
  }

  if (process.platform === 'win32') {
    // Recursive copy. fs.cpSync requires Node ≥ 16.7.0.
    fs.cpSync(sourceRoot, destRoot, { recursive: true })
    console.log(`[M7] Value Origin fixtures copied → ${destRoot} from ${sourceRoot}`)
  } else {
    fs.symlinkSync(sourceRoot, destRoot, 'dir')
    console.log(`[M7] Value Origin fixtures symlinked → ${destRoot} → ${sourceRoot}`)
  }
}

export const config: any = {
  runner: 'local',

  specs: [
    './test/wdio/specs/**/*.e2e.ts'
  ],

  capabilities: [{
    browserName: 'vscode',
    browserVersion: vscodeChannel,
    'wdio:enforceWebDriverClassic': true,
    ...(chromedriverBinary ? {
      'wdio:chromedriverOptions': {
        binary: chromedriverBinary
      }
    } : {}),
    'wdio:vscodeOptions': ({
      ...(vscodeInsidersBinary ? { binary: vscodeInsidersBinary } : {}),
      extensionPath: path.resolve(__dirname),
      workspacePath: path.resolve(__dirname, 'test', 'wdio', 'projects', 'stylus-test'),
      storagePath: uniqueStorageRoot,
      vscodeProxyOptions: {
        connectionTimeout: 60000,
        commandTimeout: 60000
      },
      verboseLogging: true,
      vscodeArgs: {
        'disable-telemetry': true,
        'disable-extensions': false,
        'enable-proposed-api': 'metacraft-labs.ct-vscode',
        // Linux/NixOS-only Chromium workarounds. wdio-vscode-service already
        // passes --no-sandbox; on NixOS CI runners without user-namespace
        // support the zygote still fails to fork renderers.
        ...(process.platform !== 'win32' ? {
          'no-zygote': true,
          'disable-dev-shm-usage': true,
        } : {}),
        // Disable GPU acceleration on every platform. The CodeTracer webview
        // panels render heavy DOM/Monaco content; with the GPU process in
        // play the headless WDIO run was prone to GPU-process crashes that
        // took the workbench renderer down with them. Software compositing
        // is slower but stable, which is what a test run needs.
        'disable-gpu': true,
        'disable-gpu-compositing': true,
        // Pin the log directory so extension host / renderer logs survive a
        // VS Code crash for post-mortem diagnostics.
        'logsPath': vscodeLogsDir,
      },
    } as any)
  } as any],

  logLevel: 'info',
  bail: 0,
  baseUrl: '',
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,

  services: [
    'vscode'
  ],

  framework: 'mocha',
  maxInstances: 1,

  specFileRetries: 0,
  specFileRetriesDelay: 0,
  specFileRetriesDeferred: false,

  reporters: ['spec'],

  mochaOpts: {
    ui: 'bdd',
    timeout: 120000, // 2 min — enough for full diagnostics
  },

  onPrepare: function (_config, _capabilities) {
    console.log('Starting WebdriverIO CodeTracer Extension Tests...')

    // Reap chromedriver / electron / wdio-vscode-service leftovers from
    // any prior crashed or cancelled run on this (self-hosted) machine.
    // The per-run ``uniqueStorageRoot`` minted below is brand new, but
    // chrome's "user data directory is already in use" check is sensitive
    // to ANY peer process still holding ANY ``--user-data-dir=/tmp/
    // wdio-vscode-ct/...`` lease, including ones from prior runs.
    killLeftoverWdioProcesses()

    // Create wdio-vscode-service cache directory to avoid ENOENT errors
    const cacheDir = path.join(__dirname, '.wdio-vscode-service')
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true })
      console.log('Created .wdio-vscode-service cache directory')
    }

    // M7 — sync Value Origin Tracking fixtures from $CT_REPO into the local
    // tree the specs read. The source-of-truth catalogue lives in the
    // codetracer repo (it ships with the recorder fixtures + ANSWERS.md
    // files used by the M3 DAP-level tests). The VS Code extension repo
    // does NOT vendor a copy — duplicating the fixtures would put us at
    // risk of drift from the recorders' ground truth. Instead we resolve
    // $CT_REPO (or the conventional sibling `<parent>/codetracer/` checkout
    // used by `.envrc`) and symlink/copy the catalogue under
    // `test/wdio/fixtures/origin/`.
    //
    // Symlink on POSIX (zero-copy, picks up edits to the source), copy on
    // Windows (filesystem symlinks require elevation by default).
    syncValueOriginFixtures()

    // Compile the extension
    try {
      console.log('Compiling CodeTracer extension (TypeScript only)...')
      execSync('npm run compile:ts', { cwd: __dirname, stdio: 'inherit' })
    } catch (e) {
      console.warn('Failed to compile CodeTracer extension:', e)
    }

    // Restore Nim-compiled ct_vscode.js (tsc overwrites out/ct_vscode.js with an empty stub)
    const nimCtVscode = path.join(__dirname, 'media', 'ct_vscode.js')
    const outCtVscode = path.join(__dirname, 'out', 'ct_vscode.js')
    if (fs.existsSync(nimCtVscode)) {
      fs.copyFileSync(nimCtVscode, outCtVscode)
      console.log('Restored Nim-compiled ct_vscode.js to out/')
    } else {
      console.warn('WARNING: media/ct_vscode.js not found — Nim backend will not be available')
    }

    // Create the test workspace directory if it doesn't exist
    const testProjectDir = path.resolve(__dirname, 'test', 'wdio', 'projects', 'stylus-test')
    if (!fs.existsSync(testProjectDir)) {
      fs.mkdirSync(testProjectDir, { recursive: true })
      console.log('Created test workspace directory:', testProjectDir)
    }
  },

  onWorkerStart: function (cid, _caps, _specs, _args, _execArgv) {
    console.log(`Starting worker ${cid} for CodeTracer extension testing`)
  },

  beforeSession: function (_capabilities, _specs, _browser) {
    console.log('CodeTracer Extension Test Session Started')
  },

  beforeSuite: function (suite) {
    console.log(`Starting test suite: ${suite.title}`)
  },

  afterTest: async function (test, _context, result) {
    // Capture diagnostics on test failure for all tests (individual specs
    // may also capture their own diagnostics in afterEach hooks)
    if (result.error) {
      const label = `FAIL-${test.title.replace(/\s+/g, '-').substring(0, 40)}`
      try {
        const diagDir = path.resolve(__dirname, 'test', 'wdio', 'diagnostics')
        if (!fs.existsSync(diagDir)) fs.mkdirSync(diagDir, { recursive: true })
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { browser } = require('@wdio/globals')
        await browser.saveScreenshot(path.join(diagDir, `screenshot-${label}.png`))
        console.log(`[diag] Failure screenshot: ${label}`)
      } catch (e: any) {
        console.log(`[diag] Failure screenshot failed: ${e.message?.substring(0, 80)}`)
      }
    }
  },

  afterSuite: function (suite) {
    console.log(`Completed test suite: ${suite.title}`)
  },

  onComplete: function (exitCode, _config, _capabilities, _results) {
    console.log('WebdriverIO CodeTracer Extension Tests Completed')
    if (exitCode !== 0) {
      console.log('Tests failed. Check the logs above for details.')
    }
    // Mirror onPrepare: kill any orphan chromedriver / electron / wdio
    // processes this run started so the next run on the same self-hosted
    // machine starts from a clean slate, even if the test runner itself
    // crashes between onComplete and the next onPrepare.
    killLeftoverWdioProcesses()
  },

  onReload: function (_oldSessionId, _newSessionId) {
    console.log('VS Code session reloaded')
  }
}
