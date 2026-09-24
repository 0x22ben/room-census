// Site-wide constants: identity, navigation and the Content-Security-Policy every page carries.

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
// My DID, Write and Verify read or write public room messages on Technocore from the browser;
// no other page may connect out
export const TECHNOCORE_CSP = policy("'self' https://technocore.chat");

export type Icon = "discover" | "rooms" | "watched" | "did" | "write" | "search" | "verify" | "data" | "method" | "source";
export type NavItem = { label: string; href: string; icon: Icon; ready: boolean; external?: boolean };
export type NavSection = { label: string; items: NavItem[] };

// the sidebar of the approved mockup; a destination stays out of the navigation until its page
// exists (My DID ships with the public lookup; Create and Restore wait for their security review)
export const NAV: NavSection[] = [
  {
    label: "Explore",
    items: [
      { label: "Discover rooms", href: "/", icon: "discover", ready: true },
      { label: "All rooms", href: "/rooms/", icon: "rooms", ready: true },
      { label: "Watched rooms", href: "/watched/", icon: "watched", ready: true },
    ],
  },
  {
    label: "You",
    items: [
      { label: "My DID", href: "/did/", icon: "did", ready: true },
      { label: "Write", href: "/write/", icon: "write", ready: true },
      { label: "Look up a DID", href: "/look-up/", icon: "search", ready: true },
    ],
  },
  {
    label: "Evidence",
    items: [
      { label: "Verify", href: "/verify/", icon: "verify", ready: true },
      { label: "Data", href: "/open-data/", icon: "data", ready: true },
    ],
  },
];

export const NAV_FOOTER: NavItem[] = [
  { label: "Method", href: "/method/", icon: "method", ready: true },
  { label: "Source code", href: REPOSITORY, icon: "source", ready: true, external: true },
];

export const readySections = (): NavSection[] =>
  NAV.map((s) => ({ ...s, items: s.items.filter((i) => i.ready) })).filter((s) => s.items.length > 0);

export function isActive(item: NavItem, pathname: string): boolean {
  if (item.external) return false;
  return item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
}
