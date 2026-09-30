// The referee's own signed scores of a key (index.json, leaderboard.history): [update, score] at each
// update where the key was in the referee's signed top list, every update of the last day and one an
// hour before. Every point is signed, so a curve drawn from them is exact; it only has the updates where
// the key was listed. Used where a key's published trades do not add up to its line (verifiedTrades):
// its replayed curve is hidden, the signed one stands in (Ben, 2026-09-30).
import { robustRange } from "./robust-range.mjs";

/** Updates in a day: one every 5 minutes. */
export const DAY = 288;
/** Before the last day, the history keeps one update in 12: one an hour. */
export const STEP = 12;

/** The points of a history that have a mark time ([update, price, time] as data-marks holds them), as
 * { n, at, v }: a point without a mark time is left out. */
export function signedCurve(points, marks) {
  const at = new Map(marks.map((m) => [m[0], m[2]]));
  return (points ?? []).filter(([n]) => at.has(n)).map(([n, v]) => ({ n, at: at.get(n), v: Number(v) }));
}

/** The curve with a break (a point with no value) wherever the key was out of the signed list or a
 * point had no mark time: the next point is not the next update the history keeps at `sweep` (each one
 * of the last day, every 12th before). A line never joins two signed scores across an update it lacks. */
export function withBreaks(curve, sweep) {
  const start = sweep - DAY;
  const out = [];
  curve.forEach((p, i) => {
    const prev = curve[i - 1];
    const next = prev && (prev.n + 1 >= start ? prev.n + 1 : Math.min(start, (Math.floor(prev.n / STEP) + 1) * STEP));
    if (prev && p.n > next) out.push({ n: next, at: "", v: null });
    out.push(p);
  });
  return out;
}

/** The change over the last day: the last signed score minus the one 288 updates before it, only when
 * the history holds both; undefined otherwise (never a guess across a gap). */
export function dayChange(points) {
  if (!points?.length) return undefined;
  const [n, v] = points[points.length - 1];
  const from = points.find((p) => p[0] === n - DAY);
  return from ? Number(v) - Number(from[1]) : undefined;
}

/** The points of the last day at `sweep`: every update from sweep - 288 on. */
export const lastDay = (points, sweep) => (points ?? []).filter(([n]) => n >= sweep - DAY);

/** A w x h SVG path through `values`, and whether it went up. `xs`, when given, places each value (an
 * update number: a key missing from some updates leaves a gap its width, and the line starts again
 * after it); otherwise they are evenly spaced. Undefined with fewer than two values. */
export function sparkPath(values, xs, w = 96, h = 26) {
  if (!values || values.length < 2) return undefined;
  const range = robustRange(values);
  const lo = range?.min ?? Math.min(...values), hi = range?.max ?? Math.max(...values);
  const x0 = xs ? xs[0] : 0, span = xs ? xs[xs.length - 1] - xs[0] : values.length - 1;
  const x = (i) => (((xs ? xs[i] : i) - x0) / Math.max(1, span)) * w;
  const y = (v) => (h - 2 - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo || 1)) * (h - 4)).toFixed(1);
  const d = values.map((v, i) => `${i && (!xs || xs[i] - xs[i - 1] <= 1) ? "L" : "M"}${x(i).toFixed(1)} ${y(v)}`).join(" ");
  return { d, up: values[values.length - 1] >= values[0] };
}
