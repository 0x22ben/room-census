// Reading a public Technocore room from the reader's own browser.
//
// Room Census publishes counts, never messages: nothing read here is stored, sent anywhere or built
// into the site. The page asks Technocore directly, the same way anyone can with one GET, and shows
// what comes back. Technocore holds the request open for a few seconds when nothing new has arrived,
// so following a room costs one request every ten seconds instead of a constant poll.
import { readReply, TECHNOCORE } from "./did-core.mjs";

export const FIRST = 50;
export const WAIT = 10;
const MAX_TEXT = 4096;

/** One message, reduced to what the page shows. Everything is a string, and nothing is trusted. */
function entry(m) {
  const seq = Number(m.seq);
  if (!Number.isInteger(seq) || seq < 0) return null;
  const text = [...String(m.text ?? "")].slice(0, MAX_TEXT).join("");
  return {
    seq,
    from: String(m.from ?? "").slice(0, 120),
    nick: typeof m.nick === "string" ? m.nick.slice(0, 60) : "",
    ts: String(m.ts ?? "").slice(0, 40),
    nonce: String(m.nonce ?? "").slice(0, 40),
    text,
    // the signature as it was given: a page decides nothing from it until it has checked it
    sig: typeof m.sig === "string" ? m.sig.slice(0, 200) : "",
  };
}

/**
 * Reads a room. Without `since` it asks for the last messages; with one it asks Technocore to hold
 * the request until something newer arrives. Returns {messages, last} or throws.
 */
export async function readRoom(room, { since = null, wait = 0, limit = FIRST, fetcher = fetch, signal } = {}) {
  const query = since === null
    ? `format=json&limit=${limit}`
    : `format=json&since=${encodeURIComponent(String(since))}${wait ? `&wait=${wait}` : ""}`;
  const res = await fetcher(`${TECHNOCORE}/r/${encodeURIComponent(room)}?${query}`, {
    credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error", signal,
  });
  if (!res.ok) throw new Error(`room reply ${res.status}`);
  const messages = readReply(await res.text()).map(entry).filter(Boolean);
  const last = messages.reduce((n, m) => Math.max(n, m.seq), since === null ? 0 : Number(since));
  return { messages, last };
}

/** The short form of a sender, for a line that has to stay narrow. Never a name we invent. */
export function shortFrom(from, nick) {
  if (from.startsWith("did:key:")) return `${from.slice(8, 13)}…${from.slice(-4)}`;
  if (nick) return nick;
  if (!from) return "anonymous";
  return from.slice(0, 18);
}

/** The time of a message, as the reader's clock shows it, or an empty string. */
export function shortTime(ts) {
  const at = new Date(ts);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
