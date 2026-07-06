/**
 * Deep Rust trace tests for the CodeTracer VS Code extension.
 *
 * Extends the smoke test coverage with multi-step navigation, breakpoint
 * interaction, and variable value inspection. Requires a recorded Rust
 * sudoku trace (recorded via scripts/record-test-traces.sh).
 */
import { browser, expect } from '@wdio/globals'
import { DebugSession, EditorPane, ExtensionState } from '../../page-objects'
import { captureFullDiagnostics, screenshot, writeDiag } from '../../helpers/diagnostics'
import { resolveTracePath, traceExists } from '../../helpers/trace-utils'

const session = new DebugSession()
const editor = new EditorPane()
const ext = new ExtensionState()

describe('CodeTracer Extension - Rust Deep Test', () => {
  let traceDir: string

  before(function () {
    traceDir = resolveTracePath('rust-sudoku')
    if (!traceExists('rust-sudoku')) {
      const message =
        `Rust deep tests: trace not found at ${traceDir}\n` +
        'Run scripts/record-test-traces.sh to generate it.'
      throw new Error(message)
    }
  })

  afterEach(async function () {
    const testName = this.currentTest?.title?.replace(/[^a-zA-Z0-9_-]+/g, '-').substring(0, 50) ?? 'unknown'
    if (this.currentTest?.state === 'failed') {
      console.log(`[diag] Test failed: ${this.currentTest.title}`)
      await captureFullDiagnostics(`rust-deep-FAIL-${testName}`)
    }
    await screenshot(`rust-deep-${testName}`)
  })

  it('starts a debug session', async () => {
    await ext.ensureActivated()
    const started = await session.start(traceDir)
    expect(started).toBe(true)
  })

  it('opens main.rs in the editor', async () => {
    await browser.waitUntil(
      async () => editor.hasOpenTab('main.rs'),
      { timeout: 15000, timeoutMsg: 'main.rs tab did not open within 15s' },
    )
    const hasTab = await editor.hasOpenTab('main.rs')
    expect(hasTab).toBe(true)

    await browser.executeWorkbench(async (vscode) => {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input = tab.input as any
          if (input?.uri?.fsPath?.endsWith('main.rs')) {
            await vscode.window.showTextDocument(input.uri, { preserveFocus: false })
            return
          }
        }
      }
      throw new Error('main.rs tab is not available')
    })

    const state = await editor.state()
    expect(state).not.toBeNull()
    expect(state!.fileName).toContain('main.rs')
  })

  it('performs multiple step-over operations and stays in source', async () => {
    const locations: Array<{ file: string; line: number }> = []

    for (let i = 0; i < 5; i++) {
      const loc = await session.stepOver(3000)
      locations.push(loc)
      expect(loc.file.length).toBeGreaterThan(0)
      expect(loc.line).toBeGreaterThan(0)
    }

    writeDiag('rust-deep-multi-step.json', locations)
    console.log('Multi-step locations:', JSON.stringify(locations))

    // Verify we actually moved through different lines
    const uniqueLines = new Set(locations.map(l => l.line))
    expect(uniqueLines.size).toBeGreaterThan(1)
  })

  it('loads locals through the Rust DAP path', async () => {
    const result = await session.loadLocals({ lang: 'Rust', countBudget: 100, depthLimit: 3 })
    writeDiag('rust-deep-locals.json', result.data ?? result.error)
    console.log(`[Rust deep] loadLocals ok=${result.ok}, error=${result.error ?? 'none'}`)
    expect(result.ok).toBe(true)
    expect(result.data).toBeDefined()

    if (result.ok && result.data?.locals && Array.isArray(result.data.locals)) {
      const withValues = result.data.locals.filter(
        (l: any) => l.value !== undefined && l.value !== null && String(l.value).length > 0,
      )
      console.log(`Locals with values: ${withValues.length}/${result.data.locals.length}`)

      for (const v of withValues.slice(0, 5)) {
        console.log(`  ${v.name ?? v.variable_name}: ${JSON.stringify(v.value).substring(0, 80)}`)
      }
    }
  })

  it('sets breakpoint, continues, and verifies stopped location', async () => {
    await session.removeAllBreakpoints()

    // Set breakpoint at a line in main.rs
    const bpResult = await session.addBreakpoint(10)
    expect(bpResult.added).toBe(true)

    const location = await session.continue(5000)
    writeDiag('rust-deep-breakpoint.json', { bpResult, location })

    expect(location.file.length).toBeGreaterThan(0)
    expect(location.line).toBeGreaterThan(0)
  })

  it('loads calltrace after breakpoint navigation', async () => {
    const result = await session.loadCalltrace({ depth: 100, height: 500 })
    writeDiag('rust-deep-calltrace.json', result.data ?? result.error)
    console.log(`[Rust deep] loadCalltrace ok=${result.ok}, error=${result.error ?? 'none'}`)
    expect(result.ok).toBe(true)
    expect(result.data).toBeDefined()

    if (result.ok && result.data) {
      const dataStr = JSON.stringify(result.data)
      const hasMain = dataStr.includes('main')
      const hasSolve = dataStr.includes('solve')
      console.log(`Calltrace functions: main=${hasMain}, solve=${hasSolve}`)
      expect(hasMain || hasSolve).toBe(true)
    }
  })

  it('loads flow data and verifies structure', async () => {
    const result = await session.loadFlow(0)
    writeDiag('rust-deep-flow.json', result)
    expect(result.ok).toBe(true)
    expect(result.data).toBeDefined()

    console.log('Flow data keys:', Object.keys(result.data))
    const dataStr = JSON.stringify(result.data)
    expect(dataStr.length).toBeGreaterThan(2)
  })

  it('step-in and step-out complete without desynchronizing DAP replies', async () => {
    const before = await session.currentLocation()

    const inLoc = await session.stepIn(3000)
    expect(inLoc.file.length).toBeGreaterThan(0)
    expect(inLoc.line).toBeGreaterThan(0)
    writeDiag('rust-deep-step-in.json', { before, inLoc })

    const outLoc = await session.stepOut(3000)
    expect(outLoc.file.length).toBeGreaterThan(0)
    expect(outLoc.line).toBeGreaterThan(0)
    writeDiag('rust-deep-step-out.json', { inLoc, outLoc })

    const result = await session.loadCalltrace({ depth: 100, height: 500 })
    writeDiag('rust-deep-post-step-out-calltrace.json', result.data ?? result.error)
    expect(result.ok).toBe(true)
    expect(result.data).toBeDefined()
  })

  after(async () => {
    await captureFullDiagnostics('rust-deep-final')
    try { await session.removeAllBreakpoints() } catch { /* ignore */ }
    try { await session.stop() } catch { /* ignore */ }
  })
})
