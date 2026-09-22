"""Provenance: the deployment manifest, its strict validation, and the gate that stops a run before
anything is read, written or sent when the code does not match an approved commit."""
import ast
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import census_render as cr
import manifest
import room_census as rc
from tests.helpers import altered_records
from tests.test_outputs import DID, record

REPO = Path(__file__).resolve().parent.parent
COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"


def doc(commit=COMMIT, source=None):
    """A manifest of made-up files, so a test never depends on the real ones."""
    payload = source or {}
    return manifest.build(commit, reader=lambda name: payload.get(name, f"# {name}\n".encode()),
                          now=datetime(2026, 9, 22, 19, 0, tzinfo=timezone.utc))


def tree(base: Path, source: dict):
    for name in manifest.RUNTIME_FILES:
        (base / name).write_bytes(source.get(name, f"# {name}\n".encode()))


class CanonicalForm(unittest.TestCase):
    def test_serialisation_is_stable_and_compact(self):
        data = manifest.canonical_bytes(doc())
        self.assertNotIn(b" ", data)
        self.assertFalse(data.endswith(b"\n"))
        self.assertEqual(json.loads(data.decode()), doc())

    def test_digest_ignores_key_order(self):
        a = doc()
        b = json.loads(json.dumps(a))
        b["source"] = dict(reversed(list(b["source"].items())))
        b = dict(reversed(list(b.items())))
        self.assertEqual(manifest.digest(a), manifest.digest(b))
        self.assertEqual(manifest.canonical_bytes(a), manifest.canonical_bytes(b))

    def test_any_change_changes_the_digest(self):
        self.assertNotEqual(manifest.digest(doc()),
                            manifest.digest(doc(source={"durable.py": b"# durable.py \n"})))

    def test_published_name_is_the_digest_of_the_published_bytes(self):
        data = manifest.canonical_bytes(doc())
        sha = manifest.digest(doc())
        self.assertEqual(manifest.public_path(sha), f"data/manifests/{sha}.json")
        self.assertEqual(manifest.public_path(sha).split("/")[-1], f"{hashlib.sha256(data).hexdigest()}.json")

    def test_a_manifest_describes_every_runtime_file_once_in_order(self):
        names = [entry["path"] for entry in doc()["files"]]
        self.assertEqual(names, sorted(manifest.RUNTIME_FILES))
        self.assertEqual(doc()["source"], {"repository": manifest.REPOSITORY, "commit": COMMIT, "release": None})

    def test_build_refuses_a_commit_that_is_not_a_full_hash(self):
        for bad in ("", "HEAD", COMMIT[:39], COMMIT.upper(), 12345, COMMIT + "0"):
            with self.subTest(commit=bad), self.assertRaises(manifest.ManifestError):
                manifest.build(bad, reader=lambda name: b"")

    def test_round_trip_through_parse(self):
        self.assertEqual(manifest.parse(manifest.canonical_bytes(doc())), doc())


