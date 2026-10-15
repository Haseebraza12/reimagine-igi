#!/usr/bin/env python3
"""Decoder for Project I.G.I. (2000) runtime terrain: terrain.ctr + terrain.cmd (+ terrain.hmp).

Reference implementation for docs/terrain.md; the browser port is
web-port/src/loaders/terrain-octree.ts (tested for exact parity).
Stdlib only.  All coordinates are IGI world units (4096 units = 1 m), z up.

Format summary (see FINDINGS.md for the evidence behind every item):

* terrain.ctr is an array of 32-byte octree nodes forming a DAG.  Node 0 is a
  dummy; node 1 is the root.  The root cube is centred on the world origin
  (0, 0, 0) and is 2**31 units on a side (half-size 2**30).  A node at level L
  has half-size 2**(30-L).
    bytes  0..15  A[8]  u16  child node index per octant slot
    bytes 16..23  B[8]  s8   child transform (0..7), or -1 when the slot is a
                             leaf; for leaves A is 1 = solid (below ground),
                             0 = air, -1 = unclassified (only at depth 17)
    byte  24      mask  u8   bit s set  <=>  B[s] >= 0 (slot s has a child node)
    bytes 25..27         constant per file (64, 67, 0 for level 1); unused by
                         the code paths examined
    bytes 28..31  u32   byte offset of this node's mesh record in terrain.cmd
* Octant numbering is k = x + 2*y + 4*z (bit set = positive half).  When a node
  is reached with accumulated transform t, physical octant i is stored in slot
  PERM[t][i], and that child's accumulated transform is COMP[t][B[slot]].
* Transform t (dihedral group D4, acting in the horizontal plane only):
  mirror x if t & 4, then rotate counter-clockwise by (t & 3) * 90 degrees.
* terrain.cmd records: u16 ntri, u16 tri_bytes(=4*ntri), u16 nbase, u16 nextra,
  then ntri x {u8 i0, u8 i1, u8 i2, u8 flags}, then (nbase + nextra) u32
  vertices.  Vertex bit fields:
      bits 26..31  x + 24      bits 20..25  y + 24      bits 14..19  z + 24
      bits  0..5   (extra vertices only) index of the base vertex the vertex
                   morphs to at the coarser LOD
      bits  6..9   texture-projection selectors (not geometry)
  so local coordinates are integers in [-24, 24] (always even).  World:
      p = node_centre + R_t(x, y, z) * 2**(27-L) / 3
  (24 * 2**(27-L) / 3 == 2**(30-L), the node half-size).
* The game renders and collides at most at level 16 (8 m cells).  Depth-17
  nodes exist in the file but are never reached by the paths examined.
* HeightMap tasks (from objects.qvm, not the terrain files) add detail relief
  from terrain.hmp to vertices of level >= 15 cells inside the level-`Level`
  node that contains the task position:
      dz = (bilinear(hmp[bitmap_id], (x - x0)/cell, (y - y0)/cell) - 64) * 256
  where (x0, y0) is that node's minimum corner, cell = node_size / Size, and
  the hmp bytes are read as signed char, row stride Size + 1.
"""
import json
import math
import os
import struct
import sys

ROOT_HALF = 1 << 30            # root half-size; root centred on (0, 0, 0)
GAME_MAX_LEVEL = 16            # deepest level used by the renderer / collision
MIN_EMIT_LEVEL = 7             # the renderer never emits meshes coarser than this

# igi.exe 0x545e48: slot used for physical octant i under transform t.
PERM = [[0, 1, 2, 3, 4, 5, 6, 7], [2, 0, 3, 1, 6, 4, 7, 5],
        [3, 2, 1, 0, 7, 6, 5, 4], [1, 3, 0, 2, 5, 7, 4, 6],
        [1, 0, 3, 2, 5, 4, 7, 6], [3, 1, 2, 0, 7, 5, 6, 4],
        [2, 3, 0, 1, 6, 7, 4, 5], [0, 2, 1, 3, 4, 6, 5, 7]]


