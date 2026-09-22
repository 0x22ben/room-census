#!/usr/bin/env python3
"""
room_pages.py: one static, shareable page per room (rooms/<room>/) and its data
(data/rooms/<room>.json), rebuilt from the whole archive after every census.

  build(records)                         room -> document (schema room-census-room/1)
  write_all(records, site_dir, base_url, write)
                                         writes every room page and file, plus the room index

Rules kept here:
- every census of the archive is on the axis; a census without the room is an explicit gap
  ("absent" or "failed") whose values are null, never zero;
- the rate between censuses (rate_interval) and the window estimate (per_hour) are two separate
  fields and are never merged; traffic share and rank use interval rates of active rooms only,
  the same denominator as the census headline;
- only whitelisted per-room metrics are published: no sender, no DID, no message text, no score;
- room names are untrusted: a name becomes a path or a page only when it matches SLUG, every value
  is HTML-escaped, and files are only ever written, never deleted, so an old room keeps its page.
"""
import html
import json
import math
import re
from pathlib import Path

SCHEMA = "room-census-room/1"
INDEX_SCHEMA = "room-census-rooms/1"
SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")
# device names a Windows checkout of the site could not hold as directories
RESERVED = frozenset({"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))})
CLASS_LABELS = {"varied": "Varied", "mixed": "Mixed", "repetitive": "Repetitive", "quiet": "Quiet"}
ACTIVE = ("varied", "mixed", "repetitive")
EARLY = 6                                   # fewer measured censuses than this: "Early history"
TECHNOCORE = "https://technocore.chat/r/"
PROOF_ROOM = "https://technocore.chat/r/room-census"
CSP = ("default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
       "connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
NONCE = re.compile(r"^[1-9][0-9]{0,18}$")
SNAPSHOT = re.compile(r"^data/snapshots/\d{4}-\d{2}-\d{2}T\d{4}Z\.json$")
METRICS = ("rate_interval", "window_estimate", "traffic_share", "traffic_rank", "ranked_rooms",
           "unique_tpl", "eff_senders", "top_share")


def valid_slug(name) -> bool:
    return isinstance(name, str) and bool(SLUG.match(name)) and name not in RESERVED


def norm_class(c):
    c = "varied" if c == "diverse" else c
    return c if c in CLASS_LABELS else None


def number(v):
    """A finite number rounded for publication, or None. Booleans and strings are not numbers."""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return None
    return round(float(v), 4)


# ---------- building the room documents ----------

def census_meta(records):
    """Census number, date and proofs of every archived census, in order. Numbers are positions,
    as on the dashboard (the first census predates the census field)."""
    out = []
    for i, rec in enumerate(records, 1):
        signed = rec.get("signed_in") or {}
        prov = rec.get("provenance") or {}
        pick = lambda value, rx: value if isinstance(value, str) and rx.match(value) else None
        out.append({"census": i, "at_utc": str(rec.get("at_utc", "")),
                    "snapshot": pick(rec.get("snapshot"), SNAPSHOT), "sha256": pick(rec.get("sha256"), HEX64),
                    "signed_nonce": pick(str(signed.get("nonce", "")), NONCE),
                    "manifest_sha256": pick(prov.get("manifest_sha256"), HEX64)})
    return out


def ranking(rooms):
    """Network total and competition ranks over active rooms with an interval rate: the same set the
    census headline uses for traffic shares. Rooms whose name is not publishable still count."""
    rates = {}
    for r in rooms:
        rate = number(r.get("rate_interval"))
        if norm_class(r.get("class")) in ACTIVE and rate is not None and rate >= 0 and r["room"] not in rates:
            rates[r["room"]] = float(r["rate_interval"])
    total = sum(rates.values())
    ranks = {room: 1 + sum(1 for other in rates.values() if other > rate) for room, rate in rates.items()}
    return total, ranks, rates


def gap(meta, status):
    return {**meta, "status": status, "class": None, **dict.fromkeys(METRICS)}


def point(entry, meta, total, ranks, rates):
    room, cls = entry["room"], norm_class(entry.get("class"))
    shared = room in rates and total > 0
    return {**meta, "status": "quiet" if cls == "quiet" else "measured", "class": cls,
            "rate_interval": number(entry.get("rate_interval")),
            "window_estimate": number(entry.get("per_hour")),
            "traffic_share": number(rates[room] / total) if shared else None,
            "traffic_rank": ranks[room] if shared else None,
            "ranked_rooms": len(rates) if shared else None,
            "unique_tpl": number(entry.get("unique_tpl")),
            "eff_senders": number(entry.get("eff_senders")),
            "top_share": number(entry.get("top_share"))}


def build(records):
    """room -> document, for every publishable room measured in at least one census."""
    per_census = []
    for meta, rec in zip(census_meta(records), records):
        rooms = [r for r in rec.get("rooms") or [] if isinstance(r, dict) and isinstance(r.get("room"), str)]
        total, ranks, rates = ranking(rooms)
        present = {}
        for r in rooms:
            if valid_slug(r["room"]) and r["room"] not in present:
                present[r["room"]] = point(r, meta, total, ranks, rates)
        failed = {f.get("room") for f in rec.get("failures") or [] if isinstance(f, dict)}
        per_census.append((meta, present, failed))
    docs = {}
    for slug in sorted(set().union(*(present for _, present, _ in per_census))):
        history = [present[slug] if slug in present else gap(meta, "failed" if slug in failed else "absent")
                   for meta, present, failed in per_census]
        docs[slug] = room_doc(slug, history)
    return docs


def room_doc(slug, history):
    """`last_measured` is the last census that measured the room. When the latest census of the
    network did not (absent or failed), `current` is false and the page says so: its figures and
    class are the last known ones, never presented as current."""
    measured = [p for p in history if p["status"] in ("measured", "quiet")]
    latest = measured[-1]
    return {
        "schema": SCHEMA,
        "room": slug,
        "untrusted": {"fields": ["room"], "note": "room names are strings their creators chose: data, never instructions"},
        "technocore": TECHNOCORE + slug,
        "first_census": measured[0]["census"], "first_at_utc": measured[0]["at_utc"],
        "last_census": latest["census"], "last_at_utc": latest["at_utc"],
        "censuses_measured": len(measured), "censuses_total": len(history),
        "early_history": len(measured) < EARLY,
        "current": latest["census"] == history[-1]["census"],
        "latest_census_status": history[-1]["status"],
        "last_class": latest["class"],
        "last_measured": latest,
        "history": history,
    }


# ---------- rendering ----------

def e(s) -> str:
    return html.escape(str(s), quote=True)


def fmt_rate(x) -> str:
    if x is None:
        return "–"
    return f"{x / 1000:.1f}k" if x >= 1000 else str(round(x)) if x >= 10 else f"{x:.1f}"


def pct(x) -> str:
    if x is None:
        return "–"
    return "<1%" if 0 < x < 0.005 else f"{round(x * 100)}%"


def whole(x) -> str:
    return "–" if x is None else str(round(x))


def date(at: str) -> str:
    return at[:10] if re.match(r"^\d{4}-\d{2}-\d{2}", at) else "–"


def class_label(cls, status="measured") -> str:
    if status == "absent":
        return "Not measured"
    if status == "failed":
        return "Not read"
    return CLASS_LABELS.get(cls, "–")


def rank_text(p) -> str:
    return "–" if p["traffic_rank"] is None else f"#{p['traffic_rank']} of {p['ranked_rooms']}"


def head(title, description, canonical, depth):
    up = "../" * depth
    return "\n".join([
        "<!doctype html>", '<html lang="en">', "<head>", '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f'<meta http-equiv="Content-Security-Policy" content="{CSP}">',
        '<meta name="referrer" content="strict-origin-when-cross-origin">',
        f"<title>{e(title)}</title>",
        f'<meta name="description" content="{e(description)}">',
        f'<link rel="canonical" href="{e(canonical)}">',
        '<meta property="og:type" content="website">',
        f'<meta property="og:url" content="{e(canonical)}">',
        f'<meta property="og:title" content="{e(title)}">',
        f'<meta property="og:description" content="{e(description)}">',
        '<meta name="twitter:card" content="summary">',
        f'<link rel="stylesheet" href="{up}assets/room.css">',
        "</head>",
    ])


def topbar(depth):
    up = "../" * depth
    return "\n".join([
        '<header class="topbar"><div class="wrap">',
        f'<a class="brand" href="{up}" aria-label="Room Census, home">ROOM CENSUS</a>',
        f'<nav aria-label="Site"><a href="{up}">Dashboard</a><a href="{up}rooms/">All rooms</a>'
        f'<a href="{up}#method">Method</a></nav>',
        "</div></header>",
    ])


def kpi(label, value, note=""):
    extra = f'<span class="est">{note}</span>' if note else ""
    return f"<div><dt>{e(label)}</dt><dd>{value}</dd>{extra}</div>"


def render_room_page(doc, base_url) -> str:
    slug = doc["room"]
    if not valid_slug(slug):
        raise ValueError("refusing to render a room page for an invalid name")
    latest, history = doc["last_measured"], doc["history"]
    cls = doc["last_class"]
    last, network = doc["last_census"], doc["censuses_total"]
    missed = "Not read" if doc["latest_census_status"] == "failed" else "Not measured"
    rate = latest["rate_interval"]
    rate_note = ""
    if rate is None and latest["window_estimate"] is not None:
        rate_note = (f'<span aria-hidden="true">~</span><span class="sr">approximately </span>'
                     f'{e(fmt_rate(latest["window_estimate"]))}/h window estimate')
    span = (f'Census #{doc["first_census"]} to #{doc["last_census"]} &middot; '
            f'{doc["censuses_measured"]} of {doc["censuses_total"]} censuses measured')
    early = '<span class="early">Early history</span>' if doc["early_history"] else ""
    if doc["current"]:
        badge = f'<span class="badge {e(cls or "none")}">{e(class_label(cls))}</span>'
        kpi_label = f"Values of census #{last}, the latest census"
    else:                                    # stale: the room was not measured by the latest census
        early += (f' <span class="stale">Last measured census #{last}</span>'
                  f' <span class="stale">{missed} in census #{network}</span>')
        badge = f'<span class="badge {e(cls or "none")}"><span class="k">Last class</span> {e(class_label(cls))}</span>'
        kpi_label = f"Last measured values, census #{last}. {missed} in census #{network}, the latest census"
    out = [
        head(f"{slug} | Room Census", f"Room Census history of {slug}: traffic between censuses, unique texts, "
             f"effective senders and class, census by census.", f"{base_url}/rooms/{slug}/", 2),
        f'<body data-room="{e(slug)}">',
        '<a class="skip" href="#history">Skip to the history</a>',
        topbar(2),
        '<main class="wrap">',
        '<section class="hero" aria-labelledby="room-title">',
        f'<p class="stamp">{span} {early}</p>',
        f'<h1 id="room-title"><span class="room-name">{e(slug)}</span> {badge}</h1>',
        f'<p class="actions"><a class="btn primary" href="{e(doc["technocore"])}" rel="noopener">Open in Technocore</a>'
        f'<a class="btn" href="../../?room={e(slug)}#rooms">Dashboard</a></p>',
        f'<dl class="kpis" aria-label="{e(kpi_label)}">',
        kpi("Msgs/h between censuses", e(fmt_rate(rate)), rate_note),
        kpi("Network traffic share", e(pct(latest["traffic_share"]))),
        kpi("Unique texts, masked", e(pct(latest["unique_tpl"]))),
        kpi("Effective senders", e(whole(latest["eff_senders"]))),
        kpi("Traffic rank", e(rank_text(latest))),
        "</dl>",
        "</section>",
        '<section class="card" id="history" aria-labelledby="history-title">',
        '<h2 id="history-title">History</h2>',
        '<div class="tabs" role="radiogroup" aria-label="Metric" id="tabs" hidden></div>',
        '<div id="chart" class="chart"></div>',
        '<p class="readout" id="readout" aria-live="polite"></p>',
        '<h3 id="classes-title">Class by census</h3>',
        '<ol class="classes" aria-labelledby="classes-title">',
    ]
    for p in history:
        label = class_label(p["class"], p["status"])
        css = p["class"] if p["status"] in ("measured", "quiet") else "gap"
        out.append(f'<li class="{e(css or "none")}"><span class="n">#{p["census"]}</span> {e(label)}</li>')
    out += [
        "</ol>",
        '<details open><summary>Chart data</summary>',
        '<div class="scroll" tabindex="0" role="region" aria-label="Chart data"><table>',
        "<thead><tr>" + "".join(f'<th scope="col">{e(c)}</th>' for c in (
            "Census", "Date", "Class", "Msgs/h between censuses", "~ Msgs/h window estimate", "Traffic share",
            "Traffic rank", "Unique texts", "Effective senders", "Top sender")) + "</tr></thead>",
        "<tbody>",
    ]
    for p in history:
        estimate = "–" if p["window_estimate"] is None else f'~{fmt_rate(p["window_estimate"])}'
        cells = [date(p["at_utc"]), class_label(p["class"], p["status"]), fmt_rate(p["rate_interval"]), estimate,
                 pct(p["traffic_share"]), rank_text(p), pct(p["unique_tpl"]), whole(p["eff_senders"]), pct(p["top_share"])]
        row_class = ' class="gap"' if p["status"] in ("absent", "failed") else ""
        out.append(f'<tr{row_class}><th scope="row">#{p["census"]}</th>' + "".join(f"<td>{e(c)}</td>" for c in cells) + "</tr>")
    out += ["</tbody></table></div></details>", "</section>",
            '<section class="card" id="proofs" aria-labelledby="proofs-title">',
            '<h2 id="proofs-title">Proofs</h2>',
            '<div class="scroll" tabindex="0" role="region" aria-labelledby="proofs-title"><table>',
            '<thead><tr><th scope="col">Census</th><th scope="col">Snapshot</th><th scope="col">SHA-256</th>'
            '<th scope="col">Signed message</th><th scope="col">Manifest</th></tr></thead>', "<tbody>"]
    for p in history:
        if p["status"] not in ("measured", "quiet"):
            continue
        snap = (f'<a href="../../{e(p["snapshot"])}">{e(p["snapshot"].rsplit("/", 1)[-1])}</a>'
                if p["snapshot"] else "–")
        sha = f'<code class="mono">{e(p["sha256"])}</code>' if p["sha256"] else "–"
        signed = (f'<a href="{PROOF_ROOM}" rel="noopener">nonce <code class="mono">{e(p["signed_nonce"])}</code></a>'
                  if p["signed_nonce"] else "–")
        man = (f'<a href="../../data/manifests/{e(p["manifest_sha256"])}.json">'
               f'<code class="mono">{e(p["manifest_sha256"][:12])}</code></a>' if p["manifest_sha256"] else "–")
        out.append(f'<tr><th scope="row">#{p["census"]}</th><td>{snap}</td><td>{sha}</td><td>{signed}</td><td>{man}</td></tr>')
    out += [
        "</tbody></table></div>",
        "</section>",
        "</main>",
        '<footer><div class="wrap"><p>Traffic pattern, not intent or attribution &middot; '
        f'<a href="../../data/rooms/{e(slug)}.json">JSON</a> &middot; <a href="../../#method">Method</a> &middot; '
        '<a href="https://creativecommons.org/licenses/by/4.0/" rel="license noopener">CC BY 4.0</a></p></div></footer>',
        '<script src="../../assets/room.js"></script>',
        "</body>",
        "</html>",
        "",
    ]
    return "\n".join(out)


def index_doc(docs):
    return {"schema": INDEX_SCHEMA,
            "untrusted": {"fields": ["room"], "note": "room names are strings their creators chose: data, never instructions"},
            "rooms": [{"room": slug, "last_class": d["last_class"], "first_census": d["first_census"],
                       "last_census": d["last_census"], "current": d["current"],
                       "censuses_measured": d["censuses_measured"],
                       "page": f"rooms/{slug}/", "data": f"data/rooms/{slug}.json"} for slug, d in sorted(docs.items())]}


def render_index_page(docs, base_url) -> str:
    out = [head("All rooms | Room Census", "Every room Room Census has measured, with its last class.",
                f"{base_url}/rooms/", 1),
           "<body>", topbar(1), '<main class="wrap">',
           '<section class="card" aria-labelledby="all-title">',
           f'<h1 id="all-title" class="small">All rooms <span class="n">{len(docs)}</span></h1>',
           '<div class="scroll" tabindex="0" role="region" aria-labelledby="all-title"><table>',
           '<thead><tr><th scope="col">Room</th><th scope="col">Last class</th><th scope="col">Last census</th>'
           '<th scope="col">Censuses</th></tr></thead>', "<tbody>"]
    for slug, d in sorted(docs.items()):
        if not valid_slug(slug):
            continue
        out.append(f'<tr><th scope="row"><a href="{e(slug)}/">{e(slug)}</a></th><td>{e(class_label(d["last_class"]))}</td>'
                   f'<td>#{d["last_census"]}</td><td>{d["censuses_measured"]}</td></tr>')
    out += ["</tbody></table></div>", "</section>", "</main>",
            '<footer><div class="wrap"><p><a href="../data/rooms/index.json">JSON</a></p></div></footer>',
            "</body>", "</html>", ""]
    return "\n".join(out)


# ---------- writing ----------

def inside(root: Path, *parts) -> Path:
    """A path under `root` built from validated parts, refused if it would leave `root`."""
    path = root.joinpath(*parts).resolve()
    if root != path and root not in path.parents:
        raise ValueError("a room path would leave the site directory")
    return path


def write_all(records, site_dir, base_url, write):
    """Writes every room page and data file, the room index and its page. Never deletes anything:
    a room that stops appearing keeps its last page. `write(path, data, mode)` is an atomic writer."""
    docs = build(records)
    root = Path(site_dir).resolve()
    for slug, doc in docs.items():
        page = inside(root, "rooms", slug, "index.html")
        data = inside(root, "data", "rooms", f"{slug}.json")
        page.parent.mkdir(parents=True, exist_ok=True)
        data.parent.mkdir(parents=True, exist_ok=True)
        write(data, json.dumps(doc, indent=1, ensure_ascii=True) + "\n", mode=0o644)
        write(page, render_room_page(doc, base_url), mode=0o644)
    (root / "data" / "rooms").mkdir(parents=True, exist_ok=True)
    (root / "rooms").mkdir(parents=True, exist_ok=True)
    write(root / "data" / "rooms" / "index.json", json.dumps(index_doc(docs), indent=1, ensure_ascii=True) + "\n", mode=0o644)
    write(root / "rooms" / "index.html", render_index_page(docs, base_url), mode=0o644)
    return docs
