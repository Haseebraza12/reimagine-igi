/**
 * Bullet-impact and gun effect RULES of igi.exe, as pure functions (no
 * Three.js). Every value below was read from igi.exe; addresses are given per
 * rule, evidence labels as in docs/rendering.md section 7 (recovered unless
 * marked inferred). The Three.js parts live in decals.ts, particles.ts,
 * debris.ts, tracers.ts, casings.ts; effects.ts wires them.
 *
 * Maths runs in IGI axes and units (x, y horizontal, z up, 4096 units = 1 m,
 * right-handed) relative to the level origin, because several rules are
 * defined against the world z axis (FUN_004aa2f0, the decal frame). Row-major
 * 3x3 matrices applied to column vectors (world = M v), as igi.exe stores an
 * object's rotation at +0x70 (rows of 3 floats, FUN_004a9bc0 / FUN_004a9e40 /
 * FUN_004a9e80 / FUN_004a9ec0).
 */
import type { Vec3 } from "../../contracts";
import type { ImpactEffect, ImpactMaterial } from "../../loaders";
import { x87Add, x87F32Add, x87F32Mul, x87F32Sub, x87Fistp, x87Mul, x87StoreF32 } from "../../loaders/x87";

/** IGI units per metre. */
export const UNITS = 4096;

/** Uniform [0, 1) / integer draws of igi.exe's three-word generator (ai/rng.ts LevelRng). */
export interface EffectRng {
  /** FUN_004aaa20: one step, the raw u32. */
  step(): number;
  /** FUN_004aaa50. */
  float(): number;
  /** FUN_004aaaa0. */
  int(n: number): number;
}

// ---------------------------------------------------------------------------
// Axes
// ---------------------------------------------------------------------------

/** Engine direction (y up, -z = IGI +y) -> IGI direction (z up). */
export function igiDir(v: Vec3): Vec3 {
  return [v[0], -v[2], v[1]];
}

/** IGI direction -> engine direction. */
export function engineDir(v: Vec3): Vec3 {
  return [v[0], v[2], -v[1]];
}

/** Engine point (metres, relative to the level origin) -> IGI units relative to the origin. */
export function igiPoint(p: Vec3): Vec3 {
  return [p[0] * UNITS, -p[2] * UNITS, p[1] * UNITS];
}

/** IGI units relative to the origin -> engine metres. */
export function enginePoint(p: Vec3): Vec3 {
  return [p[0] / UNITS, p[2] / UNITS, -p[1] / UNITS];
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** igi.exe's normalise: unchanged when exactly zero, else v * (1 / |v|) (0x5313f8 = 1.0). */
export function normalise(v: Vec3): Vec3 {
  if (v[0] === 0 && v[1] === 0 && v[2] === 0) return [0, 0, 0];
  const k = 1 / Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] * k, v[1] * k, v[2] * k];
}

