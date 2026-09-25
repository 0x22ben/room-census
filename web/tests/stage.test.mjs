// The staging step copies exactly the public allowlist, byte for byte, and fails closed on anything else.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { StagingError, stage } from "../scripts/stage-public-data.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
let repo;
let out;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "stage-"));
  for (const name of ["data", "identity.json", "llms.txt"]) cpSync(join(REPO, name), join(repo, name), { recursive: true });
  rmSync(join(repo, "data", "contests"), { recursive: true, force: true });  // optional: each test adds its own
  // private files a real checkout of the census holds beside the public ones
  writeFileSync(join(repo, "census.jsonl"), "private archive\n");
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  mkdirSync(join(repo, "web"));
  out = join(repo, "web", ".public");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

const refused = (pattern) => assert.throws(() => stage({ repo, out }), (e) => e instanceof StagingError && pattern.test(e.message));
const edit = (rel, change) => {
  const path = join(repo, ...rel.split("/"));
  writeFileSync(path, JSON.stringify(change(JSON.parse(readFileSync(path, "utf8")))));
};

test("stages exactly the allowlist, byte for byte", () => {
  const result = stage({ repo, out });
  const paths = result.files.map((f) => f.path);
  for (const rel of ["data/latest.json", "data/history.csv", "data/card.png", "data/LICENSE", "identity.json", "llms.txt",
    "data/rooms/index.json", "data/rooms/lobby.json"]) assert.ok(paths.includes(rel), rel);
  assert.ok(paths.some((p) => p.startsWith("data/snapshots/")));
  assert.ok(paths.some((p) => p.startsWith("data/manifests/")));
  assert.ok(!paths.some((p) => /census\.jsonl|\.env|\.git/.test(p)));
  for (const f of result.files) {
    const source = readFileSync(join(repo, ...f.path.split("/")));
    assert.equal(sha(readFileSync(join(out, ...f.path.split("/")))), sha(source), f.path);
    assert.equal(f.sha256, sha(source));
  }
  assert.ok(!existsSync(join(out, "census.jsonl")));
  assert.ok(!existsSync(join(out, ".env")));
});

test("a previous staging directory is never reused", () => {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "stale.html"), "old");
  stage({ repo, out });
  assert.ok(!existsSync(join(out, "stale.html")));
});

test("a failed staging leaves no previous copy behind to fall back on", () => {
  stage({ repo, out });
  rmSync(join(repo, "data", "history.csv"));
  refused(/missing required file data\/history\.csv/);
  assert.ok(!existsSync(out), "the previous staging is removed before any check");
});

test("missing required file", () => {
  rmSync(join(repo, "llms.txt"));
  refused(/missing required file llms\.txt/);
});

test("unexpected entry in data/", () => {
  writeFileSync(join(repo, "data", "census.jsonl"), "private");
  refused(/unexpected entry in data\/: census\.jsonl/);
});

test("unexpected file in a data directory", () => {
  writeFileSync(join(repo, "data", "snapshots", "notes.txt"), "x");
  refused(/unexpected entry in data\/snapshots\/: notes\.txt/);
});

test("unsafe room file name", () => {
  writeFileSync(join(repo, "data", "rooms", "-lobby.json"), "{}");
  refused(/unexpected entry in data\/rooms\/: -lobby\.json/);
});

test("nested directory inside a data directory", () => {
  mkdirSync(join(repo, "data", "rooms", "nested"));
  refused(/unexpected entry in data\/rooms\/: nested/);
});

test("linked file", (t) => {
  const target = join(repo, "data", "LICENSE");
  const moved = join(repo, "LICENSE-real");
  cpSync(target, moved);
  rmSync(target);
  try {
    symlinkSync(moved, target);
  } catch {
    t.skip("symbolic links need extra rights on this system");
    return;
  }
  refused(/linked file refused: data\/LICENSE/);
});

test("latest snapshot altered", () => {
  const snap = JSON.parse(readFileSync(join(repo, "data", "latest.json"), "utf8")).snapshot;
  writeFileSync(join(repo, ...snap.split("/")), readFileSync(join(repo, ...snap.split("/")), "utf8") + " ");
  refused(/latest snapshot does not resolve or match/);
});

test("an extra manifest not named after its own hash", () => {
  writeFileSync(join(repo, "data", "manifests", `${"0".repeat(64)}.json`), "{}");
  refused(/manifest not named after its own SHA-256/);
});

