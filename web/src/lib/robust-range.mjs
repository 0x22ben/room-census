// An axis range that follows the bulk of a series: isolated spikes (an agents' trade far from the market,
// for instance) are left to run off the chart rather than flatten every other point. What lasts is always
// shown: the whole first series (the market price, or the only curve), and the latest value of every
// series, each once a median of 5 neighbours has dropped the one- or two-point spikes. Before that, a
// recent rise was cut off like a spike, because it was short (28 Sep 2026: NVDA above the axis).

/** The values in order with every one- or two-point spike replaced by the median of its 5 neighbours. */
function steady(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x));
  return v.map((_, i) => {
    const w = v.slice(Math.max(0, i - 2), i + 3).sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)];
  });
}

/** { min, max } around the 2nd to the 98th percentile of every value, widened to the steady first series
 * and to the steady latest value of each series, with a little room; undefined when there are too few
 * values to tell. `series` is one list of values, or a list of lists (the first is the reference).
 * `floor` keeps a lower bound (0 for counts). */
export function robustRange(series, floor) {
  const lists = Array.isArray(series[0]) ? series : [series];
  const v = lists.flat().filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length < 20) return undefined;
  const at = (q) => v[Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))))];
  let lo = at(0.02), hi = at(0.98);
  const keep = (x) => { if (x < lo) lo = x; if (x > hi) hi = x; };
  for (const x of steady(lists[0])) keep(x);
  for (const s of lists) {
    const last = steady(s).at(-1);
    if (last !== undefined) keep(last);
  }
  const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.01 || 1;
  return { min: floor === undefined ? lo - pad : Math.max(floor, lo - pad), max: hi + pad };
}
