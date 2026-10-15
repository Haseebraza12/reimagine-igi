#!/usr/bin/env python3
"""Project I.G.I. (2000) object lighting: baked .olm lightmaps for type-3
("lightmap") models and the vertex-lit path for everything else.  Stdlib only.

Recovered behaviour (evidence and labels: docs/formats.md "Object lighting";
browser port: web-port/src/loaders/olm.ts, level.ts, engine/world/world-builder.ts):

.olm  (lightmaps.res members obj<NNNNN>_<MMMMM>.olm, loader FUN_0051daa0)
    u32[15] header:  f32 0.12 (magic, 0x3df5c28f) | f32 model version (== MEF HSEM
                     f32 at +0) | u32 y,m,d,h,mi,s (bake time; must be newer than
                     the MEF HSEM timestamp, else the game re-bakes) | u32 [8] ?,
                     [9] 0, [10] 1 | u32 [11] lightmap count (must equal MEF D3DR
                     word 1; always 1 here) | u32 [12], [13] statistics the loader adds to global
                     counters (meaning unknown) | [14] stale pointer
    count x 44-byte entries: +4 u16 w,h | +8 u16 2*w, u16 3 | +16 f32 1,1 |
                     +0x20 runtime texture handle | +0x24 runtime data ptr |
                     +0x28 s16 w | +0x2a s16 h   (loader uses +0x28/+0x2a)
    then w*h*4 bytes per entry: B,G,R,A (A8R8G8B8 / texture format 3).  RGB is the
    final baked light colour (ambient included); A is ignored by the draw.
_MMMMM index = position in the building's instance list (see instance_list()).
Draw (FUN_0052e5d0 'DrawRigidMesh', type-3 branch with lightmap): lighting OFF,
    stage0 = material texture (uv0, WRAP) SELECTARG1, stage1 = lightmap (uv1 = XTRV
    floats 8-9, CLAMP, bilinear, no mip) MODULATE x1 with current; the lightmap
    page of a DNER block is DNER s16 +0x12 (always 0).
Lit path (type 0, and type 3 without a lightmap): D3D fixed-function lighting,
    one directional light per registered Dirlight with diffuse = front colour,
    direction toward the light = (cos G cos B, -sin G cos B, sin B) from the
    keyframe Beta/Gamma, material diffuse = ambient = (1,1,1), AMBIENT render state
    = GlobalLight 'Ambient color object category 1', no specular, Gouraud,
    then MODULATE with the texture:  c = tex * clamp(amb + front*max(0, n.l)).
"""
import json
import math
import os
import re
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
GAME = os.path.join(os.path.dirname(HERE), "Game Files")
LOC0 = GAME + "/missions/location0"
sys.path.insert(0, HERE)
import level_tasks  # noqa: E402


# ------------------------------------------------------------------ containers
def ilff_members(data):
    """ILFF/IRES archive -> [(name, payload bytes)]  (NAME then BODY pairs)."""
    if data[:4] != b"ILFF" or data[16:20] != b"IRES":
        raise ValueError("not an ILFF/IRES archive")
    al = struct.unpack_from("<I", data, 8)[0]
    pos = (20 + al - 1) // al * al
    out = []
    name = None
    while True:
        tag = data[pos:pos + 4]
        size, align, delta = struct.unpack_from("<3I", data, pos + 4)
        off = (pos + 16 + align - 1) // align * align
        body = data[off:off + size]
        if tag == b"NAME":
            name = body.rstrip(b"\0").decode("latin1")
        elif tag in (b"BODY", b"CSTR", b"PATH"):
            out.append((name, body))
            name = None
        if delta == 0:
            return out
        pos += delta


def ilff_form_chunks(data, form):
    if data[:4] != b"ILFF" or data[16:20] != form:
        raise ValueError("expected ILFF/%s" % form.decode())
    al = struct.unpack_from("<I", data, 8)[0]
    pos = (20 + al - 1) // al * al
    out = []
    while True:
        tag = data[pos:pos + 4].decode("latin1")
        size, align, delta = struct.unpack_from("<3I", data, pos + 4)
        off = (pos + 16 + align - 1) // align * align
        out.append((tag, off, size))
        if delta == 0:
            return out
        pos += delta


