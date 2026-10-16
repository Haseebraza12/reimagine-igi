/**
 * Rain and snow around the camera: the world object "Rain" that a RainEffect
 * task creates (loaders/objects/rain-effect.ts) [recovered, full exe: class
 * FUN_00498ab0 = FUN_00401900("Rain", 0x56d0, ...), create FUN_00498960,
 * colour FUN_00499fa0, active FUN_00499f90, particle step FUN_00499cf0, draw
 * (method 4) FUN_00498b80 -> floor trace FUN_00498bd0, then FUN_00498f10:
 * vertex fill FUN_00499090, cull FUN_00499910, per-cell draw FUN_00499430
 * through the depth-sorted deferred list FUN_004b72e0]:
 *
 *   Particles (one tile of C x C x H, C = 10895.36 units = 2.66 m (0x5342d0),
 *   H = 24576 = 6 m (0x5342a0)), stepped by the task update:
 *   - speed 2048 units / tick (rain, 15 m/s) or f32 204.8 (snow, 1.5 m/s);
 *     fade += 1/60 (0x5334c0) while active, -= 1/60 otherwise, in [0, 1];
 *     at fade 0 nothing moves;
 *   - each drop (7 floats: x, y, z, timer, vx, vy, group): z -= speed, below
 *     0 it wraps up by H; snow only: timer -= 1 and when the old timer was
 *     < 0: timer += rand(30) + 30, vx = (r - 0.5) x 136.53334, vy likewise
 *     (0x5342d4: +-0.5 m/s drift); x += vx, y += vy, leaving [0, C] wraps by C
 *     and flips group bit 1 (x) / 2 (y);
 *   - acc += speed; while acc > 307.2 (0x5342cc) and fewer than 80 drops: a
 *     new drop x = r C, y = r C, z = H - speed, timer 0, group = rand(4);
 *     acc -= 307.2 (rain: 80 drops after 12 ticks, snow after 120);
 *   - its own generator DAT_00c311d0 (FUN_004b4720 initial state at the
 *     class registration, never reseeded; FUN_004b4770 / FUN_004b47c0 = the
 *     level generator's float / int draws): one per session here.
 *   Draw (main render pass only, fade != 0; at fade 0 the next draw re-traces
 *   everything):
 *   - floor trace: a 12 x 12 ring of columns at multiples of C from
 *     ix0 = floor(camX / C - 5) (iy0 likewise); a column whose stored (x, y)
 *     differs from the one its ring slot needs is traced when the budget
 *     allows: a vertical ray from (x, y, camZ + Traceline start) down by
 *     start + end (FUN_004cb9f0 flags 0xc8000000: terrain and objects,
 *     DiscardTerrain vetoes included), the hit z is the column floor; budget
 *     10000 on the first draw, else ceil(|dX| / C x 12) + ceil(|dY| / C x 12)
 *     for the camera move since the last draw. A column keeps its floor while
 *     it stays in the ring (moving objects and vertical moves are ignored);
 *   - vertex fill: from the highest drop (searched among drops 0..n-2: the
 *     last drop is never compared, 0x4990da) backwards cyclically, each drop
 *     goes to its group's section; the group's z list records the z of the
 *     NEXT drop in that order (0x4992d5 reads it after the decrement);
 *     rain: a line from (x, y, z + fade x 2048) colour 0x00FFFFFF to (x, y, z)
 *     in the rain colour (alpha = trunc(Rain Alpha x 255), not faded); snow:
 *     two triangles, a camera-facing square of half-size fade x 81.92 units
 *     (0x5342b8), white, uv (0,0) (1,0) (0,1) (1,1);
 *   - cull: bandBase = floor(camZ / H - 1) x H; the 10 x 10 columns from
 *     (ix0 + 1, iy0 + 1) get frustum outcodes of (x, y, bandBase) and
 *     (x, y, bandBase + 3H) (a bit stays when both points are outside: 1 left,
 *     2 top, 4 right, 8 bottom, 0x10 behind; 0x20 = traced) and a depth key
 *     (mean view depth of the two); a cell of the 9 x 9 (corners (i, j) ..
 *     (i + 1, j + 1)) is queued when the AND of its corners is 0x20, keyed by
 *     the largest corner key;
 *   - per cell: group = (floor(y / C) & 1) << 1 | (floor(x / C) & 1) of its
 *     (i, j) corner, floorMax = the largest corner floor; layers k = 2, 1, 0:
 *     t = f32(floorMax - bandBase - 3H) + (3 - k) H; all the group's drops when
 *     t < 0, none when t > H, else the leading drops whose listed z is > t;
 *     drawn at (corner x, corner y, bandBase + k H): rain shows only above the
 *     highest floor of the column (roofs stop it), up to bandBase + 18 m.
 *   - states: alpha blend SRCALPHA / INVSRCALPHA, fog off, Z test LESS, no Z
 *     write, no culling, no lighting; rain = diffuse only (no texture), snow =
 *     snow.tex x diffuse, MAG LINEAR / MIN POINT.
 * Port: the cells are drawn back to front (largest key first) in one mesh
 * that the transparent pass draws after the other deferred objects
 * [approximation: igi.exe sorts each cell into the one deferred list].
 */
