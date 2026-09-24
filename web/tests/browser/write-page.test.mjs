// The Write page, as shipped, in a real headless browser. Every Technocore request is answered by the
// test: nothing is ever published for real. The tests prove the rules Ben approved:
// a typed or pasted public DID can never publish, the signing DID always comes from the unlocked key,
// a mismatched file is refused, an unknown room can never be created, publication needs a review and
// a confirmation and happens once, sharing in another room asks for everything again with a new
// signature and nonce, and no private material reaches a request, storage, the URL or the page.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

import { check, publicKey } from "../../src/lib/did-core.mjs";
import { backupHeader, createIdentity, openBackup, sealBackup } from "../../src/lib/did-wallet.mjs";
import { DIST, listeners, navigate, page, send, site, skip, sleep, start, stop, until, WEB } from "./harness.mjs";

const subtle = globalThis.crypto.subtle;
const PASSWORD = "correct horse battery staple";
const MESSAGE = "I am building a room map to help newcomers find active rooms. I would appreciate feedback on the layout.";
const files = mkdtempSync(join(tmpdir(), "rc-write-"));
let fileNo = 0;
const saveFile = (text, name) => { const p = join(files, name ?? `backup-${++fileNo}.json`); writeFileSync(p, text); return p; };
const saveAs = (name, text) => { const dir = mkdtempSync(join(files, "sel-")); const p = join(dir, name); writeFileSync(p, text); return p; };
const latest = JSON.parse(readFileSync(join(DIST, "data", "latest.json"), "utf8"));

const CATCH_DOWNLOADS = `
  window.__downloads = []; window.__blobs = {};
  const create = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { const u = create(b); window.__blobs[u] = b; return u; };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.href.startsWith("blob:") && window.__blobs[this.href]) { window.__downloads.push({ name: this.download, blob: window.__blobs[this.href] }); return; }
    return click.call(this);
  };`;

async function open(technocore = () => ({ body: JSON.stringify({ room: "x", messages: [] }) }), path = "/write/") {
  const log = { requests: [], posts: [], console: [] };
  listeners.clear();
  listeners.add(async (msg) => {
    if (msg.method === "Network.requestWillBeSent") log.requests.push(msg.params.request);
    if (msg.method === "Runtime.consoleAPICalled") log.console.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    if (msg.method === "Log.entryAdded") log.console.push(msg.params.entry.text);
    if (msg.method !== "Fetch.requestPaused") return;
    const { requestId, request } = msg.params;
    if (request.method === "OPTIONS") {
      await send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [
        { name: "access-control-allow-origin", value: "*" }, { name: "access-control-allow-methods", value: "GET, POST" },
        { name: "access-control-allow-headers", value: "Accept, Accept-Language, Content-Language, Content-Type" }] }).catch(() => {});
      return;
    }
    if (request.postData === undefined && request.postDataEntries) {
      request.postData = request.postDataEntries.map((e) => Buffer.from(e.bytes ?? "", "base64").toString("utf8")).join("");
    }
    if (request.method === "POST") log.posts.push(request);
    const a = technocore(request);
    if (a === "hold") return;
    if (a === "fail") { await send("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" }).catch(() => {}); return; }
    await send("Fetch.fulfillRequest", { requestId, responseCode: a.status ?? 200,
      responseHeaders: [{ name: "content-type", value: "application/json" }, { name: "access-control-allow-origin", value: "*" }, ...(a.headers ?? [])],
      body: Buffer.from(a.body ?? "").toString("base64") }).catch(() => {});
  });
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://technocore.chat/*", requestStage: "Request" }] });
  const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", { source: CATCH_DOWNLOADS });
  await navigate(path);
  await until(`!document.querySelector('${path.startsWith("/write/") ? "[data-write]" : "[data-did-form]"}').hidden`, "the page script");
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  log.loaded = log.requests.length;
  return log;
}

