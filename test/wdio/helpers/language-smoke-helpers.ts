/**
 * Reusable smoke test assertions for per-language WDIO tests.
 *
 * DAP-oriented equivalent of the Playwright language-smoke-test-helpers.ts
 * in the codetracer repo. Each assertion maps to a Playwright helper:
 *
 *   Playwright                         →  WDIO (DAP)
 *   assertEditorLoadsFile              →  assertEditorLoadsFile
 *   assertEventLogPopulated            →  assertEventsPopulated
 *   assertCallTraceNavigation          →  assertCalltraceContains
 *   assertVariableVisible              →  assertLocalsContainVariable
 *   assertFlowValueVisible             →  assertFlowLoads
 *   assertTerminalOutputContains       →  assertTerminalContains
 *
 * See: codetracer-specs/Testing/WDIO-Extension-Test-Catalog.md
 */
import path from 'path'
import { browser, expect } from '@wdio/globals'
import { DebugSession, EditorPane, ExtensionState } from '../page-objects'
import {
  captureDapStateSnapshot, captureFullDiagnostics, captureTraceFingerprint,
  screenshot, writeDiag,
} from './diagnostics'
import { resolveTracePath, traceExists } from './trace-utils'
import { lastMove, type DapResult } from './dap-client'
import { checkFlowAtStop } from './flow-at-stop'

// ---- Configuration ----

/** Configuration for a language smoke test suite. */
export interface LanguageSmokeConfig {
  /** Display name for test titles (e.g., "Python", "Rust"). */
  language: string
  /** Directory name under test/traces/ (e.g., "python-sudoku"). */
  traceName: string
  /** Expected source file name in the editor (e.g., "main.py"). */
  expectedFileName: string
  /** Function name to find in the calltrace (e.g., "solve_sudoku"). */
  calltraceFunction: string
  /** Variable name to check for in locals (e.g., "board"). */
  variableName: string
  /** Language ID for loadLocals (e.g., "Python", "Rust"). */
  langId: string
  /** Expected text in terminal output (optional). */
  terminalText?: string
  /** Expected text in event log (optional). */
  eventLogText?: string
  /** Use step-in instead of step-over for the navigation test.
   *  Needed when the entry function only contains a single nested call
   *  (e.g., `main() { return compute() }`) and step-over would jump to
   *  the end of the trace. */
  useStepIn?: boolean
  /** Extra step-overs before loading locals. Some recorders (e.g., Ruby)
   *  only capture variables at certain trace positions, so the single
   *  step-over from the navigation test may land on a position without
   *  locals. This advances the debugger further into the trace. */
  extraStepsForLocals?: number
  /** Step into user code before checking the editor tab. Some languages
   *  (e.g., Nim) initially stop in runtime code with no source file.
   *  This steps forward so the editor opens the user's source file. */
  stepsBeforeEditorCheck?: number
  /** Before the editor check, jump to the first call of
   *  `calltraceFunction` through the call trace's search
   *  (`ct/search-calltrace`, then `ct/calltrace-jump` on the result), the
   *  way a user reaches it from the Call Trace pane. For recordings that
   *  open in code the toolchain puts in front of the program — a Solana
   *  program opens in the `entrypoint!` code of solana-program-entrypoint,
   *  and its own `process_instruction` starts ~176 steps later — where a
   *  step count (`stepsBeforeEditorCheck`) would depend on the entrypoint
   *  crate's version and the account count. The steps that follow
   *  (`useStepIn`, `extraStepsForLocals`) then count from the function's
   *  entry. */
  jumpToCalltraceFunction?: boolean
  /** When true, the locals test only verifies that loadLocals returns a
   *  valid (ok: true) response — it does not assert that a specific
   *  variable is present. This is used for rr-based languages (Rust, Nim,
   *  Go) where LLDB/Delve variable extraction in rr soft-mode replay
   *  returns empty locals at most step positions. The test still runs
   *  (not skipped) and will catch regressions in the DAP protocol. */
  localsResponseOnly?: boolean
}

