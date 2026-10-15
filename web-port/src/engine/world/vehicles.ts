/**
 * Vehicles in the engine: the recovered helicopter, car and train simulations
 * of loaders/vehicles.ts (docs/vehicles.md) driven by the mission runtime,
 * and their placed models moved in the built world.
 *
 * Per 30 Hz tick [recovered, docs/vehicles.md sections 1, 8]:
 *   - MissionRuntime steps the AnimTasks in tree order; an AnimTask whose
 *     target is a Heli or Car calls `animInput` (MissionHost.onAnimInput),
 *     which runs that vehicle's reset (nTick 0) or physics tick with the
 *     AnimTask's channel buffer (the vehicle writes channels back). Trains
 *     are stepped inside the runtime (trainAnimInput); their cars are placed
 *     from `runtime.trainStateAt(node).distance` with placeTrain, so they
 *     run in a loop on the spline.
 *   - Vehicle ground rays (heli skids FUN_004317d0, car wheels FUN_0042e1a0)
 *     are vertical segments through the collision world's set-0 + terrain
 *     triangles (TRI_BULLET), skipping the vehicle's own body.
 *   - `sync` moves the render entries and collision bodies: rigidly per task
 *     (body, skids, glass, wagons), plus per instance for the rotors and the
 *     car wheels.
 * A vehicle whose AnimTask does not run (its container is out of the world)
 * keeps its state and does not move; the mission system hides it.
 *
 * Rotors [recovered FUN_0042c750 (update), FUN_0042c990 (attach), FUN_0042b940
 * (draw primitive, registered as "RotorPrimitive")]: each rotor object keeps
 * an angle a (+0x138) that grows by count x spin x thrust per tick (count =
 * the int at rotor config +0xc, spin = +0x8, thrust = the heli's thrust
 * before this tick's ramp). The rotor object itself sits rigidly at
 * W = W_parent L_atta (collision uses that pose); it is DRAWN `count` times
 * with W Rx(21.362831 a + k spin thrust) Rz(flap), k = 0..count-1 (a motion
 * blur fan; 0x5316e8 = 21.362831), flap = clamp(-clamp(1 - thrust, -0.1, 1)
 * arg - (z . v) 0.0263671875 arg / (cfg0 0.4), +-arg) with arg = rotor config
 * +0x4 (5 deg for the Bell's blades 711_02_1, 0 otherwise), z = the heli's
 * local z axis, v its velocity, cfg0 = heli config[0]. Child rotors (the
 * hub's two blades) are placed from the hub's unspun pose and spin by their
 * own angle. Level 1: hub 711_01_1 (1 copy, 0.1 rad/tick at thrust 1),
 * blades 711_02_1 x 2 (17 copies, 0.07), tail rotor 712_01_1 (10 copies,
 * 0.12) [observed]. That a child rotor's thrust is the heli's (+0x130) is
 * [inferred] (the rotor object is too small to hold +0x720 itself).
 *
 * Car wheels [recovered FUN_0042f8c0 / FUN_004a9680]: W = W_car Rz(steer)
 * Rx(spin) L_atta at (x, y, z + compression - suspension offset) of the
 * ATTA offset (CarSim.wheelPoses); the wheel collision stays with the truck
 * body (approximation: spin / steer / up to 0.3 m of compression are not
 * applied to the wheels' collision faces).
 */
import * as THREE from "three";
import { engineMatrix4, igiPointToEngine, igiRotationToEngine, mulMat3, mulMat3Vec, transposeMat3 } from "../../loaders/coords";
import type { IgiLevel, LevelInstance } from "../../loaders/level";
import type { AnimTaskData, Mat3, MissionRuntime, MissionTasks, TaskPose, TrainTask, Vec3 } from "../../loaders/mission";
import { railSplineFromTask } from "../../loaders/spline-segment";
import type { IgiTask } from "../../loaders/tasks";
import {
  CarSim,
  HeliSim,
  eulerF,
  matMulF,
  placeTrain,
  rotX,
  rotZ,
  trainCar,
  vehicleParamsFromTask,
  type GroundHit,
  type PhysicsObjType,
  type RailSpline,
  type RotorConfig,
  type TrainCar,
  type TrainCarPose,
  type VehicleBaseConfig,
  type VehicleWorld,
} from "../../loaders/vehicles";
import { x87StoreF32 } from "../../loaders/x87";
import { TRI_BULLET, type CollisionWorld } from "./collision";

