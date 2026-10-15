#!/usr/bin/env python3
"""Skeletons, skinned ("bone", MEF type 1) models and animations of
Project I.G.I. (igi.exe, 2000). Reference implementation for
web-port/src/loaders/skeleton.ts and anim.ts; see docs/characters.md.

Run from the repository root:

    python3 tools/igi_anim.py [--game-dir "Game Files"] [--png-dir DIR]

Without arguments it decodes every common/anims/*.iff file and every bone
model of the level-1 and location0 archives, runs the self-checks listed in
docs/characters.md and prints a summary. --png-dir writes orthographic
previews (bind pose, animation frames, first-person arms).

Evidence labels: observed (measured on the files), recovered (igi.exe code,
addresses given), inferred.

Animation container (.iff, EA-IFF, big-endian chunk sizes)       [observed]
    FORM BOBJ
      FORM BOBH
        BOSH  u32 skeleton id (= 'Bone Heirachy' task value), u32 bone count
        PLST  i32 parent per bone (-1 = root; parent < index)
        TLST  f32[3] per bone: offset from the parent in the parent's frame
      FORM BOAL
        BALH  u32 clip count, u32 clip-id capacity (max id + 1)
        clip count x FORM BOAN
          BOAH  f32 duration (ticks), u32 flags (bit 31 = loop), i32 clip id
          BOTH  u32 n; BOTD n x 40 bytes (absent when n = 0):
                f32 pos[3], f32 time, f32 c[3], f32 d[3]    (root translation)
          bone count x (BORH u32 n; BORD n x 52 bytes:
                f32 q[4] (x,y,z,w), f32 time, f32 a[4], f32 b[4])
          BOEH  u32 n; BOED n x 24 bytes: i32 trigger id, i32 0, f32 time,
                f32[3] (unknown)
    The writer stores BOBJ and BOAL sizes that stop after the 12-byte header
    of their last child FORM; every other size is exact. igi.exe walks the
    chunks by tag (FUN_004cce30), so the reader does the same and checks the
    quirk instead of trusting those two sizes.
    Times are 3ds Max ticks: 4800 per second (FUN_004c93d0 sets the per-frame
    step to 4800 / fps; FUN_004cc860 converts seconds x 4800).    [recovered]
"""
import argparse
import math
import struct
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from igi_formats import FormatError, resource_members  # noqa: E402

TICKS_PER_SECOND = 4800.0
UNITS_PER_METRE = 4096.0
LOOP_FLAG = 0x80000000
TWO_PI = 6.2831854820251465  # f32 constant at 0x531594

ANIM_FILES = ("000", "001", "002", "003", "005", "006")
MODEL_ARCHIVES = ("missions/location0/level1/models/level1.res",
                  "missions/location0/common/models/location0.res")


# --------------------------------------------------------------------------
# quaternion helpers (x, y, z, w); Hamilton product, column vectors
# --------------------------------------------------------------------------

def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz)


def qmat(q):
    """Rotation matrix (row-major, column vectors) exactly as FUN_004ca120."""
    x, y, z, w = q
    return ((1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)),
            (2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)),
            (2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)))


def mvec(m, v):
    return (m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
            m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
            m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2])


def qangle(a, b):
    d = abs(sum(x * y for x, y in zip(a, b)))
    na = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(x * x for x in b))
    return 2 * math.acos(min(1.0, d / na))


def _arc(q0, q1):
    """FUN_004aa7b0: shortest-arc angle, 1/sin and whether q1 is negated."""
    dot = sum(a * b for a, b in zip(q0, q1))
    flip = False
    if dot < 0:
        if dot >= -1e-8:
            dot = 0.0
        else:
            flip, dot = True, -dot
    angle = math.acos(min(1.0, dot))
    return angle, (1.0 / math.sin(angle) if angle != 0 else 1.0), flip


def _slerp(q0, q1, u):
    """The exe's slerp: lerp below 0.01 rad, copy q0 at exactly 0."""
    angle, inv, flip = _arc(q0, q1)
    if flip:
        q1 = tuple(-c for c in q1)
    if angle == 0:
        return tuple(q0)
    if angle >= 0.009999999776482582:
        c0 = math.sin(angle - u * angle) * inv
        c1 = math.sin(u * angle) * inv
    else:
        c0, c1 = 1 - u, u
    return tuple(c0 * a + c1 * b for a, b in zip(q0, q1))


