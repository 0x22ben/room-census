"""Room pages: one static page and one data file per room, built from the whole archive."""
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import durable
import room_census as rc
import room_pages as rp
from tests.test_outputs import DID

REPO = Path(__file__).resolve().parent.parent
BASE = "https://0x22ben.github.io/room-census"


def room(name, cls="varied", interval=None, per_hour=50.0, **extra):
    entry = {"room": name, "class": cls, "per_hour": per_hour, "unique_tpl": 0.9, "eff_senders": 12.0,
             "top_share": 0.1, "repeat_share": 0.3}
    if interval is not None:
        entry["rate_interval"] = interval
    entry.update(extra)
    return entry


def census(n, rooms, failures=(), nonce=True):
    rec = {"schema": rc.SCHEMA, "census": n, "at_utc": f"2026-09-{10 + n:02d}T10:00:00+00:00",
           "rooms": rooms, "failures": list(failures)}
    rec["snapshot"] = rc.snapshot_path(rec)
    rec["sha256"] = hashlib.sha256(rc.snapshot_bytes(rec)).hexdigest()
    if nonce:
        rec["signed_in"] = {"room": rc.ROOM, "nonce": str(1790000000000 + n)}
    return rec


def site():
    tmp = Path(tempfile.mkdtemp())
    shutil.copy(REPO / "index.html", tmp / "index.html")
    return tmp


class History(unittest.TestCase):
    def test_every_room_of_the_archive_gets_a_document(self):
        docs = rp.build([census(1, [room("old-room"), room("dev")]), census(2, [room("dev", interval=40.0)])])
        self.assertEqual(sorted(docs), ["dev", "old-room"])
        self.assertEqual([p["status"] for p in docs["old-room"]["history"]], ["measured", "absent"])
        self.assertEqual((docs["old-room"]["first_census"], docs["old-room"]["last_census"]), (1, 1))

    def test_missing_censuses_stay_gaps_never_zeros(self):
        docs = rp.build([census(1, [room("dev", interval=5.0)]), census(2, [room("lobby")]),
                         census(3, [room("dev", interval=7.0)], failures=[{"room": "lobby", "reason": "timeout"}])])
        gap = docs["dev"]["history"][1]
        self.assertEqual(gap["status"], "absent")
        self.assertEqual({k: gap[k] for k in rp.METRICS}, dict.fromkeys(rp.METRICS))
        self.assertIsNone(gap["class"])
        self.assertEqual(docs["lobby"]["history"][2]["status"], "failed")
        self.assertEqual(docs["dev"]["censuses_measured"], 2)
        self.assertIn('"rate_interval": null', json.dumps(gap))
        page = rp.render_room_page(docs["dev"], BASE)
        row = re.search(r'<tr class="gap"><th scope="row">#2</th>(.*?)</tr>', page).group(1)
        self.assertNotIn(">0<", row)
        self.assertIn("Not measured", row)

    def test_interval_rate_and_window_estimate_never_mix(self):
        docs = rp.build([census(1, [room("dev", per_hour=49.0)]), census(2, [room("dev", interval=12.0, per_hour=900.0)])])
        first, second = docs["dev"]["history"]
        self.assertEqual((first["rate_interval"], first["window_estimate"]), (None, 49.0))
        self.assertEqual((second["rate_interval"], second["window_estimate"]), (12.0, 900.0))
        self.assertIsNone(first["traffic_share"])                   # no interval: no share, no rank
        page = rp.render_room_page(rp.build([census(1, [room("dev", per_hour=49.0)])])["dev"], BASE)
        kpi = re.search(r"<dt>Msgs/h between censuses</dt><dd>(.*?)</dd>(.*?)</div>", page)
        self.assertEqual(kpi.group(1), "–")                          # the estimate never fills the interval slot
        self.assertIn("window estimate", kpi.group(2))
        self.assertIn('<span aria-hidden="true">~</span>', kpi.group(2))
        self.assertIn("<td>~49</td>", page)

    def test_share_and_rank_use_the_headline_denominator(self):
        rooms = [room("alpha", "mixed", interval=100.0), room("beta", "repetitive", interval=300.0),
                 room("Not A Slug", "varied", interval=100.0),       # unpublishable name, still network traffic
                 room("calm", "quiet", interval=0.0), room("fresh", "varied")]
        doc = rp.build([census(1, rooms)])
        pick = lambda r: {k: doc[r]["last_measured"][k] for k in ("traffic_share", "traffic_rank", "ranked_rooms")}
        self.assertEqual(pick("beta"), {"traffic_share": 0.6, "traffic_rank": 1, "ranked_rooms": 3})
        self.assertEqual(pick("alpha"), {"traffic_share": 0.2, "traffic_rank": 2, "ranked_rooms": 3})
        self.assertEqual(pick("calm"), {"traffic_share": None, "traffic_rank": None, "ranked_rooms": None})
        self.assertEqual(pick("fresh"), {"traffic_share": None, "traffic_rank": None, "ranked_rooms": None})
        self.assertEqual(doc["calm"]["last_measured"]["rate_interval"], 0.0)   # a real measured zero stays a zero
        summary = rc.summarize(rooms)
        self.assertAlmostEqual(summary["repetitive_share"], doc["beta"]["last_measured"]["traffic_share"])
        self.assertNotIn("Not A Slug", doc)

    def test_ties_share_a_rank(self):
        doc = rp.build([census(1, [room("a", interval=10.0), room("b", interval=10.0), room("c", interval=5.0)])])
        self.assertEqual([doc[r]["last_measured"]["traffic_rank"] for r in "abc"], [1, 1, 3])

    def test_early_history_until_six_measured_censuses(self):
        records = [census(n, [room("dev", interval=float(n))]) for n in range(1, 7)]
        self.assertTrue(rp.build(records[:5])["dev"]["early_history"])
        self.assertFalse(rp.build(records)["dev"]["early_history"])
        self.assertIn("Early history", rp.render_room_page(rp.build(records[:5])["dev"], BASE))
        self.assertNotIn("Early history", rp.render_room_page(rp.build(records)["dev"], BASE))

    def test_latest_is_the_last_census_that_measured_the_room(self):
        doc = rp.build([census(1, [room("dev", "mixed")]), census(2, [room("dev", "varied")]), census(3, [room("x")])])["dev"]
        self.assertEqual((doc["last_census"], doc["last_class"], doc["censuses_total"]), (2, "varied", 3))

    def test_classes_are_normalised_and_unknown_ones_dropped(self):
        doc = rp.build([census(1, [room("a", "diverse"), room("b", "<b>bot</b>")])])
        self.assertEqual((doc["a"]["last_class"], doc["b"]["last_class"]), ("varied", None))

    def test_only_finite_numbers_are_published(self):
        doc = rp.build([census(1, [room("a", interval=True, per_hour="12", unique_tpl=float("nan"),
                                        eff_senders=float("inf"), top_share=None)])])["a"]["last_measured"]
        self.assertEqual({k: doc[k] for k in ("rate_interval", "window_estimate", "unique_tpl", "eff_senders", "top_share")},
                         dict.fromkeys(("rate_interval", "window_estimate", "unique_tpl", "eff_senders", "top_share")))


