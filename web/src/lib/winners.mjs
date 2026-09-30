// The "Winners" of a paid contest (Sonnet: the writers of the winning poem and the voters who chose it),
// from FLOP Labs' payout map and allocation list as src/lib/rankings.ts loads and checks them. Nothing is
// added: every number is a sum or a count of those lines. The same answers serve "Was my DID paid?".

const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const n = (v) => v.toLocaleString("en-US");

/** payouts: Map did -> FLOP; roles: Map did -> { role, entry }. Returns the totals, the winning entry,
 * its authors (role "contributor", in the allocation list's order) and the voters' count, lowest,
 * highest and total amounts. */
export function winnersOf(payouts, roles) {
  let total = 0;
  const authors = [];
  const voters = { count: 0, min: Infinity, max: 0, total: 0 };
  const entries = new Set();
  for (const [did, flop] of payouts) {
    total += flop;
    const r = roles.get(did);
    if (r?.role === "contributor") { authors.push({ did, flop }); entries.add(r.entry); }
    else if (r?.role === "voter") {
      voters.count++;
      voters.total += flop;
      voters.min = Math.min(voters.min, flop);
      voters.max = Math.max(voters.max, flop);
    }
  }
  if (!voters.count) voters.min = 0;
  return { total, dids: payouts.size, entry: [...entries].join(", "), authors, authorsFlop: authors.reduce((t, a) => t + a.flop, 0), voters };
}

/** "7 FLOP each", or "5 to 9 FLOP each" when the voters were not all paid the same. */
export function eachLabel(v) {
  return v.min === v.max ? `${n(v.min)} FLOP each` : `${n(v.min)} to ${n(v.max)} FLOP each`;
}

/** The answer to "Was my DID paid?" for what the visitor typed. flop and role: that DID's line, if any. */
export function paidAnswer(input, flop, role) {
  const did = input.trim();
  if (!DID.test(did)) return { tone: "warning", text: "Not a did:key: it starts with did:key:z6Mk and has 56 characters." };
  if (!flop) return { tone: "muted", text: "Not in the payout list." };
  return { tone: "accent", text: `Paid ${n(flop)} FLOP, as ${role === "contributor" ? "an author" : "a voter"}.` };
}
