/**
 * World task types on the real missions of the full game (game-data, all 14
 * missions; skipped when it is not staged): RotatingObject (L3, L5, L8),
 * AlarmLight + reflector and Siren (L6 ... L14), RainEffect (rain L3 / L9 /
 * L10, snow L7 / L12, inactive L4 / L8 / L11), CubeModifier (inert).
 * Rules: src/loaders/objects/*.ts, src/engine/world/world-tasks.ts,
 * src/engine/fx/rain.ts, src/engine/combat/object-damage.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ALARM_LIGHT_MODEL,
  MissionRuntime,
  buildMissionTasks,
  flattenTasks,
  levelPathsFor,
  loadIgiLevel,
  readQvmCallTree,
  readSoundDefinitions,
  readTaskTree,
  type IgiLevel,
} from "../src/loaders";
import { loadDamageModelData, type DamageModelData } from "../src/loaders/damage-data";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { LevelRng } from "../src/engine/ai/rng";
import type { GameContext } from "../src/engine/context";
import { EventBus } from "../src/engine/events";
import { DAMAGE_EVENTS, attachDamageSystem, createDamageSystem, damageModelNames, missionRuntimeBridge, type DamageSystem, type ExplosionEventPayload } from "../src/engine/combat/object-damage";
import { buildWorld, type BuiltWorld } from "../src/engine/world/world-builder";
import { TRI_BULLET, TRI_SIGHT, TRI_SOLID, TRI_TERRAIN } from "../src/engine/world/collision";
import { dynamicTaskKeys } from "../src/engine/level";
import { ALARM_REFLECTOR_MAGIC, createWorldTasks, sameModelContent, type WorldTasks } from "../src/engine/world/world-tasks";
import { readMissionDefinition } from "../src/engine/ui/assets";

const FULL = fileURLToPath(new URL("../game-data", import.meta.url));
const haveFull = existsSync(`${FULL}/missions/location0/level14/mission.qvm`);
const bytes = (path: string): ArrayBuffer => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const raw = createFsAssetSource(FULL);

async function loadLevel(id: number): Promise<IgiLevel> {
  const [def] = readMissionDefinition(bytes(`${FULL}/missions/location0/level${id}/mission.qvm`), new Map());
  return loadIgiLevel(raw, levelPathsFor(def.location));
}

function tasksOf(id: number) {
  return flattenTasks(readTaskTree(readQvmCallTree(bytes(`${FULL}/missions/location0/level${id}/objects.qvm`))));
}

/** A level with its world, damage data, runtime and the world-task system (the game.ts wiring). */
interface Rig {
  level: IgiLevel;
  world: BuiltWorld;
  data: DamageModelData;
  rt: MissionRuntime;
  damage: DamageSystem;
  wt: WorldTasks;
  ctx: GameContext;
  sounds: Array<{ name: string; position: number[]; disposed: boolean }>;
  /** Last render-only transform per placed instance (setInstanceTransform spy). */
  transforms: Map<number, number[]>;
  explosions: ExplosionEventPayload[];
  tick(n?: number): void;
}