const f32 = x87StoreF32;
const UNITS_PER_METRE = 4096;
/** FUN_0042b940: the drawn rotor angle is the stored angle times this (0x5316e8). */
export const ROTOR_DRAW_ANGLE_SCALE = Math.fround(21.362831115722656);
const FLAP_THRUST_MIN = Math.fround(-0.1); // 0x5316ec
const FLAP_SPEED_K = Math.fround(0.0263671875); // 0x531674
const FLAP_CFG_K = Math.fround(0.4); // 0x5315d8

/** Where vehicles live in the built world (world-builder BuiltWorld). */
export interface VehicleWorldTarget {
  setTaskTransform(key: number, matrix: ArrayLike<number>): void;
  setInstanceTransform(i: number, matrix: ArrayLike<number>, copy?: number): void;
}

export interface VehicleSystemOptions {
  /** The level's collision world (ctx.world) for the vehicles' ground rays; null = no ground. */
  collision: () => CollisionWorld | null;
  /** The mission runtime, for the train distances. */
  runtime: () => MissionRuntime | null;
}

interface RotorPart {
  /** Placed instance index of the rotor model. */
  instance: number;
  /** Rotation and offset relative to the vehicle frame (IGI, the ATTA chain as place() applies it). */
  local: Mat3;
  offset: Vec3;
  config: RotorConfig;
  /** Draw copies (rotor config +0xc). */
  copies: number;
  /** Index into HeliSim.rotors for the heli model's own rotors, -1 for child rotors (own angle). */
  simIndex: number;
  angle: number;
}

interface HeliEntry {
  key: number;
  id: number;
  sim: HeliSim;
  root: number;
  rotors: RotorPart[];
  world: VehicleWorld;
}

interface CarEntry {
  key: number;
  id: number;
  sim: CarSim;
  root: number;
  /** Placed instance of each CarSim.wheelObjects entry (-1 = not placed) and its ATTA rotation. */
  wheels: Array<{ instance: number; local: Mat3 }>;
  world: VehicleWorld;
}

interface TrainEntry {
  /** Locomotive task (node index = its key). */
  train: TrainTask;
  rail: RailSpline;
  cars: TrainCar[];
  /** Task key (node index) and root instance of each car. */
  keys: number[];
  roots: number[];
  cache: { distance: number; poses: TrainCarPose[] | null } | null;
}

export interface VehicleSystem {
  readonly helis: ReadonlyArray<{ id: number; key: number; sim: HeliSim }>;
  readonly cars: ReadonlyArray<{ id: number; key: number; sim: CarSim }>;
  readonly trains: ReadonlyArray<{ train: TrainTask; keys: readonly number[]; rail: RailSpline; cars: readonly TrainCar[] }>;
  /** MissionHost.onAnimInput: an AnimTask step for a Heli / Car target. */
  animInput(anim: AnimTaskData, nTick: number, channels: Float32Array): void;
  /** Current IGI pose of a vehicle task (heli, car, any train car with an id), or null when it is not a vehicle. */
  pose(taskId: number): TaskPose | null;
  /** Poses of a train's cars (locomotive first) at the runtime's current distance. */
  trainPoses(trainNodeIndex: number): TrainCarPose[] | null;
  /** Move the vehicles' render entries and collision bodies to their current poses. */
  sync(world: VehicleWorldTarget): void;
  /** Current engine-space world matrix (column-major) of every drawn copy of a placed instance, for tests. */
  instanceMatrices(i: number): number[][];
}

/** Placed-instance helpers keyed by task pre-order index. */
function instanceIndex(level: IgiLevel): Map<number, Map<string, number>> {
  const out = new Map<number, Map<string, number>>();
  level.instances.forEach((inst, i) => {
    if (inst.taskIndex === undefined) return;
    let paths = out.get(inst.taskIndex);
    if (!paths) {
      paths = new Map();
      out.set(inst.taskIndex, paths);
    }
    if (!paths.has(inst.attachmentPath ?? "")) paths.set(inst.attachmentPath ?? "", i);
  });
  return out;
}

/** Rotation and offset of an ATTA path below `model` (place(): offset += R a.position, R = R a.matrix^T). */
function attachmentChain(level: IgiLevel, model: string, path: string): { local: Mat3; offset: Vec3 } | null {
  let local: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let offset: Vec3 = [0, 0, 0];
  let current = model;
  for (const part of path.split("/").filter((p) => p !== "")) {
    const data = level.vehicles?.models.get(current);
    const a = data?.attachments[Number(part)];
    if (!a) return null;
    const d = mulMat3Vec(local, a.position as Vec3);
    offset = [offset[0] + d[0], offset[1] + d[1], offset[2] + d[2]];
    local = mulMat3(local, transposeMat3(a.matrix as Mat3));
    current = a.name;
  }
  return { local, offset };
}

