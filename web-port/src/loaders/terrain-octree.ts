/**
 * Runtime terrain: terrain.ctr (octree DAG) + terrain.cmd (cell meshes),
 * plus HeightMap detail relief from terrain.hmp.
 *
 * TypeScript port of tools/terrain_ctr.py; evidence in docs/terrain.md
 * (recovered from igi.exe and validated: 267/268 TerrainLightMap tiles spread
 * over ~57 km lie on the decoded surface within 1 cm; the level-1 base decodes
 * to exactly the buildings' z at all 441 probe points).
 *
 * All coordinates here are IGI world units (4096 = 1 m), z up, in float64.
 *
 *   ctr node (32 bytes): u16 A[8] child index | s8 B[8] child transform or -1
 *     (leaf) | u8 child mask | 3 unused | u32 byte offset into terrain.cmd.
 *     Node 1 is the root, centred on (0,0,0), half-size 2^30; a node at level
 *     L has half-size 2^(30-L). Octant i = x + 2y + 4z. Under accumulated
 *     transform t, octant i lives in slot PERM[t][i]; the child's transform is
 *     COMP[t][B[slot]]. Transform t: mirror x if t & 4, then rotate CCW by
 *     90 deg * (t & 3); z is never transformed.
 *   cmd record: u16 ntri, u16 triangle bytes (= 4 ntri), u16 nbase, u16 nextra,
 *     ntri x {u8 i0,i1,i2,flags}, then (nbase+nextra) u32 vertices with
 *     x = bits 26-31, y = 20-25, z = 14-19, each minus 24.
 *     world = node centre + xform(t, x, y, z) * 2^(27-L) / 3.
 *   Collision uses level 16 (8 m cells); rendering picks a level per cell
 *   every frame (selectCells, recovered FUN_004c6530) and geomorphs between
 *   levels in the vertex shader (engine/world/terrain-render.ts).
 *   HeightMap relief (FUN_00509250): for cells of level >= 14 whose centre
 *   lies in the level-`Level` node containing a HeightMap task, each vertex
 *   gets r = (bilinear(hmp grid, signed bytes) - 64) * 256, grid origin at
 *   that node's minimum corner, cell = node size / Size. Level >= 15 cells and
 *   every extra (morphing) vertex store z + r; level-14 base vertices store z
 *   and add (1 - lod) * r when drawn, so the relief fades in with the LOD.
 */
import { x87Div, x87Fistp, x87Mul, x87StoreF32 } from "./x87";

export const TERRAIN_ROOT_HALF = 2 ** 30;
export const TERRAIN_GAME_MAX_LEVEL = 16;
const MIN_EMIT_LEVEL = 7;

/**
 * Terrain LOD threshold base at GOGfxPerformance(0): FUN_00405e50 passes
 * 0xa3 (0x60 with performance flag 0x10, 0x81 with 0x20) to FUN_004c80f0,
 * which stores it at 0x5460d8 (static initial value 115) [recovered].
 */
export const TERRAIN_LOD_BASE = 0xa3;
/** Lowest threshold FUN_004c7590 allows [recovered 0x4c767e]. */
export const TERRAIN_LOD_MIN = 0x46;
/** Shallowest level the selection ever emits; coarser cells are dropped (the far-field limit) [recovered 0x4c6530]. */
export const TERRAIN_MIN_DRAW_LEVEL = MIN_EMIT_LEVEL;
/** Default z floor of the selection when the level has no water plane (terrain +0xdfc = null) [recovered 0x4c6544]. */
export const TERRAIN_NO_Z_FLOOR = -(2 ** 29);

/**
 * Per-frame LOD threshold T (DAT_00abc9ac, FUN_004c7590): `base` when the
 * camera's tan(hFOV/2) > 1, else trunc(base / sqrt(tanX)) (fild / pow(tanX,
 * 0.5) / fistp in chop mode), never below 70. Zooming in raises T, which keeps
 * finer levels further out [recovered].
 */
