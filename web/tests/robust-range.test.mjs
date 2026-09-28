// The axis range of the charts: isolated spikes run off the chart, what lasts is always shown.
import assert from "node:assert/strict";
import { test } from "node:test";

import { robustRange } from "../src/lib/robust-range.mjs";

const flat = (n, v) => Array.from({ length: n }, () => v);

test("a recent rise of the market price stays inside the axis (28 Sep 2026: NVDA above it)", () => {
  const market = [...flat(200, 225), 226, 227, 228, 229, 229.5, 230, 230.2];
  const agents = [...flat(200, 224), 225, 226, 227, 228, 229, 229.8, 230];
  const r = robustRange([market, agents]);
  assert.ok(r.max > 230.2, `max ${r.max}`);
});

test("an isolated spike of the agents' price still runs off the chart", () => {
  const market = flat(200, 225);
  const agents = flat(200, 224);
  agents[50] = 400;
  agents[120] = 10;
  const r = robustRange([market, agents]);
  assert.ok(r.max < 240 && r.min > 200, `${r.min} to ${r.max}`);
});

test("the latest value of every series is shown once it lasts, but not a one-point spike at the end", () => {
  const market = flat(200, 225);
  const lasting = [...flat(197, 224), 260, 261, 262];
  assert.ok(robustRange([market, lasting]).max > 262);
  const spike = [...flat(199, 224), 400];
  assert.ok(robustRange([market, spike]).max < 240);
});

test("one list works as before, and a floor holds", () => {
  const v = [...flat(100, 5), ...flat(100, 6)];
  const r = robustRange(v, 0);
  assert.ok(r.min >= 0 && r.max > 6);
  assert.equal(robustRange([1, 2, 3]), undefined);
});
