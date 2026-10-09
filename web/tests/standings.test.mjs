import assert from "node:assert/strict";
import { test } from "node:test";

import { refereeLine, signedRows, standingsView, toCents } from "../src/lib/standings.mjs";

const did = (c) => `did:key:z6Mk${c.repeat(44)}`;

test("a score is shown to the cent, exactly", () => {
  assert.equal(toCents("1576.916300"), "1576.92");
  assert.equal(toCents("1424.740300"), "1424.74");
  assert.equal(toCents("1337.545600"), "1337.55");
  assert.equal(toCents("0.000000"), "0.00");
  assert.equal(toCents("-12.344999"), "-12.34");
  assert.equal(toCents("-0.004000"), "0.00");          // no negative zero
});

test("half a cent goes to the even cent, in both directions", () => {
  assert.equal(toCents("10.005000"), "10.00");
  assert.equal(toCents("10.015000"), "10.02");
  assert.equal(toCents("-10.005000"), "-10.00");
  assert.equal(toCents("-10.015000"), "-10.02");
  assert.equal(toCents("10.005001"), "10.01");
});

test("a score that is not six decimals is refused", () => {
  for (const bad of ["12.34", "12.3456789", "abc", "", "1e3"]) assert.throws(() => toCents(bad), /six-decimal/, bad);
});

const STANDINGS = {
  price: "234.69", posted_at: "2026-10-04T17:33:04.421681Z", seq: 2557, owners: 18790926, zero_sum: "0.000000",
  places: [{ rank: 1, did: did("A"), score: "1576.916300", sharing: 1 }, { rank: 2, did: did("B"), score: "1424.740300", sharing: 1 },
    { rank: 3, did: did("C"), score: "1337.545600", sharing: 1 }],
  next: [{ rank: 4, did: did("D"), score: "1334.181800" }, { rank: 5, did: did("E"), score: "1305.782300" }],
};

test("the view lists the prize places first, then the next ones, in the referee's order", () => {
  const v = standingsView(STANDINGS);
  assert.deepEqual(v.winners.map((w) => [w.rank, w.score, w.sharing]), [[1, "1576.92", 1], [2, "1424.74", 1], [3, "1337.55", 1]]);
  assert.deepEqual(v.next.map((w) => [w.rank, w.score]), [[4, "1334.18"], [5, "1305.78"]]);
  assert.equal(v.first, "1576.92");
  assert.equal(v.price, "234.69");
  assert.equal(v.postedAt, "2026-10-04T17:33:04.421681Z");
});

test("the view never reorders or drops a place", () => {
  const swapped = { ...STANDINGS, places: [STANDINGS.places[1], STANDINGS.places[0], STANDINGS.places[2]] };
  assert.deepEqual(standingsView(swapped).winners.map((w) => w.rank), [2, 1, 3]);
  assert.equal(standingsView(STANDINGS).winners.length + standingsView(STANDINGS).next.length, 5);
});

test("the final standings become the signed rows the lookups read, with their final rank and score", () => {
  const rows = signedRows(STANDINGS);
  assert.deepEqual(rows.map((r) => [r.rank, r.did, r.pnl]), [[1, did("A"), "1576.92"], [2, did("B"), "1424.74"], [3, did("C"), "1337.55"],
    [4, did("D"), "1334.18"], [5, did("E"), "1305.78"]]);
  assert.ok(rows.every((r) => r.check === "pending"), "nothing of our recount is claimed to confirm them");
});

test("the referee's line of a key is its final rank and score, and nothing for a key it does not list", () => {
  const rows = signedRows(STANDINGS);
  assert.deepEqual(refereeLine(rows, did("C")), { rank: 3, pnl: "1337.55" });
  assert.deepEqual(refereeLine(rows, did("E")), { rank: 5, pnl: "1305.78" });
  assert.equal(refereeLine(rows, did("Z")), undefined);
  assert.equal(refereeLine([], did("A")), undefined);
});
