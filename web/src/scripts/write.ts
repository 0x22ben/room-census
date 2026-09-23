// Write: open a DID from the file that holds its key, choose a room that already exists, review and
// publish one signed message. Two local backup formats open the same DID: the Room Census .json
// recovery file and the identity.pem written by the Python tool. The unlocked key lives only in this
// module's memory, for this tab, and the DID that signs is always derived from it: nothing here reads
// a DID typed by the reader, and did.txt is only ever a check. Opening a file makes no request.
// Publishing sends one message, after a review and a confirmation, and never resends it.
import { backupFromPem, messageProblem, MIN_PASSWORD, nextNonce, proofOf, signMessage, WalletError } from "../lib/did-wallet.mjs";
import { dateTimeUtc } from "../lib/format";
import { lookFor, publish } from "../lib/publish.mjs";
import { openChosen } from "../lib/did-open.mjs";
import { known } from "../lib/rooms.mjs";
import { roomPicker, type Room } from "./room-picker.ts";

type Identity = { did: string; privateKey: CryptoKey };
type Signed = { room: string; nonce: string; text: string; did: string; sig: string };
type Stored = { seq?: number; ts?: string };
type Kind = "published" | "unconfirmed" | "refused";

const root = document.querySelector<HTMLElement>("[data-write]");

