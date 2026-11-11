/**
 * DAP client helper for WDIO tests.
 *
 * Wraps `browser.executeWorkbench()` to provide a typed interface for sending
 * DAP requests and standard debug operations to the CodeTracer debug adapter.
 */
import { browser } from '@wdio/globals'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Result of a DAP request — either success with data or failure with error. */
export interface DapResult<T = any> {
  ok: boolean
  data?: T
  error?: string
}

/** Send a custom DAP request to the active debug session. */
export async function dapRequest<T = any>(
  command: string,
  args: any = {},
  timeoutMs = 10000
): Promise<DapResult<T>> {
  return browser.executeWorkbench(async (vscode, cmd, a, t) => {
    const session = vscode.debug.activeDebugSession
    if (!session) return { ok: false, error: 'no active debug session' }
    try {
      const result = await Promise.race([
        session.customRequest(cmd, a),
        new Promise((_, reject) => setTimeout(() => reject(new Error('DAP request timeout')), t))
      ])
      return { ok: true, data: result }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  }, command, args, timeoutMs) as DapResult<T>
}

/** Start a CodeTracer debug session with the given trace folder.
 *
 * For rr-based traces (detected by the presence of an `rr/` subdirectory),
 * the debug config includes `ctRRWorkerExe` pointing to `ct-native-replay`.
 * This mirrors what the extension's `loadTrace` command does when it detects
 * an rr trace folder via `isRrTraceFolder()`.
 *
 * The `ct-native-replay` path is resolved from the `codetracer.rrWorkerPath`
 * VS Code setting (set by CI in .vscode/settings.json).
 */
export async function startDebugSession(traceFolder: string): Promise<boolean> {
  // Detect rr-based traces from the test runner (Node.js context).
  // We can't use require('fs') inside executeWorkbench because the
  // callback is serialized and executed in the VS Code browser context.
  const isRr = fs.existsSync(path.join(traceFolder, 'rr'))
  const cwd = path.basename(traceFolder) === 'trace'
    ? path.dirname(traceFolder)
    : path.dirname(path.dirname(traceFolder))
  const rrWorkerCandidate = [
    process.env.CODETRACER_RR_WORKER_PATH,
    process.env.CT_RR_WORKER_PATH,
    path.resolve(__dirname, '..', '..', '..', '..', 'codetracer-native-backend', 'target', 'debug', 'ct-native-replay'),
  ].find((candidate) => candidate && fs.existsSync(candidate))

  return browser.executeWorkbench(
    async (vscode, folder: string, launchCwd: string, rrTrace: boolean, rrWorkerFallback: string | undefined) => {
      const config: any = {
        type: 'codetracer-debug',
        request: 'launch',
        name: 'WDIO Test Trace',
        program: 'main',
        cwd: launchCwd,
        traceFolder: folder
      }

      if (rrTrace) {
        const cfg = vscode.workspace.getConfiguration('codetracer')
        const rrWorkerPath = (cfg.get('rrWorkerPath') as string | undefined)?.trim() ?? ''
        const worker = rrWorkerPath || rrWorkerFallback || ''
        if (worker) {
          config.ctRRWorkerExe = worker
          config.rawDiffIndex = null
          config.restoreLocation = null
          console.log('[WDIO] rr trace detected, ctRRWorkerExe:', worker)
        } else {
          console.warn('[WDIO] rr trace detected but codetracer.rrWorkerPath is not set')
        }
      }

      return await vscode.debug.startDebugging(undefined, config)
    },
    traceFolder,
    cwd,
    isRr,
    rrWorkerCandidate,
  )
}

/** Wait for an active CodeTracer debug session, with timeout. */
export async function waitForDebugSession(timeoutMs = 30000): Promise<void> {
  await browser.waitUntil(
    async () => {
      return browser.executeWorkbench(async (vscode) => {
        return vscode.debug.activeDebugSession !== undefined &&
          vscode.debug.activeDebugSession.type === 'codetracer-debug'
      })
    },
    { timeout: timeoutMs, timeoutMsg: `Debug session did not start within ${timeoutMs}ms` }
  )
}

/** Stop the active debug session. */
export async function stopDebugSession(): Promise<void> {
  try {
    await browser.executeWorkbench(async (vscode) => {
      if (vscode.debug.activeDebugSession) {
        await vscode.commands.executeCommand('workbench.action.debug.stop')
      }
    })
  } catch { /* ignore cleanup errors */ }
}

/** Get the list of DAP threads. */
export async function getThreads(): Promise<DapResult<{ threads: any[] }>> {
  return dapRequest('threads')
}

/** DAP step-over (next). */
export async function stepOver(threadId = 1): Promise<DapResult> {
  return dapRequest('next', { threadId })
}

/** DAP step-in. */
export async function stepIn(threadId = 1): Promise<DapResult> {
  return dapRequest('stepIn', { threadId })
}

/** DAP step-out. */
export async function stepOut(threadId = 1): Promise<DapResult> {
  return dapRequest('stepOut', { threadId }, 45000)
}

/** DAP continue. */
export async function dapContinue(threadId = 1): Promise<DapResult> {
  return dapRequest('continue', { threadId })
}

/** DAP reverse step-in. */
export async function reverseStepIn(): Promise<DapResult> {
  return dapRequest('ct/reverseStepIn')
}

/** DAP reverse step-out. */
export async function reverseStepOut(): Promise<DapResult> {
  return dapRequest('ct/reverseStepOut')
}

/** DAP reverse continue. */
export async function reverseContinue(threadId = 1): Promise<DapResult> {
  return dapRequest('reverseContinue', { threadId })
}

/** Load the calltrace section. */
export async function loadCalltrace(opts: {
  startIndex?: number
  depth?: number
  height?: number
} = {}): Promise<DapResult> {
  // Field names must be camelCase to match the Rust struct's
  // #[serde(rename_all = "camelCase")] deserialization.
  return dapRequest('ct/load-calltrace-section', {
    location: {
      path: '', line: 0, functionName: '', highLevelPath: '',
      highLevelLine: 0, highLevelFunctionName: '', lowLevelPath: '',
      lowLevelLine: 0, rrTicks: 0, functionFirst: 0, functionLast: 0,
      event: 0, expression: '', offset: 0, error: false,
      callstackDepth: 0, originatingInstructionAddress: 0,
      key: '', globalCallKey: '',
    },
    startCallLineIndex: opts.startIndex ?? 0,
    depth: opts.depth ?? 50,
    height: opts.height ?? 200,
    rawIgnorePatterns: '',
    autoCollapsing: false,
    optimizeCollapse: false,
    renderCallLineIndex: 0,
  })
}

/** Load events from the trace. */
export async function loadEvents(): Promise<DapResult> {
  return dapRequest('ct/event-load', {}, 15000)
}

/**
 * The `lang` the specs name (`langId` in their smoke configs) -> the
 * language's wire name on `ct/load-locals`.
 *
 * The replay server reads `CtLoadLocalsArguments.lang` by NAME: the spelling
 * of `Lang::wire_name` in codetracer's `libs/ct-lang/src/lib.rs` (and
 * `langWireName` in `src/common/common_lang.nim`), decoded with
 * `ct_lang::lang_wire`. It refuses an integer ("invalid type: integer `0`,
 * expected a string") and an unknown name, so the enum's declaration order is
 * no longer a wire contract -- the ordinal table this replaces had drifted
 * from it twice.
 *
 * Python and Ruby are `pythondb` / `rubydb`, the only Python and Ruby members
 * `Lang` has. PolkaVM and Solana are not languages: codetracer retired those
 * members (a PolkaVM blob or a Solana program has no source language; the VM
 * is the recording's target ISA), so codetracer itself sends `unknown` for
 * them, and so does this table.
 */
const LANG_WIRE_NAMES: Readonly<Record<string, string>> = {
  Unknown: 'unknown',
  C: 'c', Cpp: 'cpp', Rust: 'rust', Nim: 'nim', Go: 'go',
  Pascal: 'pascal', Fortran: 'fortran', D: 'd', Crystal: 'crystal',
  Lean: 'lean', Julia: 'julia', Ada: 'ada',
  Python: 'pythondb', PythonDb: 'pythondb', Ruby: 'rubydb', RubyDb: 'rubydb',
  Javascript: 'javascript', Lua: 'lua', Asm: 'asm', Noir: 'noir',
  Bash: 'bash', Zsh: 'zsh', Solidity: 'solidity', MASM: 'masm', Masm: 'masm',
  Sway: 'sway', Move: 'move', Cairo: 'cairo', Circom: 'circom', Leo: 'leo',
  Tolk: 'tolk', Aiken: 'aiken', Cadence: 'cadence', Elixir: 'elixir',
  Erlang: 'erlang', Php: 'php', GDScript: 'gdscript',
  PolkaVM: 'unknown', Solana: 'unknown',
}

/**
 * The wire name for a spec's language. Throws on a name the table does not
 * know rather than sending `unknown`: the old table fell back silently, which
 * is how `MASM` (spelled `Masm` there) was sent as Unknown unnoticed.
 */
export function langWireName(langName: string): string {
  const wireName = LANG_WIRE_NAMES[langName]
  if (wireName === undefined) {
    throw new Error(
      `loadLocals: no ct/load-locals wire name for language '${langName}'; ` +
      'add it to LANG_WIRE_NAMES (test/wdio/helpers/dap-client.ts)',
    )
  }
  return wireName
}

/** Load local variables at the current position. */
export async function loadLocals(opts: {
  rrTicks?: number
  countBudget?: number
  lang?: string
  watchExpressions?: string[]
  depthLimit?: number
} = {}): Promise<DapResult> {
  // Field names must be camelCase to match the Rust struct's
  // #[serde(rename_all = "camelCase")] deserialization.
  return dapRequest('ct/load-locals', {
    rrTicks: opts.rrTicks ?? 0,
    countBudget: opts.countBudget ?? 100,
    minCountLimit: 10,
    lang: langWireName(opts.lang ?? 'Rust'),
    watchExpressions: opts.watchExpressions ?? [],
    depthLimit: opts.depthLimit ?? 3,
  })
}

/** Load flow data for the current location.
 *
 * The flow arrives on the `ct/updated-flow` event; the `ct/load-flow`
 * response that follows it is an acknowledgement, so the flow is
 * delivered once (CodeTracer-DAP-Extensions: `ct/load-flow`). `data` is the
 * event's `FlowUpdate` body. The event is observed through the extension's
 * `registerPanelOverride` test seam, which hears every event the adapter
 * sends, with or without the Nim session host. The engine emits a request's
 * event immediately before its response, so the last `ct/updated-flow`
 * observed once the response has resolved is this request's; on a transport
 * that delivered the response first, the next one is awaited until the
 * timeout.
 */
export async function loadFlow(flowMode = 0, timeoutMs = 10000): Promise<DapResult> {
  // Field names must be camelCase to match the Rust struct's
  // #[serde(rename_all = "camelCase")] deserialization.
  const args = {
    flowMode,
    location: {
      path: '', line: 0, functionName: '', highLevelPath: '',
      highLevelLine: 0, highLevelFunctionName: '', lowLevelPath: '',
      lowLevelLine: 0, rrTicks: 0, functionFirst: 0, functionLast: 0,
      event: 0, expression: '', offset: 0, error: false,
      callstackDepth: 0, originatingInstructionAddress: 0,
      key: '', globalCallKey: '',
    },
  }
  return browser.executeWorkbench(async (vscode, a, t) => {
    const session = vscode.debug.activeDebugSession
    if (!session) return { ok: false, error: 'no active debug session' }
    const exports = vscode.extensions.getExtension('metacraft-labs.ct-vscode')?.exports as any
    if (!exports || typeof exports.registerPanelOverride !== 'function') {
      return { ok: false, error: 'registerPanelOverride export missing' }
    }
    let flow: any = undefined
    let wake: (() => void) | undefined
    const fakePanel = {
      webview: {
        postMessage(message: any) {
          if (message?.command === 'ct/updated-flow') {
            flow = message.value
            wake?.()
          }
          return Promise.resolve(true)
        },
      },
    }
    const dispose = exports.registerPanelOverride('wdio-load-flow', fakePanel)
    const deadline = Date.now() + t
    try {
      await Promise.race([
        session.customRequest('ct/load-flow', a),
        new Promise((_, reject) => setTimeout(() => reject(new Error('DAP request timeout')), t)),
      ])
      if (flow === undefined) {
        await new Promise<void>((resolve, reject) => {
          wake = resolve
          setTimeout(
            () => reject(new Error('ct/load-flow was acknowledged but no ct/updated-flow arrived')),
            Math.max(0, deadline - Date.now()),
          )
        })
      }
      return { ok: true, data: flow }
    } catch (e: any) {
      return { ok: false, error: e.message }
    } finally {
      dispose()
    }
  }, args, timeoutMs) as DapResult
}

/** Load terminal output. */
export async function loadTerminal(): Promise<DapResult> {
  return dapRequest('ct/load-terminal', {})
}

/** Search the calltrace for a function name.
 *
 * Uses a longer timeout (30s) than the default ``dapRequest`` budget
 * because ``calltrace_search`` in the db-backend iterates the trace's
 * full ``calls_iter()`` and ``functions_iter()`` set; large traces
 * (e.g. the Solana fixture's 1277-snapshot trace with ~38k Value
 * events) can exceed the 10s default on the org's self-hosted
 * runners.  Cross-repo run 27593691346 documented this: the test
 * passed on the sparse trace from commit ``6cb5552`` but timed out on
 * the larger trace from ``7a3dccf`` (which surfaced 19 named locals
 * at call_entry).  The work itself is cheap server-side; the
 * walltime is dominated by the runner being busy.
 */
export async function searchCalltrace(query: string): Promise<DapResult> {
  return dapRequest('ct/search-calltrace', { value: query }, 30000)
}
