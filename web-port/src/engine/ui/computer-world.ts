/**
 * Adapter from the port's GameContext to the data the map computer reads
 * (computer.ts ComputerWorld). Task parameters are read the way the exe
 * compiles them (recovered):
 *
 *   ComputerHilight (FUN_00466e60 / ctor LAB_00467060 / compile FUN_00467130 /
 *   draw FUN_00467310): "Hilight" expression (drawn while byte(fistp(eval)) != 0),
 *   "TaskID" list parsed by FUN_00467200 (numbers; "a-b" fills the range; at
 *   most 64), "Click to select sprite" matched against the COMPUTER:h_*.spr
 *   table at 0x53d7b0, "Marker mesh" MARKER_NONE -1 / MARKER_BOX 0, "Marker
 *   color" MARKER_COLOR_NONE -1, RED 0, YELLOW 1, GREEN 2, BLUE 4
 *   (FUN_00466280), "Title text resource" / "Info text resource" (an empty
 *   key draws nothing, a missing one "RM: key").
 *
 *   DefineComputerObjective (FUN_00465f90): each tick, unless "Objectives
 *   Valid" is present and byte(fistp(eval)) == 0, the task becomes the active
 *   set; complete / failed = (char)fistp(eval(expression)) (0 when absent).
 *
 *   HumanPlayerInput "Mapcomputer on expression" (0x45cb23): DAT_0053dd64 =
 *   fistp(eval) or 1 when empty (level 1: empty -> the map page exists).
 */
import { igiPointToEngine, x87Fistp, type IgiTask, type TaskParam } from "../../loaders";
import type { Vec3 } from "../../contracts";
import type { GameContext } from "../context";
import {
  HILIGHT_SPRITES,
  type ComputerCamera,
  type ComputerHilightTarget,
  type ComputerHuman,
  type ComputerObjective,
  type ComputerWorld,
} from "./computer";

export type ComputerContext = Pick<GameContext, "player" | "level"> & Partial<Pick<GameContext, "enemies" | "world" | "systems">>;

const MARKER_MESH: Record<string, number> = { MARKER_NONE: -1, MARKER_BOX: 0 };
const MARKER_COLOR: Record<string, number> = {
  MARKER_COLOR_NONE: -1,
  MARKER_COLOR_RED: 0,
  MARKER_COLOR_YELLOW: 1,
  MARKER_COLOR_GREEN: 2,
  MARKER_COLOR_BLUE: 4,
};

const str = (v: TaskParam | undefined): string => (typeof v === "string" ? v : v && typeof v === "object" && "symbol" in v ? String((v as { symbol: string }).symbol) : "");
const num = (v: TaskParam | undefined, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** FUN_00467200: "1104-1110 1120" -> [1104..1110, 1120]. */
export function parseTaskIdList(text: string): number[] {
  const out: number[] = [];
  let range = false;
  let i = 0;
  while (i < text.length && out.length <= 0x3f) {
    const c = text[i];
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < text.length && text[j] >= "0" && text[j] <= "9") j++;
      const n = Number(text.slice(i, j));
      if (range && out.length) {
        for (let k = out[out.length - 1] + 1; k < n && out.length < 0x40; k++) out.push(k);
        range = false;
      }
      out.push(n);
      i = j;
      continue;
    }
    if (c === "-") range = true;
    else if (c !== " ") range = false;
    i++;
  }
  return out;
}

/** Strip "COMPUTER:" and accept only the sprites of the exe's table. */
export function hilightSprite(name: string): string | null {
  const bare = name.replace(/^COMPUTER:/i, "").toLowerCase();
  return HILIGHT_SPRITES.includes(bare) ? bare : null;
}

export interface ComputerWorldOptions {
  /** Key lookup across computer.res / objectives.res / messages.res; null when the key does not exist. */
  lookup(key: string): string | null;
}

