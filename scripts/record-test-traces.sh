#!/usr/bin/env bash
# =============================================================================
# Record test traces for WDIO language smoke tests.
#
# This script runs before WDIO tests to record traces for all available
# languages. Each language's trace is stored under test/traces/<name>/.
# The script is idempotent — existing traces are skipped unless FORCE=1.
#
# Usage:
#   ./scripts/record-test-traces.sh [LANGUAGE...]
#
# Arguments:
#   LANGUAGE  (optional) — one or more language names to record (e.g., python ruby).
#             If omitted, all available languages are recorded.
#
# Environment:
#   FORCE=1               — re-record even if traces already exist
#   DETECT_SIBLINGS_QUIET=1  — suppress sibling detection output
#
# Prerequisites:
#   - ct binary built (nix build or just build in the codetracer repo)
#   - Language-specific recorder and test programs available in sibling repos
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
TRACES_DIR="$REPO_ROOT/test/traces"

# Source sibling detection.
# shellcheck source=detect-siblings.sh
source "$SCRIPT_DIR/detect-siblings.sh" "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Resolve ct binary
# ---------------------------------------------------------------------------
CT="${CODETRACER_CT_PATH:-}"
if [ -z "$CT" ]; then
	echo "ERROR: ct binary not found. Build codetracer first (nix build or just build-once)." >&2
	echo "  Expected at: \$CODETRACER_PATH/result/bin/ct or \$CODETRACER_PATH/src/build-debug/bin/ct" >&2
	exit 1
fi
echo "Using ct binary: $CT"

# Also source the codetracer detect-siblings so ct can find recorders.
if [ -f "$CODETRACER_PATH/scripts/detect-siblings.sh" ]; then
	source "$CODETRACER_PATH/scripts/detect-siblings.sh" "$CODETRACER_PATH"
fi

mkdir -p "$TRACES_DIR"

# ---------------------------------------------------------------------------
# Helper: record a single trace
# ---------------------------------------------------------------------------
_recorded=0
_skipped=0
_failed=0

strict_required() {
	[ -n "${REQUIRE_WDIO_FIXTURES:-}" ]
}

format_command() {
	local arg
	for arg in "$@"; do
		printf '%q ' "$arg"
	done
	printf '\n'
}

print_indented() {
	sed 's/^/      /'
}

trace_has_files() {
	local trace_dir="$1"
	[ -d "$trace_dir" ] &&
	{ [ -f "$trace_dir/trace_metadata.json" ] ||
	  [ -f "$trace_dir/trace_db_metadata.json" ] ||
	  [ -f "$trace_dir/trace.json" ] ||
	  [ -f "$trace_dir/trace.ct" ] ||
	  [ -f "$trace_dir/meta.dat" ] ||
	  [ -n "$(find "$trace_dir" -maxdepth 2 -type f \( -name '*.ct' -o -name 'meta.dat' \) -print -quit 2>/dev/null)" ]; }
}

recording_id_from_output() {
	local output="$1"
	printf '%s\n' "$output" |
		sed -n 's/^recordingId:[[:space:]]*//p' |
		tail -n 1
}

copy_recording_from_store() {
	local output="$1"
	local trace_dir="$2"
	local recording_id
	local source_dir

	recording_id="$(recording_id_from_output "$output")"
	[ -n "$recording_id" ] || return 1

	source_dir="$HOME/.local/share/codetracer/$recording_id"
	trace_has_files "$source_dir" || return 1

	rm -rf "$trace_dir"
	mkdir -p "$trace_dir"
	cp -a "$source_dir/." "$trace_dir/"
}

print_record_failure() {
	local name="$1"
	local reason="$2"
	local command_text="$3"
	local output="$4"

	echo "    FAIL: $reason for $name"
	echo "    command: $command_text"
	echo "    output:"
	printf '%s\n' "$output" | print_indented
}

ct_record_command_text() {
	format_command \
		direnv exec "$CODETRACER_PATH" \
		bash -lc 'PATH="$1:$PATH"; if [ -x "$1/ct-mcr" ]; then export CODETRACER_CT_MCR_PATH="$1/ct-mcr"; fi; exec "$2" record "-o=$3" "$4"' \
		bash "$REPO_ROOT/.ct-bin" "$CT" "$1" "$2"
}

