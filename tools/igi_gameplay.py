#!/usr/bin/env python3
"""Recovered player-movement, combat and detection rules of Project I.G.I.

Run from the repository root:

    python tools/igi_gameplay.py            # print every value with evidence
    python tools/igi_gameplay.py --json     # same data as JSON

Inputs (read-only, never copied): ``Game Files/igi.exe`` and the data files
it loads (humanplayer.qvm, weapons/*, common/ai/*, material/material.qvm,
common/anims/000.iff). Nothing is executed.

Evidence labels used in the output:
  observed   value measured from a game data file (file + method named)
  recovered  meaning taken from igi.exe code (function address named); the
             instruction bytes / constants quoted are verified against the
             executable by the self-checks at the end of this script
  inferred   interpretation not proven by the code paths traced so far

Unit conventions (recovered): 4096 IGI units = 1 m; the game logic runs at a
fixed 30 ticks per second (FUN_00414f80 sets the animation clock to
4800/30 anim ticks per game tick via FUN_004c93d0(30.0); all per-frame
quantities below are per 1/30 s; the debug print "Speed Z (m/s)" in
FUN_00410a30 converts units/tick to m/s with x30/4096).
"""
import argparse
from fractions import Fraction
import hashlib
import json
import math
from pathlib import Path
import struct
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from igi_formats import FormatError, pe_sections  # noqa: E402
from igi_qvm import QVM  # noqa: E402
from level_tasks import read_tasks  # noqa: E402

GAME = Path("Game Files")
EXE_SHA256 = "2b1673443e2635d97787344da5fab9d1ac6b717d34d18c5bab7f30749b1174c2"
UNITS_PER_METRE = 4096.0
TICK_HZ = 30.0
ANIM_TICKS_PER_SECOND = 4800.0  # float at 0x532af4, used by FUN_004c93d0/FUN_004cc860

# ---------------------------------------------------------------------------
# igi.exe access
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

    def i32(self, va):
        return struct.unpack("<i", self.read(va, 4))[0]


