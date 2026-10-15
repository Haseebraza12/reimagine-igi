/**
 * `Wire` tasks (zip lines / hand-over-hand cables): how igi.exe poses the
 * model between "Start position" and "Stop position", and the attach-point
 * rule the player code uses. Details and addresses: docs/wire.md.
 *
 * Evidence labels:
 *   - recovered: read from igi.exe code (addresses below);
 *   - observed:  measured from the game data;
 *   - inferred:  consistent with code and data, not confirmed.
 *
 * Placement [recovered, Wire "compile" handler FUN_0043e590, registered at
 * 0x43e227 through the DAT_0054a16d slot]:
 *   d      = stop - start             (f64, task +0x108 - task +0xf0)
 *   L      = |d|                      (FUN_004a9410)
 *   R      = wireFrame(d / L)         (FUN_00486a60, stored at +0x70)
 *   scale  = (1, L / 4096, 1)         (+0x9c = L * DAT_005314b0 = L / 4096;
 *                                      +0x98 and +0xa0 keep the constructor's
 *                                      1.0 from FUN_004bb930)
 *   pos    = (start + stop) / 2       (DAT_00531580 = 0.5; FUN_004bcb60
 *                                      stores it as the object position +0x20)
 *   world  = pos + R * diag(scale) * v_model
 * One instance, rigidly rotated and stretched along model +y. No sag, no
 * segments, no generated geometry. The 1/4096 is hard-wired: it is not taken
 * from the model, so the model must be 4096 units long along y and centred
 * on its origin to span start..stop. Model 320_01_1 (the only Wire model in
 * level 1) is exactly that: a triangular prism y = -2048..+2048, 110 units
 * wide, z = 0.2..128 (the cable sits 0-3 cm above the start-stop line)
 * [observed].
 *
 * Rendering [recovered]: Wire overrides no draw handler; the rigid object
 * draw FUN_0052e5d0 builds the world matrix as R with column c scaled by
 * scale[c] (then x 0.001 D3D units), i.e. exactly `matrix` below. 320_01_1
 * is a type-0 (vertex-lit) model with one opaque block: lit and fogged like
 * every other rigid object (docs/rendering.md section 5) [observed flags].
 *
 * Collision [recovered FUN_004b7a60, 0x4b7d70..0x4b7fa8]: the rigid ray
 * handler moves rays into model space with R^T (p - pos) / scale.x for ALL
 * three axes, so with scale.x = 1 bullets test the UNSTRETCHED model: a 1 m
 * piece (y = +-2048) around the wire midpoint (`collisionMatrix`). The hit
 * point it reports is then mapped back with the per-axis scale. Character
 * sweeps skip Wire (filter 0x4159a0) and set 1 of 320_01_1 is empty; AI
 * sight skips it (slot 8 cleared at 0x43e2f9); bullets leave no decal (the
 * BulletHole slot DAT_0053e894 is cleared at 0x43e30d).
 *
 * Units: IGI units (4096 = 1 m), z up, right-handed. Matrices here are in
 * IGI space; convert with coords.ts (igiRotationToEngine works for any
 * linear 3x3, including this non-uniform scale).
 */
import type { Vec3 } from "../contracts";
import type { Mat3 } from "./coords";

/** Length scale: model +y scale = L * this (DAT_005314b0, f64 1/4096, fmul at 0x43e60d) [recovered]. */
export const WIRE_LENGTH_SCALE = 1 / 4096;
/** Midpoint factor for the object position (DAT_00531580, f64 0.5, 0x43e669..0x43e685) [recovered]. */
export const WIRE_POSITION_FACTOR = 0.5;
/** FUN_00486a60 builds the frame from world z unless |dir.z| > this (DAT_00531658, f32 0.95) [recovered]. */
export const WIRE_FRAME_VERTICAL_LIMIT = Math.fround(0.95);
/** Interaction kind returned by the Wire "action type" handler 0x43e880; the player dispatcher treats 9 as "wire" (FUN_0040ce30 case 9) [recovered]. */
export const WIRE_USE_KIND = 9;
/** A wire whose x-rotation angle (wrapped to [0, 2pi)) exceeds this is slid down, else traversed hand over hand (DAT_00531834, f32 2 deg, FUN_0043ea60) [recovered]. */
export const WIRE_SLIDE_MIN_ANGLE = Math.fround((2 * Math.PI) / 180);
/** Distance kept from each wire end while traversing (DAT_005314f0, f32 3072 = 0.75 m, FUN_00411a80) [recovered]. */
export const WIRE_TRAVERSE_END_MARGIN = 3072;
/** Distance kept from each wire end while sliding (DAT_00531500, f32 2048 = 0.5 m, FUN_00411ec0) [recovered]. */
export const WIRE_SLIDE_END_MARGIN = 2048;
/** Human position below the wire while traversing, along -frame z (DAT_005314e8, f64 2150.4 = 0.525 m) [recovered]. */
export const WIRE_TRAVERSE_HANG = 2150.4;
/** Human position below the wire while sliding, along -frame z (DAT_005314f8, f64 3686.4 = 0.9 m) [recovered]. */
export const WIRE_SLIDE_HANG = 3686.4;

