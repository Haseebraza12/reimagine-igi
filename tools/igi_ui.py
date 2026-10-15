#!/usr/bin/env python3
"""Project I.G.I. (2000) interface assets: sprites (.spr), pictures (.pic) and
bitmap fonts (.fnt).  Stdlib only; run from the repository root.

    python3 tools/igi_ui.py                  # self-check every UI asset, print a summary
    python3 tools/igi_ui.py --png-dir DIR    # also write PNG previews (never into the repo),
                                             # incl. preview_hud_640x480.png (mock HUD frame built
                                             # with the recovered layout) and a loading screen
    python3 tools/igi_ui.py --game DIR       # installation root (default: "Game Files")

Evidence labels follow docs/hud.md: observed = measured on the files,
recovered = read from igi.exe (function addresses given), inferred = neither.

Loader (recovered, igi.exe FUN_004ac9f0 "Invalid sprite file: %s"): one function
loads every 2D image; it dispatches on the LOOP version word at +4.

LOOP v9  sprite / picture (.spr, .pic)        [all 109 files in the UI archives parse]
    +0x10 u32 0x00050000 (s16 at +0x12 = 5 is passed to the texture creator)
    +0x18 u32 palette offset (0 in every file; non-zero = palette chunk)
    +0x1c u32 tile-map footer offset (LOOP v6, see below)
    +0x20 u32 frame count         +0x28 u32 width   +0x2c u32 height
    +0x30 u32 pixel format of the whole sprite (2 or 3)
    +0x34 frame records, 32 bytes each:
        +0 u32 pixel offset (from file start)   +4 u32 pixel format
        +8 u16 row bytes   +0xa u16 width   +0xc u16 height
        +0xe s16 advance (x step when the sprite is drawn as a tile row)
        +0x16 s16 x offset  +0x18 s16 y offset (added to the draw position)
        +0x1c u32 per-frame flags
    Draw flags: a sprite with exactly one frame gets flag 0x10000 (fixed-width
    tile rows), otherwise rows advance by each frame's own advance.
LOOP v6  tile-map footer (FUN_004ad820): +8 u32 width px, +0xc u32 height px
    (0xCCCCCCCC = unset in single sprites), +0x10 u32 columns, +0x14 u32 rows,
    then columns*rows 16-byte cells {i32 0, i32 x, i32 y, i32 frame+1}; the game
    reads only the frame byte at +12 of each cell.  A .pic is drawn as this
    grid: cell (c, r) shows frame[cell-1] at (x + c*64, y + r*32) for 64x32 tiles.
LOOP v10 font (.fnt):
    +0x0c u32 palette offset (0)    +0x10 u32 glyph count
    +0x14 u32 pixel base offset     +0x18 u16 proportional (non-zero in all fonts)
    +0x1a u16 space advance (used for characters without a glyph)
    +0x1c u16 (not read by the loader)  +0x1e u16 line height  +0x20 u16 cell width
    +0x22 u16 pixel format          +0x24 u8[256] character -> glyph (1-based, 0 = none)
    +0x124 + g*20 for g = 1..count: u32 pixel offset (from the base), u32 format,
        s16 row bytes, s16 width, s16 height, s16 x offset, s16 y offset,
        s16 advance.
LOOP v7  sprite (computer.res arrows/plus/sphere only): +0x18 palette, +0x1c tile
    map, +0x20 count, +0x28 w, +0x2c h, +0x30 format; 40-byte frames at +0x34:
    +0 offset, +4 row bytes, +8 w, +0xc h, +0x10 advance, +0x20 x, +0x24 y.
Pixel formats (observed: decoded previews are correct images; the same codes as
    LOOP v11 .tex): 2 = A1R5G5B5 (bit 15 = opaque), 3 = A8R8G8B8 stored B,G,R,A.

Text drawing (recovered, FUN_004adb90 / FUN_004ad990): the pen starts at the
    given x (or x - width/2 with flag 0x80, x - width with 0x100); each glyph's
    quad is placed at (pen + xoff, y + yoff) with its own size; the pen advances
    by the glyph advance, or by the space advance for unmapped characters; the
    line width excludes trailing unmapped characters; lines step by the line height.
    Sprites and glyphs are drawn at 1:1 pixel size at every resolution.
"""
import argparse
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from igi_formats import FormatError, resource_members  # noqa: E402


