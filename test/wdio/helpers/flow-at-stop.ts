/**
 * The flow of the session's current stop: what `loadFlow` sends as
 * `ct/load-flow`'s location, and how a spec checks that the flow it got back
 * belongs to that stop.
 *
 * Pure functions, so `flow-at-stop.test.ts` can run them under Node without
 * VS Code (`just test-wdio-helpers`). The WDIO side (tracking the moves in the
 * extension host, sending the request, reading the stop) is in
 * `dap-client.ts`.
 *
 * Why the stop comes from `ct/complete-move`: DAP's `stackTrace` carries the
 * stop's file, line and function, but not its step (`rrTicks`), and a frame's
 * `id` is a call key on a materialized trace and an index on a replayed one.
 * The replay server reports every stop on the `ct/complete-move` event, whose
 * body is a `MoveState` with the stop's `Location` (codetracer
 * `src/db-backend/src/task.rs`). The extension's own flow pane is fed the same
 * way: `DebuggerSession.followBackendMoves` adopts that location into the
 * store, and `FlowVM.requestWindow` (codetracer
 * `src/frontend/viewmodel/viewmodels/flow_vm.nim`) sends `ct/load-flow` with
 * its `path`, `line`, `rrTicks` and `callstackDepth`. `loadFlowArguments`
 * builds the same payload.
 *
 * Why there is no fallback location: with `rrTicks: 0` and no function bounds
 * the replay server serves the flow of the call that contains step 0 (on a
 * materialized trace, `load_flow` in `dap_handler.rs` takes `StepId(rrTicks)`),
 * normally `<toplevel>`, wherever the session is stopped. A spec that asked for
 * the current position's flow then passed on a flow of a different call.
 */

/** The `Location` fields of a `ct/complete-move` body that these helpers read. */
export interface StopLocation {
  path?: string
  line?: number
  rrTicks?: number
  callstackDepth?: number
  functionName?: string
  /** The call key of the stop's call, as a string (`""` when the backend has none). */
  key?: string
}

/** The last move the extension host heard from the adapter in this session. */
export interface TrackedMove {
  /** `MoveState.location` of the last `ct/complete-move`. */
  location: StopLocation
  /** How many `ct/complete-move` events this session has reported. */
  moves: number
}

/** `CtLoadFlowArguments` as `loadFlow` sends it. */
export interface LoadFlowArguments {
  flowMode: number | string
  location: { path: string; line: number; rrTicks: number; callstackDepth: number }
}

/**
 * The `ct/load-flow` arguments for the stop `move` reports.
 *
 * Throws when no move has been observed, or when the move carries no step:
 * a flow request without the stop's step would be answered with some other
 * call's flow (see the module comment), so it is never sent.
 */
export function loadFlowArguments(flowMode: number | string, move: TrackedMove | undefined): LoadFlowArguments {
  if (!move || move.moves <= 0 || !move.location) {
    throw new Error(
      'loadFlow: no ct/complete-move has been observed in this debug session, so the current stop is unknown; ' +
      'start the session with startDebugSession() (it installs the move tracker) and wait for it to stop',
    )
  }
  const loc = move.location
  if (typeof loc.rrTicks !== 'number' || !Number.isFinite(loc.rrTicks) || loc.rrTicks < 0) {
    throw new Error(`loadFlow: the last ct/complete-move carries no step (rrTicks): ${JSON.stringify(loc)}`)
  }
  return {
    flowMode,
    location: {
      path: typeof loc.path === 'string' ? loc.path : '',
      line: typeof loc.line === 'number' ? loc.line : 0,
      rrTicks: loc.rrTicks,
      callstackDepth: typeof loc.callstackDepth === 'number' ? loc.callstackDepth : 0,
    },
  }
}

/** The stop as DAP reports it (`DebugSession.currentStop()`), the fields read here. */
export interface DapStop {
  line: number
  /** Name of the innermost stack frame. */
  frame: string
}

/** What the checks found, for the spec's diagnostics and failure message. */
export interface FlowStopReport {
  flowFunction: string
  flowKey: string
  flowRRTicks: number | undefined
  flowLines: number[]
  stop: DapStop
  stopKey: string
  stopRRTicks: number | undefined
  /** The line of the last `ct/complete-move`, which the request was built from. */
  moveLine: number | undefined
  /** Each way the flow fails to belong to the stop; empty when it belongs. */
  mismatches: string[]
}

