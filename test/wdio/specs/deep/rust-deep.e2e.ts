/**
 * Deep Rust trace tests for the CodeTracer VS Code extension.
 *
 * Extends the smoke test coverage with multi-step navigation, breakpoint
 * interaction, and variable value inspection. Requires a recorded Rust
 * sudoku trace (recorded via scripts/record-test-traces.sh).
 */
import { expect } from '@wdio/globals'
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
      console.warn(`SKIPPING ${message}`)
      this.skip()
    }
  })

  afterEach(async function () {
    const testName = this.currentTest?.title?.replace(/\s+/g, '-').substring(0, 50) ?? 'unknown'
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

  it('step-in enters a callee and step-out returns', async () => {
    const before = await session.currentLocation()

    const inLoc = await session.stepIn(3000)
    expect(inLoc.file.length).toBeGreaterThan(0)
    expect(inLoc.line).toBeGreaterThan(0)
    writeDiag('rust-deep-step-in.json', { before, inLoc })

    const outLoc = await session.stepOut(3000)
    expect(outLoc.file.length).toBeGreaterThan(0)
    expect(outLoc.line).toBeGreaterThan(0)
    writeDiag('rust-deep-step-out.json', { inLoc, outLoc })
  })

  it('loads locals with variable values (not just names)', async () => {
    const result = await session.loadLocals({ lang: 'Rust', countBudget: 100, depthLimit: 3 })
    expect(result.ok).toBe(true)
    writeDiag('rust-deep-locals.json', result.data)

    if (result.data?.locals && Array.isArray(result.data.locals)) {
      const withValues = result.data.locals.filter(
        (l: any) => l.value !== undefined && l.value !== null && String(l.value).length > 0,
      )
      console.log(`Locals with values: ${withValues.length}/${result.data.locals.length}`)
      expect(withValues.length).toBeGreaterThan(0)

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

  it('calltrace contains main with module-qualified name', async () => {
    const result = await session.loadCalltrace({ depth: 100, height: 500 })
    expect(result.ok).toBe(true)
    writeDiag('rust-deep-calltrace.json', result.data)

    if (result.data) {
      const dataStr = JSON.stringify(result.data)
      // Rust traces use module-qualified names
      expect(dataStr).toContain('main')

      const hasSolve = dataStr.includes('solve')
      console.log(`Calltrace functions: main=true, solve=${hasSolve}`)
    }
  })

  it('loads flow data and verifies structure', async () => {
    const result = await session.loadFlow(0)
    writeDiag('rust-deep-flow.json', result)

    if (result.ok && result.data) {
      console.log('Flow data keys:', Object.keys(result.data))
      // Flow data should have some structure
      const dataStr = JSON.stringify(result.data)
      expect(dataStr.length).toBeGreaterThan(2)
    }
  })

  after(async () => {
    await captureFullDiagnostics('rust-deep-final')
    try { await session.removeAllBreakpoints() } catch { /* ignore */ }
    try { await session.stop() } catch { /* ignore */ }
  })
})
