/**
 * Mission task runtime of Project I.G.I. (igi.exe, 2000): how the level's
 * `objects.qvm` tasks behave every 30 Hz tick, including the cut-scene
 * system, the mission flow (start, objective, complete, failed) and the
 * per-tick update order.  Full tables and evidence: docs/mission.md.
 * Python reference with self-checks: tools/igi_mission.py.
 *
 * Labels: observed = measured on the shipped files; recovered = read from
 * igi.exe code (function addresses, image base 0x400000); inferred = neither.
 *
 * ## Task object model (recovered)
 *
 * Every task is an object of a registered class (FUN_00401940(name, size,
 * parentClass)); handlers live in a 0x180-wide table at 0xa3c820:
 *   slot 0 create, slot 1 per-tick update (table 0xa3ce20), slot 2 destroy,
 *   plus message ids: "get schema" (FUN_004e8710), "compile" (FUN_004e8720,
 *   broadcast once to the whole tree after objects.qsc ran, FUN_004e79e0),
 *   "register members" (FUN_004e7eb0, only for tasks with id >= 0, from
 *   Task_New FUN_004e7420), "unregister members" (FUN_004e7ec0),
 *   "remove from world" (FUN_004c4c40) / "add to world" (FUN_004c4c30).
 * Children are an Exec-style list (AddTail FUN_004a5d50), so siblings keep
 * file order.  There is NO global task scheduler: the Level root's update
 * (LAB_004e7100) updates its children in order and then advances the level
 * clock (+0x24 ms += 33, +0x28 tick += 1); every task type's update decides
 * whether, and before or after its own logic, it updates its children.
 * `Static` does nothing (FUN_00526660), so static geometry is never updated.
 *
 * ## Members (recovered from each type's "register members" handler)
 *
 * A task with id >= 0 publishes script variables "<Type>_<id>.<member>" that
 * the task-condition expressions read (docs/qvm-vm.md section 8).  Conditions
 * are compiled at load (FUN_004e80a0 + FUN_004ae920) and evaluated in float
 * mode (FUN_004e8380 -> FUN_004af8a0) whenever the owning task updates.
 * An empty or uncompilable condition is "absent" (FUN_004e8360 false).
 */
import { readQvmCallTree } from "./qvm";
import { readTaskTree, type IgiTask } from "./tasks";
import {
  QVM_CONSTANTS,
  evaluateQvmExpression,
  parseQvmExpression,
  prepareQvmTaskExpression,
  qvmRoundToInt,
  type QvmExpression,
  type QvmExpressionArg,
  type QvmRuntimeValue,
} from "./qvm-vm";
import { x87F32Add, x87F32Div, x87F32Mul, x87F32Sub, x87Mul, x87StoreF32 } from "./x87";
import { aiNewPerceptionSlot, aiPerceptionStep, type AiPerceptionSlot } from "./ai-rules";

export type Vec3 = [number, number, number];
/** Row-major 3x3 matrix; its columns are the object's local axes in world space. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** FSTP DWORD: the game runs the FPU in chop mode, so float32 stores truncate (docs/gameplay.md "FPU rounding mode"). */
const f32 = x87StoreF32;

// ---------------------------------------------------------------------------
// Recovered constants
// ---------------------------------------------------------------------------

/** Ticks per second: Flow loop FUN_004029a0(0x1e); cut-scene clock set to 30 at 0x415048 (FUN_004ed1a0). */
export const MISSION_TICKS_PER_SECOND = 30;
/** World units per metre (WORLD_METER, FUN_004148b0). */
export const WORLD_UNITS_PER_METRE = 4096;
/** StatusMessage: minimum ticks between two sends of one message (FUN_00483690: nTickSendt + 0xd2 < now). */
export const STATUS_MESSAGE_RESEND_TICKS = 210;
/** Switch / Terminal pulses expire when pressTick + 2 < LevelFlow.nTick (FUN_00444210, FUN_00442ac0). */
export const PULSE_HOLD_TICKS = 2;
/** SCamera: ticks of continuous sighting of an enemy before isDetection (FUN_00440db0: 0x5a). */
export const SCAMERA_DETECTION_TICKS = 90;
/** SCamera: ticks to wait after losing a target before sweeping again (FUN_00440db0: 0x3c). */
export const SCAMERA_LOST_TARGET_WAIT_TICKS = 60;
/** SCamera pitch slew per tick, rad (0x531870 = 2.5 deg) and the switched-off droop pitch (0x531874 = -75 deg). */
export const SCAMERA_PITCH_STEP = f32(0.04363323375582695);
export const SCAMERA_OFF_PITCH = f32(-1.3089969158172607);
/** SCamera tracking: dead zone 5 deg (0x53187c) and max turn 0.75 deg per tick (0x53151c). */
export const SCAMERA_TRACK_DEADZONE = f32(0.0872664675116539);
export const SCAMERA_TRACK_STEP = f32(0.013089969754219055);
/**
 * SCamera lens detector (FUN_00487ae0(lens +0x188, 1, 6, mask, 4, 8) at 0x4408c6): team 1, flags 6
 * (alive objects of another team -> list +0x1a0, dead objects of team 1 -> list +0x1ac), class mask
 * = humans (0x5c1174, FUN_00462e90) | SCamera holders (0x57f6d0, FUN_00442850).
 */
export const SCAMERA_TEAM = 1;
/** Alarm light (lens draw LAB_00441c50): blink phase +0x25d8 toggles when the +0x25d4 countdown (7..0) is 0. */
export const SCAMERA_LIGHT_BLINK_RESET = 7;
/** Train speed: MaxSpeed (km/h) * thrust * 4096000 * (1/108000) world units per tick (FUN_0042a450, 0x5314a4, 0x5314a0). */
export const TRAIN_KMH_TO_UNITS_PER_TICK = 4096000 * f32(9.259259059035685e-6);
/** Cut-scene camera submission priority (FUN_004cfed0 arg 6 = 1000.0); the player's HumanCamera uses 300 (docs/rendering.md). */
export const CUTSCENE_CAMERA_PRIORITY = 1000;
/** EditCamera FOV clamp at compile (FUN_004ff270: 0x5316c0, 0x531534); FOV is tan(horizontal half angle). */
export const CAMERA_FOV_MIN = f32(0.0010000000474974513);
export const CAMERA_FOV_MAX = 3;
/** Angle unwrap thresholds of FUN_004eb5a0 (doubles 0x531620 / 0x532b48, step float 0x531594). */
const UNWRAP_PI = 3.1415926535897944;
const UNWRAP_TWO_PI = f32(6.2831854820251465);
/** Camera shake: position jitter (0.5 - rand) * shake * 4096, angle jitter (0.5 - rand) * shake * 0.5340708 (0x5313b8, 0x532b50). */
export const CAMERA_SHAKE_POSITION_SCALE = 4096;
export const CAMERA_SHAKE_ANGLE_SCALE = f32(0.5340707898139954);

/** CAMERAFILTER_TYPE_* constants (FUN_00499900). */
export const CAMERA_FILTERS = {
  CAMERAFILTER_TYPE_NONE: 0,
  CAMERAFILTER_TYPE_LINE: 1,
  CAMERAFILTER_TYPE_BAND: 2,
  CAMERAFILTER_TYPE_BAND_UPDATE: 3,
  CAMERAFILTER_TYPE_HANDICAM: 4,
} as const;
/** Overlay class names created for each filter (FUN_00499900): LineFilter, BandFilter, HandiCamFilter; the letterbox is WideScreenFilter. */
export const CAMERA_FILTER_CLASS: Readonly<Record<number, string>> = {
  0: "none", 1: "LineFilter", 2: "BandFilter", 3: "BandFilter", 4: "HandiCamFilter",
};

/**
 * Parameters that are compiled as task conditions (each goes through
 * FUN_004e80a0 in the type's compile handler).  Recovered per type:
 * StatusMessage FUN_004837e0, EditVariable FUN_004867e0, LevelTimer
 * FUN_00515c80, ConditionalContainer FUN_00485710, CutScene FUN_004ecfa0,
 * AnimTask FUN_004ea5c0, Door FUN_00446600, Switch FUN_00444410, Terminal
 * FUN_00442bf0, AlarmControl FUN_0043fbb0, SCameraControl FUN_00440010,
 * DefineComputerObjective FUN_004660b0, LevelFlow FUN_00487820,
 * ConditionalSound / AmbientArea / vehicles (FUN_004e8360 call sites).
 */
export const TASK_EXPRESSION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  StatusMessage: ["Send"],
  EditVariable: ["Add", "Sub"],
  LevelTimer: ["On", "Reset"],
  ConditionalContainer: ["Condition", "Run at start", "Run at stop"],
  CutScene: ["Run", "Reset", "Time delta (seconds)", "Start expression", "Stop expression"],
  AnimTask: ["Run"],
  Door: ["Locked expression", "Open door expression", "Close door expression"],
  Switch: ["On"],
  ExplodeObject: ["Explosion expression"],
  Terminal: ["Explosion expression", "On Expression"],
  AlarmControl: ["Explosion expression", "On Expression", "Trigger Expression", "Alarm Expression"],
  SCameraControl: ["Explosion expression", "On Expression", "Detection Expression"],
  SCamera: ["On Expression"],
  ConditionalSound: ["Condition"],
  LevelFlow: ["Complete", "Failed"],
  DefineComputerObjective: ["Objectives Valid",
    ...[1, 2, 3, 4, 5, 6].flatMap((k) => [`Objective ${k} Complete Expression`, `Objective ${k} Failed Expression`])],
  Train: ["Play Sound"],
  Car: ["Open door", "Can fire", "Play sound"],
  Heli: ["Open door", "Can fire", "Play sound"],
};

/**
 * Members published per type: name -> storage kind ("char" = byte read as
 * int, "int").  Recovered from the register-members handlers listed.
 */
export const TASK_MEMBERS: Readonly<Record<string, Readonly<Record<string, "char" | "int">>>> = {
  AreaActivate: { nActive: "int" }, // LAB_004fb1d0
  StatusMessage: { isSendt: "char", nTickSendt: "int" }, // FUN_00483800
  EditVariable: { nValue: "int" }, // FUN_00486810
  LevelTimer: { isRun: "char", nTick: "int" }, // FUN_00515a60
  ConditionalContainer: { isRun: "char" }, // FUN_00485890
  CutScene: { isRun: "char", isFinished: "char", nTick: "int" }, // FUN_004ebc10
  AnimTask: { isRun: "char", nTick: "int" }, // FUN_004ea820
  LevelFlow: { isComplete: "char", isFailed: "char", nTick: "int", eDifficulty: "int" }, // FUN_004873b0 (+ global Key0..9_isPressed)
  Door: { isLocked: "char", isOpen: "char", isClosed: "char", isLastClosed: "char", isLastOpen: "char", isPicked: "char", nDoorOpenTicks: "int" }, // FUN_00446860
  Switch: { isOn: "char", isLastOn: "char", isPressed: "char", isLastPressed: "char", isDestroyed: "char", isLastDestroyed: "char" }, // FUN_00444630
  ExplodeObject: { isExploded: "char" }, // FUN_00480650
  Terminal: { isExploded: "char", isInUse: "char", isLastInUse: "char", isOn: "char", isHacked: "char", isHackedThisTick: "char" }, // FUN_00442c40
  AlarmControl: { isExploded: "char", isInUse: "char", isLastInUse: "char", isOn: "char", isHacked: "char", isHackedThisTick: "char", isTrigger: "char", isAlarm: "char", nTriggerLastTick: "int" }, // FUN_0043fc00
  SCameraControl: { isExploded: "char", isInUse: "char", isLastInUse: "char", isOn: "char", isHacked: "char", isHackedThisTick: "char", isDetection: "char" }, // FUN_00440060
  SCamera: { isDetection: "char", isLastDetection: "char", nDetectionTime: "int", isExploded: "char" }, // 0x441a50..0x441b0d
  ConditionalSound: { isRun: "char", isLastRun: "char", isPlaying: "char", nPlayTick: "int" }, // FUN_00424990
  Car: { isExploded: "char" }, // 0x42ef93 (+0x2ed5)
  HumanPlayer: { isDead: "char", eTeam: "int" }, // Human base 0x45f4f3 (+0xcf5, +0xfc)
  HumanSoldier: { isDead: "char", eTeam: "int" },
  HumanAI: { isDetection: "char" }, // 0x44f573 (+0x3ab5)
};

// ---------------------------------------------------------------------------
// Decoded data
// ---------------------------------------------------------------------------

/** One task in tree pre-order (= file order = update order of siblings). */
export interface MissionNode {
  index: number;
  id: number;
  type: string;
  name: string;
  /** Parent node index, or -1 for a top-level task (child of the Level root). */
  parent: number;
  depth: number;
  children: number[];
  task: IgiTask;
}

export interface AreaActivateTask {
  id: number;
  nodeIndex: number;
  position: Vec3;
  /** Real32x9 Euler angles (alpha, beta, gamma), radians. */
  euler: Vec3;
  /** "Dimensions": FULL box sizes in world units (half extents = 0.5 x, FUN_004fb290 constant 0x531508). */
  dimensions: Vec3;
  halfExtents: Vec3;
  criteria: string;
}

export interface StatusMessageTask {
  id: number;
  nodeIndex: number;
  name: string;
  send: string;
  /** messages.res key. */
  text: string;
  sprite: string;
  sound: string;
  sendOnce: boolean;
  cutsceneMessage: boolean;
  durationSeconds: number;
}

export interface EditVariableTask { id: number; name: string; initialValue: number; add: string; sub: string }
export interface LevelTimerTask { id: number; on: string; reset: string; initialRun: boolean }
export interface ConditionalContainerTask {
  id: number; nodeIndex: number; name: string; condition: string; runAtStart: string; runAtStop: string; childIds: number[];
}

