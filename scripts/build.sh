#!/usr/bin/env bash
# One-shot build: toolchain -> clangd -> wasm-opt -> publish into public/wasm.
#
#   ./scripts/build.sh                      # JSPI build (Chrome/Edge 137+)
#   VARIANT=asyncify ./scripts/build.sh     # Asyncify build (every engine)
#   JOBS=12 ROOT=/data/clangd ./scripts/build.sh
#
# Artifacts end up in public/wasm/$VARIANT/{clangd.js,clangd.wasm}.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/config.sh"

"$HERE/01-toolchain.sh"
"$HERE/02-clangd.sh"
"$HERE/03-optimize.sh"

mkdir -p "$PUBLIC"
cp "$OUT/clangd.opt.wasm" "$PUBLIC/clangd.wasm"
cp "$OUT/clangd.js" "$PUBLIC/clangd.js"
echo "== published to $PUBLIC"
ls -l "$PUBLIC"
