/**
 * Damage and explosion rules of igi.exe, as pure functions (docs/damage.md).
 * Units are the original's: positions and lengths in IGI units (4096 per
 * metre, z up), time in 30 Hz ticks. Every value names its source address;
 * "inferred" marks what was not read from the exe.
 *
 * Explosions (recovered):
 *   - FUN_0047f350(pos, count, interval, damage, radius, falloff, scorch,
 *     fragments, fireballs, scorchTarget, fragmentModel, sound, aiType,
 *     aiFlags, aiRange, source) draws the fragment direction (r - 0.5,
 *     r - 0.5, r - 0.3) and calls FUN_0047f410, which creates an Explosion0
 *     task (child of the Dynamic task, appended at the tail), draws three
 *     more randoms for the fragment type and broadcasts the AI event at once.
 *   - Explosion0 update (FUN_0047f2b0): delay -= 1 while non-zero; at 0 it
 *     explodes (FUN_0047d570) and, with repeats left, redraws the delay as
 *     rand(interval). Every level-1 explosion has count 1 and interval 0 or 1,
 *     so it explodes on its first update: the end of the Dynamic walk of the
 *     tick that created it.
 *   - FUN_0047d570: nothing unless radius != 0; fireballs, smoke, fragments,
 *     the sound at the centre, then (damage != 0) every object of the damage
 *     list DAT_00577b68 gets method DAT_00537433 with the record
 *     {fireball, &centre, damage, radius, falloff, 90, source}.
 *   - FUN_00415b90: e = |centre - target| - targetRadius - radius;
 *     factor = damage if e < 0, damage (falloff - e) / falloff if e < falloff,
 *     else 0.
 */
import type { LevelRng } from "../ai/rng";
import { x87Add, x87Div, x87F32Div, x87F32Mul, x87F32Sub, x87Fistp, x87Mul, x87StoreF32, x87Sub } from "../../loaders/x87";
import { FRAGMENTS, frameOf, mulMat3, normalise, rotX, rotZ, rotZYX, x87Spin, type Mat3 } from "../fx/bullet-effects";

export type V3 = [number, number, number];

export const UNITS_PER_METRE = 4096;

// --- Constants ---------------------------------------------------------------

/** Glass: threshold = 0.75 (imm 0x3f400000 at 0x448731) + rand * 0.75 (f32 0x531524), drawn at creation. */
export const GLASS_THRESHOLD_BASE = 0.75;
export const GLASS_THRESHOLD_RANGE = Math.fround(0.75);
/** Glass bullet shatter: the cast segment x 0.007 (f32 0x5318b8) is the shard push (FUN_00449010). */
export const GLASS_BULLET_PUSH = Math.fround(0.007000000216066837);
/** Glass explosion shatter speed (imm 0x43cccccd, LAB_004489e0) and physics-contact speed (0x434ccccd, LAB_00448af0). */
export const GLASS_EXPLOSION_SHARD_SPEED = Math.fround(409.6);
export const GLASS_CONTACT_SHARD_SPEED = Math.fround(204.8);
/** GlassShatter life (+0xbc = 0x1e) in ticks; shards fade with it (LAB_00448c90). */
export const GLASS_SHATTER_TICKS = 30;
/** glass_crush_1..3 (0x53a830, stride 0x20), picked with rand(3) of the level RNG (FUN_00449470). */
export const GLASS_SOUNDS = ["glass_crush_1", "glass_crush_2", "glass_crush_3"] as const;

/** SCamera lens: damage it can take (+0x108 = 0x3f000000, lens create LAB_00440780). */
export const SCAMERA_LENS_HIT_POINTS = 0.5;

/** Scorch decal size of object / grenade explosions (imm 0x45c00000 = 6144 units = 1.5 m). */
export const EXPLOSION_SCORCH = 6144;
/** Fragment model of every FUN_0047f350 caller ("1009_01_1", 0x539c38). */
export const FRAGMENT_MODEL = "1009_01_1";
/** Fireball model ("1006_01_1", 0x53e8cc): 26-frame animated additive dome. */
export const FIREBALL_MODEL = "1006_01_1";
/** AI EXPLOSION event (FUN_0047f410 -> FUN_0044fab0): type 21, team 1, flags 2. */
export const EXPLOSION_AI_EVENT = { type: 21, team: 1, flags: 2 } as const;
/** AI event range of object explosions (imm 0x47c80000 = 100000 units) and grenades (0x47200000 = 40960). */
export const EXPLOSION_AI_RANGE = 100000;
export const GRENADE_AI_RANGE = 40960;
/** Damage record word 5: shake duration in ticks (imm 0x5a at 0x47e356). */
export const EXPLOSION_SHAKE_TICKS = 90;
/** Weapon id whose explosions destroy cars (LAW 80; car handler 0x42ede0 tests **(record+0x18) == 0xc). */
export const CAR_KILLER_WEAPON_ID = 12;

