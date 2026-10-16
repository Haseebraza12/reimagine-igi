/**
 * The world task types of missions 3-14 in the engine (their task logic is in
 * loaders/objects/*, run by the MissionRuntime; docs: NOTES "world"):
 *
 *   - RotatingObject (L3 / L5 / L8 radar dishes): after every tick its placed
 *     model (a dynamic task, engine/level.ts MOVING_TASK_TYPES) is posed at
 *     Position x rotatingObjectMatrix() (FUN_00439090: +0x70 = Rz Ry Rx of the
 *     angles; Base = identity); render and collision follow, so bullets hit
 *     the dish where it is drawn. "Rotate sound" loops from the compile
 *     (FUN_004395d0 -> FUN_004e6b00) at Position, var 0 = the speed ratio;
 *   - AlarmLight: the lamp shows the model field the runtime selects
 *     (ALARM_LIGHT_MODEL; the destroyed lamp's "" = no model), skipping swaps
 *     to a model whose mesh, textures and collision equal the shown one
 *     (344_01_1 <-> 344_03_1 differ only by the ATTA, which the reflector does
 *     not depend on: it lives in the lamp's container from the compile); the
 *     reflector (the lamp instance's attachment "0", TASKTYPE_ALARMLIGHTREFLECTOR)
 *     turns to M_lamp M_attach Rx(theta) (FUN_00439b70) and is no longer drawn
 *     once the lamp is destroyed (FUN_00439ec0; its collision stays); while the
 *     lamp is on and intact the glow (FUN_00439f10) goes to fx/alarm-lights.ts:
 *     alarmlight.spr at the reflector + R x magic vertex 0 of its model, red
 *     alarmGlowRed(theta), half-size 6144 units, only when the camera is on
 *     the lamp's local +y side; "On sound" follows the runtime's flag;
 *   - Siren: "Working Sound" / "Faulty Sound" loops follow the runtime's flags
 *     (FUN_004494d0) at Position (sound host LAB_004497b0);
 *   - RainEffect: one Rain object per task (fx/rain.ts): a new RainSim at
 *     every mission start (the compile creates it), stepped once per task
 *     update (the runtime's `steps`), drawn for the main camera.
 * Bullets and explosions of AlarmLight / Siren: combat/object-damage.ts.
 */
import * as THREE from "three";
import type { DecodedTexture, IAssetSource, Vec3 } from "../../contracts";
import {
  ALARM_GLOW_HALF_SIZE,
  ALARM_LIGHT_MODEL_PARAMS,
  alarmGlowRed,
  decodeTex,
  igiPointToEngine,
  readIlffMembers,
  rainEffectParams,
  rotatingObjectMatrix,
  type IgiLevel,
  type LevelModel,
  type MissionRuntime,
} from "../../loaders";
import { engineMatrix4, igiRotationToEngine, type Mat3 } from "../../loaders/coords";
import type { GameContext } from "../context";
import { damageSystemOf } from "../combat/object-damage";
import type { AlarmLightQuad } from "../fx/alarm-lights";
import { RainSim, createRainRenderer, rainSessionRng, type RainRenderer } from "../fx/rain";
import { addSceneHook } from "../render/scene-hooks";
import { TRI_BULLET } from "./collision";

const UNITS = 4096;
/** The reflector's magic type (magicobj.qvm DefineMagicObj("344_02_1", ..., TASKTYPE_ALARMLIGHTREFLECTOR)). */
export const ALARM_REFLECTOR_MAGIC = "TASKTYPE_ALARMLIGHTREFLECTOR";
/** snow.tex, loaded by the RainEffect registration (FUN_00416930, LOCAL:common/textures/). */
export const SNOW_TEXTURE = "snow.tex";
const TEXTURES_RES = "common/textures/textures.res";

/** What world-tasks needs from the built world (world/world-builder.ts BuiltWorld). */
export interface WorldTasksWorld {
  readonly dynamicTasks: ReadonlySet<number>;
  setTaskTransform(key: number, matrix: ArrayLike<number>): void;
  setInstanceTransform(i: number, matrix: ArrayLike<number>, copy?: number): void;
  setInstanceModel(i: number, model: LevelModel | null): boolean;
  setInstanceHidden(i: number, hidden: boolean): void;
}

/** The sound side: an object's looping sounds (audio/igi-audio-system.ts objectSound). */
export interface WorldTasksAudio {
  objectSound(name: string, position: Vec3, vars?: readonly number[] | null): { update(position: Vec3, vars?: readonly number[] | null): void; dispose(): void; readonly alive: boolean } | null;
}