/** Model data the Wire code reads (from the .mef; see readWireModelInfo). */
export interface WireModelInfo {
  /** HSEM f32 at +0x78: largest vertex distance from the model origin (FUN_004c59a0). 320_01_1: 2052.73. */
  originRadius: number;
  /**
   * XTVM records (16 bytes: f32 x, y, z, u32): the model's points read by
   * FUN_004c59c0 / FUN_004c5aa0 (runtime header +0x7c count, +0x88 array).
   * 320_01_1: (17.6, -2048, 121.5) and (17.6, +2048, 121.5), one per end.
   * The XTVM -> +0x88 link is inferred (count and values match; the loader
   * fix-up was not traced).
   */
  magicVertices: Vec3[];
}

export interface WirePose {
  /** Object position = midpoint of start and stop (IGI units). */
  position: Vec3;
  /** Unit vector start -> stop (= model +y in world). */
  direction: Vec3;
  /** |stop - start| in IGI units. */
  length: number;
  /** Row-major rotation (columns = model x, y, z axes in world), FUN_00486a60. */
  rotation: Mat3;
  /** Per-axis model scale (1, length / 4096, 1). */
  scale: Vec3;
  /** rotation * diag(scale), row-major: the linear part of the draw transform. */
  linear: Mat3;
  /** Column-major 4x4 model -> world (IGI units, z up) used to DRAW the wire. */
  matrix: number[];
  /**
   * Column-major 4x4 rigid model -> world (no scale) in which igi.exe's ray
   * handler tests the collision faces (FUN_004b7a60 divides by scale.x = 1).
   */
  collisionMatrix: number[];
  /** Octree / cull sphere radius about `position`: originRadius * max(scale); null without model info. */
  boundingRadius: number | null;
}

export type WireUseMode = "slide" | "traverse";

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (v: Vec3): Vec3 => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 0];
};
const column = (m: Mat3, c: number): Vec3 => [m[c], m[3 + c], m[6 + c]];

/** Column-major 4x4 from a row-major linear part and a translation. */
function columnMajor(linear: Mat3, t: Vec3): number[] {
  const m = linear;
  return [m[0], m[3], m[6], 0, m[1], m[4], m[7], 0, m[2], m[5], m[8], 0, t[0], t[1], t[2], 1];
}

/**
 * Orthonormal frame whose +y is `direction` (FUN_00486a60) [recovered].
 * Returned row-major with columns (x, y, z):
 *   |dir.z| <= 0.95: x = normalize(dir x Z), z = normalize(x x dir)
 *                    (x horizontal, z = world up made perpendicular to dir);
 *   otherwise:       z = normalize(X x dir), x = normalize(dir x z).
 * Right-handed (x x y = z). `direction` must be unit length (the caller,
 * FUN_0043e590, normalises it in f64 and passes f32; this port keeps f64).
 */
export function wireFrame(direction: Vec3): Mat3 {
  const d = direction;
  let x: Vec3;
  let z: Vec3;
  if (Math.abs(d[2]) <= WIRE_FRAME_VERTICAL_LIMIT) {
    x = normalize([d[1], -d[0], 0]);
    z = normalize(cross(x, d));
  } else {
    z = normalize([0, -d[2], d[1]]);
    x = normalize(cross(d, z));
  }
  return [x[0], d[0], z[0], x[1], d[1], z[1], x[2], d[2], z[2]];
}

/**
 * Pose of a Wire task's model (FUN_0043e590) [recovered]. Returns null when
 * start == stop (igi.exe would divide by zero and produce NaNs).
 */
export function wirePose(start: Vec3, stop: Vec3, model: WireModelInfo | null = null): WirePose | null {
  const delta = sub(stop, start);
  const length = Math.hypot(delta[0], delta[1], delta[2]);
  if (!(length > 0) || !Number.isFinite(length)) return null;
  const direction: Vec3 = [delta[0] / length, delta[1] / length, delta[2] / length];
  const rotation = wireFrame(direction);
  const scale: Vec3 = [1, length * WIRE_LENGTH_SCALE, 1];
  const linear = rotation.map((v, i) => v * scale[i % 3]) as Mat3;
  const position: Vec3 = [
    (start[0] + stop[0]) * WIRE_POSITION_FACTOR,
    (start[1] + stop[1]) * WIRE_POSITION_FACTOR,
    (start[2] + stop[2]) * WIRE_POSITION_FACTOR,
  ];
  return {
    position,
    direction,
    length,
    rotation,
    scale,
    linear,
    matrix: columnMajor(linear, position),
    collisionMatrix: columnMajor(rotation, position),
    boundingRadius: model ? model.originRadius * Math.max(scale[0], scale[1], scale[2]) : null,
  };
}

/**
 * Frame the player code uses (FUN_0043e9e0) [recovered]: wireFrame of the
 * world-space direction from model point 0 to point 1 (R * S * (p1 - p0)).
 * For 320_01_1 this equals `pose.rotation` to ~1e-7.
 */