class Stale(unittest.TestCase):
    """A room missing from the latest census shows its last known figures as such, never as current."""

    def doc(self, latest):
        return rp.build([census(1, [room("dev", "mixed")]), census(2, [room("dev", "varied", interval=8.0)]), latest])["dev"]

    def test_absent_from_the_latest_census(self):
        doc = self.doc(census(3, [room("other")]))
        self.assertEqual((doc["current"], doc["latest_census_status"], doc["last_census"], doc["censuses_total"]),
                         (False, "absent", 2, 3))
        self.assertEqual((doc["last_class"], doc["last_measured"]["census"]), ("varied", 2))
        page = rp.render_room_page(doc, BASE)
        for needle in ('<span class="stale">Last measured census #2</span>', '<span class="stale">Not measured in census #3</span>',
                       '<span class="k">Last class</span> Varied',
                       'aria-label="Last measured values, census #2. Not measured in census #3, the latest census"'):
            with self.subTest(needle=needle):
                self.assertIn(needle, page)
        self.assertNotIn("Not read", page.split("<h2")[0])

    def test_not_read_in_the_latest_census(self):
        doc = self.doc(census(3, [room("other")], failures=[{"room": "dev", "source": "listed", "reason": "timeout"}]))
        self.assertEqual((doc["current"], doc["latest_census_status"]), (False, "failed"))
        page = rp.render_room_page(doc, BASE)
        for needle in ('<span class="stale">Last measured census #2</span>', '<span class="stale">Not read in census #3</span>',
                       '<span class="k">Last class</span> Varied',
                       'aria-label="Last measured values, census #2. Not read in census #3, the latest census"'):
            with self.subTest(needle=needle):
                self.assertIn(needle, page)
        self.assertNotIn("Not measured in census", page)

    def test_a_room_measured_by_the_latest_census_is_current(self):
        doc = self.doc(census(3, [room("dev", "repetitive", interval=9.0)]))
        self.assertEqual((doc["current"], doc["latest_census_status"], doc["last_class"]), (True, "measured", "repetitive"))
        page = rp.render_room_page(doc, BASE)
        self.assertIn('aria-label="Values of census #3, the latest census"', page)
        for absent in ("Last measured census", "Last class", 'class="stale"'):
            self.assertNotIn(absent, page)

    def test_the_index_speaks_of_last_class(self):
        root = site()
        self.addCleanup(shutil.rmtree, root, True)
        rp.write_all([census(1, [room("dev"), room("gone")]), census(2, [room("dev")])], root, BASE, durable.atomic_write)
        listing = (root / "rooms" / "index.html").read_text(encoding="utf-8")
        self.assertIn('<th scope="col">Last class</th>', listing)
        self.assertNotIn('<th scope="col">Class</th>', listing)
        index = {r["room"]: r for r in json.loads((root / "data" / "rooms" / "index.json").read_text(encoding="utf-8"))["rooms"]}
        self.assertEqual((index["gone"]["last_class"], index["gone"]["last_census"], index["gone"]["current"]), ("varied", 1, False))
        self.assertTrue(index["dev"]["current"])
        self.assertNotIn("class", index["dev"])


