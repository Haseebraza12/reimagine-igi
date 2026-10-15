"""LOOP v8 QVM reference disassembler, interpreter and whole-install validator.

Python reference for web-port/src/loaders/qvm-vm.ts; stdlib only. Run from
the repository root:

    python tools/igi_qvm_vm.py                       # validate every .qvm
    python tools/igi_qvm_vm.py --disassemble FILE    # full listing
    python tools/igi_qvm_vm.py --run FILE --event AIEVENT_CREATE
                                                     # host-call trace

Evidence labels used below (see docs/qvm-vm.md for the full write-up):
  recovered = read from igi.exe code (function addresses cited),
  observed  = measured from the shipped files with this tool,
  inferred  = reasoning without direct proof.

Interpreter (recovered): FUN_004b3290 resets the program (pc=0, empty
stacks) and FUN_004b31f0 dispatches `table[0x00a3be48 + op*0x18]` until a
BRK sets the halt flag or a handler sets an error code; the handlers are
registered by FUN_004b3640. Two parallel stacks: a type stack (1 int,
2 float, 3 string, 4 identifier text, 5 address, 6 symbol pointer,
7 data block) and a data stack of 32-bit words; strings are stored inline.
CALL (FUN_004b3a90) does NOT evaluate arguments: it passes the host
handler {argc, offsets}; the handler pulls each argument through
Script_GetArgInt/Float/String (FUN_004aec60/4aec90/4aecc0 ->
FUN_004b2d00), which runs the VM from that argument's offset until BRK and
pops the result converted to the requested type.
"""
import argparse
import collections
from fractions import Fraction
import json
import math
from pathlib import Path
import struct
import sys

# --------------------------------------------------------------------------
# Opcode table (recovered: mnemonic strings at 0x545a28..0x545b40 indexed by
# the disassembler switch FUN_004b4ec0; handlers registered by FUN_004b3640;
# operand encodings from the handlers and the assembler FUN_004b6c50).
# operand kinds: none, i8, i16, i32, f32, str (inline NUL-terminated),
#                lit8/lit16/lit32 (literal-table index), sym8/sym16/sym32
#                (symbol-table index), rel32 (branch), call, blk
# --------------------------------------------------------------------------
OPCODES = [
    # (mnemonic, operand, handler address)
    ("BRK", "none", 0x4B4E90),       # 00 set halt flag (+0x2c)
    ("NOP", "none", 0x4B4E80),       # 01 pc += 1
    ("PUSH", "i32", 0x4B4B00),       # 02 push int
    ("PUSHB", "i8", 0x4B4A80),       # 03 push sign-extended byte
    ("PUSHW", "i16", 0x4B4AC0),      # 04 push sign-extended short
    ("PUSHF", "f32", 0x4B4BB0),      # 05 push float
    ("PUSHA", "i32", 0x4B4B00),      # 06 push address (type 5)
    ("PUSHS", "str", 0x4B4BE0),      # 07 push inline string (type 3)
    ("PUSHSI", "lit32", 0x4B4C40),   # 08 push literal-table string
    ("PUSHSIB", "lit8", 0x4B4C40),   # 09
    ("PUSHSIW", "lit16", 0x4B4C40),  # 0a
    ("PUSHI", "str", 0x4B4BE0),      # 0b push inline identifier (type 4)
    ("PUSHII", "sym32", 0x4B4C40),   # 0c push symbol-table identifier (type 6)
    ("PUSHIIB", "sym8", 0x4B4C40),   # 0d
    ("PUSHIIW", "sym16", 0x4B4C40),  # 0e
    ("PUSH0", "none", 0x4B4A40),     # 0f push int 0
    ("PUSH1", "none", 0x4B4A20),     # 10 push int 1
    ("PUSHM", "none", 0x4B4A60),     # 11 push int -1
    ("POP", "none", 0x4B3A70),       # 12 drop one value
    ("RET", "none", 0x4B4EA0),       # 13 illegal (error 5)
    ("BRA", "rel32", 0x4B3940),      # 14 pc = end + rel
    ("BF", "rel32", 0x4B3940),       # 15 pop; branch if zero
    ("BT", "rel32", 0x4B3940),       # 16 pop; branch if non-zero
    ("JSR", "rel32", 0x4B4EA0),      # 17 illegal (error 5)
    ("CALL", "call", 0x4B3A90),      # 18 host call
    ("ADD", "none", 0x4B3E50), ("SUB", "none", 0x4B3E50),    # 19 1a
    ("MUL", "none", 0x4B3E50), ("DIV", "none", 0x4B3E50),    # 1b 1c
    ("SHL", "none", 0x4B3E50), ("SHR", "none", 0x4B3E50),    # 1d 1e
    ("AND", "none", 0x4B3E50), ("OR", "none", 0x4B3E50),     # 1f 20
    ("XOR", "none", 0x4B3E50), ("LAND", "none", 0x4B3E50),   # 21 22
    ("LOR", "none", 0x4B3E50), ("EQ", "none", 0x4B3E50),     # 23 24
    ("NE", "none", 0x4B3E50), ("LT", "none", 0x4B3E50),      # 25 26
    ("LE", "none", 0x4B3E50), ("GT", "none", 0x4B3E50),      # 27 28
    ("GE", "none", 0x4B3E50),                                # 29
    ("ASSIGN", "none", 0x4B3C70),    # 2a store into a script variable
    ("PLUS", "none", 0x4B48B0),      # 2b unary +
    ("MINUS", "none", 0x4B48B0),     # 2c unary -
    ("INV", "none", 0x4B48B0),       # 2d bitwise not (int only)
    ("NOT", "none", 0x4B48B0),       # 2e logical not (int only)
    ("BLK", "blk", 0x4B4B90),        # 2f skip u32-length inline data block
    ("ILLEGAL", "none", 0x4B4EA0),   # 30 error 5
]
OP = {name: code for code, (name, _, _) in enumerate(OPCODES)}

