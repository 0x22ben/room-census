// Where the pages read the contest shards: the contest-data commit on raw.githubusercontent.com when the
// build names one, the site itself otherwise, and never an address built from a malformed ref.
import assert from "node:assert/strict";
import { test } from "node:test";

import { LOCAL_CONTEST_FILES, RAW_REPOSITORY, contestFilesBase, shardUrl } from "../src/lib/contest-files.mjs";

const REF = "e92c0d791ca7efcc59e34ce8e258dcbed3aa1db4";
const MAIN = "/data/contests/close-1.ranking.json";

test("with a contest-data commit, the shards are read at that commit on raw.githubusercontent.com", () => {
  assert.equal(RAW_REPOSITORY, "https://raw.githubusercontent.com/0x22ben/room-census/");
  const base = contestFilesBase(REF);
  assert.equal(base, `https://raw.githubusercontent.com/0x22ben/room-census/${REF}/data/contests/`);
  assert.equal(shardUrl(base, MAIN, "ranking", "bf"), `https://raw.githubusercontent.com/0x22ben/room-census/${REF}/data/contests/close-1.ranking.bf.json`);
  assert.equal(shardUrl(base, MAIN, "trades", "0a"), `https://raw.githubusercontent.com/0x22ben/room-census/${REF}/data/contests/close-1.trades.0a.json`);
  // every address stays under the path the Content-Security-Policy allows
  assert.ok(shardUrl(base, MAIN, "trades", "ff").startsWith(RAW_REPOSITORY));
});

test("without one, the shards are asked from the site itself", () => {
  for (const none of [undefined, null, ""]) {
    assert.equal(contestFilesBase(none), "/data/contests/");
    assert.equal(contestFilesBase(none), LOCAL_CONTEST_FILES);
  }
  assert.equal(shardUrl(LOCAL_CONTEST_FILES, MAIN, "ranking", "00"), "/data/contests/close-1.ranking.00.json");
  assert.equal(shardUrl(LOCAL_CONTEST_FILES, MAIN, "trades", "bf"), "/data/contests/close-1.trades.bf.json");
});

test("a ref that is not a full 40-hex commit SHA is refused", () => {
  for (const bad of ["contest-data", "main", "HEAD", REF.slice(0, 7), REF.slice(0, 39), `${REF}0`, REF.toUpperCase(),
    `${REF}\n`, ` ${REF}`, `${REF.slice(0, 39)}g`, `../${REF.slice(3)}`, "refs/heads/contest-data", 42, {}]) {
    assert.throws(() => contestFilesBase(bad), /CONTEST_DATA_REF must be a full 40-hex commit SHA/, JSON.stringify(bad));
  }
});

test("only the two kinds of shard of a contest ranking file have an address", () => {
  const base = contestFilesBase(REF);
  assert.throws(() => shardUrl(base, MAIN, "index", "bf"), /unknown shard kind/);
  for (const s of ["b", "bff", "BF", "g0", "../"]) assert.throws(() => shardUrl(base, MAIN, "ranking", s), /not a shard/);
  // the sample's ranking (one file, no shards) has no shard address
  assert.throws(() => shardUrl(base, "/contests/close-1/ranking.json", "trades", "bf"), /not a contest ranking file/);
  assert.throws(() => shardUrl(base, "/data/contests/index.json", "ranking", "bf"), /not a contest ranking file/);
});
