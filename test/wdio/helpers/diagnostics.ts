/**
 * Diagnostic capture utilities for WDIO tests.
 *
 * Captures screenshots, DOM state dumps, extension host logs, browser console
 * logs, and DAP state snapshots to the diagnostics directory. These artifacts
 * are essential for debugging test failures in CI or headless environments.
 */
import path from 'path'
import fs from 'fs'
import { browser } from '@wdio/globals'

const DIAG_DIR = path.resolve(__dirname, '..', 'diagnostics')

// Ensure the diagnostics directory exists at module load time.
if (!fs.existsSync(DIAG_DIR)) {
  fs.mkdirSync(DIAG_DIR, { recursive: true })
}

/** Return the absolute path to the diagnostics directory. */
export function diagDir(): string {
  return DIAG_DIR
}

/** Write a diagnostic artifact to the diagnostics directory. */
export function writeDiag(filename: string, data: any): void {
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  const filePath = path.join(DIAG_DIR, filename)
  fs.writeFileSync(filePath, content)
  console.log(`[diag] Wrote ${filename} (${content.length} bytes)`)
}

/** Capture a labeled screenshot. Returns true on success. */
export async function screenshot(label: string): Promise<boolean> {
  try {
    const filePath = path.join(DIAG_DIR, `screenshot-${label}.png`)
    await browser.saveScreenshot(filePath)
    console.log(`[diag] Screenshot: ${label}`)
    return true
  } catch (e: any) {
    console.log(`[diag] Screenshot ${label} failed: ${e.message?.substring(0, 80)}`)
    return false
  }
}

/** Capture browser console logs and save to a JSON file. */
export async function captureBrowserLogs(label: string): Promise<any[]> {
  try {
    const logs = await browser.getLogs('browser')
    writeDiag(`browser-console-${label}.json`, logs)
    const errors = logs.filter((l: any) => l.level === 'SEVERE' || l.level === 'ERROR')
    if (errors.length > 0) {
      console.log(`[diag] Browser console (${label}): ${logs.length} total, ${errors.length} errors`)
      for (const e of errors.slice(0, 5)) {
        console.log(`  [error] ${JSON.stringify(e).substring(0, 200)}`)
      }
    }
    return logs
  } catch (e: any) {
    console.log(`[diag] captureBrowserLogs(${label}) failed: ${e.message?.substring(0, 80)}`)
    return []
  }
}

/** Read the VS Code extension host log and extract relevant lines. */
export async function captureExtHostLog(label: string): Promise<any> {
  try {
    const result = await browser.executeWorkbench(async (vscode) => {
      const base = vscode.Uri.file('/tmp/wdio-vscode-ct')
      const entries = await vscode.workspace.fs.readDirectory(base)
      const latest = entries
        .filter(([n]: any) => n.startsWith('run-'))
        .map(([n]: any) => n).sort().pop()
      if (!latest) return { error: 'no run dir' }

      const logsBase = vscode.Uri.joinPath(base, latest, 'settings', 'logs')
      const logDirs = await vscode.workspace.fs.readDirectory(logsBase)
      const logDir = logDirs.map(([n]: any) => n).sort().pop()
      if (!logDir) return { error: 'no log dir' }

      const extHostPath = vscode.Uri.joinPath(logsBase, logDir, 'window1', 'exthost', 'exthost.log')
      const bytes = await vscode.workspace.fs.readFile(extHostPath)
      const text = new TextDecoder().decode(bytes)
      const lines = text.split('\n')
      const relevant = lines.filter((l: string) =>
        l.toLowerCase().includes('codetracer') ||
        l.toLowerCase().includes('ct-vscode') ||
        l.toLowerCase().includes('ct_vscode') ||
        l.includes('error') || l.includes('Error') ||
        l.includes('warn') || l.includes('Warn') ||
        l.includes('activat')
      )
      return { total: lines.length, relevant: relevant.length, lines: relevant.slice(-80) }
    })
    writeDiag(`exthost-log-${label}.json`, result)
    return result
  } catch (e: any) {
    console.log(`[diag] captureExtHostLog(${label}) failed: ${e.message?.substring(0, 80)}`)
    return { error: e.message }
  }
}

/**
 * Capture a full diagnostic snapshot: screenshot + browser logs + ext host log.
 * Call this in afterEach hooks or on failure.
 */
export async function captureFullDiagnostics(label: string): Promise<void> {
  await screenshot(label)
  await captureBrowserLogs(label)
  await captureExtHostLog(label)
}
