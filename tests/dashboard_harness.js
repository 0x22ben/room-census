"use strict";
// Runs the real app.js against a minimal DOM and scripted data files, then drives the room table like
// a user would and prints what happened as JSON. Used by tests/test_dashboard.py (needs node only).
//   node dashboard_harness.js <app.js> <data dir>
const fs = require("fs"), path = require("path"), vm = require("vm");
const [appPath, dataDir] = process.argv.slice(2);

// selectors used by app.js and this harness: tag, .class, [attr], [attr="value"], comma lists
function parseSel(sel) {
  const r = /^([a-z0-9]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(sel.trim());
  if (!r) throw new Error("unsupported selector: " + sel);
  const attrs = ((r[3] || "").match(/\[[^\]]+\]/g) || []).map(a => {
    const body = a.slice(1, -1), i = body.indexOf("=");
    return i < 0 ? [body, undefined] : [body.slice(0, i), body.slice(i + 1).replace(/^"|"$/g, "")];
  });
  return { tag: r[1] ? r[1].toLowerCase() : null, classes: (r[2] || "").split(".").filter(Boolean), attrs };
}

class El {
  constructor(tag) {
    this.tag = tag.toLowerCase(); this.attrs = {}; this.children = []; this.parent = null; this._text = "";
    this.listeners = {}; this.style = { setProperty() {} }; this.hidden = false; this.value = "";
  }
  get dataset() {
    const d = {};
    for (const k in this.attrs) if (k.startsWith("data-")) d[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = this.attrs[k];
    return d;
  }
  set textContent(t) { this.children = []; this._text = t == null ? "" : String(t); }
  get textContent() { return this._text + this.children.map(c => (typeof c === "string" ? c : c.textContent)).join(""); }
  get className() { return this.attrs.class || ""; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  append(...c) { for (const x of c) { if (x && typeof x === "object") x.parent = this; this.children.push(x); } }
  replaceChildren(...c) { this._text = ""; this.children = []; this.append(...c); }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  matches(sel) {
    return sel.split(",").some(s => {
      const m = parseSel(s), cls = this.className.split(/\s+/);
      return (!m.tag || m.tag === this.tag) && m.classes.every(c => cls.includes(c))
        && m.attrs.every(([k, v]) => k in this.attrs && (v === undefined || this.attrs[k] === v));
    });
  }
  closest(sel) { for (let n = this; n; n = n.parent) if (n.matches && n.matches(sel)) return n; return null; }
  descendants() {
    const out = [];
    const walk = n => { for (const c of n.children) if (c && typeof c === "object") { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.descendants().find(n => n.matches(sel)) || null; }
  querySelectorAll(sel) { return this.descendants().filter(n => n.matches(sel)); }
  focus() { doc.activeElement = this; }
  scrollIntoView() {}
  get clientWidth() { return 900; }
  get offsetWidth() { return 120; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 300 }; }
}

const IDS = ["tabs", "crit", "q", "status", "reset-slot", "table", "insights", "changes", "changes-title", "changes-body",
  "trend-card", "trend", "legend", "tip", "trend-live", "trend-table", "rooms", "tracked-card", "tracked"];
const body = new El("body"), ids = {};
for (const id of IDS) {
  const e = new El(id === "table" ? "table" : id === "q" ? "input" : "div");
  e.setAttribute("id", id);
  body.append(e);
  ids[id] = e;
}
const doc = {
  body, activeElement: body,
  getElementById: id => ids[id] || null,
  createElement: t => new El(t), createElementNS: (_, t) => new El(t),
  querySelector: s => body.querySelector(s), querySelectorAll: s => body.querySelectorAll(s),
};
const assigned = [], opened = [];
let selection = "";
const ctx = {
  document: doc,
  location: { search: "", pathname: "/", hash: "", assign: href => assigned.push(href) },
  history: { replaceState() {} },
  window: { open: (href, target, features) => opened.push([href, target, features]) },
  getSelection: () => selection,
  CSS: { escape: s => s },
  URLSearchParams, setTimeout, clearTimeout, console, innerWidth: 1200, addEventListener() {},
  fetch: url => {
    const file = path.join(dataDir, url.split("?")[0]);
    if (!fs.existsSync(file)) return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("") });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(fs.readFileSync(file, "utf8")) });
  },
};

