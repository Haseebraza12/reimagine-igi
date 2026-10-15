"""Soldier AI behaviour of igi.exe: graph format, route table, patrol paths,
combat configuration and the recovered constants, with self-checks.

Stdlib only. Run from the repository root:

    python tools/igi_ai.py                 # everything, level 1
    python tools/igi_ai.py --root "Game Files" --level missions/location0/level1

Evidence labels used in the output and in docs/ai.md:
  [recovered]  read from igi.exe code (function addresses cited)
  [observed]   measured on the shipped files by this script
  [inferred]   reasoning only

What it checks
--------------
1. graphs/graph*.dat is the engine's generic "GraphStream" (FUN_004f09c0 /
   FUN_004f08a0 / FUN_004f0a80): every field is
       u8 4, u32 tag, u8 0, u8 field-type, u8 value-type, payload
   where tag = FUN_004f0a40(field name) (upper-cased, weights 1, 1+0x13d, ...
   mod 2^16). The script recomputes the tag of every field name the exe
   registers and requires that every record of every file matches one.
2. The RouteTable blob (AIGraph field registered by FUN_004ffe00, read by
   FUN_005001f0) is cap*cap entries of {i32 next node, f32 cost}; the entry
   for (from, to) is at index cap*to + from. Checks: next == to for every
   link, next is always a neighbour of from, following next reaches to,
   and costs against Dijkstra on Euclidean link lengths.
3. PatrolPath / PatrolPathCommand cursor semantics (FUN_004525f0,
   FUN_00452540, FUN_00452570, FUN_00452690) are simulated on every level
   path and the first commands executed are printed.
4. HumanAIConfigItem fields -> HumanAI fields (FUN_00407080) at the
   configured difficulty, with the fields igi.exe never reads.
5. When Game Files/igi.exe is present, the recovered numeric constants are
   re-read from the exe image (data and code immediates) and compared.
"""
from __future__ import annotations

import argparse
import heapq
import math
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

WORLD_METER = 4096.0          # [recovered] WORLD_METER, FUN_004148b0
GAME_FREQUENCY = 30           # [recovered] GAME_FREQUENCY, FUN_004148b0

# ---------------------------------------------------------------------------
# GraphStream
# ---------------------------------------------------------------------------
GRAPH_MAGIC = 0xFFEEDDCC

# value-type codes of the stream (FUN_004f0a80 writer / FUN_004f08a0 reader)
VALUE_WIDTH = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 8, 8: 24}
# 9 = string (u8 length + bytes), 10 = blob (value-type 5 length + bytes)

# field name -> declared field type, as registered by FUN_004f1630 (nodes,
# links) and FUN_004ffe00 (RouteTable)
GRAPH_FIELDS = {
    "nMaxNodes": 5, "RouteTable": 10, "nNodeID": 5, "tNodePosition": 8,
    "vNodeGamma": 6, "vNodeRadius": 6, "nNodeMaterial": 5, "nNodeCriteria": 9,
    "nLinkID1": 5, "nLinkID2": 5, "eLinkType": 5,
}


class GraphError(ValueError):
    pass


def stream_hash(name: str) -> int:
    """FUN_004f0a40: sum(upper(c) * w), w = 1, 1+0x13d, ... (mod 0x10000)."""
    acc, weight = 0, 1
    for ch in name.encode("ascii"):
        c = ch - 0x20 if 0x60 < ch < 0x7B else ch
        acc = (acc + c * weight) & 0xFFFFFFFF
        weight = (weight + 0x13D) & 0xFFFF
    return acc


TAG_TO_FIELD = {stream_hash(n): n for n in GRAPH_FIELDS}


