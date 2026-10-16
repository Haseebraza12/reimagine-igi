/**
 * The Missile object (class "Missile", 0x898 bytes, derived from the Vehicle
 * base class 0x4f45f0): the RPG18 rocket (player, HumanSoldierRPG), the APC /
 * T80 turret rounds (weaponconfig "Missile - Model" 110_02_1) and the Mil
 * rocket pods' HIND rockets (700_10_1). Pure flight rules; the engine side
 * (spawn, rays, explosion, drawing) is combat/projectiles.ts. IGI units (4096
 * = 1 m, z up), units/tick, 30 ticks/s; float32 stores as the exe's (chop).
 *
 * Recovered (full exe, image base 0x400000):
 *   - Class FUN_00427ff0: create 0x428270 -> FUN_00428280 (Vehicle create
 *     FUN_004f4680: FUN_004fb5f0 sets collision detection +0x6d8 = 1, Force Z
 *     +0x6d9 = 0), update 0x428390, destroy FUN_00428ca0, type reader
 *     FUN_00429730 (MissileConfig, loaders/vehicles.ts), projectile spawn
 *     method LAB_004298a0 -> FUN_00429a30, ray filter LAB_00427fc0 (a ray of
 *     the missile itself, of its gun or owner, or any Missile, passes).
 *     MISSILE_TYPE_* 0 DIRECT, 1 HIND_HELICOPTER, 2 BALLISTIC, 3 ANTITANK,
 *     4 KEYBOARD, 5 BOMB; MISSILE_SMOKE_NONE 0 / NORMAL 1. The missile random
 *     generator DAT_0057bc88 is initialised once (FUN_004b4720) at the class
 *     registration and never re-seeded: process-wide, not the level RNG.
 *   - Spawn FUN_00429a30(parent, gun, owner, muzzle, aim matrix, muzzle
 *     velocity, target point, target object, model, weaponconfig): matrix =
 *     the aim matrix; type = the DefinePhysicsObjType of the model
 *     (FUN_004ee140), body FUN_004fb700 (mass, box inertia, contact points at
 *     the model's magic vertices); fuel +0x864 = type +0x120; drag elements
 *     copied (FUN_00429ef0: elements 2 / 3 = elements 0 / 1 with the point's
 *     y negated: the nose pair mirrored to the tail); throttle +0x720 =
 *     target +0x730 = 1.0; smoke (FUN_00429dc0) and sound (FUN_00429d80: the
 *     type's sound group at the missile); gun +0x858 / owner +0x85c handles;
 *     guidance: DIRECT -> aim point +0x828 = muzzle + col1 x 4096000
 *     (0x533548); HIND -> +0x840 = target - muzzle, +0x828 = target; other
 *     types: the target point or the target object (+0x860); velocity = col1
 *     x muzzle velocity x f32 136.53334 (0x533680, m/s -> units/tick);
 *     source +0x894 = the weaponconfig (cars take damage only from id 12).
 *   - Update 0x428390: +0x860 alive -> aim = its position; guidance (DIRECT
 *     FUN_00428910: inputs 0 and 2 = 0; HIND FUN_00428930); smoke
 *     FUN_00428630 while fuel != 0 and the type smokes; physics FUN_00428d00;
 *     sound position FUN_00428610; attached children (FUN_004f4660); task
 *     children. No contact: when (global frame & 0x1f) == 0 a ray 1000 m down
 *     (0xc14f4000...): nothing below -> deleted. Contact (+0x1b8 > 0): a ray
 *     3 m down (the scorch hit), FUN_00480fe0(position, 1, 1, 5.0, 10240,
 *     7168, 6144, 10, 5, hit, "1009_01_1", "explo_03_l", 21, 2, 102400,
 *     source), deleted.
 *   - Physics FUN_00428d00: throttle step cfg[8] at or above 0.7 (f32
 *     0x5336c4), else cfg[9], toward the target without overshoot, < 0.001
 *     -> 0; controls c_k = s_k c_k + (1 - s_k) in_k (s = cfg[2], [4], [6]);
 *     any c != 0 -> M = M Rx(c0 cfg[1] pi/180) Rz(c2 cfg[5] pi/180)
 *     (FUN_004b3b60, FUN_004b3be0); fuel == 0 -> M = M Euler((0.5 - r1) 0.1,
 *     (0.7 - r2) 0.1, (0.3 - r3) 0.1) with three missile-generator draws
 *     (FUN_004b38e0 = Rz Ry Rx); throttle != 0 and fuel != 0 -> force (0,
 *     cfg[7] throttle g, 0) in the body frame at the origin (FUN_004ecf50);
 *     fuel = max(0, fuel - burn); unless at rest (FUN_004fc7b0): flat-plate
 *     drag FUN_004ec2c0(elements, n, 0.000327, -v) and the physics-object
 *     step FUN_004fc0e0(g 44.600887, linear 0.95, angular 0.92) with the ray
 *     filter 0x539547 {self, gun, owner, 1.0} (combat/grenade.ts
 *     stepRigidObject: integrate, contact pass with impulse / friction,
 *     position += v above 40.96, inside test).
 *   - HIND guidance FUN_00428930: d = position - aim; P = (d . o) d + 12800
 *     unit((d . o) d) (FUN_004b30c0, double 0x40c80000...), o = +0x840;
 *     FUN_00428b60(P): local = M^T (P - position); in0 = clamp(FUN_004148f0(
 *     local), -1, 1), in2 = clamp(FUN_00414950(local), -1, 1). (P is used as
 *     a world point: with |(d . o) d| ~ |d|^3 it lies far along -d, so the
 *     rocket turns toward the aim point while d . o < 0.)
 *   - Smoke FUN_00428630 (counter +0x878 against fistp(+0x880)): one draw for
 *     the alpha (r x 0.3 + 0.15), n = max(1, fistp(speed / +0x884)) particles
 *     spaced v / n from the tail (magic vertex 1 for a model with two or more
 *     magic vertices [inferred: the model field read is the vertex count]),
 *     each FUN_004fe120(system, point, the unit velocity +0x114 as velocity,
 *     alpha, spin (0.5 - r) x 0.0376991, angle r x 2 pi, scale 1.0, life
 *     fistp(+0x88c x 3), fade over fistp((r x 0.3 + 0.6) x +0x88c x 30)
 *     ticks) after three unused draws: six draws per particle. The system
 *     (FUN_00429dc0 -> FUN_004fdf00, a child of the Dynamic task, removed when
 *     empty): the type's sprite, acceleration (0, 0, f32 0.0217778), colour
 *     12.7 (1/128 scale), half-size +0x12c, far 2048000, flags 0x1080000,
 *     growth (+0x130 / +0x12c - 1) / (+0x88c x 30) per tick, 2000 particles.
 * Inferred / not modelled: the hit object's contact method (the human / car
 * answers of FUN_004fc860) and FUN_004fbe86's velocity x 0.25 when an object
 * answers; MISSILE_TYPE_MISSILE_BALLISTIC / ANTITANK / KEYBOARD / BOMB
 * guidance (no shipped type uses them).
 */
