// "Find my DID": looks a did:key up in the ranking files this site serves. Nothing leaves the site and
// nothing is stored. Only keys with at least one settled trade are ranked: any other key has not
// traded yet, as far as our capture shows. Ranks are the same as in the Top 100 (ranking-lookup.ts).
// the fifth field, when present, is the open position rebuilt by our recount: [signed contracts, entry] or null
import { drawCard, shareCard, type Card } from "./pnl-card";
import { lookup, type Row, type Signed } from "./ranking-lookup";

const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const SOURCE = {
  official: { label: "Signed by the referee", tone: "border-accent-border bg-accent-soft text-accent" },
  signed: { label: "Signed by the referee", tone: "border-border bg-surface-raised text-text-secondary" },
  complete: { label: "Our recount", tone: "border-accent-border bg-accent-soft text-accent" },
  // the caveat of a partial count stays in the badge's title, not on screen (Ben 2026-09-27)
  partial: { label: "Our recount", tone: "border-border bg-surface-raised text-text-secondary" },
} as const;

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}`;
const tone = (v: number) => (v > 0 ? "text-accent" : v < 0 ? "text-down" : "text-text-secondary");

function positionText(p: Row[4]): string | undefined {
  if (p === undefined) return undefined;
  if (p === null) return "Flat";
  return p[0].startsWith("-") ? `Short ${p[0].slice(1)} @ ${p[1]}` : `Long ${p[0]} @ ${p[1]}`;
}

function stat(label: string, value: string, cls = "text-text"): HTMLElement {
  const li = el("li", "flex items-center justify-between gap-3");
  li.append(el("span", "text-text-secondary", label), el("span", `font-mono font-semibold tabular-nums ${cls}`, value));
  return li;
}

function ranked(row: Row, traders: number, line: number | undefined, note: string | undefined): HTMLElement {
  const box = el("div", "grid gap-3");
  const score = Number(row[2]);
  const top = el("div", "flex items-end justify-between gap-3");
  const left = el("p", "grid");
  left.append(el("span", "font-mono text-3xl font-bold", `#${row[0].toLocaleString("en-US")}`),
    el("span", "text-xs text-text-muted", `of ${traders.toLocaleString("en-US")}`));
  top.append(left, el("p", `font-mono text-2xl font-semibold tabular-nums ${tone(score)}`, signed(score)));
  const list = el("ul", "grid gap-2 border-t border-border pt-3 text-sm");
  const pos = positionText(row[4]);
  if (pos) list.append(stat("Position", pos, pos.startsWith("Short") ? "text-down" : pos === "Flat" ? "text-text-muted" : "text-accent"));
  if (line !== undefined && row[0] > 3) list.append(stat("To 3rd place", signed(score - line), tone(score - line)));
  const source = SOURCE[row[3]];
  const badge = el("span", `justify-self-start rounded-md border px-2 py-0.5 text-xs font-semibold ${source.tone}`, source.label);
  if (note) badge.title = note;
  const open = el("a", "text-sm font-semibold text-link", "Open its trades");
  open.setAttribute("href", `${location.pathname.replace(/\/?$/, "/")}did/?k=${encodeURIComponent(row[1])}`);
  const foot = el("div", "flex flex-wrap items-center justify-between gap-2");
  foot.append(badge, open);
  box.append(top, ...(list.childElementCount ? [list] : []), foot);
  return box;
}

/** "Share on X": the score card is drawn as soon as the result shows, so a click opens the share
 * sheet (or X) right away, inside the click, as browsers require. */
function shareButton(root: HTMLElement, row: Row, traders: number, line: number | undefined): HTMLElement {
  const button = el("button", "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent", "Share my score on X");
  button.setAttribute("type", "button");
  const card: Card = { did: row[1], score: Number(row[2]), rank: row[0], traders, line, contest: root.dataset.contest ?? "", official: row[3] === "official" || row[3] === "signed",
    sweep: Number(root.dataset.sweep), position: positionText(row[4]), prices: JSON.parse(root.dataset.prices ?? "[]") };
  let ready: Blob | undefined;
  drawCard(card).then((b) => { ready = b; }).catch(() => undefined);
  button.addEventListener("click", () => {
    shareCard(card, root.dataset.page ?? location.href, ready).catch(() => undefined);
  });
  return button;
}

function noTrade(lock: string | undefined): HTMLElement {
  const box = el("div", "grid gap-3");
  const head = el("div", "flex items-center gap-3");
  const icon = el("span", "grid size-10 place-items-center rounded-lg bg-warning-soft font-mono text-lg font-bold text-warning", "0");
  icon.setAttribute("aria-hidden", "true");
  const texts = el("p", "grid");
  texts.append(el("span", "font-semibold", "No trade yet"), el("span", "text-xs text-text-muted", "No settled trade in our capture"));
  head.append(icon, texts);
  box.append(head);
  if (lock) {
    const list = el("ul", "grid gap-2 border-t border-border pt-3 text-sm");
    list.append(stat("Trading locks in", lock));
    box.append(list);
  }
  return box;
}

function init(root: HTMLElement) {
  const form = root.querySelector<HTMLFormElement>("[data-find-form]")!;
  const input = form.querySelector<HTMLInputElement>("input")!;
  const out = root.querySelector<HTMLElement>("[data-find-result]")!;
  const line = root.dataset.line ? Number(root.dataset.line) : undefined;
  const signed: Signed[] = JSON.parse(root.dataset.signed ?? "[]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const did = input.value.trim();
    out.replaceChildren();
    if (!DID.test(did)) {
      out.append(el("p", "text-sm text-warning", "Not a did:key: it starts with did:key:z6Mk and has 56 characters."));
      return;
    }
    out.append(el("p", "text-sm text-text-muted", "Searching…"));
    try {
      const ranking = await lookup(root.dataset.url!, did, signed);
      const row = ranking.row;
      if (row) {
        const card = ranked(row, ranking.traders, line, ranking.notes[row[3]]);
        card.append(shareButton(root, row, ranking.traders, line));
        out.replaceChildren(card);
      } else {
        out.replaceChildren(noTrade(root.dataset.lock));
      }
    } catch {
      out.replaceChildren(el("p", "text-sm text-warning", "The ranking could not be read. Try again in a moment."));
    }
  });
}

document.querySelectorAll<HTMLElement>("[data-find-did]").forEach(init);
