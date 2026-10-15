/**
 * QVM interpreter: synthetic programs pin the recovered opcode semantics;
 * the real AI / mission / menu scripts (skipped when the staged game files
 * are absent) are run against a recording mock host for every AIEVENT_*.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readQvmCallTree, type QvmCall, type QvmValue } from "../src/loaders/qvm";
import {
  QVM_AI_EVENTS,
  QVM_CONSTANTS,
  QVM_HOST_FUNCTIONS,
  QVM_OPCODES,
  QvmError,
  disassembleQvm,
  evaluateQvmExpression,
  loadQvmProgram,
  parseQvmExpression,
  prepareQvmTaskExpression,
  qvmRoundToInt,
  runQvm,
  type QvmHost,
  type QvmHostResult,
  type QvmRuntimeValue,
} from "../src/loaders/qvm-vm";
import { RAW_ROOT, readRaw } from "./helpers";

// ---------------------------------------------------------------------------
// Synthetic program builder (no game data)
// ---------------------------------------------------------------------------

const u32 = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const f32 = (v: number) => Array.from(new Uint8Array(new Float32Array([v]).buffer));

type Block = (base: number) => number[];
const bytes = (...b: number[]): Block => () => b;
const seq = (...blocks: Block[]): Block => (base) => {
  const out: number[] = [];
  for (const block of blocks) out.push(...block(base + out.length));
  return out;
};
/** `PUSHIIB sym; CALL n, offsets; BRA end; (arg BRK)*` - the compiler's call layout. */
const call = (sym: number, ...args: Block[]): Block => (base) => {
  const head = 2 + 5 + 4 * args.length + 5;
  let at = base + head;
  const offsets: number[] = [];
  const bodies: number[] = [];
  for (const arg of args) {
    offsets.push(at);
    const body = [...arg(at), 0x00];
    bodies.push(...body);
    at += body.length;
  }
  return [0x0d, sym, 0x18, ...u32(args.length), ...offsets.flatMap(u32), 0x14, ...u32(at - (base + head)), ...bodies];
};
const statement = (sym: number, ...args: Block[]) => seq(call(sym, ...args), bytes(0x12));
/** cond; BF else; then; BRA end; else: otherwise; end: */
const ifElse = (cond: Block, then: Block, otherwise: Block, branch = 0x15): Block => (base) => {
  const c = cond(base);
  const thenAt = base + c.length + 5;
  const t = then(thenAt);
  const elseAt = thenAt + t.length + 5;
  const e = otherwise(elseAt);
  return [...c, branch, ...u32(elseAt - thenAt), ...t, 0x14, ...u32(e.length), ...e];
};

function fixture(code: number[], symbols: string[], literals: string[] = [], revision = 5): ArrayBuffer {
  const out: number[] = new Array(60).fill(0);
  const put = (at: number, v: number) => out.splice(at, 4, ...u32(v));
  "LOOP".split("").forEach((c, i) => (out[i] = c.charCodeAt(0)));
  put(4, 8);
  put(8, revision);
  const section = (values: string[], header: number) => {
    const table = out.length;
    values.forEach(() => out.push(0, 0, 0, 0));
    const pool = out.length;
    values.forEach((v, i) => {
      put(table + i * 4, out.length - pool);
      out.push(...v.split("").map((c) => c.charCodeAt(0)), 0);
    });
    put(header, table);
    put(header + 4, pool);
    put(header + 8, pool - table);
    put(header + 12, out.length - pool);
  };
  section(symbols, 12);
  section(literals, 28);
  put(44, out.length);
  put(48, code.length);
  out.push(...code);
  return new Uint8Array(out).buffer;
}

interface Recorded {
  name: string;
  args: (number | string)[];
}