def _u16(d, o):
    if o < 0 or o + 2 > len(d):
        raise FormatError(f"u16 outside file at {o:#x}")
    return struct.unpack_from("<H", d, o)[0]


def _s16(d, o):
    if o < 0 or o + 2 > len(d):
        raise FormatError(f"s16 outside file at {o:#x}")
    return struct.unpack_from("<h", d, o)[0]


def _u32(d, o):
    if o < 0 or o + 4 > len(d):
        raise FormatError(f"u32 outside file at {o:#x}")
    return struct.unpack_from("<I", d, o)[0]


def decode_pixels(d, offset, fmt, row_bytes, width, height, where):
    """Return RGBA bytes (rows top-down) for format 2 (A1R5G5B5) or 3 (BGRA8888)."""
    bpp = {2: 2, 3: 4}.get(fmt)
    if bpp is None:
        raise FormatError(f"{where}: unsupported pixel format {fmt}")
    if width < 1 or height < 1 or row_bytes < width * bpp:
        raise FormatError(f"{where}: bad frame size {width}x{height} rows {row_bytes}")
    end = offset + row_bytes * (height - 1) + width * bpp
    if offset < 0 or end > len(d):
        raise FormatError(f"{where}: pixels outside file at {offset:#x}")
    out = bytearray(width * height * 4)
    o = 0
    for y in range(height):
        row = offset + y * row_bytes
        if bpp == 2:
            for x in range(width):
                v = d[row + 2 * x] | (d[row + 2 * x + 1] << 8)
                r, g, b = (v >> 10) & 31, (v >> 5) & 31, v & 31
                out[o] = (r << 3) | (r >> 2)
                out[o + 1] = (g << 3) | (g >> 2)
                out[o + 2] = (b << 3) | (b >> 2)
                out[o + 3] = 255 if v & 0x8000 else 0
                o += 4
        else:
            for x in range(width):
                p = row + 4 * x
                out[o] = d[p + 2]
                out[o + 1] = d[p + 1]
                out[o + 2] = d[p]
                out[o + 3] = d[p + 3]
                o += 4
    return bytes(out)


def _tile_map(d, offset, where):
    if offset + 0x24 > len(d) or d[offset:offset + 4] != b"LOOP" or _u32(d, offset + 4) != 6:
        raise FormatError(f"{where}: tile map footer missing at {offset:#x}")
    cols, rows = _u32(d, offset + 0x10), _u32(d, offset + 0x14)
    if cols < 1 or rows < 1 or cols * rows > 4096:
        raise FormatError(f"{where}: bad tile map {cols}x{rows} at {offset:#x}")
    end = offset + 0x18 + cols * rows * 16
    if end != len(d):
        raise FormatError(f"{where}: tile map does not end at EOF ({end:#x} vs {len(d):#x})")
    cells = [d[offset + 0x24 + 16 * i] for i in range(cols * rows)]
    return {"width": _u32(d, offset + 8), "height": _u32(d, offset + 0xc),
            "columns": cols, "rows": rows, "cells": cells}


