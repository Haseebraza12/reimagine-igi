"""Read-only parsers for the formats observed in this IGI installation.

These describe measured layouts, not complete engine specifications. Unknown
versions fail explicitly. All offsets are file offsets unless named otherwise.
"""
from dataclasses import dataclass
import struct


class FormatError(ValueError):
    pass


def u32(data, offset):
    if offset < 0 or offset + 4 > len(data):
        raise FormatError(f"u32 outside file at {offset:#x}")
    return struct.unpack_from("<I", data, offset)[0]


def align_up(value, alignment):
    if alignment < 1 or alignment > 4096 or alignment & (alignment - 1):
        raise FormatError(f"unsupported alignment {alignment}")
    return (value + alignment - 1) & -alignment


@dataclass(frozen=True)
class Chunk:
    tag: str
    header_offset: int
    payload_offset: int
    size: int
    alignment: int
    next_delta: int

    def payload(self, data):
        return data[self.payload_offset:self.payload_offset + self.size]


def ilff_chunks(data):
    """Walk the observed ILFF/IRES container, checking every boundary.

    The root size includes its header. Child payloads align against the file
    origin; the next delta is relative to the child header. Zero ends the chain.
    """
    if len(data) < 20 or data[:4] != b"ILFF" or data[16:20] != b"IRES":
        raise FormatError("expected ILFF/IRES resource container")
    if u32(data, 4) != len(data) or u32(data, 12) != 0:
        raise FormatError("unexpected root size or link")
    pos = align_up(20, u32(data, 8))
    while pos < len(data):
        if pos + 16 > len(data):
            raise FormatError(f"truncated chunk header at {pos:#x}")
        raw_tag = data[pos:pos + 4]
        if not all(32 <= byte <= 126 for byte in raw_tag):
            raise FormatError(f"invalid chunk tag at {pos:#x}")
        size, alignment, delta = struct.unpack_from("<3I", data, pos + 4)
        payload = align_up(pos + 16, alignment)
        end = payload + size
        if end > len(data):
            raise FormatError(f"chunk payload outside file at {pos:#x}")
        chunk = Chunk(raw_tag.decode("ascii"), pos, payload, size, alignment, delta)
        if delta == 0:
            # Observed terminal chunks end at EOF without compulsory padding.
            if end != len(data):
                raise FormatError(f"unexplained bytes after final chunk at {pos:#x}")
        elif pos + delta < end or pos + delta >= len(data):
            raise FormatError(f"invalid next-chunk delta at {pos:#x}")
        yield chunk
        if delta == 0:
            return
        pos += delta
    if pos != len(data):
        raise FormatError("root alignment exceeds file")


def resource_members(data):
    """Pair NAME with BODY, CSTR or PATH, preserving original virtual names."""
    pending = None
    for chunk in ilff_chunks(data):
        if chunk.tag == "NAME":
            if pending is not None:
                raise FormatError("NAME without a corresponding payload")
            raw = chunk.payload(data)
            if not raw or raw[-1] != 0:
                raise FormatError("NAME is not NUL terminated")
            pending = raw.rstrip(b"\0").decode("latin1")
        elif chunk.tag in ("BODY", "CSTR", "PATH"):
            if pending is None:
                raise FormatError(f"{chunk.tag} without NAME")
            yield pending, chunk
            pending = None
        else:
            raise FormatError(f"unsupported resource chunk {chunk.tag}")
    if pending is not None:
        raise FormatError("resource ends with unmatched NAME")


def qvm_symbols(data):
    """LOOP v8 symbol names, with measured table and code bounds.

    No assumption that these symbols are executable procedures: they include
    host function names, constants, and arguments. No bytecode execution.
    """
    if len(data) < 60 or data[:4] != b"LOOP" or u32(data, 4) != 8:
        raise FormatError("expected LOOP v8 QVM")
    table, strings, table_size, strings_size = struct.unpack_from("<4I", data, 12)
    code, code_size = struct.unpack_from("<2I", data, 44)
    if table < 60 or table_size % 4 or table + table_size != strings:
        raise FormatError("invalid symbol-offset table")
    if strings + strings_size > len(data) or code + code_size != len(data):
        raise FormatError("invalid QVM section bounds")
    if code < strings + strings_size:
        raise FormatError("code overlaps symbol strings")
    names = []
    for offset in range(table, table + table_size, 4):
        relative = u32(data, offset)
        if relative >= strings_size:
            raise FormatError("symbol offset outside string section")
        start = strings + relative
        end = data.find(b"\0", start, strings + strings_size)
        if end < 0:
            raise FormatError("unterminated symbol")
        names.append({"name": data[start:end].decode("latin1"), "offset": start})
    return {"version": 8, "symbol_count": len(names), "symbols": names,
            "code_offset": code, "code_size": code_size,
            "status": "symbols recovered; bytecode not decoded"}


