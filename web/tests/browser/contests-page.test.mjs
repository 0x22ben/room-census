// The built Contests pages in a real headless browser: the list, a contest overview, the leaderboard
// with "Find my DID" (a ranked key, a key with no trade, a malformed key) and the checks. Set SHOT_DIR
// to also save a PNG of each page.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { DIST, navigate, page, send, skip, start, stop, until } from "./harness.mjs";

const ranking = JSON.parse(readFileSync(join(DIST, "contests", "close-1", "ranking.json"), "utf8"));
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
  assert.equal(await page(`document.querySelector("h1").textContent`), "Contests");
  const cards = await page(`[...document.querySelectorAll("article h3")].map((h) => h.textContent)`);
  assert.deepEqual(cards, ["Close Call · NVDA", "Sonnet Challenge"]);
  assert.match(await page(`document.body.textContent`), /Sample data/);
  assert.equal(await page(`document.querySelector('a[aria-current="page"]').textContent.trim().startsWith("Contests")`), true);
  await shot("contests-list");
  await shot("contests-list-mobile", 390);
});

test("a live contest shows time left, players, price, prize and the top 3", { skip }, async () => {
  await navigate("/contests/close-1/");
  const text = await page(`document.querySelector("main").textContent`);
  for (const part of ["Players", "NVDA price used", "Prize", "Players over time", "Top 3 at update", "See the checks"]) assert.match(text, new RegExp(part));
  assert.equal(await page(`document.querySelectorAll("section[aria-labelledby=top3-title] li").length`), 3);
  await shot("contest-overview");
  await shot("contest-overview-mobile", 390);
});

test("Find my DID gives the rank and its source, or says there is no trade, or refuses a malformed key", { skip }, async () => {
  await navigate("/contests/close-1/leaderboard/");
  const [rank, did, pnl] = ranking.rows[0];
  const found = await find(did);
  assert.match(found, new RegExp(`#${rank}`));
  assert.match(found, new RegExp(pnl.replace(".", "\\.")));
  assert.match(found, /Signed by the referee/);  // the first row is in the matched signed top list
  await shot("contest-leaderboard");
  assert.match(await find(NOBODY), /Not found in the inspected data/);
  assert.match(await find("did:key:nope"), /not a did:key/);
});

test("the checks list every state in plain words", { skip }, async () => {
  await navigate("/contests/close-1/verify/");
  const items = await page(`document.querySelectorAll("main ul > li").length`);
  assert.ok(items >= 5, `expected at least 5 checks, got ${items}`);
  assert.match(await page(`document.querySelector("[role=status]").textContent`), /checks pass/);
  await shot("contest-verify");
});
