/**
 * Characters: skeleton/animation files (common/anims/*.iff), skinned bone
 * models (.mef type 1), posing and the first-person rig, checked against the
 * staged original files (skipped when absent). Reference values come from
 * tools/igi_anim.py; see docs/characters.md.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FIRST_PERSON,
  HUMAN_SOLDIER_ACTIONS,
  SOLDIER_GUN_BONE,
  TICKS_PER_SECOND,
  clipTime,
  readAnimations,
  sampleClip,
  sampleRotation,
  sampleTranslation,
  type AnimationFile,
  type AnimClip,
} from "../src/loaders/anim";
import { readIlffMembers } from "../src/loaders/ilff";
import { readMef } from "../src/loaders/mef";
import { poseSkeleton, poseVertices, readSkinnedModel, skinBuffers, type SkinnedModel } from "../src/loaders/skeleton";
import { RAW_ROOT, readRaw } from "./helpers";

const ANIMS = ["000", "001", "002", "003", "005", "006"];
const LEVEL_MODELS = "missions/location0/level1/models/level1.res";
const LOCATION_MODELS = "missions/location0/common/models/location0.res";
const UNITS = 4096;
const have = existsSync(`${RAW_ROOT}/common/anims/001.iff`) && existsSync(`${RAW_ROOT}/${LEVEL_MODELS}`);

async function anims(): Promise<Map<string, AnimationFile>> {
  const out = new Map<string, AnimationFile>();
  for (const name of ANIMS) out.set(name, readAnimations(await readRaw(`common/anims/${name}.iff`)));
  return out;
}

async function boneModels(): Promise<Map<string, ArrayBuffer>> {
  const out = new Map<string, ArrayBuffer>();
  for (const archive of [LEVEL_MODELS, LOCATION_MODELS]) {
    for (const m of readIlffMembers(await readRaw(archive))) {
      if (!m.name.endsWith(".mef")) continue;
      if (readMef(m.payload).modelType === 1) out.set(m.name.split("/").pop()!.replace(".mef", ""), m.payload);
    }
  }
  return out;
}

/** Largest distance (units) between where a vertex's primary and extra influences put it. */
function influenceDisagreement(model: SkinnedModel, matrices: Float32Array): number {
  let worst = 0;
  const place = (v: number) => {
    const m = 16 * model.vertexBone[v];
    const [x, y, z] = [model.positions[3 * v], model.positions[3 * v + 1], model.positions[3 * v + 2]];
    return [0, 1, 2].map((r) => matrices[m + r] * x + matrices[m + 4 + r] * y + matrices[m + 8 + r] * z + matrices[m + 12 + r]);
  };
  for (let e = 0; e < model.extraCount; e++) {
    const a = place(model.extraTarget[e]);
    const b = place(model.primaryCount + e);
    worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
  }
  return worst;
}

function boneWorldPosition(matrices: Float32Array, b: number): number[] {
  return [matrices[16 * b + 12], matrices[16 * b + 13], matrices[16 * b + 14]];
}

/** Share of a loop during which a foot (bones 26/31) moves < 0.25 m/s once the root translation is added. */
function plantedShare(anim: AnimationFile, clip: AnimClip, steps = 48): number {
  let planted = 0;
  let prev: number[][] | null = null;
  const dt = clip.duration / steps;
  for (let s = 0; s <= steps; s++) {
    const t = s * dt;
    const sample = sampleClip(clip, t);
    const m = poseSkeleton(anim.skeleton, sample.rotations);
    const feet = [26, 31].map((b) => boneWorldPosition(m, b).map((v, i) => v + sample.translation[i]));
    if (prev) {
      const speeds = feet.map((f, i) => Math.hypot(f[0] - prev![i][0], f[1] - prev![i][1], f[2] - prev![i][2]) / UNITS / (dt / TICKS_PER_SECOND));
      if (Math.min(...speeds) < 0.25) planted++;
    }
    prev = feet;
  }
  return planted / steps;
}

