/**
 * AIAction_Combat per AI type and firing (docs/ai.md sections 6 and 7).
 *
 * Recovered:
 *   - Action per type (FUN_0044bfa0): patrol types 0x488fc0 (stand / kneel /
 *     liedown states, FUN_0048a020 / FUN_0048a6a0 / FUN_0048a960), guard /
 *     sniper / priboi 0x48b420 (FUN_0048b4a0), ANYA / EKK 0x489080
 *     (FUN_004892b0 decision), RPG 0x48af60, GUNNER 0x48b6e0; CIVILIAN none.
 *   - Start: register as an attacker in the shared target record of the
 *     first current event with an "other" object; "first sequence" halves p.
 *   - Every combat tick (FUN_00488d40): refresh the target's perception
 *     slot (end when dead / untracked); last known position = the target's
 *     position when visible or when ALERT, WALK, GROUNDIMPACT, DOOR, FENCE,
 *     LADDER, TAKINGDAMAGE, GUNSHOT, GRENADELAND or GUNSHOTMISS events were
 *     processed this frame; detected voice the first time a visible target
 *     is the player; distance; ALERT (0x26, 7 m, other = target) on the
 *     first tick and every 20 ticks.
 *   - Patrol stand: evasive check first (aiEvasiveChoice, r0 every tick),
 *     the running sub-state, else wait for the stand state (cancel an
 *     animation with request 3 = -1) and decide (aiCombatDecision).
 *     Kneel / liedown hold their request; Grenade there only logs; Close,
 *     RePosition, Move and Look stand up first.
 *   - Node search (FUN_00489470): BFS of at most 5 nodes from the node
 *     nearest the target, free cell and line of sight (FUN_00489b00: the
 *     FUN_004c4630 ray with filter 0x537430, which every human answers
 *     "skip" (0x4fa7f0), so no human blocks it; see-through >= 0.79) from node
 *     height + "Node cover midoffset" to the target's aim point; on my route
 *     (stored costs) when the target is visible.
 *   - Follow runs (search redone every tick) and fires while running when
 *     cos > 0.96 to a visible target and fewer than 4 others fire.
 *   - Guard: never moves; not visible: count, give up after the targeting
 *     timeout, turn toward the last known aim point while it is outside the
 *     cone; clip empty: reload; visible: fire if fewer than 4 others fire,
 *     else wait (status 2).
 *   - Fire sequence (FUN_00489de0 / FUN_0048bd00): r drawn first; rounds =
 *     aiRoundsPerSequence; p = aiHitProbability(distance, view length, first
 *     sequence); aim point smoothed by aim precision per tick; aim request
 *     (27); one round counted per clip change; burst-1 shot delay; trigger
 *     (6) only when facing within 2 deg and the delay is over.
 *   - The stop function unregisters from the target record.
 *
 * Inferred: the soldier reserves the occupancy cell nearest to it on its
 * current node when combat starts (RePosition's "reserved cell"); a fire
 * sequence's first aim point is straight ahead at the target's distance;
 * Follow fires with the trigger only (the route steers); the move node's
 * "destination" is cleared on arrival; ANYA / EKK use the stand state
 * without evasive rolls; RPG and GUNNER fight as guards (no stand/kneel
 * switching, no stationary guns in level 1).
 */
import {
  AI_AIM_HEIGHT,
  AI_ALERT,
  AI_CLOSE_COMBAT_DISTANCE,
  AI_COMBAT_DECISION,
  AI_FIRE_WHILE_RUNNING_COS,
  AI_MAX_SHOOTERS,
  AI_TURN_CLAMP,
  aiAimStep,
  aiCombatDecision,
  aiEvasiveChoice,
  aiGraphNodeContains,
  aiGraphRoute,
  aiInViewCone,
  aiRoundsPerSequence,
  aiRulesHitProbability,
  aiShotDelayTicks,
} from "../../loaders";
import type { ActionImpl, ActionRecord, HumanAi } from "./human-ai";
import { BODY, CH } from "./motor";
import type { SharedTarget } from "./world";
import { EV, dist, headingForward, headingRight, type AiEvent, type AiHuman, type V3 } from "./types";

const DEG = Math.PI / 180;
const AIM_TOL = 2 * DEG;
const HEARD = [EV.ALERT, EV.WALK, EV.GROUNDIMPACT, EV.DOOR, EV.FENCE, EV.LADDER, EV.TAKINGDAMAGE, EV.GUNSHOT, EV.GRENADELAND, EV.GUNSHOTMISS];

