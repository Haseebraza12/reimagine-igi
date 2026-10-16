/**
 * The engine side of the StationaryGun tasks (loaders/objects/stationary-gun.ts
 * runs the recovered update FUN_00474190 at the task's place in the tree):
 * the attached Gun (M2HB) that fires, the holder model turning with the yaw,
 * the gun model, the users (the player in movement state 33, soldiers in body
 * state 36) and the user's view override.
 *
 * Recovered (full exe):
 *   - The Gun (FUN_00477c50(self, 0, weaponconfig(Weapon ID), Ammo, 0)):
 *     clip +0x144 = Ammo (-1 = endless: the update replaces only the -2
 *     sentinel, the fire code blocks on an ammo type with clip 0 and
 *     decrements only a clip > 0; mission 7 #3301 has 10000 rounds and then
 *     dry-fires, there is no reload path).
 *   - Gun use FUN_00479780 -> core fire FUN_00478ba0 with the record {fire,
 *     no eye, no view matrix, scale = user +0x4d4, user}: request held ->
 *     shots +0x140 counted to "Maximum Rounds/Burst"; no round while the
 *     cooldown +0x13c runs or with an empty clip; burst >= 2: "Fire Sound
 *     Loop" kept at the gun while the request holds, "Loop End" when it stops;
 *     muzzle = the gun's origin + gun matrix x magic vertex 2 (FUN_00414e20),
 *     direction = gun matrix col 1; spread = "Minimum random spread" for the
 *     first 4 shots of a hold, then the maximum, r1 r2 r3 x spread / r4 x 2 pi
 *     per pellet (level RNG); no casing (only the player's own gun ejects one:
 *     FUN_00416a70(0) == owner); cooldown = fistp(60 / rpm x 30) (M2HB 800 rpm:
 *     2 ticks); a round leaves -> the AI GUNSHOT event {team: the user's or 1,
 *     flags 0x46, range = the weapon's detection range, at the muzzle} and the
 *     kick (two level-RNG draws per unit-disk try) into the record.
 *   - The Gun is a child of the StationaryGun: its update (cooldown - 1) runs
 *     after the gun's own update.
 *   - Users: player state 33 (FUN_0040c970 enter, 0x40cae0 tick), soldier
 *     state 36 (FUN_0045c8b0 enter, 0x45c9b0 tick); the user's channels 0, 1, 6
 *     feed the update; release FUN_00475340 clears the user and the view
 *     override (FUN_00465910).
 *   - The holder model is the StationaryGun's own model: it turns with the
 *     total yaw (+0x70 = base x Rz(yaw)); the gun model (weaponconfig "Gun
 *     Model", 123_01_1) is the Gun object at the pivot with the gun matrix.
 * Bullets: a player-manned gun shoots the player's bullets (weapon.ts
 * shootBullet: soldiers hit like the player's), a soldier-manned one the
 * soldier's (enemy.ts: the hit-probability roll on the player).
 */
import * as THREE from "three";
import {
  AI_GUNSHOT_RANGE,
  AI_GUNSHOT_SILENCED_RANGE,
  fireCooldownTicks,
  sampleViewKick,
  spreadForShot,
  type LevelWeapon,
  type MissionNode,
} from "../../loaders";
import { engineMatrix4, igiPointToEngine, igiRotationToEngine, type Mat3 } from "../../loaders/coords";
import {
  STATIONARY_GUN,
  STATIONARY_GUN_EVENTS,
  colM3,
  newStationaryGunState,
  stationaryGunBehind,
  stationaryGunDefOf,
  stationaryGunMount,
  stationaryGunPose,
  stationaryGunUsePoint,
  type GunKick,
  type M3,
  type StationaryGunDef,
  type StationaryGunPose,
  type StationaryGunState,
  type StationaryGunUser,
} from "../../loaders/objects/stationary-gun";
import { lookChannel, lookSensitivity } from "../look";
import { EV } from "../ai/types";
import type { GameContext } from "../context";
import { GameEvent } from "../events";
import { createMuzzleFlash, type MuzzleFlash } from "../fx/muzzle-flash";
import { addSceneHook } from "../render/scene-hooks";
import type { CombatModelEntry } from "../render/combat-models";
import { damageSystemOf } from "./object-damage";
import { drawPellet, pelletDirection, spreadRadians } from "./pellet";

type V3 = [number, number, number];
const UNITS = 4096;
/** Sound-event shooter keys of the stationary guns (an actor that is neither the player nor a soldier). */
export const STATIONARY_GUN_SHOOTER_BASE = 1_000_000;