import * as THREE from "three";
import type { DecodedTexture, Vec3 } from "../../contracts";
import { x87F32Add, x87F32Sub, x87Fistp, x87StoreF32 } from "../../loaders/x87";
import { LevelRng } from "../ai/rng";

/** Constants of the Rain object (addresses in the file comment). */
export const RAIN = {
  /** Tile C (f32 0x5342d0; the trace uses the double 0x534288 of the same value). */
  tile: Math.fround(10895.3603515625),
  /** 1 / C as a double (0x534290) and as a float (0x534280, the budget). */
  invTile: 0.00009178218688807207,
  invTileF32: Math.fround(0.00009178218897432089),
  /** 5.5 C (double 0x534298): the ring origin offset. */
  ringOffset: 59924.48193359375,
  /** 12 C (double 0x534278). */
  ringSpan: 130744.32421875,
  /** H (0x5342a0), 1 / H (double 0x5342a8), 1.5 H (double 0x5342b0), 3 H (0x5342c0 / 0x5342c8). */
  height: 24576,
  invHeight: 0.000040690104166666664,
  bandOffset: 36864,
  bandSpan: 73728,
  maxDrops: 80,
  spawnStep: Math.fround(307.20001220703125),
  rainSpeed: 2048,
  snowSpeed: Math.fround(204.8000030517578),
  fadeStep: Math.fround(0.01666666753590107),
  drift: Math.fround(136.53334045410156),
  /** Rain streak length at full fade (0x533688) and snow flake half-size (0x5342b8), units. */
  streak: 2048,
  flake: Math.fround(81.91999816894531),
  ring: 12,
  /** Sampled columns (10 x 10) and drawn cells (9 x 9) of the window. */
  window: 10,
  cells: 9,
  firstBudget: 10000,
  /** Alpha factor of the colour (-255, 0x5342d8). */
  alphaScale: -255,
} as const;

const FLOATS_PER_DROP = 7;

/** The Rain object's generator DAT_00c311d0: FUN_004b4720's state, set once at the class registration. */
const SESSION_RNG = new LevelRng(0);
export function rainSessionRng(): LevelRng {
  return SESSION_RNG;
}

/** FUN_00499fa0: ARGB colour = trunc(alpha x -255) x -0x1000000 + 0xFFFFFF (chop mode). */
export function rainColour(alpha: number): number {
  const n = x87Fistp(Math.fround(alpha) * RAIN.alphaScale);
  return (Math.imul(n, -0x1000000) + 0xffffff) >>> 0;
}

