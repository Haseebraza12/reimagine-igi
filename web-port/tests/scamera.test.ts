/**
 * Security cameras (SCamera, docs/mission.md "SCamera", docs/damage.md
 * "SCamera"): the holder model, the lens / camera head object (SCameraLens,
 * "Camera Model") at the holder's magic vertex 0, its pose Rz(Holder Gamma +
 * Camera Gamma + sweep) Rx(pitch), the dynamic body that follows it, the
 * damage lens and the destroyed-model swap. Real-data checks use the staged
 * original files and are skipped when they are absent.
 */
import { existsSync } from "node:fs";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { LEVEL1_PATHS, loadIgiLevel, type IgiLevel } from "../src/loaders";
import { igiPointToEngine, igiRotationToEngine, engineMatrix4 } from "../src/loaders/coords";
import {
  SCAMERA_OFF_PITCH,
  eulerToMatrix,
  securityCameraLensMatrix,
  securityCameraLensPivot,
  type Vec3,
} from "../src/loaders/mission";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { loadDamageModelData, type DamageModelData } from "../src/loaders/damage-data";
import { LevelRng } from "../src/engine/ai/rng";
import type { GameContext } from "../src/engine/context";
import { EventBus } from "../src/engine/events";
import { DAMAGE_EVENTS, createDamageSystem, damageModelNames, missionRuntimeBridge } from "../src/engine/combat/object-damage";
import { SCAMERA_LENS_KEY_BASE, buildWorld, scameraLensKey, taskNodeOfKey, type BuiltWorld } from "../src/engine/world/world-builder";
import { TERRAIN_HIT_MATERIAL, TRI_BULLET, TRI_SIGHT, TRI_SOLID, TRI_TERRAIN } from "../src/engine/world/collision";
import { dynamicTaskKeys } from "../src/engine/level";
import { createMissionSystem, type MissionSystem } from "../src/engine/mission/mission-system";
import { RAW_ROOT } from "./helpers";

describe("SCamera lens pose rules (FUN_00441290, FUN_004a9bc0 at 0x440c24)", () => {
  it("puts the lens at the holder + Rz(Holder Gamma) x magic vertex 0", () => {
    const p = securityCameraLensPivot([100, 200, 300], Math.PI / 2, [0, 1000, 50]);
    expect(p[0]).toBeCloseTo(100 - 1000, 6);
    expect(p[1]).toBeCloseTo(200, 6);
    expect(p[2]).toBeCloseTo(350, 6);
    expect(securityCameraLensPivot([1, 2, 3], 1, null)).toEqual([1, 2, 3]); // FUN_00486e20: no magic vertex -> 0
  });

  it("turns Rz(sweep + Holder Gamma + Camera Gamma) Rx(pitch); model +y is the view, negative pitch looks down", () => {
    const m = securityCameraLensMatrix(0.5, 0.25, 0.125, -0.1);
    const ref = eulerToMatrix(-0.1, 0, Math.fround(0.875));
    m.forEach((v, i) => expect(v).toBeCloseTo(ref[i], 7));
    const droop = securityCameraLensMatrix(0, 0, 0, SCAMERA_OFF_PITCH);
    // forward = column y
    expect(droop[7]).toBeCloseTo(Math.sin(-75 * Math.PI / 180), 6);
    expect(droop[4]).toBeCloseTo(Math.cos(75 * Math.PI / 180), 6);
  });

  it("keys lens bodies apart from task nodes", () => {
    expect(scameraLensKey(469)).toBe(SCAMERA_LENS_KEY_BASE + 469);
    expect(taskNodeOfKey(scameraLensKey(469))).toBe(469);
    expect(taskNodeOfKey(469)).toBe(469);
  });
});

const haveLevel = existsSync(`${RAW_ROOT}/${LEVEL1_PATHS.objects}`);

