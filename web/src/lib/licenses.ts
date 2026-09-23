// Licenses of what the site is made of, read at build time from the installed packages and the
// repository, so the published text is always the official one. A missing file stops the build.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WEB = process.cwd();
const REPO = resolve(WEB, "..");

export type Entry = { name: string; version?: string; license: string; use: string; url: string; text: string };

function read(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (e) {
    throw new Error(`license text unavailable: ${path}: ${(e as Error).message}`);
  }
}

const pkg = (name: string) => JSON.parse(read(resolve(WEB, "node_modules", name, "package.json"))).version as string;
const npm = (name: string, file: string, license: string, use: string, url: string): Entry =>
  ({ name, version: pkg(name), license, use, url, text: read(resolve(WEB, "node_modules", name, file)) });

export function licenses(): { project: Entry[]; shipped: Entry[] } {
  return {
    project: [
      { name: "Room Census code", license: "MIT", use: "The census runtime, this site and its tests.",
        url: "https://github.com/0x22ben/room-census", text: read(resolve(REPO, "LICENSE")) },
      { name: "Room Census data", license: "CC BY 4.0", use: "Every file under /data/: censuses, snapshots, room histories and the share card.",
        url: "https://creativecommons.org/licenses/by/4.0/", text: read(resolve(REPO, "data", "LICENSE")) },
    ],
    shipped: [
      npm("@fontsource-variable/inter", "LICENSE", "SIL Open Font License 1.1", "Inter, the text font, served from this site.", "https://github.com/rsms/inter"),
      npm("@fontsource/ibm-plex-mono", "LICENSE", "SIL Open Font License 1.1", "IBM Plex Mono, the font for numbers and labels, served from this site.", "https://github.com/IBM/plex"),
      npm("chart.js", "LICENSE.md", "MIT", "Draws the line charts.", "https://www.chartjs.org/"),
      npm("@kurkle/color", "LICENSE.md", "MIT", "Color handling inside Chart.js.", "https://github.com/kurkle/color"),
      npm("@lucide/astro", "LICENSE", "ISC", "Interface icons.", "https://lucide.dev/"),
      npm("tailwindcss", "LICENSE", "MIT", "Generates the stylesheet.", "https://tailwindcss.com/"),
      npm("astro", "LICENSE", "MIT", "Builds the static pages.", "https://astro.build/"),
    ],
  };
}
