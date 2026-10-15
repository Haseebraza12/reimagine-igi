/**
 * QVM call trees, mission tasks, MEF models, MTP tables and ILSF sounds,
 * checked against the real staged game files (skipped when absent) plus
 * synthetic fixtures for the failure paths.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readIlffMembers } from "../src/loaders/ilff";
import { decodeIlsf } from "../src/loaders/ilsf";
import { readMef } from "../src/loaders/mef";
import { readMtp } from "../src/loaders/mtp";
import { isQvmCall, readQvmCallTree, readQvmLiteralCalls, type QvmValue } from "../src/loaders/qvm";
import { flattenTasks, readTaskTree, vec3Param } from "../src/loaders/tasks";
import { RAW_ROOT, readRaw } from "./helpers";

const OBJECTS = "missions/location0/level1/objects.qvm";
const MODELS = "missions/location0/level1/models/level1.res";
const MTP = "missions/location0/level1/level1.mtp";
const TEXTURES = "missions/location0/level1/textures/level1.res";
const SOUNDS = "common/sounds/sounds.res";
const WEAPONS = "weapons/weaponconfig.qvm";
const haveRaw = existsSync(`${RAW_ROOT}/${OBJECTS}`) && existsSync(`${RAW_ROOT}/${SOUNDS}`);

/** Build a minimal LOOP v8 file around `code` with the given tables. */
function qvmFixture(code: number[], symbols: string[], literals: string[]): ArrayBuffer {
  const out: number[] = new Array(60).fill(0);
  const u32 = (at: number, v: number) => {
    out[at] = v & 255;
    out[at + 1] = (v >>> 8) & 255;
    out[at + 2] = (v >>> 16) & 255;
    out[at + 3] = (v >>> 24) & 255;
  };
  "LOOP".split("").forEach((c, i) => (out[i] = c.charCodeAt(0)));
  u32(4, 8);
  const section = (values: string[], header: number) => {
    const table = out.length;
    const pool: number[] = [];
    for (const v of values) {
      const at = out.length;
      out.push(0, 0, 0, 0);
      u32(at, pool.length);
      for (const ch of v) pool.push(ch.charCodeAt(0));
      pool.push(0);
    }
    const start = out.length;
    out.push(...pool);
    u32(header, table);
    u32(header + 4, start);
    u32(header + 8, values.length * 4);
    u32(header + 12, pool.length);
  };
  section(symbols, 12);
  section(literals, 28);
  u32(44, out.length);
  u32(48, code.length);
  out.push(...code);
  return new Uint8Array(out).buffer;
}

/** `PUSHI fn; CALL args; BRA end; args; end: terminator` with byte arguments. */
function callBytes(fnSymbol: number, args: number[][], terminator: number, base = 0): number[] {
  const header = 2 + 5 + args.length * 4 + 5;
  const offsets: number[] = [];
  let at = base + header;
  for (const a of args) {
    offsets.push(at);
    at += a.length;
  }
  const le = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  const body = args.flat();
  return [
    0x0d, fnSymbol,
    0x18, ...le(args.length), ...offsets.flatMap(le),
    0x14, ...le(body.length),
    ...body,
    terminator,
  ];
}

describe("readQvmCallTree (synthetic)", () => {
  it("decodes literals, MINUS, u32 pushes, symbols and nested calls", () => {
    const nested = callBytes(1, [[0x10, 0x00]], 0x00, 0); // computed below with real base
    const args = (base: number) => [
      [0x10, 0x2c, 0x00], // -1
      [0x02, 0xa0, 0x86, 0x01, 0x00, 0x00], // 100000
      [0x09, 0x00, 0x00], // "hello"
      [0x0d, 0x02, 0x00], // TRUE
      [0x0d, 0x03, 0x00], // symbol CONST
      callBytes(1, [[0x10, 0x00]], 0x00, base),
    ];
    // The nested call's offsets depend on where it lands; compute iteratively.
    let code = callBytes(0, args(0), 0x12);
    const nestedStart = code.length - 1 - nested.length;
    code = callBytes(0, args(nestedStart), 0x12);
    code.push(0x00);
    const tree = readQvmCallTree(qvmFixture(code, ["Outer", "Inner", "TRUE", "CONST"], ["hello"]));
    expect(tree).toHaveLength(1);
    expect(tree[0].fn).toBe("Outer");
    expect(tree[0].args.slice(0, 5)).toEqual([-1, 100000, "hello", true, { symbol: "CONST" }]);
    expect(tree[0].args[5]).toMatchObject({ fn: "Inner", args: [1] });
  });

  it("rejects unknown opcodes instead of guessing", () => {
    const code = [...callBytes(0, [[0x7e, 0x00]], 0x12), 0x00];
    expect(() => readQvmCallTree(qvmFixture(code, ["Outer"], []))).toThrow(/unsupported opcode 0x7e/);
  });

  it("rejects MINUS applied to a string", () => {
    const code = [...callBytes(0, [[0x09, 0x00, 0x2c, 0x00]], 0x12), 0x00];
    expect(() => readQvmCallTree(qvmFixture(code, ["Outer"], ["x"]))).toThrow(/MINUS/);
  });

  it("rejects bytecode that does not end with BRK", () => {
    const code = callBytes(0, [[0x10, 0x00]], 0x12);
    expect(() => readQvmCallTree(qvmFixture(code, ["Outer"], []))).toThrow();
  });
});

