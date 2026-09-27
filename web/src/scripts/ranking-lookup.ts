// Finds one key in a contest's published ranking, with the same rank everywhere on the site: the
// referee's signed list first, with its ranks and signed scores, then our recount. Ranking v2 is
// already in that order and split in 256 files by the hash of the DID, so only one small file is
// read; ranking v1 (one file with every key, ordered by score) is put in that order here.
import { shard, shardFile } from "../lib/did-shard.mjs";

export type Source = "official" | "signed" | "complete" | "partial";
export type Row = [number, string, string, Source, ([string, string] | null)?];
export type Signed = { rank: number; did: string; pnl: string; check: "match" | "pending" | "differs" };
export type Found = { row: Row | undefined; traders: number; sweep: number; notes: Partial<Record<Source, string>> };

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

export async function lookup(mainUrl: string, did: string, signed: Signed[]): Promise<Found> {
  const doc = await get<V1 | V2>(mainUrl);
  if ("top" in doc) {
    const part = await get<{ rows: Row[] }>(shardFile(mainUrl, "ranking", shard(did)));
    return { row: part.rows.find((r) => r[1] === did), traders: doc.traders, sweep: doc.sweep, notes: doc.notes ?? {} };
  }
  return { row: fromV1(doc, did, signed), traders: doc.traders, sweep: doc.sweep, notes: doc.notes ?? {} };
}

/** A key's settled trades ([sweep, side, contracts, price, fee]), or undefined when not published yet. */
export async function tradesOf(mainUrl: string, did: string): Promise<[number, "b" | "s" | "x", string, string, string][] | undefined> {
  try {
    const part = await get<{ keys: Record<string, [number, "b" | "s" | "x", string, string, string][]> }>(shardFile(mainUrl, "trades", shard(did)));
    return part.keys[did] ?? [];
  } catch {
    return undefined;
  }
}