/** Row-major 3x3, world = M v. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9) as Mat3;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}

export function mulMat3Vec(m: Mat3, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

/** FUN_004a9e40: rotation about x. */
export function rotX(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
/** FUN_004a9e80: rotation about y. */
export function rotY(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
/** FUN_004a9ec0: rotation about z. */
export function rotZ(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}
/** FUN_004a9bc0(m, x, y, z): Rz(z) Ry(y) Rx(x). */
export function rotZYX(x: number, y: number, z: number): Mat3 {
  return mulMat3(mulMat3(rotZ(z), rotY(y)), rotX(x));
}

/**
 * FUN_004aa2f0: frame of a direction n (rows b, c, d): a = (n.y, -n.x, 0)
 * normalised ((0, 1, 0) when n.x = n.y = 0), b = |a x n|, c = |n x b|,
 * d = |b x c| (= n). Used for the bullet-hole quad and the fragment cone.
 */
export function frameOf(n: Vec3): Mat3 {
  let a: Vec3;
  if (n[0] === 0 && n[1] === 0) a = [0, 1, 0];
  else a = normalise([n[1], -n[0], 0]);
  const b = normalise(cross(a, n));
  const c = normalise(cross(n, b));
  const d = normalise(cross(b, c));
  return [b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]];
}

// ---------------------------------------------------------------------------
// What the bullet loop reports (combat/bullet.ts must fill this; see the
// report in docs/rendering.md section 7 "Port hooks")
// ---------------------------------------------------------------------------

/** Identity of the surface a ray hit, for the per-object bullet-hole lists. */
export interface HitSurface {
  terrain: boolean;
  /** RayHit.owner: placed instance index (-1 for terrain / extra geometry). */
  owner: number;
  /** Dynamic body id (RayHit.triangle < 0 ? -1 - triangle : null). */
  body: number | null;
  /** A human body (BoneDynCubeObj): no debris, dust or bullet hole. */
  human: boolean;
}

/** One ray hit of the bullet loop (FUN_00479e30), front or back face, in trace order. */
export interface BulletHitReport extends HitSurface {
  /** Entering (front) or leaving (back) face. */
  front: boolean;
  /** Material name of the record word: front -> word 0x13 (untagged object faces and terrain = "Ground"), back -> word 0x14; null = none. */
  material: string | null;
  /** Hit point, engine metres. */
  point: Vec3;
  /** Outward face normal (front: towards the shooter = RayHit.normal; back: -RayHit.normal), engine, unit. */
  faceNormal: Vec3;
  /**
   * Vector of the cast that produced the hit, engine metres: (start + dir *
   * remaining) - start = dir * remaining, with dir BEFORE a ricochet on this
   * hit changes it (local_5ac - local_5e4 at 0x47a6xx).
   */
  segment: Vec3;
}

/** One cast of the bullet loop (tracer rule, 0x47a7c0-0x47a90e). */
export interface BulletSegmentReport {
  /** Cast start, engine metres. */
  start: Vec3;
  /** Hit point, or start + dir * remaining when nothing was hit. */
  end: Vec3;
  /** The bullet passed through the face hit by this cast (local_705). */
  passed: boolean;
  /** The bullet has ricocheted (bullet +0x40), as set after this cast. */
  ricocheted: boolean;
}

export interface BulletReport {
  /** Who fired: "player" or an enemy id; one tracer counter per shooter + weapon (GunShot +0x98). */
  shooter: string | number;
  weaponId: string;
  /** WeaponConfig "Calibre ID": the ammo type whose arg 4 equals it gives the tracer (FUN_0047b450, gun +0x12c). */
  calibreId: number;
  /** Bullet range, metres (bullet +0x34 = Effective Range x 4096). */
  rangeMetres: number;
  hits: BulletHitReport[];
  segments: BulletSegmentReport[];
  /** The bullet ricocheted (bullet +0x40) at the end of the trace. */
  ricocheted: boolean;
}

// ---------------------------------------------------------------------------
// FUN_00479e30 tail: which impacts get an effect, with which flag
// ---------------------------------------------------------------------------

export const MAX_IMPACT_EFFECTS = 10;

export interface GunshotEffectCall {
  /** 0 = material entry A (+0x254 / +0x258, front faces), 1 = entry B (+0x25c / +0x260, back faces). */
  entry: 0 | 1;
  effect: ImpactEffect;
  hit: BulletHitReport;
  /** Unit direction (IGI axes) handed to FUN_004084d0: front = the segment mirrored about the face, back = the segment. */
  direction: Vec3;
  /** FUN_004084d0 flag: 1 except on the last record, and 0 for every record of a bullet that ricocheted. */
  flag: boolean;
}

function findMaterial(materials: readonly ImpactMaterial[], name: string | null): ImpactMaterial | null {
  if (!name) return null;
  const key = name.toLowerCase();
  return materials.find((m) => m.name.toLowerCase() === key) ?? null;
}

/**
 * Records and flags of FUN_00479e30 [recovered]:
 *   - front hits (word 0x13 set) are recorded only when material entry A's
 *     first texture handle (record +0x58) is non-null (0x47a4c5), so Air,
 *     Water, Fence, HumanCollision, MetalLadder, MetalFence record nothing;
 *     direction = D - 2 (D.n) n (D = the cast vector, n = the unit face normal);
 *   - back hits (word 0x14 set) are always recorded (0x47a0d0), direction = D;
 *   - at most 10 records per bullet (local_700 < 10);
 *   - flag (0x47a940-0x47a98a): 0 when the bullet ricocheted; else 1, except
 *     the last record gets 0 when (record normal . direction) > 0, which holds
 *     for every front and back record (so the last record always has 0).
 */
export function gunshotEffectCalls(hits: readonly BulletHitReport[], ricocheted: boolean, materials: readonly ImpactMaterial[]): GunshotEffectCall[] {
  const out: Array<Omit<GunshotEffectCall, "flag">> = [];
  for (const hit of hits) {
    if (out.length >= MAX_IMPACT_EFFECTS) break;
    const m = findMaterial(materials, hit.material);
    if (!m) continue;
    const n = normalise(igiDir(hit.faceNormal));
    const d = igiDir(hit.segment);
    if (hit.front) {
      const effect = m.effects[0];
      if (!effect.decalTextures[0]) continue;
      const k = dot(d, n);
      out.push({ entry: 0, effect, hit, direction: normalise([d[0] - 2 * k * n[0], d[1] - 2 * k * n[1], d[2] - 2 * k * n[2]]) });
    } else {
      out.push({ entry: 1, effect: m.effects[1], hit, direction: normalise(d) });
    }
  }
  return out.map((c, i) => {
    let flag: boolean;
    if (ricocheted) flag = false;
    else if (i < out.length - 1) flag = true;
    else flag = !(dot(igiDir(c.hit.faceNormal), c.direction) > 0);
    return { ...c, flag };
  });
}

// ---------------------------------------------------------------------------
// GunShotEffect handler FUN_004376c0 (record parsed by FUN_00437a30)
// ---------------------------------------------------------------------------

/**
 * TASKTYPE_GUNSHOTEFFECT record (0x60 bytes, FUN_00437a30) from
 * DefineGameMaterial's six values after the task symbol:
 *   +0 byte  "dust": concrete1.spr puffs (ImpactEffect.flagA)
 *   +1 byte  "debris": the impact model thrown as fragments (ImpactEffect.flagB)
 *   +2, +0x1a texture 1 / texture 2 (24 chars); +0x58 / +0x5c their handles
 *   +0x54 size x 4096.0 (double 0x531498): the bullet hole HALF-size in units
 *   +0x32 model (32 chars)
 */
export const GUNSHOT_EFFECT = {
  /** Fragments: rand(3) + 2 copies of the model (0x4376ff). */
  debrisCountBase: 2,
  debrisCountRange: 3,
  /** Explosion0 args (0x43770c-0x437749): cone 0x3f060a92 (30 deg), speed 340..680 units/tick, explosion size 2048. */
  debrisConeRad: Math.fround(0.5235987901687622),
  debrisSpeedMin: 340,
  debrisSpeedMax: 680,
  explosionSize: 2048,
  /** Dust (0x4377eb-0x437a1c): 50 % (step & 1), two concrete1.spr particles. */
  dustHalfSize: Math.fround(163.84000396728516),
  /** pos1 = hit + n * halfSize * 3.0 (double 0x531810); pos2 = pos1 + z halfSize * 0.25 (double 0x531808). */
  dustOffsetFactor: 3,
  dustRaiseFactor: 0.25,
  /** Upward speed (r * 0.75 + 0.15) * 4096000 * (1 / 108000) units/tick (km/h -> units/tick, f32 0x5314a4 / 0x5314a0); the second puff x 1.25. */
  dustSpeedUnits: Math.fround(4096000),
  dustSpeedPerHour: Math.fround(9.259259059035685e-6),
  dustSecondSpeedFactor: Math.fround(1.25),
  /** Alpha r * 0.25 + 0.75 (doubles 0x531808, 0x531800), shared by both puffs. */
  /** Spin ((r - 0.5) * 2) * 0.0523599 + 0.0127991 rad/tick (0x5317f4, 0x5317f0). */
  spinScale: Math.fround(0.05235987901687622),
  spinBias: Math.fround(0.012799081392586231),
  /** Particle life 15 ticks, then alpha -= 1/30 per tick (args 0xf, 0x1e). */
  dustLife: 15,
  dustFadeTicks: 30,
  /** System: colour (127,127,127) in the 1/128 scale, growth 0.0889 / tick (0x3db60b61), 2 particles, far 409600 (100 m), flags 0x1080000. */
  dustColour: 127,
  dustGrowth: Math.fround(0.08888889104127884),
  dustMaxParticles: 2,
  particleFar: 409600,
  dustFlags: 0x1080000,
} as const;

/** Spin rate of a particle, one level-RNG float (0x437986 / 0x462b39). */
export function particleSpin(r: number): number {
  const h = x87Add(r, -0.5);
  return x87StoreF32(x87Add(x87Mul(x87Add(h, h), GUNSHOT_EFFECT.spinScale), GUNSHOT_EFFECT.spinBias));
}

export interface DebrisPlan {
  model: string;
  count: number;
  /** Shared angular velocity (rad/tick, IGI axes x, y, z), decays x0.99 per tick. */
  spin: Vec3;
  /** Unit launch axis (IGI). */
  direction: Vec3;
}

export interface DustPlan {
  /** Upward speeds (units/tick) of the two puffs. */
  speeds: [number, number];
  alpha: number;
  spins: [number, number];
}

export interface GunshotEffectPlan {
  debris: DebrisPlan | null;
  /** Bullet-hole texture file (or null) and half-size in units. */
  decal: { texture: string; halfSizeUnits: number } | null;
  dust: DustPlan | null;
}

/**
 * FUN_004376c0 with its level-RNG draws in order [recovered]:
 *   1. human = the hit object derives from BoneDynCubeObj (FUN_00401d30 with
 *      FUN_004cfca0): humans get no debris and no dust;
 *   2. debris (+1 set, not human): count = rand(3) + 2; Explosion0
 *      (FUN_0047f410) draws three floats for its spin (x 0.6283185, 0x5321a4);
 *   3. bullet hole when the hit has an object and ((flag and texture 1) or
 *      texture 2): texture 1 when the flag is set and it exists, else
 *      texture 2; sent to the object's bullet-hole handler (slot
 *      DAT_0053e894), which may not exist (humans, wires, ...);
 *   4. dust (+0 set, not human): one raw step, odd -> puffs: speed, alpha and
 *      two spins (four floats).
 */
export function gunshotEffectPlan(call: GunshotEffectCall, rng: EffectRng): GunshotEffectPlan {
  const e = call.effect;
  const human = call.hit.human;
  let debris: DebrisPlan | null = null;
  if (e.flagB && !human) {
    const count = rng.int(GUNSHOT_EFFECT.debrisCountRange) + GUNSHOT_EFFECT.debrisCountBase;
    const k = Math.fround(0.6283185482025146);
    const spin: Vec3 = [x87StoreF32(rng.float() * k), x87StoreF32(rng.float() * k), x87StoreF32(rng.float() * k)];
    debris = e.model ? { model: e.model, count, spin, direction: call.direction } : null;
  }
  let decal: GunshotEffectPlan["decal"] = null;
  const [t1, t2] = e.decalTextures;
  const texture = call.flag && t1 ? t1 : t2 || null;
  if (texture) decal = { texture, halfSizeUnits: x87StoreF32(e.size * 4096) };
  let dust: DustPlan | null = null;
  if (e.flagA && !human && (rng.step() & 1) !== 0) {
    const v = x87StoreF32(x87Mul(x87Mul(x87Add(x87Mul(rng.float(), 0.75), 0.15), GUNSHOT_EFFECT.dustSpeedUnits), GUNSHOT_EFFECT.dustSpeedPerHour));
    const alpha = x87StoreF32(x87Add(x87Mul(rng.float(), 0.25), 0.75));
    const spin1 = particleSpin(rng.float());
    const v2 = x87F32Mul(v, GUNSHOT_EFFECT.dustSecondSpeedFactor);
    const spin2 = particleSpin(rng.float());
    dust = { speeds: [v, v2], alpha, spins: [spin1, spin2] };
  }
  return { debris, decal, dust };
}

/** The two dust positions (IGI units rel. origin, doubles): hit + |n| * 491.52, then the same + z 40.96 (0x4378a0-0x437938). */
export function dustPositions(hitIgi: Vec3, normalIgi: Vec3): [Vec3, Vec3] {
  const n = normalise(normalIgi);
  const o = GUNSHOT_EFFECT.dustHalfSize * GUNSHOT_EFFECT.dustOffsetFactor;
  const p1: Vec3 = [x87Add(x87Mul(o, n[0]), hitIgi[0]), x87Add(x87Mul(o, n[1]), hitIgi[1]), x87Add(x87Mul(o, n[2]), hitIgi[2])];
  const p2: Vec3 = [p1[0], p1[1], x87Add(GUNSHOT_EFFECT.dustHalfSize * GUNSHOT_EFFECT.dustRaiseFactor, p1[2])];
  return [p1, p2];
}

// ---------------------------------------------------------------------------
// Bullet holes (BulletHole class FUN_0047b630; FUN_0047b9d0 objects,
// FUN_0047c6b0 terrain, FUN_0047bf10 quad, 0x47b700 draw)
// ---------------------------------------------------------------------------

export const BULLET_HOLE = {
  /** At most 100 objects carry a bullet-hole list (pool FUN_004a6f60(&DAT_005c44b8, 4, 100, 4)); later objects get none. */
  maxObjects: 100,
  /** 200 slots per object, a ring: the oldest slot is reused (+0x44e0 / +0x44e4 / +0x44e8). */
  slotsPerObject: 200,
  /** Quad lifted 12.288 units (3 mm) along the normal (0x47bf73). */
  liftUnits: Math.fround(12.288000106811523),
  /** Each corner needs geometry within 24.576 units along -n from the lifted corner (f32 0x532164), else the hole is not drawn. */
  probeUnits: Math.fround(24.576000213623047),
  /** A new hole is dropped when an existing one is within 1.5 x its half-size (f32 0x531544) ... */
  duplicateRadiusFactor: Math.fround(1.5),
  /** ... and (objects only) their normals' dot product exceeds 0.9 (f32 0x5315bc). */
  duplicateMinDot: Math.fround(0.8999999761581421),
  /** Corner UVs (0x47b7bd-0x47b84f): (+s,+s) (0,0); (-s,+s) (0,1); (+s,-s) (1,0); (-s,-s) (1,1). */
  uvs: [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ] as const,
  /** Triangles (c0, c1, c2) and (c1, c3, c2). */
  triangles: [0, 1, 2, 1, 3, 2] as const,
} as const;

/**
 * The four corners of a bullet hole (FUN_0047bf10): local (x, y, 12.288) with
 * x, y = +-halfSize in the frame of the unit normal (FUN_004aa2f0), plus the
 * centre. Order c0 (+,+), c1 (-,+), c2 (+,-), c3 (-,-). IGI axes.
 */
export function bulletHoleCorners(centre: Vec3, normal: Vec3, halfSize: number): [Vec3, Vec3, Vec3, Vec3] {
  const n = normalise(normal);
  const m = frameOf(n);
  const s = halfSize;
  const lift = BULLET_HOLE.liftUnits;
  const corner = (x: number, y: number): Vec3 => [
    m[0] * x + m[3] * y + m[6] * lift + centre[0],
    m[1] * x + m[4] * y + m[7] * lift + centre[1],
    m[2] * x + m[5] * y + m[8] * lift + centre[2],
  ];
  return [corner(s, s), corner(-s, s), corner(s, -s), corner(-s, -s)];
}

export interface StoredHole {
  centre: Vec3;
  normal: Vec3;
  halfSize: number;
  /** Not drawn (a corner overhangs: -NaN at +0x48), but still occupies its slot. */
  invalid: boolean;
}

/** FUN_0047b9d0 / FUN_0047c6b0 duplicate test against the existing holes of the object. */
export function isDuplicateHole(holes: readonly (StoredHole | null)[], centre: Vec3, normal: Vec3, terrain: boolean): boolean {
  const n = normalise(normal);
  for (const h of holes) {
    if (!h || h.invalid) continue;
    const dx = h.centre[0] - centre[0], dy = h.centre[1] - centre[1], dz = h.centre[2] - centre[2];
    const r = h.halfSize * BULLET_HOLE.duplicateRadiusFactor;
    if (!(dz * dz + dy * dy + dx * dx < r * r)) continue;
    if (terrain) return true;
    if (dot(n, normalise(h.normal)) > BULLET_HOLE.duplicateMinDot) return true;
  }
  return false;
}

/** Slot ring of one object (+0x44e0 last, +0x44e4 next, +0x44e8 count). Returns the slot for a new hole. */
export class HoleRing {
  count = 0;
  next = 0;
  last = -1;
  take(): number {
    let slot: number;
    if (this.count === BULLET_HOLE.slotsPerObject) {
      slot = this.next;
      const n = slot + 1;
      this.next = n > BULLET_HOLE.slotsPerObject - 1 ? slot - (BULLET_HOLE.slotsPerObject - 1) : n;
    } else {
      slot = this.count;
      this.count++;
    }
    this.last = slot;
    return slot;
  }
}

// ---------------------------------------------------------------------------
// Fragments (Explosion0 FUN_0047f410 -> burst FUN_0047d570 -> FUN_0047d440;
// SimpointObjContainer physics FUN_004fa1d0, SimpointObj life FUN_004fa7d0)
// ---------------------------------------------------------------------------

export const FRAGMENTS = {
  /** SimpointObjContainer args (FUN_004fa830): life 0x2d ticks, drag 0.98, gravity 44.6 x (size 2048 x 0.9/4096 = 0.45). */
  lifeTicks: 45,
  drag: Math.fround(0.9800000190734863),
  gravity: Math.fround(44.60089874267578),
  gravityScale: x87F32Mul(GUNSHOT_EFFECT.explosionSize, Math.fround(0.0002197265566792339)),
  /** Spin decays x 0.99 per tick (f32 0x531470). */
  spinDecay: Math.fround(0.9900000095367432),
  /** Model scale 204.8 x (1/2048) = 0.1 (FUN_0047d440, +0x98..+0xa0). */
  scale: x87F32Mul(Math.fround(204.8000030517578), Math.fround(0.00048828125)),
  /** Initial tilt: three floats x pi/100 (f32 0x532180). */
  tiltScale: Math.fround(0.03141592815518379),
} as const;

/** Spin decay of one axis (fld; fmul 0x531470; fstp DWORD). */
export function x87Spin(w: number): number {
  return x87F32Mul(w, FRAGMENTS.spinDecay);
}

/** Gravity per tick: size 0.45 x 44.6 x drag 0.98 (local_28 in FUN_004fa1d0). */
export const FRAGMENT_GRAVITY = x87F32Mul(x87F32Mul(FRAGMENTS.gravityScale, FRAGMENTS.gravity), FRAGMENTS.drag);

export interface FragmentLaunch {
  velocity: Vec3;
  rotation: Mat3;
}

/**
 * One fragment of the burst (FUN_0047d570 loop, then FUN_0047d440), seven
 * level-RNG floats: speed = 340 + r (680 - 340); the frame of the direction
 * (FUN_004aa2f0) transposed, x Rz(r pi), x Rx(r cone); velocity = third
 * column x speed (so the spread covers a HALF cone: the frame's b component
 * is never negative); one unused draw; tilt Rz(r1 k) Ry(r2 k) Rx(r3 k).
 */
export function fragmentLaunch(direction: Vec3, rng: EffectRng): FragmentLaunch {
  const speed = x87StoreF32((GUNSHOT_EFFECT.debrisSpeedMax - GUNSHOT_EFFECT.debrisSpeedMin) * rng.float() + GUNSHOT_EFFECT.debrisSpeedMin);
  const f = frameOf(normalise(direction));
  const t: Mat3 = [f[0], f[3], f[6], f[1], f[4], f[7], f[2], f[5], f[8]];
  const a = mulMat3(t, rotZ(x87StoreF32(rng.float() * Math.fround(3.1415927410125732))));
  const b = mulMat3(a, rotX(x87StoreF32(rng.float() * GUNSHOT_EFFECT.debrisConeRad)));
  rng.float();
  const velocity: Vec3 = [x87StoreF32(b[2] * speed), x87StoreF32(b[5] * speed), x87StoreF32(b[8] * speed)];
  const z = x87StoreF32(rng.float() * FRAGMENTS.tiltScale);
  const y = x87StoreF32(rng.float() * FRAGMENTS.tiltScale);
  const x = x87StoreF32(rng.float() * FRAGMENTS.tiltScale);
  return { velocity, rotation: rotZYX(x, y, z) };
}

/** One SimpointObjContainer tick for one fragment: v = 0.98 v, v.z -= gravity, p += v, R = spinRotation R. */
export function fragmentStep(position: Vec3, velocity: Vec3, rotation: Mat3, spinRotation: Mat3): { position: Vec3; velocity: Vec3; rotation: Mat3 } {
  const vx = x87F32Mul(FRAGMENTS.drag, velocity[0]);
  const vy = x87F32Mul(FRAGMENTS.drag, velocity[1]);
  const vz = x87F32Sub(x87F32Mul(FRAGMENTS.drag, velocity[2]), FRAGMENT_GRAVITY);
  return {
    position: [position[0] + vx, position[1] + vy, position[2] + vz],
    velocity: [vx, vy, vz],
    rotation: mulMat3(spinRotation, rotation),
  };
}

// ---------------------------------------------------------------------------
// Tracers (GunShot FUN_00479e30 tail, FUN_0047aba0 slots, draw FUN_004792b0
// -> FUN_004d7ac0 line / FUN_0047acf0 triangle, removal FUN_0047ac40)
// ---------------------------------------------------------------------------

export interface AmmoTracer {
  /** DefineAmmoType arg 12 (+0x20). */
  tracer: boolean;
  /** Args 6-8 (+0x08..+0x10): colour at the muzzle end; args 9-11 (+0x14..+0x1c): colour at full range (0-255). */
  near: Vec3;
  far: Vec3;
}

export const TRACER = {
  /** GunShot +0x98 starts at 10 (FUN_00479c40). */
  counterReset: 10,
  /** Five slots per GunShot (FUN_0047aba0); a slot lives 30 ticks unless drawn (draw sets 0, the next tick removes it). */
  slots: 5,
  lifeTicks: 30,
  /** 1/255 (f32 0x532148). */
  colourScale: Math.fround(0.003921568859368563),
  /** Depth fade: alpha x (1 - z / 2048000 x 0.1) with z clamped to [0, 2048000] (0x532140, 0x5313c8, 0x532144), floor 0.2 (0x5313c4). */
  fadeDepth: Math.fround(2048000),
  fadeScale: Math.fround(4.882812731921149e-7),
  fadeFactor: Math.fround(0.10000000149011612),
  minAlpha: Math.fround(0.20000000298023224),
  /** Lines are clipped at view depth 409.6 units (f32 0x5318d0). */
  nearClip: Math.fround(409.6000061035156),
  /** Camera-plane crossing: one triangle, third vertex 286.72 units across the segment in xy (f32 0x532160); at most 10. */
  crossingWidth: Math.fround(286.7200012207031),
  crossingMax: 10,
} as const;

/** Per-gun tracer decision for one cast (0x47a7c0): returns whether this cast draws a tracer. */
export class TracerCounter {
  value: number = TRACER.counterReset;
  /** `hasTracerAmmo` = the gun exists and its ammo type has the tracer flag. */
  cast(hasTracerAmmo: boolean, segment: BulletSegmentReport, lengthUnits: number): boolean {
    if (!hasTracerAmmo) return false;
    if (this.value < 1 || segment.ricocheted || segment.passed) {
      if (lengthUnits > 0) {
        this.value = TRACER.counterReset;
        return true;
      }
      return false;
    }
    this.value--;
    return false;
  }
}

/** Colour (0..1 per channel, clamped) of a tracer end at distance fraction t (FUN_004792b0). */
export function tracerColour(ammo: AmmoTracer, t: number): Vec3 {
  const k = TRACER.colourScale;
  const c = (i: number) => {
    const diff = x87F32Mul(x87StoreF32(ammo.far[i] - ammo.near[i]), k);
    const v = x87StoreF32(t * diff + ammo.near[i] * k);
    return v < 0 ? 0 : v > 1 ? 1 : v;
  };
  return [c(0), c(1), c(2)];
}

/** Alpha of a tracer end: t clamped to [0, 1], faded by view depth (units), floored at 0.2. */
export function tracerAlpha(t: number, depthUnits: number): number {
  let a = t < 0 ? 0 : t > 1 ? 1 : t;
  const z = depthUnits < 0 ? 0 : depthUnits > TRACER.fadeDepth ? TRACER.fadeDepth : depthUnits;
  a = x87StoreF32((1 - z * TRACER.fadeScale * TRACER.fadeFactor) * a);
  return a <= TRACER.minAlpha ? TRACER.minAlpha : a;
}

/** D3D colour byte of a TL vertex channel: trunc(v x 255) (FUN_00504300, chop). */
export function colourByte(v: number): number {
  return x87Fistp(v * 255);
}

// ---------------------------------------------------------------------------
// Particles (Particle2DDynCubeObjTask FUN_004f3b70; create FUN_004f4b20, emit
// FUN_004f4d40, cone emit FUN_004f4e30, tick FUN_004f4280, draw FUN_004f3c40)
// ---------------------------------------------------------------------------

/** Seed of the particle generator DAT_0080aba8 (FUN_004aaac0(&DAT_0080aba8, 0x12332153) at registration). */
export const PARTICLE_RNG_SEED = 0x12332153;

export const PARTICLES = {
  /** Not drawn nearer than 2048 units (f32 0x531500) or beyond the system's far distance. */
  nearUnits: 2048,
  /** Projected half-size floor 0.5 pixel (0x4f3e30). */
  minHalfPixels: 0.5,
  /** Collision rays every 15 ticks, staggered by a global counter mod 16 (DAT_0080abc4). */
  collisionInterval: 15,
} as const;

/**
 * FUN_004f4e30 direction: d = |dir|; u = |w x d| with w = (0, 1, 0) if
 * |d.x| > 0.75 else (1, 0, 0); v = u x d; three particle-RNG floats r1, r2,
 * r3: tilt x = cone/2 - r1 cone, azimuth z = pi - 2 pi r2, m = Rz(z) Rx(x);
 * direction = v m[2] + u m[5] + d m[8]; speed = vmin + r3 (vmax - vmin).
 */
export function coneVelocity(dir: Vec3, cone: number, vmin: number, vmax: number, rng: EffectRng): Vec3 {
  const d = normalise(dir);
  const w: Vec3 = Math.abs(d[0]) > 0.75 ? [0, 1, 0] : [1, 0, 0];
  const u = normalise([w[1] * d[2], -(w[0] * d[2]), w[0] * d[1] - w[1] * d[0]]);
  const v: Vec3 = [u[1] * d[2] - u[2] * d[1], -(u[0] * d[2] - u[2] * d[0]), u[0] * d[1] - u[1] * d[0]];
  const tilt = x87StoreF32(rng.float() * cone);
  const az = x87StoreF32(Math.fround(3.1415927410125732) - rng.float() * Math.fround(6.2831854820251465));
  const m = rotZYX(x87F32Sub(x87F32Mul(cone, 0.5), tilt), 0, az);
  const out = normalise([
    m[8] * d[0] + m[5] * u[0] + m[2] * v[0],
    m[8] * d[1] + m[5] * u[1] + m[2] * v[1],
    m[8] * d[2] + m[5] * u[2] + m[2] * v[2],
  ]);
  const speed = (vmax - vmin) * rng.float() + vmin;
  return [x87StoreF32(out[0] * speed), x87StoreF32(out[1] * speed), x87StoreF32(out[2] * speed)];
}

// ---------------------------------------------------------------------------
// Blood (Human hit FUN_0045e5b0 -> FUN_00462710; droplet hits FUN_00462cf0)
// ---------------------------------------------------------------------------

export const BLOOD = {
  /** Wall behind: ray 12288 units (3 m, double 0x531848) along the bullet from the hit; size (r + 1) x 614.4 (f32 0x5319b4); hole_blood1 / hole_blood2 by rand(2). */
  wallRayUnits: 12288,
  wallSize: Math.fround(614.4000244140625),
  wallTextures: ["hole_blood1.tex", "hole_blood2.tex"] as const,
  /** Puff: blood1.spr, half-size 1228.8 units (0x4499999a), frame step trunc(15 / frames) ticks, 2 particles, life 15, alpha -1 per tick. */
  puffHalfSize: Math.fround(1228.800048828125),
  puffLife: 15,
  puffMaxParticles: 2,
  puffFlags: 0x1080000,
  /** Droplets: blood2.spr, half-size 102.4 (0x42cccccd), gravity -14.867 units/tick^2 (0xc16ddf15), 10 particles, flags 0x80000. */
  dropHalfSize: Math.fround(102.4000015258789),
  dropGravity: Math.fround(-14.866963386535645),
  dropMaxParticles: 10,
  dropFlags: 0x80000,
  /** Forward: rand(3) + 3 along the bullet, cone 10 deg (0x3e32b8c3), 378..606 units/tick; backward: rand(3) + 2, cone 70 deg (0x3f9c61aa), 37..113. */
  forward: { base: 3, cone: Math.fround(0.17453299462795258), vmin: 378, vmax: 606 },
  backward: { base: 2, cone: Math.fround(1.2217304706573486), vmin: 37, vmax: 113 },
  dropLife: 30,
  dropFadeTicks: 7,
  /** Droplet hit: hole_blood3 / hole_blood4 by rand(2), size 102.4 + r 204.8 (0x531898, 0x531518). */
  dropTextures: ["hole_blood3.tex", "hole_blood4.tex"] as const,
  dropDecalBase: Math.fround(102.4000015258789),
  dropDecalRange: Math.fround(204.8000030517578),
} as const;

// ---------------------------------------------------------------------------
// Casings (gun fire handler FUN_004772c0 0x477b80-0x477ced -> FUN_00476430;
// GunCasing tick FUN_004769f0)
// ---------------------------------------------------------------------------

export const CASING = {
  /** Gun model attachment (ATTA) index of the ejection point (FUN_00486e20(.., gun, 3)). */
  attachment: 3,
  /** 19 ticks (0x13), no collision. */
  lifeTicks: 19,
  /** v = (v - (0, 0, 44.6)) x 0.985 per tick (f32 0x53146c, 0x53212c). */
  drag: Math.fround(0.9850000143051147),
  gravity: Math.fround(44.600887298583984),
} as const;

export interface CasingLaunch {
  /** Gun-local velocity (IGI units/tick): (s cos a, 0, s sin a). */
  localVelocity: Vec3;
  /** Per-tick spin Rz(c) Ry(b) Rx(a) with a = rand(2), b = rand(5), c = rand(5) degrees. */
  spin: Mat3;
}

/**
 * Casing launch, level-RNG draws in order: a = rand(30) degrees, s =
 * ((rand(4) + 4) x 4096000) / 108000 (integer division: 151, 189, 227, 265
 * units/tick); local velocity Ry(-a) (s, 0, 0) = (s cos a, 0, s sin a); then
 * FUN_00476430 draws rand(2), rand(5), rand(5) for the spin (degrees,
 * f32 0x531684).
 */
export function casingLaunch(rng: EffectRng): CasingLaunch {
  const deg = Math.fround(0.01745329238474369);
  const a = x87StoreF32(rng.int(30) * deg);
  const s = Math.trunc(((rng.int(4) + 4) * 0x3e8000) / 0x1a5e0);
  const r = rotY(-a);
  const localVelocity: Vec3 = [x87StoreF32(r[0] * s), x87StoreF32(r[3] * s), x87StoreF32(r[6] * s)];
  const x = x87StoreF32(rng.int(2) * deg);
  const y = x87StoreF32(rng.int(5) * deg);
  const z = x87StoreF32(rng.int(5) * deg);
  return { localVelocity, spin: rotZYX(x, y, z) };
}

/** One GunCasing tick (FUN_004769f0): v = 0.985 v (z: (v.z - 44.6) x 0.985), p += v, R = R x spin. */
export function casingStep(position: Vec3, velocity: Vec3, rotation: Mat3, spin: Mat3): { position: Vec3; velocity: Vec3; rotation: Mat3 } {
  const vx = x87F32Mul(velocity[0], CASING.drag);
  const vy = x87F32Mul(velocity[1], CASING.drag);
  const vz = x87F32Mul(x87F32Sub(velocity[2], CASING.gravity), CASING.drag);
  return { position: [position[0] + vx, position[1] + vy, position[2] + vz], velocity: [vx, vy, vz], rotation: mulMat3(rotation, spin) };
}

// ---------------------------------------------------------------------------
// Particle state step (FUN_004f4280), shared by particles.ts and tests
// ---------------------------------------------------------------------------

export interface ParticleState {
  /** Position, IGI units relative to the level origin (doubles). */
  position: Vec3;
  /** Velocity, units/tick (floats). */
  velocity: Vec3;
  /** Collision countdown (+0x24). */
  collide: number;
  /** Life countdown (+0x26); while > 0 the alpha holds. */
  life: number;
  /** Animation frame (+0x28) and its tick counter (+0x2a). */
  frame: number;
  frameTicks: number;
  /** Spin rate (+0x2c), alpha (+0x30), fade per tick (+0x34), angle (+0x38), scale (+0x3c). */
  spin: number;
  alpha: number;
  fade: number;
  angle: number;
  scale: number;
  /** Position at the last collision check (+0x40). */
  previous: Vec3;
}

export interface ParticleSystemRules {
  /** Acceleration per tick (IGI units, +0xc4). */
  accel: Vec3;
  /** Scale growth per tick (+0xe4). */
  growth: number;
  /** Ticks per animation frame (+0xf4) and last frame index (frames - 1); 0 = not animated. */
  frameDelay: number;
  lastFrame: number;
}

/** Advance one particle one tick; returns false when it dies (FUN_004f4280 0x4f4324-0x4f43b2). */
export function stepParticle(p: ParticleState, s: ParticleSystemRules): boolean {
  p.velocity = [x87F32Add(p.velocity[0], s.accel[0]), x87F32Add(s.accel[1], p.velocity[1]), x87F32Add(s.accel[2], p.velocity[2])];
  p.position = [x87Add(p.velocity[0], p.position[0]), x87Add(p.velocity[1], p.position[1]), x87Add(p.velocity[2], p.position[2])];
  p.angle = x87F32Add(p.spin, p.angle);
  p.scale = x87F32Add(s.growth, p.scale);
  if (s.lastFrame !== 0) {
    p.frameTicks++;
    if (s.frameDelay <= p.frameTicks) {
      p.frameTicks = 0;
      if (p.frame < s.lastFrame) p.frame++;
    }
  }
  if (p.life === 0) {
    p.alpha = x87F32Sub(p.alpha, p.fade);
    return p.alpha > 0 && p.scale > 0;
  }
  p.life--;
  return true;
}
