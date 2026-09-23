"""The Astro front end under web/: staging tests, design-token contrast and the built artifact.

The artifact checks run on web/dist when it exists (after `npm run build` in web/). The continuous
integration job that builds web/ before these tests arrives with the CI step of the migration (A7);
until then they run on local builds only. Nothing here installs packages or uses the network."""
import hashlib
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
            with self.subTest(page=self.route(page)):
                self.assertEqual(p.csp, PAGE_CSP)
                self.assertIsNone(contract.csp_problem(p.csp))
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

    def test_navigation_shows_only_ready_destinations(self):
        for page in self.html_pages():
            text = page.read_text(encoding="utf-8")
            nav = re.search(r'<nav aria-label="Primary".*?</nav>', text, re.S).group(0)
            labels = re.findall(r">([^<>]+)</a>", nav)
            with self.subTest(page=self.route(page)):
                self.assertEqual(labels, ["Overview", "Rooms"])
                self.assertNotIn("/did/", text)
        self.assertFalse((DIST / "did").exists())
        for page, current in ((DIST / "index.html", "/"), (DIST / "rooms" / "index.html", "/rooms/")):
            self.assertRegex(page.read_text(encoding="utf-8"), rf'<a href="{current}" aria-current="page"')

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
                ok = (rel.endswith(".html") or re.fullmatch(r"_astro/[\w.-]+\.(css|js)", rel)
                      or rel in contract.REQUIRED_FILES or rel.startswith("data/"))
                self.assertTrue(ok, "not a page, a built asset or public data")
        text = "".join(f.read_text(encoding="utf-8", errors="replace") for f in DIST.rglob("*") if f.suffix in (".html", ".css", ".js"))
        for leak in ("C:\\", "Users\\", "node_modules", "file://"):
            self.assertNotIn(leak, text)


if __name__ == "__main__":
    unittest.main()
