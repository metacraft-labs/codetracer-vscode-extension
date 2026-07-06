/**
 * M7 — VS Code WebdriverIO spec for the Python `parameter_pass` fixture
 * (frame-transition hops).
 *
 * Frame-transition hops are emitted when value origin crosses a
 * function-call boundary (e.g. a parameter pass at the call site).
 * The corresponding hop row carries a frame-change indicator that
 * the embedded Origin Chain Panel renders distinctly from the
 * straight-line TrivialCopy hops.
 *
 * This spec verifies the embedded panel actually surfaces a
 * frame-transition hop when one is present in the chain — i.e. that
 * the M6 post-message bridge faithfully delivers the wire-schema
 * `crossesFrame`/`frameTransition` annotation through to the embedded
 * webview without losing it in the extension layer.
 *
 * Fixture: `$CT_REPO/src/db-backend/tests/fixtures/origin/python/parameter_pass/`.
 *
 * Spec: codetracer-specs/Planned-Features/Value-Origin-Tracking.milestones.org M7.
 */
import { browser, expect } from '@wdio/globals'
import { DebugSession, ExtensionState, OriginChainPanelPageObject, openStatePanel } from '../../page-objects'
import { captureFullDiagnostics } from '../../helpers/diagnostics'
import {
  originFixturePath,
  originFixtureTracePath,
  valueOriginSpecSkipReason,
} from '../../helpers/value-origin-fixtures'

const ext = new ExtensionState()
const debug = new DebugSession()
const origin = new OriginChainPanelPageObject()

const LANGUAGE = 'python' as const
const SCENARIO = 'parameter_pass'
const TARGET_LINE = 9

describe('M7 — Python parameter_pass Value Origin (frame transitions)', () => {
  let skipReason: string | null = null
  const fixturePath = originFixturePath(LANGUAGE, SCENARIO)
  const tracePath = originFixtureTracePath(LANGUAGE, SCENARIO)

  before(async function () {
    skipReason = valueOriginSpecSkipReason(LANGUAGE, SCENARIO)
    if (skipReason) {
      console.log(`[M7] prerequisite failure — ${skipReason}`)
      throw new Error(skipReason ?? 'Expected value-origin UI path was unavailable: no embedded Origin Chain panel, State rows, or DAP-backed origin payload was rendered')
      return
    }
    await ext.ensureActivated()
    await ext.waitForCommands(15000)
    const started = await debug.start(tracePath)
    if (!started) {
      throw new Error(`codetracer-debug session must start for ${tracePath}`)
    }
    await debug.waitForBackendReady()
    await browser.executeWorkbench(async (vscode, p: string) => {
      const doc = await vscode.workspace.openTextDocument(p)
      await vscode.window.showTextDocument(doc, { preview: true })
    }, fixturePath)
    await debug.addBreakpoint(TARGET_LINE)
    await debug.continue(3000)
    await openStatePanel()
  })

  after(async function () {
    await debug.stop()
  })

  afterEach(async function () {
    if (this.currentTest?.state === 'failed') {
      await captureFullDiagnostics(
        `m7-python-frame-transitions-${this.currentTest.title.replace(/\s+/g, '-').substring(0, 40)}`,
      )
    }
  })

  it('embedded panel surfaces a frame-transition hop in the parameter_pass chain', async function () {
    if (skipReason) {
      throw new Error(skipReason ?? 'Expected value-origin UI path was unavailable: no embedded Origin Chain panel, State rows, or DAP-backed origin payload was rendered')
      return
    }

    await browser.executeWorkbench(async (vscode, p: string) => {
      try {
        const doc = await vscode.workspace.openTextDocument(p)
        await vscode.window.showTextDocument(doc, { preview: true })
      } catch {
        /* ignore — prerequisite probe owned that */
      }
    }, fixturePath)
    await browser.executeWorkbench(async (vscode) => {
      await vscode.commands.executeCommand('ct-vscode.showValueOrigin')
    })
    await openStatePanel()

    const hops = await origin.expandedChainHops()
    if (hops.length === 0) {
      const description = await origin.describeFrame()
      console.log(
        '[M7] Embedded panel hops not present (probable: no DAP session); frame=' +
          JSON.stringify(description),
      )
      throw new Error(skipReason ?? 'Expected value-origin UI path was unavailable: no embedded Origin Chain panel, State rows, or DAP-backed origin payload was rendered')
      return
    }

    // A parameter-pass chain has at least one hop whose row carries
    // a frame-transition marker. The Nim renderer applies one of:
    //   - data-origin-classification="FrameTransition"
    //   - a `.ct-origin-frame-transition` class on the row
    //   - aria-label that mentions "frame transition" (a11y label)
    // Any of the three is sufficient — they are alternative encodings
    // of the same wire-schema annotation.
    const markerPresent = await origin.hasFrameTransitionMarker()
    if (!markerPresent) {
      throw new Error('parameter_pass chain must include a frame-transition hop annotation')
    }
  })
})
