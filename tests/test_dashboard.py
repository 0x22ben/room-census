"""Dashboard room table: every row opens its room page; no inline accordion is left."""
import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CLASSES = ["varied", "mixed", "repetitive"]
NO_PAGE = "zz-no-page"            # listed in latest.json but not in data/rooms/index.json


def rooms():
    out = []
    for i in range(19):
        name = "lobby" if i == 0 else f"room-{i:02d}"
        out.append({"room": name, "class": CLASSES[i % 3], "per_hour": 1000.0 - i * 40, "rate_interval": 900.0 - i * 40,
                    "unique_tpl": 0.5 + i / 50, "eff_senders": 5.0 + i, "reason": "templated texts (40% unique)"})
    out.append({"room": NO_PAGE, "class": "mixed", "per_hour": 1.0, "rate_interval": 0.5, "unique_tpl": 0.7,
                "eff_senders": 3.0, "reason": "few regular senders"})
    return out


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class RowNavigation(unittest.TestCase):
    """The real app.js, run under node with a minimal DOM and driven like a user."""

    @classmethod
    def setUpClass(cls):
        tmp = Path(tempfile.mkdtemp())
        cls.addClassCleanup(shutil.rmtree, tmp, True)
        data = tmp / "data"
        (data / "rooms").mkdir(parents=True)
        listed = rooms()
        (data / "latest.json").write_text(json.dumps({"census": 2, "rooms": listed}), encoding="utf-8")
        (data / "history.csv").write_text("at_utc,census,kind,room\n", encoding="utf-8")
        (data / "rooms" / "index.json").write_text(json.dumps(
            {"schema": "room-census-rooms/1", "rooms": [{"room": r["room"]} for r in listed if r["room"] != NO_PAGE]}),
            encoding="utf-8")
        run = subprocess.run(["node", str(REPO / "tests" / "dashboard_harness.js"), str(REPO / "app.js"), str(tmp)],
                             capture_output=True, text=True, encoding="utf-8", timeout=60)
        if run.returncode != 0:
            raise AssertionError(run.stderr)
        cls.out = json.loads(run.stdout)
        cls.by_rate = [r["room"] for r in sorted(listed, key=lambda r: -r["rate_interval"])]

    def test_no_accordion_is_left(self):
        self.assertEqual(self.out["forbidden"], {"ariaExpandedOrControls": 0, "toggles": 0, "detailRows": 0})

    def test_each_row_points_to_its_room_page_with_a_native_link(self):
        row = self.out["row0"]
        self.assertEqual(self.out["initial"][0], "lobby")
        self.assertEqual((row["href"], row["link"], row["cls"]), ("rooms/lobby/", "rooms/lobby/", "row nav"))
        self.assertEqual(row["focusKey"], "room:lobby")
        self.assertEqual((row["lastCell"], row["lastHidden"]), ("go", "true"))      # decorative arrow, hidden from AT
        self.assertEqual(row["headerCells"], row["cells"])                          # the arrow column has its header cell
        self.assertEqual(self.out["keyboardTargets"], 1)                            # the link only, no duplicate target

    def test_a_click_anywhere_on_the_row_opens_the_page_in_the_same_tab(self):
        for key in ("cellClick", "arrowClick", "badgeClick"):
            with self.subTest(click=key):
                self.assertEqual(self.out[key], ["rooms/lobby/"])

    def test_the_native_link_navigates_once_and_on_its_own(self):
        self.assertEqual(self.out["linkClick"], {"assigned": [], "prevented": False})

    def test_modifiers_middle_button_and_text_selection(self):
        self.assertEqual(self.out["ctrlClick"], {"assigned": [], "opened": [["rooms/lobby/", "_blank", "noopener"]]})
        self.assertEqual(self.out["middleClick"], [])
        self.assertEqual(self.out["selectingClick"], [])

    def test_only_a_room_page_is_ever_opened(self):
        self.assertEqual(self.out["tamperedClicks"], {"assigned": [], "opened": []})

    def test_a_room_without_a_page_keeps_its_old_link_and_is_not_a_navigation_row(self):
        no_page = self.out["noPage"]
        self.assertEqual((no_page["cls"], no_page["link"]), ("row", f"https://technocore.chat/r/{NO_PAGE}"))
        self.assertEqual(self.out["noPageClick"], [])

    def test_only_navigation_rows_show_the_arrow(self):
        no_page = self.out["noPage"]
        # no false affordance: an empty, hidden cell keeps the columns aligned
        self.assertEqual(no_page["arrow"], {"cell": "go", "hidden": "true", "svgs": 0})
        self.assertEqual(no_page["cells"], self.out["row0"]["cells"])
        self.assertEqual(len(self.out["navArrows"]), 19)
        self.assertEqual(set(self.out["navArrows"]), {1})

    def test_sorting_still_works_and_never_navigates(self):
        self.assertEqual(self.out["initial"], self.by_rate[:15])
        self.assertEqual(self.out["sortedAsc"], sorted(self.by_rate)[:15])
        self.assertEqual(self.out["sortedDesc"], sorted(self.by_rate, reverse=True)[:15])
        self.assertEqual(self.out["sortClickNavigated"], [])

    def test_filters_search_and_show_all_still_work(self):
        self.assertTrue(self.out["variedBadges"])
        self.assertEqual(set(self.out["variedBadges"]), {"Varied"})
        self.assertEqual((self.out["limitedCount"], self.out["allCount"]), (15, 20))
        self.assertEqual(self.out["search"], ["lobby"])

    def test_keyboard_focus_stays_on_the_room_link_across_renders(self):
        self.assertEqual(self.out["focusAfterRender"], "room:" + self.out["focusedRoom"])

    def test_insight_cards_still_open_room_pages(self):
        self.assertTrue(self.out["cards"])
        self.assertTrue(all(re.fullmatch(r"rooms/[a-z0-9][a-z0-9_-]*/", c) for c in self.out["cards"]), self.out["cards"])


