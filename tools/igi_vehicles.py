#!/usr/bin/env python3
"""Vehicle physics of Project I.G.I. (igi.exe, 2000): helicopter, car/truck and
train (wagons along the rail spline), and a replay of the level-1 intro and
outro vehicle timelines.

Run from the repository root (stdlib only; reads the original files, writes
nothing):

    python tools/igi_vehicles.py                 # types, spline, replays, self-checks
    python tools/igi_vehicles.py --json          # machine-readable trajectories
    python tools/igi_vehicles.py --no-collision  # truck on terrain only (fast)

Evidence labels (as in docs/vehicles.md):
  recovered  read from igi.exe code (function addresses: Ghidra FUN_ names,
             image base 0x400000); constants read from the executable
  observed   measured on the shipped data files by this script
  inferred   interpretation the traced code does not prove

Numerics: igi.exe keeps positions in doubles and everything else (matrices,
velocities, forces, spline points) in float32 struct fields, computing on the
x87 stack in between.  This module computes in double and rounds with f32()
wherever the exe stores to a float field or float local, which is the closest
stdlib emulation (x87 extended precision is not reproduced bit for bit).

Units: IGI world units (4096 = 1 m), z up, 30 ticks per second; velocities in
units/tick, forces in units*mass/tick^2.  Matrices are row-major lists of 9
floats with world = M * local (columns are the local axes).

Python counterpart of web-port/src/loaders/vehicles.ts (tests:
web-port/tests/vehicles.test.ts).
"""
import argparse
import json
import math
from pathlib import Path
import struct
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from igi_anim import mef_chunks, read_atta  # noqa: E402
from igi_formats import resource_members  # noqa: E402
from igi_qvm import QVM  # noqa: E402
from level_tasks import read_tasks  # noqa: E402

GAME = Path("Game Files")
LEVEL = "missions/location0/level1"
MODEL_ARCHIVES = [f"{LEVEL}/models/level1.res", "missions/location0/common/models/location0.res"]
TICKS_PER_SECOND = 30
UNITS_PER_METRE = 4096.0


def f32(x):
    """FSTP DWORD as igi.exe executes it: the FPU runs in chop mode
    (FUN_004966d0; docs/gameplay.md "FPU rounding mode"), so a float32 store
    rounds toward zero (the exe's float struct fields and locals)."""
    try:
        d = struct.unpack("<f", struct.pack("<f", x))[0]
    except OverflowError:
        return math.copysign(3.4028234663852886e38, x)  # masked overflow in chop mode: +-FLT_MAX
    if abs(d) > abs(x) and math.isfinite(x):
        bits = struct.unpack("<I", struct.pack("<f", d))[0] - 1
        d = struct.unpack("<f", struct.pack("<I", bits))[0]
    return d


# ------------------------------------------------------------- constants
# [recovered] values read from igi.exe (address: type, value)
GRAVITY = f32(44.600887298583984)       # immediate 0x4232674f pushed by the heli/car steps = 9.8 m/s^2 in units/tick^2
QUARTER_G = f32(11.150221824645996)     # 0x531764 f32, heli skid spring scale (FUN_004317d0)
HELI_LIN_DAMP = f32(1.0)                # FUN_004310b0 -> FUN_004f2d00(.., 1.0, 0.92, ..)
HELI_ANG_DAMP = f32(0.92)
CAR_LIN_DAMP = f32(0.97)                # FUN_0042df40 -> FUN_004f2d00(.., 0.97, 0.9, ..)
CAR_ANG_DAMP = f32(0.9)
MOVE_THRESHOLD = f32(40.96)             # 0x531730 f32: position integrates only when speed > 0.01 m/tick
DRAG_K = f32(0.00032699998700991273)    # immediate 0x39ab7132 (FUN_004e2e40 call sites)
LEN_K1 = f32(0.414213568)               # 0x532a64 (FUN_004a8cf0 approximate length)
LEN_K2 = f32(0.317837238)               # 0x532a68
INERTIA_K = f32(1.0 / 12.0)             # 0x531888 f32 0.0833333358 (FUN_004e3a50)
INV_INERTIA_SCALE = f32(1.01)           # 0x5322c4 (FUN_004f2320)
DEG = f32(0.0174532924)                 # 0x531684 f32
HELI_FAST_THRUST = f32(0.8)             # 0x531758 (double 0.8, compared as float)
HELI_ZERO_THRUST = f32(0.001)           # 0x5316c0
HELI_MOVING_SPEED = f32(2.0)            # 0x531588
HELI_PITCH_K = f32(-0.8)                # 0x531750
HELI_YAW_K = f32(0.08)                  # 0x53174c
HELI_PITCH_ARM = f32(819.2)             # 0x4448cccd immediate (0.2 m)
HELI_ROLL_ARM = f32(409.6)              # 0x43cccccd immediate (0.1 m)
HELI_YAW_ARM = 12288.0                  # 3 m
HELI_TURN_K_UP = f32(-0.7)              # 0x531748
HELI_TURN_K_DOWN = f32(0.7)             # 0x5316c4
HELI_TURN_K = f32(0.000290888208665722)  # 0x531740 double, cast to float
ROTOR_TORQUE_K = f32(2.5)               # 0x5316f0
ROTOR_TORQUE_ARM = 8192.0               # immediate 0x46000000 (2 m)
SKID_RAY_UP = 8192.0                    # 0x531708 double
CAR_RAY_UP = 4096.0                     # 0x531498 double
CAR_RAY_DOWN = 2048.0                   # 0x531460 double
CAR_WHEEL_POINT_LIFT = f32(1638.4)      # 0x531718 (0.4 m)
CAR_ZERO_THRUST = f32(0.01)             # 0x531714
FRICTION_STATIC = f32(0.1)              # 0x5313c8
FRICTION_KINETIC = f32(0.24)            # 0x531738
FRICTION_LIMIT = f32(4.0)               # 0x53158c
WHEEL_SPIN_K = f32(0.6)                 # 0x53169c
WHEEL_SPIN_SMOOTH = f32(0.7)            # 0x5316c4
WHEEL_SPIN_GAIN = f32(0.3)              # 0x5316a4
TWO_PI_D = 6.283185307179586            # 0x531728 double
TRAIN_SPEED_K = f32(37.925926208496094)  # 0x5316c8 (reset speed)
TRAIN_KMH = (f32(4096000.0), f32(9.259259059035685e-6))  # 0x5314a4, 0x5314a0
SPLINE_DEGENERATE = 0.001               # 0x532b88 double
PI_F = f32(math.pi)                     # 0x531400


# ------------------------------------------------------------- small math

def vsub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def mat_mul(a, b):
    return [f32(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]) for r in range(3) for c in range(3)]


def rot_x(a):
    """FUN_004a9e40."""
    s, c = f32(math.sin(a)), f32(math.cos(a))
    return [1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c]


def rot_y(a):
    """FUN_004a9e80."""
    s, c = f32(math.sin(a)), f32(math.cos(a))
    return [c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c]


def rot_z(a):
    """FUN_004a9ec0."""
    s, c = f32(math.sin(a)), f32(math.cos(a))
    return [c, -s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0]


def euler(alpha, beta, gamma):
    """FUN_004a9bc0: M = Rz(gamma) * Ry(beta) * Rx(alpha), float entries."""
    return mat_mul(mat_mul(rot_z(f32(gamma)), rot_y(f32(beta))), rot_x(f32(alpha)))


def approx_len(v):
    """FUN_004a8cf0: max + 0.4142 mid + 0.3178 min of |x|, |y|, |z| (extended result)."""
    a = sorted(abs(c) for c in v)
    return a[1] * LEN_K1 + a[0] * LEN_K2 + a[2]


def angle_between(a, b):
    """FUN_004a8e10: acos(a.b / (|a||b|)), 0 for a zero vector, clamped."""
    if a == [0.0, 0.0, 0.0] or b == [0.0, 0.0, 0.0]:
        return 0.0
    d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (
        f32(math.sqrt(f32(b[2] * b[2] + b[1] * b[1] + b[0] * b[0]))) * f32(math.sqrt(f32(a[2] * a[2] + a[1] * a[1] + a[0] * a[0]))))
    if d >= 1.0:
        return 0.0
    if d <= -1.0:
        return PI_F
    return math.acos(d)


# ------------------------------------------------------------- physics object types

def _sym(v):
    return v.get("symbol") if isinstance(v, dict) else v


def decode_physics_type(args, source=""):
    """DefinePhysicsObjType (handler LAB_004e48a0 = FUN_004e48a0) [recovered layout].

    Common header (type struct 0x2d8 bytes at 0x7ef6c8 + 0x2d8 n): +0 task type,
    +4 index, +8 mass, +0xc/+0x10/+0x14 box size in metres (x, y, z), +0x18 name,
    +0x38 description, +0x138 model (the vehicle's "Model" selects its type,
    FUN_004e4cc0), +0x148 n contact points of 6 values {+0x14c magic-vertex
    index, +0x150 int, +0x154 int, +0x158 f, +0x15c lateral grip, +0x160
    rolling grip}, +0x2cc rest speed, +0x2d0 rest angular speed^2, +0x2d4 the
    class config parsed by the class's handler (message DAT_00549cb8)."""
    a = list(args)
    t = {"source": source, "taskType": _sym(a[0]), "index": int(a[1]), "mass": f32(a[2]),
         "size": [f32(a[3]), f32(a[4]), f32(a[5])], "name": a[6], "description": a[7], "model": a[8]}
    n = int(a[9])
    i = 10
    t["points"] = []
    for _ in range(n):
        t["points"].append({"vertex": int(a[i]), "a": int(a[i + 1]), "b": int(a[i + 2]), "c": f32(a[i + 3]),
                            "gripLateral": f32(a[i + 4]), "gripRolling": f32(a[i + 5])})
        i += 6
    t["restSpeed"], t["restAngular"] = f32(a[i]), f32(a[i + 1])
    i += 2
    rest = a[i:]
    tt = t["taskType"]
    if tt in ("TASKTYPE_HELI", "TASKTYPE_CAR"):
        cfg, j = _decode_vehicle_base(rest)
        if tt == "TASKTYPE_CAR":
            j = _decode_car(cfg, rest, j)
        cfg["extra"] = rest[j:]
        t["config"] = cfg
    elif tt == "TASKTYPE_ROTOR":
        # FUN_0042ccc0 (no base parse): +0 main-rotor byte, +1 tail-rotor byte,
        # +0xc int spin multiplier, +4 = arg x pi/180, +8 spin per tick at thrust 1, +0x10 model
        t["config"] = {"main": bool(rest[0]), "tail": bool(rest[1]), "spinSign": int(rest[2]),
                       "arg3": f32(f32(rest[3]) * 0.017453292519943295), "spin": f32(rest[4]), "model": rest[5]}
    elif tt == "TASKTYPE_WHEEL":
        # FUN_0042f100: +0x2d8 model, +0x2e8 radius x 4096, +0x2ec x 4096
        t["config"] = {"model": rest[0], "radius": f32(f32(rest[1]) * 4096.0), "bounce": f32(f32(rest[2]) * 4096.0)}
    else:
        t["config"] = {"raw": rest}
    return t


def _decode_vehicle_base(a):
    """FUN_004f9e10 (base vehicle config, 0x118 bytes): cfg[0..9] floats, +0x28 n
    drag elements of 7 args {coef, px, py, pz (m), nx, ny, nz} stored as
    (coef, unit n, p x 4096) by FUN_004e3050, then +0x10c view-cone length x 4096,
    +0x110/+0x114 view-cone angles x 0.5 deg->rad."""
    cfg = {"c": [f32(x) for x in a[0:10]]}
    n = int(a[10])
    j = 11
    els = []
    for _ in range(n):
        coef, px, py, pz, nx, ny, nz = (f32(x) for x in a[j:j + 7])
        ln = math.sqrt(nx * nx + ny * ny + nz * nz)
        if ln:
            nx, ny, nz = f32(nx / ln), f32(ny / ln), f32(nz / ln)
        els.append({"coef": coef, "normal": [nx, ny, nz], "point": [f32(px * 4096), f32(py * 4096), f32(pz * 4096)]})
        j += 7
    cfg["drag"] = els
    cfg["viewCone"] = [f32(f32(a[j]) * 4096), f32(f32(a[j + 1]) * 0.5 * DEG), f32(f32(a[j + 2]) * 0.5 * DEG)]
    return cfg, j + 3