export function terrainLodThreshold(tanX: number, base = TERRAIN_LOD_BASE): number {
  const t = tanX <= 1 ? x87Fistp(x87Div(base, Math.sqrt(tanX))) : base;
  return Math.max(TERRAIN_LOD_MIN, t);
}

/**
 * Geomorph constants for threshold T (FUN_005090a0 / FUN_0050a740): a vertex
 * of a level-L cell at Chebyshev camera distance d (IGI units) has
 * lod = clamp((d * 0.375 / 2^(25 - L) - offset) * slope, 0, 1), with
 * offset = trunc((T + 64) * 0.375) and slope = float32(1 / (T - 64)) * 2.6666667
 * (0x532bb8 = 0.375 double, 0x532bb0 = 2.6666667 float) [recovered].
 * Level 1 (T = 163): offset 85, slope 0.026936; a level-16 vertex morphs from
 * 28.3 m (lod 0) to 40.7 m (lod 1).
 */
export function terrainMorphParams(threshold: number): { offset: number; slope: number } {
  const inv = x87StoreF32(x87Div(1, threshold - 64));
  return {
    offset: x87Fistp(x87Mul(threshold + 64, 0.375)),
    slope: x87StoreF32(x87Mul(inv, Math.fround(2.6666667461395264))),
  };
}

/** Per-vertex distance scale of a level-L cell: 0.375 / 2^(25 - L) per IGI unit [recovered 0x50c33c]. */
export function terrainLodScale(level: number): number {
  return 0.375 / 2 ** (25 - level);
}

/**
 * CPU reference of the draw-time geomorph (FUN_0050be70) [recovered]: base
 * vertex k gets lod_k = clamp((Chebyshev distance of its stored position to
 * the camera * terrainLodScale(level) - offset) * slope, 0, 1) and
 * z += (1 - lod_k) * relief_k; an extra vertex moves to its target's STORED
 * position by the target's lod: p = p + (target - p) * lod_target. Returns the
 * drawn positions and every vertex's lod (an extra vertex reports its
 * target's, which also sets its blend weights). The renderer evaluates the
 * same in its vertex shader (engine/world/terrain-render.ts).
 */
export function morphCellGeometry(
  g: TerrainCellGeometry,
  level: number,
  camera: readonly [number, number, number],
  morph: { offset: number; slope: number },
): { positions: Float64Array; lod: Float64Array } {
  const p = g.positions;
  const count = g.target.length;
  const scale = terrainLodScale(level);
  const lod = new Float64Array(count);
  const out = new Float64Array(p.length);
  for (let k = 0; k < g.nbase; k++) {
    const d = Math.max(Math.abs(p[k * 3] - camera[0]), Math.abs(p[k * 3 + 1] - camera[1]), Math.abs(p[k * 3 + 2] - camera[2]));
    lod[k] = Math.min(1, Math.max(0, (d * scale - morph.offset) * morph.slope));
    out[k * 3] = p[k * 3];
    out[k * 3 + 1] = p[k * 3 + 1];
    out[k * 3 + 2] = p[k * 3 + 2] + (1 - lod[k]) * g.relief[k];
  }
  for (let k = g.nbase; k < count; k++) {
    const t = g.target[k];
    lod[k] = lod[t];
    for (let c = 0; c < 3; c++) out[k * 3 + c] = p[k * 3 + c] + (p[t * 3 + c] - p[k * 3 + c]) * lod[t];
  }
  return { positions: out, lod };
}

