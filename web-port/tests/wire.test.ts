/**
 * Wire task pose (src/loaders/wire.ts, docs/wire.md). Real-data checks use
 * the staged original files and are skipped when they are absent.
 */
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { Vec3 } from "../src/contracts";
import { readCollisionModel } from "../src/loaders/collision-mesh";
import type { Mat3 } from "../src/loaders/coords";
import { readIlffMembers } from "../src/loaders/ilff";
import { readMef } from "../src/loaders/mef";
import { readQvmCallTree } from "../src/loaders/qvm";
import { flattenTasks, readTaskTree, stringParam, vec3Param } from "../src/loaders/tasks";
import {
  WIRE_FRAME_VERTICAL_LIMIT,
  WIRE_LENGTH_SCALE,
  WIRE_POSITION_FACTOR,
  WIRE_SLIDE_END_MARGIN,
  WIRE_SLIDE_HANG,
  WIRE_SLIDE_MIN_ANGLE,
  WIRE_TRAVERSE_END_MARGIN,
  WIRE_TRAVERSE_HANG,
  WIRE_USE_KIND,
  readWireModelInfo,
  wireAttachFrame,
  wireFrame,
  wireHoldPoint,
  wirePose,
  wireUseMode,
  type WireModelInfo,
} from "../src/loaders/wire";
import { RAW_ROOT, readRaw } from "./helpers";

/** Column-major 4x4 times point. */
function apply(m: number[], v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
  ];
}

function det3(m: Mat3): number {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

function expectOrthonormal(r: Mat3): void {
  for (let a = 0; a < 3; a++) {
    for (let b = 0; b < 3; b++) {
      const d = r[a] * r[b] + r[3 + a] * r[3 + b] + r[6 + a] * r[6 + b];
      expect(d).toBeCloseTo(a === b ? 1 : 0, 12);
    }
  }
  expect(det3(r)).toBeCloseTo(1, 12);
}

function expectVec(actual: Vec3, expected: Vec3, digits: number): void {
  for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], digits);
}

/** 320_01_1 values (observed; docs/wire.md) for the synthetic tests. */
const MODEL_320: WireModelInfo = {
  originRadius: 2052.7297,
  magicVertices: [
    [17.584823608398438, -2048, 121.51398468017578],
    [17.584659576416016, 2048, 121.51438903808594],
  ],
};

describe("wire constants (igi.exe)", () => {
  it("matches the recovered executable constants", () => {
    expect(WIRE_LENGTH_SCALE).toBe(0.000244140625); // DAT_005314b0
    expect(WIRE_POSITION_FACTOR).toBe(0.5); // DAT_00531580
    expect(WIRE_FRAME_VERTICAL_LIMIT).toBe(Math.fround(0.95)); // DAT_00531658
    expect(WIRE_SLIDE_MIN_ANGLE).toBe(Math.fround(0.03490658476948738)); // DAT_00531834
    expect(WIRE_TRAVERSE_END_MARGIN).toBe(3072); // DAT_005314f0
    expect(WIRE_SLIDE_END_MARGIN).toBe(2048); // DAT_00531500
    expect(WIRE_TRAVERSE_HANG).toBe(2150.4); // DAT_005314e8
    expect(WIRE_SLIDE_HANG).toBe(3686.4); // DAT_005314f8
    expect(WIRE_USE_KIND).toBe(9); // 0x43e880
  });
});

describe("wireFrame (FUN_00486a60)", () => {
  it("is the identity for a wire along +y", () => {
    const r = wireFrame([0, 1, 0]);
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => expect(r[i]).toBeCloseTo(v, 15));
  });

  it("keeps x horizontal and z up for sloped wires", () => {
    const d = [0.6, -0.7, -0.3];
    const n = Math.hypot(...d);
    const dir: Vec3 = [d[0] / n, d[1] / n, d[2] / n];
    const r = wireFrame(dir);
    expectOrthonormal(r);
    expect([r[1], r[4], r[7]]).toEqual(dir); // model +y = wire direction
    expect(r[6]).toBe(0); // model x has no z component
    expect(r[8]).toBeGreaterThan(0); // model z points up
    // x = dir x Z (normalised)
    const h = Math.hypot(dir[0], dir[1]);
    expect(r[0]).toBeCloseTo(dir[1] / h, 12);
    expect(r[3]).toBeCloseTo(-dir[0] / h, 12);
  });

  it("switches to the world-x construction above |dir.z| = 0.95", () => {
    const d = [0.1, 0.2, 0.97];
    const n = Math.hypot(...d);
    const dir: Vec3 = [d[0] / n, d[1] / n, d[2] / n];
    const r = wireFrame(dir);
    expectOrthonormal(r);
    expect(r[2]).toBe(0); // z = X x dir has no x component
    expect([r[1], r[4], r[7]]).toEqual(dir);
  });
});

