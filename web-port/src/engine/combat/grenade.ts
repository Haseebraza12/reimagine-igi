/**
 * Thrown hand grenades and flashbangs, as igi.exe's "Grenade" class runs them
 * (docs/damage.md "Grenade flight", docs/weapons-view.md S7). Shared by the
 * player's S7 throw (combat/weapon.ts) and the soldiers' throw (combat/enemy.ts).
 * Positions in IGI units (z up), velocities in units/tick, 30 ticks/s.
 *
 * Recovered (igi.exe, image base 0x400000):
 *   - Class "Grenade" (0x738 bytes, registered by FUN_00474e70 as
 *     TASKTYPE_GRENADE) derives from PhysicsObj (FUN_004f2200): init
 *     LAB_004750f0, update FUN_004751f0, destroy FUN_00475580, bullet method
 *     0x4755c0 (fuse = 0), explosion method FUN_004755d0 (fuse = 0 when the
 *     factor is non-zero), projectile spawn FUN_004756c0, weaponconfig tag
 *     reader FUN_00474fe0 ("Grenade - Explosion damage factor / radius /
 *     falloff", defaults 1 / 5 m / 0 m), type-parameter reader FUN_00475690
 *     (DefinePhysicsObjType tail: fuse seconds, GRENADE_EXPLOSIONTYPE_*).
 *     No draw method: drawn like any rigid object (DrawRigidMesh of its model).
 *   - Create FUN_00475760(parent, owner, position, matrix, velocity,
 *     weaponconfig, cooked): model = weaponconfig +0x61c ("Gun Model"),
 *     physics type = the DefinePhysicsObjType whose model is that name
 *     (FUN_004e4cc0); fuse +0x720 = max(0, -fistp(fuse x -30) - cooked);
 *     velocity copied to the body, angular momentum 0; then the AI event
 *     GRENADETHROWN (17, team -1, flags 1, range -1; FUN_00475470).
 *   - Update FUN_004751f0: fuse != 0 -> fuse - 1, physics step FUN_004754c0,
 *     bounce sound FUN_004753f0; fuse == 0 -> explode and delete. The object
 *     is a child of the Dynamic task: its first update is in the tick that
 *     created it, so a fuse of F explodes on the (F + 1)th update.
 *   - Physics step FUN_004754c0: nothing while at rest (FUN_004f33d0:
 *     contacts > 0, no pending force, speed < type +0x2cc and |w|^2 < +0x2d0);
 *     else FUN_004f2d00(obj, g = 44.600887, linear 1.0, angular 0.92) and,
 *     with no contact this tick, v x 0.985 (0x53212c).
 *   - FUN_004f2d00: FUN_004f2bb0 (force -(g m) along world z, FUN_004e3220
 *     integration, L x angular, v x linear); FUN_004f25c0 (contact points:
 *     the first point whose path P -> P + (v + w x r) crosses a face with an
 *     approaching normal speed <= -1 gets the impulse FUN_004f3500 with the
 *     point's restitution and the friction FUN_004f38c0; one contact per
 *     tick); position += v only when speed > 40.96 (0x531730); FUN_004f3240
 *     (a point whose upward 5 m ray first meets a back face is inside: the
 *     pose goes back to the previous tick's, velocity kept).
 *   - Rays: FUN_004c24c0 / FUN_004c1c10 = HSMC set 0 of the objects + terrain
 *     (port: TRI_BULLET), filter 0x537430 (humans, pickups, other grenades,
 *     guns, wires skipped). The face normal is the outward (c - a) x (b - a).
 *   - Bounce sound FUN_004753f0: with a contact and armed: "grenade_bnc_1" at
 *     the grenade and AI GRENADELAND (18, team -1, flags 2, 5 m); disarmed
 *     until a contact-free tick more than 10 ticks after the last sound.
 *   - Explosion FUN_004751f0: GRENADE_EXPLOSIONTYPE_NORMAL -> FUN_0047f350(
 *     pos, 1, 1, damage, radius, falloff, 6144, 3, 1, surface 0.5 m below,
 *     1009_01_1, explo_02_m, 21, 2, 40960); FLASHBANG -> FUN_0047cd10 (a
 *     flash on every human, no damage). Without weaponconfig tags: 1, 5 m, 0
 *     (flash: 5 m, 10 m).
 *   - Player throw speed (FUN_00461a90): (pow(50 h, 0.7) + 0.1 h) x Muzzle
 *     Velocity along the view's forward axis, h = cook ticks (human +0x4e0)
 *     clamped to [3, 60]; spawn at the eye. The cooked ticks passed to the
 *     grenade come from the owner's method DAT_005c1768, which only class
 *     Human registers (0x4feb90: writes 0): the fuse is always the full 4 s.
 *   - Soldier throw (state 8 FUN_0045a170 -> FUN_00451740): fly = r x random
 *     + min (s), T = fly x 30 ticks, v = 1.1 d / T + (0, 0, 22.300444 T) with
 *     d = aim point (FUN_00450150) - release point; cooked =
 *     fistp(r x random x 30 + min) (the explode minimum is added in seconds,
 *     unscaled, as the exe does).
 * Inferred / not modelled (labelled where used):
 *   - The player's grenade starts with the view orientation (the exe passes
 *     the held gun's matrix +0x70); a soldier's with its body heading (the
 *     exe builds it from the AI frame and an aim angle, FUN_00451740).
 *   - The soldier release point is the hand (gun bone); the exe reads it
 *     from [human +0x70] +0x858, not decoded.
 *   - Bullets do not hit flying grenades (bullet method 0x4755c0 would set
 *     the fuse to 0); the glass contact callback (DAT_0054a556) is not
 *     modelled, so grenades bounce off glass.
 */
