/**
 * Value Origin Tracking — M6 verification spec #2.
 *
 * `test_extension_forwards_show_value_origin_into_embedded_webview`
 *
 * Invoking `ct-vscode.showValueOrigin` must post a `showValueOrigin`
 * message into the embedded CodeTracer webview via
 * `panel.webview.postMessage(...)`. Per spec §8.2 the extension does NOT
 * render a TreeView, a standalone webview panel, or any other origin
 * UI — it is a thin command/menu bridge.
 *
 * The test installs a fake panel via the extension's `registerPanelOverride`
 * test seam (see `CodeTracerExtensionExports` in `src/extension.ts`), then
 * executes the command and asserts the message landed on the override.
 *
 * Spec: codetracer-specs/Planned-Features/Value-Origin-Tracking.milestones.org M6.
 */
import { browser, expect } from '@wdio/globals'
import { ExtensionState } from '../../page-objects'
import { captureFullDiagnostics } from '../../helpers/diagnostics'

const ext = new ExtensionState()
const SHOW_VALUE_ORIGIN_COMMAND = 'ct-vscode.showValueOrigin'

describe('Value Origin Tracking M6 — showValueOrigin forwarding', () => {
  afterEach(async function () {
    if (this.currentTest?.state === 'failed') {
      await captureFullDiagnostics(
        `value-origin-forwarding-${this.currentTest.title.replace(/\s+/g, '-').substring(0, 40)}`
      )
    }
  })

  before(async () => {
    await ext.ensureActivated()
    await ext.waitForCommands(15000)
  })

  it('posts a showValueOrigin message into the embedded webview when invoked', async () => {
    // Stage: install a fake panel via the extension's test seam, run the
    // command, then read the captured messages back from the workbench.
    const captured = await browser.executeWorkbench(
      async (vscode, command: string) => {
        const extension = vscode.extensions.getExtension('metacraft-labs.ct-vscode')
        if (!extension) {
          return { error: 'extension not found' }
        }
        if (!extension.isActive) {
          await extension.activate()
        }
        const exports = extension.exports as any
        if (!exports || typeof exports.registerPanelOverride !== 'function') {
          // Extension is loaded but the test seam is missing — this is a
          // hard failure: the suite cannot verify forwarding without it.
          return { error: 'registerPanelOverride export missing' }
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
        const dispose = exports.registerPanelOverride('m6-test-panel', fakePanel)
        try {
          // Execute the command exactly as the keybinding or the menu
          // entry would. No active editor / selection is required because
          // the handler tolerates an empty expression payload — the
          // embedded panel renders a placeholder in that case.
          await vscode.commands.executeCommand(command)
        } finally {
          dispose()
        }

        return { messages, error: null as string | null }
      },
      SHOW_VALUE_ORIGIN_COMMAND
    )

    expect(captured).toBeDefined()
    expect((captured as any).error).toBeNull()
    const messages = (captured as any).messages as any[]
    expect(messages.length).toBeGreaterThanOrEqual(1)
    const showOrigin = messages.find((m) => m?.command === 'showValueOrigin')
    expect(showOrigin).toBeDefined()
    // The message must carry a `value` envelope so the embedded
    // `StateVM.onShowOrigin` can read the expression + location even if
    // both are empty (no active editor).
    expect(showOrigin?.value).toBeDefined()
    expect(showOrigin?.value).toHaveProperty('expression')
  })

  it('does not contribute any extension-side TreeView for value origin', async () => {
    // Spec §8.2 forbids an extension-side TreeView — all rendering lives
    // inside the embedded CodeTracer panels. Verify by reading the
    // contributions.
    const pkg = await browser.executeWorkbench(async (vscode, extId: string) => {
      const found = vscode.extensions.getExtension(extId)
      return found?.packageJSON ?? null
    }, 'metacraft-labs.ct-vscode')

    const views = (pkg as any)?.contributes?.views ?? {}
    // Walk every view container and assert none mentions value origin.
    for (const containerId of Object.keys(views)) {
      const list = (views[containerId] ?? []) as any[]
      for (const v of list) {
        const id = String(v?.id ?? '').toLowerCase()
        const name = String(v?.name ?? '').toLowerCase()
        expect(id).not.toContain('origin')
        expect(name).not.toContain('origin')
      }
    }
  })
})
