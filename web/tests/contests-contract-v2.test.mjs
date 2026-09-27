// Ranking v2 (a summary with the first places, every key in one of 256 files by the hash of its DID) and
// the 256 files of settled trades: the valid set passes, and each single alteration is refused.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ContestContractError, checkContests } from "../scripts/contests-contract.mjs";
import { SHARDS, shard } from "../src/lib/did-shard.mjs";
import { DIDS, validIndex } from "./fixtures/contests-valid.mjs";

const hex = (k) => k.toString(16).padStart(2, "0");

function build(withTrades = false) {
  const index = validIndex();
  const lines = [[1, DIDS[0], "76.35", "official", ["44.66", "221.65"]], [2, DIDS[1], "68.41", "signed", null], [3, DIDS[2], "-3.10", "complete", ["-12.40", "229.40"]]];
  const main = { schema: "room-census/contest-ranking/2", contest: "close-1", sweep: 2, at: "2026-09-25T17:31:00Z", traders: 3, owners: 600784,
    capture_start: "13:32 UTC", shards: SHARDS, notes: { official: "o", signed: "s", complete: "c", partial: "p" }, top: lines.map((l) => [...l]) };
  const docs = { "data/contests/index.json": index, "data/contests/close-1.ranking.json": main };
  for (let k = 0; k < SHARDS; k++) {
    docs[`data/contests/close-1.ranking.${hex(k)}.json`] = { schema: "room-census/contest-ranking-shard/1", contest: "close-1", sweep: 2, shard: hex(k), rows: [] };
    if (withTrades) docs[`data/contests/close-1.trades.${hex(k)}.json`] = { schema: "room-census/contest-trades/1", contest: "close-1", sweep: 2, shard: hex(k), keys: {} };
  }
  for (const l of lines) docs[`data/contests/close-1.ranking.${shard(l[1])}.json`].rows.push([...l]);
  if (withTrades) docs[`data/contests/close-1.trades.${shard(DIDS[0])}.json`].keys[DIDS[0]] = [[1, "b", "44.66", "221.65", "0.98"], [2, "x", "1", "224.00", "0.002240"]];
  return docs;
}

function run(mutate = () => {}, withTrades = false) {
  const docs = build(withTrades);
  mutate(docs, docs["data/contests/index.json"].contests[0], docs["data/contests/close-1.ranking.json"]);
  return () => checkContests(Object.keys(docs), (rel) => docs[rel]);
}

const at = (did) => `data/contests/close-1.ranking.${shard(did)}.json`;
const tradesAt = (did) => `data/contests/close-1.trades.${shard(did)}.json`;

test("a valid ranking v2 passes, with or without the trade files", () => {
  assert.doesNotThrow(run());
  assert.doesNotThrow(run(() => {}, true));
});

const MUTATIONS = [
  ["a shard file missing", (d) => { delete d[at(DIDS[2])]; }, /shard .. is missing/],
  ["a key in the wrong shard", (d) => { const r = d[at(DIDS[2])].rows.pop(); d[`data/contests/close-1.ranking.${shard(DIDS[2]) === "00" ? "01" : "00"}.json`].rows.push(r); }, /belongs to shard/],
  ["a key listed twice", (d) => { d[at(DIDS[0])].rows.push([4, DIDS[0], "1.00", "complete"]); d["data/contests/close-1.ranking.json"].traders = 4; d["data/contests/index.json"].contests[0].ranking.traders = 4; }, /rank 4|listed twice/],
  ["a rank repeated", (d) => { d[at(DIDS[2])].rows[0][0] = 1; }, /out of range or repeated|differs between/],
  ["the trader count off", (d, c, m) => { m.traders = 4; c.ranking.traders = 4; }, /hold 3 keys, not 4|too long/],
  ["the top list not starting with the referee's list", (d, c, m) => { m.top[1][1] = DIDS[2]; }, /not line 2 of the referee's signed list/],
  ["a signed line marked official while our recount has not confirmed it", (d, c, m) => { m.top[1][3] = "official"; }, /marked official but checked pending/],
  ["a key outside the referee's list marked as signed", (d, c, m) => { m.top[2][3] = "signed"; }, /marked as signed but is not in the referee's list/],
  ["the top list and a shard disagreeing", (d) => { d[at(DIDS[2])].rows[0][2] = "-3.20"; }, /differs between the top list and its shard/],
  ["a shard of another update", (d) => { d[at(DIDS[0])].sweep = 1; }, /is not shard/],
  ["a note missing", (d, c, m) => { delete m.notes.signed; }, /notes missing/],
];
for (const [name, mutate, pattern] of MUTATIONS) {
  test(`refused: ${name}`, () => {
    assert.throws(run(mutate), (e) => e instanceof ContestContractError && pattern.test(e.message), `${name}: ${pattern}`);
  });
}

const TRADE_MUTATIONS = [
  ["a trades file missing", (d) => { delete d[tradesAt(DIDS[1])]; }, /are in 255 files/],
  ["a trade with an unknown side", (d) => { d[tradesAt(DIDS[0])].keys[DIDS[0]][0][1] = "long"; }, /is malformed/],
  ["a trade from a later update", (d) => { d[tradesAt(DIDS[0])].keys[DIDS[0]][0][0] = 3; }, /is malformed/],
  ["a price with three decimals", (d) => { d[tradesAt(DIDS[0])].keys[DIDS[0]][0][3] = "221.655"; }, /is malformed/],
  ["a key in the wrong trades file", (d) => { const f = tradesAt(DIDS[0]); d[`data/contests/close-1.trades.${shard(DIDS[0]) === "00" ? "01" : "00"}.json`].keys[DIDS[0]] = d[f].keys[DIDS[0]]; delete d[f].keys[DIDS[0]]; }, /bad key/],
];
for (const [name, mutate, pattern] of TRADE_MUTATIONS) {
  test(`refused: ${name}`, () => {
    assert.throws(run(mutate, true), (e) => e instanceof ContestContractError && pattern.test(e.message), `${name}: ${pattern}`);
  });
}
