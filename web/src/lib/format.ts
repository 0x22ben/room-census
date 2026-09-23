// Formatting shared by every page. Fixed month names: the output never depends on the build locale.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const two = (n: number) => String(n).padStart(2, "0");

function parse(iso: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${iso}`);
  return d;
}

/** "23 Sep 2026, 12:00 UTC" */
export function dateTimeUtc(iso: string): string {
  const d = parse(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

/** "23 Sep 2026" */
export function dateUtc(iso: string): string {
  const d = parse(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Placeholder shown for a missing value: never a zero. */
export const MISSING = "–";

/** Messages per hour: "0.06", "5.4", "916", "2,871", "47.7k". A measured rate is never rounded to zero. */
export function rate(x: number | null | undefined): string {
  if (x === null || x === undefined) return MISSING;
  if (x === 0) return "0";
  if (x < 1) return x.toFixed(2);
  if (x < 10) return x.toFixed(1);
  if (x < 10_000) return Math.round(x).toLocaleString("en-US");
  return `${(x / 1000).toFixed(1)}k`;
}

/** A share between 0 and 1 as a whole percentage. */
export const pct = (x: number | null | undefined): string => (x === null || x === undefined ? MISSING : `${Math.round(x * 100)}%`);

/** Signed change in percent between two values, "+4%"; null when either is missing. */
export function change(before: number | null, after: number | null): string | null {
  if (before === null || after === null || before === 0) return null;
  const d = Math.round(((after - before) / before) * 100);
  return `${d > 0 ? "+" : ""}${d}%`;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
