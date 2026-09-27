// The pixel pictures of the contest cards (Pencil mockup MXuy7), drawn on a 64 x 30 grid and merged
// into horizontal runs. Each contest has its scene: Close Call a candle chart climbing to the price
// line with the trophy, Sonnet a parchment and a quill; "next" is the card of the contest to come.
export const W = 64;
export const H = 30;

function canvas() {
  const px = new Map();
  const put = (x, y, c) => { if (x >= 0 && x < W && y >= 0 && y < H) px.set(`${x},${y}`, c); };
  const glyph = (rows, x0, y0, c) => rows.forEach((r, y) => [...r].forEach((ch, x) => ch !== " " && put(x0 + x, y0 + y, c)));
  const dots = (list, c) => list.forEach(([x, y]) => put(x, y, c));
  return { px, put, glyph, dots };
}

/** [x, y, width, colour] runs, left to right, top to bottom. */
function runs(px) {
  const out = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W;) {
      const c = px.get(`${x},${y}`);
      if (!c) { x++; continue; }
      let e = x;
      while (px.get(`${e + 1},${y}`) === c) e++;
      out.push([x, y, e - x + 1, c]);
      x = e + 1;
    }
  }
  return out;
}

function candles() {
  const { px, put, glyph, dots } = canvas();
  dots([[3, 3], [20, 2], [47, 1], [33, 5], [2, 14], [40, 24]], "#2ec4a655");
  for (let x = 0; x < W; x += 2) put(x, 9, "#e3b34199");
  // open, close, low, high: rows grow downwards, so a close above the open is a rise
  const bars = [[24, 20, 27, 18], [20, 17, 23, 15], [18, 19, 21, 14], [19, 14, 22, 12], [14, 15, 18, 11], [15, 12, 17, 9], [12, 13, 15, 10], [13, 10, 15, 8], [10, 8, 12, 6]];
  bars.forEach(([o, c, lo, hi], i) => {
    const x = 3 + i * 5;
    const col = c < o ? "#2ec4a6" : "#f0616d";
    for (let y = hi; y <= lo; y++) put(x + 1, y, `${col}99`);
    for (let y = Math.min(o, c); y <= Math.max(o, c); y++) for (let k = 0; k < 3; k++) put(x + k, y, col);
  });
  for (let x = 0; x < W; x++) put(x, 28, "#262d35");
  glyph(["#########", "#########", " ####### ", "  #####  ", "   ###   ", "    #    ", "   ###   ", " ####### "], 51, 12, "#e3b341");
  dots([[50, 12], [50, 13], [50, 14], [60, 12], [60, 13], [60, 14]], "#e3b341");
  for (let x = 49; x <= 61; x++) put(x, 20, "#9a6f12");
  return px;
}

function poem() {
  const { px, put, glyph, dots } = canvas();
  dots([[4, 3], [10, 20], [56, 6], [60, 22], [28, 2], [48, 26], [2, 25], [62, 14]], "#e3b34188");
  for (let y = 6; y <= 26; y++) for (let x = 16; x <= 42; x++) put(x, y, "#e8dcc0");
  for (let y = 6; y <= 26; y++) { put(15, y, "#c9b48a"); put(43, y, "#c9b48a"); }
  for (let x = 15; x <= 43; x++) { put(x, 5, "#c9b48a"); put(x, 27, "#c9b48a"); }
  [[9, 19, 38], [12, 19, 40], [15, 19, 36], [18, 19, 39], [21, 19, 33]].forEach(([y, a, b]) => {
    for (let x = a; x <= b; x++) if ((x - a) % 7 !== 5) put(x, y, "#8a6f47");
  });
  for (let t = 0; t <= 12; t++) {
    const x0 = 52 - t, y0 = 1 + t;
    put(x0, y0, "#ffffff");
    const w = t < 2 ? 0 : t < 9 ? 2 : t < 11 ? 1 : 0;
    for (let k = 1; k <= w; k++) { put(x0 + k, y0 + k, "#c4b5fd"); put(x0 - k, y0 - k, k === w ? "#a77bf3" : "#ddd6fe"); }
  }
  dots([[39, 14], [38, 15]], "#3b2f1f");
  dots([[37, 16], [36, 16]], "#1a1410");
  glyph(["# # #", "#####", "#####"], 27, 1, "#e3b341");
  return px;
}

function next() {
  const { px, put, glyph, dots } = canvas();
  dots([[5, 5], [57, 4], [12, 23], [52, 24], [30, 2]], "#3a444f");
  for (let y = 6; y <= 21; y++) {
    for (let x = 24; x <= 39; x++) put(x, y, x === 24 || y === 6 ? "#f5cf6a" : x === 39 || y === 21 ? "#9a6f12" : "#e3b341");
  }
  dots([[26, 8], [37, 8], [26, 19], [37, 19]], "#9a6f12");
  glyph([" #### ", "##  ##", "    ##", "   ## ", "  ##  ", "      ", "  ##  "], 29, 9, "#7a560c");
  for (let x = 24; x <= 39; x++) put(x, 22, "#00000066");
  for (let x = 0; x < W; x++) for (let y = 26; y < H; y++) put(x, y, (x + y) % 4 < 2 ? "#1d2330" : "#181d23");
  return px;
}

const SCENES = { "close-1": candles, "sonnet-2": poem, next };

/** The scene of a contest (the trophy chart when it has none of its own yet), as runs. */
export function scene(id) {
  return runs((SCENES[id] ?? candles)());
}

/** The background of each scene, a top-to-bottom gradient in the card. */
export const TINT = { "close-1": "from-[#0c211d]", "sonnet-2": "from-[#1a1233]", next: "from-surface-raised" };