/** The particle state of one Rain object (FUN_00498960 create, FUN_00499cf0 step). */
export class RainSim {
  /** +0x5650: snow (Is Rain == 0). */
  readonly snow: boolean;
  /** +0x56ac: active byte (RainEffect's Is Active). */
  active = 0;
  /** +0x56a8. */
  fade = 0;
  /** +0x564c. */
  acc = 0;
  /** +0xe3c. */
  count = 0;
  /** +0x57c: x, y, z, timer, vx, vy, group per drop. */
  readonly drops = new Float32Array(RAIN.maxDrops * FLOATS_PER_DROP);
  /** +0x56c8 (ARGB). */
  colour: number;
  /** Traceline start (+0x56a0) and length start + end (+0x5698), units. */
  readonly traceStart: number;
  readonly traceLength: number;

  constructor(o: { snow: boolean; alpha: number; traceStartM: number; traceEndM: number }) {
    this.snow = o.snow;
    this.colour = rainColour(o.alpha);
    // FUN_00436a50: start x 4096.0f and end x 4096.0f (float), then (double)p4 and (double)(p4 + p5).
    const start = x87StoreF32(o.traceStartM * 4096);
    const end = x87StoreF32(o.traceEndM * 4096);
    this.traceStart = start;
    this.traceLength = x87StoreF32(start + end);
  }

  /** The speed of this object, units per tick. */
  get speed(): number {
    return this.snow ? RAIN.snowSpeed : RAIN.rainSpeed;
  }

  /** FUN_00499cf0: one task update. */
  step(rng: LevelRng = SESSION_RNG): void {
    const speed = this.speed;
    if (this.active) {
      const f = x87F32Add(this.fade, RAIN.fadeStep);
      this.fade = f >= 1 ? 1 : f;
    } else {
      const f = x87F32Sub(this.fade, RAIN.fadeStep);
      this.fade = f <= 0 ? 0 : f;
    }
    if (this.fade === 0) return;
    const d = this.drops;
    const C = RAIN.tile;
    for (let i = 0; i < this.count; i++) {
      const o = i * FLOATS_PER_DROP;
      const z = x87F32Sub(d[o + 2], speed);
      d[o + 2] = z < 0 ? x87F32Add(z, RAIN.height) : z;
      if (!this.snow) continue;
      const timer = x87Fistp(d[o + 3]);
      d[o + 3] = timer - 1;
      if (timer < 0) {
        d[o + 3] = x87Fistp(d[o + 3]) + rng.int(30) + 30;
        d[o + 4] = x87StoreF32((rng.float() - 0.5) * RAIN.drift);
        d[o + 5] = x87StoreF32((rng.float() - 0.5) * RAIN.drift);
      }
      d[o] = x87F32Add(d[o + 4], d[o]);
      d[o + 1] = x87F32Add(d[o + 5], d[o + 1]);
      if (d[o] < 0) {
        d[o] = x87F32Add(d[o], C);
        d[o + 6] = x87Fistp(d[o + 6]) ^ 1;
      } else if (C < d[o]) {
        d[o] = x87F32Sub(d[o], C);
        d[o + 6] = x87Fistp(d[o + 6]) ^ 1;
      }
      if (d[o + 1] < 0) {
        d[o + 1] = x87F32Add(d[o + 1], C);
        d[o + 6] = x87Fistp(d[o + 6]) ^ 2;
      } else if (C < d[o + 1]) {
        d[o + 1] = x87F32Sub(d[o + 1], C);
        d[o + 6] = x87Fistp(d[o + 6]) ^ 2;
      }
    }
    this.acc = x87F32Add(speed, this.acc);
    while (RAIN.spawnStep < this.acc) {
      if (this.count === RAIN.maxDrops) return;
      const o = this.count * FLOATS_PER_DROP;
      d[o] = x87StoreF32(rng.float() * C);
      d[o + 3] = 0;
      d[o + 1] = x87StoreF32(rng.float() * C);
      d[o + 2] = x87F32Sub(RAIN.height, speed);
      d[o + 6] = rng.int(4);
      this.count += 1;
      this.acc = x87F32Sub(this.acc, RAIN.spawnStep);
    }
  }
}

/** One group's section of the vertex buffer (FUN_00499090): drop indices in fill order and the listed z values. */
export interface RainGroup {
  drops: number[];
  /** +0x6c + g x 0x144 list: the z of the drop after each one in the fill order. */
  z: number[];
}

