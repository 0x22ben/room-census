"""Crash, recovery and duplication scenarios of the publication path, against a fake Technocore that
enforces the real nonce rule (a nonce must exceed the last one this key used in the room)."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import durable
import flop_did
import room_census as rc
from tests.helpers import FakeTechnocore, install, messages


class Crash(BaseException):
    """Stands for the process being killed: not an Exception, so nothing in the code catches it."""


class FakeServer(FakeTechnocore):
    def __init__(self, **kw):
        super().__init__(listing=["dev", "kibble"], rooms={"dev": {"last_seq": 900, "generation": 0,
                                                                   "messages": messages(60, 12)},
                                                           "kibble": {"last_seq": 500, "generation": 0,
                                                                      "messages": messages(60, 3)}}, **kw)
        self.seq = 0
        # a message posted by someone else before the census, so the retained history reaches back
        self.others = [self.message("did:key:z6MkOTHERoldestAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 1, "x" * 86,
                                    "hello", ts=(datetime.now(timezone.utc) - timedelta(days=2)).isoformat())]
        self.stored = []            # our messages that really landed in room-census
        self.post_calls = 0
        self.plan = []              # behaviour of the next posts: ok, lose_request, lose_response, crash_before, crash_after
        self.export_fails = False
        self.retained_since = None  # drop records older than this timestamp from the export (ring eviction)

    def message(self, did, nonce, sig, text, ts=None):
        self.seq += 1
        return {"seq": self.seq, "ts": ts or datetime.now(timezone.utc).isoformat(), "from": did,
                "nonce": int(nonce), "sig": sig, "text": text}

    def room(self):
        return sorted(self.others + self.stored, key=lambda m: m["seq"])

    def chatter(self, n):
        """n messages from other agents, after everything already in the room."""
        for i in range(n):
            self.others.append(self.message(f"did:key:z6MkOTHER{i:04d}", i + 1, "y" * 86, f"chatter {i}"))

    def __call__(self, path):
        if path.startswith(f"/r/{rc.ROOM}"):
            return {"generation": 0, "last_seq": self.seq, "messages": self.room()[-200:]}   # latest page only
        return super().__call__(path)

    def text(self, path):
        if path != f"/r/{rc.ROOM}/export":
            raise AssertionError(f"unexpected text request {path}")
        if self.export_fails:
            raise TimeoutError("export unreachable")
        rows = self.room()
        if self.retained_since:
            rows = [m for m in rows if rc.parse_ts(m["ts"]) >= rc.parse_ts(self.retained_since)]
        return "".join(json.dumps(m) + "\n" for m in rows)

    def post(self, room, did, sig, nonce, text):
        self.post_calls += 1
        mode = self.plan.pop(0) if self.plan else "ok"
        if mode == "crash_before":
            raise Crash("killed before the request left")
        if mode == "lose_request":
            raise TimeoutError("request lost")
        last = max((int(m["nonce"]) for m in self.stored if m["from"] == did), default=0)
        if int(nonce) <= last:
            raise flop_did.PublishRefused("HTTP 400: bad nonce: must exceed the last nonce")
        self.stored.append(self.message(did, nonce, sig, text))
        if mode == "lose_response":
            raise TimeoutError("response lost after the message was stored")
        if mode == "crash_after":
            raise Crash("killed right after the message was stored")
        return 200, "# room room-census"


class PublicationCase(unittest.TestCase):
    """Temporary files, a throwaway key and a fake server; no scenario of its own."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        patches = {
            (rc, "ARCHIVE"): self.tmp / "census.jsonl", (rc, "STATE_FILE"): self.tmp / "state.json",
            (rc, "JOURNAL"): self.tmp / "pending_publication.json", (rc, "ABANDONED_DIR"): self.tmp / "abandoned",
            (rc, "SITE_DIR"): self.tmp / "no-site", (rc, "POST_RETRY_WAIT"): 0,
            (flop_did, "KEY_FILE"): self.tmp / "identity.pem", (flop_did, "PASS_FILE"): self.tmp / "passphrase.txt",
            (flop_did, "DID_FILE"): self.tmp / "did.txt", (flop_did, "PROOF_FILE"): self.tmp / "proofs.jsonl",
            (flop_did, "NONCE_FILE"): self.tmp / "nonces.json", (flop_did, "LOCK_FILE"): self.tmp / "census.lock",
        }
        for (module, name), value in patches.items():
            p = mock.patch.object(module, name, value)
            p.start()
            self.addCleanup(p.stop)
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("FLOP_DID_PASSPHRASE", None)
        with mock.patch("builtins.print"):
            flop_did.cmd_init()
        self.did = flop_did.DID_FILE.read_text().strip()
        self.server = FakeServer()
        install(self, self.server)
        for target, value in ((flop_did, "post_signed"), (rc, "refresh_did_note")):
            p = mock.patch.object(target, value, self.server.post if value == "post_signed" else lambda did: None)
            p.start()
            self.addCleanup(p.stop)

    # helpers

    def run_main(self):
        """Runs `room_census.py --publish` in-process; returns the exit code (0 when main returns)."""
        with mock.patch.object(sys, "argv", ["room_census.py", "--publish"]), mock.patch("builtins.print"):
            try:
                rc.main()
                return 0
            except SystemExit as e:
                return e.code

    def archive(self):
        return rc.read_archive_lines()

    def assert_consistent(self, published=1):
        """Exactly `published` messages landed, each archived once with its own nonce, journal gone."""
        self.assertEqual(len(self.server.stored), published)
        archived = self.archive()
        self.assertEqual(len(archived), published)
        self.assertEqual(sorted(str(m["nonce"]) for m in self.server.stored),
                         sorted(r["signed_in"]["nonce"] for r in archived))
        self.assertEqual(len({r["sha256"] for r in archived}), published)
        self.assertFalse(rc.JOURNAL.exists())


