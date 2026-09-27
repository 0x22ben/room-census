// "Find my DID": looks a did:key up in the ranking files this site serves. Nothing leaves the site and
// nothing is stored. A ranked key opens its trader page directly (rank, score over time, position,
// every trade, the score card to share). Only keys with at least one settled trade are ranked: any
// other key is told it has no trade yet, as far as our capture shows.
import { lookup, type Signed } from "./ranking-lookup";

const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
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
    const li = el("li", "flex items-center justify-between gap-3");
    li.append(el("span", "text-text-secondary", "Trading locks in"), el("span", "font-mono font-semibold tabular-nums text-text", lock));
    const list = el("ul", "grid gap-2 border-t border-border pt-3 text-sm");
    list.append(li);
    box.append(list);
  }
  return box;
}

function init(root: HTMLElement) {
  const form = root.querySelector<HTMLFormElement>("[data-find-form]")!;
  const input = form.querySelector<HTMLInputElement>("input")!;
  const out = root.querySelector<HTMLElement>("[data-find-result]")!;
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
      const { row } = await lookup(root.dataset.url!, did, signed);
      if (row) {
        location.assign(`${location.pathname.replace(/\/?$/, "/")}did/?k=${encodeURIComponent(did)}`);
      } else {
        out.replaceChildren(noTrade(root.dataset.lock));
      }
    } catch {
      out.replaceChildren(el("p", "text-sm text-warning", "The ranking could not be read. Try again in a moment."));
    }
  });
}

document.querySelectorAll<HTMLElement>("[data-find-did]").forEach(init);
