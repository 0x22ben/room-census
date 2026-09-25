// A small but complete and valid data/contests/ pair, for the contract and staging tests. Built in code so
// each test can change one field and see the contract refuse it.
const did = (tail) => `did:key:z6Mk${tail.padEnd(44, "a")}`;
export const DIDS = [did("gTDg3hEz4pwiFcJCDjRvR3hZbVWwy23oGuqFbFxu7Hne"), did("eTcR7He7sY6imuJguhifiNKrWceKNus5HGuajbAwymdK"), did("hn3VX65yYQ8XpbqbuyriEWBdwQGR5RZTc76pMmRQPg7F")];
export const SELF = did("mpb5XhgweP9mfxnA3vpQRu2VcSsGyFC7AfE3ZEFqXxD1");

const check = (state, title) => ({ state, title, text: `${title}: text`, help: `${title}: help` });

export function validIndex() {
  return {
    schema: "room-census-contests/2",
    captured_at: "2026-09-25T17:38:09.819914Z",
    contests: [
      {
        id: "close-1", title: "Close Call · NVDA", short: "Close Call", summary: "Agents bet on the price of NVDA on 4 October.",
        status: "live", opening: "2026-09-25T12:00:00Z", trading_lock_at: "2026-10-04T09:00:00Z", final_price_at: "2026-10-04T10:00:00Z",
        coverage_start: "2026-09-25T13:32:19.958388Z",
        prize: "1,000,000 FLOP", prize_note: "shared by the top 3 after mainnet",
        rules: "https://github.com/flop-labs/technocore-close-call-challenge",
        check: { level: "partial", label: "Partly checked" },
        checks: [check("ok", "The records are genuine"), check("warn", "Part of the trading room is lost")],
        latest: { sweep: 2, at: "2026-09-25T17:31:00Z", owners: 600784, price: "224.87", price_time: "2026-09-25T17:34:00Z", price_age_s: 0 },
        series: [{ n: 1, at: "2026-09-25T12:05:22Z", owners: 10, price: "226.26" }, { n: 2, at: "2026-09-25T17:31:00Z", owners: 600784, price: "224.87" }],
        leaderboard: { sweep: 2, at: "2026-09-25T17:31:00Z", rows: [{ rank: 1, did: DIDS[0], pnl: "76.35", check: "match" }, { rank: 2, did: DIDS[1], pnl: "68.41", check: "pending" }] },
        ranking: { sweep: 2, traders: 3, file: "/data/contests/close-1.ranking.json" },
        self_key: { did: SELF, registration: { room: "close1", seq: 152370, at: "2026-09-25T13:30:28.129773Z" }, mint: "not_established", settled_trade: false },
      },
      {
        id: "sonnet-2", title: "Sonnet Challenge", short: "Sonnet Challenge", summary: "Agents wrote sonnets and voted.",
        status: "ended", opening: "2026-09-11T12:00:00Z", trading_lock_at: "2026-09-18T12:00:00Z", final_price_at: null,
        coverage_start: null, prize: "100,000 FLOP", winner: "maragung-flop", winner_source: "named by the referee",
        rules: "https://github.com/flop-labs/technocore-sonnet-challenge",
        check: { level: "partial", label: "Partly checked" },
        checks: [check("ok", "The payments list is the one the referee signed"), check("wait", "The votes cannot be recounted")],
      },
    ],
  };
}

export function validRanking() {
  return {
    schema: "room-census/contest-ranking/1", contest: "close-1", sweep: 2, at: "2026-09-25T17:31:00Z",
    traders: 3, owners: 600784, capture_start: "13:32 UTC",
    notes: { official: "official note", complete: "complete note", partial: "partial note" },
    rows: [[1, DIDS[0], "76.35", "official"], [2, DIDS[1], "68.40", "partial"], [3, DIDS[2], "-3.10", "complete"]],
  };
}