const q = (sel) => JSON.stringify(sel);
const text = (sel) => page(`document.querySelector(${q(sel)})?.textContent.trim() ?? null`);
const hidden = (sel) => page(`document.querySelector(${q(sel)}).hidden`);
const visible = (sel) => page(`(() => { const e = document.querySelector(${q(sel)}); return !!e && !e.hidden && !e.closest("[hidden]"); })()`);
const click = (sel) => page(`document.querySelector(${q(sel)}).click()`);
const fill = (sel, value) => page(`(() => { const e = document.querySelector(${q(sel)}); e.value = ${q(value)}; e.dispatchEvent(new Event("input", { bubbles: true })); })()`);
const submit = (sel) => page(`document.querySelector(${q(sel)}).requestSubmit()`);
const downloads = () => page("Promise.all(window.__downloads.map(async (d) => ({ name: d.name, text: await d.blob.text() })))");
const outcome = (kind, ms) => until(`document.querySelector('[data-panel=outcome]').dataset.outcome === '${kind}' && !document.querySelector('[data-panel=outcome]').hidden`, `the ${kind} outcome`, ms);
const errorOf = (name) => text(`[data-error="${name}"]`);
const waitError = (name) => until(`document.querySelector('[data-error="${name}"]').textContent !== ''`, `the ${name} error`);
async function setFile(selector, ...paths) {
  const { root } = await send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector });
  await send("DOM.setFileInputFiles", { nodeId, files: paths });
}
// the identity.pem the Python tool writes, with the DID it prints for that same key
const PEM_TEXT = readFileSync(resolve(WEB, "tests", "fixtures", "identity-test-key.pem.txt"), "utf8");
const PEM_PASSPHRASE = "correct horse battery staple";
const PEM_DID = "did:key:z6MkehRgf7yJbgaGfYsdoAsKdBPE3dj2CYhowQdcjqSJgvVd";
const backupFile = async (identity) => saveFile(JSON.stringify(await sealBackup(subtle, (n) => new Uint8Array(randomBytes(n)), identity, PASSWORD)), `room-census-did-recovery-${++fileNo}.json`);

const stored = (post, seq = 51) => {
  const m = JSON.parse(post.postData);
  return JSON.stringify({ room: m.room ?? "lobby", count: 1, first_seq: seq, last_seq: seq,
    messages: [{ seq, ts: "2026-09-23T21:00:00.500000Z", from: m.did, text: m.text, nonce: m.nonce, sig: m.sig }] })
    .replace(/"nonce":"(\d+)"/, '"nonce":$1');
};

async function secretsOf(backup) {
  const b = JSON.parse(backup);
  const base = await subtle.importKey("raw", new TextEncoder().encode(PASSWORD), "PBKDF2", false, ["deriveKey"]);
  const key = await subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: Buffer.from(b.kdf.salt, "base64url"), iterations: b.kdf.iterations },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const pkcs8 = Buffer.from(await subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(b.cipher.iv, "base64url"),
    additionalData: new TextEncoder().encode(backupHeader(b)) }, key, Buffer.from(b.ciphertext, "base64url")));
  return [pkcs8.subarray(16), pkcs8].flatMap((x) => [x.toString("hex"), x.toString("base64"), x.toString("base64url")]).concat(PASSWORD);
}

async function exposure(log) {
  const inPage = await page(`(async () => JSON.stringify({
    html: document.documentElement.outerHTML, url: location.href, cookie: document.cookie,
    local: { ...localStorage }, session: { ...sessionStorage },
    databases: (await (indexedDB.databases?.() ?? Promise.resolve([]))).map((d) => d.name),
    fields: [...document.querySelectorAll("input, textarea")].map((i) => i.value),
  }))()`);
  const offered = (await downloads()).map((d) => d.text);
  return [inPage, JSON.stringify(log.requests.map((r) => [r.url, r.postData ?? ""])), log.console.join("\n"), ...offered].join("\n");
}

/** Unlocks a fresh identity on the Write page and returns it with the request log. */
async function unlocked(technocore) {
  const log = await open(technocore);
  const identity = await createIdentity(subtle);
  await setFile("[data-unlock-file]", await backupFile(identity));
  await fill("[data-unlock-password]", PASSWORD);
  await submit("[data-unlock]");
  await until("!document.querySelector('[data-panel=room]').hidden", "the room picker");
  return { did: identity.did, log };
}

