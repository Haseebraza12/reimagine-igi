#!/usr/bin/env python3
"""Collision meshes and surface materials of Project I.G.I. (igi.exe, 2000).

Run from the repository root (stdlib only; nothing is executed or copied):

    python tools/igi_collision.py              # validate + print every table
    python tools/igi_collision.py --hull       # + measure the set-1 hull offset
    python tools/igi_collision.py --png DIR    # + top/side preview PNGs of a few models
    python tools/igi_collision.py --json       # machine-readable report

Inputs: ``Game Files/igi.exe``, the model archives
``missions/location0/level1/models/level1.res`` and
``missions/location0/common/models/location0.res`` (601 ``.mef`` files),
``material/material.qvm``, ``missions/location0/level1/objects.qvm`` and
``.../terrain/terrain.qvm`` + ``terrain.bit``.

Evidence labels (as in docs/collision.md):
  observed   measured over the data files by this script
  recovered  read from igi.exe code; the quoted instruction bytes and
             constants are verified against the executable by the checks below
  inferred   interpretation the traced code does not prove

Model collision (``.mef`` chunks HSMC + 2 x {XTVC ECFC TAMC HPSC}):
  HSMC   2 x 32 bytes {u32 faces, verts, surfaces, spheres, 4 x u32 0}; the
         loader at 0x53025b stores the chunk pointers at +0x10 (ECFC), +0x14
         (XTVC), +0x18 (TAMC), +0x1c (HPSC) of each 32-byte header, so a set
         is 0x20 bytes at model+0x2c + 0x20 * set.
  XTVC   16 bytes: f32 x, y, z, u32 bone (bone models; 0 elsewhere).
  ECFC   8 bytes: u16 a, b, c, u16 surface (TAMC index).
  TAMC   12 bytes: f32 transparency (not read by the ray code), i16 portal id
         (>= 0: portal polygon, skipped by every traced query), i16 texture
         slot (the faces duplicate that slot's render triangles), u16 game
         material (SetActiveMaterial index; 0xffff = none), u16 garbage.
  HPSC   24 bytes: f32 centre xyz, radius, u16 first face, u16 face count,
         u16 first child, u16 next sibling: a bounding-sphere tree stored
         first-child / next-sibling, node 0 = root, 2 x faces - 1 nodes.
  Set 0  is read by bullets, line of sight and every ray built with
         FUN_004c24c0 (query word 5 = 0); set 1 (material HumanCollision,
         drawn ~0.2 m outside the walls) by the character wall sweep and the
         ground probe (FUN_004c3d40 / FUN_004c2060 called with 1).
"""
import argparse
import collections
import hashlib
import json
import math
from pathlib import Path
import struct
import sys
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parent))
from igi_formats import FormatError, align_up, pe_sections, resource_members  # noqa: E402
from igi_qvm import QVM  # noqa: E402
from level_tasks import read_tasks, terrain_script  # noqa: E402

GAME = Path("Game Files")
EXE_SHA256 = "2b1673443e2635d97787344da5fab9d1ac6b717d34d18c5bab7f30749b1174c2"
UNITS_PER_METRE = 4096.0
LEVEL = "missions/location0/level1"
ARCHIVES = [f"{LEVEL}/models/level1.res", "missions/location0/common/models/location0.res"]
NO_MATERIAL = 0xFFFF
#: material index used by the ray code when TAMC says 0xffff (FUN_004b7a60 0x4b8eea: world+0xd40 = table[1])
UNTAGGED_RAY_MATERIAL = 1

# ---------------------------------------------------------------------------
# igi.exe evidence
# ---------------------------------------------------------------------------


class Exe:
    def __init__(self, data):
        self.data = data
        self.info = pe_sections(data)

    def offset(self, va):
        for s in self.info["sections"]:
            if s["va"] <= va < s["va"] + max(s["virtual_size"], s["raw_size"]):
                rel = va - s["va"]
                if rel >= s["raw_size"]:
                    raise FormatError(f"VA {va:#x} is in uninitialised data")
                return s["raw_offset"] + rel
        raise FormatError(f"VA {va:#x} outside every section")

    def read(self, va, n):
        o = self.offset(va)
        return self.data[o:o + n]

    def f32(self, va):
        return struct.unpack("<f", self.read(va, 4))[0]

    def f64(self, va):
        return struct.unpack("<d", self.read(va, 8))[0]


