/**
 * SplineObj segments of igi.exe (railway embankment, cables): the frames a
 * SplineObjSegment computes at compile time and the vertex deformation its
 * draw and its ray handler apply to the segment model.  Documentation and
 * evidence: docs/vehicles.md section 6 ("Segment drawing").
 *
 * Evidence labels:
 *   [recovered] read from igi.exe (Ghidra FUN_ names, image base 0x400000)
 *   [observed]  measured on the shipped files
 *   [inferred]  interpretation the traced code does not prove
 *
 * Summary [recovered]:
 * - Waypoint k >= 1 owns the segment from waypoint k-1 to k (the waypoint
 *   compile 0x4f7b10 takes the previous sibling, FUN_00401cc0, and calls
 *   FUN_004db070 at 0x4f8361 with ITS OWN "Segment Model" +0x188, "NumAreas"
 *   +0x198 and "Flip" +0x1a4; schema 0x4f91be..0x4f92ee).  An empty Segment
 *   Model gives no model (FUN_004c82b0 returns 0) and the segment is not
 *   drawn, but it still counts for the spline length.
 * - Pieces n = min(NumAreas, SplineObj "Number of Matrices / Segment", 20)
 *   (0x4f8098..0x4f80bb); linear = SplineObj "Linear Segments" (+0x4e) or the
 *   waypoint's "Align" (+0x1a1) (0x4f8078..0x4f8092, 0x4f82fc).
 * - FUN_004db1d0: points p_i (the train polyline, vehicles.ts RailSpline) and
 *   one matrix M_i per point (+0x200 + 0x28 i): M_0 / M_n = the start / end
 *   waypoint matrices; 0 < i < n: Rz(gamma_i) Ry(beta_i) Rx(alpha_i) with
 *   gamma_i / beta_i the heading / pitch of the Hermite derivative
 *   (FUN_00511f00, FUN_004a8fe0) and alpha_i the waypoints' roll
 *   (FUN_004a9f30) interpolated linearly in s = i / n (unwrapped to +-pi).
 * - The model's x range is [min(0, min x), max(0, max x)] over the render
 *   vertices of every LOD (+0xfc / +0x100).
 * - Vertex (FUN_0052d340 draw, FUN_004d80e0 collision copy): f = (x - x0) n /
 *   (xmax - xmin) (x0 = xmin, or xmax with Flip and f negated), i =
 *   trunc(f) (FISTP, chop mode; i = n -> n - 1), t = clamp(f - i, 0, 1);
 *   P = M_i (0, y, z) + p_i, Q = M_{i+1} (0, y, z) + p_{i+1}, v = P + t (Q -
 *   P): model x only selects the place along the polyline, the cross-section
 *   (y, z) is carried by the blended frames.  Draw normals = M_i n.
 * - Linear segments: one matrix M (+0x70) whose column 0 is the 3D chord /
 *   (xmax - xmin) (negated with Flip) and columns 1, 2 those of Rz(heading of
 *   the chord); v = M (x - (xmin + xmax) / 2, y, z); draw normals are NOT
 *   rotated (FUN_0052d340 copies them).
 * - Positions are relative to the segment midpoint (object +0x20); the draw
 *   uses an identity world rotation (FUN_0052cfc0).  The ray handler
 *   FUN_004d8380 tests the same deformed HSMC sets (linear: the original set
 *   with the ray mapped through M^-1, +0x520) and negates the face normal
 *   with Flip.
 */
import type { IgiTask } from "./tasks";
import { numberParam, stringParam, vec3Param } from "./tasks";
import type { Mat3, Vec3 } from "./mission";
import { RailSpline, eulerF, rotZ, type RailSegment, type RailWaypoint } from "./vehicles";
import { x87Fistp, x87StoreF32 } from "./x87";

const f32 = x87StoreF32;
const PI_F = Math.fround(Math.PI); // 0x531400
const TWO_PI_F = Math.fround(2 * Math.PI); // 0x531594
const TWO_PI_D = 6.283185307179589; // 0x531728 (double)
const HALF_PI_D = 1.5707963267948972; // 0x532a78 (double)
const GIMBAL_EPS = 0.0001; // 0x532250 (double)
/** "Number of Matrices / Segment" and "NumAreas" range [2, 20] (0x80acf8); the piece count is clamped to 20 (0x4f80a9). */
export const MAX_SEGMENT_PIECES = 20;