import type { Vec3 } from "../../contracts";
import type { IgiLevel } from "../../loaders";
import { RigidBody, VEHICLE_GRAVITY, type PhysicsObjType } from "../../loaders/vehicles";
import { x87StoreF32 } from "../../loaders/x87";
import type { Mat3 } from "../../loaders/coords";
import type { GameContext } from "../context";
import { EV, type AiEvent } from "../ai/types";
import { TRI_BULLET } from "../world/collision";
import { DAMAGE_EVENTS, damageSystemOf, type DamageSystem, type ExplosionHuman } from "./object-damage";
import { EXPLOSION_SCORCH, GRENADE_AI_RANGE, explosionFactor } from "./explosion-rules";

const f32 = x87StoreF32;
type V3 = [number, number, number];
const UNITS = 4096;

// --- Constants [recovered] -----------------------------------------------------

export const GRENADE_CONSTANTS = {
  /** FUN_004754c0 -> FUN_004f2d00 arguments: gravity (0x4232674f), linear and angular damping. */
  gravity: VEHICLE_GRAVITY,
  linearDamping: 1,
  angularDamping: Math.fround(0.92),
  /** Air drag on a tick without contact (f32 0x53212c). */
  airDrag: Math.fround(0.985),
  /** The position moves only above this speed, units/tick (f32 0x531730). */
  moveThreshold: Math.fround(40.96),
  /** FUN_004f3490: separating above 1.0 (0x5313e0), impact at or below -1.0 (0x53167c). */
  separating: 1,
  impact: -1,
  /** FUN_004f38c0: friction direction needs |v^ x n| >= 1e-5 (f32 0x532a70). */
  frictionEpsilon: Math.fround(9.999999747378752e-6),
  /** FUN_004f3240: upward inside-test ray per point, units (double 0x40d40000_00000000). */
  insideRay: 20480,
  /** Fuse seconds x 30 (f32 0x5313bc / -30 0x5319b0). */
  ticksPerSecond: 30,
  /** Bounce sound re-arm: more than 10 ticks after the last sound without contact (FUN_004753f0). */
  bounceRearmTicks: 10,
  bounceSound: "grenade_bnc_1",
  /** GRENADELAND: 5 m (0x46a00000), flags 2; GRENADETHROWN: flags 1, range -1 (FUN_00475470). */
  landRange: 20480,
  /** Scorch target: the surface within 0.5 m below (FUN_004c0e10 with -2048, double 0xc0a00000_00000000). */
  scorchRay: 2048,
  /** Weaponconfig tag defaults (FUN_00474fe0): damage 1, radius 5 m, falloff 0. */
  tagDefaults: { damage: 1, radiusM: 5, falloffM: 0 },
  /** No weaponconfig at all (FUN_004751f0): normal 1 / 20480 / 0; flash 20480 / 40960. */
  noConfig: { damage: 1, radius: 20480, falloff: 0, flashRadius: 20480, flashFalloff: 40960 },
  /** Player throw (FUN_00461a90): hold ticks clamped to [3, 60] (doubles 0x531810, 0x531490), x 50 (0x5319a8), ^0.7 (0x5319a0), + 0.1 h (f32 0x5313c8). */
  throwHoldMin: 3,
  throwHoldMax: 60,
  throwHoldScale: 50,
  throwExponent: 0.7,
  throwLinear: Math.fround(0.1),
  /** Soldier throw (FUN_00451740): x 1.1 (double 0x531900), g / 2 = 22.300444 (double 0x5318f8). */
  soldierAimScale: 1.1,
  soldierHalfGravity: 22.300444444444445,
} as const;

