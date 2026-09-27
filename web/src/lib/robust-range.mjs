// An axis range that follows the bulk of a series: isolated spikes (an agents' trade far from the market,
// for instance) are left to run off the chart rather than flatten every other point.
/** { min, max } from the 2nd to the 98th percentile of the values, with a little room; undefined when
 * there are too few values to tell. `floor` keeps a lower bound (0 for counts). */
export function robustRange(values, floor) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length < 20) return undefined;
  const at = (q) => v[Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))))];
  const lo = at(0.02), hi = at(0.98);
  const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.01 || 1;
  return { min: floor === undefined ? lo - pad : Math.max(floor, lo - pad), max: hi + pad };
}
