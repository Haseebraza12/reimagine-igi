"""Level-1 mission task runtime model of Project I.G.I. (igi.exe), with self-checks.

Python counterpart of web-port/src/loaders/mission.ts; evidence in docs/mission.md.
Stdlib only; run from the repository root:

    python tools/igi_mission.py                 # summary + self-checks
    python tools/igi_mission.py --json out.json # full model as JSON
    python tools/igi_mission.py --timeline      # intro / outro tick timelines

Labels: observed = measured on the shipped files; recovered = read from igi.exe
code (function addresses); inferred = neither.

What this reproduces (all recovered unless marked):
  * tree update order: the Level root (LAB_004e7100) updates its children in
    file order, each type decides when to update its own children; Static
    never updates (FUN_00526660); the tick counter advances after the tree.
  * per-type rules: ConditionalContainer FUN_00485450, LevelTimer FUN_00515bb0,
    EditVariable FUN_004866f0, StatusMessage FUN_00483690, CutScene
    FUN_004ebe30/FUN_004ec060/FUN_004ec230, AnimTask FUN_004ea7c0/FUN_004eabe0,
    Train input FUN_0042a450, Door FUN_00445ae0, Switch FUN_00444210,
    Terminal FUN_00442ac0, AlarmControl FUN_0043fa60, SCameraControl
    FUN_0043ff30, SCamera FUN_004417d0/FUN_00440930/FUN_00440db0,
    ConditionalSound FUN_004246a0, AreaActivate FUN_004fb540/FUN_004faf50,
    DefineComputerObjective FUN_00465f90, LevelFlow FUN_004876b0, Game task
    FUN_00415306 (mission complete).
  * conditions: FUN_004e80a0 rewrite and float-mode evaluation FUN_004af8a0
    (docs/qvm-vm.md section 8): && || short-circuit, comparisons give 1.0/0.0.
"""
import argparse
from fractions import Fraction
import json
import math
import re
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from level_tasks import read_tasks  # noqa: E402

LEVEL = "missions/location0/level1"
TICKS = 30


def f32(x):
    return struct.unpack("<f", struct.pack("<f", x))[0]


def fist(x):
    """x87 fistp QWORD + low dword as igi.exe runs it: the FPU is in chop mode
    (FUN_004966d0, checked every frame at 0x48dbc1; docs/gameplay.md "FPU
    rounding mode"), so this truncates toward zero; NaN / inf give 0."""
    if not math.isfinite(x) or abs(x) >= 2.0 ** 63:
        return 0
    v = int(x) & 0xFFFFFFFF
    return v - (1 << 32) if v >= 1 << 31 else v


def chop(exact):
    """An x87 double op result in chop mode: the double nearest `exact` (a Fraction) toward zero."""
    d = float(exact)
    if d != 0 and abs(Fraction(d)) > abs(exact):
        d = math.nextafter(d, 0.0)
    return d


def byte(x):
    v = fist(x) & 0xff
    return v - 256 if v >= 128 else v


# --------------------------------------------------------------- expressions

TOKEN = re.compile(r"\s*(?:(\d+\.\d*(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+)|(\d+)|([A-Za-z_.][0-9A-Za-z_.]*|\d[0-9A-Za-z_.]*[A-Za-z_.][0-9A-Za-z_.]*)"
                   r"|(&&|\|\||==|!=|<=|>=|<<|>>|[-+*/<>!~()&|^,?:]))")
PREC = {"*": 3, "/": 3, "+": 4, "-": 4, "<<": 5, ">>": 5, "<": 6, ">": 6, "<=": 6, ">=": 6, "==": 7, "!=": 7,
        "&": 8, "^": 9, "|": 10, "&&": 11, "||": 12}


def task_id_of(token):
    """FUN_004e8470: digits right before the first '.' (or the end)."""
    head = token.split(".", 1)[0]
    m = re.search(r"(\d+)$", head)
    return int(m.group(1)) if m else -1


def rewrite(text, exists):
    """FUN_004e80a0: missing task -> 0, '.isExists' -> 1, whitespace dropped (tokens kept apart)."""
    out = []
    for tok in re.findall(r"[0-9A-Za-z_.$]+|\"[^\"]*\"|&&|\|\||==|!=|<=|>=|<<|>>|\S", text):
        if re.match(r"[A-Za-z_.]", tok) and task_id_of(tok) >= 0 and not exists(task_id_of(tok)):
            tok = "0"
        if ".isExists" in tok:
            tok = "1"
        out.append(tok)
    return " ".join(out)


def parse(text):
    toks = []
    pos = 0
    text = text.strip().rstrip(";")
    while pos < len(text):
        m = TOKEN.match(text, pos)
        if not m or m.end() == pos:
            if text[pos:].strip() == "":
                break
            raise ValueError(f"bad token at {pos} in {text!r}")
        pos = m.end()
        if m.group(1):
            toks.append(("num", float(m.group(1))))
        elif m.group(2):
            toks.append(("num", int(m.group(2))))
        elif m.group(3):
            toks.append(("id", m.group(3)))
        else:
            toks.append(("op", m.group(4)))
    i = 0

    def peek():
        return toks[i] if i < len(toks) else (None, None)

    def primary():
        nonlocal i
        kind, val = peek()
        if kind == "op" and val == "(":
            i += 1
            node = expr(15)
            i += 1
            return node
        if kind == "op" and val in "+-!~":
            i += 1
            return ("un", val, expr(2))
        if kind == "num":
            i += 1
            return ("num", val)
        if kind == "id":
            i += 1
            if peek() == ("op", "("):
                i += 1
                args = []
                if peek() != ("op", ")"):
                    args.append(expr(14))
                    while peek() == ("op", ","):
                        i += 1
                        args.append(expr(14))
                i += 1
                return ("call", val, args)
            return ("id", val)
        raise ValueError(f"unexpected {val!r} in {text!r}")

    def expr(limit):
        nonlocal i
        left = primary()
        while True:
            kind, val = peek()
            if kind != "op":
                break
            if val == "?" and limit >= 13:
                i += 1
                a = expr(13)
                i += 1
                b = expr(13)
                left = ("tern", left, a, b)
                continue
            p = PREC.get(val)
            if p is None or p > limit:
                break
            i += 1
            left = ("bin", val, left, expr(p - 1))
        return left

    node = expr(15)
    if i != len(toks):
        raise ValueError(f"trailing input in {text!r}")
    return node


