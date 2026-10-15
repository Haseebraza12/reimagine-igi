/**
 * Collision meshes, surface materials and collision rules
 * (src/loaders/collision-mesh.ts). Reference values come from
 * tools/igi_collision.py over the original files; see docs/collision.md.
 */
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AI_SIGHT_MIN_TRANSMISSION,
  CHARACTER_SWEEP,
  HUMAN_COLLISION_MATERIAL,
  NO_MATERIAL,
  TerrainMaterialLookup,
  UNTAGGED_RAY_MATERIAL,
  aiSightPasses,
  characterSweepRays,
  faceNormal,
  flattenWallNormal,
  hitReplaces,
  raycastCollisionSet,
  readCollisionModel,
  readSurfaceMaterials,
  readTerrainGameMaterials,
  sightTransmission,
  slideOnWall,
  type CollisionModel,
  type CollisionSet,
  type SurfaceMaterial,
  type TerrainModifierInput,
} from "../src/loaders/collision-mesh";
import { readIlffMembers } from "../src/loaders/ilff";
import { readQvmCallTree } from "../src/loaders/qvm";
import { flattenTasks, numberParam, readTaskTree, vec3Param } from "../src/loaders/tasks";
import type { Vec3 } from "../src/contracts";
import { RAW_ROOT, readRaw } from "./helpers";

const ARCHIVES = ["missions/location0/level1/models/level1.res", "missions/location0/common/models/location0.res"];
const haveModels = ARCHIVES.every((a) => existsSync(`${RAW_ROOT}/${a}`));
const haveMaterial = existsSync(`${RAW_ROOT}/material/material.qvm`);
const TERRAIN = "missions/location0/level1/terrain";
const haveTerrain = existsSync(`${RAW_ROOT}/${TERRAIN}/terrain.bit`) && existsSync(`${RAW_ROOT}/missions/location0/level1/objects.qvm`);

/** Brute-force nearest hit (same face test and ordering, no sphere tree) to check the tree walk. */
function bruteForce(set: CollisionSet, from: Vec3, to: Vec3): { face: number; t: number } | null {
  let best: { face: number; t: number; distance: number; front: boolean } | null = null;
  const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const len = Math.hypot(...d);
  const p = set.positions;
  for (let f = 0; f < set.faces.length / 3; f++) {
    if (set.surfaces[set.faceSurface[f]].portal !== -1) continue;
    const [a, b, c] = [0, 1, 2].map((k) => set.faces[f * 3 + k] * 3);
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    // Möller-Trumbore
    const pv = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
    if (Math.abs(det) < 1e-12) continue;
    const s = [from[0] - p[a], from[1] - p[a + 1], from[2] - p[a + 2]];
    const u = (s[0] * pv[0] + s[1] * pv[1] + s[2] * pv[2]) / det;
    if (u < 0 || u > 1) continue;
    const qv = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]) / det;
    if (v < 0 || u + v > 1) continue;
    const t = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) / det;
    if (t < 0 || t > 1) continue;
    const n = faceNormal(set, f);
    const candidate = { face: f, t, distance: t * len, front: n[0] * d[0] + n[1] * d[1] + n[2] * d[2] < 0 };
    if (hitReplaces(candidate, best)) best = candidate;
  }
  return best;
}

