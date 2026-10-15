/**
 * Per-frame terrain LOD as igi.exe draws it (docs/terrain.md section 7):
 * cell selection (FUN_004c6530), geomorph constants and formula
 * (FUN_005090a0 / FUN_0050be70), level-14 HeightMap relief and the
 * ancestor-only TerrainLightMap rule, on the real level-1 terrain (skipped
 * when absent), plus the pure helpers.
 */
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { loadIgiLevel, type IgiLevel } from "../src/loaders/level";
import {
  morphCellGeometry,
  TERRAIN_ROOT_HALF,
  terrainLodScale,
  terrainLodThreshold,
  terrainMorphParams,
  type TerrainCell,
  type TerrainCellGeometry,
} from "../src/loaders/terrain-octree";
import { packSquares, terrainCornerWeights } from "../src/engine/world/terrain-render";
import { RAW_ROOT } from "./helpers";

const have = existsSync(`${RAW_ROOT}/missions/location0/level1/terrain/terrain.ctr`) && existsSync(`${RAW_ROOT}/missions/location0/level1/objects.qvm`);

describe("terrain LOD constants (FUN_004c7590 / FUN_005090a0)", () => {
  it("threshold: 163 at GOGfxPerformance(0), raised by zoom, at least 70", () => {
    expect(terrainLodThreshold(1)).toBe(163);
    expect(terrainLodThreshold(4 / 3)).toBe(163); // tan > 1: the base value
    expect(terrainLodThreshold(0.5)).toBe(230); // trunc(163 / sqrt(0.5)) = 230.5 -> 230
    expect(terrainLodThreshold(0.1)).toBe(515);
    expect(terrainLodThreshold(1, 0x60)).toBe(96);
    expect(terrainLodThreshold(2, 50)).toBe(70);
  });

  it("geomorph offset/slope and per-level distance scale", () => {
    const m = terrainMorphParams(163);
    expect(m.offset).toBe(85); // trunc(227 * 0.375)
    expect(m.slope).toBeCloseTo(0.026936026, 8);
    expect(Math.fround(m.slope)).toBe(m.slope); // stored as float32
    // A level-16 vertex starts morphing at 28.3 m and is fully coarse at 40.7 m.
    const start = m.offset / terrainLodScale(16) / 4096;
    const end = (m.offset + 1 / m.slope) / terrainLodScale(16) / 4096;
    expect(start).toBeCloseTo(28.33, 2);
    expect(end).toBeCloseTo(40.71, 1);
  });

  it("corner weights sum to 255 and split by material (vertex shader mirror)", () => {
    for (const lod of [0, 0.1, 0.37, 0.5, 0.99, 1]) {
      const a = terrainCornerWeights(lod, false);
      expect(a[0] + a[1]).toBe(255);
      const b = terrainCornerWeights(lod, true);
      expect(Math.abs(b.reduce((s, v) => s + v, 0) - 255)).toBeLessThanOrEqual(1);
      expect(b[0] + b[2]).toBe(a[0]); // detail total = W
    }
    expect(terrainCornerWeights(0, false)).toEqual([255, 0, 0, 0]);
    expect(terrainCornerWeights(1, true)).toEqual([0, 0, 0, 255]);
  });

  it("packs power-of-two lightmaps without overlap", () => {
    const sides = [16, 128, 32, 64, 16, 16, 128, 64, 32, 16, 128];
    const pack = packSquares(sides, 256);
    const taken = new Set<string>();
    sides.forEach((s, i) => {
      const [x, y] = pack.at[i];
      expect(x % s).toBe(0);
      expect(y % s).toBe(0);
      expect(x + s).toBeLessThanOrEqual(pack.width);
      expect(y + s).toBeLessThanOrEqual(pack.height);
      for (let ty = 0; ty < s; ty += 16) {
        for (let tx = 0; tx < s; tx += 16) {
          const key = `${x + tx},${y + ty}`;
          expect(taken.has(key)).toBe(false);
          taken.add(key);
        }
      }
    });
  });
});