def _build_comp():
    """Transform composition table, generated exactly as igi.exe FUN_004c5f40
    fills 0xab8920: COMP[parent_t][child_B] -> child accumulated transform."""
    table = []
    for row in range(8):
        out = []
        for j in range(8):
            b6 = j
            b3 = j
            if row >= 4:
                b3 = (-j) & 0xFF
                b6 = (~j) & 0xFF
            out.append(((b3 + row) & 3) + (b6 & 4))
        table.append(out)
    return table


COMP = _build_comp()


def xform(t, lx, ly):
    """Apply transform t to local (x, y) (as in igi.exe FUN_00509250)."""
    if t & 4:
        lx = -lx
    r = t & 3
    if r == 0:
        return lx, ly
    if r == 1:
        return -ly, lx
    if r == 2:
        return -lx, -ly
    return ly, -lx


# Level-1 HeightMap tasks as stored in objects.qvm (Task_New "HeightMap"); the
# validation below re-reads them from the file (tools/level_tasks.py).
LEVEL1_HEIGHTMAPS = [
    {"position": (22128590.0, -57264816.0, 174634432.0), "level": 11, "size": 128, "bitmap_id": 0},
    {"position": (22735164.0, -56375428.0, 174696704.0), "level": 11, "size": 128, "bitmap_id": 1},
    {"position": (23335550.0, -56157360.0, 174594512.0), "level": 11, "size": 128, "bitmap_id": 2},
]
# Default full-detail region for level 1: extent of the objects.qvm placements and
# AI graph nodes (x 22.06M..26.02M, y -60.99M..-55.56M), padded by 2**20 (256 m) and
# snapped outward to the level-16 grid (2**15).  This is level-specific.
LEVEL1_DEFAULT_BBOX = (21004288, -62062592, 27066368, -54493184)