/** Camera state for the per-frame cell selection (igi.exe FUN_004c7590 / FUN_004c6530). */
export interface TerrainView {
  /** Camera position, IGI units (the exe truncates it to integers). */
  position: readonly [number, number, number];
  /**
   * View rotation, row-major 3 x 3 in IGI axes; rows = camera right, down,
   * forward (igi.exe camera basis, DAT_00b70820). Omit to skip frustum culling.
   */
  rotation?: ArrayLike<number>;
  /** Frustum half-angle tangents of the culling test (DAT_00b70860 / DAT_00b70864). */
  tanX: number;
  tanY: number;
  /** LOD threshold T (terrainLodThreshold). */
  threshold: number;
  /** Cells whose top is below this z are skipped (water plane; default TERRAIN_NO_Z_FLOOR). */
  zFloor?: number;
}

/** One cell's render geometry (FUN_00509250): stored positions plus the morph data the draw applies. */
export interface TerrainCellGeometry {
  /** xyz per vertex, IGI units: base vertices first (nbase), then extra vertices. */
  positions: Float64Array;
  /** Per vertex: relief added as (1 - lod) * relief when drawn (level-14 base vertices), else 0. */
  relief: Float64Array;
  /** Per vertex: the base vertex an extra vertex morphs to (bits 0-5); a base vertex's own index. */
  target: Uint8Array;
  nbase: number;
  /** Raw u32 vertex words (texture projection bits 6-9). */
  words: Uint32Array;
  /** Triangle vertex indices, counter-clockwise seen from +z (mirrored transforms reordered). */
  triangles: Uint8Array;
}

/** igi.exe 0x545e48: slot holding physical octant i under transform t. */
const PERM = [
  [0, 1, 2, 3, 4, 5, 6, 7],
  [2, 0, 3, 1, 6, 4, 7, 5],
  [3, 2, 1, 0, 7, 6, 5, 4],
  [1, 3, 0, 2, 5, 7, 4, 6],
  [1, 0, 3, 2, 5, 4, 7, 6],
  [3, 1, 2, 0, 7, 5, 6, 4],
  [2, 3, 0, 1, 6, 7, 4, 5],
  [0, 2, 1, 3, 4, 6, 5, 7],
];

/** Transform composition, built exactly like igi.exe FUN_004c5f40 (0xab8920). */
const COMP: number[][] = (() => {
  const table: number[][] = [];
  for (let row = 0; row < 8; row++) {
    const out: number[] = [];
    for (let j = 0; j < 8; j++) {
      let b3 = j;
      let b6 = j;
      if (row >= 4) {
        b3 = -j & 0xff;
        b6 = ~j & 0xff;
      }
      out.push(((b3 + row) & 3) + (b6 & 4));
    }
    table.push(out);
  }
  return table;
})();

function xform(t: number, x: number, y: number): [number, number] {
  if (t & 4) x = -x;
  switch (t & 3) {
    case 0:
      return [x, y];
    case 1:
      return [-y, x];
    case 2:
      return [-x, -y];
    default:
      return [y, -x];
  }
}

export interface HeightMapTask {
  position: [number, number, number];
  level: number;
  size: number;
  bitmapId: number;
}

interface ReliefRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cell: number;
  stride: number;
  data: Int8Array;
}

interface CellRecord {
  /** Local integer coordinates, xyz per vertex. */
  verts: Int8Array;
  /** Raw u32 vertex words (texture projection bits 6-9, morph target bits 0-5). */
  words: Uint32Array;
  /** Triangle vertex indices (i0, i1, i2) as stored. */
  tris: Uint8Array;
  /** Number of base vertices (the rest are extra vertices that morph to a base vertex). */
  nbase: number;
}

export interface TerrainCell {
  node: number;
  level: number;
  cx: number;
  cy: number;
  cz: number;
  t: number;
}

export interface TerrainMesh {
  /** xyz per vertex, IGI world units (float64). */
  positions: Float64Array;
  /** Counter-clockwise seen from +z for upward faces. */
  indices: Uint32Array;
  cells: number;
}

function fail(message: string): never {
  throw new Error(`terrain: ${message}`);
}

