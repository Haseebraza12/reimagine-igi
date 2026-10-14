/**
 * Enemy + AI manager. OWNED BY: engine/combat agent.
 *
 * Owns the enemy prototypes/capsules, spawns a small garrison for the slice,
 * and runs a simple perception -> patrol/engage state machine using the level
 * navigation graph (ctx.manifest nav) and terrain height. Replaces this stub.
 */
import type { GameContext } from "../context";

export interface EnemyManager {
  update(dt: number): void;
  /** Spawn `count` enemies near the player using nav nodes. */
  spawn(count: number): void;
}

export function createEnemyManager(ctx: GameContext): EnemyManager {
  return {
    update(_dt: number): void {
      // Stub: keep enemies pinned to terrain; no AI yet.
      for (const enemy of ctx.enemies) {
        if (!enemy.alive) continue;
        if (ctx.terrain) {
          enemy.position[1] = ctx.terrain.heightAt(enemy.position[0], enemy.position[2]);
        }
      }
    },
    spawn(_count: number): void {
      /* replaced by agent */
    },
  };
}
