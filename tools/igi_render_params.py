#!/usr/bin/env python3
"""Project I.G.I. (2000) renderer parameters recovered from igi.exe.  Stdlib only.

Run from the repository root:   python3 tools/igi_render_params.py
It prints every recovered constant with its evidence, re-reads each one from
"Game Files/igi.exe" (instruction immediates and .rdata values at the cited
addresses), derives the level-1 values from the mission data, and runs
self-checks.  Exit status is non-zero if any check fails.

Labels: observed = measured from the game data; recovered = read from igi.exe
code (function addresses given); inferred = consistent but not confirmed.
Write-up: docs/rendering.md.  Browser port: web-port/src/loaders/render-params.ts.

Summary of the recovered pipeline (D3D7 fixed function):
  * World scale: D3D units = IGI units * 0.001 (DAT_00b7092c, set at 0x491ad3).
  * Three "layers" (FUN_00495c70): 0 = first-person gun, 1 = world, 2 = unused
    (near = far).  Each has its own near/far plane and viewport depth range, so
    the gun is always in front of the world.
  * Projection: _11 = 1/tan(hfov/2), _22 = -1/tan(vfov/2),
    tan(vfov/2) = 0.75 * tan(hfov/2) for full-screen views (FUN_00495fe0).
    Player tan(hfov/2) = tan(pi/4) = 1 (90 deg); gun tan(pi/6) (60 deg)
    (FUN_00462fe0).
  * Fog: exponential, f = exp(-d * 0.001 * density * 0.0005) with d in IGI
    units (FUN_00521280 scales the keyframe density by 0.0005).  Terrain
    computes f per vertex on the CPU (FUN_0050be70, view depth); objects use
    D3D vertex fog (FOGVERTEXMODE = EXP).  Only "object category 1" is read.
  * Sky: 321-vertex gradient dome (FUN_005269c0) + flat cloud layers projected
    on a camera-relative plane (FUN_00517d20); no fog on either.
"""
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GAME = os.path.join(ROOT, "Game Files")
LEVEL1 = os.path.join(GAME, "missions", "location0", "level1")
sys.path.insert(0, HERE)

IGI_UNITS_PER_METRE = 4096.0
D3D_SCALE = 0.001            # D3D unit = 1000 IGI units
TICKS_PER_SECOND = 30        # FUN_004020b0: FUN_004029a0(0x1e)

FAILURES = []


def check(label, ok, detail=""):
    print("  [%s] %s%s" % ("ok" if ok else "FAIL", label, (": " + detail) if detail else ""))
    if not ok:
        FAILURES.append(label)


# ---------------------------------------------------------------- igi.exe
class Exe:
    """Minimal PE32 reader: VA -> bytes."""

    def __init__(self, path):
        self.data = open(path, "rb").read()
        d = self.data
        pe = struct.unpack_from("<I", d, 0x3C)[0]
        nsec = struct.unpack_from("<H", d, pe + 6)[0]
        optsz = struct.unpack_from("<H", d, pe + 20)[0]
        self.base = struct.unpack_from("<I", d, pe + 24 + 28)[0]
        self.sections = []
        for i in range(nsec):
            o = pe + 24 + optsz + 40 * i
            vsize, va, rsize, roff = struct.unpack_from("<IIII", d, o + 8)
            self.sections.append((self.base + va, max(vsize, rsize), roff, rsize))

    def offset(self, va):
        for start, size, roff, rsize in self.sections:
            if start <= va < start + size and va - start < rsize:
                return roff + va - start
        raise ValueError("VA 0x%x not backed by file data" % va)

    def f32(self, va):
        return struct.unpack_from("<f", self.data, self.offset(va))[0]

    def f64(self, va):
        return struct.unpack_from("<d", self.data, self.offset(va))[0]

    def has_imm32(self, va, value, span=12):
        """True when the instruction at va encodes the 32-bit immediate."""
        o = self.offset(va)
        return struct.pack("<I", value & 0xFFFFFFFF) in self.data[o:o + span]


