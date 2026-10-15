/**
 * One bullet ray, traced as igi.exe's FUN_00479e30 does [recovered]:
 *
 *   while range remains: cast from the current point along the direction
 *   for the remaining range against the visible faces (HSMC set 0), the
 *   terrain and the humans; on the nearest hit
 *   - front face (entering): the object takes the hit (humans: damage), the
 *     material's impact sound plays; then, unless the bullet is inside a
 *     solid it entered earlier,
 *       - ricochet, once per bullet, with chance (A k - (pi/2 - i)) / (A k)
 *         (A = material ricochet angle in degrees, k = pi/180 as f32 0x531684,
 *         i = angle between the reversed ray and the face normal): the
 *         direction is mirrored about the normal;
 *       - else penetration: d = weapon "Penetration Power" - material hardness;
 *         d >= 1 passes, d == 0 passes with chance 0.6 (0x53169c), less stops;
 *         only faces of an object pass (terrain always stops);
 *     a front hit while inside a solid stops the bullet;
 *   - back face (leaving a solid): marks the bullet as inside (exit effect B;
 *     not drawn by the port);
 *   then range -= hit distance and the next cast starts 20.48 units (5 mm,
 *   0x532130) past the hit point along the (possibly mirrored) direction.
 *
 * Humans are closed bodies (their posed bone-model collision set 0, with
 * per-face materials: Flesh, BloodyFlesh, helmet metal): a body is entered at
 * its first hit and its exit is implied (the bullet is then inside a solid).
 */
import type { Vec3 } from "../../contracts";
import type { SurfaceMaterial } from "../../loaders";
import { x87Div, x87F32Mul, x87F32Sub, x87StoreF32, x87Sub } from "../../loaders/x87";
import { TRI_BULLET, type CollisionWorld } from "../world/collision";
import type { BulletHitReport, BulletSegmentReport } from "../fx/bullet-effects";
import type { BulletObjectHit } from "./object-damage";

/** Restart offset past a hit: 20.48 units (f32 0x532130). */
const ADVANCE_M = Math.fround(20.479999542236328) / 4096;
const DEG_TO_RAD = Math.fround(0.01745329238474369);
const HALF_PI = Math.fround(1.5707963705062866);
/** Equal penetration power and hardness pass with this chance (f32 0x53169c). */
const EQUAL_PASS_CHANCE = Math.fround(0.6000000238418579);
/** Untagged object faces report Ground. */
const GROUND = 1;
/** Material human hits use (Flesh) [inferred]. */
export const HUMAN_HIT_MATERIAL = 8;
/** At most this many impacts per bullet are recorded for effects (FUN_00479e30 count < 10). */
const MAX_IMPACTS = 10;

export interface BulletHumanHit {
  distance: number;
  point: Vec3;
  /** Identity of the human, so a bullet does not enter the same body twice. */
  key: unknown;
  /** Material of the body face hit (its bone model's collision set 0); default Flesh. */
  material?: number;
  /** Apply the hit (damage, AI event). */
  apply(): void;
}

export interface BulletImpact {
  point: Vec3;
  /** Unit face normal towards the incoming bullet. */
  normal: Vec3;
  /** Material name (material.qvm), or null without one. */
  material: string | null;
  /** The bullet ricocheted off this surface. */
  ricochet: boolean;
  /** The hit was on a human (no decal). */
  human: boolean;
}

export interface BulletTrace {
  world: CollisionWorld | null;
  from: Vec3;
  /** Unit direction. */
  dir: Vec3;
  /** Weapon range, metres. */
  range: number;
  /** Weapon "Penetration Power". */
  penetration: number;
  materials: readonly SurfaceMaterial[];
  random: () => number;
  /** Nearest human hit along the segment within maxDistance, skipping `exclude`d bodies. */
  human?(from: Vec3, dir: Vec3, maxDistance: number, exclude: ReadonlySet<unknown>): BulletHumanHit | null;
  /**
   * A front-face hit on an object face (not terrain, not a human): the object's bullet-hit method
   * (FUN_00479e30 0x47a0dd), before the impact, the ricochet roll and the penetration test, even
   * inside a solid (combat/object-damage.ts bulletHit).
   */
  object?(hit: BulletObjectHit): void;
  onImpact?(impact: BulletImpact): void;
}

export interface BulletResult {
  /** End point of the last segment. */
  end: Vec3;
  /** Front-face surfaces hit, in order. */
  impacts: BulletImpact[];
  /** Every face hit (front and back), in order, for the effect records (fx/bullet-effects.ts gunshotEffectCalls). */
  hits: BulletHitReport[];
  /** Every cast (tracer rule, fx/tracers.ts). */
  segments: BulletSegmentReport[];
  /** The bullet ricocheted (bullet +0x40). */
  ricocheted: boolean;
}

/** FUN_004a8e10: angle between two vectors (0 for a zero vector). */
function angleBetween(a: Vec3, b: Vec3): number {
  const la = Math.hypot(a[0], a[1], a[2]);
  const lb = Math.hypot(b[0], b[1], b[2]);
  if (la === 0 || lb === 0) return 0;
  const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
  if (c >= 1) return 0;
  if (c <= -1) return Math.PI;
  return Math.acos(c);
}

