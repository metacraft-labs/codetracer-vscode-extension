import path from 'path'
import fs from 'fs'
import os from 'os'
import { execSync } from 'child_process'

// Resolve chromedriver binary: prefer Nix-provided, fallback to npm package.
// The npm chromedriver binary won't run on NixOS (dynamically linked), so
// we look for a system chromedriver first.
function resolveChromedriverBinary(): string | undefined {
  // Check environment variable
  if (process.env.CHROMEDRIVER_PATH) return process.env.CHROMEDRIVER_PATH
  // Check PATH
  try {
    const fromPath = execSync('command -v chromedriver', { encoding: 'utf8' }).trim()
    if (fromPath) return fromPath
  } catch { }
  // Fallback to npm chromedriver package (works on non-NixOS)
  try {
    const chromedriver = require('chromedriver')
    return chromedriver.path
  } catch { }
  return undefined
}
const chromedriverBinary = resolveChromedriverBinary()

/// Resolve the VS Code Insiders binary path, handling Nix-managed installations.
function resolveVSCodeInsidersBinary(): string | undefined {
  const fromEnv = process.env.VSCODE_INSIDERS_PATH
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv
  try {
    const whichPath = execSync('command -v code-insiders', { encoding: 'utf8' }).trim()
    if (whichPath) {
      // Resolve symlinks (Nix often symlinks to store paths)
      let resolved = whichPath
      try { resolved = fs.realpathSync(whichPath) } catch { }
      // Nix macOS app bundle path from CLI wrapper
      const nixAppCandidate = resolved.replace(
        /\/bin\/code-insiders$/, '/Applications/Visual Studio Code - Insiders.app'
      )
      if (fs.existsSync(nixAppCandidate)) return nixAppCandidate
      // Directly try to locate Electron inside Nix store
      try {
        const found = execSync('ls -d /nix/store/*-vscode-insiders*/Applications/Visual\\ Studio\\ Code\\ -\\ Insiders.app 2>/dev/null | head -n 1', { encoding: 'utf8' }).trim()
        if (found) return found
      } catch { }
      // Fallback to wrapper if nothing else found
      return whichPath
    }
  } catch { }
  try {
    // macOS Spotlight lookup for the Insiders app
    const appPath = execSync('mdfind "kMDItemCFBundleIdentifier == com.microsoft.VSCodeInsiders" | head -n 1', { encoding: 'utf8' }).trim()
    if (appPath) return `${appPath}/Contents/MacOS/Electron`
  } catch { }
  return undefined
}

// VS Code channel to test against. Defaults to `stable`.
//
// `stable` is the representative target for the suite: no WDIO spec
// exercises the extension's sole proposed API (`editorInsets`, used only
// by the interactive tracepoint / flow-inset commands), so the suite does
// not require the Insiders channel. The renderer-crash investigation also
// confirmed the crash reproduces identically on stable 1.121.0 and
// Insiders 1.122.0, so it is not a pre-release-build instability.
//
// Override with WDIO_VSCODE_VERSION (e.g. `insiders`, or a pinned version
// like `1.96.4`) when a proposed-API run is genuinely needed.
const vscodeChannel = process.env.WDIO_VSCODE_VERSION?.trim() || 'stable'

const vscodeInsidersBinary = vscodeChannel === 'insiders' ? resolveVSCodeInsidersBinary() : undefined
if (vscodeChannel === 'insiders' && vscodeInsidersBinary) {
  console.log(`Using VS Code Insiders binary: ${vscodeInsidersBinary}`)
} else {
  console.log(`Using VS Code channel: ${vscodeChannel} (downloaded by wdio-vscode-service)`)
}

// Use a short tmp directory to avoid Unix socket path length issues.
// On POSIX, wdio-vscode-service places its IPC socket under TMPDIR and the
// 108-char sun_path limit can be exceeded by deep default temp paths, so we
// pin a short, stable `/tmp` location. On Windows there is no Unix-socket
// path-length limit and `/tmp` is not a valid path, so we base the short
// directory under the OS temp directory instead.
const shortTmpDir = process.platform === 'win32'
  ? path.join(os.tmpdir(), 'wdio-vscode-ct')
  : '/tmp/wdio-vscode-ct'
