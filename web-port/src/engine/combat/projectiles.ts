/**
 * Projectiles fired by guns besides bullets and hand grenades: the M16A2's M203
 * grenade (class "M203") and the RPG18 rocket (class "Missile"). IGI units
 * (4096 = 1 m, z up), velocities in units per tick, 30 ticks/s. Both are
 * children of the Dynamic task: created during the tick, first updated at the
 * end of the same tick (after the humans), like the thrown grenades.
 *
 * M203 [recovered, full exe: FUN_00476110, create 0x4761b0, update 0x476340,
 * spawn FUN_00476670, launch FUN_00473510]:
 *   - Launch: velocity = view col 1 x f32(km/h x 4096000.0f) x 9.259259e-6
 *     (f32 0x5334a4 / 0x5334a0; 270 km/h -> 10240 units/tick = 75 m/s) from
 *     the eye; "m203_launch_1" at the gun (+0x150 = the eye); the grenade's
 *     matrix is the basis of the direction (FUN_00414a60, fixed in flight).
 *     Weaponconfig tags (FUN_004737f0, defaults 270 km/h, 5 m, 1, 108_05_1):
 *     "M203 - Muzzle velocity (km/h)", "- Explosion radius (meters)",
 *     "- Activate radius (meters)", "- Model".
 *   - Update: vx, vy x 0.995 (f32 0x533790); vz = (vz - 35.68071) x 0.995
 *     (f32 0x534140); position += v; a ray old -> new (FUN_004cc2a0, filter
 *     0x539547 = LAB_00416a90 with {self, gun, owner, 1.0}: its gun and the
 *     shooter are skipped); a hit -> the explosion at the hit point and the
 *     grenade is deleted; else one smoke particle (smoke1.spr) with three
 *     level-RNG draws: speed (0.75 r + 0.15) x 37.93, size (r + 1) x 0.35,
 *     angle 2 (r - 0.5) x 0.05236 + 0.0128. No lifetime, no arming distance.
 *   - Explosion FUN_00480fe0(hit, 1, 1, damage = the "Activate radius" tag
 *     (1.0), radius = explosion radius x 4096 (5 m), falloff 0, scorch 4096,
 *     3 fragments, 1 fireball, the hit object, "1009_01_1", "explo_proxy",
 *     AI 21, flags 2, range 102400, source 0): falloff 0 makes the damage
 *     binary (1.0 inside 5 m + the target's radius); source 0, so cars ignore it.
 * Missile (class "Missile": the RPG18 rocket, the APC / T80 turret rounds and
 * the Mil rocket pods' HIND rockets) [recovered, full exe; rules in
 * combat/missile.ts]: spawn FUN_00429a30 (the aim matrix, muzzle velocity x
 * 136.533, the type's fuel, guidance and drag), update 0x428390 (guidance,
 * smoke draws from the missile generator DAT_0057bc88, physics FUN_00428d00 =
 * throttle / controls / tumble / thrust / fuel / drag + the physics-object
 * step FUN_004fc0e0 with the contact point at the model's magic vertex 0;
 * no contact: every 32 global frames a 1000 m ray down, nothing -> deleted;
 * contact: a 3 m scorch ray down and FUN_00480fe0(position, 1, 1, 5.0,
 * 10240, 7168, 6144, 10, 5, hit, "1009_01_1", "explo_03_l", 21, 2, 102400,
 * source weaponconfig: weapon id 12 destroys cars, docs/damage.md), deleted).
 *   - Contact rays (ray filter 0x539547, the missile's {self, gun, owner, 1.0}):
 *     HSMC set 0 + terrain (TRI_BULLET) and the humans but the owner; a
 *     human hit's normal faces the ray [inferred]. A turret's round skips its
 *     vehicle's whole body [approximation: the exe skips only the gun and the
 *     turret objects]. The player's hit filter draw (FUN_0045d100 with p 1.0)
 *     is not taken [not modelled].
 *   - Sound: the type's group ("radarwind_1") at the missile from the spawn
 *     (FUN_00429d80, position each tick FUN_00428610) until it is deleted.
 */
