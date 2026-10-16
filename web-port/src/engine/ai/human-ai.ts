/**
 * One soldier's HumanAI task (0x3ec8 bytes in igi.exe): the script host,
 * event queues and priority dispatch, the action stack and the per-frame
 * driver FUN_0044e260, plus the movement helpers the actions share.
 *
 * Recovered (docs/ai.md 1, docs/qvm-vm.md 6-7, and re-read from igi.exe for
 * this port):
 *   - Frame order (FUN_0044e260): clear the 40 channels; return when there is
 *     no script or no graph; first update: run CREATE (priority -1) and go to
 *     dispatch; on death (once): end every action, run DEAD with DEAD's
 *     priority index; while alive: perception, ENEMYDETECTION for every
 *     visible alive enemy and FRIENDLYDETECTION for every visible dead
 *     friend (every frame), ALARMON while the AlarmControl's isAlarm
 *     (+0x2a1) is set else ALARMOFF while its previous-tick copy (+0x2a2) is
 *     set, the animation interval (ANIMATION, countdown redrawn
 *     min + rand(randTicks)); target-record bookkeeping; alarm flag
 *     H+0x3ab7 = ALARMON queued or target still perceived; IDLE when the
 *     stack is empty; dispatch (FUN_0044eb80); run the top action
 *     (FUN_0044ecf0).
 *   - Dispatch (FUN_0044eb80): limit = top action's priority index (24 with
 *     an empty stack); for every list entry i in order: when i < limit, the
 *     queue is non-empty and no run produced an action yet, run the script
 *     with that event (FUN_0044eac0); every visited type's queue is then
 *     emptied and its count kept in H+0x87c[type].
 *   - One run (FUN_0044eac0): pending actions are committed after the run
 *     even when the run failed; one action: pop the non-PUSHABLE actions on
 *     top, push, draw the reaction delay from the level RNG, call start
 *     (FUN_0044fc40); several: same pop, then push them from the last queued
 *     to the first (the first ends on top), all with the last one's flags,
 *     each with a delay draw and its start call (FUN_0044fce0).
 *   - Running (FUN_0044ecf0): the topmost record with an update function
 *     runs; every start installs one, so the delay never matters.
 *   - Ending (FUN_0044fdc0): stop function, unlink.
 *   - Receive filter FUN_0044eee0 = aiEventAccepted (ai-rules.ts).
 *   - Host functions: docs/qvm-vm.md section 7 (handlers 0x44bf20..0x44dc90).
 *
 * Inferred: the listener's position is the soldier's feet (H+0x20 = soldier
 * position lowered by bone 0's offset); the eye is the pelvis + 0.69 m
 * standing / + 0.35 m otherwise (the same offsets as the camera / vision
 * target, FUN_00464490; the body eye offset +0x2ac was not decoded); a
 * queue's head (E) is the first event received in the frame.
 */
import {
  AI_EMPTY_STACK_PRIORITY,
  AI_TURN_CLAMP,
  AI_WAYPOINT_REACHED,
  QVM_AI_TYPES,
  QVM_AI_TYPE_SCRIPT,
  QVM_CONSTANTS,
  QVM_HOST_FUNCTIONS,
  QvmError,
  aiApplyViewCall,
  aiDefaultView,
  aiEventAccepted,
  aiGraphClosestNode,
  aiGraphNodeContains,
  aiGraphNodeWorld,
  aiGraphWaypoints,
  aiInViewCone,
  aiNewPerceptionSlot,
  aiPerceptionStep,
  aiReactionDelayTicks,
  aiSteerValue,
  runQvm,
  type AiEyeFrame,
  type AiNodeOccupancy,
  type AiPerceptionSlot,
  type AiRulesCombatConfig,
  type AiRulesView,
  type QvmCallContext,
  type QvmHost,
  type QvmProgram,
  type QvmRuntimeValue,
} from "../../loaders";
import { ACTIONS, combatActionFor } from "./actions";
import type { AiExtraConfig, AiGraphInfo } from "./data";
import { BODY, CH, type SoldierMotor } from "./motor";
import type { AiWorld, SharedTarget } from "./world";
import {
  EV, EVENT_TYPES, UNITS, dist, elevation, headingForward, headingRight, yawErrorRight,
  type AiEvent, type AiHuman, type RV3, type V3,
} from "./types";

export interface ActionImpl<D = unknown> {
  readonly name: string;
  start?(ai: HumanAi, rec: ActionRecord<D>): void;
  update(ai: HumanAi, rec: ActionRecord<D>): void;
  stop?(ai: HumanAi, rec: ActionRecord<D>): void;
}

/** Action record (0x30 bytes, FUN_0044fbe0) [recovered]. */
export interface ActionRecord<D = unknown> {
  impl: ActionImpl<D>;
  data: D;
  /** AIACTIONFLAG (bit 0 PUSHABLE). */
  flags: number;
  /** Priority-list index of the event that queued it (-1 by CREATE). */
  priority: number;
  /** Reaction delay (no effect, docs/ai.md 1). */
  delay: number;
  ended: boolean;
}

interface Pending {
  impl: ActionImpl<unknown>;
  data: unknown;
  flags: number;
}

interface RunContext {
  type: number;
  events: AiEvent[];
  priority: number;
  pending: Pending[];
}

