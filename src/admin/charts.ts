/**
 * Chart rendering for the admin dashboard.
 *
 * Every value shown here comes from the live request tracker snapshot.
 * No estimated, sampled, or invented statistics are produced.
 *
 * The spec builders are pure and self-contained: the server renders the spec
 * to inline SVG, and the browser re-renders the same spec to DOM after a live
 * refresh, so the two can never disagree on geometry or wording.
 */
import type { RequestSummary } from "../core/request-tracker";
import { escapeHtml } from "./html";

export interface ChartBar {
  /** Epoch ms of the first instant covered by the bar. */
  start: number;
  /** Epoch ms just after the last instant covered by the bar. */
  end: number;
  count: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Accessible description shown on hover. */
  title: string;
}

export interface ChartLabel {
  x: number;
  y: number;
  text: string;
  anchor: string;
}

export interface ChartStats {
  /** Number of recorded requests represented. */
  total: number;
  /** Peak value in a single bucket (volume only). */
  peak: number;
  min: number;
  median: number;
  max: number;
  average: number;
}

export interface ChartSpec {
  kind: "volume" | "latency";
  width: number;
  height: number;
  baseline: number;
  gridLines: number[];
  bars: ChartBar[];
  linePoints: string;
  areaPoints: string;
  labels: ChartLabel[];
  /** Accessible summary of the whole chart. */
  summary: string;
  stats: ChartStats;
  empty: boolean;
  /** Message shown in place of the chart when there is no data. */
  emptyMessage: string;
}

const CHART_WIDTH = 720;
const CHART_HEIGHT = 190;
const CHART_BASELINE = 132;
const CHART_GRID = [52, 92];
const MAX_BUCKETS = 24;
/** Widest a single volume bar may become, so few buckets stay readable. */
const MAX_BAR_WIDTH = 56;
/** Bucket sizes from finest to coarsest. */
const BUCKET_LADDER = [1000, 5000, 10000, 60000, 300000, 900000, 3600000];

function clock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function emptyStats(): ChartStats {
  return { total: 0, peak: 0, min: 0, median: 0, max: 0, average: 0 };
}

/**
 * Picks a bucket size that yields between 2 and 24 readable bars.
 * Fine units are preferred so a burst of requests is not flattened into
 * a single bar; very long spans widen to fit the 24-bar cap.
 */
function chooseBucketSize(span: number): number {
  if (span <= 0) return BUCKET_LADDER[0]!;
  for (const size of BUCKET_LADDER) {
    const count = Math.ceil(span / size);
    if (count <= MAX_BUCKETS) {
      if (count >= 2) return size;
      continue;
    }
  }
  // Every unit overflows the cap: widen the finest bucket to fit exactly 24.
  return Math.max(BUCKET_LADDER[0]!, span / MAX_BUCKETS);
}

/**
 * Builds the request-volume chart description from the recorded request rows.
 */
export function buildVolumeSpec(rows: unknown[]): ChartSpec {
  const list = (rows || []).filter(
    (row): row is { time: number } =>
      !!row &&
      typeof (row as { time?: unknown }).time === "number" &&
      Number.isFinite((row as { time: number }).time),
  );
  if (list.length === 0) {
    return {
      kind: "volume",
      width: CHART_WIDTH,
      height: CHART_HEIGHT,
      baseline: CHART_BASELINE,
      gridLines: CHART_GRID,
      bars: [],
      linePoints: "",
      areaPoints: "",
      labels: [],
      summary: "No requests recorded yet.",
      stats: emptyStats(),
      empty: true,
      emptyMessage:
        "No requests recorded yet. Run a connection test or send a request from your app.",
    };
  }
  const ordered = list.slice().sort((a, b) => a.time - b.time);
  const from = ordered[0]!.time;
  const to = Math.max(ordered[ordered.length - 1]!.time, from);
  const span = to - from;
  const bucketSize = chooseBucketSize(span);
  const bucketCount = Math.max(1, Math.min(MAX_BUCKETS, Math.ceil(span / bucketSize)));
  const bucketSpan = bucketCount > 0 ? span / bucketCount : 0;
  const counts: number[] = [];
  for (let index = 0; index < bucketCount; index += 1) counts.push(0);
  for (const row of ordered) {
    const index =
      bucketSpan <= 0
        ? 0
        : Math.min(bucketCount - 1, Math.floor((row.time - from) / bucketSpan));
    counts[index] = (counts[index] || 0) + 1;
  }
  let peak = 0;
  for (const count of counts) if (count > peak) peak = count;

  const gap = 6;
  const naturalWidth = (CHART_WIDTH - gap * (bucketCount - 1)) / bucketCount;
  const barWidth = Math.min(naturalWidth, MAX_BAR_WIDTH);
  const scale = peak > 0 ? peak : 1;
  const bars: ChartBar[] = [];
  for (let index = 0; index < bucketCount; index += 1) {
    const count = counts[index] || 0;
    const height =
      count > 0
        ? Math.max(3, Math.round((count / scale) * (CHART_BASELINE - 12)))
        : 0;
    const start = from + index * bucketSpan;
    const end = start + bucketSpan;
    // Centre each bar inside its slot so wide slots do not look lopsided.
    const slotX = index * (naturalWidth + gap);
    bars.push({
      start,
      end,
      count,
      x: slotX + (naturalWidth - barWidth) / 2,
      y: CHART_BASELINE - height,
      width: barWidth,
      height,
      title: `${count} request${
        count === 1 ? "" : "s"
      } between ${clock(start)} and ${clock(end)} UTC`,
    });
  }
  return {
    kind: "volume",
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    baseline: CHART_BASELINE,
    gridLines: CHART_GRID,
    bars,
    linePoints: "",
    areaPoints: "",
    labels: [
      { x: 0, y: 158, text: clock(from), anchor: "start" },
      { x: CHART_WIDTH, y: 158, text: clock(to), anchor: "end" },
    ],
    summary:
      `Request volume across ${ordered.length} recorded request` +
      `${ordered.length === 1 ? "" : "s"}, from ${clock(from)} to ${clock(to)} UTC.`,
    stats: {
      total: ordered.length,
      peak,
      min: peak,
      median: 0,
      max: peak,
      average: 0,
    },
    empty: false,
    emptyMessage: "",
  };
}