describe("wirePose (FUN_0043e590)", () => {
  const start: Vec3 = [1000, 2000, 3000];
  const stop: Vec3 = [1000 + 4096 * 3, 2000 - 4096 * 4, 3000 - 4096];

  it("stretches the 4096-unit model from start to stop about the midpoint", () => {
    const pose = wirePose(start, stop, MODEL_320)!;
    const length = Math.hypot(4096 * 3, 4096 * 4, 4096);
    expect(pose.length).toBeCloseTo(length, 9);
    expect(pose.scale).toEqual([1, length / 4096, 1]);
    expectVec(pose.position, [(start[0] + stop[0]) / 2, (start[1] + stop[1]) / 2, (start[2] + stop[2]) / 2], 9);
    expectVec(apply(pose.matrix, [0, -2048, 0]), start, 6);
    expectVec(apply(pose.matrix, [0, 2048, 0]), stop, 6);
    expect(det3(pose.linear)).toBeCloseTo(length / 4096, 9);
    expect(pose.boundingRadius).toBeCloseTo(2052.7297 * (length / 4096), 6);
  });

  it("collides with the unscaled model (FUN_004b7a60 divides by scale.x only)", () => {
    const pose = wirePose(start, stop)!;
    expect(pose.boundingRadius).toBeNull();
    expectOrthonormal(pose.rotation);
    const end = apply(pose.collisionMatrix, [0, 2048, 0]);
    const fromMid = Math.hypot(end[0] - pose.position[0], end[1] - pose.position[1], end[2] - pose.position[2]);
    expect(fromMid).toBeCloseTo(2048, 9);
  });

  it("returns null for a zero-length wire", () => {
    expect(wirePose(start, start)).toBeNull();
  });

  it("classifies slide / traverse with the wrapped pitch (FUN_0043ea60)", () => {
    const level = wirePose([0, 0, 0], [40960, 0, 0], MODEL_320)!;
    const down = wirePose([0, 0, 0], [40960, 0, -1], MODEL_320)!;
    const upShallow = wirePose([0, 0, 0], [40960, 0, 40960 * Math.tan((1 * Math.PI) / 180)], MODEL_320)!;
    const upSteep = wirePose([0, 0, 0], [40960, 0, 40960 * Math.tan((3 * Math.PI) / 180)], MODEL_320)!;
    expect(wireUseMode(wireAttachFrame(level, MODEL_320))).toBe("traverse");
    expect(wireUseMode(wireAttachFrame(down, MODEL_320))).toBe("slide");
    expect(wireUseMode(wireAttachFrame(upShallow, MODEL_320))).toBe("traverse");
    expect(wireUseMode(wireAttachFrame(upSteep, MODEL_320))).toBe("slide");
  });

  it("clamps the hold point inside the end margins and hangs below the wire", () => {
    const pose = wirePose([0, 0, 0], [0, 40960, 0], MODEL_320)!; // 10 m along +y, level
    const far = wireHoldPoint(pose, MODEL_320, [0, 99999, 0], "traverse");
    expectVec(far, [0, 40960 - WIRE_TRAVERSE_END_MARGIN, -WIRE_TRAVERSE_HANG], 3);
    const near = wireHoldPoint(pose, MODEL_320, [500, 10000, 77], "slide");
    expectVec(near, [0, 10000, -WIRE_SLIDE_HANG], 3);
    const candidate = wireHoldPoint(pose, MODEL_320, [0, -5000, 0], "candidate");
    expectVec(candidate, [0, 0, 0], 3);
  });
});

