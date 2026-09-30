// The referee's signed scores of the keys of its signed list (index.json, leaderboard.history): the
// contract accepts a well-formed history, with ranking v2 or v3, and an index without one; it refuses
// every other shape. The helpers the pages draw them with, on small cases worked by hand.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { ContestContractError, checkContests } from "../scripts/contests-contract.mjs";
import { DAY, STEP, dayChange, lastDay, signedCurve, sparkPath, withBreaks } from "../src/lib/signed-history.mjs";
import { DIDS, validRankingV2Files, validRankingV3Files } from "./fixtures/contests-valid.mjs";

// the signed list of the fixture holds DIDS[0] and DIDS[1], at update 2
const HISTORY = () => ({ [DIDS[0]]: [[1, "70.10"], [2, "76.35"]], [DIDS[1]]: [[2, "68.41"]] });

function run(mutate = () => {}, files = validRankingV2Files) {
  const docs = files(true);
  const c = docs["data/contests/index.json"].contests[0];
  c.leaderboard.history = HISTORY();
  mutate(c.leaderboard, c);
  return () => checkContests(Object.keys(docs), (rel) => docs[rel]);
}

test("a signed history passes with ranking v2 and v3, and an index without one still passes", () => {
  assert.doesNotThrow(run());
  assert.doesNotThrow(run(() => {}, validRankingV3Files));
  assert.doesNotThrow(run((lb) => { delete lb.history; }));
  assert.doesNotThrow(run((lb) => { lb.history = {}; }));                          // no key listed: nothing to draw
  assert.doesNotThrow(run((lb) => { delete lb.history[DIDS[1]]; }));               // a key without history
  assert.doesNotThrow(run((lb) => { lb.history[DIDS[0]] = [[1, "-0.00"], [2, "-123456789.00"]]; }));
});

const MUTATIONS = [
  ["a history that is a list", (lb) => { lb.history = [[1, "70.10"]]; }, /not an object/],
  ["a history that is null", (lb) => { lb.history = null; }, /not an object/],
  ["a history that is a string", (lb) => { lb.history = "{}"; }, /not an object/],
  ["a key outside the signed list", (lb) => { lb.history[DIDS[2]] = [[2, "-3.10"]]; }, /not a row of the signed list/],
  ["a key that is not a DID", (lb) => { lb.history.nope = [[2, "1.00"]]; }, /not a row of the signed list/],
  ["a __proto__ key", (lb) => { lb.history = JSON.parse(`{"__proto__": [[2, "1.00"]]}`); }, /not a row of the signed list/],
  ["an empty history", (lb) => { lb.history[DIDS[0]] = []; }, /is empty or not a list/],
  ["a history that is an object", (lb) => { lb.history[DIDS[0]] = { 1: "70.10" }; }, /is empty or not a list/],
  ["a point that is not a pair", (lb) => { lb.history[DIDS[0]] = [[1, "70.10", "x"]]; }, /not \[update, score\]/],
  ["a point that is an object", (lb) => { lb.history[DIDS[0]] = [{ n: 1, pnl: "70.10" }]; }, /not \[update, score\]/],
  ["a score as a number", (lb) => { lb.history[DIDS[0]] = [[1, 70.1]]; }, /not \[update, score\]/],
  ["a score with three decimals", (lb) => { lb.history[DIDS[0]] = [[1, "70.100"]]; }, /not \[update, score\]/],
  ["a score with one decimal", (lb) => { lb.history[DIDS[0]] = [[1, "70.1"]]; }, /not \[update, score\]/],
  ["a score with a plus sign", (lb) => { lb.history[DIDS[0]] = [[1, "+70.10"]]; }, /not \[update, score\]/],
  ["update 0", (lb) => { lb.history[DIDS[0]] = [[0, "70.10"]]; }, /not \[update, score\]/],
  ["a fractional update", (lb) => { lb.history[DIDS[0]] = [[1.5, "70.10"]]; }, /not \[update, score\]/],
  ["an update as a string", (lb) => { lb.history[DIDS[0]] = [["1", "70.10"]]; }, /not \[update, score\]/],
  ["an update after the signed list's", (lb) => { lb.history[DIDS[0]] = [[1, "70.10"], [3, "76.35"]]; }, /up to update 2/],
  ["updates out of order", (lb) => { lb.history[DIDS[0]] = [[2, "76.35"], [1, "70.10"]]; }, /strictly increasing/],
  ["an update twice", (lb) => { lb.history[DIDS[0]] = [[2, "76.35"], [2, "76.35"]]; }, /strictly increasing/],
];
for (const [name, mutate, pattern] of MUTATIONS) {
  test(`refused: ${name}`, () => {
    assert.throws(run(mutate), (e) => e instanceof ContestContractError && pattern.test(e.message), `${name}: ${pattern}`);
  });
}

