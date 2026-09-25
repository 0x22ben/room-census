// Copies the public data contract of the repository into web/.public, the Astro publicDir, byte for
// byte. Fail closed: an unexpected, missing, linked or inconsistent file stops the build. Nothing
// outside the allowlist below can reach the site, so the private archive, journals, state, secrets
// and Git metadata never do.
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED = ["data/latest.json", "data/history.csv", "data/card.png", "data/LICENSE",
  "data/rooms/index.json", "identity.json", "llms.txt"];
// every entry allowed directly under data/, and the file names allowed in each data directory
const DATA_ENTRIES = new Set(["latest.json", "history.csv", "card.png", "LICENSE", "snapshots", "manifests", "rooms", "contests"]);
const SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const RESERVED = new Set(["con", "prn", "aux", "nul", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((i) => [`com${i}`, `lpt${i}`])]);
export const DIRECTORIES = {
  "data/snapshots": (name) => /^\d{4}-\d{2}-\d{2}T\d{4}Z\.json$/.test(name),
  "data/manifests": (name) => /^[0-9a-f]{64}\.json$/.test(name),
  "data/rooms": (name) => name === "index.json" || (name.endsWith(".json") && validSlug(name.slice(0, -5))),
};
// directories that may be absent: the contest witness publishes data/contests/ only once a contest runs
export const OPTIONAL_DIRECTORIES = {
  "data/contests": (name) => name === "index.json" || (name.endsWith(".ranking.json") && validSlug(name.slice(0, -13))),
};
const SNAPSHOT = /^data\/snapshots\/\d{4}-\d{2}-\d{2}T\d{4}Z\.json$/;

export class StagingError extends Error {}

export function validSlug(name) {
  return typeof name === "string" && SLUG.test(name) && !RESERVED.has(name);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => { throw new StagingError(message); };

function regularFile(repo, rel) {
  const path = join(repo, ...rel.split("/"));
  let info;
  try {
    info = lstatSync(path);
  } catch {
    fail(`missing required file ${rel}`);
  }
  if (info.isSymbolicLink()) fail(`linked file refused: ${rel}`);
  if (!info.isFile()) fail(`not a regular file: ${rel}`);
  const real = realpathSync(path);
  if (relative(repo, real).startsWith("..") || real === repo) fail(`path outside the repository: ${rel}`);
  return path;
}

function directory(repo, rel) {
  const path = join(repo, ...rel.split("/"));
  let info;
  try {
    info = lstatSync(path);
  } catch {
    fail(`missing required directory ${rel}`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) fail(`not a plain directory: ${rel}`);
  return path;
}

/** Every public file the site may publish, as repository-relative paths, after checking the tree. */
export function allowlist(repo) {
  const files = [...REQUIRED];
  for (const entry of readdirSync(directory(repo, "data"))) {
    if (!DATA_ENTRIES.has(entry)) fail(`unexpected entry in data/: ${entry}`);
  }
  const present = Object.entries(OPTIONAL_DIRECTORIES).filter(([dir]) => {
    try {
      lstatSync(join(repo, ...dir.split("/")));
      return true;
    } catch {
      return false;
    }
  });
  for (const [dir, allowed] of [...Object.entries(DIRECTORIES), ...present]) {
    for (const entry of readdirSync(directory(repo, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (!entry.isFile() || !allowed(entry.name)) fail(`unexpected entry in ${dir}/: ${entry.name}`);
      if (!files.includes(rel)) files.push(rel);
    }
  }
  return files.sort();
}

function readJson(bytes, rel) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`not valid JSON: ${rel}`);
  }
}

function* snapshotRefs(node) {
  if (Array.isArray(node)) for (const v of node) yield* snapshotRefs(v);
  else if (node && typeof node === "object") {
    if ("snapshot" in node) yield node;
    for (const v of Object.values(node)) yield* snapshotRefs(v);
  }
}

// key order never matters: two documents agree when their canonical forms do
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
    : JSON.stringify(v));
const same = (a, b) => canonical(a) === canonical(b);

