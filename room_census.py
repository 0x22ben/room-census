#!/usr/bin/env python3
"""
room_census.py: Room Census, a twice-weekly census of public Technocore rooms, published as a signed
message (schema room-census/1).

Commands:
  python room_census.py            dry run: computes and prints the message, sends and stores nothing
  python room_census.py --publish  computes, signs and publishes in the room-census room
  --jitter H                       first waits a random time between 0 and H hours

Method (read-only use of public data):
  - Stable panel: publishable rooms from /rooms, plus the rooms of the 2 previous runs, plus rooms
    tracked on request. /rooms is only used to discover names (its counters are inconsistent).
  - Each room is read directly (latest 200 messages): window rate, text uniqueness after masking
    every token that contains a digit, share of recurring senders, share of the top sender, effective
    senders. The rate between two runs comes from last_seq (contiguous per room), as long as the
    room was not reset (generation).
  - Fixed, published classification: varied, mixed, repetitive (or quiet when too few messages).
  - Twin flag: a room sharing most of its senders with another measured room is flagged, not reclassified.
Security: room names and texts are untrusted data. No third-party text is ever quoted; only filtered
room names and numbers computed here are published.

Publication (--publish) is crash-safe: a kernel lock (durable.ProcessLock) serialises runs and nonces;
the signed census is written to a pending journal before it is sent; an interrupted run is resolved at
the next start by checking the room (finish the archive, or send the same signed payload again, or set
a stale journal aside); every local file is written atomically and the archive is deduplicated.

After publishing: the DID note is rewritten, then site/data is fully rebuilt from census.jsonl
(history.csv, latest.json, one frozen snapshot per run whose SHA-256 is in the signed message),
committed and pushed.
"""
import csv
import hashlib
import io
import json
import math
import random
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import durable
import flop_did

SERVER = "https://technocore.chat"
ROOM = "room-census"
OLD_ROOMS = ("flop-veille",)
DASHBOARD = "https://0x22ben.github.io/room-census"
SCHEMA = "room-census/1"
USER_AGENT = "room-census/1.0"
BASE = Path(__file__).resolve().parent
SITE_DIR = BASE / "site"
ARCHIVE = BASE / "census.jsonl"
STATE_FILE = BASE / "state.json"
JOURNAL = BASE / "pending_publication.json"      # a census signed but not yet known to be published
ABANDONED_DIR = BASE / "abandoned"               # stale journals moved aside, never deleted
PENDING_MAX_AGE_H = 6                            # an older unpublished census is not sent late
POST_RETRY_WAIT = 60
PENDING_SCHEMA = "room-census-pending/1"

WINDOW = 200
MIN_WINDOW = 30
MAX_PANEL = 80
PANEL_MEMORY = 2
SAFE_NAME = re.compile(r"^[a-z][a-z0-9_-]{2,31}$")
RANDOM_LIKE = re.compile(r"^[0-9a-f]{8,}$|\d{6,}")
# names that read like instructions or secrets; everything else is rendered as plain text anyway
DENY_WORDS = re.compile(r"ignore|instruct|prompt|jailbreak|passw|seed-?phrase|private-?key|mnemonic|http|www")
FETCH_TRIES = (0, 3, 10)          # seconds to wait before each attempt
PARTIAL_SHARE = 0.1               # a census is marked partial when more than 10% of attempted rooms fail
TEMPLATE_TOKEN = re.compile(r"\S*\d\S*")
TRAILING_TAG = re.compile(r"\s[·|]\s*\S+$")

REQUEST_RE = re.compile(r"(untrack|track)\s+(?:/?r/)?([a-z0-9][a-z0-9_-]{0,47})")
MAX_TRACKED = 5
MAX_PER_DID = 2
MAX_NEW_PER_PULSE = 3
TRACK_PULSES = 4

VARIED = {"unique_tpl": 0.8, "repeat_share": 0.2, "top_share": 0.3, "eff_senders": 5}
TWIN = {"jaccard": 0.5, "min_senders": 10}
REPETITIVE = {"unique_tpl": 0.5, "top_share": 0.8, "repeat_share": 0.05}
RISE = {"ratio": 2.0, "min_per_hour": 20}
METHOD = {
    "window_msgs": WINDOW,
    "per_hour": "rate over the latest 200 messages (a snapshot, can cover seconds in busy rooms)",
    "rate_interval": "messages posted between two runs divided by hours, from last_seq; the reliable rate",
    "unique_tpl": "share of distinct texts after masking every token that contains a digit and the room name",
    "repeat_share": "share of messages whose sender appears at least twice in the window",
    "top_share": "share of messages written by the most active sender",
    "eff_senders": "exp(Shannon entropy of senders): how many senders really carry the room",
    "twin": "the room shares at least half of its combined senders (Jaccard) with another measured room",
    "thresholds": {"varied_min": VARIED, "repetitive_if_any": REPETITIVE, "twin": TWIN, "rise": RISE},
    "limits": "200-message windows; did:key identities are free and texts can be varied, so every "
              "metric can be gamed; a script shared by many bots can look varied; unique text does not mean human; "
              "thresholds reviewed after 6 censuses",
}
CSV_FIELDS = ["at_utc", "census", "kind", "room", "per_hour", "signed", "unique", "senders", "window", "requested_by",
              "span_h", "last_seq", "generation", "rate_interval", "unique_tpl", "repeat_share", "top_share",
              "eff_senders", "class", "reason", "source", "twin", "twin_share"]