# Instruction bytes in igi.exe that carry each recovered rule.
# (virtual address, exact bytes, function, meaning)
CODE_EVIDENCE = [
    # FPU rounding mode (docs/gameplay.md "FPU rounding mode"): chop, so every FISTP truncates.
    (0x4966d0, "9bd93ddcb86800", "FUN_004966d0", "fstcw [0x68b8dc] ..."),
    (0x4966d7, "66810ddcb86800000c", "FUN_004966d0", "... or 0xC00: rounding control = chop (truncate toward zero)"),
    (0x4966e0, "d92ddcb86800", "FUN_004966d0", "... fldcw: chop mode active"),
    (0x48dbc1, "c7442410 0000e0bf".replace(" ", ""), "WinMain loop", "every pass: fld -1.75 ..."),
    (0x48dbd5, "df7c244c", "WinMain loop", "... fistp; must give -1 (chop) else 'Invalid FPU rounding mode' (0x53fc88)"),
    (0x48dbe9, "e8e28a0000", "WinMain loop", "... then call FUN_004966d0 again"),
    (0x491f72, "6808100000", "DirectDraw set-up", "SetCooperativeLevel(DDSCL_NORMAL | DDSCL_FPUPRESERVE): D3D keeps the FPU mode"),
    (0x410180, "d80da4145300", "FUN_00410160 DefineHumanPlayerGeneral",
     "args 1-3 x 4096000 (float 0x5314a4) ..."),
    (0x410189, "d80da0145300", "FUN_00410160", "... x 1/108000 (0x5314a0): km/h -> units per 1/30 s tick"),
    (0x4101ce, "dc0d98145300", "FUN_00410160", "args 4-5 x 4096.0 (0x531498): metres -> units"),
    (0x4101f6, "dc0d88145300", "FUN_00410160", "arg 6 x 30.0 (0x531488) ..."),
    (0x4101ff, "df7c244c", "FUN_00410160", "... FISTP (chop: truncated): seconds -> whole ticks"),
    (0x410230, "bb506a5300", "FUN_00410160", "args 9-25 -> 17-entry hit-zone table at 0x536a50 (stride 16)"),
    (0x41024f, "bb606b5300", "FUN_00410160", "args 26-42 -> second 17-entry table at 0x536b60 (no reader found)"),
    (0x4105a1, "68506a5300", "FUN_00410460 HumanPlayer create", "push 0x536a50 -> FUN_00488050 (hit-zone table)"),
    (0x4105b6, "8b1574a35600", "FUN_00410460", "human+0x258 (max damage) = arg 7"),
    (0x410c20, "d90558a35600", "FUN_00410a30 player tick", "animation root delta x arg 0"),
    (0x40bc7d, "d80d5ca35600", "FUN_0040bb80 jump start", "horizontal jump speed = arg 1"),
    (0x40bca6, "d90560a35600", "FUN_0040bb80", "vertical jump speed = arg 2"),
    (0x4085b2, "d90564a35600", "FUN_00408570 airborne tick", "air-control acceleration = arg 3"),
    (0x40e0f4, "db0570a35600", "FUN_0040e0c0 peek", "lean step = distance / arg-6 ticks"),
    (0x412f59, "d90578a35600", "FUN_00412f20 electric fence", "shock damage = arg 8 x zone-13 multiplier"),
    (0x408587, "d825f0135300", "FUN_00408570", "vz -= 84.7417 units/tick^2 (gravity, 0x5313f0)"),
    (0x4086f5, "d825d0135300", "FUN_00408570", "landing speed (m/s) - 14.0 (0x5313d0)"),
    (0x408735, "d80dcc135300", "FUN_00408570", "x 1/13 (0x5313cc) x max damage = fall damage"),
    (0x4086fe, "c744242c0000a046", "FUN_00408570", "GROUNDIMPACT noise range 20480 units (5 m)"),
    (0x4087d7, "c744242c00002047", "FUN_00408570", "GROUNDIMPACT range 40960 units (10 m) after fall damage"),
    (0x412470, "d80d28155300", "FUN_004123e0 player bullet hit", "x 1.25 at difficulty index 2 (GD_3)"),
    (0x41247c, "d80d24155300", "FUN_004123e0", "x 0.75 at difficulty index 0 (GD_1)"),
    (0x4880fc, "8b3c8548f15300", "FUN_00488080 hit zone", "bone index -> zone table at 0x53f148"),
    (0x40fdda, "8b87e4060000", "player medipack state 0x40fd10", "heal = max damage x factor per round"),
    (0x44de43, "6800e00100", "FUN_0044dd00 AI symbols", "HUMANAI_DETECTIONEVENT_GUNSHOT_RANGE = 0x1e000"),
    (0x44de48, "68fcba5300", "FUN_0044dd00", "... name string 0x53bafc"),
    (0x44de52, "6800100000", "FUN_0044dd00", "HUMANAI_DETECTIONEVENT_GUNSHOT_SILENCED_RANGE = 0x1000"),
    (0x44de57, "68ccba5300", "FUN_0044dd00", "... name string 0x53bacc"),
    (0x44ca8f, "dc0d98145300", "FUN_0044ca80 AIFunction_SetViewLength", "AI+0xb0 = metres x 4096"),
    (0x44cb21, "dc0d98145300", "FUN_0044cb10 AIFunction_SetAlarmViewLength", "AI+0xb8 = metres x 4096"),
    (0x44cb81, "d80d84165300", "FUN_0044cb70 AIFunction_SetViewAlpha", "AI+0xa0 = degrees x pi/180"),
    (0x44cbe1, "d80d84165300", "FUN_0044cbd0 AIFunction_SetViewGamma", "AI+0xa8 = degrees x pi/180"),
    (0x487ede, "dc5b40", "FUN_00487d80 view cone", "|vertical angle| < alpha (viewer+0x40)"),
    (0x487ee8, "dc5348", "FUN_00487d80", "|horizontal angle| < gamma (viewer+0x48)"),
    (0x487ed0, "dc5b50", "FUN_00487d80", "distance <= view length (viewer+0x50)"),
    (0x487f91, "d81d18225300", "FUN_00487f40 line of sight", "visible if ray fraction >= 0.79"),
    (0x46449a, "c7461014ae47e1", "FUN_00464490 detection point", "standing: +2826.24 units (low dword)"),
    (0x4644b5, "c7461066666666", "FUN_00464490", "crouched: +1433.6 units (low dword)"),
    (0x4072aa, "8b8ea0020000", "FUN_00407080 AI config", "HumanAIConfigItem 'Damage scale' -> human+0x258 (max damage)"),
    (0x489f6f, "dcb7b0000000", "FUN_00489de0 AI burst start", "hit probability: distance / view length (AI+0xb0)"),
    (0x45d131, "d85e10", "FUN_0045d100 human ray filter", "player hit only if rand <= shooter hit probability"),
    (0x477566, "83bd4001000003", "FUN_004772c0 gun fire", "shots 1-4 of a burst use min spread, later max"),
    (0x477585, "d80d84165300", "FUN_004772c0", "spread degrees x pi/180"),
    (0x477d7a, "dc3d90145300", "FUN_004772c0", "cooldown = 60/rpm (fdivr 60.0) ..."),
    (0x477d86, "dc0d88145300", "FUN_004772c0", "... x 30.0 ..."),
    (0x477d8c, "df7c2434", "FUN_004772c0", "... FISTP: cooldown ticks, every step chopped (truncated)"),
    (0x477f9b, "d80d84165300", "FUN_00477ea0 gun fired", "view kick degrees x pi/180"),
    (0x461c89, "d80dbc155300", "FUN_00461a90 human fire", "view-kick offset x 0.9 per tick"),
    (0x479892, "d80db8135300", "FUN_00479870 gunshot spawn", "bullet range = Effective Range x 4096"),
    (0x47a485, "d81d9c165300", "FUN_00479e30 gunshot trace", "penetration when power == hardness: rand < 0.6"),
    (0x460524, "c744241400000045", "FUN_004600f0 movement", "ground snap / step height 2048 units (0.5 m)"),
    (0x460224, "d82d54195300", "FUN_004600f0", "slope = 90 - normal elevation (deg)"),
    (0x46034e, "d81d14195300", "FUN_004600f0", "slopes above 45 deg slide"),
    (0x414f91, "680000f041", "FUN_00414f80", "animation clock: FUN_004c93d0(30.0)"),
    (0x4626b5, "d80db8135300", "FUN_00462560 footstep", "WALK noise range = ground material range x 4096"),
]

