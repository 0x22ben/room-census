// The contest's accounting (close_call_fold.py), in floating point for display: first in, first out,
// every fee taken from cash, a short valued at its collateral plus or minus the move. The published
// score of a key stays the recount's own; this only draws curves between updates.
export const MINT = 10_000;

export class Account {
  cash = MINT;
  fees = 0;
  lots = [];
  /** Applies a trade (side +1 buy, -1 sell) and returns what it realized, fees included. */
  apply(side, qty, px, fee) {
    this.cash -= fee;
    this.fees += fee;
    let left = qty;
    let realized = -fee;
    while (left > 0 && this.lots.length && this.lots[0][0] * side < 0) {
      const [lq, lp] = this.lots[0];
      const size = Math.min(left, Math.abs(lq));
      this.cash += side < 0 ? size * px : size * (2 * lp - px);
      realized += side < 0 ? size * (px - lp) : size * (lp - px);
      left -= size;
      if (size === Math.abs(lq)) this.lots.shift();
      else this.lots[0][0] = lq + side * size;
    }
    if (left > 0) {
      this.cash -= left * px;
      this.lots.push([side * left, px]);
    }
    return realized;
  }
  /** A published trade [sweep, "b" | "s" | "x", qty, price, fee]; "x" (a trade with itself) only costs its fee. */
  applyTrade(t) {
    if (t[1] === "x") {
      this.cash -= Number(t[4]);
      this.fees += Number(t[4]);
      return 0;
    }
    return this.apply(t[1] === "b" ? 1 : -1, Number(t[2]), Number(t[3]), Number(t[4]));
  }
  value(mark) {
    return this.cash + this.lots.reduce((v, [q, p]) => v + (q > 0 ? q * mark : -q * (2 * p - mark)), 0);
  }
}

/** Whether an account replayed from a key's published trades lands on its ranking line: the same open
 * position ([quantity, average entry], or null when flat). When it does not, a trade is missing from the
 * published history and nothing computed from it may be shown (Ben, 2026-09-29: never a wrong figure). */
export function matchesLine(acct, line) {
  const held = acct.lots.reduce((v, [x]) => v + x, 0);
  if (line === undefined) return false;                                // no position published: nothing to check against
  if (line === null) return Math.abs(held) < 0.005;
  const size = acct.lots.reduce((v, [x]) => v + Math.abs(x), 0);
  const entry = size ? acct.lots.reduce((v, [x, p]) => v + Math.abs(x) * p, 0) / size : 0;
  return Math.abs(held - Number(line[0])) < 0.005 && Math.abs(entry - Number(line[1])) < 0.01;
}

/** Whether a key's published trades add up to its ranking line at the ranking's sweep: every trade settled
 * by then, the same open position, and the same score at that sweep's mark (within 0.02 POLF). A position
 * check alone misses a sale and a buyback both left out. Only then may a page show numbers replayed from
 * those trades: cash, fees, a score curve, best trades (Ben, 2026-09-29: never a wrong figure). */
export function verifiedTrades(trades, marks, sweep, pnl, line) {
  if (!trades?.length || trades[trades.length - 1][0] > sweep) return false;
  const mark = marks.find((m) => m[0] === sweep);
  if (!mark) return false;
  const acct = new Account();
  for (const t of trades) acct.applyTrade(t);
  return matchesLine(acct, line) && Math.abs(acct.value(Number(mark[1])) - MINT - Number(pnl)) <= 0.02;
}

/** Score after each mark ([sweep, price]), the trades of a sweep settling before its mark. */
export function scoreCurve(trades, marks) {
  const acct = new Account();
  const out = [];
  let i = 0;
  for (const [sweep, mark] of marks) {
    for (; i < trades.length && trades[i][0] <= sweep; i++) acct.applyTrade(trades[i]);
    out.push(acct.value(mark) - MINT);
  }
  return out;
}
