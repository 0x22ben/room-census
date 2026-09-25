// The built Contests pages in a real headless browser: the list, a contest overview, the leaderboard
// with "Find my DID" (a ranked key, a key with no trade, a malformed key) and the checks. Set SHOT_DIR
// to also save a PNG of each page.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { DIST, navigate, page, send, skip, start, stop, until } from "./harness.mjs";

// live when the witness published data/contests/, sample otherwise: the pages must work in both
const LIVE = existsSync(join(DIST, "data", "contests", "index.json"));
const ranking = JSON.parse(readFileSync(LIVE ? join(DIST, "data", "contests", "close-1.ranking.json")
  : join(DIST, "contests", "close-1", "ranking.json"), "utf8"));
const NOBODY = "did:key:z6Mkfw79DoBMgePecy4YaXSSimwzHKYz8sB3JB9X7bKSXMkG";
const index = JSON.parse(readFileSync(LIVE ? join(DIST, "data", "contests", "index.json") : join(DIST, "..", "src", "fixtures", "contests.sample.json"), "utf8"));
const SELF = index.contests.find((c) => c.id === "close-1").self_key;

async function shot(name, width = 1440) {
  if (!process.env.SHOT_DIR) return;
  await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
  const { cssContentSize } = await send("Page.getLayoutMetrics");
  await send("Emulation.setDeviceMetricsOverride", { width, height: Math.ceil(cssContentSize.height), deviceScaleFactor: 1, mobile: width < 768 });
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  mkdirSync(process.env.SHOT_DIR, { recursive: true });
  writeFileSync(join(process.env.SHOT_DIR, `${name}.png`), Buffer.from(data, "base64"));
  await send("Emulation.clearDeviceMetricsOverride");
}

async function find(did) {
  await page(`(() => { const i = document.querySelector("#find-input"); i.value = ${JSON.stringify(did)};
    document.querySelector("[data-find-form]").requestSubmit(); return true; })()`);
  await until(`document.querySelector("[data-find-result]").textContent.length > 0`, "a Find my DID result");
  return page(`document.querySelector("[data-find-result]").textContent`);
}

before(start);
after(stop);

test("the list shows each contest with its status and opens it", { skip }, async () => {
  await navigate("/contests/");
  assert.equal(await page(`document.querySelector("h1").textContent`), "Contests we follow");
  const text = await page(`document.querySelector("main").textContent`);
  assert.match(text, /We hold every referee update since the opening\. Our copy of the trading room starts .* after the opening/);
  assert.doesNotMatch(text, /We hold nothing from before/);
  assert.doesNotMatch(text, /appear here on their own|from the first minute/);
  const cards = await page(`[...document.querySelectorAll("article h3")].map((h) => h.textContent)`);
  assert.deepEqual(cards, ["Close Call · NVDA", "Sonnet Challenge"]);
  if (LIVE) assert.doesNotMatch(await page(`document.body.textContent`), /Sample data/);
  else assert.match(await page(`document.body.textContent`), /Sample data/);
  assert.equal(await page(`document.querySelector('a[aria-current="page"]').textContent.trim().startsWith("Contests")`), true);
  await shot("contests-list");
  await shot("contests-list-mobile", 390);
});

test("a live contest shows time left, players, price, prize and the top 3", { skip }, async () => {
  await navigate("/contests/close-1/");
  const text = await page(`document.querySelector("main").textContent`);
  for (const part of ["Players", "NVDA price used", "Prize", "Players over time", "Top 3 at update", "See the checks", "Trading closes 4 Oct 2026, 09:00 UTC"]) {
    assert.match(text, new RegExp(part));
  }
  assert.equal(await page(`document.querySelectorAll("section[aria-labelledby=top3-title] li").length`), 3);
  await shot("contest-overview");
  await shot("contest-overview-mobile", 390);
});

test("Find my DID gives the rank and its source, or says there is no trade, or refuses a malformed key", { skip }, async () => {
  await navigate("/contests/close-1/leaderboard/");
  const [rank, did, pnl, source] = ranking.rows[0];
  const found = await find(did);
  assert.match(found, new RegExp(`#${rank}`));
  assert.match(found, new RegExp(pnl.replace(".", "\\.")));
  const label = { official: /Signed by the referee/, complete: /Our count/, partial: /may be incomplete/ }[source];
  assert.match(found, label);
  await shot("contest-leaderboard");
  const nobody = await find(NOBODY);
  assert.match(nobody, /Not found in the inspected data/);
  assert.match(nobody, /Registration and mint: not independently established/);
  assert.doesNotMatch(nobody, /not registered/i);
  assert.match(await find("did:key:nope"), /not a did:key/);
  if (SELF && !SELF.settled_trade) {
    // our own key: its registration post is evidence we hold; its mint is not claimed
    const ours = await find(SELF.did);
    assert.match(ours, new RegExp(`Registration:\\s*observed from our own signed posting record \\(not from the referee\\): close1, seq ${SELF.registration.seq}`));
    assert.match(ours, /Mint of 10,000 POLF:\s*not independently confirmed/);
    assert.match(ours, /Settled trade:\s*no settled trade found in the trades we saved/);
    // never presented as confirmed without a signed referee record
    assert.doesNotMatch(ours, /registration (is )?confirmed|mint(ed)? confirmed|officially registered/i);
  }
});

test("the checks list every state in plain words", { skip }, async () => {
  await navigate("/contests/close-1/verify/");
  const items = await page(`document.querySelectorAll("main ul > li").length`);
  assert.ok(items >= 5, `expected at least 5 checks, got ${items}`);
  assert.match(await page(`document.querySelector("[role=status]").textContent`), /checks pass/);
  await shot("contest-verify");
});
