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
const rankingDoc = JSON.parse(readFileSync(LIVE ? join(DIST, "data", "contests", "close-1.ranking.json")
  : join(DIST, "contests", "close-1", "ranking.json"), "utf8"));
// ranking v1 lists every key; v2 lists the first places, the others are in 256 shard files
const ranking = { rows: rankingDoc.rows ?? rankingDoc.top };
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
  // one key per row, ranked 1, 2, 3... up to 100
  const ranks = await page(`[...document.querySelectorAll("section[aria-labelledby=top-title] tbody tr td:first-child")].map((t) => Number(t.textContent.trim()))`);
  assert.equal(ranks.length, Math.min(100, ranking.rows.length));
  assert.deepEqual(ranks, ranks.map((_, i) => i + 1));
  // the referee's signed list comes first, each key with its signed score
  const idx = JSON.parse(readFileSync(LIVE ? join(DIST, "data", "contests", "index.json") : join(DIST, "..", "src", "fixtures", "contests.sample.json"), "utf8"));
  const signedRows = idx.contests.find((c) => c.id === "close-1").leaderboard.rows;
  const shown = await page(`[...document.querySelectorAll("section[aria-labelledby=top-title] tbody tr")].slice(0, ${signedRows.length}).map((tr) => tr.querySelector("td:nth-child(3)").textContent.trim())`);
  assert.deepEqual(shown, signedRows.map((r) => (r.pnl.startsWith("-") || Number(r.pnl) === 0 ? r.pnl : `+${r.pnl}`)));
  await shot("contest-live");
  await shot("contest-live-mobile", 390);
});

test("the old leaderboard address lands on the Live page", { skip }, async () => {
  await navigate("/contests/close-1/leaderboard/");
  await until(`location.pathname === "/contests/close-1/"`, "the redirect to Live");
});

/** Searches a ranked key: the trader page opens, and its rank is read there. */
async function openFromSearch(did) {
  await navigate("/contests/close-1/");
  await page(`(() => { const i = document.querySelector("#find-input"); i.value = ${JSON.stringify(did)};
    document.querySelector("[data-find-form]").requestSubmit(); return true; })()`);
  await until(`location.pathname === "/contests/close-1/did/"`, "the trader page");
  await until(`!document.querySelector("[data-head]").hidden`, "the trader's rank");
  return page(`document.querySelector("[data-rank]").textContent`);
}

test("Find my DID opens a ranked key's page, says a key has not traded yet, or refuses a malformed key", { skip }, async () => {
  const [rank, did, pnl] = ranking.rows[0];
  assert.equal(await openFromSearch(did), `#${rank}`);
  assert.equal(await page(`new URLSearchParams(location.search).get("k")`), did);
  assert.match(await page(`document.querySelector("[data-score]").textContent`), new RegExp(pnl.replace("-", "").replace(".", "\\.")));
  await navigate("/contests/close-1/");
  await find(NOBODY);
  await until(`!document.querySelector("[data-find-result]").textContent.includes("Searching")`, "the search to finish");
  assert.match(await page(`document.querySelector("[data-find-result]").textContent`), /No trade yet/);
  assert.equal(await page(`location.pathname`), "/contests/close-1/");
  await shot("contest-find");
  assert.match(await find("did:key:nope"), /Not a did:key/);
});

test("Share on X opens a prefilled post on X and puts the 1200 x 675 card on the clipboard", { skip }, async () => {
  const [, did] = ranking.rows[0];
  await navigate(`/contests/close-1/did/?k=${did}`);
  await until(`!document.querySelector("[data-head]").hidden`, "the trader page");
  // the test stands in for X and for the clipboard, and keeps what they were given
  await page(`(() => { window.open = (u) => { window.__opened = u; return null; };
    navigator.clipboard.write = async (items) => { window.__copied = await items[0].getType("image/png"); }; return true; })()`);
  await until(`(async () => { await new Promise((r) => setTimeout(r, 300)); return true; })()`, "the card to be drawn");
  await page(`document.querySelector("[data-share]").click()`);
  await until(`window.__opened !== undefined && window.__copied !== undefined`, "X and the clipboard");
  const opened = await page(`window.__opened`);
  assert.match(opened, /^https:\/\/x\.com\/intent\/post\?text=/);
  assert.match(decodeURIComponent(opened), /Score in .* POLF, #1 of/);
  assert.match(await page(`document.querySelector("[data-share-status]").textContent`), /Ctrl\+V/);
  const info = await page(`(async () => { const f = window.__copied; const b = await createImageBitmap(f);
    const r = new FileReader(); const url = await new Promise((ok) => { r.onload = () => ok(r.result); r.readAsDataURL(f); });
    return { type: f.type, w: b.width, h: b.height, url }; })()`);
  assert.equal(info.type, "image/png");
  assert.deepEqual([info.w, info.h], [1200, 675]);
  if (process.env.SHOT_DIR) writeFileSync(join(process.env.SHOT_DIR, "score-card.png"), Buffer.from(info.url.split(",")[1], "base64"));
});

test("the checks list every state in plain words", { skip }, async () => {
  await navigate("/contests/close-1/verify/");
  const items = await page(`document.querySelectorAll("main ul > li").length`);
  assert.ok(items >= 5, `expected at least 5 checks, got ${items}`);
  assert.match(await page(`document.querySelector("[role=status]").textContent`), /checks pass/);
  await shot("contest-verify");
});

test("Find my DID gives each key the rank the Top 100 shows", { skip }, async () => {
  await navigate("/contests/close-1/");
  const table = await page(`[...document.querySelectorAll("section[aria-labelledby=top-title] tbody tr")].slice(0, 30).map((tr) =>
    [Number(tr.querySelector("td").textContent.trim()), tr.querySelector("td:nth-child(2) a").getAttribute("href").split("k=")[1]])`);
  for (const [rank, did] of [table[0], table[1], table[5], table[table.length - 1]]) {
    assert.equal(await openFromSearch(did), `#${rank.toLocaleString("en-US")}`, `${did} is #${rank} in the table`);
  }
});

test("a trader's page opens from the table with its rank, score and position", { skip }, async () => {
  await navigate("/contests/close-1/");
  const href = await page(`document.querySelector("section[aria-labelledby=top-title] tbody tr td:nth-child(2) a").getAttribute("href")`);
  const score = await page(`document.querySelector("section[aria-labelledby=top-title] tbody tr td:nth-child(3)").textContent.trim()`);
  // the whole row opens it: a click on the score cell lands on the row's link
  assert.equal(await page(`(() => { const td = document.querySelector("section[aria-labelledby=top-title] tbody tr td:nth-child(3)");
    const r = td.getBoundingClientRect(); td.scrollIntoView({ block: "center" }); const b = td.getBoundingClientRect();
    return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2).closest("a")?.getAttribute("href"); })()`), href);
  await navigate(href);
  await until(`!document.querySelector("[data-head]").hidden || !document.querySelector("[data-problem]").classList.contains("hidden")`, "the trader page");
  assert.equal(await page(`document.querySelector("[data-rank]").textContent`), "#1");
  assert.equal(await page(`document.querySelector("[data-score]").textContent`), score.replace("-", "−"));
  assert.match(await page(`document.querySelector("[data-position]").textContent`), /Long|Short|Flat|–/);
  await shot("contest-did");
  await navigate("/contests/close-1/did/?k=nope");
  assert.match(await page(`document.querySelector("[data-problem]").textContent`), /Open this page from the contest/);
});