def _decode_car(cfg, a, j):
    """FUN_0042cda0: +0x118 n wheels of 6 args {+0x11c steerable, +0x11d driven,
    +0x120 max steer (deg), +0x124 contact-point index (<0: no physics; the
    wheel model shows contact -10-k), +0x128 suspension travel x 4096,
    +0x12c spring}, +0x25c suspension offset x 4096, +0x260 wheels-from-model
    flag, +0x261 differential flag, +0x262 sound, +0x2ac n + list (explosion
    vertices), +0x2b0 wreck model."""
    n = int(a[j])
    j += 1
    wheels = []
    for _ in range(n):
        wheels.append({"steerable": bool(a[j]), "driven": bool(a[j + 1]), "maxSteerDeg": f32(a[j + 2]),
                       "contact": int(a[j + 3]), "travel": f32(f32(a[j + 4]) * 4096), "spring": f32(a[j + 5])})
        j += 6
    cfg["wheels"] = wheels
    cfg["suspensionOffset"] = f32(f32(a[j]) * 4096)
    cfg["wheelsFromModel"] = bool(a[j + 1])
    cfg["differential"] = bool(a[j + 2])
    cfg["sound"] = a[j + 3]
    k = int(a[j + 4])
    cfg["explosionVertices"] = [int(x) for x in a[j + 5:j + 5 + k]]
    cfg["wreckModel"] = a[j + 5 + k]
    return j + 6 + k


def read_physics_types(game=GAME):
    """Every DefinePhysicsObjType under physicsobj/ (37 in the shipped files).  The
    three plane scripts contain argument expressions the conservative QVM reader
    does not evaluate; they are kept with None for those arguments (planes are not
    used by level 1)."""
    out = []
    for path in sorted((game / "physicsobj").rglob("*.qvm")):
        data = path.read_bytes()
        source = str(path.relative_to(game))
        try:
            calls = [(c["fn"], c["args"]) for c in QVM(data).call_tree()]
        except Exception:  # noqa: BLE001 - unsupported expression: fall back to the flat call list
            calls = [(c["function"], [a.get("value") if a.get("status") == "recovered" else None for a in c["arguments"]])
                     for c in QVM(data).calls()["calls"]]
        for fn, args in calls:
            if fn == "DefinePhysicsObjType":
                out.append(decode_physics_type(args, source))
    return out


def read_magic_objects(game=GAME):
    """magicobj.qvm DefineMagicObj(name, model, TASKTYPE, params...)."""
    out = {}
    for call in QVM((game / "magicobj" / "magicobj.qvm").read_bytes()).call_tree():
        if call["fn"] == "DefineMagicObj":
            a = call["args"]
            out[a[0].lower()] = {"model": a[1], "taskType": _sym(a[2]), "params": a[3:]}
    return out


# ------------------------------------------------------------- models (magic vertices, attachments)