async function compose(room, message = MESSAGE) {
  await fill("[data-room-search]", room);
  await until(`[...document.querySelectorAll('[data-room]')].some(b => b.dataset.room === ${q(room)})`, `the room ${room}`);
  await click(`[data-room="${room}"]`);
  await fill("[data-message]", message);
  await submit("[data-compose]");
  await until("!document.querySelector('[data-panel=review]').hidden", "the review");
}
async function publishNow() {
  await click("[data-understand]");
  await click("[data-action=publish]");
}

before(start);
after(async () => { await stop(); rmSync(files, { recursive: true, force: true }); });

test("only a recovery file unlocks, and the signing DID comes from the key inside it", { skip }, async () => {
  const log = await open();
  // the page offers no way to type a DID: the only field naming one takes a file
  assert.equal(await page(`[...document.querySelectorAll("[data-write] input")].filter(i => i.type !== "file" && /did/i.test(i.getAttribute("aria-label") || i.id || "")).length`), 0);
  assert.equal(await page(`document.querySelector("[data-did-value]").isContentEditable`), false);
  assert.equal(await visible("[data-signing]"), false);

  const identity = await createIdentity(subtle);
  const other = await createIdentity(subtle);
  // a recovery file whose DID does not match its key is refused
  const forged = await sealBackup(subtle, (n) => new Uint8Array(randomBytes(n)), { did: identity.did, pkcs8: other.pkcs8 }, PASSWORD);
  await setFile("[data-unlock-file]", saveFile(JSON.stringify(forged)));
  await fill("[data-unlock-password]", PASSWORD);
  await submit("[data-unlock]");
  await waitError("unlock");
  assert.equal(await errorOf("unlock"), "The key in this backup does not match its DID.");
  assert.equal(await hidden("[data-panel=room]"), true);

  await setFile("[data-unlock-file]", await backupFile(identity));
  await fill("[data-unlock-password]", "wrong password here");
  await submit("[data-unlock]");
  await until(`document.querySelector('[data-error="unlock"]').textContent.startsWith("Wrong")`, "the wrong password error");
  await fill("[data-unlock-password]", PASSWORD);
  await submit("[data-unlock]");
  await until("!document.querySelector('[data-panel=room]').hidden", "the room picker");

  assert.equal(await text("[data-signing] code[data-did-value]"), identity.did, "the DID is derived from the unlocked key");
  assert.equal(await page("document.querySelector('[data-unlock-password]').value"), "");
  assert.equal(log.requests.length, log.loaded, "unlocking made no request");
  const haystack = await exposure(log);
  for (const secret of await secretsOf(JSON.stringify(await sealBackup(subtle, (n) => new Uint8Array(randomBytes(n)), identity, PASSWORD)))) {
    if (secret === PASSWORD) assert.ok(!haystack.includes(secret), "the passphrase leaked");
  }
});

