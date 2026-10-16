/**
 * The engine side of the combat task types the mission runtime runs as
 * registered behaviours (loaders/objects): GuardGenerator, MineField,
 * StationaryGun, AIStationaryGunHolder. The behaviours keep the recovered
 * state machines; this module answers their queries (MissionHost.query) and
 * carries out their events (MissionHost.onTaskEvent) on the engine systems:
 *   - guard.*      the soldiers (combat/enemy.ts spawnGenerated / removeGenerated);
 *   - minefield.*  the explosion pipeline (combat/object-damage.ts);
 *   - sgun.*       the stationary guns (combat/stationary-guns.ts);
 *   - turret.*     the ceiling turrets (combat/ai-turrets.ts).
 * Positions are IGI units here; the engine works in metres (y up).
 */
import type { MissionNode } from "../../loaders";
import { GUARD_EVENTS } from "../../loaders/objects/guard-generator";
import { MINEFIELD_EVENTS, MINEFIELD_SNAP_RAY, type MineFieldExplosion } from "../../loaders/objects/mine-field";
import type { GameContext } from "../context";
import { TRI_BULLET } from "../world/collision";
import { isSoldierTaskType } from "../../loaders/soldier-types";
import { damageSystemOf } from "./object-damage";
import { createStationaryGuns, type StationaryGuns } from "./stationary-guns";
import { createAiTurrets, type AiTurrets } from "./ai-turrets";
import { createVehicleWeapons, type VehicleWeapons } from "./vehicle-weapons";
import type { MountedWeaponHooks } from "../world/vehicles";
import type { CombatModelEntry } from "../render/combat-models";
import { projectileSystemOf } from "./projectiles";

type V3 = [number, number, number];
const UNITS = 4096;

/** The mission-system surface the combat objects register on (engine/mission/mission-system.ts). */
export interface CombatMissionHost {
  onTaskEvent(handler: (node: MissionNode, event: string, data?: unknown) => void): () => void;
  setTaskQuery(name: string, fn: ((...args: unknown[]) => unknown) | null): void;
  readonly runtime: { tasks: { nodes: MissionNode[]; byId: Map<number, number> }; nodeState(index: number): Readonly<Record<string, number>> } | null;
  /** turrets: hand the vehicle system the vehicles' attached weapons (mission-system.ts). */
  setVehicleWeapons?(hooks: MountedWeaponHooks | null): void;
}

export interface CombatObjects {
  readonly stationaryGuns: StationaryGuns;
  readonly turrets: AiTurrets;
  /** turrets: the vehicles' mounted guns and rocket pods (combat/vehicle-weapons.ts). */
  readonly vehicleWeapons: VehicleWeapons;
  /** A fresh mission (after mission.start): forget per-mission state. */
  reset(): void;
  /** The built world (moving holders and turrets). */
  attachWorld(world: Parameters<StationaryGuns["attachWorld"]>[0]): void;
  /** Every run-time combat model to draw this frame (render/combat-models.ts). */
  models(): CombatModelEntry[];
  /** Explosions requested by MineFields (diagnostics / tests). */
  readonly mineFieldExplosions: number;
  dispose(): void;
}