export function wireAttachFrame(pose: WirePose, model: WireModelInfo): Mat3 {
  if (model.magicVertices.length < 2) throw new Error("wire: model has fewer than two points");
  const [p0, p1] = model.magicVertices;
  const local = sub(p1, p0);
  const m = pose.linear;
  return wireFrame(
    normalize([
      m[0] * local[0] + m[1] * local[1] + m[2] * local[2],
      m[3] * local[0] + m[4] * local[1] + m[5] * local[2],
      m[6] * local[0] + m[7] * local[1] + m[8] * local[2],
    ]),
  );
}

/**
 * Slide or hand-over-hand (FUN_0043ea60 -> FUN_0040ce30 case 9) [recovered]:
 * alpha = atan2(frame[7], frame[8]) (FUN_004a9f30's first angle, the pitch of
 * the start -> stop direction), wrapped to [0, 2pi) when negative; the exe
 * then takes |alpha| (a no-op after the wrap) and slides when alpha > 2 deg.
 * So any wire whose stop is lower than its start slides, an exactly level
 * wire is traversed, and a rising wire slides only above 2 deg. (The
 * gimbal branch of FUN_004a9f30 needs |frame x| <= 1e-4 horizontally, which
 * wireFrame never produces.)
 */
export function wireUseMode(frame: Mat3): WireUseMode {
  let alpha = Math.atan2(frame[7], frame[8]);
  if (alpha < 0) alpha += 2 * Math.PI;
  return Math.abs(alpha) > WIRE_SLIDE_MIN_ANGLE ? "slide" : "traverse";
}

/**
 * Point on the wire for a human at `point` (IGI world) [recovered]:
 *   y  = frame.y . (point - pose.position), clamped to
 *        [p0.y * scale.y + margin, p1.y * scale.y - margin];
 *   out = pose.position + frame.y * y - frame.z * hang.
 *   "candidate": margin 0, hang 0 (0x43e720, the use-target test);
 *   "traverse":  margin 3072, hang 2150.4 (FUN_00411a80, attach);
 *   "slide":     margin 2048, hang 3686.4 (FUN_00411ec0, attach).
 * While attached, leaving [lo, hi] detaches the player (same functions).
 */
export function wireHoldPoint(
  pose: WirePose,
  model: WireModelInfo,
  point: Vec3,
  mode: "candidate" | WireUseMode,
): Vec3 {
  const frame = wireAttachFrame(pose, model);
  const axis = column(frame, 1);
  const up = column(frame, 2);
  const margin = mode === "traverse" ? WIRE_TRAVERSE_END_MARGIN : mode === "slide" ? WIRE_SLIDE_END_MARGIN : 0;
  const hang = mode === "traverse" ? WIRE_TRAVERSE_HANG : mode === "slide" ? WIRE_SLIDE_HANG : 0;
  const lo = model.magicVertices[0][1] * pose.scale[1] + margin;
  const hi = model.magicVertices[1][1] * pose.scale[1] - margin;
  const y = dot(axis, sub(point, pose.position));
  const t = y < lo ? lo : y > hi ? hi : y;
  return [
    pose.position[0] + axis[0] * t - up[0] * hang,
    pose.position[1] + axis[1] * t - up[1] * hang,
    pose.position[2] + axis[2] * t - up[2] * hang,
  ];
}

/**
 * Read the two model values the Wire code uses from a .mef (ILFF/OCEM):
 * HSEM f32 +0x78 (the runtime header is the HSEM payload: +0x30 sphere
 * centre and +0x3c radius are what FUN_004c4d00 reads) and the XTVM points.
 */
export function readWireModelInfo(buffer: ArrayBuffer): WireModelInfo {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  const fail = (message: string): never => {
    throw new Error(`wire: ${message}`);
  };
  if (bytes.length < 20 || tag(0) !== "ILFF" || tag(16) !== "OCEM") fail("expected ILFF/OCEM model");
  const align = (value: number, a: number) => (a > 1 ? Math.ceil(value / a) * a : value);
  let hsem: { offset: number; size: number } | null = null;
  let xtvm: { offset: number; size: number } | null = null;
  let pos = align(20, view.getUint32(8, true));
  for (let guard = 0; pos + 16 <= bytes.length && guard < 4096; guard++) {
    const size = view.getUint32(pos + 4, true);
    const offset = align(pos + 16, view.getUint32(pos + 8, true));
    const next = view.getUint32(pos + 12, true);
    if (offset + size > bytes.length) fail(`chunk ${tag(pos)} outside file`);
    if (tag(pos) === "HSEM") hsem = { offset, size };
    if (tag(pos) === "XTVM") xtvm = { offset, size };
    if (next === 0) break;
    pos += next;
  }
  if (!hsem || hsem.size < 0x7c) return fail("missing HSEM");
  if (!xtvm || xtvm.size % 16 !== 0) return fail("missing XTVM");
  const magicVertices: Vec3[] = [];
  for (let at = xtvm.offset; at < xtvm.offset + xtvm.size; at += 16) {
    magicVertices.push([view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true)]);
  }
  return { originRadius: view.getFloat32(hsem.offset + 0x78, true), magicVertices };
}