class Tampering(unittest.TestCase):
    """Every way a manifest can be wrong is a refusal, never a silent pass."""

    def altered(self, change):
        broken = json.loads(json.dumps(doc()))
        change(broken)
        return manifest.canonical_bytes(broken)

    def test_shapes_and_fields(self):
        entry = lambda d, **kw: d["files"][0].update(kw)
        cases = {
            "not json": b"{not json",
            "not utf-8": b'{"schema":"\xff"}',
            "not an object": b"[]",
            "empty": b"",
            "too large": manifest.canonical_bytes(doc()) + b" " * manifest.MAX_BYTES,
            "unknown schema": self.altered(lambda d: d.update(schema="room-census-manifest/9")),
            "missing files": self.altered(lambda d: d.pop("files")),
            "missing source": self.altered(lambda d: d.pop("source")),
            "extra top field": self.altered(lambda d: d.update(signature="trust me")),
            "source not an object": self.altered(lambda d: d.update(source="commit abc")),
            "short commit": self.altered(lambda d: d["source"].update(commit=COMMIT[:12])),
            "upper case commit": self.altered(lambda d: d["source"].update(commit=COMMIT.upper())),
            "commit not a string": self.altered(lambda d: d["source"].update(commit=None)),
            "missing commit": self.altered(lambda d: d["source"].pop("commit")),
            "other repository": self.altered(lambda d: d["source"].update(repository="https://example.invalid/x")),
            "empty release": self.altered(lambda d: d["source"].update(release="  ")),
            "extra source field": self.altered(lambda d: d["source"].update(branch="main")),
            "no time zone": self.altered(lambda d: d.update(generated_at_utc="2026-09-22T19:00:00")),
            "offset east of UTC": self.altered(lambda d: d.update(generated_at_utc="2026-09-22T21:00:00+02:00")),
            "offset west of UTC": self.altered(lambda d: d.update(generated_at_utc="2026-09-22T14:00:00-05:00")),
            "not a timestamp": self.altered(lambda d: d.update(generated_at_utc="yesterday")),
            "timestamp not a string": self.altered(lambda d: d.update(generated_at_utc=1790104879062)),
            "files empty": self.altered(lambda d: d.update(files=[])),
            "files not a list": self.altered(lambda d: d.update(files={"durable.py": "x" * 64})),
            "entry not an object": self.altered(lambda d: d["files"].__setitem__(0, "durable.py")),
            "entry missing sha256": self.altered(lambda d: d["files"][0].pop("sha256")),
            "entry extra field": self.altered(lambda d: entry(d, signed_by="someone")),
            "parent path": self.altered(lambda d: entry(d, path="../room_census.py")),
            "nested path": self.altered(lambda d: entry(d, path="tools/room_census.py")),
            "absolute path": self.altered(lambda d: entry(d, path="/etc/passwd")),
            "windows path": self.altered(lambda d: entry(d, path="c:\\code\\durable.py")),
            "not a python file": self.altered(lambda d: entry(d, path="census.jsonl")),
            "upper case path": self.altered(lambda d: entry(d, path="Durable.py")),
            "path not a string": self.altered(lambda d: entry(d, path=None)),
            "short sha256": self.altered(lambda d: entry(d, sha256="ab" * 31)),
            "upper case sha256": self.altered(lambda d: entry(d, sha256="A" * 64)),
            "bytes negative": self.altered(lambda d: entry(d, bytes=-1)),
            "bytes boolean": self.altered(lambda d: entry(d, bytes=True)),
            "bytes a string": self.altered(lambda d: entry(d, bytes="5033")),
            "duplicate entry": self.altered(lambda d: d["files"].insert(1, dict(d["files"][0]))),
            "unsorted entries": self.altered(lambda d: d["files"].reverse()),
            "incomplete list": self.altered(lambda d: d["files"].pop()),
            "unknown file": self.altered(lambda d: d["files"].append({"path": "extra.py", "sha256": "0" * 64, "bytes": 1})),
            "not canonical": json.dumps(doc(), indent=2).encode(),
            "keys in insertion order": json.dumps(doc(), sort_keys=False, separators=(",", ":")).encode(),
        }
        for name, data in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(manifest.ManifestError) as caught:
                    manifest.parse(data)
                self.assertTrue(str(caught.exception))

    def test_each_refusal_names_its_reason(self):
        entry = lambda **kw: self.altered(lambda d: d["files"][0].update(kw))
        cases = [
            (entry(path="../room_census.py"), "forbidden path"), (entry(path="/etc/passwd"), "forbidden path"),
            (entry(path="tools/durable.py"), "forbidden path"), (entry(path="c:\\x\\durable.py"), "forbidden path"),
            (self.altered(lambda d: d["files"].insert(1, dict(d["files"][0]))), "duplicate"),
            (self.altered(lambda d: d["files"].reverse()), "not sorted"),
            (self.altered(lambda d: d["files"].pop()), "does not cover"),
            (self.altered(lambda d: d["files"].append({"path": "zz.py", "sha256": "0" * 64, "bytes": 1})), "does not run"),
            (json.dumps(doc(), sort_keys=True, indent=1).encode(), "canonical"),
            (self.altered(lambda d: d.update(generated_at_utc="2026-09-22T21:00:00+02:00")), "not in UTC"),
        ]
        for data, reason in cases:
            with self.subTest(reason=reason, data=data[:60]):
                with self.assertRaises(manifest.ManifestError) as caught:
                    manifest.parse(data)
                self.assertIn(reason, str(caught.exception))

    def test_a_zero_offset_is_utc(self):
        for moment in ("2026-09-22T19:00:00Z", "2026-09-22T19:00:00+00:00", "2026-09-22T19:00:00.5-00:00"):
            with self.subTest(moment=moment):
                self.assertEqual(manifest.parse(self.altered(lambda d: d.update(generated_at_utc=moment)))
                                 ["generated_at_utc"], moment)

    def test_a_manifest_that_is_merely_pretty_printed_is_refused(self):
        good = doc()
        self.assertEqual(manifest.parse(manifest.canonical_bytes(good)), good)
        with self.assertRaises(manifest.ManifestError):
            manifest.parse(json.dumps(good, sort_keys=True, separators=(", ", ": ")).encode())

    def test_errors_never_leak_a_path_or_a_host(self):
        base = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, base, True)
        tree(base, {})
        (base / "durable.py").write_bytes(b"# tampered\n")
        with self.assertRaises(manifest.ManifestError) as caught:
            manifest.verify_files(doc(), base)
        message = str(caught.exception)
        self.assertIn("durable.py", message)
        for secret in (str(base), os.sep + "home", "technocore.chat", "65.20."):
            self.assertNotIn(secret, message)


