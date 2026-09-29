// The built Contests pages in a real headless browser: the list, a contest's Live page with "Find my
// DID" (a key of the referee's signed top list, a key outside it, a malformed key), a trader's page
// for both, and the checks. Until our recount is proved, a rank or a score shows only for the signed
// top list (Pencil mockup FbqCS, Ben 2026-09-29). Set SHOT_DIR to also save a PNG of each page.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { DIST, navigate, page, send, skip, start, stop, until } from "./harness.mjs";

// live when the witness published data/contests/, sample otherwise: the pages must work in both
const LIVE = existsSync(join(DIST, "data", "contests", "index.json"));
const rankingDoc = JSON.parse(readFileSync(LIVE ? join(DIST, "data", "contests", "close-1.ranking.json")
  : join(DIST, "contests", "close-1", "ranking.json"), "utf8"));
// ranking v1 lists every key; v2 lists the first places, the others are in 256 shard files; v3 (since
// 2026-09-30) lists none: nothing of our recount is published
const ranking = { rows: rankingDoc.rows ?? rankingDoc.top ?? [] };
const NOBODY = "did:key:z6Mkfw79DoBMgePecy4YaXSSimwzHKYz8sB3JB9X7bKSXMkG";
// the referee's signed top list, the only ranks and scores the pages show
const idx = JSON.parse(readFileSync(LIVE ? join(DIST, "data", "contests", "index.json") : join(DIST, "..", "src", "fixtures", "contests.sample.json"), "utf8"));
const close = idx.contests.find((c) => c.id === "close-1");
const signedRows = close.leaderboard.rows;
const isSigned = (did) => signedRows.some((r) => r.did === did);
// a key our recount ranks but the referee does not sign: shown with no rank and no score
const UNSIGNED = ranking.rows.map((r) => r[1]).find((d) => !isSigned(d)) ?? NOBODY;
const withSign = (pnl) => (pnl.startsWith("-") || Number(pnl) === 0 ? pnl : `+${pnl}`);
// the registered players the referee signed at the update of its top list, when that update has them
const signedPlayers = close.series?.find((p) => p.n === close.leaderboard.sweep)?.owners;

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
  await until(`document.querySelector("[data-find-did]")?.dataset.ready !== undefined`, "the search to be ready");
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
  const text = await page(`document.querySelector("main").textContent`);
  assert.match(text, /We hold every referee update since the opening\. Our copy of the trading room starts .* after the opening/);
  assert.doesNotMatch(text, /We hold nothing from before/);
  assert.doesNotMatch(text, /appear here on their own|from the first minute/);
  const cards = await page(`[...document.querySelectorAll("article h3")].map((h) => h.textContent)`);
  assert.deepEqual(cards, ["Close Call · NVDA", "Sonnet Challenge", "Next contest"]);
  // every contest card has its pixel picture, and the whole card opens the contest
  assert.equal(await page(`document.querySelectorAll("[data-contest-card] svg[viewBox='0 0 64 30']").length`), 3);
  assert.equal(await page(`[...document.querySelectorAll("[data-contest-card] h3 a")].map((a) => a.getAttribute("href")).join(" ")`), "/contests/close-1/ /contests/sonnet-2/");
  if (LIVE) assert.doesNotMatch(await page(`document.body.textContent`), /Sample data/);
  else assert.match(await page(`document.body.textContent`), /Sample data/);
  assert.equal(await page(`document.querySelector('a[aria-current="page"]').textContent.trim().startsWith("Contests")`), true);
  await shot("contests-list");
  await shot("contests-list-mobile", 390);
});