test("only a room from the census list can be picked, and publishing needs a review and a confirmation", { skip }, async () => {
  const { did, log } = await unlocked((r) => (r.method === "POST" ? { body: stored(r) } : { body: "{}" }));
  const first = latest.rooms[0].room;

  // a name that is not measured cannot be chosen, and nothing creates it
  await fill("[data-room-search]", "not-a-real-room-9x");
  assert.equal(await page("document.querySelectorAll('[data-room]').length"), 0);
  assert.equal(await visible("[data-room-empty]"), true);
  await fill("[data-message]", MESSAGE);
  await submit("[data-compose]");
  assert.equal(await errorOf("compose"), "Choose a room from the list.");
  assert.equal(log.posts.length, 0);

  await compose(first);
  assert.equal(await text("[data-review-room]"), first);
  assert.equal(await text("[data-review-did]"), did);
  assert.equal(await text("[data-review-text]"), MESSAGE);
  assert.equal(await page("document.querySelector('[data-action=publish]').disabled"), true, "no confirmation, no publication");
  await click("[data-action=publish]");
  await sleep(200);
  assert.equal(log.posts.length, 0);

  await click("[data-understand]");
  await page("document.querySelector('[data-action=publish]').click(); document.querySelector('[data-action=publish]').click();");
  await outcome("published");
  await click("[data-action=publish]");
  await sleep(300);
  assert.equal(log.posts.length, 1, "one message, sent once");
  const body = JSON.parse(log.posts[0].postData);
  assert.equal(log.posts[0].url, `https://technocore.chat/r/${first}?format=json`);
  assert.deepEqual(Object.keys(body).sort(), ["did", "nonce", "sig", "text"]);
  assert.equal(body.did, did, "the published DID is the unlocked one");
  const key = await subtle.importKey("raw", publicKey(did), { name: "Ed25519" }, false, ["verify"]);
  assert.equal(await check(subtle, key, did, first, { from: did, ...body }), "checked");
  assert.equal(await text("[data-outcome-title]"), "Message published");
  assert.equal(await text("[data-out-room]"), first);
  assert.equal((await downloads()).length, 0, "no receipt is forced on the reader");
  // the DID reaches My DID through a fragment, which a browser never sends with a request
  assert.equal(decodeURIComponent(await page(`document.querySelector('[data-action=view]').getAttribute("href")`)), `/look-up/#did=${did}`);
  for (const r of log.requests) assert.ok(!r.url.includes("z6Mk"), `the DID left the browser: ${r.url}`);

  // the receipt is optional, and nothing secret is anywhere after a publication
  await page("document.querySelector('[data-advanced]').open = true");
  await click("[data-action=download-proof]");
  const receipts = (await downloads()).filter((d) => d.name.startsWith("room-census-technical-receipt-"));
  assert.equal(receipts.length, 1);
  assert.equal(JSON.parse(receipts[0].text).outcome, "published");
  assert.ok(!(await exposure(log)).includes(PASSWORD), "the passphrase leaked");

  // locking forgets the key: the page goes back to its locked state
  await click("[data-action=lock]");
  assert.equal(await hidden("[data-panel=locked]"), false);
  assert.equal(await visible("[data-signing]"), false);
  assert.equal(await text("[data-signing] code[data-did-value]"), "");
  assert.equal(await page("document.querySelector('[data-unlock-password]').value"), "");
});

