"""Builds the sample data of the Contests pages from one real export of the witness.

Usage: python scripts/contests-sample.py <folder holding index.json and close-1.ranking.json>
Writes src/fixtures/contests.sample.json and src/fixtures/close-1.ranking.sample.json. The pages read the
sample only when the site has no data/contests/ (a fresh checkout) and then say "Sample data" on every page.
The sample keeps the exact format of the live export, so the pages are tested against what they will read.
"""
import json, sys
from pathlib import Path

SRC = Path(sys.argv[1])
OUT = Path(__file__).resolve().parents[1] / "src" / "fixtures"

index = json.loads((SRC / "index.json").read_text(encoding="utf-8"))
ranking = json.loads((SRC / "close-1.ranking.json").read_text(encoding="utf-8"))
for c in index["contests"]:
    if c.get("ranking"):
        c["ranking"]["file"] = f"/contests/{c['id']}/ranking.json"  # served by the sample-only route
OUT.mkdir(parents=True, exist_ok=True)
(OUT / "contests.sample.json").write_text(json.dumps({**index, "sample": True}, indent=1) + "\n", encoding="utf-8")
(OUT / "close-1.ranking.sample.json").write_text(json.dumps({**ranking, "sample": True}, separators=(",", ":")) + "\n", encoding="utf-8")
print("sample written:", index["captured_at"], ranking["sweep"], len(ranking["rows"]))
