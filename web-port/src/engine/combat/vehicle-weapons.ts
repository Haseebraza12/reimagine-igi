/**
 * Weapons mounted on the vehicles of missions 2-14: the AIStationaryGun
 * turrets of the APC 601_01_1 (601_02_1, gun 601_05_1 = WEAPON_ID_APC, rounds
 * = Missiles 110_02_1), the T80 614_01_1 (614_02_1, gun 614_03_1 =
 * WEAPON_ID_T80, Missiles; on it 614_10_1 with the M2HB 123_01_1) and the Mil
 * 700_01_1 (700_11_1, gun 700_12_1 = WEAPON_ID_MIL, bullets), and the Mil's
 * four RocketPods 700_09_1 (HIND rockets 700_10_1). IGI units (4096 = 1 m, z
 * up), row-major matrices (world = M local), 30 ticks/s.
 *
 * Recovered (full exe, image base 0x400000):
 *   - The vehicle's model ATTA records with a TASKTYPE_AISTATIONARYGUN /
 *     TASKTYPE_ROCKETPOD magic object become its attached children
 *     (FUN_004f4800 -> FUN_004c4950: container +0xe8, "parent" argument =
 *     the vehicle); an AIStationaryGun creates its own ATTA children the same
 *     way with ITS parent (FUN_0046eae0 -> FUN_004c4950(self, self, +0x130)),
 *     so 614_10_1 lives in 614_02_1's child list but its +0x130 is the T80.
 *   - Turret create FUN_0046eae0: +0xf0 the ATTA offset, +0x108 B (the
 *     re-orthonormalised ATTA matrix), +0x130 the vehicle, +0x1b8 the
 *     magicobj definition (FUN_0046fa50), the Gun of the weaponconfig whose
 *     Gun Model is the definition's (FUN_00413c00 / FUN_00477c50, clip = the
 *     definition's ammo), pitch / yaw / memory / spin 0, the pose
 *     FUN_0046ec90 (turret = P B Rz(yaw), gun = P B Rz(yaw + pi) Ry(spin)
 *     Rx(pitch) at the turret's magic vertex 1, P = the vehicle's matrix).
 *   - Turret update 0x46f390: the parent's "get detector" method (0x54127e:
 *     Car FUN_0042fc70 -> +0xa90, Heli FUN_00433000 -> +0x8c0, Holder
 *     FUN_0046e9e0 -> +0x168; none -> nothing at all); the first list entry
 *     (det +0x18) that is visible (+0x29) with an object; local = V^T
 *     (object +0x20 - turret +0x20), V = the PARENT's (vehicle's) matrix;
 *     then as for the holders (loaders/objects/ai-stationary-gun.ts
 *     stepAiTurret: memory 90, unwrap, slew, clamp, fire window 5 deg and
 *     min range, spin, the turning sound "tank_turret" above 2 deg), the Gun
 *     use FUN_0046f950 and the children (the Gun 0x478640: cooldown - 1; a
 *     nested turret).
 *   - Turret place 0x46fba0 (method 0x4d9fb0, called with the container's
 *     pose): position = P + Pm f32(offset); matrix = Pm B Rz(yaw); the Gun
 *     pose FUN_00470050: at position + matrix v1 (the turret model's magic
 *     vertex 1; origin without one), matrix = V Rz(yaw) Rx(pitch) [Ry(spin)
 *     when spin != 0], V = the vehicle's matrix; then the nested turrets.
 *   - Gun fire FUN_00478ba0 (through the use method 0x53f314 and the AI use
 *     FUN_00479780): no request -> shots 0; shots == burst -> no request; a
 *     shot needs cooldown 0 (and clip > 0 for a calibre); burst >= 2 ->
 *     the fire loop sound from the request's start, "Loop End" at its end
 *     (else one of the two at random per shot); muzzle = gun + M v2 (gun
 *     magic vertex 2, origin without), direction col 1, aim basis
 *     FUN_00414a60; per round the spread (minimum for the first 4 shots of a
 *     hold) r1 r2 r3 x spread / r4 x 2 pi from the level RNG (FUN_004b38e0
 *     Rz(0) Ry(az) Rx(a)); the projectile (TASKTYPE_GUNSHOT bullet,
 *     TASKTYPE_MISSILE Missile FUN_004298a0 with the weaponconfig's muzzle
 *     velocity and "Missile - Model"); cooldown fistp(60 / rpm x 30); clip -
 *     1; then FUN_00479780: the GUNSHOT AI event (team 1 without a user,
 *     flags 0x46, the weaponconfig range) at the muzzle and the view-kick
 *     draws (level RNG, unit-disc rejection).
 *   - Update order: Car FUN_0042e320 (at the Car node: "Can fire" ->
 *     perception; task children: the CarAI's input runs FUN_004f4660 (the
 *     attached children update) before the physics, which places them; then
 *     the update loop over the attached children; not driven this tick
 *     (+0x2ecc): place them and update the AIStationaryGun ones again) - so a
 *     car's turrets update twice per tick. Heli: its update FUN_004316d0 runs
 *     "Can fire" -> the perception with M Rx(-pi/2); the attached children
 *     update only in the AnimTask input with nTick > 0 (FUN_00431b70 ->
 *     FUN_004f4660, before the physics FUN_00431e30, which places them); the
 *     input with nTick 0 re-creates them (FUN_004f4820 / FUN_004f4800).
 *   - RocketPod (class FUN_00427830, 0x140 bytes): definition FUN_00427d40
 *     (param x 30 ticks: 15 -> 450); create FUN_00427940 (cooldown +0x13c =
 *     rand(450) from the level RNG, FUN_004b47c0); place FUN_00426fa0 (P +
 *     Pm offset, Pm B); update FUN_00427a70: while the cooldown is < 0, for
 *     every visible entry of the heli's perception list (+0x8d8) with an
 *     object: local = pod^T (object - pod); local.y >= 0 and |FUN_00414950|
 *     < 1.3 (double 0x533690) and the segment pod -> object clear
 *     (FUN_004ce410, filter 0x54127c) -> FUN_00429a30(Dynamic, pod, pod, pod
 *     + col1 x 2048 (f32 0x533688), the pod's matrix, heli speed x
 *     0.00732421875 (0x533684) + 5 (0x5335f8), the object's position, 0,
 *     "700_10_1", 0) and cooldown = rand(450) + 450 (the loop goes on); then
 *     cooldown - 1 every update.
 *   - The car's attacker slot +0x2ed0 (CarAI FUN_00426000): written only by
 *     the create (0x42e309) and the end of every update (0x42e586), both 0:
 *     it is always 0.
 * Inferred / approximations (labelled where used): the bullets' and rounds'
 * owner filter skips the firing vehicle's whole collision body (the exe
 * skips the gun and the turret objects; the port merges the turret into the
 * vehicle body); a turret bullet hits soldiers of every team but 1 and has
 * hit probability 1.0 against the player (no AI user); the pods' clear-line
 * test is a set-0 + terrain ray skipping the heli (FUN_004ce410's per-class
 * answers are not traced); the turret's collision stays at its build pose.
 */