def evaluate(node, lookup):
    """Float-mode evaluation (FUN_004af8a0)."""
    k = node[0]
    if k == "num":
        return float(node[1])
    if k == "id":
        v = lookup(node[1], None)
        return 0.0 if v is None else float(v)
    if k == "call":
        v = lookup(node[1], [evaluate(a, lookup) for a in node[2]])
        return 0.0 if v is None else float(v)
    if k == "un":
        v = evaluate(node[2], lookup)
        return -v if node[1] == "-" else v if node[1] == "+" else (1.0 if v == 0 else 0.0) if node[1] == "!" else 0.0
    if k == "tern":
        return evaluate(node[2] if fist(evaluate(node[1], lookup)) != 0 else node[3], lookup)
    op, a, b = node[1], node[2], node[3]
    if op == "&&":
        return 1.0 if evaluate(a, lookup) != 0 and evaluate(b, lookup) != 0 else 0.0
    if op == "||":
        return 1.0 if evaluate(a, lookup) != 0 or evaluate(b, lookup) != 0 else 0.0
    x, y = evaluate(a, lookup), evaluate(b, lookup)
    if op in ("+", "-", "*", "/"):  # doubles, rounded toward zero (0x4afa30..0x4afaa9, chop mode)
        if op == "/" and y == 0:
            return 0.0
        if not (math.isfinite(x) and math.isfinite(y)):
            return {"+": x + y, "-": x - y, "*": x * y, "/": x / y}[op]
        X, Y = Fraction(x), Fraction(y)
        return chop({"+": X + Y, "-": X - Y, "*": X * Y, "/": X / Y if y else 0}[op])
    return {"==": float(x == y), "!=": float(x != y), "<": float(x < y),
            ">": float(x > y), "<=": float(x <= y), ">=": float(x >= y)}.get(op, 0.0)


CONSTANTS = {"GAME_FREQUENCY": 30, "TRUE": 1, "FALSE": 0, "ON": 1, "OFF": 0}

# Parameters compiled as conditions, per type (compile handlers, see mission.ts TASK_EXPRESSION_FIELDS).
EXPRESSION_FIELDS = {
    "StatusMessage": ["Send"], "EditVariable": ["Add", "Sub"], "LevelTimer": ["On", "Reset"],
    "ConditionalContainer": ["Condition", "Run at start", "Run at stop"],
    "CutScene": ["Run", "Reset", "Time delta (seconds)", "Start expression", "Stop expression"],
    "AnimTask": ["Run"], "Door": ["Locked expression", "Open door expression", "Close door expression"],
    "Switch": ["On"], "ExplodeObject": ["Explosion expression"],
    "Terminal": ["Explosion expression", "On Expression"],
    "AlarmControl": ["Explosion expression", "On Expression", "Trigger Expression", "Alarm Expression"],
    "SCameraControl": ["Explosion expression", "On Expression", "Detection Expression"],
    "SCamera": ["On Expression"], "ConditionalSound": ["Condition"], "LevelFlow": ["Complete", "Failed"],
    "DefineComputerObjective": ["Objectives Valid"] + [f"Objective {k} {w} Expression" for k in range(1, 7)
                                                       for w in ("Complete", "Failed")],
    "Train": ["Play Sound"], "Car": ["Open door", "Can fire", "Play sound"], "Heli": ["Open door", "Can fire", "Play sound"],
}

# Members per type (register-members handlers; addresses in docs/mission.md section 3).
MEMBERS = {
    "AreaActivate": ["nActive"], "StatusMessage": ["isSendt", "nTickSendt"], "EditVariable": ["nValue"],
    "LevelTimer": ["isRun", "nTick"], "ConditionalContainer": ["isRun"], "CutScene": ["isRun", "isFinished", "nTick"],
    "AnimTask": ["isRun", "nTick"], "LevelFlow": ["isComplete", "isFailed", "nTick", "eDifficulty"],
    "Door": ["isLocked", "isOpen", "isClosed", "isLastClosed", "isLastOpen", "isPicked", "nDoorOpenTicks"],
    "Switch": ["isOn", "isLastOn", "isPressed", "isLastPressed", "isDestroyed", "isLastDestroyed"],
    "ExplodeObject": ["isExploded"],
    "Terminal": ["isExploded", "isInUse", "isLastInUse", "isOn", "isHacked", "isHackedThisTick"],
    "AlarmControl": ["isExploded", "isInUse", "isLastInUse", "isOn", "isHacked", "isHackedThisTick", "isTrigger",
                     "isAlarm", "nTriggerLastTick"],
    "SCameraControl": ["isExploded", "isInUse", "isLastInUse", "isOn", "isHacked", "isHackedThisTick", "isDetection"],
    "SCamera": ["isDetection", "isLastDetection", "nDetectionTime", "isExploded"],
    "ConditionalSound": ["isRun", "isLastRun", "isPlaying", "nPlayTick"],
    "Car": ["isExploded"], "HumanPlayer": ["isDead", "eTeam"], "HumanSoldier": ["isDead", "eTeam"],
    "HumanAI": ["isDetection"],
}


