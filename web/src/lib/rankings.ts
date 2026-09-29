// Rankings (beta, unofficial): every DID by the FLOP that FLOP Labs awarded it, contest after contest,
// read from the payout maps FLOP Labs published (src/data/flop-labs). Room Census adds nothing of its
// own: no points, no formula. A file whose SHA-256 is not the one the referee signed stops the build.
// Each contest's allocation list (same source) says why a DID was paid: for Sonnet, wrote the winning
// poem or voted for it. It must name exactly the DIDs and amounts of the payout map.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Paid = { id: string; title: string; prize: string; payouts: Map<string, number>; roles: Map<string, { role: string; entry: string }>; labels: Record<string, string> };
export type Pending = { id: string; title: string; prize: string; note: string };
/** One line: shared rank (ties share it), DID, total FLOP, FLOP and role per paid contest. */
export type RankedDid = { rank: number; did: string; flop: number; by: Record<string, number>; roles: Record<string, string> };

const SOURCES = [
  { id: "sonnet-2", title: "Sonnet", prize: "Winning poem", file: "sonnet-2.payouts.json", sha256: "ebc0de591eb7108180a70cb28b5b7cf08ac0a4447fdf8e0ebfc389e47dffeff1",
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
    return { id: s.id, title: s.title, prize: s.prize, payouts, roles, labels: s.labels };
  });
}

let cache: { paid: Paid[]; rows: RankedDid[] } | undefined;

/** Paid contests and every DID they paid, best first; equal totals share a rank (1, 1, 1, 1, 5...). */
export function rankings(): { paid: Paid[]; pending: Pending[]; rows: RankedDid[] } {
  if (!cache) {
    const paid = load();
    const total = new Map<string, RankedDid>();
    for (const c of paid) {
      for (const [did, flop] of c.payouts) {
        const r = total.get(did) ?? { rank: 0, did, flop: 0, by: {}, roles: {} };
        r.flop += flop;
        r.by[c.id] = flop;
        r.roles[c.id] = c.roles.get(did)!.role;
        total.set(did, r);
      }
    }
    const rows = [...total.values()].sort((a, b) => b.flop - a.flop || (a.did < b.did ? -1 : 1));
    rows.forEach((r, i) => { r.rank = i > 0 && rows[i - 1].flop === r.flop ? rows[i - 1].rank : i + 1; });
    cache = { paid, rows };
  }
  return { ...cache, pending: [{ id: "close-1", title: "Close Call", prize: "1,000,000 FLOP", note: "for the top 3, paid after 4 October" }] };
}