test("a live contest shows five numbers, the chart, Find my DID and the referee's signed top list only", { skip }, async () => {
  await navigate("/contests/close-1/");
  const text = await page(`document.querySelector("main").textContent`);
  for (const part of ["NVDA", "Registered players", "#1 score", "Prize · top 3", "Find my DID", "Top traders"]) {
    assert.ok(text.includes(part), `the page shows "${part}"`);
  }
  // the players tile counts the players the referee signs, not the traders of our recount
  assert.equal(await page(`[...document.querySelectorAll("main ul li")].find((li) => li.textContent.includes("Registered players"))
    .querySelector(".font-mono").textContent`), close.latest.owners.toLocaleString("en-US"));
  assert.doesNotMatch(text, /Active traders|[\d,]+ active\b/);
  assert.deepEqual(await page(`[...document.querySelectorAll('nav[aria-label="Contest sections"] a')].map((a) => a.textContent.trim())`), ["Live", "Verify"]);
  assert.ok(await page(`document.querySelector("[data-trading-chart] canvas") !== null`), "the chart is drawn");
  // Price, Top scores and Players: the long, short and active series of our recount are not drawn
  const views = await page(`[...document.querySelectorAll("[data-view]")].map((b) => b.textContent.trim())`);
  assert.equal(views[0], "Price");
  assert.equal(views[views.length - 1], "Players");
  assert.ok(views.every((v) => ["Price", "Top scores", "Players"].includes(v)), views.join(", "));
  // the signed rows only, with the referee's ranks and signed scores, and nothing of our recount after them
  const rows = await page(`[...document.querySelectorAll("section[aria-labelledby=top-title] tbody tr")].map((tr) =>
    [Number(tr.querySelector("td").textContent.trim()), tr.querySelector("td:nth-child(2) a").getAttribute("href").split("k=")[1], tr.querySelector("td:nth-child(3)").textContent.trim()])`);
  assert.deepEqual(rows, signedRows.map((r) => [r.rank, r.did, withSign(r.pnl)]));
  // no open position: the referee signs the score, not the position
  const table = await page(`document.querySelector("section[aria-labelledby=top-title]").textContent`);
  assert.doesNotMatch(table, /Position|Long |Short |Flat/);
  assert.match(await page(`document.querySelector("#top-title").textContent`), new RegExp(`^Top ${signedRows.length}(?!\\d)`));
  assert.equal(await page(`document.querySelector("[data-top-note]").textContent.trim()`),
    `Top ${signedRows.length}, signed by the referee. The rest of the ranking returns once our recount is proved.`);
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
  await until(`document.querySelector("[data-find-did]")?.dataset.ready !== undefined`, "the search to be ready");
  await page(`(() => { const i = document.querySelector("#find-input"); i.value = ${JSON.stringify(did)};
    document.querySelector("[data-find-form]").requestSubmit(); return true; })()`);
  await until(`location.pathname === "/contests/close-1/did/"`, "the trader page");
  await until(`!document.querySelector("[data-head]").hidden`, "the trader's rank");
  return page(`document.querySelector("[data-rank]").textContent`);
}

test("Find my DID opens a signed key's page, says any other key is not in the signed top list, or refuses a malformed key", { skip }, async () => {
  const { rank, did, pnl } = signedRows[0];
  assert.equal(await openFromSearch(did), `#${rank}`);
  assert.equal(await page(`new URLSearchParams(location.search).get("k")`), did);
  assert.match(await page(`document.querySelector("[data-score]").textContent`), new RegExp(pnl.replace("-", "").replace(".", "\\.")));
  // a key our recount ranks but the referee does not sign, and a key with no trade: the same answer
  for (const other of [UNSIGNED, NOBODY]) {
    await navigate("/contests/close-1/");
    const said = await find(other);
    assert.match(said, new RegExp(`Not in the signed top ${signedRows.length}`));
    assert.match(said, /Its score shows once it can be proved/);
    assert.doesNotMatch(said, /#\d|POLF|No trade/);
    assert.equal(await page(`location.pathname`), "/contests/close-1/");
  }
  await navigate("/contests/close-1/");
  await find(UNSIGNED);
  await shot("find-did-unsigned");
  assert.match(await find("did:key:nope"), /Not a did:key/);
});

test("the saved DIDs have column labels above them, and none without a saved DID", { skip }, async () => {
  const { rank, did, pnl } = signedRows[0];
  await navigate("/contests/close-1/");
  await page(`(() => { localStorage.removeItem("roomcensus.saved"); return true; })()`);
  await navigate("/contests/close-1/");
  assert.equal(await page(`document.querySelector("[data-saved-head]").hidden`), true);
  await page(`(() => { localStorage.setItem("roomcensus.saved", JSON.stringify([{ did: ${JSON.stringify(did)}, nick: "main" }]));
    return true; })()`);
  await navigate("/contests/close-1/");
  await until(`document.querySelector("[data-saved-list] li") !== null`, "the saved DID");
  assert.equal(await page(`document.querySelector("[data-saved-head]").hidden`), false);
  assert.equal(await page(`[...document.querySelectorAll("[data-saved-head] span")].map((x) => x.innerText).join(" | ")`), "TRADER | RANK · SCORE");
  await until(`document.querySelector("[data-saved-list] li").textContent.includes("#${rank.toLocaleString("en-US")}")`, "the saved DID's rank");
  assert.ok((await page(`document.querySelector("[data-saved-list] li").textContent`)).includes(withSign(pnl)), "its signed score");
  // a saved key outside the signed top list: "–" and "not verified", no rank and no score
  await page(`(() => { localStorage.setItem("roomcensus.saved", JSON.stringify([{ did: ${JSON.stringify(did)}, nick: "main" },
    { did: ${JSON.stringify(UNSIGNED)}, nick: "alpha" }])); return true; })()`);
  await navigate("/contests/close-1/");
  await until(`document.querySelectorAll("[data-saved-list] li").length === 2`, "the two saved DIDs");
  const other = await page(`[...document.querySelectorAll("[data-saved-list] li:nth-child(2) a > span:last-child span")].map((x) => [x.textContent, x.className])`);
  assert.deepEqual(other.map(([t]) => t), ["–", "not verified"]);
  assert.match(other[1][1], /text-text-muted/);
  await shot("find-did-saved");
  await page(`(() => { localStorage.removeItem("roomcensus.saved"); return true; })()`);
});

test("Share on X opens a prefilled post on X and puts the 1200 x 675 card on the clipboard", { skip }, async () => {
  const { did } = signedRows[0];
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
  assert.match(decodeURIComponent(opened), new RegExp(signedPlayers === undefined ? "Score in .* POLF, #1, signed by the referee"
    : `Score in .* POLF, #1 of ${signedPlayers.toLocaleString("en-US")} players, signed by the referee`));
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

test("Find my DID gives each key the rank the Top list shows", { skip }, async () => {
  await navigate("/contests/close-1/");
  const table = await page(`[...document.querySelectorAll("section[aria-labelledby=top-title] tbody tr")].map((tr) =>
    [Number(tr.querySelector("td").textContent.trim()), tr.querySelector("td:nth-child(2) a").getAttribute("href").split("k=")[1]])`);
  for (const [rank, did] of [table[0], table[1], table[5], table[table.length - 1]]) {
    assert.equal(await openFromSearch(did), `#${rank.toLocaleString("en-US")}`, `${did} is #${rank} in the table`);
  }
});

test("a trader's page opens from the table with its signed rank and score, and no open position", { skip }, async () => {
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
  assert.equal(await page(`document.querySelector("[data-position]")`), null);
  assert.doesNotMatch(await page(`document.querySelector("main").textContent`), /Open position|Unrealized/);
  // the free POLF, replayed from the key's trades like its fees: a number with two decimals
  assert.match(await page(`document.querySelector("[data-cash]").textContent`), /^(\d{1,3}(,\d{3})*\.\d{2}|–)$/);
  assert.match(await page(`document.querySelector("[data-cash]").parentElement.textContent`), /Cash/);
  await shot("contest-did");
  await navigate("/contests/close-1/did/?k=nope");
  assert.match(await page(`document.querySelector("[data-problem]").textContent`), /Open this page from the contest/);
});


test("a trader's page of a key outside the signed top list shows dashes, one sentence and no Share", { skip }, async () => {
  await navigate("/contests/close-1/");
  await page(`(() => { localStorage.removeItem("roomcensus.saved"); return true; })()`);
  await navigate(`/contests/close-1/did/?k=${UNSIGNED}`);
  await until(`!document.querySelector("[data-head]").hidden && !document.querySelector("[data-unsigned]").hidden`, "the trader page and its sentence");
  assert.equal(await page(`document.querySelector("[data-unsigned]").textContent`),
    `Not in the referee's signed top ${signedRows.length}: nothing is shown for this key until it can be proved.`);
  for (const k of ["rank", "count", "fees", "cash"]) assert.equal(await page(`document.querySelector("[data-${k}]").textContent`), "–", k);
  // no score, no position, no curve, no best trade, no trade: the whole body stays hidden and empty
  assert.equal(await page(`document.querySelector("[data-body]").hidden`), true);
  assert.equal(await page(`document.querySelector("[data-best]").hidden`), true);
  assert.equal(await page(`document.querySelector("[data-score]").textContent`), "–");
  assert.equal(await page(`document.querySelector("[data-position]")`), null);
  assert.equal(await page(`document.querySelector("[data-trades]").children.length`), 0);
  assert.equal(await page(`document.querySelector("[data-problem]").classList.contains("hidden")`), true);
  // Save stays; Share on X is gone, so no score of this key can be shared
  assert.equal(await page(`getComputedStyle(document.querySelector("[data-share]")).display`), "none");
  assert.notEqual(await page(`getComputedStyle(document.querySelector("[data-save]")).display`), "none");
  await page(`document.querySelector("[data-save]").click()`);
  await until(`document.querySelector("[data-save]").getAttribute("aria-pressed") === "true"`, "Saved");
  await shot("trader-unsigned");
  await page(`(() => { localStorage.removeItem("roomcensus.saved"); return true; })()`);
});