class Publication(PublicationCase):
    def test_normal_run_publishes_once_and_cleans_up(self):
        self.assertEqual(self.run_main(), 0)
        self.assert_consistent(1)
        nonce = self.server.stored[0]["nonce"]
        self.assertEqual(json.loads(flop_did.NONCE_FILE.read_text())[rc.ROOM], nonce)
        self.assertTrue(rc.STATE_FILE.exists())
        self.assertEqual(len(flop_did.PROOF_FILE.read_text().splitlines()), 1)

    def test_crash_after_the_message_landed_is_recovered_without_a_second_post(self):
        self.server.plan = ["crash_after"]
        with self.assertRaises(Crash):
            self.run_main()
        self.assertTrue(rc.JOURNAL.exists())
        self.assertEqual(self.archive(), [])
        self.assertEqual(self.run_main(), 0)                     # next run: recovery only
        self.assertEqual(self.server.post_calls, 1)             # nothing sent again, no new census
        self.assert_consistent(1)

    def test_crash_before_the_message_left_is_sent_again_with_the_same_signature(self):
        self.server.plan = ["crash_before"]
        with self.assertRaises(Crash):
            self.run_main()
        pending = json.loads(rc.JOURNAL.read_text())
        self.assertEqual(self.server.stored, [])
        self.assertEqual(self.run_main(), 0)
        self.assert_consistent(1)
        landed = self.server.stored[0]
        self.assertEqual((str(landed["nonce"]), landed["sig"]), (pending["nonce"], pending["sig"]))

    def test_lost_response_is_detected_in_the_room_and_not_retried(self):
        self.server.plan = ["lose_response"]
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.server.post_calls, 1)
        self.assert_consistent(1)

    def test_two_lost_requests_keep_the_journal_then_the_next_run_completes(self):
        self.server.plan = ["lose_request", "lose_request"]
        self.assertEqual(self.run_main(), 1)
        self.assertTrue(rc.JOURNAL.exists())
        self.assertEqual((self.server.stored, self.archive()), ([], []))
        self.assertEqual(json.loads(rc.JOURNAL.read_text())["attempts"], 2)
        self.assertEqual(self.run_main(), 0)
        self.assert_consistent(1)

    def test_crash_during_finalize_is_idempotent(self):
        original = flop_did.record_proof
        calls = {"n": 0}

        def crash_once(*a, **kw):
            calls["n"] += 1
            if calls["n"] == 1:
                raise Crash("killed after archive and state, before the proof")
            return original(*a, **kw)
        with mock.patch.object(flop_did, "record_proof", crash_once):
            with self.assertRaises(Crash):
                self.run_main()
            self.assertEqual(len(self.archive()), 1)            # archive written, journal still there
            self.assertTrue(rc.JOURNAL.exists())
            self.assertEqual(self.run_main(), 0)
        self.assert_consistent(1)                               # still one archived census
        self.assertEqual(len(flop_did.PROOF_FILE.read_text().splitlines()), 1)

    def test_a_refused_resend_of_a_landed_message_is_recognised(self):
        self.server.plan = ["crash_after"]
        with self.assertRaises(Crash):
            self.run_main()
        pending = json.loads(rc.JOURNAL.read_text())
        with mock.patch.object(rc, "is_published", side_effect=[False, True]):
            self.assertTrue(rc.deliver(pending))                # server refuses the nonce, room confirms
        self.assertEqual(len(self.server.stored), 1)

    def test_stale_unpublished_journal_is_set_aside_and_a_fresh_census_runs(self):
        self.server.plan = ["crash_before"]
        with self.assertRaises(Crash):
            self.run_main()
        pending = json.loads(rc.JOURNAL.read_text())
        pending["created_utc"] = (datetime.now(timezone.utc) - timedelta(hours=7)).isoformat()
        rc.JOURNAL.write_text(json.dumps(pending))
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(len(list(rc.ABANDONED_DIR.iterdir())), 1)
        self.assert_consistent(1)
        self.assertNotEqual(str(self.server.stored[0]["nonce"]), pending["nonce"])   # the stale one was never sent

    def test_unreadable_journal_blocks_publication(self):
        rc.JOURNAL.write_text("{truncated")
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.server.post_calls, 0)
        self.assertEqual(rc.JOURNAL.read_text(), "{truncated")

    def test_an_archived_census_cannot_be_published_twice(self):
        self.run_main()
        record = dict(self.archive()[0])
        lock = durable.ProcessLock(flop_did.LOCK_FILE).acquire()
        self.addCleanup(lock.release)
        with self.assertRaises(RuntimeError):
            rc.publish_census(json.loads(rc.STATE_FILE.read_text()), record, "text", lock)
        self.assertEqual(self.server.post_calls, 1)

    def test_archive_append_is_idempotent(self):
        rec = {"schema": rc.SCHEMA, "sha256": "abc", "census": 1}
        self.assertTrue(rc.archive_append(rec))
        self.assertFalse(rc.archive_append(rec))
        self.assertEqual(len(self.archive()), 1)

    def test_run_is_skipped_while_another_holds_the_lock(self):
        lock = durable.ProcessLock(flop_did.LOCK_FILE).acquire()
        self.addCleanup(lock.release)
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.server.post_calls, 0)

    def test_lost_nonce_file_uses_the_room_as_a_floor(self):
        self.run_main()
        first = self.server.stored[0]["nonce"]
        flop_did.NONCE_FILE.unlink()
        self.server.stored[0]["nonce"] = first + 10 ** 15      # our last nonce is far above the clock
        self.run_main()
        self.assertGreater(self.server.stored[1]["nonce"], self.server.stored[0]["nonce"])

    def test_two_normal_runs_give_two_censuses_with_increasing_nonces(self):
        self.run_main()
        self.run_main()
        self.assert_consistent(2)
        a, b = (m["nonce"] for m in self.server.stored)
        self.assertLess(a, b)

    def test_manual_say_uses_the_shared_lock_and_nonce_store(self):
        lock = durable.ProcessLock(flop_did.LOCK_FILE).acquire()
        durable.NonceStore(flop_did.NONCE_FILE, lock).reserve(rc.ROOM, now_ms=10 ** 17)
        lock.release()
        with mock.patch("builtins.print"):
            flop_did.cmd_say(rc.ROOM, "About room-census")
        self.assertEqual(self.server.stored[-1]["nonce"], 10 ** 17 + 1)
        durable.ProcessLock(flop_did.LOCK_FILE).acquire().release()     # released afterwards


