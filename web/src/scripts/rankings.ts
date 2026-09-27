// Rankings page: pins the visitor's saved DIDs and any DID searched at the top of the table, from the
// full list (/rankings/ranking.json), and switches between all contests and one contest.
import { avatarSvg } from "../lib/avatar.mjs";
import { saved } from "../lib/saved-store";

type Row = [number, string, number, Record<string, number>, Record<string, string>];
type Doc = { contests: { id: string; title: string; roles: Record<string, string> }[]; pending: { id: string; title: string }[]; rows: Row[] };

const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const n = (v: number) => v.toLocaleString("en-US");
const short = (did: string) => `${did.slice(8, 16)}…${did.slice(-5)}`;

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function init(root: HTMLElement) {
  let doc: Promise<Doc> | null = null;
  const load = () => (doc ??= fetch(root.dataset.url!).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<Doc>; }));
  const pinned = root.querySelector<HTMLElement>("[data-pinned]")!;
  const result = root.querySelector<HTMLElement>("[data-rank-result]")!;
  let searched: string | null = null;

  function pinRow(d: Doc, did: string, label: string): HTMLElement {
    const row = d.rows.find((r) => r[1] === did);
    const tr = el("tr", "relative border-t border-accent-border bg-accent-soft/60");
    tr.dataset.pinned = did;
    tr.append(el("td", "px-4 py-2.5 font-mono font-bold text-accent sm:px-5", row ? String(row[0]) : "–"));
    const av = el("td", "w-9 py-2.5 pl-4");
    av.append(avatarSvg(did, 26));
    const name = el("td", "px-2 py-2.5");
    const a = el("a", "font-mono text-text no-underline outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline", short(did)) as HTMLAnchorElement;
    a.href = `/contests/close-1/did/?k=${encodeURIComponent(did)}`;
    name.append(a, document.createTextNode(" "), el("span", "rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] font-bold text-on-accent uppercase", label));
    tr.append(av, name, el("td", "px-4 py-2.5 text-right font-mono font-bold whitespace-nowrap text-accent", row ? n(row[2]) : "0"));
    tr.append(el("td", "hidden px-4 py-2.5 font-mono text-text-secondary sm:table-cell", row ? String(Object.keys(row[3]).length) : "0"));
    const role = el("td", "hidden px-4 py-2.5 md:table-cell");
    const chips = el("span", "flex flex-wrap gap-1");
    for (const c of d.contests) if (row?.[4]?.[c.id]) chips.append(el("span", "rounded-md border border-border-strong bg-surface-raised px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-text-secondary", c.roles[row[4][c.id]]));
    role.append(chips);
    tr.append(role);
    for (const c of d.contests) tr.append(el("td", "hidden px-4 py-2.5 font-mono text-xs lg:table-cell", row?.[3][c.id] ? n(row[3][c.id]) : "–"));
    for (let i = 0; i < d.pending.length; i++) tr.append(el("td", "hidden px-4 py-2.5 lg:table-cell", ""));
    tr.append(el("td", "pr-4 sm:pr-5", ""));
    return tr;
  }

  async function drawPins() {
    const list = saved();
    const wanted: [string, string][] = list.map((s) => [s.did, s.nick]);
    if (searched && !list.some((s) => s.did === searched)) wanted.unshift([searched, "you"]);
    if (!wanted.length) { pinned.replaceChildren(); return; }
    try {
      const d = await load();
      pinned.replaceChildren(...wanted.map(([did, label]) => pinRow(d, did, label)));
    } catch {
      pinned.replaceChildren();
    }
  }

  root.querySelector<HTMLFormElement>("[data-rank-form]")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const did = root.querySelector<HTMLInputElement>("#rank-input")!.value.trim();
    if (!DID.test(did)) { result.textContent = "Not a did:key: it starts with did:key:z6Mk and has 56 characters."; return; }
    result.textContent = "Searching…";
    try {
      const d = await load();
      const row = d.rows.find((r) => r[1] === did);
      searched = did;
      result.textContent = row ? "" : "0 FLOP won so far: this DID is in no payout list FLOP Labs published.";
      await drawPins();
    } catch {
      result.textContent = "The rankings could not be read. Try again in a moment.";
    }
  });

  // contest filter: every paid contest counts in "All contests"; a contest not paid yet shows its notice
  const podium = document.querySelector<HTMLElement>("[data-podium]");
  const pending = document.querySelector<HTMLElement>("[data-pending]");
  document.querySelectorAll<HTMLElement>("[data-filter]").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll<HTMLElement>("[data-filter]").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
    const waiting = b.dataset.filter === "close-1";
    pending?.classList.toggle("hidden", !waiting);
    pending?.classList.toggle("flex", waiting);
    if (podium) podium.hidden = waiting;
    root.hidden = waiting;
  }));

  window.addEventListener("roomcensus:saved", drawPins);
  drawPins();
}

document.querySelectorAll<HTMLElement>("[data-rankings]").forEach(init);
