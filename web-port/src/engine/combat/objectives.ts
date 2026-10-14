/**
 * Objective tracker.
 *
 * Evaluates ctx.objectives each frame (reach-zone proximity, eliminate counts)
 * and emits GameEvent.ObjectiveComplete / MissionComplete.
 */
import { GameEvent } from "../events";
import type { GameContext } from "../context";

export interface ObjectiveTracker {
  update(_dt: number): void;
  /** True when every objective is completed. */
  readonly allComplete: boolean;
}

export function createObjectiveTracker(ctx: GameContext): ObjectiveTracker {
  /** Guards against re-emitting MissionComplete every frame once complete. */
  let missionEmitted = false;

  return {
    update(_dt: number): void {
      for (const objective of ctx.objectives) {
        if (objective.completed) continue;
        // `type` is widened to string so we can also support "eliminate"
        // objectives even though the shipped ObjectiveSpec union lists "reach".
        const type = objective.spec.type as string;

        if (type === "reach") {
          const pos = objective.spec.position;
          const radius = objective.spec.radius;
          if (pos && typeof radius === "number") {
            const dx = ctx.player.position[0] - pos[0];
            const dz = ctx.player.position[2] - pos[2];
            if (Math.hypot(dx, dz) <= radius) {
              objective.completed = true;
              ctx.events.emit(GameEvent.ObjectiveComplete, { id: objective.spec.id });
            }
          }
        } else if (type === "eliminate") {
          // Complete only once enemies exist and every one of them is dead.
          if (ctx.enemies.length > 0 && ctx.enemies.every((e) => !e.alive)) {
            objective.completed = true;
            ctx.events.emit(GameEvent.ObjectiveComplete, { id: objective.spec.id });
          }
        }
      }

      const allDone =
        ctx.objectives.length > 0 && ctx.objectives.every((o) => o.completed);
      if (allDone) {
        if (!missionEmitted) {
          missionEmitted = true;
          ctx.events.emit(GameEvent.MissionComplete);
        }
      } else {
        // Reset so a level restart can fire MissionComplete again.
        missionEmitted = false;
      }
    },
    get allComplete(): boolean {
      return ctx.objectives.length > 0 && ctx.objectives.every((o) => o.completed);
    },
  };
}
