// The full ranking of our recount, served as a static file for "Find my DID". Built from the sample
// until the live export exists (step 3).
import type { APIRoute } from "astro";
import ranking from "../../../fixtures/close-1.ranking.sample.json";
import { contests } from "../../../lib/contests";

export function getStaticPaths() {
  return contests().filter((c) => c.ranking).map((c) => ({ params: { id: c.id } }));
}

export const GET: APIRoute = ({ params }) =>
  params.id === "close-1"
    ? new Response(JSON.stringify(ranking), { headers: { "Content-Type": "application/json" } })
    : new Response("{}", { status: 404 });