describe.skipIf(!existsSync(`${RAW_ROOT}/common/ai/guard.qvm`))("readQvmLiteralCalls (real AI scripts)", () => {
  const VIEW = ["AIFunction_SetViewLength", "AIFunction_SetAlarmViewLength", "AIFunction_SetViewAlpha", "AIFunction_SetViewGamma"];

  it("recovers the view constants each AI script sets on creation", async () => {
    const guard = readQvmLiteralCalls(await readRaw("common/ai/guard.qvm"), VIEW);
    expect(VIEW.map((n) => guard.get(n))).toEqual([[40], [50], [50], [45]]);
    const sniper = readQvmLiteralCalls(await readRaw("common/ai/sniper.qvm"), VIEW);
    expect(VIEW.map((n) => sniper.get(n))).toEqual([[100], [110], [30], [15]]);
    const own = readQvmLiteralCalls(await readRaw("missions/location0/level1/ai/2209.qvm"), VIEW);
    expect(own.get("AIFunction_SetViewLength")).toEqual([20]);
    expect(own.get("AIFunction_SetViewAlpha")).toEqual([]);
  });

  it("ignores byte matches that are not complete call sites", () => {
    // A PUSHI fn byte pair followed by garbage, then a real call site.
    const code = [0x0d, 0x00, 0x7e, 0x0d, 0x00, 0x18, 1, 0, 0, 0, 19, 0, 0, 0, 0x14, 3, 0, 0, 0, 0x03, 7, 0x00, 0x12, 0x00];
    const calls = readQvmLiteralCalls(qvmFixture(code, ["Fn"], []), ["Fn", "Missing"]);
    expect(calls.get("Fn")).toEqual([7]);
    expect(calls.get("Missing")).toEqual([]);
  });
});

describe.skipIf(!haveRaw)("objects.qvm task tree (real file)", () => {
  it("parses all 60 statements and 1,418 calls", async () => {
    const tree = readQvmCallTree(await readRaw(OBJECTS));
    expect(tree).toHaveLength(60);
    let calls = 0;
    const walk = (v: QvmValue) => {
      if (isQvmCall(v)) {
        calls++;
        v.args.forEach(walk);
      }
    };
    tree.forEach(walk);
    expect(calls).toBe(1418);
  });

  it("decodes every Task_New with its declared schema", async () => {
    const tasks = flattenTasks(readTaskTree(readQvmCallTree(await readRaw(OBJECTS))));
    expect(tasks.length).toBe(1362); // every Task_New call in the file
    const player = tasks.find((t) => t.type === "HumanPlayer")!;
    expect(player.name).toBe("TheGoodGuy");
    expect(vec3Param(player, "Position")).toEqual([24578514, -55852816, 174421680]);
    expect(player.params.Model).toBe("000_01_1");
    const truck = tasks.find((t) => t.id === 1099)!;
    expect(truck.type).toBe("Car");
    expect(truck.params.Model).toBe("622_01_1");
    const graph = tasks.find((t) => t.type === "AIGraph" && t.id === 4019)!;
    expect(graph.params.Graphdata).toEqual([264, 300, 876]);
  });
});

