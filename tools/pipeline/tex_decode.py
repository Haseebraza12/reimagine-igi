"""LOOP .tex decoder (v2 / v9 / v11) based on Research/TEX/TEX_FORMAT.md plus
visual validation performed by this pipeline (see research/pipeline-report.json).

Observed in Mission 1 data:
  * v11 mode 2  - ARGB1555  (632/663 res textures)   bpp=2
  * v11 mode 67 - BGRA8888  (31/663 res textures)    bpp=4
  * v11 mode 3  - BGRA8888  (sky layers)             bpp=4
  * v9  mode 2  - ARGB1555, 18 tile layers           (terrain.tex)

Pixel-order decisions (per Research/TEX/TEX_FORMAT.md section 3.2):
  mode 2 : value u16 LE; R = bits 14..10, G = bits 9..5, B = bits 4..0;
           alpha bit 15 IGNORED (forced opaque) - the doc explicitly says the
           alpha bit is ignored by the game's loader.
  mode 3 / 67: byte order B,G,R,A -> output R,G,B,A.

Validation performed by the build (recorded in the report):
  sky layers are decoded with the documented order AND the alternative
  interpretation; per-row luminance variance proves the documented order
  produces the smooth gradient expected of a sky.
"""

import struct
import sys
from pathlib import Path

_TOOLS_DIR = Path(__file__).resolve().parent.parent
if str(_TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_TOOLS_DIR))

from igi_formats import FormatError, u32  # noqa: E402


def _scale5(v: int) -> int:
    """5-bit channel -> 8-bit (value * 255 / 31, rounded)."""

def _decode_v9(data: bytes):
    """Multi-tile v9 (terrain.tex): 52-byte header, tile descriptors at 0x34."""
    if len(data) < 52:
        raise FormatError("truncated v9 header")
    footer_offset = u32(data, 0x1C)
    layer_count = u32(data, 0x20)
    width, height, mode = struct.unpack_from("<3I", data, 0x28)
    if not 0 < layer_count <= 64 or not 0 < width <= 4096:
        raise FormatError("unsupported v9 header values")
    layers = []
    fmt_str = conf = None
    for i in range(layer_count):
        base = 0x34 + i * 32
        if base + 32 > len(data):
            raise FormatError("truncated v9 layer descriptors")
        img_off, img_mode = struct.unpack_from("<II", data, base)
        line_w, w, h = struct.unpack_from("<3H", data, base + 8)
        bpp = 2 if img_mode == 2 else 4
        need = img_off + line_w * h
        if w != width or h != height or need > len(data):
            raise FormatError(f"unsupported v9 layer {i} layout")
        rows = [data[img_off + y * line_w:img_off + y * line_w + w * bpp]
                for y in range(h)]
        rgba, fmt_str, conf = decode_mode(img_mode, bpp, b"".join(rows))
        layers.append(rgba)
    return {
        "width": width, "height": height, "rgba": layers[0],
        "format": fmt_str, "confidence": conf, "version": 9, "mode": mode,
        "bpp": 2, "layer_count": layer_count,
        "tail_bytes": max(0, len(data) - footer_offset),
        "layers": layers,
    }


def _decode_v2(data: bytes):
    if len(data) < 20:
        raise FormatError("truncated v2 header")
    mode = u32(data, 8)
    line_w, width, height, bpp = struct.unpack_from("<4H", data, 16)
    if mode != 2 or bpp != 2 or line_w // 2 != width:
        raise FormatError("only 16-bit v2 textures are supported")
    need = 20 + width * height * 2
    if need > len(data):
        raise FormatError("truncated v2 pixels")
    rgba, fmt, conf = decode_mode(2, 2, data[20:need])
    return {
        "width": width, "height": height, "rgba": rgba, "format": fmt,
        "confidence": conf, "version": 2, "mode": mode, "bpp": bpp,
        "layer_count": 1, "tail_bytes": len(data) - need, "layers": None,
    }

    return (v << 3) | (v >> 2)