# --------------------------------------------------------------------------
# .iff animation files
# --------------------------------------------------------------------------

class _Reader:
    def __init__(self, data):
        self.data = data
        self.pos = 0

    def _header(self, tag):
        if self.pos + 8 > len(self.data):
            raise FormatError(f"truncated chunk header at {self.pos:#x}")
        found = self.data[self.pos:self.pos + 4]
        if found != tag.encode():
            raise FormatError(f"expected {tag} at {self.pos:#x}, found {found!r}")
        size = struct.unpack_from(">I", self.data, self.pos + 4)[0]
        self.pos += 8
        return size

    def form(self, form_type):
        start = self.pos
        size = self._header("FORM")
        found = self.data[self.pos:self.pos + 4]
        if found != form_type.encode():
            raise FormatError(f"expected FORM {form_type} at {start:#x}, found {found!r}")
        self.pos += 4
        return start, size

    def chunk(self, tag, expect=None):
        start = self.pos
        size = self._header(tag)
        if self.pos + size > len(self.data):
            raise FormatError(f"{tag} at {start:#x} runs past the end of the file")
        if expect is not None and size != expect:
            raise FormatError(f"{tag} at {start:#x} has {size} bytes, expected {expect}")
        payload = self.data[self.pos:self.pos + size]
        self.pos += size + (size & 1)
        return payload


class Clip:
    __slots__ = ("id", "duration", "flags", "translation", "rotation", "events", "offset")

    @property
    def loop(self):
        return bool(self.flags & LOOP_FLAG)

    @property
    def seconds(self):
        return self.duration / TICKS_PER_SECOND


class AnimFile:
    __slots__ = ("skeleton_id", "parents", "offsets", "id_capacity", "clips")


def read_iff(data):
    r = _Reader(data)
    _, bobj_size = r.form("BOBJ")
    bobh_at, bobh_size = r.form("BOBH")
    skel_id, bone_count = struct.unpack("<2I", r.chunk("BOSH", 8))
    if not 0 < bone_count <= 256:
        raise FormatError(f"BOSH bone count {bone_count} at {bobh_at:#x}")
    parents = struct.unpack(f"<{bone_count}i", r.chunk("PLST", 4 * bone_count))
    for i, p in enumerate(parents):
        if (i == 0 and p != -1) or (i > 0 and not 0 <= p < i):
            raise FormatError(f"PLST parent {p} of bone {i} is not an earlier bone")
    tl = r.chunk("TLST", 12 * bone_count)
    offsets = [struct.unpack_from("<3f", tl, 12 * i) for i in range(bone_count)]
    if r.pos != bobh_at + 8 + bobh_size:
        raise FormatError(f"FORM BOBH at {bobh_at:#x} size does not match its chunks")
    boal_at, boal_size = r.form("BOAL")
    if bobj_size != 4 + 8 + bobh_size + 12:
        raise FormatError("FORM BOBJ size differs from the observed writer quirk")
    clip_count, id_capacity = struct.unpack("<2I", r.chunk("BALH", 8))
    clips = {}
    last_at = None
    for _ in range(clip_count):
        at, size = r.form("BOAN")
        last_at = at
        duration, flags, clip_id = struct.unpack("<fIi", r.chunk("BOAH", 12))
        if not 0 <= clip_id < id_capacity or clip_id in clips:
            raise FormatError(f"BOAH at {at:#x}: clip id {clip_id} invalid or repeated")
        if not duration > 0 or flags & ~LOOP_FLAG:
            raise FormatError(f"BOAH at {at:#x}: duration {duration} / flags {flags:#x}")
        n = struct.unpack("<I", r.chunk("BOTH", 4))[0]
        trans = []
        if n:
            d = r.chunk("BOTD", 40 * n)
            for i in range(n):
                f = struct.unpack_from("<10f", d, 40 * i)
                trans.append((f[0:3], f[3], f[4:7], f[7:10]))
        rot = []
        for b in range(bone_count):
            n = struct.unpack("<I", r.chunk("BORH", 4))[0]
            if n < 1:
                raise FormatError(f"BOAN at {at:#x}: bone {b} has no rotation key")
            d = r.chunk("BORD", 52 * n)
            keys = []
            for i in range(n):
                f = struct.unpack_from("<13f", d, 52 * i)
                keys.append((f[0:4], f[4], f[5:9], f[9:13]))
            rot.append(keys)
        n = struct.unpack("<I", r.chunk("BOEH", 4))[0]
        d = r.chunk("BOED", 24 * n)
        events = [struct.unpack_from("<iif3f", d, 24 * i) for i in range(n)]
        if r.pos != at + 8 + size:
            raise FormatError(f"FORM BOAN at {at:#x} size does not match its chunks")
        for keys in rot + [trans]:
            times = [k[1] for k in keys]
            if times and (times[0] != 0 or any(a >= b for a, b in zip(times, times[1:]))):
                raise FormatError(f"BOAN at {at:#x}: key times must start at 0 and increase")
        c = Clip()
        c.id, c.duration, c.flags, c.translation, c.rotation, c.events, c.offset = (
            clip_id, duration, flags, trans, rot, events, at)
        clips[clip_id] = c
    if r.pos != len(data):
        raise FormatError(f"{len(data) - r.pos} unexplained bytes after the last clip")
    if last_at is not None and boal_at + 8 + boal_size != last_at + 12:
        raise FormatError("FORM BOAL size differs from the observed writer quirk")
    out = AnimFile()
    out.skeleton_id, out.parents, out.offsets, out.id_capacity, out.clips = (
        skel_id, parents, offsets, id_capacity, clips)
    return out


