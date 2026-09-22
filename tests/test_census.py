"""Panel selection, failures, interval rates, aggregates and twins, with a fake Technocore."""
import unittest
from datetime import datetime, timedelta, timezone

import room_census as rc
from tests.helpers import FakeTechnocore, install, messages


def room(n=60, senders=10, last_seq=1000, generation=0, **kw):
    return {"last_seq": last_seq, "generation": generation, "messages": messages(n, senders, **kw)}


def ten_hours_ago():
    return (datetime.now(timezone.utc) - timedelta(hours=10)).isoformat()


def previous(names, at=None, last_seq=400):
    return {"schema": rc.SCHEMA, "at_utc": at or ten_hours_ago(),
            "rooms": [{"room": n, "class": "mixed", "last_seq": last_seq, "generation": 0} for n in names]}


class CensusCase(unittest.TestCase):
    def run_census(self, fake, archive=(), tracked=()):
        install(self, fake)
        orig = rc.read_archive
        rc.read_archive = lambda: list(archive)
        self.addCleanup(setattr, rc, "read_archive", orig)
        return rc.build_census({"tracked": list(tracked)})


class Panel(CensusCase):
    def test_previous_panel_survives_a_large_discovery(self):
        old = [f"old{i:02d}" for i in range(30)]
        new = [f"new{i:03d}" for i in range(200)]
        fake = FakeTechnocore(listing=new, rooms={n: room() for n in old + new})
        rec = self.run_census(fake, archive=[previous(old)])
        names = [r["room"] for r in rec["rooms"]]
        self.assertEqual(names[:30], old)
        self.assertEqual(len(names), rc.MAX_PANEL)
        self.assertEqual(rec["coverage"]["dropped_by_limit"], 230 - rc.MAX_PANEL)

    def test_order_is_tracked_then_panel_then_listed_and_deduplicated(self):
        fake = FakeTechnocore(listing=["dev", "kibble", "agents"], rooms={n: room() for n in ("dev", "kibble", "agents", "trading")})
        rec = self.run_census(fake, archive=[previous(["trading", "dev"])],
                              tracked=[{"room": "kibble", "did": "did:key:z6MkX", "seq": 3, "pulses_left": 4}])
        self.assertEqual([(r["room"], r["source"]) for r in rec["rooms"]],
                         [("kibble", "tracked"), ("trading", "panel"), ("dev", "panel"), ("agents", "listed")])

    def test_same_inputs_give_the_same_panel(self):
        make = lambda: FakeTechnocore(listing=[f"r{i:03d}x" for i in range(90)], rooms={})
        a = [r["room"] for r in self.run_census(make())["rooms"]]
        b = [r["room"] for r in self.run_census(make())["rooms"]]
        self.assertEqual(a, b)

    def test_excluded_names_are_counted(self):
        fake = FakeTechnocore(listing=["dev", "mb-inbox", "ea61d65aabc99e2e", "prompt-me"], rooms={"dev": room()})
        cov = self.run_census(fake)["coverage"]
        self.assertEqual((cov["listed"], cov["eligible"], cov["excluded"]), (4, 1, 3))


class Failures(CensusCase):
    def test_every_attempted_room_has_an_outcome(self):
        names = [f"room{i:02d}" for i in range(20)]
        fake = FakeTechnocore(listing=names, rooms={n: room() for n in names}, fail=["room03", "room07"])
        rec = self.run_census(fake)
        cov = rec["coverage"]
        self.assertEqual(cov["attempted"], cov["measured"] + cov["failed"])
        self.assertEqual({f["room"] for f in rec["failures"]}, {"room03", "room07"})
        self.assertEqual(rec["failures"][0]["reason"], "unreachable")

    def test_transient_failure_is_retried(self):
        class Flaky(FakeTechnocore):
            tries = 0

            def __call__(self, path):
                if "/r/dev?" in path:
                    Flaky.tries += 1
                    if Flaky.tries == 1:
                        raise TimeoutError("first attempt fails")
                return super().__call__(path)
        rec = self.run_census(Flaky(listing=["dev"], rooms={"dev": room()}))
        self.assertEqual([r["room"] for r in rec["rooms"]], ["dev"])
        self.assertEqual(rec["failures"], [])

    def test_invalid_payload_is_a_failure_not_a_crash(self):
        fake = FakeTechnocore(listing=["dev"], rooms={"dev": {"messages": "not a list"}})
        rec = self.run_census(fake)
        self.assertEqual(rec["failures"][0]["reason"], "invalid payload")

    def test_partial_flag_above_ten_percent(self):
        names = [f"room{i:02d}" for i in range(10)]
        ok = self.run_census(FakeTechnocore(listing=names, rooms={n: room() for n in names}, fail=["room01"]))
        bad = self.run_census(FakeTechnocore(listing=names, rooms={n: room() for n in names}, fail=["room01", "room02"]))
        self.assertFalse(ok["partial"])      # 1 of 10 is not more than 10%
        self.assertTrue(bad["partial"])      # 2 of 10 is


