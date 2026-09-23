// Opening an identity.pem: the DID it derives, the DID it refuses, and the recovery file it can
// become. The fixture was written by the same call flop_did.py makes, from a seed that is in the
// file's own header, so "the browser derives the DID the Python tool prints" is checked, not assumed.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { check, publicKey } from "../src/lib/did-core.mjs";
import {
  backupFromPem, didFromText, forget, nextNonce, openBackup, openIdentityPem, passphraseFromText, PemError,
  sealBackup, signMessage, WalletError,
} from "../src/lib/did-wallet.mjs";
import { MAX_BYTES, sortFiles } from "../src/lib/did-files.mjs";
import { publicFromSeed } from "../src/lib/ed25519-public.mjs";

const subtle = globalThis.crypto.subtle;
const random = (n) => new Uint8Array(randomBytes(n));
const PEM = readFileSync(new URL("./fixtures/identity-test-key.pem.txt", import.meta.url), "utf8");
const PASSPHRASE = "correct horse battery staple";
// what `python flop_did.py` prints for the seed named in the fixture's header
const DID = "did:key:z6MkehRgf7yJbgaGfYsdoAsKdBPE3dj2CYhowQdcjqSJgvVd";

const failsWith = (code, promise) => assert.rejects(promise, (e) => (e instanceof PemError || e instanceof WalletError) && e.code === code);
/** The same file with one byte of the sealed key changed, and nothing else. */
function broken(text) {
  const lines = text.split("\n");
  const last = lines.findLastIndex((l) => /^[A-Za-z0-9+/=]{8,}$/.test(l));
  const line = lines[last];
  lines[last] = line.slice(0, 5) + (line[5] === "A" ? "B" : "A") + line.slice(6);
  return lines.join("\n");
}

test("the public key computed here is the one Web Crypto exports", async () => {
  for (let i = 0; i < 10; i++) {
    const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey));
    const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
    assert.deepEqual(await publicFromSeed(subtle, pkcs8.subarray(16)), raw);
  }
});

test("an identity.pem derives the DID the Python tool prints for the same key", async () => {
  const identity = await openIdentityPem(subtle, PEM, PASSPHRASE);
  assert.equal(identity.did, DID);
  assert.equal(identity.privateKey.extractable, false, "the key can never be exported again");
  assert.deepEqual(identity.privateKey.usages, ["sign"]);
});

test("a did.txt is only a check: it is never needed, and a mismatch is refused", async () => {
  const other = await openIdentityPem(subtle, PEM, PASSPHRASE);
  assert.equal((await openIdentityPem(subtle, PEM, PASSPHRASE, `${DID}\n`)).did, other.did);
  assert.equal((await openIdentityPem(subtle, PEM, PASSPHRASE, undefined)).did, DID, "leaving did.txt out skips the check");
  // a did.txt that was given must hold a DID, even when it is empty
  await failsWith("mismatch", openIdentityPem(subtle, PEM, PASSPHRASE, ""));
  await failsWith("mismatch", openIdentityPem(subtle, PEM, PASSPHRASE, "   "));
  const mine = await sealBackup(subtle, random, { did: DID, pkcs8: new Uint8Array(48) }, PASSPHRASE).catch(() => null);
  assert.equal(mine, null, "a backup is never sealed around a key that is not one");
  await failsWith("mismatch", openIdentityPem(subtle, PEM, PASSPHRASE, "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"));
  assert.equal(didFromText("did:key:z6MkehRgf7yJbgaGfYsdoAsKdBPE3dj2CYhowQdcjqSJgvVd\n"), DID);
  assert.equal(didFromText("nothing here"), null);
  assert.equal(passphraseFromText(`${PASSPHRASE}\r\nsomething else`), PASSPHRASE);
});

test("a wrong passphrase, a changed file and an unsupported format are all refused", async () => {
  await failsWith("password", openIdentityPem(subtle, PEM, "correct horse battery stapl"));
  await failsWith("password", openIdentityPem(subtle, PEM, ""));
  await failsWith("password", openIdentityPem(subtle, broken(PEM), PASSPHRASE));
  await failsWith("format", openIdentityPem(subtle, "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n", PASSPHRASE));
  await failsWith("format", openIdentityPem(subtle, "{\"schema\":\"room-census-did-backup/1\"}", PASSPHRASE));
  await failsWith("format", openIdentityPem(subtle, "", PASSPHRASE));
  // an unprotected key is refused rather than opened
  const plain = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END PRIVATE KEY-----\n";
  await failsWith("unsupported", openIdentityPem(subtle, plain, PASSPHRASE));
});

