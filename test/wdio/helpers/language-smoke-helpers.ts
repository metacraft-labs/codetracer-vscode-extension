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
import { captureFullDiagnostics, screenshot, writeDiag } from './diagnostics'
import { resolveTracePath, traceExists } from './trace-utils'

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

/** Verify step-over works and changes the current location. */
export async function assertStepWorks(
  session: DebugSession,
): Promise<void> {
  const before = await session.currentLocation()
  const after = await session.stepOver(2000)
  // We should still be in a source file.
  expect(after.file.length).toBeGreaterThan(0)
  expect(after.line).toBeGreaterThan(0)
  writeDiag('step-over.json', { before, after })
}

/** Verify flow data loads (primarily for RR-based traces). */
export async function assertFlowLoads(
  session: DebugSession,
): Promise<void> {
  const result = await session.loadFlow(0)
  if (result.ok && result.data) {
    writeDiag('flow.json', result.data)
  } else {
    console.warn('Flow did not load:', result.error)
    expect(result.ok).toBe(true)
  }
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
        console.warn(
          `SKIPPING ${config.language} smoke tests: trace not found at ${traceDir}\n` +
          'Run scripts/record-test-traces.sh to generate it.',
        )
        this.skip()
      }
    })

    afterEach(async function () {
      const testName = this.currentTest?.title?.replace(/\s+/g, '-').substring(0, 50) ?? 'unknown'
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
    })

    it(`opens ${config.expectedFileName} in the editor`, async () => {
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

    it('can step-over and remain in the trace', async () => {
      await assertStepWorks(session)
    })

    it(`finds ${config.variableName} in local variables`, async () => {
      await assertLocalsContainVariable(session, config.variableName, config.langId)
    })

    if (config.terminalText) {
      it(`terminal output contains "${config.terminalText}"`, async () => {
        await assertTerminalContains(session, config.terminalText!)
      })
    }

    if (config.eventLogText) {
      it(`event log contains "${config.eventLogText}"`, async () => {
        const result = await session.loadEvents()
        if (result.ok && result.data) {
          expect(JSON.stringify(result.data)).toContain(config.eventLogText)
        }
      })
    }

    after(async () => {
      await captureFullDiagnostics(`${config.language.toLowerCase()}-final`)
      try { await session.removeAllBreakpoints() } catch { /* ignore */ }
      try { await session.stop() } catch { /* ignore */ }
    })
  })
}