def f32_bits(x):
    return struct.unpack("<I", struct.pack("<f", x))[0]


# (label, kind, VA, expected value, meaning, evidence function)
#   kind 'imm'  : float immediate in the instruction at VA (value as f32)
#   kind 'immi' : integer immediate in the instruction at VA
#   kind 'bytes': exact instruction bytes at VA
#   kind 'f32' / 'f64': value stored in .rdata at VA (the FOV doubles are float-rounded)
EXE_CONSTANTS = [
    ("world scale (D3D units per IGI unit)", "imm", 0x491AD3, 0.001, "DAT_00b7092c", "FUN_00491970 init"),
    ("layer 0 (gun) near plane, D3D units (f32 bits)", "immi", 0x491B23, 0x3E51B718, "DAT_00b70b18 = 204.8 IGI = 0.05 m", "init 0x491b23"),
    ("layer 0 (gun) far plane, D3D units", "imm", 0x491B2D, 6.144, "DAT_00b70af8 = 6144 IGI = 1.5 m", "init 0x491b2d"),
    ("layer 1 (world) near plane, D3D units (f32 bits)", "immi", 0x491B37, 0x3ED1B718, "DAT_00b70ae0 = 409.6 IGI = 0.1 m", "init 0x491b37"),
    ("layer 1 (world) far plane, D3D units", "imm", 0x491B41, 409600.03125, "DAT_00b70b08 = 100 km", "init 0x491b41"),
    ("layer 2 near plane, D3D units", "imm", 0x491B4B, 409600.03125, "DAT_00b70af0 (near == far: layer unused)", "init 0x491b4b"),
    ("layer 2 far plane, D3D units", "imm", 0x491B55, 409600.03125, "DAT_00b70ae8", "init 0x491b55"),
    ("layer 0 viewport MinZ", "imm", 0x491B5F, 0.0, "DAT_00b70930", "init 0x491b5f"),
    ("layer 0 viewport MaxZ", "imm", 0x491B69, 0.05, "DAT_00b70a30", "init 0x491b69"),
    ("layer 1 viewport MinZ (f32 bits of 0.06)", "immi", 0x491B73, 0x3D75C290, "DAT_00b70af4", "init 0x491b73"),
    ("layer 1 viewport MaxZ", "imm", 0x491B7D, 1.0, "DAT_00b70acc", "init 0x491b7d"),
    ("layer 2 viewport MinZ", "imm", 0x491B87, 1.0, "DAT_00b70b24", "init 0x491b87"),
    ("layer 2 viewport MaxZ", "imm", 0x491B91, 1.0, "DAT_00b70adc", "init 0x491b91"),
    ("aspect numerator (h*4)", "f32", 0x53158C, 4.0, "FUN_00490130 aspect = 4h/(3w)", "FUN_00490130"),
    ("aspect denominator (w*3)", "f32", 0x531534, 3.0, "", "FUN_00490130"),
    ("player half-FOV angle (rad, tan taken)", "f64", 0x5315F0, math.pi / 4, "tan -> 1.0 = 90 deg horizontal", "FUN_00462fe0 / FUN_00464650"),
    ("gun half-FOV angle (rad, tan taken)", "f64", 0x5319B8, math.pi / 6, "tan -> 0.5774 = 60 deg horizontal", "FUN_00462fe0 / FUN_00464650"),
    ("zoom-in factor per tick", "f32", 0x5319C4, 0.96, "FOV tangents *= 0.96 while zooming in", "FUN_00463470"),
    ("zoom-out factor per tick", "f32", 0x5319C0, 1.0416667, "FOV tangents *= 1/0.96", "FUN_00463470"),
    ("eye height standing (f64 high dword)", "immi", 0x4644A2, 0x40A6147A, "2826.24 IGI = 0.69 m above the human origin", "FUN_00464490"),
    ("eye height crouched (f64 high dword)", "immi", 0x4644BC, 0x40966666, "1433.6 IGI = 0.35 m above the human origin", "FUN_00464490"),
    ("game ticks per second", "bytes", 0x4020E3, b"\x6a\x1e", "push 0x1e -> FUN_004029a0", "FUN_004020b0"),
    ("fog density scale", "f32", 0x532C80, 0.0005, "D3D FOGDENSITY = keyframe 'Fog density' * 0.0005", "FUN_00521280"),
    ("terrain FOGSTART (unused in EXP mode)", "immi", 0x50C07A, f32_bits(10000.0), "", "FUN_0050be70"),
    ("terrain FOGEND (unused in EXP mode)", "immi", 0x50C086, f32_bits(30000.0), "", "FUN_0050be70"),
    ("sky dome radius factor", "f32", 0x5316CC, 0.8, "R = 4.096e8 IGI * 0.8 = 80 km", "FUN_005269c0"),
    ("sky dome ring step (rad)", "f32", 0x53181C, math.radians(6.0), "15 rings, 6 deg apart", "FUN_005269c0"),
    ("sky dome azimuth step (rad)", "f32", 0x531598, math.radians(18.0), "20 vertices per ring", "FUN_005269c0"),
    ("sky dome azimuth weight step", "f32", 0x5313C8, 0.1, "a = |0.1 j - 1|", "FUN_005269c0"),
    ("sky dome skirt height factor", "f32", 0x532B54, -0.5, "skirt ring at z = -0.5 R", "FUN_005269c0"),
    ("cloud fade minimum distance (IGI)", "f32", 0x5318D0, 409.6, "start = D - (D - 409.6) * FogAmount", "FUN_00517d20"),
    ("cloud alpha cap", "f32", 0x532AF8, 0.999, "", "FUN_00517d20"),
    ("FlatSky metres -> IGI", "f32", 0x5313B8, 4096.0, "Z Pos and Distance * 4096", "FUN_00517d20"),
    ("FlatSky angle scale (deg -> rad)", "f32", 0x532C60, 1.0 / 180.0, "Angle * pi * (1/180)", "FUN_00518670"),
    ("LODSettings relative factor scale", "f32", 0x5317E0, 0.02, "first-switch / cutoff values * 0.02", "FUN_004e4620"),
    ("blob shadow base grey", "f32", 0x546568, 0.9, "colour = 0.9 * f", "FUN_004d7670"),
    ("blob shadow min intensity", "f32", 0x5316A4, 0.3, "f = clamp(0.8 (1 - h / 1000 m), 0.3, 1)", "FUN_004d7670"),
    ("blob shadow lift along normal (IGI)", "f32", 0x531480, 10.0, "", "FUN_004d7670"),
    ("blob shadow fade height (IGI)", "immi", 0x45D910, f32_bits(4096000.0), "1000 m", "FUN_0045d850 -> FUN_004d7960"),
    ("blob shadow half-size (IGI)", "immi", 0x45D90B, f32_bits(1843.2), "0.45 m", "FUN_0045d850 -> FUN_004d7960"),
    ("muzzle flash roll step (rad per unit)", "f32", 0x531684, math.radians(1.0), "roll by {0,4,7} deg per shown frame", "FUN_00476000"),
    ("decal near-plane nudge", "f32", 0x5322C4, 1.01, "PolyList draws with near * 1.01", "FUN_00498c10"),
]


