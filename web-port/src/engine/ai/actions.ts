/**
 * AIAction_* implementations (start / update / stop functions), tick by
 * tick as docs/ai.md section 5 recovers them. Combat lives in combat.ts.
 *
 * Recovered: Patrol (0x48cc40 / 0x48cca0 / 0x48ceb0) with the patrol
 * cursor (FUN_00452540 / FUN_00452570) and the commands of FUN_0048cca0;
 * Dead / Idle (level the view, never end); FallFlat (lie down for `time`
 * seconds); WalkToNode / RunToNode (reserve the node's centre cell, walk or
 * run, end on arrival); PlayAnimation (wait for stand, request, wait while
 * in the animation state, end); MoveToEvent; LookAtEvent (2 deg, then the
 * time since the start); Stunned (animation 38 for `time` seconds);
 * KickGrenade (never ends: a stub in igi.exe too); RunPanicking (radius in
 * metres; BFS of up to 10 nodes from the node nearest the event for one
 * farther than r with a free cell; panic run there); SetCombat (post COMBAT
 * to itself, end); Activate (walk / run to the task's nearest node, request
 * use with channel 24 = task id, end).
 *
 * Inferred: the patrol's WALKTO / RUNTO do not reserve occupancy cells; a
 * missing PatrolPath task ends the action; Activate does not do the switch
 * reservation / free-node BFS (no level-1 script reaches Activate: no
 * soldier has an alarm trigger id).
 */
import {
  AI_AIM_TOLERANCE,
  AI_LOOKAT_NODE_TOLERANCE,
  AI_TURN_CLAMP,
  AiPatrolCursor,
  PATROL_COMMAND,
  type PatrolCommand,
} from "../../loaders";
import { combatActionFor as combatFor, fireAtAction } from "./combat";
import type { ActionImpl, ActionRecord, HumanAi } from "./human-ai";
import { BODY, CH } from "./motor";
import { EV, dist, type V3 } from "./types";

// ---------------------------------------------------------------------------
// Idle / Dead
// ---------------------------------------------------------------------------

const idle: ActionImpl = {
  name: "Idle",
  update(ai) {
    ai.levelView();
  },
};

const dead: ActionImpl = {
  name: "Dead",
  update(ai) {
    ai.levelView();
  },
};

// ---------------------------------------------------------------------------
// Patrol
// ---------------------------------------------------------------------------

interface PatrolData {
  pathId: number;
  start: number;
  cursor?: AiPatrolCursor;
  timer: number;
  /** Per-command progress: 0 not started, 1 running, 2 animation playing. */
  phase: number;
  crouch: boolean;
}

function patrolCommands(ai: HumanAi, id: number): PatrolCommand[] | null {
  const task = ai.world.data.taskById.get(id);
  if (!task || task.type !== "PatrolPath") return null;
  return task.children
    .filter((c) => c.type === "PatrolPathCommand")
    .map((c) => ({ command: Number(c.params["Command"]), parameter: Number(c.params["Command Parameter"]) }));
}

