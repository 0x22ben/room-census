// The built /verify/ page in a real headless browser. The page hashes the snapshot and the manifest
// the site serves; here the test can alter or refuse those files on their way, to prove that only a
// real match ever shows as a pass.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { DIST, listeners, navigate, page, send, site, skip, start, stop, until } from "./harness.mjs";

const latest = JSON.parse(readFileSync(join(DIST, "data", "latest.json"), "utf8"));

/** Opens /verify/, letting `change(path, bytes)` rewrite a data file on its way (or return a status). */
async function open(change = () => null) {
  const requests = [];
  listeners.clear();
  listeners.add(async (msg) => {
    if (msg.method === "Network.requestWillBeSent") requests.push(msg.params.request.url);
    if (msg.method !== "Fetch.requestPaused") return;
    const { requestId, request } = msg.params;
    const path = new URL(request.url).pathname;
    const bytes = readFileSync(join(DIST, ...path.split("/").filter(Boolean)));
    const out = change(path, bytes);
    if (out === null) { await send("Fetch.continueRequest", { requestId }).catch(() => {}); return; }
    const { status = 200, body = bytes } = out;
    await send("Fetch.fulfillRequest", { requestId, responseCode: status,
      responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(body).toString("base64") }).catch(() => {});
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: `${site.origin}/data/*`, requestStage: "Request" }] });
  await navigate("/verify/");
  await until("!document.querySelector('[data-verify-summary-text]').textContent.startsWith('Checking')"
    + " && !document.querySelector('[data-verify-summary-text]').textContent.includes('needs JavaScript')", "the checks to finish");
  return requests;
}

const results = () => page(`Object.fromEntries([...document.querySelectorAll('[data-check]')].map(c => [c.dataset.check, c.textContent.trim()]))`);
const summary = () => page("document.querySelector('[data-verify-summary-text]').textContent");

before(start);
after(stop);

test("the served files match, and the page says exactly which checks ran", { skip }, async () => {
  const requests = await open();
  assert.deepEqual(await results(), { snapshot: "Matches: checked in this browser", manifest: "Matches: checked in this browser" });
  assert.equal(await summary(), "The snapshot and the manifest match their fingerprints, checked in your browser. Check the signature and the source code with the steps below.");
  for (const u of requests) assert.ok(u.startsWith(site.origin) || u.startsWith("data:"), `unexpected request ${u}`);
  assert.ok(requests.includes(`${site.origin}/${latest.snapshot}`));
  assert.ok(requests.includes(`${site.origin}/${latest.provenance.manifest}`));
  assert.equal(await page("document.querySelector('button[data-copy]').hidden"), false);
});

test("one changed byte in the snapshot is a mismatch, never a pass", { skip }, async () => {
  await open((path, bytes) => {
    if (!path.includes("/snapshots/")) return null;
    const copy = Buffer.from(bytes);
    copy[copy.length - 2] ^= 1;
    return { body: copy };
  });
  const r = await results();
  assert.match(r.snapshot, /^Does not match: this browser computed [0-9a-f]{64}$/);
  assert.equal(r.manifest, "Matches: checked in this browser");
  assert.equal(await summary(), "1 of 2 checks did not pass in your browser. See the steps below.");
  assert.equal(await page("document.querySelector('[data-check=snapshot]').classList.contains('text-warning')"), true);
});

test("a manifest that cannot be read is reported, never passed", { skip }, async () => {
  await open((path) => (path.includes("/manifests/") ? { status: 404, body: "missing" } : null));
  const r = await results();
  assert.equal(r.manifest, "Could not be checked here (HTTP 404)");
  assert.equal(r.snapshot, "Matches: checked in this browser");
  assert.equal(await summary(), "1 of 2 checks did not pass in your browser. See the steps below.");
});
