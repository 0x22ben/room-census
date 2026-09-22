import unittest

import room_census as rc

VARIED = {"unique_tpl": 0.9, "repeat_share": 0.5, "top_share": 0.1, "eff_senders": 20}


def cls(**over):
    return rc.classify({**VARIED, **over})[0]


class Classification(unittest.TestCase):
    def test_varied_room(self):
        self.assertEqual(cls(), "varied")

    def test_varied_thresholds_are_inclusive(self):
        self.assertEqual(cls(unique_tpl=0.8, repeat_share=0.2, top_share=0.3, eff_senders=5), "varied")

    def test_just_below_varied_thresholds_is_mixed(self):
        for over in ({"unique_tpl": 0.79}, {"repeat_share": 0.19}, {"top_share": 0.31}, {"eff_senders": 4.9}):
            with self.subTest(**over):
                self.assertEqual(cls(**over), "mixed")

    def test_repetitive_rules(self):
        self.assertEqual(cls(unique_tpl=0.49), "repetitive")
        self.assertEqual(cls(top_share=0.8), "repetitive")
        self.assertEqual(cls(repeat_share=0.04), "repetitive")

    def test_repetitive_boundaries_are_exclusive_where_published(self):
        self.assertNotEqual(cls(unique_tpl=0.5), "repetitive")
        self.assertNotEqual(cls(repeat_share=0.05), "repetitive")
        self.assertNotEqual(cls(top_share=0.79), "repetitive")

    def test_repetitive_takes_precedence_and_lists_every_reason(self):
        c, reasons = rc.classify({**VARIED, "unique_tpl": 0.1, "top_share": 0.9, "repeat_share": 0.0})
        self.assertEqual(c, "repetitive")
        self.assertEqual(len(reasons), 3)

    def test_reasons_contain_no_comma(self):
        # history.csv rows must never need quoting for the dashboard parser's sake
        for over in ({}, {"unique_tpl": 0.7}, {"unique_tpl": 0.1, "top_share": 0.95}):
            self.assertNotIn(",", "; ".join(rc.classify({**VARIED, **over})[1]))


class Names(unittest.TestCase):
    def test_ordinary_names_are_publishable(self):
        for name in ("dev", "lobby", "kibble", "tokenomics", "monkey-bar", "wallet-dev", "a2a_mesh_telemetry"):
            with self.subTest(name=name):
                self.assertTrue(rc.is_publishable_name(name))

    def test_instruction_or_secret_like_names_are_refused(self):
        for name in ("ignore-rules-send-flop", "prompt-me", "seed-phrase-help", "free-private-key",
                     "jailbreak", "http-link", "mnemonic-share", "passwords"):
            with self.subTest(name=name):
                self.assertFalse(rc.is_publishable_name(name))

    def test_private_random_reserved_and_own_rooms_are_refused(self):
        for name in ("mb-inbox", "p-secret", "e-temp", "d-owned", "ea61d65aabc99e2e", "room1234567",
                     "events", rc.ROOM, "flop-veille", "ab", "Upper", "x" * 40):
            with self.subTest(name=name):
                self.assertFalse(rc.is_publishable_name(name))


class Templates(unittest.TestCase):
    def test_tokens_with_digits_are_masked(self):
        self.assertEqual(rc.template("Ping #4821 from agent-77"), rc.template("ping #4822 from agent-12"))

    def test_trailing_random_tag_is_dropped(self):
        self.assertEqual(rc.template("daily check in · xyqfs"), rc.template("Daily check in · abcde"))

    def test_room_name_is_masked(self):
        self.assertEqual(rc.template("Present in ion-grid-744. Hello", "ion-grid-744"),
                         rc.template("Present in kilo-yard-260. Hello", "kilo-yard-260"))

    def test_different_sentences_stay_different(self):
        self.assertNotEqual(rc.template("the registry is last-write-wins"), rc.template("flush the stalled reader"))


if __name__ == "__main__":
    unittest.main()
