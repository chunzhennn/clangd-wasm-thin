#!/usr/bin/env bash
# Phase 1 — toolchain: emsdk, WASI sysroot, LLVM sources, native tablegens.
#
# Everything lands in $ROOT and is reused between runs (only the first run is slow).
set -euo pipefail
source "$(dirname "$0")/config.sh"

mkdir -p "$ROOT" && cd "$ROOT"

if [ ! -d emsdk ]; then
  echo "== cloning emsdk $EMSDK_VER"
  git clone --branch "$EMSDK_VER" --depth 1 https://github.com/emscripten-core/emsdk
fi
if [ ! -f emsdk/upstream/emscripten/emcc ]; then
  echo "== installing emsdk $EMSDK_VER"
  (cd emsdk && ./emsdk install "$EMSDK_VER" && ./emsdk activate "$EMSDK_VER")
fi

if [ ! -d "wasi-sysroot-$WASI_SDK_VER" ]; then
  echo "== downloading wasi-sysroot $WASI_SDK_VER"
  curl -L --retry 3 -o wasi-sysroot.tar.gz \
    "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$WASI_SDK_MAJOR/wasi-sysroot-$WASI_SDK_VER.tar.gz"
  tar -xzf wasi-sysroot.tar.gz
fi

if [ ! -d llvm-project ]; then
  echo "== cloning llvm $LLVM_VER (shallow)"
  git clone --branch "llvmorg-$LLVM_VER" --depth 1 https://github.com/llvm/llvm-project llvm-project
fi

if [ ! -x llvm-project/build-native/bin/clang-tblgen ]; then
  echo "== building native tablegens (-j$JOBS, ~5 min)"
  cmake -G Ninja -S llvm-project/llvm -B llvm-project/build-native \
    -DCMAKE_BUILD_TYPE=Release \
    -DLLVM_ENABLE_PROJECTS=clang \
    -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
    -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_TERMINFO=OFF
  cmake --build llvm-project/build-native --target llvm-tblgen clang-tblgen -j"$JOBS"
fi

if [ ! -x "binaryen-$BINARYEN_VER/bin/wasm-opt" ]; then
  echo "== downloading binaryen $BINARYEN_VER"
  curl -L --retry 3 -o binaryen.tar.gz \
    "https://github.com/WebAssembly/binaryen/releases/download/$BINARYEN_VER/binaryen-$BINARYEN_VER-x86_64-linux.tar.gz"
  tar -xzf binaryen.tar.gz
fi

echo "== phase 1 done"
