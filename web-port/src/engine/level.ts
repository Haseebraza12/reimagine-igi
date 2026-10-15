/**
 * Level bootstrap: read the ORIGINAL game files from the raw asset source,
 * decode them (loaders/level.ts) and build the renderable world, terrain,
 * environment and collision into the GameContext. Rendering follows the
 * recovered igi.exe rules (docs/rendering.md): sky/clouds/fog
 * (render/environment.ts), per-frame terrain LOD (world/terrain-render.ts), model
 * blocks with per-instance LOD (world/world-builder.ts, world/model-lods.ts)
 * and effect resources (fx/effects.ts).
 */
import type { DecodedTexture, IAssetSource } from "../contracts";
import {
  LEVEL1_PATHS,
  decodeTex,
  decodeTexLayers,
  loadIgiLevel,
  readIlffMembers,
  readImpactMaterials,
  readMipMapControl,
  readQvmCallTree,
  readSkyLayers,
  type ImpactMaterial,
} from "../loaders";
import type { IgiTask } from "../loaders";
import type { GameContext } from "./context";
import { applyEnvironment, type Environment } from "./render/environment";
import { addSceneHook } from "./render/scene-hooks";
import type { PlayArea } from "./world/character";
import { loadModelLods } from "./world/model-lods";
import { buildTerrain, type TerrainRender } from "./world/terrain-render";
import { buildWorld, type BuiltWorld } from "./world/world-builder";
import { vehicleRenderCopies } from "./world/vehicles";
import { TERRAIN_HIT_MATERIAL, TRI_BULLET, TRI_SIGHT, TRI_SOLID, TRI_TERRAIN } from "./world/collision";
import { createViewModels, type ViewModels } from "./render/viewmodel";
import { loadEffectAssets } from "./fx/effect-assets";

/** Effect textures (blob shadow, bullet holes) and impact materials (docs/rendering.md section 7). */
export const EFFECT_PATHS = {
  textures: "common/textures/textures.res",
  materials: "material/material.qvm",
};

/** Decoded textures.res members by file name ("shadow1.tex"); empty when the archive is not staged. */
async function readEffectTextures(raw: IAssetSource): Promise<Map<string, DecodedTexture>> {
  const out = new Map<string, DecodedTexture>();
  if (!(await raw.exists(EFFECT_PATHS.textures))) return out;
  for (const member of readIlffMembers(await raw.readBinary(EFFECT_PATHS.textures))) {
    const file = member.name.slice(member.name.lastIndexOf("/") + 1).toLowerCase();
    try {
      out.set(file, decodeTex(member.payload));
    } catch (error) {
      console.info(`[level] ${member.name}: ${(error as Error).message}`);
    }
  }
  return out;
}

async function readImpactTable(raw: IAssetSource): Promise<ImpactMaterial[]> {
  if (!(await raw.exists(EFFECT_PATHS.materials))) return [];
  try {
    return readImpactMaterials(readQvmCallTree(await raw.readBinary(EFFECT_PATHS.materials)));
  } catch (error) {
    console.info(`[level] material.qvm: ${(error as Error).message}`);
    return [];
  }
}

export interface LoadedLevel {
  world: BuiltWorld;
  terrain: TerrainRender;
  environment: Environment;
  viewModels: ViewModels;
  dispose(): void;
}

/** Task types whose models move at run time (docs/mission.md: Door, Train, Heli, Car). */
const MOVING_TASK_TYPES = new Set(["Door", "Train", "Heli", "Car"]);

/**
 * Keys of the tasks whose placed models can move or leave the world: doors and
 * vehicles (every train car), and every task inside a ConditionalContainer
 * (containers add and remove their subtrees, docs/mission.md). A key is the
 * task's pre-order index in the task tree (= IgiLevel.tasks index =
 * LevelInstance.taskIndex = MissionTasks node index), unique even for the
 * many tasks with id -1 (17 of 23 level-1 doors, most wagons). Their
 * collision is built as dynamic bodies with that id (world/collision.ts; a
 * body hit reports triangle = -1 - key) and their render entries can be
 * moved or hidden (world/world-builder.ts).
 */
export function dynamicTaskKeys(level: { taskRoots: IgiTask[] }): Set<number> {
  const out = new Set<number>();
  let index = 0;
  const walk = (task: IgiTask, inContainer: boolean) => {
    const key = index++;
    if (inContainer || MOVING_TASK_TYPES.has(task.type)) out.add(key);
    const container = inContainer || task.type === "ConditionalContainer";
    for (const child of task.children) walk(child, container);
  };
  for (const root of level.taskRoots) walk(root, false);
  return out;
}

/** Characters stay this far inside the edge of the full-detail terrain (metres). */
const PLAY_AREA_MARGIN = 2;

/** Horizontal extent of the collision terrain, shrunk by the margin. */
export function playAreaOf(positions: Float32Array): PlayArea {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!(maxX - minX > 2 * PLAY_AREA_MARGIN && maxZ - minZ > 2 * PLAY_AREA_MARGIN)) {
    throw new Error("level: the collision terrain is empty");
  }
  return {
    minX: minX + PLAY_AREA_MARGIN,
    maxX: maxX - PLAY_AREA_MARGIN,
    minZ: minZ + PLAY_AREA_MARGIN,
    maxZ: maxZ - PLAY_AREA_MARGIN,
  };
}

