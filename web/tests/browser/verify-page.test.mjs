// The built /verify/ page in a real headless browser. The page hashes the snapshot and the manifest
// the site serves, and checks the signed census message read from the room-census export. Here the
// test answers every read itself (no network) and can alter, refuse, drop or hold them, to prove that
// only a real match is ever shown as a pass, and that "failed" and "could not be checked" stay apart.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { readReply } from "../../src/lib/did-core.mjs";
import { DIST, WEB, listeners, navigate, page, send, site, skip, start, stop, until } from "./harness.mjs";

const latest = JSON.parse(readFileSync(join(DIST, "data", "latest.json"), "utf8"));
const OTHER = "did:key:z6Mkfw79DoBMgePecy4YaXSSimwzHKYz8sB3JB9X7bKSXMkG";
// the real room-census messages, exact nonces kept, one JSONL line each as the export serves them
const census = readReply(readFileSync(join(WEB, "tests", "fixtures", "room-census-reply.json"), "utf8"));
const line = (m) => JSON.stringify(m).replace(/"nonce":"(\d+)"/, '"nonce":$1');
const exportOf = (messages) => messages.map(line).join("\n") + "\n";
const target = census.find((m) => m.nonce === latest.signed_in.nonce);
const others = census.filter((m) => m !== target);
const PASS = "All 3 checks that run in your browser passed. The source code still needs the Git command in step 4.";

/**
 * Opens /verify/. `change(path, bytes)` may rewrite a data file of the site; `technocore()` answers the
 * room export ({status, body}, "fail" for a network error, "hold" to never answer).
 */
async function open({ change = () => null, technocore = () => ({ body: exportOf(census) }), init = "" } = {}) {
  const log = { requests: [], exports: [] };
  listeners.clear();
  listeners.add(async (msg) => {
    if (msg.method === "Network.requestWillBeSent") log.requests.push(msg.params.request);
    if (msg.method !== "Fetch.requestPaused") return;
    const { requestId, request } = msg.params;
    const url = new URL(request.url);
    const fulfill = (status, body, type = "application/json") => send("Fetch.fulfillRequest", { requestId, responseCode: status,
      responseHeaders: [{ name: "content-type", value: type }, { name: "access-control-allow-origin", value: "*" }],
      body: Buffer.from(body).toString("base64") }).catch(() => {});
    if (url.origin === "https://technocore.chat") {
      log.exports.push(request);
      const a = technocore();
      if (a === "hold") return;
      if (a === "fail") { await send("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" }).catch(() => {}); return; }
      await fulfill(a.status ?? 200, a.body ?? "", "application/x-ndjson");
      return;
    }
    const bytes = readFileSync(join(DIST, ...url.pathname.split("/").filter(Boolean)));
    const out = change(url.pathname, bytes);
    if (out === null) { await send("Fetch.continueRequest", { requestId }).catch(() => {}); return; }
    await fulfill(out.status ?? 200, out.body ?? bytes);
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: `${site.origin}/data/*`, requestStage: "Request" },
    { urlPattern: "https://technocore.chat/*", requestStage: "Request" }] });
  const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", { source: init });
  await navigate("/verify/");
  await until("['Checking', 'needs JavaScript'].every(t => !document.querySelector('[data-verify-summary-text]').textContent.includes(t))",
    "the checks to finish", 30000);
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  return log;
}

const results = () => page(`Object.fromEntries([...document.querySelectorAll('[data-check]')].map(c => [c.dataset.check, [c.dataset.state, c.textContent.trim()]]))`);
const summary = () => page("document.querySelector('[data-verify-summary-text]').textContent");
const MATCH = ["pass", "Matches: checked in this browser"];

before(start);
after(stop);

test("the served files and the signed census message pass, and only public reads leave the browser", { skip }, async () => {
  const log = await open();
  assert.deepEqual(await results(), {
    snapshot: MATCH, manifest: MATCH,
    signature: ["pass", "Valid signature from the Room Census DID, and it names both fingerprints: checked in this browser"],
  });
  assert.equal(await summary(), PASS);
  // one GET of the public export, with nothing of the reader or of the DID in it
  assert.equal(log.exports.length, 1);
  assert.equal(log.exports[0].method, "GET");
  assert.equal(log.exports[0].url, `https://technocore.chat/r/${latest.signed_in.room}/export`);
  for (const r of log.requests) {
    assert.ok(r.url.startsWith(site.origin) || r.url.startsWith("https://technocore.chat/") || r.url.startsWith("data:"), `unexpected request ${r.url}`);
    assert.ok(!r.url.includes("z6Mk") && !/did(:|%3A)key/i.test(r.url), `the DID left the browser: ${r.url}`);
    assert.equal(r.method, "GET");
  }
  assert.equal(await page("document.querySelector('button[data-copy]').hidden"), false);
});

