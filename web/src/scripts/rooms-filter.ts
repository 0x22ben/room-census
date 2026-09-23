// Filters the room table by class and by name. Progressive enhancement: without script the controls
// stay hidden and the full table is shown. Room names are only compared as text, never rendered.
const controls = document.querySelector<HTMLElement>("[data-room-filters]");
const rows = [...document.querySelectorAll<HTMLTableRowElement>("tr[data-room]")];

if (controls && rows.length > 0) {
  const buttons = [...controls.querySelectorAll<HTMLButtonElement>("button[data-filter]")];
  const search = controls.querySelector<HTMLInputElement>("input[type=search]");
  const status = document.querySelector<HTMLElement>("[data-room-count]");
  let cls = "all";

  const apply = () => {
    const q = (search?.value ?? "").trim().toLowerCase();
    let shown = 0;
    for (const row of rows) {
      const match = (cls === "all" || row.dataset.class === cls) && (!q || (row.dataset.room ?? "").includes(q));
      row.hidden = !match;
      if (match) shown += 1;
    }
    if (status) status.textContent = shown === rows.length ? `Showing all ${rows.length} rooms` : `Showing ${shown} of ${rows.length} rooms`;
  };

  for (const b of buttons) {
    b.addEventListener("click", () => {
      cls = b.dataset.filter ?? "all";
      for (const other of buttons) other.setAttribute("aria-pressed", String(other === b));
      apply();
    });
  }
  search?.addEventListener("input", apply);
  controls.hidden = false;
  apply();
}
