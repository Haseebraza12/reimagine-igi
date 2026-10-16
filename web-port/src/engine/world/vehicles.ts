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
 * Missions 2-14 (full exe, spec vehicles; addresses are full-exe): Plane tasks
 * (loaders/plane.ts PlaneSim: AnimTask-driven aerodynamics, gear contact, gear
 * / hatch / canopy / rudder sub-parts W = M L_atta R(part)); CarAI tasks
 * (loaders/car-ai.ts: patrol / attack driving of their Car, run at their node
 * by `taskUpdate`); the Car update FUN_0042e320 ("Can fire" perception
 * FUN_0042e870 with the VehicleDetector, the explosion FUN_0042e5a0 -> wreck,
 * isExploded); Heli "Play sound" / "Open door" (HeliDoor slide FUN_004273b0);
 * the vehicles' sound groups and parameter blocks; CRITERIA_VEHICLE objects.
 * ATTA child rotations are re-orthonormalised as FUN_004c4950 does
 * (vehicles.ts attaMatrix).
 *
 * Car wheels [recovered FUN_0042f8c0 / FUN_004a9680]: W = W_car Rz(steer)
 * Rx(spin) L_atta at (x, y, z + compression - suspension offset) of the
 * ATTA offset (CarSim.wheelPoses); the wheel collision stays with the truck
 * body (approximation: spin / steer / up to 0.3 m of compression are not
 * applied to the wheels' collision faces).
 */
import * as THREE from "three";
import { engineMatrix4, igiPointToEngine, igiRotationToEngine, mulMat3, mulMat3Vec } from "../../loaders/coords";
import type { IgiLevel, LevelInstance } from "../../loaders/level";
import type { AnimTaskData, Mat3, MissionRuntime, MissionTasks, TaskPose, TrainTask, Vec3 } from "../../loaders/mission";
import { railSplineFromTask } from "../../loaders/spline-segment";
import type { IgiTask } from "../../loaders/tasks";
import {
  CarSim,
  HeliSim,
  attaMatrix,
  eulerF,
  matMulF,
  placeTrain,
  rotX,
  rotZ,
  trainCar,
  vehicleParamsFromTask,
  type CarConfig,
  type GroundHit,
  type PhysicsObjType,
  type RailSpline,
  type RotorConfig,
  type TrainCar,
  type TrainCarPose,
  type VehicleBaseConfig,
  type VehicleWorld,
} from "../../loaders/vehicles";
import { PlaneSim, planeFlagsFromTask, type PlanePart } from "../../loaders/plane";
import {
  CarAi,
  VehicleDetector,
  patrolCommandsOf,
  vehicleInCone,
  type VehiclePerceivable,
} from "../../loaders/car-ai";
import { x87Fistp } from "../../loaders/x87";
import { x87StoreF32 } from "../../loaders/x87";
import { TRI_BULLET, type CollisionWorld } from "./collision";

const f32 = x87StoreF32;
const UNITS_PER_METRE = 4096;
/** FUN_0042b940: the drawn rotor angle is the stored angle times this (0x5316e8). */
export const ROTOR_DRAW_ANGLE_SCALE = Math.fround(21.362831115722656);
const FLAP_THRUST_MIN = Math.fround(-0.1); // 0x5316ec
const FLAP_SPEED_K = Math.fround(0.0263671875); // 0x531674
const FLAP_CFG_K = Math.fround(0.4); // 0x5315d8
/** 0x53367c: degrees -> radians (float). */
const DEG_F = Math.fround(0.01745329238474369);
/** 0x533680: m/s -> units/tick (4096 / 30). */
const DOOR_SPEED_K = Math.fround(136.53334045410156);

/** Where vehicles live in the built world (world-builder BuiltWorld). */
export interface VehicleWorldTarget {
  setTaskTransform(key: number, matrix: ArrayLike<number>): void;
  setInstanceTransform(i: number, matrix: ArrayLike<number>, copy?: number): void;
}

/** What the mounted weapons (combat/vehicle-weapons.ts) read of a Car / Heli (live values). */
export interface MountedVehicleView {
  readonly key: number;
  readonly id: number;
  readonly kind: "car" | "heli";
  readonly model: string;
  /** +0x20 / +0x70. */
  readonly position: Vec3;
  readonly matrix: Mat3;
  /** Body speed (+0xf8, approximate |v|, units/tick). */
  readonly speed: number;
  /** The "Can fire" perception (car +0xa90, heli +0x8c0; the "get detector" method 0x54127e). */
  readonly detector: VehicleDetector;
  /** A perception entry's object position (+0x20, FUN_004c3440), null when it is gone. */
  targetPosition(key: string | number): Vec3 | null;
  /** The car was replaced by its wreck (+0x2ed5): its children are gone. */
  readonly exploded: boolean;
}

/**
 * The attached magic children of a Car / Heli the vehicle system drives [recovered, full exe]:
 *   - create: FUN_004f4800 (ATTA children made, the vehicles' compile; the Heli's AnimTask
 *     nTick 0 re-creates them, FUN_00431b70 -> FUN_004f4820 / FUN_004f4800);
 *   - update: the children's update slot (MagicObjContainer update 0x488700 through
 *     FUN_004f4660 in the AnimTask input with nTick > 0 before the physics, and the Car
 *     update FUN_0042e320's own loop over +0xe8; `turretsOnly`: its extra pass over the
 *     AIStationaryGun children, FUN_00401be0 / FUN_00401c40 with type FUN_00470400, after
 *     placing them when the car was not driven this tick);
 *   - place: method 0x4d9fb0 with the vehicle's pose (the physics FUN_0042eca0 / FUN_00431e30
 *     end, the AnimTask nTick 0, the undriven Car update);
 *   - sync: their drawn poses after the vehicle's (render only).
 */
export interface MountedWeaponHooks {
  create(v: MountedVehicleView): void;
  update(v: MountedVehicleView, turretsOnly?: boolean): void;
  place(v: MountedVehicleView): void;
  sync?(v: MountedVehicleView, world: VehicleWorldTarget): void;
}

export interface VehicleSystemOptions {
  /** The level's collision world (ctx.world) for the vehicles' ground rays; null = no ground. */
  collision: () => CollisionWorld | null;
  /** The mission runtime, for the train distances. */
  runtime: () => MissionRuntime | null;
  /** Evaluate a task expression in float mode (MissionRuntime.evaluate); "Can fire", "Play sound", "Open door". */
  evaluate?(text: string): number;
  /** The humans of the detectable registry (task-tree order) the vehicle perception tracks. */
  humans?(): Iterable<VehiclePerceivable>;
  /** The AI sight ray from `from` to `point` (FUN_00489b20: no hit or see-through >= 0.79); `selfKey` = the vehicle's own body. */
  lineOfSight?(from: Vec3, point: Vec3, target: string | number, selfKey: number): boolean;
  /** The application tick the perception phases are tested against (FUN_00489750). */
  appTick?(): number;
  /** Perception phase handed out at the level load (mission-system perceptionPhases) / at a re-init. */
  phase?(node: number): number | undefined;
  nextPhase?(): number;
  /** Is the target (a registry key) dead (FUN_00463170)? Its position (+0x20)? */
  targetDead?(key: string | number): boolean;
  targetPosition?(key: string | number): Vec3 | null;
  /** The damage system's car flag (+0x91c: an explosion of weapon 12 reached the car, object-damage.ts). */
  carDamaged?(node: number): boolean;
  /** FUN_00480fe0: an explosion (IGI position, damage, radius / falloff / scorch in units, fragments, fireballs, delay ticks). */
  explode?(e: { position: Vec3; damage: number; radius: number; falloff: number; scorch: number; fragments: number; fireballs: number; delay: number; sound: string }): void;
  /** FUN_004f0ee0 + FUN_00401780: the wreck replaces the car (its pose frozen); null wreck = the car is just removed. */
  wreck?(carNode: number, wreckModel: string | null): void;
  /** One draw of the level RNG (FUN_00416d20). */
  random?(): number;
  /**
   * turrets: the vehicles' attached weapons (combat/vehicle-weapons.ts: AIStationaryGun turrets
   * on Car / Heli, Heli RocketPods), called at the exe's points (MountedWeaponHooks).
   */
  mounted?(): MountedWeaponHooks | null;
  /** FUN_004d0950: a model's bounding radius (units; object-damage.ts modelRadius). */
  modelRadius?(model: string): number;
  log?(message: string): void;
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

/**
 * HeliDoor child (class 0x4272a4 registration, full exe) [recovered]: params (axis 0/1/2, speed
 * m/s x 136.53 (0x533680) units/tick, distance m x 4096) (FUN_004277c0); the heli's "Open door"
 * sets its flag (FUN_00426d80, from FUN_004316d0); its update FUN_004273b0 slides d toward
 * distance (open) or 0 by speed; placement FUN_004274e0: the ATTA offset's `axis` component + d,
 * matrix M L_atta (no rotation).
 */
interface HeliDoor {
  instance: number;
  offset: Vec3;
  local: Mat3;
  axis: number;
  speed: number;
  distance: number;
  d: number;
  open: boolean;
}

interface HeliEntry {
  key: number;
  id: number;
  sim: HeliSim;
  root: number;
  rotors: RotorPart[];
  world: VehicleWorld;
  doors: HeliDoor[];
  /** "Open door" (+0x758) and "Play sound" (+0x7f8) expressions; the sound group "helicopter_1" runs while soundOn. */
  openDoor: string;
  playSound: string;
  soundOn: boolean;
  /**
   * turrets: "Can fire" (+0x7a8) and its result (+0x751); the perception +0x8c0 (compile
   * 0x4329dc: FUN_004896c0(1, 4, phase); cone +0x888 / +0x890 rad, +0x898 units).
   */
  canFireExpr: string;
  canFire: boolean;
  detector: VehicleDetector;
  cone: { alpha: number; gamma: number; length: number };
  phaseSet: boolean;
  view: MountedVehicleView;
}

interface CarEntry {
  key: number;
  id: number;
  sim: CarSim;
  root: number;
  /** Placed instance of each CarSim.wheelObjects entry (-1 = not placed) and its ATTA rotation. */
  wheels: Array<{ instance: number; local: Mat3 }>;
  world: VehicleWorld;
  state: CarState;
  /** turrets: the mounted-weapon view of this car. */
  view: MountedVehicleView;
}

interface PlaneEntry {
  key: number;
  id: number;
  sim: PlaneSim;
  root: number;
  /** Placed instance of each animated sub-part (gear, hatch, canopy, rudders). */
  parts: Array<{ part: PlanePart; instance: number }>;
  world: VehicleWorld;
  /** "Play sound" (+0x838): empty = always on; evaluated per update (FUN_00433690). */
  playSound: string;
  soundOn: boolean;
}

/** Car task state beyond the physics (full-exe Car class 0x42dcf0, spec vehicles §3.1). */
interface CarState {
  /** "Can fire" (+0x978) and its last result (+0x91d). */
  canFireExpr: string;
  canFire: boolean;
  /** "Play sound" (+0x9c8) result: the car's sound group runs (cfg +0x262). */
  playSoundExpr: string;
  soundOn: boolean;
  /** Perception +0xa90 (FUN_004896c0 at compile) and its cone (+0xa58 / +0xa60 rad, +0xa68 units). */
  detector: VehicleDetector;
  cone: { alpha: number; gamma: number; length: number };
  /** +0x91c destroyed, +0x920 explosion countdown, +0x2ed5 isExploded. */
  destroyed: boolean;
  countdown: number;
  exploded: boolean;
  /** The damage flag already turned into `destroyed` (the damage system keeps it set). */
  damageSeen: boolean;
  /** +0x2ecc: an input with nTick > 0 arrived this tick. */
  driven: boolean;
  /** The load phase (handed out after the runtime is built) was taken. */
  phaseSet: boolean;
}

interface CarAiEntry {
  key: number;
  id: number;
  ai: CarAi;
  /** The Car entry it drives (null: "Car ID" is no Car: inert). */
  car: CarEntry | null;
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
  /** turrets: `canFire` / `detector` = the heli's "Can fire" (+0x751) and perception (+0x8c0). */
  readonly helis: ReadonlyArray<{ id: number; key: number; sim: HeliSim; readonly canFire: boolean; readonly detector: VehicleDetector }>;
  readonly cars: ReadonlyArray<{ id: number; key: number; sim: CarSim; state: Readonly<CarState> }>;
  readonly planes: ReadonlyArray<{ id: number; key: number; sim: PlaneSim }>;
  readonly carAis: ReadonlyArray<{ id: number; key: number; ai: CarAi; car: { id: number; key: number } | null }>;
  /**
   * The update of a vehicle task at its place in the tree walk (before its children): Car
   * (FUN_0042e320: "Can fire" + perception, explosion), CarAI (FUN_00425de0: drives its car),
   * Plane (FUN_00433690: "Play sound"). Called by the mission system's updateTask.
   */
  taskUpdate(node: number): void;
  /**
   * turrets: the end of a Car's update FUN_0042e320 after its task children (the CarAI drove it):
   * the attached children's update loop, then when the car was not driven this tick (+0x2ecc)
   * their placement and the AIStationaryGun pass; +0x2ecc / +0x2ed0 cleared. Called by the
   * mission system's MissionHost.afterTaskChildren.
   */
  afterChildren(node: number): void;
  /** Car_<id>.isExploded (+0x2ed5). */
  isExploded(taskId: number): number;
  /** Pose of a vehicle by task node index (heli, car, plane, train locomotive), for riders such as Smoke. */
  nodePose(node: number): TaskPose | null;
  /**
   * Every Vehicle-class object (Train cars, Car, Heli, Plane: the classes derived from "Vehicle",
   * registration 0x4f4160.., full exe) with its node and position (+0x20): AreaActivate's
   * CRITERIA_VEHICLE handler FUN_004f4560 counts those inside the area. Exploded cars are gone.
   */
  areaVehicles(): Array<{ node: number; position: Vec3 }>;
  /** Per-tick sound state of the vehicles (group, position, param block) for the audio system. */
  sounds(): Array<{ key: number; group: string; position: Vec3; vars: number[]; on: boolean }>;
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
    local = mulMat3(local, attaMatrix(a.matrix));
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

/** turrets: a live MountedVehicleView over a car / heli entry. */
function mountedView(
  e: { key: number; id: number; sim: HeliSim | CarSim },
  kind: "car" | "heli",
  model: string,
  targetPosition: (key: string | number) => Vec3 | null,
): MountedVehicleView {
  const detectorOf = () => ("state" in e ? (e as CarEntry).state.detector : (e as HeliEntry).detector);
  return {
    key: e.key, id: e.id, kind, model, targetPosition,
    get position() { return e.sim.position; },
    get matrix() { return e.sim.matrix; },
    get speed() { return e.sim.body.speed; },
    get detector() { return detectorOf(); },
    get exploded() { return "state" in e ? (e as CarEntry).state.exploded : false; },
  };
}

export function createVehicleSystem(level: IgiLevel, tasks: MissionTasks, options: VehicleSystemOptions): VehicleSystem {
  const data = level.vehicles;
  const origin = level.originIgi;
  const byTask = instanceIndex(level);
  const helis: HeliEntry[] = [];
  const cars: CarEntry[] = [];
  const planes: PlaneEntry[] = [];
  const carAis: CarAiEntry[] = [];
  const trains: TrainEntry[] = [];
  const types: PhysicsObjType[] = data?.types ?? [];
  const keyOfTask = new Map<IgiTask, number>();
  tasks.nodes.forEach((n) => keyOfTask.set(n.task, n.index));

  if (data) {
    for (const node of tasks.nodes) {
      if (node.type !== "Heli" && node.type !== "Car" && node.type !== "Plane") continue;
      const paths = byTask.get(node.index);
      const root = paths?.get("");
      if (root === undefined) continue;
      const params = vehicleParamsFromTask(node.task);
      const model = data.models.get(params.model);
      if (!model) continue;
      const world = groundQuery(options.collision, origin, node.index);
      try {
        if (node.type === "Plane") {
          // Plane (full exe class FUN_004330f0): compile FUN_00434770 inside the PlaneSim constructor.
          const sim = new PlaneSim(params, types, model, data.magic, (n) => data.models.get(n), planeFlagsFromTask(node.task.params));
          const parts = sim.parts.filter((p) => p.kind !== "afterburner").map((part) => ({ part, instance: paths!.get(String(part.atta)) ?? -1 }));
          const playSound = String(node.task.params["Play sound"] ?? "");
          planes.push({ key: node.index, id: node.id, sim, root, parts, world, playSound, soundOn: false });
        } else if (node.type === "Heli") {
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
          const doors: HeliDoor[] = [];
          model.attachments.forEach((a, k) => {
            const mo = data.magic.get(a.name.toLowerCase());
            if (mo?.taskType !== "TASKTYPE_HELIDOOR") return;
            doors.push({
              instance: paths!.get(String(k)) ?? -1, offset: a.position.map(f32) as Vec3, local: attaMatrix(a.matrix), axis: mo.params[0] | 0,
              speed: f32(f32(mo.params[1]) * DOOR_SPEED_K), distance: f32(f32(mo.params[2]) * UNITS_PER_METRE), d: 0, open: false,
            });
          });
          const p = node.task.params;
          const numberOf = (k: string, d: number) => (typeof p[k] === "number" ? (p[k] as number) : d);
          const entry = {
            key: node.index, id: node.id, sim, root, rotors, world, doors, openDoor: String(p["Open door"] ?? ""), playSound: String(p["Play sound"] ?? ""), soundOn: false,
            // turrets: compile 0x43298e: cone alpha / gamma deg -> rad (0x53367c), length x 4096 (0x5333b8); create defaults 180 / 360 / 60 (0x4316a6..).
            canFireExpr: String(p["Can fire"] ?? ""), canFire: false, detector: new VehicleDetector(0), phaseSet: false,
            cone: {
              alpha: Math.fround(numberOf("ViewCone Alpha (degrees)", 180)) * DEG_F,
              gamma: Math.fround(numberOf("ViewCone Gamma (degrees)", 360)) * DEG_F,
              length: Math.fround(numberOf("ViewCone Length (meter)", 60)) * UNITS_PER_METRE,
            },
          } as Omit<HeliEntry, "view"> as HeliEntry;
          entry.view = mountedView(entry, "heli", params.model, (k) => options.targetPosition?.(k) ?? null);
          helis.push(entry);
        } else {
          const sim = new CarSim(params, types, model, data.magic);
          // CarSim.wheelObjects: the model's TASKTYPE_WHEEL attachments in ATTA order.
          const wheels: CarEntry["wheels"] = [];
          model.attachments.forEach((a, k) => {
            if (data.magic.get(a.name.toLowerCase())?.taskType !== "TASKTYPE_WHEEL") return;
            wheels.push({ instance: paths!.get(String(k)) ?? -1, local: attaMatrix(a.matrix) });
          });
          const p = node.task.params;
          const numberOf = (k: string, d: number) => (typeof p[k] === "number" ? (p[k] as number) : d);
          // Compile FUN_0042f530: cone alpha / gamma deg -> rad (0x53367c), length x 4096 (0x5333b8); create defaults 180 / 360 / 30.
          const state: CarState = {
            canFireExpr: String(p["Can fire"] ?? ""), canFire: false, playSoundExpr: String(p["Play sound"] ?? ""), soundOn: false,
            detector: new VehicleDetector(0),
            cone: {
              alpha: Math.fround(numberOf("ViewCone Alpha (degrees)", 180)) * DEG_F,
              gamma: Math.fround(numberOf("ViewCone Gamma (degrees)", 360)) * DEG_F,
              length: Math.fround(numberOf("ViewCone Length (meter)", 30)) * UNITS_PER_METRE,
            },
            destroyed: false, countdown: -1, exploded: false, damageSeen: false, driven: false, phaseSet: false,
          };
          const carEntry = { key: node.index, id: node.id, sim, root, wheels, world, state } as Omit<CarEntry, "view"> as CarEntry;
          carEntry.view = mountedView(carEntry, "car", params.model, (k) => options.targetPosition?.(k) ?? null);
          cars.push(carEntry);
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
  const planeById = new Map(planes.filter((p) => p.id >= 0).map((p) => [p.id, p]));
  const carByNode = new Map(cars.map((c) => [c.key, c]));
  const planeByNode = new Map(planes.map((p) => [p.key, p]));
  const heliByNode = new Map(helis.map((h) => [h.key, h]));

  // turrets: the vehicles' compiles create their ATTA children (FUN_004f4800): AIStationaryGun turrets
  // and RocketPods (combat/vehicle-weapons.ts), in task order, before the CarAI compiles drive them.
  {
    const hooks = options.mounted?.() ?? null;
    if (hooks) {
      const byNode = new Map<number, MountedVehicleView>([...cars.map((c) => [c.key, c.view] as const), ...helis.map((h) => [h.key, h.view] as const)]);
      for (const node of tasks.nodes) {
        const v = byNode.get(node.index);
        if (v) hooks.create(v);
      }
    }
  }

  // CarAI tasks (full exe FUN_00425c80): the Car / AIGraph / PatrolPath they name; compile FUN_004265a0
  // sends the reset input (nTick 0) to the car. The vehicle system exists before the runtime, so this
  // happens with the other compiles.
  for (const node of tasks.nodes) {
    if (node.type !== "CarAI") continue;
    const p = node.task.params;
    const idOf = (k: string) => (typeof p[k] === "number" ? (p[k] as number) : -1);
    const carNode = tasks.byId.get(idOf("Car ID"));
    const car = carNode !== undefined && tasks.nodes[carNode].type === "Car" ? carByNode.get(carNode) ?? null : null;
    const graph = data?.graphs?.get(idOf("Graph ID")) ?? null;
    const routeNode = tasks.byId.get(idOf("Route ID"));
    const route = routeNode !== undefined && tasks.nodes[routeNode].type === "PatrolPath" ? patrolCommandsOf(tasks.nodes[routeNode].task.children) : null;
    const ai = new CarAi(node.id, graph, idOf("Route ID") === -1 ? null : route ?? [], options.log);
    carAis.push({ key: node.index, id: node.id, ai, car });
    if (car) car.sim.animInput(0, CarAi.compileInput(), car.world);
  }
  const carAiByNode = new Map(carAis.map((c) => [c.key, c]));

  /** (char)fistp(eval(expr)) of a vehicle expression field; null when the field is empty (FUN_004f16c0 false). */
  const evalByte = (expr: string): number | null => {
    if (expr.trim() === "" || !options.evaluate) return null;
    return ((x87Fistp(options.evaluate(expr)) & 0xff) << 24) >> 24;
  };

  /** FUN_00489750 for a vehicle eye: only on its phase ticks are the registry humans collected and tested. */
  const perceive = (eyeKey: number, detector: VehicleDetector, eyePos: Vec3, matrix: Mat3, cone: CarState["cone"]) => {
    const tick = options.appTick?.() ?? 0;
    if ((tick & 3) !== detector.phase) return;
    const humans = options.humans ? [...options.humans()] : [];
    const eye = { position: eyePos, matrix, alpha: cone.alpha, gamma: cone.gamma, length: cone.length };
    detector.perceive(
      tick,
      humans,
      (o) => vehicleInCone(eye, o.point),
      (o) => options.lineOfSight?.(eyePos, o.point, o.key, eyeKey) ?? true,
    );
  };

  /**
   * FUN_0042e5a0 (the end of the car update; run at the start of its next update in the port):
   * destroyed -> explosions at the type's explosion vertices (1009_01_1 fragments, explo_03_l,
   * random delay < 30 ticks, wait 30) or one at the origin scaled by the bounding radius (x0.25,
   * x0.05, x0.005, wait 10); at 0 the wreck replaces the car and isExploded = 1 [recovered].
   */
  const carExplosion = (car: CarEntry) => {
    const st = car.state;
    if (!st.destroyed || st.exploded) return;
    const cfg = car.sim.config as CarConfig;
    if (st.countdown === -1) {
      const verts = cfg.explosionVertices ?? [];
      const m = car.sim.matrix;
      const pos = car.sim.position;
      if (verts.length > 0) {
        const mv = data?.models.get(car.sim.type.model)?.magicVertices ?? [];
        for (const v of verts) {
          const l = mv[v] ?? [0, 0, 0];
          const at: Vec3 = [pos[0] + (m[0] * l[0] + m[1] * l[1] + m[2] * l[2]), pos[1] + (m[3] * l[0] + m[4] * l[1] + m[5] * l[2]), pos[2] + (m[6] * l[0] + m[7] * l[1] + m[8] * l[2])];
          const delay = Math.floor((options.random?.() ?? 0) * 30);
          options.explode?.({ position: at, damage: 1, radius: 12288, falloff: 3072, scorch: 3072, fragments: 3, fireballs: 2, delay, sound: "explo_03_l" });
        }
        st.countdown = 30;
      } else {
        // FUN_004d0950(model) x the largest scale (1): the model's bounding radius.
        const r = options.modelRadius?.(car.sim.type.model) ?? car.sim.type.size.reduce((a, b) => Math.max(a, b), 0) * UNITS_PER_METRE * 0.5;
        options.explode?.({ position: [...pos] as Vec3, damage: 1, radius: Math.fround(r * 0.25), falloff: Math.fround(r * 0.05), scorch: Math.fround(r * 0.005), fragments: 3, fireballs: 1, delay: 0, sound: "explo_03_l" });
        st.countdown = 10;
      }
      return;
    }
    st.countdown -= 1;
    if (st.countdown === 0) {
      st.exploded = true;
      options.wreck?.(car.key, cfg.wreckModel || null);
    }
  };

  /** FUN_0042e320 (full exe) before the children: explosion step, "Play sound", "Can fire" + perception. */
  const carUpdate = (car: CarEntry) => {
    const st = car.state;
    carExplosion(car);
    if (st.exploded) return;
    if (!st.destroyed && !st.damageSeen && options.carDamaged?.(car.key)) {
      st.damageSeen = true;
      st.destroyed = true;
    }
    const sound = evalByte(st.playSoundExpr);
    st.soundOn = sound === null || sound !== 0;
    // FUN_0042e870: "Can fire" -> +0x91d; while set the perception runs with the eye 2 m above the origin.
    if (!st.phaseSet) {
      st.detector.phase = options.phase?.(car.key) ?? 0;
      st.phaseSet = true;
    }
    const fire = evalByte(st.canFireExpr);
    if (fire !== null) {
      const was = st.canFire;
      st.canFire = fire !== 0;
      if (st.canFire) {
        const p = car.sim.position;
        perceive(car.key, st.detector, [p[0], p[1], p[2] + 8192], car.sim.matrix, st.cone);
      } else if (was) {
        // FUN_00489b90 + FUN_004896c0: the falling edge clears the list and takes a new phase.
        st.detector.clear();
        st.detector.phase = options.nextPhase?.() ?? st.detector.phase;
      }
    }
    // turrets: +0x2ecc is cleared at the end of the update, after the children (afterChildren).
  };

  /** turrets: FUN_0042e320 after the task children: the attached children, then the undriven pass. */
  const carAfterChildren = (car: CarEntry) => {
    const st = car.state;
    const hooks = options.mounted?.() ?? null;
    if (!st.exploded && hooks) {
      hooks.update(car.view);
      if (!st.driven) {
        hooks.place(car.view);
        hooks.update(car.view, true);
      }
    }
    st.driven = false;
  };

  /** turrets: FUN_004316d0's "Can fire" (+0x7a8): the perception with the matrix turned by Rx(-pi/2) (FUN_004b34f0). */
  const heliCanFire = (heli: HeliEntry) => {
    if (!heli.phaseSet) {
      heli.detector.phase = options.phase?.(heli.key) ?? 0;
      heli.phaseSet = true;
    }
    const fire = evalByte(heli.canFireExpr);
    if (fire === null) return;
    const was = heli.canFire;
    heli.canFire = fire !== 0;
    if (heli.canFire) {
      // Eye = the heli's origin (+0x848), matrix = M Rx(0xbfc90fdb = -1.5707964) (+0x860), no secondary cone (+0x8b8 = 0).
      perceive(heli.key, heli.detector, [...heli.sim.position] as Vec3, matMulF(heli.sim.matrix, rotX(Math.fround(-1.5707963267948966))), heli.cone);
    } else if (was) {
      heli.detector.clear();
      heli.detector.phase = options.nextPhase?.() ?? heli.detector.phase;
    }
  };

  /** FUN_00425de0. */
  const carAiUpdate = (entry: CarAiEntry) => {
    const car = entry.car;
    const usable = car && !car.state.exploded ? car : null;
    const view = usable
      ? {
        position: usable.sim.position, matrix: usable.sim.matrix, speed: usable.sim.body.speed, thrust: usable.sim.thrust, canFire: usable.state.canFire,
        seen: () => {
          const k = usable.state.detector.seen();
          const at = k === null ? null : options.targetPosition?.(k) ?? null;
          return k === null || !at ? null : { key: k, position: at };
        },
      }
      : null;
    const out = entry.ai.update(view, {
      dead: (k) => options.targetDead?.(k) ?? false,
      position: (k) => options.targetPosition?.(k) ?? null,
    });
    if (out && usable) carInput(usable, out.nTick, out.channels);
  };

  /** The car's AnimTask input (FUN_0042ea10): nTick 0 also clears destroyed (+0x91c) and isExploded (+0x2ed5). */
  const carInput = (car: CarEntry, nTick: number, channels: Float32Array) => {
    if (car.state.exploded) return;
    const hooks = options.mounted?.() ?? null;
    if (nTick === 0) {
      car.state.destroyed = false;
      car.state.countdown = -1;
    } else {
      // turrets: 0x42ec0e: FUN_004f4660 (the attached children update) before +0x2ecc and the physics.
      hooks?.update(car.view);
      car.state.driven = true;
    }
    car.sim.animInput(nTick, channels, car.world);
    // turrets: the children placed at the pose (nTick 0: 0x42eb73; physics FUN_0042eca0's end).
    hooks?.place(car.view);
  };
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
    planes,
    carAis,
    trains,
    taskUpdate(node) {
      const car = carByNode.get(node);
      if (car) return carUpdate(car);
      const ai = carAiByNode.get(node);
      if (ai) return carAiUpdate(ai);
      const heli = heliByNode.get(node);
      if (heli) {
        // FUN_004316d0: "Play sound" 0 stops "helicopter_1"; "Open door" -> the HeliDoor flag (char).
        const v = evalByte(heli.playSound);
        heli.soundOn = v === null || v !== 0;
        const open = evalByte(heli.openDoor);
        if (open !== null) for (const d of heli.doors) d.open = open !== 0;
        heliCanFire(heli);
        return;
      }
      const plane = planeByNode.get(node);
      if (plane) {
        // FUN_00433690: "Play sound" evaluating to 0 stops the "su27" group, else it runs.
        const v = evalByte(plane.playSound);
        plane.soundOn = v === null || v !== 0;
      }
    },
    afterChildren(node) {
      const car = carByNode.get(node);
      if (car) carAfterChildren(car);
    },
    isExploded(taskId) {
      return carById.get(taskId)?.state.exploded ? 1 : 0;
    },
    nodePose(node) {
      const v = heliByNode.get(node) ?? carByNode.get(node) ?? planeByNode.get(node);
      if (v) return v.sim.pose();
      const t = trains.find((e) => e.train.nodeIndex === node);
      const pose = t ? trainPosesOf(t)?.[0] : null;
      return pose ? { position: [...pose.position] as Vec3, matrix: [...pose.matrix] as Mat3 } : null;
    },
    areaVehicles() {
      const out: Array<{ node: number; position: Vec3 }> = [];
      for (const h of helis) out.push({ node: h.key, position: h.sim.position });
      for (const c of cars) if (!c.state.exploded) out.push({ node: c.key, position: c.sim.position });
      for (const p of planes) out.push({ node: p.key, position: p.sim.position });
      for (const t of trains) trainPosesOf(t)?.forEach((pose, j) => out.push({ node: t.keys[j], position: pose.position }));
      return out;
    },
    sounds() {
      const out: Array<{ key: number; group: string; position: Vec3; vars: number[]; on: boolean }> = [];
      // Heli block +0x748 (FUN_004e6ab0(2), FUN_00431e30): thrust, playing (thrust > 0.01); group "helicopter_1".
      for (const h of helis) {
        const t = h.sim.thrust;
        out.push({ key: h.key, group: "helicopter_1", position: [...h.sim.position] as Vec3, vars: [t, t > 0.01 ? 1 : 0], on: h.soundOn });
      }
      // Plane block +0x828 (FUN_004e6ab0(2)): thrust, playing (thrust > 0.01); group "su27" (0x53bfcc).
      for (const p of planes) out.push({ key: p.key, group: "su27", position: [...p.sim.position] as Vec3, vars: [...p.sim.sound], on: p.soundOn });
      // Car block +0x74c (FUN_004e6ab0(3)): thrust, thrust > 0.01, min(1, speed x 0.001); group = config +0x262.
      for (const c of cars) {
        const cfg = c.sim.config as CarConfig;
        if (!cfg.sound) continue;
        const t = c.sim.thrust;
        out.push({ key: c.key, group: cfg.sound, position: [...c.sim.position] as Vec3, vars: [t, t > 0.01 ? 1 : 0, Math.min(1, c.sim.body.speed * 0.001)], on: c.state.soundOn && !c.state.exploded });
      }
      return out;
    },
    animInput(anim, nTick, channels) {
      const plane = planeById.get(anim.targetId);
      if (plane) {
        plane.sim.animInput(nTick, channels, plane.world);
        return;
      }
      const heli = heliById.get(anim.targetId);
      if (heli) {
        const before = heli.sim.thrust;
        const hooks = options.mounted?.() ?? null;
        // turrets: FUN_00431b70: nTick > 0 -> the attached children update (FUN_004f4660) before the physics.
        if (nTick > 0) hooks?.update(heli.view);
        heli.sim.animInput(nTick, channels, heli.world);
        // nTick 0 re-creates the ATTA children (FUN_004f4820 / FUN_004f4800); both end placing them.
        if (nTick === 0) hooks?.create(heli.view);
        hooks?.place(heli.view);
        if (nTick > 0) {
          // FUN_0042c750 on the child rotors (the hub's blades), after the hub, with the same thrust.
          for (const r of heli.rotors) if (r.simIndex < 0) r.angle = f32(r.copies * r.config.spin * before + r.angle);
          // FUN_004273b0: the attached HeliDoors update with the other children (FUN_004eb2c0).
          for (const d of heli.doors) {
            const goal = d.open ? d.distance : 0;
            if (d.d < goal) d.d = Math.min(f32(d.d + d.speed), goal);
            else if (d.d > goal) d.d = Math.max(f32(d.d - d.speed), goal);
          }
        }
        return;
      }
      const car = carById.get(anim.targetId);
      if (car) carInput(car, nTick, channels);
    },
    pose(taskId) {
      const vehicle = heliById.get(taskId) ?? carById.get(taskId) ?? planeById.get(taskId);
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
        for (const door of heli.doors) {
          if (door.instance < 0) continue;
          const off: Vec3 = [...door.offset] as Vec3;
          off[door.axis] = f32(off[door.axis] + door.d);
          const p = partPose(position, matrix, door.local, off, null);
          world.setInstanceTransform(door.instance, deltaFor(door.instance, p.position, p.matrix).elements);
        }
        for (const rotor of heli.rotors) {
          rotorCopies(heli, rotor).forEach((spin, k) => {
            const p = partPose(position, matrix, rotor.local, rotor.offset, spin);
            world.setInstanceTransform(rotor.instance, deltaFor(rotor.instance, p.position, p.matrix).elements, k);
          });
        }
        options.mounted?.()?.sync?.(heli.view, world);
      }
      for (const plane of planes) {
        const { position, matrix } = plane.sim;
        world.setTaskTransform(plane.key, deltaFor(plane.root, position, matrix).elements);
        // Sub-parts (FUN_00435a80 / FUN_004355a0 / FUN_00434f50 / FUN_004362c0): W = M L_atta R(part).
        for (const { part, instance } of plane.parts) {
          if (instance < 0) continue;
          const p = plane.sim.partWorld(part);
          world.setInstanceTransform(instance, deltaFor(instance, p.position, p.matrix).elements);
        }
      }
      for (const car of cars) {
        if (car.state.exploded) continue; // removed (FUN_00401780): the wreck stays where it was
        const { position, matrix } = car.sim;
        world.setTaskTransform(car.key, deltaFor(car.root, position, matrix).elements);
        car.sim.wheelPoses().forEach((w, k) => {
          const wheel = car.wheels[k];
          if (!wheel || wheel.instance < 0) return;
          // W = W_car Rz(steer) Rx(spin) L_atta at the adjusted ATTA offset (FUN_0042f8c0).
          const p = partPose(position, matrix, mulMat3(eulerF(w.spin, 0, w.steer), wheel.local), w.offset, null);
          world.setInstanceTransform(wheel.instance, deltaFor(wheel.instance, p.position, p.matrix).elements);
        });
        options.mounted?.()?.sync?.(car.view, world);
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