async function rig(id: number): Promise<Rig> {
  const level = await loadLevel(id);
  const world = buildWorld(
    level,
    (b) => b.addIndexed(level.terrain.detail.positions, level.terrain.detail.indices, TRI_SOLID | TRI_BULLET | TRI_SIGHT | TRI_TERRAIN, 1),
    { dynamicTasks: dynamicTaskKeys(level) },
  );
  const names = damageModelNames(level);
  const data = await loadDamageModelData(raw, names.bounds, names.build, (key) => level.textures.has(key), level.paths);
  const ctx = {
    events: new EventBus(),
    rng: new LevelRng(),
    level,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 2000),
    world: world.collision,
    player: { position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0, grounded: true, crouching: false, running: false, health: 3, maxHealth: 3, alive: true, walking: false, eyeHeight: 1.6, kickPitch: 0, kickYaw: 0, leanSide: 0, leanUp: 0 },
    systems: { weapon: null, enemies: null, objectives: null, audio: null, hud: null, effects: null, tasks: null, player: null },
  } as unknown as GameContext;
  const damage = createDamageSystem(ctx, { fx: false });
  attachDamageSystem(ctx, damage);
  damage.attach(level, world, data);
  const rt = new MissionRuntime(buildMissionTasks(level.taskRoots));
  damage.setMissionBridge(missionRuntimeBridge(rt));
  const sounds: Rig["sounds"] = [];
  const explosions: ExplosionEventPayload[] = [];
  ctx.events.on(DAMAGE_EVENTS.Explosion, (p) => explosions.push(p as ExplosionEventPayload));
  const audio = {
    objectSound(name: string, position: number[]) {
      const entry = { name, position: [...position], disposed: false };
      sounds.push(entry);
      return { update() {}, dispose() { entry.disposed = true; }, alive: true };
    },
  };
  const transforms = new Map<number, number[]>();
  const spy = {
    get dynamicTasks() {
      return world.dynamicTasks;
    },
    setTaskTransform: (k: number, m: ArrayLike<number>) => world.setTaskTransform(k, m),
    setInstanceTransform: (i: number, m: ArrayLike<number>, copy?: number) => {
      transforms.set(i, Array.from(m));
      world.setInstanceTransform(i, m, copy);
    },
    setInstanceModel: (i: number, m: Parameters<BuiltWorld["setInstanceModel"]>[1]) => world.setInstanceModel(i, m),
    setInstanceHidden: (i: number, h: boolean) => world.setInstanceHidden(i, h),
  };
  const wt = createWorldTasks(ctx, { runtime: () => rt, world: () => spy, audio: () => audio as never });
  await wt.load(raw, level);
  wt.reset();
  return {
    level, world, data, rt, damage, wt, ctx, sounds, explosions, transforms,
    tick(n = 1) {
      for (let i = 0; i < n; i++) {
        damage.beginTick();
        rt.tick();
        damage.endTick();
        wt.tick();
      }
    },
  };
}

const nodeOf = (rt: MissionRuntime, type: string, id?: number) => rt.tasks.nodes.find((n) => n.type === type && (id === undefined || n.id === id))!;

/** Put the camera 2 m from placed instance i, looking at it. */
function lookAt(r: Rig, i: number): void {
  const p = new THREE.Vector3().fromArray(r.level.instances[i].matrix, 12);
  r.ctx.camera.position.set(p.x + 1.5, p.y + 0.5, p.z + 1.5);
  r.ctx.camera.lookAt(p);
  r.ctx.camera.updateMatrixWorld();
  r.world.update(r.ctx.camera);
}

/** A ray (engine space) that meets instance i's first set-0 face head-on from 1 m away, at its current pose. */
function rayAt(r: Rig, i: number): { from: THREE.Vector3; dir: THREE.Vector3 } {
  const set = r.level.models.get(r.level.instances[i].model)!.collision![0];
  const m = new THREE.Matrix4().fromArray(r.world.instanceWorldMatrix(i)!);
  const v = (k: number) => new THREE.Vector3().fromArray(set.positions, set.indices[k] * 3).applyMatrix4(m);
  const [a, b, c] = [v(0), v(1), v(2)];
  const centre = a.clone().add(b).add(c).multiplyScalar(1 / 3);
  const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
  return { from: centre.clone().addScaledVector(n, 1), dir: n.negate() };
}
const hitOwner = (r: Rig, ray: { from: THREE.Vector3; dir: THREE.Vector3 }) =>
  r.world.collision.raycast(ray.from.x, ray.from.y, ray.from.z, ray.dir.x, ray.dir.y, ray.dir.z, 1.5, TRI_BULLET)?.owner ?? null;