const C = GRENADE_CONSTANTS;

// --- Types -----------------------------------------------------------------------

/** One contact point of the physics type (DefinePhysicsObjType record, FUN_004f2320). */
export interface GrenadePoint {
  /** Model-local position (the model's magic vertex), units. */
  local: V3;
  /** +0x158 -> point +0x1c4: restitution of FUN_004f3500. */
  restitution: number;
  /** +0x160 -> point +0x1dc: friction coefficient of FUN_004f38c0. */
  grip: number;
}

/** The DefinePhysicsObjType of a grenade model (TASKTYPE_GRENADE) with its model's data. */
export interface GrenadeType {
  model: string;
  mass: number;
  /** Box size, metres (inertia). */
  size: V3;
  points: GrenadePoint[];
  /** +0x2cc / +0x2d0: rest thresholds. */
  restSpeed: number;
  restAngular: number;
  /** Type tail (FUN_00475690): fuse seconds and explosion type (0 normal, 1 flashbang). */
  fuseSeconds: number;
  explosion: 0 | 1;
  /** Model origin radius (FUN_004c59a0), units: the explosion-method target radius. */
  originRadius: number;
}

/** Weaponconfig "Grenade - Explosion ..." tags (+0x6e0: damage, radius, falloff). */
export interface GrenadeTags {
  damage: number;
  radiusM: number;
  falloffM: number;
}

export interface GrenadeSpawn {
  weaponId: string;
  /** Weaponconfig "Gun Model" (+0x61c): the model drawn and the physics type's key. */
  model: string;
  /** IGI units. */
  position: V3;
  /** IGI row-major rotation (world = M local). */
  matrix: Mat3;
  /** Units per tick. */
  velocity: V3;
  /** FUN_00475760 argument 7: ticks taken off the fuse. */
  cooked: number;
  /** Weaponconfig tags, or null for "no weaponconfig" (FUN_004751f0's fallback). */
  tags: GrenadeTags | null;
  /** "player" or the soldier's enemy id (diagnostics). */
  thrower: "player" | number;
}

export interface Grenade {
  readonly id: number;
  readonly weaponId: string;
  readonly model: string;
  readonly type: GrenadeType;
  readonly tags: GrenadeTags | null;
  readonly thrower: "player" | number;
  position: V3;
  matrix: Mat3;
  readonly body: RigidBody;
  /** +0x6c0 / +0x694: pose at the end of the previous step. */
  previousPosition: V3;
  previousMatrix: Mat3;
  /** +0x1b8: contacts of the last step. */
  contacts: number;
  /** +0x1d6 per point: the point touched in the last step. */
  touching: boolean[];
  /** +0x720 */
  fuse: number;
  /** +0x728 (sound played, disarmed) and +0x724 (tick of the last sound). */
  bouncePlayed: boolean;
  lastBounceTick: number;
  /** Updates run (diagnostics). */
  updates: number;
  exploded: boolean;
}

/** Ray queries of the step, IGI units. */
export interface GrenadeWorld {
  /** Nearest set-0 / terrain hit of the segment `from` -> `to`, with the face's outward unit normal. */
  segment(from: V3, to: V3): { distance: number; normal: V3; front: boolean } | null;
  /** FUN_004f3240's test: the first hit of the 5 m upward ray from `p` is a back face. */
  inside(p: V3, length: number): boolean;
}

// --- Type data -----------------------------------------------------------------------

/**
 * The grenade type for a weapon model: the DefinePhysicsObjType (TASKTYPE_GRENADE)
 * whose model is `model`, its points at the model's magic vertices.
 */
export function grenadeTypeFor(
  types: readonly PhysicsObjType[],
  model: string,
  magic: readonly (readonly number[])[] | null,
  originRadius: number,
): GrenadeType | null {
  const t = types.find((x) => x.taskType === "TASKTYPE_GRENADE" && x.model.toLowerCase() === model.toLowerCase());
  if (!t) return null;
  const raw = "raw" in t.config ? t.config.raw : [];
  const fuse = typeof raw[0] === "number" ? Math.fround(raw[0]) : 4;
  const kind = raw[1];
  const sym = typeof kind === "object" && kind !== null && "symbol" in kind ? kind.symbol : "";
  return {
    model: t.model,
    mass: t.mass,
    size: [...t.size] as V3,
    // FUN_004c5a30: the point's magic vertex; [inferred] the origin when the model has none.
    points: t.points.map((p) => ({ local: (magic?.[p.vertex] ? [...magic[p.vertex]] : [0, 0, 0]) as V3, restitution: p.c, grip: p.gripRolling })),
    restSpeed: t.restSpeed,
    restAngular: t.restAngular,
    fuseSeconds: fuse,
    explosion: sym === "GRENADE_EXPLOSIONTYPE_FLASHBANG" ? 1 : 0,
    originRadius,
  };
}