# (virtual address, exact bytes, function, meaning)
CODE_EVIDENCE = [
    (0x53025B, "6848534d43", "MEF loader", "push 'HSMC'; two 32-byte set headers follow"),
    (0x5302A5, "6858545643", "MEF loader", "per set: 'XTVC' -> header+0x14"),
    (0x5302BE, "6845434643", "MEF loader", "per set: 'ECFC' -> header+0x10"),
    (0x5302DB, "6854414d43", "MEF loader", "per set: 'TAMC' -> header+0x18"),
    (0x5302FA, "6848505343", "MEF loader", "per set: 'HPSC' -> header+0x1c"),
    (0x4C3F91, "8b4d28", "FUN_004c3d40 multi-ray query", "query word 5 (collision set) = argument 9 ..."),
    (0x4C3FB7, "894db4", "FUN_004c3d40", "... stored at [ebp-0x4c]"),
    (0x4C2734, "8975b4", "FUN_004c24c0 ray query (bullets, LOS terrain)", "collision set = 0 (esi zeroed at 0x4c2711)"),
    (0x46097D, "6a01", "FUN_004606b0 wall sweep", "push 1: sweep uses collision set 1"),
    (0x461368, "6a01", "FUN_00460fd0 ground probe", "push 1: ground rays use collision set 1"),
    (0x4B7AC0, "8b4714", "FUN_004b7a60 rigid ray handler (methods 9/10)", "set = query word 5 ..."),
    (0x4B7AC3, "8b512c", "FUN_004b7a60", "... model+0x2c (HSMC) ..."),
    (0x4B7AC6, "c1e005", "FUN_004b7a60", "... + set x 32"),
    (0x4B84C0, "66817c8204ffff", "FUN_004b7a60", "face skipped unless TAMC+4 (portal) == -1 or query word 6 set"),
    (0x4B8EDC, "668b5208", "FUN_004b7a60", "hit material = TAMC+8 ..."),
    (0x4B8EEA, "8bba400d0000", "FUN_004b7a60", "... 0xffff -> world material table[1] (Ground)"),
    (0x4B8EFB, "8bbc973c0d0000", "FUN_004b7a60", "... else world+0xd3c + 4 x material"),
    (0x4B9867, "8b582c", "FUN_004b9810 rigid line-of-sight handler (method 8)", "always HSMC set 0"),
    (0x4BA07E, "66817c8304ffff", "FUN_004b9810", "portal faces skipped"),
    (0x4BA70C, "d902d84918d95918", "FUN_004b9810", "front-face hit: transmission x= material+0 (QMaterial arg 0)"),
    (0x4BA728, "c7411800000000", "FUN_004b9810", "opaque (or untagged) material: transmission = 0"),
    (0x487F91, "d81d18225300", "FUN_00487f40 AI sight ray", "blocked ray still visible if transmission >= 0.79"),
    (0x51D680, "33c0c3", "FUN_0051d680 face accept", "always 0: no texture/alpha test on collision faces"),
    (0x4084A9, "be80535600", "FUN_004084a0", "world material table[i] = 0x565380 + i x 0x268 ..."),
    (0x4084B9, "81c668020000", "FUN_004084a0", "... record stride 0x268, 32 entries"),
    (0x4BC8B6, "898720edbc00", "CreateTerrainMaterial handler 0x4bc890", "arg 1 stored at record+0 (stride 900)"),
    (0x4C1C04, "8a049520edbc00", "FUN_004c1a30 terrain material", "returns byte arg 1 of the terrain material"),
    (0x4C1BAA, "d81da4165300", "FUN_004c1a30", "TextureModifier bilinear mask value >= 0.3 selects it"),
    (0x4C19E6, "8b848a3c0d0000", "FUN_004c1270 column query", "terrain hit material = world table[lookup]"),
    (0x4966D7, "66810ddcb86800000c", "FUN_004966d0", "FPU rounding control = chop (FISTP truncates)"),
    (0x4609C0, "dc2578195300", "FUN_004606b0", "sweep rays are extended by 10.24 units (0x531978)"),
]

# (VA, type, expected, meaning)
CONSTANTS = [
    (0x531978, "f64", 10.24, "sweep skin: ray extension and push-out (units)"),
    (0x531418, "f64", 409.6, "probe height 0.1 m above the feet"),
    (0x531478, "f64", 1638.4, "probe height 0.4 m (standing); ground ray start"),
    (0x531970, "f64", 819.2, "probe height 0.2 m (crouched); ground ray start"),
    (0x531960, "f64", 7372.8, "probe height 1.8 m (standing)"),
    (0x531968, "f64", 5324.8, "probe height 1.3 m (crouched)"),
    (0x5313C8, "f32", 0.1, "|normal z| below this = wall"),
    (0x53195C, "f32", 0.9999, "low-probe floor (step) normal z"),
    (0x531988, "f64", 204.8, "material re-cast starts 5 cm above the ground hit"),
    (0x531460, "f64", 2048.0, "material re-cast length 0.5 m"),
    (0x5316A4, "f32", 0.3, "TextureModifier bilinear threshold"),
    (0x532218, "f32", 0.79, "AI sight: minimum transmission"),
]

# ---------------------------------------------------------------------------
# .mef collision decoding
# ---------------------------------------------------------------------------


def mef_chunks(data, where):
    """Walk the OCEM ILFF chunk chain; returns [(tag, payload offset, size)]."""
    if len(data) < 20 or data[:4] != b"ILFF" or data[16:20] != b"OCEM":
        raise FormatError(f"{where}: not an ILFF/OCEM model")
    if struct.unpack_from("<I", data, 4)[0] != len(data):
        raise FormatError(f"{where}: root size does not match the file length")
    pos = align_up(20, struct.unpack_from("<I", data, 8)[0])
    out = []
    while True:
        if pos + 16 > len(data):
            raise FormatError(f"{where}: truncated chunk header at {pos:#x}")
        tag = data[pos:pos + 4].decode("latin1")
        size, alignment, delta = struct.unpack_from("<3I", data, pos + 4)
        payload = align_up(pos + 16, alignment)
        if payload + size > len(data):
            raise FormatError(f"{where}: chunk {tag} at {pos:#x} runs past the file")
        out.append((tag, payload, size))
        if delta == 0:
            if payload + size != len(data):
                raise FormatError(f"{where}: bytes after the final chunk {tag} at {pos:#x}")
            return out
        if pos + delta < payload + size:
            raise FormatError(f"{where}: chunk {tag} at {pos:#x} overlaps its successor")
        pos += delta


