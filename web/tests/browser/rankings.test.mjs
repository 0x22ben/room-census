// Rankings (beta) and the saved-DIDs switcher in a real headless browser: the page says it is beta and
// unofficial, shows a podium and the first hundred, pins a searched DID; a DID saved in the top bar is
// pinned too, marked on the trader page, and forgotten on demand.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { DIST, navigate, page, send, skip, start, stop, until } from "./harness.mjs";

const doc = JSON.parse(readFileSync(join(DIST, "rankings", "ranking.json"), "utf8"));
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

before(start);
after(stop);

test("rankings say beta and unofficial, and show a podium and the first hundred", { skip }, async () => {
  await navigate("/rankings/");
  const head = await page(`document.querySelector("main").textContent`);
  assert.match(head, /BETA/);
  assert.match(head, /Unofficial\. Made by Room Census, not by FLOP Labs\./);
  // a shared first place stands on one step, every DID of it (Sonnet: the 4 writers of the winning poem)
  const first = doc.rows.filter((r) => r[0] === 1).length;
  assert.equal(await page(`document.querySelectorAll("[data-podium] svg[viewBox='0 0 5 5']").length`), first > 1 ? first : Math.min(3, doc.rows.length));
  if (first > 1) assert.match(await page(`document.querySelector("[data-podium]").textContent`), /MARAGUNG-FLOP|maragung-flop/i);
  // every line says why FLOP Labs paid it; a long tie shows three lines and how many more share it
  const lines = await page(`[...document.querySelectorAll("[data-rankings] tbody:not([data-pinned]) tr[data-did]")].map((tr) => [tr.dataset.did, tr.textContent])`);
  assert.ok(lines.length > 0 && lines.length <= 100);
  lines.forEach(([did, text], i) => {
    assert.equal(did, doc.rows[i][1]);
    assert.match(text, /Wrote the poem|Voted for the winner/);
  });
  const more = await page(`[...document.querySelectorAll("[data-rankings] tr[data-more]")].map((tr) => tr.textContent.trim())`);
  const ties = Object.values(Object.groupBy(doc.rows, (r) => r[0])).filter((g) => g.length > 10);
  if (ties.length) assert.ok(more[0].startsWith(`+ ${(ties[0].length - 3).toLocaleString("en-US")} more DIDs at #${ties[0][0][0]}`), more[0]);
  assert.ok(doc.rows.every((r, i) => i === 0 || r[2] <= doc.rows[i - 1][2]), "sorted by FLOP");
  await shot("rankings");
});

test("a searched DID is pinned with its rank, and a DID with no FLOP is told so", { skip }, async () => {
  await navigate("/rankings/");
  const [rank, did] = doc.rows[doc.rows.length - 1];
  await page(`(() => { document.querySelector("#rank-input").value = ${JSON.stringify(did)}; document.querySelector("[data-rank-form]").requestSubmit(); return true; })()`);
  await until(`document.querySelector("[data-pinned] tr") !== null`, "the pinned row");
  assert.equal(await page(`document.querySelector("[data-pinned] tr td").textContent`), String(rank));
  await page(`(() => { document.querySelector("#rank-input").value = ${JSON.stringify(NOBODY)}; document.querySelector("[data-rank-form]").requestSubmit(); return true; })()`);
  await until(`/0 FLOP/.test(document.querySelector("[data-rank-result]").textContent)`, "the no-FLOP answer");
});

test("a DID signed in from the top bar shows everywhere and can be forgotten", { skip }, async () => {
  const [, did] = doc.rows[0];
  await navigate("/rankings/");
  await page(`localStorage.clear()`);
  await navigate("/rankings/");
  assert.equal(await page(`document.querySelector("[data-sw-nick]").textContent`), "Sign in");
  await page(`(() => { document.querySelector("[popovertarget=did-menu]").click(); document.querySelector("[data-sw-did]").value = ${JSON.stringify(did)};
    document.querySelector("[data-sw-form]").requestSubmit(); return true; })()`);
  await until(`document.querySelector("[data-sw-nick]").textContent === "main"`, "the saved DID in the top bar");
  await until(`[...document.querySelectorAll("[data-pinned] tr")].some((tr) => tr.dataset.pinned === ${JSON.stringify(did)})`, "the pinned saved DID");
  await shot("rankings-saved");
  await navigate(`/contests/close-1/did/?k=${did}`);
  await until(`document.querySelector("[data-save]").getAttribute("aria-pressed") === "true"`, "Saved on the trader page");
  await page(`document.querySelector("[data-save]").click()`);
  await until(`document.querySelector("[data-sw-nick]").textContent === "Sign in"`, "the DID removed everywhere");
  assert.equal(await page(`localStorage.getItem("roomcensus.saved")`), "[]");
  assert.ok(!(await page(`localStorage.getItem("roomcensus.saved.ranks") ?? ""`)).includes(did), "its cached rank is gone too");
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
  assert.equal(await page(`document.querySelector("[data-md-input]").value`), "not-a-did");
  assert.equal(await page(`document.querySelector("[data-md-count]").textContent`), "2");
  assert.equal(await page(`document.querySelector("[data-sw-nick]").textContent`), "main");
  // switch to the second one: it moves first, marked signed in, and the top bar follows
  await page(`document.querySelector("[data-md-list] tr:nth-child(2) button:not([aria-label])").click()`);
  await until(`document.querySelector("[data-md-list] tr").dataset.did === ${JSON.stringify(b)}`, "the switched DID first");
  assert.match(await page(`document.querySelector("[data-md-list] tr").textContent`), /SIGNED IN/);
  assert.equal(await page(`document.querySelector("[data-sw-nick]").textContent`), "DID 2");
  await page(`(() => { document.querySelector("[data-md-list] tr [aria-label^=Rename]").click(); const f = document.querySelector("[data-md-list] tr input");
    f.value = "long-bot"; f.blur(); return true; })()`);
  await until(`document.querySelector("[data-sw-nick]").textContent === "long-bot"`, "the new nickname in the top bar");
  await shot("my-dids");
  await page(`document.querySelector("[data-md-list] tr [aria-label^=Remove]").click()`);
  await until(`document.querySelectorAll("[data-md-list] tr").length === 1`, "one row left");
  assert.equal(await page(`document.querySelector("[data-sw-nick]").textContent`), "main");
});

test("switching DID on a trades page opens the new DID's trades", { skip }, async () => {
  const c = JSON.parse(readFileSync(join(DIST, "data", "contests", "close-1.ranking.json"), "utf8"));
  const [a, b] = (c.top ?? c.rows).slice(0, 2).map((r) => r[1]);
  await navigate("/rankings/");
  await page(`(() => { localStorage.clear(); localStorage.setItem("roomcensus.saved", JSON.stringify([{ did: ${JSON.stringify(a)}, nick: "main" }, { did: ${JSON.stringify(b)}, nick: "other" }])); return true; })()`);
  await navigate(`/contests/close-1/did/?k=${a}`);
  await until(`document.querySelector("[data-sw-list] button") !== null`, "the other DID in the menu");
  await page(`document.querySelector("[data-sw-list] button").click()`);
  await until(`new URLSearchParams(location.search).get("k") === ${JSON.stringify(b)}`, "the new DID's trades");
  await until(`document.querySelector("[data-sw-nick]").textContent === "other"`, "the switched DID in the top bar");
});
