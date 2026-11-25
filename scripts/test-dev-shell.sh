#!/usr/bin/env bash
# Exercise the real locked flake; evaluation needs no foreign-system builders.
set -euo pipefail
cd "$(dirname "$0")/.."
for system in aarch64-darwin x86_64-darwin x86_64-linux aarch64-linux; do
    echo "Checking dev shell: $system"
    shell=".#devShells.$system.default"
    # shellHook alone misses unsupported inputs that are not interpolated there.
    hook="$(nix eval --no-write-lock-file --raw "$shell" \
        --apply 'shell: shell.drvPath + "\n" + shell.shellHook')"
    for variable in LD_LIBRARY_PATH CHROMEDRIVER_PATH PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD FONTCONFIG_FILE; do
        if [[ "$system" == *-darwin ]]; then
            if [[ "$hook" == *"export $variable="* ]]; then
                echo "$system exports Linux-only $variable" >&2
                exit 1
            fi
        else
            [[ "$hook" == *"export $variable="* ]]
        fi
    done
    [[ "$hook" == *'export VSCODE_INSIDERS_PATH='* ]]
    [[ "$hook" == *'export VSCODE_INSIDERS_EXECUTABLE='* ]]
    if [[ "$system" == *-darwin ]]; then
        [[ "$hook" == *'/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Electron'* ]]
    else
        [[ "$hook" == *'/lib/vscode/code-insiders'* ]]
    fi
done