function flowLocationOf(flow: any): any {
  if (flow?.location && typeof flow.location === 'object') return flow.location
  return flow?.viewUpdates?.[0]?.location
}

/**
 * Check that a `FlowUpdate` (the `ct/updated-flow` body) is the flow of the
 * call the session is stopped in.
 *
 * The update's `location` is the first step of the call the flow walked (the
 * replay server widens a request to the entry of the enclosing call), so it is
 * compared with the stop as follows:
 *
 *   - the last `ct/complete-move`, which the request was built from, is at
 *     the line DAP reports for the stop (the move is the current stop);
 *   - its `functionName` is the stop's innermost DAP frame name;
 *   - its call `key` is the stop's (`ct/complete-move`), when both carry one --
 *     this is what tells two activations of one function apart;
 *   - its `rrTicks` is at or before the stop's step: the call began no later
 *     than the stop;
 *   - the stop's line is among the lines of the flow's steps.
 *
 * A step-0 flow fails the first check whenever the stop is outside the call
 * that contains step 0.
 */
export function checkFlowAtStop(flow: any, stop: DapStop, move: TrackedMove | undefined): FlowStopReport {
  const mismatches: string[] = []
  const loc = flowLocationOf(flow) ?? {}
  const flowFunction = String(loc.functionName ?? '')
  const flowKey = String(loc.key ?? '')
  const flowRRTicks = typeof loc.rrTicks === 'number' ? loc.rrTicks : undefined
  const steps: any[] = Array.isArray(flow?.viewUpdates?.[0]?.steps) ? flow.viewUpdates[0].steps : []
  const flowLines = [...new Set(steps.map(s => s?.position).filter((p): p is number => typeof p === 'number'))]
    .sort((a, b) => a - b)
  const stopKey = String(move?.location?.key ?? '')
  const stopRRTicks = typeof move?.location?.rrTicks === 'number' ? move.location.rrTicks : undefined

  if (flow === undefined || flow === null) {
    mismatches.push('no flow was delivered')
  } else if (flow.error) {
    mismatches.push(`the flow is an error: ${flow.errorMessage ?? ''}`)
  }
  if (!stop.frame) {
    mismatches.push('the stop has no frame name to compare the flow with')
  } else if (flowFunction !== stop.frame) {
    mismatches.push(`the flow is of '${flowFunction}', but the session is stopped in '${stop.frame}'`)
  }
  // The request was built from the last `ct/complete-move`, and the key and
  // step checks below compare the flow with that move too. They prove the
  // flow is the stop's only if that move IS the stop DAP reports now, so a
  // tracker that missed a move (or kept another session's) fails here
  // rather than passing on the flow of a stop the session has left.
  const moveLine = typeof move?.location?.line === 'number' ? move.location.line : undefined
  if (moveLine !== undefined && moveLine !== stop.line) {
    mismatches.push(
      `the last ct/complete-move is at line ${moveLine}, but DAP reports the stop at line ${stop.line}: ` +
      'the flow was requested for a stop the session is no longer at',
    )
  }
  if (flowKey !== '' && stopKey !== '' && flowKey !== stopKey) {
    mismatches.push(`the flow is of call ${flowKey}, but the session is stopped in call ${stopKey}`)
  }
  if (stopRRTicks === undefined) {
    mismatches.push('no ct/complete-move reported the stop\'s step')
  } else if (flowRRTicks === undefined) {
    mismatches.push('the flow\'s location carries no step (rrTicks)')
  } else if (flowRRTicks > stopRRTicks) {
    mismatches.push(`the flow's call begins at step ${flowRRTicks}, after the stop's step ${stopRRTicks}`)
  }
  if (!flowLines.includes(stop.line)) {
    mismatches.push(`the stop's line ${stop.line} is not among the flow's step lines [${flowLines.join(', ')}]`)
  }
  return { flowFunction, flowKey, flowRRTicks, flowLines, stop, stopKey, stopRRTicks, moveLine, mismatches }
}