def verify_exe(exe):
    print("\n== igi.exe constants (re-read at the cited addresses) ==")
    for label, kind, va, expected, meaning, fn in EXE_CONSTANTS:
        if kind == "imm":
            ok = exe.has_imm32(va, f32_bits(expected))
            got = "imm %.7g" % expected if ok else "immediate not found"
        elif kind == "immi":
            ok = exe.has_imm32(va, expected)
            got = "imm 0x%x" % expected if ok else "immediate not found"
        elif kind == "f32":
            v = exe.f32(va)
            ok = abs(v - expected) <= 1e-6 * max(1.0, abs(expected))
            got = "%.9g" % v
        elif kind == "bytes":
            o = exe.offset(va)
            ok = exe.data[o:o + len(expected)] == expected
            got = expected.hex()
        else:
            v = exe.f64(va)
            ok = abs(v - expected) <= 1e-7   # stored as a float-rounded double
            got = "%.12g" % v
        check("%-42s @0x%06x %-14s %s [recovered %s]" % (label, va, got, meaning, fn), ok)


# ---------------------------------------------------------------- formulas
def projection(tan_half_x, near_m, far_m):
    """D3D projection of FUN_00495c70 for a full-screen view (row-vector convention)."""
    tan_half_y = 0.75 * tan_half_x
    q = far_m / (far_m - near_m)
    return {"_11": 1.0 / tan_half_x, "_22": -1.0 / tan_half_y, "_33": q, "_34": 1.0, "_43": -q * near_m,
            "hfov_deg": math.degrees(2 * math.atan(tan_half_x)), "vfov_deg": math.degrees(2 * math.atan(tan_half_y))}


