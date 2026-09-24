// The live room on a room page, as shipped, in a real headless browser. Every Technocore request is
// answered by the test: nothing is ever read from, or published to, the real server. What is proven:
// a message from the room can never become markup or a link, nothing can be written without a key
// opened on the device, sending goes out once with a signature the room can check, and locking or
// leaving the page forgets the key.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { check, publicKey } from "../../src/lib/did-core.mjs";
import { createIdentity, nextNonce, sealBackup, signMessage } from "../../src/lib/did-wallet.mjs";
import { DIST, listeners, navigate, page, send, skip, sleep, start, stop, until } from "./harness.mjs";

const subtle = globalThis.crypto.subtle;
const PASSWORD = "correct horse battery staple";
const files = mkdtempSync(join(tmpdir(), "rc-chat-"));
let fileNo = 0;
const latest = JSON.parse(readFileSync(join(DIST, "data", "latest.json"), "utf8"));
const ROOM = latest.rooms[0].room;

const q = (sel) => JSON.stringify(sel);
const text = (sel) => page(`document.querySelector(${q(sel)})?.textContent.trim() ?? null`);
const hidden = (sel) => page(`document.querySelector(${q(sel)}).hidden`);
const click = (sel) => page(`document.querySelector(${q(sel)}).click()`);
const fill = (sel, value) => page(`(() => { const e = document.querySelector(${q(sel)}); e.value = ${q(value)}; e.dispatchEvent(new Event("input", { bubbles: true })); })()`);
const tick = (sel) => page(`(() => { const e = document.querySelector(${q(sel)}); e.checked = true; e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
const submit = (sel) => page(`document.querySelector(${q(sel)}).requestSubmit()`);
const lines = () => page(`[...document.querySelectorAll('[data-chat-list] li')].map(li => li.innerText.replace(/\\s+/g, " ").trim())`);

async function setFile(selector, path) {
  const { root } = await send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector });
  await send("DOM.setFileInputFiles", { nodeId, files: [path] });
}
const backupFile = async (identity) => {
  const p = join(files, `room-census-did-recovery-${++fileNo}.json`);
  writeFileSync(p, JSON.stringify(await sealBackup(subtle, (n) => new Uint8Array(randomBytes(n)), identity, PASSWORD)));
  return p;
};

const reply = (messages) => JSON.stringify({ room: ROOM, count: messages.length, messages });

/** Opens a room page with the room answered by the test. `first` is what a read returns. */
async function open(first, onPost) {
  const log = { requests: [], posts: [], console: [] };
  listeners.clear();
  listeners.add(async (msg) => {
    if (msg.method === "Network.requestWillBeSent") log.requests.push(msg.params.request);
    if (msg.method === "Runtime.consoleAPICalled") log.console.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
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
    let body = reply([]);
    if (request.method === "POST") {
      log.posts.push(request);
      body = onPost ? onPost(request) : reply([]);
    } else if (!request.url.includes("since=")) {
      body = first;
    }
    await send("Fetch.fulfillRequest", { requestId, responseCode: 200,
      responseHeaders: [{ name: "content-type", value: "application/json" }, { name: "access-control-allow-origin", value: "*" }],
      body: Buffer.from(body).toString("base64") }).catch(() => {});
  });
  await send("Runtime.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://technocore.chat/*", requestStage: "Request" }] });
  await navigate(`/rooms/${ROOM}/`);
  await until("!document.querySelector('[data-chat]').hidden", "the live room");
  return log;
}

before(async () => { await start(); });
after(async () => { await stop(); rmSync(files, { recursive: true, force: true }); });

test("the room is read live, a signature is checked here, and a message can never become markup", { skip }, async () => {
  // one message really signed by a DID, and one that claims the same DID with a signature that is not
  const author = await createIdentity(subtle);
  const real = await signMessage(subtle, author, ROOM, nextNonce(), "signed hello");
  const log = await open(reply([
    { seq: 10, from: author.did, ts: "2026-09-24T09:00:00Z", nonce: Number(real.nonce), text: real.text, sig: real.sig },
    { seq: 11, from: "someone", ts: "2026-09-24T09:01:00Z", text: "<img src=x onerror=alert(1)> and https://evil.example/pay" },
    { seq: 12, from: author.did, ts: "2026-09-24T09:02:00Z", nonce: 7, text: "I am that DID, trust me", sig: real.sig },
  ]));
  await until("[...document.querySelectorAll('[data-chat-list] li span[data-checked]')].every(s => s.dataset.checked !== 'pending') && document.querySelectorAll('[data-chat-list] li').length >= 3", "the checked messages");
  const shown = await lines();
  assert.match(shown[0], /signed hello/);
  assert.match(shown[1], /<img src=x onerror=alert\(1\)> and https:\/\/evil\.example\/pay/, "the text is shown exactly as it is");
  // a claim is only a claim until the signature is checked in this browser
  const verdicts = await page("[...document.querySelectorAll('[data-chat-list] span[data-checked]')].map(s => s.dataset.checked)");
  assert.deepEqual(verdicts, ["checked", "none", "bad"]);
  assert.match(shown[2], /\(unverified\)/, "a message that fails its signature says so next to the sender");
  assert.doesNotMatch(shown[1], /unverified/, "a message that claims no signature is not accused of failing one");
  // nothing a message contains becomes an element or a link
  assert.equal(await page("document.querySelectorAll('[data-chat-list] img, [data-chat-list] a, [data-chat-list] script').length"), 0);
  assert.equal(await text("[data-chat-status]"), "live");
  // the page says where this comes from, and nothing was stored
  assert.match(await text("[data-chat]"), /Written by anonymous agents and strangers/);
  // the browser keeps what it kept before, which is the census a room was last seen at, and no message
  const kept = JSON.parse(await page("JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })"));
  assert.deepEqual(Object.keys(kept.session), []);
  assert.ok(Object.keys(kept.local).every((k) => k.startsWith("roomcensus.")), `unexpected storage: ${Object.keys(kept.local)}`);
  const stored = JSON.stringify(kept);
  for (const secret of ["signed hello", "onerror", "evil.example"]) assert.ok(!stored.includes(secret), "a message was stored");
  assert.deepEqual(log.console.filter((l) => /error/i.test(l)), []);

  // the page keeps asking, and never faster than once every two seconds
  const before = log.requests.filter((r) => r.url.includes("since=")).length;
  await sleep(6000);
  const after = log.requests.filter((r) => r.url.includes("since=")).length;
  assert.ok(after > before, "it follows the room");
  assert.ok(after - before <= 4, `it asked ${after - before} times in six seconds`);
});

test("writing needs a key opened here, and a message goes out once, signed", { skip }, async () => {
  const identity = await createIdentity(subtle);
  let seq = 40;
  const log = await open(reply([]), (post) => {
    const m = JSON.parse(post.postData);
    return JSON.stringify({ room: ROOM, count: 1, first_seq: ++seq, last_seq: seq,
      messages: [{ seq, ts: "2026-09-24T09:05:00Z", from: m.did, text: m.text, nonce: Number(m.nonce), sig: m.sig }] });
  });

  // locked: there is no way to type a message at all
  assert.equal(await hidden("[data-chat-locked]"), false);
  assert.equal(await hidden("[data-chat-send]"), true);
  assert.equal(await page("document.querySelector('[data-chat-text]').closest('form').hidden"), true);

  // the box has to be ticked, and the file has to open
  await click("[data-action=chat-open]");
  await setFile("[data-chat-file]", await backupFile(identity));
  await fill("[data-chat-password]", PASSWORD);
  await submit("[data-chat-unlock]");
  await until("document.querySelector('[data-chat-error]').textContent !== ''", "the reminder");
  assert.match(await text("[data-chat-error]"), /public and permanent/);
  assert.equal(await hidden("[data-chat-send]"), true, "nothing opened without the box");

  await tick("[data-chat-understand]");
  await fill("[data-chat-password]", PASSWORD);
  await submit("[data-chat-unlock]");
  await until("!document.querySelector('[data-chat-send]').hidden", "the message field");
  assert.equal(await text("[data-chat-did]"), identity.did);
  assert.equal(await page("document.querySelector('[data-chat-password]').value"), "", "the passphrase is not kept in the page");

  // one message, one request, and a signature the room can check
  await fill("[data-chat-text]", "  Hello from a room page.  ");
  await submit("[data-chat-send]");
  await until("[...document.querySelectorAll('[data-chat-list] li')].some(li => li.innerText.includes('Hello from a room page.'))", "the sent message");
  await sleep(300);
  assert.equal(log.posts.length, 1, "it is sent once");
  const body = JSON.parse(log.posts[0].postData);
  assert.equal(body.did, identity.did);
  assert.equal(body.text, "Hello from a room page.", "what is signed is what Technocore will store");
  assert.match(body.nonce, /^\d{13,19}$/);
  const key = await subtle.importKey("raw", publicKey(identity.did), { name: "Ed25519" }, false, ["verify"]);
  assert.equal(await check(subtle, key, identity.did, ROOM, { from: body.did, nonce: body.nonce, text: body.text, sig: body.sig }), "checked");
  assert.equal(await page("document.querySelector('[data-chat-text]').value"), "", "the field is cleared once it is out");

  // nothing secret is anywhere in the page, and locking forgets the key
  const seen = await page(`JSON.stringify({ html: document.documentElement.outerHTML, url: location.href, local: { ...localStorage }, session: { ...sessionStorage } })`);
  assert.ok(!seen.includes(PASSWORD), "the passphrase leaked");
  await click("[data-action=chat-lock]");
  assert.equal(await hidden("[data-chat-send]"), true);
  assert.equal(await hidden("[data-chat-locked]"), false);
  assert.equal(await text("[data-chat-did]"), "");
});

test("a room that cannot be reached says so, and the page keeps working", { skip }, async () => {
  listeners.clear();
  listeners.add(async (msg) => {
    if (msg.method !== "Fetch.requestPaused") return;
    await send("Fetch.failRequest", { requestId: msg.params.requestId, errorReason: "ConnectionRefused" }).catch(() => {});
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://technocore.chat/*", requestStage: "Request" }] });
  await navigate(`/rooms/${ROOM}/`);
  await until("document.querySelector('[data-chat-status]').textContent !== ''", "the status");
  assert.match(await text("[data-chat-status]"), /could not be reached/);
  assert.equal(await page("document.querySelectorAll('[data-chat-list] li').length"), 0);
  // the rest of the page is untouched: the census figures do not depend on Technocore
  assert.match(await text("h1"), new RegExp(ROOM));
});
