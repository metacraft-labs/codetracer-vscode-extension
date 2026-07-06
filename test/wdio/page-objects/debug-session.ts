/**
 * Page object for managing the VS Code debug session in WDIO tests.
 *
 * Wraps breakpoint management, step operations, and session lifecycle.
 * Step operations wait for the debugger to settle before returning.
 */
import { browser } from '@wdio/globals'
import * as dap from '../helpers/dap-client'

export interface BreakpointInfo {
  id: string
  line: number // 1-based
  verified: boolean
  enabled: boolean
}

export interface StoppedLocation {
  file: string
  line: number // 1-based
}

export class DebugSession {
  /** Start a CodeTracer debug session and wait for it to be active. */
  async start(traceFolder: string): Promise<boolean> {
    const started = await dap.startDebugSession(traceFolder)
    if (started) {
      await dap.waitForDebugSession()
    }
    return started
  }

  /** Stop the current debug session. */
  async stop(): Promise<void> {
    await dap.stopDebugSession()
  }

  /** Check if a debug session is active. */
  async isActive(): Promise<boolean> {
    return browser.executeWorkbench(async (vscode) => {
      const session = vscode.debug.activeDebugSession
      return session !== undefined && session.type === 'codetracer-debug'
    })
  }

  /** Get the current stopped location (file + line from the editor cursor).
   *
   * Reads from ``vscode.window.activeTextEditor`` when available;
   * actively re-shows a source-shape editor from
   * ``vscode.window.tabGroups`` when focus has shifted to a side panel
   * (e.g. the locals view, calltrace tree, flow webview).  The deep
   * test suite (``test/wdio/specs/deep/*.e2e.ts``) issues several
   * non-step DAP queries between session start and the first
   * step-over; under VS Code Insiders those steal editor focus,
   * leaving ``activeTextEditor`` undefined and
   * ``visibleTextEditors`` empty -- the smoke variant runs
   * ``stepOver`` before those queries so it happens to keep focus.
   *
   * To recover the stopped-at location, walk ``tabGroups`` for a
   * source-shape tab, ``showTextDocument`` it (which both makes it
   * visible *and* makes it the active editor), and read the cursor
   * from there.  VS Code's DAP integration moves the cursor to the
   * stopped position on every ``stopped`` event regardless of focus,
   * so showing the editor surfaces the post-step line without
   * re-issuing the step.
   */
  async currentLocation(): Promise<StoppedLocation> {
    return browser.executeWorkbench(async (vscode) => {
      let editor: any = vscode.window.activeTextEditor
      if (!editor) {
        const sourceRe = /\.(rs|c|cc|cpp|cxx|h|hpp|sol|move|cairo|aiken|leo|sw|circom|tact|tolk|stylus|wasm|nim|py|ts|js)$/i
        let candidateUri: any = null
        for (const group of vscode.window.tabGroups.all) {
          for (const tab of group.tabs) {
            const input: any = tab.input
            const fsPath: string | undefined = input?.uri?.fsPath
            if (fsPath && sourceRe.test(fsPath)) {
              candidateUri = input.uri
              break
            }
          }
          if (candidateUri) break
        }
        if (candidateUri) {
          try {
            editor = await vscode.window.showTextDocument(candidateUri, { preserveFocus: false })
          } catch {
            // ignore
          }
        }
        editor =
          editor ??
          vscode.window.activeTextEditor ??
          vscode.window.visibleTextEditors[0]
      }
      if (!editor) return { file: '', line: -1 }
      return {
        file: editor.document.fileName,
        line: editor.selection.active.line + 1,
      }
    })
  }

  // ---- Step operations ----