# VM error codes (recovered: FUN_004b3290 message switch)
ERRORS = {1: "Stack underflow", 2: "Stack overflow", 3: "Internal error (read: BUG!!!)",
          5: "Illegal instruction", 6: "Illegal operand(s) for instruction",
          7: "Unknown identifier", 8: "Identifier not a variable",
          9: "Identifier not a function", 10: "No function on stack", 11: "Syntax error",
          12: "Undefined error", 13: "Function argument overflow", 14: "Datablock not present",
          15: "Index out of range"}

# --------------------------------------------------------------------------
# Symbol constants (recovered registration tables)
# --------------------------------------------------------------------------
AIEVENTS = ["CREATE", "DELETE", "DEAD", "ANIMATION", "IDLE", "ALERT", "ALERT_RESPONSE",
            "COMBAT", "ALARMON", "ALARMOFF", "WALK", "GROUNDIMPACT", "DOOR", "FENCE",
            "LADDER", "TAKINGDAMAGE", "GUNSHOT", "GRENADETHROWN", "GRENADELAND",
            "FLASHBANG", "GUNSHOTMISS", "EXPLOSION", "ENEMYDETECTION", "FRIENDLYDETECTION"]
AITYPES = ["RPG", "GUNNER", "SNIPER", "ANYA", "EKK", "PRIBOI", "CIVILIAN", "PATROL_UZI",
           "PATROL_AK", "PATROL_SPAS", "PATROL_PISTOL", "GUARD_UZI", "GUARD_AK", "GUARD_SPAS",
           "GUARD_PISTOL", "SECURITY_PATROL_UZI", "SECURITY_PATROL_SPAS", "MAFIA_PATROL_UZI",
           "MAFIA_PATROL_AK", "MAFIA_PATROL_SPAS", "MAFIA_GUARD_UZI", "MAFIA_GUARD_AK",
           "MAFIA_GUARD_SPAS", "SPETNAZ_PATROL_UZI", "SPETNAZ_PATROL_AK", "SPETNAZ_PATROL_SPAS",
           "SPETNAZ_GUARD_UZI", "SPETNAZ_GUARD_AK", "SPETNAZ_GUARD_SPAS"]
CONSTANTS = {}
# FUN_004aed60 (script system init)
CONSTANTS.update({"TRUE": ("i", 1), "ON": ("i", 1), "FALSE": ("i", 0), "OFF": ("i", 0),
                  "SCRIPT_WARNINGLEVEL_NO_WARNINGS": ("i", 0),
                  "SCRIPT_WARNINGLEVEL_NORMAL": ("i", 1),
                  "SCRIPT_WARNINGLEVEL_HIGH": ("i", 2)})
# FUN_0044dd00 (HumanAI constants)
CONSTANTS.update({"AIEVENT_" + n: ("i", i) for i, n in enumerate(AIEVENTS)})
CONSTANTS.update({"AITYPE_" + n: ("i", i) for i, n in enumerate(AITYPES)})
CONSTANTS.update({"AIACTIONFLAG_NONE": ("i", 0), "AIACTIONFLAG_PUSHABLE": ("i", 1),
                  "HUMANAI_DETECTIONEVENT_GUNSHOT_RANGE": ("i", 0x1E000),
                  "HUMANAI_DETECTIONEVENT_GUNSHOT_SILENCED_RANGE": ("i", 0x1000),
                  "AIALARMACCESS_BEFORECOMBAT": ("i", 0), "AIALARMACCESS_AFTERCOMBAT": ("i", 1)})
# FUN_004148b0 (Level module): GAME_FREQUENCY int constant; WORLD_METER and
# MATH_PI are double *variables* (FUN_004aeab0) at 0x537440 / 0x537438.
CONSTANTS.update({"GAME_FREQUENCY": ("i", 30), "WORLD_METER": ("f", 4096.0),
                  "MATH_PI": ("f", 3.1415926535897944)})
# FUN_0041ab20 (mission list)
CONSTANTS["MISSION_NEXT_MISSION_UNDEFINED"] = ("i", -1)

# AITYPE -> common script (recovered: table 0x53a8fc indexes paths 0x53a8d8)
AITYPE_SCRIPT = ["rpg", "gunner", "sniper", "anya", "ekk", "priboi", "civilian"] + \
    ["patrol"] * 4 + ["guard"] * 4 + ["patrol"] * 5 + ["guard"] * 3 + ["patrol"] * 3 + ["guard"] * 3