export function traceBullet(t: BulletTrace): BulletResult {
  let remaining = t.range;
  const pos: Vec3 = [...t.from];
  const dir: Vec3 = [...t.dir];
  let ricocheted = false;
  let inside = false;
  const entered = new Set<unknown>();
  const impacts: BulletImpact[] = [];
  const hits: BulletHitReport[] = [];
  const segments: BulletSegmentReport[] = [];
  let recorded = 0;
  const end: Vec3 = [...t.from];
  for (let guard = 0; remaining > 0 && guard < 64; guard++) {
    const wall = t.world?.raycast(pos[0], pos[1], pos[2], dir[0], dir[1], dir[2], remaining, TRI_BULLET) ?? null;
    const human = t.human?.(pos, dir, wall ? wall.distance : remaining, entered) ?? null;
    const castStart: Vec3 = [pos[0], pos[1], pos[2]];
    const castVector: Vec3 = [dir[0] * remaining, dir[1] * remaining, dir[2] * remaining];
    if (!wall && !human) {
      end[0] = pos[0] + dir[0] * remaining;
      end[1] = pos[1] + dir[1] * remaining;
      end[2] = pos[2] + dir[2] * remaining;
      segments.push({ start: castStart, end: [end[0], end[1], end[2]], passed: false, ricocheted });
      break;
    }
    const isHuman = human !== null && (!wall || human.distance < wall.distance);
    const distance = isHuman ? human!.distance : wall!.distance;
    const point: Vec3 = isHuman ? [...human!.point] : [...wall!.point];
    const normal: Vec3 = isHuman ? [-dir[0], -dir[1], -dir[2]] : [...wall!.normal];
    const front = isHuman ? true : wall!.front;
    // Materials of the record words: front hits carry the face material (untagged -> Ground; terrain front -> Ground),
    // back hits carry it in the back word (terrain back faces carry none).
    const material = isHuman ? (human!.material ?? HUMAN_HIT_MATERIAL) : wall!.material < 0 ? (wall!.terrain ? -1 : GROUND) : wall!.material;
    const isObject = isHuman || (wall !== null && !wall.terrain);
    end[0] = point[0];
    end[1] = point[1];
    end[2] = point[2];
    let stop = false;
    let bounced = false;
    let passed = false;
    const surface = {
      terrain: !isHuman && wall!.terrain,
      owner: isHuman ? -1 : wall!.owner,
      body: !isHuman && wall!.triangle < 0 ? -1 - wall!.triangle : null,
      human: isHuman,
    };
    if (front && material >= 0) {
      if (isHuman) {
        entered.add(human!.key);
        human!.apply();
      } else if (!wall!.terrain) {
        t.object?.({ owner: wall!.owner, point: [point[0], point[1], point[2]], dir: [dir[0], dir[1], dir[2]], remaining });
      }
      const m = t.materials[material];
      if (!inside) {
        // float32 stores and register arithmetic in chop mode (0x47a243-0x47a2a0).
        const incidence = x87StoreF32(angleBetween([-dir[0], -dir[1], -dir[2]], normal));
        const a = m ? x87F32Mul(Math.fround(m.ricochetDeg), DEG_TO_RAD) : 0;
        const chance = a === 0 ? 0 : x87StoreF32(x87Div(x87Sub(a, x87Sub(HALF_PI, incidence)), a));
        if (!ricocheted && t.random() < chance) {
          // Mirror the direction about the face normal.
          const c = -(dir[0] * normal[0] + dir[1] * normal[1] + dir[2] * normal[2]);
          dir[0] += 2 * c * normal[0];
          dir[1] += 2 * c * normal[1];
          dir[2] += 2 * c * normal[2];
          const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
          dir[0] /= len;
          dir[1] /= len;
          dir[2] /= len;
          ricocheted = true;
          bounced = true;
        } else {
          const d = x87F32Sub(Math.fround(t.penetration), Math.fround(m?.hardness ?? 0));
          const passes = d === 0 ? t.random() < EQUAL_PASS_CHANCE : d >= 1;
          if (!passes || !isObject) stop = true;
          else {
            passed = true; // local_705
            if (isHuman) inside = true; // the body's exit face is implied
          }
        }
      } else {
        stop = true;
        inside = false;
      }
      const impact: BulletImpact = {
        point,
        normal,
        material: m?.name ?? null,
        ricochet: bounced,
        human: isHuman,
      };
      impacts.push(impact);
      hits.push({ front: true, material: m?.name ?? null, point: [...point], faceNormal: [...normal], segment: castVector, ...surface });
      if (recorded < MAX_IMPACTS) {
        recorded++;
        t.onImpact?.(impact);
      }
    } else if (!front && material >= 0) {
      inside = true;
      // Exit (back face): effect B; the record normal is the outward normal (along the ray).
      hits.push({ front: false, material: t.materials[material]?.name ?? null, point: [...point], faceNormal: [-normal[0], -normal[1], -normal[2]], segment: castVector, ...surface });
    }
    segments.push({ start: castStart, end: [point[0], point[1], point[2]], passed, ricocheted });
    remaining = stop ? 0 : remaining - distance;
    pos[0] = point[0] + dir[0] * ADVANCE_M;
    pos[1] = point[1] + dir[1] * ADVANCE_M;
    pos[2] = point[2] + dir[2] * ADVANCE_M;
  }
  return { end, impacts, hits, segments, ricocheted };
}
