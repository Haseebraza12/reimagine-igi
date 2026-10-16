/**
 * The player's "use" (Activate) interactions, as igi.exe runs them
 * (docs/interactions.md): the target search and HUD action icon, the
 * Activate dispatch (FUN_0040ce30), the timed uses (terminal hacking) and
 * the attached states (ladders, fences, wires; attach.ts).
 *
 * Recovered:
 *   - Activate is read in the upper-body idle state (FUN_0040ead0): only
 *     when no fire / alternate-fire / reload / weapon-select action takes
 *     the tick, the latch +0x7b9 is clear, a target exists and Activate is
 *     held (+0x1d4 != 0). The latch is set by every release (FUN_00462260)
 *     and cleared there once Activate is up, so one press uses one object.
 *   - FUN_0040ce30: the target becomes the active object (+0x7b4), "in use"
 *     (+0x7b8 = 1) stops the search, then per kind:
 *       2 Switch:   FUN_00443ce0 (isLastPressed = isPressed, isPressed = 1,
 *                   press tick) and release;
 *       3 Door:     unlocked -> toggle (FUN_00446c10) + AI DOOR noise
 *                   (FUN_0040c370, type 12) and release; locked but pickable
 *                   -> lock-pick state 30;
 *       5 Terminal: hacking state 32;
 *       9 Wire:     slide (pitch > 2 deg) or traverse (FUN_0043ea60);
 *      10 Ladder:   +0xd78 -> FUN_00411380 attaches (bottom or top, +0xd7b);
 *      11 Fence:    +0xd90 -> FUN_00411710 attaches.
 *   - While an object is active and the player is grounded, its method
 *     0x42c runs every tick (FUN_0045fb20): Terminal -> isInUse = 1 and the
 *     use tick (FUN_00442f60). (Wire would set isInUse, but a wire user is
 *     never grounded, so Wire.isInUse stays 0.)
 *   - Hacking (FUN_0040c780 / FUN_0040c980): the body stands 2764.8 units
 *     in front of the terminal's point 1, facing it, on the ground below
 *     (FUN_00461ea0); counter limit = fistp("Hack Time (s)" x 30); the clip
 *     90 plays with typecomp_loop. Each tick the counter grows to the limit;
 *     at the limit with Activate still held (and alive) the terminal is
 *     hacked (FUN_004473f0: isHacked, isHackedThisTick, hack tick) with
 *     typecomp_end; releasing Activate (or dying) earlier aborts. Either way
 *     the use ends: weapon back, view unlocked, release, state 0.
 *   - Lock picking (FUN_0040bfe0 / FUN_0040c260) is the same with
 *     "Pick lock time (s)", picklock_loop / pickloop_end; at the end the door
 *     is marked picked (FUN_00446bd0) and toggled open. (Level 1 has no
 *     pickable door; the stance in front of the door, FUN_00473b30, is not
 *     ported.)
 */
import type { IAssetSource, Vec3 } from "../../contracts";
import {
  LEVEL1_PATHS,
  createHttpAssetSource,
  doorPose,
  eulerToMatrix,
  readAnimations,
  readIlffMembers,
  type AnimClip,
  type DoorState,
  type DoorTask,
  type IgiLevel,
  type IgiLevelPaths,
  type IgiTask,
} from "../../loaders";
import { numberParam, stringParam, vec3Param } from "../../loaders/tasks";
import { wirePose, type WireModelInfo } from "../../loaders/wire";
import { x87Fistp } from "../../loaders/x87";
import type { GameContext } from "../context";
import { AI_NOISE, AttachController, type AttachHost, type LoopSound } from "./attach";
import {
  USE_KIND,
  makeWire,
  searchUseTarget,
  terminalStance,
  useIconOf,
  useKindOf,
  type DoorTarget,
  type FenceTarget,
  type Ladder,
  type M3,
  type PanelTarget,
  type UseKind,
  type UseObject,
  type UseView,
  type V3,
  type Wire,
  ladderRungs,
} from "./use-objects";

