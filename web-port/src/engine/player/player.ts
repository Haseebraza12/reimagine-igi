/**
 * Player movement controller. OWNED BY: engine/player agent.
 *
 * Reads ctx.input + ctx.terrain + ctx.tuning each frame and integrates
 * ctx.player (walk/run/crouch/jump, gravity, ground clamp, friction/accel).
 * Replaces this stub with a full implementation.
 */
import type { GameContext } from "../context";

export interface PlayerController {
  update(dt: number): void;
  /** Re-seed the player at the manifest spawn point. */
  reset(): void;
}

export function createPlayerController(ctx: GameContext): PlayerController {
  return {
    update(_dt: number): void {
      if (!ctx.terrain || !ctx.player.alive) return;
      // Stub: keep the player pinned to the terrain surface.
      ctx.player.position[1] = ctx.terrain.heightAt(ctx.player.position[0], ctx.player.position[2]);
      ctx.player.grounded = true;
    },
    reset(): void {
      /* replaced by agent */
    },
  };
}
