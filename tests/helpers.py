"""Shared test helpers: an in-memory stand-in for technocore.chat, so no test touches the network."""
import json
from datetime import datetime, timedelta, timezone

import room_census as rc


def iso(minutes: float, base: str = "2026-09-24T10:00:00+00:00") -> str:
    return (datetime.fromisoformat(base) + timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")


def messages(n=60, senders=10, text="message number {i} about topic {k}", room="", minutes_apart=1.0, did=True):
    """n messages from `senders` rotating senders; texts vary unless the template ignores {i}/{k}."""
    out = []
    for i in range(n):
        k = i % senders
        sender = f"did:key:z6Mk{'A' * 40}{k:04d}" if did else f"nick{k}"
        out.append({"seq": i + 1, "ts": iso(i * minutes_apart), "from": sender,
                    "text": text.format(i=i, k=k, room=room), "sig": "x" * 86 if did else None})
    return out


class FakeTechnocore:
    """Answers get_json() paths from dictionaries; records every path requested."""

    def __init__(self, listing=(), rooms=None, events=None, fail=(), veille=None):
        self.listing = [{"room": r} for r in listing]
        self.rooms = rooms or {}
        self.events = events if events is not None else [{"ts": iso(i), "text": f"created r{i}"} for i in range(20)]
        self.fail = dict.fromkeys(fail, TimeoutError("simulated timeout")) if not isinstance(fail, dict) else fail
        self.veille = veille or {"generation": 0, "messages": []}
        self.calls = []

    def __call__(self, path):
        self.calls.append(path)
        if path.startswith("/rooms"):
            return {"rooms": self.listing}
        if path.startswith("/r/events"):
            return {"messages": self.events}
        name = path.split("/")[2].split("?")[0]
        if name == rc.ROOM:
            return self.veille
        if name in self.fail:
            raise self.fail[name]
        data = self.rooms.get(name, {"messages": []})
        return json.loads(json.dumps(data))


def install(test_case, fake):
    """Routes room_census network calls to `fake` and removes sleeps, restoring both afterwards."""
    orig_get, orig_sleep = rc.get_json, rc.time.sleep
    rc.get_json = fake
    rc.time.sleep = lambda s: None
    test_case.addCleanup(setattr, rc, "get_json", orig_get)
    test_case.addCleanup(setattr, rc.time, "sleep", orig_sleep)
