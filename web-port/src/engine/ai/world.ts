/**
 * The soldiers' shared AI world: event broadcast (FUN_0044fab0), the
 * shared target records (pool 0x580d70, 8 records, FUN_0044fe50), node
 * occupancy grids per graph (FUN_00451a70) and the level RNG. Engine-free;
 * combat/enemy.ts supplies the hooks (rays, task members, outputs).
 */
import { AiNodeOccupancy, aiGraphNodeWorld } from "../../loaders";
import type { AiLevelData } from "./data";
import type { HumanAi } from "./human-ai";
import { LevelRng } from "./rng";
import type { AiEvent, AiHuman, RV3, V3 } from "./types";

/** The two objects a perception sight ray skips (FUN_00487f40's record {self, target}, filter 0x441c30). */
export interface SightSkip {
  /** The looker (the soldier's own human key). */
  self: number;
  /** The tracked object the ray goes to. */
  target: number;
}

export interface AiHooks {
  /**
   * Line of sight from a to b (IGI units): clear when nothing is hit or the
   * see-through transmission of the hits is >= 0.79.
   *   - With `skip` (perception, FUN_00487f40, filter 0x53f120): every human
   *     in the world (alive or dead, posed) other than skip.self and
   *     skip.target is on the ray too (human filter 0x441c30 ->
   *     FUN_0045e490).
   *   - Without (the combat node search FUN_00489b00, filter 0x537430):
   *     humans never stop the ray (their handler 0x4fa7f0 answers "skip").
   */
  lineOfSight(a: RV3, b: RV3, skip?: SightSkip): boolean;
  /**
   * Perception phase of a HumanAI task (DAT_005c4a48 as FUN_0044f3a0 takes it
   * in the level's create / compile order, shared with the SCamera lenses and
   * the vehicles: loaders/mission.ts perceptionPhases); undefined when the
   * task runtime does not know it (the AI world then deals phases itself).
   */
  perceptionPhase?(aiTaskId: number): number | undefined;
  /** Task member such as "AlarmControl_98.isAlarm" (task runtime), undefined when unknown / unavailable. */
  taskMember(name: string): number | undefined;
  /** IGI world position of a task, or null. */
  taskPosition(id: number): V3 | null;
  /** First detection of the player by a soldier in combat (detected_0N voice). */
  detected?(ai: HumanAi): void;
  /** AIAction_PlaySound. */
  playSound?(ai: HumanAi, name: string): void;
  /** Request to open the door on a door leg near `point`; true when it is open (or no door exists there). */
  doorOpen?(ai: HumanAi, point: RV3): boolean;
  /** The door leg was completed: forget its door (the next door leg searches again). */
  doorLegDone?(ai: HumanAi): void;
  log?(message: string): void;
}

/** Shared last-known-position record of one target (FUN_0044fe50) [recovered]. */
export class SharedTarget {
  /** Attacker -> status: 0 firing, 1 reloading, 2 waiting, -1 none. */
  readonly attackers = new Map<HumanAi, number>();
  /** The detected voice was played for this record. */
  voiced = false;
  constructor(readonly key: number, public lastKnown: V3) {}
  /** Attackers other than `self` currently firing (status 0). */
  firing(self: HumanAi): number {
    let n = 0;
    for (const [ai, status] of this.attackers) if (ai !== self && status === 0) n++;
    return n;
  }
}

export const TARGET_POOL_SIZE = 8;

export class AiWorld {
  readonly rng: LevelRng;
  /** Level tick (the mission's ctx.tick): timers, the combat and action clocks. */
  tick = 0;
  /**
   * The application tick *(DAT_00563dfc + 0x34) (FUN_00402a30) [recovered]:
   * reset at each level load (FUN_004029a0), +1 after every main-loop tick
   * (0x4023ce) including the ticks the in-game menu pauses the Game task
   * (+0xe0, FUN_00415c60). The perception phase test FUN_00487b70 reads it.
   */
  appTick = 0;
  readonly humans = new Map<number, AiHuman>();
  readonly soldiers: HumanAi[] = [];
  readonly targets: SharedTarget[] = [];
  private readonly occupancy = new Map<number, Map<number, AiNodeOccupancy>>();
  private nextPhase = 0;
  /** AlarmControl isAlarm (+0x2a1) now and its previous-tick copy (+0x2a2), per task id. */
  private readonly alarms = new Map<number, { name: string | null; prev: boolean; cur: boolean }>();

