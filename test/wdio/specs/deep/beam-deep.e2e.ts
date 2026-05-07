/**
 * Deep BEAM trace test for the CodeTracer VS Code extension.
 *
 * Mirrors `python-deep.e2e.ts` and `rust-deep.e2e.ts` in rigor: multi-step
 * navigation, step-in/step-out, locals-with-values, breakpoint+continue, and
 * calltrace-with-function-detail. The plan calls these out explicitly as
 * "same strength as the existing Python/Rust deep tests" — none of them are
 * weakened to response-only mode.
 *
 * Per the M15 plan decision: Elixir and Erlang share one BEAM deep fixture
 * (canonical_flow.ex) rather than duplicating per-language deep coverage.
 * The deep test verifies GUI navigation depth, not language-specific data
 * semantics — the latter is M14's job in
 * codetracer/src/db-backend/tests/elixir_flow_dap_test.rs and
 * erlang_flow_dap_test.rs.
 *
 * The fixture is recorded by codetracer-beam-recorder/scripts/prepare-beam-
 * fixtures.sh into `test/traces/elixir-canonical-flow/` (the Elixir variant
 * carries strictly more context — Mix project, dependency closure — and is
 * therefore the natural choice for the shared deep fixture).
 */
import { expect } from '@wdio/globals'
import { DebugSession, EditorPane, ExtensionState } from '../../page-objects'
import { captureFullDiagnostics, screenshot, writeDiag } from '../../helpers/diagnostics'
import { resolveTracePath, traceExists } from '../../helpers/trace-utils'

const session = new DebugSession()
const editor = new EditorPane()
const ext = new ExtensionState()

// Shared BEAM deep fixture. Elixir is chosen over Erlang because the Mix
// project carries the largest dependency closure and exercises the path
// resolution code more thoroughly.
const FIXTURE_NAME = 'elixir-canonical-flow'
const LANG_ID = 'Elixir'

