/**
 * LOOP v8 `.qvm` virtual machine: loader, disassembler and interpreter that
 * executes the original AI, mission, menu and sound scripts with igi.exe's
 * script-VM semantics, plus the string-expression language the exe compiles
 * at run time for task conditions ("AreaActivate_303.nActive && ...").
 *
 * Evidence labels: recovered = read from igi.exe code (addresses cited),
 * observed = measured on the shipped files (tools/igi_qvm_vm.py validates all
 * 118), inferred = reasoning only. Full write-up: docs/qvm-vm.md.
 *
 * Loader (recovered, FUN_004b3430): file >= 0x3c bytes, "LOOP", u32 version 8,
 * u32 at +8 must be > 4 (all shipped files: 5), tables as in qvm.ts, bytecode
 * at +0x2c/+0x30, data-stack bytes at +0x34 (0 -> 0x800), type-stack entries
 * at +0x38 (0 -> 0x100).
 *
 * VM (recovered): FUN_004b3290 starts every run at pc 0 with empty stacks;
 * FUN_004b31f0 dispatches the 49-entry handler table built by FUN_004b3640
 * until BRK sets the halt flag. A type stack (1 int, 2 float, 3 string,
 * 4 identifier text, 5 address, 6 symbol) runs beside a word stack; strings
 * are stored inline. There are no script variables, locals or subroutines in
 * the VM itself (RET/JSR are illegal): all state lives in host symbols.
 *
 * Host calls (recovered): `PUSHII fn; CALL n, off[n]; BRA end; arg blocks;
 * end:`. CALL (FUN_004b3a90) pops the function symbol and invokes its native
 * handler with {argc, offsets}; arguments are NOT evaluated by CALL. The
 * handler pulls argument i through Script_GetArgInt/Float/String
 * (FUN_004aec60 / 4aec90 / 4aecc0 -> FUN_004b2d00), which runs the VM from
 * off[i] until the block's BRK and pops the value converted to the requested
 * type. CALL then resumes after its offset table and pushes the handler's
 * result (int, float or string by the symbol's return type), the BRA skips
 * the argument blocks and a POP (statement) or BRK (nested argument) follows.
 * runQvm evaluates arguments eagerly left to right by default; hosts that
 * need the exe's lazy, context-dependent order (Task_New, DefineGroup set a
 * parent context before evaluating child arguments) return true from
 * lazyArgs(name) and read arguments through the QvmCallContext.
 */

import { x87Add, x87Div, x87F32Add, x87F32Div, x87F32Mul, x87F32Sub, x87Fistp, x87Mul, x87StoreF32, x87Sub } from "./x87";

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** A typed VM value as host functions see it (type-stack tags 1, 2, 3). */
export type QvmRuntimeValue =
  | { readonly type: "int"; readonly value: number }
  | { readonly type: "float"; readonly value: number }
  | { readonly type: "string"; readonly value: string };

/** Internal stack slot: runtime values plus unresolved symbols and PUSHA addresses. */
type Slot =
  | QvmRuntimeValue
  | { readonly type: "symbol"; readonly value: string }
  | { readonly type: "address"; readonly value: number };

export const qvmInt = (value: number): QvmRuntimeValue => ({ type: "int", value: value | 0 });
export const qvmFloat = (value: number): QvmRuntimeValue => ({ type: "float", value: Math.fround(value) });
export const qvmString = (value: string): QvmRuntimeValue => ({ type: "string", value });

/**
 * x87 FISTP as used for every float -> int conversion in the VM (FUN_004b30e0
 * 0x4b3139, FUN_004ae220 0x4ae234, the expression evaluators 0x4af3bc /
 * 0x4af992, variable stores 0x4b3d47): `fistp QWORD` then the low dword.
 * igi.exe keeps the FPU in chop mode (FUN_004966d0, checked every frame at
 * 0x48dbc1; docs/gameplay.md "FPU rounding mode"), so despite the name this
 * TRUNCATES toward zero (2.9 -> 2, -2.9 -> -2, 0.5 -> 0). Values beyond int32
 * keep their low 32 bits (3e9 -> -1294967296); NaN, +-Infinity and
 * |x| >= 2^63 give 0 (low dword of the integer indefinite). = x87Fistp.
 */
export function qvmRoundToInt(value: number): number {
  return x87Fistp(value);
}

/** Script_GetArgInt semantics (FUN_004b2cd0): int as is, float truncated (qvmRoundToInt), string 0. */
export function qvmToInt(v: QvmRuntimeValue): number {
  return v.type === "int" ? v.value : v.type === "float" ? qvmRoundToInt(v.value) : 0;
}

/** Script_GetArgFloat semantics (FUN_004b3230): numbers as float32 (int: fild + fstp DWORD, chopped), string 0. */
export function qvmToFloat(v: QvmRuntimeValue): number {
  return v.type === "string" ? 0 : v.type === "int" ? x87StoreF32(v.value) : Math.fround(v.value);
}

/** Script_GetArgString semantics (FUN_004b3260): strings truncated to size-1, numbers "". */
export function qvmToString(v: QvmRuntimeValue, bufferSize = 0x100): string {
  return v.type === "string" ? v.value.slice(0, Math.max(0, bufferSize - 1)) : "";
}

// ---------------------------------------------------------------------------
// Opcodes (recovered: mnemonics 0x545a28..0x545b40 via FUN_004b4ec0, handlers
// registered by FUN_004b3640, encodings chosen by the assembler FUN_004b6c50)
// ---------------------------------------------------------------------------

type Operand =
  | "none" | "i8" | "i16" | "i32" | "f32" | "str" | "lit8" | "lit16" | "lit32"
  | "sym8" | "sym16" | "sym32" | "rel32" | "call" | "blk";

export interface QvmOpcode {
  readonly code: number;
  readonly mnemonic: string;
  readonly operand: Operand;
  /** Native handler in igi.exe. */
  readonly handler: number;
}

const OPCODE_ROWS: readonly [string, Operand, number][] = [
  ["BRK", "none", 0x4b4e90], ["NOP", "none", 0x4b4e80], ["PUSH", "i32", 0x4b4b00],
  ["PUSHB", "i8", 0x4b4a80], ["PUSHW", "i16", 0x4b4ac0], ["PUSHF", "f32", 0x4b4bb0],
  ["PUSHA", "i32", 0x4b4b00], ["PUSHS", "str", 0x4b4be0], ["PUSHSI", "lit32", 0x4b4c40],
  ["PUSHSIB", "lit8", 0x4b4c40], ["PUSHSIW", "lit16", 0x4b4c40], ["PUSHI", "str", 0x4b4be0],
  ["PUSHII", "sym32", 0x4b4c40], ["PUSHIIB", "sym8", 0x4b4c40], ["PUSHIIW", "sym16", 0x4b4c40],
  ["PUSH0", "none", 0x4b4a40], ["PUSH1", "none", 0x4b4a20], ["PUSHM", "none", 0x4b4a60],
  ["POP", "none", 0x4b3a70], ["RET", "none", 0x4b4ea0], ["BRA", "rel32", 0x4b3940],
  ["BF", "rel32", 0x4b3940], ["BT", "rel32", 0x4b3940], ["JSR", "rel32", 0x4b4ea0],
  ["CALL", "call", 0x4b3a90], ["ADD", "none", 0x4b3e50], ["SUB", "none", 0x4b3e50],
  ["MUL", "none", 0x4b3e50], ["DIV", "none", 0x4b3e50], ["SHL", "none", 0x4b3e50],
  ["SHR", "none", 0x4b3e50], ["AND", "none", 0x4b3e50], ["OR", "none", 0x4b3e50],
  ["XOR", "none", 0x4b3e50], ["LAND", "none", 0x4b3e50], ["LOR", "none", 0x4b3e50],
  ["EQ", "none", 0x4b3e50], ["NE", "none", 0x4b3e50], ["LT", "none", 0x4b3e50],
  ["LE", "none", 0x4b3e50], ["GT", "none", 0x4b3e50], ["GE", "none", 0x4b3e50],
  ["ASSIGN", "none", 0x4b3c70], ["PLUS", "none", 0x4b48b0], ["MINUS", "none", 0x4b48b0],
  ["INV", "none", 0x4b48b0], ["NOT", "none", 0x4b48b0], ["BLK", "blk", 0x4b4b90],
  ["ILLEGAL", "none", 0x4b4ea0],
];