# Host functions registered by FUN_0044bae0 (HumanAI) with the arity the
# compiler enforces and the native return type (void/int/float).
AI_FUNCTIONS = {
    "AIAction_Patrol": (3, "void", 0x44BF20), "AIAction_Combat": (1, "void", 0x44BFA0),
    "AIAction_Dead": (1, "void", 0x44C0A0), "AIAction_FallFlat": (2, "void", 0x44C100),
    "AIAction_Activate": (3, "void", 0x44C260), "AIAction_WalkToNode": (2, "void", 0x44C2E0),
    "AIAction_RunToNode": (2, "void", 0x44C350), "AIAction_FireAtNode": (5, "void", 0x44C3C0),
    "AIAction_FireAtTask": (5, "void", 0x44C470), "AIAction_PlayAnimation": (2, "void", 0x44C520),
    "AIAction_PlaySound": (3, "void", 0x44C590), "AIAction_MoveToEvent": (2, "void", 0x44C610),
    "AIAction_LookAtEvent": (2, "void", 0x44C6B0), "AIAction_Stunned": (2, "void", 0x44C730),
    "AIAction_KickGrenade": (1, "void", 0x44C7A0), "AIAction_RunPanicking": (2, "void", 0x44C840),
    "AIAction_Idle": (1, "void", 0x44C8C0), "AIAction_SetCombat": (1, "void", 0x44C920),
    "AIFunction_DefaultHandler": (0, "void", 0x44CEA0),
    "AIFunction_RemoveAlarmActions": (0, "void", 0x44CA00),
    "AIFunction_SetViewLength": (1, "void", 0x44CA80),
    "AIFunction_SetAlarmViewLength": (1, "void", 0x44CB10),
    "AIFunction_SetViewAlpha": (1, "void", 0x44CB70),
    "AIFunction_SetViewGamma": (1, "void", 0x44CBD0),
    "AIFunction_SetSecondaryViewLength": (1, "void", 0x44CC30),
    "AIFunction_SetSecondaryAlarmViewLength": (1, "void", 0x44CCC0),
    "AIFunction_SetSecondaryViewAlpha": (1, "void", 0x44CD20),
    "AIFunction_SetSecondaryViewGamma": (1, "void", 0x44CD80),
    "AIFunction_SetEventPriority": (1, "void", 0x44CF00),
    "AIFunction_SetInvulnerability": (1, "void", 0x44CF90),
    "AIFunction_SetInstantDeath": (1, "void", 0x44CFF0),
    "AIFunction_SetDeathAnimation": (1, "void", 0x44D050),
    "AIFunction_SetAlarmTriggerID": (1, "void", 0x44D0B0),
    "AIFunction_SetAlarmControlID": (1, "void", 0x44D110),
    "AIFunction_SetAlarmAccess": (1, "void", 0x44D170),
    "AIFunction_SetGunnerID": (1, "void", 0x44D1D0),
    "AIFunction_SetScriptIntegerValue": (2, "void", 0x44D510),
    "AIFunction_SetScriptRealValue": (2, "void", 0x44D5D0),
    "AIFunction_GetAlarmTriggerID": (0, "int", 0x44D230),
    "AIFunction_GetAlarmControlID": (0, "int", 0x44D270),
    "AIFunction_GetAlarmAccess": (0, "int", 0x44D2B0),
    "AIFunction_GetGunnerID": (0, "int", 0x44D2F0),
    "AIFunction_GetAlarmControlStatus": (0, "int", 0x44D330),
    "AIFunction_GetGunnerStatus": (0, "int", 0x44D420),
    "AIFunction_GetScriptIntegerValue": (1, "int", 0x44D580),
    "AIFunction_GetCurrentEventType": (0, "int", 0x44CDE0),
    "AIFunction_IsEventBehind": (0, "int", 0x44D6A0),
    "AIFunction_GetScriptRealValue": (1, "float", 0x44D640),
    "AIFunction_GetRandomValue": (1, "float", 0x44CE40),
    "AIFunction_GetEventDistance": (0, "float", 0x44D770),
    "AIFunction_GetAlarmTriggerDistance": (0, "float", 0x44D7F0),
    "AIFunction_SetAnimationInterval": (2, "void", 0x44D930),
    "AIFunction_AddAnimationEntry": (2, "void", 0x44D9F0),
    "AIFunction_GetAnimationToPlay": (0, "int", 0x44DAF0),
    "AIFunction_SendResponse": (0, "void", 0x44DC90),
}
OTHER_FUNCTIONS = {
    # name: (arity or -1 = variadic, return, handler)
    "_Script_SetWarningLevel": (1, "void", 0x4AEEA0), "BreakScript": (0, "void", 0x4AEE50),
    "DefineMission": (-1, "void", 0x41AB50), "Task_New": (-1, "void", 0x4E7420),
    "Task_DeclareParameters": (-1, "void", 0x4E73E0), "DefineGroup": (-1, "void", 0x4E2610),
    "DefineSound": (-1, "void", 0x4DF830), "DefineGraph": (-1, "void", 0x4E18C0),
    "DefineTriggerOnce": (-1, "void", 0x4E0AB0), "Game_SetMission": (1, "void", 0x414BA0),
    "Game_UpdateVolume": (0, "void", 0x414BF0), "Game_DisablePlayerInput": (0, "void", 0x414AE0),
    "Game_EnablePlayerInput": (0, "void", 0x414B40),
}
FUNCTIONS = dict(AI_FUNCTIONS, **OTHER_FUNCTIONS)


class QvmError(Exception):
    """Malformed program or VM fault; message names the code offset."""


# --------------------------------------------------------------------------
# Numeric helpers matching the native types
# --------------------------------------------------------------------------
def i32(value):
    return ((int(value) + 0x80000000) & 0xFFFFFFFF) - 0x80000000


def f32(value):
    try:
        return struct.unpack("<f", struct.pack("<f", value))[0]
    except OverflowError:
        return math.copysign(math.inf, value)


def fist(value):
    """x87 FISTP QWORD + low dword, as igi.exe runs it: the FPU is in chop mode
    (FUN_004966d0, checked every frame at 0x48dbc1; docs/gameplay.md "FPU
    rounding mode"), so the value is truncated toward zero and wrapped to
    int32. NaN, +-inf and |x| >= 2^63 give the integer indefinite, whose low
    dword is 0."""
    if not math.isfinite(value) or abs(value) >= 2.0 ** 63:
        return 0
    return i32(int(value))


FLT_MAX = 3.4028234663852886e38