/** FUN_0047f350 fragment cone: half angle pi/2 (0x3fc90fdb), speed 272..1360 units/tick (0x43880000, 0x44aa0000). */
export const FRAGMENT_SPREAD = Math.fround(1.5707963705062866);
export const FRAGMENT_SPEED_MIN = 272;
export const FRAGMENT_SPEED_MAX = 1360;
/** Fragment size passed to FUN_0047d440 (0x434ccccd); scale = size x 1/2048 (f32 0x53217c). */
export const FRAGMENT_SIZE = Math.fround(204.8);

/** Fireball: life 75 ticks (0x4b), frame period 75; scale = size / 2048 (double 0x532198). */
export const FIREBALL_LIFE = 75;
export const FIREBALL_SCALE = 1 / 2048;

/** Human explosion handlers: target radius = model origin radius (+0xa0) x 1/3 (f32 0x53152c). */
export const HUMAN_RADIUS_FACTOR = Math.fround(0.3333333432674408);
/** Torso front zone used by every human explosion handler (+0x2e8 = 0xd). */
export const EXPLOSION_ZONE = 13;
/** Player knock-back: d < (falloff + radius) x 1.5 (f32 0x531544) -> 758.518 units/tick (f32 0x531540). */
export const KNOCK_RANGE_FACTOR = 1.5;
export const EXPLOSION_KNOCK = Math.fround(758.5184936523438);
/** Ear ringing ("earcandy", 0x5370f0): d < 102400 (0x53153c) adds 1 - d x 9.7656e-6 (f32 0x531538); -1/150 per tick (0x5314b8). */
export const EARCANDY_RANGE = 102400;
export const EARCANDY_PER_UNIT = Math.fround(9.765624781721272e-6);
export const EARCANDY_DECAY = Math.fround(0.006666666828095913);
/** Hit-direction indicators +0xdcc..+0xdd8: (rand + 1) x 0.4 (double 0x531510); -0.0222 per tick (0x5314bc). */
export const INDICATOR_SCALE = 0.4;
export const INDICATOR_DECAY = Math.fround(0.02222222276031971);
/** View shake (FUN_004645e0): e = d - 3 R (0x531534); k = 1 - e / (6 R) (0x531530). */
export const SHAKE_NEAR = 3;
export const SHAKE_FAR = 6;
/** Shake amplitude k x 204.8 units (0x531518); angle k x 0.75 deg (player, 0x53151c) / 1.5 deg (soldiers, 0x531910). */
export const SHAKE_AMPLITUDE = Math.fround(204.8000030517578);
export const SHAKE_ANGLE_PLAYER = Math.fround(0.013089969754219055);
export const SHAKE_ANGLE_SOLDIER = Math.fround(0.02617993950843811);
/** Player explosion damage x difficulty: 0.75 (0x531524) / 1 / 1.25 (0x531528) for profile 0 / 1 / 2. */
export const PLAYER_EXPLOSION_DIFFICULTY = [0.75, 1, 1.25] as const;

// --- Records -------------------------------------------------------------------

/** What FUN_0047f350 / FUN_0047f410 store in an Explosion0 (+0x20 ... +0x84). */
export interface ExplosionSpec {
  /** +0x20: centre, IGI units. */
  position: V3;
  /** +0x38: explosions left. */
  count: number;
  /** +0x3c / +0x40: initial delay and redraw range, ticks. */
  interval: number;
  /** +0x50: damage factor. */
  damage: number;
  /** +0x54: blast radius, units. */
  radius: number;
  /** +0x58: falloff, units. */
  falloff: number;
  /** FUN_0047f410 argument 7: scorch decal size, units (0 = none). */
  scorch: number;
  /** +0x68: fragments. */
  fragments: number;
  /** +0x6c: fireballs. */
  fireballs: number;
  /** FUN_0047f410 argument 11: fragment model. */
  fragmentModel: string;
  /** +0x70: sound definition. */
  sound: string;
  /** AI event range (argument 15), or null when argument 13 is -1 (no event). */
  aiRange: number | null;
  /** +0x84: the launching weapon's id when it is a missile, else null (cars test it). */
  sourceWeaponId: number | null;
  /** +0x44: unit fragment direction; +0x5c spread; +0x60 / +0x64 speed range (FUN_0047f350). */
  direction: V3;
  /** Spin of the fragment container (rad/tick, IGI x, y, z). */
  spin: V3;
  spread: number;
  speedMin: number;
  speedMax: number;
}