/** All 49 opcodes, indexed by opcode byte. */
export const QVM_OPCODES: readonly QvmOpcode[] = OPCODE_ROWS.map(([mnemonic, operand, handler], code) => ({
  code,
  mnemonic,
  operand,
  handler,
}));

const OP = Object.fromEntries(QVM_OPCODES.map((o) => [o.mnemonic, o.code])) as Record<string, number>;

// ---------------------------------------------------------------------------
// Host symbols (recovered registration tables)
// ---------------------------------------------------------------------------

/** AIEVENT_* names; the index is the value (FUN_0044dd00). */
export const QVM_AI_EVENTS: readonly string[] = [
  "AIEVENT_CREATE", "AIEVENT_DELETE", "AIEVENT_DEAD", "AIEVENT_ANIMATION", "AIEVENT_IDLE",
  "AIEVENT_ALERT", "AIEVENT_ALERT_RESPONSE", "AIEVENT_COMBAT", "AIEVENT_ALARMON",
  "AIEVENT_ALARMOFF", "AIEVENT_WALK", "AIEVENT_GROUNDIMPACT", "AIEVENT_DOOR", "AIEVENT_FENCE",
  "AIEVENT_LADDER", "AIEVENT_TAKINGDAMAGE", "AIEVENT_GUNSHOT", "AIEVENT_GRENADETHROWN",
  "AIEVENT_GRENADELAND", "AIEVENT_FLASHBANG", "AIEVENT_GUNSHOTMISS", "AIEVENT_EXPLOSION",
  "AIEVENT_ENEMYDETECTION", "AIEVENT_FRIENDLYDETECTION",
];

/** AITYPE_* names; the index is the value (table 0x53a970 walked by FUN_0044dd00). */
export const QVM_AI_TYPES: readonly string[] = [
  "AITYPE_RPG", "AITYPE_GUNNER", "AITYPE_SNIPER", "AITYPE_ANYA", "AITYPE_EKK", "AITYPE_PRIBOI",
  "AITYPE_CIVILIAN", "AITYPE_PATROL_UZI", "AITYPE_PATROL_AK", "AITYPE_PATROL_SPAS",
  "AITYPE_PATROL_PISTOL", "AITYPE_GUARD_UZI", "AITYPE_GUARD_AK", "AITYPE_GUARD_SPAS",
  "AITYPE_GUARD_PISTOL", "AITYPE_SECURITY_PATROL_UZI", "AITYPE_SECURITY_PATROL_SPAS",
  "AITYPE_MAFIA_PATROL_UZI", "AITYPE_MAFIA_PATROL_AK", "AITYPE_MAFIA_PATROL_SPAS",
  "AITYPE_MAFIA_GUARD_UZI", "AITYPE_MAFIA_GUARD_AK", "AITYPE_MAFIA_GUARD_SPAS",
  "AITYPE_SPETNAZ_PATROL_UZI", "AITYPE_SPETNAZ_PATROL_AK", "AITYPE_SPETNAZ_PATROL_SPAS",
  "AITYPE_SPETNAZ_GUARD_UZI", "AITYPE_SPETNAZ_GUARD_AK", "AITYPE_SPETNAZ_GUARD_SPAS",
];

/**
 * Common script run by AIFunction_DefaultHandler for each AITYPE value
 * (recovered: index table 0x53a8fc into the path table 0x53a8d8, scripts
 * loaded by FUN_0044b710 as LOCAL:common/ai/<name>.qsc).
 */
export const QVM_AI_TYPE_SCRIPT: readonly string[] = [
  "rpg", "gunner", "sniper", "anya", "ekk", "priboi", "civilian",
  "patrol", "patrol", "patrol", "patrol", "guard", "guard", "guard", "guard",
  "patrol", "patrol", "patrol", "patrol", "patrol", "guard", "guard", "guard",
  "patrol", "patrol", "patrol", "guard", "guard", "guard",
];

function buildConstants(): Record<string, QvmRuntimeValue> {
  const out: Record<string, QvmRuntimeValue> = {
    // FUN_004aed60 (script system init)
    TRUE: qvmInt(1), ON: qvmInt(1), FALSE: qvmInt(0), OFF: qvmInt(0),
    SCRIPT_WARNINGLEVEL_NO_WARNINGS: qvmInt(0),
    SCRIPT_WARNINGLEVEL_NORMAL: qvmInt(1),
    SCRIPT_WARNINGLEVEL_HIGH: qvmInt(2),
    // FUN_0044dd00 (HumanAI)
    AIACTIONFLAG_NONE: qvmInt(0), AIACTIONFLAG_PUSHABLE: qvmInt(1),
    HUMANAI_DETECTIONEVENT_GUNSHOT_RANGE: qvmInt(0x1e000),
    HUMANAI_DETECTIONEVENT_GUNSHOT_SILENCED_RANGE: qvmInt(0x1000),
    AIALARMACCESS_BEFORECOMBAT: qvmInt(0), AIALARMACCESS_AFTERCOMBAT: qvmInt(1),
    // FUN_004148b0 (Level): GAME_FREQUENCY constant; WORLD_METER / MATH_PI
    // are double variables (0x537440 = 4096.0, 0x537438) read as floats.
    GAME_FREQUENCY: qvmInt(30),
    WORLD_METER: qvmFloat(4096),
    MATH_PI: qvmFloat(3.1415926535897944),
    // FUN_0041ab20 (mission list)
    MISSION_NEXT_MISSION_UNDEFINED: qvmInt(-1),
  };
  QVM_AI_EVENTS.forEach((name, i) => (out[name] = qvmInt(i)));
  QVM_AI_TYPES.forEach((name, i) => (out[name] = qvmInt(i)));
  return out;
}

/** Every constant recovered from the exe's registration code. */
export const QVM_CONSTANTS: Readonly<Record<string, QvmRuntimeValue>> = Object.freeze(buildConstants());

export interface QvmHostFunction {
  /** Argument count the compiler enforces (-1 = variadic). */
  readonly arity: number;
  /** Native result type; CALL pushes an int for "void" (value unused by every shipped script). */
  readonly returns: "void" | "int" | "float";
  /** Native handler address in igi.exe. */
  readonly handler: number;
}

