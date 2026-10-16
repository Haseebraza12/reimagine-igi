/**
 * Soldiers: spawning, the recovered HumanAI (engine/ai/*) and the engine
 * side of their bodies, bullets and noises.
 *
 * Recovered (docs/ai.md, docs/qvm-vm.md, docs/gameplay.md):
 *   - Every HumanSoldier task is a soldier (team 0 actors such as 4023
 *     "Jones" included); health = settings.qvm "Damage scale" at the
 *     configured difficulty (FUN_00407080); a soldier whose AI has no
 *     script or no graph does nothing (FUN_0044e260).
 *   - Each soldier runs its own mission script MISSION:AI/<HumanAI id> with
 *     the type's common script as DefaultHandler, on the recovered event /
 *     action machinery (engine/ai/human-ai.ts), perception, combat and
 *     firing (engine/ai/combat.ts), driving its body through the 40 input
 *     channels (engine/ai/motor.ts).
 *   - Noises offered to every soldier (AI_EVENT_PRODUCERS): the player's
 *     gunshots (GUNSHOT 0x46, WeaponConfig "AI Detection Event Range": 30 m
 *     or 1 m, from the gun), footsteps (WALK, ground material range, none
 *     while crouched), landings (GROUNDIMPACT 5 m / 10 m when hurt), bullet
 *     paths near soldiers (GUNSHOTMISS, 2 m), damage (TAKINGDAMAGE, posted
 *     to the damaged soldier only); the soldiers' own gunshots, footsteps,
 *     ALERTs, grenade landings and explosions.
 *   - AI bullets: one ray per pellet from the muzzle toward the AI's aim
 *     point with the gun's spread; when it reaches the player's hitbox it
 *     collides only if rand <= p (FUN_0045d100, level RNG); damage = Damage
 *     Factor x zone multiplier (1: the player's torso / head) x difficulty
 *     (FUN_004123e0). Never collides with the shooter's own team.
 *   - Soldier damage: zone multipliers from the posed body (head x100 unless
 *     SetInstantDeath(FALSE)); SetInvulnerability makes a soldier immune.
 *   - Perception sight rays (FUN_00487f40) meet every human in the world but
 *     the looker and the target, alive or dead (humanSightHits, docs/ai.md
 *     2.2); the combat node ray (FUN_00489b00) meets none. Humans are
 *     registered in task-tree order; the player is tracked only while in the
 *     world; the phase test reads the application tick (ctx.appTick).
 *
 * Inferred / port choices (labelled where used):
 *   - A bullet "reaches" the player when it passes the 0.35 m capsule (1.8 m /
 *     1.3 m crouched): then the hit roll; the hit itself is tested on the
 *     player's posed body (bone model set 0) with the player's zone
 *     multipliers (player.ts bodyHit).
 *   - Near-miss sound when a bullet passes within 2 m of the player (the
 *     GUNSHOTMISS range); the path's closest point is the event position.
 *   - Footsteps use the ground record's surface material (world/character.ts);
 *     a step with no material makes no WALK noise and no sound.
 *   - Grenades: HumanSoldier state 8 (FUN_0045a170) throws on animation
 *     event 11 while the AI holds a target: fly time and cooked ticks from
 *     the AI settings, the ballistic velocity of FUN_00451740 towards the
 *     target's aim point (FUN_00450150), then the shared thrown grenade
 *     (combat/grenade.ts: physics, bounce sound, GRENADETHROWN / GRENADELAND,
 *     fuse, the FUN_004751f0 explosion), ticked at the end of the soldiers'
 *     update. Soldiers take FUN_004592a0's zone-13 explosion damage (no
 *     TAKINGDAMAGE post). The release point is the hand bone [inferred].
 *   - Close combat: the strike hits a player within 2 m in front with
 *     "Close Combat hit probability", "Close Combat damage" x difficulty.
 *   - Soldiers with no ground under them (cut-scene storage, vehicle
 *     riders) are held in place without gravity.
 *   - Each soldier's body (motor, move, pose) updates before its AI frame,
 *     with the channels of the AI's previous frame: the HumanSoldier node
 *     precedes its HumanAI node in the mission task tree, and soldiers run
 *     in node order [recovered order of the task tree].
 *   - Bodies beyond the lod.qvm cutoff are not drawn (FUN_004c4fc0, soldier-lod.ts);
 *     dying bodies keep their root motion plus FUN_0045c3b0's slide.
 *   - Bodies far from the camera (> 120 m) are posed every 4th tick (port
 *     optimisation). Every living soldier moves through FUN_004600f0's sweep
 *     and ground probe each tick; airborne soldiers fall with the player's
 *     gravity (the AI fall handling was not traced).
 */
import * as THREE from "three";
import type { IAssetSource, Vec3 } from "../../contracts";
import {
  AI_DEATH_COUNTDOWN_TICKS,
  AI_GUNSHOT_RANGE,
  AI_GUNSHOT_SILENCED_RANGE,
  GRAVITY_UNITS_PER_TICK2,
  HIT_ZONE,
  PLAYER_DIFFICULTY_DAMAGE,
  createHttpAssetSource,
  aiBulletMayHitPlayer,
  x87F32Add,
  x87StoreF32,
  playerBulletDamage,
  spreadForShot,
  type IgiTask,
  type LevelSoldier,
  type LevelWeapon,
} from "../../loaders";
// collision-mesh.ts is not re-exported by loaders/index.ts yet (owned by the collision work).
import { NO_MATERIAL, aiSightPasses, readSurfaceMaterials, sightTransmission } from "../../loaders/collision-mesh";
import { NEAR_MISS_METRES, PLAYER_HITBOX, closestOnSegment, rayCapsule } from "../ai/ballistics";
import { traceBullet } from "./bullet";
import { drawPellet, pelletDirection, spreadRadians } from "./pellet";
import type { ExplosionRecord, SoldierExplosionHit } from "./explosion-rules";
import { damageSystemOf, type DamageSystem, type ExplosionHuman } from "./object-damage";
import { grenadeSystemOf, soldierThrowVelocity } from "./grenade";
import { aimPointOf } from "../ai/combat";
import { GRAPH_ATTACHING_TYPES, loadAiLevelData, type AiLevelData } from "../ai/data";
import { HumanAi } from "../ai/human-ai";
import { SoldierMotor, type GunSpec } from "../ai/motor";
import { DEATH_TYPE } from "../ai/soldier-graph";
import { tanHalfFovX } from "../world/lod";
import { EV, PLAYER_KEY, type AiEvent, type AiHuman, type V3 } from "../ai/types";
import { AiWorld, type AiHooks } from "../ai/world";
import { GameEvent } from "../events";
import { INTERACT_EVENTS } from "../player/interact";
import type { Enemy, EnemyState, GameContext } from "../context";
import type { BlobShadow } from "../fx/blob-shadow";
import { createMuzzleFlash, type MuzzleFlash } from "../fx/muzzle-flash";
import { addSceneHook } from "../render/scene-hooks";
import { attachHuman, createHumanMoveState, moveHuman, updatePlatform, type HumanMoveState } from "../world/character";
import { TRI_BULLET, TRI_SIGHT, TRI_SOLID, type CollisionWorld } from "../world/collision";
import { SoldierAssets, SoldierBody } from "./soldier-body";
import { segmentNearSphere } from "./body-collision";
import { readMefBounds } from "../../loaders/damage-data";
import { stationaryGunsOf } from "./stationary-guns";
import { projectileSystemOf } from "./projectiles";
import { isSoldierTaskType } from "../../loaders/soldier-types";
import { SOLDIER_CLASS_OF_TYPE } from "../ai/soldier-variants";
import type { AiStationaryGun } from "../ai/gunner";

const UNITS = 4096;
const FULL_POSE_DISTANCE = 120;
/** Soldiers' airborne gravity per tick, metres (the player's 0x5313f0; the AI fall handling was not traced). */
const GRAVITY_M_PER_TICK2 = GRAVITY_UNITS_PER_TICK2 / UNITS;
const ZERO_CHANNELS = new Float32Array(40);


export interface EnemyHitResult {
  enemy: Enemy;
  distance: number;
  point: Vec3;
  head: boolean;
  /** Damage multiplier of the hit zone (docs/gameplay.md: head x100, torso x1, limbs 0.5-1). */
  zoneMultiplier: number;
  /** material.qvm index of the body face hit (bone-model collision set 0). */
  material: number;
}

export interface EnemyStats {
  /** Mean / max wall-clock milliseconds of update() over the last 300 ticks. */
  msPerTick: number;
  maxMsPerTick: number;
  scriptRuns: number;
  soldiers: number;
  activeAi: number;
  aiLoaded: boolean;
  /** Mean ms per tick split: AI frames (scripts, perception, actions), motor + collision, skinning, shadow rays. */
  split: { ai: number; move: number; pose: number; shadow: number };
}

export interface EnemyManager {
  update(dt: number): void;
  /** Remove all soldiers and spawn the level's. */
  reset(): void;
  damage(enemy: Enemy, amount: number, from: Vec3): void;
  /** Soldiers hit by a ray from `from` along unit `dir` within `maxDistance`, nearest first. */
  /** `options.nearMiss` false: no GUNSHOTMISS alert along the ray (knife rays are not gunshots). */
  hitTest(from: Vec3, dir: Vec3, maxDistance: number, options?: { nearMiss?: boolean }): EnemyHitResult[];
  /** HumanAI_<id>.isDetection (+0x3ab5). igi.exe only ever writes 0 there (constructor 0x44df96). */
  isDetection(aiTaskId: number): number;
  /** HumanSoldier_<id>.isDead. */
  isDead(soldierTaskId: number): number;
  /** The soldier AI of an Enemy (diagnostics / tests), or null. */
  /** Debug view of a soldier's body, motor and attach state (automation). */
  inspect(enemy: Enemy): {
    clip: { id: number; loop: boolean; time: number } | null;
    motorState: number;
    scripted: number;
    scriptedClip: number;
    rootZ: number;
    present: boolean;
    attached: { body: number; local: number[] } | null;
    channels: number[] | null;
  } | null;
  aiOf(enemy: Enemy): HumanAi | null;
  /**
   * Task-tree order (FUN_004e2d60 walk; game.ts drives it from the mission runtime): beginNodeTick,
   * then tickNode for each HumanSoldier (body) and HumanAI (AI frame) node the walk reaches, then
   * endNodeTick (grenades; soldiers whose node was not reached are out of the world).
   */
  beginNodeTick(dt: number): boolean;
  tickNode(taskId: number, type: string, nodeIndex: number): void;
  /** `fallback`: the walk did not run (no runtime): tick every soldier in list order instead. */
  endNodeTick(fallback?: boolean): void;
  /** Soldiers in the world (alive, present) with their HumanSoldier "Team" and eye position (engine). */
  visibleSoldiers(): Array<{ enemy: Enemy; team: number; eye: Vec3; model: string }>;
  /**
   * The humans on a sight ray from `from` to `to` (engine): the set-0 faces of every human in the
   * world (soldiers alive or dead, the player) except the `skip` keys (0 = the player, else
   * Enemy.id) whose HSEM sphere the segment passes (FUN_004c4630 message 8 -> FUN_0045e490), as
   * {material, front} for sightTransmission. The security cameras' sight rays add these.
   */
  sightHits(from: Vec3, to: Vec3, skip: readonly number[]): Array<{ material: number; front: boolean }>;
  readonly stats: EnemyStats;
  // --- combat: GuardGenerator soldiers (loaders/objects/guard-generator.ts) -------------------
  /** Instantiate the template soldier of HumanSoldier node `node` (FUN_00488000): a fresh body, AI and phase. */
  spawnGenerated(node: number): Enemy | null;
  /** Delete the generated soldier of node `node` (FUN_004015f0). */
  removeGenerated(node: number): void;
  /** The generated soldier of node `node`: dead (+0xcf5) and in the world (+0xcf6), or null when none exists. */
  generatedState(node: number): { dead: boolean; inWorld: boolean } | null;
  /** The soldier runtime of an Enemy for the combat objects (stationary guns, turrets), or null. */
  soldierOf(enemy: Enemy): EnemyCombatAccess | null;
  /** The soldier with this AI key (Enemy.id), or null. */
  enemyByKey(key: number): Enemy | null;
  /** FUN_0044fab0: offer an event to every soldier's AI (the combat objects' gunshots). */
  broadcast(ev: AiEvent): void;
  /** combat: one AI bullet of a non-soldier shooter (a turret): its team filter and hit probability. */
  shootAs(src: { team: number; hitProbability: number; id: number }, weapon: LevelWeapon, from: Vec3, dir: Vec3): void;
  /** The player as an AI human (key 0) and the soldiers (their AI view), for the combat objects' detectors. */
  aiHumans(): Iterable<AiHuman>;
}

