// The My DID identity wizard, as shipped, in a real headless browser. Every Technocore request is
// answered by the test (no network, never a real publication). Downloads are caught in the page.
// The primary flow under test (Ben, 2026-09-23): Create DID -> save the encrypted recovery file, with
// a download the reader asks for -> Write a message -> Publish -> Message published, with "View in My
// DID" and "Write another message". The tests also prove: creating, sealing, downloading and restoring make zero requests; no
// receipt is forced on the reader; a message is published only after a review and a confirmation, at
// most once; and no secret appears in any request, console line, storage, the page's HTML, an error
// message or an offered file.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, promises as fs, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

import { check, publicKey, readReply } from "../../src/lib/did-core.mjs";
import { backupHeader, createIdentity, sealBackup } from "../../src/lib/did-wallet.mjs";
import { listeners, navigate, page, send, skip, sleep, start, stop, until, WEB } from "./harness.mjs";

const subtle = globalThis.crypto.subtle;
const PASSWORD = "correct horse battery staple";
const MESSAGE = "I am building a room map to help newcomers find active rooms. I would appreciate feedback on the layout.";
const files = mkdtempSync(join(tmpdir(), "rc-backups-"));
let fileNo = 0;
const saveFile = (text) => { const p = join(files, `backup-${++fileNo}.json`); writeFileSync(p, text); return p; };
const saveAs = (name, text) => { const dir = mkdtempSync(join(files, "sel-")); const p = join(dir, name); writeFileSync(p, text); return p; };
// the identity.pem the Python tool writes, with the DID it prints for that same key
const PEM_TEXT = readFileSync(resolve(WEB, "tests", "fixtures", "identity-test-key.pem.txt"), "utf8");
const PEM_PASSPHRASE = "correct horse battery staple";
const PEM_DID = "did:key:z6MkehRgf7yJbgaGfYsdoAsKdBPE3dj2CYhowQdcjqSJgvVd";

// in the page: keep each download (blob and name) instead of saving it; the page code is untouched
const CATCH_DOWNLOADS = `
  window.__downloads = []; window.__blobs = {};
  const create = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { const u = create(b); window.__blobs[u] = b; return u; };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.href.startsWith("blob:") && window.__blobs[this.href]) { window.__downloads.push({ name: this.download, blob: window.__blobs[this.href] }); return; }
    return click.call(this);
  };`;

/** Opens /did/ with Technocore answered by `technocore(request)`; returns a log of everything seen. */
async function open(technocore = () => ({ body: JSON.stringify({ room: "x", messages: [] }) })) {
  const log = { requests: [], posts: [], console: [] };
  listeners.clear();
  listeners.add(async (msg) => {
    if (msg.method === "Network.requestWillBeSent") log.requests.push(msg.params.request);
    if (msg.method === "Runtime.consoleAPICalled") log.console.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    if (msg.method === "Runtime.exceptionThrown") log.console.push(JSON.stringify(msg.params.exceptionDetails));
    if (msg.method === "Log.entryAdded") log.console.push(msg.params.entry.text);
    if (msg.method !== "Fetch.requestPaused") return;
    const { requestId, request } = msg.params;
    if (request.method === "OPTIONS") {
      // the CORS preflight, answered with the headers technocore.chat sends (checked on 2026-09-23)
      await send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [
        { name: "access-control-allow-origin", value: "*" }, { name: "access-control-allow-methods", value: "GET, POST" },
        { name: "access-control-allow-headers", value: "Accept, Accept-Language, Content-Language, Content-Type" },
        { name: "access-control-max-age", value: "600" }] }).catch(() => {});
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
  await navigate("/did/");
  await until("!document.querySelector('[data-wizard]').hidden", "the wizard");
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  log.loaded = log.requests.length;
  return log;
}

const q = (sel) => JSON.stringify(sel);
const text = (sel) => page(`document.querySelector(${q(sel)})?.textContent.trim() ?? null`);
const hidden = (sel) => page(`document.querySelector(${q(sel)}).hidden`);
const visible = (sel) => page(`(() => { const e = document.querySelector(${q(sel)}); return !!e && !e.closest("[hidden]"); })()`);
const click = (sel) => page(`document.querySelector(${q(sel)}).click()`);
const fill = (sel, value) => page(`(() => { const e = document.querySelector(${q(sel)}); e.value = ${q(value)}; e.dispatchEvent(new Event("input", { bubbles: true })); })()`);
const submit = (sel) => page(`document.querySelector(${q(sel)}).requestSubmit()`);
const step = () => page("(() => { const li = document.querySelector('[aria-current=step]'); return li ? `${Number(li.dataset.step) + 1}. ${li.dataset.stepLabel}` : null; })()");
const downloads = () => page("Promise.all(window.__downloads.map(async (d) => ({ name: d.name, text: await d.blob.text() })))");
const unloadWarns = () => page("(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })()");
const outcome = (kind) => until(`document.querySelector('[data-panel=outcome]').dataset.outcome === '${kind}' && !document.querySelector('[data-panel=outcome]').hidden`, `the ${kind} outcome`);
async function setFile(selector, ...paths) {
  const { root } = await send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector });
  await send("DOM.setFileInputFiles", { nodeId, files: paths });
}
const errorOf = (name) => text(`[data-error="${name}"]`);
const waitError = (name) => until(`document.querySelector('[data-error="${name}"]').textContent !== ''`, `the ${name} error`);