const UNITS = 4096;

/** Extra engine events from the interactions (not in GameEvent yet; see docs/interactions.md "Hooks"). */
export const INTERACT_EVENTS = {
  /**
   * AI noise (FUN_0044fab0) from a ladder rung (type 14), a fence climb tick
   * (13) or a door the player opened (12): flags 0x46, range 20480 units.
   * payload: { type: number; flags: number; range: number; position: Vec3 (engine) }
   */
  Noise: "game:interact-noise",
  /** A use happened. payload: { kind: UseKind; object: string; taskId: number } */
  Used: "game:interact-used",
} as const;

/** Model data the use tests read: XTVM points and the HSEM origin radius. */
export interface ModelInfo {
  points: V3[];
  /** HSEM +0x78 (FUN_004c59a0). */
  radius: number;
}

/** Read HSEM +0x78 and the XTVM points of an ILFF/OCEM model; null when it is not one. */
export function readModelInfo(buffer: ArrayBuffer): ModelInfo | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 20) return null;
  const view = new DataView(buffer);
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (tag(0) !== "ILFF" || tag(16) !== "OCEM") return null;
  const align = (value: number, a: number) => (a > 1 ? Math.ceil(value / a) * a : value);
  let radius = 0;
  const points: V3[] = [];
  let pos = align(20, view.getUint32(8, true));
  for (let guard = 0; pos + 16 <= bytes.length && guard < 4096; guard++) {
    const size = view.getUint32(pos + 4, true);
    const offset = align(pos + 16, view.getUint32(pos + 8, true));
    const next = view.getUint32(pos + 12, true);
    if (offset + size > bytes.length) return null;
    if (tag(pos) === "HSEM" && size >= 0x7c) radius = view.getFloat32(offset + 0x78, true);
    if (tag(pos) === "XTVM") {
      for (let at = offset; at + 16 <= offset + size; at += 16) {
        points.push([view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true)]);
      }
    }
    if (next === 0) break;
    pos += next;
  }
  return { points, radius };
}

const baseName = (virtualName: string): string => {
  const slash = Math.max(virtualName.lastIndexOf("/"), virtualName.lastIndexOf("\\"), virtualName.lastIndexOf(":"));
  const file = slash >= 0 ? virtualName.slice(slash + 1) : virtualName;
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
};

/** Model info for `names` from the level's model archives (earlier archives win, as in loadIgiLevel). */
export async function loadModelInfo(raw: IAssetSource, names: Iterable<string>, paths: IgiLevelPaths = LEVEL1_PATHS): Promise<Map<string, ModelInfo>> {
  const wanted = new Set(names);
  const out = new Map<string, ModelInfo>();
  for (const archive of paths.archives) {
    if (out.size === wanted.size) break;
    if (!(await raw.exists(archive.models))) continue;
    for (const member of readIlffMembers(await raw.readBinary(archive.models))) {
      const name = baseName(member.name);
      if (!wanted.has(name) || out.has(name)) continue;
      const info = readModelInfo(member.payload);
      if (info) out.set(name, info);
    }
  }
  return out;
}

/** Models the use list and the pickups read. */
export function interactionModels(level: IgiLevel): Set<string> {
  const names = new Set<string>();
  for (const i of level.instances) if (i.magicType === "TASKTYPE_LADDER") names.add(i.model);
  for (const t of level.tasks) {
    const add = (key: string) => {
      const m = stringParam(t, key);
      if (m) names.add(m);
    };
    if (t.type === "Wire" || t.type === "Door" || t.type === "Fence" || t.type === "Terminal" || t.type === "AlarmControl" || t.type === "SCameraControl") add("Model");
    if (t.type === "Switch") ["On model", "Off model", "On pressed model", "Off pressed model"].forEach(add);
  }
  for (const w of level.weapons.values()) if (w.gunModel) names.add(w.gunModel);
  // AmmoPickup touch radius: the DefineAmmoType model's (FUN_0046c350).
  for (const a of level.ammoTypes?.values() ?? []) if (a.model) names.add(a.model);
  return names;
}

