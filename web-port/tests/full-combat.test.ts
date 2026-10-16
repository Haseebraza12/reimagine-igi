/**
 * The combat task types and weapons on the full game's missions (game-data):
 * StationaryGun, AIStationaryGun(Holder), MineField, GuardGenerator, the
 * soldier subclasses HumanSoldierRPG / HumanSoldierFemale, M203 and SPAS12.
 * Skipped when the full game is not staged.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { createFsAssetSource } from "../src/loaders/fs-source";
import {
  MissionRuntime,
  buildMissionTasks,
  levelPathsFor,
  loadIgiLevel,
  perceptionPhases,
  readAnimations,
  readQvmCallTree,
  type IgiLevel,
  type MissionHost,
} from "../src/loaders";
import { flattenTasks, readTaskTree } from "../src/loaders/tasks";
import { loadDamageModelData } from "../src/loaders/damage-data";
import { MINEFIELD_EVENTS, type MineFieldExplosion } from "../src/loaders/objects/mine-field";
import { stationaryGunDef } from "../src/loaders/objects/stationary-gun";
import { aiTurretDef } from "../src/loaders/objects/ai-stationary-gun";
import { readMissionDefinition } from "../src/engine/ui/assets";
import { readWeaponExtras } from "../src/engine/combat/weapon-tags";
import { LevelRng } from "../src/engine/ai/rng";
import { ClipPlayer } from "../src/engine/ai/clip-player";
import { CH, SoldierMotor } from "../src/engine/ai/motor";
import { FEMALE_STATE } from "../src/engine/ai/soldier-variants";
import type { Enemy, GameContext } from "../src/engine/context";
import { EventBus } from "../src/engine/events";
import { attachDamageSystem, createDamageSystem, damageModelNames, type DamageSystem } from "../src/engine/combat/object-damage";
import { createEnemyManager, type EnemyManager } from "../src/engine/combat/enemy";
import { createWeaponSystem, WEAPON_STATE, type WeaponSystem } from "../src/engine/combat/weapon";
import { createPlayerController, type PlayerController } from "../src/engine/player/player";
import { buildWorld } from "../src/engine/world/world-builder";
import { TERRAIN_HIT_MATERIAL, TRI_BULLET, TRI_SIGHT, TRI_SOLID, TRI_TERRAIN } from "../src/engine/world/collision";
import { dynamicTaskKeys } from "../src/engine/level";
import { createMissionSystem, type MissionSystem } from "../src/engine/mission/mission-system";
import { createCombatObjects, type CombatObjects } from "../src/engine/combat/combat-objects";
import { projectileSystemOf } from "../src/engine/combat/projectiles";
import { playerViewMode } from "../src/engine/player/camera";
import { isSoldierTaskType } from "../src/loaders/soldier-types";

const FULL = fileURLToPath(new URL("../game-data", import.meta.url));
const haveFull = existsSync(`${FULL}/missions/location0/level14/objects.qvm`);
const bytes = (path: string): ArrayBuffer => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const raw = createFsAssetSource(FULL);
const tasksOf = (l: number) => flattenTasks(readTaskTree(readQvmCallTree(bytes(`${FULL}/missions/location0/level${l}/objects.qvm`))));

async function loadMission(id: number): Promise<IgiLevel> {
  const [def] = readMissionDefinition(bytes(`${FULL}/missions/location0/level${id}/mission.qvm`), new Map());
  return loadIgiLevel(raw, levelPathsFor(def.location));
}

describe.skipIf(!haveFull)("combat task types in the 14 missions (objects.qvm)", () => {
  it("counts: 20 StationaryGun, 9 AIStationaryGunHolder, 2 MineField, 82 GuardGenerator, 1 HumanSoldierRPG, 5 HumanSoldierFemale", () => {
    const n: Record<string, number> = {};
    for (let l = 1; l <= 14; l++) for (const t of tasksOf(l)) n[t.type] = (n[t.type] ?? 0) + 1;
    expect([n.StationaryGun, n.AIStationaryGunHolder, n.MineField, n.GuardGenerator, n.HumanSoldierRPG, n.HumanSoldierFemale]).toEqual([20, 9, 2, 82, 1, 5]);
  });

  it("StationaryGun parameters: M2HB everywhere, endless ammo except mission 7 #3301 (10000)", () => {
    const guns = [4, 6, 7, 8, 9, 11, 12].flatMap((l) => tasksOf(l).filter((t) => t.type === "StationaryGun").map((t) => ({ l, t })));
    expect(guns).toHaveLength(20);
    for (const { l, t } of guns) {
      const d = stationaryGunDef(t.params);
      expect(d.weaponId).toBe("WEAPON_ID_M2HB");
      expect(d.holderModel).toBe("123_02_1");
      expect(d.ammo).toBe(l === 7 && t.id === 3301 ? 10000 : -1);
    }
  });

  it("GuardGenerator templates take no perception phase at load (mission 14: 38 generators)", () => {
    const tasks = buildMissionTasks(readTaskTree(readQvmCallTree(bytes(`${FULL}/missions/location0/level14/objects.qvm`))));
    const { phases } = perceptionPhases(tasks, 0);
    const templated = tasks.nodes.filter((n) => {
      for (let p = n.parent; p >= 0; p = tasks.nodes[p].parent) if (tasks.nodes[p].type === "GuardGenerator") return n.type === "HumanAI";
      return false;
    });
    expect(templated.length).toBeGreaterThanOrEqual(38);
    for (const n of templated) expect(phases.has(n.index)).toBe(false);
  });

  it("GuardGenerator members: mission 4 generators spawn on the first tick inside their containers", () => {
    const tasks = buildMissionTasks(readTaskTree(readQvmCallTree(bytes(`${FULL}/missions/location0/level4/objects.qvm`))));
    const spawned: number[] = [];
    const rt = new MissionRuntime(tasks, { onTaskEvent: (n, e) => e === "guard.spawn" && spawned.push(n.id), value: () => 0 });
    for (let i = 0; i < 3; i++) rt.tick();
    // #600-#603 sit in ConditionalContainers that are not running yet: no spawn.
    expect(rt.member("GuardGenerator_600.nSpawns")).toBe(0);
    expect(rt.member("GuardGenerator_600.isOn")).toBe(0);
    expect(spawned).toEqual([]);
  });
});

describe.skipIf(!haveFull)("mission loads: soldier subclasses, combat models, turret definitions", () => {
  let l10: IgiLevel;
  let l14: IgiLevel;
  beforeAll(async () => {
    l10 = await loadMission(10);
    l14 = await loadMission(14);
  }, 180_000);

  it("mission 14: the 5 HumanSoldierFemale soldiers load (skeleton 6, Ekk 012_01_1 x4, Anya 015_01_1)", () => {
    const f = l14.soldiers.filter((s) => s.taskType === "HumanSoldierFemale");
    expect(f).toHaveLength(5);
    expect(f.map((s) => s.taskId).sort((a, b) => a - b)).toEqual([454, 456, 700, 701, 702]);
    expect(new Set(f.map((s) => s.skeleton))).toEqual(new Set([6]));
    expect(f.filter((s) => s.model === "012_01_1")).toHaveLength(4);
    expect(f.find((s) => s.taskId === 456)).toMatchObject({ model: "015_01_1", aiType: "AITYPE_ANYA", team: 0, standAnimation: 10 });
    expect(f.find((s) => s.taskId === 454)).toMatchObject({ aiType: "AITYPE_EKK", standAnimation: -1 });
    expect(l14.animations.has(6)).toBe(true);
    for (const s of f) expect(l14.boneModels.has(s.model)).toBe(true);
    // Every soldier class is in level.soldiers, in task order.
    expect(l14.soldiers.length).toBe(l14.tasks.filter((t) => isSoldierTaskType(t.type)).length);
  });

  it("mission 10: the RPG guard #431 (skeleton 2, AITYPE_RPG, RPG18) and the missile model", () => {
    const r = l10.soldiers.find((s) => s.taskType === "HumanSoldierRPG")!;
    expect(r).toMatchObject({ taskId: 431, skeleton: 2, standAnimation: 2, aiType: "AITYPE_RPG", weapon: "WEAPON_ID_RPG18", model: "013_01_1" });
    expect(l10.animations.has(2)).toBe(true);
    expect(l10.models.has("110_02_1")).toBe(true);
  });

  it("mission 14: nine turret holders, each with its ATTA turret (TASKTYPE_AISTATIONARYGUN 456_12_1) and the SENTRY gun model", () => {
    const holders = l14.tasks.map((t, i) => ({ t, i })).filter((x) => x.t.type === "AIStationaryGunHolder");
    expect(holders).toHaveLength(9);
    for (const h of holders) expect(l14.instances.some((x) => x.taskIndex === h.i && x.magicType === "TASKTYPE_AISTATIONARYGUN" && x.model === "456_12_1")).toBe(true);
    const def = aiTurretDef(l14.aiTurretDefs!.get("456_12_1")!)!;
    expect(def).toMatchObject({ gunModel: "456_13_1", sound: "tank_turret", ammo: 10000 });
    expect(l14.models.has("456_13_1")).toBe(true);
    const sentry = [...l14.weapons.values()].find((w) => w.gunModel === "456_13_1")!;
    expect(sentry.scriptId).toBe("WEAPON_ID_SENTRY");
  });

  it("mission 14: the turret holders' team follows !Terminal_301.isHacked", () => {
    const tasks = buildMissionTasks(l14.taskRoots);
    const events: Array<{ id: number; team: number; isOn: number }> = [];
    const host: MissionHost = { onTaskEvent: (n, e, d) => e === "turret.update" && events.push({ id: n.id, ...(d as { team: number; isOn: number }) }), value: () => 0 };
    const rt = new MissionRuntime(tasks, host);
    rt.tick();
    const generator = events.filter((e) => e.id >= 2500 && e.id <= 2504);
    expect(generator.length).toBeGreaterThan(0);
    expect(new Set(generator.map((e) => e.team))).toEqual(new Set([1]));
    rt.hackTerminal(301);
    events.length = 0;
    rt.tick();
    expect(new Set(events.filter((e) => e.id >= 2500 && e.id <= 2504).map((e) => e.team))).toEqual(new Set([0]));
  });

  it("HumanSoldierFemale body (006.iff): stand clip 6, aim request -> raise (clip 7) -> aim (clip 14) -> fire (clip 9)", () => {
    const anim = readAnimations(l14.animations.get(6)!);
    const body = new ClipPlayer(anim);
    let shots = 0;
    const m = new SoldierMotor(body, 0, -1, { weaponId: "WEAPON_ID_UZI", roundsPerClip: 32, maxRoundsPerBurst: 32, roundsPerMinute: 600, grenade: false }, null, { shot: () => shots++ }, () => 0, { cls: "female", aiType: "AITYPE_EKK" });
    const ch = new Float32Array(40);
    m.step(ch);
    expect(m.graphState).toBe(FEMALE_STATE.STAND);
    expect(body.currentClip).toBe(6);
    ch[CH.AIM] = 1;
    m.step(ch);
    expect(m.graphState).toBe(FEMALE_STATE.RAISE);
    expect(body.currentClip).toBe(7);
    for (let i = 0; i < 60 && m.graphState !== FEMALE_STATE.AIM; i++) m.step(ch);
    expect(m.graphState).toBe(FEMALE_STATE.AIM);
    ch[CH.FIRE] = 1;
    m.step(ch);
    expect(m.graphState).toBe(FEMALE_STATE.FIRE);
    for (let i = 0; i < 10; i++) m.step(ch);
    expect(shots).toBeGreaterThan(0);
    // The AI sees the female stand (0) and animation (11) states only: the others match no body test.
    expect(m.state).toBeGreaterThanOrEqual(1000);
    // A female never flinches (0x4553e0 sets no flinch bit).
    m.hit({ amount: 0.5, zone: 13, deathType: 2, direction: [0, 0, 0], lethal: false });
    expect(m.bits & 0x10000).toBe(0);
  });
});

describe.skipIf(!haveFull)("MineField in mission 7 (the player's feet, every 5 s)", () => {
  it("explodes under the player inside a trigger area, sound explo_m_02 kept as in the data", () => {
    const tasks = buildMissionTasks(readTaskTree(readQvmCallTree(bytes(`${FULL}/missions/location0/level7/objects.qvm`))));
    const area = tasks.areas.find((a) => a.id === 186)!;
    const out: MineFieldExplosion[] = [];
    const host: MissionHost = {
      humans: () => [{ position: [...area.position], team: 0 }],
      value: (n) => (n === "HumanPlayer_0.isDead" ? 0 : undefined),
      onTaskEvent: (_n, e, d) => e === MINEFIELD_EVENTS.explode && out.push(d as MineFieldExplosion),
      query: (name, ...a) => (name === MINEFIELD_EVENTS.position && a[0] === 0 ? [...area.position] : name === MINEFIELD_EVENTS.snap ? area.position[2] - 4096 : undefined),
    };
    const rt = new MissionRuntime(tasks, host);
    for (let i = 0; i < 160; i++) rt.tick();
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0]).toMatchObject({ damage: 4.5, radius: 12288, falloff: 6144, fragments: 3, fireballs: 3, sound: "explo_m_02" });
    expect(out[0].position[2]).toBe(area.position[2] - 4096);
  });
});

interface Rig {
  ctx: GameContext;
  level: IgiLevel;
  mission: MissionSystem;
  enemies: EnemyManager;
  player: PlayerController;
  weapon: WeaponSystem;
  combat: CombatObjects;
  damage: DamageSystem;
  held: Set<string>;
  step(n?: number): void;
}

async function engineRig(id: number): Promise<Rig> {
  const level = await loadMission(id);
  const world = buildWorld(
    level,
    (b) => b.addIndexed(level.terrain.detail.positions, level.terrain.detail.indices, TRI_SOLID | TRI_BULLET | TRI_SIGHT | TRI_TERRAIN, TERRAIN_HIT_MATERIAL),
    { dynamicTasks: dynamicTaskKeys(level) },
  );
  const names = damageModelNames(level);
  const data = await loadDamageModelData(raw, names.bounds, names.build, (key) => level.textures.has(key), level.paths);
  const held = new Set<string>();
  const input = {
    get isFiring() {
      return held.has("Fire");
    },
    action: (a: string) => held.has(a),
    actionPressed: () => false,
    isDown: () => false,
    consumeMouse: () => [0, 0],
    forward: 0,
    strafe: 0,
  };
  const ctx = {
    world: world.collision, level, tick: 0, appTick: 0, events: new EventBus(), rng: new LevelRng(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(73.74, 4 / 3, 0.1, 2000), input, running: true,
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
  const player = createPlayerController(ctx, { interactions: { source: raw as never, doors: true } });
  ctx.systems.player = player;
  const weapon = createWeaponSystem(ctx);
  weapon.setWeaponExtras(readWeaponExtras(bytes(`${FULL}/weapons/weaponconfig.qvm`)));
  ctx.systems.weapon = weapon;
  const enemies = createEnemyManager(ctx, { source: raw });
  ctx.systems.enemies = enemies;
  const mission = createMissionSystem(ctx);
  ctx.systems.tasks = mission;
  const combat = createCombatObjects(ctx, mission);
  player.reset();
  weapon.reset();
  enemies.reset();
  mission.start(level);
  mission.attachWorld(world);
  combat.reset();
  combat.attachWorld(world);
  await player.interactions.load();
  for (let i = 0; i < 400 && !enemies.stats.aiLoaded; i++) await new Promise((r) => setTimeout(r, 25));
  const tick = (breakIntro: boolean) => {
    if (breakIntro) mission.requestBreak();
    damage.beginTick();
    enemies.beginNodeTick(1 / 30);
    let walked = false;
    mission.setNodeTick((type, tid, node) => {
      walked = true;
      if (type === "HumanPlayer") {
        player.update(1 / 30);
        weapon.update(1 / 30);
      } else if (isSoldierTaskType(type) || type === "HumanAI") enemies.tickNode(tid, type, node);
    });
    mission.tick();
    mission.setNodeTick(null);
    enemies.endNodeTick(!walked);
    damage.endTick();
    ctx.tick++;
    ctx.appTick = (ctx.appTick ?? 0) + 1;
  };
  for (let i = 0; i < 4000 && (i < 2 || !(mission.playerInWorld && !mission.cutscene)); i++) tick(true);
  return { ctx, level, mission, enemies, player, weapon, combat, damage, held, step: (n = 1) => { for (let i = 0; i < n; i++) tick(false); } };
}

describe.skipIf(!haveFull)("mission 8 in the engine: GuardGenerator, StationaryGun (player state 33, gunner mount)", () => {
  let rig: Rig;
  beforeAll(async () => {
    rig = await engineRig(8);
  }, 600_000);

  it("generators spawn their soldiers (not created at load); a corpse leaves the world 300 ticks after its death clip, then respawns", () => {
    const { mission, enemies, ctx } = rig;
    const rt = mission.runtime!;
    expect(rt.member("GuardGenerator_658.nSpawns")).toBe(1);
    expect(rt.member("GuardGenerator_658.isSpawned")).toBe(1);
    const node = rt.tasks.nodes.find((n) => n.type === "HumanSoldier" && n.id === 436)!.index;
    let e = ctx.enemies.find((x) => x.node === node)!;
    expect(e).toBeDefined();
    expect(rt.member("GuardGenerator_1700.nSpawns")).toBe(1);
    enemies.damage(e, 100, [e.position[0] + 1, e.position[1] + 1, e.position[2]]);
    expect(e.alive).toBe(false);
    let removedAt = -1;
    for (let i = 0; i < 900 && rt.member("GuardGenerator_1700.nSpawns") === 1; i++) {
      rig.step();
      if (removedAt < 0 && e.outOfWorld) removedAt = i;
    }
    expect(removedAt).toBeGreaterThan(300);
    expect(rt.member("GuardGenerator_1700.nSpawns")).toBe(2);
    e = ctx.enemies.find((x) => x.node === node)!;
    expect(e.alive).toBe(true);
    expect(e.outOfWorld).toBeFalsy();
  });

  it("the player mounts gun #775 from behind (state 33, camera mode 4), fires every 2 ticks and leaves on a fresh Activate", () => {
    const { ctx, combat, player, held } = rig;
    const guns = combat.stationaryGuns;
    const c = guns.candidates().find((x) => x.gun.id === 775)!;
    expect(c).toBeDefined();
    // 1.2 m behind the use point (along col1 of the object matrix), on the ground below.
    const o = ctx.level!.originIgi;
    const behind = [c.point[0] + c.matrix[1] * 1.2 * 4096, c.point[1] + c.matrix[4] * 1.2 * 4096, c.point[2]];
    const e = [(behind[0] - o[0]) / 4096, (behind[2] - o[2]) / 4096, -(behind[1] - o[1]) / 4096];
    const ground = ctx.world!.raycast(e[0], e[1] + 0.3, e[2], 0, -1, 0, 20, TRI_SOLID);
    ctx.player.position = [e[0], ground ? ground.point[1] : e[1] - 1.6, e[2]];
    rig.step(10);
    expect(ctx.player.grounded).toBe(true);
    // The view looks at the use point.
    const target = new THREE.Vector3((c.point[0] - o[0]) / 4096, (c.point[2] - o[2]) / 4096, -(c.point[1] - o[1]) / 4096);
    const p = ctx.player.position;
    ctx.camera.position.set(p[0], p[1] + ctx.player.eyeHeight, p[2]);
    ctx.camera.lookAt(target);
    ctx.camera.updateMatrixWorld();
    for (let i = 0; i < 60 && rig.weapon.state !== WEAPON_STATE.ready; i++) rig.step();
    rig.step(2);
    expect(player.interactions.target?.kind).toBe("stationaryGun");
    expect(player.interactions.actionIcon).toBe("a_gun.spr");
    held.add("Activate");
    rig.step(1);
    expect(player.movementState).toBe(33);
    expect(guns.playerGun?.id).toBe(775);
    expect(playerViewMode(ctx)).toBe(4);
    expect(player.interactions.weaponHolstered).toBe(true);
    rig.step(2);
    expect(rig.weapon.state).toBe(WEAPON_STATE.holstered);
    held.delete("Activate");
    held.add("Fire");
    const gun = guns.playerGun!;
    const before = gun.rounds;
    for (let i = 0; i < 10; i++) {
      guns.setPlayerInput(0, 0, true, 0.4, true);
      rig.step();
    }
    expect(gun.rounds - before).toBeGreaterThanOrEqual(4);
    expect(gun.rounds - before).toBeLessThanOrEqual(5);
    expect(gun.clip).toBe(-1);
    held.delete("Fire");
    guns.setPlayerInput(0, 0, true, 0.4, false);
    rig.step(2);
    held.add("Activate");
    rig.step(1);
    expect(guns.playerGun).toBeNull();
    expect(player.movementState).toBe(0);
    held.delete("Activate");
  });

  it("the tank-tower gunner (soldier 445, SetGunnerID 780) mounts on channel 24: state 36, 0.7 m behind, the gun in use", () => {
    const { ctx, enemies, combat } = rig;
    const rt = rig.mission.runtime!;
    const node = rt.tasks.nodes.find((n) => n.type === "HumanSoldier" && n.id === 445)!.index;
    const e = ctx.enemies.find((x) => x.node === node)!;
    const ai = enemies.aiOf(e)!;
    expect(ai.gunnerId).toBe(780);
    expect(combat.stationaryGuns.isInUse(780)).toBe(0);
    ai.ch[CH.USE] = 780;
    rig.step();
    expect(enemies.inspect(e)!.motorState).toBe(36);
    expect(combat.stationaryGuns.isInUse(780)).toBe(1);
    const gun = combat.stationaryGuns.byId(780)!;
    expect(gun.user).toEqual({ kind: "soldier", key: e.id });
    rig.step(5);
    expect(enemies.inspect(e)!.motorState).toBe(36); // no channel-24 press: it stays
  });
});

describe.skipIf(!haveFull)("player weapons of the full game: M203 (mission 5) and SPAS12", () => {
  let level: IgiLevel;
  beforeAll(async () => {
    level = await loadMission(5);
  }, 120_000);

  function weaponRig() {
    const held = new Set<string>();
    const pressed = new Set<string>();
    const ctx = {
      level, world: null, events: new EventBus(), rng: new LevelRng(), running: true, camera: new THREE.PerspectiveCamera(),
      input: { get isFiring() { return held.has("Fire"); }, action: (a: string) => held.has(a), actionPressed: (a: string) => pressed.has(a), forward: 0, strafe: 0 },
      player: { position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0, grounded: true, crouching: false, running: false, health: 3, maxHealth: 3, alive: true, walking: false, eyeHeight: 1.64, kickPitch: 0, kickYaw: 0, leanSide: 0, leanUp: 0 },
      weapon: null, enemies: [], systems: { weapon: null, enemies: null, objectives: null, audio: null, hud: null, effects: null, tasks: null, player: null },
    } as unknown as GameContext;
    const ws = createWeaponSystem(ctx);
    ws.setWeaponExtras(readWeaponExtras(bytes(`${FULL}/weapons/weaponconfig.qvm`)));
    ws.reset();
    return { ctx, ws, held, pressed, run: (n: number) => { for (let i = 0; i < n; i++) { ws.update(1 / 30); pressed.clear(); } } };
  }

  it("M203: AlternateFire with the M16A2 takes one AMMO_ID_M203 round, plays FireAnim2 (clip 39) and launches a grenade at 10240 units/tick", () => {
    const r = weaponRig();
    expect(level.player.weapons).toContain("WEAPON_ID_M16A2");
    expect(r.ws.reserveOf("AMMO_ID_M203")).toBe(3);
    // Select the M16A2.
    for (let i = 0; i < 400 && r.ctx.weapon?.spec.scriptId !== "WEAPON_ID_M16A2"; i++) {
      r.ws.cycle();
      r.run(30);
    }
    expect(r.ctx.weapon?.spec.scriptId).toBe("WEAPON_ID_M16A2");
    r.run(30);
    expect(r.ws.state).toBe(WEAPON_STATE.ready);
    const projectiles = projectileSystemOf(r.ctx);
    r.held.add("AlternateFire");
    r.run(1);
    expect(r.ws.state).toBe(WEAPON_STATE.m203);
    expect(r.ws.reserveOf("AMMO_ID_M203")).toBe(2);
    expect(r.ctx.firstPerson!.arms.current?.clip).toBe(39);
    const g = projectiles.flying.find((p) => p.kind === "m203")!;
    expect(g).toBeDefined();
    expect(Math.hypot(...g.velocity)).toBeCloseTo(10240, -1);
    r.held.delete("AlternateFire");
    r.run(50);
    expect(r.ws.state).toBe(WEAPON_STATE.ready);
  });

  it("SPAS12 reload: clips 61 -> 62 per shell -> 63; 7 rounds from 5 in 1 + 19 + 2 x 10 + 43 ticks", () => {
    const r = weaponRig();
    r.ws.addWeapon("WEAPON_ID_SPAS12", 5);
    r.ws.addAmmo("AMMO_ID_12", 10);
    for (let i = 0; i < 400 && r.ctx.weapon?.spec.scriptId !== "WEAPON_ID_SPAS12"; i++) {
      r.ws.cycle();
      r.run(30);
    }
    expect(r.ctx.weapon?.spec.scriptId).toBe("WEAPON_ID_SPAS12");
    r.run(30);
    const clips: number[] = [];
    r.ws.reload();
    let ticks = 0;
    do {
      r.run(1);
      ticks++;
      const c = r.ctx.firstPerson!.arms.current?.clip;
      if (r.ws.state === WEAPON_STATE.reload && c !== undefined && clips[clips.length - 1] !== c) clips.push(c);
    } while ((ticks < 3 || r.ws.state === WEAPON_STATE.reload) && ticks < 400);
    // S1 enters S3 on the request tick (the stand clip 58 still plays); the S3 ticks run the SPAS12 method.
    expect(clips.slice(clips.indexOf(61))).toEqual([61, 62, 63]);
    expect(r.ctx.weapon!.ammo).toBe(7);
    expect(r.ws.reserveOf("AMMO_ID_12")).toBe(8);
    expect(ticks).toBeGreaterThanOrEqual(80);
    expect(ticks).toBeLessThanOrEqual(100);
  });
});
