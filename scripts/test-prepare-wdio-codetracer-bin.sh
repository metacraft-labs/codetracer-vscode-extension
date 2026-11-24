#!/usr/bin/env bash
# Regression test for scripts/prepare-wdio-codetracer-bin.sh: it must not link
# a sibling's native binary into .ct-bin/ when that binary cannot start.
#
# The failure it guards against: the native backend's
# target/debug/ct-native-replay stayed executable after a Nix garbage
# collection removed a library its RUNPATH named, so the dynamic loader refused
# to start it (exit 127, "error while loading shared libraries"). The
# preparation step tested only `-x`, linked it, and reported success; every
# native WDIO test then failed at the replay.
#
# What is real here: the preparation script itself, run end to end as `just`
# runs it, against a staged workspace; the dynamic loader; and the binaries,
# which are ELF (or Mach-O) executables compiled with the dev shell's `cc`.
# The unloadable one is linked against a shared library that is then deleted,
# which is exactly how a garbage-collected store path breaks a debug build.
#
# What is stood in, and why:
#   * `repro` on PATH is a shim that runs the command after `--` directly in
#     the repo, and logs each invocation. The script's own boundary is the
#     `repro exec . -- just build` call it makes; the shim checks that call
#     verbatim. Entering the real native backend's dev shell and building it
#     would take many minutes and the whole lldb toolchain, and it would test
#     the backend's build rather than this script's decision.
#   * The staged native backend's justfile `build` recipe copies a prepared
#     binary into target/debug/ (a working one, or a still-unloadable one),
#     standing in for `cargo build` the same way. The staged BEAM recorder's
#     `build` recipe does the same for its debug binary.
#   * The staged codetracer checkout's `ct` and `db-backend` are executable
#     placeholders: the script only resolves and links them, never runs them.
# The script is copied into a staged extension checkout because it writes
# .ct-bin/ and test/wdio/projects/stylus-test/.vscode/settings.json beside
# itself; running the checked-in copy would rewrite this checkout's files.
set -euo pipefail

EXTENSION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$EXTENSION_DIR/scripts/prepare-wdio-codetracer-bin.sh"

command -v cc >/dev/null 2>&1 || {
	echo "FAIL: cc is required to build the test binaries (run inside the dev shell)" >&2
	exit 1
}
command -v just >/dev/null 2>&1 || {
	echo "FAIL: just is required (run inside the dev shell)" >&2
	exit 1
}
command -v node >/dev/null 2>&1 || {
	echo "FAIL: node is required (run inside the dev shell)" >&2
	exit 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failures=0
fail_case() {
	echo "FAIL [$1]: $2" >&2
	failures=$((failures + 1))
}

# --- binaries ---------------------------------------------------------------
# A working replay prints a version, like clap's `--version`. The unloadable
# one is the same program linked against libgone, whose file is then removed.
bins="$work/bins"
mkdir -p "$bins/lib"
cat >"$bins/main.c" <<'C'
#include <stdio.h>
#ifdef NEEDS_GONE
int gone_symbol(void);
#endif
int main(int argc, char **argv) {
#ifdef NEEDS_GONE
	gone_symbol();
#endif
	(void)argc; (void)argv;
	puts("ct-native-replay 0.0.0-test");
	return 0;
}
C
printf 'int gone_symbol(void) { return 0; }\n' >"$bins/gone.c"
case "$(uname -s)" in
Darwin)
	cc -shared -o "$bins/lib/libgone.dylib" -install_name @rpath/libgone.dylib "$bins/gone.c"
	;;
*)
	cc -shared -fPIC -o "$bins/lib/libgone.so" "$bins/gone.c"
	;;
esac
cc -o "$bins/good" "$bins/main.c"
cc -DNEEDS_GONE -o "$bins/unloadable" "$bins/main.c" \
	-L"$bins/lib" -lgone -Wl,-rpath,"$bins/lib"
# Positive control: the unloadable binary starts while its library exists,
# so what breaks it below is only the library's removal.
"$bins/unloadable" --version >/dev/null
rm -f "$bins/lib/libgone.so" "$bins/lib/libgone.dylib"
if "$bins/unloadable" --version >/dev/null 2>&1; then
	echo "FAIL: the staged unloadable binary still starts after its library was removed" >&2
	exit 1