/** Engine-space point of model-space IGI point `local` through a column-major matrix. */
function modelPoint(m: ArrayLike<number>, local: readonly number[]): THREE.Vector3 {
  const e = new THREE.Vector3(local[0] / 4096, local[2] / 4096, -local[1] / 4096);
  return e.applyMatrix4(new THREE.Matrix4().fromArray(Array.from(m)));
}

/** A ray (engine space) 0.3 m outside the set-0 face of instance i farthest from its origin, aimed at it. */
function rayAtFarFace(level: IgiLevel, world: BuiltWorld, i: number): { from: Vec3; dir: Vec3; target: THREE.Vector3 } {
  const inst = level.instances[i];
  const set = level.models.get(inst.model)!.collision![0];
  let best = -1;
  let bestD = -1;
  for (let k = 0; k + 2 < set.indices.length; k += 3) {
    const c = [0, 1, 2].map((q) => new THREE.Vector3().fromArray(set.positions, set.indices[k + q] * 3));
    const centre = c[0].clone().add(c[1]).add(c[2]).multiplyScalar(1 / 3);
    const area = new THREE.Vector3().subVectors(c[1], c[0]).cross(new THREE.Vector3().subVectors(c[2], c[0])).length();
    if (area < 1e-4) continue;
    const d = centre.length();
    if (d > bestD) {
      bestD = d;
      best = k;
    }
  }
  const m = new THREE.Matrix4().fromArray(world.instanceWorldMatrix(i)!);
  const v = (q: number) => new THREE.Vector3().fromArray(set.positions, set.indices[best + q] * 3).applyMatrix4(m);
  const [a, b, c] = [v(0), v(1), v(2)];
  const target = a.clone().add(b).add(c).multiplyScalar(1 / 3);
  const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
  const from = target.clone().addScaledVector(n, 0.3);
  const dir = n.clone().negate();
  return { from: [from.x, from.y, from.z], dir: [dir.x, dir.y, dir.z], target };
}

function fakeContext(level: IgiLevel): GameContext {
  return {
    events: new EventBus(),
    rng: new LevelRng(),
    level,
    scene: new THREE.Scene(),
    input: { isDown: () => false },
    enemies: [],
    player: { position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0, grounded: true, crouching: false, running: false, health: 3, maxHealth: 3, alive: true, walking: false, eyeHeight: 1.6, kickPitch: 0, kickYaw: 0, leanSide: 0, leanUp: 0 },
    systems: { weapon: null, enemies: null, objectives: null, audio: null, hud: null, effects: null, tasks: null, player: null },
  } as unknown as GameContext;
}