// --- engine <-> IGI ---------------------------------------------------------------

export function engineToIgi(level: { originIgi: Vec3 } | null, e: readonly number[]): V3 {
  const o = level?.originIgi ?? [0, 0, 0];
  return [e[0] * UNITS + o[0], -e[2] * UNITS + o[1], e[1] * UNITS + o[2]];
}

export function igiToEngine(level: { originIgi: Vec3 } | null, p: readonly number[]): Vec3 {
  const o = level?.originIgi ?? [0, 0, 0];
  return [(p[0] - o[0]) / UNITS, (p[2] - o[2]) / UNITS, -(p[1] - o[1]) / UNITS];
}

/** IGI rotation from an engine column-major 4x4 (inverse of engineMatrix4(igiRotationToEngine(R))). */
export function igiRotationFromEngineMatrix(m: readonly number[]): M3 {
  // Engine row-major E[r][c] = m[c*4 + r]; IGI R = C^T E C with C = [[1,0,0],[0,0,1],[0,-1,0]].
  const e = (r: number, c: number) => m[c * 4 + r];
  return [
    e(0, 0), -e(0, 2), e(0, 1),
    -e(2, 0), e(2, 2), -e(2, 1),
    e(1, 0), -e(1, 2), e(1, 1),
  ];
}

// --- the controller ------------------------------------------------------------------

/** Minimal runtime surface (loaders/mission.ts MissionRuntime) the uses touch. */
interface RuntimeLike {
  tasks: {
    nodes: Array<{ index: number; id: number; type: string; parent: number; task: IgiTask }>;
    doors: DoorTask[];
  };
  nodeState(index: number): Readonly<Record<string, unknown>>;
  doorStateAt(nodeIndex: number): DoorState | undefined;
  pressSwitch(id: number): void;
  useTerminal(id: number): void;
  hackTerminal(id: number): void;
  useDoor(nodeIndex: number): boolean;
  pickDoorLock(nodeIndex: number): void;
  evaluate(text: string): number;
}

export interface InteractionOptions {
  /** Where the model archives are read from (default "/raw/", as the enemy manager). */
  source?: IAssetSource;
  /**
   * Handle doors here (the recovered door test and use). Off by default while
   * game.ts still opens doors with its own ray (both would toggle the door).
   */
  doors?: boolean;
  /** Player body clips by id (default: parsed from the level's skeleton-0 animation file). */
  clips?: (id: number) => AnimClip | null;
}

export interface UseOutcome {
  kind: UseKind;
  object: UseObject;
}

export interface InteractionController {
  readonly attach: AttachController;
  /** Model data loaded for the current level. */
  readonly ready: boolean;
  /** The target of the last search (human+0x7b0). */
  readonly target: UseObject | null;
  /** HUD action icon of the target ("a_ladder.spr" ...), null when none. */
  readonly actionIcon: string | null;
  /** A timed use (hacking / lock picking) runs: counter / limit (the HUD progress bar, player +0xd64 / +0xd60). */
  readonly progress: number | null;
  /** In use (+0x7b8): attached, hacking or picking. */
  readonly busy: "attached" | "hacking" | "picking" | null;
  /** Yaw and pitch locked (+0x510, camera +0x138): attached or a timed use. */
  readonly viewLocked: boolean;
  /** The weapon is holstered (+0xd44). */
  readonly weaponHolstered: boolean;
  /** Heading the body is locked to while busy. */
  readonly lockedYaw: number | null;
  /** Start loading the level's model data (called lazily by search()). */
  load(): Promise<void>;
  reset(): void;
  /** FUN_0045fb20 target search; `grounded` = state flag 4. */
  search(grounded: boolean): void;
  /** Activate dispatch (FUN_0040ead0 -> FUN_0040ce30); returns the use or null. */
  activate(input: { held: boolean; blocked: boolean; pelvis: V3 }): UseOutcome | null;
  /** One tick of a timed use; true while it continues (the body stays put). `pelvis` in IGI units. */
  tickTimedUse(input: { held: boolean; dead: boolean; pelvis: V3 }): boolean;
  /** Release the active object (FUN_00462260): search back on, Activate latched until released. */
  release(): void;
  /** Stance of the current timed use (IGI pelvis before the ground snap, heading). */
  readonly stance: { position: V3; heading: number } | null;
  /** HSEM origin radius of a loaded model (pickup touch radius), null when unknown. */
  modelRadius(model: string): number | null;
}

