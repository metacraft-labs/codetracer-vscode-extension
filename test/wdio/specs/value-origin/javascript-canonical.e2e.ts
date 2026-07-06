/**
 * M7 — VS Code WebdriverIO spec for the JavaScript `simple_trivial_chain`
 * fixture.
 *
 * Covers M7 verification entry:
 *   - e2e_extension_origin_javascript_canonical — JS fixture chain
 *     renders correctly inside the embedded panel.
 *
 * Fixture: `$CT_REPO/src/db-backend/tests/fixtures/origin/javascript/simple_trivial_chain/`.
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

const LANGUAGE = 'javascript' as const
const SCENARIO = 'simple_trivial_chain'
const SHOW_VALUE_ORIGIN_COMMAND = 'ct-vscode.showValueOrigin'
const TARGET_LINE = 7

async function focusOnVariableC(fixturePath: string): Promise<boolean> {
  return browser.executeWorkbench(async (vscode, p: string) => {
    try {
      const doc = await vscode.workspace.openTextDocument(p)
      const editor = await vscode.window.showTextDocument(doc, { preview: true })
      const text = doc.getText()
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const idx = lines[i].indexOf('console.log(c)')
        if (idx >= 0) {
          const cCol = idx + 'console.log('.length
          const pos = new vscode.Position(i, cCol)
          editor.selection = new vscode.Selection(
            pos,
            new vscode.Position(i, cCol + 1),
          )
          editor.revealRange(new vscode.Range(pos, pos))
          return true
        }
      }
      return false
    } catch {
      return false
    }
  }, fixturePath)
}

describe('M7 — JavaScript simple_trivial_chain Value Origin', () => {
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
        `m7-js-canonical-${this.currentTest.title.replace(/\s+/g, '-').substring(0, 40)}`,
      )
    }
  })

  it('e2e_extension_origin_javascript_canonical — three hops + literal terminator render', async function () {
    if (skipReason) {
      throw new Error(skipReason ?? 'Expected value-origin UI path was unavailable: no embedded Origin Chain panel, State rows, or DAP-backed origin payload was rendered')
      return
    }

    const focused = await focusOnVariableC(fixturePath)
    expect(focused).toBe(true)

    const result = await browser.executeWorkbench(
      async (vscode, command: string) => {
        const extension = vscode.extensions.getExtension('metacraft-labs.ct-vscode')
        if (!extension) {
          return { error: 'extension not found', delivered: 0, messages: [] as any[] }
        }
        if (!extension.isActive) {
          await extension.activate()
        }
        const exports = extension.exports as any
        if (!exports || typeof exports.registerPanelOverride !== 'function') {
          return { error: 'M6 test seam missing', delivered: 0, messages: [] as any[] }
        }
        const messages: any[] = []
        const dispose = exports.registerPanelOverride('m7-js-canonical', {
          webview: {
            postMessage(msg: any) {
              messages.push(msg)
              return Promise.resolve(true)
            },
          },
        })
        try {
          const delivered = await vscode.commands.executeCommand(command)
          return { error: null as string | null, delivered, messages }
        } finally {
          dispose()
        }
      },
      SHOW_VALUE_ORIGIN_COMMAND,
    )

    expect((result as any).error).toBeNull()
    expect(Number((result as any).delivered)).toBeGreaterThanOrEqual(1)
    const commandMessage = (result as any).messages.find((m: any) => m?.command === 'showValueOrigin')
    expect(commandMessage?.value?.expression).toBe('c')
    const chainMessage = (result as any).messages.find((m: any) => m?.command === 'ct/updated-origin-chain')
    expect(chainMessage).toBeDefined()
    expect(chainMessage?.value?.queryVariable).toBe('c')
    expect((chainMessage?.value?.hops ?? []).length).toBe(3)

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
    expect(hops.length).toBe(3)

    const terminatorText = await origin.terminatorText()
    expect(String(terminatorText)).toContain('10')
  })
})