/** Cross-file checks on the staged bytes: what the pages will link to must exist and match. */
export function checkConsistency(bytes) {
  const json = (rel) => readJson(bytes.get(rel), rel);
  const hashOf = (rel) => (bytes.has(rel) ? sha256(bytes.get(rel)) : null);
  const latest = json("data/latest.json");
  if (latest.schema !== "room-census/1") fail("data/latest.json is not a room-census/1 document");
  if (!SNAPSHOT.test(latest.snapshot ?? "") || hashOf(latest.snapshot) !== latest.sha256) {
    fail(`latest snapshot does not resolve or match: ${latest.snapshot}`);
  }
  const vouched = new Set([latest.snapshot]);          // snapshots whose bytes a document vouches for
  const prov = latest.provenance;
  if (prov !== null && prov !== undefined) {
    if (prov.manifest !== `data/manifests/${prov.manifest_sha256}.json` || hashOf(prov.manifest) !== prov.manifest_sha256) {
      fail(`latest manifest does not resolve or match: ${prov.manifest}`);
    }
  }
  if (!same(json("identity.json").provenance ?? null, prov ?? null)) fail("identity.json and latest.json name different provenance");
  for (const rel of bytes.keys()) {
    if (rel.startsWith("data/manifests/") && `data/manifests/${hashOf(rel)}.json` !== rel) {
      fail(`manifest not named after its own SHA-256: ${rel}`);
    }
  }
  const index = json("data/rooms/index.json");
  if (index.schema !== "room-census-rooms/1" || !Array.isArray(index.rooms)) fail("data/rooms/index.json is not a room-census-rooms/1 document");
  const listed = new Set();
  for (const entry of index.rooms) {
    const slug = entry?.room;
    if (!validSlug(slug)) fail(`unsafe room slug in the index: ${JSON.stringify(slug)}`);
    if (listed.has(slug)) fail(`duplicate room in the index: ${slug}`);
    listed.add(slug);
    const rel = `data/rooms/${slug}.json`;
    if (entry.page !== `rooms/${slug}/` || entry.data !== rel) fail(`index entry of ${slug} does not use the contract paths`);
    if (!bytes.has(rel)) fail(`room data file missing: ${rel}`);
    const doc = json(rel);
    if (doc.schema !== "room-census-room/1" || doc.room !== slug) fail(`${rel} is not the room-census-room/1 document of ${slug}`);
    for (const ref of snapshotRefs(doc)) {
      if (ref.snapshot !== null && (!SNAPSHOT.test(ref.snapshot ?? "") || hashOf(ref.snapshot) !== ref.sha256)) {
        fail(`${rel} names a snapshot that does not resolve or match: ${ref.snapshot}`);
      }
      if (ref.snapshot !== null) vouched.add(ref.snapshot);
    }
  }
  const files = [...bytes.keys()].filter((r) => r.startsWith("data/rooms/") && r !== "data/rooms/index.json");
  if (files.length !== listed.size) fail("room data files and index differ");
  for (const rel of bytes.keys()) {
    if (rel.startsWith("data/snapshots/") && !vouched.has(rel)) fail(`snapshot named by no document: ${rel}`);
  }
  checkContests(bytes, json);
  return { census: latest.census, rooms: listed.size };
}

/** data/contests/: an index of the followed contests, and one ranking file per contest that names one. */
function checkContests(bytes, json) {
  const files = [...bytes.keys()].filter((r) => r.startsWith("data/contests/"));
  if (files.length === 0) return;
  if (!bytes.has("data/contests/index.json")) fail("data/contests/ has files but no index.json");
  const index = json("data/contests/index.json");
  if (index.schema !== "room-census-contests/1" || !Array.isArray(index.contests)) fail("data/contests/index.json is not a room-census-contests/1 document");
  const named = new Set(["data/contests/index.json"]);
  const ids = new Set();
  for (const c of index.contests) {
    if (!validSlug(c?.id) || ids.has(c.id)) fail(`unsafe or duplicate contest id: ${JSON.stringify(c?.id)}`);
    ids.add(c.id);
    if (typeof c.rules !== "string" || !c.rules.startsWith("https://")) fail(`rules link of ${c.id} is not an https URL`);
    if (c.ranking) {
      const rel = `data/contests/${c.id}.ranking.json`;
      if (c.ranking.file !== `/${rel}` || !bytes.has(rel)) fail(`ranking of ${c.id} does not resolve: ${c.ranking.file}`);
      const doc = json(rel);
      if (doc.schema !== "room-census/contest-ranking/1" || doc.contest !== c.id || !Array.isArray(doc.rows)) {
        fail(`${rel} is not the room-census/contest-ranking/1 document of ${c.id}`);
      }
      named.add(rel);
    }
  }
  for (const rel of files) if (!named.has(rel)) fail(`contest file named by no contest: ${rel}`);
}

/** Rebuilds `out` from the allowlist of `repo`. Returns the inventory of staged files. */
export function stage({ repo, out }) {
  repo = realpathSync(resolve(repo));
  // the only directory this step may delete and rebuild
  let parent = resolve(out, "..");
  try {
    parent = realpathSync(parent);
  } catch {}
  if (parent !== join(repo, "web") || basename(resolve(out)) !== ".public") {
    fail("the staging directory must be web/.public inside the repository");
  }
  out = join(repo, "web", ".public");
  rmSync(out, { recursive: true, force: true });       // first: a failed run leaves nothing to fall back on
  const files = allowlist(repo);
  const bytes = new Map(files.map((rel) => [rel, readFileSync(regularFile(repo, rel))]));
  const summary = checkConsistency(bytes);
  const inventory = [];
  for (const rel of files) {
    const target = join(out, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repo, ...rel.split("/")), target);
    const copied = readFileSync(target);
    if (sha256(copied) !== sha256(bytes.get(rel))) fail(`copy differs from its source: ${rel}`);
    inventory.push({ path: rel, bytes: copied.length, sha256: sha256(copied) });
  }
  return { ...summary, files: inventory };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const result = stage({ repo: resolve(web, ".."), out: resolve(web, ".public") });
    const total = result.files.reduce((n, f) => n + f.bytes, 0);
    console.log(`staged ${result.files.length} public files (${total} bytes), census ${result.census}, ${result.rooms} rooms`);
  } catch (e) {
    console.error(`staging failed: ${e.message}`);
    process.exit(1);
  }
}