describe("animation files", () => {
  it("rejects files that are not BOBJ animation containers, naming the offset", () => {
    const bytes = new Uint8Array(32);
    bytes.set([0x46, 0x4f, 0x52, 0x4d, 0, 0, 0, 24, 0x58, 0x58, 0x58, 0x58]);
    expect(() => readAnimations(bytes.buffer)).toThrow(/expected FORM BOBJ at 0x0/);
  });

  describe.skipIf(!have)("original files", () => {
    it("decodes all six files: skeleton ids, bones, clips", async () => {
      const all = await anims();
      const summary = ANIMS.map((n) => {
        const a = all.get(n)!;
        return [n, a.skeleton.id, a.skeleton.boneCount, a.clips.size, [...a.clips.values()].filter((c) => c.loop).length];
      });
      expect(summary).toEqual([
        ["000", 0, 33, 122, 58],
        ["001", 1, 33, 95, 32],
        ["002", 2, 33, 18, 3],
        ["003", 3, 33, 47, 6],
        ["005", 5, 56, 78, 20],
        ["006", 6, 33, 16, 7],
      ]);
      const body = all.get("001")!.skeleton;
      expect([...body.parents]).toEqual([
        -1, 0, 1, 2, 3, 4, 4, 6, 3, 8, 9, 10, 11, 12, 3, 14, 15, 16, 17, 18, 1, 20, 21, 0, 23, 24, 25, 26, 0, 28, 29, 30, 31,
      ]);
      for (const n of ["000", "002", "003", "006"]) expect([...all.get(n)!.skeleton.parents]).toEqual([...body.parents]);
    });

    it("refuses a file whose BOBJ size breaks the observed writer quirk", async () => {
      const raw = new Uint8Array(await readRaw("common/anims/002.iff"));
      const copy = raw.slice();
      copy[7] ^= 4;
      expect(() => readAnimations(copy.buffer)).toThrow(/BOBJ size/);
      expect(() => readAnimations(raw.slice(0, raw.length - 10).buffer)).toThrow(/0x[0-9a-f]+/);
    });

    it("samples exactly as the Python reference (squad rotations, Hermite root)", async () => {
      const all = await anims();
      const body = all.get("001")!;
      const cases: Array<[AnimationFile, number, number, number, number[], number[]]> = [
        [body, 3, 24, 1000, [-0.692356, 0.058197, 0.011795, 0.719108], [-9.975, 3193.665, 3744.495]],
        [body, 4, 9, 2500, [0.66784, -0.027801, -0.082685, 0.739175], [-1.891, 2843.069, 3848.899]],
        [body, 57, 28, 12345, [0.06119, 0.038121, 0.037381, 0.996697], [0.944, 13392.662, 3941.132]],
        [all.get("005")!, 21, 52, 7000, [-0.448223, 0.131451, -0.074953, 0.88102], [-202.954, 65.574, -411.059]],
      ];
      for (const [file, clip, bone, t, q, root] of cases) {
        const out = new Float32Array(4);
        sampleRotation(file.clips.get(clip)!, bone, t, out);
        [...out].forEach((v, i) => expect(v).toBeCloseTo(q[i], 4));
        sampleTranslation(file.clips.get(clip)!, t).forEach((v, i) => expect(v).toBeCloseTo(root[i], 1));
      }
    });

    it("returns keys exactly at key times and unit quaternions in between", async () => {
      const clip = (await anims()).get("001")!.clips.get(57)!;
      const track = clip.rotation[24];
      const out = new Float32Array(4);
      sampleRotation(clip, 24, track.times[5], out);
      expect([...out]).toEqual([...track.q.slice(20, 24)]);
      const sample = sampleClip(clip, 777.5);
      for (let b = 0; b < 33; b++) {
        const r = sample.rotations;
        expect(Math.hypot(r[4 * b], r[4 * b + 1], r[4 * b + 2], r[4 * b + 3])).toBeCloseTo(1, 2);
      }
    });

    it("plants a foot through walk cycles and gives plausible gait speeds", async () => {
      const body = (await anims()).get("001")!;
      // Walk cycle 4: with parent*local posing plus the root translation a foot
      // is planted most of the time; local*parent (46%), no root motion (0%)
      // or conjugated quaternions (2%) fail this.
      expect(plantedShare(body, body.clips.get(4)!)).toBeGreaterThan(0.7);
      expect(plantedShare(body, body.clips.get(57)!)).toBeGreaterThan(0.8);
      const speed = (id: number) => {
        const c = body.clips.get(id)!;
        const a = sampleTranslation(c, 0);
        const b = sampleTranslation(c, c.duration);
        return Math.hypot(b[0] - a[0], b[1] - a[1]) / UNITS / c.seconds;
      };
      expect(speed(4)).toBeCloseTo(1.3, 1);
      expect(speed(57)).toBeCloseTo(1.26, 1);
      expect(speed(34)).toBeCloseTo(4.33, 1);
    });

    it("loops and clamps playback time like FUN_004cb1f0", async () => {
      const clip = (await anims()).get("001")!.clips.get(4)!;
      expect(clipTime(clip, clip.seconds * 2.5, true)).toBeCloseTo(clip.duration / 2, 3);
      expect(clipTime(clip, clip.seconds * 2.5, false)).toBe(clip.duration);
    });

    it("references only clips that exist in the soldiers' 001.iff", async () => {
      const body = (await anims()).get("001")!;
      for (const a of HUMAN_SOLDIER_ACTIONS) if (a.clip > 0) expect(body.clips.has(a.clip)).toBe(true);
      for (const death of [22, 23, 24, 25, 28, 71]) expect(body.clips.has(death)).toBe(true);
    });
  });
});