if (root) {
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const rooms = (JSON.parse(root.dataset.rooms ?? "[]") as Room[]).filter((r) => typeof r.room === "string");
  const names = rooms.map((r) => r.room);
  let identity: Identity | null = null;
  let room = "";
  let signed: Signed | null = null;
  let attempted = false;
  let unconfirmed = false;
  let busy = false;
  let result: { kind: Kind; reply: string | null; stored: Stored | null } | null = null;
  // the encrypted PEM text, kept only so its own passphrase can seal a recovery file later
  let pem: string | null = null;
  let offered = false;

  const error = (name: string, text: string) => { q<HTMLElement>(`[data-error="${name}"]`).textContent = text; };
  const clearErrors = () => root.querySelectorAll<HTMLElement>("[data-error]").forEach((e) => { e.textContent = ""; });
  const safe = (e: unknown, fallback: string) => (e instanceof WalletError ? e.message : fallback);
  const short = (did: string) => did.slice(-8);
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/:/g, "").replace("T", "-");
  const download = (name: string, data: object) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  type Panel = "locked" | "compose" | "review" | "outcome";
  function show(panel: Panel) {
    q<HTMLElement>("[data-panel=locked]").hidden = panel !== "locked";
    q<HTMLElement>("[data-panel=locked-notes]").hidden = panel !== "locked";
    q<HTMLElement>("[data-signing]").hidden = panel === "locked";
    q<HTMLElement>("[data-offer]").hidden = panel === "locked" || !pem || !offered;
    q<HTMLElement>("[data-panel=room]").hidden = panel !== "compose";
    q<HTMLElement>("[data-panel=message]").hidden = panel !== "compose";
    q<HTMLElement>("[data-panel=review]").hidden = panel !== "review";
    q<HTMLElement>("[data-panel=outcome]").hidden = panel !== "outcome";
    // the page lede sits in the header, outside the panels
    const lede = document.querySelector<HTMLElement>("[data-page-lede]");
    if (lede) {
      lede.textContent = panel === "locked"
        ? "Open your DID file to sign. A public DID alone can never publish."
        : "Signed by the DID in your file, in a room that already exists.";
    }
    // a passphrase shown in clear never stays shown
    root!.querySelectorAll<HTMLButtonElement>("[data-show]").forEach((b) => {
      q<HTMLInputElement>(b.dataset.show!).type = "password";
      b.textContent = "Show";
      b.setAttribute("aria-pressed", "false");
      b.setAttribute("aria-label", "Show the passphrase");
    });
    root!.querySelectorAll<HTMLElement>("[data-did-value]").forEach((c) => { c.textContent = identity?.did ?? ""; });
    const heads: Record<Panel, string> = { locked: "[data-panel=locked] h2", compose: "[data-panel=room] h2", review: "[data-panel=review] h2", outcome: "[data-panel=outcome] h2" };
    q<HTMLElement>(heads[panel]).focus();
  }

  async function guard(button: HTMLButtonElement | null, work: () => Promise<void>) {
    if (busy) return;
    busy = true;
    if (button) button.disabled = true;
    try {
      await work();
    } finally {
      busy = false;
      if (button) button.disabled = false;
    }
  }

  window.addEventListener("beforeunload", (e) => {
    if ((attempted && unconfirmed) || busy) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  // the unlocked key is forgotten when the page goes away, whatever the reason
  window.addEventListener("pagehide", () => { identity = null; pem = null; });

  root.querySelectorAll<HTMLButtonElement>("[data-show]").forEach((b) => b.addEventListener("click", () => {
    const field = q<HTMLInputElement>(b.dataset.show!);
    const shown = field.type === "text";
    field.type = shown ? "password" : "text";
    b.textContent = shown ? "Show" : "Hide";
    b.setAttribute("aria-pressed", String(!shown));
    b.setAttribute("aria-label", shown ? "Show the passphrase" : "Hide the passphrase");
  }));

  // ---------- open the DID ----------
  const file = q<HTMLInputElement>("[data-unlock-file]");
  file.addEventListener("change", () => {
    const names = [...(file.files ?? [])].map((f) => f.name);
    q<HTMLElement>("[data-unlock-file-name]").textContent = names.join(", ") || "No file chosen";
  });

  q<HTMLFormElement>("[data-unlock]").addEventListener("submit", (e) => {
    e.preventDefault();
    return guard((e.currentTarget as HTMLFormElement).querySelector("button[type=submit]"), async () => {
      clearErrors();
      if (identity) return;
      const pw = q<HTMLInputElement>("[data-unlock-password]");
      // My DID and Write open a file the same way: lib/did-open.mjs
      const opened = await openChosen(crypto.subtle, [...(file.files ?? [])], pw.value);
      if (opened.problem) {
        pem = null;
        offered = false;
        return error("unlock", opened.problem);
      }
      identity = opened.identity!;
      pem = opened.pem;
      offered = Boolean(opened.pem);
      pw.value = "";
      show("compose");
    });
  });

  // ---------- the same DID, also as a Room Census recovery file ----------
  const offerForm = q<HTMLFormElement>("[data-offer-form]");
  const closeOffer = () => {
    offered = false;
    offerForm.hidden = true;
    q<HTMLElement>("[data-offer]").hidden = true;
    (offerForm.querySelectorAll("input") as NodeListOf<HTMLInputElement>).forEach((i) => { i.value = ""; });
  };
  q<HTMLButtonElement>("[data-action=offer-open]").addEventListener("click", () => {
    offerForm.hidden = false;
    q<HTMLElement>("[data-offer-actions]").hidden = true;
    q<HTMLInputElement>("[data-offer-pem]").focus();
  });
  q<HTMLButtonElement>("[data-action=offer-skip]").addEventListener("click", closeOffer);
  offerForm.addEventListener("submit", (e) => {
    e.preventDefault();
    return guard(offerForm.querySelector("button[type=submit]"), async () => {
      clearErrors();
      const pemPass = q<HTMLInputElement>("[data-offer-pem]");
      if (!identity || !pem) return error("offer", "Open your identity.pem first.");
      if (!pemPass.value) return error("offer", "Enter the passphrase that protects your identity.pem.");
      if (pemPass.value.length < MIN_PASSWORD) {
        return error("offer", `A Room Census recovery file needs at least ${MIN_PASSWORD} characters, and it is protected by this same passphrase. Yours is shorter, so no file was written.`);
      }
      try {
        // the same key and the same DID in another container, proven before anything is written
        const sealed = await backupFromPem(crypto.subtle, (n: number) => crypto.getRandomValues(new Uint8Array(n)), pem, pemPass.value, pemPass.value, identity.did);
        download(`room-census-did-recovery-${short(identity.did)}-${stamp()}.json`, sealed);
        pemPass.value = "";
        offerForm.hidden = true;
        q<HTMLElement>("[data-offer-done]").hidden = false;
      } catch (err) {
        error("offer", safe(err, "This file could not be written."));
      }
    });
  });

  q<HTMLButtonElement>("[data-action=lock]").addEventListener("click", () => {
    if (busy) return;
    identity = null;
    pem = null;
    offered = false;
    room = "";
    signed = null;
    attempted = false;
    unconfirmed = false;
    result = null;
    root!.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea").forEach((i) => {
      if (i instanceof HTMLInputElement && i.type === "checkbox") i.checked = false;
      else i.value = "";
      i.disabled = false;
    });
    q<HTMLElement>("[data-unlock-file-name]").textContent = "No file chosen";
    offerForm.hidden = true;
    q<HTMLElement>("[data-offer-actions]").hidden = false;
    q<HTMLElement>("[data-offer-done]").hidden = true;
    clearErrors();
    show("locked");
  });

  // ---------- choose a room ----------
  const picker = roomPicker(q<HTMLElement>("[data-panel=room]"), rooms, (picked) => {
    room = picked;
    signed = null;
    q<HTMLTextAreaElement>("[data-message]").focus();
  });

  // ---------- write ----------
  const text = q<HTMLTextAreaElement>("[data-message]");
  const understand = q<HTMLInputElement>("[data-understand]");
  const publishButton = q<HTMLButtonElement>("[data-action=publish]");
  const status = q<HTMLElement>("[data-publish-status]");

  root.querySelectorAll<HTMLButtonElement>("[data-starter]").forEach((b) => b.addEventListener("click", () => {
    text.value = b.dataset.starterText ?? "";
    signed = null;
    text.focus();
    const start = text.value.indexOf("[");
    if (start >= 0) text.setSelectionRange(start, text.value.indexOf("]", start) + 1);
  }));
  text.addEventListener("input", () => { signed = null; });

  q<HTMLFormElement>("[data-compose]").addEventListener("submit", (e) => {
    e.preventDefault();
    return guard(null, async () => {
      clearErrors();
      if (!identity) return error("compose", "Unlock your DID first.");
      // the room must be one this page carries: an unknown name would create a room on Technocore
      if (!known(rooms, room)) return error("compose", "Choose a room from the list.");
      const problem = messageProblem(room, text.value, names);
      if (problem) return error("compose", problem);
      try {
        signed = await signMessage(crypto.subtle, identity, room, nextNonce(), text.value);
      } catch (err) {
        return error("compose", safe(err, "The message could not be signed. Nothing was sent."));
      }
      q<HTMLElement>("[data-review-room]").textContent = signed.room;
      q<HTMLElement>("[data-review-did]").textContent = signed.did;
      q<HTMLElement>("[data-review-text]").textContent = signed.text;
      understand.checked = false;
      publishButton.disabled = true;
      attempted = false;
      show("review");
    });
  });

  understand.addEventListener("change", () => { publishButton.disabled = !(understand.checked && signed && !attempted); });
  q<HTMLButtonElement>("[data-action=edit]").addEventListener("click", () => { if (!attempted) show("compose"); });

  function outcome(kind: Kind, lede: string, reply: string | null, stored: Stored | null) {
    result = { kind, reply, stored };
    const ok = kind === "published";
    q<HTMLElement>("[data-outcome-tile]").className = ok
      ? "grid size-12 place-items-center rounded-lg border border-accent-border bg-accent-soft text-accent"
      : "grid size-12 place-items-center rounded-lg border border-warning-border bg-warning-soft text-warning";
    q<SVGElement>("[data-icon-ok]").classList.toggle("hidden", !ok);
    q<SVGElement>("[data-icon-warn]").classList.toggle("hidden", ok);
    q<HTMLElement>("[data-panel=outcome]").dataset.outcome = kind;
    q<HTMLElement>("[data-outcome-title]").textContent = ok ? "Message published" : kind === "refused" ? "Not published" : "Publication could not be confirmed";
    q<HTMLElement>("[data-outcome-lede]").textContent = lede;
    q<HTMLElement>("[data-out-room]").textContent = signed!.room;
    q<HTMLElement>("[data-out-text]").textContent = signed!.text;
    q<HTMLElement>("[data-out-nonce]").textContent = signed!.nonce;
    q<HTMLElement>("[data-out-sig]").textContent = signed!.sig;
    let when = "not confirmed";
    try { if (stored?.ts) when = `#${stored.seq}, ${dateTimeUtc(stored.ts.replace(/(\.\d{3})\d+/, "$1"))}`; } catch { when = `#${stored?.seq}`; }
    q<HTMLElement>("[data-out-stored]").textContent = when;
    // My DID needs the public DID only. A fragment stays in the browser: it is never sent with a request.
    q<HTMLAnchorElement>("[data-action=view]").href = `/did/#did=${encodeURIComponent(signed!.did)}`;
    q<HTMLElement>("[data-action=view]").hidden = !ok;
    q<HTMLElement>("[data-action=another]").hidden = !ok;
    q<HTMLElement>("[data-action=share]").hidden = !ok;
    q<HTMLElement>("[data-share-note]").hidden = !ok;
    q<HTMLElement>("[data-action=look]").hidden = kind !== "unconfirmed";
    q<HTMLElement>("[data-action=edit-refused]").hidden = kind !== "refused";
    q<HTMLElement>("[data-outcome-foot]").textContent = kind === "unconfirmed" ? "Checking never sends a second copy." : "";
    q<HTMLDetailsElement>("[data-advanced]").open = false;
    status.textContent = "";
    show("outcome");
  }

  publishButton.addEventListener("click", () => guard(publishButton, async () => {
    if (!signed || attempted || !understand.checked) return;
    attempted = true;
    unconfirmed = true;
    understand.disabled = true;
    text.disabled = true;
    status.textContent = `Publishing to ${signed.room}…`;
    const out = await publish(crypto.subtle, signed);
    if (out.kind === "published") {
      unconfirmed = false;
      return outcome("published", "Technocore stored your message, and its signature was checked on this device.", out.reply, out.stored);
    }
    if (out.kind === "refused") {
      unconfirmed = false;
      return outcome("refused", `${out.reason}. Nothing was published.`, out.reply, null);
    }
    return outcome("unconfirmed", `${out.reason}. It may already be public; it will not be sent again from this page.`, out.reply, null);
  }));

  q<HTMLButtonElement>("[data-action=look]").addEventListener("click", (e) => guard(e.currentTarget as HTMLButtonElement, async () => {
    if (!signed || !unconfirmed) return;
    const note = q<HTMLElement>("[data-outcome-foot]");
    note.textContent = `Reading ${signed.room}…`;
    const out = await lookFor(crypto.subtle, signed);
    if (out.kind === "published") {
      unconfirmed = false;
      return outcome("published", "Technocore stored your message, and its signature was checked on this device.", out.reply, out.stored);
    }
    note.textContent = out.kind === "unreachable"
      ? "technocore.chat could not be reached. Nothing was sent."
      : "Not found among the newest 200 messages of the room. Nothing was sent again.";
  }));

  /** A fresh composer. `keepRoom` is false when the reader shares the same message in another room. */
  function compose(keepRoom: boolean, keepText: boolean) {
    const previous = text.value;
    signed = null;
    attempted = false;
    unconfirmed = false;
    result = null;
    understand.checked = false;
    understand.disabled = false;
    text.disabled = false;
    text.value = keepText ? previous : "";
    publishButton.disabled = true;
    if (!keepRoom) {
      room = "";
      picker.reset();
    }
    show("compose");
  }

  q<HTMLButtonElement>("[data-action=another]").addEventListener("click", () => { if (result?.kind === "published") compose(true, false); });
  // sharing the same text elsewhere: another room, another review, another signature and nonce
  q<HTMLButtonElement>("[data-action=share]").addEventListener("click", () => { if (result?.kind === "published") compose(false, true); });
  q<HTMLButtonElement>("[data-action=edit-refused]").addEventListener("click", () => { if (result?.kind === "refused") compose(true, true); });

  q<HTMLButtonElement>("[data-action=download-proof]").addEventListener("click", () => {
    if (!signed || !result) return;
    download(`room-census-technical-receipt-${short(signed.did)}-${stamp()}.json`, proofOf(signed, result.kind, result.reply, result.stored));
  });

  document.querySelector("[data-write-noscript]")?.remove();
  // shown inside another site's frame, the page stays closed: a key must be opened on this site only
  if (window.top !== window.self) {
    document.querySelector<HTMLElement>("[data-framed]")!.hidden = false;
  } else {
    root.hidden = false;
    show("locked");
  }
}