def f32_chop(value):
    """FSTP DWORD in chop mode: the float32 nearest the exact `value` (int,
    float or Fraction) toward zero. Used for VM float ops (fld; f<op> DWORD;
    fstp DWORD, 0x4b41ad..) and int -> float (fild; fstp DWORD, 0x4b3106)."""
    x = Fraction(value)
    if x == 0:
        return 0.0
    if abs(x) > FLT_MAX:
        return math.copysign(FLT_MAX, x)
    d = f32(float(x))
    if abs(Fraction(d)) > abs(x):  # one float32 step toward zero
        bits = struct.unpack("<I", struct.pack("<f", d))[0] - 1
        d = struct.unpack("<f", struct.pack("<I", bits))[0]
    return d


# --------------------------------------------------------------------------
# Program loading (recovered: FUN_004b3430)
# --------------------------------------------------------------------------
class Program:
    def __init__(self, data, name="<qvm>"):
        self.name = name
        if len(data) < 0x3C:
            raise QvmError(f"{name}: file shorter than the 60-byte header")
        if data[:4] != b"LOOP" or struct.unpack_from("<i", data, 4)[0] != 8:
            raise QvmError(f"{name}: expected LOOP version 8")
        h = struct.unpack_from("<15I", data, 0)
        self.minor = h[2]
        if not self.minor > 4:  # FUN_004b3430: `if (4 < *(int*)(file+8))`
            raise QvmError(f"{name}: header +8 = {self.minor}, the exe requires > 4")
        self.symbols = self._table(data, h[3], h[4], h[5], h[6], "symbol")
        self.literals = self._table(data, h[7], h[8], h[9], h[10], "literal")
        code, size = h[11], h[12]
        if code + size != len(data):
            raise QvmError(f"{name}: bytecode does not end at end of file")
        self.code = data[code:code + size]
        self.code_file_offset = code
        # header +0x34 data-stack bytes (0 -> 0x800), +0x38 type-stack entries (0 -> 0x100)
        self.data_stack_words = ((h[13] or 0x800) + 3) >> 2
        self.type_stack_entries = h[14] or 0x100
        self.instructions = self._decode_all()

    @staticmethod
    def _table(data, table, pool, table_bytes, pool_bytes, what):
        if table_bytes % 4 or table + table_bytes > len(data) or pool + pool_bytes > len(data):
            raise QvmError(f"invalid {what} table bounds")
        out = []
        for pos in range(table, table + table_bytes, 4):
            rel = struct.unpack_from("<I", data, pos)[0]
            end = data.find(b"\0", pool + rel, pool + pool_bytes)
            if rel >= pool_bytes or end < 0:
                raise QvmError(f"{what} string at table 0x{pos:x} outside its pool")
            out.append(data[pool + rel:end].decode("latin1"))
        return out

    def decode(self, pc):
        code = self.code
        if not 0 <= pc < len(code):
            raise QvmError(f"{self.name}: pc 0x{pc:x} outside code")
        op = code[pc]
        if op >= len(OPCODES):
            raise QvmError(f"{self.name}: unknown opcode 0x{op:02x} at code 0x{pc:x}")
        name, kind, _ = OPCODES[op]

        def need(n):
            if pc + 1 + n > len(code):
                raise QvmError(f"{self.name}: truncated {name} at code 0x{pc:x}")

        ins = {"pc": pc, "op": op, "name": name}
        if kind == "none":
            size = 1
        elif kind in ("i8", "i16", "i32", "f32", "lit8", "lit16", "lit32",
                      "sym8", "sym16", "sym32", "rel32"):
            fmt = {"i8": "<b", "i16": "<h", "i32": "<i", "f32": "<f", "lit8": "<B",
                   "lit16": "<H", "lit32": "<I", "sym8": "<B", "sym16": "<H", "sym32": "<I",
                   "rel32": "<i"}[kind]
            n = struct.calcsize(fmt)
            need(n)
            value = struct.unpack_from(fmt, code, pc + 1)[0]
            size = 1 + n
            if kind.startswith("lit"):
                if value >= len(self.literals):
                    raise QvmError(f"{self.name}: literal {value} outside table at code 0x{pc:x}")
                ins["value"] = self.literals[value]
            elif kind.startswith("sym"):
                if value >= len(self.symbols):
                    raise QvmError(f"{self.name}: symbol {value} outside table at code 0x{pc:x}")
                ins["value"] = self.symbols[value]
            elif kind == "rel32":
                ins["target"] = pc + 5 + value
            else:
                ins["value"] = value
            ins["index"] = value if kind[:3] in ("lit", "sym") else None
        elif kind == "str":
            end = code.find(b"\0", pc + 1)
            if end < 0:
                raise QvmError(f"{self.name}: unterminated inline string at code 0x{pc:x}")
            ins["value"] = code[pc + 1:end].decode("latin1")
            size = end + 1 - pc
        elif kind == "call":
            need(4)
            count = struct.unpack_from("<I", code, pc + 1)[0]
            size = 5 + 4 * count
            if pc + size > len(code):
                raise QvmError(f"{self.name}: CALL table exceeds code at 0x{pc:x}")
            ins["args"] = list(struct.unpack_from(f"<{count}I", code, pc + 5))
        elif kind == "blk":
            need(4)
            size = 5 + struct.unpack_from("<I", code, pc + 1)[0]
            if pc + size > len(code):
                raise QvmError(f"{self.name}: BLK exceeds code at 0x{pc:x}")
        ins["size"] = size
        return ins

    def _decode_all(self):
        out = {}
        pc = 0
        while pc < len(self.code):
            ins = self.decode(pc)
            out[pc] = ins
            pc += ins["size"]
        if not out or out[max(out)]["op"] != OP["BRK"]:
            raise QvmError(f"{self.name}: code does not end with BRK")
        for ins in out.values():
            for target in ([ins["target"]] if "target" in ins else []) + ins.get("args", []):
                if target not in out:
                    raise QvmError(f"{self.name}: target 0x{target:x} of {ins['name']} at code "
                                   f"0x{ins['pc']:x} is not an instruction boundary")
        return out

    def check_call_layout(self):
        """Every CALL must sit in `PUSHII fn; CALL offs; BRA end; arg*; end:`
        with the argument blocks partitioning [after BRA, end) and each block
        ending in BRK (observed on all shipped files; the compiler emits it)."""
        order = sorted(self.instructions)
        index = {pc: i for i, pc in enumerate(order)}
        for pc in order:
            ins = self.instructions[pc]
            if ins["op"] != OP["CALL"]:
                continue
            i = index[pc]
            prev = self.instructions[order[i - 1]] if i else None
            if prev is None or prev["op"] not in (OP["PUSHII"], OP["PUSHIIB"], OP["PUSHIIW"], OP["PUSHI"]):
                raise QvmError(f"{self.name}: CALL at 0x{pc:x} not preceded by an identifier push")
            bra = self.instructions.get(pc + ins["size"])
            if bra is None or bra["op"] != OP["BRA"]:
                raise QvmError(f"{self.name}: CALL at 0x{pc:x} not followed by BRA")
            start, end = bra["pc"] + bra["size"], bra["target"]
            args = ins["args"]
            bounds = args + [end]
            if (args and args[0] != start) or (not args and start != end) or \
                    any(a >= b for a, b in zip(bounds, bounds[1:])):
                raise QvmError(f"{self.name}: CALL at 0x{pc:x} arguments do not partition its block")
            for a, b in zip(args, args[1:] + [end]):
                last = self.instructions[order[index[b] - 1]] if b in index else None
                if last is None or last["op"] != OP["BRK"]:
                    raise QvmError(f"{self.name}: argument at 0x{a:x} does not end with BRK")