class Models:
    """Model archive access: XTVM magic vertices and ATTA attachments [observed layouts]."""

    def __init__(self, game=GAME):
        self.bodies = {}
        for arch in MODEL_ARCHIVES:
            data = (game / arch).read_bytes()
            for name, chunk in resource_members(data):
                if name.lower().endswith(".mef"):
                    self.bodies.setdefault(name.split("/")[-1][:-4].lower(), chunk.payload(data))

    def chunks(self, model):
        return {t: (o, s) for t, o, s in mef_chunks(self.bodies[model.lower()])}

    def magic_vertices(self, model):
        """XTVM: 16-byte records f32 x, y, z, u32 (FUN_004c59c0 reads model+0x88 + 16 i)."""
        body = self.bodies[model.lower()]
        o, s = self.chunks(model)["XTVM"]
        return [list(struct.unpack_from("<3f", body, o + 16 * i)) for i in range(s // 16)]

    def attachments(self, model):
        return _attachments(self.bodies[model.lower()])


# ------------------------------------------------------------- rigid body (obj + 0xf0)

def _attachments(body):
    """ATTA: 68-byte records {char[16] sub-model, f32 x3 offset, f32 x9 row-vector matrix, i32 bone}."""
    return [{"name": n.lower(), "offset": list(o), "matrix": list(m), "bone": b} for n, o, m, b in read_atta(body)]


class Body:
    """Rigid body embedded at object +0xf0 [recovered FUN_004e3160, FUN_004e3220,
    FUN_004e3930, FUN_004e3ad0].  Fields (body offsets): +0 mass, +4 1/mass,
    +8 speed (approximate |v|), +0xc..+0x14 inverse inertia (diagonal, local),
    +0x18 velocity (world), +0x24 unit velocity, +0x30 angular momentum (LOCAL
    frame), +0x3c last net force, +0x48 angular velocity (world), +0x54/+0x5c
    pending force list (force xyz, point xyz, both local)."""

    def __init__(self):
        self.mass = self.inv_mass = 0.0
        self.inv_inertia = [0.0, 0.0, 0.0]
        self.reset_motion()

    def reset_motion(self):
        """FUN_004e31e0."""
        self.v = [0.0, 0.0, 0.0]
        self.speed = 0.0
        self.vdir = [0.0, 0.0, 0.0]
        self.L = [0.0, 0.0, 0.0]
        self.last_force = [0.0, 0.0, 0.0]
        self.w = [0.0, 0.0, 0.0]
        self.forces = []

    def setup(self, mass, size_m):
        """FUN_004f2320 -> FUN_004e3a50(body, mass, x, y, z) -> FUN_004e3160: box
        inertia m (b^2 + c^2) / 12 with the size in units, then the inverse x 1.01."""
        dx, dy, dz = (f32(s * 4096.0) for s in size_m)
        ix = f32((dz * dz + dy * dy) * mass * INERTIA_K)
        iy = f32((dz * dz + dx * dx) * mass * INERTIA_K)
        iz = f32((dy * dy + dx * dx) * mass * INERTIA_K)
        self.mass, self.inv_mass = mass, f32(1.0 / mass)
        self.inv_inertia = [f32(f32(1.0 / i) * INV_INERTIA_SCALE) for i in (ix, iy, iz)]
        self.reset_motion()

    def add(self, force, point):
        """FUN_004e3ad0: append (force, point), both in the body frame."""
        self.forces.append(([f32(c) for c in force], [f32(c) for c in point]))

    def update_speed(self):
        """FUN_004e3930."""
        self.speed = f32(approx_len(self.v))
        if self.speed <= 0.0:
            self.vdir = [0.0, 0.0, 0.0]
        elif self.v != [0.0, 0.0, 0.0]:
            k = f32(1.0 / math.sqrt(f32(self.v[2] * self.v[2] + self.v[1] * self.v[1] + self.v[0] * self.v[0])))
            self.vdir = [f32(c * k) for c in self.v]

    def integrate(self, m):
        """FUN_004e3220: sum the pending forces; v += M (F / m); L += sum(p x F);
        w = M (I^-1 L); rotate the orientation by w through a quaternion.
        Returns the new matrix (or the same one when L = 0)."""
        x, y, z, w = _quat_from_matrix(m)
        if self.forces:
            fx = fy = fz = 0.0
            tx = ty = tz = 0.0
            for (f, p) in self.forces:
                fx, fy, fz = f32(fx + f[0]), f32(fy + f[1]), f32(fz + f[2])
                if (p[0] != 0 or p[1] != 0 or p[2] != 0) and (f[0] != 0 or f[1] != 0 or f[2] != 0):
                    tx = f32((f[2] * p[1] - p[2] * f[1]) + tx)
                    ty = f32(-(f[2] * p[0] - f[0] * p[2]) + ty)
                    tz = f32((p[0] * f[1] - f[0] * p[1]) + tz)
            self.last_force = [fx, fy, fz]
            ax, ay, az = f32(self.inv_mass * fx), f32(self.inv_mass * fy), f32(self.inv_mass * fz)
            dv = [f32(ax * m[0] + ay * m[1] + az * m[2]), f32(ay * m[4] + ax * m[3] + az * m[5]),
                  f32(az * m[8] + ax * m[6] + ay * m[7])]
            self.forces = []
            self.v = [f32(dv[0] + self.v[0]), f32(dv[1] + self.v[1]), f32(dv[2] + self.v[2])]
            self.L = [f32(tx + self.L[0]), f32(ty + self.L[1]), f32(tz + self.L[2])]
        if self.L[0] != 0 or self.L[1] != 0 or self.L[2] != 0:
            wl = [f32(self.inv_inertia[0] * self.L[0]), f32(self.inv_inertia[1] * self.L[1]), f32(self.inv_inertia[2] * self.L[2])]
            self.w = [f32(wl[2] * m[2] + m[0] * wl[0] + wl[1] * m[1]), f32(wl[1] * m[4] + wl[2] * m[5] + m[3] * wl[0]),
                      f32(wl[0] * m[6] + wl[2] * m[8] + m[7] * wl[1])]
            hx, hy, hz = f32(self.w[0] * 0.5), f32(self.w[1] * 0.5), f32(self.w[2] * 0.5)
            # 8-multiply quaternion product (FUN_004e3220 as compiled), q' = q + (h, 0) (x) q
            l3 = f32((y + x) * (hz + hx))
            l2 = f32(hy * (w - z))
            l1 = f32(-hy * (z + w))
            s1 = f32(l1 + l2 + l3)
            s2 = f32(((x - y) * (hz - hx) + s1) * 0.5)
            n1 = f32((s2 + -hx * (z + y)) - l1)
            n2 = f32((s2 + (w - x) * (hz + hy)) - l2)
            n3 = f32((s2 + (y - z) * (hz - hy)) - l3)
            x = f32(((hx * (x + w) + s2) - s1) + x)
            y, z, w = f32(n1 + y), f32(n2 + z), f32(n3 + w)
            for _ in range(2):
                k = f32(1.0 / math.sqrt(f32(w * w + x * x + y * y + z * z)))
                x, y, z, w = f32(x * k), f32(y * k), f32(z * k), f32(w * k)
            m = _matrix_from_quat(x, y, z, w)
        self.update_speed()
        return m


def _quat_from_matrix(m):
    t = f32(m[4] + m[0] + m[8])
    if t > 0.0:
        r = f32(math.sqrt(t + 1.0))
        w = f32(r * 0.5)
        s = f32(0.5 / r)
        return f32(-((m[5] - m[7]) * s)), f32(-((m[6] - m[2]) * s)), f32(-((m[1] - m[3]) * s)), w
    nxt = [1, 2, 0]
    i = 1 if m[0] < m[4] else 0
    if m[i * 4] < m[8]:
        i = 2
    j, k = nxt[i], nxt[nxt[i]]
    r = f32(math.sqrt(((m[i * 4] - m[j * 4]) - m[k * 4]) + 1.0))
    q = [0.0, 0.0, 0.0, 0.0]
    q[i] = f32(r * 0.5)
    s = f32(0.5 / r) if r != 0 else r
    q[j] = f32((m[j * 3 + i] + m[i * 3 + j]) * s)
    q[k] = f32((m[i + k * 3] + m[i * 3 + k]) * s)
    q[3] = f32(-((m[j * 3 + k] - m[k * 3 + j]) * s))
    return q[0], q[1], q[2], q[3]


def _matrix_from_quat(x, y, z, w):
    xx, xy, xz, xw = f32(x * x + x * x), f32(y * x + y * x), f32(z * x + z * x), f32(x * w + x * w)
    yy, yz, yw = f32(y * y + y * y), f32(z * y + z * y), f32(y * w + y * w)
    zz, zw = f32(z * z + z * z), f32(w * z + w * z)
    one_xx = f32(1.0 - xx)
    return [f32((1.0 - yy) - zz), f32(xy - zw), f32(yw + xz),
            f32(zw + xy), f32(one_xx - zz), f32(yz - xw),
            f32(xz - yw), f32(yz + xw), f32(one_xx - yy)]


def drag(body, elements, m):
    """FUN_004e2e40(elements, n, 0.000327, body, M, -v): u = M^T(-v), q = k |u|^2
    (approximate length); each element adds n (u_hat . n) coef q at its point."""
    nv = [-body.v[0], -body.v[1], -body.v[2]]
    u = [f32(m[0] * nv[0] + m[3] * nv[1] + m[6] * nv[2]), f32(m[4] * nv[1] + m[1] * nv[0] + m[7] * nv[2]),
         f32(m[5] * nv[1] + m[2] * nv[0] + m[8] * nv[2])]
    ln = approx_len(u)
    q = f32(ln * ln * DRAG_K)
    if not q > 0.0:
        return
    if u != [0.0, 0.0, 0.0]:
        k = f32(1.0 / math.sqrt(f32(u[2] * u[2] + u[1] * u[1] + u[0] * u[0])))
        u = [f32(c * k) for c in u]
    for e in elements:
        if e["coef"] > 0.0:
            n = e["normal"]
            s = f32((u[0] * n[0] + u[2] * n[2] + u[1] * n[1]) * e["coef"] * q)
            body.add([f32(n[0] * s), f32(n[1] * s), f32(n[2] * s)], e["point"])


def point_velocity(body, r):
    """FUN_004e3b00: v + w x r (world)."""
    w = body.w
    return [f32((r[2] * w[1] - w[2] * r[1]) + body.v[0]), f32(-(r[2] * w[0] - w[2] * r[0]) + body.v[1]),
            f32((w[0] * r[1] - r[0] * w[1]) + body.v[2])]


# ------------------------------------------------------------- vehicle base

class Physical:
    """Shared state of Heli / Car (object offsets in brackets)."""

    def __init__(self, ptype, position, orientation, original_thrust, speed=(0.0, 0.0, 0.0), collision=True, force_z=False):
        self.type = ptype
        self.cfg = ptype["config"]
        self.init_pos = [float(c) for c in position]       # +0x168 (doubles)
        self.init_m = euler(*orientation)                   # +0x18c
        self.init_speed = [f32(c) for c in speed]           # +0x180
        self.original_thrust = f32(original_thrust)         # +0x740
        self.collision = collision                          # +0x6d8 (body-point collision, unused here)
        self.force_z = force_z                              # +0x6d9
        if force_z:
            raise NotImplementedError("Force Z vehicles are not modelled (no level-1 vehicle uses it)")
        self.body = Body()
        self.pos = list(self.init_pos)
        self.m = list(self.init_m)
        self.prev_pos, self.prev_m = list(self.pos), list(self.m)
        self.thrust = self.target = 0.0                     # +0x720 / +0x730
        self.contacts = 0                                   # +0x1b8

    def setup_body(self):
        """FUN_004f2320 (with a type): body from mass and box size, prev pose = pose, contacts 0."""
        self.body.setup(self.type["mass"], self.type["size"])
        self.prev_pos, self.prev_m = list(self.pos), list(self.m)
        self.contacts = 0

    def at_rest(self):
        """FUN_004f33d0 (+0x690 wake flag never set here; +0x14c = pending force count)."""
        w = self.body.w
        return (self.contacts > 0 and not self.body.forces and self.body.speed < self.type["restSpeed"]
                and f32(w[2] * w[2] + w[1] * w[1] + w[0] * w[0]) < self.type["restAngular"])

    def integrate(self, gravity, lin, ang):
        """FUN_004f2d00 -> FUN_004f2bb0: gravity -(g m) along the local image of world z
        (row 2 of M), integrate, damp L and v, recompute the speed; the position moves
        by v only when speed > 40.96 units/tick.  The body-point collision passes
        (FUN_004f25c0, FUN_004f3240) do nothing for level-1 vehicles: every contact
        point is a wheel (car) or the type has none (heli)."""
        g = f32(-(gravity * self.type["mass"]))
        self.body.add([f32(g * self.m[6]), f32(g * self.m[7]), f32(g * self.m[8])], [0.0, 0.0, 0.0])
        self.m = self.body.integrate(self.m)
        b = self.body
        b.L = [f32(c * ang) for c in b.L]
        b.v = [f32(c * lin) for c in b.v]
        b.update_speed()
        if MOVE_THRESHOLD < b.speed:
            self.pos = [b.v[0] + self.pos[0], b.v[1] + self.pos[1], b.v[2] + self.pos[2]]
        self.prev_pos, self.prev_m = list(self.pos), list(self.m)

    def local_to_world(self, p):
        o = [self.m[0] * p[0] + self.m[1] * p[1] + self.m[2] * p[2], self.m[3] * p[0] + self.m[4] * p[1] + self.m[5] * p[2],
             self.m[6] * p[0] + self.m[7] * p[1] + self.m[8] * p[2]]
        return [self.pos[0] + o[0], self.pos[1] + o[1], self.pos[2] + o[2]]

    def pose(self):
        return {"position": list(self.pos), "matrix": list(self.m)}


# ------------------------------------------------------------- helicopter

class Heli(Physical):
    """Heli task (class 0x539e08: create FUN_004307c0, update FUN_00430950, compile
    FUN_00431bd0, AnimTask input FUN_00430df0, physics FUN_004310b0) with its
    model's attached magic objects: Rotor (FUN_0042c750) and HeliWheel skids
    (FUN_004317d0 reads them)."""

    def __init__(self, task, types, models, magic):
        p = task["params"]
        ptype = _type_for_model(types, p["Model"])
        super().__init__(ptype, p["Position"], p["Orientation"], p["Original Thrust"], p["Speed"],
                         p["Collision detection"], p["Force Z"])
        self.id = task["id"]
        self.c = [0.0, 0.0, 0.0]      # +0x724.. smoothed control axes
        self.inp = [0.0, 0.0, 0.0]    # +0x734.. AnimTask channels 0..2
        self.rotors = []
        self.skids = []
        for a in models.attachments(p["Model"]):
            mo = magic.get(a["name"])
            if not mo:
                continue
            if mo["taskType"] == "TASKTYPE_ROTOR":
                self.rotors.append({"model": a["name"], "cfg": _type_for_model(types, a["name"])["config"],
                                    "offset": a["offset"], "angle": 0.0})
            elif mo["taskType"] == "TASKTYPE_HELIWHEEL":
                # FUN_00426440: [1] = arg0 x 4096 (0.15 m), [0] = arg1 x 4096 (0.3 m)
                self.skids.append({"model": a["name"], "offset": [f32(c) for c in a["offset"]],
                                   "depth": f32(f32(mo["params"][1]) * 4096), "hard": f32(f32(mo["params"][0]) * 4096)})
        self.reset_pose()

    def reset_pose(self):
        self.pos, self.m = list(self.init_pos), list(self.init_m)
        self.setup_body()

    def skid_world(self, s):
        return self.local_to_world(s["offset"])

    def anim_input(self, n_tick, ch, world):
        """FUN_00430df0: ch3 -> thrust target (-1 keeps), ch0..2 -> control axes;
        nTick 0 resets (pose, body, thrust = target = Original Thrust, controls 0,
        v = M * Speed) and writes ch3 = -1, ch4 = -2, ch0..2 = 0 back into the
        AnimTask; nTick > 0 updates the attached rotors, then the physics."""
        if f32(ch[3]) != -1.0:
            self.target = f32(ch[3])
        self.inp = [f32(ch[0]), f32(ch[1]), f32(ch[2])]
        if n_tick == 0:
            self.pos = list(self.init_pos)
            ch[3], ch[4], ch[0], ch[1], ch[2] = -1.0, -2.0, 0.0, 0.0, 0.0
            self.m = list(self.init_m)
            self.setup_body()
            self.thrust = self.target = self.original_thrust
            self.c = [0.0, 0.0, 0.0]
            self.inp = [0.0, 0.0, 0.0]
            s = self.init_speed
            m = self.m
            self.body.v = [f32(m[0] * s[0] + m[1] * s[1] + m[2] * s[2]), f32(m[3] * s[0] + m[4] * s[1] + m[5] * s[2]),
                           f32(m[6] * s[0] + m[7] * s[1] + m[8] * s[2])]
            self.body.update_speed()
        if n_tick > 0:
            self.update_rotors()
            self.physics(world)

    def update_rotors(self):
        """FUN_0042c750 per attached rotor, with the thrust of the previous tick:
        main rotor: lift F = m g thrust along local z plus cos(angle(y_h, z)) F
        along local y; main / tail: +/- 2.5 m thrust along local x at (0, 2 m, 0)
        (they cancel exactly when both exist); spin angle += sign x spin x thrust."""
        mass = self.type["mass"]
        b = self.body
        for r in self.rotors:
            cfg = r["cfg"]
            if cfg["main"]:
                f = f32(mass * self.thrust * GRAVITY)
                if f != 0.0:
                    a = 0.0
                    yh = [self.m[1], self.m[4], 0.0]
                    zc = [self.m[2], self.m[5], self.m[8]]
                    if yh[0] != 0.0 or yh[1] != 0.0:
                        a = angle_between(yh, zc)
                    b.add([0.0, f32(math.cos(a) * f), f], [0.0, 0.0, 0.0])
            if self.thrust != 0.0 and (cfg["tail"] or cfg["main"]) and self.contacts == 0:
                k = f32(mass * self.thrust * ROTOR_TORQUE_K)
                b.add([-k if cfg["tail"] else k, 0.0, 0.0], [0.0, ROTOR_TORQUE_ARM, 0.0])
            r["angle"] = f32(cfg["spinSign"] * cfg["spin"] * self.thrust + r["angle"])

    def physics(self, world):
        """FUN_004310b0."""
        cfg = self.cfg["c"]
        mass = self.type["mass"]
        b = self.body
        step = cfg[8] if HELI_FAST_THRUST <= self.thrust else cfg[9]
        t = self.thrust
        if self.target <= t:
            if not t <= self.target:
                t = f32(t - step)
                if not self.target <= t:
                    t = self.target
        else:
            t = f32(t + step)
            if not t <= self.target:
                t = self.target
        if t < HELI_ZERO_THRUST and self.target == 0.0:
            t = 0.0
        self.thrust = t
        for k, (s, i) in enumerate(((cfg[2], 0), (cfg[4], 1), (cfg[6], 2))):
            self.c[k] = f32(s * self.c[k] + (1.0 - s) * self.inp[i])
        c0, c1, c2 = self.c
        if (c0 != 0.0 or c1 != 0.0 or c2 != 0.0) and (self.contacts == 0 or HELI_MOVING_SPEED < b.speed):
            b.add([0.0, f32(c0 * cfg[1] * mass * HELI_PITCH_K), 0.0], [0.0, 0.0, HELI_PITCH_ARM])
            b.add([f32(c1 * cfg[3] * mass), 0.0, 0.0], [0.0, 0.0, HELI_ROLL_ARM])
            b.add([f32(c2 * cfg[5] * t * mass * HELI_YAW_K), 0.0, 0.0], [0.0, HELI_YAW_ARM, 0.0])
        if self.contacts == 0 and HELI_MOVING_SPEED < b.speed:
            # weathervane: rotate about local x by -0.7 x tilt (the up axis leaning
            # toward local x) x yaw gain x 2.9e-4 rad (applied to M directly)
            m00, m10 = self.m[0], self.m[3]
            a = 0.0
            if m00 != 0.0 or m10 != 0.0:
                k = f32(1.0 / math.sqrt(f32(m10 * m10 + m00 * m00)))
                hx = f32(m00 * k)
                tilt = f32(hx * self.m[2] + m10 * k * self.m[5] + 0.0 * self.m[8])
                a = f32(tilt * (HELI_TURN_K_DOWN if self.m[8] <= 0.0 else HELI_TURN_K_UP))
            self.m = mat_mul(self.m, rot_x(f32(a * cfg[5] * HELI_TURN_K)))
        if not self.at_rest():
            self.skid_contacts(world)
            if self.cfg["drag"]:
                drag(b, self.cfg["drag"], self.m)
            self.integrate(GRAVITY, HELI_LIN_DAMP, HELI_ANG_DAMP)

    def skid_contacts(self, world):
        """FUN_004317d0: per HeliWheel a vertical ray from 2 m above the skid to
        `depth` (0.3 m) below; a hit deeper than `hard` (0.15 m) below the skid is
        a spring m g/4 (depth - (d - 2 m))/depth, a shallower one a stiff push
        m g/4 (2 - d/(hard + 2 m)) and lifts the heli by the penetration (only if
        the LAST contacting skid was the stiff kind - exe quirk); every contact
        damps v by (0.95, 0.95, 0.97) and L by 0.98."""
        b = self.body
        mass = self.type["mass"]
        self.contacts = 0
        deep = False
        lift = -1.7976931348623157e308
        for s in self.skids:
            p = self.skid_world(s)
            top = p[2] + SKID_RAY_UP
            length = s["depth"] + SKID_RAY_UP
            hit = world.cast_down(p[0], p[1], top, top - length)
            if hit is None or not hit["distance"] <= length:
                continue
            d = abs(hit["distance"])
            if s["hard"] + SKID_RAY_UP <= hit["distance"]:
                deep = False
                f = f32(((s["depth"] - (d - SKID_RAY_UP)) / s["depth"]) * mass * QUARTER_G)
            else:
                deep = True
                h = f32(s["hard"] + f32(SKID_RAY_UP))
                f = f32(((h - f32(d)) / h + 1.0) * mass * QUARTER_G)
                lift = max(lift, (s["hard"] + SKID_RAY_UP) - hit["distance"])
            b.add([0.0, 0.0, f], s["offset"])
            self.contacts += 1
            b.v = [f32(b.v[0] * f32(0.95)), f32(b.v[1] * f32(0.95)), f32(b.v[2] * f32(0.97))]
            b.L = [f32(c * f32(0.98)) for c in b.L]
        if deep:
            self.pos[2] += lift

    def render_parts(self):
        return {"rotors": [{"model": r["model"], "angle": r["angle"]} for r in self.rotors]}


def _type_for_model(types, model):
    """FUN_004e4cc0: the physics type whose model name equals the task's Model."""
    for t in types:
        if t["model"].lower() == model.lower():
            return t
    raise KeyError(f"no DefinePhysicsObjType for model {model}")


# ------------------------------------------------------------- car / truck

class Car(Physical):
    """Car task (class 0x539d58: create FUN_0042d420, update FUN_0042d5c0, compile
    FUN_0042e7d0, AnimTask input FUN_0042dcb0, physics FUN_0042df40, wheels
    FUN_0042e1a0, drive FUN_0042ff90, tyre friction FUN_0042fbe0)."""

    def __init__(self, task, types, models, magic):
        p = task["params"]
        ptype = _type_for_model(types, p["Model"])
        super().__init__(ptype, p["Position"], p["Orientation"], p["Original Thrust"], p["Speed"],
                         p["Collision detection"], p["Force Z"])
        self.id = task["id"]
        self.model = p["Model"]
        self.steer = self.steer_target = 0.0        # +0x72c / +0x73c
        self.brake = False                          # +0x744
        mv = models.magic_vertices(p["Model"])
        self.vertices = mv
        wheels = self.cfg["wheels"]
        # FUN_0042ea60: n driven / n steerable; wheels present only if the model's
        # TASKTYPE_WHEEL objects claim them (+0x260 = 1), in ATTA order (FUN_0042f280)
        self.n_driven = sum(1 for w in wheels if w["driven"])
        self.present = [not self.cfg["wheelsFromModel"]] * len(wheels)
        self.wheel_objects = []
        k = 0
        for a in models.attachments(p["Model"]):
            mo = magic.get(a["name"])
            if mo and mo["taskType"] == "TASKTYPE_WHEEL":
                if self.cfg["wheelsFromModel"] and k < len(wheels):
                    self.present[k] = True
                wt = _type_for_model(types, a["name"])["config"]
                self.wheel_objects.append({"model": a["name"], "index": k, "offset": a["offset"], "radius": wt["radius"],
                                           "rate": 0.0, "spin": 0.0, "steer": 0.0})
                k += 1
        self.wheel_contact = [False] * len(wheels)  # +0x75d + 0x1c i
        self.wheel_normal = [[0.0, 0.0, 0.0] for _ in wheels]
        self.wheel_point = [[0.0, 0.0, 0.0] for _ in wheels]
        self.reset_pose()

    def init_points(self):
        """FUN_004f2320 contact points (model magic vertices x scale 1) then
        FUN_0042ded0: wheel contact points lowered by the suspension offset."""
        self.points = []
        for pt in self.type["points"]:
            v = self.vertices[pt["vertex"]]
            self.points.append({"local": [f32(v[0]), f32(v[1]), f32(v[2])], "gripLateral": pt["gripLateral"],
                                "gripRolling": pt["gripRolling"], "side": pt["a"], "compression": 0.0, "touch": False})
        for w in self.cfg["wheels"]:
            if w["contact"] >= 0:
                q = self.points[w["contact"]]["local"]
                q[2] = f32(q[2] - self.cfg["suspensionOffset"])

    def reset_pose(self):
        self.pos, self.m = list(self.init_pos), list(self.init_m)
        self.setup_body()
        self.init_points()

    def anim_input(self, n_tick, ch, world):
        """FUN_0042dcb0: ch1 -> thrust target (-1 keeps), ch0 -> steering target,
        ch3 != -1 -> brake; nTick 0 resets (writes ch1 = -1, ch2 = -2), otherwise
        FUN_0042df40 steps the car."""
        if f32(ch[1]) != -1.0:
            self.target = f32(ch[1])
        self.steer_target = f32(ch[0])
        self.brake = f32(ch[3]) != -1.0
        if n_tick == 0:
            self.pos, self.m = list(self.init_pos), list(self.init_m)
            ch[1], ch[2] = -1.0, -2.0
            self.setup_body()
            self.init_points()
            self.thrust = self.steer = self.steer_target = 0.0
            self.brake = False
            self.thrust = self.target = self.original_thrust
        else:
            self.physics(world)
            self.update_wheel_objects()

    def physics(self, world):
        """FUN_0042df40."""
        cfg = self.cfg["c"]
        self.thrust = f32(cfg[8] * self.thrust + (1.0 - cfg[8]) * self.target)
        self.steer = f32(self.steer * cfg[6] + (1.0 - cfg[6]) * self.steer_target)
        if self.target == 0.0 and abs(self.thrust) < CAR_ZERO_THRUST:
            self.thrust = 0.0
        self.wheels(world)
        if not self.at_rest():
            if self.cfg["drag"]:
                drag(self.body, self.cfg["drag"], self.m)
            self.integrate(GRAVITY, CAR_LIN_DAMP, CAR_ANG_DAMP)

    def wheels(self, world):
        """FUN_0042e1a0: per present wheel with a contact point, a vertical ray
        from travel + 1 m above the (lowered) contact point to 0.5 m below it.
        Compression c = travel + 1 m - d (full travel and a stiffer push when the
        hit is in the top metre) -> spring force (c / travel) spring m g along
        local z at the contact point; then drive and tyre friction."""
        wheels = self.cfg["wheels"]
        mass = self.type["mass"]
        deep_any = False
        lift = -1.7976931348623157e308
        for i, w in enumerate(wheels):
            ci = w["contact"]
            if ci < 0 or not self.present[i]:
                continue
            pt = self.points[ci]
            p = self.local_to_world(pt["local"])
            top = (w["travel"] + p[2]) + CAR_RAY_UP
            bottom = (top - (w["travel"] + CAR_RAY_DOWN)) - CAR_RAY_UP
            hit = world.cast_down(p[0], p[1], top, bottom)
            comp = 0.0
            touched = False
            if hit is not None:
                dist = hit["distance"]
                deep = False
                skip = False
                if CAR_RAY_UP <= dist:
                    if dist <= CAR_RAY_UP or f32(w["travel"] + f32(4096.0)) <= f32(dist):
                        skip = True
                    else:
                        comp = f32((w["travel"] + f32(4096.0)) - f32(dist))
                else:
                    deep = deep_any = True
                    comp = w["travel"]
                    lift = max(lift, CAR_RAY_UP - dist)
                if not skip:
                    f = f32((comp / w["travel"]) * w["spring"] * mass * GRAVITY)
                    if deep:
                        f = f32((2.0 - dist * (1.0 / 4096.0)) * f)
                    self.body.add([0.0, 0.0, f], pt["local"])
                    touched = True
            diff = abs(f32(pt["compression"] - comp))
            if f32(0.001) < diff:
                if comp <= pt["compression"]:
                    comp = f32(comp * f32(0.95) + pt["compression"] * f32(0.05))
                pt["compression"] = comp
            self.wheel_contact[i] = touched
            pt["touch"] = touched
            if touched:
                n = [f32(c) for c in hit["normal"]]
                if n != [0.0, 0.0, 0.0]:
                    k = f32(1.0 / math.sqrt(f32(n[2] * n[2] + n[1] * n[1] + n[0] * n[0])))
                    n = [f32(c * k) for c in n]
                self.wheel_normal[i] = n
                q = pt["local"]
                self.wheel_point[i] = [q[0], q[1], f32(q[2] + CAR_WHEEL_POINT_LIFT)]
                self.contacts = 1
                self.drive(i, ci)
        if deep_any:
            self.pos[2] += lift

    def drive(self, i, ci):
        """FUN_0042ff90 (+ FUN_0042fbe0)."""
        w = self.cfg["wheels"][i]
        b = self.body
        m = self.m
        steer = f32(f32(w["maxSteerDeg"] * DEG) * self.steer)
        if w["driven"] and self.wheel_contact[i] and self.thrust != 0.0:
            n = self.wheel_normal[i]
            y = [m[1], m[4], m[7]]
            direction = [0.0, 0.0, 0.0]
            if n != y:
                a0 = f32(y[2] * n[1] - y[1] * n[2])
                a1 = f32(-(y[2] * n[0] - y[0] * n[2]))
                a2 = f32(y[1] * n[0] - y[0] * n[1])
                direction = [f32(a1 * n[2] - a2 * n[1]), f32(-(a0 * n[2] - a2 * n[0])), f32(a0 * n[1] - a1 * n[0])]
            power = (self.cfg["c"][7] * self.thrust * GRAVITY) / self.n_driven
            if self.cfg["differential"]:
                power *= self.differential(ci)
            power -= b.speed
            fw = [f32(power * direction[0]), f32(power * direction[1]), power * direction[2]]
            fl = [f32(fw[1] * m[3] + fw[2] * m[6] + fw[0] * m[0]), f32(fw[2] * m[7] + fw[0] * m[1] + fw[1] * m[4]),
                  f32(fw[1] * m[5] + fw[2] * m[8] + fw[0] * m[2])]
            r = rot_z(-steer)
            b.add([f32(r[1] * fl[1] + r[2] * fl[2] + r[0] * fl[0]), f32(r[4] * fl[1] + r[5] * fl[2] + r[3] * fl[0]),
                   f32(r[7] * fl[1] + r[8] * fl[2] + r[6] * fl[0])], self.wheel_point[i])
        if self.wheel_contact[i] and ci >= 0:
            if not w["steerable"]:
                steer = 0.0
            pt = self.points[ci]
            k_lat, k_roll = pt["gripLateral"], pt["gripRolling"]
            if self.brake:
                self.thrust = f32(self.thrust * f32(0.95))
                k_roll = k_lat
            tyre_friction(b, m, self.wheel_point[i], self.wheel_normal[i], steer, k_lat, k_roll)

    def differential(self, ci):
        """FUN_0042f730 (cfg +0x261; the level-1 truck does not use it)."""
        s = self.steer
        side = self.points[ci]["side"]
        if s <= CAR_ZERO_THRUST:
            if s < -CAR_ZERO_THRUST and side == 0:
                return s + 0.5 + s + 0.5
        elif side == 1:
            return (0.5 - s) + (0.5 - s)
        return 1.0

    def update_wheel_objects(self):
        """FUN_0042f440 (visual wheel spin and steer; no physics)."""
        cfg = self.cfg
        for wo in self.wheel_objects:
            w = cfg["wheels"][wo["index"]]
            ci = w["contact"] if w["contact"] >= 0 else -10 - w["contact"]
            rate = 0.0
            pt = self.points[ci]
            if not pt["touch"]:
                if w["driven"]:
                    rate = ((self.thrust * GRAVITY * cfg["c"][7]) / self.n_driven) * WHEEL_SPIN_K
            else:
                v = point_velocity(self.body, pt["local"])
                rate = f32(math.sqrt(f32(v[2] * v[2] + v[1] * v[1] + v[0] * v[0])))
                if rate < MOVE_THRESHOLD:
                    rate = 0.0
            wo["rate"] = f32(wo["rate"] * WHEEL_SPIN_SMOOTH + (rate / f32(wo["radius"] * f32(TWO_PI_D))) * f32(TWO_PI_D) * WHEEL_SPIN_GAIN)
            if w["steerable"]:
                wo["steer"] = f32(-(w["maxSteerDeg"] * self.steer * DEG))
            if self.brake:
                wo["rate"] = 0.0
            wo["spin"] = f32(wo["spin"] - wo["rate"])

    def render_parts(self):
        out = []
        for wo in self.wheel_objects:
            w = self.cfg["wheels"][wo["index"]]
            ci = w["contact"] if w["contact"] >= 0 else -10 - w["contact"]
            off = list(wo["offset"])
            off[2] = (self.points[ci]["compression"] + off[2]) - self.cfg["suspensionOffset"]
            out.append({"model": wo["model"], "offset": off, "spin": wo["spin"], "steer": wo["steer"]})
        return {"wheels": out}


def tyre_friction(b, m, p, n, steer, k_lat, k_roll):
    """FUN_0042fbe0: friction against the tangential velocity of the contact point,
    scaled per wheel axis (wheel frame = Rz(steer) of the body frame: x lateral
    k_lat, y rolling k_roll); static |v_t| m 0.1 up to |v_t| <= 4 g n_z, else
    kinetic 0.24 m g n_z."""
    load = f32(b.mass * GRAVITY * n[2])
    r = [f32(p[2] * m[2] + p[1] * m[1] + m[0] * p[0]), f32(m[4] * p[1] + m[3] * p[0] + m[5] * p[2]),
         f32(p[0] * m[6] + p[1] * m[7] + p[2] * m[8])]
    vp = point_velocity(b, r)
    vn = f32(vp[0] * n[0] + vp[1] * n[1] + vp[2] * n[2])
    u = [f32(n[0] * vn - vp[0]), f32(n[1] * vn - vp[1]), f32(n[2] * vn - vp[2])]
    mag = f32(math.sqrt(f32(u[2] * u[2] + u[1] * u[1] + u[0] * u[0])))
    if u != [0.0, 0.0, 0.0]:
        k = f32(1.0 / mag)
        u = [f32(c * k) for c in u]
    ul = [f32(u[2] * m[6] + u[0] * m[0] + u[1] * m[3]), f32(u[0] * m[1] + u[2] * m[7] + u[1] * m[4]),
          f32(u[2] * m[8] + u[0] * m[2] + u[1] * m[5])]
    rr = rot_z(steer)
    wz = f32(rr[6] * ul[0] + rr[7] * ul[1] + rr[8] * ul[2])
    wx = f32((rr[0] * ul[0] + rr[1] * ul[1] + rr[2] * ul[2]) * k_lat)
    wy = f32((rr[3] * ul[0] + rr[4] * ul[1] + rr[5] * ul[2]) * k_roll)
    bx = f32(rr[0] * wx + rr[3] * wy + rr[6] * wz)
    by = f32(rr[1] * wx + rr[4] * wy + rr[7] * wz)
    bz = f32(rr[2] * wx + rr[5] * wy + rr[8] * wz)
    if mag <= f32(load * FRICTION_LIMIT) / b.mass:
        s = mag * b.mass * FRICTION_STATIC
        f = [f32(bx * s), f32(by * s), f32(bz * s)]
    else:
        s = load * FRICTION_KINETIC
        f = [f32(bx * s), f32(by * s), f32(bz * s)]
    b.add(f, p)


# ------------------------------------------------------------- rail spline (SplineObj / SplineObjWaypoint)

class RailSpline:
    """SplineObj with its SplineObjWaypoint children.

    Segment k (k >= 1) belongs to waypoint k and spans waypoints k-1 -> k
    (FUN_004db070 called from the waypoint compile at 0x4f8361 with the previous
    waypoint's pose, this waypoint's "Segment Model" and piece count +0x198).
    FUN_004db1d0 samples a cubic Hermite per axis (FUN_00511e70 / FUN_00511ed0)
    from p0 to p1 with tangents = column 0 (local x) of each waypoint matrix x the
    3D chord, at s = i / n, i = 0..n, storing float points relative to the segment
    midpoint; piece lengths are float chord lengths.  Linear splines use one
    straight piece.  The spline's total length (+0x28) is the float sum of the
    segment lengths.  [recovered]  n = the waypoint's "NumAreas" [inferred: the
    field after "Segment Model" in the waypoint layout]."""

    def __init__(self, spline_task, gamma_quirk=True):
        p = spline_task["params"]
        self.id = spline_task["id"]
        self.linear = bool(p["Linear Segments"])
        wps = []
        for c in spline_task["children"]:
            if c["type"] != "SplineObjWaypoint":
                continue
            q = c["params"]
            wps.append({"pos": [float(v) for v in q["Position"]], "m": euler(*q["Orientation"]),
                        "segment": q["Segment Model"], "pieces": int(q["NumAreas"])})
        gamma = f32(p["Gamma Orientation"])
        if gamma_quirk and wps and gamma != PI_F:
            # FUN_004f9360: the SplineObj is created with gamma = previous gamma = pi
            # (0x4f9300); a different "Gamma Orientation" rotates every waypoint about
            # the first by Rz(gamma - pi) (x, y deltas rounded to float) and M = M R.
            r = rot_z(f32(gamma - PI_F))
            first = list(wps[0]["pos"])
            for w in wps:
                d = vsub(w["pos"], first)
                w["pos"] = [f32(r[0] * d[0] + r[1] * d[1] + r[2] * d[2]) + first[0],
                            f32(r[3] * d[0] + r[4] * d[1] + r[5] * d[2]) + first[1],
                            (r[6] * d[0] + r[7] * d[1] + r[8] * d[2]) + first[2]]
                w["m"] = mat_mul(w["m"], r)
        self.waypoints = wps
        self.segments = [None] + [self._segment(wps[k - 1], wps[k]) for k in range(1, len(wps))]
        total = 0.0
        for s in self.segments[1:]:
            total = f32(s["length"] + total)
        self.total = total

    def _segment(self, a, b):
        p0, p1 = a["pos"], b["pos"]
        chord = math.sqrt(sum((p0[i] - p1[i]) ** 2 for i in range(3)))
        mid = [(p0[i] + p1[i]) * 0.5 for i in range(3)]
        n = 1 if self.linear else b["pieces"]
        inv = f32(1.0 / f32(n))
        pts, lens, total = [], [], 0.0
        if self.linear:
            for i in range(2):
                s = float(i) * inv
                pts.append([f32((s * (p1[k] - p0[k]) + p0[k]) - mid[k]) for k in range(3)])
            d = [f32(p1[k] - p0[k]) for k in range(3)]
            ln = f32(f32(math.sqrt(f32(d[2] * d[2] + d[1] * d[1] + d[0] * d[0]))) * inv)
            lens = [ln, 0.0]
            total = f32(ln + total)
        else:
            coeffs = []
            for k in range(3):
                m0 = f32(a["m"][k * 3] * f32(chord))
                m1 = f32(b["m"][k * 3] * f32(chord))
                coeffs.append((p0[k], m0, ((p0[k] + p0[k]) - (p1[k] + p1[k])) + m0 + m1, ((p1[k] * 3 - p0[k] * 3) - (m0 + m0)) - m1))
            for i in range(n + 1):
                s = float(i) * inv
                pts.append([f32((s * c1 + s * s * c3 + s * s * s * c2 + c0) - mid[k]) for k, (c0, c1, c2, c3) in enumerate(coeffs)])
                if i > 0:
                    d = [f32(pts[i][k] - pts[i - 1][k]) for k in range(3)]
                    ln = f32(math.sqrt(f32(d[2] * d[2] + d[1] * d[1] + d[0] * d[0])))
                    lens.append(ln)
                    total = f32(ln + total)
            lens.append(0.0)
        return {"mid": mid, "points": pts, "lengths": lens, "pieces": n, "length": total,
                "model": b["segment"]}

    def world_point(self, seg, i):
        s = self.segments[seg]
        p = s["points"][i]
        return [p[0] + s["mid"][0], p[1] + s["mid"][1], p[2] + s["mid"][2]]

    def evaluate(self, distance, offsets):
        """FUN_004f5830(spline, 0, out, &ok, distance, len(offsets), offsets, 0):
        point 0 at arc `distance` (float, wrapped into [0, total)) on the piecewise-
        linear curve; point j+1 at Euclidean distance |offsets[j]| from point j,
        searched forward (offset > 0) or backward along the pieces (sphere /
        piece intersection by the laws of cosines and sines); while the current
        piece end is still farther than the offset, the arc estimate
        distance + sum(offsets) is used instead (exe quirk).  Returns the
        1 + len(offsets) points or None."""
        d = f32(distance)
        total = self.total
        nseg = len(self.segments)
        if total == 0.0 or nseg < 2:
            return None
        while d < 0.0:
            d = f32(d + total)
        while total <= d:
            d = f32(d - total)
        if d == 0.0:
            p = list(self.waypoints[0]["pos"])
            return [list(p) for _ in range(len(offsets) + 1)]
        # segment walk
        seg, acc = 0, 0.0
        while True:
            seg += 1
            if seg >= nseg:
                return None
            acc = f32(acc + self.segments[seg]["length"])
            if not acc < d:
                break
        acc = f32(acc - self.segments[seg]["length"])
        S = self.segments[seg]
        if acc == d:
            p = self.world_point(seg, 0)
            return [list(p) for _ in range(len(offsets) + 1)]
        k = 0
        while True:
            if S["pieces"] <= k:
                p = self.world_point(seg, S["pieces"])
                return [list(p) for _ in range(len(offsets) + 1)]
            acc = f32(acc + S["lengths"][k])
            k += 1
            if not acc < d:
                break
        k -= 1
        acc = f32(acc - S["lengths"][k])
        f = f32((d - acc) / S["lengths"][k])
        a, b = S["points"][k], S["points"][k + 1]
        out = [[f32((b[0] - a[0]) * f + a[0]) + S["mid"][0], f32((b[1] - a[1]) * f + a[1]) + S["mid"][1],
                f32((b[2] - a[2]) * f + a[2]) + S["mid"][2]]]
        arc = d
        for off in offsets:
            prev = out[-1]
            L = f32(off)
            L2 = f32(L * L)
            arc = f32(L + arc)
            res = self._next_point(seg, k, acc, arc, prev, L, L2)
            if res is None:
                break
            point, seg, k, acc = res
            out.append(point)
        while len(out) < len(offsets) + 1:   # ran off the spline (LAB_004f743a): clamp
            out.append(list(out[-1]))
        return out

    def _piece(self, seg, k):
        return self.world_point(seg, k), self.world_point(seg, k + 1)

    def _next_point(self, seg, k, acc, arc, prev, L, L2):
        S = self.segments[seg]
        if 0.0 <= L:
            a_end = self.world_point(seg, k + 1)
            if _d2(prev, a_end) <= L2:
                while True:
                    if k < self.segments[seg]["pieces"] - 1:
                        step = self.segments[seg]["lengths"][k]
                        k += 1
                    else:
                        nxt = seg + 1
                        if nxt >= len(self.segments):
                            last = self.world_point(seg, self.segments[seg]["pieces"])
                            return last, seg, k, acc
                        step = self.segments[seg]["lengths"][k]
                        seg, k = nxt, 0
                    acc = f32(acc + step)
                    s0, s1 = self._piece(seg, k)
                    a2, b2 = f32(_d2(prev, s0)), f32(_d2(prev, s1))
                    if (L2 < a2) != (L2 < b2):
                        break
                ln = self.segments[seg]["lengths"][k]
                a = f32(math.sqrt(a2))
                g = _acos_c(f32(((b2 - a2) - ln * ln) / (a * ln * -2.0)))
                sg = math.sin(g)
                rest = f32(PI_F - g)
                dl = _asin_c(f32((f32(sg) / L) * a))
                if rest - dl <= SPLINE_DEGENERATE:
                    f = (L - a) / (math.sqrt(b2) - a)
                else:
                    f = ((math.sin(rest - dl) * L) / f32(sg)) / ln
                f = f32(f)
            else:
                f = f32((arc - acc) / S["lengths"][k])
                s0, s1 = self._piece(seg, k)
        else:
            a_start = self.world_point(seg, k)
            if _d2(prev, a_start) <= L2:
                while True:
                    if k == 0:
                        prv = seg - 1
                        if prv < 1:
                            first = self.world_point(seg, 0)
                            return first, seg, k, acc
                        seg = prv
                        k = self.segments[seg]["pieces"]
                        step = self.segments[seg]["lengths"][k - 1]
                    else:
                        step = self.segments[seg]["lengths"][k - 1]
                    k -= 1
                    acc = f32(acc - step)
                    s0, s1 = self._piece(seg, k)
                    a2, b2 = f32(_d2(prev, s0)), f32(_d2(prev, s1))
                    if (L2 < a2) != (L2 < b2):
                        break
                ln = self.segments[seg]["lengths"][k]
                bl = f32(math.sqrt(b2))
                g = _acos_c(f32(((a2 - b2) - ln * ln) / (bl * ln * -2.0)))
                Lp = -L
                sg = math.sin(g)
                rest = f32(PI_F - g)
                dl = _asin_c(f32((f32(sg) / Lp) * bl))
                if rest - dl <= SPLINE_DEGENERATE:
                    f = (Lp - math.sqrt(a2)) / (bl - math.sqrt(a2))
                else:
                    f = 1.0 - ((math.sin(rest - dl) * Lp) / f32(sg)) / ln
                f = f32(f)
            else:
                f = f32((arc - acc) / S["lengths"][k])
                s0, s1 = self._piece(seg, k)
        point = [(s1[i] - s0[i]) * f + s0[i] for i in range(3)]
        return point, seg, k, acc


def _d2(a, b):
    """FUN_004a95d0: squared distance of two double points."""
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2


def _acos_c(x):
    """FUN_004a8a40."""
    return math.acos(max(-1.0, min(1.0, x)))


def _asin_c(x):
    """FUN_004a8ab0."""
    return math.asin(max(-1.0, min(1.0, x)))


# ------------------------------------------------------------- trains

class Train:
    """Train task (class DAT_0057f1f0; create FUN_00429390, compile FUN_00429560,
    update FUN_0042aa90, AnimTask input FUN_0042a450, placement FUN_004296d0 +
    FUN_00429bd0).  Wagons are the child Train tasks, in file order."""

    def __init__(self, task, spline, models):
        p = task["params"]
        self.id = task["id"]
        self.spline = spline
        self.flip = bool(p["Flip Direction"])
        self.cars = []
        for t in [task] + [c for c in task["children"] if c["type"] == "Train"]:
            q = t["params"]
            mv = models.magic_vertices(q["Model"])
            # FUN_00429560: length = |x0 - x1| of magic vertices 0 and 1; frac = |x0| / length
            length = abs(f32(f32(mv[0][0]) - f32(mv[1][0])))
            self.cars.append({"id": t["id"], "model": q["Model"], "length": length,
                              "frac": f32(abs(f32(mv[0][0])) / length),
                              "disp": [f32(f32(q["Displacement X"]) * 4096.0), f32(f32(q["Displacement Y"]) * 4096.0)]})
        self.distance = self.original_distance = f32(p["Position"])
        self.original_thrust = f32(p["Original thrust"])
        self.thrust_step = f32(p["ThrustStep"])
        self.max_speed = f32(p["MaxSpeed"])
        self.thrust = self.target = self.original_thrust
        self.speed = 0.0

    def anim_input(self, n_tick, ch):
        """FUN_0042a450 (as mission.ts trainAnimInput)."""
        if f32(ch[0]) != -1.0:
            self.target = f32(ch[0])
        if n_tick == 0:
            ch[1] = -2.0
            self.distance = f32(self.original_distance)
            self.speed = f32(self.max_speed * self.original_thrust * TRAIN_SPEED_K)
            self.thrust = self.target = self.original_thrust
            return
        if self.thrust < self.target:
            self.thrust = min(f32(self.thrust + self.thrust_step), self.target)
        elif self.target < self.thrust:
            self.thrust = max(f32(self.thrust - self.thrust_step), self.target)
        v = f32(self.max_speed * self.thrust * TRAIN_KMH[0] * TRAIN_KMH[1])
        self.speed = v
        self.distance = f32((-v if self.flip else v) + self.distance)

    def poses(self, distance=None):
        """FUN_004296d0 / FUN_00429bd0: coupling points from the spline, then each
        car between points j and j+1: local x = -unit(p1 - p0) (= direction of
        travel for flipped trains), local z = up-ish frame of FUN_004aa2f0,
        origin = p0 + frac (p1 - p0) + M (0, dispX, dispY)."""
        d = self.distance if distance is None else distance
        offs = [(c["length"] if self.flip else -c["length"]) for c in self.cars]
        pts = self.spline.evaluate(d, offs)
        if pts is None:
            return None
        out = []
        for j, c in enumerate(self.cars):
            p0, p1 = pts[j], pts[j + 1]
            if p0 == p1:
                m = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
                pos = list(p0)
            else:
                m = _train_frame([f32(p1[i] - p0[i]) for i in range(3)])
                pos = [(p1[i] - p0[i]) * c["frac"] + p0[i] for i in range(3)]
            dx, dy = c["disp"]
            pos = [(dy * m[2] + dx * m[1]) + pos[0], (dx * m[4] + dy * m[5]) + pos[1], (dy * m[8] + dx * m[7]) + pos[2]]
            out.append({"id": c["id"], "model": c["model"], "position": pos, "matrix": m, "front": p0, "back": p1})
        return out


def _train_frame(d):
    """FUN_004aa2f0(m, d) followed by FUN_004296d0's row shuffle and transpose:
    rows A = unit(r x d), B = unit(d x A'), C = unit(A x B') with r = unit(dy, -dx, 0);
    result columns (-C, B, A)."""
    dx, dy, dz = d
    if dx == 0.0 and dy == 0.0:
        r = [0.0, 1.0, 0.0]
    else:
        k = f32(1.0 / math.sqrt(f32(-dx * -dx + dy * dy)))
        r = [f32(dy * k), f32(-dx * k), 0.0]
    a1, a2, a3 = f32(dz * r[1] - dy * 0.0), f32(-(dz * r[0] - dx * 0.0)), f32(r[0] * dy - r[1] * dx)
    A = [a1, a2, a3]
    if A != [0.0, 0.0, 0.0]:
        k = f32(1.0 / math.sqrt(f32(a3 * a3 + a2 * a2 + a1 * a1)))
        A = [f32(a1 * k), f32(a2 * k), f32(a3 * k)]
    B = [f32(a3 * dy - a2 * dz), f32(-(a3 * dx - a1 * dz)), f32(a2 * dx - a1 * dy)]
    C = [f32(B[2] * A[1] - B[1] * A[2]), f32(-(B[2] * A[0] - B[0] * A[2])), f32(B[1] * A[0] - B[0] * A[1])]
    if B != [0.0, 0.0, 0.0]:
        k = f32(1.0 / math.sqrt(f32(B[0] * B[0] + B[1] * B[1] + B[2] * B[2])))
        B = [f32(c * k) for c in B]
    if C != [0.0, 0.0, 0.0]:
        k = f32(1.0 / math.sqrt(f32(C[2] * C[2] + C[1] * C[1] + C[0] * C[0])))
        C = [f32(c * k) for c in C]
    return [-C[0], B[0], A[0], -C[1], B[1], A[1], -C[2], B[2], A[2]]


# ------------------------------------------------------------- world queries

class FlatWorld:
    """Vertical ray caster over a horizontal plane z = height."""

    def __init__(self, height):
        self.height = height

    def cast_down(self, x, y, top, bottom):
        if bottom <= self.height <= top:
            return {"distance": top - self.height, "normal": [0.0, 0.0, 1.0]}
        return None


class LevelWorld:
    """Vertical ray caster over the level-1 terrain (tools/terrain_ctr.py, with
    HeightMap relief) and, optionally, the set-0 collision meshes (the set every
    FUN_004c24c0 ray reads, docs/collision.md) of the static placed models
    (Building, EditRigidObj, Fence, ...) inside `bbox`.  Vehicles, doors and
    trains are dynamic and excluded (the exe's ray filter skips the vehicle
    itself; the outro gates are open before the truck reaches them)."""

    STATIC_TYPES = {"Building": ("Position", "Orientation", "Model"), "EditRigidObj": ("Position", "Orientation", "Model"),
                    "ExplodeObject": ("Position", "Orientation", "Model"), "Terminal": ("Position", "Orientation", "Model"),
                    "AlarmControl": ("Position", "Orientation", "Model"), "SCameraControl": ("Position", "Orientation", "Model"),
                    "Fence": ("Position", "Gamma", "Model")}

    def __init__(self, tasks, bbox=None, cell=8 * 4096.0):
        import terrain_ctr
        tdir = GAME / LEVEL / "terrain"
        hm = []
        for t in tasks:
            if t["type"] == "HeightMap":
                q = t["params"]
                hm.append({"position": q.get("Position"), "level": q.get("Level"), "size": q.get("Size"), "bitmap_id": q.get("Bitmap ID")})
        self.terrain = terrain_ctr.Terrain((tdir / "terrain.ctr").read_bytes(), (tdir / "terrain.cmd").read_bytes(),
                                           (tdir / "terrain.hmp").read_bytes(), terrain_ctr.LEVEL1_HEIGHTMAPS)
        self.cell = cell
        self.grid = {}
        self.triangles = 0
        if bbox is not None:
            self._load_models(tasks, bbox)

    def _load_models(self, tasks, bbox):
        import igi_collision
        _files, models = igi_collision.load_models()
        cache = {}

        def coll(name):
            if name not in cache:
                body = models.get(name)
                c = igi_collision.read_collision(body[1], name) if body else None
                cache[name] = (c, _attachments(body[1]) if body else [])
            return cache[name]

        x0, y0, x1, y1 = bbox
        for t in tasks:
            spec = self.STATIC_TYPES.get(t["type"])
            if not spec:
                continue
            q = t["params"]
            pos, rot, model = q.get(spec[0]), q.get(spec[1]), q.get(spec[2])
            if not isinstance(pos, list) or not isinstance(model, str) or not model:
                continue
            if not (x0 - 200000 <= pos[0] <= x1 + 200000 and y0 - 200000 <= pos[1] <= y1 + 200000):
                continue
            r = euler(0, 0, rot) if spec[1] == "Gamma" else euler(*rot)
            self._place(model.lower(), [float(c) for c in pos], r, coll, 0, bbox)

    def _place(self, name, pos, r, coll, depth, bbox):
        c, atta = coll(name)
        if c:
            s = c["sets"][0]
            verts = [[pos[k] + r[k * 3] * v[0] + r[k * 3 + 1] * v[1] + r[k * 3 + 2] * v[2] for k in range(3)] for v in s["verts"]]
            for f in s["faces"]:
                if s["surfaces"][f[3]]["portal"] >= 0:
                    continue
                tri = (verts[f[0]], verts[f[1]], verts[f[2]])
                xs = [p[0] for p in tri]
                ys = [p[1] for p in tri]
                if max(xs) < bbox[0] or min(xs) > bbox[2] or max(ys) < bbox[1] or min(ys) > bbox[3]:
                    continue
                for gx in range(int(math.floor(min(xs) / self.cell)), int(math.floor(max(xs) / self.cell)) + 1):
                    for gy in range(int(math.floor(min(ys) / self.cell)), int(math.floor(max(ys) / self.cell)) + 1):
                        self.grid.setdefault((gx, gy), []).append(tri)
                self.triangles += 1
        if depth >= 4:
            return
        for a in atta:
            local = [a["matrix"][0], a["matrix"][3], a["matrix"][6], a["matrix"][1], a["matrix"][4], a["matrix"][7],
                     a["matrix"][2], a["matrix"][5], a["matrix"][8]]   # row-vector ATTA matrix -> column form
            off = a["offset"]
            p = [pos[k] + r[k * 3] * off[0] + r[k * 3 + 1] * off[1] + r[k * 3 + 2] * off[2] for k in range(3)]
            rr = [sum(r[i * 3 + k] * local[k * 3 + j] for k in range(3)) for i in range(3) for j in range(3)]
            self._place(a["name"], p, rr, coll, depth + 1, bbox)

    def cast_down(self, x, y, top, bottom):
        best = None
        for cell in self.terrain.column_cells(x, y):
            V, T = self.terrain.cell_mesh(*cell)
            for (i, j, k) in T:
                h = _vertical_hit(V[i], V[j], V[k], x, y)
                if h and bottom <= h[0] <= top and (best is None or h[0] > best[0]):
                    best = h
        for tri in self.grid.get((int(math.floor(x / self.cell)), int(math.floor(y / self.cell))), ()):
            h = _vertical_hit(tri[0], tri[1], tri[2], x, y)
            if h and bottom <= h[0] <= top and (best is None or h[0] > best[0]):
                best = h
        if best is None:
            return None
        return {"distance": top - best[0], "normal": best[1]}


def _vertical_hit(a, b, c, x, y):
    d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
    if d == 0:
        return None
    l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d
    l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d
    l3 = 1.0 - l1 - l2
    if l1 < -1e-9 or l2 < -1e-9 or l3 < -1e-9:
        return None
    z = l1 * a[2] + l2 * b[2] + l3 * c[2]
    u = vsub(b, a)
    v = vsub(c, a)
    n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    ln = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2) or 1.0
    n = [c_ / ln for c_ in n]
    if n[2] < 0:
        n = [-c_ for c_ in n]
    return (z, n)


# ------------------------------------------------------------- level-1 replay

VEHICLE_IDS = (1502, 1508, 1501, 1507, 1999, 2333, 2099, 3555, 1499, 1099)
GATE_X = 24979312.0                       # Door 400 / 401 "Position start" x (observed)
GATE_Y = (-56218464.0, -56202112.0)       # Door 400 / 401 "Position start" y


class Replay:
    """Runs tools/igi_mission.py's Runtime (the Python MissionRuntime) and drives
    the vehicles from the AnimTask inputs it sends (FUN_004eace0); snapshots every
    vehicle pose whenever a CutScene applies its camera (its own tree position)."""

    def __init__(self, world=None):
        import igi_mission
        self.igi_mission = igi_mission
        self.tasks = read_tasks((GAME / LEVEL / "objects.qvm").read_bytes())
        self.byid = {t["id"]: t for t in self.tasks if t["id"] >= 0}
        self.types, self.models, self.magic = read_physics_types(), Models(), read_magic_objects()
        self.world = world if world is not None else FlatWorld(-1e18)
        self.splines, self.trains, self.vehicles = {}, {}, {}
        for t in self.tasks:
            if t["type"] == "Train" and (t["parent"] is None or t["parent"]["type"] != "Train"):
                sid = t["params"]["RailroadQTaskID"]
                if sid not in self.splines:
                    self.splines[sid] = RailSpline(self.byid[sid])
                self.trains[t["order"]] = Train(t, self.splines[sid], self.models)
            elif t["type"] == "Heli":
                self.vehicles[t["order"]] = Heli(t, self.types, self.models, self.magic)
            elif t["type"] == "Car":
                self.vehicles[t["order"]] = Car(t, self.types, self.models, self.magic)
        self.snapshots = []
        self.inputs = {}
        replay = self

        class RT(igi_mission.Runtime):
            def _anim_input(self, anim, n_tick, ch):
                super()._anim_input(anim, n_tick, ch)
                target = self.ids.get(anim["params"]["TargetID"])
                if target is None:
                    return
                if target["type"] == "Train":
                    tr = replay.trains.get(target["order"])
                    if tr is not None:
                        tr.anim_input(n_tick, ch)
                    return
                v = replay.vehicles.get(target["order"])
                if v is not None:
                    v.anim_input(n_tick, ch, replay.world)
                    replay.inputs.setdefault(target["id"], []).append((self.level_tick + 1, n_tick))

            def update(self, t):
                if t["type"] == "CutScene":
                    s = self._st(t)
                    n_before = s["nTick"]
                    super().update(t)
                    if s["isRun"]:
                        replay.snapshot(self.level_tick + 1, t, n_before)
                    return
                super().update(t)

        self.RT = RT

    def poses(self):
        out = {}
        for tr in self.trains.values():
            for p in tr.poses() or []:
                out[p["id"]] = {"position": p["position"], "matrix": p["matrix"]}
        for v in self.vehicles.values():
            out[v.id] = v.pose()
        return out

    def snapshot(self, level_tick, cut_task, n_tick):
        self.snapshots.append({"tick": level_tick, "cut": cut_task["id"], "nTick": n_tick, "poses": self.poses()})

    def run(self, ticks, outro_tick=None):
        """Intro from the first tick; with outro_tick the player stands in area 200
        (the truck objective) from that tick on, which starts the outro."""
        player = next(t for t in self.tasks if t["type"] == "HumanPlayer")
        state = {"tick": 0}

        def humans():
            if outro_tick is not None and state["tick"] >= outro_tick:
                return [(list(self.byid[200]["params"]["Position"]), 0)]
            return [(list(player["params"]["Position"]), 0)]
        rt = self.RT(self.tasks, humans=humans, log=[])
        # compile ran in the constructor (AnimTasks rewound their targets): link poses
        self.compile_poses = self.poses()
        self.runtime = rt
        for _ in range(ticks):
            if rt.complete:
                break
            state["tick"] += 1
            rt.tick()
        return rt


# ------------------------------------------------------------- camera framing

def camera_view(cut, n_tick, poses, compile_poses, igi_mission):
    """Cut-scene camera at nTick with link (p' = cur + Rcur Rinit^T (p - init)) and
    target (look-at the target origin), as mission.ts applyCameraLink / cameraLookAt."""
    cam = igi_mission.sample_camera(cut, n_tick)
    if cam is None:
        return None
    pos = list(cam["position"])
    m = [float(c) for row in igi_mission.euler_matrix(cam["alpha"], cam["beta"], cam["gamma"]) for c in row]
    link, target = cam["link"], cam["target"]
    if link is not None and link >= 0:
        init, cur = compile_poses.get(link), poses.get(link)
        if init and cur:
            rel = _mm(cur["matrix"], _mt(init["matrix"]))
            d = vsub(pos, init["position"])
            pos = [cur["position"][i] + rel[i * 3] * d[0] + rel[i * 3 + 1] * d[1] + rel[i * 3 + 2] * d[2] for i in range(3)]
            m = _mm(rel, m)
    if target is not None and target >= 0 and poses.get(target):
        m = _look_at(pos, poses[target]["position"])
    return {"position": pos, "matrix": m, "fov": cam["fov"], "key": cam["key"], "link": link, "target": target}


def _mm(a, b):
    return [sum(a[r * 3 + k] * b[k * 3 + c] for k in range(3)) for r in range(3) for c in range(3)]


def _mt(m):
    return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]