def read_stream(data: bytes, pos: int):
    """Yield (field name, value, offset) records until EOF."""
    while pos < len(data):
        start = pos
        if pos + 8 > len(data):
            raise GraphError(f"truncated record header at 0x{pos:x}")
        if data[pos] != 4:
            raise GraphError(f"record at 0x{pos:x}: tag type {data[pos]} != 4")
        tag = struct.unpack_from("<I", data, pos + 1)[0]
        name = TAG_TO_FIELD.get(tag)
        if name is None:
            raise GraphError(f"record at 0x{pos:x}: unknown tag 0x{tag:x}")
        if data[pos + 5] != 0:
            raise GraphError(f"record at 0x{pos:x}: field-type byte prefix {data[pos + 5]} != 0")
        field_type = data[pos + 6]
        if field_type != GRAPH_FIELDS[name]:
            raise GraphError(f"record at 0x{pos:x}: {name} field type {field_type}, expected {GRAPH_FIELDS[name]}")
        vtype = data[pos + 7]
        pos += 8
        if field_type == 10:
            # blob: the field-type byte pair is repeated, then a type-5 length
            if vtype != 0 or data[pos] != 10 or data[pos + 1] != 5:
                raise GraphError(f"blob {name} at 0x{start:x}: bad blob header")
            length = struct.unpack_from("<I", data, pos + 2)[0]
            pos += 6
            value = data[pos:pos + length]
            if len(value) != length:
                raise GraphError(f"blob {name} at 0x{start:x} runs past EOF")
            pos += length
        elif field_type == 9:
            if vtype != 9:
                raise GraphError(f"string {name} at 0x{start:x}: value type {vtype}")
            n = data[pos]
            raw = data[pos + 1:pos + 1 + n]
            pos += 1 + n
            value = raw.split(b"\0", 1)[0].decode("ascii", "replace")
        else:
            if vtype != field_type:
                raise GraphError(f"{name} at 0x{start:x}: value type {vtype} != field type {field_type}")
            width = VALUE_WIDTH[vtype]
            raw = data[pos:pos + width]
            if len(raw) != width:
                raise GraphError(f"{name} at 0x{start:x} runs past EOF")
            pos += width
            value = {5: lambda b: struct.unpack("<i", b)[0], 6: lambda b: struct.unpack("<f", b)[0],
                     8: lambda b: struct.unpack("<3d", b)}[vtype](raw)
        yield name, value, start


def read_graph(data: bytes, name: str = "graph"):
    if len(data) < 4 or struct.unpack_from("<I", data, 0)[0] != GRAPH_MAGIC:
        raise GraphError(f"{name}: bad magic")
    cap = None
    route = None
    nodes, links = [], []
    node, link = None, None
    for field, value, off in read_stream(data, 4):
        if field == "nMaxNodes":
            cap = value
        elif field == "RouteTable":
            if cap is None or len(value) != cap * cap * 8:
                raise GraphError(f"{name}: RouteTable size {len(value)} != 8*{cap}^2")
            route = value
        elif field == "nNodeID":
            node = {"id": value}
        elif field in ("tNodePosition", "vNodeGamma", "vNodeRadius", "nNodeMaterial"):
            if node is None:
                raise GraphError(f"{name}: {field} at 0x{off:x} outside a node")
            node[{"tNodePosition": "position", "vNodeGamma": "gamma", "vNodeRadius": "radius",
                  "nNodeMaterial": "material"}[field]] = value
        elif field == "nNodeCriteria":
            if node is None or len(node) != 5:
                raise GraphError(f"{name}: incomplete node before 0x{off:x}")
            node["criteria"] = value
            nodes.append(node)
            node = None
        elif field == "nLinkID1":
            link = {"a": value}
        elif field == "nLinkID2":
            link["b"] = value
        elif field == "eLinkType":
            link["type"] = value
            links.append(link)
            link = None
    if cap is None or route is None:
        raise GraphError(f"{name}: missing nMaxNodes or RouteTable")
    ids = [n["id"] for n in nodes]
    if len(set(ids)) != len(ids) or any(not 0 <= i < cap for i in ids):
        raise GraphError(f"{name}: node ids not unique / out of [0, {cap})")
    return {"cap": cap, "nodes": {n["id"]: n for n in nodes}, "links": links, "route": route}


def route_entry(graph, src, dst):
    """FUN_005001f0: entry (from, to) at index cap*to + from -> (next, cost)."""
    cap = graph["cap"]
    return struct.unpack_from("<if", graph["route"], (cap * dst + src) * 8)