test("an identity.pem opens the same DID, and only with the right files", { skip }, async () => {
  const log = await open((r) => (r.method === "POST" ? { body: stored(r) } : { body: "{}" }));
  const pemPath = saveAs("identity.pem", PEM_TEXT);
  // a did.txt naming another DID stops everything, even with the right passphrase typed by hand
  const wrongDid = saveAs("did.txt", "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK\n");
  await setFile("[data-unlock-file]", pemPath, wrongDid);
  await fill("[data-unlock-password]", PEM_PASSPHRASE);
  await submit("[data-unlock]");
  await waitError("unlock");
  assert.match(await errorOf("unlock"), /did\.txt names a different DID/);
  assert.equal(await hidden("[data-panel=locked]"), false);
  assert.equal(await visible("[data-signing]"), false);

  // a did.txt that holds anything else is refused too, and never taken for a passphrase
  for (const [what, body] of [["extra text", `${PEM_DID} (my identity)\n`], ["nothing usable", "hello\n"],
    ["two DIDs", `${PEM_DID}\n${PEM_DID}\n`], ["a huge file", "x".repeat(70000)]]) {
    await setFile("[data-unlock-file]", pemPath, saveAs("did.txt", body));
    await fill("[data-unlock-password]", PEM_PASSPHRASE);
    await submit("[data-unlock]");
    await waitError("unlock");
    assert.match(await errorOf("unlock"), /did\.txt (does not hold one did:key value|is too large)/, `did.txt with ${what}`);
    assert.equal(await visible("[data-signing]"), false, `did.txt with ${what} unlocked something`);
  }

  // a selection that is not one key file with at most one of each helper is refused before it is read
  const refusals = [
    [[pemPath, saveAs("backup.json", "{}")], /one DID file at a time/],
    [[pemPath, saveAs("did.txt", `${PEM_DID}\n`), saveAs("did.txt", `${PEM_DID}\n`)], /Only one did\.txt/],
    [[pemPath, saveAs("passphrase.txt", "a"), saveAs("passphrase.txt", "b")], /Only one passphrase\.txt/],
    [[pemPath, saveAs("notes.md", "hello")], /does not know what to do with notes\.md/],
    [[saveAs("passphrase.txt", "a")], /None of these files is a DID file/],
    [[saveAs("identity.pem", "x".repeat(70000))], /identity\.pem is too large/],
  ];
  for (const [paths, expected] of refusals) {
    await setFile("[data-unlock-file]", ...paths);
    await fill("[data-unlock-password]", PEM_PASSPHRASE);
    await submit("[data-unlock]");
    await waitError("unlock");
    assert.match(await errorOf("unlock"), expected);
    assert.equal(await visible("[data-signing]"), false);
  }

  // a wrong passphrase says so, and still unlocks nothing
  await fill("[data-unlock-password]", "not the passphrase");
  await setFile("[data-unlock-file]", pemPath);
  await submit("[data-unlock]");
  await until(`document.querySelector('[data-error="unlock"]').textContent.startsWith("Wrong passphrase")`, "the passphrase error");
  assert.equal(await visible("[data-signing]"), false);

  // the passphrase and the DID may both come from the files the Python tool wrote
  await fill("[data-unlock-password]", "");
  await setFile("[data-unlock-file]", pemPath, saveAs("passphrase.txt", `${PEM_PASSPHRASE}\n`), saveAs("did.txt", `${PEM_DID}\n`));
  await submit("[data-unlock]");
  await until("!document.querySelector('[data-panel=room]').hidden", "the room picker");
  assert.equal(await text("[data-signing] code[data-did-value]"), PEM_DID, "the DID is derived from the key in the PEM");
  // opening a file asks nothing of the network
  assert.deepEqual(log.requests.filter((r) => r.url.startsWith("https://technocore.chat/")).map((r) => r.url), []);

  // the same key can also be kept as a Room Census recovery file, and it opens to the same DID
  assert.equal(await hidden("[data-offer]"), false);
  await click("[data-action=offer-open]");
  await fill("[data-offer-pem]", PEM_PASSPHRASE);
  await submit("[data-offer-form]");
  await until("!document.querySelector('[data-offer-done]').hidden", "the saved recovery file");
  const saved = (await downloads()).filter((d) => d.name.startsWith("room-census-did-recovery-"));
  assert.equal(saved.length, 1);
  const reopened = await openBackup(subtle, saved[0].text, PEM_PASSPHRASE);
  assert.equal(reopened.did, PEM_DID, "the recovery file holds the same DID, never a new one");

  // the message is signed by that DID, and the passphrase is nowhere
  await compose(latest.rooms[0].room);
  await publishNow();
  await outcome("published");
  assert.equal(JSON.parse(log.posts.at(-1).postData).did, PEM_DID);
  const seen = await exposure(log);
  assert.ok(!seen.includes(PEM_PASSPHRASE), "the passphrase leaked");
  const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  for (const encoding of ["hex", "base64", "base64url"]) {
    assert.ok(!seen.includes(seed.toString(encoding)), `the private key leaked as ${encoding}`);
  }

  // locking forgets the key and the file: the offer is gone too
  await click("[data-action=lock]");
  assert.equal(await hidden("[data-panel=locked]"), false);
  assert.equal(await hidden("[data-offer]"), true);
});

test("a did.txt that names another DID also stops a .json recovery file", { skip }, async () => {
  await open();
  const identity = await createIdentity(subtle);
  const backup = saveAs("room-census-did-recovery.json", JSON.stringify(await sealBackup(subtle, (n) => new Uint8Array(randomBytes(n)), identity, PASSWORD)));
  await setFile("[data-unlock-file]", backup, saveAs("did.txt", `${PEM_DID}\n`));
  await fill("[data-unlock-password]", PASSWORD);
  await submit("[data-unlock]");
  await waitError("unlock");
  assert.match(await errorOf("unlock"), /did\.txt names a different DID than the recovery file/);
  assert.equal(await visible("[data-signing]"), false);
  // the same file, with the DID it really holds, opens
  await setFile("[data-unlock-file]", backup, saveAs("did.txt", `${identity.did}\n`));
  await fill("[data-unlock-password]", PASSWORD);
  await submit("[data-unlock]");
  await until("!document.querySelector('[data-panel=room]').hidden", "the room picker");
  assert.equal(await text("[data-signing] code[data-did-value]"), identity.did);
});

