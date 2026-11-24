/**
 * Tests for the VS Code launcher the WDIO suite and the scenario binding use:
 * `run-vscode.cjs` (the program ChromeDriver starts as the browser),
 * `vscode-launcher.cjs` (which points the capabilities at it) and
 * `vscode-service.mts` (the service wrapper the WDIO suite registers).
 *
 * Run with `just test-wdio-helpers` (Node's built-in test runner, with the
 * `tsx` loader WDIO itself uses). The file is not a `*.e2e.ts` spec, so WDIO
 * does not collect it.
 *
 * The capabilities come from the real `wdio-vscode-service` worker's
 * `beforeSession`, as in the scenario binding, and the launcher they name is
 * executed the way ChromeDriver executes a browser binary: directly, with the
 * capability's arguments (plus a few arguments of ChromeDriver's own).
 *
 * One stand-in, justified: VS Code itself is replaced by a small node script
 * written to a temporary directory. What is under test is what the launcher
 * does with the process it starts (its argv, its output, its ending), and a
 * real VS Code neither writes a chosen amount of output on demand nor ends
 * with a chosen status; it would also need a display and minutes per case. The
 * stand-in writes a chosen number of bytes to stdout and to stderr, records
 * its argv and whether it finished, and then exits by itself with a chosen
 * code or signal (or waits, to be stopped). The service's VS Code proxy is
 * disabled in these capabilities because nothing here connects to it; that
 * option changes only VS Code's user settings, not the launcher or its
 * arguments.
 *
 * The first test is the reproduction of the defect this launcher fixes: under
 * `wdio-vscode-service`'s own launcher, Node's `execFile` 1 MiB output limit
 * sends SIGTERM to a VS Code that has written more than that
 * (https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback).
 */
