// The phases of a contest, from its own times. Plain JavaScript with no dependency, so the pages, the
// staging check and the tests share one definition.
//
// A trading contest has two closing times: trading locks first (`trading_lock_at`), then the final price
// is taken (`final_price_at`). Close Call locks at 09:00 UTC and prices at 10:00 UTC on 4 Oct 2026.
// A contest without a separate final price (Sonnet) ends at its lock.

/** @typedef {{ opening: string, trading_lock_at: string, final_price_at?: string | null }} Times */

/** "upcoming" before the opening, "live" while trading is open, "closed" between the lock and the final
 * price, "ended" once the final price is taken. `now` is an ISO time. */
export function phase(c, now) {
  const t = Date.parse(now);
  const lock = Date.parse(c.trading_lock_at);
  const final = Date.parse(c.final_price_at ?? c.trading_lock_at);
  if (t < Date.parse(c.opening)) return "upcoming";
  if (t < lock) return "live";
  if (t < final) return "closed";
  return "ended";
}

/** Plain words for each phase. */
export const PHASE_LABEL = {
  upcoming: "Not started",
  live: "Live",
  closed: "Trading closed · awaiting final price",
  ended: "Ended",
};

/** "8 days 20 h", "2 h 5 min", "12 min": the time from `now` to `target`, never negative. */
export function until(target, now) {
  const ms = Math.max(0, Date.parse(target) - Date.parse(now));
  const h = Math.floor(ms / 3_600_000);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d} days ${h % 24} h`;
  if (h > 0) return `${h} h ${Math.floor((ms % 3_600_000) / 60_000)} min`;
  return `${Math.floor(ms / 60_000)} min`;
}

/** "92 min", "3 h 12 min": how long after the opening our capture began. */
export function after(start, opening) {
  return until(start, opening);
}
