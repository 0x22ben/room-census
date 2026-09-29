// Page views, counted with GoatCounter (Ben, 2026-09-29): no cookie, and only the page's path is sent,
// never its query or its hash (a DID looked up in ?k= stays in this browser), with no referrer. It counts
// on roomcensus.xyz only, never in a preview or a test. Opening any page with #toggle-goatcounter switches
// the counting off in this browser (a flag in localStorage), and back on the next time.
import { GOATCOUNTER } from "../lib/goatcounter.mjs";

const SKIP = "skipgc";

function skipped(): boolean {
  try {
    if (location.hash === "#toggle-goatcounter") {
      if (localStorage.getItem(SKIP) === "t") localStorage.removeItem(SKIP);
      else localStorage.setItem(SKIP, "t");
    }
    return localStorage.getItem(SKIP) === "t";
  } catch {
    return false;                                   // storage blocked: count as any visitor
  }
}

if (location.hostname === "roomcensus.xyz" && !navigator.webdriver && !skipped()) {
  const url = `${GOATCOUNTER}/count?p=${encodeURIComponent(location.pathname)}&rnd=${Math.random().toString(36).slice(2)}`;
  fetch(url, { mode: "no-cors", referrerPolicy: "no-referrer", credentials: "omit", keepalive: true }).catch(() => {});
}
