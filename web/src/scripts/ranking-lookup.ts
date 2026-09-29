// Which keys the site may rank, and where their trades are read. Until our recount can be proved against
// the referee's signed hashes, a key has a rank and a score only when it is in the referee's signed top
// list, which every page hands its script (data-signed, src/lib/contests.ts signedRows): the lines of our
// recount stay out of every page (Ben, 2026-09-29: never show a wrong figure). A key's trades are split
// in 256 files by the hash of the DID, so only one small file is read, from the contest-data commit the
// build names (data-shards, src/lib/contest-files.mjs), on raw.githubusercontent.com, with a plain GET:
// no credentials, no header.
import { LOCAL_CONTEST_FILES, shardUrl } from "../lib/contest-files.mjs";
import { shard } from "../lib/did-shard.mjs";

/** One line of the referee's signed top list: its rank, the key, its signed score and our check of it. */
export type Signed = { rank: number; did: string; pnl: string; check: "match" | "pending" | "differs" };
/** A contest's ranking summary (a file of this site) and the folder its shards are read from. */
export type Files = { url: string; shards: string };

/** The one place that decides whether a key is shown: its line of the signed top list, or undefined. */
export const signedLine = (signed: Signed[], did: string): Signed | undefined => signed.find((s) => s.did === did);

/** The files named by an element's data-url and data-shards; undefined when it names no ranking. */
export function filesOf(el: HTMLElement): Files | undefined {
  const url = el.dataset.url;
  return url ? { url, shards: el.dataset.shards || LOCAL_CONTEST_FILES } : undefined;
}

const cache = new Map<string, Promise<unknown>>();
function get<T>(url: string): Promise<T> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p as Promise<T>;
}

/** A key's settled trades ([sweep, side, contracts, price, fee]), or undefined when not published yet. */
export async function tradesOf(files: Files, did: string): Promise<[number, "b" | "s" | "x", string, string, string][] | undefined> {
  try {
    const part = await get<{ keys: Record<string, [number, "b" | "s" | "x", string, string, string][]> }>(shardUrl(files.shards, files.url, "trades", shard(did)));
    return part.keys[did] ?? [];
  } catch {
    return undefined;
  }
}