// SHOTS_DIR=<folder> saves a screenshot of chosen screens, for review; nothing otherwise
async function shot(name) {
  if (!process.env.SHOTS_DIR) return;
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const h = await page("document.documentElement.scrollHeight");
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1440, height: h, scale: 1 } });
  writeFileSync(join(process.env.SHOTS_DIR, `${name}.png`), Buffer.from(data, "base64"));
}

/** The secret bytes inside a recovery file, recovered here the way anyone holding the password would. */
async function secretsOf(backup) {
  const b = JSON.parse(backup);
  const base = await subtle.importKey("raw", new TextEncoder().encode(PASSWORD), "PBKDF2", false, ["deriveKey"]);
  const key = await subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: Buffer.from(b.kdf.salt, "base64url"), iterations: b.kdf.iterations },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const pkcs8 = Buffer.from(await subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(b.cipher.iv, "base64url"),
    additionalData: new TextEncoder().encode(backupHeader(b)) }, key, Buffer.from(b.ciphertext, "base64url")));
  return [pkcs8.subarray(16), pkcs8].flatMap((x) => [x.toString("hex"), x.toString("base64"), x.toString("base64url")]).concat(PASSWORD);
}

/** Everything a secret could leak into: requests, console, storage, the page's HTML and every offered file but the sealed one. */
async function exposure(log) {
  const inPage = await page(`(async () => JSON.stringify({
    html: document.documentElement.outerHTML, url: location.href, cookie: document.cookie,
    local: { ...localStorage }, session: { ...sessionStorage },
    databases: (await (indexedDB.databases?.() ?? Promise.resolve([]))).map((d) => d.name),
    caches: typeof caches === "undefined" ? [] : await caches.keys(),
    fields: [...document.querySelectorAll("input")].map((i) => i.value),
  }))()`);
  const offered = (await downloads()).filter((d) => !d.name.startsWith("room-census-did-recovery-")).map((d) => d.text);
  return [inPage, JSON.stringify(log.requests.map((r) => [r.url, r.postData ?? ""])), log.console.join("\n"), ...offered].join("\n");
}

const backupFile = async (identity) => saveFile(JSON.stringify(await sealBackup(subtle, (n) => new Uint8Array(randomBytes(n)), identity, PASSWORD)));