test("both backup formats sign for the same DID, and Technocore checks either signature", async () => {
  const fromPem = await openIdentityPem(subtle, PEM, PASSPHRASE);
  // the same key, sealed into the Room Census container, then opened again
  const sealed = await backupFromPem(subtle, random, PEM, PASSPHRASE, "a longer test password", DID);
  const fromJson = await openBackup(subtle, JSON.stringify(sealed), "a longer test password");
  assert.equal(fromJson.did, DID, "converting never produces another DID");
  assert.equal(sealed.did, DID);

  const room = "room-census-tests";
  const nonce = nextNonce();
  const a = await signMessage(subtle, fromPem, room, nonce, "Two files, one DID.");
  const b = await signMessage(subtle, fromJson, room, nonce, "Two files, one DID.");
  assert.equal(a.sig, b.sig, "Ed25519 is deterministic: the same key signs the same bytes the same way");
  const key = await subtle.importKey("raw", publicKey(DID), { name: "Ed25519" }, false, ["verify"]);
  for (const signed of [a, b]) {
    assert.equal(await check(subtle, key, DID, room, { from: DID, nonce: signed.nonce, text: signed.text, sig: signed.sig }), "checked");
  }
});

test("a conversion that cannot prove the DID writes nothing", async () => {
  await failsWith("password", backupFromPem(subtle, random, PEM, "not the passphrase", "a longer test password", DID));
  await failsWith("mismatch", backupFromPem(subtle, random, PEM, PASSPHRASE, "a longer test password", "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"));
});

test("opening a file asks nothing of the network", async () => {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = (...args) => { calls.push(args[0]); throw new Error("no request is allowed here"); };
  try {
    const identity = await openIdentityPem(subtle, PEM, PASSPHRASE, `${DID}\n`);
    const sealed = await backupFromPem(subtle, random, PEM, PASSPHRASE, "a longer test password", identity.did);
    await openBackup(subtle, JSON.stringify(sealed), "a longer test password");
    await signMessage(subtle, identity, "room-census-tests", nextNonce(), "Nothing left this machine.");
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(calls, []);
});

test("the bytes a page holds are wiped once they are used", () => {
  const bytes = Uint8Array.from([1, 2, 3]);
  forget(bytes);
  assert.deepEqual([...bytes], [0, 0, 0]);
});

// ---- the structure itself, byte for byte ----

const der = (text) => Buffer.from(text.replace(/[\s\S]*?-----BEGIN ENCRYPTED PRIVATE KEY-----/, "").replace(/-----END[\s\S]*/, "").replace(/\s+/g, ""), "base64");
const armour = (bytes) => `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${Buffer.from(bytes).toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END ENCRYPTED PRIVATE KEY-----\n`;
/** One DER element: a tag and its contents, with the length written the way a reader expects it. */
function element(tag, value) {
  const body = Buffer.from(value);
  const head = body.length < 128 ? [tag, body.length]
    : body.length < 256 ? [tag, 0x81, body.length]
      : [tag, 0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from(head), body]);
}
const seq = (...parts) => element(0x30, Buffer.concat(parts));
const oid = (hex) => element(0x06, Buffer.from(hex, "hex"));
const octets = (bytes) => element(0x04, Buffer.from(bytes));
const OIDS = { pbes2: "2a864886f70d01050d", pbkdf2: "2a864886f70d01050c", sha256: "2a864886f70d0209", sha1: "2a864886f70d0207", aes256: "60864801650304012a", aes128: "60864801650304010e" };

