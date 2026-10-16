/**
 * Vehicle physics of igi.exe: helicopter, car / truck, and train wagons along
 * a rail spline, as deterministic per-tick simulations in IGI units.
 *
 * Python reference with self-checks and the level-1 replays:
 * tools/igi_vehicles.py; documentation and evidence: docs/vehicles.md.
 *
 * Evidence labels used below:
 *   [recovered] read from igi.exe code (Ghidra FUN_ names, image base 0x400000)
 *   [observed]  measured on the shipped files
 *   [inferred]  interpretation the traced code does not prove
 *
 * Units and conventions: 4096 units = 1 m, z up, 30 ticks per second;
 * velocities in units/tick, forces in units*mass/tick^2.  Matrices are
 * row-major `Mat3` with world = M * local (columns are the local axes), the
 * layout of the exe's float[9] at object +0x70.  Positions are doubles (the
 * exe's +0x20); everything the exe stores in float fields is rounded with
 * Math.fround at the same points (x87 extended precision in between is
 * approximated by doubles).
 *
 * The world is abstracted as `VehicleWorld.castDown`: every ground probe of
 * the heli skids (FUN_004317d0) and the car wheels (FUN_0042e1a0) is a
 * vertical segment cast through FUN_004c24c0 that ignores the vehicle itself.
 */
import { x87StoreF32 } from "./x87";
import type { QvmCall, QvmValue } from "./qvm";
import { readQvmCallTree } from "./qvm";
import type { IgiTask } from "./tasks";
import type { MefAttachment } from "./mef";
import type { AnimRecord, Mat3, TrainState, TrainTask, Vec3 } from "./mission";
import { stepAnimRecords } from "./mission";

/** FSTP DWORD in chop mode (the game's FPU setting): float32 stores truncate. */
const f32 = x87StoreF32;

// ---------------------------------------------------------------------------
// Constants [recovered: values read from igi.exe]
// ---------------------------------------------------------------------------

/** Gravity pushed by the heli and car steps (immediate 0x4232674f): 9.8 m/s^2 in units/tick^2. */
export const VEHICLE_GRAVITY = f32(44.600887298583984);
/** Heli skid spring scale m * this (0x531764). */
const QUARTER_G = f32(11.150221824645996);
/** FUN_004f2d00 damping arguments: heli (FUN_004310b0) and car (FUN_0042df40). */
export const HELI_DAMPING = { linear: f32(1), angular: f32(0.92) } as const;
export const CAR_DAMPING = { linear: f32(0.97), angular: f32(0.9) } as const;
/** The position integrates only when the speed exceeds 0.01 m/tick (0x531730). */
export const VEHICLE_MOVE_THRESHOLD = f32(40.96);
const DRAG_K = f32(0.00032699998700991273); // immediate 0x39ab7132
const LEN_K1 = f32(0.414213568); // 0x532a64
const LEN_K2 = f32(0.317837238); // 0x532a68
const INERTIA_K = f32(1 / 12); // 0x531888
const INV_INERTIA_SCALE = f32(1.01); // 0x5322c4
const DEG = f32(0.0174532924); // 0x531684
const HELI_FAST_THRUST = f32(0.8); // 0x531758 (double, compared as float)
const HELI_ZERO_THRUST = f32(0.001); // 0x5316c0
const HELI_MOVING_SPEED = f32(2); // 0x531588
const HELI_PITCH_K = f32(-0.8); // 0x531750
const HELI_YAW_K = f32(0.08); // 0x53174c
const HELI_PITCH_ARM = f32(819.2); // 0.2 m
const HELI_ROLL_ARM = f32(409.6); // 0.1 m
const HELI_YAW_ARM = 12288; // 3 m
const HELI_TURN_K_UP = f32(-0.7); // 0x531748
const HELI_TURN_K_DOWN = f32(0.7); // 0x5316c4
const HELI_TURN_K = f32(0.000290888208665722); // 0x531740
const ROTOR_TORQUE_K = f32(2.5); // 0x5316f0
const ROTOR_TORQUE_ARM = 8192; // immediate 0x46000000 (2 m)
const SKID_RAY_UP = 8192; // 0x531708 double
const CAR_RAY_UP = 4096; // 0x531498 double
const CAR_RAY_DOWN = 2048; // 0x531460 double
const CAR_WHEEL_POINT_LIFT = f32(1638.4); // 0x531718
const CAR_ZERO_THRUST = f32(0.01); // 0x531714
const FRICTION_STATIC = f32(0.1); // 0x5313c8
const FRICTION_KINETIC = f32(0.24); // 0x531738
const FRICTION_LIMIT = f32(4); // 0x53158c
const WHEEL_SPIN_K = f32(0.6); // 0x53169c
const WHEEL_SPIN_SMOOTH = f32(0.7); // 0x5316c4
const WHEEL_SPIN_GAIN = f32(0.3); // 0x5316a4
const TWO_PI_D = 6.283185307179586; // 0x531728 double
const SPLINE_DEGENERATE = 0.001; // 0x532b88 double
const PI_F = f32(Math.PI); // 0x531400

// ---------------------------------------------------------------------------
// Small float math
// ---------------------------------------------------------------------------

/** FUN_004a9e40: rotation about x. */
export function rotX(a: number): Mat3 {
  const s = f32(Math.sin(a));
  const c = f32(Math.cos(a));
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
/** FUN_004a9e80: rotation about y. */
export function rotY(a: number): Mat3 {
  const s = f32(Math.sin(a));
  const c = f32(Math.cos(a));
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
/** FUN_004a9ec0: rotation about z. */
export function rotZ(a: number): Mat3 {
  const s = f32(Math.sin(a));
  const c = f32(Math.cos(a));
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** Float matrix product (each entry rounded). */
export function matMulF(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9) as Mat3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[r * 3 + c] = f32(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]);
  }
  return out;
}

/** FUN_004a9bc0: M = Rz(gamma) Ry(beta) Rx(alpha) with float entries (task "Orientation"). */
export function eulerF(alpha: number, beta: number, gamma: number): Mat3 {
  return matMulF(matMulF(rotZ(f32(gamma)), rotY(f32(beta))), rotX(f32(alpha)));
}

/**
 * The rotation an attached child gets from its ATTA record (FUN_004c4950,
 * full exe, the create of every ATTA child) [recovered]: with a = column 0
 * and b = column 1 of the stored 3x3 (the row-vector matrix of
 * docs/formats.md), c = a x b, the child matrix (column form, world = P M)
 * has rows (unit a, unit(c x a), unit(unit a x (c x a))). For a proper
 * rotation this is the transpose of the stored matrix (the reading
 * loaders/level.ts used); a mirroring record (det -1: 8 of the 2,120 ATTA
 * records of the full game, the SU-27's left gear 702_15_1 and left taileron
 * 702_14_1 and six parts of 617_01_1 [observed]) becomes the proper rotation
 * that keeps a and b (diag(-1, 1, 1) -> diag(-1, 1, -1)). Float32 as the
 * exe stores it.
 */
export function attaMatrix(f: readonly number[]): Mat3 {
  const a: Vec3 = [f32(f[0]), f32(f[3]), f32(f[6])];
  const b: Vec3 = [f32(f[1]), f32(f[4]), f32(f[7])];
  const c: Vec3 = [f32(b[2] * a[1] - b[1] * a[2]), f32(-(b[2] * a[0] - b[0] * a[2])), f32(b[1] * a[0] - b[0] * a[1])];
  const unit = (v: Vec3): Vec3 => {
    if (isZero(v)) return v;
    const k = 1 / Math.sqrt(v[2] * v[2] + v[1] * v[1] + v[0] * v[0]);
    return [f32(v[0] * k), f32(v[1] * k), f32(v[2] * k)];
  };
  const r0 = unit(a);
  const r1: Vec3 = [f32(c[1] * a[2] - c[2] * a[1]), f32(-(c[0] * a[2] - c[2] * a[0])), f32(c[0] * a[1] - c[1] * a[0])];
  const r2: Vec3 = [f32(r1[2] * r0[1] - r1[1] * r0[2]), f32(-(r1[2] * r0[0] - r1[0] * r0[2])), f32(r1[1] * r0[0] - r1[0] * r0[1])];
  const u1 = unit(r1);
  const u2 = unit(r2);
  return [r0[0], r0[1], r0[2], u1[0], u1[1], u1[2], u2[0], u2[1], u2[2]];
}

/** FUN_004a8cf0: approximate length max + 0.4142 mid + 0.3178 min of |x|, |y|, |z|. */
export function approxLength(v: readonly number[]): number {
  const a = [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])].sort((p, q) => p - q);
  return a[1] * LEN_K1 + a[0] * LEN_K2 + a[2];
}

/** FUN_004a8e10: angle between two vectors (0 for a zero vector; acos clamped). */
function angleBetween(a: Vec3, b: Vec3): number {
  if ((a[0] === 0 && a[1] === 0 && a[2] === 0) || (b[0] === 0 && b[1] === 0 && b[2] === 0)) return 0;
  const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2])
    / (f32(Math.sqrt(f32(b[2] * b[2] + b[1] * b[1] + b[0] * b[0]))) * f32(Math.sqrt(f32(a[2] * a[2] + a[1] * a[1] + a[0] * a[0]))));
  if (d >= 1) return 0;
  if (d <= -1) return PI_F;
  return Math.acos(d);
}

function isZero(v: readonly number[]): boolean {
  return v[0] === 0 && v[1] === 0 && v[2] === 0;
}