def texture_preview(data):
    """Experimental LOOP v11 base-level decoding to RGBA.

    Pixel interpretation remains inferred until checked against the original
    renderer. Supports observed 1555 and BGRA8888 candidates only. Tail bytes
    (e.g. mip levels) are reported rather than silently treated as pixels.
    """
    if len(data) < 32 or data[:4] != b"LOOP" or u32(data, 4) != 11:
        raise FormatError("only LOOP texture v11 is supported")
    fmt = u32(data, 8)
    width, height, stored_width, stored_height, bpp = struct.unpack_from("<5H", data, 22)
    if not 0 < width <= 4096 or not 0 < height <= 4096:
        raise FormatError("unsupported texture dimensions")
    if (width, height) != (stored_width, stored_height):
        raise FormatError("different logical/storage dimensions need investigation")
    if (fmt, bpp) not in ((2, 2), (3, 4), (67, 4)):
        raise FormatError(f"unsupported pixel format {fmt}, bytes/pixel {bpp}")
    count = width * height
    end = 32 + count * bpp
    if end > len(data):
        raise FormatError("truncated base-level texture pixels")
    pixels = data[32:end]
    rgba = bytearray(count * 4)
    if bpp == 2:
        for i, (value,) in enumerate(struct.iter_unpack("<H", pixels)):
            r, g, b = (value >> 10) & 31, (value >> 5) & 31, value & 31
            rgba[i * 4:i * 4 + 4] = bytes(((r << 3) | (r >> 2),
                (g << 3) | (g >> 2), (b << 3) | (b >> 2), 255 if value & 0x8000 else 0))
        interpretation = "inferred A1R5G5B5"
    else:
        for i in range(count):
            b, g, r, a = pixels[i * 4:i * 4 + 4]
            rgba[i * 4:i * 4 + 4] = bytes((r, g, b, a))
        interpretation = "inferred BGRA8888"
    return {"width": width, "height": height, "format_id": fmt,
            "bytes_per_pixel": bpp, "tail_bytes": len(data) - end,
            "interpretation": interpretation, "confidence": "inferred"}, bytes(rgba)


def pe_sections(data):
    """Minimal PE32 triage and raw-file to virtual-address mapping."""
    if data[:2] != b"MZ":
        raise FormatError("expected DOS MZ header")
    pe = u32(data, 60)
    if data[pe:pe + 4] != b"PE\0\0" or pe + 24 > len(data):
        raise FormatError("expected PE signature")
    machine, count, timestamp = struct.unpack_from("<HHI", data, pe + 4)
    optional_size = struct.unpack_from("<H", data, pe + 20)[0]
    optional = pe + 24
    if optional_size < 64 or optional + optional_size > len(data):
        raise FormatError("truncated optional header")
    if struct.unpack_from("<H", data, optional)[0] != 0x10b:
        raise FormatError("only PE32 is supported")
    base = u32(data, optional + 28)
    sections = []
    for i in range(count):
        offset = optional + optional_size + i * 40
        if offset + 40 > len(data):
            raise FormatError("truncated section table")
        virtual_size, rva, raw_size, raw_offset = struct.unpack_from("<4I", data, offset + 8)
        if raw_size and raw_offset + raw_size > len(data):
            raise FormatError("section raw bytes outside file")
        sections.append({"name": data[offset:offset + 8].rstrip(b"\0").decode("ascii"),
            "virtual_size": virtual_size, "rva": rva, "raw_size": raw_size,
            "raw_offset": raw_offset, "va": base + rva})
    return {"machine": hex(machine), "architecture": "x86" if machine == 0x14c else "unknown",
            "timestamp": timestamp, "image_base": hex(base),
            "entry_va": hex(base + u32(data, optional + 16)), "sections": sections}


def file_offset_to_va(info, offset):
    for section in info["sections"]:
        if section["raw_offset"] <= offset < section["raw_offset"] + section["raw_size"]:
            return section["va"] + offset - section["raw_offset"]
    return None
