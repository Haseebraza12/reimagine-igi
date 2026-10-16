/**
 * RotatingObject (missions 3, 5, 8: the radar dish 436_02_1 inside a
 * "RadarDome" Building) [recovered, full exe: class FUN_00438df0 =
 * FUN_00401900("RotatingObject", 0x200, RigidDynCubeObj); create
 * FUN_00438c30, update FUN_00439090, compile FUN_004395d0, bullet hit
 * LAB_00439750, sound host LAB_00439770 (+0x20 position, +0x70 matrix, +0x1a4
 * one-variable block)]:
 *
 *   - create: Degrees per second X / Y / Z (+0x120..+0x128) = 10, Acceleration
 *     X / Y / Z (+0x12c..+0x134) = 1, Destructable (+0x138) = 1, base matrix
 *     +0x160 = identity, var block FUN_004e6ab0(1), destroyed (+0x1a8) = 0;
 *   - compile: +0x160 := +0x70 (the current matrix, identity after create:
 *     the Orientation parameter, stored at +0x160, is overwritten and has no
 *     effect), model + placement at Position, +0x70 := +0x160; target speeds
 *     (+0x13c..) = current speeds (+0x148..) = Degrees per second (it starts at
 *     full speed), angles (+0x154..) = 0; the old sound instance is deleted and
 *     FUN_004e6b00(task, "Rotate sound") started (it loops for the object's
 *     life, independent of On); On expression compiled;
 *   - update (every tick, no children): if (On valid and (char)fistp(On) == 0)
 *     or destroyed: targets = 0 (never restored: once stopped it cannot
 *     restart); per axis the current speed approaches the target by
 *     Acceleration x f32(1/30) (0x533678) without overshoot; angle += speed x
 *     f32(1/30), then while angle >= 360 (0x533818): angle -= 360 (only the
 *     upward wrap); +0x70 = Base x FUN_004b38e0(angles x f32(pi/180)
 *     (0x53367c)) = Rz(z) Ry(y) Rx(x) (FUN_004b3be0 / FUN_004b3ba0 /
 *     FUN_004b3b60, the order of every Real32x9 orientation); sound var 0 =
 *     curY/degY + curX/degX + curZ/degZ clamped to [0, 1] (NaN when a Degrees
 *     per second is 0: 0/0 passes both clamps; generator_run reads no var);
 *   - bullet hit: Destructable sets destroyed, so the targets go to 0 and it
 *     spins down. No shipped instance is destructable; not in the explosion
 *     damage list; no members.
 * Data [observed]: L3 90 deg/s about z, On "1" (spins forever); L5 25 deg/s,
 * Acceleration z 0, On "0" (target 0 but acceleration 0: spins forever at 25
 * deg/s); L8 25 deg/s, On "!Switch_260.isPressed" (decelerates at 1 deg/s^2 to
 * a stop 25 s after the press and never restarts). All use model 436_02_1,
 * Orientation (0, 0, 0), Destructable false; L5 / L8 loop "generator_run".
 * The engine (engine/world/world-tasks.ts) poses the dynamic instance from
 * rotatingObjectMatrix() after every tick (render + collision follow) and
 * plays the sound at Position with var 0.
 */
import { eulerToMatrix, registerTaskBehaviour, type Mat3, type TaskBehaviourContext } from "../mission";
import { x87F32Add, x87F32Sub, x87StoreF32 } from "../x87";
import type { IgiTask } from "../tasks";

/** f32(1/30) (0x533678): per-tick factor of speeds and accelerations. */
export const ROTATING_TICK = Math.fround(0.03333333507180214);
/** 360.0f (0x533818): the angle wrap. */
export const ROTATING_WRAP = 360;
/** f32(pi/180) (0x53367c). */
export const ROTATING_DEG = Math.fround(0.01745329238474369);

const AXES = ["X", "Y", "Z"] as const;

/** The parameters the update reads (create defaults where the task has none). */
export interface RotatingObjectParams {
  /** "Degrees per second X/Y/Z-axis" (+0x120..+0x128, default 10). */
  degreesPerSecond: [number, number, number];
  /** "Acceleration, degrees per second X/Y/Z-axis" (+0x12c..+0x134, default 1). */
  acceleration: [number, number, number];
  /** "Destructable" (+0x138, default 1). */
  destructable: boolean;
  /** "Rotate sound" (+0xf0, String16). */
  sound: string;
  /** "Model" (+0x110). */
  model: string;
}

const numOr = (task: IgiTask, key: string, fallback: number): number => {
  const v = task.params[key];
  return typeof v === "number" ? Math.fround(v) : fallback;
};

