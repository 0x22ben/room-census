// The My DIDs page: add one or many DIDs (one per line), search, rename, switch, open trades, remove.
// Everything goes through saved-store (this browser only); every change redraws the page and the top bar.
import { avatarSvg } from "../lib/avatar.mjs";
import { active, isDid, remove, rename, save, saved, setActive, type Saved } from "../lib/saved-store";
import type { Signed } from "./ranking-lookup";
import { pnlText, pnlTone, rankText, ranker, short } from "./saved-ranks";

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function init(root: HTMLElement) {
  const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const rankOf = ranker(JSON.parse(root.dataset.signed ?? "[]") as Signed[]);
  const contestId = root.dataset.contest;
  const max = Number(root.dataset.max);
  const icons = document.querySelector<HTMLTemplateElement>("[data-md-icons]")!.content;
  const icon = (name: string) => icons.querySelector(`[data-i="${name}"] svg`)!.cloneNode(true);
  const input = q<HTMLTextAreaElement>("[data-md-input]");
  const search = q<HTMLInputElement>("[data-md-search]");

  q("[data-md-noscript]").hidden = true;
  q("[data-md-body]").hidden = false;

  /** The pasted lines, sorted into new DIDs, ones already saved, and anything that is not a did:key. */
  function parse() {
    const have = new Set(saved().map((s) => s.did));
    const fresh: string[] = [];
    let known = 0;
    let bad = 0;
    for (const t of input.value.split(/[\s,;]+/).filter(Boolean)) {
      if (!isDid(t)) bad += 1;
      else if (have.has(t) || fresh.includes(t)) known += 1;
      else fresh.push(t);
    }
    return { fresh: fresh.slice(0, Math.max(0, max - have.size)), over: Math.max(0, fresh.length - (max - have.size)), known, bad };
  }

  function drawAdd(done?: number) {
    const { fresh, over, known, bad } = parse();
    const btn = q<HTMLButtonElement>("[data-md-submit]");
    btn.disabled = fresh.length === 0;
    btn.textContent = fresh.length ? `Add ${plural(fresh.length, "DID")}` : "Add DIDs";
    const notes = [
      done ? `${plural(done, "DID")} added.` : "",
      bad ? `${bad} not a did:key.` : "",
      known ? `${known} already saved.` : "",
      over ? `${over} over the limit of ${max}.` : "",
    ].filter(Boolean);
    q("[data-md-hint]").textContent = notes.length ? notes.join(" ") : "One DID per line.";
  }

  function row(s: Saved, on: boolean): HTMLElement {
    const tr = el("tr", "border-t border-border");
    tr.dataset.did = s.did;

    const who = el("td", "px-4 py-2.5");
    const box = el("div", "flex items-center gap-3");
    box.append(avatarSvg(s.did, 28));
    const names = el("div", "grid min-w-0 gap-0.5");
    const line = el("div", "flex items-center gap-2");
    const nick = el("span", "truncate font-semibold", s.nick);
    const edit = el("button", "rounded p-1 text-text-muted hover:text-text") as HTMLButtonElement;
    edit.type = "button";
    edit.setAttribute("aria-label", `Rename ${s.nick}`);
    edit.append(icon("pencil"));
    edit.addEventListener("click", () => {
      const field = el("input", "min-h-8 w-40 rounded border border-border bg-bg px-2 text-sm outline-none") as HTMLInputElement;
      field.value = s.nick;
      field.maxLength = 20;
      field.setAttribute("aria-label", `New nickname for ${short(s.did)}`);
      // Enter keeps the name at once: it never depends on the field having had focus
      let over = false;
      const done = () => { if (over) return; over = true; const v = field.value.trim(); if (!v || v === s.nick || !rename(s.did, v)) draw(); };
      field.addEventListener("keydown", (e) => { if (e.key === "Enter") done(); if (e.key === "Escape") { field.value = s.nick; done(); } });
      field.addEventListener("blur", done);
      nick.replaceWith(field);
      edit.hidden = true;
      field.focus();
      field.select();
    });
    line.append(nick, edit);
    if (on) line.append(el("span", "rounded border border-accent-border bg-accent-soft px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-widest text-accent", "SIGNED IN"));
    const idLine = el("div", "flex items-center gap-1.5 font-mono text-[11px] text-text-muted");
    const copy = el("button", "rounded p-0.5 hover:text-text") as HTMLButtonElement;
    copy.type = "button";
    copy.setAttribute("aria-label", `Copy ${short(s.did)}`);
    copy.append(icon("copy"));
    copy.addEventListener("click", () => {
      navigator.clipboard?.writeText(s.did).then(() => { copy.replaceChildren(el("span", "text-accent", "Copied")); setTimeout(() => copy.replaceChildren(icon("copy")), 1500); }, () => {});
    });
    idLine.append(el("span", "", short(s.did)), copy);
    names.append(line, idLine);
    box.append(names);
    who.append(box);

    // a rank and a score only for a key of the referee's signed top list; any other: "–", not verified
    const r = rankOf(s.did);
    const rank = el("td", "px-4 py-2.5 text-right font-mono font-semibold", rankText(r));
    const pnl = el("td", `px-4 py-2.5 text-right font-mono ${pnlTone(r)}`, pnlText(r));

    const act = el("td", "px-4 py-2.5");
    const acts = el("div", "flex items-center justify-end gap-2");
    if (!on) {
      const use = el("button", "min-h-8 rounded-md border border-border-strong px-2.5 text-xs font-semibold hover:bg-surface-raised", "Sign in") as HTMLButtonElement;
      use.type = "button";
      use.addEventListener("click", () => setActive(s.did));
      acts.append(use);
    }
    const trades = el("a", "px-1 text-xs font-semibold text-link", "Trades") as HTMLAnchorElement;
    trades.href = `/contests/${contestId}/did/?k=${encodeURIComponent(s.did)}`;
    const del = el("button", "rounded p-1.5 text-text-muted hover:text-down") as HTMLButtonElement;
    del.type = "button";
    del.setAttribute("aria-label", `Remove ${s.nick}`);
    del.append(icon("trash"));
    del.addEventListener("click", () => remove(s.did));
    acts.append(trades, del);
    act.append(acts);

    tr.append(who, rank, pnl, act);
    return tr;
  }

  function draw() {
    const list = saved();
    const a = active();
    const f = search.value.trim().toLowerCase();
    const ordered = a ? [a, ...list.filter((s) => s.did !== a.did)] : list;
    const shown = ordered.filter((s) => !f || s.nick.toLowerCase().includes(f) || s.did.toLowerCase().includes(f));
    q("[data-md-count]").textContent = String(list.length);
    q("[data-md-list]").replaceChildren(...shown.map((s) => row(s, s.did === a?.did)));
    q("[data-md-empty]").hidden = list.length > 0;
    q("[data-md-none]").hidden = list.length === 0 || shown.length > 0;
    drawAdd();
  }

  input.addEventListener("input", () => drawAdd());
  search.addEventListener("input", draw);
  q("[data-md-add]").addEventListener("submit", (e) => {
    e.preventDefault();
    const { fresh } = parse();
    let n = 0;
    for (const did of fresh) if (save(did)) n += 1;
    // keep only what could not be added, so the reader can fix it
    input.value = input.value.split(/[\s,;]+/).filter((t) => t && !isDid(t)).join("\n");
    drawAdd(n);
  });

  window.addEventListener("roomcensus:saved", draw);
  window.addEventListener("storage", draw);
  draw();
}

document.querySelectorAll<HTMLElement>("[data-my-dids]").forEach(init);