# --------------------------------------------------------------- geometry

def euler_matrix(a, b, g):
    """FUN_004a9bc0: Rz(g) Ry(b) Rx(a), row-major; columns are local axes."""
    ca, sa, cb, sb, cg, sg = math.cos(a), math.sin(a), math.cos(b), math.sin(b), math.cos(g), math.sin(g)
    rz = [[cg, -sg, 0], [sg, cg, 0], [0, 0, 1]]
    ry = [[cb, 0, sb], [0, 1, 0], [-sb, 0, cb]]
    rx = [[1, 0, 0], [0, ca, -sa], [0, sa, ca]]

    def mul(p, q):
        return [[sum(p[r][k] * q[k][c] for k in range(3)) for c in range(3)] for r in range(3)]
    return mul(mul(rz, ry), rx)


def area_contains(area, p):
    """FUN_004faf50: |R^T (p - pos)| <= Dimensions/2 per axis (inclusive)."""
    r = euler_matrix(*area["euler"])
    d = [p[i] - area["position"][i] for i in range(3)]
    for i in range(3):
        local = f32(sum(r[k][i] * d[k] for k in range(3)))
        if local > area["half"][i] or -area["half"][i] > local:
            return False
    return True


def hermite(p, t, time):
    """FUN_004ece70 + FUN_00511e70/FUN_00511ed0."""
    p0, p1, p2, p3 = p
    t0, t1, t2, t3 = t
    m1 = 0.0 if t2 - t0 == 0 else (p2 - p0) * 0.5 * ((t1 - t0) * 2 / (t2 - t0))
    m2 = 0.0 if t3 - t1 == 0 else ((t2 - t1) * 2 / (t3 - t1)) * (p3 - p1) * 0.5
    s = 0.0 if t2 - t1 == 0 else (time - t1) / (t2 - t1)
    c3 = p1 + p1 - (p2 + p2) + m1 + m2
    c2 = p2 * 3 - p1 * 3 - (m1 + m1) - m2
    return s * m1 + s * s * c2 + s * s * s * c3 + p1


FILTERS = {"CAMERAFILTER_TYPE_NONE": 0, "CAMERAFILTER_TYPE_LINE": 1, "CAMERAFILTER_TYPE_BAND": 2,
           "CAMERAFILTER_TYPE_BAND_UPDATE": 3, "CAMERAFILTER_TYPE_HANDICAM": 4}


def cut_scene(task):
    """Camera keys (FUN_004eb4e0): float32 running start, unwrap (FUN_004eb5a0)."""
    p = task["params"]
    scale = f32(p["Time scale"])
    keys, total = [], 0.0
    for c in task["children"]:
        if c["type"] != "EditCamera":
            continue
        q = c["params"]
        fov = min(max(f32(q["FOV"]), f32(0.001)), 3.0)
        keys.append({"name": c["name"], "start": total, "duration": f32(q["Duration"]), "position": list(q["Position"]),
                     "alpha": f32(q["Alpha"]), "beta": f32(q["Beta"]), "gamma": f32(q["Gamma"]), "fov": fov,
                     "link": q["Link task ID"], "update_link": q["Update link continously"],
                     "target": q["Target task ID"], "update_target": q["Update target continously"],
                     "smooth": q["Smooth to next"], "time_of_day": f32(q["Time of day (-1 means use default)"]),
                     "filter": q["FILTER"], "noise": f32(q["Noise"]), "filter_color": list(q["Filter color"]),
                     "shake": f32(q["Camera shake"])})
        total = f32(f32(scale * f32(q["Duration"])) + total)
    for axis in ("alpha", "beta", "gamma"):
        for i in range(1, len(keys)):
            a, prev = keys[i][axis], keys[i - 1][axis]
            while 3.1415926535897944 < a - prev:
                a = f32(a - f32(6.2831854820251465))
            while a - prev < -3.1415926535897944:
                a = f32(a + f32(6.2831854820251465))
            keys[i][axis] = a
    return {"id": task["id"], "name": task["name"], "keys": keys, "total": total,
            "viewport_height_factor": f32(p["Viewport height factor"]),
            "fade_in": f32(p["Viewport height factor fade in time"]),
            "fade_out": f32(p["Viewport height factor fade out time"]), "time_of_day": f32(p["Time of day"]),
            "start_time": p["Start time (seconds)"]}


def sample_camera(cut, n_tick):
    """FUN_004ec060 / FUN_004ec230 without shake, link and target."""
    keys = cut["keys"]
    if not keys:
        return None
    t = f32(f32(n_tick) / f32(30))
    i = -1
    for k, key in enumerate(keys):
        if t < key["start"]:
            break
        i = k
    finished = cut["total"] < t

    def at(k):
        return min(max(k, 0), len(keys) - 1)
    k0, k1, k2, k3 = at(i - 1), at(i), at(i + 1), at(i + 2)
    if not keys[k0]["smooth"]:
        k0 = k1
    if not keys[k1]["smooth"]:
        k2 = k1
    if not keys[k2]["smooth"]:
        k3 = k2
    ks = [keys[k0], keys[k1], keys[k2], keys[k3]]
    times = [k["start"] for k in ks]

    def h(get):
        return hermite([get(k) for k in ks], times, t)
    return {"key": i, "curve": [k0, k1, k2, k3], "finished": finished, "time": t,
            "position": [h(lambda k, j=j: k["position"][j]) for j in range(3)],
            "alpha": f32(h(lambda k: k["alpha"])), "beta": f32(h(lambda k: k["beta"])),
            "gamma": f32(h(lambda k: k["gamma"])), "fov": f32(h(lambda k: k["fov"])),
            "link": ks[1]["link"], "target": ks[1]["target"], "filter": ks[1]["filter"]}


