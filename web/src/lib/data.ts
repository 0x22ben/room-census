// Build-time access to the public data. Pages read the staged copy (web/.public), which is the exact,
// already checked set of bytes the site publishes. No network, no fallback: a missing file stops the build.
// Field-level validation of every document arrives with the data loader (A2).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const STAGED = resolve(process.cwd(), ".public");

function readJson(rel: string): any {
  try {
    return JSON.parse(readFileSync(resolve(STAGED, rel), "utf8"));
  } catch (e) {
    throw new Error(`public data unavailable: ${rel} (run the staging step first): ${(e as Error).message}`);
  }
}

export type Latest = {
  census: number;
  at_utc: string;
  next: string;
  summary: { active: number; varied: number; mixed: number; repetitive: number };
};

export function latest(): Latest {
  const doc = readJson("data/latest.json");
  if (doc?.schema !== "room-census/1") throw new Error("data/latest.json is not a room-census/1 document");
  return doc;
}

export function roomCount(): number {
  const doc = readJson("data/rooms/index.json");
  if (doc?.schema !== "room-census-rooms/1" || !Array.isArray(doc.rooms)) {
    throw new Error("data/rooms/index.json is not a room-census-rooms/1 document");
  }
  return doc.rooms.length;
}