function d2(a: readonly number[], b: readonly number[]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

// ---------------------------------------------------------------------------
// Physics object types (DefinePhysicsObjType)
// ---------------------------------------------------------------------------

export interface PhysicsContactPoint {
  /** Model magic vertex (XTVM) index (+0x14c). */
  vertex: number;
  /** +0x150: side for the differential (FUN_0042f730). */
  a: number;
  /** +0x154 (not traced; 5 on the truck). */
  b: number;
  /** +0x158 (not traced). */
  c: number;
  /** +0x15c: tyre grip across the wheel (FUN_0042fbe0 lateral factor). */
  gripLateral: number;
  /** +0x160: tyre grip along the wheel (rolling). */
  gripRolling: number;
}

export interface DragElement {
  coef: number;
  /** Unit normal (body frame). */
  normal: Vec3;
  /** Application point (body frame, units). */
  point: Vec3;
}

/** Base vehicle config (FUN_004f9e10, 0x118 bytes at type +0x2d4). */
export interface VehicleBaseConfig {
  /** cfg[0..9] (+0x00..+0x24). Heli: [1] pitch gain, [2] pitch smoothing, [3] roll gain, [4] roll smoothing, [5] yaw gain, [6] yaw smoothing, [8] thrust step >= 0.8, [9] thrust step < 0.8. Car: [6] steering smoothing, [7] drive force, [8] thrust smoothing. */
  c: number[];
  drag: DragElement[];
  /** +0x10c view-cone length (units), +0x110 / +0x114 half angles (rad). */
  viewCone: Vec3;
  /** Class-specific values after the base fields that are not decoded. */
  extra: QvmValue[];
}

export interface CarWheelConfig {
  steerable: boolean;
  driven: boolean;
  maxSteerDeg: number;
  /** Contact point index; < 0: no physics, the wheel model shows contact -10 - k. */
  contact: number;
  /** Suspension travel (units). */
  travel: number;
  spring: number;
}

export interface CarConfig extends VehicleBaseConfig {
  wheels: CarWheelConfig[];
  /** +0x25c (units): wheel contact points are lowered by this at reset (FUN_0042ded0). */
  suspensionOffset: number;
  /** +0x260: wheels exist only when the model's TASKTYPE_WHEEL magic objects claim them. */
  wheelsFromModel: boolean;
  /** +0x261: differential factor FUN_0042f730. */
  differential: boolean;
  sound: string;
  explosionVertices: number[];
  wreckModel: string;
}

export interface RotorConfig { main: boolean; tail: boolean; spinSign: number; arg3: number; spin: number; model: string }
export interface WheelModelConfig { model: string; radius: number; bounce: number }

/**
 * Missile type config (TASKTYPE_MISSILE, class "Missile" FUN_00427ff0, full exe): the base
 * vehicle config read by the Vehicle class (FUN_004f9e10, through the reader FUN_00429730's
 * parent call), then the tail FUN_00429730 reads [recovered]: +0x118 smoke (MISSILE_SMOKE_NONE 0 /
 * NORMAL 1), +0x11c guidance (MISSILE_TYPE_MISSILE_DIRECT 0, HIND_HELICOPTER 1, BALLISTIC 2,
 * ANTITANK 3, KEYBOARD 4, BOMB 5; symbols registered by FUN_00427ff0), +0x120 fuel, +0x124 burn
 * per tick = arg x f32 1/30 (0x533678), +0x128, +0x12c / +0x130 = arg x 4096 (0x5333b8), +0x134,
 * +0x138, +0x13c smoke sprite, +0x23c sound group.
 */
export interface MissileConfig extends VehicleBaseConfig {
  smoke: number;
  guidance: number;
  fuel: number;
  burn: number;
  /** +0x128 (50 in every shipped type; no reader traced). */
  arg4: number;
  /** +0x12c: smoke particle spacing along the path (units); +0x130: the smoke growth end size (units). */
  smokeSpacing: number;
  smokeGrowth: number;
  /** +0x134: ticks between smoke emissions (fistp, chop); +0x138: smoke size / life factor. */
  smokeInterval: number;
  smokeSize: number;
  sprite: string;
  sound: string;
}

/** MISSILE_* symbols of the physicsobj scripts (FUN_00427ff0 registration) [recovered]. */
export const MISSILE_SYMBOLS: Readonly<Record<string, number>> = {
  MISSILE_SMOKE_NONE: 0, MISSILE_SMOKE_NORMAL: 1,
  MISSILE_TYPE_MISSILE_DIRECT: 0, MISSILE_TYPE_HIND_HELICOPTER: 1, MISSILE_TYPE_MISSILE_BALLISTIC: 2,
  MISSILE_TYPE_MISSILE_ANTITANK: 3, MISSILE_TYPE_MISSILE_KEYBOARD: 4, MISSILE_TYPE_BOMB: 5,
};

export interface PhysicsObjType {
  source: string;
  taskType: string;
  index: number;
  mass: number;
  /** Box size in metres (x, y, z): inertia and the default body. */
  size: Vec3;
  name: string;
  description: string;
  /** The vehicle task's "Model" selects its type (FUN_004e4cc0). */
  model: string;
  points: PhysicsContactPoint[];
  /** +0x2cc: at rest below this speed (units/tick) ... */
  restSpeed: number;
  /** +0x2d0: ... and this squared angular speed. */
  restAngular: number;
  config: VehicleBaseConfig | CarConfig | RotorConfig | WheelModelConfig | MissileConfig | { raw: QvmValue[] };
}

function sym(v: QvmValue | undefined): string {
  return typeof v === "object" && v !== null && "symbol" in v ? v.symbol : String(v);
}
function num(v: QvmValue | undefined): number {
  return typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : 0;
}
function text(v: QvmValue | undefined): string {
  return typeof v === "string" ? v : "";
}

/**
 * Decode one DefinePhysicsObjType call (handler FUN_004e48a0, type records of
 * 0x2d8 bytes at 0x7ef6c8) [recovered layout].
 */
export function decodePhysicsObjType(args: readonly QvmValue[], source = ""): PhysicsObjType {
  const a = args;
  const t: PhysicsObjType = {
    source, taskType: sym(a[0]), index: num(a[1]), mass: f32(num(a[2])),
    size: [f32(num(a[3])), f32(num(a[4])), f32(num(a[5]))], name: text(a[6]), description: text(a[7]), model: text(a[8]),
    points: [], restSpeed: 0, restAngular: 0, config: { raw: [] },
  };
  const n = num(a[9]);
  let i = 10;
  for (let k = 0; k < n; k++, i += 6) {
    t.points.push({ vertex: num(a[i]), a: num(a[i + 1]), b: num(a[i + 2]), c: f32(num(a[i + 3])), gripLateral: f32(num(a[i + 4])), gripRolling: f32(num(a[i + 5])) });
  }
  t.restSpeed = f32(num(a[i]));
  t.restAngular = f32(num(a[i + 1]));
  i += 2;
  const rest = a.slice(i);
  // TASKTYPE_PLANE: the base config only (Plane class, FUN_004330f0 registration; spec vehicles §1.4).
  if (t.taskType === "TASKTYPE_HELI" || t.taskType === "TASKTYPE_CAR" || t.taskType === "TASKTYPE_PLANE") {
    const { cfg, next } = decodeVehicleBase(rest);
    if (t.taskType === "TASKTYPE_CAR") {
      const car = cfg as CarConfig;
      const j = decodeCar(car, rest, next);
      car.extra = rest.slice(j);
    } else {
      cfg.extra = rest.slice(next);
    }
    t.config = cfg;
  } else if (t.taskType === "TASKTYPE_MISSILE") {
    // turrets: FUN_00429730 (the Vehicle base config first, then the missile tail).
    const { cfg, next } = decodeVehicleBase(rest);
    const r = rest.slice(next);
    const symOrNum = (v: QvmValue | undefined) => (typeof v === "object" && v !== null && "symbol" in v ? MISSILE_SYMBOLS[v.symbol] ?? 0 : num(v));
    const m: MissileConfig = {
      ...cfg,
      smoke: symOrNum(r[0]), guidance: symOrNum(r[1]), fuel: f32(num(r[2])), burn: f32(f32(num(r[3])) * f32(0.03333333507180214)), arg4: f32(num(r[4])),
      smokeSpacing: f32(f32(num(r[5])) * 4096), smokeGrowth: f32(f32(num(r[6])) * 4096), smokeInterval: f32(num(r[7])), smokeSize: f32(num(r[8])),
      sprite: text(r[9]), sound: text(r[10]), extra: r.slice(11),
    };
    t.config = m;
  } else if (t.taskType === "TASKTYPE_ROTOR") {
    // FUN_0042ccc0
    t.config = { main: num(rest[0]) !== 0, tail: num(rest[1]) !== 0, spinSign: num(rest[2]), arg3: f32(f32(num(rest[3])) * 0.017453292519943295), spin: f32(num(rest[4])), model: text(rest[5]) };
  } else if (t.taskType === "TASKTYPE_WHEEL") {
    // FUN_0042f100
    t.config = { model: text(rest[0]), radius: f32(f32(num(rest[1])) * 4096), bounce: f32(f32(num(rest[2])) * 4096) };
  } else {
    t.config = { raw: rest };
  }
  return t;
}

/** FUN_004f9e10 + FUN_004e3050 (drag element args coef, px, py, pz (m), nx, ny, nz). */
function decodeVehicleBase(a: readonly QvmValue[]): { cfg: VehicleBaseConfig; next: number } {
  const c = a.slice(0, 10).map((v) => f32(num(v)));
  const n = num(a[10]);
  let j = 11;
  const drag: DragElement[] = [];
  for (let k = 0; k < n; k++, j += 7) {
    const [coef, px, py, pz, nx0, ny0, nz0] = a.slice(j, j + 7).map((v) => f32(num(v)));
    const ln = Math.sqrt(nx0 * nx0 + ny0 * ny0 + nz0 * nz0);
    const normal: Vec3 = ln ? [f32(nx0 / ln), f32(ny0 / ln), f32(nz0 / ln)] : [nx0, ny0, nz0];
    drag.push({ coef, normal, point: [f32(px * 4096), f32(py * 4096), f32(pz * 4096)] });
  }
  const viewCone: Vec3 = [f32(f32(num(a[j])) * 4096), f32(f32(num(a[j + 1])) * 0.5 * DEG), f32(f32(num(a[j + 2])) * 0.5 * DEG)];
  return { cfg: { c, drag, viewCone, extra: [] }, next: j + 3 };
}

/** FUN_0042cda0 (after the base config). */
function decodeCar(cfg: CarConfig, a: readonly QvmValue[], start: number): number {
  let j = start;
  const n = num(a[j++]);
  cfg.wheels = [];
  for (let k = 0; k < n; k++, j += 6) {
    cfg.wheels.push({
      steerable: num(a[j]) !== 0, driven: num(a[j + 1]) !== 0, maxSteerDeg: f32(num(a[j + 2])), contact: num(a[j + 3]),
      travel: f32(f32(num(a[j + 4])) * 4096), spring: f32(num(a[j + 5])),
    });
  }
  cfg.suspensionOffset = f32(f32(num(a[j])) * 4096);
  cfg.wheelsFromModel = num(a[j + 1]) !== 0;
  cfg.differential = num(a[j + 2]) !== 0;
  cfg.sound = text(a[j + 3]);
  const k = num(a[j + 4]);
  cfg.explosionVertices = a.slice(j + 5, j + 5 + k).map(num);
  cfg.wreckModel = text(a[j + 5 + k]);
  return j + 6 + k;
}

/**
 * Read every DefinePhysicsObjType of one physicsobj script.  The three plane
 * scripts fold constant argument expressions (`15000 * 1.5`, `0.027 * 2`;
 * qvm.ts constexpr arguments); a script outside the call-tree grammar throws.
 */
export function readPhysicsObjTypes(buffer: ArrayBuffer, source = ""): PhysicsObjType[] {
  const calls: QvmCall[] = readQvmCallTree(buffer);
  return calls.filter((c) => c.fn === "DefinePhysicsObjType").map((c) => decodePhysicsObjType(c.args, source));
}

/** FUN_004e4cc0: the type whose model equals the task's "Model". */
export function physicsTypeForModel(types: readonly PhysicsObjType[], model: string): PhysicsObjType {
  const found = types.find((t) => t.model.toLowerCase() === model.toLowerCase());
  if (!found) throw new Error(`vehicles: no DefinePhysicsObjType for model ${model}`);
  return found;
}

/** magicobj.qvm DefineMagicObj(name, model, TASKTYPE, params...). */
export interface MagicObjectDef { model: string; taskType: string; params: number[] }

/**
 * Host symbols magicobj.qvm passes as parameters [recovered: the Rudder
 * registration FUN_004361d0 (full exe) registers RUDDER_AILERON 0,
 * RUDDER_TAILERON_LEFT 1, RUDDER_TAILERON_RIGHT 2, RUDDER_GAMMA 3].
 */
export const MAGIC_PARAM_SYMBOLS: Readonly<Record<string, number>> = {
  RUDDER_AILERON: 0, RUDDER_TAILERON_LEFT: 1, RUDDER_TAILERON_RIGHT: 2, RUDDER_GAMMA: 3,
};

export function readMagicObjects(buffer: ArrayBuffer): Map<string, MagicObjectDef> {
  const out = new Map<string, MagicObjectDef>();
  for (const c of readQvmCallTree(buffer)) {
    if (c.fn !== "DefineMagicObj") continue;
    const param = (v: QvmValue) => (typeof v === "object" && v !== null && "symbol" in v ? MAGIC_PARAM_SYMBOLS[v.symbol] ?? 0 : num(v));
    out.set(text(c.args[0]).toLowerCase(), { model: text(c.args[1]), taskType: sym(c.args[2]), params: c.args.slice(3).map(param) });
  }
  return out;
}

/**
 * XTVM chunk of a .mef: 16-byte magic vertices {f32 x, y, z, u32}
 * (FUN_004c59c0 reads model +0x88 + 16 i) [observed layout].
 */
export function readMefMagicVertices(buffer: ArrayBuffer): Vec3[] {
  const view = new DataView(buffer);
  const tag = (o: number) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (tag(0) !== "ILFF" || tag(16) !== "OCEM") throw new Error("vehicles: not an ILFF/OCEM model");
  const alignUp = (v: number, a: number) => (a > 1 ? Math.ceil(v / a) * a : v);
  let pos = alignUp(20, view.getUint32(8, true));
  for (;;) {
    const size = view.getUint32(pos + 4, true);
    const align = view.getUint32(pos + 8, true);
    const delta = view.getUint32(pos + 12, true);
    const payload = alignUp(pos + 16, align);
    if (tag(pos) === "XTVM") {
      const out: Vec3[] = [];
      for (let i = 0; i + 16 <= size; i += 16) {
        out.push([view.getFloat32(payload + i, true), view.getFloat32(payload + i + 4, true), view.getFloat32(payload + i + 8, true)]);
      }
      return out;
    }
    if (delta === 0) return [];
    pos += delta;
  }
}

// ---------------------------------------------------------------------------
// Rigid body (object +0xf0)
// ---------------------------------------------------------------------------

/**
 * Rigid body embedded at object +0xf0 [recovered FUN_004e3160, FUN_004e3220,
 * FUN_004e3930, FUN_004e3ad0]: +0 mass, +4 1/mass, +8 speed (approximate
 * |v|), +0xc inverse inertia (diagonal, body frame), +0x18 velocity (world),
 * +0x24 unit velocity, +0x30 angular momentum (BODY frame), +0x3c last net
 * force, +0x48 angular velocity (world), +0x54/+0x5c pending forces
 * (force and point, both in the body frame).
 */
export class RigidBody {
  mass = 0;
  invMass = 0;
  invInertia: Vec3 = [0, 0, 0];
  velocity: Vec3 = [0, 0, 0];
  speed = 0;
  velocityDir: Vec3 = [0, 0, 0];
  angularMomentum: Vec3 = [0, 0, 0];
  lastForce: Vec3 = [0, 0, 0];
  angularVelocity: Vec3 = [0, 0, 0];
  forces: Array<{ force: Vec3; point: Vec3 }> = [];

  /** FUN_004e31e0. */
  resetMotion(): void {
    this.velocity = [0, 0, 0];
    this.speed = 0;
    this.velocityDir = [0, 0, 0];
    this.angularMomentum = [0, 0, 0];
    this.lastForce = [0, 0, 0];
    this.angularVelocity = [0, 0, 0];
    this.forces = [];
  }

  /** FUN_004f2320 -> FUN_004e3a50 -> FUN_004e3160: box inertia m (b^2 + c^2) / 12 (size in units), inverse x 1.01. */
  setup(mass: number, sizeM: Vec3): void {
    const [dx, dy, dz] = sizeM.map((s) => f32(s * 4096));
    const ix = f32((dz * dz + dy * dy) * mass * INERTIA_K);
    const iy = f32((dz * dz + dx * dx) * mass * INERTIA_K);
    const iz = f32((dy * dy + dx * dx) * mass * INERTIA_K);
    this.mass = mass;
    this.invMass = f32(1 / mass);
    this.invInertia = [ix, iy, iz].map((i) => f32(f32(1 / i) * INV_INERTIA_SCALE)) as Vec3;
    this.resetMotion();
  }

  /** FUN_004e3ad0: append a force at a point, both in the body frame. */
  add(force: readonly number[], point: readonly number[]): void {
    this.forces.push({ force: [f32(force[0]), f32(force[1]), f32(force[2])], point: [f32(point[0]), f32(point[1]), f32(point[2])] });
  }

  /** FUN_004e3930. */
  updateSpeed(): void {
    this.speed = f32(approxLength(this.velocity));
    const v = this.velocity;
    if (this.speed <= 0) this.velocityDir = [0, 0, 0];
    else if (!isZero(v)) {
      const k = f32(1 / Math.sqrt(f32(v[2] * v[2] + v[1] * v[1] + v[0] * v[0])));
      this.velocityDir = [f32(v[0] * k), f32(v[1] * k), f32(v[2] * k)];
    }
  }

  /**
   * FUN_004e3220: v += M (sum F / m); L += sum(p x F); w = M (I^-1 L); the
   * orientation turns by w through an 8-multiply quaternion product.
   * Returns the new orientation (the same one when L = 0).
   */
  integrate(m: Mat3): Mat3 {
    let [x, y, z, w] = quatFromMatrix(m);
    if (this.forces.length) {
      let fx = 0, fy = 0, fz = 0, tx = 0, ty = 0, tz = 0;
      for (const { force: f, point: p } of this.forces) {
        fx = f32(fx + f[0]);
        fy = f32(fy + f[1]);
        fz = f32(fz + f[2]);
        if (!isZero(p) && !isZero(f)) {
          tx = f32((f[2] * p[1] - p[2] * f[1]) + tx);
          ty = f32(-(f[2] * p[0] - f[0] * p[2]) + ty);
          tz = f32((p[0] * f[1] - f[0] * p[1]) + tz);
        }
      }
      this.lastForce = [fx, fy, fz];
      const ax = f32(this.invMass * fx), ay = f32(this.invMass * fy), az = f32(this.invMass * fz);
      const dv: Vec3 = [f32(ax * m[0] + ay * m[1] + az * m[2]), f32(ay * m[4] + ax * m[3] + az * m[5]), f32(az * m[8] + ax * m[6] + ay * m[7])];
      this.forces = [];
      this.velocity = [f32(dv[0] + this.velocity[0]), f32(dv[1] + this.velocity[1]), f32(dv[2] + this.velocity[2])];
      const L = this.angularMomentum;
      this.angularMomentum = [f32(tx + L[0]), f32(ty + L[1]), f32(tz + L[2])];
    }
    const L = this.angularMomentum;
    let out = m;
    if (!isZero(L)) {
      const wl = [f32(this.invInertia[0] * L[0]), f32(this.invInertia[1] * L[1]), f32(this.invInertia[2] * L[2])];
      this.angularVelocity = [
        f32(wl[2] * m[2] + m[0] * wl[0] + wl[1] * m[1]), f32(wl[1] * m[4] + wl[2] * m[5] + m[3] * wl[0]), f32(wl[0] * m[6] + wl[2] * m[8] + m[7] * wl[1]),
      ];
      const [hx, hy, hz] = this.angularVelocity.map((c) => f32(c * 0.5));
      const l3 = f32((y + x) * (hz + hx));
      const l2 = f32(hy * (w - z));
      const l1 = f32(-hy * (z + w));
      const s1 = f32(l1 + l2 + l3);
      const s2 = f32(((x - y) * (hz - hx) + s1) * 0.5);
      const n1 = f32((s2 + -hx * (z + y)) - l1);
      const n2 = f32((s2 + (w - x) * (hz + hy)) - l2);
      const n3 = f32((s2 + (y - z) * (hz - hy)) - l3);
      x = f32(((hx * (x + w) + s2) - s1) + x);
      y = f32(n1 + y);
      z = f32(n2 + z);
      w = f32(n3 + w);
      for (let k = 0; k < 2; k++) {
        const r = f32(1 / Math.sqrt(f32(w * w + x * x + y * y + z * z)));
        x = f32(x * r);
        y = f32(y * r);
        z = f32(z * r);
        w = f32(w * r);
      }
      out = matrixFromQuat(x, y, z, w);
    }
    this.updateSpeed();
    return out;
  }

  /** FUN_004e3b00: velocity of a point r (world offset from the origin): v + w x r. */
  pointVelocity(r: readonly number[]): Vec3 {
    const w = this.angularVelocity;
    const v = this.velocity;
    return [f32((r[2] * w[1] - w[2] * r[1]) + v[0]), f32(-(r[2] * w[0] - w[2] * r[0]) + v[1]), f32((w[0] * r[1] - r[0] * w[1]) + v[2])];
  }
}

function quatFromMatrix(m: Mat3): [number, number, number, number] {
  const t = f32(m[4] + m[0] + m[8]);
  if (t > 0) {
    const r = f32(Math.sqrt(t + 1));
    const s = f32(0.5 / r);
    return [f32(-((m[5] - m[7]) * s)), f32(-((m[6] - m[2]) * s)), f32(-((m[1] - m[3]) * s)), f32(r * 0.5)];
  }
  const next = [1, 2, 0];
  let i = m[0] < m[4] ? 1 : 0;
  if (m[i * 4] < m[8]) i = 2;
  const j = next[i];
  const k = next[j];
  const r = f32(Math.sqrt(((m[i * 4] - m[j * 4]) - m[k * 4]) + 1));
  const q = [0, 0, 0, 0];
  q[i] = f32(r * 0.5);
  const s = r !== 0 ? f32(0.5 / r) : r;
  q[j] = f32((m[j * 3 + i] + m[i * 3 + j]) * s);
  q[k] = f32((m[i + k * 3] + m[i * 3 + k]) * s);
  q[3] = f32(-((m[j * 3 + k] - m[k * 3 + j]) * s));
  return [q[0], q[1], q[2], q[3]];
}

function matrixFromQuat(x: number, y: number, z: number, w: number): Mat3 {
  const xx = f32(x * x + x * x), xy = f32(y * x + y * x), xz = f32(z * x + z * x), xw = f32(x * w + x * w);
  const yy = f32(y * y + y * y), yz = f32(z * y + z * y), yw = f32(y * w + y * w);
  const zz = f32(z * z + z * z), zw = f32(w * z + w * z);
  const oneXx = f32(1 - xx);
  return [f32((1 - yy) - zz), f32(xy - zw), f32(yw + xz), f32(zw + xy), f32(oneXx - zz), f32(yz - xw), f32(xz - yw), f32(yz + xw), f32(oneXx - yy)];
}

/** FUN_004e2e40(elements, n, 0.000327, body, M, -v): flat-plate drag n (u . n) coef k |u|^2. */
export function applyDrag(body: RigidBody, elements: readonly DragElement[], m: Mat3): void {
  const nv = [-body.velocity[0], -body.velocity[1], -body.velocity[2]];
  let u: Vec3 = [f32(m[0] * nv[0] + m[3] * nv[1] + m[6] * nv[2]), f32(m[4] * nv[1] + m[1] * nv[0] + m[7] * nv[2]), f32(m[5] * nv[1] + m[2] * nv[0] + m[8] * nv[2])];
  const ln = approxLength(u);
  const q = f32(ln * ln * DRAG_K);
  if (!(q > 0)) return;
  if (!isZero(u)) {
    const k = f32(1 / Math.sqrt(f32(u[2] * u[2] + u[1] * u[1] + u[0] * u[0])));
    u = [f32(u[0] * k), f32(u[1] * k), f32(u[2] * k)];
  }
  for (const e of elements) {
    if (!(e.coef > 0)) continue;
    const n = e.normal;
    const s = f32((u[0] * n[0] + u[2] * n[2] + u[1] * n[1]) * e.coef * q);
    body.add([f32(n[0] * s), f32(n[1] * s), f32(n[2] * s)], e.point);
  }
}

// ---------------------------------------------------------------------------
// World query
// ---------------------------------------------------------------------------

/** A vertical segment hit: distance below `top` (units) and the surface normal (IGI axes, pointing up). */
export interface GroundHit { distance: number; normal: Vec3 }

/**
 * The vehicles' only world query: a vertical segment cast at (x, y) from z =
 * top down to z = bottom (FUN_004c24c0 batches, filtered to exclude the
 * vehicle itself), returning the first surface below `top`.
 */
export interface VehicleWorld {
  castDown(x: number, y: number, top: number, bottom: number): GroundHit | null;
}

/** A horizontal plane z = height (tests, synthetic scenes). */
export function flatWorld(height: number): VehicleWorld {
  return {
    castDown(_x, _y, top, bottom) {
      return bottom <= height && height <= top ? { distance: top - height, normal: [0, 0, 1] } : null;
    },
  };
}

/** No ground at all. */
export const EMPTY_WORLD: VehicleWorld = { castDown: () => null };

// ---------------------------------------------------------------------------
// Vehicle base
// ---------------------------------------------------------------------------

/** Vehicle task parameters (objects.qvm Heli / Car). */
export interface VehicleTaskParams {
  id: number;
  position: Vec3;
  /** alpha, beta, gamma radians. */
  orientation: Vec3;
  originalThrust: number;
  speed: Vec3;
  model: string;
  collision: boolean;
  forceZ: boolean;
}

/** Vehicle parameters of an objects.qvm Heli / Car task. */
export function vehicleParamsFromTask(task: IgiTask): VehicleTaskParams {
  const p = task.params;
  const v3 = (k: string): Vec3 => (Array.isArray(p[k]) ? (p[k] as QvmValue[]).slice(0, 3).map(num) as Vec3 : [0, 0, 0]);
  return {
    id: task.id, position: v3("Position"), orientation: v3("Orientation"), originalThrust: num(p["Original Thrust"] as QvmValue),
    speed: v3("Speed"), model: text(p["Model"] as QvmValue), collision: p["Collision detection"] === true, forceZ: p["Force Z"] === true,
  };
}

/** SplineObj parameters and its SplineObjWaypoint children (objects.qvm). */
export function railParamsFromTask(spline: IgiTask): RailSplineParams {
  const v3 = (t: IgiTask, k: string): Vec3 => (Array.isArray(t.params[k]) ? (t.params[k] as QvmValue[]).slice(0, 3).map(num) as Vec3 : [0, 0, 0]);
  return {
    linear: spline.params["Linear Segments"] === true,
    gamma: num(spline.params["Gamma Orientation"] as QvmValue),
    position: v3(spline, "Position"),
    autoOrient: spline.params["Automatic Orientation"] === true,
    waypoints: spline.children.filter((c) => c.type === "SplineObjWaypoint").map((w) => ({
      position: v3(w, "Position"), orientation: v3(w, "Orientation"), segmentModel: text(w.params["Segment Model"] as QvmValue),
      pieces: num(w.params["NumAreas"] as QvmValue), autoOrient: w.params["Automatic Orientation"] === true,
    })),
  };
}

/** Model data the vehicle needs: magic vertices (XTVM) and attachments (ATTA). */
export interface VehicleModelData {
  magicVertices: Vec3[];
  attachments: MefAttachment[];
}

export interface VehiclePose { position: Vec3; matrix: Mat3 }

export abstract class PhysicsVehicle {
  readonly type: PhysicsObjType;
  readonly id: number;
  readonly initPosition: Vec3;
  readonly initMatrix: Mat3;
  readonly initSpeed: Vec3;
  readonly originalThrust: number;
  readonly body = new RigidBody();
  position: Vec3;
  matrix: Mat3;
  /** +0x720 current / +0x730 target thrust. */
  thrust = 0;
  target = 0;
  /** +0x1b8 ground contacts of the last probe. */
  contacts = 0;

  constructor(task: VehicleTaskParams, type: PhysicsObjType) {
    if (task.forceZ) throw new Error("vehicles: Force Z vehicles are not modelled (no level-1 vehicle uses it)");
    this.id = task.id;
    this.type = type;
    this.initPosition = [...task.position];
    this.initMatrix = eulerF(task.orientation[0], task.orientation[1], task.orientation[2]);
    this.initSpeed = task.speed.map(f32) as Vec3;
    this.originalThrust = f32(task.originalThrust);
    this.position = [...this.initPosition];
    this.matrix = [...this.initMatrix];
  }

  pose(): VehiclePose {
    return { position: [...this.position], matrix: [...this.matrix] };
  }

  protected setupBody(): void {
    this.body.setup(this.type.mass, this.type.size);
    this.contacts = 0;
  }

  /** FUN_004f33d0: contacts, no wake flag (+0x690), no pending forces (+0x14c), slow and not turning. */
  protected atRest(): boolean {
    const w = this.body.angularVelocity;
    return this.contacts > 0 && this.body.forces.length === 0 && this.body.speed < this.type.restSpeed
      && f32(w[2] * w[2] + w[1] * w[1] + w[0] * w[0]) < this.type.restAngular;
  }

  /**
   * FUN_004f2d00 / FUN_004f2bb0: gravity -(g m) along the local image of world
   * z (row 2 of M), integrate, damp L and v; the position moves by v only when
   * the speed exceeds 40.96 units/tick.  The body-point collision passes
   * (FUN_004f25c0, FUN_004f3240) find nothing for level-1 vehicles (the car's
   * contact points are all wheels, the heli type has none).
   */
  protected integrate(linear: number, angular: number): void {
    const g = f32(-(VEHICLE_GRAVITY * this.type.mass));
    const m = this.matrix;
    this.body.add([f32(g * m[6]), f32(g * m[7]), f32(g * m[8])], [0, 0, 0]);
    this.matrix = this.body.integrate(m);
    const b = this.body;
    b.angularMomentum = b.angularMomentum.map((c) => f32(c * angular)) as Vec3;
    b.velocity = b.velocity.map((c) => f32(c * linear)) as Vec3;
    b.updateSpeed();
    if (VEHICLE_MOVE_THRESHOLD < b.speed) {
      this.position = [b.velocity[0] + this.position[0], b.velocity[1] + this.position[1], b.velocity[2] + this.position[2]];
    }
  }

  localToWorld(p: readonly number[]): Vec3 {
    const m = this.matrix;
    return [
      this.position[0] + (m[0] * p[0] + m[1] * p[1] + m[2] * p[2]),
      this.position[1] + (m[3] * p[0] + m[4] * p[1] + m[5] * p[2]),
      this.position[2] + (m[6] * p[0] + m[7] * p[1] + m[8] * p[2]),
    ];
  }

  /** AnimTask input (FUN_004eace0 message): nTick 0 resets, otherwise one physics tick. Channels are written back like the exe. */
  abstract animInput(nTick: number, channels: Float32Array, world: VehicleWorld): void;
}

// ---------------------------------------------------------------------------
// Helicopter
// ---------------------------------------------------------------------------

export interface HeliRotor { model: string; config: RotorConfig; offset: Vec3; angle: number }
export interface HeliSkid { model: string; offset: Vec3; depth: number; hard: number }

/**
 * Heli task (class 0x539e08: AnimTask input FUN_00430df0, physics
 * FUN_004310b0) with its model's attached magic objects: Rotor
 * (FUN_0042c750) and HeliWheel skids (probed by FUN_004317d0).
 */
export class HeliSim extends PhysicsVehicle {
  readonly config: VehicleBaseConfig;
  /** +0x724.. smoothed control axes, +0x734.. AnimTask channels 0..2. */
  controls: Vec3 = [0, 0, 0];
  inputs: Vec3 = [0, 0, 0];
  readonly rotors: HeliRotor[] = [];
  readonly skids: HeliSkid[] = [];

  constructor(task: VehicleTaskParams, types: readonly PhysicsObjType[], model: VehicleModelData, magic: ReadonlyMap<string, MagicObjectDef>) {
    super(task, physicsTypeForModel(types, task.model));
    this.config = this.type.config as VehicleBaseConfig;
    for (const a of model.attachments) {
      const mo = magic.get(a.name.toLowerCase());
      if (!mo) continue;
      if (mo.taskType === "TASKTYPE_ROTOR") {
        this.rotors.push({ model: a.name, config: physicsTypeForModel(types, a.name).config as RotorConfig, offset: [...a.position], angle: 0 });
      } else if (mo.taskType === "TASKTYPE_HELIWHEEL") {
        // FUN_00426440: [1] = arg0 x 4096 (stiff zone), [0] = arg1 x 4096 (ray depth)
        this.skids.push({ model: a.name, offset: a.position.map(f32) as Vec3, depth: f32(f32(mo.params[1]) * 4096), hard: f32(f32(mo.params[0]) * 4096) });
      }
    }
    this.setupBody();
  }

  /**
   * FUN_00430df0: ch3 -> thrust target (-1 keeps), ch0..2 -> control axes;
   * nTick 0 resets the pose, body, thrust = target = Original Thrust,
   * controls 0, v = M * Speed and writes ch3 = -1, ch4 = -2, ch0..2 = 0 back;
   * nTick > 0 updates the rotors, then the physics.
   */
  animInput(nTick: number, ch: Float32Array, world: VehicleWorld): void {
    if (ch[3] !== -1) this.target = f32(ch[3]);
    this.inputs = [f32(ch[0]), f32(ch[1]), f32(ch[2])];
    if (nTick === 0) {
      this.position = [...this.initPosition];
      ch[3] = -1;
      ch[4] = -2;
      ch[0] = ch[1] = ch[2] = 0;
      this.matrix = [...this.initMatrix];
      this.setupBody();
      this.thrust = this.target = this.originalThrust;
      this.controls = [0, 0, 0];
      this.inputs = [0, 0, 0];
      const s = this.initSpeed;
      const m = this.matrix;
      this.body.velocity = [f32(m[0] * s[0] + m[1] * s[1] + m[2] * s[2]), f32(m[3] * s[0] + m[4] * s[1] + m[5] * s[2]), f32(m[6] * s[0] + m[7] * s[1] + m[8] * s[2])];
      this.body.updateSpeed();
    }
    if (nTick > 0) {
      this.updateRotors();
      this.physics(world);
    }
  }

  /**
   * FUN_0042c750 per rotor with the previous tick's thrust: main rotor lift
   * F = m g thrust along local z plus cos(angle(y_h, z)) F along local y;
   * main / tail torque +-2.5 m thrust along local x at (0, 2 m, 0) (they
   * cancel exactly when both exist); spin angle += sign spin thrust.
   */
  private updateRotors(): void {
    const mass = this.type.mass;
    const m = this.matrix;
    for (const r of this.rotors) {
      const c = r.config;
      if (c.main) {
        const f = f32(mass * this.thrust * VEHICLE_GRAVITY);
        if (f !== 0) {
          let a = 0;
          if (m[1] !== 0 || m[4] !== 0) a = angleBetween([m[1], m[4], 0], [m[2], m[5], m[8]]);
          this.body.add([0, f32(Math.cos(a) * f), f], [0, 0, 0]);
        }
      }
      if (this.thrust !== 0 && (c.tail || c.main) && this.contacts === 0) {
        const k = f32(mass * this.thrust * ROTOR_TORQUE_K);
        this.body.add([c.tail ? -k : k, 0, 0], [0, ROTOR_TORQUE_ARM, 0]);
      }
      r.angle = f32(c.spinSign * c.spin * this.thrust + r.angle);
    }
  }

  /** FUN_004310b0. */
  private physics(world: VehicleWorld): void {
    const c = this.config.c;
    const mass = this.type.mass;
    const b = this.body;
    const step = HELI_FAST_THRUST <= this.thrust ? c[8] : c[9];
    let t = this.thrust;
    if (this.target <= t) {
      if (!(t <= this.target)) {
        t = f32(t - step);
        if (!(this.target <= t)) t = this.target;
      }
    } else {
      t = f32(t + step);
      if (!(t <= this.target)) t = this.target;
    }
    if (t < HELI_ZERO_THRUST && this.target === 0) t = 0;
    this.thrust = t;
    const smooth = [c[2], c[4], c[6]];
    for (let k = 0; k < 3; k++) this.controls[k] = f32(smooth[k] * this.controls[k] + (1 - smooth[k]) * this.inputs[k]);
    const [c0, c1, c2] = this.controls;
    if ((c0 !== 0 || c1 !== 0 || c2 !== 0) && (this.contacts === 0 || HELI_MOVING_SPEED < b.speed)) {
      b.add([0, f32(c0 * c[1] * mass * HELI_PITCH_K), 0], [0, 0, HELI_PITCH_ARM]);
      b.add([f32(c1 * c[3] * mass), 0, 0], [0, 0, HELI_ROLL_ARM]);
      b.add([f32(c2 * c[5] * t * mass * HELI_YAW_K), 0, 0], [0, HELI_YAW_ARM, 0]);
    }
    if (this.contacts === 0 && HELI_MOVING_SPEED < b.speed) {
      // rotate about local x by -0.7 x (lean of the up axis toward local x) x yaw gain x 2.9e-4
      const m = this.matrix;
      let a = 0;
      if (m[0] !== 0 || m[3] !== 0) {
        const k = f32(1 / Math.sqrt(f32(m[3] * m[3] + m[0] * m[0])));
        const hx = f32(m[0] * k);
        const tilt = f32(hx * m[2] + m[3] * k * m[5] + 0 * m[8]);
        a = f32(tilt * (m[8] <= 0 ? HELI_TURN_K_DOWN : HELI_TURN_K_UP));
      }
      this.matrix = matMulF(m, rotX(f32(a * c[5] * HELI_TURN_K)));
    }
    if (!this.atRest()) {
      this.skidContacts(world);
      if (this.config.drag.length) applyDrag(b, this.config.drag, this.matrix);
      this.integrate(HELI_DAMPING.linear, HELI_DAMPING.angular);
    }
  }

  /**
   * FUN_004317d0: per skid a vertical ray from 2 m above it to `depth` (0.3 m)
   * below.  A hit below `hard` (0.15 m) is a spring m g/4 (depth - (d - 2 m)) /
   * depth; above it a stiff push m g/4 (2 - d / (hard + 2 m)) that also lifts
   * the heli by the penetration when the LAST contacting skid was stiff (exe
   * quirk).  Each contact damps v by (0.95, 0.95, 0.97) and L by 0.98.
   */
  private skidContacts(world: VehicleWorld): void {
    const b = this.body;
    const mass = this.type.mass;
    this.contacts = 0;
    let deep = false;
    let lift = -Number.MAX_VALUE;
    for (const s of this.skids) {
      const p = this.localToWorld(s.offset);
      const top = p[2] + SKID_RAY_UP;
      const length = s.depth + SKID_RAY_UP;
      const hit = world.castDown(p[0], p[1], top, top - length);
      if (!hit || !(hit.distance <= length)) continue;
      const d = Math.abs(hit.distance);
      let f: number;
      if (s.hard + SKID_RAY_UP <= hit.distance) {
        deep = false;
        f = f32(((s.depth - (d - SKID_RAY_UP)) / s.depth) * mass * QUARTER_G);
      } else {
        deep = true;
        const h = f32(s.hard + f32(SKID_RAY_UP));
        f = f32(((h - f32(d)) / h + 1) * mass * QUARTER_G);
        lift = Math.max(lift, (s.hard + SKID_RAY_UP) - hit.distance);
      }
      b.add([0, 0, f], s.offset);
      this.contacts++;
      b.velocity = [f32(b.velocity[0] * f32(0.95)), f32(b.velocity[1] * f32(0.95)), f32(b.velocity[2] * f32(0.97))];
      b.angularMomentum = b.angularMomentum.map((c) => f32(c * f32(0.98))) as Vec3;
    }
    if (deep) this.position = [this.position[0], this.position[1], this.position[2] + lift];
  }

  /** Rotor spin angles (radians; axis = the rotor model's spin axis [inferred]). */
  rotorAngles(): Array<{ model: string; angle: number }> {
    return this.rotors.map((r) => ({ model: r.model, angle: r.angle }));
  }
}

// ---------------------------------------------------------------------------
// Car / truck
// ---------------------------------------------------------------------------

export interface CarContactPoint {
  /** Body-frame position (wheel points lowered by the suspension offset). */
  local: Vec3;
  gripLateral: number;
  gripRolling: number;
  side: number;
  /** +0x1f0: suspension compression (units), smoothed, drives the wheel model height. */
  compression: number;
  touching: boolean;
}

export interface CarWheelObject { model: string; index: number; offset: Vec3; radius: number; rate: number; spin: number; steer: number }

/**
 * Car task (class 0x539d58: AnimTask input FUN_0042dcb0, physics FUN_0042df40,
 * suspension FUN_0042e1a0, drive FUN_0042ff90, tyre friction FUN_0042fbe0,
 * wheel models FUN_0042f440 / FUN_0042f8c0).
 */
export class CarSim extends PhysicsVehicle {
  readonly config: CarConfig;
  /** +0x72c current / +0x73c target steering (-1..1). */
  steer = 0;
  steerTarget = 0;
  /** +0x744: AnimTask channel 3 != -1. */
  brake = false;
  readonly nDriven: number;
  readonly present: boolean[];
  readonly wheelObjects: CarWheelObject[] = [];
  readonly wheelContact: boolean[];
  readonly wheelNormal: Vec3[];
  readonly wheelPoint: Vec3[];
  points: CarContactPoint[] = [];
  private readonly vertices: Vec3[];

  constructor(task: VehicleTaskParams, types: readonly PhysicsObjType[], model: VehicleModelData, magic: ReadonlyMap<string, MagicObjectDef>) {
    super(task, physicsTypeForModel(types, task.model));
    this.config = this.type.config as CarConfig;
    this.vertices = model.magicVertices;
    const wheels = this.config.wheels;
    // FUN_0042ea60 + FUN_0042f280: model TASKTYPE_WHEEL objects claim wheels 0, 1, ... in ATTA order
    this.nDriven = wheels.filter((w) => w.driven).length;
    this.present = wheels.map(() => !this.config.wheelsFromModel);
    let k = 0;
    for (const a of model.attachments) {
      const mo = magic.get(a.name.toLowerCase());
      if (!mo || mo.taskType !== "TASKTYPE_WHEEL") continue;
      if (this.config.wheelsFromModel && k < wheels.length) this.present[k] = true;
      const wt = physicsTypeForModel(types, a.name).config as WheelModelConfig;
      this.wheelObjects.push({ model: a.name, index: k, offset: [...a.position], radius: wt.radius, rate: 0, spin: 0, steer: 0 });
      k++;
    }
    this.wheelContact = wheels.map(() => false);
    this.wheelNormal = wheels.map(() => [0, 0, 0] as Vec3);
    this.wheelPoint = wheels.map(() => [0, 0, 0] as Vec3);
    this.setupBody();
    this.initPoints();
  }

  /** FUN_004f2320 contact points (magic vertices) then FUN_0042ded0 (wheel points lowered by the suspension offset). */
  private initPoints(): void {
    this.points = this.type.points.map((pt) => {
      const v = this.vertices[pt.vertex];
      return { local: [f32(v[0]), f32(v[1]), f32(v[2])] as Vec3, gripLateral: pt.gripLateral, gripRolling: pt.gripRolling, side: pt.a, compression: 0, touching: false };
    });
    for (const w of this.config.wheels) {
      if (w.contact >= 0) {
        const q = this.points[w.contact].local;
        q[2] = f32(q[2] - this.config.suspensionOffset);
      }
    }
  }

  /**
   * FUN_0042dcb0: ch1 -> thrust target (-1 keeps), ch0 -> steering target,
   * ch3 != -1 -> brake; nTick 0 resets (writes ch1 = -1, ch2 = -2), otherwise
   * FUN_0042df40 steps the car.
   */
  animInput(nTick: number, ch: Float32Array, world: VehicleWorld): void {
    if (ch[1] !== -1) this.target = f32(ch[1]);
    this.steerTarget = f32(ch[0]);
    this.brake = ch[3] !== -1;
    if (nTick === 0) {
      this.position = [...this.initPosition];
      this.matrix = [...this.initMatrix];
      ch[1] = -1;
      ch[2] = -2;
      this.setupBody();
      this.initPoints();
      this.thrust = this.steer = this.steerTarget = 0;
      this.brake = false;
      this.thrust = this.target = this.originalThrust;
      return;
    }
    this.physics(world);
    this.updateWheelObjects();
  }

  /** FUN_0042df40. */
  private physics(world: VehicleWorld): void {
    const c = this.config.c;
    this.thrust = f32(c[8] * this.thrust + (1 - c[8]) * this.target);
    this.steer = f32(this.steer * c[6] + (1 - c[6]) * this.steerTarget);
    if (this.target === 0 && Math.abs(this.thrust) < CAR_ZERO_THRUST) this.thrust = 0;
    this.suspension(world);
    if (!this.atRest()) {
      if (this.config.drag.length) applyDrag(this.body, this.config.drag, this.matrix);
      this.integrate(CAR_DAMPING.linear, CAR_DAMPING.angular);
    }
  }

  /**
   * FUN_0042e1a0: per present wheel with a contact point, a vertical ray from
   * travel + 1 m above the (lowered) contact point to 0.5 m below it;
   * compression = travel + 1 m - d (full travel and a stiffer push when the hit
   * is in the top metre, plus a lift by the penetration); spring force
   * (compression / travel) spring m g along local z at the contact point; then
   * drive and tyre friction for touching wheels.
   */
  private suspension(world: VehicleWorld): void {
    const wheels = this.config.wheels;
    const mass = this.type.mass;
    let deepAny = false;
    let lift = -Number.MAX_VALUE;
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      const ci = w.contact;
      if (ci < 0 || !this.present[i]) continue;
      const pt = this.points[ci];
      const p = this.localToWorld(pt.local);
      const top = (w.travel + p[2]) + CAR_RAY_UP;
      const bottom = (top - (w.travel + CAR_RAY_DOWN)) - CAR_RAY_UP;
      const hit = world.castDown(p[0], p[1], top, bottom);
      let comp = 0;
      let touched = false;
      if (hit) {
        const dist = hit.distance;
        let deep = false;
        let skip = false;
        if (CAR_RAY_UP <= dist) {
          if (dist <= CAR_RAY_UP || f32(w.travel + f32(4096)) <= f32(dist)) skip = true;
          else comp = f32((w.travel + f32(4096)) - f32(dist));
        } else {
          deep = deepAny = true;
          comp = w.travel;
          lift = Math.max(lift, CAR_RAY_UP - dist);
        }
        if (!skip) {
          let f = f32((comp / w.travel) * w.spring * mass * VEHICLE_GRAVITY);
          if (deep) f = f32((2 - dist * (1 / 4096)) * f);
          this.body.add([0, 0, f], pt.local);
          touched = true;
        }
      }
      const diff = Math.abs(f32(pt.compression - comp));
      if (f32(0.001) < diff) {
        if (comp <= pt.compression) comp = f32(comp * f32(0.95) + pt.compression * f32(0.05));
        pt.compression = comp;
      }
      this.wheelContact[i] = touched;
      pt.touching = touched;
      if (touched && hit) {
        let n: Vec3 = hit.normal.map(f32) as Vec3;
        if (!isZero(n)) {
          const k = f32(1 / Math.sqrt(f32(n[2] * n[2] + n[1] * n[1] + n[0] * n[0])));
          n = [f32(n[0] * k), f32(n[1] * k), f32(n[2] * k)];
        }
        this.wheelNormal[i] = n;
        this.wheelPoint[i] = [pt.local[0], pt.local[1], f32(pt.local[2] + CAR_WHEEL_POINT_LIFT)];
        this.contacts = 1;
        this.drive(i, ci);
      }
    }
    if (deepAny) this.position = [this.position[0], this.position[1], this.position[2] + lift];
  }

  /**
   * FUN_0042ff90: driven wheel force (cfg[7] thrust g / nDriven - speed) along
   * the forward axis projected on the ground, turned by -steer in the body
   * frame; then tyre friction (FUN_0042fbe0) with the wheel's grips (rolling =
   * lateral when braking, and the thrust decays by 0.95).
   */
  private drive(i: number, ci: number): void {
    const w = this.config.wheels[i];
    const b = this.body;
    const m = this.matrix;
    let steer = f32(f32(w.maxSteerDeg * DEG) * this.steer);
    if (w.driven && this.wheelContact[i] && this.thrust !== 0) {
      const n = this.wheelNormal[i];
      const y = [m[1], m[4], m[7]];
      let dir: Vec3 = [0, 0, 0];
      if (n[0] !== y[0] || n[1] !== y[1] || n[2] !== y[2]) {
        const a0 = f32(y[2] * n[1] - y[1] * n[2]);
        const a1 = f32(-(y[2] * n[0] - y[0] * n[2]));
        const a2 = f32(y[1] * n[0] - y[0] * n[1]);
        dir = [f32(a1 * n[2] - a2 * n[1]), f32(-(a0 * n[2] - a2 * n[0])), f32(a0 * n[1] - a1 * n[0])];
      }
      let power = (this.config.c[7] * this.thrust * VEHICLE_GRAVITY) / this.nDriven;
      if (this.config.differential) power *= this.differential(ci);
      power -= b.speed;
      const fw = [f32(power * dir[0]), f32(power * dir[1]), power * dir[2]];
      const fl = [f32(fw[1] * m[3] + fw[2] * m[6] + fw[0] * m[0]), f32(fw[2] * m[7] + fw[0] * m[1] + fw[1] * m[4]), f32(fw[1] * m[5] + fw[2] * m[8] + fw[0] * m[2])];
      const r = rotZ(-steer);
      b.add([f32(r[1] * fl[1] + r[2] * fl[2] + r[0] * fl[0]), f32(r[4] * fl[1] + r[5] * fl[2] + r[3] * fl[0]), f32(r[7] * fl[1] + r[8] * fl[2] + r[6] * fl[0])], this.wheelPoint[i]);
    }
    if (this.wheelContact[i] && ci >= 0) {
      if (!w.steerable) steer = 0;
      const pt = this.points[ci];
      const kLat = pt.gripLateral;
      let kRoll = pt.gripRolling;
      if (this.brake) {
        this.thrust = f32(this.thrust * f32(0.95));
        kRoll = kLat;
      }
      tyreFriction(b, m, this.wheelPoint[i], this.wheelNormal[i], steer, kLat, kRoll);
    }
  }

  /** FUN_0042f730 (config +0x261). */
  private differential(ci: number): number {
    const s = this.steer;
    const side = this.points[ci].side;
    if (s <= CAR_ZERO_THRUST) {
      if (s < -CAR_ZERO_THRUST && side === 0) return s + 0.5 + s + 0.5;
    } else if (side === 1) {
      return (0.5 - s) + (0.5 - s);
    }
    return 1;
  }

  /** FUN_0042f440: visual wheel spin rate / angle and steering (no physics). */
  private updateWheelObjects(): void {
    const cfg = this.config;
    for (const wo of this.wheelObjects) {
      const w = cfg.wheels[wo.index];
      if (!w) continue;
      const ci = w.contact >= 0 ? w.contact : -10 - w.contact;
      const pt = this.points[ci];
      let rate = 0;
      if (!pt.touching) {
        if (w.driven) rate = ((this.thrust * VEHICLE_GRAVITY * cfg.c[7]) / this.nDriven) * WHEEL_SPIN_K;
      } else {
        const v = this.body.pointVelocity(pt.local);
        rate = f32(Math.sqrt(f32(v[2] * v[2] + v[1] * v[1] + v[0] * v[0])));
        if (rate < VEHICLE_MOVE_THRESHOLD) rate = 0;
      }
      wo.rate = f32(wo.rate * WHEEL_SPIN_SMOOTH + (rate / f32(wo.radius * f32(TWO_PI_D))) * f32(TWO_PI_D) * WHEEL_SPIN_GAIN);
      if (w.steerable) wo.steer = f32(-(w.maxSteerDeg * this.steer * DEG));
      if (this.brake) wo.rate = 0;
      wo.spin = f32(wo.spin - wo.rate);
    }
  }

  /**
   * Wheel model poses relative to the car (FUN_0042f8c0): ATTA offset with z +=
   * compression - suspension offset; spin about the wheel's x axis and steer
   * about z [axes inferred from FUN_004a9680's argument order].
   */
  wheelPoses(): Array<{ model: string; offset: Vec3; spin: number; steer: number }> {
    return this.wheelObjects.map((wo) => {
      const w = this.config.wheels[wo.index];
      const ci = w ? (w.contact >= 0 ? w.contact : -10 - w.contact) : -1;
      const comp = ci >= 0 && ci < this.points.length ? this.points[ci].compression : 0;
      return { model: wo.model, offset: [wo.offset[0], wo.offset[1], (comp + wo.offset[2]) - this.config.suspensionOffset], spin: wo.spin, steer: wo.steer };
    });
  }
}

