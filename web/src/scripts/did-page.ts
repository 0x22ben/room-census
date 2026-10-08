// The trading page of one key: reads ?k=, its ranking line and its settled trades, then replays the
// trades with the contest's accounting (close_call_fold.py: first in, first out, fees taken from cash)
// to show the best trades, the open position and every trade. Numbers here are floating point, for
// display: the ranking line carries the recounted score itself. No chart: the contest is over.
import { Account, MINT, verifiedTrades } from "../lib/fold-lite.mjs";
import { isSaved, remove, save } from "../lib/saved-store";
import { drawCard, shareOnX, type Card } from "./pnl-card";
import { filesOf, lookup, tradesOf, type Signed } from "./ranking-lookup";

type Trade = [number, "b" | "s" | "x", string, string, string];
type Mark = [number, number, string];

const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}`;
const tone = (v: number) => (v > 0 ? "text-accent" : v < 0 ? "text-down" : "text-text-secondary");
const n = (v: number) => v.toLocaleString("en-US");

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function ago(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

function init(root: HTMLElement) {
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const did = new URLSearchParams(location.search).get("k")?.trim() ?? "";
  const problem = (text: string) => { const p = q("[data-problem]"); p.textContent = text; p.classList.remove("hidden"); };
  if (!DID.test(did)) {
    problem("Open this page from the contest: pick a trader in the Top 100 or search a DID.");
    return;
  }
  const short = `${did.slice(8, 16)}…${did.slice(-6)}`;
  // Save / Saved: keeps this DID in the browser, for the top bar and every page
  const saveBtn = q("[data-save]");
  const drawSave = () => {
    const on = isSaved(did);
    saveBtn.setAttribute("aria-pressed", String(on));
    q("[data-save-label]").textContent = on ? "Saved" : "Save";
  };
  saveBtn.addEventListener("click", () => { if (isSaved(did)) remove(did); else save(did); drawSave(); });
  window.addEventListener("roomcensus:saved", drawSave);
  drawSave();
  q("[data-crumb]").textContent = short;
  document.title = `${short} · ${document.title}`;
  const signedList: Signed[] = JSON.parse(root.dataset.signed ?? "[]");
  const marks: Mark[] = JSON.parse(root.dataset.marks ?? "[]");
  const opening = Date.parse(root.dataset.opening ?? "");
  const files = filesOf(root)!;

  (async () => {
    let found;
    try {
      found = await lookup(files, did, signedList);
    } catch {
      problem("The ranking could not be read. Try again in a moment.");
      return;
    }
    const row = found.row;
    if (!row) {
      problem("No trade yet: this key has no settled trade in our capture.");
      return;
    }
    const trades = await tradesOf(files, did);
    const score = Number(row[2]);
    const official = row[3] === "official" || row[3] === "signed";

    q("[data-head]").hidden = false;
    q("[data-body]").hidden = false;
    q("[data-short]").textContent = short;
    q("[data-source]").textContent = official ? " · signed by the referee" : "";
    q("[data-rank]").textContent = `#${n(row[0])}`;
    const scoreEl = q("[data-score]");
    scoreEl.textContent = signed(score);
    scoreEl.classList.add(tone(score));
    q("[data-copy]").addEventListener("click", () => navigator.clipboard?.writeText(did));

    // replay the trades after each update
    const acct = new Account();
    const best: { gain: number; t: Trade }[] = [];
    const curve: { at: string; v: number }[] = [];
    if (trades && trades.length) {
      // trades in the order they settled; an update without a posted price still settles its trades
      const first = trades[0][0];
      let i = 0;
      const settle = (upTo: number) => {
        for (; i < trades.length && trades[i][0] <= upTo; i++) {
          const t = trades[i];
          const gain = acct.applyTrade(t);
          if (t[1] !== "x") best.push({ gain, t });
        }
      };
      // up to the ranking's sweep only: a later trade of this key is not published yet
      for (const [sweep, mark, at] of marks.filter((m) => m[0] <= found.sweep)) {
        settle(sweep);
        if (sweep >= first) curve.push({ at, v: acct.value(mark) - MINT });
      }
      settle(Infinity);
    }
    // The replay must land on the ranking line: the same open position at the same entry. Some keys'
    // published trades do not add up (a trade missing from the history inherited before sweep 975): then
    // nothing computed from them is shown, only the rank, the score and the position (Ben, 2026-09-29:
    // never a wrong figure)
    const complete = !trades || verifiedTrades(trades, marks, found.sweep, row[2], row[4]);
    const shown = trades && complete;
    q("[data-count]").textContent = shown ? n(trades.length) : "–";
    q("[data-fees]").textContent = shown ? acct.fees.toFixed(2) : "–";
    // the POLF this key still has free: not locked as collateral in its open position (Ben, 2026-09-29)
    q("[data-cash]").textContent = shown ? acct.cash.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "–";
    if (!complete) {
      const note = q("[data-no-trades]");
      note.textContent = "Part of this key's trade history is missing from our capture, so nothing is computed from it here.";
      note.classList.remove("hidden");
      note.dataset.incomplete = "";
    }

    // best trades: what each one realized, fees included
    const top = complete ? best.filter((b) => b.gain > 0).sort((a, b) => b.gain - a.gain).slice(0, 5) : [];
    if (top.length) {
      const list = q("[data-best]");
      list.hidden = false;
      top.forEach(({ gain, t }, i) => {
        const li = el("li", "grid gap-1 rounded-xl border border-border bg-surface px-4 py-3");
        li.append(el("span", `text-xs font-semibold ${i === 0 ? "text-warning" : "text-text-muted"}`, `Best #${i + 1}`));
        const v = el("span", "flex flex-wrap items-baseline gap-2");
        v.append(el("span", "font-mono text-lg font-semibold text-accent", signed(gain)),
          el("span", "font-mono text-xs text-text-muted", `${t[1] === "b" ? "Buy" : "Sell"} ${t[2]} @ ${t[3]}`));
        li.append(v);
        list.append(li);
      });
    }

    // a key without published trades says so (the incomplete case above has its own sentence)
    if (complete && !trades) q("[data-no-trades]").classList.remove("hidden");

    // open position: from the ranking line, valued at the ranking's sweep, where the line is true
    const pos = row[4];
    const mark = marks.find((m) => m[0] === found.sweep)?.[1];
    const body = q("[data-position]");
    const tr = el("tr", "border-t border-border");
    if (pos === undefined || pos === null || mark === undefined) {
      tr.append(el("td", "px-4 py-3 text-text-muted sm:px-5", pos === null ? "Flat" : "–"));
      for (let i = 0; i < 4; i++) tr.append(el("td", "px-4 py-3"));
    } else {
      const qty = Number(pos[0]), entry = Number(pos[1]);
      const upnl = qty > 0 ? qty * (mark - entry) : -qty * (entry - mark);
      const side = qty > 0 ? "Long" : "Short";
      tr.append(el("td", "px-4 py-3 sm:px-5", ""), el("td", "px-4 py-3 font-mono", Math.abs(qty).toFixed(2)), el("td", "px-4 py-3 font-mono", entry.toFixed(2)),
        el("td", "px-4 py-3 font-mono", mark.toFixed(2)), el("td", `px-4 py-3 text-right font-mono font-semibold sm:px-5 ${tone(upnl)}`, signed(upnl)));
      tr.firstElementChild!.append(el("span", `rounded-md px-2 py-0.5 text-xs font-semibold ${side === "Long" ? "bg-accent-soft text-accent" : "bg-down-soft text-down"}`, side));
    }
    body.append(tr);

    // every trade, newest first
    const list = q("[data-trades]");
    const draw = (filter: string) => {
      list.replaceChildren();
      const rows = (shown && trades ? trades : []).slice().reverse().filter((t) => filter === "All" || (filter === "Buy" ? t[1] === "b" : t[1] === "s"));
      if (!rows.length) {
        const r = el("tr", "border-t border-border");
        const td = el("td", "px-4 py-3 text-text-muted sm:px-5", !complete ? "Part of this key's trade history is missing from our capture, so nothing is computed from it here."
          : trades ? "No trade." : "The trades of this key appear here within the hour.");
        td.setAttribute("colspan", "4");
        r.append(td);
        list.append(r);
        return;
      }
      for (const t of rows) {
        const r = el("tr", "border-t border-border");
        const side = t[1] === "b" ? "Buy" : t[1] === "s" ? "Sell" : "Fee";
        const pill = el("span", `rounded-md px-2 py-0.5 text-xs font-semibold ${t[1] === "b" ? "bg-accent-soft text-accent" : t[1] === "s" ? "bg-down-soft text-down" : "bg-surface-raised text-text-secondary"}`, side);
        const c1 = el("td", "px-4 py-2.5 sm:px-5");
        c1.append(pill);
        r.append(c1, el("td", "px-4 py-2.5 font-mono", t[2]), el("td", "px-4 py-2.5 text-right font-mono", t[3]),
          el("td", "px-4 py-2.5 text-right font-mono text-xs text-text-muted sm:px-5", ago(new Date(opening + 300_000 * t[0]).toISOString())));
        list.append(r);
      }
    };
    draw("All");
    root.querySelectorAll<HTMLElement>("[data-filter]").forEach((b) => b.addEventListener("click", () => {
      root.querySelectorAll<HTMLElement>("[data-filter]").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
      draw(b.dataset.filter!);
    }));

    // share: the score card; it always says Score, since a saved DID proves no ownership
    const cardData: Card = { did, score, rank: row[0], traders: found.traders, contest: root.dataset.contest ?? "", official,
      sweep: found.sweep, position: pos === undefined ? undefined : pos === null ? "Flat" : `${Number(pos[0]) > 0 ? "Long" : "Short"} ${Math.abs(Number(pos[0])).toFixed(1)}`,
      line: signedList.length >= 3 ? Number(signedList[2].pnl) : undefined,
      prices: complete && curve.length > 1 ? curve.map((p) => p.v) : marks.map((m) => m[1]),
      curveLabel: complete && curve.length > 1 ? "SCORE" : "NVDA", mine: false,
      trades: shown ? trades.length : undefined, best: top.length ? top[0].gain : undefined };
    // drawn once, as soon as the page has its numbers; a click before it is ready waits for it
    const ready = drawCard(cardData);
    ready.catch(() => undefined);
    q("[data-share]").addEventListener("click", () => {
      const paste = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘V" : "Ctrl+V";
      const status = q("[data-share-status]");
      status.textContent = "Making the picture…";
      const intent = shareOnX(cardData, `${root.dataset.page}?k=${encodeURIComponent(did)}`, ready, (how, opened) => {
        status.textContent = how === "copied" ? `Picture copied: paste it in your post (${paste}).`
          : how === "downloaded" ? "Picture downloaded: add it to your post." : "The picture could not be copied.";
        if (!opened) {
          const a = document.createElement("a");
          a.href = intent;
          a.target = "_blank";
          a.rel = "noopener";
          a.className = "ml-1 font-semibold text-link";
          a.textContent = "Open the post on X";
          status.append(" ", a);
        }
      });
    });
  })();
}

document.querySelectorAll<HTMLElement>("[data-did-page]").forEach(init);