def _look_at(frm, to):
    """FUN_004ff480 (as mission.ts cameraLookAt): columns right, down, forward."""
    f = vsub(to, frm)
    ln = math.sqrt(sum(c * c for c in f))
    f = [1.0, 0.0, 0.0] if ln == 0 else [c / ln for c in f]
    r = [f[1], -f[0], 0.0]
    rl = math.hypot(r[0], r[1])
    if rl:
        r = [r[0] / rl, r[1] / rl, 0.0]
    u = [-f[0] * f[2], -f[1] * f[2], f[0] * f[0] + f[1] * f[1]]
    ul = math.sqrt(sum(c * c for c in u))
    if ul:
        u = [c / ul for c in u]
    return [r[0], -u[0], f[0], r[1], -u[1], f[1], r[2], -u[2], f[2]]


def project(view, point):
    """Screen position of a world point: x right, y down, +-1 at the frustum edges
    (horizontal tangent = fov, vertical = 0.75 fov, docs/rendering.md); depth in m."""
    d = vsub(point, view["position"])
    m = view["matrix"]
    xr = m[0] * d[0] + m[3] * d[1] + m[6] * d[2]
    yd = m[1] * d[0] + m[4] * d[1] + m[7] * d[2]
    zf = m[2] * d[0] + m[5] * d[1] + m[8] * d[2]
    if zf <= 0:
        return {"behind": True, "depth_m": zf / UNITS_PER_METRE}
    return {"behind": False, "x": xr / (zf * view["fov"]), "y": yd / (zf * view["fov"] * 0.75), "depth_m": zf / UNITS_PER_METRE}


