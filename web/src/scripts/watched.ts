// Watched rooms page: builds the list from this browser's storage and the room data embedded in the
// page. Only rooms that exist in the data are shown; every value is set as text, never as HTML.
import { sinceVisit, type Point } from "../lib/changes";
import { rate } from "../lib/format";
import { PATTERN, type Pattern } from "../lib/patterns";
import { lastSeen, markSeen, toggle, watched } from "../lib/watch-store";

// s: the last census that measured the room, when it is missing from the latest one
type Room = { p: Pattern | null; r: number | null; s: number | null; h: Point[] };

const root = document.querySelector<HTMLElement>("[data-watched]");
const COLOR: Record<Pattern, string> = { varied: "text-varied", mixed: "text-mixed", repetitive: "text-repetitive", quiet: "text-text-muted" };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

if (root) {
  const rooms = JSON.parse(root.dataset.rooms ?? "{}") as Record<string, Room>;
  const current = Number(root.dataset.census);
  const list = root.querySelector<HTMLElement>("[data-watched-list]")!;
  const empty = root.querySelector<HTMLElement>("[data-watched-empty]")!;
  const count = root.querySelector<HTMLElement>("[data-watched-count]");
  const status = root.querySelector<HTMLElement>("[data-watched-status]");
  const heading = root.querySelector<HTMLElement>("#list-title");
  // what changed is worked out once, against the visits before this one; the list then keeps it
  const lines = new Map<string, string[]>();
  for (const slug of watched()) {
    if (Object.hasOwn(rooms, slug)) lines.set(slug, sinceVisit(rooms[slug].h, lastSeen(slug), current));
  }

  const render = (focusAt?: number) => {
    const slugs = watched().filter((s) => lines.has(s));
    list.replaceChildren();
    for (const slug of slugs) {
      const room = rooms[slug];
      const li = el("li", "flex items-start gap-3 border-t border-border px-4 py-3 first:border-t-0");
      const unwatch = el("button", "grid size-11 shrink-0 cursor-pointer place-items-center rounded-md text-repetitive hover:bg-surface-raised");
      unwatch.type = "button";
      unwatch.setAttribute("aria-label", `Stop watching ${slug}`);
      const star = document.querySelector<HTMLTemplateElement>("template[data-star-icon]");
      if (star) unwatch.append(star.content.cloneNode(true));
      unwatch.addEventListener("click", () => {
        const at = slugs.indexOf(slug);
        if (toggle(slug)) return;
        render(at);
        if (status) status.textContent = `Stopped watching ${slug}.`;
      });
      const body = el("div", "grid min-w-0 flex-1 gap-1");
      const line = el("div", "flex flex-wrap items-center gap-x-3 gap-y-1");
      const link = el("a", "font-mono text-link", slug);
      link.setAttribute("href", `/rooms/${slug}/`);
      line.append(link);
      if (room.p) line.append(el("span", `text-sm font-semibold ${COLOR[room.p]}`, PATTERN[room.p].short));
      body.append(line);
      if (room.s !== null) body.append(el("p", "text-sm text-warning", `Not in the latest census. Figures from census #${room.s}.`));
      for (const text of lines.get(slug) ?? []) body.append(el("p", "text-sm text-text-muted", text));
      li.append(unwatch, body, el("span", "shrink-0 font-mono tabular-nums", room.r === null ? "–" : `${rate(room.r)}/h`));
      list.append(li);
    }
    empty.hidden = slugs.length > 0;
    list.hidden = slugs.length === 0;
    if (count) count.textContent = slugs.length === 1 ? "1 room" : `${slugs.length} rooms`;
    if (focusAt !== undefined) {
      // keep the keyboard in the list: the next room's button, else the previous one, else the heading
      const buttons = list.querySelectorAll<HTMLButtonElement>("button");
      (buttons[Math.min(focusAt, buttons.length - 1)] ?? heading)?.focus();
    }
    return slugs;
  };

  const shown = render();
  if (Number.isInteger(current)) for (const slug of shown) markSeen(slug, current);
  root.hidden = false;
  document.querySelector("[data-watched-noscript]")?.remove();
}
