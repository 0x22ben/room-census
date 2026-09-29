// Contests followed by the Room Census witness. The witness on the server publishes data/contests/
// (index.json and one ranking per contest); without it, as on a fresh checkout, the pages read a sample
// built from the real capture of 25 Sep 2026 (scripts/contests-sample.py) and say so on every page.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import sample from "../fixtures/contests.sample.json";
import { json } from "./files";
import sampleRanking from "../fixtures/close-1.ranking.sample.json";
import { contestFilesBase } from "./contest-files.mjs";
import { shard, shardFile } from "./did-shard.mjs";
import { scoreCurve, verifiedTrades } from "./fold-lite.mjs";
import { robustRange } from "./robust-range.mjs";

type Trade = [number, "b" | "s" | "x", string, string, string];
import { PHASE_LABEL, after, phase, until } from "./contest-time.mjs";
import { dateTimeUtc } from "./format";

type Doc = { sample?: boolean; captured_at: string; contests: Contest[] };
const LIVE = existsSync(resolve(process.cwd(), ".public", "data", "contests", "index.json"));
const doc: Doc = LIVE ? json<Doc>("data/contests/index.json") : (sample as unknown as Doc);

/** Where the browser reads the ranking and trades shards (data-shards of the pages that look a DID up):
 * the contest-data commit this build used, on raw.githubusercontent.com, or the site itself when the
 * build names none. A malformed CONTEST_DATA_REF stops the build (src/lib/contest-files.mjs). */
export const SHARDS_BASE: string = contestFilesBase(process.env.CONTEST_DATA_REF);

// The shards are not in the site, so the build reads them from the checkout (data/contests/, filled by
// pages.yml from that same commit), after the staging step has checked every one of them.
const REPOSITORY = resolve(process.cwd(), "..");
const hasShard = (rel: string): boolean => existsSync(resolve(REPOSITORY, rel));
const shardJson = <T>(rel: string): T => JSON.parse(readFileSync(resolve(REPOSITORY, rel), "utf8")) as T;

export type CheckState = "ok" | "warn" | "wait";
export type Check = { state: CheckState; title: string; text: string; help: string };
/** An open position rebuilt by our recount: [signed net contracts, average entry price]; null when none. */
export type Position = [string, string] | null;
export type LeaderRow = { rank: number; did: string; pnl: string; check: "match" | "pending" | "differs"; position?: Position };
export type Contest = {
  id: string;
  title: string;
  short: string;
  summary: string;
  status: Phase;
  opening: string;
  trading_lock_at: string;
  final_price_at: string | null;
  coverage_start: string | null;
  prize: string;
  prize_note?: string;
  winner?: string;
  winner_source?: string;
  rules: string;
  check: { level: "ok" | "partial"; label: string };
  latest?: { sweep: number; at: string; owners: number; price: string; price_time: string; price_age_s: number };
  series?: SeriesPoint[];
  leaderboard?: { sweep: number; at: string; rows: LeaderRow[] };
  ranking?: { sweep: number; traders: number; file: string };
  checks: Check[];
  self_key?: { did: string; registration: { room: string; seq: number; at: string } | null; mint: "confirmed" | "not_established"; settled_trade: boolean };
};
export type Phase = "upcoming" | "live" | "closed" | "ended";
/** One referee update. Beyond players and price, every field is optional: an export that cannot
 * establish a number leaves it out. global: the agents' own price (volume-weighted, signed by the
 * referee); top and line: the #1 score and the score holding the last prize place, from its signed top
 * list; settled and void: trades it settled and voided; active, long and short: keys holding a trade,
 * a long or a short position in our recount. */
export type SeriesPoint = { n: number; at: string; owners: number; price: string | null; global?: string | null;
  top?: string | null; line?: string | null; settled?: number; void?: number; active?: number; long?: number; short?: number };

export const SAMPLE = !LIVE;
export const CAPTURED_AT: string = doc.captured_at;
export const contests = (): Contest[] => doc.contests;
export const contest = (id: string): Contest | undefined => contests().find((c) => c.id === id);

/** Tabs of a contest page: Live (the numbers, the chart and the ranking) and Verify (the checks). */
export function tabs(c: Contest): { label: string; href: string }[] {
  const base = `/contests/${c.id}/`;
  return [
    { label: phase(c, CAPTURED_AT) === "ended" ? "Results" : "Live", href: base },
    { label: "Verify", href: `${base}verify/` },
  ];
}

