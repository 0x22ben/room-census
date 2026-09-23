"use strict";
// Room Census dashboard. Room names are untrusted: they only ever reach the DOM through textContent,
// setAttribute or encodeURIComponent, never through innerHTML.

const SVGNS = "http://www.w3.org/2000/svg";
const SERIES = ["--s1", "--s2", "--s3", "--s4", "--s5"];
const TABS = [["all", "All"], ["varied", "Varied"], ["mixed", "Mixed"], ["repetitive", "Repetitive"]];
const CRIT = {
  all: "Latest census, sorted by traffic.",
  varied: "≥80% unique · ≥20% regular · ≤30% top sender · ≥5 effective",
  mixed: "Between varied and repetitive thresholds.",
  repetitive: "<50% unique · or ≥80% top sender · or <5% regular",
};
const NUM = new Set(["census", "per_hour", "signed", "unique", "senders", "window", "span_h", "last_seq", "generation",
  "rate_interval", "unique_tpl", "repeat_share", "top_share", "eff_senders", "twin_share"]);
const $ = id => document.getElementById(id);
const state = { tab: "all", q: "", sort: "rate", dir: -1, showAll: false };
let DATA;

function h(tag, text, attrs) {
  const n = document.createElement(tag);
  if (text !== undefined && text !== null) n.textContent = text;
  for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
  return n;
}
function el(tag, attrs, text) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (text !== undefined) n.textContent = text;
  return n;
}
const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pct = x => (num(x) === null ? "–" : Math.round(x * 100) + "%");
const fmt = x => (num(x) === null ? "–" : x >= 1000 ? (x / 1000).toFixed(1) + "k" : x >= 10 ? String(Math.round(x)) : x.toFixed(1));
const when = s => new Date(s).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
const rateOf = r => num(r.rate_interval) ?? num(r.per_hour);
const classLabel = c => ({ varied: "Varied", diverse: "Varied", mixed: "Mixed", repetitive: "Repetitive", quiet: "Quiet" }[c] || "Unclassified");
const classVar = c => `var(--${c === "diverse" ? "varied" : ["varied", "mixed", "repetitive", "quiet"].includes(c) ? c : "quiet"})`;
const didShort = d => (typeof d === "string" && d.length > 12 ? "…" + d.slice(-8) : "");
const SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const technocore = room => "https://technocore.chat/r/" + encodeURIComponent(room);
// Room Census page of a room, only when data/rooms/index.json lists it (no dead link before the first build)
const pageOf = room => (DATA && DATA.pages.has(room) ? "rooms/" + encodeURIComponent(room) + "/" : null);

// RFC 4180 parser: quoted fields, doubled quotes, commas and line breaks inside quotes
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.length === head.length).map(r => {
    const o = {};
    head.forEach((k, i) => { const x = r[i]; o[k] = x === "" ? null : NUM.has(k) ? (Number.isFinite(+x) ? +x : null) : x; });
    return o;
  }).filter(o => /^\d{4}-\d{2}-\d{2}T/.test(o.at_utc || "") && (o.kind === "active" || o.kind === "global"));
}
const getText = url => fetch(url, { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error(url + " " + r.status); return r.text(); });

function readURL() {
  const p = new URLSearchParams(location.search);
  const tab = p.get("tab"), q = p.get("room");
  if (TABS.some(t => t[0] === tab)) state.tab = tab;
  if (q && /^[a-z0-9_-]{1,48}$/.test(q)) { state.q = q; state.showAll = true; }
}
function writeURL() {
  const p = new URLSearchParams();
  if (state.tab !== "all") p.set("tab", state.tab);
  if (state.q) p.set("room", state.q);
  const s = p.toString();
  history.replaceState(null, "", location.pathname + (s ? "?" + s : "") + location.hash);
}

function openRoom(room) {
  state.tab = "all";
  state.q = room;
  state.showAll = true;
  $("q").value = room;
  render();
  $("rooms").scrollIntoView({ behavior: "smooth", block: "start" });
}

