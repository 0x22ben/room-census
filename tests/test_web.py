"""The Astro front end under web/: staging tests, design-token contrast and the built artifact.

The artifact checks run on web/dist when it exists (after `npm run build` in web/). The web
workflow (.github/workflows/web.yml) builds web/ and then runs this file; the tests workflow runs it
without a build, so the artifact checks skip there. Nothing here installs packages or uses the network."""
import hashlib
import html
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

from tests import site_contract as contract

REPO = Path(__file__).resolve().parent.parent
WEB = REPO / "web"
DIST = WEB / "dist"
DOMAIN = "https://roomcensus.xyz"
PAGE_CSP = ("default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; "
            "base-uri 'none'; form-action 'none'; object-src 'none'")
# My DID is the only page that may connect out, and only to Technocore's public read API
DID_CSP = PAGE_CSP.replace("connect-src 'self'", "connect-src 'self' https://technocore.chat")
DID_DISCLAIMER = ("This page summarizes public Technocore activity. It does not determine ownership, reputation or "
                  "eligibility for any reward.")
BUILT = (DIST / "index.html").is_file()


def blob(rel):
    """Bytes of a file as committed (Git blob), independent of checkout line endings."""
    return subprocess.run(["git", "-C", str(REPO), "cat-file", "blob", f"HEAD:{rel}"],
                          check=True, capture_output=True).stdout


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class Staging(unittest.TestCase):
    def test_staging_tests_pass(self):
        files = sorted(str(p) for p in (WEB / "tests").glob("*.test.mjs"))
        self.assertTrue(files)
        r = subprocess.run(["node", "--test", *files], cwd=WEB, capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(r.returncode, 0, r.stdout[-3000:] + r.stderr[-2000:])
        self.assertRegex(r.stdout, r"# fail 0")


class Project(unittest.TestCase):
    def test_versions_are_pinned_and_install_scripts_are_off(self):
        pkg = (WEB / "package.json").read_text(encoding="utf-8")
        self.assertRegex(pkg, r'"astro": "\d+\.\d+\.\d+"')
        self.assertTrue((WEB / "package-lock.json").is_file())
        npmrc = (WEB / ".npmrc").read_text(encoding="utf-8").split()
        for rule in ("save-exact=true", "ignore-scripts=true", "engine-strict=true"):
            self.assertIn(rule, npmrc)

    def test_production_is_built_for_the_domain_root(self):
        config = (WEB / "astro.config.mjs").read_text(encoding="utf-8")
        self.assertIn(f'site: "{DOMAIN}"', config)
        self.assertNotRegex(config, r"\bbase\s*:")
        self.assertIn('publicDir: "./.public"', config)

    def test_no_cname_file(self):
        """The custom domain is a repository Pages setting; GitHub ignores a CNAME file for Actions deployments."""
        found = [p for p in (list(WEB.rglob("CNAME")) + [REPO / "CNAME"]) if p.exists() and "node_modules" not in p.parts]
        self.assertEqual(found, [])

    # anything that could publish the site or write to the repository from a workflow
    DEPLOYING = (r"deploy-pages", r"upload-pages-artifact", r"configure-pages", r"write-all",
                 r"\b(pages|contents|id-token|deployments|actions)\s*:\s*['\"]?write", r"git\s+push", r"gh-pages")

    def test_no_active_pages_deployment(self):
        workflows = sorted((REPO / ".github" / "workflows").glob("*.y*ml"))
        self.assertTrue(workflows)
        for wf in workflows:
            text = wf.read_text(encoding="utf-8")
            for pattern in self.DEPLOYING:
                with self.subTest(workflow=wf.name, pattern=pattern):
                    self.assertIsNone(re.search(pattern, text, re.I))

    def test_the_deployment_guard_catches_each_form(self):
        for example in ("uses: actions/deploy-pages@v4", "pages: 'write'", "permissions: write-all",
                        "contents: write", "id-token: \"write\"", "run: git push origin HEAD:gh-pages"):
            with self.subTest(example=example):
                self.assertTrue(any(re.search(p, example, re.I) for p in self.DEPLOYING))


def luminance(hex_color):
    rgb = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast(a, b):
    hi, lo = sorted((luminance(a), luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


class Tokens(unittest.TestCase):
    TEXT = ("--color-text", "--color-text-secondary", "--color-text-muted", "--color-link", "--color-accent",
            "--color-varied", "--color-mixed", "--color-repetitive")
    BACKGROUNDS = ("--color-bg", "--color-surface", "--color-surface-raised")

    def schemes(self):
        css = (WEB / "src" / "styles" / "tokens.css").read_text(encoding="utf-8")
        dark = css.split("@media (prefers-color-scheme: light)")[0]
        light = css.split("@media (prefers-color-scheme: light)")[1].split("@media")[0]
        read = lambda block: dict(re.findall(r"(--color-[a-z-]+):\s*(#[0-9a-f]{6});", block))
        base = read(dark)
        return {"dark": base, "light": {**base, **read(light)}}

    def test_text_colors_reach_4_5_to_1_on_every_background(self):
        for scheme, tokens in self.schemes().items():
            for fg in self.TEXT:
                for bg in self.BACKGROUNDS:
                    with self.subTest(scheme=scheme, fg=fg, bg=bg):
                        self.assertGreaterEqual(contrast(tokens[fg], tokens[bg]), 4.5)
            with self.subTest(scheme=scheme, pair="on-accent"):
                self.assertGreaterEqual(contrast(tokens["--color-on-accent"], tokens["--color-accent"]), 4.5)
            # tinted surfaces: the verified status pill and the warning messages
            for fg, bg in (("--color-text", "--color-accent-soft"), ("--color-accent", "--color-accent-soft"),
                           ("--color-text", "--color-warning-soft"), ("--color-warning", "--color-warning-soft")):
                with self.subTest(scheme=scheme, fg=fg, bg=bg):
                    self.assertGreaterEqual(contrast(tokens[fg], tokens[bg]), 4.5)

    def test_focus_ring_is_visible_on_every_background(self):
        for scheme, tokens in self.schemes().items():
            for bg in self.BACKGROUNDS:
                with self.subTest(scheme=scheme, bg=bg):
                    self.assertGreaterEqual(contrast(tokens["--color-focus"], tokens[bg]), 3)

    def test_motion_is_short_and_can_be_turned_off(self):
        css = (WEB / "src" / "styles" / "tokens.css").read_text(encoding="utf-8")
        for ms in re.findall(r"--motion-[a-z]+:\s*(\d+)ms", css.split("prefers-reduced-motion")[0]):
            self.assertTrue(150 <= int(ms) <= 250, ms)
        self.assertIn("prefers-reduced-motion: reduce", css)


@unittest.skipUnless(BUILT, "web/dist is not built")
class Artifact(unittest.TestCase):
    def html_pages(self):
        return sorted(DIST.rglob("*.html"))

    def route(self, page):
        rel = page.relative_to(DIST).as_posix()
        return "/" if rel == "index.html" else "/" + rel[: -len("index.html")] if rel.endswith("/index.html") else "/" + rel

    def test_every_page_carries_the_strict_policy_and_no_inline_code(self):
        for page in self.html_pages():
            text = page.read_text(encoding="utf-8")
            p = contract.parse(page)
            route = self.route(page)
            with self.subTest(page=route):
                self.assertEqual(p.csp, DID_CSP if route == "/did/" else PAGE_CSP)
                self.assertIsNone(contract.csp_problem(p.csp.replace(" https://technocore.chat", "") if route == "/did/" else p.csp))
                self.assertEqual(p.inline_scripts, 0)
                self.assertNotRegex(text, r"<style[\s>]")
                self.assertNotRegex(text, r"\sstyle=")
                self.assertNotRegex(text, r"\son[a-z]+=")

    def test_resources_and_links_stay_inside_the_site(self):
        for page in self.html_pages():
            p = contract.parse(page)
            route = self.route(page)
            for res in p.resources:
                with self.subTest(page=route, resource=res):
                    if not res.startswith("data:"):
                        target = contract.resolve(DIST, route, res)
                        self.assertIsNotNone(target, "external resource")
                        self.assertTrue(target.is_file(), "resource does not resolve")
            for href in p.links:
                target = contract.resolve(DIST, route, href)
                if target is not None:
                    with self.subTest(page=route, link=href):
                        self.assertTrue(target.is_file(), "broken internal link")

    def test_canonical_urls_use_the_domain_root(self):
        for page in self.html_pages():
            route = self.route(page)
            with self.subTest(page=route):
                if route == "/404.html":
                    self.assertIsNone(contract.parse(page).canonical)
                else:
                    self.assertEqual(contract.parse(page).canonical, DOMAIN + route)

    def nav_links(self, text, label):
        """(href, visible text, current) of every link of the navigation landmark named `label`."""
        nav = re.search(rf'<nav aria-label="{label}".*?</nav>', text, re.S).group(0)
        out = []
        for attrs, inner in re.findall(r"<a([^>]*)>(.*?)</a>", nav, re.S):
            href = re.search(r'href="([^"]*)"', attrs).group(1)
            out.append((href, re.sub(r"<[^>]+>", "", inner).strip(), 'aria-current="page"' in attrs))
        return out

    def test_navigation_shows_only_pages_that_exist(self):
        for page in self.html_pages():
            text = page.read_text(encoding="utf-8")
            route = self.route(page)
            for label in ("Primary", "Menu"):
                links = self.nav_links(text, label)
                with self.subTest(page=route, nav=label):
                    self.assertEqual([t for _, t, _ in links], ["Discover rooms", "All rooms", "Watched rooms", "My DID", "Source code"])
                    for href, _, _ in links:
                        if href.startswith("/"):
                            self.assertTrue(contract.resolve(DIST, route, href).is_file(), href)
                    current = [h for h, _, on in links if on]
                    expected = (["/"] if route == "/" else ["/rooms/"] if route.startswith("/rooms/")
                                else ["/watched/"] if route == "/watched/" else ["/did/"] if route == "/did/" else [])
                    self.assertEqual(current, expected)
            with self.subTest(page=route):
                # pages that do not exist yet are never linked, in any form (data files under /data/ are)
                self.assertIsNone(re.search(r'href="(https?://[^"/]+)?/(verify|method)(/[^"]*)?"', text))
                self.assertIsNone(re.search(r'href="(https?://[^"/]+)?/data/?"', text))
        for gated in ("verify", "method"):
            self.assertFalse((DIST / gated).exists())

    def test_the_overview_keeps_the_anchors_signed_messages_link_to(self):
        ids = contract.parse(DIST / "index.html").ids
        for anchor in contract.ANCHORS["/"]:
            self.assertIn(anchor, ids)

    def test_the_overview_numbers_come_from_the_published_data(self):
        text = (DIST / "index.html").read_text(encoding="utf-8")
        latest = json.loads((DIST / "data" / "latest.json").read_text(encoding="utf-8"))
        spec = json.loads(html.unescape(re.search(r'data-chart="([^"]+)"', text).group(1)))
        self.assertEqual(spec["labels"], [f"#{i}" for i in range(1, latest["census"] + 1)])
        last = {s["label"]: s["values"][-1] for s in spec["series"]}
        for label, cls in (("Different", "varied"), ("Mixed", "mixed"), ("Repeated", "repetitive")):
            self.assertEqual(last[label], latest["summary"][cls])
        active = sorted((r for r in latest["rooms"] if r["class"] != "quiet"), key=lambda r: -(r.get("rate_interval") or -1))
        table = re.search(r'<section id="rooms".*?</section>', text, re.S).group(0)
        shown = re.findall(r'href="/rooms/([a-z0-9_-]+)/"', table)
        self.assertEqual(shown, [r["room"] for r in active[:8]])
        self.assertIn(f'{round(latest["summary"]["repetitive_share"] * 100)}%', text)

    def test_scripts_are_external_modules_and_only_where_needed(self):
        """Charts and the room filters need script; every other page works without any."""
        for page in self.html_pages():
            text = page.read_text(encoding="utf-8")
            scripts = re.findall(r"<script\b([^>]*)>", text)
            with self.subTest(page=self.route(page)):
                for attrs in scripts:
                    self.assertRegex(attrs, r'type="module" src="/_astro/[\w.-]+\.js"')
                needed = sum(hook in text for hook in ("data-chart=", "data-room-filters", "data-visit=", "data-watched ", "data-did-form "))
                self.assertEqual(len(scripts), needed)

    def test_the_built_site_meets_the_legacy_route_contract(self):
        """Same routes, anchors, data files and link integrity as the legacy site, at the domain root."""
        self.assertEqual(contract.check(DIST, contract.DOMAIN_BASE), [])

    def test_room_pages_show_gaps_and_stale_rooms_honestly(self):
        index = json.loads((DIST / "data" / "rooms" / "index.json").read_text(encoding="utf-8"))["rooms"]
        for entry in index:
            doc = json.loads((DIST / entry["data"]).read_text(encoding="utf-8"))
            text = (DIST / entry["page"] / "index.html").read_text(encoding="utf-8")
            history = re.search(r'<section id="history".*?</section>', text, re.S).group(0)
            rows = re.findall(r"<tr class=\"border-b border-border last:border-0\">(.*?)</tr>", history, re.S)
            with self.subTest(room=entry["room"]):
                self.assertEqual(len(rows), doc["censuses_total"])
                for row, point in zip(rows, reversed(doc["history"])):
                    cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)
                    self.assertIn(f"#{point['census']}<", row)
                    if point["rate_interval"] is None:
                        self.assertIn("–", cells[2], "a missing rate must be shown as missing, never as zero")
                self.assertEqual("Figures below are from census" in text or "The figures below are from census" in text, not doc["current"])
                self.assertIn(f'href="{doc["technocore"]}"', text)

    def test_the_method_text_matches_the_code_that_classifies(self):
        import room_census as rc
        text = re.sub(r"<[^>]+>", "", (DIST / "index.html").read_text(encoding="utf-8"))
        v, r = rc.VARIED, rc.REPETITIVE
        pc = lambda x: f"{round(x * 100)}%"
        for needle in (f"at least {pc(v['unique_tpl'])} different messages", f"at least {pc(v['repeat_share'])} of messages from senders",
                       f"no sender above {pc(v['top_share'])}", f"at least {v['eff_senders']} effective senders",
                       f"under {pc(r['unique_tpl'])} different messages", f"one sender writing {pc(r['top_share'])} or more",
                       f"under {pc(r['repeat_share'])} of messages from senders", f"fewer than {rc.MIN_WINDOW} recent messages",
                       f"windows of {rc.WINDOW} messages"):
            with self.subTest(needle=needle):
                self.assertIn(needle, text)

    def test_a_measured_rate_is_never_shown_as_zero(self):
        for entry in json.loads((DIST / "data" / "rooms" / "index.json").read_text(encoding="utf-8"))["rooms"]:
            doc = json.loads((DIST / entry["data"]).read_text(encoding="utf-8"))
            text = (DIST / entry["page"] / "index.html").read_text(encoding="utf-8")
            history = re.search(r'<section id="history".*?</section>', text, re.S).group(0)
            rows = re.findall(r"<tr class=\"border-b border-border last:border-0\">(.*?)</tr>", history, re.S)
            for row, point in zip(rows, reversed(doc["history"])):
                shown = re.sub(r"<[^>]+>", "", re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)[2]).strip()
                if point["rate_interval"]:
                    with self.subTest(room=entry["room"], census=point["census"]):
                        self.assertNotEqual(shown, "0")

    def test_the_licenses_page_publishes_the_official_texts(self):
        text = html.unescape((DIST / "licenses" / "index.html").read_text(encoding="utf-8"))
        shipped = {"@fontsource-variable/inter": "LICENSE", "@fontsource/ibm-plex-mono": "LICENSE", "chart.js": "LICENSE.md",
                   "@kurkle/color": "LICENSE.md", "@lucide/astro": "LICENSE", "tailwindcss": "LICENSE", "astro": "LICENSE"}
        for name, file in shipped.items():
            with self.subTest(package=name):
                official = (WEB / "node_modules" / name / file).read_text(encoding="utf-8").strip()
                self.assertIn(official, text)
        for own in (REPO / "LICENSE", REPO / "data" / "LICENSE"):
            with self.subTest(file=own.name):
                self.assertIn(own.read_text(encoding="utf-8").strip().replace("\r\n", "\n"), text)
        self.assertEqual(text.count("SIL OPEN FONT LICENSE"), 2, "both self-hosted fonts ship their OFL text")
        for page in self.html_pages():
            with self.subTest(page=self.route(page)):
                self.assertIn('href="/licenses/"', page.read_text(encoding="utf-8"))

    # claims the census cannot prove, and internal class names, must never reach a reader
    FORBIDDEN = (r"human conversation", r"human-like", r"bot detected", r"\bbots?\b", r"authentic traffic",
                 r"quality room", r"healthy room", r"varied traffic", r"traffic quality", r"human activity",
                 r"airdrop", r"eligib", r"reputation score", r"real conversation", r"\bvaried\b", r"\brepetitive\b")

    # daily censuses cannot show live or hourly activity, and a signature is not a verification
    OVERCLAIM = (r"\bactive now\b", r"\blive activity\b", r"\bright now\b", r"\brising\b", r"\bverified\b",
                 r"\bin the last \d+ hours?\b", r"\bplanned\b", r"where people post")

    def visible_text(self, page):
        text = page.read_text(encoding="utf-8")
        text = re.sub(r"<(script|template)\b.*?</\1>", " ", text, flags=re.S)
        # words a reader or a search engine gets from attributes: descriptions, titles, alt texts, accessible names
        said = re.findall(r'\b(?:aria-label|content|title|alt|placeholder)="([^"]*)"', text)
        text = re.sub(r"<[^>]*>", " ", text)                     # other tags and attributes are data, not words
        return html.unescape(text + " " + " ".join(said)).replace(DID_DISCLAIMER, " ")

    def test_no_forbidden_or_internal_wording_reaches_a_reader(self):
        for page in self.html_pages():
            text = self.visible_text(page)
            for pattern in self.FORBIDDEN + self.OVERCLAIM:
                with self.subTest(page=self.route(page), pattern=pattern):
                    self.assertIsNone(re.search(pattern, text, re.I))
        # text the scripts insert at runtime: every string literal of every built script. The internal
        # class names stay allowed there (data keys and color classes); labels come from lib/patterns.ts
        claims = [p for p in self.FORBIDDEN if p not in (r"\bvaried\b", r"\brepetitive\b")]
        for script in DIST.glob("_astro/*.js"):
            code = script.read_text(encoding="utf-8")
            strings = " ".join(a or b for a, b in re.findall(r'"([^"\n]*)"|`([^`]*)`', code)).replace(DID_DISCLAIMER, " ")
            for pattern in claims + list(self.OVERCLAIM):
                with self.subTest(script=script.name, pattern=pattern):
                    self.assertIsNone(re.search(pattern, strings, re.I))

    def test_every_page_carries_the_message_pattern_disclaimer_where_patterns_show(self):
        disclaimer = "They do not prove whether a message was written by a human or an automated agent."
        marks = re.compile(r'data-pattern=|data-watched |data-filter="varied"')
        showing = [p for p in self.html_pages() if marks.search(p.read_text(encoding="utf-8"))]
        self.assertGreater(len(showing), 3)
        for page in showing:
            with self.subTest(page=self.route(page)):
                self.assertIn(disclaimer, self.visible_text(page))

    def test_the_watched_page_keeps_the_list_in_the_browser(self):
        text = (DIST / "watched" / "index.html").read_text(encoding="utf-8")
        data = json.loads(html.unescape(re.search(r'data-rooms="([^"]+)"', text).group(1)))
        index = json.loads((DIST / "data" / "rooms" / "index.json").read_text(encoding="utf-8"))["rooms"]
        self.assertEqual(sorted(data), sorted(r["room"] for r in index))
        self.assertIn("Saved only in this browser", text)
        self.assertRegex(text, r"<section data-watched [^>]*hidden")
        self.assertIn("needs JavaScript", text)
        for room_page in (DIST / "rooms").glob("*/index.html"):
            page = room_page.read_text(encoding="utf-8")
            with self.subTest(room=room_page.parent.name):
                self.assertRegex(page, r'<button type="button" data-watch="[a-z0-9_-]+" aria-pressed="false" hidden')
                self.assertIn('data-watch-note role="status"', page)
        store = next(DIST.glob("_astro/watch-store*.js")).read_text(encoding="utf-8")
        self.assertIn("localStorage", store)
        self.assertNotRegex(store, r"fetch\(|XMLHttpRequest|sendBeacon|navigator\.send")

    def test_my_did_runs_in_the_browser_and_says_what_it_inspected(self):
        text = (DIST / "did" / "index.html").read_text(encoding="utf-8")
        latest = json.loads((DIST / "data" / "latest.json").read_text(encoding="utf-8"))
        identity = json.loads((DIST / "identity.json").read_text(encoding="utf-8"))
        visible = self.visible_text(DIST / "did" / "index.html")
        # the lookup needs script: without it the form stays hidden, and the policy blocks any submit
        self.assertRegex(text, r"<form data-did-form [^>]*hidden")
        self.assertIn("form-action 'none'", DID_CSP)
        self.assertIn("The lookup needs JavaScript", text)
        self.assertIn(DID_DISCLAIMER, html.unescape(text))
        self.assertIn("not sent to Room Census and is not stored", visible)
        # the rooms read are exactly the latest census plus the room where Room Census signs
        rooms = json.loads(html.unescape(re.search(r'data-rooms="([^"]+)"', text).group(1)))
        self.assertEqual(rooms, [r["room"] for r in latest["rooms"]] + [identity["room"]])
        self.assertIn(f'the newest 200 messages of each of the {len(latest["rooms"])} rooms in census #{latest["census"]}', visible)
        self.assertIn("Older messages, other rooms and private rooms are not inspected", visible)
        # it never claims a full history, and it keeps "not found" apart from "no activity"
        script = next(DIST.glob("_astro/did.astro*.js")).read_text(encoding="utf-8")
        for claim in ("Total messages", "First seen", "Rooms visited", "Contest"):
            self.assertNotIn(claim, script + text)
        for phrase in ("Recent activity found in measured rooms", "Not found in the inspected data",
                       "This does not mean the DID has no activity"):
            self.assertIn(phrase, script)
        # it reads Technocore and nothing else, and keeps nothing
        self.assertIn("https://technocore.chat", script + "".join(p.read_text(encoding="utf-8") for p in DIST.glob("_astro/did-core*.js")))
        self.assertNotRegex(script, r"localStorage|sessionStorage|indexedDB|sendBeacon|XMLHttpRequest|document\.cookie")
        for page in self.html_pages():
            if self.route(page) != "/did/":
                with self.subTest(page=self.route(page)):
                    self.assertNotIn("technocore.chat https", contract.parse(page).csp or "")
                    self.assertNotIn("connect-src 'self' https", contract.parse(page).csp or "")

    def test_the_rooms_index_lists_every_room_with_filters_that_need_script(self):
        text = (DIST / "rooms" / "index.html").read_text(encoding="utf-8")
        index = json.loads((DIST / "data" / "rooms" / "index.json").read_text(encoding="utf-8"))["rooms"]
        listed = re.findall(r'<tr data-room="([^"]+)"', text)
        self.assertEqual(sorted(listed), sorted(r["room"] for r in index))
        self.assertRegex(text, r"<div data-room-filters hidden")

    def test_the_census_status_never_claims_more_than_the_data(self):
        latest = json.loads((DIST / "data" / "latest.json").read_text(encoding="utf-8"))
        complete = not latest["partial"] and latest["signed_in"] is not None and latest["provenance"] is not None
        expected = f"Census #{latest['census']} " + ("signed" if complete else "incomplete")
        for page in self.html_pages():
            text = page.read_text(encoding="utf-8")
            with self.subTest(page=self.route(page)):
                self.assertIn(expected, text)
                self.assertNotRegex(text, r"(?i)census #\d+ verified")
                self.assertNotIn("passed every public check", text)

    def test_the_mobile_menu_and_the_help_work_without_script(self):
        for page in self.html_pages():
            text = page.read_text(encoding="utf-8")
            with self.subTest(page=self.route(page)):
                self.assertRegex(text, r'<details[^>]*>\s*<summary aria-label="Menu"')
                ids = re.findall(r'<span id="([^"]+)" popover', text)
                targets = re.findall(r'popovertarget="([^"]+)"', text)
                self.assertTrue(targets, "no help on the page")
                self.assertEqual(len(ids), len(set(ids)), "duplicate popover id")
                self.assertEqual(sorted(targets), sorted(ids), "every help button opens its own popover")
                labels = re.findall(r'popovertarget="[^"]+"[^>]*aria-label="([^"]+)"', text)
                self.assertEqual(len(labels), len(targets), "every help button has a spoken question")
                for label in labels:
                    self.assertTrue(label.endswith("?") and len(label) > 8, label)

    def test_public_data_is_published_byte_for_byte(self):
        staged = [p for p in DIST.rglob("*") if p.is_file() and p.relative_to(DIST).parts[0] in ("data", "identity.json", "llms.txt")]
        self.assertGreater(len(staged), 60)
        for f in staged:
            rel = f.relative_to(DIST).as_posix()
            with self.subTest(file=rel):
                self.assertEqual(hashlib.sha256(f.read_bytes()).hexdigest(), hashlib.sha256(blob(rel)).hexdigest())

    def test_the_artifact_holds_nothing_unexpected(self):
        for f in DIST.rglob("*"):
            if not f.is_file():
                continue
            rel = f.relative_to(DIST).as_posix()
            with self.subTest(file=rel):
                self.assertFalse(rel.endswith(".map"), "source map")
                ok = (rel.endswith(".html") or re.fullmatch(r"_astro/[\w.-]+\.(css|js|woff2?)", rel)
                      or rel in contract.REQUIRED_FILES or rel.startswith("data/"))
                self.assertTrue(ok, "not a page, a built asset or public data")
        text = "".join(f.read_text(encoding="utf-8", errors="replace") for f in DIST.rglob("*") if f.suffix in (".html", ".css", ".js"))
        for leak in ("C:\\", "Users\\", "node_modules", "file://"):
            self.assertNotIn(leak, text)


if __name__ == "__main__":
    unittest.main()