class Source(unittest.TestCase):
    """What the review asked to remove is gone; the row states exist and move nothing."""

    def setUp(self):
        self.js = (REPO / "app.js").read_text(encoding="utf-8")
        self.html = (REPO / "index.html").read_text(encoding="utf-8")
        self.css = re.search(r"<style>(.*?)</style>", self.html, re.S).group(1)

    def test_accordion_code_is_removed(self):
        for gone in ("aria-expanded", "aria-controls", "state.open", "detailRow", "sparkline", "chevron", 'class: "toggle"'):
            with self.subTest(js=gone):
                self.assertNotIn(gone, self.js)
        for gone in (".toggle", "tr.detail", ".detail ", ".roomcell"):
            with self.subTest(css=gone):
                self.assertNotIn(gone, self.css)

    def test_row_states_are_styled_without_movement(self):
        for rule in ("tbody tr.row.nav { cursor: pointer; }", "tbody tr.row:hover { background: var(--hover); }",
                     "tbody tr.row.nav:active { background:",
                     "tbody tr.row:has(.room-link:focus-visible) { background: var(--hover); }",
                     "tbody tr.row:has(.room-link:focus-visible) td:first-child { box-shadow: inset 3px 0 0 var(--focus); }",
                     ":focus-visible { outline: 2px solid var(--focus)"):
            with self.subTest(rule=rule):
                self.assertIn(rule, self.css)
        # hover, press and focus states of the row may change colours only
        state_rules = [block for block in re.findall(r"([^{}]*\{[^{}]*\})", self.css)
                       if re.search(r"(tr\.row|room-link|\.go)[^{]*:(hover|active|focus-visible|has)", block)]
        self.assertGreaterEqual(len(state_rules), 5)
        for block in state_rules:
            with self.subTest(block=block.strip()[:50]):
                self.assertNotRegex(block, r"transform|margin|font-size|padding-top|border-width")

    def test_the_table_header_does_not_cover_the_first_row(self):
        # a sticky header inside the horizontal scroller sticks to the scroller, not the page, and hid row one
        th_rules = [b for b in re.findall(r"([^{}]*\{[^{}]*\})", self.css) if re.match(r"\s*(/\*.*?\*/\s*)?th\s*\{", b, re.S)]
        self.assertTrue(th_rules)
        for block in th_rules:
            self.assertNotIn("sticky", block.split("{", 1)[1])          # declarations only, not the comment
        self.assertIn(".scroll { overflow-x: auto; }", self.css)

    def test_collapsible_sections_are_untouched(self):
        for section in ('<details open><summary class="trust-summary" id="verify-title">',
                        '<details><summary class="trust-summary" id="provenance-title">',
                        '<details><summary id="agents-title">', '<details><summary id="method-title">'):
            with self.subTest(section=section):
                self.assertIn(section, self.html)


if __name__ == "__main__":
    unittest.main()
