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
import { DebugSession, ExtensionState, OriginChainPanelPageObject, openStatePanel } from '../../page-objects'
import { captureFullDiagnostics } from '../../helpers/diagnostics'
import { latestOriginChainFailure } from '../../helpers/origin-chain-diagnostics'
import {
  originFixturePath,
  originFixtureTracePath,
  valueOriginSpecSkipReason,
} from '../../helpers/value-origin-fixtures'

const ext = new ExtensionState()
const debug = new DebugSession()
const origin = new OriginChainPanelPageObject()

const LANGUAGE = 'ruby' as const
const SCENARIO = 'simple_trivial_chain'
const TARGET_LINE = 6

describe('M7 — Ruby simple_trivial_chain Value Origin', () => {
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
        `m7-ruby-canonical-${this.currentTest.title.replace(/\s+/g, '-').substring(0, 40)}`,
      )
    }
  })

  it('e2e_extension_origin_ruby_canonical — three hops + literal terminator render', async function () {
    if (skipReason) {
      throw new Error(skipReason ?? 'Expected value-origin UI path was unavailable: no embedded Origin Chain panel, State rows, or DAP-backed origin payload was rendered')
      return
    }

    await browser.executeWorkbench(async (vscode, p: string) => {
      try {
        const doc = await vscode.workspace.openTextDocument(p)
        await vscode.window.showTextDocument(doc, { preview: true })
      } catch {
        /* ignore — prerequisite probe owns this */
      }
    }, fixturePath)

    // Forward the showValueOrigin command. With a recorder-equipped CI
    // run this populates the embedded panel via the M6 bridge.
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
      const backendFailure = latestOriginChainFailure('c')
      if (backendFailure) {
        throw new Error(backendFailure)
      }
      throw new Error(skipReason ?? 'Expected value-origin UI path was unavailable: no embedded Origin Chain panel, State rows, or DAP-backed origin payload was rendered')
      return
    }
    // Ruby canonical chain matches the Python canonical chain:
    // `c -> b -> a -> Literal(10)`.
    expect(hops.length).toBe(3)
    const terminatorText = await origin.terminatorText()
    expect(String(terminatorText)).toContain('10')
  })
})