export interface HumanAiSpec {
  /** HumanSoldier task id. */
  taskId: number;
  /** HumanAI task id (mission script), or null. */
  aiTaskId: number | null;
  aiType: string | null;
  graphId: number | null;
  team: number;
}

const EYE_STAND = 2826.24;
const EYE_LOW = 1433.6;
const DEG = Math.PI / 180;

export class HumanAi {
  readonly key: number;
  readonly team: number;
  readonly aiType: number;
  readonly aiTypeName: string;
  readonly program: QvmProgram | null;
  readonly common: QvmProgram | null;
  readonly graphInfo: AiGraphInfo | null;
  readonly cfg: AiRulesCombatConfig | null;
  readonly extra: AiExtraConfig | null;
  /** Phase dealt by the AI world at construction (used when the task runtime has none for this HumanAI). */
  private readonly fallbackPhase: number;
  private resolvedPhase: number | undefined;
  /** Has a script and a graph (otherwise the original AI does nothing). */
  readonly active: boolean;

  /** The 40 input channels (H+0x3c6c), cleared every frame. */
  readonly ch = new Float32Array(40);
  readonly priorities: number[] = [];
  private readonly registered = new Set<number>();
  readonly queues: AiEvent[][] = Array.from({ length: EVENT_TYPES }, () => []);
  /** Events of each type processed this frame (H+0x87c). */
  readonly counts = new Int32Array(EVENT_TYPES);
  /** Action stack, index 0 = top. */
  readonly stack: ActionRecord[] = [];
  readonly intSlots = new Map<number, number>();
  readonly realSlots = new Map<number, number>();
  readonly view: AiRulesView = aiDefaultView();
  invulnerable = false;
  /** H+0x3ab9 (SetInstantDeath(x) stores x == 0): removes the x100 head multiplier. */
  headshotProof = false;
  deathAnimation = -1;
  alarmTriggerId = -1;
  alarmControlId = -1;
  alarmAccess = 0;
  gunnerId = -1;
  animMinTicks = 0;
  animRandTicks = 0;
  animCountdown = -1;
  readonly animEntries: Array<{ anim: number; weight: number }> = [];

  readonly slots = new Map<number, AiPerceptionSlot>();
  /** H+0x3ab7: alarm lengths for vision / event cones. */
  alarmFlag = false;
  /** H+0x3aa8: shared target record held by combat. */
  target: SharedTarget | null = null;
  created = false;
  deadHandled = false;

  /** Feet position (H+0x20), IGI units, refreshed every frame. */
  pos: V3 = [0, 0, 0];
  readonly eye: AiEyeFrame = { position: [0, 0, 0], right: [1, 0, 0], forward: [0, 1, 0], up: [0, 0, 1] };

  /** Current graph node (H+0x3e24), -1 = none. */
  currentNode = -1;
  /** FUN_00460fd0's route height segment: the previous (+0x808) and next (+0x820) waypoint, IGI units; null = still zero. */
  private heightFrom: V3 | null = null;
  private heightTo: V3 | null = null;
  route: Array<{ point: [number, number, number]; node: number; door: boolean }> = [];
  reservation: { node: number; cx: number; cy: number } | null = null;

  /** Point the gun is aimed at this frame (fire sequence / follow), IGI units; null = straight ahead. */
  aimPoint: V3 | null = null;
  /** Last run's error (diagnostics). */
  lastError: string | null = null;
  scriptRuns = 0;
  private run: RunContext | null = null;
  private readonly host: QvmHost;

  constructor(
    readonly world: AiWorld,
    readonly self: AiHuman,
    readonly motor: SoldierMotor,
    readonly spec: HumanAiSpec,
  ) {
    this.key = self.key;
    this.team = spec.team;
    const typeIndex = spec.aiType ? QVM_AI_TYPES.indexOf(spec.aiType) : -1;
    this.aiType = typeIndex;
    this.aiTypeName = spec.aiType ?? "";
    const data = world.data;
    this.program = spec.aiTaskId !== null ? data.mission.get(spec.aiTaskId) ?? null : null;
    const script = typeIndex >= 0 ? scriptName(typeIndex) : null;
    this.common = script ? data.common.get(script) ?? null : null;
    this.graphInfo = spec.graphId !== null ? data.graphs.get(spec.graphId) ?? null : null;
    this.cfg = spec.aiType ? data.combat.get(spec.aiType) ?? null : null;
    this.extra = spec.aiType ? data.extra.get(spec.aiType) ?? null : null;
    // A HumanAI without a mission script is not created by FUN_0044f3a0's
    // loader; the port falls back to the type's common script (inferred).
    this.active = spec.aiTaskId !== null && (this.program !== null || this.common !== null) && this.graphInfo !== null;
    this.fallbackPhase = world.takePhase();
    this.host = this.makeHost();
    this.refreshFrame();
    if (this.graphInfo) {
      const c = aiGraphClosestNode(this.graphInfo.graph, this.graphInfo.position, this.pos);
      this.currentNode = c ? c.node.id : -1;
    }
  }

  get now(): number {
    return this.world.tick;
  }

