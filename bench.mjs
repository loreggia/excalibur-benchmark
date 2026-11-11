#!/usr/bin/env node
/**
 * Excalibur benchmark CLI
 *
 *   node bench.mjs run --candidate <bundle> --baseline <bundle> [--repeat 3] [--tests a,b] [--out results.json] [--charts dir]
 *                     [--gl swiftshader|hardware] [--headed (also presents every frame)] [--no-warmup]
 *                     [--frames n] [--warmup n] [--gc (trace collections)]
 *   node bench.mjs report <results.json> [--markdown] [--warn 20] [--charts dir]
 *   node bench.mjs list
 *
 * A bundle is a path/URL to an Excalibur UMD build (build/dist/excalibur.js) or an npm spec like `npm:excalibur@latest`.
 * Every (engine, test) pair runs in a fresh headless Chromium page; repetitions are interleaved baseline/candidate
 * so machine drift affects both sides equally. The exit code is always 0: results are informational.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { resolveEngine } from './lib/engines.mjs';
import { createServer } from './lib/server.mjs';
import { renderMarkdown, renderText, summarize, writeCharts } from './lib/report.mjs';
import { gcInSteps, traceGc } from './lib/profiling.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_DIST = path.join(here, 'harness', 'dist');
const ENGINE_CACHE = path.join(here, '.engines');

// swiftshader: deterministic software GL, the only option on GitHub hosted runners. hardware: the machine's real GPU
// (needs a display, i.e. --headed on most setups), the right choice for drawing benchmarks on dev machines
const CHROMIUM_ARGS = {
  swiftshader: ['--use-angle=swiftshader', '--disable-gpu-vsync', '--mute-audio', '--js-flags=--expose-gc'],
  hardware: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-gpu-vsync', '--disable-frame-rate-limit', '--mute-audio', '--js-flags=--expose-gc']
};

function usage(message) {
  if (message) {
    console.error(message);
  }
  console.error(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).join('\n').replace(/^ \* ?/gm, ''));
  process.exit(message ? 1 : 0);
}

/**
 * Rejects after `ms` unless the promise settles first, without keeping the process alive for the timer
 */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function ensureHarness() {
  if (!fs.existsSync(path.join(HARNESS_DIST, 'index.html'))) {
    usage(`harness not built: ${HARNESS_DIST} is missing, run "npm run build" first`);
  }
}

async function openHarness(browser, serverUrl, engineKey, headed) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') {
      errors.push(m.text());
    }
  });
  const harnessWithEngine = `${serverUrl}/?engine=/engines/${engineKey}.js`;
  console.log('Harness url:', harnessWithEngine);
  await page.goto(`${serverUrl}/?engine=/engines/${engineKey}.js`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__bench && (window.__bench.ready || window.__bench.error), null, { timeout: 60_000 });
  const state = await page.evaluate(() => ({ ready: window.__bench.ready, error: window.__bench.error, version: window.__bench.engineVersion }));
  if (!state.ready) {
    await page.close();
    throw new Error(`harness failed to load engine "${engineKey}": ${state.error}`);
  }
  if (headed) {
    await page.bringToFront();
  }
  return { page, errors, version: state.version };
}