/** FUN_00499090's ordering: per group, the drops from the highest one backwards (cyclic) and their z list. */
export function rainGroups(sim: Pick<RainSim, "drops" | "count">): RainGroup[] {
  const groups: RainGroup[] = [0, 1, 2, 3].map(() => ({ drops: [], z: [] }));
  const n = sim.count;
  if (n === 0) return groups;
  const d = sim.drops;
  let start = 0;
  // 0x4990d7: n - 1 comparisons starting at drop 0 (the last drop never takes part), strict >.
  for (let i = 0; i < n - 1; i++) if (d[i * FLOATS_PER_DROP + 2] > d[start * FLOATS_PER_DROP + 2]) start = i;
  let k = start;
  for (let j = 0; j < n; j++) {
    const g = x87Fistp(d[k * FLOATS_PER_DROP + 6]) & 3;
    groups[g].drops.push(k);
    k = k - 1 < 0 ? n - 1 : k - 1;
    groups[g].z.push(d[k * FLOATS_PER_DROP + 2]);
  }
  return groups;
}

/** FUN_00499430's drop count for one layer: t = floorMax - layer bottom (f32). */
export function rainLayerCount(group: RainGroup, t: number): number {
  if (t < 0) return group.drops.length;
  if (t > RAIN.height) return 0;
  let n = 0;
  while (n < group.z.length && group.z[n] > t) n++;
  return n;
}

/** Camera of one draw, IGI space: position (units, double) and the rows of its rotation (right, down, forward). */
export interface RainCamera {
  position: Vec3;
  right: Vec3;
  down: Vec3;
  forward: Vec3;
  /** Projection scales: screen x = right / depth x sx, screen y (down) = down / depth x sy, in [-1, 1]. */
  sx: number;
  sy: number;
}

/** A queued cell (FUN_004b72e0 entry): its (i, j) ring column, the depth key, and the band base. */
export interface RainCell {
  i: number;
  j: number;
  key: number;
}

/**
 * The 12 x 12 ring of traced columns (the +0xe40 cell cache; the exe stores it
 * 24 x 24 with 2 x 2 copies so any window is contiguous, which the modulo
 * indexing here replaces).
 */
export class RainColumns {
  readonly x = new Float64Array(144);
  readonly y = new Float64Array(144);
  /** Column floor (record +0x10, the hit z). */
  readonly floor = new Float64Array(144);
  /** Depth key (record +0x18) and flags (record +0x1c: 0x20 traced, outcodes). */
  readonly key = new Float32Array(144);
  readonly flags = new Uint32Array(144);
  /** +0x56ad: a draw has traced since the last reset; 0 forces the 10000 budget. */
  traced = false;
  /** +0x56b0: camera position of the last draw. */
  private last: Vec3 = [0, 0, 0];
  /** Ring origin of the last trace: floor(cam / C - 5). */
  ix0 = 0;
  iy0 = 0;
  /** Traces made by the last call (diagnostics / tests). */
  lastTraces = 0;

  constructor() {
    // FUN_00498960: flags cleared; x, y = 0 never match a column away from the origin.
    this.x.fill(Number.NaN);
    this.y.fill(Number.NaN);
  }

  /** Ring slot of column (i, j). */
  slot(i: number, j: number): number {
    return (((i % 12) + 12) % 12) * 12 + (((j % 12) + 12) % 12);
  }