export function createComputerWorld(ctx: ComputerContext, options: ComputerWorldOptions): ComputerWorld & { mapEnabled(): boolean } {
  const tasksById = new Map<number, IgiTask>();
  const hilights: IgiTask[] = [];
  const objectiveSets: IgiTask[] = [];
  const cameras: IgiTask[] = [];
  let playerInput: IgiTask | null = null;
  let indexedLevel: unknown = null;

  const index = () => {
    if (indexedLevel === ctx.level) return;
    indexedLevel = ctx.level;
    tasksById.clear();
    hilights.length = objectiveSets.length = cameras.length = 0;
    playerInput = null;
    for (const t of ctx.level?.tasks ?? []) {
      tasksById.set(t.id, t);
      if (t.type === "ComputerHilight") hilights.push(t);
      else if (t.type === "DefineComputerObjective") objectiveSets.push(t);
      else if (t.type === "SCamera") cameras.push(t);
      else if (t.type === "HumanPlayerInput") playerInput = t;
    }
  };

  const origin = (): Vec3 => {
    const lvl = ctx.level as { originIgi?: Vec3; origin?: Vec3 } | null;
    return lvl?.originIgi ?? lvl?.origin ?? [0, 0, 0];
  };

  const taskPosition = (id: number): Vec3 | null => {
    index();
    const t = tasksById.get(id);
    // SCamera keeps its position in "Holder Position" (the head sits on the holder; inferred).
    const p = t?.params.Position ?? t?.params["Holder Position"];
    if (!Array.isArray(p) || p.length < 3) return null;
    return igiPointToEngine([Number(p[0]), Number(p[1]), Number(p[2])], origin());
  };

  /** byte(fistp(eval(expr))) through the task runtime; literals without one. */
  const truth = (expr: string, self: string): boolean => {
    const e = expr.trim();
    if (!e) return false;
    const tasks = ctx.systems?.tasks;
    let v: number;
    if (tasks) v = tasks.condition(e, self);
    else {
      v = Number(e);
      if (!Number.isFinite(v)) return false;
    }
    return (x87Fistp(v) & 0xff) !== 0;
  };

  const resolve = (key: string): string | null => {
    if (!key) return null;
    return options.lookup(key) ?? `RM: ${key}`;
  };

  return {
    mapEnabled(): boolean {
      index();
      const expr = playerInput ? str(playerInput.params["Mapcomputer on expression"]).trim() : "";
      if (!expr) return true;
      const tasks = ctx.systems?.tasks;
      const v = tasks ? tasks.condition(expr, "HumanPlayerInput_-1") : Number(expr);
      return Number.isFinite(v) && x87Fistp(v) !== 0;
    },

    player(): ComputerHuman | null {
      const p = ctx.player;
      if (!p) return null;
      return { id: 0, position: p.position, yaw: p.yaw, team: 0, alive: p.alive };
    },

    soldiers(): readonly ComputerHuman[] {
      index();
      const out: ComputerHuman[] = [];
      for (const e of ctx.enemies ?? []) {
        const task = tasksById.get(e.taskId);
        const inWorld = ctx.systems?.tasks?.inWorld?.(e.taskId) ?? true;
        out.push({ id: e.id, position: e.position, yaw: e.yaw, team: num(task?.params.Team, 1), alive: e.alive && inWorld });
      }
      return out;
    },

    cameras(): readonly ComputerCamera[] {
      index();
      const out: ComputerCamera[] = [];
      for (const t of cameras) {
        const pos = taskPosition(t.id);
        if (pos) out.push({ id: t.id, position: pos, rotatingFrame: null });
      }
      return out;
    },

    hilights(): readonly ComputerHilightTarget[] {
      index();
      const out: ComputerHilightTarget[] = [];
      for (const h of hilights) {
        const p = h.params;
        if (!truth(str(p.Hilight), `ComputerHilight_${h.id}`)) continue;
        const sprite = hilightSprite(str(p["Click to select sprite"]));
        const marker = MARKER_MESH[str(p["Marker mesh"])] ?? -1;
        const markerColour = MARKER_COLOR[str(p["Marker color"])] ?? -1;
        const title = resolve(str(p["Title text resource"]));
        const info = resolve(str(p["Info text resource"]));
        for (const id of parseTaskIdList(str(p.TaskID))) {
          const pos = taskPosition(id);
          if (pos) out.push({ taskId: id, position: pos, sprite, marker, markerColour, title, info });
        }
      }
      return out;
    },

    objectives(): readonly ComputerObjective[] | null {
      index();
      let active: IgiTask | null = null;
      for (const t of objectiveSets) {
        const valid = str(t.params["Objectives Valid"]).trim();
        if (!valid || truth(valid, `DefineComputerObjective_${t.id}`)) active = t;
      }
      if (!active) return null;
      const self = `DefineComputerObjective_${active.id}`;
      const out: ComputerObjective[] = [];
      for (let i = 1; i <= 6; i++) {
        const p = active.params;
        const key = str(p[`Objective ${i} Text Resource`]);
        out.push({
          text: key ? options.lookup(key) ?? `RM: ${key}` : "",
          link: num(p[`Objective ${i} Link To Position`], -1),
          complete: truth(str(p[`Objective ${i} Complete Expression`]), self),
          failed: truth(str(p[`Objective ${i} Failed Expression`]), self),
        });
      }
      return out;
    },

    taskPosition,

    ray(o: Vec3, d: Vec3, max: number): Vec3 | null {
      const hit = ctx.world?.raycast(o[0], o[1], o[2], d[0], d[1], d[2], max);
      return hit ? [hit.point[0], hit.point[1], hit.point[2]] : null;
    },

    lineOfSight(from: Vec3, to: Vec3): boolean {
      const w = ctx.world;
      if (!w) return true;
      // The exe casts from the camera to the human's origin; the port's position is the feet, so aim
      // 1 m higher (rendering.md: the runtime origin sits about 1 m above the feet, inferred).
      const tx = to[0] - from[0];
      const ty = to[1] + 1 - from[1];
      const tz = to[2] - from[2];
      const dist = Math.hypot(tx, ty, tz);
      if (dist <= 0) return true;
      const hit = w.raycast(from[0], from[1], from[2], tx / dist, ty / dist, tz / dist, dist);
      return !hit || hit.distance >= dist - 0.05;
    },
  };
}
