"""Signed track / untrack requests read from the census room."""
import unittest

import room_census as rc
from tests.helpers import FakeTechnocore, install

ME = "did:key:z6MkOWN"
D = lambda i: f"did:key:z6Mk{i}AAAAAAAAAAzz{i}"


def msg(seq, text, sender=None, signed=True):
    return {"seq": seq, "from": sender or D(1), "sig": "x" * 86 if signed else None, "text": text}


class Requests(unittest.TestCase):
    def apply(self, msgs, state=None, generation=0, existing=("kibble", "dev", "flop", "meta", "lobby")):
        rooms = {n: {"messages": [{}, {}]} for n in existing}
        install(self, FakeTechnocore(rooms=rooms, veille={"generation": generation, "messages": msgs}))
        return rc.apply_requests(state or {"last_seq": 0, "generation": 0, "tracked": []}, ME)

    def test_exact_command_is_accepted(self):
        state, accepted, refused = self.apply([msg(3, "track kibble")])
        self.assertEqual([t["room"] for t in state["tracked"]], ["kibble"])
        self.assertEqual((len(accepted), refused), (1, 0))

    def test_commands_inside_sentences_are_ignored(self):
        state, accepted, refused = self.apply([msg(3, "don't track lobby"), msg(4, "track dev and track meta")])
        self.assertEqual((state["tracked"], accepted, refused), ([], [], 0))

    def test_unsigned_own_and_nick_messages_are_ignored(self):
        state, _, _ = self.apply([msg(3, "track dev", signed=False), msg(4, "track dev", sender=ME),
                                  msg(5, "track dev", sender="bob")])
        self.assertEqual(state["tracked"], [])

    def test_at_most_three_new_requests_per_census(self):
        state, accepted, refused = self.apply([msg(i, f"track {n}", sender=D(i)) for i, n in
                                               enumerate(["kibble", "dev", "flop", "meta"], start=3)])
        self.assertEqual((len(state["tracked"]), refused), (3, 1))

    def test_full_slots_refuse_instead_of_evicting(self):
        full = {"last_seq": 0, "generation": 0,
                "tracked": [{"room": f"r{i}xx", "did": D(9), "seq": 1, "pulses_left": 4} for i in range(5)]}
        state, accepted, refused = self.apply([msg(3, "track kibble")], state=full)
        self.assertEqual(([t["room"] for t in state["tracked"]], refused), ([f"r{i}xx" for i in range(5)], 1))

    def test_two_rooms_per_did(self):
        state, _, refused = self.apply([msg(3, "track kibble"), msg(4, "track dev"), msg(5, "track flop")])
        self.assertEqual((len(state["tracked"]), refused), (2, 1))

    def test_unknown_or_unpublishable_rooms_are_refused(self):
        state, _, refused = self.apply([msg(3, "track nowhere"), msg(4, "track mb-inbox", sender=D(2))])
        self.assertEqual((state["tracked"], refused), ([], 2))

    def test_untrack_by_requester_only(self):
        state, accepted, _ = self.apply([msg(3, "track kibble"), msg(4, "untrack kibble", sender=D(2)),
                                         msg(5, "untrack kibble")])
        self.assertEqual((state["tracked"], accepted), ([], []))

    def test_cursor_advances_and_resets_with_generation(self):
        state, _, _ = self.apply([msg(7, "hello")])
        self.assertEqual(state["last_seq"], 7)
        state, _, _ = self.apply([msg(2, "track kibble")], state={"last_seq": 900, "generation": 0, "tracked": []},
                                 generation=1)
        self.assertEqual((state["generation"], [t["room"] for t in state["tracked"]]), (1, ["kibble"]))


if __name__ == "__main__":
    unittest.main()
