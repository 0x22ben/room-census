// Which of the 256 files of a contest holds a key: two hex digits from the FNV-1a hash of the DID.
// The witness computes the same on the server (export_contests.py, shard()); hex, so no two file names
// differ by case only.
export const SHARDS = 256;

/** "bf" for did:key:z6MkgTDg…u7Hne. */
export function shard(did) {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(did)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % SHARDS).toString(16).padStart(2, "0");
}

/** The file of one shard, next to the contest's main file: "/data/contests/close-1.ranking.json" gives
 * "/data/contests/close-1.ranking.bf.json" (kind "ranking") or "/data/contests/close-1.trades.bf.json". */
export function shardFile(mainFile, kind, s) {
  return mainFile.replace(/ranking\.json$/, `${kind}.${s}.json`);
}
