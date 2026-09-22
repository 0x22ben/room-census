#!/usr/bin/env python3
"""
census_render.py: static outputs of a Room Census run, standard library only.

  write_card(path, view)      1200x630 PNG share card (bitmap font, flat colours, zlib + struct)
  render_page(html, view)     writes the hero, the verify block and the share tags into index.html,
                              between <!--census:NAME--> and <!--/census:NAME--> markers

`view` is a plain dict built by room_census.public_view(). Room names never reach these outputs:
only numbers, dates and our own URLs do, and every value is HTML-escaped anyway.
"""
import html
import re
import struct
import urllib.parse
import zlib
from datetime import datetime

W, H = 1200, 630
DARK = {"bg": "0B0D10", "ink": "E8EAED", "ink2": "8B93A1", "varied": "2EC4A6", "mixed": "9AA3B5",
        "repetitive": "E39B4B", "quiet": "3A404B"}

# 5x7 bitmap font: one string of 7 rows of 5 bits per glyph
FONT = {
    "A": "01110 10001 10001 11111 10001 10001 10001", "B": "11110 10001 10001 11110 10001 10001 11110",
    "C": "01110 10001 10000 10000 10000 10001 01110", "D": "11110 10001 10001 10001 10001 10001 11110",
    "E": "11111 10000 10000 11110 10000 10000 11111", "F": "11111 10000 10000 11110 10000 10000 10000",
    "G": "01110 10001 10000 10111 10001 10001 01111", "H": "10001 10001 10001 11111 10001 10001 10001",
    "I": "01110 00100 00100 00100 00100 00100 01110", "J": "00111 00010 00010 00010 00010 10010 01100",
    "K": "10001 10010 10100 11000 10100 10010 10001", "L": "10000 10000 10000 10000 10000 10000 11111",
    "M": "10001 11011 10101 10101 10001 10001 10001", "N": "10001 10001 11001 10101 10011 10001 10001",
    "O": "01110 10001 10001 10001 10001 10001 01110", "P": "11110 10001 10001 11110 10000 10000 10000",
    "Q": "01110 10001 10001 10001 10101 10010 01101", "R": "11110 10001 10001 11110 10100 10010 10001",
    "S": "01111 10000 10000 01110 00001 00001 11110", "T": "11111 00100 00100 00100 00100 00100 00100",
    "U": "10001 10001 10001 10001 10001 10001 01110", "V": "10001 10001 10001 10001 10001 01010 00100",
    "W": "10001 10001 10001 10101 10101 10101 01010", "X": "10001 10001 01010 00100 01010 10001 10001",
    "Y": "10001 10001 01010 00100 00100 00100 00100", "Z": "11111 00001 00010 00100 01000 10000 11111",
    "0": "01110 10001 10011 10101 11001 10001 01110", "1": "00100 01100 00100 00100 00100 00100 01110",
    "2": "01110 10001 00001 00010 00100 01000 11111", "3": "11111 00010 00100 00010 00001 10001 01110",
    "4": "00010 00110 01010 10010 11111 00010 00010", "5": "11111 10000 11110 00001 00001 10001 01110",
    "6": "00110 01000 10000 11110 10001 10001 01110", "7": "11111 00001 00010 00100 01000 01000 01000",
    "8": "01110 10001 10001 01110 10001 10001 01110", "9": "01110 10001 10001 01111 00001 00010 01100",
    " ": "00000 00000 00000 00000 00000 00000 00000", "%": "11000 11001 00010 00100 01000 10011 00011",
    ".": "00000 00000 00000 00000 00000 01100 01100", ":": "00000 01100 01100 00000 01100 01100 00000",
    "/": "00000 00001 00010 00100 01000 10000 00000", "-": "00000 00000 00000 11111 00000 00000 00000",
    "#": "01010 01010 11111 01010 11111 01010 01010", "~": "00000 00000 01000 10101 00010 00000 00000",
}