class CorruptArchive(PublicationCase):
    """Point 1: an invalid census.jsonl line stops everything and the file keeps its exact bytes."""

    def corrupt(self, bad=b'{"schema": "room-census/1", "sha256": "trunc'):
        self.assertEqual(self.run_main(), 0)                   # one valid census first
        data = rc.ARCHIVE.read_bytes() + bad + b"\n"
        rc.ARCHIVE.write_bytes(data)
        return data

    def test_publication_stops_and_the_archive_bytes_are_untouched(self):
        before = self.corrupt()
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(rc.ARCHIVE.read_bytes(), before)
        self.assertEqual(self.server.post_calls, 1)           # nothing new was sent
        self.assertFalse(rc.JOURNAL.exists())

    def test_archive_append_refuses_and_keeps_the_bytes(self):
        before = self.corrupt()
        with self.assertRaises(rc.ArchiveCorrupt):
            rc.archive_append({"schema": rc.SCHEMA, "sha256": "f" * 64, "census": 9})
        self.assertEqual(rc.ARCHIVE.read_bytes(), before)

    def test_a_non_object_line_is_corruption_too(self):
        before = self.corrupt(bad=b"[1, 2, 3]")
        with self.assertRaises(rc.ArchiveCorrupt):
            rc.read_archive_lines()
        self.assertEqual(rc.ARCHIVE.read_bytes(), before)

    def test_a_corrupt_archive_stops_a_new_census_before_anything_is_signed(self):
        before = self.corrupt()
        self.assertEqual(self.run_main(), 1)
        self.assertEqual((self.server.post_calls, rc.JOURNAL.exists()), (1, False))
        self.assertEqual(rc.ARCHIVE.read_bytes(), before)

    def test_recovery_does_not_finalize_into_a_corrupt_archive(self):
        self.assertEqual(self.run_main(), 0)                   # census 1, archived
        self.server.plan = ["crash_after"]
        with self.assertRaises(Crash):
            self.run_main()                                     # census 2 landed, journal left
        before = rc.ARCHIVE.read_bytes() + b"{broken line\n"
        rc.ARCHIVE.write_bytes(before)
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(rc.ARCHIVE.read_bytes(), before)       # not rewritten by the recovery
        self.assertTrue(rc.JOURNAL.exists())                    # kept for the operator
        self.assertEqual(self.server.post_calls, 2)             # and never re-sent