/** A Technocore reply that stores the posted message as #42, exact nonce as a JSON number. */
const stored = (post, seq = 42) => {
  const m = JSON.parse(post.postData);
  return JSON.stringify({ room: "lobby", count: 1, first_seq: seq, last_seq: seq,
    messages: [{ seq, ts: "2026-09-23T20:00:00.123456Z", from: m.did, text: m.text, nonce: m.nonce, sig: m.sig }] })
    .replace(/"nonce":"(\d+)"/, '"nonce":$1');
};

/** Picks a room in the shared picker, writes the message and opens the review. */
async function compose(message = MESSAGE, room = "lobby") {
  await fill("[data-room-search]", room);
  await until(`[...document.querySelectorAll('[data-room]')].some(b => b.dataset.room === ${JSON.stringify(room)})`, `the room ${room}`);
  await click(`[data-room="${room}"]`);
  await fill("[data-message]", message);
  await submit("[data-compose]");
  await until("!document.querySelector('[data-preview]').hidden", "the review", 5000);
}
async function publishNow() {
  await click("[data-understand]");
  await click("[data-action=publish]");
}

/** A later visit: the recovery file is opened once, and the composer comes straight after. */
async function restored(technocore) {
  const log = await open(technocore);
  await click("[data-action=begin-restore]");
  const identity = await createIdentity(subtle);
  await setFile("[data-restore-file]", await backupFile(identity));
  await fill("[data-restore-password]", PASSWORD);
  await submit("[data-restore]");
  await until("!document.querySelector('[data-panel=message]').hidden", "the composer");
  return { did: identity.did, log };
}

before(start);
after(async () => { await stop(); rmSync(files, { recursive: true, force: true }); });