class Canvas:
    def __init__(self, bg):
        self.px = bytearray(bytes.fromhex(bg) * (W * H))

    def rect(self, x, y, w, h, color):
        x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + w), min(H, y + h)
        if x1 <= x0 or y1 <= y0:
            return
        line = bytes.fromhex(color) * (x1 - x0)
        for yy in range(y0, y1):
            i = (yy * W + x0) * 3
            self.px[i:i + len(line)] = line

    def text(self, x, y, s, scale, color):
        for ch in s.upper():
            rows = FONT.get(ch, FONT[" "]).split()
            for r, bits in enumerate(rows):
                for c, bit in enumerate(bits):
                    if bit == "1":
                        self.rect(x + c * scale, y + r * scale, scale, scale, color)
            x += 6 * scale
        return x

    def png(self) -> bytes:
        raw = b"".join(b"\x00" + bytes(self.px[y * W * 3:(y + 1) * W * 3]) for y in range(H))
        chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
        return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def text_width(s, scale):
    return len(s) * 6 * scale - scale


def fit(lines, scale, width):
    """Largest scale <= `scale` at which every line fits in `width` pixels."""
    while scale > 1 and max(text_width(s, scale) for s in lines) > width:
        scale -= 1
    return scale


def write_card(path, view):
    c, p = Canvas(DARK["bg"]), DARK
    # tally mark icon and wordmark
    for i in range(4):
        c.rect(64 + i * 11, 58, 5, 36, p["varied"])
    for i in range(8):
        c.rect(58 + i * 7, 86 - i * 3, 8, 5, p["varied"])
    c.text(124, 62, "ROOM CENSUS", 4, p["ink"])
    right = f"TECHNOCORE.CHAT  {view['date_short'].upper()}"
    c.text(W - 64 - text_width(right, 3), 68, right, 3, p["ink2"])
    # hero number and statement
    big = f"{view['repetitive_pct']}%"
    end = c.text(64, 150, big, 22, p["repetitive"])
    lines = ["OF MEASURED AGENT TRAFFIC", "COMES FROM REPETITIVE ROOMS"]
    s = fit(lines, 5, W - 64 - (end + 36))
    c.text(end + 36, 186, lines[0], s, p["ink"])
    c.text(end + 36, 186 + 12 * s, lines[1], s, p["ink"])
    sub = f"VARIED ROOMS CARRY {view['varied_pct']}%"
    c.text(end + 36, 196 + 24 * s, sub, max(3, fit([sub], s - 1, W - 64 - (end + 36))), p["ink2"])
    # one square per active room, coloured by class
    cells = ["varied"] * view["varied"] + ["mixed"] * view["mixed"] + ["repetitive"] * view["repetitive"]
    per_row = 28 if len(cells) <= 56 else 36
    size = (W - 128 - (per_row - 1) * 8) // per_row
    for i, cls in enumerate(cells):
        r, k = divmod(i, per_row)
        c.rect(64 + k * (size + 8), 392 + r * (size + 8), size, size, p[cls])
    rows = (len(cells) + per_row - 1) // per_row
    y = 392 + rows * (size + 8) + 14
    x = 64
    for cls, n in (("varied", view["varied"]), ("mixed", view["mixed"]), ("repetitive", view["repetitive"])):
        c.rect(x, y + 2, 16, 16, p[cls])
        x = c.text(x + 26, y, f"{n} {cls.upper()}", 3, p["ink"]) + 28
    left = f"CENSUS #{view['census']}  SHA256 {view['sha_short'].upper()}"
    right = "0X22BEN.GITHUB.IO/ROOM-CENSUS"
    c.text(64, H - 56, left, 3, p["ink2"])
    c.text(W - 64 - text_width(right, 3), H - 56, right, 3, p["ink"])
    with open(path, "wb") as f:
        f.write(c.png())


def _bar(label, parts):
    total = sum(v for _, v in parts) or 1
    segs = "".join(
        f'<span class="seg {k}" style="width:{v / total * 100:.2f}%"></span>' for k, v in parts if v > 0)
    return (f'<div class="bar"><span class="bar-label">{html.escape(label)}</span>'
            f'<span class="bar-track" role="img" aria-label="{html.escape(label)}: '
            + ", ".join(f"{html.escape(k)} {v:g}" for k, v in parts) + f'">{segs}</span></div>')


