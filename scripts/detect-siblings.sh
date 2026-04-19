#!/usr/bin/env bash
# =============================================================================
# Unified sibling repo detection for the CodeTracer VS Code extension.
#
# Detects sibling repos checked out alongside the extension repo (in a
# workspace layout) and exports environment variables for each detected
# sibling. Follows the same pattern as codetracer/scripts/detect-siblings.sh.
#
# Usage:
#   source scripts/detect-siblings.sh [ROOT_DIR]
#
# Arguments:
#   ROOT_DIR  (optional) — absolute path to the extension repo root.
#             Defaults to `git rev-parse --show-toplevel`.
#
# Environment:
#   DETECT_SIBLINGS_QUIET=1  — suppress summary output to stderr.
# =============================================================================

# Resolve the extension repo root directory.
_EXT_ROOT_DIR="${1:-}"
if [ -z "$_EXT_ROOT_DIR" ]; then
	_EXT_ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null)" || true
fi
if [ -z "$_EXT_ROOT_DIR" ]; then
	echo "detect-siblings.sh: ERROR: cannot determine repo root." >&2
	return 1 2>/dev/null || exit 1
fi

# ---------------------------------------------------------------------------
# Determine workspace root (parent directory containing sibling repos).
# ---------------------------------------------------------------------------
_EXT_WORKSPACE_ROOT=""

_ext_try_workspace_root() {
	local candidate="$1"
	if [ -d "$candidate/codetracer" ] ||
		[ -d "$candidate/codetracer-python-recorder" ] ||
		[ -d "$candidate/codetracer-ruby-recorder" ]; then
		_EXT_WORKSPACE_ROOT="$candidate"
		return 0
	fi
	return 1
}

_ext_parent="$(cd "$_EXT_ROOT_DIR/.." 2>/dev/null && pwd)"
if [ -n "$_ext_parent" ]; then
	if ! _ext_try_workspace_root "$_ext_parent"; then
		_ext_grandparent="$(cd "$_EXT_ROOT_DIR/../.." 2>/dev/null && pwd)"
		if [ -n "$_ext_grandparent" ]; then
			_ext_try_workspace_root "$_ext_grandparent" || true
		fi
	fi
fi

_EXT_DETECTED_SIBLINGS=""

_ext_detect_summary() {
	if [ -z "${DETECT_SIBLINGS_QUIET:-}" ]; then
		_EXT_DETECTED_SIBLINGS="${_EXT_DETECTED_SIBLINGS}  sibling: $1 detected"$'\n'
	fi
}

# ---------------------------------------------------------------------------
# Sibling detection
# ---------------------------------------------------------------------------

# --- codetracer (main repo) ---
# Exports: CODETRACER_PATH, CODETRACER_CT_PATH (ct binary), CODETRACER_DB_BACKEND_PATH
if [ -n "$_EXT_WORKSPACE_ROOT" ] && [ -d "$_EXT_WORKSPACE_ROOT/codetracer/src/db-backend" ]; then
	export CODETRACER_PATH="$_EXT_WORKSPACE_ROOT/codetracer"
	# Prefer nix result, then build-debug
	if [ -x "$_EXT_WORKSPACE_ROOT/codetracer/result/bin/ct" ]; then
		export CODETRACER_CT_PATH="$_EXT_WORKSPACE_ROOT/codetracer/result/bin/ct"
	elif [ -x "$_EXT_WORKSPACE_ROOT/codetracer/src/build-debug/bin/ct" ]; then
		export CODETRACER_CT_PATH="$_EXT_WORKSPACE_ROOT/codetracer/src/build-debug/bin/ct"
	fi
	if [ -x "$_EXT_WORKSPACE_ROOT/codetracer/src/db-backend/target/debug/db-backend" ]; then
		export CODETRACER_DB_BACKEND_PATH="$_EXT_WORKSPACE_ROOT/codetracer/src/db-backend/target/debug/db-backend"
	elif [ -x "$_EXT_WORKSPACE_ROOT/codetracer/result/bin/db-backend" ]; then
		export CODETRACER_DB_BACKEND_PATH="$_EXT_WORKSPACE_ROOT/codetracer/result/bin/db-backend"
	fi
	_ext_detect_summary "codetracer"