import * as THREE from "three";
import { AI_GUNSHOT_RANGE, fireCooldownTicks, sampleViewKick, spreadForShot, type IgiLevel, type LevelWeapon } from "../../loaders";
import { engineMatrix4, igiPointToEngine, igiRotationToEngine } from "../../loaders/coords";
import type { Mat3 } from "../../loaders/mission";
import { aiTurretAim, aiTurretDef, newAiTurretState, stepAiTurret, type AiTurretDef, type AiTurretState } from "../../loaders/objects/ai-stationary-gun";
import { attaMatrix, eulerF, matMulF, rotY, rotZ } from "../../loaders/vehicles";
import { x87StoreF32 } from "../../loaders/x87";
import { EV } from "../ai/types";
import type { GameContext } from "../context";
import { GameEvent } from "../events";
import { createMuzzleFlash, type MuzzleFlash } from "../fx/muzzle-flash";
import { addSceneHook } from "../render/scene-hooks";
import type { CombatModelEntry } from "../render/combat-models";
import { TRI_BULLET } from "../world/collision";
import type { MountedVehicleView, MountedWeaponHooks, VehicleWorldTarget } from "../world/vehicles";
import { damageSystemOf } from "./object-damage";
import { drawPellet, spreadRadians } from "./pellet";
import { directionBasis, projectileSystemOf } from "./projectiles";
import { horizontalAngle } from "./missile";

