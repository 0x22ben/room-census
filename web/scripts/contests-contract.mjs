// The contract of data/contests/: the index of the contests the witness follows and one ranking file per
// contest. Every rule is blocking. The staging step runs it before any build, and the witness on the
// server runs that same staging step on a clone before it commits, so a malformed, incomplete or altered
// export can never reach the site. Since 2026-09-30 the witness publishes ranking v3 (rankingV3): nothing
// of our own recount; v1 and v2 stay accepted, so a return to the previous export never stops the build.
import { phase } from "../src/lib/contest-time.mjs";
import { SHARDS, shard } from "../src/lib/did-shard.mjs";

export class ContestContractError extends Error {}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const PNL = /^-?\d{1,9}\.\d{2}$/;
const PRICE = /^\d{1,7}\.\d{2}$/;
const QTY = /^-?\d{1,5}\.\d{2}$/;
const STATES = new Set(["ok", "warn", "wait"]);
const ROW_CHECK = new Set(["match", "pending", "differs"]);
const SOURCE = new Set(["official", "complete", "partial"]);
// ranking v2 also names a line of the referee's signed list that our recount has not confirmed
const SOURCE2 = new Set(["official", "signed", "complete", "partial"]);
const HEX2 = /^[0-9a-f]{2}$/;
const AMOUNT = /^\d{1,9}(\.\d{1,2})?$/;
const FEE = /^\d{1,12}(\.\d{1,30})?$/;
const MINT = new Set(["confirmed", "not_established"]);

