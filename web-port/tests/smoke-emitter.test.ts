/**
 * The Smoke task (locomotive exhausts; src/engine/fx/smoke-emitter.ts,
 * docs/rendering.md 7.11), recovered from igi.exe FUN_00436790 /
 * FUN_00437280 / FUN_00437030 / FUN_00436d50. Synthetic checks of the rules,
 * then the level-1 intro through the mission system (skipped without the
 * staged files).
 */
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { Vec3 } from "../src/contracts";
import { LEVEL1_PATHS, loadIgiLevel, type IgiLevel, type IgiTask, type MissionRuntime, type TaskPose } from "../src/loaders";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { LevelRng } from "../src/engine/ai/rng";
import type { GameContext } from "../src/engine/context";
import { mulMat3, rotX, rotZ, PARTICLE_RNG_SEED } from "../src/engine/fx/bullet-effects";
import { createParticleManager } from "../src/engine/fx/particles";
import { SMOKE_TASK, createSmokeEmitters, smokeDirection, smokeLaunch, smokeParams, smokeSystemSpec } from "../src/engine/fx/smoke-emitter";
import { createMissionSystem } from "../src/engine/mission/mission-system";
import { RAW_ROOT } from "./helpers";

/** Level 1's Smoke 867 parameters (objects.qvm). */
const PARAMS: IgiTask["params"] = {
  Position: [22488446, -57017028, 174510912],
  Alpha: 1.780236005783081,
  Gamma: -0.4188790023326874,
  "Number of Particles": 300,
  Radius: 2,
  "Maximum Random Angle": 0.785398006439209,
  "Minimum Velocity": 4.5,
  "Maximum Velocity": 6,
  Colour: [2, 2, 2],
  "Life Time": 1.2999999523162842,
  "Fade Time": 2.5,
  "Fade Mode": 0,
  "Sprite index": 3,
  "Particle Size": 0.699999988079071,
  "Particle Size Delta": 2.6666669845581055,
  "Minimum Rotation Speed": 0.30000001192092896,
  "Maximum Rotation Speed": 0.6000000238418579,
  Intensity: 0.10000000149011612,
  "Initial generate factor value": 30,
  "Generate factor": "",
  "Move Particles": false,
};
const task = (params: IgiTask["params"]): IgiTask => ({ id: -1, type: "Smoke", name: "", params, children: [] }) as unknown as IgiTask;
const sprite = { version: 9 as const, width: 8, height: 8, format: 3, frames: [{ width: 8, height: 8, x: 0, y: 0, advance: 0, format: 3 as const, flags: 0, rgba: new Uint8ClampedArray(256).fill(255) }], tiles: null };

