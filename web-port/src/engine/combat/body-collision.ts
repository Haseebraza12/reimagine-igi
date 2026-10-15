/**
 * A bone model's own collision (HSMC set 0), posed with the skeleton for
 * hit tests, as igi.exe does for humans (FUN_004cdcb0 / FUN_004cef60,
 * docs/characters.md, docs/collision.md): every collision vertex is
 * bone-local (XTVC dword 3 = bone) and is placed at R_b p + T_b; faces keep
 * their TAMC material; hits are ordered like every other ray (more than 0.1
 * unit closer wins, within it a front hit beats a back hit).
 *
 * Coordinates: bone matrices in IGI object space (z up, units, the body's
 * yaw included); posed vertices in engine metres relative to the object's
 * feet position: (x, z + rootZ, -y) / 4096.
 */
import { HIT_TIE_WINDOW, NO_MATERIAL, UNTAGGED_RAY_MATERIAL, readCollisionModel, type CollisionSet } from "../../loaders/collision-mesh";
import { readMefBounds } from "../../loaders/damage-data";

const UNITS_PER_METRE = 4096;
const TIE_M = HIT_TIE_WINDOW / UNITS_PER_METRE;

/**
 * The sphere a human presents to a sight ray before its faces are tested
 * (FUN_0045e490 -> FUN_0045e210, repeated at the top of FUN_004cef60)
 * [recovered]: with a = from - c and b = to - c, c the human's position
 * (+0x20, the pelvis) and r = human +0xa0 = HSEM +120 of its "Model"
 * (FUN_004cfd90 -> FUN_004c59a0, the farthest bind-pose vertex from the
 * origin; level 1: 0.90-0.95 m), the segment counts only when its bounding
 * box meets the cube c +- r on every axis and the distance from c to its line
 * is at most r. Posed faces outside the sphere (a raised arm, the soles)
 * cannot stop a ray that misses it. Any length unit, any axis order.
 */
export function segmentNearSphere(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  r: number,
): boolean {
  if (Math.min(ax, bx) > r || Math.min(ay, by) > r || Math.min(az, bz) > r) return false;
  if (Math.max(ax, bx) < -r || Math.max(ay, by) < -r || Math.max(az, bz) < -r) return false;
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const dd = dx * dx + dy * dy + dz * dz;
  const along = ax * dx + ay * dy + az * dz;
  const aa = ax * ax + ay * ay + az * az;
  return (dd > 0 ? aa - (along * along) / dd : aa) <= r * r;
}

export interface BodyRayHit {
  /** Distance along the (unit) ray, metres. */
  distance: number;
  /** Bone of the face's first vertex. */
  bone: number;
  /** material.qvm index of the face (untagged faces report Ground). */
  material: number;
  front: boolean;
}

export class BodyCollision {
  /** Posed vertices (engine metres, relative to the feet position). */
  readonly posed: Float32Array;
  /** Root height of the last pose (units): the human position (+0x20, the pelvis) above the feet. */
  private rootZ = 0;
  private constructor(
    private readonly set: CollisionSet,
    /** Non-portal faces as (a, c, b): (v1 - v0) x (v2 - v0) is outward. */
    private readonly tris: Uint16Array,
    private readonly material: Int16Array,
    /** Sight sphere radius, metres: HSEM +120 of the model (human +0xa0, see segmentNearSphere). */
    readonly sphereRadius: number,
  ) {
    this.posed = new Float32Array(set.positions.length);
  }

  /** Set 0 of a bone model's .mef, or null when it has none. */
  static fromModel(buffer: ArrayBuffer): BodyCollision | null {
    const set = readCollisionModel(buffer)?.sets[0];
    if (!set || set.faces.length === 0) return null;
    const tris: number[] = [];
    const material: number[] = [];
    for (let f = 0; f < set.faces.length / 3; f++) {
      const surface = set.surfaces[set.faceSurface[f]];
      if (!surface || surface.portal >= 0) continue;
      tris.push(set.faces[f * 3], set.faces[f * 3 + 2], set.faces[f * 3 + 1]);
      material.push(surface.material === NO_MATERIAL ? UNTAGGED_RAY_MATERIAL : surface.material);
    }
    let radius = Infinity;
    try {
      radius = readMefBounds(buffer).originRadius / UNITS_PER_METRE;
    } catch {
      // no HSEM bounds: no sphere pre-test
    }
    return new BodyCollision(set, Uint16Array.from(tris), Int16Array.from(material), radius);
  }

