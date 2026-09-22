"use strict";
// Room Census room page: the chart. Everything else on the page is static HTML, so the page reads
// without this script. The room name is untrusted: it is checked against the slug pattern and only
// reaches the DOM through textContent and setAttribute, never innerHTML.

const SVGNS = "http://www.w3.org/2000/svg";
const SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rate = x => (x >= 1000 ? (x / 1000).toFixed(1) + "k" : x >= 10 ? String(Math.round(x)) : x.toFixed(1));
const pct = x => (x > 0 && x < 0.005 ? "<1%" : Math.round(x * 100) + "%");
// Only real measured points; a census without the value is a gap, never a zero.
const METRICS = [
  { key: "traffic", label: "Traffic", field: "rate_interval", unit: v => rate(v) + " msgs/h", share: false,
    name: "Messages per hour between censuses (window estimates excluded)" },
  { key: "unique", label: "Unique texts", field: "unique_tpl", unit: pct, share: true, name: "Unique texts after masking" },
  { key: "senders", label: "Effective senders", field: "eff_senders", unit: v => String(Math.round(v)), share: false,
    name: "Effective senders" },
  { key: "top", label: "Top sender", field: "top_share", unit: pct, share: true, name: "Share of the largest sender" },
];
const $ = id => document.getElementById(id);
const state = { metric: 0, cur: null };
let HISTORY = [];

function h(tag, text, attrs) {
  const n = document.createElement(tag);
  if (text !== undefined && text !== null) n.textContent = text;
  for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
  return n;
}
function s(tag, attrs, text) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (text !== undefined) n.textContent = text;
  return n;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// fixed format, independent of the browser locale: "24 Sep"
const day = at => { const m = /^\d{4}-(\d{2})-(\d{2})/.exec(at || ""); return m ? `${+m[2]} ${MONTHS[+m[1] - 1] || ""}` : ""; };
const status = p => (p.status === "absent" ? "not measured" : p.status === "failed" ? "not read" : null);

function nice(max) {
  if (!(max > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(max)), m = max / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}
// round steps: 1-2-5 scales split in 5 (or 4 for 2), shares in quarters
function ticks(top, share) {
  const k = share ? 4 : Math.round(top / 10 ** Math.floor(Math.log10(top))) === 2 ? 4 : 5;
  return Array.from({ length: k + 1 }, (_, i) => top * i / k);
}
const axis = (v, share) => (share ? Math.round(v * 100) + "%" : v >= 1000 ? +(v / 1000).toFixed(1) + "k" : String(+v.toFixed(1)));

function describe(i) {
  const m = METRICS[state.metric], p = HISTORY[i], v = num(p[m.field]);
  const gap = status(p);
  return `Census #${p.census} · ${day(p.at_utc)} · ` + (gap || (v === null ? "no value" : m.unit(v)));
}

function tabs() {
  const box = $("tabs");
  box.replaceChildren();
  METRICS.forEach((m, i) => {
    const on = i === state.metric;
    const b = h("button", m.label, { type: "button", role: "radio", "aria-checked": String(on), tabindex: on ? "0" : "-1" });
    b.addEventListener("click", () => { state.metric = i; draw(); tabs(); });
    box.append(b);
  });
  box.onkeydown = ev => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
    if (step === undefined) return;
    ev.preventDefault();
    state.metric = (state.metric + step + METRICS.length) % METRICS.length;
    draw(); tabs();
    box.querySelector('[aria-checked="true"]').focus();
  };
  box.hidden = false;
}