# ---------- reading Technocore ----------

def get_json(path: str):
    url = f"{SERVER}{path}{'&' if '?' in path else '?'}n={int(time.time() * 1000)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_ts(ts: str) -> float:
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


def is_publishable_name(name: str) -> bool:
    if not SAFE_NAME.match(name) or RANDOM_LIKE.search(name) or DENY_WORDS.search(name):
        return False
    return not name.startswith(("mb-", "p-", "e-", "d-")) and name not in ("events", ROOM, *OLD_ROOMS)


def template(text: str, room: str = "") -> str:
    t = re.sub(r"\s+", " ", str(text).strip().lower())
    if room:
        t = t.replace(room, "#room")
    return TEMPLATE_TOKEN.sub("#", TRAILING_TAG.sub("", t))


def classify(m):
    rep = []
    if m["unique_tpl"] < REPETITIVE["unique_tpl"]:
        rep.append(f"templated texts ({m['unique_tpl']:.0%} unique)")
    if m["top_share"] >= REPETITIVE["top_share"]:
        rep.append(f"one sender writes {m['top_share']:.0%}")
    if m["repeat_share"] < REPETITIVE["repeat_share"]:
        rep.append("one-time senders only")
    if rep:
        return "repetitive", rep
    mixed = []
    if m["unique_tpl"] < VARIED["unique_tpl"]:
        mixed.append(f"partly templated ({m['unique_tpl']:.0%} unique)")
    if m["repeat_share"] < VARIED["repeat_share"]:
        mixed.append(f"few regular senders ({m['repeat_share']:.0%})")
    if m["top_share"] > VARIED["top_share"]:
        mixed.append(f"one sender writes {m['top_share']:.0%}")
    if m["eff_senders"] < VARIED["eff_senders"]:
        mixed.append(f"about {m['eff_senders']:.0f} effective senders")
    if mixed:
        return "mixed", mixed
    return "varied", [f"{m['eff_senders']:.0f} effective senders; {m['repeat_share']:.0%} regular; varied texts"]


def fetch_room(name: str):
    """Reads a room with bounded retries. Raises the last error when every attempt failed."""
    err = None
    for wait in FETCH_TRIES:
        time.sleep(wait)
        try:
            data = get_json(f"/r/{name}?format=json&limit={WINDOW}")
            if not isinstance(data, dict) or not isinstance(data.get("messages", []), list):
                raise ValueError("invalid room payload")
            return data
        except Exception as e:
            err = e
    raise err


def failure_reason(e) -> str:
    if isinstance(e, urllib.error.HTTPError):
        return f"http {e.code}"
    if isinstance(e, (TimeoutError, urllib.error.URLError)):
        return "unreachable"
    if isinstance(e, ValueError):
        return "invalid payload"
    return "error"


def room_metrics(name: str):
    data = fetch_room(name)
    msgs = data.get("messages") or []
    m = {"room": name, "last_seq": data.get("last_seq"), "generation": data.get("generation"), "window": len(msgs)}
    span = parse_ts(msgs[-1]["ts"]) - parse_ts(msgs[0]["ts"]) if len(msgs) >= 2 else 0
    if len(msgs) < MIN_WINDOW or span <= 0:
        m.update({"class": "quiet", "reason": f"only {len(msgs)} recent messages"})
        return m
    n = len(msgs)
    who = Counter(str(x.get("from", "")) for x in msgs)
    probs = [c / n for c in who.values()]
    m.update({
        "per_hour": (n - 1) * 3600 / span,
        "span_h": span / 3600,
        "signed": sum(1 for x in msgs if str(x.get("from", "")).startswith("did:key:")) / n,
        "unique": len({re.sub(r"\s+", " ", str(x.get("text", "")).strip().lower()) for x in msgs}) / n,
        "unique_tpl": len({template(x.get("text", ""), name) for x in msgs}) / n,
        "senders": len(who),
        "repeat_share": sum(c for c in who.values() if c >= 2) / n,
        "top_share": max(who.values()) / n,
        "eff_senders": math.exp(-sum(p * math.log(p) for p in probs)),
    })
    cls, reasons = classify(m)
    m["class"], m["reason"] = cls, "; ".join(reasons)
    m["_senders"] = set(who)
    return m


def new_rooms_per_hour():
    msgs = get_json("/r/events?format=json&limit=200").get("messages") or []
    if len(msgs) < 2:
        return None
    span = parse_ts(msgs[-1]["ts"]) - parse_ts(msgs[0]["ts"])
    return (len(msgs) - 1) * 3600 / span if span > 0 else None


# ---------- archive and state ----------

class ArchiveCorrupt(RuntimeError):
    """census.jsonl contains a line that is not a JSON object. Nothing reads past it and nothing
    rewrites the file: an operator must inspect it, so no archived census can be lost silently."""


