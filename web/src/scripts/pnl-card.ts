// The score card a player can share on X: drawn in the browser on a 1200 x 675 canvas, from the
// numbers already on the page (Pencil mockup, nodes CZ6BX and jG5es, as redrawn by Ben on 27 Sep 2026). Nothing is sent anywhere: the
// reader shares the picture through the system share sheet, or downloads it and posts it themselves.

export type Card = {
  did: string; score: number; rank: number; traders: number; contest: string; sweep: number;
  position?: string; line?: number; prices: number[]; official?: boolean;
  /** how many trades the key made, and what its best one realized (the tiles of mockup CZ6BX) */
  trades?: number; best?: number;
  /** what the curve shows: the NVDA price by default, or the key's own score */
  curveLabel?: string;
  /** false when the card is shared from someone's trader page: then it says SCORE, not MY SCORE */
  mine?: boolean;
};

const W = 1200, H = 675;
const C = { bg: "#090c0f", surface: "#12161b", border: "#262d35", text: "#e8ecef", soft: "#b9c0c9", muted: "#7d8894",
  up: "#2ec4a6", down: "#f0616d", gold: "#e39b4b", goldSoft: "#2a1d0f", goldBorder: "#5c3d1d" };
const PIXEL = "Silkscreen", MONO = "IBM Plex Mono";
// pixelarticons (MIT) paths, on a 24-unit grid
const ICON = {
  trophy: "M16 17H13V19H15V21H9V19H11V17H8V15H16V17ZM18 5H22V11H20V7H18V11H20V13H18V15H16V5H8V15H6V13H4V11H6V7H4V11H2V5H6V3H18V5Z",
  crown: "M3 3h2v12H3zm16 0h2v12h-2zm-8 0h2v2h-2zM9 5h2v2H9zM5 5h2v2H5z M3 3h2v2H3zm4 4h2v2H7zm6-2h2v2h-2zm2 2h2v2h-2zm2-2h2v2h-2zM5 15h14v2H5zm-2 4h18v2H3z",
  check: "M10 18H8v-2h2v2Zm-2-2H6v-2h2v2Zm4-2v2h-2v-2h2Zm-6 0H4v-2h2v2Zm8 0h-2v-2h2v2Zm2-2h-2v-2h2v2Zm2-2h-2V8h2v2Zm2-2h-2V6h2v2Z",
  coins: "M6 2h6v2H6zM4 4h2v2H4zm8 0h2v2h-2zm-8 8h2v2H4zm8 0h2v2h-2zm-6 2h6v2H6zM2 6h2v6H2zm12 0h2v6h-2zM14 8h4v2h-4zm-4 10h2v2h-2zm8-8h2v2h-2zm-6 10h2v2h-2zm6-2h2v2h-2zM12 20h6v2h-6zm-4-6h2v4H8zm12-2h2v6h-2zM7 6h4v2H7z",
  fire: "M9 2h2v4H9zM7 6h2v2H7zM5 8h2v2H5zm8 2h2v2h-2zm2-2h2v2h-2zm2 2h2v2h-2zm2 2h2v6h-2zM3 10h2v8H3zm8-4h2v4h-2zm6 12h2v2h-2zM7 20h10v2H7zm-2-2h2v2H5zm4-2h6v4H9zM11 14h2v3h-2z",
  chart: "M22 22H4v-2h18v2ZM4 20H2V2h2v18Zm4-6H6v-2h2v2Zm8 0h-2v-2h2v2Zm-6-2H8v-2h2v2Zm4 0h-2v-2h2v2Zm4 0h-2v-2h2v2Zm-6-2h-2V8h2v2Zm8 0h-2V8h2v2Zm2-2h-2V6h2v2Z",
};
// the Room Census logo, as in the favicon: four bars crossed by the census line
const LOGO = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230B0D10'/%3E%3Cpath d='M9 8v16M14 8v16M19 8v16M24 8v16M6 21l22-10' stroke='%232EC4A6' stroke-width='2.6' stroke-linecap='round'/%3E%3C/svg%3E";

function icon(ctx: CanvasRenderingContext2D, name: keyof typeof ICON, x: number, y: number, size: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.fillStyle = color;
  ctx.fill(new Path2D(ICON[name]));
  ctx.restore();
}