import type { Vec3 } from "../../contracts";
import { x87StoreF32 } from "../../loaders/x87";
import type { MissileConfig, PhysicsObjType } from "../../loaders/vehicles";
import type { Mat3 } from "../../loaders/mission";
import type { GameContext } from "../context";
import { LevelRng } from "../ai/rng";
import { TRI_BULLET } from "../world/collision";
import { damageSystemOf } from "./object-damage";
import type { CombatModelEntry } from "../render/combat-models";
import type { GrenadeWorld } from "./grenade";
import { MISSILE_RULES, createMissile, missileSmokeSystem, missileTypeFor, updateMissile, type Missile, type MissileSmokeParticle, type MissileType } from "./missile";

type V3 = [number, number, number];
type M3 = [number, number, number, number, number, number, number, number, number];
const f32 = x87StoreF32;
const UNITS = 4096;

export const M203 = {
  /** Weaponconfig tag defaults (FUN_004737f0). */
  defaults: { muzzleKmh: 270, explosionRadiusM: 5, activateRadius: 1, model: "108_05_1" },
  /** f32 0x5334a4 / 0x5334a0. */
  kmhUnits: 4096000,
  perTick: Math.fround(9.259259059035685e-6),
  /** f32 0x533790 (air drag per tick) and 0x534140 (gravity per tick, 7.84 m/s^2). */
  drag: Math.fround(0.9950000047683716),
  gravity: Math.fround(35.68070983886719),
  /** Explosion: scorch 0x45800000, fragments, fireballs, the AI event range 0x47c80000. */
  scorch: 4096,
  fragments: 3,
  fireballs: 1,
  aiRange: 102400,
  sound: "explo_proxy",
  launchSound: "m203_launch_1",
} as const;

/**
 * The shipped RPG18 Missile type (physicsobj/missiles/RPG18, 110_02_1) [observed], used only
 * when a level carries no DefinePhysicsObjType for a missile model (unit tests, demo data).
 */
export const RPG18_MISSILE_TYPE: MissileType = {
  model: "110_02_1",
  mass: 10,
  size: [Math.fround(0.4), 5, Math.fround(0.4)],
  points: [{ local: [0, 2420, 0], restitution: Math.fround(0.2), grip: 1 }],
  restSpeed: Math.fround(0.7),
  restAngular: Math.fround(0.001),
  config: {
    c: [200, 5, Math.fround(0.8), 5, Math.fround(0.8), 5, Math.fround(0.8), 200, Math.fround(0.027), Math.fround(0.003)],
    drag: [
      { coef: 1, normal: [0, 0, 1], point: [0, 16384, 0] },
      { coef: 1, normal: [1, 0, 0], point: [0, 16384, 0] },
      { coef: 0, normal: [0, 0, 0], point: [0, 0, 0] },
      { coef: 0, normal: [0, 0, 0], point: [0, 0, 0] },
    ],
    viewCone: [0, 0, 0],
    extra: [],
    smoke: 1, guidance: 0, fuel: 4, burn: Math.fround(0.03333333507180214), arg4: 50, smokeSpacing: 1024, smokeGrowth: 2048,
    smokeInterval: 1, smokeSize: 1, sprite: "smoke2.spr", sound: "radarwind_1",
  } as MissileConfig,
  magic: [[0, 2420, 0], [0, -2444, 0]],
};

export interface M203Tags {
  muzzleKmh: number;
  explosionRadiusM: number;
  activateRadius: number;
  model: string;
}

/** FUN_00473510: the launch velocity for a unit direction (IGI). */
export function m203LaunchVelocity(dir: readonly number[], muzzleKmh: number): V3 {
  const k = f32(Math.fround(muzzleKmh) * M203.kmhUnits);
  return [f32(f32(k * dir[0]) * M203.perTick), f32(f32(k * dir[1]) * M203.perTick), f32(f32(k * dir[2]) * M203.perTick)];
}

/** 0x476340's motion step: drag on x / y, gravity then drag on z (float32), then the position. */
export function m203Step(position: V3, velocity: V3): void {
  velocity[0] = f32(velocity[0] * M203.drag);
  velocity[1] = f32(velocity[1] * M203.drag);
  velocity[2] = f32((velocity[2] - M203.gravity) * M203.drag);
  position[0] = f32(velocity[0] + f32(position[0]));
  position[1] = f32(velocity[1] + f32(position[1]));
  position[2] = f32(velocity[2] + f32(position[2]));
}