import type { Vec3 } from "../../contracts";
import { RigidBody, VEHICLE_GRAVITY, applyDrag, eulerF, matMulF, rotX, rotZ, type DragElement, type MissileConfig, type PhysicsObjType } from "../../loaders/vehicles";
import type { Mat3 } from "../../loaders/mission";
import { x87Fistp, x87StoreF32 } from "../../loaders/x87";
import type { LevelRng } from "../ai/rng";
import { stepRigidObject, type GrenadePoint, type GrenadeWorld, type RigidStepObject } from "./grenade";

const f32 = x87StoreF32;
type V3 = [number, number, number];

export const MISSILE_RULES = {
  /** f32 0x533680: Muzzle Velocity (m/s) -> units/tick. */
  muzzleScale: f32(136.53334045410156),
  gravity: VEHICLE_GRAVITY,
  /** FUN_004fc0e0 arguments of FUN_00428d00 (0x3f733333, 0x3f6b851f). */
  linearDamping: f32(0.949999988079071),
  angularDamping: f32(0.9200000166893005),
  /** Throttle step switch (f32 0x5336c4) and zero snap (f32 0x5336c0). */
  throttleSwitch: f32(0.699999988079071),
  throttleZero: f32(0.0010000000474974513),
  /** f32 0x53367c. */
  deg: f32(0.01745329238474369),
  /** Tumble Euler offsets (f32 0x533504, 0x5336c4, 0x5336a4) and scale (f32 0x5333c8). */
  tumble: [f32(0.5), f32(0.699999988079071), f32(0.30000001192092896)] as const,
  tumbleScale: f32(0.10000000149011612),
  /** DIRECT aim point distance along col 1 (double 0x533548). */
  directRange: 4096000,
  /** HIND lead length (double 0x40c80000_00000000 for FUN_004b30c0). */
  hindLead: 12800,
  /** No contact: every 32 global frames a ray 1000 m down (double 0xc14f4000_00000000). */
  probeMask: 0x1f,
  probeRange: 4096000,
  /** Contact: the scorch ray 3 m down (double 0xc0c80000_00000000). */
  scorchRay: 12288,
  explosion: {
    damage: 5, radius: 10240, falloff: 7168, scorch: 6144, fragments: 10, fireballs: 5,
    fragmentModel: "1009_01_1", sound: "explo_03_l", aiEvent: 21, flags: 2, aiRange: 102400,
  },
  smoke: {
    /** r x 0.3 (f32 0x5336a4) + 0.15 (f32 0x533598). */
    speedK: f32(0.30000001192092896), speedBase: f32(0.15000000596046448),
    /** life fistp((r x 0.3 + 0.6 (f32 0x53369c)) x size x 30 (f32 0x5333bc)). */
    lifeBase: f32(0.6000000238418579), ticks: 30,
    /** life fistp(+0x88c x 3 (f32 0x5336a0)); angle r x 2 pi (f32 0x5334a8); spin (0.5 - r) x f32 0x533698. */
    sizeK: 3, angle: f32(6.2831854820251465), spin: f32(0.03769911453127861),
    /** FUN_00429dc0's system: acceleration z (0x3cb2674f), colour 12.7 (0x414b3333), far (0x49fa0000), flags, 2000 particles. */
    accelZ: f32(0.02177777700126171), colour: f32(12.699999809265137), far: 2048000, flags: 0x1080000, maxParticles: 2000,
  },
} as const;