def framing(replay):
    """Per cut-scene key: for every vehicle the camera links to, targets, or shows
    on screen, the range of its screen position and depth over the key."""
    cuts = {t["id"]: replay.igi_mission.cut_scene(t) for t in replay.tasks if t["type"] == "CutScene"}
    rows = {}
    for s in replay.snapshots:
        view = camera_view(cuts[s["cut"]], s["nTick"], s["poses"], replay.compile_poses, replay.igi_mission)
        if view is None:
            continue
        for vid in VEHICLE_IDS:
            p = s["poses"].get(vid)
            if not p:
                continue
            pr = project(view, p["position"])
            visible = not pr["behind"] and abs(pr["x"]) <= 1 and abs(pr["y"]) <= 1
            role = "target" if view["target"] == vid else "link" if view["link"] == vid else "visible" if visible else None
            if role is None:
                continue
            key = (s["cut"], view["key"], vid)
            r = rows.setdefault(key, {"cut": s["cut"], "key": view["key"], "vehicle": vid, "role": role, "ticks": [s["tick"], s["tick"]],
                                      "depth": [pr["depth_m"], pr["depth_m"]], "x": [], "y": [], "inFrame": 0, "samples": 0})
            r["ticks"][1] = s["tick"]
            r["depth"] = [min(r["depth"][0], pr["depth_m"]), max(r["depth"][1], pr["depth_m"])]
            r["samples"] += 1
            if not pr["behind"]:
                r["x"].append(pr["x"])
                r["y"].append(pr["y"])
                r["inFrame"] += int(visible)
    out = []
    for r in rows.values():
        xs, ys = r.pop("x"), r.pop("y")
        r["xRange"] = [round(min(xs), 2), round(max(xs), 2)] if xs else None
        r["yRange"] = [round(min(ys), 2), round(max(ys), 2)] if ys else None
        r["depth"] = [round(r["depth"][0], 1), round(r["depth"][1], 1)]
        out.append(r)
    return sorted(out, key=lambda r: (r["ticks"][0], r["vehicle"]))


