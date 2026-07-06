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

find_first_candidate() {
	shift
	local candidate

	for candidate in "$@"; do
		if is_executable_file "$candidate"; then
			canonical_file "$candidate" || fail "Could not resolve candidate path: $candidate"
			return 0
		fi
	done

	return 1
}

run_in_repo_env() {
	local repo="$1"
	shift
	(
		cd "$repo"
		direnv exec . "$@"
	)
}

ensure_codetracer_runtime_assets() {
	local src_config="$CODETRACER_REPO/src/config"
	local build_config="$CODETRACER_REPO/src/build-debug/config"

	if [ ! -d "$src_config" ]; then
		fail "CodeTracer source config directory not found: $src_config"
	fi
	if [ ! -d "$CODETRACER_REPO/src/build-debug" ]; then
		return 0
	fi
	if [ -f "$build_config/default_config.yaml" ]; then
		return 0
	fi

	echo "CodeTracer debug config assets missing; copying src/config into build-debug/config ..." >&2
	mkdir -p "$build_config"
	cp -R "$src_config/." "$build_config/"
}

ensure_python_recorder_installed() {
	local recorder_repo="$CODETRACER_REPO/../codetracer-python-recorder"
	local python="$CODETRACER_REPO/.python-recorder-venv/bin/python"
	local venv="$CODETRACER_REPO/.python-recorder-venv"

	[ -d "$recorder_repo/codetracer-python-recorder" ] || return 0
	[ -x "$python" ] || return 0

	if "$python" -c 'import codetracer_python_recorder' >/dev/null 2>&1; then
		return 0
	fi

	echo "Installing codetracer_python_recorder into CodeTracer venv with sibling dev shell ..." >&2
	run_in_repo_env "$recorder_repo" bash -lc \
		'export VIRTUAL_ENV="$1"; export PYO3_PYTHON="$2"; export PATH="$1/bin:$PATH"; exec maturin develop --manifest-path codetracer-python-recorder/Cargo.toml --features integration-test' \
		bash "$venv" "$python"

	"$python" -c 'import codetracer_python_recorder' >/dev/null 2>&1 ||
		fail "codetracer_python_recorder is still not importable from $python after maturin develop"
}

ensure_python_recorder_shim() {
	local recorder="$CODETRACER_REPO/.python-recorder-venv/bin/codetracer-python-recorder"
	local python="$CODETRACER_REPO/.python-recorder-venv/bin/python"

	if [ -x "$recorder" ]; then
		mkdir -p "$REPO_ROOT/.ct-bin"
		replace_symlink "$recorder" "$REPO_ROOT/.ct-bin/codetracer-python-recorder"
	fi
	if [ -x "$python" ]; then
		mkdir -p "$REPO_ROOT/.ct-bin"
		replace_symlink "$python" "$REPO_ROOT/.ct-bin/python"
		replace_symlink "$python" "$REPO_ROOT/.ct-bin/python3"
	fi
}

ensure_beam_recorder_built() {
	local recorder_repo="$CODETRACER_REPO/../codetracer-beam-recorder"

	[ -d "$recorder_repo" ] || return 0
	if [ -x "$recorder_repo/target/debug/codetracer-beam-recorder" ] ||
	   [ -x "$recorder_repo/target/release/codetracer-beam-recorder" ]; then
		return 0
	fi

	echo "codetracer-beam-recorder binary missing; building sibling recorder with direnv exec ..." >&2
	run_in_repo_env "$recorder_repo" just build
}

ensure_mcr_recorder_shim() {
	local recorder_repo="$CODETRACER_REPO/../codetracer-native-recorder"
	local mcr="$recorder_repo/ct_cli/ct_cli"

	[ -d "$recorder_repo" ] || return 0
	if [ ! -x "$mcr" ]; then
		echo "ct-mcr binary missing; building sibling native recorder with direnv exec ..." >&2
		run_in_repo_env "$recorder_repo" just build-ct-mcr
	fi
	if [ -x "$mcr" ]; then
		mkdir -p "$REPO_ROOT/.ct-bin"
		replace_symlink "$mcr" "$REPO_ROOT/.ct-bin/ct-mcr"
	fi
}