def route_path(graph, src, dst):
    """Follow next hops like FUN_004506b0 does; None when unroutable."""
    path, cur = [src], src
    for _ in range(graph["cap"] + 1):
        if cur == dst:
            return path
        nxt, _cost = route_entry(graph, cur, dst)
        if nxt < 0 or nxt not in graph["nodes"]:
            return None
        path.append(nxt)
        cur = nxt
    return None


def check_graph(graph):
    nodes, links = graph["nodes"], graph["links"]
    adj = {i: {} for i in nodes}
    for l in links:
        w = math.dist(nodes[l["a"]]["position"], nodes[l["b"]]["position"])
        adj[l["a"]][l["b"]] = w
        adj[l["b"]][l["a"]] = w
    direct_ok = sum(1 for l in links for s, t in ((l["a"], l["b"]), (l["b"], l["a"]))
                    if route_entry(graph, s, t)[0] == t)
    not_neighbour = unreachable = mismatched = pairs = 0
    max_dev = 0.0
    for s in nodes:
        dist = {s: 0.0}
        pq = [(0.0, s)]
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist[u]:
                continue
            for v, w in adj[u].items():
                if d + w < dist.get(v, math.inf):
                    dist[v] = d + w
                    heapq.heappush(pq, (d + w, v))
        for t in nodes:
            if t == s:
                continue
            nxt, cost = route_entry(graph, s, t)
            if t not in dist:
                if nxt != -1:
                    mismatched += 1
                continue
            pairs += 1
            if nxt not in adj[s]:
                not_neighbour += 1
                continue
            if route_path(graph, s, t) is None:
                unreachable += 1
            dev = abs(cost - dist[t])
            max_dev = max(max_dev, dev)
            if dev > 1.0:
                mismatched += 1
    return {"links": len(links), "direct_next_ok": direct_ok, "pairs": pairs,
            "next_not_neighbour": not_neighbour, "path_fail": unreachable,
            "cost_mismatch_gt_1unit": mismatched, "max_cost_dev_units": max_dev}


# ---------------------------------------------------------------------------
# Patrol paths
# ---------------------------------------------------------------------------
PATROL_COMMANDS = {-1: "NONE", 0: "ANIMATION", 1: "DELAY", 2: "WALKTO", 3: "RUNTO",
                   4: "CROUCH", 5: "LOOKATNODE", 6: "END", 7: "QUIT", 8: "SETSPEED"}


class PatrolCursor:
    """FUN_004525f0 (init), FUN_00452540 (next), FUN_00452570 (advance)."""

    def __init__(self, commands, start=0):
        self.cmds = commands          # list of (command, parameter)
        self.loop = None              # path+8: the END command reached
        self.last_move = None         # path+0xc: last WALKTO/RUNTO
        i = 0
        while i < len(commands) and i < start:     # FUN_00452690
            c = commands[i][0]
            if 1 < c < 4:
                self.last_move = i
            elif c == 6:
                self.loop = i
            i += 1
        self.cur = i if i < len(commands) else None
        if self.cur is not None and commands[self.cur][0] == 6:
            self.cur = self._next()

    def _next(self):
        """FUN_00452540: the following command; past the end -> the
        remembered END, else the first command."""
        if self.cur is not None and self.cur + 1 < len(self.cmds):
            return self.cur + 1
        if self.loop is not None:
            return self.loop
        return 0 if self.cmds else None

    def advance(self):
        """FUN_00452570: returns False when the cursor did not move."""
        nxt = self._next()
        if nxt is None:
            return False
        c = self.cmds[nxt][0]
        if c == 6:
            if nxt == self.loop:
                return False
            self.cur = self.loop = nxt
            nxt = self._next()
            if nxt == self.cur or nxt is None:
                return False
            c = self.cmds[nxt][0]
            if c == 6:
                raise GraphError("END command following END command")  # exe: fatal
        if 1 < c < 4:
            self.last_move = nxt
        self.cur = nxt
        return True


