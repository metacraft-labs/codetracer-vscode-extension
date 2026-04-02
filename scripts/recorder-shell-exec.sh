#!/usr/bin/env bash
# Shared helper for fixture preparation scripts.
#
# Provides `recorder_exec` which runs a command inside the recorder repo's
# dev shell. It tries multiple strategies in order:
#   1. direnv exec (fast — uses cached nix dev shell)
#   2. nix develop (slower — builds the dev shell from the repo's flake.nix)
#   3. bare execution (assumes tools are already on PATH)
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/recorder-shell-exec.sh"
#   recorder_exec "$RECORDER_DIR" cargo build --manifest-path "$RECORDER_DIR/Cargo.toml"
#   recorder_exec "$RECORDER_DIR" "$RECORDER_DIR/target/debug/my-binary" record ...

recorder_exec() {
  local repo_dir="$1"
  shift

  if command -v direnv >/dev/null 2>&1 && [ -f "$repo_dir/.envrc" ]; then
    direnv allow "$repo_dir"
    direnv exec "$repo_dir" "$@"
  elif [ -f "$repo_dir/flake.nix" ] && command -v nix >/dev/null 2>&1; then
    nix develop "$repo_dir" --accept-flake-config -c "$@"
  else
    "$@"
  fi
}