# --------------------------------------------------------------------------
# sampling (FUN_004cb810 rotations, FUN_004caed0 translation; squad and
# Hermite because FUN_004c92d0 sets the interpolation flag 0x7e4d88 = 1)
# --------------------------------------------------------------------------

def sample_rotation(clip, bone, t):
    t = min(max(t, 0.0), clip.duration)  # the exe only samples [0, duration]
    keys = clip.rotation[bone]
    n = len(keys)
    if n == 1:
        return tuple(keys[0][0])
    k = 0
    while k < n and keys[k][1] < t:
        k += 1
    if k < n and keys[k][1] == t:
        return tuple(keys[k][0])
    if k == n:
        if not clip.loop or not clip.duration > keys[-1][1]:
            return tuple(keys[-1][0])
        i, j = n - 1, 0
        u = (t - keys[i][1]) / (clip.duration - keys[i][1])
    elif k == 0:
        return tuple(keys[0][0])
    else:
        i, j = k - 1, k
        u = 1 - (keys[j][1] - t) / (keys[j][1] - keys[i][1])
    s1 = _slerp(keys[i][0], keys[j][0], u)
    s2 = _slerp(keys[i][2], keys[j][3], u)
    return _slerp(s1, s2, 2 * u * (1 - u))


def sample_translation(clip, t):
    t = min(max(t, 0.0), clip.duration)
    keys = clip.translation
    if not keys:
        return (0.0, 0.0, 0.0)
    n = len(keys)
    if n == 1:
        return tuple(keys[0][0])
    k = 0
    while k < n and keys[k][1] < t:
        k += 1
    if k == n:
        return tuple(keys[-1][0])
    if keys[k][1] == t or k == 0:
        return tuple(keys[k][0])
    p0, t0, c0, _ = keys[k - 1]
    p1, t1, _, d1 = keys[k]
    dt = t1 - t0
    u = 1 - (t1 - t) / dt
    u2, u3 = u * u, u * u * u
    h00, h01 = 2 * u3 - 3 * u2 + 1, 3 * u2 - 2 * u3
    h10, g = u - 2 * u2 + u3, u2 - u3
    return tuple(h00 * p0[c] + h01 * p1[c] + dt * (h10 * c0[c] + g * d1[c]) for c in range(3))