def finish_tick(cut):
    n = 0
    while not cut["total"] < f32(f32(n) / f32(30)):
        n += 1
    return n


def anim_records(value):
    """FUN_004ea1f0: n pairs (channel, value); channel 32 = wait N ticks."""
    n = int(value[0])
    return [(fist(value[1 + 2 * k]), fist(value[2 + 2 * k]) if fist(value[1 + 2 * k]) == 32 else f32(value[2 + 2 * k]))
            for k in range(n)]


# --------------------------------------------------------------- runtime

class Runtime:
    """Python port of MissionRuntime (mission.ts); host hooks are plain callables."""

    def __init__(self, tasks, humans=lambda: [], escape=lambda: False, external=lambda name: None,
                 sighting=lambda cam_id: None, log=None):
        self.tasks = tasks
        self.humans, self.escape, self.external, self.sighting = humans, escape, external, sighting
        self.log = log if log is not None else []
        self.ids = {t["id"]: t for t in tasks if t["id"] >= 0}
        self.roots = [t for t in tasks if t["parent"] is None]
        self.level_tick = 0
        self.complete = False
        self.objectives = []
        self.s = {}
        self.members = {}
        self.compiled = {}
        self.cam_target = {}
        self.level_flow = None
        for t in tasks:
            self._create(t)
        for t in tasks:
            self._compile(t)

    def _st(self, t):
        return self.s[t["order"]]

    def _create(self, t):
        p = t["params"]
        s = {}
        typ = t["type"]
        if typ == "AreaActivate":
            d = p["Dimensions"]
            s.update(nActive=0)
            t["_area"] = {"position": p["Position"], "euler": p["Orientation"], "half": [f32(x * 0.5) for x in d]}
            t["_mask"] = p["Criteria"].strip()
        elif typ == "StatusMessage":
            s.update(isSendt=0, nTickSendt=-100000)
        elif typ == "EditVariable":
            s.update(nValue=int(p["Initial value"]))
        elif typ == "LevelTimer":
            s.update(isRun=int(bool(p["Initial run"])), nTick=0)
        elif typ == "ConditionalContainer":
            s.update(isRun=0, inWorld=1)
        elif typ == "CutScene":
            s.update(isRun=int(bool(p["Initial run"])), isFinished=0, nTick=0, wasRun=0, keyIndex=-1)
            t["_cut"] = cut_scene(t)
        elif typ == "AnimTask":
            s.update(isRun=int(bool(p["Initial run"])), nTick=-1)
            t["_records"] = anim_records(p["AnimData"])
            t["_ch"] = [0.0] * 34
        elif typ == "LevelFlow":
            s.update(isComplete=0, isFailed=0, nTick=0, eDifficulty=1)
            self.level_flow = t
        elif typ == "Switch":
            s.update(isOn=int(bool(p["Initial on"])), isLastOn=1, isPressed=0, isLastPressed=0, isDestroyed=0,
                     isLastDestroyed=0, pressTick=0)
        elif typ in ("ExplodeObject", "Terminal", "AlarmControl", "SCameraControl"):
            s.update(isExploded=0, countdown=-1, flag=0)
            if typ != "ExplodeObject":
                s.update(isInUse=0, isLastInUse=0, isOn=1, isHacked=0, isHackedThisTick=0, useTick=0, hackTick=0)
            if typ == "AlarmControl":
                s.update(isTrigger=0, isAlarm=0, nTriggerLastTick=-10000)
            if typ == "SCameraControl":
                s.update(isDetection=0)
        elif typ == "SCamera":
            s.update(isOn=0, isDetection=0, isLastDetection=0, nDetectionTime=0, isExploded=0)
        elif typ == "ConditionalSound":
            s.update(isRun=0, isLastRun=0, isPlaying=0, nPlayTick=-1, started=0, voice=0)
        elif typ == "Door":
            s.update(isLocked=0, isOpen=0, isClosed=1, isLastOpen=0, isLastClosed=1, isPicked=0, nDoorOpenTicks=0,
                     angle=0.0, slide=f32(p["Position slider"]), want=0)
        elif typ == "Train":
            s.update(thrust=f32(p["Original thrust"]), target=f32(p["Original thrust"]), speed=0.0,
                     distance=f32(p["Position"]))
        self.s[t["order"]] = s
        if t["id"] >= 0:
            for m in MEMBERS.get(typ, []):
                if m in s:
                    self.members[f"{typ}_{t['id']}.{m}"] = (t["order"], m)

    def _compile(self, t):
        for field in EXPRESSION_FIELDS.get(t["type"], []):
            text = t["params"].get(field, "")
            node = None
            if isinstance(text, str) and text.strip():
                node = parse(rewrite(text, lambda i: i in self.ids))
            self.compiled[(t["order"], field)] = node
        if t["type"] == "CutScene":
            self._st(t)["nTick"] = fist(30 * f32(t["params"]["Start time (seconds)"]))
        if t["type"] == "AnimTask":
            self._seek(t, 0)

    def lookup(self, name, args):
        if args is not None:
            if name == "LevelFlow_GetBreakCutSceneKey":
                return 0x80 if self.escape() else 0
            if name == "LevelFlow_LevelFailed":
                return self._st(self.level_flow)["isFailed"]
            self.log.append((self.level_tick + 1, "call", f"{name}({','.join(str(int(a)) for a in args)})"))
            return 0
        if name in self.members:
            order, m = self.members[name]
            return self.s[order][m]
        if name in CONSTANTS:
            return CONSTANTS[name]
        return self.external(name)

    def ev(self, t, field):
        node = self.compiled.get((t["order"], field))
        return None if node is None else evaluate(node, self.lookup)

    def evb(self, t, field):
        v = self.ev(t, field)
        return None if v is None else byte(v)

    def lf_tick(self):
        return self._st(self.level_flow)["nTick"]

    def tick(self):
        if self.complete:
            return
        if self._st(self.level_flow)["isComplete"]:
            self.complete = True
            return
        for r in self.roots:
            self.update(r)
        self.level_tick += 1

    def press_switch(self, sid):
        s = self._st(self.ids[sid])
        s["isLastPressed"], s["isPressed"], s["pressTick"] = s["isPressed"], 1, self.lf_tick()

    def children(self, t):
        for c in t["children"]:
            self.update(c)

    def update(self, t):
        typ, s, now = t["type"], self._st(t), self.level_tick + 1
        if typ == "Static":
            return
        if typ == "AreaActivate":
            mask = t["_mask"]
            team = int(mask[len("CRITERIA_HUMAN"):]) if mask[len("CRITERIA_HUMAN"):].isdigit() else None
            s["nActive"] = sum(1 for pos, tm in self.humans() if (team is None or tm == team) and area_contains(t["_area"], pos))
            self.children(t)
        elif typ == "StatusMessage":
            p = t["params"]
            if (not p["Is send once"] or not s["isSendt"]) and s["nTickSendt"] + 210 < self.lf_tick():
                v = self.ev(t, "Send")
                if v:
                    self.log.append((now, "msg", p["Text"]))
                    s["isSendt"], s["nTickSendt"] = 1, self.lf_tick()
        elif typ == "EditVariable":
            for field, sign in (("Add", 1), ("Sub", -1)):
                v = self.ev(t, field)
                if v is not None:
                    s["nValue"] += sign * fist(v)
        elif typ == "LevelTimer":
            self.children(t)
            on = self.evb(t, "On")
            if on is not None:
                s["isRun"] = on
            r = self.ev(t, "Reset")
            if r is not None and r != 0:
                s["nTick"] = 0
            if s["isRun"]:
                s["nTick"] += 1
        elif typ == "ConditionalContainer":
            prev = s["isRun"]
            c = self.evb(t, "Condition")
            if c is not None:
                s["isRun"] = c
            if not s["isRun"] and not prev:
                if s["inWorld"]:
                    self.log.append((now, "remove", t["id"]))
                    s["inWorld"] = 0
            else:
                if not s["inWorld"]:
                    self.log.append((now, "add", t["id"]))
                    s["inWorld"] = 1
                self.children(t)
            if s["isRun"] and not prev:
                self.ev(t, "Run at start")
            elif not s["isRun"] and prev:
                self.ev(t, "Run at stop")
        elif typ == "CutScene":
            self.children(t)
            r = self.evb(t, "Run")
            if r is not None:
                s["isRun"] = r
            prev = s["wasRun"]
            if s["isRun"]:
                cam = sample_camera(t["_cut"], s["nTick"])
                if cam:
                    if s["nTick"] == 0:
                        self.log.append((now, "cut start", t["id"]))
                    if cam["finished"]:
                        s["isFinished"] = 1
                        s["nTick"] = fist(30 * t["_cut"]["total"])
                        self.log.append((now, "cut finished", t["id"]))
                    s["keyIndex"] = cam["key"]
                s["nTick"] += 1
            elif prev:
                self.log.append((now, "cut stop", t["id"]))
            s["wasRun"] = s["isRun"]
        elif typ == "AnimTask":
            r = self.evb(t, "Run")
            if r is not None:
                s["isRun"] = r
            if s["isRun"]:
                self._seek(t, s["nTick"] + 1)
        elif typ == "Door":
            self.children(t)
            self._door(t, s)
        elif typ == "Switch":
            self.children(t)
            on = self.evb(t, "On")
            if on is not None:
                s["isOn"] = on
            if s["pressTick"] + 2 < self.lf_tick():
                s["isLastPressed"], s["isPressed"] = s["isPressed"], 0
        elif typ in ("ExplodeObject", "Terminal", "AlarmControl", "SCameraControl"):
            self.children(t)
            if not s["isExploded"]:
                f = self.evb(t, "Explosion expression")
                if f is not None:
                    s["flag"] = f
                if s["flag"] or s["countdown"] == 0:
                    s["isExploded"] = 1
                elif s["countdown"] > 0:
                    s["countdown"] -= 1
            if typ == "ExplodeObject":
                return
            if not s["isExploded"]:
                on = self.evb(t, "On Expression")
                if on is not None:
                    s["isOn"] = on
            else:
                s["isOn"] = 0
            if s["useTick"] + 2 < self.lf_tick():
                s["isInUse"] = 0
            s["isLastInUse"] = s["isInUse"]
            if s["hackTick"] + 2 < self.lf_tick():
                s["isHackedThisTick"] = 0
            if typ == "AlarmControl":
                if not s["isExploded"] and s["isOn"]:
                    v = self.evb(t, "Trigger Expression")
                    if v is not None:
                        s["isTrigger"] = v
                    if s["isTrigger"]:
                        s["nTriggerLastTick"] = self.level_tick
                    v = self.evb(t, "Alarm Expression")
                    if v is not None:
                        s["isAlarm"] = v
                else:
                    s["isTrigger"] = s["isAlarm"] = 0
            elif typ == "SCameraControl":
                v = self.evb(t, "Detection Expression") if not s["isExploded"] else 0
                if v is not None:
                    s["isDetection"] = v
        elif typ == "SCamera":
            s["isLastDetection"] = s["isDetection"]
            s["isDetection"] = 0
            if s["isOn"]:
                sight = self.sighting(t["id"])
                if sight is not None:
                    if self.cam_target.get(t["id"]) != sight:
                        self.cam_target[t["id"]] = sight
                        s["nDetectionTime"] = 90
                    if s["nDetectionTime"]:
                        s["nDetectionTime"] -= 1
                    if s["nDetectionTime"] == 0:
                        s["isDetection"] = 1
                else:
                    s["nDetectionTime"] = 0
                    self.cam_target[t["id"]] = None
            self.children(t)
            on = self.evb(t, "On Expression") if not s["isExploded"] else 0
            if on is not None:
                s["isOn"] = on
        elif typ == "ConditionalSound":
            p = t["params"]
            c = self.evb(t, "Condition")
            if c is not None:
                s["isLastRun"], s["isRun"] = s["isRun"], c
            if not p["OneShot"] or not s["started"]:
                if not s["isRun"]:
                    if s["voice"]:
                        s["voice"] = 0
                        self.log.append((now, "snd stop", p["SoundDef"]))
                elif not s["isLastRun"]:
                    s["started"], s["voice"] = 1, 0 if p["Simple"] else 1
                    self.log.append((now, "snd start", p["SoundDef"]))
                self.children(t)
        elif typ == "DefineComputerObjective":
            v = self.ev(t, "Objectives Valid")
            if v is not None and fist(v) & 0xff == 0:
                return
            p = t["params"]
            self.objectives = [{"index": k, "text": p[f"Objective {k} Text Resource"],
                                "complete": self.evb(t, f"Objective {k} Complete Expression") or 0,
                                "failed": self.evb(t, f"Objective {k} Failed Expression") or 0}
                               for k in range(1, 7) if p[f"Objective {k} Text Resource"]]
        elif typ == "LevelFlow":
            self.children(t)
            c, f = self.evb(t, "Complete"), self.evb(t, "Failed")
            if c is not None:
                s["isComplete"] = c
            if f is not None:
                s["isFailed"] = f
            if s["isFailed"]:
                s["isComplete"] = 0
            s["nTick"] += 1
        else:
            self.children(t)

    def _door(self, t, s):
        p = t["params"]
        s["isLastOpen"], s["isLastClosed"] = s["isOpen"], s["isClosed"]
        if s["isClosed"]:
            v = self.ev(t, "Open door expression")
            if v:
                s["want"] = 1
        if s["isOpen"]:
            s["nDoorOpenTicks"] += 1
            v = self.ev(t, "Close door expression")
            if v:
                s["want"] = 0
        else:
            s["nDoorOpenTicks"] = 0
        v = self.evb(t, "Locked expression")
        if v is not None:
            s["isLocked"] = int(v != 0)
        if s["isPicked"]:
            s["isLocked"] = 0
        ticks = f32(f32(p["Open time"]) * 30)
        ta = f32(p["Max angle"]) if s["want"] else 0.0
        ts = 1.0 if s["want"] else 0.0
        if s["angle"] != ta:
            step = f32(abs(f32(p["Max angle"])) / ticks)
            s["angle"] = min(f32(s["angle"] + step), ta) if s["angle"] < ta else max(f32(s["angle"] - step), ta)
        sx, sy = p["Position stop X"], p["Position stop Y"]
        if (sx == 0 and sy == 0) or s["slide"] == ts:
            s["slide"] = ts
        else:
            ln = f32(math.hypot(sx, sy))
            step = f32(f32(ln / ticks) / ln)
            s["slide"] = min(f32(s["slide"] + step), ts) if s["slide"] < ts else max(f32(s["slide"] - step), ts)
        if s["angle"] == ta and s["slide"] == ts:
            s["isClosed"] = int(ta == 0 and ts == 0)
            s["isOpen"] = 1 - s["isClosed"]
        else:
            s["isClosed"] = s["isOpen"] = 0

    def _seek(self, t, n):
        """FUN_004eab70 / FUN_004eabe0; the message carries the pre-increment tick (FUN_004eace0)."""
        s, ch, rec = self._st(t), t["_ch"], t["_records"]

        def step():
            if fist(ch[33]) < len(rec):
                if ch[32] != 0:
                    ch[32] -= 1
                    if ch[32] == 0:
                        ch[33] += 1
                while ch[32] == 0:
                    cur = fist(ch[33])
                    if cur >= len(rec):
                        break
                    c, v = rec[cur]
                    ch[c] = v
                    if ch[32] == 0:
                        ch[33] += 1
            self._anim_input(t, s["nTick"], ch)
        if n == 0 or n < s["nTick"]:
            for i in range(34):
                ch[i] = 0.0
            s["nTick"] = 0
            for _ in range(n + 1):
                step()
        else:
            while s["nTick"] < n:
                step()
                s["nTick"] += 1

    def _anim_input(self, anim, n_tick, ch):
        target = self.ids.get(anim["params"]["TargetID"])
        if target is None or target["type"] != "Train":
            return
        s, p = self._st(target), target["params"]
        if ch[0] != -1:
            s["target"] = ch[0]
        if n_tick == 0:
            ch[1] = -2.0
            s["distance"] = f32(p["Position"])
            s["target"] = s["thrust"] = f32(p["Original thrust"])
            s["speed"] = f32(f32(p["MaxSpeed"]) * s["thrust"] * f32(37.925926208496094))
            return
        step = f32(p["ThrustStep"])
        if s["thrust"] < s["target"]:
            s["thrust"] = min(f32(s["thrust"] + step), s["target"])
        elif s["target"] < s["thrust"]:
            s["thrust"] = max(f32(s["thrust"] - step), s["target"])
        v = f32(f32(p["MaxSpeed"]) * s["thrust"] * 4096000 * f32(9.259259059035685e-6))
        s["speed"] = v
        s["distance"] = f32((-v if p["Flip Direction"] else v) + s["distance"])

    def member(self, name):
        order, m = self.members[name]
        return self.s[order][m]