describe.skipIf(!haveRaw)("readMef (real models)", () => {
  it("decodes every level-1 model with consistent counts", async () => {
    const members = readIlffMembers(await readRaw(MODELS));
    expect(members).toHaveLength(417);
    const types = new Map<number, number>();
    for (const m of members) {
      const model = readMef(m.payload);
      types.set(model.modelType, (types.get(model.modelType) ?? 0) + 1);
      expect(model.indices.length % 3).toBe(0);
      const vertexCount = model.positions.length / 3;
      for (const i of model.indices) expect(i).toBeLessThan(vertexCount);
      expect(model.groups.reduce((s, g) => s + g.count, 0)).toBe(model.indices.length);
    }
    expect(Object.fromEntries(types)).toEqual({ 0: 46, 1: 25, 3: 346 });
  });

  it("decodes every location0 (shared) model", async () => {
    const members = readIlffMembers(await readRaw("missions/location0/common/models/location0.res"));
    expect(members).toHaveLength(184);
    for (const m of members) expect(() => readMef(m.payload)).not.toThrow();
  });

  it("reads the LargeFuelContainer: 255 vertices, 122 faces, 34 blocks, ~14 m wide", async () => {
    const members = readIlffMembers(await readRaw(MODELS));
    const model = readMef(members.find((m) => m.name.endsWith("/438_01_1.mef"))!.payload);
    expect(model.modelType).toBe(3);
    expect(model.positions.length / 3).toBe(255);
    expect(model.indices.length / 3).toBe(122);
    expect(model.groups).toHaveLength(34);
    expect((model.max[0] - model.min[0]) / 4096).toBeGreaterThan(13);
    expect((model.max[0] - model.min[0]) / 4096).toBeLessThan(15);
    // type-3 normals (bytes 12..23) are unit length.
    const n = model.normals;
    expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 3);
  });

  it("reads attachments with proper rotation matrices", async () => {
    const members = readIlffMembers(await readRaw(MODELS));
    const tower = readMef(members.find((m) => m.name.endsWith("/435_01_1.mef"))!.payload);
    expect(tower.attachments.map((a) => a.name)).toEqual(["435_02_1"]);
    const m = tower.attachments[0].matrix;
    const det =
      m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    expect(det).toBeCloseTo(1, 5);
  });

  it("rejects a truncated model", async () => {
    const members = readIlffMembers(await readRaw(MODELS));
    expect(() => readMef(members[0].payload.slice(0, 200))).toThrow(/MEF/);
  });
});

describe.skipIf(!haveRaw)("readMtp (real table)", () => {
  it("lists models and textures in archive member order", async () => {
    const mtp = readMtp(await readRaw(MTP));
    const models = readIlffMembers(await readRaw(MODELS)).map((m) => m.name.replace(/^.*\/|\.mef$/g, ""));
    const textures = readIlffMembers(await readRaw(TEXTURES)).map((m) => m.name.replace(/^.*\/|\.tex$/g, ""));
    expect(mtp.models).toEqual(models);
    expect(mtp.textures).toEqual(textures);
    expect(mtp.modelTextures.get("438_01_1")).toEqual(["402_22_1", "438_01_1", "401_17_1_argb8888"]);
  });
});

describe.skipIf(!haveRaw)("decodeIlsf (real sounds)", () => {
  it("decodes the MP5SD loop: 44.1 kHz mono, 20,112 frames", async () => {
    const members = readIlffMembers(await readRaw(SOUNDS));
    const sound = decodeIlsf(members.find((m) => m.name.endsWith("/mp5sd_loop.wav"))!.payload);
    expect(sound.sampleRate).toBe(44100);
    expect(sound.channels).toBe(1);
    expect(sound.samples.length).toBe(20112);
  });

  it("rejects a length that disagrees with the frame count", () => {
    const buffer = new ArrayBuffer(24);
    const bytes = new Uint8Array(buffer);
    bytes.set([0x49, 0x4c, 0x53, 0x46, 1, 0, 16, 0, 1, 0, 2, 0x10, 0x22, 0x56, 0, 0, 5, 0, 0, 0]);
    expect(() => decodeIlsf(buffer)).toThrow(/frames/);
  });
});

describe.skipIf(!haveRaw)("weaponconfig.qvm", () => {
  it("decodes the MP5SD configuration", async () => {
    const tasks = flattenTasks(readTaskTree(readQvmCallTree(await readRaw(WEAPONS))));
    const mp5 = tasks.find((t) => t.type === "WeaponConfig" && t.params["Script ID"] === "WEAPON_ID_MP5SD")!;
    expect(mp5.params["Rounds/Minute"]).toBe(700);
    expect(mp5.params["Rounds/Clip"]).toBe(32);
    expect(mp5.params["Reload Time"]).toBeCloseTo(1.8, 5);
    expect(mp5.params["Effective Range of Weapon"]).toBe(100);
  });
});
