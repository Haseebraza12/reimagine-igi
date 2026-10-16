/**
 * LOOP v8 `.qvm` script reader: header tables + a static call-tree parser.
 *
 * The bytecode is never executed. Mission data files such as `objects.qvm`
 * and `magicobj.qvm` are pure declarations: a list of top-level calls whose
 * arguments are literals or nested calls. This module recovers exactly that
 * tree and rejects anything else.
 *
 * Header (u32 little endian; confidence: observed, docs/qvm.md):
 *   0  "LOOP"            4  version 8
 *   12 symbol-offset table     16 symbol-string pool
 *   20 symbol table bytes      24 symbol pool bytes
 *   28 literal-offset table    32 literal-string pool
 *   36 literal table bytes     40 literal pool bytes
 *   44 bytecode offset         48 bytecode bytes (bytecode ends at EOF)
 *
 * Opcodes (confidence noted per row; unknown opcodes throw):
 *   00 BRK           02 PUSH u32       03 PUSH u8       04 PUSH u16
 *   05 PUSHF f32     09 PUSHS u8       0a PUSHS u16     0d PUSHI u8
 *   0f PUSH 0        10 PUSH 1         12 POP           14 BRA s32
 *   18 CALL n, n*u32 2c MINUS (unary negate)
 * 00, 03-18 are validated against the shipped config.qsc/.qas/.qvm triplet.
 * 0a and 2c are recovered from objects.qvm: a full parse of that file agrees
 * with the community decompile (objects.qsc) on 18,105 of 18,127 tree nodes,
 * every disagreement being a later text edit, not a decoding error.
 * 02 is recovered from humanplayer.qvm / weaponconfig.qvm: only a 4-byte
 * operand makes those argument blocks end exactly at BRK (docs/qvm.md).
 *
 * Grammar recovered from the bytecode:
 *   statement := PUSHI fn; CALL offsets; BRA end; arg*; end: POP
 *   nested    := PUSHI fn; CALL offsets; BRA end; arg*; end: BRK
 *   arg       := (literal [MINUS] | nested | constexpr) BRK
 *   constexpr := postfix numeric literals with 19 ADD, 1a SUB, 1b MUL,
 *                1c DIV, 2b PLUS, 2c MINUS (no symbols, no calls)
 * CALL's offset table must exactly partition the region skipped by BRA.
 *
 * Constant expressions [observed: the three physicsobj/planes/*\/plane.qvm
 * scripts, e.g. `PUSHW 15000; PUSHF 1.5; MUL` for the SU-27 speed
 * normaliser 22500 and `PUSHF 0.027; PUSHB 2; MUL` for its thrust step]
 * are folded with the VM's binary-operator semantics (qvm-vm.ts,
 * FUN_004b3e50 [recovered]): int op int stays int (32-bit wrap), any float
 * operand makes the operation a float32 one (fld / f<op> / fstp DWORD in
 * chop mode); unary minus / plus as FUN_004b48b0. Opcode numbers come from
 * the exe's mnemonic table (qvm-vm.ts QVM_OPCODES). Every other opcode in
 * an argument still throws.
 */
import { x87F32Add, x87F32Div, x87F32Mul, x87F32Sub, x87StoreF32 } from "./x87";

export type QvmValue = number | string | boolean | QvmSymbol | QvmCall;

/** A reference to a host identifier other than TRUE/FALSE (e.g. "WEAPON_ID_AK47"). */
export interface QvmSymbol {
  symbol: string;
}

export interface QvmCall {
  fn: string;
  args: QvmValue[];
  /** Code-relative offset of the PUSHI that names the function. */
  codeOffset: number;
}

const OP = {
  BRK: 0x00,
  PUSH_U32: 0x02,
  PUSH_U8: 0x03,
  PUSH_U16: 0x04,
  PUSHF: 0x05,
  PUSHS_U8: 0x09,
  PUSHS_U16: 0x0a,
  PUSHI: 0x0d,
  PUSH_0: 0x0f,
  PUSH_1: 0x10,
  POP: 0x12,
  BRA: 0x14,
  CALL: 0x18,
  ADD: 0x19,
  SUB: 0x1a,
  MUL: 0x1b,
  DIV: 0x1c,
  PLUS: 0x2b,
  MINUS: 0x2c,
} as const;

function fail(message: string): never {
  throw new Error(`QVM: ${message}`);
}

