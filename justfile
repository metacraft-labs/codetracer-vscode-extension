build:
    #!/usr/bin/env bash
    mkdir -p ./media
    mkdir -p ./backend

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
    npm run compile
    cp ./media/ct_vscode.js out/ct_vscode.js

    if [ ! -L ~/codetracer-data ] && [ ! -e ~/codetracer-data ]; then \
        ln -s ~/.local/share/codetracer ~/codetracer-data;
    fi

build-npm:
    npm run compile
