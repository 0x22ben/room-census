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
  assert.equal(await page(`document.querySelectorAll("[data-podium] svg[viewBox='0 0 5 5']").length`), 3);
  const rows = await page(`document.querySelectorAll("[data-rankings] tbody:not([data-pinned]) tr").length`);
  assert.equal(rows, Math.min(100, doc.rows.length));
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

test("a DID saved in the top bar shows everywhere and can be forgotten", { skip }, async () => {
  const [, did] = doc.rows[0];
  await navigate("/rankings/");
  await page(`localStorage.clear()`);
  await navigate("/rankings/");
  assert.equal(await page(`document.querySelector("[data-sw-nick]").textContent`), "Save a DID");
  await page(`(() => { document.querySelector("[popovertarget=did-menu]").click(); document.querySelector("#sw-add-input").value = ${JSON.stringify(did)};
    document.querySelector("[data-sw-add]").requestSubmit(); return true; })()`);
  await until(`document.querySelector("[data-sw-nick]").textContent === "main"`, "the saved DID in the top bar");
  await until(`[...document.querySelectorAll("[data-pinned] tr")].some((tr) => tr.dataset.pinned === ${JSON.stringify(did)})`, "the pinned saved DID");
  await shot("rankings-saved");
  await navigate(`/contests/close-1/did/?k=${did}`);
  await until(`document.querySelector("[data-save]").getAttribute("aria-pressed") === "true"`, "Saved on the trader page");
  await page(`document.querySelector("[data-save]").click()`);
  await until(`document.querySelector("[data-sw-nick]").textContent === "Save a DID"`, "the DID removed everywhere");
  assert.equal(await page(`localStorage.getItem("roomcensus.saved")`), "[]");
});