test("the happy path: create, save the recovery file once, write, publish, and see a simple success", { skip }, async () => {
  let n = 0;
  const log = await open((r) => (r.method === "POST" ? { body: stored(r, 42 + n++) } : { body: JSON.stringify({ room: "x", messages: [] }) }));
  assert.equal(await hidden("[data-stepper]"), true, "the landing has no steps, as the mockup");
  await click("[data-action=begin]");
  assert.equal(await step(), "1. Create");

  // create: a double click makes one DID
  await page("document.querySelector('[data-action=create]').click(); document.querySelector('[data-action=create]').click();");
  await until("!document.querySelector('[data-panel=protect]').hidden", "the protect step");
  const did = await text("[data-panel=protect] [data-did-value]");
  assert.match(did, /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/);
  assert.equal(await step(), "2. Protect");
  assert.equal(await page("document.activeElement.id"), "protect-title", "focus moves to the new step");
  assert.equal(await unloadWarns(), true, "leaving before the recovery file is saved warns");

  // protect: one passphrase, then the recovery file is prepared
  await fill("[data-seal-password]", "short");
  await fill("[data-seal-confirm]", "short");
  await submit("[data-seal]");
  assert.equal(await errorOf("seal"), "Use at least 12 characters.");
  await fill("[data-seal-password]", PASSWORD);
  await fill("[data-seal-confirm]", PASSWORD + "!");
  await submit("[data-seal]");
  assert.equal(await errorOf("seal"), "The two passwords are not the same.");
  await fill("[data-seal-confirm]", PASSWORD);
  await page("document.querySelector('[data-seal]').requestSubmit(); document.querySelector('[data-seal]').requestSubmit();");

  // save: nothing moves on until the reader asks for the download and says they kept it
  await until("!document.querySelector('[data-panel=save]').hidden", "the save step");
  assert.equal(await step(), "2. Protect");
  assert.equal(await unloadWarns(), true, "the DID is still only in this tab");
  assert.equal((await downloads()).length, 0, "the file is never downloaded on its own");
  assert.equal(await hidden("[data-after-download]"), true);
  assert.match(await text("[data-file-name]"), /^room-census-did-recovery-[1-9A-HJ-NP-Za-km-z]{8}-\d{4}-\d{2}-\d{2}-\d{6}\.json$/);
  // a click on Continue before the download does nothing
  await click("[data-action=continue]");
  assert.equal(await hidden("[data-panel=save]"), false);
  await click("[data-action=download-backup]");
  const saved = await downloads();
  assert.equal(saved.length, 1, "one download, and only when asked");
  assert.equal(saved[0].name, await text("[data-file-name]"));
  assert.equal(JSON.parse(saved[0].text).did, did);
  assert.equal(await hidden("[data-after-download]"), false);
  assert.equal(await text("[data-download-label]"), "Download it again");
  // the file is saved, but the reader must still say so
  assert.equal(await page("document.querySelector('[data-action=continue]').disabled"), true);
  await click("[data-action=continue]");
  assert.equal(await hidden("[data-panel=save]"), false, "Continue stays closed until the box is ticked");
  // even with the button forced open, the tick is still required
  await page("document.querySelector('[data-action=continue]').disabled = false");
  await click("[data-action=continue]");
  assert.equal(await hidden("[data-panel=save]"), false, "the tick itself is the gate");
  assert.equal(await unloadWarns(), true);
  // a second download is allowed, and locking here says what is at stake
  await click("[data-action=download-backup]");
  assert.equal((await downloads()).length, 2, "the file can be downloaded again");
  await click("[data-action=start-over]");
  assert.match(await text("[data-confirm-over-text]"), /^Lock and forget this DID\? You downloaded its recovery file but did not confirm keeping it/);
  await click("[data-action=over-no]");
  await click("[data-saved-check]");
  await click("[data-action=continue]");

  // write: straight to the composer, never an import of the file just saved
  await until("!document.querySelector('[data-panel=message]').hidden", "the composer");
  assert.equal(await step(), "3. Write");
  assert.equal(await text("[data-message-title]"), "Publish your first message");
  assert.match(await text("[data-saved-note]"), /Keep it and the passphrase in two separate safe places/);
  assert.equal(await page("document.querySelectorAll('input[type=file]').length"), 1, "only the restore card has a file field");
  assert.equal(await visible("[data-restore-file]"), false);
  assert.equal(await unloadWarns(), false);
  assert.equal(log.requests.length, log.loaded, "creating, sealing and downloading made no request");

  // the introduction is proposed, in the community room, which is open
  assert.equal(await page("document.querySelector('[data-message]').value"), "I created my Technocore identity with Room Census. I am interested in [topic], and I plan to contribute by [contribution].");
  assert.match(await text("[data-proposed]"), /room-census-community/);
  assert.match(await text("[data-proposed]"), /Open since \d{4}-\d{2}-\d{2}/);
  assert.doesNotMatch(await text("[data-proposed]"), /Not created yet|coming soon|does not exist/);
  assert.equal(await page(`[...document.querySelectorAll('[data-room]')].some(b => b.dataset.room === "room-census-community")`), true, "the community room is offered");
  assert.equal(await page(`[...document.querySelectorAll('[data-room]')].some(b => b.dataset.room === "room-census")`), false, "the census room is never offered");
  // the community room comes already chosen, and the placeholders still have to be replaced
  await submit("[data-compose]");
  assert.equal(await errorOf("compose"), "Replace every part in [brackets] with your own words.");
  await fill("[data-room-search]", "lobby");
  await until(`[...document.querySelectorAll('[data-room]')].some(b => b.dataset.room === "lobby")`, "the lobby row");
  await click(`[data-room="lobby"]`);
  await submit("[data-compose]");
  assert.equal(await errorOf("compose"), "Replace every part in [brackets] with your own words.");
  assert.match(await text("[data-panel=message]"), /Tip from Coin Academy \(third-party guidance, not an official Flop Labs rule\)/);

  // review: the exact public message; nothing is sent before the confirmation, and edits withdraw it
  await compose(MESSAGE + "\n");
  assert.equal(await text("[data-preview-text]"), MESSAGE, "the review shows the exact stored text");
  assert.equal(await text("[data-preview-room]"), "lobby");
  assert.equal(await text("[data-preview-did]"), did);
  assert.equal(await page("document.querySelector('[data-action=publish]').disabled"), true);
  await click("[data-action=publish]");
  await fill("[data-message]", MESSAGE + " Edited.");
  assert.equal(await hidden("[data-preview]"), true);
  await compose(MESSAGE);
  assert.equal(await text("[data-action=publish]"), "Publish message");
  assert.equal(log.posts.length, 0, "nothing was sent before the confirmation");

  // publish: a double click sends once
  await click("[data-understand]");
  await page("document.querySelector('[data-action=publish]').click(); document.querySelector('[data-action=publish]').click();");
  await outcome("published");
  await click("[data-action=publish]");
  await sleep(300);
  assert.equal(log.posts.length, 1);
  const body = JSON.parse(log.posts[0].postData);
  assert.equal(log.posts[0].url, "https://technocore.chat/r/lobby?format=json");
  assert.deepEqual(Object.keys(body).sort(), ["did", "nonce", "sig", "text"]);
  assert.deepEqual([body.did, body.text], [did, MESSAGE]);
  const key = await subtle.importKey("raw", publicKey(did), { name: "Ed25519" }, false, ["verify"]);
  assert.equal(await check(subtle, key, did, "lobby", { from: did, ...body }), "checked", "the exact Technocore payload is signed");

  // the success screen: simple, and no file forced on the reader
  assert.equal(await text("[data-outcome-title]"), "Message published");
  assert.equal(await text("[data-panel=outcome] [data-did-value]"), did);
  assert.equal(await text("[data-out-room]"), "lobby");
  assert.equal(await visible("[data-action=view]"), true);
  assert.equal(await visible("[data-action=another]"), true);
  assert.equal(await step(), "4. Publish");
  assert.equal(await page("document.querySelector('[data-advanced]').open"), false, "technical details stay folded");
  assert.equal((await downloads()).length, 2, "no receipt was downloaded: only the recovery files the reader asked for");
  await shot("did-5-published-1440");

  // the optional technical receipt, inside Advanced
  await page("document.querySelector('[data-advanced]').open = true");
  assert.match(await text("[data-out-stored]"), /^#42, 23 Sep 2026, 20:00 UTC$/);
  await click("[data-action=download-proof]");
  const receipt = (await downloads()).find((d) => d.name.startsWith("room-census-technical-receipt-"));
  const proof = JSON.parse(receipt.text);
  assert.deepEqual([proof.outcome, proof.room, proof.nonce, proof.text, proof.sig, proof.seq], ["published", "lobby", body.nonce, MESSAGE, body.sig, 42]);
  assert.equal(readReply(proof.server_reply)[0].nonce, body.nonce, "the complete server reply is kept");

  // write another: no passphrase again, a new signature
  await click("[data-action=another]");
  assert.equal(await text("[data-message-title]"), "Publish another message");
  assert.equal(await visible("[data-seal-password]"), false);
  await compose(MESSAGE + " Second message.");
  await publishNow();
  await outcome("published");
  assert.equal(log.posts.length, 2);
  assert.notEqual(JSON.parse(log.posts[1].postData).nonce, body.nonce);

  // View in My DID: the lookup gets the public DID, which never goes into a request or the URL
  await click("[data-action=view]");
  await until("!document.querySelector('[data-did-proof]').hidden", "the lookup to finish");
  assert.equal(await page("document.getElementById('did-input').value"), did);
  assert.equal(await page("location.hash + location.search"), "");
  for (const r of log.requests.filter((x) => x.method === "GET")) {
    assert.ok(!r.url.includes("z6Mk") && !/did(:|%3A)key/i.test(r.url), `the DID left the browser: ${r.url}`);
  }

  const haystack = await exposure(log);
  for (const secret of await secretsOf(saved[0].text)) assert.ok(!haystack.includes(secret), "a secret leaked");
});

test("a later visit opens the recovery file once, safely, and goes straight to the composer", { skip }, async () => {
  const log = await open();
  await click("[data-action=begin-restore]");
  const identity = await createIdentity(subtle);
  const good = JSON.parse(await fs.readFile(await backupFile(identity), "utf8"));
  const flip = (s) => (s[5] === "A" ? `${s.slice(0, 5)}B${s.slice(6)}` : `${s.slice(0, 5)}A${s.slice(6)}`);
  const forged = await sealBackup(subtle, (n) => new Uint8Array(randomBytes(n)), { did: identity.did, pkcs8: (await createIdentity(subtle)).pkcs8 }, PASSWORD);
  const cases = [
    [JSON.stringify(good), "wrong password here", "Wrong password, or the file was changed."],
    [JSON.stringify({ ...good, ciphertext: flip(good.ciphertext) }), PASSWORD, "Wrong password, or the file was changed."],
    [JSON.stringify({ ...good, created_at: "2020-01-01T00:00:00.000Z" }), PASSWORD, "Wrong password, or the file was changed."],
    ["{ not json", PASSWORD, "This is not a Room Census DID backup file."],
    [JSON.stringify({ ...good, kdf: { ...good.kdf, iterations: 1 } }), PASSWORD, "This is not a Room Census DID backup file, or it is damaged."],
    [JSON.stringify({ ...good, schema: "room-census-did-backup/2" }), PASSWORD, "This backup comes from a newer version of this page, which this one cannot open."],
    [JSON.stringify(forged), PASSWORD, "The key in this backup does not match its DID."],
  ];
  for (const [file, password, message] of cases) {
    await page("document.querySelector('[data-error=restore]').textContent = ''");
    await setFile("[data-restore-file]", saveFile(file));
    await fill("[data-restore-password]", password);
    await submit("[data-restore]");
    await waitError("restore");
    assert.equal(await errorOf("restore"), message);
    assert.equal(await hidden("[data-panel=message]"), true);
  }
  await setFile("[data-restore-file]", saveFile(JSON.stringify(good)));
  await fill("[data-restore-password]", PASSWORD);
  await submit("[data-restore]");
  await until("!document.querySelector('[data-panel=message]').hidden", "the composer");
  assert.equal(await page("document.querySelector('[data-restore-password]').value"), "");
  assert.equal(await text("[data-page-title]"), "My DID", "a restored DID keeps the My DID title");
  assert.equal(await hidden("[data-saved-note]"), true);
  assert.equal(log.requests.length, log.loaded, "restoring made no request");
  await compose();
  assert.equal(await text("[data-preview-did]"), identity.did, "the same DID signs");
  const haystack = await exposure(log);
  for (const secret of await secretsOf(JSON.stringify(good))) assert.ok(!haystack.includes(secret), "a secret leaked");
});

test("an unclear answer is never called published, is never resent, and forces no file on the reader", { skip }, async () => {
  let found = false;
  let posted = null;
  const { log } = await restored((r) => {
    if (r.method === "POST") { posted = r; return { body: JSON.stringify({ room: "lobby", messages: [] }) }; }
    return { body: found ? stored(posted) : JSON.stringify({ room: "lobby", messages: [] }) };
  });
  await compose();
  await publishNow();
  await outcome("unconfirmed");
  assert.equal(await text("[data-outcome-title]"), "Publication could not be confirmed");
  assert.match(await text("[data-outcome-lede]"), /may already be public; it will not be sent again/);
  assert.equal(await visible("[data-action=look]"), true);
  assert.equal(await visible("[data-action=another]"), false, "no new message while this one is unclear");
  assert.equal((await downloads()).length, 0, "no file is forced on the reader");
  assert.equal(await unloadWarns(), true);
  await shot("did-6-unconfirmed-1440");
  await click("[data-action=publish]");
  await click("[data-action=look]");
  await until("document.querySelector('[data-outcome-foot]').textContent.startsWith('Not found')", "the first look");
  found = true;
  await click("[data-action=look]");
  await outcome("published");
  assert.equal(log.posts.length, 1, "looking for it reads, it never sends again");

  for (const technocore of [
    (r) => (r.method === "POST" ? "fail" : { body: "{}" }),
    (r) => (r.method === "POST" ? { status: 500, body: "oops" } : { body: "{}" }),
    (r) => (r.method === "POST" ? { status: 307, body: "", headers: [{ name: "location", value: "https://technocore.chat/r/lobby-elsewhere?format=json" }] } : { body: "{}" }),
  ]) {
    const again = await restored(technocore);
    await compose();
    await publishNow();
    await outcome("unconfirmed");
    await sleep(200);
    assert.equal(again.log.posts.length, 1, "no redirect followed, no retry");
  }
  // locking now warns that the last message may already be public
  await click("[data-action=start-over]");
  assert.match(await text("[data-confirm-over-text]"), /could not be confirmed and may already be public/);
});

test("after a refusal the message can be changed and signed again", { skip }, async () => {
  let refuse = true;
  const { log } = await restored((r) => {
    if (r.method !== "POST") return { body: "{}" };
    if (refuse) { refuse = false; return { status: 422, body: "422 duplicate: this text was just posted\nmore" }; }
    return { body: stored(r) };
  });
  await compose();
  await publishNow();
  await outcome("refused");
  assert.equal(await text("[data-outcome-title]"), "Not published");
  assert.match(await text("[data-outcome-lede]"), /HTTP 422\): 422 duplicate: this text was just posted\. Nothing was published\.$/);
  await click("[data-action=edit]");
  assert.equal(await hidden("[data-panel=message]"), false);
  assert.equal(await page("document.querySelector('[data-message]').value"), MESSAGE, "the text is kept for editing");
  await compose(MESSAGE + " Second try.");
  await publishNow();
  await outcome("published");
  assert.equal(log.posts.length, 2);
  assert.notEqual(JSON.parse(log.posts[0].postData).nonce, JSON.parse(log.posts[1].postData).nonce, "a new signature, a new nonce");
});