/** Records every host call with eagerly evaluated arguments. */
function recorder(results: Record<string, QvmHostResult | ((args: readonly QvmRuntimeValue[]) => QvmHostResult)> = {},
  values: Record<string, QvmRuntimeValue | number> = {}, strict = true) {
  const calls: Recorded[] = [];
  const typed: QvmRuntimeValue[][] = [];
  const host: QvmHost = {
    has: strict ? (name) => name in QVM_HOST_FUNCTIONS || name in values || name in results : undefined,
    value: (name) => values[name],
    call(name, args) {
      calls.push({ name, args: args.map((a) => a.value) });
      typed.push([...args]);
      const r = results[name];
      return typeof r === "function" ? r(args) : r;
    },
  };
  return { host, calls, typed };
}

describe("QVM opcode table", () => {
  it("names all 49 opcodes in the exe's order", () => {
    expect(QVM_OPCODES).toHaveLength(49);
    expect(QVM_OPCODES.map((o) => o.mnemonic).slice(0, 25).join(" ")).toBe(
      "BRK NOP PUSH PUSHB PUSHW PUSHF PUSHA PUSHS PUSHSI PUSHSIB PUSHSIW PUSHI PUSHII PUSHIIB PUSHIIW " +
        "PUSH0 PUSH1 PUSHM POP RET BRA BF BT JSR CALL",
    );
    expect(QVM_OPCODES[0x2c].mnemonic).toBe("MINUS");
    expect(QVM_OPCODES[0x30].mnemonic).toBe("ILLEGAL");
  });

  it("recovers the AIEVENT and AIACTIONFLAG values from the registration code", () => {
    expect(QVM_CONSTANTS.AIEVENT_CREATE).toEqual({ type: "int", value: 0 });
    expect(QVM_CONSTANTS.AIEVENT_DEAD).toEqual({ type: "int", value: 2 });
    expect(QVM_CONSTANTS.AIEVENT_FRIENDLYDETECTION).toEqual({ type: "int", value: 23 });
    expect(QVM_CONSTANTS.AIACTIONFLAG_PUSHABLE).toEqual({ type: "int", value: 1 });
    expect(QVM_CONSTANTS.AITYPE_SPETNAZ_GUARD_SPAS).toEqual({ type: "int", value: 28 });
    expect(QVM_CONSTANTS.WORLD_METER).toEqual({ type: "float", value: 4096 });
  });
});