export interface WorldTasksDeps {
  runtime(): MissionRuntime | null;
  world(): WorldTasksWorld | null;
  audio?(): WorldTasksAudio | null;
  /** No enclosing ConditionalContainer has its subtree out of the world (mission-system inWorldNode). */
  inWorldNode?(node: number): boolean;
}

export interface WorldTasks {
  /** Level load: snow.tex and the Rain objects' renderers. */
  load(raw: IAssetSource, level: IgiLevel): Promise<void>;
  /** Use already loaded resources (tests). */
  attach(level: IgiLevel, snow: DecodedTexture | null): void;
  /** Mission start / restart (after the runtime is built): compile-time poses, models, sounds, new Rain objects. */
  reset(): void;
  /** After every game tick (after the damage system's endTick). */
  tick(): void;
  /** Glow quads of the switched-on lamps for fx/alarm-lights.ts (engine space; drawn when the camera faces their side). */
  alarmLightGlows(): AlarmLightQuad[];
  /** The Rain objects (diagnostics / tests). */
  readonly rains: ReadonlyArray<{ node: number; renderer: RainRenderer }>;
  dispose(): void;
}

const registry = new WeakMap<object, WorldTasks>();

/** The world-task system attached to a GameContext (game.ts creates and attaches it). */
export function worldTasksOf(ctx: object): WorldTasks | null {
  return registry.get(ctx) ?? null;
}

export function attachWorldTasks(ctx: object, system: WorldTasks | null): void {
  if (system) registry.set(ctx, system);
  else registry.delete(ctx);
}

/**
 * Collision vertices closer than this (engine metres) count as equal: 344_03_1's hull (set 1)
 * repeats 344_01_1's with four coordinates 0.0004 units (1e-7 m) apart [observed].
 */
const COLLISION_EPS_M = 1e-5;

/** Two models draw the same (positions, uvs, triangles, blocks and their textures) and collide the same (sets 0 / 1). */
export function sameModelContent(a: LevelModel | null, b: LevelModel | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const eq = (x: ArrayLike<number> | null, y: ArrayLike<number> | null, eps = 0) => {
    if (x === y) return true;
    if (!x || !y || x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!(Math.abs(x[i] - y[i]) <= eps)) return false;
    return true;
  };
  if (a.modelType !== b.modelType || !eq(a.positions, b.positions) || !eq(a.uv, b.uv) || !eq(a.indices, b.indices)) return false;
  if (a.groups.length !== b.groups.length) return false;
  for (let i = 0; i < a.groups.length; i++) {
    const g = a.groups[i];
    const h = b.groups[i];
    if (g.start !== h.start || g.count !== h.count || g.texture !== h.texture || (g.noMaterial ?? false) !== (h.noMaterial ?? false)) return false;
  }
  const ca = a.collision;
  const cb = b.collision;
  if (!ca || !cb) return ca === cb;
  for (let k = 0; k < 2; k++) {
    if (!eq(ca[k].positions, cb[k].positions, COLLISION_EPS_M) || !eq(ca[k].indices, cb[k].indices) || !eq(ca[k].material, cb[k].material)) return false;
  }
  return true;
}

interface RotatingEntry {
  node: number;
  position: Vec3;
  /** Placed instance (build pose: Position, identity) and its inverse. */
  inverse: THREE.Matrix4 | null;
  sound: string;
  handle: ReturnType<WorldTasksAudio["objectSound"]>;
  posed: string;
}

interface AlarmEntry {
  node: number;
  /** Lamp root instance, reflector instance (-1 when the model had none). */
  root: number;
  reflector: number;
  /** Reflector build matrix (engine, column-major) and its inverse. */
  build: THREE.Matrix4 | null;
  inverse: THREE.Matrix4 | null;
  /** Magic vertex 0 of the reflector model, engine model axes (metres). */
  magic: THREE.Vector3;
  /** Lamp origin and its local +y axis, engine space. */
  origin: Vec3;
  axisY: Vec3;
  /** Model field shown and its LevelModel (null = none). */
  shown: number;
  shownModel: LevelModel | null;
  veiled: boolean;
  theta: number;
  sound: string;
  handle: ReturnType<WorldTasksAudio["objectSound"]>;
}