# 65536-entry ARGB1555 -> RGBA8888 lookup, built lazily once per process.
_ARG1555_TABLE = None


def _argb1555_table():
    global _ARG1555_TABLE
    if _ARG1555_TABLE is None:
        tbl = [None] * 65536
        for v in range(65536):
            r = _scale5((v >> 10) & 31)
            g = _scale5((v >> 5) & 31)
            b = _scale5(v & 31)
            tbl[v] = bytes((r, g, b, 255))  # alpha bit ignored -> opaque
        _ARG1555_TABLE = tbl
    return _ARG1555_TABLE


def _decode_1555(pixels: bytes) -> bytes:
    tbl = _argb1555_table()
    count = len(pixels) // 2
    values = struct.unpack("<%dH" % count, pixels)
    return b"".join([tbl[v] for v in values])


def _decode_bgra(pixels: bytes) -> bytes:
    """BGRA8888 -> RGBA8888 (swap byte 0 and 2 of every quad)."""
    n = len(pixels) // 4
    out = bytearray(len(pixels))
    out[0::4] = pixels[2::4]
    out[1::4] = pixels[1::4]
    out[2::4] = pixels[0::4]
    out[3::4] = pixels[3::4]
    return bytes(out)


def _decode_bgr24(pixels: bytes) -> bytes:
    n = len(pixels) // 3
    out = bytearray(n * 4)
    out[0::4] = pixels[2::3]
    out[1::4] = pixels[1::3]
    out[2::4] = pixels[0::3]
    out[3::4] = b"\xff" * n
    return bytes(out)


def decode_mode(mode: int, bpp: int, pixels: bytes):
    """Decode raw pixel bytes for one mip/tile layer.

    Returns (rgba, format_string, confidence).
    """
    if mode == 2 and bpp == 2:
        return _decode_1555(pixels), "LOOP-type2-argb1555", "recovered"
    if mode in (3, 67) and bpp == 4:
        return _decode_bgra(pixels), "LOOP-type%d-bgra8888" % mode, "recovered"
    if mode == 3 and bpp == 3:
        return _decode_bgr24(pixels), "LOOP-type3-bgr24", "inferred"
    raise FormatError(f"unsupported pixel format mode={mode} bpp={bpp}")


def decode(data: bytes):
    """Decode a LOOP .tex to RGBA8888.

    Returns dict: width, height, rgba, format, confidence, version, mode,
                  bpp, layer_count, tail_bytes, layers (v9 tiles only).
    v9 tile textures additionally expose every layer; `rgba` is the first
    tile so callers always have something to render.
    """
    if len(data) < 20 or data[:4] != b"LOOP":
        raise FormatError("not a LOOP texture")
    version = u32(data, 4)

    if version == 11:
        return _decode_v11(data)
    if version == 9:
        return _decode_v9(data)
    if version == 2:
        return _decode_v2(data)
    raise FormatError(f"unsupported LOOP texture version {version}")


def _decode_v11(data: bytes):
    if len(data) < 32:
        raise FormatError("truncated v11 header")
    mode = u32(data, 8)
    width, height, stored_w, stored_h, bpp = struct.unpack_from("<5H", data, 22)
    if not 0 < width <= 4096 or not 0 < height <= 4096:
        raise FormatError("unsupported v11 dimensions")
    stride = stored_w * bpp
    need = 32 + stride * height
    if need > len(data):
        raise FormatError("truncated v11 pixels")
    # Compose rows honoring the stored stride (equals width*bpp in all
    # observed Mission-1 textures; kept general per TEX_FORMAT.md 3.6).
    rows = []
    for y in range(height):
        rows.append(data[32 + y * stride:32 + y * stride + width * bpp])
    pixels = b"".join(rows)
    rgba, fmt, conf = decode_mode(mode, bpp, pixels)
    return {
        "width": width, "height": height, "rgba": rgba, "format": fmt,
        "confidence": conf, "version": 11, "mode": mode, "bpp": bpp,
        "layer_count": 1, "tail_bytes": len(data) - need, "layers": None,
    }
