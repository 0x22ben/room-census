// The saved-DIDs switcher of the top bar: shows the active DID with its rank in the live contest, and a
// menu to switch, open its trader page, save another, rename, remove or forget all. Ranks come from the
// contest's published ranking files (same order as the Top 100) and are remembered for 15 minutes.
import { avatarSvg } from "../lib/avatar.mjs";
import { active, forgetAll, isDid, remove, rename, save, saved, setActive, type Saved } from "../lib/saved-store";
import { lookup, type Signed } from "./ranking-lookup";

const CACHE = "roomcensus.saved.ranks";
const TTL = 15 * 60_000;
const short = (did: string) => `${did.slice(8, 14)}…${did.slice(-6)}`;

type Rank = { rank: number; pnl: string } | null;
function cached(): Record<string, { at: number; r: Rank }> {
  try {
    return JSON.parse(window.localStorage.getItem(CACHE) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function init(root: HTMLElement) {
  const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const url = root.dataset.url;
  const signedList: Signed[] = JSON.parse(root.dataset.signed ?? "[]");
  const contestId = root.dataset.contest;
  let managing = false;

  async function rankOf(did: string): Promise<Rank> {
    if (!url) return null;
    const all = cached();
    const hit = all[did];
    if (hit && Date.now() - hit.at < TTL) return hit.r;
    try {
      const { row } = await lookup(url, did, signedList);
      const r: Rank = row ? { rank: row[0], pnl: row[2] } : null;
      all[did] = { at: Date.now(), r };
      try { window.localStorage.setItem(CACHE, JSON.stringify(all)); } catch { /* no memory */ }
      return r;
    } catch {
      return null;
    }
  }

  const rankText = (r: Rank) => (r ? `#${r.rank.toLocaleString("en-US")}` : "–");

  function drawPill() {
    const a = active();
    const av = q("[data-sw-avatar]");
    av.replaceChildren();
    if (!a) {
      q("[data-sw-nick]").textContent = "Save a DID";
      q("[data-sw-rank]").textContent = "";
      return;
    }
    av.append(avatarSvg(a.did, 22));
    q("[data-sw-nick]").textContent = a.nick;
    q("[data-sw-rank]").textContent = "";
    rankOf(a.did).then((r) => { if (active()?.did === a.did) q("[data-sw-rank]").textContent = rankText(r); });
  }

  function item(s: Saved, on: boolean): HTMLElement {
    const li = el("li", `flex items-center gap-2.5 rounded-lg px-2 py-1.5 ${on ? "bg-accent-soft" : "hover:bg-surface"}`);
    li.dataset.did = s.did;
    li.append(avatarSvg(s.did, 26));
    const names = el("span", "grid min-w-0 flex-1");
    if (managing) {
      const input = el("input", "min-h-8 w-full rounded border border-border bg-bg px-2 text-sm outline-none") as HTMLInputElement;
      input.value = s.nick;
      input.maxLength = 20;
      input.setAttribute("aria-label", `Nickname of ${short(s.did)}`);
      input.addEventListener("change", () => { if (!rename(s.did, input.value.trim())) input.value = s.nick; });
      names.append(input);
    } else {
      const pick = el("button", "truncate text-left font-semibold", s.nick) as HTMLButtonElement;
      pick.type = "button";
      pick.addEventListener("click", () => setActive(s.did));
      names.append(pick);
    }
    names.append(el("span", "font-mono text-[11px] text-text-muted", short(s.did)));
    li.append(names);
    if (managing) {
      const del = el("button", "rounded px-2 py-1 text-xs text-down hover:bg-surface", "Remove") as HTMLButtonElement;
      del.type = "button";
      del.addEventListener("click", () => remove(s.did));
      li.append(del);
    } else {
      const right = el("span", "grid justify-items-end");
      const rank = el("span", "font-mono text-xs font-semibold", "…");
      const pnl = el("span", "font-mono text-[11px] text-text-muted", "");
      right.append(rank, pnl);
      rankOf(s.did).then((r) => {
        rank.textContent = rankText(r);
        pnl.textContent = r ? `${Number(r.pnl) > 0 ? "+" : ""}${r.pnl}` : "No trade";
        pnl.className = `font-mono text-[11px] ${r && Number(r.pnl) > 0 ? "text-accent" : r && Number(r.pnl) < 0 ? "text-down" : "text-text-muted"}`;
      });
      const open = el("a", "rounded px-1.5 py-1 text-xs text-link", "Open") as HTMLAnchorElement;
      open.href = `/contests/${contestId}/did/?k=${encodeURIComponent(s.did)}`;
      li.append(right, open);
    }
    return li;
  }

  function drawMenu() {
    const list = saved();
    const a = active();
    const filter = q<HTMLInputElement>("[data-sw-filter]");
    filter.hidden = list.length < 5;
    const f = filter.value.trim().toLowerCase();
    const shown = list.filter((s) => !f || s.nick.toLowerCase().includes(f) || s.did.toLowerCase().includes(f));
    q("[data-sw-list]").replaceChildren(...shown.map((s) => item(s, s.did === a?.did)));
    q("[data-sw-count]").textContent = `Saved · ${list.length}`;
    q("[data-sw-empty]").hidden = list.length > 0;
    q("[data-sw-manage]").hidden = list.length === 0;
    q("[data-sw-manage]").lastChild!.textContent = managing ? "Done" : "Manage";
    q("[data-sw-forget]").hidden = !managing;
  }

  const draw = () => { drawPill(); drawMenu(); };
  q("[data-sw-filter]").addEventListener("input", drawMenu);
  q("[data-sw-manage]").addEventListener("click", () => { managing = !managing; drawMenu(); });
  q("[data-sw-forget]").addEventListener("click", () => {
    if (window.confirm(`Forget ${saved().length} saved DIDs in this browser?`)) { managing = false; forgetAll(); }
  });
  q("[data-sw-add]").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = q<HTMLInputElement>("#sw-add-input");
    const did = input.value.trim();
    const err = q("[data-sw-error]");
    err.textContent = !isDid(did) ? "Not a did:key." : saved().some((s) => s.did === did) ? "Already saved." : save(did) ? "" : "Could not save it in this browser.";
    if (!err.textContent) input.value = "";
  });
  window.addEventListener("roomcensus:saved", draw);
  window.addEventListener("storage", draw);
  draw();
}

document.querySelectorAll<HTMLElement>("[data-did-switcher]").forEach(init);
