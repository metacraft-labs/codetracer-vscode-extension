/**
 * Page objects for CodeTracer webview panels in WDIO tests.
 *
 * The CodeTracer extension creates webview panels for calltrace, state,
 * event log, scratchpad, and terminal output. These panels render inside
 * triple-nested iframes (VS Code webview architecture), so direct DOM
 * queries via WebDriver selectors are difficult.
 *
 * Instead, we query panel state through `executeWorkbench()` (extension host)
 * and DAP custom requests (debug adapter). For DOM-level inspection of webview
 * content, we provide iframe navigation helpers.
 */
import { browser } from '@wdio/globals'
import { writeDiag } from '../helpers/diagnostics'

/** Information about a CodeTracer panel's existence and visibility. */
export interface PanelInfo {
  id: string
  title: string
  visible: boolean
  active: boolean
}

/** Get the status of all CodeTracer panels. */
export async function getPanelStatus(): Promise<PanelInfo[]> {
  return browser.executeWorkbench(async (vscode) => {
    // The panels are registered as webview panels. We can check for them
    // via the tab groups API.
    const panels: any[] = []
    const expectedPanels = [
      'State', 'Calltrace', 'Event Log', 'Scratchpad', 'Terminal'
    ]

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const label = tab.label || ''
        if (expectedPanels.some(p => label.includes(p))) {
          panels.push({
            id: label.toLowerCase().replace(/\s+/g, '-'),
            title: label,
            visible: group.isActive,
            active: tab.isActive,
          })
        }
      }
    }
    return panels
  })
}

/** Check if a specific panel is open (by title substring). */
export async function isPanelOpen(titlePattern: string): Promise<boolean> {
  const panels = await getPanelStatus()
  return panels.some(p =>
    p.title.toLowerCase().includes(titlePattern.toLowerCase())
  )
}

/** Open a CodeTracer panel by executing its command. */
export async function openPanel(panelCommand: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      return browser.executeWorkbench(async (vscode, cmd: string) => {
        const commands = await vscode.commands.getCommands(true)
        return commands.includes(cmd)
      }, panelCommand)
    },
    {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: `${panelCommand} was not registered within 20000ms`,
    },
  )
  await browser.executeWorkbench(async (vscode, cmd: string) => {
    await vscode.commands.executeCommand(cmd)
  }, panelCommand)
  // Allow the panel to render
  await browser.pause(500)
}

/** Open the State panel. */
export async function openStatePanel(): Promise<void> {
  await openPanel('ct-vscode.openState')
}

/** Open the Calltrace panel. */
export async function openCalltracePanel(): Promise<void> {
  await openPanel('ct-vscode.openCalltrace')
}

/** Open the Event Log panel. */
export async function openEventLogPanel(): Promise<void> {
  await openPanel('ct-vscode.openEventLog')
}

/** Open the Terminal Output panel. */
export async function openTerminalPanel(): Promise<void> {
  await openPanel('ct-vscode.openTerminalOutput')
}

/** Open the Scratchpad panel. */
export async function openScratchpadPanel(): Promise<void> {
  await openPanel('ct-vscode.openScratchpad')
}

/**
 * Inspect webview content by navigating through nested iframes.
 *
 * VS Code webviews are typically rendered inside 2-3 levels of iframes.
 * This function navigates the iframe tree and captures DOM state for
 * diagnostic purposes.
 *
 * Returns an array of webview content snapshots.
 */
export async function inspectWebviews(label: string): Promise<any[]> {
  const results: any[] = []

  try {
    const iframes = await browser.$$('iframe')
    console.log(`[panels] Top-level iframes: ${iframes.length}`)

    for (let i = 0; i < Math.min(iframes.length, 10); i++) {
      const src = await iframes[i].getAttribute('src') || ''
      const cls = await iframes[i].getAttribute('class') || ''

      try {
        await browser.switchToFrame(iframes[i])
        const nested = await browser.$$('iframe')

        for (let j = 0; j < Math.min(nested.length, 8); j++) {
          try {
            await browser.switchToFrame(nested[j])
            const deep = await browser.$$('iframe')

            if (deep.length > 0) {
              for (let k = 0; k < Math.min(deep.length, 5); k++) {
                try {
                  await browser.switchToFrame(deep[k])
                  const domInfo = await browser.execute(() => ({
                    title: document.title,
                    bodyLength: document.body?.innerHTML?.length ?? 0,
                    bodyPreview: document.body?.innerHTML?.substring(0, 2000) ?? '',
                    innerText: document.body?.innerText?.substring(0, 500) ?? '',
                    scripts: Array.from(document.querySelectorAll('script')).map(s => ({
                      src: s.getAttribute('src')?.substring(0, 150) ?? null,
                    })),
                    divCount: document.querySelectorAll('div').length,
                    hasComponent: (window as any).component !== undefined,
                    componentType: (window as any).component?.constructor?.name ?? null,
                  }))
                  results.push({ iframe: `${i}-${j}-${k}`, ...domInfo })
                  await browser.switchToParentFrame()
                } catch {
                  try { await browser.switchToParentFrame() } catch { /* ignore */ }
                }
              }
            } else {
              // This might be the webview content itself
              const domInfo = await browser.execute(() => ({
                title: document.title,
                bodyLength: document.body?.innerHTML?.length ?? 0,
                innerText: document.body?.innerText?.substring(0, 500) ?? '',
                hasComponent: (window as any).component !== undefined,
              }))
              results.push({ iframe: `${i}-${j}`, ...domInfo })
            }
            await browser.switchToParentFrame()
          } catch {
            try { await browser.switchToParentFrame() } catch { /* ignore */ }
          }
        }
        await browser.switchToParentFrame()
      } catch {
        try { await browser.switchToParentFrame() } catch { /* ignore */ }
      }
    }
  } catch (e: any) {
    console.log(`[panels] inspectWebviews failed: ${e.message?.substring(0, 80)}`)
  }

  // Always return to the top frame
  try { await browser.switchToFrame(null) } catch { /* ignore */ }

  if (results.length > 0) {
    writeDiag(`webview-inspection-${label}.json`, results)
  }

  return results
}
