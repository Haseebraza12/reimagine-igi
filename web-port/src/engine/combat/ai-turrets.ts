/**
 * The engine side of AIStationaryGunHolder / AIStationaryGun (mission 14's
 * ceiling turrets; rules in loaders/objects/ai-stationary-gun.ts):
 *   - the holder's detector (FUN_00489750 on its perception phase, the
 *     process-wide counter at its compile): every human in the world of another
 *     team than the holder's (Team expression) that is alive gets a slot at the
 *     list's tail; the cone (Viewcone Alpha / Gamma about the holder's axes,
 *     360 deg = everything) within Viewcone Length and the AI sight ray
 *     (FUN_00487f40: see-through product >= 0.79, every other human on the ray)
 *     drive the slot's "visible" flag (aiPerceptionStep); switched off, the
 *     detector is reset (FUN_00489b90);
 *   - the turret (stepAiTurret): target = the first visible slot, its origin
 *     (+0x20) seen from the turret in the holder's frame; it fires the Gun of
 *     the weaponconfig whose Gun Model is the definition's (WEAPON_ID_SENTRY:
 *     1 tick, spread 15 deg, the GUNSHOT event of team 1: no user) through the
 *     AI bullet path with hit probability 1.0 (the record's scale);
 *   - the turret ATTA (456_12_1) turns about z (instance transform) and the
 *     gun model (456_13_1) is drawn at the turret's origin with the gun matrix.
 * Inferred: the holder ATTA's matrix B is the instance's placement relative to
 * the holder (FUN_004e0930 builds it from the ATTA, not traced); the bullets
 * hit soldiers of every team but the holder's (the soldiers' own-team filter
 * applied to the turret's team).
 */
import * as THREE from "three";
import {
  AI_GUNSHOT_RANGE,
  aiNewPerceptionSlot,
  aiPerceptionStep,
  fireCooldownTicks,
  sampleViewKick,
  spreadForShot,
  type AiPerceptionSlot,
  type LevelWeapon,
  type MissionNode,
} from "../../loaders";
import { engineMatrix4, igiRotationToEngine, type Mat3 } from "../../loaders/coords";
import { AI_TURRET_EVENTS, aiTurretAim, aiTurretDef, aiTurretHolderCone, aiTurretMuzzle, aiTurretPose, newAiTurretState, stepAiTurret, type AiTurretDef, type AiTurretState } from "../../loaders/objects/ai-stationary-gun";
import { eulerZYX, mulM3, type M3 } from "../../loaders/objects/stationary-gun";
import { NO_MATERIAL, aiSightPasses, sightTransmission } from "../../loaders/collision-mesh";
import { igiRotationFromEngineMatrix } from "../player/interact";
import { EV, type AiHuman } from "../ai/types";
import { horizontalAngle, verticalAngle } from "../player/use-objects";
import type { GameContext } from "../context";
import { GameEvent } from "../events";
import { TRI_SIGHT } from "../world/collision";
import type { CombatModelEntry } from "../render/combat-models";
import { damageSystemOf } from "./object-damage";
import { drawPellet, pelletDirection, spreadRadians } from "./pellet";

type V3 = [number, number, number];
const UNITS = 4096;
export const TURRET_SHOOTER_BASE = 2_000_000;

export interface AiTurretRecord {
  node: number;
  id: number;
  cone: { alpha: number; gamma: number; length: number };
  holderMatrix: M3;
  /** The turret ATTA instance (index in level.instances), its origin (IGI) and matrix relative to the holder. */
  instance: number;
  origin: V3;
  attach: M3;
  def: AiTurretDef;
  weapon: LevelWeapon | null;
  gunMagic: V3[];
  state: AiTurretState;
  /** The detector's slots and enemy list (det +0x18) in AddTail order. */
  slots: Map<number, AiPerceptionSlot>;
  list: number[];
  phase: number;
  team: number;
  on: boolean;
  clip: number;
  cooldown: number;
  shots: number;
  firing: boolean;
  turning: { kill(): void; alive?: boolean } | null;
  rounds: number;
  pose: { turret: M3; gun: M3 };
  lastYaw: number;
}