class Names(unittest.TestCase):
    BAD = ["../evil", "a/b", "a\\b", "UPPER", "", "x" * 49, "-lead", "_lead", "con", "lpt1", "<script>", "a b",
           "caf\u00e9", "a.b", "a:b", 12, None]            # a non-ASCII name, written as an escape

    def test_invalid_names_never_become_pages(self):
        self.assertEqual(rp.build([census(1, [room(n) for n in self.BAD] + [room("ok-room_1")])]).keys(), {"ok-room_1"})
        for name in self.BAD:
            with self.subTest(name=name):
                self.assertFalse(rp.valid_slug(name))
        self.assertTrue(rp.valid_slug("a" * 48))

    def test_render_refuses_an_invalid_name_even_if_one_slipped_through(self):
        doc = rp.build([census(1, [room("dev")])])["dev"]
        with self.assertRaises(ValueError):
            rp.render_room_page({**doc, "room": "<img src=x>"}, BASE)

    def test_paths_cannot_leave_the_site(self):
        root = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, root, True)
        with self.assertRaises(ValueError):
            rp.inside(root, "rooms", "..", "..", "escape")
        self.assertEqual(rp.inside(root, "rooms", "dev", "index.html"), root / "rooms" / "dev" / "index.html")

    def test_archive_values_reaching_the_page_are_checked_or_escaped(self):
        rec = census(1, [room("dev")])
        rec.update(snapshot="javascript:alert(1)", sha256='"><img src=x>', at_utc='2026-09-11T10:00:00+00:00<script>',
                   signed_in={"nonce": "1<script>"}, provenance={"manifest_sha256": "../../x"})
        doc = rp.build([rec])["dev"]
        page = rp.render_room_page(doc, BASE)
        latest = doc["last_measured"]
        self.assertEqual((latest["snapshot"], latest["sha256"], latest["signed_nonce"], latest["manifest_sha256"]),
                         (None, None, None, None))
        self.assertEqual(page.count("<script"), 1)                  # only the shared room.js
        self.assertNotIn("javascript:", page)
        self.assertNotIn("<img", page)


class Escaping(unittest.TestCase):
    def test_every_rendered_value_goes_through_the_escaper(self):
        self.assertEqual(rp.e("<a href=\"x\">&'"), "&lt;a href=&quot;x&quot;&gt;&amp;&#x27;")
        doc = rp.build([census(1, [room("dev")])])["dev"]
        page = rp.render_room_page({**doc, "technocore": 'https://t/"><script>alert(1)</script>'}, BASE)
        self.assertIn("&quot;&gt;&lt;script&gt;", page)
        self.assertEqual(page.count("<script"), 1)