// a click that bubbles from the target up to the table, like a real one
function fire(target, type, extra = {}) {
  let prevented = false;
  const ev = Object.assign({ type, target, button: 0, ctrlKey: false, metaKey: false, shiftKey: false }, extra, {
    get defaultPrevented() { return prevented; }, preventDefault() { prevented = true; } });
  for (let n = target; n; n = n.parent) {
    for (const f of n.listeners[type] || []) f(ev);
    if (typeof n["on" + type] === "function") n["on" + type](ev);
  }
  return ev;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

vm.createContext(ctx);
vm.runInContext(fs.readFileSync(appPath, "utf8"), ctx);

(async () => {
  await sleep(100);
  const rows = () => ids.table.querySelectorAll("tr.row");
  const names = () => rows().map(r => r.querySelector("a.room-link").textContent);
  const out = { initial: names(), status: ids.status.textContent };
  out.forbidden = {
    ariaExpandedOrControls: body.descendants().filter(n => "aria-expanded" in n.attrs || "aria-controls" in n.attrs).length,
    toggles: body.querySelectorAll("button.toggle").length,
    detailRows: body.querySelectorAll("tr.detail").length,
  };
  const r0 = rows()[0], link0 = r0.querySelector("a.room-link"), last = r0.children[r0.children.length - 1];
  out.row0 = { href: r0.getAttribute("data-href"), cls: r0.className, link: link0.getAttribute("href"),
    focusKey: link0.getAttribute("data-focus"), lastCell: last.className, lastHidden: last.getAttribute("aria-hidden"),
    headerCells: ids.table.querySelectorAll("th").length, cells: r0.children.length };
  out.keyboardTargets = [r0, ...r0.descendants()].filter(n => ["a", "button", "input"].includes(n.tag) || "tabindex" in n.attrs).length;

  fire(r0.children[1], "click"); out.cellClick = assigned.splice(0);
  fire(last, "click"); out.arrowClick = assigned.splice(0);
  fire(r0.querySelector("span.badge"), "click"); out.badgeClick = assigned.splice(0);
  const linkEv = fire(link0, "click"); out.linkClick = { assigned: assigned.splice(0), prevented: linkEv.defaultPrevented };
  fire(r0.children[1], "click", { ctrlKey: true }); out.ctrlClick = { assigned: assigned.splice(0), opened: opened.splice(0) };
  fire(r0.children[1], "click", { button: 1 }); out.middleClick = assigned.splice(0);
  selection = "lob"; fire(r0.children[1], "click"); out.selectingClick = assigned.splice(0); selection = "";
  // a tampered destination is never followed
  for (const bad of ["https://example.invalid/", "javascript:alert(1)", "rooms/../x/", "rooms/UPPER/"]) {
    r0.setAttribute("data-href", bad);
    fire(r0.children[1], "click");
  }
  out.tamperedClicks = { assigned: assigned.splice(0), opened: opened.splice(0) };

  const sortRoom = () => ids.table.querySelector('button[data-focus="sort:room"]');
  fire(sortRoom(), "click"); out.sortedAsc = names(); out.sortClickNavigated = assigned.splice(0);
  fire(sortRoom(), "click"); out.sortedDesc = names();
  fire(ids.table.querySelector('button[data-focus="sort:rate"]'), "click");

  fire(ids.tabs.querySelector('button[data-focus="tab:varied"]'), "click");
  out.variedBadges = rows().map(r => r.querySelector("span.badge").textContent);
  fire(ids.tabs.querySelector('button[data-focus="tab:all"]'), "click");

  out.limitedCount = rows().length;
  const more = ids["reset-slot"].querySelector('button[data-focus="toggle-limit"]');
  if (more) fire(more, "click");
  out.allCount = rows().length;
  const nopage = rows().find(r => !r.hasAttribute("data-href"));
  const arrowOf = r => { const go = r.children[r.children.length - 1];
    return { cell: go.className, hidden: go.getAttribute("aria-hidden"), svgs: go.querySelectorAll("svg").length }; };
  out.noPage = nopage && { cls: nopage.className, link: nopage.querySelector("a.room-link").getAttribute("href"),
    arrow: arrowOf(nopage), cells: nopage.children.length };
  out.navArrows = rows().filter(r => r.hasAttribute("data-href")).map(r => arrowOf(r).svgs);
  if (nopage) { fire(nopage.children[1], "click"); out.noPageClick = assigned.splice(0); }

  ids.q.value = "lob"; fire(ids.q, "input");
  await sleep(250);
  out.search = names();
  ids.q.value = ""; fire(ids.q, "input");
  await sleep(250);

  const link = rows()[2].querySelector("a.room-link");
  link.focus();
  fire(ids.tabs.querySelector('button[data-focus="tab:all"]'), "click");        // any re-render
  out.focusAfterRender = doc.activeElement.getAttribute ? doc.activeElement.getAttribute("data-focus") : null;
  out.focusedRoom = link.textContent;

  out.cards = ids.insights.querySelectorAll("a.insight").map(a => a.getAttribute("href"));
  console.log(JSON.stringify(out));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