  /**
   * Perception phase (detector +0xc, FUN_00487ae0 from FUN_0044f3a0): the
   * process-wide counter DAT_005c4a48 as the level load hands it out (lenses
   * at create, then HumanAI / Car / Heli / AIStationaryGunHolder in compile
   * order: hooks.perceptionPhase), read once the runtime knows it; else the
   * AI world's own round-robin.
   */
  get phase(): number {
    if (this.resolvedPhase !== undefined) return this.resolvedPhase;
    const p = this.spec.aiTaskId !== null ? this.world.hooks.perceptionPhase?.(this.spec.aiTaskId) : undefined;
    if (p === undefined) return this.fallbackPhase;
    this.resolvedPhase = p & 3;
    return this.resolvedPhase;
  }

  get dead(): boolean {
    return this.self.dead();
  }

  get top(): ActionRecord | null {
    return this.stack[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Frame (FUN_0044e260)
  // -------------------------------------------------------------------------

  /** Positions and the eye frame (step 1). */
  refreshFrame(): void {
    const f = this.self.feet();
    this.pos[0] = f[0];
    this.pos[1] = f[1];
    this.pos[2] = f[2];
    const o = this.self.origin();
    const yaw = this.motor.yaw;
    const p = this.motor.pitch;
    // The eye offset follows the crouch flag (human+0x33d, set by each state's entry), as the exe reads it.
    const h = this.motor.crouched ? EYE_LOW : EYE_STAND;
    const e = this.eye as { position: V3; right: V3; forward: V3; up: V3 };
    e.position = [o[0], o[1], o[2] + h];
    const r = headingRight(yaw);
    const fw = headingForward(yaw);
    const cp = Math.cos(p);
    const sp = Math.sin(p);
    e.right = r;
    e.forward = [fw[0] * cp, fw[1] * cp, sp];
    // up = right x forward
    e.up = [r[1] * e.forward[2] - r[2] * e.forward[1], r[2] * e.forward[0] - r[0] * e.forward[2], r[0] * e.forward[1] - r[1] * e.forward[0]];
  }

  frame(): void {
    this.ch.fill(0);
    this.aimPoint = null;
    this.refreshFrame();
    if (!this.active) return;
    if (!this.created) {
      this.created = true;
      this.queues[EV.CREATE] = [this.selfEvent(EV.CREATE)];
      this.runScript(EV.CREATE, -1);
      this.queues[EV.CREATE] = [];
    } else {
      const dead = this.dead;
      if (dead && !this.deadHandled) {
        while (this.stack.length) this.endAction(this.stack[0]);
        const priority = this.priorities.indexOf(EV.DEAD);
        this.queues[EV.DEAD] = [this.selfEvent(EV.DEAD)];
        this.runScript(EV.DEAD, priority);
        this.queues[EV.DEAD] = [];
        this.deadHandled = true;
      }
      let alarm = false;
      if (!dead) {
        this.perceive();
        for (const [key, slot] of this.slots) {
          if (!slot.visible) continue;
          const h = this.world.humans.get(key);
          if (!h) continue;
          const isDead = h.dead();
          if (h.team !== this.team && !isDead) this.receive(this.detection(EV.ENEMYDETECTION, h));
          else if (h.team === this.team && isDead) this.receive(this.detection(EV.FRIENDLYDETECTION, h));
        }
        if (this.alarmControlId !== -1) {
          const name = this.taskName(this.alarmControlId);
          if (name === null) {
            this.world.hooks.log?.(`HumanAI ${this.spec.aiTaskId}: AlarmControl ${this.alarmControlId} not found`);
            this.alarmControlId = -1;
          } else if (this.world.alarmIsOn(this.alarmControlId)) {
            this.receive(this.selfEvent(EV.ALARMON));
            alarm = true;
          } else if (this.world.alarmWasOn(this.alarmControlId)) {
            this.receive(this.selfEvent(EV.ALARMOFF));
          }
        }
        if (this.animCountdown >= 0 && this.animEntries.length) {
          if (this.animCountdown === 0) {
            this.receive(this.selfEvent(EV.ANIMATION));
            this.animCountdown = (this.animRandTicks > 0 ? this.world.rng.int(this.animRandTicks) : 0) + this.animMinTicks;
          } else {
            this.animCountdown--;
          }
        }
      }
      // Target record bookkeeping (step 6).
      if (this.target) {
        const h = this.world.humans.get(this.target.key);
        if (h && this.slots.has(h.key)) alarm = true;
        else {
          this.world.releaseTarget(this.target, this);
          this.target = null;
        }
      }
      this.alarmFlag = alarm;
      if (!this.stack.length) {
        const idle = this.selfEvent(EV.IDLE);
        idle.team = -1;
        this.receive(idle);
      }
    }
    this.dispatch();
    this.runTop();
  }

  private selfEvent(type: number): AiEvent {
    return { type, team: this.team, flags: 0, range: -1, position: [this.pos[0], this.pos[1], this.pos[2]], source: null, other: null };
  }

  private detection(type: number, h: AiHuman): AiEvent {
    return { type, team: h.team, flags: 0, range: -1, position: h.origin(), source: h.key, other: h.key };
  }

  /** "<Type>_<id>" of a level task, or null. */
  taskName(id: number): string | null {
    const t = this.world.data.taskById.get(id);
    return t ? `${t.type}_${id}` : null;
  }

  // -------------------------------------------------------------------------
  // Perception (FUN_00487b70 / FUN_00487cf0, docs/ai.md 2.2)
  // -------------------------------------------------------------------------

  targetPoint(h: AiHuman): V3 {
    const o = h.origin();
    return [o[0], o[1], o[2] + (h.crouched() ? 1433.6 : 2826.24)];
  }

  /**
   * FUN_00487b70 [recovered]: nothing at all unless (application tick & 3) ==
   * phase; then, for each registry object in create order (world.humans is
   * kept in task-tree order), the slot bookkeeping and FUN_00487cf0 together:
   * the soldier itself and objects that are out of the world or fail the team
   * rule (flags 6: alive humans of another team, dead humans of the own team)
   * lose their slot; a newly qualifying one gets a fresh slot at the list's
   * tail (FUN_00487920); every tracked one then runs its cone / sight step.
   * Between phase ticks the slots (and so the target-record test of step 6)
   * keep the last run's state.
   */
  private perceive(): void {
    if ((this.world.appTick & 3) !== this.phase) return;
    for (const h of this.world.humans.values()) {
      if (h.key === this.key) continue;
      const tracked = h.present() && (h.team !== this.team ? !h.dead() : h.dead());
      let slot = this.slots.get(h.key);
      if (!tracked) {
        if (slot) this.slots.delete(h.key);
        continue;
      }
      if (!slot) {
        slot = aiNewPerceptionSlot();
        this.slots.set(h.key, slot);
      }
      let point: V3 | null = null;
      const pt = () => (point ??= this.targetPoint(h));
      aiPerceptionStep(
        slot,
        () => aiInViewCone(this.eye, pt(), this.view, this.alarmFlag),
        () => this.world.hooks.lineOfSight(this.eye.position, pt(), { self: this.key, target: h.key }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /** FUN_0044eee0 receive filter, then queue (FUN_0044f2f0). */
  receive(ev: AiEvent): void {
    if (!this.active) return;
    const other = ev.other !== null ? this.world.humans.get(ev.other) : undefined;
    const accepted = aiEventAccepted(
      { self: this.key, team: this.team, position: this.pos, dead: this.dead, created: this.created, registered: this.registered },
      ev,
      (p) => aiInViewCone(this.eye, p, this.view, this.alarmFlag, true),
      ev.other === null ? null : { isHuman: other !== undefined, dead: other ? other.dead() : false },
    );
    if (accepted) this.queues[ev.type].push(ev);
  }

  /** FUN_0044eb80. */
  private dispatch(): void {
    const top = this.top;
    const limit = top ? top.priority : AI_EMPTY_STACK_PRIORITY;
    let produced = false;
    for (let i = 0; i < this.priorities.length; i++) {
      const type = this.priorities[i];
      if (i < limit && this.queues[type].length && !produced) produced = this.runScript(type, i);
      this.counts[type] = this.queues[type].length;
      this.queues[type] = [];
    }
  }

  /** FUN_0044ecf0. */
  private runTop(): void {
    const top = this.top;
    if (top) top.impl.update(this, top);
  }

  /** FUN_0044eac0: one script run with event type `type` current; true when it produced an action. */
  runScript(type: number, priority: number): boolean {
    const program = this.program ?? this.common;
    if (!program) return false;
    const ctx: RunContext = { type, events: this.queues[type], priority, pending: [] };
    const saved = this.run;
    this.run = ctx;
    this.scriptRuns++;
    try {
      runQvm(program, this.host, { maxSteps: 200_000 });
    } catch (error) {
      this.reportError(error);
    } finally {
      this.run = saved;
    }
    const pending = ctx.pending;
    if (pending.length > 1) this.commitSequence(pending, priority);
    else if (pending.length === 1) this.commitSingle(pending[0], priority);
    return pending.length > 0;
  }

  private reportError(error: unknown): void {
    const message = error instanceof QvmError ? error.message : String(error);
    if (this.lastError !== message) this.world.hooks.log?.(`Error in QVM program (HumanAI ${this.spec.aiTaskId}): ${message}`);
    this.lastError = message;
  }

  private popNonPushable(): void {
    while (this.stack.length && !(this.stack[0].flags & 1)) this.endAction(this.stack[0]);
  }

  /** FUN_0044fc40. */
  private commitSingle(p: Pending, priority: number): void {
    this.popNonPushable();
    const rec: ActionRecord = { impl: p.impl, data: p.data, flags: p.flags, priority, delay: 0, ended: false };
    this.stack.unshift(rec);
    rec.delay = aiReactionDelayTicks(this.world.rng.float());
    rec.impl.start?.(this, rec);
  }

  /** FUN_0044fce0. */
  private commitSequence(list: Pending[], priority: number): void {
    this.popNonPushable();
    const flags = list[list.length - 1].flags;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      const rec: ActionRecord = { impl: p.impl, data: p.data, flags, priority, delay: 0, ended: false };
      this.stack.unshift(rec);
      rec.delay = aiReactionDelayTicks(this.world.rng.float());
      rec.impl.start?.(this, rec);
    }
  }

  /** FUN_0044fdc0. */
  endAction(rec: ActionRecord): void {
    if (rec.ended) return;
    rec.ended = true;
    rec.impl.stop?.(this, rec);
    const i = this.stack.indexOf(rec);
    if (i >= 0) this.stack.splice(i, 1);
  }

  /** Post an event to this soldier directly (FUN_0044fb20). */
  post(ev: AiEvent): void {
    this.receive(ev);
  }

  // -------------------------------------------------------------------------
  // Host (FUN_0044bae0 registrations)
  // -------------------------------------------------------------------------

  private get E(): AiEvent | null {
    return this.run?.events[0] ?? null;
  }

  private queueAction(impl: ActionImpl<unknown>, data: unknown, flags: number): void {
    this.run?.pending.push({ impl, data, flags });
  }

  private makeHost(): QvmHost {
    const has = (name: string) => name in QVM_HOST_FUNCTIONS || name in QVM_CONSTANTS || name.includes(".");
    return {
      has,
      lazyArgs: () => true,
      value: (name: string): QvmRuntimeValue | number | undefined => {
        if (name in QVM_CONSTANTS) return undefined;
        if (name.includes(".")) return this.world.hooks.taskMember(name) ?? 0;
        return undefined;
      },
      call: (name, _args, c) => this.call(name, c),
    };
  }

  private call(name: string, c: QvmCallContext): number | QvmRuntimeValue | undefined {
    const E = this.E;
    switch (name) {
      // --- Functions ----------------------------------------------------
      case "AIFunction_GetCurrentEventType":
        return E ? E.type : -1;
      case "AIFunction_DefaultHandler": {
        if (this.common) {
          try {
            runQvm(this.common, this.host, { maxSteps: 200_000 });
          } catch (error) {
            this.reportError(error);
          }
        }
        return 1;
      }
      case "AIFunction_SetEventPriority": {
        const type = c.argInt(0);
        if (!this.registered.has(type)) {
          this.registered.add(type);
          this.priorities.push(type);
        }
        return undefined;
      }
      case "AIFunction_SetViewLength":
      case "AIFunction_SetAlarmViewLength":
      case "AIFunction_SetViewAlpha":
      case "AIFunction_SetViewGamma":
      case "AIFunction_SetSecondaryViewLength":
      case "AIFunction_SetSecondaryAlarmViewLength":
      case "AIFunction_SetSecondaryViewAlpha":
      case "AIFunction_SetSecondaryViewGamma":
        aiApplyViewCall(this.view, name, c.argFloat(0));
        return undefined;
      case "AIFunction_SetInvulnerability":
        this.invulnerable = c.argInt(0) !== 0;
        return undefined;
      case "AIFunction_SetInstantDeath":
        this.headshotProof = c.argInt(0) === 0;
        return undefined;
      case "AIFunction_SetDeathAnimation":
        this.deathAnimation = c.argInt(0);
        return undefined;
      case "AIFunction_SetAlarmTriggerID": this.alarmTriggerId = c.argInt(0); return undefined;
      case "AIFunction_SetAlarmControlID": this.alarmControlId = c.argInt(0); return undefined;
      case "AIFunction_SetAlarmAccess": this.alarmAccess = c.argInt(0); return undefined;
      case "AIFunction_SetGunnerID": this.gunnerId = c.argInt(0); return undefined;
      case "AIFunction_GetAlarmTriggerID": return this.alarmTriggerId;
      case "AIFunction_GetAlarmControlID": return this.alarmControlId;
      case "AIFunction_GetAlarmAccess": return this.alarmAccess;
      case "AIFunction_GetGunnerID": return this.gunnerId;
      case "AIFunction_GetAlarmControlStatus": {
        if (this.alarmControlId === -1) return 0;
        return this.taskName(this.alarmControlId) ? (this.world.alarmIsOn(this.alarmControlId) ? 1 : 0) : 0;
      }
      case "AIFunction_GetGunnerStatus": {
        // FUN_0044e5e0 (full exe): IsInUse (FUN_00475370) of the gun, 0 when unset or unknown (logged).
        if (this.gunnerId === -1) return 0;
        const gun = this.world.hooks.stationaryGun?.(this.gunnerId) ?? null;
        if (!gun) {
          this.world.hooks.log?.(`StationaryGun ID #${this.gunnerId} not defined`);
          return 0;
        }
        return gun.inUse ? 1 : 0;
      }
      case "AIFunction_SetScriptIntegerValue": {
        const slot = c.argInt(0);
        this.intSlots.set(slot, c.argInt(1));
        return undefined;
      }
      case "AIFunction_GetScriptIntegerValue":
        return this.intSlots.get(c.argInt(0)) ?? 0;
      case "AIFunction_SetScriptRealValue": {
        const slot = c.argInt(0);
        this.realSlots.set(slot, c.argFloat(1));
        return undefined;
      }
      case "AIFunction_GetScriptRealValue":
        return { type: "float", value: Math.fround(this.realSlots.get(c.argInt(0)) ?? 0) };
      case "AIFunction_RemoveAlarmActions": {
        // Literal: entry 8 of the priority list (H+0x83c) compared with action priority indices.
        const p = this.priorities[8];
        for (const rec of [...this.stack]) if (rec.priority === p) this.endAction(rec);
        return undefined;
      }
      case "AIFunction_GetRandomValue": {
        const max = c.argFloat(0);
        return { type: "float", value: Math.fround(this.world.rng.float() * max) };
      }
      case "AIFunction_IsEventBehind": {
        const f = headingForward(this.motor.yaw);
        for (const ev of this.run?.events ?? []) {
          if ((ev.position[0] - this.pos[0]) * f[0] + (ev.position[1] - this.pos[1]) * f[1] < 0) return 1;
        }
        return 0;
      }
      case "AIFunction_GetEventDistance":
        return { type: "float", value: Math.fround(E ? dist(E.position, this.pos) : 0) };
      case "AIFunction_GetAlarmTriggerDistance": {
        const p = this.alarmTriggerId !== -1 ? this.world.hooks.taskPosition(this.alarmTriggerId) : null;
        return { type: "float", value: p ? Math.fround(dist(p, this.pos)) : -1 };
      }
      case "AIFunction_SetAnimationInterval": {
        const min = c.argFloat(0);
        const rand = c.argFloat(1);
        this.animMinTicks = Math.trunc(min * 30);
        this.animRandTicks = Math.trunc(rand * 30);
        this.animCountdown = this.animMinTicks;
        return undefined;
      }
      case "AIFunction_AddAnimationEntry": {
        const anim = c.argInt(0);
        const weight = c.argFloat(1);
        if (this.animEntries.length < 5) this.animEntries.push({ anim, weight });
        return undefined;
      }
      case "AIFunction_GetAnimationToPlay": {
        if (!this.animEntries.length) {
          this.world.hooks.log?.(`HumanAI ${this.spec.aiTaskId}: no animation entries`);
          return -1;
        }
        const total = this.animEntries.reduce((a, e) => a + e.weight, 0);
        let r = this.world.rng.float() * total;
        for (const e of this.animEntries) {
          if (r < e.weight) return e.anim;
          r -= e.weight;
        }
        return this.animEntries[this.animEntries.length - 1].anim;
      }
      case "AIFunction_SendResponse": {
        if (E && E.source !== null) {
          const to = this.world.soldiers.find((s) => s.key === E.source);
          to?.post({ type: EV.ALERT_RESPONSE, team: this.team, flags: 0x24, range: -1, position: [...this.pos] as V3, source: this.key, other: this.key });
        }
        return undefined;
      }
      case "_Script_SetWarningLevel":
      case "BreakScript":
        return undefined;

      // --- Actions --------------------------------------------------------
      case "AIAction_Patrol": {
        const pathId = c.argInt(0);
        const start = c.argInt(1);
        this.queueAction(ACTIONS.patrol, { pathId, start }, c.argInt(2));
        return undefined;
      }
      case "AIAction_Combat": {
        const flags = c.argInt(0);
        const impl = combatActionFor(this.aiTypeName);
        if (impl) this.queueAction(impl, { events: [...(this.run?.events ?? [])] }, flags);
        return 1;
      }
      case "AIAction_Dead":
        this.queueAction(ACTIONS.dead, {}, c.argInt(0));
        return undefined;
      case "AIAction_FallFlat": {
        // Returns early, reading no arguments, on a STAIR node or when E's other object is nearer than "liedown min distance".
        if (this.onStairNode()) return undefined;
        const other = E && E.other !== null ? this.world.humans.get(E.other) : undefined;
        if (other && this.cfg && dist(other.feet(), this.pos) < this.cfg.liedownMinDistance) return undefined;
        const time = c.argFloat(0);
        this.queueAction(ACTIONS.fallFlat, { ticks: Math.trunc(time * 30) }, c.argInt(1));
        return undefined;
      }
      case "AIAction_Activate": {
        const taskId = c.argInt(0);
        const run = c.argInt(1) !== 0;
        this.queueAction(ACTIONS.activate, { taskId, run }, c.argInt(2));
        return undefined;
      }
      case "AIAction_WalkToNode":
      case "AIAction_RunToNode": {
        const node = c.argInt(0);
        this.queueAction(ACTIONS.toNode, { node, run: name === "AIAction_RunToNode" }, c.argInt(1));
        return undefined;
      }
      case "AIAction_FireAtNode":
      case "AIAction_FireAtTask": {
        const target = c.argInt(0);
        const t0 = c.argFloat(1);
        const t1 = c.argFloat(2);
        const reload = c.argInt(3) !== 0;
        this.queueAction(ACTIONS.fireAt, { target, task: name === "AIAction_FireAtTask", t0: Math.trunc(t0 * 30), t1: Math.trunc(t1 * 30), reload }, c.argInt(4));
        return undefined;
      }
      case "AIAction_PlayAnimation": {
        const anim = c.argInt(0);
        this.queueAction(ACTIONS.playAnimation, { anim }, c.argInt(1));
        return undefined;
      }
      case "AIAction_PlaySound": {
        const sound = c.argString(0, 32);
        const attached = c.argInt(1) !== 0;
        this.queueAction(ACTIONS.playSound, { sound, attached }, c.argInt(2));
        return undefined;
      }
      case "AIAction_MoveToEvent": {
        const run = c.argInt(0) !== 0;
        this.queueAction(ACTIONS.moveToEvent, { run, position: E ? [...E.position] : [...this.pos] }, c.argInt(1));
        return undefined;
      }
      case "AIAction_LookAtEvent": {
        const time = c.argFloat(0);
        this.queueAction(ACTIONS.lookAtEvent, { ticks: Math.trunc(time * 30), position: E ? [...E.position] : [...this.pos] }, c.argInt(1));
        return undefined;
      }
      case "AIAction_Stunned": {
        const time = c.argFloat(0);
        this.queueAction(ACTIONS.stunned, { ticks: Math.trunc(time * 30) }, c.argInt(1));
        return undefined;
      }
      case "AIAction_KickGrenade": {
        const flags = c.argInt(0);
        if (E && E.source !== null) this.queueAction(ACTIONS.kickGrenade, {}, flags);
        return undefined;
      }
      case "AIAction_RunPanicking": {
        const radius = c.argFloat(0);
        this.queueAction(ACTIONS.runPanicking, { radius: radius * UNITS, position: E ? [...E.position] : [...this.pos] }, c.argInt(1));
        return undefined;
      }
      case "AIAction_Idle":
        this.queueAction(ACTIONS.idle, {}, c.argInt(0));
        return undefined;
      case "AIAction_SetCombat": {
        const flags = c.argInt(0);
        if (E && E.source !== null) this.queueAction(ACTIONS.setCombat, { position: [...E.position], source: E.source, other: E.other }, flags);
        return undefined;
      }
      default:
        // Registered but not used by the AI (e.g. Task_New): no effect here.
        for (let i = 0; i < c.argc; i++) c.arg(i);
        return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Movement helpers (FUN_004510b0, FUN_00450310, FUN_004510e0, FUN_004513f0 / FUN_00451470)
  // -------------------------------------------------------------------------

  /** FUN_004513f0: walking: press the walk/run toggle while the flag is clear. */
  walkMode(): void {
    if (!this.motor.walking) this.ch[CH.WALK_TOGGLE] = 1;
  }

  /** FUN_00451470: running: press the toggle while the walking flag is set. */
  runMode(): void {
    if (this.motor.walking) this.ch[CH.WALK_TOGGLE] = 1;
  }

  /** FUN_004501c0: bring the view pitch back to level. */
  levelView(): void {
    this.ch[CH.PITCH] = aiSteerValue(-this.motor.pitch, AI_TURN_CLAMP.normal);
  }

  nodeWorld(id: number): V3 | null {
    const g = this.graphInfo;
    const n = g?.graph.nodeById.get(id);
    return g && n ? aiGraphNodeWorld(n, g.position) : null;
  }

  onNode(id: number, margin = 0.3, height = true): boolean {
    const g = this.graphInfo;
    const n = g?.graph.nodeById.get(id);
    return Boolean(g && n && aiGraphNodeContains(n, g.position, this.pos, margin, height));
  }

  onStairNode(): boolean {
    const n = this.graphInfo?.graph.nodeById.get(this.currentNode);
    return Boolean(n && n.flags & 4);
  }

  /** Closest node (skipping VIEW nodes) to a point, -1 when none. */
  closestNode(p: RV3): number {
    const g = this.graphInfo;
    if (!g) return -1;
    const c = aiGraphClosestNode(g.graph, g.position, p);
    return c ? c.node.id : -1;
  }

  /**
   * FUN_00460fd0's AI branch (0x46125a-0x46146f) [recovered]: a soldier with a graph takes its
   * feet height from the graph, never from collision (no ground probe, no gravity; the HumanAI
   * pointer human+0x800 is set once at creation and never cleared, so dead soldiers too).
   * - No queued waypoint: the current node's world height (FUN_004f02f0 / FUN_004f0340), or the
   *   feet height unchanged when the node is not valid.
   * - Walking: when the first waypoint is more than 100 units (0x531990) from the stored next
   *   one, previous = next and next = that waypoint (both start at the feet the first time);
   *   r = |next - feet| / |next - previous| (3-D) clamped to [0, 1], z = (1 - r)(next.z -
   *   previous.z) + previous.z; exactly at next: next.z.
   * `feet` is the moved feet position (IGI units); returns the feet z or null without a graph.
   */
  graphFeetZ(feet: RV3): number | null {
    const g = this.graphInfo;
    if (!g) return null;
    const z = Math.fround(feet[2]);
    if (this.route.length < 1) {
      const n = g.graph.nodeById.get(this.currentNode);
      return n ? aiGraphNodeWorld(n, g.position)[2] : z;
    }
    if (!this.heightTo) {
      this.heightFrom = [feet[0], feet[1], z];
      this.heightTo = [feet[0], feet[1], z];
    }
    const head = this.route[0].point;
    const to = this.heightTo;
    if (Math.hypot(head[0] - to[0], head[1] - to[1], head[2] - to[2]) > 100) {
      this.heightFrom = to;
      this.heightTo = [head[0], head[1], head[2]];
    }
    const next = this.heightTo!;
    const prev = this.heightFrom!;
    const d = [next[0] - feet[0], next[1] - feet[1], next[2] - z];
    if (d[0] === 0 && d[1] === 0 && d[2] === 0) return next[2];
    const ratio = Math.hypot(d[0], d[1], d[2]) / Math.hypot(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]);
    const r = 0 <= ratio ? (ratio <= 1 ? ratio : 1) : 0;
    return (1 - r) * (next[2] - prev[2]) + prev[2];
  }

  /** Queue the route from the current node to `node` (FUN_004506b0 via the stored route table). */
  routeTo(node: number, finalPoint?: RV3): boolean {
    const g = this.graphInfo;
    if (!g) return false;
    if (this.currentNode < 0 || !g.graph.nodeById.has(this.currentNode)) this.currentNode = this.closestNode(this.pos);
    if (this.currentNode < 0) return false;
    const onFrom = this.onNode(this.currentNode);
    const wps = aiGraphWaypoints(g.graph, g.position, this.currentNode, node, onFrom, finalPoint);
    if (!wps) {
      this.route = [];
      return false;
    }
    this.route = wps;
    return true;
  }

  /**
   * FUN_00450310: steer along the queued waypoints. A waypoint is reached
   * inside the 1228.8-unit box in the soldier's frame; the current node then
   * becomes its node and the next one is processed in the same tick.
   * Returns true when the queue is empty.
   */
  followRoute(): boolean {
    const yaw = this.motor.yaw;
    const f = headingForward(yaw);
    const r = headingRight(yaw);
    while (this.route.length) {
      const wp = this.route[0];
      const dx = wp.point[0] - this.pos[0];
      const dy = wp.point[1] - this.pos[1];
      const x = dx * r[0] + dy * r[1];
      const y = dx * f[0] + dy * f[1];
      // A door leg is handled before the reach test (0x450340): until the door is open the
      // walker waits facing the leg point ("Waiting for door to open").
      if (wp.door && this.world.hooks.doorOpen && !this.world.hooks.doorOpen(this, wp.point)) {
        this.ch[CH.TURN] = aiSteerValue(Math.atan2(x, y), AI_TURN_CLAMP.normal);
        return false;
      }
      if (Math.abs(x) <= AI_WAYPOINT_REACHED && Math.abs(y) <= AI_WAYPOINT_REACHED) {
        this.currentNode = wp.node;
        this.route.shift();
        // The leg's door is forgotten (+0x3e42 / +0x3e44 cleared).
        this.world.hooks.doorLegDone?.(this);
        continue;
      }
      this.ch[CH.FORWARD] = 1;
      this.ch[CH.TURN] = aiSteerValue(Math.atan2(x, y), AI_TURN_CLAMP.normal);
      this.ch[CH.PITCH] = aiSteerValue(-this.motor.pitch, AI_TURN_CLAMP.normal);
      return false;
    }
    return true;
  }

  /** FUN_004510e0: turn toward a point; true when yaw and pitch errors are within `tolerance`. */
  turnTo(point: RV3, limit: number, tolerance: number): boolean {
    const yawErr = yawErrorRight(this.pos, this.motor.yaw, point);
    const pitchErr = elevation(this.eye.position, point) - this.motor.pitch;
    if (Math.abs(yawErr) <= tolerance && Math.abs(pitchErr) <= tolerance) return true;
    this.ch[CH.TURN] = aiSteerValue(yawErr, limit);
    this.ch[CH.PITCH] = aiSteerValue(pitchErr, limit);
    return false;
  }

  // -------------------------------------------------------------------------
  // Occupancy (FUN_00451a70 / FUN_00451b30 / FUN_00451990 / FUN_00489680)
  // -------------------------------------------------------------------------

  occupancy(node: number): AiNodeOccupancy | null {
    return this.spec.graphId !== null ? this.world.occupancyOf(this.spec.graphId, node) : null;
  }

  /** A free cell of a node (centre first), or null. */
  freeCell(node: number): [number, number] | null {
    const occ = this.occupancy(node);
    if (!occ || !occ.hasRoom()) return null;
    const n = occ.size;
    if (n === 0) return [0, 0];
    const c = Math.trunc(n / 2);
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        if (!occ.isFree(x, y)) continue;
        const d = (x - c) * (x - c) + (y - c) * (y - c);
        if (d < bestD) {
          bestD = d;
          best = [x, y];
        }
      }
    }
    return best;
  }

  /** World point of a node cell. */
  cellPoint(node: number, cx: number, cy: number): V3 | null {
    const occ = this.occupancy(node);
    const w = this.nodeWorld(node);
    const n = this.graphInfo?.graph.nodeById.get(node);
    if (!occ || !w || !n) return null;
    const [ox, oy] = occ.cellOffset(cx, cy, n.radius);
    return [w[0] + ox, w[1] + oy, w[2]];
  }

  /** Reserve the cell of `node` nearest to `near` (node centre by default); returns its world point. */
  reserveCell(node: number, near?: RV3, requireFree = false): V3 | null {
    this.releaseCell();
    const occ = this.occupancy(node);
    const w = this.nodeWorld(node);
    if (!occ || !w) return null;
    let cell: [number, number];
    if (requireFree) {
      const free = this.freeCell(node);
      if (!free) return null;
      cell = free;
    } else {
      cell = occ.cellOf(near ? near[0] - w[0] : 0, near ? near[1] - w[1] : 0);
    }
    occ.reserve(cell[0], cell[1]);
    this.reservation = { node, cx: cell[0], cy: cell[1] };
    return this.cellPoint(node, cell[0], cell[1]);
  }

  releaseCell(): void {
    const r = this.reservation;
    if (!r) return;
    this.occupancy(r.node)?.release(r.cx, r.cy);
    this.reservation = null;
  }

  /** Remove every action (mission reset / soldier removal). */
  clear(): void {
    while (this.stack.length) this.endAction(this.stack[0]);
    this.releaseCell();
  }
}

/** Facing tolerance for aiming / LookAtEvent (2 deg) and LookAtNode (3 deg) [recovered]. */
export const AIM_TOLERANCE = 2 * DEG;

/** Common script of an AI type value: table 0x53a8fc (QVM_AI_TYPE_SCRIPT) [recovered]. */
function scriptName(typeIndex: number): string | null {
  return QVM_AI_TYPE_SCRIPT[typeIndex] ?? null;
}

export { BODY };