// Create a unique storage root per run to avoid user-data-dir lock contention
const uniqueStorageRoot = path.join(shortTmpDir, `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
// Pin VS Code's --logsPath to a stable directory inside the diagnostics tree
// so the extension host / renderer logs survive a VS Code crash and a
// post-run storage cleanup (the per-run user-data-dir is volatile).
const vscodeLogsDir = path.resolve(__dirname, 'test', 'wdio', 'diagnostics', 'vscode-logs')
try {
  if (!fs.existsSync(shortTmpDir)) fs.mkdirSync(shortTmpDir, { recursive: true })
  if (!fs.existsSync(uniqueStorageRoot)) fs.mkdirSync(uniqueStorageRoot, { recursive: true })
  fs.rmSync(vscodeLogsDir, { recursive: true, force: true })
  fs.mkdirSync(vscodeLogsDir, { recursive: true })
  process.env.TMPDIR = shortTmpDir
  process.env.TEMP = shortTmpDir
  process.env.TMP = shortTmpDir
} catch { }

export const config: any = {
  runner: 'local',

  specs: [
    './test/wdio/specs/**/*.e2e.ts'
  ],

  capabilities: [{
    browserName: 'vscode',
    browserVersion: vscodeChannel,
    'wdio:enforceWebDriverClassic': true,
    ...(chromedriverBinary ? {
      'wdio:chromedriverOptions': {
        binary: chromedriverBinary
      }
    } : {}),
    'wdio:vscodeOptions': ({
      ...(vscodeInsidersBinary ? { binary: vscodeInsidersBinary } : {}),
      extensionPath: path.resolve(__dirname),
      workspacePath: path.resolve(__dirname, 'test', 'wdio', 'projects', 'stylus-test'),
      storagePath: uniqueStorageRoot,
      vscodeProxyOptions: {
        connectionTimeout: 60000,
        commandTimeout: 60000
      },
      verboseLogging: true,
      vscodeArgs: {
        'disable-telemetry': true,
        'disable-extensions': false,
        'enable-proposed-api': 'metacraft-labs.ct-vscode',
        // Linux/NixOS-only Chromium workarounds. wdio-vscode-service already
        // passes --no-sandbox; on NixOS CI runners without user-namespace
        // support the zygote still fails to fork renderers.
        ...(process.platform !== 'win32' ? {
          'no-zygote': true,
          'disable-dev-shm-usage': true,
        } : {}),
        // Disable GPU acceleration on every platform. The CodeTracer webview
        // panels render heavy DOM/Monaco content; with the GPU process in
        // play the headless WDIO run was prone to GPU-process crashes that
        // took the workbench renderer down with them. Software compositing
        // is slower but stable, which is what a test run needs.
        'disable-gpu': true,
        'disable-gpu-compositing': true,
        // Pin the log directory so extension host / renderer logs survive a
        // VS Code crash for post-mortem diagnostics.
        'logsPath': vscodeLogsDir,
      },
    } as any)
  } as any],

  logLevel: 'info',
  bail: 0,
  baseUrl: '',
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,

  services: [
    'vscode'
  ],

  framework: 'mocha',
  maxInstances: 1,

  specFileRetries: 0,
  specFileRetriesDelay: 0,
  specFileRetriesDeferred: false,

  reporters: ['spec'],

  mochaOpts: {
    ui: 'bdd',
    timeout: 120000, // 2 min — enough for full diagnostics
  },

  onPrepare: function (_config, _capabilities) {
    console.log('Starting WebdriverIO CodeTracer Extension Tests...')

    // Create wdio-vscode-service cache directory to avoid ENOENT errors
    const cacheDir = path.join(__dirname, '.wdio-vscode-service')
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true })
      console.log('Created .wdio-vscode-service cache directory')
    }

    // Compile the extension
    try {
      console.log('Compiling CodeTracer extension (TypeScript only)...')
      execSync('npm run compile:ts', { cwd: __dirname, stdio: 'inherit' })
    } catch (e) {
      console.warn('Failed to compile CodeTracer extension:', e)
    }

    // Restore Nim-compiled ct_vscode.js (tsc overwrites out/ct_vscode.js with an empty stub)
    const nimCtVscode = path.join(__dirname, 'media', 'ct_vscode.js')
    const outCtVscode = path.join(__dirname, 'out', 'ct_vscode.js')
    if (fs.existsSync(nimCtVscode)) {
      fs.copyFileSync(nimCtVscode, outCtVscode)
      console.log('Restored Nim-compiled ct_vscode.js to out/')
    } else {
      console.warn('WARNING: media/ct_vscode.js not found — Nim backend will not be available')
    }

    // Create the test workspace directory if it doesn't exist
    const testProjectDir = path.resolve(__dirname, 'test', 'wdio', 'projects', 'stylus-test')
    if (!fs.existsSync(testProjectDir)) {
      fs.mkdirSync(testProjectDir, { recursive: true })
      console.log('Created test workspace directory:', testProjectDir)
    }
  },

  onWorkerStart: function (cid, _caps, _specs, _args, _execArgv) {
    console.log(`Starting worker ${cid} for CodeTracer extension testing`)
  },

  beforeSession: function (_capabilities, _specs, _browser) {
    console.log('CodeTracer Extension Test Session Started')
  },

  beforeSuite: function (suite) {
    console.log(`Starting test suite: ${suite.title}`)
  },

  afterTest: async function (test, _context, result) {
    // Capture diagnostics on test failure for all tests (individual specs
    // may also capture their own diagnostics in afterEach hooks)
    if (result.error) {
      const label = `FAIL-${test.title.replace(/\s+/g, '-').substring(0, 40)}`
      try {
        const diagDir = path.resolve(__dirname, 'test', 'wdio', 'diagnostics')
        if (!fs.existsSync(diagDir)) fs.mkdirSync(diagDir, { recursive: true })
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { browser } = require('@wdio/globals')
        await browser.saveScreenshot(path.join(diagDir, `screenshot-${label}.png`))
        console.log(`[diag] Failure screenshot: ${label}`)
      } catch (e: any) {
        console.log(`[diag] Failure screenshot failed: ${e.message?.substring(0, 80)}`)
      }
    }
  },

  afterSuite: function (suite) {
    console.log(`Completed test suite: ${suite.title}`)
  },

  onComplete: function (exitCode, _config, _capabilities, _results) {
    console.log('WebdriverIO CodeTracer Extension Tests Completed')
    if (exitCode !== 0) {
      console.log('Tests failed. Check the logs above for details.')
    }
  },

  onReload: function (_oldSessionId, _newSessionId) {
    console.log('VS Code session reloaded')
  }
}