function deltaOf(r) {
  const p = DATA.prevMap.get(r.room);
  const a = p ? num(p.rate_interval) : null, b = num(r.rate_interval);
  return a && b ? b / a : null;
}
function deltaCell(k) {
  const td = h("td", null, { class: "hide-sm" });
  if (k === null) { td.textContent = "–"; return td; }
  if (k >= 1.4 || k <= 1 / 1.4) {
    td.append(h("span", k >= 1 ? "▲ " : "▼ ", { "aria-hidden": "true" }), "×" + k.toFixed(k >= 1 ? 1 : 2));
    td.append(h("span", k >= 1 ? " up" : " down", { class: "sr" }));
  } else td.textContent = "stable";
  return td;
}
// A click or tap anywhere on a room row opens its room page. Links and buttons keep their native
// behaviour, so the room link never navigates twice, and ending a text selection is not a click.
function rowTarget(ev) {
  if (!ev || ev.defaultPrevented || ev.button > 0) return null;
  const t = ev.target;
  if (!t || typeof t.closest !== "function" || t.closest("a, button, input, select, textarea, summary")) return null;
  const row = t.closest("tr.row.nav");
  const href = row ? row.getAttribute("data-href") : null;
  if (!href || !/^rooms\/[a-z0-9][a-z0-9_-]{0,47}\/$/.test(href)) return null;
  const selected = typeof getSelection === "function" ? String(getSelection() || "") : "";
  return selected ? null : href;
}
// decorative: the row's accessible target is the room link. Only a row that opens a room page shows
// the arrow; any other row keeps an empty cell so the columns stay aligned.
function arrowCell(navigates) {
  const td = h("td", null, { class: "go", "aria-hidden": "true" });
  if (!navigates) return td;
  const s = el("svg", { width: 14, height: 14, viewBox: "0 0 14 14", focusable: "false" });
  s.append(el("path", { d: "M3 7h8M8 4l3 3-3 3", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" }));
  td.append(s);
  return td;
}

function render() {
  const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.focus : null;
  const { rooms } = DATA;
  const count = key => (key === "all" ? rooms.length : rooms.filter(r => r.class === key).length);

  const tabs = $("tabs");
  tabs.replaceChildren();
  for (const [key, name] of TABS) {
    const on = state.tab === key;
    const b = h("button", name, { type: "button", role: "radio", "aria-checked": String(on), tabindex: on ? "0" : "-1", "data-focus": "tab:" + key });
    b.append(h("span", String(count(key)), { class: "n", "aria-hidden": "true" }));
    b.setAttribute("aria-label", `${name}, ${count(key)} rooms`);
    b.addEventListener("click", () => { state.tab = key; state.showAll = false; render(); });
    tabs.append(b);
  }
  tabs.onkeydown = ev => {
    const i = TABS.findIndex(t => t[0] === state.tab);
    const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: TABS.length - 1 }[ev.key];
    if (next === undefined) return;
    ev.preventDefault();
    state.tab = TABS[(next + TABS.length) % TABS.length][0];
    state.showAll = false;
    render();
    tabs.querySelector('[aria-checked="true"]').focus();
  };
  $("crit").textContent = CRIT[state.tab];

  const q = state.q.trim().toLowerCase();
  const list = rooms.filter(r => (state.tab === "all" || r.class === state.tab) && (!q || r.room.includes(q)));
  const key = { room: r => r.room, rate: r => rateOf(r) ?? -1, senders: r => num(r.eff_senders) ?? -1,
    unique: r => num(r.unique_tpl) ?? -1, delta: r => deltaOf(r) ?? -1 }[state.sort];
  list.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * state.dir; });

  const limited = !q && !state.showAll && list.length > 15;
  const visible = limited ? list.slice(0, 15) : list;
  const msg = limited ? (state.tab === "all" ? `Showing top 15 of ${list.length} rooms` : `Showing 15 of ${list.length} matching rooms`)
    : `${list.length} of ${rooms.length} rooms`;
  if ($("status").textContent !== msg) $("status").textContent = msg;
  const slot = $("reset-slot");
  slot.replaceChildren();
  if (limited) {
    const show = h("button", `Show all ${list.length} rooms`, { type: "button", class: "linkbtn", "data-focus": "toggle-limit" });
    show.addEventListener("click", () => { state.showAll = true; render(); });
    slot.append(show);
  } else if (state.showAll && !q && list.length > 15) {
    const less = h("button", "Show top 15", { type: "button", class: "linkbtn", "data-focus": "toggle-limit" });
    less.addEventListener("click", () => { state.showAll = false; render(); $("rooms").scrollIntoView({ block: "start" }); });
    slot.append(less);
  }
  if (state.q || state.tab !== "all") {
    const reset = h("button", "Reset filters", { type: "button", class: "linkbtn", "data-focus": "reset" });
    reset.addEventListener("click", () => { state.tab = "all"; state.q = ""; state.showAll = false; $("q").value = ""; render(); $("q").focus(); });
    slot.append(reset);
  }
  writeURL();

  const showDelta = rooms.some(r => deltaOf(r) !== null);
  const cols = [["room", "Room", ""], ["rate", "Msgs/h", ""], ...(showDelta ? [["delta", "Change", "hide-sm"]] : []),
    ["senders", "Effective senders", "hide-sm"], ["unique", "Unique texts", ""]];
  const t = $("table");
  t.replaceChildren();
  const thead = h("thead"), hr = h("tr");
  for (const [k, name, cls] of cols) {
    const th = h("th", null, Object.assign({ scope: "col" }, cls ? { class: cls } : {}));
    if (state.sort === k) th.setAttribute("aria-sort", state.dir > 0 ? "ascending" : "descending");
    const b = h("button", name, { type: "button", "data-focus": "sort:" + k });
    if (state.sort === k) b.append(h("span", state.dir > 0 ? "↑" : "↓", { class: "arrow", "aria-hidden": "true" }));
    b.addEventListener("click", () => {
      if (state.sort === k) state.dir *= -1; else { state.sort = k; state.dir = k === "room" ? 1 : -1; }
      render();
    });
    th.append(b); hr.append(th);
  }
  hr.append(h("th", null, { class: "go", "aria-hidden": "true" }));
  thead.append(hr); t.append(thead);

  const tb = h("tbody");
  if (!list.length) {
    const tr = h("tr"), td = h("td", null, { colspan: String(cols.length + 1) });
    td.append(h("p", q ? "No measured room matches this search." : "No room in this class in the latest census.", { class: "empty" }));
    tr.append(td); tb.append(tr);
  }
  for (const r of visible) {
    // the room name is the row's only keyboard target: a native link to the room page
    const page = pageOf(r.room);
    const tr = h("tr", null, page ? { class: "row nav", "data-href": page } : { class: "row" });
    const c0 = h("td");
    c0.append(h("a", r.room, { href: page || technocore(r.room), class: "room-link", "data-focus": "room:" + r.room }));
    const badge = h("span", classLabel(r.class), { class: "badge" });
    badge.style.setProperty("--c", classVar(r.class));
    c0.append(badge);
    const why = [r.reason, r.twin ? `shares ${pct(r.twin_share)} of senders with ${r.twin}` : null].filter(Boolean).join("; ");
    if (why) c0.append(h("span", why, { class: "why" }));
    tr.append(c0);

    const rate = h("td"), rv = rateOf(r);
    if (rv !== null && num(r.rate_interval) === null) {
      rate.append(h("span", "~", { class: "approx", "aria-hidden": "true" }), h("span", "approximately ", { class: "sr" }));
    }
    rate.append(fmt(rv)); tr.append(rate);
    if (showDelta) tr.append(deltaCell(deltaOf(r)));
    tr.append(h("td", num(r.eff_senders) === null ? "–" : String(Math.round(r.eff_senders)), { class: "hide-sm" }));
    const u = h("td"), m = h("span", null, { class: "meter" }), bar = h("i", null, { "aria-hidden": "true" }), fill = h("b");
    fill.style.width = Math.round((num(r.unique_tpl) || 0) * 100) + "%";
    fill.style.setProperty("--c", classVar(r.class));
    bar.append(fill); m.append(h("span", pct(r.unique_tpl)), bar); u.append(m); tr.append(u);
    tr.append(arrowCell(Boolean(page)));
    tb.append(tr);
  }
  t.append(tb);
  t.onclick = ev => {
    const href = rowTarget(ev);
    if (!href) return;
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey) window.open(href, "_blank", "noopener");
    else location.assign(href);
  };

  if (focusKey) {
    const target = document.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`);
    (target || $("q")).focus();
  }
}

function renderInsights() {
  const box = $("insights");
  box.replaceChildren();
  const measured = DATA.rooms.filter(r => rateOf(r) !== null);
  const pick = (rows, value) => rows.reduce((best, row) => !best || value(row) > value(best) ? row : best, null);
  const busiest = pick(measured, r => rateOf(r));
  const busiestVaried = pick(measured.filter(r => r.class === "varied"), r => rateOf(r));
  const broadest = pick(DATA.rooms.filter(r => num(r.eff_senders) !== null), r => r.eff_senders);
  const movers = measured.map(r => ({ room: r, delta: deltaOf(r) }))
    .filter(x => x.delta && x.delta > 0)
    .sort((a, b) => Math.abs(Math.log(b.delta)) - Math.abs(Math.log(a.delta)));
  const mover = movers[0] || null;
  const fallback = pick(DATA.rooms.filter(r => num(r.unique_tpl) !== null), r => r.unique_tpl);
  const cards = [
    busiest && ["Traffic leader", busiest, `${fmt(rateOf(busiest))} msgs/h between censuses`],
    busiestVaried && ["Busiest varied room", busiestVaried, `${fmt(rateOf(busiestVaried))} msgs/h, ${pct(busiestVaried.unique_tpl)} unique texts`],
    broadest && ["Broadest sender mix", broadest, `${Math.round(broadest.eff_senders)} effective senders, ${classLabel(broadest.class).toLowerCase()}`],
    mover ? ["Largest movement", mover.room, `${mover.delta >= 1 ? "Up" : "Down"} ×${mover.delta.toFixed(mover.delta >= 1 ? 1 : 2)} since the previous census`]
      : fallback && ["Most varied texts", fallback, `${pct(fallback.unique_tpl)} unique texts after masking`],
  ].filter(Boolean);
  for (const [label, room, note] of cards) {
    const page = pageOf(room.room);
    const a = h("a", null, { class: "insight", href: page || `?room=${encodeURIComponent(room.room)}#rooms`, "aria-label": `${label}: ${room.room}. ${note}` });
    a.append(h("span", label, { class: "insight-label" }), h("span", room.room, { class: "insight-value" }), h("span", note, { class: "insight-note" }));
    if (!page) a.addEventListener("click", ev => { ev.preventDefault(); openRoom(room.room); });
    box.append(a);
  }
}