export interface CameraKey {
  /** Index among the cut-scene's EditCamera keys. */
  index: number;
  name: string;
  /** Key start in seconds: float32 running sum of TimeScale * Duration (FUN_004eb4e0). */
  start: number;
  duration: number;
  /** World units. */
  position: Vec3;
  /** Euler angles, radians, already unwrapped to within +-pi of the previous key (FUN_004eb5a0). */
  alpha: number;
  beta: number;
  gamma: number;
  /** tan of the horizontal half field of view (1 = 90 deg), clamped to [0.001, 3]. */
  fov: number;
  linkTaskId: number;
  updateLink: boolean;
  targetTaskId: number;
  updateTarget: boolean;
  smoothToNext: boolean;
  /** -1 = use the cut-scene's Time of day. */
  timeOfDay: number;
  filter: number;
  filterName: string;
  noise: number;
  filterColor: Vec3;
  shake: number;
}

export interface CutSceneTask {
  id: number;
  nodeIndex: number;
  name: string;
  run: string;
  reset: string;
  timeDelta: string;
  startTimeSeconds: number;
  initialRun: boolean;
  timeScale: number;
  viewportHeightFactor: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  timeOfDay: number;
  startExpression: string;
  stopExpression: string;
  keys: CameraKey[];
  /** float32 sum of TimeScale * Duration over the keys. */
  totalSeconds: number;
}

export interface AnimRecord {
  /** Channel 0..31; 32 (' ') = wait N ticks. */
  channel: number;
  value: number;
}

export interface AnimTaskData {
  id: number;
  nodeIndex: number;
  targetId: number;
  targetType: string | null;
  run: string;
  initialRun: boolean;
  records: AnimRecord[];
}

export interface DoorTask {
  id: number;
  nodeIndex: number;
  start: Vec3;
  stopX: number;
  stopY: number;
  slider: number;
  euler: Vec3;
  model: string;
  maxAngleDeg: number;
  openTimeSeconds: number;
  pickable: boolean;
  pickLockSeconds: number;
  locked: string;
  open: string;
  close: string;
  openSound: string;
  closeSound: string;
  moveSound: string;
}

export interface SwitchTask { id: number; nodeIndex: number; on: string; initialOn: boolean; models: string[]; destructable: boolean }

export interface ExplosiveFields {
  model: string;
  destroyedModel: string;
  damageScale: number;
  explosionDelaySeconds: number;
  explosionExpression: string;
  explosionSound: string;
}

export interface TerminalTask extends ExplosiveFields {
  id: number;
  nodeIndex: number;
  type: "Terminal" | "AlarmControl" | "SCameraControl";
  on: string;
  hackTimeSeconds: number;
  trigger: string;
  alarm: string;
  detection: string;
}

export interface ExplodeObjectTask extends ExplosiveFields { id: number; nodeIndex: number; name: string }

export interface SecurityCameraTask {
  id: number;
  nodeIndex: number;
  holderPosition: Vec3;
  holderGamma: number;
  cameraAlpha: number;
  cameraGamma: number;
  rotateRightDeg: number;
  rotateLeftDeg: number;
  rotateSpeedDegPerSecond: number;
  gammaDelaySeconds: number;
  viewconeAlphaDeg: number;
  viewconeGammaDeg: number;
  viewconeLengthMetres: number;
  on: string;
}

export interface ConditionalSoundTask {
  id: number; nodeIndex: number; name: string; condition: string; soundDef: string; position: Vec3;
  simple: boolean; oneShot: boolean; relativeToMicrophone: boolean;
}

export interface ComputerObjective {
  index: number; textResource: string; linkToPosition: number; complete: string; failed: string;
}

export interface ComputerObjectivesTask { id: number; nodeIndex: number; valid: string; objectives: ComputerObjective[] }

export interface LevelFlowTask {
  id: number; startTime: number; complete: string; failed: string; interfaceTimerEnabled: boolean; maxLevelPlayTime: number;
}

export interface TrainTask {
  id: number; nodeIndex: number;
  /** Initial distance along the rail spline (world units). */
  distance: number;
  originalThrust: number;
  railroadTaskId: number;
  model: string;
  thrustStep: number;
  /** km/h at thrust 1. */
  maxSpeed: number;
  flipDirection: boolean;
  displacement: [number, number];
  playSound: string;
}

export interface VehicleTask {
  id: number; type: "Car" | "Heli"; position: Vec3; euler: Vec3; originalThrust: number; model: string;
  collision: boolean; openDoor: string; canFire: string; playSound: string;
}

export interface PlayerSpawn {
  id: number; position: Vec3; gamma: number; team: number; model: string;
  loadout: Array<{ type: string; id: string; slot: number | null; ammo: number | null }>;
}

export interface MissionTasks {
  roots: IgiTask[];
  /** Every task, pre-order. */
  nodes: MissionNode[];
  /** Task id -> node index (ids >= 0 only). */
  byId: Map<number, number>;
  inventory: Record<string, number>;
  areas: AreaActivateTask[];
  statusMessages: StatusMessageTask[];
  variables: EditVariableTask[];
  timers: LevelTimerTask[];
  containers: ConditionalContainerTask[];
  cutScenes: CutSceneTask[];
  animTasks: AnimTaskData[];
  doors: DoorTask[];
  switches: SwitchTask[];
  terminals: TerminalTask[];
  explodeObjects: ExplodeObjectTask[];
  securityCameras: SecurityCameraTask[];
  conditionalSounds: ConditionalSoundTask[];
  objectives: ComputerObjectivesTask[];
  levelFlow: LevelFlowTask | null;
  trains: TrainTask[];
  vehicles: VehicleTask[];
  player: PlayerSpawn | null;
}

// --------------------------------------------------------------------- params

function raw(task: IgiTask, key: string): unknown {
  return task.params[key];
}
function num(task: IgiTask, key: string, fallback = 0): number {
  const v = raw(task, key);
  return typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : fallback;
}
function str(task: IgiTask, key: string): string {
  const v = raw(task, key);
  return typeof v === "string" ? v : "";
}
function bool(task: IgiTask, key: string): boolean {
  const v = raw(task, key);
  return v === true || (typeof v === "number" && v !== 0);
}
function vec(task: IgiTask, key: string): Vec3 {
  const v = raw(task, key);
  if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number")) return [v[0] as number, v[1] as number, v[2] as number];
  return [0, 0, 0];
}

/** objects.qvm -> typed mission data (all level-1 task types the runtime needs). */
export function readMissionTasks(objectsQvm: ArrayBuffer): MissionTasks {
  return buildMissionTasks(readTaskTree(readQvmCallTree(objectsQvm)));
}

/** Same as readMissionTasks, from an already decoded task tree. */
export function buildMissionTasks(roots: IgiTask[]): MissionTasks {
  const nodes: MissionNode[] = [];
  const byId = new Map<number, number>();
  const walk = (task: IgiTask, parent: number, depth: number) => {
    const index = nodes.length;
    nodes.push({ index, id: task.id, type: task.type, name: task.name, parent, depth, children: [], task });
    if (parent >= 0) nodes[parent].children.push(index);
    if (task.id >= 0 && !byId.has(task.id)) byId.set(task.id, index);
    for (const child of task.children) walk(child, index, depth + 1);
  };
  for (const root of roots) walk(root, -1, 0);

  const inventory: Record<string, number> = {};
  for (const n of nodes) inventory[n.type] = (inventory[n.type] ?? 0) + 1;
  const of = (type: string) => nodes.filter((n) => n.type === type);

  const areas = of("AreaActivate").map(({ task: t, index }): AreaActivateTask => {
    const d = vec(t, "Dimensions");
    return {
      id: t.id, nodeIndex: index, position: vec(t, "Position"), euler: vec(t, "Orientation"), dimensions: d,
      halfExtents: [f32(d[0] * 0.5), f32(d[1] * 0.5), f32(d[2] * 0.5)], criteria: str(t, "Criteria"),
    };
  });
  const statusMessages = of("StatusMessage").map(({ task: t, index }): StatusMessageTask => ({
    id: t.id, nodeIndex: index, name: t.name, send: str(t, "Send"), text: str(t, "Text"), sprite: str(t, "Sprite"), sound: str(t, "Sound"),
    sendOnce: bool(t, "Is send once"), cutsceneMessage: bool(t, "Cutscene message"), durationSeconds: num(t, "Duration", 2),
  }));
  const variables = of("EditVariable").map(({ task: t }): EditVariableTask => ({
    id: t.id, name: t.name, initialValue: num(t, "Initial value"), add: str(t, "Add"), sub: str(t, "Sub"),
  }));
  const timers = of("LevelTimer").map(({ task: t }): LevelTimerTask => ({
    id: t.id, on: str(t, "On"), reset: str(t, "Reset"), initialRun: bool(t, "Initial run"),
  }));
  const containers = of("ConditionalContainer").map((n): ConditionalContainerTask => ({
    id: n.id, nodeIndex: n.index, name: n.name, condition: str(n.task, "Condition"), runAtStart: str(n.task, "Run at start"),
    runAtStop: str(n.task, "Run at stop"), childIds: n.children.map((c) => nodes[c].id),
  }));
  const cutScenes = of("CutScene").map((n) => decodeCutScene(n, nodes));
  const animTasks = of("AnimTask").map((n): AnimTaskData => {
    const t = n.task;
    const targetId = num(t, "TargetID", -1);
    const target = byId.get(targetId);
    return {
      id: t.id, nodeIndex: n.index, targetId, targetType: target === undefined ? null : nodes[target].type, run: str(t, "Run"),
      initialRun: bool(t, "Initial run"), records: decodeAnimData(raw(t, "AnimData")),
    };
  });
  const doors = of("Door").map((n): DoorTask => {
    const t = n.task;
    return {
      id: t.id, nodeIndex: n.index, start: vec(t, "Position start"), stopX: num(t, "Position stop X"), stopY: num(t, "Position stop Y"),
      slider: num(t, "Position slider"), euler: vec(t, "Orientation"), model: str(t, "Model"), maxAngleDeg: num(t, "Max angle"),
      openTimeSeconds: num(t, "Open time", 0.5), pickable: bool(t, "Pickable"), pickLockSeconds: num(t, "Pick lock time (s)", 4),
      locked: str(t, "Locked expression"), open: str(t, "Open door expression"), close: str(t, "Close door expression"),
      openSound: str(t, "Open sound"), closeSound: str(t, "Close sound"), moveSound: str(t, "Move sound"),
    };
  });
  const switches = of("Switch").map((n): SwitchTask => ({
    id: n.id, nodeIndex: n.index, on: str(n.task, "On"), initialOn: bool(n.task, "Initial on"),
    models: ["On model", "On pressed model", "Off model", "Off pressed model", "Destroyed model"].map((k) => str(n.task, k)),
    destructable: bool(n.task, "Destructable"),
  }));
  const explosive = (t: IgiTask): ExplosiveFields => ({
    model: str(t, "Model"), destroyedModel: str(t, "Destroyed model"), damageScale: num(t, "Damage scale", 1),
    explosionDelaySeconds: num(t, "Explosion delay"), explosionExpression: str(t, "Explosion expression"),
    explosionSound: str(t, "Explosion sound"),
  });
  const terminals = nodes.filter((n) => n.type === "Terminal" || n.type === "AlarmControl" || n.type === "SCameraControl")
    .map((n): TerminalTask => ({
      id: n.id, nodeIndex: n.index, type: n.type as TerminalTask["type"], ...explosive(n.task), on: str(n.task, "On Expression"),
      hackTimeSeconds: num(n.task, "Hack Time (s)", 4), trigger: str(n.task, "Trigger Expression"),
      alarm: str(n.task, "Alarm Expression"), detection: str(n.task, "Detection Expression"),
    }));
  const explodeObjects = of("ExplodeObject").map((n): ExplodeObjectTask => ({ id: n.id, nodeIndex: n.index, name: n.name, ...explosive(n.task) }));
  const securityCameras = of("SCamera").map(({ task: t, index }): SecurityCameraTask => ({
    id: t.id, nodeIndex: index, holderPosition: vec(t, "Holder Position"), holderGamma: num(t, "Holder Gamma"), cameraAlpha: num(t, "Camera Alpha"),
    cameraGamma: num(t, "Camera Gamma"), rotateRightDeg: num(t, "Rotate Gamma Right (d)"), rotateLeftDeg: num(t, "Rotate Gamma Left (d)"),
    rotateSpeedDegPerSecond: num(t, "Rotate Gamma Speed (d/s)"), gammaDelaySeconds: num(t, "Gamma Delay (s)", 1),
    viewconeAlphaDeg: num(t, "Viewcone Alpha (d)"), viewconeGammaDeg: num(t, "Viewcone Gamma (d)"),
    viewconeLengthMetres: num(t, "Viewcone length (m)"), on: str(t, "On Expression"),
  }));
  const conditionalSounds = of("ConditionalSound").map(({ task: t, index }): ConditionalSoundTask => ({
    id: t.id, nodeIndex: index, name: t.name, condition: str(t, "Condition"), soundDef: str(t, "SoundDef"), position: vec(t, "Position"),
    simple: bool(t, "Simple"), oneShot: bool(t, "OneShot"), relativeToMicrophone: bool(t, "Relative to microphone"),
  }));
  const objectives = of("DefineComputerObjective").map(({ task: t, index }): ComputerObjectivesTask => ({
    id: t.id, nodeIndex: index, valid: str(t, "Objectives Valid"),
    objectives: [1, 2, 3, 4, 5, 6].map((k) => ({
      index: k, textResource: str(t, `Objective ${k} Text Resource`), linkToPosition: num(t, `Objective ${k} Link To Position`, -1),
      complete: str(t, `Objective ${k} Complete Expression`), failed: str(t, `Objective ${k} Failed Expression`),
    })).filter((o) => o.textResource !== ""),
  }));
  const flow = of("LevelFlow")[0];
  const levelFlow: LevelFlowTask | null = flow ? {
    id: flow.id, startTime: num(flow.task, "Start time"), complete: str(flow.task, "Complete"), failed: str(flow.task, "Failed"),
    interfaceTimerEnabled: bool(flow.task, "Interface timer enabled"), maxLevelPlayTime: num(flow.task, "Max level play time"),
  } : null;
  const trains = of("Train").map((n): TrainTask => ({
    id: n.id, nodeIndex: n.index, distance: num(n.task, "Position"), originalThrust: num(n.task, "Original thrust"),
    railroadTaskId: num(n.task, "RailroadQTaskID", -1), model: str(n.task, "Model"), thrustStep: num(n.task, "ThrustStep"),
    maxSpeed: num(n.task, "MaxSpeed"), flipDirection: bool(n.task, "Flip Direction"),
    displacement: [num(n.task, "Displacement X"), num(n.task, "Displacement Y")], playSound: str(n.task, "Play Sound"),
  }));
  const vehicles = nodes.filter((n) => n.type === "Car" || n.type === "Heli").map((n): VehicleTask => ({
    id: n.id, type: n.type as VehicleTask["type"], position: vec(n.task, "Position"), euler: vec(n.task, "Orientation"),
    originalThrust: num(n.task, "Original Thrust"), model: str(n.task, "Model"), collision: bool(n.task, "Collision detection"),
    openDoor: str(n.task, "Open door"), canFire: str(n.task, "Can fire"), playSound: str(n.task, "Play sound"),
  }));
  const playerNode = of("HumanPlayer")[0];
  const player: PlayerSpawn | null = playerNode ? {
    id: playerNode.id, position: vec(playerNode.task, "Position"), gamma: num(playerNode.task, "Gamma"),
    team: num(playerNode.task, "Team"), model: str(playerNode.task, "Model"),
    loadout: playerNode.children.map((c) => nodes[c]).filter((c) => typeof raw(c.task, "ID") === "string").map((c) => ({
      type: c.type, id: str(c.task, "ID"),
      slot: typeof raw(c.task, "Slot") === "number" ? num(c.task, "Slot") : null,
      ammo: typeof raw(c.task, "Ammo") === "number" ? num(c.task, "Ammo") : null,
    })),
  } : null;

  return {
    roots, nodes, byId, inventory, areas, statusMessages, variables, timers, containers, cutScenes, animTasks, doors, switches,
    terminals, explodeObjects, securityCameras, conditionalSounds, objectives, levelFlow, trains, vehicles, player,
  };
}