describe.skipIf(!haveModels)("HSMC collision meshes (all 601 model files)", () => {
  const models = new Map<string, CollisionModel | null>();
  let files = 0;
  beforeAll(async () => {
    for (const archive of ARCHIVES) {
      for (const member of readIlffMembers(await readRaw(archive))) {
        if (!member.name.toLowerCase().endsWith(".mef")) continue;
        files++;
        const name = member.name.split("/").pop()!.slice(0, -4).toLowerCase();
        const model = readCollisionModel(member.payload, 24); // throws on any bad index or tree
        if (!models.has(name)) models.set(name, model); // level archive first, as level.ts
      }
    }
  });

  it("decodes every file; every _1 model has collision and no LOD _2+ model does", () => {
    expect(files).toBe(601);
    expect(models.size).toBe(592);
    let withCollision = 0;
    for (const [name, model] of models) {
      const lod = /_(\d+)$/.exec(name)?.[1];
      if (lod && lod !== "1") expect(model, name).toBeNull();
      else expect(model, name).not.toBeNull();
      if (model) withCollision++;
    }
    expect(withCollision).toBe(246);
  });

  it("set 1 is a HumanCollision hull wherever it exists", () => {
    const materials = new Map<number, number>();
    for (const model of models.values()) {
      for (const s of model?.sets[1].surfaces ?? []) materials.set(s.material, (materials.get(s.material) ?? 0) + 1);
    }
    expect(Object.fromEntries(materials)).toEqual({ [HUMAN_COLLISION_MATERIAL]: 121, [NO_MATERIAL]: 1 });
  });

  it("decodes 503_01_1 (a wall with a wooden frame) exactly", () => {
    const m = models.get("503_01_1")!;
    expect(m.modelType).toBe(3);
    const [s0, s1] = m.sets;
    expect([s0.faces.length / 3, s0.positions.length / 3, s0.surfaces.length, s0.spheres.length]).toEqual([52, 34, 6, 103]);
    expect([s1.faces.length / 3, s1.positions.length / 3, s1.surfaces.length, s1.spheres.length]).toEqual([12, 8, 1, 23]);
    expect(s0.surfaces[0]).toEqual({ transparency: 0, portal: -1, textureSlot: 0, material: 3 });
    expect(s0.surfaces[1]).toEqual({ transparency: 1, portal: -1, textureSlot: -1, material: NO_MATERIAL });
    expect(s1.surfaces[0]).toEqual({ transparency: 1, portal: -1, textureSlot: -1, material: HUMAN_COLLISION_MATERIAL });
    expect(s0.spheres[0]).toMatchObject({ firstFace: 0xffff, faceCount: 0, firstChild: 102, nextSibling: 0 });
    expect(s0.spheres[1]).toMatchObject({ firstFace: 0, faceCount: 1, firstChild: 0, nextSibling: 97 });
  });

  it("tags portal polygons of 400_02_1 with their portal ids", () => {
    const s0 = models.get("400_02_1")!.sets[0];
    const portals = s0.surfaces.filter((s) => s.portal >= 0).map((s) => s.portal).sort();
    expect(portals).toEqual([0, 3, 4]);
    for (const s of s0.surfaces.filter((x) => x.portal >= 0)) expect(s.material).toBe(NO_MATERIAL);
  });

  it("finds the nearest wall face with its material and side", () => {
    const [s0, s1] = models.get("503_01_1")!.sets;
    const hit = raycastCollisionSet(s0, [2000, 2000, 4000], [2000, -2000, 4000])!;
    expect(hit.front).toBe(true);
    expect(hit.material).toBe(3); // Wood
    expect(hit.point[1]).toBeCloseTo(58.8, 0);
    expect(hit.normal[1]).toBeGreaterThan(0.99);
    const back = raycastCollisionSet(s0, [2000, 0, 4000], [2000, 2000, 4000])!; // from inside the wall slab
    expect(back.front).toBe(false);
    const hull = raycastCollisionSet(s1, [2000, 2000, 4000], [2000, -2000, 4000])!;
    expect(hull.material).toBe(HUMAN_COLLISION_MATERIAL);
    expect(hull.point[1]).toBeCloseTo(914.6, 0); // the hull stands ~0.21 m off the 58.8-unit face
    expect(raycastCollisionSet(s0, [9000, 2000, 4000], [9000, -2000, 4000])).toBeNull();
  });

  it("reports untagged faces as Ground", () => {
    const s0 = models.get("503_01_1")!.sets[0];
    // face 4/5 is the untagged underside at z = 55
    const hit = raycastCollisionSet(s0, [2000, 0, -1000], [2000, 0, 2000])!;
    expect(hit.surface.material).toBe(NO_MATERIAL);
    expect(hit.material).toBe(UNTAGGED_RAY_MATERIAL);
  });

  it("sphere-tree walk returns the brute-force nearest face on random rays", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    let hits = 0;
    for (const name of ["400_01_1", "622_01_1", "203_01_1", "000_01_1", "503_01_1"]) {
      const model = models.get(name)!;
      for (const set of model.sets) {
        if (set.spheres.length === 0) continue;
        const r = set.spheres[0].radius;
        const c = set.spheres[0].center;
        for (let i = 0; i < 200; i++) {
          const from: Vec3 = [c[0] + (rnd() - 0.5) * 3 * r, c[1] + (rnd() - 0.5) * 3 * r, c[2] + (rnd() - 0.5) * 3 * r];
          const to: Vec3 = [c[0] + (rnd() - 0.5) * 3 * r, c[1] + (rnd() - 0.5) * 3 * r, c[2] + (rnd() - 0.5) * 3 * r];
          const tree = raycastCollisionSet(set, from, to);
          const brute = bruteForce(set, from, to);
          expect(tree === null, `${name} ray ${i}`).toBe(brute === null);
          if (tree && brute) {
            expect(tree.t).toBeCloseTo(brute.t, 6);
            hits++;
          }
        }
      }
    }
    expect(hits).toBeGreaterThan(300);
  });
});

