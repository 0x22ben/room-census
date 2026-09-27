// The DIDs a visitor saved, kept only in this browser (localStorage). Nothing is ever sent. A saved DID
// is one the visitor follows: saving it proves nothing about who owns it. Stored values are untrusted:
// anything malformed is ignored, and storage errors leave the page working without memory.
const SAVED = "roomcensus.saved";
const ACTIVE = "roomcensus.saved.active";
const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const NICK = /^[\p{L}\p{N} ._-]{1,20}$/u;
export const MAX = 20;

export type Saved = { did: string; nick: string };

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
    window.dispatchEvent(new CustomEvent("roomcensus:saved"));
    return true;
  } catch {
    return false;
  }
}

export const isDid = (s: string): boolean => DID.test(s);

export function saved(): Saved[] {
  const v = read(SAVED);
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: Saved[] = [];
  for (const x of v) {
    if (x && typeof x === "object" && typeof x.did === "string" && DID.test(x.did) && !seen.has(x.did)) {
      seen.add(x.did);
      out.push({ did: x.did, nick: typeof x.nick === "string" && NICK.test(x.nick) ? x.nick : `DID ${out.length + 1}` });
    }
  }
  return out.slice(0, MAX);
}

export const isSaved = (did: string): boolean => saved().some((s) => s.did === did);

/** The DID the top bar shows: the chosen one if still saved, else the first. */
export function active(): Saved | undefined {
  const list = saved();
  const a = read(ACTIVE);
  return list.find((s) => s.did === a) ?? list[0];
}

export function setActive(did: string): void {
  write(ACTIVE, did);
}

/** Saves a DID (first free nickname "main", then "DID 2"...); returns false when it could not. */
export function save(did: string, nick?: string): boolean {
  const list = saved();
  if (!DID.test(did) || list.some((s) => s.did === did) || list.length >= MAX) return false;
  const name = nick && NICK.test(nick) ? nick : list.length === 0 ? "main" : `DID ${list.length + 1}`;
  return write(SAVED, [...list, { did, nick: name }]);
}

export function remove(did: string): void {
  write(SAVED, saved().filter((s) => s.did !== did));
}

export function rename(did: string, nick: string): boolean {
  if (!NICK.test(nick)) return false;
  return write(SAVED, saved().map((s) => (s.did === did ? { did, nick } : s)));
}

export function forgetAll(): void {
  try {
    window.localStorage.removeItem(SAVED);
    window.localStorage.removeItem(ACTIVE);
    window.dispatchEvent(new CustomEvent("roomcensus:saved"));
  } catch {
    /* nothing to forget */
  }
}