/** Render copies per placed instance for world-builder `renderCopies` (rotor blur fans). */
export function vehicleRenderCopies(level: IgiLevel): Map<number, number> {
  const out = new Map<number, number>();
  const types = level.vehicles?.types ?? [];
  level.instances.forEach((inst, i) => {
    if (inst.magicType !== "TASKTYPE_ROTOR") return;
    const type = types.find((t) => t.model.toLowerCase() === inst.model.toLowerCase());
    const count = type ? Math.trunc((type.config as RotorConfig).spinSign ?? 1) : 1;
    if (count > 1) out.set(i, count - 1);
  });
  return out;
}

/** Ground rays of one vehicle: vertical segments through set 0 + terrain, the vehicle's own body skipped. */
function groundQuery(collision: () => CollisionWorld | null, origin: Vec3, ownBody: number): VehicleWorld {
  return {
    castDown(x, y, top, bottom): GroundHit | null {
      const world = collision();
      if (!world) return null;
      const o = igiPointToEngine([x, y, top], origin);
      const hit = world.raycast(o[0], o[1], o[2], 0, -1, 0, (top - bottom) / UNITS_PER_METRE, TRI_BULLET, undefined, ownBody);
      if (!hit) return null;
      // Engine (x, y, z) = IGI (x, z, -y).
      return { distance: hit.distance * UNITS_PER_METRE, normal: [hit.normal[0], -hit.normal[2], hit.normal[1]] };
    },
  };
}