function readStringTable(
  bytes: Uint8Array,
  view: DataView,
  table: number,
  tableSize: number,
  pool: number,
  poolSize: number,
  what: string,
): string[] {
  if (tableSize % 4 !== 0) fail(`${what} table size ${tableSize} is not a multiple of 4`);
  if (table + tableSize > bytes.length || pool + poolSize > bytes.length) {
    fail(`${what} section outside file`);
  }
  const out: string[] = [];
  for (let pos = table; pos < table + tableSize; pos += 4) {
    const relative = view.getUint32(pos, true);
    if (relative >= poolSize) fail(`${what} offset outside pool at 0x${pos.toString(16)}`);
    let end = pool + relative;
    while (end < pool + poolSize && bytes[end] !== 0) end++;
    if (end >= pool + poolSize) fail(`unterminated ${what} string at 0x${(pool + relative).toString(16)}`);
    let text = "";
    for (let i = pool + relative; i < end; i++) text += String.fromCharCode(bytes[i]);
    out.push(text);
  }
  return out;
}

/** Parsed LOOP v8 tables plus the bytecode slice. */
export interface QvmFile {
  symbols: string[];
  literals: string[];
  code: Uint8Array;
}

export function readQvmFile(buffer: ArrayBuffer): QvmFile {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 60) fail("file shorter than the 60-byte header");
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "LOOP" || view.getUint32(4, true) !== 8) fail("expected LOOP v8 script");
  const u = (offset: number) => view.getUint32(offset, true);
  const [symTable, symPool, symTableSize, symPoolSize] = [u(12), u(16), u(20), u(24)];
  const [litTable, litPool, litTableSize, litPoolSize] = [u(28), u(32), u(36), u(40)];
  const [code, codeSize] = [u(44), u(48)];
  if (symTable < 60 || symTable + symTableSize !== symPool) fail("invalid symbol table bounds");
  if (litTable < symPool + symPoolSize || litTable + litTableSize !== litPool) {
    fail("invalid literal table bounds");
  }
  if (litPool + litPoolSize !== code || code + codeSize !== bytes.length) {
    fail("invalid bytecode bounds");
  }
  return {
    symbols: readStringTable(bytes, view, symTable, symTableSize, symPool, symPoolSize, "symbol"),
    literals: readStringTable(bytes, view, litTable, litTableSize, litPool, litPoolSize, "literal"),
    code: bytes.slice(code, code + codeSize),
  };
}

interface Instruction {
  op: number;
  size: number;
  value?: number | string;
  isSymbol?: boolean;
  target?: number;
  argOffsets?: number[];
}

/** Instruction decoder over one script's code; throws on unknown opcodes. */
function createDecoder({ symbols, literals, code }: QvmFile): (at: number) => Instruction {
  const view = new DataView(code.buffer, code.byteOffset, code.byteLength);
  return (at: number): Instruction => {
    if (at < 0 || at >= code.length) fail(`instruction outside code at 0x${at.toString(16)}`);
    const op = code[at];
    const need = (n: number) => {
      if (at + 1 + n > code.length) fail(`truncated operand at code 0x${at.toString(16)}`);
    };
    switch (op) {
      case OP.BRK:
      case OP.POP:
      case OP.MINUS:
      case OP.PLUS:
      case OP.ADD:
      case OP.SUB:
      case OP.MUL:
      case OP.DIV:
        return { op, size: 1 };
      case OP.PUSH_0:
        return { op, size: 1, value: 0 };
      case OP.PUSH_1:
        return { op, size: 1, value: 1 };
      case OP.PUSH_U8:
        need(1);
        return { op, size: 2, value: code[at + 1] };
      case OP.PUSH_U16:
        need(2);
        return { op, size: 3, value: view.getUint16(at + 1, true) };
      case OP.PUSH_U32:
        need(4);
        return { op, size: 5, value: view.getUint32(at + 1, true) };
      case OP.PUSHF: {
        need(4);
        const value = view.getFloat32(at + 1, true);
        if (!Number.isFinite(value)) fail(`non-finite float at code 0x${at.toString(16)}`);
        return { op, size: 5, value };
      }
      case OP.PUSHS_U8:
      case OP.PUSHS_U16: {
        const wide = op === OP.PUSHS_U16;
        need(wide ? 2 : 1);
        const index = wide ? view.getUint16(at + 1, true) : code[at + 1];
        if (index >= literals.length) fail(`literal index ${index} outside table`);
        return { op, size: wide ? 3 : 2, value: literals[index] };
      }
      case OP.PUSHI: {
        need(1);
        const index = code[at + 1];
        if (index >= symbols.length) fail(`symbol index ${index} outside table`);
        return { op, size: 2, value: symbols[index], isSymbol: true };
      }
      case OP.BRA: {
        need(4);
        const target = at + 5 + view.getInt32(at + 1, true);
        if (target < 0 || target >= code.length) fail(`branch target outside code at 0x${at.toString(16)}`);
        return { op, size: 5, target };
      }
      case OP.CALL: {
        need(4);
        const count = view.getUint32(at + 1, true);
        if (at + 5 + count * 4 > code.length) fail(`CALL table exceeds code at 0x${at.toString(16)}`);
        const argOffsets: number[] = [];
        for (let i = 0; i < count; i++) argOffsets.push(view.getUint32(at + 5 + i * 4, true));
        return { op, size: 5 + count * 4, argOffsets };
      }
      default:
        fail(`unsupported opcode 0x${op.toString(16).padStart(2, "0")} at code 0x${at.toString(16)}`);
    }
  };
}

