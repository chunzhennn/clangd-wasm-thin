# Internals

What changed relative to [clangd-in-browser](https://github.com/guyutongxue/clangd-in-browser),
why it is safe, and what did **not** work.

## 1. Sysroot pruning

clangd resolves `#include <vector>` through the sysroot that is embedded in the module with
`--embed-file`. The released `wasi-sysroot-29.0` contains:

```
include/wasm32-wasi           17 MB   ← libc++ + libc for the default target
include/wasm32-wasi-threads   17 MB
include/wasm32-wasip1         17 MB
include/wasm32-wasip1-threads 17 MB
include/wasm32-wasip2         17 MB
include/c++                    8 KB   ← v1 inside each of the above
--------------------------------------------------
total                         85 MB
```

Every target directory carries the same libc++ headers again (they are the bulk of the 17 MB).
Upstream embeds the whole `include/` tree: 85 MB of text, of which 77.7 MB lands in the wasm
data segments, and all of it is parsed by the module loader at startup. Only one copy is reachable,
because clangd's `.clangd` file adds

```
-isystem/usr/include/wasm32-wasi/c++/v1
-isystem/usr/include
-isystem/usr/include/wasm32-wasi
```

so this build stages only `include/wasm32-wasi` (17 MB), adds clang's builtin headers
(`lib/clang/21/include`, ~8 MB: `stddef.h`, `stdarg.h`, intrinsics) and embeds 25 MB — data
segments drop from 77.7 MB to 25.9 MB. Nothing becomes unreachable: the surviving tree is the
same one the `-isystem` flags point at, and it is self-contained.

## 2. Memory

`-sINITIAL_MEMORY=512MB` (upstream: `2GB`) with `-sALLOW_MEMORY_GROWTH -sMAXIMUM_MEMORY=4GB`.
The module imports its memory (pthreads), so the host page has to provide a `SharedArrayBuffer`
of at least the declared initial size at instantiation time. 512 MiB is enough for clangd to
start and index a small workspace, and the heap grows on demand afterwards; 2 GiB up front is a
hard requirement that many devices cannot satisfy.

## 3. JSPI instead of Asyncify

`patches/wait-stdin.patch` turns clangd's blocking read into

```cpp
EM_ASYNC_JS(void, waitForStdin, (), { await Module.stdinReady(); })
```

which Emscripten implements in one of two ways:

- **Asyncify** (`-sASYNCIFY`): every function in the module is rewritten into a state machine
  that can unwind its stack into a side buffer and rewind it later. Correct everywhere, but it
  adds code to every function and a check to every call, and the unwind buffer costs memory.
- **JSPI** (`-sJSPI`, Emscripten maps it to `ASYNCIFY=2`): the engine itself can suspend a wasm
  stack on a JS promise. No instrumentation, no unwind buffer, nothing added to the hot path.

Both suspends happen at the same `await`, so the source patch is identical — only the link flag
changes (`scripts/02-clangd.sh`, `VARIANT`).

Why it matters beyond size: clangd's `read()` sits on the hot path of *every* LSP message, and
the AST/preamble work is thousands of nested calls. With Asyncify the machine spends ~2.5x the
CPU on the same analysis (46.4 s vs 18.7 s on the 5-header file from the benchmarks).

Browser support: JSPI shipped in Chrome/Edge 137. Firefox and Safari do not have it yet, which is
why `VARIANT=asyncify` exists.

## 4. Smaller details

- `-sASSERTIONS` off (upstream leaves it on; it is a debugging aid).
- `-sSTACK_SIZE=256kB`, `-sPTHREAD_POOL_SIZE='Math.max(navigator.hardwareConcurrency, 8)'`
  (unchanged from upstream).
- A second, explicit `wasm-opt -Oz --all-features` pass over the linked module: −7%.
- The glue and the wasm keep their file names (the glue spawns pthread workers with
  `new URL("clangd.js", import.meta.url)`); hash the directory if you need cache busting.

## Negative results

Things that sound like optimizations and are not, in this workload. All measured the same way as
the numbers above.

### `Release` (`-O2`) instead of `MinSizeRel` (`-Os`)

| | `-Os` (shipped) | `-O2` |
| --- | --- | --- |
| wasm | 48.0 MB | 61.1 MB |
| first diagnostic | 2.52–2.88 s | **3.41–3.48 s** |
| CPU for the analysis | 18.8–20.2 s | **25.5 s** |
| single-line edit | 89–188 ms | 196–247 ms |

A wasm module is compiled again by the engine (baseline + tier-up). 23% more code costs more
than `-O2` buys back for a parser that is already dominated by template instantiation.
**Smaller is faster here.**

### `wasm-opt -O3` instead of `-Oz`

Same `-Os` build, different final pass: 2.95 s first diagnostic vs 2.52–2.88 s for `-Oz`, CPU
identical. Stick with `-Oz`.

### `--background-index=0`

clangd's background indexer kicks in right after the preamble is built ("Indexing c++23 standard
library…"). Disabling it changed nothing measurable (2.91 s vs 2.79–2.88 s, edits unchanged) —
the indexer runs *after* the diagnostics are published, and on more than two cores it does not
steal meaningful time. It stays on.

### `-sPROXY_TO_PTHREAD`

Idea: run `main()` on a pthread so the worker's JS main thread stays free. It breaks this
integration: the `FS.streams[0]` override that provides stdin is installed on the JS main
thread's filesystem, and the pthread that actually runs `clangd` has its own FS instance, so
clangd sees no input and dies with `Transport error: I/O error` immediately after `initialize`.

### Dropping Asyncify *without* JSPI (SharedArrayBuffer + `Atomics.wait`)

Idea: let the worker really block on a `SharedArrayBuffer` ring buffer. The build works (48 MB)
and clangd starts, but every request then stalls for ~20 s: once `main()` parks in `Atomics.wait`,
the worker's JS main thread never returns to its event loop, and Emscripten's cross-thread
machinery (mailbox wake-ups, `Atomics.waitAsync`, `_proc_exit` proxying) needs it. First
diagnostic went from 5 s to 164 s. JSPI is the way to get this without instrumentation.

## Build system notes

- Two passes are unavoidable: the first one produces `build/lib/clang/21/include` (clang's
  builtin headers), which must exist *before* the `--embed-file` link.
- Switching `VARIANT` only recompiles the patched `JSONTransport.cpp` and relinks (~2 min).
- `ROOT` holds emsdk, wasi-sysroot, LLVM sources, the native tablegens, the build tree and
  Binaryen: ~6 GB after a full build.