def read_sprite(d, name="sprite"):
    """Decode a LOOP v9 (or v7) sprite/picture into frames of RGBA pixels."""
    if len(d) < 0x34 or d[:4] != b"LOOP":
        raise FormatError(f"{name}: not a LOOP file")
    version = _u32(d, 4)
    if version not in (7, 9):
        raise FormatError(f"{name}: LOOP v{version} is not a sprite")
    if _u32(d, 0x18) != 0:
        raise FormatError(f"{name}: palette at {_u32(d, 0x18):#x} not supported")
    count, width, height, fmt = _u32(d, 0x20), _u32(d, 0x28), _u32(d, 0x2c), _u32(d, 0x30)
    stride = 32 if version == 9 else 40
    if count < 1 or 0x34 + count * stride > len(d):
        raise FormatError(f"{name}: bad frame count {count} at 0x20")
    frames = []
    for i in range(count):
        r = 0x34 + i * stride
        if version == 9:
            off, ffmt = _u32(d, r), _u32(d, r + 4)
            rb, w, h = _u16(d, r + 8), _u16(d, r + 0xa), _u16(d, r + 0xc)
            adv, x, y, flags = _s16(d, r + 0xe), _s16(d, r + 0x16), _s16(d, r + 0x18), _u32(d, r + 0x1c)
        else:
            off, rb, w, h = _u32(d, r), _u32(d, r + 4), _u32(d, r + 8), _u32(d, r + 0xc)
            adv, x, y, flags, ffmt = _u32(d, r + 0x10), _u32(d, r + 0x20), _u32(d, r + 0x24), 0, fmt
        rgba = decode_pixels(d, off, ffmt, rb, w, h, f"{name} frame {i} (record {r:#x})")
        frames.append({"width": w, "height": h, "x": x, "y": y, "advance": adv,
                       "format": ffmt, "flags": flags, "rgba": rgba})
    tiles = None
    footer = _u32(d, 0x1c)
    if footer:
        tiles = _tile_map(d, footer, name)
    return {"version": version, "width": width, "height": height, "format": fmt,
            "frames": frames, "tiles": tiles}


def compose_picture(sprite):
    """Assemble a tiled .pic (or any sprite with a tile map) into one RGBA image."""
    t = sprite["tiles"]
    tw, th = sprite["width"], sprite["height"]
    W, H = t["columns"] * tw, t["rows"] * th
    out = bytearray(W * H * 4)
    for i, cell in enumerate(t["cells"]):
        if cell == 0:
            continue
        if cell > len(sprite["frames"]):
            raise FormatError(f"tile cell {i} names missing frame {cell}")
        f = sprite["frames"][cell - 1]
        cx, cy = (i % t["columns"]) * tw + f["x"], (i // t["columns"]) * th + f["y"]
        for y in range(f["height"]):
            src = y * f["width"] * 4
            dst = ((cy + y) * W + cx) * 4
            out[dst:dst + f["width"] * 4] = f["rgba"][src:src + f["width"] * 4]
    # The footer's own size (e.g. 640x480 or 295x107) crops the padded tile grid.
    cw = t["width"] if 0 < t["width"] <= W else W
    ch = t["height"] if 0 < t["height"] <= H else H
    if (cw, ch) != (W, H):
        cropped = bytearray(cw * ch * 4)
        for y in range(ch):
            cropped[y * cw * 4:(y + 1) * cw * 4] = out[y * W * 4:y * W * 4 + cw * 4]
        return cw, ch, bytes(cropped)
    return W, H, bytes(out)


def read_font(d, name="font"):
    """Decode a LOOP v10 bitmap font."""
    if len(d) < 0x124 or d[:4] != b"LOOP" or _u32(d, 4) != 10:
        raise FormatError(f"{name}: not a LOOP v10 font")
    if _u32(d, 0xc) != 0:
        raise FormatError(f"{name}: palette at {_u32(d, 0xc):#x} not supported")
    count, base = _u32(d, 0x10), _u32(d, 0x14)
    if count < 1 or count > 255 or 0x124 + (count + 1) * 20 > base or base > len(d):
        raise FormatError(f"{name}: bad glyph count {count} / base {base:#x} at 0x10")
    font = {"proportional": _u16(d, 0x18) != 0, "space_advance": _u16(d, 0x1a),
            "unknown_1c": _u16(d, 0x1c), "line_height": _u16(d, 0x1e),
            "cell_width": _u16(d, 0x20), "format": _u16(d, 0x22),
            "char_map": list(d[0x24:0x124]), "glyphs": []}
    for c, g in enumerate(font["char_map"]):
        if g > count:
            raise FormatError(f"{name}: char {c} maps to glyph {g} > {count} at {0x24 + c:#x}")
    end = base
    for g in range(1, count + 1):
        r = 0x124 + g * 20
        off, fmt = _u32(d, r), _u32(d, r + 4)
        rb, w, h, xo, yo, adv = (_s16(d, r + 8 + 2 * k) for k in range(6))
        rgba = decode_pixels(d, base + off, fmt, rb, w, h, f"{name} glyph {g} (record {r:#x})")
        end = max(end, base + off + rb * h)
        font["glyphs"].append({"width": w, "height": h, "x": xo, "y": yo, "advance": adv,
                               "format": fmt, "rgba": rgba})
    font["pixel_end"] = end
    font["trailing_bytes"] = len(d) - end
    return font


def text_width(font, text):
    """Line width exactly as FUN_004ad990 computes it (proportional fonts)."""
    pen = last = 0
    for ch in text.encode("latin1"):
        g = font["char_map"][ch]
        if g == 0:
            pen += font["space_advance"]
        else:
            pen += font["glyphs"][g - 1]["advance"]
            last = pen
    return last


def render_text(font, text, color=(255, 255, 255)):
    """Rasterise a line of text (RGBA), as FUN_004adb90 lays it out from x = 0."""
    W = max(1, text_width(font, text) + 8)
    H = font["line_height"] + 8
    out = bytearray(W * H * 4)
    pen = 0
    for ch in text.encode("latin1"):
        g = font["char_map"][ch]
        if g == 0:
            pen += font["space_advance"]
            continue
        gl = font["glyphs"][g - 1]
        for y in range(gl["height"]):
            for x in range(gl["width"]):
                px, py = pen + gl["x"] + x, gl["y"] + y
                if not (0 <= px < W and 0 <= py < H):
                    continue
                s = (y * gl["width"] + x) * 4
                a = gl["rgba"][s + 3]
                if a == 0:
                    continue
                o = (py * W + px) * 4
                for k in range(3):
                    out[o + k] = gl["rgba"][s + k] * color[k] // 255
                out[o + 3] = a
        pen += gl["advance"]
    return W, H, bytes(out)


def font_atlas(font, columns=16):
    """Pack all glyphs into one RGBA sheet (cell = max glyph box + 1)."""
    cw = max(g["width"] for g in font["glyphs"]) + 1
    ch = max(g["height"] for g in font["glyphs"]) + 1
    rows = (len(font["glyphs"]) + columns - 1) // columns
    W, H = columns * cw, rows * ch
    out = bytearray(W * H * 4)
    for i, g in enumerate(font["glyphs"]):
        ox, oy = (i % columns) * cw, (i // columns) * ch
        for y in range(g["height"]):
            o = ((oy + y) * W + ox) * 4
            out[o:o + g["width"] * 4] = g["rgba"][y * g["width"] * 4:(y + 1) * g["width"] * 4]
    return W, H, bytes(out)


def write_png(path, width, height, rgba, background=None):
    """Minimal RGBA PNG writer; optional background colour flattens alpha."""
    if background is not None:
        flat = bytearray(rgba)
        for i in range(0, len(flat), 4):
            a = flat[i + 3]
            for k in range(3):
                flat[i + k] = (flat[i + k] * a + background[k] * (255 - a)) // 255
            flat[i + 3] = 255
        rgba = bytes(flat)
    raw = b"".join(b"\0" + rgba[y * width * 4:(y + 1) * width * 4] for y in range(height))

    def chunk(tag, body):
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body))

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


