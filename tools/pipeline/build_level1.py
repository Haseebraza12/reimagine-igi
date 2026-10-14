"""Level 1 asset pipeline: raw IGI mission data -> web-port runtime assets.

Run with no arguments:

    python3 tools/pipeline/build_level1.py

It reads the staged Mission-1 data under web-port/public/raw and writes
web-port/public/assets/level1:

    heights.bin      129x129 Float32 LE world-unit elevation grid
    lightmap.bin     129x129 uint8 coarse lightmap
    terrain.png      terrain diffuse texture (LOOP .tex -> RGBA PNG)
    textures/*.png   sky layers + every texture in common/textures/location0.res
    nav.json         NavGraph for the engine AI layer
    manifest.json    LevelManifest (web-port/src/contracts.ts)

Idempotent: every artifact is overwritten in place, so re-running reproduces
byte-identical output.  Directories are created as needed.

WHAT IS AND IS NOT DECODED
--------------------------
Decoded here: terrain (hmp/lmp/tex), textures, AI navigation graphs.

NOT decoded: object placements.  Mission-1 stores them in objects.qvm /
objects.qsc, whose layout is not established, so `objects` is emitted EMPTY and
`playerSpawn` / `objectives` are documented placeholders rather than guesses.
The same applies to `enemyPatrols`, which is omitted entirely.  Filling those
in requires a QVM/QSC placement decoder; until then the engine gets an honest
empty array instead of fabricated transforms.  Per-field confidence is in
`manifest.provenance` and in the terrain_build / nav_build docstrings.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import png  # noqa: E402
import res_extract  # noqa: E402
import tex_decode  # noqa: E402
import terrain_build  # noqa: E402
import nav_build  # noqa: E402

# --- fixed paths -------------------------------------------------------------
# Derived from this file's location so the tree stays relocatable; in this
# workspace they resolve to exactly the documented absolute paths.
REPO_ROOT = Path(__file__).resolve().parents[2]
RAW = REPO_ROOT / "web-port" / "public" / "raw"
ASSETS_OUT = REPO_ROOT / "web-port" / "public" / "assets" / "level1"

LEVEL_NAME = "level1"
MISSION_REL = "missions/location0"
LEVEL_REL = f"{MISSION_REL}/{LEVEL_NAME}"
COMMON_REL = f"{MISSION_REL}/common"
TERRAIN_REL = f"{LEVEL_REL}/terrain"
COMMON_TEXTURES_REL = f"{COMMON_REL}/textures"

SKY_LAYER_FILES = ("sky_layer1.tex", "sky_layer2.tex")
COMMON_TEXTURE_CONTAINER = "location0.res"

# Player eye height above the ground at the spawn point.  Matches
# DEFAULT_PLAYER_TUNING.eyeHeight in web-port/src/contracts.ts.
EYE_HEIGHT = 1.7

# Placeholder objective, expressed as a fraction of the way across the
# heightfield from vertex (0,0).  0.8 puts it on the far side of the level from
# the centred spawn so a "reach it" goal is meaningful.
OBJECTIVE_CELL_FRACTION = 0.8
OBJECTIVE_RADIUS = 12.0

GENERATOR = "tools/pipeline/build_level1.py"



# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _png_name(safe_name: str) -> str:
    """`000_03_1.tex` -> `000_03_1.png` (keeps res_extract's collision suffixes)."""
    return Path(safe_name).with_suffix(".png").name


def _read_heights(path: Path, size: int):
    """Read back heights.bin and sanity-check its length.

    Reading the file back (instead of reusing the in-memory array) means the
    spawn point is derived from the artifact that actually ships.
    """
    data = path.read_bytes()
    expected = size * size * 4
    if len(data) != expected:
        raise ValueError(
            f"{path} is {len(data)} bytes, expected {expected} "
            f"({size}x{size} Float32)")
    return struct.unpack("<%df" % (size * size), data)


def build_textures(out_textures_dir: Path, raw_dir: Path):
    """Decode the sky layers and the common texture container to PNGs.

    Writes `out_textures_dir`/<name>.png.  Failures are skipped and reported
    rather than aborting the build, so one bad texture never costs the level.
    """
    out_textures_dir.mkdir(parents=True, exist_ok=True)
    written, failed = [], []

    def emit(label: str, target_name: str, payload: bytes) -> None:
        try:
            tex = tex_decode.decode(payload)
            png.write(out_textures_dir / target_name, tex["width"], tex["height"],
                      tex["rgba"], 4)
        except Exception as exc:  # noqa: BLE001 - report and continue
            failed.append({"source": label, "error": f"{type(exc).__name__}: {exc}"})
            return
        written.append({"file": target_name, "source": label,
                        "width": tex["width"], "height": tex["height"],
                        "format": tex["format"]})

    # 1. Standalone sky layers (bottom -> top, matching manifest.skyLayers).
    for name in SKY_LAYER_FILES:
        path = raw_dir / COMMON_TEXTURES_REL / name
        try:
            payload = path.read_bytes()
        except OSError as exc:
            failed.append({"source": str(path), "error": str(exc)})
            continue
        emit(name, _png_name(name), payload)

    # 2. Every member of the common ILFF texture container.
    container = raw_dir / COMMON_TEXTURES_REL / COMMON_TEXTURE_CONTAINER
    container_members = 0
    try:
        data = container.read_bytes()
        members, _ = res_extract.extract_container(container)
        container_members = len(members)
        for member in members:
            payload = data[member["offset"]:member["offset"] + member["size"]]
            emit(member["name"], _png_name(member["safe_name"]), payload)
    except Exception as exc:  # noqa: BLE001 - report and continue
        failed.append({"source": container.name,
                       "error": f"{type(exc).__name__}: {exc}"})

    return {"written": written, "failed": failed,
            "containerMembers": container_members}


def build_manifest(terrain_spec: dict, heights) -> dict:
    """Assemble the LevelManifest for web-port/src/contracts.ts."""
    size = terrain_spec["size"]
    cell = terrain_spec["cellSize"]
    scale = terrain_spec["heightScale"]
    offset = terrain_spec["worldOffset"]

    # Spawn: terrain centre vertex, eye height above the ground.
    mid = (size - 1) // 2
    spawn_y = heights[mid * size + mid] + EYE_HEIGHT
    spawn_x = offset[0] + mid * cell
    spawn_z = offset[2] + mid * cell

    # Placeholder goal on the far side of the heightfield from the spawn.
    far = min(size - 1, int(round((size - 1) * OBJECTIVE_CELL_FRACTION)))
    goal_y = heights[far * size + far] + 1.0

    return {
        "name": LEVEL_NAME,
        "provenance": {
            "generator": GENERATOR,
            "confidence": "recovered",
            "notes": (
                "Terrain heights/lightmap/texture and the AI navigation graph are "
                "parsed from the original Mission-1 binaries. cellSize=%.1f and "
                "heightScale=%.1f are documented inferences (no source file records "
                "the terrain's world extent; IGI itself uses 4096 units = 1 m). "
                "objects is EMPTY and playerSpawn/objectives are placeholders "
                "because objects.qvm/.qsc placements are not decoded yet. "
                "worldOffset centres the heightfield on the origin: vertex (x,z) -> "
                "worldOffset + (x*cellSize, heights[z*size+x], z*cellSize). nav.json "
                "is in level-origin metres and is NOT yet registered against the "
                "terrain." % (cell, scale)
            ),
        },
        "terrain": {
            "hmp": f"{TERRAIN_REL}/terrain.hmp",
            "lmp": f"{TERRAIN_REL}/terrain.lmp",
            "heightsBin": f"{LEVEL_NAME}/heights.bin",
            "lightmapBin": f"{LEVEL_NAME}/lightmap.bin",
            # `size` is redundant: loadTerrain() derives it from sqrt(float count)
            # in heights.bin.  It is emitted anyway because it is the one number
            # a consumer needs before fetching, and TerrainData.size carries it
            # too.  Harmless at the JSON boundary: loadLevelManifest() casts
            # parsed JSON to LevelManifest, and structural typing only rejects
            # excess properties on fresh object literals.
            "size": size,
            "cellSize": cell,
            "heightScale": scale,
            "worldOffset": offset,
        },
        "skyLayers": [f"{COMMON_TEXTURES_REL}/{n}" for n in SKY_LAYER_FILES],
        "objects": [],
        "playerSpawn": {
            "position": [round(spawn_x, 4), round(spawn_y, 4), round(spawn_z, 4)],
            "yaw": 0.0,
        },
        "objectives": [{
            "id": "objective_reach_extraction",
            "type": "reach",
            "position": [round(offset[0] + far * cell, 4), round(goal_y, 4),
                         round(offset[2] + far * cell, 4)],
            "radius": OBJECTIVE_RADIUS,
            "description": (
                "PLACEHOLDER (not from game data): reach the far side of the "
                "terrain. Real objectives need mission.qvm decoding."
            ),
        }],
    }



# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _fmt_bytes(n: int) -> str:
    return f"{n:,}"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Build the Project I.G.I. level1 web-port asset bundle.")
    parser.add_argument("--raw", type=Path, default=RAW,
                        help="staged raw game data root (default: %(default)s)")
    parser.add_argument("--out", type=Path, default=ASSETS_OUT,
                        help="asset output directory (default: %(default)s)")
    args = parser.parse_args(argv)

    raw_dir = args.raw
    out_dir = args.out
    terrain_dir = raw_dir / TERRAIN_REL
    graphs_dir = raw_dir / LEVEL_REL / "graphs"

    print("Project I.G.I. web port - level1 asset build")
    print(f"  raw    {raw_dir}")
    print(f"  assets {out_dir}")

    # --- (a) terrain --------------------------------------------------------
    terrain_build.ensure_tex_decoder_ready()
    spec = terrain_build.build_terrain(terrain_dir, out_dir)
    heights = _read_heights(out_dir / spec["heightsBin"], spec["size"])
    hs, ls, ts = spec["heightStats"], spec["lightmapStats"], spec["textureStats"]

    print("\nterrain")
    print(f"  heights.bin   {_fmt_bytes(spec['bytes']['heights.bin']):>10} bytes"
          f"  {spec['size']}x{spec['size']} Float32 LE"
          f"  elevation {hs['worldMin']:.1f}..{hs['worldMax']:.1f} world units"
          f" (raw u8 {hs['rawMin']}..{hs['rawMax']})")
    print(f"  lightmap.bin  {_fmt_bytes(spec['bytes']['lightmap.bin']):>10} bytes"
          f"  {spec['size']}x{spec['size']} uint8"
          f"  from .lmp tile #{ls['sourceTileIndex']} ({ls['sourceTileSize']}x"
          f"{ls['sourceTileSize']} of {ls['tileCount']}, nearest resample)")
    print(f"  terrain.png   {'':>10}       {ts['width']}x{ts['height']} RGBA"
          f"  {ts['format']} (v{ts['version']}, {ts['layerCount']} tile layers)")
    print(f"  cellSize {spec['cellSize']}  heightScale {spec['heightScale']}"
          f"  worldOffset {spec['worldOffset']}")

    # --- (b) textures -------------------------------------------------------
    tex_report = build_textures(out_dir / "textures", raw_dir)
    print("\ntextures")
    print(f"  written {len(tex_report['written'])} PNGs into textures/"
          f"  ({len(SKY_LAYER_FILES)} sky layers + "
          f"{tex_report['containerMembers']} members of "
          f"{COMMON_TEXTURE_CONTAINER})")
    fmts = {}
    for entry in tex_report["written"]:
        fmts[entry["format"]] = fmts.get(entry["format"], 0) + 1
    for fmt, count in sorted(fmts.items(), key=lambda kv: -kv[1]):
        print(f"    {count:>4}  {fmt}")

    # --- (c) navigation -----------------------------------------------------
    nav_graph, nav_report = nav_build.build_nav_with_stats(graphs_dir)
    nav_bytes = nav_build.write_nav(nav_graph, out_dir / "nav.json")
    print("\nnavigation")
    print(f"  nav.json      {_fmt_bytes(nav_bytes):>10} bytes"
          f"  {nav_report['nodeCount']} nodes / {nav_report['linkCount']} links"
          f" from {len(nav_report['graphs'])} graph files")
    print(f"  transform: IGI units / {nav_report['unitsPerMeter']:.0f} = metres,"
          f" up_axis={nav_report['upAxis']}, offset={nav_report['offset']}")
    for entry in nav_report["graphs"]:
        flag = "exact EOF" if entry["exactEof"] else "TRAILING BYTES"
        dropped = (f", dropped {entry['droppedNodes']} node(s)"
                   if entry["droppedNodes"] else "")
        print(f"    {entry['file']:<15} {entry['keptNodes']:>3} nodes"
              f" {entry['keptLinks']:>4} links  ({flag}{dropped})")

    # --- (d) manifest -------------------------------------------------------
    manifest = build_manifest(spec, heights)
    manifest_path = out_dir / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n",
                             encoding="utf-8")

    print("\nmanifest")
    print(f"  manifest.json {_fmt_bytes(manifest_path.stat().st_size):>10} bytes")
    print(f"    name        {manifest['name']}")
    print(f"    terrain     size {manifest['terrain']['size']}, cellSize "
          f"{manifest['terrain']['cellSize']}, heightScale "
          f"{manifest['terrain']['heightScale']}")
    print(f"    objects     {len(manifest['objects'])} (placements not decoded)")
    print(f"    playerSpawn {manifest['playerSpawn']['position']}")
    print(f"    objectives  {len(manifest['objectives'])} (placeholder)")
    print(f"    skyLayers   {len(manifest['skyLayers'])}")


    # --- (e) skipped / failed ----------------------------------------------
    problems = []
    problems += [f"texture {p['source']}: {p['error']}"
                 for p in tex_report["failed"]]
    problems += [f"graph {p['file']}: {p['error']}"
                 for p in nav_report["failed"]]
    if nav_report["droppedNodes"]:
        problems.append(
            f"{nav_report['droppedNodes']} nav node(s) dropped as implausible "
            f"(beyond {nav_report['maxExtent']} m)")
    if nav_report["droppedLinks"]:
        problems.append(
            f"{nav_report['droppedLinks']} nav link(s) dropped (dangling node id)")

    print("\nskipped / failed")
    if problems:
        for line in problems:
            print(f"  ! {line}")
    else:
        print("  (none)")

    level_textures = raw_dir / LEVEL_REL / "textures"
    if level_textures.is_dir():
        try:
            count = len(res_extract.extract_container(
                level_textures / f"{LEVEL_NAME}.res")[0])
        except Exception:  # noqa: BLE001 - informational only
            count = None
        if count:
            print(f"\nnote: {count} textures in {LEVEL_NAME}.res were NOT decoded "
                  f"(outside this task's scope); re-run build_textures() on that "
                  f"container to add them.")

    print(f"\ndone. {len(tex_report['written']) + 6} files written under {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