  /** Re-show a source-shape editor so VS Code's DAP integration can
   * navigate it on the next ``stopped`` event.
   *
   * The deep test suite's non-step DAP queries
   * (``loadLocals`` / ``loadCalltrace`` / ``loadFlow``) hide the
   * source editor under a side panel.  When ``dap.stepOver`` /
   * ``stepIn`` / ``stepOut`` then fires and VS Code's DAP client
   * receives the ``stopped`` event, it has no editor to move the
   * cursor in -- so subsequent calls all read the same stale cursor
   * position and ``test/wdio/specs/deep/solana-deep.e2e.ts:performs
   * multiple step-over operations and changes line`` fails the
   * ``uniqueLines.size > 1`` assertion (cross-repo run
   * 27593691346: step-over returned valid line numbers but they
   * never changed).  Calling ``showTextDocument`` *before* the DAP
   * step ensures VS Code has a visible editor to navigate.
   */
  private async ensureSourceEditorShown(): Promise<void> {
    await browser.executeWorkbench(async (vscode) => {
      if (vscode.window.activeTextEditor) return
      const sourceRe = /\.(rs|c|cc|cpp|cxx|h|hpp|sol|move|cairo|aiken|leo|sw|circom|tact|tolk|stylus|wasm|nim|py|ts|js)$/i
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input: any = tab.input
          const fsPath: string | undefined = input?.uri?.fsPath
          if (fsPath && sourceRe.test(fsPath)) {
            await vscode.window.showTextDocument(input.uri, { preserveFocus: false })
            return
          }
        }
      }
    })
  }

  /** Step over (next line) and wait for the move to complete. */
  async stepOver(settleMs = 2000): Promise<StoppedLocation> {
    await this.ensureSourceEditorShown()
    await dap.stepOver()
    await browser.pause(settleMs)
    return this.currentLocation()
  }

  /** Step into and wait for the move to complete. */
  async stepIn(settleMs = 2000): Promise<StoppedLocation> {
    await this.ensureSourceEditorShown()
    await dap.stepIn()
    await browser.pause(settleMs)
    return this.currentLocation()
  }

  /** Step out and wait for the move to complete. */
  async stepOut(settleMs = 2000): Promise<StoppedLocation> {
    await this.ensureSourceEditorShown()
    await dap.stepOut()
    await browser.pause(settleMs)
    return this.currentLocation()
  }

  /** Continue execution and wait for the debugger to stop again. */
  async continue(settleMs = 3000): Promise<StoppedLocation> {
    await dap.dapContinue()
    await browser.pause(settleMs)
    return this.currentLocation()
  }

  /** Reverse step in. */
  async reverseStepIn(settleMs = 2000): Promise<StoppedLocation> {
    await dap.reverseStepIn()
    await browser.pause(settleMs)
    return this.currentLocation()
  }

  /** Reverse continue. */
  async reverseContinue(settleMs = 3000): Promise<StoppedLocation> {
    await dap.reverseContinue()
    await browser.pause(settleMs)
    return this.currentLocation()
  }

  /**
   * Wait for the DAP backend to finish initialization by polling threads.
   *
   * For traces with source files, the editor tab opening (waitUntil 15s)
   * acts as a natural barrier. For binary-blob traces (e.g. PolkaVM) that
   * skip the editor tab check, call this method after start() to ensure
   * the backend's setup() has completed before sending further requests.
   */
  async waitForBackendReady(timeoutMs = 60000): Promise<void> {
    await browser.waitUntil(
      async () => {
        const result = await this.getThreads()
        return result.ok
      },
      {
        timeout: timeoutMs,
        interval: 2000,
        timeoutMsg: `DAP backend not ready within ${timeoutMs / 1000}s (threads request did not succeed)`,
      },
    )
  }

  /**
   * Step over via DAP only — does not read the editor cursor.
   * Useful for binary-blob traces (e.g. PolkaVM) where VS Code may not
   * have an active text editor tab.
   */
  async stepOverDap(settleMs = 2000): Promise<dap.DapResult> {
    const result = await dap.stepOver()
    await browser.pause(settleMs)
    return result
  }

  // ---- Breakpoints ----

  /** Add a source breakpoint at the given 1-based line number.
   *
   * Finds the source URI by walking ``tabGroups`` if
   * ``activeTextEditor`` is undefined (same focus-loss case
   * ``currentLocation`` handles).  Without the fallback the deep
   * test suite's ``sets a breakpoint and continues to it`` returns
   * ``{added: false}`` because the locals/calltrace queries earlier
   * in the spec stole editor focus.
   */
  async addBreakpoint(line: number): Promise<{ total: number; added: boolean }> {
    return browser.executeWorkbench(async (vscode, targetLine: number) => {
      let uri: any = vscode.window.activeTextEditor?.document.uri
      if (!uri) {
        const sourceRe = /\.(rs|c|cc|cpp|cxx|h|hpp|sol|move|cairo|aiken|leo|sw|circom|tact|tolk|stylus|wasm|nim|py|ts|js)$/i
        for (const group of vscode.window.tabGroups.all) {
          for (const tab of group.tabs) {
            const input: any = tab.input
            const fsPath: string | undefined = input?.uri?.fsPath
            if (fsPath && sourceRe.test(fsPath)) {
              uri = input.uri
              break
            }
          }
          if (uri) break
        }
      }
      if (!uri) return { total: 0, added: false }

      const bp = new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(targetLine - 1, 0)),
      )
      vscode.debug.addBreakpoints([bp])

      const bps = vscode.debug.breakpoints
      return {
        total: bps.length,
        added: bps.some(
          (b: any) =>
            b.location && b.location.range.start.line === targetLine - 1,
        ),
      }
    }, line)
  }

  /** Remove all breakpoints. */
  async removeAllBreakpoints(): Promise<void> {
    await browser.executeWorkbench(async (vscode) => {
      const bps = vscode.debug.breakpoints
      if (bps.length > 0) {
        vscode.debug.removeBreakpoints(bps)
      }
    })
  }

  /** Get all current breakpoints. */
  async getBreakpoints(): Promise<BreakpointInfo[]> {
    return browser.executeWorkbench(async (vscode) => {
      return vscode.debug.breakpoints.map((bp: any) => ({
        id: bp.id || '',
        line: bp.location ? bp.location.range.start.line + 1 : -1,
        verified: bp.verified ?? false,
        enabled: bp.enabled ?? true,
      }))
    })
  }

  // ---- DAP data queries (delegated to dap-client) ----

  async getThreads() { return dap.getThreads() }
  async loadCalltrace(opts?: Parameters<typeof dap.loadCalltrace>[0]) { return dap.loadCalltrace(opts) }
  async loadEvents() { return dap.loadEvents() }
  async loadLocals(opts?: Parameters<typeof dap.loadLocals>[0]) { return dap.loadLocals(opts) }
  async loadFlow(flowMode?: number) { return dap.loadFlow(flowMode) }
  async loadTerminal() { return dap.loadTerminal() }
  async searchCalltrace(query: string) { return dap.searchCalltrace(query) }
}