/**
 * FUN_0042fbe0: friction against the contact point's tangential velocity,
 * scaled per wheel axis (wheel frame = Rz(steer) of the body frame: x lateral
 * by kLat, y rolling by kRoll); static |v_t| m 0.1 while |v_t| <= 4 g n_z,
 * else kinetic 0.24 m g n_z.
 */
function tyreFriction(b: RigidBody, m: Mat3, p: Vec3, n: Vec3, steer: number, kLat: number, kRoll: number): void {
  const load = f32(b.mass * VEHICLE_GRAVITY * n[2]);
  const r = [f32(p[2] * m[2] + p[1] * m[1] + m[0] * p[0]), f32(m[4] * p[1] + m[3] * p[0] + m[5] * p[2]), f32(p[0] * m[6] + p[1] * m[7] + p[2] * m[8])];
  const vp = b.pointVelocity(r);
  const vn = f32(vp[0] * n[0] + vp[1] * n[1] + vp[2] * n[2]);
  let u: Vec3 = [f32(n[0] * vn - vp[0]), f32(n[1] * vn - vp[1]), f32(n[2] * vn - vp[2])];
  const mag = f32(Math.sqrt(f32(u[2] * u[2] + u[1] * u[1] + u[0] * u[0])));
  if (!isZero(u)) {
    const k = f32(1 / mag);
    u = [f32(u[0] * k), f32(u[1] * k), f32(u[2] * k)];
  }
  const ul = [f32(u[2] * m[6] + u[0] * m[0] + u[1] * m[3]), f32(u[0] * m[1] + u[2] * m[7] + u[1] * m[4]), f32(u[2] * m[8] + u[0] * m[2] + u[1] * m[5])];
  const rr = rotZ(steer);
  const wz = f32(rr[6] * ul[0] + rr[7] * ul[1] + rr[8] * ul[2]);
  const wx = f32((rr[0] * ul[0] + rr[1] * ul[1] + rr[2] * ul[2]) * kLat);
  const wy = f32((rr[3] * ul[0] + rr[4] * ul[1] + rr[5] * ul[2]) * kRoll);
  const bx = f32(rr[0] * wx + rr[3] * wy + rr[6] * wz);
  const by = f32(rr[1] * wx + rr[4] * wy + rr[7] * wz);
  const bz = f32(rr[2] * wx + rr[5] * wy + rr[8] * wz);
  const s = mag <= f32(load * FRICTION_LIMIT) / b.mass ? mag * b.mass * FRICTION_STATIC : load * FRICTION_KINETIC;
  b.add([f32(bx * s), f32(by * s), f32(bz * s)], p);
}