# --------------------------------------------------------------------------
# Interpreter
# --------------------------------------------------------------------------
class CallContext:
    """What a native handler sees (the args struct of FUN_004b3a90):
    argument count plus lazy, typed accessors (FUN_004aec60/4aec90/4aecc0)."""

    def __init__(self, vm, name, offsets, pc):
        self.vm, self.name, self.offsets, self.pc = vm, name, offsets, pc

    @property
    def argc(self):
        return len(self.offsets)

    def arg(self, i):
        """Run argument i's code and return its raw value (symbols resolved)."""
        return self.vm.eval_arg(self.offsets[i])

    def arg_int(self, i):  # FUN_004b2cd0: FUN_004b30e0 -> int, float truncated (fistp, chop mode), else 0
        v = self.arg(i)
        return v[1] if v[0] == "i" else fist(v[1]) if v[0] == "f" else 0

    def arg_float(self, i):  # FUN_004b3230 (an int goes through fild + fstp DWORD: chopped)
        v = self.arg(i)
        return f32_chop(v[1]) if v[0] == "i" else f32(v[1]) if v[0] == "f" else 0.0

    def arg_string(self, i, size=0x100):  # FUN_004b3260: strncpy(buf, s, size-1)
        v = self.arg(i)
        return v[1][:size - 1] if v[0] == "s" else ""


