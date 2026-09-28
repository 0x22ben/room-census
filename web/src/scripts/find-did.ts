// "Find my DID": looks a did:key up in the contest's published ranking files (the summary on this site,
// the shard on raw.githubusercontent.com, src/lib/contest-files.mjs). Nothing is sent but the address of
// that file, and nothing is stored. A ranked key opens its trader page directly (rank, score over time,
// position, every trade, the score card to share). Only keys with at least one settled trade are ranked:
// any other key is told it has no trade yet, as far as our capture shows.
import { avatarSvg } from "../lib/avatar.mjs";
import { saved } from "../lib/saved-store";
import { filesOf, lookup, type Signed } from "./ranking-lookup";

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
  const files = filesOf(root)!;
  // the visitor's saved DIDs: listed here with their rank, and marked in the Top 100
  const list = root.querySelector<HTMLElement>("[data-saved-list]");
  const drawSaved = () => {
    const mine = saved();
    list?.replaceChildren(...mine.map((s) => {
      const li = el("li", "");
      const a = el("a", "flex items-center gap-2.5 rounded-lg px-2 py-1.5 no-underline hover:bg-surface-raised") as HTMLAnchorElement;
      a.href = `${location.pathname.replace(/\/?$/, "/")}did/?k=${encodeURIComponent(s.did)}`;
      const names = el("span", "grid min-w-0 flex-1");
      names.append(el("span", "truncate text-sm font-semibold text-text", s.nick), el("span", "font-mono text-[11px] text-text-muted", `${s.did.slice(8, 14)}…${s.did.slice(-6)}`));
      const right = el("span", "grid justify-items-end");
      const rank = el("span", "font-mono text-sm font-semibold text-text", "…");
      const pnl = el("span", "font-mono text-[11px] text-text-muted", "");
      right.append(rank, pnl);
      a.append(avatarSvg(s.did, 26), names, right);
      li.append(a);
      lookup(files, s.did, signed).then(({ row }) => {
        rank.textContent = row ? `#${row[0].toLocaleString("en-US")}` : "–";
        pnl.textContent = row ? `${Number(row[2]) > 0 ? "+" : ""}${row[2]}` : "No trade";
        pnl.className = `font-mono text-[11px] ${row && Number(row[2]) > 0 ? "text-accent" : row && Number(row[2]) < 0 ? "text-down" : "text-text-muted"}`;
      }).catch(() => { rank.textContent = "–"; });
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
      const { row } = await lookup(files, did, signed);
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
