// The referee's signed final standings of a contest (its "standings" post, marked at the closing price), ready to
// show: the prize places first, then the next ones. Nothing is computed from our own recount: every score is the
// referee's, written with six decimals, shown to the cent.

export const SCORE = /^-?\d{1,9}\.\d{6}$/;

/** "1576.916300" -> "1576.92". Exact decimal arithmetic on the six digits, half to even like the rest of the site. */
export function toCents(score) {
  const m = /^(-?)(\d+)\.(\d{6})$/.exec(score);
  if (!m) throw new Error(`not a six-decimal score: ${score}`);
  const micro = BigInt(m[2]) * 1_000_000n + BigInt(m[3]);
  let c = micro / 10_000n;
  const r = micro % 10_000n;
  if (r > 5_000n || (r === 5_000n && c % 2n === 1n)) c += 1n;
  const body = `${c / 100n}.${String(c % 100n).padStart(2, "0")}`;
  return m[1] === "-" && c !== 0n ? `-${body}` : body;
}

/** The places to show: winners (the prize places, ties share them), the next places, the first score. */
export function standingsView(st) {
  const line = (p) => ({ rank: p.rank, did: p.did, score: toCents(p.score) });
  return {
    price: st.price,
    postedAt: st.posted_at,
    owners: st.owners,
    winners: st.places.map((p) => ({ ...line(p), sharing: p.sharing })),
    next: st.next.map(line),
    first: toCents(st.places[0].score),
  };
}
