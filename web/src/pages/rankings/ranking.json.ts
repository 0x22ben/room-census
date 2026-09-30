// The full Rankings list, for "Find my rank" and the saved DIDs: every DID FLOP Labs paid, with its
// shared rank, total FLOP, FLOP per contest and why it was paid there (a role, named in "roles").
// Built from the payout maps and allocation lists in src/data/flop-labs.
import type { APIRoute } from "astro";
import { rankings } from "../../lib/rankings";

export const GET: APIRoute = () => {
  const { paid, pending, rows } = rankings();
  const doc = {
    schema: "room-census/rankings/1",
    beta: true,
    note: "Unofficial. Made by Room Census, not by FLOP Labs. Counts only the FLOP that FLOP Labs awarded in the payout lists it published.",
    contests: paid.map((c) => ({ id: c.id, title: c.title, roles: c.labels })),
    pending: pending.map((p) => ({ id: p.id, title: p.title, prize: p.prize })),
    rows: rows.map((r) => [r.rank, r.did, r.flop, r.by, r.roles]),
  };
  return new Response(JSON.stringify(doc), { headers: { "Content-Type": "application/json" } });
};