def pose(anim, clip, t, root_rotation=(0.0, 0.0, 0.0, 1.0)):
    """World (quaternion, position) per bone in object space (FUN_004c9f50 /
    FUN_004ca120): root at the origin, child = parent * local, child position
    = parent position + parent rotation * TLST. clip=None gives the bind pose
    (identity rotations)."""
    out = []
    for b, parent in enumerate(anim.parents):
        local = sample_rotation(clip, b, t) if clip else (0.0, 0.0, 0.0, 1.0)
        if parent < 0:
            pq, pp = root_rotation, (0.0, 0.0, 0.0)
        else:
            pq, pp = out[parent]
        off = mvec(qmat(pq), anim.offsets[b])
        out.append((qmul(pq, local), (pp[0] + off[0], pp[1] + off[1], pp[2] + off[2])))
    return out


# --------------------------------------------------------------------------
# bone models (.mef type 1)
# --------------------------------------------------------------------------

def mef_chunks(data):
    if len(data) < 20 or data[:4] != b"ILFF" or data[16:20] != b"OCEM":
        raise FormatError("expected ILFF/OCEM model")
    align = struct.unpack_from("<I", data, 8)[0]
    pos = (20 + align - 1) & -align
    chunks = []
    while True:
        if pos + 16 > len(data):
            raise FormatError(f"truncated MEF chunk header at {pos:#x}")
        tag = data[pos:pos + 4].decode("latin1")
        size, al, delta = struct.unpack_from("<3I", data, pos + 4)
        off = (pos + 16 + al - 1) & -al
        if off + size > len(data):
            raise FormatError(f"MEF chunk {tag} at {pos:#x} outside the file")
        chunks.append((tag, off, size))
        if delta == 0:
            return chunks
        pos += delta