/** The fixture's own structure, rebuilt part by part, so one part at a time can be changed. */
function rebuilt({ prf = OIDS.sha256, cipher = OIDS.aes256, extra = null, prfArgs = [element(0x05, [])] } = {}) {
  const bytes = der(PEM);
  const salt = bytes.subarray(35, 51);
  const iv = bytes.subarray(84, 100);
  const sealed = bytes.subarray(102);
  const params = [octets(salt), element(0x02, [0x08, 0x00]), seq(oid(prf), ...prfArgs)];
  if (extra) params.push(extra);
  return seq(seq(oid(OIDS.pbes2), seq(seq(oid(OIDS.pbkdf2), seq(...params)), seq(oid(cipher), octets(iv)))), octets(sealed));
}

test("the rebuilt structure is the fixture's own, so the mutations below change one thing each", async () => {
  assert.deepEqual(rebuilt(), der(PEM));
  assert.equal((await openIdentityPem(subtle, armour(rebuilt()), PASSPHRASE)).did, DID);
});

test("a structure that is not exactly the one flop_did.py writes is refused", async () => {
  // nothing may follow the key, and nothing may be missing from it
  await failsWith("format", openIdentityPem(subtle, armour(Buffer.concat([rebuilt(), Buffer.from([0x00])])), PASSPHRASE));
  await failsWith("format", openIdentityPem(subtle, armour(rebuilt().subarray(0, -1)), PASSPHRASE));
  // an extra field inside the key derivation, even a harmless one, is not silently ignored
  await failsWith("unsupported", openIdentityPem(subtle, armour(rebuilt({ extra: element(0x02, [0x20]) })), PASSPHRASE));
  await failsWith("unsupported", openIdentityPem(subtle, armour(rebuilt({ prfArgs: [element(0x05, []), element(0x05, [])] })), PASSPHRASE));
  // another hash or another cipher is refused rather than attempted
  await failsWith("unsupported", openIdentityPem(subtle, armour(rebuilt({ prf: OIDS.sha1 })), PASSPHRASE));
  await failsWith("unsupported", openIdentityPem(subtle, armour(rebuilt({ cipher: OIDS.aes128 })), PASSPHRASE));
});

test("a selection of files is sorted by name, and refused before anything is read", () => {
  const file = (name, size = 600) => ({ name, size });
  assert.deepEqual(sortFiles([file("identity.pem")]).key.name, "identity.pem");
  const full = sortFiles([file(String.raw`C:\keys\Identity.PEM`), file("passphrase.txt"), file("did.txt")]);
  assert.equal(full.key.name, String.raw`C:\keys\Identity.PEM`);
  assert.equal(full.passphrase.name, "passphrase.txt");
  assert.equal(full.did.name, "did.txt");
  assert.equal(sortFiles([file("room-census-did-recovery-2026-09-23.json")]).problem, undefined);

  const problem = (files) => sortFiles(files).problem;
  assert.match(problem([]), /Choose your DID file/);
  assert.match(problem([file("identity.pem"), file("backup.json")]), /one DID file at a time/);
  assert.match(problem([file("did.txt"), file("did.txt")]), /Only one did\.txt/);
  assert.match(problem([file("identity.pem"), file("passphrase.txt"), file("passphrase.txt")]), /Only one passphrase\.txt/);
  assert.match(problem([file("identity.pem"), file("notes.md")]), /does not know what to do with notes\.md/);
  assert.match(problem([file("passphrase.txt"), file("did.txt")]), /None of these files is a DID file/);
  assert.match(problem([file("identity.pem"), file("did.txt"), file("passphrase.txt"), file("extra.json")]), /at most 3 files/);
  assert.match(problem([file("identity.pem", MAX_BYTES + 1)]), /too large/);
  assert.match(problem([file("identity.pem"), file("did.txt", MAX_BYTES + 1)]), /did\.txt is too large/);
});

test("a did.txt is one DID and nothing else", async () => {
  assert.equal(didFromText(` ${DID}\n`), DID);
  assert.equal(didFromText(`${DID} (my identity)`), null);
  assert.equal(didFromText(`${DID}\n${DID}`), null);
  assert.equal(didFromText("did:key:z6MkehRgf7yJbgaGfYsdoAsKdBPE3dj2CYhowQdcjqSJgvV"), null);
  await failsWith("mismatch", openIdentityPem(subtle, PEM, PASSPHRASE, `${DID} (my identity)`));
  await failsWith("mismatch", openIdentityPem(subtle, PEM, PASSPHRASE, "x".repeat(400)));
});
