#!/usr/bin/env bash
# Phase 3 — a second Binaryen pass over the linked module.
#
# Emscripten already runs Binaryen internally, but an explicit -Oz pass over the
# whole module still shaves ~7% (74.3 MB -> 69.1 MB on the Asyncify variant,
# 49.8 MB -> 48.0 MB on the JSPI one).
#
# -Oz, not -O3: this workload is much faster when the module is smaller,
# because V8 spends its time on baseline compilation and the instruction cache,
# not on peak code quality (see docs/benchmarks.md).
set -euo pipefail
source "$(dirname "$0")/config.sh"

WASM_OPT=${WASM_OPT:-$ROOT/binaryen-$BINARYEN_VER/bin/wasm-opt}
IN=${IN:-$OUT/clangd.wasm}
OUT_FILE=${OUT_FILE:-$OUT/clangd.opt.wasm}

[ -x "$WASM_OPT" ] || die "wasm-opt not found at $WASM_OPT (run 01-toolchain.sh)"
[ -f "$IN" ] || die "missing $IN (run 02-clangd.sh first)"

echo "== wasm-opt -Oz ($(basename "$IN"))"
time "$WASM_OPT" "$IN" -Oz --all-features -o "$OUT_FILE"

sz() { ls -l "$1" | awk '{printf "%.1f MB", $5/1048576}'; }
gz() { gzip -9 -c "$1" | wc -c | awk '{printf "%.1f MB", $1/1048576}'; }
echo "   raw : $(sz "$IN") -> $(sz "$OUT_FILE")"
echo "   gzip: $(gz "$IN") -> $(gz "$OUT_FILE")"
