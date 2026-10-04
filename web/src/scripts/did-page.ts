// The trading page of one key: reads ?k=, its ranking line and its settled trades, then replays the
// trades with the contest's accounting (close_call_fold.py: first in, first out, fees taken from cash)
// to draw the score after each referee update, the best trades and the open position. Numbers here are
// floating point, for display: the ranking line carries the recounted score itself. When a key of the
// referee's signed list has trades that do not add up, its curve is drawn from the referee's own signed
// scores instead (leaderboard.history, data-history), exact at every point it has.
import { CategoryScale, Chart, Filler, LinearScale, LineController, LineElement, PointElement, Tooltip } from "chart.js";
import { Account, MINT, verifiedTrades } from "../lib/fold-lite.mjs";
import { robustRange } from "../lib/robust-range.mjs";
import { dayChange, signedCurve, withBreaks } from "../lib/signed-history.mjs";
import { isSaved, remove, save } from "../lib/saved-store";
import { drawCard, shareOnX, type Card } from "./pnl-card";
import { filesOf, lookup, tradesOf, type Signed } from "./ranking-lookup";

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Filler);

type Trade = [number, "b" | "s" | "x", string, string, string];
type Mark = [number, number, string];

const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
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
  const history: Record<string, [number, number][]> = JSON.parse(root.dataset.history ?? "{}");
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
    // no replayed curve for a key of the signed list (its trades do not add up, or are not published
    // yet): its curve comes from the referee's signed scores, at the updates where it was listed
    const listed = signedList.some((s) => s.did === did);
    const own = listed && !shown ? signedCurve(history[did], marks) : [];
    const fromSigned = own.length > 1;
    q("[data-count]").textContent = shown ? n(trades.length) : "–";
    q("[data-fees]").textContent = shown ? acct.fees.toFixed(2) : "–";
    // the POLF this key still has free: not locked as collateral in its open position (Ben, 2026-09-29)
    q("[data-cash]").textContent = shown ? acct.cash.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "–";
    if (!complete) {
      const note = q("[data-no-trades]");
      note.textContent = fromSigned
        ? "The curve shows the referee's signed scores, at the updates where this key was in its signed top list. Part of this key's trade history is missing from our capture, so its trades, fees and cash are not computed here."
        : "Part of this key's trade history is missing from our capture, so nothing is computed from it here.";
      note.classList.remove("hidden");
      note.dataset.incomplete = "";
    }

    // score over a day before now, when there is enough history: replayed, or both signed ends
    const day = fromSigned ? dayChange(history[did]) : complete && curve.length > 288 ? curve[curve.length - 1].v - curve[curve.length - 289].v : undefined;
    if (day !== undefined) {
      const d = q("[data-day]");
      d.textContent = `${signed(day)}  24h`;
      d.classList.add(tone(day));
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

    // chart
    const color = css(score >= 0 ? "--color-accent" : "--color-down");
    const when = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)} ${s.slice(11, 16)}`;
    const area = (ctx: { chart: Chart }) => {
      const box = ctx.chart.chartArea;
      if (!box) return "transparent";
      const g = ctx.chart.ctx.createLinearGradient(0, box.top, 0, box.bottom);
      g.addColorStop(0, `${color}33`);
      g.addColorStop(1, `${color}00`);
      return g;
    };
    const yAxis = (values: number[]) => ({ ...(robustRange(values) ?? {}), position: "right" as const, grid: { color: css("--color-border") },
      ticks: { color: css("--color-text-muted"), maxTicksLimit: 5, callback: (v: string | number) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 }) } });
    if (fromSigned) {
      // placed by update, so an hour kept as one point takes an hour's width; broken where the key was not listed
      const points = withBreaks(own, Number(root.dataset.historySweep || found.sweep));
      const time = new Map(marks.map((m) => [m[0], m[2]]));
      const canvas = q<HTMLCanvasElement>("[data-chart]");
      canvas.setAttribute("aria-label", "The referee's signed score at each update where this key was in its signed top list");
      canvas.dataset.signed = String(own.length);
      q("[data-signed-curve]").hidden = false;
      new Chart(canvas, {
        type: "line",
        // monotone: between two signed points the line never runs past either of them
        data: { datasets: [{ label: "Signed score", data: points.map((p) => ({ x: p.n, y: p.v })), borderColor: color, borderWidth: 2, pointRadius: 0, cubicInterpolationMode: "monotone", fill: "origin",
          spanGaps: false, backgroundColor: area }] },
        options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
          scales: { x: { type: "linear", min: own[0].n, max: own[own.length - 1].n, grid: { display: false },
            // the first and the last update and evenly between (three labels on a phone), each named by its time
            afterBuildTicks: (axis: { width: number; ticks: { value: number }[] }) => {
              const k = axis.width < 480 ? 3 : 4, lo = own[0].n, hi = own[own.length - 1].n;
              axis.ticks = Array.from({ length: k }, (_, i) => ({ value: Math.round(lo + ((hi - lo) * i) / (k - 1)) }));
            },
            ticks: { color: css("--color-text-muted"), maxRotation: 0, callback: (v: string | number) => { const s = time.get(Math.round(Number(v))); return s ? when(s) : ""; } } },
            y: yAxis(own.map((p) => p.v)) },
          plugins: { legend: { display: false }, tooltip: { filter: (item: { parsed: { y: number | null } }) => item.parsed.y !== null, callbacks: {
            title: (items: { parsed: { x: number | null } }[]) => { const x = items[0]?.parsed.x ?? 0; const s = time.get(x); return s ? `${when(s)} UTC · update ${x}` : ""; },
            label: (c: { parsed: { y: number | null } }) => `Signed by the referee: ${signed(c.parsed.y ?? 0)}` } } } },
      });
    } else if (complete && curve.length > 1) {
      new Chart(q<HTMLCanvasElement>("[data-chart]"), {
        type: "line",
        data: { labels: curve.map((p) => p.at), datasets: [{ label: "Score", data: curve.map((p) => p.v), borderColor: color, borderWidth: 2, pointRadius: 0, tension: 0.2, fill: "origin",
          backgroundColor: area }] },
        options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
          scales: { x: { grid: { display: false }, ticks: { color: css("--color-text-muted"), maxTicksLimit: 4, maxRotation: 0,
            callback(this: { getLabelForValue(v: number): string }, v: string | number) { return when(this.getLabelForValue(Number(v))); } } },
            y: yAxis(curve.map((p) => p.v)) },
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c: { parsed: { y: number | null } }) => `Score: ${signed(c.parsed.y ?? 0)}` } } } },
      });
    } else {
      q("[data-chart]").parentElement!.hidden = true;
      if (!trades || !complete) q("[data-no-trades]").classList.remove("hidden");
    }

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

    // share: the score card with this key's own curve; it always says Score, since a saved DID proves no ownership
    const cardData: Card = { did, score, rank: row[0], traders: found.traders, contest: root.dataset.contest ?? "", official,
      sweep: found.sweep, position: pos === undefined ? undefined : pos === null ? "Flat" : `${Number(pos[0]) > 0 ? "Long" : "Short"} ${Math.abs(Number(pos[0])).toFixed(1)}`,
      line: signedList.length >= 3 ? Number(signedList[2].pnl) : undefined,
      prices: fromSigned ? own.map((p) => p.v) : complete && curve.length > 1 ? curve.map((p) => p.v) : marks.map((m) => m[1]),
      curveLabel: fromSigned || (complete && curve.length > 1) ? "SCORE" : "NVDA", mine: false,
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
