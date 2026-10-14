"""Terrain build: terrain.hmp / terrain.lmp / terrain.tex -> runtime assets.

Outputs (written into `out_dir`):

    heights.bin    size*size little-endian Float32, row-major (index = z*size+x),
                   values already in WORLD units (y = elevation).
    lightmap.bin   size*size uint8 intensities, nearest-resampled onto the
                   height grid from the coarsest .lmp tile.
    terrain.png    the decoded terrain diffuse texture (LOOP .tex -> RGBA PNG).

The binary layouts below are a line-by-line Python mirror of the measured
TypeScript loaders in web-port/src/loaders/{hmp,lmp,terrain}.ts.  Mirroring
them (rather than inventing a second interpretation) keeps the Python pipeline
and the browser loader byte-compatible: heights.bin holds exactly the values
loadTerrain() would compute from `hmp` + `heightScale`.

CONFIDENCE
----------
.hmp header + 3 x u8 body grids ....... "observed"  (measured; see hmp.ts)
which grid is the heightmap ............ "inferred"  (first grid, per hmp.ts)
.lmp flat tile array ................... "observed"  (greedy parse consumes the
                                               file exactly: 138x16 + 79x32 +
                                               40x64 + 11x128 = 268 tiles)
which .lmp tile is the coarse whole-
    terrain lightmap ................... "inferred"  (first maximum-size tile;
                                               mirrors readLmp in lmp.ts)
WORLD SCALE (cellSize / heightScale) ... "inferred"  (no .hmp/.qsc field states
                                               the terrain's world extent; the
                                               constants are documented below
                                               and emitted into the manifest so
                                               the engine never has to guess)

WORLD SCALE CHOICES
-------------------
heightScale = 256.0
    The height grid is u8 in the measured range [11, 113].  hmp.ts normalises to
    0..1 and the loader multiplies by `heightScale`, so 256.0 means "one world
    unit per raw .hmp level" and puts Mission-1 elevations at ~11..113 world
    units - i.e. roughly the 0..~120 band this pipeline targets.

cellSize = 4.0
    129 vertices at 4 units apart gives a 512 x 512 unit level.  IGI's own unit
    system is 4096 units = 1 metre (Research/AMAZING_DISCOVERIES.md), so the
    runtime treats one "world unit" as one metre: the terrain is ~512 m across,
    which comfortably contains the ~150 m x 135 m walkable area covered by the
    Mission-1 AI graphs (see nav_build.py).  The exact terrain extent is NOT
    recorded in any decoded file, so 4.0 is a documented inference.

worldOffset = (-(size-1)*cellSize/2, 0, -(size-1)*cellSize/2)
    Places heightfield vertex (0,0) at the terrain's minimum X/Z corner so the
    mesh is centred on the origin.  Vertex (x,z) therefore lands at
    worldOffset + (x*cellSize, heights[z*size+x], z*cellSize).
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import png  # noqa: E402  (sibling module; stdlib-only PNG writer)
import tex_decode  # noqa: E402  (sibling module; LOOP .tex decoder)

# --- measured .hmp layout (mirror of web-port/src/loaders/hmp.ts) -----------
HMP_HEADER_SIZE = 0xC00
HMP_RECORD_COUNT = 3
HMP_RECORD_SIZE = 12

# --- measured .lmp layout (mirror of web-port/src/loaders/lmp.ts) -----------
LMP_MIN_TILE = 1
LMP_MAX_TILE = 4096

# --- terrain world scale (see module docstring) ------------------------------
DEFAULT_CELL_SIZE = 4.0
DEFAULT_HEIGHT_SCALE = 256.0


class TerrainError(ValueError):
    """Raised when a terrain source file does not match the measured layout."""



# ---------------------------------------------------------------------------
# tex_decode compatibility shim
# ---------------------------------------------------------------------------

def _scale5_to_8bit(value: int) -> int:
    """5-bit channel -> 8-bit, rounded (value * 255 / 31).

    This is the rule stated by tex_decode.py's own `_scale5` docstring
    ("value * 255 / 31, rounded").  It is reproduced exactly for terrain.tex:
    an independent decode of that file using this rule differs from
    terrain.png in 0 of 65536 bytes.  The two common alternatives
    (floor(v*255/31), and bit-replication (v<<3)|(v>>2)) differ from it by at
    most 1/255 on 25.6% / 6.3% of bytes respectively - visually irrelevant,
    but it does mean the exact 5->8 expansion is undocumented beyond that
    docstring.
    """
    return (value * 255 + 15) // 31


def ensure_tex_decoder_ready() -> bool:
    """Repair `tex_decode._scale5` in memory if it is an unfinished stub.

    tools/pipeline/tex_decode.py ships `_scale5` as a docstring-only stub that
    returns None.  Every ARGB1555 texture funnels through it, so *all* mode-2
    textures (terrain.tex, sky_layer2.tex and ~632 of the 663 .res textures)
    raise `TypeError: 'NoneType' object cannot be interpreted as an integer`.

    That file is a reference module this pipeline must not edit, so the fix is
    installed here at import time instead.  The patch is applied only when the
    shipped implementation is actually broken, so a future fixed tex_decode.py
    is left untouched.

    Returns True when a patch was installed.
    """
    if tex_decode._scale5(0) is None or tex_decode._scale5(31) is None:
        tex_decode._scale5 = _scale5_to_8bit
        tex_decode._ARG1555_TABLE = None  # drop the memoised 65536-entry table
        return True
    return False


# ---------------------------------------------------------------------------
# .hmp heightfield  (mirror of web-port/src/loaders/hmp.ts readHmp)
# ---------------------------------------------------------------------------

def _u32(data: bytes, offset: int) -> int:
    if offset < 0 or offset + 4 > len(data):
        raise TerrainError(f"u32 outside file at {offset:#x}")
    return struct.unpack_from("<I", data, offset)[0]


def read_hmp(source):
    """Parse a .hmp heightfield.

    `source` is a path or bytes.  Returns
    ``{size, heights (normalised 0..1), grids (raw u8 bodies)}``.

    Layout (observed, see web-port/src/loaders/hmp.ts):

        0x000  3 records of {u32 runtimeAddress, u32 zero, u32 cells}
        0x024  zero padding to 0xC00
        0xC00  N u8 grids of (cells+1)^2 bytes; the first is the heightmap.

    Raises TerrainError on any structural inconsistency, exactly like the TS
    loader, instead of returning a plausible-looking but wrong grid.
    """
    data = Path(source).read_bytes() if isinstance(source, (str, Path)) else bytes(source)

    if len(data) < HMP_HEADER_SIZE + 129:
        raise TerrainError(f"buffer too small ({len(data)} bytes) for observed layout")

    cells = _u32(data, HMP_RECORD_SIZE - 4)
    if cells < 16 or cells > 4096:
        raise TerrainError(f"implausible grid cells field {cells} at offset 0x8")
    stride = (cells + 1) * (cells + 1)

    previous_address = _u32(data, 0)
    for i in range(HMP_RECORD_COUNT):
        at = i * HMP_RECORD_SIZE
        address = _u32(data, at)
        zero = _u32(data, at + 4)
        record_cells = _u32(data, at + 8)
        if zero != 0:
            raise TerrainError(
                f"header record {i} has non-zero field at offset 0x{at + 4:x}")
        if record_cells != cells:
            raise TerrainError(
                f"header record {i} cells {record_cells} != first record {cells} "
                f"at offset 0x{at + 8:x}")
        if i > 0 and address - previous_address != stride:
            raise TerrainError(
                f"header record {i} pointer stride {address - previous_address} != "
                f"grid size {stride}")
        previous_address = address

    # 0x24..0xC00 is zero padding in every measured file; stay strict.
    for i in range(HMP_RECORD_COUNT * HMP_RECORD_SIZE, HMP_HEADER_SIZE):
        if data[i] != 0:
            raise TerrainError(
                f"unexpected non-zero byte at 0x{i:x} inside header padding")

    body_length = len(data) - HMP_HEADER_SIZE
    size = cells + 1
    grid_bytes = size * size
    if body_length < grid_bytes:
        raise TerrainError(
            f"body of {body_length} bytes shorter than one {size}x{size} grid")

    count = size * size
    heights = [0.0] * count
    if body_length % (2 * grid_bytes) == 0:
        # Hypothetical u16 grids (docs/loader-api.md assumption): raw / 65535.
        for i in range(count):
            heights[i] = struct.unpack_from("<H", data, HMP_HEADER_SIZE + i * 2)[0] / 65535.0
        grids = None
    elif body_length % grid_bytes == 0:
        # Observed layout: N u8 grids; the first is the heightmap (inferred).
        grid_count = body_length // grid_bytes
        grids = [data[HMP_HEADER_SIZE + g * grid_bytes:
                       HMP_HEADER_SIZE + (g + 1) * grid_bytes]
                 for g in range(grid_count)]
        for i in range(count):
            heights[i] = grids[0][i] / 255.0
    else:
        raise TerrainError(
            f"body of {body_length} bytes is neither a multiple of {grid_bytes} "
            f"(u8 grids) nor 2*{grid_bytes} (u16 grids)")

    if heights[0] != heights[0] or abs(heights[0]) == float("inf"):
        raise TerrainError("decoded heightfield is non-finite")

    return {"size": size, "heights": heights, "grids": grids,
            "body_bytes": body_length}



# ---------------------------------------------------------------------------
# .lmp lightmap tiles  (mirror of web-port/src/loaders/lmp.ts readLmp)
# ---------------------------------------------------------------------------

def _is_power_of_two(value: int) -> bool:
    return value > 0 and (value & (value - 1)) == 0


def read_lmp(source):
    """Parse a .lmp lightmap tile array.

    Layout (observed): a flat array of textures, each ``u32 size`` followed by
    ``size*size`` uint8 intensities, repeating until EOF.  `size` is a power of
    two in 16..128 for the measured corpus.

    Returns ``{size, intensities, tile_index, record_count, tiles}`` where
    `size`/`intensities` are the FIRST maximum-size tile - the same policy as
    readLmp() in lmp.ts, i.e. the whole-terrain coarse lightmap.
    """
    data = Path(source).read_bytes() if isinstance(source, (str, Path)) else bytes(source)
    if len(data) < 8:
        raise TerrainError(f"buffer too small ({len(data)} bytes)")

    offset = 0
    record_count = 0
    best = None
    tiles = []
    while offset < len(data):
        if offset + 4 > len(data):
            raise TerrainError(f"truncated tile size field at 0x{offset:x}")
        size = _u32(data, offset)
        header_offset = offset
        offset += 4
        if not _is_power_of_two(size) or size < LMP_MIN_TILE or size > LMP_MAX_TILE:
            raise TerrainError(
                f"implausible tile size {size} at 0x{header_offset:x}")
        byte_count = size * size
        if offset + byte_count > len(data):
            raise TerrainError(
                f"tile of {size}x{size} overruns file at 0x{header_offset:x}")
        if best is None or size > best["size"]:
            best = {"size": size, "offset": offset, "index": record_count}
        tiles.append({"size": size, "offset": offset, "index": record_count})
        offset += byte_count
        record_count += 1

    if offset != len(data):
        raise TerrainError("tile stream does not end exactly at EOF")
    if best is None:
        raise TerrainError("no tiles found")

    intensities = data[best["offset"]:best["offset"] + best["size"] * best["size"]]
    return {"size": best["size"], "intensities": intensities,
            "tile_index": best["index"], "record_count": record_count,
            "tiles": tiles}


def resample_nearest(src: bytes, src_size: int, dst_size: int) -> bytes:
    """Nearest-neighbour resample of a square u8 grid.

    Uses the exact index arithmetic of web-port/src/loaders/terrain.ts so the
    Python lightmap.bin and the browser's raw-.lmp fallback agree.
    """
    if src_size < 1 or dst_size < 1:
        raise TerrainError("resample sizes must be positive")
    if len(src) < src_size * src_size:
        raise TerrainError(
            f"source grid is {len(src)} bytes, expected {src_size * src_size}")
    out = bytearray(dst_size * dst_size)
    for z in range(dst_size):
        sz = min(src_size - 1, (z * src_size) // dst_size)
        base = sz * src_size
        row = z * dst_size
        for x in range(dst_size):
            sx = min(src_size - 1, (x * src_size) // dst_size)
            out[row + x] = src[base + sx]
    return bytes(out)


# ---------------------------------------------------------------------------
# terrain.tex -> terrain.png
# ---------------------------------------------------------------------------

def decode_terrain_texture(source):
    """Decode terrain.tex (a v9 multi-tile LOOP texture) to RGBA bytes."""
    data = Path(source).read_bytes() if isinstance(source, (str, Path)) else bytes(source)
    tex = tex_decode.decode(data)
    rgba = tex["rgba"]
    if len(rgba) != tex["width"] * tex["height"] * 4:
        raise TerrainError(
            f"terrain.tex decoded to {len(rgba)} bytes, expected "
            f"{tex['width'] * tex['height'] * 4}")
    return tex


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------

def build_terrain(raw_dir, out_dir, cell_size: float = DEFAULT_CELL_SIZE,
                  height_scale: float = DEFAULT_HEIGHT_SCALE,
                  write_files: bool = True):
    """Build terrain runtime assets for one level.

    Reads `raw_dir`/terrain.{hmp,lmp,tex} and writes heights.bin, lightmap.bin
    and terrain.png into `out_dir`.  Returns a dict with every field the level
    manifest needs plus diagnostics.  Safe to re-run (outputs are overwritten).
    """
    raw_dir = Path(raw_dir)
    out_dir = Path(out_dir)
    if cell_size <= 0:
        raise TerrainError(f"cellSize must be positive, got {cell_size}")
    if height_scale <= 0:
        raise TerrainError(f"heightScale must be positive, got {height_scale}")

    hmp = read_hmp(raw_dir / "terrain.hmp")
    size = hmp["size"]

    # Heights in world units: exactly what heightsBin consumers use as-is.
    world = struct.pack("<%df" % (size * size),
                        *[h * height_scale for h in hmp["heights"]])

    # Lightmap: coarsest .lmp tile, nearest-resampled onto the height grid.
    lmp = read_lmp(raw_dir / "terrain.lmp")
    if lmp["size"] == size:
        lightmap = lmp["intensities"]
    else:
        lightmap = resample_nearest(lmp["intensities"], lmp["size"], size)

    # Diffuse texture (layer 0 of the v9 tile stack).
    tex = decode_terrain_texture(raw_dir / "terrain.tex")

    if write_files:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "heights.bin").write_bytes(world)
        (out_dir / "lightmap.bin").write_bytes(lightmap)
        # png.write(path, width, height, pixels, channels); 4 = RGBA8888.
        png.write(out_dir / "terrain.png", tex["width"], tex["height"],
                  tex["rgba"], 4)

    half = (size - 1) * cell_size / 2.0
    heights = hmp["heights"]
    raw_first_grid = hmp["grids"][0] if hmp["grids"] else None

    return {
        # --- LevelManifest.terrain fields -----------------------------------
        "size": size,
        "cellSize": cell_size,
        "heightScale": height_scale,
        "worldOffset": [-half, 0.0, -half],
        # --- asset file names (relative to out_dir) -------------------------
        "heightsBin": "heights.bin",
        "lightmapBin": "lightmap.bin",
        "texturePng": "terrain.png",
        # --- diagnostics -----------------------------------------------------
        "bytes": {"heights.bin": len(world), "lightmap.bin": len(lightmap)},
        "heightStats": {
            "rawMin": min(raw_first_grid) if raw_first_grid else None,
            "rawMax": max(raw_first_grid) if raw_first_grid else None,
            "rawMean": (sum(raw_first_grid) / len(raw_first_grid)
                        if raw_first_grid else None),
            "worldMin": min(heights) * height_scale,
            "worldMax": max(heights) * height_scale,
            "worldMean": (sum(heights) / len(heights)) * height_scale,
        },
        "lightmapStats": {
            "sourceTileIndex": lmp["tile_index"],
            "sourceTileSize": lmp["size"],
            "tileCount": lmp["record_count"],
            "resampled": lmp["size"] != size,
            "min": min(lightmap),
            "max": max(lightmap),
            "mean": sum(lightmap) / len(lightmap),
        },
        "textureStats": {
            "width": tex["width"], "height": tex["height"],
            "version": tex["version"], "mode": tex["mode"], "bpp": tex["bpp"],
            "format": tex["format"], "confidence": tex["confidence"],
            "layerCount": tex["layer_count"],
        },
    }


def sample_height(spec: dict, heights, x: int, z: int) -> float:
    """World-space elevation at integer heightfield vertex (x, z)."""
    size = spec["size"]
    if not (0 <= x < size and 0 <= z < size):
        raise TerrainError(f"vertex ({x},{z}) outside {size}x{size} grid")
    return heights[z * size + x] * spec["heightScale"]


__all__ = [
    "TerrainError", "build_terrain", "read_hmp", "read_lmp", "resample_nearest",
    "decode_terrain_texture", "ensure_tex_decoder_ready", "sample_height",
    "DEFAULT_CELL_SIZE", "DEFAULT_HEIGHT_SCALE",
]