/** Aim point on a human: last known origin + 0.5 m standing / 0.25 m crouched (FUN_00450150) [recovered]. */
export function aimPointOf(lastKnown: V3, crouched: boolean): V3 {
  return [lastKnown[0], lastKnown[1], lastKnown[2] + (crouched ? AI_AIM_HEIGHT.crouched : AI_AIM_HEIGHT.standing)];
}

// ---------------------------------------------------------------------------
// Fire sequence
// ---------------------------------------------------------------------------

export class FireSequence {
  aim: V3;
  readonly rounds: number;
  fired = 0;
  wait = 0;
  private lastAmmo: number;
  readonly p: number;

  /** FUN_00489de0. */
  constructor(ai: HumanAi, targetAim: V3, firstSequence: boolean) {
    const r = ai.world.rng.float();
    const gun = ai.motor.gun;
    const cfg = ai.cfg;
    const clip = gun ? gun.roundsPerClip : 1;
    const burst = gun ? gun.maxRoundsPerBurst : 1;
    this.rounds = cfg ? aiRoundsPerSequence(cfg, clip, burst, r, Boolean(gun?.grenade)) : 1;
    const d = dist(ai.eye.position, targetAim);
    this.p = gun?.grenade ? 1 : cfg ? aiRulesHitProbability(d, ai.view.primary.length, cfg, firstSequence) : 0.5;
    ai.motor.hitProbability = this.p;
    const f = ai.eye.forward;
    this.aim = [ai.eye.position[0] + f[0] * d, ai.eye.position[1] + f[1] * d, ai.eye.position[2] + f[2] * d];
    this.lastAmmo = ai.motor.ammo;
  }

