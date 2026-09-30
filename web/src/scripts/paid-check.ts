// "Was my DID paid?" on a paid contest's page: looks a did:key up in the site's own Rankings file
// (/rankings/ranking.json, built from FLOP Labs' payout lists). Nothing leaves the browser but the
// request for that file, and nothing is stored.
import { paidAnswer } from "../lib/winners.mjs";

type Row = [number, string, number, Record<string, number>, Record<string, string>];
const TONE: Record<string, string> = { accent: "text-accent", warning: "text-warning", muted: "text-text-muted" };

function init(root: HTMLElement) {
  const contest = root.dataset.contest!;
  const out = root.querySelector<HTMLElement>("[data-paid-result]")!;
  let rows: Promise<Map<string, Row>> | null = null;
  const load = () => (rows ??= fetch(root.dataset.url!)
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<{ rows: Row[] }>; })
    .then((d) => new Map(d.rows.map((r) => [r[1], r])))
    .catch((e) => { rows = null; throw e; }));
  const show = (tone: string, text: string) => { out.className = `text-sm ${TONE[tone] ?? ""}`; out.textContent = text; };

  root.querySelector<HTMLFormElement>("[data-paid-form]")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = root.querySelector<HTMLInputElement>("#paid-input")!.value;
    const bad = paidAnswer(input);
    if (bad.tone === "warning") { show(bad.tone, bad.text); return; }
    show("muted", "Checking…");
    try {
      const row = (await load()).get(input.trim());
      const a = paidAnswer(input, row?.[3][contest], row?.[4][contest]);
      show(a.tone, a.text);
    } catch {
      show("warning", "The payout list could not be read. Try again in a moment.");
    }
  });
  root.dataset.ready = "";
}

document.querySelectorAll<HTMLElement>("[data-paid-check]").forEach(init);
