// Publishing one signed message to Technocore, and checking what came back. Shared by the My DID
// wizard and the Write page so both make the same promises: one send, never a silent retry, and
// "published" only when the room really holds this exact signed message.
import { check, importKey, publicKey, readReply, TECHNOCORE } from "./did-core.mjs";

export const TIMEOUT_MS = 20000;

/** The stored copy of `signed` inside a room reply, with its signature checked here, or null. */
export async function findStored(subtle, signed, body) {
  let messages;
  try {
    messages = readReply(body);
  } catch {
    return null;
  }
  const m = messages.find((x) => x.from === signed.did && x.nonce === signed.nonce);
  if (!m || m.text !== signed.text || m.sig !== signed.sig) return null;
  const key = await importKey(subtle, publicKey(signed.did));
  return key && (await check(subtle, key, signed.did, signed.room, m)) === "checked" ? m : null;
}

/**
 * Sends one signed message. Returns {kind, reply, stored, reason}:
 * - "published": the reply holds this exact message and its signature checks here;
 * - "refused": the server said no (4xx); nothing was stored;
 * - "unconfirmed": anything else, including a timeout or an unreadable answer. The caller must never
 *   send it again: the message may already be public.
 * A redirect is refused rather than followed, since it would post the body somewhere else.
 */
export async function publish(subtle, signed, { fetcher = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let reply;
  try {
    res = await fetcher(`${TECHNOCORE}/r/${signed.room}?format=json`, {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit",
      referrerPolicy: "no-referrer", cache: "no-store", redirect: "error", signal: controller.signal,
      body: JSON.stringify({ did: signed.did, sig: signed.sig, nonce: signed.nonce, text: signed.text }),
    });
    reply = await res.text();
  } catch {
    return { kind: "unconfirmed", reply: null, stored: null,
      reason: controller.signal.aborted ? "Technocore did not answer in time" : "Technocore could not be reached" };
  } finally {
    clearTimeout(timer);
  }
  if (res.status >= 400 && res.status < 500) {
    return { kind: "refused", reply, stored: null, reason: `technocore.chat refused this message (HTTP ${res.status}): ${reply.split("\n")[0].slice(0, 200)}` };
  }
  const stored = res.ok ? await findStored(subtle, signed, reply) : null;
  if (stored) return { kind: "published", reply, stored, reason: "" };
  return { kind: "unconfirmed", reply, stored: null,
    reason: res.ok ? "Technocore answered, but the reply did not contain this exact signed message" : `Technocore answered HTTP ${res.status}` };
}

/** Reads a room and looks for a message already sent, without ever sending it again. */
export async function lookFor(subtle, signed, { fetcher = fetch, window = 200 } = {}) {
  try {
    const res = await fetcher(`${TECHNOCORE}/r/${signed.room}?format=json&limit=${window}`, {
      credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
    });
    const body = await res.text();
    const stored = res.ok ? await findStored(subtle, signed, body) : null;
    return stored ? { kind: "published", reply: body, stored, reason: "" } : { kind: "missing", reply: body, stored: null, reason: "" };
  } catch {
    return { kind: "unreachable", reply: null, stored: null, reason: "technocore.chat could not be reached" };
  }
}
