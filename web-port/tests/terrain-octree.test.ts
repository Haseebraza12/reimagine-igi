/**
 * Octree terrain decoder: parity with the validated reference decoder
 * (tools/terrain_ctr.py) on the real level-1 files (skipped when absent).
 * Expected heights were produced by tools/terrain_ctr.py; the TerrainLightMap
 * points are tile positions from objects.qvm, which lie on the surface.
 */
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { TerrainOctree } from "../src/loaders/terrain-octree";
import { RAW_ROOT, readRaw } from "./helpers";

const DIR = "missions/location0/level1/terrain";
const have = existsSync(`${RAW_ROOT}/${DIR}/terrain.ctr`);

const LEVEL1_HEIGHTMAPS = [
  { position: [22128590, -57264816, 174634432] as [number, number, number], level: 11, size: 128, bitmapId: 0 },
  { position: [22735164, -56375428, 174696704] as [number, number, number], level: 11, size: 128, bitmapId: 1 },
  { position: [23335550, -56157360, 174594512] as [number, number, number], level: 11, size: 128, bitmapId: 2 },
];

const REFERENCE: Array<[string, number, number, number[]]> = [
  ["TerrainLightMap", 24638438, -56057824, [174413141.33333334]],
  ["TerrainLightMap", 15728643, -47185916, [174238379.83333334]],
  ["TerrainLightMap", 29360130, -46137340, [175461719.33333334]],
  ["TerrainLightMap", 10485763, -85983224, [177908389.16666666]],
  ["TerrainLightMap", -25165820, -109051896, [178956972.66666666]],
  ["TerrainLightMap", 88080384, -12582908, [174762664.66666666]],
  ["TerrainLightMap", 83886080, -150994928, [174762658.66666666]],
  ["Building", 24316832, -55962088, [174413141.33333334]],
  ["HeightMap relief", 24083352, -55703172, [174495063.72916666]],
  ["far field", 100000000, 50000000, [173617770.6666667]],
];

describe.skipIf(!have)("TerrainOctree (real level-1 terrain)", () => {
  let terrain: TerrainOctree;
  beforeAll(async () => {
    terrain = new TerrainOctree(
      await readRaw(`${DIR}/terrain.ctr`),
      await readRaw(`${DIR}/terrain.cmd`),
      await readRaw(`${DIR}/terrain.hmp`),
      LEVEL1_HEIGHTMAPS,
    );
  });

  it.each(REFERENCE)("%s at (%d, %d) matches the reference decoder", (_kind, x, y, expected) => {
    const heights = terrain.heightsAt(x, y);
    expect(heights).toHaveLength(expected.length);
    heights.forEach((h, i) => expect(h).toBeCloseTo(expected[i], 4));
  });

  it("decodes the base exactly at the buildings' float32 height", () => {
    const h = terrain.heightsAt(24316832, -55962088)[0];
    expect(Math.fround(h)).toBe(174413136);
  });

  it("builds the reference-sized mesh for the level region", () => {
    const mesh = terrain.mesh([21004288, -62062592, 27066368, -54493184]);
    expect(mesh.cells).toBe(63392);
    expect(mesh.positions.length / 3).toBe(247356);
    expect(mesh.indices.length / 3).toBe(492624);
  });
});
