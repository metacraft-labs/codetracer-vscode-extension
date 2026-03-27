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

# Run WDIO smoke tests (requires Xvfb on Linux)
test-wdio-smoke:
    #!/usr/bin/env bash
    set -euo pipefail
    # Start Xvfb for headless VS Code
    DISPLAY_NUM=99
    while [ -e "/tmp/.X${DISPLAY_NUM}-lock" ]; do
        DISPLAY_NUM=$((DISPLAY_NUM + 1))
    done
    Xvfb ":${DISPLAY_NUM}" -screen 0 1920x1080x24 -nolisten tcp &
    XVFB_PID=$!
    trap "kill $XVFB_PID 2>/dev/null || true" EXIT
    sleep 1
    export DISPLAY=":${DISPLAY_NUM}"
    npx wdio run wdio.conf.ts --spec test/wdio/specs/hello-vscode.e2e.ts

# Run WDIO Stylus trace tests (requires fixture + Xvfb)
test-wdio-stylus:
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
    npx wdio run wdio.conf.ts --spec test/wdio/specs/stylus-trace-load.e2e.ts

# Run all WDIO tests
test-wdio:
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
    npx wdio run wdio.conf.ts
