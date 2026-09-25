// Contest phases: trading locks at 09:00 UTC, the final price is taken at 10:00 UTC, and the three
// periods around them are told apart.
import assert from "node:assert/strict";
import { test } from "node:test";

import { PHASE_LABEL, after, phase, until } from "../src/lib/contest-time.mjs";

const CLOSE = { opening: "2026-09-25T12:00:00Z", trading_lock_at: "2026-10-04T09:00:00Z", final_price_at: "2026-10-04T10:00:00Z" };
const SONNET = { opening: "2026-09-11T12:00:00Z", trading_lock_at: "2026-09-18T12:00:00Z", final_price_at: null };

test("before 09:00 UTC on 4 Oct the contest is live and counts down to the lock, not to the final price", () => {
  assert.equal(phase(CLOSE, "2026-10-04T08:59:59Z"), "live");
  assert.equal(until(CLOSE.trading_lock_at, "2026-10-04T08:00:00Z"), "1 h 0 min");
  assert.equal(until(CLOSE.trading_lock_at, "2026-09-25T17:38:09Z"), "8 days 15 h");
});

test("between 09:00 and 10:00 UTC trading is closed and the final price is awaited", () => {
  for (const now of ["2026-10-04T09:00:00Z", "2026-10-04T09:30:00Z", "2026-10-04T09:59:59Z"]) {
    assert.equal(phase(CLOSE, now), "closed", now);
  }
  assert.equal(PHASE_LABEL.closed, "Trading closed · awaiting final price");
  assert.equal(until(CLOSE.final_price_at, "2026-10-04T09:45:00Z"), "15 min");
});

test("from 10:00 UTC the contest has ended", () => {
  assert.equal(phase(CLOSE, "2026-10-04T10:00:00Z"), "ended");
  assert.equal(phase(CLOSE, "2026-10-05T00:00:00Z"), "ended");
});

test("before the opening it is upcoming, and a contest without a final price ends at its lock", () => {
  assert.equal(phase(CLOSE, "2026-09-25T11:59:59Z"), "upcoming");
  assert.equal(phase(SONNET, "2026-09-18T11:59:59Z"), "live");
  assert.equal(phase(SONNET, "2026-09-18T12:00:00Z"), "ended");
});

test("a countdown is never negative, and the coverage delay reads in plain units", () => {
  assert.equal(until(CLOSE.trading_lock_at, "2026-10-05T00:00:00Z"), "0 min");
  assert.equal(after("2026-09-25T13:32:19Z", CLOSE.opening), "1 h 32 min");
});
