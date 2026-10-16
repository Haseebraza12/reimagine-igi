/**
 * Elevator (docs/objects.md "Elevator"; full exe): a platform that runs
 * along a SplineObj between floors = the spline's waypoints.
 *
 * Recovered (full exe): create FUN_0043d010, update FUN_0043d280, move
 * FUN_0043d6e0, pose FUN_0043d960, compile FUN_0043ddb0, members
 * FUN_0043df20, platform method FUN_0043e290 (riders, world/character.ts).
 * - Floor i is at f(i) = float sum of the segment lengths of waypoints 0..i
 *   (FUN_00502180), total = f(n - 1) (FUN_005020c0); the segments are the
 *   rail-spline ones (vehicles.ts RailSpline: a Hermite polyline unless the
 *   SplineObj has "Linear Segments").
 * - Per tick, once (guard +0x644): children first; Wanted floor i ->
 *   isWantedFloor[i] = byte(eval); Floor up / Floor down are rising-edge
 *   steps, else the highest wanted floor wins; while Can start (absent = 1)
 *   the car moves: |d| >= 4 m accelerates by Inertia (m/s per tick) up to
 *   Max, inside 4 m speed = max(|d| Max / 4 m, 0.1); step = speed x 4096/30.
 *   Then vFloor (double) interpolates between the floors, isMoving = pos !=
 *   target (also while halted by Can start), the move loop starts / stops,
 *   isStart / isStop play the start / stop sounds and nInactive counts idle
 *   ticks.
 * - Pose: pos clamped to [0, total]; "Linear" = lerp of the first and last
 *   waypoint positions by pos / total (doubles), R = Orientation; otherwise
 *   the spline point at arc pos (total - 0.1 at the end, FUN_004fec10) and,
 *   unless "Force orientation", R = Orientation . M (the spline frame).
 * - Children follow rigidly (message 0x547f40: pos = parent pos + R local,
 *   R = R . local R, the local offsets captured at compile) [recovered
 *   handler list; capture at compile inferred]: the engine moves them by
 *   current x compile^-1.
 * [inferred] the spline frame M is the piece matrix at pos (FUN_004fec10
 * blends the two piece matrices; every Linear = 0 elevator in the data runs
 * on a "Linear Segments" spline whose two matrices are equal, or has Force
 * orientation); the guard counter is the level tick.
 */
import type { IgiTask } from "../tasks";
import { numberParam, stringParam, vec3Param } from "../tasks";
import { registerTaskBehaviour, eulerToMatrix, mul3, type Mat3, type TaskBehaviourContext, type TaskPose, type Vec3 } from "../mission";
import { qvmRoundToInt } from "../qvm-vm";
import { splineParamsFromTask, splineSegmentFrames } from "../spline-segment";
import { RailSpline } from "../vehicles";
import { x87StoreF32 } from "../x87";

const f32 = x87StoreF32;
/** 0x53382c / 0x533828: the 4 m slow-down distance (units) and its reciprocal. */
export const ELEVATOR_SLOWDOWN_UNITS = 16384;
/** 0x5333c8: the minimum speed inside the slow-down distance (m/s), and the end-of-spline back-off (units). */
export const ELEVATOR_MIN_SPEED = Math.fround(0.1);
/** 0x533680: metres per second -> units per tick (4096 / 30). */
export const ELEVATOR_UNITS_PER_TICK = Math.fround(4096 / 30);
/** 0x5336c0 / 0x533824: the arrival tolerance (units). */
export const ELEVATOR_EPSILON = Math.fround(0.001);
export const ELEVATOR_FLOORS = 10;

export const ELEVATOR_EXPRESSIONS: readonly string[] = [
  "Floor down", "Floor up", "Can start", ...Array.from({ length: ELEVATOR_FLOORS }, (_, i) => `Wanted floor ${i}`),
];

/** FUN_0043df20. */
export const ELEVATOR_MEMBERS = {
  vFloor: "double", vLastFloor: "double",
  ...Object.fromEntries(Array.from({ length: ELEVATOR_FLOORS }, (_, i) => [`isWantedFloor${i}`, "char"])),
  nInactive: "int", nWantedFloor: "int", isMoving: "char", isStart: "char", isStop: "char",
} as const;

/** The compiled elevator: its spline, floors and the current / previous / compile poses. */
export interface ElevatorRig {
  linear: boolean;
  force: boolean;
  orientation: Mat3;
  maxSpeed: number;
  inertia: number;
  /** null when "SplineObj taskid" names no SplineObj with waypoints. */
  rail: RailSpline | null;
  /** f(0..n-1). */
  floors: number[];
  total: number;
  /** Piece matrices per segment (the frame M of FUN_004fec10), [segment][piece]. */
  frames: Mat3[][];
  start: string;
  stop: string;
  move: string;
  pose: TaskPose;
  /** Pose before this tick's move (+0x108 / +0x148): the platform delta. */
  lastPose: TaskPose;
  /** Pose at compile: children follow current x compile^-1. */
  compilePose: TaskPose;
}