def simulate_patrol(commands, steps=12):
    """Commands the Patrol action executes (QUIT ends the action)."""
    cur = PatrolCursor(commands)
    out = []
    for _ in range(steps):
        if cur.cur is None:
            break
        cmd, par = cur.cmds[cur.cur]
        out.append(f"{PATROL_COMMANDS.get(cmd, cmd)}({par})")
        if cmd == 7:
            out.append("<action ends; IDLE re-issues Patrol>")
            break
        if not cur.advance():
            out.append(f"<repeats {PATROL_COMMANDS.get(cmd, cmd)}({par}) forever>")
            break
    return out


# ---------------------------------------------------------------------------
# HumanAIConfigItem -> HumanAI (FUN_00407080)
# ---------------------------------------------------------------------------
# (config field, HumanAI offset, conversion, read by)  read by = None -> the
# field is copied but never read anywhere in .text (reference count on the
# objdump listing).
CONFIG_MAP = [
    ("Damage scale", "soldier+0x258", "copy", "human damage code"),
    ("Recoil threshold", "soldier+0xd04 (HumanSoldier only)", "copy", "human code"),
    ("Combat initial movement delay (in seconds)", "H+0x3d3c", "ticks", None),
    ("Combat movement delay (in seconds)", "H+0x3d40", "ticks", None),
    ("Combat targeting timeout (in seconds)", "H+0x3d48", "ticks", "FUN_0048a3f0/004892b0/0048b4a0/0048aff0"),
    ("Combat tracking distance (in meters)", "H+0x3db8", "units", "FUN_0048a3f0, FUN_004892b0"),
    ("Combat liedown mim distance (in meters)", "H+0x3db0", "units", "FUN_0048a250, AIAction_FallFlat"),
    ("Combat evasive action probability", "H+0x3d4c", "copy", "FUN_0048a250"),
    ("Combat evasive stand roll / liedown probability", "H+0x3d50", "copy", "FUN_0048a250 (stand and kneel)"),
    ("Combat evasive kneel roll / liedown probability", "H+0x3d54", "copy", None),
    ("Combat evasive stand roll side probability", "H+0x3d58", "copy", "FUN_0048a250 (stand and kneel)"),
    ("Combat evasive kneel roll side probability", "H+0x3d5c", "copy", None),
    ("Combat firing hit probability at minimum range", "H+0x3d60", "copy", "FUN_00489de0"),
    ("Combat firing hit probability at maximum range", "H+0x3d64", "copy", "FUN_00489de0"),
    ("Combat Firing Max Number Of Rounds per sequence", "H+0x3d44", "copy", "FUN_00489de0"),
    ("Combat firing Aim precision", "H+0x3dc0", "copy", "FUN_0048bd00"),
    ("Combat firing minimum clip percentage", "H+0x3d68", "copy", "FUN_00489de0"),
    ("Combat firing random clip percentage", "H+0x3d6c", "copy", "FUN_00489de0"),
    ("Combat firing minimum delay (in seconds)", "H+0x3d70", "copy", None),
    ("Combat firing random delay (in seconds)", "H+0x3d74", "copy", None),
    ("Combat firing minimum shot delay (in seconds)", "H+0x3d78", "copy", "FUN_0048bd00"),
    ("Combat firing random shot delay (in seconds)", "H+0x3d7c", "copy", "FUN_0048bd00"),
    ("Combat grenade throw probability", "H+0x3d80", "copy", "FUN_0048a3f0 (clip empty)"),
    ("Combat grenade throw when reload probability", "H+0x3d84", "copy", "FUN_0048a3f0 (clip not empty)"),
    ("Combat grenade minimum distance (in meters)", "H+0x3d88", "units(f32)", "FUN_0048a3f0"),
    ("Combat grenade maximum distance (in meters)", "H+0x3d8c", "units(f32)", "FUN_0048a3f0"),
    ("Combat grenade minimum fly time (in seconds)", "H+0x3d90", "copy", "soldier grenade code 0x45a2xx"),
    ("Combat grenade random fly time (in seconds)", "H+0x3d94", "copy", "soldier grenade code 0x45a2xx"),
    ("Combat grenade minimum explode time (in seconds)", "H+0x3d98", "copy", "soldier grenade code 0x45a2xx"),
    ("Combat grenade random explode time (in seconds)", "H+0x3d9c", "copy", "soldier grenade code 0x45a2xx"),
    ("Close Combat hit probability", "H+0x3da0", "copy", "soldier close-combat code"),
    ("Close Combat damage", "H+0x3da4", "copy", "soldier close-combat code"),
]