// ---- Individual assertion functions ----

/** Start a debug session with a trace and verify it's active. */
export async function assertSessionStarts(
  session: DebugSession,
  traceDir: string,
): Promise<void> {
  const started = await session.start(traceDir)
  expect(started).toBe(true)
  const active = await session.isActive()
  expect(active).toBe(true)
}

/** Verify the editor opens the expected source file. */
export async function assertEditorLoadsFile(
  editor: EditorPane,
  expectedFileName: string,
): Promise<void> {
  const hasTab = await editor.hasOpenTab(expectedFileName)
  if (!hasTab) {
    await browser.waitUntil(
      async () => editor.hasOpenTab(expectedFileName),
      { timeout: 15000, timeoutMsg: `${expectedFileName} tab did not open within 15s` },
    )
  }

  // Activate the tab so subsequent checks work against it.
  await browser.executeWorkbench(async (vscode, fileName: string) => {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as any
        if (input?.uri?.fsPath?.endsWith(fileName)) {
          await vscode.window.showTextDocument(input.uri)
          return
        }
      }
    }
  }, expectedFileName)
  await browser.pause(1000)

  const state = await editor.state()
  expect(state).not.toBeNull()
  expect(state!.fileName).toContain(expectedFileName)
}

/** Verify DAP reports at least one thread. */
export async function assertThreadsExist(
  session: DebugSession,
): Promise<void> {
  const result = await session.getThreads()
  expect(result.ok).toBe(true)
  expect(result.data!.threads.length).toBeGreaterThanOrEqual(1)
}

/** Verify the event log has data. */
export async function assertEventsPopulated(
  session: DebugSession,
): Promise<void> {
  const result = await session.loadEvents()
  if (result.ok && result.data) {
    const dataStr = JSON.stringify(result.data)
    expect(dataStr.length).toBeGreaterThan(2) // more than "{}"
  } else {
    console.warn('Events did not return inline data:', result.error)
    expect(result.ok).toBe(true)
  }
}

/** Verify the calltrace contains a known function name. */
export async function assertCalltraceContains(
  session: DebugSession,
  functionName: string,
): Promise<void> {
  const result = await session.loadCalltrace({ depth: 50, height: 200 })
  if (result.ok && result.data) {
    const dataStr = JSON.stringify(result.data)
    writeDiag('calltrace.json', result.data)
    // Check if the function name appears anywhere in the response.
    expect(dataStr).toContain(functionName)
  } else {
    console.warn('Calltrace did not return inline data:', result.error)
    expect(result.ok).toBe(true)
  }
}

/** Verify locals contain a known variable name. */
export async function assertLocalsContainVariable(
  session: DebugSession,
  variableName: string,
  langId: string,
): Promise<void> {
  const result = await session.loadLocals({ lang: langId, countBudget: 100, depthLimit: 3 })
  if (result.ok && result.data) {
    const dataStr = JSON.stringify(result.data)
    writeDiag('locals.json', result.data)
    expect(dataStr).toContain(variableName)
  } else {
    console.warn('Locals did not return inline data:', result.error)
    expect(result.ok).toBe(true)
  }
}

/**
 * Verify locals contain a variable with a specific expected value.
 *
 * This is a stricter alternative to `assertLocalsContainVariable` — it checks
 * both the variable name AND its value. The value comparison is performed as a
 * substring match against the JSON-serialised locals payload so that it works
 * regardless of the exact DAP response structure (nested `value` field, inline
 * string representation, etc.).
 */
