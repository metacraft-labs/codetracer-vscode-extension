#!/usr/bin/env bash
# Regression test for scripts/record-test-traces.sh: what codetracer's dev env
# prints while it is activated must reach the log while it is being printed.
#
# The failure it guards against: every recording ran as
# `ct_output="$(repro exec "$CODETRACER_PATH" -- … ct record …)"`, and the
# first of them also activated codetracer's dev env. On a cold Nix store that
# realises the whole shell, and everything repro and nix printed meanwhile sat
# in `$ct_output`. A CI run printed `RECORDING python-sudoku ...` and then
# nothing for 2 h 36 min until the job was cancelled, so a slow step could not
# be told apart from a hung one.
#
# What is real here: the recording script itself, run end to end against a
# staged workspace, together with the sibling detection it sources.
#
# What is stood in, and why:
#   * `repro` on PATH is a shim, and it logs each invocation. On its first
#     `exec` into the staged codetracer checkout it acts like a cold dev-env
#     activation: it prints the lines a Nix build prints, then waits until the
#     test has seen them in the script's output (or for a bound), and only then
#     runs the command. The test reads the output while the shim is waiting, so
#     the activation is still running when its progress is checked. A real
#     cold activation of codetracer's dev shell builds hundreds of store paths
#     and takes hours. Other `exec`s run the command after `--` directly.
#   * The staged codetracer checkout's `ct` is a script that writes a trace
#     into its `-o=` directory and prints a `recordingId:` line, like
#     `ct record`. Recording a real program needs the recorders and the
#     native toolchain, and the test is about what the script prints.
# The script is copied into a staged extension checkout because it writes
# test/traces/ beside itself; running the checked-in copy would rewrite this
# checkout's traces.
set -euo pipefail

EXTENSION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

work="$(mktemp -d)"
cleanup() {
	# A case that failed may leave the script running behind the shim's wait.
	if [ -n "${script_pid:-}" ]; then
		kill "$script_pid" 2>/dev/null || true
		wait "$script_pid" 2>/dev/null || true
	fi
	rm -rf "$work"
}
trap cleanup EXIT

failures=0
fail_case() {
	echo "FAIL [$1]: $2" >&2
	failures=$((failures + 1))
}

# The line the shim prints for a cold activation, as `nix` prints a build.
BUILD_LINE="building '/nix/store/00000000000000000000000000000000-sui-1.82.3.drv'..."

# How long the shim holds a cold activation open waiting for the test to see
# its output. It bounds the run on the unfixed script, where the output is
# never seen; the fixed script shows it within a moment.
SEEN_TIMEOUT_SECONDS=30

# --- repro shim -------------------------------------------------------------
shim_dir="$work/shim-bin"
mkdir -p "$shim_dir"
cat >"$shim_dir/repro" <<'SH'
#!/usr/bin/env bash
# Stand-in for `repro exec <dir> -- <cmd...>`; see the test's header comment.
set -euo pipefail
printf '%s\n' "$*" >>"$REPRO_SHIM_LOG"
[ "${1:-}" = exec ] && [ "${3:-}" = -- ] || {
	echo "repro shim: unexpected invocation: $*" >&2
	exit 2
}
dir="$2"
shift 3
if [ "$dir" = "$SHIM_CODETRACER_PATH" ] && [ ! -e "$SHIM_STATE/activated" ]; then
	echo "these 36 derivations will be built:" >&2
	echo "$SHIM_BUILD_LINE" >&2
	if [ -n "${SHIM_ACTIVATION_FAILS:-}" ]; then
		echo "error: builder for '/nix/store/00000000000000000000000000000000-sui-1.82.3.drv' failed with exit code 1" >&2
		exit 1
	fi
	# Hold the activation open until the test has looked at the output.
	# The test's cleanup kills only the script's own process, so this shim
	# (or a command-substitution subshell running it) can outlive an aborted
	# test; it gives up as soon as the test's state directory is removed.
	waited=0
	while [ -d "$SHIM_STATE" ] && [ ! -e "$SHIM_STATE/seen" ] &&
		[ "$waited" -lt "$SHIM_SEEN_TIMEOUT" ]; do
		sleep 1
		waited=$((waited + 1))
	done
	[ -d "$SHIM_STATE" ] || exit 1
	touch "$SHIM_STATE/activated"
fi
exec "$@"
SH
chmod +x "$shim_dir/repro"

