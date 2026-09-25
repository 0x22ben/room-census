// "Find my DID": looks a did:key up in the ranking file this site serves. Nothing leaves the site and
// nothing is stored. Every result says where its number comes from.
type Row = [number, string, string, "official" | "complete" | "partial"];
type Ranking = { sweep: number; traders: number; owners: number; rows: Row[]; capture_start?: string; notes?: Partial<Record<Row[3], string>> };
type SelfKey = { did: string; registration: { room: string; seq: number; at: string } | null; mint: "confirmed" | "not_established"; settled_trade: boolean };

const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const SOURCES = {
  official: { label: "Signed by the referee", tone: "accent", note: "The referee's signed number. Our own count agrees within the rounding of its posted price." },
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

/** What we can and cannot establish about a key, one line each: never more than the evidence holds. */
function facts(lines: [string, string, boolean][]): HTMLElement {
  const list = el("ul", "grid gap-1.5 border-t border-border pt-2.5 text-sm");
  for (const [label, value, known] of lines) {
    const li = el("li", "flex flex-wrap gap-x-2");
    li.append(el("span", "text-text-secondary", `${label}:`), document.createTextNode(" "), el("span", known ? "text-text" : "text-text-muted", value));
    list.append(li);
  }
  return list;
}

const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;

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
      const self: SelfKey | null = root.dataset.self ? JSON.parse(root.dataset.self) : null;
      const ours = self && self.did === did ? self : null;
      if (row) {
        const s = SOURCES[row[3]];
        const score = row[2].startsWith("-") || Number(row[2]) === 0 ? row[2] : `+${row[2]}`;
        out.append(card(`#${row[0]}`, of, `${score} POLF`, s.label, s.tone, ranking.notes?.[row[3]] ?? s.note));
      } else {
        const box = card("–", "not ranked", "–", "Not found in the inspected data", "muted",
          `No settled trade of this DID is in the trades we saved. That alone does not tell whether it registered or traded: it may have traded only before we started saving (${ranking.capture_start ?? "the start of our capture"}).`);
        box.append(facts(ours ? [
          ["Registration", ours.registration ? `observed from our own signed posting record (not from the referee): ${ours.registration.room}, seq ${ours.registration.seq}, ${utc(ours.registration.at)}` : "not observed in the data we hold", !!ours.registration],
          ["Mint of 10,000 POLF", ours.mint === "confirmed" ? "confirmed by a signed referee record" : "not independently confirmed: no signed referee record names it, as its public lists leave most mints out", ours.mint === "confirmed"],
          ["Settled trade", ours.settled_trade ? "found" : "no settled trade found in the trades we saved", true],
        ] : [
          ["Settled trade", "none found in the trades we saved", true],
          ["Registration and mint", "not independently established from the data we publish", false],
        ]));
        out.append(box);
      }
    } catch {
      data = null;
      out.append(el("p", "text-sm text-warning", "The ranking file could not be read. Try again in a moment."));
    }
  });
}

document.querySelectorAll<HTMLElement>("[data-find-did]").forEach(init);
