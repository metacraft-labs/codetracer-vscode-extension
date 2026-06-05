/**
 * Value Origin Tracking — M6 verification spec #3.
 *
 * `test_extension_forwards_updated_origin_chain_event_into_embedded_webview`
 *
 * The db-backend emits `ct/updated-origin-chain` as a lazy-continuation
 * DAP event alongside the canonical `ct/originChain` response (spec
 * §5.2). On the TypeScript side the extension MUST forward every such
 * event payload into the embedded CodeTracer webview via
 * `panel.webview.postMessage(...)` so the embedded `OriginChainVM` can
 * merge the update without re-issuing the request.
 *
 * Without a real `codetracer-debug` session we cannot inject a real DAP
 * custom event — `vscode.debug.onDidReceiveDebugSessionCustomEvent` is a
 * read-only stream populated by the debug adapter. The spec gates that
 * end-to-end path behind a running adapter. What we *can* verify in any
 * environment is the contract the subscription delegates to:
 * `forwardToEmbeddedPanels(...)` posts a `ct/updated-origin-chain`
 * envelope to every embedded panel. The DAP-event subscription in
 * `src/extension.ts` is a one-line bridge that invokes exactly this
 * function with exactly this envelope (see the
 * `onDidReceiveDebugSessionCustomEvent` handler), so verifying the
 * function directly is the tightest unit-level proof the wiring is
 * correct.
 *
 * The second test in this file probes for an active CodeTracer debug
 * session and, if one is present, exercises the end-to-end DAP path by
 * triggering a `ct/originChain` request and waiting for the matching
 * `ct/updated-origin-chain` event. In environments without a live
 * recorder + db-backend the probe SKIPs cleanly with a precise reason
 * string — the same discipline the M3 / M5 specs use.
 *
 * Spec: codetracer-specs/Planned-Features/Value-Origin-Tracking.milestones.org M6.
 */
import { browser, expect } from '@wdio/globals'
import { ExtensionState } from '../../page-objects'
import { captureFullDiagnostics } from '../../helpers/diagnostics'

const ext = new ExtensionState()
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

  it('forwards the ct/updated-origin-chain payload to every embedded panel', async () => {
    // Drive the production `forwardToEmbeddedPanels(...)` helper with the
    // exact envelope the DAP-event subscription would build, and verify
    // the override panel receives it. This is the same code path the
    // `onDidReceiveDebugSessionCustomEvent` handler triggers — only the
    // upstream signal differs (here: synchronous call; there: VS Code
    // debug event stream).
    const captured = await browser.executeWorkbench(
      async (vscode, eventName: string) => {
        const extension = vscode.extensions.getExtension('metacraft-labs.ct-vscode')
        if (!extension) {
          return { error: 'extension not found', messages: [] as any[] }
        }
        if (!extension.isActive) {
          await extension.activate()
        }
        const exports = extension.exports as any
        if (
          !exports ||
          typeof exports.registerPanelOverride !== 'function' ||
          typeof exports.forwardToEmbeddedPanels !== 'function'
        ) {
          return { error: 'M6 test seam exports missing', messages: [] as any[] }
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
        const dispose = exports.registerPanelOverride('m6-dap-event-panel', fakePanel)
        try {
          // Synthetic event body modelled on §5.2 — the wire shape is
          // opaque to the extension; the embedded panel parses it. We
          // only assert the envelope and that the body round-trips
          // verbatim.
          const body = {
            requestId: 'm6-test-req-1',
            queryVariable: 'total',
            hops: [],
            terminator: { kind: 'Literal', expression: '10' },
          }
          exports.forwardToEmbeddedPanels({
            command: eventName,
            value: body,
          })
        } finally {
          dispose()
        }

        return { error: null as string | null, messages }
      },
      UPDATED_ORIGIN_CHAIN_EVENT
    )

    expect((captured as any).error).toBeNull()
    const messages = (captured as any).messages as any[]
    expect(messages.length).toBeGreaterThanOrEqual(1)
    const update = messages.find(
      (m) => m?.command === UPDATED_ORIGIN_CHAIN_EVENT
    )
    expect(update).toBeDefined()
    expect(update?.value?.queryVariable).toBe('total')
    expect(update?.value?.terminator?.kind).toBe('Literal')
  })

  it('end-to-end: forwards a real DAP ct/updated-origin-chain event when a codetracer-debug session is active', async function () {
    // Probe: is a CodeTracer debug session live?
    const sessionState = await browser.executeWorkbench(async (vscode) => {
      const session = vscode.debug.activeDebugSession
      return session?.type === 'codetracer-debug'
        ? { active: true, name: session.name }
        : { active: false, name: '' }
    })

    if (!(sessionState as any).active) {
      // The CI environment with a live codetracer binary + recorder will
      // exercise this path; here we SKIP honestly so the spec stays
      // green in dev shells without the toolchain.
      this.skip()
      return
    }

    // With a session active, register a probe via the extension's test
    // seam, then invoke a `ct/originChain` customRequest. The db-backend
    // is expected to fire one `ct/updated-origin-chain` event back; the
    // subscription in `src/extension.ts` forwards it through
    // `forwardToEmbeddedPanels(...)`, which our override observes.
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
          expression: 'total',
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
