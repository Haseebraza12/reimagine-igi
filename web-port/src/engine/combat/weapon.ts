/**
 * Weapon system (hitscan). OWNED BY: engine/combat agent.
 *
 * Handles trigger input, cyclic rate, spread, ammo/reload, and applies hitscan
 * damage against ctx.enemies via a ray from the camera. Emits GameEvent.Fire /
 * Hit / EnemyKilled. Replaces this stub.
 */
import type { GameContext } from "../context";

export interface WeaponSystem {
  update(dt: number): void;
  /** Begin/queued reload; no-op when already full or reloading. */
  reload(): void;
}

export function createWeaponSystem(ctx: GameContext): WeaponSystem {
  return {
    update(_dt: number): void {
      if (!ctx.weapon) return;
      const w = ctx.weapon;
      if (w.cooldownRemaining > 0) w.cooldownRemaining = Math.max(0, w.cooldownRemaining - _dt);
      if (w.reloadRemaining > 0) {
        w.reloadRemaining = Math.max(0, w.reloadRemaining - _dt);
        if (w.reloadRemaining === 0) {
          w.reloading = false;
          const need = w.spec.magSize - w.ammo;
          const take = Math.min(need, w.reserve);
          w.ammo += take;
          w.reserve -= take;
          ctx.events.emit("game:reload-end", { weaponId: w.spec.id });
        }
      }
    },
    reload(): void {
      /* replaced by agent */
    },
  };
}
