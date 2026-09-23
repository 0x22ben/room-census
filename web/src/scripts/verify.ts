// Verify page: hashes the snapshot and the manifest this site serves, in the reader's browser, and
// compares them with the published fingerprints. Same-origin reads only; nothing is stored or sent.
const summary = document.querySelector<HTMLElement>("[data-verify-summary-text]");
const checks = [...document.querySelectorAll<HTMLElement>("[data-check]")];
const HEX = /^[0-9a-f]{64}$/;

async function sha256(url: string): Promise<string> {
  const res = await fetch(url, { cache: "no-store", credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const digest = await crypto.subtle.digest("SHA-256", await res.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function mark(check: HTMLElement, ok: boolean, text: string) {
  check.querySelector("svg")?.remove();
  check.classList.remove("text-text-muted");
  check.classList.add(ok ? "text-accent" : "text-warning");
  // the icon is decoration: the sentence carries the result
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "18");
  icon.setAttribute("height", "18");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ok ? "M20 6 9 17l-5-5" : "M18 6 6 18M6 6l12 12");
  icon.append(path);
  check.prepend(icon);
  check.querySelector<HTMLElement>("[data-check-text]")!.textContent = text;
}

async function run() {
  if (!summary || checks.length === 0) return;
  summary.textContent = "Checking the snapshot and the manifest in your browser…";
  let passed = 0;
  for (const check of checks) {
    const url = check.dataset.url ?? "";
    const expected = check.dataset.expected ?? "";
    // same-origin files only: a protocol-relative or absolute address is never fetched
    if (new URL(url, location.href).origin !== location.origin || !HEX.test(expected)) continue;
    try {
      const got = await sha256(url);
      // a manifest is named after its own digest: the file name, the census and the bytes must agree
      const named = check.dataset.check === "manifest" ? url.endsWith(`/${expected}.json`) : true;
      if (got === expected && named) {
        passed += 1;
        mark(check, true, "Matches: checked in this browser");
      } else {
        mark(check, false, `Does not match: this browser computed ${got}`);
      }
    } catch (e) {
      mark(check, false, `Could not be checked here (${e instanceof Error ? e.message : "read failed"})`);
    }
  }
  const what = checks.length === 2 ? "The snapshot and the manifest match their fingerprints" : "The snapshot matches its fingerprint";
  summary.textContent = passed === checks.length
    ? `${what}, checked in your browser. Check the signature and the source code with the steps below.`
    : `${checks.length - passed} of ${checks.length} checks did not pass in your browser. See the steps below.`;
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
