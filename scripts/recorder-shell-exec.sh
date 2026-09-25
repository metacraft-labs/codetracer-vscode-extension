#!/usr/bin/env bash
# Shared helper for fixture preparation scripts.
#
# Provides `recorder_exec` which runs a command inside the recorder repo's
# dev shell through Repro. Repositories declaring repro.nim or a legacy .envrc
# must enter that environment successfully; failures never fall back to PATH.
# Repositories without either declaration retain the checked bare fallback.
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
  [ -n "${IN_NIX_SHELL:-}" ] || [ -n "${__REPRO_PROJECT_ROOT:-}" ]
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
    recorder_fail "repo has no environment declaration and current dev shell is missing required tool(s): ${missing[*]}"
    return 1
  fi
}

recorder_exec() {
  local repo_dir="$1"
  shift

  if [ -f "$repo_dir/repro.nim" ] || [ -f "$repo_dir/reprobuild.nim" ] || [ -f "$repo_dir/.envrc" ]; then
    if ! command -v repro >/dev/null 2>&1; then
      recorder_fail "repro is required to run commands in $repo_dir"
      return 1
    fi
    repro exec "$repo_dir" -- bash -c 'cd "$1" && shift && exec "$@"' recorder-exec "$PWD" "$@"
    return $?
  fi

  if ! recorder_in_known_dev_shell; then
    recorder_fail "$repo_dir has no environment declaration; refusing bare execution outside a known dev shell"
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
