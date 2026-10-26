/**
 * Shared steps of the panel paging suites (`test/wdio/specs/panels/`).
 *
 * Those suites read the Call Trace and Event Log panels' own DOM — the
 * `vscode_panel.js` bundle rendered in VS Code's webviews — through
 * `inPanel`, and the debugger's position from the real replay server through
 * the debug session's `stackTrace`. Nothing here is mocked.
 *
 * Their recording is `python-panels`: `test/wdio/programs/python_panels/main.py`
 * recorded by `scripts/record-test-traces.sh python-panels`. It is longer than
 * one window of either panel (several hundred calls, 201 printed lines), which
 * the python-sudoku recording is not for the Event Log (21 lines).
 */
import { browser } from '@wdio/globals'
import { inPanel, openPanel, panelDocuments } from '../page-objects/panels'

/** The recording the panel paging suites run on. */
export const PANEL_PAGING_TRACE = 'python-panels'

/** The program's last printed line: the Event Log's last event. */
export const PANEL_PAGING_LAST_LINE = 'total 2646700'

/**
 * Open panel `kind` with `command`, wait until its webview has mounted, and
 * leave it the visible tab of its group.
 *
 * VS Code opens the stopped-at source file when the session starts, and with
 * a single editor group that editor can land in the panel's group and hide
 * the panel. A user looks at the panel before scrolling it, so the panel is
 * revealed again (its command reveals an open panel) once the source editor
 * is open, and the test waits until the panel's tab is the active one.
 */
export async function openMountedPanel(kind: string, command: string, title: string): Promise<void> {
  await openPanel(command)
  await browser.waitUntil(
    async () => (await panelDocuments()).some((d) => d.panel === kind && d.mounted === kind),
    { timeout: 30_000, interval: 500, timeoutMsg: `the ${kind} panel did not mount vscode_panel.js` },
  )
  await browser.waitUntil(
    async () => browser.executeWorkbench(async (vscode) => vscode.window.tabGroups.all.some(
      (g) => g.tabs.some((t) => /\.py$/.test(((t.input as any)?.uri?.fsPath ?? '') as string)))),
    { timeout: 30_000, interval: 500, timeoutMsg: 'the session did not open its source file' },
  )
  await revealPanel(command, title)
}

/** Reveal the open panel titled `title` (its `command`) and wait until its tab is active. */
export async function revealPanel(command: string, title: string): Promise<void> {
  await browser.waitUntil(async () => {
    await openPanel(command)
    return browser.executeWorkbench(async (vscode, t: string) => vscode.window.tabGroups.all.some(
      (g) => g.tabs.some((tab) => tab.label === t && tab.isActive)), title)
  }, { timeout: 30_000, interval: 1000, timeoutMsg: `the ${title} panel did not become the active tab` })
}

/** The top stack frame the debug adapter reports. */
export interface TopFrame {
  name: string
  line: number
  file: string
}

/** The top stack frame of the active debug session, asked of the replay. */
export async function topFrame(): Promise<TopFrame> {
  return browser.executeWorkbench(async (vscode) => {
    const s = vscode.debug.activeDebugSession
    if (!s) return { name: '', line: -1, file: '' }
    const threads = await s.customRequest('threads')
    const threadId = threads?.threads?.[0]?.id ?? 1
    const trace = await s.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 })
    const frame = trace?.stackFrames?.[0]
    return {
      name: String(frame?.name ?? ''),
      line: typeof frame?.line === 'number' ? frame.line : -1,
      file: String(frame?.source?.path ?? ''),
    }
  })
}

/** One Call Trace row the panel shows. */
export interface CallRow {
  /** The row's line index in the whole call trace (`#local-call-text-<index>`). */
  index: number
  /** The function the row names (`data-function`). */
  name: string
  /** Whether the row is marked as the selected one (`.event-selected`). */
  selected: boolean
}

/** The Call Trace rows the panel's DOM holds now. */
export async function calltraceRows(): Promise<CallRow[]> {
  return inPanel('calltrace', async () => browser.execute(() => {
    const rows: Array<{ index: number; name: string; selected: boolean }> = []
    document.querySelectorAll('.call-text[id^="local-call-text-"]').forEach((el) => {
      const index = Number(el.id.slice('local-call-text-'.length))
      const row = el.closest('[data-function]') as HTMLElement | null
      rows.push({
        index,
        name: row?.dataset.function ?? '',
        selected: row?.classList.contains('event-selected') ?? false,
      })
    })
    return rows
  }))
}

/** What the Event Log panel shows: its rows and its footer. */
export interface EventLogState {
  /** `data-position` of every row the table holds (0-based, in the log). */
  positions: number[]
  /** The footer's class, which carries `<start>to<end>`. */
  footerClass: string
  /** "Rows X to <endRow> of <total>". */
  endRow: number
  total: number
  lastText: string
}

/** The Event Log panel's rows and footer now. */
export async function eventLogState(): Promise<EventLogState> {
  return inPanel('eventLog', async () => browser.execute(() => {
    const rows = Array.from(
      document.querySelectorAll('.eventLog-rows tbody tr[data-position]')) as HTMLElement[]
    const footer = document.querySelector('.data-tables-footer') as HTMLElement | null
    const num = (sel: string) => Number(document.querySelector(sel)?.textContent?.trim() ?? 'NaN')
    const byPosition = rows.slice().sort(
      (a, b) => Number(a.dataset.position) - Number(b.dataset.position))
    return {
      positions: rows.map((r) => Number(r.dataset.position)),
      footerClass: footer?.className ?? '',
      endRow: num('.data-tables-footer-end-row'),
      total: num('.data-tables-footer-rows-count'),
      lastText: byPosition[byPosition.length - 1]?.innerText?.replace(/\s+/g, ' ').trim() ?? '',
    }
  }))
}

/**
 * Scroll the scroller `selector` of panel `kind` to its end, as a wheel or a
 * scrollbar drag does; returns the scroll offset it reached (-1: no scroller).
 */
export async function scrollPanelToEnd(kind: string, selector: string): Promise<number> {
  return inPanel(kind, async () => browser.execute((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) return -1
    el.scrollTop = el.scrollHeight
    el.dispatchEvent(new Event('scroll'))
    return el.scrollTop
  }, selector))
}
