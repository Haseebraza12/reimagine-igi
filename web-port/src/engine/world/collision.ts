/**
 * Triangle collision world (engine space, metres, y up), built from the
 * original collision meshes (docs/collision.md).
 *
 * Every triangle carries query flags, a surface material (material.qvm
 * SetActiveMaterial index, -1 = none) and its owner (placed instance index,
 * -1 = terrain or extra geometry). The flags say which queries see it:
 *   - TRI_SOLID:   character wall sweep and ground probe = HSMC set 1 (the
 *                  HumanCollision hull) + terrain           [recovered: push 1 at 0x46097d, 0x461368]
 *   - TRI_BULLET:  bullets = HSMC set 0 (visible faces) + terrain  [recovered: 0x4c2734]
 *   - TRI_SIGHT:   AI line of sight = set 0 without Glass + terrain [recovered: filter 0x53f120]
 *   - TRI_TERRAIN: terrain triangle (Ground on front hits, none on back hits).
 * Triangles are stored with their outward normal (c - a) x (b - a) of the
 * original winding as the geometric normal, so a hit is "front" when the ray
 * runs against it. There is no alpha test: the original never tests texels
 * (FUN_0051d680 returns 0).
 *
 * Hit ordering [recovered, FUN_004b7a60 / FUN_004c2a30]: among objects, a hit
 * more than 0.1 unit closer wins and within 0.1 unit a front hit beats a back
 * hit; a terrain hit replaces the object hit only when strictly closer.
 *
 * Moving or removable objects (doors, vehicles, objects inside
 * ConditionalContainers) are dynamic bodies: small worlds of their own, moved
 * rigidly by setBodyTransform() and switched off by setBodyEnabled(). The
 * original likewise tests each object at its current pose.
 *
 * Static triangles are bucketed in a uniform XZ grid (port data structure).
 */
import { HIT_TIE_WINDOW } from "../../loaders/collision-mesh";

/** Per-triangle flags. */
export const TRI_SOLID = 1;
export const TRI_BULLET = 2;
export const TRI_SIGHT = 4;
export const TRI_TERRAIN = 8;

/** Material terrain rays report on a front hit: world material table entry 1, Ground [recovered 0x4c3520]. */
export const TERRAIN_HIT_MATERIAL = 1;
/** The 0.1-unit hit tie window in metres. */
export const HIT_TIE_WINDOW_M = HIT_TIE_WINDOW / 4096;

export interface RayHit {
  distance: number;
  point: [number, number, number];
  /** Unit face normal turned towards the ray origin. The outward normal is `front ? normal : -normal`. */
  normal: [number, number, number];
  /** Static triangle index, or -1 - bodyId for a dynamic body. */
  triangle: number;
  /** True when the ray runs against the face's outward normal (enters the surface). */
  front: boolean;
  /**
   * material.qvm index of the face, -1 when the face has none (rays report an
   * untagged object face as Ground, the sight test treats it as opaque) and
   * for terrain back faces.
   */
  material: number;
  terrain: boolean;
  /** Placed instance index that owns the face, -1 for terrain / extra geometry. */
  owner: number;
}

export interface SphereContact {
  /** Unit vector from the triangle towards the sphere centre. */
  normal: [number, number, number];
  depth: number;
}

export class CollisionWorldBuilder {
  /** Sub-builders of dynamic bodies (doors, vehicles, objects inside ConditionalContainers). */
  private readonly bodies = new Map<number, CollisionWorldBuilder>();
  private target: CollisionWorldBuilder | null = null;
  private readonly coords: number[] = [];
  private readonly flags: number[] = [];
  private readonly materials: number[] = [];
  private readonly owners: number[] = [];

  /**
   * Route following addIndexed() calls into dynamic body `id` (null = static
   * world). A body is built in the pose its triangles are given in; at run
   * time setBodyTransform() moves it rigidly and setBodyEnabled() removes it.
   */
  setTarget(id: number | null): void {
    if (id === null) {
      this.target = null;
      return;
    }
    let body = this.bodies.get(id);
    if (!body) {
      body = new CollisionWorldBuilder();
      this.bodies.set(id, body);
    }
    this.target = body;
  }