export class TerrainOctree {
  private readonly child: Uint16Array;
  private readonly trans: Int8Array;
  private readonly mask: Uint8Array;
  private readonly rec: Uint32Array;
  private readonly cmd: DataView;
  private readonly records = new Map<number, CellRecord>();
  private readonly regions: ReliefRegion[] = [];
  readonly nodeCount: number;

  constructor(ctr: ArrayBuffer, cmd: ArrayBuffer, hmp?: ArrayBuffer, heightMaps: HeightMapTask[] = []) {
    if (ctr.byteLength % 32 !== 0 || ctr.byteLength < 64) fail("terrain.ctr size is not a multiple of 32");
    const view = new DataView(ctr);
    const n = ctr.byteLength / 32;
    this.nodeCount = n;
    this.child = new Uint16Array(n * 8);
    this.trans = new Int8Array(n * 8);
    this.mask = new Uint8Array(n);
    this.rec = new Uint32Array(n);
    this.cmd = new DataView(cmd);
    for (let i = 0; i < n; i++) {
      const o = i * 32;
      for (let s = 0; s < 8; s++) {
        this.child[i * 8 + s] = view.getUint16(o + s * 2, true);
        this.trans[i * 8 + s] = view.getInt8(o + 16 + s);
      }
      this.mask[i] = view.getUint8(o + 24);
      this.rec[i] = view.getUint32(o + 28, true);
      for (let s = 0; s < 8; s++) {
        const has = (this.mask[i] >> s) & 1;
        if (has && (this.trans[i * 8 + s] < 0 || this.child[i * 8 + s] >= n)) {
          fail(`node ${i} slot ${s} has an invalid child`);
        }
      }
    }
    if (hmp && heightMaps.length) this.setupRelief(hmp, heightMaps);
  }

  private setupRelief(hmp: ArrayBuffer, tasks: HeightMapTask[]): void {
    const view = new DataView(hmp);
    if (hmp.byteLength < 0xc00) fail("terrain.hmp shorter than its 256-entry header");
    const bodies = new Map<number, { data: Int8Array; side: number }>();
    let p = 0xc00;
    for (let i = 0; i < 256; i++) {
      const side = view.getUint32(i * 12 + 8, true);
      if (!side) continue;
      const bytes = (side + 1) * (side + 1);
      if (p + bytes > hmp.byteLength) fail(`terrain.hmp grid ${i} overruns the file`);
      bodies.set(i, { data: new Int8Array(hmp, p, bytes), side });
      p += bytes;
    }
    if (p !== hmp.byteLength) fail("terrain.hmp grids do not end at EOF");
    for (const task of tasks) {
      const body = bodies.get(task.bitmapId);
      if (!body) continue; // the game skips a HeightMap whose bitmap is absent
      if (body.side !== task.size) fail(`HeightMap size ${task.size} != hmp side ${body.side}`);
      const full = 2 * (TERRAIN_ROOT_HALF / 2 ** task.level);
      const x0 = Math.floor(task.position[0] / full) * full;
      const y0 = Math.floor(task.position[1] / full) * full;
      this.regions.push({
        x0,
        y0,
        x1: x0 + full,
        y1: y0 + full,
        cell: full / task.size,
        stride: task.size + 1,
        data: body.data,
      });
    }
  }

  private relief(region: ReliefRegion, x: number, y: number): number {
    const gx = (x - region.x0) / region.cell;
    const gy = (y - region.y0) / region.cell;
    const ix = Math.trunc(gx); // x87 chop mode
    const iy = Math.trunc(gy);
    const fx = gx - ix;
    const fy = gy - iy;
    const at = (k: number) => (k >= 0 && k < region.data.length ? region.data[k] : 64);
    const s00 = at(iy * region.stride + ix);
    const s01 = at(iy * region.stride + ix + 1);
    const s10 = at((iy + 1) * region.stride + ix);
    const s11 = at((iy + 1) * region.stride + ix + 1);
    const top = s00 + (s01 - s00) * fx;
    const bottom = s10 + (s11 - s10) * fx;
    return (top + (bottom - top) * fy - 64) * 256;
  }

