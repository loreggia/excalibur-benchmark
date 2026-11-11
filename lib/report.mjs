import fs from "node:fs";
import path from "node:path";
import { barChart, lineChart } from "./chart.mjs";

export function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return NaN;
  }
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const relative = (candidate, baseline) =>
  Number.isFinite(candidate) && Number.isFinite(baseline) && baseline > 0
    ? ((candidate - baseline) / baseline) * 100
    : NaN;

/**
 * Picks the fastest repetition (lowest median) for each engine of each test as the representative run that drives
 * the tables and charts: for CPU bound work under external load the best run is the most robust estimate of the
 * intrinsic cost, and the spread across runs (min..max of the medians) is reported next to it so noise stays visible
 */
export function summarize(results) {
  const summary = { meta: results.meta, tests: [] };
  for (const [name, byEngine] of Object.entries(results.tests)) {
    const entry = {
      name,
      baseline: null,
      candidate: null,
      delta: NaN,
      p95Delta: NaN,
      low5Delta: NaN,
      low1Delta: NaN,
    };
    for (const side of ["baseline", "candidate"]) {
      const runs = (byEngine[side] ?? []).filter((r) => r && !r.error);
      const errors = (byEngine[side] ?? [])
        .filter((r) => r && r.error)
        .map((r) => r.error);
      if (runs.length === 0) {
        entry[side] = { error: errors[0] ?? "no runs", runs: 0 };
        continue;
      }
      const medians = runs.map((r) => r.median);
      const representative = runs.reduce(
        (best, r) => (r.median < best.median ? r : best),
        runs[0],
      );
      entry[side] = {
        runs: runs.length,
        errors: errors.length,
        minMedian: Math.min(...medians),
        maxMedian: Math.max(...medians),
        engineVersion: representative.engineVersion,
        mode: representative.mode,
        median: representative.median,
        p95: representative.p95,
        mean: representative.mean,
        // the tails vary more between runs than the median does, and one disturbed run moves a mean of them a long way
        p99: median(runs.map((r) => r.p99)),
        low5: median(runs.map((r) => r.low5)),
        low1: median(runs.map((r) => r.low1)),
        extras: representative.extras ?? {},
        samples: representative.samples,
      };
    }
    if (entry.baseline?.median && entry.candidate?.median) {
      entry.delta =
        ((entry.candidate.median - entry.baseline.median) /
          entry.baseline.median) *
        100;
      entry.p95Delta =
        ((entry.candidate.p95 - entry.baseline.p95) / entry.baseline.p95) * 100;
      entry.low5Delta = relative(entry.candidate.low5, entry.baseline.low5);
      entry.low1Delta = relative(entry.candidate.low1, entry.baseline.low1);
    }
    summary.tests.push(entry);
  }
  return summary;
}

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2) : "-");

/**
 * Engine versions, specs and error messages come from the bundles under test (a PR can put anything in EX_VERSION),
 * neutralize markdown and html before they land in a comment
 */
