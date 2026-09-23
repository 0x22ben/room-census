// The My DID identity module: generation, encrypted backup round trip, every way a backup must fail,
// the Technocore signing payload, and first-message rules. Runs on Node's Web Crypto.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { check, publicKey } from "../src/lib/did-core.mjs";
import {
  BACKUP_SCHEMA, createIdentity, didOf, forget, ITERATIONS, messageProblem, nextNonce, openBackup, passwordProblem, proofOf, ROOMS,
  sealBackup, signMessage, STARTERS, sweep, WalletError,
} from "../src/lib/did-wallet.mjs";

const subtle = globalThis.crypto.subtle;
const random = (n) => new Uint8Array(randomBytes(n));
const PASSWORD = "correct horse battery staple";
const hex = (b) => Buffer.from(b).toString("hex");
const encodings = (b) => [hex(b), Buffer.from(b).toString("base64"), Buffer.from(b).toString("base64url")];

async function sealed() {
  const id = await createIdentity(subtle);
  const seed = id.pkcs8.slice(16);
  const backup = await sealBackup(subtle, random, id, PASSWORD);
  return { id, seed, backup, text: JSON.stringify(backup) };
}

async function failsWith(code, promise) {
  await assert.rejects(promise, (e) => e instanceof WalletError && e.code === code);
}

test("a new identity is an Ed25519 did:key that signs what Technocore checks", async () => {
  const id = await createIdentity(subtle);
  assert.match(id.did, /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/);
  assert.equal(id.did.length, 56);
  assert.equal(publicKey(id.did).length, 32);
  assert.equal(id.pkcs8.length, 48);
  assert.equal(id.privateKey.extractable, false, "the key the page keeps cannot be exported");
  const signed = await signMessage(subtle, id, "lobby", "1790000000000", "hello");
  const key = await subtle.importKey("raw", publicKey(id.did), { name: "Ed25519" }, false, ["verify"]);
  assert.equal(await check(subtle, key, id.did, "lobby", { from: id.did, ...signed }), "checked");
  assert.match(signed.sig, /^[A-Za-z0-9_-]{85}[AQgw]$/);
  const other = await createIdentity(subtle);
  assert.notEqual(other.did, id.did);
  forget(id.pkcs8);
  assert.ok(id.pkcs8.every((b) => b === 0));
});

test("the DID derivation matches the did:key encoding of flop_did.py", () => {
  // the Room Census public key and DID, as published in identity.json
  const did = "did:key:z6Mkmpb5XhgweP9mfxnA3vpQRu2VcSsGyFC7AfE3ZEFqXxD1";
  assert.equal(didOf(publicKey(did)), did);
});

test("a backup opens with its password and gives back the exact same DID and key", async () => {
  const { id, seed, backup, text } = await sealed();
  assert.equal(backup.schema, BACKUP_SCHEMA);
  assert.equal(backup.kdf.iterations, ITERATIONS);
  assert.deepEqual(Object.keys(backup).sort(), ["cipher", "ciphertext", "created_at", "did", "kdf", "schema"]);
  for (const e of encodings(seed)) assert.ok(!text.includes(e), "the key never appears in clear in the file");
  assert.ok(!text.includes(PASSWORD));
  const back = await openBackup(subtle, text, PASSWORD);
  assert.equal(back.did, id.did);
  const a = await signMessage(subtle, id, "lobby", "7", "same");
  const b = await signMessage(subtle, back, "lobby", "7", "same");
  assert.equal(a.sig, b.sig, "Ed25519 is deterministic: the same key gives the same signature");
  // two backups of one key never share salt, IV or ciphertext
  const again = await sealBackup(subtle, random, id, PASSWORD);
  assert.notEqual(again.kdf.salt, backup.kdf.salt);
  assert.notEqual(again.cipher.iv, backup.cipher.iv);
  assert.notEqual(again.ciphertext, backup.ciphertext);
});

test("a wrong password fails safely, without key material in the error", async () => {
  const { seed, text } = await sealed();
  for (const wrong of ["", "correct horse battery stapl", PASSWORD + " "]) {
    const err = await openBackup(subtle, text, wrong).catch((e) => e);
    assert.ok(err instanceof WalletError, wrong);
    assert.equal(err.code, "password");
    for (const e of encodings(seed)) assert.ok(!String(err.message + err.stack).includes(e));
  }
});

test("a changed backup fails: ciphertext, DID, date, salt, IV, iterations, extra or missing fields", async () => {
  const { text } = await sealed();
  const b = JSON.parse(text);
  const flip = (s) => (s[5] === "A" ? `${s.slice(0, 5)}B${s.slice(6)}` : `${s.slice(0, 5)}A${s.slice(6)}`);
  const other = (await createIdentity(subtle)).did;
  const cases = [
    ["password", { ...b, ciphertext: flip(b.ciphertext) }],
    ["password", { ...b, did: other }],
    ["password", { ...b, created_at: "2020-01-01T00:00:00.000Z" }],
    ["password", { ...b, kdf: { ...b.kdf, salt: flip(b.kdf.salt) } }],
    ["password", { ...b, cipher: { ...b.cipher, iv: flip(b.cipher.iv) } }],
    ["format", { ...b, kdf: { ...b.kdf, iterations: 1000 } }],
    ["format", { ...b, extra: 1 }],
    ["format", { ...b, ciphertext: undefined }],
    ["format", { ...b, did: "did:key:z6MkNOTAKEY" }],
    ["format", { ...b, cipher: { ...b.cipher, name: "AES-CBC" } }],
  ];
  for (const [code, changed] of cases) await failsWith(code, openBackup(subtle, JSON.stringify(changed), PASSWORD));
  for (const junk of ["", "{", "[]", "null", '"x"', "{}", JSON.stringify({ schema: "something/1" })]) {
    await failsWith("format", openBackup(subtle, junk, PASSWORD));
  }
});