// ---------------------------------------------------------------------------
// Rail spline (SplineObj / SplineObjWaypoint) and train placement
// ---------------------------------------------------------------------------

export interface RailWaypoint {
  position: Vec3;
  /** alpha, beta, gamma radians. */
  orientation: Vec3;
  /** "Segment Model": the segment ENDING at this waypoint uses it. */
  segmentModel: string;
  /** "NumAreas": piece count of that segment [inferred field]. */
  pieces: number;
  /** "Automatic Orientation" (+0x1a5) of the waypoint. */
  autoOrient?: boolean;
}

/** SplineObj parameters the rail needs (objects.qvm SplineObj and its SplineObjWaypoint children). */
export interface RailSplineParams {
  linear: boolean;
  gamma: number;
  waypoints: RailWaypoint[];
  /** SplineObj "Position" (+0x2c, float): every waypoint moves by Rz(gamma) Position (FUN_00502740). */
  position?: Vec3;
  /** SplineObj "Automatic Orientation" (+0x4f). */
  autoOrient?: boolean;
}

/**
 * The waypoint matrix "Automatic Orientation" builds (waypoint compile
 * FUN_00500ef0 at 0x500f28..0x501452, full exe) [recovered]: t = (P -
 * P_prev) + (P_next - P) (float; a missing neighbour's term is left out;
 * t = 0 -> (1, 0, 0)); h = unit(t.y, -t.x, 0) ((0, 1, 0) when t.x = t.y =
 * 0); c = h x t; b = c x t; e = unit(t) x b; the matrix has the columns
 * unit(t), unit(b), unit(e): local x along the tangent, y horizontal, z up.
 */