# Every UI archive the game opens (strings in igi.exe; see docs/hud.md).
UI_ARCHIVES = [
    "screens/game/status/status.res",
    "common/sprites/sprites.res",
    "computer/computer.res",
    "menusystem/menusystem.res",
    "menusystem/ingamemenu.res",
    "menusystem/loadingscreen.res",
    "menusystem/missionsprites.res",
]
LOOSE_FONTS = ["screens/intro/font3.fnt", "screens/intro/font4.fnt"]
STRING_ARCHIVES = [
    "menusystem/english.res",
    "language/english/menusystem.res",
    "language/english/messages.res",
    "language/english/objectives.res",
    "language/english/missions.res",
    "language/english/movies.res",
    "language/english/computer.res",
]


def avi_info(d):
    """FourCCs and stream formats of a RIFF AVI (headers only, no decoding)."""
    if d[:4] != b"RIFF" or d[8:12] != b"AVI ":
        raise FormatError("not a RIFF AVI")
    info = {"streams": []}
    pos, end = 12, min(len(d), 8 + _u32(d, 4))
    stack = [(pos, end)]
    while stack:
        pos, end = stack.pop()
        while pos + 8 <= end:
            tag = d[pos:pos + 4]
            size = _u32(d, pos + 4)
            if tag == b"LIST":
                kind = d[pos + 8:pos + 12]
                if kind in (b"hdrl", b"strl"):
                    stack.append((pos + 12, pos + 8 + size))
            elif tag == b"avih":
                info["usec_per_frame"], _, _, _, info["frames"] = struct.unpack_from("<5I", d, pos + 8)
                info["width"], info["height"] = struct.unpack_from("<2I", d, pos + 8 + 32)
            elif tag == b"strh":
                info["streams"].append({"type": d[pos + 8:pos + 12].decode("latin1"),
                                        "handler": d[pos + 12:pos + 16].decode("latin1"),
                                        "rate": _u32(d, pos + 8 + 24), "scale": _u32(d, pos + 8 + 20)})
            elif tag == b"strf" and info["streams"]:
                s = info["streams"][-1]
                if s["type"] == "vids":
                    s["compression"] = d[pos + 8 + 16:pos + 8 + 20].decode("latin1")
                    s["bits"] = _u16(d, pos + 8 + 14)
                elif s["type"] == "auds":
                    s["wFormatTag"], s["channels"], s["samples_per_sec"] = struct.unpack_from("<HHI", d, pos + 8)
                    s["bits"] = _u16(d, pos + 8 + 14)
            pos += 8 + size + (size & 1)
    return info