class Files(unittest.TestCase):
    def setUp(self):
        self.root = site()
        self.addCleanup(shutil.rmtree, self.root, True)

    def write(self, records):
        return rp.write_all(records, self.root, BASE, durable.atomic_write)

    def test_pages_data_and_index_are_generated(self):
        docs = self.write([census(1, [room("dev"), room("lobby", "repetitive")]), census(2, [room("dev", interval=3.0)])])
        for slug in docs:
            page = (self.root / "rooms" / slug / "index.html").read_text(encoding="utf-8")
            data = json.loads((self.root / "data" / "rooms" / f"{slug}.json").read_text(encoding="utf-8"))
            self.assertEqual((data["schema"], data["room"]), (rp.SCHEMA, slug))
            self.assertIn(f'data-room="{slug}"', page)
            self.assertIn('href="../../assets/room.css"', page)
            self.assertIn('src="../../assets/room.js"', page)
        index = json.loads((self.root / "data" / "rooms" / "index.json").read_text(encoding="utf-8"))
        self.assertEqual([r["room"] for r in index["rooms"]], ["dev", "lobby"])
        listing = (self.root / "rooms" / "index.html").read_text(encoding="utf-8")
        self.assertIn('href="dev/"', listing)
        self.assertIn('href="lobby/"', listing)

    def test_the_page_carries_every_required_block(self):
        rec2 = census(2, [room("dev", interval=12.0)])
        self.write([census(1, [room("dev")]), rec2])
        page = (self.root / "rooms" / "dev" / "index.html").read_text(encoding="utf-8")
        for needle in ('class="room-name">dev<', 'class="badge varied"', ">Open in Technocore<",
                       'href="https://technocore.chat/r/dev"', "Msgs/h between censuses", "Network traffic share",
                       "Unique texts, masked", "Effective senders", "Traffic rank", 'id="tabs"', 'id="chart"',
                       "Class by census", "Chart data", "Census #1 to #2", "2 of 2 censuses measured",
                       f'href="../../{rec2["snapshot"]}"', rec2["sha256"], "nonce <code", "Proofs"):
            with self.subTest(needle=needle):
                self.assertIn(needle, page)

    def test_same_csp_as_the_dashboard_and_no_external_resource(self):
        self.write([census(1, [room("dev")])])
        csp = re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"',
                        (REPO / "index.html").read_text(encoding="utf-8")).group(1)
        for path in (self.root / "rooms" / "dev" / "index.html", self.root / "rooms" / "index.html"):
            page = path.read_text(encoding="utf-8")
            self.assertIn(f'content="{csp}"', page)
            self.assertEqual(re.findall(r'<(?:script|link rel="stylesheet")[^>]*(?:src|href)="(https?:)', page), [])
        for asset in ("room.css", "room.js"):
            self.assertNotIn("http", (REPO / "assets" / asset).read_text(encoding="utf-8").replace("http://www.w3.org/2000/svg", ""))

    def test_old_pages_are_never_deleted(self):
        ghost_page, ghost_data = self.root / "rooms" / "ghost" / "index.html", self.root / "data" / "rooms" / "ghost.json"
        ghost_page.parent.mkdir(parents=True)
        ghost_data.parent.mkdir(parents=True)
        ghost_page.write_text("kept", encoding="utf-8")
        ghost_data.write_text("{}", encoding="utf-8")
        self.write([census(1, [room("dev")])])
        self.assertEqual((ghost_page.read_text(encoding="utf-8"), ghost_data.read_text(encoding="utf-8")), ("kept", "{}"))

    def test_a_room_seen_only_long_ago_keeps_its_page(self):
        records = [census(1, [room("gone")])] + [census(n, [room("dev")]) for n in range(2, 8)]
        self.write(records)
        page = (self.root / "rooms" / "gone" / "index.html").read_text(encoding="utf-8")
        self.assertIn("1 of 7 censuses measured", page)
        self.assertEqual(page.count('<tr class="gap">'), 6)

    def test_census_data_rebuild_writes_the_room_pages(self):
        with mock.patch.object(rc, "SITE_DIR", self.root):
            rc.write_data_files([census(1, [room("dev")]), census(2, [room("dev", interval=4.0), room("new")])], DID)
        self.assertTrue((self.root / "rooms" / "new" / "index.html").exists())
        self.assertEqual(json.loads((self.root / "data" / "rooms" / "dev.json").read_text(encoding="utf-8"))["last_census"], 2)


