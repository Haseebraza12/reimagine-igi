/**
 * Shot and blown-up objects and the explosion (src/engine/combat/
 * explosion-rules.ts, object-damage.ts, src/loaders/damage-data.ts,
 * world-builder destructible instances; docs/damage.md). Real-data checks
 * use the staged original files and are skipped when they are absent.
 */
import { existsSync } from "node:fs";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { LEVEL1_PATHS, MissionRuntime, buildMissionTasks, loadIgiLevel, type IgiLevel } from "../src/loaders";
import { loadDamageModelData, readExplodeMagicDefs, type DamageModelData } from "../src/loaders/damage-data";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { LevelRng } from "../src/engine/ai/rng";
import type { GameContext } from "../src/engine/context";
import { EventBus, GameEvent } from "../src/engine/events";
import * as R from "../src/engine/combat/explosion-rules";
import { FRAGMENT_GRAVITY } from "../src/engine/fx/bullet-effects";
import { DAMAGE_EVENTS, createDamageSystem, damageModelNames, missionRuntimeBridge } from "../src/engine/combat/object-damage";
import { DESTRUCTIBLE_BODY_ID, buildWorld, type BuiltWorld } from "../src/engine/world/world-builder";
import { TRI_BULLET, TRI_SIGHT } from "../src/engine/world/collision";
import { RAW_ROOT, readRaw } from "./helpers";

const rec = (over: Partial<R.ExplosionRecord> = {}): R.ExplosionRecord => ({
  position: [0, 0, 0], damage: 1, radius: 7 * 4096, falloff: 3 * 4096, shakeTicks: 90, sourceWeaponId: null, ...over,
});

