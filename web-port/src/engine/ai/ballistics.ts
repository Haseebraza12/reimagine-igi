/**
 * AI bullet vs the player (engine space, metres; pure).
 *
 * Recovered: FUN_0045d100 (the Human class's bullet-ray filter): when an AI
 * bullet's ray reaches the player's hitbox it collides only if
 * rand() <= p (the hit probability the fire sequence stored in soldier
 * +0x4d4, level RNG); otherwise it passes through.
 * Inferred: the hitbox is the movement capsule (radius 0.35 m, 1.8 m
 * standing / 1.3 m crouched); a near miss is a bullet path passing within
 * 2 m (the GUNSHOTMISS range) of the capsule's centre, reported at the
 * path's closest point.
 */
import { aiBulletMayHitPlayer } from "../../loaders";

type P3 = readonly [number, number, number];

/** Ray parameter (from + d t, d unit) where it enters a vertical capsule standing on `feet`, or null. */
export function rayCapsule(from: P3, d: P3, maxT: number, feet: P3, height: number, r: number): number | null {
  const ox = from[0] - feet[0];
  const oz = from[2] - feet[2];
  const a = d[0] * d[0] + d[2] * d[2];
  const lo = feet[1] + r;
  const hi = feet[1] + Math.max(r, height - r);
  let best: number | null = null;
  if (a > 1e-12) {
    const b = 2 * (ox * d[0] + oz * d[2]);
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      const y = from[1] + d[1] * t;
      if (t >= 0 && t <= maxT && y >= lo && y <= hi) best = t;
    }
  }
  for (const cy of [lo, hi]) {
    const cyo = from[1] - cy;
    const b = ox * d[0] + cyo * d[1] + oz * d[2];
    const c = ox * ox + cyo * cyo + oz * oz - r * r;
    const disc = b * b - c;
    if (disc < 0) continue;
    const t = -b - Math.sqrt(disc);
    if (t >= 0 && t <= maxT && (best === null || t < best)) best = t;
  }
  return best;
}

/** Closest point of the segment from + d t, t in [0, len], to p. */
export function closestOnSegment(from: P3, d: P3, len: number, p: readonly number[]): [number, number, number] {
  const t = Math.max(0, Math.min(len, (p[0] - from[0]) * d[0] + (p[1] - from[1]) * d[1] + (p[2] - from[2]) * d[2]));
  return [from[0] + d[0] * t, from[1] + d[1] * t, from[2] + d[2] * t];
}

export interface PlayerTarget {
  feet: P3;
  crouched: boolean;
}

export const PLAYER_HITBOX = { radius: 0.35, standing: 1.8, crouched: 1.3 } as const;
export const NEAR_MISS_METRES = 2;

/**
 * One AI bullet ray against the player. `rand` is drawn only when the ray
 * reaches the hitbox (the exe's draw order). Returns the hit distance, or
 * the near-miss point when the bullet passes (or passes through) close by.
 */
export function aiBulletVsPlayer(
  from: P3,
  d: P3,
  limit: number,
  player: PlayerTarget,
  hitProbability: number,
  rand: () => number,
): { hit: boolean; distance: number | null; nearMiss: [number, number, number] | null } {
  const height = player.crouched ? PLAYER_HITBOX.crouched : PLAYER_HITBOX.standing;
  const t = rayCapsule(from, d, limit, player.feet, height, PLAYER_HITBOX.radius);
  if (t !== null && aiBulletMayHitPlayer(rand(), hitProbability)) return { hit: true, distance: t, nearMiss: null };
  const centre: [number, number, number] = [player.feet[0], player.feet[1] + height * 0.6, player.feet[2]];
  const c = closestOnSegment(from, d, limit, centre);
  const near = Math.hypot(c[0] - centre[0], c[1] - centre[1], c[2] - centre[2]) <= NEAR_MISS_METRES;
  return { hit: false, distance: null, nearMiss: near ? c : null };
}
