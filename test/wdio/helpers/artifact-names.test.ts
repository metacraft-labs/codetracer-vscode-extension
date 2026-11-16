/**
 * Unit tests for `artifact-names.ts`, the file names WDIO diagnostics are
 * written under.
 *
 * Run with `just test-wdio-helpers` (Node's built-in test runner, with the
 * `tsx` loader WDIO itself uses). The file is not a `*.e2e.ts` spec, so WDIO
 * does not collect it. No mocks: the functions are pure, and the last test
 * writes the produced names to a real temporary directory.
 *
 * The forbidden set is the one `actions/upload-artifact` rejects a whole
 * artifact for (https://github.com/actions/toolkit/blob/main/packages/artifact/src/internal/upload/path-and-artifact-name-validation.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_ARTIFACT_NAME_MAX_LENGTH, artifactFileName, artifactSafeName,
} from './artifact-names'

const UPLOAD_ARTIFACT_FORBIDDEN = ['"', ':', '<', '>', '|', '*', '?', '\r', '\n']
const PORTABLE = /^[A-Za-z0-9._-]+$/

function assertPortable(name: string): void {
  assert.match(name, PORTABLE, `not portable: ${JSON.stringify(name)}`)
  for (const ch of UPLOAD_ARTIFACT_FORBIDDEN) {
    assert.ok(!name.includes(ch), `${JSON.stringify(name)} contains ${JSON.stringify(ch)}`)
  }
  assert.ok(!name.includes('/') && !name.includes('\\'), `${name} contains a path separator`)
  assert.ok(!name.startsWith('.'), `${name} is hidden or a dot entry`)
}

test('the title that lost a run its diagnostics gets a portable name', () => {
  const name = artifactFileName('screenshot-FAIL-event log contains "result".png')
  assertPortable(name)
  assert.ok(name.endsWith('.png'))
  assert.ok(name.startsWith('screenshot-FAIL-event-log-contains-result-'), name)
})

test('each forbidden character, a slash and a backslash are replaced', () => {
  for (const ch of [...UPLOAD_ARTIFACT_FORBIDDEN, '/', '\\', '\t', '\u0000', 'é']) {
    const name = artifactFileName(`screenshot-a${ch}b.png`)
    assertPortable(name)
    assert.ok(name.startsWith('screenshot-a-b-'), `${JSON.stringify(ch)} -> ${name}`)
    assert.ok(name.endsWith('.png'))
  }
})

test('a title with every forbidden character at once', () => {
  const label = `FAIL-${UPLOAD_ARTIFACT_FORBIDDEN.join('x')}/..\\x`
  assertPortable(artifactSafeName(label))
})

test('a name that is already safe is returned unchanged', () => {
  for (const name of [
    'screenshot-solana-opens-solana_flow_test.rs-in-the-editor.png',
    'dap-state-solana-before-locals.json',
    'locals.json',
  ]) {
    assert.equal(artifactFileName(name), name)
  }
})

test('names stay unique when sanitising or truncating makes them collide', () => {
  // Same text once the unsafe characters are replaced.
  const a = artifactSafeName('contains "result"')
  const b = artifactSafeName('contains <result>')
  const c = artifactSafeName('contains-result')
  assert.notEqual(a, b)
  assert.notEqual(a, c)
  assert.notEqual(b, c)
  // Same first DEFAULT_ARTIFACT_NAME_MAX_LENGTH characters.
  const prefix = 'x'.repeat(DEFAULT_ARTIFACT_NAME_MAX_LENGTH)
  assert.notEqual(artifactSafeName(`${prefix}-one`), artifactSafeName(`${prefix}-two`))
  // Deterministic: the same label always maps to the same name.
  assert.equal(artifactSafeName('contains "result"'), a)
})

test('the length limit holds and keeps the extension', () => {
  const long = `screenshot-${'a very long test title '.repeat(20)}.png`
  const name = artifactFileName(long)
  assertPortable(name)
  assert.ok(name.endsWith('.png'))
  assert.ok(name.length <= DEFAULT_ARTIFACT_NAME_MAX_LENGTH + '.png'.length, `${name.length}`)
  assert.ok(artifactSafeName('b'.repeat(500), 20).length <= 20)
})

test('dot entries, hidden names and empty labels never come back', () => {
  for (const label of ['', '.', '..', '...', '"', '/', '.hidden', '..\\..\\x']) {
    const name = artifactSafeName(label)
    assertPortable(name)
    assert.notEqual(name, '.')
    assert.notEqual(name, '..')
  }
  assert.match(artifactSafeName('???'), /^unnamed-[0-9a-f]{8}$/)
})

test('an unusable maxLength is refused', () => {
  assert.throws(() => artifactSafeName('x', 5), RangeError)
  assert.throws(() => artifactSafeName('x', 12.5), RangeError)
})

test('the names can be created as files directly in the directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-names-'))
  try {
    const labels = [
      'screenshot-FAIL-event log contains "result".png',
      'browser-console-a/b/../../c.json',
      'exthost-log-C:\\Users\\x.json',
    ]
    const names = labels.map((l) => artifactFileName(l))
    for (const name of names) {
      fs.writeFileSync(path.join(dir, name), 'x')
    }
    assert.deepEqual(fs.readdirSync(dir).sort(), [...names].sort())
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