/** AnimData = n pairs (channel, value); channel 32 values are truncated to integers (FUN_004ea1f0: fistp at 0x4ea247, chop mode). */
export function decodeAnimData(value: unknown): AnimRecord[] {
  if (!Array.isArray(value) || typeof value[0] !== "number") return [];
  const count = value[0] as number;
  const out: AnimRecord[] = [];
  for (let k = 0; k < count; k++) {
    const channel = qvmRoundToInt(Number(value[1 + 2 * k]));
    const v = Number(value[2 + 2 * k]);
    out.push({ channel: (channel << 24) >> 24, value: channel === 32 ? qvmRoundToInt(v) : f32(v) });
  }
  return out;
}

function decodeCutScene(node: MissionNode, nodes: MissionNode[]): CutSceneTask {
  const t = node.task;
  const timeScale = f32(num(t, "Time scale", 1));
  const keys: CameraKey[] = [];
  let total = 0;
  // FUN_004eb4e0: the first EditCamera child and its following EditCamera
  // siblings (recursing into EditCamera children), start = running float32 sum.
  const collect = (indices: number[]) => {
    for (const i of indices) {
      const c = nodes[i];
      if (c.type !== "EditCamera") continue;
      const p = c.task;
      const filterName = str(p, "FILTER") || "CAMERAFILTER_TYPE_NONE";
      const fov = f32(num(p, "FOV", 1));
      keys.push({
        index: keys.length, name: c.name, start: total, duration: f32(num(p, "Duration")), position: vec(p, "Position"),
        alpha: f32(num(p, "Alpha")), beta: f32(num(p, "Beta")), gamma: f32(num(p, "Gamma")),
        fov: fov < CAMERA_FOV_MIN ? CAMERA_FOV_MIN : fov > CAMERA_FOV_MAX ? CAMERA_FOV_MAX : fov,
        linkTaskId: num(p, "Link task ID", -1), updateLink: bool(p, "Update link continously"),
        targetTaskId: num(p, "Target task ID", -1) === c.id && c.id >= 0 ? -1 : num(p, "Target task ID", -1),
        updateTarget: bool(p, "Update target continously"), smoothToNext: bool(p, "Smooth to next"),
        timeOfDay: f32(num(p, "Time of day (-1 means use default)", -1)),
        filter: (CAMERA_FILTERS as Record<string, number>)[filterName] ?? 0, filterName,
        noise: f32(num(p, "Noise", 0.5)), filterColor: vec(p, "Filter color"), shake: f32(num(p, "Camera shake")),
      });
      total = f32(f32(timeScale * f32(num(p, "Duration"))) + total);
      collect(c.children);
    }
  };
  collect(node.children);
  unwrapKeyAngles(keys);
  return {
    id: t.id, nodeIndex: node.index, name: t.name, run: str(t, "Run"), reset: str(t, "Reset"), timeDelta: str(t, "Time delta (seconds)"),
    startTimeSeconds: num(t, "Start time (seconds)"), initialRun: bool(t, "Initial run"), timeScale,
    viewportHeightFactor: f32(num(t, "Viewport height factor", 1)),
    fadeInSeconds: Math.max(0, f32(num(t, "Viewport height factor fade in time"))),
    fadeOutSeconds: Math.max(0, f32(num(t, "Viewport height factor fade out time"))),
    timeOfDay: f32(num(t, "Time of day")), startExpression: str(t, "Start expression"), stopExpression: str(t, "Stop expression"),
    keys, totalSeconds: total,
  };
}