def wav_info(d):
    """Intro soundtracks are ILSF (not RIFF): u16 format, bits, channels, flags,
    u32 rate, u32 frames.  Format 2 (both intro tracks) is compressed."""
    if d[:4] == b"ILSF" and len(d) >= 20:
        fmt, bits, ch, flags = struct.unpack_from("<4H", d, 4)
        rate, frames = struct.unpack_from("<2I", d, 12)
        return {"container": "ILSF", "format": fmt, "bits": bits, "channels": ch,
                "rate": rate, "frames": frames, "seconds": round(frames / rate, 2),
                "bytes_per_frame": round((len(d) - 20) / frames, 3)}
    if d[:4] != b"RIFF" or d[8:12] != b"WAVE":
        raise FormatError("not ILSF or RIFF WAVE")
    pos = 12
    while pos + 8 <= len(d):
        tag, size = d[pos:pos + 4], _u32(d, pos + 4)
        if tag == b"fmt ":
            tagf, ch, rate = struct.unpack_from("<HHI", d, pos + 8)
            return {"format_tag": tagf, "channels": ch, "rate": rate, "bits": _u16(d, pos + 8 + 14)}
        pos += 8 + size + (size & 1)
    raise FormatError("WAVE without fmt chunk")


# --- Recovered layout (docs/hud.md; fractions read from igi.exe .rdata) ------

HEALTH_CENTRE = (0.0625, 0.8958333134651184)        # FUN_0045f070 (0x5315cc, 0x531924)
WEAPON_RIGHT = (0.984375, 0.8958333134651184)        # FUN_00478440 (0x53213c, 0x531924)
ACTION_ICON = (0.5, 0.875)                           # FUN_00485130 (0x531508, 0x532210)
MESSAGE_ORIGIN = (0.015625, 0.02083333395421505)     # FUN_00483f90 (0x5320d8, 0x5320dc)
CUTSCENE_ORIGIN = (0.015625, 0.8645833134651184)     # FUN_00483f90 (0x5321f8)
LOADING_BAR = (40, 440, 560, 10)                     # FUN_00488860


def colour_byte(c):
    """Vertex colour argument (0..255, 128 = neutral) -> byte, as FUN_00504300:
    trunc(v * 255) (fistp 0x504501..0x50458d; the FPU runs in chop mode,
    docs/gameplay.md "FPU rounding mode"), so 64 -> 127."""
    return int((c / 128) * 255) & 0xFF