def _grid(view):
    """One square per active room, coloured by class, in the same order as on the share card."""
    cells = "".join(f'<i class="{k}"></i>' * view[k] for k in ("varied", "mixed", "repetitive"))
    label = (f"{view['active']} active rooms: {view['varied']} varied, {view['mixed']} mixed, "
             f"{view['repetitive']} repetitive")
    return (f'<div class="roomgrid" role="img" aria-label="{html.escape(label)}">{cells}</div>'
            f'<p class="gridkey" aria-hidden="true"><span class="key varied">{view["varied"]} varied</span>'
            f'<span class="key mixed">{view["mixed"]} mixed</span>'
            f'<span class="key repetitive">{view["repetitive"]} repetitive</span></p>')


def render_page(page, view, base_url):
    e = lambda s: html.escape(str(s), quote=True)
    headline = f"{view['repetitive_pct']}% of measured agent traffic on technocore.chat comes from repetitive rooms."
    share_text = f"{headline} Room Census #{view['census']}, signed and verifiable:"
    intent = "https://x.com/intent/tweet?" + urllib.parse.urlencode({"text": share_text, "url": base_url + "/"})
    card = f"{base_url}/data/card.png?v={view['census']}"
    blocks = {
        "head": "\n".join([
            f'<meta name="description" content="{e(headline)} A signed, twice-weekly census of public rooms.">',
            f'<meta property="og:type" content="website">',
            f'<meta property="og:url" content="{e(base_url)}/">',
            f'<meta property="og:title" content="Room Census: which rooms talk, which rooms loop">',
            f'<meta property="og:description" content="{e(headline)}">',
            f'<meta property="og:image" content="{e(card)}">',
            f'<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">',
            f'<meta name="twitter:card" content="summary_large_image">',
            f'<meta name="twitter:image" content="{e(card)}">',
            f'<meta name="twitter:image:alt" content="{e(headline)} {view["varied"]} varied, {view["mixed"]} mixed, '
            f'{view["repetitive"]} repetitive rooms out of {view["active"]}.">',
        ]),
        "hero": "\n".join([
            f'<p class="stamp">Census #{view["census"]} &middot; {e(view["date_long"])} &middot; '
            f'<a href="#verify">signed and verifiable</a></p>',
            f'<h1 id="headline"><span class="big">{view["repetitive_pct"]}%</span> <span class="claim">of measured agent '
            f'traffic on technocore.chat comes from repetitive rooms.</span></h1>',
            f'<p class="lede">Varied rooms carry {view["varied_pct"]}%. Which rooms talk, which rooms loop.</p>',
            _grid(view),
            _bar("Share of messages", [("varied", view["varied_pct_raw"]), ("mixed", view["mixed_pct_raw"]),
                              ("repetitive", view["repetitive_pct_raw"])]),
            '<dl class="kpis">',
            f'<div><dt>Active rooms</dt><dd>{view["active"]}</dd></div>',
            f'<div><dt>Varied rooms</dt><dd>{view["varied"]}</dd></div>',
            f'<div><dt>New public rooms</dt><dd>~{e(view["new_rooms"])}/h</dd></div>',
            '</dl>',
            '<p class="actions"><a class="btn primary" href="#rooms">See the rooms</a>'
            '<a class="btn" href="#verify">Verify this census</a>'
            f'<a class="btn" href="{e(intent)}" target="_blank" rel="noopener">Share on X</a></p>',
        ]),
        "verify": "\n".join([
            f'<p>Census #{view["census"]} was signed by <code class="mono">{e(view["publisher_short"])}</code> '
            f'in <a href="https://technocore.chat/r/room-census">room-census</a>. Its signed message contains the '
            f'SHA-256 of this snapshot:</p>',
            f'<p class="hash"><a href="{e(view["snapshot"])}">{e(view["snapshot"].split("/")[-1])}</a> '
            f'<code class="mono" id="sha">{e(view["sha256"])}</code> '
            '<button type="button" class="copy" data-copy="sha">Copy</button></p>',
            '<p class="note">Download the snapshot, hash it, and compare. The full procedure is in '
            '<a href="llms.txt">llms.txt</a>.</p>',
        ]),
    }
    for name, content in blocks.items():
        pattern = re.compile(rf"(<!--census:{name}-->)(.*?)(<!--/census:{name}-->)", re.S)
        if not pattern.search(page):
            raise ValueError(f"marker census:{name} missing in index.html")
        page = pattern.sub(lambda m: m.group(1) + "\n" + content + "\n" + m.group(3), page)
    return page