const fail = (msg) => { throw new ContestContractError(msg); };
const need = (ok, msg) => { if (!ok) fail(msg); };
const text = (v, max = 400) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const int = (v, min = 0) => Number.isInteger(v) && v >= min;
const iso = (v) => typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v));
// an open position: [signed net contracts, average entry price]; null when the key holds none
const position = (v) => v === null || (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string" && QTY.test(v[0] ?? "") && Number(v[0]) !== 0 && PRICE.test(v[1] ?? "") && Number(v[1]) > 0);
const https = (v) => typeof v === "string" && /^https:\/\/[^\s"<>]+$/.test(v);

function checks(c, where) {
  need(Array.isArray(c.checks) && c.checks.length > 0, `${where}: no checks`);
  for (const [i, k] of c.checks.entries()) {
    need(k && STATES.has(k.state), `${where}: check ${i} has an unknown state`);
    need(text(k.title, 120) && text(k.text) && text(k.help), `${where}: check ${i} is incomplete`);
  }
  need(c.check && (c.check.level === "ok" || c.check.level === "partial") && text(c.check.label, 60), `${where}: summary check is incomplete`);
  const allOk = c.checks.every((k) => k.state === "ok");
  need((c.check.level === "ok") === allOk, `${where}: summary level does not follow its checks`);
}

function contest(c, capturedAt, where) {
  need(text(c.title, 80) && text(c.short, 40) && text(c.summary, 200), `${where}: title, short name or summary missing`);
  need(iso(c.opening) && iso(c.trading_lock_at), `${where}: opening or trading lock is not an ISO time`);
  need(c.final_price_at === null || iso(c.final_price_at), `${where}: final price time is not an ISO time`);
  const open = Date.parse(c.opening), lock = Date.parse(c.trading_lock_at);
  const final = c.final_price_at ? Date.parse(c.final_price_at) : lock;
  need(open < lock && lock <= final, `${where}: times out of order (opening < trading lock <= final price)`);
  need(c.status === phase(c, capturedAt), `${where}: status ${c.status} does not match its times at ${capturedAt}`);
  need(https(c.rules), `${where}: rules link is not an https URL`);
  need(text(c.prize, 40), `${where}: prize missing`);
  need(c.coverage_start === null || (iso(c.coverage_start) && Date.parse(c.coverage_start) >= open),
    `${where}: coverage must be null or start at or after the opening`);
  if (c.coverage_start !== null) need(Date.parse(c.coverage_start) <= Date.parse(capturedAt), `${where}: coverage starts after the capture time`);
  if (c.winner !== undefined) need(text(c.winner, 60) && text(c.winner_source, 60), `${where}: a winner needs its source`);
  checks(c, where);
  if (c.latest !== undefined) {
    const l = c.latest;
    need(int(l.sweep, 1) && iso(l.at) && int(l.owners) && PRICE.test(l.price ?? "") && iso(l.price_time) && int(l.price_age_s),
      `${where}: latest update is malformed`);
  }
  if (c.series !== undefined) {
    need(Array.isArray(c.series) && c.series.length > 0, `${where}: empty series`);
    c.series.forEach((s, i) => {
      need(int(s.n, 1) && iso(s.at) && int(s.owners) && (s.price === null || PRICE.test(s.price)), `${where}: series point ${i} is malformed`);
      // optional numbers: absent when the export cannot establish them, never guessed
      need(s.global === undefined || s.global === null || PRICE.test(s.global), `${where}: series point ${i} has a malformed agents' price`);
      for (const k of ["top", "line"]) need(s[k] === undefined || s[k] === null || PNL.test(s[k]), `${where}: series point ${i} has a malformed ${k} score`);
      for (const k of ["settled", "void", "active", "long", "short"]) need(s[k] === undefined || int(s[k]), `${where}: series point ${i} has a malformed ${k} count`);
      if (i > 0) {
        const p = c.series[i - 1];
        need(s.n > p.n, `${where}: series updates are not in increasing order`);
        need(s.owners >= p.owners, `${where}: registered players went down in the series`);
      }
    });
    if (c.latest) need(c.series[c.series.length - 1].n === c.latest.sweep, `${where}: the series does not end at the latest update`);
  }
  if (c.leaderboard !== undefined) {
    const lb = c.leaderboard;
    need(int(lb.sweep, 1) && iso(lb.at) && Array.isArray(lb.rows), `${where}: leaderboard is malformed`);
    const seen = new Set();
    lb.rows.forEach((r, i) => {
      need(r.rank === i + 1, `${where}: leaderboard ranks are not 1, 2, 3...`);
      need(DID.test(r.did ?? "") && !seen.has(r.did), `${where}: leaderboard row ${i + 1} has a bad or repeated DID`);
      seen.add(r.did);
      need(PNL.test(r.pnl ?? "") && ROW_CHECK.has(r.check), `${where}: leaderboard row ${i + 1} is malformed`);
      need(r.position === undefined || position(r.position), `${where}: leaderboard row ${i + 1} has a malformed position`);
    });
  }
  if (c.self_key !== undefined) {
    const s = c.self_key;
    need(DID.test(s.did ?? ""), `${where}: our key is not a did:key`);
    need(s.registration === null || (SLUG.test(s.registration.room ?? "") && int(s.registration.seq, 1) && iso(s.registration.at)),
      `${where}: our registration evidence is malformed`);
    need(MINT.has(s.mint) && typeof s.settled_trade === "boolean", `${where}: our key status is malformed`);
  }
}

/** Ranking v2: a summary with the first places, and every key in one of 256 files by the hash of its
 * DID. The referee's signed list comes first with its own ranks and signed scores, then our recount. */
function rankingV2(doc, c, where, files, read) {
  need(doc.sweep === c.ranking.sweep && int(doc.sweep, 1), `${where}: its update differs from the index`);
  need(int(doc.traders) && c.ranking.traders === doc.traders && doc.shards === SHARDS, `${where}: trader count or shard count differs`);
  need(int(doc.owners) && text(doc.capture_start, 40) && doc.notes && [...SOURCE2].every((k) => text(doc.notes[k])),
    `${where}: owners, capture start or notes missing`);
  const row = (r, w) => {
    need(Array.isArray(r) && (r.length === 4 || r.length === 5), `${w} is not [rank, did, pnl, source, position?]`);
    need(int(r[0], 1) && DID.test(r[1] ?? "") && PNL.test(r[2] ?? "") && SOURCE2.has(r[3]), `${w} is malformed`);
    need(r.length === 4 || position(r[4]), `${w} has a malformed position`);
  };
  need(Array.isArray(doc.top) && doc.top.length <= Math.min(1000, doc.traders), `${where}: top list missing or too long`);
  const signedRows = c.leaderboard && c.leaderboard.sweep === doc.sweep ? c.leaderboard.rows : null;
  let previous = Infinity;
  doc.top.forEach((r, i) => {
    row(r, `${where}: top row ${i + 1}`);
    need(r[0] === i + 1, `${where}: top ranks are not 1, 2, 3...`);
    const signed = r[3] === "official" || r[3] === "signed";
    if (signedRows) {
      if (i < signedRows.length) {
        const l = signedRows[i];
        need(signed && r[1] === l.did && r[2] === l.pnl, `${where}: top row ${i + 1} is not line ${i + 1} of the referee's signed list`);
        need((r[3] === "official") === (l.check === "match"), `${where}: top row ${i + 1} is marked ${r[3]} but checked ${l.check}`);
      } else {
        need(!signed, `${where}: top row ${i + 1} is marked as signed but is not in the referee's list`);
        need(Number(r[2]) <= previous, `${where}: rows after the signed list are not sorted by profit`);
        previous = Number(r[2]);
      }
    }
  });
  // every key in its shard, every rank once
  const ranks = new Uint8Array(doc.traders + 1);
  const byDid = new Map();
  for (let k = 0; k < SHARDS; k++) {
    const hh = k.toString(16).padStart(2, "0");
    const rel = `data/contests/${c.id}.ranking.${hh}.json`;
    need(files.includes(rel), `${where}: shard ${hh} is missing`);
    const d = read(rel);
    need(d && d.schema === "room-census/contest-ranking-shard/1" && d.contest === c.id && d.sweep === doc.sweep && d.shard === hh && Array.isArray(d.rows),
      `${rel} is not shard ${hh} of this ranking`);
    d.rows.forEach((r, i) => {
      row(r, `${rel}: row ${i + 1}`);
      need(shard(r[1]) === hh, `${rel}: ${r[1]} belongs to shard ${shard(r[1])}`);
      need(r[0] <= doc.traders && ranks[r[0]] === 0, `${rel}: rank ${r[0]} is out of range or repeated`);
      ranks[r[0]] = 1;
      need(!byDid.has(r[1]), `${rel}: ${r[1]} is listed twice`);
      byDid.set(r[1], r);
    });
  }
  need(byDid.size === doc.traders, `${where}: the shards hold ${byDid.size} keys, not ${doc.traders}`);
  for (const r of doc.top) {
    const same = byDid.get(r[1]);
    need(same && same[0] === r[0] && same[2] === r[2] && same[3] === r[3], `${where}: ${r[1]} differs between the top list and its shard`);
  }
  if (c.self_key) need(c.self_key.settled_trade === byDid.has(c.self_key.did), `${where}: our key's settled-trade status disagrees with the ranking`);
}

const RANKING_V3_KEYS = ["at", "contest", "schema", "shards", "sweep"];

/** Ranking v3 (Ben, 2026-09-30: never show a wrong figure): until our recount can be proved against the
 * referee's signed hashes, nothing of it is published. The summary only names the update and the 256
 * trades files next to it: no ranking row, no ranking shard, no trader count; the index carries no open
 * position and no active, long or short count; and only the keys of the referee's signed top list, at
 * that same update, may have trades published (checked in trades()). */
function rankingV3(doc, c, where) {
  need(Object.keys(doc).sort().join() === RANKING_V3_KEYS.join(), `${where}: a v3 summary holds only ${RANKING_V3_KEYS.join(", ")}`);
  need(doc.sweep === c.ranking.sweep && int(doc.sweep, 1) && iso(doc.at) && doc.shards === SHARDS, `${where}: its update, time or shard count is malformed or differs from the index`);
  need(c.ranking.traders === undefined, `${where}: the index still counts the traders of our recount`);
  need(c.leaderboard && c.leaderboard.sweep === doc.sweep, `${where}: the referee's signed top list is not at the same update`);
  need(c.leaderboard.rows.every((r) => r.position === undefined), `${where}: the signed top list carries positions of our recount`);
  need((c.series ?? []).every((s) => ["active", "long", "short"].every((k) => s[k] === undefined)),
    `${where}: the series carries active, long or short counts of our recount`);
}

/** The settled trades of the keys, in the same 256 shards: optional. `only`, when given, is the set of
 * the keys whose trades may be published (ranking v3: the referee's signed top list). */
function trades(c, sweep, files, read, only) {
  const rels = files.filter((f) => f.startsWith(`data/contests/${c.id}.trades.`));
  if (rels.length === 0) return rels;
  need(rels.length === SHARDS, `the trades of ${c.id} are in ${rels.length} files, not ${SHARDS}`);
  for (const rel of rels) {
    const hh = rel.slice(`data/contests/${c.id}.trades.`.length, -5);
    need(HEX2.test(hh), `unexpected trades file ${rel}`);
    const d = read(rel);
    need(d && d.schema === "room-census/contest-trades/1" && d.contest === c.id && d.shard === hh && int(d.sweep, 1) && d.sweep <= sweep
      && d.keys && typeof d.keys === "object" && !Array.isArray(d.keys), `${rel} is not trades shard ${hh} of ${c.id}`);
    for (const [did, list] of Object.entries(d.keys)) {
      need(DID.test(did) && shard(did) === hh && Array.isArray(list) && list.length > 0, `${rel}: bad key ${did}`);
      need(!only || only.has(did), `${rel}: ${did} is not in the referee's signed top list, its trades are not published`);
      for (const t of list) {
        need(Array.isArray(t) && t.length === 5 && int(t[0], 1) && t[0] <= d.sweep && ["b", "s", "x"].includes(t[1])
          && AMOUNT.test(t[2] ?? "") && AMOUNT.test(t[3] ?? "") && FEE.test(t[4] ?? ""), `${rel}: a trade of ${did} is malformed`);
      }
    }
  }
  return rels;
}

function ranking(doc, c, where) {
  need(doc && doc.schema === "room-census/contest-ranking/1" && doc.contest === c.id, `${where} is not the room-census/contest-ranking/1 document of ${c.id}`);
  need(doc.sweep === c.ranking.sweep && int(doc.sweep, 1), `${where}: its update differs from the index`);
  need(Array.isArray(doc.rows) && doc.traders === doc.rows.length && c.ranking.traders === doc.rows.length,
    `${where}: trader count differs from its rows or from the index`);
  need(int(doc.owners) && text(doc.capture_start, 40) && doc.notes && SOURCE.size === Object.keys(doc.notes).filter((k) => SOURCE.has(k) && text(doc.notes[k])).length,
    `${where}: owners, capture start or notes missing`);
  const seen = new Set();
  let previous = Infinity;
  doc.rows.forEach((r, i) => {
    need(Array.isArray(r) && (r.length === 4 || r.length === 5), `${where}: row ${i + 1} is not [rank, did, pnl, source, position?]`);
    const [rank, did, pnl, source] = r;
    need(r.length === 4 || position(r[4]), `${where}: row ${i + 1} has a malformed position`);
    need(rank === i + 1, `${where}: ranks are not 1, 2, 3...`);
    need(DID.test(did ?? "") && !seen.has(did), `${where}: row ${i + 1} has a bad or repeated DID`);
    seen.add(did);
    need(PNL.test(pnl ?? "") && SOURCE.has(source), `${where}: row ${i + 1} is malformed`);
    need(Number(pnl) <= previous, `${where}: rows are not sorted by profit`);
    previous = Number(pnl);
  });
  if (c.leaderboard && c.leaderboard.sweep === doc.sweep) {
    const signed = new Map(c.leaderboard.rows.filter((r) => r.check === "match").map((r) => [r.did, r.pnl]));
    for (const [, did, pnl, source] of doc.rows) {
      if (source !== "official") continue;
      need(signed.has(did), `${where}: ${did} is marked official but not checked in the leaderboard`);
      need(signed.get(did) === pnl, `${where}: ${did} is marked official but does not show the referee's signed profit`);
    }
  }
  if (c.self_key) need(c.self_key.settled_trade === seen.has(c.self_key.did), `${where}: our key's settled-trade status disagrees with the ranking`);
}

/** Checks data/contests/ as a whole. `files` are the staged paths under data/contests/, `read(rel)` parses one. */
export function checkContests(files, read) {
  if (files.length === 0) return;
  need(files.includes("data/contests/index.json"), "data/contests/ has files but no index.json");
  const index = read("data/contests/index.json");
  need(index && index.schema === "room-census-contests/2" && iso(index.captured_at) && Array.isArray(index.contests) && index.contests.length > 0,
    "data/contests/index.json is not a room-census-contests/2 document");
  const named = new Set(["data/contests/index.json"]);
  const ids = new Set();
  for (const c of index.contests) {
    need(c && SLUG.test(c.id ?? "") && !ids.has(c.id), `unsafe or duplicate contest id: ${JSON.stringify(c?.id)}`);
    ids.add(c.id);
    contest(c, index.captured_at, `contest ${c.id}`);
    if (c.ranking) {
      const rel = `data/contests/${c.id}.ranking.json`;
      need(c.ranking.file === `/${rel}` && files.includes(rel), `ranking of ${c.id} does not resolve: ${c.ranking.file}`);
      const doc = read(rel);
      let only;
      if (doc && doc.schema === "room-census/contest-ranking/3" && doc.contest === c.id) {
        rankingV3(doc, c, rel);
        only = new Set(c.leaderboard.rows.map((r) => r.did));
      } else if (doc && doc.schema === "room-census/contest-ranking/2" && doc.contest === c.id) {
        rankingV2(doc, c, rel, files, read);
        for (let k = 0; k < SHARDS; k++) named.add(`data/contests/${c.id}.ranking.${k.toString(16).padStart(2, "0")}.json`);
      } else {
        ranking(doc, c, rel);
      }
      named.add(rel);
      for (const t of trades(c, c.ranking.sweep, files, read, only)) named.add(t);
    }
  }
  for (const rel of files) need(named.has(rel), `contest file named by no contest: ${rel}`);
}
