/**
 * Smoke tests for the CodeTracer VS Code extension.
 *
 * Verifies that VS Code launches, the extension activates, and essential
 * commands are registered. These tests run first and fast — if they fail,
 * the heavier trace-loading tests are unlikely to succeed.
 */
import { browser, expect } from '@wdio/globals'
import { ExtensionState } from '../page-objects'
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
})