# --------------------------------------------------------------- report

def ilff_strings(data):
    """ILFF/IRES name -> string (messages.res / objectives.res)."""
    al = struct.unpack_from("<I", data, 8)[0]
    pos = (20 + al - 1) // al * al
    out, name = {}, None
    while True:
        tag = data[pos:pos + 4]
        size, align, delta = struct.unpack_from("<3I", data, pos + 4)
        off = (pos + 16 + align - 1) // align * align
        body = data[off:off + size]
        if tag == b"NAME":
            name = body.rstrip(b"\0").decode("latin1").split(".")[0].upper()
        elif tag in (b"BODY", b"CSTR", b"PATH"):
            out[name] = body.split(b"\0")[0].decode("latin1")
        if delta == 0:
            return out
        pos += delta


def ancestors(t):
    out = []
    while t["parent"] is not None:
        t = t["parent"]
        out.append(t)
    return out


def cutscene_actors(root, tasks):
    """Cut-scene actors driven by their AI script's IDLE branch (observed from the bytecode)."""
    import igi_qvm_vm
    out = []
    for t in tasks:
        if t["type"] != "HumanAI":
            continue
        cc = next((a for a in ancestors(t) if a["type"] == "ConditionalContainer" and a["id"] in (4001, 4007)), None)
        path = Path(root) / LEVEL / "ai" / f"{t['id']}.qvm"
        if cc is None or not path.exists():
            continue
        prog = igi_qvm_vm.Program(path.read_bytes(), path.name)
        ins = [prog.instructions[pc] for pc in sorted(prog.instructions)]
        names = [x.get("value") if x["name"].startswith("PUSHII") else None for x in ins]
        invulnerable = "AIFunction_SetInvulnerability" in names
        idle = next(i for i, v in enumerate(names) if v == "AIEVENT_IDLE" and ins[i + 1]["name"] == "EQ")
        cond, threshold, action, arg = None, None, None, None
        for x in ins[idle + 1:]:
            v = x.get("value")
            if x["name"].startswith("PUSHII") and isinstance(v, str):
                if v.endswith(".nTick"):
                    cond = v
                elif v.startswith("AIAction_"):
                    action = v
                elif v.startswith("AIEVENT_"):
                    break
            elif x["name"] in ("PUSHB", "PUSHW", "PUSH") and isinstance(v, int):
                if cond and threshold is None and action is None:
                    threshold = v
                elif action and arg is None:
                    arg = v
        soldier = t["parent"]
        out.append({"ai": t["id"], "soldier": soldier["id"], "soldier_name": soldier["name"],
                    "model": soldier["params"].get("Model"), "container": cc["id"],
                    "parent": f"{soldier['parent']['type']}_{soldier['parent']['id']}" if soldier["parent"] else None,
                    "invulnerable": invulnerable, "idle_action": action, "arg": arg,
                    "condition": f"{cond} > {threshold}" if cond else None})
    return out


