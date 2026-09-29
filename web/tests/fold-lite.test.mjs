// The display accounting follows close_call_fold.py on small cases worked by hand.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Account, matchesLine, scoreCurve, verifiedTrades } from "../src/lib/fold-lite.mjs";

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

test("a replay that lands on the ranking line matches it; one missing a trade does not", () => {
  // the #1 key of 29 Sep 2026: its published history lacked the sale that closed its first long
  const published = [[390, "b", "43.03", "221.58", "125.6476"], [886, "s", "0.28", "235.47", "0.7532"],
    [899, "b", "42.32", "226.44", "117.6496"], [899, "b", "1.47", "226.44", "4.0866"], [918, "s", "2.01", "234.88", "6.0099"],
    [918, "s", "0.92", "234.88", "2.7508"], [957, "b", "0.19", "225.40", "0.5871"], [957, "b", "2.70", "225.40", "8.3430"],
    [1108, "s", "3.18", "234.11", "8.8404"], [1108, "s", "1.94", "234.11", "5.3932"]];
  const a = new Account();
  for (const t of published) a.applyTrade(t);
  assert.equal(matchesLine(a, ["38.35", "226.36"]), false);
  const b = new Account();
  b.applyTrade([1, "b", "10", "200", "2"]);
  b.applyTrade([2, "b", "10", "210", "2.1"]);
  b.applyTrade([3, "s", "5", "220", "1.1"]);
  assert.equal(matchesLine(b, ["15.00", "206.67"]), true);           // 5 left at 200, 10 at 210
  assert.equal(matchesLine(b, ["15.00", "205.00"]), false);          // same size, another entry
  assert.equal(matchesLine(b, null), false);                         // the line says flat
  const c = new Account();
  c.applyTrade([1, "b", "10", "200", "2"]);
  c.applyTrade([2, "s", "10", "210", "2.1"]);
  assert.equal(matchesLine(c, null), true);
  assert.equal(matchesLine(c, ["10.00", "200.00"]), false);
});

test("published trades are verified only if they add up to the line's position and score at its sweep", () => {
  const trades = [[1, "b", "10", "200", "20"], [3, "s", "10", "210", "21"]];
  const marks = [[1, 200], [2, 205], [3, 210], [4, 212]];
  // flat after the sale: cash 10,000 - 20 - 2000 ... + 2100 - 21 = 10,059
  assert.equal(verifiedTrades(trades, marks, 3, "59.00", null), true);
  assert.equal(verifiedTrades(trades, marks, 4, "59.00", null), true);             // flat: the mark no longer moves it
  assert.equal(verifiedTrades(trades, marks, 3, "60.00", null), false);            // a score off by 1
  assert.equal(verifiedTrades(trades, marks, 2, "59.00", null), false);            // a trade after the ranking's sweep
  assert.equal(verifiedTrades(trades, marks, 5, "59.00", null), false);            // no mark for that sweep
  assert.equal(verifiedTrades(trades, marks, 3, "59.00", undefined), false);       // no position to check
  assert.equal(verifiedTrades([], marks, 3, "0.00", null), false);
  // a sale and a buyback both missing: same position, another score
  const full = [[1, "b", "10", "200", "20"], [2, "s", "10", "205", "20.5"], [2, "b", "10", "205", "20.5"]];
  assert.equal(verifiedTrades(full, marks, 3, "39.00", ["10", "205"]), true);       // 10,000 - 61 + 100 = 10,039
  assert.equal(verifiedTrades(full.slice(0, 1), marks, 3, "39.00", ["10", "205"]), false);
});