function renderChanges(latest) {
  const c = latest && latest.changes;
  if (!c) return;
  const body = $("changes-body");
  const groups = [
    ["Changed class", (c.class_changes || []).map(x => `${x.room}: ${classLabel(x.from)} → ${classLabel(x.to)}`)],
    ["Rising (rate between censuses)", (c.rising || []).map(x => `${x.room}: ×${Number(x.ratio).toFixed(1)}`)],
    ["Falling", (c.falling || []).map(x => `${x.room}: ×${Number(x.ratio).toFixed(2)}`)],
    ["Went quiet", (c.went_quiet || []).map(x => String(x))],
  ].filter(g => g[1].length);
  if (!groups.length) return;
  $("changes-title").textContent = `What changed since census #${(latest.census || 2) - 1}`;
  for (const [title, items] of groups) {
    body.append(h("h3", title));
    const ul = h("ul");
    items.slice(0, 8).forEach(i => ul.append(h("li", i)));
    body.append(ul);
  }
  $("changes").hidden = false;
}

function trendChart() {
  const { censuses, index, rooms } = DATA;
  const box = $("trend");
  box.replaceChildren(); $("legend").replaceChildren();
  const top = rooms.filter(r => rateOf(r) !== null).sort((a, b) => rateOf(b) - rateOf(a)).slice(0, 5).map(r => r.room);
  const W = Math.max(300, box.clientWidth), H = W < 600 ? 220 : 260, L = 44, R = 12, T = 10, B = 26;
  const times = censuses.map(c => Date.parse(c)), t0 = times[0], t1 = times[times.length - 1];
  const series = top.map((room, i) => ({ room, color: `var(${SERIES[i]})`,
    pts: censuses.map((c, j) => { const r = index.get(c + "|" + room); return r && rateOf(r) !== null ? { j, v: rateOf(r) } : null; }).filter(Boolean) }));
  const vals = series.flatMap(s => s.pts.map(p => p.v)).filter(v => v > 0);
  const lo = 10 ** Math.floor(Math.log10(Math.min(...vals, 100))), hi = 10 ** Math.ceil(Math.log10(Math.max(...vals, 1000)));
  const x = j => L + (times[j] - t0) / (t1 - t0 || 1) * (W - L - R);
  const y = v => T + (H - T - B) * (1 - (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)));
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", tabindex: "0",
    "aria-label": "Messages per hour for the 5 busiest rooms at each census, log scale. The values are in the table below the chart." });
  for (let v = lo; v <= hi; v *= 10) {
    svg.append(el("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: v === lo ? "var(--axis)" : "var(--grid)" }));
    svg.append(el("text", { x: L - 8, y: y(v) + 4, "text-anchor": "end" }, fmt(v)));
  }
  const n = censuses.length, step = Math.max(1, Math.ceil(n / (W < 600 ? 3 : 6)));
  censuses.forEach((c, j) => {
    if (j % step === 0 || j === n - 1) svg.append(el("text", { x: x(j), y: H - 6, "text-anchor": j === 0 ? "start" : j === n - 1 ? "end" : "middle" },
      new Date(c).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })));
  });
  for (const s of series) {
    svg.append(el("polyline", { points: s.pts.map(p => `${x(p.j)},${y(p.v)}`).join(" "), fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    for (const p of s.pts) svg.append(el("circle", { cx: x(p.j), cy: y(p.v), r: 4, fill: s.color, stroke: "var(--surface)", "stroke-width": 2 }));
    const item = h("span", s.room); item.style.setProperty("--c", s.color); $("legend").append(item);
  }
  const cross = el("line", { y1: T, y2: H - B, stroke: "var(--axis)", visibility: "hidden" });
  const hit = el("rect", { x: 0, y: 0, width: W, height: H, fill: "transparent" });
  svg.append(cross, hit);
  const tip = $("tip"), card = $("trend-card");
  let cur = n - 1;
  const show = (j, cx, cy) => {
    cur = j;
    cross.setAttribute("x1", x(j)); cross.setAttribute("x2", x(j)); cross.setAttribute("visibility", "visible");
    tip.replaceChildren(h("b", when(censuses[j])));
    const spoken = [when(censuses[j])];
    for (const s of series) {
      const p = s.pts.find(q => q.j === j), line = h("div"), dot = h("span", "● ");
      dot.style.color = s.color;
      line.append(dot, document.createTextNode(`${s.room}: ${p ? fmt(p.v) + " msgs/h" : "–"}`));
      tip.append(line); spoken.push(`${s.room} ${p ? fmt(p.v) : "no data"}`);
    }
    $("trend-live").textContent = spoken.join(", ");
    const c = card.getBoundingClientRect(), sr = svg.getBoundingClientRect();
    tip.style.display = "block";
    const px = cx ?? sr.left + x(j) * sr.width / W, py = cy ?? sr.top + T + 20;
    tip.style.left = Math.min(Math.max(8, px - c.left + 12), c.width - tip.offsetWidth - 8) + "px";
    tip.style.top = (py - c.top + 12) + "px";
  };
  const hide = () => { tip.style.display = "none"; cross.setAttribute("visibility", "hidden"); };
  hit.addEventListener("pointermove", ev => {
    const r = svg.getBoundingClientRect(), lx = (ev.clientX - r.left) * W / r.width;
    let j = 0, best = Infinity;
    censuses.forEach((_, k) => { const d = Math.abs(x(k) - lx); if (d < best) { best = d; j = k; } });
    show(j, ev.clientX, ev.clientY);
  });
  hit.addEventListener("pointerleave", hide);
  svg.addEventListener("focus", () => show(cur));
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", ev => {
    if (ev.key === "ArrowLeft") { ev.preventDefault(); show(Math.max(0, cur - 1)); }
    else if (ev.key === "ArrowRight") { ev.preventDefault(); show(Math.min(n - 1, cur + 1)); }
    else if (ev.key === "Escape") hide();
  });
  box.append(svg);

  const tt = $("trend-table");
  tt.replaceChildren();
  const hr = h("tr");
  hr.append(h("th", "Census", { scope: "col" }));
  series.forEach(s => hr.append(h("th", s.room, { scope: "col" })));
  tt.append(hr);
  censuses.forEach((c, j) => {
    const tr = h("tr");
    tr.append(h("td", when(c)));
    series.forEach(s => { const p = s.pts.find(q => q.j === j); tr.append(h("td", p ? fmt(p.v) : "–")); });
    tt.append(tr);
  });
}

