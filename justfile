build:
    #!/usr/bin/env bash
    mkdir -p ./media
    
    pushd libs/codetracer && \
    nix develop .#devShells.x86_64-linux.default --command ./build_ui_js.sh ../../media/ui.js && \
    popd;
    if [[ ! -e ./media/frontend_bundle.js && ! -f ./media/frontend_bundle.js ]]; then
        rm -f ./media/frontend_bundle.js
        ln -s $(pwd)/libs/codetracer/src/public/dist/frontend_bundle.js ./media/frontend_bundle.js
    fi;
    if [[ ! -e ./media/third_party && ! -d ./media/third_party ]]; then
        rm -rf ./media/third_party
        ln -s $(pwd)/libs/codetracer/src/public/third_party media/third_party
    fi;
    if [[ ! -e ./media/styles/default_dark_theme.css && ! -f ./media/styles/default_dark_theme.css ]]; then
        rm -f ./media/styles/default_dark_theme.css
        mkdir -p ./media/styles
        ln -s $(pwd)/libs/codetracer/src/build-debug/frontend/styles/default_dark_theme.css ./media/styles/default_dark_theme.css
    fi;
    npm run compile