/** One line of a contest's full ranking file: rank, DID, profit, source of the number, open position. */
export type RankRow = [number, string, string, "official" | "signed" | "complete" | "partial", Position?];
/** Ranking v1 holds every row; v2 holds the first places and 256 shard files next to it. */
type RankingDoc = { rows: RankRow[] } | { top: RankRow[]; shards: number };

export type TopRow = { rank: number; did: string; pnl: string; source: "signed" | "complete" | "partial"; check?: LeaderRow["check"]; position?: Position };

/** The first `limit` places: every line of the referee's signed top list first, with its rank, its
 * signed score and our check, then the next keys of our recount of the signed trades (the file "Find
 * my DID" searches), numbered on from there. A key of the signed list is never shown twice. */
export function topTraders(c: Contest, limit = 100): TopRow[] {
  const signedRows = c.leaderboard?.rows ?? [];
  const doc = !c.ranking ? undefined : !LIVE ? (c.id === "close-1" ? (sampleRanking as RankingDoc) : undefined)
    : json<RankingDoc>(c.ranking.file.replace(/^\//, ""));
  // ranking v2 already lists the signed list first, with the referee's ranks: read its first places
  if (doc && "top" in doc) {
    const checks = new Map(signedRows.map((r) => [r.did, r.check]));
    return doc.top.slice(0, limit).map(([rank, did, pnl, source, position]) => source === "official" || source === "signed"
      ? { rank, did, pnl, source: "signed", check: source === "official" ? "match" : (checks.get(did) ?? "pending"), position }
      : { rank, did, pnl, source, position });
  }
  const out: TopRow[] = signedRows.slice(0, limit).map((r) => ({ rank: r.rank, did: r.did, pnl: r.pnl, source: "signed", check: r.check, position: r.position }));
  if (!doc || out.length >= limit) return out;
  const file: RankRow[] = doc.rows;
  const seen = new Set(out.map((r) => r.did));
  for (const [, did, pnl, source, position] of file) {
    if (out.length >= limit) break;
    if (seen.has(did)) continue;
    out.push({ rank: out.length + 1, did, pnl, source: source === "partial" ? "partial" : "complete", position });
  }
  return out;
}

/** The last day of each key's score (288 updates), replayed at build time from the published trades,
 * as a 96 x 26 SVG path, and whether it went up. Keys without published trades get nothing, and so do
 * keys whose trades do not add up to their ranking line (verifiedTrades): never a wrong curve. */
export function sparklines(c: Contest, rows: { did: string; pnl: string; position?: RankRow[4] }[]): Map<string, { d: string; up: boolean }> {
  const out = new Map<string, { d: string; up: boolean }>();
  if (!c.ranking || !LIVE) return out;
  // up to the ranking's sweep only: the published trades say nothing of a key's later trades
  const marks = (c.series ?? []).map((p) => [p.n, Number(p.global ?? p.price ?? 0)] as [number, number])
    .filter(([n, v]) => v > 0 && n <= c.ranking!.sweep);
  const recent = marks.slice(-289);
  const files = new Map<string, Record<string, Trade[]> | null>();
  for (const { did, pnl, position } of rows) {
    const s = shard(did);
    if (!files.has(s)) {
      const rel = shardFile(c.ranking.file, "trades", s).replace(/^\//, "");
      files.set(s, hasShard(rel) ? shardJson<{ keys: Record<string, Trade[]> }>(rel).keys : null);
    }
    const trades = files.get(s)?.[did];
    if (!trades?.length || !verifiedTrades(trades, marks, c.ranking.sweep, pnl, position)) continue;
    const all = scoreCurve(trades, marks).slice(-recent.length);
    const [w, h] = [96, 26];
    const range = robustRange(all);
    const lo = range?.min ?? Math.min(...all), hi = range?.max ?? Math.max(...all);
    const y = (v: number) => (h - 2 - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo || 1)) * (h - 4)).toFixed(1);
    const d = all.map((v, i) => `${i ? "L" : "M"}${((i / Math.max(1, all.length - 1)) * w).toFixed(1)} ${y(v)}`).join(" ");
    out.set(did, { d, up: all[all.length - 1] >= all[0] });
  }
  return out;
}

/** The rank and score of some keys in a contest's published ranking, read at build time from their
 * shard files (ranking v2) or from the one file (v1). Keys that did not trade are left out. */
export function ranksOf(c: Contest, dids: string[]): Map<string, { rank: number; pnl: string }> {
  const out = new Map<string, { rank: number; pnl: string }>();
  if (!c.ranking || !LIVE) return out;
  const main = json<RankingDoc>(c.ranking.file.replace(/^\//, ""));
  if (!("top" in main)) {
    const want = new Set(dids);
    for (const [rank, did, pnl] of main.rows) if (want.has(did)) out.set(did, { rank, pnl });
    return out;
  }
  const byShard = new Map<string, string[]>();
  for (const d of dids) byShard.set(shard(d), [...(byShard.get(shard(d)) ?? []), d]);
  for (const [s, list] of byShard) {
    const rows = shardJson<{ rows: RankRow[] }>(shardFile(c.ranking.file, "ranking", s).replace(/^\//, "")).rows;
    const want = new Set(list);
    for (const [rank, did, pnl] of rows) if (want.has(did)) out.set(did, { rank, pnl });
  }
  return out;
}

/** "−0.53%" between two prices, or undefined when one is missing. */
export function change(from: string | null | undefined, to: string | null | undefined): string | undefined {
  if (!from || !to) return undefined;
  const v = (Number(to) / Number(from) - 1) * 100;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`;
}

/** "6d 21h", "3h 05m" or "12m" until `iso`, counted from our capture (a build must be reproducible). */
export function countdown(iso: string): string {
  const m = Math.max(0, Math.floor((Date.parse(iso) - Date.parse(CAPTURED_AT)) / 60_000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${String(mm).padStart(2, "0")}m` : `${mm}m`;
}

/** "did:key:z6MkgTDg…u7Hne": the start and the end, enough to recognise a key. */
export const shortDid = (did: string): string => `${did.slice(8, 16)}…${did.slice(-5)}`;

/** "Long" / "Short" / "Flat" and "44.66 @ 221.65"; undefined when the export carries no position. */
export function positionParts(p: Position | undefined): { side: string; detail: string } | undefined {
  if (p === undefined) return undefined;
  if (p === null) return { side: "Flat", detail: "" };
  const short = p[0].startsWith("-");
  return { side: short ? "Short" : "Long", detail: `${short ? p[0].slice(1) : p[0]} @ ${p[1]}` };
}

/** Signed profit with its unit: "+71.87", "-3.20", "0.00". */
export const signed = (v: string): string => (v.startsWith("-") || Number(v) === 0 ? v : `+${v}`);

/** The phase of a contest at the time of our capture (not the build time: a build must be reproducible). */
export const phaseOf = (c: Contest): Phase => phase(c, CAPTURED_AT) as Phase;
export const phaseLabel = (p: Phase): string => PHASE_LABEL[p];

/** The one line that says where a contest stands in time. */
export function timeLine(c: Contest): string {
  const p = phaseOf(c);
  if (p === "upcoming") return `Starts ${dateTimeUtc(c.opening)}`;
  // a sample is frozen: no countdown that would already be wrong
  if (p === "live") return `Trading closes ${dateTimeUtc(c.trading_lock_at)}${SAMPLE ? "" : ` · ${until(c.trading_lock_at, CAPTURED_AT)} left`}`;
  if (p === "closed") return `Trading closed · final price at ${dateTimeUtc(c.final_price_at!)}`;
  return `Ended ${dateTimeUtc(c.final_price_at ?? c.trading_lock_at)}`;
}

/** What we hold of a contest and from when; never implies records we do not hold. `coverage_start` is
 * where our copy of the trading room begins; the referee's own updates are kept from its first one. */
export function coverageLine(c: Contest): string {
  if (!c.coverage_start) return "Not followed live: checked from what the referee published after the end.";
  const late = Date.parse(c.coverage_start) - Date.parse(c.opening);
  return late < 60_000
    ? `We hold the referee's updates and the trading room from the opening, ${dateTimeUtc(c.coverage_start)}.`
    : `We hold every referee update since the opening. Our copy of the trading room starts ${dateTimeUtc(c.coverage_start)}, ${after(c.coverage_start, c.opening)} after the opening: earlier trading-room messages were already deleted by Technocore.`;
}

/** "1 check passes", "5 checks pass" */
export const passes = (n: number): string => (n === 1 ? "1 check passes" : `${n} checks pass`);

/** Counts of each check state, for the summary line. */
export function tally(checks: Check[]): Record<CheckState, number> {
  return { ok: checks.filter((c) => c.state === "ok").length, warn: checks.filter((c) => c.state === "warn").length,
    wait: checks.filter((c) => c.state === "wait").length };
}