test("an altered message text fails the signature", { skip }, async () => {
  await open({ technocore: () => ({ body: exportOf([...others, { ...target, text: target.text + " " }]) }) });
  const r = await results();
  assert.deepEqual(r.signature, ["fail", "Failed: the signature does not match this message"]);
  assert.match(await summary(), /^2 of 3 checks passed in your browser, 1 failed\. /);
});

test("a message with another nonce, or from another DID, is not the census message", { skip }, async () => {
  for (const wrong of [{ ...target, nonce: String(BigInt(target.nonce) + 1n) }, { ...target, from: OTHER }]) {
    await open({ technocore: () => ({ body: exportOf([...others, wrong]) }) });
    const r = await results();
    assert.deepEqual(r.signature, ["unchecked", "Could not be checked: the room export holds no message from the Room Census DID with this nonce"]);
    assert.match(await summary(), /^2 of 3 checks passed in your browser, 1 could not be checked\. /);
  }
});

test("a missing message, an HTTP error, a network error or a timeout is never a pass", { skip }, async () => {
  const cases = [
    [() => ({ body: exportOf(others) }), "Could not be checked: the room export holds no message from the Room Census DID with this nonce"],
    [() => ({ body: "" }), "Could not be checked: the room export holds no message from the Room Census DID with this nonce"],
    [() => ({ status: 503, body: "busy" }), "Could not be checked: technocore.chat answered HTTP 503"],
    [() => "fail", "Could not be checked: technocore.chat could not be reached"],
    [() => "hold", "Could not be checked: no answer from technocore.chat within 10 seconds"],
  ];
  for (const [technocore, text] of cases) {
    await open({ technocore });
    const r = await results();
    assert.deepEqual(r.signature, ["unchecked", text]);
    assert.deepEqual([r.snapshot, r.manifest], [MATCH, MATCH]);
    assert.notEqual(await summary(), PASS);
  }
});

test("without Ed25519, or without Web Crypto at all, nothing is passed", { skip }, async () => {
  await open({ init: `{ const real = crypto.subtle.importKey.bind(crypto.subtle);
    crypto.subtle.importKey = (f, k, alg, ...rest) => (alg && alg.name === "Ed25519") ? Promise.reject(new Error("NotSupportedError")) : real(f, k, alg, ...rest); }` });
  let r = await results();
  assert.deepEqual(r.signature, ["unchecked", "Could not be checked: this browser cannot check Ed25519 signatures"]);
  await open({ init: "Object.defineProperty(Crypto.prototype, 'subtle', { get: () => undefined });" });
  r = await results();
  for (const k of ["snapshot", "manifest", "signature"]) assert.equal(r[k][0], "unchecked", k);
  assert.match(await summary(), /^0 of 3 checks passed in your browser, 3 could not be checked\. /);
});

test("one changed byte in the snapshot fails it, and a missing manifest cannot be checked", { skip }, async () => {
  await open({ change: (path, bytes) => {
    if (!path.includes("/snapshots/")) return null;
    const copy = Buffer.from(bytes);
    copy[copy.length - 2] ^= 1;
    return { body: copy };
  } });
  let r = await results();
  assert.equal(r.snapshot[0], "fail");
  assert.match(r.snapshot[1], /^Failed: does not match, this browser computed [0-9a-f]{64}$/);
  assert.deepEqual(r.manifest, MATCH);
  await open({ change: (path) => (path.includes("/manifests/") ? { status: 404, body: "missing" } : null) });
  r = await results();
  assert.deepEqual(r.manifest, ["unchecked", "Could not be checked here (HTTP 404)"]);
  assert.match(await summary(), /^2 of 3 checks passed in your browser, 1 could not be checked\. /);
});
