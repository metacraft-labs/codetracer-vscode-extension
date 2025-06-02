#!/usr/bin/env bash

echo "INSIDE nix devshell"

npm install
just build