/**
 * Builds the response-latency chart description from the recorded request rows.
 */
export function buildLatencySpec(rows: unknown[]): ChartSpec {
  const list = (rows || []).filter(
    (row): row is { time: number; durationMs: number } =>
      !!row &&
      typeof (row as { durationMs?: unknown }).durationMs === "number" &&
      Number.isFinite((row as { durationMs: number }).durationMs),
  );
  if (list.length === 0) {
    return {
      kind: "latency",
      width: CHART_WIDTH,
      height: CHART_HEIGHT,
      baseline: CHART_BASELINE,
      gridLines: CHART_GRID,
      bars: [],
      linePoints: "",
      areaPoints: "",
      labels: [],
      summary: "No requests recorded yet.",
      stats: emptyStats(),
      empty: true,
      emptyMessage:
        "No timings recorded yet. Run a connection test to capture latency.",
    };
  }
  const ordered = list.slice().sort((a, b) => a.time - b.time);
  const values = ordered.map((row) => row.durationMs);
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? sorted[middle] || 0
      : Math.round(((sorted[middle - 1] || 0) + (sorted[middle] || 0)) / 2);
  let sum = 0;
  for (const value of values) sum += value;
  const min = sorted[0] || 0;
  const max = sorted[sorted.length - 1] || 0;
  const average = Math.round(sum / values.length);

  const scale = max > 0 ? max : 1;
  const step = values.length > 1 ? CHART_WIDTH / (values.length - 1) : 0;
  const points: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] || 0;
    const x = (index * step).toFixed(2);
    const y = (CHART_BASELINE - (value / scale) * (CHART_BASELINE - 12)).toFixed(2);
    points.push(`${x},${y}`);
  }
  const linePoints = points.join(" ");
  const areaPoints =
    values.length > 0
      ? `0,${CHART_BASELINE} ${linePoints} ${((values.length - 1) * step).toFixed(2)},${CHART_BASELINE}`
      : "";
  return {
    kind: "latency",
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    baseline: CHART_BASELINE,
    gridLines: CHART_GRID,
    bars: [],
    linePoints,
    areaPoints,
    labels: [],
    summary:
      `Response latency for ${values.length} recorded request` +
      `${values.length === 1 ? "" : "s"}. Minimum ${min} ms, median ${median} ms, maximum ${max} ms.`,
    stats: {
      total: values.length,
      peak: max,
      min,
      median,
      max,
      average,
    },
    empty: false,
    emptyMessage: "",
  };
}

/** Renders a chart spec to inline SVG markup. */
export function renderSpec(spec: ChartSpec): string {
  const bars = spec.bars
    .map(
      (bar) =>
        `<rect class="chart-bar" x="${bar.x.toFixed(2)}" y="${bar.y.toFixed(
          2,
        )}" width="${bar.width.toFixed(2)}" height="${bar.height}" rx="3"><title>${escapeHtml(
          bar.title,
        )}</title></rect>`,
    )
    .join("");
  const grid = spec.gridLines
    .map(
      (y) =>
        `<line class="chart-rule" x1="0" y1="${y}" x2="${spec.width}" y2="${y}" />`,
    )
    .join("");
  const labels = spec.labels
    .map(
      (label) =>
        `<text class="chart-label" x="${label.x}" y="${label.y}" text-anchor="${label.anchor}">${escapeHtml(
          label.text,
        )}</text>`,
    )
    .join("");
  const area = spec.areaPoints
    ? `<polygon class="chart-area" points="${spec.areaPoints}" />`
    : "";
  const line = spec.linePoints
    ? `<polyline class="chart-line" points="${spec.linePoints}" />`
    : "";
  return `<svg class="chart-svg" viewBox="0 0 ${spec.width} ${spec.height}" role="img" aria-label="${escapeHtml(
    spec.summary,
  )}" focusable="false" stroke="none" preserveAspectRatio="xMidYMid meet"><line class="chart-axis" x1="0" y1="${
    spec.baseline
  }" x2="${spec.width}" y2="${spec.baseline}" />${grid}${area}${line}${bars}${labels}</svg>`;
}

/** Inline SVG for the request-volume chart. Empty string when there is no data. */
export function renderVolumeChart(rows: RequestSummary[]): string {
  const spec = buildVolumeSpec(rows);
  return spec.empty ? "" : renderSpec(spec);
}

/** Inline SVG for the latency chart. Empty string when there is no data. */
export function renderLatencyChart(rows: RequestSummary[]): string {
  const spec = buildLatencySpec(rows);
  return spec.empty ? "" : renderSpec(spec);
}
