// Ranks of the visitor's saved DIDs in the live contest, shared by Find my DID, the account menu and the
// My DIDs page. A saved DID has a rank and a score only when it is in the referee's signed top list
// (signedLine); any other shows "–", not verified, until our recount can be proved (Ben, 2026-09-29:
// never show a wrong figure). Nothing is read over the network for them, and nothing is remembered.
import { signedLine, type Signed } from "./ranking-lookup";

export type Rank = { rank: number; pnl: string } | null;

export const short = (did: string) => `${did.slice(8, 14)}…${did.slice(-6)}`;
export const rankText = (r: Rank) => (r ? `#${r.rank.toLocaleString("en-US")}` : "–");
export const pnlText = (r: Rank) => (r ? `${Number(r.pnl) > 0 ? "+" : ""}${r.pnl}` : "not verified");
export const pnlTone = (r: Rank) => (r && Number(r.pnl) > 0 ? "text-accent" : r && Number(r.pnl) < 0 ? "text-down" : "text-text-muted");

export function ranker(signed: Signed[]) {
  return function rankOf(did: string): Rank {
    const line = signedLine(signed, did);
    return line ? { rank: line.rank, pnl: line.pnl } : null;
  };
}
