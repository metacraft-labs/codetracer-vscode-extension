/**
 * DAP client helper for WDIO tests.
 *
 * Wraps `browser.executeWorkbench()` to provide a typed interface for sending
 * DAP requests and standard debug operations to the CodeTracer debug adapter.
 */
import { browser } from '@wdio/globals'

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
  const fs = await import('fs')
  const path = await import('path')
  const isRr = fs.existsSync(path.join(traceFolder, 'rr'))

  return browser.executeWorkbench(
    async (vscode, folder: string, rrTrace: boolean) => {
      const config: any = {
        type: 'codetracer-debug',
        request: 'launch',
        name: 'WDIO Test Trace',
        program: 'main',
        cwd: '',
        traceFolder: folder
      }

      if (rrTrace) {
        const cfg = vscode.workspace.getConfiguration('codetracer')
        const rrWorkerPath = cfg.get<string>('rrWorkerPath')?.trim() ?? ''
        if (rrWorkerPath) {
          config.ctRRWorkerExe = rrWorkerPath
          config.rawDiffIndex = null
          config.restoreLocation = null
          console.log('[WDIO] rr trace detected, ctRRWorkerExe:', rrWorkerPath)
        } else {
          console.warn('[WDIO] rr trace detected but codetracer.rrWorkerPath is not set')
        }
      }

      return await vscode.debug.startDebugging(undefined, config)
    },
    traceFolder,
    isRr
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
  return dapRequest('stepOut', { threadId })
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
 * Map language names to their numeric IDs matching the Rust `Lang` enum
 * (repr(u8), serde_repr). The db-backend deserializes `lang` as a u8.
 */
const LANG_IDS: Record<string, number> = {
  C: 0, Cpp: 1, Rust: 2, Nim: 3, Go: 4, Pascal: 5, Fortran: 6,
  D: 7, Crystal: 8, Lean: 9, Julia: 10, Ada: 11, Python: 12,
  Ruby: 13, RubyDb: 14, Javascript: 15, Lua: 16, Asm: 17, Noir: 18,
  RustWasm: 19, CppWasm: 20, Small: 21, PythonDb: 22, Unknown: 23,
  Bash: 24, Zsh: 25, Solidity: 26, Masm: 27, Sway: 28, Move: 29,
  PolkaVM: 30, Cairo: 31, Circom: 32, Leo: 33, Tolk: 34, Aiken: 35,
  Cadence: 36, Solana: 37, Elixir: 38, Erlang: 39,
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
  // The `lang` field is a repr(u8) enum and must be sent as a number.
  const langName = opts.lang ?? 'Rust'
  const langId = LANG_IDS[langName] ?? LANG_IDS.Unknown
  return dapRequest('ct/load-locals', {
    rrTicks: opts.rrTicks ?? 0,
    countBudget: opts.countBudget ?? 100,
    minCountLimit: 10,
    lang: langId,
    watchExpressions: opts.watchExpressions ?? [],
    depthLimit: opts.depthLimit ?? 3,
  })
}

/** Load flow data for the current location. */
export async function loadFlow(flowMode = 0): Promise<DapResult> {
  // Field names must be camelCase to match the Rust struct's
  // #[serde(rename_all = "camelCase")] deserialization.
  return dapRequest('ct/load-flow', {
    flowMode,
    location: {
      path: '', line: 0, functionName: '', highLevelPath: '',
      highLevelLine: 0, highLevelFunctionName: '', lowLevelPath: '',
      lowLevelLine: 0, rrTicks: 0, functionFirst: 0, functionLast: 0,
      event: 0, expression: '', offset: 0, error: false,
      callstackDepth: 0, originatingInstructionAddress: 0,
      key: '', globalCallKey: '',
    },
  })
}

/** Load terminal output. */
export async function loadTerminal(): Promise<DapResult> {
  return dapRequest('ct/load-terminal', {})
}

/** Search the calltrace for a function name. */
export async function searchCalltrace(query: string): Promise<DapResult> {
  return dapRequest('ct/search-calltrace', { value: query })
}
