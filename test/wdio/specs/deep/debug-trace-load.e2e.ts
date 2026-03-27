/**
 * Full diagnostic capture test for the CodeTracer extension.
 *
 * This test captures comprehensive state from the extension, debug session,
 * DAP communication, webview panels, and VS Code extension host logs.
 * Its primary purpose is generating diagnostic artifacts for debugging —
 * it's the WDIO equivalent of running the Playwright tests with full tracing.
 */
import { browser } from '@wdio/globals'
import { DebugSession, EditorPane, ExtensionState } from '../page-objects'
import { getPanelStatus, inspectWebviews } from '../page-objects/panels'
import {
  captureFullDiagnostics,
  screenshot,
  writeDiag,
  captureBrowserLogs,
  captureExtHostLog,
} from '../helpers/diagnostics'

const ext = new ExtensionState()
const session = new DebugSession()
const editor = new EditorPane()

describe('CodeTracer Debug - Full Diagnostics', () => {
  it('captures complete state of extension, panels, webviews, and DAP', async () => {
    // ===== PHASE 1: Activation =====
    console.log('===== PHASE 1: Activation =====')
    await screenshot('01-initial')

    const info = await ext.info()
    writeDiag('01-extension-info.json', info)
    console.log('Extension:', JSON.stringify(info))

    await ext.ensureActivated()
    const nimState = await ext.nimBackendState()
    writeDiag('01-nim-state.json', nimState)
    console.log('Nim backend:', JSON.stringify(nimState))

    const runnablePath = await ext.runnablePath()
    console.log('Runnable path:', runnablePath)

    const commands = await ext.waitForCommands(15000)
    writeDiag('01-commands.json', commands)
    console.log('Commands:', commands.length, 'registered')

    // ===== PHASE 2: Start debug =====
    console.log('===== PHASE 2: Start debug =====')
    const startOk = await browser.executeWorkbench(async (vscode) => {
      return vscode.debug.startDebugging(
        vscode.workspace.workspaceFolders?.[0],
        {
          type: 'codetracer-debug',
          request: 'launch',
          name: 'Stylus Fund Trace',
          traceFolder: '/home/zahary/metacraft/stylus-trace-manual',
        }
      )
    })
    console.log('startDebugging:', startOk)
    await browser.pause(3000)
    await screenshot('02-debug-started')

    // ===== PHASE 3: Editor state =====
    console.log('===== PHASE 3: Editor state =====')
    const editorState = await editor.state()
    writeDiag('03-editor-state.json', editorState)
    console.log('Editor:', JSON.stringify(editorState))

    const tabs = await editor.openTabs()
    writeDiag('03-open-tabs.json', tabs)
    console.log('Open tabs:', tabs.length)

    // ===== PHASE 4: Panel state =====
    console.log('===== PHASE 4: Panel state =====')
    await browser.pause(5000)
    await screenshot('03-panels-loaded')

    const panels = await getPanelStatus()
    writeDiag('04-panels.json', panels)
    console.log('Panels:', JSON.stringify(panels))

    const isActive = await session.isActive()
    const location = await session.currentLocation()
    writeDiag('04-session.json', { isActive, location })
    console.log('Session active:', isActive, 'Location:', JSON.stringify(location))

    // ===== PHASE 5: DAP checks =====
    console.log('===== PHASE 5: DAP communication =====')

    const threads = await session.getThreads()
    writeDiag('05-dap-threads.json', threads)
    console.log('DAP threads:', JSON.stringify(threads).substring(0, 200))

    const events = await session.loadEvents()
    writeDiag('05-dap-events.json', events)
    console.log('DAP events:', events.ok ? 'OK' : events.error)

    const calltrace = await session.loadCalltrace({ depth: 50, height: 200 })
    writeDiag('05-dap-calltrace.json', calltrace)
    console.log('DAP calltrace:', calltrace.ok ? 'OK' : calltrace.error)

    const locals = await session.loadLocals()
    writeDiag('05-dap-locals.json', locals)
    console.log('DAP locals:', locals.ok ? 'OK' : locals.error)

    const flow = await session.loadFlow()
    writeDiag('05-dap-flow.json', flow)
    console.log('DAP flow:', flow.ok ? 'OK' : flow.error)

    const terminal = await session.loadTerminal()
    writeDiag('05-dap-terminal.json', terminal)
    console.log('DAP terminal:', terminal.ok ? 'OK' : terminal.error)

    await screenshot('05-after-dap')

    // ===== PHASE 6: Resource files =====
    console.log('===== PHASE 6: Resource files =====')
    const resources = await ext.resourceFileStatus()
    writeDiag('06-resource-files.json', resources)
    console.log('Resource files:', JSON.stringify(resources, null, 2))

    // ===== PHASE 7: Webview inspection =====
    console.log('===== PHASE 7: Webview inspection =====')
    await inspectWebviews('diagnostic')

    // ===== PHASE 8: Logs =====
    console.log('===== PHASE 8: Logs =====')
    await captureBrowserLogs('diagnostic')
    const extLog = await captureExtHostLog('diagnostic')
    if (extLog?.lines) {
      for (const l of extLog.lines.slice(-15)) {
        console.log(`[exthost] ${String(l).substring(0, 150)}`)
      }
    }

    await screenshot('08-final')

    // ===== SUMMARY =====
    console.log('===== DIAGNOSTIC SUMMARY =====')
    console.log(`Extension: ${info?.id ?? 'NOT FOUND'} (active: ${info?.isActive})`)
    console.log(`Session: ${isActive ? 'ACTIVE' : 'INACTIVE'}`)
    console.log(`Editor: ${editorState?.fileName ?? 'none'} at line ${editorState?.cursorLine ?? '?'}`)
    console.log(`Panels: ${panels.length} found`)
    console.log(`DAP: threads=${threads.ok} events=${events.ok} calltrace=${calltrace.ok} locals=${locals.ok}`)
    console.log(`Open tabs: ${tabs.length}`)
    console.log('Diagnostics written to test/wdio/diagnostics/')
  })
})