# stage_workspace <case>: a workspace with the extension's scripts, a
# codetracer checkout with a stand-in `ct`, and the Python recorder's program.
stage_workspace() {
	local case_dir="$work/$1"
	local ws="$case_dir/ws"
	mkdir -p "$ws/codetracer-vscode-extension/scripts" \
		"$ws/codetracer-vscode-extension/test/wdio/programs/python_panels" \
		"$ws/codetracer/src/db-backend" \
		"$ws/codetracer/src/build-debug-repro/bin" \
		"$ws/codetracer-python-recorder/test-programs/py_sudoku_solver" \
		"$case_dir/state" "$case_dir/home"
	cp "$EXTENSION_DIR/scripts/record-test-traces.sh" \
		"$EXTENSION_DIR/scripts/detect-siblings.sh" \
		"$ws/codetracer-vscode-extension/scripts/"
	echo 'print("sudoku")' >"$ws/codetracer-python-recorder/test-programs/py_sudoku_solver/main.py"
	echo 'print("panels")' >"$ws/codetracer-vscode-extension/test/wdio/programs/python_panels/main.py"
	cat >"$ws/codetracer/src/build-debug-repro/bin/ct" <<'CT'
#!/usr/bin/env bash
# Stand-in for `ct record -o=<dir> <program>`; see the test's header comment.
set -euo pipefail
[ "${1:-}" = record ] || { echo "ct stand-in: unexpected: $*" >&2; exit 2; }
out="${2#-o=}"
mkdir -p "$out"
printf '{"program": "%s"}\n' "$3" >"$out/trace_metadata.json"
echo "recordingId: 1"
CT
	chmod +x "$ws/codetracer/src/build-debug-repro/bin/ct"
	: >"$case_dir/repro.log"
}

# start_script <case> [env assignments...] -- <languages...>: run the staged
# script in the background with its stdout and stderr in <case>/output.
start_script() {
	local case_dir="$work/$1"
	shift
	local assignments=()
	while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
		assignments+=("$1")
		shift
	done
	shift
	(
		cd "$case_dir/ws/codetracer-vscode-extension"
		# The variables the script reads are reset, so the caller's own
		# environment (a dev shell exports several) cannot steer it.
		exec env -u CODETRACER_CT_PATH -u CODETRACER_PATH -u FORCE \
			-u REQUIRE_WDIO_FIXTURES -u CODETRACER_PYTHON_RECORDER_ROOT \
			-u CODETRACER_NATIVE_TEST_PROGRAMS_PATH -u CODETRACER_BEAM_RECORDER_ROOT \
			HOME="$case_dir/home" \
			PATH="$shim_dir:$PATH" \
			REPRO_SHIM_LOG="$case_dir/repro.log" \
			SHIM_STATE="$case_dir/state" \
			SHIM_CODETRACER_PATH="$case_dir/ws/codetracer" \
			SHIM_BUILD_LINE="$BUILD_LINE" \
			SHIM_SEEN_TIMEOUT="$SEEN_TIMEOUT_SECONDS" \
			DETECT_SIBLINGS_QUIET=1 \
			${assignments[@]+"${assignments[@]}"} \
			bash scripts/record-test-traces.sh "$@"
	) >"$case_dir/output" 2>&1 &
	script_pid=$!
}

# finish_script: wait for the background script; sets script_status.
finish_script() {
	script_status=0
	wait "$script_pid" || script_status=$?
	script_pid=""
}

show_output() {
	echo "--- output of case $1 ---" >&2
	sed 's/^/    /' "$work/$1/output" >&2
	echo "--- repro invocations ---" >&2
	sed 's/^/    /' "$work/$1/repro.log" >&2
}

# --- case 1: a cold activation is shown while it runs ------------------------
case_name=cold-activation-streams
stage_workspace "$case_name"
start_script "$case_name" -- python python-panels
seen_while_running=0
for _ in $(seq 1 "$SEEN_TIMEOUT_SECONDS"); do
	if grep -qF "$BUILD_LINE" "$work/$case_name/output"; then
		# The shim is still waiting, so this was printed while the
		# activation ran, not after it.
		if [ ! -e "$work/$case_name/state/activated" ]; then
			seen_while_running=1
		fi
		break
	fi
	if ! kill -0 "$script_pid" 2>/dev/null; then
		break
	fi
	sleep 1
done
touch "$work/$case_name/state/seen"
finish_script
if [ "$seen_while_running" -ne 1 ]; then
	fail_case "$case_name" "what the dev-env activation printed did not reach the output while the activation ran"
