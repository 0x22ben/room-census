// Ranks of the visitor's saved DIDs in the live contest, shared by the account menu and the My DIDs page.
// They come from the contest's published ranking files (same order as the Top 100) and are remembered
// in this browser for 15 minutes; a DID removed while its lookup runs is not written back.
import { RANKS as CACHE, saved } from "../lib/saved-store";
import { lookup, type Files, type Signed } from "./ranking-lookup";

const TTL = 15 * 60_000;
export type Rank = { rank: number; pnl: string } | null;

export const short = (did: string) => `${did.slice(8, 14)}…${did.slice(-6)}`;
export const rankText = (r: Rank) => (r ? `#${r.rank.toLocaleString("en-US")}` : "–");
export const pnlText = (r: Rank) => (r ? `${Number(r.pnl) > 0 ? "+" : ""}${r.pnl}` : "No trade");
export const pnlTone = (r: Rank) => (r && Number(r.pnl) > 0 ? "text-accent" : r && Number(r.pnl) < 0 ? "text-down" : "text-text-muted");

function cached(): Record<string, { at: number; r: Rank }> {
  try {
    return JSON.parse(window.localStorage.getItem(CACHE) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

export function ranker(files: Files | undefined, signed: Signed[]) {
  return async function rankOf(did: string): Promise<Rank> {
    if (!files) return null;
    const hit = cached()[did];
    if (hit && Date.now() - hit.at < TTL) return hit.r;
    try {
      const { row, referee } = await lookup(files, did, signed);
      const r: Rank = row ? { rank: referee?.rank ?? row[0], pnl: referee?.pnl ?? row[2] } : null;
      // read again after the wait: the DID may have been removed or forgotten meanwhile
      if (saved().some((s) => s.did === did)) {
        const now = cached();
        now[did] = { at: Date.now(), r };
        try { window.localStorage.setItem(CACHE, JSON.stringify(now)); } catch { /* no memory */ }
      }
      return r;
    } catch {
      return null;
    }
  };
}