ensure_nim_compiler_shim() {
	local nim_repo="$CODETRACER_REPO/../codetracer-nim"
	local nim_exe=""

	[ -d "$nim_repo" ] || return 0
	if [ -x "$nim_repo/bin/nim" ]; then
		nim_exe="$nim_repo/bin/nim"
	elif command -v direnv >/dev/null 2>&1 && [ -f "$nim_repo/.envrc" ]; then
		nim_exe="$(run_in_repo_env "$nim_repo" bash -lc 'command -v nim' 2>/dev/null || true)"
	fi

	if [ -n "$nim_exe" ] && [ -x "$nim_exe" ]; then
		mkdir -p "$REPO_ROOT/.ct-bin"
		replace_symlink "$nim_exe" "$REPO_ROOT/.ct-bin/nim"
	fi
}

ensure_js_recorder_shim() {
	local recorder_repo="$CODETRACER_REPO/../codetracer-js-recorder"
	local package_bin="$recorder_repo/result/bin/codetracer-js-recorder"
	local local_bin="$recorder_repo/packages/cli/dist/index.js"
	local native_addon="$recorder_repo/crates/recorder_native/index.node"

	[ -d "$recorder_repo" ] || return 0
	mkdir -p "$REPO_ROOT/.ct-bin"

	if [ -x "$package_bin" ]; then
		replace_symlink "$package_bin" "$REPO_ROOT/.ct-bin/codetracer-js-recorder"
		return 0
	fi

	if [ -f "$local_bin" ] && [ -f "$native_addon" ]; then
		cat >"$REPO_ROOT/.ct-bin/codetracer-js-recorder" <<EOF
#!/usr/bin/env bash
exec node "$local_bin" "\$@"
EOF
		chmod +x "$REPO_ROOT/.ct-bin/codetracer-js-recorder"
		return 0
	fi

	if [ -f "$recorder_repo/flake.nix" ]; then
		echo "codetracer-js-recorder package missing; building sibling JS recorder package with nix ..." >&2
		if ! run_in_repo_env "$recorder_repo" nix build .#default; then
			echo "codetracer-js-recorder nix package build failed; falling back to local native build ..." >&2
		fi
		if [ -x "$package_bin" ]; then
			replace_symlink "$package_bin" "$REPO_ROOT/.ct-bin/codetracer-js-recorder"
			return 0
		fi
	fi

	if [ ! -f "$local_bin" ] || [ ! -f "$native_addon" ]; then
		echo "codetracer-js-recorder CLI missing; building sibling JS recorder with direnv exec ..." >&2
		run_in_repo_env "$recorder_repo" bash -lc '
			if [ ! -d node_modules ]; then
				npm install
			fi
			cd crates/recorder_native
			cargo build --release
			ext=so
			case "$(uname -s)" in Darwin) ext=dylib ;; esac
			cp "target/release/libcodetracer_js_recorder_native.$ext" index.node
			cd ../..
			npm run build
		'
	fi

	if [ -f "$local_bin" ] && [ -f "$native_addon" ]; then
		cat >"$REPO_ROOT/.ct-bin/codetracer-js-recorder" <<EOF
#!/usr/bin/env bash
exec node "$local_bin" "\$@"
EOF
		chmod +x "$REPO_ROOT/.ct-bin/codetracer-js-recorder"
	fi
}

