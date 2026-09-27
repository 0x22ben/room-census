// The built Contests pages in a real headless browser: the list, a contest's Live page with "Find my
// DID" (a ranked key, a key with no trade, a malformed key) and the checks. Set SHOT_DIR
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

test("a live contest shows five numbers, the chart, Find my DID and the top traders", { skip }, async () => {
  await navigate("/contests/close-1/");
  const text = await page(`document.querySelector("main").textContent`);
  for (const part of ["NVDA", "Active traders", "#1 score", "Prize · top 3", "Find my DID", "Top traders"]) {
    assert.ok(text.includes(part), `the page shows "${part}"`);
  }
  assert.deepEqual(await page(`[...document.querySelectorAll('nav[aria-label="Contest sections"] a')].map((a) => a.textContent.trim())`), ["Live", "Verify"]);
  assert.ok(await page(`document.querySelector("[data-trading-chart] canvas") !== null`), "the chart is drawn");
  assert.match(await page(`document.querySelector("[data-view]").textContent`), /Price/);
  const rows = await page(`document.querySelectorAll("section[aria-labelledby=top-title] tbody tr").length`);
  assert.ok(rows >= 1, "the signed top list has rows");
  // equal scores share one row
  const scores = await page(`[...document.querySelectorAll("section[aria-labelledby=top-title] tbody tr td:nth-child(3)")].map((t) => t.textContent)`);
  assert.equal(new Set(scores).size, scores.length);
  await shot("contest-live");
  await shot("contest-live-mobile", 390);
});

test("the old leaderboard address lands on the Live page", { skip }, async () => {
  await navigate("/contests/close-1/leaderboard/");
  await until(`location.pathname === "/contests/close-1/"`, "the redirect to Live");
});

test("Find my DID gives the rank, says a key has not traded yet, or refuses a malformed key", { skip }, async () => {
  await navigate("/contests/close-1/");
  const [rank, did, pnl, source] = ranking.rows[0];
  const found = await find(did);
  await until(`!document.querySelector("[data-find-result]").textContent.includes("Searching")`, "the search to finish");
  const result = await page(`document.querySelector("[data-find-result]").textContent`);
  assert.match(result, new RegExp(`#${rank}`));
  assert.match(result, new RegExp(pnl.replace("-", "").replace(".", "\\.")));
  const label = { official: /Signed by the referee/, complete: /Our recount/, partial: /may miss early trades/ }[source];
  assert.match(result, label);
  assert.ok(found.length > 0);
  await shot("contest-find");
  await find(NOBODY);
  await until(`!document.querySelector("[data-find-result]").textContent.includes("Searching")`, "the search to finish");
  assert.match(await page(`document.querySelector("[data-find-result]").textContent`), /No trade yet/);
  assert.match(await find("did:key:nope"), /Not a did:key/);
});

test("the checks list every state in plain words", { skip }, async () => {
  await navigate("/contests/close-1/verify/");
  const items = await page(`document.querySelectorAll("main ul > li").length`);
  assert.ok(items >= 5, `expected at least 5 checks, got ${items}`);
  assert.match(await page(`document.querySelector("[role=status]").textContent`), /checks pass/);
  await shot("contest-verify");
});
