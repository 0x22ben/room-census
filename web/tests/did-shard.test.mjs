// The site and the witness must put a key in the same file: these values come from export_contests.py.
import assert from "node:assert/strict";
import { test } from "node:test";

import { shard, shardFile } from "../src/lib/did-shard.mjs";

test("a key lands in the same shard as on the server", () => {
  assert.equal(shard("did:key:z6MkgTDg3hEz4pwiFcJCDjRvR3hZbVWwy23oGuqFbFxu7Hne"), "bf");
  assert.equal(shard("did:key:z6MkhwLTnZEv8yzXSC973k3xcQHCDBMF8jrFDSo7refhCgmg"), "63");
  assert.equal(shard("did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte"), "5e");
});

test("shards are two lowercase hex digits and the file sits next to the ranking", () => {
  for (let i = 0; i < 200; i++) assert.match(shard(`did:key:z6Mk${i}`), /^[0-9a-f]{2}$/);
  assert.equal(shardFile("/data/contests/close-1.ranking.json", "trades", "0a"), "/data/contests/close-1.trades.0a.json");
  assert.equal(shardFile("/data/contests/close-1.ranking.json", "ranking", "ff"), "/data/contests/close-1.ranking.ff.json");
});
