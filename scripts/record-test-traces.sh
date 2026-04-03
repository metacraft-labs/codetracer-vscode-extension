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

record_trace() {
	local name="$1"
	local program="$2"
	local trace_dir="$TRACES_DIR/$name"

	# Check if trace already exists (skip unless FORCE=1).
	if [ -d "$trace_dir" ] && [ -f "$trace_dir/trace_metadata.json" ] && [ -z "${FORCE:-}" ]; then
		echo "  SKIP $name (already recorded, use FORCE=1 to re-record)"
		_skipped=$((_skipped + 1))
		return 0
	fi

	if [ ! -f "$program" ] && [ ! -d "$program" ]; then
		echo "  SKIP $name (program not found: $program)"
		_skipped=$((_skipped + 1))
		return 0
	fi

	echo "  RECORDING $name ..."
	rm -rf "$trace_dir"
	mkdir -p "$trace_dir"

	# Record the trace directly into the target directory using -o.
	local ct_output
	if ct_output=$("$CT" record -o "$trace_dir" "$program" 2>&1); then
		# Verify that ct produced trace metadata in the target directory.
		if [ -f "$trace_dir/trace_metadata.json" ]; then
			echo "    OK → $trace_dir"
			_recorded=$((_recorded + 1))
			return 0
		fi

		# Fallback: check if trace.json was written (some recorders
		# produce trace.json but not trace_metadata.json immediately).
		if [ -f "$trace_dir/trace.json" ]; then
			echo "    OK (partial) → $trace_dir"
			_recorded=$((_recorded + 1))
			return 0
		fi

		echo "    WARN: ct record succeeded but trace files not found in $trace_dir"
		echo "    ct output: ${ct_output:0:300}"
		_failed=$((_failed + 1))
	else
		echo "    FAIL: ct record failed for $name"
		echo "    ${ct_output:0:300}"
		_failed=$((_failed + 1))
	fi
}

# ---------------------------------------------------------------------------
# Determine which languages to record
# ---------------------------------------------------------------------------
LANGUAGES=("$@")
if [ ${#LANGUAGES[@]} -eq 0 ]; then
	LANGUAGES=(python ruby rust c go nim)
fi

echo "=== Recording test traces ==="
echo "  Traces dir: $TRACES_DIR"
echo "  Languages:  ${LANGUAGES[*]}"
echo ""

for lang in "${LANGUAGES[@]}"; do
	case "$lang" in
		python)
			if [ -n "${CODETRACER_PYTHON_RECORDER_PRESENT:-}" ]; then
				# Prefer test-programs/ in the recorder repo, fall back to codetracer/test-programs/
				if [ -f "$CODETRACER_PYTHON_RECORDER_ROOT/test-programs/py_sudoku_solver/main.py" ]; then
					record_trace "python-sudoku" "$CODETRACER_PYTHON_RECORDER_ROOT/test-programs/py_sudoku_solver/main.py"
				elif [ -f "$CODETRACER_PATH/test-programs/py_sudoku_solver/main.py" ]; then
					record_trace "python-sudoku" "$CODETRACER_PATH/test-programs/py_sudoku_solver/main.py"
				else
					echo "  SKIP python (test program not found)"
				fi
			else
				echo "  SKIP python (codetracer-python-recorder not available)"
			fi
			;;
		ruby)
			if [ -n "${CODETRACER_RUBY_RECORDER_PRESENT:-}" ]; then
				if [ -f "$CODETRACER_RUBY_RECORDER_ROOT/test-programs/rb_sudoku_solver/sudoku_solver.rb" ]; then
					record_trace "ruby-sudoku" "$CODETRACER_RUBY_RECORDER_ROOT/test-programs/rb_sudoku_solver/sudoku_solver.rb"
				elif [ -f "$CODETRACER_PATH/test-programs/rb_sudoku_solver/sudoku_solver.rb" ]; then
					record_trace "ruby-sudoku" "$CODETRACER_PATH/test-programs/rb_sudoku_solver/sudoku_solver.rb"
				else
					echo "  SKIP ruby (test program not found)"
				fi
			else
				echo "  SKIP ruby (codetracer-ruby-recorder not available)"
			fi
			;;
		rust)
			if [ -n "${CODETRACER_NATIVE_TEST_PROGRAMS_PRESENT:-}" ]; then
				record_trace "rust-sudoku" "$CODETRACER_NATIVE_TEST_PROGRAMS_PATH/rust/sudoku_solver/"
			elif [ -d "$CODETRACER_PATH/test-programs/rs_sudoku_solver" ]; then
				record_trace "rust-sudoku" "$CODETRACER_PATH/test-programs/rs_sudoku_solver/"
			else
				echo "  SKIP rust (test program not found)"
			fi
			;;
		c)
			if [ -n "${CODETRACER_NATIVE_TEST_PROGRAMS_PRESENT:-}" ]; then
				record_trace "c-sudoku" "$CODETRACER_NATIVE_TEST_PROGRAMS_PATH/c/sudoku_solver/"
			elif [ -d "$CODETRACER_PATH/test-programs/c_sudoku_solver" ]; then
				record_trace "c-sudoku" "$CODETRACER_PATH/test-programs/c_sudoku_solver/"
			else
				echo "  SKIP c (test program not found)"
			fi
			;;
		go)
			if [ -n "${CODETRACER_NATIVE_TEST_PROGRAMS_PRESENT:-}" ]; then
				record_trace "go-sudoku" "$CODETRACER_NATIVE_TEST_PROGRAMS_PATH/go/sudoku_solver/"
			elif [ -d "$CODETRACER_PATH/test-programs/go_sudoku_solver" ]; then
				record_trace "go-sudoku" "$CODETRACER_PATH/test-programs/go_sudoku_solver/"
			else
				echo "  SKIP go (test program not found)"
			fi
			;;
		nim)
			if [ -n "${CODETRACER_NATIVE_TEST_PROGRAMS_PRESENT:-}" ]; then
				record_trace "nim-sudoku" "$CODETRACER_NATIVE_TEST_PROGRAMS_PATH/nim/sudoku_solver/"
			elif [ -d "$CODETRACER_PATH/test-programs/nim_sudoku_solver" ]; then
				record_trace "nim-sudoku" "$CODETRACER_PATH/test-programs/nim_sudoku_solver/"
			else
				echo "  SKIP nim (test program not found)"
			fi
			;;
		*)
			echo "  SKIP $lang (unknown language)"
			;;
	esac
done

echo ""
echo "=== Done: $_recorded recorded, $_skipped skipped, $_failed failed ==="
