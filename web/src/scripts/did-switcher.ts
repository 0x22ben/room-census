// The account of the top bar. Signed out: "Sign in" opens a small form (a DID, an optional nickname).
// Signed in: the active DID with its rank in the live contest, and a menu to open its trades, rename it,
// switch to another saved DID, add one, manage them all or sign out (forgets every DID in this browser).
import { avatarSvg } from "../lib/avatar.mjs";
import { active, forgetAll, isDid, rename, save, saved, setActive, type Saved } from "../lib/saved-store";
import { filesOf, type Signed } from "./ranking-lookup";
import { pnlText, pnlTone, rankText, ranker, short } from "./saved-ranks";

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** After a switch, the page follows the new DID: a trades page opens the new DID's trades, and any
 *  other page reloads so everything on it matches. My DIDs already redraws itself. */
function follow(did: string) {
  if (/^\/contests\/[^/]+\/did\/$/.test(location.pathname)) location.href = `${location.pathname}?k=${encodeURIComponent(did)}`;
  else if (!location.pathname.startsWith("/my-dids/")) location.reload();
}

function init(root: HTMLElement) {
  const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const signedList: Signed[] = JSON.parse(root.dataset.signed ?? "[]");
  const rankOf = ranker(filesOf(root), signedList);
  const contestId = root.dataset.contest;
  const menu = q("#did-menu");
  let adding = false;

  function drawPill() {
    const a = active();
    const av = q("[data-sw-avatar]");
    q("[data-sw-chevron]").hidden = !a;
    q("[data-sw-rank]").textContent = "";
    if (!a) {
      av.replaceChildren(document.querySelector<HTMLTemplateElement>("[data-sw-user-icon]")!.content.cloneNode(true));
      q("[data-sw-nick]").textContent = "Sign in";
      return;
    }
    av.replaceChildren(avatarSvg(a.did, 22));
    q("[data-sw-nick]").textContent = a.nick;
    rankOf(a.did).then((r) => { if (active()?.did === a.did) q("[data-sw-rank]").textContent = rankText(r); });
  }

  function other(s: Saved): HTMLElement {
    const li = el("li", "");
    const b = el("button", "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface") as HTMLButtonElement;
    b.type = "button";
    b.dataset.did = s.did;
    b.append(avatarSvg(s.did, 26));
    const names = el("span", "grid min-w-0 flex-1");
    names.append(el("span", "truncate font-semibold", s.nick), el("span", "font-mono text-[11px] text-text-muted", short(s.did)));
    const right = el("span", "grid justify-items-end");
    const rank = el("span", "font-mono text-xs font-semibold", "…");
    const pnl = el("span", "font-mono text-[11px] text-text-muted", "");
    right.append(rank, pnl);
    rankOf(s.did).then((r) => { rank.textContent = rankText(r); pnl.textContent = pnlText(r); pnl.className = `font-mono text-[11px] ${pnlTone(r)}`; });
    b.append(names, right);
    b.addEventListener("click", () => { setActive(s.did); follow(s.did); });
    li.append(b);
    return li;
  }

  function drawMenu() {
    const list = saved();
    const a = active();
    const form = !a || adding;
    q("[data-sw-form]").hidden = !form;
    q("[data-sw-menu]").hidden = form;
    q("[data-sw-form-title]").textContent = a ? "Add another DID" : "Sign in with your DID";
    q("[data-sw-submit]").textContent = a ? "Add" : "Sign in";
    q("[data-sw-create]").hidden = !!a;
    q("[data-sw-back]").hidden = !a;
    if (!a) return;
    q("[data-sw-me-avatar]").replaceChildren(avatarSvg(a.did, 32));
    q("[data-sw-me-nick]").textContent = a.nick;
    q("[data-sw-me-did]").textContent = short(a.did);
    q("[data-sw-me-rank]").textContent = "…";
    q("[data-sw-me-pnl]").textContent = "";
    rankOf(a.did).then((r) => {
      if (active()?.did !== a.did) return;
      q("[data-sw-me-rank]").textContent = rankText(r);
      q("[data-sw-me-pnl]").textContent = pnlText(r);
      q("[data-sw-me-pnl]").className = `font-mono text-[11px] ${pnlTone(r)}`;
    });
    q<HTMLAnchorElement>("[data-sw-trades]").href = `/contests/${contestId}/did/?k=${encodeURIComponent(a.did)}`;
    const others = list.filter((s) => s.did !== a.did);
    q("[data-sw-others-box]").hidden = others.length === 0;
    q("[data-sw-others-head]").textContent = `Switch DID · ${others.length}`;
    q("[data-sw-list]").replaceChildren(...others.map(other));
    q("[data-sw-count]").textContent = String(list.length);
  }

  const draw = () => { drawPill(); drawMenu(); };

  q("[data-sw-form]").addEventListener("submit", (e) => {
    e.preventDefault();
    const did = q<HTMLInputElement>("[data-sw-did]").value.trim();
    const nick = q<HTMLInputElement>("[data-sw-name]").value.trim();
    const err = q("[data-sw-error]");
    const known = saved().some((s) => s.did === did);
    err.textContent = !isDid(did) ? "This is not a did:key." : known ? "" : save(did, nick || undefined) ? "" : "Could not keep it in this browser.";
    if (err.textContent) return;
    q<HTMLInputElement>("[data-sw-did]").value = "";
    q<HTMLInputElement>("[data-sw-name]").value = "";
    adding = false;
    setActive(did);
    menu.hidePopover();
    follow(did);
  });
  q("[data-sw-add]").addEventListener("click", () => { adding = true; drawMenu(); q<HTMLInputElement>("[data-sw-did]").focus(); });
  q("[data-sw-back]").addEventListener("click", () => { adding = false; q("[data-sw-error]").textContent = ""; drawMenu(); });

  const input = q<HTMLInputElement>("[data-sw-rename]");
  const closeRename = () => { input.hidden = true; q("[data-sw-me-nick]").hidden = false; };
  q("[data-sw-edit]").addEventListener("click", () => {
    const a = active();
    if (!a) return;
    input.value = a.nick;
    input.hidden = false;
    q("[data-sw-me-nick]").hidden = true;
    input.focus();
    input.select();
  });
  // Enter keeps the name at once: it never depends on the field having had focus
  const keepName = () => {
    if (input.hidden) return;
    const a = active();
    const v = input.value.trim();
    closeRename();
    if (a && v && v !== a.nick) rename(a.did, v);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); keepName(); }
    if (e.key === "Escape") { e.stopPropagation(); input.value = active()?.nick ?? ""; keepName(); }
  });
  input.addEventListener("blur", keepName);

  q("[data-sw-out]").addEventListener("click", () => {
    const n = saved().length;
    if (n > 1 && !window.confirm(`Sign out and forget the ${n} DIDs saved in this browser?`)) return;
    menu.hidePopover();
    forgetAll();
  });
  menu.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState === "closed") { adding = false; q("[data-sw-error]").textContent = ""; closeRename(); drawMenu(); }
  });

  window.addEventListener("roomcensus:saved", draw);
  window.addEventListener("storage", draw);
  draw();
}

document.querySelectorAll<HTMLElement>("[data-did-switcher]").forEach(init);