export function autoOrientMatrix(p: readonly number[], prev: readonly number[] | null, next: readonly number[] | null): Mat3 {
  let t: Vec3 = [0, 0, 0];
  if (prev) t = [f32(p[0] - prev[0]), f32(p[1] - prev[1]), f32(p[2] - prev[2])];
  if (next) t = [f32((next[0] - p[0]) + t[0]), f32(f32(next[1] - p[1]) + t[1]), f32(f32(next[2] - p[2]) + t[2])];
  const m0: Vec3 = t[0] === 0 && t[1] === 0 && t[2] === 0 ? [1, 0, 0] : t;
  let h: Vec3;
  if (m0[0] === 0 && m0[1] === 0) h = [0, 1, 0];
  else {
    const k = 1 / Math.sqrt(m0[1] * m0[1] + m0[0] * m0[0]);
    h = [f32(m0[1] * k), f32(-m0[0] * k), 0];
  }
  const c: Vec3 = [f32(h[1] * m0[2] - h[2] * m0[1]), f32(-(h[0] * m0[2] - h[2] * m0[0])), f32(h[0] * m0[1] - h[1] * m0[0])];
  const unit = (v: Vec3): Vec3 => {
    if (isZero(v)) return v;
    const k = 1 / Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return [f32(v[0] * k), f32(v[1] * k), f32(v[2] * k)];
  };
  const tu = unit(m0);
  const b: Vec3 = [f32(m0[2] * c[1] - c[2] * m0[1]), f32(-(m0[2] * c[0] - c[2] * m0[0])), f32(m0[1] * c[0] - m0[0] * c[1])];
  const e: Vec3 = [f32(b[2] * tu[1] - b[1] * tu[2]), f32(-(b[2] * tu[0] - b[0] * tu[2])), f32(b[1] * tu[0] - b[0] * tu[1])];
  const bu = unit(b);
  const eu = unit(e);
  return [tu[0], bu[0], eu[0], tu[1], bu[1], eu[1], tu[2], bu[2], eu[2]];
}