class FilesOnDisk(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base, True)
        tree(self.base, {})

    def test_matching_files_pass(self):
        manifest.verify_files(doc(), self.base)

    def test_one_added_byte_is_caught(self):
        (self.base / "room_census.py").write_bytes(b"# room_census.py\n ")
        with self.assertRaises(manifest.ManifestError):
            manifest.verify_files(doc(), self.base)

    def test_same_size_different_content_is_caught(self):
        (self.base / "flop_did.py").write_bytes(b"# flop_diX.py\n")
        with self.assertRaises(manifest.ManifestError):
            manifest.verify_files(doc(), self.base)

    def test_a_missing_file_is_caught(self):
        (self.base / "census_render.py").unlink()
        with self.assertRaises(manifest.ManifestError):
            manifest.verify_files(doc(), self.base)

    def test_verify_reads_checks_and_returns_the_digest(self):
        path = self.base / "deploy_manifest.json"
        path.write_bytes(manifest.canonical_bytes(doc()))
        found, sha = manifest.verify(path, self.base)
        self.assertEqual((found, sha), (doc(), manifest.digest(doc())))

    def test_verify_reports_a_missing_manifest_without_its_path(self):
        with self.assertRaises(manifest.ManifestError) as caught:
            manifest.verify(self.base / "absent.json", self.base)
        self.assertNotIn(str(self.base), str(caught.exception))

    def test_the_real_program_files_can_be_described_and_verified(self):
        real = manifest.build(COMMIT)
        manifest.verify_files(real, manifest.BASE)
        self.assertEqual([e["path"] for e in real["files"]], sorted(manifest.RUNTIME_FILES))


class PastTheGate(BaseException):
    """Raised by any request, wait or lock once a run went past the provenance check."""


