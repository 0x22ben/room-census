// The live room on a room page: what this browser reads from Technocore right now, and, once a DID
// is open, what the reader sends there.
//
// Nothing here is stored. The messages are fetched by this page from the public room and written into
// the DOM as text, never as markup, so a message can never run anything or become a link. The key is
// opened by the same shared code as the Write page, it never leaves this page, and closing or leaving
// the page forgets it. Sending goes through the one publication path the whole site uses.
import { check, importKey, publicKey } from "../lib/did-core.mjs";
import { openChosen } from "../lib/did-open.mjs";
import { messageProblem, nextNonce, signMessage, sweep } from "../lib/did-wallet.mjs";
import { publish } from "../lib/publish.mjs";
import { FIRST, readRoom, shortFrom, shortTime, WAIT } from "../lib/room-feed.mjs";

type Identity = { did: string; privateKey: CryptoKey };
type Line = { seq: number; from: string; nick: string; ts: string; nonce: string; text: string; sig: string };

const root = document.querySelector<HTMLElement>("[data-chat]");

if (root && "crypto" in window && crypto.subtle) {
  const room = root.dataset.chat!;
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const list = q<HTMLElement>("[data-chat-list]");
  const status = q<HTMLElement>("[data-chat-status]");
  const locked = q<HTMLElement>("[data-chat-locked]");
  const unlock = q<HTMLFormElement>("[data-chat-unlock]");
  const sender = q<HTMLFormElement>("[data-chat-send]");
  const text = q<HTMLInputElement>("[data-chat-text]");

  const GAP = 2000;
  let identity: Identity | null = null;
  let last = 0;
  let live = true;
  let busy = false;
  const seen = new Set<number>();

  root.hidden = false;
  const writable = root.dataset.chatWritable === "yes";
  if (!writable) {
    locked.textContent = "";
    const note = document.createElement("p");
    note.className = "text-sm text-text-muted";
    note.textContent = "This room is not in the latest census, so this page does not offer to write in it. You can still read it here, and write in it on Technocore.";
    locked.append(note);
  }

  // ---------- reading ----------

  /**
   * Whether this message really was signed by the DID it names. A message can claim any sender, so
   * nothing is shown as signed until the signature has been checked here, against that DID.
   */
  async function verify(m: Line): Promise<"checked" | "bad" | null> {
    if (!m.sig || !m.from.startsWith("did:key:")) return null;
    const raw = publicKey(m.from);
    if (!raw) return null;
    const key = await importKey(crypto.subtle, raw);
    if (!key) return null;
    const verdict = await check(crypto.subtle, key, m.from, room, { from: m.from, nonce: m.nonce, text: m.text, sig: m.sig });
    return verdict === "checked" ? "checked" : "bad";
  }

  /** One line, built from text only: nothing a message contains can become markup or a link. */
  function draw(m: Line) {
    if (seen.has(m.seq)) return;
    seen.add(m.seq);
    const li = document.createElement("li");
    li.className = "grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2.5 gap-y-0.5 font-mono text-xs sm:grid-cols-[auto_auto_minmax(0,1fr)]";
    const time = document.createElement("span");
    time.className = "text-text-muted tabular-nums";
    time.textContent = shortTime(m.ts);
    const who = document.createElement("span");
    who.className = "text-text-secondary";
    who.textContent = shortFrom(m.from, m.nick);
    who.title = m.from ? `${m.from}, signature not checked` : "no sender";
    who.dataset.checked = "pending";
    const body = document.createElement("span");
    body.className = "col-span-2 text-sm break-words whitespace-pre-wrap text-text sm:col-span-1";
    body.textContent = m.text;
    li.append(time, who, body);
    list.append(li);
    while (list.children.length > 300) list.firstElementChild!.remove();
    // the sender is only ever presented as the DID it claims once that claim has been checked here
    void verify(m).then((verdict) => {
      who.dataset.checked = verdict ?? "none";
      if (verdict === "checked") {
        who.className = "font-semibold text-accent";
        who.title = `${m.from}, signature checked in this browser`;
      } else if (verdict === "bad") {
        who.className = "font-semibold text-warning";
        who.textContent = `${shortFrom(m.from, m.nick)} (unverified)`;
        who.title = `${m.from}, the signature does not verify: this message may come from anyone`;
      } else {
        who.title = m.from ? `${m.from}, no signature to check` : "no sender";
      }
    }).catch(() => { who.dataset.checked = "none"; });
  }

  const atBottom = () => list.scrollTop + list.clientHeight >= list.scrollHeight - 24;

  function add(messages: Line[]) {
    const stick = atBottom();
    for (const m of messages) draw(m);
    if (stick) list.scrollTop = list.scrollHeight;
  }

  async function follow(resuming = false) {
    if (!resuming) {
      try {
        const first = await readRoom(room, { limit: FIRST });
        last = first.last;
        add(first.messages);
        status.textContent = first.messages.length ? "live" : "no message yet";
      } catch {
        status.textContent = "technocore.chat could not be reached";
        return;
      }
    }
    while (live) {
      // a busy room answers at once, every time: this page asks at most once every two seconds
      const started = Date.now();
      try {
        const next = await readRoom(room, { since: last, wait: WAIT });
        if (!live) return;
        last = next.last;
        add(next.messages);
        status.textContent = "live";
      } catch {
        if (!live) return;
        status.textContent = "reconnecting";
        await new Promise((r) => setTimeout(r, 5000));
      }
      const gap = GAP - (Date.now() - started);
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    }
  }

  // the page stops asking Technocore anything as soon as the reader leaves it, and forgets the key
  window.addEventListener("pagehide", () => {
    live = false;
    identity = null;
    status.textContent = "paused";
    // nothing may still say it is signing with a key this page no longer holds
    sender.hidden = true;
    q<HTMLElement>("[data-chat-did]").textContent = "";
    locked.hidden = false;
  });
  // coming back to a page the browser kept starts the reading again, rather than looking live frozen
  window.addEventListener("pageshow", () => {
    if (live) return;
    live = true;
    void follow(last > 0);
  });

  // ---------- opening a DID ----------

  const file = q<HTMLInputElement>("[data-chat-file]");
  file.addEventListener("change", () => {
    q<HTMLElement>("[data-chat-file-name]").textContent = [...(file.files ?? [])].map((f) => f.name).join(", ") || "No file chosen";
  });

  q<HTMLButtonElement>("[data-action=chat-open]").addEventListener("click", () => {
    locked.hidden = true;
    unlock.hidden = false;
    file.focus();
  });

  q<HTMLButtonElement>("[data-action=chat-cancel]").addEventListener("click", () => {
    unlock.reset();
    q<HTMLElement>("[data-chat-file-name]").textContent = "No file chosen";
    q<HTMLElement>("[data-chat-error]").textContent = "";
    unlock.hidden = true;
    locked.hidden = false;
  });

  unlock.addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    const button = unlock.querySelector<HTMLButtonElement>("button[type=submit]")!;
    button.disabled = true;
    const error = q<HTMLElement>("[data-chat-error]");
    const password = q<HTMLInputElement>("[data-chat-password]");
    const understand = q<HTMLInputElement>("[data-chat-understand]");
    void (async () => {
      try {
        error.textContent = "";
        if (!understand.checked) {
          error.textContent = "Tick the box: what you send here is public and permanent.";
          return;
        }
        // the same opening as the Write page and My DID
        const opened = await openChosen(crypto.subtle, [...(file.files ?? [])], password.value);
        if (opened.problem) {
          error.textContent = opened.problem;
          return;
        }
        identity = opened.identity!;
        password.value = "";
        unlock.hidden = true;
        locked.hidden = true;
        sender.hidden = false;
        q<HTMLElement>("[data-chat-did]").textContent = identity.did;
        text.focus();
      } finally {
        busy = false;
        button.disabled = false;
      }
    })();
  });

  q<HTMLButtonElement>("[data-action=chat-lock]").addEventListener("click", () => {
    identity = null;
    sender.hidden = true;
    unlock.hidden = true;
    unlock.reset();
    q<HTMLElement>("[data-chat-file-name]").textContent = "No file chosen";
    q<HTMLElement>("[data-chat-did]").textContent = "";
    locked.hidden = false;
  });

  // ---------- sending ----------

  sender.addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy || !identity) return;
    const error = q<HTMLElement>("[data-chat-send-error]");
    const button = sender.querySelector<HTMLButtonElement>("button[type=submit]")!;
    const written = text.value;
    const problem = messageProblem(room, written, [room]);
    if (problem) {
      error.textContent = problem;
      return;
    }
    busy = true;
    button.disabled = true;
    error.textContent = "";
    void (async () => {
      try {
        // what is signed is what Technocore will store: the text after its single line sweep
        const nonce = nextNonce();
        const signed = await signMessage(crypto.subtle, identity!, room, nonce, sweep(written));
        const out = await publish(crypto.subtle, signed);
        if (out.kind === "published") {
          text.value = "";
          if (out.stored) add([{ seq: Number(out.stored.seq), from: signed.did, nick: "", ts: String(out.stored.ts ?? ""), nonce: signed.nonce, text: signed.text, sig: signed.sig }]);
          return;
        }
        error.textContent = out.kind === "refused"
          ? `${out.reason}. Nothing was published.`
          : `${out.reason}. It may already be public, and this page will not send it again.`;
        if (out.kind === "unconfirmed") text.value = "";
      } finally {
        busy = false;
        button.disabled = false;
      }
    })();
  });

  void follow();
}