describe("QVM interpreter semantics (synthetic programs)", () => {
  const SYMS = ["Out", "WORLD_METER", "Side", "Nope", "AIFunction_GetRandomValue"];
  const OUT = 0;
  const run = (code: Block, literals: string[] = [], host = recorder({}, {}, false)) => {
    const program = loadQvmProgram(fixture(seq(code, bytes(0x00))(0), SYMS, literals));
    runQvm(program, host.host);
    return host;
  };

  it("integer, float and mixed arithmetic follow the native handlers", () => {
    const { typed } = run(
      seq(
        statement(OUT, bytes(0x03, 7, 0x03, 2, 0x2c, 0x1c)), // 7 / -2
        statement(OUT, bytes(0x03, 10, 0x0d, 1, 0x1b)), // 10 * WORLD_METER
        statement(OUT, bytes(0x10, 0x05, ...f32(0.5), 0x19)), // 1 + 0.5
        statement(OUT, bytes(0x03, 0x80)), // PUSHB is sign-extended
        statement(OUT, bytes(0x04, 0x00, 0x80)), // PUSHW is sign-extended
        statement(OUT, bytes(0x03, 5, 0x05, ...f32(3.5), 0x28)), // 5 > 3.5
        statement(OUT, bytes(0x03, 5, 0x2d)), // ~5
        statement(OUT, bytes(0x0f, 0x2e)), // !0
        statement(OUT, bytes(0x03, 1, 0x03, 31, 0x1d)), // 1 << 31 wraps
      ),
    );
    expect(typed.map((a) => a[0])).toEqual([
      { type: "int", value: -3 },
      { type: "float", value: 40960 },
      { type: "float", value: 1.5 },
      { type: "int", value: -128 },
      { type: "int", value: -32768 },
      { type: "int", value: 1 },
      { type: "int", value: -6 },
      { type: "int", value: 1 },
      { type: "int", value: -2147483648 },
    ]);
  });

  it("strings concatenate with ADD and compare like strcmp", () => {
    const { calls } = run(
      seq(statement(OUT, bytes(0x09, 0, 0x09, 1, 0x19)), statement(OUT, bytes(0x09, 0, 0x09, 2, 0x26))),
      ["ab", "c", "b"],
    );
    expect(calls).toEqual([{ name: "Out", args: ["abc"] }, { name: "Out", args: [1] }]);
  });

  it("LAND evaluates both operands (no short circuit in compiled code)", () => {
    const { calls } = run(statement(OUT, seq(bytes(0x0f), call(2), bytes(0x22))));
    expect(calls).toEqual([{ name: "Side", args: [] }, { name: "Out", args: [0] }]);
  });

  it("BF and BT branch on zero / non-zero", () => {
    const { calls } = run(
      seq(
        ifElse(bytes(0x0f), statement(OUT, bytes(0x03, 1)), statement(OUT, bytes(0x03, 2))),
        ifElse(bytes(0x0f), statement(OUT, bytes(0x03, 3)), statement(OUT, bytes(0x03, 4)), 0x16),
      ),
    );
    expect(calls.map((c) => c.args[0])).toEqual([2, 3]);
  });

  it("float host results feed comparisons (GetRandomValue(1) > 0.5)", () => {
    const host = recorder({ AIFunction_GetRandomValue: 0.75 }, {}, false);
    run(statement(OUT, seq(call(4, bytes(0x10)), bytes(0x05, ...f32(0.5), 0x28))), [], host);
    expect(host.typed[0]).toEqual([{ type: "int", value: 1 }]);
    expect(host.typed[1]).toEqual([{ type: "int", value: 1 }]);
  });

  it("lazy hosts read typed arguments with the exe's conversions", () => {
    const seen: number[] = [];
    const host: QvmHost = {
      lazyArgs: () => true,
      call(_name, args, ctx) {
        expect(args).toEqual([]);
        for (let i = 0; i < ctx.argc; i++) seen.push(ctx.argInt(i));
        seen.push(ctx.argFloat(0));
        expect(ctx.argString(0)).toBe("");
      },
    };
    const program = loadQvmProgram(
      fixture(
        seq(
          statement(OUT, bytes(0x05, ...f32(2.5)), bytes(0x05, ...f32(3.5)), bytes(0x05, ...f32(-2.5)), bytes(0x09, 0)),
          bytes(0x00),
        )(0),
        SYMS,
        ["text"],
      ),
    );
    runQvm(program, host);
    // GetArgInt is fistp in igi.exe's chop mode: 2.5 -> 2, 3.5 -> 3, -2.5 -> -2.
    expect(seen).toEqual([2, 3, -2, 0, 2.5]);
    expect(qvmRoundToInt(0.5)).toBe(0);
    expect(qvmRoundToInt(1.5)).toBe(1);
    expect(qvmRoundToInt(-1.75)).toBe(-1); // WinMain's per-frame check (0x48dbc1)
    expect(qvmRoundToInt(3e9)).toBe(-1294967296); // fistp QWORD, low dword
    expect(qvmRoundToInt(Number.NaN)).toBe(0); // low dword of the integer indefinite
  });

  it("faults like the exe: unknown identifiers, illegal opcodes, integer divide by zero", () => {
    const strict = recorder({}, {}, true);
    expect(() => run(statement(3), [], strict)).toThrow(/unknown identifier "Nope" at code 0x0/);
    expect(() => run(bytes(0x13))).toThrow(/illegal instruction RET at code 0x0/);
    expect(() => run(statement(OUT, bytes(0x10, 0x0f, 0x1c)))).toThrow(QvmError);
  });

  it("rejects malformed programs with the offending offset", () => {
    const ok = seq(statement(OUT, bytes(0x10)), bytes(0x00))(0);
    expect(() => loadQvmProgram(fixture(ok, SYMS))).not.toThrow();
    const bad = new Uint8Array(fixture(ok, SYMS));
    bad[0] = 0x4d;
    expect(() => loadQvmProgram(bad.buffer)).toThrow(/LOOP version 8/);
    expect(() => loadQvmProgram(fixture(ok, SYMS, [], 4))).toThrow(/requires > 4/);
    expect(() => loadQvmProgram(fixture([0x10, 0x12], SYMS))).toThrow(/does not end with BRK/);
    expect(() => loadQvmProgram(fixture([0x31, 0x00], SYMS))).toThrow(/unknown opcode 0x31 at code 0x0/);
    expect(() => loadQvmProgram(fixture([0x14, 1, 0, 0, 0, 0x03, 5, 0x12, 0x00], SYMS))).toThrow(/not an instruction boundary/);
  });
});