describe.skipIf(!haveMaterial)("material.qvm surface materials", () => {
  let materials: SurfaceMaterial[];
  beforeAll(async () => {
    materials = readSurfaceMaterials(await readRaw("material/material.qvm"));
  });

  it("has 24 materials in SetActiveMaterial order", () => {
    expect(materials.map((m) => m.name)).toEqual([
      "Air", "Ground", "Water", "Wood", "Carton", "StrongMetal", "NormalMetal", "SoftMetal", "Flesh", "BloodyFlesh",
      "Textiles", "Concrete", "Runway", "Rug", "Glass", "Plastic", "Porcelain", "Rubber", "Fence", "Gravel", "Snow",
      "HumanCollision", "MetalLadder", "MetalFence",
    ]);
  });

  it("carries the values the collision rules use", () => {
    const by = (name: string) => materials.find((m) => m.name === name)!;
    expect(by("Gravel")).toMatchObject({ index: 19, footstepRangeM: 10, hardness: 10, ricochetDeg: 30, seeThrough: 0 });
    expect(by("Ground")).toMatchObject({ index: 1, footstepRangeM: 1, hardness: 10, ricochetDeg: 5 });
    expect(by("Glass").seeThrough).toBe(1);
    expect(by("Fence").seeThrough).toBeCloseTo(0.8, 6);
    expect(by("Concrete").effects[0].decals).toEqual(["bullethole_concrete.tex", "dent_concrete.tex"]);
    expect(by("Wood").walk[0]).toBe("walk_wood_1");
    expect(by("HumanCollision").index).toBe(HUMAN_COLLISION_MATERIAL);
  });

  it("sight passes glass and one fence, not two fences or concrete", () => {
    const see = (i: number) => materials[i].seeThrough;
    const glass = 14;
    const fence = 18;
    const concrete = 11;
    const pane = sightTransmission([{ material: glass, front: true }, { material: glass, front: false }], see);
    expect(pane).toEqual({ blocked: true, transmission: 1 });
    expect(aiSightPasses(pane)).toBe(true);
    const oneFence = sightTransmission([{ material: fence, front: true }], see);
    expect(oneFence.transmission).toBeCloseTo(0.8, 6);
    expect(aiSightPasses(oneFence)).toBe(true);
    const twoFences = sightTransmission([{ material: fence, front: true }, { material: fence, front: true }], see);
    expect(twoFences.transmission).toBeLessThan(AI_SIGHT_MIN_TRANSMISSION);
    expect(aiSightPasses(twoFences)).toBe(false);
    expect(aiSightPasses(sightTransmission([{ material: concrete, front: true }], see))).toBe(false);
    expect(aiSightPasses(sightTransmission([{ material: NO_MATERIAL, front: true }], see))).toBe(false);
    expect(aiSightPasses(sightTransmission([], see))).toBe(true);
  });
});