describe("Smoke rules", () => {
  it("reads the parameters and builds the system of FUN_00437280", () => {
    const p = smokeParams(task(PARAMS));
    const spec = smokeSystemSpec(p);
    expect(spec.sprite).toBe("smoke1.spr"); // index 3
    expect(spec.flags).toBe(0x1080000 | 0x40000); // Fade Mode 0: alpha blend with the particle alpha
    expect(spec.colour).toBe(126); // 2 x 63
    expect(spec.halfSize[0]).toBeCloseTo(0.7 * 4096, 2);
    expect(spec.growth).toBeCloseTo(2.6666667 / 30, 6);
    expect(spec.maxParticles).toBe(300);
    expect(spec.far).toBe(409600);
    expect(spec.owned).toBe(true);
    expect(SMOKE_TASK.sprites).toEqual(["fireball.spr", "blood1.spr", "smoke2.spr", "smoke1.spr"]);
    expect(smokeSystemSpec(smokeParams(task({ ...PARAMS, "Fade Mode": 1, "Sprite index": 2 })))).toMatchObject({ sprite: "smoke2.spr", flags: 0x1040008 });
    expect(smokeSystemSpec(smokeParams(task({ ...PARAMS, "Fade Mode": 2, "Sprite index": 0 })))).toMatchObject({ sprite: "fireball.spr", flags: 0x1040010 });
  });

  it("emits along the third column of Rz(Gamma) Rx(Alpha)", () => {
    expect(smokeDirection(0, 0)).toEqual([0, 0, 1]);
    const m = mulMat3(rotZ(-0.4188790023326874), rotX(1.780236005783081));
    const d = smokeDirection(Math.fround(1.780236005783081), Math.fround(-0.4188790023326874));
    for (let k = 0; k < 3; k++) expect(d[k]).toBeCloseTo(m[k * 3 + 2], 6);
    expect(d[2]).toBeCloseTo(Math.cos(1.780236), 5); // 102 degrees from up
  });

  it("launches a particle with three class draws and three particle-generator draws", () => {
    const p = smokeParams(task(PARAMS));
    const cls = new LevelRng(0);
    const prt = new LevelRng(PARTICLE_RNG_SEED);
    const at: Vec3 = [1000, 2000, 3000];
    const dir = smokeDirection(p.alpha, p.gamma);
    const q = smokeLaunch(p, at, dir, cls, prt);
    expect(cls.draws).toBe(3);
    expect(prt.draws).toBe(3);
    expect(q.life).toBe(38); // trunc(1.2999999523 x 30)
    expect(q.fadeTicks).toBe(749); // trunc(2.5 x 30 / 0.1f)
    expect(smokeLaunch(smokeParams(task({ ...PARAMS, "Life Time": 1.5, "Fade Time": 2 })), at, dir, cls, prt)).toMatchObject({ life: 45, fadeTicks: 599 });
    expect(q.alpha).toBe(Math.fround(0.1));
    expect(q.position[2]).toBe(3000);
    expect(Math.hypot(q.position[0] - 1000, q.position[1] - 2000)).toBeLessThanOrEqual(2 * 4096);
    const speed = Math.hypot(...q.velocity);
    expect(speed).toBeGreaterThanOrEqual(612 - 0.01);
    expect(speed).toBeLessThanOrEqual(816 + 0.01);
    expect(q.spin).toBeGreaterThanOrEqual(0.3 / 30 - 1e-6);
    expect(q.spin).toBeLessThanOrEqual(0.6 / 30 + 1e-6);
    // Within the 45-degree cone around the direction.
    const cos = (q.velocity[0] * dir[0] + q.velocity[1] * dir[1] + q.velocity[2] * dir[2]) / speed;
    expect(Math.acos(Math.min(1, cos))).toBeLessThanOrEqual(0.785398 / 2 + 1e-4);
  });
});

/** A fake runtime: container 0 > Train 1 > Smoke 2. */
function fakeRuntime(params: IgiTask["params"]) {
  const state = [{ isRun: 0, inWorld: 0 }, {}, {}];
  const nodes = [
    { index: 0, id: 1, type: "ConditionalContainer", name: "", parent: -1, depth: 0, children: [1], task: task({}) },
    { index: 1, id: 2, type: "Train", name: "", parent: 0, depth: 1, children: [2], task: task({}) },
    { index: 2, id: -1, type: "Smoke", name: "", parent: 1, depth: 2, children: [], task: task(params) },
  ];
  const rt = { tasks: { nodes }, nodeState: (i: number) => state[i] } as unknown as MissionRuntime;
  return { rt, state };
}