const R = MISSILE_RULES;

/** MISSILE_TYPE_* (FUN_00427ff0). */
export const MISSILE_GUIDANCE = { direct: 0, hind: 1, ballistic: 2, antitank: 3, keyboard: 4, bomb: 5 } as const;

/** A DefinePhysicsObjType TASKTYPE_MISSILE with its model data. */
export interface MissileType {
  model: string;
  mass: number;
  size: Vec3;
  /** Contact points at the model's magic vertices (FUN_004fb700): restitution +0x158, friction +0x160. */
  points: GrenadePoint[];
  restSpeed: number;
  restAngular: number;
  config: MissileConfig;
  /** The model's magic vertices (the smoke start). */
  magic: V3[];
}

/** The missile type of a model (FUN_004ee140), or null when no TASKTYPE_MISSILE names it. */
export function missileTypeFor(types: readonly PhysicsObjType[], model: string, magic: readonly (readonly number[])[] | null): MissileType | null {
  const t = types.find((x) => x.taskType === "TASKTYPE_MISSILE" && x.model.toLowerCase() === model.toLowerCase());
  if (!t || !("guidance" in t.config)) return null;
  const mv = (magic ?? []).map((v) => [v[0], v[1], v[2]] as V3);
  return {
    model: t.model,
    mass: t.mass,
    size: [...t.size] as Vec3,
    // FUN_004d09e0: the point's magic vertex; [inferred] the origin when the model has none.
    points: t.points.map((p) => ({ local: (mv[p.vertex] ? [...mv[p.vertex]] : [0, 0, 0]) as V3, restitution: p.c, grip: p.gripRolling })),
    restSpeed: t.restSpeed,
    restAngular: t.restAngular,
    config: t.config,
    magic: mv,
  };
}

/** One Missile object (the fields the flight reads). */
export interface Missile extends RigidStepObject {
  readonly type: MissileType;
  /** +0x720 current / +0x730 target throttle. */
  throttle: number;
  throttleTarget: number;
  /** +0x724.. smoothed controls, +0x734.. inputs. */
  controls: V3;
  inputs: V3;
  /** +0x864 fuel (type units, burn per tick from the type). */
  fuel: number;
  /** +0x828 aim point, +0x840 HIND offset. */
  aim: V3;
  offset: V3;
  /** +0x748.. drag elements (FUN_00429ef0). */
  drag: DragElement[];
  /** +0x878 smoke counter. */
  smokeCounter: number;
}