def build_model(root):
    root = Path(root)
    data = (root / LEVEL / "objects.qvm").read_bytes()
    tasks = read_tasks(data)
    inventory = {}
    for t in tasks:
        inventory[t["type"]] = inventory.get(t["type"], 0) + 1
    msgs = {}
    lang = root / "language/english/messages.res"
    if lang.exists():
        msgs = ilff_strings(lang.read_bytes())
    cuts = [cut_scene(t) for t in tasks if t["type"] == "CutScene"]
    for c in cuts:
        c["finish_tick"] = finish_tick(c)
    subtitles = []
    for t in tasks:
        if t["type"] == "StatusMessage" and t["params"]["Cutscene message"]:
            m = re.match(r"LevelTimer_999\.nTick\s*>\s*([0-9.]+)(\*GAME_FREQUENCY)?", t["params"]["Send"])
            # literal x GAME_FREQUENCY is a double FMUL in chop mode: 24.7 * 30 = 740.9999999999999
            x = chop(Fraction(float(m.group(1))) * 30) if m.group(2) else float(m.group(1))
            subtitles.append({"id": t["id"], "text_key": t["params"]["Text"], "text": msgs.get(t["params"]["Text"], ""),
                              "send_when": t["params"]["Send"], "level_timer_tick": math.floor(x) + 1,
                              "duration_ticks": fist(t["params"]["Duration"] * 30)})
    sounds = [{"id": t["id"], "name": t["name"], "condition": t["params"]["Condition"], "sound": t["params"]["SoundDef"],
               "simple": t["params"]["Simple"], "one_shot": t["params"]["OneShot"],
               "relative": t["params"]["Relative to microphone"]}
              for t in tasks if t["type"] == "ConditionalSound"]
    exprs = []
    for t in tasks:
        for f in EXPRESSION_FIELDS.get(t["type"], []):
            v = t["params"].get(f)
            if isinstance(v, str) and v.strip():
                exprs.append({"task": f"{t['type']}_{t['id']}", "order": t["order"], "field": f, "text": v})
    order = [{"order": t["order"], "task": f"{t['type']}_{t['id']}", "name": t["name"], "depth": len(ancestors(t))}
             for t in tasks if t["type"] in EXPRESSION_FIELDS or t["type"] in ("AreaActivate", "Container", "Dynamic", "Static")]
    return {"source": f"{LEVEL}/objects.qvm (tools/level_tasks.py)", "tasks": len(tasks), "inventory": inventory,
            "members": MEMBERS, "expressions": exprs, "update_order": order, "cut_scenes": cuts,
            "subtitles": subtitles, "conditional_sounds": sounds, "cutscene_actors": cutscene_actors(root, tasks),
            "anim_tasks": [{"id": t["id"], "target": t["params"]["TargetID"], "run": t["params"]["Run"].strip(),
                            "records": anim_records(t["params"]["AnimData"])} for t in tasks if t["type"] == "AnimTask"]}, tasks


