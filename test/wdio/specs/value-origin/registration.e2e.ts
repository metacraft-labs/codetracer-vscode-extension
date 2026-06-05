/**
 * Value Origin Tracking — M6 verification spec #1.
 *
 * `test_extension_registers_show_value_origin_command`
 *
 * Asserts the `ct-vscode.showValueOrigin` command is contributed in
 * `package.json` (the command-palette wiring depends on the contributes
 * block being read by VS Code at activation time) and that the command
 * is actually registered on the live `vscode.commands` registry after
 * the extension finishes activating.
 *
 * The spec also probes the supporting menu/keybinding contributions per
 * the milestone deliverable list — these come from the same
 * `contributes` block, so reading them through the workbench API is the
 * tightest end-to-end verification we can do without invoking the
 * command (which is covered by `command-forwarding.e2e.ts`).
 *
 * Spec: codetracer-specs/Planned-Features/Value-Origin-Tracking.milestones.org M6.
 */
import { browser, expect } from '@wdio/globals'
import { ExtensionState } from '../../page-objects'
import { captureFullDiagnostics } from '../../helpers/diagnostics'

const ext = new ExtensionState()
const SHOW_VALUE_ORIGIN_COMMAND = 'ct-vscode.showValueOrigin'

describe('Value Origin Tracking M6 — command registration', () => {
  afterEach(async function () {
    if (this.currentTest?.state === 'failed') {
      await captureFullDiagnostics(
        `value-origin-registration-${this.currentTest.title.replace(/\s+/g, '-').substring(0, 40)}`
      )
    }
  })

  it('contributes ct-vscode.showValueOrigin in package.json', async () => {
    // `package.json` is the canonical source of contribution metadata for the
    // command palette. Reading it back through the extension's `packageJSON`
    // proves the entry survived the build (we read the on-disk file via the
    // extension's `packageJSON` which VS Code populates from the manifest).
    const pkg = await browser.executeWorkbench(async (vscode, extId: string) => {
      const found = vscode.extensions.getExtension(extId)
      return found?.packageJSON ?? null
    }, 'metacraft-labs.ct-vscode')

    expect(pkg).not.toBeNull()
    const commands = (pkg as any)?.contributes?.commands ?? []
    const entry = (commands as any[]).find(
      (c) => c.command === SHOW_VALUE_ORIGIN_COMMAND
    )
    expect(entry).toBeDefined()
    // The command must declare the human-readable title used by the palette
    // and the CodeTracer category so it groups with the existing
    // CodeTracer commands.
    expect(entry?.title).toBe('Show Value Origin')
    expect(entry?.category).toBe('CodeTracer')
  })

  it('contributes the debug/variables/context and editor/context menus per spec §8.2', async () => {
    const pkg = await browser.executeWorkbench(async (vscode, extId: string) => {
      const found = vscode.extensions.getExtension(extId)
      return found?.packageJSON ?? null
    }, 'metacraft-labs.ct-vscode')

    const menus = (pkg as any)?.contributes?.menus ?? {}
    const debugVarsMenu = (menus['debug/variables/context'] ?? []) as any[]
    const editorMenu = (menus['editor/context'] ?? []) as any[]
    const palette = (menus['commandPalette'] ?? []) as any[]

    expect(debugVarsMenu.some((m) => m.command === SHOW_VALUE_ORIGIN_COMMAND)).toBe(true)
    expect(editorMenu.some((m) => m.command === SHOW_VALUE_ORIGIN_COMMAND)).toBe(true)
    expect(palette.some((m) => m.command === SHOW_VALUE_ORIGIN_COMMAND)).toBe(true)
  })

  it('contributes a default Ctrl+Shift+O / Cmd+Shift+O keybinding', async () => {
    const pkg = await browser.executeWorkbench(async (vscode, extId: string) => {
      const found = vscode.extensions.getExtension(extId)
      return found?.packageJSON ?? null
    }, 'metacraft-labs.ct-vscode')

    const keybindings = ((pkg as any)?.contributes?.keybindings ?? []) as any[]
    const entry = keybindings.find((k) => k.command === SHOW_VALUE_ORIGIN_COMMAND)
    expect(entry).toBeDefined()
    expect(entry?.key).toBe('ctrl+shift+o')
    expect(entry?.mac).toBe('cmd+shift+o')
    // The keybinding is gated on the same context key used by the other
    // CodeTracer commands so it stays inert until a session is active.
    expect(entry?.when).toBe('codetracer:active')
  })

  it('registers ct-vscode.showValueOrigin after activation', async () => {
    await ext.ensureActivated()
    const commands = await ext.waitForCommands(15000)
    // The contributes-side entry is necessary but not sufficient — the
    // command must also be registered on the live `vscode.commands` table
    // (this is what `commandPalette` + `keybindings` actually resolve
    // against at runtime).
    expect(commands).toContain(SHOW_VALUE_ORIGIN_COMMAND)
  })
})