const rigs = new WeakMap<TaskBehaviourContext, ElevatorRig>();
const rigByNode = new WeakMap<object, Map<number, ElevatorRig>>();

/** The elevator rig of node `index` in `runtime` (engine: model and children poses, platform). */
export function elevatorRig(runtime: object, index: number): ElevatorRig | null {
  return rigByNode.get(runtime)?.get(index) ?? null;
}

/** Floors f(i): float sums of the segment lengths (FUN_00502180). */
export function elevatorFloors(rail: RailSpline): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < rail.waypoints.length; i++) {
    if (i > 0) acc = f32(acc + (rail.segments[i]?.length ?? 0));
    out.push(acc);
  }
  return out;
}

function floorAt(rig: ElevatorRig, i: number): number {
  if (rig.floors.length === 0) return 0;
  return rig.floors[Math.max(0, Math.min(i, rig.floors.length - 1))];
}

/** FUN_0043d960: place the car for `state.pos` (clamping it). */
export function elevatorPose(rig: ElevatorRig, state: Record<string, number>): void {
  if (!rig.rail) return;
  const total = rig.total;
  let at = state.pos;
  if (total <= state.pos) {
    at = f32(total - ELEVATOR_MIN_SPEED);
    state.pos = total;
  }
  if (at < 0) {
    at = 0;
    state.pos = 0;
  }
  if (!rig.linear) {
    const loc = rig.rail.locate(at);
    const point = rig.rail.evaluate(at, [])?.[0];
    if (!loc || !point) return; // FUN_004fec10 ok = 0: the pose stays
    rig.pose.position = [point[0], point[1], point[2]];
    if (!rig.force) {
      const pieces = rig.frames[loc.seg] ?? [];
      const m = pieces[Math.min(loc.piece, pieces.length - 1)];
      if (m) rig.pose.matrix = mul3(rig.orientation, m);
    }
    return;
  }
  const w = rig.rail.waypoints;
  const a = w[0].position;
  const b = w[w.length - 1].position;
  const t = state.pos / total;
  rig.pose.position = [t * (b[0] - a[0]) + a[0], t * (b[1] - a[1]) + a[1], t * (b[2] - a[2]) + a[2]];
}

/** FUN_0043d6e0: speed and position toward floor nWantedFloor. */
export function elevatorMove(rig: ElevatorRig, state: Record<string, number>): void {
  if (!rig.rail || rig.floors.length === 0) return;
  const target = floorAt(rig, state.nWantedFloor);
  const d = target - state.pos;
  if (Math.abs(d) >= ELEVATOR_SLOWDOWN_UNITS) {
    if (state.speed < rig.maxSpeed) state.speed = Math.min(f32(state.speed + rig.inertia), rig.maxSpeed);
    else if (state.speed > rig.maxSpeed) state.speed = Math.max(f32(state.speed - rig.inertia), rig.maxSpeed);
  } else {
    state.speed = Math.max(f32(Math.abs(d) * rig.maxSpeed * (1 / ELEVATOR_SLOWDOWN_UNITS)), ELEVATOR_MIN_SPEED);
  }
  const step = state.speed * ELEVATOR_UNITS_PER_TICK;
  if (d > ELEVATOR_EPSILON) state.pos = Math.min(f32(state.pos + step), target);
  else if (d < -ELEVATOR_EPSILON) state.pos = Math.max(f32(state.pos - step), target);
  else state.pos = target;
  elevatorPose(rig, state);
}

function rigOf(task: IgiTask, splineTask: IgiTask | null): ElevatorRig {
  const angles = vec3Param(task, "Orientation") ?? [0, 0, 0];
  const orientation = eulerToMatrix(angles[0], angles[1], angles[2]);
  let rail: RailSpline | null = null;
  let frames: Mat3[][] = [];
  if (splineTask && splineTask.type === "SplineObj") {
    const params = splineParamsFromTask(splineTask);
    if (params.waypoints.length > 0) {
      rail = new RailSpline(params);
      frames = [[], ...splineSegmentFrames(params, rail).map((s) => s.matrices)];
    }
  }
  const floors = rail ? elevatorFloors(rail) : [];
  const position = (vec3Param(task, "Position") ?? [0, 0, 0]) as Vec3;
  const pose = (): TaskPose => ({ position: [...position] as Vec3, matrix: [...orientation] as Mat3 });
  return {
    linear: task.params["Linear"] === true,
    force: task.params["Force orientation"] === true,
    orientation,
    maxSpeed: f32(numberParam(task, "Max speed") ?? 5),
    inertia: f32(numberParam(task, "Speed inertia") ?? 0.99),
    rail,
    floors,
    total: floors.length ? floors[floors.length - 1] : 0,
    frames,
    start: stringParam(task, "Start sound") ?? "",
    stop: stringParam(task, "Stop sound") ?? "",
    move: stringParam(task, "Move sound") ?? "",
    pose: pose(),
    lastPose: pose(),
    compilePose: pose(),
  };
}

const copyPose = (p: TaskPose): TaskPose => ({ position: [...p.position] as Vec3, matrix: [...p.matrix] as Mat3 });