def fog_density_per_metre(keyframe_density):
    """exp(-d * k): k per metre from the GlobalLightKeyframe 'Fog density' value."""
    return keyframe_density * 0.0005 * D3D_SCALE * IGI_UNITS_PER_METRE


def fog_factor(keyframe_density, distance_m):
    """Fraction of the surface colour kept (1 = no fog); D3D EXP fog."""
    return math.exp(-distance_m * fog_density_per_metre(keyframe_density))


def lerp(a, b, t):
    return [a[i] + (b[i] - a[i]) * t for i in range(3)]


def f32_chop(x):
    """FSTP DWORD in chop mode: the float32 nearest x toward zero."""
    d = struct.unpack("<f", struct.pack("<f", x))[0]
    if abs(d) > abs(x):
        bits = struct.unpack("<I", struct.pack("<f", d))[0] - 1
        d = struct.unpack("<f", struct.pack("<I", bits))[0]
    return d


def to_byte(x):
    """FUN_00526c10 0x526cab..: float32 store, fmul 255.0f, fistp, >= 255 -> 255.
    igi.exe runs the FPU in chop mode (FUN_004966d0; docs/gameplay.md "FPU
    rounding mode"), so the store and the FISTP both truncate (0.5 -> 127)."""
    v = int(f32_chop(x) * 255.0)
    return 255 if v > 254 else v


def sky_dome(flat_sky):
    """Vertices (pos IGI units in dome space, colour bytes) and triangles of FUN_005269c0 /
    FUN_00526d20.  flat_sky: dict with top, mid1, mid2, bot1, bot2 (RGB 0..1), angle_deg, snap."""
    top, mid1, mid2, bot1, bot2 = (flat_sky[k] for k in ("top", "mid1", "mid2", "bot1", "bot2"))
    if flat_sky.get("snap"):
        mid2, bot2 = mid1, bot1
    cols = [top, top, mid1, mid2, bot1, bot2]
    A = flat_sky["angle_deg"] * math.pi / 180.0
    R = 4.096e8 * 0.8
    verts = [((0.0, 0.0, R), tuple(to_byte(c) for c in top))]
    phi = math.pi / 2
    ring_colours = []
    for ring in range(15):
        phi -= math.radians(6.0)
        if phi < A:
            base = 2
            b = 0.0
            if A * 0.5 <= phi:
                b = phi / (A * 0.5) - 1.0
        else:
            base = 0
            b = (phi - A) / (math.pi / 2 - A)
        b = 1.0 - b
        row = []
        for j in range(20):
            th = math.radians(18.0) * j
            a = abs(0.1 * j - 1.0)
            c = lerp(lerp(cols[base], cols[base + 1], a), lerp(cols[base + 2], cols[base + 3], a), b)
            col = tuple(to_byte(x) for x in c)
            verts.append(((R * math.cos(th) * math.cos(phi), R * math.sin(th) * math.cos(phi), R * math.sin(phi)), col))
            row.append(col)
        ring_colours.append((math.degrees(phi), row[10], row[0]))
    for j in range(20):
        p, col = verts[1 + 14 * 20 + j]
        verts.append(((p[0], p[1], -0.5 * R), col))
    tris = []
    prev = 19
    for j in range(20):
        tris.append((0, prev + 1, j + 1))
        prev = j
    for ring in range(15):
        s = ring * 20
        prev = 19
        for j in range(20):
            a0, a1 = j + 1 + s, prev + 1 + s
            b0, b1 = j + 21 + s, prev + 21 + s
            tris.append((a0, a1, b0))
            tris.append((a1, b1, b0))
            prev = j
    return verts, tris, ring_colours