describe("explosion rules (FUN_00415b90 and the handlers)", () => {
  it("deals the full factor inside the blast and falls off linearly", () => {
    const r = rec();
    // e = d - targetRadius - radius
    expect(R.explosionFactor(r, [6 * 4096, 0, 0], 0)).toBe(1);
    expect(R.explosionFactor(r, [8.5 * 4096, 0, 0], 0)).toBeCloseTo(0.5, 6);
    expect(R.explosionFactor(r, [10 * 4096, 0, 0], 0)).toBe(0);
    expect(R.explosionFactor(r, [10 * 4096, 0, 0], 4096)).toBeCloseTo(1 / 3, 6);
    // Zero falloff (SCamera explosion): only inside the radius.
    expect(R.explosionFactor(rec({ falloff: 0, radius: 2048, damage: 0.25 }), [2047, 0, 0], 0)).toBe(0.25);
    expect(R.explosionFactor(rec({ falloff: 0, radius: 2048, damage: 0.25 }), [2049, 0, 0], 0)).toBe(0);
  });

  it("accumulates damage as the exe (chopped float32 store, 53-bit compare)", () => {
    // ExplodeObject "Damage scale" 1: MP5SD (0.2) needs six hits, not five: the chop-mode
    // stores lose the last bit (0.6 -> 0.59999996, 0.8 -> 0.79999995, sum 5 = 0.99999996).
    const hitsFor = (d: number, limit: number) => {
      let acc = 0;
      for (let hits = 1; ; hits++) {
        const r = R.accumulate(acc, Math.fround(d), limit);
        acc = r.stored;
        if (r.reached) return hits;
      }
    };
    expect(hitsFor(0.2, 1)).toBe(6);
    expect(hitsFor(0.2, 0.5)).toBe(3); // a camera lens
    expect(hitsFor(0.3, 1)).toBe(4);
  });

  it("draws glass thresholds in [0.75, 1.5) from the level RNG at creation", () => {
    const rng = new LevelRng();
    const values = Array.from({ length: 200 }, () => R.glassThreshold(rng));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0.75);
    expect(Math.max(...values)).toBeLessThan(1.5);
    expect(rng.draws).toBe(200);
    // Hits of 0.2 needed: ceil-like, 4 .. 8.
    for (const t of values) {
      let acc = 0;
      let hits = 0;
      for (;;) {
        hits++;
        const r = R.accumulate(acc, Math.fround(0.2), t);
        acc = r.stored;
        if (r.reached) break;
      }
      expect(hits).toBeGreaterThanOrEqual(4);
      expect(hits).toBeLessThanOrEqual(8);
    }
  });

  it("plans fireballs and smoke like FUN_0047d570", () => {
    const one = R.fireballPlan(new LevelRng(), 2048, 1);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ size: 2048, life: 75, period: 75, delay: 0 });
    const rng = new LevelRng();
    const four = R.fireballPlan(rng, 8192, 4);
    expect(four).toHaveLength(4);
    expect(four[0].size).toBe(6144); // 0.75 x radius with several fireballs
    expect(rng.draws).toBe(3 * 7);
    for (let i = 1; i < 4; i++) {
      const f = four[i];
      expect(f.size).toBeGreaterThanOrEqual(0.5 * 8192);
      expect(f.size).toBeLessThan(0.75 * 8192);
      expect(f.life).toBeGreaterThanOrEqual(37);
      expect(f.life).toBeLessThan(75);
      expect(f.delay - 18 * i).toBeGreaterThanOrEqual(0); // 75 / 4 = 18 per step, + trunc(15 r)
      expect(f.delay - 18 * i).toBeLessThan(15);
      for (const o of f.offset) expect(Math.abs(o)).toBeLessThanOrEqual(4096);
    }
    expect(R.smokePlan(4096, 0)).toBeNull();
    expect(R.smokePlan(4096, 1)?.life).toBe(150);
    expect(R.smokePlan(4096, 4)?.life).toBe(261);
  });

  it("makes explosions with six draws and a unit fragment direction", () => {
    const rng = new LevelRng();
    const spec = R.makeExplosion(rng, { position: [1, 2, 3], interval: 0, damage: 0.5, radius: 2048, falloff: 2048, scorch: 6144, fragments: 1, fireballs: 1, sound: "explo_monitor", aiRange: 100000 });
    expect(rng.draws).toBe(6);
    expect(Math.hypot(...spec.direction)).toBeCloseTo(1, 5);
    const frags = R.fragmentPlan(rng, { ...spec, fragments: 3 });
    expect(frags).toHaveLength(3);
    for (const v of frags) {
      const s = Math.hypot(...v.velocity);
      expect(s).toBeGreaterThanOrEqual(272 - 1e-3);
      expect(s).toBeLessThanOrEqual(1360 + 1e-3);
    }
    expect(rng.draws).toBe(6 + 3 * 7);
    // FUN_004fa1d0: gravity scales with the blast radius (bullet debris: radius 2048 -> 19.67 units/tick).
    expect(R.fragmentGravity(2048)).toBe(FRAGMENT_GRAVITY);
    expect(R.fragmentGravity(7 * 4096)).toBeCloseTo(19.67 * 14, 1);
    const step = R.explosionFragmentStep([0, 0, 0], [100, 0, 0], frags[0].rotation, R.spinRotation(0, 0, 0), R.fragmentGravity(2048));
    expect(step.velocity[0]).toBeCloseTo(98, 4);
    expect(step.velocity[2]).toBeCloseTo(-19.67, 2);
  });

  it("hits the player like FUN_00412930 (knock-back, shake, ear ringing, damage x difficulty)", () => {
    const r = rec(); // hand grenade: 7 m, falloff 3 m, factor 1
    const eye: R.V3 = [4096 * 2, 0, 0];
    const origin: R.V3 = [4096 * 2, 0, -2826.24];
    const rng = new LevelRng();
    const hit = R.playerExplosionHit(r, eye, origin, 3882.719482421875, 1, 2, false, rng);
    expect(hit.damage).toBe(1.25);
    expect(hit.knock![0]).toBeCloseTo(758.518, 2);
    expect(hit.knock![1]).toBe(0);
    expect(hit.shake).toEqual({ amplitude: Math.fround(204.8000030517578), angle: Math.fround(0.013089969754219055), ticks: 90 });
    expect(hit.earcandy).toBeCloseTo(1 - 8192 * R.EARCANDY_PER_UNIT, 6);
    expect(hit.indicators).toHaveLength(4);
    expect(rng.draws).toBe(4);
    // Out of reach: nothing, no draws.
    const far = R.playerExplosionHit(r, [4096 * 40, 0, 0], [4096 * 40, 0, 0], 3882.7, 1, 1, false, rng);
    expect(far).toMatchObject({ damage: 0, knock: null, indicators: null });
    expect(rng.draws).toBe(4);
  });

  it("gives soldiers the zone-13 damage and a 1.5 degree shake", () => {
    const s = R.soldierExplosionHit(rec(), [4096 * 9, 0, 0], [4096 * 9, 0, 0], 3793.4, 1);
    // e = 9 m - 0.309 m - 7 m = 1.69 m within the 3 m falloff.
    expect(s.damage).toBeCloseTo((3 - (9 - 3793.4 / 3 / 4096 - 7)) / 3, 4);
    expect(s.shake?.angle).toBeCloseTo(0.02617993950843811, 7);
  });
});