# Constants read by the code above: (VA, type, expected, meaning).
CONSTANTS = [
    (0x5314a4, "f32", 4096000.0, "units per km"),
    (0x5314a0, "f32", 1 / 108000.0, "1 / (3600 s/h x 30 ticks/s)"),
    (0x531498, "f64", 4096.0, "units per metre"),
    (0x531488, "f64", 30.0, "ticks per second"),
    (0x531490, "f64", 60.0, "seconds per minute (rpm -> ticks)"),
    (0x5313f0, "f32", 84.74169158935547, "gravity, units per tick^2"),
    (0x5313bc, "f32", 30.0, "ticks per second (m/s conversion)"),
    (0x5313e8, "f32", 1 / 4096.0, "metres per unit"),
    (0x5313d0, "f32", 14.0, "fall-damage threshold speed (m/s)"),
    (0x5313cc, "f32", 1 / 13.0, "fall damage per m/s above threshold (fraction of max)"),
    (0x5313c8, "f32", 0.1, "fall sound: <10% of max -> player_fall_1"),
    (0x5313c4, "f32", 0.2, "fall sound: <20% -> player_fall_2, else _3"),
    (0x531524, "f32", 0.75, "player damage multiplier GD_1"),
    (0x531528, "f32", 1.25, "player damage multiplier GD_3"),
    (0x532220, "f64", 614.4, "head-shot radius around bone 4 (0.15 m)"),
    (0x531684, "f32", math.pi / 180.0, "degrees -> radians"),
    (0x531594, "f32", 2 * math.pi, "spread azimuth range"),
    (0x5314bc, "f32", 1 / 45.0, "trigger-hold ramp per tick (0..1)"),
    (0x5315bc, "f32", 0.9, "per-tick decay of view kick, knock-back and slide"),
    (0x531504, "f32", 189.62962341308594, "bullet knock-back, units per tick"),
    (0x531540, "f32", 758.5184936523438, "explosion knock-back, units per tick"),
    (0x53169c, "f32", 0.6, "penetration chance when power == hardness"),
    (0x531954, "f32", 90.0, "slope = 90 - elevation"),
    (0x531950, "f32", 80.0, "slope > 80 deg: slide 1137 units/tick"),
    (0x531948, "f32", 60.0, "slope > 60 deg: slide 948 units/tick"),
    (0x531920, "f32", 50.0, "slope > 50 deg: +56.89 units/tick^2"),
    (0x531914, "f32", 45.0, "slope > 45 deg: +18.96 units/tick^2"),
    (0x53194c, "f32", 1137.0, ""), (0x531944, "f32", 948.0, ""),
    (0x531940, "f32", 56.88888931274414, ""), (0x53193c, "f32", 18.962963104248047, ""),
    (0x532218, "f32", 0.79, "line-of-sight acceptance fraction"),
    (0x5313b8, "f32", 4096.0, "units per metre"),
    (0x531720, "f64", 0.01, "hit-probability distance floor (units)"),
    (0x532af4, "f32", 4800.0, "animation ticks per second"),
]

