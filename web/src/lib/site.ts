// Site-wide constants: identity, navigation and the Content-Security-Policy every page carries.

export const SITE_NAME = "Room Census";
export const REPOSITORY = "https://github.com/0x22ben/room-census";

// scripts and styles come from the site itself only; nothing inline, nothing embedded
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

export type NavItem = { label: string; href: string; ready: boolean };

// the three primary destinations of ROOM_CENSUS_UX_SPEC.md; a destination stays out of the
// navigation until it is ready (Create DID waits for its recovery tests and security review)
export const NAV: NavItem[] = [
  { label: "Overview", href: "/", ready: true },
  { label: "Rooms", href: "/rooms/", ready: true },
  { label: "Create DID", href: "/did/", ready: false },
];

export function isActive(item: NavItem, pathname: string): boolean {
  return item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
}
