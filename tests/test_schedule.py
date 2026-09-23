"""Publication schedule: one daily wording, from one place, everywhere it is published; none of the
old twice-weekly wording left in the sources or in anything the census generates."""
import json
import os
import re
import shutil
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

import room_census as rc
from tests.test_outputs import DID, record

REPO = Path(__file__).resolve().parent.parent
OLD = {                                               # pattern -> an example it must catch
    r"monday\s+and\s+thursday": "Monday and Thursday, between 08:00 and 18:00 UTC",
    r"\bmon\s*\+\s*thu\b": "Mon + Thu &middot; 08:00-18:00 UTC",
    r"twice[-\s]weekly": "A twice-weekly, signed census",
    r"\bmon\s*,\s*thu\b": "schedule:mon,thu about:",
    r"schedule\s*,\s*thu": "schedule,thu",
    r"08:00\s*-\s*18:00\s*utc": "08:00-18:00 UTC",
    r"between\s+08:00\s+and\s+18:00": "random time between 08:00 and 18:00 UTC",
}
TEXT_SUFFIXES = {".py", ".js", ".html", ".txt", ".md", ".css", ".yml", ".json"}
# rebuilt from the archive by every census, never edited by hand: checked through the generator below
GENERATED_DIRS = {"data", "rooms"}
GENERATED_FILES = {"identity.json"}
SKIP_DIRS = {".git", "__pycache__", ".codex-test-tmp", ".claude"}


def old_wording(text):
    return [p for p in OLD if re.search(p, text, re.I)]


def source_files():
    for root, dirs, files in os.walk(REPO, onerror=lambda e: None):
        rel = Path(root).relative_to(REPO)
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not (rel == Path(".") and d in GENERATED_DIRS)]
        for name in files:
            path = Path(root) / name
            if path.suffix in TEXT_SUFFIXES and path.name != Path(__file__).name \
                    and not (rel == Path(".") and name in GENERATED_FILES):
                yield path


class OldWording(unittest.TestCase):
    def test_every_pattern_catches_its_example(self):
        for pattern, example in OLD.items():
            with self.subTest(pattern=pattern):
                self.assertRegex(example, re.compile(pattern, re.I))
        self.assertEqual(old_wording(rc.SCHEDULE_TEXT), [])

    def test_no_source_file_keeps_the_old_schedule(self):
        files = list(source_files())
        self.assertGreater(len(files), 20)
        for must in ("room_census.py", "census_render.py", "index.html", "llms.txt", "README.md", "app.js"):
            self.assertIn(must, {p.name for p in files})
        for path in files:
            with self.subTest(file=str(path.relative_to(REPO))):
                self.assertEqual(old_wording(path.read_text(encoding="utf-8", errors="replace")), [])


class GeneratedOutputs(unittest.TestCase):
    """What a census writes: latest.json, identity.json, the dashboard page, the room pages and the DID
    note, all with the same daily schedule."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        shutil.copy(REPO / "index.html", self.tmp / "index.html")
        p = mock.patch.object(rc, "SITE_DIR", self.tmp)
        p.start()
        self.addCleanup(p.stop)
        rc.write_data_files([record(1), record(2, at="2026-09-24T09:12:00+00:00", interval=True)], DID)
        self.latest = json.loads((self.tmp / "data" / "latest.json").read_text(encoding="utf-8"))
        self.identity = json.loads((self.tmp / "identity.json").read_text(encoding="utf-8"))

    def did_note(self):
        seen = []

        class Answer:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return b"ok"
        with mock.patch.object(rc.urllib.request, "urlopen", lambda req, timeout: seen.append(req.full_url) or Answer()), \
                mock.patch("builtins.print"):
            rc.refresh_did_note(DID)
        self.assertEqual(len(seen), 1)
        return urllib.parse.unquote(seen[0].rsplit("/set/", 1)[1])

    def test_the_schedule_is_daily_from_08_to_10_utc(self):
        self.assertEqual(rc.SCHEDULE_CRON, "0 8 * * *")
        self.assertEqual(rc.SCHEDULE_JITTER_HOURS, 2)
        self.assertEqual(rc.SCHEDULE_WINDOW_UTC, "08:00-10:00")
        self.assertEqual(rc.SCHEDULE_TEXT, "Daily, random start between 08:00 and 10:00 UTC")

    def test_identity_latest_and_did_note_share_one_source(self):
        self.assertEqual(self.latest["next"], rc.SCHEDULE_TEXT)
        self.assertEqual(self.identity["schedule"], rc.SCHEDULE_TEXT)
        self.assertEqual(self.latest["schedule"], rc.SCHEDULE)
        self.assertEqual(self.identity["schedule_detail"], rc.SCHEDULE)
        self.assertTrue(self.identity["about"].startswith("Daily signed census"))
        note = self.did_note()
        self.assertIn("schedule:daily ", note)
        self.assertIn(f"window:{rc.SCHEDULE_WINDOW_UTC}UTC ", note)
        self.assertIn("a daily signed census of public Technocore rooms", note)
        self.assertEqual(old_wording(note), [])

    def test_nothing_generated_keeps_the_old_schedule(self):
        generated = [p for p in self.tmp.rglob("*") if p.is_file() and p.suffix in (".json", ".html", ".csv")]
        self.assertGreater(len(generated), 5)
        for path in generated:
            with self.subTest(file=str(path.relative_to(self.tmp))):
                self.assertEqual(old_wording(path.read_text(encoding="utf-8")), [])
        page = (self.tmp / "index.html").read_text(encoding="utf-8")
        self.assertIn("A signed, daily census of public rooms.", page)


class Documentation(unittest.TestCase):
    def test_docs_and_page_state_the_same_schedule(self):
        readme = (REPO / "README.md").read_text(encoding="utf-8")
        llms = (REPO / "llms.txt").read_text(encoding="utf-8")
        page = (REPO / "index.html").read_text(encoding="utf-8")
        module = rc.__doc__
        for text, needles in (
            (readme, ["`0 8 * * *`", "--jitter 2", "random start between 08:00 and 10:00 UTC", "A daily, signed census"]),
            (llms, ["cron 0 8 * * * UTC", "jitter 2 hours", "random start between 08:00 and 10:00 UTC", "A daily, signed census"]),
            (page, ["<p>Daily &middot; random start 08:00-10:00 UTC", '"description":"A signed, daily census']),
            (module, ["0 8 * * *", "--jitter 2", "between 08:00 and 10:00 UTC"]),
        ):
            for needle in needles:
                with self.subTest(needle=needle):
                    self.assertIn(needle, text)


if __name__ == "__main__":
    unittest.main()