test("a snapshot no document vouches for", () => {
  writeFileSync(join(repo, "data", "snapshots", "2026-01-01T0000Z.json"), "{\"anything\": true}");
  refused(/snapshot named by no document: data\/snapshots\/2026-01-01T0000Z\.json/);
});

test("provenance agrees whatever the key order", () => {
  edit("identity.json", (d) => ({ ...d, provenance: Object.fromEntries(Object.entries(d.provenance).reverse()) }));
  stage({ repo, out });
});

test("latest manifest not named after its hash", () => {
  const prov = JSON.parse(readFileSync(join(repo, "data", "latest.json"), "utf8")).provenance;
  writeFileSync(join(repo, ...prov.manifest.split("/")), "{}");
  refused(/latest manifest does not resolve or match/);
});

test("identity and latest name different provenance", () => {
  edit("identity.json", (d) => ({ ...d, provenance: null }));
  refused(/different provenance/);
});

test("room listed in the index without a data file", () => {
  rmSync(join(repo, "data", "rooms", "lobby.json"));
  refused(/room data file missing: data\/rooms\/lobby\.json/);
});

test("room data file absent from the index", () => {
  cpSync(join(repo, "data", "rooms", "lobby.json"), join(repo, "data", "rooms", "stray.json"));
  refused(/room data files and index differ/);
});

test("unsafe slug inside the index", () => {
  edit("data/rooms/index.json", (d) => ({ ...d, rooms: [...d.rooms, { room: "../x", page: "rooms/../x/", data: "data/rooms/../x.json" }] }));
  refused(/unsafe room slug in the index/);
});

test("room document names an unknown snapshot", () => {
  edit("data/rooms/lobby.json", (d) => ({ ...d, last_measured: { ...d.last_measured, snapshot: "data/snapshots/2026-01-01T0000Z.json" } }));
  refused(/names a snapshot that does not resolve or match/);
});

test("only web/.public can be staged into, so nothing else is ever deleted", () => {
  for (const other of [join(tmpdir(), "elsewhere"), repo, join(repo, "data"), join(repo, "web"), join(repo, "web", "dist")]) {
    assert.throws(() => stage({ repo, out: other }), /must be web\/\.public/);
  }
  assert.ok(existsSync(join(repo, "data", "latest.json")));
});

// data/contests/ is optional: the contest witness adds it once a contest runs
const contests = (index, rankings = {}) => {
  mkdirSync(join(repo, "data", "contests"));
  writeFileSync(join(repo, "data", "contests", "index.json"), JSON.stringify(index));
  for (const [id, doc] of Object.entries(rankings)) writeFileSync(join(repo, "data", "contests", `${id}.ranking.json`), JSON.stringify(doc));
};
const INDEX = { schema: "room-census-contests/1", contests: [{ id: "close-1", rules: "https://github.com/flop-labs/x", ranking: { file: "/data/contests/close-1.ranking.json" } }] };
const RANKING = { schema: "room-census/contest-ranking/1", contest: "close-1", rows: [] };

test("contest data is staged when present and optional when absent", () => {
  assert.ok(!stage({ repo, out }).files.some((f) => f.path.startsWith("data/contests/")));
  contests(INDEX, { "close-1": RANKING });
  const paths = stage({ repo, out }).files.map((f) => f.path);
  assert.ok(paths.includes("data/contests/index.json") && paths.includes("data/contests/close-1.ranking.json"));
});

test("a contest ranking named by the index must exist and be its document", () => {
  contests(INDEX);
  refused(/ranking of close-1 does not resolve/);
});

test("a contest file named by no contest is refused", () => {
  contests({ ...INDEX, contests: [{ id: "close-1", rules: "https://github.com/flop-labs/x" }] }, { "close-1": RANKING });
  refused(/contest file named by no contest/);
});

test("an unexpected file or a bad document in data/contests/ is refused", () => {
  contests(INDEX, { "close-1": { ...RANKING, contest: "other" } });
  refused(/is not the room-census\/contest-ranking\/1 document of close-1/);
  writeFileSync(join(repo, "data", "contests", "notes.txt"), "x");
  refused(/unexpected entry in data\/contests\/: notes\.txt/);
});

test("a contest rules link that is not https is refused", () => {
  contests({ ...INDEX, contests: [{ ...INDEX.contests[0], rules: "javascript:alert(1)" }] }, { "close-1": RANKING });
  refused(/rules link of close-1 is not an https URL/);
});

test("an unsafe contest id is refused", () => {
  contests({ schema: "room-census-contests/1", contests: [{ id: "../x" }] });
  refused(/unsafe or duplicate contest id/);
});