ensure_ruby_recorder_shim() {
	local recorder_repo="$CODETRACER_REPO/../codetracer-ruby-recorder"
	local package_bin="$recorder_repo/result/bin/codetracer-ruby-recorder"
	local source_bin="$recorder_repo/gems/codetracer-ruby-recorder/bin/codetracer-ruby-recorder"

	[ -d "$recorder_repo" ] || return 0
	mkdir -p "$REPO_ROOT/.ct-bin"

	if [ -x "$package_bin" ]; then
		replace_symlink "$package_bin" "$REPO_ROOT/.ct-bin/codetracer-ruby-recorder"
		return 0
	fi

	if [ ! -x "$source_bin" ]; then
		return 0
	fi

	replace_symlink "$source_bin" "$REPO_ROOT/.ct-bin/codetracer-ruby-recorder"
}

ensure_native_replay_shim() {
	local backend_repo="$CODETRACER_REPO/../codetracer-native-backend"
	local replay="$backend_repo/target/debug/ct-native-replay"

	[ -d "$backend_repo" ] || return 0
	if [ ! -x "$replay" ]; then
		echo "ct-native-replay binary missing; building sibling native backend with direnv exec ..." >&2
		run_in_repo_env "$backend_repo" just build
	fi
	if [ -x "$replay" ]; then
		mkdir -p "$REPO_ROOT/.ct-bin"
		replace_symlink "$replay" "$REPO_ROOT/.ct-bin/ct-native-replay"
		replace_symlink "$replay" "$REPO_ROOT/.ct-bin/ct-rr-support"
	fi
}

ensure_native_recorder_shim() {
	local recorder_repo="$CODETRACER_REPO/../codetracer-native-recorder"
	local mcr="$recorder_repo/ct_cli/ct_cli"

	[ -d "$recorder_repo" ] || return 0
	if [ ! -x "$mcr" ]; then
		echo "codetracer-native-recorder binary missing; building sibling native recorder with direnv exec ..." >&2
		run_in_repo_env "$recorder_repo" just build-ct-mcr
	fi
	if [ -x "$mcr" ]; then
		mkdir -p "$REPO_ROOT/.ct-bin"
		replace_symlink "$mcr" "$REPO_ROOT/.ct-bin/codetracer-native-recorder"
	fi
}

build_codetracer_if_needed() {
	local ct_ready=0
	local dap_ready=0

	if [ -n "${CODETRACER_CT_PATH:-}" ]; then
		resolve_explicit_binary CODETRACER_CT_PATH >/dev/null
		ct_ready=1
	elif find_first_candidate \
		"ct" \
		"$CODETRACER_REPO/result/bin/ct" \
		"$CODETRACER_REPO/src/build-debug/bin/ct" >/dev/null; then
		ct_ready=1
	fi

	if [ -n "${CODETRACER_DB_BACKEND_PATH:-}" ]; then
		resolve_explicit_binary CODETRACER_DB_BACKEND_PATH >/dev/null
		dap_ready=1
	elif find_first_candidate \
		"DAP backend" \
		"$CODETRACER_REPO/result/bin/db-backend" \
		"$CODETRACER_REPO/result/bin/replay-server" \
		"$CODETRACER_REPO/src/db-backend/target/debug/db-backend" \
		"$CODETRACER_REPO/src/db-backend/target/debug/replay-server" \
		"$CODETRACER_REPO/src/build-debug/bin/db-backend" \
		"$CODETRACER_REPO/src/build-debug/bin/replay-server" >/dev/null; then
		dap_ready=1
	fi

	if [ "$ct_ready" = 1 ] && [ "$dap_ready" = 1 ]; then
		return 0
	fi

	echo "CodeTracer binaries missing; building sibling codetracer with direnv exec ..." >&2
	if ! command -v direnv >/dev/null 2>&1; then
		fail "direnv is required to build sibling codetracer for WDIO fixtures"
	fi
	(
		cd "$CODETRACER_REPO"
		direnv exec . just build-once
	)
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
		"$CODETRACER_REPO/src/db-backend/target/debug/db-backend" \
		"$CODETRACER_REPO/src/db-backend/target/debug/replay-server" \
		"$CODETRACER_REPO/src/build-debug/bin/db-backend" \
		"$CODETRACER_REPO/src/build-debug/bin/replay-server"
}