def model_type(data, chunks, where):
    hsem = [c for c in chunks if c[0] == "HSEM"]
    if len(hsem) != 1 or hsem[0][2] < 36:
        raise FormatError(f"{where}: missing HSEM")
    return struct.unpack_from("<I", data, hsem[0][1] + 32)[0]


def read_collision(data, where, game_materials=24):
    """Decode HSMC + 2 x (XTVC ECFC TAMC HPSC). Returns None when the model has no HSMC.

    Every count, index and the sphere tree are validated; errors name the file offset."""
    chunks = mef_chunks(data, where)
    mtype = model_type(data, chunks, where)
    tags = [c[0] for c in chunks]
    if "HSMC" not in tags:
        if any(t in tags for t in ("XTVC", "ECFC", "TAMC", "HPSC")):
            raise FormatError(f"{where}: collision chunks without HSMC")
        return None
    h = tags.index("HSMC")
    expect = ["HSMC"] + ["XTVC", "ECFC", "TAMC", "HPSC"] * 2
    if tags[h:h + 9] != expect:
        raise FormatError(f"{where}: collision chunk order {tags[h:h + 9]} at {chunks[h][1]:#x}")
    hsmc = chunks[h]
    if hsmc[2] != 64:
        raise FormatError(f"{where}: HSMC at {hsmc[1]:#x} is {hsmc[2]} bytes, expected 2 x 32")
    sets = []
    for k in range(2):
        hdr = struct.unpack_from("<8I", data, hsmc[1] + 32 * k)
        nf, nv, nm, ns = hdr[:4]
        if any(hdr[4:]):
            raise FormatError(f"{where}: HSMC set {k} header at {hsmc[1] + 32 * k:#x} has non-zero runtime words")
        xt, ec, tm, hp = chunks[h + 1 + 4 * k: h + 5 + 4 * k]
        for (tag, off, size), n, stride in ((xt, nv, 16), (ec, nf, 8), (tm, nm, 12), (hp, ns, 24)):
            if size != n * stride:
                raise FormatError(f"{where}: set {k} {tag} at {off:#x} is {size} bytes, header says {n} x {stride}")
        verts = [struct.unpack_from("<3fI", data, xt[1] + 16 * i) for i in range(nv)]
        for i, v in enumerate(verts):
            if not all(math.isfinite(c) for c in v[:3]):
                raise FormatError(f"{where}: set {k} vertex {i} at {xt[1] + 16 * i:#x} is not finite")
            if mtype != 1 and v[3] != 0:
                raise FormatError(f"{where}: set {k} vertex {i} at {xt[1] + 16 * i:#x} has bone {v[3]} on a non-bone model")
        faces = [struct.unpack_from("<4H", data, ec[1] + 8 * i) for i in range(nf)]
        for i, f in enumerate(faces):
            if max(f[:3]) >= nv or f[3] >= nm:
                raise FormatError(f"{where}: set {k} face {i} at {ec[1] + 8 * i:#x} indexes outside its set")
        surfaces = []
        for i in range(nm):
            transparency, portal, slot, material, _garbage = struct.unpack_from("<f2h2H", data, tm[1] + 12 * i)
            if portal < -1 or slot < -1 or (material != NO_MATERIAL and material >= game_materials):
                raise FormatError(f"{where}: set {k} TAMC {i} at {tm[1] + 12 * i:#x} out of range")
            surfaces.append({"transparency": transparency, "portal": portal, "slot": slot,
                             "material": -1 if material == NO_MATERIAL else material})
        spheres = [struct.unpack_from("<4f4H", data, hp[1] + 24 * i) for i in range(ns)]
        if ns != (2 * nf - 1 if nf else 0):
            raise FormatError(f"{where}: set {k} HPSC at {hp[1]:#x} has {ns} nodes for {nf} faces (expected 2n-1)")
        sets.append({"verts": verts, "faces": faces, "surfaces": surfaces, "spheres": spheres,
                     "offsets": {"XTVC": xt[1], "ECFC": ec[1], "TAMC": tm[1], "HPSC": hp[1]}})
        check_sphere_tree(sets[-1], f"{where}: set {k}")
    return {"type": mtype, "sets": sets, "chunks": chunks}