describe.skipIf(!have)("terrain LOD on the level-1 terrain", () => {
  let level: IgiLevel;
  let camera: [number, number, number];
  beforeAll(async () => {
    level = await loadIgiLevel(createFsAssetSource(RAW_ROOT));
    const [ground] = level.terrain.octree.heightsAt(level.origin[0], level.origin[1]);
    camera = [level.origin[0], level.origin[1], ground + 1.7 * 4096];
  });

  const half = (c: TerrainCell) => TERRAIN_ROOT_HALF / 2 ** c.level;
  const cheb = (c: TerrainCell, p: readonly number[]) =>
    Math.max(Math.abs(c.cx - Math.trunc(p[0])), Math.abs(c.cy - Math.trunc(p[1])), Math.abs(c.cz - Math.trunc(p[2])));

  it("selects levels 7..16 by the Chebyshev metric (m >= T or level 16)", () => {
    const T = terrainLodThreshold(1);
    const cells = level.terrain.octree.selectCells({ position: camera, tanX: 1, tanY: 0.75, threshold: T });
    const levels = new Set(cells.map((c) => c.level));
    expect(Math.min(...levels)).toBe(7);
    expect(Math.max(...levels)).toBe(16);
    for (const c of cells) {
      const h = half(c);
      const m = Math.floor((cheb(c, camera) - h) / 2 ** (25 - c.level));
      if (c.level < 16) expect(m).toBeGreaterThanOrEqual(T);
      // Its parent was refined: m(parent) < T.
      const H = 2 * h; // parent half-size; parent centres are odd multiples of H
      const px = Math.floor(c.cx / (2 * H)) * 2 * H + H;
      const py = Math.floor(c.cy / (2 * H)) * 2 * H + H;
      const pz = Math.floor(c.cz / (2 * H)) * 2 * H + H;
      const parent = { ...c, level: c.level - 1, cx: px, cy: py, cz: pz };
      expect(Math.floor((cheb(parent, camera) - H) / 2 ** (25 - parent.level))).toBeLessThan(T);
    }
    // Full detail only near the camera: level-16 cells within ~49 m (level-15 node centre) + 4 m.
    for (const c of cells.filter((c) => c.level === 16)) expect(cheb(c, camera) / 4096).toBeLessThan(49 + 4 + 0.01);
    // The far field ends with level 7 cells whose level-6 parent centre lies within 2^19 * (32 + T).
    const far = Math.max(...cells.map((c) => cheb(c, camera)));
    expect(far).toBeLessThan(2 ** 19 * (32 + T) + 2 ** 24 + 1);
    expect(far / 4096).toBeGreaterThan(20000);
  });

  it("frustum culling keeps a subset whose bounding spheres meet the view volume", () => {
    const yaw = 0.7;
    // Rows right, down, forward in IGI axes (z up).
    const R = [Math.sin(yaw), -Math.cos(yaw), 0, 0, 0, -1, Math.cos(yaw), Math.sin(yaw), 0];
    const T = terrainLodThreshold(1);
    const all = level.terrain.octree.selectCells({ position: camera, tanX: 1, tanY: 0.75, threshold: T });
    const seen = level.terrain.octree.selectCells({ position: camera, rotation: R, tanX: 1, tanY: 0.75, threshold: T });
    const key = (c: TerrainCell) => `${c.cx},${c.cy},${c.cz},${c.level}`;
    const allKeys = new Set(all.map(key));
    expect(seen.length).toBeGreaterThan(200);
    expect(seen.length).toBeLessThan(all.length / 2);
    for (const c of seen) {
      expect(allKeys.has(key(c))).toBe(true);
      const d = [c.cx - Math.trunc(camera[0]), c.cy - Math.trunc(camera[1]), c.cz - Math.trunc(camera[2])];
      const z = R[6] * d[0] + R[7] * d[1] + R[8] * d[2];
      const x = R[0] * d[0] + R[1] * d[1] + R[2] * d[2];
      expect(Math.abs(x)).toBeLessThan(z + 1.7321 * half(c) * Math.SQRT2 + 1);
    }
  });

  it("geomorphing closes every boundary between cells of different levels", () => {
    // Heights on both sides of each cell edge where the neighbouring cells have
    // different levels must agree for the morphed geometry (the property the
    // recovered target-lod rule gives); morphing extras by their own lod fails.
    const oct = level.terrain.octree;
    const T = terrainLodThreshold(1);
    const morph = terrainMorphParams(T);
    const cells = oct.selectCells({ position: camera, tanX: 1, tanY: 0.75, threshold: T }).filter((c) => c.level >= 11);
    const build = (variant: "exe" | "own") =>
      cells.map((c) => {
        const g = oct.cellGeometry(c);
        let p = morphCellGeometry(g, c.level, camera, morph).positions;
        if (variant === "own") p = ownLodMorph(g, c.level, camera, morph);
        return { c, h: half(c), p, t: g.triangles };
      });
    const check = (data: ReturnType<typeof build>) => {
      let samples = 0;
      let bad = 0;
      for (const d of data) {
        for (const [axis, x0] of [
          [0, d.c.cx - d.h],
          [0, d.c.cx + d.h],
          [1, d.c.cy - d.h],
          [1, d.c.cy + d.h],
        ] as const) {
          for (const f of [0.17, 0.5, 0.83]) {
            const x = axis === 0 ? x0 : d.c.cx - d.h + 2 * d.h * f;
            const y = axis === 1 ? x0 : d.c.cy - d.h + 2 * d.h * f;
            const along = (e: (typeof data)[number]) => Math.abs((axis === 0 ? y : x) - (axis === 0 ? e.c.cy : e.c.cx)) <= e.h;
            const at = (e: (typeof data)[number]) => (axis === 0 ? e.c.cx : e.c.cy);
            const v = axis === 0 ? x : y;
            const left = data.filter((e) => along(e) && v > at(e) - e.h && v <= at(e) + e.h);
            const right = data.filter((e) => along(e) && v >= at(e) - e.h && v < at(e) + e.h);
            if (!left.length || !right.length) continue;
            if (new Set([...left, ...right].map((e) => e.c.level)).size < 2) continue;
            const L = left.flatMap((e) => heightsIn(e.p, e.t, x, y));
            const R = right.flatMap((e) => heightsIn(e.p, e.t, x, y));
            if (!L.length || !R.length) continue;
            samples++;
            const miss = (a: number[], b: number[]) => a.some((z) => !b.some((w) => Math.abs(w - z) <= 16));
            if (miss(L, R) || miss(R, L)) bad++;
          }
        }
      }
      return { samples, bad };
    };
    const exe = check(build("exe"));
    expect(exe.samples).toBeGreaterThan(1000);
    expect(exe.bad).toBe(0);
    // Sanity: the check is sensitive to the morph rule.
    // (Own-lod morphing breaks same-level edges; at level transitions it can
    // still agree, so compare the unmorphed full-detail mesh instead.)
    const flat = check(
      cells.map((c) => {
        const g = oct.cellGeometry(c);
        const p = new Float64Array(g.positions);
        for (let k = 0; k < g.relief.length; k++) p[k * 3 + 2] += g.relief[k];
        return { c, h: half(c), p, t: g.triangles };
      }),
    );
    expect(flat.bad).toBeGreaterThan(100);
  }, 120_000);

  it("level-14 cells fade the HeightMap relief in; level 15+ store it", () => {
    const oct = level.terrain.octree;
    const hm = level.tasks.find((t) => t.type === "HeightMap")!;
    const [x, y] = (hm.params as { Position: number[] }).Position;
    const [ground] = oct.heightsAt(x, y);
    const cells = oct.selectCells({ position: [x, y, ground + 2 * 4096], tanX: 1, tanY: 0.75, threshold: 163 });
    const withRelief = (lvl: number) =>
      cells
        .filter((c) => c.level === lvl)
        .map((c) => oct.cellGeometry(c))
        .filter((g) => g.relief.some((r) => r !== 0));
    expect(withRelief(15)).toHaveLength(0);
    expect(withRelief(16)).toHaveLength(0);
    const l14 = withRelief(14);
    expect(l14.length).toBeGreaterThan(0);
    for (const g of l14) {
      // Only base vertices carry the deferred relief.
      for (let k = g.nbase; k < g.relief.length; k++) expect(g.relief[k]).toBe(0);
      // At lod 0 the drawn mesh has the full relief; at lod 1 none on base vertices.
      const lod0 = morphCellGeometry(g, 14, [0, 0, 0], { offset: -1e9, slope: 0 });
      const lod1 = morphCellGeometry(g, 14, [0, 0, 0], { offset: -1e9, slope: 1 });
      for (let k = 0; k < g.nbase; k++) {
        expect(lod0.positions[k * 3 + 2]).toBeCloseTo(g.positions[k * 3 + 2] + g.relief[k], 6);
        expect(lod1.positions[k * 3 + 2]).toBeCloseTo(g.positions[k * 3 + 2], 6);
      }
    }
  });

  it("a TerrainLightMap applies to cells finer than its level only", () => {
    const look = level.terrain.look;
    const oct = level.terrain.octree;
    const cells = oct.selectCells({ position: camera, tanX: 1, tanY: 0.75, threshold: terrainLodThreshold(1) });
    const levelOf = (c: TerrainCell) => {
      const l = look.cellLook(c, oct.cellGeometry(c)).lightmap;
      return l < 0 ? -1 : look.lightmaps[l].level;
    };
    // Level-10 tiles (512 m nodes) cover the base; a cell inside one uses it
    // only when the cell is finer than level 10 (the node was entered).
    const full = 2 ** 21;
    const tiles = new Set(
      level.tasks
        .filter((t) => t.type === "TerrainLightMap" && (t.params as { Level: number }).Level === 10)
        .map((t) => (t.params as { Position: number[] }).Position)
        .map((p) => `${Math.floor(p[0] / full)},${Math.floor(p[1] / full)}`),
    );
    let inside = 0;
    for (const c of cells) {
      const lm = levelOf(c);
      expect(lm).toBeLessThan(c.level);
      if (tiles.has(`${Math.floor(c.cx / full)},${Math.floor(c.cy / full)}`)) {
        expect(lm).toBe(c.level > 10 ? 10 : lm);
        if (c.level === 10) expect(lm).toBeLessThan(10);
        inside++;
      }
    }
    expect(inside).toBeGreaterThan(300);
  });
});