const f32 = x87StoreF32;
type V3 = [number, number, number];
const UNITS = 4096;

/** Shooter ids of the mounted guns (Fire events, bullet sources): base + vehicle node x 16 + slot. */
export const VEHICLE_SHOOTER_BASE = 3_000_000;

export const VEHICLE_WEAPON_RULES = {
  /** RocketPod: |heading| < 1.3 rad (double 0x533690), local y >= 0 (0x5333b0). */
  podCone: 1.3,
  /** Launch point col1 x 2048 (f32 0x533688); speed = heli speed x 0.00732421875 (f32 0x533684) + 5 (f32 0x5335f8). */
  podForward: 2048,
  podSpeedK: f32(0.00732421875),
  podSpeedBase: 5,
  /** FUN_00427d40: definition param x 30 ticks. */
  podTicksPerUnit: 30,
  /** The model the pods fire (string 0x53bb60). */
  podMissile: "700_10_1",
  /** The turret gun's team for the AI events without a user (FUN_00479780). */
  team: 1,
} as const;

const W = VEHICLE_WEAPON_RULES;

/** The Gun object of a turret (class Gun 0x477e30): the fields its fire and update use. */
export interface TurretGun {
  weapon: LevelWeapon | null;
  /** "Missile - Model" when the weapon's projectile is TASKTYPE_MISSILE. */
  missileModel: string | null;
  /** +0x13c cooldown, +0x140 shots of the hold, +0x144 clip. */
  cooldown: number;
  shots: number;
  clip: number;
  /** The fire request of the last use (the loop sound is running). */
  firing: boolean;
  /** Shots fired (diagnostics). */
  rounds: number;
  /** Gun magic vertices (muzzle = vertex 2). */
  magic: V3[];
}

/** One AIStationaryGun mounted on a vehicle (or on another mounted turret). */
export interface MountedTurret {
  id: number;
  vehicleKey: number;
  /** Placed instance of the turret model and its ATTA path below the vehicle model. */
  instance: number;
  path: string;
  model: string;
  /** The container turret (null: the vehicle's own child). */
  container: MountedTurret | null;
  children: MountedTurret[];
  /** +0xf0 ATTA offset (container frame) and +0x108 B. */
  offset: V3;
  attach: Mat3;
  def: AiTurretDef;
  /** The turret model's magic vertex 1 (the Gun's pivot), origin without one. */
  pivot: V3;
  state: AiTurretState;
  /** +0x20 / +0x70. */
  position: V3;
  matrix: Mat3;
  /** The Gun's pose (+0x178 / +0x190, FUN_004f2310). */
  gunPosition: V3;
  gunMatrix: Mat3;
  gun: TurretGun;
  /** The turning sound (+0x1d0). */
  turning: { kill(): void; alive?: boolean; setPosition?(p: V3): void } | null;
  flash: MuzzleFlash | null;
  /** Updates run (diagnostics). */
  updates: number;
  /** FUN_004c4950's world matrix P B at the create (the frame its own ATTA children are made in). */
  createMatrix?: Mat3;
}

/** One RocketPod of a heli. */
export interface MountedPod {
  vehicleKey: number;
  instance: number;
  offset: V3;
  attach: Mat3;
  /** FUN_00427d40: the definition's reload, ticks. */
  reload: number;
  /** +0x13c. */
  cooldown: number;
  position: V3;
  matrix: Mat3;
  /** Rockets fired (diagnostics). */
  launches: number;
}

