// Rankings (beta) and the saved-DIDs switcher in a real headless browser: the page is paused until our
// recount is proved and shows no ranking (Ben, 2026-09-29: never show a wrong figure); a DID saved in
// the top bar is marked on the trader page and forgotten on demand; My DIDs ranks only the keys of the
// referee's signed top list.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { DIST, navigate, page, send, skip, start, stop, until } from "./harness.mjs";

const doc = JSON.parse(readFileSync(join(DIST, "rankings", "ranking.json"), "utf8"));
// the referee's signed top list of the live contest: the only ranks and scores the saved DIDs show
const INDEX = join(DIST, "data", "contests", "index.json");
const contests = JSON.parse(readFileSync(existsSync(INDEX) ? INDEX : join(DIST, "..", "src", "fixtures", "contests.sample.json"), "utf8"));
const signedRows = contests.contests.find((c) => c.id === "close-1").leaderboard.rows;

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

before(start);
after(stop);

test("rankings are paused until our recount is proved, and show no ranking", { skip }, async () => {
  await navigate("/rankings/");
  const main = await page(`document.querySelector("main").textContent`);
  assert.match(main, /BETA/);
  assert.match(main, /Unofficial\. Made by Room Census, not by FLOP Labs\./);
  assert.match(main, /Paused: the ranking returns once our recount is proved\./);
  // no podium, no table, no search, no DID
  assert.equal(await page(`document.querySelectorAll("main table, main form, [data-podium], [data-rankings]").length`), 0);
  assert.doesNotMatch(main, /z6Mk[1-9A-HJ-NP-Za-km-z]{44}|\d FLOP/);
  // the sidebar still leads here, marked as the current page
  assert.equal(await page(`document.querySelector('nav[aria-label="Primary"] a[aria-current="page"]').getAttribute("href")`), "/rankings/");
  await shot("rankings-paused");
});

test("a DID signed in from the top bar is marked on its trader page and can be forgotten", { skip }, async () => {
  const [, did] = doc.rows[0];
  await navigate("/rankings/");
  await page(`localStorage.clear()`);
  await navigate("/rankings/");
  assert.equal(await page(`document.querySelector("[data-sw-nick]").textContent`), "Sign in");
  await page(`(() => { document.querySelector("[popovertarget=did-menu]").click(); document.querySelector("[data-sw-did]").value = ${JSON.stringify(did)};
    document.querySelector("[data-sw-form]").requestSubmit(); return true; })()`);
  await until(`document.querySelector("[data-sw-nick]").textContent === "main"`, "the saved DID in the top bar");
  // a rank cached by an earlier version of the site: it names the DID, so it goes with it
  await page(`(() => { localStorage.setItem("roomcensus.saved.ranks", JSON.stringify({ ${JSON.stringify(did)}: { at: Date.now(), r: { rank: 7, pnl: "1.00" } } })); return true; })()`);
  await navigate(`/contests/close-1/did/?k=${did}`);
  await until(`document.querySelector("[data-save]").getAttribute("aria-pressed") === "true"`, "Saved on the trader page");
  await page(`document.querySelector("[data-save]").click()`);
  await until(`document.querySelector("[data-sw-nick]").textContent === "Sign in"`, "the DID removed everywhere");
  assert.equal(await page(`localStorage.getItem("roomcensus.saved")`), "[]");
  assert.equal(await page(`localStorage.getItem("roomcensus.saved.ranks")`), "{}", "its cached rank is gone too");
});

