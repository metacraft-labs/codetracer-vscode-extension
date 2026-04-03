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

  # Strategy 1: direnv exec (fast — uses cached nix dev shell).
  # Falls through if direnv or the dev shell evaluation fails (e.g., in CI
  # where mcl-blockchain flake attributes may not be available).
  if command -v direnv >/dev/null 2>&1 && [ -f "$repo_dir/.envrc" ]; then
    direnv allow "$repo_dir" 2>/dev/null || true
    if direnv exec "$repo_dir" "$@"; then
      return 0
    fi
    echo "  (direnv exec failed, falling back to bare execution)" >&2
  fi

  # Strategy 2: nix develop (slower — builds the dev shell from flake.nix).
  # Skipped in CI where the outer nix develop already provides tools.
  if [ -z "${CI:-}" ] && [ -f "$repo_dir/flake.nix" ] && command -v nix >/dev/null 2>&1; then
    if nix develop "$repo_dir" --accept-flake-config -c "$@"; then
      return 0
    fi
    echo "  (nix develop failed, falling back to bare execution)" >&2
  fi

  # Strategy 3: bare execution (assumes tools are already on PATH,
  # e.g., from an outer nix develop wrapper in the CI workflow).
  "$@"
}