export interface RailSegment {
  /** Segment origin: midpoint of its two waypoints (doubles). */
  mid: Vec3;
  /** Float points relative to `mid`, pieces + 1 of them. */
  points: Vec3[];
  /** Float chord lengths of the pieces (+0x548), then a trailing 0. */
  lengths: number[];
  pieces: number;
  /** Float sum of the piece lengths (+0xf8). */
  length: number;
  model: string;
}

/**
 * SplineObj with its waypoints [recovered FUN_004db070 / FUN_004db1d0 called
 * from the waypoint compile 0x4f7b10, FUN_004f9360 (SplineObj compile)].
 * Segment k >= 1 spans waypoints k-1 -> k: a cubic Hermite per axis
 * (FUN_00511e70 / FUN_00511ed0) with tangents = column 0 (local x) of each
 * waypoint matrix x the 3D chord, sampled at s = i / n into float points
 * relative to the midpoint; trains run on that polyline.  Linear splines use
 * one straight piece.  Total length = float sum of the segment lengths.
 */
export class RailSpline {
  readonly linear: boolean;
  readonly waypoints: Array<{ position: Vec3; matrix: Mat3; segmentModel: string; pieces: number }>;
  readonly segments: Array<RailSegment | null>;
  readonly total: number;

  /**
   * `gammaQuirk`: FUN_004f9360 rotates every waypoint about the first by
   * Rz(gamma - pi) when the SplineObj's "Gamma Orientation" differs from the
   * pi it was created with (0x4f9300) [recovered path; that the loaded value
   * triggers it is inferred — level 1's 3.1415929 is one float ulp above pi,
   * a sub-millimetre effect].
   */
  constructor(params: RailSplineParams, gammaQuirk = true) {
    this.linear = params.linear;
    const wps = params.waypoints.map((w) => ({
      position: [...w.position] as Vec3, matrix: eulerF(w.orientation[0], w.orientation[1], w.orientation[2]), segmentModel: w.segmentModel, pieces: w.pieces,
    }));
    const gamma = f32(params.gamma);
    // FUN_00502740 (SplineObj compile, full exe) [recovered]: the create (0x5026e0) stores
    // gamma0 = pi (float 0x40490fdb) and a zero "previous position"; a loaded "Gamma Orientation"
    // different from gamma0 rotates every waypoint about the first by Rz(gamma - gamma0).
    if (gammaQuirk && wps.length && gamma !== PI_F) {
      const r = rotZ(f32(gamma - PI_F));
      const first = [...wps[0].position];
      for (const w of wps) {
        const d = [w.position[0] - first[0], w.position[1] - first[1], w.position[2] - first[2]];
        w.position = [
          f32(r[0] * d[0] + r[1] * d[1] + r[2] * d[2]) + first[0],
          f32(r[3] * d[0] + r[4] * d[1] + r[5] * d[2]) + first[1],
          (r[6] * d[0] + r[7] * d[1] + r[8] * d[2]) + first[2],
        ];
        w.matrix = matMulF(w.matrix, r);
      }
    }
    // FUN_00502740, then: a "Position" different from the stored zero moves every waypoint by
    // Rz(gamma) Position (float vector added to the double positions, 0x502d8a).
    const shift = (params.position ?? [0, 0, 0]).map(f32);
    if (shift[0] !== 0 || shift[1] !== 0 || shift[2] !== 0) {
      const r = rotZ(gamma);
      const t = [f32(r[0] * shift[0] + r[1] * shift[1] + r[2] * shift[2]), f32(r[3] * shift[0] + r[4] * shift[1] + r[5] * shift[2]), f32(r[6] * shift[0] + r[7] * shift[1] + r[8] * shift[2])];
      for (const w of wps) w.position = [t[0] + w.position[0], t[1] + w.position[1], t[2] + w.position[2]];
    }
    // Waypoint compile FUN_00500ef0 (0x500f28): "Automatic Orientation" of the SplineObj or the
    // waypoint, a curved spline and a neighbour -> the waypoint matrix follows the tangent.
    if (!params.linear) {
      for (let k = 0; k < wps.length; k++) {
        if (!(params.autoOrient || params.waypoints[k].autoOrient) || wps.length < 2) continue;
        wps[k].matrix = autoOrientMatrix(wps[k].position, k > 0 ? wps[k - 1].position : null, k + 1 < wps.length ? wps[k + 1].position : null);
      }
    }
    this.waypoints = wps;
    this.segments = [null];
    for (let k = 1; k < wps.length; k++) this.segments.push(this.buildSegment(wps[k - 1], wps[k]));
    let total = 0;
    for (const s of this.segments) if (s) total = f32(s.length + total);
    this.total = total;
  }