interface SirenEntry {
  node: number;
  position: Vec3;
  working: string;
  faulty: string;
  workingHandle: ReturnType<WorldTasksAudio["objectSound"]>;
  faultyHandle: ReturnType<WorldTasksAudio["objectSound"]>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const vec = (v: unknown): Vec3 | null => (Array.isArray(v) && v.length === 3 ? [Number(v[0]), Number(v[1]), Number(v[2])] : null);

export function createWorldTasks(ctx: GameContext, deps: WorldTasksDeps): WorldTasks {
  let level: IgiLevel | null = null;
  let snow: DecodedTexture | null = null;
  let boundRuntime: MissionRuntime | null = null;
  let rotating: RotatingEntry[] = [];
  let alarms: AlarmEntry[] = [];
  let sirens: SirenEntry[] = [];
  let rains: Array<{ node: number; renderer: RainRenderer; consumed: number }> = [];
  const m4 = new THREE.Matrix4();
  const m4b = new THREE.Matrix4();
  const spin = new THREE.Matrix4();

  const audio = () => deps.audio?.() ?? null;
  const toEngine = (p: Vec3): Vec3 => igiPointToEngine(p, level!.originIgi);

  /** A model by name: placed ones from the level, the others from the damage data (built like the level's). */
  function modelNamed(name: string): LevelModel | null {
    if (!name || !level) return null;
    const placed = level.models.get(name) ?? level.models.get(name.toLowerCase());
    if (placed) return placed;
    return damageSystemOf(ctx)?.data?.models.get(name.toLowerCase()) ?? null;
  }

  function magicVertex(model: string, i: number): Vec3 {
    const m = damageSystemOf(ctx)?.data?.bounds.get(model.toLowerCase())?.magic[i];
    return m ? [m[0], m[1], m[2]] : [0, 0, 0];
  }

  // --- Rain objects: drawn for the main camera only (FUN_00498b80's pass test) ------------------
  const removeHook = ctx.scene
    ? addSceneHook(ctx.scene, (_renderer, _scene, camera) => {
        for (const r of rains) {
          if (camera === ctx.camera) r.renderer.draw(camera);
          else r.renderer.skip();
        }
      })
    : () => {};

  function castFloor(x: number, y: number, z: number, length: number): number | null {
    const w = ctx.world;
    if (!w || !level) return null;
    const o = level.originIgi;
    const hit = w.raycast((x - o[0]) / UNITS, (z - o[2]) / UNITS, -(y - o[1]) / UNITS, 0, -1, 0, length / UNITS, TRI_BULLET);
    return hit ? o[2] + hit.point[1] * UNITS : null;
  }

  function buildRains(lvl: IgiLevel): void {
    for (const r of rains) r.renderer.dispose();
    rains = [];
    lvl.tasks.forEach((task, node) => {
      if (task.type !== "RainEffect") return;
      const renderer = createRainRenderer({ originIgi: lvl.originIgi, cast: castFloor }, snow);
      ctx.scene?.add(renderer.object);
      rains.push({ node, renderer, consumed: 0 });
    });
  }

  // --- Binding to a runtime (mission start) ------------------------------------------------------
  function bind(rt: MissionRuntime): void {
    boundRuntime = rt;
    const lvl = level;
    if (!lvl) return;
    for (const r of rotating) r.handle?.dispose();
    for (const a of alarms) a.handle?.dispose();
    for (const s of sirens) {
      s.workingHandle?.dispose();
      s.faultyHandle?.dispose();
    }
    rotating = [];
    alarms = [];
    sirens = [];
    const rootOf = new Map<number, number>();
    const reflectorOf = new Map<number, number>();
    lvl.instances.forEach((inst, i) => {
      if (inst.taskIndex === undefined || inst.part !== undefined) return;
      const path = inst.attachmentPath ?? "";
      if (path === "" && !rootOf.has(inst.taskIndex)) rootOf.set(inst.taskIndex, i);
      if (inst.magicType === ALARM_REFLECTOR_MAGIC && !path.includes("/") && !reflectorOf.has(inst.taskIndex)) reflectorOf.set(inst.taskIndex, i);
    });
    for (const n of rt.tasks.nodes) {
      const p = n.task.params;
      if (n.type === "RotatingObject") {
        const position = vec(p["Position"]);
        if (!position) continue;
        const root = rootOf.get(n.index);
        rotating.push({
          node: n.index, position, inverse: root !== undefined ? new THREE.Matrix4().fromArray(lvl.instances[root].matrix).invert() : null,
          sound: str(p["Rotate sound"]), handle: null, posed: "",
        });
      } else if (n.type === "AlarmLight") {
        const position = vec(p["Position"]) ?? [0, 0, 0];
        const root = rootOf.get(n.index) ?? -1;
        const reflector = reflectorOf.get(n.index) ?? -1;
        const build = reflector >= 0 ? new THREE.Matrix4().fromArray(lvl.instances[reflector].matrix) : null;
        const v0 = reflector >= 0 ? magicVertex(lvl.instances[reflector].model, 0) : [0, 0, 0];
        // Lamp +0x108 column 1 (its local +y) in engine axes: IGI model y -> engine model -z.
        const rootMatrix = root >= 0 ? lvl.instances[root].matrix : null;
        const axisY: Vec3 = rootMatrix ? [-rootMatrix[8], -rootMatrix[9], -rootMatrix[10]] : [0, 0, -1];
        alarms.push({
          node: n.index, root, reflector, build, inverse: build ? build.clone().invert() : null,
          magic: new THREE.Vector3(v0[0] / UNITS, v0[2] / UNITS, -v0[1] / UNITS),
          origin: toEngine(position), axisY,
          shown: 0, shownModel: root >= 0 ? (lvl.models.get(lvl.instances[root].model) ?? null) : null,
          veiled: false, theta: 0, sound: str(p["On sound"]), handle: null,
        });
      } else if (n.type === "Siren") {
        const position = vec(p["Position"]);
        if (!position) continue;
        sirens.push({ node: n.index, position, working: str(p["Working Sound"]), faulty: str(p["Faulty Sound"]), workingHandle: null, faultyHandle: null });
      }
    }
    for (const r of rains) r.consumed = 0;
  }

  // --- Per type -----------------------------------------------------------------------------------
  function syncRotating(rt: MissionRuntime, world: WorldTasksWorld | null): void {
    for (const r of rotating) {
      const s = rt.nodeState(r.node);
      if (world && r.inverse && world.dynamicTasks.has(r.node)) {
        const posed = `${s.ax}|${s.ay}|${s.az}`;
        if (posed !== r.posed) {
          r.posed = posed;
          const rotation = rotatingObjectMatrix(s) as Mat3;
          m4.fromArray(engineMatrix4(igiRotationToEngine(rotation), toEngine(r.position)));
          m4b.multiplyMatrices(m4, r.inverse);
          world.setTaskTransform(r.node, m4b.elements);
        }
      }
      const vars = [s.var0 ?? 0];
      if (r.handle) r.handle.update(toEngine(r.position), vars);
    }
  }

  function syncAlarms(rt: MissionRuntime, world: WorldTasksWorld | null): void {
    const task = (node: number) => rt.tasks.nodes[node].task;
    for (const a of alarms) {
      const s = rt.nodeState(a.node);
      // The lamp's model field (FUN_004c48d0 on a transition or the destroy).
      const field = s.model ?? 0;
      if (field !== a.shown) {
        a.shown = field;
        const name = str(task(a.node).params[ALARM_LIGHT_MODEL_PARAMS[field] ?? "Off model"]);
        const next = modelNamed(name);
        if (!sameModelContent(next, a.shownModel) && world && a.root >= 0) {
          const placed = level ? (level.models.get(level.instances[a.root].model) ?? null) : null;
          // Back to the placed model: undo the swap; else show the new one (or none).
          if (next && sameModelContent(next, placed)) world.setInstanceModel(a.root, placed);
          else world.setInstanceModel(a.root, next);
        }
        a.shownModel = next;
      }
      // FUN_00439ec0: a destroyed lamp's reflector is no longer drawn.
      const veil = (s.isDestroyed ?? 0) !== 0;
      if (veil !== a.veiled && world && a.reflector >= 0) {
        a.veiled = veil;
        world.setInstanceHidden(a.reflector, veil);
      }
      // FUN_00439b70: M_lamp M_attach Rx(theta) about the reflector's origin.
      const theta = s.theta ?? 0;
      if (theta !== a.theta && world && a.reflector >= 0 && a.build && a.inverse && world.dynamicTasks.has(a.node)) {
        a.theta = theta;
        spin.makeRotationX(theta);
        m4.multiplyMatrices(a.build, spin).multiply(a.inverse);
        world.setInstanceTransform(a.reflector, m4.elements);
      }
      // "On sound" instance (+0x1f4).
      const want = (s.sound ?? 0) !== 0;
      if (want && !a.handle) a.handle = audio()?.objectSound(a.sound, a.origin) ?? null;
      else if (!want && a.handle) {
        a.handle.dispose();
        a.handle = null;
      }
    }
  }

  function syncSirens(rt: MissionRuntime): void {
    for (const sr of sirens) {
      const s = rt.nodeState(sr.node);
      const at = toEngine(sr.position);
      if ((s.working ?? 0) !== 0) sr.workingHandle ??= audio()?.objectSound(sr.working, at) ?? null;
      else if (sr.workingHandle) {
        sr.workingHandle.dispose();
        sr.workingHandle = null;
      }
      if ((s.faulty ?? 0) !== 0) sr.faultyHandle ??= audio()?.objectSound(sr.faulty, at) ?? null;
      else if (sr.faultyHandle) {
        sr.faultyHandle.dispose();
        sr.faultyHandle = null;
      }
    }
  }

  function stepRains(rt: MissionRuntime): void {
    for (const r of rains) {
      const sim = r.renderer.sim;
      const s = rt.nodeState(r.node);
      const steps = s.steps ?? 0;
      if (!sim) {
        r.consumed = steps;
        continue;
      }
      while (r.consumed < steps) {
        sim.active = s.active ?? 0;
        sim.step(rainSessionRng());
        r.consumed += 1;
      }
    }
  }

  const system: WorldTasks = {
    async load(raw, lvl) {
      let tex: DecodedTexture | null = null;
      if (lvl.tasks.some((t) => t.type === "RainEffect") && (await raw.exists(TEXTURES_RES))) {
        const member = readIlffMembers(await raw.readBinary(TEXTURES_RES)).find((m) => m.name.toLowerCase().endsWith(`/${SNOW_TEXTURE}`));
        if (member) tex = decodeTex(member.payload);
      }
      system.attach(lvl, tex);
    },
    attach(lvl, texture) {
      level = lvl;
      snow = texture;
      boundRuntime = null;
      buildRains(lvl);
    },
    reset() {
      const rt = deps.runtime();
      if (!rt || !level) return;
      bind(rt);
      const world = deps.world();
      // The compile poses: dishes at angle 0, reflectors at theta 0, lamps on their Off model, drawn.
      for (const r of rotating) {
        if (world?.dynamicTasks.has(r.node)) world.setTaskTransform(r.node, m4.identity().elements);
        r.posed = "";
        // FUN_004395d0: "Rotate sound" from the compile, for the object's life.
        if (r.sound) r.handle = audio()?.objectSound(r.sound, toEngine(r.position), [rt.nodeState(r.node).var0 ?? 0]) ?? null;
      }
      for (const a of alarms) {
        if (world && a.reflector >= 0) {
          world.setInstanceHidden(a.reflector, false);
          if (world.dynamicTasks.has(a.node)) world.setInstanceTransform(a.reflector, m4.identity().elements);
        }
      }
      // A new Rain object per RainEffect (FUN_00436a50 at load: the handle is 0).
      for (const r of rains) {
        const p = rainEffectParams(level.tasks[r.node]);
        r.renderer.reset(new RainSim({ snow: !p.isRain, alpha: p.alpha, traceStartM: p.traceStartM, traceEndM: p.traceEndM }));
        r.consumed = rt.nodeState(r.node).steps ?? 0;
      }
    },
    tick() {
      const rt = deps.runtime();
      if (!rt || !level) return;
      if (rt !== boundRuntime) system.reset();
      const world = deps.world();
      syncRotating(rt, world);
      syncAlarms(rt, world);
      syncSirens(rt);
      stepRains(rt);
    },
    alarmLightGlows() {
      const out: AlarmLightQuad[] = [];
      const rt = boundRuntime;
      if (!rt) return out;
      const v = new THREE.Vector3();
      for (const a of alarms) {
        if (a.reflector < 0 || !a.build) continue;
        const s = rt.nodeState(a.node);
        if (!s.isOn || s.isDestroyed) continue;
        if (deps.inWorldNode && !deps.inWorldNode(a.node)) continue;
        const theta = s.theta ?? 0;
        // Reflector + R(+0x70) x magic vertex 0 (FUN_00414e20).
        m4.multiplyMatrices(a.build, spin.makeRotationX(theta));
        v.copy(a.magic).applyMatrix4(m4);
        out.push({
          position: [v.x, v.y, v.z],
          rgb: [alarmGlowRed(theta), 0, 0],
          halfSize: ALARM_GLOW_HALF_SIZE / UNITS,
          facing: { origin: a.origin, axis: a.axisY },
        });
      }
      return out;
    },
    get rains() {
      return rains;
    },
    dispose() {
      removeHook();
      for (const r of rains) r.renderer.dispose();
      rains = [];
      for (const r of rotating) r.handle?.dispose();
      for (const a of alarms) a.handle?.dispose();
      for (const s of sirens) {
        s.workingHandle?.dispose();
        s.faultyHandle?.dispose();
      }
      rotating = [];
      alarms = [];
      sirens = [];
    },
  };
  return system;
}