run_ct_record() {
	local trace_dir="$1"
	local program="$2"

	direnv exec "$CODETRACER_PATH" \
		bash -lc 'PATH="$1:$PATH"; if [ -x "$1/ct-mcr" ]; then export CODETRACER_CT_MCR_PATH="$1/ct-mcr"; fi; exec "$2" record "-o=$3" "$4"' \
		bash "$REPO_ROOT/.ct-bin" "$CT" "$trace_dir" "$program"
}

configure_nim_compiler() {
	local workspace_root
	local nim_repo
	local nim_exe=""

	workspace_root="$(cd "$REPO_ROOT/.." && pwd -P)"
	nim_repo="$workspace_root/codetracer-nim"
	if [ -x "$REPO_ROOT/.ct-bin/nim" ]; then
		export CODETRACER_NIM_EXE_PATH="$REPO_ROOT/.ct-bin/nim"
		return 0
	fi
	[ -d "$nim_repo" ] || return 0

	if [ -x "$nim_repo/bin/nim" ]; then
		nim_exe="$nim_repo/bin/nim"
	elif command -v direnv >/dev/null 2>&1 && [ -f "$nim_repo/.envrc" ]; then
		nim_exe="$(
			cd "$nim_repo" &&
				direnv exec . bash -lc 'command -v nim' 2>/dev/null || true
		)"
	fi

	if [ -n "$nim_exe" ] && [ -x "$nim_exe" ]; then
		export CODETRACER_NIM_EXE_PATH="$nim_exe"
	fi
}

skip_or_fail() {
	local name="$1"
	local reason="$2"
	if strict_required; then
		echo "  FAIL $name ($reason)"
		_failed=$((_failed + 1))
	else
		echo "  SKIP $name ($reason)"
		_skipped=$((_skipped + 1))
	fi
}

trace_ready() {
	local trace_dir="$TRACES_DIR/$1"
	[ -z "${FORCE:-}" ] &&
	[ -d "$trace_dir" ] &&
	{ [ -f "$trace_dir/trace_metadata.json" ] ||
	  [ -f "$trace_dir/trace_db_metadata.json" ] ||
	  [ -n "$(find "$trace_dir"/*.ct -maxdepth 0 -print -quit 2>/dev/null)" ]; }
}

use_existing_trace_if_ready() {
	local name="$1"
	if trace_ready "$name"; then
		echo "  SKIP $name (already recorded, use FORCE=1 to re-record)"
		_skipped=$((_skipped + 1))
		return 0
	fi
	return 1
}

record_trace() {
	local name="$1"
	local program="$2"
	local trace_dir="$TRACES_DIR/$name"

	# Check if trace already exists (skip unless FORCE=1).
	# DB-based traces (Python, Ruby) produce trace_metadata.json;
	# rr-based traces (Rust, C, Go, Nim) produce trace_db_metadata.json.
	if [ -d "$trace_dir" ] && \
	   { [ -f "$trace_dir/trace_metadata.json" ] || [ -f "$trace_dir/trace_db_metadata.json" ]; } && \
	   [ -z "${FORCE:-}" ]; then
		echo "  SKIP $name (already recorded, use FORCE=1 to re-record)"
		_skipped=$((_skipped + 1))
		return 0
	fi

	if [ ! -f "$program" ] && [ ! -d "$program" ]; then
		skip_or_fail "$name" "program not found: $program"
		return 0
	fi

	echo "  RECORDING $name ..."
	rm -rf "$trace_dir"
	mkdir -p "$trace_dir"

	# Record the trace directly into the target directory using -o=<dir>.
	# IMPORTANT: confutils (the Nim CLI parser ct uses) requires the = sign
	# for named options — `-o <value>` does NOT work (it treats <value> as a
	# positional argument).
	local ct_output
	local command_text
	command_text="$(ct_record_command_text "$trace_dir" "$program")"
	if ct_output="$(run_ct_record "$trace_dir" "$program" 2>&1)"; then
		# Verify that ct produced trace metadata in the target directory.
		# DB-based traces write trace_metadata.json; rr-based traces write
		# trace_db_metadata.json.
		if trace_has_files "$trace_dir"; then
			echo "    OK → $trace_dir"
			_recorded=$((_recorded + 1))
			return 0
		fi

		if copy_recording_from_store "$ct_output" "$trace_dir"; then
			echo "    OK (copied from CodeTracer store) → $trace_dir"
			_recorded=$((_recorded + 1))
			return 0
		fi

		print_record_failure "$name" "ct record succeeded but trace files were not found in $trace_dir or CodeTracer storage" "$command_text" "$ct_output"
		_failed=$((_failed + 1))
	else
		print_record_failure "$name" "ct record exited non-zero" "$command_text" "$ct_output"
		_failed=$((_failed + 1))
	fi
}