export interface AiTurrets {
  onTaskEvent(node: MissionNode, event: string, data?: unknown): void;
  reset(): void;
  dispose(): void;
  attachWorld?(world: unknown): void;
  models?(): CombatModelEntry[];
  readonly turrets: readonly AiTurretRecord[];
}

interface MissionLike {
  readonly runtime: { tasks: { nodes: MissionNode[] } } | null;
}

export function createAiTurrets(ctx: GameContext, mission: MissionLike): AiTurrets {
  let turrets: AiTurretRecord[] = [];
  let builtFor: unknown = null;
  let world: { setInstanceTransform(i: number, m: ArrayLike<number>): void; readonly dynamicTasks: ReadonlySet<number> } | null = null;
  const origin = () => ctx.level?.originIgi ?? [0, 0, 0];
  const toEngine = (p: readonly number[]): V3 => {
    const o = origin();
    return [(p[0] - o[0]) / UNITS, (p[2] - o[2]) / UNITS, -(p[1] - o[1]) / UNITS];
  };
  const toIgi = (e: readonly number[]): V3 => {
    const o = origin();
    return [e[0] * UNITS + o[0], -e[2] * UNITS + o[1], e[1] * UNITS + o[2]];
  };

  function build(): void {
    turrets = [];
    builtFor = mission.runtime;
    const level = ctx.level;
    const rt = mission.runtime;
    if (!level || !rt) return;
    const tasks = ctx.systems.tasks as { perceptionPhase?(id: number): number | undefined } | null;
    for (const n of rt.tasks.nodes) {
      if (n.type !== "AIStationaryGunHolder") continue;
      const i = level.instances.findIndex((x) => x.taskIndex === n.index && x.magicType === "TASKTYPE_AISTATIONARYGUN");
      if (i < 0) continue;
      const inst = level.instances[i];
      const args = level.aiTurretDefs?.get(inst.model.toLowerCase());
      const def = args ? aiTurretDef(args) : null;
      if (!def) continue;
      const o = n.task.params["Orientation"];
      const a = Array.isArray(o) ? o.map(Number) : [0, 0, 0];
      const holderMatrix = eulerZYX(a[0], a[1], a[2]);
      const r = igiRotationFromEngineMatrix(inst.matrix) as M3;
      // B = H^T R (the ATTA's matrix relative to the holder).
      const ht: M3 = [holderMatrix[0], holderMatrix[3], holderMatrix[6], holderMatrix[1], holderMatrix[4], holderMatrix[7], holderMatrix[2], holderMatrix[5], holderMatrix[8]];
      const attach = mulM3(ht, r);
      const weapon = [...level.weapons.values()].find((w) => w.gunModel?.toLowerCase() === def.gunModel.toLowerCase()) ?? null;
      const state = newAiTurretState();
      turrets.push({
        node: n.index, id: n.id, cone: aiTurretHolderCone(n.task.params), holderMatrix, instance: i, origin: toIgi([inst.matrix[12], inst.matrix[13], inst.matrix[14]]),
        attach, def, weapon, gunMagic: (damageSystemOf(ctx)?.data?.bounds.get(def.gunModel.toLowerCase())?.magic ?? []).map((m) => [m[0], m[1], m[2]] as V3),
        state, slots: new Map(), list: [], phase: (tasks?.perceptionPhase?.(n.id) ?? 0) & 3, team: 1, on: false, clip: def.ammo, cooldown: 0, shots: 0,
        firing: false, turning: null, rounds: 0, pose: aiTurretPose(holderMatrix, attach, state), lastYaw: Number.NaN,
      });
    }
  }
  const ensure = () => {
    if (builtFor !== mission.runtime) build();
  };

  /** The humans of the detectable registry (FUN_00489750 walks it in create order). */
  function humans(): AiHuman[] {
    return [...(ctx.systems.enemies?.aiHumans() ?? [])];
  }

  /** FUN_00487d80 with the holder's cone: dist <= length, |vertical| < alpha, |horizontal| < gamma (holder axes). */
  function inCone(t: AiTurretRecord, point: V3): boolean {
    const d = [point[0] - t.origin[0], point[1] - t.origin[1], point[2] - t.origin[2]];
    if (Math.hypot(d[0], d[1], d[2]) > t.cone.length) return false;
    const h = t.holderMatrix;
    const l = [h[0] * d[0] + h[3] * d[1] + h[6] * d[2], h[1] * d[0] + h[4] * d[1] + h[7] * d[2], h[2] * d[0] + h[5] * d[1] + h[8] * d[2]];
    return Math.abs(verticalAngle(l)) < t.cone.alpha && Math.abs(horizontalAngle(l)) < t.cone.gamma;
  }

  function sight(t: AiTurretRecord, from: V3, to: V3, target: number): boolean {
    const w = ctx.world;
    if (!w) return true;
    const a = toEngine(from);
    const b = toEngine(to);
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    if (!(len > 0)) return true;
    const hits: Array<{ material: number; front: boolean; terrain?: boolean }> = w
      .raycastAll(a[0], a[1], a[2], d[0] / len, d[1] / len, d[2] / len, len, TRI_SIGHT)
      .filter((x) => x.owner !== t.node)
      .map((x) => ({ material: x.material < 0 ? NO_MATERIAL : x.material, front: x.front, terrain: x.terrain }));
    const enemies = ctx.systems.enemies;
    if (enemies?.sightHits) hits.push(...enemies.sightHits(a, b, [target]));
    const table = ctx.level?.surfaceMaterials ?? [];
    return aiSightPasses(sightTransmission(hits, (m) => table[m]?.seeThrough ?? 0));
  }

  const pointOf = (h: AiHuman): V3 => {
    const o = h.origin();
    return [o[0], o[1], o[2] + (h.crouched() ? 1433.6 : 2826.24)];
  };

  /** FUN_00489750 on the phase ticks: slots of alive humans of another team, in registry order. */
  function perceive(t: AiTurretRecord): void {
    if (((ctx.appTick ?? ctx.tick) & 3) !== t.phase) return;
    for (const h of humans()) {
      const tracked = h.present() && !h.dead() && h.team !== t.team;
      let slot = t.slots.get(h.key);
      if (!tracked) {
        if (slot) {
          t.slots.delete(h.key);
          t.list.splice(t.list.indexOf(h.key), 1);
        }
        continue;
      }
      if (!slot) {
        slot = aiNewPerceptionSlot();
        t.slots.set(h.key, slot);
        t.list.push(h.key);
      }
      const p = pointOf(h);
      aiPerceptionStep(slot, () => inCone(t, p), () => sight(t, t.origin, p, h.key));
    }
  }

  function shoot(t: AiTurretRecord, fire: boolean): void {
    const w = t.weapon;
    if (!w) return;
    let req = fire;
    if (!req) t.shots = 0;
    else if (t.shots === w.maxRoundsPerBurst) req = false;
    let shot = req && t.cooldown === 0;
    if (w.calibreId > 0 && t.clip === 0) shot = req = false;
    const { muzzle, dir } = aiTurretMuzzle(t.origin, t.pose.gun, t.gunMagic[2] ?? [0, 0, 0]);
    const at = toEngine(muzzle);
    const shooter = TURRET_SHOOTER_BASE + t.node;
    if (!req && t.firing) {
      t.firing = false;
      ctx.events.emit(GameEvent.FireStopped, { weaponId: w.scriptId, shooter, position: at });
    }
    if (shot) {
      t.firing = true;
      ctx.events.emit(GameEvent.Fire, { weaponId: w.scriptId, shooter, position: at });
      const aim: V3 = [dir[0], dir[2], -dir[1]];
      const spread = spreadRadians(spreadForShot(w.minSpread, w.maxSpread, t.shots));
      for (let k = 0; k < Math.max(1, w.bulletsPerRound); k++) {
        let d: V3 = aim;
        if (spread !== 0) {
          const p = drawPellet(spread, () => ctx.rng.float());
          d = pelletDirection(aim, p.angle, p.azimuth);
        }
        ctx.systems.enemies?.shootAs({ team: t.team, hitProbability: 1, id: shooter }, w, at, d);
      }
      t.shots++;
      t.rounds++;
      t.cooldown = fireCooldownTicks(w.roundsPerMinute);
      if (w.calibreId > 0 && t.clip > 0) t.clip--;
      ctx.systems.enemies?.broadcast({ type: EV.GUNSHOT, team: 1, flags: 0x46, range: AI_GUNSHOT_RANGE, position: muzzle, source: null, other: null });
      sampleViewKick({ kickFixedXDeg: w.recoilPitch, kickRandomXDeg: w.recoilPitchRandom, kickFixedZDeg: w.recoilYaw, kickRandomZDeg: w.recoilYawRandom }, () => ctx.rng.float());
    }
    if (t.cooldown > 0) t.cooldown--;
  }

  function update(t: AiTurretRecord, data: { team: number; isOn: number; wasOn: number }): void {
    t.team = data.team;
    t.on = data.isOn !== 0;
    if (!t.on) {
      if (data.wasOn) {
        t.slots.clear();
        t.list = [];
      }
    } else perceive(t);
    // The turret's update 0x46f390: the first visible slot of the enemy list.
    let aim: { pitch: number; yaw: number; d2: number } | null = null;
    for (const key of t.list) {
      if (!t.slots.get(key)?.visible) continue;
      const h = ctx.systems.enemies?.aiHumans ? humans().find((x) => x.key === key) : undefined;
      if (!h) continue;
      aim = aiTurretAim(t.holderMatrix, t.origin, h.origin());
      break;
    }
    const r = stepAiTurret(t.def, t.state, aim);
    t.pose = aiTurretPose(t.holderMatrix, t.attach, t.state);
    shoot(t, r.fire);
    // The turning sound: the definition's sample looped at the turret while turning.
    const audio = ctx.systems.audio as { playAt?(n: string, p: V3): { kill(): void; alive?: boolean } | null } | null;
    if (r.turning) {
      if ((!t.turning || t.turning.alive === false) && t.def.sound) t.turning = audio?.playAt?.(t.def.sound, toEngine(t.origin)) ?? null;
    } else if (t.turning) {
      t.turning.kill();
      t.turning = null;
    }
    syncTurret(t);
  }

  function syncTurret(t: AiTurretRecord): void {
    if (!world || !world.dynamicTasks.has(t.node) || t.state.yaw === t.lastYaw) return;
    t.lastYaw = t.state.yaw;
    const p = toEngine(t.origin);
    const now = new THREE.Matrix4().fromArray(engineMatrix4(igiRotationToEngine(t.pose.turret as Mat3), p));
    const built = new THREE.Matrix4().fromArray(engineMatrix4(igiRotationToEngine(mulM3(t.holderMatrix, t.attach) as Mat3), p)).invert();
    world.setInstanceTransform(t.instance, now.multiply(built).elements);
  }

  return {
    get turrets() {
      ensure();
      return turrets;
    },
    onTaskEvent(node, event, data) {
      if (event !== AI_TURRET_EVENTS.update) return;
      ensure();
      const t = turrets.find((x) => x.node === node.index);
      if (t) update(t, data as { team: number; isOn: number; wasOn: number });
    },
    reset() {
      for (const t of turrets) t.turning?.kill();
      build();
    },
    dispose() {
      for (const t of turrets) t.turning?.kill();
      turrets = [];
    },
    attachWorld(next) {
      world = next as typeof world;
      ensure();
      for (const t of turrets) {
        t.lastYaw = Number.NaN;
        syncTurret(t);
      }
    },
    models() {
      const out: CombatModelEntry[] = [];
      for (const t of turrets) {
        const inWorld = (ctx.systems.tasks as { inWorldNode?(n: number): boolean } | null)?.inWorldNode?.(t.node) ?? true;
        if (!inWorld) continue;
        out.push({ key: `turret:${t.node}`, model: t.def.gunModel, position: t.origin, matrix: t.pose.gun });
      }
      return out;
    },
  };
}

