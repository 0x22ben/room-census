// The time of the newest public data in a build, shown at the bottom of the sidebar (Pencil c0bwx).
// Pure functions: no file access, so they are tested on their own.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n) => String(n).padStart(2, "0");

/** The latest of the given ISO times; null ones (a source the build does not have) are skipped. */
export function newest(...isos) {
  let best = null;
  for (const iso of isos) {
    if (iso === null || iso === undefined) continue;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) throw new Error(`invalid date: ${iso}`);
    if (best === null || t > best.t) best = { iso, t };
  }
  return best === null ? null : new Date(best.t).toISOString();
}

/** "28 Sep, 14:34 UTC": the sidebar has room for no more. */
export function dayTimeUtc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${iso}`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}