import { after, test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { REPO_VSCODE_LAUNCHER, upstreamVSCodeShim, useRepoVSCodeLauncher } from './vscode-launcher.cjs'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const MiB = 1024 * 1024

/** Arguments ChromeDriver adds to the capability's own when it starts the
 *  browser: switches, a `--key=value`, and the initial URL as a positional. */
const CHROMEDRIVER_ARGS = ['--remote-debugging-port=0', '--no-first-run', '--test-type=webdriver', '--log-level=0', 'data:,']

/** The bytes the stand-in writes to `stream`: numbered lines, so a truncated
 *  or reordered copy does not compare equal. JavaScript source, because the
 *  stand-in runs it too. */
const PAYLOAD_SOURCE = `function payload(stream, total) {
  const lines = []
  let size = 0
  for (let i = 0; size < total; i++) {
    const line = stream + ' line ' + String(i).padStart(8, '0') + ' ' + 'x'.repeat(40) + '\\n'
    lines.push(line)
    size += line.length
  }
  return Buffer.from(lines.join('')).subarray(0, total)
}`
const payload = new Function(`${PAYLOAD_SOURCE}\nreturn payload`)() as (stream: string, total: number) => Buffer

/** The stand-in VS Code. Environment:
 *  STANDIN_DIR (required) where it records `argv.json`, `pid` and `ending`;
 *  STANDIN_BYTES bytes to write to each of stdout and stderr (default 0);
 *  STANDIN_EXIT the exit code; STANDIN_SIGNAL a signal to end itself with;
 *  STANDIN_HANG=1 to wait until it is stopped. `ending` reads `finished`
 *  once all its output was written; a SIGTERM is recorded there as
 *  `SIGTERM after <n> bytes` (of stdout and stderr together), and then ends it. */
const STANDIN_SOURCE = `
const fs = require('node:fs')
const path = require('node:path')
const dir = process.env.STANDIN_DIR
fs.writeFileSync(path.join(dir, 'argv.json'), JSON.stringify(process.argv.slice(2)))
fs.writeFileSync(path.join(dir, 'pid'), String(process.pid))
let written = 0
process.on('SIGTERM', () => {
  fs.writeFileSync(path.join(dir, 'ending'), 'SIGTERM after ' + written + ' bytes')
  // End by the signal, as a process without the handler would.
  process.removeAllListeners('SIGTERM')
  process.kill(process.pid, 'SIGTERM')
})
${PAYLOAD_SOURCE}
async function main() {
  const total = Number(process.env.STANDIN_BYTES || 0)
  const out = payload('stdout', total)
  const err = payload('stderr', total)
  const chunk = 64 * 1024
  for (let at = 0; at < total; at += chunk) {
    for (const [fd, data] of [[1, out], [2, err]]) {
      try {
        fs.writeSync(fd, data.subarray(at, at + chunk))
        written += Math.min(chunk, total - at)
      } catch (e) {
        // EPIPE: the reader went away; wait for whatever ends this process.
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
    // Yield, so a signal handler can run between chunks.
    await new Promise((r) => setImmediate(r))
  }
  fs.writeFileSync(path.join(dir, 'ending'), 'finished')
  if (process.env.STANDIN_HANG === '1') {
    setInterval(() => {}, 1000)
    return
  }
  if (process.env.STANDIN_SIGNAL) {
    process.removeAllListeners('SIGTERM')
    process.kill(process.pid, process.env.STANDIN_SIGNAL)
    return
  }
  process.exit(Number(process.env.STANDIN_EXIT || 0))
}
main()
`


/** Every case gets a time limit: a launcher that stops forwarding signals or
 *  ending with VS Code would otherwise hang the suite instead of failing it. */
const CASE_TIMEOUT_MS = 300_000
const test = (name: string, fn: () => void | Promise<void>): void => { nodeTest(name, { timeout: CASE_TIMEOUT_MS }, fn) }

/** The temporary directories the cases make, removed when the file is done. */
const tempDirs: string[] = []
after(() => {
  for (const dir of tempDirs) { fs.rmSync(dir, { recursive: true, force: true }) }
})

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ct-run-vscode-${label}-`))
  tempDirs.push(dir)
  return dir
}

/** A stand-in VS Code executable in a fresh directory, which is also its
 *  STANDIN_DIR. */
function makeStandIn(): { binary: string; dir: string } {
  const dir = tempDir('standin')
  const binary = path.join(dir, 'code')
  fs.writeFileSync(binary, `#!/usr/bin/env node\n${STANDIN_SOURCE}`)
  fs.chmodSync(binary, 0o755)
  return { binary, dir }
}

/** Capabilities as the scenario binding builds them, after the real service
 *  worker's `beforeSession`. */
async function serviceCapabilities(vscodeBinary: string): Promise<any> {
  const service: any = await import('wdio-vscode-service')
  const storage = tempDir('storage')
  const workspace = path.join(storage, 'workspace')
  fs.mkdirSync(workspace)
  const caps: any = {
    browserName: 'vscode',
    browserVersion: 'stable',
    'wdio:enforceWebDriverClassic': true,
    'wdio:vscodeOptions': {
      binary: vscodeBinary,
      extensionPath: REPO_ROOT,
      workspacePath: workspace,
      storagePath: storage,
      userSettings: { 'workbench.startupEditor': 'none' },
      vscodeProxyOptions: { enable: false },
      vscodeArgs: {
        disableExtensions: false,
        disableTelemetry: true,
        enableProposedApi: 'metacraft-labs.ct-vscode',
        noZygote: true,
        disableDevShmUsage: true,
        disableGpu: true,
        disableGpuCompositing: true,
      },
    },
  }
  const worker = new service.default({}, caps)
  await worker.beforeSession({}, caps)
  return caps
}

interface Ending { code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer }

/** Executes `binary` as ChromeDriver does, collecting all of its output. */
function execute(binary: string, args: string[], env: Record<string, string>,
  onStart?: (child: ReturnType<typeof spawn>) => void): Promise<Ending> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (b: Buffer) => out.push(b))
    child.stderr.on('data', (b: Buffer) => err.push(b))
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }))
    onStart?.(child)
  })
}

