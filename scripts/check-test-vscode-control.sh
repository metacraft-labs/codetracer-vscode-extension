#!/usr/bin/env bash
# Positive control for `just test-vscode`: prove that a failing extension host
# test fails the run.
#
# Runs only out/test-control/throws.control.js, whose single test always
# throws, through the same wrapper (scripts/run-vscode-test.sh) and the same
# `npx vscode-test` configuration (.vscode-test.mjs) that `just test-vscode`
# uses. The run must exit non-zero, name the failing test, and print the error
# that test throws -- the last proves the test body really executed inside VS
# Code. A run that exits 0 -- as `vscode-test` did when it was handed VS Code's
# CLI launcher, which detaches the app and exits before any test runs -- or
# exits non-zero without the test having run, fails here.
#
# The passing side is asserted by `just test-vscode` itself:
# scripts/run-vscode-test.sh refuses a 0 exit without mocha's `<N> passing`.
#
# Expects a display (`just test-vscode-control` runs it under _xvfb-run) and a
# compiled out/ (`npm run compile:ts`).
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
control_js="out/test-control/throws.control.js"
# Both strings are defined in src/test-control/throws.control.ts.
control_test="this test always throws"
control_error="POSITIVE-CONTROL: this failure is expected"

if [ ! -f "$control_js" ]; then
    echo "test-vscode-control: FATAL: $control_js is missing; run 'npm run compile:ts'." >&2
    exit 1
fi

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
failed=0

echo "test-vscode-control: running the always-throwing control ($control_js)"
bash "$script_dir/run-vscode-test.sh" --run "$control_js" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "$status" -eq 0 ]; then
    echo "test-vscode-control: FAIL: the control run exited 0, but its test always throws." >&2
    failed=1
else
    echo "test-vscode-control: ok: the control run exited non-zero ($status)"
fi
for expected in "$control_test" "$control_error"; do
    if grep -qF "$expected" "$log"; then
        echo "test-vscode-control: ok: the output contains '$expected'"
    else
        echo "test-vscode-control: FAIL: the output does not contain '$expected'." >&2
        failed=1
    fi
done

if [ "$failed" -ne 0 ]; then
    echo "test-vscode-control: FAILED: a throwing extension host test does not fail the run." >&2
    exit 1
fi
echo "test-vscode-control: PASSED"