  /** Pose with bone matrices (16 per bone, column-major, IGI object space) and the root height (units). */
  pose(bones: ArrayLike<number>, rootZ: number): void {
    const P = this.set.positions;
    const B = this.set.vertexBones;
    const out = this.posed;
    this.rootZ = rootZ;
    for (let v = 0; v < B.length; v++) {
      const o = B[v] * 16;
      const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
      const X = bones[o] * x + bones[o + 4] * y + bones[o + 8] * z + bones[o + 12];
      const Y = bones[o + 1] * x + bones[o + 5] * y + bones[o + 9] * z + bones[o + 13];
      const Z = bones[o + 2] * x + bones[o + 6] * y + bones[o + 10] * z + bones[o + 14];
      out[v * 3] = X / UNITS_PER_METRE;
      out[v * 3 + 1] = (Z + rootZ) / UNITS_PER_METRE;
      out[v * 3 + 2] = -Y / UNITS_PER_METRE;
    }
  }

  /**
   * Every face the segment o + d t, t in [0, far], crosses (o relative to the
   * feet position, d unit length), both sides, unordered: the sight-ray face
   * loop of FUN_004cef60 (no ordering; each crossed face marks the ray blocked
   * and feeds the see-through product, see sightTransmission).
   */
  raycastAll(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, far: number): BodyRayHit[] {
    const V = this.posed;
    const T = this.tris;
    const out: BodyRayHit[] = [];
    for (let i = 0; i < T.length; i += 3) {
      const a = T[i] * 3, b = T[i + 1] * 3, c = T[i + 2] * 3;
      const e1x = V[b] - V[a], e1y = V[b + 1] - V[a + 1], e1z = V[b + 2] - V[a + 2];
      const e2x = V[c] - V[a], e2y = V[c + 1] - V[a + 1], e2z = V[c + 2] - V[a + 2];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const sx = ox - V[a], sy = oy - V[a + 1], sz = oz - V[a + 2];
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t < 0 || t > far) continue;
      out.push({ distance: t, bone: this.set.vertexBones[T[i]], material: this.material[i / 3], front: det > 0 });
    }
    return out;
  }

  /**
   * A sight ray's segment from o to e (engine metres, relative to the feet
   * position) against this posed body, FUN_0045e490 [recovered]: nothing
   * unless the segment passes the HSEM sphere around the pelvis
   * (segmentNearSphere), then every set-0 face it crosses (raycastAll).
   */
  sightHits(ox: number, oy: number, oz: number, ex: number, ey: number, ez: number): BodyRayHit[] {
    const cy = this.rootZ / UNITS_PER_METRE;
    if (!segmentNearSphere(ox, oy - cy, oz, ex, ey - cy, ez, this.sphereRadius)) return [];
    const dx = ex - ox, dy = ey - oy, dz = ez - oz;
    const len = Math.hypot(dx, dy, dz);
    if (len === 0) return [];
    return this.raycastAll(ox, oy, oz, dx / len, dy / len, dz / len, len);
  }

  /**
   * Nearest hit of the ray o + d t, t in [near, far] (o relative to the feet
   * position, d unit length), with the exe's ordering.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, near: number, far: number): BodyRayHit | null {
    const V = this.posed;
    const T = this.tris;
    let best = -1;
    let bestT = Infinity;
    let bestFront = false;
    for (let i = 0; i < T.length; i += 3) {
      const a = T[i] * 3, b = T[i + 1] * 3, c = T[i + 2] * 3;
      const e1x = V[b] - V[a], e1y = V[b + 1] - V[a + 1], e1z = V[b + 2] - V[a + 2];
      const e2x = V[c] - V[a], e2y = V[c + 1] - V[a + 1], e2z = V[c + 2] - V[a + 2];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const sx = ox - V[a], sy = oy - V[a + 1], sz = oz - V[a + 2];
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t < near || t > far) continue;
      const front = det > 0;
      const replaces = best < 0 || t < bestT - TIE_M || (t < bestT + TIE_M && (t < bestT ? front || !bestFront : front && !bestFront));
      if (!replaces) continue;
      best = i / 3;
      bestT = t;
      bestFront = front;
    }
    if (best < 0) return null;
    return { distance: bestT, bone: this.set.vertexBones[T[best * 3]], material: this.material[best], front: bestFront };
  }
}
