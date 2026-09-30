// The Winners section of Sonnet's page in a real headless browser: the totals, the authors of the winning
// poem, the voters, and "Was my DID paid?" for an author, a voter, an unknown DID and a malformed input.
// Set SHOT_DIR to also save a PNG of the page.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { WEB, navigate, page, send, skip, start, stop, until } from "./harness.mjs";

const lines = readFileSync(join(WEB, "src", "data", "flop-labs", "sonnet-2.allocations.csv"), "utf8").split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(","));
const AUTHOR = lines.find((f) => f[1] === "contributor");
const VOTER = lines.find((f) => f[1] === "voter");
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

async function check(did) {
  await until(`document.querySelector("[data-paid-check]")?.dataset.ready !== undefined`, "the check to be ready");
  await page(`(() => { document.querySelector("[data-paid-result]").textContent = ""; document.querySelector("#paid-input").value = ${JSON.stringify(did)};
    document.querySelector("[data-paid-form]").requestSubmit(); return true; })()`);
  await until(`/^(Paid|Not)/.test(document.querySelector("[data-paid-result]").textContent)`, "an answer");
  return page(`document.querySelector("[data-paid-result]").textContent`);
}

before(start);
after(stop);

test("Sonnet's results keep the three tiles and list the winners", { skip }, async () => {
  await navigate("/contests/sonnet-2/");
  const main = await page(`document.querySelector("main").textContent`);
  for (const t of ["Winner", "Prize", "Rules"]) assert.ok(main.includes(t), t);
  assert.equal(await page(`document.querySelector("#winners-title").textContent`), "Winners");
  assert.equal(await page(`document.querySelector("[data-winners-total]").textContent`), "97,964 FLOP paid to 6,856 DIDs");
  assert.match(main, /Winning poem · maragung-flop/);
  assert.match(main, /4 authors · 50,000 FLOP/);
  const authors = await page(`[...document.querySelectorAll("[data-author]")].map((li) => [li.dataset.author, li.innerText.replace(/\\s+/g, " ").trim()])`);
  assert.equal(authors.length, 4);
  for (const [did, text] of authors) {
    assert.ok(lines.some((f) => f[0] === did && f[1] === "contributor"), did);
    assert.equal(text, `${did.slice(8, 16)}…${did.slice(-5)} Author 12,500 FLOP`);
  }
  assert.equal(await page(`document.querySelector("[data-voters]").textContent`), "6,852 voters · 7 FLOP each · 47,964 FLOP");
  assert.match(main, /From FLOP Labs' payout list, byte for byte the one the referee signed \(settlement receipt, seq 45498\)\./);
  assert.ok(!main.includes(String.fromCharCode(0x2014)), "no em dash");
});

test("Was my DID paid? answers an author, a voter, an unknown DID and a malformed input", { skip }, async () => {
  await navigate("/contests/sonnet-2/");
  assert.equal(await check(AUTHOR[0]), "Paid 12,500 FLOP, as an author.");
  assert.equal(await check(VOTER[0]), `Paid ${Number(VOTER[3]).toLocaleString("en-US")} FLOP, as a voter.`);
  await shot("sonnet-2");
  assert.equal(await check(NOBODY), "Not in the payout list.");
  assert.equal(await check("did:key:z6Mk-not-a-key"), "Not a did:key: it starts with did:key:z6Mk and has 56 characters.");
});