test("a refusal, a timeout and a redirect are never called published", { skip }, async () => {
  const room = latest.rooms[0].room;
  // a refusal publishes nothing, and the message can be edited and signed again
  let refuse = true;
  const refused = await unlocked((r) => {
    if (r.method !== "POST") return { body: "{}" };
    if (refuse) { refuse = false; return { status: 422, body: "422 duplicate: this text was just posted" }; }
    return { body: stored(r) };
  });
  await compose(room);
  await publishNow();
  await outcome("refused");
  assert.equal(await text("[data-outcome-title]"), "Not published");
  assert.match(await text("[data-outcome-lede]"), /HTTP 422\).*Nothing was published\.$/);
  assert.equal(await visible("[data-action=share]"), false);
  await click("[data-action=edit-refused]");
  await until("!document.querySelector('[data-panel=room]').hidden", "the room picker");
  await compose(room, MESSAGE + " Second try.");
  await publishNow();
  await outcome("published");
  assert.equal(refused.log.posts.length, 2);
  assert.notEqual(JSON.parse(refused.log.posts[0].postData).nonce, JSON.parse(refused.log.posts[1].postData).nonce);

  // a redirect would post the body elsewhere: it is refused, and the result stays unconfirmed
  const redirected = await unlocked((r) => (r.method === "POST"
    ? { status: 307, body: "", headers: [{ name: "location", value: "https://technocore.chat/r/elsewhere?format=json" }] } : { body: "{}" }));
  await compose(room);
  await publishNow();
  await outcome("unconfirmed");
  await sleep(200);
  assert.equal(redirected.log.posts.length, 1, "the redirect was not followed");

  // no answer at all: the page waits, says so, and never sends again
  const held = await unlocked((r) => (r.method === "POST" ? "hold" : { body: "{}" }));
  await compose(room);
  await publishNow();
  await outcome("unconfirmed", 40000);
  assert.match(await text("[data-outcome-lede]"), /did not answer in time/);
  assert.equal(held.log.posts.length, 1);
});

test("sharing in another room asks again and signs again; nothing is broadcast", { skip }, async () => {
  const rooms = latest.rooms.map((r) => r.room);
  const { log } = await unlocked((r) => (r.method === "POST" ? { body: stored(r) } : { body: "{}" }));
  await compose(rooms[0]);
  await publishNow();
  await outcome("published");
  assert.equal(await visible("[data-share-note]"), true);

  await click("[data-action=share]");
  await until("!document.querySelector('[data-panel=room]').hidden", "the room picker again");
  assert.equal(await page("document.querySelector('[data-message]').value"), MESSAGE, "the text is kept");
  assert.equal(await page("document.querySelectorAll('[data-room][aria-pressed=true]').length"), 0, "the room must be chosen again");
  await submit("[data-compose]");
  assert.equal(await errorOf("compose"), "Choose a room from the list.");
  await compose(rooms[1]);
  assert.equal(await text("[data-review-room]"), rooms[1]);
  assert.equal(await page("document.querySelector('[data-action=publish]').disabled"), true, "another confirmation is needed");
  await publishNow();
  await outcome("published");
  assert.equal(log.posts.length, 2, "one message per room, never a broadcast");
  const [a, b] = log.posts.map((p) => JSON.parse(p.postData));
  assert.notEqual(a.nonce, b.nonce, "a new nonce");
  assert.notEqual(a.sig, b.sig, "a new signature");
  assert.equal(a.text, b.text);
  assert.deepEqual(log.posts.map((p) => new URL(p.url).pathname), [`/r/${rooms[0]}`, `/r/${rooms[1]}`]);
});

test("an unclear answer is never called published and is never resent", { skip }, async () => {
  const room = latest.rooms[0].room;
  const { log } = await unlocked((r) => (r.method === "POST" ? { body: JSON.stringify({ room, messages: [] }) } : { body: JSON.stringify({ room, messages: [] }) }));
  await compose(room);
  await publishNow();
  await outcome("unconfirmed");
  assert.match(await text("[data-outcome-lede]"), /may already be public; it will not be sent again/);
  assert.equal(await visible("[data-action=share]"), false);
  assert.equal(await visible("[data-action=another]"), false);
  await click("[data-action=look]");
  await until("document.querySelector('[data-outcome-foot]').textContent.startsWith('Not found')", "the look");
  assert.equal(log.posts.length, 1, "looking reads, it never sends again");
});