export interface VehicleWeapons extends MountedWeaponHooks {
  readonly turrets: readonly MountedTurret[];
  readonly pods: readonly MountedPod[];
  /** Drop every record (mission restart: the vehicle system re-creates them). */
  reset(): void;
  /** Gun models with their muzzle flashes (render/combat-models.ts). */
  models(): CombatModelEntry[];
  dispose(): void;
}

const mulVec = (m: Mat3, v: readonly number[]): V3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const tMulVec = (m: Mat3, v: readonly number[]): V3 => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];

/** FUN_00427a70's target test: local = pod^T (object - pod); in front (y >= 0) and |FUN_00414950| < 1.3. */
export function podSees(podPosition: readonly number[], podMatrix: Mat3, object: readonly number[]): boolean {
  const local = tMulVec(podMatrix, [object[0] - podPosition[0], object[1] - podPosition[1], object[2] - podPosition[2]]);
  return local[1] >= 0 && Math.abs(horizontalAngle(local)) < W.podCone;
}

/** FUN_00427a70's launch: the point col1 x 2048 ahead (float sums) and the speed heli + 5 m/s. */
export function podLaunch(podPosition: readonly number[], podMatrix: Mat3, heliSpeed: number): { position: V3; speed: number } {
  const m = podMatrix;
  return {
    position: [f32(f32(m[1] * W.podForward) + f32(podPosition[0])), f32(f32(m[4] * W.podForward) + f32(podPosition[1])), f32(f32(m[7] * W.podForward) + f32(podPosition[2]))],
    speed: f32(heliSpeed * W.podSpeedK + W.podSpeedBase),
  };
}

