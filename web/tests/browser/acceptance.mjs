// Acceptance check, run by hand: open a DID on the shipped Create a DID page (its restore step) from the three files
// flop_did.py writes, in a real browser, and report only what was observed.
//
//   node tests/browser/acceptance.mjs <folder holding identity.pem, passphrase.txt, did.txt>
//
// It opens the DID and stops there. It never signs, never publishes, never writes a recovery file
// and never touches the folder it is given. Every technocore.chat request is refused by this script,
// so nothing can reach the network even if the page tried. Nothing it prints comes from the files
// except the DID, which is public by design.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { listeners, navigate, page, send, site, skip, start, stop, until } from "./harness.mjs";

const folder = resolve(process.argv[2] ?? "");
if (skip) {
  console.log(`cannot run: ${skip}`);
  process.exit(1);
}

const q = (sel) => JSON.stringify(sel);
const text = (sel) => page(`document.querySelector(${q(sel)})?.textContent.trim() ?? null`);
const visible = (sel) => page(`(() => { const e = document.querySelector(${q(sel)}); return !!e && !e.hidden && !e.closest("[hidden]"); })()`);

const requests = [];
await start();
try {
  listeners.clear();
  listeners.add(async (msg) => {
    if (msg.method === "Network.requestWillBeSent") requests.push(msg.params.request.url);
    if (msg.method !== "Fetch.requestPaused") return;
    // nothing reaches technocore.chat from this check, whatever the page does
    await send("Fetch.failRequest", { requestId: msg.params.requestId, errorReason: "BlockedByClient" }).catch(() => {});
  });
  await send("Network.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://technocore.chat/*", requestStage: "Request" }] });
  await navigate("/did/");
  await until("!document.querySelector('[data-wizard]').hidden", "the page script");
  await page(`document.querySelector("[data-action=begin-restore]").click()`);
  const loaded = requests.length;

  const { root } = await send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "[data-restore-file]" });
  await send("DOM.setFileInputFiles", { nodeId, files: ["identity.pem", "passphrase.txt", "did.txt"].map((n) => join(folder, n)) });
  await page(`document.querySelector("[data-restore]").requestSubmit()`);
  await until("!document.querySelector('[data-panel=message]').hidden || document.querySelector('[data-error=restore]').textContent !== ''", "the page to answer");

  const shown = (await page(`[...document.querySelectorAll("[data-did-value]")].map((e) => e.textContent.trim()).find(Boolean) ?? null`));
  const expected = readFileSync(join(folder, "did.txt"), "utf8").trim();
  const asked = requests.slice(loaded).filter((url) => !url.startsWith(site.origin));
  console.log(`DID shown matches did.txt   : ${shown === expected ? "yes" : "no"}`);
  console.log(`DID                         : ${shown ?? "(none)"}`);
  console.log(`requests while opening      : ${asked.length}${asked.length ? ` (${asked.join(", ")})` : ""}`);
  console.log(`composer visible            : ${await visible("[data-panel=message]")}`);
  console.log(`restore error               : ${(await text("[data-error=restore]")) || "(none)"}`);
  console.log(`preview or outcome shown    : ${(await visible("[data-preview]")) || (await visible("[data-panel=outcome]"))}`);
  assert.equal(shown, expected);
  assert.equal(asked.length, 0);
} finally {
  await stop();
}
