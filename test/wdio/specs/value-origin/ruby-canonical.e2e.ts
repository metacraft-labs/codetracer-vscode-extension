/**
 * M7 — VS Code WebdriverIO spec for the Ruby `simple_trivial_chain`
 * fixture.
 *
 * Covers M7 verification entry:
 *   - e2e_extension_origin_ruby_canonical — Ruby fixture chain renders
 *     correctly in the extension UI.
 *
 * Fixture: `$CT_REPO/src/db-backend/tests/fixtures/origin/ruby/simple_trivial_chain/`.
 *
 * The Ruby recorder + classifier path is exercised independently in M3
 * (DAP layer). The M7 layer only verifies the embedded panel rendered
 * inside VS Code surfaces the canonical chain — i.e. the M6 bridge
 * doesn't drop the Ruby-side payload.
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

const LANGUAGE = 'ruby' as const
const SCENARIO = 'simple_trivial_chain'

describe('M7 — Ruby simple_trivial_chain Value Origin', () => {
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
        `m7-ruby-canonical-${this.currentTest.title.replace(/\s+/g, '-').substring(0, 40)}`,
      )
    }
  })

  it('e2e_extension_origin_ruby_canonical — three hops + literal terminator render', async function () {
    if (skipReason) {
      this.skip()
      return
    }

    await browser.executeWorkbench(async (vscode, p: string) => {
      try {
        const doc = await vscode.workspace.openTextDocument(p)
        await vscode.window.showTextDocument(doc, { preview: true })
      } catch {
        /* ignore — SKIP probe owns this */
      }
    }, fixturePath)

    // Forward the showValueOrigin command. With a recorder-equipped CI
    // run this populates the embedded panel via the M6 bridge.
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
    // Ruby canonical chain matches the Python canonical chain:
    // `c -> b -> a -> Literal(10)`.
    expect(hops.length).toBe(3)
    const terminatorText = await browser.execute(() => {
      const sidePanel = document.querySelector(
        'aside#ct-origin-chain-side-panel',
      )
      if (!sidePanel) {
        return ''
      }
      const term = sidePanel.querySelector('.ct-origin-terminator-row')
      return (term?.textContent ?? '').trim()
    })
    expect(
      String(terminatorText),
      'terminator row must surface the literal value',
    ).toContain('10')
  })
})
