// My DID lookup. Reads the newest messages of each inspected room from Technocore, keeps those that
// name the DID, checks their signatures in this browser and shows only what was checked. Nothing is
// stored, and nothing but public room reads leaves the browser: the DID itself is never sent.
import {
  check, importKey, publicKey, readReply, roomCoverage, shortestWindow, span, summarize, TECHNOCORE, validRoom, validTs, WINDOW,
} from "../lib/did-core.mjs";
import { dateTimeUtc } from "../lib/format";
import { DID_DISCLAIMER } from "../lib/patterns";

type Message = { seq?: number; ts?: string; from?: string; text?: string; nonce?: string; sig?: string };
type Found = { room: string; message: Message; result: "checked" | "bad" | "unsupported" };
type Coverage = ReturnType<typeof roomCoverage> | { room: string; status: "not read"; reason: string };

const form = document.querySelector<HTMLFormElement>("form[data-did-form]");
const result = document.querySelector<HTMLElement>("[data-did-result]");
const $ = <T extends HTMLElement>(sel: string) => result!.querySelector<T>(sel)!;
const PARALLEL = 4;
const TIMES = "Times are as reported by technocore.chat: a signature covers the room, the nonce and the text, not the time.";

// server timestamps carry microseconds; untrusted input must never break the page
function when(ts: unknown): string {
  if (!validTs(ts)) return "–";
  try {
    return dateTimeUtc((ts as string).replace(/(\.\d{3})\d+/, "$1"));
  } catch {
    return "–";
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

if (form && result) {
  const rooms = (JSON.parse(form.dataset.rooms ?? "[]") as unknown[]).filter(validRoom) as string[];
  const measured = new Set(JSON.parse(form.dataset.measured ?? "[]") as string[]);
  const pages = new Set(JSON.parse(form.dataset.pages ?? "[]") as string[]);
  const census = Number(form.dataset.census);
  const input = form.querySelector<HTMLInputElement>("input")!;
  const submit = form.querySelector<HTMLButtonElement>("[data-did-submit]")!;
  const error = form.querySelector<HTMLElement>("[data-did-error]")!;
  const heading = $<HTMLElement>("[data-did-heading]");
  const status = $<HTMLElement>("[data-did-status]");
  const progress = $<HTMLProgressElement>("[data-did-progress]");
  const cancel = $<HTMLButtonElement>("[data-did-cancel]");
  const proofButton = $<HTMLButtonElement>("[data-did-proof]");
  let running: AbortController | null = null;
  let proof: { did: string; checked_at: { finished: string } } | null = null;

  const fail = (text: string) => {
    error.textContent = text;
    input.setAttribute("aria-invalid", "true");
    input.focus();
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (running) return;
    const did = input.value.trim();
    const raw = publicKey(did);
    if (!raw) return fail("This is not an Ed25519 did:key. Check that it starts with did:key:z6Mk and was copied whole.");
    const controller = new AbortController();
    running = controller;
    submit.disabled = true;
    // without Ed25519 nothing could be counted, and "not found" would be false: stop before reading
    const key = await importKey(crypto.subtle, raw);
    if (!key) {
      running = null;
      submit.disabled = false;
      return fail("This browser cannot check Ed25519 signatures, so the lookup cannot run here. Try a current version of Chrome, Edge, Firefox or Safari.");
    }
    error.textContent = "";
    input.removeAttribute("aria-invalid");
    await lookup(did, key, controller);
    running = null;
    submit.disabled = false;
  });

  cancel.addEventListener("click", () => running?.abort());

  proofButton.addEventListener("click", () => {
    if (!proof) return;
    const blob = new Blob([JSON.stringify(proof, null, 2) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `did-activity-${proof.did.slice(-8)}-${proof.checked_at.finished.slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  async function lookup(did: string, key: CryptoKey, controller: AbortController) {
    const started = new Date().toISOString();
    const found: Found[] = [];
    const coverage: Coverage[] = [];
    proof = null;
    reset(did);
    let done = 0;
    let next = 0;

    const worker = async () => {
      while (next < rooms.length && !controller.signal.aborted) {
        const room = rooms[next++];
        try {
          const res = await fetch(`${TECHNOCORE}/r/${room}?format=json&limit=${WINDOW}`, {
            signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const messages = readReply(await res.text()) as Message[];
          coverage.push(roomCoverage(room, messages));
          for (const m of messages) {
            const r = await check(crypto.subtle, key, did, room, m);
            if (r) found.push({ room, message: m, result: r });
          }
        } catch (e) {
          coverage.push({ room, status: "not read", reason: controller.signal.aborted ? "stopped" : e instanceof Error ? e.message : "read failed" });
        }
        done += 1;
        progress.value = done / rooms.length;
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));

    const stopped = controller.signal.aborted;
    // rooms never reached after Stop are part of the coverage too, as not read
    const seen = new Set(coverage.map((c) => c.room));
    for (const room of rooms) if (!seen.has(room)) coverage.push({ room, status: "not read", reason: "stopped" });
    const order = new Map(rooms.map((r, i) => [r, i]));
    coverage.sort((a, b) => order.get(a.room)! - order.get(b.room)!);
    found.sort((a, b) => (b.message.ts ?? "").localeCompare(a.message.ts ?? ""));
    const finished = new Date().toISOString();
    show(found, coverage, stopped, finished);
    proof = {
      schema: "room-census-did-activity/1",
      did,
      disclaimer: DID_DISCLAIMER,
      checked_at: { started, finished },
      all_rooms_read: coverage.every((c) => c.status === "read"),
      coverage: {
        source: TECHNOCORE,
        read: `GET /r/<room>?format=json&limit=${WINDOW}: the newest ${WINDOW} messages of each room at read time, not its history`,
        rooms_from: `census #${census} of Room Census, plus the room where Room Census signs`,
        not_inspected: "older messages, rooms outside the census, private rooms",
        rooms: coverage,
      },
      verification: {
        method: "Ed25519 signature over the UTF-8 bytes of <room>|<nonce>|<text>, checked in the browser with Web Crypto",
        counted: "only messages whose signature checks",
        not_signed: "seq and ts are assigned by the server and are not covered by the signature",
      },
      summary: summarize(found),
      records: found.map((f) => ({ room: f.room, result: f.result, message: f.message })),
      note: "Nonces are kept as exact decimal strings. A signature re-verifies from room, nonce, text and sig.",
    } as typeof proof & object;
    proofButton.hidden = false;
  }

  function reset(did: string) {
    result!.hidden = false;
    heading.textContent = "Looking up this DID";
    $<HTMLElement>("[data-did-for]").textContent = did;
    status.textContent = `Reading ${rooms.length} rooms from technocore.chat.`;
    progress.hidden = false;
    progress.value = 0;
    cancel.hidden = false;
    proofButton.hidden = true;
    for (const sel of ["[data-did-summary]", "[data-did-messages]", "[data-did-coverage]"]) $<HTMLElement>(sel).hidden = true;
    heading.focus();
  }

  function show(found: Found[], coverage: Coverage[], stopped: boolean, finished: string) {
    const s = summarize(found);
    const read = coverage.filter((c) => c.status === "read").length;
    const failed = coverage.filter((c) => c.status !== "read" && c.reason !== "stopped").length;
    const checked = found.filter((x) => x.result === "checked");
    const inMeasured = checked.some((f) => measured.has(f.room));
    progress.hidden = true;
    cancel.hidden = true;
    heading.textContent = s.signed_messages === 0 ? "Not found in the inspected data"
      : inMeasured ? "Recent activity found in measured rooms" : "Recent activity found in the Room Census room";
    const narrow = shortestWindow(coverage);
    $<HTMLElement>("[data-did-meaning]").textContent = [
      s.signed_messages > 0
        ? `Signed messages from this DID were found among the newest ${WINDOW} messages of the rooms read. Older activity is not included.`
        : `No message signed by this DID among the newest ${WINDOW} messages of the rooms read. This does not mean the DID has no activity: older messages, other rooms and private rooms were not inspected.`,
      narrow ? `In the busiest room read (${narrow.room}), those messages covered only the last ${span(narrow.ms)}.` : "",
      s.signed_messages > 0 ? TIMES : "",
    ].filter(Boolean).join(" ");
    status.textContent = [
      `${read} of ${rooms.length} rooms read, finished ${when(finished)}.`,
      stopped ? "Stopped before the end." : "",
      failed > 0 ? `${failed} could not be read.` : "",
    ].filter(Boolean).join(" ");
    for (const [k, v] of Object.entries(s)) {
      const dd = result!.querySelector<HTMLElement>(`[data-kpi="${k}"]`);
      if (dd) dd.textContent = k === "last_active" ? when(v) : String(v);
    }
    // zeros would read as "no activity": when nothing is found, only the sentences above are shown
    $<HTMLElement>("[data-did-kpis]").hidden = s.signed_messages === 0;
    $<HTMLElement>("[data-did-bad]").textContent = s.not_verifiable > 0
      ? `${s.not_verifiable} ${s.not_verifiable === 1 ? "message names" : "messages name"} this DID without a valid signature. ${s.not_verifiable === 1 ? "It is" : "They are"} not counted.`
      : "";
    $<HTMLElement>("[data-did-summary]").hidden = false;

    const list = $<HTMLElement>("[data-did-list]");
    list.replaceChildren();
    for (const f of checked) {
      const li = el("li", "grid gap-1 border-t border-border px-4 py-3 first:border-t-0");
      const top = el("div", "flex flex-wrap items-center gap-x-3 gap-y-1");
      if (pages.has(f.room)) {
        const a = el("a", "font-mono break-all text-link", f.room);
        a.setAttribute("href", `/rooms/${f.room}/`);
        top.append(a);
      } else top.append(el("span", "font-mono break-all", f.room));
      top.append(el("span", "text-sm text-text-muted", when(f.message.ts)));
      top.append(el("span", "text-sm font-semibold text-accent", "Signature checked"));
      li.append(top, el("p", "line-clamp-2 break-words text-text-secondary", f.message.text ?? ""));
      li.append(el("p", "font-mono text-xs break-all text-text-muted", `nonce ${f.message.nonce ?? "–"}`));
      list.append(li);
    }
    $<HTMLElement>("[data-did-messages]").hidden = checked.length === 0;

    const body = $<HTMLElement>("[data-did-rooms]");
    body.replaceChildren();
    for (const c of coverage) {
      const tr = el("tr", "border-t border-border");
      tr.append(el("td", "px-4 py-2 font-mono", c.room));
      if (c.status === "read") {
        tr.append(el("td", "px-4 py-2 font-mono tabular-nums", `${c.messages_read} messages`),
          el("td", "px-4 py-2 font-mono text-xs", when(c.first_ts)),
          el("td", "px-4 py-2 font-mono text-xs", when(c.last_ts)));
      } else {
        const td = el("td", "px-4 py-2 text-warning", `Not read (${c.reason})`);
        td.colSpan = 3;
        tr.append(td);
      }
      body.append(tr);
    }
    $<HTMLElement>("[data-did-coverage]").hidden = false;
    heading.focus();
  }

  form.hidden = false;
  document.querySelector("[data-did-noscript]")?.remove();
}
