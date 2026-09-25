// "Find my DID": looks a did:key up in the ranking file this site serves. Nothing leaves the site and
// nothing is stored. Every result says where its number comes from.
type Row = [number, string, string, "official" | "complete" | "partial"];
type Ranking = { sweep: number; traders: number; owners: number; rows: Row[]; capture_start?: string; notes?: Partial<Record<Row[3], string>> };

const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const SOURCES = {
  official: { label: "Signed by the referee", tone: "accent", note: "In the referee's signed top list. Our count gives the same number." },
  complete: { label: "Our count", tone: "accent", note: "Every trade of this DID is in our capture." },
  partial: { label: "Our count · may be incomplete", tone: "warning", note: "Some early trades happened before we started saving (before 13:37 UTC). Your rank could be off." },
} as const;

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function card(rank: string, of: string, score: string, badge: string, tone: string, note: string): HTMLElement {
  const box = el("div", "grid gap-2.5 rounded-md border border-border bg-bg px-4 py-3.5");
  const top = el("div", "flex flex-wrap items-end justify-between gap-2");
  const left = el("p", "flex items-end gap-2.5");
  left.append(el("span", "font-mono text-2xl font-semibold", rank), el("span", "text-sm text-text-secondary", of));
  const scoreTone = score.startsWith("-") ? "text-warning" : score.startsWith("+") ? "text-accent" : "text-text-secondary";
  top.append(left, el("p", `font-mono text-xl tabular-nums ${scoreTone}`, score));
  const bottom = el("p", "flex flex-wrap items-center gap-2.5 text-sm text-text-muted");
  const pillTone = tone === "warning" ? "border-warning-border bg-warning-soft text-warning"
    : tone === "accent" ? "border-accent-border bg-accent-soft text-accent" : "border-border bg-surface-raised text-text-secondary";
  bottom.append(el("span", `rounded-md border px-2 py-0.5 text-xs font-semibold ${pillTone}`, badge), document.createTextNode(note));
  box.append(top, bottom);
  return box;
}

function init(root: HTMLElement) {
  const form = root.querySelector<HTMLFormElement>("[data-find-form]")!;
  const input = form.querySelector<HTMLInputElement>("input")!;
  const out = root.querySelector<HTMLElement>("[data-find-result]")!;
  let data: Promise<Ranking> | null = null;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const did = input.value.trim();
    out.replaceChildren();
    if (!DID.test(did)) {
      out.append(el("p", "text-sm text-warning", "This is not a did:key. It starts with did:key:z6Mk and has 56 characters."));
      return;
    }
    data ??= fetch(root.dataset.url!).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json() as Promise<Ranking>;
    });
    try {
      const ranking = await data;
      const row = ranking.rows.find((r) => r[1] === did);
      const of = `of ${ranking.traders.toLocaleString("en-US")} traders`;
      if (row) {
        const s = SOURCES[row[3]];
        const score = row[2].startsWith("-") || Number(row[2]) === 0 ? row[2] : `+${row[2]}`;
        out.append(card(`#${row[0]}`, of, `${score} POLF`, s.label, s.tone, ranking.notes?.[row[3]] ?? s.note));
      } else {
        out.append(card("–", "not ranked", "–", "Not found in the inspected data", "muted",
          `No settled trade of this DID is in the trades we saved. It may not have traded, may not be registered, or may have traded only before we started saving (${ranking.capture_start ?? "13:37 UTC"}).`));
      }
    } catch {
      data = null;
      out.append(el("p", "text-sm text-warning", "The ranking file could not be read. Try again in a moment."));
    }
  });
}

document.querySelectorAll<HTMLElement>("[data-find-did]").forEach(init);