def read_archive_lines():
    """Every archived record, pilot run included, in file order. Raises ArchiveCorrupt on any line
    that is not a JSON object, so the archive is never rewritten from a partial reading."""
    if not ARCHIVE.exists():
        return []
    records = []
    for n, line in enumerate(ARCHIVE.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError:
            raise ArchiveCorrupt(f"census.jsonl line {n} is not valid JSON; the archive was left untouched") from None
        if not isinstance(record, dict):
            raise ArchiveCorrupt(f"census.jsonl line {n} is not a JSON object; the archive was left untouched")
        records.append(record)
    return records


def read_archive():
    """Public censuses only: the pilot run (older method, no schema) stays in the archive but is never
    published or compared against. Records are returned untouched so snapshots keep their signed hash."""
    return [r for r in read_archive_lines() if r.get("schema")]


def archive_append(record) -> bool:
    """Adds `record` to the archive once. The whole file is rewritten atomically, so a crash leaves
    either the previous archive or the new one. Returns False when the census is already archived."""
    records = read_archive_lines()
    if any(r.get("sha256") == record["sha256"] for r in records):
        return False
    lines = [json.dumps(r, ensure_ascii=False) for r in records + [record]]
    durable.atomic_write(ARCHIVE, "\n".join(lines) + "\n")
    return True


def norm_class(c):
    return "varied" if c == "diverse" else c


def load_state():
    if STATE_FILE.exists():
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    else:
        state = {}
    state.setdefault("last_seq", 0)
    state.setdefault("generation", None)
    state.setdefault("tracked", [])
    for t in state["tracked"]:
        t.setdefault("pulses_left", TRACK_PULSES)
    return state


def short_did(did: str) -> str:
    return f"{did[8:12]}..{did[-4:]}"


def apply_requests(state, own_did: str):
    """Reads signed replies in the census room. A valid request is a message containing only
    'track <room>' or 'untrack <room>'. Occupied slots are never taken back from their requester."""
    data = get_json(f"/r/{ROOM}?format=json&limit=200&since={state['last_seq']}")
    if state["generation"] is not None and data.get("generation") != state["generation"]:
        state["last_seq"] = 0
        data = get_json(f"/r/{ROOM}?format=json&limit=200&since=0")
    state["generation"] = data.get("generation")
    tracked, accepted, refused = list(state["tracked"]), [], 0
    for m in data.get("messages") or []:
        state["last_seq"] = max(state["last_seq"], int(m["seq"]))
        sender = str(m.get("from", ""))
        if not m.get("sig") or not sender.startswith("did:key:") or sender == own_did:
            continue
        req = REQUEST_RE.fullmatch(str(m.get("text", "")).strip().lower())
        if not req:
            continue
        action, name = req.groups()
        if action == "untrack":
            tracked = [t for t in tracked if not (t["room"] == name and t["did"] == sender)]
            accepted = [a for a in accepted if a != f"{name} for {short_did(sender)}"]
            continue
        if any(t["room"] == name for t in tracked):
            continue
        if (not is_publishable_name(name) or len(accepted) >= MAX_NEW_PER_PULSE or len(tracked) >= MAX_TRACKED
                or sum(t["did"] == sender for t in tracked) >= MAX_PER_DID
                or len(get_json(f"/r/{name}?format=json&limit=2").get("messages") or []) < 2):
            refused += 1
            continue
        tracked.append({"room": name, "did": sender, "seq": int(m["seq"]), "pulses_left": TRACK_PULSES})
        accepted.append(f"{name} for {short_did(sender)}")
    state["tracked"] = tracked
    return state, accepted, refused


# ---------- computing a census run ----------

def best_rate(r):
    return r.get("rate_interval") if r.get("rate_interval") is not None else r.get("per_hour")


def build_census(state):
    now = datetime.now(timezone.utc)
    records = read_archive()
    prev = records[-1] if records else None
    prev_rooms = {r["room"]: r for r in (prev or {}).get("rooms", [])}
    tracked = {t["room"]: t for t in state["tracked"]}

    listing = get_json(f"/rooms?format=json&limit={WINDOW}")
    listed = [str(r.get("room", "")) for r in listing.get("rooms", [])]
    eligible = [n for n in listed if is_publishable_name(n)]
    remembered = []
    for rec in reversed(records[-PANEL_MEMORY:]):
        for r in rec.get("rooms", []):
            if is_publishable_name(r["room"]) and r.get("class") != "quiet" and r["room"] not in remembered:
                remembered.append(r["room"])
    # deterministic order, deduplicated before truncation: tracked, previous panel, newly listed
    panel = {}
    for name in tracked:
        panel.setdefault(name, "tracked")
    for name in remembered:
        panel.setdefault(name, "panel")
    for name in eligible:
        panel.setdefault(name, "listed")
    attempted = list(panel.items())[:MAX_PANEL]

    rooms, failures = [], []
    for name, source in attempted:
        try:
            m = room_metrics(name)
        except Exception as e:
            failures.append({"room": name, "source": source, "reason": failure_reason(e)})
            continue
        m["source"] = source
        if name in tracked:
            m["requested_by"] = tracked[name]["did"]
        p = prev_rooms.get(name)
        if (p and p.get("last_seq") is not None and m.get("last_seq") is not None
                and p.get("generation") == m.get("generation") and m["last_seq"] >= p["last_seq"]):
            hours = (now.timestamp() - parse_ts(prev["at_utc"])) / 3600
            if hours > 0:
                m["rate_interval"] = (m["last_seq"] - p["last_seq"]) / hours
        rooms.append(m)
        time.sleep(0.2)
    flag_twins(rooms)
    record = {
        "schema": SCHEMA,
        "census": len(records) + 1,
        "at_utc": now.isoformat(),
        "prev_at_utc": prev["at_utc"] if prev else None,
        "new_rooms_per_hour": new_rooms_per_hour(),
        "method": METHOD,
        "rooms": rooms,
        "failures": failures,
        "coverage": {
            "listed": len(listed), "eligible": len(eligible), "excluded": len(listed) - len(eligible),
            "remembered": len(remembered), "tracked": len(tracked), "attempted": len(attempted),
            "measured": len(rooms), "failed": len(failures), "dropped_by_limit": max(0, len(panel) - MAX_PANEL),
            "interval_hours": round((now.timestamp() - parse_ts(prev["at_utc"])) / 3600, 2) if prev else None,
        },
        "partial": bool(attempted) and len(failures) / len(attempted) > PARTIAL_SHARE,
    }
    record["summary"] = summarize(rooms)
    record["changes"] = changes(record, prev)
    return record


def flag_twins(rooms):
    """Flags rooms that share most of their senders with another measured room; the sender sets are
    used here only and never stored."""
    sets = {r["room"]: r.pop("_senders", set()) for r in rooms}
    for r in rooms:
        a = sets[r["room"]]
        if len(a) < TWIN["min_senders"]:
            continue
        best, name = 0.0, None
        for other, b in sets.items():
            if other == r["room"] or len(b) < TWIN["min_senders"]:
                continue
            j = len(a & b) / len(a | b)
            if j > best:
                best, name = j, other
        if best >= TWIN["jaccard"]:
            r["twin"], r["twin_share"] = name, len(a & sets[name]) / len(a)


def summarize(rooms):
    """Room counts use every classified room. Traffic shares use ONLY rooms with a rate measured
    between two censuses (rate_interval): window estimates are never mixed into them. Without any
    interval rate (the first census) the shares are None and the census is a baseline."""
    active = [r for r in rooms if norm_class(r.get("class")) in ("varied", "mixed", "repetitive")]
    timed = [r for r in active if r.get("rate_interval") is not None]
    total = sum(r["rate_interval"] for r in timed)
    out = {"active": len(active), "interval_rooms": len(timed), "baseline": not timed or total <= 0}
    for c in ("varied", "mixed", "repetitive"):
        out[c] = sum(1 for r in active if norm_class(r["class"]) == c)
        out[f"{c}_share"] = (None if out["baseline"]
                             else sum(r["rate_interval"] for r in timed if norm_class(r["class"]) == c) / total)
    return out


def changes(record, prev):
    """What moved since the previous census: class changes, reliable rate swings, rooms gone quiet."""
    if not prev:
        return {}
    before = {r["room"]: r for r in prev.get("rooms", [])}
    moved, gone = [], []
    for r in record["rooms"]:
        p = before.get(r["room"])
        if not p:
            continue
        a, b = norm_class(p.get("class")), norm_class(r.get("class"))
        if a != b and "quiet" not in (a, b):
            moved.append({"room": r["room"], "from": a, "to": b})
        elif b == "quiet" and a != "quiet":
            gone.append(r["room"])
    up, down = trends(record, prev)
    return {"class_changes": moved, "went_quiet": gone,
            "rising": [{"room": n, "ratio": k} for k, n in up], "falling": [{"room": n, "ratio": k} for k, n in down]}


def trends(record, prev):
    """Reliable rises and drops: compares between-run rates from one interval to the next."""
    if not prev:
        return [], []
    before = {r["room"]: r for r in prev.get("rooms", [])}
    up, down = [], []
    for r in record["rooms"]:
        a, b = before.get(r["room"], {}).get("rate_interval"), r.get("rate_interval")
        if not a or not b:
            continue
        if b / a >= RISE["ratio"] and b >= RISE["min_per_hour"]:
            up.append((b / a, r["room"]))
        elif a / b >= RISE["ratio"] and a >= RISE["min_per_hour"]:
            down.append((b / a, r["room"]))
    return sorted(up, reverse=True), sorted(down)


def snapshot_bytes(record) -> bytes:
    public = {k: v for k, v in record.items() if k not in ("text", "signed_in", "snapshot", "sha256")}
    return json.dumps(public, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def snapshot_path(record) -> str:
    return f"data/snapshots/{datetime.fromisoformat(record['at_utc']):%Y-%m-%dT%H%MZ}.json"


def fmt_rate(x) -> str:
    if x is None:
        return "n/a"
    return f"{x / 1000:.1f}k/h" if x >= 1000 else f"{x:.0f}/h"


def shown_rate(r) -> str:
    """Interval rates as is; window estimates marked with ~ so the two are never confused."""
    return fmt_rate(r["rate_interval"]) if r.get("rate_interval") is not None else "~" + fmt_rate(r.get("per_hour"))


def build_message(record, prev, accepted, refused, tracked):
    """One line, pipe-separated so agents can split it; empty segments are omitted."""
    rooms = [r for r in record["rooms"] if r.get("class") != "quiet"]
    rank = lambda r: (r.get("rate_interval") is not None, best_rate(r) or 0)
    by = lambda c: sorted((r for r in rooms if norm_class(r["class"]) == c), key=rank, reverse=True)
    var, rep = by("varied"), by("repetitive")
    s = record["summary"]
    at = datetime.fromisoformat(record["at_utc"])
    cov = record.get("coverage", {})
    head = f"Room Census #{record['census']} {at:%Y-%m-%d %H:%M} UTC" + (" (partial)" if record.get("partial") else "")
    counts = f"{s['active']} active rooms: {s['varied']} varied, {s['mixed']} mixed, {s['repetitive']} repetitive"
    if s["baseline"]:
        traffic = "baseline census, traffic shares start with the next census"
    else:
        traffic = (f"repetitive rooms carried {s['repetitive_share']:.0%} of measured traffic over "
                   f"{cov.get('interval_hours', 0):.0f}h ({s['interval_rooms']} rooms with an interval rate)")
    parts = [head, f"{counts}; {traffic}",
             f"Coverage: {cov.get('measured', len(record['rooms']))} measured, {cov.get('failed', 0)} failed"]
    if var:
        parts.append("Top varied (msgs/h, unique, regular): " + "; ".join(
            f"{r['room']} {shown_rate(r)} {r['unique_tpl']:.0%} {r['repeat_share']:.0%}" for r in var[:5]))
    if rep:
        parts.append("Top repetitive: " + "; ".join(f"{r['room']} {shown_rate(r)} ({r['reason']})" for r in rep[:3]))
    up, down = trends(record, prev)
    if up or down:
        parts.append("Change: " + "; ".join([f"{n} x{k:.1f}" for k, n in up[:3]] + [f"{n} x{k:.2f}" for k, n in down[:3]]))
    twins = [r for r in rooms if r.get("twin")]
    if twins:
        parts.append("Twins: " + "; ".join(f"{r['room']} ~ {r['twin']}" for r in twins[:3]))
    if record.get("new_rooms_per_hour") is not None:
        parts.append(f"New rooms ~{record['new_rooms_per_hour']:.0f}/h")
    if tracked:
        cls = {r["room"]: norm_class(r.get("class")) for r in record["rooms"]}
        parts.append("Tracked: " + "; ".join(f"{t['room']} {cls.get(t['room'], 'n/a')} (by {short_did(t['did'])})" for t in tracked))
    if accepted or refused:
        parts.append(f"Requests: accepted {', '.join(accepted) or 'none'}, refused {refused}")
    parts.append(f"sha256:{record['sha256']} {DASHBOARD}/{record['snapshot']}")
    parts.append(f"Method: {DASHBOARD}/#method")
    parts.append('Track a room: signed "track <room>"')
    return " | ".join(parts)


# ---------- side outputs ----------

def refresh_did_note(did: str):
    """Rewrites the public DID note (Technocore /patterns.md section 3 convention)."""
    fp = hashlib.sha256(did.encode()).hexdigest()[:16]
    value = (f"{did} mailbox:{ROOM} data:{DASHBOARD}/data/latest.json schema:{SCHEMA} commands:track,untrack "
             f"schedule:mon,thu about: Room Census, a twice-weekly signed census of public Technocore rooms "
             f"(varied, mixed, repetitive). dashboard: {DASHBOARD}")
    url = f"{SERVER}/kv/did-{fp[:2]}/{fp[2:]}/set/{urllib.parse.quote(value, safe='')}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        print("DID note:", resp.read().decode("utf-8", "replace").strip().splitlines()[-1])


def rnd(v):
    return round(v, 4) if isinstance(v, float) else v


def public_rooms(rec):
    return [{**{k: rnd(v) for k, v in r.items() if not k.startswith("_")}, "class": norm_class(r.get("class"))}
            for r in rec.get("rooms", [])]


def public_view(rec, number, own_did):
    s = summarize(rec.get("rooms", []))          # always recomputed with the current, comparable rules
    at = datetime.fromisoformat(rec["at_utc"])
    cov = rec.get("coverage") or {}
    share = lambda k: s[k] or 0.0
    return {
        "census": number, "active": s["active"], "varied": s["varied"], "mixed": s["mixed"], "repetitive": s["repetitive"],
        "baseline": s["baseline"], "interval_rooms": s["interval_rooms"],
        "interval_hours": cov.get("interval_hours"), "measured": cov.get("measured", len(rec.get("rooms", []))),
        "failed": cov.get("failed", 0), "partial": bool(rec.get("partial")),
        "room_pct": round(s["repetitive"] / s["active"] * 100) if s["active"] else 0,
        "repetitive_pct": round(share("repetitive_share") * 100), "varied_pct": round(share("varied_share") * 100),
        "repetitive_pct_raw": share("repetitive_share"), "varied_pct_raw": share("varied_share"),
        "mixed_pct_raw": share("mixed_share"),
        "new_rooms": f"{rec['new_rooms_per_hour']:.0f}" if rec.get("new_rooms_per_hour") is not None else "n/a",
        "date_short": f"{at:%d %b %Y}", "date_long": f"{at:%a %d %b %Y, %H:%M} UTC",
        "snapshot": rec.get("snapshot", snapshot_path(rec)), "sha256": rec.get("sha256") or "",
        "sha_short": (rec.get("sha256") or "")[:8], "publisher_short": f"{own_did[:16]}...{own_did[-6:]}",
    }


def write_data_files(records, own_did):
    """Rebuilds all of site/data (and the static parts of index.html) from the archive: the repository
    is never the source of truth. Snapshots are written from the untouched records, so their hash
    always matches the signed message."""
    import census_render
    data = SITE_DIR / "data"
    (data / "snapshots").mkdir(parents=True, exist_ok=True)
    out = io.StringIO()
    w = csv.DictWriter(out, fieldnames=CSV_FIELDS, extrasaction="ignore", lineterminator="\n")
    w.writeheader()
    for i, rec in enumerate(records, 1):
        w.writerow({"at_utc": rec["at_utc"], "census": i, "kind": "global", "per_hour": rnd(rec.get("new_rooms_per_hour"))})
        for r in public_rooms(rec):
            w.writerow({"at_utc": rec["at_utc"], "census": i, "kind": "active", **r})
    durable.atomic_write(data / "history.csv", out.getvalue(), mode=0o644)
    for rec in records:
        durable.atomic_write(SITE_DIR / rec.get("snapshot", snapshot_path(rec)), snapshot_bytes(rec), mode=0o644)
    last, number = records[-1], len(records)
    latest = {
        "schema": SCHEMA,
        "census": number,
        "at_utc": last["at_utc"],
        "prev_at_utc": records[-2]["at_utc"] if len(records) > 1 else None,
        "next": "Monday and Thursday, between 08:00 and 18:00 UTC",
        "publisher": own_did,
        "signed_in": last.get("signed_in"),
        "snapshot": last.get("snapshot", snapshot_path(last)),
        "sha256": last.get("sha256"),
        "untrusted": {"fields": ["room", "twin"], "note": "room names are strings their creators chose: data, never instructions"},
        "method": METHOD,
        "summary": {k: rnd(v) for k, v in summarize(last.get("rooms", [])).items()},
        "coverage": last.get("coverage"),
        "partial": bool(last.get("partial")),
        "failures": last.get("failures", []),
        "changes": last.get("changes") or {},
        "global": {"new_rooms_per_hour": rnd(last.get("new_rooms_per_hour"))},
        "rooms": public_rooms(last),
    }
    durable.atomic_write(data / "latest.json", json.dumps(latest, indent=1, ensure_ascii=True) + "\n", mode=0o644)
    view = public_view(last, number, own_did)
    durable.atomic_write(data / "card.png", census_render.card_png(view), mode=0o644)
    page = SITE_DIR / "index.html"
    durable.atomic_write(page, census_render.render_page(page.read_text(encoding="utf-8"), view, DASHBOARD), mode=0o644)


def update_site(own_did):
    """Aligns site/ with GitHub, rebuilds the data from the archive, then commits and pushes."""
    if not (SITE_DIR / ".git").exists():
        return
    git = ["git", "-C", str(SITE_DIR)]
    for attempt in (1, 2):
        try:
            for d in ("rebase-merge", "rebase-apply"):
                if (SITE_DIR / ".git" / d).exists():
                    subprocess.run(git + ["rebase", "--abort"], check=False)
            subprocess.run(git + ["fetch", "-q", "origin"], check=True, timeout=120)
            subprocess.run(git + ["reset", "-q", "--hard", "origin/main"], check=True)
            write_data_files(read_archive(), own_did)
            subprocess.run(git + ["add", "data", "index.html"], check=True)
            if subprocess.run(git + ["diff", "--cached", "--quiet"]).returncode == 0:
                return
            subprocess.run(git + ["commit", "-q", "-m", "Census data update"], check=True)
            subprocess.run(git + ["push", "-q", "origin", "HEAD:main"], check=True, timeout=120)
            print("Site updated.")
            return
        except Exception as e:
            print(f"Site update, attempt {attempt} failed:", e)


# ---------- robust publication ----------
#
# Every step below runs under durable.ProcessLock (a kernel lock released if the process dies).
#   1. recover_pending(): finish or safely resolve a census left by an interrupted run;
#   2. publish_census(): reserve a nonce, sign, write the pending journal atomically, send;
#   3. finalize(): archive (idempotent), state, proof, and only then remove the journal.
# A signed payload is sent again only when the room shows it did not land, and always with the same
# nonce and signature, so Technocore itself refuses a second copy.

class PublishUncertain(RuntimeError):
    """The census may or may not be published; the journal is kept for the next run to resolve."""


def next_state(state):
    """State to persist once the census is published: every tracked room uses one of its runs."""
    out = json.loads(json.dumps(state))
    for t in out["tracked"]:
        t["pulses_left"] -= 1
    out["tracked"] = [t for t in out["tracked"] if t["pulses_left"] > 0]
    return out


class RoomCheckFailed(RuntimeError):
    """What we published in the census room cannot be established; the caller must not guess."""


class InvalidJournal(ValueError):
    """The pending journal does not match the expected schema."""


HEX64 = re.compile(r"^[0-9a-f]{64}$")
SIG_RE = re.compile(r"^[A-Za-z0-9_-]{85}[AQgw]$")


def get_text(path: str) -> str:
    url = f"{SERVER}{path}{'&' if '?' in path else '?'}n={int(time.time() * 1000)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8")


def room_export(room=ROOM):
    """Every record Technocore still retains for the room (GET /r/<room>/export, raw JSONL), not only
    the latest page of messages. Raises RoomCheckFailed if it cannot be read or parsed."""
    try:
        body = get_text(f"/r/{room}/export")
    except Exception as e:
        raise RoomCheckFailed(f"room export unreachable ({type(e).__name__})") from None
    records = []
    for n, line in enumerate(body.splitlines(), 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError:
            raise RoomCheckFailed(f"room export line {n} is not JSON") from None
        if not isinstance(record, dict):
            raise RoomCheckFailed(f"room export line {n} is not an object")
        records.append(record)
    return records


def publication_status(pending) -> str:
    """"published" or "absent", from the full retained export. Absence is only asserted when the
    retained history reaches back to before the census was signed; otherwise RoomCheckFailed."""
    records = room_export(pending["room"])
    for r in records:
        if (r.get("from") == pending["did"] and str(r.get("nonce")) == pending["nonce"]
                and r.get("sig") == pending["sig"]):
            return "published"
    if not records:
        raise RoomCheckFailed("the room export is empty; absence cannot be proven")
    try:
        oldest = min(parse_ts(r["ts"]) for r in records)
    except (KeyError, TypeError, ValueError):
        raise RoomCheckFailed("the room export has records without a valid timestamp") from None
    if oldest > parse_ts(pending["created_utc"]):
        raise RoomCheckFailed("the retained history starts after this census was signed; absence cannot be proven")
    return "absent"


def landed(pending):
    """True (published), False (proven absent) or None (cannot be established)."""
    try:
        return publication_status(pending) == "published"
    except RoomCheckFailed as e:
        print(f"Room check impossible: {e}", flush=True)
        return None


def is_published(pending) -> bool:
    return landed(pending) is True


def highest_seen_nonce(did) -> int:
    """Highest nonce of ours in the whole retained export: a floor for the next nonce if nonces.json
    was lost. Raises RoomCheckFailed rather than guessing 0."""
    nonces = [int(r["nonce"]) for r in room_export(ROOM)
              if r.get("from") == did and str(r.get("nonce", "")).isdigit()]
    return max(nonces, default=0)


def validate_pending(p):
    """Explicit schema check of the pending journal (independent of `assert`, so it holds under -O)."""
    if not isinstance(p, dict):
        raise InvalidJournal("the journal is not a JSON object")
    problems = []

    def need(ok, field):
        if not ok:
            problems.append(field)
    need(p.get("schema") == PENDING_SCHEMA, "schema")
    need(isinstance(p.get("run_id"), str) and bool(HEX64.match(p["run_id"])), "run_id")
    try:
        parse_ts(p["created_utc"])
        need(True, "created_utc")
    except (KeyError, TypeError, ValueError, AttributeError):
        need(False, "created_utc")
    need(p.get("room") == ROOM, "room")
    need(isinstance(p.get("did"), str) and p["did"].startswith("did:key:z6Mk") and len(p["did"]) == 56, "did")
    need(isinstance(p.get("nonce"), str) and bool(flop_did.NONCE_RE.match(p["nonce"])), "nonce")
    need(isinstance(p.get("sig"), str) and bool(SIG_RE.match(p["sig"])), "sig")
    need(isinstance(p.get("text"), str) and 0 < len(p["text"]) <= 4096 and "\n" not in p["text"], "text")
    rec = p.get("record")
    need(isinstance(rec, dict) and rec.get("sha256") == p.get("run_id") and type(rec.get("census")) is int
         and isinstance(rec.get("rooms"), list), "record")
    st = p.get("state")
    need(isinstance(st, dict) and isinstance(st.get("tracked"), list) and type(st.get("last_seq")) is int, "state")
    need(type(p.get("attempts")) is int and p["attempts"] >= 0, "attempts")
    if problems:
        raise InvalidJournal("invalid pending journal: " + ", ".join(problems))
    return p


def write_journal(pending):
    durable.atomic_write(JOURNAL, json.dumps(pending, ensure_ascii=False, sort_keys=True))


def deliver(pending) -> bool:
    """Sends the signed payload. Returns True once the message is known to be in the room. Never sends
    a second time without first checking that the first attempt did not land."""
    for attempt in (1, 2):
        if attempt > 1:
            time.sleep(POST_RETRY_WAIT)
            state = landed(pending)
            if state is True:
                return True
            if state is None:            # absence not proven: never send blindly
                return False
        pending["attempts"] = pending.get("attempts", 0) + 1
        write_journal(pending)
        try:
            status, body = flop_did.post_signed(pending["room"], pending["did"], pending["sig"],
                                                pending["nonce"], pending["text"])
            pending["http_status"], pending["server_response"] = status, body[:2000]
            return True
        except flop_did.PublishRefused as e:
            # a refusal can mean "already stored" (same nonce): the room is the only authority
            print(f"Publishing refused ({e}); checking the room", flush=True)
        except Exception as e:
            print(f"Publishing outcome unknown ({type(e).__name__}: {e}); checking the room", flush=True)
        state = landed(pending)
        if state is True:
            return True
        if state is None:
            return False
    return False


def finalize(pending):
    """Idempotent: archive the census once, persist the state, record the proof, drop the journal."""
    record = dict(pending["record"])
    record["text"] = pending["text"]
    record["signed_in"] = {"room": pending["room"], "nonce": pending["nonce"]}
    archive_append(record)
    durable.atomic_write(STATE_FILE, json.dumps(pending["state"], ensure_ascii=False, indent=1))
    flop_did.record_proof(pending["room"], pending["did"], pending["sig"], pending["nonce"], pending["text"],
                          pending.get("http_status"), pending.get("server_response"))
    JOURNAL.unlink(missing_ok=True)
    return record


def recover_pending():
    """Resolves a journal left by an interrupted run. Returns "none" (no journal), "recovered" (the
    pending census is now published and archived), "abandoned" (stale and never published: moved
    aside) or "unresolved" (keep the journal, publish nothing new)."""
    if not JOURNAL.exists():
        return "none"
    try:
        pending = validate_pending(json.loads(JOURNAL.read_text(encoding="utf-8")))
    except ValueError as e:              # JSON errors and InvalidJournal
        print(f"The pending journal is unusable ({e}); it is kept for inspection and nothing is published", flush=True)
        return "unresolved"
    state = landed(pending)
    if state is None:
        print("The pending census cannot be checked; the journal is kept", flush=True)
        return "unresolved"
    if state:
        finalize(pending)
        print(f"Recovered census #{pending['record']['census']}: it was published, archive completed", flush=True)
        return "recovered"
    age_h = (time.time() - parse_ts(pending["created_utc"])) / 3600
    if age_h > PENDING_MAX_AGE_H:
        ABANDONED_DIR.mkdir(exist_ok=True)
        target = ABANDONED_DIR / f"{pending['created_utc'][:19].replace(':', '')}.json"
        JOURNAL.replace(target)
        print(f"A census signed {age_h:.0f} h ago was never published; moved to {target.name}", flush=True)
        return "abandoned"
    if deliver(pending):
        finalize(pending)
        print(f"Recovered census #{pending['record']['census']}: sent again with the same nonce", flush=True)
        return "recovered"
    return "unresolved"


def publish_census(state, record, text, lock):
    """Journal first, then send, then finalize. Raises PublishUncertain when the outcome is unknown."""
    if any(r.get("sha256") == record["sha256"] for r in read_archive_lines()):
        raise RuntimeError("this census is already archived; refusing to publish it twice")
    did = flop_did.DID_FILE.read_text(encoding="utf-8").strip()
    nonce = durable.NonceStore(flop_did.NONCE_FILE, lock).reserve(ROOM, floor=highest_seen_nonce(did))
    did, sig, nonce, _ = flop_did.sign(ROOM, text, nonce=nonce)
    pending = {"schema": PENDING_SCHEMA, "run_id": record["sha256"], "created_utc": datetime.now(timezone.utc).isoformat(),
               "room": ROOM, "did": did, "nonce": nonce, "sig": sig, "text": text,
               "record": record, "state": next_state(state), "attempts": 0}
    write_journal(validate_pending(pending))
    if not deliver(pending):
        raise PublishUncertain(f"census #{record['census']} (nonce {nonce}) may not be published; journal kept")
    return finalize(pending)


def side_steps(own_did):
    for step in (lambda: refresh_did_note(own_did), lambda: update_site(own_did)):
        try:
            step()
        except Exception as e:
            print("Side step failed:", e)


# ---------- main ----------

def prepare(own_did):
    state = load_state()
    state, accepted, refused = apply_requests(state, own_did)
    record = build_census(state)
    record["snapshot"] = snapshot_path(record)
    record["sha256"] = hashlib.sha256(snapshot_bytes(record)).hexdigest()
    records = read_archive()
    text = build_message(record, records[-1] if records else None, accepted, refused, state["tracked"])
    return state, record, text


def main():
    args = sys.argv[1:]
    publish = "--publish" in args
    if "--jitter" in args:
        delay = random.uniform(0, float(args[args.index("--jitter") + 1]) * 3600)
        print(f"Random wait: {delay / 3600:.2f} h", flush=True)
        time.sleep(delay)
    own_did = flop_did.DID_FILE.read_text(encoding="utf-8").strip()
    if not publish:
        state, record, text = prepare(own_did)
        print(text)
        print(f"\n({len(text)} characters, {len(record['rooms'])} rooms)")
        _, _, _, url = flop_did.sign(ROOM, text)
        print(f"Signed URL: {len(url)} bytes (limit ~16 KB). Dry run: nothing was sent or stored.")
        return record
    try:
        lock = durable.ProcessLock(flop_did.LOCK_FILE).acquire()
    except durable.LockBusy as e:
        print(f"Another run holds the lock ({e}); nothing done", flush=True)
        return None
    with lock:
        try:
            outcome = recover_pending()
            if outcome == "unresolved":
                sys.exit(1)
            if outcome == "recovered":
                side_steps(own_did)          # the interrupted run never reached them
                return None                  # one census per run: the recovered one
            try:
                state, record, text = prepare(own_did)
            except ArchiveCorrupt:
                raise
            except Exception as e:
                print("Computation failed, retrying in 10 minutes:", e, flush=True)
                time.sleep(600)
                state, record, text = prepare(own_did)
            print(text)
            print(f"\n({len(text)} characters, {len(record['rooms'])} rooms)")
            record = publish_census(state, record, text, lock)
        except (ArchiveCorrupt, RoomCheckFailed, PublishUncertain) as e:
            print(f"Stopped without publishing anything new: {e}", flush=True)
            sys.exit(1)
        side_steps(own_did)
    return record


if __name__ == "__main__":
    main()
