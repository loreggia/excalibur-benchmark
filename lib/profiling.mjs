/**
 * Garbage collection and allocation measurements over exactly the measured steps of a run, driven over the DevTools
 * protocol from the hooks the harness awaits right before the first and right after the last measured step.
 */

/** Must match MEASURE_MARK in harness/runner.ts */
const MEASURE_MARK = 'excalibur-bench-measure';
const GC_EVENTS = new Set(['MinorGC', 'MajorGC']);

/**
 * Exposes `window.__benchHook` on the page, whose start and end phases call the given handlers
 * @param {import('playwright').Page} page
 * @param {{ start: () => Promise<void>, end: () => Promise<void> }} handlers
 */
async function exposeHook(page, handlers) {
  await page.exposeFunction('__benchHook', (phase) => (phase === 'start' ? handlers.start() : handlers.end()));
}

/**
 * Records a trace of the measured steps, from which {@link gcInSteps} reads the garbage collections
 * @param {import('playwright').Page} page
 * @returns {Promise<{ events: () => object[] }>}
 */
export async function traceGc(page) {
  const cdp = await page.context().newCDPSession(page);
  const events = [];
  cdp.on('Tracing.dataCollected', ({ value }) => events.push(...value));
  await exposeHook(page, {
    start: () =>
      cdp.send('Tracing.start', {
        transferMode: 'ReportEvents',
        traceConfig: { includedCategories: ['devtools.timeline', 'v8', 'blink.user_timing', '__metadata'] }
      }),
    end: async () => {
      const complete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
      await cdp.send('Tracing.end');
      await complete;
    }
  });
  return { events: () => events };
}

/**
 * The garbage collections on the page's main thread during the measured steps, and which steps they fell into
 * @param {object[]} events trace events from {@link traceGc}
 * @param {{ samples: number[], timeline?: { mark: number, starts: number[] } }} run
 */
export function gcInSteps(events, run) {
  const mark = events.find((e) => e.name === MEASURE_MARK);
  if (!mark || !run.timeline) {
    return null;
  }
  const main = events.find((e) => e.ph === 'M' && e.name === 'thread_name' && e.pid === mark.pid && e.args?.name === 'CrRendererMain');
  const tid = main?.tid ?? mark.tid;
  // the mark's trace timestamp is the same moment as its performance.now(), which places every step on the trace
  const toTrace = (time) => mark.ts + (time - run.timeline.mark) * 1000;
  const { starts } = run.timeline;
  const samples = run.samples;
  const steps = samples.map((ms, i) => ({ from: toTrace(starts[i]), to: toTrace(starts[i]) + ms * 1000, gcUs: 0 }));
  const first = steps[0]?.from ?? 0;
  const last = steps[steps.length - 1]?.to ?? 0;

  const collections = events.filter(
    (e) => e.ph === 'X' && GC_EVENTS.has(e.name) && e.pid === mark.pid && e.tid === tid && e.ts < last && e.ts + e.dur > first
  );
  for (const gc of collections) {
    for (const step of steps) {
      const overlap = Math.min(step.to, gc.ts + gc.dur) - Math.max(step.from, gc.ts);
      if (overlap > 0) {
        step.gcUs += overlap;
      }
    }
  }

  const withGc = steps.map((step, i) => ({ ms: samples[i], gc: step.gcUs > 0 }));
  const mean = (list) => (list.length ? list.reduce((sum, s) => sum + s.ms, 0) / list.length : NaN);
  // of the slowest steps, how many had a collection in them
  const slowest = [...withGc].sort((a, b) => b.ms - a.ms);
  const shareWithGc = (share) => {
    const top = slowest.slice(0, Math.max(1, Math.round(slowest.length * share)));
    return top.filter((s) => s.gc).length / top.length;
  };
  return {
    steps: samples.length,
    minor: collections.filter((e) => e.name === 'MinorGC').length,
    major: collections.filter((e) => e.name === 'MajorGC').length,
    pauseMs: steps.reduce((sum, s) => sum + s.gcUs, 0) / 1000,
    longestPauseMs: Math.max(0, ...collections.map((e) => e.dur / 1000)),
    stepsWithGc: withGc.filter((s) => s.gc).length,
    meanWithGc: mean(withGc.filter((s) => s.gc)),
    meanWithoutGc: mean(withGc.filter((s) => !s.gc)),
    slowest1WithGc: shareWithGc(0.01),
    slowest5WithGc: shareWithGc(0.05)
  };
}

/**
 * Samples every allocation of the measured steps, including what was collected again before the end
 * @param {import('playwright').Page} page
 * @param {number} samplingInterval mean bytes between two samples
 * @returns {Promise<{ profile: () => object | undefined }>}
 */
export async function profileAllocations(page, samplingInterval) {
  const cdp = await page.context().newCDPSession(page);
  let profile;
  await exposeHook(page, {
    start: async () => {
      await cdp.send('HeapProfiler.enable');
      await cdp.send('HeapProfiler.collectGarbage');
      await cdp.send('HeapProfiler.startSampling', {
        samplingInterval,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true
      });
    },
    end: async () => {
      ({ profile } = await cdp.send('HeapProfiler.stopSampling'));
    }
  });
  return { profile: () => profile };
}

/**
 * Finds the class a line of an engine bundle belongs to, to tell one `clone` from another. Bundles declare classes as
 * `var Name = class` or `class Name` at the start of a line; anything else that starts a top level declaration ends one
 * @param {string} source
 */
function classFinder(source) {
  const starts = [];
  source.split('\n').forEach((line, index) => {
    const match = /^(?:var (\w+) = class\b|class (\w+)\b)/.exec(line);
    if (match) {
      starts.push({ line: index, name: match[1] ?? match[2] });
    } else if (/^(var|let|const|function|\/\/#region) /.test(line)) {
      starts.push({ line: index, name: undefined });
    }
  });
  return (line) => {
    let found;
    for (const start of starts) {
      if (start.line > line) {
        break;
      }
      found = start;
    }
    return found?.name;
  };
}

/**
 * Bytes allocated per measured step, in all and by allocating function
 * @param {object} profile a sampling heap profile from {@link profileAllocations}
 * @param {number} steps the number of measured steps
 * @param {string} engineSource the bundle under test, to name the classes its functions belong to
 */
export function allocationsByFunction(profile, steps, engineSource) {
  const classOf = classFinder(engineSource);
  const byFunction = {};
  let total = 0;
  const visit = (node) => {
    const { functionName, lineNumber, url } = node.callFrame;
    if (node.selfSize > 0) {
      let label = functionName || '(anonymous)';
      if (/\/engines\/[^/]+\.js$/.test(url)) {
        const owner = classOf(lineNumber);
        label = owner ? `${owner}.${label}` : label;
      } else if (url) {
        label = `(harness) ${label}`;
      }
      byFunction[label] = (byFunction[label] ?? 0) + node.selfSize / steps;
      total += node.selfSize;
    }
    node.children.forEach(visit);
  };
  visit(profile.head);
  const top = Object.entries(byFunction)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25);
  return { bytesPerStep: total / steps, byFunction: Object.fromEntries(top) };
}
