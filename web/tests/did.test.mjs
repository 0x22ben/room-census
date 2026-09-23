// The My DID lookup core: did:key parsing, exact nonces, Ed25519 checks and honest totals. The
// fixture is a real reply of the room-census room, where only Room Census's own DID writes
// (one old message carrying retired schedule wording was cut out; the others are byte for byte).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { check, importKey, publicKey, readReply, roomCoverage, shortestWindow, span, summarize, validRoom, validTs } from "../src/lib/did-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const body = readFileSync(join(HERE, "fixtures", "room-census-reply.json"), "utf8");
const identity = JSON.parse(readFileSync(join(HERE, "..", "..", "identity.json"), "utf8"));
const DID = identity.did;
const subtle = globalThis.crypto.subtle;

test("a did:key gives its 32-byte Ed25519 key; anything else gives nothing", () => {
  assert.equal(publicKey(DID).length, 32);
  for (const bad of ["", "did:key:z6Mk", "did:web:example.com", DID + "x", DID.replace("z6Mk", "z6Mm"), DID.slice(0, -1) + "0", `${DID} `]) {
    assert.equal(publicKey(bad), null, bad);
  }
});

test("nonces keep every digit, even past 2^53", () => {
  const messages = readReply(body);
  const raw = [...body.matchAll(/"nonce":\s*(\d+)/g)].map((m) => m[1]);
  assert.deepEqual(messages.map((m) => m.nonce), raw);
  const big = readReply('{"messages":[{"nonce": 1790180154067082191}]}');
  assert.equal(big[0].nonce, "1790180154067082191");
  assert.throws(() => readReply('{"rooms":[]}'));
  // spacing around the colon does not matter, and text that looks like a nonce is left alone
  assert.equal(readReply('{"messages":[{"nonce" : 1790180154067082191}]}')[0].nonce, "1790180154067082191");
  const [m] = readReply('{"messages":[{"text":"x \\"nonce\\": 5","nonce":12}]}');
  assert.equal(m.text, 'x "nonce": 5');
  assert.equal(m.nonce, "12");
});

test("server times are used only when well formed, and never count a day on their own", () => {
  assert.ok(validTs("2026-09-23T16:15:54.245208Z"));
  assert.ok(validTs("2026-09-23T16:15:54Z"));
  for (const bad of ["garbage", "", null, 5, "2026-09-23", "2026-13-40T99:99:99Z", "2026-09-23T16:15:54.245208"]) assert.ok(!validTs(bad), String(bad));
  const found = [
    { room: "a", message: { ts: "garbage" }, result: "checked" },
    { room: "a", message: { ts: "2026-09-22T10:00:00Z" }, result: "checked" },
  ];
  const s = summarize(found);
  assert.equal(s.signed_messages, 2);
  assert.equal(s.active_days, 1);
  assert.equal(s.last_active, "2026-09-22T10:00:00Z");
});

test("the narrowest room window says how far back the lookup reached", () => {
  const w = shortestWindow([
    { room: "busy", status: "read", first_ts: "2026-09-23T16:00:00.000000Z", last_ts: "2026-09-23T16:00:12.500000Z" },
    { room: "calm", status: "read", first_ts: "2026-09-20T16:00:00Z", last_ts: "2026-09-23T16:00:00Z" },
    { room: "down", status: "not read", reason: "HTTP 503" },
  ]);
  assert.deepEqual(w, { room: "busy", ms: 12500 });
  assert.equal(span(12500), "12 seconds");
  assert.equal(span(60000), "1 minute");
  assert.equal(span(3 * 86400000), "3 days");
  assert.equal(span(10), "under a second");
  assert.equal(shortestWindow([]), null);
});

test("every signature of the real reply checks, and any change to room, nonce or text breaks it", async () => {
  const key = await importKey(subtle, publicKey(DID));
  assert.ok(key, "this Node has Ed25519 in Web Crypto");
  const messages = readReply(body);
  assert.ok(messages.length > 0);
  for (const m of messages) {
    assert.equal(await check(subtle, key, DID, "room-census", m), "checked");
    assert.equal(await check(subtle, key, DID, "lobby", m), "bad");
    assert.equal(await check(subtle, key, DID, "room-census", { ...m, text: m.text + " " }), "bad");
    assert.equal(await check(subtle, key, DID, "room-census", { ...m, nonce: String(BigInt(m.nonce) + 1n) }), "bad");
    assert.equal(await check(subtle, key, DID, "room-census", { ...m, sig: undefined }), "bad");
    assert.equal(await check(subtle, key, "did:key:z6MkOther", "room-census", m), null);
    assert.equal(await check(subtle, null, DID, "room-census", m), "unsupported");
  }
});

test("only checked messages count, and the coverage says what was read", async () => {
  const key = await importKey(subtle, publicKey(DID));
  const messages = readReply(body);
  const found = [];
  for (const m of messages) found.push({ room: "room-census", message: m, result: await check(subtle, key, DID, "room-census", m) });
  found.push({ room: "lobby", message: { ...messages[0], text: "forged" }, result: "bad" });
  const s = summarize(found);
  assert.equal(s.signed_messages, messages.length);
  assert.equal(s.rooms_with_activity, 1);
  assert.equal(s.not_verifiable, 1);
  assert.equal(s.last_active, messages.map((m) => m.ts).sort().pop());
  assert.equal(s.active_days, new Set(messages.map((m) => m.ts.slice(0, 10))).size);
  const c = roomCoverage("room-census", messages);
  assert.equal(c.messages_read, messages.length);
  assert.ok(c.first_ts <= c.last_ts && c.first_seq <= c.last_seq);
  assert.deepEqual(summarize([]), { signed_messages: 0, rooms_with_activity: 0, active_days: 0, last_active: null, not_verifiable: 0, unchecked: 0 });
});

test("room names are checked before they reach a URL", () => {
  for (const ok of ["lobby", "room-census", "a", "x_1"]) assert.ok(validRoom(ok));
  for (const bad of ["", "Lobby", "../x", "a/b", "a?b", "-a", "a".repeat(49)]) assert.ok(!validRoom(bad), bad);
});