# Bone of skeleton 000 -> hit zone (int32[30] at 0x53f148, read by FUN_00488080).
BONE_ZONE_VA = 0x53f148
# 17 x {f32 multiplier, i32 hit animation, i32, i32} tables (stride 16).
ZONE_TABLES = {
    "player default (overridden by humanplayer.qvm args 9-25)": 0x536a50,
    "HumanSoldier (FUN_0045b600)": 0x53d180,
    "HumanSoldierPistol (FUN_00458aa0)": 0x53ca98,
    "HumanSoldierRPG (FUN_00455ac0)": 0x53c748,
    "HumanSoldierFemale (FUN_00453920)": 0x53c4b8,
}
# Player locomotion animation table at 0x5368c8 (human+0x338): {anim id, flag} x 30.
PLAYER_ANIM_TABLE_VA = 0x5368c8

ZONE_NAMES = [
    "limb A distal (hand/foot)", "limb A middle", "limb A proximal",
    "limb B distal", "limb B middle", "limb B proximal",
    "limb C distal", "limb C middle", "limb C proximal",
    "limb D distal", "limb D middle", "limb D proximal",
    "torso (side / default)", "torso front", "torso back",
    "head (front, < 0.15 m from bone 4)", "head/neck bones 4-7",
]

# ---------------------------------------------------------------------------
# Data files
# ---------------------------------------------------------------------------

HUMANPLAYER_GENERAL = [
    ("animationSpeedScale", "x", "player displacement = animation root-motion delta x this (FUN_00410a30)"),
    ("jumpHorizontalSpeedKmh", "km/h", "jump: horizontal speed along current move direction (FUN_0040bb80)"),
    ("jumpVerticalSpeedKmh", "km/h", "jump: initial upward speed (FUN_0040bb80)"),
    ("airControlKmhPerTick", "km/h per tick", "airborne: per-tick velocity change from Left/Right/Up/Down (FUN_00408570)"),
    ("leanSideMetres", "m", "Peek + Left/Right: sideways camera offset (FUN_0040e0c0)"),
    ("leanUpMetres", "m", "Peek + Up while crouched: upward camera offset (FUN_0040e0c0)"),
    ("leanTimeSeconds", "s", "time to reach a lean offset; stored as whole ticks (FUN_0040e0c0)"),
    ("maxDamage", "damage units", "player health capacity; dead when accumulated damage >= this"),
    ("fenceShockDamage", "damage units", "electric fence shock, x zone-13 multiplier, 45-tick cooldown (FUN_00412f20)"),
]


def u8_file(path):
    p = GAME / path
    if not p.exists():
        raise SystemExit(f"missing {p} (run from the repository root)")
    return p.read_bytes()


def decode_humanplayer(data):
    calls = {c["fn"]: c["args"] for c in QVM(data).call_tree()}
    args = calls["DefineHumanPlayerGeneral"]
    if len(args) != 43:
        raise FormatError(f"DefineHumanPlayerGeneral has {len(args)} arguments, expected 43")
    general = {name: args[i] for i, (name, _, _) in enumerate(HUMANPLAYER_GENERAL)}
    zones = args[9:26]
    zones2 = args[26:43]
    categories = []
    cat = calls["DefineHumanPlayerWeaponCategory"]
    i = 0
    while i < len(cat):
        n = int(cat[i])
        categories.append([a["symbol"] for a in cat[i + 1:i + 1 + n]])
        i += 1 + n
    ammo = calls["DefineHumanPlayerAmmoLimit"]
    limits = {ammo[i]["symbol"]: ammo[i + 1] for i in range(0, len(ammo), 2)}
    cycle = [a["symbol"] for a in calls["DefineHumanPlayerWeaponCycle"]]
    return general, zones, zones2, categories, limits, cycle


def ticks_round(x):
    """x87 FISTP as igi.exe runs it: chop mode (FUN_004966d0, re-applied and
    checked every frame at 0x48dbc1), so it truncates toward zero."""
    return int(x)  # Python int() truncates toward zero


def chop(exact):
    """An x87 double op in chop mode (53-bit precision): the double nearest the
    exact value (a Fraction) toward zero."""
    d = float(exact)
    if d != 0 and abs(Fraction(d)) > abs(exact):
        d = math.nextafter(d, 0.0)
    return d


def cooldown_ticks(rpm):
    """FUN_004772c0 0x477d6d..0x477d8c: fild rpm; fdivr 60.0; fmul 30.0; fistp,
    each step chopped: 60/50 = 1.2 is inexact, so 50 rpm gives 35 ticks, not 36."""
    return ticks_round(chop(Fraction(chop(Fraction(60) / rpm)) * 30))


