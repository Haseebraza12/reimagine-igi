/**
 * The engine rig of the full-game turret tests (tests/full-turrets.test.ts): a
 * mission loaded from game-data with the collision world, damage, player,
 * weapons, soldiers, mission system and combat objects (as full-combat's rig).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { levelPathsFor, loadIgiLevel, type IgiLevel } from "../src/loaders";
import { loadDamageModelData } from "../src/loaders/damage-data";
import { readMissionDefinition } from "../src/engine/ui/assets";
import { readWeaponExtras } from "../src/engine/combat/weapon-tags";
import { LevelRng } from "../src/engine/ai/rng";
import type { Enemy, GameContext } from "../src/engine/context";
import { EventBus } from "../src/engine/events";
import { attachDamageSystem, createDamageSystem, damageModelNames, type DamageSystem } from "../src/engine/combat/object-damage";
import { createEnemyManager, type EnemyManager } from "../src/engine/combat/enemy";
import { createWeaponSystem, type WeaponSystem } from "../src/engine/combat/weapon";
import { createPlayerController, type PlayerController } from "../src/engine/player/player";
import { buildWorld } from "../src/engine/world/world-builder";
import { TERRAIN_HIT_MATERIAL, TRI_BULLET, TRI_SIGHT, TRI_SOLID, TRI_TERRAIN } from "../src/engine/world/collision";
import { dynamicTaskKeys } from "../src/engine/level";
import { createMissionSystem, type MissionSystem } from "../src/engine/mission/mission-system";
import { createCombatObjects, type CombatObjects } from "../src/engine/combat/combat-objects";
import { isSoldierTaskType } from "../src/loaders/soldier-types";

export const FULL = fileURLToPath(new URL("../game-data", import.meta.url));
export const bytes = (path: string): ArrayBuffer => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
export const raw = createFsAssetSource(FULL);

export async function loadMission(id: number): Promise<IgiLevel> {
  const [def] = readMissionDefinition(bytes(`${FULL}/missions/location0/level${id}/mission.qvm`), new Map());
  return loadIgiLevel(raw, levelPathsFor(def.location));
}

export interface TurretRig {
  ctx: GameContext;
  level: IgiLevel;
  mission: MissionSystem;
  enemies: EnemyManager;
  player: PlayerController;
  weapon: WeaponSystem;
  combat: CombatObjects;
  damage: DamageSystem;
  world: ReturnType<typeof buildWorld>;
  step(n?: number): void;
  /** Put the player (feet) at an IGI point on the ground below it. */
  placePlayer(igi: readonly number[]): void;
}

export async function turretRig(id: number, level?: IgiLevel): Promise<TurretRig> {
  level ??= await loadMission(id);
  const lvl = level;
  const world = buildWorld(
    lvl,
    (b) => b.addIndexed(lvl.terrain.detail.positions, lvl.terrain.detail.indices, TRI_SOLID | TRI_BULLET | TRI_SIGHT | TRI_TERRAIN, TERRAIN_HIT_MATERIAL),
    { dynamicTasks: dynamicTaskKeys(lvl) },
  );
  const names = damageModelNames(lvl);
  const data = await loadDamageModelData(raw, names.bounds, names.build, (key) => lvl.textures.has(key), lvl.paths);
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
    world: world.collision, level: lvl, tick: 0, appTick: 0, events: new EventBus(), rng: new LevelRng(), scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(73.74, 4 / 3, 0.1, 2000), input, running: true,
    player: {
      position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0, grounded: true, crouching: false, running: false, health: 3, maxHealth: 3,
      alive: true, walking: false, eyeHeight: 1.64, kickPitch: 0, kickYaw: 0, leanSide: 0, leanUp: 0,
    },
    enemies: [] as Enemy[], playArea: null, weapon: null, objectives: [], messages: [],
    systems: { weapon: null, enemies: null, objectives: null, audio: null, hud: null, effects: null, tasks: null, player: null },
  } as unknown as GameContext;
  const damage = createDamageSystem(ctx, { fx: false });
  damage.attach(lvl, world, data);
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
  mission.start(lvl);
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
  const placePlayer = (igi: readonly number[]) => {
    const o = lvl.originIgi;
    const e = [(igi[0] - o[0]) / 4096, (igi[2] - o[2]) / 4096, -(igi[1] - o[1]) / 4096];
    const ground = world.collision.raycast(e[0], e[1] + 3, e[2], 0, -1, 0, 60, TRI_SOLID);
    ctx.player.position = [e[0], ground ? ground.point[1] : e[1], e[2]];
  };
  return { ctx, level: lvl, mission, enemies, player, weapon, combat, damage, world, placePlayer, step: (n = 1) => { for (let i = 0; i < n; i++) tick(false); } };
}