// the browser tests put these real signed scores into the trader page built from the repository's copy
// of the contest files (update 667): they must be what the contract lets through for that index
test("the browser tests' signed history of update 667 fits the contract with that index", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/close-1.history-667.json", import.meta.url), "utf8"));
  const repo = new URL("../../data/contests/index.json", import.meta.url);
  const index = existsSync(repo) ? JSON.parse(readFileSync(repo, "utf8")) : undefined;
  const c = index?.contests.find((x) => x.id === "close-1");
  if (!c || c.leaderboard.sweep !== fixture.sweep) return;   // another copy: the fixture is not used
  delete c.ranking;
  c.leaderboard.history = fixture.history;
  assert.doesNotThrow(() => checkContests(["data/contests/index.json"], () => index));
  for (const [did, points] of Object.entries(fixture.history)) {
    assert.equal(points.at(-1)[1], c.leaderboard.rows.find((r) => r.did === did).pnl, "its last point is the signed list's own score");
  }
});

test("the curve keeps the points that have a mark time, as numbers", () => {
  const marks = [[1, 226.1, "2026-09-25T12:05:00Z"], [3, 226.3, "2026-09-25T12:15:00Z"], [4, 226.4, "2026-09-25T12:20:00Z"]];
  assert.deepEqual(signedCurve([[1, "10.00"], [2, "11.00"], [3, "-1.50"], [4, 12]], marks),
    [{ n: 1, at: "2026-09-25T12:05:00Z", v: 10 }, { n: 3, at: "2026-09-25T12:15:00Z", v: -1.5 }, { n: 4, at: "2026-09-25T12:20:00Z", v: 12 }]);
  assert.deepEqual(signedCurve(undefined, marks), []);
});

test("the 24h change needs both signed ends, 288 updates apart", () => {
  const sweep = 1000;
  const full = [];
  for (let n = 1; n <= sweep; n++) if (n >= sweep - DAY || n % STEP === 0) full.push([n, `${(n / 10).toFixed(2)}`]);
  assert.equal(dayChange(full).toFixed(2), "28.80");                               // 100.00 - 71.20
  assert.equal(dayChange(full.filter(([n]) => n !== sweep - DAY)), undefined);      // the key was not listed a day ago
  assert.equal(dayChange([[sweep, "1.00"]]), undefined);
  assert.equal(dayChange([]), undefined);
  assert.equal(dayChange(undefined), undefined);
});

test("the last day is every update from 288 before the sweep", () => {
  assert.deepEqual(lastDay([[1, "1.00"], [700, "2.00"], [712, "3.00"], [1000, "4.00"]], 1000), [[712, "3.00"], [1000, "4.00"]]);
});

test("the curve breaks where the key was not listed, not between the hourly points kept before the last day", () => {
  const p = (n) => ({ n, at: `t${n}`, v: n });
  const gap = (n) => ({ n, at: "", v: null });
  // sweep 1000: the last day starts at 712; before it one point an hour (every 12th update)
  assert.deepEqual(withBreaks([p(684), p(696), p(708), p(712), p(713)], 1000), [p(684), p(696), p(708), p(712), p(713)]);
  assert.deepEqual(withBreaks([p(684), p(708)], 1000), [p(684), gap(696), p(708)]);           // missing at 696
  assert.deepEqual(withBreaks([p(708), p(714)], 1000), [p(708), gap(712), p(714)]);           // missing at 712 and 713
  assert.deepEqual(withBreaks([p(900), p(901), p(905), p(906)], 1000), [p(900), p(901), gap(902), p(905), p(906)]);
  assert.deepEqual(withBreaks([], 1000), []);
});

test("a sparkline is placed by update when asked, and broken where the key was not listed; evenly otherwise", () => {
  const even = sparkPath([0, 5, 10]);
  assert.equal(even.d, "M0.0 24.0 L48.0 13.0 L96.0 2.0");
  assert.equal(even.up, true);
  const placed = sparkPath([0, 5, 10], [10, 11, 14]);
  assert.equal(placed.d, "M0.0 24.0 L24.0 13.0 M96.0 2.0");                       // not listed at 12 and 13: no line across
  assert.equal(sparkPath([0, 5, 10], [10, 11, 12]).d, "M0.0 24.0 L48.0 13.0 L96.0 2.0");
  assert.equal(sparkPath([3, 1]).up, false);
  assert.equal(sparkPath([1]), undefined);
  assert.equal(sparkPath([]), undefined);
});
