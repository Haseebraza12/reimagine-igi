/**
 * Mission flow from objects.qvm.
 *
 * Recovered: objective text (objectives.res "M1_OBJ1"), its completion area
 * (DefineComputerObjective -> EditVariable_105 "Add" rule -> AreaActivate_200
 * beside the truck), Anya's radio messages and the areas that trigger them
 * (StatusMessage tasks), and the failure text. The original then plays a
 * cut-scene (CutScene_1204, not reproduced) and completes the level.
 * Simplified: extra message conditions (e.g. "gates closed") are ignored, and
 * failure is the player's death only (the truck cannot be destroyed here).
 */
import { GameEvent } from "../events";
import type { GameContext } from "../context";
import type { LevelArea } from "../../loaders";

export interface ObjectiveTracker {
  update(dt: number): void;
  reset(): void;
  readonly allComplete: boolean;
}

function inside(area: LevelArea, p: [number, number, number]): boolean {
  // The player position is the feet; test the body's lower half.
  const y = p[1] + 0.5;
  return (
    Math.abs(p[0] - area.center[0]) <= area.halfExtents[0] &&
    Math.abs(y - area.center[1]) <= area.halfExtents[1] + 0.5 &&
    Math.abs(p[2] - area.center[2]) <= area.halfExtents[2]
  );
}

export function createObjectiveTracker(ctx: GameContext): ObjectiveTracker {
  let finished = false;

  function reset(): void {
    finished = false;
    const level = ctx.level;
    ctx.objectives = (level?.objectives ?? []).map((o) => ({ id: o.id, text: o.text, area: o.area, completed: false }));
    ctx.messages = (level?.messages ?? []).map((m) => ({ id: m.id, text: m.text, area: m.area, shown: false }));
  }

  return {
    reset,
    get allComplete() {
      return ctx.objectives.length > 0 && ctx.objectives.every((o) => o.completed);
    },
    update(): void {
      if (finished) return;
      const p = ctx.player.position;
      for (const message of ctx.messages) {
        if (!message.shown && inside(message.area, p)) {
          message.shown = true;
          ctx.events.emit(GameEvent.Status, { text: message.text, ttl: 7 });
        }
      }
      for (const objective of ctx.objectives) {
        if (!objective.completed && ctx.player.alive && inside(objective.area, p)) {
          objective.completed = true;
          ctx.events.emit(GameEvent.ObjectiveComplete, { id: objective.id, text: objective.text });
        }
      }
      if (ctx.objectives.length > 0 && ctx.objectives.every((o) => o.completed)) {
        finished = true;
        ctx.events.emit(GameEvent.MissionComplete);
      }
    },
  };
}
