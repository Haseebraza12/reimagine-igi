/**
 * Model LOD variants, DNER render flags and LOD distances for the placed
 * models (docs/rendering.md sections 5-6).
 *
 * The level loader keeps only each placed model (its LOD 1, "<base>_1") and
 * drops the DNER flags, so this re-reads the model archives:
 *   - LOD variants: "<base>_2" ... "<base>_n" from the same archives, as the
 *     game's instance lists enumerate them (loaders/level.ts `lods`);
 *   - per block: deferred (s16 +0x16/+0x18 != 0) and additive (flag bit 0),
 *     loaders/mef.ts [recovered];
 *   - baked lightmaps of the variants: a building's instance list holds every
 *     LOD variant consecutively (emit(model) = model_1..model_n), so the .olm
 *     of LOD k is the LOD-1 entry's number + k - 1 [recovered list order,
 *     docs/formats.md "Object lighting"]; the size must equal the variant's
 *     PMTL size, else the variant falls back to vertex lighting;
 *   - explicit distances from lod.qvm ModelLODSettings (readModelLodTable) and
 *     the LODSettings task for the relative rule (readLodSettings).
 * Model radius / centre for the LOD metric: the bounding sphere of the LOD-1
 * vertices (box centre, farthest vertex) [approximation: the exact sphere
 * fields igi.exe reads are not traced].
 */
import type { DecodedTexture, IAssetSource, Vec3 } from "../../contracts";
import {
  IGI_UNITS_PER_METRE,
  LEVEL1_PATHS,
  decodeOlm,
  flattenTasks,
  igiDirToEngine,
  readIlffMembers,
  readLodSettings,
  readMef,
  readModelLodTable,
  readMtp,
  readQvmCallTree,
  readTaskTree,
  type IgiLevel,
  type IgiLevelPaths,
  type LevelModel,
  type LodSettings,
  type MefModel,
} from "../../loaders";

/** Render flags of one block (parallel to LevelModel.groups). */
export interface BlockFlags {
  deferred: boolean;
  additive: boolean;
}

export interface LodVariant {
  /** Model name ("438_01_2"). */
  name: string;
  model: LevelModel;
  flags: BlockFlags[];
  /** Triangle count (the relative rule's n_i). */
  faces: number;
  /** PMTL size of the variant's baked lightmap, or null. */
  lightmapSize: [number, number] | null;
}

export type LodKind = "rigid" | "spline" | "bone";

export interface ModelLodInfo {
  kind: LodKind;
  /** variants[0] is the placed model itself. */
  variants: LodVariant[];
  /** Bounding-sphere centre in model space (engine axes, metres) and radius (m). */
  centre: Vec3;
  radius: number;
  /** lod.qvm distances [LOD1..LOD4, cutoff] (m, non-decreasing), or null for the relative rule. */
  explicit: number[] | null;
}

export interface ModelLodLibrary {
  info(model: string): ModelLodInfo | null;
  /** Baked lightmap of LOD `lod` for an instance whose LOD-1 lightmap is `lod0Name`, or null (vertex-lit). */
  lightmapFor(lod0Name: string, lod: number): string | null;
  /** Variant lightmaps decoded here (LOD >= 2); LOD-1 ones are IgiLevel.lightmaps. */
  lightmaps: Map<string, DecodedTexture>;
  settings: LodSettings | null;
  warnings: string[];
}

/** .olm name of LOD `lod` (0-based) given the LOD-1 name "objNNNNN_MMMMM" (consecutive instance-list entries). */
export function lodLightmapName(lod0Name: string, lod: number): string | null {
  const m = /^(.*_)(\d{5})$/.exec(lod0Name);
  if (!m) return null;
  return `${m[1]}${String(Number(m[2]) + lod).padStart(5, "0")}`;
}

/** "438_01_1" -> ["438_01", 1]; null when the name has no numeric LOD suffix. */
export function splitLodName(name: string): [string, number] | null {
  const m = /^(.*)_(\d+)$/.exec(name);
  return m ? [m[1], Number(m[2])] : null;
}

/** Bounding sphere (box centre, farthest vertex) of engine-space positions. */
export function boundingSphereOf(positions: Float32Array): { centre: Vec3; radius: number } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (!(min[0] <= max[0])) return { centre: [0, 0, 0], radius: 0 };
  const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let r2 = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - centre[0];
    const dy = positions[i + 1] - centre[1];
    const dz = positions[i + 2] - centre[2];
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }
  return { centre, radius: Math.sqrt(r2) };
}

const flagsOf = (mef: MefModel): BlockFlags[] =>
  mef.groups.map((g) => ({ deferred: g.deferredFlag !== 0, additive: (g.blendFlags & 1) !== 0 }));

function baseName(virtualName: string): string {
  const slash = virtualName.lastIndexOf("/");
  const file = slash >= 0 ? virtualName.slice(slash + 1) : virtualName;
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

/** Engine-space LevelModel of a decoded .mef (same conversion as loaders/level.ts). */
function engineModel(name: string, source: MefModel, textureKeys: (string | null)[]): LevelModel {
  const count = source.positions.length / 3;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const p = igiDirToEngine([source.positions[i * 3], source.positions[i * 3 + 1], source.positions[i * 3 + 2]]);
    const n = igiDirToEngine([source.normals[i * 3], source.normals[i * 3 + 1], source.normals[i * 3 + 2]]);
    for (let k = 0; k < 3; k++) {
      positions[i * 3 + k] = p[k] / IGI_UNITS_PER_METRE;
      normals[i * 3 + k] = n[k];
    }
  }
  return {
    name,
    modelType: source.modelType,
    positions,
    normals,
    uv: source.uv,
    lightmapUv: source.lightmapUv,
    indices: source.indices,
    groups: source.groups.map((g) => ({ start: g.start, count: g.count, texture: textureKeys[g.materialSlot] ?? null })),
  };
}