fi

# --- codetracer-python-recorder ---
# Exports: CODETRACER_PYTHON_RECORDER_ROOT
if [ -n "$_EXT_WORKSPACE_ROOT" ] && [ -d "$_EXT_WORKSPACE_ROOT/codetracer-python-recorder" ]; then
	export CODETRACER_PYTHON_RECORDER_ROOT="$_EXT_WORKSPACE_ROOT/codetracer-python-recorder"
	_ext_detect_summary "codetracer-python-recorder"
fi

# --- codetracer-ruby-recorder ---
# Exports: CODETRACER_RUBY_RECORDER_ROOT
if [ -n "$_EXT_WORKSPACE_ROOT" ] && [ -d "$_EXT_WORKSPACE_ROOT/codetracer-ruby-recorder" ]; then
	export CODETRACER_RUBY_RECORDER_ROOT="$_EXT_WORKSPACE_ROOT/codetracer-ruby-recorder"
	_ext_detect_summary "codetracer-ruby-recorder"
fi

# --- codetracer-native-backend (formerly codetracer-rr-backend) ---
# Exports: CODETRACER_RR_BACKEND_PATH
if [ -n "$_EXT_WORKSPACE_ROOT" ] && [ -x "$_EXT_WORKSPACE_ROOT/codetracer-native-backend/target/debug/ct-native-replay" ]; then
	export CODETRACER_RR_BACKEND_PATH="$_EXT_WORKSPACE_ROOT/codetracer-native-backend"
	_ext_detect_summary "codetracer-native-backend"
elif [ -n "$_EXT_WORKSPACE_ROOT" ] && [ -x "$_EXT_WORKSPACE_ROOT/codetracer-rr-backend/target/debug/ct-rr-support" ]; then
	# Legacy fallback
	export CODETRACER_RR_BACKEND_PATH="$_EXT_WORKSPACE_ROOT/codetracer-rr-backend"
	_ext_detect_summary "codetracer-rr-backend (legacy)"
fi

# --- codetracer-native-test-programs ---
# Exports: CODETRACER_NATIVE_TEST_PROGRAMS_PATH
if [ -n "$_EXT_WORKSPACE_ROOT" ] && [ -d "$_EXT_WORKSPACE_ROOT/codetracer-native-test-programs" ]; then
	export CODETRACER_NATIVE_TEST_PROGRAMS_PATH="$_EXT_WORKSPACE_ROOT/codetracer-native-test-programs"
	_ext_detect_summary "codetracer-native-test-programs"
fi

# ---------------------------------------------------------------------------
# Backward compatibility: derive _PRESENT=1 from non-empty _PATH/_ROOT vars.
# ---------------------------------------------------------------------------
if [ -n "${CODETRACER_PATH:-}" ]; then
	export CODETRACER_PRESENT=1
fi
if [ -n "${CODETRACER_PYTHON_RECORDER_ROOT:-}" ]; then
	export CODETRACER_PYTHON_RECORDER_PRESENT=1
fi
if [ -n "${CODETRACER_RUBY_RECORDER_ROOT:-}" ]; then
	export CODETRACER_RUBY_RECORDER_PRESENT=1
fi
if [ -n "${CODETRACER_RR_BACKEND_PATH:-}" ]; then
	export CODETRACER_RR_BACKEND_PRESENT=1
fi
if [ -n "${CODETRACER_NATIVE_TEST_PROGRAMS_PATH:-}" ]; then
	export CODETRACER_NATIVE_TEST_PROGRAMS_PRESENT=1
fi

# ---------------------------------------------------------------------------
# Print summary to stderr (unless DETECT_SIBLINGS_QUIET=1)
# ---------------------------------------------------------------------------
if [ -z "${DETECT_SIBLINGS_QUIET:-}" ] && [ -n "$_EXT_DETECTED_SIBLINGS" ]; then
	echo "$_EXT_DETECTED_SIBLINGS" >&2
fi

# Clean up temporary variables.
unset _EXT_ROOT_DIR _EXT_WORKSPACE_ROOT _EXT_DETECTED_SIBLINGS
unset _ext_parent _ext_grandparent
unset -f _ext_try_workspace_root _ext_detect_summary
