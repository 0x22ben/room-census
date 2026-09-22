#!/usr/bin/env python3
"""
durable.py: crash-safe primitives shared by room_census.py and flop_did.py (standard library only).

  ProcessLock(path)       exclusive lock held by the kernel: fcntl.flock on POSIX (production), msvcrt
                          on Windows (local development only). The kernel releases it when the process
                          dies, so a crash never leaves the census blocked. The lock file's existence
                          means nothing; only the kernel lock does.
  atomic_write(path, b)   writes a temporary file in the same directory, fsyncs it, then os.replace():
                          readers see the old content or the new one, never a truncated file.
  NonceStore(path, lock)  last nonce per room, persisted atomically. next = max(clock_ms, last + 1,
                          floor + 1): strictly increasing across restarts and clock rollbacks. Refuses to
                          work unless the caller holds the ProcessLock.
"""
import json
import os
import tempfile
import time
from pathlib import Path

try:
    import fcntl
    msvcrt = None
except ImportError:                      # Windows, local development only
    fcntl = None
    import msvcrt

MAX_NONCE = 10 ** 19 - 1                 # Technocore accepts 1 to 19 digits


class LockBusy(RuntimeError):
    """Another live process holds the lock."""


class ProcessLock:
    def __init__(self, path):
        self.path = Path(path)
        self.fd = None

    @property
    def held(self) -> bool:
        return self.fd is not None

    def acquire(self, blocking: bool = False, timeout: float = 30.0):
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        deadline = time.monotonic() + timeout
        while True:
            try:
                if fcntl:
                    fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
                else:
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                break
            except OSError:
                if blocking and not fcntl and time.monotonic() < deadline:
                    time.sleep(0.02)
                    continue
                os.close(fd)
                raise LockBusy(f"{self.path.name} is held by another process") from None
        self.fd = fd
        return self

    def release(self):
        if self.fd is None:
            return
        try:
            if fcntl:
                fcntl.flock(self.fd, fcntl.LOCK_UN)
            else:
                os.lseek(self.fd, 0, os.SEEK_SET)
                msvcrt.locking(self.fd, msvcrt.LK_UNLCK, 1)
        finally:
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self if self.held else self.acquire()

    def __exit__(self, *exc):
        self.release()


def _fsync_dir(directory: Path):
    if os.name != "posix":
        return
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write(path, data, mode=None):
    """Replaces `path` with `data` (bytes or str) atomically. `mode` defaults to the existing file's
    permissions, or 0o600 for a new file."""
    path = Path(path)
    if isinstance(data, str):
        data = data.encode("utf-8")
    if mode is None:
        mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
    _fsync_dir(path.parent)


class NonceStore:
    def __init__(self, path, lock: ProcessLock):
        self.path = Path(path)
        self.lock = lock

    def _load(self) -> dict:
        if not self.path.exists():
            return {}
        return json.loads(self.path.read_text(encoding="utf-8"))

    def last(self, room: str) -> int:
        return int(self._load().get(room, 0))

    def reserve(self, room: str, floor: int = 0, now_ms: int = None) -> str:
        """Returns a nonce strictly greater than every nonce previously reserved for `room` and than
        `floor` (for example the highest nonce already seen on the server), and persists it before
        returning, so it can never be handed out twice."""
        if not self.lock.held:
            raise RuntimeError("NonceStore.reserve requires the process lock")
        data = self._load()
        clock = int(time.time() * 1000) if now_ms is None else int(now_ms)
        nonce = max(clock, int(data.get(room, 0)) + 1, int(floor) + 1)
        if nonce > MAX_NONCE:
            raise ValueError("nonce exceeds 19 digits")
        data[room] = nonce
        atomic_write(self.path, json.dumps(data, sort_keys=True) + "\n")
        return str(nonce)