# ---------------------------------------------------------------------------
# Determine which languages to record
# ---------------------------------------------------------------------------
LANGUAGES=("$@")
if [ ${#LANGUAGES[@]} -eq 0 ]; then
	LANGUAGES=(python ruby rust c go nim beam)
fi

configure_nim_compiler

echo "=== Recording test traces ==="
echo "  Traces dir: $TRACES_DIR"
echo "  Languages:  ${LANGUAGES[*]}"
echo ""

for lang in "${LANGUAGES[@]}"; do
	case "$lang" in
		python)
			if use_existing_trace_if_ready "python-sudoku"; then
				continue
			fi
			if [ -n "${CODETRACER_PYTHON_RECORDER_PRESENT:-}" ]; then
				# Prefer test-programs/ in the recorder repo, fall back to codetracer/test-programs/
				if [ -f "$CODETRACER_PYTHON_RECORDER_ROOT/test-programs/py_sudoku_solver/main.py" ]; then
					record_trace "python-sudoku" "$CODETRACER_PYTHON_RECORDER_ROOT/test-programs/py_sudoku_solver/main.py"
				elif [ -f "$CODETRACER_PATH/test-programs/py_sudoku_solver/main.py" ]; then
					record_trace "python-sudoku" "$CODETRACER_PATH/test-programs/py_sudoku_solver/main.py"
				else
					skip_or_fail "python" "test program not found"
				fi
			else
				skip_or_fail "python" "codetracer-python-recorder not available"
			fi
			;;
		ruby)
			if use_existing_trace_if_ready "ruby-sudoku"; then
				continue
			fi
			if [ -n "${CODETRACER_RUBY_RECORDER_PRESENT:-}" ]; then
				if [ -f "$CODETRACER_RUBY_RECORDER_ROOT/test-programs/rb_sudoku_solver/sudoku_solver.rb" ]; then
					record_trace "ruby-sudoku" "$CODETRACER_RUBY_RECORDER_ROOT/test-programs/rb_sudoku_solver/sudoku_solver.rb"
				elif [ -f "$CODETRACER_PATH/test-programs/rb_sudoku_solver/sudoku_solver.rb" ]; then
					record_trace "ruby-sudoku" "$CODETRACER_PATH/test-programs/rb_sudoku_solver/sudoku_solver.rb"
				else
					skip_or_fail "ruby" "test program not found"
				fi
			else
				skip_or_fail "ruby" "codetracer-ruby-recorder not available"
			fi
			;;
		rust)
			if use_existing_trace_if_ready "rust-sudoku"; then
				continue
			fi
			# Pass the individual source file, not the directory.
			# ct-native-replay build uses the file extension to detect the language;
			# directory-based detection only works for project files (Cargo.toml, etc.).
			if [ -n "${CODETRACER_NATIVE_TEST_PROGRAMS_PRESENT:-}" ]; then
				record_trace "rust-sudoku" "$CODETRACER_NATIVE_TEST_PROGRAMS_PATH/rust/sudoku_solver/main.rs"
			elif [ -f "$CODETRACER_PATH/test-programs/rs_sudoku_solver/main.rs" ]; then
				record_trace "rust-sudoku" "$CODETRACER_PATH/test-programs/rs_sudoku_solver/main.rs"
			else
				skip_or_fail "rust" "test program not found"
			fi
			;;
		c)
			if use_existing_trace_if_ready "c-sudoku"; then
				continue
			fi
			if [ -n "${CODETRACER_NATIVE_TEST_PROGRAMS_PRESENT:-}" ]; then
				record_trace "c-sudoku" "$CODETRACER_NATIVE_TEST_PROGRAMS_PATH/c/sudoku_solver/main.c"
			elif [ -f "$CODETRACER_PATH/test-programs/c_sudoku_solver/main.c" ]; then
				record_trace "c-sudoku" "$CODETRACER_PATH/test-programs/c_sudoku_solver/main.c"
			else
				skip_or_fail "c" "test program not found"
			fi
			;;
		go)
			if use_existing_trace_if_ready "go-sudoku"; then
				continue
			fi
			if [ -n "${CODETRACER_NATIVE_TEST_PROGRAMS_PRESENT:-}" ]; then
				record_trace "go-sudoku" "$CODETRACER_NATIVE_TEST_PROGRAMS_PATH/go/sudoku_solver/sudoku.go"
			elif [ -f "$CODETRACER_PATH/test-programs/go_sudoku_solver/sudoku.go" ]; then
				record_trace "go-sudoku" "$CODETRACER_PATH/test-programs/go_sudoku_solver/sudoku.go"
			else
				skip_or_fail "go" "test program not found"
			fi
			;;
		nim)
			if use_existing_trace_if_ready "nim-sudoku"; then
				continue
			fi
			if [ -n "${CODETRACER_NATIVE_TEST_PROGRAMS_PRESENT:-}" ]; then
				record_trace "nim-sudoku" "$CODETRACER_NATIVE_TEST_PROGRAMS_PATH/nim/sudoku_solver/main.nim"
			elif [ -f "$CODETRACER_PATH/test-programs/nim_sudoku_solver/main.nim" ]; then
				record_trace "nim-sudoku" "$CODETRACER_PATH/test-programs/nim_sudoku_solver/main.nim"
			else
				skip_or_fail "nim" "test program not found"
			fi
			;;
		beam)
			if use_existing_trace_if_ready "elixir-canonical-flow" &&
			   use_existing_trace_if_ready "erlang-canonical-flow"; then
				continue
			fi
			# BEAM canonical fixtures (Elixir + Erlang) are recorded via the
			# recorder-owned prepare-beam-fixtures.sh, not ct record. The
			# script handles compilation, recorder invocation, and bundle
			# validation; it fails loudly on missing prerequisites (verified
			# by codetracer-beam-recorder/tests/verify-beam-fixture-generation-no-silent-skip.sh).
			if [ -n "${CODETRACER_BEAM_RECORDER_PRESENT:-}" ]; then
				_beam_script="$CODETRACER_BEAM_RECORDER_ROOT/scripts/prepare-beam-fixtures.sh"
				if [ -x "$_beam_script" ]; then
					_beam_elixir="$TRACES_DIR/elixir-canonical-flow"
					_beam_erlang="$TRACES_DIR/erlang-canonical-flow"
					# Skip if both fixtures already exist (idempotent),
					# unless FORCE=1.
					if [ -z "${FORCE:-}" ] && \
					   [ -f "$_beam_elixir/trace_metadata.json" ] && \
					   [ -f "$_beam_erlang/trace_metadata.json" ]; then
						echo "  SKIP beam (fixtures present at $_beam_elixir and $_beam_erlang; use FORCE=1)"
						_skipped=$((_skipped + 2))
					else
						echo "  RECORDING beam (Elixir + Erlang canonical_flow) ..."
						if FORCE="${FORCE:-}" "$_beam_script" "$_beam_elixir" "$_beam_erlang"; then
							echo "    OK → $_beam_elixir"
							echo "    OK → $_beam_erlang"
							_recorded=$((_recorded + 2))
						else
							echo "    FAIL: prepare-beam-fixtures.sh exited non-zero"
							_failed=$((_failed + 2))
						fi
					fi
				else
					skip_or_fail "beam" "prepare-beam-fixtures.sh not executable at $_beam_script"
				fi
			else
				skip_or_fail "beam" "codetracer-beam-recorder sibling not available"
			fi
			;;
		*)
			skip_or_fail "$lang" "unknown language"
			;;
	esac
done

echo ""
echo "=== Done: $_recorded recorded, $_skipped skipped, $_failed failed ==="

# Fail the script if any recordings failed so CI catches the problem. When
# REQUIRE_WDIO_FIXTURES=1 is set, missing prerequisites are counted as failures
# too; full WDIO orchestration must not pass by accepting skipped trace suites.
if [ "$_failed" -gt 0 ]; then
	exit 1
fi
