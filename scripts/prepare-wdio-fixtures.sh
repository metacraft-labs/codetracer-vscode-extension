#!/usr/bin/env bash
# Prepare or validate fixture inputs needed by fixture-backed WDIO suites.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

fail() {
	echo "ERROR: $*" >&2
	exit 1
}

run_script() {
	local script="$1"
	if [ ! -x "$script" ]; then
		fail "fixture preparation script is missing or not executable: $script"
	fi
	echo "=== Running $script ==="
	bash "$script"
}

prepare_trace_fixtures() {
	"$SCRIPT_DIR/prepare-wdio-codetracer-bin.sh"
	export PATH="$REPO_ROOT/.ct-bin:$PATH"
	REQUIRE_WDIO_FIXTURES=1 bash "$SCRIPT_DIR/record-test-traces.sh"
}

prepare_blockchain_fixtures() {
	local scripts=(
		"$SCRIPT_DIR/prepare-masm-fixture.sh"
		"$SCRIPT_DIR/prepare-sway-fixture.sh"
		"$SCRIPT_DIR/prepare-move-fixture.sh"
		"$SCRIPT_DIR/prepare-solana-fixture.sh"
		"$SCRIPT_DIR/prepare-aiken-fixture.sh"
		"$SCRIPT_DIR/prepare-cadence-fixture.sh"
		"$SCRIPT_DIR/prepare-cairo-fixture.sh"
		"$SCRIPT_DIR/prepare-circom-fixture.sh"
		"$SCRIPT_DIR/prepare-leo-fixture.sh"
		"$SCRIPT_DIR/prepare-polkavm-fixture.sh"
		"$SCRIPT_DIR/prepare-solidity-fixture.sh"
		"$SCRIPT_DIR/prepare-tolk-fixture.sh"
		"$SCRIPT_DIR/prepare-stylus-fixture.sh"
	)

	for script in "${scripts[@]}"; do
		run_script "$script"
	done
}

require_file() {
	local path="$1"
	[ -f "$path" ] || fail "required value-origin fixture file is missing: $path"
}

require_path() {
	local path="$1"
	[ -e "$path" ] || fail "required value-origin fixture path is missing: $path"
}

path_exists() {
	local path="$1"
	[ -e "$path" ]
}

# True when $1 is a single-file CTFS container: a regular file that starts
# with the CTFS magic bytes C0 DE 72 AC E2 (src/ctfs.ts, CTFS_MAGIC).
ctfs_container_file() {
	local path="$1"
	[ -f "$path" ] || return 1
	[ "$(head -c 5 "$path" | od -An -tx1 | tr -d ' \n')" = "c0de72ace2" ]
}

# A trace is materialized when it is a trace directory carrying one of the
# recorders' layouts, or a single-file CTFS `.ct` container. The latter is how
# codetracer's `ct record-web` writes a browser session since codetracer
# 01068538c ("browser sessions are recorded as a single-file CTFS .ct"), so the
# cross-process fixture's frontend.ct / frontend-wasm.ct are files, not
# directories (backend.ct is still a directory).
trace_materialized() {
	local trace_dir="$1"
	ctfs_container_file "$trace_dir" && return 0
	[ -d "$trace_dir" ] || return 1
	[ -f "$trace_dir/trace.json" ] && return 0
	[ -f "$trace_dir/trace_metadata.json" ] && return 0
	[ -f "$trace_dir/trace_db_metadata.json" ] && return 0
	[ -f "$trace_dir/meta.dat" ] && return 0
	[ -d "$trace_dir/rr" ] && return 0
	find "$trace_dir" -maxdepth 1 -type f -name '*.ct' -print -quit | grep -q .
}

