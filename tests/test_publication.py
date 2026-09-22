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
            (flop_did, "SAY_JOURNAL"): self.tmp / "say_pending.json",
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
        for target, name, value in ((flop_did, "post_signed", self.server.post),
                                    (flop_did, "fetch_export", lambda room: self.server.text(f"/r/{room}/export")),
                                    (rc, "refresh_did_note", lambda did: None)):
            p = mock.patch.object(target, name, value)
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


class ManualSay(PublicationCase):
    """flop_did.py say: a lost response or an interruption never leads to the same content being
    signed again with a new nonce."""
    TEXT = "About room-census: a twice-weekly signed census of public Technocore rooms."

    def say(self, text=TEXT):
        with mock.patch("builtins.print"):
            try:
                return flop_did.cmd_say(rc.ROOM, text)
            except SystemExit as e:
                return e

    def reserved(self):
        return json.loads(flop_did.NONCE_FILE.read_text())[rc.ROOM] if flop_did.NONCE_FILE.exists() else None

    def test_message_stored_then_response_lost_is_confirmed_without_a_second_post(self):
        self.server.plan = ["lose_response"]
        proof = self.say()
        self.assertIsInstance(proof, dict)
        self.assertEqual((self.server.post_calls, len(self.server.stored)), (1, 1))
        self.assertEqual(proof["nonce"], str(self.server.stored[0]["nonce"]))
        self.assertFalse(flop_did.SAY_JOURNAL.exists())
        self.assertEqual(len(flop_did.PROOF_FILE.read_text().splitlines()), 1)

    def test_rerun_after_a_crash_following_storage_does_not_sign_again(self):
        self.server.plan = ["crash_after"]
        with self.assertRaises(Crash):
            self.say()
        self.assertTrue(flop_did.SAY_JOURNAL.exists())
        nonce_before = self.reserved()
        self.assertIsInstance(self.say(), dict)               # the same command again
        self.assertEqual((self.server.post_calls, len(self.server.stored)), (1, 1))
        self.assertEqual(self.reserved(), nonce_before)       # no new nonce reserved
        self.assertFalse(flop_did.SAY_JOURNAL.exists())

    def test_rerun_after_a_crash_before_sending_resends_the_same_signature(self):
        self.server.plan = ["crash_before"]
        with self.assertRaises(Crash):
            self.say()
        pending = json.loads(flop_did.SAY_JOURNAL.read_text())
        self.assertIsInstance(self.say(), dict)
        self.assertEqual(len(self.server.stored), 1)
        landed = self.server.stored[0]
        self.assertEqual((str(landed["nonce"]), landed["sig"]), (pending["nonce"], pending["sig"]))
        self.assertEqual(self.reserved(), int(pending["nonce"]))

    def test_lost_response_with_unreachable_export_keeps_the_journal_then_confirms(self):
        self.server.plan = ["lose_response"]
        self.server.export_fails = True
        self.assertIsInstance(self.say(), SystemExit)
        self.assertTrue(flop_did.SAY_JOURNAL.exists())
        self.server.export_fails = False
        self.assertIsInstance(self.say(), dict)
        self.assertEqual((self.server.post_calls, len(self.server.stored)), (1, 1))

    def test_a_different_message_after_an_interruption_finishes_the_first_one_first(self):
        self.server.plan = ["crash_after"]
        with self.assertRaises(Crash):
            self.say()
        self.assertIsInstance(self.say("A second, different message."), dict)
        self.assertEqual([m["text"] for m in self.server.stored], [self.TEXT, "A second, different message."])
        self.assertLess(self.server.stored[0]["nonce"], self.server.stored[1]["nonce"])

    def test_request_lost_before_storage_is_reported_and_not_retried_with_a_new_nonce(self):
        self.server.plan = ["lose_request"]
        self.assertIsInstance(self.say(), SystemExit)
        self.assertEqual((self.server.post_calls, self.server.stored), (1, []))
        self.assertFalse(flop_did.SAY_JOURNAL.exists())       # proven absent: nothing left to finish

    def test_unusable_journal_blocks_sending(self):
        flop_did.SAY_JOURNAL.write_text("{broken")
        self.assertIsInstance(self.say(), SystemExit)
        self.assertEqual(self.server.post_calls, 0)
        self.assertEqual(flop_did.SAY_JOURNAL.read_text(), "{broken")

    # crashes around the final acknowledgement

    def crash_on_journal_unlink(self, after_unlink: bool):
        """Kills the process when the say journal is dropped, just after (or just before) the unlink."""
        journal, original = flop_did.SAY_JOURNAL, Path.unlink

        def unlink(path, *a, **kw):
            if path == journal and not after_unlink:
                raise Crash("killed just before the journal was dropped")
            original(path, *a, **kw)
            if path == journal and after_unlink:
                raise Crash("killed just after the journal was dropped, before cmd_say returned")
        return mock.patch.object(Path, "unlink", unlink)

    def test_crash_right_after_confirmation_and_before_return_publishes_nothing_on_rerun(self):
        with self.crash_on_journal_unlink(after_unlink=True), self.assertRaises(Crash):
            self.say()
        self.assertFalse(flop_did.SAY_JOURNAL.exists())       # no journal left: only the receipt remains
        nonce_before = self.reserved()
        proof = self.say()                                    # the user runs the same command again
        self.assertIsInstance(proof, dict)
        self.assertEqual(proof["nonce"], str(self.server.stored[0]["nonce"]))
        self.assertEqual((self.server.post_calls, len(self.server.stored)), (1, 1))
        self.assertEqual(self.reserved(), nonce_before)       # no nonce reserved by the rerun

    def test_crash_after_the_receipt_but_before_dropping_the_journal(self):
        with self.crash_on_journal_unlink(after_unlink=False), self.assertRaises(Crash):
            self.say()
        self.assertTrue(flop_did.SAY_JOURNAL.exists())
        nonce_before = self.reserved()
        self.assertIsInstance(self.say(), dict)
        self.assertEqual((self.server.post_calls, len(self.server.stored), self.reserved()), (1, 1, nonce_before))
        self.assertFalse(flop_did.SAY_JOURNAL.exists())
        self.assertEqual(len(flop_did.read_proofs()), 1)

    def test_crash_in_the_recovery_path_after_dropping_the_journal(self):
        self.server.plan = ["crash_after"]
        with self.assertRaises(Crash):
            self.say()                                        # stored, journal left behind
        with self.crash_on_journal_unlink(after_unlink=True), self.assertRaises(Crash):
            self.say("Another message")                       # recovery confirms the first, then dies
        self.assertFalse(flop_did.SAY_JOURNAL.exists())
        nonce_before = self.reserved()
        self.assertIsInstance(self.say(), dict)               # the first text again: receipt, nothing sent
        self.assertEqual((self.server.post_calls, len(self.server.stored), self.reserved()), (1, 1, nonce_before))

    def test_repeat_is_the_only_way_to_publish_the_same_text_again(self):
        first = self.say()
        again = self.say()                                    # no intent: the receipt is returned
        self.assertEqual((again["nonce"], self.server.post_calls), (first["nonce"], 1))
        with mock.patch("builtins.print"):
            repeated = flop_did.cmd_say(rc.ROOM, self.TEXT, repeat=True)
        self.assertEqual(len(self.server.stored), 2)
        self.assertGreater(int(repeated["nonce"]), int(first["nonce"]))

    def test_command_line_repeat_flag(self):
        with mock.patch.object(flop_did, "cmd_say") as say:
            for argv in (["say", rc.ROOM, "hello", "world"], ["say", "--repeat", rc.ROOM, "hello", "world"]):
                with mock.patch.object(sys, "argv", ["flop_did.py", *argv]):
                    flop_did.main()
        self.assertEqual(say.call_args_list, [mock.call(rc.ROOM, "hello world"),
                                              mock.call(rc.ROOM, "hello world", repeat=True)])

    def test_receipts_are_written_atomically_after_an_old_truncated_line(self):
        flop_did.PROOF_FILE.write_text('{"room": "x", "nonce": "1"}\n{"trunc')    # legacy partial append
        self.say()
        lines = flop_did.PROOF_FILE.read_text().splitlines()
        self.assertEqual(lines[1], '{"trunc')
        self.assertEqual(json.loads(lines[2])["text"], self.TEXT)             # complete, on its own line
        self.assertEqual(len(list(self.tmp.glob(".proofs.jsonl.*.tmp"))), 0)


class ExportRequests(unittest.TestCase):
    """Point 2: /r/<room>/export is requested without any query parameter."""

    def captured_url(self, call):
        seen = []

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b'{"seq": 1, "ts": "2026-09-22T00:00:00Z", "from": "x", "text": "t"}\n'
        with mock.patch("urllib.request.urlopen", lambda req, timeout: seen.append(req.full_url) or Response()):
            call()
        return seen

    def test_census_export_has_no_query_parameter(self):
        self.assertEqual(self.captured_url(lambda: rc.room_export(rc.ROOM)), [f"{rc.SERVER}/r/{rc.ROOM}/export"])

    def test_manual_say_export_has_no_query_parameter(self):
        self.assertEqual(self.captured_url(lambda: flop_did.fetch_export(rc.ROOM)),
                         [f"{flop_did.SERVER}/r/{rc.ROOM}/export"])

    def test_paged_reads_keep_their_cache_busting_parameter(self):
        with mock.patch("urllib.request.urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = b"{}"
            rc.get_json(f"/r/{rc.ROOM}?format=json&limit=200")
        self.assertIn("&n=", urlopen.call_args[0][0].full_url)


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