def read_bone_model(data):
    """Decode a type-1 MEF. Vertex layout (40 bytes) [observed + recovered,
    FUN_0052be70]: f32 pos[3] (bone space), f32 normal[3], f32 uv[2],
    f32 weight, u16 target vertex, u16 bone. D3DR words 3 and 4 hold the
    extra-influence and primary vertex counts; XTRV = primaries then extras."""
    chunks = mef_chunks(data)
    one = {}
    for tag, off, size in chunks:
        if tag in ("HSEM", "D3DR", "DNER", "XTRV"):
            if tag in one:
                raise FormatError(f"repeated {tag}")
            one[tag] = (off, size)
    for tag in ("HSEM", "D3DR", "DNER", "XTRV"):
        if tag not in one:
            raise FormatError(f"missing {tag}")
    if struct.unpack_from("<I", data, one["HSEM"][0] + 32)[0] != 1:
        raise FormatError("not a bone (type 1) model")
    d3dr = struct.unpack_from("<5I", data, one["D3DR"][0])
    faces, blocks, extra, primary = d3dr[1], d3dr[2], d3dr[3], d3dr[4]
    xo, xs = one["XTRV"]
    if xs != 40 * (primary + extra):
        raise FormatError(f"XTRV holds {xs // 40} vertices, D3DR declares {primary} + {extra}")
    verts = [struct.unpack_from("<8ffHH", data, xo + 40 * i) for i in range(primary + extra)]
    pos = [v[0:3] for v in verts]
    nrm = [v[3:6] for v in verts]
    uv = [v[6:8] for v in verts]
    weight = [v[8] for v in verts]
    target = [v[9] for v in verts]
    bone = [v[10] for v in verts]
    sums = [0.0] * primary
    for i in range(primary):
        sums[i] += weight[i]
    for i in range(primary, primary + extra):
        if target[i] >= primary:
            raise FormatError(f"extra vertex {i} targets {target[i]} >= {primary}")
        sums[target[i]] += weight[i]
    worst = max(abs(s - 1) for s in sums) if sums else 0
    if worst > 1e-4:
        raise FormatError(f"influence weights do not sum to 1 (off by {worst:.2e})")
    do, ds = one["DNER"]
    off = 0
    tris, groups = [], []
    while off < ds:
        at = do + off
        count, _nxt, slot, voff, vcount = struct.unpack_from("<5h", data, at + 12)
        if count < 0 or count % 3 or voff < 0 or vcount < 0 or voff + vcount > primary:
            raise FormatError(f"DNER block +{off} outside the primary vertices")
        idx = struct.unpack_from(f"<{count}H", data, at + 28)
        if any(i >= vcount for i in idx):
            raise FormatError(f"DNER block +{off} index outside its range")
        groups.append((len(tris), count // 3, slot))
        tris += [(voff + idx[i], voff + idx[i + 1], voff + idx[i + 2]) for i in range(0, count, 3)]
        off += 28 + 2 * count
    if off != ds or len(groups) != blocks or len(tris) != faces:
        raise FormatError("DNER blocks disagree with D3DR")
    return {"primary": primary, "extra": extra, "pos": pos, "nrm": nrm, "uv": uv,
            "weight": weight, "target": target, "bone": bone, "tris": tris, "groups": groups}


def skin(model, world, weighted=True):
    """FUN_0052be70. LOD 0 (weighted=True): primary w*(R p + T) plus the
    extras' w*(R p + T) added into their target; other LODs place every
    primary rigidly on its bone and ignore weights and extras."""
    mats = [qmat(q) for q, _ in world]
    out = []
    for i in range(model["primary"]):
        b = model["bone"][i]
        p = mvec(mats[b], model["pos"][i])
        t = world[b][1]
        w = model["weight"][i] if weighted else 1.0
        out.append([w * (p[0] + t[0]), w * (p[1] + t[1]), w * (p[2] + t[2])])
    if weighted:
        for i in range(model["primary"], model["primary"] + model["extra"]):
            b = model["bone"][i]
            p = mvec(mats[b], model["pos"][i])
            t = world[b][1]
            w = model["weight"][i]
            o = out[model["target"][i]]
            for c in range(3):
                o[c] += w * (p[c] + t[c])
    return out


def read_atta(data):
    """ATTA records of any MEF: (name, offset xyz, row-major 3x3, bone)."""
    out = []
    for tag, off, size in mef_chunks(data):
        if tag != "ATTA":
            continue
        if size % 68:
            raise FormatError(f"ATTA size {size} not a multiple of 68")
        for i in range(size // 68):
            at = off + 68 * i
            name = data[at:at + 16].split(b"\0")[0].decode("latin1")
            f = struct.unpack_from("<12f", data, at + 16)
            out.append((name, f[0:3], f[3:12], struct.unpack_from("<i", data, at + 64)[0]))
    return out


def bind_mismatch(model, anim):
    """Distance (units) between where a vertex's primary and extra influences
    put it in the bind pose; zero when the bind pose is the authored pose."""
    world = pose(anim, None, 0)
    worst = 0.0
    for i in range(model["primary"], model["primary"] + model["extra"]):
        t = model["target"][i]
        a = model["pos"][t]
        pa = world[model["bone"][t]][1]
        b = model["pos"][i]
        pb = world[model["bone"][i]][1]
        d = math.dist((a[0] + pa[0], a[1] + pa[1], a[2] + pa[2]),
                      (b[0] + pb[0], b[1] + pb[1], b[2] + pb[2]))
        worst = max(worst, d)
    return worst


# --------------------------------------------------------------------------
# game data access
# --------------------------------------------------------------------------

def load_anims(game):
    return {name: read_iff((game / "common/anims" / f"{name}.iff").read_bytes())
            for name in ANIM_FILES}


def load_bone_models(game):
    models = {}
    for arc in MODEL_ARCHIVES:
        data = (game / arc).read_bytes()
        for name, chunk in resource_members(data):
            if not name.endswith(".mef"):
                continue
            body = chunk.payload(data)
            chunks = mef_chunks(body)
            hsem = [c for c in chunks if c[0] == "HSEM"][0]
            if struct.unpack_from("<I", body, hsem[1] + 32)[0] == 1:
                models[name.split("/")[-1][:-4]] = read_bone_model(body)
    return models


# --------------------------------------------------------------------------
# previews (orthographic, z-buffered, flat Lambert, colour per bone)
# --------------------------------------------------------------------------

def _png(path, w, h, rgb):
    raw = b"".join(b"\0" + bytes(rgb[y * w * 3:(y + 1) * w * 3]) for y in range(h))

    def chunk(tag, payload):
        c = struct.pack(">I", len(payload)) + tag + payload
        return c + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    Path(path).write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                           + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def _bone_colour(b):
    h = (b * 0.61803398875) % 1.0
    i = int(h * 6)
    f = h * 6 - i
    v, s = 0.95, 0.55
    p, q, t = v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))
    return [(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)][i % 6]


def render(panels, path, size=360, metres=2.2, centre=(0.0, 1.0)):
    """panels: list of (positions, model, view) with view 'front' (looking
    along -y, x to the left), 'side' (from +x, y to the right) or 'top'."""
    w, h = size * len(panels), size
    rgb = bytearray([235, 235, 235] * (w * h))
    scale = size / (metres * UNITS_PER_METRE)
    for pi, (pts, model, view) in enumerate(panels):
        zbuf = [-1e30] * (size * size)
        if view == "front":
            proj = [(-p[0], p[2], p[1]) for p in pts]
        elif view == "side":
            proj = [(p[1], p[2], p[0]) for p in pts]
        else:
            proj = [(p[0], p[1], p[2]) for p in pts]
        cx, cy = centre[0] * UNITS_PER_METRE, centre[1] * UNITS_PER_METRE
        scr = [((x - cx) * scale + size / 2, size / 2 - (y - cy) * scale, d) for x, y, d in proj]
        # ground line (z = 0) and 1.8 m tick for front/side views
        if view != "top":
            for gy, col in ((0.0, (90, 90, 90)), (1.8, (200, 60, 60))):
                yy = int(size / 2 - (gy * UNITS_PER_METRE - cy) * scale)
                if 0 <= yy < size:
                    for x in range(size):
                        o = (yy * w + pi * size + x) * 3
                        rgb[o:o + 3] = bytes(col)
        for a, b, c in model["tris"]:
            pa, pb, pc = pts[a], pts[b], pts[c]
            n = ((pb[1] - pa[1]) * (pc[2] - pa[2]) - (pb[2] - pa[2]) * (pc[1] - pa[1]),
                 (pb[2] - pa[2]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[2] - pa[2]),
                 (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]))
            ln = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2) or 1
            light = (0.3, 0.8, 0.6) if view != "side" else (0.8, 0.3, 0.6)
            shade = 0.35 + 0.65 * abs(n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) / ln
            col = _bone_colour(model["bone"][a])
            col = bytes(int(255 * min(1, c_ * shade)) for c_ in col)
            sa, sb, sc = scr[a], scr[b], scr[c]
            x0 = max(0, int(min(sa[0], sb[0], sc[0])))
            x1 = min(size - 1, int(max(sa[0], sb[0], sc[0])) + 1)
            y0 = max(0, int(min(sa[1], sb[1], sc[1])))
            y1 = min(size - 1, int(max(sa[1], sb[1], sc[1])) + 1)
            den = (sb[1] - sc[1]) * (sa[0] - sc[0]) + (sc[0] - sb[0]) * (sa[1] - sc[1])
            if abs(den) < 1e-9:
                continue
            for y in range(y0, y1 + 1):
                for x in range(x0, x1 + 1):
                    l1 = ((sb[1] - sc[1]) * (x - sc[0]) + (sc[0] - sb[0]) * (y - sc[1])) / den
                    l2 = ((sc[1] - sa[1]) * (x - sc[0]) + (sa[0] - sc[0]) * (y - sc[1])) / den
                    l3 = 1 - l1 - l2
                    if l1 < 0 or l2 < 0 or l3 < 0:
                        continue
                    d = l1 * sa[2] + l2 * sb[2] + l3 * sc[2]
                    zi = y * size + x
                    if d > zbuf[zi]:
                        zbuf[zi] = d
                        o = (y * w + pi * size + x) * 3
                        rgb[o:o + 3] = col
    _png(path, w, h, rgb)


