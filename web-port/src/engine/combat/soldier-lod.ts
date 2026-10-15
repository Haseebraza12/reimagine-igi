/**
 * Level of detail for soldier bone models (docs/characters.md "Bone-model
 * LOD").
 *
 * Recovered:
 *   - DrawBoneMesh (FUN_0052fc20) asks FUN_004c4fc0 for the LOD of the bone
 *     object (object +0xd4 != 0; the first-person arms set 0 and always draw
 *     LOD 0): -1 = not drawn, else variant i of the object's LOD set
 *     (<base>_1 .. <base>_n) is skinned by FUN_0052be70 with that index:
 *     LOD 0 weighted with the extra influences, LOD >= 1 rigid.
 *   - FUN_004c4fc0 with a lod.qvm ModelLODSettings entry: z = camera-forward
 *     depth of (object position + the model's sphere centre, unrotated),
 *     r = model radius (record +0x78), d = t (z - r) with t = tan(horizontal
 *     half-FOV); not drawn when d > cutoff; LOD = number of "Distance to LOD
 *     i" values below d (selectLodExplicit). Level-1 soldier models (000,
 *     001, 003, 019_01_1): 001/003/019 at 5 / 9 / 40 / 50 m, cut off at 80 m;
 *     000_01_1 at 80 / 90 / 100 / 110 m, cut off at 120 m (observed lod.qvm).
 * Inferred:
 *   - The model record's sphere is the .mef HSEM chunk: centre = words 12..14
 *     (+0x30, the offset FUN_004c4fc0 reads) and radius = word 30 (+0x78);
 *     003_01_1: centre (-31, -85, -180) units, radius 3778 units (0.92 m).
 *   - Models without a lod.qvm entry (015_01_1) stay at LOD 0 (the relative
 *     rule's constants for bone objects were not traced).
 */
import type { IAssetSource } from "../../contracts";
import {
  LEVEL1_PATHS,
  flattenTasks,
  readIlffMembers,
  readModelLodTable,
  readMtp,
  readQvmCallTree,
  readTaskTree,
  selectLodExplicit,
  type IgiLevel,
  type IgiLevelPaths,
} from "../../loaders";

export interface SoldierLodVariant {
  name: string;
  buffer: ArrayBuffer;
  /** Texture keys of the level (`<archive>:<texture>`) per material slot, null when missing. */
  textureKeys: (string | null)[];
}

export interface SoldierLodSet {
  /** Variants 1.. (variant 0 is the soldier's own model in IgiLevel.boneModels). */
  variants: SoldierLodVariant[];
  /** lod.qvm distances [LOD1..LOD4, cutoff] in metres (non-decreasing), or null. */
  explicit: number[] | null;
  /** HSEM sphere of variant 0: centre in IGI units (object space, unrotated) and radius (units). */
  centre: [number, number, number];
  radius: number;
}

function baseName(virtualName: string): string {
  const slash = virtualName.lastIndexOf("/");
  const file = slash >= 0 ? virtualName.slice(slash + 1) : virtualName;
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

/** HSEM sphere of a .mef (ILFF/OCEM chunk walk as tools/igi_anim.py mef_chunks) [layout inferred]. */
export function mefSphere(buffer: ArrayBuffer): { centre: [number, number, number]; radius: number } | null {
  const view = new DataView(buffer);
  const tag = (o: number) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (buffer.byteLength < 20 || tag(0) !== "ILFF" || tag(16) !== "OCEM") return null;
  const align = view.getUint32(8, true);
  let pos = (20 + align - 1) & -align;
  for (let guard = 0; guard < 64 && pos + 16 <= buffer.byteLength; guard++) {
    const t = tag(pos);
    const size = view.getUint32(pos + 4, true);
    const al = view.getUint32(pos + 8, true) || 1;
    const delta = view.getUint32(pos + 12, true);
    const off = (pos + 16 + al - 1) & -al;
    if (t === "HSEM") {
      if (size < 31 * 4 || off + size > buffer.byteLength) return null;
      return {
        centre: [view.getFloat32(off + 48, true), view.getFloat32(off + 52, true), view.getFloat32(off + 56, true)],
        radius: view.getFloat32(off + 120, true),
      };
    }
    if (delta === 0) break;
    pos += delta;
  }
  return null;
}

/** Load the LOD variants, lod.qvm distances and spheres of the given soldier models. */
export async function loadSoldierLods(raw: IAssetSource, level: IgiLevel, models: Iterable<string>, paths: IgiLevelPaths = LEVEL1_PATHS): Promise<Map<string, SoldierLodSet>> {
  const wanted = new Set(models);
  const out = new Map<string, SoldierLodSet>();
  if (wanted.size === 0) return out;
  const payloads = new Map<string, SoldierLodVariant>();
  for (const archive of paths.archives) {
    if (!(await raw.exists(archive.models)) || !(await raw.exists(archive.mtp))) continue;
    const mtp = readMtp(await raw.readBinary(archive.mtp));
    for (const member of readIlffMembers(await raw.readBinary(archive.models))) {
      const name = baseName(member.name);
      if (payloads.has(name)) continue; // earlier archives win (as the level loader)
      const textureKeys = (mtp.modelTextures.get(name) ?? []).map((t) => {
        const key = `${archive.id}:${t}`;
        return level.textures.has(key) ? key : null;
      });
      payloads.set(name, { name, buffer: member.payload, textureKeys });
    }
  }
  let explicitTable = new Map<string, number[]>();
  if (await raw.exists("lod.qvm")) {
    explicitTable = readModelLodTable(flattenTasks(readTaskTree(readQvmCallTree(await raw.readBinary("lod.qvm")))));
  }
  for (const model of wanted) {
    const m = /^(.*)_(\d+)$/.exec(model);
    const variants: SoldierLodVariant[] = [];
    if (m) {
      for (let k = Number(m[2]) + 1; payloads.has(`${m[1]}_${k}`); k++) variants.push(payloads.get(`${m[1]}_${k}`)!);
    }
    const own = level.boneModels.get(model);
    const sphere = own ? mefSphere(own.buffer) : null;
    out.set(model, {
      variants,
      explicit: explicitTable.get(model) ?? null,
      centre: sphere?.centre ?? [0, 0, 0],
      radius: sphere?.radius ?? 4096,
    });
  }
  return out;
}

/**
 * FUN_004c4fc0 for a soldier: LOD index (0 = finest) or -1 (not drawn).
 * depthM = camera-forward depth of the object position + sphere centre;
 * tanX = tan(horizontal half-FOV) of the current camera.
 */
export function soldierLod(set: SoldierLodSet | null, lodCount: number, depthM: number, tanX: number, detail = 1): number {
  if (!set || !set.explicit || lodCount <= 0) return 0;
  const i = selectLodExplicit(depthM, set.radius / 4096, set.explicit, lodCount, tanX, detail);
  return i < 0 ? -1 : Math.min(i, lodCount - 1);
}