class Privacy(unittest.TestCase):
    def test_no_did_no_sender_no_message_text_no_verdict(self):
        root = site()
        self.addCleanup(shutil.rmtree, root, True)
        rooms = [room("dev", requested_by=DID, twin="lobby", twin_share=0.7, reason="templated texts (35% unique)",
                      senders=41, signed=0.9, sample_text="hello this is a real message")]
        rec = census(1, rooms)
        rec["text"] = "Room Census #1 signed text"
        rp.write_all([rec], root, BASE, durable.atomic_write)
        allowed = {"census", "at_utc", "snapshot", "sha256", "signed_nonce", "manifest_sha256", "status", "class",
                   *rp.METRICS}
        doc = json.loads((root / "data" / "rooms" / "dev.json").read_text(encoding="utf-8"))
        for p in doc["history"] + [doc["last_measured"]]:
            self.assertLessEqual(set(p), allowed)
        texts = [p.read_text(encoding="utf-8") for p in root.rglob("*") if p.is_file() and p.suffix in (".json", ".html")
                 and "rooms" in p.parts]
        for forbidden in ("did:key", "requested_by", "twin", "lobby", "templated texts", "hello this is", "signed text",
                          "bot", "human", "malicious", "legit", "score"):
            for text in texts:
                with self.subTest(forbidden=forbidden):
                    self.assertNotIn(forbidden, text.lower() if forbidden.islower() else text)


class Dashboard(unittest.TestCase):
    """The dashboard opens a room's page only when the room index lists it, and never builds DOM from strings."""

    def test_scripts_never_inject_html(self):
        for name in ("app.js", "assets/room.js"):
            code = (REPO / name).read_text(encoding="utf-8")
            with self.subTest(script=name):
                self.assertIsNone(re.search(r"\.innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML|document\.write", code))

    def test_room_links_go_to_the_room_page_when_it_exists(self):
        code = (REPO / "app.js").read_text(encoding="utf-8")
        self.assertIn('getText("data/rooms/index.json")', code)
        self.assertEqual(code.count("pageOf(r.room) || technocore(r.room)"), 1)      # tracked table
        self.assertIn("href: page || technocore(r.room)", code)                         # rooms table (see test_dashboard)
        self.assertIn("href: page || `?room=", code)                                 # top insights
        self.assertIn('class: "room-link"', code)            # the room name stays a native link