const fn = (arity: number, returns: QvmHostFunction["returns"], handler: number): QvmHostFunction => ({
  arity,
  returns,
  handler,
});

/**
 * Host functions used by the mission-1 executable scripts. AI functions are
 * registered by FUN_0044bae0 (void: FUN_004aead0, int: FUN_004aeb00, float:
 * FUN_004aeb30); the rest by the modules noted in docs/qvm-vm.md.
 */
export const QVM_HOST_FUNCTIONS: Readonly<Record<string, QvmHostFunction>> = Object.freeze({
  AIAction_Patrol: fn(3, "void", 0x44bf20),
  AIAction_Combat: fn(1, "void", 0x44bfa0),
  AIAction_Dead: fn(1, "void", 0x44c0a0),
  AIAction_FallFlat: fn(2, "void", 0x44c100),
  AIAction_Activate: fn(3, "void", 0x44c260),
  AIAction_WalkToNode: fn(2, "void", 0x44c2e0),
  AIAction_RunToNode: fn(2, "void", 0x44c350),
  AIAction_FireAtNode: fn(5, "void", 0x44c3c0),
  AIAction_FireAtTask: fn(5, "void", 0x44c470),
  AIAction_PlayAnimation: fn(2, "void", 0x44c520),
  AIAction_PlaySound: fn(3, "void", 0x44c590),
  AIAction_MoveToEvent: fn(2, "void", 0x44c610),
  AIAction_LookAtEvent: fn(2, "void", 0x44c6b0),
  AIAction_Stunned: fn(2, "void", 0x44c730),
  AIAction_KickGrenade: fn(1, "void", 0x44c7a0),
  AIAction_RunPanicking: fn(2, "void", 0x44c840),
  AIAction_Idle: fn(1, "void", 0x44c8c0),
  AIAction_SetCombat: fn(1, "void", 0x44c920),
  AIFunction_DefaultHandler: fn(0, "void", 0x44cea0),
  AIFunction_RemoveAlarmActions: fn(0, "void", 0x44ca00),
  AIFunction_SetViewLength: fn(1, "void", 0x44ca80),
  AIFunction_SetAlarmViewLength: fn(1, "void", 0x44cb10),
  AIFunction_SetViewAlpha: fn(1, "void", 0x44cb70),
  AIFunction_SetViewGamma: fn(1, "void", 0x44cbd0),
  AIFunction_SetSecondaryViewLength: fn(1, "void", 0x44cc30),
  AIFunction_SetSecondaryAlarmViewLength: fn(1, "void", 0x44ccc0),
  AIFunction_SetSecondaryViewAlpha: fn(1, "void", 0x44cd20),
  AIFunction_SetSecondaryViewGamma: fn(1, "void", 0x44cd80),
  AIFunction_SetEventPriority: fn(1, "void", 0x44cf00),
  AIFunction_SetInvulnerability: fn(1, "void", 0x44cf90),
  AIFunction_SetInstantDeath: fn(1, "void", 0x44cff0),
  AIFunction_SetDeathAnimation: fn(1, "void", 0x44d050),
  AIFunction_SetAlarmTriggerID: fn(1, "void", 0x44d0b0),
  AIFunction_SetAlarmControlID: fn(1, "void", 0x44d110),
  AIFunction_SetAlarmAccess: fn(1, "void", 0x44d170),
  AIFunction_SetGunnerID: fn(1, "void", 0x44d1d0),
  AIFunction_SetScriptIntegerValue: fn(2, "void", 0x44d510),
  AIFunction_SetScriptRealValue: fn(2, "void", 0x44d5d0),
  AIFunction_GetAlarmTriggerID: fn(0, "int", 0x44d230),
  AIFunction_GetAlarmControlID: fn(0, "int", 0x44d270),
  AIFunction_GetAlarmAccess: fn(0, "int", 0x44d2b0),
  AIFunction_GetGunnerID: fn(0, "int", 0x44d2f0),
  AIFunction_GetAlarmControlStatus: fn(0, "int", 0x44d330),
  AIFunction_GetGunnerStatus: fn(0, "int", 0x44d420),
  AIFunction_GetScriptIntegerValue: fn(1, "int", 0x44d580),
  AIFunction_GetCurrentEventType: fn(0, "int", 0x44cde0),
  AIFunction_IsEventBehind: fn(0, "int", 0x44d6a0),
  AIFunction_GetScriptRealValue: fn(1, "float", 0x44d640),
  AIFunction_GetRandomValue: fn(1, "float", 0x44ce40),
  AIFunction_GetEventDistance: fn(0, "float", 0x44d770),
  AIFunction_GetAlarmTriggerDistance: fn(0, "float", 0x44d7f0),
  AIFunction_SetAnimationInterval: fn(2, "void", 0x44d930),
  AIFunction_AddAnimationEntry: fn(2, "void", 0x44d9f0),
  AIFunction_GetAnimationToPlay: fn(0, "int", 0x44daf0),
  AIFunction_SendResponse: fn(0, "void", 0x44dc90),
  _Script_SetWarningLevel: fn(1, "void", 0x4aeea0),
  BreakScript: fn(0, "void", 0x4aee50),
  DefineMission: fn(-1, "void", 0x41ab50),
  Task_New: fn(-1, "void", 0x4e7420),
  Task_DeclareParameters: fn(-1, "void", 0x4e73e0),
  DefineGroup: fn(-1, "void", 0x4e2610),
  DefineSound: fn(-1, "void", 0x4df830),
  DefineGraph: fn(-1, "void", 0x4e18c0),
  DefineTriggerOnce: fn(-1, "void", 0x4e0ab0),
});

// ---------------------------------------------------------------------------
// Program loading and disassembly
// ---------------------------------------------------------------------------

export class QvmError extends Error {
  constructor(message: string, readonly codeOffset?: number) {
    super(`QVM: ${message}${codeOffset === undefined ? "" : ` at code 0x${codeOffset.toString(16)}`}`);
    this.name = "QvmError";
  }
}

export interface QvmInstruction {
  readonly offset: number;
  readonly opcode: number;
  readonly mnemonic: string;
  readonly size: number;
  /** Literal number/string, symbol name, or table index resolved to its text. */
  readonly value?: number | string;
  /** Branch target (code offset). */
  readonly target?: number;
  /** CALL argument-block offsets. */
  readonly args?: readonly number[];
}

export interface QvmProgram {
  readonly symbols: readonly string[];
  readonly literals: readonly string[];
  readonly code: Uint8Array;
  /** Every instruction keyed by code offset (linear sweep covers the whole code). */
  readonly instructions: ReadonlyMap<number, QvmInstruction>;
  /** Instruction offsets in ascending order. */
  readonly offsets: readonly number[];
  /** Header u32 at +8; the exe refuses files where it is <= 4. */
  readonly revision: number;
  readonly dataStackWords: number;
  readonly typeStackEntries: number;
}

