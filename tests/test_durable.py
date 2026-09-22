"""Kernel lock, atomic writes and monotonic nonces, including real concurrent and crashing processes."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest import mock

import durable

REPO = Path(__file__).resolve().parent.parent


def child(code: str, *args, **kw):
    """Starts `code` in a separate Python process that can import the repository modules."""
    prelude = f"import sys; sys.path.insert(0, {str(REPO)!r})\n"
    return subprocess.Popen([sys.executable, "-c", prelude + textwrap.dedent(code), *map(str, args)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **kw)


class TempDir(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def spawn(self, code, *args):
        """child() whose process is killed and whose pipes are closed at the end of the test."""
        p = child(code, *args)

        def reap():
            if p.poll() is None:
                p.kill()
            p.wait(10)
            for stream in (p.stdin, p.stdout, p.stderr):
                stream.close()
        self.addCleanup(reap)
        return p


class Lock(TempDir):
    def hold_in_child(self):
        p = self.spawn("""
            import durable, sys
            lock = durable.ProcessLock(sys.argv[1]).acquire()
            print("locked", flush=True)
            sys.stdin.readline()          # hold until told to stop, or until killed
        """, self.tmp / "census.lock")
        self.assertEqual(p.stdout.readline().strip(), "locked")
        return p

    def acquire_eventually(self, timeout=10):
        deadline = time.monotonic() + timeout
        while True:
            try:
                return durable.ProcessLock(self.tmp / "census.lock").acquire()
            except durable.LockBusy:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.05)

    def test_second_process_is_refused_while_held(self):
        p = self.hold_in_child()
        with self.assertRaises(durable.LockBusy):
            durable.ProcessLock(self.tmp / "census.lock").acquire()
        p.stdin.write("\n"); p.stdin.flush(); p.wait(10)

    def test_lock_is_released_when_the_holder_is_killed(self):
        p = self.hold_in_child()
        p.kill(); p.wait(10)                                     # crash: no release, no cleanup
        lock = self.acquire_eventually()
        self.assertTrue(lock.held)
        lock.release()

    def test_lock_is_released_when_the_holder_exits_abruptly(self):
        p = self.spawn("""
            import durable, os, sys
            durable.ProcessLock(sys.argv[1]).acquire()
            os._exit(3)                                           # no finally, no atexit
        """, self.tmp / "census.lock")
        self.assertEqual(p.wait(10), 3)
        self.acquire_eventually().release()

    def test_existing_lock_file_does_not_mean_locked(self):
        (self.tmp / "census.lock").write_text("stale content from a crashed run")
        with durable.ProcessLock(self.tmp / "census.lock") as lock:
            self.assertTrue(lock.held)
        self.assertFalse(lock.held)


class AtomicWrite(TempDir):
    def test_writes_bytes_and_text(self):
        durable.atomic_write(self.tmp / "a.json", '{"x": 1}')
        durable.atomic_write(self.tmp / "b.bin", b"\x00\x01")
        self.assertEqual((self.tmp / "a.json").read_text(), '{"x": 1}')
        self.assertEqual((self.tmp / "b.bin").read_bytes(), b"\x00\x01")

    def test_failed_replace_keeps_the_old_file_and_leaves_no_temporary(self):
        target = self.tmp / "state.json"
        target.write_text("old")
        with mock.patch("durable.os.replace", side_effect=OSError("disk full")), self.assertRaises(OSError):
            durable.atomic_write(target, "new")
        self.assertEqual(target.read_text(), "old")
        self.assertEqual([p.name for p in self.tmp.iterdir()], ["state.json"])

    def test_crash_while_writing_keeps_the_old_file(self):
        target = self.tmp / "state.json"
        target.write_text("old")
        with mock.patch("durable.os.fsync", side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
            durable.atomic_write(target, "new content that must never appear half written")
        self.assertEqual(target.read_text(), "old")
        self.assertEqual(len(list(self.tmp.iterdir())), 1)

    @unittest.skipUnless(os.name == "posix", "permission bits are POSIX only")
    def test_permissions(self):
        durable.atomic_write(self.tmp / "secret.json", "{}")
        self.assertEqual((self.tmp / "secret.json").stat().st_mode & 0o777, 0o600)
        durable.atomic_write(self.tmp / "public.json", "{}", mode=0o644)
        self.assertEqual((self.tmp / "public.json").stat().st_mode & 0o777, 0o644)


class Nonces(TempDir):
    def store(self):
        lock = durable.ProcessLock(self.tmp / "census.lock").acquire()
        self.addCleanup(lock.release)
        return durable.NonceStore(self.tmp / "nonces.json", lock)

    def test_requires_the_lock(self):
        with self.assertRaises(RuntimeError):
            durable.NonceStore(self.tmp / "nonces.json", durable.ProcessLock(self.tmp / "x.lock")).reserve("r")

    def test_strictly_increasing_even_when_the_clock_goes_back(self):
        s = self.store()
        a = s.reserve("room-census", now_ms=5_000)
        b = s.reserve("room-census", now_ms=10)                  # clock rollback
        c = s.reserve("room-census", now_ms=10)
        self.assertEqual([a, b, c], ["5000", "5001", "5002"])

    def test_persisted_before_returning_and_per_room(self):
        s = self.store()
        s.reserve("room-census", now_ms=700)
        s.reserve("other-room", now_ms=3)
        data = json.loads((self.tmp / "nonces.json").read_text())
        self.assertEqual(data, {"room-census": 700, "other-room": 3})
        self.assertEqual(durable.NonceStore(self.tmp / "nonces.json", s.lock).reserve("room-census", now_ms=1), "701")

    def test_floor_from_the_server(self):
        self.assertEqual(self.store().reserve("room-census", floor=9_999, now_ms=10), "10000")

    def test_refuses_more_than_19_digits(self):
        with self.assertRaises(ValueError):
            self.store().reserve("room-census", now_ms=10 ** 19)

    def test_concurrent_processes_never_share_a_nonce(self):
        code = """
            import durable, sys
            lock_path, store_path = sys.argv[1], sys.argv[2]
            out = []
            for _ in range(25):
                lock = durable.ProcessLock(lock_path).acquire(blocking=True)
                try:
                    out.append(durable.NonceStore(store_path, lock).reserve("room-census", now_ms=1000))
                finally:
                    lock.release()
            print(" ".join(out), flush=True)
        """
        procs = [self.spawn(code, self.tmp / "census.lock", self.tmp / "nonces.json") for _ in range(6)]
        results = []
        for p in procs:
            out, err = p.communicate(timeout=120)
            self.assertEqual(p.returncode, 0, err)
            seq = [int(x) for x in out.split()]
            self.assertEqual(seq, sorted(seq))                   # increasing within each process
            results += seq
        self.assertEqual(sorted(results), list(range(1000, 1000 + 6 * 25)))   # unique, no gap, no reuse


if __name__ == "__main__":
    unittest.main()