# --------------------------------------------------------------------------
# self-checks
# --------------------------------------------------------------------------

def foot_planted_fraction(anim, clip, foot_bones, steps=48):
    """Share of a loop during which some foot moves < 0.25 m/s in object
    space once the root translation is added (FUN_00488760 adds it)."""
    dt = clip.duration / steps
    prev = None
    planted = 0
    for s in range(steps + 1):
        t = s * dt
        world = pose(anim, clip, t)
        root = sample_translation(clip, t)
        feet = [tuple(world[b][1][c] + root[c] for c in range(3)) for b in foot_bones]
        if prev is not None:
            speed = min(math.dist(f, p) for f, p in zip(feet, prev)) / UNITS_PER_METRE / (dt / TICKS_PER_SECOND)
            planted += speed < 0.25
        prev = feet
    return planted / steps


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--game-dir", default="Game Files")
    ap.add_argument("--png-dir")
    ap.add_argument("--list", action="store_true", help="print every clip of every file")
    args = ap.parse_args(argv)
    game = Path(args.game_dir)
    failures = []

    def check(ok, message):
        print(("ok    " if ok else "FAIL  ") + message)
        if not ok:
            failures.append(message)

    anims = load_anims(game)
    for name, a in anims.items():
        loops = sum(c.loop for c in a.clips.values())
        check(a.skeleton_id == int(name), f"{name}.iff: skeleton {a.skeleton_id}, {len(a.parents)} bones, "
              f"{len(a.clips)} clips ({loops} loop), ids < {a.id_capacity}")
    models = load_bone_models(game)
    check(len(models) == 26, f"{len(models)} bone models decode (weights sum to 1, blocks inside primaries)")
    for name, m in sorted(models.items()):
        skel = anims["005"] if name.startswith("005_") else anims["001"]
        check(max(m["bone"]) < len(skel.parents), f"{name}: {m['primary']} + {m['extra']} vertices, "
              f"bones {min(m['bone'])}..{max(m['bone'])} < {len(skel.parents)}")

    # bind pose = authored pose: every vertex's influences agree
    for name in ("000_01_1", "001_01_1", "003_01_1", "015_01_1", "019_01_1", "005_01_1"):
        m = models[name]
        results = {k: bind_mismatch(m, a) for k, a in anims.items() if len(a.parents) > max(m["bone"])}
        best = min(results, key=results.get)
        detail = ", ".join(f"{k}: {v / 40.96:.2f} cm" for k, v in sorted(results.items()))
        if name.startswith("005_"):
            # observed: the arms' shoulder/elbow influences disagree in the
            # identity pose (fingers agree exactly); reported, not a failure
            print(f"      {name} bind pose vs skeleton {best}: worst influence disagreement {detail}")
        else:
            check(results[best] < 0.015 * UNITS_PER_METRE, f"{name} bind pose fits skeleton {best} ({detail})")
        world = pose(anims[best], None, 0)
        pts = skin(m, world)
        zs = [p[2] for p in pts]
        print(f"      {name}: bind-pose height {(max(zs) - min(zs)) / UNITS_PER_METRE:.3f} m "
              f"(z {min(zs) / UNITS_PER_METRE:+.3f} .. {max(zs) / UNITS_PER_METRE:+.3f} m from the root)")

    # first-person rig: magazine (52) and moving-part (55) bones sit at the
    # gun models' ATTA part offsets relative to the gun bone (3)
    arms = anims["005"]
    data = (game / MODEL_ARCHIVES[1]).read_bytes()
    gun_models = {n.split("/")[-1][:-4]: c.payload(data) for n, c in resource_members(data) if n.endswith(".mef")}
    for gun, clip_id, parts in (("103_01_1", 18, {52: "103_02_1"}), ("100_01_1", 10, {52: "100_03_1", 55: "100_02_1"}),
                                ("117_01_1", 14, {52: "117_03_1", 55: "117_02_1"}), ("111_01_1", 6, {52: "111_02_1", 55: "111_03_1"})):
        atta = {a[0]: a[1] for a in read_atta(gun_models[gun])}
        world = pose(arms, arms.clips[clip_id], 0)
        m3 = qmat(world[3][0])
        worst = 0.0
        for bone, part in parts.items():
            d = [world[bone][1][i] - world[3][1][i] for i in range(3)]
            local = [sum(m3[r][c] * d[r] for r in range(3)) for c in range(3)]
            worst = max(worst, math.dist(local, atta[part]))
        check(worst < 0.01 * UNITS_PER_METRE, f"005 clip {clip_id}: gun parts of {gun} on bones 52/55 within "
              f"{worst / 40.96:.2f} cm of their ATTA offsets from bone 3")

    # loops: wrap step vs the largest one-frame (160 tick) step, stride, planted feet
    body = anims["001"]
    for cid in sorted(body.clips):
        c = body.clips[cid]
        if not c.loop or len(c.translation) < 2:
            continue
        end = sample_translation(c, c.duration)
        start = sample_translation(c, 0)
        stride = math.hypot(end[0] - start[0], end[1] - start[1]) / UNITS_PER_METRE
        bones = range(len(body.parents))
        wrap = max(qangle(sample_rotation(c, b, c.duration - 1e-3), sample_rotation(c, b, 0)) for b in bones)
        frame = max(qangle(sample_rotation(c, b, t), sample_rotation(c, b, t + 160))
                    for b in bones for t in range(0, int(c.duration) - 160, 160))
        planted = foot_planted_fraction(body, c, (26, 31))
        print(f"      001 clip {cid:3d}: {c.seconds:5.2f} s loop, {stride:5.2f} m/cycle = "
              f"{stride / c.seconds:4.2f} m/s, wrap step {math.degrees(wrap):4.1f} deg "
              f"(largest 1/30 s step {math.degrees(frame):4.1f}), a foot planted {planted:4.0%}")
    check(foot_planted_fraction(body, body.clips[4], (26, 31)) > 0.7, "walk clip 4 keeps a foot planted > 70% of the cycle")

    if args.list:
        for name, a in anims.items():
            for cid in sorted(a.clips):
                c = a.clips[cid]
                root = sample_translation(c, 0)
                end = sample_translation(c, c.duration)
                print(f"{name}.iff clip {cid:3d}: {c.seconds:6.2f} s {'loop' if c.loop else '    '} "
                      f"keys(root) {len(c.translation):3d} root z {root[2] / UNITS_PER_METRE:+.2f} -> "
                      f"{end[2] / UNITS_PER_METRE:+.2f} m, moves {math.hypot(end[0] - root[0], end[1] - root[1]) / UNITS_PER_METRE:5.2f} m, "
                      f"events {[(e[0], round(e[2])) for e in c.events]}")

    if args.png_dir:
        out = Path(args.png_dir)
        out.mkdir(parents=True, exist_ok=True)
        for name, skel in (("003_01_1", "001"), ("019_01_1", "001"), ("000_01_1", "000"), ("001_01_1", "001")):
            m = models[name]
            # bind pose, pelvis raised by the idle clip's root height (feet on z = 0)
            root_z = sample_translation(body.clips[2], 0)[2]
            pts = [(p[0], p[1], p[2] + root_z) for p in skin(m, pose(anims[skel], None, 0))]
            render([(pts, m, "front"), (pts, m, "side")], out / f"bind_{name}_skel{skel}.png")
        m = models["003_01_1"]
        for cid in (2, 4, 3, 34, 57, 24, 25, 29):
            if cid not in body.clips:
                continue
            c = body.clips[cid]
            panels = []
            for k in range(4):
                t = c.duration * k / 4 if c.loop else c.duration * k / 3
                world = pose(body, c, t)
                root = sample_translation(c, t)
                # loops are drawn in place (forward root motion removed)
                pts = [(p[0] + root[0], p[1] + root[1] - (root[1] if c.loop else 0), p[2] + root[2])
                       for p in skin(m, world)]
                panels.append((pts, m, "side"))
            render(panels, out / f"anim001_{cid:03d}_003_01_1.png", size=260, metres=2.4)
        arms = models["005_01_1"]
        a5 = anims["005"]
        for cid in (18, 19, 20, 21, 2):
            if cid not in a5.clips:
                continue
            c = a5.clips[cid]
            # camera at the origin looking along +y: arms root at the clip's root translation
            world = pose(a5, c, 0)
            root = sample_translation(c, 0)
            pts = [(p[0] + root[0], p[1] + root[1], p[2] + root[2]) for p in skin(arms, world)]
            panels = [(pts, arms, view) for view in ("side", "top", "front")]
            render(panels, out / f"arms005_{cid:03d}.png", size=300, metres=1.2, centre=(0.0, 0.0))
        print(f"      previews written to {out}")

    print(f"{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