/**
 * One elevator tick (FUN_0043d280). Exported for the platform method: a rider whose node runs
 * first makes the elevator update early (FUN_0043e290); the guard keeps it to once per tick.
 */
export function updateElevator(c: TaskBehaviourContext): void {
  const s = c.state;
  const rig = rigs.get(c);
  if (!rig) return;
  const posOld = s.pos;
  const tick = c.runtime.levelTick;
  if (s.guard === tick) return;
  s.guard = tick;
  c.updateChildren();
  const n = rig.floors.length;
  const tgtOld = floorAt(rig, s.nWantedFloor);
  for (let i = 0; i < ELEVATOR_FLOORS; i++) {
    const v = c.evalByte(`Wanted floor ${i}`);
    if (v !== null) s[`isWantedFloor${i}`] = v;
  }
  const upV = c.eval("Floor up");
  const downV = c.eval("Floor down");
  const canV = c.eval("Can start");
  const up = upV === null ? 0 : qvmRoundToInt(upV);
  const down = downV === null ? 0 : qvmRoundToInt(downV);
  const can = canV === null ? 1 : qvmRoundToInt(canV);
  if (up && !s.lastUp) s.nWantedFloor = Math.min(s.nWantedFloor + 1, n - 1);
  else if (down && !s.lastDown) s.nWantedFloor = Math.max(s.nWantedFloor - 1, 0);
  else for (let i = 0; i < ELEVATOR_FLOORS; i++) if (s[`isWantedFloor${i}`]) s.nWantedFloor = i;
  s.lastUp = ((up & 0xff) << 24) >> 24;
  s.lastDown = ((down & 0xff) << 24) >> 24;
  rig.lastPose = copyPose(rig.pose);
  if (can) elevatorMove(rig, s);
  s.vLastFloor = s.vFloor;
  s.vFloor = 0;
  let prev = 0;
  let i = 1;
  for (; i < n; i++) {
    const fi = rig.floors[i];
    if (fi > s.pos) {
      s.vFloor = i - (fi - s.pos) / (fi - prev);
      break;
    }
    prev = fi;
  }
  if (i >= n) s.vFloor = n - 1;
  const tgt = floorAt(rig, s.nWantedFloor);
  s.isMoving = s.pos !== tgt ? 1 : 0;
  const at = rig.pose.position;
  if (s.isMoving && !s.loop && rig.move) {
    s.loop = 1;
    c.emit("loop", { slot: "move", name: rig.move, position: [...at] });
  }
  if (!s.isMoving && s.loop) {
    s.loop = 0;
    c.emit("loop-stop", { slot: "move" });
  }
  // Only a trip that leaves the floor on the tick its target changed (posOld at the old target):
  // a car held by Can start leaves silently.
  s.isStart = posOld === tgtOld && posOld !== s.pos ? 1 : 0;
  if (s.isStart && rig.start) c.emit("sound", { name: rig.start, position: [...at] });
  s.isStop = s.pos === tgt && posOld !== s.pos ? 1 : 0;
  if (s.isStop && rig.stop) c.emit("sound", { name: rig.stop, position: [...at] });
  if (s.pos === tgt && !s.isMoving && can === s.lastCan) s.nInactive += 1;
  else s.nInactive = 0;
  s.lastCan = ((can & 0xff) << 24) >> 24; // +0x640 is a char

}

registerTaskBehaviour("Elevator", {
  expressions: ELEVATOR_EXPRESSIONS,
  members: ELEVATOR_MEMBERS,
  create(c) {
    Object.assign(c.state, {
      pos: 0, speed: 0, nWantedFloor: 0, vFloor: 0, vLastFloor: 0, nInactive: 0, lastUp: 0, lastDown: 0,
      isMoving: 0, isStart: 0, isStop: 0, lastCan: 1, loop: 0, guard: -1,
      ...Object.fromEntries(Array.from({ length: ELEVATOR_FLOORS }, (_, i) => [`isWantedFloor${i}`, 0])),
    });
  },
  compile(c) {
    const id = numberParam(c.node.task, "SplineObj taskid") ?? -1;
    const splineIndex = c.runtime.tasks.byId.get(id);
    const splineTask = splineIndex === undefined ? null : c.runtime.tasks.nodes[splineIndex].task;
    const rig = rigOf(c.node.task, splineTask);
    rigs.set(c, rig);
    let byNode = rigByNode.get(c.runtime);
    if (!byNode) rigByNode.set(c.runtime, (byNode = new Map()));
    byNode.set(c.node.index, rig);
    const s = c.state;
    s.vLastFloor = s.vFloor;
    s.nInactive = 0;
    s.speed = 0;
    s.pos = Math.min(Math.max(f32(numberParam(c.node.task, "Pos") ?? 0), 0), rig.total);
    elevatorPose(rig, s);
    rig.lastPose = copyPose(rig.pose);
    rig.compilePose = copyPose(rig.pose);
    s.isStart = 0;
    s.isStop = 0;
    s.lastCan = 1;
  },
  update: updateElevator,
});
