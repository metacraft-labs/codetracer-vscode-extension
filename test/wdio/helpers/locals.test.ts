/**
 * Unit tests for `locals.ts`, the exact-name matching WDIO specs use to check
 * variables in a `ct/load-locals` response.
 *
 * Run with `just test-wdio-helpers` (Node's built-in test runner, with the
 * `tsx` loader WDIO itself uses). The file is not a `*.e2e.ts` spec, so WDIO
 * does not collect it. No mocks: the functions are pure. The response bodies
 * below are trimmed copies of what CodeTracer's DAP server returned for the
 * Solidity FlowTest fixture (`a = 10` at line 14 in compute(), and the empty
 * response at the toplevel's first step).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { displayValue, findLocal, listLocals } from './locals'

/** A `ct/load-locals` entry as the DAP server sends it, trimmed to the fields read. */
function local(expression: string, value: Record<string, string>): Record<string, unknown> {
  const blank = { i: '', r: '', text: '', f: '', c: '' }
  return { address: -1, expression, value: { ...blank, ...value, kind: 7 } }
}

const IN_COMPUTE = {
  locals: [
    local('storedA', { r: '0xa' }),
    local('result', { i: '0' }),
    local('b', { i: '20' }),
    local('a', { i: '10' }),
  ],
}

test('the empty response lists nothing and does not match "a", although its JSON contains an "a"', () => {
  const empty = { locals: [] }
  assert.ok(JSON.stringify(empty).includes('a'), 'precondition: the vacuous substring check passes here')
  assert.deepEqual(listLocals(empty), [])
  assert.equal(findLocal(empty, 'a'), undefined)
})

test('names that merely contain the letter do not match "a"', () => {
  const noA = { locals: [local('storedA', { r: '0xa' }), local('result', { i: '0' }), local('Ab', { i: '1' })] }
  assert.equal(findLocal(noA, 'a'), undefined)
})

test('an exact "a" matches, with its displayed value', () => {
  assert.deepEqual(findLocal(IN_COMPUTE, 'a'), { name: 'a', value: '10' })
  assert.deepEqual(findLocal(IN_COMPUTE, 'storedA'), { name: 'storedA', value: '0xa' })
})

test('listLocals keeps response order and display values', () => {
  assert.deepEqual(listLocals(IN_COMPUTE), [
    { name: 'storedA', value: '0xa' },
    { name: 'result', value: '0' },
    { name: 'b', value: '20' },
    { name: 'a', value: '10' },
  ])
})

test('a local named by `name` instead of `expression` is still matched exactly', () => {
  assert.deepEqual(findLocal({ locals: [{ name: 'a', value: { i: '10' } }] }, 'a'), { name: 'a', value: '10' })
})

test('malformed responses and entries list nothing rather than throwing', () => {
  for (const response of [undefined, null, 'a', 42, {}, { locals: 'a' }, { locals: null }]) {
    assert.deepEqual(listLocals(response), [], `response ${JSON.stringify(response)}`)
    assert.equal(findLocal(response, 'a'), undefined)
  }
  assert.deepEqual(listLocals({ locals: [null, 'a', 7, { value: { i: '10' } }, { expression: '' }] }), [])
})

test('displayValue prefers the integer, then the raw word, then text, float and char', () => {
  assert.equal(displayValue({ i: '10', r: '0xa' }), '10')
  assert.equal(displayValue({ i: '', r: '0xa', text: 'x' }), '0xa')
  assert.equal(displayValue({ text: 'hello' }), 'hello')
  assert.equal(displayValue({ f: '1.5' }), '1.5')
  assert.equal(displayValue({ c: 'z' }), 'z')
  assert.equal(displayValue({ i: 10 }), '', 'a non-string field is not displayed')
  assert.equal(displayValue(undefined), '')
  assert.equal(displayValue('10'), '')
})
