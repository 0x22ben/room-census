import assert from "node:assert/strict";
import { test } from "node:test";

import { assumedFromStandings, equalSplit, ordinal, rankRows } from "../src/lib/rank-rows.mjs";

const did = (c) => `did:key:z6Mk${c.repeat(44)}`;
const place = (rank, ch) => ({ rank, did: did(ch), score: "1.000000", sharing: 1 });
const STANDINGS = { places: [place(1, "A"), place(2, "B"), place(3, "C")], next: [] };

test("ordinals", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st"]);
});

test("an equal split gives each key the same whole FLOP and never invents the remainder", () => {
  assert.deepEqual([...equalSplit(1_000_000, [did("A"), did("B"), did("C")])].map(([, v]) => v), [333_333, 333_333, 333_333]);
  assert.deepEqual([...equalSplit(1_000_000, [did("A"), did("B")])].map(([, v]) => v), [500_000, 500_000]);
  assert.equal(equalSplit(1_000_000, []).size, 0);
  assert.equal(equalSplit(0, [did("A")]).size, 0);
  assert.equal(equalSplit(1.5, [did("A")]).size, 0);
});

test("Close Call's prize places become an equal split, each labelled with its place and the assumption", () => {
  const a = assumedFromStandings(STANDINGS, "1,000,000 FLOP");
  assert.equal(a.pool, 1_000_000);
  assert.deepEqual([...a.payouts.values()], [333_333, 333_333, 333_333]);
  assert.deepEqual([...a.roles.values()].map((r) => r.role), ["place1", "place2", "place3"]);
  assert.deepEqual(Object.values(a.labels), ["1st place, equal split assumed", "2nd place, equal split assumed", "3rd place, equal split assumed"]);
  assert.match(a.note, /^1,000,000 FLOP for the top 3, paid after mainnet\. FLOP Labs has not published the split: counted here as an equal split\.$/);
});

test("a tie on the last prize place splits between every key of the places, and says how many", () => {
  const tied = { places: [place(1, "A"), place(2, "B"), place(3, "C"), place(3, "D")], next: [] };
  const a = assumedFromStandings(tied, "1,000,000 FLOP");
  assert.deepEqual([...a.payouts.values()], [250_000, 250_000, 250_000, 250_000]);
  assert.match(a.note, /for its 4 prize places/);
});

test("no standings, or a prize that is not a plain amount, gives nothing", () => {
  assert.equal(assumedFromStandings(undefined, "1,000,000 FLOP"), undefined);
  assert.equal(assumedFromStandings({ places: [], next: [] }, "1,000,000 FLOP"), undefined);
  for (const prize of ["1M FLOP", "1,000,000", "1000000 FLOP", "", undefined]) assert.equal(assumedFromStandings(STANDINGS, prize), undefined, String(prize));
});

const paidContest = (id, entries, roleOf) => ({ id, payouts: new Map(entries), roles: new Map(entries.map(([d]) => [d, { role: roleOf(d) }])) });

test("the ranking puts the assumed winners first, tied, in the order of their places, then the paid DIDs", () => {
  const a = assumedFromStandings({ places: [place(1, "Z"), place(2, "Y"), place(3, "X")], next: [] }, "1,000,000 FLOP");
  const close = { id: "close-1", payouts: a.payouts, roles: a.roles, assumed: { pool: a.pool } };
  const sonnet = paidContest("sonnet-2", [[did("A"), 12_500], [did("B"), 12_500], [did("C"), 7]], (d) => (d === did("C") ? "voter" : "contributor"));
  const rows = rankRows([sonnet, close]);
  assert.deepEqual(rows.map((r) => [r.rank, r.did.slice(-1), r.flop]), [[1, "Z", 333_333], [1, "Y", 333_333], [1, "X", 333_333], [4, "A", 12_500], [4, "B", 12_500], [6, "C", 7]]);
  assert.deepEqual(rows[0].by, { "close-1": 333_333 });
  assert.deepEqual(rows[3].roles, { "sonnet-2": "contributor" });
});

test("a DID in both contests adds up its FLOP", () => {
  const a = assumedFromStandings({ places: [place(1, "A"), place(2, "B"), place(3, "C")], next: [] }, "1,000,000 FLOP");
  const close = { id: "close-1", payouts: a.payouts, roles: a.roles, assumed: { pool: a.pool } };
  const sonnet = paidContest("sonnet-2", [[did("C"), 12_500]], () => "contributor");
  const rows = rankRows([sonnet, close]);
  assert.deepEqual(rows.map((r) => [r.rank, r.did.slice(-1), r.flop]), [[1, "C", 345_833], [2, "A", 333_333], [2, "B", 333_333]]);
});