  private regionFor(x: number, y: number): ReliefRegion | null {
    for (const r of this.regions) if (x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) return r;
    return null;
  }

  private record(offset: number): CellRecord {
    let r = this.records.get(offset);
    if (!r) {
      const cmd = this.cmd;
      if (offset + 8 > cmd.byteLength) fail(`cmd record offset ${offset} outside file`);
      const ntri = cmd.getUint16(offset, true);
      const triBytes = cmd.getUint16(offset + 2, true);
      const count = cmd.getUint16(offset + 4, true) + cmd.getUint16(offset + 6, true);
      const triAt = offset + 8;
      const vertAt = triAt + triBytes;
      if (triBytes !== ntri * 4 || vertAt + count * 4 > cmd.byteLength) fail(`malformed cmd record at ${offset}`);
      const verts = new Int8Array(count * 3);
      const words = new Uint32Array(count);
      for (let k = 0; k < count; k++) {
        const v = cmd.getUint32(vertAt + k * 4, true);
        words[k] = v;
        verts[k * 3] = ((v >>> 26) & 63) - 24;
        verts[k * 3 + 1] = ((v >>> 20) & 63) - 24;
        verts[k * 3 + 2] = ((v >>> 14) & 63) - 24;
      }
      const tris = new Uint8Array(ntri * 3);
      for (let k = 0; k < ntri; k++) {
        for (let j = 0; j < 3; j++) {
          const index = cmd.getUint8(triAt + k * 4 + j);
          if (index >= count) fail(`cmd record ${offset} triangle index out of range`);
          tris[k * 3 + j] = index;
        }
      }
      const nbase = cmd.getUint16(offset + 4, true);
      for (let k = nbase; k < count; k++) {
        if ((words[k] & 63) >= nbase) fail(`cmd record ${offset} extra vertex ${k} morphs to a non-base vertex`);
      }
      r = { verts, words, tris, nbase };
      this.records.set(offset, r);
    }
    return r;
  }

  /** Raw u32 vertex words of a node's cell record (same order as cellMesh vertices). */
  cellVertexWords(node: number): Uint32Array {
    return this.record(this.rec[node]).words;
  }

  /**
   * Render geometry of one cell as FUN_00509250 builds it: positions as
   * stored (HeightMap relief included for level >= 15 and for every extra
   * vertex; level-14 base vertices keep it separately in `relief`), the morph
   * target of every vertex and the triangles.
   */
  cellGeometry(cell: TerrainCell): TerrainCellGeometry {
    const { verts, tris, words, nbase } = this.record(this.rec[cell.node]);
    const scale = 2 ** (27 - cell.level) / 3;
    const count = verts.length / 3;
    const positions = new Float64Array(count * 3);
    const relief = new Float64Array(count);
    const target = new Uint8Array(count);
    // local_c20 = 0 below level 14 [recovered 0x509181].
    const region = this.regions.length && cell.level >= 14 ? this.regionFor(cell.cx, cell.cy) : null;
    for (let k = 0; k < count; k++) {
      const [x, y] = xform(cell.t, verts[k * 3], verts[k * 3 + 1]);
      const wx = cell.cx + x * scale;
      const wy = cell.cy + y * scale;
      let wz = cell.cz + verts[k * 3 + 2] * scale;
      if (region) {
        const r = this.relief(region, wx, wy);
        if (k < nbase && cell.level === 14) relief[k] = r;
        else wz += r;
      }
      positions[k * 3] = wx;
      positions[k * 3 + 1] = wy;
      positions[k * 3 + 2] = wz;
      target[k] = k < nbase ? k : words[k] & 63;
    }
    return { positions, relief, target, nbase, words, triangles: this.windTriangles(cell, tris) };
  }

