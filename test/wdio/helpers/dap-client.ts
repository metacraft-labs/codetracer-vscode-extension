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

/** Start a CodeTracer debug session with the given trace folder. */
export async function startDebugSession(traceFolder: string): Promise<boolean> {
  return browser.executeWorkbench(
    async (vscode, folder: string) => {
      return await vscode.debug.startDebugging(undefined, {
        type: 'codetracer-debug',
        request: 'launch',
        name: 'WDIO Test Trace',
        cwd: '',
        traceFolder: folder
      })
    },
    traceFolder
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
  return dapRequest('ct/load-calltrace-section', {
    location: {},
    start_call_line_index: opts.startIndex ?? 0,
    depth: opts.depth ?? 50,
    height: opts.height ?? 200,
    raw_ignore_patterns: '',
    auto_collapsing: false,
    optimize_collapse: false,
    render_call_line_index: 0,
  })
}

/** Load events from the trace. */
export async function loadEvents(): Promise<DapResult> {
  return dapRequest('ct/event-load', {}, 15000)
}

/** Load local variables at the current position. */
export async function loadLocals(opts: {
  rrTicks?: number
  countBudget?: number
  lang?: string
  watchExpressions?: string[]
  depthLimit?: number
} = {}): Promise<DapResult> {
  return dapRequest('ct/load-locals', {
    rr_ticks: opts.rrTicks ?? 0,
    count_budget: opts.countBudget ?? 100,
    min_count_limit: 10,
    lang: opts.lang ?? 'Rust',
    watch_expressions: opts.watchExpressions ?? [],
    depth_limit: opts.depthLimit ?? 3,
  })
}

/** Load flow data for the current location. */
export async function loadFlow(flowMode = 0): Promise<DapResult> {
  return dapRequest('ct/load-flow', { flow_mode: flowMode, location: {} })
}

/** Load terminal output. */
export async function loadTerminal(): Promise<DapResult> {
  return dapRequest('ct/load-terminal', {})
}

/** Search the calltrace for a function name. */
export async function searchCalltrace(query: string): Promise<DapResult> {
  return dapRequest('ct/search-calltrace', { value: query })
}
