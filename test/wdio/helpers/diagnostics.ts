/**
 * Diagnostic capture utilities for WDIO tests.
 *
 * Captures screenshots, DOM state dumps, extension host logs, browser console
 * logs, and DAP state snapshots to the diagnostics directory. These artifacts
 * are essential for debugging test failures in CI or headless environments.
 */
import path from 'path'
import fs from 'fs'
import os from 'os'
import { browser } from '@wdio/globals'

const DIAG_DIR = path.resolve(__dirname, '..', 'diagnostics')

// Root of the per-run wdio-vscode-service storage tree.  Must match the
// `shortTmpDir` computed in wdio.conf.ts: `/tmp/wdio-vscode-ct` on POSIX
// (short path to stay under the Unix-socket sun_path limit) and a directory
// under the OS temp dir on Windows (no such limit, and `/tmp` is not a valid
// Windows path).
const WDIO_STORAGE_ROOT = process.platform === 'win32'
  ? path.join(os.tmpdir(), 'wdio-vscode-ct')
  : '/tmp/wdio-vscode-ct'

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
    const result = await browser.executeWorkbench(async (vscode, storageRoot: string) => {
      const base = vscode.Uri.file(storageRoot)
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
    }, WDIO_STORAGE_ROOT)
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

/**
 * Hash a fixture file so local vs CI runs can be byte-compared.
 * Captures SHA-256, size, and the first 64 bytes (hex) which include
 * the CTFS magic + meta.dat header.  Diagnostic-only.
 */
export function captureTraceFingerprint(label: string, tracePath: string): void {
  try {
    if (!fs.existsSync(tracePath)) {
      writeDiag(`trace-fingerprint-${label}.json`, { error: 'missing', path: tracePath })
      return
    }
    const buf = fs.readFileSync(tracePath)
    const crypto = require('crypto')
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
    writeDiag(`trace-fingerprint-${label}.json`, {
      path: tracePath,
      size: buf.length,
      sha256,
      first_64_hex: buf.subarray(0, 64).toString('hex'),
    })
  } catch (e: any) {
    writeDiag(`trace-fingerprint-${label}.json`, { error: e.message, path: tracePath })
  }
}

/**
 * Capture every DAP query that touches the current step's state — what
 * VS Code thinks the active frame is + what scopes/variables the debug
 * adapter exposes for that frame.  Run this BEFORE the locals assertion
 * so the captured payload matches the failing query exactly.
 *
 * The DAP `customRequest`s here are run inside the workbench context
 * (`browser.executeWorkbench`) because they have to talk to VS Code's
 * `debug.activeDebugSession`.  Every query is best-effort: failures
 * are captured in the diagnostic JSON, never thrown.
 */
export async function captureDapStateSnapshot(label: string): Promise<void> {
  // Why inlined / no const helper: ``browser.executeWorkbench`` ships the
  // callback to the VS Code workbench by calling ``.toString()`` on the
  // transpiled function.  ``tsx`` (the WDIO loader) inserts ``__name(fn,
  // "fn")`` polyfill calls for every NAMED function expression — incl.
  // ``const safeRequest = async () => {...}`` — and the workbench has no
  // ``__name`` global, so the deserialised function throws ``__name is
  // not defined`` (observed in cross-repo run 27709264564's
  // ``dap-state-solana-before-locals.json``).  Inlining each DAP call
  // sidesteps the polyfill.
  try {
    const snapshot = await browser.executeWorkbench(async (vscode: any) => {
      const session = vscode.debug.activeDebugSession
      if (!session) return { error: 'no active debug session' }

      let threads: any
      try { threads = await session.customRequest('threads', {}) }
      catch (e: any) { threads = { error: e.message } }

      const threadId = threads?.threads?.[0]?.id ?? 1

      let stackTrace: any
      try {
        stackTrace = await session.customRequest('stackTrace', {
          threadId, startFrame: 0, levels: 20,
        })
      } catch (e: any) { stackTrace = { error: e.message } }

      const frameId = stackTrace?.stackFrames?.[0]?.id ?? 0

      let scopes: any
      try { scopes = await session.customRequest('scopes', { frameId }) }
      catch (e: any) { scopes = { error: e.message } }

      const variablesByScope: any = {}
      if (scopes && scopes.scopes && Array.isArray(scopes.scopes)) {
        for (const scope of scopes.scopes) {
          if (scope.variablesReference > 0) {
            const key = scope.name ?? `ref-${scope.variablesReference}`
            try {
              variablesByScope[key] = await session.customRequest('variables', {
                variablesReference: scope.variablesReference,
                count: 64,
              })
            } catch (e: any) {
              variablesByScope[key] = { error: e.message }
            }
          }
        }
      }
      return { threads, stackTrace, scopes, variablesByScope }
    })
    writeDiag(`dap-state-${label}.json`, snapshot)
  } catch (e: any) {
    writeDiag(`dap-state-${label}.json`, { error: e.message })
  }
}
