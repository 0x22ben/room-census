// The Rankings list as pure functions, so that every rule is tested without a build: a contest whose FLOP is
// announced but not split yet (Close Call) counted as an equal split, and the shared ranks of every DID.

/** "1st", "2nd", "3rd", "4th"... */
export function ordinal(n) {
  const t = n % 100;
  const s = t >= 11 && t <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${s}`;
}

/** A pool split equally between some keys, in whole FLOP (any remainder is left out, never invented). */
export function equalSplit(pool, dids) {
  if (!Number.isInteger(pool) || pool <= 0 || dids.length === 0) return new Map();
  const each = Math.floor(pool / dids.length);
  return new Map(dids.map((d) => [d, each]));
}

const PRIZE = /^(\d{1,3}(?:,\d{3})*) FLOP$/;

/** The prize places of a contest's final standings counted as an equal split of its prize ("1,000,000 FLOP"):
 * payouts, a role per place that orders the keys the split leaves tied, its labels, the pool and the note
 * that says it is an assumption. Undefined without standings or with a prize that is not a plain amount. */
export function assumedFromStandings(standings, prize) {
  const m = PRIZE.exec(prize ?? "");
  if (!standings || !m || !standings.places?.length) return undefined;
  const pool = Number(m[1].replaceAll(",", ""));
  const places = standings.places;
  const payouts = equalSplit(pool, places.map((p) => p.did));
  const roles = new Map(places.map((p) => [p.did, { role: `place${p.rank}`, entry: "Close Call" }]));
  const labels = Object.fromEntries(places.map((p) => [`place${p.rank}`, `${ordinal(p.rank)} place, equal split assumed`]));
  const who = places.length === 3 ? "the top 3" : `its ${places.length} prize places`;
  const note = `${pool.toLocaleString("en-US")} FLOP for ${who}, paid after mainnet. FLOP Labs has not published the split: counted here as an equal split.`;
  return { payouts, roles, labels, pool, note };
}

/** Every DID of the contests, best total first; equal totals share a rank (1, 1, 1, 4...) and are ordered by
 * their place in a contest whose amounts are assumed, then by DID. paid: [{ id, payouts: Map, roles: Map, assumed? }]. */
export function rankRows(paid) {
  const total = new Map();
  for (const c of paid) {
    for (const [did, flop] of c.payouts) {
      const r = total.get(did) ?? { rank: 0, did, flop: 0, by: {}, roles: {} };
      r.flop += flop;
      r.by[c.id] = flop;
      r.roles[c.id] = c.roles.get(did).role;
      total.set(did, r);
    }
  }
  const place = (r) => Math.min(...paid.filter((c) => c.assumed && r.roles[c.id]).map((c) => Number(r.roles[c.id].replace("place", ""))), Infinity);
  const rows = [...total.values()].sort((a, b) => b.flop - a.flop || place(a) - place(b) || (a.did < b.did ? -1 : 1));
  rows.forEach((r, i) => { r.rank = i > 0 && rows[i - 1].flop === r.flop ? rows[i - 1].rank : i + 1; });
  return rows;
}
