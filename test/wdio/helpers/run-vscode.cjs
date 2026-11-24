#!/usr/bin/env node
/**
 * The program ChromeDriver starts as "the browser" when a test drives VS Code:
 * it starts VS Code with the arguments `wdio-vscode-service` prepared, and
 * passes VS Code's stdout and stderr straight through.
 *
 * Why it exists. `wdio-vscode-service` does not let ChromeDriver start VS Code
 * itself. Its worker's `beforeSession` sets `goog:chromeOptions.binary` to a
 * shim of its own, `wdio-vscode-service/dist/chromium/index.js`, which parses
 * its argv, takes VS Code's path from `--vscode-binary-path=...`, and starts
 * VS Code with `child_process.execFile(binaryPath, args, { env, cwd })`.
 * `execFile` buffers the child's output for its completion callback, up to
 * `maxBuffer` per stream, 1 MiB (1024 * 1024 bytes) by default; when either
 * stream passes it, Node kills the child with `killSignal`, SIGTERM by default
 * (https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback).
 * The shim sets no `maxBuffer`. So VS Code is sent SIGTERM as soon as it has
 * written a little over 1 MiB to stdout or to stderr, and it shuts down cleanly
 * in the middle of whatever the test is doing: ChromeDriver sees its targets
 * detach and the browser connection drop, and the next WebDriver command fails
 * with "no such window" or "invalid session id". A CodeTracer debug session
 * that logs its DAP traffic crosses 1 MiB in an ordinary long test. Checked
 * against `wdio-vscode-service` 6.1.4 (installed) and 8.0.0 (latest at the
 * time); both shims are the same in this respect.
 *
 * What it does. It loads the upstream shim as a module (the shim exports its
 * `run(process, execFile)` function when it is not the main module) and calls
 * it with an `execFile` that `spawn`s VS Code with `stdio: 'inherit'`. The
 * shim's own argument handling (yargs-parser with camel-case expansion and no
 * boolean negation, every option re-rendered as `--key` or `--key=value`,
 * then the positionals) therefore produces VS Code's argv exactly as before,
 * and only the output handling changes: VS Code writes to this process's
 * stdout and stderr, which are whatever ChromeDriver gave the browser, and
 * nothing buffers or limits them. Then it supervises the child:
 *
 * - VS Code's exit code becomes this process's exit code, and a signal that
 *   ended VS Code is raised on this process, so ChromeDriver sees the same
 *   ending it would see if it had started VS Code itself;
 * - SIGTERM, SIGINT and SIGHUP sent to this process (ChromeDriver ends the
 *   browser with SIGTERM) are forwarded to VS Code, so stopping the launcher
 *   stops VS Code. SIGKILL cannot be forwarded; after one, VS Code is
 *   orphaned exactly as it was under the upstream shim.
 *
 * It refuses, with a message naming what changed, when the upstream shim is
 * missing or no longer exports `run`, so a new `wdio-vscode-service` is noticed
 * rather than half-working. `vscode-launcher.cjs` points the capabilities at this
 * file, and refuses when the service did not set the shim it expects.
 *
 * It is a plain CommonJS script with a `node` shebang and the executable bit,
 * because ChromeDriver executes the binary it is given directly, as it executed
 * the upstream shim. Not used on Windows, where the service's shim is a
 * compiled `index.exe` (see `vscode-launcher.cjs`).
 */
'use strict'

const childProcess = require('node:child_process')
const os = require('node:os')
const path = require('node:path')

const TAG = '[run-vscode]'

/** The launcher `wdio-vscode-service` puts in `goog:chromeOptions.binary` on
 *  POSIX: `path.join(<the service's dist/>, 'chromium', 'index.js')`, as in
 *  its `dist/service.js` (`beforeSession`). Resolved from this repository's
 *  `node_modules`, the copy the tests import. */
function upstreamShimPath() {
  const serviceMain = require.resolve('wdio-vscode-service') // .../dist/index.js
  return path.join(path.dirname(serviceMain), 'chromium', 'index.js')
}

/** An `execFile` replacement for the shim's `run`: the same file, arguments,
 *  environment and working directory, with the child's stdio inherited instead
 *  of buffered. */
function passThroughExecFile(file, args, options) {
  return childProcess.spawn(file, args, { ...options, stdio: 'inherit' })
}

function fail(message) {
  process.stderr.write(`${TAG} ${message}\n`)
  process.exit(70)
}

/** Ends this process the way `child` ended: with its exit code, or by the
 *  signal that ended it. */
function endLike(code, signal) {
  if (signal) {
    process.kill(process.pid, signal)
    // A signal Node ignores or handles itself (SIGPIPE, for one) does not end
    // the process; end it with the shell's convention for "killed by" instead.
    setTimeout(() => process.exit(128 + (os.constants.signals[signal] || 0)), 1000).unref()
    return
  }
  process.exit(code === null ? 1 : code)
}

/** Forwards termination signals to `child` and ends this process when it ends. */
function supervise(child, file) {
  const forwarded = ['SIGTERM', 'SIGINT', 'SIGHUP']
  const handlers = forwarded.map((sig) => {
    const handler = () => {
      try {
        child.kill(sig)
      } catch (err) {
        process.stderr.write(`${TAG} could not forward ${sig} to ${file}: ${err.message}\n`)
      }
    }
    process.on(sig, handler)
    return [sig, handler]
  })
  child.on('error', (err) => {
    fail(`could not start ${file}: ${err.message}`)
  })
  child.on('exit', (code, signal) => {
    // Our handlers go first, so a signal re-raised below takes its default
    // action (ending this process) instead of being forwarded to a dead child.
    for (const [sig, handler] of handlers) {
      process.removeListener(sig, handler)
    }
    endLike(code, signal)
  })
}

function main() {
  const shim = upstreamShimPath()
  let run
  try {
    run = require(shim)
  } catch (err) {
    fail(`cannot load wdio-vscode-service's VS Code launcher ${shim}: ${err.message}`)
  }
  if (typeof run !== 'function') {
    fail(`${shim} no longer exports its run(process, execFile) function; ` +
      'wdio-vscode-service changed how it starts VS Code, so update this launcher to match.')
  }
  let started
  const execFile = (file, args, options) => {
    started = { file, child: passThroughExecFile(file, args, options) }
    return started.child
  }
  try {
    run(process, execFile)
  } catch (err) {
    fail(err.message)
  }
  if (!started) {
    fail(`${shim} returned without starting VS Code`)
  }
  supervise(started.child, started.file)
}

if (require.main === module) {
  main()
} else {
  module.exports = { upstreamShimPath, passThroughExecFile }
}