class FullExport(PublicationCase):
    """Point 2: checks read the whole retained export, not the latest 200 messages."""

    def our_page_nonces(self):
        page = self.server(f"/r/{rc.ROOM}?format=json&limit=200")["messages"]
        return {m["nonce"] for m in page if m["from"] == self.did}

    def test_landed_message_buried_under_more_than_200_messages_is_found(self):
        self.server.plan = ["crash_after"]
        with self.assertRaises(Crash):
            self.run_main()
        self.server.chatter(250)
        self.assertEqual(self.our_page_nonces(), set())        # invisible in the latest page
        self.assertEqual(self.run_main(), 0)
        self.assertEqual(self.server.post_calls, 1)           # found in the export: no second post
        self.assert_consistent(1)

    def test_nonce_floor_comes_from_the_whole_export(self):
        self.run_main()
        flop_did.NONCE_FILE.unlink()
        self.server.stored[0]["nonce"] += 10 ** 15            # our last nonce, far above the clock
        self.server.chatter(250)                              # and buried
        self.run_main()
        self.assertGreater(self.server.stored[1]["nonce"], self.server.stored[0]["nonce"])

    def test_unreachable_export_during_recovery_keeps_the_journal_and_sends_nothing(self):
        self.server.plan = ["crash_before"]
        with self.assertRaises(Crash):
            self.run_main()
        self.server.export_fails = True
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.server.post_calls, 1)           # only the crashed attempt
        self.assertTrue(rc.JOURNAL.exists())

    def test_unreachable_export_before_signing_publishes_nothing(self):
        self.server.export_fails = True
        self.assertEqual(self.run_main(), 1)
        self.assertEqual((self.server.post_calls, rc.JOURNAL.exists()), (0, False))
        self.assertFalse(flop_did.NONCE_FILE.exists())        # no nonce consumed either

    def test_evicted_history_cannot_prove_absence_so_nothing_is_resent(self):
        self.server.plan = ["crash_before"]
        with self.assertRaises(Crash):
            self.run_main()
        self.server.chatter(5)
        self.server.retained_since = (datetime.now(timezone.utc) + timedelta(seconds=1)).isoformat()
        self.server.chatter(5)                                # only these are still retained
        for m in self.server.others[-5:]:
            m["ts"] = (datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat()
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.server.post_calls, 1)
        self.assertTrue(rc.JOURNAL.exists())

    def test_lost_request_then_unreachable_export_is_not_retried_blindly(self):
        self.server.plan = ["lose_request"]
        original = self.server.text

        def fail_after_post(path):
            if self.server.post_calls >= 1:
                raise TimeoutError("export down right after the lost request")
            return original(path)
        self.server.text = fail_after_post
        rc.get_text = fail_after_post
        self.assertEqual(self.run_main(), 1)
        self.assertEqual(self.server.post_calls, 1)           # no second send without proof of absence
        self.assertTrue(rc.JOURNAL.exists())


