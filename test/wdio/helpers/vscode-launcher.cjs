/**
 * Points a VS Code session's capabilities at this repository's VS Code
 * launcher, `run-vscode.cjs`, instead of `wdio-vscode-service`'s.
 *
 * `wdio-vscode-service`'s worker `beforeSession` turns the `vscode` capability
 * into a Chromium one whose `goog:chromeOptions.binary` is the service's shim
 * (`wdio-vscode-service/dist/chromium/index.js`). That shim starts VS Code with
 * Node's `execFile` and its default 1 MiB output buffer, so VS Code is sent
 * SIGTERM once it has logged a little over 1 MiB, in the middle of a test
 * (https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback).
 * `run-vscode.cjs` explains the failure and the replacement in full; it
 * produces the same VS Code argv and passes VS Code's output through unlimited.
 *
 * Every way this repository starts VS Code for a test goes through
 * `useRepoVSCodeLauncher`, called on the capabilities right after the
 * service's `beforeSession`: the scenario binding
 * (`test/scenarios/codetracer-binding.ts`) calls it directly, and the WDIO
 * suite gets it from the service wrapper in `vscode-service.mts`.
 *
 * It is plain CommonJS JavaScript, typed by `vscode-launcher.d.cts`, because
 * its two callers load modules differently: the WDIO suite through tsx, and
 * the scenario binding through Node's own TypeScript type stripping (the
 * arm runs `node main.ts`), which neither maps a `.js` specifier to a `.ts`
 * file nor gives an ES module `require` or `__dirname`. A `.cjs` file is
 * loaded the same way by both.
 *
 * It refuses, instead of passing the capabilities on unchanged, when they do
 * not name the shim it expects: a `wdio-vscode-service` that starts VS Code
 * some other way must be looked at, not silently run with the old limit or
 * with a launcher that no longer matches it. Checked against
 * `wdio-vscode-service` 6.1.4 (installed) and 8.0.0.
 */
'use strict'

const path = require('node:path')
// It exports its helpers when it is not the main module.
const runVSCode = require('./run-vscode.cjs')

/** This repository's VS Code launcher, the file ChromeDriver is to execute. */
const REPO_VSCODE_LAUNCHER = path.join(__dirname, 'run-vscode.cjs')

/** The launcher `wdio-vscode-service` sets as the browser binary. */
function upstreamVSCodeShim() {
  return runVSCode.upstreamShimPath()
}

/** Replaces the service's VS Code launcher in `caps` (as left by the
 *  service's `beforeSession`) with `REPO_VSCODE_LAUNCHER`, in place, and
 *  returns `caps`. Every other capability, the launch arguments included, is
 *  left as the service set it. Throws when `caps` does not name the
 *  service's shim. */
function useRepoVSCodeLauncher(caps) {
  const what = 'cannot start VS Code through this repository\'s launcher (test/wdio/helpers/run-vscode.cjs)'
  if (process.platform === 'win32') {
    // The service starts VS Code through a compiled `index.exe` there, and
    // ChromeDriver cannot execute a node script in its place.
    throw new Error(`${what}: not supported on Windows, where wdio-vscode-service's launcher is index.exe`)
  }
  const chrome = caps?.['goog:chromeOptions']
  if (!chrome || typeof chrome.binary !== 'string') {
    throw new Error(`${what}: the capabilities have no goog:chromeOptions.binary; ` +
      'call this after wdio-vscode-service\'s beforeSession, on a desktop VS Code capability')
  }
  const expected = upstreamVSCodeShim()
  if (path.resolve(chrome.binary) !== expected) {
    throw new Error(`${what}: wdio-vscode-service set the browser binary to ${chrome.binary}, ` +
      `not the launcher this repository replaces (${expected}); the service has changed how it starts VS Code`)
  }
  chrome.binary = REPO_VSCODE_LAUNCHER
  return caps
}

module.exports = { REPO_VSCODE_LAUNCHER, upstreamVSCodeShim, useRepoVSCodeLauncher }