/**
 * Parse every top-level statement of a declarative LOOP v8 script into a
 * call tree. Throws on any opcode or layout outside the recovered grammar.
 */
export function readQvmCallTree(buffer: ArrayBuffer): QvmCall[] {
  const file = readQvmFile(buffer);
  const { code } = file;
  const decode = createDecoder(file);

  const parseCall = (at: number, terminator: number): { call: QvmCall; next: number } => {
    const name = decode(at);
    if (name.op !== OP.PUSHI) fail(`expected PUSHI function at code 0x${at.toString(16)}`);
    const callAt = at + name.size;
    const call = decode(callAt);
    if (call.op !== OP.CALL) fail(`expected CALL at code 0x${callAt.toString(16)}`);
    const braAt = callAt + call.size;
    const bra = decode(braAt);
    if (bra.op !== OP.BRA) fail(`expected BRA at code 0x${braAt.toString(16)}`);
    const start = braAt + bra.size;
    const end = bra.target!;
    const offsets = call.argOffsets!;
    const partitions =
      offsets.length === 0
        ? start === end
        : offsets[0] === start &&
          offsets.every((o, i) => i === 0 || offsets[i - 1] < o) &&
          offsets[offsets.length - 1] < end;
    if (!partitions) fail(`CALL arguments do not partition the skipped region at code 0x${callAt.toString(16)}`);
    const args = offsets.map((o, i) => parseArgument(o, i + 1 < offsets.length ? offsets[i + 1] : end));
    const term = decode(end);
    if (term.op !== terminator) {
      fail(`call at code 0x${at.toString(16)} ends with opcode 0x${term.op.toString(16)}`);
    }
    return { call: { fn: String(name.value), args, codeOffset: at }, next: end + 1 };
  };

  const parseArgument = (start: number, end: number): QvmValue => {
    const first = decode(start);
    if (first.op === OP.PUSHI && first.value !== "TRUE" && first.value !== "FALSE") {
      const following = start + first.size < end ? decode(start + first.size) : null;
      if (following && following.op === OP.CALL) {
        const { call, next } = parseCall(start, OP.BRK);
        if (next !== end) fail(`nested call at code 0x${start.toString(16)} does not fill its argument`);
        return call;
      }
    }
    let at = start + first.size;
    let negate = false;
    let op = decode(at);
    if (op.op === OP.MINUS) {
      if (typeof first.value !== "number") fail(`MINUS applied to a non-number at code 0x${start.toString(16)}`);
      negate = true;
      at += op.size;
      op = decode(at);
    }
    if (op.op !== OP.BRK || at + 1 !== end) {
      if (!first.isSymbol && typeof first.value === "number") return foldConstant(start, end);
      fail(`unsupported argument expression at code 0x${start.toString(16)}`);
    }
    if (first.isSymbol) {
      if (first.value === "TRUE") return true;
      if (first.value === "FALSE") return false;
      return { symbol: String(first.value) };
    }
    if (first.value === undefined) {
      fail(`argument at code 0x${start.toString(16)} does not start with a literal`);
    }
    if (typeof first.value === "number") return negate ? -first.value : first.value;
    return first.value;
  };

  /**
   * A numeric constant expression argument (postfix, see the header): every
   * instruction up to the block's BRK must be a numeric literal push or one
   * of ADD / SUB / MUL / DIV / PLUS / MINUS, leaving exactly one value.
   */
  const foldConstant = (start: number, end: number): number => {
    const stack: Array<{ int: boolean; value: number }> = [];
    let at = start;
    while (at < end) {
      const ins = decode(at);
      if (ins.op === OP.BRK) break;
      if (typeof ins.value === "number" && !ins.isSymbol) {
        stack.push({ int: ins.op !== OP.PUSHF, value: ins.value });
      } else if (ins.op === OP.MINUS || ins.op === OP.PLUS) {
        const v = stack.pop() ?? fail(`unary operator without operand at code 0x${at.toString(16)}`);
        if (ins.op === OP.MINUS) stack.push({ int: v.int, value: v.int ? -v.value | 0 : -v.value });
        else stack.push(v);
      } else if (ins.op === OP.ADD || ins.op === OP.SUB || ins.op === OP.MUL || ins.op === OP.DIV) {
        const b = stack.pop();
        const a = stack.pop();
        if (!a || !b) fail(`binary operator without operands at code 0x${at.toString(16)}`);
        if (a.int && b.int) {
          if (ins.op === OP.DIV && b.value === 0) fail(`integer division by zero at code 0x${at.toString(16)}`);
          const r = ins.op === OP.ADD ? (a.value + b.value) | 0 : ins.op === OP.SUB ? (a.value - b.value) | 0
            : ins.op === OP.MUL ? Math.imul(a.value, b.value) : Math.trunc(a.value / b.value) | 0;
          stack.push({ int: true, value: r });
        } else {
          // Operands popped as float32 (an int via fild + fstp DWORD), one float32 operation.
          const x = x87StoreF32(a.value);
          const y = x87StoreF32(b.value);
          const r = ins.op === OP.ADD ? x87F32Add(x, y) : ins.op === OP.SUB ? x87F32Sub(x, y) : ins.op === OP.MUL ? x87F32Mul(x, y) : x87F32Div(x, y);
          stack.push({ int: false, value: r });
        }
      } else {
        fail(`unsupported argument expression at code 0x${start.toString(16)}`);
      }
      at += ins.size;
    }
    if (at + 1 !== end || stack.length !== 1) fail(`unsupported argument expression at code 0x${start.toString(16)}`);
    return stack[0].value;
  };

  const statements: QvmCall[] = [];
  let pos = 0;
  while (pos < code.length) {
    if (code[pos] === OP.BRK && pos + 1 === code.length) return statements;
    const { call, next } = parseCall(pos, OP.POP);
    statements.push(call);
    pos = next;
  }
  fail("bytecode does not end with BRK");
}

