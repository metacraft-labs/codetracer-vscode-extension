/**
 * Smoke tests for the CodeTracer VS Code extension.
 *
 * Verifies that VS Code launches, the extension activates, and essential
 * commands are registered. These tests run first and fast — if they fail,
 * the heavier trace-loading tests are unlikely to succeed.
 */
import { browser, expect } from '@wdio/globals'
import { ExtensionState, panelDocuments } from '../page-objects'
import { captureFullDiagnostics } from '../helpers/diagnostics'

const ext = new ExtensionState()

describe('CodeTracer Extension - Smoke Test', () => {
  afterEach(async function () {
    if (this.currentTest?.state === 'failed') {
      await captureFullDiagnostics(`smoke-${this.currentTest.title.replace(/\s+/g, '-').substring(0, 40)}`)
    }
  })

  it('can launch VS Code and read the title bar', async () => {
    const workbench = await (browser as any).getWorkbench()
    const titleBar = await workbench.getTitleBar()
    const title = await titleBar.getTitle()
    console.log('VS Code Title:', title)
    expect(title).toBeDefined()
    expect(String(title).length).toBeGreaterThan(0)
  })

  it('has CodeTracer extension installed', async () => {
    const info = await ext.info()
    console.log('Extension info:', JSON.stringify(info, null, 2))
    expect(info).not.toBeNull()
    expect(info!.id).toBe('metacraft-labs.ct-vscode')
  })

  it('can activate the extension', async () => {
    await ext.ensureActivated()
    const active = await ext.isActive()
    console.log('Extension active:', active)
    expect(active).toBe(true)
  })

  it('registers essential ct-vscode commands', async () => {
    const commands = await ext.waitForCommands(15000)
    console.log('CodeTracer commands found:', commands)

    const expectedCommands = [
      'ct-vscode.toggleCT',
      'ct-vscode.loadRecentTraces',
      'ct-vscode.loadRecentTransactions',
      'ct-vscode.addTracepoint',
    ]
    for (const cmd of expectedCommands) {
      expect(commands).toContain(cmd)
    }
  })

  it('has expected resource files in the extension directory', async () => {
    const status = await ext.resourceFileStatus()
    console.log('Resource files:', JSON.stringify(status, null, 2))

    // The compiled extension.js must exist
    expect(status['out/extension.js']?.exists).toBe(true)
  })

  // THE REAL PANEL BUNDLE (Shared-DOM-Front-Ends D5). A TypeScript-only
  // build has no `media/vscode_panel.js`; a `just build` from the codetracer
  // checkout does, and CI's integration job sets CT_EXPECT_PANEL_BUNDLE=1 so
  // its absence fails instead of skipping.
  it('opens a panel whose webview loads vscode_panel.js alone, and mounts it', async function () {
    const status = await ext.resourceFileStatus()
    const built = Boolean(status['media/vscode_panel.js']?.exists && status['media/vscode_host.js']?.exists)
    if (!built) {
      if (process.env.CT_EXPECT_PANEL_BUNDLE === '1') {
        throw new Error('media/vscode_panel.js / media/vscode_host.js are missing: run `just build` against the codetracer checkout')
      }
      this.skip()
    }
    await ext.ensureActivated()
    await browser.executeWorkbench(async (vscode) => {
      await vscode.commands.executeCommand('ct-vscode.openState')
    })
    let docs: Awaited<ReturnType<typeof panelDocuments>> = []
    await browser.waitUntil(async () => {
      docs = await panelDocuments()
      return docs.some((d) => d.panel === 'state' && d.mounted === 'state')
    }, { timeout: 30000, interval: 500, timeoutMsg: 'the State panel webview did not mount vscode_panel.js' })
    console.log('Panel documents:', JSON.stringify(docs))
    const state = docs.find((d) => d.panel === 'state')!
    // One script, the panel's: no renderer bundle, no webpack bundle, no
    // Monaco, no jQuery.
    expect(state.scripts).toEqual(['vscode_panel.js'])
    const open = await browser.executeWorkbench(async (vscode) => {
      const extension = vscode.extensions.getExtension('metacraft-labs.ct-vscode')
      return (extension?.exports as any)?.openPanels?.() ?? []
    })
    expect(open).toContain('state')

    // What of the arrangement the extension can read back (D9 / SDF-AREQ9):
    // the column VS Code put the panel in, and the editor layout through
    // VS Code's own `vscode.getEditorLayout` command. Logged as the
    // measurement. The extension asks for column Two; with no editor open
    // VS Code puts the panel in the first group (measured 2026-10-22), so
    // the assertion is that the column is readable, not which it is.
    const arrangement = await browser.executeWorkbench(async (vscode) => {
      const extension = vscode.extensions.getExtension('metacraft-labs.ct-vscode')
      const columns = (extension?.exports as any)?.panelColumns?.() ?? {}
      const layout = await vscode.commands.executeCommand('vscode.getEditorLayout')
      return { columns, layout }
    })
    console.log('Panel arrangement:', JSON.stringify(arrangement))
    expect((arrangement as any).columns.state).toBeGreaterThanOrEqual(1)
    expect((arrangement as any).layout).toBeDefined()
  })
})
