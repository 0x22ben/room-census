// Mutation tests of the contest contract: the valid pair passes, and each single alteration of a date, a
// source, a series, a check, a DID, a rank, a profit or the links between files is refused.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ContestContractError, checkContests } from "../scripts/contests-contract.mjs";
import { DIDS, SELF, validIndex, validRanking } from "./fixtures/contests-valid.mjs";

const FILES = ["data/contests/index.json", "data/contests/close-1.ranking.json"];

function run(mutate = () => {}, files = FILES) {
  const index = validIndex();
  const rank = validRanking();
  mutate(index, rank, index.contests[0], index.contests[1]);
  const docs = { "data/contests/index.json": index, "data/contests/close-1.ranking.json": rank };
  return () => checkContests(files, (rel) => docs[rel]);
}

test("the valid index and ranking pass", () => {
  assert.doesNotThrow(run());
});

const MUTATIONS = [
  // dates and phases
  ["index schema", (i) => { i.schema = "room-census-contests/1"; }, /room-census-contests\/2/],
  ["capture time not ISO", (i) => { i.captured_at = "yesterday"; }, /room-census-contests\/2/],
  ["lock after the final price", (i, r, c) => { c.trading_lock_at = "2026-10-04T11:00:00Z"; }, /out of order/],
  ["opening after the lock", (i, r, c) => { c.opening = "2026-10-05T00:00:00Z"; }, /out of order/],
  ["final price not ISO", (i, r, c) => { c.final_price_at = "4 Oct"; }, /final price time/],
  ["status that the times contradict", (i, r, c) => { c.status = "ended"; }, /status ended does not match/],
  ["coverage before the opening", (i, r, c) => { c.coverage_start = "2026-09-25T11:00:00Z"; }, /coverage/],
  ["coverage after the capture", (i, r, c) => { c.coverage_start = "2026-09-26T00:00:00Z"; }, /coverage starts after/],
  // sources and rules
  ["rules not https", (i, r, c) => { c.rules = "javascript:alert(1)"; }, /rules link/],
  ["winner without its source", (i, r, c, s) => { delete s.winner_source; }, /winner needs its source/],
  // checks and states
  ["unknown check state", (i, r, c) => { c.checks[0].state = "pass"; }, /unknown state/],
  ["empty check text", (i, r, c) => { c.checks[1].text = " "; }, /incomplete/],
  ["summary ok while a check warns", (i, r, c) => { c.check.level = "ok"; }, /summary level/],
  ["no checks", (i, r, c) => { c.checks = []; }, /no checks/],
  // series and latest
  ["series going backwards", (i, r, c) => { c.series[1].n = 1; }, /increasing order/],
  ["players going down", (i, r, c) => { c.series[1].owners = 5; }, /went down/],
  ["series not ending at the latest update", (i, r, c) => { c.latest.sweep = 3; c.leaderboard.sweep = 3; c.ranking.sweep = 3; r.sweep = 3; }, /does not end at the latest/],
  ["price with three decimals", (i, r, c) => { c.latest.price = "224.875"; }, /latest update is malformed/],
  // DIDs, ranks and profits
  ["leaderboard DID malformed", (i, r, c) => { c.leaderboard.rows[0].did = "did:key:nope"; }, /bad or repeated DID/],
  ["leaderboard rank skipped", (i, r, c) => { c.leaderboard.rows[1].rank = 3; }, /ranks are not/],
  ["ranking DID repeated", (i, r) => { r.rows[1][1] = DIDS[0]; }, /bad or repeated DID/],
  ["ranking rank skipped", (i, r) => { r.rows[2][0] = 4; }, /ranks are not/],
  ["ranking profit not a decimal", (i, r) => { r.rows[1][2] = "68.4"; }, /is malformed/],
  ["ranking not sorted by profit", (i, r) => { r.rows[2][2] = "99.00"; }, /not sorted by profit/],
  ["unknown number source", (i, r) => { r.rows[2][3] = "guess"; }, /is malformed/],
  ["official without a checked line", (i, r) => { r.rows[1][3] = "official"; }, /marked official but not checked/],
  ["official showing our number, not the referee's", (i, r) => { r.rows[0][2] = "76.22"; }, /does not show the referee's signed profit/],
  // consistency between files
  ["trader count off", (i, r) => { r.traders = 4; }, /trader count/],
  ["ranking of another contest", (i, r) => { r.contest = "close-2"; }, /contest-ranking\/1 document of close-1/],
  ["ranking of another update", (i, r) => { r.sweep = 1; }, /its update differs/],
  ["notes missing", (i, r) => { delete r.notes.partial; }, /notes missing/],
  ["ranking file path wrong", (i, r, c) => { c.ranking.file = "/data/contests/other.json"; }, /does not resolve/],
  ["duplicate contest id", (i, r, c, s) => { s.id = "close-1"; }, /duplicate contest id/],
  ["contest id that leaves its folder", (i, r, c, s) => { s.id = "../x"; }, /unsafe or duplicate contest id/],
  ["contest id with an upper case letter", (i, r, c, s) => { s.id = "Sonnet-2"; }, /unsafe or duplicate contest id/],
  // our own key
  ["our key said to have a trade that the ranking lacks", (i, r, c) => { c.self_key.settled_trade = true; }, /settled-trade status disagrees/],
  ["our key mint status unknown", (i, r, c) => { c.self_key.mint = "probably"; }, /our key status/],
  ["our registration without a sequence", (i, r, c) => { delete c.self_key.registration.seq; }, /registration evidence/],
];

for (const [name, mutate, pattern] of MUTATIONS) {
  test(`refused: ${name}`, () => {
    assert.throws(run(mutate), (e) => e instanceof ContestContractError && pattern.test(e.message), `${name}: ${pattern}`);
  });
}

test("refused: an incomplete set of files", () => {
  assert.throws(run(() => {}, ["data/contests/index.json"]), /does not resolve/);
  assert.throws(run(() => {}, [...FILES, "data/contests/stray.ranking.json"]), /named by no contest/);
});

test("our key ranked with a settled trade is accepted only when the ranking holds it", () => {
  assert.doesNotThrow(run((i, r, c) => { c.self_key.settled_trade = true; r.rows[2][1] = SELF; }));
});