/** 0x46fba0's position: P + Pm f32(offset) (doubles). */
function placePoint(p: readonly number[], m: Mat3, offset: readonly number[]): V3 {
  const o = [f32(offset[0]), f32(offset[1]), f32(offset[2])];
  const d = mulVec(m, o);
  return [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
}

/** FUN_00414e20(obj, k): the object's magic vertex k in the world frame (offset), 0 beyond the count. */
function magicOffset(m: Mat3, magic: readonly V3[], k: number): V3 {
  return k < magic.length ? mulVec(m, magic[k]) : [0, 0, 0];
}

/** FUN_00470050: the Gun's pose from the turret's (vehicle matrix V). */
export function turretGunPose(t: Pick<MountedTurret, "position" | "matrix" | "pivot" | "state">, vehicle: Mat3): { position: V3; matrix: Mat3 } {
  const pv = mulVec(t.matrix, t.pivot);
  let g = matMulF(vehicle, eulerF(t.state.pitch, 0, t.state.yaw));
  if (t.state.spin !== 0) g = matMulF(g, rotY(t.state.spin));
  return { position: [t.position[0] + pv[0], t.position[1] + pv[1], t.position[2] + pv[2]], matrix: g };
}

/** 0x46fba0 (recursive): the turret at its container's pose, its Gun, its nested turrets. */
export function placeTurret(t: MountedTurret, containerPos: readonly number[], containerMatrix: Mat3, vehicle: Mat3): void {
  t.position = placePoint(containerPos, containerMatrix, t.offset);
  t.matrix = matMulF(containerMatrix, matMulF(t.attach, rotZ(t.state.yaw)));
  const g = turretGunPose(t, vehicle);
  t.gunPosition = g.position;
  t.gunMatrix = g.matrix;
  for (const c of t.children) placeTurret(c, t.position, t.matrix, vehicle);
}

/** FUN_0046eae0's pose (FUN_004c4950's world pose, then FUN_0046ec90 with the vehicle matrix). */
function createPose(t: MountedTurret, containerPos: readonly number[], containerMatrix: Mat3, vehicle: Mat3): void {
  // FUN_004c4950: the ATTA child at the container's pose; its children are made at P B (`world`).
  t.position = placePoint(containerPos, containerMatrix, t.offset);
  const world = matMulF(containerMatrix, t.attach);
  // FUN_0046ec90 (+0x70 rewritten): turret = V B Rz(yaw); gun = V B Rz(yaw + pi) Ry(spin) Rx(pitch) at the pivot.
  const turret = matMulF(vehicle, matMulF(t.attach, rotZ(t.state.yaw)));
  t.matrix = turret;
  t.createMatrix = world;
  const pv = mulVec(turret, t.pivot);
  t.gunPosition = [t.position[0] + pv[0], t.position[1] + pv[1], t.position[2] + pv[2]];
  t.gunMatrix = matMulF(vehicle, matMulF(t.attach, eulerF(t.state.pitch, t.state.spin, f32(t.state.yaw + Math.fround(Math.PI)))));
}

export function createVehicleWeapons(ctx: GameContext): VehicleWeapons {
  let turrets: MountedTurret[] = [];
  let pods: MountedPod[] = [];
  let builtFor: IgiLevel | null = null;
  const byVehicle = new Map<number, { turrets: MountedTurret[]; pods: MountedPod[]; view: MountedVehicleView }>();
  const origin = () => ctx.level?.originIgi ?? [0, 0, 0];
  const toEngine = (p: readonly number[]): V3 => {
    const o = origin();
    return [(p[0] - o[0]) / UNITS, (p[2] - o[2]) / UNITS, -(p[1] - o[1]) / UNITS];
  };
  const igiDirToEngine = (d: readonly number[]): V3 => [d[0], d[2], -d[1]];

  const ensureLevel = () => {
    if (builtFor !== ctx.level) {
      for (const t of turrets) t.turning?.kill();
      turrets = [];
      pods = [];
      byVehicle.clear();
      builtFor = ctx.level;
    }
  };

  /** A model's magic vertices (XTVM): the level's vehicle model data, else the damage data's bounds. */
  const magicOf = (level: IgiLevel, model: string): V3[] => {
    const m = level.vehicles?.models.get(model)?.magicVertices ?? damageSystemOf(ctx)?.data?.bounds.get(model.toLowerCase())?.magic ?? [];
    return m.map((x) => [x[0], x[1], x[2]] as V3);
  };

  /** The ATTA record at `path` below `model` (its model name, offset and B). */
  function attaAt(level: IgiLevel, model: string, path: string): { name: string; offset: V3; attach: Mat3; parentPath: string } | null {
    const parts = path.split("/").filter((p) => p !== "");
    let current = model;
    let record: { name: string; position: number[]; matrix: number[] } | null = null;
    for (const part of parts) {
      const a = level.vehicles?.models.get(current)?.attachments[Number(part)];
      if (!a) return null;
      record = a as unknown as { name: string; position: number[]; matrix: number[] };
      current = a.name;
    }
    if (!record) return null;
    return { name: record.name, offset: [record.position[0], record.position[1], record.position[2]], attach: attaMatrix(record.matrix), parentPath: parts.slice(0, -1).join("/") };
  }

  function gunFor(def: AiTurretDef): TurretGun {
    const level = ctx.level!;
    const weapon = [...level.weapons.values()].find((w) => w.gunModel?.toLowerCase() === def.gunModel.toLowerCase()) ?? null;
    const missileModel = weapon ? projectileSystemOf(ctx).missileModelOf(weapon.scriptId) : null;
    return { weapon, missileModel, cooldown: 0, shots: 0, clip: def.ammo, firing: false, rounds: 0, magic: magicOf(level, def.gunModel) };
  }

  /** FUN_004f4800 for a vehicle: its turrets (and their nested ones) and pods, at the current pose. */
  function create(v: MountedVehicleView): void {
    ensureLevel();
    const level = ctx.level;
    if (!level) return;
    const old = byVehicle.get(v.key);
    if (old) {
      // The old children are deleted (FUN_004f4820): their sounds stop.
      for (const t of old.turrets) {
        t.turning?.kill();
        if (t.gun.firing && t.gun.weapon) ctx.events.emit(GameEvent.FireStopped, { weaponId: t.gun.weapon.scriptId, shooter: t.id, position: toEngine(t.gunPosition) });
      }
      turrets = turrets.filter((t) => t.vehicleKey !== v.key);
      pods = pods.filter((p) => p.vehicleKey !== v.key);
    }
    const mine: MountedTurret[] = [];
    const myPods: MountedPod[] = [];
    const byPath = new Map<string, MountedTurret>();
    level.instances.forEach((inst, i) => {
      if (inst.taskIndex !== v.key) return;
      const path = inst.attachmentPath ?? "";
      if (inst.magicType === "TASKTYPE_AISTATIONARYGUN") {
        const args = level.aiTurretDefs?.get(inst.model.toLowerCase());
        const def = args ? aiTurretDef(args) : null;
        const a = attaAt(level, v.model, path);
        if (!def || !a) return;
        const magic = magicOf(level, inst.model);
        const t: MountedTurret = {
          id: VEHICLE_SHOOTER_BASE + v.key * 16 + (mine.length & 15), vehicleKey: v.key, instance: i, path, model: inst.model, container: null, children: [],
          offset: a.offset, attach: a.attach, def, pivot: magic[1] ? [...magic[1]] as V3 : [0, 0, 0], state: newAiTurretState(),
          position: [0, 0, 0], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], gunPosition: [0, 0, 0], gunMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          gun: gunFor(def), turning: null, flash: null, updates: 0,
        };
        t.flash = t.gun.weapon ? createMuzzleFlash(level, t.gun.weapon.scriptId) : null;
        byPath.set(path, t);
        mine.push(t);
      } else if (inst.magicType === "TASKTYPE_ROCKETPOD" && v.kind === "heli") {
        const a = attaAt(level, v.model, path);
        const param = level.vehicles?.magic.get(inst.model.toLowerCase())?.params[0] ?? 0;
        if (!a) return;
        const reload = Math.trunc(param) * W.podTicksPerUnit;
        const pod: MountedPod = {
          vehicleKey: v.key, instance: i, offset: a.offset, attach: a.attach, reload,
          // FUN_00427940: +0x13c = FUN_004b47c0(level RNG, reload).
          cooldown: reload > 0 ? ctx.rng.int(reload) : 0,
          position: placePoint(v.position, v.matrix, a.offset), matrix: matMulF(v.matrix, a.attach), launches: 0,
        };
        myPods.push(pod);
      }
    });
    // Containers: a turret whose ATTA path continues another turret's lives in its child list.
    for (const t of mine) {
      const parentPath = t.path.includes("/") ? t.path.slice(0, t.path.lastIndexOf("/")) : null;
      const c = parentPath !== null ? byPath.get(parentPath) ?? null : null;
      if (c) {
        t.container = c;
        c.children.push(t);
      }
    }
    // FUN_0046eae0's pose, top-down (a nested turret is created inside its container's create).
    const createRec = (t: MountedTurret, pos: readonly number[], m: Mat3) => {
      createPose(t, pos, m, v.matrix);
      for (const c of t.children) createRec(c, t.position, t.createMatrix ?? t.matrix);
    };
    for (const t of mine) if (!t.container) createRec(t, v.position, v.matrix);
    turrets.push(...mine);
    pods.push(...myPods);
    byVehicle.set(v.key, { turrets: mine, pods: myPods, view: v });
  }

  /** The turning sound (FUN_004e6b00 / FUN_004e6c30 / FUN_004e6c00). */
  function turningSound(t: MountedTurret, on: boolean): void {
    const audio = ctx.systems.audio as { playAt?(n: string, p: V3): MountedTurret["turning"] } | null;
    if (on) {
      if (!t.turning || t.turning.alive === false) t.turning = t.def.sound ? audio?.playAt?.(t.def.sound, toEngine(t.position)) ?? null : null;
      else t.turning.setPosition?.(toEngine(t.position));
    } else if (t.turning) {
      t.turning.kill();
      t.turning = null;
    }
  }

  /** FUN_00478ba0 + FUN_00479780 for a turret's Gun (`request` = FUN_0046f950's flag). */
  function fireGun(t: MountedTurret, v: MountedVehicleView, request: boolean): void {
    const g = t.gun;
    const w = g.weapon;
    if (!w) return;
    let req = request;
    if (!req) g.shots = 0;
    else if (g.shots === w.maxRoundsPerBurst) req = false;
    let shot = req && g.cooldown === 0;
    if (w.calibreId > 0 && g.clip === 0) shot = req = false;
    const muzzleOff = magicOffset(t.gunMatrix, g.magic, 2);
    const muzzle: V3 = [t.gunPosition[0] + muzzleOff[0], t.gunPosition[1] + muzzleOff[1], t.gunPosition[2] + muzzleOff[2]];
    const at = toEngine(muzzle);
    if (!req && g.firing) {
      g.firing = false;
      ctx.events.emit(GameEvent.FireStopped, { weaponId: w.scriptId, shooter: t.id, position: at });
    }
    if (!shot) return;
    g.firing = true;
    ctx.events.emit(GameEvent.Fire, { weaponId: w.scriptId, shooter: t.id, position: at });
    t.flash?.fire();
    const dir: V3 = [t.gunMatrix[1], t.gunMatrix[4], t.gunMatrix[7]];
    const basis = directionBasis(dir) as Mat3;
    const spread = spreadRadians(spreadForShot(w.minSpread, w.maxSpread, g.shots));
    for (let k = 0; k < Math.max(1, w.bulletsPerRound); k++) {
      let aim = basis;
      if (spread !== 0) {
        const p = drawPellet(spread, () => ctx.rng.float());
        aim = matMulF(basis, eulerF(p.angle, p.azimuth, 0));
      }
      if (g.missileModel) {
        projectileSystemOf(ctx).spawnMissile({
          position: muzzle, matrix: aim, muzzleVelocity: w.muzzleVelocity, model: g.missileModel, owner: t.id, sourceWeaponId: w.weaponNumber, skipBody: v.key,
        });
      } else {
        ctx.systems.enemies?.shootAs({ team: W.team, hitProbability: 1, id: t.id }, w, at, igiDirToEngine([aim[1], aim[4], aim[7]]));
      }
    }
    g.shots++;
    g.rounds++;
    g.cooldown = fireCooldownTicks(w.roundsPerMinute);
    if (w.calibreId > 0 && g.clip > 0) g.clip--;
    ctx.systems.enemies?.broadcast({ type: EV.GUNSHOT, team: W.team, flags: 0x46, range: AI_GUNSHOT_RANGE, position: muzzle, source: null, other: null });
    sampleViewKick({ kickFixedXDeg: w.recoilPitch, kickRandomXDeg: w.recoilPitchRandom, kickFixedZDeg: w.recoilYaw, kickRandomZDeg: w.recoilYawRandom }, () => ctx.rng.float());
  }

  /** The first visible entry of the vehicle's perception list with an object, and its position. */
  function firstTarget(v: MountedVehicleView): V3 | null {
    const det = v.detector;
    for (const key of det.list) {
      if (!det.slots.get(key)?.visible) continue;
      const p = v.targetPosition(key);
      if (p) return [p[0], p[1], p[2]];
    }
    return null;
  }

  /** 0x46f390. */
  function updateTurret(t: MountedTurret, v: MountedVehicleView): void {
    t.updates++;
    const target = firstTarget(v);
    const aim = target ? aiTurretAim(v.matrix, t.position, target) : null;
    const r = stepAiTurret(t.def, t.state, aim);
    fireGun(t, v, r.fire);
    turningSound(t, r.turning);
    // The children: the Gun (0x478640: cooldown - 1), then the nested turrets.
    if (t.gun.cooldown !== 0) t.gun.cooldown--;
    for (const c of t.children) updateTurret(c, v);
  }

  /** FUN_004ce410 for a pod: the segment pod -> object, set 0 + terrain, the heli skipped [inferred]. */
  function podClear(v: MountedVehicleView, from: V3, to: V3): boolean {
    const w = ctx.world;
    if (!w) return true;
    const a = toEngine(from);
    const b = toEngine(to);
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    if (!(len > 0)) return true;
    return w.raycast(a[0], a[1], a[2], d[0] / len, d[1] / len, d[2] / len, len, TRI_BULLET, undefined, v.key) === null;
  }

  /** FUN_00427a70. */
  function updatePod(p: MountedPod, v: MountedVehicleView): void {
    if (p.cooldown < 0) {
      const det = v.detector;
      for (const key of [...det.list]) {
        if (!det.slots.get(key)?.visible) continue;
        const obj = v.targetPosition(key);
        if (!obj || !podSees(p.position, p.matrix, obj)) continue;
        if (!podClear(v, p.position, [obj[0], obj[1], obj[2]])) continue;
        const launch = podLaunch(p.position, p.matrix, v.speed);
        projectileSystemOf(ctx).spawnMissile({
          position: launch.position, matrix: [...p.matrix] as Mat3, muzzleVelocity: launch.speed, model: W.podMissile,
          owner: VEHICLE_SHOOTER_BASE + v.key * 16 + 15, sourceWeaponId: null, target: [obj[0], obj[1], obj[2]], skipBody: v.key,
        });
        p.launches++;
        p.cooldown = (p.reload > 0 ? ctx.rng.int(p.reload) : 0) + p.reload;
      }
    }
    p.cooldown -= 1;
  }

  function update(v: MountedVehicleView, turretsOnly = false): void {
    const mine = byVehicle.get(v.key);
    if (!mine || v.exploded) return;
    for (const t of mine.turrets) if (!t.container) updateTurret(t, v);
    if (!turretsOnly) for (const p of mine.pods) updatePod(p, v);
  }

  function place(v: MountedVehicleView): void {
    const mine = byVehicle.get(v.key);
    if (!mine || v.exploded) return;
    for (const t of mine.turrets) if (!t.container) placeTurret(t, v.position, v.matrix, v.matrix);
    for (const p of mine.pods) {
      p.position = placePoint(v.position, v.matrix, p.offset);
      p.matrix = matMulF(v.matrix, p.attach);
    }
  }

  const buildInverse = new Map<number, THREE.Matrix4>();
  function sync(v: MountedVehicleView, world: VehicleWorldTarget): void {
    const mine = byVehicle.get(v.key);
    const level = ctx.level;
    if (!mine || !level || v.exploded) return;
    const o = level.originIgi;
    for (const t of mine.turrets) {
      let inv = buildInverse.get(t.instance);
      if (!inv) {
        inv = new THREE.Matrix4().fromArray(level.instances[t.instance].matrix).invert();
        buildInverse.set(t.instance, inv);
      }
      const now = new THREE.Matrix4().fromArray(engineMatrix4(igiRotationToEngine(t.matrix as Mat3), igiPointToEngine(t.position, o)));
      world.setInstanceTransform(t.instance, now.multiply(inv).elements);
    }
  }

  const flashHook = ctx.scene ? addSceneHook(ctx.scene, () => {
    for (const t of turrets) t.flash?.update();
  }) : null;

  return {
    get turrets() {
      return turrets;
    },
    get pods() {
      return pods;
    },
    create,
    update,
    place,
    sync,
    reset() {
      // A restart rebuilds the vehicle system, whose compiles re-create every record (create());
      // records of another level go with ensureLevel. Only the flashes restart here.
      for (const t of turrets) t.flash?.reset();
      buildInverse.clear();
    },
    models() {
      const out: CombatModelEntry[] = [];
      const tasks = ctx.systems.tasks as { inWorldNode?(n: number): boolean } | null;
      for (const t of turrets) {
        if (tasks?.inWorldNode && !tasks.inWorldNode(t.vehicleKey)) continue;
        if (byVehicle.get(t.vehicleKey)?.view.exploded) continue;
        out.push({ key: `vgun:${t.vehicleKey}:${t.path}`, model: t.def.gunModel, position: t.gunPosition, matrix: t.gunMatrix, children: t.flash ? [t.flash.object] : [] });
      }
      return out;
    },
    dispose() {
      for (const t of turrets) {
        t.turning?.kill();
        t.flash?.dispose();
      }
      flashHook?.();
      turrets = [];
      pods = [];
      byVehicle.clear();
    },
  };
}
