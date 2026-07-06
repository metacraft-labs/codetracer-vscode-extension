/**
 * M11 — VS Code WebdriverIO spec for the multi-threaded C
 * `cross_thread_copy` Value Origin fixture against an RR-backed trace.
 *
 * Covers M11 verification entry:
 *
 *   - e2e_extension_origin_c_cross_thread_copy_in_vscode — opens the
 *     fixture trace; the TreeView + embedded webview render a hop
 *     with kind=CrossThreadCopy plus the confidence badge "0.6".
 *
 * Fixture: `$CT_REPO/src/db-backend/tests/fixtures/origin/c/cross_thread_copy/`.
 *
 * Environment skip discipline mirrors M7: when the locally synced
 * fixture is missing or the RR toolchain (rr, ct-native-replay, gcc)
 * isn't available, SKIP cleanly with a precise reason.
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

const SHOW_VALUE_ORIGIN_COMMAND = 'ct-vscode.showValueOrigin'
const LANGUAGE = 'c' as const
const SCENARIO = 'cross_thread_copy'
const TARGET_LINE = 43

async function focusOnLocal(fixturePath: string): Promise<boolean> {
  return browser.executeWorkbench(async (vscode, p: string) => {
    try {
      const doc = await vscode.workspace.openTextDocument(p)
      const editor = await vscode.window.showTextDocument(doc, { preview: true })
      const text = doc.getText()
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const idx = lines[i].indexOf('printf("%d\\n", local)')
        if (idx >= 0) {
          // Inside the printf, `local` starts at idx + 'printf("%d\\n", '.length
          const offset = 'printf("%d\\n", '.length
          const col = idx + offset
          editor.selection = new vscode.Selection(
            new vscode.Position(i, col),
            new vscode.Position(i, col + 'local'.length),
          )
          return true
        }
      }
      return false
    } catch {
      return false
    }
  }, fixturePath)
}

describe('M11 — C cross_thread_copy Value Origin (RR-backed)', () => {
  let skipReason: string | null = null
  const fixturePath = originFixturePath(LANGUAGE, SCENARIO)
  const tracePath = originFixtureTracePath(LANGUAGE, SCENARIO)

  before(async function () {
    skipReason = valueOriginSpecSkipReason(LANGUAGE, SCENARIO)
    if (skipReason) {
      console.log(`[M11] prerequisite failure — ${skipReason}`)
      throw new Error(skipReason)
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
        `m11-c-cross-thread-${this.currentTest.title.replace(/\s+/g, '-').substring(0, 40)}`,
      )
    }
  })

  it('e2e_extension_origin_c_cross_thread_copy_in_vscode — CrossThreadCopy hop renders with 0.6 confidence', async function () {
    if (skipReason) {
      throw new Error(skipReason)
      return
    }

    const focused = await focusOnLocal(fixturePath)
    expect(focused).toBe(true)

    const result = await browser.executeWorkbench(
      async (vscode, command: string) => {
        const extension = vscode.extensions.getExtension('metacraft-labs.ct-vscode')
        if (!extension) {
          return { error: 'extension not found', commandMessage: null as any }
        }
        if (!extension.isActive) {
          await extension.activate()
        }
        const exports = extension.exports as any
        if (!exports || typeof exports.registerPanelOverride !== 'function') {
          return { error: 'M6 test seam missing', commandMessage: null as any }
        }
        const messages: any[] = []
        const dispose = exports.registerPanelOverride('m11-c-cross-thread', {
          webview: {
            postMessage(msg: any) {
              messages.push(msg)
              return Promise.resolve(true)
            },
          },
        })
        try {
          await vscode.commands.executeCommand(command)
        } finally {
          dispose()
        }
        const commandMessage = messages.find((m) => m?.command === 'showValueOrigin')
        return { error: null as string | null, commandMessage }
      },
      SHOW_VALUE_ORIGIN_COMMAND,
    )

    expect((result as any).error).toBeNull()
    const msg = (result as any).commandMessage
    expect(msg).toBeDefined()
    expect(msg?.value?.expression).toBe('local')

    // The override above verifies command forwarding without rendering
    // into the real panel. Re-run through the normal path so the embedded
    // State/Origin side panel receives the DAP-backed chain and renders it.
    await browser.executeWorkbench(async (vscode, command: string) => {
      await vscode.commands.executeCommand(command)
    }, SHOW_VALUE_ORIGIN_COMMAND)
    await openStatePanel()

    const hops = await origin.expandedChainHops()
    if (hops.length === 0) {
      const description = await origin.describeFrame()
      console.log(
        '[M11] Embedded panel hops not present — frame=' + JSON.stringify(description),
      )
      const backendFailure = latestOriginChainFailure('local')
      if (backendFailure) {
        throw new Error(backendFailure)
      }
      throw new Error('Expected DOM-rendered CrossThreadCopy origin hops, but the embedded Origin Chain panel did not render any hops')
      return
    }

    // The chain must render at least one CrossThreadCopy hop with the
    // 0.6 confidence badge — the panel exposes per-hop kind + confidence
    // via test-ids the renderer emits.
    const crossThreadHops = hops.filter((h: any) => h?.kind === 'CrossThreadCopy' || h?.kind === 'crossThreadCopy')
    expect(crossThreadHops.length).toBeGreaterThanOrEqual(1)
    const confidences = crossThreadHops.map((h: any) => Number(h?.confidence))
    expect(confidences.some((c: number) => Math.abs(c - 0.6) < 0.05)).toBe(true)
  })
})