@unittest.skipUnless(shutil.which("git"), "git is not installed")
class FromCommit(unittest.TestCase):
    """The command line describes the files as the commit stores them, not as the checkout shows them."""

    def setUp(self):
        self.repo = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.repo, True)
        git = lambda *a: subprocess.run(["git", "-C", str(self.repo), *a], check=True, capture_output=True)
        git("init", "-q")
        git("config", "core.autocrlf", "false")
        git("config", "user.email", "tests@example.invalid")
        git("config", "user.name", "tests")
        self.committed = {name: f"# {name}\nprint('lf only')\n".encode() for name in manifest.RUNTIME_FILES}
        tree(self.repo, self.committed)
        git("add", "-A")
        git("commit", "-q", "-m", "runtime files")
        self.commit = subprocess.run(["git", "-C", str(self.repo), "rev-parse", "HEAD"],
                                     capture_output=True, text=True, check=True).stdout.strip()

    def test_digests_are_those_of_the_committed_bytes(self):
        for name in manifest.RUNTIME_FILES:                       # a checkout that rewrote line endings
            (self.repo / name).write_bytes(self.committed[name].replace(b"\n", b"\r\n"))
        built = manifest.build(self.commit, reader=manifest.from_commit(self.commit, self.repo))
        expected = {n: hashlib.sha256(b).hexdigest() for n, b in self.committed.items()}
        self.assertEqual({e["path"]: e["sha256"] for e in built["files"]}, expected)
        self.assertEqual(built["source"]["commit"], self.commit)

    def test_an_unknown_commit_is_refused(self):
        with self.assertRaises(manifest.ManifestError):
            manifest.build("f" * 40, reader=manifest.from_commit("f" * 40, self.repo))


