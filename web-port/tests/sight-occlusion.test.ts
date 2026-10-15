/**
 * Humans on sight rays, perception phases and the application tick
 * (docs/ai.md 2.2, docs/mission.md "SCamera vision"):
 *   - FUN_00487f40's ray (filter 0x53f120) meets every human but the looker and
 *     the target (filter 0x441c30): FUN_0045e490 = HSEM sphere around the pelvis
 *     (FUN_0045e210), then the posed set-0 faces (FUN_004cef60); dead bodies
 *     too; the combat node ray (FUN_00489b00, filter 0x537430) ignores humans.
 *   - Soldiers take their phase from the shared counter (perceptionPhases) and
 *     do the slot bookkeeping on phase ticks only (FUN_00487b70).
 *   - The phase test reads the application tick, which runs on while the
 *     in-game menu pauses the game.
 * Real-data checks are skipped when the staged original files are absent.
 */
import { existsSync } from "node:fs";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { LEVEL1_PATHS, loadIgiLevel, poseSkeleton, readAnimations, sampleClip, type IgiLevel } from "../src/loaders";
import { igiPointToEngine } from "../src/loaders/coords";
import { buildMissionTasks, perceptionPhases, apply3, securityCameraLensMatrix, type Vec3 } from "../src/loaders/mission";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { loadDamageModelData, type DamageModelData } from "../src/loaders/damage-data";
import { BodyCollision, segmentNearSphere } from "../src/engine/combat/body-collision";
import { LevelRng } from "../src/engine/ai/rng";
import { PLAYER_KEY } from "../src/engine/ai/types";
import type { Enemy, GameContext } from "../src/engine/context";
import { EventBus } from "../src/engine/events";
import { attachDamageSystem, createDamageSystem, damageModelNames } from "../src/engine/combat/object-damage";
import { createEnemyManager, type EnemyManager } from "../src/engine/combat/enemy";
import { createPlayerController } from "../src/engine/player/player";
import { buildWorld, type BuiltWorld } from "../src/engine/world/world-builder";
import { TERRAIN_HIT_MATERIAL, TRI_BULLET, TRI_SIGHT, TRI_SOLID, TRI_TERRAIN } from "../src/engine/world/collision";
import { dynamicTaskKeys } from "../src/engine/level";
import { createMissionSystem, type MissionSystem } from "../src/engine/mission/mission-system";
import { HAVE_LEVEL, createHarness } from "./ai-engine-harness";
import { RAW_ROOT } from "./helpers";

const UNITS = 4096;

describe("the human sight sphere (FUN_0045e210)", () => {
  it("counts a segment only when its line passes within r and its box meets the cube +-r", () => {
    const r = 1;
    expect(segmentNearSphere(-5, 0, 0, 5, 0, 0, r)).toBe(true); // through the centre
    expect(segmentNearSphere(-5, 0.99, 0, 5, 0.99, 0, r)).toBe(true);
    expect(segmentNearSphere(-5, 1.01, 0, 5, 1.01, 0, r)).toBe(false); // the line passes outside
    expect(segmentNearSphere(-5, 0.8, 0.8, 5, 0.8, 0.8, r)).toBe(false); // 1.13 from the centre
    // the line passes through the centre but the segment stops short of the cube
    expect(segmentNearSphere(-5, 0, 0, -1.01, 0, 0, r)).toBe(false);
    expect(segmentNearSphere(-5, 0, 0, -0.99, 0, 0, r)).toBe(true);
    // a segment ending inside the sphere
    expect(segmentNearSphere(0.2, 0.1, 0, 3, 3, 3, r)).toBe(true);
    // the box test is per axis: corner of the cube, outside the sphere, line far away
    expect(segmentNearSphere(0.95, 0.95, -5, 0.95, 0.95, 5, r)).toBe(false);
  });
});

const haveLevel = HAVE_LEVEL && existsSync(`${RAW_ROOT}/${LEVEL1_PATHS.objects}`);

