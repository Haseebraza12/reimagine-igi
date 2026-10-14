"""Minimal PNG writer (and tiny reader for self-tests) using only zlib/struct.

Supported: 8-bit RGB (color type 2) and 8-bit RGBA (color type 6), no
interlace, scanline filter type 0 ("None").  This is intentionally small: the
pipeline only needs to dump decoded texture pixels for the web loader.

The reader exists so tests can round-trip encode->decode without PIL; it
understands exactly what the writer emits (plus filter types 0..4 so that the
round-trip test is meaningful against general decoders is NOT required - we
keep it strict and fail loudly on anything else).
"""

import struct
import zlib

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class PngError(ValueError):
    pass


def _chunk(tag: bytes, payload: bytes) -> bytes:
    """One PNG chunk: length, tag, payload, CRC32(tag+payload)."""
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def encode(width: int, height: int, pixels: bytes, channels: int) -> bytes:
    """Encode 8-bit pixel data (row-major, top-down) into a PNG byte string.

    channels: 3 = RGB, 4 = RGBA.  pixels must be width*height*channels bytes.
    """
    if width <= 0 or height <= 0:
        raise PngError("invalid image dimensions")
    if channels not in (3, 4):
        raise PngError("only 3 (RGB) or 4 (RGBA) channels are supported")
    expected = width * height * channels
    if len(pixels) != expected:
        raise PngError(f"pixel buffer is {len(pixels)} bytes, expected {expected}")

    color_type = 2 if channels == 3 else 6
    ihdr = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)

    # Filter byte 0 ("None") in front of every scanline.
    stride = width * channels
    raw = bytearray()
    for row in range(height):
        raw.append(0)
        raw += pixels[row * stride:(row + 1) * stride]

    idat = zlib.compress(bytes(raw), 9)
    return PNG_SIGNATURE + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", idat) + _chunk(b"IEND", b"")


def write(path, width: int, height: int, pixels: bytes, channels: int) -> int:
    """Encode and write to `path` (str or pathlib.Path). Returns byte count."""
    data = encode(width, height, pixels, channels)
    with open(path, "wb") as fh:
        fh.write(data)
    return len(data)


def decode(data: bytes):
    """Decode a PNG produced by `encode` back into (width, height, channels, pixels).

    Strict: accepts only bit depth 8, color types 2/6, non-interlaced, filter 0.
    """
    if data[:8] != PNG_SIGNATURE:
        raise PngError("not a PNG file")
    pos = 8
    width = height = channels = None
    idat = bytearray()
    seen_iend = False
    while pos < len(data):
        if pos + 8 > len(data):
            raise PngError("truncated chunk header")
        length, tag = struct.unpack_from(">I4s", data, pos)
        pos += 8
        payload = data[pos:pos + length]
        if len(payload) != length:
            raise PngError("truncated chunk payload")
        pos += 4  # CRC (not validated; this reader is for round-trip tests)
        if tag == b"IHDR":
            width, height, depth, color, comp, filt, interlace = struct.unpack(
                ">IIBBBBB", payload)
            if depth != 8 or color not in (2, 6) or interlace != 0:
                raise PngError("unsupported PNG variant in reader")
            channels = color
        elif tag == b"IDAT":
            idat += payload
        elif tag == b"IEND":
            seen_iend = True
            break
    if width is None or not seen_iend:
        raise PngError("missing IHDR or IEND")
    raw = zlib.decompress(bytes(idat))
    stride = width * channels
    if len(raw) != (stride + 1) * height:
        raise PngError("decompressed size mismatch")
    out = bytearray()
    for row in range(height):
        base = row * (stride + 1)
        if raw[base] != 0:
            raise PngError("reader only supports filter type 0")
        out += raw[base + 1:base + 1 + stride]
    return width, height, channels, bytes(out)


def write_rgb(path, width, height, pixels):
    return write(path, width, height, pixels, 3)


def write_rgba(path, width, height, pixels):
    return write(path, width, height, pixels, 4)