# ------------------------------------------------------------- report

def trajectories(replay):
    """Vehicle positions at every cut-scene camera apply: {id: [(tick, cut, nTick, pos)]}."""
    out = {}
    for s in replay.snapshots:
        for vid, pose in s["poses"].items():
            out.setdefault(vid, []).append((s["tick"], s["cut"], s["nTick"], pose["position"]))
    return out


def moving_span(rows):
    """First and last row index where the position changes (the vehicle is driven)."""
    idx = [i for i in range(1, len(rows)) if rows[i][3] != rows[i - 1][3]]
    return (idx[0] - 1, idx[-1]) if idx else None


def full_replay(collision=True):
    tasks = read_tasks((GAME / LEVEL / "objects.qvm").read_bytes())
    world = LevelWorld(tasks, bbox=(24700000, -56700000, 25300000, -55900000) if collision else None)
    rp = Replay(world)
    rp.run(3800, outro_tick=2950)
    return rp, world


def print_report(rp, world, as_json=False):
    types = rp.types
    bell = _type_for_model(types, "709_01_1")
    truck = _type_for_model(types, "622_01_1")
    rail = rp.splines[1500]
    traj = trajectories(rp)
    frames = framing(rp)
    origin = rp.byid[0]["params"]["Position"]
    if as_json:
        out = {"origin": origin, "rail": {"total": rail.total, "segments": [
            {"pieces": s["pieces"], "length": s["length"], "model": s["model"]} for s in rail.segments[1:]]},
            "trajectories": {str(v): [{"tick": t, "cut": c, "nTick": n, "position": p} for (t, c, n, p) in rows if n % 30 == 0]
                             for v, rows in traj.items()},
            "framing": frames}
        print(json.dumps(out, indent=1))
        return
    print(f"physicsobj: {len(types)} DefinePhysicsObjType entries in {len({t['source'] for t in types})} files")
    print(f"  heli 709_01_1 (helis/bell): mass {bell['mass']}, box {bell['size']} m, c = {bell['config']['c']}")
    print(f"    drag {[(e['coef'], e['normal']) for e in bell['config']['drag']]}")
    print(f"  truck 622_01_1 (cars/cutscene_truck): mass {truck['mass']}, c = {truck['config']['c']}, "
          f"suspension offset {truck['config']['suspensionOffset']}")
    for i, w in enumerate(truck["config"]["wheels"]):
        print(f"    wheel {i}: {w}")
    print(f"SplineObj 1500: {len(rail.waypoints)} waypoints, {sum(s['pieces'] for s in rail.segments[1:])} pieces, "
          f"total {rail.total:.1f} units ({rail.total / 4096:.1f} m)")
    print(f"ground: terrain octree + {world.triangles} static model collision triangles near the base")
    print("positions every second (m from the HumanPlayer_0 spawn; x east, y north, z up):")
    for vid in VEHICLE_IDS:
        rows = traj.get(vid, [])
        span = moving_span(rows)
        if not span:
            continue
        rows = rows[span[0]:span[1] + 1]
        print(f"  {vid}: level ticks {rows[0][0]}..{rows[-1][0]}")
        for (t, c, n, p) in rows:
            if (t - rows[0][0]) % 30 == 0 or (t, c, n, p) == rows[-1]:
                print(f"    t{t:5d} CutScene_{c} nTick {n:4d}  {metres(p, origin)}")
    print("camera framing (vehicle origin on screen: x, y in [-1, 1]; depth m):")
    for r in frames:
        print(f"  CutScene_{r['cut']} key {r['key']:2d} {r['role']:7s} {r['vehicle']}: ticks {r['ticks'][0]}..{r['ticks'][1]} "
              f"x {r['xRange']} y {r['yRange']} depth {r['depth']} in frame {r['inFrame']}/{r['samples']}")


