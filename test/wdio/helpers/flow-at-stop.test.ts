/**
 * Unit tests for `flow-at-stop.ts`: the `ct/load-flow` arguments `loadFlow`
 * builds from the session's last `ct/complete-move`, and the check that a
 * `FlowUpdate` belongs to the stop.
 *
 * Run with `just test-wdio-helpers` (Node's built-in test runner, with the
 * `tsx` loader WDIO itself uses). The file is not a `*.e2e.ts` spec, so WDIO
 * does not collect it. No mocks: the functions are pure. The locations and
 * flows below are hand-written in the shape of the replay server's
 * `ct/complete-move` location and `FlowUpdate` (codetracer
 * `src/db-backend/src/task.rs`), for the Solidity FlowTest program stopped at
 * the compute() breakpoint (line 14). The step-0 case is the one measured on
 * the Stylus fixture: stopped in `fund` (call 3, step 6, line 59), a zeroed
 * location was answered with the flow of `new` (call 0, step 0, line 49).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkFlowAtStop, loadFlowArguments, type TrackedMove } from './flow-at-stop'

const COMPUTE_PATH = '/fixtures/FlowTest.sol'

/** The `ct/complete-move` location at the compute() breakpoint. */
const AT_COMPUTE_BREAKPOINT: TrackedMove = {
  moves: 3,
  location: {
    path: COMPUTE_PATH, line: 14, rrTicks: 21, callstackDepth: 1,
    functionName: 'compute', key: '1',
  },
}

/** The DAP stop at the same place (`DebugSession.currentStop()`). */
const COMPUTE_STOP = { line: 14, frame: 'compute' }

function flowUpdate(functionName: string, key: string, rrTicks: number, lines: number[]): any {
  const location = { path: COMPUTE_PATH, line: lines[0], functionName, key, rrTicks }
  return {
    location,
    viewUpdates: [{ location, steps: lines.map((position, i) => ({ position, rrTicks: rrTicks + i })) }],
    error: false,
    errorMessage: '',
    finished: true,
    mode: 'call',
  }
}

/** compute()'s flow: the call begins at step 18 and visits lines 12-16. */
const COMPUTE_FLOW = flowUpdate('compute', '1', 18, [12, 13, 14, 15, 16])
/** The flow served for a zeroed location: the call containing step 0. */
const TOPLEVEL_FLOW = flowUpdate('<toplevel>', '0', 0, [1, 2, 3])

test('loadFlow refuses to build arguments before any move was observed', () => {
  assert.throws(() => loadFlowArguments(0, undefined), /no ct\/complete-move has been observed/)
  assert.throws(() => loadFlowArguments(0, { moves: 0, location: {} }), /no ct\/complete-move has been observed/)
})

test('loadFlow refuses a move that carries no step', () => {
  assert.throws(
    () => loadFlowArguments(0, { moves: 1, location: { path: COMPUTE_PATH, line: 14 } }),
    /carries no step/,
  )
  assert.throws(
    () => loadFlowArguments(0, { moves: 1, location: { path: COMPUTE_PATH, line: 14, rrTicks: -1 } }),
    /carries no step/,
  )
})

test('the arguments carry the stop, as the extension\'s FlowVM sends them', () => {
  assert.deepEqual(loadFlowArguments(0, AT_COMPUTE_BREAKPOINT), {
    flowMode: 0,
    location: { path: COMPUTE_PATH, line: 14, rrTicks: 21, callstackDepth: 1 },
  })
})

test('a stop at step 0 is a stop: its step is sent, not refused', () => {
  const atStart: TrackedMove = { moves: 1, location: { path: COMPUTE_PATH, line: 1, rrTicks: 0 } }
  assert.deepEqual(loadFlowArguments('call', atStart).location, {
    path: COMPUTE_PATH, line: 1, rrTicks: 0, callstackDepth: 0,
  })
})

