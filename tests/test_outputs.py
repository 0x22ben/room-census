"""Snapshots, published data files, page rendering, share card and the signed message."""
import csv
import hashlib
import json
import shutil
import struct
import tempfile
import unittest
from pathlib import Path

import census_render as cr
import room_census as rc

REPO = Path(__file__).resolve().parent.parent
DID = "did:key:z6Mkmpb5XhgweP9mfxnA3vpQRu2VcSsGyFC7AfE3ZEFqXxD1"


def record(n=1, at="2026-09-21T23:27:05.033899+00:00", interval=False, extra_room=None):
    rooms = [
        {"room": "dev", "class": "varied", "per_hour": 49.0, "unique_tpl": 0.83, "repeat_share": 0.22, "top_share": 0.1,
         "eff_senders": 150.0, "reason": "150 effective senders; 22% regular; varied texts", "last_seq": 10, "generation": 0},
        {"room": "lobby", "class": "repetitive", "per_hour": 41700.0, "unique_tpl": 0.35, "repeat_share": 0.0,
         "top_share": 0.01, "eff_senders": 180.0, "reason": "templated texts (35% unique); one-time senders only",
         "last_seq": 90000, "generation": 0},
        {"room": "calm", "class": "quiet", "reason": "only 3 recent messages", "last_seq": 3, "generation": 0},
    ]
    if extra_room:
        rooms.append(extra_room)
    if interval:
        rooms[0]["rate_interval"], rooms[1]["rate_interval"] = 50.0, 950.0
    rec = {"schema": rc.SCHEMA, "census": n, "at_utc": at, "prev_at_utc": None, "new_rooms_per_hour": 1091.3,
           "method": rc.METHOD, "rooms": rooms, "coverage": {"measured": 3, "failed": 0, "interval_hours": 10.0 if interval else None},
           "partial": False, "failures": []}
    rec["summary"] = rc.summarize(rooms)
    rec["snapshot"] = rc.snapshot_path(rec)
    rec["sha256"] = hashlib.sha256(rc.snapshot_bytes(rec)).hexdigest()
    rec["text"], rec["signed_in"] = "signed text", {"room": rc.ROOM, "nonce": "1"}
    return rec


class Snapshots(unittest.TestCase):
    def test_bytes_are_canonical_and_exclude_publication_fields(self):
        a = record()
        b = json.loads(json.dumps(a))
        b = dict(reversed(list(b.items())))                     # different key order, same content
        self.assertEqual(rc.snapshot_bytes(a), rc.snapshot_bytes(b))
        for field in (b'"text"', b'"signed_in"', b'"sha256"', b'"snapshot"'):
            self.assertNotIn(field, rc.snapshot_bytes(a))

    def test_any_change_changes_the_hash(self):
        a, b = record(), record()
        b["rooms"][0]["per_hour"] = 49.0001
        self.assertNotEqual(hashlib.sha256(rc.snapshot_bytes(a)).digest(), hashlib.sha256(rc.snapshot_bytes(b)).digest())

    def test_snapshot_path(self):
        self.assertEqual(rc.snapshot_path(record()), "data/snapshots/2026-09-21T2327Z.json")