function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.lineWidth = 2; ctx.strokeStyle = stroke; ctx.stroke(); }
}

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, font: string, color: string, spacing = 0) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.letterSpacing = `${spacing}px`;
  ctx.fillText(s, x, y);
  const w = ctx.measureText(s).width;
  ctx.letterSpacing = "0px";
  return w;
}

const loadImage = (src: string) => new Promise<HTMLImageElement>((ok, fail) => {
  const img = new Image();
  img.onload = () => ok(img);
  img.onerror = fail;
  img.src = src;
});

const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v).toFixed(2)}`;
const n = (v: number) => v.toLocaleString("en-US");

export async function drawCard(card: Card): Promise<Blob> {
  await Promise.all([document.fonts.load(`400 20px ${PIXEL}`), document.fonts.load(`700 80px "${MONO}"`), document.fonts.load(`400 26px "${MONO}"`)]);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const up = card.score >= 0;
  const col = up ? C.up : C.down;
  const mono = (size: number, bold = false) => `${bold ? 700 : 400} ${size}px "${MONO}"`;
  ctx.textBaseline = "alphabetic";

  // background, faint pixel grid and a glow behind the chart
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff07";
  for (let x = 0; x < W; x += 40) ctx.fillRect(x, 0, 1, H);
  const glow = ctx.createRadialGradient(900, 350, 0, 900, 350, 300);
  glow.addColorStop(0, `${col}26`);
  glow.addColorStop(1, `${col}00`);
  ctx.fillStyle = glow;
  ctx.fillRect(600, 50, 600, 600);

  // the contest
  ctx.font = mono(20);
  ctx.letterSpacing = "1px";
  const cw = ctx.measureText(card.contest).width + 66;
  ctx.letterSpacing = "0px";
  box(ctx, 64, 56, cw, 42, 8, C.goldSoft, C.goldBorder);
  icon(ctx, "trophy", 80, 65, 24, C.gold);
  text(ctx, card.contest, 114, 84, mono(20), C.gold, 1);

  // who and the score
  const avatar = ctx.createLinearGradient(64, 208, 100, 244);
  avatar.addColorStop(0, C.up);
  avatar.addColorStop(1, "#3b6fd6");
  ctx.fillStyle = avatar;
  ctx.beginPath();
  ctx.arc(82, 226, 18, 0, Math.PI * 2);
  ctx.fill();
  text(ctx, `${card.did.slice(8, 14)}…${card.did.slice(-6)}`, 110, 236, mono(26), C.soft);
  text(ctx, card.mine === false ? "SCORE" : "MY SCORE", 64, 280, `400 20px ${PIXEL}`, C.muted, 2);
  const sw = text(ctx, signed(card.score), 62, 380, mono(80, true), col);
  text(ctx, "POLF", 62 + sw + 12, 378, mono(24), C.muted);

  // rank
  const rank = `#${n(card.rank)}`;
  const of = `of ${n(card.traders)} traders`;
  ctx.font = mono(31, true);
  const rw = ctx.measureText(rank).width;
  ctx.font = mono(20, true);
  const ow = ctx.measureText(of).width;
  box(ctx, 64, 416, 16 + 24 + 12 + rw + 12 + ow + 16, 60, 10, up ? "#0e2622" : "#2a1518");
  icon(ctx, "crown", 80, 434, 24, C.gold);
  text(ctx, rank, 116, 457, mono(31, true), C.text);
  text(ctx, of, 116 + rw + 12, 454, mono(20, true), C.muted);

  // NVDA over the contest, on the right
  const cx = 664, cy = 175, cwid = 472, ch = 230;
  box(ctx, cx, cy, cwid, ch, 14, C.surface, C.border);
  const p = card.prices;
  if (p.length > 1) {
    const lo = Math.min(...p), hi = Math.max(...p), span = hi - lo || 1;
    const px = (i: number) => cx + (i / (p.length - 1)) * cwid;
    const py = (v: number) => cy + 40 + (1 - (v - lo) / span) * (ch - 70);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(cx, cy, cwid, ch, 14);
    ctx.clip();
    const line = new Path2D();
    p.forEach((v, i) => (i ? line.lineTo(px(i), py(v)) : line.moveTo(px(i), py(v))));
    const area = new Path2D(line);
    area.lineTo(px(p.length - 1), cy + ch);
    area.lineTo(px(0), cy + ch);
    area.closePath();
    const fill = ctx.createLinearGradient(0, cy, 0, cy + ch);
    fill.addColorStop(0, `${col}40`);
    fill.addColorStop(1, `${col}00`);
    ctx.fillStyle = fill;
    ctx.fill(area);
    ctx.lineWidth = 4;
    ctx.strokeStyle = col;
    ctx.lineJoin = "round";
    ctx.stroke(line);
    ctx.restore();
  }

  // three facts under the chart, as in mockup CZ6BX: trades, best trade, open position
  const [side, qty] = (card.position ?? "").split(" ");
  const facts: [keyof typeof ICON, string, string, string, string][] = [
    ["coins", "Trades", card.trades !== undefined ? n(card.trades) : "-", C.text, C.up],
    ["fire", "Best", card.best !== undefined ? signed(card.best) : "-", C.text, C.gold],
    ["chart", side && qty ? side : "Position", qty ?? side ?? "-", C.text, side === "Short" ? C.down : C.up],
  ];
  const fw = (cwid - 24) / 3;
  facts.forEach(([ic, label, value, color, tint], i) => {
    const fx = cx + i * (fw + 12);
    box(ctx, fx, 421, fw, 90, 10, C.surface, C.border);
    icon(ctx, ic, fx + 14, 433, 24, tint);
    text(ctx, label, fx + 46, 450, `400 16px ${PIXEL}`, C.muted);
    ctx.font = mono(27, true);
    let v = value;
    while (ctx.measureText(v).width > fw - 28 && v.length > 4) v = `${v.slice(0, -2)}…`;
    text(ctx, v, fx + 14, 490, mono(27, true), color);
  });

  // where the number comes from
  icon(ctx, "check", 64, 585, 24, C.up);
  text(ctx, `${card.official ? "Signed by the referee" : "Our recount of signed trades"} · update ${card.sweep}`, 98, 604, mono(18), C.soft);
  ctx.font = mono(25);
  ctx.letterSpacing = "1px";
  const uw = ctx.measureText("roomcensus.xyz").width;
  ctx.letterSpacing = "0px";
  text(ctx, "roomcensus.xyz", W - 64 - uw, 606, mono(25), C.up, 1);

  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("no image"))), "image/png"));
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** "Share on X": puts the score card on the clipboard so the reader pastes it into the post (X lets no
 * site attach a picture itself), then opens a post on X with the text and the link filled in. The
 * card is copied first, while this page is still in front: a browser stops drawing in a tab that X
 * has pushed to the back. When the clipboard refuses, the card is downloaded instead. X opens right
 * after, still within the click's grace time; if the browser blocks it anyway, the reader gets a link.
 * Must be called inside the click. Returns the address of the post on X. */
export function shareOnX(card: Card, pageUrl: string, blob: Promise<Blob>, told: (how: "copied" | "downloaded" | "failed", opened: boolean) => void): string {
  const post = `${card.mine === false ? "Score" : "My score"} in ${card.contest.replace(" · ", " ")}: ${signed(card.score)} POLF, #${n(card.rank)} of ${n(card.traders)} traders${card.official ? ", signed by the referee" : " (Room Census recount)"}.`;
  const intent = `https://x.com/intent/post?text=${encodeURIComponent(post)}&url=${encodeURIComponent(pageUrl)}`;
  const name = `room-census-${card.did.slice(-8)}.png`;
  let done = false;
  const finish = (how: "copied" | "downloaded" | "failed") => {
    if (done) return;
    done = true;
    const w = window.open(intent, "_blank");
    if (w) w.opener = null;
    told(how, !!w);
  };
  const fallback = () => blob.then((b) => { download(b, name); finish("downloaded"); }, () => finish("failed"));
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(() => finish("copied"), fallback);
  } else {
    fallback();
  }
  // never keep the reader waiting on a slow clipboard: X opens anyway after a moment
  setTimeout(() => finish("failed"), 3000);
  return intent;
}