/** Barycentric heights of the triangles covering (x, y) (non-degenerate in xy). */
function heightsIn(p: Float64Array, t: Uint8Array, x: number, y: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < t.length; k += 3) {
    const i = t[k] * 3;
    const j = t[k + 1] * 3;
    const l = t[k + 2] * 3;
    const den = (p[j + 1] - p[l + 1]) * (p[i] - p[l]) + (p[l] - p[j]) * (p[i + 1] - p[l + 1]);
    if (Math.abs(den) < 1e-6) continue;
    const l1 = ((p[j + 1] - p[l + 1]) * (x - p[l]) + (p[l] - p[j]) * (y - p[l + 1])) / den;
    const l2 = ((p[l + 1] - p[i + 1]) * (x - p[l]) + (p[i] - p[l]) * (y - p[l + 1])) / den;
    const l3 = 1 - l1 - l2;
    if (l1 >= -1e-7 && l2 >= -1e-7 && l3 >= -1e-7) out.push(l1 * p[i + 2] + l2 * p[j + 2] + l3 * p[l + 2]);
  }
  return out;
}

/** Wrong rule for comparison: extras morph with their own lod. */
function ownLodMorph(g: TerrainCellGeometry, lvl: number, cam: readonly number[], m: { offset: number; slope: number }): Float64Array {
  const p = g.positions;
  const out = new Float64Array(p.length);
  const s = terrainLodScale(lvl);
  for (let k = 0; k < g.target.length; k++) {
    const d = Math.max(Math.abs(p[k * 3] - cam[0]), Math.abs(p[k * 3 + 1] - cam[1]), Math.abs(p[k * 3 + 2] - cam[2]));
    const lod = Math.min(1, Math.max(0, (d * s - m.offset) * m.slope));
    const t = g.target[k];
    for (let c = 0; c < 3; c++) out[k * 3 + c] = p[k * 3 + c] + (p[t * 3 + c] - p[k * 3 + c]) * lod;
    if (k < g.nbase) out[k * 3 + 2] += (1 - lod) * g.relief[k];
  }
  return out;
}
