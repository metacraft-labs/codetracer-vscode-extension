#!/usr/bin/env bash
# Prepare CodeTracer binaries and VS Code workspace settings for WDIO tests.

set -euo pipefail

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

canonical_dir() {
	local path="$1"
	[ -d "$path" ] || return 1
	(cd "$path" >/dev/null 2>&1 && pwd -P)
}

canonical_file() {
	local path="$1"
	local dir
	local base
	dir="$(cd "$(dirname "$path")" >/dev/null 2>&1 && pwd -P)" || return 1
	base="$(basename "$path")"
	[ -e "$dir/$base" ] || return 1
	printf '%s/%s\n' "$dir" "$base"
}

is_executable_file() {
	local path="$1"
	[ -n "$path" ] && [ -f "$path" ] && [ -x "$path" ]
}

resolve_explicit_binary() {
	local env_name="$1"
	local value="${!env_name:-}"

	if [ -z "$value" ]; then
		return 1
	fi
	if ! is_executable_file "$value"; then
		fail "$env_name does not point to an executable file: $value"
	fi
	canonical_file "$value" || fail "Could not resolve $env_name path: $value"
}

resolve_first_candidate() {
	local label="$1"
	shift
	local candidate
	local checked=()

	for candidate in "$@"; do
		checked+=("$candidate")
		if is_executable_file "$candidate"; then
			canonical_file "$candidate" || fail "Could not resolve $label path: $candidate"
			return 0
		fi
	done

	printf 'FAIL: %s binary not found. Checked:\n' "$label" >&2
	printf '  %s\n' "${checked[@]}" >&2
	exit 1
}

resolve_ct_binary() {
	if [ -n "${CODETRACER_CT_PATH:-}" ]; then
		resolve_explicit_binary CODETRACER_CT_PATH
		return 0
	fi

	resolve_first_candidate \
		"ct" \
		"$CODETRACER_REPO/result/bin/ct" \
		"$CODETRACER_REPO/src/build-debug/bin/ct"
}

resolve_dap_backend_binary() {
	if [ -n "${CODETRACER_DB_BACKEND_PATH:-}" ]; then
		resolve_explicit_binary CODETRACER_DB_BACKEND_PATH
		return 0
	fi

	resolve_first_candidate \
		"DAP backend" \
		"$CODETRACER_REPO/result/bin/db-backend" \
		"$CODETRACER_REPO/result/bin/replay-server" \
		"$CODETRACER_REPO/src/build-debug/bin/db-backend" \
		"$CODETRACER_REPO/src/build-debug/bin/replay-server" \
		"$CODETRACER_REPO/src/db-backend/target/debug/db-backend" \
		"$CODETRACER_REPO/src/db-backend/target/debug/replay-server"
}

resolve_codetracer_root() {
	local env_name
	local value
	local root

	for env_name in CODETRACER_PATH CODETRACER_DIR CODETRACER_ROOT; do
		value="${!env_name:-}"
		if [ -n "$value" ]; then
			root="$(canonical_dir "$value")" || fail "$env_name does not point to a directory: $value"
			if [ ! -d "$root/src" ]; then
				fail "$env_name does not look like a CodeTracer repo: $root"
			fi
			printf '%s\n' "$root"
			return 0
		fi
	done

	local old_quiet="${DETECT_SIBLINGS_QUIET-__unset__}"
	export DETECT_SIBLINGS_QUIET=1
	# shellcheck source=detect-siblings.sh
	source "$SCRIPT_DIR/detect-siblings.sh" "$REPO_ROOT"
	if [ "$old_quiet" = "__unset__" ]; then
		unset DETECT_SIBLINGS_QUIET
	else
		export DETECT_SIBLINGS_QUIET="$old_quiet"
	fi

	if [ -n "${CODETRACER_PATH:-}" ]; then
		root="$(canonical_dir "$CODETRACER_PATH")" || fail "CODETRACER_PATH from detect-siblings.sh is not a directory: $CODETRACER_PATH"
		printf '%s\n' "$root"
		return 0
	fi

	fail "CodeTracer repo not found. Set CODETRACER_PATH, CODETRACER_DIR, or CODETRACER_ROOT."
}

replace_symlink() {
	local source="$1"
	local target="$2"

	if [ -e "$target" ] || [ -L "$target" ]; then
		if [ -d "$target" ] && [ ! -L "$target" ]; then
			fail "Refusing to replace directory: $target"
		fi
		rm -f "$target"
	fi
	ln -s "$source" "$target"
}

write_workspace_settings() {
	local settings_dir="$REPO_ROOT/test/wdio/projects/stylus-test/.vscode"
	local settings_file="$settings_dir/settings.json"
	local runnable_path="$REPO_ROOT/.ct-bin/ct"

	mkdir -p "$settings_dir"
	command -v node >/dev/null 2>&1 || fail "node is required to write $settings_file"
	SETTINGS_FILE="$settings_file" RUNNABLE_PATH="$runnable_path" node <<'NODE'
const fs = require('fs');

const settingsFile = process.env.SETTINGS_FILE;
const runnablePath = process.env.RUNNABLE_PATH;
let settings = {};

try {
  if (fs.existsSync(settingsFile)) {
    const text = fs.readFileSync(settingsFile, 'utf8').trim();
    settings = text ? JSON.parse(text) : {};
  }
} catch (error) {
  console.error(`FAIL: could not read ${settingsFile}: ${error.message}`);
  process.exit(1);
}

settings['codetracer.runnablePath'] = runnablePath;

fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
NODE
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
CODETRACER_REPO="$(resolve_codetracer_root)"

CT_BINARY="$(resolve_ct_binary)"
DAP_BACKEND_BINARY="$(resolve_dap_backend_binary)"

mkdir -p "$REPO_ROOT/.ct-bin"
replace_symlink "$CT_BINARY" "$REPO_ROOT/.ct-bin/ct"
replace_symlink "$DAP_BACKEND_BINARY" "$REPO_ROOT/.ct-bin/db-backend"
write_workspace_settings

echo "CodeTracer WDIO setup:"
echo "  ct:         $CT_BINARY"
echo "  db-backend: $DAP_BACKEND_BINARY"
echo "  bin dir:    $REPO_ROOT/.ct-bin"
