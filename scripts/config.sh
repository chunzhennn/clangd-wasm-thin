#!/usr/bin/env bash
# Shared configuration for the clangd wasm build.
#
# Keep the WASI SDK major version in sync with the LLVM version: the sysroot
# headers and the clang builtin headers must agree, otherwise the preprocessed
# standard library headers refuse to compile.
EMSDK_VER=${EMSDK_VER:-4.0.22}
WASI_SDK_VER=${WASI_SDK_VER:-29.0}
WASI_SDK_MAJOR=${WASI_SDK_MAJOR:-29}
LLVM_VER=${LLVM_VER:-21.1.0}
LLVM_VER_MAJOR=${LLVM_VER_MAJOR:-21}
BINARYEN_VER=${BINARYEN_VER:-version_123}

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ROOT=${ROOT:-$REPO_ROOT/.build}
JOBS=${JOBS:-$(nproc 2>/dev/null || echo 8)}
VARIANT=${VARIANT:-jspi}          # jspi | asyncify
INITIAL_MEMORY=${INITIAL_MEMORY:-512MB}
STAGE=$ROOT/sysroot-include
OUT=$ROOT/out/$VARIANT
PUBLIC=${PUBLIC:-$REPO_ROOT/public/wasm/$VARIANT}

die() { echo "!! $*" >&2; exit 1; }

case "$VARIANT" in
  jspi|asyncify) ;;
  *) die "VARIANT must be 'jspi' or 'asyncify' (got '$VARIANT')" ;;
esac