function readTable(bytes: Uint8Array, view: DataView, table: number, pool: number, tableBytes: number,
  poolBytes: number, what: string): string[] {
  if (tableBytes % 4 !== 0 || table + tableBytes > bytes.length || pool + poolBytes > bytes.length) {
    throw new QvmError(`invalid ${what} table bounds`);
  }
  const out: string[] = [];
  for (let pos = table; pos < table + tableBytes; pos += 4) {
    const rel = view.getUint32(pos, true);
    let end = pool + rel;
    while (end < pool + poolBytes && bytes[end] !== 0) end++;
    if (rel >= poolBytes || end >= pool + poolBytes) {
      throw new QvmError(`${what} string at table 0x${pos.toString(16)} outside its pool`);
    }
    let text = "";
    for (let i = pool + rel; i < end; i++) text += String.fromCharCode(bytes[i]);
    out.push(text);
  }
  return out;
}

function decodeAt(code: Uint8Array, view: DataView, at: number, symbols: readonly string[],
  literals: readonly string[]): QvmInstruction {
  const opcode = code[at];
  const spec = QVM_OPCODES[opcode];
  if (!spec) throw new QvmError(`unknown opcode 0x${opcode.toString(16).padStart(2, "0")}`, at);
  const need = (n: number) => {
    if (at + 1 + n > code.length) throw new QvmError(`truncated ${spec.mnemonic}`, at);
  };
  const base = { offset: at, opcode, mnemonic: spec.mnemonic };
  const table = (index: number, names: readonly string[], what: string): string => {
    if (index >= names.length) throw new QvmError(`${what} index ${index} outside table`, at);
    return names[index];
  };
  switch (spec.operand) {
    case "none":
      return { ...base, size: 1 };
    case "i8":
      need(1);
      return { ...base, size: 2, value: view.getInt8(at + 1) };
    case "i16":
      need(2);
      return { ...base, size: 3, value: view.getInt16(at + 1, true) };
    case "i32":
      need(4);
      return { ...base, size: 5, value: view.getInt32(at + 1, true) };
    case "f32": {
      need(4);
      const value = view.getFloat32(at + 1, true);
      if (!Number.isFinite(value)) throw new QvmError("non-finite float literal", at);
      return { ...base, size: 5, value };
    }
    case "lit8":
      need(1);
      return { ...base, size: 2, value: table(code[at + 1], literals, "literal") };
    case "lit16":
      need(2);
      return { ...base, size: 3, value: table(view.getUint16(at + 1, true), literals, "literal") };
    case "lit32":
      need(4);
      return { ...base, size: 5, value: table(view.getUint32(at + 1, true), literals, "literal") };
    case "sym8":
      need(1);
      return { ...base, size: 2, value: table(code[at + 1], symbols, "symbol") };
    case "sym16":
      need(2);
      return { ...base, size: 3, value: table(view.getUint16(at + 1, true), symbols, "symbol") };
    case "sym32":
      need(4);
      return { ...base, size: 5, value: table(view.getUint32(at + 1, true), symbols, "symbol") };
    case "rel32":
      need(4);
      return { ...base, size: 5, target: at + 5 + view.getInt32(at + 1, true) };
    case "str": {
      let end = at + 1;
      while (end < code.length && code[end] !== 0) end++;
      if (end >= code.length) throw new QvmError("unterminated inline string", at);
      let text = "";
      for (let i = at + 1; i < end; i++) text += String.fromCharCode(code[i]);
      return { ...base, size: end + 1 - at, value: text };
    }
    case "call": {
      need(4);
      const count = view.getUint32(at + 1, true);
      if (at + 5 + count * 4 > code.length) throw new QvmError("CALL table exceeds code", at);
      const args: number[] = [];
      for (let i = 0; i < count; i++) args.push(view.getUint32(at + 5 + i * 4, true));
      return { ...base, size: 5 + count * 4, args };
    }
    case "blk": {
      need(4);
      const size = 5 + view.getUint32(at + 1, true);
      if (at + size > code.length) throw new QvmError("BLK exceeds code", at);
      return { ...base, size };
    }
  }
}

/**
 * Load and fully validate a LOOP v8 program: every byte of code decodes, the
 * last instruction is BRK, every branch and CALL argument offset lands on an
 * instruction boundary. Throws QvmError naming the offset otherwise.
 */
export function loadQvmProgram(buffer: ArrayBuffer): QvmProgram {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 0x3c) throw new QvmError("file shorter than the 60-byte header");
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "LOOP" || view.getUint32(4, true) !== 8) throw new QvmError("expected LOOP version 8");
  const u = (offset: number) => view.getUint32(offset, true);
  const revision = u(8);
  if (!(revision > 4)) throw new QvmError(`header +8 is ${revision}; igi.exe requires > 4`);
  const symbols = readTable(bytes, view, u(12), u(16), u(20), u(24), "symbol");
  const literals = readTable(bytes, view, u(28), u(32), u(36), u(40), "literal");
  const codeAt = u(44);
  const codeSize = u(48);
  if (codeAt + codeSize !== bytes.length) throw new QvmError("bytecode does not end at end of file");
  const code = bytes.slice(codeAt, codeAt + codeSize);
  const codeView = new DataView(code.buffer, code.byteOffset, code.byteLength);
  const instructions = new Map<number, QvmInstruction>();
  const offsets: number[] = [];
  for (let at = 0; at < code.length; ) {
    const ins = decodeAt(code, codeView, at, symbols, literals);
    instructions.set(at, ins);
    offsets.push(at);
    at += ins.size;
  }
  const last = offsets.length ? instructions.get(offsets[offsets.length - 1]) : undefined;
  if (!last || last.opcode !== OP.BRK) throw new QvmError("code does not end with BRK");
  for (const ins of instructions.values()) {
    for (const target of [...(ins.target === undefined ? [] : [ins.target]), ...(ins.args ?? [])]) {
      if (!instructions.has(target)) {
        throw new QvmError(`${ins.mnemonic} target 0x${target.toString(16)} is not an instruction boundary`, ins.offset);
      }
    }
  }
  return {
    symbols,
    literals,
    code,
    instructions,
    offsets,
    revision,
    dataStackWords: ((u(52) || 0x800) + 3) >>> 2,
    typeStackEntries: u(56) || 0x100,
  };
}