def x87_round(x: float) -> int:
    """fistp as igi.exe runs it: the FPU is in chop mode (FUN_004966d0, checked
    every frame at 0x48dbc1; docs/gameplay.md "FPU rounding mode"), so it
    truncates toward zero (7.5 -> 7, -1.75 -> -1). Name kept for callers."""
    return int(x)  # Python int() truncates toward zero


def convert(value, how):
    if how == "ticks":
        return x87_round(value * GAME_FREQUENCY)
    if how.startswith("units"):
        return value * WORLD_METER
    return value


# ---------------------------------------------------------------------------
# igi.exe constant checks (data and code immediates)
# ---------------------------------------------------------------------------
class Exe:
    def __init__(self, data: bytes):
        self.data = data
        pe = struct.unpack_from("<I", data, 0x3C)[0]
        nsec = struct.unpack_from("<H", data, pe + 6)[0]
        opt = struct.unpack_from("<H", data, pe + 20)[0]
        self.secs = []
        for i in range(nsec):
            o = pe + 24 + opt + i * 40
            vsz, va, rsz, raw = struct.unpack_from("<IIII", data, o + 8)
            self.secs.append((va + 0x400000, rsz, raw))

    def read(self, va: int, n: int) -> bytes:
        for sva, rsz, raw in self.secs:
            if sva <= va and va + n <= sva + rsz:
                return self.data[raw + va - sva: raw + va - sva + n]
        raise GraphError(f"VA 0x{va:x} not in a raw section")

    def u32(self, va): return struct.unpack("<I", self.read(va, 4))[0]
    def i32(self, va): return struct.unpack("<i", self.read(va, 4))[0]
    def f32(self, va): return struct.unpack("<f", self.read(va, 4))[0]
    def f64(self, va): return struct.unpack("<d", self.read(va, 8))[0]
    def f64_hi(self, va_hi):
        """A double whose low dword is a zeroed register (xor r,r)."""
        return struct.unpack("<d", struct.pack("<II", 0, self.u32(va_hi)))[0]

    def f64_split(self, va_lo, va_hi):
        return struct.unpack("<d", struct.pack("<II", self.u32(va_lo), self.u32(va_hi)))[0]


def f32_bits(bits): return struct.unpack("<f", struct.pack("<I", bits))[0]


