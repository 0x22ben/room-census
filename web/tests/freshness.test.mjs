// The sidebar's data time: the newest of the census and the contest capture, in UTC, never a guess.
import assert from "node:assert/strict";
import { test } from "node:test";

import { dayTimeUtc, newest } from "../src/lib/freshness.mjs";

test("the newest of the census and the contests wins, whatever the order", () => {
  const census = "2026-09-28T09:06:20.928988+00:00";
  const contests = "2026-09-28T14:30:43.287802Z";
  assert.equal(newest(census, contests), "2026-09-28T14:30:43.287Z");
  assert.equal(newest(contests, census), "2026-09-28T14:30:43.287Z");
});

test("a source the build does not have is skipped, and nothing at all gives null", () => {
  assert.equal(newest("2026-09-28T09:06:20Z", null), "2026-09-28T09:06:20.000Z");
  assert.equal(newest(null, undefined), null);
});

test("an invalid time stops the build instead of showing a wrong date", () => {
  assert.throws(() => newest("yesterday"));
  assert.throws(() => dayTimeUtc("not a date"));
});

test("the short form is day, month and UTC time, without the year", () => {
  assert.equal(dayTimeUtc("2026-09-28T14:34:59Z"), "28 Sep, 14:34 UTC");
  assert.equal(dayTimeUtc("2026-10-04T09:05:00+02:00"), "4 Oct, 07:05 UTC");
});
