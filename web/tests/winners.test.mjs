// The Winners section of a paid contest: totals, the winning entry and its authors, the voters' amounts,
// and the answers of "Was my DID paid?", on a small case and on Sonnet's real payout list.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { eachLabel, paidAnswer, winnersOf } from "../src/lib/winners.mjs";

const A = "did:key:z6MkeZAT641SbbXmAUqP8yZe2UqpFnRLC9XihYkQR2EherwJ";
const B = "did:key:z6MkopM1Tnu15FjebpaqidcWGHC7A9XHVmEsQL9HnQxcvxHr";
const V1 = "did:key:z6Mkfw79DoBMgePecy4YaXSSimwzHKYz8sB3JB9X7bKSXMkG";
const V2 = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

test("a small list: totals, authors in order, voters with a range", () => {
  const payouts = new Map([[A, 100], [V1, 3], [B, 100], [V2, 5]]);
  const roles = new Map([[A, { role: "contributor", entry: "team" }], [V1, { role: "voter", entry: "team" }],
    [B, { role: "contributor", entry: "team" }], [V2, { role: "voter", entry: "team" }]]);
  const w = winnersOf(payouts, roles);
  assert.equal(w.total, 208);
  assert.equal(w.dids, 4);
  assert.equal(w.entry, "team");
  assert.deepEqual(w.authors, [{ did: A, flop: 100 }, { did: B, flop: 100 }]);
  assert.equal(w.authorsFlop, 200);
  assert.deepEqual(w.voters, { count: 2, min: 3, max: 5, total: 8 });
  assert.equal(eachLabel(w.voters), "3 to 5 FLOP each");
  assert.equal(eachLabel({ min: 7, max: 7 }), "7 FLOP each");
});

test("Sonnet: 97,964 FLOP to 6,856 DIDs, 4 authors of maragung-flop, voters at 7 FLOP each", () => {
  const dir = join(import.meta.dirname, "..", "src", "data", "flop-labs");
  const payouts = new Map(Object.entries(JSON.parse(readFileSync(join(dir, "sonnet-2.payouts.json"), "utf8"))));
  const [head, ...lines] = readFileSync(join(dir, "sonnet-2.allocations.csv"), "utf8").split(/\r?\n/).filter(Boolean);
  const cols = head.split(",");
  // the did, role and entry columns come before the quoted "basis" field, so a plain split reads them
  const roles = new Map(lines.map((l) => { const f = l.split(","); return [f[cols.indexOf("did")], { role: f[cols.indexOf("role")], entry: f[cols.indexOf("entry")] }]; }));
  const w = winnersOf(payouts, roles);
  assert.equal(w.total, 97_964);
  assert.equal(w.dids, 6_856);
  assert.equal(w.entry, "maragung-flop");
  assert.equal(w.authors.length, 4);
  assert.equal(w.authorsFlop, 50_000);
  assert.ok(w.authors.every((a) => a.flop === 12_500));
  assert.equal(w.voters.count, 6_852);
  assert.equal(w.voters.total, 47_964);
  assert.equal(eachLabel(w.voters), "7 FLOP each");
});

test("Was my DID paid? answers an author, a voter, an unknown DID and a malformed input", () => {
  assert.deepEqual(paidAnswer(` ${A} `, 12_500, "contributor"), { tone: "accent", text: "Paid 12,500 FLOP, as an author." });
  assert.deepEqual(paidAnswer(V1, 7, "voter"), { tone: "accent", text: "Paid 7 FLOP, as a voter." });
  assert.deepEqual(paidAnswer(V1), { tone: "muted", text: "Not in the payout list." });
  assert.equal(paidAnswer("did:key:z6Mk-nope").tone, "warning");
  assert.match(paidAnswer("").text, /^Not a did:key/);
});