/** Fuse ticks of a new grenade: max(0, -fistp(fuse x -30) - cooked) (FUN_00475760; FPU in chop mode). */
export function grenadeFuseTicks(fuseSeconds: number, cooked: number): number {
  const fuse = -Math.trunc(Math.fround(fuseSeconds) * -C.ticksPerSecond) - cooked;
  return fuse < 0 ? 0 : fuse;
}

/** FUN_00461a90: the player's throw speed, units/tick, for `hold` ticks since the pin was pulled. */
export function playerThrowSpeed(hold: number, muzzleVelocity: number): number {
  const h = Math.fround(Math.min(Math.max(hold, C.throwHoldMin), C.throwHoldMax));
  return (Math.pow(h * C.throwHoldScale, C.throwExponent) + h * C.throwLinear) * Math.fround(muzzleVelocity);
}

/** FUN_00461a90: velocity = speed x the view's forward axis (column 1), stored as floats. */
export function playerThrowVelocity(hold: number, muzzleVelocity: number, forward: V3): V3 {
  const s = playerThrowSpeed(hold, muzzleVelocity);
  return [f32(s * forward[0]), f32(s * forward[1]), f32(s * forward[2])];
}

/** FUN_00451740: the soldier's throw velocity reaching `target` from `from` in `flySeconds`. */
export function soldierThrowVelocity(from: V3, target: V3, flySeconds: number): V3 {
  const t = f32(Math.fround(flySeconds) * C.ticksPerSecond);
  const dx = (target[0] - from[0]) * C.soldierAimScale;
  const dy = (target[1] - from[1]) * C.soldierAimScale;
  const dz = (target[2] - from[2]) * C.soldierAimScale;
  return [f32(dx / t), f32(dy / t), f32(dz / t + t * C.soldierHalfGravity)];
}

// --- Physics (FUN_004f2d00 and friends) ----------------------------------------------

function cross(a: readonly number[], b: readonly number[]): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** M p, each component stored as a float (FUN_004f25c0). */
function rotate(m: Mat3, p: readonly number[]): V3 {
  return [f32(m[2] * p[2] + m[1] * p[1] + m[0] * p[0]), f32(m[5] * p[2] + m[4] * p[1] + m[3] * p[0]), f32(m[8] * p[2] + m[7] * p[1] + m[6] * p[0])];
}

/** FUN_004f33d0. */
export function grenadeAtRest(g: Grenade): boolean {
  const w = g.body.angularVelocity;
  return g.contacts > 0 && g.body.forces.length === 0 && g.body.speed < g.type.restSpeed && f32(w[0] * w[0] + w[1] * w[1] + w[2] * w[2]) < g.type.restAngular;
}

/** FUN_004f3500: impulse -(1 + e) vn / (1/m + n . ((I^-1 (r x n)) x r)) along n at the point r. */
function impulse(b: RigidBody, m: Mat3, n: V3, r: V3, vn: number, e: number): void {
  const a = cross(r, n);
  const bl: V3 = [a[0] * m[0] + a[1] * m[3] + a[2] * m[6], a[0] * m[1] + a[1] * m[4] + a[2] * m[7], a[0] * m[2] + a[1] * m[5] + a[2] * m[8]];
  const c: V3 = [b.invInertia[0] * bl[0], b.invInertia[1] * bl[1], b.invInertia[2] * bl[2]];
  const d: V3 = [c[2] * m[2] + c[0] * m[0] + c[1] * m[1], c[2] * m[5] + c[0] * m[3] + c[1] * m[4], c[2] * m[8] + c[0] * m[6] + c[1] * m[7]];
  const denom = (d[0] * r[1] - d[1] * r[0]) * n[2] + (d[1] * r[2] - d[2] * r[1]) * n[0] - (d[0] * r[2] - d[2] * r[0]) * n[1] + b.invMass;
  const j = -((e + 1) * vn) / denom;
  const J: V3 = [n[0] * j, n[1] * j, n[2] * j];
  const tau = cross(r, J);
  const L: V3 = [
    f32(tau[0] * m[0] + tau[1] * m[3] + tau[2] * m[6] + b.angularMomentum[0]),
    f32(tau[0] * m[1] + tau[1] * m[4] + tau[2] * m[7] + b.angularMomentum[1]),
    f32(tau[1] * m[5] + tau[2] * m[8] + tau[0] * m[2] + b.angularMomentum[2]),
  ];
  b.angularMomentum = L;
  const wl: V3 = [f32(b.invInertia[0] * L[0]), f32(b.invInertia[1] * L[1]), f32(b.invInertia[2] * L[2])];
  b.angularVelocity = [
    f32(m[2] * wl[2] + m[0] * wl[0] + m[1] * wl[1]),
    f32(wl[0] * m[3] + wl[2] * m[5] + m[4] * wl[1]),
    f32(wl[0] * m[6] + wl[2] * m[8] + m[7] * wl[1]),
  ];
  b.velocity = [f32(b.velocity[0] + J[0] * b.invMass), f32(b.velocity[1] + J[1] * b.invMass), f32(b.velocity[2] + J[2] * b.invMass)];
  b.updateSpeed();
}

