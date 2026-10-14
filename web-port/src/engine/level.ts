/**
 * Level loader — populate a GameContext from converted web assets.
 *
 * Loads, in order: manifest.json, terrain (heights/lightmap/texture), sky,
 * navigation graph, player spawn, objectives, and a default weapon. Every step
 * is best-effort so a partially-converted level still boots (docs/loader-api.md
 * requires the engine to boot even without assets). Original files are read
 * only through the raw asset source; converted output through the assets source.
 */
import {
  DEFAULT_PLAYER_TUNING,
  DEFAULT_WEAPONS,
  type NavGraph,
  type Vec3,
} from "../contracts";
import { createHttpAssetSource, loadTerrain, loadLevelManifest } from "../loaders";
import type { GameContext } from "./context";
import { TerrainField } from "./terrain";
import { buildTerrainMesh } from "./render/terrainMesh";
import { buildSky } from "./render/sky";
import { TextureCache } from "./render/textures";

export interface LoadedLevel {
  textures: TextureCache;
}

/** Candidate paths for the top sky layer (pipeline naming may vary). */
const SKY_TOP_CANDIDATES = [
  "level1/textures/sky_layer2.png",
  "level1/textures/sky_layer1.png",
  "level1/sky_layer2.png",
  "level1/sky_layer1.png",
];

async function loadNav(assets: ReturnType<typeof createHttpAssetSource>, name: string): Promise<NavGraph | null> {
  try {
    if (!(await assets.exists(`${name}/nav.json`))) return null;
    const buffer = await assets.readBinary(`${name}/nav.json`);
    return JSON.parse(new TextDecoder().decode(buffer)) as NavGraph;
  } catch (error) {
    console.warn("[level] failed to load nav graph:", error);
    return null;
  }
}

export async function loadLevel(ctx: GameContext, name = "level1"): Promise<LoadedLevel> {
  const raw = createHttpAssetSource("/raw/");
  const assets = createHttpAssetSource("/assets/");
  ctx.raw = raw;
  ctx.assets = assets;
  ctx.tuning = DEFAULT_PLAYER_TUNING;

  const textures = new TextureCache(assets);
  const manifest = await loadLevelManifest(assets, name);
  ctx.manifest = manifest;
  ctx.nav = await loadNav(assets, name);

  if (manifest) {
    // --- Terrain -----------------------------------------------------------
    try {
      const terrainData = await loadTerrain(raw, assets, manifest.terrain);
      const offset: Vec3 = manifest.terrain.worldOffset ?? [0, 0, 0];
      ctx.terrain = new TerrainField(terrainData, offset);
      const terrainTex = await textures.load(`${name}/terrain.png`);
      ctx.scene.add(buildTerrainMesh(terrainData, offset, terrainTex));
    } catch (error) {
      console.warn("[level] terrain failed to load:", error);
    }

    // --- Sky (best-effort; fall back to the scene background colour) -------
    let skyTex = null;
    for (const candidate of SKY_TOP_CANDIDATES) {
      skyTex = await textures.load(candidate);
      if (skyTex) break;
    }
    const sky = buildSky(skyTex);
    if (sky) ctx.scene.add(sky);

    // --- Player spawn ------------------------------------------------------
    ctx.player.position = [...manifest.playerSpawn.position];
    if (ctx.terrain) {
      const ground = ctx.terrain.heightAt(ctx.player.position[0], ctx.player.position[2]);
      ctx.player.position[1] = Math.max(ctx.player.position[1], ground + 0.1);
    }
    ctx.player.yaw = (manifest.playerSpawn.yaw * Math.PI) / 180;

    // --- Objectives --------------------------------------------------------
    ctx.objectives = manifest.objectives.map((spec) => ({ spec, completed: false }));
  }

  // --- Default weapon (single-weapon slice; QVM weapon config is future work).
  if (!ctx.weapon && DEFAULT_WEAPONS.length > 0) {
    const spec = DEFAULT_WEAPONS[0];
    ctx.weapon = {
      spec,
      ammo: spec.magSize,
      reserve: 90,
      reloading: false,
      reloadRemaining: 0,
      cooldownRemaining: 0,
    };
  }

  return { textures };
}
