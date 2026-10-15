#!/usr/bin/env python3
"""Project I.G.I. (2000) terrain texturing and lighting (stdlib only).

Builds on terrain_ctr.py (geometry).  Reproduces, per emitted terrain cell vertex
or per surface point, what igi.exe's FUN_00509250 (cell build) and FUN_0050be70
(draw) compute:

* material   - per vertex: the innermost active TextureModifier whose 1-bit mask
               (terrain.bit) is set at the vertex, else material 0;
* layers     - per (material, cell): tex layer = tilemap[tm][vtile*8 + utile]
               from CreateTerrainMaterial / CreateTerrainTileMap (terrain.qvm);
               two layers per material: B (fine, full detail) and A (coarse,
               blended in with the LOD factor);
* UV         - planar in world x/y, or x-z / y-z when the vertex projection bits
               (B: bits 8-9, A: bits 6-7) are non-zero;
* lightmap   - innermost TerrainLightMap node's terrain.lmp record, planar UV,
               8-bit value looked up through a palette built from the terrain
               ambient colour and the sun (Dirlight) front colour;
* blending   - pass 0 (opaque, tex*diffuse), pass 1 (additive, tex*diffuse),
               pass 2 (multiply by lightmap colour).  At full detail (LOD factor
               m = 0) only layer B of each vertex's own material contributes, with
               per-vertex weight 1 and Gouraud interpolation across triangles.

Evidence and confidence labels: docs/terrain.md ("Texturing and lighting").
Browser port: web-port/src/loaders/terrain-look.ts.
"""
import json
import math
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import terrain_ctr as tc   # noqa: E402

import level_tasks  # noqa: E402

GAME_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "Game Files", "missions", "location0", "level1", "terrain")
LEVEL1_DATA = None  # inputs are read from objects.qvm / terrain.qvm unless a JSON path is given