class Canvas:
    """Tiny RGBA compositor (SRCALPHA/INVSRCALPHA, texture x vertex colour)."""

    def __init__(self, w, h, rgb=(0, 0, 0)):
        self.w, self.h = w, h
        self.px = bytearray(bytes((rgb[0], rgb[1], rgb[2], 255)) * (w * h))

    def blend(self, x, y, r, g, b, a):
        if 0 <= x < self.w and 0 <= y < self.h and a > 0:
            o = (y * self.w + x) * 4
            p = self.px
            p[o] = (r * a + p[o] * (255 - a)) // 255
            p[o + 1] = (g * a + p[o + 1] * (255 - a)) // 255
            p[o + 2] = (b * a + p[o + 2] * (255 - a)) // 255

    def image(self, x, y, w, h, rgba, mul=(255, 255, 255), alpha=255, v_top=0.0):
        x0, y0 = int(-(-(x - 0.5) // 1)), int(-(-(y - 0.5) // 1))  # ceil(x - 0.5)
        skip = int(round(v_top * h))
        for yy in range(skip, h):
            for xx in range(w):
                s = (yy * w + xx) * 4
                a = rgba[s + 3] * alpha // 255
                self.blend(x0 + xx, y0 + yy, rgba[s] * mul[0] // 255, rgba[s + 1] * mul[1] // 255,
                           rgba[s + 2] * mul[2] // 255, a)

    def rect(self, x, y, w, h, rgb, a):
        for yy in range(int(-(-(y - 0.5) // 1)), int(-(-(y + h - 0.5) // 1))):
            for xx in range(int(-(-(x - 0.5) // 1)), int(-(-(x + w - 0.5) // 1))):
                self.blend(xx, yy, rgb[0], rgb[1], rgb[2], a)

    def hline(self, x0, x1, y, rgb, a):
        for xx in range(int(min(x0, x1)), int(max(x0, x1))):
            self.blend(xx, int(y), rgb[0], rgb[1], rgb[2], a)

    def vline(self, x, y0, y1, rgb, a):
        for yy in range(int(min(y0, y1)), int(max(y0, y1))):
            self.blend(int(x), yy, rgb[0], rgb[1], rgb[2], a)

    def text(self, font, s, x, y, align="left", mul=(255, 255, 255)):
        width = text_width(font, s)
        pen = x - width // 2 if align == "centre" else x - width if align == "right" else x
        for ch in s.encode("latin1"):
            g = font["char_map"][ch]
            if g == 0:
                pen += font["space_advance"]
                continue
            gl = font["glyphs"][g - 1]
            self.image(pen + gl["x"], y + gl["y"], gl["width"], gl["height"], gl["rgba"], mul)
            pen += gl["advance"]


def wrap_status_text(font, text, wrap):
    """FUN_00483d20 word wrap (see web-port/src/loaders/ui.ts wrapStatusText)."""
    buf, lines, start, space, p = list(text), [], 0, -1, 0
    while p < len(buf):
        if len(lines) > 8:
            break
        c = buf[p]
        if text_width(font, "".join(buf[start:p])) >= wrap or c == "\n":
            if space < 0:
                space = p - 1
            lines.append("".join(buf[start:space if space >= start else len(buf)]))
            start = space + 1
        if buf[p] == " ":
            space = p
        p += 1
    if p != start and start < len(buf):
        lines.append("".join(buf[start:]))
    return lines[-3:] if len(lines) >= 4 else lines


def _archive(root, rel):
    data = open(os.path.join(root, rel), "rb").read()
    out = {}
    for name, chunk in resource_members(data):
        short = name.split("/")[-1]
        if chunk.tag != "BODY":
            continue
        body = chunk.payload(data)
        out[short] = read_font(body, short) if short.endswith(".fnt") else read_sprite(body, short)
    return out


def hud_preview(root, W=640, H=480):
    """Compose a mock in-game frame with the recovered layout rules."""
    st = _archive(root, "screens/game/status/status.res")
    hud_font = _archive(root, "computer/computer.res")["font3.fnt"]
    msg_font = _archive(root, "menusystem/ingamemenu.res")["font1.fnt"]
    cv = Canvas(W, H, (70, 78, 70))
    spr = lambda n, i=0: st[n]["frames"][i]
    neutral = (255, 255, 255)
    # Health (bar drawn before the outline: reversed submission order).
    hx, hy = W * HEALTH_CENTRE[0], H * HEALTH_CENTRE[1]
    bar, bg = spr("powerbar.spr"), spr("powerbarbackground.spr")
    health = 0.7
    cv.image(hx - 2 - bar["width"] * 0.5, hy - 2 - bar["height"] * 0.5, bar["width"], bar["height"],
             bar["rgba"], v_top=1 - health)
    cv.image(hx - bg["width"] * 0.5, hy - bg["height"] * 0.5, bg["width"], bg["height"], bg["rgba"])
    # Weapon panel (MP5SD: CLIP display, 23 of 32 rounds, 49 spare).
    rx, by = W * WEAPON_RIGHT[0], H * WEAPON_RIGHT[1]
    name, lh = "Mp5 SD3", hud_font["line_height"]
    icon = spr("Mp5.spr")
    nw = text_width(hud_font, name)
    cv.text(hud_font, name, rx, by - 2 - lh, "right")
    cv.image(rx - icon["width"], by - 2 - 2 - icon["height"] - lh, icon["width"], icon["height"], icon["rgba"])
    line_w = nw + 3 if icon["width"] < nw else icon["width"]
    cv.hline(rx - line_w, rx, by, (0, 229, 0), 127)   # 0.9f / 0.5f, truncated
    ammo = "49  "
    aw = text_width(hud_font, ammo)
    clip = spr("clip20.spr", 60 - (23 * 60) // 32)
    cv.text(hud_font, ammo, rx - 4, by + 4, "right")
    cv.image(rx - 4 - 8 - clip["width"] - aw, by + 4, clip["width"], clip["height"], clip["rgba"])
    # Crosshair.
    cross = spr("cross.spr")
    cv.image(W * 0.5 - int(cross["width"] * 0.5), H * 0.5 - int(cross["height"] * 0.5),   # trunc (chop-mode fistp)
             cross["width"], cross["height"], cross["rgba"])
    # Action icon (door) at full pulse.
    door = spr("a_door.spr")
    cv.image(W * 0.5 - door["width"] // 2, H * 0.875 - door["height"] // 2, door["width"], door["height"],
             door["rgba"], alpha=255)
    # Radio messages (fully open and typed), first without portrait, second with ammo.spr.
    mx, my = W * MESSAGE_ORIGIN[0], H * MESSAGE_ORIGIN[1]
    for text, portrait in (("ANYA: The truck is in the garage on the far side of the base.", None),
                           ("Picked up ammo", "ammo.spr")):
        p = spr(portrait) if portrait else None
        h = p["height"] if p else 37
        x0, x1, y0, y1 = mx, mx + 235, my, my + h
        cv.hline(x0, x1, y0, (0, 229, 0), 127)
        cv.hline(x0, x1, y1, (0, 229, 0), 127)
        cv.vline(x0, y0, y1, (0, 229, 0), 127)
        cv.vline(x1, y0, y1, (0, 229, 0), 127)
        cv.rect(x0, y0, x1 - x0, y1 - y0, (0, 127, 0), colour_byte(0.15 * 128))   # 0.5 -> 127
        cv.rect(x0, y0, x1 - x0, y1 - y0, (0, 0, 0), colour_byte(0.33 * 128))
        ty = my + 2
        for line in wrap_status_text(msg_font, text, 229):
            cv.text(msg_font, line, mx + (p["width"] if p else 0) + 3, ty, mul=(0, colour_byte(120), 0))
            ty += msg_font["line_height"]
        if p:
            cv.image(mx, my, p["width"], p["height"], p["rgba"])
        my += 42
    return W, H, bytes(cv.px)


def loading_preview(root, done=4, total=9, W=800, H=600):
    pics = _archive(root, "menusystem/loadingscreen.res")
    pw, ph, rgba = compose_picture(pics["loading.pic"])
    cv = Canvas(W, H)
    ox, oy = (W - 640) // 2, (H - 480) // 2
    cv.image(ox, oy, pw, ph, rgba)
    x, y, bw, bh = LOADING_BAR
    cv.rect(ox + x, oy + y, bw, bh, (0, 127, 0), 255)
    cv.rect(ox + x, oy + y, (bw * done) // total, bh, (0, 255, 0), 255)
    return W, H, bytes(cv.px)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--game", default=os.path.join(HERE, "..", "Game Files"))
    ap.add_argument("--png-dir", default=None, help="write PNG previews here (outside the repo)")
    args = ap.parse_args(argv)
    root = os.path.abspath(args.game)
    png = args.png_dir
    if png:
        os.makedirs(png, exist_ok=True)
    totals = {"sprites": 0, "frames": 0, "pictures": 0, "fonts": 0, "glyphs": 0, "strings": 0}
    failures = []

    def save(name, w, h, rgba, bg=None):
        if png:
            write_png(os.path.join(png, name.replace("/", "__").replace(":", "_") + ".png"), w, h, rgba, bg)

    def font_check(label, data):
        f = read_font(data, label)
        totals["fonts"] += 1
        totals["glyphs"] += len(f["glyphs"])
        mapped = sum(1 for g in f["char_map"] if g)
        print(f"  font {label}: {len(f['glyphs'])} glyphs, {mapped} mapped chars, line height "
              f"{f['line_height']}, space {f['space_advance']}, cell {f['cell_width']}, "
              f"trailing {f['trailing_bytes']} bytes")
        if png:
            save(label + "_atlas", *font_atlas(f), bg=(0, 0, 0))
            save(label + "_sample", *render_text(f, "Steal the truck near the main entrance. 0123456789 %-:"), bg=(40, 60, 40))
        return f

    for rel in UI_ARCHIVES:
        path = os.path.join(root, rel)
        if not os.path.exists(path):
            print(f"{rel}: missing")
            failures.append(rel)
            continue
        data = open(path, "rb").read()
        print(f"{rel}:")
        for name, chunk in resource_members(data):
            if chunk.tag != "BODY":
                continue
            body = chunk.payload(data)
            short = name.split(":", 1)[-1]
            try:
                if short.endswith(".fnt"):
                    font_check(short, body)
                    continue
                s = read_sprite(body, short)
                totals["sprites"] += 1
                totals["frames"] += len(s["frames"])
                if short.endswith(".pic"):
                    totals["pictures"] += 1
                    w, h, rgba = compose_picture(s)
                    print(f"  picture {short}: {s['tiles']['columns']}x{s['tiles']['rows']} tiles of "
                          f"{s['width']}x{s['height']} -> {w}x{h}")
                    save(short, w, h, rgba)
                else:
                    f0 = s["frames"][0]
                    print(f"  sprite {short}: v{s['version']} {len(s['frames'])} frame(s) "
                          f"{f0['width']}x{f0['height']} fmt {f0['format']}")
                    for i, f in enumerate(s["frames"]):
                        if i == 0 or i == len(s["frames"]) - 1:
                            save(f"{short}_{i}", f["width"], f["height"], f["rgba"], bg=(255, 0, 255))
            except FormatError as e:
                failures.append(f"{short}: {e}")
                print(f"  FAIL {short}: {e}")
    for rel in LOOSE_FONTS:
        path = os.path.join(root, rel)
        if os.path.exists(path):
            print(f"{rel}:")
            try:
                font_check(rel, open(path, "rb").read())
            except FormatError as e:
                failures.append(f"{rel}: {e}")
    for rel in STRING_ARCHIVES:
        path = os.path.join(root, rel)
        if not os.path.exists(path):
            continue
        data = open(path, "rb").read()
        n = sum(1 for _, c in resource_members(data) if c.tag == "CSTR")
        totals["strings"] += n
        print(f"{rel}: {n} strings")
    for rel in ("screens/intro/eidos.avi", "screens/intro/innerloop.avi"):
        path = os.path.join(root, rel)
        if os.path.exists(path):
            print(f"{rel}: {avi_info(open(path, 'rb').read())}")
    for rel in ("screens/intro/eidos.wav", "screens/intro/innerloop.wav"):
        path = os.path.join(root, rel)
        if os.path.exists(path):
            print(f"{rel}: {wav_info(open(path, 'rb').read())}")
    if png and not failures:
        save("preview_hud_640x480", *hud_preview(root))
        save("preview_loading_800x600_4of9", *loading_preview(root))
        print(f"previews written to {png}")
    print("summary:", ", ".join(f"{v} {k}" for k, v in totals.items()),
          f"| {len(failures)} failure(s)")
    for f in failures:
        print("  failure:", f)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