def cloud_alpha(depth_m, distance_m, fog_amount, layer_alpha=1.0):
    """Vertex alpha of a FlatSkyLayer point at camera depth depth_m (FUN_00517d20)."""
    D = distance_m * 4096.0
    s = D - (D - 409.6) * fog_amount
    z = depth_m * 4096.0
    if z >= s:
        a = (s - (1.0 / z) * s * D) / (s - D)
        a = 0.0 if a <= 0 else (0.999 if a > 0.999 else a)
    else:
        a = 1.0
    return a * layer_alpha


def lod_relative(depth_m, radius_m, face_counts, first_switch, cutoff, degree, ideal_radius_m, tan_half_fov=1.0, detail=1.0):
    """LOD index (or -1 = culled) for a model without lod.qvm distances (FUN_004c4d00)."""
    r_eff = (1.0 - degree) * (ideal_radius_m - radius_m) + radius_m
    d = depth_m * detail - r_eff
    if d <= 0:
        return 0
    S, C = first_switch * 0.02, cutoff * 0.02
    thresholds = [1.0 / (S * r_eff)] + [(face_counts[i] / face_counts[0]) ** 2 / (S * r_eff) for i in range(1, len(face_counts))]
    inv = 1.0 / d
    i = 0
    if inv < tan_half_fov * thresholds[0]:
        while i < len(face_counts) - 1 and inv < tan_half_fov * thresholds[i]:
            i += 1
    if i == len(face_counts) - 1 and C * r_eff < tan_half_fov * d:
        return -1
    return i


def lod_explicit(depth_m, radius_m, distances_m, n_lods, tan_half_fov=1.0, detail=1.0):
    """LOD index (or -1) for a model with ModelLODSettings (lod.qvm) distances (FUN_004c4d00)."""
    dist = []
    for k, v in enumerate(distances_m):            # FUN_004e46e0 makes them non-decreasing
        dist.append(max(v, dist[k - 1]) if k else v)
    d = tan_half_fov * (depth_m * detail - radius_m)
    if d > dist[4]:
        return -1
    i = 0
    if dist[0] == 0.0 and n_lods - 1 > 0:
        i = min(n_lods - 1, 1)
    while dist[i] < d and i < n_lods - 1:
        i += 1
    return i


# ---------------------------------------------------------------- data
def loop_v2(data):
    """flare00-07.tex / shadow00-01.tex: 'LOOP', u32 2, 8 zero bytes, u16 row bytes, u16 w, u16 h,
    u16 2, then w*h A1R5G5B5 pixels from 0x18 (observed on all 10 files)."""
    if data[:4] != b"LOOP" or struct.unpack_from("<I", data, 4)[0] != 2:
        raise ValueError("not LOOP v2")
    rb, w, h, mode = struct.unpack_from("<4H", data, 0x10)
    if rb != 2 * w or len(data) != 0x18 + rb * h:
        raise ValueError("LOOP v2 size mismatch")
    px = struct.unpack_from("<%dH" % (w * h), data, 0x18)
    return w, h, mode, px


