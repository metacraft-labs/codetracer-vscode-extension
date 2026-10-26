/**
 * The Request Panel is a VS Code panel role (codetracer-vscode-extension#44;
 * codetracer-pm Shared-DOM-Front-Ends Q8 and Request-Panel.md § The VS Code
 * extension).
 *
 * Checked in VS Code itself, on a real recording (`helpers/panel-paging.ts`),
 * with nothing mocked:
 *  - `ct-vscode.openRequests` opens a `Requests` webview whose
 *    `vscode_panel.js` mounts the `requestPanel` role — the shared Request
 *    Panel view (`.component-container.request-panel` with its table body)
 *    over the mirrored session;
 *  - the webview loads `vscode_panel.js` and no other CodeTracer script, as
 *    every panel role does (Shared-DOM-Front-Ends D5).
 *
 * The recording serves no HTTP requests, so the view shows its empty table;
 * the rows a recording with request spans brings, and a row click running on
 * the extension host's session, are covered by codetracer's
 * `vscode_request_panel_role_dom_test.nim` over the same entry module.
 */
import { browser, expect } from '@wdio/globals'
import { DebugSession, ExtensionState } from '../../page-objects'
import { inPanel, panelDocuments } from '../../page-objects/panels'
import { captureFullDiagnostics, screenshot, writeDiag } from '../../helpers/diagnostics'
import { resolveTracePath, traceExists } from '../../helpers/trace-utils'
import { PANEL_PAGING_TRACE, openMountedPanel } from '../../helpers/panel-paging'

const session = new DebugSession()
const ext = new ExtensionState()

describe('Requests panel: the Request Panel role mounts in VS Code (#44)', () => {
  let traceDir: string

  before(function () {
    traceDir = resolveTracePath(PANEL_PAGING_TRACE)
    if (!traceExists(PANEL_PAGING_TRACE)) {
      console.warn(`SKIPPING Requests panel: trace not found at ${traceDir}; ` +
        `run scripts/record-test-traces.sh ${PANEL_PAGING_TRACE}`)
      this.skip()
    }
  })

  afterEach(async function () {
    const name = this.currentTest?.title?.replace(/[^a-zA-Z0-9_-]+/g, '-').substring(0, 50) ?? 'unknown'
    if (this.currentTest?.state === 'failed') {
      await captureFullDiagnostics(`requests-panel-FAIL-${name}`)
    }
    await screenshot(`requests-panel-${name}`)
  })

  it('opens the Requests panel and mounts the shared Request Panel view', async () => {
    await ext.ensureActivated()
    expect(await session.start(traceDir)).toBe(true)
    await session.waitForBackendReady()
    await openMountedPanel('requestPanel', 'ct-vscode.openRequests', 'Requests')

    const docs = await panelDocuments()
    const doc = docs.find((d) => d.panel === 'requestPanel')
    writeDiag('requests-panel-documents.json', docs)
    expect(doc?.mounted).toBe('requestPanel')
    expect(doc?.scripts.filter((s) => s.endsWith('.js'))).toEqual(['vscode_panel.js'])

    const view = await inPanel('requestPanel', async () => browser.execute(() => {
      const panel = document.querySelector('.component-container.request-panel')
      return {
        panel: panel !== null,
        body: document.querySelector('.request-table-body') !== null,
        header: document.querySelector('.request-table-header') !== null,
      }
    }))
    writeDiag('requests-panel-view.json', view)
    expect(view).toEqual({ panel: true, body: true, header: true })
  })
})
