// Site-wide constants: identity, navigation and the Content-Security-Policy every page carries.
import { RAW_REPOSITORY } from "./contest-files.mjs";

export const SITE_NAME = "Room Census";
export const REPOSITORY = "https://github.com/0x22ben/room-census";

// scripts, styles and fonts come from the site itself only; nothing inline, nothing embedded
const policy = (connect: string) => [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  `connect-src ${connect}`,
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");
export const CSP = policy("'self'");
// Create a DID, Verify and every room page read or write public room messages on Technocore from
// the browser;
// no other page may connect out
export const TECHNOCORE_CSP = policy("'self' https://technocore.chat");
// the pages that look a DID up in a contest (the account menu of the top bar, Find my DID, a trader's
// page, My DIDs) read the ranking and trades shards from this repository on raw.githubusercontent.com
// (src/lib/contest-files.mjs): that path only, never the whole host
export const CONTEST_CSP = policy(`'self' ${RAW_REPOSITORY}`);

export type Icon = "discover" | "rooms" | "watched" | "contests" | "rankings" | "did" | "write" | "search" | "verify" | "data" | "method" | "source";
export type NavItem = { label: string; href: string; icon: Icon; ready: boolean; external?: boolean };
export type NavSection = { label: string; items: NavItem[] };

// the sidebar of the approved mockup (Pencil hHTyx, 28 Sep 2026): the account lives in the top bar,
// so YOU keeps only the creation of a DID; Verify and Data sit in the footer group
export const NAV: NavSection[] = [
  {
    label: "Explore",
    items: [
      { label: "Discover rooms", href: "/", icon: "discover", ready: true },
      { label: "All rooms", href: "/rooms/", icon: "rooms", ready: true },
      { label: "Watched rooms", href: "/watched/", icon: "watched", ready: true },
      { label: "Contests", href: "/contests/", icon: "contests", ready: true },
      { label: "Rankings", href: "/rankings/", icon: "rankings", ready: true },
    ],
  },
  {
    label: "You",
    items: [
      { label: "Create a DID", href: "/did/", icon: "did", ready: true },
    ],
  },
];

export const NAV_FOOTER: NavItem[] = [
  { label: "Verify", href: "/verify/", icon: "verify", ready: true },
  { label: "Data", href: "/open-data/", icon: "data", ready: true },
  { label: "Method", href: "/method/", icon: "method", ready: true },
  { label: "Source code", href: REPOSITORY, icon: "source", ready: true, external: true },
];

export const readySections = (): NavSection[] =>
  NAV.map((s) => ({ ...s, items: s.items.filter((i) => i.ready) })).filter((s) => s.items.length > 0);

export function isActive(item: NavItem, pathname: string): boolean {
  if (item.external) return false;
  return item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
}