test("Lock my DID forgets the unlocked key; publishing again needs the recovery file", { skip }, async () => {
  const { log } = await restored((r) => (r.method === "POST" ? { body: stored(r) } : { body: "{}" }));
  await compose();
  await publishNow();
  await outcome("published");
  await click("[data-action=start-over]");
  assert.equal(await text("[data-confirm-over-text]"), "Lock and forget your DID in this tab? To publish again, open your recovery file.");
  await click("[data-action=over-yes]");
  assert.equal(await hidden("[data-panel=start]"), false);
  assert.equal(await hidden("[data-action=start-over]"), true);
  assert.equal(await page("[...document.querySelectorAll('[data-did-value]')].map(e => e.textContent).join('')"), "");
  // the composer cannot sign once the key is forgotten
  await page("document.querySelector('[data-panel=message]').hidden = false");
  await fill("[data-room-search]", "lobby");
  await click(`[data-room="lobby"]`);
  await fill("[data-message]", MESSAGE);
  await submit("[data-compose]");
  await sleep(300);
  assert.equal(await hidden("[data-preview]"), true, "nothing can be signed once locked");
  assert.match(await errorOf("compose"), /no longer unlocked in this tab/);
  assert.equal(log.posts.length, 1);
});

test("locking from the save step drops the file and starts the next DID clean", { skip }, async () => {
  const log = await open();
  await click("[data-action=begin]");
  await click("[data-action=create]");
  await until("!document.querySelector('[data-panel=protect]').hidden", "the protect step");
  await fill("[data-seal-password]", PASSWORD);
  await fill("[data-seal-confirm]", PASSWORD);
  await submit("[data-seal]");
  await until("!document.querySelector('[data-panel=save]').hidden", "the save step");
  const first = await text("[data-file-name]");
  await click("[data-action=download-backup]");
  await click("[data-saved-check]");
  await click("[data-action=start-over]");
  await click("[data-action=over-yes]");
  assert.equal(await hidden("[data-panel=start]"), false);

  // a second DID starts from a clean save step: nothing downloaded, nothing ticked
  await click("[data-action=begin]");
  await click("[data-action=create]");
  await until("!document.querySelector('[data-panel=protect]').hidden", "the protect step again");
  await fill("[data-seal-password]", PASSWORD);
  await fill("[data-seal-confirm]", PASSWORD);
  await submit("[data-seal]");
  await until("!document.querySelector('[data-panel=save]').hidden", "the save step again");
  assert.notEqual(await text("[data-file-name]"), first, "a new DID, a new file");
  assert.equal(await hidden("[data-after-download]"), true);
  assert.equal(await page("document.querySelector('[data-saved-check]').checked"), false);
  assert.equal(await page("document.querySelector('[data-action=continue]').disabled"), true);
  assert.equal(await text("[data-download-label]"), "Download recovery file");
  assert.equal((await downloads()).length, 1, "the first file, and no second one on its own");
  assert.equal(log.requests.length, log.loaded, "none of this made a request");
});