class RunGate(unittest.TestCase):
    """A run stops on a bad manifest before any collection, any state change and any request."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.manifest = self.tmp / "deploy_manifest.json"
        self.manifest.write_bytes(manifest.canonical_bytes(manifest.build(COMMIT)))
        self.did_file = self.tmp / "did.txt"
        self.did_file.write_text("did:key:z6Mk" + "A" * 44, encoding="utf-8")
        p = mock.patch.object(rc.flop_did, "DID_FILE", self.did_file)
        p.start()
        self.addCleanup(p.stop)
        patches = {"MANIFEST_FILE": self.manifest, "ARCHIVE": self.tmp / "census.jsonl",
                   "STATE_FILE": self.tmp / "state.json", "JOURNAL": self.tmp / "pending_publication.json",
                   "SITE_DIR": self.tmp / "no-site"}
        for name, value in patches.items():
            p = mock.patch.object(rc, name, value)
            p.start()
            self.addCleanup(p.stop)
        # past the gate, the first request, wait or lock is a BaseException nothing in the program
        # catches: a gate that let a bad manifest through fails at once instead of retrying
        for target, name in ((rc, "get_json"), (rc, "get_text"), (rc.time, "sleep"), (rc.durable, "ProcessLock")):
            p = mock.patch.object(target, name, side_effect=PastTheGate(f"{name} reached"))
            p.start()
            self.addCleanup(p.stop)

    def run_census(self, *args):
        with mock.patch.object(sys, "argv", ["room_census.py", *args]), mock.patch("builtins.print"):
            try:
                rc.main()
                return 0
            except SystemExit as e:
                return e.code

    def files_now(self):
        return {p.name: p.read_bytes() for p in sorted(self.tmp.iterdir()) if p.is_file()
                and p.name != "deploy_manifest.json"}

    def test_every_broken_manifest_stops_the_run_before_anything_happens(self):
        good = self.manifest.read_bytes()
        broken = {
            "absent": None,
            "empty": b"",
            "not canonical": json.dumps(json.loads(good), indent=1).encode(),
            "unknown schema": manifest.canonical_bytes({**json.loads(good), "schema": "x/1"}),
            "short commit": manifest.canonical_bytes(
                {**json.loads(good), "source": {**json.loads(good)["source"], "commit": "abc"}}),
            "incomplete": manifest.canonical_bytes(
                {**json.loads(good), "files": json.loads(good)["files"][:-1]}),
            "one wrong digest": manifest.canonical_bytes(
                {**json.loads(good),
                 "files": [{**e, "sha256": "0" * 64} if e["path"] == "durable.py" else e
                           for e in json.loads(good)["files"]]}),
        }
        for name, data in broken.items():
            with self.subTest(manifest=name):
                if data is None:
                    self.manifest.unlink()
                else:
                    self.manifest.write_bytes(data)
                before = self.files_now()
                self.assertEqual(self.run_census("--publish"), 2)     # 2: provenance, never 0 or 1
                self.assertEqual(self.files_now(), before)            # nothing written, not even state
                self.manifest.write_bytes(good)

    def test_a_dry_run_is_gated_too(self):
        self.manifest.write_bytes(b"{}")
        self.assertEqual(self.run_census(), 2)

    def test_the_gate_runs_before_the_random_wait(self):
        self.manifest.write_bytes(b"{}")
        self.assertEqual(self.run_census("--publish", "--jitter", "10"), 2)      # sleep raises PastTheGate

    def test_a_valid_manifest_lets_the_run_reach_the_collection(self):
        with mock.patch.object(rc, "prepare", side_effect=RuntimeError("collection reached")) as prepare:
            with self.assertRaises(RuntimeError):
                self.run_census()
        self.assertEqual(prepare.call_args.args[1]["manifest_sha256"],
                         hashlib.sha256(self.manifest.read_bytes()).hexdigest())


class PublicReferences(unittest.TestCase):
    """What the census publishes carries the manifest digest, and the manifest is published as is."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        shutil.copy(REPO / "index.html", self.tmp / "index.html")
        p = mock.patch.object(rc, "SITE_DIR", self.tmp)
        p.start()
        self.addCleanup(p.stop)
        self.doc = doc()
        self.sha = manifest.digest(self.doc)
        self.prov = manifest.provenance(self.doc, self.sha)

    def census(self, n=1, with_doc=None, **kw):
        """A census as prepare() archives it: provenance in the snapshot, the manifest beside it."""
        rec = record(n, **kw)
        used = with_doc or self.doc
        rec["provenance"] = manifest.provenance(used, manifest.digest(used))
        rec["deploy_manifest"] = used
        rec["sha256"] = hashlib.sha256(rc.snapshot_bytes(rec)).hexdigest()
        return rec

    def signed(self, rec):
        return rc.build_message(rec, None, [], 0, [])

    def published(self):
        folder = self.tmp / "data" / "manifests"
        return sorted(p.name for p in folder.iterdir()) if folder.exists() else []

    def test_snapshot_latest_and_message_all_carry_the_manifest_digest(self):
        rec = self.census(2, interval=True)
        snapshot = rc.snapshot_bytes(rec)
        self.assertIn(self.sha.encode(), snapshot)
        self.assertNotIn(b"deploy_manifest", snapshot)          # the document stays in the archive only
        rc.write_data_files([rec], DID)
        latest = json.loads((self.tmp / "data/latest.json").read_text(encoding="utf-8"))
        self.assertEqual(latest["provenance"], self.prov)
        self.assertNotIn("deploy_manifest", latest)
        self.assertEqual((self.tmp / rec["snapshot"]).read_bytes(), snapshot)
        message = self.signed(rec)
        self.assertIn(f"manifest:{self.sha}", message)
        self.assertIn(f"{rc.DASHBOARD}/data/manifests/{self.sha}.json", message)

    def test_the_published_manifest_is_named_after_its_own_bytes(self):
        rc.write_data_files([self.census(1)], DID)
        published = self.tmp / "data" / "manifests" / f"{self.sha}.json"
        data = published.read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), published.stem)
        self.assertEqual(manifest.parse(data), self.doc)

    def test_every_manifest_named_by_a_census_is_published_even_after_a_redeployment(self):
        older = doc(source={"durable.py": b"# the code of a previous deployment\n"})
        recovered = self.census(1, with_doc=older)             # e.g. finished by a later deployment
        current = self.census(2, at="2026-09-24T12:00:00+00:00")
        rc.write_data_files([recovered, current], DID)
        self.assertEqual(self.published(), sorted([f"{manifest.digest(older)}.json", f"{self.sha}.json"]))

    def test_a_stored_manifest_that_does_not_match_its_census_is_never_published(self):
        rec = self.census(1)
        rec["deploy_manifest"] = doc(source={"flop_did.py": b"# swapped\n"})
        with self.assertRaises(rc.RecordInvalid):
            rc.write_data_files([rec], DID)
        self.assertEqual(self.published(), [])

    def test_a_stored_document_that_is_not_a_manifest_is_never_published(self):
        rec = self.census(1)
        bad = json.loads(json.dumps(self.doc))
        bad["files"][0]["path"] = "../../identity.pem"
        rec["deploy_manifest"] = bad
        rec["provenance"] = {**rec["provenance"], "manifest_sha256": manifest.digest(bad)}
        with self.assertRaises(rc.RecordInvalid):
            rc.write_data_files([rec], DID)
        self.assertEqual(self.published(), [])

    def test_identity_json_describes_the_agent_and_its_provenance(self):
        rc.write_data_files([self.census(1)], DID)
        identity = json.loads((self.tmp / "identity.json").read_text(encoding="utf-8"))
        self.assertEqual((identity["schema"], identity["did"]), (rc.IDENTITY_SCHEMA, DID))
        self.assertEqual(identity["provenance"], self.prov)
        self.assertEqual(identity["room"], rc.ROOM)
        self.assertTrue(identity["verify"])

    def test_public_files_hold_no_host_no_path_and_no_secret(self):
        rc.write_data_files([self.census(1)], DID)
        forbidden = ("65.20.101.7", "/opt/flop", "identity.pem", "passphrase", "FLOP_DID_PASSPHRASE",
                     "ssh", "root@", "deploy_key", str(self.tmp), str(REPO))
        files = sorted(p for p in self.tmp.rglob("*") if p.is_file() and p.suffix in (".json", ".csv", ".html"))
        self.assertTrue(any(p.parent.name == "manifests" for p in files))
        for path in files:
            text = path.read_text(encoding="utf-8", errors="replace")
            for secret in forbidden:
                with self.subTest(file=path.name, secret=secret):
                    self.assertNotIn(secret, text)

    def test_the_page_shows_the_identity_and_provenance_section(self):
        view = rc.public_view(self.census(2, interval=True), 2, DID)
        page = cr.render_page((REPO / "index.html").read_text(encoding="utf-8"), view, rc.DASHBOARD)
        self.assertIn(self.sha, page)
        self.assertIn(self.prov["commit"], page)
        self.assertIn(f'href="data/manifests/{self.sha}.json"', page)
        self.assertIn('href="identity.json"', page)

    def test_censuses_published_before_the_manifest_still_render(self):
        old = record(1)                                    # no provenance field at all
        before = rc.snapshot_bytes(old)
        rc.write_data_files([old], DID)                    # and no manifest to publish
        self.assertEqual((self.tmp / old["snapshot"]).read_bytes(), before)
        self.assertNotIn(b"provenance", before)
        latest = json.loads((self.tmp / "data/latest.json").read_text(encoding="utf-8"))
        self.assertIsNone(latest["provenance"])
        self.assertEqual(self.published(), [])
        view = rc.public_view(old, 1, DID)
        page = cr.render_page((REPO / "index.html").read_text(encoding="utf-8"), view, rc.DASHBOARD)
        self.assertIn("census #1", page.lower())
        self.assertIn("before deployment manifests", page)

    def test_old_and_new_censuses_live_side_by_side(self):
        old, new = record(1), self.census(2, at="2026-09-24T12:00:00+00:00", interval=True)
        old_bytes = rc.snapshot_bytes(old)
        rc.write_data_files([old, new], DID)
        self.assertEqual((self.tmp / old["snapshot"]).read_bytes(), old_bytes)
        self.assertEqual(json.loads((self.tmp / "data/latest.json").read_text(encoding="utf-8"))["provenance"], self.prov)

    def test_a_signed_message_without_provenance_has_no_provenance_segment(self):
        self.assertNotIn("Provenance:", self.signed(record(1)))
        self.assertIn("Provenance:", self.signed(self.census(1)))