  /**
   * Append triangles from indexed world-space geometry. The winding must make
   * (v1 - v0) x (v2 - v0) the outward normal. `material` is one value for all
   * triangles or one per triangle (-1 = none).
   */
  addIndexed(
    positions: ArrayLike<number>,
    indices: ArrayLike<number>,
    flags = TRI_SOLID | TRI_BULLET | TRI_SIGHT,
    material: number | ArrayLike<number> = -1,
    owner = -1,
  ): void {
    if (this.target) {
      this.target.addIndexed(positions, indices, flags, material, owner);
      return;
    }
    for (let i = 0, t = 0; i + 2 < indices.length; i += 3, t++) {
      const a = indices[i];
      const b = indices[i + 1];
      const c = indices[i + 2];
      this.coords.push(
        positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2],
        positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2],
        positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2],
      );
      this.flags.push(flags);
      this.materials.push(typeof material === "number" ? material : material[t]);
      this.owners.push(owner);
    }
  }

  build(cellSize = 4): CollisionWorld {
    const world = new CollisionWorld(
      new Float32Array(this.coords),
      new Uint8Array(this.flags),
      cellSize,
      Int16Array.from(this.materials),
      Int32Array.from(this.owners),
    );
    for (const [id, body] of this.bodies) world.addBody(id, body.build(cellSize));
    return world;
  }
}

/** A rigid dynamic body: its own small world in its build pose, plus the current transform. */
interface DynamicBody {
  world: CollisionWorld;
  /** Column-major 4x4: build pose -> current pose (rigid). */
  matrix: Float64Array;
  /** Inverse of `matrix`. */
  inverse: Float64Array;
  enabled: boolean;
}