# ------------------------------------------------------------------ .olm
class Olm:
    HEADER = 0x3C
    ENTRY = 0x2C

    def __init__(self, payload, name=""):
        self.name = name
        h = struct.unpack_from("<2f13I", payload, 0)
        self.magic = struct.unpack_from("<I", payload, 0)[0]
        self.model_version = h[1]
        self.timestamp = tuple(h[2:8])
        self.u8, self.u9, self.u10 = h[8], h[9], h[10]
        self.count = h[11]
        self.texel_total = h[12]
        self.entries = []
        p = self.HEADER + self.ENTRY * self.count
        for i in range(self.count):
            e = self.HEADER + self.ENTRY * i
            w4, h4 = struct.unpack_from("<2H", payload, e + 4)
            pitch16, fmt = struct.unpack_from("<2H", payload, e + 8)
            f1, f2 = struct.unpack_from("<2f", payload, e + 16)
            w, hh = struct.unpack_from("<2h", payload, e + 0x28)
            px = payload[p:p + w * hh * 4]
            self.entries.append({"w": w, "h": hh, "w_at4": w4, "h_at4": h4, "pitch16": pitch16, "fmt": fmt,
                                 "f": (f1, f2), "bgra": px})
            p += w * hh * 4
        self.end = p
        self.size = len(payload)

    def rgb(self, page, x, y):
        e = self.entries[page]
        k = 4 * (y * e["w"] + x)
        b, g, r, _a = e["bgra"][k:k + 4]
        return (r, g, b)

    def sample(self, page, u, v):
        """Bilinear, CLAMP (D3DTSS_ADDRESS = 3 on stage 1)."""
        e = self.entries[page]
        w, h = e["w"], e["h"]
        tx = min(max(u * w - 0.5, 0.0), w - 1.0)
        ty = min(max(v * h - 0.5, 0.0), h - 1.0)
        x0, y0 = int(tx), int(ty)
        x1, y1 = min(x0 + 1, w - 1), min(y0 + 1, h - 1)
        fx, fy = tx - x0, ty - y0
        c00, c10, c01, c11 = self.rgb(page, x0, y0), self.rgb(page, x1, y0), self.rgb(page, x0, y1), self.rgb(page, x1, y1)
        return tuple((c00[i] * (1 - fx) + c10[i] * fx) * (1 - fy) + (c01[i] * (1 - fx) + c11[i] * fx) * fy
                     for i in range(3))