  constructor(readonly data: AiLevelData, readonly hooks: AiHooks, rng = new LevelRng()) {
    this.rng = rng;
  }

  /**
   * Perception phases 0..3 handed out round-robin as soldiers are created
   * (FUN_00487ae0) [recovered counter]: the fallback when hooks.perceptionPhase
   * does not know the HumanAI (no task runtime, e.g. headless tests).
   */
  takePhase(): number {
    const p = this.nextPhase;
    this.nextPhase = (this.nextPhase + 1) & 3;
    return p;
  }

  /** Start of a 30 Hz tick: AlarmControl +0x2a2 = previous isAlarm, +0x2a1 = current (FUN_0043fa60) [recovered]. */
  beginTick(): void {
    for (const a of this.alarms.values()) {
      a.prev = a.cur;
      a.cur = a.name ? Boolean(this.hooks.taskMember(`${a.name}.isAlarm`)) : false;
    }
  }

  private alarm(id: number) {
    let a = this.alarms.get(id);
    if (!a) {
      const t = this.data.taskById.get(id);
      const name = t ? `${t.type}_${id}` : null;
      const cur = name ? Boolean(this.hooks.taskMember(`${name}.isAlarm`)) : false;
      a = { name, prev: cur, cur };
      this.alarms.set(id, a);
    }
    return a;
  }

  /** FUN_0043fdc0: AlarmControl +0x2a1 (isAlarm). */
  alarmIsOn(id: number): boolean {
    return this.alarm(id).cur;
  }

  /** FUN_0043fdd0: AlarmControl +0x2a2 (isAlarm of the previous tick). */
  alarmWasOn(id: number): boolean {
    return this.alarm(id).prev;
  }

  addHuman(h: AiHuman): void {
    this.humans.set(h.key, h);
  }

  /** FUN_0044fab0: offer an event to every HumanAI (each applies its receive filter). */
  broadcast(ev: AiEvent): void {
    for (const s of this.soldiers) if (s.self.present()) s.receive(ev);
  }

  /** Shared target record for an object: the existing one, else a new one from the pool of 8 (null when full). */
  targetRecord(key: number): SharedTarget | null {
    const found = this.targets.find((t) => t.key === key);
    if (found) return found;
    if (this.targets.length >= TARGET_POOL_SIZE) return null;
    const h = this.humans.get(key);
    const rec = new SharedTarget(key, h ? h.origin() : [0, 0, 0]);
    this.targets.push(rec);
    return rec;
  }

  /** FUN_00450070: unregister an attacker; the record returns to the pool when nobody uses it. */
  releaseTarget(rec: SharedTarget, ai: HumanAi): void {
    rec.attackers.delete(ai);
    if (rec.attackers.size === 0) {
      const i = this.targets.indexOf(rec);
      if (i >= 0) this.targets.splice(i, 1);
    }
  }

  occupancyOf(graphId: number, nodeId: number): AiNodeOccupancy | null {
    const info = this.data.graphs.get(graphId);
    const node = info?.graph.nodeById.get(nodeId);
    if (!info || !node) return null;
    let byNode = this.occupancy.get(graphId);
    if (!byNode) {
      byNode = new Map();
      this.occupancy.set(graphId, byNode);
    }
    let occ = byNode.get(nodeId);
    if (!occ) {
      occ = new AiNodeOccupancy(node.radius);
      byNode.set(nodeId, occ);
    }
    return occ;
  }

  nodeWorld(graphId: number, nodeId: number): V3 | null {
    const info = this.data.graphs.get(graphId);
    const node = info?.graph.nodeById.get(nodeId);
    return info && node ? aiGraphNodeWorld(node, info.position) : null;
  }
}
