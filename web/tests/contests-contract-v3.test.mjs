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

// The closing price the referee posted (2026-10-04): published for an ended contest, with the trade it comes from.
const ENDED = (d, c) => {
  d["data/contests/index.json"].captured_at = "2026-10-04T10:00:15.644705Z";
  c.status = "ended";
  c.final = { price: "234.69", trade: { tid: 868189527772348, time: "2026-10-04T09:59:40.596000Z" } };
};
const ended = (more = () => {}) => (d, c, m) => { ENDED(d, c); more(d, c, m); };

test("an ended contest may carry the referee's closing price and its trade", () => {
  assert.doesNotThrow(run(ended()));
});

const FINAL_MUTATIONS = [
  ["a closing price with one decimal", (d, c) => { c.final.price = "234.7"; }, /final price is malformed/],
  ["a closing price that is not text", (d, c) => { c.final.price = 234.69; }, /final price is malformed/],
  ["a closing price with a key we do not know", (d, c) => { c.final.note = "x"; }, /final price is malformed/],
  ["a closing trade id that is not a whole number", (d, c) => { c.final.trade.tid = "868189527772348"; }, /final price is malformed/],
  ["a closing trade time that is not a time", (d, c) => { c.final.trade.time = "yesterday"; }, /final price is malformed/],
  ["a closing trade after the final price time", (d, c) => { c.final.trade.time = "2026-10-04T10:00:01Z"; }, /not before the final price time/],
  ["a closing price on a contest that has not ended", (d, c) => { c.status = "closed"; d["data/contests/index.json"].captured_at = "2026-10-04T09:30:00Z"; }, /only for an ended contest/],
];
for (const [name, mutate, pattern] of FINAL_MUTATIONS) {
  test(`refused: ${name}`, () => {
    assert.throws(run(ended(mutate)), (e) => e instanceof ContestContractError && pattern.test(e.message), `${name}: ${pattern}`);
  });
}

// The referee's signed final standings (2026-10-04 17:33 UTC), marked at the closing price.
const D = (ch) => `did:key:z6Mk${ch.repeat(44)}`;
const STANDINGS = () => ({
  price: "234.69", posted_at: "2026-10-04T17:33:04.421681Z", seq: 2557, owners: 18790926, zero_sum: "0.000000",
  places: [{ rank: 1, did: D("A"), score: "1576.916300", sharing: 1 }, { rank: 2, did: D("B"), score: "1424.740300", sharing: 1 },
    { rank: 3, did: D("C"), score: "1337.545600", sharing: 1 }],
  next: [{ rank: 4, did: D("D"), score: "1334.181800" }, { rank: 5, did: D("E"), score: "1305.782300" }],
});
const withStandings = (more = () => {}) => ended((d, c, m) => { c.standings = STANDINGS(); more(d, c, m); });

test("an ended contest may carry the referee's signed final standings", () => {
  assert.doesNotThrow(run(withStandings()));
});

test("final standings with a tie on the last prize place are accepted", () => {
  assert.doesNotThrow(run(withStandings((d, c) => {
    c.standings.places = [{ rank: 1, did: D("A"), score: "9.000000", sharing: 1 }, { rank: 2, did: D("B"), score: "5.000000", sharing: 1 },
      { rank: 3, did: D("C"), score: "4.000000", sharing: 2 }, { rank: 3, did: D("F"), score: "4.000000", sharing: 2 }];
    c.standings.next = [{ rank: 5, did: D("D"), score: "3.000000" }];
  })));
});

const STANDINGS_MUTATIONS = [
  ["standings without a closing price", (d, c) => { delete c.final; }, /need the final price/],
  ["standings marked at another price", (d, c) => { c.standings.price = "234.31"; }, /not at the final price/],
  ["standings dated before the closing trade", (d, c) => { c.standings.posted_at = "2026-10-04T09:00:00Z"; }, /dated before the closing trade/],
  ["standings with a key we do not know", (d, c) => { c.standings.note = "x"; }, /standings are malformed/],
  ["a score with two decimals", (d, c) => { c.standings.places[0].score = "1576.92"; }, /place 1 of the final standings is malformed/],
  ["a place with a malformed key", (d, c) => { c.standings.places[1].did = "did:key:zshort"; }, /place 2 of the final standings is malformed/],
  ["a next place with an unknown field", (d, c) => { c.standings.next[0].sharing = 1; }, /next place 1 of the final standings is malformed/],
  ["scores that are not in decreasing order", (d, c) => { c.standings.places[1].score = "1600.000000"; }, /decreasing order/],
  ["the same key twice", (d, c) => { c.standings.next[1].did = D("A"); }, /twice/],
  ["a next place that is not numbered on", (d, c) => { c.standings.next[0].rank = 9; }, /not numbered on/],
  ["a sharing count of zero", (d, c) => { c.standings.places[0].sharing = 0; }, /malformed rank or sharing/],
  ["a prize place ranked below the prize places", (d, c) => { c.standings.places[2].rank = 4; }, /malformed rank or sharing/],
  ["no prize place", (d, c) => { c.standings.places = []; }, /1 to 10 prize places/],
  ["a zero-sum check that is not six decimals", (d, c) => { c.standings.zero_sum = "0"; }, /zero-sum check/],
];
for (const [name, mutate, pattern] of STANDINGS_MUTATIONS) {
  test(`refused: ${name}`, () => {
    assert.throws(run(withStandings(mutate)), (e) => e instanceof ContestContractError && pattern.test(e.message), `${name}: ${pattern}`);
  });
}
