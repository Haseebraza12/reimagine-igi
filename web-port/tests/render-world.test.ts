/**
 * Render integration on the staged level-1 files: DNER render flags (mef.ts),
 * LOD variants and their lightmaps (world/model-lods.ts), and the world build
 * (collision unchanged, per-instance LOD / cutoff culling).
 */
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { LEVEL1_PATHS, loadIgiLevel, readIlffMembers, readMef, type IgiLevel } from "../src/loaders";
import { loadModelLods, type ModelLodLibrary } from "../src/engine/world/model-lods";
import { buildWorld, type BuiltWorld } from "../src/engine/world/world-builder";
import { createMuzzleFlash } from "../src/engine/fx/muzzle-flash";
import { RAW_ROOT, readRaw } from "./helpers";

const haveArchives = LEVEL1_PATHS.archives.every((a) => existsSync(`${RAW_ROOT}/${a.models}`));

describe.skipIf(!haveArchives)("DNER render flags (all level-1 + location0 models)", () => {
  it("additive exactly on the GUNFLAME models and the explosion sprite; 817 deferred blocks (29 rigid, 3 bone, 785 lightmapped)", async () => {
    const additive = new Set<string>();
    const deferred = { 0: 0, 1: 0, 3: 0 } as Record<number, number>;
    const seen = new Set<string>();
    for (const archive of LEVEL1_PATHS.archives) {
      for (const member of readIlffMembers(await readRaw(archive.models))) {
        const name = member.name.replace(/^.*\//, "").replace(/\.[^.]*$/, "");
        if (seen.has(name)) continue;
        seen.add(name);
        const mef = readMef(member.payload);
        for (const g of mef.groups) {
          if (g.blendFlags & 1) additive.add(name);
          else if (g.deferredFlag !== 0) deferred[mef.modelType]++;
        }
      }
    }
    // (1000_01_2 is the LOD-2 variant of the AK47 flame 1000_01_1.)
    expect([...additive].sort()).toEqual(["1000_01_1", "1000_01_2", "1005_01_1", "1006_01_1", "1007_01_1", "1008_01_1", "1010_01_1"]);
    expect(deferred).toEqual({ 0: 29, 1: 3, 3: 785 });
  });
});

const haveLevel = existsSync(`${RAW_ROOT}/${LEVEL1_PATHS.objects}`);

describe.skipIf(!haveLevel)("world build with LOD variants (level 1)", () => {
  let level: IgiLevel;
  let lods: ModelLodLibrary;
  let world: BuiltWorld;
  beforeAll(async () => {
    const raw = createFsAssetSource(RAW_ROOT);
    level = await loadIgiLevel(raw);
    lods = await loadModelLods(raw, level);
    world = buildWorld(level, (b) => b.addIndexed(level.terrain.detail.positions, level.terrain.detail.indices), { lods });
  }, 120_000);

  it("loads LOD variants, explicit distances and variant lightmaps", () => {
    const fence = lods.info("303_01_1");
    expect(fence?.variants.map((v) => v.name)).toEqual(["303_01_1", "303_01_2", "303_01_3"]);
    expect(fence?.explicit).toEqual([5, 30, 40, 50, 200]);
    expect(fence?.variants[0].flags.map((f) => f.deferred)).toEqual([false, true, true, true, true]);
    const placed = new Set(level.instances.map((i) => i.model));
    expect([...placed].filter((m) => (lods.info(m)?.variants.length ?? 0) > 1).length).toBeGreaterThan(50);
    // Every decoded variant lightmap has the size its variant's PMTL asks for.
    let checked = 0;
    for (const instance of level.instances) {
      if (!instance.lightmap) continue;
      const info = lods.info(instance.model)!;
      info.variants.forEach((v, k) => {
        if (k === 0 || !v.lightmapSize) return;
        const name = lods.lightmapFor(instance.lightmap!, k);
        if (!name) return;
        const t = lods.lightmaps.get(name)!;
        expect([t.width, t.height]).toEqual(v.lightmapSize);
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("muzzle flash: GUNFLAME parts of the carried guns, none for the MP5SD", () => {
    expect(createMuzzleFlash(level, "WEAPON_ID_MP5SD")).toBeNull();
    const glock = createMuzzleFlash(level, "WEAPON_ID_GLOCK");
    expect(glock).not.toBeNull();
    const materials: THREE.Material[] = [];
    glock!.object.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m) materials.push(...(Array.isArray(m) ? m : [m]));
    });
    expect(materials.length).toBeGreaterThan(0);
    for (const m of materials) {
      expect([m.blendSrc, m.blendDst]).toEqual([THREE.OneFactor, THREE.OneFactor]); // ONE/ONE
      expect(m.depthWrite).toBe(false);
    }
    expect(glock!.object.visible).toBe(false);
    glock!.fire();
    glock!.update();
    expect(glock!.object.visible).toBe(true);
    glock!.update();
    expect(glock!.object.visible).toBe(false);
    glock!.dispose();
  });

  it("collides with the models' own HSMC sets plus the terrain", () => {
    // Set 0 (bullets / sight) and set 1 (characters; wires never) of every placed instance,
    // portal faces dropped by the loader; dynamic tasks' triangles live in their bodies, and so
    // do the destructible instances (glass, explosives; one rebuildable body, docs/damage.md).
    let expected = level.terrain.detail.indices.length / 3;
    let dynamic = 0;
    const dynamicTasks = new Set(world.dynamicTasks);
    level.instances.forEach((instance, i) => {
      const sets = level.models.get(instance.model)?.collision;
      if (!sets) return;
      const n = sets[0].indices.length / 3 + (instance.taskType === "Wire" ? 0 : sets[1].indices.length / 3);
      if (dynamicTasks.has(instance.taskId)) dynamic += n;
      else if (!world.destructibleInstances.has(i)) expected += n;
    });
    expect(dynamic).toBe(0); // built without dynamic tasks here
    expect(world.collision.triangleCount).toBe(expected);
    expect(world.collision.triangleCount).toBeGreaterThan(level.terrain.detail.indices.length / 3 + 40_000);
  });

  it("chooses LODs per instance and culls beyond the cutoff", () => {
    const camera = new THREE.PerspectiveCamera(73.74, 4 / 3, 0.1, 100_000);
    camera.position.set(level.player.position[0], level.player.position[1] + 1.7, level.player.position[2]);
    camera.lookAt(camera.position.x, camera.position.y, camera.position.z + 10);
    world.update(camera);
    const lodsAtSpawn = level.instances.map((_, i) => world.lodOf(i));
    expect(lodsAtSpawn.filter((l) => l === 0).length).toBeGreaterThan(50);
    expect(lodsAtSpawn.filter((l) => l > 0).length).toBeGreaterThan(10);
    expect(lodsAtSpawn.filter((l) => l < 0).length).toBeGreaterThan(10);
    // 20 km away, looking at the level: everything is past its cutoff. (Behind
    // the camera the view depth is negative and igi.exe's rule picks LOD 0;
    // frustum culling hides those.)
    camera.position.set(20_000, 100, 20_000);
    camera.lookAt(0, 0, 0);
    world.update(camera);
    expect(level.instances.every((_, i) => world.lodOf(i) === -1)).toBe(true);
    expect(world.group.children.every((c) => !c.visible)).toBe(true);
  });
});