/** FUN_004f38c0: Coulomb friction against the tangential velocity (limit g |n.z| grip per tick), then L x angular. */
function friction(b: RigidBody, n: V3, g: number, grip: number, angular: number): void {
  let normal = g * n[2];
  if (normal < 0) normal = -normal;
  if (normal === 0) return;
  const u = b.velocityDir;
  let a: V3 = [u[1] * n[2] - u[2] * n[1], -(u[0] * n[2] - u[2] * n[0]), u[0] * n[1] - u[1] * n[0]];
  const len = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  let t: V3 = [0, 0, 0];
  if (C.frictionEpsilon <= len) {
    if (a[0] !== 0 || a[1] !== 0 || a[2] !== 0) a = [a[0] / len, a[1] / len, a[2] / len];
    t = [a[1] * n[2] - a[2] * n[1], -(a[0] * n[2] - a[2] * n[0]), a[0] * n[1] - a[1] * n[0]];
  }
  const s = t[1] * b.velocity[1] + t[2] * b.velocity[2] + t[0] * b.velocity[0];
  const limit = normal * grip;
  const k = Math.abs(s) < limit ? Math.abs(s) : limit;
  b.velocity = [f32(t[0] * k + b.velocity[0]), f32(t[1] * k + b.velocity[1]), f32(k * t[2] + b.velocity[2])];
  b.updateSpeed();
  b.angularMomentum = [f32(b.angularMomentum[0] * angular), f32(b.angularMomentum[1] * angular), f32(b.angularMomentum[2] * angular)];
}

/**
 * A rigid object stepped by the physics-object step (demo FUN_004f2d00 = full exe FUN_004fc0e0):
 * grenades and (turrets) the Missile. Its contact points are the type's (magic vertices).
 */
export interface RigidStepObject {
  position: V3;
  matrix: Mat3;
  readonly body: RigidBody;
  previousPosition: V3;
  previousMatrix: Mat3;
  contacts: number;
  touching: boolean[];
  readonly type: { readonly mass: number; readonly points: readonly GrenadePoint[] };
}

/** FUN_004f25c0: the contact points' paths; the first approaching hit gets the impulse and friction. */
function contactPass(g: RigidStepObject, world: GrenadeWorld, angular: number): void {
  const points = g.type.points;
  if (points.length === 0) return;
  const b = g.body;
  g.contacts = 0;
  g.touching.fill(false);
  for (let i = 0; i < points.length; i++) {
    const r = rotate(g.matrix, points[i].local);
    const p0: V3 = [g.position[0] + r[0], g.position[1] + r[1], g.position[2] + r[2]];
    const u = b.pointVelocity(r);
    const p1: V3 = [u[0] + p0[0], u[1] + p0[1], u[2] + p0[2]];
    const hit = world.segment(p0, p1);
    if (!hit) continue;
    const n = hit.normal;
    // FUN_004f3490: normal speed of the point.
    const vn = f32(u[0] * n[0] + u[1] * n[1] + u[2] * n[2]);
    if (C.separating < vn || !(vn <= C.impact)) continue;
    g.contacts++;
    g.touching[i] = true;
    impulse(b, g.matrix, n, r, vn, points[i].restitution);
    friction(b, n, C.gravity, points[i].grip, angular);
    return;
  }
}