class VM:
    def __init__(self, program, host, max_steps=1_000_000):
        self.p, self.host, self.max_steps = program, host, max_steps
        self.stack = []      # entries: ("i", int) ("f", float) ("s", str) ("sym", name) ("a", int)
        self.words = 0       # data-stack words in use (strings take 1 + ceil((len+1)/4))
        self.steps = 0
        self.depth = 0

    # -- stack -------------------------------------------------------------
    @staticmethod
    def _words(v):
        return 1 + (len(v[1]) + 4) // 4 if v[0] == "s" else 1

    def push(self, v, pc):
        w = self._words(v)
        if len(self.stack) >= self.p.type_stack_entries or self.words + w > self.p.data_stack_words:
            raise QvmError(f"{self.p.name}: stack overflow at code 0x{pc:x}")
        self.stack.append(v)
        self.words += w

    def pop_raw(self, pc):
        if not self.stack:
            raise QvmError(f"{self.p.name}: stack underflow at code 0x{pc:x}")
        v = self.stack.pop()
        self.words -= self._words(v)
        return v

    def resolve(self, v, pc):
        """Symbol on the stack -> its value via the getter (FUN_004b30e0 /
        FUN_004b2e20 call symbol+0x10 for kinds 0 variable and 2 constant)."""
        if v[0] != "sym":
            return v
        value = None
        getter = getattr(self.host, "value", None)
        if getter is not None:
            value = getter(v[1])
        if value is None:
            value = CONSTANTS.get(v[1])
        if value is None:
            raise QvmError(f"{self.p.name}: unknown identifier {v[1]!r} used as a value at code 0x{pc:x}")
        return value

    def pop_value(self, pc):
        return self.resolve(self.pop_raw(pc), pc)

    # -- execution -----------------------------------------------------------
    def run(self, pc=0):
        """FUN_004b31f0: dispatch until BRK. Returns the pc of that BRK."""
        code = self.p.instructions
        while True:
            self.steps += 1
            if self.steps > self.max_steps:
                raise QvmError(f"{self.p.name}: step limit exceeded at code 0x{pc:x}")
            ins = code.get(pc)
            if ins is None:
                raise QvmError(f"{self.p.name}: pc 0x{pc:x} is not an instruction")
            op, nxt = ins["op"], pc + ins["size"]
            name = ins["name"]
            if op == 0x00:
                return pc
            elif op == 0x01 or op == 0x2F:
                pass
            elif op in (0x02, 0x03, 0x04):
                self.push(("i", ins["value"]), pc)
            elif op == 0x05:
                self.push(("f", ins["value"]), pc)
            elif op == 0x06:
                self.push(("a", ins["value"]), pc)
            elif op in (0x07, 0x08, 0x09, 0x0A):
                self.push(("s", ins["value"]), pc)
            elif op in (0x0B, 0x0C, 0x0D, 0x0E):
                has = getattr(self.host, "has", None)
                if has is not None and not has(ins["value"]) and ins["value"] not in CONSTANTS:
                    raise QvmError(f"{self.p.name}: unknown identifier {ins['value']!r} at code 0x{pc:x}")
                self.push(("sym", ins["value"]), pc)
            elif op in (0x0F, 0x10, 0x11):
                self.push(("i", {0x0F: 0, 0x10: 1, 0x11: -1}[op]), pc)
            elif op == 0x12:
                self.pop_raw(pc)
            elif op == 0x14:
                nxt = ins["target"]
            elif op in (0x15, 0x16):
                v = self.pop_value(pc)
                if v[0] not in ("i", "f"):
                    raise QvmError(f"{self.p.name}: {name} on a non-number at code 0x{pc:x}")
                if (v[1] == 0) == (op == 0x15):
                    nxt = ins["target"]
            elif op == 0x18:
                self.call(ins, pc)
            elif 0x19 <= op <= 0x29:
                self.binary(op, pc)
            elif op == 0x2A:
                value = self.pop_value(pc)
                target = self.pop_raw(pc)
                assign = getattr(self.host, "assign", None)
                if target[0] != "sym" or assign is None:
                    raise QvmError(f"{self.p.name}: ASSIGN target is not a variable at code 0x{pc:x}")
                self.push(assign(target[1], value), pc)
            elif 0x2B <= op <= 0x2E:
                v = self.pop_value(pc)
                if v[0] == "i":
                    r = {0x2B: v[1], 0x2C: i32(-v[1]), 0x2D: i32(~v[1]), 0x2E: int(v[1] == 0)}[op]
                    self.push(("i", r), pc)
                elif v[0] == "f" and op in (0x2B, 0x2C):
                    self.push(("f", v[1] if op == 0x2B else -v[1]), pc)
                else:
                    raise QvmError(f"{self.p.name}: {name} on {v[0]} operand at code 0x{pc:x}")
            else:  # 13 RET, 17 JSR, 30 ILLEGAL -> error 5 (FUN_004b4ea0)
                raise QvmError(f"{self.p.name}: illegal instruction {name} at code 0x{pc:x}")
            pc = nxt

    def binary(self, op, pc):
        """FUN_004b3e50: pop B (top) then A; numeric if both numeric (float if
        either is float), else both must be strings."""
        b = self.pop_value(pc)
        a = self.pop_value(pc)
        name = OPCODES[op][0]
        if a[0] in ("i", "f") and b[0] in ("i", "f"):
            if a[0] == "i" and b[0] == "i":
                x, y = a[1], b[1]
                if op == 0x1C and (y == 0 or (x == -0x80000000 and y == -1)):
                    raise QvmError(f"{self.p.name}: integer divide fault at code 0x{pc:x}")
                r = {0x19: lambda: x + y, 0x1A: lambda: x - y, 0x1B: lambda: x * y,
                     0x1C: lambda: (abs(x) // abs(y)) * (-1 if (x < 0) != (y < 0) else 1),
                     0x1D: lambda: x << (y & 31), 0x1E: lambda: x >> (y & 31),
                     0x1F: lambda: x & y, 0x20: lambda: x | y, 0x21: lambda: x ^ y,
                     0x22: lambda: int(x != 0 and y != 0), 0x23: lambda: int(x != 0 or y != 0),
                     0x24: lambda: int(x == y), 0x25: lambda: int(x != y), 0x26: lambda: int(x < y),
                     0x27: lambda: int(x <= y), 0x28: lambda: int(x > y), 0x29: lambda: int(x >= y)}[op]()
                self.push(("i", i32(r)), pc)
                return
            # Operands popped as float32 (FUN_004b30e0: an int via fild + fstp DWORD,
            # chopped); each op is fld; f<op> DWORD; fstp DWORD in chop mode, so the
            # result is the exact value truncated to float32.
            x, y = (f32_chop(v[1]) if v[0] == "i" else f32(v[1]) for v in (a, b))
            if 0x1D <= op <= 0x21:
                raise QvmError(f"{self.p.name}: {name} on float operands at code 0x{pc:x}")
            if op <= 0x1C:
                if not (math.isfinite(x) and math.isfinite(y)) or (op == 0x1C and not y):
                    if op == 0x1C:
                        r = x / y if y else (math.copysign(math.inf, x) * math.copysign(1, y) if x else math.nan)
                    else:
                        r = {0x19: lambda: x + y, 0x1A: lambda: x - y, 0x1B: lambda: x * y}[op]()
                    self.push(("f", f32(r)), pc)
                else:
                    X, Y = Fraction(x), Fraction(y)
                    self.push(("f", f32_chop({0x19: X + Y, 0x1A: X - Y, 0x1B: X * Y, 0x1C: X / Y}[op])), pc)
            else:
                r = {0x22: x != 0 and y != 0, 0x23: x != 0 or y != 0, 0x24: x == y, 0x25: x != y,
                     0x26: x < y, 0x27: x <= y, 0x28: x > y, 0x29: x >= y}[op]
                self.push(("i", int(r)), pc)
            return
        if a[0] == "s" and b[0] == "s":
            if op == 0x19:
                self.push(("s", a[1] + b[1]), pc)
                return
            if 0x24 <= op <= 0x29:
                x, y = a[1].encode("latin1"), b[1].encode("latin1")
                c = (x > y) - (x < y)
                r = {0x24: c == 0, 0x25: c != 0, 0x26: c < 0, 0x27: c <= 0, 0x28: c > 0, 0x29: c >= 0}[op]
                self.push(("i", int(r)), pc)
                return
        raise QvmError(f"{self.p.name}: {name} on {a[0]}/{b[0]} operands at code 0x{pc:x}")

    def eval_arg(self, start):
        """FUN_004b2d00: run from `start` until BRK; the pushed value is the
        argument; stack depth is restored afterwards."""
        depth, words = len(self.stack), self.words
        self.run(start)
        if len(self.stack) <= depth:
            raise QvmError(f"{self.p.name}: argument at code 0x{start:x} pushed no value")
        v = self.pop_value(start)
        del self.stack[depth:]
        self.words = words
        return v

    def call(self, ins, pc):
        fn = self.pop_raw(pc)
        if fn[0] != "sym":
            raise QvmError(f"{self.p.name}: CALL without a function on the stack at code 0x{pc:x}")
        ctx = CallContext(self, fn[1], ins["args"], pc)
        self.depth += 1
        try:
            result = self.host.call(fn[1], ctx)
        finally:
            self.depth -= 1
        # FUN_004b3a90 pushes the handler's result typed by the symbol's return type
        if result is None:
            result = ("i", 0)
        elif isinstance(result, bool) or isinstance(result, int):
            result = ("i", i32(result))
        elif isinstance(result, float):
            ret = FUNCTIONS.get(fn[1], (0, "float"))[1]
            result = ("i", fist(result)) if ret in ("int", "void") else ("f", f32(result))
        elif isinstance(result, str):
            result = ("s", result)
        self.push(result, pc)


def run(program, host, max_steps=1_000_000):
    """FUN_004b3290: one complete execution from pc 0 with empty stacks."""
    vm = VM(program, host, max_steps)
    vm.run(0)
    if vm.stack:
        raise QvmError(f"{program.name}: {len(vm.stack)} value(s) left on the stack")
    return vm


# --------------------------------------------------------------------------
# Recording host for validation / traces
# --------------------------------------------------------------------------
class RecordingHost:
    """Evaluates every argument eagerly, left to right, and records
    (name, [values]). GetCurrentEventType returns `event`; other getters
    return `defaults.get(name, 0)`. Unknown identifiers resolve to 0."""

    def __init__(self, event=None, defaults=None, permissive=True):
        self.event, self.defaults = event, defaults or {}
        self.permissive = permissive
        self.calls = []

    def has(self, name):
        return self.permissive or name in FUNCTIONS or name in CONSTANTS

    def value(self, name):
        if name in CONSTANTS:
            return CONSTANTS[name]
        return ("i", 0) if self.permissive else None

    def call(self, name, ctx):
        args = []
        for i in range(ctx.argc):
            v = ctx.arg(i)
            args.append(v[1])
        self.calls.append((name, args))
        if name == "AIFunction_GetCurrentEventType":
            return self.event if self.event is not None else 0
        return self.defaults.get(name)


# --------------------------------------------------------------------------
# config.qas cross-check (the exe's own assembler listing)
# --------------------------------------------------------------------------
def check_qas(program, text):
    """Rows of the compiler's .qas listing vs the bytecode. The assembler
    (FUN_004b6c50) re-encodes `PUSH n` as PUSH0/PUSH1/PUSHM/PUSHB/PUSHW/PUSH,
    `PUSHF x` as PUSH0/PUSH1/PUSHM (0.0/1.0/-1.0) or PUSHF, and
    `PUSHS`/`PUSHI` as table indices of 1, 2 or 4 bytes."""
    family = {"PUSH": "PUSH", "PUSHB": "PUSH", "PUSHW": "PUSH", "PUSH0": "PUSH",
              "PUSH1": "PUSH", "PUSHM": "PUSH", "PUSHF": "PUSHF", "PUSHSI": "PUSHS",
              "PUSHSIB": "PUSHS", "PUSHSIW": "PUSHS", "PUSHII": "PUSHI", "PUSHIIB": "PUSHI",
              "PUSHIIW": "PUSHI"}
    order = sorted(program.instructions)
    rows, labels = [], {}
    for line in text.splitlines():
        t = line.strip()
        if not t:
            continue
        if t.endswith(":"):
            labels[t[:-1]] = order[len(rows)] if len(rows) < len(order) else len(program.code)
        else:
            parts = t.split(None, 1)
            rows.append((parts[0], parts[1] if len(parts) > 1 else ""))
    if len(rows) != len(order):
        raise QvmError(f"qas has {len(rows)} instructions, bytecode {len(order)}")
    diffs = []
    for (mn, operand), pc in zip(rows, order):
        ins = program.instructions[pc]
        actual = ins["name"]
        fam = family.get(actual, actual)
        if mn == "PUSHF" and actual in ("PUSH0", "PUSH1", "PUSHM"):
            fam = "PUSHF"
        if mn != fam:
            raise QvmError(f"qas row {mn} vs bytecode {actual} at code 0x{pc:x}")
        if mn in ("PUSH", "PUSHF"):
            value = {"PUSH0": 0, "PUSH1": 1, "PUSHM": -1}.get(actual, ins.get("value"))
            if abs(float(operand) - value) > 5e-7:
                diffs.append({"code": pc, "qas": float(operand), "qvm": value})
        elif mn in ("PUSHS", "PUSHI"):
            expected = json.loads(operand) if mn == "PUSHS" else operand
            if expected != ins["value"]:
                raise QvmError(f"qas operand {operand} vs {ins['value']!r} at code 0x{pc:x}")
        elif mn == "CALL":
            names = [n.strip() for n in operand.strip("()").split(",") if n.strip()]
            if [labels[n] for n in names] != ins["args"]:
                raise QvmError(f"qas CALL labels differ at code 0x{pc:x}")
        elif mn == "BRA" and labels[operand] != ins["target"]:
            raise QvmError(f"qas BRA label differs at code 0x{pc:x}")
    return {"instructions": len(rows), "differences": diffs}


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def is_ai_script(path):
    p = path.as_posix().lower()
    return ("/ai/" in p or p.startswith("ai/")) and not p.endswith("settings.qvm")


def validate(root):
    files = sorted(Path(root).rglob("*.qvm"), key=lambda p: p.as_posix().lower())
    usage = collections.Counter()
    summary = {"files": 0, "instructions": 0, "code_bytes": 0, "calls": 0, "branches": 0,
               "executions": 0, "host_calls": 0, "aborted_runs": [], "arity_checked": 0,
               "arity_mismatch": [], "unregistered": collections.Counter()}
    for path in files:
        rel = path.relative_to(root)
        prog = Program(path.read_bytes(), str(rel))
        prog.check_call_layout()
        summary["files"] += 1
        summary["instructions"] += len(prog.instructions)
        summary["code_bytes"] += len(prog.code)
        for ins in prog.instructions.values():
            usage[ins["name"]] += 1
            summary["calls"] += ins["op"] == OP["CALL"]
            summary["branches"] += "target" in ins
        order = sorted(prog.instructions)
        for i, pc in enumerate(order):
            ins = prog.instructions[pc]
            if ins["op"] != OP["CALL"]:
                continue
            fn = prog.instructions[order[i - 1]]["value"]
            arity = FUNCTIONS.get(fn, (-1,))[0]
            if arity >= 0:
                summary["arity_checked"] += 1
                if arity != len(ins["args"]):
                    summary["arity_mismatch"].append(f"{rel} 0x{pc:x} {fn}: {len(ins['args'])} != {arity}")
            if fn not in FUNCTIONS:
                summary["unregistered"][fn] += 1
        events = range(len(AIEVENTS)) if is_ai_script(rel) else [None]
        for event in events:
            host = RecordingHost(event)
            try:
                run(prog, host)
            except QvmError as err:
                summary["aborted_runs"].append(f"{rel} event={event}: {err}")
                continue
            summary["executions"] += 1
            summary["host_calls"] += len(host.calls)
    return summary, usage


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--root", type=Path, default=Path("Game Files"))
    ap.add_argument("--disassemble", type=Path)
    ap.add_argument("--run", type=Path)
    ap.add_argument("--event", default=None, help="AIEVENT_* name or number for --run")
    args = ap.parse_args()
    if args.disassemble:
        prog = Program(args.disassemble.read_bytes(), str(args.disassemble))
        for pc in sorted(prog.instructions):
            ins = prog.instructions[pc]
            operand = ins.get("value", ins.get("target", ins.get("args", "")))
            print(f"{pc:6x}  {ins['name']:<8} {operand!r}" if operand != "" else f"{pc:6x}  {ins['name']}")
        return
    if args.run:
        prog = Program(args.run.read_bytes(), str(args.run))
        event = None
        if args.event is not None:
            event = CONSTANTS[args.event][1] if args.event in CONSTANTS else int(args.event)
        host = RecordingHost(event, permissive=False)
        run(prog, host)
        for name, values in host.calls:
            print(f"{name}({', '.join(map(repr, values))})")
        return
    root = args.root
    if not root.is_dir():
        sys.exit(f"{root} not found; run from the repository root or pass --root")
    summary, usage = validate(root)
    qas = sorted(root.rglob("*.qas"))
    for path in qas:
        prog = Program(path.with_suffix(".qvm").read_bytes(), str(path.with_suffix(".qvm")))
        report = check_qas(prog, path.read_text(encoding="latin1"))
        print(f"qas cross-check {path.relative_to(root)}: {report['instructions']} instructions agree; "
              f"operand differences: {report['differences']}")
    print(f"files: {summary['files']}  instructions: {summary['instructions']}  "
          f"code bytes: {summary['code_bytes']}  CALLs: {summary['calls']}  branches: {summary['branches']}")
    print("decoding: every file decodes completely, ends with BRK, all branch/argument targets on "
          "instruction boundaries, every CALL in PUSHII/CALL/BRA/arg*/end layout")
    print(f"arity: {summary['arity_checked']} calls to functions of known arity checked, "
          f"mismatches: {summary['arity_mismatch'] or 'none'}")
    print("called functions outside this tool's catalogue (registered by other exe modules, "
          "except AIAction_LookAtToEvent which igi.exe never registers): " +
          ", ".join(f"{k} {v}" for k, v in sorted(summary["unregistered"].items())))
    print(f"execution: {summary['executions']} complete runs ({summary['host_calls']} host calls); "
          f"aborted runs: {len(summary['aborted_runs'])}")
    for line in summary["aborted_runs"]:
        print("  aborted:", line)
    print("opcode usage: " + ", ".join(f"{k} {v}" for k, v in usage.most_common()))
    unused = [name for name, _, _ in OPCODES if name not in usage]
    print("never used: " + ", ".join(unused))


if __name__ == "__main__":
    main()