def metres(p, origin):
    return [round((p[i] - origin[i]) / UNITS_PER_METRE, 2) for i in range(3)]


# ------------------------------------------------------------- standalone AnimTask replay

def anim_records(task):
    ad = task["params"]["AnimData"]
    return [(int(ad[1 + 2 * i]), ad[2 + 2 * i]) for i in range(int(ad[0]))]


def standalone(vehicle, records, updates, world):
    """Drive one vehicle from its AnimTask outside the mission runtime: compile
    seek(0), then `updates` updates seek(nTick + 1) (FUN_004eab70 / FUN_004eabe0,
    as mission.ts seekAnimPlayback).  Returns the pose after every update."""
    ch = [0.0] * 34
    state = {"n": 0}

    def step():
        if int(round(ch[33])) < len(records):
            if ch[32] != 0:
                ch[32] = f32(ch[32] - 1)
                if ch[32] == 0:
                    ch[33] = f32(ch[33] + 1)
            while ch[32] == 0:
                cur = int(round(ch[33]))
                if cur >= len(records):
                    break
                c, v = records[cur]
                ch[c] = f32(v)
                if ch[32] == 0:
                    ch[33] = f32(ch[33] + 1)

    def seek(n):
        if n == 0 or n < state["n"]:
            for i in range(34):
                ch[i] = 0.0
            state["n"] = 0
            for _ in range(n + 1):
                step()
                vehicle.anim_input(state["n"], ch, world)
        else:
            while state["n"] < n:
                step()
                vehicle.anim_input(state["n"], ch, world)
                state["n"] += 1
    seek(0)
    out = []
    for _ in range(updates):
        seek(state["n"] + 1)
        out.append({"nTick": state["n"] - 1, "position": list(vehicle.pos), "matrix": list(vehicle.m),
                    "thrust": vehicle.thrust, "speed": vehicle.body.speed})
    return out