/** FUN_00429ef0: the type's drag elements, elements 2 / 3 = 0 / 1 with the point's y negated. */
export function missileDragElements(cfg: MissileConfig): DragElement[] {
  const out = cfg.drag.map((e) => ({ coef: e.coef, normal: [...e.normal] as Vec3, point: [...e.point] as Vec3 }));
  for (const [dst, src] of [[2, 0], [3, 1]] as const) {
    const s = cfg.drag[src] ?? out[src];
    if (!s) continue;
    out[dst] = { coef: s.coef, normal: [...s.normal] as Vec3, point: [s.point[0], -s.point[1], s.point[2]] };
  }
  return out;
}

/** FUN_00429a30 without the task bookkeeping. `matrix` = the aim matrix (col 1 = the launch direction). */
export function createMissile(
  type: MissileType,
  s: { position: readonly number[]; matrix: Mat3; muzzleVelocity: number; target?: readonly number[] | null },
): Missile {
  const cfg = type.config;
  const body = new RigidBody();
  body.setup(type.mass, type.size);
  const m = [...s.matrix] as Mat3;
  const mv = Math.fround(s.muzzleVelocity);
  // +0x108..: (float) col1 x param_6 x f32 136.53334.
  body.velocity = [f32(m[1] * mv * R.muzzleScale), f32(m[4] * mv * R.muzzleScale), f32(m[7] * mv * R.muzzleScale)];
  body.updateSpeed();
  const p: V3 = [s.position[0], s.position[1], s.position[2]];
  let aim: V3 = [0, 0, 0];
  let offset: V3 = [0, 0, 0];
  if (cfg.guidance === MISSILE_GUIDANCE.direct) {
    aim = [f32(f32(m[1] * R.directRange) + f32(p[0])), f32(m[4] * R.directRange) + p[1], f32(m[7] * R.directRange) + p[2]];
  } else if (cfg.guidance === MISSILE_GUIDANCE.hind && s.target) {
    offset = [s.target[0] - p[0], s.target[1] - p[1], s.target[2] - p[2]];
    aim = [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]];
  } else if (s.target) {
    aim = [s.target[0], s.target[1], s.target[2]];
  }
  return {
    type,
    position: [...p],
    matrix: m,
    body,
    previousPosition: [...p],
    previousMatrix: [...m] as Mat3,
    contacts: 0,
    touching: type.points.map(() => false),
    throttle: 1,
    throttleTarget: 1,
    controls: [0, 0, 0],
    inputs: [0, 0, 0],
    fuel: cfg.fuel,
    aim,
    offset,
    drag: missileDragElements(cfg),
    smokeCounter: 0,
  };
}

/** FUN_004148f0: the angle of (0, y, z) from +y, negative below (0 for y = z = 0). */
export function verticalAngle(v: readonly number[]): number {
  const n = Math.hypot(v[1], v[2]);
  if (n === 0) return 0;
  const a = Math.acos(Math.max(-1, Math.min(1, v[1] / n)));
  return v[2] < 0 ? -a : a;
}

/** FUN_00414950: the angle of (x, y, 0) from +y, negative to the right (x > 0). */
export function horizontalAngle(v: readonly number[]): number {
  const n = Math.hypot(v[0], v[1]);
  if (n === 0) return 0;
  const a = Math.acos(Math.max(-1, Math.min(1, v[1] / n)));
  return v[0] > 0 ? -a : a;
}

/** FUN_00428b60: steering inputs toward the world point `p`. */
export function steerToward(m: Missile, p: readonly number[]): void {
  const d = [p[0] - m.position[0], p[1] - m.position[1], p[2] - m.position[2]];
  const M = m.matrix;
  const l = [M[0] * d[0] + M[3] * d[1] + M[6] * d[2], M[1] * d[0] + M[4] * d[1] + M[7] * d[2], M[2] * d[0] + M[5] * d[1] + M[8] * d[2]];
  const clamp = (x: number) => (x < -1 ? -1 : 1 < x ? 1 : x);
  m.inputs[0] = f32(clamp(verticalAngle(l)));
  m.inputs[2] = f32(clamp(horizontalAngle(l)));
}

