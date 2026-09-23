// Build-time facts about the published files: sizes and counts read from the staged copy (web/.public),
// the exact bytes the site serves. No network.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const STAGED = resolve(process.cwd(), ".public");

/** Size in bytes of one published file. */
export const bytes = (rel: string): number => statSync(resolve(STAGED, rel)).size;

/** Number and total size of the published files of one folder. */
export function folder(rel: string, keep: (name: string) => boolean = () => true): { count: number; bytes: number } {
  const names = readdirSync(resolve(STAGED, rel)).filter(keep);
  return { count: names.length, bytes: names.reduce((sum, n) => sum + bytes(`${rel}/${n}`), 0) };
}

/** "28 KB", "1.4 MB": binary units, rounded. */
export function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Column names of the history file, from its first line. */
export const csvColumns = (rel: string): string[] => readFileSync(resolve(STAGED, rel), "utf8").split(/\r?\n/, 1)[0].split(",");

/** One published JSON document, as served. */
export const json = <T = unknown>(rel: string): T => JSON.parse(readFileSync(resolve(STAGED, rel), "utf8")) as T;