  /**
   * FUN_00498bd0. `cast(x, y, z, length)` = hit z of a vertical ray from (x, y, z) down by
   * `length` units, or null when nothing is hit. On a miss the exe stores whatever its out
   * record still holds (the previous hit of this pass, else stale stack data): the previous hit
   * of this call, else camZ - Traceline end [inferred].
   */
  trace(cam: Vec3, traceStart: number, traceLength: number, cast: (x: number, y: number, z: number, length: number) => number | null): void {
    const ix = Math.floor((cam[0] - RAIN.ringOffset) * RAIN.invTile + 0.5);
    const iy = Math.floor((cam[1] - RAIN.ringOffset) * RAIN.invTile + 0.5);
    this.ix0 = ix;
    this.iy0 = iy;
    const xoff = ((ix % 12) + 12) % 12;
    const yoff = ((iy % 12) + 12) % 12;
    let budget: number;
    if (!this.traced) budget = RAIN.firstBudget;
    else {
      budget = Math.ceil(Math.abs(cam[0] - this.last[0]) * RAIN.invTileF32 * 12);
      budget += Math.ceil(Math.fround(Math.abs(cam[1] - this.last[1])) * RAIN.invTileF32 * 12);
    }
    this.last = [cam[0], cam[1], cam[2]];
    this.traced = true;
    let traces = 0;
    let lastHit = cam[2] + traceStart - traceLength;
    let rowX = (ix - xoff) * 10895.3603515625;
    for (let a = 0; a < 12; a++) {
      const x = a < xoff ? rowX + RAIN.ringSpan : rowX;
      let colY = (iy - yoff) * 10895.3603515625;
      for (let b = 0; b < 12; b++) {
        const y = b < yoff ? colY + RAIN.ringSpan : colY;
        const s = a * 12 + b;
        const keep = this.x[s] === x && this.y[s] === y ? 0x20 : 0;
        this.flags[s] &= keep;
        if (this.flags[s] === 0 && budget-- > 0) {
          this.x[s] = x;
          this.y[s] = y;
          const hit = cast(x, y, cam[2] + traceStart, traceLength);
          if (hit !== null) lastHit = hit;
          this.floor[s] = lastHit;
          this.flags[s] = 0x20;
          traces++;
        }
        colY += 10895.3603515625;
      }
      rowX += 10895.3603515625;
    }
    this.lastTraces = traces;
  }

  /** The ring slot that holds window column (i, j) (0 <= i, j < 10, from (ix0 + 1, iy0 + 1)). */
  windowSlot(i: number, j: number): number {
    return this.slot(this.ix0 + 1 + i, this.iy0 + 1 + j);
  }

  /** FUN_00499910 + FUN_00498f10: outcodes and keys of the 10 x 10 window, then the queued cells (9 x 9), back to front. */
  cull(camera: RainCamera, bandBase: number): RainCell[] {
    const cam = camera.position;
    const outcode = (x: number, y: number, z: number): { flags: number; depth: number } => {
      const dx = x - cam[0];
      const dy = y - cam[1];
      const dz = z - cam[2];
      const r = Math.fround(camera.right[0] * dx + camera.right[1] * dy + camera.right[2] * dz);
      const dn = Math.fround(camera.down[0] * dx + camera.down[1] * dy + camera.down[2] * dz);
      const depth = Math.fround(camera.forward[0] * dx + camera.forward[1] * dy + camera.forward[2] * dz);
      if (depth <= 0) return { flags: 0x10 | (r <= 0 ? 1 : 4) | (dn <= 0 ? 2 : 8), depth };
      const sx = (r / depth) * camera.sx;
      const sy = (dn / depth) * camera.sy;
      return { flags: (sx <= -1 ? 1 : 0) | (sy <= -1 ? 2 : 0) | (sx >= 1 ? 4 : 0) | (sy >= 1 ? 8 : 0), depth };
    };
    for (let i = 0; i < RAIN.window; i++) {
      for (let j = 0; j < RAIN.window; j++) {
        const s = this.windowSlot(i, j);
        if ((this.flags[s] & 0x20) === 0) {
          this.flags[s] = 0x1f;
          continue;
        }
        const lo = outcode(this.x[s], this.y[s], bandBase);
        const hi = outcode(this.x[s], this.y[s], bandBase + RAIN.bandSpan);
        this.flags[s] = 0x20 | (lo.flags & hi.flags);
        this.key[s] = Math.fround((hi.depth + lo.depth) * 0.5);
      }
    }
    const cells: RainCell[] = [];
    for (let i = 0; i < RAIN.cells; i++) {
      for (let j = 0; j < RAIN.cells; j++) {
        const a = this.windowSlot(i, j);
        const b = this.windowSlot(i, j + 1);
        const c = this.windowSlot(i + 1, j);
        const d = this.windowSlot(i + 1, j + 1);
        if ((this.flags[a] & this.flags[b] & this.flags[c] & this.flags[d]) !== 0x20) continue;
        cells.push({ i, j, key: Math.max(this.key[a], this.key[c], this.key[b], this.key[d]) });
      }
    }
    // The deferred list draws far before near [inferred: back-to-front blending order].
    return cells.sort((p, q) => q.key - p.key);
  }

