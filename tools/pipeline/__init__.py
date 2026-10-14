"""Asset pipeline converting Project I.G.I. Mission 1 (location0/level1) game
assets into web-port-ready files.

Modules (stdlib only):
    png.py            Minimal PNG encoder/decoder (RGB8/RGBA8, zlib).
    res_extract.py    ILFF/IRES container walker with per-member manifests.
    tex_decode.py     LOOP .tex decoder (v2 / v9 tiles / v11 mips).
    terrain_build.py  terrain.hmp -> heights.bin, terrain.tex -> terrain.png,
                      terrain.lmp patch analysis.
    nav_build.py      graphs/*.dat -> nav.json (positions + links).
    build_level1.py   CLI orchestrator; emits LevelManifest + assets + report.

The reference parser tools/igi_formats.py is imported (its directory is added
to sys.path) rather than copied; this package adds conversion on top of its
measured container/texture walking.
"""

__all__ = [
    "png",
    "res_extract",
    "tex_decode",
    "terrain_build",
    "nav_build",
]

__version__ = "1.0.0"
