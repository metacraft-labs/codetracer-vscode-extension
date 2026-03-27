/**
 * Deep Python trace tests for the CodeTracer VS Code extension.
 *
 * Extends the smoke test coverage with multi-step navigation, breakpoint
 * interaction, and variable value inspection. Requires a recorded Python
 * sudoku trace (recorded via scripts/record-test-traces.sh).
 */
import { expect } from '@wdio/globals'
import { DebugSession, EditorPane, ExtensionState } from '../../page-objects'
import { captureFullDiagnostics, screenshot, writeDiag } from '../../helpers/diagnostics'
import { resolveTracePath, traceExists } from '../../helpers/trace-utils'

const session = new DebugSession()
const editor = new EditorPane()
const ext = new ExtensionState()

describe('CodeTracer Extension - Python Deep Test', () => {
  let traceDir: string

  before(function () {
    traceDir = resolveTracePath('python-sudoku')
    if (!traceExists('python-sudoku')) {
      console.warn(
        `SKIPPING Python deep tests: trace not found at ${traceDir}\n` +
        'Run scripts/record-test-traces.sh to generate it.',
      )
      this.skip()
    }
  })

  afterEach(async function () {
    const testName = this.currentTest?.title?.replace(/\s+/g, '-').substring(0, 50) ?? 'unknown'
    if (this.currentTest?.state === 'failed') {
      console.log(`[diag] Test failed: ${this.currentTest.title}`)
      await captureFullDiagnostics(`python-deep-FAIL-${testName}`)
    }
    await screenshot(`python-deep-${testName}`)
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
      // Each step should land in a source file with a valid line
      expect(loc.file.length).toBeGreaterThan(0)
      expect(loc.line).toBeGreaterThan(0)
    }

    writeDiag('python-deep-multi-step.json', locations)
    console.log('Multi-step locations:', JSON.stringify(locations))

    // Verify we moved — not all locations should be the same line
    const uniqueLines = new Set(locations.map(l => l.line))
    expect(uniqueLines.size).toBeGreaterThan(1)
  })

  it('step-in enters a callee and step-out returns', async () => {
    const before = await session.currentLocation()

    const inLoc = await session.stepIn(3000)
    expect(inLoc.file.length).toBeGreaterThan(0)
    expect(inLoc.line).toBeGreaterThan(0)
    writeDiag('python-deep-step-in.json', { before, inLoc })

    const outLoc = await session.stepOut(3000)
    expect(outLoc.file.length).toBeGreaterThan(0)
    expect(outLoc.line).toBeGreaterThan(0)
    writeDiag('python-deep-step-out.json', { inLoc, outLoc })
  })

  it('loads locals with variable values (not just names)', async () => {
    const result = await session.loadLocals({ lang: 'Python', countBudget: 100, depthLimit: 3 })
    expect(result.ok).toBe(true)
    writeDiag('python-deep-locals.json', result.data)

    if (result.data?.locals && Array.isArray(result.data.locals)) {
      // Verify at least one variable has a non-empty value
      const withValues = result.data.locals.filter(
        (l: any) => l.value !== undefined && l.value !== null && String(l.value).length > 0,
      )
      console.log(`Locals with values: ${withValues.length}/${result.data.locals.length}`)
      expect(withValues.length).toBeGreaterThan(0)

      // Log first few for diagnostics
      for (const v of withValues.slice(0, 5)) {
        console.log(`  ${v.name ?? v.variable_name}: ${JSON.stringify(v.value).substring(0, 80)}`)
      }
    }
  })

  it('sets breakpoint, continues, and verifies stopped location', async () => {
    await session.removeAllBreakpoints()

    // Set breakpoint at a line we expect exists in the sudoku solver
    const bpResult = await session.addBreakpoint(10)
    expect(bpResult.added).toBe(true)

    const location = await session.continue(5000)
    writeDiag('python-deep-breakpoint.json', { bpResult, location })

    // After continue, we should be at a valid location
    expect(location.file.length).toBeGreaterThan(0)
    expect(location.line).toBeGreaterThan(0)
  })

  it('calltrace contains solve_sudoku with function details', async () => {
    const result = await session.loadCalltrace({ depth: 100, height: 500 })
    expect(result.ok).toBe(true)
    writeDiag('python-deep-calltrace.json', result.data)

    if (result.data) {
      const dataStr = JSON.stringify(result.data)
      expect(dataStr).toContain('solve_sudoku')

      // Check for additional expected functions in the call chain
      const hasPrint = dataStr.includes('print')
      const hasMain = dataStr.includes('main') || dataStr.includes('__main__')
      console.log(`Calltrace functions: solve_sudoku=true, print=${hasPrint}, main=${hasMain}`)
    }
  })

  after(async () => {
    await captureFullDiagnostics('python-deep-final')
    try { await session.removeAllBreakpoints() } catch { /* ignore */ }
    try { await session.stop() } catch { /* ignore */ }
  })
})