  /** Largest floor of cell (i, j)'s four corners. */
  cellFloor(i: number, j: number): number {
    return Math.max(
      this.floor[this.windowSlot(i, j)], this.floor[this.windowSlot(i + 1, j)],
      this.floor[this.windowSlot(i, j + 1)], this.floor[this.windowSlot(i + 1, j + 1)],
    );
  }
}

/** bandBase of FUN_00498f10: floor((camZ - 1.5 H) / H + 0.5) x H. */
export function rainBandBase(camZ: number): number {
  return Math.floor((camZ - RAIN.bandOffset) * RAIN.invHeight + 0.5) * RAIN.height;
}

/** One drawn layer of one cell: where its group's first `count` drops go. */
export interface RainBatch {
  group: number;
  count: number;
  /** Layer origin (IGI units): cell corner x, y and bandBase + k H. */
  origin: Vec3;
}

/** FUN_00499430 for every queued cell (layers 2, 1, 0). */
export function rainBatches(columns: RainColumns, cells: readonly RainCell[], groups: readonly RainGroup[], bandBase: number): RainBatch[] {
  const out: RainBatch[] = [];
  for (const cell of cells) {
    const s = columns.windowSlot(cell.i, cell.j);
    const cx = columns.x[s];
    const cy = columns.y[s];
    const g = ((Math.floor(cy * RAIN.invTile) & 1) << 1) | (Math.floor(cx * RAIN.invTile) & 1);
    let t = x87StoreF32(columns.cellFloor(cell.i, cell.j) - bandBase - RAIN.bandSpan);
    for (let k = 2; k >= 0; k--) {
      t = x87F32Add(t, RAIN.height);
      const count = rainLayerCount(groups[g], t);
      if (count > 0) out.push({ group: g, count, origin: [cx, cy, bandBase + k * RAIN.height] });
    }
  }
  return out;
}

/** What the renderer needs from the level: the trace and the IGI <-> engine origin. */
export interface RainHost {
  /** IGI origin of the engine frame (IgiLevel.originIgi). */
  originIgi: Vec3;
  /** Hit z (IGI units) of a vertical ray from (x, y, z) down by `length` units, or null. */
  cast(x: number, y: number, z: number, length: number): number | null;
}

export interface RainRenderer {
  readonly object: THREE.Object3D;
  /** The current simulation (null: nothing drawn). */
  sim: RainSim | null;
  /** The trace ring (diagnostics / tests). */
  readonly columns: RainColumns;
  /** Draw for `camera` (the main pass): trace, fill, cull, cells. */
  draw(camera: THREE.Camera): void;
  /** Hide for a render that is not the main pass (the map computer's camera). */
  skip(): void;
  /** Drawn primitives of the last draw: lines (rain) or flakes (snow). */
  readonly drawn: number;
  /** A new Rain object (mission start): the trace starts again. */
  reset(sim: RainSim | null): void;
  dispose(): void;
}

const UNITS = 4096;