  /** FUN_0048bd00; true when the sequence is done. */
  tick(ai: HumanAi, targetAim: V3): boolean {
    const cfg = ai.cfg;
    this.aim = aiAimStep(this.aim, targetAim, cfg ? cfg.aimPrecision : 1);
    const m = ai.motor;
    if (m.ammo !== this.lastAmmo) {
      if (m.ammo < this.lastAmmo) {
        this.fired += this.lastAmmo - m.ammo;
        const burst = m.gun ? m.gun.maxRoundsPerBurst : 1;
        if (burst === 1 && cfg) this.wait = aiShotDelayTicks(cfg, burst, ai.world.rng.float());
      }
      this.lastAmmo = m.ammo;
    }
    if (this.fired >= this.rounds || m.clipEmpty) return true;
    ai.motor.hitProbability = this.p;
    ai.ch[CH.AIM] = 1;
    ai.aimPoint = this.aim;
    const facing = ai.turnTo(this.aim, AI_TURN_CLAMP.normal, AIM_TOL);
    if (this.wait > 0) this.wait--;
    else if (facing) ai.ch[CH.FIRE] = 1;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Combat data and common tick
// ---------------------------------------------------------------------------

type Kind = "patrol" | "guard" | "female" | "rpg" | "gunner";
type State = "stand" | "kneel" | "liedown";
type Sub = (ai: HumanAi, c: CombatData) => boolean;

export interface CombatData {
  events: AiEvent[];
  kind: Kind;
  target: number;
  record: SharedTarget | null;
  first: boolean;
  distance: number;
  ticks: number;
  state: State;
  sub: Sub | null;
  subName: string;
  fire: FireSequence | null;
  memory: { destinationNode: number; notVisibleCount: number };
  evasive: { nextAllowed: number; lastRollDir: number };
  visible: boolean;
  guardCount: number;
  /** Motor action seen by a grenade / close-combat sub-state. */
  seen: boolean;
  rollDir: number;
}

function kindOf(aiType: string): Kind | null {
  if (aiType === "AITYPE_CIVILIAN") return null;
  if (aiType === "AITYPE_RPG") return "rpg";
  if (aiType === "AITYPE_GUNNER") return "gunner";
  if (aiType === "AITYPE_ANYA" || aiType === "AITYPE_EKK") return "female";
  if (aiType.includes("_PATROL_")) return "patrol";
  return "guard"; // SNIPER, PRIBOI, *_GUARD_*
}

function setStatus(ai: HumanAi, c: CombatData, status: number): void {
  c.record?.attackers.set(ai, status);
}

function targetHuman(ai: HumanAi, c: CombatData): AiHuman | undefined {
  return ai.world.humans.get(c.target);
}

function lastAim(ai: HumanAi, c: CombatData): V3 {
  const h = targetHuman(ai, c);
  return aimPointOf(c.record ? c.record.lastKnown : h ? h.origin() : ai.pos, h ? h.crouched() : false);
}

/** FUN_00489470 node search near the target. */
function findNode(ai: HumanAi, c: CombatData, onRoute: boolean): number | null {
  const g = ai.graphInfo;
  if (!g || !c.record) return null;
  const aim = lastAim(ai, c);
  const start = ai.closestNode(c.record.lastKnown);
  if (start < 0) return null;
  const targetNode = start;
  const me = ai.currentNode;
  const cap = g.graph;
  const costMeTarget = aiGraphRoute(cap, me, targetNode)?.cost ?? -1;
  const seen = new Set<number>([start]);
  const queue = [start];
  let examined = 0;
  while (queue.length && examined < 5) {
    const n = queue.shift()!;
    examined++;
    const w = ai.nodeWorld(n);
    if (w && ai.freeCell(n)) {
      const from: V3 = [w[0], w[1], w[2] + g.midOffset * 4096];
      if (ai.world.hooks.lineOfSight(from, aim)) {
        let ok = true;
        if (onRoute) {
          const a = aiGraphRoute(cap, n, me)?.cost;
          const b = aiGraphRoute(cap, n, targetNode)?.cost;
          ok = n === me || (a !== undefined && b !== undefined && costMeTarget >= a + b);
        }
        if (ok) return n;
      }
    }
    for (const m of cap.nodeById.get(n)?.neighbours ?? []) {
      if (!seen.has(m)) {
        seen.add(m);
        queue.push(m);
      }
    }
  }
  return null;
}

/** FUN_004514f0: the point 3 m to the left (bit 0) / right (bit 1) lies inside the current node square. */
function freeSides(ai: HumanAi): number {
  const g = ai.graphInfo;
  const node = g?.graph.nodeById.get(ai.currentNode);
  if (!g || !node) return 0;
  const r = headingRight(ai.motor.yaw);
  const L: V3 = [ai.pos[0] - r[0] * 12288, ai.pos[1] - r[1] * 12288, ai.pos[2]];
  const R: V3 = [ai.pos[0] + r[0] * 12288, ai.pos[1] + r[1] * 12288, ai.pos[2]];
  return (aiGraphNodeContains(node, g.position, L, 0, false) ? 1 : 0) | (aiGraphNodeContains(node, g.position, R, 0, false) ? 2 : 0);
}

function startCombat(kind: Kind): ActionImpl<CombatData> {
  return {
    name: `Combat(${kind})`,
    start(ai, rec) {
      const c = rec.data;
      c.kind = kind;
      const ev = c.events.find((e) => e.other !== null);
      c.target = ev ? ev.other! : -1;
      c.record = c.target >= 0 ? ai.world.targetRecord(c.target) : null;
      if (c.record) {
        c.record.attackers.set(ai, -1);
        ai.target = c.record;
      }
      c.first = true;
      c.distance = 0;
      c.ticks = 0;
      const stance = ai.motor.stance;
      c.state = kind === "patrol" ? (stance === "kneel" ? "kneel" : stance === "prone" ? "liedown" : "stand") : "stand";
      c.sub = null;
      c.subName = "";
      c.fire = null;
      c.memory = { destinationNode: -1, notVisibleCount: 0 };
      c.evasive = { nextAllowed: -1, lastRollDir: 0 };
      c.visible = false;
      c.guardCount = 0;
      c.seen = false;
      c.rollDir = 0;
      if (ai.currentNode >= 0 && !ai.reservation) ai.reserveCell(ai.currentNode, ai.pos);
    },
    update(ai, rec) {
      const c = rec.data;
      if (!commonTick(ai, rec)) return;
      switch (c.kind) {
        case "patrol":
          patrolTick(ai, rec, false);
          break;
        case "female":
          patrolTick(ai, rec, true);
          break;
        default:
          guardTick(ai, rec);
          break;
      }
    },
    stop(ai, rec) {
      const c = rec.data;
      ai.route = [];
      if (c.record) {
        ai.world.releaseTarget(c.record, ai);
        if (ai.target === c.record) ai.target = null;
      }
    },
  };
}

/** FUN_00488d40; false when the action ended. */
function commonTick(ai: HumanAi, rec: ActionRecord<CombatData>): boolean {
  const c = rec.data;
  const h = targetHuman(ai, c);
  const slot = h ? ai.slots.get(h.key) : undefined;
  if (!h || !slot || h.dead() || !c.record) {
    ai.endAction(rec);
    return false;
  }
  c.visible = slot.visible;
  const heard = HEARD.some((t) => ai.counts[t] > 0);
  if (c.visible || heard) c.record.lastKnown = h.origin();
  if (c.visible && h.isPlayer && !c.record.voiced) {
    c.record.voiced = true;
    ai.world.hooks.detected?.(ai);
  }
  c.distance = dist(c.record.lastKnown, ai.pos);
  if (c.ticks % AI_ALERT.periodTicks === 0) {
    ai.world.broadcast({
      type: EV.ALERT, team: ai.team, flags: AI_ALERT.flags, range: AI_ALERT.radius,
      position: [ai.pos[0], ai.pos[1], ai.pos[2]], source: ai.key, other: c.target,
    });
  }
  c.ticks++;
  return true;
}

function newFire(ai: HumanAi, c: CombatData): FireSequence {
  const f = new FireSequence(ai, lastAim(ai, c), c.first);
  c.first = false;
  return f;
}

// ---------------------------------------------------------------------------
// Sub-states (FUN_0048ab80, FUN_0048ac80, FUN_0048aed0, 0x48bf30, FUN_0048c010, FUN_0048bfd0, FUN_0048bcd0)
// ---------------------------------------------------------------------------

const subFire: Sub = (ai, c) => {
  if (!c.fire) c.fire = newFire(ai, c);
  const done = c.fire.tick(ai, lastAim(ai, c));
  if (done) c.fire = null;
  return done;
};

const subReload: Sub = (ai) => {
  if (!ai.motor.clipEmpty) return true;
  ai.ch[CH.RELOAD] = 1;
  return false;
};

const subLook: Sub = (ai, c) => {
  ai.ch[CH.CH26] = 1;
  return ai.turnTo(lastAim(ai, c), AI_TURN_CLAMP.normal, AIM_TOL);
};

const subReposition: Sub = (ai, c) => {
  ai.ch[CH.CH26] = 1;
  if (!ai.route.length) {
    const r = ai.reservation;
    const p = r ? ai.cellPoint(r.node, r.cx, r.cy) : null;
    if (!r || !p || !ai.routeTo(r.node, p)) return true;
  }
  ai.walkMode();
  const done = ai.followRoute();
  if (done) c.memory.destinationNode = -1;
  return done;
};

const subFollow: Sub = (ai, c) => {
  ai.ch[CH.CH26] = 1;
  const node = findNode(ai, c, c.visible);
  if (node !== null && node !== c.memory.destinationNode) {
    c.memory.destinationNode = node;
    ai.route = [];
  }
  const dest = c.memory.destinationNode;
  if (dest < 0) return true;
  if (!ai.route.length) {
    const cell = ai.reserveCell(dest, undefined, true) ?? ai.nodeWorld(dest) ?? undefined;
    if (!ai.routeTo(dest, cell)) {
      c.memory.destinationNode = -1;
      return true;
    }
  }
  ai.runMode();
  const arrived = ai.followRoute();
  // Fire while running at a visible target in front (cos > 0.96), shooter limit 4.
  const h = targetHuman(ai, c);
  if (!arrived && c.visible && h && c.record && c.record.firing(ai) < AI_MAX_SHOOTERS.guardGunnerFollow && !ai.motor.clipEmpty) {
    const o = h.origin();
    const f = headingForward(ai.motor.yaw);
    const dx = o[0] - ai.pos[0];
    const dy = o[1] - ai.pos[1];
    const len = Math.hypot(dx, dy) || 1;
    if ((dx * f[0] + dy * f[1]) / len > AI_FIRE_WHILE_RUNNING_COS) {
      if (!c.fire) c.fire = newFire(ai, c);
      ai.motor.hitProbability = c.fire.p;
      ai.aimPoint = lastAim(ai, c);
      ai.ch[CH.FIRE] = 1;
    }
  }
  if (arrived) {
    c.fire = null;
    c.memory.destinationNode = -1;
  }
  return arrived;
};

function subMotorAction(channel: number, action: number): Sub {
  return (ai, c) => {
    if (ai.motor.state === action) c.seen = true;
    else if (c.seen) return true;
    if (channel === CH.GRENADE && ai.motor.grenades <= 0 && !c.seen) return true;
    ai.ch[channel] = 1;
    return false;
  };
}
const subGrenade = subMotorAction(CH.GRENADE, 8);
const subClose = subMotorAction(CH.CLOSE_COMBAT, 9);

const subRoll: Sub = (ai, c) => {
  if (ai.motor.state === BODY.KNEEL) {
    c.state = "kneel";
    return true;
  }
  ai.ch[c.rollDir === 1 ? CH.LEFT : CH.RIGHT] = 1;
  return false;
};

function setSub(c: CombatData, sub: Sub | null, name: string): void {
  c.sub = sub;
  c.subName = name;
  c.seen = false;
  if (sub !== subFire) c.fire = null;
}

// ---------------------------------------------------------------------------
// Patrol types and ANYA / EKK (FUN_0048a020, FUN_0048a6a0, FUN_0048a960, FUN_004890e0)
// ---------------------------------------------------------------------------

function holdStance(ai: HumanAi, c: CombatData): void {
  if (c.state === "kneel") ai.ch[CH.KNEEL] = 1;
  else if (c.state === "liedown") ai.ch[CH.LIEDOWN] = 1;
}

function patrolTick(ai: HumanAi, rec: ActionRecord<CombatData>, female: boolean): void {
  const c = rec.data;
  const cfg = ai.cfg;
  holdStance(ai, c);
  // 1. Evasive check first; it can interrupt a running sub-state.
  if (!female && cfg) {
    const choice = aiEvasiveChoice({
      rand: () => ai.world.rng.float(),
      now: ai.now,
      state: c.evasive,
      threatenedThisFrame: ai.counts[EV.GUNSHOTMISS] > 0 || ai.counts[EV.GUNSHOT] > 0 || ai.counts[EV.TAKINGDAMAGE] > 0,
      onStairNode: ai.onStairNode(),
      distance: c.distance,
      freeSides: freeSides(ai),
      cfg,
    });
    if (choice === 0 && c.state !== "liedown") {
      setStatus(ai, c, -1);
      setSub(c, null, "");
      c.state = "liedown";
      holdStance(ai, c);
      ai.ch[CH.KNEEL] = 0;
    } else if ((choice === 1 || choice === 2) && c.state !== "liedown") {
      setStatus(ai, c, -1);
      c.rollDir = choice;
      c.evasive.lastRollDir = choice === 1 ? 1 : -1;
      setSub(c, subRoll, "Roll");
    }
  }
  // 2. The running sub-state.
  if (c.sub) {
    holdStance(ai, c);
    if (c.sub(ai, c)) setSub(c, null, "");
    return;
  }
  // 3. Wait for the state's body pose (an animation is cancelled), then decide.
  const want = c.state === "stand" ? BODY.STAND : c.state === "kneel" ? BODY.KNEEL : BODY.LIEDOWN;
  if (ai.motor.state !== want) {
    if (ai.motor.state === BODY.ANIMATION) ai.ch[CH.ANIMATION] = -1;
    return;
  }
  if (!cfg) return;
  const result = aiCombatDecision({
    cfg,
    rand: () => ai.world.rng.float(),
    memory: c.memory,
    currentNode: ai.currentNode,
    onCurrentNode: ai.onNode(ai.currentNode),
    targetVisible: c.visible,
    distance: c.distance,
    clipLoaded: !ai.motor.clipEmpty,
    hasGrenade: ai.motor.grenades > 0,
    shooters: c.record ? c.record.firing(ai) : 0,
    closeCombatDistance: female ? 0 : AI_CLOSE_COMBAT_DISTANCE,
    findNode: (onRoute) => findNode(ai, c, onRoute),
    female,
  });
  setStatus(ai, c, result.status);
  const D = AI_COMBAT_DECISION;
  if (c.state !== "stand" && (result.code === D.CLOSE || result.code === D.REPOSITION || result.code === D.MOVE || result.code === D.LOOK)) {
    // Kneel / liedown: stand up first.
    c.state = "stand";
    ai.ch[CH.KNEEL] = 0;
    ai.ch[CH.LIEDOWN] = 0;
    return;
  }
  switch (result.code) {
    case D.REPOSITION: setSub(c, subReposition, "RePosition"); break;
    case D.MOVE: setSub(c, subFollow, "Follow"); break;
    case D.LOOK: setSub(c, subLook, "LookForTarget"); break;
    case D.GIVE_UP: ai.endAction(rec); return;
    case D.CLOSE: setSub(c, subClose, "Close"); break;
    case D.RELOAD: setSub(c, subReload, "Reload"); break;
    case D.GRENADE:
      if (c.state === "stand") setSub(c, subGrenade, "Grenade");
      else ai.world.hooks.log?.(c.state === "kneel" ? "Kneel throw grenade" : "Liedown throw grenade");
      break;
    case D.FIRE: setSub(c, subFire, "Fire"); break;
    default: break;
  }
  const next = c.sub as Sub | null;
  if (next) {
    holdStance(ai, c);
    if (next(ai, c)) setSub(c, null, "");
  }
}

// ---------------------------------------------------------------------------
// Guard, sniper, priboi (FUN_0048b4a0); RPG and GUNNER as guards (inferred)
// ---------------------------------------------------------------------------

function guardTick(ai: HumanAi, rec: ActionRecord<CombatData>): void {
  const c = rec.data;
  const cfg = ai.cfg;
  if (c.sub) {
    if (c.sub(ai, c)) setSub(c, null, "");
    return;
  }
  if (!c.visible) {
    setStatus(ai, c, -1);
    c.guardCount++;
    if (cfg && c.guardCount > cfg.targetingTimeoutTicks) {
      ai.endAction(rec);
      return;
    }
    const aim = lastAim(ai, c);
    if (!aiInViewCone(ai.eye, aim, ai.view, ai.alarmFlag)) ai.turnTo(aim, AI_TURN_CLAMP.normal, AIM_TOL);
    return;
  }
  c.guardCount = 0;
  if (ai.motor.clipEmpty) {
    setStatus(ai, c, 1);
    setSub(c, subReload, "Reload");
  } else if (!c.record || c.record.firing(ai) < AI_MAX_SHOOTERS.guardGunnerFollow) {
    setStatus(ai, c, 0);
    setSub(c, subFire, "Fire");
  } else {
    setStatus(ai, c, 2);
    ai.turnTo(lastAim(ai, c), AI_TURN_CLAMP.normal, AIM_TOL);
    return;
  }
  const next = c.sub as Sub | null;
  if (next && next(ai, c)) setSub(c, null, "");
}

const combatByKind = new Map<Kind, ActionImpl<CombatData>>();

/** AIAction_Combat's action for an AI type name (FUN_0044bfa0); null for CIVILIAN. */
export function combatActionFor(aiType: string): ActionImpl<unknown> | null {
  const kind = kindOf(aiType);
  if (!kind) return null;
  let impl = combatByKind.get(kind);
  if (!impl) {
    impl = startCombat(kind);
    combatByKind.set(kind, impl);
  }
  return impl as ActionImpl<unknown>;
}

// ---------------------------------------------------------------------------
// FireAtNode / FireAtTask (0x48d040 / 0x48d180)
// ---------------------------------------------------------------------------

interface FireAtData {
  target: number;
  task: boolean;
  t0: number;
  t1: number;
  reload: boolean;
  until?: number;
  pause?: number;
  seq?: FireSequence | null;
  point?: V3 | null;
}

export const fireAtAction: ActionImpl<FireAtData> = {
  name: "FireAt",
  start(ai, rec) {
    const d = rec.data;
    d.until = ai.now + d.t0;
    d.pause = 0;
    d.seq = null;
    d.point = d.task ? ai.world.hooks.taskPosition(d.target) : ai.nodeWorld(d.target);
  },
  update(ai, rec) {
    const d = rec.data;
    if (ai.now >= d.until! || !d.point) {
      ai.endAction(rec);
      return;
    }
    if (ai.motor.clipEmpty) {
      if (d.reload) ai.ch[CH.RELOAD] = 1;
      else ai.motor.refill();
      return;
    }
    if (d.pause! > 0) {
      d.pause!--;
      return;
    }
    if (!d.seq) d.seq = new FireSequence(ai, d.point, false);
    if (d.seq.tick(ai, d.point)) {
      d.seq = null;
      d.pause = d.t1;
    }
  },
};
