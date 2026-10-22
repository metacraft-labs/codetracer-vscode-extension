/**
 * Value Origin Tracking — M6 verification spec #3.
 *
 * `test_extension_forwards_updated_origin_chain_event_into_embedded_webview`
 *
 * The db-backend emits `ct/updated-origin-chain` as a lazy-continuation
 * DAP event alongside the canonical `ct/originChain` response (spec
 * §5.2). The extension host's session receives every event the replay
 * sends (its debug adapter tracker) and merges the update into its
 * `OriginChainVM`; the panels mirror that session, so no event is
 * forwarded to a webview (Shared-DOM-Front-Ends D2/D5).
 *
 * The spec starts a CodeTracer debug session, asks for a chain, and
 * observes the event reaching the host through the extension's
 * `registerPanelOverride` seam, which is handed each event the replay
 * sends. In environments without a live recorder + db-backend the probe
 * fails explicitly with a precise reason string — the same discipline the
 * M3 / M5 specs use.
 *
 * Spec: codetracer-specs/Planned-Features/Value-Origin-Tracking.milestones.org M6.
 */
import { browser, expect } from '@wdio/globals'
import { DebugSession, ExtensionState } from '../../page-objects'
import { captureFullDiagnostics } from '../../helpers/diagnostics'
import { crossProcessTracePath } from '../../helpers/value-origin-fixtures'

const ext = new ExtensionState()
const debug = new DebugSession()
const UPDATED_ORIGIN_CHAIN_EVENT = 'ct/updated-origin-chain'

describe('Value Origin Tracking M6 — ct/updated-origin-chain forwarding', () => {
  afterEach(async function () {
    if (this.currentTest?.state === 'failed') {
      await captureFullDiagnostics(
        `value-origin-updated-${this.currentTest.title.replace(/\s+/g, '-').substring(0, 40)}`
      )
    }
  })

  before(async () => {
    await ext.ensureActivated()
    await ext.waitForCommands(15000)
  })

  after(async () => {
    await debug.stop()
  })

  it('end-to-end: forwards a real DAP ct/updated-origin-chain event when a codetracer-debug session is active', async function () {
    const traceFolder = crossProcessTracePath('frontend.ct')
    const started = await debug.start(traceFolder)
    if (!started) {
      throw new Error(`codetracer-debug session must start for ${traceFolder}`)
    }

    // Probe: is a CodeTracer debug session live?
    const sessionState = await browser.executeWorkbench(async (vscode) => {
      const session = vscode.debug.activeDebugSession
      return session?.type === 'codetracer-debug'
        ? { active: true, name: session.name }
        : { active: false, name: '' }
    })

    if (!(sessionState as any).active) {
      throw new Error(`codetracer-debug session was not active after starting ${traceFolder}`)
    }

    // With a session active, register a probe via the extension's test
    // seam, then invoke a `ct/originChain` customRequest. The db-backend
    // is expected to fire one `ct/updated-origin-chain` event back, which
    // reaches the host's session and our override.
    const result = await browser.executeWorkbench(async (vscode) => {
      const extension = vscode.extensions.getExtension('metacraft-labs.ct-vscode')
      const exports = extension?.exports as any
      if (!exports || typeof exports.registerPanelOverride !== 'function') {
        return { error: 'registerPanelOverride export missing', messages: [] as any[] }
      }
      const messages: any[] = []
      const fakePanel = {
        webview: {
          postMessage(message: any) {
            messages.push(message)
            return Promise.resolve(true)
          },
        },
      }
      const dispose = exports.registerPanelOverride('m6-real-dap-panel', fakePanel)
      try {
        const session = vscode.debug.activeDebugSession!
        await session.customRequest('ct/originChain', {
          variableName: 'total',
          maxHops: 16,
        })
        // Give the adapter ~3s to emit the lazy continuation. The actual
        // event timing is implementation-dependent; this is a generous
        // upper bound for CI.
        await new Promise((r) => setTimeout(r, 3000))
      } finally {
        dispose()
      }
      return { error: null as string | null, messages }
    })

    expect((result as any).error).toBeNull()
    const messages = (result as any).messages as any[]
    const update = messages.find(
      (m) => m?.command === UPDATED_ORIGIN_CHAIN_EVENT
    )
    expect(update).toBeDefined()
  })
})
