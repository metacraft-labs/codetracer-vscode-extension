/**
 * The Call Trace panel loads rows as it scrolls, and a row moves the debugger.
 *
 * Regression suite for metacraft-labs/codetracer-vscode-extension#37: the
 * VS Code Call Trace showed only its first rows, scrolling loaded nothing
 * more, and activating a row did not move the debugger. The panel's
 * ViewModel ran in the webview over a backend that answered nothing. The
 * panel now mirrors the session the extension host owns; its scroll window
 * and its row activation are relayed to the host, which asks the replay.
 *
 * Checked in VS Code itself, on a real recording (see
 * `helpers/panel-paging.ts`), with nothing mocked:
 *  - scrolling the panel to its end renders rows past the first window's
 *    last index — rows only a window request the replay answered can bring;
 *  - a real double-click (Click-Navigation § 3.3: double-click activates) on
 *    one of those rows moves the debugger into the call it names — the top
 *    stack frame the replay reports becomes that function — and marks it.
 */
import { browser, expect } from '@wdio/globals'
import { DebugSession, ExtensionState } from '../../page-objects'
import { inPanel } from '../../page-objects/panels'
import { captureFullDiagnostics, screenshot, writeDiag } from '../../helpers/diagnostics'
import { resolveTracePath, traceExists } from '../../helpers/trace-utils'
import {
  CallRow, PANEL_PAGING_TRACE, calltraceRows, openMountedPanel, scrollPanelToEnd, topFrame,
} from '../../helpers/panel-paging'

const session = new DebugSession()
const ext = new ExtensionState()

describe('Call Trace panel: scroll loading and row navigation (#37)', () => {
  let traceDir: string

  before(function () {
    traceDir = resolveTracePath(PANEL_PAGING_TRACE)
    if (!traceExists(PANEL_PAGING_TRACE)) {
      console.warn(`SKIPPING Call Trace panel: trace not found at ${traceDir}; ` +
        `run scripts/record-test-traces.sh ${PANEL_PAGING_TRACE}`)
      this.skip()
    }
  })

  afterEach(async function () {
    const name = this.currentTest?.title?.replace(/[^a-zA-Z0-9_-]+/g, '-').substring(0, 50) ?? 'unknown'
    if (this.currentTest?.state === 'failed') {
      await captureFullDiagnostics(`calltrace-panel-FAIL-${name}`)
    }
    await screenshot(`calltrace-panel-${name}`)
  })

  let first: CallRow[] = []
  let loaded: CallRow[] = []
  let firstMax = -1

  it('starts a debug session and shows the first window of calls', async () => {
    await ext.ensureActivated()
    expect(await session.start(traceDir)).toBe(true)
    await session.waitForBackendReady()
    await openMountedPanel('calltrace', 'ct-vscode.openCalltrace', 'Calltrace')
    await browser.waitUntil(async () => {
      first = await calltraceRows()
      return first.length > 0
    }, { timeout: 30_000, interval: 500, timeoutMsg: 'the Call Trace panel showed no rows' })
    firstMax = Math.max(...first.map((r) => r.index))
    console.log(`[calltrace] first window: ${first.length} rows, indices ` +
      `${Math.min(...first.map((r) => r.index))}..${firstMax}`)
  })

  it('loads rows past the first window when scrolled to its end', async () => {
    const scrolledTo = await scrollPanelToEnd('calltrace', '.local-calltrace-view')
    expect(scrolledTo).toBeGreaterThan(0)
    await browser.waitUntil(async () => {
      loaded = await calltraceRows()
      return loaded.some((r) => r.index > firstMax)
    }, {
      timeout: 30_000, interval: 500,
      timeoutMsg: `scrolling the Call Trace brought no row past index ${firstMax}, the first window's last`,
    })
    writeDiag('calltrace-panel-scroll.json', { first, loaded, firstMax, scrolledTo })
    console.log(`[calltrace] scrolled to ${scrolledTo}px: ${loaded.length} rows, indices ` +
      `${Math.min(...loaded.map((r) => r.index))}..${Math.max(...loaded.map((r) => r.index))}`)
  })

  it('moves the debugger into the call a double-clicked row names, and marks the row', async () => {
    // A row the scroll loaded, naming a call of `square`: it calls nothing,
    // so the frame it lands in is unambiguous.
    const target = loaded.find((r) => r.index > firstMax && r.name.endsWith('square'))
    expect(target).toBeDefined()

    const before = await topFrame()
    await inPanel('calltrace', async () => {
      const el = await browser.$(`#local-call-text-${target!.index}`)
      await el.scrollIntoView({ block: 'center' })
      await el.doubleClick()
    })

    let now = before
    await browser.waitUntil(async () => {
      now = await topFrame()
      return now.name.endsWith('square') && now.name !== before.name
    }, {
      timeout: 30_000, interval: 500,
      timeoutMsg: `a double-click on Call Trace row ${target!.index} (${target!.name}) did not ` +
        `move the debugger into it; the top frame stayed ${JSON.stringify(before)}`,
    })
    expect(now.file.endsWith('main.py')).toBe(true)

    let rows: CallRow[] = []
    await browser.waitUntil(async () => {
      rows = await calltraceRows()
      return rows.some((r) => r.index === target!.index && r.selected)
    }, { timeout: 15_000, interval: 500, timeoutMsg: `row ${target!.index} was not marked after the jump` })
    writeDiag('calltrace-panel-jump.json', { target, before, now })
    console.log(`[calltrace] double-click on row ${target!.index} (${target!.name}): ` +
      `top frame ${before.name}:${before.line} -> ${now.name}:${now.line}`)
  })

  after(async () => {
    try { await session.stop() } catch { /* ignore */ }
  })
})
