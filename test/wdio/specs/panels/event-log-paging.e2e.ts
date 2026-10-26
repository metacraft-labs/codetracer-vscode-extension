/**
 * The Event Log panel pages past its first window.
 *
 * Regression suite for metacraft-labs/codetracer-vscode-extension#40: the
 * VS Code Event Log showed "Rows 1 to 34 of 116" and scrolling never fetched
 * the rest. The panel's ViewModel ran in the webview and its window requests
 * did not come back to it. The panel now mirrors the session the extension
 * host owns; its scroll window is relayed to the host, which pages the log
 * through `ct/update-table` as the desktop does.
 *
 * Checked in VS Code itself, on a real recording with 201 events (see
 * `helpers/panel-paging.ts`), with nothing mocked: scrolling the table to its
 * end renders events past the first window, the footer's "to" grows to the
 * log's total, and the last row is the log's last event.
 */
import { browser, expect } from '@wdio/globals'
import { DebugSession, ExtensionState } from '../../page-objects'
import { captureFullDiagnostics, screenshot, writeDiag } from '../../helpers/diagnostics'
import { resolveTracePath, traceExists } from '../../helpers/trace-utils'
import {
  EventLogState, PANEL_PAGING_LAST_LINE, PANEL_PAGING_TRACE, eventLogState, openMountedPanel,
  scrollPanelToEnd,
} from '../../helpers/panel-paging'

const session = new DebugSession()
const ext = new ExtensionState()

describe('Event Log panel: paging past the first window (#40)', () => {
  let traceDir: string

  before(function () {
    traceDir = resolveTracePath(PANEL_PAGING_TRACE)
    if (!traceExists(PANEL_PAGING_TRACE)) {
      console.warn(`SKIPPING Event Log paging: trace not found at ${traceDir}; ` +
        `run scripts/record-test-traces.sh ${PANEL_PAGING_TRACE}`)
      this.skip()
    }
  })

  afterEach(async function () {
    const name = this.currentTest?.title?.replace(/[^a-zA-Z0-9_-]+/g, '-').substring(0, 50) ?? 'unknown'
    if (this.currentTest?.state === 'failed') {
      await captureFullDiagnostics(`event-log-paging-FAIL-${name}`)
    }
    await screenshot(`event-log-paging-${name}`)
  })

  let first: EventLogState | undefined

  it('starts a debug session and shows the first window of events', async () => {
    await ext.ensureActivated()
    expect(await session.start(traceDir)).toBe(true)
    await session.waitForBackendReady()
    await openMountedPanel('eventLog', 'ct-vscode.openEventLog', 'Event Log')
    await browser.waitUntil(async () => {
      first = await eventLogState()
      return first.positions.length > 0 && first.total > 0
    }, { timeout: 30_000, interval: 500, timeoutMsg: 'the Event Log panel showed no events' })
    // More events than the first window shows, or there is nothing to page.
    expect(first!.endRow).toBeLessThan(first!.total)
    expect(Math.max(...first!.positions)).toBeLessThan(first!.total - 1)
    console.log(`[eventLog] first window: positions ${Math.min(...first!.positions)}..` +
      `${Math.max(...first!.positions)}, footer "${first!.footerClass}" ` +
      `(to ${first!.endRow} of ${first!.total})`)
  })

  it('renders the events past the first window when scrolled to its end', async () => {
    const firstMax = Math.max(...first!.positions)
    const scrolledTo = await scrollPanelToEnd('eventLog', '.eventLog-scroll-body')
    expect(scrolledTo).toBeGreaterThan(0)

    let after: EventLogState | undefined
    await browser.waitUntil(async () => {
      after = await eventLogState()
      return after.positions.includes(after.total - 1) && after.endRow === after.total
    }, {
      timeout: 30_000, interval: 500,
      timeoutMsg: `scrolling the Event Log did not bring its last event; first window ended at ` +
        `${firstMax}, now ${JSON.stringify(after ?? first)}`,
    })
    writeDiag('event-log-paging.json', { first, after, scrolledTo })
    console.log(`[eventLog] scrolled to ${scrolledTo}px: positions ${Math.min(...after!.positions)}..` +
      `${Math.max(...after!.positions)}, footer "${after!.footerClass}" ` +
      `(to ${after!.endRow} of ${after!.total}); last row "${after!.lastText}"`)

    // The window moved past the first one, the footer's "to" grew, and the
    // last row is the program's last printed line.
    expect(Math.max(...after!.positions)).toBeGreaterThan(firstMax)
    expect(after!.endRow).toBeGreaterThan(first!.endRow)
    expect(after!.lastText).toContain(PANEL_PAGING_LAST_LINE)
  })

  after(async () => {
    try { await session.stop() } catch { /* ignore */ }
  })
})
