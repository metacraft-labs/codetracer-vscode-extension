#!/usr/bin/env bash
# Run `npx vscode-test` (the VS Code extension host tests) and refuse a run
# that reported no results.
#
# Usage: scripts/run-vscode-test.sh [extra `vscode-test` arguments...]
#
# The exit status of `vscode-test` stays authoritative: a failing run fails
# this script with that status. On top of it, a run that exits 0 must have
# printed mocha's summary line (`<N> passing`). `vscode-test` exited 0 with no
# test output at all when it was handed VS Code's CLI launcher, which starts
# the app detached and exits at once; this check keeps any such launch from
# passing silently again.
set -euo pipefail

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

status=0
npx vscode-test "$@" 2>&1 | tee "$log" || status=$?
if [ "$status" -ne 0 ]; then
    echo "run-vscode-test: vscode-test exited with status $status" >&2
    exit "$status"
fi
if ! grep -Eq '[0-9]+ passing' "$log"; then
    echo "run-vscode-test: FATAL: vscode-test exited 0 but printed no mocha summary" >&2
    echo "  ('<N> passing'), so no test reported a result. VS Code was probably" >&2
    echo "  launched through a launcher that exits before the tests run; check" >&2
    echo "  VSCODE_INSIDERS_EXECUTABLE (see .vscode-test.mjs)." >&2
    exit 1
fi
echo "run-vscode-test: OK: $(grep -Eo '[0-9]+ passing' "$log" | tail -n 1)"