/** Per-waypoint parameters (SplineObjWaypoint schema 0x4f91be..0x4f92ee). */
export interface SplineWaypointParams extends RailWaypoint {
  /** "Align" (+0x1a1): makes this waypoint's segment linear. */
  align: boolean;
  /** "Flip" (+0x1a4): the segment model runs from this waypoint back to the previous one. */
  flip: boolean;
}

/** SplineObj parameters (schema 0x4f9051..: Linear Segments +0x4e, Number of Matrices / Segment +0x24). */
export interface SplineParams {
  linear: boolean;
  gamma: number;
  matricesPerSegment: number;
  waypoints: SplineWaypointParams[];
}

export function splineParamsFromTask(spline: IgiTask): SplineParams {
  const matrices = numberParam(spline, "Number of Matrices / Segment") ?? MAX_SEGMENT_PIECES;
  return {
    linear: spline.params["Linear Segments"] === true,
    gamma: numberParam(spline, "Gamma Orientation") ?? Math.PI,
    matricesPerSegment: matrices,
    waypoints: spline.children.filter((c) => c.type === "SplineObjWaypoint").map((w) => {
      const areas = numberParam(w, "NumAreas") ?? MAX_SEGMENT_PIECES;
      return {
        position: vec3Param(w, "Position") ?? [0, 0, 0],
        orientation: vec3Param(w, "Orientation") ?? [0, 0, 0],
        segmentModel: stringParam(w, "Segment Model") ?? "",
        // min(NumAreas, Number of Matrices / Segment, 20) [recovered 0x4f8098]
        pieces: Math.min(areas, matrices, MAX_SEGMENT_PIECES),
        align: w.params["Align"] === true,
        flip: w.params["Flip"] === true,
      };
    }),
  };
}

/** The rail the trains run on: vehicles.ts RailSpline with the recovered piece count. */
export function railSplineFromTask(spline: IgiTask): RailSpline {
  return new RailSpline(splineParamsFromTask(spline));
}

/** One SplineObjSegment: what FUN_004db1d0 stores for drawing and rays. */
export interface SplineSegmentFrames {
  /** Index k >= 1 of the owning (end) waypoint. */
  index: number;
  /** The end waypoint's "Segment Model" ("" = not drawn). */
  model: string;
  linear: boolean;
  flip: boolean;
  pieces: number;
  /** Segment origin (object +0x20): midpoint of the two waypoints (doubles). */
  mid: Vec3;
  /** Float points relative to `mid` (pieces + 1; the train polyline). */
  points: Vec3[];
  /** M_0 .. M_n (linear segments: Rz(heading of the chord) twice). */
  matrices: Mat3[];
  /** p_end - p_start as floats (the linear stretch, 0x4db454). */
  chord: Vec3;
}

/** FUN_004a9f30: matrix -> (alpha, beta, gamma), each wrapped to [0, 2 pi), stored as floats. */
export function matrixAngles(m: Mat3): Vec3 {
  const atan2Guarded = (y: number, x: number): number => {
    if (x === 0) {
      if (y === 0) return 0; // the exe stops with "Atan2 undefined in origo"
      return (y < 0 ? -1 : 1) * HALF_PI_D;
    }
    return Math.atan2(y, x);
  };
  const cb = Math.sqrt(m[0] * m[0] + m[3] * m[3]);
  let alpha: number;
  let gamma: number;
  if (cb <= GIMBAL_EPS) {
    alpha = atan2Guarded(-m[5], m[4]);
    gamma = 0;
  } else {
    alpha = atan2Guarded(m[7], m[8]);
    gamma = atan2Guarded(m[3], m[0]);
  }
  let beta = cb === 0 ? (-m[6] < 0 ? -HALF_PI_D : HALF_PI_D) : Math.atan2(-m[6], cb);
  if (alpha < 0) alpha += TWO_PI_D;
  if (beta < 0) beta += TWO_PI_D;
  if (gamma < 0) gamma += TWO_PI_D;
  return [f32(alpha), f32(beta), f32(gamma)];
}

