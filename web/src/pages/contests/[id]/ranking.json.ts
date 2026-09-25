// Sample mode only: the full ranking of our recount from the sample, for "Find my DID". Live, the
// witness publishes it as data/contests/<id>.ranking.json and this route builds nothing.
import type { APIRoute } from "astro";
import ranking from "../../../fixtures/close-1.ranking.sample.json";
import { SAMPLE, contests } from "../../../lib/contests";

export function getStaticPaths() {
  return SAMPLE ? contests().filter((c) => c.ranking).map((c) => ({ params: { id: c.id } })) : [];
}

export const GET: APIRoute = ({ params }) =>
  params.id === "close-1"
    ? new Response(JSON.stringify(ranking), { headers: { "Content-Type": "application/json" } })
    : new Response("{}", { status: 404 });