test("a backup whose key does not match its DID is refused", async () => {
  const a = await createIdentity(subtle);
  const b = await createIdentity(subtle);
  const forged = await sealBackup(subtle, random, { did: a.did, pkcs8: b.pkcs8 }, PASSWORD);
  await failsWith("mismatch", openBackup(subtle, JSON.stringify(forged), PASSWORD));
});

test("prototype keys and duplicated keys in a backup never open it wrongly", async () => {
  const { text, id } = await sealed();
  const b = JSON.parse(text);
  await failsWith("format", openBackup(subtle, text.replace('{"schema"', '{"__proto__":{"x":1},"schema"'), PASSWORD));
  await failsWith("format", openBackup(subtle, JSON.stringify({ ...b, kdf: { ...b.kdf, __proto__: { iterations: 1 } } }).replace('"kdf":{', '"kdf":{"constructor":1,'), PASSWORD));
  // a duplicated key keeps its last value, and the authenticated header is built from parsed values
  const other = (await createIdentity(subtle)).did;
  await failsWith("password", openBackup(subtle, text.replace('"did":', `"did":"${other}","did":`).replace(`"did":"${other}","did":"${id.did}"`, `"did":"${id.did}","did":"${other}"`), PASSWORD));
  assert.equal((await openBackup(subtle, text.replace('"did":', `"did":"${other}","did":`), PASSWORD)).did, id.did);
});

test("a backup from a newer version is refused as such", async () => {
  const { text } = await sealed();
  await failsWith("version", openBackup(subtle, JSON.stringify({ ...JSON.parse(text), schema: "room-census-did-backup/2" }), PASSWORD));
});

test("passwords need twelve characters and a matching confirmation", () => {
  assert.match(passwordProblem("short", "short"), /at least 12/);
  assert.match(passwordProblem(PASSWORD, PASSWORD + "x"), /not the same/);
  assert.equal(passwordProblem(PASSWORD, PASSWORD), null);
});

test("the text signed is the text Technocore stores, after its single-line sweep", async () => {
  assert.equal(sweep("  a\nb\tc\u200bd\u2028e\u202ef  "), "a b c d e f");
  assert.equal(sweep("\u0000x\u00ad"), "x");
  const id = await createIdentity(subtle);
  const s = await signMessage(subtle, id, "lobby", "12", " line one\nline two ");
  assert.equal(s.text, "line one line two");
  const key = await subtle.importKey("raw", publicKey(id.did), { name: "Ed25519" }, false, ["verify"]);
  assert.equal(await check(subtle, key, id.did, "lobby", { from: id.did, ...s }), "checked");
  assert.equal(await check(subtle, key, id.did, "lobby", { from: id.did, ...s, text: " line one\nline two " }), "bad");
});

test("starters are editable prompts: every bracket must be filled, only lobby is allowed", () => {
  assert.deepEqual(ROOMS, ["lobby"]);
  assert.equal(STARTERS.length, 4);
  for (const s of STARTERS) {
    assert.match(messageProblem("lobby", s.text), /\[brackets\]/);
    assert.doesNotMatch(s.text, /airdrop|eligib|\bgm\b|present/i);
  }
  const filled = "I am building a room map to help newcomers. I would appreciate feedback on the layout.";
  assert.equal(messageProblem("lobby", filled), null);
  assert.equal(messageProblem("room-census", filled), "Choose a room.");
  assert.equal(messageProblem("lobby", " \n "), "Write your message.");
  assert.match(messageProblem("lobby", "x".repeat(4097)), /4096/);
  assert.match(messageProblem("lobby", "I am building [project] now"), /\[brackets\]/);
});

test("nonces are digit strings from the millisecond clock, and proofs keep the full reply", () => {
  assert.equal(nextNonce(1790000000123.9), "1790000000123");
  assert.match(nextNonce(), /^\d{13,19}$/);
  const signed = { room: "lobby", nonce: "5", text: "t", did: "did:key:z6Mk", sig: "s" };
  const p = proofOf(signed, "published", '{"raw":1}', { seq: 9, ts: "2026-09-23T00:00:00Z" }, "2026-09-23T00:00:01Z");
  assert.equal(p.signed_payload, "lobby|5|t");
  assert.equal(p.server_reply, '{"raw":1}');
  assert.equal(p.seq, 9);
  assert.equal(proofOf(signed, "unconfirmed", null, null).seq, null);
});