trace_tree_materialized() {
	local trace_dir="$1"
	local child
	trace_materialized "$trace_dir" && return 0
	[ -d "$trace_dir" ] || return 1
	for child in "$trace_dir"/*; do
		[ -d "$child" ] || continue
		trace_materialized "$child" && return 0
	done
	return 1
}

require_binary() {
	local binary="$1"
	command -v "$binary" >/dev/null 2>&1 || fail "required binary not on PATH: $binary"
}

resolve_python() {
	local codetracer_root="$1"
	if command -v python3 >/dev/null 2>&1; then
		command -v python3
		return 0
	fi
	if command -v python >/dev/null 2>&1; then
		command -v python
		return 0
	fi
	if [ -x "$codetracer_root/.python-recorder-venv/bin/python" ]; then
		printf '%s\n' "$codetracer_root/.python-recorder-venv/bin/python"
		return 0
	fi
	fail "required Python interpreter not found (python3, python, or $codetracer_root/.python-recorder-venv/bin/python)"
}

run_value_origin_regenerator() {
	local script="$1"
	local codetracer_root
	local preserved_env=()
	[ -x "$script" ] || fail "value-origin regenerator is missing or not executable: $script"
	codetracer_root="$(cd "$(dirname "$script")/../../../../../.." && pwd -P)"
	if [ -n "${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-}" ]; then
		preserved_env+=("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH")
	fi

	echo "Value-origin cross-process traces are missing; regenerating with $script ..."
	set +e
	(
		cd "$codetracer_root"
		repro exec . -- env "${preserved_env[@]}" bash "$script"
	)
	local status=$?
	set -e
	if [ "$status" -eq 75 ]; then
		fail "value-origin regenerator reported missing prerequisites; refusing to skip fixture-backed WDIO tests"
	fi
	if [ "$status" -ne 0 ]; then
		fail "value-origin regenerator failed with exit status $status"
	fi
}

# Run one of codetracer's per-scenario `origin/<lang>/<scenario>/regenerate.sh`
# scripts in codetracer's own development environment, as the cross-process
# regenerator above is run. Those scripts invoke the recorder by its bare name
# (`codetracer-python-recorder`, `codetracer-ruby-recorder`, `rustc`, ...) and
# expect the environment that codetracer's dev shell provides ("after
# `nix develop` provides the recorder on $PATH", their headers say); this
# extension's own dev shell does not carry the Python recorder at all. PATH
# keeps .ct-bin (exported by the caller), so the recorders prepared there are
# still found first.
run_origin_regenerator() {
	local script="$1"
	local codetracer_root="$2"
	[ -x "$script" ] || fail "value-origin regenerator is missing or not executable: $script"
	echo "Value-origin trace is missing; regenerating with $script ..."
	if ! (cd "$codetracer_root" && repro exec . -- bash "$script"); then
		fail "value-origin regenerator failed: $script"
	fi
}

prepare_origin_trace() {
	local language="$1"
	local scenario="$2"
	local script="$origin_root/$language/$scenario/regenerate.sh"
	local trace_dir="$origin_root/$language/$scenario/trace"

	if ! trace_tree_materialized "$trace_dir"; then
		run_origin_regenerator "$script" "$codetracer_root"
	fi
	trace_tree_materialized "$trace_dir" ||
		fail "value-origin trace did not materialize: $trace_dir"
}

prepare_value_origin_fixtures() {
	"$SCRIPT_DIR/prepare-wdio-codetracer-bin.sh"
	export PATH="$REPO_ROOT/.ct-bin:$PATH"
	require_binary ct

	local codetracer_root="${CT_REPO:-${CODETRACER_PATH:-$REPO_ROOT/../codetracer}}"
	[ -d "$codetracer_root/src/db-backend/tests/fixtures" ] ||
		fail "codetracer fixture catalogue not found under $codetracer_root/src/db-backend/tests/fixtures (set CT_REPO)"

	local origin_root="$codetracer_root/src/db-backend/tests/fixtures/origin"
	local required_origin=(
		"python/simple_trivial_chain/main.py"
		"python/parameter_pass/main.py"
		"python/computational_origin/main.py"
		"ruby/simple_trivial_chain/main.rb"
		"javascript/simple_trivial_chain/main.js"
		"rust/simple_trivial_chain/main.rs"
		"c/cross_thread_copy/main.c"
	)
	for rel in "${required_origin[@]}"; do
		require_file "$origin_root/$rel"
	done

	prepare_origin_trace python simple_trivial_chain
	prepare_origin_trace python parameter_pass
	prepare_origin_trace python computational_origin
	prepare_origin_trace ruby simple_trivial_chain
	prepare_origin_trace javascript simple_trivial_chain
	prepare_origin_trace rust simple_trivial_chain
	prepare_origin_trace c cross_thread_copy

	local cross_root="$codetracer_root/src/db-backend/tests/fixtures/cross_process/account-balance-with-wasm"
	local missing_cross=0
	for name in frontend.ct frontend-wasm.ct backend.ct; do
		if ! trace_materialized "$cross_root/$name"; then
			missing_cross=1
		fi
	done
	if [ "$missing_cross" -ne 0 ]; then
		run_value_origin_regenerator "$cross_root/regenerate.sh"
	fi
	for name in frontend.ct frontend-wasm.ct backend.ct; do
		trace_materialized "$cross_root/$name" ||
			fail "account-balance-with-wasm trace is not materialized: $cross_root/$name"
	done

	echo "Value-origin fixture prerequisites are present."
}

mode="${1:-all}"
case "$mode" in
	traces)
		prepare_trace_fixtures
		;;
	blockchain)
		prepare_blockchain_fixtures
		;;
	value-origin)
		prepare_value_origin_fixtures
		;;
	all)
		prepare_trace_fixtures
		prepare_blockchain_fixtures
		prepare_value_origin_fixtures
		;;
	*)
		fail "unknown fixture preparation mode: $mode"
		;;
esac