def simulate(tasks, ticks, **hooks):
    log = []
    rt = Runtime(tasks, log=log, **hooks)
    for _ in range(ticks):
        if rt.complete:
            break
        rt.tick()
    return rt, log


def self_checks(model, tasks):
    errors = []

    def check(cond, msg):
        if not cond:
            errors.append(msg)
    check(model["tasks"] == 1362, "task count")
    check(len(model["inventory"]) == 59, "type count")
    fin = {c["id"]: c["finish_tick"] for c in model["cut_scenes"]}
    check(fin == {1200: 559, 1201: 67, 1202: 2132, 1203: 163, 1204: 751}, f"cut-scene finish ticks {fin}")
    subs = [s["level_timer_tick"] for s in sorted(model["subtitles"], key=lambda s: s["level_timer_tick"])]
    # 24.7 and 59.8 x GAME_FREQUENCY chop to 740.999.. / 1793.999.. -> sent on ticks 741 / 1794.
    check(subs == [2, 361, 481, 741, 811, 931, 991, 1261, 1591, 1666, 1711, 1794, 1981, 2251, 2326, 2611], f"subtitle ticks {subs}")
    # Intro with no input.
    rt, log = simulate(tasks, 2930)
    ev = {(a, b, c) for a, b, c in log}
    for item in [(1, "cut start", 1200), (560, "cut finished", 1200), (560, "cut start", 1201), (627, "cut start", 1202),
                 (2759, "cut start", 1203), (2922, "cut finished", 1203), (2923, "add", 1495), (2924, "remove", 4001),
                 (1, "call", "MenuManager_SetEnabled(0)"), (2923, "call", "MenuManager_SetEnabled(1)"),
                 (2923, "call", "StatusMessageScreen_ClearMessages()"), (1, "snd start", "_cut01_01")]:
        check(item in ev, f"intro event {item}")
    msg_ticks = [a for a, b, c in log if b == "msg" and c.startswith("M1_CUT")]
    check(msg_ticks == subs, f"runtime subtitle ticks {msg_ticks}")
    # Esc on tick 101.
    rt2 = Runtime(tasks, escape=lambda: rt2.level_tick + 1 == 101)
    for _ in range(105):
        rt2.tick()
    check((101, "add", 1495) in {(a, b, c) for a, b, c in rt2.log}, "skip: player container added on the Esc tick")
    # Truck area after the intro -> outro -> complete.
    truck = [24956964, -56099004, 174417760]
    rt3 = Runtime(tasks, humans=lambda: [(truck, 0)] if rt3.level_tick + 1 >= 3001 else [])
    for _ in range(4000):
        if rt3.complete:
            break
        rt3.tick()
    l3 = {(a, b, c) for a, b, c in rt3.log}
    check((3001, "cut start", 1204) in l3 and (3752, "cut finished", 1204) in l3, "outro 1204 runs 3001..3752")
    check(rt3.complete and rt3.level_tick == 3752, f"mission complete at {rt3.level_tick}")
    check(rt3.objectives and rt3.objectives[0]["complete"] == 1, "objective 1 complete")
    # Player dead -> failed on the same tick.
    rt4 = Runtime(tasks, external=lambda n: int(rt4.level_tick + 1 >= 3001) if n == "HumanPlayer_0.isDead" else None)
    for _ in range(3002):
        rt4.tick()
    check((3001, "msg", "MISSION_FAILED") in {(a, b, c) for a, b, c in rt4.log}, "MISSION_FAILED at 3001")
    check(rt4.member("LevelFlow_10.isFailed") == 1, "LevelFlow failed")
    # Camera sighting -> alarm.
    rt5 = Runtime(tasks, sighting=lambda cid: "player" if cid == 1301 and rt5.level_tick + 1 >= 3001 else None)
    for _ in range(3100):
        rt5.tick()
    check((3092, "msg", "M1_MSG_5") in {(a, b, c) for a, b, c in rt5.log}, "alarm message at 3092")
    return errors


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--root", default="Game Files")
    ap.add_argument("--json", type=Path)
    ap.add_argument("--timeline", action="store_true")
    args = ap.parse_args()
    model, tasks = build_model(args.root)
    print(f"{model['source']}: {model['tasks']} tasks, {len(model['inventory'])} types, "
          f"{len(model['expressions'])} conditions")
    for c in model["cut_scenes"]:
        print(f"CutScene_{c['id']} {c['name']!r}: {len(c['keys'])} keys, total {c['total']:.6f} s, finishes at nTick {c['finish_tick']}")
    for a in model["cutscene_actors"]:
        print(f"  actor HumanAI_{a['ai']} ({a['soldier_name'] or 'soldier'} {a['model']}, on {a['parent']}): "
              f"{a['idle_action']}({a['arg']})" + (f" when {a['condition']}" if a["condition"] else "")
              + (" [invulnerable]" if a["invulnerable"] else ""))
    if args.timeline:
        rt, log = simulate(tasks, 2930)
        for tick, kind, what in log:
            print(f"  intro tick {tick:5d}  {kind:13s} {what}")
    if args.json:
        args.json.write_text(json.dumps(model, indent=1, default=str))
        print(f"wrote {args.json}")
    errors = self_checks(model, tasks)
    print("self-checks:", "all passed" if not errors else f"{len(errors)} FAILED")
    for e in errors:
        print("  FAIL", e)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