class RecordIntegrity(unittest.TestCase):
    """A stored record is checked as a whole (snapshot hash, snapshot path, full provenance block
    against its stored manifest) and every record is checked before a single site file is touched."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        shutil.copy(REPO / "index.html", self.tmp / "index.html")
        (self.tmp / "data").mkdir()
        (self.tmp / "data" / "latest.json").write_text('{"census": 0}\n', encoding="utf-8")
        p = mock.patch.object(rc, "SITE_DIR", self.tmp)
        p.start()
        self.addCleanup(p.stop)
        self.old = record(1)
        self.good = record(2, at="2026-09-24T12:00:00+00:00", interval=True)
        self.good["deploy_manifest"] = doc()
        self.good["provenance"] = manifest.provenance(doc(), manifest.digest(doc()))
        self.good["sha256"] = hashlib.sha256(rc.snapshot_bytes(self.good)).hexdigest()

    def tree_now(self):
        return {str(p.relative_to(self.tmp)): p.read_bytes() for p in sorted(self.tmp.rglob("*")) if p.is_file()}

    def test_valid_records_pass(self):
        self.assertEqual(rc.check_records([self.old, self.good]), [self.old, self.good])

    def test_each_alteration_is_named(self):
        cases = altered_records(self.good)
        self.assertGreaterEqual(len(cases), 14)
        for name, (bad, reason) in cases.items():
            with self.subTest(alteration=name):
                with self.assertRaises(rc.RecordInvalid) as caught:
                    rc.check_record(bad)
                self.assertIn(reason, str(caught.exception))

    def test_the_whole_provenance_block_is_compared_not_only_the_digest(self):
        bad = json.loads(json.dumps(self.good))
        bad["provenance"]["commit"] = "e" * 40                    # digest untouched, snapshot resealed
        bad["sha256"] = hashlib.sha256(rc.snapshot_bytes(bad)).hexdigest()
        self.assertEqual(bad["provenance"]["manifest_sha256"], self.good["provenance"]["manifest_sha256"])
        with self.assertRaises(rc.RecordInvalid):
            rc.check_record(bad)

    def test_no_site_file_is_written_when_any_record_is_altered(self):
        before = self.tree_now()
        for name, (bad, _) in altered_records(self.good).items():
            with self.subTest(alteration=name):
                with self.assertRaises(rc.RecordInvalid):
                    rc.write_data_files([self.old, bad], DID)       # the bad one comes last: first pass
                self.assertEqual(self.tree_now(), before)

    def test_the_site_repository_is_not_touched_either(self):
        (self.tmp / ".git").mkdir()
        bad, _ = altered_records(self.good)["provenance.commit"]
        with mock.patch.object(rc, "read_archive", return_value=[self.old, bad]), \
                mock.patch.object(rc.subprocess, "run", side_effect=AssertionError("git was called")) as run:
            with self.assertRaises(rc.RecordInvalid):
                rc.update_site(DID)
        self.assertFalse(run.called)

    def test_the_archive_refuses_an_altered_record(self):
        archive = self.tmp / "census.jsonl"
        with mock.patch.object(rc, "ARCHIVE", archive):
            self.assertTrue(rc.archive_append(self.good))
            before = archive.read_bytes()
            for name, (bad, _) in altered_records(self.good).items():
                with self.subTest(alteration=name):
                    with self.assertRaises(rc.RecordInvalid):
                        rc.archive_append(bad)
                    self.assertEqual(archive.read_bytes(), before)

    def test_published_censuses_still_pass(self):
        """The two censuses already public, rebuilt from their public snapshots, hold."""
        for name in sorted((REPO / "data" / "snapshots").glob("*.json")):
            with self.subTest(snapshot=name.name):
                data = name.read_bytes()
                rec = json.loads(data)
                rec.update(snapshot=f"data/snapshots/{name.name}", sha256=hashlib.sha256(data).hexdigest())
                self.assertEqual(rc.snapshot_bytes(rec), data)
                rc.check_record(rec)


class RuntimeFiles(unittest.TestCase):
    """RUNTIME_FILES is exactly the closure of the repository modules imported from room_census.py."""

    def local_imports(self, path):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                self.assertEqual(node.level, 0, f"relative import in {path.name}")
                names.add(node.module.split(".")[0])
            elif isinstance(node, ast.Call):
                func = node.func
                called = func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")
                self.assertNotIn(called, ("__import__", "import_module"), f"dynamic import in {path.name}")
        for name in names:
            self.assertFalse((REPO / name / "__init__.py").exists(), f"package {name}: not covered by the manifest")
        return {name for name in names if (REPO / f"{name}.py").is_file()}

    def test_every_repository_module_reached_from_room_census_is_listed_exactly_once(self):
        seen, todo = set(), ["room_census"]
        while todo:
            name = todo.pop()
            if name not in seen:
                seen.add(name)
                todo.extend(self.local_imports(REPO / f"{name}.py"))
        self.assertEqual(len(manifest.RUNTIME_FILES), len(set(manifest.RUNTIME_FILES)))
        self.assertEqual(sorted(manifest.RUNTIME_FILES), sorted(f"{name}.py" for name in seen))


class OptimizedMode(unittest.TestCase):
    """python -O strips asserts; every check above must still refuse a bad manifest."""

    def test_validation_and_the_run_gate_hold_under_dash_O(self):
        code = ("import json, sys, pathlib\n"
                "sys.path.insert(0, sys.argv[1])\n"
                "import manifest\n"
                "assert False, 'asserts are stripped under -O'\n"
                "good = json.loads(sys.argv[2].encode())\n"
                "manifest.parse(manifest.canonical_bytes(good))\n"
                "broken = {**good, 'files': good['files'][:-1]}\n"
                "for data in (b'{}', b'[]', json.dumps(good, indent=1).encode(),\n"
                "             manifest.canonical_bytes(broken)):\n"
                "    try:\n"
                "        manifest.parse(data)\n"
                "        print('accepted a bad manifest')\n"
                "        sys.exit(1)\n"
                "    except manifest.ManifestError:\n"
                "        pass\n"
                "print('rejected')\n")
        out = subprocess.run([sys.executable, "-O", "-c", code, str(REPO), json.dumps(doc())],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual((out.returncode, out.stdout.strip()), (0, "rejected"), out.stderr)

    def test_the_command_line_builds_and_verifies_under_dash_O(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        out = tmp / "deploy_manifest.json"
        build = subprocess.run([sys.executable, "-O", str(REPO / "manifest.py"), "build",
                                "--commit", COMMIT, "--from-disk", "--out", str(out)],
                               capture_output=True, text=True, timeout=60)
        self.assertEqual(build.returncode, 0, build.stderr)
        self.assertIn(hashlib.sha256(out.read_bytes()).hexdigest(), build.stdout)
        self.assertEqual(json.loads(out.read_bytes())["source"]["commit"], COMMIT)
        check = subprocess.run([sys.executable, "-O", str(REPO / "manifest.py"), "verify",
                                "--manifest", str(out)], capture_output=True, text=True, timeout=60)
        self.assertEqual(check.returncode, 0, check.stderr)
        out.write_bytes(out.read_bytes() + b" ")
        broken = subprocess.run([sys.executable, "-O", str(REPO / "manifest.py"), "verify",
                                 "--manifest", str(out)], capture_output=True, text=True, timeout=60)
        self.assertEqual(broken.returncode, 1)
        self.assertIn("manifest error", broken.stdout)


if __name__ == "__main__":
    unittest.main()