class Terrain:
    """Parsed terrain.  ctr/cmd are required; hmp + heightmaps are optional."""

    def __init__(self, ctr_bytes, cmd_bytes, hmp_bytes=None, heightmaps=None):
        if len(ctr_bytes) % 32:
            raise ValueError("terrain.ctr size is not a multiple of 32")
        self.cmd = bytes(cmd_bytes)
        n = len(ctr_bytes) // 32
        self.child = []     # per node: tuple of 8 child indices
        self.tr = []        # per node: tuple of 8 transforms (-1 = leaf)
        self.mask = []
        self.rec = []       # cmd byte offset
        for i in range(n):
            o = i * 32
            self.child.append(struct.unpack_from("<8H", ctr_bytes, o))
            self.tr.append(struct.unpack_from("<8b", ctr_bytes, o + 16))
            self.mask.append(ctr_bytes[o + 24])
            self.rec.append(struct.unpack_from("<I", ctr_bytes, o + 28)[0])
        self._rec_cache = {}
        self._local_cache = {}
        self.regions = []
        if hmp_bytes is not None and heightmaps:
            self._setup_heightmaps(hmp_bytes, heightmaps)

    # ----------------------------------------------------------------- hmp
    def _setup_heightmaps(self, hmp, heightmaps):
        hdr = [struct.unpack_from("<3I", hmp, 12 * i) for i in range(256)]
        bodies = {}
        p = 0xC00
        for i, (_ptr, _flag, side) in enumerate(hdr):
            if side:
                s = side + 1
                bodies[i] = (hmp[p:p + s * s], side)
                p += s * s
        for hm in heightmaps:
            bid = hm["bitmap_id"]
            if bid not in bodies:
                continue          # the game skips a HeightMap whose bitmap is absent
            data, side = bodies[bid]
            level = hm["level"]
            size = hm["size"]
            if side != size:
                raise ValueError("HeightMap size %d != hmp side %d" % (size, side))
            full = 2 * (ROOT_HALF >> level)
            px, py = hm["position"][0], hm["position"][1]
            x0 = int(px) & ~(full - 1)      # node containing the task (floor)
            y0 = int(py) & ~(full - 1)
            self.regions.append({"box": (x0, y0, x0 + full, y0 + full), "origin": (x0, y0),
                                 "cell": full / size, "stride": size + 1, "data": data,
                                 "bitmap_id": bid})

    @staticmethod
    def _hmp_sample(r, x, y):
        data = r["data"]
        st = r["stride"]
        gx = (x - r["origin"][0]) / r["cell"]
        gy = (y - r["origin"][1]) / r["cell"]
        ix = int(gx)                       # x87 in chop mode: truncation
        iy = int(gy)
        fx = gx - ix
        fy = gy - iy

        def b(k):
            v = data[k] if 0 <= k < len(data) else 64   # outside: treat as neutral
            return v - 256 if v > 127 else v
        s00 = b(iy * st + ix)
        s01 = b(iy * st + ix + 1)
        s10 = b((iy + 1) * st + ix)
        s11 = b((iy + 1) * st + ix + 1)
        top = s00 + (s01 - s00) * fx
        bot = s10 + (s11 - s10) * fx
        return ((top + (bot - top) * fy) - 64.0) * 256.0

    def _region_for(self, cx, cy):
        for r in self.regions:
            x0, y0, x1, y1 = r["box"]
            if x0 <= cx < x1 and y0 <= cy < y1:
                return r
        return None

    # ----------------------------------------------------------------- cmd
    def record(self, off):
        """(list of (x, y, z) local ints, list of (i0, i1, i2, flags))."""
        r = self._rec_cache.get(off)
        if r is None:
            cmd = self.cmd
            ntri, tbytes, nbase, nextra = struct.unpack_from("<4H", cmd, off)
            tri = off + 8
            vp = tri + tbytes
            verts = []
            for k in range(nbase + nextra):
                v = struct.unpack_from("<I", cmd, vp + 4 * k)[0]
                verts.append((((v >> 26) & 63) - 24, ((v >> 20) & 63) - 24, ((v >> 14) & 63) - 24))
            tris = [tuple(cmd[tri + 4 * k:tri + 4 * k + 4]) for k in range(ntri)]
            r = (verts, tris)
            self._rec_cache[off] = r
        return r

    def _local(self, off, t):
        key = (off, t)
        r = self._local_cache.get(key)
        if r is None:
            verts, tris = self.record(off)
            lv = []
            for (lx, ly, lz) in verts:
                X, Y = xform(t, lx, ly)
                lv.append((X, Y, lz))
            if t & 4:      # mirrored: flip winding to keep counter-clockwise-from-above
                lt = [(a, c, b) for (a, b, c, _f) in tris]
            else:
                lt = [(a, b, c) for (a, b, c, _f) in tris]
            r = (lv, lt)
            self._local_cache[key] = r
        return r

    def cell_mesh(self, node, level, centre, t):
        """World-space vertices and triangles of one emitted node."""
        lv, lt = self._local(self.rec[node], t)
        sc = (1 << (27 - level)) / 3.0
        cx, cy, cz = centre
        V = [(cx + X * sc, cy + Y * sc, cz + Z * sc) for (X, Y, Z) in lv]
        if self.regions and level >= 15:          # game: z += dz only for level > 14
            r = self._region_for(cx, cy)
            if r is not None:
                V = [(x, y, z + self._hmp_sample(r, x, y)) for (x, y, z) in V]
        return V, lt

    # ----------------------------------------------------------- traversal
    def _children(self, node, level, centre, t):
        h = ROOT_HALF >> (level + 1)
        cx, cy, cz = centre
        m = self.mask[node]
        A = self.child[node]
        B = self.tr[node]
        P = PERM[t]
        for i in range(8):
            s = P[i]
            if m & (1 << s):
                yield (A[s], level + 1,
                       (cx + h if i & 1 else cx - h, cy + h if i & 2 else cy - h, cz + h if i & 4 else cz - h),
                       COMP[t][B[s]])

    def column_cells(self, x, y, max_level=GAME_MAX_LEVEL):
        """All emitted cells whose xy footprint contains (x, y)."""
        out = []
        stack = [(1, 0, (0, 0, 0), 0)]
        while stack:
            node, level, c, t = stack.pop()
            if level >= max_level or self.mask[node] == 0:
                out.append((node, level, c, t))
                continue
            for ch in self._children(node, level, c, t):
                cc = ch[2]
                if (x >= c[0]) == (cc[0] > c[0]) and (y >= c[1]) == (cc[1] > c[1]):
                    stack.append(ch)
        return out

    def heights_at(self, x, y, max_level=GAME_MAX_LEVEL):
        """Sorted z of every terrain surface crossing the vertical line at (x, y)."""
        res = []
        for cell in self.column_cells(x, y, max_level):
            V, T = self.cell_mesh(*cell)
            for (i, j, k) in T:
                x1, y1, z1 = V[i]
                x2, y2, z2 = V[j]
                x3, y3, z3 = V[k]
                d = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3)
                if d == 0:
                    continue
                l1 = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / d
                l2 = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / d
                l3 = 1.0 - l1 - l2
                e = -1e-9
                if l1 >= e and l2 >= e and l3 >= e:
                    res.append(l1 * z1 + l2 * z2 + l3 * z3)
        res.sort()
        out = []
        for z in res:                 # merge duplicates from shared edges
            if not out or abs(z - out[-1]) > 1e-3:
                out.append(z)
        return out

    def height_at(self, x, y, z_hint=None, max_level=GAME_MAX_LEVEL):
        """h(x, y): highest surface, or the surface nearest z_hint.  None if none."""
        hs = self.heights_at(x, y, max_level)
        if not hs:
            return None
        if z_hint is None:
            return hs[-1]
        return min(hs, key=lambda h: abs(h - z_hint))

    def iter_cells(self, bbox, max_level=GAME_MAX_LEVEL, lod_factor=3.0, far_extent=0):
        """Cells to emit: full detail (max_level) for cells touching bbox; outside
        it, if far_extent > 0, a cell is emitted once its Chebyshev distance to
        bbox is >= lod_factor * cell size (never coarser than level 7); cells
        farther than far_extent from bbox are dropped."""
        bx0, by0, bx1, by1 = bbox
        stack = [(1, 0, (0, 0, 0), 0)]
        while stack:
            node, level, c, t = stack.pop()
            h = ROOT_HALF >> level
            dx = max(bx0 - (c[0] + h), (c[0] - h) - bx1, 0)
            dy = max(by0 - (c[1] + h), (c[1] - h) - by1, 0)
            d = max(dx, dy)
            if d > 0 and (far_extent <= 0 or d > far_extent):
                continue
            if level >= max_level or self.mask[node] == 0:
                yield (node, level, c, t)
                continue
            if d > 0 and level >= MIN_EMIT_LEVEL and d >= lod_factor * 2 * h:
                yield (node, level, c, t)
                continue
            stack.extend(self._children(node, level, c, t))

    def mesh(self, bbox, max_level=GAME_MAX_LEVEL, lod_factor=3.0, far_extent=0, dedupe=True):
        vid = {}
        verts = []
        tris = []
        cells = 0
        levels = {}
        for cell in self.iter_cells(bbox, max_level, lod_factor, far_extent):
            cells += 1
            levels[cell[1]] = levels.get(cell[1], 0) + 1
            V, T = self.cell_mesh(*cell)
            idx = []
            for p in V:
                if dedupe:
                    key = (round(p[0] * 1024), round(p[1] * 1024), round(p[2] * 1024))
                    k = vid.get(key)
                    if k is None:
                        k = len(verts)
                        vid[key] = k
                        verts.append([p[0], p[1], p[2]])
                else:
                    k = len(verts)
                    verts.append([p[0], p[1], p[2]])
                idx.append(k)
            for (a, b, cc) in T:
                ia, ib, ic = idx[a], idx[b], idx[cc]
                if ia != ib and ib != ic and ia != ic:
                    tris.append([ia, ib, ic])
        return verts, tris, cells, levels