describe.skipIf(!haveTerrain)("terrain material lookup (level 1)", () => {
  let lookup: TerrainMaterialLookup;
  let modifiers: TerrainModifierInput[];
  let mapping: Map<number, number>;
  beforeAll(async () => {
    mapping = readTerrainGameMaterials(await readRaw(`${TERRAIN}/terrain.qvm`));
    const tasks = flattenTasks(readTaskTree(readQvmCallTree(await readRaw("missions/location0/level1/objects.qvm"))));
    modifiers = tasks
      .filter((t) => t.type === "TextureModifier")
      .map((t) => ({
        position: vec3Param(t, "Position")!,
        level: numberParam(t, "Level")!,
        material: numberParam(t, "Material Index")!,
        bitmapId: numberParam(t, "Bitmap ID")!,
      }));
    lookup = new TerrainMaterialLookup(modifiers, await readRaw(`${TERRAIN}/terrain.bit`), mapping);
  });

  it("maps every terrain material to Ground", () => {
    expect([...mapping.entries()]).toEqual([[0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1]]);
  });

  it("matches tools/igi_collision.py on a 4 m grid over the modifier boxes", () => {
    const boxes = modifiers.map((m) => {
      const full = 2 * (2 ** 30 / 2 ** m.level);
      return [Math.floor(m.position[0] / full) * full, Math.floor(m.position[1] / full) * full, full];
    });
    const xs = boxes.flatMap(([x, , f]) => [x, x + f]);
    const ys = boxes.flatMap(([, y, f]) => [y, y + f]);
    const counts = new Map<number, number>();
    const games = new Set<number>();
    for (let x = Math.min(...xs); x < Math.max(...xs); x += 16384) {
      for (let y = Math.min(...ys); y < Math.max(...ys); y += 16384) {
        const id = lookup.terrainMaterialAt(x + 0.5, y + 0.5);
        counts.set(id, (counts.get(id) ?? 0) + 1);
        games.add(lookup.gameMaterialAt(x + 0.5, y + 0.5));
      }
    }
    expect(Object.fromEntries(counts)).toEqual({ 0: 529857, 1: 51905, 4: 3289, 5: 4773 });
    expect([...games]).toEqual([1]);
  });
});

describe("collision rule helpers", () => {
  it("builds the three sweep rays with the skin extension", () => {
    const rays = characterSweepRays([0, 0, 100], [1000, 0, 0], false);
    expect(rays.map((r) => r.from[2] - 100)).toEqual([409.6, 1638.4, 7372.8]);
    expect(rays[0].to[0]).toBeCloseTo(1010.24, 6);
    expect(characterSweepRays([0, 0, 0], [0, 500, 0], true).map((r) => r.height)).toEqual([409.6, 819.2, 5324.8]);
    expect(characterSweepRays([0, 0, 0], [0, 0, 0], false)).toEqual([]);
  });

  it("treats only near-vertical faces as walls and slides along them", () => {
    expect(flattenWallNormal([0, 0, 1])).toBeNull();
    expect(flattenWallNormal([0.2, 0, 0.9798])).toBeNull();
    const n = flattenWallNormal([0, -0.995, 0.0999])!;
    expect(n[0]).toBeCloseTo(0, 9);
    expect(n[1]).toBeCloseTo(-1, 9);
    expect(n[2]).toBe(0);
    // moving +y into a wall facing -y at y = 1000, hit at (100, 1000)
    const end = slideOnWall([0, 0, 0], [200, 1500, 0], [100, 1000, 0], [0, -1, 0])!;
    expect(end[0]).toBeCloseTo(200, 9);
    expect(end[1]).toBeCloseTo(1000 - CHARACTER_SWEEP.skin, 9);
    expect(slideOnWall([0, 0, 0], [0, -500, 0], [0, 1000, 0], [0, -1, 0])).toBeNull();
  });

  it("orders hits inside the 0.1-unit window front-first", () => {
    expect(hitReplaces({ distance: 5, front: false }, null)).toBe(true);
    expect(hitReplaces({ distance: 4.85, front: false }, { distance: 5, front: true })).toBe(true);
    expect(hitReplaces({ distance: 4.95, front: false }, { distance: 5, front: true })).toBe(false);
    expect(hitReplaces({ distance: 5.05, front: true }, { distance: 5, front: false })).toBe(true);
    expect(hitReplaces({ distance: 5.05, front: true }, { distance: 5, front: true })).toBe(false);
    expect(hitReplaces({ distance: 5.2, front: true }, { distance: 5, front: false })).toBe(false);
  });
});
