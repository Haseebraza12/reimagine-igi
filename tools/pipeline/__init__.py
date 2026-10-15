"""Research utilities for Project I.G.I. asset inspection (stdlib only).

Modules:
    png.py            Minimal PNG encoder/decoder (RGB8/RGBA8, zlib).
    res_extract.py    ILFF/IRES container walker with per-member manifests.
    tex_decode.py     LOOP .tex decoder (v2 / v9 tiles / v11 mips) for previews.
    nav_build.py      graphs/*.dat AI navigation graph parser (validated against
                      the community Graph_7 notes; parses every level-1 graph
                      to EOF). Node positions are relative to the AIGraph task's
                      "Graph position" in objects.qvm.

The web port no longer needs a conversion step: it decodes the original files
in the browser (web-port/src/loaders). An earlier build_level1.py /
terrain_build.py pair turned the first terrain.hmp grid into the level's height
field; that interpretation was wrong (the grids are HeightMap detail stamps,
see docs/terrain.md) and both scripts were removed.

The reference parser tools/igi_formats.py is imported (its directory is added
to sys.path) rather than copied.
"""

__all__ = [
    "png",
    "res_extract",
    "tex_decode",
    "nav_build",
]

__version__ = "2.0.0"