/**
 * The physics-object step FUN_004f2d00 (demo) / FUN_004fc0e0 (full exe) with collision on
 * (+0x6d8, the default of FUN_004fb5f0): FUN_004f2bb0 / FUN_004fbf90 (weight -(g m) along world z
 * in the body frame, integrate, L x angular, v x linear), the contact pass FUN_004f25c0 /
 * FUN_004fb9a0, position += v above 40.96 units/tick, the inside test FUN_004f3240 /
 * FUN_004fc620 (back to the previous pose, contact + 1) [recovered].
 */
export function stepRigidObject(g: RigidStepObject, world: GrenadeWorld, linear: number, angular: number): void {
  const b = g.body;
  const m = g.matrix;
  const old: V3 = [...g.position];
  // FUN_004f2bb0: weight along world z in the body frame (row 2 of M), integrate, damp.
  const w = -(C.gravity * g.type.mass);
  b.add([f32(w * m[6]), f32(w * m[7]), f32(w * m[8])], [0, 0, 0]);
  g.matrix = b.integrate(m);
  b.angularMomentum = [f32(b.angularMomentum[0] * angular), f32(b.angularMomentum[1] * angular), f32(b.angularMomentum[2] * angular)];
  b.velocity = [f32(b.velocity[0] * linear), f32(b.velocity[1] * linear), f32(b.velocity[2] * linear)];
  b.updateSpeed();
  // +0x6d8 (collision on, FUN_004f2210).
  contactPass(g, world, angular);
  if (C.moveThreshold < b.speed) g.position = [b.velocity[0] + old[0], b.velocity[1] + old[1], b.velocity[2] + old[2]];
  // FUN_004f3240: a point inside geometry puts the pose back (velocity kept).
  for (let i = 0; i < g.type.points.length; i++) {
    const r = rotate(g.matrix, g.type.points[i].local);
    if (world.inside([g.position[0] + r[0], g.position[1] + r[1], g.position[2] + r[2]], C.insideRay)) {
      g.touching[i] = true;
      g.contacts++;
      g.position = [...g.previousPosition];
      g.matrix = [...g.previousMatrix];
      break;
    }
  }
  g.previousPosition = [...g.position];
  g.previousMatrix = [...g.matrix];
}

/** FUN_004754c0 (one physics tick of a grenade). */
export function stepGrenadePhysics(g: Grenade, world: GrenadeWorld): void {
  if (grenadeAtRest(g)) return;
  const b = g.body;
  stepRigidObject(g, world, C.linearDamping, C.angularDamping);
  // FUN_004754c0: air drag without contact.
  if (g.contacts === 0) {
    b.velocity = [f32(b.velocity[0] * C.airDrag), f32(b.velocity[1] * C.airDrag), f32(b.velocity[2] * C.airDrag)];
    b.updateSpeed();
  }
}

let nextId = 1;

/** FUN_00475760 without the task bookkeeping: a grenade at `s`'s pose and velocity. */
export function createGrenade(s: GrenadeSpawn, type: GrenadeType, tick: number): Grenade {
  const body = new RigidBody();
  body.setup(type.mass, type.size);
  body.velocity = [f32(s.velocity[0]), f32(s.velocity[1]), f32(s.velocity[2])];
  body.updateSpeed();
  return {
    id: nextId++,
    weaponId: s.weaponId,
    model: s.model,
    type,
    tags: s.tags,
    thrower: s.thrower,
    position: [...s.position],
    matrix: [...s.matrix] as Mat3,
    body,
    previousPosition: [...s.position],
    previousMatrix: [...s.matrix] as Mat3,
    contacts: 0,
    touching: type.points.map(() => false),
    fuse: grenadeFuseTicks(type.fuseSeconds, s.cooked),
    bouncePlayed: false,
    lastBounceTick: tick,
    updates: 0,
    exploded: false,
  };
}

// --- The system ------------------------------------------------------------------------

export interface GrenadeSystem {
  /** Grenades in flight (or resting), in creation order. */
  readonly grenades: readonly Grenade[];
  /** FUN_00475760: a new grenade (null when the model has no TASKTYPE_GRENADE physics type). */
  spawn(s: GrenadeSpawn): Grenade | null;
  /** One tick of every grenade (FUN_004751f0), in creation order; grenades made during it update next tick. */
  update(): void;
  /** Drop every grenade (mission restart). */
  clear(): void;
  /** Where GRENADETHROWN / GRENADELAND go (the AI world's broadcast, FUN_0044fab0). */
  setAiEvents(sink: ((ev: AiEvent) => void) | null): void;
  /** Weaponconfig grenade tags by WEAPON_ID (combat/weapon-tags.ts readWeaponExtras). */
  setWeaponTags(tags: ReadonlyMap<string, GrenadeTags | null>): void;
  /** The weaponconfig tags of a weapon, or null when none were set. */
  tagsOf(weaponId: string): GrenadeTags | null;
  /** The physics type of a grenade model (null without physics data). */
  typeOf(model: string): GrenadeType | null;
  /** Ray queries (default: ctx.world). */
  setWorld(world: GrenadeWorld | null): void;
}