test("My DIDs adds many at once, renames, switches and removes", { skip }, async () => {
  const [a, b] = [doc.rows[0][1], doc.rows[1][1]];
  await navigate("/my-dids/");
  await page(`localStorage.clear()`);
  await navigate("/my-dids/");
  await page(`(() => { const t = document.querySelector("[data-md-input]"); t.value = ${JSON.stringify(`${a}\nnot-a-did\n${b}\n${a}`)};
    t.dispatchEvent(new Event("input")); return true; })()`);
  assert.equal(await page(`document.querySelector("[data-md-submit]").textContent`), "Add 2 DIDs");
  await page(`(() => { document.querySelector("[data-md-add]").requestSubmit(); return true; })()`);
  await until(`document.querySelectorAll("[data-md-list] tr").length === 2`, "the two rows");
  assert.match(await page(`document.querySelector("[data-md-hint]").textContent`), /2 DIDs added\. 1 not a did:key\./);
  // a rank and a score only for a key of the signed top list; any other: "–", not verified
  for (const did of [a, b]) {
    const line = signedRows.find((r) => r.did === did);
    const cells = await page(`[...document.querySelector('[data-md-list] tr[data-did="${did}"]').children].slice(1, 3).map((td) => td.textContent)`);
    assert.deepEqual(cells, line ? [`#${line.rank}`, Number(line.pnl) > 0 ? `+${line.pnl}` : line.pnl] : ["–", "not verified"]);
  }
  assert.equal(await page(`document.querySelector("[data-md-input]").value`), "not-a-did");
  assert.equal(await page(`document.querySelector("[data-md-count]").textContent`), "2");
  assert.equal(await page(`document.querySelector("[data-sw-nick]").textContent`), "main");
  // switch to the second one: it moves first, marked signed in, and the top bar follows
  await page(`document.querySelector("[data-md-list] tr:nth-child(2) button:not([aria-label])").click()`);
  await until(`document.querySelector("[data-md-list] tr").dataset.did === ${JSON.stringify(b)}`, "the switched DID first");
  assert.match(await page(`document.querySelector("[data-md-list] tr").textContent`), /SIGNED IN/);
  assert.equal(await page(`document.querySelector("[data-sw-nick]").textContent`), "DID 2");
  await page(`(() => { document.querySelector("[data-md-list] tr [aria-label^=Rename]").click(); const f = document.querySelector("[data-md-list] tr input");
    f.value = "long-bot"; f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); return true; })()`);
  await until(`document.querySelector("[data-sw-nick]").textContent === "long-bot"`, "the new nickname in the top bar");
  await shot("my-dids");
  await page(`document.querySelector("[data-md-list] tr [aria-label^=Remove]").click()`);
  await until(`document.querySelectorAll("[data-md-list] tr").length === 1`, "one row left");
  assert.equal(await page(`document.querySelector("[data-sw-nick]").textContent`), "main");
});

test("the account menu ranks a key of the signed top list, and shows any other as not verified", { skip }, async () => {
  const { rank, did, pnl } = signedRows[0];
  const other = doc.rows.map((r) => r[1]).find((d) => !signedRows.some((r) => r.did === d));
  await navigate("/my-dids/");
  await page(`(() => { localStorage.clear(); localStorage.setItem("roomcensus.saved", JSON.stringify([{ did: ${JSON.stringify(did)}, nick: "main" }, { did: ${JSON.stringify(other)}, nick: "alpha" }])); return true; })()`);
  await navigate("/my-dids/");
  await until(`document.querySelector("[data-sw-nick]").textContent === "main"`, "the saved DID in the top bar");
  assert.equal(await page(`document.querySelector("[data-sw-rank]").textContent`), `#${rank}`);
  assert.equal(await page(`document.querySelector("[data-sw-me-rank]").textContent`), `#${rank}`);
  assert.equal(await page(`document.querySelector("[data-sw-me-pnl]").textContent`), Number(pnl) > 0 ? `+${pnl}` : pnl);
  assert.deepEqual(await page(`[...document.querySelectorAll("[data-sw-list] button > span:last-child span")].map((x) => x.textContent)`), ["–", "not verified"]);
  await page(`localStorage.clear()`);
});

test("switching DID on a trades page opens the new DID's trades", { skip }, async () => {
  const c = JSON.parse(readFileSync(join(DIST, "data", "contests", "close-1.ranking.json"), "utf8"));
  // ranking v3 (since 2026-09-30) lists no key: the referee's signed top list then gives the two keys
  const [a, b] = (c.top ?? c.rows ?? signedRows.map((r) => [r.rank, r.did])).slice(0, 2).map((r) => r[1]);
  await navigate("/rankings/");
  await page(`(() => { localStorage.clear(); localStorage.setItem("roomcensus.saved", JSON.stringify([{ did: ${JSON.stringify(a)}, nick: "main" }, { did: ${JSON.stringify(b)}, nick: "other" }])); return true; })()`);
  await navigate(`/contests/close-1/did/?k=${a}`);
  await until(`document.querySelector("[data-sw-list] button") !== null`, "the other DID in the menu");
  await page(`document.querySelector("[data-sw-list] button").click()`);
  await until(`new URLSearchParams(location.search).get("k") === ${JSON.stringify(b)}`, "the new DID's trades");
  await until(`document.querySelector("[data-sw-nick]").textContent === "other"`, "the switched DID in the top bar");
});