export type GunUserRef = { kind: "player" } | { kind: "soldier"; key: number };

/** One StationaryGun task and its attached Gun (+0x20c). */
export interface StationaryGunRecord {
  node: number;
  id: number;
  def: StationaryGunDef;
  weapon: LevelWeapon | null;
  /** +0x12c: the weapon has an ammo type (its calibre's DefineAmmoType). */
  ammoType: boolean;
  /** Gun +0x144 / +0x13c / +0x140 and the loop-sound handle (+0x194). */
  clip: number;
  cooldown: number;
  shots: number;
  firing: boolean;
  user: GunUserRef | null;
  /** The latest pose (FUN_00474420). */
  pose: StationaryGunPose;
  holderMagic: V3[];
  gunMagic: V3[];
  flash: MuzzleFlash | null;
  /** Rounds fired (diagnostics). */
  rounds: number;
}

export interface StationaryGuns {
  readonly guns: readonly StationaryGunRecord[];
  registerQueries(): void;
  onTaskEvent(node: MissionNode, event: string, data?: unknown): void;
  reset(): void;
  dispose(): void;
  /** The built world (the holders turn: setTaskTransform). */
  attachWorld(world: { setTaskTransform(key: number, matrix: ArrayLike<number>): void; readonly dynamicTasks: ReadonlySet<number> } | null): void;
  byNode(node: number): StationaryGunRecord | null;
  byId(id: number): StationaryGunRecord | null;
  /** The player's channels 0 / 1 (mouse counts of the tick, FUN_0045cde0) and 6 (Fire) while on a gun. */
  setPlayerInput(dx: number, dy: number, invertY: boolean, sensitivity: number, fire: boolean): void;
  /** Free guns for the use search (FUN_00474e30): the use point (origin + object x magic 0) and the object matrix. */
  candidates(): Array<{ gun: StationaryGunRecord; point: V3; matrix: M3 }>;
  /** Player state 33 enter (FUN_0040c970): user = player; returns the new x, y (IGI) and heading. */
  mountPlayer(node: number, human: readonly number[]): { x: number; y: number; heading: number } | null;
  /** 0x40cae0 exit: release (FUN_00475340). */
  releasePlayer(): void;
  readonly playerGun: StationaryGunRecord | null;
  /** The view override of the player (camera mode 4): eye and gun matrix (IGI), FOV = the arms' (90 deg). */
  playerView(): { eye: V3; matrix: M3 } | null;
  /** Soldier state 36 enter (FUN_0045c8b0, no flip test): user = soldier `key`. */
  mountSoldier(node: number, key: number, human: readonly number[]): { x: number; y: number; heading: number } | null;
  releaseSoldier(node: number): void;
  /** IsInUse (FUN_00475370) of the gun task `id`; null when no such StationaryGun exists. */
  isInUse(id: number): number | null;
  /** The gun models to draw (render/combat-models.ts). */
  models(): CombatModelEntry[];
}

const registry = new WeakMap<object, StationaryGuns>();

/** The stationary guns of a GameContext (created by createCombatObjects), or null. */
export function stationaryGunsOf(ctx: object): StationaryGuns | null {
  return registry.get(ctx) ?? null;
}

interface MissionLike {
  setTaskQuery(name: string, fn: ((...args: unknown[]) => unknown) | null): void;
  readonly runtime: { tasks: { nodes: MissionNode[] }; nodeState(index: number): Readonly<Record<string, number>> } | null;
}

