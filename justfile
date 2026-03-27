build:
    #!/usr/bin/env bash
    mkdir -p ./media
    mkdir -p ./backend
    npm install

    pushd libs/codetracer && \
        nix develop \
            --extra-experimental-features nix-command \
            --extra-experimental-features flakes \
            .#devShells.x86_64-linux.default --command ./build_for_extension.sh ../../media/ui.js ../../media/ct_vscode.js ../../backend/db-backend && \
        popd;
    if [[ ! -e ./media/frontend_bundle.js && ! -f ./media/frontend_bundle.js ]]; then
        rm -f ./media/frontend_bundle.js
        ln -s $(pwd)/libs/codetracer/src/public/dist/frontend_bundle.js ./media/frontend_bundle.js
    fi;
    if [[ ! -e ./media/third_party && ! -d ./media/third_party ]]; then
        rm -rf ./media/third_party
        ln -s $(pwd)/libs/codetracer/src/public/third_party media/third_party
    fi;
    if [[ ! -e ./media/styles/default_dark_theme_extension.css && ! -f ./media/styles/default_dark_theme_extension.css ]]; then
        rm -f ./media/styles/default_dark_theme_extension.css
        mkdir -p ./media/styles
        ln -s $(pwd)/libs/codetracer/src/build-debug/frontend/styles/default_dark_theme_extension.css ./media/styles/default_dark_theme_extension.css
    fi;
    if [[ ! -e ./media/fonts/SpaceGrotesk-VariableFont_wght.ttf && ! -f ./media/fonts/SpaceGrotesk-VariableFont_wght.ttf ]]; then
        rm -f ./media/fonts/SpaceGrotesk-VariableFont_wght.ttf
        mkdir -p ./media/fonts
        ln -s $(pwd)/libs/codetracer/src/public/resources/fonts/space_grotesk/SpaceGrotesk-VariableFont_wght.ttf ./media/fonts/SpaceGrotesk-VariableFont_wght.ttf
    fi;

    npm run compile:ts
    cp ./media/ct_vscode.js out/ct_vscode.js

# TypeScript-only build (no Nim/Rust dependencies)
build-npm:
    npm run compile:ts
    cp ./media/ct_vscode.js out/ct_vscode.js

# --- CI targets ---

# Install npm dependencies
install:
    npm ci

# Run ESLint
lint:
    npm run lint

# Compile TypeScript and verify output
compile-ts:
    npm run compile:ts
    test -f out/extension.js

# Helper: start Xvfb and run a command with DISPLAY set.
# Usage: just _xvfb-run "npx wdio run wdio.conf.ts --spec ..."
[private]
_xvfb-run +CMD:
    #!/usr/bin/env bash
    set -euo pipefail
    DISPLAY_NUM=99
    while [ -e "/tmp/.X${DISPLAY_NUM}-lock" ]; do
        DISPLAY_NUM=$((DISPLAY_NUM + 1))
    done
    Xvfb ":${DISPLAY_NUM}" -screen 0 1920x1080x24 -nolisten tcp &
    XVFB_PID=$!
    trap "kill $XVFB_PID 2>/dev/null || true" EXIT
    sleep 1
    export DISPLAY=":${DISPLAY_NUM}"
    {{CMD}}

# Run WDIO hello-world smoke test (no sibling repos needed)
test-wdio-smoke:
    just _xvfb-run "npx wdio run wdio.conf.ts --spec test/wdio/specs/hello-vscode.e2e.ts"

# Record test traces from sibling repos (idempotent, skips existing)
record-test-traces *LANGS:
    #!/usr/bin/env bash
    set -euo pipefail
    bash scripts/record-test-traces.sh {{LANGS}}

# Run per-language smoke tests (requires sibling repos + recorded traces)
test-wdio-smoke-langs: record-test-traces
    just _xvfb-run "npx wdio run wdio.conf.ts --spec 'test/wdio/specs/smoke/*.e2e.ts'"

# Run WDIO Stylus trace tests (requires fixture + Xvfb)
test-wdio-stylus:
    just _xvfb-run "npx wdio run wdio.conf.ts --spec test/wdio/specs/deep/stylus-trace-load.e2e.ts"

# Run WDIO deep tests (requires traces + Xvfb)
test-wdio-deep:
    just _xvfb-run "npx wdio run wdio.conf.ts --spec 'test/wdio/specs/deep/*.e2e.ts'"

# Run all WDIO tests
test-wdio:
    just _xvfb-run "npx wdio run wdio.conf.ts"
