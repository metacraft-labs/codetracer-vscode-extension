/**
 * "Add to Scratchpad" from the editor: a local is added, an expression is
 * evaluated, and an expression the replay cannot evaluate is an error value.
 *
 * Regression suite for metacraft-labs/codetracer-vscode-extension#43 and the
 * 2026-10-26 decision recorded in codetracer-pm
 * `spec/GUI/Core-Panes/Scratchpad-Pane.md` § Adding Values ("An editor
 * selection (VS Code)"): a selection that is not a local or a watch is
 * evaluated at the current stop through the watch path (`ct/load-locals`
 * carrying it as a watch expression), and a failed evaluation is shown as an
 * error value instead of being dropped.
 *
 * Checked in VS Code itself, on a real recording, with nothing mocked. The
 * recording is `python-scratchpad` (`test/wdio/programs/python_scratchpad/`),
 * recorded by `scripts/record-test-traces.sh python-scratchpad`. The debugger
 * is moved into `check` (a double-click on its Call Trace row), where `board`
 * is a recorded local holding a list of rows. The selections are made in an
 * untitled document, because the command reads only the active editor's
 * selection, and the program's source has no `board.no_such_field` to select.
 */
import { browser, expect } from '@wdio/globals'
import { DebugSession, ExtensionState } from '../../page-objects'
import { inPanel } from '../../page-objects/panels'
import { captureFullDiagnostics, screenshot, writeDiag } from '../../helpers/diagnostics'
import { resolveTracePath, traceExists } from '../../helpers/trace-utils'
import { CallRow, calltraceRows, openMountedPanel, revealPanel, topFrame } from '../../helpers/panel-paging'

const TRACE = 'python-scratchpad'
const session = new DebugSession()
const ext = new ExtensionState()

interface ScratchpadRow {
  name: string
  value: string
  isError: boolean
}

/** The top-level rows the Scratchpad panel shows. */
async function scratchpadRows(): Promise<ScratchpadRow[]> {
  return inPanel('scratchpad', async () => browser.execute(() => {
    return Array.from(document.querySelectorAll('.scratchpad-value-view'))
      .filter((el) => el.querySelector('#close-element') !== null)
      .map((el) => ({
        name: (el.querySelector('.value-name')?.textContent ?? '').replace(/:\s*$/, '').trim(),
        value: (el.querySelector('.value-view')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        isError: el.classList.contains('scratchpad-value-error'),
      }))
  }))
}

/**
 * Show the untitled document the selections are made in, select its line
 * `line` (0-based) and run the command. The document is shown first because
 * the command reveals the Scratchpad, which takes the active editor away.
 */
async function addSelectedLine(line: number): Promise<void> {
  await browser.executeWorkbench(async (vscode, l: number) => {
    const doc = vscode.workspace.textDocuments.find((d) => d.isUntitled)
    if (!doc) throw new Error('the untitled document is gone')
    const editor = await vscode.window.showTextDocument(doc, { preview: false })
    const text = editor.document.lineAt(l).range
    editor.selection = new vscode.Selection(text.start, text.end)
    await vscode.commands.executeCommand('ct-vscode.addToScratchpad')
  }, line)
}

async function waitForRow(name: string): Promise<ScratchpadRow> {
  let found: ScratchpadRow | undefined
  await browser.waitUntil(async () => {
    found = (await scratchpadRows()).find((r) => r.name === name)
    return found !== undefined
  }, { timeout: 30_000, interval: 500, timeoutMsg: `the Scratchpad showed no row for '${name}'` })
  return found!
}

describe('Add to Scratchpad from the editor (#43)', () => {
  let traceDir: string

  before(function () {
    traceDir = resolveTracePath(TRACE)
    if (!traceExists(TRACE)) {
      console.warn(`SKIPPING Add to Scratchpad: trace not found at ${traceDir}; ` +
        `run scripts/record-test-traces.sh python-scratchpad`)
      this.skip()
    }
  })

  afterEach(async function () {
    const name = this.currentTest?.title?.replace(/[^a-zA-Z0-9_-]+/g, '-').substring(0, 50) ?? 'unknown'
    if (this.currentTest?.state === 'failed') {
      await captureFullDiagnostics(`scratchpad-add-FAIL-${name}`)
    }
    await screenshot(`scratchpad-add-${name}`)
  })

  it('stops in check, where board is a local', async () => {
    await ext.ensureActivated()
    expect(await session.start(traceDir)).toBe(true)
    await session.waitForBackendReady()
    await openMountedPanel('calltrace', 'ct-vscode.openCalltrace', 'Calltrace')
    let target: CallRow | undefined
    await browser.waitUntil(async () => {
      target = (await calltraceRows()).find((r) => r.name.endsWith('check'))
      return target !== undefined
    }, { timeout: 30_000, interval: 500, timeoutMsg: 'the Call Trace showed no check call' })
    // The session can bring its source editor to the front after the panel
    // was revealed, and a double-click then lands in the editor. So the panel
    // is revealed right before each double-click, and the double-click is
    // repeated until the debugger has moved.
    await browser.waitUntil(async () => {
      await revealPanel('ct-vscode.openCalltrace', 'Calltrace')
      await inPanel('calltrace', async () => {
        const el = await browser.$(`#local-call-text-${target!.index}`)
        await el.scrollIntoView({ block: 'center' })
        await el.doubleClick()
      })
      try {
        await browser.waitUntil(async () => (await topFrame()).name.endsWith('check'),
          { timeout: 5_000, interval: 500 })
        return true
      } catch {
        return false
      }
    }, { timeout: 60_000, interval: 500, timeoutMsg: 'the debugger did not move into check' })
    await openMountedPanel('scratchpad', 'ct-vscode.openScratchpad', 'Scratchpad')
    // The document the selections are made in.
    await browser.executeWorkbench(async (vscode) => {
      const doc = await vscode.workspace.openTextDocument({
        content: 'board\nboard[0]\nboard.no_such_field\n',
      })
      await vscode.window.showTextDocument(doc, { preview: false })
    })
  })

  it('adds a local as the State pane shows it', async () => {
    await addSelectedLine(0)
    const row = await waitForRow('board')
    expect(row.isError).toBe(false)
    expect(row.value.length).toBeGreaterThan(0)
  })

  it('evaluates an expression that is not a local, through the watch path', async () => {
    await addSelectedLine(1)
    const row = await waitForRow('board[0]')
    writeDiag('scratchpad-add-evaluated.json', row)
    expect(row.isError).toBe(false)
    expect(row.value.length).toBeGreaterThan(0)
    // The State pane's watch list is not changed by the add.
    await revealPanel('ct-vscode.openState', 'State')
    const watched = await inPanel('state', async () => browser.execute(() =>
      document.body.innerText.includes('board[0]')))
    expect(watched).toBe(false)
    await revealPanel('ct-vscode.openScratchpad', 'Scratchpad')
  })

  it('shows an error value for an expression the replay cannot evaluate', async () => {
    await addSelectedLine(2)
    const row = await waitForRow('board.no_such_field')
    writeDiag('scratchpad-add-error.json', row)
    expect(row.isError).toBe(true)
    expect(row.value.length).toBeGreaterThan(0)
    console.log(`[scratchpad] error value: ${row.value}`)
  })

  after(async () => {
    try { await session.stop() } catch { /* ignore */ }
  })
})