test("Write is reachable from the navigation, under My DID, and stays closed inside a frame", { skip }, async () => {
  await open();
  const nav = await page(`[...document.querySelectorAll('nav[aria-label=Primary] a')].map(a => a.textContent.trim())`);
  assert.deepEqual(nav.slice(3, 5), ["My DID", "Write"]);
  assert.equal(await page(`document.querySelector('nav[aria-label=Primary] a[href="/write/"]').getAttribute("aria-current")`), "page");
  const state = await page(`(async () => {
    const f = document.createElement("iframe");
    f.src = "/write/";
    document.body.append(f);
    await new Promise((r) => f.addEventListener("load", r, { once: true }));
    await new Promise((r) => setTimeout(r, 500));
    const d = f.contentDocument;
    return { page: d.querySelector("[data-write]").hidden, framed: d.querySelector("[data-framed]").hidden };
  })()`);
  assert.deepEqual(state, { page: true, framed: false });
});

test("a handed-over DID fills My DID but never starts a lookup by itself", { skip }, async () => {
  const identity = await createIdentity(subtle);
  const log = await open(() => ({ body: JSON.stringify({ room: "x", messages: [] }) }), `/look-up/#did=${identity.did}`);
  await until("document.getElementById('did-input').value !== ''", "the filled field");
  assert.equal(await page("document.getElementById('did-input').value"), identity.did);
  assert.equal(await page("location.hash"), "", "the fragment is removed once read");
  assert.equal(await page("document.activeElement.id"), "did-input");
  assert.match(await text("[data-did-handed]"), /^This DID came from the page you arrived from\./);
  // a link can never make this browser read the rooms on its own
  await sleep(1500);
  assert.equal(log.requests.filter((r) => r.url.startsWith("https://technocore.chat/")).length, 0);
  assert.equal(await hidden("[data-did-result]"), true);
  // the reader starts it
  await submit("form[data-did-form]");
  await until("!document.querySelector('[data-did-proof]').hidden", "the lookup to finish", 30000);
  assert.equal(await text("[data-did-heading]"), "Not found in the inspected data");
  assert.ok(log.requests.filter((r) => r.url.startsWith("https://technocore.chat/")).length > 0);
});

test("a room page can hand over its room, and only a room this page carries", { skip }, async () => {
  const room = latest.rooms[0].room;
  const identity = await createIdentity(subtle);
  // the room comes from the address, the page checks it against its own list, then cleans the address
  const log = await open((r) => (r.method === "POST" ? { body: stored(r) } : { body: "{}" }), `/write/?room=${room}`);
  assert.equal(await page("location.search"), "", "the address is cleaned once read");
  assert.equal(await hidden("[data-panel=room]"), true, "nothing is chosen before the DID is open");
  await setFile("[data-unlock-file]", await backupFile(identity));
  await fill("[data-unlock-password]", PASSWORD);
  await submit("[data-unlock]");
  await until("!document.querySelector('[data-panel=room]').hidden", "the room picker");
  assert.equal(await page(`document.querySelector('[data-room="${room}"]').getAttribute("aria-pressed")`), "true", "the handed room is chosen");
  // and it is a choice, not a publication: the review still has to be asked for
  assert.equal(await hidden("[data-panel=review]"), true);
  assert.deepEqual(log.posts, []);

  // a room this page does not carry is ignored, and nothing is chosen
  await open(() => ({ body: "{}" }), "/write/?room=not-a-measured-room");
  await setFile("[data-unlock-file]", await backupFile(identity));
  await fill("[data-unlock-password]", PASSWORD);
  await submit("[data-unlock]");
  await until("!document.querySelector('[data-panel=room]').hidden", "the room picker");
  assert.equal(await page(`[...document.querySelectorAll('[data-room]')].some(b => b.getAttribute("aria-pressed") === "true")`), false);
  await fill("[data-message]", MESSAGE);
  await submit("[data-compose]");
  assert.equal(await errorOf("compose"), "Choose a room from the list.");
});
