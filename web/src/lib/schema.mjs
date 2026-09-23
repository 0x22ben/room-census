// The public data contract, checked at build time. Every document the pages read is validated
// here, field by field, then the documents are checked against each other. Anything malformed,
// missing or inconsistent stops the build: no page is ever rendered from data that does not hold.
// Extra fields are accepted (additive, versioned changes); missing or wrong ones are not.
import { z } from "astro/zod";

const SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const RESERVED = new Set(["con", "prn", "aux", "nul", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((i) => [`com${i}`, `lpt${i}`])]);
const HEX64 = /^[0-9a-f]{64}$/;
const NONCE = /^[1-9][0-9]{0,18}$/;
const SNAPSHOT = /^data\/snapshots\/\d{4}-\d{2}-\d{2}T\d{4}Z\.json$/;
const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;

export const CLASSES = ["varied", "mixed", "repetitive"];
export const validSlug = (s) => typeof s === "string" && SLUG.test(s) && !RESERVED.has(s);

const slug = z.string().refine(validSlug, "unsafe room slug");
const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T/.test(s), "not an ISO date");
const count = z.number().int().nonnegative();
const censusNo = z.number().int().positive();
const num = z.number().finite();
const share = z.number().finite().min(0).max(1);
const cls = z.enum([...CLASSES, "quiet"]);

const provenance = z.looseObject({
  manifest_sha256: z.string().regex(HEX64),
  manifest: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  repository: z.string().url(),
});

const latestRoom = z.looseObject({
  room: slug,
  class: cls,
  reason: z.string().max(300),
  rate_interval: num.nonnegative().nullable().optional(),
  unique_tpl: share.optional(),
  eff_senders: num.nonnegative().optional(),
  top_share: share.optional(),
  repeat_share: share.optional(),
  senders: count.optional(),
});

export const latestSchema = z.looseObject({
  schema: z.literal("room-census/1"),
  census: censusNo,
  at_utc: isoDate,
  prev_at_utc: isoDate.nullable(),
  next: z.string().min(1).max(120),
  publisher: z.string().regex(DID),
  signed_in: z.looseObject({ room: z.string(), nonce: z.string().regex(NONCE) }).nullable(),
  snapshot: z.string().regex(SNAPSHOT),
  sha256: z.string().regex(HEX64),
  provenance: provenance.nullable(),
  summary: z.looseObject({
    active: count, varied: count, mixed: count, repetitive: count, baseline: z.boolean(),
    varied_share: share.nullable(), mixed_share: share.nullable(), repetitive_share: share.nullable(),
  }),
  coverage: z.looseObject({ measured: count, failed: count, interval_hours: num.positive().nullable() }).nullable(),
  partial: z.boolean(),
  changes: z.looseObject({
    class_changes: z.array(z.looseObject({ room: slug, from: z.string(), to: z.string() })),
    went_quiet: z.array(z.unknown()),
  }),
  global: z.looseObject({ new_rooms_per_hour: num.nonnegative().nullable() }),
  method: z.looseObject({
    window_msgs: censusNo,
    thresholds: z.looseObject({
      varied_min: z.looseObject({ unique_tpl: share, repeat_share: share, top_share: share, eff_senders: num.positive() }),
      repetitive_if_any: z.looseObject({ unique_tpl: share, top_share: share, repeat_share: share }),
      rise: z.looseObject({ ratio: num.positive(), min_per_hour: num.nonnegative() }),
    }),
  }),
  rooms: z.array(latestRoom),
});

const point = z.looseObject({
  census: censusNo,
  at_utc: isoDate,
  snapshot: z.string().regex(SNAPSHOT),
  sha256: z.string().regex(HEX64),
  signed_nonce: z.string().regex(NONCE).nullable(),
  manifest_sha256: z.string().regex(HEX64).nullable(),
  status: z.enum(["measured", "quiet", "absent", "failed"]),
  class: cls.nullable(),
  rate_interval: num.nonnegative().nullable(),
  window_estimate: num.nonnegative().nullable(),
  traffic_share: share.nullable(),
  traffic_rank: censusNo.nullable(),
  ranked_rooms: censusNo.nullable(),
  unique_tpl: share.nullable(),
  eff_senders: num.nonnegative().nullable(),
  top_share: share.nullable(),
});