class IntervalRates(CensusCase):
    def test_rate_between_censuses(self):
        rec = self.run_census(FakeTechnocore(listing=["dev"], rooms={"dev": room(last_seq=1000)}),
                              archive=[previous(["dev"], last_seq=400)])
        hours = rec["coverage"]["interval_hours"]
        self.assertAlmostEqual(hours, 10, places=1)
        self.assertAlmostEqual(rec["rooms"][0]["rate_interval"], 60, delta=0.1)   # 600 messages in 10 hours

    def test_no_interval_rate_when_the_previous_census_is_in_the_future(self):
        future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        rec = self.run_census(FakeTechnocore(listing=["dev"], rooms={"dev": room(last_seq=1000)}),
                              archive=[previous(["dev"], at=future, last_seq=400)])
        self.assertNotIn("rate_interval", rec["rooms"][0])

    def test_no_interval_rate_after_a_reset_or_a_counter_going_back(self):
        for label, data in (("reset", room(last_seq=1000, generation=1)), ("going back", room(last_seq=100))):
            with self.subTest(case=label):
                rec = self.run_census(FakeTechnocore(listing=["dev"], rooms={"dev": data}),
                                      archive=[previous(["dev"], last_seq=400)])
                self.assertNotIn("rate_interval", rec["rooms"][0])

    def test_quiet_room_has_no_metrics(self):
        rec = self.run_census(FakeTechnocore(listing=["dev"], rooms={"dev": room(n=5)}))
        self.assertEqual(rec["rooms"][0]["class"], "quiet")
        self.assertNotIn("per_hour", rec["rooms"][0])


class Aggregates(unittest.TestCase):
    def test_first_census_is_a_baseline(self):
        s = rc.summarize([{"room": "a", "class": "varied", "per_hour": 10},
                          {"room": "b", "class": "repetitive", "per_hour": 90000}])
        self.assertTrue(s["baseline"])
        self.assertIsNone(s["repetitive_share"])
        self.assertEqual((s["active"], s["varied"], s["repetitive"]), (2, 1, 1))

    def test_window_estimates_never_enter_traffic_shares(self):
        s = rc.summarize([{"room": "a", "class": "varied", "rate_interval": 50},
                          {"room": "b", "class": "repetitive", "rate_interval": 150},
                          {"room": "c", "class": "repetitive", "per_hour": 1e6}])
        self.assertFalse(s["baseline"])
        self.assertEqual(s["interval_rooms"], 2)
        self.assertAlmostEqual(s["repetitive_share"], 0.75)
        self.assertAlmostEqual(s["varied_share"] + s["mixed_share"] + s["repetitive_share"], 1.0)

    def test_quiet_rooms_are_not_counted_and_old_labels_are_normalised(self):
        s = rc.summarize([{"room": "a", "class": "quiet"}, {"room": "b", "class": "diverse", "rate_interval": 5}])
        self.assertEqual((s["active"], s["varied"]), (1, 1))


class Twins(unittest.TestCase):
    def test_rooms_sharing_most_senders_are_flagged_both_ways(self):
        shared = {f"s{i}" for i in range(20)}
        rooms = [{"room": "a", "_senders": shared}, {"room": "b", "_senders": shared | {"x"}},
                 {"room": "c", "_senders": {f"c{i}" for i in range(20)}}]
        rc.flag_twins(rooms)
        self.assertEqual((rooms[0].get("twin"), rooms[1].get("twin")), ("b", "a"))
        self.assertNotIn("twin", rooms[2])
        self.assertTrue(all("_senders" not in r for r in rooms))

    def test_small_rooms_are_never_twins(self):
        rooms = [{"room": "a", "_senders": {"x", "y"}}, {"room": "b", "_senders": {"x", "y"}}]
        rc.flag_twins(rooms)
        self.assertTrue(all("twin" not in r for r in rooms))


if __name__ == "__main__":
    unittest.main()
