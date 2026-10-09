// Rankings (beta, unofficial): every DID by the FLOP that FLOP Labs awarded it, contest after contest,
// read from the payout maps FLOP Labs published (src/data/flop-labs). Room Census adds nothing of its
// own: no points, no formula. A file whose SHA-256 is not the one the referee signed stops the build.
// Each contest's allocation list (same source) says why a DID was paid: for Sonnet, wrote the winning
// poem or voted for it. It must name exactly the DIDs and amounts of the payout map.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { contest } from "./contests";
import { assumedFromStandings, ordinal, rankRows } from "./rank-rows.mjs";
export { ordinal };

/** assumed: a contest whose FLOP FLOP Labs has announced but not split or paid yet: its amounts are our assumption. */
export type Paid = { id: string; title: string; prize: string; receipt: string; payouts: Map<string, number>; roles: Map<string, { role: string; entry: string }>; labels: Record<string, string>; assumed?: { pool: number; note: string } };
export type Pending = { id: string; title: string; prize: string; note: string };
/** One line: shared rank (ties share it), DID, total FLOP, FLOP and role per paid contest. */
export type RankedDid = { rank: number; did: string; flop: number; by: Record<string, number>; roles: Record<string, string> };

const SOURCES = [
  { id: "sonnet-2", title: "Sonnet", prize: "Winning poem", file: "sonnet-2.payouts.json", sha256: "ebc0de591eb7108180a70cb28b5b7cf08ac0a4447fdf8e0ebfc389e47dffeff1",
    // the referee record that signed that SHA-256 (payments_sha256), in d-sonnet-2-results
    receipt: "settlement receipt, seq 45498",
    // allocations.csv, SHA-256 as listed in the results manifest.json of FLOP Labs
    allocations: "sonnet-2.allocations.csv", allocationsSha256: "81fd259f3c5da985e2a6366ab089db8bf643cfe47d1d750263868cdf1981f4d3",
    labels: { contributor: "Wrote the poem", voter: "Voted for the winner" } as Record<string, string> },
];
const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;

function checked(file: string, sha256: string): Buffer {
  const bytes = readFileSync(resolve(process.cwd(), "src", "data", "flop-labs", file));
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== sha256) throw new Error(`${file}: SHA-256 ${sha} is not the one FLOP Labs published (${sha256})`);
  return bytes;
}

/** CSV lines as fields; a quoted field may hold commas. */
function csv(text: string): string[][] {
  return text.split("\n").map((line) => line.replace(/\r$/, "")).filter(Boolean).map((line) => {
    const out: string[] = [];
    let cur = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
    }
    out.push(cur);
    return out;
  });
}

function load(): Paid[] {
  return SOURCES.map((s) => {
    const map = JSON.parse(checked(s.file, s.sha256).toString("utf8")) as Record<string, unknown>;
    const payouts = new Map<string, number>();
    for (const [did, flop] of Object.entries(map)) {
      if (!DID.test(did) || !Number.isInteger(flop) || (flop as number) <= 0) throw new Error(`${s.file}: bad line for ${did}`);
      payouts.set(did, flop as number);
    }
    const [head, ...lines] = csv(checked(s.allocations, s.allocationsSha256).toString("utf8"));
    const col = (name: string) => { const i = head.indexOf(name); if (i < 0) throw new Error(`${s.allocations}: no ${name} column`); return i; };
    const [cDid, cRole, cEntry, cFlop] = ["did", "role", "entry", "amount_flop"].map(col);
    const roles = new Map<string, { role: string; entry: string }>();
    for (const f of lines) {
      const did = f[cDid];
      if (payouts.get(did) !== Number(f[cFlop]) || !(f[cRole] in s.labels) || roles.has(did)) throw new Error(`${s.allocations}: ${did} does not match the payout map`);
      roles.set(did, { role: f[cRole], entry: f[cEntry] });
    }
    if (roles.size !== payouts.size) throw new Error(`${s.allocations}: ${roles.size} DIDs, the payout map has ${payouts.size}`);
    return { id: s.id, title: s.title, prize: s.prize, receipt: s.receipt, payouts, roles, labels: s.labels };
  });
}

let cache: { paid: Paid[]; rows: RankedDid[] } | undefined;

/** Close Call, once the referee has posted its final standings: FLOP Labs announced on 6 Oct 2026 that its
 * three prize places share the contest's prize, paid after mainnet, without saying how. Ben chose to count it
 * now as an equal split (2026-10-09), shown as an assumption everywhere it appears. */
function closeCall(): Paid | undefined {
  const c = contest("close-1");
  const a = assumedFromStandings(c?.standings, c?.prize);
  if (!a) return undefined;
  return { id: "close-1", title: "Close Call", prize: "Top 3", receipt: "the referee's final standings and FLOP Labs' post of 6 Oct 2026",
    payouts: a.payouts, roles: a.roles, labels: a.labels, assumed: { pool: a.pool, note: a.note } };
}

/** Paid contests and every DID they paid, best first; equal totals share a rank (1, 1, 1, 1, 5...). */
export function rankings(): { paid: Paid[]; pending: Pending[]; rows: RankedDid[] } {
  if (!cache) {
    const cc = closeCall();
    const paid = [...load(), ...(cc ? [cc] : [])];
    const rows = rankRows(paid) as RankedDid[];
    cache = { paid, rows };
  }
  const pending: Pending[] = cache.paid.some((p) => p.id === "close-1") ? []
    : [{ id: "close-1", title: "Close Call", prize: "1,000,000 FLOP", note: "for the top 3, paid after 4 October" }];
  return { ...cache, pending };
}

/** The first place: every DID at rank 1 and, when they are one team of one contest (Sonnet's winning
 * poem), that team and its prize. */
export function champions(): { rows: RankedDid[]; team?: { name: string; prize: string; flop: number; assumed?: boolean } } {
  const { paid, rows } = rankings();
  const first = rows.filter((r) => r.rank === 1);
  const ids = new Set(first.flatMap((r) => Object.keys(r.by)));
  const c = ids.size === 1 ? paid.find((p) => ids.has(p.id)) : undefined;
  const entries = new Set(first.map((r) => c?.roles.get(r.did)?.entry));
  if (!c || first.length < 2 || entries.size !== 1) return { rows: first };
  return { rows: first, team: { name: [...entries][0]!, prize: c.prize, flop: c.assumed?.pool ?? first.reduce((t, r) => t + r.flop, 0), assumed: !!c.assumed } };
}

