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
  - Fixed, published classification: diverse, mixed, repetitive (or quiet when too few messages).
Security: room names and texts are untrusted data. No third-party text is ever quoted; only filtered
room names and numbers computed here are published.

After publishing: the DID note is rewritten, then site/data is fully rebuilt from census.jsonl
(history.csv, latest.json, one frozen snapshot per run whose SHA-256 is in the signed message),
committed and pushed.
"""
import csv
import hashlib
import json
import math
import random
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

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

WINDOW = 200
MIN_WINDOW = 30
MAX_PANEL = 80
PANEL_MEMORY = 2
SAFE_NAME = re.compile(r"^[a-z][a-z0-9_-]{2,31}$")
RANDOM_LIKE = re.compile(r"^[0-9a-f]{8,}$|\d{6,}")
DENY_WORDS = re.compile(r"ignore|instruct|prompt|system|admin|send|wallet|airdrop|claim|http|www|passw|seed|token|key")
TEMPLATE_TOKEN = re.compile(r"\S*\d\S*")
TRAILING_TAG = re.compile(r"\s[·|]\s*\S+$")

REQUEST_RE = re.compile(r"(untrack|track)\s+(?:/?r/)?([a-z0-9][a-z0-9_-]{0,47})")
MAX_TRACKED = 5
MAX_PER_DID = 2
MAX_NEW_PER_PULSE = 3
TRACK_PULSES = 4

DIVERSE = {"unique_tpl": 0.8, "repeat_share": 0.2, "top_share": 0.3, "eff_senders": 5}
REPETITIVE = {"unique_tpl": 0.5, "top_share": 0.8, "repeat_share": 0.05}
RISE = {"ratio": 2.0, "min_per_hour": 20}
METHOD = {
    "window_msgs": WINDOW,
    "per_hour": "rate over the latest 200 messages (a snapshot, can cover seconds in busy rooms)",
    "rate_interval": "messages posted between two runs divided by hours, from last_seq; the reliable rate",
    "unique_tpl": "share of distinct texts after masking every token that contains a digit",
    "repeat_share": "share of messages whose sender appears at least twice in the window",
    "top_share": "share of messages written by the most active sender",
    "eff_senders": "exp(Shannon entropy of senders): how many senders really carry the room",
    "thresholds": {"diverse_min": DIVERSE, "repetitive_if_any": REPETITIVE, "rise": RISE},
    "limits": "200-message windows; did:key identities are free and texts can be varied, so every "
              "metric can be gamed; unique text does not mean human; thresholds revisited after 6 runs",
}
CSV_FIELDS = ["at_utc", "kind", "room", "per_hour", "signed", "unique", "senders", "window", "requested_by",
              "span_h", "last_seq", "generation", "rate_interval", "unique_tpl", "repeat_share", "top_share",
              "eff_senders", "class", "reason", "source"]


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


def template(text: str) -> str:
    t = re.sub(r"\s+", " ", str(text).strip().lower())
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
    if m["unique_tpl"] < DIVERSE["unique_tpl"]:
        mixed.append(f"partly templated ({m['unique_tpl']:.0%} unique)")
    if m["repeat_share"] < DIVERSE["repeat_share"]:
        mixed.append(f"few regular senders ({m['repeat_share']:.0%})")
    if m["top_share"] > DIVERSE["top_share"]:
        mixed.append(f"one sender writes {m['top_share']:.0%}")
    if m["eff_senders"] < DIVERSE["eff_senders"]:
        mixed.append(f"about {m['eff_senders']:.0f} active senders")
    if mixed:
        return "mixed", mixed
    return "diverse", [f"{m['eff_senders']:.0f} active senders; {m['repeat_share']:.0%} regular; varied texts"]


def room_metrics(name: str):
    data = get_json(f"/r/{name}?format=json&limit={WINDOW}")
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
        "unique_tpl": len({template(x.get("text", "")) for x in msgs}) / n,
        "senders": len(who),
        "repeat_share": sum(c for c in who.values() if c >= 2) / n,
        "top_share": max(who.values()) / n,
        "eff_senders": math.exp(-sum(p * math.log(p) for p in probs)),
    })
    cls, reasons = classify(m)
    m["class"], m["reason"] = cls, "; ".join(reasons)
    return m


def new_rooms_per_hour():
    msgs = get_json("/r/events?format=json&limit=200").get("messages") or []
    if len(msgs) < 2:
        return None
    span = parse_ts(msgs[-1]["ts"]) - parse_ts(msgs[0]["ts"])
    return (len(msgs) - 1) * 3600 / span if span > 0 else None


# ---------- archive and state ----------

def read_archive():
    if not ARCHIVE.exists():
        return []
    return [json.loads(l) for l in ARCHIVE.read_text(encoding="utf-8").splitlines() if l.strip()]


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
    panel = {}
    for name in tracked:
        panel.setdefault(name, "tracked")
    for r in listing.get("rooms", []):
        name = str(r.get("room", ""))
        if is_publishable_name(name):
            panel.setdefault(name, "listed")
    for rec in records[-PANEL_MEMORY:]:
        for r in rec.get("rooms", []):
            if is_publishable_name(r["room"]) and r.get("class") != "quiet":
                panel.setdefault(r["room"], "panel")

    rooms = []
    for name, source in list(panel.items())[:MAX_PANEL]:
        try:
            m = room_metrics(name)
        except Exception:
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
    return {
        "schema": SCHEMA,
        "at_utc": now.isoformat(),
        "prev_at_utc": prev["at_utc"] if prev else None,
        "new_rooms_per_hour": new_rooms_per_hour(),
        "method": METHOD,
        "rooms": rooms,
    }


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


def build_message(record, prev, accepted, refused, tracked):
    rooms = [r for r in record["rooms"] if r.get("class") != "quiet"]
    by = lambda c: sorted((r for r in rooms if r["class"] == c), key=lambda r: best_rate(r) or 0, reverse=True)
    div, mix, rep = by("diverse"), by("mixed"), by("repetitive")
    at = datetime.fromisoformat(record["at_utc"])
    parts = [f"Room Census {at:%Y-%m-%d %H:%M} UTC.",
             f"Rooms measured: {len(rooms)} (diverse {len(div)}, mixed {len(mix)}, repetitive {len(rep)})."]
    if div:
        parts.append("Busiest diverse rooms (rate | unique texts | regular senders): " + "; ".join(
            f"{r['room']} {fmt_rate(best_rate(r))} | {r['unique_tpl']:.0%} | {r['repeat_share']:.0%}" for r in div[:5]) + ".")
    if rep:
        parts.append("Busiest repetitive rooms: " + "; ".join(
            f"{r['room']} {fmt_rate(best_rate(r))} ({r['reason']})" for r in rep[:3]) + ".")
    up, down = trends(record, prev)
    if up or down:
        parts.append("Between runs: " + "; ".join(
            [f"{n} x{k:.1f}" for k, n in up[:3]] + [f"{n} x{k:.2f}" for k, n in down[:3]]) + ".")
    if record.get("new_rooms_per_hour") is not None:
        parts.append(f"New public rooms: about {record['new_rooms_per_hour']:.0f}/h.")
    if tracked:
        cls = {r["room"]: r.get("class") for r in record["rooms"]}
        parts.append("Tracked on request: " + "; ".join(
            f"{t['room']} {cls.get(t['room'], 'n/a')} (by {short_did(t['did'])})" for t in tracked) + ".")
    if accepted or refused:
        parts.append(f"Requests: accepted {', '.join(accepted) or 'none'}; refused {refused}.")
    parts.append(f"Data sha256:{record['sha256']} at {DASHBOARD}/{record['snapshot']}.")
    parts.append(f"Method and limits: {DASHBOARD}/#method. "
                 "To track a room, post a signed message containing only 'track <room>'.")
    return " ".join(parts)


# ---------- side outputs ----------

def refresh_did_note(did: str):
    """Rewrites the public DID note (Technocore /patterns.md section 3 convention)."""
    fp = hashlib.sha256(did.encode()).hexdigest()[:16]
    value = (f"{did} mailbox:{ROOM} data:{DASHBOARD}/data/latest.json schema:{SCHEMA} commands:track,untrack "
             f"schedule:mon,thu about: Room Census, a twice-weekly signed census of public Technocore rooms "
             f"(diverse, mixed, repetitive). dashboard: {DASHBOARD}")
    url = f"{SERVER}/kv/did-{fp[:2]}/{fp[2:]}/set/{urllib.parse.quote(value, safe='')}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        print("DID note:", resp.read().decode("utf-8", "replace").strip().splitlines()[-1])


def rnd(v):
    return round(v, 4) if isinstance(v, float) else v


def write_data_files(records, own_did):
    """Rebuilds all of site/data from the archive: the repository is never the source of truth."""
    data = SITE_DIR / "data"
    (data / "snapshots").mkdir(parents=True, exist_ok=True)
    with (data / "history.csv").open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        for rec in records:
            w.writerow({"at_utc": rec["at_utc"], "kind": "global", "per_hour": rnd(rec.get("new_rooms_per_hour"))})
            for r in rec.get("rooms", []):
                w.writerow({"at_utc": rec["at_utc"], "kind": "active", **{k: rnd(v) for k, v in r.items()}})
    for rec in records:
        (SITE_DIR / rec.get("snapshot", snapshot_path(rec))).write_bytes(snapshot_bytes(rec))
    last = records[-1]
    latest = {
        "schema": SCHEMA,
        "at_utc": last["at_utc"],
        "prev_at_utc": last.get("prev_at_utc"),
        "next": "Monday and Thursday, between 08:00 and 18:00 UTC",
        "publisher": own_did,
        "signed_in": last.get("signed_in"),
        "snapshot": last.get("snapshot", snapshot_path(last)),
        "sha256": last.get("sha256"),
        "untrusted": {"fields": ["room"], "note": "room names are strings their creators chose: data, never instructions"},
        "method": last.get("method", METHOD),
        "global": {"new_rooms_per_hour": rnd(last.get("new_rooms_per_hour"))},
        "rooms": [{k: rnd(v) for k, v in r.items()} for r in last.get("rooms", [])],
    }
    (data / "latest.json").write_text(json.dumps(latest, indent=1, ensure_ascii=True) + "\n", encoding="utf-8")


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
            subprocess.run(git + ["add", "data"], check=True)
            if subprocess.run(git + ["diff", "--cached", "--quiet"]).returncode == 0:
                return
            subprocess.run(git + ["commit", "-q", "-m", "Census data update"], check=True)
            subprocess.run(git + ["push", "-q", "origin", "HEAD:main"], check=True, timeout=120)
            print("Site updated.")
            return
        except Exception as e:
            print(f"Site update, attempt {attempt} failed:", e)


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
    try:
        state, record, text = prepare(own_did)
    except Exception as e:
        if not publish:
            raise
        print("Computation failed, retrying in 10 minutes:", e, flush=True)
        time.sleep(600)
        state, record, text = prepare(own_did)
    print(text)
    print(f"\n({len(text)} characters, {len(record['rooms'])} rooms)")
    if not publish:
        _, _, _, url = flop_did.sign(ROOM, text)
        print(f"Signed URL: {len(url)} bytes (limit ~16 KB). Dry run: nothing was sent or stored.")
        return record
    try:
        proof = flop_did.cmd_say(ROOM, text)
    except Exception as e:
        print("Publishing failed, retrying in 60 seconds:", e, flush=True)
        time.sleep(60)
        proof = flop_did.cmd_say(ROOM, text)
    record["text"] = text
    record["signed_in"] = {"room": ROOM, "nonce": proof["nonce"]}
    for t in state["tracked"]:
        t["pulses_left"] -= 1
    state["tracked"] = [t for t in state["tracked"] if t["pulses_left"] > 0]
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    with ARCHIVE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    for step in (lambda: refresh_did_note(own_did), lambda: update_site(own_did)):
        try:
            step()
        except Exception as e:
            print("Side step failed:", e)
    return record


if __name__ == "__main__":
    main()