export function createRainRenderer(host: RainHost, snowTexture: DecodedTexture | null): RainRenderer {
  let sim: RainSim | null = null;
  let columns = new RainColumns();
  let drawn = 0;
  const group = new THREE.Group();
  group.name = "rain";
  // Rain: D3DPT_LINELIST, diffuse only (COLOROP / ALPHAOP SELECTARG2), SRCALPHA / INVSRCALPHA.
  const lineGeometry = new THREE.BufferGeometry();
  const lineMaterial = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, depthTest: true, depthWrite: false, fog: false, toneMapped: false,
  });
  lineMaterial.depthFunc = THREE.LessDepth;
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  lines.frustumCulled = false;
  lines.name = "rain-lines";
  // Snow: TRIANGLELIST, snow.tex x diffuse, MAG LINEAR / MIN POINT.
  let texture: THREE.DataTexture | null = null;
  if (snowTexture) {
    texture = new THREE.DataTexture(new Uint8Array(snowTexture.rgba), snowTexture.width, snowTexture.height, THREE.RGBAFormat);
    texture.flipY = false;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
  }
  const flakeGeometry = new THREE.BufferGeometry();
  const flakeMaterial = new THREE.MeshBasicMaterial({
    map: texture, color: 0xffffff, transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false,
  });
  flakeMaterial.depthFunc = THREE.LessDepth;
  const flakes = new THREE.Mesh(flakeGeometry, flakeMaterial);
  flakes.frustumCulled = false;
  flakes.name = "snow-flakes";
  group.add(lines, flakes);
  group.visible = false;
  let lineCapacity = 0;
  let flakeCapacity = 0;

  const camPos = new THREE.Vector3();
  const axis = new THREE.Vector3();
  /** Engine direction -> IGI direction (x, -z, y). */
  const igiDir = (v: THREE.Vector3): Vec3 => [v.x, -v.z, v.y];

  const ensureLines = (n: number) => {
    if (n <= lineCapacity) return;
    lineCapacity = Math.max(1024, n * 2);
    lineGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(lineCapacity * 3), 3));
    lineGeometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(lineCapacity * 4), 4));
  };
  const ensureFlakes = (n: number) => {
    if (n <= flakeCapacity) return;
    flakeCapacity = Math.max(1024, n * 2);
    flakeGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(flakeCapacity * 3), 3));
    flakeGeometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(flakeCapacity * 2), 2));
  };

  return {
    object: group,
    get sim() {
      return sim;
    },
    set sim(next: RainSim | null) {
      sim = next;
    },
    get columns() {
      return columns;
    },
    get drawn() {
      return drawn;
    },
    reset(next) {
      sim = next;
      columns = new RainColumns();
      group.visible = false;
      drawn = 0;
    },
    skip() {
      group.visible = false;
    },
    draw(camera) {
      drawn = 0;
      group.visible = false;
      if (!sim) return;
      // FUN_00498b80: nothing at fade 0, and the next draw traces from scratch.
      if (sim.fade === 0) {
        columns.traced = false;
        return;
      }
      camera.updateMatrixWorld();
      camPos.setFromMatrixPosition(camera.matrixWorld);
      const o = host.originIgi;
      const camIgi: Vec3 = [o[0] + camPos.x * UNITS, o[1] - camPos.z * UNITS, o[2] + camPos.y * UNITS];
      const right = igiDir(axis.setFromMatrixColumn(camera.matrixWorld, 0).normalize());
      const up = igiDir(axis.setFromMatrixColumn(camera.matrixWorld, 1).normalize());
      const back = igiDir(axis.setFromMatrixColumn(camera.matrixWorld, 2).normalize());
      const down: Vec3 = [-up[0], -up[1], -up[2]];
      const forward: Vec3 = [-back[0], -back[1], -back[2]];
      const proj = (camera as THREE.PerspectiveCamera).projectionMatrix?.elements ?? [1, 0, 0, 0, 0, 1];
      const view: RainCamera = { position: camIgi, right, down, forward, sx: proj[0], sy: proj[5] };
      // Stage 1: floor trace.
      columns.trace(camIgi, sim.traceStart, sim.traceLength, host.cast);
      // Stage 2: the group sections; stage 3: cull; stage 4: cells.
      const groups = rainGroups(sim);
      const bandBase = rainBandBase(camIgi[2]);
      const cells = columns.cull(view, bandBase);
      const batches = rainBatches(columns, cells, groups, bandBase);
      let total = 0;
      for (const b of batches) total += b.count;
      if (total === 0) return;
      const d = sim.drops;
      // Engine coordinates relative to the camera: ((X - camX), (Z - camZ), -(Y - camY)) / 4096.
      group.position.copy(camPos);
      group.updateMatrixWorld(true);
      if (!sim.snow) {
        ensureLines(total * 2);
        const pos = lineGeometry.getAttribute("position") as THREE.BufferAttribute;
        const col = lineGeometry.getAttribute("color") as THREE.BufferAttribute;
        const p = pos.array as Float32Array;
        const c = col.array as Float32Array;
        const streak = x87StoreF32(sim.fade * RAIN.streak);
        const alpha = (sim.colour >>> 24) / 255;
        let v = 0;
        for (const b of batches) {
          const ox = b.origin[0] - camIgi[0];
          const oy = b.origin[1] - camIgi[1];
          const oz = b.origin[2] - camIgi[2];
          const list = groups[b.group].drops;
          for (let n = 0; n < b.count; n++) {
            const k = list[n] * FLOATS_PER_DROP;
            const x = (ox + d[k]) / UNITS;
            const yE = -(oy + d[k + 1]) / UNITS;
            const z = d[k + 2];
            p[v * 3] = x; p[v * 3 + 1] = (oz + x87F32Add(streak, z)) / UNITS; p[v * 3 + 2] = yE;
            c[v * 4] = 1; c[v * 4 + 1] = 1; c[v * 4 + 2] = 1; c[v * 4 + 3] = 0; // 0x00FFFFFF
            v++;
            p[v * 3] = x; p[v * 3 + 1] = (oz + z) / UNITS; p[v * 3 + 2] = yE;
            c[v * 4] = 1; c[v * 4 + 1] = 1; c[v * 4 + 2] = 1; c[v * 4 + 3] = alpha;
            v++;
          }
        }
        pos.needsUpdate = true;
        col.needsUpdate = true;
        lineGeometry.setDrawRange(0, v);
        lines.visible = true;
        flakes.visible = false;
        drawn = v / 2;
      } else {
        ensureFlakes(total * 6);
        const pos = flakeGeometry.getAttribute("position") as THREE.BufferAttribute;
        const uvs = flakeGeometry.getAttribute("uv") as THREE.BufferAttribute;
        const p = pos.array as Float32Array;
        const uv = uvs.array as Float32Array;
        const s = x87StoreF32(sim.fade * RAIN.flake);
        // Corners c +- s right +- s down (the world matrix R^T x 0.001 turns the view-space square back).
        const corners = [[-1, -1, 0, 0], [1, -1, 1, 0], [-1, 1, 0, 1], [1, 1, 1, 1], [1, -1, 1, 0], [-1, 1, 0, 1]];
        let v = 0;
        for (const b of batches) {
          const list = groups[b.group].drops;
          for (let n = 0; n < b.count; n++) {
            const k = list[n] * FLOATS_PER_DROP;
            const cx = b.origin[0] - camIgi[0] + d[k];
            const cy = b.origin[1] - camIgi[1] + d[k + 1];
            const cz = b.origin[2] - camIgi[2] + d[k + 2];
            for (const [a, e, u, w] of corners) {
              const X = cx + (a * right[0] + e * down[0]) * s;
              const Y = cy + (a * right[1] + e * down[1]) * s;
              const Z = cz + (a * right[2] + e * down[2]) * s;
              p[v * 3] = X / UNITS; p[v * 3 + 1] = Z / UNITS; p[v * 3 + 2] = -Y / UNITS;
              uv[v * 2] = u; uv[v * 2 + 1] = w;
              v++;
            }
          }
        }
        pos.needsUpdate = true;
        uvs.needsUpdate = true;
        flakeGeometry.setDrawRange(0, v);
        flakes.visible = true;
        lines.visible = false;
        drawn = v / 6;
      }
      group.visible = true;
    },
    dispose() {
      group.removeFromParent();
      lineGeometry.dispose();
      lineMaterial.dispose();
      flakeGeometry.dispose();
      flakeMaterial.dispose();
      texture?.dispose();
    },
  };
}