export const roomSchema = z.looseObject({
  schema: z.literal("room-census-room/1"),
  room: slug,
  technocore: z.string(),
  first_census: censusNo,
  last_census: censusNo,
  censuses_measured: count,
  censuses_total: censusNo,
  early_history: z.boolean(),
  current: z.boolean(),
  latest_census_status: z.enum(["measured", "quiet", "absent", "failed"]),
  last_class: cls.nullable(),
  last_measured: point,
  history: z.array(point).min(1),
});

export const indexSchema = z.looseObject({
  schema: z.literal("room-census-rooms/1"),
  rooms: z.array(z.looseObject({
    room: slug, last_class: cls.nullable(), first_census: censusNo, last_census: censusNo,
    current: z.boolean(), censuses_measured: count, page: z.string(), data: z.string(),
  })),
});

export const identitySchema = z.looseObject({
  schema: z.literal("room-census-identity/1"),
  did: z.string().regex(DID),
  room: z.string(),
  provenance: provenance.nullable(),
});

export class DataContractError extends Error {}

function parse(schema, doc, name) {
  const r = schema.safeParse(doc);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new DataContractError(`${name} breaks the data contract: ${issues.join("; ")}`);
  }
  return r.data;
}

const fail = (m) => { throw new DataContractError(m); };

/** Validates every public document and their consistency, then returns what the pages need.
 *  `read(rel)` returns the parsed JSON of a published file (repository-relative path). */
