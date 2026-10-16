/**
 * The engine side of the full game's object tasks (docs/objects.md;
 * loaders/objects/*): their sounds, the moving elevator and what it
 * carries, picked-up GenericPickups leaving the world, the cabinet drawers,
 * the charge a PlaceExplosiveTBA moves, and the BinocularOverlayHolder flag.
 *
 * - Sounds (MissionHost.onTaskEvent): "sound" = a one-shot at a position
 *   (the task's, unless given), "loop" = an instanced definition kept per
 *   (node, slot) until "loop-stop" (FUN_004e6b00 / FUN_004e6c00); "follow"
 *   ones are children of the object and move with it, the elevator's are
 *   placed once (FUN_004e6c30 at creation [whether it follows: unknown]);
 *   "sound2d" = by name, 2-D (FUN_004e7200).
 * - Elevators: the model goes from its placement to the runtime pose; task
 *   children (switch, doors, ...) follow rigidly by current x compile^-1
 *   (message 0x547f40 [recovered handler list]).
 * - Drawer (FUN_00444260): the TASKTYPE_DRAWER sub-model of a cabinet sits at
 *   rest + R (0, slide, 0); render only (its collision stays with the cabinet).
 */
import * as THREE from "three";
import {
  elevatorRig,
  eulerToMatrix,
  mul3,
  transpose3,
  apply3,
  type IgiLevel,
  type Mat3,
  type MissionNode,
  type MissionRuntime,
  type TaskPose,
  type Vec3,
} from "../../loaders";
import { vec3Param } from "../../loaders/tasks";
import type { GameContext } from "../context";
import type { MissionWorld } from "./mission-system";

interface SoundObjectLike {
  update(position: Vec3): void;
  readonly alive: boolean;
  dispose(): void;
}
interface AudioLike {
  objectSound?(name: string, position: Vec3): SoundObjectLike | null;
  playAt?(name: string, position: Vec3): unknown;
  play2D?(name: string): unknown;
}

export interface ObjectPresenter {
  /** MissionHost.onTaskEvent. */
  event(node: MissionNode, event: string, data?: unknown): void;
  /** MissionHost.query. */
  query(name: string, ...args: unknown[]): unknown;
  /** After the runtime tick: follow-sounds to their objects. */
  tick(): void;
  /**
   * The rigid motion of the tasks carried by an elevator this tick (IGI): node -> carry(pose).
   * The world sync applies it to their models (doors compose it with their own motion).
   */
  carried(node: number): ((pose: TaskPose) => TaskPose) | null;
  /** World transforms of the elevators, carried children (not doors), drawers and placed charges. */
  sync(world: MissionWorld, poseToEngine: (pose: TaskPose, out: THREE.Matrix4) => THREE.Matrix4): void;
  /** A task left the world by its own logic (a picked-up GenericPickup). */
  hidden(node: number): boolean;
  /** State 36: the "Task ID to place" EditRigidObj moves to this IGI pose. */
  placeTask(taskId: number, position: Vec3, rotation: Mat3): void;
  /** Current pose of a moved / carried task (use tests, camera links), null when it never moved. */
  poseOf(node: number): TaskPose | null;
  /** A BinocularOverlayHolder is visible (the HUD draws the binocular overlay). */
  readonly binocularOverlay: boolean;
  start(level: IgiLevel, runtime: MissionRuntime): void;
  reset(): void;
}

const copyPose = (p: TaskPose): TaskPose => ({ position: [...p.position] as Vec3, matrix: [...p.matrix] as Mat3 });

/** The elevator ancestor of a node, or -1. */
function carrierOf(runtime: MissionRuntime, node: number): number {
  for (let n = runtime.tasks.nodes[node]?.parent ?? -1; n >= 0; n = runtime.tasks.nodes[n].parent) {
    if (runtime.tasks.nodes[n].type === "Elevator") return n;
  }
  return -1;
}

/** pose' = cur . comp^-1 . pose: a child that kept its offset from the compile pose (0x547f40). */
export function carryPose(current: TaskPose, compile: TaskPose, pose: TaskPose): TaskPose {
  const r = mul3(current.matrix, transpose3(compile.matrix));
  const d: Vec3 = [pose.position[0] - compile.position[0], pose.position[1] - compile.position[1], pose.position[2] - compile.position[2]];
  const o = apply3(r, d);
  return {
    position: [current.position[0] + o[0], current.position[1] + o[1], current.position[2] + o[2]],
    matrix: mul3(r, pose.matrix),
  };
}