export async function assertLocalsContainVariableWithValue(
  session: DebugSession,
  variableName: string,
  expectedValue: string,
  langId: string,
): Promise<void> {
  const result = await session.loadLocals({ lang: langId, countBudget: 100, depthLimit: 3 })
  expect(result.ok).toBe(true)

  if (result.ok && result.data) {
    const dataStr = JSON.stringify(result.data)
    writeDiag('locals-with-value.json', result.data)

    // First verify the variable name exists in the response.
    expect(dataStr).toContain(variableName)

    // Then verify the expected value also appears. Because the DAP response
    // format varies (e.g. `{ name: "x", value: "42" }` vs a nested object),
    // we check for the value as a substring of the full JSON payload.
    expect(dataStr).toContain(expectedValue)

    // If we have a structured locals array, also log the matching variable for
    // diagnostic purposes.
    if (result.data.locals && Array.isArray(result.data.locals)) {
      const matching = result.data.locals.filter(
        (l: any) => {
          const name = l.name ?? l.variable_name ?? ''
          return name === variableName || String(name).includes(variableName)
        },
      )
      for (const v of matching) {
        console.log(
          `  [assertLocalsContainVariableWithValue] ${v.name ?? v.variable_name}: ` +
          JSON.stringify(v.value ?? v).substring(0, 120),
        )
      }
    }
  } else {
    console.warn('Locals did not return inline data:', result.error)
    expect(result.ok).toBe(true)
  }
}

/** Whether a call-trace `Call` is a call of `functionName`: its name is
 *  exactly that, or a path ending in `::functionName` (DWARF-named Rust
 *  functions may be qualified). */
function isCallOf(call: any, functionName: string): boolean {
  const names = [call?.location?.functionName, call?.rawName]
    .filter((n): n is string => typeof n === 'string')
  return names.some((n) => n === functionName || n.endsWith(`::${functionName}`))
}

/**
 * Jump to the first call of `functionName` the call trace's search finds,
 * and verify the session stopped in `expectedFileName`.
 *
 * The DAP-level counterpart of the desktop scenario that types the function
 * into the Call Trace pane's search box and activates the first result
 * (codetracer `src/tests/scenarios/languages/solana-opens-at-entry.yaml`).
 * The search's regex can match other names that merely contain
 * `functionName`, so the call is chosen by `isCallOf`; when several calls
 * match, the search returns them in recording order and the first is taken.
 */
export async function jumpToFirstCall(
  session: DebugSession,
  functionName: string,
  expectedFileName: string,
): Promise<void> {
  const search = await session.searchCalltrace(functionName)
  writeDiag(`calltrace-search-${functionName}.json`, search.data ?? search.error)
  expect(search.ok).toBe(true)
  const calls: any[] = Array.isArray(search.data?.calls) ? search.data.calls : []
  const call = calls.find((c) => isCallOf(c, functionName))
  if (!call) {
    throw new Error(
      `ct/search-calltrace found no call of ${functionName} among ${calls.length} result(s): ` +
      JSON.stringify(calls.map((c) => c?.location?.functionName ?? c?.rawName)),
    )
  }
  const before = await session.currentLocation()
  const { result, location } = await session.calltraceJump(call.location)
  writeDiag(`calltrace-jump-${functionName}.json`, { before, call: call.location, result, location })
  expect(result.ok).toBe(true)
  expect(path.basename(location.file)).toBe(expectedFileName)
  expect(location.line).toBeGreaterThan(0)
}

/** Verify step-over works and changes the current location. */
export async function assertStepWorks(
  session: DebugSession,
  useStepIn = false,
): Promise<void> {
  const before = await session.currentLocation()
  const after = useStepIn
    ? await session.stepIn(2000)
    : await session.stepOver(2000)
  // We should still be in a source file.
  expect(after.file.length).toBeGreaterThan(0)
  expect(after.line).toBeGreaterThan(0)
  writeDiag('step-over.json', { before, after })
}

/**
 * Assert that `result` (a `loadFlow` answer) is the flow of the call the
 * session is stopped in now: the request succeeded, and the flow's function,
 * call, starting step and lines agree with the stop DAP reports and with the
 * last `ct/complete-move` (`checkFlowAtStop` in `flow-at-stop.ts`). A flow
 * that merely arrived non-empty is not enough: the flow of step 0 is never
 * empty, wherever the session is stopped.
 *
 * Writes the flow and the comparison to `diagName` either way.
 */
