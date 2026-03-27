/**
 * Trace fixture/recording path utilities for WDIO tests.
 *
 * Traces are stored in two locations:
 * - `test/traces/<name>/`   — dynamically recorded by scripts/record-test-traces.sh
 * - `test/fixtures/<name>/` — committed pre-recorded fixtures (e.g., Stylus)
 *
 * The WDIO_TRACE_BASE and WDIO_FIXTURE_BASE env vars allow CI to override paths.
 */
import path from 'path'
import fs from 'fs'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

/** Resolve path to a dynamically recorded trace directory. */
export function resolveTracePath(traceName: string): string {
  const base = process.env.WDIO_TRACE_BASE || path.join(REPO_ROOT, 'test', 'traces')
  return path.resolve(base, traceName)
}

/** Resolve path to a committed fixture directory. */
export function resolveFixturePath(fixtureName: string): string {
  const base = process.env.WDIO_FIXTURE_BASE || path.join(REPO_ROOT, 'test', 'fixtures')
  return path.resolve(base, fixtureName)
}

/** Check whether a trace directory contains the minimum required files. */
export function traceExists(traceName: string): boolean {
  const dir = resolveTracePath(traceName)
  return hasTraceFiles(dir)
}

/** Check whether a fixture directory contains the minimum required files. */
export function fixtureExists(fixtureName: string): boolean {
  const dir = resolveFixturePath(fixtureName)
  return hasTraceFiles(dir)
}

/** Check whether a directory contains trace_metadata.json and at least one trace file. */
function hasTraceFiles(dir: string): boolean {
  if (!fs.existsSync(dir)) return false
  const hasMetadata = fs.existsSync(path.join(dir, 'trace_metadata.json'))
  const hasTrace = fs.existsSync(path.join(dir, 'trace.json')) ||
                   fs.existsSync(path.join(dir, 'trace.bin'))
  return hasMetadata && hasTrace
}
