#!/usr/bin/env bash
# Phase 2 — build clangd for wasm32-wasi.
#
# Two passes, like the upstream build.sh: the first one produces a host-side
# `clang` resource directory (clang's builtin headers: stddef.h, stdarg.h, …),
# which is then copied into the staged sysroot and embedded in the second link.
#
# What this script does differently from upstream:
#   * embeds only the `wasm32-wasi` slice of the sysroot. The released
#     wasi-sysroot ships six copies of the C++ headers (c++/v1 + five target
#     dirs, 85 MB); upstream embeds all of them, which is ~60 MB of dead weight
#     in the wasm data segments.
#   * INITIAL_MEMORY=512MB instead of 2GB (ALLOW_MEMORY_GROWTH still grows to
#     4GB), so a weak device does not need a 2 GiB SharedArrayBuffer up front.
#   * no ASSERTIONS (the module is not a debugging build).
#   * VARIANT=jspi (default): the blocking stdin read suspends on a JS promise
#     (-sJSPI) instead of being instrumented by Asyncify. Same source, same
#     patch, ~20 MB smaller and ~2x faster on the first analysis.
#     VARIANT=asyncify keeps the upstream instrumentation for engines without
#     JSPI (Firefox/Safari as of 2026).
set -euo pipefail
source "$(dirname "$0")/config.sh"

cd "$ROOT"
# shellcheck disable=SC1091
source emsdk/emsdk_env.sh >/dev/null

BUILD="$ROOT/llvm-project/build"
SRC="$ROOT/llvm-project/llvm"

# --- patch clangd so that a blocking stdin read suspends instead of spins -----
cd "$ROOT/llvm-project"
if ! grep -q "__EMSCRIPTEN__" clang-tools-extra/clangd/JSONTransport.cpp; then
  echo "== applying patches/wait-stdin.patch"
  git apply "$(dirname "$0")/../patches/wait-stdin.patch"
else
  echo "== wait-stdin patch already applied"
fi
cd "$ROOT"

# --- stage the pruned sysroot ------------------------------------------------
if [ ! -d "$STAGE/wasm32-wasi" ]; then
  echo "== staging wasm32-wasi sysroot headers"
  mkdir -p "$STAGE"
  cp -r "wasi-sysroot-$WASI_SDK_VER/include/wasm32-wasi" "$STAGE/"
fi

COMMON=(
  -G Ninja -S "$SRC" -B "$BUILD"
  -DCMAKE_BUILD_TYPE=MinSizeRel
  -DLLVM_TARGET_ARCH=wasm32-emscripten
  -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-wasi
  -DLLVM_TARGETS_TO_BUILD=WebAssembly
  -DLLVM_ENABLE_PROJECTS="clang;clang-tools-extra"
  -DLLVM_TABLEGEN="$ROOT/llvm-project/build-native/bin/llvm-tblgen"
  -DCLANG_TABLEGEN="$ROOT/llvm-project/build-native/bin/clang-tblgen"
  -DLLVM_BUILD_STATIC=ON
  -DLLVM_INCLUDE_EXAMPLES=OFF
  -DLLVM_INCLUDE_TESTS=OFF
  -DLLVM_ENABLE_BACKTRACES=OFF
  -DLLVM_ENABLE_UNWIND_TABLES=OFF
  -DLLVM_ENABLE_CRASH_OVERRIDES=OFF
  -DCLANG_ENABLE_STATIC_ANALYZER=OFF
  -DLLVM_ENABLE_TERMINFO=OFF
  -DLLVM_ENABLE_PIC=OFF
  -DLLVM_ENABLE_ZLIB=OFF
  -DCLANG_ENABLE_ARCMT=OFF
)

CXXFLAGS="-pthread -Dwait4=__syscall_wait4"

[ -x "$ROOT/llvm-project/build-native/bin/clang-tblgen" ] || die "native tablegens missing, run scripts/01-toolchain.sh first"

# --- pass 1: build once to get clang's builtin headers -----------------------
if [ ! -f "$BUILD/CMakeCache.txt" ]; then
  echo "== pass 1: configure"
  emcmake cmake "${COMMON[@]}" \
    -DCMAKE_CXX_FLAGS="$CXXFLAGS" \
    -DCMAKE_EXE_LINKER_FLAGS="-pthread -s ENVIRONMENT=worker -s NO_INVOKE_RUN"
fi

if [ ! -f "$BUILD/bin/clangd.wasm" ] && [ ! -f "$BUILD/bin/clangd" ]; then
  echo "== pass 1: build (-j$JOBS, ~20 min)"
  cmake --build "$BUILD" --target clangd -j"$JOBS"
fi

echo "== copying clang builtin headers into the staged sysroot"
cp -r "$BUILD"/lib/clang/"$LLVM_VER_MAJOR"/include/* "$STAGE"/
echo "   staged sysroot: $(du -sh "$STAGE" | cut -f1)"

# --- pass 2: relink with the final flags ------------------------------------
LINKER="-pthread -s ENVIRONMENT=worker -s NO_INVOKE_RUN -s EXIT_RUNTIME"
LINKER="$LINKER -s INITIAL_MEMORY=$INITIAL_MEMORY -s ALLOW_MEMORY_GROWTH -s MAXIMUM_MEMORY=4GB"
LINKER="$LINKER -s STACK_SIZE=256kB -s EXPORTED_RUNTIME_METHODS=FS,callMain"
LINKER="$LINKER -s MODULARIZE -s EXPORT_ES6 -s WASM_BIGINT"
LINKER="$LINKER -s PTHREAD_POOL_SIZE='Math.max(navigator.hardwareConcurrency, 8)'"
case "$VARIANT" in
  jspi)     LINKER="$LINKER -s JSPI" ;;
  asyncify) LINKER="$LINKER -s ASYNCIFY" ;;
esac
LINKER="$LINKER --embed-file=$STAGE@/usr/include"

echo "== pass 2: configure ($VARIANT)"
emcmake cmake "${COMMON[@]}" \
  -DCMAKE_CXX_FLAGS="$CXXFLAGS" \
  -DCMAKE_EXE_LINKER_FLAGS="$LINKER"

echo "== pass 2: relink (-j$JOBS, ~2 min)"
cmake --build "$BUILD" --target clangd -j"$JOBS"

mkdir -p "$OUT"
cp "$BUILD/bin/clangd.js" "$BUILD/bin/clangd.wasm" "$OUT/"
echo "== $VARIANT built:"; ls -l "$OUT"