/** FUN_00428930 (MISSILE_TYPE_HIND_HELICOPTER). */
export function hindGuidance(m: Missile): void {
  const d = [m.position[0] - m.aim[0], m.position[1] - m.aim[1], m.position[2] - m.aim[2]];
  const k = d[0] * m.offset[0] + d[1] * m.offset[1] + d[2] * m.offset[2];
  const v = [k * d[0], k * d[1], k * d[2]];
  const n = Math.hypot(v[0], v[1], v[2]);
  // FUN_004b30c0: unit vector x 12800 ([inferred] nothing added for a zero vector).
  const lead = n > 0 ? v.map((x) => (x / n) * R.hindLead) : [0, 0, 0];
  steerToward(m, [lead[0] + v[0], lead[1] + v[1], lead[2] + v[2]]);
}

/** One smoke particle of FUN_00428630 (FUN_004fe120 arguments, fx/particles.ts ParticleSystem.emit). */
export interface MissileSmokeParticle {
  position: V3;
  /** The missile's unit velocity (+0x114): the particle's velocity, units/tick. */
  velocity: V3;
  alpha: number;
  /** Rotation per tick and initial angle, radians. */
  spin: number;
  angle: number;
  scale: number;
  /** Ticks before the fade, and the fade length in ticks. */
  life: number;
  fadeTicks: number;
}

/** FUN_00429dc0's smoke system (FUN_004fdf00 arguments) for a missile type. */
export function missileSmokeSystem(cfg: MissileConfig): { sprite: string; accel: V3; colour: number; halfSize: [number, number]; far: number; flags: number; growth: number; maxParticles: number } {
  const growth = cfg.smokeSpacing > 0 && cfg.smokeSize > 0 ? f32((cfg.smokeGrowth / cfg.smokeSpacing - 1) / f32(cfg.smokeSize * R.smoke.ticks)) : 0;
  return {
    sprite: cfg.sprite, accel: [0, 0, R.smoke.accelZ], colour: R.smoke.colour, halfSize: [cfg.smokeSpacing, cfg.smokeSpacing],
    far: R.smoke.far, flags: R.smoke.flags, growth, maxParticles: R.smoke.maxParticles,
  };
}

/** FUN_00428630: smoke emission with its missile-generator draws. */
export function missileSmoke(m: Missile, rng: LevelRng, emit?: (p: MissileSmokeParticle) => void): void {
  const cfg = m.type.config;
  m.smokeCounter += 1;
  if (m.smokeCounter < x87Fistp(cfg.smokeInterval)) return;
  const r0 = rng.float();
  const speedRaw = m.body.speed;
  m.smokeCounter = 0;
  let pos: V3 = [...m.position];
  const mv = m.type.magic;
  if (mv.length >= 2) {
    const t = mv[1];
    const M = m.matrix;
    pos = [M[0] * t[0] + M[1] * t[1] + M[2] * t[2] + pos[0], M[3] * t[0] + M[4] * t[1] + M[5] * t[2] + pos[1], M[6] * t[0] + M[7] * t[1] + M[8] * t[2] + pos[2]];
  } else if (mv.length === 1) {
    // FUN_00414ed0 for a single magic vertex is not traced: its vertex 0 [inferred].
    const t = mv[0];
    const M = m.matrix;
    pos = [M[0] * t[0] + M[1] * t[1] + M[2] * t[2] + pos[0], M[3] * t[0] + M[4] * t[1] + M[5] * t[2] + pos[1], M[6] * t[0] + M[7] * t[1] + M[8] * t[2] + pos[2]];
  }
  const dir: V3 = [...m.body.velocityDir];
  let n = cfg.smokeSpacing > 0 ? x87Fistp(f32(speedRaw / cfg.smokeSpacing)) : 1;
  if (n < 2) n = 1;
  const k = f32(1 / n);
  const step: V3 = [k * m.body.velocity[0], k * m.body.velocity[1], k * m.body.velocity[2]];
  const alpha = f32(r0 * R.smoke.speedK + R.smoke.speedBase);
  for (let i = 0; i < n; i++) {
    rng.float();
    rng.float();
    rng.float();
    const life = x87Fistp(cfg.smokeSize * R.smoke.sizeK);
    const fadeTicks = x87Fistp((rng.float() * R.smoke.speedK + R.smoke.lifeBase) * cfg.smokeSize * R.smoke.ticks);
    const angle = f32(rng.float() * R.smoke.angle);
    const spin = f32((R.tumble[0] - rng.float()) * R.smoke.spin);
    emit?.({ position: [...pos], velocity: dir, alpha, spin, angle, scale: 1, life, fadeTicks });
    pos = [step[0] + pos[0], step[1] + pos[1], step[2] + pos[2]];
  }
}