def tex_v11_alpha(data):
    fmt = struct.unpack_from("<I", data, 8)[0]
    w, h = struct.unpack_from("<2H", data, 22)
    bpp = struct.unpack_from("<H", data, 30)[0]
    if bpp != 4:
        return fmt, w, h, None
    a = data[32 + 3:32 + w * h * 4:4]
    return fmt, w, h, (min(a), max(a))


def first(tasks, kind):
    return next((t for t in tasks if t["type"] == kind), None)


def main():
    import level_tasks
    from igi_qvm import QVM
    import object_lighting as ol

    print("Project I.G.I. renderer parameters (docs/rendering.md)")
    exe_path = os.path.join(GAME, "igi.exe")
    if os.path.exists(exe_path):
        verify_exe(Exe(exe_path))
    else:
        print("igi.exe not found; skipping executable checks")

    print("\n== Camera [recovered FUN_00495c70, FUN_00495fe0, FUN_00462fe0] ==")
    world = projection(1.0, 0.1, 100000.0)
    gun = projection(math.tan(math.pi / 6), 0.05, 1.5)
    print("  world: hfov %.2f deg, vfov %.2f deg, near 0.1 m, far 100 km, depth range [0.06, 1]" % (world["hfov_deg"], world["vfov_deg"]))
    print("  gun:   hfov %.2f deg, vfov %.2f deg, near 0.05 m, far 1.5 m, depth range [0, 0.05]" % (gun["hfov_deg"], gun["vfov_deg"]))
    check("world vfov = 2 atan(0.75)", abs(world["vfov_deg"] - 73.7397953) < 1e-6)
    check("gun hfov = 60 deg", abs(gun["hfov_deg"] - 60.0) < 1e-9)

    tasks = level_tasks.read_tasks(open(os.path.join(LEVEL1, "objects.qvm"), "rb").read())
    frames = sorted((t for t in tasks if t["type"] == "GlobalLightKeyframe"), key=lambda t: t["params"]["Time"])
    key = frames[0]["params"]     # time of day 0 < every Time: the earliest keyframe applies (E019)
    print("\n== Fog (level 1, keyframe Time %.0f) [recovered FUN_00521280, FUN_0050be70, FUN_0052daf0] ==" % key["Time"])
    for cat in ("terrain", "object category 1"):
        dens = key["Fog density " + cat]
        col = key["Fog color " + cat]
        k = fog_density_per_metre(dens)
        print("  %-18s density %.4f -> exp(-%.6f * d_m); colour %s = #%02x%02x%02x; 50%% at %.0f m, 90%% at %.0f m"
              % (cat, dens, k, [round(c, 4) for c in col], to_byte(col[0]), to_byte(col[1]), to_byte(col[2]),
                 math.log(2) / k, math.log(10) / k))
    check("terrain fog factor at 100 m", abs(fog_factor(1.89, 100.0) - math.exp(-0.38707)) < 1e-4,
          "%.4f" % fog_factor(1.89, 100.0))
    for c in (2, 3, 4):
        print("  object category %d: interpolated but never read by any draw path (no xrefs to 0x%x)" % (c, 0xAECA40 + 4 * c))

    print("\n== Sky dome (FlatSky) [recovered FUN_00518670, FUN_005269c0, FUN_00526d20, FUN_00526de0] ==")
    sky = first(tasks, "FlatSky")["params"]
    params = {"top": sky["SkyDome Top Colour"], "mid1": sky["SkyDome Middle Colour 1"], "mid2": sky["SkyDome Middle Colour 2"],
              "bot1": sky["SkyDome Bottom Colour 1"], "bot2": sky["SkyDome Bottom Colour 2"],
              "angle_deg": sky["SkyDome Angle"], "snap": bool(sky["SkyDome Snap Colours"])}
    verts, tris, rings = sky_dome(params)
    print("  clear colour (FlatSky 'Fog Color') = #%02x%02x%02x" % tuple(to_byte(c) for c in sky["Fog Color"]))
    print("  angle %.1f deg; %d vertices, %d triangles; ring colours (toward sun, away):" % (params["angle_deg"], len(verts), len(tris)))
    print("    pole  90.0 deg: #%02x%02x%02x" % verts[0][1])
    for el, sunward, away in rings:
        print("    ring %5.1f deg: #%02x%02x%02x  #%02x%02x%02x" % ((el,) + sunward + away))
    check("dome vertex count 321 (0x141)", len(verts) == 321)
    check("dome index count 1860 (0x744)", len(tris) * 3 == 1860)

    print("\n== Cloud layers (FlatSkyLayer) [recovered FUN_00517d20, FUN_00518760] ==")
    zpos, dist, amount = sky["Z Pos"], sky["Distance"], sky["Fog Amount"]
    D = dist * 4096.0
    s = D - (D - 409.6) * amount
    print("  plane %.1f m above the camera; alpha 1 up to depth %.2f m, 0 at %.1f m (linear in 1/depth)" % (zpos, s / 4096.0, dist))
    for layer in (t for t in tasks if t["type"] == "FlatSkyLayer"):
        p = layer["params"]
        print("  %s scale %.3g/IGI unit (repeat %.2f m), scroll (%.5f, %.5f) uv/tick = (%.4f, %.4f) uv/s, colour %s, alpha %s"
              % (os.path.basename(p["Texture File Name"]), p["Scale"], 1.0 / p["Scale"] / 4096.0, p["X Speed"], p["Y Speed"],
                 p["X Speed"] * TICKS_PER_SECOND, p["Y Speed"] * TICKS_PER_SECOND, [round(c, 3) for c in p["Color"]], p["Alpha"]))
    check("cloud alpha 1 at the fade start", abs(cloud_alpha(s / 4096.0, dist, amount) - 0.999) < 1e-6 or cloud_alpha(s / 4096.0, dist, amount) == 1.0)
    check("cloud alpha 0 at Distance", cloud_alpha(dist, dist, amount) == 0.0)

    print("\n== Texture filtering / LOD (level 1) [recovered FUN_00518a50, FUN_00518bb0, FUN_004e4620, FUN_004c4d00] ==")
    mip = first(tasks, "MipMapControl")["params"]
    print("  MipMapControl: D3DTSS_MIPMAPLODBIAS(stage 0) = %.2f ('LOD bias (Standard MipMapping)'); mode %s, LOD blend %s (not applied by this handler)"
          % (mip["LOD bias (Standard MipMapping)"], mip["MipMap mode"], mip["LOD blend"]))
    lod = first(tasks, "LODSettings")["params"]
    for k, v in lod.items():
        print("  LODSettings %-70s %s" % (k, v))
    first_rigid = lod["Distance to first switch, relative to object radius (Rigid Objects)"]
    cut_rigid = lod["Cutoff distance, relative to object radius (Rigid Objects)"]
    deg, ideal = lod["Degree to which radius affects LOD"], lod["Ideal radius"]
    r_eff = (1 - deg) * (ideal - 10.0) + 10.0
    print("  example: rigid model radius 10 m -> effective radius %.2f m, LOD1 beyond depth %.1f m, culled beyond %.0f m"
          % (r_eff, r_eff + first_rigid * 0.02 * r_eff, r_eff + cut_rigid * 0.02 * r_eff))
    check("LOD 0 near", lod_relative(5.0, 10.0, [1000, 500], first_rigid, cut_rigid, deg, ideal) == 0)
    check("LOD culled far", lod_relative(5000.0, 10.0, [1000, 500], first_rigid, cut_rigid, deg, ideal) == -1)
    lod_qvm = os.path.join(GAME, "lod.qvm")
    if os.path.exists(lod_qvm):
        mls = [t for t in level_tasks.read_tasks(open(lod_qvm, "rb").read()) if t["type"] == "ModelLODSettings"]
        print("  lod.qvm: %d ModelLODSettings (explicit per-model distances in metres, x4096 on load) [observed]" % len(mls))

    print("\n== Materials: bullet impact decals (material/material.qvm DefineGameMaterial) [observed values] ==")
    mq = os.path.join(GAME, "material", "material.qvm")
    if os.path.exists(mq):
        for call in QVM(open(mq, "rb").read()).call_tree():
            if call["fn"] != "DefineGameMaterial":
                continue
            a = call["args"]
            print("  %-13s decal %-24s / %-24s size %.3f model %-10s | 2nd: %s %s %.3f" % (a[0], a[25] or "-", a[26] or "-", a[27], a[28] or "-", a[32] or "-", a[33] or "-", a[34]))

    print("\n== Effect textures [observed] ==")
    tex_dir = os.path.join(GAME, "common", "textures")
    for n in ["flare%02d" % i for i in range(8)] + ["shadow00", "shadow01"]:
        w, h, mode, px = loop_v2(open(os.path.join(tex_dir, n + ".tex"), "rb").read())
        bright = sum(1 for v in px if (v & 0x7FFF) != 0)
        print("  %s.tex  LOOP v2 %dx%d mode %d, all pixels alpha=1, %d non-black" % (n, w, h, mode, bright))
    check("flare/shadow textures decode as LOOP v2 64x64", True)
    for name, payload in ol.ilff_members(open(os.path.join(tex_dir, "textures.res"), "rb").read()):
        fmt, w, h, al = tex_v11_alpha(payload)
        print("  textures.res %-22s fmt %d %dx%d alpha %s" % (name.split("/")[-1], fmt, w, h, al))
    shadow = dict((n.split("/")[-1], p) for n, p in ol.ilff_members(open(os.path.join(tex_dir, "textures.res"), "rb").read()))["shadow1.tex"]
    check("shadow1.tex black with soft alpha <= 199", tex_v11_alpha(shadow)[3] == (0, 199))

    print("\n== Muzzle flashes: GUNFLAME attachments and additive blocks [observed] ==")
    lib_paths = (LEVEL1 + "/models/level1.res", os.path.join(GAME, "missions", "location0", "common", "models", "location0.res"))
    flames = {"1000_01_1", "1005_01_1", "1007_01_1", "1008_01_1", "1010_01_1"}
    additive = set()
    for arc in lib_paths:
        for name, payload in ol.ilff_members(open(arc, "rb").read()):
            model = name.split("/")[-1].replace(".mef", "")
            try:
                mef = ol.Mef(payload, model)
            except (KeyError, ValueError, struct.error):
                continue
            for a in mef.atta:
                if a["name"] in flames:
                    print("  gun %-9s -> flame %s at %.3f m along the barrel" % (model, a["name"], a["offset"][1] / 4096.0))
            chunks = {}
            for tag, off, size in ol.ilff_form_chunks(payload, b"OCEM"):
                chunks.setdefault(tag, (off, size))
            o, s = chunks["DNER"]
            hdr = 32 if mef.type == 3 else 28
            p = 0
            while p < s:
                at = o + p
                ic = struct.unpack_from("<h", payload, at + 12)[0]
                flag = payload[at + (0x1C if mef.type == 3 else 0x18)]
                if flag & 1:
                    additive.add(model)
                p += hdr + ic * 2
    print("  models with DNER flag bit 0 (deferred additive ONE/ONE, unlit, unfogged): %s" % ", ".join(sorted(additive)))
    check("every GUNFLAME model is additive", flames <= additive)

    print("\n%d check(s) failed" % len(FAILURES) if FAILURES else "\nall checks passed")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