# (description, reader, expected, where)
EXE_CHECKS = [
    ("waypoint reached box half-size (units)", lambda e: e.f64(0x531850), 1228.8, "FUN_00450310 @4505e9"),
    ("steering gain 1/pi", lambda e: e.f32(0x531820), 1 / math.pi, "FUN_00450310, FUN_004510e0"),
    ("LOS pass: first hit at >= this fraction", lambda e: e.f32(0x532218), 0.79, "FUN_00487f40, FUN_00489b00"),
    ("fire-while-running cone cos", lambda e: e.f64(0x532238), 0.96, "FUN_0048ac80 @48ae30"),
    ("node occupancy cell (units)", lambda e: e.f64(0x531708), 8192.0, "FUN_00451b30"),
    ("hit prob min-range distance (units)", lambda e: e.f64(0x531720), 0.01, "FUN_00489de0 @489f44"),
    ("RPG stance switch probability", lambda e: e.f32(0x5315d8), 0.4, "FUN_0048aff0/0048b210"),
    ("aim height over target origin, crouched (units)", lambda e: e.f64(0x5318e8), 1024.0, "FUN_00450150"),
    ("aim height over target origin, standing (units)", lambda e: e.f64(0x531460), 2048.0, "FUN_00450150"),
    ("vision target height standing (units)", lambda e: e.f64_split(0x46449d, 0x4644a5), 2826.24, "FUN_00464490"),
    ("vision target height crouched (units)", lambda e: e.f64_split(0x4644b8, 0x4644bf), 1433.6, "FUN_00464490"),
    ("default view alpha (vertical) rad", lambda e: e.f64_split(0x44dff7, 0x44dffc), math.radians(45), "FUN_0044deb0"),
    ("default view gamma (horizontal) rad", lambda e: e.f64_split(0x44dff7, 0x44e018), math.radians(50), "FUN_0044deb0"),
    ("default view length (units)", lambda e: e.f64_hi(0x44e01d), 122880.0, "FUN_0044deb0"),
    ("default secondary gamma rad", lambda e: e.f64_split(0x44dff7, 0x44e051), math.radians(80), "FUN_0044deb0"),
    ("default secondary length (units)", lambda e: e.f64_hi(0x44e056), 40960.0, "FUN_0044deb0"),
    ("default/LookAtNode turn clamp (rad)", lambda e: f32_bits(e.u32(0x451399)), 0.025926, "FUN_00451390, FUN_0044deb0"),
    ("LookAtNode tolerance (rad)", lambda e: f32_bits(e.u32(0x48ce08)), math.radians(3), "FUN_0048cca0"),
    ("ALERT event type", lambda e: e.u32(0x488f3d), 5, "FUN_00488f30"),
    ("ALERT filter flags", lambda e: e.u32(0x488f45), 0x26, "FUN_00488f30"),
    ("ALERT radius (units)", lambda e: f32_bits(e.u32(0x488f4d)), 28672.0, "FUN_00488f30"),
    ("ALERT period (ticks)", lambda e: e.u32(0x488f1b), 20, "FUN_00488d40"),
    ("'detected' voice min gap (ticks)", lambda e: e.read(0x488df1, 1)[0], 0x5A, "FUN_00488d40"),
    ("DOOR event type/flags/range", lambda e: (e.u32(0x40c37d), e.u32(0x40c38b), f32_bits(e.u32(0x40c397))),
     (12, 0x46, 20480.0), "FUN_0040c370"),
    ("LADDER event type/flags/range", lambda e: (e.u32(0x40d882), e.u32(0x40d88e), f32_bits(e.u32(0x40d896))),
     (14, 0x46, 20480.0), "FUN_0040d8b0"),
    ("FENCE event type/flags/range", lambda e: (e.u32(0x411a38), e.u32(0x411a44), f32_bits(e.u32(0x411a4c))),
     (13, 0x46, 20480.0), "FUN_00411710"),
    ("GROUNDIMPACT event type/flags, hard-landing range", lambda e: (e.u32(0x4087ea), e.u32(0x4087f6), f32_bits(e.u32(0x4087db))),
     (11, 0x46, 40960.0), "FUN_00408570"),
    ("WALK event type/flags", lambda e: (e.u32(0x4626d0), e.u32(0x4626e0)), (10, 0x46), "FUN_00462560"),
    ("GUNSHOT event type/flags", lambda e: (e.u32(0x477efe), e.u32(0x477f06)), (16, 0x46), "FUN_00477ea0"),
    ("GUNSHOTMISS event type/flags/range", lambda e: (e.u32(0x45f447), e.u32(0x45f457), f32_bits(e.u32(0x45f45f))),
     (20, 0x46, 8192.0), "0x45f443 (bullet code)"),
    ("FLASHBANG event type/flags/range", lambda e: (e.u32(0x47cc96), e.u32(0x47cca7), f32_bits(e.u32(0x47ccb3))),
     (19, 3, 40960.0), "0x47cc92"),
    ("GRENADELAND event type/flags/range", lambda e: (e.read(0x475435, 1)[0], e.read(0x475433, 1)[0], f32_bits(e.u32(0x47542e))),
     (18, 2, 20480.0), "FUN_004753f0"),
    ("GRENADETHROWN event type/flags/range", lambda e: (e.read(0x47592a, 1)[0], e.read(0x475928, 1)[0], f32_bits(e.u32(0x47591b))),
     (17, 1, -1.0), "FUN_00475760"),
    ("EXPLOSION event type/flags/range (typical)", lambda e: (e.read(0x427b2c, 1)[0], e.read(0x427b2a, 1)[0], f32_bits(e.u32(0x427b25))),
     (21, 2, 102400.0), "0x427b24"),
    ("TAKINGDAMAGE event type/flags", lambda e: (e.u32(0x454391), e.u32(0x4543a1)), (15, 0), "0x45438d"),
    ("close-combat distance (units)", lambda e: e.f64_hi(0x44e0bd), 6144.0, "FUN_0044deb0 (H+0x3da8)"),
]