describe.skipIf(!haveFull)("full game: world task types", () => {
  it("census (objects.qvm of every mission) and CubeModifier is never placed, always under Static", () => {
    const types = ["CubeModifier", "RainEffect", "RotatingObject", "AlarmLight", "Siren", "DiscardTerrainArea"];
    const counts: Record<string, number[]> = Object.fromEntries(types.map((t) => [t, []]));
    for (let l = 1; l <= 14; l++) {
      const all = tasksOf(l);
      for (const t of types) counts[t].push(all.filter((x) => x.type === t).length);
      const parent = new Map<unknown, (typeof all)[number]>();
      for (const t of all) for (const c of t.children) parent.set(c, t);
      // Every CubeModifier has Static above it (directly or through a Container): never updated.
      for (const t of all.filter((x) => x.type === "CubeModifier")) {
        const chain: string[] = [];
        for (let p = parent.get(t); p; p = parent.get(p)) chain.push(p.type);
        expect(chain).toContain("Static");
        expect(chain.slice(0, chain.indexOf("Static")).every((x) => x === "Container")).toBe(true);
      }
    }
    expect(counts.CubeModifier).toEqual([0, 0, 0, 0, 0, 4, 0, 8, 2, 1, 0, 0, 0, 0]);
    expect(counts.RainEffect).toEqual([0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0]);
    expect(counts.RotatingObject).toEqual([0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    expect(counts.AlarmLight).toEqual([0, 0, 0, 0, 0, 3, 2, 7, 2, 0, 0, 0, 0, 2]);
    expect(counts.Siren).toEqual([0, 0, 0, 0, 0, 9, 5, 7, 6, 0, 7, 0, 0, 0]);
    expect(counts.DiscardTerrainArea.every((n) => n === 0)).toBe(true);
  });

  it("the sounds they name (common sounds.qvm): generator_run 25 m loop, alarmsystem_working 40 / 80 m loop, explo_01_s; explosion_1 is undefined", () => {
    const defs = readSoundDefinitions(bytes(`${FULL}/common/sounds/sounds.qvm`), "common");
    const by = (n: string) => defs.find((d) => (d as { name?: string }).name === n) as Record<string, unknown> | undefined;
    expect(by("generator_run")).toMatchObject({ sample: "GENERATOR_RUN", minDistance: 0, maxDistance: 25, loop: true, volumeVar: -1, pitchVar: -1 });
    expect(by("alarmsystem_working")).toMatchObject({ sample: "ALARM_1", volume: 1, minDistance: 40, maxDistance: 80, loop: true });
    expect(by("explo_01_s")).toMatchObject({ maxDistance: 65, loop: false });
    expect(by("explosion_1")).toBeUndefined();
  });

  describe("mission 3: the radar dish and the rain", () => {
    let r: Rig;
    beforeAll(async () => {
      r = await rig(3);
    }, 240_000);

    it("places the dish (436_02_1) as a dynamic task and turns it 90 deg/s about the vertical; collision follows", () => {
      const dish = r.level.instances.findIndex((i) => i.taskType === "RotatingObject");
      expect(dish).toBeGreaterThanOrEqual(0);
      const inst = r.level.instances[dish];
      expect(inst.model).toBe("436_02_1");
      const node = inst.taskIndex!;
      expect(r.world.dynamicTasks.has(node)).toBe(true);
      const before = new THREE.Matrix4().fromArray(inst.matrix);
      r.tick(30);
      expect(r.rt.nodeState(node).az).toBeCloseTo(90, 2);
      const now = new THREE.Matrix4().fromArray(r.world.instanceWorldMatrix(dish)!);
      const p0 = new THREE.Vector3().setFromMatrixPosition(before);
      const p1 = new THREE.Vector3().setFromMatrixPosition(now);
      expect(p1.distanceTo(p0)).toBeLessThan(1e-6); // turns about Position
      const x0 = new THREE.Vector3().setFromMatrixColumn(before, 0);
      const x1 = new THREE.Vector3().setFromMatrixColumn(now, 0);
      expect(x0.dot(x1)).toBeCloseTo(0, 4); // 90 degrees
      expect(Math.abs(x1.y)).toBeLessThan(1e-6); // about the vertical (engine y)
      // IGI Rz(+90): IGI x -> IGI y = engine -z.
      expect(x1.z).toBeCloseTo(-x0.x, 4);
      const body = r.world.collision.bodyMatrix(node);
      expect(body).not.toBeNull();
      r.tick(90);
      expect(r.rt.nodeState(node).az).toBeLessThan(360);
      expect(r.rt.nodeState(node).cz).toBe(90); // On "1": spins forever
      expect(r.sounds.filter((s) => s.name === "generator_run")).toHaveLength(0); // L3: no Rotate sound
      // Destructable FALSE: bullets do nothing to it (not a damage object).
      expect(r.damage.objects.some((o) => o.kind === "rotatingObject")).toBe(false);
    });

    it("rain: alpha byte 33, 80 drops after 13 ticks, drawn around the camera above the floors", () => {
      expect(r.wt.rains).toHaveLength(1);
      const rain = r.wt.rains[0].renderer;
      expect(rain.sim?.snow).toBe(false);
      expect(rain.sim!.colour).toBe(0x21ffffff);
      expect(rain.sim!.count).toBe(80); // already ticked 120 times
      expect(rain.sim!.fade).toBe(1);
      // The camera at the player's start (engine origin), looking north and slightly down.
      r.ctx.camera.position.set(0, 2, 0);
      r.ctx.camera.lookAt(0, 1.5, -10);
      r.ctx.camera.updateMatrixWorld();
      rain.draw(r.ctx.camera);
      expect(rain.columns.lastTraces).toBe(144);
      expect(rain.drawn).toBeGreaterThan(0);
      expect(rain.object.visible).toBe(true);
      rain.draw(r.ctx.camera);
      expect(rain.columns.lastTraces).toBe(0);
    });
  });

  it("mission 5: On \"0\" with acceleration 0 spins forever at 25 deg/s; generator_run loops from the compile", async () => {
    const r = await rig(5);
    const node = nodeOf(r.rt, "RotatingObject").index;
    r.tick(200);
    expect(r.rt.nodeState(node).tz).toBe(0);
    expect(r.rt.nodeState(node).cz).toBe(25);
    const sound = r.sounds.filter((s) => s.name === "generator_run");
    expect(sound).toHaveLength(1);
    expect(sound[0].disposed).toBe(false);
  }, 240_000);

  it("mission 8: the dish decelerates 1 deg/s^2 after Switch 260 is pressed and never restarts", async () => {
    const r = await rig(8);
    const node = nodeOf(r.rt, "RotatingObject").index;
    r.tick(10);
    expect(r.rt.nodeState(node).cz).toBe(25);
    r.rt.pressSwitch(260);
    r.tick(30);
    expect(r.rt.nodeState(node).cz).toBeCloseTo(24, 3);
    r.tick(26 * 30);
    expect(r.rt.nodeState(node).cz).toBe(0);
    expect(r.rt.nodeState(node).tz).toBe(0);
    // Rain in mission 8 is "FALSE": the Rain object never fades in.
    expect(r.wt.rains[0].renderer.sim!.fade).toBe(0);
    expect(r.wt.rains[0].renderer.sim!.count).toBe(0);
  }, 240_000);

  describe("mission 6: alarm lights, reflectors and sirens", () => {
    let r: Rig;
    let lamps: Array<{ node: number; root: number; reflector: number }>;
    beforeAll(async () => {
      r = await rig(6);
      lamps = r.rt.tasks.nodes.filter((n) => n.type === "AlarmLight").map((n) => ({
        node: n.index,
        root: r.level.instances.findIndex((i) => i.taskIndex === n.index && i.attachmentPath === ""),
        reflector: r.level.instances.findIndex((i) => i.taskIndex === n.index && i.magicType === ALARM_REFLECTOR_MAGIC),
      }));
    }, 240_000);

    it("places each lamp with its Off model and the 344_02_1 reflector from its ATTA; sirens with their model", () => {
      expect(lamps).toHaveLength(3);
      for (const l of lamps) {
        expect(r.level.instances[l.root].model).toBe("344_01_1");
        const refl = r.level.instances[l.reflector];
        expect(refl.model).toBe("344_02_1");
        expect(refl.attachmentPath).toBe("0");
        // Reflector origin = lamp + R(gamma) x (1.127, 142.04, 10.43) units (ATTA of 344_01_1).
        const a = new THREE.Vector3().fromArray(r.level.instances[l.root].matrix, 12);
        const b = new THREE.Vector3().fromArray(refl.matrix, 12);
        expect(a.distanceTo(b) * 4096).toBeCloseTo(Math.hypot(1.1271085739135742, 142.0423126220703, 10.427105903625488), 1);
        expect(r.world.destructibleInstances.has(l.root)).toBe(true);
      }
      expect(r.level.instances.filter((i) => i.taskType === "Siren" && i.attachmentPath === "")).toHaveLength(9);
      // The On model differs from the Off model only by the ATTA: the swap changes nothing drawn.
      expect(sameModelContent(r.level.models.get("344_01_1")!, r.data.models.get("344_03_1")!)).toBe(true);
    });

    it("alarm on: lamps on, reflectors spin 180 deg/s, glows pulse; sirens wail; alarm off: the On-model swap is invisible", () => {
      const lightsOn = (on: number) => {
        const v = nodeOf(r.rt, "EditVariable", 96).index;
        (r.rt.nodeState(v) as Record<string, number>).nValue = on;
      };
      expect(r.wt.alarmLightGlows()).toHaveLength(0);
      lightsOn(1);
      r.tick(2);
      for (const l of lamps) expect(r.rt.nodeState(l.node).isOn).toBe(1);
      const working = r.sounds.filter((s) => s.name === "alarmsystem_working" && !s.disposed);
      expect(working).toHaveLength(4); // the four sirens on AlarmControl_98
      r.tick(15);
      // On from the first tick (AlarmControl_98 updates before the lamps): 17 ticks on, theta =
      // 17 x f32(pi/30); the reflector's render entry turns about its own origin by Rx(theta) in
      // its model frame (spin = build x Rx x build^-1).
      const theta = r.rt.nodeState(lamps[0].node).theta;
      expect(theta).toBeCloseTo(17 * Math.PI / 30, 4);
      const build = new THREE.Matrix4().fromArray(r.level.instances[lamps[0].reflector].matrix);
      const spin = new THREE.Matrix4().fromArray(r.transforms.get(lamps[0].reflector)!);
      const posed = spin.clone().multiply(build);
      const expected = build.clone().multiply(new THREE.Matrix4().makeRotationX(theta));
      for (let k = 0; k < 16; k++) expect(posed.elements[k]).toBeCloseTo(expected.elements[k], 4);
      const after = r.world.instanceWorldMatrix(lamps[0].reflector)!;
      const glows = r.wt.alarmLightGlows();
      expect(glows).toHaveLength(3);
      expect(glows[0].rgb[0]).toBeCloseTo(128 * Math.abs((2 * (theta % Math.PI)) / Math.PI - 1), 3);
      expect(glows[0].rgb[1]).toBe(0);
      expect(glows[0].halfSize).toBe(1.5);
      // The glow sits on the reflector's magic vertex 0 (about 0.12 m from its origin).
      const centre = new THREE.Vector3().fromArray(after, 12);
      expect(new THREE.Vector3(...glows[0].position).distanceTo(centre) * 4096).toBeCloseTo(Math.hypot(276.3231201171875, 430.4527282714844, 3.1501762866973877), 0);
      lightsOn(0);
      r.tick(2);
      for (const l of lamps) {
        expect(r.rt.nodeState(l.node).isOn).toBe(0);
        expect(r.rt.nodeState(l.node).model).toBe(ALARM_LIGHT_MODEL.on);
      }
      expect(r.wt.alarmLightGlows()).toHaveLength(0);
      expect(r.sounds.filter((s) => s.name === "alarmsystem_working" && !s.disposed)).toHaveLength(0);
      // Still drawn and solid: no swap happened (344_03_1 draws and collides as 344_01_1).
      lookAt(r, lamps[1].root);
      expect(r.world.lodOf(lamps[1].root)).toBeGreaterThanOrEqual(0);
      expect(hitOwner(r, rayAt(r, lamps[1].root))).toBe(lamps[1].root);
    });

    it("one bullet destroys a lamp: a 1 m explosion (0.05 damage, 2 fireballs), the lamp vanishes, its reflector is no longer drawn", () => {
      const l = lamps[2];
      lookAt(r, l.root);
      expect(r.world.lodOf(l.reflector)).toBeGreaterThanOrEqual(0);
      const ray = rayAt(r, l.root);
      expect(hitOwner(r, ray)).toBe(l.root);
      r.explosions.length = 0;
      expect(r.damage.bulletHit({ owner: l.root, point: [0, 0, 0], dir: [1, 0, 0], remaining: 10 }, Math.fround(0.2))).toBe(true);
      expect(r.rt.nodeState(l.node).isDestroyed).toBe(1);
      expect(r.damage.bulletHit({ owner: l.root, point: [0, 0, 0], dir: [1, 0, 0], remaining: 10 }, Math.fround(0.2))).toBe(false);
      r.tick();
      expect(r.explosions).toHaveLength(1);
      expect(r.explosions[0]).toMatchObject({ radiusM: 1, falloffM: 0, fireballs: 2, fragments: 5, sound: "" });
      expect(r.explosions[0].damage).toBeCloseTo(0.05, 6);
      r.world.update(r.ctx.camera);
      expect(r.world.lodOf(l.root)).toBe(-1);
      expect(r.world.lodOf(l.reflector)).toBe(-1);
      expect(hitOwner(r, ray)).not.toBe(l.root); // "Destroyde model" "": no model, no collision
      // Destroyed: the update returns at once (isOn frozen, theta frozen), no glow.
      const v = nodeOf(r.rt, "EditVariable", 96).index;
      const frozen = { ...r.rt.nodeState(l.node) };
      (r.rt.nodeState(v) as Record<string, number>).nValue = 1 - (frozen.isOn ?? 0);
      r.tick(3);
      expect(r.rt.nodeState(l.node).isOn).toBe(frozen.isOn);
      expect(r.rt.nodeState(l.node).theta).toBe(frozen.theta);
      (r.rt.nodeState(v) as Record<string, number>).nValue = 1;
      r.tick(3);
      expect(r.wt.alarmLightGlows()).toHaveLength(2);
    });

    it("a siren takes six 0.2 bullets, explodes silently (explosion_1) and keeps wailing with its Faulty sound", () => {
      const siren = r.level.instances.findIndex((i) => i.taskType === "Siren" && i.attachmentPath === "" && r.rt.tasks.nodes[i.taskIndex!].id === 93);
      const node = r.level.instances[siren].taskIndex!;
      r.explosions.length = 0;
      for (let k = 0; k < 6; k++) r.damage.bulletHit({ owner: siren, point: [0, 0, 0], dir: [1, 0, 0], remaining: 10 }, Math.fround(0.2));
      r.tick(2);
      expect(r.rt.member("Siren_93.isExploded")).toBe(1);
      expect(r.explosions).toHaveLength(1);
      expect(r.explosions[0]).toMatchObject({ radiusM: 0.5, falloffM: 0.5, damage: 1, fireballs: 4, fragments: 5, sound: "explosion_1" });
      expect(r.rt.member("Siren_93.isOn")).toBe(1);
      expect(r.rt.nodeState(node).faulty).toBe(1);
      expect(r.rt.nodeState(node).working).toBe(0);
    });

    it("a restart puts every lamp back (models, reflectors, theta 0)", () => {
      r.damage.reset();
      const rt2 = new MissionRuntime(buildMissionTasks(r.level.taskRoots));
      (r as { rt: MissionRuntime }).rt = rt2;
      r.damage.setMissionBridge(missionRuntimeBridge(rt2));
      const wt2 = createWorldTasks(r.ctx, { runtime: () => rt2, world: () => r.world });
      wt2.attach(r.level, null);
      wt2.reset();
      lookAt(r, lamps[2].root);
      expect(r.world.lodOf(lamps[2].root)).toBeGreaterThanOrEqual(0);
      expect(r.world.lodOf(lamps[2].reflector)).toBeGreaterThanOrEqual(0);
      expect(rt2.nodeState(lamps[2].node).isDestroyed).toBe(0);
      wt2.dispose();
    });
  });

  it("snow in missions 7 and 12 (Is Rain false); inactive rain in missions 4 and 11", async () => {
    for (const [id, snow, active] of [[7, true, true], [12, true, true], [4, false, false], [11, false, false]] as const) {
      const tasks = tasksOf(id).filter((t) => t.type === "RainEffect");
      expect(tasks).toHaveLength(1);
      expect(tasks[0].params["Is Rain"]).toBe(!snow);
      void active;
    }
    const r = await rig(7);
    const rain = r.wt.rains[0].renderer;
    r.tick(121);
    expect(rain.sim!.snow).toBe(true);
    expect(rain.sim!.count).toBe(80);
    r.ctx.camera.position.set(0, 2, 0);
    r.ctx.camera.lookAt(0, 1.5, -10);
    r.ctx.camera.updateMatrixWorld();
    rain.draw(r.ctx.camera);
    expect(rain.drawn).toBeGreaterThan(0);
    expect(r.wt.alarmLightGlows()).toHaveLength(0);
  }, 240_000);
});
