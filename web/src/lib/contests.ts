// Contests followed by the Room Census witness. The witness on the server publishes data/contests/
// (index.json and one ranking per contest); without it, as on a fresh checkout, the pages read a sample
// built from the real capture of 25 Sep 2026 (scripts/contests-sample.py) and say so on every page.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import sample from "../fixtures/contests.sample.json";
import { json } from "./files";
import { PHASE_LABEL, after, phase, until } from "./contest-time.mjs";
import { dateTimeUtc } from "./format";

type Doc = { sample?: boolean; captured_at: string; contests: Contest[] };
const LIVE = existsSync(resolve(process.cwd(), ".public", "data", "contests", "index.json"));
const doc: Doc = LIVE ? json<Doc>("data/contests/index.json") : (sample as unknown as Doc);

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

/** Rows of the signed top list grouped by equal score: the first key of each group, and how many more
 * share its score (they share the places they span, per the rules). */
export function tieGroups(rows: LeaderRow[]): { row: LeaderRow; tied: number }[] {
  const out: { row: LeaderRow; tied: number }[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.row.pnl === r.pnl) last.tied += 1;
    else out.push({ row: r, tied: 0 });
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
