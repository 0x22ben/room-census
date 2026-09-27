// "Find my DID": looks a did:key up in the ranking file this site serves. Nothing leaves the site and
// nothing is stored. Only keys with at least one settled trade are ranked: any other key has not
// traded yet, as far as our capture shows.
// the fifth field, when present, is the open position rebuilt by our recount: [signed contracts, entry] or null
type Row = [number, string, string, "official" | "complete" | "partial", ([string, string] | null)?];
type Ranking = { sweep: number; traders: number; owners: number; rows: Row[]; capture_start?: string; notes?: Partial<Record<Row[3], string>> };

const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const SOURCE = {
  official: { label: "Signed by the referee", tone: "border-accent-border bg-accent-soft text-accent" },
  complete: { label: "Our recount", tone: "border-accent-border bg-accent-soft text-accent" },
  partial: { label: "Our recount · may miss early trades", tone: "border-warning-border bg-warning-soft text-warning" },
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
  box.append(top, ...(list.childElementCount ? [list] : []), badge);
  return box;
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
  let data: Promise<Ranking> | null = null;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const did = input.value.trim();
    out.replaceChildren();
    if (!DID.test(did)) {
      out.append(el("p", "text-sm text-warning", "Not a did:key: it starts with did:key:z6Mk and has 56 characters."));
      return;
    }
    out.append(el("p", "text-sm text-text-muted", "Searching…"));
    data ??= fetch(root.dataset.url!).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json() as Promise<Ranking>;
    });
    try {
      const ranking = await data;
      const row = ranking.rows.find((r) => r[1] === did);
      out.replaceChildren(row ? ranked(row, ranking.traders, line, ranking.notes?.[row[3]]) : noTrade(root.dataset.lock));
    } catch {
      data = null;
      out.replaceChildren(el("p", "text-sm text-warning", "The ranking could not be read. Try again in a moment."));
    }
  });
}

document.querySelectorAll<HTMLElement>("[data-find-did]").forEach(init);
