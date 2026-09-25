// The contract of data/contests/: the index of the contests the witness follows and one ranking file per
// contest. Every rule is blocking. The staging step runs it before any build, and the witness on the
// server runs that same staging step on a clone before it commits, so a malformed, incomplete or altered
// export can never reach the site.
import { phase } from "../src/lib/contest-time.mjs";

export class ContestContractError extends Error {}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const PNL = /^-?\d{1,9}\.\d{2}$/;
const PRICE = /^\d{1,7}\.\d{2}$/;
const STATES = new Set(["ok", "warn", "wait"]);
const ROW_CHECK = new Set(["match", "pending", "differs"]);
const SOURCE = new Set(["official", "complete", "partial"]);
const MINT = new Set(["confirmed", "not_established"]);

const fail = (msg) => { throw new ContestContractError(msg); };
const need = (ok, msg) => { if (!ok) fail(msg); };
const text = (v, max = 400) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const int = (v, min = 0) => Number.isInteger(v) && v >= min;
const iso = (v) => typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v));
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
    need(Array.isArray(r) && r.length === 4, `${where}: row ${i + 1} is not [rank, did, pnl, source]`);
    const [rank, did, pnl, source] = r;
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
      ranking(read(rel), c, rel);
      named.add(rel);
    }
  }
  for (const rel of files) need(named.has(rel), `contest file named by no contest: ${rel}`);
}