const registry = new WeakMap<object, GrenadeSystem>();

/** The grenade system of a GameContext, created on first use. */
export function grenadeSystemOf(ctx: GameContext): GrenadeSystem {
  let s = registry.get(ctx);
  if (!s) {
    s = createGrenadeSystem(ctx);
    registry.set(ctx, s);
  }
  return s;
}

/** Ray queries against ctx.world (engine metres, y up) for IGI positions. */
export function collisionGrenadeWorld(ctx: Pick<GameContext, "world" | "level">): GrenadeWorld {
  const origin = (): readonly number[] => ctx.level?.originIgi ?? [0, 0, 0];
  const toEngine = (p: readonly number[]): V3 => {
    const o = origin();
    return [(p[0] - o[0]) / UNITS, (p[2] - o[2]) / UNITS, -(p[1] - o[1]) / UNITS];
  };
  return {
    segment(from, to) {
      const w = ctx.world;
      if (!w) return null;
      const a = toEngine(from);
      const e = toEngine(to);
      const d = [e[0] - a[0], e[1] - a[1], e[2] - a[2]];
      const len = Math.hypot(d[0], d[1], d[2]);
      if (!(len > 0)) return null;
      const hit = w.raycast(a[0], a[1], a[2], d[0] / len, d[1] / len, d[2] / len, len, TRI_BULLET);
      if (!hit) return null;
      // RayHit.normal faces the ray origin; the exe's record holds the outward normal.
      const s = hit.front ? 1 : -1;
      const n: V3 = [hit.normal[0] * s, -hit.normal[2] * s, hit.normal[1] * s];
      const ln = Math.hypot(n[0], n[1], n[2]) || 1;
      return { distance: hit.distance * UNITS, normal: [f32(n[0] / ln), f32(n[1] / ln), f32(n[2] / ln)], front: hit.front };
    },
    inside(p, length) {
      const w = ctx.world;
      if (!w) return false;
      const a = toEngine(p);
      const hit = w.raycast(a[0], a[1], a[2], 0, 1, 0, length / UNITS, TRI_BULLET);
      return hit !== null && !hit.front;
    },
  };
}