/** The damage record passed to every damage-list object (built at 0x47e325). */
export interface ExplosionRecord {
  position: V3;
  damage: number;
  radius: number;
  falloff: number;
  shakeTicks: number;
  sourceWeaponId: number | null;
}

export function recordOf(spec: ExplosionSpec): ExplosionRecord {
  return { position: spec.position, damage: spec.damage, radius: spec.radius, falloff: spec.falloff, shakeTicks: EXPLOSION_SHAKE_TICKS, sourceWeaponId: spec.sourceWeaponId };
}

/** FUN_004a9410: length of a double vector (x87, 53-bit). */
function length(a: readonly number[], b: readonly number[]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * FUN_00415b90: the damage factor an explosion deals to a target whose
 * centre is `centre` and radius `targetRadius` (units). The comparison with
 * 0 uses the register value; the falloff part uses it stored as a float32.
 */
export function explosionFactor(rec: ExplosionRecord, centre: readonly number[], targetRadius: number): number {
  const e = x87Sub3(length(rec.position, centre), targetRadius, rec.radius);
  if (e < 0) return rec.damage;
  const e32 = x87StoreF32(e);
  if (e32 < rec.falloff) return ((rec.falloff - e32) * rec.damage) / rec.falloff;
  return 0;
}

function x87Sub3(a: number, b: number, c: number): number {
  return a - b - c;
}

/**
 * A damage accumulator update (`fld add; fadd [acc]; fst [acc]; fcomp
 * [limit]`): returns the stored float32 and whether the 53-bit sum reached
 * `limit`.
 */
export function accumulate(acc: number, add: number, limit: number): { stored: number; reached: boolean } {
  const sum = x87Add(add, acc);
  return { stored: x87StoreF32(sum), reached: limit <= sum };
}

/** Glass break threshold, drawn from the level RNG when the pane is created (FUN_00448630). */
export function glassThreshold(rng: LevelRng): number {
  return x87StoreF32(rng.float() * GLASS_THRESHOLD_RANGE + GLASS_THRESHOLD_BASE);
}

/** rand(3) of FUN_00449470: the glass_crush sound. */
export function glassSound(rng: LevelRng): string {
  return GLASS_SOUNDS[rng.int(3)];
}

/**
 * FUN_0047f350 + FUN_0047f410: a new explosion. Draws three randoms for the
 * fragment direction (r - 0.5, r - 0.5, r - 0.3; f32 0x531508, 0x5316a4),
 * normalised as float32, then three for the fragment type's spin (x 0.628,
 * 0x5321a4; visual only).
 */
export function makeExplosion(
  rng: LevelRng,
  a: {
    position: V3; count?: number; interval: number; damage: number; radius: number; falloff: number; scorch: number;
    fragments: number; fireballs: number; sound: string; aiRange: number | null; sourceWeaponId?: number | null;
    fragmentModel?: string;
  },
): ExplosionSpec {
  const dx = x87StoreF32(rng.float() - 0.5);
  const dy = x87StoreF32(rng.float() - 0.5);
  const dz = x87StoreF32(rng.float() - Math.fround(0.30000001192092896));
  const len = Math.sqrt(dz * dz + dy * dy + dx * dx);
  const inv = len > 0 ? 1 / len : 0;
  const direction: V3 = len > 0 ? [x87StoreF32(dx * inv), x87StoreF32(dy * inv), x87StoreF32(dz * inv)] : [0, 0, 0];
  // FUN_0047f410: the fragment container's spin, three floats x 0.628 (f32 0x5321a4).
  const spin: V3 = [
    x87StoreF32(rng.float() * Math.fround(0.6283185482025146)),
    x87StoreF32(rng.float() * Math.fround(0.6283185482025146)),
    x87StoreF32(rng.float() * Math.fround(0.6283185482025146)),
  ];
  return {
    spin,
    position: [a.position[0], a.position[1], a.position[2]],
    count: a.count ?? 1,
    interval: a.interval,
    damage: Math.fround(a.damage),
    radius: Math.fround(a.radius),
    falloff: Math.fround(a.falloff),
    scorch: a.scorch,
    fragments: a.fragments,
    fireballs: a.fireballs,
    fragmentModel: a.fragmentModel ?? FRAGMENT_MODEL,
    sound: a.sound,
    aiRange: a.aiRange,
    sourceWeaponId: a.sourceWeaponId ?? null,
    direction,
    spread: FRAGMENT_SPREAD,
    speedMin: FRAGMENT_SPEED_MIN,
    speedMax: FRAGMENT_SPEED_MAX,
  };
}

// --- The explosion's visuals (FUN_0047d570) -----------------------------------------

export interface FireballSpec {
  /** Offset from the explosion centre, units. */
  offset: V3;
  /** Size, units: the dome radius (model 1006_01_1 is ~2048 units, scale = size / 2048). */
  size: number;
  /** Life (+0xf4 / +0xf8) and frame period (+0x108), ticks. */
  life: number;
  period: number;
  /** Ticks before it appears (+0xfc). */
  delay: number;
}

/**
 * FUN_0047d570 fireballs: one at the centre (size = radius, x 0.75 when
 * there are several), life 75; each further one i = 1 .. n-1 draws
 * size (r x 0.25 + 0.5) x radius, one discarded draw, offset
 * (r - 0.5) x radius per axis, life trunc((r + 1) x 75 x 0.5) and delay
 * (75 / n) i - trunc(r x -15).
 */
export function fireballPlan(rng: LevelRng, radius: number, n: number): FireballSpec[] {
  const out: FireballSpec[] = [];
  if (n === 0) return out;
  const main = n > 1 ? x87StoreF32(radius * Math.fround(0.75)) : x87StoreF32(radius);
  out.push({ offset: [0, 0, 0], size: main, life: FIREBALL_LIFE, period: FIREBALL_LIFE, delay: 0 });
  const r32 = x87StoreF32(radius);
  for (let i = 1; i <= n - 1; i++) {
    const size = x87StoreF32((rng.float() * 0.25 + 0.5) * r32);
    rng.float();
    const ox = (rng.float() - 0.5) * radius;
    const oy = (rng.float() - 0.5) * radius;
    const oz = (rng.float() - 0.5) * radius;
    const life = x87Fistp((rng.float() + 1) * FIREBALL_LIFE * 0.5);
    const k = x87Fistp(rng.float() * -15);
    const delay = Math.trunc(FIREBALL_LIFE / n) * i - k;
    out.push({ offset: [ox, oy, oz], size, life, period: life, delay });
  }
  return out;
}

/** FUN_0047d570 smoke (ExplosionSmoke, FUN_0047d520): life trunc(299 - 150 / n) for n > 1, else 150; size radius x 0.9. */
export function smokePlan(radius: number, n: number): { life: number; size: number } | null {
  if (n === 0) return null;
  const life = n > 1 ? x87Fistp(Math.fround(150) - Math.fround(150) / n - 1 + 150) : 150;
  return { life, size: x87StoreF32(radius * 0.8999999761581421) };
}

// --- FireBall draw (FUN_0047ea50 update, LAB_0047eb00 draw) ---------------------------

/** FireBall z scale floor (f32 0x531714) and the size -> scale factor (double 0x532198). */
export const FIREBALL_Z_FLOOR = Math.fround(0.009999999776482582);

/**
 * FUN_0047ea50 frame: trunc((life - left) / period x frames) mod frames, in
 * the chop-mode x87 (fild; fidiv; fimul; fistp; idiv) [recovered].
 */
export function fireballFrame(life: number, left: number, period: number, frames: number): number {
  if (frames <= 0) return -1;
  return x87Fistp(x87Mul(x87Div(life - left, period), frames)) % frames;
}

/**
 * LAB_0047eb00 scale: x = y = size / 2048 (+0x10c); z (the axis turned to the
 * camera) = (1 - left / life) x size / 2048 + 0.01, from the counter AFTER
 * the tick's update (the draw follows the update) [recovered 0x47eb22-0x47eb63].
 */
export function fireballScale(size: number, left: number, life: number): V3 {
  const s = x87StoreF32(size * FIREBALL_SCALE);
  const z = x87StoreF32(x87Add(x87Mul(x87Sub(1, x87Div(left, life)), s), FIREBALL_Z_FLOOR));
  return [s, s, z];
}

/**
 * LAB_0047eb00 basis (world = M v, IGI rows): d = unit(camera - centre) (or
 * (1, 0, 0) when they coincide); a = unit(z x d) = unit(-d.y, d.x, 0);
 * b = unit(d x a); c = unit(a x b) (= d); M has the columns a, b, c, so the
 * dome's z axis (its apex, model 1006_01_1 spans z 0..2038) points at the
 * camera, x stays horizontal. d = (0, 0, 1) exactly gives the identity. The
 * extra rotation about the result (+0x110 += +0x114, both 0 for explosions)
 * is the identity [recovered 0x47eb6b-0x47f0f0].
 */
export function fireballBasis(toCamera: readonly number[]): Mat3 {
  const f = Math.fround;
  let d: V3 = [f(toCamera[0]), f(toCamera[1]), f(toCamera[2])];
  if (d[0] === 0 && d[1] === 0 && d[2] === 0) d = [1, 0, 0];
  else {
    const k = f(1 / Math.sqrt(d[1] * d[1] + d[0] * d[0] + d[2] * d[2]));
    d = [f(d[0] * k), f(d[1] * k), f(d[2] * k)];
  }
  if (d[0] === 0 && d[1] === 0 && d[2] === 1) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const unit = (v: V3): V3 => {
    if (v[0] === 0 && v[1] === 0 && v[2] === 0) return v;
    const k = f(1 / Math.sqrt(v[2] * v[2] + v[1] * v[1] + v[0] * v[0]));
    return [f(v[0] * k), f(v[1] * k), f(v[2] * k)];
  };
  const a0: V3 = [f(0 - d[1]), f(-(0 - d[0])), 0];
  const b0: V3 = [f(d[1] * a0[2] - d[2] * a0[1]), f(-(d[0] * a0[2] - d[2] * a0[0])), f(d[0] * a0[1] - d[1] * a0[0])];
  const a = unit(a0);
  const c0: V3 = [f(b0[2] * a[1] - b0[1] * a[2]), f(-(b0[2] * a[0] - b0[0] * a[2])), f(b0[1] * a[0] - b0[0] * a[1])];
  const b = unit(b0);
  const c = unit(c0);
  // Rows a, b, c transposed: the columns of the world matrix.
  return [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
}

// --- ExplosionSmoke particles (FUN_0047e790 -> FUN_0047ce40 -> FUN_004f4b20 / FUN_004f4d40) ---

/**
 * The two particle systems of an ExplosionSmoke, both one smoke2.spr particle
 * (DAT_005c4510) at the explosion centre [recovered FUN_0047ce40]:
 * acceleration (0, 0, 2.2300444) units/tick^2 (0x400eb90c), colour 12.7 in
 * the 1/128 scale (0x414b3333, so at most 0.099 x the particle alpha), far
 * 819200 units (0x49480000), 1 particle, no frame animation, no system light
 * (+0xdc = 0); emitted with velocity (0, 0, 1), scale 1, angle r x 2 pi
 * (0x531594), spin (0.5 - r) x 0.01885 rad/tick (0x53216c).
 */
export const SMOKE = {
  sprite: "smoke2.spr",
  accel: Math.fround(2.230044364929199),
  colour: Math.fround(12.699999809265137),
  far: 819200,
  maxParticles: 1,
  velocity: 1,
  /** First update: SRCALPHA / ONE (TL flag 0x8), linear. */
  glowFlags: 0x1000008,
  /** At 90 % of the life: ZERO / INVSRCCOLOR (TL flag 0x10), linear. */
  shadeFlags: 0x1000010,
  angleScale: Math.fround(6.2831854820251465),
  spinScale: Math.fround(0.018849557265639305),
  /** Glow: life trunc(T x 0.1) (0x5313c8), fade over trunc((r x 0.2 + 0.8) T) ticks (0x5313c4, 0x5316cc), alpha (r + 1) x 0.1. */
  glowLife: Math.fround(0.10000000149011612),
  glowFadeRange: Math.fround(0.20000000298023224),
  glowFadeBase: Math.fround(0.800000011920929),
  glowAlpha: Math.fround(0.10000000149011612),
  /** Shade: created at left == trunc(T x 0.9) (0x5315bc), life T, fade 1 per tick, alpha 0.001 then set every update. */
  shadeAt: Math.fround(0.8999999761581421),
  shadeStartAlpha: Math.fround(0.0010000000474974513),
  shadeAlpha: Math.fround(0.30000001192092896),
} as const;

/** One ExplosionSmoke particle system as FUN_0047ce40 creates it. */
export interface SmokeParticle {
  /** TL flags (+0xe8, | 0x40000 by FUN_004f4b20). */
  flags: number;
  /** Half-size (x, y) = the smoke size, units. */
  halfSize: number;
  /** Scale growth per tick (+0xe4) = 1 / T. */
  growth: number;
  /** Particle life (ticks before the fade). */
  life: number;
  /** Fade ticks (0 = alpha -1 per tick). */
  fadeTicks: number;
  alpha: number;
  angle: number;
  spin: number;
}

/** FUN_0047ce40's two draws (angle, then spin). */
function smokeParticle(rng: LevelRng, flags: number, size: number, growth: number, life: number, fadeTicks: number, alpha: number): SmokeParticle {
  const angle = x87StoreF32(x87Mul(rng.float(), SMOKE.angleScale));
  const spin = x87StoreF32(x87Mul(x87Sub(Math.fround(0.5), rng.float()), SMOKE.spinScale));
  return { flags, halfSize: size, growth, life, fadeTicks, alpha, angle, spin };
}

/**
 * ExplosionSmoke first update (left == T, 0x47e7bc-0x47e847): four level-RNG
 * draws in order: fade, alpha, angle, spin.
 */
export function smokeGlow(rng: LevelRng, total: number, size: number): SmokeParticle {
  const life = x87Fistp(x87Mul(total, SMOKE.glowLife));
  const t32 = x87StoreF32(total);
  const fadeTicks = x87Fistp(x87Mul(x87Add(x87Mul(rng.float(), SMOKE.glowFadeRange), SMOKE.glowFadeBase), t32));
  const growth = x87F32Div(1, t32);
  const alpha = x87StoreF32(x87Mul(x87Add(rng.float(), 1), SMOKE.glowAlpha));
  return smokeParticle(rng, SMOKE.glowFlags, size, growth, life, fadeTicks, alpha);
}

/** The update on which the shade system appears: left == trunc(T x 0.9). */
export function smokeShadeTick(total: number): number {
  return x87Fistp(x87Mul(total, SMOKE.shadeAt));
}

/** ExplosionSmoke shade system (0x47e873-0x47e8ae): two draws (angle, spin). */
export function smokeShade(rng: LevelRng, total: number, size: number): SmokeParticle {
  return smokeParticle(rng, SMOKE.shadeFlags, size, x87StoreF32(x87Div(1, total)), total, 0, SMOKE.shadeStartAlpha);
}

/**
 * FUN_004f5200 argument of every update once the shade exists (0x47e8bc-0x47e902):
 * h = T / 2; k = left / h when left <= h, else 1 - (left - h) / (0.9 T - h);
 * alpha = k x 0.3, written to every particle of the shade system.
 */
export function smokeShadeAlpha(left: number, total: number): number {
  const h = x87Mul(total, 0.5);
  const k = left <= h ? x87Div(left, h) : x87Sub(1, x87Div(x87Sub(left, h), x87Sub(x87Mul(x87StoreF32(total), SMOKE.shadeAt), h)));
  return x87StoreF32(x87Mul(k, SMOKE.shadeAlpha));
}

// --- FlashBang (FUN_0047cd10 create, FUN_0047cb00 / FUN_0047cb90) ----------------------

/**
 * The flash grenade's FlashBang task [recovered]: a smoke1.spr system
 * (DAT_005c44fc) with colour 127, half-size 2457.6 (0x4519999a), far 819200,
 * flags 0x1000008 (SRCALPHA / ONE), growth 0.0145833 per tick (0x3c6eeeef),
 * 20 particles; its first update emits three particles (three draws each:
 * speed, alpha, spin), plays explo_flash, broadcasts AI event 19 (FLASHBANG,
 * team -1, flags 3, range 40960) and deletes the task. FUN_0047cd10 also
 * scorches the grenade's 0.5 m-down hit object with burn1.tex of half-size
 * 2048 (0x45000000) and sends the flash message (slot DAT_0053e8a4) to every
 * human first.
 */
export const FLASHBANG = {
  sprite: "smoke1.spr",
  colour: 127,
  halfSize: Math.fround(2457.60009765625),
  far: 819200,
  flags: 0x1000008,
  growth: Math.fround(0.014583333395421505),
  maxParticles: 20,
  count: 3,
  life: 90,
  fadeTicks: 30,
  scorchHalfSize: 2048,
  /** Upward speed (r + 1) x 1.5 km/h -> units/tick (doubles 0x531838; f32 0x5314a4, 0x5314a0). */
  speedKmh: 1.5,
  /** Alpha (r + 1) x 0.25 (double 0x531808); spin ((r - 0.5) x 2) x 0.0436332 + 0.0203622 (0x531870, 0x532168). */
  alpha: 0.25,
  spinScale: Math.fround(0.04363323375582695),
  spinBias: Math.fround(0.02036217600107193),
} as const;

/** The three FlashBang particles (velocity z, alpha, spin), level-RNG draws in order. */
export function flashbangPuff(rng: LevelRng): Array<{ speed: number; alpha: number; spin: number }> {
  const out: Array<{ speed: number; alpha: number; spin: number }> = [];
  for (let i = 0; i < FLASHBANG.count; i++) {
    const speed = x87StoreF32(x87Mul(x87Mul(x87Mul(x87Add(rng.float(), 1), FLASHBANG.speedKmh), Math.fround(4096000)), Math.fround(9.259259059035685e-6)));
    const alpha = x87StoreF32(x87Mul(x87Add(rng.float(), 1), FLASHBANG.alpha));
    const r = rng.float();
    const spin = x87StoreF32(x87Add(x87Mul(x87Add(x87Sub(r, 0.5), x87Sub(r, 0.5)), FLASHBANG.spinScale), FLASHBANG.spinBias));
    out.push({ speed, alpha, spin });
  }
  return out;
}

/** One explosion fragment at launch: velocity (units/tick) and rotation (IGI). */
export interface ExplosionFragment {
  velocity: V3;
  rotation: Mat3;
}

/**
 * FUN_0047d570 fragments (the launch of fx/bullet-effects.ts fragmentLaunch
 * with the explosion's cone and speeds): per fragment speed = (max - min) r
 * + min; the frame of the direction (FUN_004aa2f0) transposed, x Rz(r pi),
 * x Rx(r spread); velocity = its third column x speed; one unused draw;
 * tilt Rz(r1 k) Ry(r2 k) Rx(r3 k) with k = pi / 100 (FUN_0047d440).
 */
export function fragmentPlan(rng: LevelRng, spec: ExplosionSpec): ExplosionFragment[] {
  const out: ExplosionFragment[] = [];
  const f = frameOf(normalise([spec.direction[0], spec.direction[1], spec.direction[2]]));
  const t: Mat3 = [f[0], f[3], f[6], f[1], f[4], f[7], f[2], f[5], f[8]];
  for (let k = 0; k < spec.fragments; k++) {
    const speed = x87StoreF32((spec.speedMax - spec.speedMin) * rng.float() + spec.speedMin);
    const a = mulMat3(t, rotZ(x87StoreF32(rng.float() * Math.fround(3.1415927410125732))));
    const b = mulMat3(a, rotX(x87StoreF32(rng.float() * spec.spread)));
    rng.float();
    const velocity: V3 = [x87StoreF32(b[2] * speed), x87StoreF32(b[5] * speed), x87StoreF32(b[8] * speed)];
    const z = x87StoreF32(rng.float() * FRAGMENTS.tiltScale);
    const y = x87StoreF32(rng.float() * FRAGMENTS.tiltScale);
    const x = x87StoreF32(rng.float() * FRAGMENTS.tiltScale);
    out.push({ velocity, rotation: rotZYX(x, y, z) });
  }
  return out;
}

/**
 * Fragment gravity per tick (FUN_004fa1d0): the container's size argument
 * (FUN_0047f410: blast radius x 0.9 / 4096, f32 0x5321a0) x 44.6 x drag 0.98.
 */
export function fragmentGravity(radius: number): number {
  const scale = x87F32Mul(Math.fround(radius), Math.fround(0.0002197265566792339));
  return x87F32Mul(x87F32Mul(scale, FRAGMENTS.gravity), FRAGMENTS.drag);
}

/** One fragment tick (FUN_004fa1d0): v = 0.98 v, v.z -= gravity, p += v, R = spin R. No collision. */
export function explosionFragmentStep(position: V3, velocity: V3, rotation: Mat3, spinRotation: Mat3, gravity: number): { position: V3; velocity: V3; rotation: Mat3 } {
  const vx = x87F32Mul(FRAGMENTS.drag, velocity[0]);
  const vy = x87F32Mul(FRAGMENTS.drag, velocity[1]);
  const vz = x87F32Sub(x87F32Mul(FRAGMENTS.drag, velocity[2]), gravity);
  return { position: [position[0] + vx, position[1] + vy, position[2] + vz], velocity: [vx, vy, vz], rotation: mulMat3(spinRotation, rotation) };
}

/** Fragments live 45 ticks (+1 to be removed, FUN_004fa7d0); the shared spin decays x 0.99 per tick. */
export const FRAGMENT_LIFE = FRAGMENTS.lifeTicks;
export { x87Spin as fragmentSpinDecay, rotZYX as spinRotation };

// --- Humans ------------------------------------------------------------------------

/** FUN_004645e0 view shake: amplitude (units), angle (radians), duration (ticks). */
export interface ViewShake {
  amplitude: number;
  angle: number;
  ticks: number;
}

/** The shake an explosion gives a human's view (player FUN_00412930, soldiers FUN_004592a0 ...). */
export function explosionShake(rec: ExplosionRecord, eyeDistance: number, angleScale: number): ViewShake | null {
  let k: number;
  const e = eyeDistance - rec.radius * SHAKE_NEAR;
  if (e < 0) k = 1;
  else {
    k = 1 - e / (rec.radius * SHAKE_FAR);
    if (!(k > 0)) return null;
  }
  return { amplitude: x87StoreF32(k * SHAKE_AMPLITUDE), angle: x87StoreF32(k * angleScale), ticks: rec.shakeTicks };
}

export interface PlayerExplosionHit {
  /** Knock-back added to +0x670 / +0x674 (IGI x, y units per tick), or null. */
  knock: [number, number] | null;
  /** Ear ringing added to +0xdc8 (clamped to [0, 1] by the player tick), 0 when out of range. */
  earcandy: number;
  shake: ViewShake | null;
  /** Damage after zone 13 and difficulty; 0 = untouched (no sound, no indicators). */
  damage: number;
  /** Hit-direction indicators +0xdcc..+0xdd8 (all four), when damaged. */
  indicators: [number, number, number, number] | null;
}

/**
 * FUN_00412930, the player's explosion handler. `eye` = the view position
 * (HumanView +0xe0), `origin` = human +0x20, `modelRadius` = +0xa0 (the
 * body model's origin radius). Draws four randoms when damaged.
 */
export function playerExplosionHit(
  rec: ExplosionRecord,
  eye: readonly number[],
  origin: readonly number[],
  modelRadius: number,
  zoneMultiplier: number,
  difficulty: 0 | 1 | 2,
  attached: boolean,
  rng: LevelRng,
): PlayerExplosionHit {
  const dx = eye[0] - rec.position[0];
  const dy = eye[1] - rec.position[1];
  const dz = eye[2] - rec.position[2];
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  let knock: [number, number] | null = null;
  if (d < (Math.fround(rec.falloff + rec.radius)) * KNOCK_RANGE_FACTOR && !attached) {
    const y32 = x87StoreF32(dy);
    let nx = dx;
    let ny = y32;
    if (dx !== 0 || y32 !== 0 || dz !== 0) {
      const inv = 1 / Math.sqrt(dz * dz + y32 * y32 + dx * dx);
      nx = dx * inv;
      ny = x87StoreF32(y32 * inv);
    }
    knock = [x87StoreF32(nx * EXPLOSION_KNOCK), x87StoreF32(ny * EXPLOSION_KNOCK)];
  }
  const earcandy = d < EARCANDY_RANGE ? 1 - d * EARCANDY_PER_UNIT : 0;
  const shake = explosionShake(rec, d, SHAKE_ANGLE_PLAYER);
  let damage = explosionFactor(rec, origin, x87StoreF32(modelRadius * HUMAN_RADIUS_FACTOR));
  if (damage === 0) return { knock, earcandy, shake, damage: 0, indicators: null };
  damage = x87StoreF32(damage * zoneMultiplier);
  if (difficulty !== 1) damage = x87StoreF32(damage * PLAYER_EXPLOSION_DIFFICULTY[difficulty]);
  const indicator = () => x87StoreF32((rng.float() + 1) * INDICATOR_SCALE);
  const indicators: [number, number, number, number] = [indicator(), indicator(), indicator(), indicator()];
  return { knock, earcandy, shake, damage, indicators };
}

export interface SoldierExplosionHit {
  shake: ViewShake | null;
  /** Damage after the zone-13 multiplier, 0 = untouched. */
  damage: number;
}

/** FUN_004592a0 (HumanSoldier) and its siblings: view shake, then damage x zone 13; nothing when invulnerable. */
export function soldierExplosionHit(
  rec: ExplosionRecord,
  eye: readonly number[],
  origin: readonly number[],
  modelRadius: number,
  zoneMultiplier: number,
): SoldierExplosionHit {
  const shake = explosionShake(rec, length(rec.position, eye), SHAKE_ANGLE_SOLDIER);
  const raw = explosionFactor(rec, origin, x87StoreF32(modelRadius * HUMAN_RADIUS_FACTOR));
  return { shake, damage: raw === 0 ? 0 : x87StoreF32(raw * zoneMultiplier) };
}
