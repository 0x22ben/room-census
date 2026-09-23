// Build-time access to the public data. Pages read the staged copy (web/.public), which is the exact,
// already checked set of bytes the site publishes, through the data contract of schema.mjs. No
// network, no fallback: a missing, malformed or inconsistent file stops the build.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadSite } from "./schema.mjs";

const STAGED = resolve(process.cwd(), ".public");

function readJson(rel: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(STAGED, rel), "utf8"));
  } catch (e) {
    throw new Error(`public data unavailable: ${rel} (run the staging step first): ${(e as Error).message}`);
  }
}

export type Site = ReturnType<typeof loadSite>;
export type Latest = Site["latest"];

let cached: Site | undefined;

/** Every public document, validated once per build. */
export function site(): Site {
  cached ??= loadSite(readJson);
  return cached;
}

export const latest = (): Latest => site().latest;
export const roomCount = (): number => site().rooms.size;

/** What the site can honestly say about the latest census. The staging step has already checked
 * that the snapshot and the manifest match their fingerprints; the signature itself lives in the
 * Technocore room and is not checked at build time, so the label never claims more than that. */
export function censusStatus(l: Latest): { complete: boolean; label: string; help: string } {
  const complete = !l.partial && l.signed_in !== null && l.provenance !== null;
  return complete
    ? { complete, label: `Census #${l.census} signed`,
        help: "Room Census signed this census in the room-census room of Technocore. Before publishing this page we checked that its snapshot and its code manifest match their fingerprints." }
    : { complete, label: `Census #${l.census} incomplete`,
        help: "This census is partial or misses its signature or code manifest reference. Treat its numbers with care." };
}
