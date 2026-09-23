// My DID identity wizard, in the style of the approved mockups. Primary flow (Ben, 2026-09-23):
// Create DID -> Download the encrypted recovery file once -> Write a message -> Publish -> Message published.
// Plus Restore, for a later visit, when the reader wants to publish again.
// The unlocked identity lives only in this module's memory, for this tab: closing or reloading the page,
// or "Lock my DID", forgets it. Creating, sealing, downloading and restoring make no request at all.
// The only requests this file makes are the publication of one reviewed, confirmed message and reads
// of the room to find it again. Nothing is stored, logged or put in a URL; errors carry no key material.
// The server reply is kept in memory only to check the result; a technical receipt is optional.
import { openChosen } from "../lib/did-open.mjs";
import { lookFor, publish as publishMessage } from "../lib/publish.mjs";
import {
  COMMUNITY, createIdentity, forget, INTRODUCTION, messageProblem, MIN_PASSWORD, nextNonce, openBackup, passwordProblem, proofOf, sealBackup,
  signMessage, WalletError,
} from "../lib/did-wallet.mjs";
import { dateTimeUtc } from "../lib/format";
import { known } from "../lib/rooms.mjs";
import { roomPicker, type Room } from "./room-picker.ts";

type Identity = { did: string; privateKey: CryptoKey };
type Signed = { room: string; nonce: string; text: string; did: string; sig: string };
type Stored = { seq?: number; ts?: string; from?: string; text?: string; nonce?: string; sig?: string };
type Panel = "start" | "create" | "restore" | "protect" | "save" | "message" | "outcome";
type Kind = "published" | "unconfirmed" | "refused";

const root = document.querySelector<HTMLElement>("[data-wizard]");
const PANELS: Panel[] = ["start", "create", "restore", "protect", "save", "message", "outcome"];
const STEP: Record<Panel, number> = { start: -1, create: 0, restore: -1, protect: 1, save: 1, message: 2, outcome: 3 };
const WITH_LOOKUP: Panel[] = ["start", "outcome"];