ROOM_JS_HARNESS = r"""
const fs = require("fs"), vm = require("vm");
const doc = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
class El {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.textContent = ""; this.hidden = true; this.on = {}; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(...c) { this.children.push(...c); }
  replaceChildren(...c) { this.children = [...c]; }
  addEventListener(t, f) { this.on[t] = f; }
  querySelector() { return this.children.find(c => c.attrs["aria-checked"] === "true"); }
  focus() {}
  get clientWidth() { return 800; }
  getBoundingClientRect() { return { left: 0, width: 800 }; }
}
const all = (n, tag, out = []) => { for (const c of n.children) if (typeof c === "object") { if (c.tag === tag) out.push(c); all(c, tag, out); } return out; };
const els = { tabs: new El("div"), chart: new El("div"), readout: new El("p") };
let requested = null;
const ctx = {
  document: { body: { dataset: { room: doc.room } }, getElementById: id => els[id], createElement: t => new El(t), createElementNS: (_, t) => new El(t) },
  innerWidth: 1000, addEventListener() {}, setTimeout, clearTimeout,
  fetch: url => { requested = url; return Promise.resolve({ ok: true, json: () => Promise.resolve(doc) }); },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[2], "utf8"), ctx);
setTimeout(() => {
  const out = { requested, tabs: els.tabs.children.map(b => b.textContent), tabsHidden: els.tabs.hidden, metrics: [] };
  for (let i = 0; i < out.tabs.length; i++) {
    els.tabs.children[i].on.click();
    const svg = els.chart.children[0];
    svg.on.focus();
    const reads = [];
    for (let k = 0; k < doc.history.length; k++) { svg.on.keydown({ key: k ? "ArrowRight" : "Home", preventDefault() {} }); reads.push(els.readout.textContent); }
    out.metrics.push({ runs: all(svg, "polyline").map(p => p.attrs.points.split(" ").length),
                       dots: all(svg, "circle").length, label: svg.attrs["aria-label"], reads });
  }
  // a plain tap: pointerdown or click at a position selects the nearest census, without preventDefault
  els.tabs.children[0].on.click();
  const hit = els.chart.children[0].children.find(c => c.tag === "rect" && c.attrs.fill === "transparent");
  let prevented = false;
  const tap = (clientX, type) => {
    hit.on[type]({ clientX, clientY: 100, pointerType: "touch", preventDefault() { prevented = true; } });
    return els.readout.textContent;
  };
  out.touch = { handlers: Object.keys(hit.on).sort(), first: tap(48, "pointerdown"), last: tap(786, "pointerdown"),
                middle: tap(417, "click"), near: tap(640, "pointerdown"), prevented };
  console.log(JSON.stringify(out));
}, 50);
"""


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class Scripts(unittest.TestCase):
    """room.js and the dashboard link helper, run for real under node with a minimal DOM."""

    def run_room_js(self, doc):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        (tmp / "harness.js").write_text(ROOM_JS_HARNESS, encoding="utf-8")
        (tmp / "doc.json").write_text(json.dumps(doc), encoding="utf-8")
        out = subprocess.run(["node", str(tmp / "harness.js"), str(REPO / "assets" / "room.js"), str(tmp / "doc.json")],
                             capture_output=True, text=True, encoding="utf-8", timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout)

    def test_the_chart_draws_real_points_and_keeps_gaps(self):
        records = [census(1, [room("dev", per_hour=49.0)]), census(2, [room("dev", interval=5.0)]),
                   census(3, [room("dev", interval=7.0)]), census(4, [room("x")]), census(5, [room("dev", interval=9.0)])]
        out = self.run_room_js(rp.build(records)["dev"])
        self.assertEqual(out["requested"], "../../data/rooms/dev.json")
        self.assertEqual(out["tabs"], ["Traffic", "Unique texts", "Effective senders", "Top sender"])
        self.assertFalse(out["tabsHidden"])
        traffic, unique = out["metrics"][0], out["metrics"][1]
        # traffic: census 1 is only a window estimate (not drawn), census 4 is a gap: 2-point run + lone dot
        self.assertEqual((traffic["runs"], traffic["dots"]), ([2], 3))
        self.assertIn("3 of 5 censuses have a value", traffic["label"])
        self.assertIn("window estimates excluded", traffic["label"])
        self.assertEqual((unique["runs"], unique["dots"]), ([3], 4))
        self.assertEqual(traffic["reads"][0], "Census #1 · 11 Sep · no value")
        self.assertEqual(traffic["reads"][3], "Census #4 · 14 Sep · not measured")
        self.assertEqual(traffic["reads"][4], "Census #5 · 15 Sep · 9.0 msgs/h")

    def test_a_tap_selects_the_nearest_census_without_blocking_scroll(self):
        records = [census(1, [room("dev", per_hour=49.0)]), census(2, [room("dev", interval=5.0)]),
                   census(3, [room("dev", interval=7.0)]), census(4, [room("x")]), census(5, [room("dev", interval=9.0)])]
        touch = self.run_room_js(rp.build(records)["dev"])["touch"]
        self.assertEqual(touch["handlers"], ["click", "pointerdown", "pointermove"])
        dot = " · "
        self.assertEqual(touch["first"], f"Census #1{dot}11 Sep{dot}no value")
        self.assertEqual(touch["last"], f"Census #5{dot}15 Sep{dot}9.0 msgs/h")
        self.assertEqual(touch["middle"], f"Census #3{dot}13 Sep{dot}7.0 msgs/h")
        self.assertEqual(touch["near"], f"Census #4{dot}14 Sep{dot}not measured")   # 640 is closest to census 4
        self.assertFalse(touch["prevented"])                                        # vertical scrolling stays free
        css = (REPO / "assets" / "room.css").read_text(encoding="utf-8")
        self.assertRegex(css, r"\.chart svg \{[^}]*touch-action: pan-y;")

    def test_the_dashboard_links_a_room_to_its_page_only_when_it_exists(self):
        code = (REPO / "app.js").read_text(encoding="utf-8")
        helpers = re.findall(r"^const (?:SLUG|technocore|pageOf) = .*$", code, re.M)
        self.assertEqual(len(helpers), 3)
        script = "\n".join(["let DATA = { pages: new Set(['dev']) };", *helpers,
                            "console.log(JSON.stringify([pageOf('dev'), pageOf('lobby'), technocore('dev'), SLUG.test('../x')]));",
                            "DATA = null; console.log(JSON.stringify(pageOf('dev')));"])
        out = subprocess.run(["node", "-e", script], capture_output=True, text=True, encoding="utf-8", timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        first, second = out.stdout.splitlines()
        self.assertEqual(json.loads(first), ["rooms/dev/", None, "https://technocore.chat/r/dev", False])
        self.assertIsNone(json.loads(second))


if __name__ == "__main__":
    unittest.main()
