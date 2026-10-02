// Ranking v2 (a summary with the first places, every key in one of 256 files by the hash of its DID) and
// the 256 files of settled trades: the valid set passes, and each single alteration is refused.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ContestContractError, checkContests } from "../scripts/contests-contract.mjs";
import { shard } from "../src/lib/did-shard.mjs";
import { DIDS, validRankingV2Files } from "./fixtures/contests-valid.mjs";
import { MUTATIONS, TRADE_MUTATIONS } from "./fixtures/contests-v2-mutations.mjs";

// `fresh`: each read parses a new copy, as the staging step does from disk, and counts the reads
function run(mutate = () => {}, withTrades = false, fresh = false, reads = new Map()) {
  const docs = validRankingV2Files(withTrades);
  mutate(docs, docs["data/contests/index.json"].contests[0], docs["data/contests/close-1.ranking.json"]);
  const read = fresh
    ? (rel) => { reads.set(rel, (reads.get(rel) ?? 0) + 1); return rel in docs ? JSON.parse(JSON.stringify(docs[rel])) : undefined; }
    : (rel) => docs[rel];
  return () => checkContests(Object.keys(docs), read);
}

test("a valid ranking v2 passes, with or without the trade files", () => {
  assert.doesNotThrow(run());
  assert.doesNotThrow(run(() => {}, true));
});

test("the shards are checked one at a time: each file is read once, from a fresh copy", () => {
  const reads = new Map();
  assert.doesNotThrow(run(() => {}, true, true, reads));
  assert.equal(reads.size, 2 + 256 + 256);
  assert.ok([...reads.values()].every((n) => n === 1), "no file is read twice");
});

test("our key's settled-trade status is checked against the shards", () => {
  assert.throws(run((d, c) => { c.self_key.settled_trade = !c.self_key.settled_trade; }, false, true),
    (e) => e instanceof ContestContractError && /settled-trade status disagrees/.test(e.message));
  assert.throws(run((d, c) => { c.self_key.did = DIDS[1]; c.self_key.settled_trade = false; }, false, true),
    (e) => e instanceof ContestContractError && /settled-trade status disagrees/.test(e.message));
  assert.doesNotThrow(run((d, c) => { c.self_key.did = DIDS[1]; c.self_key.settled_trade = true; }, false, true));
});

test("a key listed twice in its own shard is refused even with distinct ranks", () => {
  const twice = (d, c, m) => {
    d[`data/contests/close-1.ranking.${shard(DIDS[1])}.json`].rows.push([4, DIDS[1], "1.00", "complete"]);
    m.traders = 4;
    c.ranking.traders = 4;
  };
  assert.throws(run(twice, false, true), (e) => e instanceof ContestContractError && /listed twice/.test(e.message));
});

for (const [name, mutate, pattern] of MUTATIONS) {
  test(`refused: ${name}`, () => {
    for (const fresh of [false, true]) {
      assert.throws(run(mutate, false, fresh), (e) => e instanceof ContestContractError && pattern.test(e.message), `${name}: ${pattern}`);
    }
  });
}

for (const [name, mutate, pattern] of TRADE_MUTATIONS) {
  test(`refused: ${name}`, () => {
    for (const fresh of [false, true]) {
      assert.throws(run(mutate, true, fresh), (e) => e instanceof ContestContractError && pattern.test(e.message), `${name}: ${pattern}`);
    }
  });
}