test("inside another site's frame the wizard stays closed", { skip }, async () => {
  await open();
  await navigate("/watched/");
  const state = await page(`(async () => {
    const f = document.createElement("iframe");
    f.src = "/did/";
    document.body.append(f);
    await new Promise((r) => f.addEventListener("load", r, { once: true }));
    await new Promise((r) => setTimeout(r, 500));
    const d = f.contentDocument;
    return { wizard: d.querySelector("[data-wizard]").hidden, framed: d.querySelector("[data-framed]").hidden };
  })()`);
  assert.deepEqual(state, { wizard: true, framed: false });
});

test("My DID opens an identity.pem too, and says plainly what never leaves the device", { skip }, async () => {
  const log = await open();
  // the two lists are separate, and the private key is only ever in the second one
  const seen = await page("document.querySelector('[data-sees]').innerText");
  const [, publicPart, keptPart] = seen.split(/Public on Technocore|Never sent to Room Census or to Technocore/);
  assert.match(publicPart, /Your public DID/);
  assert.match(publicPart, /The messages you choose to publish/);
  assert.doesNotMatch(publicPart, /private key/i);
  for (const kept of ["Your private key", "Your passphrase", "Your recovery files"]) assert.match(keptPart, new RegExp(kept));
  assert.match(seen, /Your private key exists decrypted only in this tab's memory while the DID is unlocked\. It never leaves your device\./);

  // the same entry point takes the other local backup format, with its two optional files
  await click("[data-action=begin-restore]");
  await setFile("[data-restore-file]", saveAs("identity.pem", PEM_TEXT), saveAs("passphrase.txt", `${PEM_PASSPHRASE}
`), saveAs("did.txt", `${PEM_DID}
`));
  await submit("[data-restore]");
  await until("!document.querySelector('[data-panel=message]').hidden", "the composer");
  assert.equal(log.requests.length, log.loaded, "opening a DID made no request");
  await compose();
  assert.equal(await text("[data-preview-did]"), PEM_DID, "the DID comes from the key in the PEM");
  const haystack = await exposure(log);
  assert.ok(!haystack.includes(PEM_PASSPHRASE), "the passphrase leaked");

  // and it refuses the same selections the Write page refuses
  await click("[data-action=start-over]");
  await click("[data-action=over-yes]");
  await until("!document.querySelector('[data-panel=start]').hidden", "the landing");
  await click("[data-action=begin-restore]");
  for (const [paths, expected] of [
    [[saveAs("identity.pem", PEM_TEXT), saveAs("did.txt", "hello")], /did\.txt does not hold one did:key value/],
    [[saveAs("identity.pem", PEM_TEXT), saveAs("notes.md", "x")], /does not know what to do with notes\.md/],
  ]) {
    await setFile("[data-restore-file]", ...paths);
    await fill("[data-restore-password]", PEM_PASSPHRASE);
    await submit("[data-restore]");
    await waitError("restore");
    assert.match(await errorOf("restore"), expected);
    assert.equal(await hidden("[data-panel=message]"), true);
  }
});
