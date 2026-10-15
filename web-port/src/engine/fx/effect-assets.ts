/**
 * Extra original files the gun / impact effects need beyond IgiLevel
 * (docs/rendering.md section 7), read from the user's game files:
 *   - common/sprites/sprites.res: concrete1.spr (dust), blood1.spr (blood
 *     puff, 7 frames), blood2.spr (droplet) [names: FUN_00437610, FUN_0045d170],
 *     smoke2.spr (explosion smoke) and smoke1.spr (flash grenade),
 *     alarmlight.spr (the SCamera light: 16 x 16, one frame);
 *   - ammo/<dir>/ammo.qvm (DefineAmmoType, loaded from "LOCAL:ammo" by
 *     FUN_0047b3d0): tracer flag and colours per calibre;
 *   - the fragment models of material.qvm (1009/1011/1012/1013_01_1) and the
 *     WeaponConfig "Casing Model"s (113_01_1, SPAS12 109_03_1) from the
 *     level's model archives, with their textures' keys;
 *   - each gun model's point 3 (the casing ejection point,
 *     FUN_00486e20(.., gun, 3) at 0x477b7e): FUN_004c5aa0 reads 16-byte
 *     entries at model +0x88 (count +0x7c) = the .mef XTVM chunk (x, y, z,
 *     pad); guns have 4 or 6 points, point 2 = the muzzle, 3 = the ejection
 *     port (AK47 100_01_1: (-0.3, 767.4, 49.9) units) [observed values].
 * engine/level.ts passes the result to effects.setLevelResources (hook).
 */
import type { IAssetSource, Vec3 } from "../../contracts";
import {
  IGI_UNITS_PER_METRE,
  LEVEL1_PATHS,
  flattenTasks,
  igiDirToEngine,
  readAmmoTypes,
  readIlffMembers,
  readMef,
  readMtp,
  readQvmCallTree,
  readTaskTree,
  readUiSprite,
  type AmmoType,
  type IgiLevel,
  type IgiLevelPaths,
  type ImpactMaterial,
  type UiSprite,
} from "../../loaders";

/** Geometry of an effect model in engine space (metres, y up, CCW faces). */
export interface EffectModel {
  name: string;
  positions: Float32Array;
  normals: Float32Array;
  uv: Float32Array;
  indices: Uint32Array;
  groups: Array<{ start: number; count: number; texture: string | null; deferred: boolean; additive: boolean }>;
}

export interface EffectAssets {
  /** Sprites by lower-case file name ("concrete1.spr"). */
  sprites: Map<string, UiSprite>;
  /** Every DefineAmmoType found. */
  ammo: AmmoType[];
  /** Fragment and casing models by name. */
  models: Map<string, EffectModel>;
  /** WeaponConfig "Script ID" -> "Casing Model" (empty = none). */
  casingModels: Map<string, string>;
  /** Gun model -> XTVM point 3 (engine metres, gun-model space), when the model has one. */
  ejectionPoints: Map<string, Vec3>;
}

export const EFFECT_ASSET_PATHS = {
  sprites: "common/sprites/sprites.res",
  /** "LOCAL:ammo" holds one directory per ammo type; observed names: 12 127 357 44 556 762 919 DRAGUNOV FLASHBANG GRENADE M203 MEDIPACK PROXIMITYMINE. */
  ammoDirs: ["12", "127", "357", "44", "556", "762", "919", "DRAGUNOV", "FLASHBANG", "GRENADE", "M203", "MEDIPACK", "PROXIMITYMINE"],
  ammo: (dir: string) => `ammo/${dir}/ammo.qvm`,
} as const;

/** smoke2.spr: ExplosionSmoke (DAT_005c4510); smoke1.spr: the FlashBang puff (DAT_005c44fc) [recovered FUN_0047e520, FUN_0047ca70]. */
/** alarmlight.spr: the SCamera light (FUN_004158c0 at 0x440635; fx/alarm-lights.ts). */
const SPRITES = ["concrete1.spr", "concrete2.spr", "blood1.spr", "blood2.spr", "smoke2.spr", "smoke1.spr", "alarmlight.spr"];

