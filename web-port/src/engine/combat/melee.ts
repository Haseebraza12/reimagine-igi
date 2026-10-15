/**
 * The player's knife stab: weaponconfig "Projectile Task Type"
 * TASKTYPE_KNIFESTAB, spawned by the gun fire FUN_004772c0 -> FUN_00413cd0
 * like a bullet (docs/weapons-view.md "Knife").
 *
 * Recovered (FUN_0046caf0, FUN_0046cb30):
 *   - three rays from the eye, 8192 units (2 m) long, along the aim forward
 *     turned about the aim matrix's up axis by -15, -5 and +5 degrees
 *     (f32 -0.2617994, step 0.17453294; FUN_004a9a70 = M x Rz(a), so the
 *     forward becomes cos(a) forward - sin(a) right: 15 deg right, 5 deg
 *     right, 5 deg left), in that order; the aim matrix is FUN_00486a60's
 *     basis of the view forward (right = horizontal);
 *   - the ray uses the bullet collision set (FUN_00415730) and stops at the
 *     first surface; a hit on a task with a hit handler (a human) ends the
 *     stab, anything else (walls) lets the next ray try;
 *   - hit record: damage = weapon "Damage Factor" (knife 0.1), replaced by
 *     1000 when the victim is a human with an AI that holds no combat target
 *     record (H+0x3aa8 == 0, FUN_00451700): a stealth kill; direction = the
 *     ray; attacker field 0;
 *   - the soldier handler FUN_0045bfe0 multiplies by the hit-zone multiplier
 *     (head x100 unless AI flag +0x3ab9) and, when the soldier survives,
 *     plays "ai_hit_N" and, for WEAPONTYPE_KNIFE (3), "stab_01" on it.
 * Not reproduced: the attacker field 0 in the AI's hit event (the port's
 * damage() names the player).
 */
import type { Vec3 } from "../../contracts";
import type { LevelWeapon } from "../../loaders";
import type { GameContext } from "../context";
import { GameEvent } from "../events";
import { TRI_BULLET } from "../world/collision";
import type { EnemyHitResult } from "./enemy";

/** Stab reach: 8192 units (double 0x531708). */
export const KNIFE_REACH_M = 8192 / 4096;
/** Ray angles: f32 -0.2617994, then + f32 0.17453294 twice (0x46caf9, 0x531664). */
export const KNIFE_RAY_ANGLES: readonly number[] = (() => {
  const out: number[] = [];
  let a = Math.fround(-0.2617994);
  for (let i = 0; i < 3; i++) {
    out.push(a);
    a = Math.fround(a + 0.1745329350233078);
  }
  return out;
})();
/** Damage of a stab on a soldier without a combat target (0x46cd23: 0x447a0000). */
export const KNIFE_UNAWARE_DAMAGE = 1000;

export interface KnifeStabResult {
  hit: EnemyHitResult;
  /** Damage after the zone multiplier. */
  damage: number;
  /** The victim had no combat target (1000 base damage). */
  unaware: boolean;
  /** Index of the ray that hit (0 = 15 deg right). */
  ray: number;
}

type QuietHitTest = (from: Vec3, dir: Vec3, maxDistance: number, options?: { nearMiss?: boolean }) => EnemyHitResult[];

/** The three ray directions for an aim forward (unit) and the horizontal right (unit). */
export function knifeRayDirections(forward: Vec3, right: Vec3): Vec3[] {
  return KNIFE_RAY_ANGLES.map((a) => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    const d: Vec3 = [c * forward[0] - s * right[0], c * forward[1] - s * right[1], c * forward[2] - s * right[2]];
    const n = Math.hypot(d[0], d[1], d[2]) || 1;
    return [d[0] / n, d[1] / n, d[2] / n];
  });
}

/**
 * One stab from `eye` (engine metres). Damages the first soldier a ray
 * reaches and returns the hit, or null.
 */
export function knifeStab(ctx: GameContext, eye: Vec3, forward: Vec3, right: Vec3, spec: LevelWeapon): KnifeStabResult | null {
  const enemies = ctx.systems.enemies;
  if (!enemies) return null;
  const dirs = knifeRayDirections(forward, right);
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i];
    const wall = ctx.world?.raycast(eye[0], eye[1], eye[2], d[0], d[1], d[2], KNIFE_REACH_M, TRI_BULLET);
    const reach = wall ? Math.min(wall.distance, KNIFE_REACH_M) : KNIFE_REACH_M;
    // The stab posts no near-miss events (FUN_0046cb30); the option is ignored by older enemy managers.
    const humans = (enemies.hitTest as QuietHitTest).call(enemies, eye, d, reach, { nearMiss: false });
    const hit = humans.find((h) => h.distance <= reach && h.enemy.alive);
    if (!hit) continue;
    const ai = enemies.aiOf(hit.enemy);
    const unaware = ai !== null && ai.target === null;
    const base = unaware ? KNIFE_UNAWARE_DAMAGE : spec.damageFactor;
    const damage = base * hit.zoneMultiplier;
    ctx.events.emit(GameEvent.Hit, { damage, point: hit.point, head: hit.head });
    enemies.damage(hit.enemy, damage, eye);
    if (hit.enemy.alive) {
      const audio = ctx.systems.audio as { attachTo?: (name: string, actor: number) => unknown } | null;
      audio?.attachTo?.("stab_01", hit.enemy.id);
    }
    return { hit, damage, unaware, ray: i };
  }
  return null;
}