export function createCombatObjects(ctx: GameContext, mission: CombatMissionHost): CombatObjects {
  const stationaryGuns = createStationaryGuns(ctx, mission);
  const turrets = createAiTurrets(ctx, mission);
  const vehicleWeapons = createVehicleWeapons(ctx);
  mission.setVehicleWeapons?.(vehicleWeapons);
  let mineFieldExplosions = 0;
  const origin = (): readonly number[] => ctx.level?.originIgi ?? [0, 0, 0];
  const toEngine = (p: readonly number[]): V3 => {
    const o = origin();
    return [(p[0] - o[0]) / UNITS, (p[2] - o[2]) / UNITS, -(p[1] - o[1]) / UNITS];
  };
  const toIgi = (e: readonly number[]): V3 => {
    const o = origin();
    return [e[0] * UNITS + o[0], -e[2] * UNITS + o[1], e[1] * UNITS + o[2]];
  };

  /** Method 7 (table 0xa994e0) of a task: a human's origin (+0x20), else the task's position. */
  function taskPosition(id: number): V3 | null {
    const rt = mission.runtime;
    const node = rt?.tasks.byId.get(id);
    if (node === undefined || !rt) return null;
    const n = rt.tasks.nodes[node];
    if (n.type === "HumanPlayer") {
      const p = ctx.player;
      // Origin = eye - 0.69 m standing / 0.35 m crouched (FUN_00464490).
      const above = p.eyeHeight - (p.crouching ? 1433.6 : 2826.24) / UNITS;
      return toIgi([p.position[0], p.position[1] + above, p.position[2]]);
    }
    if (isSoldierTaskType(n.type)) {
      const e = ctx.enemies.find((x) => x.node === node) ?? ctx.enemies.find((x) => x.taskId === id);
      const ai = e ? ctx.systems.enemies?.aiOf(e) : null;
      if (ai) return ai.self.origin();
      if (e) return toIgi([e.position[0], e.position[1] + 0.95, e.position[2]]);
    }
    const p = n.task.params["Position"];
    return Array.isArray(p) && p.length === 3 ? [Number(p[0]), Number(p[1]), Number(p[2])] : null;
  }

  /** FUN_004149b0: a ray 1638400 units down from the point, else up; the hit's z (null without a hit). */
  function snap(position: readonly number[]): number | null {
    const w = ctx.world;
    if (!w) return null;
    const e = toEngine(position);
    const len = MINEFIELD_SNAP_RAY / UNITS;
    const down = w.raycast(e[0], e[1], e[2], 0, -1, 0, len, TRI_BULLET);
    const hit = down ?? w.raycast(e[0], e[1], e[2], 0, 1, 0, len, TRI_BULLET);
    return hit ? toIgi(hit.point)[2] : null;
  }

  /** FUN_00480fe0 with the MineField's arguments, through the explosion pipeline. */
  function explode(x: MineFieldExplosion): void {
    const sys = damageSystemOf(ctx);
    if (!sys) return;
    mineFieldExplosions++;
    sys.explode(sys.makeExplosion({
      position: [x.position[0], x.position[1], x.position[2]],
      count: x.count,
      interval: x.interval,
      damage: x.damage,
      radius: x.radius,
      falloff: x.falloff,
      scorch: x.scorch,
      fragments: x.fragments,
      fireballs: x.fireballs,
      fragmentModel: x.fragmentModel,
      sound: x.sound,
      aiRange: x.aiRange,
    }));
  }

  const off = mission.onTaskEvent((node, event, data) => {
    switch (event) {
      case GUARD_EVENTS.spawn:
        for (const child of (data as { children: number[] }).children) {
          if (isSoldierTaskType(mission.runtime?.tasks.nodes[child]?.type ?? "")) ctx.systems.enemies?.spawnGenerated(child);
        }
        return;
      case GUARD_EVENTS.remove:
        for (const child of (data as { children: number[] }).children) ctx.systems.enemies?.removeGenerated(child);
        return;
      case MINEFIELD_EVENTS.explode:
        explode(data as MineFieldExplosion);
        return;
      default:
        stationaryGuns.onTaskEvent(node, event, data);
        turrets.onTaskEvent(node, event, data);
    }
  });
  mission.setTaskQuery(GUARD_EVENTS.child, (_generator, child) => ctx.systems.enemies?.generatedState(child as number) ?? null);
  mission.setTaskQuery(MINEFIELD_EVENTS.position, (id) => taskPosition(id as number));
  mission.setTaskQuery(MINEFIELD_EVENTS.snap, (p) => snap(p as V3));
  stationaryGuns.registerQueries();

  return {
    stationaryGuns,
    turrets,
    vehicleWeapons,
    reset() {
      mineFieldExplosions = 0;
      stationaryGuns.reset();
      turrets.reset();
      vehicleWeapons.reset();
    },
    attachWorld(world) {
      stationaryGuns.attachWorld(world);
      turrets.attachWorld?.(world);
    },
    models() {
      return [...stationaryGuns.models(), ...(turrets.models?.() ?? []), ...vehicleWeapons.models(), ...projectileSystemOf(ctx).models()];
    },
    get mineFieldExplosions() {
      return mineFieldExplosions;
    },
    dispose() {
      off();
      stationaryGuns.dispose();
      turrets.dispose();
      mission.setVehicleWeapons?.(null);
      vehicleWeapons.dispose();
    },
  };
}