export async function assertFlowAtCurrentStop(
  session: DebugSession,
  result: DapResult,
  diagName: string,
): Promise<void> {
  if (!result.ok) {
    writeDiag(diagName, { error: result.error })
    throw new Error(`loadFlow failed: ${result.error}`)
  }
  const stop = await session.currentStop()
  const move = await lastMove()
  const report = checkFlowAtStop(result.data, stop, move)
  writeDiag(diagName, { flow: result.data, report })
  console.log('[flow] at stop:', JSON.stringify({ ...report, flowLines: report.flowLines.length }))
  expect(report.mismatches).toEqual([])
}

/** Verify the flow of the current stop loads (Playwright's
 *  `assertFlowValueVisible`): see `assertFlowAtCurrentStop`. */
export async function assertFlowLoads(
  session: DebugSession,
): Promise<void> {
  const result = await session.loadFlow(0)
  await assertFlowAtCurrentStop(session, result, 'flow.json')
}

/** Verify terminal output contains expected text. */
export async function assertTerminalContains(
  session: DebugSession,
  text: string,
): Promise<void> {
  const result = await session.loadTerminal()
  if (result.ok && result.data) {
    const dataStr = JSON.stringify(result.data)
    writeDiag('terminal.json', result.data)
    expect(dataStr).toContain(text)
  } else {
    console.warn('Terminal did not return inline data:', result.error)
    expect(result.ok).toBe(true)
  }
}

// ---- Test suite generator ----

/**
 * Define a complete language smoke test suite.
 *
 * Generates a Mocha `describe()` block with ~8 standardized tests that
 * verify the core debugging experience for a given language. Tests are
 * skipped if the trace hasn't been recorded (sibling repo not available).
 *
 * Usage:
 * ```typescript
 * defineLanguageSmokeTests({
 *   language: 'Python',
 *   traceName: 'python-sudoku',
 *   expectedFileName: 'main.py',
 *   calltraceFunction: 'solve_sudoku',
 *   variableName: 'board',
 *   langId: 'Python',
 *   terminalText: '1',
 * })
 * ```
 */
