// The built /did/ page in a real headless browser. Every Technocore read is answered by the test
// (no network), so the page script runs exactly as shipped: bounded concurrency, visible progress and
// partial failures, stop, honest results, the local proof, and nothing stored or sent.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { DIST, WEB, listeners, navigate, page, send, site, skip, sleep, start, stop, until } from "./harness.mjs";

const fixture = readFileSync(join(WEB, "tests", "fixtures", "room-census-reply.json"), "utf8");
const identity = JSON.parse(readFileSync(join(WEB, "..", "identity.json"), "utf8"));
const DID = identity.did;
const OTHER = "did:key:z6Mkfw79DoBMgePecy4YaXSSimwzHKYz8sB3JB9X7bKSXMkG";

/**
 * Opens /did/ with Technocore answered by `answer(room)` -> {status, body} after `delay` ms (or held
 * until released when `hold` is true). Returns a log of every request the page made.
 */
async function open({ answer, delay = 25, hold = false, noEd25519 = false }) {
  const log = { requests: [], technocore: [], inFlight: 0, maxInFlight: 0, held: [] };
  listeners.clear();
  listeners.add(async (msg) => {
    if (msg.method === "Network.requestWillBeSent") log.requests.push(msg.params.request.url);
    if (msg.method !== "Fetch.requestPaused") return;
    const { requestId, request } = msg.params;
    log.technocore.push(request.url);
    log.inFlight += 1;
    log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
    const room = new URL(request.url).pathname.split("/")[2];
    const reply = async () => {
      const { status = 200, body = JSON.stringify({ room, messages: [] }) } = answer(room) ?? {};
      log.inFlight -= 1;
      await send("Fetch.fulfillRequest", {
        requestId, responseCode: status,
        responseHeaders: [{ name: "content-type", value: "application/json" }, { name: "access-control-allow-origin", value: "*" }],
        body: Buffer.from(body).toString("base64"),
      }).catch(() => {});
    };
    if (hold) log.held.push(reply);
    else setTimeout(reply, delay);
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://technocore.chat/*", requestStage: "Request" }] });
  const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", {
    source: noEd25519
      ? `{ const real = crypto.subtle.importKey.bind(crypto.subtle);
           crypto.subtle.importKey = (f, k, alg, ...rest) => (alg && alg.name === "Ed25519") ? Promise.reject(new Error("NotSupportedError")) : real(f, k, alg, ...rest); }`
      : "",
  });
  await navigate("/look-up/");
  await until("!document.querySelector('form[data-did-form]').hidden", "the form to be enabled by the script");
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  return log;
}

