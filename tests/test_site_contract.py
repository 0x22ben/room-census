"""The public route and artifact contract holds for the legacy site, and catches each kind of regression."""
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from tests import site_contract as contract

REPO = Path(__file__).resolve().parent.parent
SITE = ("index.html", "app.js", "assets", "rooms", "data", "identity.json", "llms.txt")


class LegacySite(unittest.TestCase):
    def test_the_repository_site_meets_the_contract(self):
        self.assertEqual(contract.check(REPO, contract.LEGACY_BASE), [])

    def test_every_route_class_is_inventoried(self):
        routes = contract.routes(REPO)
        rooms = json.loads((REPO / "data/rooms/index.json").read_text(encoding="utf-8"))["rooms"]
        self.assertIn("/", routes)
        self.assertIn("/rooms/", routes)
        for entry in rooms:
            self.assertIn(f"/rooms/{entry['room']}/", routes)
            self.assertIn(f"/data/rooms/{entry['room']}.json", routes)
        for rel in contract.REQUIRED_FILES:
            self.assertIn("/" + rel, routes)
        self.assertTrue(any(r.startswith("/data/snapshots/") for r in routes))
        self.assertTrue(any(r.startswith("/data/manifests/") for r in routes))

    def test_links_resolve_at_a_domain_root(self):
        """The legacy pages link relatively, so the same files work at https://roomcensus.xyz/."""
        for route, _, page in contract.pages(REPO, ["lobby"]):
            for href in contract.parse(page).links + contract.parse(page).resources:
                with self.subTest(route=route, href=href):
                    self.assertFalse(href.startswith("/room-census"), "a link would only work under /room-census/")


class Regressions(unittest.TestCase):
    """Each mutation of a copy of the site must be reported."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)
        for name in SITE:
            src = REPO / name
            (shutil.copytree if src.is_dir() else shutil.copy)(src, self.root / name)
        self.assertEqual(contract.check(self.root, contract.LEGACY_BASE), [])

    def edit(self, rel, old, new):
        path = self.root / rel
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text)
        path.write_text(text.replace(old, new, 1), encoding="utf-8", newline="\n")

    def assertReported(self, needle):
        problems = contract.check(self.root, contract.LEGACY_BASE)
        self.assertTrue(any(needle in p for p in problems), problems)

    def test_missing_required_file(self):
        (self.root / "data" / "history.csv").unlink()
        self.assertReported("missing required file data/history.csv")

    def test_altered_latest_snapshot(self):
        snap = json.loads((self.root / "data/latest.json").read_text(encoding="utf-8"))["snapshot"]
        (self.root / snap).write_bytes((self.root / snap).read_bytes() + b" ")
        self.assertReported("latest snapshot hash differs")

    def test_manifest_not_named_after_its_hash(self):
        m = next((self.root / "data" / "manifests").glob("*.json"))
        m.write_bytes(m.read_bytes() + b"\n")
        self.assertReported("not named after its own SHA-256")

    def test_identity_and_latest_disagree(self):
        path = self.root / "identity.json"
        doc = json.loads(path.read_text(encoding="utf-8"))
        doc["provenance"] = None
        path.write_text(json.dumps(doc), encoding="utf-8")
        self.assertReported("different provenance")

    def test_missing_room_page(self):
        shutil.rmtree(self.root / "rooms" / "lobby")
        self.assertReported("room pages and index differ")

    def test_room_data_file_outside_the_index(self):
        shutil.copy(self.root / "data/rooms/lobby.json", self.root / "data/rooms/stray.json")
        self.assertReported("room data files and index differ")

    def test_unsafe_slug_in_the_index(self):
        self.edit("data/rooms/index.json", '"room": "lobby"', '"room": "../lobby"')
        self.assertReported("unsafe or missing room slug")

    def test_room_document_names_an_unknown_snapshot(self):
        path = self.root / "data/rooms/lobby.json"
        doc = json.loads(path.read_text(encoding="utf-8"))
        for where in (doc["last_measured"], doc["history"][0]):
            with self.subTest(where="last_measured" if where is doc["last_measured"] else "history"):
                saved = where["snapshot"]
                where["snapshot"] = "data/snapshots/2026-09-23T1300Z.json"
                path.write_text(json.dumps(doc), encoding="utf-8")
                self.assertReported("names a snapshot that does not resolve")
                where["snapshot"] = saved

    def test_wrong_canonical(self):
        self.edit("rooms/lobby/index.html", 'href="https://0x22ben.github.io/room-census/rooms/lobby/"',
                  'href="https://0x22ben.github.io/room-census/rooms/"')
        self.assertReported("/rooms/lobby/: canonical")

    def test_weakened_csp(self):
        self.edit("index.html", "script-src 'self';", "script-src 'self' 'unsafe-inline';")
        self.assertReported("/: missing or weakened Content-Security-Policy")

    def test_policy_opening_another_origin(self):
        for old, new in (("connect-src 'self'", "connect-src 'self' https://stats.example"),
                         ("style-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' https://fonts.example"),
                         ("img-src 'self' data:", "img-src *")):
            with self.subTest(change=new):
                self.edit("index.html", old, new)
                self.assertReported("/: missing or weakened Content-Security-Policy")
                self.edit("index.html", new, old)

    def test_preconnect_to_another_origin(self):
        self.edit("index.html", "</head>", '<link rel="preconnect" href="https://fonts.example"></head>')
        self.assertReported("/: external resource https://fonts.example")

    def test_executable_inline_script(self):
        self.edit("rooms/lobby/index.html", "</head>", "<script>alert(1)</script></head>")
        self.assertReported("/rooms/lobby/: 1 executable inline script")

    def test_external_script(self):
        self.edit("index.html", '<script src="app.js"', '<script src="https://cdn.example.com/app.js"')
        self.assertReported("/: external resource https://cdn.example.com/app.js")

    def test_missing_anchor_used_by_signed_messages(self):
        self.edit("index.html", 'id="method"', 'id="methodology"')
        self.assertReported("/: missing anchor #method")

    def test_broken_internal_link(self):
        self.edit("rooms/lobby/index.html", 'href="../../data/rooms/lobby.json"', 'href="../../data/rooms/lobby2.json"')
        self.assertReported("/rooms/lobby/: broken internal link ../../data/rooms/lobby2.json")

    def test_link_climbing_above_the_site(self):
        self.edit("rooms/lobby/index.html", 'href="../../rooms/"', 'href="../../../rooms/"')
        self.assertReported("/rooms/lobby/: broken internal link ../../../rooms/")


if __name__ == "__main__":
    unittest.main()