describe.skipIf(!have)("bone models", () => {
  it("decodes all 26 bone models with weights summing to 1", async () => {
    const all = await anims();
    const models = await boneModels();
    expect(models.size).toBe(26);
    for (const [name, buffer] of models) {
      const skeleton = all.get(name.startsWith("005_") ? "005" : "001")!.skeleton;
      const m = readSkinnedModel(buffer, skeleton);
      expect(m.indices.every((i) => i < m.primaryCount)).toBe(true);
      expect(m.bones).toHaveLength(skeleton.boneCount);
    }
    const soldier = readSkinnedModel(models.get("003_01_1")!);
    expect([soldier.primaryCount, soldier.extraCount, soldier.maxBone]).toEqual([600, 239, 31]);
    expect(soldier.collision.length).toBe(2);
    expect(Math.max(...soldier.collision[0].vertexBone)).toBeLessThan(33);
  });

  it("bind pose (identity rotations + TLST) is the authored pose of the right skeleton", async () => {
    const all = await anims();
    const models = await boneModels();
    const check = (model: string, skel: string) =>
      influenceDisagreement(readSkinnedModel(models.get(model)!), poseSkeleton(all.get(skel)!.skeleton, null)) / UNITS;
    expect(check("003_01_1", "001")).toBeLessThan(0.001);
    expect(check("000_01_1", "000")).toBeLessThan(0.001);
    expect(check("015_01_1", "006")).toBeLessThan(0.001);
    expect(check("019_01_1", "001")).toBeLessThan(0.01);
    // The wrong skeleton tears the mesh apart.
    expect(check("003_01_1", "000")).toBeGreaterThan(0.05);
    expect(check("000_01_1", "001")).toBeGreaterThan(0.05);
  });

  it("skins a ~1.8 m soldier standing on the ground in its idle clip", async () => {
    const all = await anims();
    const body = all.get("001")!;
    const model = readSkinnedModel((await boneModels()).get("003_01_1")!, body.skeleton);
    const clip = body.clips.get(2)!;
    const sample = sampleClip(clip, 0);
    const { positions } = poseVertices(model, poseSkeleton(body.skeleton, sample.rotations));
    let lo = Infinity;
    let hi = -Infinity;
    for (let v = 0; v < model.primaryCount; v++) {
      const z = positions[3 * v + 2] + sample.translation[2];
      lo = Math.min(lo, z);
      hi = Math.max(hi, z);
    }
    expect(lo / UNITS).toBeCloseTo(0, 1);
    expect(hi / UNITS).toBeGreaterThan(1.75);
    expect(hi / UNITS).toBeLessThan(1.85);
    // GPU buffers: weights per vertex sum to 1.
    const gpu = skinBuffers(model);
    for (let v = 0; v < model.primaryCount; v++) {
      const s = gpu.skinWeight[4 * v] + gpu.skinWeight[4 * v + 1] + gpu.skinWeight[4 * v + 2] + gpu.skinWeight[4 * v + 3];
      expect(s).toBeCloseTo(1, 5);
    }
    expect(SOLDIER_GUN_BONE).toBe(22);
  });
});

describe.skipIf(!have)("first-person rig", () => {
  it("magazine and moving-part bones sit at the gun models' ATTA part offsets", async () => {
    const arms = (await anims()).get("005")!;
    const guns = new Map(readIlffMembers(await readRaw(LOCATION_MODELS)).map((m) => [m.name.split("/").pop()!, m.payload]));
    // weapon -> [gun model, stand clip, ATTA part on the magazine bone, ATTA part on the moving-part bone]
    const cases: Array<[string, number, string, string | null]> = [
      ["103_01_1", 18, "103_02_1", null], // MP5SD
      ["100_01_1", 10, "100_03_1", "100_02_1"], // AK47
      ["117_01_1", 14, "117_03_1", "117_02_1"], // Glock
      ["111_01_1", 6, "111_02_1", "111_03_1"], // Uzi
    ];
    for (const [gun, clipId, magazine, moving] of cases) {
      const atta = readMef(guns.get(`${gun}.mef`)!).attachments;
      const m = poseSkeleton(arms.skeleton, sampleClip(arms.clips.get(clipId)!, 0).rotations);
      const g = FIRST_PERSON.gunBone;
      const local = (b: number) => {
        const d = [0, 1, 2].map((i) => m[16 * b + 12 + i] - m[16 * g + 12 + i]);
        return [0, 1, 2].map((c) => m[16 * g + 4 * c] * d[0] + m[16 * g + 4 * c + 1] * d[1] + m[16 * g + 4 * c + 2] * d[2]);
      };
      const expectNear = (bone: number, part: string) => {
        const a = atta.find((x) => x.name === part)!;
        local(bone).forEach((v, i) => expect(Math.abs(v - a.position[i]) / UNITS).toBeLessThan(0.01));
      };
      expectNear(FIRST_PERSON.magazineBone, magazine);
      if (moving) expectNear(FIRST_PERSON.movingPartBone, moving);
    }
  });

  it("arms model uses skeleton 5 and hangs below and in front of the camera", async () => {
    const arms = (await anims()).get("005")!;
    const model = readSkinnedModel((await boneModels()).get(FIRST_PERSON.model)!, arms.skeleton);
    expect(model.maxBone).toBe(48);
    const sample = sampleClip(arms.clips.get(18)!, 0);
    const right = boneWorldPosition(poseSkeleton(arms.skeleton, sample.rotations), 6).map((v, i) => (v + sample.translation[i]) / UNITS);
    expect(right[0]).toBeGreaterThan(0.05); // right of the eye
    expect(right[1]).toBeGreaterThan(0.05); // in front
    expect(right[2]).toBeLessThan(-0.1); // below
  });
});