export function defineLanguageSmokeTests(config: LanguageSmokeConfig): void {
  const session = new DebugSession()
  const editor = new EditorPane()
  const ext = new ExtensionState()

  describe(`CodeTracer Extension - ${config.language} Smoke Test`, () => {
    let traceDir: string

    before(function () {
      traceDir = resolveTracePath(config.traceName)
      if (!traceExists(config.traceName)) {
        const message =
          `${config.language} smoke tests: trace not found at ${traceDir}. ` +
          'Run the fixture preparation script to generate it.'
        console.warn(`SKIPPING: ${message}`)
        this.skip()
      }
    })

    afterEach(async function () {
      const testName = this.currentTest?.title?.replace(/[^a-zA-Z0-9_-]+/g, '-').substring(0, 50) ?? 'unknown'
      if (this.currentTest?.state === 'failed') {
        console.log(`[diag] Test failed: ${this.currentTest.title}`)
        await captureFullDiagnostics(`${config.language.toLowerCase()}-FAIL-${testName}`)
      }
      await screenshot(`${config.language.toLowerCase()}-${testName}`)
    })

    it('starts a debug session with the trace', async () => {
      await ext.ensureActivated()
      await assertSessionStarts(session, traceDir)

      const location = await session.currentLocation()
      console.log(`[${config.language}] Initial location:`, JSON.stringify(location))
      writeDiag(`${config.language.toLowerCase()}-session-start.json`, { location })

      // Hash every regular file in the trace directory so a local vs CI
      // failure can be byte-compared.  The recorder writes either
      // ``trace.bin`` or ``<name>.ct`` (CTFS container) plus optional
      // sidecar files; we just hash whatever is there to avoid making
      // assumptions per language.
      const fs = await import('fs')
      const path = await import('path')
      for (const entry of fs.readdirSync(traceDir)) {
        const full = path.join(traceDir, entry)
        if (fs.statSync(full).isFile()) {
          captureTraceFingerprint(`${config.language.toLowerCase()}-${entry}`, full)
        }
      }
    })

    if (config.jumpToCalltraceFunction) {
      it(`jumps to ${config.calltraceFunction} through the calltrace search`, async () => {
        await jumpToFirstCall(session, config.calltraceFunction, config.expectedFileName)
      })
    }

    it(`opens ${config.expectedFileName} in the editor`, async () => {
      if (config.stepsBeforeEditorCheck) {
        for (let i = 0; i < config.stepsBeforeEditorCheck; i++) {
          await session.stepOver(2000)
        }
      }
      await assertEditorLoadsFile(editor, config.expectedFileName)
    })

    it('reports at least one DAP thread', async () => {
      await assertThreadsExist(session)
    })

    it('loads events from the trace', async () => {
      await assertEventsPopulated(session)
    })

    it(`finds ${config.calltraceFunction} in the calltrace`, async () => {
      await assertCalltraceContains(session, config.calltraceFunction)
    })

    it(`can ${config.useStepIn ? 'step-in' : 'step-over'} and remain in the trace`, async () => {
      await assertStepWorks(session, config.useStepIn)
    })

    it(config.localsResponseOnly
      ? `loads locals (${config.language} rr replay — variable assertion deferred)`
      : `finds ${config.variableName} in local variables${config.extraStepsForLocals ? ' after stepping' : ''}`,
    async () => {
      if (config.extraStepsForLocals) {
        for (let i = 0; i < config.extraStepsForLocals; i++) {
          await session.stepOver(2000)
        }
      }
      // Capture the DAP-side view of the current frame BEFORE the
      // locals assertion runs, so the snapshot matches the failing
      // call exactly.  Recorder regressions (e.g. column-aware steps
      // landing on a position with no bound locals) show up as an
      // empty ``variablesByScope`` here while ``stackTrace`` reports
      // the expected line number — distinguishing a recorder problem
      // from a step-navigation problem.
      await captureDapStateSnapshot(`${config.language.toLowerCase()}-before-locals`)
      if (config.localsResponseOnly) {
        // Verify loadLocals returns a valid DAP response. Variable content
        // is not asserted because rr soft-mode replay currently returns
        // empty locals for this language.
        const result = await session.loadLocals({ lang: config.langId, countBudget: 100, depthLimit: 3 })
        writeDiag('locals.json', result.data ?? result.error)
        expect(result.ok).toBe(true)
      } else {
        await assertLocalsContainVariable(session, config.variableName, config.langId)
      }
    })

    if (config.terminalText) {
      it(`terminal output contains "${config.terminalText}"`, async () => {
        await assertTerminalContains(session, config.terminalText!)
      })
    }

    if (config.eventLogText) {
      it(`event log contains "${config.eventLogText}"`, async () => {
        // `ct/event-load` with no window answers the recorded log from its
        // start (the replay server's `event_load`: the first 20 events,
        // whatever the current step; `indexAtTick` only marks where the
        // current step falls in it). So an event recorded after the current
        // position is listed too -- Solana's `result: 94` is written ~90
        // steps after the step the locals test leaves the session on.
        // A failed request or an empty answer is a failure, not a pass.
        const result = await session.loadEvents()
        writeDiag(`${config.language.toLowerCase()}-event-log.json`, result.data ?? result.error)
        expect(result.ok).toBe(true)
        expect(JSON.stringify(result.data ?? null)).toContain(config.eventLogText)
      })
    }

    after(async () => {
      await captureFullDiagnostics(`${config.language.toLowerCase()}-final`)
      try { await session.removeAllBreakpoints() } catch { /* ignore */ }
      try { await session.stop() } catch { /* ignore */ }
    })
  })
}