function draw() {
  const m = METRICS[state.metric], box = $("chart");
  const n = HISTORY.length, W = Math.max(300, box.clientWidth || 600), H = W < 600 ? 200 : 240;
  const L = 48, R = 14, T = 12, B = 28;
  const vals = HISTORY.map(p => num(p[m.field]));
  const real = vals.filter(v => v !== null);
  const top = m.share ? 1 : nice(Math.max(...real, 0));
  const x = i => (n === 1 ? (L + W - R) / 2 : L + i * (W - L - R) / (n - 1));
  const y = v => T + (H - T - B) * (1 - v / top);
  const latest = [...vals.keys()].reverse().find(i => vals[i] !== null);
  const summary = real.length
    ? `${m.name}: ${real.length} of ${n} censuses have a value, from ${m.unit(Math.min(...real))} to ${m.unit(Math.max(...real))}; ` +
      `latest ${m.unit(vals[latest])} at census #${HISTORY[latest].census}. Values are also in the table below.`
    : `${m.name}: no value yet. The table below lists every census.`;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", tabindex: "0", "aria-label": summary });
  for (const v of ticks(top, m.share)) {
    svg.append(s("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: v === 0 ? "var(--axis)" : "var(--grid)" }));
    svg.append(s("text", { x: L - 8, y: y(v) + 4, "text-anchor": "end" }, axis(v, m.share)));
  }
  const every = Math.max(1, Math.ceil(n / (W < 600 ? 4 : 10)));
  HISTORY.forEach((p, i) => {
    if (i % every === 0 || i === n - 1) svg.append(s("text", { x: x(i), y: H - 8, "text-anchor": "middle" }, "#" + p.census));
  });
  // straight segments between consecutive measured censuses only: a gap stays a gap
  let run = [];
  const flush = () => {
    if (run.length > 1) svg.append(s("polyline", { points: run.join(" "), fill: "none", stroke: "var(--line)", "stroke-width": 2, "stroke-linejoin": "round" }));
    run = [];
  };
  vals.forEach((v, i) => { if (v === null) flush(); else run.push(`${x(i)},${y(v)}`); });
  flush();
  vals.forEach((v, i) => {
    if (v !== null) svg.append(s("circle", { cx: x(i), cy: y(v), r: 4, fill: "var(--line)", stroke: "var(--surface)", "stroke-width": 2 }));
  });
  const cursor = s("line", { y1: T, y2: H - B, stroke: "var(--axis)", visibility: "hidden" });
  const hit = s("rect", { x: 0, y: 0, width: W, height: H, fill: "transparent" });
  svg.append(cursor, hit);
  const show = i => {
    state.cur = i;
    cursor.setAttribute("x1", x(i)); cursor.setAttribute("x2", x(i)); cursor.setAttribute("visibility", "visible");
    $("readout").textContent = describe(i);
  };
  const nearest = ev => {
    const r = svg.getBoundingClientRect(), lx = (ev.clientX - r.left) * W / r.width;
    let best = 0;
    HISTORY.forEach((_, i) => { if (Math.abs(x(i) - lx) < Math.abs(x(best) - lx)) best = i; });
    show(best);
  };
  // mouse hover, plus a plain tap or click on touch screens. No preventDefault: with
  // touch-action: pan-y on the chart, a vertical swipe still scrolls the page.
  hit.addEventListener("pointermove", nearest);
  hit.addEventListener("pointerdown", nearest);
  hit.addEventListener("click", nearest);
  svg.addEventListener("focus", () => show(state.cur ?? latest ?? n - 1));
  svg.addEventListener("keydown", ev => {
    const i = state.cur ?? n - 1;
    const next = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: n - 1 }[ev.key];
    if (next === undefined) return;
    ev.preventDefault();
    show(Math.min(n - 1, Math.max(0, next)));
  });
  box.replaceChildren(svg);
  $("readout").textContent = state.cur === null ? "" : describe(state.cur);
}

const room = document.body.dataset.room;
if (typeof room === "string" && SLUG.test(room)) {
  fetch("../../data/rooms/" + encodeURIComponent(room) + ".json", { cache: "no-cache" })
    .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then(doc => {
      if (!doc || doc.room !== room || !Array.isArray(doc.history) || !doc.history.length) throw new Error("unexpected data");
      HISTORY = doc.history.filter(p => p && Number.isInteger(p.census));
      tabs();
      draw();
      let width = innerWidth, t;
      addEventListener("resize", () => { if (innerWidth === width) return; width = innerWidth; clearTimeout(t); t = setTimeout(draw, 150); });
    })
    .catch(() => { $("readout").textContent = "Chart unavailable. The same values are in the table below."; });
}
