// Site-wide constants: identity, navigation and the Content-Security-Policy every page carries.

export const SITE_NAME = "Room Census";
export const REPOSITORY = "https://github.com/0x22ben/room-census";

// scripts, styles and fonts come from the site itself only; nothing inline, nothing embedded
export const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

export type Icon = "overview" | "rooms" | "did" | "verify" | "data" | "method" | "source";
export type NavItem = { label: string; href: string; icon: Icon; ready: boolean; external?: boolean };
export type NavSection = { label: string; items: NavItem[] };

// the sidebar of the approved mockup; a destination stays out of the navigation until its page
// exists (Create DID also waits for its recovery tests and security review)
export const NAV: NavSection[] = [
  {
    label: "Explore",
    items: [
      { label: "Overview", href: "/", icon: "overview", ready: true },
      { label: "Rooms", href: "/rooms/", icon: "rooms", ready: true },
      { label: "Create DID", href: "/did/", icon: "did", ready: false },
    ],
  },
  {
    label: "Evidence",
    items: [
      { label: "Verify", href: "/verify/", icon: "verify", ready: false },
      { label: "Data", href: "/data/", icon: "data", ready: false },
    ],
  },
];

export const NAV_FOOTER: NavItem[] = [
  { label: "Method", href: "/method/", icon: "method", ready: false },
  { label: "Source code", href: REPOSITORY, icon: "source", ready: true, external: true },
];

export const readySections = (): NavSection[] =>
  NAV.map((s) => ({ ...s, items: s.items.filter((i) => i.ready) })).filter((s) => s.items.length > 0);

export function isActive(item: NavItem, pathname: string): boolean {
  if (item.external) return false;
  return item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
}
