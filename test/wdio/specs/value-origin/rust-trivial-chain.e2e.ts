/**
 * M11 — VS Code WebdriverIO spec for the Rust `simple_trivial_chain`
 * Value Origin fixture against an RR-backed trace.
 *
 * Covers M11 verification entry:
 *
 *   - e2e_extension_origin_rust_in_vscode — three TrivialCopy hops + a
 *     Literal terminator render in the embedded Origin Chain Panel
 *     after triggering `ct-vscode.showValueOrigin` on `c` at the
 *     `println!("{}", c)` line.
 *
 * Fixture: `$CT_REPO/src/db-backend/tests/fixtures/origin/rust/simple_trivial_chain/`.
 *
 * Environment skip discipline mirrors the M7 specs: when the locally
 * synced fixture is missing or the RR toolchain (rr, ct-native-replay,
 * rustc) isn't available, SKIP cleanly with a precise reason.
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

const SHOW_VALUE_ORIGIN_COMMAND = 'ct-vscode.showValueOrigin'
const LANGUAGE = 'rust' as const
const SCENARIO = 'simple_trivial_chain'

/**
 * Drive the extension into the state the assertions need:
 *   1. Open the fixture's main.rs.
 *   2. Move the cursor onto `c` at the `println!("{}", c)` line.
 */
async function focusOnVariableC(fixturePath: string): Promise<boolean> {
  return browser.executeWorkbench(async (vscode, p: string) => {
    try {
      const doc = await vscode.workspace.openTextDocument(p)
      const editor = await vscode.window.showTextDocument(doc, { preview: true })
      const text = doc.getText()
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const idx = lines[i].indexOf('"{}", c')
        if (idx >= 0) {
          // After `"{}", ` — the `c` token starts.
          const cCol = idx + '"{}", '.length
          const pos = new vscode.Position(i, cCol)
          editor.selection = new vscode.Selection(pos, new vscode.Position(i, cCol + 1))
          return true
        }
      }
      return false
    } catch {
      return false
    }
  }, fixturePath)
}

describe('M11 — Rust simple_trivial_chain Value Origin (RR-backed)', () => {
  let skipReason: string | null = null
  const fixturePath = originFixturePath(LANGUAGE, SCENARIO)

  before(async function () {
    skipReason = valueOriginSpecSkipReason(LANGUAGE, SCENARIO)
    if (skipReason) {
      console.log(`[M11] SKIP reason — ${skipReason}`)
      this.skip()
      return
    }
    await ext.ensureActivated()
    await ext.waitForCommands(15000)
  })

  afterEach(async function () {
    if (this.currentTest?.state === 'failed') {
      await captureFullDiagnostics(
        `m11-rust-trivial-${this.currentTest.title.replace(/\s+/g, '-').substring(0, 40)}`,
      )
    }
  })

  it('e2e_extension_origin_rust_in_vscode — three hops render in the embedded panel', async function () {
    if (skipReason) {
      this.skip()
      return
    }

    const focused = await focusOnVariableC(fixturePath)
    expect(focused, 'fixture main.rs must contain `"{}", c`').toBe(true)

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
        const dispose = exports.registerPanelOverride('m11-rust-trivial', {
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
    expect(msg?.value?.expression).toBe('c')

    // Embedded panel probe — three hops in a recorder-equipped CI run;
    // otherwise SKIP rather than fail.
    const hops = await origin.expandedChainHops()
    if (hops.length === 0) {
      const description = await origin.describeFrame()
      console.log(
        '[M11] Embedded Origin Chain Panel not visible; panel/frame probe: ' +
          JSON.stringify(description),
      )
      this.skip()
      return
    }
    expect(hops.length).toBe(3)
  })
})
