/**
 * Objective tracker. OWNED BY: engine/combat agent.
 *
 * Evaluates ctx.objectives each frame (reach-zone proximity, eliminate counts)
 * and emits GameEvent.ObjectiveComplete / MissionComplete. Replaces this stub.
 */
import type { GameContext } from "../context";

export interface ObjectiveTracker {
  update(_dt: number): void;
  /** True when every objective is completed. */
  readonly allComplete: boolean;
}

export function createObjectiveTracker(ctx: GameContext): ObjectiveTracker {
  return {
    update(_dt: number): void {
      for (const objective of ctx.objectives) {
        if (objective.completed) continue;
        if (objective.spec.type === "reach") {
          const dx = ctx.player.position[0] - objective.spec.position[0];
          const dz = ctx.player.position[2] - objective.spec.position[2];
          if (Math.hypot(dx, dz) <= objective.spec.radius) {
            objective.completed = true;
            ctx.events.emit("game:objective-complete", { id: objective.spec.id });
          }
        }
      }
      if (ctx.objectives.length > 0 && ctx.objectives.every((o) => o.completed)) {
        ctx.events.emit("game:mission-complete");
      }
    },
    get allComplete(): boolean {
      return ctx.objectives.length > 0 && ctx.objectives.every((o) => o.completed);
    },
  };
}