describe.skipIf(!haveLevel)("level-1 security cameras", () => {
  let level: IgiLevel;
  let world: BuiltWorld;
  let data: DamageModelData;
  const cameras = () => level.tasks.map((t, node) => ({ t, node })).filter(({ t }) => t.type === "SCamera");
  const lensOf = (node: number) => level.instances.findIndex((i) => i.part === "scameraLens" && i.taskIndex === node);
  const holderOf = (node: number) => level.instances.findIndex((i) => i.part === undefined && i.taskIndex === node);

  beforeAll(async () => {
    const raw = createFsAssetSource(RAW_ROOT);
    level = await loadIgiLevel(raw);
    world = buildWorld(
      level,
      (b) => b.addIndexed(level.terrain.detail.positions, level.terrain.detail.indices, TRI_SOLID | TRI_BULLET | TRI_SIGHT | TRI_TERRAIN, TERRAIN_HIT_MATERIAL),
      { dynamicTasks: dynamicTaskKeys(level) },
    );
    const names = damageModelNames(level);
    data = await loadDamageModelData(raw, names.bounds, names.build, (key) => level.textures.has(key));
  }, 240_000);

  it("places five holders and five lenses (Camera Model at the holder's magic vertex 0, compile pose)", () => {
    expect(cameras()).toHaveLength(5);
    for (const { t, node } of cameras()) {
      const h = holderOf(node);
      const l = lensOf(node);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(l).toBe(h + 1); // created right after its holder (FUN_004415b0 -> FUN_004012e0)
      expect(level.instances[h].model).toBe(t.params["Holder Model"]);
      expect(level.instances[l].model).toBe(t.params["Camera Model"]);
      expect(level.instances[l].lightmap).toBeNull();
      // pivot = holder matrix x magic vertex 0 of 313_01_1 (2.3, 959.8, 338.1) [observed]
      const pivot = modelPoint(level.instances[h].matrix, data.bounds.get("313_01_1")!.magic[0]);
      const m = level.instances[l].matrix;
      expect(pivot.distanceTo(new THREE.Vector3(m[12], m[13], m[14]))).toBeLessThan(1e-6);
      const pos = t.params["Holder Position"] as number[];
      const ref = securityCameraLensPivot(pos as Vec3, t.params["Holder Gamma"] as number, data.bounds.get("313_01_1")!.magic[0]);
      const e = igiPointToEngine(ref, level.originIgi);
      expect(pivot.distanceTo(new THREE.Vector3(...e))).toBeLessThan(1e-6);
      // rotation = Rz(HG + CG) Rx(Camera Alpha)
      const r = igiRotationToEngine(securityCameraLensMatrix(t.params["Holder Gamma"] as number, t.params["Camera Gamma"] as number, 0, t.params["Camera Alpha"] as number));
      const expected = engineMatrix4(r, e);
      for (let k = 0; k < 16; k++) expect(m[k]).toBeCloseTo(expected[k], 9);
    }
    // 3.5 - 5.5 m above the base ground, inside the base [observed]
    for (const { node } of cameras()) {
      const y = level.instances[lensOf(node)].matrix[13];
      expect(y).toBeGreaterThan(3.5);
      expect(y).toBeLessThan(6.5);
    }
    // the 313_02_1 view-cone helper 313_04_1 is not built (no FUN_004bab70)
    expect(level.instances.some((i) => i.model === "313_04_1")).toBe(false);
  });

  it("builds each lens as its own dynamic, destructible body (the holder stays static)", () => {
    for (const { node } of cameras()) {
      const key = scameraLensKey(node);
      expect(world.dynamicTasks.has(key)).toBe(true);
      expect(world.dynamicTasks.has(node)).toBe(false);
      expect(world.destructibleInstances.has(lensOf(node))).toBe(true);
      expect(world.destructibleInstances.has(holderOf(node))).toBe(false);
      expect(world.collision.bodyIds).toContain(key);
    }
  });

  it("bullets hit the lens where it is drawn: its body turns with it", () => {
    const { node } = cameras()[0];
    const lens = lensOf(node);
    const key = scameraLensKey(node);
    const before = rayAtFarFace(level, world, lens);
    const hit = world.collision.raycast(...before.from, ...before.dir, 1, TRI_BULLET);
    expect(hit?.owner).toBe(lens);
    expect(hit && -1 - hit.triangle).toBe(key);
    // turn 90 deg about the pivot (engine y axis)
    const m = level.instances[lens].matrix;
    const pivot = new THREE.Vector3(m[12], m[13], m[14]);
    const delta = new THREE.Matrix4()
      .makeTranslation(pivot.x, pivot.y, pivot.z)
      .multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2))
      .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
    // vertex light snapshot of every vertex-lit batch (the lens is relit as it turns)
    const lit = () => {
      const out: number[][] = [];
      world.group.traverse((o) => {
        const a = (o as THREE.Mesh).geometry?.getAttribute?.("objLight") as THREE.BufferAttribute | undefined;
        if ((o as THREE.BatchedMesh).isBatchedMesh && a) out.push(Array.from(a.array as Float32Array));
      });
      return out;
    };
    const lit0 = lit();
    world.setTaskTransform(key, delta.elements);
    const lit1 = lit();
    let changed = 0;
    lit0.forEach((arr, b) => arr.forEach((x, k) => (changed += Math.abs(x - lit1[b][k]) > 1e-4 ? 1 : 0)));
    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThan(3 * 2000); // only the lens's own vertices (all LOD variants)
    expect(world.collision.raycast(...before.from, ...before.dir, 1, TRI_BULLET)?.owner ?? -1).not.toBe(lens);
    const after = rayAtFarFace(level, world, lens);
    expect(after.target.distanceTo(before.target)).toBeGreaterThan(0.3);
    expect(world.collision.raycast(...after.from, ...after.dir, 1, TRI_BULLET)?.owner).toBe(lens);
    world.setTaskTransform(key, new THREE.Matrix4().elements);
    expect(world.collision.raycast(...before.from, ...before.dir, 1, TRI_BULLET)?.owner).toBe(lens);
  });

  it("three MP5SD rounds destroy the placed lens; the destroyed model turns with the head", () => {
    const ctx = fakeContext(level);
    const sys = createDamageSystem(ctx);
    sys.attach(level, world, data);
    const { node } = cameras()[1];
    const lensInstance = lensOf(node);
    const key = scameraLensKey(node);
    const lens = sys.objects.find((o) => o.kind === "scameraLens" && o.node === node)!;
    expect(lens.instance).toBe(lensInstance); // registered from the loader's placement
    expect(sys.objectAt(lensInstance)?.kind).toBe("scameraLens");
    expect(sys.objectAt(holderOf(node))).toBeNull(); // the holder has no damage handlers
    const states = new Map<number, Record<string, number>>([[node, { isExploded: 0 }]]);
    sys.setMissionBridge(missionRuntimeBridge({ nodeState: (i) => states.get(i) ?? { isExploded: 0 } }, () => true));
    const destroyed: unknown[] = [];
    const booms: Array<{ sound: string; position: number[] }> = [];
    ctx.events.on(DAMAGE_EVENTS.ObjectDestroyed, (p) => destroyed.push(p));
    ctx.events.on(DAMAGE_EVENTS.Explosion, (p) => booms.push(p as { sound: string; position: number[] }));
    const { from, dir } = rayAtFarFace(level, world, lensInstance);
    const hit = world.collision.raycast(...from, ...dir, 1, TRI_BULLET)!;
    expect(hit.owner).toBe(lensInstance);
    for (let k = 0; k < 3; k++) expect(sys.bulletHit({ owner: hit.owner, point: hit.point, dir, remaining: 10 }, Math.fround(0.2))).toBe(true);
    expect(lens.flag).toBe(true);
    sys.beginTick(); // lens update 0x440b9d
    expect(states.get(node)!.isExploded).toBe(1);
    expect(destroyed).toMatchObject([{ type: "SCamera", instance: lensInstance, destroyedModel: "313_03_1" }]);
    sys.endTick();
    expect(booms.map((b) => b.sound)).toEqual(["explo_camera"]);
    // explosion at the lens origin (+0x20) = the pivot
    const m = level.instances[lensInstance].matrix;
    expect(new THREE.Vector3(...booms[0].position).distanceTo(new THREE.Vector3(m[12], m[13], m[14]))).toBeLessThan(1e-6);
    // the swapped model follows the lens transform (render and collision)
    const swap = world.group.getObjectByName("destroyed-models")!.children.filter((c) => c.name === `313_03_1@${lensInstance}`) as THREE.Mesh[];
    expect(swap.length).toBeGreaterThan(0);
    const light0 = Array.from((swap[0].geometry.getAttribute("objLight") as THREE.BufferAttribute).array);
    const pivot = new THREE.Vector3(m[12], m[13], m[14]);
    const delta = new THREE.Matrix4()
      .makeTranslation(pivot.x, pivot.y, pivot.z)
      .multiply(new THREE.Matrix4().makeRotationX(-1.2))
      .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
    world.setTaskTransform(key, delta.elements);
    for (let k = 0; k < 16; k++) expect(swap[0].matrix.elements[k]).toBeCloseTo(delta.elements[k], 9);
    // relit with its new pose (D3D lights with the current world matrix)
    const light1 = Array.from((swap[0].geometry.getAttribute("objLight") as THREE.BufferAttribute).array);
    expect(light1.some((x, i) => Math.abs(x - light0[i]) > 1e-3)).toBe(true);
    expect(sys.bulletHit({ owner: lensInstance, point: [0, 0, 0], dir: [1, 0, 0], remaining: 1 }, 0.2)).toBe(false); // done
    world.setTaskTransform(key, new THREE.Matrix4().elements);
    sys.reset();
    expect(world.group.getObjectByName("destroyed-models")!.children.filter((c) => c.name === `313_03_1@${lensInstance}`)).toHaveLength(0);
  });

  describe("mission system", () => {
    let mission: MissionSystem;
    beforeAll(() => {
      const ctx = {
        world: world.collision,
        level,
        events: { emit() {} },
        input: { isDown: () => false },
        player: { position: [0, 0, 0], crouching: false, eyeHeight: 1.7, alive: true },
        enemies: [],
        systems: { enemies: null },
      };
      mission = createMissionSystem(ctx as unknown as GameContext);
      mission.start(level);
      mission.attachWorld(world);
    });

    const expectedMatrix = (node: number) => {
      const t = level.tasks[node];
      const s = mission.runtime!.nodeState(node);
      const m = level.instances[lensOf(node)].matrix;
      const r = igiRotationToEngine(securityCameraLensMatrix(t.params["Holder Gamma"] as number, t.params["Camera Gamma"] as number, s.yaw, s.pitch));
      return engineMatrix4(r, [m[12], m[13], m[14]]);
    };

    it("starts at the compile pose (pitch = Camera Alpha) and follows the runtime's sweep", () => {
      for (const { t, node } of cameras()) {
        expect(mission.runtime!.nodeState(node).pitch).toBe(Math.fround(t.params["Camera Alpha"] as number));
        const now = world.instanceWorldMatrix(lensOf(node))!;
        const placed = level.instances[lensOf(node)].matrix;
        for (let k = 0; k < 16; k++) expect(now[k]).toBeCloseTo(placed[k], 9);
      }
      for (let k = 0; k < 120; k++) mission.tick();
      // cameras 1301, 1303, 1305 sweep (Rotate Gamma Left/Right non-zero), 1302 / 1304 stand still
      const swept = cameras().filter(({ node }) => mission.runtime!.nodeState(node).yaw !== 0).map(({ t }) => t.id);
      expect(swept).toEqual([1301, 1303, 1305]);
      for (const { node } of cameras()) {
        const now = world.instanceWorldMatrix(lensOf(node))!;
        const want = expectedMatrix(node);
        for (let k = 0; k < 16; k++) expect(now[k]).toBeCloseTo(want[k], 6);
      }
    });

    it("droops to -75 deg once the camera is destroyed (isOn = 0), turning its body", () => {
      const { node } = cameras()[3];
      mission.runtime!.nodeState(node); // exists
      (mission.runtime!.nodeState(node) as Record<string, number>).isExploded = 1;
      for (let k = 0; k < 40; k++) mission.tick();
      expect(mission.runtime!.nodeState(node).pitch).toBe(SCAMERA_OFF_PITCH);
      const now = world.instanceWorldMatrix(lensOf(node))!;
      const want = expectedMatrix(node);
      for (let k = 0; k < 16; k++) expect(now[k]).toBeCloseTo(want[k], 6);
      // the view axis (model +y -> engine -z column) points 75 deg down
      const forward = new THREE.Vector3(-now[8], -now[9], -now[10]).normalize();
      expect(Math.asin(forward.y) * 180 / Math.PI).toBeCloseTo(-75, 3);
      // the collision body carries the same transform (placed pose -> current pose)
      const body = world.collision.bodyMatrix(scameraLensKey(node))!;
      const delta = new THREE.Matrix4().fromArray(now).multiply(new THREE.Matrix4().fromArray(level.instances[lensOf(node)].matrix).invert());
      for (let k = 0; k < 16; k++) expect(body[k]).toBeCloseTo(delta.elements[k], 9);
    });
  });
});