export async function loadModelLods(raw: IAssetSource, level: IgiLevel, paths: IgiLevelPaths = level.paths ?? LEVEL1_PATHS): Promise<ModelLodLibrary> {
  const warnings: string[] = [];
  const payloads = new Map<string, { buffer: ArrayBuffer; textures: (string | null)[] }>();
  for (const archive of paths.archives) {
    if (!(await raw.exists(archive.models)) || !(await raw.exists(archive.mtp))) continue;
    const mtp = readMtp(await raw.readBinary(archive.mtp));
    for (const member of readIlffMembers(await raw.readBinary(archive.models))) {
      const name = baseName(member.name);
      if (payloads.has(name)) continue; // earlier archives win (as the loader)
      const textures = (mtp.modelTextures.get(name) ?? []).map((t) => {
        const key = `${archive.id}:${t}`;
        return level.textures.has(key) ? key : null;
      });
      payloads.set(name, { buffer: member.payload, textures });
    }
  }

  let explicitTable = new Map<string, number[]>();
  const lodPath = "lod.qvm";
  if (await raw.exists(lodPath)) {
    try {
      explicitTable = readModelLodTable(flattenTasks(readTaskTree(readQvmCallTree(await raw.readBinary(lodPath)))));
    } catch (error) {
      warnings.push(`lod.qvm: ${(error as Error).message}`);
    }
  } else {
    warnings.push("lod.qvm is not staged; every model uses the relative LODSettings rule");
  }

  const olm = new Map<string, ArrayBuffer>();
  if (await raw.exists(paths.lightmaps)) {
    for (const member of readIlffMembers(await raw.readBinary(paths.lightmaps))) olm.set(baseName(member.name), member.payload);
  }

  const decoded = new Map<string, MefModel | null>();
  const mef = (name: string): MefModel | null => {
    if (!decoded.has(name)) {
      const entry = payloads.get(name);
      let model: MefModel | null = null;
      if (entry) {
        try {
          model = readMef(entry.buffer);
        } catch (error) {
          warnings.push(`model ${name}: ${(error as Error).message}`);
        }
      }
      decoded.set(name, model);
    }
    return decoded.get(name) ?? null;
  };

  const infos = new Map<string, ModelLodInfo | null>();
  const placed = new Set(level.instances.map((i) => i.model));
  for (const name of placed) {
    const model = level.models.get(name);
    if (!model) continue;
    const colon = name.indexOf(":");
    const sourceName = colon >= 0 ? name.slice(colon + 1) : name;
    const sourceMef = mef(sourceName);
    let flags: BlockFlags[] = model.groups.map(() => ({ deferred: false, additive: false }));
    if (sourceMef && sourceMef.groups.length === model.groups.length) flags = flagsOf(sourceMef);
    else if (sourceMef) warnings.push(`${name}: ${model.groups.length} groups but ${sourceName} has ${sourceMef.groups.length} DNER blocks`);
    const variants: LodVariant[] = [
      {
        name,
        model,
        flags,
        faces: model.indices.length / 3,
        lightmapSize: sourceMef?.lightmapSizes[0] ?? null,
      },
    ];
    const kind: LodKind = colon >= 0 ? "spline" : model.modelType === 1 ? "bone" : "rigid";
    const split = colon >= 0 ? null : splitLodName(name);
    if (split) {
      const [base, first] = split;
      for (let k = first + 1; payloads.has(`${base}_${k}`); k++) {
        const vname = `${base}_${k}`;
        const vmef = mef(vname);
        if (!vmef) break;
        variants.push({
          name: vname,
          model: engineModel(vname, vmef, payloads.get(vname)!.textures),
          flags: flagsOf(vmef),
          faces: vmef.indices.length / 3,
          lightmapSize: vmef.lightmapSizes[0] ?? null,
        });
      }
    }
    const sphere = boundingSphereOf(model.positions);
    infos.set(name, {
      kind,
      variants,
      centre: sphere.centre,
      radius: sphere.radius,
      explicit: colon >= 0 ? null : explicitTable.get(name) ?? null,
    });
  }

  const lightmaps = new Map<string, DecodedTexture>();
  const lightmapCache = new Map<string, string | null>();
  return {
    info: (model) => infos.get(model) ?? null,
    lightmapFor(lod0Name, lod) {
      if (lod === 0) return lod0Name;
      const key = `${lod0Name}#${lod}`;
      if (lightmapCache.has(key)) return lightmapCache.get(key)!;
      let result: string | null = null;
      const name = lodLightmapName(lod0Name, lod);
      const payload = name ? olm.get(name) : undefined;
      if (name && payload) {
        try {
          lightmaps.set(name, lightmaps.get(name) ?? decodeOlm(payload));
          result = name;
        } catch (error) {
          warnings.push(`lightmap ${name}: ${(error as Error).message}`);
        }
      }
      lightmapCache.set(key, result);
      return result;
    },
    lightmaps,
    settings: readLodSettings(level.tasks),
    warnings,
  };
}