/** FUN_004fc7b0 (the wake flag +0x690 is never set for a missile). */
function atRest(m: Missile): boolean {
  const w = m.body.angularVelocity;
  return m.contacts > 0 && m.body.forces.length === 0 && m.body.speed < m.type.restSpeed && f32(w[0] * w[0] + w[1] * w[1] + w[2] * w[2]) < m.type.restAngular;
}

/** FUN_00428d00: throttle, controls, tumble, thrust, fuel, drag and the physics-object step. */
export function missilePhysics(m: Missile, world: GrenadeWorld, rng: LevelRng): void {
  const c = m.type.config.c;
  const step = R.throttleSwitch <= m.throttle ? c[8] : c[9];
  let t = m.throttle;
  const target = m.throttleTarget;
  if (target > t) {
    t = f32(t + step);
    if (target < t) t = target;
  } else if (t > target) {
    t = f32(t - step);
    if (t < target) t = target;
  }
  if (t < R.throttleZero) t = 0;
  m.throttle = t;
  m.controls = [
    f32(c[2] * m.controls[0] + (1 - c[2]) * m.inputs[0]),
    f32(c[4] * m.controls[1] + (1 - c[4]) * m.inputs[1]),
    f32(c[6] * m.controls[2] + (1 - c[6]) * m.inputs[2]),
  ];
  if (m.controls[0] !== 0 || m.controls[1] !== 0 || m.controls[2] !== 0) {
    const yaw = f32(m.controls[2] * c[5] * R.deg);
    m.matrix = matMulF(m.matrix, rotX(f32(m.controls[0] * c[1] * R.deg)));
    m.matrix = matMulF(m.matrix, rotZ(yaw));
  }
  if (m.fuel === 0) {
    const a = f32((R.tumble[0] - rng.float()) * R.tumbleScale);
    const b = f32((R.tumble[1] - rng.float()) * R.tumbleScale);
    const g = f32((R.tumble[2] - rng.float()) * R.tumbleScale);
    m.matrix = matMulF(m.matrix, eulerF(a, b, g));
  }
  if (m.throttle !== 0 && m.fuel !== 0) m.body.add([0, f32(c[7] * m.throttle * R.gravity), 0], [0, 0, 0]);
  const fuel = f32(m.fuel - m.type.config.burn);
  m.fuel = fuel < 0 ? 0 : fuel;
  if (atRest(m)) return;
  if (m.type.config.drag.length > 0) applyDrag(m.body, m.drag.slice(0, m.type.config.drag.length), m.matrix);
  stepRigidObject(m, world, R.linearDamping, R.angularDamping);
}

/** What one update (0x428390) decided. */
export type MissileOutcome = "fly" | "explode" | "delete";

/**
 * One update of a missile (0x428390) without its presentation: `targetPosition` answers the
 * target object (+0x860), `probeDown` the 1000 m ray of the no-contact check.
 */
export function updateMissile(
  m: Missile,
  env: {
    world: GrenadeWorld;
    rng: LevelRng;
    /** The global frame counter (DAT_00bc2360 +0x68): the probe runs when its low 5 bits are 0. */
    frame: number;
    probeDown(position: V3): boolean;
    targetPosition?: () => V3 | null;
    smoke?: (p: MissileSmokeParticle) => void;
  },
): MissileOutcome {
  const tp = env.targetPosition?.();
  if (tp) m.aim = [...tp];
  const g = m.type.config.guidance;
  if (g === MISSILE_GUIDANCE.direct) {
    m.inputs[0] = 0;
    m.inputs[2] = 0;
  } else if (g === MISSILE_GUIDANCE.hind) hindGuidance(m);
  if (m.fuel !== 0 && m.type.config.smoke !== 0) missileSmoke(m, env.rng, env.smoke);
  missilePhysics(m, env.world, env.rng);
  if (m.contacts === 0) {
    if ((env.frame & R.probeMask) === 0 && !env.probeDown([...m.position])) return "delete";
    return "fly";
  }
  return "explode";
}
