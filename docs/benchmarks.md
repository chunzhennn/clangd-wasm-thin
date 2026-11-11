# Benchmarks

All numbers in this repo come from the same machine and the same LLVM revision; only the build
flags differ. Nothing here is extrapolated.

## Test setup

| | |
| --- | --- |
| CPU | 16 cores (AMD Ryzen 9 7950X class), 26 GB RAM, 8 GB swap |
| OS | Linux 6.x, NVMe |
| Browser | Chrome 155 (headless), same flags for every run |
| Server | `nginx` container on localhost; assets served with gzip and `cache-control: immutable` |
| Measurement | Chrome DevTools Protocol: `Performance.getMetrics` for CPU time, `Memory.getDOMCounters`/`SystemInfo` for RSS, `performance.now()` marks in the page for latencies |
| Scenario | a workspace with `main.cpp` including `<iostream> <string> <vector> <map> <algorithm>` (~16 lines), diagnostics requested for line 11 |

Two knobs make the variants comparable:

- the wasm is byte-identical except for the optimization mode being tested;
- the browser profile is fresh for every run (no HTTP cache, no V8 code cache), so "first
  analysis" really is cold.

`taskset -c 0,1` reproduces the "2-core laptop" column.

## Headline numbers

| | upstream `build.sh` | this repo, Asyncify | this repo, JSPI |
| --- | --- | --- | --- |
| `clangd.wasm` | 121 MB | 69.1 MB | **48.0 MB** |
| gzip −9 | 24.9 MiB | 16.4 MiB | **11.4 MiB** |
| `INITIAL_MEMORY` | 2 GiB | 512 MiB | 512 MiB |
| Asyncify instrumentation | yes | yes | **no** |
| click → clangd ready (wasm cached) | 917 ms | 467 ms | **420 ms** |
| click → first diagnostic | 5.23 s | 5.06 s | **2.59 s** |
| CPU time spent on that analysis | 49.7 s | 46.4 s | **18.7 s** |
| edit a line (5 headers) | — | 234–240 ms | **89–150 ms** |
| replace the whole file | — | 236–451 ms | **150–182 ms** |
| completion / hover round trip | — | 44–93 ms | **32–69 ms** |
| renderer RSS with clangd | 1.94 GB | 1.80 GB | **1.76 GB** |
| renderer RSS without clangd | 1.29 GB | 1.21 GB | 1.21 GB |
| TS+Python ready (no clangd) | 0.72 s | 0.68 s | 0.68 s |

The 121 MB → 69 MB step is sysroot pruning + 512 MiB initial memory + no assertions; the
69 MB → 48 MB step is JSPI. Both are described in [internals.md](internals.md).

## Where the 121 MB went

```
121.0 MB  upstream build
 −46.7 MB  pruned sysroot (6 copies of the headers -> 1) + no -sASSERTIONS
          = 74.3 MB (this repo, before the final Binaryen pass)
 − 5.2 MB  wasm-opt -Oz over the linked module (-7%)
          = 69.1 MB (Asyncify variant)
 −21.1 MB  -sJSPI instead of -sASYNCIFY
          = 48.0 MB (JSPI variant)
```

The data segments tell the same story: 77.7 MB embedded in the upstream build, **25.9 MB** here.

## 2 cores (`taskset -c 0,1`)

| | JSPI |
| --- | --- |
| page → TS/Python ready | 2.31 s |
| click → clangd ready | 1.78 s |
| click → first diagnostic | 9.35 s |
| single-line edit | 295–702 ms |

A slow machine is dominated by the preamble build (1.8 s even before), so the win from
removing Asyncify matters more there, not less — and it is also the part that a host
application can hide completely by warming clangd up while the page is idle (in our editor
that takes the first click from 2.5 s to **59 ms**).

## Reproducing

The demo prints the two numbers that matter:

```bash
./scripts/build.sh && node demo/serve.mjs
# open http://localhost:8080/demo/, press "Analyze"
# log: "boot: 420 ms", "first diagnostics: 2600 ms"
```

For end-to-end page metrics, drive Chrome with the DevTools Protocol and read
`Performance.getMetrics` before/after the interaction — that is how the table above was
produced (same approach as `PerformanceObserver` with `TaskAttributionTiming`, but with CPU
time in seconds instead of wall time, which is much less noisy on a busy machine).
