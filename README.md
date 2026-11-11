# clangd.wasm-thin

**clangd 21 in the browser — 48 MB instead of 121 MB, and 2x faster on the first analysis.**

[clangd](https://clangd.llvm.org) normally runs as a native process next to your editor.
[guyutongxue/clangd-in-browser](https://github.com/guyutongxue/clangd-in-browser) showed that it
can also run *inside* the browser as a WebAssembly module with pthreads, and that gives you real
C++ IntelliSense — real clang diagnostics, completion, go-to-definition — with no server at all.

The catch is the payload: the upstream `build.sh` produces a **121 MB** wasm (90 MB in the
older releases), needs a **2 GiB** `SharedArrayBuffer` up front, and instruments the whole
module with **Asyncify** just to make `read(0, …)` block.

This repo is a build of the same clangd 21 that fixes all three, without changing a single
line of clang's behaviour:

| | upstream `build.sh` | **clangd.wasm-thin (JSPI)** | delta |
| --- | --- | --- | --- |
| `clangd.wasm` | 121 MB | **48.0 MB** | **−60%** |
| `clangd.wasm` (gzip −9) | 24.9 MiB | **11.4 MiB** | **−54%** |
| initial memory | 2 GiB | **512 MiB** | −75% |
| first analysis of a 5-header file | 5.2 s | **2.6 s** | **−50%** |
| CPU spent on it | 49.7 s | **18.7 s** | −62% |
| peak renderer RSS | 1.94 GB | **1.76 GB** | −9% |
| bytes of code instrumented by Asyncify | all | **none** | — |

Measured on 16 cores / Chrome 155 / localhost, same LLVM revision, same sysroot content —
see [docs/benchmarks.md](docs/benchmarks.md) for the methodology and the full numbers
(including the Asyncify variant of this repo and a 2-core machine).

## What is different

### 1. Only one copy of the standard library is embedded (121 MB → 69 MB)

clangd needs the C++ headers at runtime, so the build embeds a sysroot into the module with
`--embed-file`. The released `wasi-sysroot` ships **six** copies of the same headers
(`include/c++/v1` plus one under each target triple), 85 MB in total. Upstream embeds the whole
directory, which puts ~78 MB of duplicate header text into the wasm data segments.

This build embeds only `include/wasm32-wasi` (17 MB) plus clang's own builtin headers (~8 MB).
The data segments drop from 77.7 MB to 25.9 MB. Nothing is lost: the flags clangd is configured
with point at the surviving copy.

### 2. `INITIAL_MEMORY` is 512 MiB, not 2 GiB (memory)

`ALLOW_MEMORY_GROWTH` is still enabled (up to 4 GiB), so clangd can grow as much as it needs —
but a device no longer has to reserve a 2 GiB `SharedArrayBuffer` before it can start. On a
phone that is the difference between "opens" and "the tab reloads".

### 3. JSPI instead of Asyncify (69 MB → 48 MB, 2x faster)

clangd's `JSONTransport` does a blocking `read()` on stdin. In a browser there is nothing to
block on, so upstream patches clangd to call into JavaScript and resumes the wasm stack once
input arrives. The upstream patch relies on **Asyncify**, which rewrites *every function* in the
module into a resumable state machine.

Modern engines can suspend a wasm stack directly: [JSPI](https://github.com/WebAssembly/js-promise-integration)
(`-sJSPI` in Emscripten, Chrome/Edge 137+). The same patch — literally the same
[`patches/wait-stdin.patch`](patches/wait-stdin.patch) — works unchanged, because the suspend
point is an `await` either way. The instrumentation disappears:

| | Asyncify | JSPI |
| --- | --- | --- |
| wasm | 69.1 MB | **48.0 MB** |
| first analysis | 5.1 s | **2.6 s** |
| CPU for that analysis | 46.4 s | **18.7 s** |
| single-line edit round trip | 234–240 ms | **89–150 ms** |

That is not a warm-up artefact: clangd re-parses on every edit, so the instrumented code sits on
the hot path of everything it does.

`VARIANT=asyncify ./scripts/build.sh` produces the classic build for engines without JSPI
(Firefox/Safari as of 2026) — same optimizations 1 and 2 apply, it is the 69 MB column above.

## Build

Requirements: Linux x86_64, ~8 GB of disk, `git cmake ninja python3 curl`, and patience —
a from-scratch build is ~30–40 minutes (toolchain download + LLVM compile). Subsequent variant
builds are ~5 minutes because they reuse the object files.

```bash
./scripts/build.sh                    # JSPI build  -> public/wasm/jspi/
VARIANT=asyncify ./scripts/build.sh   # fallback    -> public/wasm/asyncify/
```

Useful environment variables:

| variable | default | meaning |
| --- | --- | --- |
| `JOBS` | `nproc` | parallel compile jobs |
| `ROOT` | `./.build` | toolchain + build tree (keep it between runs) |
| `VARIANT` | `jspi` | `jspi` or `asyncify` |
| `INITIAL_MEMORY` | `512MB` | `-sINITIAL_MEMORY` |
| `EMSDK_VER`, `WASI_SDK_VER`, `LLVM_VER` | see [scripts/config.sh](scripts/config.sh) | toolchain versions |

Output: `public/wasm/$VARIANT/clangd.js` (glue, ES module) + `clangd.wasm`.

> Keep the glue and the wasm together. The glue spawns pthread workers with
> `new URL("clangd.js", import.meta.url)`, so the pair must keep its file names — if you serve
> them from a CDN, content-hash the **directory**, not the file names, or a stale glue will be
> paired with a new wasm and blow up with `LinkError: Import #9 "env" "_abort_js"`.

## Try it

```bash
node demo/serve.mjs        # http://localhost:8080/demo/
```

The demo is deliberately editor-free: a textarea, a hand-written `initialize`/`didOpen`
conversation, and the diagnostics clangd publishes. It prints the boot time and the time to the
first diagnostic, so it doubles as a quick benchmark. If both variants are built it picks JSPI
when the engine supports it (`?variant=asyncify` forces the fallback).

`demo/serve.mjs` sends the headers clangd needs, and that part is not optional:
clangd is a pthread build, so the page must be `crossOriginIsolated`, which requires

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

on every response (HTML, worker, wasm). Without them `SharedArrayBuffer` is unavailable and the
module cannot start.

## Using the wasm in your own page

```js
const { default: createModule } = await import('./wasm/jspi/clangd.js');

const module = await createModule({
  thisProgram: '/usr/bin/clangd',
  stdin,          // () => byte | null   — see demo/worker.mjs
  stdinReady,     // async () => {}      — resolves when stdin has data
  stdout,         // (byte) => void
  stderr,         // (byte) => void
  locateFile: (path) => new URL(`./wasm/jspi/${path}`, import.meta.url).href
});

// write your workspace into clangd's in-memory filesystem
module.FS.mkdirTree('/home/web_user/workspace');
module.FS.writeFile('/home/web_user/workspace/main.cpp', source);
module.FS.writeFile(
  '/home/web_user/.clangd',
  JSON.stringify({
    CompileFlags: {
      Add: [
        '-isystem/usr/include/wasm32-wasi/c++/v1',
        '-isystem/usr/include',
        '-isystem/usr/include/wasm32-wasi'
      ]
    }
  })
);

module.callMain([]);   // suspends at the first stdin read; the LSP loop is now live
```

Then speak LSP over `stdin`/`stdout` with `Content-Length` framing. `demo/worker.mjs` is a
complete, commented implementation of that bridge (~200 lines) — it also shows the one subtle
part: queue each JSON-RPC message as **three chunks** (header, blank line, body), otherwise a
suspended read can end up waiting for input that is already queued.

## Performance notes

- **Cold start is dominated by the preamble.** Opening a file with `<iostream> <string>
  <vector> <map> <algorithm>` spends ~1.8 s of the ~2.6 s compiling those headers into a
  preamble (11 MB of PCH). clangd caches it per file, so closing and reopening the same file is
  ~100 ms. If you control the host app, warm the file up while the page is idle and the first
  real click becomes ~60 ms.
- **Smaller is faster here.** A `Release` (`-O2`) build of the same clangd is 61 MB and *slower*
  (3.4 s first analysis, 25.5 s CPU) — V8 spends its time on baseline compilation and i-cache,
  not on peak code quality. `-Oz` everywhere, including the final `wasm-opt` pass, is the
  optimum. Numbers and the other failed experiments are in
  [docs/internals.md](docs/internals.md#negative-results).

## Limitations

- JSPI needs Chrome/Edge 137+. Use `VARIANT=asyncify` for everything else.
- The preamble cache is per session. Every page load re-parses the headers (see above).
- `crossOriginIsolated` is mandatory (pthreads ⇒ `SharedArrayBuffer`).
- One clangd per tab; there is no `SharedWorker` sharing yet.
- The embedded sysroot is `wasm32-wasi` only — this is a *hosted* C++ toolchain for the
  editor's benefit, not a way to compile programs to run inside the page.

## Prior art

- [guyutongxue/clangd-in-browser](https://github.com/guyutongxue/clangd-in-browser) — the
  project this builds on; its `build.sh` and `wait_stdin.patch` are the starting point, and its
  [write-up](https://zhuanlan.zhihu.com/p/680612294) is the best explanation of why clangd needs
  a real filesystem and threads in the first place.
- [ConorBobbleHat/clangd-wasm](https://github.com/ConorBobbleHat/clangd-wasm),
  [nokotan/vscode-clangd](https://github.com/nokotan/vscode-clangd) — earlier wasm ports.
- [soedirgo/llvm-wasm](https://github.com/soedirgo/llvm-wasm) — how to build LLVM for wasm at all.
- [clangd/vscode-clangd#723](https://github.com/clangd/vscode-clangd/issues/723) — the
  "90 MB is the only drawback" thread that motivated the size work here.

## License

MIT. `patches/wait-stdin.patch` is derived from clangd-in-browser (MIT, © 2024 Guyutongxue);
LLVM itself is Apache-2.0 with LLVM exceptions.