def decode_terrain(ctr_bytes, cmd_bytes, **extra):
    """Decode terrain.ctr + terrain.cmd into a world-space triangle mesh.

    extra (all optional):
      bbox=(xmin, ymin, xmax, ymax)  full-detail region (default: LEVEL1_DEFAULT_BBOX)
      max_level=16                   finest level (the game uses 16)
      far_extent=0                   also emit coarser LOD cells up to this distance
                                     (IGI units) outside bbox; 0 = bbox only
      lod_factor=3.0                 LOD ring spacing (in cell sizes)
      hmp_bytes=None, heightmaps=None  apply HeightMap relief (heightmaps: list of
                                     {"position", "level", "size", "bitmap_id"};
                                     LEVEL1_HEIGHTMAPS holds level 1's)
      dedupe=True                    merge coincident vertices
    Returns {"vertices": [[x,y,z],...], "triangles": [[i,j,k],...], "notes": str,
             "stats": {...}}.  Triangles wind counter-clockwise seen from +z for
             upward-facing surfaces.
    """
    bbox = tuple(extra.get("bbox") or LEVEL1_DEFAULT_BBOX)
    max_level = int(extra.get("max_level", GAME_MAX_LEVEL))
    far_extent = extra.get("far_extent", 0)
    lod_factor = float(extra.get("lod_factor", 3.0))
    heightmaps = extra.get("heightmaps")
    hmp = extra.get("hmp_bytes")
    terr = Terrain(ctr_bytes, cmd_bytes, hmp, heightmaps)
    verts, tris, cells, levels = terr.mesh(bbox, max_level, lod_factor, far_extent,
                                           extra.get("dedupe", True))
    notes = ("IGI world units (4096 = 1 m), z up. Octree root centred at origin, size 2^31. "
             "Cells inside bbox at level %d; %s. HeightMap relief %s. Default bbox is level-1 "
             "specific (from objects.qvm placements); pass bbox for other levels. "
             "No crack fixing between cells of different levels (the game hides LOD seams by "
             "geomorphing)." % (max_level,
                                "LOD ring to %s units outside bbox" % far_extent if far_extent else "nothing outside bbox",
                                "applied to %d region(s)" % len(terr.regions) if terr.regions else "not applied"))
    return {"vertices": verts, "triangles": tris, "notes": notes,
            "stats": {"cells": cells, "cells_per_level": levels, "bbox": list(bbox)}}