export function createObjectPresenter(ctx: GameContext): ObjectPresenter {
  let runtime: MissionRuntime | null = null;
  let level: IgiLevel | null = null;
  const sounds = new Map<string, { object: SoundObjectLike; node: number; follow: boolean }>();
  const placed = new Map<number, TaskPose>();
  /** Inverse build matrix (engine) of each task's root instance. */
  const buildInverse = new Map<number, THREE.Matrix4 | null>();
  const tmp = new THREE.Matrix4();
  const tmp2 = new THREE.Matrix4();
  /** Last value sent to the world per node (unchanged ones are not re-posed: a task transform relights). */
  const sent = new Map<number, string>();
  const changed = (node: number, key: string): boolean => {
    if (sent.get(node) === key) return false;
    sent.set(node, key);
    return true;
  };
  const poseKey = (p: TaskPose): string => `${p.position.join(",")}|${p.matrix.join(",")}`;

  const audio = (): AudioLike | null => (ctx.systems.audio as unknown as AudioLike | null) ?? null;
  const toEngine = (p: readonly number[]): Vec3 => {
    const o = level?.originIgi ?? [0, 0, 0];
    return [(p[0] - o[0]) / 4096, (p[2] - o[2]) / 4096, -(p[1] - o[1]) / 4096];
  };

  /** The task's current IGI position (moved / carried pose, else its Position). */
  function positionOf(node: number): Vec3 {
    const pose = poseOf(node);
    if (pose) return pose.position;
    const task = runtime?.tasks.nodes[node]?.task;
    const p = task ? vec3Param(task, "Position") : null;
    return (p ? [...p] : [0, 0, 0]) as Vec3;
  }

  function poseOf(node: number): TaskPose | null {
    if (!runtime) return null;
    const n = runtime.tasks.nodes[node];
    if (!n) return null;
    if (n.type === "Elevator") return elevatorRig(runtime, node)?.pose ?? null;
    if (n.id >= 0 && placed.has(n.id)) return placed.get(n.id)!;
    const carrier = carrierOf(runtime, node);
    if (carrier < 0) return null;
    const rig = elevatorRig(runtime, carrier);
    const task = n.task;
    const p = vec3Param(task, "Position");
    if (!rig || !p) return null;
    const a = vec3Param(task, "Orientation") ?? [0, 0, 0];
    return carryPose(rig.pose, rig.compilePose, { position: [...p] as Vec3, matrix: eulerToMatrix(a[0], a[1], a[2]) });
  }

  function inverseBuild(node: number): THREE.Matrix4 | null {
    let m = buildInverse.get(node);
    if (m === undefined) {
      const inst = level?.instances.find((i) => i.taskIndex === node && i.attachmentPath === "");
      m = inst ? new THREE.Matrix4().fromArray(inst.matrix).invert() : null;
      buildInverse.set(node, m);
    }
    return m;
  }

  return {
    event(node, event, data) {
      const d = (data ?? {}) as { name?: string; slot?: string; position?: readonly number[]; follow?: boolean };
      const a = audio();
      if (!a) return;
      const key = `${node.index}:${d.slot ?? ""}`;
      switch (event) {
        case "sound": {
          if (!d.name) return;
          a.playAt?.(d.name, toEngine(d.position ?? positionOf(node.index)));
          return;
        }
        case "loop": {
          if (!d.name) return;
          sounds.get(key)?.object.dispose();
          sounds.delete(key);
          const object = a.objectSound?.(d.name, toEngine(d.position ?? positionOf(node.index))) ?? null;
          if (object) sounds.set(key, { object, node: node.index, follow: d.follow === true });
          return;
        }
        case "loop-stop": {
          sounds.get(key)?.object.dispose();
          sounds.delete(key);
          return;
        }
        case "sound2d": {
          if (d.name) a.play2D?.(d.name);
          return;
        }
      }
    },
    query(name, ...args) {
      if (name === "soundPlaying") {
        const s = sounds.get(`${args[0]}:${args[1] ?? ""}`);
        return !!s && s.object.alive;
      }
      return undefined;
    },
    tick() {
      for (const [key, s] of sounds) {
        if (!s.object.alive) {
          sounds.delete(key);
          continue;
        }
        if (s.follow) s.object.update(toEngine(positionOf(s.node)));
      }
    },
    carried(node) {
      if (!runtime) return null;
      const carrier = carrierOf(runtime, node);
      const rig = carrier >= 0 ? elevatorRig(runtime, carrier) : null;
      if (!rig) return null;
      const current = copyPose(rig.pose);
      const compile = rig.compilePose;
      return (pose) => carryPose(current, compile, pose);
    },
    sync(world, poseToEngine) {
      if (!runtime || !level) return;
      for (const n of runtime.tasks.nodes) {
        if (n.type === "Elevator") {
          const rig = elevatorRig(runtime, n.index);
          const inv = inverseBuild(n.index);
          if (!rig || !changed(n.index, poseKey(rig.pose))) continue;
          if (inv && world.dynamicTasks.has(n.index)) {
            world.setTaskTransform(n.index, tmp.multiplyMatrices(poseToEngine(rig.pose, tmp2), inv).elements);
          }
          // Carried children (doors compose their own motion in the door sync).
          {
            const delta = poseToEngine(rig.pose, new THREE.Matrix4()).multiply(poseToEngine(rig.compilePose, tmp2).invert());
            const walk = (i: number) => {
              for (const c of runtime!.tasks.nodes[i].children) {
                const child = runtime!.tasks.nodes[c];
                if (child.type !== "Door" && child.type !== "Elevator" && world.dynamicTasks.has(c)) world.setTaskTransform(c, delta.elements);
                if (child.type !== "Elevator") walk(c);
              }
            };
            walk(n.index);
          }
        } else if (n.type === "Cabinet" && world.dynamicTasks.has(n.index)) {
          const s = runtime.nodeState(n.index);
          const drawer = level.instances.findIndex((i) => i.taskIndex === n.index && i.magicType === "TASKTYPE_DRAWER");
          if (drawer < 0 || !changed(n.index, String(s.slide ?? 0))) continue;
          world.setTaskTransform(n.index, tmp.identity().elements);
          // rest + R (0, slide, 0): the drawer's own +y axis (its build matrix, engine column 2 = -IGI y).
          const m = level.instances[drawer].matrix;
          const slide = (s.slide ?? 0) / 4096;
          tmp.makeTranslation(-m[8] * slide, -m[9] * slide, -m[10] * slide);
          world.setInstanceTransform(drawer, tmp.elements);
        }
      }
      for (const [taskId, pose] of placed) {
        const node = runtime.tasks.byId.get(taskId);
        if (node === undefined || !world.dynamicTasks.has(node)) continue;
        const inv = inverseBuild(node);
        if (inv && changed(node, poseKey(pose))) world.setTaskTransform(node, tmp.multiplyMatrices(poseToEngine(pose, tmp2), inv).elements);
      }
    },
    hidden(node) {
      if (!runtime) return false;
      const n = runtime.tasks.nodes[node];
      return n?.type === "GenericPickup" && runtime.nodeState(node).inWorld === 0;
    },
    placeTask(taskId, position, rotation) {
      // FUN_0040d180: only an EditRigidObj (FUN_00401cf0 against "EditRigidObj").
      const node = runtime?.tasks.byId.get(taskId);
      if (node === undefined || runtime?.tasks.nodes[node].type !== "EditRigidObj") return;
      placed.set(taskId, { position: [...position] as Vec3, matrix: [...rotation] as Mat3 });
    },
    poseOf,
    get binocularOverlay() {
      if (!runtime) return false;
      for (const n of runtime.tasks.nodes) {
        if (n.type === "BinocularOverlayHolder" && runtime.nodeState(n.index).visible) return true;
      }
      return false;
    },
    start(next, rt) {
      this.reset();
      level = next;
      runtime = rt;
    },
    reset() {
      for (const s of sounds.values()) s.object.dispose();
      sounds.clear();
      placed.clear();
      buildInverse.clear();
      sent.clear();
      runtime = null;
      level = null;
    },
  };
}
