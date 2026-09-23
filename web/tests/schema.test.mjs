// The data contract accepts the published data and refuses each kind of malformed or inconsistent document.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DataContractError, loadSite } from "../src/lib/schema.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const original = (rel) => JSON.parse(readFileSync(join(REPO, ...rel.split("/")), "utf8"));

/** A reader over the real files, with some documents changed by `edits` (rel -> function). */
function reader(edits = {}) {
  return (rel) => {
    const doc = structuredClone(original(rel));
    return edits[rel] ? edits[rel](doc) ?? doc : doc;
  };
}

const refused = (edits, pattern) =>
  assert.throws(() => loadSite(reader(edits)), (e) => e instanceof DataContractError && pattern.test(e.message), String(pattern));

test("the published data holds and yields one census list and the chart aggregates", () => {
  const site = loadSite(reader());
  const latest = original("data/latest.json");
  assert.equal(site.censuses.length, latest.census);
  assert.equal(site.rooms.size, original("data/rooms/index.json").rooms.length);
  const last = site.byCensus[site.byCensus.length - 1];
  assert.equal(last.varied + last.mixed + last.repetitive, latest.summary.active);
  assert.equal(site.byCensus[0].traffic, null, "the first census has no rate between censuses");
});

test("wrong schema name", () => refused({ "data/latest.json": (d) => { d.schema = "room-census/2"; } }, /latest\.json breaks the data contract: schema/));
test("text where a number belongs", () => refused({ "data/rooms/lobby.json": (d) => { d.history[2].rate_interval = "47700"; } }, /lobby\.json breaks the data contract: history\.2\.rate_interval/));
test("share above one", () => refused({ "data/rooms/lobby.json": (d) => { d.history[2].unique_tpl = 1.5; } }, /history\.2\.unique_tpl/));
test("unknown status", () => refused({ "data/rooms/lobby.json": (d) => { d.history[2].status = "guessed"; } }, /history\.2\.status/));
test("unknown class", () => refused({ "data/latest.json": (d) => { d.rooms[0].class = "suspicious"; } }, /rooms\.0\.class/));
test("unsafe slug in the index", () => refused({ "data/rooms/index.json": (d) => { d.rooms[0].room = "../etc"; } }, /unsafe room slug/));
test("missing required field", () => refused({ "data/latest.json": (d) => { delete d.summary.active; } }, /summary\.active/));
test("publisher is not a did:key", () => refused({ "data/latest.json": (d) => { d.publisher = "did:web:example.com"; } }, /publisher/));
test("identity and latest name different publishers", () => refused({ "identity.json": (d) => { d.did = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"; } }, /different publishers/));
test("unexpected Technocore address", () => refused({ "data/rooms/lobby.json": (d) => { d.technocore = "https://evil.example/r/lobby"; } }, /unexpected Technocore address/));
test("index and room document disagree", () => refused({ "data/rooms/index.json": (d) => { d.rooms.find((r) => r.room === "lobby").last_class = "varied"; } }, /disagree on last_class/));
test("history out of order", () => refused({ "data/rooms/lobby.json": (d) => { d.history.reverse(); } }, /not census 1 to/));
test("history shorter than the census count", () => refused({ "data/rooms/lobby.json": (d) => { d.history.pop(); d.censuses_total -= 1; } }, /does not cover censuses/));
test("a gap that carries values", () => refused({ "data/rooms/lobby.json": (d) => { d.history[0].status = "absent"; } }, /is absent but carries values/));
test("a zero invented for a missing census", () => refused({ "data/rooms/lobby.json": (d) => { Object.assign(d.history[0], { status: "failed", class: null, rate_interval: 0, window_estimate: null, traffic_share: null, unique_tpl: null, eff_senders: null, top_share: null }); } }, /is failed but carries values/));
test("measured without a class", () => refused({ "data/rooms/lobby.json": (d) => { d.history[2].class = null; } }, /measured without a class/));
test("stale flag that does not match the history", () => refused({ "data/rooms/lobby.json": (d) => { d.current = false; }, "data/rooms/index.json": (d) => { d.rooms.find((r) => r.room === "lobby").current = false; } }, /current flag/));
test("rooms disagree on a census", () => refused({ "data/rooms/lobby.json": (d) => { d.history[1].sha256 = "0".repeat(64); } }, /disagrees with the other rooms on census #2/));
test("latest snapshot differs from the room documents", () => refused({ "data/latest.json": (d) => { d.sha256 = "0".repeat(64); } }, /different latest snapshots/));
test("signed message differs from the room documents", () => refused({ "data/latest.json": (d) => { d.signed_in.nonce = "1"; } }, /different signed messages/));
test("latest lists a room outside the index", () => refused({ "data/latest.json": (d) => { d.rooms.push({ ...d.rooms[0], room: "ghost-room" }); } }, /ghost-room, absent from the room index/));
test("a class change names an unknown room", () => refused({ "data/latest.json": (d) => { d.changes.class_changes.push({ room: "ghost-room", from: "mixed", to: "varied" }); } }, /unknown room: ghost-room/));
test("infinite value", () => refused({ "data/rooms/lobby.json": (d) => { d.history[2].eff_senders = Infinity; } }, /history\.2\.eff_senders/));