export function createGrenadeSystem(ctx: GameContext): GrenadeSystem {
  let list: Grenade[] = [];
  let aiSink: ((ev: AiEvent) => void) | null = null;
  let tagTable: ReadonlyMap<string, GrenadeTags | null> | null = null;
  let world: GrenadeWorld | null = null;
  const defaultWorld = collisionGrenadeWorld(ctx);
  const types = new Map<string, GrenadeType | null>();
  let typesFor: IgiLevel | null = null;
  let typesData: unknown = null;
  let connected: DamageSystem | null = null;
  let order = 0;
  const orders = new WeakMap<Grenade, number>();

  const toEngine = (p: readonly number[]): Vec3 => {
    const o = ctx.level?.originIgi ?? [0, 0, 0];
    return [(p[0] - o[0]) / UNITS, (p[2] - o[2]) / UNITS, -(p[1] - o[1]) / UNITS];
  };

  function typeOf(model: string): GrenadeType | null {
    const level = ctx.level;
    if (!level) return null;
    const sys = damageSystemOf(ctx);
    const data = sys?.data ?? null;
    if (typesFor !== level || typesData !== data) {
      types.clear();
      typesFor = level;
      typesData = data;
    }
    const key = model.toLowerCase();
    if (!types.has(key)) {
      const bounds = data?.bounds.get(key) ?? null;
      types.set(key, grenadeTypeFor(level.vehicles?.types ?? [], key, bounds?.magic ?? null, bounds?.originRadius ?? 0));
    }
    return types.get(key) ?? null;
  }

  function broadcast(ev: AiEvent): void {
    aiSink?.(ev);
  }

  function playAt(name: string, position: Vec3): void {
    const audio = ctx.systems.audio as unknown as { playAt?(n: string, p: Vec3): unknown } | null;
    audio?.playAt?.(name, position);
  }

  /** The grenades as explosion targets: FUN_004755d0 sets the fuse to 0 on a non-zero factor. */
  function connectDamage(): void {
    const sys = damageSystemOf(ctx);
    if (!sys || sys === connected) return;
    connected = sys;
    sys.setHumanTargets("grenades", function* (): Iterable<ExplosionHuman> {
      for (const g of list) {
        if (g.exploded) continue;
        yield {
          order: Number.MAX_SAFE_INTEGER / 2 + (orders.get(g) ?? 0),
          active: true,
          origin: g.position,
          eye: g.position,
          modelRadius: 0,
          zoneMultiplier: 1,
          apply: (_hit, rec) => {
            if (g.fuse !== 0 && explosionFactor(rec, g.position, f32(g.type.originRadius)) !== 0) g.fuse = 0;
          },
        };
      }
    });
  }

  /** FUN_004753f0. */
  function bounceSound(g: Grenade): void {
    if (g.contacts === 0) {
      if (C.bounceRearmTicks < ctx.tick - g.lastBounceTick) g.bouncePlayed = false;
      return;
    }
    if (g.bouncePlayed) return;
    playAt(C.bounceSound, toEngine(g.position));
    broadcast({ type: EV.GRENADELAND, team: -1, flags: 0x02, range: C.landRange, position: [...g.position], source: null, other: null });
    g.bouncePlayed = true;
    g.lastBounceTick = ctx.tick;
  }

  /** FUN_004751f0's fuse-0 branch. */
  function explode(g: Grenade): void {
    g.exploded = true;
    const position = toEngine(g.position);
    // FUN_004c0e10: the surface 0.5 m below takes the scorch; terrain hits carry no object (no scorch).
    const below = ctx.world?.raycast(position[0], position[1], position[2], 0, -1, 0, C.scorchRay / UNITS, TRI_BULLET) ?? null;
    const tags = g.tags;
    if (g.type.explosion === 1) {
      const radiusM = tags ? f32(tags.radiusM * UNITS) / UNITS : C.noConfig.flashRadius / UNITS;
      const falloffM = tags ? f32(tags.falloffM * UNITS) / UNITS : C.noConfig.flashFalloff / UNITS;
      // FUN_0047cd10: the flash on every human (HUD / player side), no damage. The FLASHBANG AI event is
      // carried over from the earlier port (not traced in FUN_0047cd10) [inferred].
      ctx.events.emit("game:flashbang", { position, radiusM, falloffM });
      broadcast({ type: EV.FLASHBANG, team: -1, flags: 0x03, range: 40960, position: [...g.position], source: null, other: null });
      return;
    }
    const sys = damageSystemOf(ctx);
    if (!sys) return;
    sys.explode(sys.makeExplosion({
      position: [...g.position],
      interval: 1,
      damage: tags ? tags.damage : C.noConfig.damage,
      radius: tags ? f32(tags.radiusM * UNITS) : C.noConfig.radius,
      falloff: tags ? f32(tags.falloffM * UNITS) : C.noConfig.falloff,
      scorch: EXPLOSION_SCORCH,
      fragments: 3,
      fireballs: 1,
      sound: "explo_02_m",
      aiRange: GRENADE_AI_RANGE,
    }));
    if (below && !below.terrain && below.owner >= 0) {
      ctx.events.emit(DAMAGE_EVENTS.Scorch, { point: [...below.point], sizeM: EXPLOSION_SCORCH / UNITS, texture: "burn1" });
    }
  }

  const system: GrenadeSystem = {
    get grenades() {
      return list;
    },
    spawn(s) {
      const type = typeOf(s.model);
      if (!type) return null;
      const g = createGrenade(s, type, ctx.tick);
      orders.set(g, order++);
      list.push(g);
      // FUN_00475470(obj, 17, 1, -1.0): GRENADETHROWN.
      broadcast({ type: EV.GRENADETHROWN, team: -1, flags: 0x01, range: -1, position: [...g.position], source: null, other: null });
      return g;
    },
    update() {
      connectDamage();
      const w = world ?? defaultWorld;
      for (const g of [...list]) {
        g.updates++;
        if (g.fuse !== 0) {
          g.fuse--;
          stepGrenadePhysics(g, w);
          bounceSound(g);
          continue;
        }
        list.splice(list.indexOf(g), 1);
        explode(g);
      }
    },
    clear() {
      list = [];
    },
    setAiEvents(sink) {
      aiSink = sink;
    },
    setWeaponTags(tags) {
      tagTable = tags;
    },
    tagsOf(weaponId) {
      if (!tagTable) return null;
      return tagTable.get(weaponId) ?? null;
    },
    typeOf,
    setWorld(w) {
      world = w;
    },
  };
  return system;
}