test('the flow of the stop\'s call belongs to the stop', () => {
  const report = checkFlowAtStop(COMPUTE_FLOW, COMPUTE_STOP, AT_COMPUTE_BREAKPOINT)
  assert.deepEqual(report.mismatches, [])
  assert.equal(report.flowFunction, 'compute')
  assert.deepEqual(report.flowLines, [12, 13, 14, 15, 16])
})

test('the step-0 flow does not belong to a stop in compute(), though it is non-empty', () => {
  assert.ok(JSON.stringify(TOPLEVEL_FLOW).length > 2, 'precondition: the vacuous non-empty check passes here')
  const report = checkFlowAtStop(TOPLEVEL_FLOW, COMPUTE_STOP, AT_COMPUTE_BREAKPOINT)
  assert.equal(report.mismatches.length, 3, report.mismatches.join('\n'))
  assert.match(report.mismatches[0], /the flow is of '<toplevel>', but the session is stopped in 'compute'/)
  assert.match(report.mismatches[1], /call 0, but the session is stopped in call 1/)
  assert.match(report.mismatches[2], /line 14 is not among the flow's step lines \[1, 2, 3\]/)
})

test('another activation of the same function is told apart by its call key', () => {
  const otherCall = flowUpdate('compute', '7', 18, [12, 13, 14, 15, 16])
  const report = checkFlowAtStop(otherCall, COMPUTE_STOP, AT_COMPUTE_BREAKPOINT)
  assert.deepEqual(report.mismatches, ['the flow is of call 7, but the session is stopped in call 1'])
})

test('a move the session has since left is not the stop, even when its flow is consistent with it', () => {
  // The tracker last heard a move to line 13 of the same call, but DAP now
  // reports line 14: a move was missed, so the request did not name the
  // stop. The flow, key and step agree with the stale move, so only the
  // move/stop comparison catches it.
  const stale: TrackedMove = {
    moves: 2,
    location: { ...AT_COMPUTE_BREAKPOINT.location, line: 13, rrTicks: 20 },
  }
  const report = checkFlowAtStop(COMPUTE_FLOW, COMPUTE_STOP, stale)
  assert.deepEqual(report.mismatches, [
    'the last ct/complete-move is at line 13, but DAP reports the stop at line 14: ' +
    'the flow was requested for a stop the session is no longer at',
  ])
})

test('a call that begins after the stop is not the stop\'s', () => {
  const later = flowUpdate('compute', '', 40, [12, 13, 14])
  const report = checkFlowAtStop(later, COMPUTE_STOP, AT_COMPUTE_BREAKPOINT)
  assert.deepEqual(report.mismatches, ["the flow's call begins at step 40, after the stop's step 21"])
})

test('an error update, a missing flow and a stop without a frame are mismatches', () => {
  const error = { location: {}, viewUpdates: [], error: true, errorMessage: 'no call at step 21' }
  assert.match(checkFlowAtStop(error, COMPUTE_STOP, AT_COMPUTE_BREAKPOINT).mismatches[0], /an error: no call at step 21/)
  assert.match(checkFlowAtStop(undefined, COMPUTE_STOP, AT_COMPUTE_BREAKPOINT).mismatches[0], /no flow was delivered/)
  assert.ok(
    checkFlowAtStop(COMPUTE_FLOW, { line: 14, frame: '' }, AT_COMPUTE_BREAKPOINT).mismatches
      .some(m => /no frame name/.test(m)),
  )
  assert.ok(
    checkFlowAtStop(COMPUTE_FLOW, COMPUTE_STOP, undefined).mismatches.some(m => /reported the stop's step/.test(m)),
  )
})

test('the view update\'s location is used when the envelope has none', () => {
  const { location: _dropped, ...withoutEnvelope } = COMPUTE_FLOW
  assert.deepEqual(checkFlowAtStop(withoutEnvelope, COMPUTE_STOP, AT_COMPUTE_BREAKPOINT).mismatches, [])
})