class DataFiles(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        shutil.copy(REPO / "index.html", self.tmp / "index.html")
        orig = rc.SITE_DIR
        rc.SITE_DIR = self.tmp
        self.addCleanup(setattr, rc, "SITE_DIR", orig)

    def build(self, records):
        rc.write_data_files(records, DID)
        return json.loads((self.tmp / "data/latest.json").read_text(encoding="utf-8"))

    def test_signed_snapshots_are_written_byte_for_byte(self):
        old = record(1, extra_room={"room": "legacy", "class": "diverse", "per_hour": 5.0})   # pre-rename label
        new = record(2, at="2026-09-24T12:00:00+00:00", interval=True)
        self.build([old, new])
        for rec in (old, new):
            data = (self.tmp / rec["snapshot"]).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), rec["sha256"])
        self.assertIn(b'"diverse"', (self.tmp / old["snapshot"]).read_bytes())    # history is never rewritten

    def test_published_views_use_current_labels_and_rules(self):
        latest = self.build([record(1, extra_room={"room": "legacy", "class": "diverse", "per_hour": 5.0})])
        self.assertEqual({r["class"] for r in latest["rooms"]} & {"diverse"}, set())
        self.assertTrue(latest["summary"]["baseline"])
        self.assertIsNone(latest["summary"]["repetitive_share"])
        self.assertEqual(latest["untrusted"]["fields"], ["room", "twin"])

    def test_history_csv_is_parseable_and_numbered(self):
        self.build([record(1), record(2, at="2026-09-24T12:00:00+00:00", interval=True)])
        with (self.tmp / "data/history.csv").open(encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        self.assertEqual(list(rows[0].keys()), rc.CSV_FIELDS)
        self.assertEqual({r["census"] for r in rows}, {"1", "2"})
        self.assertEqual(sum(1 for r in rows if r["kind"] == "global"), 2)

    def test_page_blocks_are_filled_and_markers_kept(self):
        self.build([record(1)])
        page = (self.tmp / "index.html").read_text(encoding="utf-8")
        for name in ("head", "hero", "verify"):
            self.assertEqual(page.count(f"<!--census:{name}-->"), 1)
            self.assertEqual(page.count(f"<!--/census:{name}-->"), 1)
        self.assertIn("Baseline census", page)
        self.assertNotIn("agent traffic", page)
        self.build([record(1)])                                    # idempotent: same page twice
        self.assertEqual(page, (self.tmp / "index.html").read_text(encoding="utf-8"))

    def test_missing_marker_fails_loudly(self):
        (self.tmp / "index.html").write_text("<html>no markers</html>", encoding="utf-8")
        with self.assertRaises(ValueError):
            rc.write_data_files([record(1)], DID)


class Rendering(unittest.TestCase):
    def view(self, **kw):
        return rc.public_view(record(**kw), kw.get("n", 1), DID)

    def test_baseline_claims_rooms_not_traffic(self):
        k = cr.claims(self.view())
        self.assertIn("rooms", k["claim"])
        self.assertIn("Baseline", k["lede"])

    def test_interval_claims_traffic(self):
        v = self.view(n=2, interval=True, at="2026-09-24T12:00:00+00:00")
        k = cr.claims(v)
        self.assertEqual(k["big"], "95%")                          # 950 / (50 + 950)
        self.assertIn("traffic", k["claim"])

    def test_dashboard_hero_has_context_and_accessible_percentages(self):
        v = self.view(n=2, interval=True, at="2026-09-24T12:00:00+00:00")
        page = "<!--census:head--><!--/census:head--><!--census:hero--><!--/census:hero-->" \
               "<!--census:verify--><!--/census:verify--><!--census:provenance--><!--/census:provenance-->"
        out = cr.render_page(page, v, rc.DASHBOARD)
        self.assertIn('class="hero-top"', out)
        self.assertIn('class="signal-card"', out)
        self.assertIn("Traffic pattern, not intent or attribution", out)
        self.assertIn("Share of traffic: varied 5%, mixed 0%, repetitive 95%", out)
        self.assertNotIn("Share of traffic: varied 0.05", out)

    def test_values_are_html_escaped(self):
        v = self.view()
        v["date_long"] = '<script>alert(1)</script>'
        v["provenance"] = {"commit": '"><script>alert(2)</script>', "manifest": 'data/manifests/"><img src=x>.json',
                           "manifest_sha256": "0" * 64, "release": None, "repository": 'javascript:"<b>'}
        page = "<!--census:head--><!--/census:head--><!--census:hero--><!--/census:hero-->" \
               "<!--census:verify--><!--/census:verify--><!--census:provenance--><!--/census:provenance-->"
        out = cr.render_page(page, v, rc.DASHBOARD)
        self.assertNotIn("<script>alert", out)
        self.assertNotIn("<img src=x>", out)
        self.assertNotIn('"<b>', out)
        self.assertNotIn('href="javascript:', out)
        self.assertNotIn('href="data/manifests/&quot;', out)
        self.assertIn("&lt;script&gt;", out)

    def test_card_is_a_valid_1200x630_png(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "card.png"
            cr.write_card(p, self.view())
            data = p.read_bytes()
        self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(struct.unpack(">II", data[16:24]), (1200, 630))


class Message(unittest.TestCase):
    def test_signed_message_is_one_line_within_limits(self):
        rec = record(2, interval=True, at="2026-09-24T12:00:00+00:00")
        text = rc.build_message(rec, None, ["kibble for z6Mk..zz1"], 1, [])
        self.assertNotIn("\n", text)
        self.assertLess(len(text), 4096)
        self.assertIn(f"sha256:{rec['sha256']}", text)
        self.assertIn("95% of measured traffic", text)

    def test_baseline_message_has_no_traffic_share_and_marks_estimates(self):
        text = rc.build_message(record(1), None, [], 0, [])
        self.assertIn("baseline census", text)
        self.assertNotIn("% of measured traffic", text)
        self.assertIn("~", text)                                   # window rates are marked as estimates


if __name__ == "__main__":
    unittest.main()
