// Contests followed by the Room Census witness. Until the live export exists (step 3), the pages read
// a sample built from the real capture of 25 Sep 2026 (scripts/contests-sample.py) and say so.
import sample from "../fixtures/contests.sample.json";

export type CheckState = "ok" | "warn" | "wait";
export type Check = { state: CheckState; title: string; text: string; help: string };
export type LeaderRow = { rank: number; did: string; pnl: string; check: "match" | "pending" | "differs" };
export type Contest = {
  id: string;
  title: string;
  short: string;
  summary: string;
  status: "live" | "ended";
  opening: string;
  end: string;
  prize: string;
  prize_note?: string;
  winner?: string;
  winner_source?: string;
  rules: string;
  check: { level: "ok" | "partial"; label: string };
  latest?: { sweep: number; at: string; owners: number; price: string; price_time: string; price_age_s: number };
  series?: { n: number; at: string; owners: number; price: string | null }[];
  leaderboard?: { sweep: number; at: string; rows: LeaderRow[] };
  ranking?: { sweep: number; traders: number; file: string };
  checks: Check[];
};

export const SAMPLE = sample.sample === true;
export const CAPTURED_AT: string = sample.captured_at;
export const contests = (): Contest[] => sample.contests as Contest[];
export const contest = (id: string): Contest | undefined => contests().find((c) => c.id === id);

/** Tabs of a contest page; an ended contest without a leaderboard has no Leaderboard tab. */
export function tabs(c: Contest): { label: string; href: string }[] {
  const base = `/contests/${c.id}/`;
  return [
    { label: "Overview", href: base },
    ...(c.leaderboard ? [{ label: "Leaderboard", href: `${base}leaderboard/` }] : []),
    { label: "Verify", href: `${base}verify/` },
  ];
}

/** "did:key:z6MkgTDg…u7Hne": the start and the end, enough to recognise a key. */
export const shortDid = (did: string): string => `${did.slice(8, 16)}…${did.slice(-5)}`;

/** Signed profit with its unit: "+71.87", "-3.20", "0.00". */
export const signed = (v: string): string => (v.startsWith("-") || Number(v) === 0 ? v : `+${v}`);

/** "8 days 20 h left", "2 h 5 min left", or "ended". */
export function left(endIso: string, nowIso: string): string {
  const ms = Date.parse(endIso) - Date.parse(nowIso);
  if (ms <= 0) return "ended";
  const h = Math.floor(ms / 3_600_000);
  const d = Math.floor(h / 24);
  return d > 0 ? `${d} days ${h % 24} h left` : `${h} h ${Math.floor((ms % 3_600_000) / 60_000)} min left`;
}

/** "1 check passes", "5 checks pass" */
export const passes = (n: number): string => (n === 1 ? "1 check passes" : `${n} checks pass`);

/** Counts of each check state, for the summary line. */
export function tally(checks: Check[]): Record<CheckState, number> {
  return { ok: checks.filter((c) => c.state === "ok").length, warn: checks.filter((c) => c.state === "warn").length,
    wait: checks.filter((c) => c.state === "wait").length };
}