describe("QVM string expressions (task conditions)", () => {
  const scope = (values: Record<string, number>, warnings: string[] = []) => ({
    value: (name: string) => values[name],
    warn: (m: string) => warnings.push(m),
  });

  it("uses C precedence with unary operators binding tightest", () => {
    expect(evaluateQvmExpression("1 + 2 * 3 == 7", scope({}))).toBe(1);
    expect(evaluateQvmExpression("-2 * 3", scope({}))).toBe(-6);
    expect(evaluateQvmExpression("!0 + 1", scope({}))).toBe(2);
    expect(evaluateQvmExpression("1 || 0 && 0", scope({}))).toBe(1);
  });

  it("evaluates objects.qvm-style conditions in float mode", () => {
    const v = { "AreaActivate_303.nActive": 1, "Door_402.isClosed": 1, "Door_403.isClosed": 0 };
    expect(evaluateQvmExpression("AreaActivate_303.nActive &&\n(Door_402.isClosed && Door_403.isClosed)", scope(v))).toBe(0);
    const t = { "CutScene_1204.nTick": 331, GAME_FREQUENCY: 30 };
    expect(evaluateQvmExpression("CutScene_1204.nTick > 11.35*GAME_FREQUENCY", scope(t))).toBe(0);
    expect(evaluateQvmExpression("CutScene_1204.nTick > 11.35*GAME_FREQUENCY", scope(t), "int")).toBe(1);
  });

  it("short-circuits && / ||, truncates ?: conditions and drops integer operators in float mode", () => {
    let called = 0;
    const s = { value: (name: string) => (name === "f" ? (called++, 1) : undefined) };
    expect(evaluateQvmExpression("0 && f()", s)).toBe(0);
    expect(called).toBe(0);
    // The ?: condition goes through fistp (0x4af992) in chop mode: 0.4 and 0.6 are 0, 1.2 and -1.5 are not.
    expect(evaluateQvmExpression("0.4 ? 10 : 20", s)).toBe(20);
    expect(evaluateQvmExpression("0.6 ? 10 : 20", s)).toBe(20);
    expect(evaluateQvmExpression("1.2 ? 10 : 20", s)).toBe(10);
    expect(evaluateQvmExpression("-1.5 ? 10 : 20", s)).toBe(10);
    // Float-mode arithmetic is double FMUL/FADD in chop mode: 24.7 * 30 = 740.9999999999999 (not 741).
    expect(evaluateQvmExpression("24.7 * 30", s)).toBe(740.9999999999999);
    expect(evaluateQvmExpression("741 > 24.7 * 30", s)).toBe(1);
    expect(evaluateQvmExpression("2.7", s, "int")).toBe(2);
    expect(evaluateQvmExpression("6 & 3", s)).toBe(0);
    expect(evaluateQvmExpression("6 & 3", s, "int")).toBe(2);
    const warnings: string[] = [];
    expect(evaluateQvmExpression("1 / 0 + missing", scope({}, warnings))).toBe(0);
    expect(warnings).toEqual(["division by zero", "Unknown identifier 'missing' in expression"]);
  });

  it("rewrites task references like FUN_004e80a0", () => {
    const exists = (id: number) => id !== 999;
    expect(
      prepareQvmTaskExpression("AreaActivate_303.nActive &&\n(Door_402.isClosed && Door_999.isClosed)", { taskExists: exists }),
    ).toEqual({ text: "AreaActivate_303.nActive&&(Door_402.isClosed&&0)", taskIds: [303, 402] });
    expect(prepareQvmTaskExpression("Foo_5.isExists || Foo_999.isExists", { taskExists: exists }).text).toBe("1||0");
    expect(prepareQvmTaskExpression("this.nTick > 1.5", { taskExists: exists, thisName: "LevelTimer_95" }).text).toBe(
      "LevelTimer_95.nTick>1.5",
    );
  });
});

