/**
 * GuardGenerator (82 tasks in missions 4-14): a container that keeps its child
 * soldier as a template and (re)spawns it while its expression holds, up to
 * "Max spawns" times (docs/ai.md "Guard generators").
 *
 * Recovered (full exe; class registered by FUN_00487be0, size 0x80, parent
 * the container 0x4018f0):
 *   - Schema: "Generate guards" VarString (+0x20), "Max spawns" Int32 (+0x78).
 *     Create FUN_00487eb0: isOn +0x70, members-registered +0x71, isSpawned
 *     +0x72, nSpawns +0x74, max +0x78 and the template +0x7c all 0 (the
 *     parameters are written over the defaults afterwards).
 *   - Members (0x488430): "<name>.isOn" and "<name>.isSpawned" (bytes),
 *     "<name>.nSpawns" (int).
 *   - Compile FUN_00488200 -> FUN_00488220: every child subtree is serialised
 *     (each task's declared parameters through its schema) into the template
 *     and the children are deleted: at level start no generated soldier
 *     exists (their HumanAI compile, and so its perception phase, never runs).
 *   - Update FUN_00487ee0, every tick, before the children:
 *       1. isOn = (char)fistp(expression) when the expression is valid;
 *       2. isOn == 0: with no child, isSpawned = 0 (a living soldier is never
 *          removed by the generator);
 *       3. isOn != 0 and nSpawns < Max spawns: no child -> spawn; else when the
 *          (first) child is dead (+0xcf5, FUN_00463170) and out of the world
 *          (+0xcf6 == 0, FUN_00463190) -> delete it (FUN_004015f0) and spawn.
 *          Each spawn (FUN_00488000: instantiate the template under the
 *          generator, FUN_00488040, then its compile with record 1) sets
 *          isSpawned = 1 and nSpawns + 1, so Max spawns counts the first one;
 *       4. the children update.
 *   - The soldier leaves the world 300 ticks after its death clip ended
 *     (HumanAI update 0x44fa8f-0x44fb7f, unconditionally for a GuardGenerator
 *     child): engine side (combat/enemy.ts).
 * The engine instantiates and deletes the soldiers through the task events
 * "guard.spawn" / "guard.remove" ({ children: node indices }) and answers the
 * query "guard.child" (generator node, child node) with the child's
 * { dead, inWorld } (MissionHost.onTaskEvent / query). Without an engine the
 * spawned child counts as alive and in the world.
 */
import { registerTaskBehaviour, type TaskBehaviourContext } from "../mission";

/** The answer of the engine's "guard.child" query. */
export interface GuardChildState {
  /** Human +0xcf5. */
  dead: boolean;
  /** Human +0xcf6 (in the world). */
  inWorld: boolean;
}

/** Event / query names of the GuardGenerator protocol (MissionHost.onTaskEvent / query). */
export const GUARD_EVENTS = {
  spawn: "guard.spawn",
  remove: "guard.remove",
  child: "guard.child",
} as const;

/** Is node `index` inside a GuardGenerator (a template soldier, not created at load)? */
export function underGuardGenerator(nodes: ReadonlyArray<{ type: string; parent: number }>, index: number): boolean {
  for (let n = nodes[index]?.parent ?? -1; n >= 0; n = nodes[n].parent) if (nodes[n].type === "GuardGenerator") return true;
  return false;
}

function maxSpawns(c: TaskBehaviourContext): number {
  const v = c.node.task.params["Max spawns"];
  return typeof v === "number" ? Math.trunc(v) : 0;
}

/** FUN_00488000: instantiate the template (the engine creates the soldier and its AI). */
function spawn(c: TaskBehaviourContext): void {
  c.state.hasChild = 1;
  c.emit(GUARD_EVENTS.spawn, { children: [...c.node.children] });
  c.state.isSpawned = 1;
  c.state.nSpawns = (c.state.nSpawns + 1) | 0;
}

registerTaskBehaviour("GuardGenerator", {
  expressions: ["Generate guards"],
  members: { isOn: "char", isSpawned: "char", nSpawns: "int" },
  create(c) {
    // FUN_00487eb0, then the parameters (Max spawns +0x78).
    Object.assign(c.state, { isOn: 0, isSpawned: 0, nSpawns: 0, maxSpawns: maxSpawns(c), hasChild: 0 });
  },
  update(c) {
    const s = c.state;
    const on = c.evalByte("Generate guards");
    if (on !== null) s.isOn = on;
    if (s.isOn === 0) {
      if (!s.hasChild) s.isSpawned = 0;
    } else if (s.nSpawns < s.maxSpawns) {
      if (!s.hasChild) spawn(c);
      else {
        const first = c.node.children[0];
        const child = first === undefined ? null : (c.host.query?.(GUARD_EVENTS.child, c.node, first) as GuardChildState | null | undefined);
        if (child && child.dead && !child.inWorld) {
          // FUN_004015f0: the old soldier task is deleted, then the template is instantiated again.
          c.emit(GUARD_EVENTS.remove, { children: [...c.node.children] });
          s.hasChild = 0;
          spawn(c);
        }
      }
    }
    if (s.hasChild) c.updateChildren();
  },
});
