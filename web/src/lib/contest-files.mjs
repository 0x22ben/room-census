// Where the browser reads the heavy files of a contest: the 256 ranking shards and the 256 trades shards.
// They are not part of the site (GitHub Pages caps a published site at 1 GB, and they grow every 15
// minutes): the Pages build embeds the commit of the contest-data branch it used (CONTEST_DATA_REF, set
// by .github/workflows/pages.yml), and the pages read the shards of that exact commit from
// raw.githubusercontent.com. A commit never changes, so one address always gives the same bytes and every
// shard read by one page load comes from the same publication as the ranking summary the site serves.
// Without that commit (local build, no contest-data branch) the shards are asked from the site itself.
import { shardFile } from "./did-shard.mjs";

/** The one place outside the site a contest page may read from (the connect-src of CONTEST_CSP). */
export const RAW_REPOSITORY = "https://raw.githubusercontent.com/0x22ben/room-census/";
/** Where the shards are asked when the build names no contest-data commit. */
export const LOCAL_CONTEST_FILES = "/data/contests/";

const COMMIT = /^[0-9a-f]{40}$/;
const KINDS = new Set(["ranking", "trades"]);

/** The folder the shards are read from, for the contest-data commit `ref` (a full 40-hex SHA-1, as
 * `git rev-parse` prints it). No ref, or an empty one: the site's own /data/contests/. Anything else is
 * refused, so a branch name, a short or mistyped commit never ends up in an address. */
export function contestFilesBase(ref) {
  if (ref === undefined || ref === null || ref === "") return LOCAL_CONTEST_FILES;
  if (typeof ref !== "string" || !COMMIT.test(ref)) {
    throw new Error(`CONTEST_DATA_REF must be a full 40-hex commit SHA, not ${JSON.stringify(ref)}`);
  }
  return `${RAW_REPOSITORY}${ref}/data/contests/`;
}

/** The address of one shard: the file next to the contest's ranking summary (`mainFile`, e.g.
 * "/data/contests/close-1.ranking.json"), read from `base` (contestFilesBase). */
export function shardUrl(base, mainFile, kind, s) {
  if (!KINDS.has(kind)) throw new Error(`unknown shard kind ${JSON.stringify(kind)}`);
  if (!/^[0-9a-f]{2}$/.test(s)) throw new Error(`not a shard: ${JSON.stringify(s)}`);
  const name = shardFile(mainFile, kind, s).split("/").pop();
  if (!name.endsWith(`.${kind}.${s}.json`)) throw new Error(`not a contest ranking file: ${JSON.stringify(mainFile)}`);
  return `${base}${name}`;
}
