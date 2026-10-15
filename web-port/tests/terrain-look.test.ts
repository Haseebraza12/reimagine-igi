/**
 * Terrain texturing/lighting parity with the reference implementation
 * (tools/terrain_tex.py, whose model is recovered from igi.exe; see
 * docs/terrain.md). Reference values were produced by terrain_tex.py
 * cell_texturing() for cells at the base centre, inside a HeightMap relief
 * area and in a "Grass" TextureModifier area.
 */
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { loadIgiLevel, type IgiLevel } from "../src/loaders/level";
import { RAW_ROOT } from "./helpers";

const have = existsSync(`${RAW_ROOT}/missions/location0/level1/terrain/terrain.bit`);

const REFERENCE = [
  {
    cell: { node: 6739, level: 16, cx: 24592384, cy: -56115200, cz: 174407680, t: 2 },
    // [x, y, z, material, layer, u, v, light]
    vertices: [[24608768.0, -56098816.0, 174413141.333333, 4, 14, 1.00390625, 1.00390625, 135.0], [24576000.0, -56098816.0, 174413141.333333, 1, 9, 0.00390625, 1.00390625, 135.0], [24608768.0, -56131584.0, 174413141.333333, 4, 14, 1.00390625, 0.00390625, 135.0], [24576000.0, -56131584.0, 174413141.333333, 4, 14, 0.00390625, 0.00390625, 135.0], [24608768.0, -56115200.0, 174413141.333333, 4, 14, 1.00390625, 0.50390625, 148.0], [24592384.0, -56098816.0, 174413141.333333, 1, 9, 0.50390625, 1.00390625, 109.0], [24576000.0, -56115200.0, 174413141.333333, 4, 14, 0.00390625, 0.50390625, 122.0], [24592384.0, -56131584.0, 174413141.333333, 4, 14, 0.50390625, 0.00390625, 109.0], [24592384.0, -56115200.0, 174413141.333333, 4, 14, 0.50390625, 0.50390625, 109.0]],
  },
  {
    cell: { node: 8581, level: 16, cx: 24068096, cy: -55689216, cz: 174505984, t: 5 },
    // [x, y, z, material, layer, u, v, light]
    vertices: [[24084480.0, -55672832.0, 174495914.666667, 0, 3, 1.00390625, 1.00390625, 57.0], [24084480.0, -55705600.0, 174494890.666667, 0, 3, 1.00390625, 0.00390625, 124.0], [24051712.0, -55672832.0, 174499925.333333, 0, 3, 0.00390625, 1.00390625, 136.0], [24051712.0, -55705600.0, 174499413.333333, 0, 3, 0.00390625, 0.00390625, 161.0], [24068096.0, -55672832.0, 174497621.333333, 0, 3, 0.50390625, 1.00390625, 42.0], [24084480.0, -55689216.0, 174495146.666667, 0, 3, 1.00390625, 0.50390625, 32.0], [24068096.0, -55705600.0, 174496597.333333, 0, 3, 0.50390625, 0.00390625, 133.0], [24062634.666666668, -55672832.0, 174498645.333333, 0, 3, 0.33723958, 1.00390625, 73.333333], [24062634.666666668, -55705600.0, 174497621.333333, 0, 3, 0.33723958, 0.00390625, 142.333333], [24051712.0, -55689216.0, 174499413.333333, 0, 3, 0.00390625, 0.50390625, 152.0], [24068096.0, -55689216.0, 174497109.333333, 0, 3, 0.50390625, 0.50390625, 73.0], [24062634.666666668, -55689216.0, 174497962.666667, 0, 3, 0.33723958, 0.50390625, 99.333333]],
  },
  {
    cell: { node: 8528, level: 16, cx: 23052288, cy: -59326464, cz: 174473216, t: 7 },
    // [x, y, z, material, layer, u, v, light]
    vertices: [[23035904.0, -59342848.0, 174484138.666667, 1, 10, 0.00390625, 0.00390625, 148.0], [23035904.0, -59310080.0, 174484138.666667, 0, 6, 0.00390625, 1.00390625, 148.0], [23068672.0, -59342848.0, 174484138.666667, 1, 10, 1.00390625, 0.00390625, 148.0], [23068672.0, -59310080.0, 174478677.333333, 1, 10, 1.00390625, 1.00390625, 148.0], [23052288.0, -59342848.0, 174484138.666667, 1, 10, 0.50390625, 0.00390625, 148.0], [23035904.0, -59326464.0, 174484138.666667, 1, 10, 0.00390625, 0.50390625, 148.0], [23052288.0, -59310080.0, 174484138.666667, 1, 10, 0.50390625, 1.00390625, 148.0], [23068672.0, -59326464.0, 174484138.666667, 1, 10, 1.00390625, 0.50390625, 148.0], [23052288.0, -59326464.0, 174484138.666667, 1, 10, 0.50390625, 0.50390625, 148.0]],
  },
];

describe.skipIf(!have)("TerrainLook parity with tools/terrain_tex.py", () => {
  let level: IgiLevel;
  beforeAll(async () => {
    level = await loadIgiLevel(createFsAssetSource(RAW_ROOT));
  });

  it.each(REFERENCE.map((r, i) => [i, r] as const))("cell %d: materials, layers, uvs and lightmap values", (_i, ref) => {
    const mesh = level.terrain.look.buildRenderMesh([ref.cell]);
    expect(mesh.triangles).toBeGreaterThan(0);
    const seen = new Set<number>();
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      const [x, y, z] = [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]];
      const index = ref.vertices.findIndex((r) => Math.abs(r[0] - x) < 1e-6 && Math.abs(r[1] - y) < 1e-6);
      expect(index).toBeGreaterThanOrEqual(0);
      const [, , rz, , layer, u, vv, light] = ref.vertices[index];
      expect(z).toBeCloseTo(rz, 4);
      expect(mesh.layers[v * 3 + (v % 3)]).toBe(layer); // the vertex's own material layer
      expect(mesh.uv[v * 2]).toBeCloseTo(u, 5);
      expect(mesh.uv[v * 2 + 1]).toBeCloseTo(vv, 5);
      expect(mesh.light[v]).toBeCloseTo(light, 3);
      seen.add(index);
    }
    expect(seen.size).toBe(ref.vertices.length);
  });
});