if (root) {
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const rooms = (JSON.parse(root.dataset.rooms ?? "[]") as Room[]).filter((r) => typeof r.room === "string");
  const names = rooms.map((r) => r.room);
  let identity: Identity | null = null;
  let pkcs8: Uint8Array | null = null; // only between creation and the recovery file download
  let backup: { name: string; file: object } | null = null; // sealed, waiting for the reader to save it
  let downloaded = false; // the reader asked for the file, whether or not they confirmed keeping it
  let backedUp = false;
  let busy = false;
  let signed: Signed | null = null;
  let attempted = false; // a signed message is sent at most once, whatever happens
  let unconfirmed = false;
  let result: { kind: Kind; reply: string | null; stored: Stored | null } | null = null;
  let created = false; // this DID was made here, so the page keeps the "Create" title of the mockup
  let sent = 0; // messages published in this tab

  const error = (name: string, text: string) => { q<HTMLElement>(`[data-error="${name}"]`).textContent = text; };
  const clearErrors = () => root.querySelectorAll<HTMLElement>("[data-error]").forEach((e) => { e.textContent = ""; });
  const safe = (e: unknown, fallback: string) => (e instanceof WalletError ? e.message : fallback);
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/:/g, "").replace("T", "-");
  const short = (did: string) => did.slice(-8);
  const download = (name: string, data: object) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  function show(panel: Panel) {
    for (const p of PANELS) q<HTMLElement>(`[data-panel="${p}"]`).hidden = p !== panel;
    q<HTMLElement>("[data-sees]").hidden = panel !== "start";
    const at = STEP[panel];
    q<HTMLElement>("[data-stepper]").hidden = at < 0;
    // on a phone the steps show numbers only: say the current one in words
    const now = q<HTMLElement>("[data-step-now]");
    now.hidden = at < 0;
    now.textContent = at < 0 ? "" : `Step ${at + 1} of 4: ${q<HTMLElement>(`[data-step="${at}"]`).dataset.stepLabel}`;
    root!.querySelectorAll<HTMLElement>("[data-step]").forEach((li) => {
      const i = Number(li.dataset.step);
      if (i === at) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
      if (i < at || (panel === "outcome" && result?.kind === "published")) li.dataset.done = "";
      else delete li.dataset.done;
    });
    const h1 = document.querySelector<HTMLElement>("[data-page-title]");
    if (h1) h1.textContent = panel === "create" || (created && panel !== "start" && panel !== "restore") ? "Create your Technocore DID" : "My DID";
    const lookup = document.querySelector<HTMLElement>("[data-lookup-area]");
    if (lookup) lookup.hidden = !WITH_LOOKUP.includes(panel);
    q<HTMLElement>("[data-action=start-over]").hidden = identity === null;
    q<HTMLElement>("[data-confirm-over]").hidden = true;
    // a passphrase shown in clear never stays shown on the next screen
    root!.querySelectorAll<HTMLButtonElement>("[data-show]").forEach((b) => {
      q<HTMLInputElement>(b.dataset.show!).type = "password";
      b.textContent = "Show";
      b.setAttribute("aria-pressed", "false");
      b.setAttribute("aria-label", "Show the passphrase");
    });
    root!.querySelectorAll<HTMLElement>("[data-did-value]").forEach((c) => { c.textContent = identity?.did ?? ""; });
    if (panel !== "start") q<HTMLElement>(`[data-panel="${panel}"] h2`).focus();
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

  // leaving before the recovery file is saved loses the DID; leaving while a message is in flight loses its outcome
  window.addEventListener("beforeunload", (e) => {
    if ((identity && !backedUp) || (attempted && unconfirmed) || busy) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  // the unlocked key is forgotten when the page goes away, whatever the reason
  window.addEventListener("pagehide", () => {
    forget(pkcs8);
    pkcs8 = null;
    identity = null;
    backup = null;
    downloaded = false;
  });

  q<HTMLInputElement>("[data-restore-file]").addEventListener("change", (e) => {
    const names = [...((e.currentTarget as HTMLInputElement).files ?? [])].map((f) => f.name);
    q<HTMLElement>("[data-restore-file-name]").textContent = names.join(", ") || "No file chosen";
  });

  // ---------- landing ----------
  q<HTMLButtonElement>("[data-action=begin]").addEventListener("click", () => show("create"));
  q<HTMLButtonElement>("[data-action=begin-restore]").addEventListener("click", () => show("restore"));

  // ---------- 1. create ----------
  q<HTMLButtonElement>("[data-action=create]").addEventListener("click", (e) => guard(e.currentTarget as HTMLButtonElement, async () => {
    clearErrors();
    if (identity) return;
    try {
      const made = await createIdentity(crypto.subtle);
      identity = { did: made.did, privateKey: made.privateKey };
      pkcs8 = made.pkcs8;
      backedUp = false;
      downloaded = false;
      created = true;
      show("protect");
    } catch (err) {
      error("create", safe(err, "This browser could not create an Ed25519 key. Try a current version of Chrome, Edge, Firefox or Safari."));
    }
  }));

  // ---------- 2. protect: one download, then straight to the message ----------
  const strength = (pw: string) => {
    const n = [...pw].length;
    const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z\d]/].filter((r) => r.test(pw)).length;
    return n < MIN_PASSWORD ? (n === 0 ? 0 : 1) : n >= 20 || (n >= 16 && kinds >= 3) ? 4 : n >= 16 || kinds >= 3 ? 3 : 2;
  };
  const LEVEL = [`At least ${MIN_PASSWORD} characters.`, `Too short: at least ${MIN_PASSWORD} characters.`, "Fair: longer is safer.", "Good.", "Strong: long, with several kinds of characters."];
  q<HTMLInputElement>("[data-seal-password]").addEventListener("input", (e) => {
    const s = strength((e.currentTarget as HTMLInputElement).value);
    root.querySelectorAll<HTMLElement>("[data-bar]").forEach((b) => { if (Number(b.dataset.bar) < s) b.dataset.on = ""; else delete b.dataset.on; });
    q<HTMLElement>("[data-strength]").textContent = LEVEL[s];
  });
  root.querySelectorAll<HTMLButtonElement>("[data-show]").forEach((b) => b.addEventListener("click", () => {
    const field = q<HTMLInputElement>(b.dataset.show!);
    const shown = field.type === "text";
    field.type = shown ? "password" : "text";
    b.textContent = shown ? "Show" : "Hide";
    b.setAttribute("aria-pressed", String(!shown));
    b.setAttribute("aria-label", shown ? "Show the passphrase" : "Hide the passphrase");
  }));
  const copy = q<HTMLButtonElement>("[data-copy-did]");
  copy.addEventListener("click", async () => {
    const label = copy.querySelector<HTMLElement>("[data-copy-label]")!;
    try {
      await navigator.clipboard.writeText(identity?.did ?? "");
      label.textContent = "Copied";
    } catch {
      label.textContent = "Select and copy it";
    }
    setTimeout(() => { label.textContent = "Copy"; }, 2000);
  });

  q<HTMLFormElement>("[data-seal]").addEventListener("submit", (e) => {
    e.preventDefault();
    return guard((e.currentTarget as HTMLFormElement).querySelector("button[type=submit]"), async () => {
      clearErrors();
      const pw = q<HTMLInputElement>("[data-seal-password]");
      const again = q<HTMLInputElement>("[data-seal-confirm]");
      const problem = passwordProblem(pw.value, again.value);
      if (problem) return error("seal", problem);
      if (!identity || !pkcs8) return error("seal", "There is no DID to protect in this tab.");
      try {
        const file = await sealBackup(crypto.subtle, (n: number) => crypto.getRandomValues(new Uint8Array(n)), { did: identity.did, pkcs8 }, pw.value);
        backup = { name: `room-census-did-recovery-${short(identity.did)}-${stamp()}.json`, file };
        forget(pkcs8);
        pkcs8 = null;
        pw.value = "";
        again.value = "";
        q<HTMLElement>("[data-file-name]").textContent = backup.name;
        q<HTMLElement>("[data-after-download]").hidden = true;
        q<HTMLInputElement>("[data-saved-check]").checked = false;
        q<HTMLButtonElement>("[data-action=continue]").disabled = true;
        q<HTMLElement>("[data-download-label]").textContent = "Download recovery file";
        show("save");
      } catch (err) {
        error("seal", safe(err, "The recovery file could not be made. Nothing was saved."));
      }
    });
  });

  // ---------- 2b. save: nothing continues until the reader downloads the file on purpose ----------
  const savedCheck = q<HTMLInputElement>("[data-saved-check]");
  q<HTMLButtonElement>("[data-action=download-backup]").addEventListener("click", () => {
    if (!backup) return;
    download(backup.name, backup.file);
    downloaded = true;
    q<HTMLElement>("[data-after-download]").hidden = false;
    q<HTMLElement>("[data-download-label]").textContent = "Download it again";
    savedCheck.focus();
  });
  savedCheck.addEventListener("change", () => { q<HTMLButtonElement>("[data-action=continue]").disabled = !savedCheck.checked; });
  q<HTMLButtonElement>("[data-action=continue]").addEventListener("click", () => {
    if (!backup || !savedCheck.checked) return;
    if (!identity) return error("save", "This DID is no longer unlocked in this tab. Open your recovery file to publish.");
    backedUp = true;
    backup = null;
    q<HTMLElement>("[data-saved-note]").hidden = false;
    compose();
  });

  // ---------- restore (a later visit) ----------
  q<HTMLFormElement>("[data-restore]").addEventListener("submit", (e) => {
    e.preventDefault();
    return guard((e.currentTarget as HTMLFormElement).querySelector("button[type=submit]"), async () => {
      clearErrors();
      if (identity) return;
      const chosen = [...(q<HTMLInputElement>("[data-restore-file]").files ?? [])];
      const pw = q<HTMLInputElement>("[data-restore-password]");
      // the same opening as the Write page: lib/did-open.mjs
      const opened = await openChosen(crypto.subtle, chosen, pw.value);
      if (opened.problem) return error("restore", opened.problem);
      identity = opened.identity!;
      // a DID that was already saved somewhere does not have to be saved again here
      backedUp = true;
      pw.value = "";
      q<HTMLElement>("[data-saved-note]").hidden = true;
      compose();
    });
  });

  // ---------- 3. write, 4. publish ----------
  const text = q<HTMLTextAreaElement>("[data-message]");
  const preview = q<HTMLElement>("[data-preview]");
  const understand = q<HTMLInputElement>("[data-understand]");
  const publish = q<HTMLButtonElement>("[data-action=publish]");
  const status = q<HTMLElement>("[data-publish-status]");
  // the community room is proposed but cannot be written to until it exists; any measured room can
  const picker = roomPicker(q<HTMLElement>("[data-room-area]"), rooms, () => {
    signed = null;
    invalidate();
    // the list is rebuilt on every pick, so the focus is moved on instead of being lost
    q<HTMLTextAreaElement>("[data-message]").focus();
  });
  if (COMMUNITY.ready && known(rooms, COMMUNITY.room)) picker.set(COMMUNITY.room);
  const room = () => picker.selected;

  /** A fresh composer: nothing signed, nothing attempted. */
  function compose() {
    signed = null;
    attempted = false;
    unconfirmed = false;
    result = null;
    text.value = sent === 0 ? INTRODUCTION : "";
    text.disabled = false;
    understand.checked = false;
    understand.disabled = false;
    publish.disabled = true;
    preview.hidden = true;
    status.textContent = "";
    q<HTMLElement>("[data-message-title]").textContent = sent === 0 ? "Publish your first message" : "Publish another message";
    show("message");
  }

  const invalidate = () => {
    if (attempted) return;
    signed = null;
    preview.hidden = true;
    understand.checked = false;
    publish.disabled = true;
  };
  root.querySelectorAll<HTMLButtonElement>("[data-starter]").forEach((b) => b.addEventListener("click", () => {
    if (attempted) return;
    text.value = b.dataset.starterText ?? "";
    invalidate();
    text.focus();
    // select the first part to replace, so typing replaces it
    const start = text.value.indexOf("[");
    if (start >= 0) text.setSelectionRange(start, text.value.indexOf("]", start) + 1);
  }));
  text.addEventListener("input", invalidate);
  understand.addEventListener("change", () => { publish.disabled = !(understand.checked && signed && !attempted); });

  q<HTMLFormElement>("[data-compose]").addEventListener("submit", (e) => {
    e.preventDefault();
    return guard(null, async () => {
      clearErrors();
      if (attempted) return;
      if (!identity) return error("compose", "This DID is no longer unlocked in this tab. Open your recovery file to publish.");
      const problem = messageProblem(room(), text.value, names);
      if (problem) return error("compose", problem);
      try {
        signed = await signMessage(crypto.subtle, identity, room(), nextNonce(), text.value);
      } catch (err) {
        return error("compose", safe(err, "The message could not be signed. Nothing was sent."));
      }
      q<HTMLElement>("[data-preview-room]").textContent = signed.room;
      q<HTMLElement>("[data-preview-text]").textContent = signed.text;
      q<HTMLElement>("[data-preview-did]").textContent = signed.did;
      understand.checked = false;
      publish.disabled = true;
      preview.hidden = false;
      q<HTMLElement>("#preview-title").focus();
    });
  });

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
    q<HTMLElement>("[data-out-nonce]").textContent = signed!.nonce;
    q<HTMLElement>("[data-out-sig]").textContent = signed!.sig;
    let when = "not confirmed";
    try { if (stored?.ts) when = `#${stored.seq}, ${dateTimeUtc(stored.ts.replace(/(\.\d{3})\d+/, "$1"))}`; } catch { when = `#${stored?.seq}`; }
    q<HTMLElement>("[data-out-stored]").textContent = when;
    q<HTMLElement>("[data-action=view]").hidden = !ok;
    q<HTMLElement>("[data-action=another]").hidden = !ok;
    q<HTMLElement>("[data-action=look]").hidden = kind !== "unconfirmed";
    q<HTMLElement>("[data-action=edit]").hidden = kind !== "refused";
    q<HTMLElement>("[data-outcome-foot]").textContent = kind === "unconfirmed" ? "Checking never sends a second copy." : "";
    q<HTMLDetailsElement>("[data-advanced]").open = false;
    status.textContent = "";
    show("outcome");
  }

  function succeed(m: Stored, reply: string) {
    unconfirmed = false;
    sent += 1;
    outcome("published", "Technocore stored your message, and its signature was checked on this device.", reply, m);
  }

  // one publication path for the whole site: lib/publish.mjs
  publish.addEventListener("click", () => guard(publish, async () => {
    if (!signed || attempted || !understand.checked) return;
    attempted = true;
    unconfirmed = true;
    understand.disabled = true;
    text.disabled = true;
    status.textContent = `Publishing to ${signed.room}…`;
    const out = await publishMessage(crypto.subtle, signed);
    if (out.kind === "published") return succeed(out.stored!, out.reply!);
    if (out.kind === "refused") {
      unconfirmed = false;
      return outcome("refused", `${out.reason}. Nothing was published.`, out.reply, null);
    }
    return outcome("unconfirmed", `${out.reason}. It may already be public; it will not be sent again from this page.`, out.reply, null);
  }));

  q<HTMLButtonElement>("[data-action=look]").addEventListener("click", (e) => guard(e.currentTarget as HTMLButtonElement, async () => {
    if (!signed || !unconfirmed) return;
    const foot = q<HTMLElement>("[data-outcome-foot]");
    foot.textContent = `Reading ${signed.room}…`;
    const out = await lookFor(crypto.subtle, signed);
    if (out.kind === "published") return succeed(out.stored!, out.reply!);
    foot.textContent = out.kind === "unreachable"
      ? "technocore.chat could not be reached. Nothing was sent."
      : "Not found among the newest 200 messages of the room. Nothing was sent again.";
  }));

  // after a refusal nothing was published: the message may be changed and signed again
  q<HTMLButtonElement>("[data-action=edit]").addEventListener("click", () => {
    if (!signed || result?.kind !== "refused") return;
    const kept = text.value;
    compose();
    text.value = kept;
  });
  // skipping publishes nothing: the identity stays unlocked and the activity lookup opens
  q<HTMLButtonElement>("[data-action=skip]").addEventListener("click", () => {
    if (attempted || !identity) return;
    signed = null;
    q<HTMLElement>("[data-panel=message]").hidden = true;
    const area = document.querySelector<HTMLElement>("[data-lookup-area]");
    const input = document.querySelector<HTMLInputElement>("#did-input");
    const lookup = document.querySelector<HTMLFormElement>("form[data-did-form]");
    if (area) area.hidden = false;
    if (input && lookup) {
      input.value = identity.did;
      lookup.requestSubmit();
      lookup.scrollIntoView({ block: "start" });
    }
  });

  q<HTMLButtonElement>("[data-action=another]").addEventListener("click", () => {
    if (result?.kind === "published") compose();
  });

  // My DID activity uses the public DID only: it is filled here, in the page, never put in a URL
  q<HTMLButtonElement>("[data-action=view]").addEventListener("click", () => {
    const input = document.querySelector<HTMLInputElement>("#did-input");
    const lookup = document.querySelector<HTMLFormElement>("form[data-did-form]");
    if (!identity || !input || !lookup) return;
    input.value = identity.did;
    lookup.requestSubmit();
    lookup.scrollIntoView({ block: "start" });
  });

  // optional, inside Advanced: the complete server reply and what was signed
  q<HTMLButtonElement>("[data-action=download-proof]").addEventListener("click", () => {
    if (!signed || !result) return;
    download(`room-census-technical-receipt-${short(signed.did)}-${stamp()}.json`, proofOf(signed, result.kind, result.reply, result.stored));
  });

  // ---------- lock ----------
  const confirmBox = q<HTMLElement>("[data-confirm-over]");
  q<HTMLButtonElement>("[data-action=start-over]").addEventListener("click", () => {
    q<HTMLElement>("[data-confirm-over-text]").textContent = [
      backedUp ? "Lock and forget your DID in this tab? To publish again, open your recovery file."
        : downloaded ? "Lock and forget this DID? You downloaded its recovery file but did not confirm keeping it: without that file the DID is lost for good."
        : "Lock and forget this DID? Its recovery file is not saved yet, so it will be lost for good.",
      attempted && unconfirmed ? "Your last message could not be confirmed and may already be public: check the room before writing it again." : "",
    ].filter(Boolean).join(" ");
    confirmBox.hidden = false;
    q<HTMLButtonElement>("[data-action=over-no]").focus();
  });
  q<HTMLButtonElement>("[data-action=over-no]").addEventListener("click", () => { confirmBox.hidden = true; });
  q<HTMLButtonElement>("[data-action=over-yes]").addEventListener("click", () => {
    if (busy) return;
    forget(pkcs8);
    pkcs8 = null;
    identity = null;
    backedUp = false;
    downloaded = false;
    backup = null;
    signed = null;
    attempted = false;
    unconfirmed = false;
    result = null;
    created = false;
    sent = 0;
    root!.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea").forEach((i) => {
      if (i instanceof HTMLInputElement && (i.type === "checkbox" || i.type === "radio")) i.checked = false;
      else i.value = "";
      i.disabled = false;
    });
    q<HTMLElement>("[data-restore-file-name]").textContent = "No file chosen";
    q<HTMLElement>("[data-saved-note]").hidden = true;
    q<HTMLElement>("[data-after-download]").hidden = true;
    q<HTMLButtonElement>("[data-action=continue]").disabled = true;
    q<HTMLElement>("[data-download-label]").textContent = "Download recovery file";
    preview.hidden = true;
    clearErrors();
    show("start");
  });

  document.querySelector("[data-wizard-noscript]")?.remove();
  // shown inside another site's frame, the wizard stays closed: a key must be typed on this site only
  if (window.top !== window.self) {
    document.querySelector<HTMLElement>("[data-framed]")!.hidden = false;
  } else {
    root.hidden = false;
    show("start");
  }
}