async function runCommand(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      candidate: { type: 'string' },
      baseline: { type: 'string' },
      repeat: { type: 'string', default: '3' },
      tests: { type: 'string' },
      out: { type: 'string', default: path.join('results', 'results.json') },
      charts: { type: 'string' },
      mode: { type: 'string', default: 'step' },
      timeout: { type: 'string', default: '180000' },
      headed: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      'no-warmup': { type: 'boolean', default: false },
      gl: { type: 'string', default: 'swiftshader' },
      frames: { type: 'string' },
      warmup: { type: 'string' },
      gc: { type: 'boolean', default: false }
    }
  });
  const positive = (value) => (value === undefined ? undefined : Math.max(0, parseInt(value, 10) || 0));
  const stepOptions = { frames: positive(values.frames) || undefined, warmup: positive(values.warmup) };
  if (!(values.gl in CHROMIUM_ARGS)) {
    usage(`--gl must be one of ${Object.keys(CHROMIUM_ARGS).join(', ')}`);
  }
  if (!values.candidate || !values.baseline) {
    usage('run needs --candidate and --baseline');
  }
  ensureHarness();
  const repeat = Math.max(1, parseInt(values.repeat, 10) || 1);
  const timeout = parseInt(values.timeout, 10) || 180_000;
  const mode = values.mode === 'realtime' ? 'realtime' : 'step';
  const log = values.quiet ? () => {} : (...a) => console.error(...a);

  const engines = {
    baseline: await resolveEngine(values.baseline, ENGINE_CACHE),
    candidate: await resolveEngine(values.candidate, ENGINE_CACHE)
  };
  log(`baseline:  ${engines.baseline.spec} -> ${engines.baseline.file}`);
  log(`candidate: ${engines.candidate.spec} -> ${engines.candidate.file}`);

  const server = await createServer({
    root: HARNESS_DIST,
    engines: { 
      baseline: engines.baseline.file,
      candidate: engines.candidate.file 
    },
  });
  const browser = await chromium.launch({ headless: !values.headed, args: CHROMIUM_ARGS[values.gl] });
  const results = {
    meta: {
      date: new Date().toISOString(),
      node: process.version,
      chromium: browser.version(),
      gl: values.gl,
      mode,
      repeat,
      frames: stepOptions.frames ?? null,
      warmup: stepOptions.warmup ?? null,
      gc: values.gc,
      baseline: { spec: engines.baseline.spec, version: '' },
      candidate: { spec: engines.candidate.spec, version: '' }
    },
    tests: {}
  };

  try {
    // discover tests with the candidate engine loaded
    const probe = await openHarness(browser, server.url, 'candidate', false);
    let testNames = (await probe.page.evaluate(() => window.__bench.listTests())).map((t) => t.name);
    // without it Chromium rounds performance.now() to 100µs
    results.meta.crossOriginIsolated = await probe.page.evaluate(() => window.crossOriginIsolated);
    if (!results.meta.crossOriginIsolated) {
      log('warning: the harness is not cross-origin isolated, step times are rounded to 100µs');
    }
    await probe.page.close();
    if (values.tests) {
      const wanted = values.tests.split(',').map((s) => s.trim());
      const unknown = wanted.filter((w) => !testNames.includes(w));
      if (unknown.length) {
        usage(`unknown test(s): ${unknown.join(', ')}. Known: ${testNames.join(', ')}`);
      }
      testNames = wanted;
    }
    for (const name of testNames) {
      results.tests[name] = { baseline: [], candidate: [] };
    }

    // the first scenario of a cold browser is noticeably slower (JIT, shader compilation), run one throwaway
    // pass of the first test on each engine so neither side pays for it in the measurements
    if (!values['no-warmup'] && testNames.length) {
      for (const side of ['baseline', 'candidate']) {
        const { page } = await openHarness(browser, server.url, side, false);
        try {
          await withTimeout(
            page.evaluate(([testName, runMode]) => window.__bench.runTest(testName, { mode: runMode }), [testNames[0], mode]),
            timeout,
            `warm-up timed out after ${timeout}ms`
          );
          log(`warmed up ${side}`);
        } catch (e) {
          log(`warm-up on ${side} failed: ${e.message}`);
        }
        await page.close();
      }
    }

    for (let rep = 0; rep < repeat; rep++) {
      for (const name of testNames) {
        // alternate which side goes first each repetition
        const order = rep % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
        for (const side of order) {
          const { page, errors, version } = await openHarness(browser, server.url, side, values.headed);
          results.meta[side].version = version;
          const tracer = values.gc && mode === 'step' ? await traceGc(page) : undefined;
          const started = Date.now();
          let result;
          try {
            result = await withTimeout(
              page.evaluate(([testName, options]) => window.__bench.runTest(testName, options), [
                name,
                { mode, present: values.headed, ...stepOptions }
              ]),
              timeout,
              `timed out after ${timeout}ms`
            );
          } catch (e) {
            result = { name, mode, engineVersion: version, samples: [], median: NaN, p95: NaN, mean: NaN, extras: {}, error: e.message };
          }
          if (!result.error && errors.length) {
            result.error = `page errors: ${errors.join(' | ')}`;
          }
          if (tracer && !result.error) {
            result.gc = gcInSteps(tracer.events(), result);
          }
          delete result.timeline;
          results.tests[name][side].push(result);
          const unit = mode === 'realtime' ? 'fps' : 'ms';
          const lows = Number.isFinite(result.low1) ? ` 5% low ${result.low5.toFixed(2)}${unit} 1% low ${result.low1.toFixed(2)}${unit}` : '';
          const gc = result.gc ? `, ${result.gc.minor + result.gc.major} GCs in ${result.gc.stepsWithGc} steps` : '';
          log(
            `[${rep + 1}/${repeat}] ${name.padEnd(28)} ${side.padEnd(9)} ${version.padEnd(24)} ${result.error ? 'ERROR ' + result.error.split('\n')[0] : `median ${result.median.toFixed(2)}${unit} p95 ${result.p95.toFixed(2)}${unit}${lows}${gc}`}  (${((Date.now() - started) / 1000).toFixed(1)}s: setup ${((result.setupMs ?? 0) / 1000).toFixed(1)}s, warmup ${((result.warmupMs ?? 0) / 1000).toFixed(1)}s, measured ${((result.total ?? 0) / 1000).toFixed(1)}s)`
          );
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }

  fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
  fs.writeFileSync(values.out, JSON.stringify(results, null, 2));
  log(`wrote ${values.out}`);
  const summary = summarize(results);
  if (values.charts) {
    const files = writeCharts(summary, values.charts);
    log(`wrote ${files.length} chart(s) to ${values.charts}`);
  }
  console.log(renderText(summary));
}

function reportCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      markdown: { type: 'boolean', default: false },
      warn: { type: 'string', default: '20' },
      charts: { type: 'string' }
    }
  });
  const file = positionals[0];
  if (!file) {
    usage('report needs a results.json path');
  }
  const results = JSON.parse(fs.readFileSync(file, 'utf8'));
  const summary = summarize(results);
  const warn = parseFloat(values.warn) || 20;
  if (values.charts) {
    writeCharts(summary, values.charts);
  }
  console.log(values.markdown ? renderMarkdown(summary, { warn, chartsDir: values.charts }) : renderText(summary, { warn }));
}

async function listCommand() {
  ensureHarness();
  // any engine will do for listing, use the stub page without an engine
  const server = await createServer({ root: HARNESS_DIST, engines: {} });
  const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS.swiftshader });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.url}/`, { waitUntil: 'load' });
    const tests = await page.evaluate(() => window.__bench.listTests());
    for (const t of tests) {
      console.log(`${t.name.padEnd(28)} ${t.description}`);
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'run') {
    await runCommand(rest);
  } else if (command === 'report') {
    reportCommand(rest);
  } else if (command === 'list') {
    await listCommand();
  } else {
    usage(command ? `unknown command "${command}"` : undefined);
  }
} catch (e) {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
}