// ---------------------------------------------------------------------------
// Real scripts
// ---------------------------------------------------------------------------

const GUARD = "common/ai/guard.qvm";
const haveRaw = existsSync(`${RAW_ROOT}/${GUARD}`);

function stagedQvms(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(`${RAW_ROOT}/${dir}`)) {
      const rel = dir ? `${dir}/${name}` : name;
      if (statSync(`${RAW_ROOT}/${rel}`).isDirectory()) walk(rel);
      else if (name.toLowerCase().endsWith(".qvm")) out.push(rel);
    }
  };
  walk("");
  return out.sort();
}

/** Mock AI host: answers GetCurrentEventType with `event`; other getters from `results`. */
function aiHost(event: number, results: Record<string, QvmHostResult> = {}, values: Record<string, number> = {}) {
  return recorder({ AIFunction_GetCurrentEventType: event, ...results }, values, true);
}
const withoutEventQueries = (calls: Recorded[]) => calls.filter((c) => c.name !== "AIFunction_GetCurrentEventType");
const ev = (name: string) => QVM_AI_EVENTS.indexOf(name);

describe.skipIf(!haveRaw)("QVM interpreter on the shipped scripts", () => {
  it("loads and runs every staged .qvm (AI scripts once per AIEVENT)", async () => {
    const files = stagedQvms();
    expect(files.length).toBeGreaterThan(90);
    let runs = 0;
    for (const file of files) {
      const program = loadQvmProgram(await readRaw(file));
      expect(disassembleQvm(program)).toHaveLength(program.offsets.length);
      const ai = /(^|\/)ai\//i.test(file) && !/settings\.qvm$/i.test(file);
      for (const event of ai ? QVM_AI_EVENTS.map((_, i) => i) : [0]) {
        const host: QvmHost = {
          value: () => 0,
          call: (name) => (name === "AIFunction_GetCurrentEventType" ? event : undefined),
        };
        runQvm(program, host);
        runs++;
      }
    }
    expect(runs).toBeGreaterThan(1000);
  });

  it("guard.qvm on AIEVENT_CREATE sets event priorities, then the view cone", async () => {
    const program = loadQvmProgram(await readRaw(GUARD));
    const { host, calls } = aiHost(ev("AIEVENT_CREATE"));
    runQvm(program, host);
    const made = withoutEventQueries(calls);
    expect(made.slice(-4)).toEqual([
      { name: "AIFunction_SetViewLength", args: [40] },
      { name: "AIFunction_SetAlarmViewLength", args: [50] },
      { name: "AIFunction_SetViewAlpha", args: [50] },
      { name: "AIFunction_SetViewGamma", args: [45] },
    ]);
    const priorities = made.filter((c) => c.name === "AIFunction_SetEventPriority").map((c) => QVM_AI_EVENTS[c.args[0] as number]);
    expect(priorities).toEqual([
      "AIEVENT_DEAD", "AIEVENT_ALARMOFF", "AIEVENT_FLASHBANG", "AIEVENT_GRENADETHROWN", "AIEVENT_GRENADELAND",
      "AIEVENT_COMBAT", "AIEVENT_ALERT", "AIEVENT_ENEMYDETECTION", "AIEVENT_GUNSHOT", "AIEVENT_TAKINGDAMAGE",
      "AIEVENT_GUNSHOTMISS", "AIEVENT_WALK", "AIEVENT_GROUNDIMPACT", "AIEVENT_DOOR", "AIEVENT_FENCE",
      "AIEVENT_ALARMON", "AIEVENT_EXPLOSION", "AIEVENT_ANIMATION", "AIEVENT_IDLE", "AIEVENT_CREATE",
    ]);
    expect(made).toHaveLength(24);
  });

  it("guard.qvm reacts to each event with the original host-call sequence", async () => {
    const program = loadQvmProgram(await readRaw(GUARD));
    const trace = (event: string, results: Record<string, QvmHostResult> = {}) => {
      const { host, calls } = aiHost(ev(event), results);
      runQvm(program, host);
      return withoutEventQueries(calls);
    };
    expect(trace("AIEVENT_DEAD")).toEqual([{ name: "AIAction_Dead", args: [0] }]);
    expect(trace("AIEVENT_IDLE")).toEqual([{ name: "AIAction_Idle", args: [1] }]);
    expect(trace("AIEVENT_ALARMOFF")).toEqual([{ name: "AIFunction_RemoveAlarmActions", args: [] }]);
    expect(trace("AIEVENT_FLASHBANG")).toEqual([{ name: "AIAction_PlayAnimation", args: [39, 0] }]);
    expect(trace("AIEVENT_GRENADETHROWN", { AIFunction_GetRandomValue: 0.9 })).toEqual([
      { name: "AIFunction_GetRandomValue", args: [1] },
      { name: "AIAction_RunPanicking", args: [10, 0] },
    ]);
    expect(trace("AIEVENT_GRENADETHROWN", { AIFunction_GetRandomValue: 0.2 })).toEqual([
      { name: "AIFunction_GetRandomValue", args: [1] },
    ]);
    expect(trace("AIEVENT_ALERT")).toEqual([
      { name: "AIFunction_SendResponse", args: [] },
      { name: "AIAction_SetCombat", args: [1] },
    ]);
    expect(trace("AIEVENT_DOOR", { AIFunction_IsEventBehind: 0 })).toEqual([
      { name: "AIFunction_IsEventBehind", args: [] },
      { name: "AIAction_LookAtEvent", args: [1, 0] },
    ]);
    expect(trace("AIEVENT_ALARMON")).toEqual([]);
  });

  it("level1/ai/2209.qvm on create: default handler, alarm control 98, view length 20", async () => {
    const program = loadQvmProgram(await readRaw("missions/location0/level1/ai/2209.qvm"));
    const { host, calls } = aiHost(ev("AIEVENT_CREATE"));
    runQvm(program, host);
    expect(calls).toEqual([
      { name: "AIFunction_GetCurrentEventType", args: [] },
      { name: "AIFunction_DefaultHandler", args: [] },
      { name: "AIFunction_SetAlarmControlID", args: [98] },
      { name: "AIFunction_SetViewLength", args: [20] },
    ]);
    const idle = aiHost(ev("AIEVENT_IDLE"));
    runQvm(program, idle.host);
    expect(withoutEventQueries(idle.calls)).toEqual([{ name: "AIAction_Patrol", args: [2409, 0, 0] }]);
  });

  it("every level-1 soldier script falls back to AIFunction_DefaultHandler", async () => {
    const files = stagedQvms().filter((f) => f.startsWith("missions/location0/level1/ai/"));
    expect(files).toHaveLength(37);
    for (const file of files) {
      const program = loadQvmProgram(await readRaw(file));
      for (const event of ["AIEVENT_CREATE", "AIEVENT_COMBAT", "AIEVENT_DOOR"]) {
        const { host, calls } = aiHost(ev(event), {}, { "AnimTask_1599.isRun": 0, "CutScene_1200.nTick": 0, "CutScene_1203.nTick": 0 });
        runQvm(program, host);
        expect(withoutEventQueries(calls).map((c) => c.name), `${file} ${event}`).toContain("AIFunction_DefaultHandler");
      }
    }
  });

  it("task members gate soldier animations (1566 AnimTask_1599.isRun, 1667 CutScene_1200.nTick)", async () => {
    const p1566 = loadQvmProgram(await readRaw("missions/location0/level1/ai/1566.qvm"));
    const run1566 = (isRun: number) => {
      const { host, calls } = aiHost(ev("AIEVENT_IDLE"), {}, { "AnimTask_1599.isRun": isRun });
      runQvm(p1566, host);
      return withoutEventQueries(calls);
    };
    expect(run1566(1)).toEqual([{ name: "AIAction_PlayAnimation", args: [242, 0] }]);
    expect(run1566(0)).toEqual([]);
    const p1667 = loadQvmProgram(await readRaw("missions/location0/level1/ai/1667.qvm"));
    const { host, calls } = aiHost(ev("AIEVENT_IDLE"), {}, { "CutScene_1200.nTick": 561 });
    runQvm(p1667, host);
    expect(withoutEventQueries(calls)[0]).toEqual({ name: "AIAction_PlayAnimation", args: [242, 0] });
  });

  it("sniper.qvm calls AIAction_LookAtToEvent, which igi.exe never registers", async () => {
    const program = loadQvmProgram(await readRaw("common/ai/sniper.qvm"));
    const { host } = aiHost(ev("AIEVENT_DOOR"), { AIFunction_IsEventBehind: 0 });
    expect(() => runQvm(program, host)).toThrow(/unknown identifier "AIAction_LookAtToEvent" at code 0x392/);
  });

  it("mission.qvm defines mission 1", async () => {
    const program = loadQvmProgram(await readRaw("missions/location0/level1/mission.qvm"));
    const { host, calls } = recorder({}, {}, true);
    runQvm(program, host);
    expect(calls).toEqual([
      {
        name: "DefineMission",
        args: [1, "Mission 1 Name", "Mission 1 Desc", "", -1, "missions/location0/level1", "missions/location0/common",
          "missions/location0/level1", "location0", "level1", "mission1.spr"],
      },
    ]);
  });

  it("lazy Task_New builds parents before children, as the exe's context switch requires", async () => {
    const buffer = await readRaw("menusystem/mainmenu.qvm");
    const program = loadQvmProgram(buffer);
    const lazyOrder: string[] = [];
    runQvm(program, {
      lazyArgs: (name) => name === "Task_New",
      call(name, _args, ctx) {
        if (name !== "Task_New") return;
        lazyOrder.push(ctx.argString(2, 0x40));
        for (let i = 3; i < ctx.argc; i++) ctx.arg(i);
      },
    });
    const eagerOrder: string[] = [];
    runQvm(program, {
      call(name, args) {
        if (name === "Task_New") eagerOrder.push(args[2].value as string);
      },
    });
    const pre: string[] = [];
    const post: string[] = [];
    const walk = (node: QvmCall) => {
      pre.push(node.args[2] as string);
      node.args.filter((a: QvmValue): a is QvmCall => typeof a === "object" && a !== null && "fn" in a).forEach(walk);
      post.push(node.args[2] as string);
    };
    readQvmCallTree(buffer).filter((s) => s.fn === "Task_New").forEach(walk);
    expect(pre).toHaveLength(191);
    expect(lazyOrder).toEqual(pre);
    expect(eagerOrder).toEqual(post);
  });

  it("parses and evaluates every condition expression in objects.qvm", async () => {
    const program = loadQvmProgram(await readRaw("missions/location0/level1/objects.qvm"));
    const conditions = program.literals.filter((s) => /[A-Za-z]+_\d+\.[A-Za-z]/.test(s) && !/\.spr$/.test(s));
    expect(conditions.length).toBeGreaterThan(70);
    for (const text of conditions) {
      const prepared = prepareQvmTaskExpression(text, { taskExists: () => true });
      const expr = parseQvmExpression(prepared.text);
      expect(Number.isFinite(evaluateQvmExpression(expr, { value: () => 0 }))).toBe(true);
    }
  });
});
