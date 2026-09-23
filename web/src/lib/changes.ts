// "Since your last visit", in plain words, from a room's history. Shared by the room page and the
// watched rooms page so both say the same thing.
import { change, rate } from "./format";
import { PATTERN, type Pattern } from "./patterns";

export type Point = { c: number; r: number | null; p: Pattern | null; e: number | null };

export function sinceVisit(history: Point[], seen: number | null, current: number): string[] {
  if (seen === null) return ["First visit on this device. Next time, this shows what changed here."];
  if (seen >= current) return ["No new census since your last visit."];
  const before = history.find((h) => h.c === seen);
  const now = history.find((h) => h.c === current);
  if (!before || !now) return [`Last visit: census #${seen}. The room was not measured in both censuses.`];
  const lines = [`Last visit: census #${seen}.`];
  const d = change(before.r, now.r);
  lines.push(before.r !== null && now.r !== null ? `Messages per hour: ${rate(before.r)} to ${rate(now.r)}${d ? ` (${d})` : ""}` : "Messages per hour: not measured in both censuses");
  if (before.p && now.p) {
    lines.push(before.p === now.p ? `Message pattern: unchanged, ${PATTERN[now.p].short}` : `Message pattern: ${PATTERN[before.p].short} to ${PATTERN[now.p].short}`);
  }
  if (before.e !== null && now.e !== null) {
    const a = Math.round(before.e);
    const b = Math.round(now.e);
    lines.push(a === b ? `Senders carrying the activity: about ${b}, unchanged` : `Senders carrying the activity: about ${a} to about ${b}`);
  }
  return lines;
}
