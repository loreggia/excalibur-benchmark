import { tests } from './tests/index';
import { runRealtime, runStep, type MeasureHooks, type Mode, type Result } from './runner';
import type { Ex } from './test';
import { lineChart } from '../lib/chart.mjs';

export interface RunOptions {
  mode?: Mode;
  /** realtime mode only */
  durationMs?: number;
  /** step mode only: present every frame on screen (slower, for watching headed runs) */
  present?: boolean;
  /** step mode only: overrides the test's number of measured steps */
  frames?: number;
  /** step mode only: overrides the test's fixed number of warmup steps */
  warmup?: number;
}

/**
 * Exposed by the CLI (playwright's exposeFunction) when it traces or profiles the measured steps
 */
type BenchHook = (phase: 'start' | 'end') => Promise<void>;

function hooksFromCli(): MeasureHooks | undefined {
  const hook = (window as unknown as { __benchHook?: BenchHook }).__benchHook;
  return hook ? { measureStart: () => hook('start'), measureEnd: () => hook('end') } : undefined;
}

/**
 * API used by bench.mjs through playwright's page.evaluate, and by the buttons on the page
 */
export interface BenchApi {
  ready: boolean;
  error: string | null;
  engineVersion: string;
  listTests(): { name: string; description: string }[];
  runTest(name: string, options?: RunOptions): Promise<Result>;
}

function loadEngine(url: string): Promise<Ex> {
  return import(/* @vite-ignore */url).then(ex => {
    ((window as any).ex = ex as any);
    return ex;
  });
  // switching to esm only
  // return new Promise((resolve, reject) => {
  //   const script = document.createElement('script');
  //   script.src = url;
  //   script.onload = () => {
  //     let ex = (window as unknown as { ex?: Ex }).ex;
  //     if (!ex) {
  //       resolve(import(/* @vite-ignore */url).then(ex => {
  //         ((window as any).ex = ex as any);
  //         return ex;
  //       }));
  //     }
  //     if (ex) {
  //       resolve(ex);
  //     } else {
  //       reject(new Error(`${url} loaded but did not define the global "ex", is it the UMD bundle (build/dist/excalibur.js)?`));
  //     }
  //   };
  //   script.onerror = () => reject(new Error(`failed to load engine bundle ${url}`));
  //   document.head.appendChild(script);
  // });
}

const status = document.getElementById('status') as HTMLDivElement;
const controls = document.getElementById('controls') as HTMLDivElement;
const testSelect = document.getElementById('test') as HTMLSelectElement;
const modeSelect = document.getElementById('mode') as HTMLSelectElement;
const repeatInput = document.getElementById('repeat') as HTMLInputElement;
const runButton = document.getElementById('run') as HTMLButtonElement;
const runAllButton = document.getElementById('runAll') as HTMLButtonElement;
const resultsTable = document.getElementById('results') as HTMLTableElement;
const resultsBody = resultsTable.querySelector('tbody') as HTMLTableSectionElement;

let ex: Ex = null;

const api: BenchApi = {
  ready: false,
  error: null,
  engineVersion: '',
  listTests: () => tests.map((t) => ({ name: t.name, description: t.description })),
  async runTest(name, options = {}) {
    const test = tests.find((t) => t.name === name);
    if (!test) {
      throw new Error(`unknown test "${name}", known tests: ${tests.map((t) => t.name).join(', ')}`);
    }
    if (!ex) {
      throw new Error('engine not loaded');
    }
    const mode = options.mode ?? 'step';
    return mode === 'realtime'
      ? runRealtime(ex, test, options.durationMs ?? 10_000)
      : runStep(ex, test, { present: options.present ?? false, frames: options.frames, warmup: options.warmup, hooks: hooksFromCli() });
  }
};
(window as unknown as { __bench: BenchApi }).__bench = api;

function format(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : '-';
}

function appendResult(result: Result) {
  resultsTable.hidden = false;
  const row = resultsBody.insertRow();
  const unit = result.mode === 'step' ? ' ms' : ' fps';
  const cells = [
    result.name,
    result.mode,
    format(result.median) + unit,
    format(result.p95) + unit,
    format(result.mean) + unit,
    result.error
      ? `ERROR: ${result.error.split('\n')[0]}`
      : Object.entries(result.extras)
          .map(([k, v]) => `${k}=${format(v)}`)
          .join(' ')
  ];
  for (const text of cells) {
    row.insertCell().textContent = text;
  }
  if (!result.error && result.samples.length) {
    // same SVG charts the CLI writes, one per run
    const chart = document.createElement('div');
    chart.innerHTML = lineChart({
      title: `${result.name} - Excalibur ${result.engineVersion}`,
      yLabel: result.mode === 'step' ? 'ms per frame' : 'fps',
      xLabel: result.mode === 'step' ? 'frame' : 'sample (250ms)',
      series: [{ name: `${result.mode} (median ${format(result.median)})`, samples: result.samples }]
    });
    (document.getElementById('charts') ?? document.body).appendChild(chart);
  }
}

async function runFromUi(names: string[]) {
  runButton.disabled = runAllButton.disabled = true;
  const mode = modeSelect.value as Mode;
  const repeat = Math.max(1, Number(repeatInput.value) || 1);
  try {
    for (const name of names) {
      for (let i = 0; i < repeat; i++) {
        status.textContent = `Running ${name} (${mode}) ${i + 1}/${repeat}…`;
        appendResult(await api.runTest(name, { mode, present: true }));
      }
    }
    status.textContent = `Excalibur ${api.engineVersion} - done`;
  } finally {
    runButton.disabled = runAllButton.disabled = false;
  }
}

async function main() {
  const engineUrl = new URLSearchParams(location.search).get('engine');
  if (!engineUrl) {
    status.innerHTML =
      'No engine specified. Open this page with <code>?engine=&lt;url to excalibur.js bundle&gt;</code>, ' +
      'or use <code>node bench.mjs run</code> for headless A/B comparisons.';
    api.error = 'no engine specified';
    return;
  }
  try {
    ex = await loadEngine(engineUrl);
    api.engineVersion = String(ex.EX_VERSION ?? 'unknown');
    api.ready = true;
    status.textContent = `Excalibur ${api.engineVersion} loaded from ${engineUrl}`;
  } catch (e) {
    api.error = e instanceof Error ? e.message : String(e);
    status.textContent = api.error;
    return;
  }

  for (const test of tests) {
    const option = document.createElement('option');
    option.value = test.name;
    option.textContent = `${test.name} - ${test.description}`;
    testSelect.appendChild(option);
  }
  controls.hidden = false;
  runButton.addEventListener('click', () => void runFromUi([testSelect.value]));
  runAllButton.addEventListener('click', () => void runFromUi(tests.map((t) => t.name)));
}

void main();
