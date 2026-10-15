/**
 * IGI world/model coordinates -> engine coordinates.
 *
 * IGI (confidence noted in docs/formats.md "Coordinate system"):
 *   - 4096 units = 1 metre (community research; consistent with model sizes:
 *     four 14 m fuel tanks placed exactly 65,536 units = 16 m apart).
 *   - x, y horizontal, z up, RIGHT-handed: a texture label on a +x face reads
 *     left-to-right along +y, which only holds in a right-handed frame.
 *   - Task orientation (alpha, beta, gamma): gamma is a counter-clockwise
 *     rotation about +z (verified: 0 of 876 AI walk-graph links cross a rotated
 *     building, 23 do with the opposite sign). alpha/beta are applied as
 *     Rz(gamma) * Ry(beta) * Rx(alpha) — that order is INFERRED (few
 *     placements use non-zero alpha/beta, so it has not been testable).
 *   - Models face +y: a character or vehicle with heading gamma faces
 *     (-sin gamma, cos gamma) (the driver of the truck shares its gamma).
 *
 * Engine (Three.js): metres, y up, right-handed, -z = IGI north (+y).
 *   engine = C * (igi - origin) / 4096 with C = [[1,0,0],[0,0,1],[0,-1,0]].
 * C is a proper rotation (det +1), so nothing is mirrored. A character with
 * IGI heading gamma has engine yaw == gamma (yaw 0 looks along -z).
 */
import type { Vec3 } from "../contracts";

export const IGI_UNITS_PER_METRE = 4096;

/** Row-major 3x3 matrix, applied to column vectors (v' = M v). */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9) as Mat3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

export function transposeMat3(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function mulMat3Vec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** IGI task orientation (alpha, beta, gamma radians) -> rotation matrix in IGI axes. */
export function igiEulerToMat3(alpha: number, beta: number, gamma: number): Mat3 {
  const [ca, sa] = [Math.cos(alpha), Math.sin(alpha)];
  const [cb, sb] = [Math.cos(beta), Math.sin(beta)];
  const [cg, sg] = [Math.cos(gamma), Math.sin(gamma)];
  const rx: Mat3 = [1, 0, 0, 0, ca, -sa, 0, sa, ca];
  const ry: Mat3 = [cb, 0, sb, 0, 1, 0, -sb, 0, cb];
  const rz: Mat3 = [cg, -sg, 0, sg, cg, 0, 0, 0, 1];
  return mulMat3(rz, mulMat3(ry, rx));
}

/** IGI axes -> engine axes. */
const C: Mat3 = [1, 0, 0, 0, 0, 1, 0, -1, 0];
const C_T = transposeMat3(C);

/** Convert a direction/normal from IGI axes to engine axes (no scaling). */
export function igiDirToEngine(v: Vec3): Vec3 {
  return [v[0], v[2], -v[1]];
}

/** Convert an IGI world position to engine metres relative to `origin` (IGI units). */
export function igiPointToEngine(p: Vec3, origin: Vec3): Vec3 {
  return [
    (p[0] - origin[0]) / IGI_UNITS_PER_METRE,
    (p[2] - origin[2]) / IGI_UNITS_PER_METRE,
    -(p[1] - origin[1]) / IGI_UNITS_PER_METRE,
  ];
}

/** Express an IGI-axes rotation in engine axes (C R C^T). */
export function igiRotationToEngine(r: Mat3): Mat3 {
  return mulMat3(C, mulMat3(r, C_T));
}

/**
 * Column-major 4x4 (Three.js Matrix4.elements order) from an engine-axes
 * rotation and an engine-space translation.
 */
export function engineMatrix4(r: Mat3, t: Vec3): number[] {
  return [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, t[0], t[1], t[2], 1];
}