resolve_mcr_emulator_library() {
	local candidate

	for candidate in \
		"$CODETRACER_REPO/src/build-debug/bin/libmcr_emulator.so" \
		"$CODETRACER_REPO/src/build-debug/bin/libmcr_emulator.dylib" \
		"$CODETRACER_REPO/src/db-backend/target/debug/libmcr_emulator.so" \
		"$CODETRACER_REPO/src/db-backend/target/debug/libmcr_emulator.dylib"; do
		if [ -f "$candidate" ]; then
			canonical_file "$candidate"
			return 0
		fi
	done

	find "$CODETRACER_REPO/src/db-backend/target/debug/build" \
		-type f \( -name 'libmcr_emulator.so' -o -name 'libmcr_emulator.dylib' \) \
		-printf '%T@ %p\n' 2>/dev/null \
		| sort -nr \
		| awk 'NR == 1 { $1 = ""; sub(/^ /, ""); print; }'
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
	local rr_worker_path="$REPO_ROOT/.ct-bin/ct-native-replay"
	local rr_exe_path

	rr_exe_path="$(command -v rr 2>/dev/null || true)"

	mkdir -p "$settings_dir"
	command -v node >/dev/null 2>&1 || fail "node is required to write $settings_file"
	SETTINGS_FILE="$settings_file" RUNNABLE_PATH="$runnable_path" RR_WORKER_PATH="$rr_worker_path" RR_EXE_PATH="$rr_exe_path" node <<'NODE'
const fs = require('fs');

const settingsFile = process.env.SETTINGS_FILE;
const runnablePath = process.env.RUNNABLE_PATH;
const rrWorkerPath = process.env.RR_WORKER_PATH;
const rrExePath = process.env.RR_EXE_PATH;
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
if (rrWorkerPath && fs.existsSync(rrWorkerPath)) {
  settings['codetracer.rrWorkerPath'] = rrWorkerPath;
}
if (rrExePath && fs.existsSync(rrExePath)) {
  settings['codetracer.rrExePath'] = rrExePath;
}

fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
NODE
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
CODETRACER_REPO="$(resolve_codetracer_root)"

build_codetracer_if_needed
ensure_codetracer_runtime_assets
ensure_python_recorder_installed
ensure_python_recorder_shim
ensure_beam_recorder_built

CT_BINARY="$(resolve_ct_binary)"
DAP_BACKEND_BINARY="$(resolve_dap_backend_binary)"

mkdir -p "$REPO_ROOT/.ct-bin"
replace_symlink "$CT_BINARY" "$REPO_ROOT/.ct-bin/ct"
replace_symlink "$DAP_BACKEND_BINARY" "$REPO_ROOT/.ct-bin/db-backend"
replace_symlink "$DAP_BACKEND_BINARY" "$REPO_ROOT/.ct-bin/replay-server"
MCR_EMULATOR_LIB="$(resolve_mcr_emulator_library || true)"
if [ -n "$MCR_EMULATOR_LIB" ]; then
	replace_symlink "$MCR_EMULATOR_LIB" "$REPO_ROOT/.ct-bin/$(basename "$MCR_EMULATOR_LIB")"
fi
ensure_mcr_recorder_shim
ensure_nim_compiler_shim
ensure_js_recorder_shim
ensure_ruby_recorder_shim
ensure_native_replay_shim
ensure_native_recorder_shim
write_workspace_settings

echo "CodeTracer WDIO setup:"
echo "  ct:         $CT_BINARY"
echo "  db-backend: $DAP_BACKEND_BINARY"
if [ -n "${MCR_EMULATOR_LIB:-}" ]; then
	echo "  mcr lib:    $MCR_EMULATOR_LIB"
fi
echo "  bin dir:    $REPO_ROOT/.ct-bin"