/** FUN_004eb5a0: bring each key's alpha/beta/gamma to within (-pi, pi] of the previous key (in place). */
function unwrapKeyAngles(keys: CameraKey[]): void {
  for (const axis of ["alpha", "beta", "gamma"] as const) {
    for (let i = 1; i < keys.length; i++) {
      const prev = keys[i - 1][axis];
      let a = keys[i][axis];
      while (UNWRAP_PI < a - prev) a = f32(a - UNWRAP_TWO_PI);
      while (a - prev < -UNWRAP_PI) a = f32(a + UNWRAP_TWO_PI);
      keys[i][axis] = a;
    }
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers (recovered)
// ---------------------------------------------------------------------------

/**
 * FUN_004a9bc0(m, alpha, beta, gamma): m = Rz(gamma) * Ry(beta) * Rx(alpha),
 * row-major; used for every Real32x9 task orientation (setter 0x4e66e0) and
 * for EditCamera angles.  Rz = [c -s 0; s c 0; 0 0 1] (FUN_004a9ec0),
 * Ry = [c 0 s; 0 1 0; -s 0 c] (FUN_004a9e80), Rx = [1 0 0; 0 c -s; 0 s c]
 * (FUN_004a9e40).  For a camera the columns are (right, down, forward).
 */
export function eulerToMatrix(alpha: number, beta: number, gamma: number): Mat3 {
  const [ca, sa, cb, sb, cg, sg] = [Math.cos(alpha), Math.sin(alpha), Math.cos(beta), Math.sin(beta), Math.cos(gamma), Math.sin(gamma)];
  const rz: Mat3 = [cg, -sg, 0, sg, cg, 0, 0, 0, 1];
  const ry: Mat3 = [cb, 0, sb, 0, 1, 0, -sb, 0, cb];
  const rx: Mat3 = [1, 0, 0, 0, ca, -sa, 0, sa, ca];
  return mul3(mul3(rz, ry), rx);
}

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return out;
}

export function transpose3(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function apply3(m: Mat3, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

/**
 * SCamera lens pivot, IGI units [recovered FUN_00441290 0x4412c4..0x441378]:
 * the SCameraLens object (the camera head, created by the SCamera in
 * FUN_004415b0) sits at holder +0x20 + FUN_00486e20(holder, 0) = the holder's
 * position + Rz(Holder Gamma) x magic vertex 0 (XTVM) of the "Holder Model"
 * (FUN_004c5aa0 with scale 1; the holder's rotation is set by FUN_00441900
 * FUN_004a9ec0(+0x70, Holder Gamma) before its children compile). No magic
 * vertex: offset (0, 0, 0). The lens never moves afterwards: its update only
 * rotates it about this point.
 */
export function securityCameraLensPivot(holderPosition: Vec3, holderGamma: number, holderMagic0: Vec3 | null): Vec3 {
  if (!holderMagic0) return [holderPosition[0], holderPosition[1], holderPosition[2]];
  const o = apply3(eulerToMatrix(0, 0, holderGamma), holderMagic0);
  return [holderPosition[0] + o[0], holderPosition[1] + o[1], holderPosition[2] + o[2]];
}

/**
 * SCamera lens rotation [recovered FUN_004a9bc0(lens +0x70, pitch, 0, gamma):
 * compile 0x4413bf with pitch = Camera Alpha and no sweep, every lens update
 * 0x440c24]: Rz(gamma) Rx(pitch), gamma = f32(sweep yaw (+0xf4) + Holder
 * Gamma (+0x108) + Camera Gamma (+0x124)), pitch = lens +0xf0. The lens's
 * forward is model +y, so a negative pitch looks down (the switched-off droop
 * is -75 deg).
 */
export function securityCameraLensMatrix(holderGamma: number, cameraGamma: number, yaw: number, pitch: number): Mat3 {
  return eulerToMatrix(pitch, 0, f32(yaw + holderGamma + cameraGamma));
}

// ---------------------------------------------------------------------------
// SCamera vision: the lens detector [recovered]
// ---------------------------------------------------------------------------
//
// Lens update LAB_00440930 while the holder isOn: eye +0x110 = lens + R x magic
// vertex 1 of its model, eye matrix +0x128 = R, both from the lens matrix +0x70 of
// the PREVIOUS update (the update ends with FUN_004a9bc0 at 0x440c24); +0x180 = 0
// (no secondary cone); FUN_00487b70(lens +0x188, eye, holder, team 1); then
// FUN_00440db0 picks the target and tracks it. Same detector code as the soldiers
// (docs/ai.md 2.2), set up with (team 1, flags 6, humans | SCamera holders, 4, 8).

/** Half view cone of a lens (FUN_00441290 tail, 0x441410..0x441458), radians / units. */
export interface SecurityCameraCone {
  /** (int)(Viewcone Alpha / 2) x deg: the VERTICAL half angle (eye +0x40 = lens +0x150). */
  alpha: number;
  /** (int)(Viewcone Gamma / 2) x deg: the HORIZONTAL half angle (eye +0x48 = lens +0x158). */
  gamma: number;
  /** Viewcone length (m) x 4096 (eye +0x50 = lens +0x160). */
  length: number;
}

/**
 * The lens cone [recovered 0x441410]: the shorts are halved as integers (cdq; sub;
 * sar 1: 55 deg -> 27), fild x float deg (0x531684), stored as doubles; the length
 * is float x 4096.0f (0x5313b8). Level 1: 45 deg vertical, 27 deg horizontal, 25 m.
 */
export function securityCameraCone(cam: Pick<SecurityCameraTask, "viewconeAlphaDeg" | "viewconeGammaDeg" | "viewconeLengthMetres">): SecurityCameraCone {
  const deg = f32(0.01745329238474369);
  const half = (d: number) => Math.trunc(Math.trunc(d) / 2);
  return {
    alpha: x87Mul(half(cam.viewconeAlphaDeg), deg),
    gamma: x87Mul(half(cam.viewconeGammaDeg), deg),
    length: x87Mul(f32(cam.viewconeLengthMetres), 4096),
  };
}

/** `point - origin` in the frame of row-major `m` (columns right, forward = model +y, up), FUN_00487d80 / 0x440e8b. */
function lensLocal(origin: Vec3, m: Mat3, point: Vec3): Vec3 {
  const dx = point[0] - origin[0];
  const dy = point[1] - origin[1];
  const dz = point[2] - origin[2];
  return [m[0] * dx + m[3] * dy + m[6] * dz, m[1] * dx + m[4] * dy + m[7] * dz, m[2] * dx + m[5] * dy + m[8] * dz];
}

/** FUN_00486950: signed angle of (x, y) from +y, positive towards -x (left); 0 for a zero vector. */
function horizontalAngle(v: Vec3): number {
  const n = Math.hypot(v[0], v[1]);
  if (n === 0) return 0;
  const a = Math.acos(Math.max(-1, Math.min(1, v[1] / n)));
  return v[0] > 0 ? -a : a;
}

/** FUN_004868f0: signed angle of (y, z) from +y, negative below; 0 for a zero vector. */
function verticalAngle(v: Vec3): number {
  const n = Math.hypot(v[1], v[2]);
  if (n === 0) return 0;
  const a = Math.acos(Math.max(-1, Math.min(1, v[1] / n)));
  return v[2] < 0 ? -a : a;
}

/**
 * Lens cone test FUN_00487d80 [recovered] with the secondary cone off (+0x180 = 0):
 * `point - eye` in the eye matrix; distance (double) <= length, float32(|vertical|)
 * < alpha, |horizontal| < gamma (extended precision).
 */
export function securityCameraInViewCone(eye: Vec3, matrix: Mat3, point: Vec3, cone: SecurityCameraCone): boolean {
  const v = lensLocal(eye, matrix, point);
  if (!(Math.hypot(v[0], v[1], v[2]) <= cone.length)) return false;
  if (!(f32(Math.abs(verticalAngle(v))) < cone.alpha)) return false;
  return Math.abs(horizontalAngle(v)) < cone.gamma;
}

/**
 * Target bearing for the tracking (FUN_00440db0 0x440e8b..0x440f0a) [recovered]:
 * FUN_00486950 of the target point minus the lens origin (+0x20, the pivot, not
 * the eye) in the lens matrix +0x70 (the previous update's rotation); positive =
 * target to the left (the sweep yaw grows).
 */
export function securityCameraBearing(pivot: Vec3, matrix: Mat3, point: Vec3): number {
  return horizontalAngle(lensLocal(pivot, matrix, point));
}

/**
 * An object of the detectable registry DAT_005c4a00 (FUN_00487aa0: SCamera holders
 * at create FUN_004415b0, humans at create 0x45d850, so in task-tree order) as its
 * detection-info message reports it [recovered]: humans FUN_0045eaa0 (team +0xfc,
 * alive = !isDead +0xcf5, in world +0xcf6 (set by the add / remove-from-world
 * handlers 0x45f5c0 / 0x45f610), point = origin + 0.69 m standing / 0.35 m
 * crouched, FUN_00464490); SCamera holders FUN_00441bf0 (team 1, alive =
 * !isExploded, always in the world, point = the holder position +0x20).
 */
export interface CameraDetectable {
  /** Identity (the slot / target pointer). */
  key: string | number;
  kind: "human" | "scamera";
  /** SCamera: its node index (a lens skips its own holder, FUN_00487b70 `param_3`). */
  node: number;
  team: number;
  alive: boolean;
  inWorld: boolean;
  /** Detection-info point (IGI units): the cone / sight target and, for both kinds, the tracking point (FUN_004411e0). */
  point: Vec3;
}

/** One tracked object of a lens detector: the soldier slot of FUN_00487920 + its list (0 = +0x1a0, 1 = +0x1ac). */
export interface SecurityCameraSlot extends AiPerceptionSlot {
  list: 0 | 1;
}

/**
 * The lens detector of one SCamera (lens +0x188) [recovered FUN_00487b70,
 * FUN_00487cf0, FUN_00440db0 head]:
 *   - it runs on ticks with (global tick & 3) == phase (DAT_005c4a48 round-robin
 *     at FUN_00487ae0);
 *   - registry objects in order: its own holder and objects that are out of the
 *     world or fail the team rule lose their slot; others of another team that are
 *     alive go to list +0x1a0, dead ones of team 1 (bodies, destroyed cameras) to
 *     list +0x1ac (AddTail at first tracking); then FUN_00487cf0 (cone every 2nd
 *     run, sight ray every 3rd run while in the cone: aiPerceptionStep);
 *   - the target is the first visible slot of +0x1ac (alert), replaced by the
 *     first visible slot of +0x1a0 when there is one.
 */
export class SecurityCameraDetector {
  readonly slots = new Map<string | number, SecurityCameraSlot>();
  /** List +0x1a0 (other team, alive) and +0x1ac (team 1, dead), in AddTail order. */
  readonly lists: [Array<string | number>, Array<string | number>] = [[], []];

  constructor(readonly phase: number) {}

  /** Which list an object belongs to (FUN_00487b70 flag tests with flags 6), or null when untracked. */
  static listOf(o: CameraDetectable, selfNode: number): 0 | 1 | null {
    if (o.kind === "scamera" && o.node === selfNode) return null;
    if (!o.inWorld) return null;
    if (o.team !== SCAMERA_TEAM) return o.alive ? 0 : null; // flag 4 (alive) / flag 8 (dead) of another team
    return o.alive ? null : 1; // flag 1 (alive) / flag 2 (dead) of the own team
  }

  /** FUN_00487b70 for the lens of SCamera node `selfNode`: `cone` / `sight` test one object. */
  perceive(
    tick: number,
    selfNode: number,
    objects: Iterable<CameraDetectable>,
    cone: (o: CameraDetectable) => boolean,
    sight: (o: CameraDetectable) => boolean,
  ): void {
    if ((tick & 3) !== this.phase) return;
    for (const o of objects) {
      const list = SecurityCameraDetector.listOf(o, selfNode);
      let slot = this.slots.get(o.key);
      if (list === null) {
        if (slot) this.remove(o.key, slot);
        continue;
      }
      if (!slot) {
        slot = { ...aiNewPerceptionSlot(), list }; // FUN_00487920: countdowns 0, not visible, AddTail
        this.slots.set(o.key, slot);
        this.lists[list].push(o.key);
      }
      aiPerceptionStep(slot, () => cone(o), () => sight(o));
    }
  }

  /** FUN_00440db0: the target and whether it came from list +0x1ac (holder +0x164). */
  target(): { key: string | number; alert: boolean } | null {
    const first = (list: 0 | 1) => this.lists[list].find((k) => this.slots.get(k)?.visible) ?? null;
    const enemy = first(0);
    if (enemy !== null) return { key: enemy, alert: false };
    const body = first(1);
    return body !== null ? { key: body, alert: true } : null;
  }

  private remove(key: string | number, slot: SecurityCameraSlot): void {
    this.slots.delete(key);
    const list = this.lists[slot.list];
    const i = list.indexOf(key);
    if (i >= 0) list.splice(i, 1);
  }
}

/**
 * Perception phases (DAT_005c4a48, FUN_00487ae0) handed out at a level load
 * [recovered]: the counter is process-wide (static 0, never reset, (n + 1) & 3);
 * objects.qsc creates every task first (an SCamera's create makes its lens, whose
 * create LAB_00440780 takes a phase), then "compile" runs in pre-order over the
 * tree (HumanAI FUN_0044f3a0, Car FUN_0042e7d0 and Heli FUN_00431bd0 when their
 * model and vehicle definition load, AIStationaryGunHolder FUN_0046d370 each take
 * one). Returns node index -> phase and the counter after the load. Car / Heli
 * whose model is empty are skipped [inferred: FUN_004c82b0 / FUN_004e4cc0 succeed
 * for every named model]. Run-time re-inits (Car / Heli / StationaryGun "Can
 * fire" falling to 0: 0x42dbcf, 0x430c68, 0x46d201) also advance the counter.
 * The HumanAIs of GuardGenerator templates take none here: the generator's
 * compile deletes its children (FUN_00488220, full exe) and each spawn compiles
 * a fresh copy, which takes the counter's value then (FUN_00488000).
 */
export function perceptionPhases(tasks: Pick<MissionTasks, "nodes">, counter = 0): { phases: Map<number, number>; next: number } {
  const phases = new Map<number, number>();
  let c = counter & 3;
  const take = (node: number) => {
    phases.set(node, c);
    c = (c + 1) & 3;
  };
  for (const n of tasks.nodes) if (n.type === "SCamera") take(n.index);
  /** GuardGenerator templates (FUN_00488220 deletes them at the generator's compile): their phase comes at the spawn. */
  const templated = (n: MissionNode): boolean => {
    for (let p = n.parent; p >= 0; p = tasks.nodes[p].parent) if (tasks.nodes[p].type === "GuardGenerator") return true;
    return false;
  };
  for (const n of tasks.nodes) {
    if (n.type === "HumanAI" && templated(n)) continue;
    if (n.type === "HumanAI" || n.type === "AIStationaryGunHolder") take(n.index);
    else if ((n.type === "Car" || n.type === "Heli") && str(n.task, "Model") !== "") take(n.index);
  }
  return { phases, next: c };
}

/** Alarm light quad of one lens (LAB_00441c50) [recovered]: colour in the 1/128 scale, half-size in units. */
export interface SecurityCameraLight {
  /** (r, g, b) x 1/128 (0x532a90). */
  rgb: Vec3;
  /** Half-size of the screen-aligned quad at the light's depth (FUN_004962b0), units. */
  halfSize: number;
}

/**
 * The light of a lens for its state, or null when the holder is off
 * [recovered LAB_00441c50]: idle (isDetection 0 and nDetectionTime 0) green
 * (0, 128, 0) at 819.2 units in blink phase 1, (0, 64, 0) at 307.2 in phase 0;
 * counting or detecting red (128, 0, 0) at 1433.6 / 512.
 */
export function securityCameraLight(s: { isOn?: number; isDetection?: number; nDetectionTime?: number; lightPhase?: number }): SecurityCameraLight | null {
  if (!s.isOn) return null;
  const on = (s.lightPhase ?? 0) !== 0;
  if (!s.isDetection && !s.nDetectionTime) return on ? { rgb: [0, 128, 0], halfSize: 819.2 } : { rgb: [0, 64, 0], halfSize: 307.2 };
  return { rgb: [128, 0, 0], halfSize: on ? 1433.6 : 512 };
}

/**
 * AreaActivate point test (FUN_004faf50): local = R^T (p - position); inside
 * when -half <= local <= half on all three axes (boundaries count).  The
 * tested point is a human's origin (+0x20), not its feet.
 */
export function areaContains(area: AreaActivateTask, point: Vec3): boolean {
  const r = eulerToMatrix(area.euler[0], area.euler[1], area.euler[2]);
  const d: Vec3 = [point[0] - area.position[0], point[1] - area.position[1], point[2] - area.position[2]];
  const local = apply3(transpose3(r), d);
  for (let i = 0; i < 3; i++) {
    const l = f32(local[i]);
    if (l > area.halfExtents[i] || -area.halfExtents[i] > l) return false;
  }
  return true;
}

/**
 * Criteria constants (registered by FUN_004fb6d0 from FUN_0045d170 and
 * FUN_004eae10).  The exe gives each a bit by registration order; the bit
 * values here are arbitrary but distinct (only the names matter to scripts).
 */
export const AREA_CRITERIA: Readonly<Record<string, number>> = {
  CRITERIA_HUMAN: 1 << 0,
  ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map((k) => [`CRITERIA_HUMAN${k}`, 1 << (1 + k)])),
  CRITERIA_VEHICLE: 1 << 9,
};

/** Criteria string -> bit mask (FUN_004ae9b0 = int-mode evaluation at compile, FUN_004fb290). */
export function areaCriteriaMask(criteria: string): number {
  if (criteria.trim() === "") return 0;
  return evaluateQvmExpression(criteria, {
    value: (name) => (name in AREA_CRITERIA ? AREA_CRITERIA[name] : QVM_CONSTANTS[name]),
  }, "int");
}

/** An actor the AreaActivate callbacks can count. */
export interface AreaActor { position: Vec3; team?: number; kind: "human" | "vehicle" }

/**
 * nActive of one area (FUN_004fb540): for every criteria bit, the bit's
 * callback adds the matching actors inside.  CRITERIA_HUMAN counts every
 * human (LAB_0045f6e0), CRITERIA_HUMAN<k> humans of team k (LAB_0045f680);
 * there is no alive test in either callback.
 */
export function areaActiveCount(area: AreaActivateTask, actors: Iterable<AreaActor>, mask = areaCriteriaMask(area.criteria)): number {
  let count = 0;
  const list = [...actors];
  for (const [name, bit] of Object.entries(AREA_CRITERIA)) {
    if ((mask & bit) === 0) continue;
    for (const a of list) {
      if (name === "CRITERIA_VEHICLE" ? a.kind !== "vehicle" : a.kind !== "human") continue;
      if (name.startsWith("CRITERIA_HUMAN") && name !== "CRITERIA_HUMAN" && a.team !== Number(name.slice(14))) continue;
      if (areaContains(area, a.position)) count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Cut-scene camera (recovered FUN_004ec060, FUN_004ec230, FUN_004ece70)
// ---------------------------------------------------------------------------

/**
 * FUN_004ece70 + FUN_00511e70/FUN_00511ed0: cubic Hermite between p1 and p2
 * with tangents m1 = (p2 - p0) (t1 - t0) / (t2 - t0) and
 * m2 = (p3 - p1) (t2 - t1) / (t3 - t1) (0 when the denominator is 0), at
 * s = (t - t1) / (t2 - t1) (0 when t2 == t1).  Note m1 uses (t1 - t0), not
 * (t2 - t1): that is what the exe computes.
 */
export function cameraHermite(p: [number, number, number, number], t: [number, number, number, number], time: number): number {
  const [p0, p1, p2, p3] = p;
  const [t0, t1, t2, t3] = t;
  const m1 = t2 - t0 === 0 ? 0 : (p2 - p0) * 0.5 * ((t1 - t0 + (t1 - t0)) / (t2 - t0));
  const m2 = t3 - t1 === 0 ? 0 : ((t2 - t1 + (t2 - t1)) / (t3 - t1)) * (p3 - p1) * 0.5;
  const a = m1;
  const b = p1;
  const c3 = p1 + p1 - (p2 + p2) + m1 + m2;
  const c2 = p2 * 3 - p1 * 3 - (m1 + m1) - m2;
  const s = t2 - t1 === 0 ? 0 : (time - t1) / (t2 - t1);
  return s * a + s * s * c2 + s * s * s * c3 + b;
}

export interface CutSceneCameraSample {
  cutSceneId: number;
  /** nTick the sample was taken at (before the update adds 1). */
  nTick: number;
  /** float32 nTick / 30. */
  time: number;
  /** Current key = last key whose start <= time. */
  keyIndex: number;
  /** The four keys (indices) the curve uses after the "Smooth to next" substitution. */
  curveKeys: [number, number, number, number];
  /** True on the tick the key index changed (filters are rebuilt then). */
  cut: boolean;
  /** time > total: CutScene.isFinished is set and nTick snaps to trunc(30 * total) (0x4ec149). */
  finished: boolean;
  /** Interpolated world position (units) before link / target. */
  position: Vec3;
  alpha: number;
  beta: number;
  gamma: number;
  /** Camera orientation before link / target (columns right, down, forward). */
  matrix: Mat3;
  /** tan(horizontal half FOV); vertical = 0.75 x (4:3 frustum, docs/rendering.md). */
  fov: number;
  timeOfDay: number;
  noise: number;
  shake: number;
  /** Filter colour, linear between k1 and k2. */
  filterColor: Vec3;
  /** Filter of the current key (k1). */
  filter: number;
  link: { taskId: number; update: boolean } | null;
  target: { taskId: number; update: boolean } | null;
  /** Visible fraction of the screen height: (1 - c) + c * ViewportHeightFactor, c = fade factor. */
  viewportFactor: number;
}

/**
 * Sample a cut-scene camera at CutScene.nTick (FUN_004ec060 then
 * FUN_004ec230, without the random shake and without link / target, which
 * need live task poses: see applyCameraLink / cameraLookAt).
 * Returns null when the cut-scene has no EditCamera child (the exe then sets
 * nothing, and isFinished never becomes true).
 */
export function sampleCutSceneCamera(cut: CutSceneTask, nTick: number, previousKeyIndex = -2): CutSceneCameraSample | null {
  const n = cut.keys.length;
  if (n === 0) return null;
  const time = f32(f32(nTick) / f32(MISSION_TICKS_PER_SECOND));
  let i = -1;
  for (let k = 0; k < n; k++) {
    if (time < cut.keys[k].start) break;
    i = k;
  }
  const total = cut.totalSeconds;
  const finished = total < time;
  const keyIndex = i;
  const cut_ = finished || previousKeyIndex !== keyIndex;
  const at = (k: number) => Math.min(Math.max(k, 0), n - 1);
  let k0 = at(i - 1), k2 = at(i + 1), k3 = at(i + 2);
  const k1 = at(i);
  if (!cut.keys[k0].smoothToNext) k0 = k1;
  if (!cut.keys[k1].smoothToNext) k2 = k1;
  if (!cut.keys[k2].smoothToNext) k3 = k2;
  const ks = [cut.keys[k0], cut.keys[k1], cut.keys[k2], cut.keys[k3]];
  const times = ks.map((k) => k.start) as [number, number, number, number];
  const h = (get: (k: CameraKey) => number) => cameraHermite(ks.map(get) as [number, number, number, number], times, time);
  const position: Vec3 = [h((k) => k.position[0]), h((k) => k.position[1]), h((k) => k.position[2])];
  const alpha = f32(h((k) => k.alpha));
  const beta = f32(h((k) => k.beta));
  const gamma = f32(h((k) => k.gamma));
  const fov = f32(h((k) => k.fov));
  const timeOfDay = f32(h((k) => (k.timeOfDay < 0 ? cut.timeOfDay : k.timeOfDay)));
  const shake = f32(h((k) => k.shake));
  const noise = f32(h((k) => k.noise));
  const span = f32(ks[2].start - ks[1].start);
  const u = span === 0 ? 0 : f32((time - ks[1].start) / span);
  const filterColor: Vec3 = span === 0
    ? [...ks[1].filterColor] as Vec3
    : [0, 1, 2].map((c) => (ks[2].filterColor[c] - ks[1].filterColor[c]) * u + ks[1].filterColor[c]) as Vec3;
  // Viewport (letterbox) factor: fade in over the first fadeIn seconds, out over the last fadeOut.
  const fin = cut.fadeInSeconds !== 0 && time < cut.fadeInSeconds ? time / cut.fadeInSeconds : 1;
  const left = total - time;
  const fout = cut.fadeOutSeconds === 0 || cut.fadeOutSeconds <= left ? 1 : left / cut.fadeOutSeconds;
  const c = Math.min(Math.max(Math.min(fin, fout), 0), 1);
  const viewportFactor = f32(1 - c + c * cut.viewportHeightFactor);
  return {
    cutSceneId: cut.id, nTick, time, keyIndex, curveKeys: [k0, k1, k2, k3], cut: cut_, finished, position, alpha, beta, gamma,
    matrix: eulerToMatrix(alpha, beta, gamma), fov, timeOfDay, noise, shake, filterColor, filter: ks[1].filter,
    link: ks[1].linkTaskId >= 0 ? { taskId: ks[1].linkTaskId, update: ks[1].updateLink } : null,
    target: ks[1].targetTaskId >= 0 ? { taskId: ks[1].targetTaskId, update: ks[1].updateTarget } : null,
    viewportFactor,
  };
}

/** A task's pose: origin (world units) and orientation matrix. */
export interface TaskPose { position: Vec3; matrix: Mat3 }

/**
 * FUN_004ff7a0: a linked camera rides with the link task.  Key positions are
 * authored in world space relative to the link task's pose captured when the
 * EditCamera compiled (level load, FUN_004ff270); at run time
 * p' = cur.pos + Rcur * Rinit^T * (p - init.pos), M' = Rcur * Rinit^T * M.
 */
export function applyCameraLink(position: Vec3, matrix: Mat3, initial: TaskPose, current: TaskPose): TaskPose {
  const rel = mul3(current.matrix, transpose3(initial.matrix));
  const d = apply3(rel, [position[0] - initial.position[0], position[1] - initial.position[1], position[2] - initial.position[2]]);
  return { position: [current.position[0] + d[0], current.position[1] + d[1], current.position[2] + d[2]], matrix: mul3(rel, matrix) };
}

/**
 * FUN_004ff480: look-at orientation from `from` to `to`: forward = unit(to -
 * from), right = unit(forward x +z), down = -unit(right x forward); columns
 * (right, down, forward).  Degenerate (same point): forward = +x.
 */
export function cameraLookAt(from: Vec3, to: Vec3): Mat3 {
  let f: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const len = Math.hypot(f[0], f[1], f[2]);
  f = len === 0 ? [1, 0, 0] : [f[0] / len, f[1] / len, f[2] / len];
  let r: Vec3 = [f[1], -f[0], 0];
  const rl = Math.hypot(r[0], r[1]);
  if (rl !== 0) r = [r[0] / rl, r[1] / rl, 0];
  let u: Vec3 = [-f[0] * f[2], -f[1] * f[2], f[0] * f[0] + f[1] * f[1]];
  const ul = Math.hypot(u[0], u[1], u[2]);
  if (ul !== 0) u = [u[0] / ul, u[1] / ul, u[2] / ul];
  return [r[0], -u[0], f[0], r[1], -u[1], f[1], r[2], -u[2], f[2]];
}

/**
 * WideScreenFilter (FUN_00499330 created by FUN_004ec230, drawn by
 * LAB_0049a4b0): two black bars, top at y = 0 and bottom at
 * y = (H + 1) - bar, each (W + 1) wide and bar = (1 - factor) * (H + 1) * 0.5
 * + 1 pixels high.  No bars when factor == 1.  The overlay is created once
 * (with the factor of that tick) and never resized while it exists.
 */
export function letterboxBarHeight(screenHeight: number, viewportFactor: number): number {
  if (viewportFactor === 1) return 0;
  return f32(f32((1 - viewportFactor) * (screenHeight + 1)) * 0.5 + 1);
}

/** Cut-scene key timeline in ticks: key k starts at trunc(30 * start) (inferred display rule, same FISTP conversion as FUN_004ecfa0). */
export function cutSceneKeyTicks(cut: CutSceneTask): number[] {
  return cut.keys.map((k) => qvmRoundToInt(k.start * MISSION_TICKS_PER_SECOND));
}

/** Smallest nTick for which the cut-scene is finished (float32 test total < nTick / 30). */
export function cutSceneFinishTick(cut: CutSceneTask): number {
  let n = Math.max(0, Math.floor(cut.totalSeconds * MISSION_TICKS_PER_SECOND) - 2);
  while (!(cut.totalSeconds < f32(f32(n) / f32(MISSION_TICKS_PER_SECOND)))) n++;
  return n;
}

// ---------------------------------------------------------------------------
// AnimTask playback and trains (recovered)
// ---------------------------------------------------------------------------

/** AnimTask playback state: 34 float channels (32 = wait counter, 33 = record cursor), FUN_004ea680. */
export interface AnimPlaybackState { channels: Float32Array; nTick: number }

export function newAnimPlayback(): AnimPlaybackState {
  return { channels: new Float32Array(34), nTick: -1 };
}

/**
 * FUN_004eabe0: one playback step.  Records set channel[c] = value until a
 * wait record (channel 32) is reached; a wait of N holds the cursor on the
 * wait record for N steps, then the following records apply.
 */
export function stepAnimRecords(state: AnimPlaybackState, records: readonly AnimRecord[]): void {
  const ch = state.channels;
  if (qvmRoundToInt(ch[33]) < records.length) {
    if (ch[32] !== 0) {
      ch[32] = ch[32] - 1;
      if (ch[32] === 0) ch[33] = ch[33] + 1;
    }
    while (ch[32] === 0) {
      const cursor = qvmRoundToInt(ch[33]);
      if (cursor >= records.length) break;
      const r = records[cursor];
      ch[r.channel] = r.value;
      if (ch[32] === 0) ch[33] = ch[33] + 1;
    }
  }
}

/**
 * FUN_004eab70: seek to tick n.  n == 0 or n < current: reset all channels
 * and step n + 1 times (so tick 0 applies the records before the first
 * wait).  n > current: step until nTick == n.  `onStep(nTick)` is the
 * message the AnimTask sends to its target after every step (FUN_004eace0).
 */
export function seekAnimPlayback(state: AnimPlaybackState, records: readonly AnimRecord[], n: number,
  onStep?: (nTick: number, channels: Float32Array) => void): void {
  if (n === 0 || n < state.nTick) {
    state.channels.fill(0);
    state.nTick = 0;
    for (let k = n + 1; k > 0; k--) {
      stepAnimRecords(state, records);
      onStep?.(state.nTick, state.channels);
    }
  } else if (state.nTick < n) {
    do {
      stepAnimRecords(state, records);
      onStep?.(state.nTick, state.channels);
      state.nTick += 1;
    } while (state.nTick < n);
  }
}

/** Train motion state (FUN_0042a450): thrust approaches the target by ThrustStep per step. */
export interface TrainState { thrust: number; targetThrust: number; speed: number; distance: number }

export function newTrainState(train: TrainTask): TrainState {
  return trainAnimInput(train, { thrust: 0, targetThrust: 0, speed: 0, distance: 0 }, 0, new Float32Array(34));
}

/**
 * Train reaction to its AnimTask (FUN_0042a450).  Channel 0 = target thrust
 * (-1 = keep).  nTick 0 resets to the task parameters; otherwise thrust moves
 * by ThrustStep toward the target, speed = MaxSpeed * thrust * 37.926
 * units/tick (km/h), distance += speed (negated when Flip Direction).  The
 * wagons are then placed along the rail SplineObj at that distance
 * (FUN_004296d0 -> FUN_004f5830, not reimplemented here).
 */
export function trainAnimInput(train: TrainTask, s: TrainState, nTick: number, channels: Float32Array): TrainState {
  if (channels[0] !== -1) s.targetThrust = channels[0];
  if (nTick === 0) {
    channels[1] = -2;
    s.distance = f32(train.distance);
    s.speed = f32(f32(train.maxSpeed) * f32(train.originalThrust) * f32(37.925926208496094));
    s.targetThrust = f32(train.originalThrust);
    s.thrust = s.targetThrust;
    return s;
  }
  const step = f32(train.thrustStep);
  if (s.thrust < s.targetThrust) {
    s.thrust = f32(s.thrust + step);
    if (s.targetThrust < s.thrust) s.thrust = s.targetThrust;
  } else if (s.targetThrust < s.thrust) {
    s.thrust = f32(s.thrust - step);
    if (s.thrust < s.targetThrust) s.thrust = s.targetThrust;
  }
  let v = f32(f32(train.maxSpeed) * s.thrust * 4096000 * f32(9.259259059035685e-6));
  s.speed = v;
  if (train.flipDirection) v = -v;
  s.distance = f32(v + s.distance);
  return s;
}

// ---------------------------------------------------------------------------
// Doors (recovered FUN_00445ae0, FUN_00446600, FUN_00445060, FUN_00446c10)
// ---------------------------------------------------------------------------

export interface DoorState {
  /** Rotation, degrees about the door's local z. */
  angle: number;
  /** Slide fraction 0..1 of (Position stop X, Y) metres in the door frame. */
  slide: number;
  /** Requested state (+0x290): toggled by "use" (FUN_00446c10), set by the open / close expressions. */
  wantOpen: boolean;
  isLocked: boolean;
  isOpen: boolean;
  isClosed: boolean;
  isLastOpen: boolean;
  isLastClosed: boolean;
  isPicked: boolean;
  nDoorOpenTicks: number;
  /** Move-sound loop playing. */
  moving: boolean;
}

/** Door state right after its compile handler (FUN_00446600). */
export function newDoorState(door: DoorTask): DoorState {
  return {
    angle: 0, slide: f32(door.slider), wantOpen: false, isLocked: false, isOpen: false, isClosed: true,
    isLastOpen: false, isLastClosed: true, isPicked: false, nDoorOpenTicks: 0, moving: false,
  };
}

export interface DoorStepEvents { openSound: boolean; closeSound: boolean; startMoveSound: boolean; stopMoveSound: boolean; moved: boolean }

/**
 * One door tick (after its children).  `evalExpr(field)` returns the
 * condition value or null when absent; `blocked()` is the swept-volume test
 * (FUN_004c24c0 between the model's two bounding points) done only when the
 * door moved: a blocked door re-opens fully.
 */
export function stepDoor(door: DoorTask, s: DoorState, evalExpr: (field: "locked" | "open" | "close") => number | null,
  blocked?: () => boolean): DoorStepEvents {
  s.isLastOpen = s.isOpen;
  s.isLastClosed = s.isClosed;
  if (s.isClosed) {
    const v = evalExpr("open");
    if (v !== null && v !== 0) s.wantOpen = true;
  }
  if (s.isOpen) {
    s.nDoorOpenTicks += 1;
    const v = evalExpr("close");
    if (v !== null && v !== 0) s.wantOpen = false;
  } else {
    s.nDoorOpenTicks = 0;
  }
  const locked = evalExpr("locked");
  if (locked !== null) s.isLocked = (qvmRoundToInt(locked) & 0xff) !== 0;
  if (s.isPicked) s.isLocked = false;
  let targetAngle = s.wantOpen ? f32(door.maxAngleDeg) : 0;
  let targetSlide = s.wantOpen ? 1 : 0;
  let moved = false;
  // float32 operations stored in chop mode: a 1 s door's step 1/30 truncates, so 30
  // steps end just below the target and the door arrives on tick 31.
  const ticks = x87F32Mul(f32(door.openTimeSeconds), 30);
  if (targetAngle !== s.angle) {
    const step = x87F32Div(Math.abs(f32(door.maxAngleDeg)), ticks);
    if (s.angle < targetAngle) s.angle = Math.min(x87F32Add(step, s.angle), targetAngle);
    else s.angle = Math.max(x87F32Sub(s.angle, step), targetAngle);
    moved = true;
  }
  const len = f32(Math.hypot(door.stopX, door.stopY));
  if ((door.stopX === 0 && door.stopY === 0) || s.slide === targetSlide) {
    s.slide = targetSlide;
  } else {
    const step = x87F32Div(x87F32Div(len, ticks), len);
    if (s.slide < targetSlide) s.slide = Math.min(x87F32Add(step, s.slide), targetSlide);
    else s.slide = Math.max(x87F32Sub(s.slide, step), targetSlide);
    moved = true;
  }
  if (s.angle === targetAngle && s.slide === targetSlide) {
    s.isClosed = targetAngle === 0 && targetSlide === 0;
    s.isOpen = !s.isClosed;
  } else {
    s.isClosed = false;
    s.isOpen = false;
  }
  if (moved && blocked?.()) {
    targetSlide = 1;
    targetAngle = f32(door.maxAngleDeg);
    s.isClosed = false;
    s.isOpen = false;
    s.wantOpen = true;
  }
  const ev: DoorStepEvents = {
    openSound: s.isOpen && !s.isLastOpen, closeSound: s.isClosed && !s.isLastClosed,
    startMoveSound: false, stopMoveSound: false, moved,
  };
  if (!s.isClosed && !s.isOpen) {
    if (!s.moving) ev.startMoveSound = s.moving = true;
  } else if (s.moving) {
    s.moving = false;
    ev.stopMoveSound = true;
  }
  return ev;
}

/** FUN_00445060 + FUN_004a9a70: door pose from its state. */
export function doorPose(door: DoorTask, s: DoorState): TaskPose {
  const r = eulerToMatrix(door.euler[0], door.euler[1], door.euler[2]);
  const ox = f32(f32(door.stopX * s.slide) * WORLD_UNITS_PER_METRE);
  const oy = f32(f32(door.stopY * s.slide) * WORLD_UNITS_PER_METRE);
  const d = apply3(r, [ox, oy, 0]);
  const a = s.angle * f32(0.01745329238474369);
  return {
    position: [door.start[0] + d[0], door.start[1] + d[1], door.start[2] + d[2]],
    matrix: mul3(r, [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1]),
  };
}

// ---------------------------------------------------------------------------
// Task runtime
// ---------------------------------------------------------------------------

/** A human the AreaActivate criteria can count (the host's live human list, DAT_005c115c). */
export interface MissionHuman { position: Vec3; team: number }

/**
 * SCamera sighting reported by the host's vision code (lens detector FUN_00487b70;
 * SecurityCameraDetector computes it from the camera's state `rotYaw` / `rotPitch`,
 * the lens matrix of the previous update).
 */
export interface CameraSighting {
  /** Identity of the sighted object; a change restarts nDetectionTime. */
  key: string | number;
  /**
   * True for a target of list +0x1ac (dead objects of team 1: soldiers' bodies and
   * destroyed SCameras, [recovered FUN_00487b70 flags 6]): no 3 s delay, "camera_beep_al".
   */
  alert: boolean;
  /** Horizontal bearing of the target in the camera frame (securityCameraBearing, FUN_00486950), radians; omit to skip tracking. */
  bearing?: number;
}

export interface MissionHost {
  /** Humans in the world (player and soldiers), for AreaActivate. */
  humans?(): Iterable<MissionHuman>;
  /** Vehicles for CRITERIA_VEHICLE. */
  vehicles?(): Iterable<{ position: Vec3 }>;
  /** Members the runtime does not own: HumanPlayer_0.isDead, HumanSoldier_<id>.isDead, HumanAI_<id>.isDetection, Car_<id>.isExploded ... */
  value?(name: string): number | undefined;
  /** LevelFlow_GetBreakCutSceneKey: DirectInput DIK_ESCAPE byte (0xbce9a3) & 0x80. */
  escapePressed?(): boolean;
  /** Key0_isPressed .. Key9_isPressed (DIK_0, DIK_1..DIK_9). */
  digitPressed?(digit: number): boolean;
  /** Script functions called from expressions (MenuManager_SetEnabled, StatusMessageScreen_ClearMessages, ...). */
  call?(name: string, args: readonly number[]): number | void;
  /** Update a task the runtime does not implement (humans, weapons, pickups, ...); return true when handled. */
  updateTask?(node: MissionNode, runtime: MissionRuntime): boolean;
  /**
   * turrets: a host-updated task (updateTask returned false) after its children were updated: the
   * part of its update that follows the children (the Car update FUN_0042e320's attached
   * children and turrets, combat/vehicle-weapons.ts).
   */
  afterTaskChildren?(node: MissionNode, runtime: MissionRuntime): void;
  /** A ConditionalContainer added (true) or removed (false) its children to / from the world. */
  onContainerWorld?(container: ConditionalContainerTask, inWorld: boolean): void;
  onStatusMessage?(message: StatusMessageTask, levelFlowTick: number): void;
  onCutSceneCamera?(sample: CutSceneCameraSample, cutScene: CutSceneTask): void;
  /** A cut-scene stopped running (its overlays are removed on the next frame). */
  onCutSceneStop?(cutScene: CutSceneTask): void;
  /** AnimTask step sent to a non-train target (Car, Heli): FUN_004eace0 message. */
  onAnimInput?(anim: AnimTaskData, nTick: number, channels: Float32Array): void;
  onSound?(sound: ConditionalSoundTask, start: boolean): void;
  /** Is the ConditionalSound's voice still playing (FUN_004248b0)? Default: false. */
  soundPlaying?(sound: ConditionalSoundTask): boolean;
  onDoorEvent?(door: DoorTask, events: DoorStepEvents, state: DoorState): void;
  doorBlocked?(door: DoorTask, state: DoorState): boolean;
  cameraSighting?(camera: SecurityCameraTask): CameraSighting | null;
  onExplode?(id: number, type: string): void;
  /** An event of a registered task behaviour (sounds, effects, ...): `TaskBehaviourContext.emit`. */
  onTaskEvent?(node: MissionNode, event: string, data?: unknown): void;
  /** One draw of the level random generator (+0x2c, the AI's): [0, 1) (FUN_004aaa50). */
  random?(): number;
  /** One draw of the level random generator: next() mod n (FUN_004aaaa0; full exe FUN_004b47c0). */
  randomInt?(n: number): number;
  /** Engine-side queries a behaviour needs (the player position, a model radius, ...). */
  query?(name: string, ...args: unknown[]): unknown;
  warn?(message: string): void;
}

/** Storage kind of a task member: char / int read as ints, float / double as floats. */
export type TaskMemberKind = "char" | "int" | "float" | "double";

/** What a registered behaviour sees of its node (see `registerTaskBehaviour`). */
export interface TaskBehaviourContext {
  readonly runtime: MissionRuntime;
  readonly node: MissionNode;
  /** The node's state: its members are fields of it. */
  readonly state: Record<string, number>;
  readonly host: MissionHost;
  /** The compiled field in float mode; null when the field is empty (FUN_004e8360 false). */
  eval(field: string): number | null;
  /** (char)fistp(eval(field)), null when empty. */
  evalByte(field: string): number | null;
  /** Update the node's children (the tree pre-order). */
  updateChildren(): void;
  /** Tell the host (presentation: sounds, effects). */
  emit(event: string, data?: unknown): void;
}

/**
 * A task type implemented outside this file (src/loaders/objects/*). The
 * runtime calls create at load (pre-order), compile after every node is
 * created (the compile broadcast), and update at the node's place in the
 * tick order; `members` are published as "<Type>_<id>.<member>".
 */
export interface TaskBehaviour {
  expressions?: readonly string[];
  members?: Readonly<Record<string, TaskMemberKind>>;
  create?(c: TaskBehaviourContext): void;
  compile?(c: TaskBehaviourContext): void;
  update(c: TaskBehaviourContext): void;
}

const TASK_BEHAVIOURS = new Map<string, TaskBehaviour>();

/** Register the behaviour of a task type (one per type; a later one replaces it). */
export function registerTaskBehaviour(type: string, behaviour: TaskBehaviour): void {
  TASK_BEHAVIOURS.set(type, behaviour);
}

export function taskBehaviour(type: string): TaskBehaviour | undefined {
  return TASK_BEHAVIOURS.get(type);
}

interface Compiled { text: string; expr: QvmExpression }

type NodeState = Record<string, number>;

/**
 * Deterministic re-implementation of the non-AI task logic, run in the
 * exe's tree order.  `tick()` = one 30 Hz frame of the Game task
 * (FUN_00415306): if LevelFlow.isComplete was set last frame the mission
 * ends and nothing updates; else (unless paused) the Level root updates its
 * children in order (LAB_004e7100) and the level tick advances.
 *
 * Humans, AI, weapons, pickups and vehicle physics are the host's: they are
 * offered to `host.updateTask` at their exact place in the order.
 */
export class MissionRuntime {
  readonly tasks: MissionTasks;
  readonly host: MissionHost;
  /** Level root tick counter (+0x28, FUN_004e7d20): completed ticks. */
  levelTick = 0;
  /** Set when the Game task saw LevelFlow.isComplete (next mission / main menu, FUN_00415306). */
  missionComplete = false;
  /** Game +0xe0: the in-game menu is open; nothing updates. */
  paused = false;
  /** Dynamic freeze flag 0x805fa5 (editor; always false in the game). */
  frozen = false;
  /** Objectives of the last DefineComputerObjective that updated (DAT_005c11b0). */
  objectives: Array<{ index: number; textResource: string; linkToPosition: number; complete: number; failed: number }> = [];

  private readonly state: NodeState[];
  private readonly compiled = new Map<string, Compiled | null>();
  private readonly members = new Map<string, () => number>();
  private readonly roots: number[];
  private readonly byNode = new Map<number, unknown>();
  private readonly animPlayback = new Map<number, AnimPlaybackState>();
  private readonly trainState = new Map<number, TrainState>();
  private readonly doorState = new Map<number, DoorState>();
  private readonly cameraTarget = new Map<number, string | number | null>();
  private readonly areaMask = new Map<number, number>();
  private readonly behaviourContexts = new Map<number, TaskBehaviourContext>();
  private levelFlowNode = -1;

  constructor(tasks: MissionTasks, host: MissionHost = {}) {
    this.tasks = tasks;
    this.host = host;
    this.state = tasks.nodes.map(() => ({}));
    this.roots = tasks.nodes.filter((n) => n.parent === -1).map((n) => n.index);
    const records: Array<{ nodeIndex: number }> = [
      ...tasks.areas, ...tasks.statusMessages, ...tasks.containers, ...tasks.cutScenes, ...tasks.animTasks, ...tasks.doors,
      ...tasks.securityCameras, ...tasks.conditionalSounds, ...tasks.objectives, ...tasks.trains,
    ];
    for (const r of records) this.byNode.set(r.nodeIndex, r);
    this.createAll();
    this.compileAll();
  }

  private rec<T>(index: number): T {
    return this.byNode.get(index) as T;
  }

  /** Current value of "<Type>_<id>.<member>" (runtime-owned members only). */
  member(name: string): number | undefined {
    return this.members.get(name)?.();
  }

  /** Every runtime-owned member and its value. */
  memberSnapshot(): Record<string, number> {
    return Object.fromEntries([...this.members].map(([k, get]) => [k, get()]));
  }

  /** Raw state of a node (fields named after the exe members). */
  nodeState(index: number): Readonly<NodeState> {
    return this.state[index];
  }

  /** Evaluate any task expression against the live members (float mode, like a task condition). */
  evaluate(text: string): number {
    const prepared = prepareQvmTaskExpression(text, { taskExists: (id) => this.tasks.byId.has(id) });
    return evaluateQvmExpression(prepared.text, { value: (n, a) => this.lookup(n, a) }, "float");
  }

  /** One 30 Hz frame. */
  tick(): void {
    if (this.missionComplete) return;
    if (this.levelFlowNode >= 0 && this.state[this.levelFlowNode].isComplete) {
      this.missionComplete = true;
      return;
    }
    if (this.paused) return;
    for (const r of this.roots) this.update(r);
    this.levelTick += 1;
  }

  // ---- player / world interactions (recovered entry points) ----

  /** Player "use" on a door (FUN_0040ce30 case 3 -> FUN_00446c10): toggles the request unless locked. */
  useDoor(nodeIndex: number): boolean {
    const s = this.doorState.get(nodeIndex);
    if (!s || s.isLocked) return false;
    s.wantOpen = !s.wantOpen;
    return true;
  }

  /** A lock was picked (the human's lock-pick state; its timing was not traced). */
  pickDoorLock(nodeIndex: number): void {
    const s = this.doorState.get(nodeIndex);
    if (s) s.isPicked = true;
  }

  /** Switch pressed (FUN_00443ce0; player and AI "use"). */
  pressSwitch(id: number): void {
    const s = this.state[this.tasks.byId.get(id) ?? -1];
    if (!s) return;
    s.isLastPressed = s.isPressed;
    s.isPressed = 1;
    s.pressTick = this.levelFlowTick();
  }

  /** Terminal used this tick (0x442f64). */
  useTerminal(id: number): void {
    const s = this.state[this.tasks.byId.get(id) ?? -1];
    if (!s) return;
    s.isInUse = 1;
    s.useTick = this.levelFlowTick();
  }

  /** Hacking finished (FUN_004473f0, from the human's hack state after "Hack Time (s)"). */
  hackTerminal(id: number): void {
    const s = this.state[this.tasks.byId.get(id) ?? -1];
    if (!s) return;
    s.isHacked = 1;
    s.isHackedThisTick = 1;
    s.hackTick = this.levelFlowTick();
  }

  /** Damage set off an explosive task (ExplodeObject / Terminal family): countdown = trunc(delay * 30) (FISTP, chop mode) [the damage path is inferred]. */
  detonate(nodeIndex: number): void {
    const s = this.state[nodeIndex];
    if (!s || s.isExploded || s.countdown >= 0) return;
    s.countdown = qvmRoundToInt(num(this.tasks.nodes[nodeIndex].task, "Explosion delay") * MISSION_TICKS_PER_SECOND);
  }

  levelFlowTick(): number {
    return this.levelFlowNode >= 0 ? this.state[this.levelFlowNode].nTick : 0;
  }

  /** The ExplodeObject part of a subclass's update (FUN_0047fce0): children, then the explosion rule. */
  updateExplodeObject(index: number): void {
    this.updateExplosive(index);
  }

  /** Mutable state of a node driven by a registered behaviour (player uses, pickups). */
  behaviourState(index: number): Record<string, number> {
    return this.state[index];
  }

  /** Run node `index`'s registered behaviour now if it has one (a platform's early update, FUN_0043e290). */
  updateBehaviourNow(index: number): void {
    const b = TASK_BEHAVIOURS.get(this.tasks.nodes[index]?.type);
    if (b) b.update(this.behaviourContext(index));
  }

  doorStateAt(nodeIndex: number): DoorState | undefined {
    return this.doorState.get(nodeIndex);
  }

  trainStateAt(nodeIndex: number): TrainState | undefined {
    return this.trainState.get(nodeIndex);
  }

  animPlaybackAt(nodeIndex: number): AnimPlaybackState | undefined {
    return this.animPlayback.get(nodeIndex);
  }

  // ---- load ----

  private createAll(): void {
    this.tasks.nodes.forEach((n, i) => {
      const s = this.state[i];
      const t = n.task;
      switch (n.type) {
        case "AreaActivate": s.nActive = 0; break; // LAB_004fb670
        case "StatusMessage": Object.assign(s, { isSendt: 0, nTickSendt: -100000 }); break; // LAB_00483630
        case "EditVariable": s.nValue = num(t, "Initial value"); break; // param written over +0xd8
        case "LevelTimer": Object.assign(s, { isRun: bool(t, "Initial run") ? 1 : 0, nTick: 0 }); break; // FUN_00515a00
        case "ConditionalContainer": Object.assign(s, { isRun: 0, inWorld: 1 }); break; // FUN_00485410
        case "CutScene": Object.assign(s, { isRun: bool(t, "Initial run") ? 1 : 0, isFinished: 0, nTick: 0, wasRun: 0, keyIndex: -1 }); break; // FUN_004ebb40
        case "AnimTask": s.isRun = bool(t, "Initial run") ? 1 : 0; break; // FUN_004ea680
        case "LevelFlow": Object.assign(s, { isComplete: 0, isFailed: 0, nTick: 0, eDifficulty: 1 }); this.levelFlowNode = i; break; // LAB_004872f0
        case "Switch": Object.assign(s, { isOn: bool(t, "Initial on") ? 1 : 0, isLastOn: 1, isPressed: 0, isLastPressed: 0, isDestroyed: 0, isLastDestroyed: 0, pressTick: 0 }); break; // LAB_00444040
        case "ExplodeObject": Object.assign(s, { isExploded: 0, countdown: -1, exprFlag: 0 }); break; // LAB_0047faf0
        case "Terminal": case "AlarmControl": case "SCameraControl": // LAB_00442a20 (+ 0x43fa00 / 0x43fef0)
          Object.assign(s, { isExploded: 0, countdown: -1, exprFlag: 0, isInUse: 0, isLastInUse: 0, isOn: 1, isHacked: 0, isHackedThisTick: 0, useTick: 0, hackTick: 0 });
          if (n.type === "AlarmControl") Object.assign(s, { isTrigger: 0, isAlarm: 0, wasAlarm: 0, nTriggerLastTick: -10000 });
          if (n.type === "SCameraControl") s.isDetection = 0;
          break;
        // FUN_004415b0, LAB_00440780; the lens compile (FUN_00441290 0x44139e) sets pitch = Camera Alpha.
        case "SCamera": {
          // Lens create LAB_00440780 / compile FUN_00441290: pitch = Camera Alpha, matrix +0x70 = (0, Camera Alpha); light counters 0.
          const pitch = f32(num(t, "Camera Alpha"));
          Object.assign(s, {
            isOn: 0, isDetection: 0, isLastDetection: 0, nDetectionTime: 0, isExploded: 0, pitch, yaw: 0, sweepTarget: 0, sweepDir: 0,
            sweepWait: 0, lostWait: 0, rotYaw: 0, rotPitch: pitch, lightCount: 0, lightPhase: 0, alert: 0,
          });
          break;
        }
        case "ConditionalSound": Object.assign(s, { isRun: 0, isLastRun: 0, isPlaying: 0, nPlayTick: -1, started: 0, voice: 0 }); break; // FUN_00424620
        default: {
          const b = TASK_BEHAVIOURS.get(n.type);
          if (b) b.create?.(this.behaviourContext(i));
          break;
        }
      }
      if (n.id >= 0) {
        const kinds = TASK_MEMBERS[n.type] ?? TASK_BEHAVIOURS.get(n.type)?.members;
        if (kinds) for (const m of Object.keys(kinds)) if (m in s) this.members.set(`${n.type}_${n.id}.${m}`, () => this.state[i][m]);
      }
    });
    for (const d of this.tasks.doors) {
      const st = newDoorState(d);
      this.doorState.set(d.nodeIndex, st);
      if (d.id >= 0) {
        const names: Array<keyof DoorState> = ["isLocked", "isOpen", "isClosed", "isLastClosed", "isLastOpen", "isPicked", "nDoorOpenTicks"];
        for (const m of names) this.members.set(`Door_${d.id}.${m}`, () => Number(st[m]));
      }
    }
    for (const t of this.tasks.trains) this.trainState.set(t.nodeIndex, newTrainState(t));
    for (const a of this.tasks.animTasks) {
      const p = newAnimPlayback();
      this.animPlayback.set(a.nodeIndex, p);
      if (a.id >= 0) {
        this.members.set(`AnimTask_${a.id}.isRun`, () => this.state[a.nodeIndex].isRun);
        this.members.set(`AnimTask_${a.id}.nTick`, () => p.nTick);
      }
    }
  }

  /** Compile broadcast (FUN_004e79e0 -> FUN_00401dc0 "compile" message, pre-order). */
  private compileAll(): void {
    this.tasks.nodes.forEach((n, i) => {
      for (const field of TASK_EXPRESSION_FIELDS[n.type] ?? []) this.compile(i, field);
      const b = TASK_BEHAVIOURS.get(n.type);
      if (b) {
        for (const field of b.expressions ?? []) this.compile(i, field);
        b.compile?.(this.behaviourContext(i));
      }
      if (n.type === "AreaActivate") this.areaMask.set(i, areaCriteriaMask(this.rec<AreaActivateTask>(i).criteria));
      if (n.type === "CutScene") {
        // FUN_004ecfa0 0x4ecfd6: fild 30; fmul Start time; fistp -> nTick = trunc(30 * Start time).
        this.state[i].nTick = qvmRoundToInt(MISSION_TICKS_PER_SECOND * f32(num(n.task, "Start time (seconds)")));
      }
      if (n.type === "AnimTask") {
        // FUN_004ea5c0: seek to tick 0 (reset + one step), telling the target.
        const a = this.rec<AnimTaskData>(i);
        seekAnimPlayback(this.animPlayback.get(i)!, a.records, 0, (t, ch) => this.animInput(a, t, ch));
      }
    });
  }

  private compile(index: number, field: string): Compiled | null {
    const key = `${index}:${field}`;
    if (this.compiled.has(key)) return this.compiled.get(key)!;
    const n = this.tasks.nodes[index];
    const text = str(n.task, field);
    let out: Compiled | null = null;
    if (text.trim() !== "") {
      const prepared = prepareQvmTaskExpression(text, {
        taskExists: (id) => this.tasks.byId.has(id),
        thisName: n.id >= 0 ? `${n.type}_${n.id}` : undefined,
      });
      try {
        out = { text: prepared.text, expr: parseQvmExpression(prepared.text) };
      } catch (e) {
        this.host.warn?.(`${n.type}_${n.id} ${field}: ${(e as Error).message}`);
      }
    }
    this.compiled.set(key, out);
    return out;
  }

  /** FUN_004e8380: a compiled condition in float mode; null when absent (FUN_004e8360 false). */
  private eval(index: number, field: string): number | null {
    const c = this.compile(index, field);
    if (!c) return null;
    return evaluateQvmExpression(c.expr, { value: (name, args) => this.lookup(name, args), warn: (m) => this.host.warn?.(m) }, "float");
  }

  /** (char)fistp(v), i.e. the low byte of trunc(v) (chop mode): the byte stores of isRun / isOn / isTrigger ... */
  private evalByte(index: number, field: string): number | null {
    const v = this.eval(index, field);
    return v === null ? null : ((qvmRoundToInt(v) & 0xff) << 24) >> 24;
  }

  private lookup(name: string, args: readonly QvmExpressionArg[] | null): QvmRuntimeValue | number | undefined {
    if (args !== null) {
      switch (name) {
        case "LevelFlow_GetBreakCutSceneKey": return this.host.escapePressed?.() ? 0x80 : 0; // LAB_00487220
        case "LevelFlow_LevelFailed": return this.levelFlowNode >= 0 ? this.state[this.levelFlowNode].isFailed : 0; // LAB_00487270
        default: {
          const r = this.host.call?.(name, args.map((a) => a.float()));
          return typeof r === "number" ? r : 0;
        }
      }
    }
    const own = this.members.get(name);
    if (own) return own();
    const constant = QVM_CONSTANTS[name];
    if (constant !== undefined) return constant;
    const key = /^Key([0-9])_isPressed$/.exec(name);
    if (key) return this.host.digitPressed?.(Number(key[1])) ? 0x80 : 0;
    return this.host.value?.(name);
  }

  // ---- update dispatch (slot 1 of each type) ----

  private updateChildren(index: number): void {
    for (const c of this.tasks.nodes[index].children) this.update(c);
  }

  private update(index: number): void {
    const n = this.tasks.nodes[index];
    const s = this.state[index];
    switch (n.type) {
      case "Static": return; // FUN_00526660: never updated
      case "Dynamic": if (!this.frozen) this.updateChildren(index); return; // LAB_004e7300
      case "Container": case "EditCamera": this.updateChildren(index); return; // LAB_004fc9f0
      case "AreaActivate": this.updateArea(index); this.updateChildren(index); return; // FUN_004fb540
      case "StatusMessage": this.updateStatusMessage(index); return; // FUN_00483690
      case "EditVariable": { // FUN_004866f0
        const add = this.eval(index, "Add");
        if (add !== null) s.nValue = (s.nValue + qvmRoundToInt(add)) | 0; // fistp(eval) 0x4ebeb3 / 0x4ebedb: truncated
        const sub = this.eval(index, "Sub");
        if (sub !== null) s.nValue = (s.nValue - qvmRoundToInt(sub)) | 0;
        return;
      }
      case "LevelTimer": { // FUN_00515bb0
        this.updateChildren(index);
        const on = this.evalByte(index, "On");
        if (on !== null) s.isRun = on;
        const reset = this.eval(index, "Reset");
        if (reset !== null && reset !== 0) s.nTick = 0;
        if (s.isRun) s.nTick += 1;
        return;
      }
      case "ConditionalContainer": this.updateContainer(index); return; // FUN_00485450
      case "CutScene": this.updateCutScene(index); return; // FUN_004ebe30
      case "AnimTask": this.updateAnimTask(index); return; // FUN_004ea7c0
      case "Door": { // FUN_00445ae0
        this.updateChildren(index);
        const door = this.rec<DoorTask>(index);
        const st = this.doorState.get(index)!;
        const fields = { locked: "Locked expression", open: "Open door expression", close: "Close door expression" } as const;
        const ev = stepDoor(door, st, (f) => this.eval(index, fields[f]), () => this.host.doorBlocked?.(door, st) ?? false);
        this.host.onDoorEvent?.(door, ev, st);
        return;
      }
      case "Switch": { // FUN_00444210
        this.updateChildren(index);
        const on = this.evalByte(index, "On");
        if (on !== null) s.isOn = on;
        if (s.pressTick + PULSE_HOLD_TICKS < this.levelFlowTick()) {
          s.isLastPressed = s.isPressed;
          s.isPressed = 0;
        }
        s.isLastOn = s.isOn;
        s.isLastDestroyed = s.isDestroyed;
        return;
      }
      case "ExplodeObject": this.updateExplosive(index); return; // FUN_0047fce0
      case "Terminal": this.updateTerminal(index); return; // FUN_00442ac0
      case "AlarmControl": { // FUN_0043fa60
        this.updateTerminal(index);
        s.wasAlarm = s.isAlarm;
        if (!s.isExploded && s.isOn) {
          const trig = this.evalByte(index, "Trigger Expression");
          if (trig !== null) s.isTrigger = trig;
          if (s.isTrigger) s.nTriggerLastTick = this.levelTick;
          const alarm = this.evalByte(index, "Alarm Expression");
          if (alarm !== null) s.isAlarm = alarm;
        } else {
          s.isTrigger = 0;
          s.isAlarm = 0;
        }
        return;
      }
      case "SCameraControl": { // FUN_0043ff30
        this.updateTerminal(index);
        if (!s.isExploded) {
          const d = this.evalByte(index, "Detection Expression");
          if (d !== null) s.isDetection = d;
        } else {
          s.isDetection = 0;
        }
        return;
      }
      case "SCamera": this.updateSecurityCamera(index); return; // FUN_004417d0 (+ lens LAB_00440930)
      case "ConditionalSound": this.updateSound(index); return; // FUN_004246a0
      case "DefineComputerObjective": this.updateObjectives(index); return; // LAB_00465f90
      case "LevelFlow": { // LAB_004876b0
        this.updateChildren(index);
        const c = this.evalByte(index, "Complete");
        if (c !== null) s.isComplete = c;
        const f = this.evalByte(index, "Failed");
        if (f !== null) s.isFailed = f;
        if (s.isFailed) s.isComplete = 0;
        s.nTick += 1;
        return;
      }
      default: {
        const b = TASK_BEHAVIOURS.get(n.type);
        if (b) {
          b.update(this.behaviourContext(index));
          return;
        }
        if (this.host.updateTask?.(n, this)) return;
        // Train (FUN_0042aa90), Heli (FUN_00430950) and Car update their
        // children (their AnimTask) after their own expressions; Building /
        // EditRigidObj inherit a child update (inferred).
        this.updateChildren(index);
        this.host.afterTaskChildren?.(n, this);
      }
    }
  }

  private behaviourContext(index: number): TaskBehaviourContext {
    let c = this.behaviourContexts.get(index);
    if (!c) {
      const node = this.tasks.nodes[index];
      c = {
        runtime: this,
        node,
        state: this.state[index],
        host: this.host,
        eval: (field) => this.eval(index, field),
        evalByte: (field) => this.evalByte(index, field),
        updateChildren: () => this.updateChildren(index),
        emit: (event, data) => this.host.onTaskEvent?.(node, event, data),
      };
      this.behaviourContexts.set(index, c);
    }
    return c;
  }

  private updateArea(index: number): void {
    const area = this.rec<AreaActivateTask>(index);
    const actors: AreaActor[] = [];
    for (const h of this.host.humans?.() ?? []) actors.push({ position: h.position, team: h.team, kind: "human" });
    for (const v of this.host.vehicles?.() ?? []) actors.push({ position: v.position, kind: "vehicle" });
    this.state[index].nActive = areaActiveCount(area, actors, this.areaMask.get(index) ?? 0);
  }

  private updateStatusMessage(index: number): void {
    const s = this.state[index];
    const m = this.rec<StatusMessageTask>(index);
    const now = this.levelFlowTick();
    if ((!m.sendOnce || !s.isSendt) && s.nTickSendt + STATUS_MESSAGE_RESEND_TICKS < now) {
      const v = this.eval(index, "Send");
      if (v === null || v === 0) return;
      this.host.onStatusMessage?.(m, now);
      s.isSendt = 1;
      s.nTickSendt = now;
    }
  }

  private updateContainer(index: number): void {
    const s = this.state[index];
    const c = this.rec<ConditionalContainerTask>(index);
    const prev = s.isRun;
    const cond = this.evalByte(index, "Condition");
    if (cond !== null) s.isRun = cond;
    if (!s.isRun && !prev) {
      if (s.inWorld) {
        this.host.onContainerWorld?.(c, false); // "remove from world" to every child
        s.inWorld = 0;
      }
    } else {
      if (!s.inWorld) {
        this.host.onContainerWorld?.(c, true); // "add to world"
        s.inWorld = 1;
      }
      this.updateChildren(index); // also on the falling-edge tick
    }
    if (s.isRun) {
      if (!prev) this.eval(index, "Run at start");
      return;
    }
    if (prev) this.eval(index, "Run at stop");
  }

  private updateCutScene(index: number): void {
    this.updateChildren(index);
    const s = this.state[index];
    const cut = this.rec<CutSceneTask>(index);
    const run = this.evalByte(index, "Run");
    if (run !== null) s.isRun = run;
    const reset = this.eval(index, "Reset");
    if (reset !== null && (qvmRoundToInt(reset) & 0xff) !== 0) {
      s.nTick = 0;
      s.isFinished = 0;
    }
    const prev = s.wasRun;
    if (s.isRun) {
      const sample = sampleCutSceneCamera(cut, s.nTick, s.keyIndex);
      if (sample) {
        if (sample.finished) {
          s.isFinished = 1;
          s.nTick = qvmRoundToInt(MISSION_TICKS_PER_SECOND * cut.totalSeconds);
        }
        s.keyIndex = sample.keyIndex;
        this.host.onCutSceneCamera?.(sample, cut);
      }
      const delta = this.eval(index, "Time delta (seconds)");
      if (delta === null) s.nTick += 1;
      // 0x4ebf2e: eval (double); fimul 30; fistp -> trunc of the chopped product.
      else s.nTick = Math.max(0, s.nTick + qvmRoundToInt(x87Mul(delta, MISSION_TICKS_PER_SECOND)));
      if (!prev) this.eval(index, "Start expression");
    } else if (prev) {
      this.host.onCutSceneStop?.(cut);
      this.eval(index, "Stop expression");
    }
    s.wasRun = s.isRun;
  }

  private updateAnimTask(index: number): void {
    const s = this.state[index];
    const run = this.evalByte(index, "Run");
    if (run !== null) s.isRun = run;
    if (!s.isRun) return;
    const a = this.rec<AnimTaskData>(index);
    const p = this.animPlayback.get(index)!;
    seekAnimPlayback(p, a.records, p.nTick + 1, (t, ch) => this.animInput(a, t, ch));
  }

  private animInput(a: AnimTaskData, nTick: number, channels: Float32Array): void {
    const target = this.tasks.byId.get(a.targetId);
    if (target !== undefined && this.tasks.nodes[target].type === "Train") {
      trainAnimInput(this.rec<TrainTask>(target), this.trainState.get(target)!, nTick, channels);
      return;
    }
    this.host.onAnimInput?.(a, nTick, channels);
  }

  private updateExplosive(index: number): void {
    this.updateChildren(index);
    const s = this.state[index];
    if (s.isExploded) return;
    const flag = this.evalByte(index, "Explosion expression");
    if (flag !== null) s.exprFlag = flag;
    if (s.exprFlag || s.countdown === 0) {
      s.isExploded = 1; // FUN_0047fdd0: destroyed model, explosion, isExploded
      this.host.onExplode?.(this.tasks.nodes[index].id, this.tasks.nodes[index].type);
      return;
    }
    if (s.countdown > 0) s.countdown -= 1;
  }

  private updateTerminal(index: number): void {
    this.updateExplosive(index);
    const s = this.state[index];
    if (!s.isExploded) {
      const on = this.evalByte(index, "On Expression");
      if (on !== null) s.isOn = on;
    } else {
      s.isOn = 0;
    }
    const now = this.levelFlowTick();
    if (s.useTick + PULSE_HOLD_TICKS < now) s.isInUse = 0;
    s.isLastInUse = s.isInUse;
    if (s.hackTick + PULSE_HOLD_TICKS < now) s.isHackedThisTick = 0;
  }

  private updateSecurityCamera(index: number): void {
    const s = this.state[index];
    const cam = this.rec<SecurityCameraTask>(index);
    // The lens (first child, created by the SCamera) updates first, with last tick's isOn.
    // LAB_00440930 head: the light's blink counter +0x25d4 (7..0) toggles the phase +0x25d8 at 0, every update.
    if (s.lightCount === 0) {
      s.lightCount = SCAMERA_LIGHT_BLINK_RESET;
      s.lightPhase ^= 1;
    } else {
      s.lightCount -= 1;
    }
    s.isLastDetection = s.isDetection;
    const slew = (value: number, target: number, step: number) =>
      value < target ? Math.min(f32(value + step), target) : value > target ? Math.max(f32(value - step), target) : value;
    if (s.isOn) {
      s.pitch = slew(s.pitch, f32(cam.cameraAlpha), SCAMERA_PITCH_STEP);
      this.cameraDetect(index, cam, s);
    } else {
      s.pitch = slew(s.pitch, SCAMERA_OFF_PITCH, SCAMERA_PITCH_STEP);
      s.isDetection = 0;
    }
    // 0x440c24: the lens matrix +0x70 = FUN_004a9bc0(pitch, 0, sweep + gammas); the next update's vision reads it.
    s.rotYaw = s.yaw;
    s.rotPitch = s.pitch;
    this.updateChildren(index);
    if (!s.isExploded) {
      const on = this.evalByte(index, "On Expression");
      if (on !== null) s.isOn = on;
    } else {
      s.isOn = 0;
    }
  }

  /** FUN_00440db0: detection timer, tracking and sweep. */
  private cameraDetect(index: number, cam: SecurityCameraTask, s: NodeState): void {
    const deg = f32(0.01745329238474369);
    s.isDetection = 0;
    const sight = this.host.cameraSighting?.(cam) ?? null;
    // Holder +0x164: the target came from the dead list +0x1ac (camera_beep_al rather than _l).
    s.alert = sight?.alert ? 1 : 0;
    const last = this.cameraTarget.get(index) ?? null;
    if (sight) {
      if (last !== sight.key) {
        this.cameraTarget.set(index, sight.key);
        s.nDetectionTime = sight.alert ? 0 : SCAMERA_DETECTION_TICKS;
      }
      if (s.nDetectionTime !== 0) s.nDetectionTime -= 1;
      if (s.nDetectionTime === 0) s.isDetection = 1;
      if (sight.bearing !== undefined && Math.abs(sight.bearing) > SCAMERA_TRACK_DEADZONE) {
        const step = Math.min(Math.max(sight.bearing, -SCAMERA_TRACK_STEP), SCAMERA_TRACK_STEP);
        s.yaw = Math.min(Math.max(f32(step + s.yaw), f32(-cam.rotateRightDeg * deg)), f32(cam.rotateLeftDeg * deg));
      }
      return;
    }
    s.nDetectionTime = 0;
    if (last !== null) {
      this.cameraTarget.set(index, null);
      s.lostWait = SCAMERA_LOST_TARGET_WAIT_TICKS;
    }
    if (s.lostWait !== 0) s.lostWait -= 1;
    if (s.lostWait !== 0) return;
    if (s.sweepDir === 0) {
      s.sweepDir = 1;
      s.sweepTarget = f32(cam.rotateLeftDeg * deg);
    }
    if (s.sweepWait !== 0) {
      s.sweepWait -= 1;
      return;
    }
    const step = f32(f32(cam.rotateSpeedDegPerSecond * deg) * f32(0.03333333507180214));
    s.yaw = s.yaw < s.sweepTarget ? Math.min(f32(step + s.yaw), s.sweepTarget) : Math.max(f32(s.yaw - step), s.sweepTarget);
    if (s.yaw === s.sweepTarget) {
      s.sweepWait = qvmRoundToInt(f32(cam.gammaDelaySeconds) * 30); // 0x4410f5: float32 x 30.0f, fistp (truncated)
      if (s.sweepDir === -1) {
        s.sweepDir = 1;
        s.sweepTarget = f32(cam.rotateLeftDeg * deg);
      } else {
        s.sweepDir = -1;
        s.sweepTarget = f32(-cam.rotateRightDeg * deg);
      }
    }
  }

  private updateSound(index: number): void {
    const s = this.state[index];
    const snd = this.rec<ConditionalSoundTask>(index);
    const cond = this.evalByte(index, "Condition");
    if (cond !== null) {
      s.isLastRun = s.isRun;
      s.isRun = cond;
    }
    if (this.host.soundPlaying) s.isPlaying = this.host.soundPlaying(snd) ? 1 : 0; // FUN_004248b0
    if (!snd.oneShot || !s.started) {
      if (!s.isRun) {
        // FUN_00424790 stops only a definition voice; a Simple raw sample runs to its end.
        if (s.voice) {
          this.host.onSound?.(snd, false);
          s.voice = 0;
          s.isPlaying = 0;
        }
      } else if (!s.isLastRun) {
        this.host.onSound?.(snd, true); // FUN_004247d0
        s.started = 1;
        s.isPlaying = 1;
        s.voice = snd.simple ? 0 : 1;
      }
      this.updateChildren(index);
    }
  }

  private updateObjectives(index: number): void {
    const def = this.rec<ComputerObjectivesTask>(index);
    const valid = this.eval(index, "Objectives Valid");
    if (valid !== null && (qvmRoundToInt(valid) & 0xff) === 0) return;
    this.objectives = def.objectives.map((o) => ({
      index: o.index, textResource: o.textResource, linkToPosition: o.linkToPosition,
      complete: this.evalByte(index, `Objective ${o.index} Complete Expression`) ?? 0,
      failed: this.evalByte(index, `Objective ${o.index} Failed Expression`) ?? 0,
    }));
  }
}