def golden():
    """Reference values for web-port/tests/vehicles.test.ts (TS / Python parity)."""
    tasks = read_tasks((GAME / LEVEL / "objects.qvm").read_bytes())
    byid = {t["id"]: t for t in tasks if t["id"] >= 0}
    types, models, magic = read_physics_types(), Models(), read_magic_objects()
    anim = {t["params"]["TargetID"]: t for t in tasks if t["type"] == "AnimTask"}
    out = {}
    h = Heli(byid[1502], types, models, magic)
    run = standalone(h, anim_records(anim[1502]), 560, FlatWorld(-1e18))
    out["heli1502"] = {str(k): run[k]["position"] for k in (0, 29, 89, 179, 269, 359, 449, 539, 559)}
    c = Car(byid[1099], types, models, magic)
    run = standalone(c, anim_records(anim[1099]), 750, FlatWorld(174413931.0))
    out["truck1099"] = {str(k): run[k]["position"] for k in (0, 29, 89, 179, 269, 359, 449, 539, 629, 749)}
    rail = RailSpline(byid[1500])
    out["railTotal"] = rail.total
    tr = Train(byid[1999], rail, models)
    out["train1999"] = {str(d): [p["position"] for p in tr.poses(d)] for d in (-971400.125, 1000000.0, 4460000.0)}
    return out


# ------------------------------------------------------------- self-checks

def self_checks(rp=None):
    errors = []

    def check(cond, msg):
        if not cond:
            errors.append(msg)
    types = read_physics_types()
    check(len(types) == 37, f"expected 37 physics types, got {len(types)}")
    bell = _type_for_model(types, "709_01_1")
    check(bell["config"]["c"] == [f32(x) for x in (200, 50, 0.4, 50, 0.4, 50, 0.4, 3000, 0.027, 0.003)], "bell config")
    check([e["coef"] for e in bell["config"]["drag"]] == [20.0, 3.0, 50.0], "bell drag elements")
    truck = _type_for_model(types, "622_01_1")
    check([w["contact"] for w in truck["config"]["wheels"]] == [1, 0, -10, 2, -13, 3], "truck wheel contacts")
    check([w["driven"] for w in truck["config"]["wheels"]] == [True, False, False, True, False, False], "truck driven wheels")
    check(truck["config"]["suspensionOffset"] == f32(819.2), "truck suspension offset")
    b = Body()
    b.setup(3000.0, bell["size"])
    expect = 3000 * ((2.2 * 4096) ** 2 + (7.8 * 4096) ** 2) / 12
    check(abs(1.01 / b.inv_inertia[2] - expect) / expect < 1e-5, "box inertia")
    tasks = read_tasks((GAME / LEVEL / "objects.qvm").read_bytes())
    byid = {t["id"]: t for t in tasks if t["id"] >= 0}
    models, magic = Models(), read_magic_objects()
    # hover: thrust 1, level heli: lift (main rotor) cancels gravity exactly
    h = Heli(byid[1502], types, models, magic)
    check([r["model"] for r in h.rotors] == ["711_01_1", "712_01_1"], "bell rotors")
    check(len(h.skids) == 4 and h.skids[0]["depth"] == f32(1228.8) and h.skids[0]["hard"] == f32(614.4), "bell skids")
    h.init_m = euler(0, 0, 0)
    ch = [0.0] * 34
    h.anim_input(0, ch, FlatWorld(-1e18))
    h.thrust = h.target = 1.0
    z0 = h.pos[2]
    for _ in range(60):
        h.anim_input(1, ch, FlatWorld(-1e18))
    check(h.pos[2] == z0 and h.body.speed < 1.0, f"hover drifted {h.pos[2] - z0}")
    # trains: couplings at chord = car length; locomotive poses = the AnimTasks' editor positions
    rail = RailSpline(byid[1500])
    check(abs(rail.total - 4461268.0) < 1.0, f"rail length {rail.total}")
    anim = {t["params"]["TargetID"]: t["params"] for t in tasks if t["type"] == "AnimTask"}
    for tid in (1499, 1501, 1999, 2099):
        tr = Train(byid[tid], rail, models)
        ps = tr.poses()
        for j in range(len(ps)):
            dd = math.sqrt(_d2(ps[j]["front"], ps[j]["back"]))
            check(abs(dd - tr.cars[j]["length"]) < 4.0, f"train {tid} coupling {j}: chord {dd} vs {tr.cars[j]['length']}")
        a = anim[tid]["Position"]
        check(math.hypot(ps[0]["position"][0] - a[0], ps[0]["position"][1] - a[1]) < 4.0,
              f"train {tid} at {ps[0]['position'][:2]} vs AnimTask {a[:2]}")
    if rp is not None:
        traj = trajectories(rp)
        cuts = {t["id"]: rp.igi_mission.cut_scene(t) for t in rp.tasks if t["type"] == "CutScene"}
        # heli flyby: CutScene_1200 key 6 (16 s .. end, camera fixed, target 1502)
        cam = cuts[1200]["keys"][6]["position"]
        near = min(math.sqrt(_d2(p, cam)) for (t, c, n, p) in traj[1502] if c == 1200 and n >= 480)
        check(near < 20 * 4096, f"heli flyby closest approach {near / 4096:.1f} m")
        # train drive-by: CutScene_1202 key 0..2 camera at a fixed point, target 1999
        cam = cuts[1202]["keys"][0]["position"]
        near = min(math.sqrt(_d2(p, cam)) for (t, c, n, p) in traj[1999] if c == 1202 and n < 112)
        check(near < 10 * 4096, f"train drive-by closest approach {near / 4096:.1f} m")
        # truck: leaves the garage and passes the main gate opening (Doors 400/401)
        rows = [r for r in traj[1099] if r[1] == 1204]
        cross = [p for (t, c, n, p) in rows if abs(p[0] - GATE_X) < 2 * 4096]
        check(any(GATE_Y[0] - 4096 <= p[1] <= GATE_Y[1] + 4096 for p in cross), "truck misses the gate opening")
        gate_tick = [n for (t, c, n, p) in rows if abs(p[0] - GATE_X) < 2 * 4096]
        check(gate_tick and min(gate_tick) > 400, f"truck reaches the gates at nTick {gate_tick[:1]} before they open (400)")
    return errors


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--json", action="store_true", help="print trajectories and framing as JSON")
    ap.add_argument("--no-collision", action="store_true", help="truck on terrain only (no building floors)")
    ap.add_argument("--golden", action="store_true", help="print the TS parity reference values as JSON")
    args = ap.parse_args(argv)
    if args.golden:
        print(json.dumps(golden()))
        return 0
    rp, world = full_replay(collision=not args.no_collision)
    print_report(rp, world, as_json=args.json)
    errors = self_checks(rp)
    if not args.json:
        print("self-checks:", "all passed" if not errors else "FAILED")
        for e in errors:
            print("  -", e)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