/** One text line per instruction: `offset  MNEMONIC operand`. */
export function disassembleQvm(program: QvmProgram): string[] {
  return program.offsets.map((at) => {
    const ins = program.instructions.get(at)!;
    const hex = at.toString(16).padStart(6, " ");
    let operand = "";
    if (ins.target !== undefined) operand = `0x${ins.target.toString(16)}`;
    else if (ins.args) operand = `[${ins.args.map((a) => `0x${a.toString(16)}`).join(", ")}]`;
    else if (typeof ins.value === "string") operand = /^PUSHI/.test(ins.mnemonic) ? ins.value : JSON.stringify(ins.value);
    else if (ins.value !== undefined) operand = String(ins.value);
    return `${hex}  ${ins.mnemonic.padEnd(8)}${operand}`.trimEnd();
  });
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

/** What a native handler receives (the args struct built by FUN_004b3a90). */
export interface QvmCallContext {
  readonly name: string;
  readonly argc: number;
  /** Code offset of the CALL instruction. */
  readonly codeOffset: number;
  /** Run argument `index`'s code block now and return its value (symbols resolved). */
  arg(index: number): QvmRuntimeValue;
  /** Script_GetArgInt (FUN_004aec60). */
  argInt(index: number): number;
  /** Script_GetArgFloat (FUN_004aec90). */
  argFloat(index: number): number;
  /** Script_GetArgString (FUN_004aecc0) into a buffer of `bufferSize` bytes. */
  argString(index: number, bufferSize?: number): string;
}

export type QvmHostResult = QvmRuntimeValue | number | string | boolean | undefined | void;

export interface QvmHost {
  /**
   * Native function `name`. `args` holds every argument evaluated left to
   * right, unless lazyArgs(name) is true: then `args` is empty and the host
   * reads arguments through ctx exactly when (and as often as) it needs.
   * Plain-number results are typed by QVM_HOST_FUNCTIONS[name].returns
   * (unknown names: integer -> int, otherwise float); undefined pushes int 0.
   */
  call(name: string, args: readonly QvmRuntimeValue[], ctx: QvmCallContext): QvmHostResult;
  /** Constant or variable `name` (e.g. "CutScene_1200.nTick"); undefined = unknown here. */
  value?(name: string): QvmRuntimeValue | number | string | undefined;
  /** When provided, PUSHII of a name for which has() is false (and that is not a recovered constant) faults like the exe's error 7. */
  has?(name: string): boolean;
  lazyArgs?(name: string): boolean;
  /** ASSIGN (opcode 2a) into script variable `name`; returns the stored value. */
  assign?(name: string, value: QvmRuntimeValue): QvmRuntimeValue;
}

export interface QvmRunOptions {
  /** Instruction budget per run (no shipped script loops; default 1,000,000). */
  maxSteps?: number;
  /** Fall back to QVM_CONSTANTS when host.value() does not know a name (default true). */
  recoveredConstants?: boolean;
}

export interface QvmRunResult {
  readonly steps: number;
  readonly hostCalls: number;
}

const INT_OPS: Record<number, (a: number, b: number) => number> = {
  0x19: (a, b) => (a + b) | 0,
  0x1a: (a, b) => (a - b) | 0,
  0x1b: (a, b) => Math.imul(a, b),
  0x1c: (a, b) => (a / b) | 0,
  0x1d: (a, b) => a << (b & 31),
  0x1e: (a, b) => a >> (b & 31),
  0x1f: (a, b) => a & b,
  0x20: (a, b) => a | b,
  0x21: (a, b) => a ^ b,
  0x22: (a, b) => (a !== 0 && b !== 0 ? 1 : 0),
  0x23: (a, b) => (a !== 0 || b !== 0 ? 1 : 0),
  0x24: (a, b) => (a === b ? 1 : 0),
  0x25: (a, b) => (a !== b ? 1 : 0),
  0x26: (a, b) => (a < b ? 1 : 0),
  0x27: (a, b) => (a <= b ? 1 : 0),
  0x28: (a, b) => (a > b ? 1 : 0),
  0x29: (a, b) => (a >= b ? 1 : 0),
};

class Machine {
  readonly stack: Slot[] = [];
  words = 0;
  steps = 0;
  hostCalls = 0;

  constructor(
    readonly program: QvmProgram,
    readonly host: QvmHost,
    readonly maxSteps: number,
    readonly constants: boolean,
  ) {}

  private slotWords(v: Slot): number {
    return v.type === "string" ? 1 + ((v.value.length + 4) >> 2) : 1;
  }

  push(v: Slot, at: number): void {
    const w = this.slotWords(v);
    if (this.stack.length >= this.program.typeStackEntries || this.words + w > this.program.dataStackWords) {
      throw new QvmError("stack overflow", at);
    }
    this.stack.push(v);
    this.words += w;
  }

  popSlot(at: number): Slot {
    const v = this.stack.pop();
    if (!v) throw new QvmError("stack underflow", at);
    this.words -= this.slotWords(v);
    return v;
  }

  /** Symbol getter (FUN_004b30e0 / FUN_004b2e20 call the symbol's handler for kinds 0 and 2). */
  resolve(v: Slot, at: number): QvmRuntimeValue {
    if (v.type === "int" || v.type === "float" || v.type === "string") return v;
    if (v.type === "address") throw new QvmError("PUSHA address used as a value", at);
    const found = this.host.value?.(v.value);
    if (found !== undefined) {
      if (typeof found === "number") return Number.isInteger(found) ? qvmInt(found) : qvmFloat(found);
      if (typeof found === "string") return qvmString(found);
      return found;
    }
    const constant = this.constants ? QVM_CONSTANTS[v.value] : undefined;
    if (constant) return constant;
    throw new QvmError(`unknown identifier "${v.value}" used as a value`, at);
  }

  popValue(at: number): QvmRuntimeValue {
    return this.resolve(this.popSlot(at), at);
  }

  /** FUN_004b31f0: execute from `pc` until a BRK; returns that BRK's offset. */
  exec(start: number): number {
    const { instructions } = this.program;
    let pc = start;
    for (;;) {
      if (++this.steps > this.maxSteps) throw new QvmError("step limit exceeded", pc);
      const ins = instructions.get(pc);
      if (!ins) throw new QvmError("pc is not an instruction", pc);
      let next = pc + ins.size;
      const op = ins.opcode;
      switch (op) {
        case 0x00: // BRK
          return pc;
        case 0x01: // NOP
        case 0x2f: // BLK: skip inline data
          break;
        case 0x02:
        case 0x03:
        case 0x04:
          this.push(qvmInt(ins.value as number), pc);
          break;
        case 0x05:
          this.push({ type: "float", value: ins.value as number }, pc);
          break;
        case 0x06:
          this.push({ type: "address", value: ins.value as number }, pc);
          break;
        case 0x07:
        case 0x08:
        case 0x09:
        case 0x0a:
          this.push(qvmString(ins.value as string), pc);
          break;
        case 0x0b:
        case 0x0c:
        case 0x0d:
        case 0x0e: {
          const name = ins.value as string;
          if (this.host.has && !this.host.has(name) && !(this.constants && name in QVM_CONSTANTS)) {
            throw new QvmError(`unknown identifier "${name}"`, pc);
          }
          this.push({ type: "symbol", value: name }, pc);
          break;
        }
        case 0x0f:
          this.push(qvmInt(0), pc);
          break;
        case 0x10:
          this.push(qvmInt(1), pc);
          break;
        case 0x11:
          this.push(qvmInt(-1), pc);
          break;
        case 0x12:
          this.popSlot(pc);
          break;
        case 0x14:
          next = ins.target!;
          break;
        case 0x15:
        case 0x16: {
          const v = this.popValue(pc);
          if (v.type === "string") throw new QvmError(`${ins.mnemonic} on a string`, pc);
          if ((v.value === 0) === (op === 0x15)) next = ins.target!;
          break;
        }
        case 0x18:
          this.call(ins, pc);
          break;
        case 0x2a: {
          const value = this.popValue(pc);
          const target = this.popSlot(pc);
          if (target.type !== "symbol" || !this.host.assign) throw new QvmError("ASSIGN target is not a variable", pc);
          this.push(this.host.assign(target.value, value), pc);
          break;
        }
        case 0x2b:
        case 0x2c:
        case 0x2d:
        case 0x2e: {
          const v = this.popValue(pc);
          if (v.type === "int") {
            const r = op === 0x2b ? v.value : op === 0x2c ? -v.value | 0 : op === 0x2d ? ~v.value : v.value === 0 ? 1 : 0;
            this.push(qvmInt(r), pc);
          } else if (v.type === "float" && (op === 0x2b || op === 0x2c)) {
            this.push({ type: "float", value: op === 0x2b ? v.value : -v.value }, pc);
          } else {
            throw new QvmError(`${ins.mnemonic} on a ${v.type} operand`, pc);
          }
          break;
        }
        default:
          if (op >= 0x19 && op <= 0x29) {
            this.binary(op, ins.mnemonic, pc);
            break;
          }
          // 13 RET, 17 JSR, 30 ILLEGAL: error 5 "Illegal instruction" (FUN_004b4ea0)
          throw new QvmError(`illegal instruction ${ins.mnemonic}`, pc);
      }
      pc = next;
    }
  }

  /** FUN_004b3e50: B is on top, A below; int if both int, float if either float, strings only + and compares. */
  binary(op: number, mnemonic: string, at: number): void {
    const b = this.popValue(at);
    const a = this.popValue(at);
    if (a.type !== "string" && b.type !== "string") {
      if (a.type === "int" && b.type === "int") {
        if (op === 0x1c && (b.value === 0 || (a.value === -2147483648 && b.value === -1))) {
          throw new QvmError("integer divide fault (the exe raises #DE)", at);
        }
        this.push(qvmInt(INT_OPS[op](a.value, b.value)), at);
        return;
      }
      // Operands are popped as float32 (an int via fild + fstp DWORD); each op is
      // fld DWORD; f<op> DWORD; fstp DWORD (0x4b41ad..0x4b422b) in chop mode.
      const x = qvmToFloat(a);
      const y = qvmToFloat(b);
      if (op >= 0x1d && op <= 0x21) throw new QvmError(`${mnemonic} on float operands`, at);
      if (op <= 0x1c) {
        const r = op === 0x19 ? x87F32Add(x, y) : op === 0x1a ? x87F32Sub(x, y) : op === 0x1b ? x87F32Mul(x, y) : x87F32Div(x, y);
        this.push({ type: "float", value: r }, at);
        return;
      }
      const r =
        op === 0x22 ? x !== 0 && y !== 0 : op === 0x23 ? x !== 0 || y !== 0 : op === 0x24 ? x === y :
        op === 0x25 ? x !== y : op === 0x26 ? x < y : op === 0x27 ? x <= y : op === 0x28 ? x > y : x >= y;
      this.push(qvmInt(r ? 1 : 0), at);
      return;
    }
    if (a.type === "string" && b.type === "string") {
      if (op === 0x19) {
        this.push(qvmString(a.value + b.value), at);
        return;
      }
      if (op >= 0x24 && op <= 0x29) {
        const c = a.value < b.value ? -1 : a.value > b.value ? 1 : 0; // strcmp on latin1 bytes
        const r = op === 0x24 ? c === 0 : op === 0x25 ? c !== 0 : op === 0x26 ? c < 0 : op === 0x27 ? c <= 0 : op === 0x28 ? c > 0 : c >= 0;
        this.push(qvmInt(r ? 1 : 0), at);
        return;
      }
    }
    throw new QvmError(`${mnemonic} on ${a.type}/${b.type} operands`, at);
  }

  /** FUN_004b2d00: run an argument block until its BRK, pop the value, restore the stack. */
  evalArg(start: number): QvmRuntimeValue {
    const depth = this.stack.length;
    const words = this.words;
    this.exec(start);
    if (this.stack.length <= depth) throw new QvmError("argument pushed no value", start);
    const v = this.popValue(start);
    this.stack.length = depth;
    this.words = words;
    return v;
  }

  call(ins: QvmInstruction, at: number): void {
    const fnSlot = this.popSlot(at);
    if (fnSlot.type !== "symbol") throw new QvmError("CALL without a function symbol on the stack", at);
    const name = fnSlot.value;
    const offsets = ins.args ?? [];
    const ctx: QvmCallContext = {
      name,
      argc: offsets.length,
      codeOffset: at,
      arg: (i) => {
        if (!Number.isInteger(i) || i < 0 || i >= offsets.length) throw new QvmError(`${name}: argument ${i} out of range`, at);
        return this.evalArg(offsets[i]);
      },
      argInt: (i) => qvmToInt(ctx.arg(i)),
      argFloat: (i) => qvmToFloat(ctx.arg(i)),
      argString: (i, size) => qvmToString(ctx.arg(i), size),
    };
    const args = this.host.lazyArgs?.(name) ? [] : offsets.map((_, i) => ctx.arg(i));
    this.hostCalls++;
    const result = this.host.call(name, args, ctx);
    this.push(this.typeResult(name, result), at);
  }

  private typeResult(name: string, result: QvmHostResult): QvmRuntimeValue {
    if (result === undefined) return qvmInt(0);
    if (typeof result === "boolean") return qvmInt(result ? 1 : 0);
    if (typeof result === "string") return qvmString(result);
    if (typeof result === "number") {
      const returns = QVM_HOST_FUNCTIONS[name]?.returns;
      if (returns === "float") return qvmFloat(result);
      if (returns === "int" || returns === "void") return qvmInt(qvmRoundToInt(result)); // truncated, as the exe's (int) casts
      return Number.isInteger(result) ? qvmInt(result) : qvmFloat(result);
    }
    return result;
  }
}

/**
 * One complete run of `program` (FUN_004b3290): pc 0, empty stacks, until the
 * top-level BRK. Throws QvmError on any VM fault (the exe reports "Error in
 * QVM program" and abandons the run at that point).
 */
export function runQvm(program: QvmProgram, host: QvmHost, options: QvmRunOptions = {}): QvmRunResult {
  const machine = new Machine(program, host, options.maxSteps ?? 1_000_000, options.recoveredConstants ?? true);
  machine.exec(0);
  if (machine.stack.length !== 0) throw new QvmError(`${machine.stack.length} value(s) left on the stack at exit`);
  return { steps: machine.steps, hostCalls: machine.hostCalls };
}

// ---------------------------------------------------------------------------
// String-expression language (task conditions in objects.qvm)
// ---------------------------------------------------------------------------
//
// Recovered pipeline: FUN_004e80a0 rewrites the condition text (task-id
// identifiers, "this.", ".isExists"), FUN_004ae920 parses it with the exe's
// source-script parser (lexer FUN_004b5e80 + FUN_00510f70, precedence
// climbing FUN_004aff10 with table FUN_004b0610) and FUN_004e8380 evaluates
// the tree with the float evaluator FUN_004af8a0 (FUN_004af360 is the int
// evaluator used e.g. for a HumanAI's AI-type string, FUN_0044f3a0).

type ExprNode =
  | { readonly kind: "int"; readonly value: number }
  | { readonly kind: "float"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "ident"; readonly name: string; readonly args: readonly ExprNode[] | null }
  | { readonly kind: "unary"; readonly op: string; readonly operand: ExprNode }
  | { readonly kind: "binary"; readonly op: string; readonly left: ExprNode; readonly right: ExprNode }
  | { readonly kind: "ternary"; readonly cond: ExprNode; readonly whenTrue: ExprNode; readonly whenFalse: ExprNode };

export interface QvmExpression {
  readonly text: string;
  readonly root: ExprNode;
}

type Token =
  | { readonly kind: "op"; readonly op: string; readonly at: number }
  | { readonly kind: "ident"; readonly text: string; readonly at: number }
  | { readonly kind: "int"; readonly value: number; readonly at: number }
  | { readonly kind: "float"; readonly value: number; readonly at: number }
  | { readonly kind: "string"; readonly value: string; readonly at: number };

/** Binary precedence (FUN_004b0610; lower binds tighter). Unary + - ~ ! are 2. */
const BINARY_PRECEDENCE: Readonly<Record<string, number>> = {
  "*": 3, "/": 3, "+": 4, "-": 4, "<<": 5, ">>": 5, "<": 6, ">": 6, "<=": 6, ">=": 6,
  "==": 7, "!=": 7, "&": 8, "^": 9, "|": 10, "&&": 11, "||": 12, "?": 13, "=": 14, ",": 15,
};

const exprError = (text: string, at: number, message: string): never => {
  throw new Error(`QVM expression: ${message} at character ${at} of ${JSON.stringify(text)}`);
};

/** Lexer (FUN_004b5e80 operators, FUN_00510f70 identifiers / numbers / strings). */
function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const isIdent = (c: string) => /[0-9A-Za-z_.]/.test(c);
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (["&&", "||", "==", "!=", "<=", ">=", "<<", ">>"].includes(two)) {
      out.push({ kind: "op", op: two, at: i });
      i += 2;
      continue;
    }
    if ("!&()*+,-/:;<=>?^{|}~".includes(c)) {
      out.push({ kind: "op", op: c, at: i });
      i++;
      continue;
    }
    if (c === '"') {
      let value = "";
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] !== "\\") {
          value += text[j];
          continue;
        }
        const e = text[++j];
        if (e === "x" || e === "X") {
          value += String.fromCharCode(parseInt(text.slice(j + 1, j + 3), 16));
          j += 2;
        } else {
          value += e === "b" ? "\b" : e === "n" ? "\n" : e === "r" ? "\r" : e === "t" ? "\t" : (e ?? "");
        }
      }
      if (j >= text.length) exprError(text, i, "unterminated string");
      out.push({ kind: "string", value, at: i });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "$" && /[0-9A-Fa-f]/.test(text[i + 1] ?? ""))) {
      const m = /^(\$[0-9A-Fa-f]*|0[xX][0-9A-Fa-f]*|[0-9]+(\.[0-9]*)?([eE][+-]?[0-9]+)?)/.exec(text.slice(i))!;
      const t = m[0];
      if (t[0] === "$" || /^0[xX]/.test(t)) {
        out.push({ kind: "int", value: Number.parseInt(t.replace(/^\$|^0[xX]/, "") || "0", 16) | 0, at: i });
      } else if (/[.eE]/.test(t)) {
        out.push({ kind: "float", value: Number.parseFloat(t), at: i });
      } else {
        out.push({ kind: "int", value: Number.parseInt(t, 10) | 0, at: i });
      }
      i += t.length;
      continue;
    }
    if (isIdent(c)) {
      let j = i;
      while (j < text.length && isIdent(text[j])) j++;
      out.push({ kind: "ident", text: text.slice(i, j), at: i });
      i = j;
      continue;
    }
    exprError(text, i, `unexpected character ${JSON.stringify(c)}`);
  }
  return out;
}