/** Runs whatever launcher `caps` names against the stand-in. */
function launch(caps: any, standInDir: string, env: Record<string, string> = {},
  onStart?: (child: ReturnType<typeof spawn>) => void): Promise<Ending> {
  const chrome = caps['goog:chromeOptions']
  return execute(chrome.binary, [...chrome.args, ...CHROMEDRIVER_ARGS], { STANDIN_DIR: standInDir, ...env }, onStart)
}

function readIfThere(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : undefined
}

async function waitFor(file: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) { throw new Error(`timed out waiting for ${file}`) }
    await new Promise((r) => setTimeout(r, 25))
  }
}

test('a VS Code that writes 4 MiB to stdout and to stderr runs to its own end, with its output intact', async () => {
  const standIn = makeStandIn()
  const caps = useRepoVSCodeLauncher(await serviceCapabilities(standIn.binary))
  const bytes = 4 * MiB
  const ended = await launch(caps, standIn.dir, { STANDIN_BYTES: String(bytes) })
  assert.equal(readIfThere(path.join(standIn.dir, 'ending')), 'finished',
    `VS Code was ended by its launcher (${caps['goog:chromeOptions'].binary}) before it finished writing its output`)
  assert.deepEqual({ code: ended.code, signal: ended.signal }, { code: 0, signal: null })
  assert.ok(ended.stderr.equals(payload('stderr', bytes)), `stderr is not VS Code's stderr (${ended.stderr.length} bytes)`)
  assert.ok(ended.stdout.includes(payload('stdout', bytes)), `stdout does not hold VS Code's stdout (${ended.stdout.length} bytes)`)
})

test('the launcher passes VS Code the arguments wdio-vscode-service\'s own launcher passes', async () => {
  const standIn = makeStandIn()
  const caps = await serviceCapabilities(standIn.binary)
  assert.equal(caps['goog:chromeOptions'].binary, upstreamVSCodeShim())
  const viaUpstream = await launch(caps, standIn.dir)
  assert.deepEqual({ code: viaUpstream.code, signal: viaUpstream.signal }, { code: 0, signal: null })
  const upstreamArgv = JSON.parse(fs.readFileSync(path.join(standIn.dir, 'argv.json'), 'utf-8'))

  fs.rmSync(path.join(standIn.dir, 'argv.json'))
  const viaRepo = await launch(useRepoVSCodeLauncher(caps), standIn.dir)
  assert.deepEqual({ code: viaRepo.code, signal: viaRepo.signal }, { code: 0, signal: null })
  const repoArgv = JSON.parse(fs.readFileSync(path.join(standIn.dir, 'argv.json'), 'utf-8'))

  assert.deepEqual(repoArgv, upstreamArgv)
  // The cases the argv covers: a `--key=value`, a switch, a false boolean,
  // and ChromeDriver's positional URL last.
  assert.ok(repoArgv.includes(`--extension-development-path=${REPO_ROOT}`), JSON.stringify(repoArgv))
  assert.ok(repoArgv.includes('--disable-gpu'), JSON.stringify(repoArgv))
  assert.ok(repoArgv.includes('--disable-extensions=false'), JSON.stringify(repoArgv))
  assert.equal(repoArgv.at(-1), 'data:,')
})

test('VS Code\'s exit code becomes the launcher\'s', async () => {
  const standIn = makeStandIn()
  const caps = useRepoVSCodeLauncher(await serviceCapabilities(standIn.binary))
  const ended = await launch(caps, standIn.dir, { STANDIN_EXIT: '7' })
  assert.deepEqual({ code: ended.code, signal: ended.signal }, { code: 7, signal: null })
})

test('a signal that ends VS Code ends the launcher', async () => {
  const standIn = makeStandIn()
  const caps = useRepoVSCodeLauncher(await serviceCapabilities(standIn.binary))
  const ended = await launch(caps, standIn.dir, { STANDIN_SIGNAL: 'SIGKILL' })
  assert.deepEqual({ code: ended.code, signal: ended.signal }, { code: null, signal: 'SIGKILL' })
})