  /** World-space vertices (xyz) and triangles of one cell at full detail (lod 0). */
  cellMesh(cell: TerrainCell): { positions: Float64Array; triangles: Uint8Array } {
    const g = this.cellGeometry(cell);
    for (let k = 0; k < g.relief.length; k++) g.positions[k * 3 + 2] += g.relief[k];
    return { positions: g.positions, triangles: g.triangles };
  }

  private windTriangles(cell: TerrainCell, tris: Uint8Array): Uint8Array {
    let triangles = tris;
    if (cell.t & 4) {
      // Mirrored transform: swap two indices to keep CCW seen from above.
      triangles = new Uint8Array(tris.length);
      for (let k = 0; k < tris.length; k += 3) {
        triangles[k] = tris[k];
        triangles[k + 1] = tris[k + 2];
        triangles[k + 2] = tris[k + 1];
      }
    }
    return triangles;
  }

  /**
   * The cells igi.exe draws this frame (FUN_004c6530, called by FUN_004c7590
   * with T = DAT_00abc9ac) [recovered]. Depth-first from the root; for each
   * existing child (octant i in slot PERM[t][i]) at level L, half-size
   * h = 2^(30 - L), centre c, integer camera p = trunc(camera):
   *   - frustum: v = R (c - p) must satisfy v.z > 64 - ry, |v.x| < v.z tanX + rx,
   *     |v.y| < v.z tanY + ry with rx = 1.7321 h / cos(atan tanX) (the
   *     bounding sphere pushed out along each side plane), ry likewise;
   *   - the cube top c.z + h must reach the z floor (water plane);
   *   - m = (max(|c - p|) - h) >> (25 - L), i.e. 32 (Chebyshev distance / h - 1);
   *   - m >= T or L = 16: draw the child if L >= 7 (coarser cells are dropped:
   *     this is the far-field limit), else descend into it.
   * At T = 163 a level-L node is refined while its centre is within
   * 2^(25-L) (32 + T) units: level 16 cells appear within ~49 m (level-15
   * node centre), level 7 cells out to ~25 km (level-6 node centre).
   * Leaf slots (no child node) draw nothing. The order is depth-first.
   */
  selectCells(view: TerrainView, out: TerrainCell[] = []): TerrainCell[] {
    const px = x87Fistp(view.position[0]);
    const py = x87Fistp(view.position[1]);
    const pz = x87Fistp(view.position[2]);
    const T = view.threshold;
    const zFloor = view.zFloor ?? TERRAIN_NO_Z_FLOOR;
    const R = view.rotation;
    // 0x532af0 = 1.7321 (float), 0x532aec = 2^30; fdivr by cos(atan(tan)).
    const SQRT3 = Math.fround(1.732100009918213);
    const rx0 = (SQRT3 / Math.cos(Math.atan(view.tanX))) * 2 ** 30;
    const ry0 = (SQRT3 / Math.cos(Math.atan(view.tanY))) * 2 ** 30;
    const { mask, child, trans } = this;
    const visit = (node: number, level: number, cx: number, cy: number, cz: number, t: number): void => {
      const cl = level + 1;
      const h = TERRAIN_ROOT_HALF / 2 ** cl;
      const rx = rx0 / 2 ** cl;
      const ry = ry0 / 2 ** cl;
      const shift = 2 ** (25 - cl);
      const perm = PERM[t];
      const m8 = mask[node];
      for (let i = 0; i < 8; i++) {
        const s = perm[i];
        if (!((m8 >> s) & 1)) continue;
        const ccx = i & 1 ? cx + h : cx - h;
        const ccy = i & 2 ? cy + h : cy - h;
        const ccz = i & 4 ? cz + h : cz - h;
        const dx = ccx - px;
        const dy = ccy - py;
        const dz = ccz - pz;
        if (R) {
          const vz = R[6] * dx + R[7] * dy + R[8] * dz;
          if (!(64 - ry < vz)) continue;
          const vx = R[0] * dx + R[1] * dy + R[2] * dz;
          const bx = vz * view.tanX + rx;
          if (!(vx < bx && -bx < vx)) continue;
          const vy = R[3] * dx + R[4] * dy + R[5] * dz;
          const by = vz * view.tanY + ry;
          if (!(vy < by && -by < vy)) continue;
        }
        if (ccz + h < zFloor) continue;
        const m = Math.floor((Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) - h) / shift);
        const childNode = child[node * 8 + s];
        const ct = COMP[t][trans[node * 8 + s]];
        if (m >= T || cl >= TERRAIN_GAME_MAX_LEVEL) {
          if (cl >= MIN_EMIT_LEVEL) out.push({ node: childNode, level: cl, cx: ccx, cy: ccy, cz: ccz, t: ct });
        } else {
          visit(childNode, cl, ccx, ccy, ccz, ct);
        }
      }
    };
    visit(1, 0, 0, 0, 0, 0);
    return out;
  }

  private *children(cell: TerrainCell): Generator<TerrainCell> {
    const h = TERRAIN_ROOT_HALF / 2 ** (cell.level + 1);
    const base = cell.node * 8;
    const perm = PERM[cell.t];
    for (let i = 0; i < 8; i++) {
      const s = perm[i];
      if (!((this.mask[cell.node] >> s) & 1)) continue;
      yield {
        node: this.child[base + s],
        level: cell.level + 1,
        cx: i & 1 ? cell.cx + h : cell.cx - h,
        cy: i & 2 ? cell.cy + h : cell.cy - h,
        cz: i & 4 ? cell.cz + h : cell.cz - h,
        t: COMP[cell.t][this.trans[base + s]],
      };
    }
  }

  /**
   * Cells to emit: `maxLevel` detail for cells touching bbox [x0,y0,x1,y1];
   * when farExtent > 0, coarser cells (>= level 7) once their distance from
   * the bbox reaches lodFactor cell sizes, up to farExtent away.
   */
  *cells(bbox: [number, number, number, number], maxLevel = TERRAIN_GAME_MAX_LEVEL, farExtent = 0, lodFactor = 3): Generator<TerrainCell> {
    const [bx0, by0, bx1, by1] = bbox;
    const stack: TerrainCell[] = [{ node: 1, level: 0, cx: 0, cy: 0, cz: 0, t: 0 }];
    while (stack.length) {
      const cell = stack.pop()!;
      const h = TERRAIN_ROOT_HALF / 2 ** cell.level;
      const dx = Math.max(bx0 - (cell.cx + h), cell.cx - h - bx1, 0);
      const dy = Math.max(by0 - (cell.cy + h), cell.cy - h - by1, 0);
      const d = Math.max(dx, dy);
      if (d > 0 && (farExtent <= 0 || d > farExtent)) continue;
      if (cell.level >= maxLevel || this.mask[cell.node] === 0) {
        yield cell;
        continue;
      }
      if (d > 0 && cell.level >= MIN_EMIT_LEVEL && d >= lodFactor * 2 * h) {
        yield cell;
        continue;
      }
      for (const c of this.children(cell)) stack.push(c);
    }
  }

  /** The far-field LOD ring: cells() minus those touching bbox. */
  *ringCells(bbox: [number, number, number, number], maxLevel = TERRAIN_GAME_MAX_LEVEL, farExtent = 0, lodFactor = 3): Generator<TerrainCell> {
    const [bx0, by0, bx1, by1] = bbox;
    for (const cell of this.cells(bbox, maxLevel, farExtent, lodFactor)) {
      const h = TERRAIN_ROOT_HALF / 2 ** cell.level;
      // Same "distance == 0" test cells() uses for the full-detail region.
      if (cell.cx + h >= bx0 && cell.cx - h <= bx1 && cell.cy + h >= by0 && cell.cy - h <= by1) continue;
      yield cell;
    }
  }

  /**
   * Build an indexed mesh (shared vertices merged) for the given region.
   * `ringOnly` keeps only the cells outside bbox (the far-field LOD ring).
   */
  mesh(
    bbox: [number, number, number, number],
    maxLevel = TERRAIN_GAME_MAX_LEVEL,
    farExtent = 0,
    lodFactor = 3,
    ringOnly = false,
  ): TerrainMesh {
    const ids = new Map<string, number>();
    const positions: number[] = [];
    const indices: number[] = [];
    let cells = 0;
    const [bx0, by0, bx1, by1] = bbox;
    for (const cell of this.cells(bbox, maxLevel, farExtent, lodFactor)) {
      if (ringOnly) {
        const h = TERRAIN_ROOT_HALF / 2 ** cell.level;
        // Same "distance == 0" test cells() uses for the full-detail region.
        const touches = cell.cx + h >= bx0 && cell.cx - h <= bx1 && cell.cy + h >= by0 && cell.cy - h <= by1;
        if (touches) continue;
      }
      cells++;
      const m = this.cellMesh(cell);
      const local: number[] = [];
      for (let k = 0; k < m.positions.length; k += 3) {
        const key = `${Math.round(m.positions[k] * 1024)},${Math.round(m.positions[k + 1] * 1024)},${Math.round(m.positions[k + 2] * 1024)}`;
        let id = ids.get(key);
        if (id === undefined) {
          id = positions.length / 3;
          ids.set(key, id);
          positions.push(m.positions[k], m.positions[k + 1], m.positions[k + 2]);
        }
        local.push(id);
      }
      for (let k = 0; k < m.triangles.length; k += 3) {
        const a = local[m.triangles[k]];
        const b = local[m.triangles[k + 1]];
        const c = local[m.triangles[k + 2]];
        if (a !== b && b !== c && a !== c) indices.push(a, b, c);
      }
    }
    return { positions: Float64Array.from(positions), indices: Uint32Array.from(indices), cells };
  }

  /** Every terrain surface height crossing the vertical line at (x, y), sorted ascending. */
  heightsAt(x: number, y: number, maxLevel = TERRAIN_GAME_MAX_LEVEL): number[] {
    const found: number[] = [];
    const stack: TerrainCell[] = [{ node: 1, level: 0, cx: 0, cy: 0, cz: 0, t: 0 }];
    while (stack.length) {
      const cell = stack.pop()!;
      if (cell.level >= maxLevel || this.mask[cell.node] === 0) {
        const m = this.cellMesh(cell);
        const p = m.positions;
        for (let k = 0; k < m.triangles.length; k += 3) {
          const i = m.triangles[k] * 3;
          const j = m.triangles[k + 1] * 3;
          const l = m.triangles[k + 2] * 3;
          const d = (p[j + 1] - p[l + 1]) * (p[i] - p[l]) + (p[l] - p[j]) * (p[i + 1] - p[l + 1]);
          if (d === 0) continue;
          const l1 = ((p[j + 1] - p[l + 1]) * (x - p[l]) + (p[l] - p[j]) * (y - p[l + 1])) / d;
          const l2 = ((p[l + 1] - p[i + 1]) * (x - p[l]) + (p[i] - p[l]) * (y - p[l + 1])) / d;
          const l3 = 1 - l1 - l2;
          if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) found.push(l1 * p[i + 2] + l2 * p[j + 2] + l3 * p[l + 2]);
        }
        continue;
      }
      for (const c of this.children(cell)) {
        if (x >= cell.cx === c.cx > cell.cx && y >= cell.cy === c.cy > cell.cy) stack.push(c);
      }
    }
    found.sort((a, b) => a - b);
    const out: number[] = [];
    for (const z of found) if (!out.length || Math.abs(z - out[out.length - 1]) > 1e-3) out.push(z);
    return out;
  }
}