# ------------------------------------------------------------------ file parsers
class TexFile:
    """terrain.tex, 'LOOP' version 9.  igi.exe FUN_005112b0 reads only: +0x04 version,
    +0x12 (s16, passed to the texture creator), +0x18 palette offset (0 = none),
    +0x20 layer count and the 32-byte layer records at +0x34.  The trailing
    'LOOP' v6 block (offset at +0x1c) is not read by the game."""

    def __init__(self, data):
        if data[:4] != b"LOOP":
            raise ValueError("not a LOOP file")
        self.version = struct.unpack_from("<I", data, 4)[0]
        if self.version != 9:
            raise ValueError("only LOOP v9 handled (igi.exe also accepts v7)")
        self.hdr_s16_0x12 = struct.unpack_from("<h", data, 0x12)[0]
        self.palette_offset = struct.unpack_from("<I", data, 0x18)[0]
        self.footer_offset = struct.unpack_from("<I", data, 0x1C)[0]
        n = struct.unpack_from("<I", data, 0x20)[0]
        self.hdr_width, self.hdr_height, self.hdr_mode = struct.unpack_from("<3I", data, 0x28)
        self.layers = []
        for i in range(n):
            o = 0x34 + 32 * i
            off, mode = struct.unpack_from("<2I", data, o)
            pitch, w, h = struct.unpack_from("<3H", data, o + 8)
            raw = struct.unpack_from("<%dH" % (w * h), data, off)   # pitch == 2*w here
            self.layers.append({"offset": off, "mode": mode, "pitch": pitch, "width": w, "height": h, "raw": raw})
        self.footer = None
        fo = self.footer_offset
        if fo and data[fo:fo + 4] == b"LOOP":
            ver = struct.unpack_from("<I", data, fo + 4)[0]
            hw = struct.unpack_from("<4H", data, fo + 8)
            cx, cy = struct.unpack_from("<2I", data, fo + 16)
            items = [struct.unpack_from("<4I", data, fo + 24 + 16 * k) for k in range(cx * cy)]
            self.footer = {"version": ver, "u16": hw, "count_x": cx, "count_y": cy, "items": items,
                           "end": fo + 24 + 16 * cx * cy}
        self._rgb = {}

    def rgb(self, layer):
        """Layer as rows of (r, g, b) 0..255, decoded as A1R5G5B5 (mode 2)."""
        r = self._rgb.get(layer)
        if r is None:
            L = self.layers[layer]
            if L["mode"] != 2:
                raise ValueError("only mode 2 (A1R5G5B5) decoded")
            w = L["width"]
            px = [(((p >> 10) & 31) * 255 // 31, ((p >> 5) & 31) * 255 // 31, (p & 31) * 255 // 31) for p in L["raw"]]
            r = [px[y * w:(y + 1) * w] for y in range(L["height"])]
            self._rgb[layer] = r
        return r

    def sample(self, layer, u, v):
        """Bilinear, CLAMP addressing (as the game sets D3DTSS_ADDRESS = CLAMP)."""
        img = self.rgb(layer)
        h = len(img)
        w = len(img[0])
        return _bilinear_rgb(img, w, h, u * w - 0.5, v * h - 0.5)


class BitFile:
    """terrain.bit: 256 x {u32 runtime ptr, u32 flag, u32 side}, then at 0xC00 the
    side*side/8-byte masks of the non-empty entries in index order (loader
    FUN_004bc460).  Bit (ix, iy) = (mask[(ix >> 3) + iy * side/8] >> (ix & 7)) & 1."""

    def __init__(self, data):
        hdr = [struct.unpack_from("<3I", data, 12 * i) for i in range(256)]
        self.entries = {}
        p = 0xC00
        for i, (_a, _b, side) in enumerate(hdr):
            if side:
                n = side * side // 8
                self.entries[i] = (side, data[p:p + n])
                p += n
        self.end = p


class LmpFile:
    """terrain.lmp: records {u32 side, side*side u8}; record i is bound to the
    TerrainLightMap task whose TextureIndex is i (FUN_004bc120 / FUN_004ef350)."""

    def __init__(self, data):
        self.records = []
        p = 0
        while p < len(data):
            s = struct.unpack_from("<I", data, p)[0]
            self.records.append((s, data[p + 4:p + 4 + s * s]))
            p += 4 + s * s
        self.end = p

    def sample(self, idx, u, v):
        """Bilinear, CLAMP; returns the interpolated 8-bit value (0..255 float)."""
        side, d = self.records[idx]
        return _bilinear_scalar(d, side, u * side - 0.5, v * side - 0.5)


def _bilinear_scalar(d, side, tx, ty):
    tx = min(max(tx, 0.0), side - 1.0)
    ty = min(max(ty, 0.0), side - 1.0)
    x0 = int(tx)
    y0 = int(ty)
    x1 = min(x0 + 1, side - 1)
    y1 = min(y0 + 1, side - 1)
    fx = tx - x0
    fy = ty - y0
    a = d[y0 * side + x0] + (d[y0 * side + x1] - d[y0 * side + x0]) * fx
    b = d[y1 * side + x0] + (d[y1 * side + x1] - d[y1 * side + x0]) * fx
    return a + (b - a) * fy


def _bilinear_rgb(img, w, h, tx, ty):
    tx = min(max(tx, 0.0), w - 1.0)
    ty = min(max(ty, 0.0), h - 1.0)
    x0 = int(tx)
    y0 = int(ty)
    x1 = min(x0 + 1, w - 1)
    y1 = min(y0 + 1, h - 1)
    fx = tx - x0
    fy = ty - y0
    out = []
    for c in range(3):
        a = img[y0][x0][c] + (img[y0][x1][c] - img[y0][x0][c]) * fx
        b = img[y1][x0][c] + (img[y1][x1][c] - img[y1][x0][c]) * fx
        out.append(a + (b - a) * fy)
    return tuple(out)


def _f32(x):
    return struct.unpack("<f", struct.pack("<f", x))[0]


def _keyframe(frames, time, key):
    """Linear keyframe interpolation by Time, as FUN_00520720/FUN_00521280 do
    (exact match -> that frame; between -> lerp; outside -> nearest)."""
    fs = sorted(frames, key=lambda f: f["time"])
    for f in fs:
        if f["time"] == time:
            return list(f[key])
    lo = [f for f in fs if f["time"] < time]
    hi = [f for f in fs if f["time"] > time]
    if not lo:
        return list(hi[0][key])
    if not hi:
        return list(lo[-1][key])
    a, b = lo[-1], hi[0]
    t = (time - a["time"]) / (b["time"] - a["time"])
    return [x + (y - x) * t for x, y in zip(a[key], b[key])]


# ------------------------------------------------------------------ texturing
class TerrainLook:
    """Texturing + lighting for a decoded terrain.

    terrain : terrain_ctr.Terrain
    data    : dict as in level1_terrain_data.json (materials, tilemaps,
              texture_modifiers, terrain_lightmaps, *_keyframes)
    tex/bit/lmp : TexFile / BitFile / LmpFile (tex only needed for colours)
    time    : time of day used for the light keyframes (level 1: 12.0)
    """

    def __init__(self, terrain, data, bit, lmp, tex=None, time=12.0):
        self.T = terrain
        self.tex = tex
        self.lmp = lmp
        self.materials = {int(k): v for k, v in data["materials"].items()}
        self.tilemaps = {int(k): v for k, v in data["tilemaps"].items()}
        # TextureModifiers: entry built as FUN_004fd0f0 does (node box, origin = node
        # min corner, scale = (side-1)/node_size, row bytes = side/8).
        self.mods = []
        for m in sorted(data["texture_modifiers"], key=lambda m: m["order"]):
            if m["bitmap_id"] < 0 or m["bitmap_id"] not in bit.entries:
                continue                      # push handler requires a bitmap
            side, mask = bit.entries[m["bitmap_id"]]
            L = m["level"]
            full = 2 * (tc.ROOT_HALF >> L)
            x0 = int(m["position"][0]) & ~(full - 1)
            y0 = int(m["position"][1]) & ~(full - 1)
            self.mods.append({"name": m["name"], "order": m["order"], "level": L, "material": m["material"],
                              "box": (x0, y0, x0 + full, y0 + full), "scale": (side - 1) / full,
                              "rowbytes": side // 8, "mask": mask, "side": side, "bitmap_id": m["bitmap_id"]})
        # TerrainLightMaps (FUN_004ef350 / FUN_004efac0)
        self.lms = []
        for t in data["terrain_lightmaps"]:
            L = t["level"]
            full = 2 * (tc.ROOT_HALF >> L)
            x0 = int(t["position"][0]) & ~(full - 1)
            y0 = int(t["position"][1]) & ~(full - 1)
            idx = t["texture_index"]
            if idx < 0 or idx >= len(lmp.records) or not lmp.records[idx][0]:
                continue
            side = lmp.records[idx][0]
            self.lms.append({"level": L, "box": (x0, y0, x0 + full, y0 + full), "full": full,
                             "texture_index": idx, "side": side, "order": t["order"]})
        self._lm_index = {}
        for e in self.lms:
            self._lm_index[(e["level"], e["box"][0], e["box"][1])] = e
        # lighting palette (FUN_00508d20): palette[i] = min(255, trunc(i*sun + 255*ambient))
        self.time = time
        self.ambient = _keyframe(data["global_light_keyframes"], time, "ambient_terrain")
        self.sun = _keyframe(data["dirlight_keyframes"], time, "front_color")
        amb = [_f32(a) for a in self.ambient]
        sun = [_f32(s) for s in self.sun]
        self.palette = []
        for i in range(256):
            self.palette.append(tuple(min(255, int(_f32(sun[c] * i + amb[c] * 255.0))) for c in range(3)))
        self._cell_cache = {}

    # ---- modifier stack / material
    def modifier_stack(self, cx, cy):
        """Active TextureModifiers for a cell centre, innermost first, max 4.
        Deeper level = pushed later = innermost.  Within one object-tree node the
        list is head-inserted (FUN_004bd050) and pushed head-first, so the
        earliest-registered modifier ends up innermost."""
        act = [m for m in self.mods if m["box"][0] <= cx < m["box"][2] and m["box"][1] <= cy < m["box"][3]]
        act.sort(key=lambda m: (-m["level"], m["order"]))
        return act[:4]

    @staticmethod
    def material_from_stack(stack, x, y):
        for m in stack:
            ix = int((x - m["box"][0]) * m["scale"])     # x87 chop
            iy = int((y - m["box"][1]) * m["scale"])
            k = (ix >> 3) + iy * m["rowbytes"]
            if 0 <= k < len(m["mask"]) and (m["mask"][k] >> (ix & 7)) & 1:
                return m["material"]
        return 0

    def material_at(self, x, y, cell_centre=None):
        cx, cy = (cell_centre[0], cell_centre[1]) if cell_centre else (x, y)
        return self.material_from_stack(self.modifier_stack(cx, cy), x, y)

    # ---- lightmap
    def lightmap_for(self, cx, cy):
        """Innermost (deepest) TerrainLightMap node containing the cell centre."""
        for L in range(31, -1, -1):
            full = 2 * (tc.ROOT_HALF >> L)
            e = self._lm_index.get((L, int(cx) & ~(full - 1), int(cy) & ~(full - 1)))
            if e is not None:
                return e
        return None

    @staticmethod
    def lightmap_uv(e, x, y):
        return ((x - e["box"][0]) / e["full"] + 0.5 / e["side"],
                (y - e["box"][1]) / e["full"] + 0.5 / e["side"])

    def lightmap_value(self, e, u, v):
        return self.lmp.sample(e["texture_index"], u, v)

    def light_rgb(self, value):
        """Palette colour for an interpolated lightmap value (D3D filters the
        expanded palette colours; the palette is affine until it clamps)."""
        i0 = int(value)
        i1 = min(i0 + 1, 255)
        f = value - i0
        a, b = self.palette[i0], self.palette[i1]
        return tuple(a[c] + (b[c] - a[c]) * f for c in range(3))

    # ---- per-material layer / UV parameters for a cell
    def layer_params(self, material, level, centre):
        """For (material, level, cell centre): {'B': (layer, slope, u0, v0, w0),
        'A': (...)}; slope multiplies (coordinate - centre)."""
        lv = self.materials[material]["levels"][level]
        half = tc.ROOT_HALF >> level
        out = {}
        for name, s_arg, tm, shift, extra in (("B", lv["scaleB_arg"], lv["tilemapB"], 22 - level, 1.0),
                                              ("A", lv["scaleA_arg"], lv["tilemapA"], 23 - level, 0.5)):
            s = _f32(s_arg * 0.5)
            ks = []
            for c in centre:
                k = int(s * c) >> shift if shift >= 0 else int(s * c) << -shift
                ks.append(k)
            utile = (ks[0] & 0x7FF) >> 8
            vtile = (ks[1] & 0x7FF) >> 8
            layer = self.tilemaps[tm][vtile * 8 + utile]
            offs = [((k & 0xFF) + 1.0) / 256.0 for k in ks]
            out[name] = (layer, extra * s / half, offs[0], offs[1], offs[2])
        return out

    @staticmethod
    def vertex_uv(params, proj, t, rel):
        layer, slope, u0, v0, w0 = params
        rx, ry, rz = rel
        if proj == 0:
            return (rx * slope + u0, ry * slope + v0)
        if (proj ^ (t & 1)) & 1:
            return (ry * slope + v0, rz * slope + w0)
        return (rx * slope + u0, rz * slope + w0)

    # ---- per emitted cell
    def cell_texturing(self, cell):
        """Everything a renderer needs for one emitted cell (node, level, centre, t):
        vertices (world, incl. HeightMap relief), triangles, per-vertex material,
        projection bits, morph target, per material the B/A layer and per-vertex
        UVs, and the lightmap record with per-vertex UVs/values."""
        key = cell
        r = self._cell_cache.get(key)
        if r is not None:
            return r
        node, level, centre, t = cell
        V, Tri = self.T.cell_mesh(node, level, centre, t)
        off = self.T.rec[node]
        cmd = self.T.cmd
        ntri, tbytes, nbase, nextra = struct.unpack_from("<4H", cmd, off)
        raw = [struct.unpack_from("<I", cmd, off + 8 + tbytes + 4 * k)[0] for k in range(nbase + nextra)]
        stack = self.modifier_stack(centre[0], centre[1])
        mats = [self.material_from_stack(stack, x, y) if stack else 0 for (x, y, _z) in V]
        morph = [None] * nbase + [v & 63 for v in raw[nbase:]]
        projB = [(v >> 8) & 3 for v in raw]
        projA = [(v >> 6) & 3 for v in raw]
        rel = [(x - centre[0], y - centre[1], z - centre[2]) for (x, y, z) in V]
        per_mat = {}
        for m in sorted(set(mats) | set(mats[k] for k in range(nbase, nbase + nextra) if morph[k] is not None)):
            pr = self.layer_params(m, level, centre)
            per_mat[m] = {"layer_B": pr["B"][0], "layer_A": pr["A"][0],
                          "uv_B": [self.vertex_uv(pr["B"], projB[k], t, rel[k]) for k in range(len(V))],
                          "uv_A": [self.vertex_uv(pr["A"], projA[k], t, rel[k]) for k in range(len(V))]}
        lm = self.lightmap_for(centre[0], centre[1])
        lm_out = None
        if lm is not None:
            uvs = [self.lightmap_uv(lm, x, y) for (x, y, _z) in V]
            lm_out = {"texture_index": lm["texture_index"], "level": lm["level"], "uv": uvs,
                      "value": [self.lightmap_value(lm, u, v) for (u, v) in uvs]}
        r = {"cell": cell, "vertices": V, "triangles": Tri, "material": mats, "morph_target": morph,
             "proj_B": projB, "proj_A": projA, "materials": per_mat, "lightmap": lm_out,
             "modifiers": [m["name"] for m in stack]}
        self._cell_cache[key] = r
        return r

    # ---- per surface point
    def shade(self, x, y, z_hint=None, with_colour=True):
        """Full-detail (LOD factor 0) texturing and lighting of the surface at (x, y).
        Returns None if no surface.  'colour' is the game's pass-0/1/2 result without
        fog: sum_m w_m * texB_m(uv_m)  *  lightmap_rgb / 255  (0..255 floats)."""
        best = None
        for cell in self.T.column_cells(x, y):
            V, Tri = self.T.cell_mesh(*cell)
            for ti, (i, j, k) in enumerate(Tri):
                x1, y1, z1 = V[i]
                x2, y2, z2 = V[j]
                x3, y3, z3 = V[k]
                d = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3)
                if d == 0:
                    continue
                l1 = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / d
                l2 = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / d
                l3 = 1.0 - l1 - l2
                if min(l1, l2, l3) < -1e-9:
                    continue
                z = l1 * z1 + l2 * z2 + l3 * z3
                score = z if z_hint is None else -abs(z - z_hint)
                if best is None or score > best[0]:
                    best = (score, cell, (i, j, k), (l1, l2, l3), z)
        if best is None:
            return None
        _s, cell, tri, bary, z = best
        ct = self.cell_texturing(cell)
        weights = {}
        for vi, b in zip(tri, bary):
            weights[ct["material"][vi]] = weights.get(ct["material"][vi], 0.0) + b
        layers = []
        for m, w in sorted(weights.items()):
            pm = ct["materials"][m]
            uvB = tuple(sum(b * pm["uv_B"][vi][c] for vi, b in zip(tri, bary)) for c in range(2))
            uvA = tuple(sum(b * pm["uv_A"][vi][c] for vi, b in zip(tri, bary)) for c in range(2))
            layers.append({"material": m, "weight": w, "layer": pm["layer_B"], "uv": uvB,
                           "coarse_layer": pm["layer_A"], "coarse_uv": uvA})
        out = {"z": z, "cell": cell, "triangle": tri, "bary": bary, "layers": layers,
               "projection_B": [ct["proj_B"][vi] for vi in tri], "modifiers": ct["modifiers"]}
        lm = ct["lightmap"]
        if lm is not None:
            uv = tuple(sum(b * lm["uv"][vi][c] for vi, b in zip(tri, bary)) for c in range(2))
            e = self.lightmap_for(cell[2][0], cell[2][1])
            val = self.lightmap_value(e, uv[0], uv[1])
            out["lightmap"] = {"texture_index": lm["texture_index"], "level": lm["level"], "uv": uv,
                               "value": val, "rgb": self.light_rgb(val)}
        else:
            out["lightmap"] = None
        if with_colour and self.tex is not None:
            base = [0.0, 0.0, 0.0]
            for L in layers:
                c = self.tex.sample(L["layer"], L["uv"][0], L["uv"][1])
                for q in range(3):
                    base[q] += L["weight"] * c[q]
            base = [min(255.0, b) for b in base]
            lrgb = out["lightmap"]["rgb"] if out["lightmap"] else (255.0, 255.0, 255.0)
            out["colour"] = tuple(min(255.0, base[q] * lrgb[q] / 255.0) for q in range(3))
        return out


def load_level1(game_dir=GAME_DIR, data_path=LEVEL1_DATA, time=12.0, with_hmp=True):
    rd = lambda n: open(os.path.join(game_dir, n), "rb").read()
    if data_path:
        data = json.load(open(data_path))
    else:
        data = level_tasks.terrain_inputs(open(os.path.join(os.path.dirname(game_dir), "objects.qvm"), "rb").read(),
                                          rd("terrain.qvm"))
    hm = [{"position": h["position"], "level": h["level"], "size": h["size"], "bitmap_id": h["bitmap_id"]}
          for h in data["heightmaps"]]
    terr = tc.Terrain(rd("terrain.ctr"), rd("terrain.cmd"), rd("terrain.hmp") if with_hmp else None,
                      hm if with_hmp else None)
    look = TerrainLook(terr, data, BitFile(rd("terrain.bit")), LmpFile(rd("terrain.lmp")), TexFile(rd("terrain.tex")),
                       time=time)
    return look, data


# ======================================================================= self-checks
def _corr(a, b):
    n = len(a)
    ma = sum(a) / n
    mb = sum(b) / n
    sa = math.sqrt(sum((x - ma) ** 2 for x in a))
    sb = math.sqrt(sum((y - mb) ** 2 for y in b))
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / (sa * sb) if sa and sb else float("nan")


def _lstsq_r2(X, y):
    """R^2 of y ~ X (X rows include a constant 1), via normal equations (Gauss)."""
    k = len(X[0])
    A = [[sum(r[i] * r[j] for r in X) for j in range(k)] for i in range(k)]
    bvec = [sum(r[i] * yy for r, yy in zip(X, y)) for i in range(k)]
    M = [A[i] + [bvec[i]] for i in range(k)]
    for c in range(k):
        p = max(range(c, k), key=lambda r: abs(M[r][c]))
        M[c], M[p] = M[p], M[c]
        for r in range(k):
            if r != c and M[c][c]:
                f = M[r][c] / M[c][c]
                M[r] = [a - f * b for a, b in zip(M[r], M[c])]
    coef = [M[i][k] / M[i][i] if M[i][i] else 0.0 for i in range(k)]
    pred = [sum(c * r[i] for i, c in enumerate(coef)) for r in X]
    my = sum(y) / len(y)
    ss = sum((a - my) ** 2 for a in y)
    return 1 - sum((a - p) ** 2 for a, p in zip(y, pred)) / ss, coef


def self_check(game_dir=GAME_DIR, data_path=LEVEL1_DATA, png_dir=None):
    look, data = load_level1(game_dir, data_path)
    tex, lmp = look.tex, look.lmp
    T = look.T
    print("== file structure")
    lay = tex.layers
    print("tex: version %d, %d layers, header %dx%d mode %d, s16@0x12=%d, palette offset %d"
          % (tex.version, len(lay), tex.hdr_width, tex.hdr_height, tex.hdr_mode, tex.hdr_s16_0x12, tex.palette_offset))
    contiguous = all(L["offset"] == 0x34 + 32 * len(lay) + i * 32768 for i, L in enumerate(lay))
    alpha = sum(1 for L in lay for p in L["raw"] if p >> 15) / float(sum(len(L["raw"]) for L in lay))
    print("  layers: all 128x128 mode 2 pitch 256: %s; contiguous from 0x%x: %s; A1 bit set: %.4f"
          % (all((L["width"], L["height"], L["mode"], L["pitch"]) == (128, 128, 2, 256) for L in lay),
             0x34 + 32 * len(lay), contiguous, alpha))
    f = tex.footer
    print("  footer @0x%x: LOOP v%d, u16 %s, count_x=%d count_y=%d, items[k][3]==k+1: %s, ends at EOF: %s"
          % (tex.footer_offset, f["version"], f["u16"], f["count_x"], f["count_y"],
             all(it == (0, 0, 0, k + 1) for k, it in enumerate(f["items"])),
             f["end"] == len(open(os.path.join(game_dir, "terrain.tex"), "rb").read())))
    print("lmp: %d records (sides %s), TextureIndex<->record sides all equal: %s"
          % (len(lmp.records), sorted(set(s for s, _ in lmp.records)),
             all(lmp.records[t["texture_index"]][0] == t["size"] for t in data["terrain_lightmaps"])))

    # ---- tile-map seam test: neighbouring tiles in a tilemap must continue each other
    print("\n== tile-map seam test (mean |RGB| step across a tile boundary)")
    def edge(layer, side):
        img = tex.rgb(layer)
        if side == "R":
            return [img[y][127] for y in range(128)]
        if side == "L":
            return [img[y][0] for y in range(128)]
        if side == "B":
            return img[127]
        return img[0]
    def step(a, b):
        return sum(abs(p[c] - q[c]) for p, q in zip(a, b) for c in range(3)) / (3.0 * len(a))
    within = [step([tex.rgb(l)[y][63] for y in range(128)], [tex.rgb(l)[y][64] for y in range(128)]) for l in range(18)]
    adj_h, adj_v, rnd = [], [], []
    for tm in (2, 3):      # 2x2 arrangements (layers 3-6, 7-10)
        g = look.tilemaps[tm]
        for vt in range(8):
            for ut in range(8):
                a = g[vt * 8 + ut]
                adj_h.append(step(edge(a, "R"), edge(g[vt * 8 + (ut + 1) % 8], "L")))
                adj_v.append(step(edge(a, "B"), edge(g[((vt + 1) % 8) * 8 + ut], "T")))
    for a in range(18):
        for b in range(18):
            if a != b:
                rnd.append(step(edge(a, "R"), edge(b, "L")))
    tr_h = []
    for tm in (2, 3):      # transposed interpretation (u <-> row): use vertical neighbour on the right edge
        g = look.tilemaps[tm]
        for vt in range(8):
            for ut in range(8):
                tr_h.append(step(edge(g[vt * 8 + ut], "R"), edge(g[((vt + 1) % 8) * 8 + ut], "L")))
    avg = lambda v: sum(v) / len(v)
    print("  inside a layer (col 63|64): %.1f;  tilemap neighbours u (R|L): %.1f, v (B|T): %.1f;"
          "  transposed reading: %.1f;  random layer pairs: %.1f"
          % (avg(within), avg(adj_h), avg(adj_v), avg(tr_h), avg(rnd)))

    # ---- projection bits vs geometry, and material/lightmap coverage over the default region
    print("\n== projection bits vs local geometry (level-16 cells in the default level-1 bbox)")
    cnt = {}
    flat_nz = []
    steep_nz = []
    cells = list(T.iter_cells(tc.LEVEL1_DEFAULT_BBOX))
    for cell in cells:
        node, level, c, t = cell
        V, Tri = T.cell_mesh(*cell)
        off = T.rec[node]
        ntri, tbytes, nb, ne = struct.unpack_from("<4H", T.cmd, off)
        raw = [struct.unpack_from("<I", T.cmd, off + 8 + tbytes + 4 * k)[0] for k in range(nb + ne)]
        acc = [[0.0, 0.0, 0.0] for _ in V]
        for (i, j, k) in Tri:
            a, b, cc = V[i], V[j], V[k]
            u = [b[q] - a[q] for q in range(3)]
            w = [cc[q] - a[q] for q in range(3)]
            n = (u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0])
            for vi in (i, j, k):
                for q in range(3):
                    acc[vi][q] += n[q]
        for vi, n in enumerate(acc):
            L = math.sqrt(sum(q * q for q in n))
            if L == 0:
                continue
            nx, ny, nz = (q / L for q in n)
            for name, pb in (("B", (raw[vi] >> 8) & 3), ("A", (raw[vi] >> 6) & 3)):
                if pb == 0:
                    (flat_nz if name == "B" else []).append(abs(nz))
                    continue
                if name == "B":
                    steep_nz.append(abs(nz))
                axis_u_is_y = bool((pb ^ (t & 1)) & 1)
                dominant_x = abs(nx) > abs(ny)
                key = (name, "agree" if axis_u_is_y == dominant_x else "disagree")
                cnt[key] = cnt.get(key, 0) + 1
    print("  vertices with B-projection 0: %d (median |n_z| %.3f); non-zero: %d (median |n_z| %.3f)"
          % (len(flat_nz), sorted(flat_nz)[len(flat_nz) // 2], len(steep_nz), sorted(steep_nz)[len(steep_nz) // 2]))
    for nm in ("B", "A"):
        a, d = cnt.get((nm, "agree"), 0), cnt.get((nm, "disagree"), 0)
        print("  layer %s: projected axis matches the dominant horizontal normal axis for %d of %d vertices (%.1f%%)"
              % (nm, a, a + d, 100.0 * a / max(1, a + d)))

    # ---- material and lightmap coverage
    from collections import Counter
    mc = Counter()
    lmc = Counter()
    nolm = 0
    for cell in cells:
        ct = look.cell_texturing(cell)
        mc.update(ct["material"])
        if ct["lightmap"] is None:
            nolm += 1
        else:
            lmc[ct["lightmap"]["level"]] += 1
    print("\n== coverage in the default bbox: %d cells; vertex materials %s; lightmap level of cells %s; "
          "cells without lightmap %d" % (len(cells), dict(sorted(mc.items())), dict(sorted(lmc.items())), nolm))

    # ---- lightmap orientation test: lightmap value ~ a + b.n (Lambert) must fit best
    print("\n== lightmap orientation test (fit value ~ c0 + c.n over surface samples)")
    import random
    random.seed(7)
    x0, y0, x1, y1 = tc.LEVEL1_DEFAULT_BBOX
    samples = []
    while len(samples) < 1500:
        x = random.uniform(x0, x1)
        y = random.uniform(y0, y1)
        cl = T.column_cells(x, y)
        if not cl:
            continue
        V, Tri = T.cell_mesh(*cl[0])
        for (i, j, k) in Tri:
            (ax, ay, az), (bx, by, bz), (cx, cy, cz) = V[i], V[j], V[k]
            d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
            if d == 0:
                continue
            l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d
            l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d
            if min(l1, l2, 1 - l1 - l2) < 0:
                continue
            u = (bx - ax, by - ay, bz - az)
            w = (cx - ax, cy - ay, cz - az)
            n = (u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0])
            L = math.sqrt(sum(q * q for q in n))
            e = look.lightmap_for(cl[0][2][0], cl[0][2][1])
            if e is None or L == 0:
                break
            samples.append((x, y, tuple(q / L for q in n), e))
            break
    variants = {
        "recovered (u=+x, v=+y)": lambda e, x, y: look.lightmap_uv(e, x, y),
        "u flipped": lambda e, x, y: (1 - look.lightmap_uv(e, x, y)[0] + 1.0 / e["side"], look.lightmap_uv(e, x, y)[1]),
        "v flipped": lambda e, x, y: (look.lightmap_uv(e, x, y)[0], 1 - look.lightmap_uv(e, x, y)[1] + 1.0 / e["side"]),
        "transposed (u=y, v=x)": lambda e, x, y: tuple(reversed(look.lightmap_uv(e, x, y))),
        "rotated 180": lambda e, x, y: tuple(1 - q + 1.0 / e["side"] for q in look.lightmap_uv(e, x, y)),
    }
    for name, fn in variants.items():
        X = []
        Y = []
        for (x, y, n, e) in samples:
            u, v = fn(e, x, y)
            X.append([1.0, n[0], n[1], n[2]])
            Y.append(look.lightmap_value(e, u, v))
        r2, coef = _lstsq_r2(X, Y)
        cl = math.sqrt(sum(c * c for c in coef[1:]))
        print("  %-26s R^2 = %.3f   fitted light dir (unit) = (%.2f, %.2f, %.2f)"
              % (name, r2, coef[1] / cl, coef[2] / cl, coef[3] / cl))

    # ---- palette
    print("\n== lighting palette at time %.1f: ambient %s, sun front %s" % (look.time, look.ambient, look.sun))
    print("  palette[0]=%s palette[128]=%s palette[255]=%s" % (look.palette[0], look.palette[128], look.palette[255]))

    # ---- example point query
    p = look.shade(24600000, -56100000)
    print("\n== shade(24.6M, -56.1M) (base centre): z=%.1f modifiers=%s layers=%s lightmap=%s colour=%s"
          % (p["z"], p["modifiers"], [(L["material"], L["layer"], tuple(round(q, 3) for q in L["uv"]), round(L["weight"], 2))
                                      for L in p["layers"]],
             {k: (round(v, 3) if isinstance(v, float) else v) for k, v in p["lightmap"].items() if k != "rgb"},
             tuple(round(c) for c in p["colour"])))
    if png_dir:
        render_png(look, os.path.join(png_dir, "textured_base.png"), (24000000, -56700000, 25400000, -55300000), 350)
    return look


def render_png(look, path, bbox, n):
    """Full-detail colour image (no fog) of bbox, n x n pixels, +y up."""
    import zlib
    x0, y0, x1, y1 = bbox
    rows = []
    for j in range(n):
        row = bytearray()
        y = y1 - (j + 0.5) * (y1 - y0) / n
        for i in range(n):
            x = x0 + (i + 0.5) * (x1 - x0) / n
            s = look.shade(x, y)
            c = s["colour"] if s else (0, 0, 0)
            row += bytes(int(max(0, min(255, q))) for q in c)
        rows.append(row)
    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 2, 0, 0, 0))
                           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    print("wrote", path)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="terrain texturing/lighting self-check")
    ap.add_argument("--game-dir", default=GAME_DIR)
    ap.add_argument("--data", default=LEVEL1_DATA)
    ap.add_argument("--png-dir", help="also render a textured image of the base into this folder")
    a = ap.parse_args()
    self_check(a.game_dir, a.data, a.png_dir)