const patrol: ActionImpl<PatrolData> = {
  name: "Patrol",
  start(ai, rec) {
    const cmds = patrolCommands(ai, rec.data.pathId);
    rec.data.timer = 0;
    rec.data.phase = 0;
    rec.data.crouch = false;
    if (cmds) rec.data.cursor = new AiPatrolCursor(cmds, rec.data.start);
    else ai.world.hooks.log?.(`HumanAI ${ai.spec.aiTaskId}: PatrolPath ${rec.data.pathId} not found`);
  },
  update(ai, rec) {
    const d = rec.data;
    const cmd = d.cursor?.command() ?? null;
    if (!cmd) {
      ai.endAction(rec);
      return;
    }
    if (d.crouch) ai.ch[CH.KNEEL] = 1;
    let done = false;
    switch (cmd.command) {
      case PATROL_COMMAND.ANIMATION:
        // Request the animation; finished when the body is back in the stand / kneel state.
        if (d.phase === 0) {
          if (ai.motor.state === BODY.ANIMATION) {
            d.phase = 2;
          } else if (ai.motor.state === BODY.STAND || ai.motor.state === BODY.KNEEL) {
            ai.ch[CH.ANIMATION] = cmd.parameter;
            d.phase = 1;
          }
        } else if (d.phase === 1) {
          if (ai.motor.state === BODY.ANIMATION) d.phase = 2;
          else done = true; // the clip does not exist: nothing to wait for
        } else if (ai.motor.state === BODY.STAND || ai.motor.state === BODY.KNEEL) {
          done = true;
        }
        break;
      case PATROL_COMMAND.DELAY:
        ai.levelView();
        done = ++d.timer >= cmd.parameter;
        break;
      case PATROL_COMMAND.WALKTO:
      case PATROL_COMMAND.RUNTO:
        d.crouch = false;
        ai.ch[CH.KNEEL] = 0;
        if (cmd.command === PATROL_COMMAND.WALKTO) ai.walkMode();
        else ai.runMode();
        if (d.phase === 0) {
          d.phase = 1;
          if (!ai.routeTo(cmd.parameter)) {
            done = true;
            break;
          }
        }
        done = ai.followRoute();
        break;
      case PATROL_COMMAND.CROUCH:
        d.crouch = true;
        ai.ch[CH.KNEEL] = 1;
        done = true;
        break;
      case PATROL_COMMAND.LOOKATNODE: {
        const p = ai.nodeWorld(cmd.parameter);
        done = !p || ai.turnTo(p, AI_TURN_CLAMP.lookAtNode, AI_LOOKAT_NODE_TOLERANCE);
        break;
      }
      case PATROL_COMMAND.QUIT:
        ai.endAction(rec);
        return;
      default:
        done = true; // END is consumed by the cursor; SETSPEED is ignored by soldiers
        break;
    }
    if (done) {
      d.cursor!.advance();
      d.timer = 0;
      d.phase = 0;
      ai.route = [];
    }
  },
  stop(ai) {
    ai.route = [];
  },
};

// ---------------------------------------------------------------------------
// FallFlat, Stunned, PlayAnimation, PlaySound, KickGrenade
// ---------------------------------------------------------------------------

const fallFlat: ActionImpl<{ ticks: number; until?: number }> = {
  name: "FallFlat",
  start(ai, rec) {
    rec.data.until = ai.now + rec.data.ticks;
  },
  update(ai, rec) {
    ai.ch[CH.LIEDOWN] = 1;
    if (ai.now >= rec.data.until!) ai.endAction(rec);
  },
};

const stunned: ActionImpl<{ ticks: number; until?: number }> = {
  name: "Stunned",
  start(ai, rec) {
    rec.data.until = ai.now + rec.data.ticks;
  },
  update(ai, rec) {
    if (ai.motor.state !== BODY.ANIMATION) ai.ch[CH.ANIMATION] = 38;
    if (ai.now >= rec.data.until!) ai.endAction(rec);
  },
};

const playAnimation: ActionImpl<{ anim: number; phase?: number }> = {
  name: "PlayAnimation",
  update(ai, rec) {
    const d = rec.data;
    const state = ai.motor.state;
    if (!d.phase) {
      if (state !== BODY.STAND) return; // wait for the stand state
      ai.ch[CH.ANIMATION] = d.anim;
      d.phase = 1;
      return;
    }
    if (d.phase === 1) {
      if (state === BODY.ANIMATION) d.phase = 2;
      else ai.endAction(rec); // clip missing in the soldier's file
      return;
    }
    if (state !== BODY.ANIMATION) ai.endAction(rec);
  },
};

const playSound: ActionImpl<{ sound: string; attached: boolean }> = {
  name: "PlaySound",
  update(ai, rec) {
    ai.world.hooks.playSound?.(ai, rec.data.sound);
    ai.endAction(rec);
  },
};

const kickGrenade: ActionImpl = {
  name: "KickGrenade",
  update(ai) {
    ai.world.hooks.log?.("Kick grenade");
  },
};

// ---------------------------------------------------------------------------
// Movement actions
// ---------------------------------------------------------------------------

const toNode: ActionImpl<{ node: number; run: boolean; started?: boolean }> = {
  name: "ToNode",
  start(ai, rec) {
    const cell = ai.reserveCell(rec.data.node);
    rec.data.started = ai.routeTo(rec.data.node, cell ?? undefined);
  },
  update(ai, rec) {
    if (rec.data.run) ai.runMode();
    else ai.walkMode();
    if (!rec.data.started || ai.followRoute()) ai.endAction(rec);
  },
  stop(ai) {
    ai.route = [];
  },
};

