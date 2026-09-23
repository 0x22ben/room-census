#!/usr/bin/env python3
"""
census_render.py: static outputs of a Room Census run, standard library only.

  card_png(view)              1200x630 PNG share card as bytes (bitmap font, flat colours, zlib + struct)
  write_card(path, view)      the same card written to a file
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


def claims(view):
    """The headline depends on what was actually measured. Baseline census: share of ROOMS (counts
    are valid from the first census). Later censuses: share of TRAFFIC between two censuses, from
    comparable interval rates only."""
    if view["baseline"]:
        return {
            "big": f"{view['room_pct']}%",
            "claim": "of measured active rooms on technocore.chat are mostly repetitive.",
            "lede": f"Baseline census | traffic shares start at census #{view['census'] + 1}",
            "card": ["OF MEASURED ACTIVE ROOMS", "ARE MOSTLY REPETITIVE"],
            "card_sub": f"{view['repetitive']} OF {view['active']} ROOMS  BASELINE CENSUS",
        }
    hours = f"{view['interval_hours']:.0f}" if view.get("interval_hours") else "?"
    return {
        "big": f"{view['repetitive_pct']}%",
        "claim": "of measured Technocore traffic came from repetitive rooms.",
        "lede": f"{hours}h interval | {view['interval_rooms']} rooms with measured traffic",
        "card": ["OF MEASURED TECHNOCORE TRAFFIC", "CAME FROM REPETITIVE ROOMS"],
        "card_sub": f"VARIED ROOMS CARRIED {view['varied_pct']}%  OVER {hours}H",
    }


def card_png(view) -> bytes:
    """Returns the 1200x630 share card as PNG bytes; the caller decides how to write it."""
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
    k = claims(view)
    end = c.text(64, 150, k["big"], 22, p["repetitive"])
    lines = k["card"]
    s = fit(lines, 5, W - 64 - (end + 36))
    c.text(end + 36, 186, lines[0], s, p["ink"])
    c.text(end + 36, 186 + 12 * s, lines[1], s, p["ink"])
    sub = k["card_sub"]
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
    return c.png()


def write_card(path, view):
    with open(path, "wb") as f:
        f.write(card_png(view))


def _bar(label, parts):
    total = sum(v for _, v in parts) or 1
    segs = "".join(
        f'<span class="seg {k}" style="width:{v / total * 100:.2f}%"></span>' for k, v in parts if v > 0)
    return (f'<div class="bar"><span class="bar-label">{html.escape(label)}</span>'
            f'<span class="bar-track" role="img" aria-label="{html.escape(label)}: '
            + ", ".join(f"{html.escape(k)} {v / total * 100:.0f}%" for k, v in parts) + f'">{segs}</span></div>')


def _grid(view):
    """One square per active room, coloured by class, in the same order as on the share card."""
    cells = "".join(f'<i class="{k}"></i>' * view[k] for k in ("varied", "mixed", "repetitive"))
    label = (f"{view['active']} active rooms: {view['varied']} varied, {view['mixed']} mixed, "
             f"{view['repetitive']} repetitive")
    return (f'<div class="roomgrid" role="img" aria-label="{html.escape(label)}">{cells}</div>'
            f'<p class="gridkey" aria-hidden="true"><span class="key varied">{view["varied"]} varied</span>'
            f'<span class="key mixed">{view["mixed"]} mixed</span>'
            f'<span class="key repetitive">{view["repetitive"]} repetitive</span></p>')


def provenance_block(view):
    """Who signs, which code ran, and how to check both. Censuses published before the deployment
    manifest existed simply say so, so old pages stay truthful."""
    e = lambda s: html.escape(str(s), quote=True)
    prov = view.get("provenance")
    lines = [f'<p><code class="mono">{e(view["publisher_short"])}</code></p>']
    if not prov:
        lines.append('<p class="note">Published before deployment manifests.</p>')
        return "\n".join(lines)
    # links come from the archive; only the two expected shapes are ever turned into an href
    manifest_href = prov["manifest"] if re.fullmatch(r"data/manifests/[0-9a-f]{64}\.json", str(prov["manifest"])) else "#"
    repo_href = prov["repository"] if re.fullmatch(r"https://github\.com/[\w.-]+/[\w.-]+", str(prov["repository"])) else "#"
    prov = {**prov, "manifest": manifest_href, "repository": repo_href}
    name = str(view["provenance"]["manifest"]).split("/")[-1]
    lines += [
        f'<dl class="kpis"><div><dt>Source commit</dt><dd><code class="mono">{e(prov["commit"])}</code></dd></div>'
        f'<div><dt>Manifest</dt><dd><a href="{e(prov["manifest"])}"><code class="mono">{e(name)}</code></a></dd></div>'
        '</dl>',
        f'<p class="note"><a href="identity.json">identity.json</a> &middot; '
        f'<a href="{e(prov["repository"])}" rel="noopener">source</a> &middot; '
        '<a href="llms.txt">verification steps</a></p>',
    ]
    return "\n".join(lines)


def render_page(page, view, base_url):
    e = lambda s: html.escape(str(s), quote=True)
    k = claims(view)
    headline = f"{k['big']} {k['claim']}"
    share_text = f"{headline} Room Census #{view['census']}, signed and verifiable:"
    intent = "https://x.com/intent/tweet?" + urllib.parse.urlencode({"text": share_text, "url": base_url + "/", "via": "0X22crypto"})
    card = f"{base_url}/data/card.png?v={view['census']}"
    blocks = {
        "head": "\n".join([
            f'<meta name="description" content="{e(headline)} A signed, daily census of public rooms.">',
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
            '<div class="hero-top">',
            '<div class="hero-copy">',
            f'<p class="stamp">Census #{view["census"]} &middot; {e(view["date_long"])} &middot; '
            f'{view["measured"]} rooms measured, {view["failed"]} failed'
            + (' &middot; <strong>partial</strong>' if view["partial"] else '')
            + ' &middot; <a href="#verify">signed and verifiable</a></p>',
            f'<h1 id="headline"><span class="big">{e(k["big"])}</span> <span class="claim">{e(k["claim"])}</span></h1>',
            f'<p class="lede">{e(k["lede"])}</p>',
            '<p class="actions"><a class="btn primary" href="#rooms">Explore rooms</a>'
            '<a class="btn" href="#trust">Verify</a>'
            f'<a class="btn" href="{e(intent)}" target="_blank" rel="noopener">Share</a></p>',
            '</div>',
            '<aside class="signal-card" aria-labelledby="composition-title">',
            '<p class="eyebrow" id="composition-title">Network composition</p>',
            _grid(view),
            '' if view["baseline"] else _bar("Share of traffic", [("varied", view["varied_pct_raw"]),
                                             ("mixed", view["mixed_pct_raw"]), ("repetitive", view["repetitive_pct_raw"])]),
            '<p class="signal-note">Traffic pattern, not intent or attribution.</p>',
            '</aside>',
            '</div>',
            '<dl class="kpis">',
            f'<div><dt>Active rooms</dt><dd>{view["active"]}</dd></div>',
            f'<div><dt>Varied rooms</dt><dd>{view["varied"]}</dd></div>',
            f'<div><dt>Varied traffic</dt><dd>{"n/a" if view["baseline"] else str(round(view["varied_pct_raw"] * 100)) + "%"}</dd></div>',
            f'<div><dt>New public rooms</dt><dd>~{e(view["new_rooms"])}/h</dd></div>',
            '</dl>',
        ]),
        "verify": "\n".join([
            f'<p><strong>Valid signature</strong> &middot; <code class="mono">{e(view["publisher_short"])}</code> '
            f'&middot; <a href="https://technocore.chat/r/room-census">room-census</a></p>',
            f'<p class="hash"><a href="{e(view["snapshot"])}">{e(view["snapshot"].split("/")[-1])}</a> '
            f'<code class="mono" id="sha">{e(view["sha256"])}</code> '
            '<button type="button" class="copy" data-copy="sha">Copy</button></p>',
            '<p class="note"><a href="llms.txt">Verification steps</a></p>',
        ]),
        "provenance": provenance_block(view),
    }
    for name, content in blocks.items():
        pattern = re.compile(rf"(<!--census:{name}-->)(.*?)(<!--/census:{name}-->)", re.S)
        if not pattern.search(page):
            raise ValueError(f"marker census:{name} missing in index.html")
        page = pattern.sub(lambda m: m.group(1) + "\n" + content + "\n" + m.group(3), page)
    return page