fi
"$bins/good" --version >/dev/null

# --- repro shim -------------------------------------------------------------
shim_dir="$work/shim-bin"
mkdir -p "$shim_dir"
cat >"$shim_dir/repro" <<'SH'
#!/usr/bin/env bash
# Stand-in for `repro exec . -- <cmd...>`; see the test's header comment.
set -euo pipefail
printf '%s\t%s\n' "$PWD" "$*" >>"$REPRO_SHIM_LOG"
[ "${1:-}" = exec ] && [ "${2:-}" = . ] && [ "${3:-}" = -- ] || {
	echo "repro shim: unexpected invocation: $*" >&2
	exit 2
}
shift 3
exec "$@"
SH
chmod +x "$shim_dir/repro"

# stage_workspace <case> <initial replay: good|unloadable|missing> <build output: good|unloadable>
stage_workspace() {
	local case_dir="$work/$1"
	local initial="$2"
	local built="$3"

	mkdir -p "$case_dir/codetracer/src/config" "$case_dir/codetracer/result/bin" \
		"$case_dir/codetracer-vscode-extension/scripts" \
		"$case_dir/codetracer-native-backend/target/debug"
	printf '#!/bin/sh\nexit 0\n' >"$case_dir/codetracer/result/bin/ct"
	printf '#!/bin/sh\nexit 0\n' >"$case_dir/codetracer/result/bin/db-backend"
	chmod +x "$case_dir/codetracer/result/bin/ct" "$case_dir/codetracer/result/bin/db-backend"
	cp "$SCRIPT" "$case_dir/codetracer-vscode-extension/scripts/"

	if [ "$initial" != missing ]; then
		cp "$bins/$initial" "$case_dir/codetracer-native-backend/target/debug/ct-native-replay"
	fi
	cat >"$case_dir/codetracer-native-backend/justfile" <<JUST
build:
    cp "$bins/$built" target/debug/ct-native-replay
JUST
	printf '%s\n' "$case_dir"
}

# run_prepare <case_dir>: run the staged script; leaves exit code in $status
# and output in $case_dir/out.
run_prepare() {
	local case_dir="$1"
	: >"$case_dir/repro.log"
	set +e
	(
		cd "$case_dir/codetracer-vscode-extension"
		env -u CODETRACER_DIR -u CODETRACER_ROOT -u CODETRACER_CT_PATH -u CODETRACER_DB_BACKEND_PATH \
			PATH="$shim_dir:$PATH" REPRO_SHIM_LOG="$case_dir/repro.log" \
			CODETRACER_PATH="$case_dir/codetracer" \
			bash scripts/prepare-wdio-codetracer-bin.sh
	) >"$case_dir/out" 2>&1
	status=$?
	set -e
}

builds_in() {
	grep -c -F "exec . -- just build" "$1/repro.log" || true
}

expect_linked_and_starting() {
	local name="$1"
	local case_dir="$2"
	local link

	for link in ct-native-replay ct-rr-support; do
		link="$case_dir/codetracer-vscode-extension/.ct-bin/$link"
		if [ ! -L "$link" ]; then
			fail_case "$name" "$link was not linked"
		elif ! "$link" --version >/dev/null 2>&1; then
			fail_case "$name" "$link is linked but cannot start"
		fi
	done
}

# 1. The issue: an executable ct-native-replay that cannot load is rebuilt
#    once through the backend's `just build`, and the rebuilt one is linked.
c="$(stage_workspace stale-rebuilt unloadable good)"
run_prepare "$c"
if [ "$status" -ne 0 ]; then
	fail_case stale-rebuilt "preparation failed (exit $status):"$'\n'"$(cat "$c/out")"
fi
[ "$(builds_in "$c")" = 1 ] ||
	fail_case stale-rebuilt "expected one 'repro exec . -- just build' in the backend, log: $(cat "$c/repro.log")"
grep -q -F "$c/codetracer-native-backend	exec . -- just build" "$c/repro.log" ||
	fail_case stale-rebuilt "the rebuild did not run in the native backend checkout: $(cat "$c/repro.log")"
expect_linked_and_starting stale-rebuilt "$c"

