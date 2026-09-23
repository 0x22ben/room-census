// Room page: the Watch button and "Since your last visit". Both only use this browser's storage.
import { sinceVisit, type Point } from "../lib/changes";
import { isWatched, lastSeen, markSeen, toggle } from "../lib/watch-store";

const button = document.querySelector<HTMLButtonElement>("button[data-watch]");
if (button) {
  const slug = button.dataset.watch ?? "";
  // the label stays "Watch": the pressed state alone says whether the room is watched
  const note = document.querySelector<HTMLElement>("[data-watch-note]");
  const render = (on: boolean) => button.setAttribute("aria-pressed", String(on));
  render(isWatched(slug));
  button.addEventListener("click", () => {
    const wanted = button.getAttribute("aria-pressed") !== "true";
    const on = toggle(slug);
    render(on);
    if (note) note.textContent = on === wanted ? "" : "This browser does not allow saving, so the room cannot be watched here.";
  });
  button.hidden = false;
}

const visit = document.querySelector<HTMLElement>("[data-visit]");
if (visit) {
  const slug = visit.dataset.visit ?? "";
  const current = Number(visit.dataset.census);
  const history = JSON.parse(visit.dataset.history ?? "[]") as Point[];
  const list = visit.querySelector<HTMLElement>("[data-visit-lines]");
  if (list && Number.isInteger(current)) {
    for (const text of sinceVisit(history, lastSeen(slug), current)) {
      const li = document.createElement("li");
      li.textContent = text;
      list.append(li);
    }
    markSeen(slug, current);
    visit.hidden = false;
  }
}