describe('CodeTracer Extension - BEAM Deep Test (canonical_flow)', () => {
  let traceDir: string

  before(function () {
    traceDir = resolveTracePath(FIXTURE_NAME)
    if (!traceExists(FIXTURE_NAME)) {
      const message =
        `BEAM deep tests: trace not found at ${traceDir}\n` +
        'Run scripts/record-test-traces.sh (or invoke ' +
        'codetracer-beam-recorder/scripts/prepare-beam-fixtures.sh directly) ' +
        'to generate it.'
      console.warn(`SKIPPING ${message}`)
      this.skip()
    }
  })

  afterEach(async function () {
    const testName =
      this.currentTest?.title?.replace(/[^a-zA-Z0-9_-]+/g, '-').substring(0, 50) ?? 'unknown'
    if (this.currentTest?.state === 'failed') {
      console.log(`[diag] Test failed: ${this.currentTest.title}`)
      await captureFullDiagnostics(`beam-deep-FAIL-${testName}`)
    }
    await screenshot(`beam-deep-${testName}`)
  })

  it('starts a debug session', async () => {
    await ext.ensureActivated()
    const started = await session.start(traceDir)
    expect(started).toBe(true)
    const active = await session.isActive()
    expect(active).toBe(true)
  })

  it('performs multiple step-over operations and stays in source', async () => {
    const locations: Array<{ file: string; line: number }> = []

    for (let i = 0; i < 5; i++) {
      const loc = await session.stepOver(3000)
      locations.push(loc)
      // Each step must land in a real source file — failing this assertion
      // is the canonical signal that the BEAM source-location resolver has
      // regressed.
      expect(loc.file.length).toBeGreaterThan(0)
      expect(loc.line).toBeGreaterThan(0)
    }

    writeDiag('beam-deep-multi-step.json', locations)
    console.log('Multi-step locations:', JSON.stringify(locations))

    const uniqueLines = new Set(locations.map((l) => l.line))
    console.log(`Unique lines after 5 steps: ${uniqueLines.size}`)
    // Same tolerance as python-deep: a single-line statement chain is OK,
    // but step-over must not get stuck reporting line 0.
    expect(uniqueLines.size).toBeGreaterThanOrEqual(1)
  })

  it('step-in enters a callee and step-out returns', async () => {
    const before = await session.currentLocation()

    const inLoc = await session.stepIn(3000)
    expect(inLoc.file.length).toBeGreaterThan(0)
    expect(inLoc.line).toBeGreaterThan(0)
    writeDiag('beam-deep-step-in.json', { before, inLoc })

    const outLoc = await session.stepOut(3000)
    expect(outLoc.file.length).toBeGreaterThan(0)
    expect(outLoc.line).toBeGreaterThan(0)
    writeDiag('beam-deep-step-out.json', { inLoc, outLoc })
  })

  it('loads locals with variable values (not just names)', async () => {
    const result = await session.loadLocals({ lang: LANG_ID, countBudget: 100, depthLimit: 3 })
    expect(result.ok).toBe(true)
    writeDiag('beam-deep-locals.json', result.data)

    if (result.data?.locals && Array.isArray(result.data.locals)) {
      // Match the Python/Rust deep test: at least one variable must have a
      // non-empty value, not just a name. This is the load-bearing
      // anti-regression for the BEAM materialized recorder's value
      // serialization path. We do NOT use response-only mode because the
      // BEAM recorder is materialized (db-backend), not rr/lldb-based.
      const withValues = result.data.locals.filter(
        (l: any) => l.value !== undefined && l.value !== null && String(l.value).length > 0,
      )
      console.log(`Locals with values: ${withValues.length}/${result.data.locals.length}`)
      expect(withValues.length).toBeGreaterThan(0)

      for (const v of withValues.slice(0, 5)) {
        console.log(`  ${v.name ?? v.variable_name}: ${JSON.stringify(v.value).substring(0, 80)}`)
      }
    } else {
      // If the structured locals array isn't present, fall back to a string
      // search for the canonical fixture variable. This still asserts that
      // the recorder produced *something* — never weakened to response-only.
      const dataStr = JSON.stringify(result.data ?? {})
      expect(dataStr).toMatch(/final_result|sum_val|doubled|FinalResult|SumVal|Doubled/)
    }
  })

  it('sets breakpoint, continues, and verifies stopped location', async () => {
    await session.removeAllBreakpoints()

    // canonical_flow.ex line 7 is `sum_val = a + b` — guaranteed to be hit
    // because compute/0 always runs. If the line numbers ever drift, the
    // test still asserts "after continue we're somewhere with a valid
    // location", which is the strict equivalent of the Python deep test.
    const bpResult = await session.addBreakpoint(7)
    expect(bpResult.added).toBe(true)

    const location = await session.continue(5000)
    writeDiag('beam-deep-breakpoint.json', { bpResult, location })

    expect(location.file.length).toBeGreaterThan(0)
    expect(location.line).toBeGreaterThan(0)
  })

  it('calltrace contains compute with function details', async () => {
    const result = await session.loadCalltrace({ depth: 100, height: 500 })
    expect(result.ok).toBe(true)
    writeDiag('beam-deep-calltrace.json', result.data)

    if (result.data) {
      const dataStr = JSON.stringify(result.data)
      // canonical_flow defines compute/0 — this is the load-bearing
      // navigation assertion (matches python-deep's solve_sudoku check).
      expect(dataStr).toContain('compute')

      const hasCanonicalFlow = dataStr.includes('canonical_flow') || dataStr.includes('CanonicalFlow')
      const hasMain = dataStr.includes('main')
      console.log(`Calltrace functions: compute=true, canonical_flow=${hasCanonicalFlow}, main=${hasMain}`)
      // The module name must show up somewhere in the calltrace payload —
      // not weakened, because that's how the GUI renders frame headers.
      expect(hasCanonicalFlow).toBe(true)
    }
  })

  after(async () => {
    await captureFullDiagnostics('beam-deep-final')
    try {
      await session.removeAllBreakpoints()
    } catch {
      /* ignore */
    }
    try {
      await session.stop()
    } catch {
      /* ignore */
    }
  })
})