/**
 * Parse one expression (the exe appends ';'). Grammar = C expressions without
 * %, ++/--, compound assignment or member access (dots are identifier
 * characters): unary + - ! ~, * /, + -, << >>, relational, equality, & ^ |,
 * && ||, ?: (right), = (right), comma; f(args); adjacent strings concatenate.
 */
export function parseQvmExpression(text: string): QvmExpression {
  const tokens = tokenize(text);
  let p = 0;
  const peekOp = (): string | undefined => {
    const t = tokens[p];
    return t && t.kind === "op" ? t.op : undefined;
  };
  const expectOp = (op: string) => {
    if (peekOp() !== op) exprError(text, tokens[p]?.at ?? text.length, `expected "${op}"`);
    p++;
  };

  const primary = (): ExprNode => {
    const t = tokens[p];
    if (!t) return exprError(text, text.length, "expected operand");
    if (t.kind === "op") {
      if (t.op === "(") {
        p++;
        const inner = parse(15, false);
        expectOp(")");
        return inner;
      }
      if (t.op === "+" || t.op === "-" || t.op === "!" || t.op === "~") {
        p++;
        return { kind: "unary", op: t.op, operand: primary() };
      }
      return exprError(text, t.at, `unexpected "${t.op}"`);
    }
    p++;
    if (t.kind === "int" || t.kind === "float") return { kind: t.kind, value: t.value };
    if (t.kind === "string") {
      let value = t.value;
      while (tokens[p]?.kind === "string") value += (tokens[p++] as { value: string }).value;
      return { kind: "string", value };
    }
    if (peekOp() === "(") {
      p++;
      const args: ExprNode[] = [];
      if (peekOp() !== ")") {
        for (;;) {
          args.push(parse(14, true));
          if (peekOp() !== ",") break;
          p++;
        }
      }
      expectOp(")");
      return { kind: "ident", name: t.text, args };
    }
    return { kind: "ident", name: t.text, args: null };
  };

  const parse = (level: number, inArgs: boolean): ExprNode => {
    let left = primary();
    for (;;) {
      const op = peekOp();
      if (op === undefined || (inArgs && op === ",")) return left;
      const prec = BINARY_PRECEDENCE[op];
      if (prec === undefined || prec > level) return left;
      p++;
      if (op === "?") {
        const whenTrue = parse(15, false);
        expectOp(":");
        const whenFalse = parse(inArgs ? 14 : 15, inArgs); // the exe parses the else-branch to the end
        left = { kind: "ternary", cond: left, whenTrue, whenFalse };
        continue;
      }
      const right = parse(op === "=" ? prec : prec - 1, inArgs);
      left = { kind: "binary", op, left, right };
    }
  };

  const root = parse(15, false);
  while (peekOp() === ";") p++;
  if (p !== tokens.length) exprError(text, tokens[p].at, "unexpected trailing input");
  return { text, root };
}