# ======================================================================= validation
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_LEVEL_DIR = os.path.join(_REPO, "Game Files", "missions", "location0", "level1")
_TERRAIN_DIR = os.path.join(_LEVEL_DIR, "terrain")


def level1_samples(level_dir=_LEVEL_DIR):
    """World-position samples from the original files: positioned objects.qvm
    tasks plus AI graph nodes (graph position + node offset)."""
    import glob
    import re
    sys.path.insert(0, os.path.join(_REPO, "tools", "pipeline"))
    import level_tasks
    import nav_build
    tasks = level_tasks.read_tasks(open(os.path.join(level_dir, "objects.qvm"), "rb").read())
    samples = []
    for t in tasks:
        p = t["params"]
        pos = p.get("Position") or p.get("Position start")
        if isinstance(pos, list) and len(pos) == 3 and t["type"] in (
                "Building", "EditRigidObj", "Door", "HumanPlayer", "HumanSoldier", "TerrainLightMap",
                "TextureModifier", "HeightMap", "GunPickup", "AmmoPickup", "Fence", "Car", "ExplodeObject",
                "Switch", "Terminal", "AlarmControl", "SplineObjWaypoint"):
            samples.append({"type": t["type"], "model": p.get("Model") or p.get("Waypoint Model") or "", "pos": pos})
    graph_pos = {t["id"]: t["params"]["Graph position"] for t in tasks if t["type"] == "AIGraph"}
    for path in sorted(glob.glob(os.path.join(level_dir, "graphs", "graph*.dat"))):
        gid = int(re.search(r"graph(\d+)", path).group(1))
        if gid not in graph_pos:
            continue
        gx, gy, gz = graph_pos[gid]
        for n in nav_build.parse_graph(path, "graph%d" % gid)["nodes"]:
            x, y, z = n["position"]
            samples.append({"type": "AIGraphNode", "pos": [gx + x, gy + y, gz + z]})
    return samples


def _q(v, p):
    if not v:
        return float("nan")
    v = sorted(v)
    return v[min(len(v) - 1, int(round(p * (len(v) - 1))))]


def _fmt(v):
    a = [abs(x) for x in v]
    n = len(a)
    if not n:
        return "n=0"
    return ("n=%d |res| median=%.0f p90=%.0f max=%.0f (units) | <=1cm %d (%.0f%%), <=5cm %d, <=0.25m %d (%.0f%%)"
            % (n, _q(a, .5), _q(a, .9), max(a), sum(x <= 41 for x in a), 100.0 * sum(x <= 41 for x in a) / n,
               sum(x <= 205 for x in a), sum(x <= 1024 for x in a), 100.0 * sum(x <= 1024 for x in a) / n))


