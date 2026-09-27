// The pixel avatar of a DID: a 5 x 5 grid mirrored left to right, drawn from the FNV-1a hash of the
// key, in one colour of a small palette. The same key always gets the same avatar, on every page.
const PALETTE = ["#2ec4a6", "#3b6fd6", "#e3b341", "#f0616d", "#a77bf3", "#8fc0ff", "#cd8a55"];

function fnv(text) {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** { color, cells: [[x, y], ...] } on a 5 x 5 grid. */
export function avatar(did) {
  const h = fnv(did);
  const cells = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if ((h >>> (y * 3 + x)) & 1) {
        for (const xx of x === 2 ? [2] : [x, 4 - x]) cells.push([xx, y]);
      }
    }
  }
  if (cells.length === 0) cells.push([2, 2]);
  return { color: PALETTE[h % PALETTE.length], cells };
}

/** The avatar as an <svg> element, for pages that draw it in the browser. */
export function avatarSvg(did, size) {
  const ns = "http://www.w3.org/2000/svg";
  const { color, cells } = avatar(did);
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 5 5");
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "shrink-0 rounded-sm bg-bg");
  for (const [x, y] of cells) {
    const r = document.createElementNS(ns, "rect");
    r.setAttribute("x", String(x));
    r.setAttribute("y", String(y));
    r.setAttribute("width", "1");
    r.setAttribute("height", "1");
    r.setAttribute("fill", color);
    svg.append(r);
  }
  return svg;
}