/** Lazily evaluated call argument for function identifiers inside expressions. */
export interface QvmExpressionArg {
  int(): number;
  float(): number;
  string(): string;
}

export interface QvmExpressionScope {
  /**
   * Getter for identifier `name` (args null) or function call `name(args)`.
   * Return undefined for unknown identifiers: the exe warns "Unknown
   * identifier '%s' in expression" and uses 0.
   */
  value(name: string, args: readonly QvmExpressionArg[] | null): QvmRuntimeValue | number | undefined;
  assign?(name: string, value: number): void;
  warn?(message: string): void;
}

/**
 * Evaluate an expression the way igi.exe does: "float" = FUN_004af8a0 (task
 * conditions), "int" = FUN_004af360. && || short-circuit; a ?: condition is
 * converted to int by FISTP (0x4af992), i.e. truncated, so 0.9 is false;
 * division by zero yields 0 (and sets the exe's error flag); in float mode
 * the integer-only operators & | ^ << >> ~ evaluate to 0. Float mode works
 * on doubles and + - * / round toward zero (x87 chop mode, 0x4afa30..0x4afaa9);
 * int mode truncates float literals (0x4af3b9).
 */
export function evaluateQvmExpression(expr: QvmExpression | string, scope: QvmExpressionScope,
  mode: "float" | "int" = "float"): number {
  const tree = typeof expr === "string" ? parseQvmExpression(expr) : expr;
  const warn = (m: string) => scope.warn?.(m);

  const lookup = (node: Extract<ExprNode, { kind: "ident" }>): QvmRuntimeValue | undefined => {
    const args = node.args?.map((a): QvmExpressionArg => ({
      int: () => evalInt(a),
      float: () => evalFloat(a),
      string: () => (a.kind === "string" ? a.value : ""),
    })) ?? null;
    const v = scope.value(node.name, args);
    if (v === undefined) {
      warn(`Unknown identifier '${node.name}' in expression`);
      return undefined;
    }
    return typeof v === "number" ? (Number.isInteger(v) ? qvmInt(v) : { type: "float", value: v }) : v;
  };
  const assign = (node: Extract<ExprNode, { kind: "binary" }>, value: number): boolean => {
    if (node.left.kind !== "ident" || node.left.args !== null || !scope.assign) {
      warn("Syntax error in assignment");
      return false;
    }
    scope.assign(node.left.name, value);
    return true;
  };

  const evalFloat = (n: ExprNode): number => {
    switch (n.kind) {
      case "int":
      case "float":
        return n.value;
      case "string":
        return 0;
      case "ident": {
        const v = lookup(n);
        return v === undefined || v.type === "string" ? 0 : v.value;
      }
      case "unary":
        if (n.op === "-") return -evalFloat(n.operand);
        if (n.op === "+") return evalFloat(n.operand);
        if (n.op === "!") return evalFloat(n.operand) === 0 ? 1 : 0;
        return 0; // ~ has no float case
      case "ternary":
        return qvmRoundToInt(evalFloat(n.cond)) !== 0 ? evalFloat(n.whenTrue) : evalFloat(n.whenFalse);
      case "binary": {
        const { op } = n;
        if (op === "&&") return evalFloat(n.left) !== 0 && evalFloat(n.right) !== 0 ? 1 : 0;
        if (op === "||") return evalFloat(n.left) !== 0 || evalFloat(n.right) !== 0 ? 1 : 0;
        if (op === ",") {
          evalInt(n.left);
          return evalInt(n.right);
        }
        if (op === "=") {
          const v = evalFloat(n.right);
          return assign(n, v) ? v : 0;
        }
        if (op === "/") {
          const d = evalFloat(n.right);
          if (d === 0) {
            warn("division by zero");
            return 0;
          }
          return x87Div(evalFloat(n.left), d);
        }
        const a = evalFloat(n.left);
        const b = evalFloat(n.right);
        switch (op) {
          case "+": return x87Add(a, b);
          case "-": return x87Sub(a, b);
          case "*": return x87Mul(a, b);
          case "==": return a === b ? 1 : 0;
          case "!=": return a !== b ? 1 : 0;
          case "<": return a < b ? 1 : 0;
          case ">": return a > b ? 1 : 0;
          case "<=": return a <= b ? 1 : 0;
          case ">=": return a >= b ? 1 : 0;
          default: return 0; // & | ^ << >> have no float case
        }
      }
    }
  };

  const evalInt = (n: ExprNode): number => {
    switch (n.kind) {
      case "int":
        return n.value;
      case "float":
        return qvmRoundToInt(n.value);
      case "string":
        return 0;
      case "ident": {
        const v = lookup(n);
        return v === undefined ? 0 : qvmToInt(v);
      }
      case "unary": {
        const v = evalInt(n.operand);
        return n.op === "-" ? -v | 0 : n.op === "+" ? v : n.op === "~" ? ~v : v === 0 ? 1 : 0;
      }
      case "ternary":
        return evalInt(n.cond) !== 0 ? evalInt(n.whenTrue) : evalInt(n.whenFalse);
      case "binary": {
        const { op } = n;
        if (op === "&&") return evalInt(n.left) !== 0 && evalInt(n.right) !== 0 ? 1 : 0;
        if (op === "||") return evalInt(n.left) !== 0 || evalInt(n.right) !== 0 ? 1 : 0;
        if (op === ",") {
          evalInt(n.left);
          return evalInt(n.right);
        }
        if (op === "=") {
          const v = evalInt(n.right);
          return assign(n, v) ? v : 0;
        }
        const b = evalInt(n.right);
        if (op === "/" && b === 0) {
          warn("division by zero");
          return 0;
        }
        const a = evalInt(n.left);
        switch (op) {
          case "+": return (a + b) | 0;
          case "-": return (a - b) | 0;
          case "*": return Math.imul(a, b);
          case "/": return (a / b) | 0;
          case "<<": return a << (b & 31);
          case ">>": return a >> (b & 31);
          case "&": return a & b;
          case "|": return a | b;
          case "^": return a ^ b;
          case "==": return a === b ? 1 : 0;
          case "!=": return a !== b ? 1 : 0;
          case "<": return a < b ? 1 : 0;
          case ">": return a > b ? 1 : 0;
          case "<=": return a <= b ? 1 : 0;
          case ">=": return a >= b ? 1 : 0;
          default: return 0;
        }
      }
    }
  };

  return mode === "int" ? evalInt(tree.root) : evalFloat(tree.root);
}

