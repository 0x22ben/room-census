// Rankings (beta, unofficial): every DID by the FLOP that FLOP Labs awarded it, contest after contest,
// read from the payout maps FLOP Labs published (src/data/flop-labs). Room Census adds nothing of its
// own: no points, no formula. A file whose SHA-256 is not the one the referee signed stops the build.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Paid = { id: string; title: string; payouts: Map<string, number> };
export type Pending = { id: string; title: string; prize: string; note: string };
/** One line: shared rank (ties share it), DID, total FLOP, FLOP per paid contest. */
export type RankedDid = { rank: number; did: string; flop: number; by: Record<string, number> };

const SOURCES = [
  { id: "sonnet-2", title: "Sonnet", file: "sonnet-2.payouts.json", sha256: "ebc0de591eb7108180a70cb28b5b7cf08ac0a4447fdf8e0ebfc389e47dffeff1" },
];
const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;

function load(): Paid[] {
  return SOURCES.map((s) => {
    const bytes = readFileSync(resolve(process.cwd(), "src", "data", "flop-labs", s.file));
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== s.sha256) throw new Error(`${s.file}: SHA-256 ${sha} is not the one the referee signed (${s.sha256})`);
    const map = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const payouts = new Map<string, number>();
    for (const [did, flop] of Object.entries(map)) {
      if (!DID.test(did) || !Number.isInteger(flop) || (flop as number) <= 0) throw new Error(`${s.file}: bad line for ${did}`);
      payouts.set(did, flop as number);
    }
    return { id: s.id, title: s.title, payouts };
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
        const r = total.get(did) ?? { rank: 0, did, flop: 0, by: {} };
        r.flop += flop;
        r.by[c.id] = flop;
        total.set(did, r);
      }
    }
    const rows = [...total.values()].sort((a, b) => b.flop - a.flop || (a.did < b.did ? -1 : 1));
    rows.forEach((r, i) => { r.rank = i > 0 && rows[i - 1].flop === r.flop ? rows[i - 1].rank : i + 1; });
    cache = { paid, rows };
  }
  return { ...cache, pending: [{ id: "close-1", title: "Close Call", prize: "1,000,000 FLOP", note: "for the top 3, paid after 4 October" }] };
}

/** "1st", "2nd", "3rd", "4th"... */
export function ordinal(n: number): string {
  const t = n % 100;
  const s = t >= 11 && t <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${s}`;
}