/** Files every boot needs; checked up front for a clear error message. */
export const REQUIRED_RAW_FILES = [
  LEVEL1_PATHS.objects,
  LEVEL1_PATHS.terrain.ctr,
  LEVEL1_PATHS.archives[0].models,
  LEVEL1_PATHS.magicObjects,
];

export async function missingRawFiles(raw: IAssetSource): Promise<string[]> {
  const missing: string[] = [];
  for (const path of REQUIRED_RAW_FILES) {
    if (!(await raw.exists(path))) missing.push(path);
  }
  return missing;
}

export async function loadLevel(
  ctx: GameContext,
  raw: IAssetSource,
  progress: (text: string) => void = () => {},
): Promise<LoadedLevel> {
  progress("Decoding mission data…");
  const level = await loadIgiLevel(raw);
  for (const warning of level.warnings) console.info(`[level] ${warning}`);

  // Sky, clouds, fog and lights first: terrain and objects share its fog uniforms.
  progress("Building sky…");
  const cloudTextures = new Map<string, DecodedTexture>();
  for (const layer of readSkyLayers(level.tasks)) {
    const path = layer.texturePath;
    if (!path || cloudTextures.has(path) || !(await raw.exists(path))) continue;
    cloudTextures.set(path, decodeTex(await raw.readBinary(path)));
  }
  const environment = applyEnvironment(ctx.scene, level, { cloudTextures, ticks: () => ctx.tick });
  // MipMapControl "LOD bias (Standard MipMapping)" -> D3DTSS_MIPMAPLODBIAS (level 1: -0.4) [recovered].
  const mipBias = { value: readMipMapControl(level.tasks)?.lodBias ?? 0 };

  progress("Building terrain…");
  const layers = decodeTexLayers(await raw.readBinary(LEVEL1_PATHS.terrain.tex));
  // Cells, levels and geomorphs are chosen per frame for the camera, as
  // igi.exe does (world/terrain-render.ts); collision keeps level 16 below.
  const terrain = buildTerrain(level.terrain.octree, level.terrain.look, layers, {
    fog: environment.fog,
    mipBias,
    origin: level.origin,
  });
  const removeTerrainHook = addSceneHook(ctx.scene, (_renderer, _scene, camera) => terrain.update(camera));

  progress("Reading model LODs…");
  const lods = await loadModelLods(raw, level);
  for (const warning of lods.warnings) console.info(`[level] ${warning}`);

  progress("Building world…");
  const world = buildWorld(
    level,
    (builder) => {
      // Terrain answers every query (sweep, ground probe, bullets, sight); its
      // stored winding faces up, so front hits report Ground [recovered 0x4c3520].
      builder.addIndexed(
        level.terrain.detail.positions,
        level.terrain.detail.indices,
        TRI_SOLID | TRI_BULLET | TRI_SIGHT | TRI_TERRAIN,
        TERRAIN_HIT_MATERIAL,
      );
    },
    { lods, fog: environment.fog, mipBias, dynamicTasks: dynamicTaskKeys(level), renderCopies: vehicleRenderCopies(level) },
  );
  // Model LOD / cutoff culling for the camera of every render of the world scene.
  const removeLodHook = addSceneHook(ctx.scene, (_renderer, _scene, camera) => world.update(camera));

  progress("Loading effects…");
  const [effectTextures, impactMaterials] = await Promise.all([readEffectTextures(raw), readImpactTable(raw)]);
  const effectAssets = await loadEffectAssets(raw, level, impactMaterials);
  ctx.systems.effects?.setLevelResources({ level, textures: effectTextures, impactMaterials, fog: environment.fog, mipBias, assets: effectAssets });

  const viewModels = createViewModels(level, environment.sun, environment.ambient);

  ctx.scene.add(terrain.group, world.group);
  ctx.level = level;
  ctx.world = world.collision;
  ctx.playArea = playAreaOf(level.terrain.detail.positions);
  const s = world.stats;
  console.info(
    `[level] ${level.name}: ${s.instances} placed models (${s.instancesWithLods} with LOD variants, ${s.lodEntries} blocks over all LODs), ` +
      `${s.triangles} model triangles, per-frame terrain LOD (${level.terrain.look.lightmaps.length} lightmaps), ` +
      `${s.batches - s.blendedBatches} opaque + ${s.blendedBatches} deferred/additive batches, ${world.collision.triangleCount} collision triangles`,
  );

  return {
    world,
    terrain,
    environment,
    viewModels,
    dispose() {
      removeLodHook();
      removeTerrainHook();
      ctx.systems.effects?.setLevelResources(null);
      ctx.scene.remove(terrain.group, world.group);
      ctx.world = null;
      ctx.playArea = null;
      terrain.dispose();
      world.dispose();
      environment.dispose();
      viewModels.dispose();
    },
  };
}