export function createStationaryGuns(ctx: GameContext, mission: MissionLike): StationaryGuns {
  let guns: StationaryGunRecord[] = [];
  let world: { setTaskTransform(key: number, matrix: ArrayLike<number>): void; readonly dynamicTasks: ReadonlySet<number> } | null = null;
  const posedYaw = new Map<number, number>();
  const player = { turn: 0, look: 0, fire: 0 };
  let builtFor: unknown = null;
  const rand = () => ctx.rng.float();
  const toEngine = (p: readonly number[]): V3 => {
    const o = ctx.level?.originIgi ?? [0, 0, 0];
    return [(p[0] - o[0]) / UNITS, (p[2] - o[2]) / UNITS, -(p[1] - o[1]) / UNITS];
  };
  const magicOf = (model: string): V3[] => (damageSystemOf(ctx)?.data?.bounds.get(model.toLowerCase())?.magic ?? []).map((m) => [m[0], m[1], m[2]] as V3);

  function build(): void {
    guns = [];
    posedYaw.clear();
    const rt = mission.runtime;
    const level = ctx.level;
    builtFor = rt;
    if (!rt || !level) return;
    for (const n of rt.tasks.nodes) {
      if (n.type !== "StationaryGun") continue;
      const def = stationaryGunDefOf(n);
      const weapon = level.weapons.get(def.weaponId) ?? null;
      const ammoType = !!weapon && weapon.calibreId > 0;
      const st = rt.nodeState(n.index) as unknown as StationaryGunState;
      const gunModel = weapon?.gunModel ?? "";
      const r: StationaryGunRecord = {
        node: n.index, id: n.id, def, weapon, ammoType, clip: def.ammo, cooldown: 0, shots: 0, firing: false, user: null,
        pose: stationaryGunPose(def, st ?? newStationaryGunState(), 0), holderMagic: magicOf(def.holderModel), gunMagic: magicOf(gunModel),
        flash: weapon ? createMuzzleFlash(level, weapon.scriptId) : null, rounds: 0,
      };
      r.pose = poseOf(r);
      guns.push(r);
    }
  }
  const ensure = () => {
    if (builtFor !== mission.runtime) build();
  };
  const stateOf = (r: StationaryGunRecord): StationaryGunState =>
    (mission.runtime?.nodeState(r.node) as unknown as StationaryGunState | undefined) ?? newStationaryGunState();
  /** FUN_00474420 with the holder model's magic vertices (123_02_1: one, so the pivot is the origin). */
  const poseOf = (r: StationaryGunRecord): StationaryGunPose => {
    if (!r.holderMagic.length) r.holderMagic = magicOf(r.def.holderModel);
    if (!r.gunMagic.length && r.weapon?.gunModel) r.gunMagic = magicOf(r.weapon.gunModel);
    return stationaryGunPose(r.def, stateOf(r), r.holderMagic.length, r.holderMagic[1] ?? null);
  };
  const byNode = (node: number) => {
    ensure();
    return guns.find((g) => g.node === node) ?? null;
  };

  /** The user's channel record (+0x1b0 turn, +0x1b4 look, +0x1c8 fire). */
  function userChannels(r: StationaryGunRecord): StationaryGunUser | null {
    const u = r.user;
    if (!u) return null;
    if (u.kind === "player") {
      if (!ctx.player.alive) return null;
      return { turn: player.turn, look: player.look, fire: player.fire };
    }
    const enemies = ctx.systems.enemies;
    const e = enemies?.enemyByKey(u.key);
    const s = e ? enemies?.soldierOf(e) : null;
    if (!s) return null;
    // FUN_00456ff0 copies the AI's channels into the human's record at the soldier's tick: the motor's last input.
    const ch = s.motor.previous;
    return { turn: ch[0], look: ch[1], fire: ch[6] };
  }

  function teamOfUser(r: StationaryGunRecord): number {
    const u = r.user;
    if (!u) return 1;
    if (u.kind === "player") {
      const t = ctx.level?.tasks.find((x) => x.type === "HumanPlayer")?.params["Team"];
      return typeof t === "number" ? t : 0;
    }
    const e = ctx.systems.enemies?.enemyByKey(u.key);
    const s = e ? ctx.systems.enemies?.soldierOf(e) : null;
    return s ? s.team : 1;
  }

  /** FUN_00474360 -> the Gun's use (FUN_00479780 / FUN_00478ba0); returns the kick outputs. */
  function use(r: StationaryGunRecord, fire: boolean): GunKick {
    const w = r.weapon;
    if (!w) return { kickPitch: 0, kickYaw: 0 };
    let req = fire;
    if (!req) r.shots = 0;
    else if (r.shots === w.maxRoundsPerBurst) req = false;
    let shot = req;
    if (r.cooldown !== 0) shot = false;
    if (r.ammoType && r.clip === 0) {
      shot = false;
      req = false;
    }
    const pose = poseOf(r);
    const m2 = r.gunMagic[2] ?? [0, 0, 0];
    const o = [pose.gun[0] * m2[0] + pose.gun[1] * m2[1] + pose.gun[2] * m2[2], pose.gun[3] * m2[0] + pose.gun[4] * m2[1] + pose.gun[5] * m2[2], pose.gun[6] * m2[0] + pose.gun[7] * m2[1] + pose.gun[8] * m2[2]];
    const muzzleIgi: V3 = [pose.pivot[0] + o[0], pose.pivot[1] + o[1], pose.pivot[2] + o[2]];
    const muzzle = toEngine(muzzleIgi);
    const shooter = STATIONARY_GUN_SHOOTER_BASE + r.node;
    // Sounds (burst >= 2: the loop while the request holds, the end sample when it stops).
    if (w.maxRoundsPerBurst >= 2) {
      if (!req) {
        if (r.firing) {
          r.firing = false;
          ctx.events.emit(GameEvent.FireStopped, { weaponId: w.scriptId, shooter, position: muzzle });
        }
      }
    }
    if (!shot) return { kickPitch: 0, kickYaw: 0 };
    r.firing = true;
    // The sound event of the round (sound-events.ts: the loop starts / is kept, or a single sample).
    ctx.events.emit(GameEvent.Fire, { weaponId: w.scriptId, shooter, position: muzzle });
    r.flash?.fire();
    // Direction = gun matrix col 1 (IGI (x, y, z) -> engine (x, z, -y)).
    const c1 = colM3(pose.gun, 1);
    const aim: V3 = [c1[0], c1[2], -c1[1]];
    const spread = spreadRadians(spreadForShot(w.minSpread, w.maxSpread, r.shots));
    const pellets = Math.max(1, w.bulletsPerRound);
    for (let k = 0; k < pellets; k++) {
      let dir: V3 = [aim[0], aim[1], aim[2]];
      if (spread !== 0) {
        const { angle, azimuth } = drawPellet(spread, rand);
        dir = pelletDirection(aim, angle, azimuth);
      }
      shootFrom(r, muzzle, dir, w);
    }
    r.shots++;
    r.rounds++;
    r.cooldown = fireCooldownTicks(w.roundsPerMinute);
    if (r.ammoType && r.clip > 0) r.clip--;
    // FUN_00479780: the GUNSHOT event (FUN_00450ce0) at the muzzle, then the kick.
    const range = (w.aiDetection ?? "").includes("SILENCED") ? AI_GUNSHOT_SILENCED_RANGE : AI_GUNSHOT_RANGE;
    const u = r.user;
    const source = u ? (u.kind === "player" ? 0 : u.key) : null;
    const player = u?.kind === "player";
    if (!(player && ctx.cheats?.invisible === true)) {
      ctx.systems.enemies?.broadcast({ type: EV.GUNSHOT, team: teamOfUser(r), flags: 0x46, range, position: muzzleIgi, source, other: source });
    }
    const kick = sampleViewKick(
      { kickFixedXDeg: w.recoilPitch, kickRandomXDeg: w.recoilPitchRandom, kickFixedZDeg: w.recoilYaw, kickRandomZDeg: w.recoilYawRandom },
      rand,
    );
    return { kickPitch: kick.pitchRad, kickYaw: kick.yawRad };
  }

  function shootFrom(r: StationaryGunRecord, from: V3, dir: V3, w: LevelWeapon): void {
    const u = r.user;
    if (u?.kind === "player") {
      ctx.systems.weapon?.shootBullet(w, from, dir);
      return;
    }
    if (u?.kind === "soldier") {
      const e = ctx.systems.enemies?.enemyByKey(u.key);
      const s = e ? ctx.systems.enemies?.soldierOf(e) : null;
      s?.shoot(w, from, dir);
    }
  }

  /** The holder model turns with the total yaw: world transform = E(base Rz(yaw)) E(base)^-1 about the origin. */
  function syncHolder(r: StationaryGunRecord): void {
    if (!world || !world.dynamicTasks.has(r.node) || !ctx.level) return;
    const yaw = stateOf(r).totalYaw;
    if (posedYaw.get(r.node) === yaw) return;
    posedYaw.set(r.node, yaw);
    const p = igiPointToEngine(r.def.position, ctx.level.originIgi);
    const now = new THREE.Matrix4().fromArray(engineMatrix4(igiRotationToEngine(r.pose.object as Mat3), p));
    const built = new THREE.Matrix4().fromArray(engineMatrix4(igiRotationToEngine(r.def.base as Mat3), p)).invert();
    world.setTaskTransform(r.node, now.multiply(built).elements);
  }

  const flashHook = addSceneHook(ctx.scene, () => {
    for (const g of guns) g.flash?.update();
  });
  void flashHook;

  const system: StationaryGuns = {
    get guns() {
      ensure();
      return guns;
    },
    registerQueries() {
      mission.setTaskQuery(STATIONARY_GUN_EVENTS.user, (node) => {
        const r = byNode((node as MissionNode).index);
        return r ? userChannels(r) : null;
      });
      mission.setTaskQuery(STATIONARY_GUN_EVENTS.use, (node, fire) => {
        const r = byNode((node as MissionNode).index);
        return r ? use(r, fire === true) : { kickPitch: 0, kickYaw: 0 };
      });
    },
    onTaskEvent(node, event) {
      if (event !== STATIONARY_GUN_EVENTS.posed) return;
      const r = byNode(node.index);
      if (!r) return;
      r.pose = poseOf(r);
      syncHolder(r);
      // The Gun child's update after the StationaryGun's own (0x478640): its cooldown runs down.
      if (r.cooldown > 0) r.cooldown--;
    },
    reset() {
      build();
      player.turn = player.look = player.fire = 0;
    },
    dispose() {
      guns = [];
    },
    attachWorld(next) {
      world = next;
      posedYaw.clear();
      ensure();
      for (const g of guns) syncHolder(g);
    },
    byNode,
    byId(id) {
      ensure();
      return guns.find((g) => g.id === id) ?? null;
    },
    setPlayerInput(dx, dy, invertY, sensitivity, fire) {
      // FUN_0045cde0: the clamped port values x the sensitivity clamp; the look channel negated unless inverted.
      const k = lookSensitivity(sensitivity);
      player.turn = Math.fround(k * lookChannel(dx));
      player.look = Math.fround(k * lookChannel(invertY ? dy : -dy));
      player.fire = fire ? 1 : 0;
    },
    candidates() {
      ensure();
      const out: Array<{ gun: StationaryGunRecord; point: V3; matrix: M3 }> = [];
      for (const g of guns) {
        if (g.user || stateOf(g).inUse) continue;
        const u = stationaryGunUsePoint(g.def, stateOf(g), g.holderMagic[0] ?? null);
        out.push({ gun: g, point: u.point, matrix: u.matrix });
      }
      return out;
    },
    mountPlayer(node, human) {
      const r = byNode(node);
      if (!r || r.user) return null;
      const u = stationaryGunUsePoint(r.def, stateOf(r), r.holderMagic[0] ?? null);
      r.user = { kind: "player" };
      stateOf(r).inUse = 1;
      return stationaryGunMount(u.point, u.matrix, human, true);
    },
    releasePlayer() {
      for (const g of guns) {
        if (g.user?.kind !== "player") continue;
        g.user = null;
        stateOf(g).inUse = 0;
      }
      player.turn = player.look = player.fire = 0;
    },
    get playerGun() {
      return guns.find((g) => g.user?.kind === "player") ?? null;
    },
    playerView() {
      const g = guns.find((x) => x.user?.kind === "player");
      if (!g) return null;
      return { eye: [...g.pose.eye] as V3, matrix: [...g.pose.gun] as M3 };
    },
    mountSoldier(node, key, human) {
      const r = byNode(node);
      if (!r || (r.user && !(r.user.kind === "soldier" && r.user.key === key))) return null;
      const u = stationaryGunUsePoint(r.def, stateOf(r), r.holderMagic[0] ?? null);
      r.user = { kind: "soldier", key };
      stateOf(r).inUse = 1;
      return stationaryGunMount(u.point, u.matrix, human, false);
    },
    releaseSoldier(node) {
      const r = byNode(node);
      if (!r || r.user?.kind !== "soldier") return;
      r.user = null;
      stateOf(r).inUse = 0;
    },
    isInUse(id) {
      const r = system.byId(id);
      if (!r) return null;
      return r.user || stateOf(r).inUse ? 1 : 0;
    },
    models() {
      const out: CombatModelEntry[] = [];
      for (const g of guns) {
        const model = g.weapon?.gunModel;
        if (!model) continue;
        const inWorld = (ctx.systems.tasks as { inWorldNode?(n: number): boolean } | null)?.inWorldNode?.(g.node) ?? true;
        if (!inWorld) continue;
        out.push({ key: `sgun:${g.node}`, model, position: g.pose.pivot, matrix: g.pose.gun, children: g.flash ? [g.flash.object] : [] });
      }
      return out;
    },
  };
  registry.set(ctx, system);
  return system;
}

/** Stationary-gun constants re-exported for the player and AI code. */
export { STATIONARY_GUN, stationaryGunBehind };