describe.skipIf(!haveLevel)("human sight geometry (bone model set 0, posed)", () => {
  let level: IgiLevel;
  beforeAll(async () => {
    level = await loadIgiLevel(createFsAssetSource(RAW_ROOT));
  }, 120_000);

  /** 003_01_1 standing at the origin (feet), yaw 0. */
  function standing(): { body: BodyCollision; rootZ: number } {
    const body = BodyCollision.fromModel(level.boneModels.get("003_01_1")!.buffer)!;
    const anim = readAnimations(level.animations.get(1)!);
    const s = sampleClip(anim.clips.get(2)!, 0); // the soldiers' stand clip
    body.pose(poseSkeleton(anim.skeleton, s.rotations, [0, 0, 0, 1]), s.translation[2]);
    return { body, rootZ: s.translation[2] };
  }

  it("radius = HSEM +120 of the Model (003_01_1: 3778.28 units); a ray through the chest crosses faces, one beside the body none", () => {
    const { body } = standing();
    expect(body.sphereRadius * UNITS).toBeCloseTo(3778.275, 2);
    const chest = body.sightHits(0, 1.25, -5, 0, 1.25, 5);
    expect(chest.length).toBeGreaterThanOrEqual(2); // in and out
    expect(chest.some((h) => h.front)).toBe(true);
    expect(chest.every((h) => [8, 9, 6, 12].includes(h.material))).toBe(true); // Flesh / BloodyFlesh / metals: see-through 0
    expect(body.sightHits(1.2, 1.25, -5, 1.2, 1.25, 5)).toEqual([]);
  });

  it("faces outside the sphere do not stop the ray: a ray at sole height crosses the shoes but misses the sphere", () => {
    const { body, rootZ } = standing();
    // Sweep a horizontal ray across the feet at heights below the sphere's bottom (pelvis - r).
    const bottom = rootZ / UNITS - body.sphereRadius;
    expect(bottom).toBeGreaterThan(0);
    let found = false;
    for (let h = 0.002; h < bottom && !found; h += 0.002) {
      for (let x = -0.3; x <= 0.3 && !found; x += 0.02) {
        const crossed = body.raycastAll(x, h, -3, 0, 0, 1, 6);
        if (crossed.length > 0) {
          found = true;
          expect(body.sightHits(x, h, -3, x, h, 3)).toEqual([]);
        }
      }
    }
    expect(found).toBe(true);
  });
});

describe.skipIf(!HAVE_LEVEL)("soldier perception schedule (FUN_00487b70, harness)", () => {
  it("slot bookkeeping waits for the phase tick: a teammate's body is tracked on the observer's next phase tick only", async () => {
    // 2007 / 2008: phases 0 / 1 (harness order); the player far away.
    const h = await createHarness({ only: [2007, 2008] });
    const [a, b] = [2007, 2008].map((id) => h.byTask.get(id)!);
    for (let i = 0; i < 6; i++) h.step();
    expect(a.ai.slots.has(b.ai.key)).toBe(false); // alive teammate: not tracked
    b.alive = false;
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const tick = h.world.appTick;
      h.step();
      if (a.ai.slots.has(b.ai.key) && seen.length === 0) seen.push(tick);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0] & 3).toBe(a.ai.phase);
  });

  it("the phase test reads the application tick: after a 3-tick pause the runs follow appTick, not the level tick", async () => {
    const h = await createHarness({ onlyAi: [3099] });
    const s = h.byAi.get(3099)!;
    const yaw = s.motor.yaw;
    h.player.feet = [s.feet[0] - Math.sin(yaw) * 10 * UNITS, s.feet[1] + Math.cos(yaw) * 10 * UNITS, s.feet[2]];
    const runs: Array<{ tick: number; app: number }> = [];
    h.ray = () => {
      runs.push({ tick: h.world.tick, app: h.world.appTick });
      return false; // in the cone, never seen
    };
    for (let i = 0; i < 8; i++) h.step();
    // The in-game menu: the Game task is not updated, the application tick runs on (0x4023ce).
    h.world.appTick += 3;
    runs.length = 0;
    for (let i = 0; i < 40; i++) h.step();
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) {
      expect(r.app & 3).toBe(s.ai.phase);
      expect(r.app - r.tick).toBe(3);
    }
    expect(runs.some((r) => (r.tick & 3) !== s.ai.phase)).toBe(true);
  });

  it("perception rays carry {self, target}; the combat node ray carries none (humans skipped by 0x4fa7f0)", async () => {
    const h = await createHarness({ onlyAi: [3099] });
    const s = h.byAi.get(3099)!;
    const yaw = s.motor.yaw;
    h.player.feet = [s.feet[0] - Math.sin(yaw) * 10 * UNITS, s.feet[1] + Math.cos(yaw) * 10 * UNITS, s.feet[2]];
    const skips: unknown[] = [];
    h.world.hooks.lineOfSight = (_a, _b, skip) => {
      skips.push(skip);
      return true;
    };
    for (let i = 0; i < 12; i++) h.step();
    expect(skips.length).toBeGreaterThan(0);
    expect(skips[0]).toEqual({ self: s.ai.key, target: PLAYER_KEY });
  });
});

