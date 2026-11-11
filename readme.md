# Excalibur Benchmark Tooling

Deterministic, headless performance scenarios for [Excalibur](https://excaliburjs.com) plus a CLI that runs them against
two engine builds and compares the results. Used by the Excalibur CI to compare every branch against the latest npm release.

`excalibur-bench run --candidate ..\Excalibur\build\esm\excalibur.js --baseline npm:excalibur@latest --repeat 1 --tests actors-1000`

## How it works

- `harness/` is a static page that loads an Excalibur **UMD bundle** (`build/dist/excalibur.js`) at runtime via `?engine=<url>`,
  so the same scenarios run against any engine version. It exposes `window.__bench.runTest(name, { mode })`.
- Each scenario in `harness/tests/` builds a scene with a seeded `ex.Random(1337)` and only uses APIs that exist in older
  releases too (feature detect if you need something newer).
- **Step mode (default, used in CI)**: the engine clock is swapped for a test clock before start and driven manually,
  every sample is the wall clock time of one engine step (`update` + `draw`) of `stepMs` simulated time. Reproducible and
  independent of vsync.
- **Realtime mode** (manual): the engine runs on its normal clock for 10s and fps is sampled every 250ms, like the original tool.
- `bench.mjs run` opens a fresh headless Chromium page per (engine, test, repetition) and **interleaves** baseline and
  candidate runs so machine drift hits both sides equally. It writes a `results.json`, prints a table and can write
  SVG charts (per-frame timings for both engines, plus a median summary).

## Usage

```bash
npm ci
npm run build                       # builds the harness page into harness/dist

# compare a local excalibur build against the latest npm release
node bench.mjs run \
  --candidate ../excalibur/build/dist/excalibur.js \
  --baseline npm:excalibur@latest \
  --repeat 3 --out results/results.json --charts results/charts

# if installed
excalibur-bench run --candidate build/esm/excalibur.js --baseline npm:excalibur@latest --repeat 1 --tests actors-1000

# re-render a report from a results file (markdown for GitHub job summaries / PR comments)
node bench.mjs report results/results.json --markdown --warn 20 --charts results/charts

node bench.mjs list                 # scenario names
node bench.mjs run ... --tests stack-realistic-300-settle,arcade-1000-bouncing --headed
```

Engine specs accepted by `--candidate`/`--baseline`: a path to a UMD bundle, `npm:<package spec>` (fetched with
`npm pack` into `.engines/`), or an `http(s)://` URL.

### Headed mode

You can test locally in a browser using the headless mode

`npm run dev`

http://localhost:5173/?engine=/@fs/home/erik/projects/excalibur-benchmark/.engines/excalibur@latest/package/build/esm/excalibur.js

This will load the local bundle off the filesystem to whatever version you want

### Software vs hardware GL

By default Chromium runs with `--gl swiftshader` (software rendering): deterministic and the only option on GitHub hosted
runners, but drawing heavy scenarios are ~40x slower than a real GPU (2000 bunnies: ~130ms/frame vs ~3ms). Relative
deltas between two engines are still meaningful, absolute numbers are not. On a dev machine with a display use
`--gl hardware --headed` for real GPU numbers:

```bash
node bench.mjs run --candidate ../excalibur/build/dist/excalibur.js --baseline npm:excalibur@latest --gl hardware --headed --tests bunnymark-2000,bunnymark-5000
```

`--headed` also presents every frame on screen (the step loop otherwise never yields to the compositor, so a headed
window would look frozen until a test finishes); the yield is outside the timed window so samples are unaffected, the
run just takes longer. The buttons on the interactive page do the same.

Drawing scenarios set `syncGpu: true` so the GPU finishes each frame inside the timed window (WebGL submits work
asynchronously; without the sync the timer would only see the CPU side).

Interactive page: `npm run dev` then open `http://localhost:5173/?engine=/@fs/<absolute path>/build/dist/excalibur.js`
(or any URL serving a bundle), pick a test and mode, and charts are rendered inline.

### The slow end: lows

Besides the median and p95, every step mode run reports the p99 and the **5% and 1% lows**: the mean of the slowest 5% and
1% of the steps. That is where hitches such as garbage collection pauses show while barely moving the median. The report
takes their median over the runs, since one disturbed run moves a mean a long way. They need more steps than the defaults
to settle, so pass `--frames` and `--warmup` (a cold page is still compiling through its first few hundred steps, which
would otherwise make up the slowest 1%):

```bash
node bench.mjs run --candidate ../Excalibur/build/esm/excalibur.js --baseline npm:excalibur@latest \
  --frames 1200 --warmup 300 --repeat 5
```

Before the measured steps the harness runs a full garbage collection (`gc()`, from Chromium's `--expose-gc`), so what
setup and warmup left behind is not collected during them. Otherwise that collection lands in the measured steps or not
depending on how fast an engine allocates, and the engine allocating less is the one to pay for it.

The harness is served cross-origin isolated (COOP/COEP): Chromium otherwise rounds `performance.now()` to 100µs, which
is a third of a fast step. `meta.crossOriginIsolated` in the results says whether it was.

### In the Excalibur CI

The Excalibur repo runs this tool on every PR and on pushes to main (`.github/workflows/benchmark.yml`). Collaborators can
re-run it on a PR by commenting `/benchmark`, optionally with `--baseline npm:excalibur@0.33.0-alpha.124 --tests actors-1000
--repeat 5`, which is the quickest way to bisect a regression across published alphas.

## Scenarios

| Name | What it stresses |
|---|---|
| `actors-1000`, `actors-4000` | ECS/transforms/renderer: non-colliding actors flying around (the original benchmark) |
| `stack-realistic-300-settle` | 300 boxes falling into a pile, realistic solver with 3 substeps (narrowphase, solver, islands) |
| `stack-realistic-300-rest` | the same pile fully asleep: per frame floor of broadphase, contact persistence, collider bookkeeping |
| `arcade-1000-bouncing` | 1000 active boxes bouncing in a box, arcade solver, no gravity (broadphase/narrowphase at high pair counts) |
| `edge-floor-realistic-200` | 200 boxes landing along a 4000px edge collider, including its ends (polygon vs edge SAT path) |
| `sleeping-pile-wake` | a sleeping 200 box pile hit by a new box every 60 frames (sleep/wake cycle, contact persistence) |
| `bunnymark-2000`, `bunnymark-5000` | drawing pipeline only: port of [excalibur-bunnymark](https://github.com/excaliburjs/excalibur-bunnymark), sprites drawn straight through the graphics context |

Extras reported next to timings (e.g. `sleepingAtEnd`, `firstFrameAllAsleep`, `fellThrough`, `outside`) double as
sanity checks that the scenario behaved the same on both engines.

## Adding a scenario

Create `harness/tests/<name>.ts` with `defineTest({...})` (see `harness/test.ts` for the options: `stepMs`, `frames`,
`warmup`/`warmupUntil`, `engineOptions`, `setup`, `onFrame`, `extras`) and add it to `harness/tests/index.ts`.
Keep the scene deterministic (use `ctx.rng`) and stick to APIs available in the baseline release.

## Reading results

Deltas are candidate vs baseline medians of the median run; negative is faster. Shared CI runners are noisy: treat single
runs as informational and look for changes that persist across runs. Results with an `error` mean the scenario threw
on that engine (usually an API difference), the table marks them.

Historical reports from the original tool live in `benchmarks/`.