/** What the combat objects (stationary guns) need of a soldier. */
export interface EnemyCombatAccess {
  enemy: Enemy;
  ai: HumanAi | null;
  motor: SoldierMotor;
  team: number;
  /** One AI bullet of `weapon` from `from` along unit `dir` (engine), with the soldier's hit probability. */
  shoot(weapon: LevelWeapon, from: Vec3, dir: Vec3): void;
  /** Place the feet (engine) and the heading (the stationary-gun mount, FUN_0045c8b0). */
  place(feet: Vec3, yaw: number): void;
}

interface SoldierRuntime {
  /**
   * The vehicle the soldier rides: its AIGraph's parent when that derives
   * from RigidDynCubeObj (Train, Car, Heli: FUN_004efc80 sets graph+100), as
   * the dynamic body id (node index); null when none, undefined until resolved.
   */
  vehicleBody?: number | null;
  /** The rider's first attach took its placed position (FUN_00461f50 at the first FUN_00460fd0). */
  riderPlaced?: boolean;
  enemy: Enemy;
  level: LevelSoldier;
  team: number;
  body: SoldierBody;
  motor: SoldierMotor;
  human: AiHuman;
  ai: HumanAi | null;
  weapon: LevelWeapon | null;
  grenade: LevelWeapon | null;
  grounded: boolean;
  /** FUN_004600f0 movement state (root position, air velocity, ground record). */
  mv: HumanMoveState;
  held: boolean;
  present: boolean;
  shadow: BlobShadow | null;
  flash: MuzzleFlash | null;
  lastPose: number;
  /** Ground probe's roof flag of the last move (graph bit 0x10). */
  roof: boolean;
  /** Last hit test on this body (zone, bullet direction in engine space) for the damage that follows it. */
  lastHit: { zone: number; dir: Vec3; tick: number } | null;
  /** FUN_0045c3b0 death slide per tick, engine metres (applied while the death clip plays). */
  deathSlide: Vec3 | null;
  /** Engine-space movement of the last tick (state 29 keeps it as the fall velocity). */
  lastMove: Vec3;
  /** A GuardGenerator child (its corpse leaves the world unconditionally). */
  generated?: boolean;
  /** H+0x3e10: corpse countdown (= H+0x3d40 = 300 at AI init 0x44f25a). */
  corpseCount?: number;
  /** +0x7c4: application tick of the last frame the body was drawn (draw path 0x45f2bf), -1 never. */
  drawStamp?: number;
  /** The body was drawn (LOD >= 0) in this tick's pose (stamped after the AI's corpse test). */
  drawnNow?: boolean;
}

export interface EnemyManagerOptions {
  /** Where the AI data (scripts, graphs, settings) is read from; default "/raw/". */
  source?: IAssetSource;
}