def literal_calls(data, names):
    """Single-literal call sites in an executable AI script (same acceptance
    rule as web-port/src/loaders/qvm.ts readQvmLiteralCalls)."""
    q = QVM(data)
    out = {}
    code = q.code
    for name in names:
        idx = next((i for i, s in enumerate(q.symbols) if s["name"] == name), None)
        values = []
        if idx is not None and idx < 256:
            at = code.find(b"\x0d" + bytes([idx]))
            while at >= 0:
                try:
                    call = q.instruction(at + 2)
                    if call["mnemonic"] == "CALL" and len(call["argument_code_offsets"]) == 1:
                        bra_at = at + 2 + call["size"]
                        bra = q.instruction(bra_at)
                        arg = call["argument_code_offsets"][0]
                        if bra["mnemonic"] == "BRA" and arg == bra_at + bra["size"]:
                            lit = q.instruction(arg)
                            brk = arg + lit["size"]
                            if (lit.get("kind") == "number" and q.instruction(brk)["mnemonic"] == "BRK"
                                    and brk + 1 == bra["target_code_offset"]
                                    and q.instruction(bra["target_code_offset"])["mnemonic"] in ("POP", "BRK")):
                                values.append(lit["value"])
                except FormatError:
                    pass
                at = code.find(b"\x0d" + bytes([idx]), at + 1)
        out[name] = values
    return out


def read_iff_anims(data):
    """common/anims/*.iff: big-endian IFF FORMs. Per animation (FORM BOAN):
    BOAH = f32 duration (anim ticks, 4800/s), u32 flags (bit 31 = loops,
    inferred), u32 animation id; BOTH = u32 root key count; BOTD = keys of
    10 f32: x, y, z, time, in-tangent xyz, out-tangent xyz (layout inferred:
    times are multiples of 160 = one 30 Hz frame, tangents equal the
    per-anim-tick slope of x/y/z)."""
    anims = {}
    cur = None
    # Linear scan entering every FORM: in 000.iff the outer FORM BOBJ
    # (size 588) contains FORM BOAL running to the end of the file, so FORM
    # sizes do not nest.
    off = 0
    while off + 8 <= len(data):
        tag = data[off:off + 4]
        size = struct.unpack(">I", data[off + 4:off + 8])[0]
        body = data[off + 8:off + 8 + size]
        if tag == b"FORM":
            if data[off + 8:off + 12] == b"BOAN":
                cur = None
            off += 12
            continue
        if off + 8 + size > len(data):
            raise FormatError(f"IFF chunk {tag!r} at {off} overruns the file")
        if tag == b"BOAH":
            dur, flags, aid = struct.unpack("<fII", body[:12])
            cur = {"duration": dur, "loops": bool(flags >> 31), "id": aid}
            anims.setdefault(aid, cur)
        elif tag == b"BOTD" and cur is not None:
            if size % 40:
                raise FormatError(f"BOTD at {off} is not a whole number of 40-byte keys")
            cur["keys"] = [struct.unpack_from("<10f", body, i) for i in range(0, size, 40)]
        off += 8 + size + (size & 1)
    return anims


def root_speed(anim):
    """Mean horizontal root speed (m/s) over [0, duration], keys linearly
    interpolated (the engine's own sampler, FUN_004c96c0, was not traced)."""
    keys = anim.get("keys") or []
    if len(keys) < 2 or anim["duration"] <= 0:
        return 0.0, (0.0, 0.0)

    def at(t):
        for a, b in zip(keys, keys[1:]):
            if a[3] <= t <= b[3]:
                f = (t - a[3]) / (b[3] - a[3]) if b[3] > a[3] else 0.0
                return [a[i] + (b[i] - a[i]) * f for i in range(3)]
        return list(keys[-1][:3])

    p0, p1 = at(0.0), at(anim["duration"])
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    v = math.hypot(dx, dy) / anim["duration"] * ANIM_TICKS_PER_SECOND / UNITS_PER_METRE
    return v, (dx, dy)


LOCOMOTION_SLOTS = [
    "stand", "run fwd", "run fwd-right", "run fwd-left", "run back", "run back-right",
    "run back-left", "run right", "run left", "walk fwd", "walk fwd-right", "walk fwd-left",
    "walk back", "walk back-right", "walk back-left", "walk right", "walk left",
    "crouch down", "stand up", "crouch idle", "crouch fwd", "crouch fwd-right",
    "crouch fwd-left", "crouch back", "crouch back-right", "crouch back-left",
    "crouch right", "crouch left", "crouch (25)", "stand (2)",
]

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