describe("Smoke emitter (FUN_00437030, FUN_00436d50)", () => {
  const origin: Vec3 = [0, 0, 0];
  const setup = (params: IgiTask["params"]) => {
    const { rt, state } = fakeRuntime(params);
    let x = 0;
    const pose = (): TaskPose => ({ position: [x, 0, 0], matrix: [0, -1, 0, 1, 0, 0, 0, 0, 1] }); // Rz(90 deg)
    const pm = createParticleManager(new Map([["smoke1.spr", sprite]]), null);
    const prng = new LevelRng(PARTICLE_RNG_SEED);
    const smokes = createSmokeEmitters({ runtime: () => rt, trainPose: () => pose(), particles: () => pm, particleRng: () => prng, originIgi: () => origin });
    smokes.reset();
    return { smokes, state, pm, setX: (v: number) => (x = v) };
  };

  it("waits for its ConditionalContainer, then emits one particle per tick from the second update", () => {
    const o = setup({ ...PARAMS, Position: [100, 50, 4000] });
    const e = o.smokes.emitters[0];
    expect(e.local[2]).toBe(4000);
    o.smokes.tick();
    expect(e.system!.particles).toHaveLength(0);
    expect(e.system!.visible).toBe(false);
    o.state[0].isRun = 1;
    o.state[0].inWorld = 1;
    o.smokes.tick(); // first update: acc 30, nothing
    expect(e.system!.particles).toHaveLength(0);
    expect(e.system!.visible).toBe(true);
    for (let t = 0; t < 10; t++) o.smokes.tick();
    expect(e.system!.particles).toHaveLength(10);
    expect(o.smokes.rng.draws).toBe(30);
    // The manager neither steps nor drops it: the Smoke owns it.
    const before = e.system!.particles[0].position.slice();
    o.pm.tick();
    expect(e.system!.particles[0].position).toEqual(before);
  });

  it("rides the parent (position = R local + P); particles stay in the world unless Move Particles", () => {
    for (const move of [false, true]) {
      const o = setup({ ...PARAMS, Position: [100, 50, 4000], "Move Particles": move });
      const e = o.smokes.emitters[0];
      o.state[0].isRun = 1;
      o.state[0].inWorld = 1;
      o.smokes.tick();
      o.smokes.tick();
      const first = e.system!.particles[0];
      const p0 = first.position.slice();
      const v0 = first.velocity.slice();
      o.setX(8192);
      o.smokes.tick();
      // Rz(90): local (50, -100, 4000) -> world (100, 50) + P.
      expect(e.position[0]).toBeCloseTo(8192 + 100, 6);
      expect(e.position[1]).toBeCloseTo(50, 6);
      const moved = first.position[0] - p0[0] - v0[0];
      expect(moved).toBeCloseTo(move ? 8192 : 0, 3);
    }
  });

  it("is still updated on the container's falling-edge tick and hidden out of the world", () => {
    const o = setup(PARAMS);
    const e = o.smokes.emitters[0];
    o.state[0].isRun = 1;
    o.state[0].inWorld = 1;
    for (let t = 0; t < 5; t++) o.smokes.tick();
    const n = e.system!.particles.length;
    o.state[0].isRun = 0; // stopped this tick: children still updated once
    o.smokes.tick();
    expect(e.system!.particles.length).toBe(n + 1);
    o.state[0].inWorld = 0;
    o.smokes.tick();
    expect(e.system!.particles.length).toBe(n + 1);
    expect(e.system!.visible).toBe(false);
  });
});

const haveLevel = existsSync(`${RAW_ROOT}/${LEVEL1_PATHS.objects}`);

describe.skipIf(!haveLevel)("level-1 locomotive smoke", () => {
  let level: IgiLevel;
  beforeAll(async () => {
    level = await loadIgiLevel(createFsAssetSource(RAW_ROOT));
  }, 240_000);

  it("Smoke 867 rides Train 846 through the intro at a steady ~113 particles", () => {
    const ctx = { world: null, level, events: { emit() {}, on: () => () => {} }, input: { isDown: () => false }, player: { position: [0, 0, 0], crouching: false, eyeHeight: 1.7, alive: true }, enemies: [], systems: { enemies: null } };
    const mission = createMissionSystem(ctx as unknown as GameContext);
    mission.start(level);
    const pm = createParticleManager(new Map([["smoke1.spr", sprite]]), null);
    const smokes = createSmokeEmitters({
      runtime: () => mission.runtime,
      trainPose: (n) => mission.vehicles?.trainPoses(n)?.[0] ?? null,
      particles: () => pm,
      particleRng: () => new LevelRng(PARTICLE_RNG_SEED),
      originIgi: () => level.originIgi,
    });
    smokes.reset();
    expect(smokes.emitters.map((e) => [e.node, e.parent])).toEqual([[817, 814], [867, 846], [879, 870]]);
    const e867 = smokes.emitters[1];
    // The chimney: a few metres from the locomotive's origin.
    expect(Math.hypot(...e867.local) / 4096).toBeLessThan(8);
    let firstEmission = -1;
    for (let t = 0; t < 1300; t++) {
      mission.tick();
      smokes.tick();
      if (firstEmission < 0 && e867.system!.particles.length > 0) firstEmission = t;
      if (t === 1202) {
        const loco = mission.vehicles!.trainPoses(846)![0];
        const m = loco.matrix;
        const l = e867.local.map(Math.fround);
        const want = [0, 1, 2].map((r) => loco.position[r] + m[r * 3] * l[0] + m[r * 3 + 1] * l[1] + m[r * 3 + 2] * l[2]);
        for (let k = 0; k < 3; k++) expect(e867.position[k]).toBeCloseTo(want[k], 3);
      }
    }
    expect(firstEmission).toBeGreaterThan(0);
    expect(e867.system!.particles.length).toBeGreaterThan(100);
    expect(e867.system!.particles.length).toBeLessThan(120);
    expect(e867.system!.visible).toBe(true);
  }, 120_000);
});