export function createEnemyManager(ctx: GameContext, options: EnemyManagerOptions = {}): EnemyManager {
  const raycaster = new THREE.Raycaster();
  const source = options.source ?? createHttpAssetSource("/raw/");
  let assets: SoldierAssets | null = null;
  let soldiers: SoldierRuntime[] = [];
  const byId = new Map<number, SoldierRuntime>();
  let nextId = 1;
  let world: AiWorld | null = null;
  let aiData: AiLevelData | null = null;
  let loadingFor: unknown = null;
  /** Thrown grenades (player's and soldiers'); their AI events go to this AI world (FUN_00475470 -> FUN_0044fab0). */
  const grenades = grenadeSystemOf(ctx);
  grenades.setAiEvents((ev) => world?.broadcast({ ...ev }));
  /** QMaterial see-through value per material.qvm index (docs/collision.md). */
  let seeThrough: number[] | null = null;
  const timings: number[] = [];
  const stats: EnemyStats = { msPerTick: 0, maxMsPerTick: 0, scriptRuns: 0, soldiers: 0, activeAi: 0, aiLoaded: false, split: { ai: 0, move: 0, pose: 0, shadow: 0 } };
  const split = { ai: 0, move: 0, pose: 0, shadow: 0, n: 0 };

  const difficultyKey = (): keyof typeof PLAYER_DIFFICULTY_DAMAGE => {
    const d = ctx.level?.difficulty;
    return d === "GD_1" || d === "GD_3" ? d : "GD_2";
  };
  const origin = (): Vec3 => ctx.level?.originIgi ?? [0, 0, 0];
  const toIgi = (e: readonly number[]): V3 => {
    const o = origin();
    return [e[0] * UNITS + o[0], -e[2] * UNITS + o[1], e[1] * UNITS + o[2]];
  };
  const toEngine = (i: readonly number[]): Vec3 => {
    const o = origin();
    return [(i[0] - o[0]) / UNITS, (i[2] - o[2]) / UNITS, -(i[1] - o[1]) / UNITS];
  };
  const inWorld = (taskId: number): boolean => {
    const fn = ctx.systems.tasks?.inWorld;
    return fn ? fn.call(ctx.systems.tasks, taskId) : true;
  };
  /** A soldier's in-world state by its own node (ids repeat), else by task id. */
  const soldierInWorld = (e: Enemy): boolean => {
    if (e.outOfWorld) return false;
    const byNode = (ctx.systems.tasks as { inWorldNode?: (node: number) => boolean } | null)?.inWorldNode;
    return e.node !== undefined && e.node >= 0 && byNode ? byNode.call(ctx.systems.tasks, e.node) : inWorld(e.taskId);
  };
  const rngFloat = () => (world ? world.rng.float() : Math.random());
  const playerTeam = (): number => {
    const t = ctx.level?.tasks.find((x) => x.type === "HumanPlayer");
    const v = t?.params["Team"];
    return typeof v === "number" ? v : 0;
  };

  // --- The player as an AI object (key 0) ---------------------------------
  const playerHuman: AiHuman = {
    key: PLAYER_KEY,
    get team() {
      return playerTeam();
    },
    isPlayer: true,
    dead: () => !ctx.player.alive,
    feet: () => toIgi(ctx.player.position),
    origin: () => {
      const p = ctx.player;
      const f = toIgi(p.position);
      // eyeHeight = pelvis + 0.69 m standing / 0.35 m crouched (player.ts).
      f[2] += (p.eyeHeight - (p.crouching ? 1433.6 : 2826.24) / UNITS) * UNITS;
      return f;
    },
    crouched: () => ctx.player.crouching,
    // FUN_0045eaa0's in-world flag (+0xcf6): out of the world (the intro's container) the player is not tracked.
    // Cheat Invisible To Enemies: the soldiers' perception (FUN_00487920 slots) skips the player.
    present: () => inWorld(playerInfo().taskId) && ctx.cheats?.invisible !== true,
  };

  // --- Hooks for the AI core ----------------------------------------------
  /** SoldierRuntime.vehicleBody of a soldier attached to an object that never moves (no body). */
  const STATIC_ATTACH = -2;
  /** Attaching parents that move: their body must be in the world before the attach. */
  const MOVING_GRAPH_PARENTS: ReadonlySet<string> = new Set(["Train", "Car", "Heli", "Plane", "Elevator", "StationaryGun"]);
  /**
   * The rider's vehicle body (see SoldierRuntime.vehicleBody), null when the soldier rides nothing,
   * undefined while its vehicle's body is not in the world yet (FUN_00460fd0 retries every tick).
   */
  const riderBody = (rt: SoldierRuntime): number | null | undefined => {
    const tasks = (ctx.systems.tasks as unknown as { runtime?: { tasks: { nodes: Array<{ type: string; parent: number; task: { id: number } }> } } | null } | null)?.runtime?.tasks;
    const graphId = rt.level.graphId;
    if (!tasks || graphId === null || !ctx.world) return null;
    const graph = tasks.nodes.find((n) => n.type === "AIGraph" && n.task.id === graphId);
    if (!graph || graph.parent < 0) return null;
    // FUN_00460fd0: the graph is attached (its parent's class derives from RigidDynCubeObj,
    // FUN_004efc80) -> FUN_00461f50 attaches the soldier to that parent object.
    const parentType = tasks.nodes[graph.parent]?.type ?? "";
    if (!GRAPH_ATTACHING_TYPES.has(parentType)) return null;
    if (ctx.world.bodyMatrix(graph.parent)) return graph.parent;
    // A moving parent (vehicle, elevator) whose body is not in the world yet: retry next tick. A
    // static object (Building, EditRigidObj outside a container) never moves: the soldier keeps
    // its frame, i.e. the world (STATIC_ATTACH).
    return MOVING_GRAPH_PARENTS.has(parentType) ? undefined : STATIC_ATTACH;
  };

  /** Per soldier AI: the door of its current door leg (FUN_00450310 +0x3e44), found once per leg. */
  const legDoors = new Map<HumanAi, number | null>();
  type DoorRuntime = {
    tasks: { doors: Array<{ nodeIndex: number; start: readonly number[] }>; nodes: Array<{ parent: number; type: string }> };
    doorStateAt(node: number): { isOpen: boolean; isClosed: boolean; wantOpen: boolean } | undefined;
    nodeState(i: number): Readonly<Record<string, unknown>>;
  };
  const doorRuntime = (): DoorRuntime | null => (ctx.systems.tasks as unknown as { runtime?: DoorRuntime | null } | null)?.runtime ?? null;
  const nodeInWorld = (rt: DoorRuntime, index: number): boolean => {
    for (let n = rt.tasks.nodes[index]?.parent ?? -1; n >= 0; n = rt.tasks.nodes[n].parent) {
      if (rt.tasks.nodes[n].type === "ConditionalContainer" && rt.nodeState(n).inWorld === 0) return false;
    }
    return true;
  };

  /** Per level: the HumanPlayer task id and the player's sight sphere radius (HSEM +120 of its Model, metres). */
  let playerCache: { level: unknown; taskId: number; radius: number } | null = null;
  function playerInfo(): { taskId: number; radius: number } {
    const level = ctx.level;
    if (!level) return { taskId: 0, radius: Infinity };
    if (playerCache?.level !== level) {
      const data = level.player.model ? level.boneModels.get(level.player.model) : undefined;
      let radius = Infinity;
      try {
        if (data) radius = readMefBounds(data.buffer).originRadius / UNITS;
      } catch {
        // no HSEM bounds: no sphere pre-test
      }
      playerCache = { level, taskId: level.tasks.find((x) => x.type === "HumanPlayer")?.id ?? 0, radius };
    }
    return playerCache;
  }

  /**
   * The humans' part of a sight ray (FUN_004c4630 message 8, FUN_00487f40's filter 0x53f120 ->
   * 0x441c30) [recovered]: every human in the world (task in-world flag +0xcf6; alive or dead,
   * a body stays in the world) except the `skip` keys (looker, target) answers through
   * FUN_0045e490: its HSEM sphere around the pelvis, then every set-0 face of its posed bone model
   * the segment crosses (all level-1 human faces are Flesh / BloodyFlesh / NormalMetal / Runway,
   * see-through 0, so any face stops the ray). Engine coordinates; the faces' {material, front}.
   * The player's body answers through player.bodyHit (its nearest face: exact while every face
   * has see-through 0).
   */
  function humanSightHits(from: Vec3, to: Vec3, skip: readonly number[]): Array<{ material: number; front: boolean }> {
    const out: Array<{ material: number; front: boolean }> = [];
    for (const rt of soldiers) {
      if (!rt.present || skip.includes(rt.enemy.id)) continue;
      for (const h of rt.body.sightHits(from, to)) out.push({ material: h.material, front: h.front });
    }
    const player = playerInfo();
    if (!skip.includes(PLAYER_KEY) && inWorld(player.taskId)) {
      const p = ctx.player;
      // The pelvis (human +0x20): the eye is 0.69 m above it standing, 0.35 m crouched.
      const cy = p.position[1] + p.eyeHeight - (p.crouching ? 1433.6 : 2826.24) / UNITS;
      const r = player.radius;
      if (segmentNearSphere(from[0] - p.position[0], from[1] - cy, from[2] - p.position[2], to[0] - p.position[0], to[1] - cy, to[2] - p.position[2], r)) {
        const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
        const len = Math.hypot(dx, dy, dz);
        const hit = len > 0 ? ctx.systems.player?.bodyHit(from, [dx / len, dy / len, dz / len], len) : null;
        if (hit) out.push({ material: hit.material, front: true });
      }
    }
    return out;
  }

  const hooks: AiHooks = {
    /**
     * FUN_00450310 on a door leg [recovered]: once per leg the nearest door of
     * the use list to the leg point (FUN_00445240: no radius); each tick its
     * state FUN_00446be0 (0 open, 1 closed, 2 moving with the open request,
     * 3 moving without): 1 or 3 -> FUN_00446c10 toggles the request; the
     * walker goes on only when the door is open (or there is none).
     */
    doorOpen(ai, point) {
      const rt = doorRuntime();
      if (!rt) return true;
      let node = legDoors.get(ai);
      if (node === undefined) {
        let best: number | null = null;
        let bestD = -1;
        for (const d of rt.tasks.doors) {
          if (!nodeInWorld(rt, d.nodeIndex)) continue;
          const dist = Math.hypot(d.start[0] - point[0], d.start[1] - point[1], d.start[2] - point[2]);
          if (bestD < 0 || dist < bestD) {
            bestD = dist;
            best = d.nodeIndex;
          }
        }
        node = best;
        legDoors.set(ai, node);
      }
      if (node === null) return true;
      const st = rt.doorStateAt(node);
      if (!st) return true;
      const code = st.isOpen ? 0 : st.isClosed ? 1 : st.wantOpen ? 2 : 3;
      if (code === 0) return true;
      if (code === 1 || code === 3) st.wantOpen = !st.wantOpen;
      return false;
    },
    doorLegDone(ai) {
      legDoors.delete(ai);
    },
    lineOfSight(a, b, skip) {
      const w = ctx.world;
      if (!w) return true;
      const ea = toEngine(a);
      const eb = toEngine(b);
      const dx = eb[0] - ea[0];
      const dy = eb[1] - ea[1];
      const dz = eb[2] - ea[2];
      const d = Math.hypot(dx, dy, dz);
      if (d < 1e-6) return true;
      // FUN_00487f40 (docs/collision.md): the transmission starts at 1 and is
      // multiplied by each front-face hit's QMaterial see-through value; the
      // target is visible when nothing is hit or the transmission is >= 0.79.
      // Every set-0 face along the ray except Glass (sight filter 0x53f120), plus terrain.
      const hits: Array<{ material: number; front: boolean; terrain?: boolean }> = w
        .raycastAll(ea[0], ea[1], ea[2], dx / d, dy / d, dz / d, d, TRI_SIGHT)
        .map((h) => ({ material: h.material < 0 ? NO_MATERIAL : h.material, front: h.front, terrain: h.terrain }));
      // Perception rays also meet every other human (filter 0x441c30 skips only the looker and the target).
      if (skip) hits.push(...humanSightHits(ea, eb, [skip.self, skip.target]));
      const table = seeThrough ?? ctx.level?.surfaceMaterials.map((m) => m.seeThrough) ?? [];
      return aiSightPasses(sightTransmission(hits, (m) => table[m] ?? 0));
    },
    perceptionPhase: (aiTaskId) => ctx.systems.tasks?.perceptionPhase?.(aiTaskId),
    stationaryGun: (id) => aiStationaryGun(id),
    taskMember: (name) => ctx.systems.tasks?.member(name),
    taskPosition(id) {
      const t = aiData?.taskById.get(id);
      const p = t?.params["Position"];
      return Array.isArray(p) && p.length === 3 ? [Number(p[0]), Number(p[1]), Number(p[2])] : null;
    },
    detected(ai) {
      const rt = byId.get(ai.key);
      if (rt) ctx.events.emit(GameEvent.Detected, { enemyId: rt.enemy.id, position: [...rt.enemy.position] });
    },
    log(message) {
      console.info(`[ai] ${message}`);
    },
  };

  // --- Assets / spawning ----------------------------------------------------
  function assetsFor(): SoldierAssets | null {
    const level = ctx.level;
    if (!level) return null;
    if (!assets || assets.level !== level) {
      assets?.dispose();
      assets = new SoldierAssets(level);
    }
    return assets;
  }

  function gunsOf(taskId: number): { primary: LevelWeapon | null; grenade: LevelWeapon | null } {
    const level = ctx.level!;
    const task = level.tasks.find((t) => t.id === taskId && isSoldierTaskType(t.type));
    let primary: LevelWeapon | null = null;
    let grenade: LevelWeapon | null = null;
    for (const c of task?.children ?? ([] as IgiTask[])) {
      if (!c.type.startsWith("Gun")) continue;
      const id = Object.values(c.params).find((v): v is string => typeof v === "string" && v.startsWith("WEAPON_ID_"));
      const w = id ? level.weapons.get(id) : undefined;
      if (!w) continue;
      if (w.weaponType === "WEAPONTYPE_GRENADE") grenade ??= w;
      else if (!primary && (w.weaponType === "WEAPONTYPE_GUN" || w.weaponType === "WEAPONTYPE_PISTOL" || w.weaponType === "WEAPONTYPE_SHOTGUN")) primary = w;
    }
    return { primary, grenade };
  }

  const gunSpec = (w: LevelWeapon | null): GunSpec | null =>
    w
      ? {
          weaponId: w.scriptId,
          roundsPerClip: Math.max(1, w.roundsPerClip),
          maxRoundsPerBurst: w.maxRoundsPerBurst,
          roundsPerMinute: w.roundsPerMinute,
          grenade: w.weaponType === "WEAPONTYPE_GRENADE",
          shotgun: w.weaponType === "WEAPONTYPE_SHOTGUN",
          kick: { kickFixedXDeg: w.recoilPitch, kickRandomXDeg: w.recoilPitchRandom, kickFixedZDeg: w.recoilYaw, kickRandomZDeg: w.recoilYawRandom },
        }
      : null;

  function spawn(soldier: LevelSoldier): SoldierRuntime | null {
    const shared = assetsFor();
    const w = ctx.world;
    if (!shared || !w) return null;
    const id = nextId++;
    const { primary, grenade } = gunsOf(soldier.taskId);
    const body = new SoldierBody(shared, soldier, id, primary?.scriptId ?? null);
    const [x, y, z] = soldier.position;
    const ground = w.raycast(x, y + 1.5, z, 0, -1, 0, 30, TRI_SOLID);
    const position: Vec3 = [x, ground ? ground.point[1] : y, z];
    const enemy: Enemy = {
      id,
      taskId: soldier.taskId,
      node: soldier.taskIndex,
      position,
      velocity: [0, 0, 0],
      yaw: soldier.yaw,
      // Soldier health = settings.qvm "Damage scale" at the configured difficulty (FUN_00407080).
      health: soldier.combat?.damageScale ?? 1,
      alive: true,
      state: "idle",
      aiType: soldier.aiType ?? "",
      weapon: primary,
      object: body.object,
    };
    const rt = {} as SoldierRuntime;
    const motor = new SoldierMotor(body.animator, soldier.yaw, soldier.standAnimation, gunSpec(primary), gunSpec(grenade), {
      shot: () => fireBullets(rt),
      fireStopped: () => {
        if (rt.weapon) ctx.events.emit(GameEvent.FireStopped, { weaponId: rt.weapon.scriptId, shooter: id, position: muzzleOf(rt) });
      },
      grenadeRelease: () => throwGrenade(rt),
      closeCombatStrike: () => strike(rt),
      trigger: (trigger, quiet) => animTrigger(rt, trigger, quiet),
      // FUN_00451700: the HumanAI holds a target record.
      hasTarget: () => Boolean(rt.ai?.target),
      // HumanAI SetDeathAnimation (H+0x3acc), read when the standing death starts.
      deathAnimation: () => rt.ai?.deathAnimation ?? -1,
      died: (info) => (rt.deathSlide = deathSlideFor(rt, info.clip, info.matrixYaw)),
      fell: () => {
        // FUN_0045ac20: the fall keeps the last movement as its air velocity.
        rt.mv.air = [rt.lastMove[0], rt.mv.air[1], rt.lastMove[2]];
      },
      use: (taskId) => mountGun(rt, taskId),
      gunReleased: () => releaseGun(rt),
    }, (n) => (world ? world.rng.int(n) : Math.floor(Math.random() * n)), {
      aiType: soldier.aiType,
      randFloat: rngFloat,
      // combat: HumanSoldierFemale / HumanSoldierRPG graphs; an AITYPE_EKK female moves x DefineHumanPlayerGeneral arg 0 (FUN_004550b0).
      cls: SOLDIER_CLASS_OF_TYPE[soldier.taskType ?? "HumanSoldier"] ?? "soldier",
      rootScale: soldier.taskType === "HumanSoldierFemale" && soldier.aiType === "AITYPE_EKK" ? Math.fround(ctx.level?.humanPlayer?.rawGeneral?.[0] ?? 1.75) : 1,
    });
    const human: AiHuman = {
      key: id,
      team: soldier.team,
      isPlayer: false,
      dead: () => !enemy.alive,
      feet: () => toIgi(enemy.position),
      origin: () => {
        const f = toIgi(enemy.position);
        f[2] += motor.rootZ;
        return f;
      },
      // FUN_00450150 / FUN_00464490 read the low-profile flag human+0x33d.
      crouched: () => motor.crouched,
      present: () => rt.present,
    };
    Object.assign(rt, {
      enemy, level: soldier, team: soldier.team, body, motor, human, ai: null, weapon: primary, grenade,
      grounded: Boolean(ground), mv: createHumanMoveState([position[0], position[1] + motor.rootZ / UNITS, position[2]]),
      // Without ground under the placed point a soldier is held, unless its graph places it (FUN_00460fd0).
      held: !ground && soldier.graphId === null, present: true, shadow: ctx.systems.effects?.createBlobShadow() ?? null,
      flash: primary && ctx.level ? createMuzzleFlash(ctx.level, primary.scriptId) : null, lastPose: -1,
      roof: false, lastHit: null, deathSlide: null, lastMove: [0, 0, 0],
    } satisfies SoldierRuntime);
    if (rt.flash) body.attachToGun(rt.flash.object);
    ctx.scene.add(body.object);
    ctx.enemies.push(enemy);
    soldiers.push(rt);
    byId.set(id, rt);
    body.useLods();
    body.pose(enemy.position, enemy.yaw);
    return rt;
  }

  function clearAll(): void {
    for (const rt of soldiers) {
      ctx.scene.remove(rt.body.object);
      rt.shadow?.dispose();
      rt.flash?.dispose?.();
      rt.ai?.clear();
    }
    soldiers = [];
    byId.clear();
    ctx.enemies.length = 0;
    world = null;
    grenades.clear();
  }

  function buildAi(): void {
    if (!aiData || aiData.level !== ctx.level || world) return;
    world = new AiWorld(aiData, hooks, ctx.rng); // the one level RNG (+0x2c)
    world.tick = ctx.tick;
    world.appTick = ctx.appTick ?? ctx.tick;
    // The detectable registry DAT_005c4a00 in create (task-tree) order: the player at its node
    // among the soldiers (FUN_00487b70 walks it in this order; new slots go to the list tail).
    const playerNode = ctx.level?.tasks.findIndex((t) => t.type === "HumanPlayer") ?? -1;
    const nodeOf = new Map<number, number>();
    ctx.level?.tasks.forEach((t, i) => {
      if (isSoldierTaskType(t.type) && !nodeOf.has(t.id)) nodeOf.set(t.id, i);
    });
    let playerAdded = false;
    for (const rt of soldiers) {
      if (!playerAdded && playerNode >= 0 && (rt.level.taskIndex ?? nodeOf.get(rt.enemy.taskId) ?? -1) > playerNode) {
        world.addHuman(playerHuman);
        playerAdded = true;
      }
      world.addHuman(rt.human);
    }
    if (!playerAdded) world.addHuman(playerHuman);
    for (const rt of soldiers) createAi(rt, world);
    stats.activeAi = world.soldiers.filter((s) => s.active).length;
    stats.aiLoaded = true;
    for (const w of aiData.warnings) console.info(`[ai] ${w}`);
  }

  /** The soldier's HumanAI (its compile, FUN_0044f3a0): AI init sets the corpse countdown H+0x3e10 = 300 (0x44f25a). */
  function createAi(rt: SoldierRuntime, w: AiWorld): void {
    const l = rt.level;
    const ai = new HumanAi(w, rt.human, rt.motor, { taskId: l.taskId, aiTaskId: l.aiTaskId, aiType: l.aiType, graphId: l.graphId, team: l.team });
    rt.ai = ai;
    // FUN_00407080 copies settings.qvm "Recoil threshold" to human+0xd04 (the flinch threshold).
    if (ai.extra) rt.motor.recoilThreshold = ai.extra.recoilThreshold;
    rt.corpseCount = AI_DEATH_COUNTDOWN_TICKS;
    w.soldiers.push(ai);
  }

  // --- GuardGenerator templates (loaders/objects/guard-generator.ts) -------------------------
  /** HumanSoldier nodes inside a GuardGenerator: FUN_00488220 deletes them at the generator's compile. */
  let templateLevel: unknown = null;
  let templateNodes = new Set<number>();
  function isTemplate(soldier: LevelSoldier): boolean {
    const level = ctx.level;
    if (!level) return false;
    if (templateLevel !== level) {
      templateLevel = level;
      const index = new Map<IgiTask, number>();
      level.tasks.forEach((t, i) => index.set(t, i));
      const parent = new Array<number>(level.tasks.length).fill(-1);
      level.tasks.forEach((t, i) => {
        for (const c of t.children) parent[index.get(c) ?? -1] = i;
      });
      templateNodes = new Set<number>();
      level.tasks.forEach((t, i) => {
        if (!isSoldierTaskType(t.type)) return;
        for (let p = parent[i]; p >= 0; p = parent[p]) {
          if (level.tasks[p].type === "GuardGenerator") {
            templateNodes.add(i);
            break;
          }
        }
      });
    }
    const node = soldier.taskIndex ?? -1;
    return templateNodes.has(node);
  }

  /** The runtime of the soldier spawned for template node `node`. */
  const generatedAt = (node: number): SoldierRuntime | undefined => soldiers.find((rt) => rt.generated && rt.level.taskIndex === node);

  function spawnGenerated(node: number): Enemy | null {
    const soldier = ctx.level?.soldiers.find((s) => s.taskIndex === node);
    if (!soldier || !isTemplate(soldier)) return null;
    // FUN_00488000 -> the template's compile: the HumanAI takes the next perception phase.
    if (soldier.aiTaskIndex !== null && soldier.aiTaskIndex !== undefined) ctx.systems.tasks?.takePerceptionPhase?.(soldier.aiTaskIndex);
    const rt = spawn(soldier);
    if (!rt) return null;
    rt.generated = true;
    // Node order for the fallback walk; the registry gets the new human at its tail (FUN_0045d850).
    soldiers.sort((a, b) => (a.level.taskIndex ?? 0) - (b.level.taskIndex ?? 0));
    if (world) {
      world.addHuman(rt.human);
      createAi(rt, world);
      stats.activeAi = world.soldiers.filter((x) => x.active).length;
    }
    bySoldierNode.set(node, rt);
    if (soldier.aiTaskIndex !== null && soldier.aiTaskIndex !== undefined) byAiNode.set(soldier.aiTaskIndex, rt);
    stats.soldiers = soldiers.length;
    return rt.enemy;
  }

  function removeGenerated(node: number): void {
    const rt = generatedAt(node);
    if (!rt) return;
    ctx.scene.remove(rt.body.object);
    rt.shadow?.dispose();
    rt.flash?.dispose?.();
    if (rt.ai) {
      rt.ai.clear();
      if (rt.ai.target) {
        world?.releaseTarget(rt.ai.target, rt.ai);
        rt.ai.target = null;
      }
      if (world) {
        const i = world.soldiers.indexOf(rt.ai);
        if (i >= 0) world.soldiers.splice(i, 1);
        for (const t of world.targets) t.attackers.delete(rt.ai);
      }
    }
    world?.humans.delete(rt.human.key);
    soldiers = soldiers.filter((x) => x !== rt);
    byId.delete(rt.enemy.id);
    const e = ctx.enemies.indexOf(rt.enemy);
    if (e >= 0) ctx.enemies.splice(e, 1);
    if (bySoldierNode.get(node) === rt) bySoldierNode.delete(node);
    const aiNode = rt.level.aiTaskIndex;
    if (aiNode !== null && aiNode !== undefined && byAiNode.get(aiNode) === rt) byAiNode.delete(aiNode);
    stats.soldiers = soldiers.length;
  }

  /**
   * HumanAI update 0x44fa8f-0x44fb7f [recovered]: a dead soldier in the world whose death clip
   * finished (+0x33c): AI cleanup, then the countdown H+0x3e10 (300) runs down one per tick; once
   * negative the body leaves the world (method 0x548177) when its parent is a GuardGenerator
   * (FUN_00488610), else when it was never drawn (+0x7c4 = -1) or not drawn for more than one tick
   * (+0x7c4 is stamped in the draw path 0x45f2bf when FUN_004d06c0, the camera-frame view test,
   * passes; port: the body's LOD choice was >= 0 in the previous tick's pose).
   */
  function corpseTick(rt: SoldierRuntime): void {
    const e = rt.enemy;
    if (!rt.ai || e.alive || e.outOfWorld || !rt.motor.deathFinished) return;
    const count = rt.corpseCount ?? AI_DEATH_COUNTDOWN_TICKS;
    if (count >= 0) {
      rt.corpseCount = count - 1;
      return;
    }
    const now = ctx.appTick ?? ctx.tick;
    const stamp = rt.drawStamp ?? -1;
    if (!rt.generated && stamp !== -1 && now - stamp <= 1) return;
    e.outOfWorld = true;
    rt.present = false;
    rt.body.object.visible = false;
    rt.shadow?.setVisible(false);
  }

  function ensureData(): void {
    const level = ctx.level;
    if (!level || (aiData && aiData.level === level) || loadingFor === level) return;
    loadingFor = level;
    if (!seeThrough) {
      source.readBinary("material/material.qvm")
        .then((buffer) => (seeThrough = readSurfaceMaterials(buffer).map((m) => m.seeThrough)))
        .catch(() => (seeThrough = null));
    }
    loadAiLevelData(source, level)
      .then((data) => {
        if (ctx.level !== level) return;
        aiData = data;
        buildAi();
      })
      .catch((error) => console.error("[ai] AI data failed to load:", error));
  }

  function reset(): void {
    clearAll();
    legDoors.clear();
    stats.aiLoaded = false;
    // Soldiers update in MissionTasks node order (each HumanSoldier node, then its HumanAI node).
    // GuardGenerator children are templates (FUN_00488220): the generator spawns them.
    for (const soldier of soldiersInNodeOrder()) if (!isTemplate(soldier)) spawn(soldier);
    stats.soldiers = soldiers.length;
    ensureData();
    buildAi();
    const level = ctx.level;
    assets?.loadLods(source).then(() => {
      if (ctx.level !== level) return;
      for (const rt of soldiers) rt.body.useLods();
    });
  }

  function soldiersInNodeOrder(): LevelSoldier[] {
    const level = ctx.level;
    if (!level) return [];
    const node = new Map<number, number>();
    level.tasks.forEach((t, i) => {
      if (isSoldierTaskType(t.type) && !node.has(t.id)) node.set(t.id, i);
    });
    return level.soldiers
      .map((s, i) => ({ s, i, n: s.taskIndex ?? node.get(s.taskId) ?? Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => a.n - b.n || a.i - b.i)
      .map((x) => x.s);
  }

  // --- Firing ---------------------------------------------------------------
  function muzzleOf(rt: SoldierRuntime): Vec3 {
    if (rt.body.hasPose) return rt.body.muzzle();
    const p = rt.enemy.position;
    return [p[0], p[1] + rt.motor.rootZ / UNITS + 0.6, p[2]];
  }

  function fireBullets(rt: SoldierRuntime): void {
    const w = rt.weapon;
    if (!w) return;
    const muzzle = muzzleOf(rt);
    ctx.events.emit(GameEvent.Fire, { weaponId: w.scriptId, shooter: rt.enemy.id, position: muzzle });
    rt.flash?.fire();
    const range = (w.aiDetection ?? "").includes("SILENCED") ? AI_GUNSHOT_SILENCED_RANGE : AI_GUNSHOT_RANGE;
    world?.broadcast({ type: EV.GUNSHOT, team: rt.team, flags: 0x46, range, position: toIgi(muzzle), source: rt.enemy.id, other: rt.enemy.id });

    // Direction: toward the AI's aim point, else along the view.
    let aim: Vec3;
    if (rt.ai?.aimPoint) aim = toEngine(rt.ai.aimPoint);
    else {
      const y = rt.motor.yaw;
      const p = rt.motor.pitch;
      aim = [muzzle[0] - Math.sin(y) * Math.cos(p) * 100, muzzle[1] + Math.sin(p) * 100, muzzle[2] - Math.cos(y) * Math.cos(p) * 100];
    }
    const base = new THREE.Vector3(aim[0] - muzzle[0], aim[1] - muzzle[1], aim[2] - muzzle[2]).normalize();
    const baseV: Vec3 = [base.x, base.y, base.z];
    // The gun fire shared with the player (FUN_004772c0, combat/pellet.ts): the level RNG, four draws per
    // pellet and none while the spread is 0.
    // combat: a TASKTYPE_MISSILE gun (the RPG guard's RPG18) launches a rocket from the muzzle along the aim (FUN_004298a0).
    const missile = projectileSystemOf(ctx).missileModelOf(w.scriptId);
    if (missile) {
      projectileSystemOf(ctx).spawnMissile({
        position: toIgi(muzzle), direction: [baseV[0], -baseV[2], baseV[1]], muzzleVelocity: w.muzzleVelocity, model: missile,
        owner: rt.enemy.id, sourceWeaponId: w.weaponNumber,
      });
      return;
    }
    const spread = spreadRadians(spreadForShot(w.minSpread, w.maxSpread, Math.max(0, rt.motor.burstCount - 1)));
    const maxRange = Math.max(1, w.rangeMetres);
    const pellets = Math.max(1, w.bulletsPerRound);
    for (let k = 0; k < pellets; k++) {
      let dir = baseV;
      if (spread !== 0) {
        const { angle, azimuth } = drawPellet(spread, rngFloat);
        dir = pelletDirection(baseV, angle, azimuth);
      }
      traceAiBullet(rt, muzzle, dir, maxRange, w);
    }
  }

  function traceAiBullet(rt: SoldierRuntime, from: Vec3, d: Vec3, range: number, w: LevelWeapon): void {
    traceShot({ self: rt, team: rt.team, hitProbability: rt.motor.hitProbability, id: rt.enemy.id }, from, d, range, w);
  }

  /**
   * One AI bullet (FUN_00479e30 with the shooter's team filter and the player's hit-probability roll,
   * FUN_0045d100). `src.self` is skipped (a soldier's own body); combat: a turret passes none.
   */
  function traceShot(src: { self: SoldierRuntime | null; team: number; hitProbability: number; id: number }, from: Vec3, d: Vec3, range: number, w: LevelWeapon): void {
    const p = ctx.player;
    const playerTarget = p.alive && playerTeam() !== src.team;
    let playerHit = false;
    const PLAYER = "player";
    // One ray with ricochet and penetration (combat/bullet.ts, FUN_00479e30).
    const result = traceBullet({
      world: ctx.world,
      from,
      dir: d,
      range,
      penetration: w.penetration,
      materials: ctx.level?.surfaceMaterials ?? [],
      random: rngFloat,
      human(o, dir, max, exclude) {
        let best: { distance: number; point: Vec3; key: unknown; material?: number; apply(): void } | null = null;
        if (playerTarget && !exclude.has(PLAYER)) {
          // FUN_0045d100: a bullet reaching the player's hitbox collides only if rand <= p.
          const height = p.crouching ? PLAYER_HITBOX.crouched : PLAYER_HITBOX.standing;
          const t = rayCapsule(o, dir, max, p.position, height, PLAYER_HITBOX.radius);
          if (t !== null && aiBulletMayHitPlayer(rngFloat(), src.hitProbability)) {
            // The filter passed: test the player's posed body (bone model set 0) and use the
            // player's zone multiplier; without the body model, the capsule hit counts as torso.
            const body = ctx.systems.player?.bodyHit(o, dir, max);
            if (body !== null) {
              const distance = body ? body.distance : t;
              const multiplier = body ? body.multiplier : 1;
              const point: Vec3 = body ? body.point : [o[0] + dir[0] * t, o[1] + dir[1] * t, o[2] + dir[2] * t];
              best = {
                distance,
                point,
                key: PLAYER,
                material: body?.material,
                apply() {
                  playerHit = true;
                  // Blood (FUN_0045e5b0 -> FUN_00462710) runs before the damage.
                  ctx.systems.effects?.humanHit({ key: PLAYER, point, direction: d });
                  const amount = playerBulletDamage(w.damageFactor, multiplier, difficultyKey());
                  // The hit zone (+0x2e8) picks the death clip; the capsule-only hit counts as torso (12).
                  // FUN_004123e0: the damage first; the hit speech only when the player survived it.
                  ctx.systems.player?.damage(amount, d, body ? body.zone : 12);
                  ctx.events.emit(GameEvent.PlayerHit, { amount, from, dead: !ctx.player.alive });
                },
              };
            }
          }
        }
        // Humans of other teams (soldiers' bullets never hit their own team).
        raycaster.set(new THREE.Vector3(...o), new THREE.Vector3(...dir));
        raycaster.near = 0;
        raycaster.far = best ? best.distance : max;
        for (const other of soldiers) {
          if (other === src.self || other.team === src.team || !other.enemy.alive || !other.present || exclude.has(other)) continue;
          const h = other.body.hitTest(raycaster);
          if (!h || (best && h.distance >= best.distance)) continue;
          const point: Vec3 = [o[0] + dir[0] * h.distance, o[1] + dir[1] * h.distance, o[2] + dir[2] * h.distance];
          best = {
            distance: h.distance,
            point,
            key: other,
            material: h.material,
            apply: () => {
              ctx.systems.effects?.humanHit({ key: other, point, direction: d });
              damageSoldier(other, w.damageFactor * zoneMultiplier(other, h.zone, h.zoneMultiplier), from, src.id, src.team, false, {
                zone: h.zone,
                dir,
                shotgun: w.weaponType === "WEAPONTYPE_SHOTGUN",
              });
            },
          };
        }
        return best;
      },
      object: (h) => void damageSystemOf(ctx)?.bulletHit(h, w.damageFactor),
      onImpact: (i) =>
        ctx.events.emit(GameEvent.Impact, { point: i.point, normal: i.normal, material: i.material, shooter: src.id, ricochet: i.ricochet, human: i.human }),
    });
    // Tracers, bullet holes, fragments, dust: the FUN_00479e30 tail (fx/effects.ts bullet()).
    ctx.systems.effects?.bullet({
      shooter: src.id,
      weaponId: w.scriptId,
      calibreId: w.calibreId,
      rangeMetres: range,
      hits: result.hits,
      segments: result.segments,
      ricocheted: result.ricocheted,
    });
    const limit = Math.hypot(result.end[0] - from[0], result.end[1] - from[1], result.end[2] - from[2]);
    if (playerTarget && !playerHit) {
      const height = p.crouching ? PLAYER_HITBOX.crouched : PLAYER_HITBOX.standing;
      const centre: Vec3 = [p.position[0], p.position[1] + height * 0.6, p.position[2]];
      const c = closestOnSegment(from, d, limit, centre);
      if (Math.hypot(c[0] - centre[0], c[1] - centre[1], c[2] - centre[2]) <= NEAR_MISS_METRES) {
        ctx.events.emit(GameEvent.NearMiss, { point: c });
      }
    }
    // GUNSHOTMISS to soldiers of another team than the shooter near the path.
    for (const other of soldiers) {
      if (other === src.self || other.team === src.team || !other.enemy.alive || !other.present) continue;
      other.ai?.post(gunshotMiss(closestOnSegment(from, d, limit, other.enemy.position), src.team, src.id));
    }
  }

  function gunshotMiss(pointEngine: Vec3, team: number, shooter: number): AiEvent {
    return { type: EV.GUNSHOTMISS, team, flags: 0x46, range: 8192, position: toIgi(pointEngine), source: shooter, other: shooter };
  }

  function zoneMultiplier(rt: SoldierRuntime, zone: number, multiplier: number): number {
    const head = zone === HIT_ZONE.HEAD || zone === HIT_ZONE.HEAD_FRONT;
    return head && rt.ai?.headshotProof ? 1 : multiplier;
  }

  // --- Grenades / close combat ------------------------------------------------
  /**
   * HumanSoldier state 8 (FUN_0045a170) on event 11 with a target record:
   * fly = f32(r x random + min) seconds, cooked = fistp(r x random x 30 +
   * min) (the explode minimum is added unscaled, as the exe does), the
   * FUN_00451740 velocity to the target's aim point (FUN_00450150), then
   * FUN_00475760 with the grenade's weaponconfig (FUN_00413b70).
   */
  function throwGrenade(rt: SoldierRuntime): void {
    const g = rt.grenade;
    const ai = rt.ai;
    const t = ai?.target;
    if (!g || !ai || !t) return;
    const fly = ai.extra?.grenadeFlySeconds ?? [0.5, 0.5];
    const boom = ai.extra?.grenadeExplodeSeconds ?? [0.3, 0.7];
    const flySeconds = x87StoreF32(rngFloat() * Math.fround(fly[1]) + Math.fround(fly[0]));
    const cooked = Math.trunc(rngFloat() * Math.fround(boom[1]) * 30 + Math.fround(boom[0]));
    // Release point: the hand (gun bone 22) [inferred; the exe reads [human +0x70] +0x858].
    const hand: Vec3 = rt.body.hasPose ? rt.body.gunPosition() : [rt.enemy.position[0], rt.enemy.position[1] + rt.motor.rootZ / UNITS, rt.enemy.position[2]];
    const from = toIgi(hand);
    const target = aimPointOf(t.lastKnown, world?.humans.get(t.key)?.crouched() ?? false);
    // Initial orientation: the body heading [inferred; the exe builds it from the AI frame, FUN_00451740].
    const c = Math.cos(rt.motor.yaw);
    const s = Math.sin(rt.motor.yaw);
    grenades.spawn({
      weaponId: g.scriptId,
      model: g.gunModel ?? "",
      position: from,
      matrix: [c, -s, 0, s, c, 0, 0, 0, 1],
      velocity: soldierThrowVelocity(from, target, flySeconds),
      cooked,
      tags: grenades.tagsOf(g.scriptId),
      thrower: rt.enemy.id,
    });
  }

  // --- StationaryGun users (combat/stationary-guns.ts) ------------------------------------
  /**
   * FUN_00459d50 for a StationaryGun (use kind 6) -> state 36 enter FUN_0045c8b0 [recovered]: the use
   * point P and object matrix M (FUN_00444b30), x / y = P + col1(M) x 0.7 m (no flip test), own z,
   * heading gamma(M) + pi, clip 31 (the motor), attached to the gun (FUN_00463310); the use start
   * (FUN_00474ee0) makes the soldier the gun's user.
   */
  function mountGun(rt: SoldierRuntime, taskId: number): number {
    const guns = stationaryGunsOf(ctx);
    const gun = guns?.byId(taskId);
    if (!guns || !gun) return 0;
    const m = guns.mountSoldier(gun.node, rt.enemy.id, rt.human.origin());
    if (!m) return 0;
    const o = origin();
    const rootHeight = rt.motor.rootZ / UNITS;
    const x = (m.x - o[0]) / UNITS;
    const z = -(m.y - o[1]) / UNITS;
    rt.enemy.position = [x, rt.enemy.position[1], z];
    rt.mv.position = [x, rt.enemy.position[1] + rootHeight, z];
    rt.motor.yaw = m.heading;
    rt.motor.bodyYaw = m.heading + rt.motor.kickYaw;
    rt.enemy.yaw = m.heading;
    rt.mv.attach = null;
    rt.vehicleBody = gun.node;
    rt.riderPlaced = true;
    rt.motor.attachedToGun = true;
    return 6;
  }

  /** 0x45c9b0's exit: FUN_00475340 (release) and the detach (FUN_00463550). */
  function releaseGun(rt: SoldierRuntime): void {
    const guns = stationaryGunsOf(ctx);
    const node = rt.vehicleBody;
    if (guns && typeof node === "number" && guns.byNode(node)) guns.releaseSoldier(node);
    rt.mv.attach = null;
    rt.vehicleBody = undefined;
    rt.riderPlaced = false;
    rt.motor.attachedToGun = false;
  }

  /** AiHooks.stationaryGun: the GUNNER's view of a StationaryGun task. */
  function aiStationaryGun(id: number): AiStationaryGun | null {
    const guns = stationaryGunsOf(ctx);
    const g = guns?.byId(id);
    if (!guns || !g) return null;
    const user = g.user;
    return {
      def: g.def,
      inUse: guns.isInUse(id) === 1,
      userKey: user ? (user.kind === "soldier" ? user.key : PLAYER_KEY) : null,
      pose: () => ({ pivot: [...g.pose.pivot] as V3, gun: g.pose.gun }),
      clipSize: g.weapon ? Math.max(1, g.weapon.roundsPerClip) : 1,
      maxBurst: g.weapon?.maxRoundsPerBurst ?? 1,
      clip: () => g.clip,
    };
  }

  /** FUN_004751f0 of every thrown grenade (Dynamic children: after the humans of the tick). */
  function updateGrenades(): void {
    connectDamageSystem();
    grenades.update();
    // combat: the M203 grenades and RPG rockets (Dynamic children too, combat/projectiles.ts).
    projectileSystemOf(ctx).update();
  }

  // --- Explosions (combat/object-damage.ts, docs/damage.md) ---------------------
  let connected: DamageSystem | null = null;

  /** Hand the damage system the soldiers (explosion targets) and the AI broadcast (EXPLOSION events). */
  function connectDamageSystem(): void {
    const sys = damageSystemOf(ctx);
    if (!sys || sys === connected) return;
    connected = sys;
    sys.setAiEvents((ev) => world?.broadcast({ ...ev }));
    sys.setHumanTargets("soldiers", soldierTargets);
  }

  /** Node (pre-order index) of a soldier task: its place in the damage list. */
  function nodeOfTask(taskId: number): number {
    const tasks = ctx.level?.tasks ?? [];
    for (let i = 0; i < tasks.length; i++) if (tasks[i].id === taskId && isSoldierTaskType(tasks[i].type)) return i;
    return 0;
  }

  /** Every soldier as an explosion target (FUN_004592a0 and its siblings). IGI units. */
  function* soldierTargets(): Iterable<ExplosionHuman> {
    const sys = connected;
    for (const rt of soldiers) {
      if (!rt.enemy.alive) continue;
      const origin = rt.human.origin();
      // View position: the origin + 0.69 m standing / 0.35 m crouched, as the player's (FUN_00464490) [inferred for soldiers].
      const eye: V3 = [origin[0], origin[1], origin[2] + (rt.motor.stance === "stand" ? 2826.24 : 1433.6)];
      yield {
        order: (rt.level.taskIndex ?? nodeOfTask(rt.enemy.taskId)) * 1000,
        active: rt.present,
        origin,
        eye,
        modelRadius: sys?.modelRadius(rt.level.model) ?? 0,
        zoneMultiplier: 1, // zone 13 (torso front) of every soldier table
        invulnerable: rt.ai?.invulnerable ?? false,
        apply: (hit, rec) => soldierExplosion(rt, hit, rec),
      };
    }
  }

  /**
   * FUN_004592a0 (HumanSoldier): damage x zone 13 accumulates; lethal: death
   * type explosion, direction = origin - centre; else a flinch with
   * "ai_xplhit_" when the damage since the last flinch passes the "Recoil
   * threshold". No TAKINGDAMAGE event (only the bullet handlers post it).
   */
  function soldierExplosion(rt: SoldierRuntime, hit: SoldierExplosionHit, rec: ExplosionRecord): void {
    const enemy = rt.enemy;
    if (hit.damage === 0 || !enemy.alive) return;
    enemy.health -= hit.damage;
    const lethal = enemy.health <= 0;
    const o = rt.human.origin();
    const flinch = !lethal && rt.motor.recoilThreshold < x87F32Add(rt.motor.recoilAccum, hit.damage);
    rt.motor.hit({
      amount: hit.damage,
      zone: 13,
      deathType: DEATH_TYPE.EXPLOSION,
      direction: [o[0] - rec.position[0], o[1] - rec.position[1], o[2] - rec.position[2]],
      lethal,
    });
    if (flinch) ctx.events.emit(GameEvent.EnemyHit, { enemyId: enemy.id, position: [...enemy.position], damage: hit.damage, explosion: true });
    if (lethal) {
      enemy.health = 0;
      enemy.alive = false;
      enemy.state = "dead";
      enemy.velocity[0] = 0;
      enemy.velocity[2] = 0;
      rt.flash?.reset();
      ctx.events.emit(GameEvent.EnemyKilled, {
        enemyId: enemy.id,
        taskId: enemy.taskId,
        position: [...enemy.position],
        weaponId: rt.weapon?.scriptId,
        gunPosition: rt.body.hasPose ? rt.body.gunPosition() : undefined,
        yaw: rt.motor.bodyYaw,
      });
    }
  }

  function strike(rt: SoldierRuntime): void {
    const p = ctx.player;
    const extra = rt.ai?.extra;
    if (!p.alive || !extra) return;
    const e = rt.enemy.position;
    const dx = p.position[0] - e[0];
    const dz = p.position[2] - e[2];
    const d = Math.hypot(dx, dz);
    const fx = -Math.sin(rt.motor.yaw);
    const fz = -Math.cos(rt.motor.yaw);
    if (d > 2 || dx * fx + dz * fz < 0) return;
    if (rngFloat() > extra.closeCombatHitProbability) return;
    // FUN_00412c80: zone 13 when the attacker is in front of the player (dot(player forward,
    // player - attacker) < 0), else 14; damage x that zone's multiplier x difficulty.
    const pf = [-Math.sin(p.yaw), -Math.cos(p.yaw)];
    const zone = pf[0] * dx + pf[1] * dz < 0 ? 13 : 14;
    const multiplier = ctx.level?.humanPlayer?.zoneMultipliers[zone] ?? 1;
    const amount = extra.closeCombatDamage * multiplier * PLAYER_DIFFICULTY_DAMAGE[difficultyKey()];
    ctx.systems.player?.damage(amount, undefined, zone);
    ctx.events.emit(GameEvent.PlayerHit, { amount, from: [...e] as Vec3, melee: true, dead: !ctx.player.alive });
  }

  function animTrigger(rt: SoldierRuntime, trigger: number, quiet: boolean): void {
    const position: Vec3 = [...rt.enemy.position];
    if (trigger === 1010) {
      const index = rt.mv.ground?.material ?? -1;
      const material = index >= 0 ? (ctx.level?.surfaceMaterials[index]?.name ?? null) : null;
      ctx.events.emit(GameEvent.Footstep, { actor: rt.enemy.id, position, material, quiet });
      if (rt.motor.stance === "stand" && world && material) {
        const range = aiData?.footstepRange.get(material) ?? UNITS;
        world.broadcast({ type: EV.WALK, team: rt.team, flags: 0x46, range, position: toIgi(position), source: rt.enemy.id, other: rt.enemy.id });
      }
    } else if (trigger >= 1000) {
      ctx.events.emit(GameEvent.AnimTrigger, { actor: rt.enemy.id, trigger, position });
    }
  }

  // --- Damage -----------------------------------------------------------------
  /**
   * Damage on a soldier (FUN_0045bfe0 bullets, FUN_004592a0 explosions): the
   * zone-multiplied amount accumulates; lethal damage sets the death type
   * (0 explosion, 1 WEAPONTYPE_SHOTGUN, 2 other) and direction, otherwise the
   * body may flinch (motor.hit). `hit`: the hit test's zone and the bullet's
   * engine-space direction.
   */
  function damageSoldier(
    rt: SoldierRuntime,
    amount: number,
    from: Vec3,
    attacker: number,
    attackerTeam: number,
    explosion: boolean,
    hit: { zone: number; dir: readonly number[]; shotgun: boolean } | null = null,
  ): void {
    const enemy = rt.enemy;
    if (!enemy.alive) return;
    rt.ai?.post({ type: EV.TAKINGDAMAGE, team: attackerTeam, flags: 0, range: -1, position: toIgi(from), source: attacker, other: attacker });
    if (rt.ai?.invulnerable) return;
    // Cheat One Shot Kills (engine/cheats.ts): the player's bullet or knife takes all the health.
    if (attacker === PLAYER_KEY && ctx.cheats?.oneShotKills === true && amount > 0) amount = Math.max(amount, enemy.health);
    enemy.health -= amount;
    ctx.events.emit(GameEvent.EnemyHit, { enemyId: enemy.id, position: [...enemy.position], damage: amount, explosion });
    const lethal = enemy.health <= 0;
    // +0xd20: explosions: the body (pelvis-level position) minus the centre; bullets: the travel direction (IGI axes).
    let direction: number[];
    if (explosion || !hit) {
      const p = enemy.position;
      direction = [p[0] - from[0], -(p[2] - from[2]), p[1] + rt.motor.rootZ / UNITS - from[1]];
    } else {
      direction = [hit.dir[0], -hit.dir[2], hit.dir[1]];
    }
    rt.motor.hit({
      amount,
      zone: explosion ? 13 : hit ? hit.zone : 12,
      deathType: explosion ? DEATH_TYPE.EXPLOSION : hit?.shotgun ? DEATH_TYPE.SHOTGUN : DEATH_TYPE.OTHER,
      direction,
      lethal,
    });
    if (lethal) {
      enemy.health = 0;
      enemy.alive = false;
      enemy.state = "dead";
      enemy.velocity[0] = 0;
      enemy.velocity[2] = 0;
      rt.flash?.reset();
      // FUN_004534d0 -> FUN_0046b500: the gun in hand drops from its own position (combat/pickups.ts).
      ctx.events.emit(GameEvent.EnemyKilled, {
        enemyId: enemy.id,
        taskId: enemy.taskId,
        position: [...enemy.position],
        weaponId: rt.weapon?.scriptId,
        gunPosition: rt.body.hasPose ? rt.body.gunPosition() : undefined,
        yaw: rt.motor.bodyYaw,
      });
    }
  }

  /**
   * FUN_0045c3b0: the death clip's horizontal root travel (first to last key),
   * lengthened by 1 m and turned by the body matrix, is cast from the pelvis
   * in 8 directions 45 deg apart (set 0, FUN_004c24c0); with a hit, the body
   * slides back by the part beyond the nearest hit over the clip's ticks
   * (none when nothing is hit). Engine metres per tick.
   */
  function deathSlideFor(rt: SoldierRuntime, clipId: number, matrixYaw: number): Vec3 | null {
    const w = ctx.world;
    const clip = rt.body.animator.anim?.clips.get(clipId);
    if (!w || !clip) return null;
    const v = clip.translation.values;
    const n = clip.translation.times.length;
    if (n < 1) return null;
    let dx = v[3 * (n - 1)] - v[0];
    let dy = v[3 * (n - 1) + 1] - v[1];
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) return null;
    const k = (len + UNITS) / len;
    dx *= k;
    dy *= k;
    const L = Math.hypot(dx, dy);
    // World (IGI) direction W = Rz(matrixYaw) d.
    const c = Math.cos(matrixYaw), s = Math.sin(matrixYaw);
    const wx = c * dx - s * dy;
    const wy = s * dx + c * dy;
    const p = rt.enemy.position;
    const origin: Vec3 = [p[0], p[1] + rt.motor.rootZ / UNITS, p[2]];
    let best: number | null = null;
    for (let i = 0; i < 8; i++) {
      const a = (i * 45 * Math.PI) / 180;
      const rx = Math.cos(a) * wx - Math.sin(a) * wy;
      const ry = Math.sin(a) * wx + Math.cos(a) * wy;
      // IGI (x, y) -> engine (x, -y) on the horizontal plane.
      const ex = rx / L, ez = -ry / L;
      const hitRay = w.raycast(origin[0], origin[1], origin[2], ex, 0, ez, L / UNITS, TRI_BULLET);
      if (hitRay && (best === null || hitRay.distance < best)) best = hitRay.distance;
    }
    if (best === null) return null;
    const ticks = (clip.duration / 4800) * 30;
    const f = best > 0 ? 1 - (best * UNITS) / L : 1;
    // Per tick: -(f W) / ticks, IGI -> engine.
    return [(-f * wx) / ticks / UNITS, 0, (f * wy) / ticks / UNITS];
  }

  // --- Player noises -------------------------------------------------------------
  const offs = [
    ctx.events.on(GameEvent.Fire, (payload) => {
      const f = payload as { weaponId?: string; shooter?: unknown; position?: Vec3 } | undefined;
      if (!world || !f || f.shooter !== "player") return;
      if (ctx.cheats?.invisible === true) return; // cheat: the soldiers do not hear the player
      const w = f.weaponId ? ctx.level?.weapons.get(f.weaponId) : undefined;
      const range = (w?.aiDetection ?? "").includes("SILENCED") ? AI_GUNSHOT_SILENCED_RANGE : AI_GUNSHOT_RANGE;
      const at = f.position ?? ctx.player.position;
      world.broadcast({ type: EV.GUNSHOT, team: playerTeam(), flags: 0x46, range, position: toIgi(at), source: PLAYER_KEY, other: PLAYER_KEY });
    }),
    ctx.events.on(GameEvent.Footstep, (payload) => {
      const f = payload as { actor?: unknown; position?: Vec3; material?: string | null } | undefined;
      if (!world || !f || f.actor !== "player" || ctx.player.crouching) return;
      if (ctx.cheats?.invisible === true) return; // cheat: the soldiers do not hear the player
      const range = aiData?.footstepRange.get(f.material ?? "Ground") ?? aiData?.footstepRange.get("Ground") ?? UNITS;
      world.broadcast({ type: EV.WALK, team: playerTeam(), flags: 0x46, range, position: toIgi(f.position ?? ctx.player.position), source: PLAYER_KEY, other: PLAYER_KEY });
    }),
    // Ladder rungs (14), fence climbing (13) and doors the player opens (12): FUN_0044fab0 via player/interact.ts.
    ctx.events.on(INTERACT_EVENTS.Noise, (payload) => {
      const f = payload as { type?: number; flags?: number; range?: number; position?: Vec3 } | undefined;
      if (!world || !f || f.type === undefined) return;
      if (ctx.cheats?.invisible === true) return; // cheat: the soldiers do not hear the player
      world.broadcast({ type: f.type, team: playerTeam(), flags: f.flags ?? 0x46, range: f.range ?? 20480, position: toIgi(f.position ?? ctx.player.position), source: PLAYER_KEY, other: PLAYER_KEY });
    }),
    ctx.events.on(GameEvent.Land, (payload) => {
      const f = payload as { actor?: unknown; position?: Vec3; damaged?: boolean } | undefined;
      if (!world || !f || f.actor !== "player") return;
      if (ctx.cheats?.invisible === true) return; // cheat: the soldiers do not hear the player
      world.broadcast({ type: EV.GROUNDIMPACT, team: playerTeam(), flags: 0x46, range: f.damaged ? 40960 : 20480, position: toIgi(f.position ?? ctx.player.position), source: PLAYER_KEY, other: PLAYER_KEY });
    }),
  ];
  void offs;

  // Muzzle flashes follow the recovered per-frame rule (once per rendered frame).
  addSceneHook(ctx.scene, () => {
    for (const rt of soldiers) rt.flash?.update();
  });

  // --- Tick -------------------------------------------------------------------------
  function stateOf(rt: SoldierRuntime): EnemyState {
    if (!rt.enemy.alive) return "dead";
    const top = rt.ai?.top;
    if (!top) return "idle";
    const name = top.impl.name;
    if (name.startsWith("Combat")) return rt.ai?.slots.get(PLAYER_KEY)?.visible ? "engage" : "search";
    if (name === "Patrol" || name === "ToNode" || name === "MoveToEvent" || name === "RunPanicking") return "patrol";
    if (name === "SetCombat" || name === "LookAtEvent") return "alert";
    return "idle";
  }

  /** Per-tick inputs shared by the soldier and AI steps (camera for the LOD, world, dt). */
  let tickState: { w: CollisionWorld; cam: THREE.Vector3; camForward: THREE.Vector3; tanX: number; dt: number; t0: number } | null = null;
  /** LOD chosen by each soldier's body step this tick (the AI step places the shadow with it). */
  const tickLod = new Map<SoldierRuntime, number>();

  /** Start of a tick: the AI world's tick and the camera inputs. False without a collision world. */
  function beginTick(dt: number): boolean {
    const w = ctx.world;
    if (!w) return false;
    const t0 = performance.now();
    if (world) {
      world.tick = ctx.tick;
      // The application tick (perception phases): ctx.appTick when game.ts keeps it, else the level tick.
      world.appTick = ctx.appTick ?? ctx.tick;
      world.beginTick();
    }
    const cam = ctx.camera.position;
    // FUN_004c4fc0 inputs: the camera's forward axis and tan(horizontal half-FOV).
    const camForward = ctx.camera.getWorldDirection(new THREE.Vector3());
    const persp = ctx.camera as THREE.PerspectiveCamera;
    const tanX = persp.isPerspectiveCamera ? tanHalfFovX(persp.fov, persp.aspect) : 1;
    tickState = { w, cam, camForward, tanX, dt, t0 };
    tickLod.clear();
    return true;
  }

  /**
   * The HumanSoldier node (FUN_0045bd00): the body's motor step with the AI's previous channels,
   * the move (or the vehicle attach) and the pose. False while the soldier is out of the world.
   */
  function tickSoldier(rt: SoldierRuntime): boolean {
    if (!tickState) return false;
    const { w, cam, camForward, tanX, dt } = tickState;
    const e = rt.enemy;
    rt.present = soldierInWorld(e);
    if (!rt.present) {
      rt.body.object.visible = false;
      rt.shadow?.setVisible(false);
      return false;
    }
    rt.body.object.visible = true;
    let t = performance.now();
    // The HumanSoldier node runs before its HumanAI node: the body (FUN_0045bd00)
    // uses the channels the AI wrote on its previous frame.
    const step = rt.motor.step(rt.ai && e.alive ? rt.ai.ch : ZERO_CHANNELS, { grounded: rt.held || rt.grounded, roof: rt.roof });
    e.yaw = rt.motor.yaw;
    if (rt.vehicleBody === undefined) rt.vehicleBody = riderBody(rt);
    if (rt.vehicleBody !== null && rt.vehicleBody !== undefined) {
      // FUN_00460fd0's AI branch: the graph is attached, so FUN_00461f50 attaches the soldier to the
      // graph's parent; then FUN_00461930 moves it rigidly in the vehicle's frame (root motion only,
      // no sweep, probe or gravity) and FUN_0045fd00 turns its heading with the vehicle.
      // FUN_00461f50 takes the human's object position (+0x20) as it is when it attaches: the
      // placed "Position" itself. That point is the pelvis one (FUN_00460fd0 puts it at ground +
      // bone 0's height), so the placed position is not raised by the root height here.
      const mv = rt.mv;
      const rootHeight = rt.motor.rootZ / UNITS;
      if (rt.vehicleBody === STATIC_ATTACH) {
        // Attached to an object that never moves (Anya's desk in the L1 / L14 intros): from the
        // placed position, root motion only (FUN_00461930: no sweep, ground probe or gravity).
        if (!rt.riderPlaced) {
          const placed = rt.level.position;
          mv.position = [placed[0], placed[1], placed[2]];
          rt.riderPlaced = true;
        }
        const yaw = rt.motor.bodyYaw;
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        const rx = Math.cos(yaw), rz = -Math.sin(yaw);
        const d: Vec3 = [
          (rx * step.delta[0] + fx * step.delta[1]) / UNITS,
          step.delta[2] / UNITS,
          (rz * step.delta[0] + fz * step.delta[1]) / UNITS,
        ];
        mv.position = [mv.position[0] + d[0], mv.position[1] + d[1], mv.position[2] + d[2]];
        mv.moved = d;
        mv.air = [0, 0, 0];
        mv.grounded = true;
        rt.grounded = true;
        rt.lastMove = [d[0], d[1], d[2]];
        e.position[0] = mv.position[0];
        e.position[1] = mv.position[1] - rootHeight;
        e.position[2] = mv.position[2];
        e.velocity[0] = d[0] / dt;
        e.velocity[1] = d[1] / dt;
        e.velocity[2] = d[2] / dt;
        e.yaw = rt.motor.yaw;
      } else if (!mv.attach) {
        if (!rt.riderPlaced) {
          const placed = rt.level.position;
          mv.position = [placed[0], placed[1], placed[2]];
          rt.riderPlaced = true;
        }
        if (!attachHuman(w, mv, rt.vehicleBody)) rt.vehicleBody = undefined;
      }
      if (mv.attach) {
        updatePlatform(w, mv);
        rt.motor.yaw += mv.platformYaw;
        const yaw = rt.motor.bodyYaw;
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        const rx = Math.cos(yaw), rz = -Math.sin(yaw);
        const rootDelta: Vec3 = [
          (rx * step.delta[0] + fx * step.delta[1]) / UNITS,
          step.delta[2] / UNITS,
          (rz * step.delta[0] + fz * step.delta[1]) / UNITS,
        ];
        moveHuman(w, mv, rootDelta, rootHeight, ctx.playArea ?? undefined);
        rt.grounded = true;
        rt.lastMove = [mv.moved[0], mv.moved[1], mv.moved[2]];
        e.position[0] = mv.position[0];
        e.position[1] = mv.position[1] - rootHeight;
        e.position[2] = mv.position[2];
        e.velocity[0] = mv.moved[0] / dt;
        e.velocity[1] = mv.moved[1] / dt;
        e.velocity[2] = mv.moved[2] / dt;
        e.yaw = rt.motor.yaw;
      }
    } else if (!rt.held && rt.vehicleBody !== undefined && !(rt.ai === null && rt.level.graphId !== null)) {
      // (A rider whose vehicle is not in the world yet, or a soldier whose HumanAI is still
      // loading, waits: igi.exe attaches / has the AI from the first tick.)
      // FUN_004600f0 for soldiers (FUN_0045bd00), dead ones included: the
      // root motion of the playing clip rotated by the body matrix (heading
      // + the gun's yaw kick; no 1.75 factor: that is the player's
      // DefineHumanPlayerGeneral argument), then the sweep and the ground
      // probe of world/character.ts. A dying body first slides by
      // FUN_0045c3b0's step (FUN_0045b160, added to the position).
      const yaw = rt.motor.bodyYaw;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const rootDelta: Vec3 = [
        (rx * step.delta[0] + fx * step.delta[1]) / UNITS,
        step.delta[2] / UNITS,
        (rz * step.delta[0] + fz * step.delta[1]) / UNITS,
      ];
      const mv = rt.mv;
      const rootHeight = rt.motor.rootZ / UNITS;
      // Follow external placement of the feet (spawn, cut-scene storage release).
      if (mv.position[0] !== e.position[0] || mv.position[1] - rootHeight !== e.position[1] || mv.position[2] !== e.position[2]) {
        mv.position = [e.position[0], e.position[1] + rootHeight, e.position[2]];
      }
      if (step.deathSlide && rt.deathSlide) {
        mv.position = [mv.position[0] + rt.deathSlide[0], mv.position[1], mv.position[2] + rt.deathSlide[2]];
      }
      // The sweep heights follow the low-profile flag human+0x33d (FUN_00460fd0 / FUN_004606b0).
      mv.crouched = rt.motor.crouched;
      mv.grounded = rt.grounded;
      if (mv.grounded) mv.air = [0, 0, 0];
      else mv.air[1] -= GRAVITY_M_PER_TICK2;
      moveHuman(w, mv, rootDelta, rootHeight, ctx.playArea ?? undefined);
      // FUN_00460fd0's AI branch: a soldier with a graph stands at the graph's height (the
      // current node, or along the route segment) + the pose's root height; always on ground.
      const graphZ = rt.ai ? rt.ai.graphFeetZ(toIgi([mv.position[0], mv.position[1] - rootHeight, mv.position[2]])) : null;
      if (graphZ !== null) {
        const origin = ctx.level?.originIgi ?? [0, 0, 0];
        mv.position[1] = (graphZ - origin[2]) / UNITS + rootHeight;
        mv.air = [0, 0, 0];
        mv.grounded = true;
      }
      rt.grounded = mv.grounded;
      rt.roof = mv.roof;
      rt.lastMove = [mv.moved[0], mv.moved[1], mv.moved[2]];
      e.position[0] = mv.position[0];
      e.position[1] = mv.position[1] - rootHeight;
      e.position[2] = mv.position[2];
      e.velocity[0] = mv.moved[0] / dt;
      e.velocity[1] = mv.moved[1] / dt;
      e.velocity[2] = mv.moved[2] / dt;
    } else {
      e.velocity[0] = 0;
      e.velocity[2] = 0;
    }
    let t2 = performance.now();
    split.move += t2 - t;
    t = t2;
    const far = Math.hypot(cam.x - e.position[0], cam.z - e.position[2]) > FULL_POSE_DISTANCE;
    const lod = rt.body.chooseLod(e.position, [cam.x, cam.y, cam.z], [camForward.x, camForward.y, camForward.z], tanX);
    if (!far || ctx.tick - rt.lastPose >= 4 || rt.lastPose < 0) {
      rt.body.pose(e.position, rt.motor.bodyYaw, {
        gunVisible: !rt.motor.weaponDropped,
        aim: rt.motor.aimEnabled ? { pitch: rt.motor.aimPitch, yaw: 0 } : null,
        rootZ: rt.motor.rootZ,
        skin: lod >= 0,
      });
      rt.lastPose = ctx.tick;
    }
    t2 = performance.now();
    split.pose += t2 - t;
    t = t2;
    tickLod.set(rt, lod);
    rt.drawnNow = lod >= 0;
    return true;
  }

  /** The HumanAI node: the AI frame (it writes the channels the body reads next tick), the state, the shadow. */
  function tickAi(rt: SoldierRuntime): void {
    if (!tickState || !rt.present) return;
    const { w } = tickState;
    const e = rt.enemy;
    const lod = tickLod.get(rt) ?? -1;
    let t = performance.now();
    let t2: number;
    if (rt.ai) rt.ai.frame();
    corpseTick(rt);
    // The draw path's stamp (0x45f2bf) of this tick's frame: read by the next tick's corpse test.
    if (rt.drawnNow) rt.drawStamp = ctx.appTick ?? ctx.tick;
    e.state = stateOf(rt);
    t2 = performance.now();
    split.ai += t2 - t;
    t = t2;
    if (rt.shadow) {
      // The blob shadow lies on the visible surface (HSMC set 0 / terrain); none for an undrawn body.
      const hit = lod >= 0 ? w.raycast(e.position[0], e.position[1] + 0.5, e.position[2], 0, -1, 0, 50, TRI_BULLET) : null;
      if (hit) {
        rt.shadow.setVisible(true);
        rt.shadow.update(hit.point, hit.normal, e.position[1] + rt.motor.rootZ / UNITS - hit.point[1]);
      } else {
        rt.shadow.setVisible(false);
      }
    }
    split.shadow += performance.now() - t;
  }

  /** End of a tick: the thrown grenades, the timing stats. */
  function endTick(): void {
    if (!tickState) return;
    const { t0 } = tickState;
    updateGrenades();
    if (++split.n >= 300) {
      stats.split = { ai: split.ai / split.n, move: split.move / split.n, pose: split.pose / split.n, shadow: split.shadow / split.n };
      split.ai = split.move = split.pose = split.shadow = split.n = 0;
    }
    const ms = performance.now() - t0;
    timings.push(ms);
    if (timings.length > 300) timings.shift();
    stats.msPerTick = timings.reduce((a, b) => a + b, 0) / timings.length;
    stats.maxMsPerTick = Math.max(...timings);
    stats.scriptRuns = world ? world.soldiers.reduce((a, s) => a + s.scriptRuns, 0) : 0;
    tickState = null;
  }

  function update(dt: number): void {
    if (!beginTick(dt)) return;
    for (const rt of soldiers) if (tickSoldier(rt)) tickAi(rt);
    endTick();
  }

  /**
   * Node-ordered ticks: soldiers by the node index of their HumanSoldier / HumanAI task (task ids
   * repeat: three level-1 soldiers have id -1), and the ones the walk reached.
   */
  const bySoldierNode = new Map<number, SoldierRuntime>();
  const byAiNode = new Map<number, SoldierRuntime>();
  const reached = new Set<SoldierRuntime>();
  function beginNodeTick(dt: number): boolean {
    bySoldierNode.clear();
    byAiNode.clear();
    for (const rt of soldiers) {
      const node = rt.level.taskIndex ?? nodeOfTask(rt.enemy.taskId);
      bySoldierNode.set(node, rt);
      const aiNode = rt.level.aiTaskIndex;
      if (aiNode !== undefined && aiNode !== null) byAiNode.set(aiNode, rt);
    }
    reached.clear();
    return beginTick(dt);
  }
  /**
   * An attached graph follows its parent object (FUN_004f0340 reads the parent's +0x20 / +0x70 when
   * it is called): a moving parent (vehicle, elevator) gives its current pose before the soldier
   * on that graph updates.
   */
  function refreshGraphParent(rt: SoldierRuntime): void {
    const parent = rt.ai?.graphInfo?.position.parent;
    if (!parent) return;
    const tasks = ctx.systems.tasks as unknown as { poseOfNode?(node: number): { position: readonly number[]; matrix: readonly number[] } | null } | null;
    const pose = tasks?.poseOfNode?.(parent.node);
    if (!pose) return;
    parent.position = [pose.position[0], pose.position[1], pose.position[2]];
    parent.matrix = [...pose.matrix];
  }

  function tickNode(_taskId: number, type: string, nodeIndex: number): void {
    if (isSoldierTaskType(type)) {
      const rt = bySoldierNode.get(nodeIndex);
      if (!rt || reached.has(rt)) return;
      reached.add(rt);
      refreshGraphParent(rt);
      tickSoldier(rt);
    } else if (type === "HumanAI") {
      const rt = byAiNode.get(nodeIndex);
      if (rt && reached.has(rt)) tickAi(rt);
    }
  }
  function endNodeTick(fallback = false): void {
    if (fallback) {
      for (const rt of soldiers) if (tickSoldier(rt)) tickAi(rt);
      endTick();
      return;
    }
    // A soldier whose node the walk did not reach is out of the world (its container is not).
    for (const rt of soldiers) {
      if (reached.has(rt)) continue;
      rt.present = false;
      rt.body.object.visible = false;
      rt.shadow?.setVisible(false);
    }
    endTick();
  }

  return {
    reset,
    update,
    beginNodeTick,
    tickNode,
    endNodeTick,
    stats,
    damage(enemy: Enemy, amount: number, from: Vec3): void {
      const rt = byId.get(enemy.id);
      if (!rt) return;
      // The hit test that preceded this damage (same tick): zone and bullet direction.
      const last = rt.lastHit && rt.lastHit.tick === ctx.tick ? rt.lastHit : null;
      const shotgun = ctx.weapon?.spec.weaponType === "WEAPONTYPE_SHOTGUN";
      damageSoldier(rt, amount, from, PLAYER_KEY, playerTeam(), false, last ? { zone: last.zone, dir: last.dir, shotgun } : null);
    },
    hitTest(from: Vec3, dir: Vec3, maxDistance: number, options?: { nearMiss?: boolean }): EnemyHitResult[] {
      raycaster.set(new THREE.Vector3(...from), new THREE.Vector3(...dir));
      raycaster.near = 0.05;
      raycaster.far = maxDistance;
      const out: EnemyHitResult[] = [];
      for (const rt of soldiers) {
        if (!rt.enemy.alive || !rt.present) continue;
        // The player's bullet path near this soldier: GUNSHOTMISS (2 m, team = shooter's).
        if (rt.ai && world && options?.nearMiss !== false && ctx.cheats?.invisible !== true) rt.ai.post(gunshotMiss(closestOnSegment(from, dir, maxDistance, rt.enemy.position), playerTeam(), PLAYER_KEY));
        const hit = rt.body.hitTest(raycaster);
        if (!hit) continue;
        rt.lastHit = { zone: hit.zone, dir: [dir[0], dir[1], dir[2]], tick: ctx.tick };
        const head = hit.zone === HIT_ZONE.HEAD || hit.zone === HIT_ZONE.HEAD_FRONT;
        out.push({ enemy: rt.enemy, distance: hit.distance, point: hit.point, head, zoneMultiplier: zoneMultiplier(rt, hit.zone, hit.zoneMultiplier), material: hit.material });
      }
      return out.sort((a, b) => a.distance - b.distance);
    },
    sightHits: (from, to, skip) => humanSightHits(from, to, skip),
visibleSoldiers() {
      const out: Array<{ enemy: Enemy; team: number; eye: Vec3; model: string }> = [];
      for (const rt of soldiers) {
        if (!rt.enemy.alive || !rt.present) continue;
        // Eye height of the human AI (2826.24 / 1433.6 units standing / crouched, ai/human-ai.ts).
        const h = (rt.motor.crouched ? 1433.6 : 2826.24) / UNITS;
        const e = rt.enemy.position;
        out.push({ enemy: rt.enemy, team: rt.team, eye: [e[0], e[1] + h, e[2]], model: rt.level.model });
      }
      return out;
    },
        isDetection(): number {
      return 0;
    },
    isDead(soldierTaskId: number): number {
      const rt = soldiers.find((s) => s.enemy.taskId === soldierTaskId);
      return rt && !rt.enemy.alive ? 1 : 0;
    },
    inspect(enemy: Enemy) {
      const rt = byId.get(enemy.id);
      if (!rt) return null;
      return {
        clip: rt.body.animator.clip ? { ...rt.body.animator.clip } : null,
        motorState: rt.motor.state,
        scripted: rt.motor.scripted,
        scriptedClip: rt.motor.scriptedClip,
        rootZ: rt.motor.rootZ,
        present: rt.present,
        attached: rt.mv.attach ? { body: rt.mv.attach.body, local: [...rt.mv.attach.local] } : null,
        channels: rt.ai ? Array.from(rt.ai.ch) : null,
      };
    },
    aiOf(enemy: Enemy): HumanAi | null {
      return byId.get(enemy.id)?.ai ?? null;
    },
    spawnGenerated,
    removeGenerated,
    generatedState(node) {
      const rt = generatedAt(node);
      return rt ? { dead: !rt.enemy.alive, inWorld: !rt.enemy.outOfWorld } : null;
    },
    soldierOf(enemy) {
      const rt = byId.get(enemy.id);
      if (!rt) return null;
      return {
        enemy: rt.enemy,
        ai: rt.ai,
        motor: rt.motor,
        team: rt.team,
        shoot: (weapon, from, dir) => traceAiBullet(rt, from, dir, Math.max(1, weapon.rangeMetres), weapon),
        place(feet, yaw) {
          rt.enemy.position = [feet[0], feet[1], feet[2]];
          rt.motor.yaw = yaw;
          rt.motor.bodyYaw = yaw + rt.motor.kickYaw;
          rt.enemy.yaw = yaw;
        },
      };
    },
    enemyByKey(key) {
      return byId.get(key)?.enemy ?? null;
    },
    broadcast(ev) {
      world?.broadcast(ev);
    },
    shootAs(src, weapon, from, dir) {
      traceShot({ self: null, ...src }, from, dir, Math.max(1, weapon.rangeMetres), weapon);
    },
    *aiHumans() {
      yield playerHuman;
      for (const rt of soldiers) yield rt.human;
    },
  };
}