describe.skipIf(!haveLevel)("level 1: humans on sight rays, perception phases, application tick", () => {
  let level: IgiLevel;
  let world: BuiltWorld;
  let data: DamageModelData;
  const raw = createFsAssetSource(RAW_ROOT);

  beforeAll(async () => {
    level = await loadIgiLevel(raw);
    world = buildWorld(
      level,
      (b) => b.addIndexed(level.terrain.detail.positions, level.terrain.detail.indices, TRI_SOLID | TRI_BULLET | TRI_SIGHT | TRI_TERRAIN, TERRAIN_HIT_MATERIAL),
      { dynamicTasks: dynamicTaskKeys(level) },
    );
    const names = damageModelNames(level);
    data = await loadDamageModelData(raw, names.bounds, names.build, (key) => level.textures.has(key));
  }, 240_000);

  interface Rig {
    ctx: GameContext;
    mission: MissionSystem;
    enemies: EnemyManager;
    step(): void;
  }

  /** The game's systems headless, ticked as game.ts does (node ticks), intro broken by Esc. */
  async function setup(): Promise<Rig> {
    const ctx = {
      world: world.collision, level, tick: 0, appTick: 0, events: new EventBus(), rng: new LevelRng(), scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 2000),
      input: { isDown: () => false },
      player: {
        position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0, grounded: true, crouching: false, running: false, health: 3, maxHealth: 3,
        alive: true, walking: false, eyeHeight: 1.64, kickPitch: 0, kickYaw: 0, leanSide: 0, leanUp: 0,
      },
      enemies: [] as Enemy[], playArea: null, weapon: null, objectives: [], messages: [],
      systems: { weapon: null, enemies: null, objectives: null, audio: null, hud: null, effects: null, tasks: null, player: null },
    } as unknown as GameContext;
    const damage = createDamageSystem(ctx, { fx: false });
    damage.attach(level, world, data);
    attachDamageSystem(ctx, damage);
    ctx.systems.player = createPlayerController(ctx, { interactions: { source: raw as never } });
    const enemies = createEnemyManager(ctx, { source: raw });
    ctx.systems.enemies = enemies;
    const mission = createMissionSystem(ctx);
    ctx.systems.tasks = mission;
    ctx.systems.player.reset();
    enemies.reset();
    mission.start(level);
    mission.attachWorld(world);
    for (let i = 0; i < 400 && !enemies.stats.aiLoaded; i++) await new Promise((r) => setTimeout(r, 25));
    expect(enemies.stats.aiLoaded).toBe(true);
    const step = (breakIntro = false) => {
      if (breakIntro) mission.requestBreak();
      damage.beginTick();
      enemies.beginNodeTick(1 / 30);
      let walked = false;
      mission.setNodeTick((type, id) => {
        walked = true;
        if (type === "HumanSoldier" || type === "HumanAI") enemies.tickNode(id, type);
      });
      mission.tick();
      mission.setNodeTick(null);
      enemies.endNodeTick(!walked);
      damage.endTick();
      ctx.tick++;
      ctx.appTick = (ctx.appTick ?? 0) + 1;
    };
    for (let i = 0; i < 4000 && (i < 2 || !(mission.playerInWorld && !mission.cutscene)); i++) step(true);
    expect(mission.playerInWorld).toBe(true);
    return { ctx, mission, enemies, step: () => step() };
  }

  const node = (id: number) => level.tasks.findIndex((t) => t.type === "SCamera" && t.id === id);
  const toIgi = (p: readonly number[]): Vec3 => [level.originIgi[0] + p[0] * UNITS, level.originIgi[1] - p[2] * UNITS, level.originIgi[2] + p[1] * UNITS];
  const ground = (x: number, z: number): number => world.collision.raycast(x, 40, z, 0, -1, 0, 80, TRI_SOLID)?.point[1] ?? 0;

  /** Engine point `metres` in front of a camera (horizontal view direction), on the ground. */
  function inFront(mission: MissionSystem, id: number, metres: number): Vec3 {
    const t = level.tasks[node(id)];
    const s = mission.runtime!.nodeState(node(id));
    const r = securityCameraLensMatrix(t.params["Holder Gamma"] as number, t.params["Camera Gamma"] as number, s.yaw, s.pitch);
    const lens = level.instances.find((i) => i.part === "scameraLens" && i.taskIndex === node(id))!;
    const f = new THREE.Vector3(r[1], 0, -r[4]).normalize();
    const p = new THREE.Vector3(lens.matrix[12], 0, lens.matrix[14]).addScaledVector(f, metres);
    return [p.x, ground(p.x, p.z), p.z];
  }

  /** The lens eye (engine) as the vision uses it. */
  function eyeOf(mission: MissionSystem, id: number): Vec3 {
    const t = level.tasks[node(id)];
    const s = mission.runtime!.nodeState(node(id));
    const r = securityCameraLensMatrix(t.params["Holder Gamma"] as number, t.params["Camera Gamma"] as number, s.rotYaw, s.rotPitch);
    const lens = level.instances.find((i) => i.part === "scameraLens" && i.taskIndex === node(id))!;
    const pivot = toIgi([lens.matrix[12], lens.matrix[13], lens.matrix[14]]);
    const e = apply3(r, data.bounds.get("313_02_1")!.magic[1] as Vec3);
    return igiPointToEngine([pivot[0] + e[0], pivot[1] + e[1], pivot[2] + e[2]], level.originIgi);
  }

  /** Team-1 soldiers in the world (alive, present). */
  const inWorldSoldiers = (rig: Rig): Enemy[] => rig.enemies.visibleSoldiers().filter((v) => v.team === 1).map((v) => v.enemy);

  /** Put soldier `e` at `feet` (engine) with its AI frozen (it stands in its idle clip), posed by one tick. */
  function standAt(rig: Rig, e: Enemy, feet: Vec3): void {
    const ai = rig.enemies.aiOf(e)!;
    (ai as unknown as { active: boolean }).active = false;
    e.position = [feet[0], feet[1], feet[2]];
  }

  it("each soldier's phase is its HumanAI's place in the load's counter (cameras, vehicles, HumanAIs), continued by a restart", async () => {
    const rig = await setup();
    const tasks = buildMissionTasks(level.taskRoots);
    const { phases, next } = perceptionPhases(tasks, 0);
    const nodeOfAi = new Map(tasks.nodes.filter((n) => n.type === "HumanAI").map((n) => [n.id, n.index]));
    const got = rig.ctx.enemies.map((e) => {
      const ai = rig.enemies.aiOf(e)!;
      return [ai.spec.aiTaskId, ai.phase];
    });
    expect(got.length).toBe(29);
    for (const [id, phase] of got) expect(phase).toBe(phases.get(nodeOfAi.get(id as number)!));
    // HumanAI_1506 3, HumanAI_2022 1 (docs/mission.md "SCamera vision")
    expect(got.find(([id]) => id === 1506)![1]).toBe(3);
    expect(got.find(([id]) => id === 2022)![1]).toBe(1);
    // Restart: the process-wide counter continues (game.ts resetMission: enemies.reset() before mission.start()).
    rig.enemies.reset();
    rig.mission.start(level);
    rig.step();
    const again = perceptionPhases(tasks, next).phases;
    for (const e of rig.ctx.enemies) {
      const ai = rig.enemies.aiOf(e);
      if (ai) expect(ai.phase).toBe(again.get(nodeOfAi.get(ai.spec.aiTaskId!)!));
    }
  }, 120_000);

  it("a soldier's sight ray is stopped by another soldier between it and the player, not by the looker or the target", async () => {
    const rig = await setup();
    const [A, B] = inWorldSoldiers(rig).slice(0, 2);
    // Open ground 30 m from the player's spawn: A, then B 5 m on, the player 5 m further.
    const p0 = rig.ctx.player.position;
    const at = (dx: number): Vec3 => [p0[0] + dx, ground(p0[0] + dx, p0[2] + 30), p0[2] + 30];
    standAt(rig, A, at(-10));
    standAt(rig, B, at(-5));
    rig.ctx.player.position = at(0);
    // Crouched: the target point (origin + 0.35 m) is 1.0 m up, so the ray crosses B at chest height.
    rig.ctx.player.crouching = true;
    rig.ctx.player.eyeHeight = 1.0;
    rig.step();
    const ai = rig.enemies.aiOf(A)!;
    ai.refreshFrame();
    const target = ai.targetPoint(ai.world.humans.get(PLAYER_KEY)!);
    const hooks = ai.world.hooks;
    expect(hooks.lineOfSight(ai.eye.position, target)).toBe(true); // the world alone: clear (and the combat node ray)
    expect(hooks.lineOfSight(ai.eye.position, target, { self: A.id, target: PLAYER_KEY })).toBe(false); // B in the way
    // B as the target: the ray to B's own point skips B (and A, whose head holds the eye).
    expect(hooks.lineOfSight(ai.eye.position, ai.targetPoint(ai.world.humans.get(B.id)!), { self: A.id, target: B.id })).toBe(true);
    // B steps aside 3 m: clear again (the ray starts in A's head and ends in the player's: both skipped)
    standAt(rig, B, [B.position[0], B.position[1], B.position[2] + 3]);
    rig.step();
    ai.refreshFrame();
    expect(hooks.lineOfSight(ai.eye.position, ai.targetPoint(ai.world.humans.get(PLAYER_KEY)!), { self: A.id, target: PLAYER_KEY })).toBe(true);
  }, 120_000);

  it("a dead body stays on sight rays: rays along the ground through it are stopped unless it is the target", async () => {
    const rig = await setup();
    const B = inWorldSoldiers(rig)[0];
    const p0 = rig.ctx.player.position;
    const spot: Vec3 = [p0[0] - 5, ground(p0[0] - 5, p0[2] + 30), p0[2] + 30];
    standAt(rig, B, spot);
    rig.step();
    rig.enemies.damage(B, 1000, [spot[0] + 5, spot[1] + 1.5, spot[2]]);
    for (let i = 0; i < 120; i++) rig.step();
    expect(B.alive).toBe(false);
    // Low rays (0.15 m up) across the body's position from four sides.
    const f = B.position;
    let stopped = 0;
    for (const [dx, dz] of [[1, 0], [0, 1], [0.7, 0.7], [0.7, -0.7]]) {
      const a: Vec3 = [f[0] - dx * 3, f[1] + 0.15, f[2] - dz * 3];
      const b: Vec3 = [f[0] + dx * 3, f[1] + 0.15, f[2] + dz * 3];
      if (rig.enemies.sightHits(a, b, []).length > 0) stopped++;
      expect(rig.enemies.sightHits(a, b, [B.id])).toEqual([]);
    }
    expect(stopped).toBeGreaterThan(0);
  }, 120_000);

  it("the player's posed body is on the rays too (e.g. between a soldier and a body it looks at), unless it is the target", async () => {
    const rig = await setup();
    const p = rig.ctx.player.position;
    rig.step();
    const a: Vec3 = [p[0] - 4, p[1] + 1.3, p[2] + 0.05];
    const b: Vec3 = [p[0] + 4, p[1] + 1.3, p[2] + 0.05];
    expect(rig.enemies.sightHits(a, b, []).length).toBeGreaterThan(0);
    expect(rig.enemies.sightHits(a, b, [PLAYER_KEY])).toEqual([]);
    // 2 m above the head: outside its HSEM sphere
    expect(rig.enemies.sightHits([a[0], a[1] + 2, a[2]], [b[0], b[1] + 2, b[2]], [])).toEqual([]);
  }, 120_000);

  it("SCamera 1304: a soldier in front of the (crouched) player blocks the lens ray; once it steps aside the camera detects", async () => {
    const rig = await setup();
    const { ctx, mission } = rig;
    const rt = mission.runtime!;
    const n1304 = node(1304);
    const feet = inFront(mission, 1304, 8);
    ctx.player.position = feet;
    ctx.player.crouching = true;
    ctx.player.eyeHeight = 1.0;
    // The blocker on the ray from the player's point to the lens eye where it is 1.2 m above the ground.
    const P = new THREE.Vector3(feet[0], feet[1] + 1.0, feet[2]);
    const C = new THREE.Vector3(...eyeOf(mission, 1304));
    let spot: Vec3 | null = null;
    for (let s = 0.02; s < 0.5; s += 0.005) {
      const X = P.clone().lerp(C, s);
      const g = ground(X.x, X.z);
      if (X.y - g >= 1.2 && X.distanceTo(P) > 0.5) {
        spot = [X.x, g, X.z];
        break;
      }
    }
    expect(spot).not.toBeNull();
    const B = inWorldSoldiers(rig)[0];
    standAt(rig, B, spot!);
    for (let k = 0; k < 120; k++) rig.step();
    const slot = mission.cameraDetector(n1304)!.slots.get("player")!;
    expect(slot.inCone).toBe(true);
    expect(slot.visible).toBe(false);
    expect(rt.nodeState(n1304).nDetectionTime).toBe(0);
    // Aside (4 m across the ray): the ray is clear, the 90-tick count starts on the lens's phase ticks.
    const across = new THREE.Vector3(C.x - P.x, 0, C.z - P.z).normalize();
    const aside: Vec3 = [spot![0] - across.z * 4, 0, spot![2] + across.x * 4];
    aside[1] = ground(aside[0], aside[2]);
    standAt(rig, B, aside);
    let first = -1;
    for (let k = 0; k < 40 && first < 0; k++) {
      const app = ctx.appTick!;
      rig.step();
      if (rt.nodeState(n1304).nDetectionTime > 0) first = app;
    }
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first & 3).toBe(mission.cameraDetector(n1304)!.phase);
  }, 120_000);

  it("SCamera phase ticks follow the application tick after a pause (ctx.appTick ahead of ctx.tick)", async () => {
    const rig = await setup();
    const { ctx, mission } = rig;
    const rt = mission.runtime!;
    const n1304 = node(1304);
    ctx.player.position = inFront(mission, 1304, 8);
    // Two ticks of in-game menu: the Game task stood still, the application tick ran on.
    ctx.appTick = (ctx.appTick ?? 0) + 2;
    let first = -1;
    let firstLevel = -1;
    for (let k = 0; k < 40 && first < 0; k++) {
      const app = ctx.appTick!;
      const lvl = ctx.tick;
      rig.step();
      if (rt.nodeState(n1304).nDetectionTime > 0) {
        first = app;
        firstLevel = lvl;
      }
    }
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first & 3).toBe(mission.cameraDetector(n1304)!.phase);
    expect((firstLevel & 3) === mission.cameraDetector(n1304)!.phase).toBe(false);
  }, 120_000);
});