export function createInteractions(ctx: GameContext, options: InteractionOptions = {}): InteractionController {
  const source = options.source ?? createHttpAssetSource("/raw/");
  let models: Map<string, ModelInfo> | null = null;
  let loadedFor: IgiLevel | null = null;
  let loading: Promise<void> | null = null;
  let staticObjects: Array<Ladder | Wire | FenceTarget | { kind: "dynamic"; nodeIndex: number; type: string }> = [];
  let target: UseObject | null = null;
  let ladderSide: "bottom" | "top" = "bottom";
  let active: UseObject | null = null;
  let busy: InteractionController["busy"] = null;
  /** +0x7b9: set by a release, cleared once Activate is up. */
  let latch = false;
  let counter = 0;
  let limit = 0;
  let loop: LoopSound | null = null;
  let stance: { position: V3; heading: number } | null = null;

  const level = () => ctx.level;
  const runtime = (): RuntimeLike | null => (ctx.systems.tasks as unknown as { runtime?: RuntimeLike | null } | null)?.runtime ?? null;
  const toEngine = (p: readonly number[]) => igiToEngine(level(), p);

  // --- sound / noise host -------------------------------------------------------
  type AudioLike = {
    playAt?(name: string, position: Vec3): unknown;
    attachTo?(name: string, actor: "player" | number): { kill?(): void } | null;
    play2D?(name: string): unknown;
    play?(name: string): void;
  };
  const audio = (): AudioLike | null => (ctx.systems.audio as unknown as AudioLike | null) ?? null;
  let parsed: { buffer: ArrayBuffer; clips: Map<number, AnimClip> } | null = null;
  const host: AttachHost = {
    clip(id) {
      if (options.clips) return options.clips(id);
      const buffer = ctx.level?.animations.get(0);
      if (!buffer) return null;
      if (parsed?.buffer !== buffer) parsed = { buffer, clips: readAnimations(buffer).clips };
      return parsed.clips.get(id) ?? null;
    },
    soundAt(name, position) {
      const a = audio();
      if (a?.playAt) a.playAt(name, toEngine(position));
      else a?.play?.(name);
    },
    soundOnPlayer(name) {
      const a = audio();
      if (a?.attachTo) a.attachTo(name, "player");
      else a?.play?.(name);
    },
    loopOnPlayer(name) {
      const h = audio()?.attachTo?.(name, "player") ?? null;
      return h ? { stop: () => h.kill?.() } : null;
    },
    noise(type, position) {
      ctx.events.emit(INTERACT_EVENTS.Noise, { type, flags: AI_NOISE.flags, range: AI_NOISE.range, position: toEngine(position) });
    },
  };
  const attach = new AttachController(host);

  // --- data ---------------------------------------------------------------------------
  function load(): Promise<void> {
    const lv = level();
    if (!lv) return Promise.resolve();
    if (loadedFor === lv && models) return Promise.resolve();
    if (loading && loadedFor === lv) return loading;
    loadedFor = lv;
    loading = loadModelInfo(source, interactionModels(lv), lv.paths)
      .then((m) => {
        if (loadedFor !== lv) return;
        models = m;
        build(lv);
      })
      .catch((error) => {
        console.warn("[interact] model data unavailable:", error);
        models = new Map();
        build(lv);
      });
    return loading;
  }

  function wireInfo(name: string): WireModelInfo | null {
    const m = models?.get(name);
    return m && m.points.length >= 2 ? { originRadius: m.radius, magicVertices: m.points.map((p) => [...p] as V3) } : null;
  }

  /** The use list in creation order (task pre-order; a building's ladders with it). */
  function build(lv: IgiLevel): void {
    staticObjects = [];
    const laddersByTask = new Map<number, typeof lv.instances>();
    for (const i of lv.instances) {
      if (i.magicType !== "TASKTYPE_LADDER" || i.taskIndex === undefined) continue;
      const list = laddersByTask.get(i.taskIndex) ?? [];
      list.push(i);
      laddersByTask.set(i.taskIndex, list);
    }
    lv.tasks.forEach((task, index) => {
      for (const inst of laddersByTask.get(index) ?? []) {
        const info = models?.get(inst.model);
        if (!info || info.points.length < 4) continue;
        const m = inst.matrix;
        const position = engineToIgi(lv, [m[12], m[13], m[14]]);
        staticObjects.push({
          kind: "ladder", model: inst.model, taskId: inst.taskId, position, rotation: igiRotationFromEngineMatrix(m),
          points: info.points, rungs: ladderRungs(info.points),
        });
      }
      switch (task.type) {
        case "Wire": {
          const model = stringParam(task, "Model");
          const start = vec3Param(task, "Start position");
          const stop = vec3Param(task, "Stop position");
          const info = model ? wireInfo(model) : null;
          const pose = start && stop ? wirePose(start, stop, info) : null;
          if (pose && info) staticObjects.push(makeWire(task.id, index, pose, info));
          break;
        }
        case "Fence": {
          const model = stringParam(task, "Model");
          const position = vec3Param(task, "Position");
          const info = model ? models?.get(model) : null;
          if (!position || !info || info.points.length < 2) break;
          staticObjects.push({
            kind: "fence", taskId: task.id, nodeIndex: index, position: [...position] as V3,
            rotation: eulerToMatrix(0, 0, numberParam(task, "Gamma") ?? 0) as M3, points: info.points, electric: false,
          });
          break;
        }
        case "Door":
          if (options.doors) staticObjects.push({ kind: "dynamic", nodeIndex: index, type: task.type });
          break;
        case "Switch":
        case "Terminal":
        case "AlarmControl":
        case "SCameraControl":
          staticObjects.push({ kind: "dynamic", nodeIndex: index, type: task.type });
          break;
      }
    });
  }

  /** No enclosing ConditionalContainer has left the world. */
  function nodeInWorld(rt: RuntimeLike | null, index: number): boolean {
    if (!rt || index < 0) return true;
    for (let n = rt.tasks.nodes[index]?.parent ?? -1; n >= 0; n = rt.tasks.nodes[n].parent) {
      if (rt.tasks.nodes[n].type === "ConditionalContainer" && rt.nodeState(n).inWorld === 0) return false;
    }
    return true;
  }

  const fenceElectric = (rt: RuntimeLike | null, fence: FenceTarget): boolean => {
    const task = level()?.tasks[fence.nodeIndex];
    const expr = task ? stringParam(task, "Electric Expression") : null;
    return !!(rt && expr && expr.trim() && rt.evaluate(expr) !== 0);
  };

  /** Resolve a dynamic entry to its current use object (null when it takes no part). */
  function dynamicObject(rt: RuntimeLike, nodeIndex: number, type: string): UseObject | null {
    const node = rt.tasks.nodes[nodeIndex];
    if (!node) return null;
    const task = node.task;
    const state = rt.nodeState(nodeIndex);
    if (type === "Door") {
      const door = rt.tasks.doors.find((d) => d.nodeIndex === nodeIndex);
      const s = door ? rt.doorStateAt(nodeIndex) : undefined;
      const info = door ? models?.get(door.model) : undefined;
      if (!door || !s || !info) return null;
      const pose = doorPose(door, s);
      const obj: DoorTarget = {
        kind: "door", taskId: door.id, nodeIndex, position: [...pose.position] as V3, rotation: [...pose.matrix] as M3,
        points: info.points, locked: s.isLocked, pickable: door.pickable,
      };
      return obj;
    }
    const position = vec3Param(task, "Position");
    if (!position) return null;
    const angles = vec3Param(task, "Orientation") ?? [0, 0, 0];
    const rotation = eulerToMatrix(angles[0], angles[1], angles[2]) as M3;
    if (type === "Switch") {
      const on = Number(state.isOn ?? 0) !== 0;
      const model = stringParam(task, on ? "On model" : "Off model");
      const info = model ? models?.get(model) : undefined;
      if (!info) return null;
      const obj: PanelTarget = {
        kind: "switch", type, taskId: node.id, nodeIndex, position: [...position] as V3, rotation, points: info.points,
        enabled: Number(state.isDestroyed ?? 0) === 0, hackSeconds: 0,
      };
      return obj;
    }
    const model = stringParam(task, "Model");
    const info = model ? models?.get(model) : undefined;
    if (!info) return null;
    const obj: PanelTarget = {
      kind: "terminal", type, taskId: node.id, nodeIndex, position: [...position] as V3, rotation, points: info.points,
      enabled: Number(state.isOn ?? 1) !== 0, hackSeconds: numberParam(task, "Hack Time (s)") ?? 4,
    };
    return obj;
  }

  function useList(): UseObject[] {
    const rt = runtime();
    const out: UseObject[] = [];
    for (const entry of staticObjects) {
      if (entry.kind === "dynamic") {
        if (!rt || !nodeInWorld(rt, entry.nodeIndex)) continue;
        const obj = dynamicObject(rt, entry.nodeIndex, entry.type);
        if (obj) out.push(obj);
      } else if (entry.kind === "fence") {
        if (!nodeInWorld(rt, entry.nodeIndex)) continue;
        entry.electric = fenceElectric(rt, entry);
        out.push(entry);
      } else if (entry.kind === "wire") {
        if (nodeInWorld(rt, entry.nodeIndex)) out.push(entry);
      } else {
        out.push(entry);
      }
    }
    return out;
  }

  /** Camera eye and axes (camera +0xe0 / +0xf8) from the engine camera. */
  function view(): UseView {
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements;
    const lv = level();
    const dir = (x: number, y: number, z: number): V3 => {
      const n = Math.hypot(x, y, z) || 1;
      return [x / n, -z / n, y / n];
    };
    const right = dir(e[0], e[1], e[2]);
    const up = dir(e[4], e[5], e[6]);
    const forward = dir(-e[8], -e[9], -e[10]);
    return {
      eye: engineToIgi(lv, [e[12], e[13], e[14]]),
      axes: [right[0], forward[0], up[0], right[1], forward[1], up[1], right[2], forward[2], up[2]],
    };
  }

  function search(grounded: boolean): void {
    target = null;
    if (!models || loadedFor !== level()) {
      void load();
      return;
    }
    // FUN_0045fb20: only grounded and not in use; then the active object's per-tick method.
    if (!grounded) return;
    if (!busy) {
      const r = searchUseTarget(view(), useList(), ladderSide);
      target = r.target;
      ladderSide = r.ladderSide;
    }
    if (active && active.kind === "terminal") runtime()?.useTerminal(active.taskId);
  }

  function release(): void {
    // FUN_00462260 (+ FUN_004622e0(human, 0) in the callers).
    busy = null;
    active = null;
    latch = true;
    stance = null;
    loop?.stop();
    loop = null;
  }

  function startTimed(kind: "hacking" | "picking", seconds: number, sound: string, at: { position: V3; heading: number } | null): void {
    busy = kind;
    counter = 0;
    limit = x87Fistp(Math.fround(seconds) * 30);
    stance = at;
    loop?.stop();
    loop = host.loopOnPlayer(sound);
  }

  function activate(input: { held: boolean; blocked: boolean; pelvis: V3 }): UseOutcome | null {
    if (input.blocked) return null;
    if (latch && !input.held) latch = false;
    if (!target || latch || !input.held || busy) return null;
    const obj = target;
    const kind = useKindOf(obj);
    active = obj;
    ctx.events.emit(INTERACT_EVENTS.Used, { kind, object: obj.kind, taskId: "taskId" in obj ? obj.taskId : -1 });
    const rt = runtime();
    switch (obj.kind) {
      case "switch":
        rt?.pressSwitch(obj.taskId);
        release();
        break;
      case "door":
        if (!obj.locked) {
          rt?.useDoor(obj.nodeIndex);
          host.noise(AI_NOISE.DOOR, input.pelvis);
          release();
        } else if (obj.pickable) {
          const door = rt?.tasks.doors.find((d) => d.nodeIndex === obj.nodeIndex);
          startTimed("picking", door?.pickLockSeconds ?? 0, "picklock_loop", null);
        }
        break;
      case "terminal":
        startTimed("hacking", obj.hackSeconds, "typecomp_loop", terminalStance(obj));
        break;
      case "wire":
        busy = "attached";
        attach.attachWire(obj, input.pelvis);
        break;
      case "ladder":
        busy = "attached";
        attach.attachLadder(obj, ladderSide);
        break;
      case "fence":
        busy = "attached";
        attach.attachFence(obj, input.pelvis);
        break;
    }
    target = null;
    return { kind, object: obj };
  }

  function tickTimedUse(input: { held: boolean; dead: boolean; pelvis: V3 }): boolean {
    if (busy !== "hacking" && busy !== "picking") return false;
    const obj = active;
    if (counter < limit) counter += 1;
    const going = !input.dead && input.held;
    if (counter === limit) {
      if (going && obj) {
        const rt = runtime();
        const at = input.pelvis;
        if (busy === "hacking" && obj.kind === "terminal") {
          rt?.hackTerminal(obj.taskId); // FUN_004473f0
          host.soundAt("typecomp_end", at);
        } else if (busy === "picking" && obj.kind === "door") {
          rt?.pickDoorLock(obj.nodeIndex); // FUN_00446bd0(door, 1)
          rt?.useDoor(obj.nodeIndex); // FUN_00446c10
          host.noise(AI_NOISE.DOOR, at); // FUN_0040c370
          host.soundAt("pickloop_end", at);
        }
      }
    } else if (going) {
      return true;
    }
    release();
    return false;
  }

  return {
    attach,
    get ready() {
      return !!models && loadedFor === level();
    },
    get target() {
      return target;
    },
    get actionIcon() {
      return target ? useIconOf(target) : null;
    },
    get progress() {
      return busy === "hacking" || busy === "picking" ? (limit > 0 ? counter / limit : 1) : null;
    },
    get busy() {
      return busy;
    },
    get viewLocked() {
      return busy !== null;
    },
    get weaponHolstered() {
      // FUN_0040c600 (+0xd44 = 1) on every attach and on hacking; not on lock picking.
      return busy === "attached" || busy === "hacking";
    },
    get lockedYaw() {
      if (busy === "attached") return attach.heading;
      return stance?.heading ?? null;
    },
    get stance() {
      return stance;
    },
    modelRadius(model) {
      return models?.get(model)?.radius ?? null;
    },
    load,
    reset() {
      attach.reset();
      target = null;
      active = null;
      busy = null;
      latch = false;
      ladderSide = "bottom";
      stance = null;
      loop?.stop();
      loop = null;
      if (models && loadedFor === level() && level()) build(level()!);
    },
    search,
    activate,
    tickTimedUse,
    release,
  };
}

export { USE_KIND };
