// The My DID lookup, without the page: parse a did:key, read Technocore room replies, check each
// Ed25519 signature and summarize what was found and what was inspected. Plain JavaScript so the
// Node tests run it as is. Nothing here stores or sends anything; the caller does the fetching.

export const TECHNOCORE = "https://technocore.chat";
// newest messages per room that one read returns (the server clamps `limit` to 1..200)
export const WINDOW = 200;

const ROOM = /^[a-z0-9][a-z0-9_-]{0,47}$/;
// server time of a message; it is not covered by the signature, so it is only trusted to be well formed
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
export const validTs = (ts) => typeof ts === "string" && TS.test(ts) && !Number.isNaN(Date.parse(ts.replace(/(\.\d{3})\d+/, "$1")));
const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{40,50}$/;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(text) {
  let bytes = [0];
  for (const ch of text) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of text) { if (ch !== "1") break; bytes.push(0); }
  return Uint8Array.from(bytes.reverse());
}

/** The 32-byte Ed25519 public key of a did:key, or null when the text is not one. */
export function publicKey(did) {
  if (typeof did !== "string" || !DID.test(did)) return null;
  const raw = base58(did.slice("did:key:z".length));
  // multicodec ed25519-pub (0xed 0x01) followed by the key
  if (!raw || raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 0x01) return null;
  return raw.slice(2);
}

function base64url(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(text)) return null;
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "==");
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Messages of one `GET /r/<room>?format=json` reply. Nonces go past 2^53, so they are kept as the
 * exact digits of the reply (a JSON number would round them and good signatures would fail).
 */
export function readReply(body) {
  const exact = body.replace(/"nonce"(\s*):(\s*)(\d+)/g, '"nonce"$1:$2"$3"');
  const reply = JSON.parse(exact);
  if (!reply || !Array.isArray(reply.messages)) throw new Error("not a room reply");
  return reply.messages.filter((m) => m && typeof m === "object");
}

/** The bytes a Technocore signature covers: `<room>|<nonce>|<text>` as UTF-8. */
export const signedBytes = (room, nonce, text) => new TextEncoder().encode(`${room}|${nonce}|${text}`);

/**
 * Checks one message against the DID. Returns "checked" (valid signature), "bad" (names the DID but
 * the signature does not verify), "unsupported" (this browser cannot check Ed25519) or null when
 * the message is not from this DID.
 */
export async function check(subtle, key, did, room, m) {
  if (m.from !== did) return null;
  const sig = base64url(m.sig);
  if (!sig || typeof m.text !== "string" || typeof m.nonce !== "string" || !/^\d{1,19}$/.test(m.nonce)) return "bad";
  if (!key) return "unsupported";
  try {
    return (await subtle.verify({ name: "Ed25519" }, key, sig, signedBytes(room, m.nonce, m.text))) ? "checked" : "bad";
  } catch {
    return "bad";
  }
}

/** Imports the DID's key for verification, or null when the browser has no Ed25519. */
export async function importKey(subtle, raw) {
  try {
    return await subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return null;
  }
}

/** One room's part of the coverage: what was read, whatever was found in it. */
export function roomCoverage(room, messages) {
  const seqs = messages.map((m) => m.seq).filter(Number.isInteger);
  const times = messages.map((m) => m.ts).filter(validTs).sort();
  return {
    room,
    status: "read",
    messages_read: messages.length,
    first_seq: seqs.length ? Math.min(...seqs) : null,
    last_seq: seqs.length ? Math.max(...seqs) : null,
    first_ts: times[0] ?? null,
    last_ts: times[times.length - 1] ?? null,
  };
}

/** The read room whose messages spanned the least time: how far back the lookup reached at worst. */
export function shortestWindow(coverage) {
  let best = null;
  for (const c of coverage) {
    if (c.status !== "read" || !c.first_ts || !c.last_ts) continue;
    const ms = Date.parse(c.last_ts.replace(/(\.\d{3})\d+/, "$1")) - Date.parse(c.first_ts.replace(/(\.\d{3})\d+/, "$1"));
    if (best === null || ms < best.ms) best = { room: c.room, ms };
  }
  return best;
}

/** "12 seconds", "3 minutes", "5 hours", "2 days" */
export function span(ms) {
  const units = [["day", 86400000], ["hour", 3600000], ["minute", 60000], ["second", 1000]];
  for (const [name, size] of units) {
    const n = Math.floor(ms / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? "" : "s"}`;
  }
  return "under a second";
}

export const validRoom = (room) => typeof room === "string" && ROOM.test(room);

/** Totals of a lookup: only messages with a checked signature count as activity. */
export function summarize(found) {
  const ok = found.filter((f) => f.result === "checked");
  const times = ok.map((f) => f.message.ts).filter(validTs).sort();
  const days = new Set(times.map((t) => t.slice(0, 10)));
  const rooms = new Set(ok.map((f) => f.room));
  const last = times.pop() ?? null;
  return {
    signed_messages: ok.length,
    rooms_with_activity: rooms.size,
    active_days: days.size,
    last_active: last,
    not_verifiable: found.filter((f) => f.result === "bad").length,
    unchecked: found.filter((f) => f.result === "unsupported").length,
  };
}
