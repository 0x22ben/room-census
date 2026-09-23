// Watched rooms and last visits, kept only in this browser (localStorage). Nothing is ever sent.
// Stored values are untrusted: anything malformed is ignored, and storage errors (private mode,
// blocked storage) leave the page working without memory.
const WATCHED = "roomcensus.watched";
const SEEN = "roomcensus.seen";
const SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const MAX = 200;

function read(key: string): unknown {
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function watched(): string[] {
  const v = read(WATCHED);
  return Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === "string" && SLUG.test(s)))].slice(0, MAX) : [];
}

export function isWatched(slug: string): boolean {
  return watched().includes(slug);
}

/** Adds or removes a room; returns whether it is now watched (false when storage is unavailable). */
export function toggle(slug: string): boolean {
  const list = watched();
  const next = list.includes(slug) ? list.filter((s) => s !== slug) : [...list, slug].slice(-MAX);
  return write(WATCHED, next) && next.includes(slug);
}

function seenMap(): Record<string, number> {
  const v = read(SEEN);
  const out: Record<string, number> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, n] of Object.entries(v)) if (SLUG.test(k) && Number.isInteger(n) && (n as number) > 0) out[k] = n as number;
  }
  return out;
}

/** Census number the reader last saw this room at, or null. */
export function lastSeen(slug: string): number | null {
  return seenMap()[slug] ?? null;
}

export function markSeen(slug: string, census: number): void {
  const m = seenMap();
  m[slug] = census;
  write(SEEN, m);
}
