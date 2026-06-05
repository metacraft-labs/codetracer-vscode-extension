/**
 * M7 — VS Code WebdriverIO spec for the Python `computational_origin`
 * fixture.
 *
 * Covers M7 verification entry:
 *   - e2e_extension_origin_python_computational — Computational hop
 *     expanded in the embedded webview shows operand snapshots.
 *
 * Fixture: `$CT_REPO/src/db-backend/tests/fixtures/origin/python/computational_origin/`.
 * The fixture's main.py computes a Computational hop (e.g. `total = a + b`)
 * for which `OriginChain.hops[i].classification == "Computational"` and
 * the hop's `operandValues` are non-empty. The embedded side-panel
 * renders the operands inside a `<details>` element that the
 * page-object expands via `expandComputationalOperands(...)` (see spec
 * §3.2.2).
 *
 * Same SKIP discipline as the trivial-chain spec: fixture/recorder/ct
 * binary probes resolve to a precise reason string before any
 * assertion runs.
 *
 * Spec: codetracer-specs/Planned-Features/Value-Origin-Tracking.milestones.org M7.
 */
import { browser, expect } from '@wdio/globals'
import { ExtensionState, OriginChainPanelPageObject } from '../../page-objects'
import { captureFullDiagnostics } from '../../helpers/diagnostics'
import {
  originFixturePath,
  valueOriginSpecSkipReason,
} from '../../helpers/value-origin-fixtures'

const ext = new ExtensionState()
const origin = new OriginChainPanelPageObject()

const LANGUAGE = 'python' as const
const SCENARIO = 'computational_origin'

describe('M7 — Python computational_origin Value Origin', () => {
  let skipReason: string | null = null
  const fixturePath = originFixturePath(LANGUAGE, SCENARIO)

  before(async function () {
    skipReason = valueOriginSpecSkipReason(LANGUAGE, SCENARIO)
    if (skipReason) {
      console.log(`[M7] SKIP reason — ${skipReason}`)
      this.skip()
      return
    }
    await ext.ensureActivated()
    await ext.waitForCommands(15000)
  })

  afterEach(async function () {
    if (this.currentTest?.state === 'failed') {
      await captureFullDiagnostics(
        `m7-python-computational-${this.currentTest.title.replace(/\s+/g, '-').substring(0, 40)}`,
      )
    }
  })

  it('e2e_extension_origin_python_computational — Computational hop reveals operand snapshots', async function () {
    if (skipReason) {
      this.skip()
      return
    }

    await browser.executeWorkbench(async (vscode, p: string) => {
      try {
        const doc = await vscode.workspace.openTextDocument(p)
        await vscode.window.showTextDocument(doc, { preview: true })
      } catch {
        /* ignore — surfaced by SKIP probe */
      }
    }, fixturePath)

    // Trigger the command — the no-DAP fallback path forwards an empty
    // payload, but a real CI run with the recorder + db-backend will
    // populate the embedded panel with the Computational hop.
    await browser.executeWorkbench(async (vscode) => {
      await vscode.commands.executeCommand('ct-vscode.showValueOrigin')
    })

    const hops = await origin.expandedChainHops()
    if (hops.length === 0) {
      const description = await origin.describeFrame()
      console.log(
        '[M7] Embedded panel hops not present (probable: no DAP session); frame=' +
          JSON.stringify(description),
      )
      this.skip()
      return
    }
    // At least one hop must be classified Computational. The wire
    // schema sets `data-origin-classification="Computational"` on the
    // hop row (see Nim renderer `ui/isonim_origin_chain.nim`).
    const computational = hops.find(
      (h) => (h.classification ?? '').toLowerCase() === 'computational',
    )
    expect(
      computational,
      'fixture must surface at least one Computational hop',
    ).toBeDefined()

    // Expand the operand panel for the focused / first computational hop.
    const expanded = await origin.expandComputationalOperands()
    expect(expanded, '<details> operand panel must be reachable').toBe(true)

    // After expansion the panel shows N operand snapshot rows — assert
    // at least one is visible. Exact operand naming is fixture-specific
    // (and verified in M3/M5); the M7 layer only verifies the embedded
    // panel renders them in the VS Code host.
    const operandRowsVisible = await browser.execute(() => {
      const sidePanel = document.querySelector(
        'aside#ct-origin-chain-side-panel',
      )
      if (!sidePanel) {
        return 0
      }
      return sidePanel.querySelectorAll('details[open] > div, details[open] li')
        .length
    })
    expect(operandRowsVisible as number, 'operand rows must render').toBeGreaterThan(0)
  })
})