/** FUN_00414a60: an orthonormal basis whose column 1 is `dir` (columns x, y = dir, z). */
export function directionBasis(dir: readonly number[]): M3 {
  const n = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const y = [dir[0] / n, dir[1] / n, dir[2] / n];
  let x: number[];
  if (Math.abs(y[2]) <= 0.95) x = [y[1], -y[0], 0];
  else x = [0, y[2], -y[1]];
  const xl = Math.hypot(x[0], x[1], x[2]) || 1;
  x = [x[0] / xl, x[1] / xl, x[2] / xl];
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

interface Flying {
  kind: "m203" | "missile";
  id: number;
  model: string;
  position: V3;
  velocity: V3;
  matrix: M3;
  /** "player" or the soldier's Enemy.id (the ray filter skips it), or a turret's shooter id. */
  owner: "player" | number;
  radius: number;
  damage: number;
  fuel: number;
  frames: number;
  /** The weaponconfig "Weapon ID" passed as the explosion source (missiles; 0 / null for the M203). */
  sourceWeaponId: number | null;
  updates: number;
  /** turrets: the Missile object (combat/missile.ts); null for the M203. */
  missile: Missile | null;
  /** A turret round: the vehicle body (dynamic task key) its rays skip. */
  skipBody: number | null;
  /** Target object (+0x860) answered by the spawner, or null. */
  target: (() => V3 | null) | null;
  /** The type's sound group at the missile (FUN_00429d80). */
  sound: { update(position: Vec3): void; dispose(): void; readonly alive?: boolean } | null;
  /** FUN_00429dc0's smoke system (fx/particles.ts; it outlives the missile until empty). */
  smoke: { emit(position: Vec3, velocity: Vec3, alpha: number, spin: number, angle: number, scale: number, life: number, fadeTicks: number): unknown } | null;
}

/** FUN_00429a30's arguments the engine passes (the rest come from the missile type). */
export interface MissileSpawn {
  /** Muzzle, IGI units. */
  position: V3;
  /** Launch direction (col 1 of the aim matrix); the basis FUN_00414a60 when no `matrix`. */
  direction?: V3;
  /** The aim matrix (row-major, col 1 = forward), e.g. a rocket pod's (FUN_00427a70). */
  matrix?: M3;
  /** Muzzle velocity, m/s (weaponconfig +0x660 or the pod's speed + 5). */
  muzzleVelocity: number;
  model: string;
  owner: "player" | number;
  sourceWeaponId: number | null;
  /** Target point (HIND: the offset origin; ballistic types: the aim point). */
  target?: V3 | null;
  /** Target object (+0x860): its position every update. */
  targetObject?: (() => V3 | null) | null;
  /** turrets: the firing vehicle's body key (rays skip it). */
  skipBody?: number | null;
}

export interface ProjectileSystem {
  readonly flying: ReadonlyArray<Readonly<Flying>>;
  /** FUN_00476670. */
  spawnM203(p: { position: V3; velocity: V3; matrix: M3; model: string; explosionRadiusM: number; activateRadius: number; owner: "player" | number }): void;
  /** FUN_00429a30. */
  spawnMissile(p: MissileSpawn): void;
  /** One tick of every projectile (Dynamic children, after the humans). */
  update(): void;
  clear(): void;
  models(): CombatModelEntry[];
  /** Diagnostics: explosions caused, and the last missile explosion (position, source). */
  readonly explosions: number;
  readonly lastMissileExplosion: { position: V3; sourceWeaponId: number | null; updates: number } | null;
  /** Weaponconfig TASKTYPE_MISSILE weapons -> "Missile - Model" (weapon-tags.ts), for the soldiers' guns. */
  setMissileModels(models: ReadonlyMap<string, string>): void;
  missileModelOf(weaponId: string): string | null;
  /** The missile generator DAT_0057bc88 (process-wide: never re-seeded, not cleared by a restart). */
  readonly missileRng: LevelRng;
  /** The Missile type of a model (DefinePhysicsObjType + its magic vertices); RPG18_MISSILE_TYPE without physics data. */
  missileTypeOf(model: string): MissileType | null;
}

const registry = new WeakMap<object, ProjectileSystem>();

export function projectileSystemOf(ctx: GameContext): ProjectileSystem {
  let s = registry.get(ctx);
  if (!s) {
    s = createProjectileSystem(ctx);
    registry.set(ctx, s);
  }
  return s;
}

let nextId = 1;

export function createProjectileSystem(ctx: GameContext): ProjectileSystem {
  let list: Flying[] = [];
  let explosions = 0;
  let lastMissileExplosion: ProjectileSystem["lastMissileExplosion"] = null;
  let missileModels: ReadonlyMap<string, string> = new Map();
  // FUN_004b4720(&DAT_0057bc88) at the class registration (FUN_00427ff0): the init state, no seed.
  const missileRng = new LevelRng(0);
  const typeCache = new Map<string, MissileType | null>();
  let typesFor: unknown = null;
  const origin = () => ctx.level?.originIgi ?? [0, 0, 0];
  const toEngine = (p: readonly number[]): Vec3 => {
    const o = origin();
    return [(p[0] - o[0]) / UNITS, (p[2] - o[2]) / UNITS, -(p[1] - o[1]) / UNITS];
  };
  const toIgi = (e: readonly number[]): V3 => {
    const o = origin();
    return [e[0] * UNITS + o[0], -e[2] * UNITS + o[1], e[1] * UNITS + o[2]];
  };

  function missileTypeOf(model: string): MissileType | null {
    const level = ctx.level;
    if (typesFor !== level) {
      typeCache.clear();
      typesFor = level;
    }
    const key = model.toLowerCase();
    if (typeCache.has(key)) return typeCache.get(key)!;
    const types: readonly PhysicsObjType[] = level?.vehicles?.types ?? [];
    const magic = level?.vehicles?.models.get(model)?.magicVertices ?? damageSystemOf(ctx)?.data?.bounds.get(key)?.magic ?? null;
    let t = missileTypeFor(types, model, magic);
    if (!t && !types.some((x) => x.taskType === "TASKTYPE_MISSILE")) t = { ...RPG18_MISSILE_TYPE, model };
    typeCache.set(key, t);
    return t;
  }

  /** The segment old -> new against the world (HSMC set 0 / terrain) and the humans but the owner. */
  function trace(p: Flying, from: V3, to: V3): { point: V3; object: number | null } | null {
    const a = toEngine(from);
    const b = toEngine(to);
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    if (!(len > 0)) return null;
    const dir: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
    let best: { distance: number; object: number | null } | null = null;
    const hit = ctx.world?.raycast(a[0], a[1], a[2], dir[0], dir[1], dir[2], len, TRI_BULLET) ?? null;
    if (hit) best = { distance: hit.distance, object: hit.terrain ? null : hit.owner };
    for (const h of ctx.systems.enemies?.hitTest(a, dir, len, { nearMiss: false }) ?? []) {
      if (h.enemy.id === p.owner) continue;
      if (!best || h.distance < best.distance) best = { distance: h.distance, object: null };
      break;
    }
    if (p.owner !== "player" && ctx.player.alive) {
      const body = ctx.systems.player?.bodyHit(a, dir, len);
      if (body && (!best || body.distance < best.distance)) best = { distance: body.distance, object: null };
    }
    if (!best) return null;
    return { point: toIgi([a[0] + dir[0] * best.distance, a[1] + dir[1] * best.distance, a[2] + dir[2] * best.distance]), object: best.object };
  }

  /** The missile's ray queries (FUN_004fb9a0 / FUN_004fc620) with its filter. */
  function missileWorld(p: Flying): GrenadeWorld {
    const skip = p.skipBody ?? undefined;
    return {
      segment(from, to) {
        const a = toEngine(from);
        const e = toEngine(to);
        const d = [e[0] - a[0], e[1] - a[1], e[2] - a[2]];
        const len = Math.hypot(d[0], d[1], d[2]);
        if (!(len > 0)) return null;
        const dir: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
        let best: { distance: number; normal: V3; front: boolean } | null = null;
        const hit = ctx.world?.raycast(a[0], a[1], a[2], dir[0], dir[1], dir[2], len, TRI_BULLET, undefined, skip) ?? null;
        if (hit) {
          // RayHit.normal faces the ray origin; the exe's record holds the outward normal.
          const s = hit.front ? 1 : -1;
          const n: V3 = [hit.normal[0] * s, -hit.normal[2] * s, hit.normal[1] * s];
          const ln = Math.hypot(n[0], n[1], n[2]) || 1;
          best = { distance: hit.distance, normal: [f32(n[0] / ln), f32(n[1] / ln), f32(n[2] / ln)], front: hit.front };
        }
        // Humans answer the ray filter 0x539547 (the owner passes) [inferred: normal against the ray].
        const facing: V3 = [-dir[0], dir[2], -dir[1]];
        for (const h of ctx.systems.enemies?.hitTest(a, dir, len, { nearMiss: false }) ?? []) {
          if (h.enemy.id === p.owner) continue;
          if (!best || h.distance < best.distance) best = { distance: h.distance, normal: facing, front: true };
          break;
        }
        if (p.owner !== "player" && ctx.player.alive) {
          const body = ctx.systems.player?.bodyHit(a, dir, len);
          if (body && (!best || body.distance < best.distance)) best = { distance: body.distance, normal: facing, front: true };
        }
        return best ? { distance: best.distance * UNITS, normal: best.normal, front: best.front } : null;
      },
      inside(q, length) {
        const w = ctx.world;
        if (!w) return false;
        const a = toEngine(q);
        const hit = w.raycast(a[0], a[1], a[2], 0, 1, 0, length / UNITS, TRI_BULLET, undefined, skip);
        return hit !== null && !hit.front;
      },
    };
  }

  /** A ray straight down from `at` (IGI) of `range` units: the hit point, or null. */
  function rayDown(at: readonly number[], range: number, skip: number | null): V3 | null {
    const e = toEngine(at);
    const hit = ctx.world?.raycast(e[0], e[1], e[2], 0, -1, 0, range / UNITS, TRI_BULLET, undefined, skip ?? undefined) ?? null;
    return hit ? toIgi(hit.point) : null;
  }

  function explode(p: Flying, at: V3): void {
    explosions++;
    const sys = damageSystemOf(ctx);
    if (p.kind === "missile") lastMissileExplosion = { position: [...at], sourceWeaponId: p.sourceWeaponId, updates: p.updates };
    if (!sys) return;
    if (p.kind === "m203") {
      sys.explode(sys.makeExplosion({
        position: at, count: 1, interval: 1, damage: p.damage, radius: f32(p.radius), falloff: 0, scorch: M203.scorch,
        fragments: M203.fragments, fireballs: M203.fireballs, sound: M203.sound, aiRange: M203.aiRange, sourceWeaponId: null,
      }));
      return;
    }
    const x = MISSILE_RULES.explosion;
    sys.explode(sys.makeExplosion({
      position: at, count: 1, interval: 1, damage: x.damage, radius: x.radius, falloff: x.falloff, scorch: x.scorch,
      fragments: x.fragments, fireballs: x.fireballs, fragmentModel: x.fragmentModel, sound: x.sound, aiRange: x.aiRange, sourceWeaponId: p.sourceWeaponId,
    }));
  }

  /** The M203 smoke particle's three level-RNG draws (FUN_004fe120 arguments; the particle itself is not drawn). */
  function smoke(): void {
    ctx.rng.float();
    ctx.rng.float();
    ctx.rng.float();
  }

  function stepM203(p: Flying): boolean {
    const old: V3 = [...p.position];
    m203Step(p.position, p.velocity);
    const hit = trace(p, old, p.position);
    if (hit) {
      explode(p, hit.point);
      return false;
    }
    smoke();
    return true;
  }

  /** FUN_00428630's particles into the missile's smoke system (positions relative to the level origin). */
  function emitSmoke(p: Flying, s: MissileSmokeParticle): void {
    if (!p.smoke) return;
    const o = origin();
    p.smoke.emit([s.position[0] - o[0], s.position[1] - o[1], s.position[2] - o[2]], s.velocity, s.alpha, s.spin, s.angle, s.scale, s.life, s.fadeTicks);
  }

  function syncMissile(p: Flying): void {
    const m = p.missile!;
    p.position = [...m.position];
    p.matrix = [...m.matrix] as M3;
    p.velocity = [...m.body.velocity];
    p.fuel = m.fuel;
    p.sound?.update(toEngine(m.position));
  }

  /** 0x428390. */
  function stepMissile(p: Flying): boolean {
    const m = p.missile!;
    const outcome = updateMissile(m, {
      world: missileWorld(p),
      rng: missileRng,
      frame: ctx.appTick ?? ctx.tick,
      probeDown: (at) => rayDown(at, MISSILE_RULES.probeRange, p.skipBody) !== null,
      targetPosition: p.target ?? undefined,
      smoke: (s) => emitSmoke(p, s),
    });
    syncMissile(p);
    p.frames++;
    if (outcome === "fly") return true;
    if (outcome === "explode") {
      // The 3 m scorch ray (its hit is the explosion's surface record) and FUN_00480fe0 at the missile.
      rayDown(m.position, MISSILE_RULES.scorchRay, p.skipBody);
      explode(p, [...m.position]);
    }
    p.sound?.dispose();
    p.sound = null;
    return false;
  }

  return {
    get flying() {
      return list;
    },
    get explosions() {
      return explosions;
    },
    get lastMissileExplosion() {
      return lastMissileExplosion;
    },
    missileRng,
    missileTypeOf,
    spawnM203(s) {
      list.push({
        kind: "m203", id: nextId++, model: s.model, position: [...s.position], velocity: [...s.velocity], matrix: s.matrix, owner: s.owner,
        radius: f32(Math.fround(s.explosionRadiusM) * 4096), damage: Math.fround(s.activateRadius), fuel: 0, frames: 0, sourceWeaponId: null, updates: 0,
        missile: null, skipBody: null, target: null, sound: null, smoke: null,
      });
    },
    spawnMissile(s) {
      const type = missileTypeOf(s.model);
      if (!type) return;
      const matrix = (s.matrix ? [...s.matrix] : directionBasis(s.direction ?? [0, 1, 0])) as Mat3;
      const m = createMissile(type, { position: s.position, matrix, muzzleVelocity: s.muzzleVelocity, target: s.target ?? null });
      const audio = ctx.systems.audio as { objectSound?(name: string, position: Vec3): { update(p: Vec3): void; dispose(): void } | null } | null;
      const sound = type.config.sound ? audio?.objectSound?.(type.config.sound, toEngine(s.position)) ?? null : null;
      const particles = (ctx.systems.effects as { particles?: { create(spec: ReturnType<typeof missileSmokeSystem> & { frameDelay: number }): Flying["smoke"] } | null } | null)?.particles ?? null;
      const smoke = type.config.smoke !== 0 && particles ? particles.create({ ...missileSmokeSystem(type.config), frameDelay: 0 }) : null;
      list.push({
        kind: "missile", id: nextId++, model: s.model, position: [...m.position], velocity: [...m.body.velocity], matrix: [...m.matrix] as M3, owner: s.owner,
        radius: MISSILE_RULES.explosion.radius, damage: MISSILE_RULES.explosion.damage, fuel: m.fuel, frames: 0, sourceWeaponId: s.sourceWeaponId, updates: 0,
        missile: m, skipBody: s.skipBody ?? null, target: s.targetObject ?? null,
        sound: sound ? { update: (p) => sound.update(p), dispose: () => sound.dispose() } : null, smoke,
      });
    },
    update() {
      const next: Flying[] = [];
      for (const p of list) {
        p.updates++;
        const alive = p.kind === "m203" ? stepM203(p) : stepMissile(p);
        if (alive) next.push(p);
      }
      list = next;
    },
    clear() {
      for (const p of list) p.sound?.dispose();
      list = [];
      explosions = 0;
      lastMissileExplosion = null;
    },
    setMissileModels(models) {
      missileModels = models;
    },
    missileModelOf(weaponId) {
      return missileModels.get(weaponId) ?? null;
    },
    models() {
      return list.map((p) => ({ key: `proj:${p.id}`, model: p.model, position: p.position, matrix: p.matrix }));
    },
  };
}
