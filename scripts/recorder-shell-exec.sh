#!/usr/bin/env bash
# Shared helper for fixture preparation scripts.
#
# Provides `recorder_exec` which runs a command inside the recorder repo's
# dev shell. Repos with an .envrc must run through `direnv exec`; if direnv
# cannot enter that shell, fixture preparation fails instead of falling back to
# whatever happens to be on PATH.
#
# Repos without an .envrc are allowed a strict bare fallback only when the
# caller is already inside a known dev shell and the obvious required tool(s)
# for the command are present. This keeps legacy repos usable without hiding a
# failed/interrupted dev-shell setup as a later "command not found" error.
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/recorder-shell-exec.sh"
#   recorder_exec "$RECORDER_DIR" cargo build --manifest-path "$RECORDER_DIR/Cargo.toml"
#   recorder_exec "$RECORDER_DIR" "$RECORDER_DIR/target/debug/my-binary" record ...

recorder_fail() {
  echo "ERROR: $*" >&2
  return 1
}

recorder_in_known_dev_shell() {
  [ -n "${IN_NIX_SHELL:-}" ] || [ -n "${DIRENV_DIR:-}" ]
}

recorder_required_tools() {
  local cmd="$1"
  local script="${2:-}"

  case "$cmd" in
    bash|sh)
      [ -n "$script" ] || return 0
      case "$script" in *cargo*) echo cargo ;; esac
      case "$script" in *"cargo build-sbf"*) echo cargo-build-sbf ;; esac
      case "$script" in *"go "*) echo go ;; esac
      case "$script" in *"sui "*) echo sui ;; esac
      ;;
    cargo)
      echo cargo
      [ "${2:-}" = "build-sbf" ] && echo cargo-build-sbf
      ;;
    sui|go|solc|anvil|cast|cargo-stylus|wazero)
      echo "$cmd"
      ;;
  esac
}

recorder_require_bare_fallback_tools() {
  local cmd="$1"
  local arg2="${2:-}"
  local script=""
  if { [ "$cmd" = "bash" ] || [ "$cmd" = "sh" ]; } && [ "$arg2" = "-c" ]; then
    script="${3:-}"
    arg2="$script"
  fi

  local tool
  local missing=()
  while IFS= read -r tool; do
    [ -n "$tool" ] || continue
    if ! command -v "$tool" >/dev/null 2>&1; then
      missing+=("$tool")
    fi
  done < <(recorder_required_tools "$cmd" "$arg2")

  if [ "${#missing[@]}" -gt 0 ]; then
    recorder_fail "repo has no .envrc and current dev shell is missing required tool(s): ${missing[*]}"
    return 1
  fi
}

recorder_exec() {
  local repo_dir="$1"
  shift

  if command -v direnv >/dev/null 2>&1 && [ -f "$repo_dir/.envrc" ]; then
    direnv allow "$repo_dir" 2>/dev/null || true
    direnv exec "$repo_dir" "$@"
    return $?
  fi

  if [ -f "$repo_dir/.envrc" ]; then
    recorder_fail "direnv is required to run commands in $repo_dir"
    return 1
  fi

  if ! recorder_in_known_dev_shell; then
    recorder_fail "$repo_dir has no .envrc; refusing bare execution outside a known dev shell"
    return 1
  fi

  recorder_require_bare_fallback_tools "$@" || return $?
  "$@"
}

recorder_target_dir() {
  local repo_dir="$1"
  if [ -n "${CARGO_TARGET_DIR:-}" ]; then
    printf '%s\n' "$CARGO_TARGET_DIR"
  else
    printf '%s\n' "$repo_dir/target"
  fi
}