fi
if [ "$script_status" -ne 0 ]; then
	fail_case "$case_name" "the script exited $script_status"
fi
for trace in python-sudoku python-panels; do
	[ -f "$work/$case_name/ws/codetracer-vscode-extension/test/traces/$trace/trace_metadata.json" ] ||
		fail_case "$case_name" "trace $trace was not recorded"
done
announce_line="$(grep -n "ACTIVATING codetracer's dev env" "$work/$case_name/output" | head -n 1 | cut -d: -f1 || true)"
build_line="$(grep -nF "$BUILD_LINE" "$work/$case_name/output" | head -n 1 | cut -d: -f1 || true)"
first_recording="$(grep -n "RECORDING python-sudoku" "$work/$case_name/output" | head -n 1 | cut -d: -f1 || true)"
if [ -z "$announce_line" ] || [ -z "$build_line" ] || [ -z "$first_recording" ] ||
	[ "$announce_line" -ge "$build_line" ] || [ "$build_line" -ge "$first_recording" ]; then
	fail_case "$case_name" "expected the activation to be announced, then its output, then the first recording"
fi
build_count="$(grep -cF "$BUILD_LINE" "$work/$case_name/output" || true)"
[ "$build_count" -eq 1 ] ||
	fail_case "$case_name" "the activation's output appeared $build_count times, expected once"
grep -q "codetracer's dev env is ready after" "$work/$case_name/output" ||
	fail_case "$case_name" "the end of the activation was not reported"
activations="$(grep -c -- "-- true\$" "$work/$case_name/repro.log" || true)"
recordings="$(grep -c " record " "$work/$case_name/repro.log" || true)"
[ "$activations" -eq 1 ] && [ "$recordings" -eq 2 ] ||
	fail_case "$case_name" "expected one activation and two recordings, got $activations and $recordings"
[ "$failures" -eq 0 ] || show_output "$case_name"

# --- case 2: nothing to record, nothing activated ----------------------------
case_name=all-present-no-activation
before="$failures"
stage_workspace "$case_name"
for trace in python-sudoku python-panels; do
	mkdir -p "$work/$case_name/ws/codetracer-vscode-extension/test/traces/$trace"
	echo '{}' >"$work/$case_name/ws/codetracer-vscode-extension/test/traces/$trace/trace_metadata.json"
done
start_script "$case_name" -- python python-panels
finish_script
[ "$script_status" -eq 0 ] || fail_case "$case_name" "the script exited $script_status"
[ ! -s "$work/$case_name/repro.log" ] ||
	fail_case "$case_name" "repro was run although every trace was already present"
if grep -q "ACTIVATING" "$work/$case_name/output"; then
	fail_case "$case_name" "the dev env was activated although nothing was recorded"
fi
[ "$failures" -eq "$before" ] || show_output "$case_name"

# --- case 3: a failed activation is shown and fails each recording -----------
case_name=activation-fails
before="$failures"
stage_workspace "$case_name"
start_script "$case_name" SHIM_ACTIVATION_FAILS=1 -- python python-panels
finish_script
[ "$script_status" -ne 0 ] || fail_case "$case_name" "the script exited 0 after the activation failed"
grep -q "error: builder for .* failed with exit code 1" "$work/$case_name/output" ||
	fail_case "$case_name" "the activation's error did not reach the output"
grep -q "FAIL: activating codetracer's dev env exited 1" "$work/$case_name/output" ||
	fail_case "$case_name" "the activation failure was not reported with its exit code"
for trace in python-sudoku python-panels; do
	grep -q "FAIL $trace (codetracer's dev env could not be activated)" "$work/$case_name/output" ||
		fail_case "$case_name" "recording $trace was not failed for the activation"
done
grep -q "0 recorded, 0 skipped, 2 failed" "$work/$case_name/output" ||
	fail_case "$case_name" "the summary does not count both recordings as failed"
invocations="$(wc -l <"$work/$case_name/repro.log")"
[ "$invocations" -eq 1 ] ||
	fail_case "$case_name" "repro was run $invocations times, expected only the one failed activation"
[ "$failures" -eq "$before" ] || show_output "$case_name"

if [ "$failures" -gt 0 ]; then
	echo "record-test-traces: $failures check(s) failed" >&2
	exit 1
fi
echo "record-test-traces: all checks passed"