const IDENTITY16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function transformPoint(m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

function transformDirection(m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] {
  return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
}

/** Inverse of a rigid column-major 4x4 (rotation^T, -rotation^T t). */
function invertRigid(m: ArrayLike<number>, out: Float64Array): void {
  out[0] = m[0]; out[1] = m[4]; out[2] = m[8]; out[3] = 0;
  out[4] = m[1]; out[5] = m[5]; out[6] = m[9]; out[7] = 0;
  out[8] = m[2]; out[9] = m[6]; out[10] = m[10]; out[11] = 0;
  out[12] = -(out[0] * m[12] + out[4] * m[13] + out[8] * m[14]);
  out[13] = -(out[1] * m[12] + out[5] * m[13] + out[9] * m[14]);
  out[14] = -(out[2] * m[12] + out[6] * m[13] + out[10] * m[14]);
  out[15] = 1;
}

/** Should object hit `c` replace object hit `b`? (0.1-unit window, front beats back) [recovered FUN_004b7a60]. */
function objectHitReplaces(cDistance: number, cFront: boolean, b: RayHit | null): boolean {
  if (!b) return true;
  const w = HIT_TIE_WINDOW_M;
  if (cDistance < b.distance - w) return true;
  if (cDistance >= b.distance + w) return false;
  if (cDistance < b.distance) return cFront || !b.front;
  return cFront && !b.front;
}

/** Combine the nearest object hit and terrain hit: terrain wins only when strictly closer. */
function combineHits(object: RayHit | null, terrain: RayHit | null): RayHit | null {
  if (!terrain) return object;
  if (!object) return terrain;
  return terrain.distance < object.distance ? terrain : object;
}

/** Per-hit callback of the grid walk: return false to stop early. */
type HitVisitor = (t: number, distance: number, front: boolean) => void;

export class CollisionWorld {
  private readonly bodies = new Map<number, DynamicBody>();
  private readonly bodyContacts: SphereContact[] = [];
  readonly triangleCount: number;
  readonly minX: number;
  readonly minZ: number;
  readonly cols: number;
  readonly rows: number;
  private readonly cellStart: Int32Array;
  private readonly cellItems: Int32Array;
  private readonly normals: Float32Array;
  private readonly stamp: Uint32Array;
  private stampValue = 0;

  constructor(
    private readonly tris: Float32Array,
    private readonly flags: Uint8Array,
    readonly cellSize: number,
    private readonly materials: Int16Array = new Int16Array(flags.length).fill(-1),
    private readonly owners: Int32Array = new Int32Array(flags.length).fill(-1),
  ) {
    this.triangleCount = flags.length;
    this.stamp = new Uint32Array(this.triangleCount);
    this.normals = new Float32Array(this.triangleCount * 3);
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let t = 0; t < this.triangleCount; t++) {
      const o = t * 9;
      for (let k = 0; k < 3; k++) {
        const x = tris[o + k * 3];
        const z = tris[o + k * 3 + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      const e1x = tris[o + 3] - tris[o];
      const e1y = tris[o + 4] - tris[o + 1];
      const e1z = tris[o + 5] - tris[o + 2];
      const e2x = tris[o + 6] - tris[o];
      const e2y = tris[o + 7] - tris[o + 1];
      const e2z = tris[o + 8] - tris[o + 2];
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      this.normals[t * 3] = nx;
      this.normals[t * 3 + 1] = ny;
      this.normals[t * 3 + 2] = nz;
    }
    if (this.triangleCount === 0) {
      minX = minZ = 0;
      maxX = maxZ = cellSize;
    }
    this.minX = minX;
    this.minZ = minZ;
    this.cols = Math.max(1, Math.ceil((maxX - minX) / cellSize) + 1);
    this.rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize) + 1);

    // Two-pass bucket fill (counts, then items).
    const cells = this.cols * this.rows;
    const counts = new Int32Array(cells + 1);
    const visit = (t: number, fn: (cell: number) => void) => {
      const o = t * 9;
      const x0 = Math.min(tris[o], tris[o + 3], tris[o + 6]);
      const x1 = Math.max(tris[o], tris[o + 3], tris[o + 6]);
      const z0 = Math.min(tris[o + 2], tris[o + 5], tris[o + 8]);
      const z1 = Math.max(tris[o + 2], tris[o + 5], tris[o + 8]);
      const c0 = this.col(x0);
      const c1 = this.col(x1);
      const r0 = this.row(z0);
      const r1 = this.row(z1);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) fn(r * this.cols + c);
    };
    for (let t = 0; t < this.triangleCount; t++) visit(t, (cell) => counts[cell + 1]++);
    for (let i = 0; i < cells; i++) counts[i + 1] += counts[i];
    this.cellStart = counts;
    this.cellItems = new Int32Array(counts[cells]);
    const fill = counts.slice(0, cells);
    for (let t = 0; t < this.triangleCount; t++) visit(t, (cell) => (this.cellItems[fill[cell]++] = t));
  }

  private col(x: number): number {
    const c = Math.floor((x - this.minX) / this.cellSize);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  private row(z: number): number {
    const r = Math.floor((z - this.minZ) / this.cellSize);
    return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
  }

  private nextStamp(): number {
    this.stampValue++;
    if (this.stampValue === 0xffffffff) {
      this.stamp.fill(0);
      this.stampValue = 1;
    }
    return this.stampValue;
  }

  /** Register dynamic body `id` (built by CollisionWorldBuilder.setTarget). */
  addBody(id: number, world: CollisionWorld): void {
    this.bodies.set(id, { world, matrix: Float64Array.from(IDENTITY16), inverse: Float64Array.from(IDENTITY16), enabled: true });
  }

  /** Ids of the dynamic bodies. */
  get bodyIds(): number[] {
    return [...this.bodies.keys()];
  }

  /** Move dynamic body `id`: `matrix` (column-major, rigid) maps its build pose to its current pose. */
  setBodyTransform(id: number, matrix: ArrayLike<number>): void {
    const body = this.bodies.get(id);
    if (!body) return;
    for (let i = 0; i < 16; i++) body.matrix[i] = matrix[i];
    invertRigid(body.matrix, body.inverse);
  }

  /** Current transform (column-major, build pose -> current pose) of enabled body `id`, or null. */
  bodyMatrix(id: number): Float64Array | null {
    const body = this.bodies.get(id);
    return body && body.enabled ? Float64Array.from(body.matrix) : null;
  }

  /** Include (true) or exclude (false) dynamic body `id` from every query. */
  setBodyEnabled(id: number, enabled: boolean): void {
    const body = this.bodies.get(id);
    if (body) body.enabled = enabled;
  }

  /** Triangle normal (unit, outward) of triangle `t`. */
  normalOf(t: number): [number, number, number] {
    return [this.normals[t * 3], this.normals[t * 3 + 1], this.normals[t * 3 + 2]];
  }

  /** Material of static triangle `t` (-1 = none). */
  materialOf(t: number): number {
    return this.materials[t];
  }

  /**
   * Walk the grid cells along the segment and call `visit` for every
   * triangle hit within [0, maxDistance] whose flags intersect `mask` (and
   * whose owner is `owner`, when given). `reach()` bounds the walk: cells
   * starting beyond it are not visited.
   */
  private walk(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDistance: number,
    mask: number,
    owner: number | undefined,
    reach: () => number,
    visit: HitVisitor,
  ): void {
    const stamp = this.nextStamp();
    const tris = this.tris;
    let c = this.col(ox);
    let r = this.row(oz);
    const stepC = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepR = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const cell = this.cellSize;
    const nextX = this.minX + (stepC > 0 ? c + 1 : c) * cell;
    const nextZ = this.minZ + (stepR > 0 ? r + 1 : r) * cell;
    let tMaxX = stepC !== 0 ? (nextX - ox) / dx : Infinity;
    let tMaxZ = stepR !== 0 ? (nextZ - oz) / dz : Infinity;
    const tDeltaX = stepC !== 0 ? cell / Math.abs(dx) : Infinity;
    const tDeltaZ = stepR !== 0 ? cell / Math.abs(dz) : Infinity;
    // Points outside the grid clamp into the border cells; the border cells
    // are always visited, so rays starting outside still find geometry.
    let tCell = 0;
    for (let guard = 0; guard < this.cols + this.rows + 2; guard++) {
      const index = r * this.cols + c;
      for (let i = this.cellStart[index]; i < this.cellStart[index + 1]; i++) {
        const t = this.cellItems[i];
        if (this.stamp[t] === stamp) continue;
        this.stamp[t] = stamp;
        if ((this.flags[t] & mask) === 0) continue;
        if (owner !== undefined && this.owners[t] !== owner) continue;
        const o = t * 9;
        const e1x = tris[o + 3] - tris[o];
        const e1y = tris[o + 4] - tris[o + 1];
        const e1z = tris[o + 5] - tris[o + 2];
        const e2x = tris[o + 6] - tris[o];
        const e2y = tris[o + 7] - tris[o + 1];
        const e2z = tris[o + 8] - tris[o + 2];
        const px = dy * e2z - dz * e2y;
        const py = dz * e2x - dx * e2z;
        const pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const sx = ox - tris[o];
        const sy = oy - tris[o + 1];
        const sz = oz - tris[o + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y;
        const qy = sz * e1x - sx * e1z;
        const qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (dist < 0 || dist > maxDistance) continue;
        // det = -dir . ((v1 - v0) x (v2 - v0)): positive when the ray runs against the outward normal.
        visit(t, dist, det > 0);
      }
      const tNext = Math.min(tMaxX, tMaxZ);
      if (reach() < tNext || tCell > maxDistance || (stepC === 0 && stepR === 0)) break;
      if (tMaxX < tMaxZ) {
        c += stepC;
        tCell = tMaxX;
        tMaxX += tDeltaX;
      } else {
        r += stepR;
        tCell = tMaxZ;
        tMaxZ += tDeltaZ;
      }
      if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) break;
    }
  }

  private hitOf(t: number, distance: number, front: boolean, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): RayHit {
    const n = this.normalOf(t);
    if (front === false) {
      n[0] = -n[0];
      n[1] = -n[1];
      n[2] = -n[2];
    }
    const terrain = (this.flags[t] & TRI_TERRAIN) !== 0;
    return {
      distance,
      point: [ox + dx * distance, oy + dy * distance, oz + dz * distance],
      normal: n,
      triangle: t,
      front,
      material: terrain && !front ? -1 : this.materials[t],
      terrain,
      owner: this.owners[t],
    };
  }

  /** Map a body-local hit back to world space. */
  private static bodyHit(id: number, body: DynamicBody, hit: RayHit): RayHit {
    return {
      ...hit,
      point: transformPoint(body.matrix, hit.point[0], hit.point[1], hit.point[2]),
      normal: transformDirection(body.matrix, hit.normal[0], hit.normal[1], hit.normal[2]),
      triangle: -1 - id,
    };
  }

  /**
   * Nearest hit of the segment origin + dir * [0, maxDistance] on triangles
   * whose flags intersect `mask` (and, when `owner` is given, owned by that
   * placed instance), with the original's ordering (see the file comment).
   * `dir` must be unit length. Both sides of a face are hit. `skipBody`
   * leaves out one dynamic body (a vehicle's own rays, FUN_004c24c0's
   * self filter).
   */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDistance: number,
    mask = TRI_BULLET,
    owner?: number,
    skipBody?: number,
  ): RayHit | null {
    let object: RayHit | null = null;
    let objectDistance = Infinity;
    let objectFront = false;
    let objectTri = -1;
    let terrainDistance = Infinity;
    let terrainFront = false;
    let terrainTri = -1;
    this.walk(ox, oy, oz, dx, dy, dz, maxDistance, mask, owner,
      () => Math.min(objectDistance + HIT_TIE_WINDOW_M, terrainDistance),
      (t, dist, front) => {
        if ((this.flags[t] & TRI_TERRAIN) !== 0) {
          if (dist < terrainDistance) {
            terrainDistance = dist;
            terrainFront = front;
            terrainTri = t;
          }
          return;
        }
        const current = objectTri < 0 ? null : ({ distance: objectDistance, front: objectFront } as RayHit);
        if (objectHitReplaces(dist, front, current)) {
          objectDistance = dist;
          objectFront = front;
          objectTri = t;
        }
      });
    if (objectTri >= 0) object = this.hitOf(objectTri, objectDistance, objectFront, ox, oy, oz, dx, dy, dz);
    for (const [id, body] of this.bodies) {
      if (!body.enabled || id === skipBody) continue;
      const [lx, ly, lz] = transformPoint(body.inverse, ox, oy, oz);
      const [ldx, ldy, ldz] = transformDirection(body.inverse, dx, dy, dz);
      const reach = object ? Math.min(maxDistance, object.distance + HIT_TIE_WINDOW_M) : maxDistance;
      const hit = body.world.raycast(lx, ly, lz, ldx, ldy, ldz, reach, mask, owner);
      if (hit && !hit.terrain && objectHitReplaces(hit.distance, hit.front, object)) object = CollisionWorld.bodyHit(id, body, hit);
    }
    const terrain = terrainTri >= 0 ? this.hitOf(terrainTri, terrainDistance, terrainFront, ox, oy, oz, dx, dy, dz) : null;
    return combineHits(object, terrain);
  }

  /**
   * Every hit of the segment (static and dynamic bodies) on triangles whose
   * flags intersect `mask`, nearest first. Used by the AI sight test, which
   * multiplies the see-through of all front hits (FUN_004b9810).
   */
  raycastAll(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDistance: number,
    mask = TRI_SIGHT,
  ): RayHit[] {
    const out: RayHit[] = [];
    this.walk(ox, oy, oz, dx, dy, dz, maxDistance, mask, undefined, () => Infinity, (t, dist, front) => {
      out.push(this.hitOf(t, dist, front, ox, oy, oz, dx, dy, dz));
    });
    for (const [id, body] of this.bodies) {
      if (!body.enabled) continue;
      const [lx, ly, lz] = transformPoint(body.inverse, ox, oy, oz);
      const [ldx, ldy, ldz] = transformDirection(body.inverse, dx, dy, dz);
      for (const hit of body.world.raycastAll(lx, ly, lz, ldx, ldy, ldz, maxDistance, mask)) out.push(CollisionWorld.bodyHit(id, body, hit));
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
  }

  /** Contacts between a sphere and solid triangles (closest-point test). */
  sphereContacts(cx: number, cy: number, cz: number, radius: number, out: SphereContact[] = []): SphereContact[] {
    out.length = 0;
    const stamp = this.nextStamp();
    const tris = this.tris;
    const c0 = this.col(cx - radius);
    const c1 = this.col(cx + radius);
    const r0 = this.row(cz - radius);
    const r1 = this.row(cz + radius);
    const closest: [number, number, number] = [0, 0, 0];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const index = r * this.cols + c;
        for (let i = this.cellStart[index]; i < this.cellStart[index + 1]; i++) {
          const t = this.cellItems[i];
          if (this.stamp[t] === stamp) continue;
          this.stamp[t] = stamp;
          if ((this.flags[t] & TRI_SOLID) === 0) continue;
          const o = t * 9;
          // Cheap reject on the triangle's AABB.
          const minY = Math.min(tris[o + 1], tris[o + 4], tris[o + 7]);
          const maxY = Math.max(tris[o + 1], tris[o + 4], tris[o + 7]);
          if (cy + radius < minY || cy - radius > maxY) continue;
          closestPointOnTriangle(tris, o, cx, cy, cz, closest);
          const ex = cx - closest[0];
          const ey = cy - closest[1];
          const ez = cz - closest[2];
          const d2 = ex * ex + ey * ey + ez * ez;
          if (d2 >= radius * radius) continue;
          const d = Math.sqrt(d2);
          if (d > 1e-6) {
            out.push({ normal: [ex / d, ey / d, ez / d], depth: radius - d });
          } else {
            // Centre exactly on the plane: push along the face normal.
            const n = this.normalOf(t);
            out.push({ normal: n, depth: radius });
          }
        }
      }
    }
    for (const body of this.bodies.values()) {
      if (!body.enabled) continue;
      const [lx, ly, lz] = transformPoint(body.inverse, cx, cy, cz);
      body.world.sphereContacts(lx, ly, lz, radius, this.bodyContacts);
      for (const contact of this.bodyContacts) {
        out.push({ normal: transformDirection(body.matrix, contact.normal[0], contact.normal[1], contact.normal[2]), depth: contact.depth });
      }
    }
    return out;
  }
}

/** Closest point on triangle (tris[o..o+8]) to p (Ericson, RTCD 5.1.5). */
export function closestPointOnTriangle(
  tris: ArrayLike<number>,
  o: number,
  px: number, py: number, pz: number,
  out: [number, number, number],
): void {
  const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
  const bx = tris[o + 3], by = tris[o + 4], bz = tris[o + 5];
  const cx = tris[o + 6], cy = tris[o + 7], cz = tris[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) {
    out[0] = ax; out[1] = ay; out[2] = az;
    return;
  }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    out[0] = bx; out[1] = by; out[2] = bz;
    return;
  }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out[0] = ax + v * abx; out[1] = ay + v * aby; out[2] = az + v * abz;
    return;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    out[0] = cx; out[1] = cy; out[2] = cz;
    return;
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out[0] = ax + w * acx; out[1] = ay + w * acy; out[2] = az + w * acz;
    return;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    out[0] = bx + w * (cx - bx); out[1] = by + w * (cy - by); out[2] = bz + w * (cz - bz);
    return;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  out[0] = ax + abx * v + acx * w;
  out[1] = ay + aby * v + acy * w;
  out[2] = az + abz * v + acz * w;
}