function wireCopy() {
  document.querySelectorAll("button.copy[data-copy]").forEach(b => {
    b.addEventListener("click", async () => {
      const src = $(b.dataset.copy);
      if (!src) return;
      try { await navigator.clipboard.writeText(src.textContent.trim()); b.textContent = "Copied"; }
      catch { b.textContent = "Select and copy"; }
      $("status").textContent = "Hash copied";
      setTimeout(() => { b.textContent = "Copy"; }, 2000);
    });
  });
}

Promise.all([
  getText("data/latest.json").then(JSON.parse),
  getText("data/history.csv").then(parseCSV).catch(() => []),
  getText("data/rooms/index.json").then(JSON.parse).catch(() => null),
]).then(([latest, rows, roomIndex]) => {
  const rooms = (Array.isArray(latest.rooms) ? latest.rooms : [])
    .filter(r => r && typeof r.room === "string" && /^[a-z0-9_-]{1,48}$/.test(r.room))
    .map(r => ({ ...r, class: r.class === "diverse" ? "varied" : r.class }));
  const active = rows.filter(r => r.kind === "active");
  const censuses = [...new Set(active.map(r => r.at_utc))].sort();
  const index = new Map(active.map(r => [r.at_utc + "|" + r.room, r]));
  const prevAt = censuses.length > 1 ? censuses[censuses.length - 2] : null;
  const prevMap = new Map(active.filter(r => r.at_utc === prevAt).map(r => [r.room, r]));
  const pages = new Set((roomIndex && Array.isArray(roomIndex.rooms) ? roomIndex.rooms : [])
    .map(x => x && x.room).filter(x => typeof x === "string" && SLUG.test(x)));
  DATA = { rooms, censuses, index, prevMap, pages };

  renderInsights();
  renderChanges(latest);
  readURL();
  $("q").value = state.q;
  let timer;
  $("q").addEventListener("input", ev => { clearTimeout(timer); timer = setTimeout(() => { state.q = ev.target.value; state.showAll = false; render(); }, 150); });
  render();
  wireCopy();

  const tracked = rooms.filter(r => r.requested_by);
  if (tracked.length) {
    $("tracked-card").hidden = false;
    const t = h("table"), hr = h("tr");
    ["Room", "Class", "Msgs/h", "Asked by"].forEach(x => hr.append(h("th", x, { scope: "col" })));
    t.append(hr);
    for (const r of tracked) {
      const tr = h("tr"), c = h("td");
      c.append(h("a", r.room, { href: pageOf(r.room) || technocore(r.room) }));
      tr.append(c, h("td", classLabel(r.class)), h("td", fmt(rateOf(r))), h("td", didShort(r.requested_by)));
      t.append(tr);
    }
    $("tracked").append(t);
  }

  const spanH = censuses.length ? (Date.parse(censuses[censuses.length - 1]) - Date.parse(censuses[0])) / 36e5 : 0;
  if (censuses.length >= 3 && spanH >= 24) {
    $("trend-card").hidden = false;
    trendChart();
    let lastW = innerWidth, t2;
    addEventListener("resize", () => { if (innerWidth === lastW) return; lastW = innerWidth; clearTimeout(t2); t2 = setTimeout(trendChart, 150); });
  }
}).catch(() => { $("status").textContent = "The data could not be loaded. Try data/latest.json directly."; });
