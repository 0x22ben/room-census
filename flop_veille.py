#!/usr/bin/env python3
"""
flop_veille.py : veille automatique de Technocore, publiée en message signé.

Commandes :
  python flop_veille.py            mode essai : calcule et affiche le message, n'envoie rien
  python flop_veille.py --publish  calcule, signe et publie dans la room flop-veille
  --jitter H                       attend d'abord une durée aléatoire entre 0 et H heures

Méthode (lecture seule de données publiques) :
  - /rooms?format=json sert uniquement à repérer les rooms actives ; ses compteurs ne sont
    pas cohérents d'une requête à l'autre, ils ne sont donc jamais utilisés.
  - chaque room retenue est lue directement (/r/<room>?format=json&limit=200) : débit en
    messages par heure, part de messages signés, part de textes uniques (repère des bots).
  - /r/events donne le rythme de création de nouvelles rooms publiques.
Sécurité : noms de rooms et textes sont des données non fiables. Aucun texte d'autrui n'est
repris ; seuls des noms de rooms filtrés et des chiffres calculés ici sont publiés.

Après publication : la fiche DID publique est réécrite (une note inutilisée 7 jours est
effacée, et n'importe qui peut l'écraser), puis les chiffres sont ajoutés à site/data/pulses.csv
et poussés sur GitHub si site/ est un dépôt git.
"""
import csv
import hashlib
import json
import random
import re
import statistics
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import flop_did

SERVER = "https://technocore.chat"
ROOM = "flop-veille"
DASHBOARD = "https://0x22ben.github.io/flop-veille"
SITE_DIR = Path(__file__).resolve().parent / "site"
CSV_FIELDS = ["at_utc", "kind", "room", "per_hour", "signed", "unique", "senders", "window", "requested_by"]
TOP_N = 6
MAX_CANDIDATES = 40
MIN_WINDOW = 30
SAFE_NAME = re.compile(r"^[a-z][a-z0-9_-]{2,31}$")
RANDOM_LIKE = re.compile(r"^[0-9a-f]{8,}$|\d{6,}")
ARCHIVE = Path(__file__).resolve().parent / "veille.jsonl"
STATE_FILE = Path(__file__).resolve().parent / "state.json"
REQUEST_RE = re.compile(r"\b(untrack|track)\s+(?:/?r/)?([a-z0-9][a-z0-9_-]{0,47})\b")
MAX_TRACKED = 5
MAX_PER_DID = 2