# ------------------------------------------------------------------ .mef
class Mef:
    def __init__(self, data, name=""):
        self.name = name
        ch = {}
        for tag, off, size in ilff_form_chunks(data, b"OCEM"):
            ch.setdefault(tag, (off, size))
        o, s = ch["HSEM"]
        self.version = struct.unpack_from("<f", data, o)[0]
        self.timestamp = struct.unpack_from("<6I", data, o + 4)
        self.type = struct.unpack_from("<I", data, o + 32)[0]
        o, s = ch["ATTA"]
        self.atta = []
        for r in range(s // 68):
            a = o + 68 * r
            nm = data[a:a + 16].split(b"\0")[0].decode("latin1")
            f = struct.unpack_from("<12f", data, a + 16)
            self.atta.append({"name": nm, "offset": f[0:3], "matrix": f[3:12],
                              "bone": struct.unpack_from("<i", data, a + 64)[0]})
        o, s = ch["D3DR"]
        self.d3dr = struct.unpack_from("<5I", data, o)
        self.lightmap_count = self.d3dr[1] if self.type == 3 else 0
        o, s = ch["XTRV"]
        stride = 32 if self.type == 0 else 40
        self.verts = []
        for k in range(s // stride):
            v = struct.unpack_from("<%df" % (stride // 4), data, o + stride * k)
            self.verts.append({"pos": v[0:3], "nrm": v[3:6], "uv0": v[6:8], "uv1": v[8:10] if self.type == 3 else None})
        o, s = ch["DNER"]
        hdr = 32 if self.type == 3 else 28
        self.blocks = []
        off = 0
        while off < s:
            a = o + off
            centre = struct.unpack_from("<3f", data, a)
            n = 10 if self.type == 3 else 8
            f = struct.unpack_from("<%dh" % n, data, a + 12)
            if self.type == 3:
                ic, nxt, slot, lm, vo, vc, deferred = f[0], f[1], f[2], f[3], f[4], f[5], f[6]
            else:
                ic, nxt, slot, vo, vc, deferred = f[0], f[1], f[2], f[3], f[4], f[5]
                lm = None
            idx = struct.unpack_from("<%dH" % ic, data, a + hdr)
            self.blocks.append({"centre": centre, "index_count": ic, "next": nxt, "slot": slot & 0xFFFF,
                                "lightmap": lm, "vertex_offset": vo, "vertex_count": vc, "deferred": deferred,
                                "indices": idx})
            off += hdr + ic * 2
        self.pmtl = []
        if "PMTL" in ch:
            o, s = ch["PMTL"]
            for r in range(s // 8):
                self.pmtl.append(struct.unpack_from("<2H", data, o + 8 * r))

    def triangles(self):
        """(block, i0, i1, i2) with model-global vertex indices (stored order)."""
        for b in self.blocks:
            for k in range(0, b["index_count"], 3):
                i = b["indices"]
                yield b, b["vertex_offset"] + i[k], b["vertex_offset"] + i[k + 1], b["vertex_offset"] + i[k + 2]


class ModelLib:
    def __init__(self, archives=(LOC0 + "/level1/models/level1.res", LOC0 + "/common/models/location0.res")):
        self.raw = {}
        for p in archives:
            for n, body in ilff_members(open(p, "rb").read()):
                m = re.search(r"([^/]+)\.mef$", n)
                if m and m.group(1) not in self.raw:
                    self.raw[m.group(1)] = body
        self._c = {}

    def __contains__(self, name):
        return name in self.raw

    def get(self, name):
        m = self._c.get(name)
        if m is None:
            m = Mef(self.raw[name], name)
            self._c[name] = m
        return m

    def lods(self, name):
        base = name.rsplit("_", 1)[0]
        out = []
        k = 1
        while "%s_%d" % (base, k) in self.raw:
            out.append("%s_%d" % (base, k))
            k += 1
        return out


# ------------------------------------------------------------------ math
def euler(a, b, g):
    """M = Rz(g) Ry(b) Rx(a), as igi.exe FUN_004a9bc0 builds it (row-major 3x3)."""
    ca, sa, cb, sb, cg, sg = math.cos(a), math.sin(a), math.cos(b), math.sin(b), math.cos(g), math.sin(g)
    rz = [[cg, -sg, 0], [sg, cg, 0], [0, 0, 1]]
    ry = [[cb, 0, sb], [0, 1, 0], [-sb, 0, cb]]
    rx = [[1, 0, 0], [0, ca, -sa], [0, sa, ca]]
    mul = lambda A, B: [[sum(A[i][k] * B[k][j] for k in range(3)) for j in range(3)] for i in range(3)]
    return mul(mul(rz, ry), rx)


def mat_vec(M, v):
    return [M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
            M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
            M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]]


def row_vec_mat(v, m9):
    """v' = v * M with M row-major 3x3 (ATTA convention, per the web-port reader)."""
    return [v[0] * m9[0] + v[1] * m9[3] + v[2] * m9[6],
            v[0] * m9[1] + v[1] * m9[4] + v[2] * m9[7],
            v[0] * m9[2] + v[1] * m9[5] + v[2] * m9[8]]


def sun_direction(beta, gamma):
    """Unit vector toward the light (FUN_00521080 + FUN_004a9bc0, C = 2*pi)."""
    return (math.cos(gamma) * math.cos(beta), -math.sin(gamma) * math.cos(beta), math.sin(beta))


def keyframe(frames, time, key):
    fs = sorted(frames, key=lambda f: f["time"])
    for f in fs:
        if f["time"] == time:
            return f[key]
    lo = [f for f in fs if f["time"] < time]
    hi = [f for f in fs if f["time"] > time]
    if not lo:
        return hi[0][key]
    if not hi:
        return lo[-1][key]
    a, b = lo[-1], hi[0]
    t = (time - a["time"]) / (b["time"] - a["time"])
    if isinstance(a[key], list):
        return [x + (y - x) * t for x, y in zip(a[key], b[key])]
    return a[key] + (b[key] - a[key]) * t


class Lights:
    """Runtime light state.  igi.exe initialises time-of-day to 0 (FUN_00521230(0),
    FUN_005221c0(0)) which is below every keyframe -> the earliest keyframe applies."""

    def __init__(self, data, time=0.0):
        dk = data["dirlight_keyframes"]
        gk = data["global_light_keyframes"]
        self.time = time
        self.front = keyframe(dk, time, "front_color")
        self.back = keyframe(dk, time, "back_color")
        # the engine interpolates the direction vector (slerp-like); use the keyframe angles
        beta = keyframe(dk, time, "beta")
        gamma = keyframe(dk, time, "gamma")
        self.sun_dir = sun_direction(beta, gamma)
        self.ambient_object = keyframe(gk, time, "ambient_object")[0]      # category 1
        self.fog_color_object = keyframe(gk, time, "fog_color_object")[0]
        self.ambient_terrain = keyframe(gk, time, "ambient_terrain")

    def vertex_colour(self, normal_world):
        """Lit path (type 0, or type 3 without lightmap): per-vertex colour 0..1."""
        n = normal_world
        L = math.sqrt(sum(c * c for c in n)) or 1.0
        d = max(0.0, sum(n[i] / L * self.sun_dir[i] for i in range(3)))
        return tuple(min(1.0, self.ambient_object[i] + self.front[i] * d) for i in range(3))


# ------------------------------------------------------------------ instance list
def instance_list(building, lib, atta_row_vector=True):
    """The building's lightmap instance list, in .olm index order (_00000, _00001, ...).

    Recovered order (exact match of all 1,308 .olm sizes for all 22 level-1 buildings):
      emit(model):  every LOD variant model_1.._n (one entry each), then the
                    model_1 ATTA entries without own attachments (ATTA order), then
                    the ATTA entries that have attachments (recursively)
      list = emit(building Model) + emit(Model) of every descendant task that has a
             'Model' parameter (EditRigidObj, Door, ExplodeObject, Terminal, ...),
             in task order.
    Each entry carries a transform model->world (rotation 3x3 applied to column
    vectors, translation)."""
    out = []

    def emit_atta(model, R, t, source):
        emit(model, R, t, source)

    def emit(model, R, t, source):
        for k, lm in enumerate(lib.lods(model)):
            out.append({"model": lm, "base": model, "lod": k + 1, "R": R, "t": t, "source": source})
        m = lib.get(model)
        order = [a for a in m.atta if not lib.get(a["name"]).atta] + [a for a in m.atta if lib.get(a["name"]).atta]
        for a in order:
            # v_parent = v_child * M + offset  ->  world = R_parent (v_child * M + offset) + t
            M = a["matrix"]
            # column form: v*M == M^T v, so R_child = R * M^T  (M row-major: M[r][c] = M9[3r + c])
            if atta_row_vector:
                Rc = [[sum(R[i][k] * M[j * 3 + k] for k in range(3)) for j in range(3)] for i in range(3)]
            else:   # alternative reading v' = M v (used only by the self-check)
                Rc = [[sum(R[i][k] * M[k * 3 + j] for k in range(3)) for j in range(3)] for i in range(3)]
            tc = [t[i] + sum(R[i][k] * a["offset"][k] for k in range(3)) for i in range(3)]
            emit_atta(a["name"], Rc, tc, source + "/" + a["name"])

    o = building["orientation"]
    emit(building["model"], euler(o[0], o[1], o[2]), list(building["position"]), "building")
    for d in building["descendant_models"]:
        oo = d["orientation"] or [0, 0, 0]
        pos = d["position"] or building["position"]      # some descendant tasks carry no Position
        emit(d["model"], euler(oo[0], oo[1], oo[2]), list(pos), d["type"])
    return out


def load_olms(path=LOC0 + "/level1/lightmaps/lightmaps.res"):
    out = {}
    for n, body in ilff_members(open(path, "rb").read()):
        m = re.search(r"(obj\d+)_(\d+)\.olm$", n)
        out.setdefault(m.group(1), {})[int(m.group(2))] = Olm(body, n)
    return out


# ------------------------------------------------------------------ textures (visual check only)
def read_mtp(data):
    assert data[:4] == b"FORM" and data[8:12] == b"MTP "
    pos = 12
    ch = {}
    while pos < len(data):
        tag = data[pos:pos + 4].decode()
        size = struct.unpack_from(">I", data, pos + 4)[0]
        ch[tag] = data[pos + 8:pos + 8 + size]
        pos += 8 + size + (size & 1)
    def names(b):
        n = struct.unpack_from("<I", b, 0)[0]
        out = []
        p = 4
        for _ in range(n):
            e = b.index(b"\0", p)
            out.append(b[p:e].decode("latin1"))
            p = e + 1
        return out
    mods, texf = names(ch["MODS"]), names(ch["TEXF"])
    inst = ch["INST"]
    res = {}
    p = 0
    while p < len(inst):
        mi, n = struct.unpack_from("<2I", inst, p)
        p += 8
        res[mods[mi]] = [texf[i] for i in struct.unpack_from("<%dI" % n, inst, p)]
        p += 4 * n
    return res


def decode_loop11(data):
    fmt = struct.unpack_from("<I", data, 8)[0]
    w, h, _sw, _sh, bpp = struct.unpack_from("<5H", data, 22)
    px = []
    if bpp == 2:
        for (v,) in struct.iter_unpack("<H", data[32:32 + w * h * 2]):
            px.append((((v >> 10) & 31) * 255 // 31, ((v >> 5) & 31) * 255 // 31, (v & 31) * 255 // 31))
    else:
        b = data[32:32 + w * h * 4]
        px = [(b[i + 2], b[i + 1], b[i]) for i in range(0, len(b), 4)]
    return w, h, px


def write_png(path, w, h, rgb_rows):
    raw = b"".join(b"\x00" + bytes(r) for r in rgb_rows)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


# ======================================================================= self-check
def self_check(png_dir=None, data_path=None):
    if data_path:
        data = json.load(open(data_path))
    else:
        data = level_tasks.building_inputs(open(LOC0 + "/level1/objects.qvm", "rb").read())
    lib = ModelLib()
    olms = load_olms()
    nfiles = sum(len(v) for v in olms.values())
    print("== .olm decode: %d files in %d objects" % (nfiles, len(olms)))
    bad = []
    stats = {"count1": 0, "size_ok": 0, "dup_wh": 0, "pitch": 0, "fmt3": 0}
    from collections import Counter
    texels = Counter()
    for obj, files in olms.items():
        for k, o in files.items():
            e = o.entries[0]
            stats["count1"] += o.count == 1
            stats["size_ok"] += o.size == o.HEADER + o.ENTRY * o.count + sum(x["w"] * x["h"] * 4 for x in o.entries)
            stats["dup_wh"] += (e["w"], e["h"]) == (e["w_at4"], e["h_at4"])
            stats["pitch"] += e["pitch16"] == 2 * e["w"]
            stats["fmt3"] += e["fmt"] == 3
            if o.magic != 0x3DF5C28F:
                bad.append(o.name)
            for i in range(0, len(e["bgra"]), 4):
                texels[e["bgra"][i:i + 3]] += 1
    print("  magic ok: %d/%d; count==1: %d; size == 60 + 44*count + 4*w*h: %d; (w,h)@+4 == @+0x28: %d; "
          "u16@+8 == 2w: %d; u16@+10 == 3: %d" % (nfiles - len(bad), nfiles, stats["count1"], stats["size_ok"],
                                                  stats["dup_wh"], stats["pitch"], stats["fmt3"]))
    top = texels.most_common(3)
    print("  most common texels (stored B,G,R): %s" % [(tuple(t), n) for t, n in top])
    L = Lights(data)
    amb255 = tuple(int(255 * a) for a in L.ambient_object)
    print("  ambient (object category 1 / terrain) x255, truncated = %s  -> stored as B,G,R %s"
          % (amb255, tuple(reversed(amb255))))

    print("\n== building -> instance list -> .olm mapping")
    ok = 0
    ver_ok = ts_ok = pm_ok = lm_ok = total = 0
    lists = {}
    for b in data["buildings"]:
        li = b["lightmap_info"]
        if not li:
            continue
        obj = li["Filename"]
        lst = instance_list(b, lib)
        lists[obj] = (b, lst)
        files = olms[obj]
        seq_ok = len(lst) == len(files)
        for i, inst in enumerate(lst):
            m = lib.get(inst["model"])
            o = files.get(i)
            if o is None:
                seq_ok = False
                continue
            total += 1
            e = o.entries[0]
            same = m.pmtl and tuple(m.pmtl[0]) == (e["w"], e["h"])
            pm_ok += bool(same)
            seq_ok &= bool(same)
            ver_ok += abs(m.version - o.model_version) < 1e-7
            ts_ok += tuple(m.timestamp) < tuple(o.timestamp)
            lm_ok += m.type == 3 and m.lightmap_count == o.count
        ok += seq_ok
    print("  buildings whose instance list reproduces every .olm (w,h) in order: %d / %d" % (ok, len(lists)))
    print("  per file: PMTL==.olm size %d/%d; HSEM version==olm[1] %d; HSEM time < olm time %d; type 3 & "
          "D3DR lightmaps == olm count %d" % (pm_ok, total, ver_ok, ts_ok, lm_ok))

    print("\n== content test: baked brightness follows the sun on each instance's own .olm")
    def samples(m, R, olm, vflip=False):
        xs, ys = [], []
        for blk, a, b2, c in m.triangles():
            p = [m.verts[q]["pos"] for q in (a, b2, c)]
            u = [p[1][i] - p[0][i] for i in range(3)]
            w = [p[2][i] - p[0][i] for i in range(3)]
            n = (u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0])
            ln = math.sqrt(sum(q * q for q in n))
            if ln == 0:
                continue
            vn = [sum(m.verts[q]["nrm"][i] for q in (a, b2, c)) for i in range(3)]
            if sum(vn[i] * n[i] for i in range(3)) < 0:
                n = tuple(-q for q in n)
            nw = mat_vec(R, [q / ln for q in n])
            uu = sum(m.verts[q]["uv1"][0] for q in (a, b2, c)) / 3
            vv = sum(m.verts[q]["uv1"][1] for q in (a, b2, c)) / 3
            col = olm.sample(0, uu, 1 - vv if vflip else vv)
            xs.append(max(0.0, sum(nw[i] * L.sun_dir[i] for i in range(3))))
            ys.append(0.299 * col[0] + 0.587 * col[1] + 0.114 * col[2])
        return xs, ys
    def corr(xs, ys):
        n = len(xs)
        mx, my = sum(xs) / n, sum(ys) / n
        sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
        sy = math.sqrt(sum((y - my) ** 2 for y in ys))
        return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy)
    pool = {}
    for obj, (b, lst) in lists.items():
        for i, inst in enumerate(lst):
            e = olms[obj][i].entries[0]
            pool.setdefault((e["w"], e["h"]), []).append((obj, i))
    A = ([], [])
    Bs = ([], [])
    per_ok = per_n = 0
    for obj, (b, lst) in lists.items():
        for i, inst in enumerate(lst):
            m = lib.get(inst["model"])
            o = olms[obj][i]
            e = o.entries[0]
            if e["w"] * e["h"] < 64:
                continue
            xs, ys = samples(m, inst["R"], o)
            others = [p for p in pool[(e["w"], e["h"])] if lists[p[0]][1][p[1]]["base"] != inst["base"]]
            if len(xs) < 8 or not others:
                continue
            A[0].extend(xs); A[1].extend(ys)
            x2, y2 = samples(m, inst["R"], olms[others[0][0]][others[0][1]])
            Bs[0].extend(x2); Bs[1].extend(y2)
            if len(set(xs)) > 1 and len(set(ys)) > 1 and len(set(y2)) > 1:
                per_n += 1
                per_ok += corr(xs, ys) > corr(x2, y2)
    print("  all instances, own .olm:            corr = %.3f over %d triangles" % (corr(*A), len(A[0])))
    print("  same-size .olm of another model:    corr = %.3f" % corr(*Bs))
    print("  instances where own .olm correlates better than the swapped one: %d / %d" % (per_ok, per_n))
    for label, kw in (("ATTA as v' = v*M (recovered)", True), ("ATTA as v' = M*v", False)):
        X, Y = [], []
        for obj, (b, lst) in lists.items():
            for i, inst in enumerate(instance_list(b, lib, atta_row_vector=kw)):
                if "/" not in inst["source"]:
                    continue                          # attachments only
                o = olms[obj][i]
                if o.entries[0]["w"] * o.entries[0]["h"] < 64:
                    continue
                xs, ys = samples(lib.get(inst["model"]), inst["R"], o)
                X.extend(xs); Y.extend(ys)
        print("  attachments only, %-30s corr = %.3f over %d triangles" % (label, corr(X, Y), len(X)))

    print("\n== orientation test (main building models, LOD 1)")
    for label, vflip, yaw_sign in (("recovered (v down rows, R = Rz(+yaw))", False, 1), ("v flipped", True, 1),
                                    ("yaw sign flipped", False, -1)):
        xs, ys = [], []
        for obj, (b, lst) in lists.items():
            inst = lst[0]
            m = lib.get(inst["model"])
            o = olms[obj][0]
            yaw = b["orientation"][2] * yaw_sign
            R = euler(0, 0, yaw)
            for blk, a, b2, c in m.triangles():
                p = [m.verts[q]["pos"] for q in (a, b2, c)]
                u = [p[1][i] - p[0][i] for i in range(3)]
                w = [p[2][i] - p[0][i] for i in range(3)]
                n = (u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0])
                ln = math.sqrt(sum(q * q for q in n))
                if ln == 0:
                    continue
                vn = [sum(m.verts[q]["nrm"][i] for q in (a, b2, c)) for i in range(3)]
                if sum(vn[i] * n[i] for i in range(3)) < 0:
                    n = tuple(-q for q in n)       # orient like the stored normals
                nw = mat_vec(R, [q / ln for q in n])
                uu = sum(m.verts[q]["uv1"][0] for q in (a, b2, c)) / 3
                vv = sum(m.verts[q]["uv1"][1] for q in (a, b2, c)) / 3
                if vflip:
                    vv = 1 - vv
                col = o.sample(0, uu, vv)
                xs.append(max(0.0, sum(nw[i] * L.sun_dir[i] for i in range(3))))
                ys.append(0.299 * col[0] + 0.587 * col[1] + 0.114 * col[2])
        print("  %-38s corr(luminance, max(0, n.sun)) = %.3f over %d triangles" % (label, corr(xs, ys), len(xs)))

    print("\n== lit path (no .olm): sun dir %s, front %s, object ambient %s"
          % (tuple(round(c, 4) for c in L.sun_dir), L.front, [round(c, 4) for c in L.ambient_object]))
    print("  vertex colour for an up-facing normal: %s; facing away: %s"
          % (tuple(round(c, 3) for c in L.vertex_colour((0, 0, 1))), tuple(round(c, 3) for c in L.vertex_colour((0, 1, 0)))))
    print("  EditRigidObj effect parameters in level 1: %s" % data["edit_rigid_effects"])

    if png_dir:
        render_checks(png_dir, lib, olms, lists, L)
    return lib, olms, lists


def render_checks(png_dir, lib, olms, lists, L, obj="obj00014"):
    b, lst = lists[obj]
    inst = lst[0]
    m = lib.get(inst["model"])
    o = olms[obj][0]
    e = o.entries[0]
    W, H = e["w"], e["h"]
    S = 4
    rows = [bytearray(3 * W * S) for _ in range(H * S)]
    for y in range(H * S):
        for x in range(W * S):
            c = o.rgb(0, x // S, y // S)
            rows[y][3 * x:3 * x + 3] = bytes(c)
    def line(p, q):
        n = int(max(abs(p[0] - q[0]), abs(p[1] - q[1]))) + 1
        for k in range(n + 1):
            t = k / n
            x = int(p[0] + (q[0] - p[0]) * t)
            y = int(p[1] + (q[1] - p[1]) * t)
            if 0 <= x < W * S and 0 <= y < H * S:
                rows[y][3 * x:3 * x + 3] = b"\x00\xff\x00"
    for blk, a, b2, c in m.triangles():
        pts = [(m.verts[q]["uv1"][0] * W * S, m.verts[q]["uv1"][1] * H * S) for q in (a, b2, c)]
        line(pts[0], pts[1]); line(pts[1], pts[2]); line(pts[2], pts[0])
    p1 = os.path.join(png_dir, "olm_%s_00000_uv1.png" % obj)
    write_png(p1, W * S, H * S, rows)
    print("wrote", p1)
    # textured + lightmapped render of the building's LOD-1 instances (main model + attachments)
    mtp = read_mtp(open(LOC0 + "/level1/level1.mtp", "rb").read())
    texarc = {}
    for p in (LOC0 + "/level1/textures/level1.res", LOC0 + "/common/textures/location0.res"):
        for n, body in ilff_members(open(p, "rb").read()):
            nm = re.search(r"([^/]+)\.tex$", n).group(1)
            texarc.setdefault(nm, body)
    texcache = {}
    def tex(name):
        if name not in texcache:
            texcache[name] = decode_loop11(texarc[name]) if name in texarc else None
        return texcache[name]
    insts = [(i, x) for i, x in enumerate(lst) if x["lod"] == 1 and x["source"].startswith("building")]
    tris = []
    for i, x in insts:
        mm = lib.get(x["model"])
        olm = olms[obj].get(i)
        names = mtp.get(x["model"], [])
        for blk, a, b2, c in mm.triangles():
            P = []
            for q in (a, b2, c):
                v = mm.verts[q]
                wp = [x["t"][k] + sum(x["R"][k][j] * v["pos"][j] for j in range(3)) for k in range(3)]
                P.append((wp, v["uv0"], v["uv1"]))
            tris.append((P, names[blk["slot"]] if blk["slot"] != 0xFFFF and blk["slot"] < len(names) else None, olm))
    # oblique orthographic view from the sun-ish side
    az = math.radians(225)
    el = math.radians(35)
    fwd = (math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), -math.sin(el))
    right = (-math.sin(az), math.cos(az), 0.0)
    up = (right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0])
    pts = [p for t in tris for p, _, _ in t[0]]
    cx = [sum(p[k] for p in pts) / len(pts) for k in range(3)]
    proj = lambda p: (sum((p[k] - cx[k]) * right[k] for k in range(3)), sum((p[k] - cx[k]) * up[k] for k in range(3)),
                      sum((p[k] - cx[k]) * fwd[k] for k in range(3)))
    pr = [proj(p) for p in pts]
    ext = max(max(abs(q[0]) for q in pr), max(abs(q[1]) for q in pr)) * 1.05
    WW, HH = 480, 360
    sc = min(WW, HH) / (2 * ext)
    zb = [[1e30] * WW for _ in range(HH)]
    img = [[(40, 40, 50)] * WW for _ in range(HH)]
    for P, tname, olm in tris:
        T = tex(tname) if tname else None
        q = [proj(p[0]) for p in P]
        s = [(WW / 2 + v[0] * sc, HH / 2 - v[1] * sc, v[2]) for v in q]
        x0, x1 = max(0, int(min(v[0] for v in s))), min(WW - 1, int(max(v[0] for v in s)) + 1)
        y0, y1 = max(0, int(min(v[1] for v in s))), min(HH - 1, int(max(v[1] for v in s)) + 1)
        d = (s[1][1] - s[2][1]) * (s[0][0] - s[2][0]) + (s[2][0] - s[1][0]) * (s[0][1] - s[2][1])
        if d == 0:
            continue
        for yy in range(y0, y1 + 1):
            for xx in range(x0, x1 + 1):
                px, py = xx + 0.5, yy + 0.5
                l1 = ((s[1][1] - s[2][1]) * (px - s[2][0]) + (s[2][0] - s[1][0]) * (py - s[2][1])) / d
                l2 = ((s[2][1] - s[0][1]) * (px - s[2][0]) + (s[0][0] - s[2][0]) * (py - s[2][1])) / d
                l3 = 1 - l1 - l2
                if min(l1, l2, l3) < 0:
                    continue
                z = l1 * s[0][2] + l2 * s[1][2] + l3 * s[2][2]
                if z >= zb[yy][xx]:
                    continue
                zb[yy][xx] = z
                u0 = l1 * P[0][1][0] + l2 * P[1][1][0] + l3 * P[2][1][0]
                v0 = l1 * P[0][1][1] + l2 * P[1][1][1] + l3 * P[2][1][1]
                u1 = l1 * P[0][2][0] + l2 * P[1][2][0] + l3 * P[2][2][0]
                v1 = l1 * P[0][2][1] + l2 * P[1][2][1] + l3 * P[2][2][1]
                if T:
                    tw, th, tp = T
                    base = tp[(int(v0 * th) % th) * tw + (int(u0 * tw) % tw)]       # WRAP, point sample
                else:
                    base = (255, 255, 255)
                lm = olm.sample(0, u1, v1) if olm else (255, 255, 255)
                img[yy][xx] = tuple(int(base[k] * lm[k] / 255) for k in range(3))
    p2 = os.path.join(png_dir, "building_%s_lightmapped.png" % obj)
    write_png(p2, WW, HH, [b"".join(bytes(c) for c in r) for r in img])
    print("wrote", p2, "(%d instances, %d triangles, MODULATE x1 of texture and .olm)" % (len(insts), len(tris)))


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="object lighting self-check")
    ap.add_argument("--png-dir")
    a = ap.parse_args()
    self_check(a.png_dir)