/**
 * FUN_004e80a0's rewrite of a task condition before compiling it: every
 * identifier/number token is re-emitted without whitespace; an identifier
 * not starting with a digit whose digits right before its first '.' (or at
 * its end) form a task id becomes "0" when that task does not exist; a
 * "this." prefix becomes "<thisName>."; any token containing ".isExists"
 * becomes "1" (after the missing-task rule, so a missing task gives "0").
 * Returns the rewritten text and the referenced existing task ids.
 */
export function prepareQvmTaskExpression(text: string,
  options: { taskExists(id: number): boolean; thisName?: string }): { text: string; taskIds: number[] } {
  const taskIds: number[] = [];
  let out = "";
  let i = 0;
  const isTokenStart = (c: string) => /[0-9A-Za-z_.$"]/.test(c);
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (!isTokenStart(c)) {
      out += c;
      i++;
      continue;
    }
    let j = i;
    if (c === '"') {
      j = text.indexOf('"', i + 1);
      j = j < 0 ? text.length : j + 1;
    } else {
      while (j < text.length && /[0-9A-Za-z_.$]/.test(text[j])) j++;
    }
    let token = c === '"' ? text.slice(i + 1, Math.max(i + 1, j - 1)) : text.slice(i, j);
    i = j;
    const id = taskIdOf(token);
    if (id >= 0 && !/^[0-9]/.test(token)) {
      if (!options.taskExists(id)) token = "0";
      else if (!taskIds.includes(id)) taskIds.push(id);
    }
    if (token.startsWith("this.") && options.thisName) token = `${options.thisName}.${token.slice(5)}`;
    if (token.includes(".isExists")) token = "1";
    out += token;
  }
  return { text: out, taskIds };
}

/** FUN_004e8470: decimal digits immediately before the first '.' (or the end); -1 if none. */
function taskIdOf(token: string): number {
  const dot = token.indexOf(".");
  let k = (dot < 0 ? token.length : dot) - 1;
  let digits = "";
  while (k >= 0 && token[k] >= "0" && token[k] <= "9") digits = token[k--] + digits;
  return digits ? Number.parseInt(digits, 10) : -1;
}