export function rotatingObjectParams(task: IgiTask): RotatingObjectParams {
  const d = task.params["Destructable"];
  const s = task.params["Rotate sound"];
  const m = task.params["Model"];
  return {
    degreesPerSecond: AXES.map((a) => numOr(task, `Degrees per second ${a}-axis`, 10)) as [number, number, number],
    acceleration: AXES.map((a) => numOr(task, `Acceleration, degrees per second ${a}-axis`, 1)) as [number, number, number],
    destructable: typeof d === "boolean" ? d : typeof d === "number" ? d !== 0 : true,
    sound: typeof s === "string" ? s : "",
    model: typeof m === "string" ? m : "",
  };
}

/** Runtime fields (node state keys): target (+0x13c), current (+0x148), angle (+0x154) per axis, destroyed (+0x1a8), var 0. */
export interface RotatingObjectState {
  tx: number; ty: number; tz: number;
  cx: number; cy: number; cz: number;
  ax: number; ay: number; az: number;
  destroyed: number;
  var0: number;
}

/** FUN_004395d0 (compile): targets = current = Degrees per second, angles 0. */
export function rotatingObjectCompile(s: Record<string, number>, p: RotatingObjectParams): void {
  const [dx, dy, dz] = p.degreesPerSecond;
  Object.assign(s, { tx: dx, ty: dy, tz: dz, cx: dx, cy: dy, cz: dz, ax: 0, ay: 0, az: 0 });
}

/** One axis of FUN_00439090: approach the target by acc / 30 without overshoot. */
function approach(cur: number, target: number, acc: number): number {
  if (cur === target) return cur;
  const step = acc * ROTATING_TICK; // f32 x f32: exact in a double
  if (target <= cur) {
    if (target < cur) {
      const next = x87F32Add(cur, -step);
      return next < target ? target : next;
    }
    return cur;
  }
  const next = x87F32Add(step, cur);
  return target < next ? target : next;
}

/** angle += speed / 30, then the upward-only wrap at 360. */
function advance(angle: number, speed: number): number {
  let a = x87F32Add(speed * ROTATING_TICK, angle);
  while (ROTATING_WRAP <= a) a = x87F32Sub(a, ROTATING_WRAP);
  return a;
}

/**
 * FUN_00439090 on the node state. `on` = (char)fistp(eval(On expression)), or
 * null when the expression is absent (FUN_004f16c0 false).
 */
export function rotatingObjectUpdate(s: Record<string, number>, p: RotatingObjectParams, on: number | null): void {
  if ((on !== null && on === 0) || s.destroyed) {
    s.tx = 0;
    s.ty = 0;
    s.tz = 0;
  }
  s.cx = approach(s.cx, s.tx, p.acceleration[0]);
  s.cy = approach(s.cy, s.ty, p.acceleration[1]);
  s.cz = approach(s.cz, s.tz, p.acceleration[2]);
  s.ax = advance(s.ax, s.cx);
  s.ay = advance(s.ay, s.cy);
  s.az = advance(s.az, s.cz);
  // Var block +0x1a4 slot 0: the summed speed ratio (one x87 expression, stored), clamped (a NaN passes both tests).
  const [dx, dy, dz] = p.degreesPerSecond;
  let v = x87StoreF32(s.cy / dy + s.cx / dx + s.cz / dz);
  if (v < 0) v = 0;
  else if (1 < v) v = 1;
  s.var0 = v;
}

/** +0x70 after an update: Rz(angle z) Ry(angle y) Rx(angle x), angles in degrees x f32(pi/180) (the base +0x160 is identity). */
export function rotatingObjectMatrix(s: Readonly<Record<string, number>>): Mat3 {
  return eulerToMatrix(
    Math.fround((s.ax ?? 0) * ROTATING_DEG),
    Math.fround((s.ay ?? 0) * ROTATING_DEG),
    Math.fround((s.az ?? 0) * ROTATING_DEG),
  );
}

/** A bullet hit (LAB_00439750): Destructable sets destroyed. */
export function rotatingObjectBulletHit(s: Record<string, number>, p: RotatingObjectParams): void {
  if (p.destructable) s.destroyed = 1;
}

const paramsCache = new WeakMap<IgiTask, RotatingObjectParams>();
const paramsOf = (c: TaskBehaviourContext): RotatingObjectParams => {
  let p = paramsCache.get(c.node.task);
  if (!p) paramsCache.set(c.node.task, (p = rotatingObjectParams(c.node.task)));
  return p;
};

registerTaskBehaviour("RotatingObject", {
  expressions: ["On expression"],
  create(c) {
    Object.assign(c.state, { tx: 0, ty: 0, tz: 0, cx: 0, cy: 0, cz: 0, ax: 0, ay: 0, az: 0, destroyed: 0, var0: 0 });
  },
  compile(c) {
    rotatingObjectCompile(c.state, paramsOf(c));
  },
  update(c) {
    rotatingObjectUpdate(c.state, paramsOf(c), c.evalByte("On expression"));
  },
});