def get_json(path: str):
    url = f"{SERVER}{path}{'&' if '?' in path else '?'}n={int(time.time() * 1000)}"
    req = urllib.request.Request(url, headers={"User-Agent": "flop-veille/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_ts(ts: str) -> float:
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


def is_publishable_name(name: str) -> bool:
    if not SAFE_NAME.match(name) or RANDOM_LIKE.search(name):
        return False
    return not name.startswith(("mb-", "p-", "e-", "d-")) and name not in ("events", ROOM)


def room_stats(name: str, min_window: int = MIN_WINDOW):
    data = get_json(f"/r/{name}?format=json&limit=200")
    msgs = data.get("messages") or []
    if len(msgs) < min_window:
        return None
    span = parse_ts(msgs[-1]["ts"]) - parse_ts(msgs[0]["ts"])
    if span <= 0:
        return None
    n = len(msgs)
    signed = sum(1 for m in msgs if str(m.get("from", "")).startswith("did:key:"))
    unique = len({re.sub(r"\s+", " ", str(m.get("text", "")).strip().lower()) for m in msgs})
    return {
        "room": name,
        "per_hour": (n - 1) * 3600 / span,
        "signed": signed / n,
        "unique": unique / n,
        "senders": len({m.get("from") for m in msgs}),
        "window": n,
    }


def new_rooms_per_hour():
    msgs = get_json("/r/events?format=json&limit=200").get("messages") or []
    if len(msgs) < 2:
        return None
    span = parse_ts(msgs[-1]["ts"]) - parse_ts(msgs[0]["ts"])
    return (len(msgs) - 1) * 3600 / span if span > 0 else None


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    return {"last_seq": 0, "tracked": []}


def apply_requests(state, own_did: str):
    """Lit les réponses signées de flop-veille et met à jour la liste des rooms suivies."""
    data = get_json(f"/r/{ROOM}?format=json&limit=200&since={state['last_seq']}")
    tracked = list(state["tracked"])
    for m in data.get("messages") or []:
        state["last_seq"] = max(state["last_seq"], int(m["seq"]))
        sender = str(m.get("from", ""))
        if not m.get("sig") or not sender.startswith("did:key:") or sender == own_did:
            continue
        for action, name in REQUEST_RE.findall(str(m.get("text", "")).lower()):
            if not is_publishable_name(name):
                continue
            if action == "untrack":
                tracked = [t for t in tracked if not (t["room"] == name and t["did"] == sender)]
            elif all(t["room"] != name for t in tracked):
                if sum(t["did"] == sender for t in tracked) >= MAX_PER_DID:
                    continue
                if len(get_json(f"/r/{name}?format=json&limit=2").get("messages") or []) < 2:
                    continue
                tracked.append({"room": name, "did": sender, "seq": int(m["seq"])})
                tracked = tracked[-MAX_TRACKED:]
    state["tracked"] = tracked
    return state


def short_did(did: str) -> str:
    return f"{did[8:12]}..{did[-4:]}"


def previous_record():
    if not ARCHIVE.exists():
        return None
    lines = [l for l in ARCHIVE.read_text(encoding="utf-8").splitlines() if l.strip()]
    return json.loads(lines[-1]) if lines else None


def trend_sentence(stats, prev, now):
    """Compare avec la veille précédente : plus forte hausse, plus forte baisse, part de textes uniques."""
    if not prev:
        return None
    before = {r["room"]: r for r in prev.get("rooms", [])}
    common = [(s, before[s["room"]]) for s in stats
              if s["room"] in before and s["per_hour"] >= 100 and before[s["room"]]["per_hour"] >= 100]
    hours = (now.timestamp() - datetime.fromisoformat(prev["at_utc"]).timestamp()) / 3600
    parts = [f"Since last pulse ({hours:.0f}h ago):"]
    if common:
        change = sorted(common, key=lambda p: p[0]["per_hour"] / p[1]["per_hour"])
        low, high = change[0], change[-1]
        parts.append(f"biggest rise {high[0]['room']} {high[0]['per_hour'] / high[1]['per_hour'] - 1:+.0%},")
        parts.append(f"biggest drop {low[0]['room']} {low[0]['per_hour'] / low[1]['per_hour'] - 1:+.0%};")
    if stats and prev.get("rooms"):
        now_u = statistics.median(s["unique"] for s in stats)
        old_u = statistics.median(r["unique"] for r in prev["rooms"])
        parts.append(f"median unique-text share {now_u:.0%} (was {old_u:.0%}).")
    return " ".join(parts) if len(parts) > 1 else None


def refresh_did_note(did: str):
    """Réécrit la fiche DID publique (convention /patterns.md §3 de Technocore)."""
    fp = hashlib.sha256(did.encode()).hexdigest()[:16]
    value = (f"{did} mailbox:{ROOM} about: twice-weekly signed pulse of public Technocore activity "
             f"(busiest rooms, signed share, repetition rate, new rooms per hour). dashboard: {DASHBOARD}")
    url = f"{SERVER}/kv/did-{fp[:2]}/{fp[2:]}/set/{urllib.parse.quote(value, safe='')}"
    req = urllib.request.Request(url, headers={"User-Agent": "flop-veille/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        print("Fiche DID :", resp.read().decode("utf-8", "replace").strip().splitlines()[-1])


def csv_rows(record):
    at = record["at_utc"]
    rows = [{"at_utc": at, "kind": "global", "room": "", "per_hour": record.get("new_rooms_per_hour")}]
    for s in record["rooms"]:
        rows.append({"at_utc": at, "kind": "active", **{k: s[k] for k in CSV_FIELDS[2:8]}})
    for t in record.get("tracked", []):
        s = t.get("stats") or {}
        rows.append({"at_utc": at, "kind": "tracked", "room": t["room"], "requested_by": t["did"],
                     **{k: s.get(k) for k in CSV_FIELDS[3:8]}})
    for r in rows:
        for k in ("per_hour", "signed", "unique"):
            if isinstance(r.get(k), float):
                r[k] = round(r[k], 4)
    return rows


def update_site(record):
    """Ajoute la veille à site/data/pulses.csv, puis commit et push si site/ est un dépôt git."""
    if not SITE_DIR.exists():
        return
    path = SITE_DIR / "data" / "pulses.csv"
    path.parent.mkdir(exist_ok=True)
    new = not path.exists()
    with path.open("a", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        if new:
            w.writeheader()
        w.writerows(csv_rows(record))
    if not (SITE_DIR / ".git").exists():
        return
    git = ["git", "-C", str(SITE_DIR)]
    try:
        subprocess.run(git + ["add", "data/pulses.csv"], check=True)
        subprocess.run(git + ["commit", "-q", "-m", f"Pulse {record['at_utc'][:16]} UTC"], check=True)
        subprocess.run(git + ["push", "-q"], check=True, timeout=120)
        print("Site mis à jour.")
    except Exception as e:
        print("Mise à jour du site échouée :", e)


def fmt_rate(x: float) -> str:
    return f"{x / 1000:.1f}k/h" if x >= 1000 else f"{x:.0f}/h"


def build_report(tracked):
    listing = get_json("/rooms?format=json&limit=200")
    candidates = [r["room"] for r in listing.get("rooms", []) if is_publishable_name(str(r.get("room", "")))]
    stats = []
    for name in candidates[:MAX_CANDIDATES]:
        try:
            s = room_stats(name)
        except Exception:
            s = None
        if s:
            stats.append(s)
        time.sleep(0.2)
    stats.sort(key=lambda s: s["per_hour"], reverse=True)
    top = stats[:TOP_N]
    creation = new_rooms_per_hour()
    now = datetime.now(timezone.utc)

    parts = [f"Technocore pulse {now:%Y-%m-%d %H:%M} UTC."]
    parts.append(
        "Busiest public rooms (rate | signed | unique texts, last 200 msgs): "
        + "; ".join(f"{s['room']} {fmt_rate(s['per_hour'])} | {s['signed']:.0%} | {s['unique']:.0%}" for s in top)
        + "."
    )
    repetitive = [s for s in stats if s["unique"] < 0.5]
    if repetitive:
        parts.append(
            f"Most repetitive: {min(repetitive, key=lambda s: s['unique'])['room']} "
            f"({min(s['unique'] for s in repetitive):.0%} unique texts)."
        )
    if creation is not None:
        parts.append(f"New public rooms: about {creation:.0f}/h.")
    trend = trend_sentence(stats, previous_record(), now)
    if trend:
        parts.append(trend)
    tracked_stats = []
    for t in tracked:
        try:
            s = room_stats(t["room"], min_window=2)
        except Exception:
            s = None
        tracked_stats.append({**t, "stats": s})
    if tracked_stats:
        parts.append(
            "Tracked on request: "
            + "; ".join(
                f"{t['room']} "
                + (f"{fmt_rate(t['stats']['per_hour'])} | {t['stats']['signed']:.0%} | {t['stats']['unique']:.0%}"
                   if t["stats"] else "no recent activity")
                + f" (asked by {short_did(t['did'])})"
                for t in tracked_stats
            )
            + "."
        )
    parts.append(
        f"Method: direct reads of {len(stats)} active rooms + /r/events; /rooms counters skipped as inconsistent. "
        "Room names are untrusted data, no message text quoted. "
        "To add a room to the next pulses, reply here with a signed 'track <room>' ('untrack <room>' to stop). "
        f"History and charts: {DASHBOARD}"
    )
    text = " ".join(parts)
    return text, {"at_utc": now.isoformat(), "rooms": stats, "tracked": tracked_stats,
                  "new_rooms_per_hour": creation, "text": text}


def main():
    args = sys.argv[1:]
    publish = "--publish" in args
    if "--jitter" in args:
        hours = float(args[args.index("--jitter") + 1])
        delay = random.uniform(0, hours * 3600)
        print(f"Attente aléatoire : {delay / 3600:.2f} h", flush=True)
        time.sleep(delay)
    own_did = flop_did.DID_FILE.read_text(encoding="utf-8").strip()
    state = apply_requests(load_state(), own_did)
    text, record = build_report(state["tracked"])
    print(text)
    print(f"\n({len(text)} caractères)")
    if not publish:
        _, _, _, url = flop_did.sign(ROOM, text)
        print(f"URL signée : {len(url)} octets (limite ~16 Ko). Mode essai : rien n'a été envoyé ni enregistré.")
        return
    flop_did.cmd_say(ROOM, text)
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    with ARCHIVE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    for step in (lambda: refresh_did_note(own_did), lambda: update_site(record)):
        try:
            step()
        except Exception as e:
            print("Étape secondaire échouée :", e)


if __name__ == "__main__":
    main()