const LEVEL = "missions/location0/level1";
const haveRaw = existsSync(`${RAW_ROOT}/${LEVEL}/objects.qvm`) && existsSync(`${RAW_ROOT}/${LEVEL}/models/level1.res`);

describe.skipIf(!haveRaw)("level-1 wires (original files)", () => {
  let wires: Array<{ id: number; start: Vec3; stop: Vec3; model: string }>;
  let mefBuffer: ArrayBuffer;

  beforeAll(async () => {
    const tasks = flattenTasks(readTaskTree(readQvmCallTree(await readRaw(`${LEVEL}/objects.qvm`))));
    wires = tasks
      .filter((t) => t.type === "Wire")
      .map((t) => ({
        id: t.id,
        start: vec3Param(t, "Start position")!,
        stop: vec3Param(t, "Stop position")!,
        model: stringParam(t, "Model")!,
      }));
    const members = readIlffMembers(await readRaw(`${LEVEL}/models/level1.res`));
    mefBuffer = members.find((m) => m.name.endsWith("/320_01_1.mef"))!.payload;
  });

  it("has three Wire tasks, all using 320_01_1", () => {
    expect(wires.map((w) => w.id)).toEqual([3500, 3501, 3502]);
    for (const w of wires) expect(w.model).toBe("320_01_1");
    expect(wires[0].start).toEqual([24631402, -56199400, 174434752]);
    expect(wires[0].stop).toEqual([24760932, -56297984, 174434752]);
  });

  it("320_01_1 is a 4096-unit prism along y with one point per end", () => {
    const mef = readMef(mefBuffer);
    expect(mef.modelType).toBe(0); // rigid, vertex-lit
    expect(mef.attachments).toHaveLength(0); // nothing else attached
    expect(mef.min[1]).toBe(-2048);
    expect(mef.max[1]).toBe(2048);
    expect(mef.max[2]).toBeLessThan(130); // cross-section 0.2..128 units above the axis
    expect(mef.groups).toHaveLength(1);
    expect(mef.groups[0].deferredFlag).toBe(0); // opaque
    expect(mef.groups[0].blendFlags & 1).toBe(0); // not additive
    const info = readWireModelInfo(mefBuffer);
    expect(info.originRadius).toBeCloseTo(2052.7297, 3);
    expect(info.magicVertices).toHaveLength(2);
    expect(info.magicVertices[0][1]).toBe(-2048);
    expect(info.magicVertices[1][1]).toBe(2048);
    const collision = readCollisionModel(mefBuffer)!;
    expect(collision.sets[0].faceSurface.length).toBe(8);
    expect(collision.sets[1].faceSurface.length).toBe(0); // characters never collide with it
    expect(collision.sets[0].surfaces.map((s) => s.material)).toEqual([7]); // SoftMetal
  });

  it("poses each wire so the model ends land on start and stop", () => {
    const info = readWireModelInfo(mefBuffer);
    const expected = [
      { lengthM: 39.7408, mode: "traverse" },
      { lengthM: 85.0422, mode: "slide" },
      { lengthM: 25.4808, mode: "slide" },
    ];
    wires.forEach((w, i) => {
      const pose = wirePose(w.start, w.stop, info)!;
      expect(pose.length / 4096).toBeCloseTo(expected[i].lengthM, 3);
      const tolerance = 1e-9 * pose.length + 1e-3;
      const a = apply(pose.matrix, [0, -2048, 0]);
      const b = apply(pose.matrix, [0, 2048, 0]);
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(a[k] - w.start[k])).toBeLessThan(tolerance);
        expect(Math.abs(b[k] - w.stop[k])).toBeLessThan(tolerance);
      }
      // Model +z (the cable's top) is the world-up side of the wire.
      expect(pose.rotation[8]).toBeGreaterThan(0.99);
      const frame = wireAttachFrame(pose, info);
      for (let k = 0; k < 9; k++) expect(frame[k]).toBeCloseTo(pose.rotation[k], 6);
      expect(wireUseMode(frame)).toBe(expected[i].mode);
    });
  });
});
