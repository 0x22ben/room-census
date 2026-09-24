// The room picker of the Write page and of the My DID first message: a search over the rooms this
// page carries, and one selected room. A room that is not in the list can never be picked, so a
// message never creates a room by writing to a name Technocore does not know yet.
import { searchRooms } from "../lib/rooms.mjs";

export type Room = { room: string; rate: number | null; senders: number | null; pattern: string | null };
const PATTERN: Record<string, string> = { varied: "Different", mixed: "Mixed", repetitive: "Repeated", quiet: "Low activity" };
const rate = (n: number | null) => (n === null ? "" : n >= 1000 ? `${(n / 1000).toFixed(1)}k/h` : `${Math.round(n)}/h`);

/**
 * Wires the search box, the list and the row template inside `root`. `onPick` is called with the
 * chosen room name. Returns the selection and a way to render or reset it.
 */
export function roomPicker(root: HTMLElement, rooms: Room[], onPick: (room: string) => void) {
  const search = root.querySelector<HTMLInputElement>("[data-room-search]")!;
  const list = root.querySelector<HTMLElement>("[data-room-list]")!;
  const empty = root.querySelector<HTMLElement>("[data-room-empty]");
  const template = document.querySelector<HTMLTemplateElement>("[data-room-template]")!;
  let selected = "";

  function render() {
    const found = searchRooms(rooms, search.value);
    list.replaceChildren();
    for (const r of found) {
      const li = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
      const button = li.querySelector<HTMLButtonElement>("[data-room]")!;
      const on = r.room === selected;
      button.dataset.room = r.room;
      button.setAttribute("aria-pressed", String(on));
      li.querySelector<HTMLElement>("[data-room-name]")!.textContent = r.room;
      li.querySelector<HTMLElement>("[data-room-meta]")!.textContent =
        [rate(r.rate), r.senders === null ? "" : `${Math.max(1, Math.round(r.senders))} senders`].filter(Boolean).join(" · ");
      li.querySelector<HTMLElement>("[data-room-pattern]")!.textContent = PATTERN[r.pattern ?? ""] ?? "";
      if (on) li.querySelector<HTMLElement>("[data-room-mark]")!.classList.add("bg-accent", "border-accent");
      button.addEventListener("click", () => {
        selected = r.room;
        render();
        onPick(r.room);
      });
      list.append(li);
    }
    if (empty) empty.hidden = found.length > 0;
  }

  search.addEventListener("input", render);
  render();

  return {
    get selected() { return selected; },
    // the search is filled in too, so the chosen room is always one of the rows on screen
    set(room: string) { selected = room; search.value = room; render(); },
    reset() { selected = ""; search.value = ""; render(); },
    render,
  };
}
