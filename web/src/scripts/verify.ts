// Verify page. Three checks run in the reader's browser, each ending in one of three states: passed,
// failed, or could not be checked. A network error, a timeout or a missing message is never a pass.
// - snapshot and manifest: hashes of the files this site serves, against the published fingerprints;
// - signed message: the public room-census export read from technocore.chat, the message found by
//   its DID and nonce, its text checked for both fingerprints, its Ed25519 signature checked locally.
// Only GET reads leave the browser; no DID or other value is sent, and nothing is stored.
import { carriesFingerprints, check, findMessage, importKey, publicKey, readExport, TECHNOCORE, validRoom } from "../lib/did-core.mjs";

type Outcome = { state: "pass" | "fail" | "unchecked"; text: string };
const summary = document.querySelector<HTMLElement>("[data-verify-summary-text]");
const checks = [...document.querySelectorAll<HTMLElement>("[data-check]")];
const HEX = /^[0-9a-f]{64}$/;
const TIMEOUT_MS = 10000;

async function sha256(url: string): Promise<string> {
  const res = await fetch(url, { cache: "no-store", credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const digest = await crypto.subtle.digest("SHA-256", await res.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fingerprint(el: HTMLElement): Promise<Outcome> {
  const url = el.dataset.url ?? "";
  const expected = el.dataset.expected ?? "";
  // same-origin files only: a protocol-relative or absolute address is never fetched
  if (new URL(url, location.href).origin !== location.origin || !HEX.test(expected)) {
    return { state: "unchecked", text: "Could not be checked: this page names no readable file" };
  }
  try {
    const got = await sha256(url);
    // a manifest is named after its own digest: the file name, the census and the bytes must agree
    const named = el.dataset.check === "manifest" ? url.endsWith(`/${expected}.json`) : true;
    return got === expected && named
      ? { state: "pass", text: "Matches: checked in this browser" }
      : { state: "fail", text: `Failed: does not match, this browser computed ${got}` };
  } catch (e) {
    return { state: "unchecked", text: `Could not be checked here (${e instanceof Error ? e.message : "read failed"})` };
  }
}

async function signature(el: HTMLElement): Promise<Outcome> {
  const { room = "", nonce = "", did = "", sha256: sha = "", manifest = "" } = el.dataset;
  const raw = publicKey(did);
  if (!validRoom(room) || !/^\d{1,19}$/.test(nonce) || !raw || !HEX.test(sha) || (manifest !== "" && !HEX.test(manifest))) {
    return { state: "unchecked", text: "Could not be checked: this page names no readable census message" };
  }
  const key = await importKey(crypto.subtle, raw);
  if (!key) return { state: "unchecked", text: "Could not be checked: this browser cannot check Ed25519 signatures" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let body: string;
  try {
    const res = await fetch(`${TECHNOCORE}/r/${room}/export`, {
      signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
    });
    if (!res.ok) return { state: "unchecked", text: `Could not be checked: technocore.chat answered HTTP ${res.status}` };
    body = await res.text();
  } catch {
    return {
      state: "unchecked",
      text: controller.signal.aborted
        ? `Could not be checked: no answer from technocore.chat within ${TIMEOUT_MS / 1000} seconds`
        : "Could not be checked: technocore.chat could not be reached",
    };
  } finally {
    clearTimeout(timer);
  }
  const message = findMessage(readExport(body), did, nonce);
  if (!message) return { state: "unchecked", text: "Could not be checked: the room export holds no message from the Room Census DID with this nonce" };
  if ((await check(crypto.subtle, key, did, room, message)) !== "checked") {
    return { state: "fail", text: "Failed: the signature does not match this message" };
  }
  if (!carriesFingerprints(message.text, sha, manifest === "" ? null : manifest)) {
    return { state: "fail", text: "Failed: the signed message does not name the fingerprints of steps 1 and 2" };
  }
  return { state: "pass", text: "Valid signature from the Room Census DID, and it names both fingerprints: checked in this browser" };
}

const PATHS = { pass: "M20 6 9 17l-5-5", fail: "M18 6 6 18M6 6l12 12", unchecked: "M12 8v4M12 16h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0" };
const COLOR = { pass: "text-accent", fail: "text-warning", unchecked: "text-text-secondary" };

function show(el: HTMLElement, o: Outcome) {
  el.querySelector("svg")?.remove();
  el.classList.remove("text-text-muted");
  el.classList.add(COLOR[o.state]);
  el.dataset.state = o.state;
  // the icon is decoration: the sentence carries the result
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "18", height: "18", "aria-hidden": "true", fill: "none",
    stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" })) icon.setAttribute(k, v);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", PATHS[o.state]);
  icon.append(path);
  el.prepend(icon);
  el.querySelector<HTMLElement>("[data-check-text]")!.textContent = o.text;
}

async function run() {
  if (!summary || checks.length === 0) return;
  summary.textContent = "Checking in your browser…";
  const outcomes = await Promise.all(checks.map(async (el) => {
    const o = el.dataset.check === "signature" ? await signature(el) : await fingerprint(el);
    show(el, o);
    return o;
  }));
  const failed = outcomes.filter((o) => o.state === "fail").length;
  const unchecked = outcomes.filter((o) => o.state === "unchecked").length;
  const code = "The source code still needs the Git command in step 4.";
  summary.textContent = failed + unchecked === 0
    ? `All ${outcomes.length} checks that run in your browser passed. ${code}`
    : [`${outcomes.length - failed - unchecked} of ${outcomes.length} checks passed in your browser`,
       failed ? `${failed} failed` : "", unchecked ? `${unchecked} could not be checked` : ""].filter(Boolean).join(", ")
      + `. See the steps below. ${code}`;
}

// copy the DID for My DID; the button only exists for readers with script
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
  const label = button.querySelector<HTMLElement>("[data-copy-label]");
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy ?? "");
      if (label) label.textContent = "Copied";
    } catch {
      if (label) label.textContent = "Select and copy it";
    }
    setTimeout(() => { if (label) label.textContent = "Copy"; }, 2000);
  });
  button.hidden = false;
}

run();