test('SIGTERM to the launcher ends VS Code, and then the launcher', async () => {
  const standIn = makeStandIn()
  const caps = useRepoVSCodeLauncher(await serviceCapabilities(standIn.binary))
  const pidFile = path.join(standIn.dir, 'pid')
  const ended = await launch(caps, standIn.dir, { STANDIN_HANG: '1' }, (launcher) => {
    waitFor(path.join(standIn.dir, 'ending')).then(() => launcher.kill('SIGTERM'), (e) => { launcher.kill('SIGKILL'); throw e })
  })
  assert.equal(readIfThere(path.join(standIn.dir, 'ending')), 'SIGTERM after 0 bytes')
  assert.deepEqual({ code: ended.code, signal: ended.signal }, { code: null, signal: 'SIGTERM' })
  const pid = Number(fs.readFileSync(pidFile, 'utf-8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `VS Code (pid ${pid}) outlived its launcher`)
})

test('the launcher refuses to start without --vscode-binary-path, naming it', async () => {
  const ended = await execute(REPO_VSCODE_LAUNCHER, ['--folder-uri=file:/tmp'], {})
  assert.equal(ended.code, 70)
  assert.match(ended.stderr.toString(), /\[run-vscode\] Missing parameter "--vscode-binary-path=/)
})

test('the launcher reports a VS Code it cannot start', async () => {
  const missing = path.join(tempDir('missing'), 'no-such-code')
  const ended = await execute(REPO_VSCODE_LAUNCHER, [`--vscode-binary-path=${missing}`], {})
  assert.equal(ended.code, 70)
  assert.match(ended.stderr.toString(), new RegExp(`could not start ${missing}: .*ENOENT`))
})

test('useRepoVSCodeLauncher changes only the binary', async () => {
  const caps = await serviceCapabilities('/nonexistent/code')
  const before = structuredClone(caps)
  useRepoVSCodeLauncher(caps)
  assert.equal(caps['goog:chromeOptions'].binary, REPO_VSCODE_LAUNCHER)
  before['goog:chromeOptions'].binary = REPO_VSCODE_LAUNCHER
  assert.deepEqual(caps, before)
})

test('useRepoVSCodeLauncher refuses a binary that is not wdio-vscode-service\'s launcher', async () => {
  const caps = await serviceCapabilities('/nonexistent/code')
  caps['goog:chromeOptions'].binary = '/usr/bin/google-chrome'
  assert.throws(() => useRepoVSCodeLauncher(caps),
    /set the browser binary to \/usr\/bin\/google-chrome, not the launcher this repository replaces .*chromium\/index\.js/)
  assert.equal(caps['goog:chromeOptions'].binary, '/usr/bin/google-chrome')
})

test('useRepoVSCodeLauncher refuses capabilities the service has not prepared', () => {
  assert.throws(() => useRepoVSCodeLauncher({ browserName: 'vscode', 'wdio:vscodeOptions': {} }),
    /no goog:chromeOptions\.binary; call this after wdio-vscode-service's beforeSession/)
})

test('the WDIO service wrapper points a VS Code capability at the launcher, and keeps the service\'s launcher service', async () => {
  const wrapper: any = await import('./vscode-service.mjs')
  const service: any = await import('wdio-vscode-service')
  assert.equal(wrapper.launcher, service.launcher)
  const caps: any = {
    browserName: 'vscode',
    browserVersion: 'stable',
    'wdio:vscodeOptions': {
      binary: '/nonexistent/code',
      extensionPath: REPO_ROOT,
      storagePath: tempDir('storage'),
      vscodeProxyOptions: { enable: false },
    },
  }
  await new wrapper.default({}, caps).beforeSession({}, caps)
  assert.equal(caps['goog:chromeOptions'].binary, REPO_VSCODE_LAUNCHER)
  assert.ok(caps['goog:chromeOptions'].args.includes('--vscode-binary-path=/nonexistent/code'))

  const other: any = { browserName: 'firefox' }
  await new wrapper.default({}, other).beforeSession({}, other)
  assert.deepEqual(other, { browserName: 'firefox' })
})