def build(args):
    exe_bytes = u8_file("igi.exe")
    digest = hashlib.sha256(exe_bytes).hexdigest()
    exe = Exe(exe_bytes)
    report = {"igi.exe sha256": digest}
    checks = []

    def check(ok, what):
        checks.append((bool(ok), what))

    check(digest == EXE_SHA256, "igi.exe is the analysed build (E005 digest)")
    for va, hexbytes, fn, meaning in CODE_EVIDENCE:
        got = exe.read(va, len(hexbytes) // 2).hex()
        check(got == hexbytes, f"code {va:#x} {fn}: {meaning} [{hexbytes}]")
    consts = {}
    for va, kind, expected, meaning in CONSTANTS:
        got = exe.f32(va) if kind == "f32" else exe.f64(va)
        consts[va] = got
        check(math.isclose(got, expected, rel_tol=1e-6, abs_tol=1e-9),
              f"constant {va:#x} = {got!r} ({meaning})")

    # --- movement -----------------------------------------------------------
    general, zones, zones2, categories, limits, cycle = decode_humanplayer(
        u8_file("humanplayer/humanplayer.qvm"))
    kmh_tick = consts[0x5314a4] * consts[0x5314a0]  # units per tick per km/h
    check(math.isclose(kmh_tick, 4096000 / 3600 / 30, rel_tol=1e-6),
          "km/h factor = 4096 units x 1000 m / 3600 s / 30 ticks")
    jump_v_units = general["jumpVerticalSpeedKmh"] * kmh_tick
    check(math.isclose(jump_v_units, 1024.0, rel_tol=1e-5),
          "jump speed 27 km/h is exactly 1024 units/tick (0.25 m per tick): km/h reading confirmed")
    lean_ticks = ticks_round(general["leanTimeSeconds"] * 30.0)
    g = consts[0x5313f0]
    g_ms2 = g * TICK_HZ * TICK_HZ / UNITS_PER_METRE
    v_up = jump_v_units * TICK_HZ / UNITS_PER_METRE
    movement = {
        "humanplayer.qvm DefineHumanPlayerGeneral (observed values, recovered meaning)": {
            name: {"value": general[name], "unit": unit, "meaning": meaning}
            for name, unit, meaning in HUMANPLAYER_GENERAL},
        "derived": {
            "jumpHorizontalSpeed_mps": general["jumpHorizontalSpeedKmh"] / 3.6,
            "jumpVerticalSpeed_mps": general["jumpVerticalSpeedKmh"] / 3.6,
            "airControlAccel_mps2": general["airControlKmhPerTick"] / 3.6 * TICK_HZ,
            "leanTicks": lean_ticks,
            "leanSeconds_effective": lean_ticks / TICK_HZ,
            "gravity_units_per_tick2": g,
            "gravity_mps2": g_ms2,
            "jumpApex_m_continuous": v_up * v_up / (2 * g_ms2),
            "jumpAirTime_s_continuous": 2 * v_up / g_ms2,
            "stepHeight_m": 2048 / UNITS_PER_METRE,
            "walkableSlope_deg": 45.0,
        },
    }
    check(lean_ticks == 7, "lean 0.25 s -> FISTP(7.5) = 7 ticks (chop mode)")
    check(ticks_round(-1.75) == -1, "chop-mode FISTP(-1.75) = -1, the value WinMain checks at 0x48dbc1")

    # Locomotion speeds from the player's animation table and 000.iff root tracks.
    table = [(exe.i32(PLAYER_ANIM_TABLE_VA + 8 * i), exe.i32(PLAYER_ANIM_TABLE_VA + 8 * i + 4))
             for i in range(len(LOCOMOTION_SLOTS))]
    speeds = {}
    try:
        anims = read_iff_anims(u8_file("common/anims/000.iff"))
        for slot, (aid, _) in zip(LOCOMOTION_SLOTS, table):
            a = anims.get(aid)
            if not a:
                continue
            v, (dx, dy) = root_speed(a)
            speeds[slot] = {"anim": aid, "root_mps": round(v, 3),
                            "player_mps": round(v * general["animationSpeedScale"], 3),
                            "dir": [round(dx), round(dy)], "loop_s": round(a["duration"] / 4800, 3)}
        check(speeds["run fwd"]["dir"][0] == 0 and speeds["run fwd"]["dir"][1] > 0,
              "anim 4 (table slot 1) moves along local +Y (forward)")
        check(speeds["run left"]["dir"][0] < 0 and speeds["run right"]["dir"][0] > 0,
              "anims 10/11 move along -X/+X (left/right strafe)")
    except SystemExit:
        speeds = {"note": "common/anims/000.iff not found"}
    movement["locomotion (anim ids: table 0x5368c8, recovered; root speeds: observed in 000.iff; slot names and key interpolation: inferred)"] = speeds
    report["movement"] = movement

    # --- health / damage ------------------------------------------------------
    bone_zone = [exe.i32(BONE_ZONE_VA + 4 * i) for i in range(30)]
    tables = {}
    for name, va in ZONE_TABLES.items():
        tables[name] = [round(exe.f32(va + 16 * i), 4) for i in range(17)]
    player_default = tables["player default (overridden by humanplayer.qvm args 9-25)"]
    check([round(z, 4) for z in zones[:15]] == player_default[:15],
          "humanplayer.qvm zone multipliers 0-14 equal the exe defaults")
    check(player_default[15:] == [100.0, 100.0] and zones[15:] == [1, 1],
          "player head zones overridden 100 -> 1 (no one-shot head kills on the player)")
    check(bone_zone[4:8] == [16] * 4 and bone_zone[:4] == [12] * 4, "bones 0-3 torso, 4-7 head")
    report["damage"] = {
        "player zone multipliers (humanplayer.qvm args 9-25)": dict(zip(ZONE_NAMES, zones)),
        "second 17-value block (args 26-42; written to 0x536b60, no reader found)": zones2,
        "soldier zone multipliers (igi.exe tables)": tables,
        "bone -> zone (0x53f148)": bone_zone,
        "player max damage": general["maxDamage"],
        "player difficulty multiplier": {"GD_1": consts[0x531524], "GD_2": 1.0, "GD_3": consts[0x531528]},
        "fall damage": "max(0, v_land_mps - 14) / 13 x maxDamage",
        "fall damage lethal landing speed (m/s)": 14 + 13,
        "fall height for first damage (m, continuous)": 14 ** 2 / (2 * g_ms2),
        "fall height lethal from full health (m, continuous)": 27 ** 2 / (2 * g_ms2),
        "ammo limits": limits,
        "weapon categories (keys 1-9)": categories,
        "weapon cycle": cycle,
    }

    # --- weapons --------------------------------------------------------------
    wtasks = [t for t in read_tasks(u8_file("weapons/weaponconfig.qvm")) if t["type"] == "WeaponConfig"]
    weapons = {}
    for t in wtasks:
        p = t["params"]
        sym = (lambda v: v["symbol"] if isinstance(v, dict) else v)
        rpm = p["Rounds/Minute"]
        cool = cooldown_ticks(rpm) if rpm > 0 else None
        tags = {c["params"]["Name"]: c["params"]["Value"] for c in t["children"]}
        detection = sym(p["AI Detection Event Range"])
        weapons[p["Script ID"]] = {
            "damage": p["Damage Factor"], "pellets": p["Bullets/Round"],
            "cooldownTicks": cool, "effectiveRpm": round(1800 / cool, 1) if cool else None,
            "clip": p["Rounds/Clip"], "burst": p["Maximum Rounds/Burst"],
            "spreadDeg(first 4 shots / later)": [p["Minimum random spread"], p["Maximum random spread"]],
            "kickPitchDeg": [p["Fixed view change around X axis (degrees)"],
                             p["Random view change around X axis (degrees)"]],
            "kickYawDeg": [p["Fixed view change around Z axis (degrees)"],
                           p["Random view change around Z axis (degrees)"]],
            "rangeM": p["Effective Range of Weapon"], "penetration": p["Penetration Power"],
            "noiseRangeM": {"HUMANAI_DETECTIONEVENT_GUNSHOT_RANGE": 30.0,
                            "HUMANAI_DETECTIONEVENT_GUNSHOT_SILENCED_RANGE": 1.0}.get(detection),
            "tags": tags,
        }
    check(weapons["WEAPON_ID_MP5SD"]["cooldownTicks"] == 2, "MP5SD 700 rpm -> trunc(2.571) = 2 ticks (900 rpm effective)")
    check(weapons["WEAPON_ID_GLOCK"]["cooldownTicks"] == 4, "Glock 400 rpm -> FISTP(4.5) = 4 ticks")
    check(weapons["WEAPON_ID_M16A2"]["cooldownTicks"] == 3, "M16A2 500 rpm -> trunc(3.6) = 3 ticks")
    check(weapons["WEAPON_ID_DRAGUNOV"]["cooldownTicks"] == 35,
          "Dragunov 50 rpm -> chop(chop(60/50) x 30) = 35.999.. -> 35 ticks")
    check(weapons["WEAPON_ID_COLT"]["cooldownTicks"] == 30, "Colt 60 rpm -> 60/60 x 30 = 30 exactly")
    report["weapons (weaponconfig.qvm overrides weapons/*/weapon.qvm: FUN_00407cf0)"] = weapons

    # --- AI combat / detection --------------------------------------------------
    gunshot = 0x1e000 / UNITS_PER_METRE
    silenced = 0x1000 / UNITS_PER_METRE
    check(gunshot == 30.0 and silenced == 1.0, "gunshot ranges are whole metres in units (30 m / 1 m)")
    ai = {}
    for t in read_tasks(u8_file("common/ai/settings.qvm")):
        if t["type"] != "HumanAIConfigItem":
            continue
        p = t["params"]
        sym = (lambda v: v["symbol"] if isinstance(v, dict) else v)
        if sym(p["Difficulty"]) != "GD_2":
            continue
        ai[sym(p["AI Type"])] = {
            "health(maxDamage)": p["Damage scale"], "flinchThreshold": p["Recoil threshold"],
            "hitProb@0m": p["Combat firing hit probability at minimum range"],
            "hitProb@viewLength": p["Combat firing hit probability at maximum range"],
            "aimPrecision": p["Combat firing Aim precision"],
        }
    views = {}
    for script in ("guard", "patrol", "sniper"):
        lc = literal_calls(u8_file(f"common/ai/{script}.qvm"),
                           ["AIFunction_SetViewLength", "AIFunction_SetAlarmViewLength",
                            "AIFunction_SetViewAlpha", "AIFunction_SetViewGamma"])
        views[script] = {
            "viewLength_m": lc["AIFunction_SetViewLength"],
            "alarmViewLength_m": lc["AIFunction_SetAlarmViewLength"],
            "verticalHalfAngle_deg (alpha)": lc["AIFunction_SetViewAlpha"],
            "horizontalHalfAngle_deg (gamma)": lc["AIFunction_SetViewGamma"],
        }
    check(views["guard"]["viewLength_m"] == [40], "guard.qvm SetViewLength(40) (E030)")
    report["ai"] = {
        "GD_2 combat settings": ai,
        "views": views,
        "noise events (range m, listener filter)": {
            "WALK (footstep, standing only)": "ground material footstep range (material.qvm arg 5)",
            "GROUNDIMPACT (landing)": "5; 10 if the landing caused fall damage",
            "DOOR": 5, "FENCE": 5, "LADDER": 5,
            "GUNSHOT": f"{gunshot} normal / {silenced} silenced",
            "GUNSHOTMISS (bullet impact near)": 2, "GRENADELAND": 5, "FLASHBANG": 10, "ALERT (teammates)": 7,
        },
        "vision": "dist<=length && |vertical|<alpha && |horizontal|<gamma, then LOS to origin+0.69 m (0.35 m crouched)",
    }
    try:
        mats = {}
        for c in QVM(u8_file("material/material.qvm")).call_tree():
            if c["fn"] == "DefineGameMaterial":
                a = c["args"]
                mats[a[0]] = {"hardness": a[1], "ricochetDeg": a[2], "footstepNoiseM": a[5]}
        report["materials (material.qvm DefineGameMaterial; FUN_00408060 layout)"] = mats
        check(mats["Gravel"]["footstepNoiseM"] == 10.0, "gravel footsteps carry 10 m")
    except SystemExit:
        pass
    return report, checks


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    report, checks = build(args)
    if args.json:
        print(json.dumps({"report": report, "checks": [[ok, w] for ok, w in checks]}, indent=1, default=str))
    else:
        def show(obj, indent=0):
            pad = "  " * indent
            if isinstance(obj, dict):
                for k, v in obj.items():
                    if isinstance(v, (dict, list)) and v and not all(
                            isinstance(x, (int, float, str)) for x in (v if isinstance(v, list) else [])):
                        print(f"{pad}{k}:")
                        show(v, indent + 1)
                    elif isinstance(v, dict):
                        print(f"{pad}{k}:")
                        show(v, indent + 1)
                    else:
                        print(f"{pad}{k}: {v}")
            elif isinstance(obj, list):
                for v in obj:
                    print(f"{pad}- {v}")
            else:
                print(f"{pad}{obj}")
        show(report)
        print("\nself-checks:")
        for ok, what in checks:
            print(f"  [{'ok' if ok else 'FAIL'}] {what}")
    failed = [w for ok, w in checks if not ok]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} self-checks passed", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