/** FUN_004a8fe0: direction -> (pitch beta = -asin(z / |v|), heading gamma = atan2(y, x), 0 when x = 0). */
export function directionAngles(v: Vec3): { beta: number; gamma: number } {
  const gamma = v[0] === 0 ? 0 : f32(Math.atan2(v[1], v[0]));
  const len = Math.sqrt(v[2] * v[2] + v[1] * v[1] + v[0] * v[0]);
  // FUN_004a8ab0: asin with the argument clamped to [-1, 1]
  const beta = len === 0 ? 0 : f32(-Math.asin(Math.max(-1, Math.min(1, v[2] / len))));
  return { beta, gamma };
}

/**
 * The segments of a SplineObj as FUN_004db1d0 builds them.  `rail` must come
 * from the same parameters (railSplineFromTask); aligned waypoints use a
 * linear twin of it for their own segment.
 */
export function splineSegmentFrames(params: SplineParams, rail: RailSpline = new RailSpline(params)): SplineSegmentFrames[] {
  const anyAlign = !params.linear && params.waypoints.some((w, k) => k > 0 && w.align);
  const linearRail = anyAlign ? new RailSpline({ ...params, linear: true }) : null;
  const out: SplineSegmentFrames[] = [];
  for (let k = 1; k < params.waypoints.length; k++) {
    const wp = params.waypoints[k];
    const linear = params.linear || wp.align;
    const source = linear && linearRail ? linearRail : rail;
    const seg = source.segments[k] as RailSegment;
    const a = source.waypoints[k - 1];
    const b = source.waypoints[k];
    const frames: SplineSegmentFrames = {
      index: k, model: wp.segmentModel, linear, flip: wp.flip, pieces: seg.pieces, mid: seg.mid, points: seg.points,
      matrices: [], chord: [0, 0, 0],
    };
    const p0 = a.position;
    const p1 = b.position;
    if (linear) {
      // 0x4db398: chord direction -> Rz(heading); +0x70 gets the chord as column 0 later.
      const chord: Vec3 = [f32(p1[0] - p0[0]), f32(p1[1] - p0[1]), f32(p1[2] - p0[2])];
      frames.chord = chord;
      const zero = chord[0] === 0 && chord[1] === 0 && chord[2] === 0;
      const h = zero ? 0 : directionAngles(chord).gamma;
      frames.matrices = [rotZ(h), rotZ(h)];
    } else {
      const n = seg.pieces;
      const inv = f32(1 / n);
      const chord = f32(Math.sqrt((p1[0] - p0[0]) ** 2 + (p1[1] - p0[1]) ** 2 + (p1[2] - p0[2]) ** 2));
      // FUN_00511e70 per axis: c0 = start tangent, c2 = 2 p0 - 2 p1 + m0 + m1, c3 = 3 p1 - 3 p0 - 2 m0 - m1
      const coef = [0, 1, 2].map((ax) => {
        const m0 = a.matrix[ax * 3] * chord;
        const m1 = b.matrix[ax * 3] * chord;
        return { m0, c2: ((p0[ax] + p0[ax]) - (p1[ax] + p1[ax])) + m0 + m1, c3: ((p1[ax] * 3 - p0[ax] * 3) - (m0 + m0)) - m1 };
      });
      const [alphaStart] = matrixAngles(a.matrix);
      const [alphaEnd] = matrixAngles(b.matrix);
      let start = alphaStart;
      let end = alphaEnd;
      while (PI_F < end - start) start += TWO_PI_F;
      while (end - start < -PI_F) end += TWO_PI_F;
      start = f32(start);
      end = f32(end);
      for (let i = 0; i <= n; i++) {
        if (i === 0) {
          frames.matrices.push([...a.matrix] as Mat3);
          continue;
        }
        if (i === n) {
          frames.matrices.push([...b.matrix] as Mat3);
          continue;
        }
        const s = i * inv; // FILD i; FMUL inv (extended, passed as a double)
        const sf = f32(s);
        // FUN_00511f00: d/ds = s c3 + s c3 + 3 s^2 c2 + m0, stored as floats
        const d = coef.map(({ m0, c2, c3 }) => f32(s * c3 + s * c3 + s * c2 * s * 3 + m0)) as Vec3;
        const zero = d[0] === 0 && d[1] === 0 && d[2] === 0;
        const { beta, gamma } = zero ? { beta: 0, gamma: 0 } : directionAngles(d);
        const alpha = f32((end - start) * sf + start);
        frames.matrices.push(eulerF(alpha, beta, gamma));
      }
    }
    out.push(frames);
  }
  return out;
}

