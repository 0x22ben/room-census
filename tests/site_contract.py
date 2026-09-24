"""Public route and artifact contract of the Room Census site.

The same checks apply to any built copy of the site: the legacy tree served from the repository root
today, and the Astro artifact later. They read files only; `python -m tests.site_contract --live URL`
checks a served copy over HTTP (status, content type, canonical URL) without changing anything.

What the contract guarantees:
- every required public data file is present, as a regular file;
- the latest snapshot and manifest resolve and match their SHA-256;
- identity.json and latest.json name the same provenance;
- the room index, the room data files and the room pages are the same set of safe slugs;
- every page has its canonical URL, the strict CSP, no executable inline script, no external
  script, stylesheet or image, the anchors that signed messages and pages link to, and internal
  links that resolve inside the site.
"""
import gzip
import hashlib
import json
import re
import sys
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath

LEGACY_BASE = "https://0x22ben.github.io/room-census/"
DOMAIN_BASE = "https://roomcensus.xyz/"

REQUIRED_FILES = ("data/latest.json", "data/history.csv", "data/card.png", "data/LICENSE",
                  "data/rooms/index.json", "identity.json", "llms.txt")
SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")
RESERVED = frozenset({"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))})
HEX64 = re.compile(r"^[0-9a-f]{64}$")
SNAPSHOT = re.compile(r"^data/snapshots/\d{4}-\d{2}-\d{2}T\d{4}Z\.json$")
MANIFEST = re.compile(r"^data/manifests/[0-9a-f]{64}\.json$")
# anchors other documents point to: every signed census links /#method, room pages link /#rooms,
# ?room=<slug>#rooms and /#trust, the room index links each room's #history
ANCHORS = {"/": ("rooms", "trust", "method"), "/rooms/<slug>/": ("history",)}
# directives every page must carry exactly: scripts only from the site itself, nothing embedded
CSP_REQUIRED = {"default-src": ["'self'"], "script-src": ["'self'"], "object-src": ["'none'"], "base-uri": ["'none'"],
                "connect-src": ["'self'"], "form-action": ["'none'"]}
# the only sources any directive may list: no host, scheme wildcard or other origin anywhere
# ('unsafe-inline' only for the legacy styles, data: only for inline images such as the favicon)
CSP_ALLOWED = {"style-src": {"'self'", "'unsafe-inline'"}, "img-src": {"'self'", "data:"}}
# the one origin a page may reach, and only a page that shows or writes to a room
TECHNOCORE = "https://technocore.chat"
# GitHub Pages serves the extensionless data/LICENSE as application/octet-stream (recorded 2026-09-23)
CONTENT_TYPES = {".html": ("text/html",), ".json": ("application/json",), ".csv": ("text/csv",), ".png": ("image/png",),
                 ".txt": ("text/plain",), "": ("text/plain", "application/octet-stream")}


def valid_slug(name) -> bool:
    return isinstance(name, str) and bool(SLUG.match(name)) and name not in RESERVED


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


class Page(HTMLParser):
    """What the contract needs from one HTML page."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids, self.links, self.resources = set(), [], []
        self.canonical = self.csp = None
        self.inline_scripts = 0
        self._script = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if a.get("id"):
            self.ids.add(a["id"])
        if tag == "a" and a.get("href"):
            self.links.append(a["href"])
        elif tag == "link":
            rel = (a.get("rel") or "").lower().split()
            if "canonical" in rel:
                self.canonical = a.get("href")
            elif a.get("href") and ({"stylesheet", "icon", "preload", "modulepreload", "prefetch", "preconnect",
                                     "dns-prefetch", "prerender", "manifest"} & set(rel)):
                self.resources.append(a["href"])
        elif tag == "meta" and (a.get("http-equiv") or "").lower() == "content-security-policy":
            self.csp = a.get("content")
        elif tag == "script":
            if a.get("src"):
                self.resources.append(a["src"])
            else:
                self._script = (a.get("type") or "").lower()
        elif tag in ("img", "source", "iframe", "embed", "object", "audio", "video") and (a.get("src") or a.get("data")):
            self.resources.append(a.get("src") or a.get("data"))

    def handle_endtag(self, tag):
        if tag == "script" and self._script is not None:
            if self._script != "application/ld+json":           # structured data is not executed
                self.inline_scripts += 1
            self._script = None


def csp_directives(policy):
    out = {}
    for part in (policy or "").split(";"):
        words = part.split()
        if words:
            out[words[0].lower()] = words[1:]
    return out


def csp_problem(policy, reads_technocore=False):
    """Why a page's Content-Security-Policy is weaker than the contract, None when it holds.

    A page that shows a room live, or that writes to one, reads technocore.chat from the browser, so
    its connect-src names that one origin. Everywhere else connect-src stays 'self', and no directive
    may name a host on any page.
    """
    d = csp_directives(policy)
    allowed = dict(CSP_ALLOWED)
    required = dict(CSP_REQUIRED)
    if reads_technocore:
        # that one origin becomes possible, it never becomes required: a page that reads no room keeps 'self'
        required.pop("connect-src")
        allowed["connect-src"] = {"'self'", TECHNOCORE}
        if "'self'" not in d.get("connect-src", []):
            return f"connect-src is {d.get('connect-src')}"
    for name, sources in required.items():
        if d.get(name) != sources:
            return f"{name} is {d.get(name)}"
    for name, sources in d.items():
        extra = set(sources) - allowed.get(name, {"'self'", "'none'"})
        if extra:
            return f"{name} allows {sorted(extra)}"
    return None


def snapshot_refs(node):
    """Every object of a document that names a snapshot (history entries, last_measured, ...)."""
    if isinstance(node, dict):
        if "snapshot" in node:
            yield node
        for v in node.values():
            yield from snapshot_refs(v)
    elif isinstance(node, list):
        for v in node:
            yield from snapshot_refs(v)


def parse(path: Path) -> Page:
    p = Page()
    p.feed(path.read_text(encoding="utf-8"))
    return p


def pages(root: Path, slugs):
    """Route, route class and file of every page the contract requires."""
    yield "/", "/", root / "index.html"
    yield "/rooms/", "/rooms/", root / "rooms" / "index.html"
    for slug in slugs:
        yield f"/rooms/{slug}/", "/rooms/<slug>/", root / "rooms" / slug / "index.html"


def resolve(root: Path, route: str, href: str):
    """File an internal link points to, None for an external or non-file link."""
    parts = urllib.parse.urlsplit(href)
    if parts.scheme or parts.netloc or not parts.path:
        return None
    target = PurePosixPath(parts.path) if parts.path.startswith("/") else PurePosixPath(route) / parts.path
    clean = []
    for piece in target.parts[1:] if target.is_absolute() else target.parts:
        if piece == "..":
            if not clean:
                return root / ".." / "outside"                      # climbs above the site root
            clean.pop()
        elif piece not in (".", ""):
            clean.append(piece)
    path = root.joinpath(*clean) if clean else root
    return path / "index.html" if parts.path.endswith("/") or path.is_dir() else path


def check(root, base_url):
    """Every contract violation found in the site at `root`, served at `base_url` (empty when valid)."""
    root = Path(root).resolve()
    problems = []
    bad = problems.append

    for rel in REQUIRED_FILES:
        f = root / rel
        if f.is_symlink() or not f.is_file():
            bad(f"missing required file {rel}")
    if problems:
        return problems

    latest = load_json(root / "data/latest.json")
    identity = load_json(root / "identity.json")
    snap = latest.get("snapshot")
    if not (isinstance(snap, str) and SNAPSHOT.match(snap) and (root / snap).is_file()):
        bad(f"latest snapshot does not resolve: {snap!r}")
    elif sha256(root / snap) != latest.get("sha256"):
        bad(f"latest snapshot hash differs from latest.json: {snap}")
    prov = latest.get("provenance")
    if prov is not None:
        path = prov.get("manifest") if isinstance(prov, dict) else None
        if not (isinstance(path, str) and MANIFEST.match(path) and (root / path).is_file()):
            bad(f"latest manifest does not resolve: {path!r}")
        elif sha256(root / path) != prov.get("manifest_sha256") or not path.endswith(f"/{prov.get('manifest_sha256')}.json"):
            bad(f"latest manifest hash differs from its name or from latest.json: {path}")
    if identity.get("provenance") != prov:
        bad("identity.json and latest.json name different provenance")
    for f in sorted((root / "data" / "manifests").glob("*")) if (root / "data" / "manifests").is_dir() else ():
        if not (f.is_file() and HEX64.match(f.stem) and f.suffix == ".json" and sha256(f) == f.stem):
            bad(f"manifest file not named after its own SHA-256: {f.name}")

    index = load_json(root / "data/rooms/index.json")
    entries = index.get("rooms") if isinstance(index, dict) else None
    if index.get("schema") != "room-census-rooms/1" or not isinstance(entries, list):
        bad("data/rooms/index.json is not a room-census-rooms/1 document")
        entries = []
    slugs = []
    for entry in entries:
        slug = entry.get("room") if isinstance(entry, dict) else None
        if not valid_slug(slug):
            bad(f"unsafe or missing room slug in the index: {slug!r}")
            continue
        if slug in slugs:
            bad(f"duplicate room in the index: {slug}")
        slugs.append(slug)
        if entry.get("page") != f"rooms/{slug}/" or entry.get("data") != f"data/rooms/{slug}.json":
            bad(f"index entry of {slug} does not use the contract paths")
        doc_path = root / "data" / "rooms" / f"{slug}.json"
        if not doc_path.is_file():
            bad(f"room data file missing: data/rooms/{slug}.json")
            continue
        doc = load_json(doc_path)
        if doc.get("schema") != "room-census-room/1" or doc.get("room") != slug:
            bad(f"data/rooms/{slug}.json is not the room-census-room/1 document of {slug}")
        for point in snapshot_refs(doc):
            s, h = point.get("snapshot"), point.get("sha256")
            if s is None:
                continue
            if not (isinstance(s, str) and SNAPSHOT.match(s) and (root / s).is_file() and sha256(root / s) == h):
                bad(f"data/rooms/{slug}.json names a snapshot that does not resolve or match: {s}")
                break
    listed = set(slugs)
    data_files = {f.stem for f in (root / "data" / "rooms").glob("*.json") if f.name != "index.json"}
    if data_files != listed:
        bad(f"room data files and index differ: {sorted(data_files ^ listed)}")
    page_dirs = {d.name for d in (root / "rooms").iterdir() if d.is_dir()} if (root / "rooms").is_dir() else set()
    if page_dirs != listed:
        bad(f"room pages and index differ: {sorted(page_dirs ^ listed)}")

    for route, kind, f in pages(root, sorted(listed)):
        if not f.is_file():
            bad(f"missing page {route}")
            continue
        p = parse(f)
        if p.canonical != base_url.rstrip("/") + route:
            bad(f"{route}: canonical is {p.canonical!r}")
        weak = csp_problem(p.csp, reads_technocore=kind == "/rooms/<slug>/")
        if weak:
            bad(f"{route}: missing or weakened Content-Security-Policy ({weak})")
        if p.inline_scripts:
            bad(f"{route}: {p.inline_scripts} executable inline script(s)")
        for missing in [a for a in ANCHORS.get(kind, ()) if a not in p.ids]:
            bad(f"{route}: missing anchor #{missing}")
        for res in p.resources:
            if res.startswith("data:"):
                continue
            target = resolve(root, route, res)
            if target is None:
                bad(f"{route}: external resource {res}")
            elif not target.is_file():
                bad(f"{route}: resource does not resolve: {res}")
        for href in p.links:
            target = resolve(root, route, href)
            if target is not None and not target.is_file():
                bad(f"{route}: broken internal link {href}")
    return problems


def routes(root):
    """Every public URL path of the site at `root`, pages and artifacts, sorted."""
    root = Path(root).resolve()
    index = load_json(root / "data/rooms/index.json")
    slugs = sorted(e["room"] for e in index["rooms"])
    out = [route for route, _, _ in pages(root, slugs)] + ["/" + rel for rel in REQUIRED_FILES]
    for sub in ("snapshots", "manifests", "rooms"):
        out += [f"/data/{sub}/{f.name}" for f in sorted((root / "data" / sub).glob("*.json"))]
    return sorted(set(out))


def live(base_url, root, canonical_base=None):
    """Checks a served copy over HTTP: status, content type and canonical URL of every route. The legacy
    site keeps its GitHub Pages canonical URL when served from another origin: pass it as canonical_base."""
    canonical_base = canonical_base or base_url
    problems = []
    for route in routes(root):
        url = base_url.rstrip("/") + route
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "room-census-contract"}),
                                        timeout=30) as r:
                status, ctype, body = r.status, r.headers.get("Content-Type", ""), r.read()
        except Exception as e:                                         # reported, never retried
            problems.append(f"{route}: {e}")
            continue
        suffix = PurePosixPath(route).suffix if not route.endswith("/") else ".html"
        if status != 200 or not ctype.startswith(CONTENT_TYPES.get(suffix, ("",))):
            problems.append(f"{route}: status {status}, content type {ctype!r}")
        if suffix == ".html":
            p = Page()
            p.feed(body.decode("utf-8"))
            if p.canonical != canonical_base.rstrip("/") + route:
                problems.append(f"{route}: canonical is {p.canonical!r}")
    return problems


def baseline(root, commit, tracked):
    """Size and route record of a site, the reference the Astro artifact is compared with."""
    root = Path(root).resolve()
    all_routes = routes(root)
    size = lambda rel: {"bytes": (root / rel).stat().st_size,
                        "gzip": len(gzip.compress((root / rel).read_bytes(), 9, mtime=0))}
    room_pages = sorted(root.glob("rooms/*/index.html"), key=lambda f: f.stat().st_size)
    contract_files = {r.lstrip("/") for r in all_routes if not r.endswith("/")}
    served = [t for t in tracked if not any(part.startswith((".", "_")) for part in t.split("/"))]
    return {
        "schema": "room-census-site-baseline/1",
        "source_commit": commit,
        "routes": {"total": len(all_routes), "pages": sum(r.endswith("/") for r in all_routes),
                   "room_pages": len(room_pages),
                   "snapshots": sum(r.startswith("/data/snapshots/") for r in all_routes),
                   "manifests": sum(r.startswith("/data/manifests/") for r in all_routes),
                   "room_data": sum(r.startswith("/data/rooms/") for r in all_routes)},
        "content_types": {k or "(no extension)": list(v) for k, v in CONTENT_TYPES.items()},
        "sizes": {rel: size(rel) for rel in ("index.html", "app.js", "assets/room.css", "assets/room.js",
                                              "rooms/index.html", "data/latest.json", "data/history.csv")},
        "room_page_bytes": {"smallest": room_pages[0].stat().st_size, "largest": room_pages[-1].stat().st_size,
                            "total": sum(f.stat().st_size for f in room_pages)},
        "legacy_only": sorted(t for t in served if t not in contract_files and not t.startswith(("rooms/", "data/"))
                              and t != "index.html"),
    }


if __name__ == "__main__":
    here = Path(__file__).resolve().parent.parent
    if len(sys.argv) in (3, 5) and sys.argv[1] == "--live":
        canonical = sys.argv[4] if len(sys.argv) == 5 and sys.argv[3] == "--canonical" else None
        found = live(sys.argv[2], here, canonical)
        print(f"{len(routes(here))} routes checked at {sys.argv[2]}")
    elif sys.argv[1:] == ["--baseline"]:
        import subprocess
        git = lambda *a: subprocess.run(["git", "-C", str(here), *a], check=True, capture_output=True, text=True).stdout
        doc = baseline(here, git("rev-parse", "HEAD").strip(), git("ls-files").splitlines())
        print(json.dumps(doc, indent=1, sort_keys=True))
        sys.exit(0)
    else:
        found = check(here, LEGACY_BASE)
    print("\n".join(found) or "contract holds")
    sys.exit(1 if found else 0)
