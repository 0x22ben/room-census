// Finds one key in a contest's published ranking, with the same rank everywhere on the site: the
// referee's signed list first, with its ranks and signed scores, then our recount. Ranking v2 is
// already in that order and split in 256 files by the hash of the DID, so only one small file is
// read; ranking v1 (one file with every key, ordered by score) is put in that order here. The summary is
// a file of this site; the shards are read from the contest-data commit the build names (data-shards,
// src/lib/contest-files.mjs), on raw.githubusercontent.com, with a plain GET: no credentials, no header.
import { LOCAL_CONTEST_FILES, shardUrl } from "../lib/contest-files.mjs";
import { shard } from "../lib/did-shard.mjs";
import { refereeLine } from "../lib/standings.mjs";

export type Source = "official" | "signed" | "complete" | "partial";
export type Row = [number, string, string, Source, ([string, string] | null)?];
export type Signed = { rank: number; did: string; pnl: string; check: "match" | "pending" | "differs" };
/** referee: the referee's own rank and score for the key when the page was given a signed list that names it
 * (its final standings): shown instead of the line of our files, which is marked at the last update. */
export type Found = { row: Row | undefined; traders: number; sweep: number; notes: Partial<Record<Source, string>>; referee?: { rank: number; pnl: string } };
/** A contest's ranking summary (a file of this site) and the folder its shards are read from. */
export type Files = { url: string; shards: string };

/** The files named by an element's data-url and data-shards; undefined when it names no ranking. */
export function filesOf(el: HTMLElement): Files | undefined {
  const url = el.dataset.url;
  return url ? { url, shards: el.dataset.shards || LOCAL_CONTEST_FILES } : undefined;
}

type V1 = { schema: string; sweep: number; traders: number; rows: Row[]; notes?: Partial<Record<Source, string>> };
type V2 = { schema: string; sweep: number; traders: number; top: Row[]; shards: number; notes?: Partial<Record<Source, string>> };

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

/** The v1 file in the site's order: signed lines first, then the others, numbered on. */
function fromV1(doc: V1, did: string, signed: Signed[]): Row | undefined {
  const own = signed.find((s) => s.did === did);
  const mine = doc.rows.find((r) => r[1] === did);
  if (own) return [own.rank, did, own.pnl, own.check === "match" ? "official" : "signed", ...(mine && mine.length > 4 ? [mine[4]] : [])] as Row;
  if (!mine) return undefined;
  const listed = new Set(signed.map((s) => s.did));
  let before = 0;
  for (const r of doc.rows) {
    if (r[1] === did) break;
    if (!listed.has(r[1])) before += 1;
  }
  return [signed.length + before + 1, did, mine[2], mine[3] === "official" ? "complete" : mine[3], ...(mine.length > 4 ? [mine[4]] : [])] as Row;
}

export async function lookup(files: Files, did: string, signed: Signed[]): Promise<Found> {
  const doc = await get<V1 | V2>(files.url);
  if ("top" in doc) {
    const part = await get<{ rows: Row[] }>(shardUrl(files.shards, files.url, "ranking", shard(did)));
    return { row: part.rows.find((r) => r[1] === did), traders: doc.traders, sweep: doc.sweep, notes: doc.notes ?? {}, referee: refereeLine(signed, did) };
  }
  return { row: fromV1(doc, did, signed), traders: doc.traders, sweep: doc.sweep, notes: doc.notes ?? {} };
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