# 2. When the rebuild still leaves a binary that cannot start, the step fails
#    and names it, and does not link it.
c="$(stage_workspace stale-still-broken unloadable unloadable)"
run_prepare "$c"
if [ "$status" -eq 0 ]; then
	fail_case stale-still-broken "preparation succeeded with a ct-native-replay that cannot start"
fi
grep -q -F "ct-native-replay still cannot start" "$c/out" &&
	grep -q -F "/codetracer-native-backend/target/debug/ct-native-replay --version" "$c/out" ||
	fail_case stale-still-broken "the failure does not name ct-native-replay and its path:"$'\n'"$(cat "$c/out")"
[ "$(builds_in "$c")" = 1 ] ||
	fail_case stale-still-broken "expected exactly one rebuild, log: $(cat "$c/repro.log")"
[ ! -e "$c/codetracer-vscode-extension/.ct-bin/ct-native-replay" ] ||
	fail_case stale-still-broken ".ct-bin/ct-native-replay was linked to a binary that cannot start"

# 3. A ct-native-replay that starts is linked without a rebuild.
c="$(stage_workspace fresh good unloadable)"
run_prepare "$c"
[ "$status" -eq 0 ] || fail_case fresh "preparation failed (exit $status):"$'\n'"$(cat "$c/out")"
[ "$(builds_in "$c")" = 0 ] || fail_case fresh "rebuilt a binary that starts, log: $(cat "$c/repro.log")"
expect_linked_and_starting fresh "$c"

# 4. A missing ct-native-replay is built, as before.
c="$(stage_workspace missing missing good)"
run_prepare "$c"
[ "$status" -eq 0 ] || fail_case missing "preparation failed (exit $status):"$'\n'"$(cat "$c/out")"
[ "$(builds_in "$c")" = 1 ] || fail_case missing "expected one build, log: $(cat "$c/repro.log")"
expect_linked_and_starting missing "$c"

# stage_beam_recorder <case_dir> <release build: good|unloadable|missing>
# The BEAM recorder is built but not linked; its `just build` writes the debug
# binary, and a release build that starts is accepted instead of it.
stage_beam_recorder() {
	local beam="$1/codetracer-beam-recorder"
	mkdir -p "$beam/target/debug" "$beam/target/release"
	if [ "$2" != missing ]; then
		cp "$bins/$2" "$beam/target/release/codetracer-beam-recorder"
	fi
	cat >"$beam/justfile" <<JUST
build:
    cp "$bins/good" target/debug/codetracer-beam-recorder
JUST
}

beam_builds_in() {
	grep -c -F "$1/codetracer-beam-recorder	exec . -- just build" "$1/repro.log" || true
}

# 5. A release BEAM recorder that cannot start is not accepted: the debug one
#    is built.
c="$(stage_workspace beam-release-stale good good)"
stage_beam_recorder "$c" unloadable
run_prepare "$c"
[ "$status" -eq 0 ] || fail_case beam-release-stale "preparation failed (exit $status):"$'\n'"$(cat "$c/out")"
[ "$(beam_builds_in "$c")" = 1 ] ||
	fail_case beam-release-stale "expected one build in the BEAM recorder, log: $(cat "$c/repro.log")"
"$c/codetracer-beam-recorder/target/debug/codetracer-beam-recorder" --version >/dev/null 2>&1 ||
	fail_case beam-release-stale "the debug BEAM recorder was not built"

# 6. A release BEAM recorder that starts is accepted without a build.
c="$(stage_workspace beam-release-fresh good good)"
stage_beam_recorder "$c" good
run_prepare "$c"
[ "$status" -eq 0 ] || fail_case beam-release-fresh "preparation failed (exit $status):"$'\n'"$(cat "$c/out")"
[ "$(beam_builds_in "$c")" = 0 ] ||
	fail_case beam-release-fresh "built a BEAM recorder whose release build starts, log: $(cat "$c/repro.log")"

if [ "$failures" -ne 0 ]; then
	echo "prepare-wdio-codetracer-bin: $failures check(s) failed" >&2
	exit 1
fi
echo "prepare-wdio-codetracer-bin: a sibling binary that cannot start is rebuilt once, or the step fails naming it"