def _validate(terrain_dir, samples_path=None, use_hmp=True):
    ctr = open(os.path.join(terrain_dir, "terrain.ctr"), "rb").read()
    cmd = open(os.path.join(terrain_dir, "terrain.cmd"), "rb").read()
    hmp = open(os.path.join(terrain_dir, "terrain.hmp"), "rb").read()
    level_dir = os.path.dirname(os.path.abspath(terrain_dir))
    S = json.load(open(samples_path)) if samples_path else level1_samples(level_dir)
    sys.path.insert(0, os.path.join(_REPO, "tools"))
    import level_tasks
    heightmaps = level_tasks.terrain_inputs(open(os.path.join(level_dir, "objects.qvm"), "rb").read(),
                                            open(os.path.join(terrain_dir, "terrain.qvm"), "rb").read())["heightmaps"]
    T = Terrain(ctr, cmd, hmp if use_hmp else None, heightmaps if use_hmp else None)
    T0 = Terrain(ctr, cmd)
    print("terrain: %d nodes, %d bytes cmd; HeightMap regions applied: %d" % (len(T.child), len(cmd), len(T.regions)))
    print("residual = sample z - decoded terrain z (surface nearest the sample in that column)")
    groups = {}
    excluded = 0
    nocov = {}
    rows = []
    for s in S:
        x, y, z = s["pos"]
        if s["type"] == "AIGraphNode" and z < 1e8:
            excluded += 1          # graph-local coordinates, not world positions
            continue
        hs = T.heights_at(x, y)
        if not hs:
            nocov[s["type"]] = nocov.get(s["type"], 0) + 1
            continue
        best = min(hs, key=lambda h: abs(h - z))
        r = z - best
        rows.append((s, r))
        groups.setdefault(s["type"], []).append(r)
    print("excluded %d AIGraphNode samples with graph-local coordinates (z < 1e8); uncovered: %s"
          % (excluded, nocov or "none"))
    print()
    for k in ("AIGraphNode", "TerrainLightMap", "Building", "EditRigidObj", "HumanSoldier", "HumanPlayer",
              "Door", "Fence", "Car"):
        if k in groups:
            print("%-16s %s" % (k, _fmt(groups[k])))
    other = [r for k, v in groups.items() if k not in ("AIGraphNode", "TerrainLightMap", "Building",
                                                         "EditRigidObj", "HumanSoldier", "HumanPlayer",
                                                         "Door", "Fence", "Car") for r in v]
    print("%-16s %s" % ("other types", _fmt(other)))
    ai = groups.get("AIGraphNode", [])
    if ai:
        on = sum(abs(r) <= 1024 for r in ai)
        above = sum(r > 1024 for r in ai)
        below = [r for r in ai if r < -1024]
        print("\nAIGraphNode lower-envelope check: on terrain (|res|<=0.25m) %d, above it (floors/roofs) %d, "
              "below it by >0.25m %d %s" % (on, above, len(below), [round(r) for r in below]))
    # ground-standing objects: soldiers, player, EditRigidObj, with per-model pivot offset removed
    by_model = {}
    for s, r in rows:
        if s["type"] in ("EditRigidObj", "HumanSoldier", "HumanPlayer") and s["pos"][2] > 1.7e8:
            by_model.setdefault((s["type"], s.get("model")), []).append(r)
    corr = []
    for k, v in by_model.items():
        if len(v) >= 3:
            m = _q(v, .5)
            corr += [r - m for r in v]
    print("ground objects (EditRigidObj/HumanSoldier/HumanPlayer, models with >=3 instances), "
          "per-model median offset removed:\n                 %s" % _fmt(corr))
    lowenv = [r for s, r in rows if s["type"] in ("EditRigidObj", "HumanSoldier", "HumanPlayer")
              and s["pos"][2] > 1.7e8]
    print("same objects, raw: %s; sample above terrain: %d, below by >0.25m: %d"
          % (_fmt(lowenv), sum(r > 1024 for r in lowenv), sum(r < -1024 for r in lowenv)))
    underground = [(s["type"], s.get("model"), round(r)) for s, r in rows if r < -1e6]
    print("samples > 244 m below the surface (inside an underground structure at z~161.16M): %s" % underground)

    # HeightMap effect on samples inside the HeightMap nodes
    if T.regions:
        a, b = [], []
        for s, r in rows:
            x, y, z = s["pos"]
            if T._region_for(x, y) and s["type"] == "EditRigidObj":
                a.append(r)
                b.append(z - T0.height_at(x, y, z))
        def spread(v):
            m = _q(v, .5)
            return _q([abs(x - m) for x in v], .5)
        print("\nEditRigidObj inside HeightMap nodes (n=%d): |res|<=1cm with hmp %d vs without %d; "
              "median |res - median| %.0f vs %.0f" % (len(a), sum(abs(x) <= 41 for x in a),
                                                       sum(abs(x) <= 41 for x in b), spread(a), spread(b)))

    # flat base check
    bx = [s["pos"] for s in S if s["type"] == "Building" and abs(s["pos"][2] - 174413136) < 1]
    x0, x1 = min(p[0] for p in bx), max(p[0] for p in bx)
    y0, y1 = min(p[1] for p in bx), max(p[1] for p in bx)
    zs = []
    for i in range(21):
        for j in range(21):
            zz = T.height_at(x0 + (x1 - x0) * i / 20, y0 + (y1 - y0) * j / 20)
            zs.append(zz)
    from collections import Counter
    c = Counter(round(z, 2) for z in zs)
    print("\nflat base: 21x21 grid over the building footprint x[%d..%d] y[%d..%d]:" % (x0, x1, y0, y1))
    print("  decoded z values (count): %s" % sorted(c.items(), key=lambda kv: -kv[1])[:6])
    print("  exact level-16 value 255488*2048/3 = %.2f; as float32 -> %d (matches building z 174413136)"
          % (255488 * 2048 / 3, struct.unpack("<f", struct.pack("<f", 255488 * 2048 / 3))[0]))

    # discriminative check: perturbed semantics must fail
    tl = [s for s in S if s["type"] == "TerrainLightMap"]

    def tl_pass(t):
        return sum(1 for s in tl if (lambda hs: hs and min(abs(h - s["pos"][2]) for h in hs) <= 1024)(t.heights_at(*s["pos"][:2])))
    global xform
    good = xform
    print("\nfalsification (TerrainLightMap tiles within 0.25 m, %d tiles):" % len(tl))
    print("  recovered semantics            %d" % tl_pass(T0))
    for name, f in (("rotation direction reversed", lambda t, a, b: good((t & 4) | ((4 - (t & 3)) & 3), a, b)),
                    ("mirror bit ignored", lambda t, a, b: good(t & 3, a, b)),
                    ("x/y vertex fields swapped", lambda t, a, b: good(t, b, a))):
        xform = f
        print("  %-30s %d" % (name, tl_pass(Terrain(ctr, cmd))))
    xform = good


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--terrain-dir", default=_TERRAIN_DIR)
    ap.add_argument("--samples", help="JSON list of {type, pos}; default: read from objects.qvm + graphs")
    ap.add_argument("--no-hmp", action="store_true", help="validate without HeightMap relief")
    ap.add_argument("--mesh-json", help="also write the decoded default-bbox mesh to this JSON file")
    ap.add_argument("--far-extent", type=float, default=0)
    a = ap.parse_args()
    _validate(a.terrain_dir, a.samples, not a.no_hmp)
    if a.mesh_json:
        d = a.terrain_dir
        res = decode_terrain(open(os.path.join(d, "terrain.ctr"), "rb").read(),
                             open(os.path.join(d, "terrain.cmd"), "rb").read(),
                             hmp_bytes=open(os.path.join(d, "terrain.hmp"), "rb").read(),
                             heightmaps=LEVEL1_HEIGHTMAPS, far_extent=a.far_extent)
        with open(a.mesh_json, "w") as f:
            json.dump(res, f)
        print("\nwrote %s: %d vertices, %d triangles, %s" % (a.mesh_json, len(res["vertices"]),
                                                          len(res["triangles"]), res["stats"]))