  private buildSegment(a: RailSpline["waypoints"][number], b: RailSpline["waypoints"][number]): RailSegment {
    const p0 = a.position;
    const p1 = b.position;
    const chord = Math.sqrt(d2(p0, p1));
    const mid: Vec3 = [(p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5, (p0[2] + p1[2]) * 0.5];
    const n = this.linear ? 1 : b.pieces;
    const inv = f32(1 / f32(n));
    const points: Vec3[] = [];
    const lengths: number[] = [];
    let total = 0;
    if (this.linear) {
      for (let i = 0; i < 2; i++) {
        const s = i * inv;
        points.push([0, 1, 2].map((k) => f32((s * (p1[k] - p0[k]) + p0[k]) - mid[k])) as Vec3);
      }
      const d = [0, 1, 2].map((k) => f32(p1[k] - p0[k]));
      const ln = f32(f32(Math.sqrt(f32(d[2] * d[2] + d[1] * d[1] + d[0] * d[0]))) * inv);
      lengths.push(ln, 0);
      total = f32(ln + total);
    } else {
      const coeffs = [0, 1, 2].map((k) => {
        // FUN_004db1d0 passes the tangents to FUN_00511e70 as doubles (matrix column x float chord, unrounded).
        const m0 = a.matrix[k * 3] * f32(chord);
        const m1 = b.matrix[k * 3] * f32(chord);
        return [p0[k], m0, ((p0[k] + p0[k]) - (p1[k] + p1[k])) + m0 + m1, ((p1[k] * 3 - p0[k] * 3) - (m0 + m0)) - m1];
      });
      for (let i = 0; i <= n; i++) {
        const s = i * inv;
        points.push(coeffs.map(([c0, c1, c2, c3], k) => f32((s * c1 + s * s * c3 + s * s * s * c2 + c0) - mid[k])) as Vec3);
        if (i > 0) {
          const d = [0, 1, 2].map((k) => f32(points[i][k] - points[i - 1][k]));
          const ln = f32(Math.sqrt(f32(d[2] * d[2] + d[1] * d[1] + d[0] * d[0])));
          lengths.push(ln);
          total = f32(ln + total);
        }
      }
      lengths.push(0);
    }
    return { mid, points, lengths, pieces: n, length: total, model: b.segmentModel };
  }

  /** World position of point i of segment `seg` (float + double, as the exe adds them). */
  worldPoint(seg: number, i: number): Vec3 {
    const s = this.segments[seg]!;
    const p = s.points[i];
    return [p[0] + s.mid[0], p[1] + s.mid[1], p[2] + s.mid[2]];
  }

  /**
   * FUN_004f5830(spline, 0, out, &ok, distance, n, offsets, 0): point 0 at arc
   * `distance` (float, wrapped into [0, total)) on the polyline; point j+1 at
   * Euclidean distance |offsets[j]| from point j, searched forward (offset >
   * 0) or backward along the pieces (sphere / piece intersection by the laws
   * of cosines and sines).  While the current piece end is still farther than
   * the offset, the arc estimate distance + sum(offsets) is used instead (exe
   * quirk).  Off the end, points clamp to the last (first) point.
   */
  /**
   * Where FUN_004f5830 puts arc length `distance` (wrapped): segment, piece
   * and the float fraction within the piece, with the exe's float32
   * accumulation (add, then subtract back the overshooting length).
   */
  locate(distance: number): { seg: number; piece: number; fraction: number } | null {
    let d = f32(distance);
    const total = this.total;
    const nseg = this.segments.length;
    if (total === 0 || nseg < 2) return null;
    while (d < 0) d = f32(d + total);
    while (total <= d) d = f32(d - total);
    if (d === 0) return { seg: 1, piece: 0, fraction: 0 };
    let seg = 0;
    let acc = 0;
    for (;;) {
      seg++;
      if (seg >= nseg) return null;
      acc = f32(acc + this.segments[seg]!.length);
      if (!(acc < d)) break;
    }
    acc = f32(acc - this.segments[seg]!.length);
    const S = this.segments[seg]!;
    if (acc === d) return { seg, piece: 0, fraction: 0 };
    let k = 0;
    for (;;) {
      if (S.pieces <= k) return { seg, piece: S.pieces, fraction: 0 };
      acc = f32(acc + S.lengths[k]);
      k++;
      if (!(acc < d)) break;
    }
    k--;
    acc = f32(acc - S.lengths[k]);
    return { seg, piece: k, fraction: f32((d - acc) / S.lengths[k]) };
  }

  evaluate(distance: number, offsets: readonly number[]): Vec3[] | null {
    let d = f32(distance);
    const total = this.total;
    const nseg = this.segments.length;
    if (total === 0 || nseg < 2) return null;
    while (d < 0) d = f32(d + total);
    while (total <= d) d = f32(d - total);
    const repeat = (p: Vec3) => Array.from({ length: offsets.length + 1 }, () => [...p] as Vec3);
    if (d === 0) return repeat(this.waypoints[0].position);
    let seg = 0;
    let acc = 0;
    for (;;) {
      seg++;
      if (seg >= nseg) return null;
      acc = f32(acc + this.segments[seg]!.length);
      if (!(acc < d)) break;
    }
    acc = f32(acc - this.segments[seg]!.length);
    const S = this.segments[seg]!;
    if (acc === d) return repeat(this.worldPoint(seg, 0));
    let k = 0;
    for (;;) {
      if (S.pieces <= k) return repeat(this.worldPoint(seg, S.pieces));
      acc = f32(acc + S.lengths[k]);
      k++;
      if (!(acc < d)) break;
    }
    k--;
    acc = f32(acc - S.lengths[k]);
    const f = f32((d - acc) / S.lengths[k]);
    const a = S.points[k];
    const b = S.points[k + 1];
    const out: Vec3[] = [[f32((b[0] - a[0]) * f + a[0]) + S.mid[0], f32((b[1] - a[1]) * f + a[1]) + S.mid[1], f32((b[2] - a[2]) * f + a[2]) + S.mid[2]]];
    let arc = d;
    let state = { seg, k, acc };
    for (const off of offsets) {
      const L = f32(off);
      arc = f32(L + arc);
      const res = this.nextPoint(state, arc, out[out.length - 1], L, f32(L * L));
      state = res.state;
      out.push(res.point);
    }
    return out;
  }

  private nextPoint(st: { seg: number; k: number; acc: number }, arc: number, prev: Vec3, L: number, L2: number): { point: Vec3; state: { seg: number; k: number; acc: number } } {
    let { seg, k, acc } = st;
    let s0: Vec3;
    let s1: Vec3;
    let f: number;
    if (0 <= L) {
      if (d2(prev, this.worldPoint(seg, k + 1)) <= L2) {
        let a2: number, b2: number;
        for (;;) {
          let step: number;
          if (k < this.segments[seg]!.pieces - 1) {
            step = this.segments[seg]!.lengths[k];
            k++;
          } else {
            if (seg + 1 >= this.segments.length) return { point: this.worldPoint(seg, this.segments[seg]!.pieces), state: { seg, k, acc } };
            step = this.segments[seg]!.lengths[k];
            seg++;
            k = 0;
          }
          acc = f32(acc + step);
          s0 = this.worldPoint(seg, k);
          s1 = this.worldPoint(seg, k + 1);
          a2 = f32(d2(prev, s0));
          b2 = f32(d2(prev, s1));
          if ((L2 < a2) !== (L2 < b2)) break;
        }
        const ln = this.segments[seg]!.lengths[k];
        const a = f32(Math.sqrt(a2));
        const g = Math.acos(clamp1(f32(((b2 - a2) - ln * ln) / (a * ln * -2))));
        const sg = Math.sin(g);
        const rest = f32(PI_F - g);
        const dl = Math.asin(clamp1(f32((f32(sg) / L) * a)));
        f = f32(rest - dl <= SPLINE_DEGENERATE ? (L - a) / (Math.sqrt(b2) - a) : ((Math.sin(rest - dl) * L) / f32(sg)) / ln);
      } else {
        f = f32((arc - acc) / this.segments[seg]!.lengths[k]);
        s0 = this.worldPoint(seg, k);
        s1 = this.worldPoint(seg, k + 1);
      }
    } else if (d2(prev, this.worldPoint(seg, k)) <= L2) {
      let a2: number, b2: number;
      for (;;) {
        let step: number;
        if (k === 0) {
          if (seg - 1 < 1) return { point: this.worldPoint(seg, 0), state: { seg, k, acc } };
          seg--;
          k = this.segments[seg]!.pieces;
          step = this.segments[seg]!.lengths[k - 1];
        } else {
          step = this.segments[seg]!.lengths[k - 1];
        }
        k--;
        acc = f32(acc - step);
        s0 = this.worldPoint(seg, k);
        s1 = this.worldPoint(seg, k + 1);
        a2 = f32(d2(prev, s0));
        b2 = f32(d2(prev, s1));
        if ((L2 < a2) !== (L2 < b2)) break;
      }
      const ln = this.segments[seg]!.lengths[k];
      const bl = f32(Math.sqrt(b2));
      const g = Math.acos(clamp1(f32(((a2 - b2) - ln * ln) / (bl * ln * -2))));
      const Lp = -L;
      const sg = Math.sin(g);
      const rest = f32(PI_F - g);
      const dl = Math.asin(clamp1(f32((f32(sg) / Lp) * bl)));
      f = f32(rest - dl <= SPLINE_DEGENERATE ? (Lp - Math.sqrt(a2)) / (bl - Math.sqrt(a2)) : 1 - ((Math.sin(rest - dl) * Lp) / f32(sg)) / ln);
    } else {
      f = f32((arc - acc) / this.segments[seg]!.lengths[k]);
      s0 = this.worldPoint(seg, k);
      s1 = this.worldPoint(seg, k + 1);
    }
    const point: Vec3 = [(s1![0] - s0![0]) * f + s0![0], (s1![1] - s0![1]) * f + s0![1], (s1![2] - s0![2]) * f + s0![2]];
    return { point, state: { seg, k, acc } };
  }
}

function clamp1(x: number): number {
  return Math.max(-1, Math.min(1, x));
}

/** One train car (locomotive or wagon) for placement. */
export interface TrainCar {
  id: number;
  model: string;
  /** |x0 - x1| of model magic vertices 0 and 1 (FUN_00429560 -> +0x74c). */
  length: number;
  /** |x0| / length (+0x748): where the origin sits between the couplings. */
  frac: number;
  /** Displacement X / Y x 4096 (+0x770 / +0x774): offset along local y / z. */
  displacement: [number, number];
}

/** Build a car from its task "Model" magic vertices and displacement parameters. */
export function trainCar(id: number, model: string, magicVertices: readonly Vec3[], displacement: [number, number] = [0, 0]): TrainCar {
  const x0 = f32(magicVertices[0][0]);
  const x1 = f32(magicVertices[1][0]);
  const length = Math.abs(f32(x0 - x1));
  return { id, model, length, frac: f32(Math.abs(x0) / length), displacement: [f32(f32(displacement[0]) * 4096), f32(f32(displacement[1]) * 4096)] };
}

export interface TrainCarPose extends VehiclePose {
  id: number;
  model: string;
  /** Coupling points (front at the train's distance side, back). */
  front: Vec3;
  back: Vec3;
}

/**
 * FUN_004296d0 (locomotive) + FUN_00429bd0 (wagons, the child Train tasks in
 * file order): coupling points from the spline (offsets +length when Flip
 * Direction, -length otherwise), then each car between points j and j+1:
 * columns (-C, B, A) of FUN_004aa2f0's frame of d = back - front (local x =
 * -unit(d), the direction of travel of a flipped train; z up), origin = front +
 * frac (back - front) + M (0, dispX, dispY).
 */
export function placeTrain(spline: RailSpline, cars: readonly TrainCar[], distance: number, flip: boolean): TrainCarPose[] | null {
  const pts = spline.evaluate(distance, cars.map((c) => (flip ? c.length : -c.length)));
  if (!pts) return null;
  return cars.map((c, j) => {
    const p0 = pts[j];
    const p1 = pts[j + 1];
    let m: Mat3;
    let pos: Vec3;
    if (p0[0] === p1[0] && p0[1] === p1[1] && p0[2] === p1[2]) {
      m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      pos = [...p0];
    } else {
      m = trainFrame([f32(p1[0] - p0[0]), f32(p1[1] - p0[1]), f32(p1[2] - p0[2])]);
      pos = [(p1[0] - p0[0]) * c.frac + p0[0], (p1[1] - p0[1]) * c.frac + p0[1], (p1[2] - p0[2]) * c.frac + p0[2]];
    }
    const [dx, dy] = c.displacement;
    pos = [(dy * m[2] + dx * m[1]) + pos[0], (dx * m[4] + dy * m[5]) + pos[1], (dy * m[8] + dx * m[7]) + pos[2]];
    return { id: c.id, model: c.model, position: pos, matrix: m, front: p0, back: p1 };
  });
}

/** FUN_004aa2f0(d) then FUN_004296d0's row shuffle and transpose: columns (-C, B, A). */
function trainFrame(d: Vec3): Mat3 {
  const [dx, dy, dz] = d;
  let r: Vec3;
  if (dx === 0 && dy === 0) r = [0, 1, 0];
  else {
    const k = f32(1 / Math.sqrt(f32(-dx * -dx + dy * dy)));
    r = [f32(dy * k), f32(-dx * k), 0];
  }
  const a1 = f32(dz * r[1] - dy * 0), a2 = f32(-(dz * r[0] - dx * 0)), a3 = f32(r[0] * dy - r[1] * dx);
  let A: Vec3 = [a1, a2, a3];
  if (!isZero(A)) {
    const k = f32(1 / Math.sqrt(f32(a3 * a3 + a2 * a2 + a1 * a1)));
    A = [f32(a1 * k), f32(a2 * k), f32(a3 * k)];
  }
  let B: Vec3 = [f32(a3 * dy - a2 * dz), f32(-(a3 * dx - a1 * dz)), f32(a2 * dx - a1 * dy)];
  let C: Vec3 = [f32(B[2] * A[1] - B[1] * A[2]), f32(-(B[2] * A[0] - B[0] * A[2])), f32(B[1] * A[0] - B[0] * A[1])];
  if (!isZero(B)) {
    const k = f32(1 / Math.sqrt(f32(B[0] * B[0] + B[1] * B[1] + B[2] * B[2])));
    B = [f32(B[0] * k), f32(B[1] * k), f32(B[2] * k)];
  }
  if (!isZero(C)) {
    const k = f32(1 / Math.sqrt(f32(C[2] * C[2] + C[1] * C[1] + C[0] * C[0])));
    C = [f32(C[0] * k), f32(C[1] * k), f32(C[2] * k)];
  }
  return [-C[0], B[0], A[0], -C[1], B[1], A[1], -C[2], B[2], A[2]];
}

/** Train poses for the mission runtime's train state (MissionRuntime.trainStateAt). */
export function placeTrainTask(spline: RailSpline, train: TrainTask, state: TrainState, cars: readonly TrainCar[]): TrainCarPose[] | null {
  return placeTrain(spline, cars, state.distance, train.flipDirection);
}

// ---------------------------------------------------------------------------
// Standalone AnimTask driving (tests, previews)
// ---------------------------------------------------------------------------

/**
 * Drive a vehicle from its AnimTask records outside the mission runtime:
 * compile seek(0), then `updates` updates of seek(nTick + 1) (FUN_004eab70 /
 * FUN_004eabe0, as mission.ts seekAnimPlayback; the first update re-sends
 * nTick 0).  Returns the pose after every update.
 */
export function driveFromAnimTask(vehicle: HeliSim | CarSim, records: readonly AnimRecord[], updates: number, world: VehicleWorld): VehiclePose[] {
  const ch = new Float32Array(34);
  const state = { channels: ch, nTick: 0 };
  const seek = (n: number) => {
    if (n === 0 || n < state.nTick) {
      ch.fill(0);
      state.nTick = 0;
      for (let k = n + 1; k > 0; k--) {
        stepAnimRecords(state, records);
        vehicle.animInput(state.nTick, ch, world);
      }
    } else {
      while (state.nTick < n) {
        stepAnimRecords(state, records);
        vehicle.animInput(state.nTick, ch, world);
        state.nTick++;
      }
    }
  };
  seek(0);
  const out: VehiclePose[] = [];
  for (let i = 0; i < updates; i++) {
    seek(state.nTick + 1);
    out.push(vehicle.pose());
  }
  return out;
}