/** A segment model's x range [min(0, min x), max(0, max x)] over the render vertices of all its LODs (+0xfc / +0x100). */
export function segmentModelRange(lodPositions: ReadonlyArray<ArrayLike<number>>): [number, number] {
  let lo = 0;
  let hi = 0;
  for (const positions of lodPositions) {
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      if (x < lo) lo = x;
      if (hi < x) hi = x;
    }
  }
  return [lo, hi];
}

export interface SegmentDeformer {
  /** Model-space IGI point -> point relative to the segment midpoint (float, as the exe stores it). */
  position(x: number, y: number, z: number): Vec3;
  /** Model-space normal -> drawn normal (M_i n; linear segments: unchanged). */
  normal(x: number, n: Vec3): Vec3;
  /** True when the deformation mirrors the model (Flip): faces turn inside out, the ray handler negates the normal. */
  mirrored: boolean;
  /** Vertices whose piece index fell outside [0, n - 1] (the exe would read past its arrays); clamped here. */
  outOfRange: number;
  /** Linear segments: the stretch matrix M (object +0x70); null otherwise. */
  matrix: Mat3 | null;
}

/** FUN_0052d340 / FUN_004d80e0 for one segment and its model x range. */
export function segmentDeformer(seg: SplineSegmentFrames, range: [number, number]): SegmentDeformer {
  const [xmin, xmax] = range;
  const inv = f32(1 / f32(xmax - xmin));
  if (seg.linear) {
    // FUN_004db1d0 tail: column 0 = chord * inv (negated with Flip), columns 1, 2 = Rz(heading).
    const chord = seg.chord;
    const sign = seg.flip ? -1 : 1;
    const r = seg.matrices[0];
    const m: Mat3 = [
      f32(sign * f32(inv * chord[0])), r[1], r[2],
      f32(sign * f32(inv * chord[1])), r[4], r[5],
      f32(sign * f32(inv * chord[2])), r[7], r[8],
    ];
    const xc = f32((xmin + xmax) * 0.5);
    const deformer: SegmentDeformer = {
      position(x, y, z) {
        const u = f32(x - xc);
        return [f32(u * m[0] + y * m[1] + z * m[2]), f32(u * m[3] + y * m[4] + z * m[5]), f32(u * m[6] + y * m[7] + z * m[8])];
      },
      normal: (_x, n) => [n[0], n[1], n[2]],
      mirrored: seg.flip,
      outOfRange: 0,
      matrix: m,
    };
    return deformer;
  }
  const n = seg.pieces;
  const x0 = seg.flip ? xmax : xmin;
  const k = seg.flip ? -(n * inv) : n * inv;
  const P = seg.points;
  const M = seg.matrices;
  let outOfRange = 0;
  const piece = (x: number): { i: number; t: number } => {
    const f = (x - x0) * k;
    let i = x87Fistp(f);
    if (i === n) i = n - 1;
    if (i < 0 || i > n - 1) {
      outOfRange++;
      i = Math.max(0, Math.min(n - 1, i));
    }
    const t = Math.max(0, Math.min(1, f - i));
    return { i, t };
  };
  return {
    position(x, y, z) {
      const { i, t } = piece(x);
      const a = M[i];
      const b = M[i + 1];
      const pa = P[i];
      const pb = P[i + 1];
      const out: Vec3 = [0, 0, 0];
      for (let r = 0; r < 3; r++) {
        const p = a[r * 3 + 1] * y + a[r * 3 + 2] * z + pa[r];
        const q = b[r * 3 + 1] * y + b[r * 3 + 2] * z + pb[r];
        out[r] = f32((q - p) * t + p);
      }
      return out;
    },
    normal(x, nv) {
      const { i } = piece(x);
      const a = M[i];
      return [
        f32(nv[0] * a[0] + a[1] * nv[1] + a[2] * nv[2]),
        f32(a[3] * nv[0] + a[4] * nv[1] + a[5] * nv[2]),
        f32(a[6] * nv[0] + a[7] * nv[1] + a[8] * nv[2]),
      ];
    },
    mirrored: seg.flip,
    get outOfRange() {
      return outOfRange;
    },
    matrix: null,
  };
}

/** World IGI position of a deformed vertex: segment midpoint (double) + float offset. */
export function segmentWorldPoint(seg: SplineSegmentFrames, local: Vec3): Vec3 {
  return [seg.mid[0] + local[0], seg.mid[1] + local[1], seg.mid[2] + local[2]];
}
