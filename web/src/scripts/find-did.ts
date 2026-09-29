// "Find my DID": looks a did:key up in the referee's signed top list, handed to the page (data-signed).
// Nothing is sent and nothing is stored. A key of that list opens its trader page directly (rank, score
// over time, every trade, the score card to share). Until our recount can be proved against
// the referee's signed hashes, any other key is told it is not in the signed top list, with no rank and
// no score (Ben, 2026-09-29: never show a wrong figure).
import { avatarSvg } from "../lib/avatar.mjs";
import { saved } from "../lib/saved-store";
import { signedLine, type Signed } from "./ranking-lookup";
import { pnlText, pnlTone, rankText, ranker } from "./saved-ranks";

const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function notSigned(top: number, lock: string | undefined, glyph: Node | undefined): HTMLElement {
  const box = el("div", "grid gap-3");
  const head = el("div", "flex items-center gap-3");
  const icon = el("span", "grid size-10 shrink-0 place-items-center rounded-full bg-surface-raised text-text-secondary");
  icon.setAttribute("aria-hidden", "true");
  if (glyph) icon.append(glyph);
  const texts = el("p", "grid");
  texts.append(el("span", "font-semibold", `Not in the signed top ${top}`), el("span", "text-xs text-text-muted", "Its score shows once it can be proved"));
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
  const rankOf = ranker(signed);
  const glyph = () => root.querySelector<HTMLTemplateElement>("[data-find-icon]")?.content.firstElementChild?.cloneNode(true);
  // the visitor's saved DIDs: listed here with their signed rank, and marked in the Top list
  const list = root.querySelector<HTMLElement>("[data-saved-list]");
  const head = root.querySelector<HTMLElement>("[data-saved-head]");
  const drawSaved = () => {
    const mine = saved();
    if (head) head.hidden = mine.length === 0;   // the column labels, only above a list
    list?.replaceChildren(...mine.map((s) => {
      const li = el("li", "");
      const a = el("a", "flex items-center gap-2.5 rounded-lg px-2 py-1.5 no-underline hover:bg-surface-raised") as HTMLAnchorElement;
      a.href = `${location.pathname.replace(/\/?$/, "/")}did/?k=${encodeURIComponent(s.did)}`;
      const names = el("span", "grid min-w-0 flex-1");
      names.append(el("span", "truncate text-sm font-semibold text-text", s.nick), el("span", "font-mono text-[11px] text-text-muted", `${s.did.slice(8, 14)}…${s.did.slice(-6)}`));
      const right = el("span", "grid justify-items-end");
      const r = rankOf(s.did);
      right.append(el("span", "font-mono text-sm font-semibold text-text", rankText(r)), el("span", `font-mono text-[11px] ${pnlTone(r)}`, pnlText(r)));
      a.append(avatarSvg(s.did, 26), names, right);
      li.append(a);
      return li;
    }));
    const dids = new Map(mine.map((s) => [s.did, s.nick]));
    document.querySelectorAll<HTMLAnchorElement>("section[aria-labelledby=top-title] tbody tr a[href*='k=']").forEach((link) => {
      const did = decodeURIComponent(link.href.split("k=")[1] ?? "");
      const tr = link.closest("tr")!;
      tr.classList.toggle("outline", dids.has(did));
      tr.classList.toggle("outline-accent", dids.has(did));
      tr.querySelector("[data-nick]")?.remove();
      if (dids.has(did)) {
        const tag = el("span", "ml-2 rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] font-bold text-on-accent uppercase", dids.get(did));
        tag.dataset.nick = "";
        link.after(tag);
      }
    });
  };
  window.addEventListener("roomcensus:saved", drawSaved);
  drawSaved();

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const did = input.value.trim();
    out.replaceChildren();
    if (!DID.test(did)) {
      out.append(el("p", "text-sm text-warning", "Not a did:key: it starts with did:key:z6Mk and has 56 characters."));
      return;
    }
    if (signedLine(signed, did)) location.assign(`${location.pathname.replace(/\/?$/, "/")}did/?k=${encodeURIComponent(did)}`);
    else out.append(notSigned(signed.length, root.dataset.lock, glyph()));
  });
}

document.querySelectorAll<HTMLElement>("[data-find-did]").forEach(init);