const sanitize = (text) =>
  String(text ?? "")
    .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])
    .replace(/[`*_\[\]()!#|\\]/g, "\\$&")
    .replace(/\s+/g, " ")
    .slice(0, 200);
const fmtDelta = (v) =>
  Number.isFinite(v) ? `${v > 0 ? "+" : ""}${v.toFixed(1)}%` : "-";
const extrasText = (extras) =>
  Object.entries(extras ?? {})
    .map(
      ([k, v]) =>
        `${k}=${Number.isFinite(v) ? (Number.isInteger(v) ? v : v.toFixed(2)) : v}`,
    )
    .join(", ");

/**
 * Markdown report, deltas are candidate vs baseline (negative = faster). Rows slower than `warn` percent are flagged.
 */
export function renderMarkdown(summary, { warn = 20, chartsDir } = {}) {
  const { meta } = summary;
  const unit =
    summary.tests[0]?.candidate?.mode === "realtime" ? "fps" : "ms/frame";
  const lines = [];
  lines.push(`### Excalibur benchmark`);
  lines.push("");
  lines.push(
    `Baseline: ${sanitize(meta.baseline.spec)} (${sanitize(meta.baseline.version)}) · Candidate: ${sanitize(meta.candidate.spec)} (${sanitize(meta.candidate.version)}) · ${meta.repeat} interleaved run(s), best run shown with the min–max of run medians · ${unit}`,
  );
  lines.push("");
  lines.push(
    `| Test | Baseline median | Baseline p95 | Candidate median | Candidate p95 | Δ median | Δ p95 | Extras (candidate) | |`,
  );
  lines.push(`|---|---:|---:|---:|---:|---:|---:|---|---|`);
  let warnings = 0;
  for (const t of summary.tests) {
    const b = t.baseline;
    const c = t.candidate;
    if (b?.error || c?.error) {
      lines.push(
        `| ${sanitize(t.name)} | ${b?.error ? "ERROR" : fmt(b.median)} | | ${c?.error ? "ERROR" : fmt(c.median)} | | | | ${sanitize((b?.error ?? c?.error ?? "").split("\n")[0])} | ❌ |`,
      );
      continue;
    }
    const slower = Number.isFinite(t.delta) && t.delta > warn;
    if (slower) {
      warnings++;
    }
    const flag = slower
      ? "⚠️"
      : Number.isFinite(t.delta) && t.delta < -warn
        ? "🚀"
        : "";
    lines.push(
      `| ${sanitize(t.name)} | ${fmt(b.median)}${spread(b)} | ${fmt(b.p95)} | ${fmt(c.median)}${spread(c)} | ${fmt(c.p95)} | ${fmtDelta(t.delta)} | ${fmtDelta(t.p95Delta)} | ${sanitize(extrasText(c.extras))} | ${flag} |`,
    );
  }
  lines.push("");
  if (warnings > 0) {
    lines.push(
      `⚠️ ${warnings} test(s) are more than ${warn}% slower than the baseline. Results are informational, shared CI runners are noisy: compare medians across a couple of runs before acting.`,
    );
  } else {
    lines.push(
      `No test is more than ${warn}% slower than the baseline. Results are informational, shared CI runners are noisy.`,
    );
  }
  if (unit === "ms/frame") {
    lines.push(...renderTails(summary));
  }
  if (chartsDir) {
    lines.push("");
    lines.push(
      `Per-frame charts (SVG) are in the \`${path.basename(chartsDir)}\` folder of the benchmark artifact.`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

const comparable = (t) =>
  t.baseline && !t.baseline.error && t.candidate && !t.candidate.error;

/**
 * The slow end of the step times, where hitches such as garbage collection pauses show
 */
function renderTails(summary) {
  const tests = summary.tests.filter(
    (t) => comparable(t) && Number.isFinite(t.candidate.low1),
  );
  if (tests.length === 0) {
    return [];
  }
  return [
    "",
    "#### Slowest steps",
    "",
    "The 5% and 1% lows are the mean of the slowest 5% and 1% of the steps, the median over the runs: where hitches such as garbage collection pauses show, while barely moving the median.",
    "",
    "| Test | Baseline p99 | Candidate p99 | Baseline 5% low | Candidate 5% low | Δ 5% low | Baseline 1% low | Candidate 1% low | Δ 1% low |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...tests.map((t) => {
      const b = t.baseline;
      const c = t.candidate;
      return `| ${sanitize(t.name)} | ${fmt(b.p99)} | ${fmt(c.p99)} | ${fmt(b.low5)} | ${fmt(c.low5)} | ${fmtDelta(t.low5Delta)} | ${fmt(b.low1)} | ${fmt(c.low1)} | ${fmtDelta(t.low1Delta)} |`;
    }),
  ];
}

/** min..max of the run medians when there was more than one run */
function spread(side) {
  return side.runs > 1
    ? ` <sub>(${fmt(side.minMedian)}–${fmt(side.maxMedian)})</sub>`
    : "";
}

const textSpread = (side) =>
  side.runs > 1 ? ` [${fmt(side.minMedian)}-${fmt(side.maxMedian)}]` : "";

/**
 * Plain text table for terminals
 */
export function renderText(summary, { warn = 20 } = {}) {
  const rows = summary.tests.map((t) => ({
    test: t.name,
    baseline: t.baseline?.error
      ? "ERROR"
      : `${fmt(t.baseline.median)} (p95 ${fmt(t.baseline.p95)})${textSpread(t.baseline)}`,
    candidate: t.candidate?.error
      ? "ERROR"
      : `${fmt(t.candidate.median)} (p95 ${fmt(t.candidate.p95)})${textSpread(t.candidate)}`,
    delta: fmtDelta(t.delta),
    "1% low": t.candidate?.error
      ? ""
      : `${fmt(t.baseline?.low1)} -> ${fmt(t.candidate?.low1)} (${fmtDelta(t.low1Delta)})`,
    flag: Number.isFinite(t.delta) && t.delta > warn ? "SLOWER" : "",
    extras: extrasText(t.candidate?.extras),
  }));
  const widths = {};
  for (const key of Object.keys(rows[0] ?? { test: "" })) {
    widths[key] = Math.max(
      key.length,
      ...rows.map((r) => String(r[key]).length),
    );
  }
  const line = (r) =>
    Object.keys(widths)
      .map((k) => String(r[k]).padEnd(widths[k]))
      .join("  ");
  const header = Object.fromEntries(Object.keys(widths).map((k) => [k, k]));
  const unit =
    summary.tests[0]?.candidate?.mode === "realtime" ? "fps" : "ms/frame";
  return [
    `Baseline ${summary.meta.baseline.spec} (${summary.meta.baseline.version}) vs candidate ${summary.meta.candidate.spec} (${summary.meta.candidate.version}), ${unit}, best of ${summary.meta.repeat} run(s) [min-max of run medians]`,
    line(header),
    line(
      Object.fromEntries(
        Object.keys(widths).map((k) => [k, "-".repeat(widths[k])]),
      ),
    ),
    ...rows.map(line),
  ].join("\n");
}

/**
 * Writes one line chart per test (per-frame samples, baseline vs candidate) and one summary bar chart.
 * @returns written file paths
 */
export function writeCharts(summary, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const unit =
    summary.tests[0]?.candidate?.mode === "realtime" ? "fps" : "ms per frame";
  for (const t of summary.tests) {
    const series = [];
    if (t.baseline && !t.baseline.error) {
      series.push({
        name: `baseline ${t.baseline.engineVersion} (median ${fmt(t.baseline.median)})`,
        samples: t.baseline.samples,
      });
    }
    if (t.candidate && !t.candidate.error) {
      series.push({
        name: `candidate ${t.candidate.engineVersion} (median ${fmt(t.candidate.median)})`,
        samples: t.candidate.samples,
      });
    }
    if (series.length === 0) {
      continue;
    }
    const file = path.join(dir, `${t.name}.svg`);
    fs.writeFileSync(file, lineChart({ title: t.name, yLabel: unit, series }));
    written.push(file);
  }
  const groups = summary.tests
    .filter(
      (t) =>
        t.baseline && !t.baseline.error && t.candidate && !t.candidate.error,
    )
    .map((t) => ({
      name: t.name,
      values: [
        {
          name: `baseline ${t.baseline.engineVersion}`,
          value: t.baseline.median,
        },
        {
          name: `candidate ${t.candidate.engineVersion}`,
          value: t.candidate.median,
        },
      ],
    }));
  if (groups.length) {
    const file = path.join(dir, "summary.svg");
    fs.writeFileSync(
      file,
      barChart({ title: `Median ${unit}`, yLabel: unit, groups }),
    );
    written.push(file);
  }
  return written;
}
