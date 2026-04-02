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

  /** Get the current stopped location (file + line from the editor cursor). */
  async currentLocation(): Promise<StoppedLocation> {
    return browser.executeWorkbench(async (vscode) => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return { file: '', line: -1 }
      return {
        file: editor.document.fileName,
        line: editor.selection.active.line + 1
      }
    })
  }

  // ---- Step operations ----

  /** Step over (next line) and wait for the move to complete. */
  async stepOver(settleMs = 2000): Promise<StoppedLocation> {
    await dap.stepOver()
    await browser.pause(settleMs)
    return this.currentLocation()
  }

  /** Step into and wait for the move to complete. */
  async stepIn(settleMs = 2000): Promise<StoppedLocation> {
    await dap.stepIn()
    await browser.pause(settleMs)
    return this.currentLocation()
  }

  /** Step out and wait for the move to complete. */
  async stepOut(settleMs = 2000): Promise<StoppedLocation> {
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

  /** Add a source breakpoint at the given 1-based line number. */
  async addBreakpoint(line: number): Promise<{ total: number; added: boolean }> {
    return browser.executeWorkbench(async (vscode, targetLine: number) => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return { total: 0, added: false }

      const uri = editor.document.uri
      const bp = new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(targetLine - 1, 0))
      )
      vscode.debug.addBreakpoints([bp])

      const bps = vscode.debug.breakpoints
      return {
        total: bps.length,
        added: bps.some((b: any) =>
          b.location && b.location.range.start.line === targetLine - 1
        )
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