const lookUp = (did) => page(`(() => {
  document.getElementById('did-input').value = ${JSON.stringify(did)};
  document.querySelector('[data-did-submit]').click();
})()`);
const done = () => until("!document.querySelector('[data-did-proof]').hidden", "the lookup to finish");
const text = (sel) => page(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const hidden = (sel) => page(`document.querySelector(${JSON.stringify(sel)}).hidden`);
const proof = () => page(`(async () => {
  let blob = null;
  const create = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (b) => { blob = b; return "about:blank"; };
  HTMLAnchorElement.prototype.click = function () { window.__proofName = this.download; };
  document.querySelector('[data-did-proof]').click();
  URL.createObjectURL = create; HTMLAnchorElement.prototype.click = click;
  return { name: window.__proofName, json: JSON.parse(await blob.text()) };
})()`);

before(start);
after(stop);

function rooms() {
  const latest = JSON.parse(readFileSync(join(DIST, "data", "latest.json"), "utf8"));
  return [...latest.rooms.map((r) => r.room), identity.room];
}

test("a lookup reads every room at most four at a time, shows progress and failures, and counts only checked signatures", { skip }, async () => {
  const all = rooms();
  const failing = all[1];
  const forged = JSON.parse(fixture).messages[0];
  const log = await open({
    delay: 60,
    answer: (room) => room === identity.room ? { body: fixture }
      : room === failing ? { status: 503, body: "busy" }
      : room === all[0] ? { body: JSON.stringify({ room, messages: [{ ...forged, text: "forged" }] }) }
      : undefined,
  });
  await lookUp(DID);
  // part way through: the count and the failure are already visible
  await until("/^([1-9]|[1-5]\\d) of 60 rooms read · 1 could not be read$/.test(document.querySelector('[data-did-count]').textContent)",
    "a partial count that shows the failed room");
  assert.ok((await page("document.querySelector('[data-did-progress]').value")) > 0);
  assert.match(await page("document.querySelector('[data-did-progress]').getAttribute('aria-valuetext')"), /of 60 rooms read/);
  assert.match(await text("[data-did-status]"), /Reading 60 rooms from technocore\.chat, 4 at a time\./);
  await done();

  assert.equal(log.technocore.length, all.length);
  assert.ok(log.maxInFlight <= 4, `at most 4 reads at once, saw ${log.maxInFlight}`);
  assert.ok(log.maxInFlight >= 2, "reads do run in parallel");
  assert.deepEqual(log.technocore.map((u) => new URL(u).pathname.split("/")[2]).sort(), [...all].sort());
  for (const u of log.technocore) assert.match(u, /^https:\/\/technocore\.chat\/r\/[a-z0-9][a-z0-9_-]*\?format=json&limit=200$/);
  for (const u of log.requests) {
    assert.ok(u.startsWith(site.origin) || u.startsWith("https://technocore.chat/") || u.startsWith("data:"), `unexpected request ${u}`);
    assert.ok(!u.includes("z6Mk") && !u.includes("did%3Akey") && !u.includes("did:key"), `the DID left the browser: ${u}`);
  }

  assert.equal(await text("[data-did-heading]"), "Recent activity found in the Room Census room");
  assert.equal(await page("document.activeElement.id"), "result-title");
  assert.match(await text("[data-did-status]"), /^59 of 60 rooms read, finished .* UTC\. 1 could not be read\.$/);
  assert.equal(await text("[data-did-count]"), "60 of 60 rooms read · 1 could not be read");
  assert.equal(await text('[data-kpi="signed_messages"]'), "3");
  assert.equal(await text('[data-kpi="rooms_with_activity"]'), "1");
  assert.match(await text("[data-did-bad]"), /^1 message names this DID without a valid signature\. It is not counted\.$/);
  assert.match(await text("[data-did-meaning]"), /newest 200 messages .* Older activity is not included\..*covered only the last/);
  assert.equal(await page("document.querySelectorAll('[data-did-list] li').length"), 3);
  assert.equal(await page("document.querySelectorAll('[data-did-rooms] tr').length"), 60);
  assert.equal(await page(`[...document.querySelectorAll('[data-did-rooms] td')].filter(t => t.textContent === 'Not read (HTTP 503)').length`), 1);

  const { name, json } = await proof();
  assert.match(name, /^did-activity-[1-9A-HJ-NP-Za-km-z]{8}-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(json.did, DID);
  assert.equal(json.all_rooms_read, false);
  assert.equal(json.coverage.rooms.length, 60);
  assert.equal(json.summary.signed_messages, 3);
  assert.equal(json.summary.not_verifiable, 1);
  assert.deepEqual(json.records.map((r) => r.result).sort(), ["bad", "checked", "checked", "checked"]);
  for (const r of json.records) assert.equal(typeof r.message.nonce, "string");
  assert.match(json.disclaimer, /does not determine ownership, reputation or eligibility for any reward\.$/);
  assert.match(json.verification.not_signed, /not covered by the signature/);
  assert.equal(await page("localStorage.length + sessionStorage.length"), 0);
});

test("nothing found is said as not found in the inspected data, without zero totals", { skip }, async () => {
  await open({ answer: () => undefined, delay: 5 });
  await lookUp(OTHER);
  await done();
  assert.equal(await text("[data-did-heading]"), "Not found in the inspected data");
  assert.match(await text("[data-did-meaning]"), /This does not mean the DID has no activity/);
  assert.equal(await hidden("[data-did-kpis]"), true);
  assert.equal(await hidden("[data-did-messages]"), true);
  assert.match(await text("[data-did-status]"), /^60 of 60 rooms read, finished .* UTC\.$/);
  assert.equal((await proof()).json.all_rooms_read, true);
});

test("Stop ends the lookup, and the rooms left unread are listed as stopped", { skip }, async () => {
  const log = await open({ answer: () => undefined, hold: true });
  await lookUp(DID);
  for (let i = 0; i < 50 && log.held.length < 4; i++) await sleep(20);
  assert.equal(log.held.length, 4, "four reads start, the rest wait");
  // a second submit while a lookup runs (Enter, a script, a double click) starts nothing new
  await page("document.querySelector('form[data-did-form]').requestSubmit()");
  await sleep(250);
  assert.equal(log.held.length, 4, "no second lookup while one runs");
  for (const reply of log.held.splice(0, 2)) await reply();
  await until("document.querySelector('[data-did-count]').textContent.startsWith('2 of 60')", "two rooms read");
  await page("document.querySelector('[data-did-cancel]').click()");
  await done();
  for (const reply of log.held.splice(0)) await reply();
  assert.match(await text("[data-did-status]"), /^2 of 60 rooms read, .*Stopped before the end\.$/);
  assert.ok(log.technocore.length < 60);
  const { json } = await proof();
  assert.equal(json.all_rooms_read, false);
  assert.equal(json.coverage.rooms.length, 60);
  assert.equal(json.coverage.rooms.filter((c) => c.status === "read").length, 2);
  assert.ok(json.coverage.rooms.filter((c) => c.reason === "stopped").length === 58);
});

test("a malformed DID is refused before any read", { skip }, async () => {
  const log = await open({ answer: () => undefined });
  await lookUp("did:key:z6Mk-not-a-key");
  await until("document.querySelector('[data-did-error]').textContent !== ''", "the error");
  assert.match(await text("[data-did-error]"), /^This is not an Ed25519 did:key\./);
  assert.equal(await page("document.getElementById('did-input').getAttribute('aria-invalid')"), "true");
  assert.equal(await page("document.querySelector('[data-did-error]').getAttribute('role')"), "alert");
  assert.equal(await hidden("[data-did-result]"), true);
  await sleep(200);
  assert.equal(log.technocore.length, 0);
});

test("a browser without Ed25519 is told so, instead of a false not found", { skip }, async () => {
  const log = await open({ answer: () => undefined, noEd25519: true });
  await lookUp(DID);
  await until("document.querySelector('[data-did-error]').textContent !== ''", "the error");
  assert.match(await text("[data-did-error]"), /cannot check Ed25519 signatures/);
  assert.equal(await hidden("[data-did-result]"), true);
  assert.equal(await page("document.querySelector('[data-did-submit]').disabled"), false);
  await sleep(200);
  assert.equal(log.technocore.length, 0);
});