const moveToEvent: ActionImpl<{ run: boolean; position: V3; started?: boolean }> = {
  name: "MoveToEvent",
  start(ai, rec) {
    const node = ai.closestNode(rec.data.position);
    rec.data.started = node >= 0 && ai.routeTo(node);
  },
  update(ai, rec) {
    if (rec.data.run) ai.runMode();
    else ai.walkMode();
    if (!rec.data.started || ai.followRoute()) ai.endAction(rec);
  },
  stop(ai) {
    ai.route = [];
  },
};

const lookAtEvent: ActionImpl<{ ticks: number; position: V3; startTick?: number }> = {
  name: "LookAtEvent",
  start(ai, rec) {
    rec.data.startTick = ai.now;
  },
  update(ai, rec) {
    if (ai.turnTo(rec.data.position, AI_TURN_CLAMP.normal, AI_AIM_TOLERANCE) && ai.now - rec.data.startTick! >= rec.data.ticks) {
      ai.endAction(rec);
    }
  },
};

/** BFS over the graph from `start`, examining at most `limit` nodes; first node passing `ok`. */
export function bfsNodes(ai: HumanAi, start: number, limit: number, ok: (node: number) => boolean): number | null {
  const g = ai.graphInfo?.graph;
  if (!g || !g.nodeById.has(start)) return null;
  const seen = new Set<number>([start]);
  const queue = [start];
  let examined = 0;
  while (queue.length && examined < limit) {
    const n = queue.shift()!;
    examined++;
    if (ok(n)) return n;
    for (const m of g.nodeById.get(n)!.neighbours) {
      if (!seen.has(m)) {
        seen.add(m);
        queue.push(m);
      }
    }
  }
  return null;
}

const runPanicking: ActionImpl<{ radius: number; position: V3; started?: boolean }> = {
  name: "RunPanicking",
  start(ai, rec) {
    const d = rec.data;
    d.started = false;
    if (dist(d.position, ai.pos) > d.radius) return;
    const from = ai.closestNode(d.position);
    const node = bfsNodes(ai, from, 10, (n) => {
      const w = ai.nodeWorld(n);
      return Boolean(w && dist(w, d.position) > d.radius && ai.freeCell(n));
    });
    if (node === null) return;
    const cell = ai.reserveCell(node, undefined, true);
    d.started = ai.routeTo(node, cell ?? undefined);
  },
  update(ai, rec) {
    if (!rec.data.started) {
      ai.endAction(rec);
      return;
    }
    ai.ch[CH.PANIC] = 1;
    ai.runMode();
    if (ai.followRoute()) ai.endAction(rec);
  },
  stop(ai) {
    ai.route = [];
  },
};

const setCombat: ActionImpl<{ position: V3; source: number | null; other: number | null }> = {
  name: "SetCombat",
  update(ai, rec) {
    ai.post({ type: EV.COMBAT, team: ai.team, flags: 0, range: -1, position: rec.data.position, source: rec.data.source, other: rec.data.other });
    ai.endAction(rec);
  },
};

const activate: ActionImpl<{ taskId: number; run: boolean; node?: number; started?: boolean }> = {
  name: "Activate",
  start(ai, rec) {
    const p = ai.world.hooks.taskPosition(rec.data.taskId);
    const node = p ? ai.closestNode(p) : -1;
    rec.data.node = node;
    rec.data.started = node >= 0 && ai.routeTo(node);
  },
  update(ai, rec) {
    if (rec.data.run) ai.runMode();
    else ai.walkMode();
    if (!rec.data.started || ai.followRoute()) {
      ai.ch[CH.USE] = rec.data.taskId;
      ai.endAction(rec);
    }
  },
  stop(ai) {
    ai.route = [];
  },
};

export const ACTIONS = {
  idle,
  dead,
  patrol,
  fallFlat,
  stunned,
  playAnimation,
  playSound,
  kickGrenade,
  toNode,
  moveToEvent,
  lookAtEvent,
  runPanicking,
  setCombat,
  activate,
  get fireAt() {
    return fireAtAction;
  },
} as const;

export function combatActionFor(aiType: string): ActionImpl<unknown> | null {
  return combatFor(aiType);
}

export type { ActionRecord };