def check_sphere_tree(s, where):
    """HPSC: node 0 is the root; children are first-child / next-sibling linked;
    every node is reached once; leaves own disjoint face ranges covering every
    face; internal nodes have exactly two children; spheres bound their faces."""
    nodes, faces, verts = s["spheres"], s["faces"], s["verts"]
    if not nodes:
        return {"max_excess": 0.0}
    if nodes[0][7] != 0:
        raise FormatError(f"{where}: HPSC root has a sibling")
    seen = [0] * len(nodes)
    covered = [0] * len(faces)
    excess = 0.0

    def walk(i, depth):
        nonlocal excess
        if depth > 4096:
            raise FormatError(f"{where}: HPSC tree too deep (cycle?)")
        if seen[i]:
            raise FormatError(f"{where}: HPSC node {i} reached twice")
        seen[i] = 1
        cx, cy, cz, r, first, count, child, _sib = nodes[i]
        owned = []
        if count:
            if child:
                raise FormatError(f"{where}: HPSC leaf {i} has children")
            if first + count > len(faces):
                raise FormatError(f"{where}: HPSC leaf {i} face range outside ECFC")
            for f in range(first, first + count):
                covered[f] += 1
                owned.append(f)
        else:
            if not child:
                raise FormatError(f"{where}: HPSC internal node {i} has no children")
            kids = []
            c = child
            while c:
                if c >= len(nodes):
                    raise FormatError(f"{where}: HPSC node {i} links outside the tree")
                kids.append(c)
                c = nodes[c][7]
            if len(kids) != 2:
                raise FormatError(f"{where}: HPSC internal node {i} has {len(kids)} children")
            for c in kids:
                owned.extend(walk(c, depth + 1))
        for f in owned:
            for vi in faces[f][:3]:
                x, y, z = verts[vi][:3]
                d = math.sqrt((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2) - r
                excess = max(excess, d)
        return owned

    walk(0, 0)
    if not all(seen):
        raise FormatError(f"{where}: HPSC has {seen.count(0)} unreachable nodes")
    if any(c != 1 for c in covered):
        raise FormatError(f"{where}: HPSC leaves do not cover every face exactly once")
    if excess > 1.0:
        raise FormatError(f"{where}: HPSC sphere misses a vertex by {excess:.2f} units")
    s["sphere_excess"] = excess
    return {"max_excess": excess}


def topology(s):
    """'closed' (every edge shared by exactly two solid faces), 'open' or 'non-manifold';
    vertices are welded at 0.1 unit (XTVC repeats positions)."""
    weld, ids = {}, []
    for v in s["verts"]:
        ids.append(weld.setdefault(tuple(round(c, 1) for c in v[:3]), len(weld)))
    edges = collections.Counter()
    for f in s["faces"]:
        if s["surfaces"][f[3]]["portal"] >= 0:
            continue
        a, b, c = ids[f[0]], ids[f[1]], ids[f[2]]
        for e in ((a, b), (b, c), (c, a)):
            edges[(min(e), max(e))] += 1
    if any(n > 2 for n in edges.values()):
        return "non-manifold"
    return "closed" if all(n == 2 for n in edges.values()) else "open"


def render_triangles(data, chunks, mtype):
    """(positions, [(i0, i1, i2, texture slot)]) from XTRV + DNER, stored winding."""
    by = {}
    for c in chunks:
        by.setdefault(c[0], []).append(c)
    _, xo, xs = by["XTRV"][0]
    stride = 32 if mtype == 0 else 40
    pos = [struct.unpack_from("<3f", data, xo + stride * i) for i in range(xs // stride)]
    _, do, dsize = by["DNER"][0]
    hdr = 32 if mtype == 3 else 28
    off, tris = 0, []
    while off < dsize:
        at = do + off
        s16 = struct.unpack_from("<8h", data, at + 12)
        count, slot = s16[0], s16[2]
        base = s16[4] if mtype == 3 else s16[3]
        idx = struct.unpack_from(f"<{count}H", data, at + hdr)
        tris += [(base + idx[i], base + idx[i + 1], base + idx[i + 2], slot) for i in range(0, count, 3)]
        off += hdr + 2 * count
    return pos, tris


def _tri_key(points):
    """Winding-preserving key: rotate so the smallest rounded vertex comes first."""
    r = [tuple(round(c) for c in p) for p in points]
    k = r.index(min(r))
    return tuple(r[k:] + r[:k])


def compare_with_render(data, coll):
    """Per texture slot: are the set-0 faces tagged with that slot exactly the render triangles?"""
    pos, tris = render_triangles(data, coll["chunks"], coll["type"])
    s = coll["sets"][0]
    render = collections.defaultdict(collections.Counter)
    for t in tris:
        render[t[3]][_tri_key([pos[i] for i in t[:3]])] += 1
    col = collections.defaultdict(collections.Counter)
    for f in s["faces"]:
        slot = s["surfaces"][f[3]]["slot"]
        if slot >= 0:
            col[slot][_tri_key([s["verts"][i][:3] for i in f[:3]])] += 1
    out = collections.Counter()
    for slot in set(render) | set(col):
        a, b = render.get(slot, collections.Counter()), col.get(slot, collections.Counter())
        out["identical" if a == b else ("render only" if not b else "different")] += 1
    return out


def load_models():
    """Every .mef in the two archives: ([(name, archive, bytes)] for all 601 files,
    {name: (archive, bytes)} with the level archive winning duplicates, as
    web-port/src/loaders/level.ts does). The 9 duplicated names differ in bytes."""
    files, models = [], {}
    for arch in ARCHIVES:
        data = (GAME / arch).read_bytes()
        for name, chunk in resource_members(data):
            if not name.lower().endswith(".mef"):
                continue
            key = name.split("/")[-1][:-4].lower()
            body = chunk.payload(data)
            files.append((key, arch, body))
            models.setdefault(key, (arch, body))
    return files, models


# ---------------------------------------------------------------------------
# materials
# ---------------------------------------------------------------------------


def _s(v):
    return v if isinstance(v, str) else (v.get("symbol") if isinstance(v, dict) else "")


def read_materials(data):
    """material.qvm: SetActiveMaterial(i); DefineQMaterial(6); DefineGameMaterial(36).
    Layout (recovered): record i at 0x565380 + i x 0x268; QMaterial at +0x00 (arg 0
    f32 = see-through factor used by FUN_004b9810), GameMaterial name at +0x20,
    hardness +0x40, ricochet angle +0x44, footstep range +0x50, sounds from +0x54,
    impacts +0x154, effect tasks +0x254 / +0x25c (FUN_00407f40, FUN_00408060)."""
    out, active, q = [], None, None
    for call in QVM(data).call_tree():
        a = call["args"]
        if call["fn"] == "SetActiveMaterial":
            active, q = int(a[0]), None
        elif call["fn"] == "DefineQMaterial":
            if len(a) != 6:
                raise FormatError(f"material.qvm: DefineQMaterial with {len(a)} arguments")
            q = [float(x) for x in a]
        elif call["fn"] == "DefineGameMaterial":
            if len(a) != 36 or active is None:
                raise FormatError(f"material.qvm: DefineGameMaterial #{len(out)} malformed")
            out.append({
                "index": active, "name": a[0],
                "see_through": q[0] if q else None, "q_arg1": q[1] if q else None, "q_arg2": q[2] if q else None,
                "q_rgb": q[3:6] if q else None,
                "hardness": float(a[1]), "ricochet_deg": float(a[2]), "arg3": float(a[3]), "arg4": bool(a[4]),
                "footstep_m": float(a[5]), "walk": list(a[6:12]), "land": a[12], "rain": a[13],
                "impact": list(a[14:20]), "arg20": a[20], "arg21": a[21],
                "effects": [{"task": _s(a[o]), "flagA": bool(a[o + 1]), "flagB": bool(a[o + 2]),
                             "decals": [a[o + 3], a[o + 4]], "size": float(a[o + 5]), "model": a[o + 6]}
                            for o in (22, 29)],
            })
    return out


# ---------------------------------------------------------------------------
# level 1
# ---------------------------------------------------------------------------


def attachments(data, chunks):
    out = []
    for tag, off, size in chunks:
        if tag == "ATTA":
            for r in range(size // 68):
                out.append(data[off + 68 * r: off + 68 * r + 16].split(b"\0")[0].decode("latin1").lower())
    return out


def level_instances(models):
    """(model, root task type) for every placed model and its ATTA sub-models (recursively)."""
    tasks = read_tasks((GAME / LEVEL / "objects.qvm").read_bytes())
    out = []

    def visit(name, ttype, depth):
        if name not in models or depth > 16:
            return
        out.append((name, ttype, depth))
        body = models[name][1]
        for sub in attachments(body, mef_chunks(body, name)):
            visit(sub, ttype, depth + 1)

    for t in tasks:
        m = t["params"].get("Model")
        if isinstance(m, str) and m:
            visit(m.lower(), t["type"], 0)
    return out, tasks


def tri_area_m2(a, b, c):
    u = [b[i] - a[i] for i in range(3)]
    v = [c[i] - a[i] for i in range(3)]
    n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
    return 0.5 * math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2) / UNITS_PER_METRE ** 2


def _f32(x):
    return struct.unpack("<f", struct.pack("<f", x))[0]


def terrain_material_table(objects_tasks):
    """TextureModifier boxes + masks as FUN_004fd0f0 builds them (terrain_tex.py), and the
    FUN_004c1a30 lookup: modifiers innermost first, bilinear mask value >= 0.3 wins."""
    bit = (GAME / LEVEL / "terrain/terrain.bit").read_bytes()
    entries, p = {}, 0xC00
    for i in range(256):
        side = struct.unpack_from("<I", bit, 12 * i + 8)[0]
        if side:
            entries[i] = (side, bit[p:p + side * side // 8])
            p += side * side // 8
    if p != len(bit):
        raise FormatError("terrain.bit masks do not end at EOF")
    mods = []
    for t in objects_tasks:
        if t["type"] != "TextureModifier":
            continue
        bid = t["params"]["Bitmap ID"]
        if bid not in entries:
            continue
        side, mask = entries[bid]
        level = t["params"]["Level"]
        full = 2 * ((1 << 30) >> level)
        x0 = int(t["params"]["Position"][0]) & ~(full - 1)
        y0 = int(t["params"]["Position"][1]) & ~(full - 1)
        mods.append({"order": t["order"], "level": level, "material": t["params"]["Material Index"],
                     "x0": x0, "y0": y0, "full": full, "scale": _f32((side - 1) / full), "row": side // 8,
                     "mask": mask})
    return mods


def terrain_material_at(mods, x, y):
    """Terrain material id at (x, y) (FUN_004c1a30, chop rounding)."""
    stack = [m for m in mods if m["x0"] <= x < m["x0"] + m["full"] and m["y0"] <= y < m["y0"] + m["full"]]
    stack.sort(key=lambda m: (-m["level"], m["order"]))  # innermost first [ordering inferred]

    def bit(m, ix, iy):
        k = (ix >> 3) + iy * m["row"]
        return (m["mask"][k] >> (ix & 7)) & 1 if 0 <= ix and 0 <= k < len(m["mask"]) else 0

    for m in stack:
        fx = (x - m["x0"]) * m["scale"]               # double (origin +0x18 is a double)
        fy = _f32((y - m["y0"]) * m["scale"])         # stored as float in FUN_004c1a30
        ix, iy = int(fx), int(fy)
        tx, ty = fx - ix, fy - iy
        top = bit(m, ix, iy) + (bit(m, ix + 1, iy) - bit(m, ix, iy)) * tx
        bottom = bit(m, ix, iy + 1) + (bit(m, ix + 1, iy + 1) - bit(m, ix, iy + 1)) * tx
        if top + (bottom - top) * ty >= 0.3:
            return m["material"]
    return 0


# ---------------------------------------------------------------------------
# optional: hull offset + previews
# ---------------------------------------------------------------------------


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def ray_triangle(o, d, a, b, c):
    e1, e2 = _sub(b, a), _sub(c, a)
    p = _cross(d, e2)
    det = _dot(e1, p)
    if abs(det) < 1e-9:
        return None
    s = _sub(o, a)
    u = _dot(s, p) / det
    if not 0 <= u <= 1:
        return None
    q = _cross(s, e1)
    v = _dot(d, q) / det
    if v < 0 or u + v > 1:
        return None
    t = _dot(e2, q) / det
    return t if t >= 0 else None


def hull_offsets(models):
    """Distance from each near-vertical set-1 face centre to the set-0 surface (both ways)."""
    hist, values = collections.Counter(), []
    for name, (_arch, body) in sorted(models.items()):
        c = read_collision(body, name)
        if not c or not c["sets"][0]["faces"] or not c["sets"][1]["faces"]:
            continue
        s0, s1 = c["sets"]
        v0 = [v[:3] for v in s0["verts"]]
        solid = [(v0[f[0]], v0[f[1]], v0[f[2]]) for f in s0["faces"] if s0["surfaces"][f[3]]["portal"] < 0]
        v1 = [v[:3] for v in s1["verts"]]
        for f in s1["faces"]:
            a, b, cc = v1[f[0]], v1[f[1]], v1[f[2]]
            n = _cross(_sub(cc, a), _sub(b, a))
            ln = math.sqrt(_dot(n, n))
            if not ln or abs(n[2] / ln) >= 0.1:
                continue
            n = (n[0] / ln, n[1] / ln, n[2] / ln)
            centre = tuple((a[i] + b[i] + cc[i]) / 3 for i in range(3))
            best = None
            for sign in (1, -1):
                d = (sign * n[0], sign * n[1], sign * n[2])
                for t in solid:
                    hit = ray_triangle(centre, d, *t)
                    if hit is not None and (best is None or hit < best):
                        best = hit
            if best is not None:
                values.append(best)
                hist[int(round(best / 25.0)) * 25] += 1
    values.sort()
    return {"wall faces measured": len(values), "median units": values[len(values) // 2] if values else None,
            "mode bins (units, count)": hist.most_common(6)}


def write_png(path, w, h, rgb):
    raw = b"".join(b"\0" + bytes(rgb[y * w * 3:(y + 1) * w * 3]) for y in range(h))

    def chunk(tag, payload):
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)

    Path(path).write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


PALETTE = [(90, 90, 90), (150, 110, 70), (60, 90, 200), (170, 120, 60), (200, 180, 120), (110, 110, 140),
           (140, 140, 170), (160, 160, 190), (200, 60, 60), (150, 30, 30), (90, 60, 120), (200, 200, 200),
           (70, 70, 70), (180, 60, 160), (100, 220, 240), (230, 200, 60), (250, 250, 250), (40, 40, 40),
           (120, 160, 120), (170, 150, 120), (240, 240, 255), (255, 0, 255), (0, 200, 0), (0, 120, 0)]


def preview(body, name, out_dir, size=256):
    """Top (x/y) and side (x/z) views: set 0 flat-shaded by game material
    (magenta = none), portal faces yellow, set-1 hull edges in green."""
    c = read_collision(body, name)
    if not c:
        return None
    s0, s1 = c["sets"]
    pts = [v[:3] for v in s0["verts"]] + [v[:3] for v in s1["verts"]]
    lo = [min(p[i] for p in pts) for i in range(3)]
    hi = [max(p[i] for p in pts) for i in range(3)]
    span = max(hi[i] - lo[i] for i in range(3)) or 1.0
    img = bytearray(b"\x18" * (2 * size * size * 3))
    zbuf = [[-1e30] * (2 * size) for _ in range(size)]
    for view, (ax, ay, az) in enumerate(((0, 1, 2), (0, 2, 1))):
        def proj(p):
            return ((p[ax] - lo[ax]) / span * (size - 1) + view * size,
                    (size - 1) - (p[ay] - lo[ay]) / span * (size - 1),
                    p[az] if view == 0 else -p[az])
        for f in s0["faces"]:
            surf = s0["surfaces"][f[3]]
            col = (255, 220, 0) if surf["portal"] >= 0 else (
                PALETTE[surf["material"]] if 0 <= surf["material"] < len(PALETTE) else (255, 0, 255))
            p = [proj(s0["verts"][i][:3]) for i in f[:3]]
            n = _cross(_sub(s0["verts"][f[2]][:3], s0["verts"][f[0]][:3]), _sub(s0["verts"][f[1]][:3], s0["verts"][f[0]][:3]))
            ln = math.sqrt(_dot(n, n)) or 1
            shade = 0.45 + 0.55 * abs(n[az] / ln)
            x0, x1 = int(max(view * size, min(q[0] for q in p))), int(min(view * size + size - 1, max(q[0] for q in p)))
            y0, y1 = int(max(0, min(q[1] for q in p))), int(min(size - 1, max(q[1] for q in p)))
            d = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1])
            if abs(d) < 1e-9:
                continue
            for y in range(y0, y1 + 1):
                for x in range(x0, x1 + 1):
                    w1 = ((x - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (y - p[0][1])) / d
                    w2 = ((p[1][0] - p[0][0]) * (y - p[0][1]) - (x - p[0][0]) * (p[1][1] - p[0][1])) / d
                    if w1 < 0 or w2 < 0 or w1 + w2 > 1:
                        continue
                    z = p[0][2] + w1 * (p[1][2] - p[0][2]) + w2 * (p[2][2] - p[0][2])
                    if z > zbuf[y][x]:
                        zbuf[y][x] = z
                        o = (y * 2 * size + x) * 3
                        img[o:o + 3] = bytes(int(ch * shade) for ch in col)
        for f in s1["faces"]:
            p = [proj(s1["verts"][i][:3]) for i in f[:3]]
            for a, b in ((0, 1), (1, 2), (2, 0)):
                steps = int(max(abs(p[b][0] - p[a][0]), abs(p[b][1] - p[a][1]))) + 1
                for k in range(steps + 1):
                    x = int(p[a][0] + (p[b][0] - p[a][0]) * k / steps)
                    y = int(p[a][1] + (p[b][1] - p[a][1]) * k / steps)
                    if view * size <= x < view * size + size and 0 <= y < size:
                        o = (y * 2 * size + x) * 3
                        img[o:o + 3] = b"\x00\xff\x00"
    path = Path(out_dir) / f"{name}.png"
    write_png(path, 2 * size, size, img)
    return str(path)


# ---------------------------------------------------------------------------
# report
# ---------------------------------------------------------------------------


def build(args):
    report, checks = {}, []

    def check(ok, what):
        checks.append((bool(ok), what))

    exe_bytes = (GAME / "igi.exe").read_bytes()
    exe = Exe(exe_bytes)
    check(hashlib.sha256(exe_bytes).hexdigest() == EXE_SHA256, "igi.exe is the analysed build")
    for va, hexbytes, fn, meaning in CODE_EVIDENCE:
        got = exe.read(va, len(hexbytes) // 2).hex()
        check(got == hexbytes, f"code {va:#x} {fn}: {meaning}")
    for va, kind, expected, meaning in CONSTANTS:
        got = exe.f32(va) if kind == "f32" else exe.f64(va)
        check(math.isclose(got, expected, rel_tol=1e-6), f"constant {va:#x} = {got:g} ({meaning})")

    materials = read_materials((GAME / "material/material.qvm").read_bytes())
    check([m["index"] for m in materials] == list(range(len(materials))),
          f"material.qvm defines materials 0..{len(materials) - 1} in SetActiveMaterial order")
    by_index = {m["index"]: m for m in materials}

    # --- every model ---------------------------------------------------------------
    files, models = load_models()
    decoded = collections.defaultdict(list)
    for key, arch, body in files:          # all 601 files, duplicates included
        c = read_collision(body, f"{arch}:{key}", len(materials))
        decoded[key].append(None if c is None else [{k: s[k] for k in ("verts", "faces", "surfaces", "spheres")}
                                                    for s in c["sets"]])
    twins = [v for v in decoded.values() if len(v) > 1]
    check(all(v[0] == v[1] for v in twins),
          f"the {len(twins)} models stored in both archives (bytes differ in headers) have identical collision")
    check(len(files) == 601, f"{len(files)} .mef files decoded and validated (HSMC sets, indices, sphere trees)")
    stats = collections.Counter()
    render_cmp = collections.Counter()
    surf_kinds = collections.Counter()
    bone_max = 0
    excess = 0.0
    per_model = {}
    for name, (_arch, body) in sorted(models.items()):
        c = read_collision(body, name, len(materials))   # raises on any inconsistency
        lod = name.rsplit("_", 1)[-1] if name.count("_") == 2 else "-"
        stats[("LOD _1/other" if lod in ("1", "-") else "LOD _2+", "has HSMC" if c else "no HSMC")] += 1
        if not c:
            continue
        per_model[name] = c
        slots = {t[3] for t in render_triangles(body, c["chunks"], c["type"])[1]}
        for k, s in enumerate(c["sets"]):
            stats[(f"set {k}", "faces" if s["faces"] else "empty")] += 1
            if s["faces"]:
                stats[(f"set {k}", topology(s))] += 1
            excess = max(excess, s.get("sphere_excess", 0.0))
            for surf in s["surfaces"]:
                kind = ("portal" if surf["portal"] >= 0 else
                        "texture slot" if surf["slot"] >= 0 else "collision-only")
                surf_kinds[(k, kind, "material" if surf["material"] >= 0 else "none",
                            f"transparency {surf['transparency']:g}")] += 1
                if surf["slot"] >= 0 and surf["slot"] not in slots:
                    raise FormatError(f"{name}: TAMC slot {surf['slot']} has no render block")
            if c["type"] == 1:
                bone_max = max([bone_max] + [v[3] for v in s["verts"]])
        render_cmp.update(compare_with_render(body, c))
    check(stats[("LOD _2+", "has HSMC")] == 0 and stats[("LOD _1/other", "no HSMC")] == 0,
          "every _1 (and unsuffixed) model has HSMC; no LOD _2+ model has one")
    report["models"] = {"files": len(files), "distinct names": len(models), "with collision": len(per_model),
                        "counts": {" / ".join(k): v for k, v in sorted(stats.items())},
                        "TAMC kinds (set, kind, material, transparency)": {
                            str(k): v for k, v in sorted(surf_kinds.items())},
                        "texture-slot faces vs render triangles (per slot)": dict(render_cmp),
                        "max bone index (type 1)": bone_max,
                        "max sphere excess (units)": round(excess, 4)}
    check(render_cmp["different"] <= 2, "set-0 faces of a texture slot are that slot's render triangles")
    set1_mats = collections.Counter(su["material"] for c in per_model.values() for su in c["sets"][1]["surfaces"])
    check(set1_mats.most_common(1)[0][0] == 21 and by_index[21]["name"] == "HumanCollision",
          f"set 1 surfaces are HumanCollision (material 21): {dict(set1_mats)}")

    # --- material table ----------------------------------------------------------------
    usage0 = collections.defaultdict(lambda: [0, 0.0])
    usage1 = collections.defaultdict(lambda: [0, 0.0])
    instances, tasks = level_instances(models)
    walkable = collections.defaultdict(float)
    for name, _ttype, _depth in instances:
        c = per_model.get(name)
        if not c:
            continue
        for k, usage in ((0, usage0), (1, usage1)):
            s = c["sets"][k]
            for f in s["faces"]:
                surf = s["surfaces"][f[3]]
                if surf["portal"] >= 0:
                    key = "portal"
                else:
                    key = surf["material"]
                a, b, cc = (s["verts"][i][:3] for i in f[:3])
                area = tri_area_m2(a, b, cc)
                usage[key][0] += 1
                usage[key][1] += area
                if k == 0 and key != "portal":
                    n = _cross(_sub(cc, a), _sub(b, a))
                    ln = math.sqrt(_dot(n, n))
                    if ln and n[2] / ln > 0.7:      # upward-facing: something you can stand on
                        walkable[key] += area
    rows = []
    for m in materials:
        rows.append({
            "index": m["index"], "name": m["name"], "see_through (Q arg0)": m["see_through"],
            "hardness": m["hardness"], "ricochet deg": m["ricochet_deg"], "footstep m": m["footstep_m"],
            "walk": m["walk"][0], "land": m["land"], "impact": [x for x in m["impact"] if x][:2],
            "decal": m["effects"][0]["decals"][0], "decal size": m["effects"][0]["size"],
            "impact model": m["effects"][0]["model"],
            "L1 set-0 faces": usage0[m["index"]][0], "L1 set-0 m2": round(usage0[m["index"]][1], 1),
            "L1 floor m2": round(walkable[m["index"]], 1),
        })
    report["materials"] = rows
    report["level 1 set 0 untagged (-1 -> Ground for rays)"] = {
        "faces": usage0[-1][0], "m2": round(usage0[-1][1], 1), "floor m2": round(walkable[-1], 1)}
    report["level 1 set 0 portal faces (skipped)"] = {"faces": usage0["portal"][0], "m2": round(usage0["portal"][1], 1)}
    report["level 1 set 1 (character hulls)"] = {
        (by_index[k]["name"] if isinstance(k, int) and k >= 0 else str(k)): {"faces": v[0], "m2": round(v[1], 1)}
        for k, v in usage1.items()}
    report["level 1 instances"] = {"placed models incl. ATTA": len(instances),
                                   "with set 0": sum(1 for n, *_ in instances if n in per_model and per_model[n]["sets"][0]["faces"]),
                                   "with set 1": sum(1 for n, *_ in instances if n in per_model and per_model[n]["sets"][1]["faces"])}

    # --- terrain -------------------------------------------------------------------------
    tmats, _tilemaps = terrain_script((GAME / LEVEL / "terrain/terrain.qvm").read_bytes())
    mapping = {tid: m["arg1"] for tid, m in sorted(tmats.items())}
    mods = terrain_material_table(tasks)
    counts = collections.Counter()
    if mods:
        xs = [m["x0"] for m in mods] + [m["x0"] + m["full"] for m in mods]
        ys = [m["y0"] for m in mods] + [m["y0"] + m["full"] for m in mods]
        step = 4096 * 4
        for x in range(min(xs), max(xs), step):
            for y in range(min(ys), max(ys), step):
                counts[terrain_material_at(mods, x + 0.5, y + 0.5)] += 1
    report["terrain"] = {
        "CreateTerrainMaterial id -> game material (arg 1)": {
            tid: f"{g} {by_index[g]['name']}" for tid, g in mapping.items()},
        "TextureModifier tasks by terrain material": dict(collections.Counter(m["material"] for m in mods)),
        "4 m grid over the modifier boxes: terrain material -> samples": dict(sorted(counts.items())),
        "game material of every sample": sorted({mapping.get(t, None) for t in counts}),
    }
    check(set(mapping.values()) == {1}, "every level-1 terrain material maps to game material 1 (Ground)")

    if args.hull:
        report["set-1 hull offset from set 0 (near-vertical faces)"] = hull_offsets(models)
    if args.png:
        Path(args.png).mkdir(parents=True, exist_ok=True)
        report["previews"] = [preview(models[n][1], n, args.png)
                              for n in ("503_01_1", "400_02_1", "203_01_1", "622_01_1", "000_01_1", "319_01_1")
                              if n in models]
    report["checks"] = {"passed": sum(ok for ok, _ in checks), "failed": [w for ok, w in checks if not ok]}
    return report, checks


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--hull", action="store_true", help="measure the set-1 hull offset (slow, ~1 min)")
    parser.add_argument("--png", metavar="DIR", help="write preview PNGs of a few models")
    args = parser.parse_args()
    report, checks = build(args)
    if args.json:
        print(json.dumps(report, indent=1, default=str))
    else:
        for key, value in report.items():
            if key == "materials":
                print("\n== materials (material.qvm; L1 = level-1 placed instances, set 0) ==")
                cols = list(value[0])
                print(" | ".join(cols))
                for row in value:
                    print(" | ".join(str(row[c]) for c in cols))
            elif isinstance(value, dict):
                print(f"\n== {key} ==")
                for k, v in value.items():
                    print(f"  {k}: {v}")
            else:
                print(f"\n== {key} ==\n  {value}")
        print("\n== self-checks ==")
        for ok, what in checks:
            print(f"  [{'ok' if ok else 'FAIL'}] {what}")
    return 0 if all(ok for ok, _ in checks) else 1


if __name__ == "__main__":
    sys.exit(main())