const baseName = (name: string) => name.slice(name.lastIndexOf("/") + 1).toLowerCase();
/** Archive member -> model name, as loaders/level.ts names them (no extension, case kept). */
const modelName = (name: string) => {
  const file = name.slice(name.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
};

async function readSprites(raw: IAssetSource): Promise<Map<string, UiSprite>> {
  const out = new Map<string, UiSprite>();
  if (!(await raw.exists(EFFECT_ASSET_PATHS.sprites))) return out;
  for (const m of readIlffMembers(await raw.readBinary(EFFECT_ASSET_PATHS.sprites))) {
    const file = baseName(m.name);
    if (!SPRITES.includes(file)) continue;
    try {
      out.set(file, readUiSprite(m.payload, file));
    } catch (error) {
      console.info(`[effects] ${m.name}: ${(error as Error).message}`);
    }
  }
  return out;
}

async function readAmmo(raw: IAssetSource): Promise<AmmoType[]> {
  const out: AmmoType[] = [];
  for (const dir of EFFECT_ASSET_PATHS.ammoDirs) {
    const path = EFFECT_ASSET_PATHS.ammo(dir);
    if (!(await raw.exists(path))) continue;
    try {
      out.push(...readAmmoTypes(readQvmCallTree(await raw.readBinary(path))));
    } catch (error) {
      console.info(`[effects] ${path}: ${(error as Error).message}`);
    }
  }
  return out;
}

/** WeaponConfig "Casing Model" and "Gun Model" per Script ID. */
async function readWeaponModels(raw: IAssetSource, path: string): Promise<{ casing: Map<string, string>; gun: Map<string, string> }> {
  const casing = new Map<string, string>();
  const gun = new Map<string, string>();
  if (!(await raw.exists(path))) return { casing, gun };
  for (const task of flattenTasks(readTaskTree(readQvmCallTree(await raw.readBinary(path))))) {
    if (task.type !== "WeaponConfig") continue;
    const id = task.params["Script ID"];
    if (typeof id !== "string") continue;
    const c = task.params["Casing Model"];
    const g = task.params["Gun Model"];
    casing.set(id, typeof c === "string" ? c : "");
    if (typeof g === "string" && g) gun.set(id, g);
  }
  return { casing, gun };
}

/**
 * The XTVM chunk of a .mef ("magic vertices": 16 bytes each, x y z in model
 * units + 4 pad bytes), walking the OCEM chunk chain like loaders/mef.ts.
 */
export function readMefPoints(buffer: ArrayBuffer): Vec3[] {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (bytes.length < 20 || tag(0) !== "ILFF" || tag(16) !== "OCEM") return [];
  const align = (v: number, a: number) => (a > 0 ? Math.ceil(v / a) * a : v);
  let pos = align(20, view.getUint32(8, true));
  for (let guard = 0; guard < 64 && pos + 16 <= bytes.length; guard++) {
    const size = view.getUint32(pos + 4, true);
    const offset = align(pos + 16, view.getUint32(pos + 8, true));
    const delta = view.getUint32(pos + 12, true);
    if (tag(pos) === "XTVM") {
      const out: Vec3[] = [];
      for (let o = offset; o + 12 <= offset + size && o + 12 <= bytes.length; o += 16) {
        out.push([view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)]);
      }
      return out;
    }
    if (delta === 0) break;
    pos += delta;
  }
  return [];
}

/** Read the effect assets for `level` (missing files leave the matching effect out). */
export async function loadEffectAssets(
  raw: IAssetSource,
  level: Pick<IgiLevel, "weapons">,
  impactMaterials: readonly ImpactMaterial[],
  paths: IgiLevelPaths = LEVEL1_PATHS,
): Promise<EffectAssets> {
  const [sprites, ammo, weaponModels] = await Promise.all([readSprites(raw), readAmmo(raw), readWeaponModels(raw, paths.weaponConfig)]);
  const wanted = new Set<string>();
  for (const m of impactMaterials) for (const e of m.effects) if (e.flagB && e.model) wanted.add(e.model);
  // Every configured weapon (IgiLevel.weapons is the whole weaponconfig table).
  const carried = [...level.weapons.keys()];
  for (const id of carried) {
    const c = weaponModels.casing.get(id);
    if (c) wanted.add(c);
  }
  const guns = new Set<string>();
  for (const id of carried) {
    const g = weaponModels.gun.get(id);
    if (g) guns.add(g);
  }
  const models = new Map<string, EffectModel>();
  const ejectionPoints = new Map<string, Vec3>();
  for (const archive of paths.archives) {
    if (!(await raw.exists(archive.models)) || !(await raw.exists(archive.mtp))) continue;
    const mtp = readMtp(await raw.readBinary(archive.mtp));
    for (const member of readIlffMembers(await raw.readBinary(archive.models))) {
      const name = modelName(member.name);
      const isGun = guns.has(name) && !ejectionPoints.has(name);
      if ((!wanted.has(name) || models.has(name)) && !isGun) continue;
      let mef;
      try {
        mef = readMef(member.payload);
      } catch (error) {
        console.info(`[effects] model ${name}: ${(error as Error).message}`);
        continue;
      }
      if (isGun) {
        const point = readMefPoints(member.payload)[3];
        if (point) {
          const p = igiDirToEngine(point);
          ejectionPoints.set(name, [p[0] / IGI_UNITS_PER_METRE, p[1] / IGI_UNITS_PER_METRE, p[2] / IGI_UNITS_PER_METRE]);
        }
      }
      if (!wanted.has(name) || models.has(name)) continue;
      const count = mef.positions.length / 3;
      const positions = new Float32Array(count * 3);
      const normals = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const p = igiDirToEngine([mef.positions[i * 3], mef.positions[i * 3 + 1], mef.positions[i * 3 + 2]]);
        const n = igiDirToEngine([mef.normals[i * 3], mef.normals[i * 3 + 1], mef.normals[i * 3 + 2]]);
        for (let k = 0; k < 3; k++) {
          positions[i * 3 + k] = p[k] / IGI_UNITS_PER_METRE;
          normals[i * 3 + k] = n[k];
        }
      }
      const textures = mtp.modelTextures.get(name) ?? [];
      models.set(name, {
        name,
        positions,
        normals,
        uv: mef.uv,
        indices: mef.indices,
        groups: mef.groups.map((g) => {
          const t = g.materialSlot >= 0 ? textures[g.materialSlot] : undefined;
          return { start: g.start, count: g.count, texture: t ? `${archive.id}:${t}` : null, deferred: g.deferredFlag !== 0, additive: (g.blendFlags & 1) !== 0 };
        }),
      });
    }
  }
  return { sprites, ammo, models, casingModels: weaponModels.casing, ejectionPoints };
}