class JournalValidation(PublicationCase):
    """Point 3: explicit schema validation, independent of assert statements."""

    def leave_journal(self):
        self.server.plan = ["crash_before"]
        with self.assertRaises(Crash):
            self.run_main()
        return json.loads(rc.JOURNAL.read_text())

    def test_every_broken_field_blocks_recovery_without_sending(self):
        good = self.leave_journal()
        variants = {
            "schema": {"schema": "room-census-pending/0"}, "run_id": {"run_id": "not-a-hash"},
            "created_utc": {"created_utc": "yesterday"}, "room": {"room": "lobby"},
            "did": {"did": "did:key:zBad"}, "nonce": {"nonce": 12345}, "nonce digits": {"nonce": "12a"},
            "sig": {"sig": "short"}, "text": {"text": "two\nlines"}, "record": {"record": {"sha256": "0" * 64}},
            "state": {"state": {"tracked": "none"}}, "attempts": {"attempts": True},
        }
        for field, change in variants.items():
            with self.subTest(field=field):
                data = json.dumps({**good, **change}).encode()
                rc.JOURNAL.write_bytes(data)
                with self.assertRaises(rc.InvalidJournal):
                    rc.validate_pending(json.loads(data))
                self.assertEqual(self.run_main(), 1)
                self.assertEqual(rc.JOURNAL.read_bytes(), data)
        missing = {k: v for k, v in good.items() if k != "sig"}
        with self.assertRaises(rc.InvalidJournal):
            rc.validate_pending(missing)
        self.assertEqual(self.server.post_calls, 1)           # only the crashed attempt, ever

    def test_the_real_journal_is_valid(self):
        self.assertEqual(rc.validate_pending(self.leave_journal())["room"], rc.ROOM)

    def test_validation_holds_under_python_optimize_mode(self):
        good = self.leave_journal()
        code = ("import json, sys; sys.path.insert(0, sys.argv[1]); import room_census as rc\n"
                "good = json.loads(sys.argv[2])\n"
                "assert False, 'asserts are stripped under -O'\n"
                "rc.validate_pending(good)\n"
                "try:\n    rc.validate_pending({**good, 'sig': 'short'})\nexcept rc.InvalidJournal:\n    print('rejected')\n")
        out = subprocess.run([sys.executable, "-O", "-c", code, str(Path(rc.__file__).parent), json.dumps(good)],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual((out.returncode, out.stdout.strip()), (0, "rejected"), out.stderr)


if __name__ == "__main__":
    unittest.main()
