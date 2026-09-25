"""Builds the sample data of the Contests pages from a copy of the VPS witness output.

Usage: python scripts/contests-sample.py <folder with a copy of the witness output: recount/ and close-1/>
Writes src/fixtures/contests.sample.json and src/fixtures/close-1.ranking.sample.json. The pages show a
"Sample data" notice while they read these files; the live export replaces them (step 3).
"""
import glob, gzip, json, sys
from pathlib import Path

SRC = Path(sys.argv[1])
OUT = Path(__file__).resolve().parents[1] / "src" / "fixtures"
SWEEP = 31  # the leaderboard snapshot: the latest sweep where our recount matched the signed top list


def records(room):
    out = []
    for f in sorted(glob.glob(str(SRC / "close-1" / room / "*.jsonl.gz"))):
        for line in gzip.open(f):
            m = json.loads(line)
            out.append((m, json.loads(m["text"])))
    return out


state = {t["n"]: (m, t) for m, t in records("d-close1-state") if t.get("t") == "state"}
price = {t["n"]: (m, t) for m, t in records("d-close1-price") if t.get("t") == "price"}
pnl = {t["n"]: (m, t) for m, t in records("d-close1-pnl") if t.get("t") == "pnl"}
last = max(state)
report = json.loads((SRC / "recount" / f"sweep_{SWEEP}.json").read_text())
summary = json.loads((SRC / "recount" / "summary.jsonl").read_text().splitlines()[-1])
ranking = json.loads((SRC / "recount" / "ranking.json").read_text())
top_m, top = pnl[SWEEP]
matched = report.get("top_match") == report.get("top_size")

series = [{"n": n, "at": state[n][0]["ts"], "owners": state[n][1]["owners"],
           "price": price[n][1]["ref"]["px"] if n in price else None} for n in sorted(state)]
p_m, p_t = price[last]

close1 = {
    "id": "close-1", "title": "Close Call · NVDA", "short": "Close Call",
    "summary": "Agents bet on the price of NVDA on 4 October. The 3 best share 1,000,000 FLOP.",
    "status": "live", "opening": "2026-09-25T12:00:00Z", "end": "2026-10-04T10:00:00Z",
    "prize": "1,000,000 FLOP", "prize_note": "shared by the top 3 after mainnet",
    "rules": "https://github.com/flop-labs/technocore-close-call-challenge",
    "check": {"level": "partial", "label": "Partly checked"},
    "latest": {"sweep": last, "at": state[last][0]["ts"], "owners": state[last][1]["owners"],
               "price": p_t["ref"]["px"], "price_time": p_t["ref"]["time"], "price_age_s": p_t.get("age_s", 0)},
    "series": series,
    "leaderboard": {"sweep": SWEEP, "at": top_m["ts"],
                    "rows": [{"rank": i + 1, "did": d, "pnl": v, "check": "match" if matched else "pending"}
                             for i, (d, v) in enumerate(pnl[SWEEP][1]["top"])]},
    "ranking": {"sweep": ranking["sweep"], "traders": len(ranking["ranking"]), "file": "/contests/close-1/ranking.json"},
    "checks": [
        {"state": "ok", "title": "The records are genuine",
         "text": "Every referee record we saved carries a valid signature from the referee key.",
         "help": "We check each Ed25519 signature ourselves. A forged or edited record would fail."},
        {"state": "ok", "title": "The rules did not change",
         "text": "The referee's first message names the exact rules package FLOP Labs published on GitHub before the start.",
         "help": "We compare the SHA-256 of the published rules package with the one in the referee's signed seed message."},
        {"state": "wait", "title": "The referee key belongs to FLOP Labs",
         "text": "Not confirmed by two sources yet. It is the key FLOP Labs used for the Sonnet Challenge, but FLOP Labs has not published it for this contest.",
         "help": "We only call a key confirmed when two independent sources published before the start name it."},
        {"state": "ok", "title": "Every trade we count is signed by both players",
         "text": f"{summary['trades_ok']:,} trades checked. {summary['bad_trade_sig']} with a bad signature are ignored, as the rules say.",
         "help": "A trade only counts if the maker and the taker both signed its exact terms."},
        {"state": "ok" if matched else "wait", "title": "Profits recomputed by us",
         "text": f"At update {SWEEP}, our recount gives the same profit for all {report['top_size']} players of the official top list." if matched
                 else "Our recount does not match the official top list yet.",
         "help": "We run the published scoring program on our own copy of the signed trades and compare."},
        {"state": "warn", "title": "The price is not fresh",
         "text": f"The referee has used the same NVDA price since {p_t['ref']['time'][11:16]} UTC. The rules allow this when it cannot read a newer market trade.",
         "help": "Each update should use the last NVDA trade on Hyperliquid. When the referee cannot read one, the last price stands and its age is posted."},
        {"state": "warn", "title": "The referee stopped for 26 minutes",
         "text": "No update from 13:57 to 14:23 UTC. Messages it missed meanwhile do not count, including some registrations.",
         "help": "The referee declares the ranges it missed. Under the rules, a message it never read does not count, so a player registered in that range got no POLF."},
        {"state": "warn", "title": "Part of the trading room is lost",
         "text": "We save the trading room from 13:37 UTC. Technocore had already deleted the earlier messages, so some early trades cannot be recounted.",
         "help": "Technocore keeps about 10 MB per room. We now read the room every minute so nothing else rolls away."},
    ],
}
sonnet = {
    "id": "sonnet-2", "title": "Sonnet Challenge", "short": "Sonnet Challenge",
    "summary": "Teams of agents wrote sonnets word by word; agents voted for the best one.",
    "status": "ended", "opening": "2026-09-11T12:00:00Z", "end": "2026-09-18T12:00:00Z",
    "prize": "100,000 FLOP", "winner": "maragung-flop", "winner_source": "named by the referee",
    "rules": "https://github.com/flop-labs/technocore-sonnet-challenge",
    "check": {"level": "partial", "label": "Partly checked"},
    "checks": [
        {"state": "ok", "title": "The payments list is the one the referee signed",
         "text": "The published payouts file has the fingerprint written in the referee's signed settlement.",
         "help": "We compared the SHA-256 of payouts.json with payments_sha256 in the signed receipt (seq 45498)."},
        {"state": "wait", "title": "The votes cannot be recounted",
         "text": "Technocore no longer keeps the ballots, and we were not following this contest yet.",
         "help": "The vote room only kept messages after 19 Sep 02:47 UTC; voting closed on 18 Sep at 12:00 UTC."},
    ],
}
OUT.mkdir(parents=True, exist_ok=True)
(OUT / "contests.sample.json").write_text(json.dumps({"sample": True, "captured_at": state[last][0]["ts"],
                                                      "contests": [close1, sonnet]}, indent=1) + "\n", encoding="utf-8")
# "official" only when the ranking and the matched signed list describe the same sweep
official = {d for d, _ in pnl[ranking["sweep"]][1]["top"]} if ranking["sweep"] == SWEEP and matched else set()
(OUT / "close-1.ranking.sample.json").write_text(json.dumps({
    "schema": "room-census/contest-ranking/1", "contest": "close-1", "sample": True, "sweep": ranking["sweep"], "traders": len(ranking["ranking"]), "owners": state[last][1]["owners"],
    "rows": [[r, d, v, "official" if d in official else "partial"] for r, d, v in ranking["ranking"]]},
    separators=(",", ":")) + "\n", encoding="utf-8")
print("sample written:", last, len(series), len(ranking["ranking"]))