const haveLevel = existsSync(`${RAW_ROOT}/${LEVEL1_PATHS.objects}`);

describe.skipIf(!haveLevel)("level-1 destructibles", () => {
  let level: IgiLevel;
  let data: DamageModelData;
  let world: BuiltWorld;
  beforeAll(async () => {
    const raw = createFsAssetSource(RAW_ROOT);
    level = await loadIgiLevel(raw);
    const names = damageModelNames(level);
    data = await loadDamageModelData(raw, names.bounds, names.build, (key) => level.textures.has(key));
    world = buildWorld(level, (b) => b.addIndexed(level.terrain.detail.positions, level.terrain.detail.indices, TRI_BULLET | TRI_SIGHT, 1));
  }, 240_000);

  it("reads the model header bounds and the explode-magic definitions", async () => {
    const barrel = data.bounds.get("300_01_1")!;
    expect(barrel.sphereCentre.map((v) => Math.round(v * 10) / 10)).toEqual([152.1, 15.6, 1791.9]);
    expect(barrel.sphereRadius).toBeCloseTo(2321.8, 1);
    expect(barrel.originRadius).toBeCloseTo(4639.977, 3);
    expect(data.bounds.get("203_01_1")!.magic[0].map(Math.round)).toEqual([-13, -1895, 1093]);
    expect(data.bounds.get("203_02_1")!.magic).toHaveLength(0);
    expect(data.bounds.get("000_01_1")!.originRadius).toBeCloseTo(3882.7195, 3);
    const defs = readExplodeMagicDefs(await readRaw(LEVEL1_PATHS.magicObjects));
    expect(defs.get("300_01_1")).toMatchObject({ destroyedModel: "300_02_1", sound: "explo_02_m", hitPoints: 3, fireballs: 2, fragments: 5, falloffM: 5, damage: 3, radiusM: 2 });
    expect(data.models.get("203_02_1")?.collision).toBeTruthy();
    expect(data.models.get("1006_01_1")?.positions.length).toBe(54 * 3);
  });

  it("builds every level-1 damage object", () => {
    const ctx = fakeContext(level);
    const sys = createDamageSystem(ctx);
    sys.attach(level, world, data);
    const count = (k: string) => sys.objects.filter((o) => o.kind === k).length;
    expect(count("glass")).toBe(54 + 4 + 24);
    expect(count("explodeMagic")).toBe(14);
    expect(count("explodeObject")).toBe(6 + 3 + 1 + 2);
    expect(count("scameraLens")).toBe(5);
    expect(count("switch")).toBe(0); // every level-1 switch has Destructable = FALSE
    expect(count("car")).toBe(1);
    expect(world.destructibleInstances.size).toBeGreaterThanOrEqual(54 + 4 + 24 + 14 + 8);
    expect(world.collision.bodyIds).toContain(DESTRUCTIBLE_BODY_ID);
  });

  it("breaks a shot glass pane after its threshold and removes it at the next update", () => {
    const ctx = fakeContext(level);
    const sys = createDamageSystem(ctx);
    sys.attach(level, world, data);
    const pane = sys.objects.find((o) => o.kind === "glass" && level.instances[o.instance].taskType === "Building")!;
    const ray = rayThrough(level, world, pane.instance);
    expect(ray).not.toBeNull();
    const { from, dir } = ray!;
    const first = world.collision.raycast(from[0], from[1], from[2], dir[0], dir[1], dir[2], 3, TRI_BULLET);
    expect(first?.owner).toBe(pane.instance);
    const breaks: unknown[] = [];
    ctx.events.on(DAMAGE_EVENTS.GlassBreak, (p) => breaks.push(p));
    let hits = 0;
    while (!pane.flag) {
      hits++;
      sys.bulletHit({ owner: pane.instance, point: first!.point, dir, remaining: 100 }, Math.fround(0.2));
      expect(hits).toBeLessThanOrEqual(8);
    }
    expect(hits).toBeGreaterThanOrEqual(4);
    expect(breaks).toHaveLength(1);
    // Still there until its update (FUN_004488c0 at the next tick).
    expect(world.collision.raycast(from[0], from[1], from[2], dir[0], dir[1], dir[2], 3, TRI_BULLET)?.owner).toBe(pane.instance);
    sys.beginTick();
    const after = world.collision.raycast(from[0], from[1], from[2], dir[0], dir[1], dir[2], 3, TRI_BULLET);
    expect(after?.owner ?? -1).not.toBe(pane.instance);
    expect(pane.done).toBe(true);
    sys.reset();
    expect(world.collision.raycast(from[0], from[1], from[2], dir[0], dir[1], dir[2], 3, TRI_BULLET)?.owner).toBe(pane.instance);
  });

  it("sets off a barrel and chains to its neighbours, with the explosion's effects", () => {
    const ctx = fakeContext(level);
    const sys = createDamageSystem(ctx);
    sys.attach(level, world, data);
    const barrels = sys.objects.filter((o) => o.kind === "explodeMagic");
    const first = barrels[0];
    const explosions: Array<{ sound: string }> = [];
    ctx.events.on(DAMAGE_EVENTS.Explosion, (p) => explosions.push(p as { sound: string }));
    // 3 hit points: 16 MP5SD rounds (chopped float32 sums).
    for (let k = 0; k < 16; k++) sys.bulletHit({ owner: first.instance, point: [0, 0, 0], dir: [1, 0, 0], remaining: 10 }, Math.fround(0.2));
    expect(first.flag).toBe(false); // the update (next tick) tests the sum
    sys.beginTick();
    expect(first.flag).toBe(true);
    expect(explosions).toHaveLength(0);
    sys.endTick();
    expect(explosions).toHaveLength(1);
    expect(explosions[0].sound).toBe("explo_02_m");
    // Barrels within 2 m (+ their own radius) got the full factor 3 and go off on the next tick.
    const near = barrels.filter((b) => b !== first && b.damage >= 3);
    sys.beginTick();
    sys.endTick();
    expect(explosions.length).toBe(1 + near.length);
    sys.reset();
  });

  it("explodes a shot computer (ExplodeObject) on its next update and swaps the destroyed model", () => {
    const ctx = fakeContext(level);
    const sys = createDamageSystem(ctx);
    sys.attach(level, world, data);
    const computer = sys.objects.find((o) => o.kind === "explodeObject" && level.tasks[o.node].type === "ExplodeObject")!;
    const destroyed: unknown[] = [];
    ctx.events.on(DAMAGE_EVENTS.ObjectDestroyed, (p) => destroyed.push(p));
    for (let k = 0; k < 6; k++) sys.bulletHit({ owner: computer.instance, point: [0, 0, 0], dir: [1, 0, 0], remaining: 10 }, Math.fround(0.2));
    sys.beginTick(); // countdown 0 -> explode (no task runtime attached: internal countdown)
    expect(destroyed).toMatchObject([{ type: "ExplodeObject", destroyedModel: "203_02_1" }]);
    sys.endTick();
    sys.reset();
  });

  it("drives the task runtime through the bridge (deferred bullet countdown, explosion delay)", () => {
    const ctx = fakeContext(level);
    const sys = createDamageSystem(ctx);
    sys.attach(level, world, data);
    const states = new Map<number, Record<string, number>>();
    const node = sys.objects.find((o) => o.kind === "explodeObject" && level.tasks[o.node].type === "ExplodeObject")!;
    states.set(node.node, { isExploded: 0, countdown: -1 });
    sys.setMissionBridge(missionRuntimeBridge({ nodeState: (i) => states.get(i) ?? { isExploded: 0, countdown: -1 } }, () => true));
    for (let k = 0; k < 6; k++) sys.bulletHit({ owner: node.instance, point: [0, 0, 0], dir: [1, 0, 0], remaining: 10 }, Math.fround(0.2));
    expect(states.get(node.node)!.countdown).toBe(-1); // written after the runtime's walk of this tick
    sys.endTick();
    expect(states.get(node.node)!.countdown).toBe(0);
    states.get(node.node)!.isExploded = 1; // the runtime explodes it on the next walk
    const booms: unknown[] = [];
    ctx.events.on(DAMAGE_EVENTS.Explosion, (p) => booms.push(p));
    sys.endTick();
    expect(booms).toHaveLength(1);
    sys.reset();
  });

  it("works with the real task runtime: shot computer -> countdown 0 -> runtime explodes it -> explosion", () => {
    const ctx = fakeContext(level);
    const sys = createDamageSystem(ctx);
    sys.attach(level, world, data);
    const runtime = new MissionRuntime(buildMissionTasks(level.taskRoots), {});
    sys.setMissionBridge(missionRuntimeBridge(runtime));
    const computer = sys.objects.find((o) => o.kind === "explodeObject" && level.tasks[o.node].type === "ExplodeObject")!;
    expect(runtime.nodeState(computer.node).countdown).toBe(-1);
    for (let k = 0; k < 6; k++) sys.bulletHit({ owner: computer.instance, point: [0, 0, 0], dir: [1, 0, 0], remaining: 10 }, Math.fround(0.2));
    sys.endTick();
    expect(runtime.nodeState(computer.node).countdown).toBe(0);
    const booms: Array<{ sound: string }> = [];
    ctx.events.on(DAMAGE_EVENTS.Explosion, (p) => booms.push(p as { sound: string }));
    sys.beginTick();
    runtime.tick(); // FUN_0047fce0: countdown 0 -> isExploded
    expect(runtime.nodeState(computer.node).isExploded).toBe(1);
    sys.endTick();
    expect(booms.map((b) => b.sound)).toEqual(["explo_monitor"]);
    // Its 0.5 m blast (factor 0.5) reached the neighbouring computers within reach: their
    // countdown is now trunc(0.5 s x 30) = 15 ticks, they go off 16 ticks later.
    const others = sys.objects.filter((o) => o.kind === "explodeObject" && o !== computer && o.damage >= 1);
    for (const o of others) expect(runtime.nodeState(o.node).countdown).toBe(15);
    sys.reset();
  });

  it("hurts the player near a grenade through the player API", () => {
    const ctx = fakeContext(level);
    const sys = createDamageSystem(ctx);
    sys.attach(level, world, data);
    let damage = 0;
    (ctx.systems as unknown as { player: unknown }).player = { damage: (a: number) => (damage += a) };
    const hits: unknown[] = [];
    ctx.events.on(GameEvent.PlayerHit, (p) => hits.push(p));
    const p = ctx.player.position;
    const o = level.originIgi;
    const at: R.V3 = [o[0] + p[0] * 4096 + 4096, o[1] - p[2] * 4096, o[2] + p[1] * 4096];
    sys.explode(sys.makeExplosion({ position: at, interval: 1, damage: 1, radius: 7 * 4096, falloff: 3 * 4096, scorch: 6144, fragments: 3, fireballs: 1, sound: "explo_02_m", aiRange: R.GRENADE_AI_RANGE }));
    sys.endTick();
    expect(damage).toBe(1);
    expect(hits).toMatchObject([{ amount: 1, explosion: true }]);
    expect(sys.earcandy).toBeGreaterThan(0.9);
  });
});

