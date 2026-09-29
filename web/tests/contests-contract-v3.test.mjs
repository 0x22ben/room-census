// Ranking v3 (Ben, 2026-09-30: never show a wrong figure): nothing of our own recount is published until
// it can be proved against the referee's signed hashes. The valid set passes, with or without the trades
// files, and each alteration that would publish a figure of our recount is refused.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ContestContractError, checkContests } from "../scripts/contests-contract.mjs";
import { shard } from "../src/lib/did-shard.mjs";
import { DIDS, validRankingV3Files } from "./fixtures/contests-valid.mjs";

function run(mutate = () => {}, withTrades = true) {
  const docs = validRankingV3Files(withTrades);
  mutate(docs, docs["data/contests/index.json"].contests[0], docs["data/contests/close-1.ranking.json"]);
  return () => checkContests(Object.keys(docs), (rel) => docs[rel]);
}

const tradesAt = (did) => `data/contests/close-1.trades.${shard(did)}.json`;
const TRADES = [[1, "b", "44.66", "221.65", "0.98"]];

test("a valid ranking v3 passes, with or without the trades files", () => {
  assert.doesNotThrow(run());
  assert.doesNotThrow(run(() => {}, false));
});

test("the trades of every key of the referee's signed top list may be published", () => {
  assert.doesNotThrow(run((d) => { d[tradesAt(DIDS[1])].keys[DIDS[1]] = TRADES; }));
});

const MUTATIONS = [
  ["the trades of a key outside the signed top list", (d) => { d[tradesAt(DIDS[2])].keys[DIDS[2]] = TRADES; }, /not in the referee's signed top list/],
  ["a ranking shard of our recount", (d) => { d[`data/contests/close-1.ranking.${shard(DIDS[2])}.json`] = { schema: "room-census/contest-ranking-shard/1", contest: "close-1", sweep: 2, shard: shard(DIDS[2]), rows: [] }; }, /named by no contest/],
  ["ranking rows in the summary", (d, c, m) => { m.top = [[1, DIDS[0], "76.35", "official"]]; }, /holds only/],
  ["a trader count in the summary", (d, c, m) => { m.traders = 3; }, /holds only/],
  ["a trader count in the index", (d, c) => { c.ranking.traders = 3; }, /counts the traders of our recount/],
  ["an open position in the signed top list", (d, c) => { c.leaderboard.rows[0].position = ["44.66", "221.65"]; }, /positions of our recount/],
  ["an active count in the series", (d, c) => { c.series[1].active = 5; }, /active, long or short/],
  ["a short count in the series", (d, c) => { c.series[1].short = 2; }, /active, long or short/],
  ["a signed top list of another update", (d, c) => { c.leaderboard.sweep = 1; }, /not at the same update/],
  ["a summary of another update", (d, c, m) => { m.sweep = 1; }, /differs from the index/],
  ["a shard count other than 256", (d, c, m) => { m.shards = 16; }, /shard count/],
  ["a trades file missing", (d) => { delete d[tradesAt(DIDS[1])]; }, /are in 255 files/],
];
for (const [name, mutate, pattern] of MUTATIONS) {
  test(`refused: ${name}`, () => {
    assert.throws(run(mutate), (e) => e instanceof ContestContractError && pattern.test(e.message), `${name}: ${pattern}`);
  });
}
