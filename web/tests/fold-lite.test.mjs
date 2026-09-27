// The display accounting follows close_call_fold.py on small cases worked by hand.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Account, scoreCurve } from "../src/lib/fold-lite.mjs";

test("a long bought and sold: cash back with the gain, fees taken", () => {
  const a = new Account();
  a.apply(1, 10, 200, 2);
  assert.equal(a.value(210), 10_000 - 2 + 100);
  assert.equal(a.apply(-1, 10, 210, 2), 100 - 2);
  assert.deepEqual(a.lots, []);
  assert.equal(a.cash, 10_000 - 4 + 100);
});

test("a short is valued at its collateral plus or minus the move", () => {
  const a = new Account();
  a.apply(-1, 5, 220, 0);
  assert.equal(a.value(210), 10_000 + 50);
  assert.equal(a.value(230), 10_000 - 50);
});

test("the curve settles each sweep's trades before its mark", () => {
  const curve = scoreCurve([[2, "b", "1", "100", "0"], [3, "s", "1", "110", "0"]], [[1, 100], [2, 105], [3, 120]]);
  assert.deepEqual(curve, [0, 5, 10]);
});