def rows_kernel(exe):
    out = []
    for k in range(25):
        dx, dy, w = struct.unpack("<iii", exe.read(0x53AA48 + 12 * k, 12))
        out.append((dx, dy, w))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--root", type=Path, default=Path("Game Files"))
    ap.add_argument("--level", default="missions/location0/level1")
    ap.add_argument("--difficulty", default="GD_2")
    args = ap.parse_args()
    root = args.root
    if not root.is_dir():
        sys.exit(f"{root} not found; run from the repository root or pass --root")
    failures = []

    def check(cond, text):
        print(("  ok   " if cond else "  FAIL ") + text)
        if not cond:
            failures.append(text)

    # 1-2 graphs ------------------------------------------------------------
    print("== graphs (GraphStream; tags = FUN_004f0a40(field name)) [recovered + observed]")
    for name, ftype in GRAPH_FIELDS.items():
        print(f"     {name:<14} type {ftype:>2}  tag 0x{stream_hash(name):08x}")
    gdir = root / args.level / "graphs"
    graphs = {}
    for path in sorted(gdir.glob("graph*.dat"), key=lambda p: int(p.stem[5:])):
        g = read_graph(path.read_bytes(), path.name)
        gid = int(path.stem[5:])
        graphs[gid] = g
        st = check_graph(g)
        crit = sorted({n["criteria"] or "-" for n in g["nodes"].values()})
        print(f"  graph {gid:>4}: cap {g['cap']:>3} nodes {len(g['nodes']):>3} links {st['links']:>3} "
              f"route pairs {st['pairs']:>5} max|cost-dijkstra| {st['max_cost_dev_units']:.1f} units "
              f"(>1 unit: {st['cost_mismatch_gt_1unit']}) criteria {crit}")
        check(st["direct_next_ok"] == 2 * st["links"], f"graph {gid}: route next == to for every linked pair")
        check(st["next_not_neighbour"] == 0, f"graph {gid}: every next hop is a neighbour")
        check(st["path_fail"] == 0, f"graph {gid}: following next hops always reaches the target")
    if 4019 in graphs:
        g = graphs[4019]
        p = route_path(g, 1, 200)
        print(f"  route 1 -> 200 in graph 4019 (next hops): {p}")
        check(p is not None and p[0] == 1 and p[-1] == 200, "graph 4019: route 1 -> 200 exists")
        bad = [(l["a"], l["b"]) for l in g["links"]
               if abs(route_entry(g, l["a"], l["b"])[1]
                      - math.dist(g["nodes"][l["a"]]["position"], g["nodes"][l["b"]]["position"])) > 1]
        print(f"  graph 4019: {len(bad)} of {len(g['links'])} links have a stored cost != their length "
              f"(all touch nodes {min(min(b) for b in bad) if bad else '-'}..{max(max(b) for b in bad) if bad else '-'}; "
              "stale table after editing [inferred]; the exe uses the stored table [recovered: FUN_00500100 loads it])")
    for gid in (7, 13):
        if gid in graphs:
            check(check_graph(graphs[gid])["max_cost_dev_units"] < 0.01,
                  f"graph {gid}: stored costs equal Dijkstra on 3-D link lengths")

    # 3 patrol paths ---------------------------------------------------------
    from level_tasks import read_tasks          # noqa: E402  (repo module, stdlib only)
    tasks = read_tasks((root / args.level / "objects.qvm").read_bytes())
    print("\n== patrol paths (FUN_004525f0 / 00452540 / 00452570) [recovered semantics, observed data]")
    by_id = {t["id"]: t for t in tasks}
    for t in tasks:
        if t["type"] != "PatrolPath":
            continue
        cmds = [(int(c["params"]["Command"]), int(c["params"]["Command Parameter"]))
                for c in t["children"] if c["type"] == "PatrolPathCommand"]
        print(f"  PatrolPath {t['id']:>4} (owner {t['parent']['type']} {t['parent']['id']}): "
              + ", ".join(simulate_patrol(cmds)))
    ais = [t for t in tasks if t["type"] == "HumanAI"]
    missing = [a["id"] for a in ais if int(a["params"]["Graph ID"]) not in graphs]
    print(f"  HumanAI tasks: {len(ais)}; graph ids used: {sorted({int(a['params']['Graph ID']) for a in ais})}")
    check(not missing, "every HumanAI 'Graph ID' has a graphs/graph<id>.dat (else FUN_0044e260 never runs it)")
    aigraphs = {t["id"]: t for t in tasks if t["type"] == "AIGraph"}
    check(all(gid in aigraphs for gid in graphs), "every graph file has an AIGraph task with the same id")
    for gid, t in sorted(aigraphs.items()):
        cnt, cap, nl = t["params"]["Graphdata"]
        g = graphs.get(gid)
        if g:
            check((len(g["nodes"]), g["cap"], len(g["links"])) == (cnt, cap, nl),
                  f"AIGraph {gid} Graphdata {cnt}/{cap}/{nl} matches the file "
                  f"(parent {t['parent']['type'] if t['parent'] else '-'})")
    _ = by_id

    # 4 combat configuration --------------------------------------------------
    print(f"\n== HumanAIConfigItem -> HumanAI (FUN_00407080), {args.difficulty} [recovered mapping, observed values]")
    cfg = [t for t in read_tasks((root / "common/ai/settings.qvm").read_bytes())
           if t["type"] == "HumanAIConfigItem" and t["params"]["Difficulty"] == args.difficulty]
    ak = next((t for t in cfg if t["params"]["AI Type"] == "AITYPE_PATROL_AK"), None)
    if ak:
        for field, off, how, reader in CONFIG_MAP:
            v = ak["params"][field]
            print(f"  {off:<34} {field:<52} {v!s:>8} -> {convert(v, how)!s:<10} "
                  f"{'read by ' + reader if reader else 'NEVER READ (no effect)'}")
        check(len(cfg) == 29, f"settings.qvm has one {args.difficulty} item per AI type (29)")

    # 5 exe ------------------------------------------------------------------
    exe_path = root / "igi.exe"
    print("\n== constants re-read from igi.exe [recovered]")
    if exe_path.is_file():
        exe = Exe(exe_path.read_bytes())
        for text, reader, expected, where in EXE_CHECKS:
            got = reader(exe)
            if isinstance(expected, tuple):
                ok = all(abs(a - b) <= 1e-6 * max(1, abs(b)) for a, b in zip(got, expected))
            else:
                ok = abs(got - expected) <= 1e-5 * max(1, abs(expected))
            check(ok, f"{text}: {got} ({where})")
        kernel = rows_kernel(exe)
        print("  occupancy stamp 5x5 (FUN_00451990, table 0x53aa48): "
              + " ".join(f"{w}" for _, _, w in kernel))
        check(kernel[12] == (0, 0, 100) and sum(w for *_, w in kernel) == 100 + 8 * 50 + 16 * 25,
              "occupancy kernel 100 centre / 50 ring / 25 outer")
        states = {n: [exe.i32(exe.u32(0x53F4FC + 4 * t) + 4 * n) for t in range(29)] for n in range(5)}
        check(states[0][7] == 0 and states[1][7] == 19 and states[2][7] == 26 and states[3][7] == 35,
              "AI state table 0x53f4fc (patrol types): stand 0, kneel 19, liedown 26, animation 35")
        chans = [exe.i32(exe.u32(0x53F3C0 + 4 * 7) + 4 * n) for n in range(10)]
        check(chans == [20, 21, 22, 23, 24, 25, 27, 28, 29, 30],
              f"AI request -> input channel table 0x53f3c0 (patrol types): {chans}")
    else:
        print("  igi.exe not present; skipped")

    print(f"\n{'all checks passed' if not failures else str(len(failures)) + ' check(s) failed'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