/**
 * For executable scripts (AI handlers), whose control flow is not decoded:
 * every call site of each named function whose single argument is a numeric
 * literal, as `PUSHI fn; CALL [arg]; BRA end; <literal> BRK; <POP|BRK>`.
 * Call sites are located by their PUSHI bytes and accepted only when that
 * whole layout decodes and the CALL table partitions the skipped region, so a
 * stray byte match is rejected rather than misread.
 */
export function readQvmLiteralCalls(buffer: ArrayBuffer, names: readonly string[]): Map<string, number[]> {
  const file = readQvmFile(buffer);
  const { code, symbols } = file;
  const decode = createDecoder(file);
  const out = new Map<string, number[]>();
  for (const name of names) {
    const index = symbols.indexOf(name);
    const values: number[] = [];
    if (index >= 0 && index < 256) {
      for (let at = code.indexOf(OP.PUSHI); at >= 0; at = code.indexOf(OP.PUSHI, at + 1)) {
        if (code[at + 1] !== index) continue;
        try {
          const call = decode(at + 2);
          if (call.op !== OP.CALL || call.argOffsets!.length !== 1) continue;
          const braAt = at + 2 + call.size;
          const bra = decode(braAt);
          if (bra.op !== OP.BRA || call.argOffsets![0] !== braAt + bra.size) continue;
          const literal = decode(call.argOffsets![0]);
          if (typeof literal.value !== "number" || literal.isSymbol) continue;
          const brk = call.argOffsets![0] + literal.size;
          if (decode(brk).op !== OP.BRK || brk + 1 !== bra.target) continue;
          const term = decode(bra.target!).op;
          if (term !== OP.POP && term !== OP.BRK) continue;
          values.push(literal.value);
        } catch {
          // Not a decodable call site at this byte offset.
        }
      }
    }
    out.set(name, values);
  }
  return out;
}

export function isQvmCall(value: QvmValue): value is QvmCall {
  return typeof value === "object" && value !== null && "fn" in value;
}

export function isQvmSymbol(value: QvmValue): value is QvmSymbol {
  return typeof value === "object" && value !== null && "symbol" in value;
}