export function createVehicleSystem(level: IgiLevel, tasks: MissionTasks, options: VehicleSystemOptions): VehicleSystem {
  const data = level.vehicles;
  const origin = level.originIgi;
  const byTask = instanceIndex(level);
  const helis: HeliEntry[] = [];
  const cars: CarEntry[] = [];
  const trains: TrainEntry[] = [];
  const types: PhysicsObjType[] = data?.types ?? [];
  const keyOfTask = new Map<IgiTask, number>();
  tasks.nodes.forEach((n) => keyOfTask.set(n.task, n.index));

  if (data) {
    for (const node of tasks.nodes) {
      if (node.type !== "Heli" && node.type !== "Car") continue;
      const paths = byTask.get(node.index);
      const root = paths?.get("");
      if (root === undefined) continue;
      const params = vehicleParamsFromTask(node.task);
      const model = data.models.get(params.model);
      if (!model) continue;
      const world = groundQuery(options.collision, origin, node.index);
      try {
        if (node.type === "Heli") {
          const sim = new HeliSim(params, types, model, data.magic);
          const rotors: RotorPart[] = [];
          let top = 0;
          for (const [path, i] of paths!) {
            const inst = level.instances[i];
            if (inst.magicType !== "TASKTYPE_ROTOR") continue;
            const chain = attachmentChain(level, params.model, path);
            const type = types.find((t) => t.model.toLowerCase() === inst.model.toLowerCase());
            if (!chain || !type) continue;
            const config = type.config as RotorConfig;
            const isTop = !path.includes("/");
            rotors.push({ instance: i, local: chain.local, offset: chain.offset, config, copies: Math.max(1, Math.trunc(config.spinSign)), simIndex: isTop ? top++ : -1, angle: 0 });
          }
          helis.push({ key: node.index, id: node.id, sim, root, rotors, world });
        } else {
          const sim = new CarSim(params, types, model, data.magic);
          // CarSim.wheelObjects: the model's TASKTYPE_WHEEL attachments in ATTA order.
          const wheels: CarEntry["wheels"] = [];
          model.attachments.forEach((a, k) => {
            if (data.magic.get(a.name.toLowerCase())?.taskType !== "TASKTYPE_WHEEL") return;
            wheels.push({ instance: paths!.get(String(k)) ?? -1, local: transposeMat3(a.matrix as Mat3) });
          });
          cars.push({ key: node.index, id: node.id, sim, root, wheels, world });
        }
      } catch (error) {
        console.info(`[vehicles] ${node.type} ${node.id}: ${(error as Error).message}`);
      }
    }
    // Trains: the locomotives (Train tasks whose parent is not a Train) and their wagons.
    const rails = new Map<number, RailSpline | null>();
    for (const train of tasks.trains) {
      const node = tasks.nodes[train.nodeIndex];
      if (node.parent >= 0 && tasks.nodes[node.parent].type === "Train") continue;
      let rail = rails.get(train.railroadTaskId);
      if (rail === undefined) {
        const splineNode = tasks.byId.get(train.railroadTaskId);
        rail = splineNode !== undefined && tasks.nodes[splineNode].type === "SplineObj" ? railSplineFromTask(tasks.nodes[splineNode].task) : null;
        rails.set(train.railroadTaskId, rail);
      }
      if (!rail) continue;
      const carNodes = [train.nodeIndex, ...node.children.filter((c) => tasks.nodes[c].type === "Train")];
      const entry: TrainEntry = { train, rail, cars: [], keys: [], roots: [], cache: null };
      let ok = true;
      for (const c of carNodes) {
        const task = tasks.nodes[c].task;
        const modelName = String(task.params["Model"] ?? "");
        const model = data.models.get(modelName);
        if (!model || model.magicVertices.length < 2) {
          ok = false;
          break;
        }
        entry.cars.push(trainCar(task.id, modelName, model.magicVertices, [Number(task.params["Displacement X"] ?? 0), Number(task.params["Displacement Y"] ?? 0)]));
        entry.keys.push(c);
        entry.roots.push(byTask.get(c)?.get("") ?? -1);
      }
      if (ok) trains.push(entry);
    }
  }

  const heliById = new Map(helis.filter((h) => h.id >= 0).map((h) => [h.id, h]));
  const carById = new Map(cars.filter((c) => c.id >= 0).map((c) => [c.id, c]));
  /** Train car task id -> (train entry, car index). */
  const trainCarById = new Map<number, { entry: TrainEntry; car: number }>();
  for (const entry of trains) entry.cars.forEach((c, j) => c.id >= 0 && trainCarById.set(c.id, { entry, car: j }));

  const trainPosesOf = (entry: TrainEntry): TrainCarPose[] | null => {
    const state = options.runtime()?.trainStateAt(entry.train.nodeIndex);
    const distance = state ? state.distance : entry.train.distance;
    if (!entry.cache || entry.cache.distance !== distance) {
      entry.cache = { distance, poses: placeTrain(entry.rail, entry.cars, distance, entry.train.flipDirection) };
    }
    return entry.cache.poses;
  };

  // --- Engine matrices ----------------------------------------------------------
  const inverseBuild = new Map<number, THREE.Matrix4>();
  const buildInverse = (i: number): THREE.Matrix4 => {
    let m = inverseBuild.get(i);
    if (!m) {
      m = new THREE.Matrix4().fromArray(level.instances[i].matrix).invert();
      inverseBuild.set(i, m);
    }
    return m;
  };
  const current = new THREE.Matrix4();
  const delta = new THREE.Matrix4();
  /** Engine 4x4 of an IGI pose. */
  const engineOf = (position: Vec3, matrix: Mat3, out: THREE.Matrix4): THREE.Matrix4 =>
    out.fromArray(engineMatrix4(igiRotationToEngine(matrix), igiPointToEngine(position, origin)));
  /** delta = E(pose) B_i^-1: maps instance i's build pose to `pose`. */
  const deltaFor = (i: number, position: Vec3, matrix: Mat3): THREE.Matrix4 =>
    delta.multiplyMatrices(engineOf(position, matrix, current), buildInverse(i));

  /** World pose of a part rigidly attached at (local, offset) to a vehicle pose, with an extra local rotation. */
  const partPose = (pos: Vec3, rot: Mat3, local: Mat3, offset: Vec3, extra: Mat3 | null): { position: Vec3; matrix: Mat3 } => {
    const d = mulMat3Vec(rot, offset);
    const m = mulMat3(rot, local);
    return { position: [pos[0] + d[0], pos[1] + d[1], pos[2] + d[2]], matrix: extra ? mulMat3(m, extra) : m };
  };

  /** FUN_0042b940: the drawn copies of a rotor (Rx(spin angle) Rz(flap) after its unspun pose). */
  const rotorCopies = (heli: HeliEntry, rotor: RotorPart): Mat3[] => {
    const sim = heli.sim;
    const thrust = sim.thrust;
    const angle = rotor.simIndex >= 0 ? sim.rotors[rotor.simIndex].angle : rotor.angle;
    const arg = rotor.config.arg3;
    const m = sim.matrix;
    const v = sim.body.velocity;
    const c0 = (sim.config as VehicleBaseConfig).c[0];
    let lift = 1 - thrust;
    if (!(FLAP_THRUST_MIN <= lift)) lift = FLAP_THRUST_MIN;
    else if (1 < lift) lift = 1;
    const flapRaw = -(lift * arg) - ((m[2] * v[0] + m[5] * v[1] + m[8] * v[2]) * FLAP_SPEED_K * arg) / (c0 * FLAP_CFG_K);
    const flap = f32(Math.max(-arg, Math.min(arg, flapRaw)));
    const step = f32(rotor.config.spin * thrust);
    const flapM = rotZ(flap);
    const out: Mat3[] = [];
    let a = f32(angle * ROTOR_DRAW_ANGLE_SCALE);
    for (let k = 0; k < rotor.copies; k++) {
      out.push(matMulF(rotX(a), flapM));
      a = f32(a + step);
    }
    return out;
  };

  const system: VehicleSystem = {
    helis,
    cars,
    trains,
    animInput(anim, nTick, channels) {
      const heli = heliById.get(anim.targetId);
      if (heli) {
        const before = heli.sim.thrust;
        heli.sim.animInput(nTick, channels, heli.world);
        if (nTick > 0) {
          // FUN_0042c750 on the child rotors (the hub's blades), after the hub, with the same thrust.
          for (const r of heli.rotors) if (r.simIndex < 0) r.angle = f32(r.copies * r.config.spin * before + r.angle);
        }
        return;
      }
      const car = carById.get(anim.targetId);
      if (car) car.sim.animInput(nTick, channels, car.world);
    },
    pose(taskId) {
      const vehicle = heliById.get(taskId) ?? carById.get(taskId);
      if (vehicle) return vehicle.sim.pose();
      const car = trainCarById.get(taskId);
      if (!car) return null;
      const pose = trainPosesOf(car.entry)?.[car.car];
      return pose ? { position: [...pose.position] as Vec3, matrix: [...pose.matrix] as Mat3 } : null;
    },
    trainPoses(trainNodeIndex) {
      const entry = trains.find((t) => t.train.nodeIndex === trainNodeIndex);
      return entry ? trainPosesOf(entry) : null;
    },
    sync(world) {
      for (const heli of helis) {
        const { position, matrix } = heli.sim;
        world.setTaskTransform(heli.key, deltaFor(heli.root, position, matrix).elements);
        for (const rotor of heli.rotors) {
          rotorCopies(heli, rotor).forEach((spin, k) => {
            const p = partPose(position, matrix, rotor.local, rotor.offset, spin);
            world.setInstanceTransform(rotor.instance, deltaFor(rotor.instance, p.position, p.matrix).elements, k);
          });
        }
      }
      for (const car of cars) {
        const { position, matrix } = car.sim;
        world.setTaskTransform(car.key, deltaFor(car.root, position, matrix).elements);
        car.sim.wheelPoses().forEach((w, k) => {
          const wheel = car.wheels[k];
          if (!wheel || wheel.instance < 0) return;
          // W = W_car Rz(steer) Rx(spin) L_atta at the adjusted ATTA offset (FUN_0042f8c0).
          const p = partPose(position, matrix, mulMat3(eulerF(w.spin, 0, w.steer), wheel.local), w.offset, null);
          world.setInstanceTransform(wheel.instance, deltaFor(wheel.instance, p.position, p.matrix).elements);
        });
      }
      for (const entry of trains) {
        const poses = trainPosesOf(entry);
        if (!poses) continue;
        poses.forEach((pose, j) => {
          const root = entry.roots[j];
          if (root >= 0) world.setTaskTransform(entry.keys[j], deltaFor(root, pose.position, pose.matrix).elements);
        });
      }
    },
    instanceMatrices(i) {
      const out: number[][] = [];
      const capture: VehicleWorldTarget = {
        setTaskTransform() {},
        setInstanceTransform(index, m, copy = 0) {
          if (index === i) out[copy] = new THREE.Matrix4().fromArray(Array.from(m)).multiply(new THREE.Matrix4().fromArray(level.instances[i].matrix)).toArray();
        },
      };
      system.sync(capture);
      return out;
    },
  };
  return system;
}

/** Placed instances of a vehicle task (tests, debugging). */
export function instancesOfTask(level: IgiLevel, key: number): LevelInstance[] {
  return level.instances.filter((i) => i.taskIndex === key);
}
