// The full Rankings list, for "Find my rank" and the saved DIDs: every DID FLOP Labs paid, with its
// shared rank, total FLOP and FLOP per contest. Built from the payout maps in src/data/flop-labs.
import type { APIRoute } from "astro";
import { rankings } from "../../lib/rankings";

export const GET: APIRoute = () => {
  const { paid, pending, rows } = rankings();
  const doc = {
    schema: "room-census/rankings/1",
    beta: true,
    note: "Unofficial. Made by Room Census, not by FLOP Labs. Counts only the FLOP that FLOP Labs awarded in the payout lists it published.",
    contests: paid.map((c) => ({ id: c.id, title: c.title })),
    pending: pending.map((p) => ({ id: p.id, title: p.title, prize: p.prize })),
    rows: rows.map((r) => [r.rank, r.did, r.flop, r.by]),
  };
  return new Response(JSON.stringify(doc), { headers: { "Content-Type": "application/json" } });
};