export function loadSite(read) {
  const latest = parse(latestSchema, read("data/latest.json"), "data/latest.json");
  const identity = parse(identitySchema, read("identity.json"), "identity.json");
  const index = parse(indexSchema, read("data/rooms/index.json"), "data/rooms/index.json");
  if (identity.did !== latest.publisher) fail("identity.json and latest.json name different publishers");

  const rooms = new Map();
  for (const entry of index.rooms) {
    const s = entry.room;
    if (rooms.has(s)) fail(`duplicate room in the index: ${s}`);
    if (entry.page !== `rooms/${s}/` || entry.data !== `data/rooms/${s}.json`) fail(`index entry of ${s} does not use the contract paths`);
    const doc = parse(roomSchema, read(entry.data), entry.data);
    if (doc.room !== s) fail(`${entry.data} describes ${doc.room}`);
    if (doc.technocore !== `https://technocore.chat/r/${s}`) fail(`${entry.data} links an unexpected Technocore address`);
    for (const k of ["last_class", "first_census", "last_census", "current", "censuses_measured"]) {
      if (doc[k] !== entry[k]) fail(`index and ${entry.data} disagree on ${k}`);
    }
    if (doc.censuses_total !== latest.census || doc.history.length !== latest.census) {
      fail(`${entry.data} does not cover censuses 1 to ${latest.census}`);
    }
    doc.history.forEach((p, i) => {
      if (p.census !== i + 1) fail(`${entry.data} history is not census 1 to ${latest.census} in order`);
      const gap = p.status === "absent" || p.status === "failed";
      const values = ["rate_interval", "window_estimate", "traffic_share", "unique_tpl", "eff_senders", "top_share"];
      if (gap && (p.class !== null || values.some((k) => p[k] !== null))) {
        fail(`${entry.data} census #${p.census} is ${p.status} but carries values`);
      }
      if (p.status === "measured" && !CLASSES.includes(p.class)) fail(`${entry.data} census #${p.census} is measured without a class`);
      if (p.status === "quiet" && p.class !== "quiet") fail(`${entry.data} census #${p.census} is quiet with class ${p.class}`);
    });
    const measured = doc.history.filter((p) => p.status === "measured" || p.status === "quiet");
    if (measured.length !== doc.censuses_measured) fail(`${entry.data} miscounts its measured censuses`);
    const lastSeen = measured[measured.length - 1];
    if (!lastSeen || lastSeen.census !== doc.last_census || doc.last_measured.census !== doc.last_census || doc.last_class !== lastSeen.class) {
      fail(`${entry.data} last measured census does not match its history`);
    }
    if (doc.current !== (doc.last_census === latest.census)) fail(`${entry.data} current flag does not match its history`);
    if (doc.latest_census_status !== doc.history[doc.history.length - 1].status) fail(`${entry.data} latest status does not match its history`);
    rooms.set(s, doc);
  }

  // one census list, identical in every room document
  const censuses = [];
  for (let i = 0; i < latest.census; i++) {
    const ref = rooms.values().next().value?.history[i];
    if (!ref) fail("no room document to describe the censuses");
    for (const [s, doc] of rooms) {
      const p = doc.history[i];
      if (p.at_utc !== ref.at_utc || p.snapshot !== ref.snapshot || p.sha256 !== ref.sha256 || p.signed_nonce !== ref.signed_nonce) {
        fail(`data/rooms/${s}.json disagrees with the other rooms on census #${i + 1}`);
      }
    }
    censuses.push({ census: i + 1, at_utc: ref.at_utc, snapshot: ref.snapshot, sha256: ref.sha256,
      nonce: ref.signed_nonce, manifest_sha256: ref.manifest_sha256 });
  }
  const last = censuses[censuses.length - 1];
  if (last.snapshot !== latest.snapshot || last.sha256 !== latest.sha256) fail("the room documents and latest.json name different latest snapshots");
  if ((latest.signed_in?.nonce ?? null) !== last.nonce) fail("the room documents and latest.json name different signed messages");

  for (const r of latest.rooms) {
    const doc = rooms.get(r.room);
    if (!doc) fail(`latest.json lists ${r.room}, absent from the room index`);
    if (!doc.current) fail(`latest.json lists ${r.room}, which its room document calls stale`);
  }
  for (const c of latest.changes.class_changes) if (!rooms.has(c.room)) fail(`a class change names an unknown room: ${c.room}`);

  // per census aggregates for the charts: rooms by class and traffic between censuses
  const byCensus = censuses.map((c, i) => {
    const counts = { varied: 0, mixed: 0, repetitive: 0 };
    let traffic = 0;
    let rated = 0;
    for (const doc of rooms.values()) {
      const p = doc.history[i];
      if (p.status === "measured" && CLASSES.includes(p.class)) counts[p.class] += 1;
      if (p.status === "measured" && p.rate_interval !== null) { traffic += p.rate_interval; rated += 1; }
    }
    return { census: c.census, at_utc: c.at_utc, ...counts, traffic: rated ? traffic : null };
  });

  // what changed between the last two censuses, for rooms measured in both: the biggest increases of
  // messages per hour (among rooms above the published minimum rate) and the rooms seen for the first time
  const n = latest.census;
  const minRate = latest.method.thresholds.rise.min_per_hour;
  const increases = [];
  const newRooms = [];
  for (const doc of rooms.values()) {
    if (doc.first_census === n && n > 1) newRooms.push(doc.room);
    if (n < 2) continue;
    const before = doc.history[n - 2].rate_interval;
    const after = doc.history[n - 1].rate_interval;
    if (before !== null && after !== null && before > 0 && before >= minRate && after > before) {
      increases.push({ room: doc.room, before, after, change: (after - before) / before });
    }
  }
  increases.sort((a, b) => b.change - a.change || a.room.localeCompare(b.room));
  newRooms.sort();

  return { latest, identity, index, rooms, censuses, byCensus, increases, newRooms };
}