function fakeContext(level: IgiLevel): GameContext {
  return {
    events: new EventBus(),
    rng: new LevelRng(),
    level,
    scene: new THREE.Scene(),
    player: { position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0, grounded: true, crouching: false, running: false, health: 3, maxHealth: 3, alive: true, walking: false, eyeHeight: 1.6, kickPitch: 0, kickYaw: 0, leanSide: 0, leanUp: 0 },
    systems: { weapon: null, enemies: null, objectives: null, audio: null, hud: null, effects: null, tasks: null, player: null },
  } as unknown as GameContext;
}

/** A ray (engine space) that hits instance i's set-0 faces head-on from 1 m away. */
function rayThrough(level: IgiLevel, world: BuiltWorld, i: number): { from: [number, number, number]; dir: [number, number, number] } | null {
  const inst = level.instances[i];
  const set = level.models.get(inst.model)?.collision?.[0];
  if (!set || set.indices.length < 3) return null;
  const m = new THREE.Matrix4().fromArray(world.instanceWorldMatrix(i)!);
  const v = (k: number) => new THREE.Vector3().fromArray(set.positions, set.indices[k] * 3).applyMatrix4(m);
  const a = v(0);
  const b = v(1);
  const c = v(2);
  const centre = a.clone().add(b).add(c).multiplyScalar(1 / 3);
  const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
  const from = centre.clone().addScaledVector(n, 1);
  const dir = n.clone().negate();
  return { from: [from.x, from.y, from.z], dir: [dir.x, dir.y, dir.z] };
}
