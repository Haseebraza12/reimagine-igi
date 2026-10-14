/**
 * Visual effects (muzzle flash, tracers, impact sparks). OWNED BY: engine/
 * presentation agent.
 *
 * Spawns short-lived Three.js objects for weapon feedback and recycles them.
 * All methods are no-ops until the agent implements them; the game runs
 * correctly without effects. Replaces this stub.
 */
import type { Vec3 } from "../../contracts";
import type { GameContext } from "../context";

export interface Effects {
  update(dt: number): void;
  muzzleFlash(position: Vec3, direction: Vec3): void;
  tracer(from: Vec3, to: Vec3): void;
  impact(point: Vec3): void;
  clear(): void;
}

export function createEffects(_ctx: GameContext): Effects {
  return {
    update(_dt: number): void {
      /* replaced by agent */
    },
    muzzleFlash(_position: Vec3, _direction: Vec3): void {
      /* replaced by agent */
    },
    tracer(_from: Vec3, _to: Vec3): void {
      /* replaced by agent */
    },
    impact(_point: Vec3): void {
      /* replaced by agent */
    },
    clear(): void {
      /* replaced by agent */
    },
  };
}
