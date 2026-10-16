/**
 * Per-weapon fields of weapons/weaponconfig.qvm that LevelWeapon does not
 * carry: the task types that pick igi.exe's per-type handlers, the
 * "selectable when empty" flag and the zoom TagItem children
 * (docs/weapons-view.md).
 *
 * Recovered (igi.exe):
 *   - "Weapon Task Type" selects the handler class: TASKTYPE_GUN (FUN_00476550,
 *     plain gun), TASKTYPE_GUNMP5SD (FUN_004721f0: zoom handler FUN_00472310),
 *     TASKTYPE_GUNDRAGUNOV (FUN_00471500: scope handler FUN_00471670, overlay
 *     FUN_00471860), TASKTYPE_MEDIPACK ("Medipack" FUN_0046efa0: use and
 *     reload methods are the empty stub FUN_00526660; tag reader FUN_0046f100),
 *     TASKTYPE_BINOCULAR (FUN_0046f1a0: handler FUN_0046f500, overlay
 *     FUN_0046f780 -> FUN_0046ff00).
 *   - "Projectile Task Type": TASKTYPE_GUNSHOT (bullet, FUN_00479870),
 *     TASKTYPE_KNIFESTAB (FUN_0046ca90: three 2 m rays, FUN_0046caf0) or
 *     TASKTYPE_GRENADE (FUN_004756c0, combat/grenade.ts; tag reader
 *     FUN_00474fe0); spawned by FUN_00413cd0 through weaponconfig +0x6d4.
 *   - TagItems are parsed by each type's weaponconfig callback (FUN_004072e0
 *     slot): GunMP5SD FUN_004724a0 and GunDRAGUNOV FUN_00471b50 read
 *     "Zoom - Min FOV (degrees)" (defaults 50 and 5 when absent), Binocular
 *     LAB_0046f930 reads "Binocular - Default / Max / Min FOV (degrees)"
 *     (defaults 70, 90, 5). Each is stored as tan(value / 2) in float32.
 * Observed (level 1, weaponconfig.qvm): MP5SD min 60; Dragunov min 5;
 * binoculars default 70, max 90, min 5.
 */
import { flattenTasks, readQvmCallTree, readTaskTree, isQvmSymbol, x87Mul, x87StoreF32, type IgiTask } from "../../loaders";

/** Binocular FOV limits (degrees) and their float32 tangents of the half angle. */
export interface BinocularFov {
  defaultDeg: number;
  minDeg: number;
  maxDeg: number;
  /** tan(default / 2), tan(min / 2), tan(max / 2) as the exe stores them (+0x6e4 [0], [1], [2]). */
  tanDefault: number;
  tanMin: number;
  tanMax: number;
}

export interface WeaponExtras {
  scriptId: string;
  /** "Weapon Task Type" symbol, e.g. TASKTYPE_GUNMP5SD (null when absent). */
  taskType: string | null;
  /** "Projectile Task Type" symbol, e.g. TASKTYPE_GUNSHOT / TASKTYPE_KNIFESTAB (null for -1). */
  projectileType: string | null;
  /** "Is weapon selectable when empty" (+0x6dc, FUN_00408830). */
  selectableWhenEmpty: boolean;
  /** GunMP5SD / GunDRAGUNOV "Zoom - Min FOV (degrees)" (exe default when the tag is absent). */
  zoomMinFovDeg: number | null;
  /** tan(zoomMinFovDeg / 2) in float32 (+0x6e4 [0]). */
  zoomMinTan: number | null;
  binocular: BinocularFov | null;
  /**
   * TASKTYPE_GRENADE projectiles: the "Grenade - Explosion damage factor /
   * radius (meters) / falloff (meters)" tags (FUN_00474fe0 -> +0x6e0; exe
   * defaults 1, 5, 0 when a tag is missing), else null.
   */
  grenade: { damage: number; radiusM: number; falloffM: number } | null;
  /** TASKTYPE_MEDIPACK: "Factor of human max damage to add for each round" (FUN_0046f100 -> +0x6e4; default 0.01), else null. */
  medipackFactor: number | null;
  /**
   * combat: TASKTYPE_GUNM16A2 "M203 - Muzzle velocity (km/h) / Explosion radius (meters) / Activate radius
   * (meters) / Model" (FUN_004737f0 -> +0x6e4; defaults 270, 5, 1, "108_05_1"), else null.
   */
  m203?: { muzzleKmh: number; explosionRadiusM: number; activateRadius: number; model: string } | null;
  /** combat: "Missile - Model" of a TASKTYPE_MISSILE projectile (RPG18: 110_02_1), else null. */
  missileModel?: string | null;
}

/** f32 0.017453292 at 0x531684 (degrees -> radians as the exe multiplies). */
const DEG_F32 = 0.01745329238474369;
/** Exe defaults when a tag is missing (FUN_004724a0 0x42480000, FUN_00471b50 0x40a00000, LAB_0046f930). */
export const ZOOM_TAG_DEFAULTS = {
  mp5MinDeg: 50,
  dragunovMinDeg: 5,
  binocular: { defaultDeg: 70, maxDeg: 90, minDeg: 5 },
  /** FUN_00474fe0: damage factor 1.0 (0x3f800000), radius 5 m (0x40a00000), falloff 0. */
  grenade: { damage: 1, radiusM: 5, falloffM: 0 },
  /** FUN_0046f100: 0.01 (0x3c23d70a). */
  medipackFactor: Math.fround(0.01),
} as const;

/**
 * tan(deg / 2) as `fld [tag]; fmul 0.5f; fmul 0.017453292f; fptan; fstp f32`
 * (0x46f9e0, 0x471b..): chopped products, float32 store chopped.
 */
export function zoomTangent(deg: number): number {
  return x87StoreF32(Math.tan(x87Mul(x87Mul(Math.fround(deg), 0.5), DEG_F32)));
}

function tagValue(task: IgiTask, name: string): number | null {
  for (const child of task.children) {
    if (!child.type.startsWith("TagItem")) continue;
    if (child.params["Name"] !== name) continue;
    const v = child.params["Value"];
    if (typeof v === "number") return v;
  }
  return null;
}

function symbol(task: IgiTask, key: string): string | null {
  const v = task.params[key];
  return v !== undefined && !Array.isArray(v) && isQvmSymbol(v) ? v.symbol : null;
}

/** Read every WeaponConfig's extras from weapons/weaponconfig.qvm. */
export function readWeaponExtras(weaponConfigQvm: ArrayBuffer): Map<string, WeaponExtras> {
  const out = new Map<string, WeaponExtras>();
  for (const task of flattenTasks(readTaskTree(readQvmCallTree(weaponConfigQvm)))) {
    if (task.type !== "WeaponConfig") continue;
    const scriptId = task.params["Script ID"];
    if (typeof scriptId !== "string") continue;
    const taskType = symbol(task, "Weapon Task Type");
    let zoomMinFovDeg: number | null = null;
    if (taskType === "TASKTYPE_GUNMP5SD") zoomMinFovDeg = tagValue(task, "Zoom - Min FOV (degrees)") ?? ZOOM_TAG_DEFAULTS.mp5MinDeg;
    else if (taskType === "TASKTYPE_GUNDRAGUNOV") zoomMinFovDeg = tagValue(task, "Zoom - Min FOV (degrees)") ?? ZOOM_TAG_DEFAULTS.dragunovMinDeg;
    let binocular: BinocularFov | null = null;
    if (taskType === "TASKTYPE_BINOCULAR") {
      const d = ZOOM_TAG_DEFAULTS.binocular;
      const defaultDeg = tagValue(task, "Binocular - Default FOV (degrees)") ?? d.defaultDeg;
      const maxDeg = tagValue(task, "Binocular - Max FOV (degrees)") ?? d.maxDeg;
      const minDeg = tagValue(task, "Binocular - Min FOV (degrees)") ?? d.minDeg;
      binocular = { defaultDeg, maxDeg, minDeg, tanDefault: zoomTangent(defaultDeg), tanMin: zoomTangent(minDeg), tanMax: zoomTangent(maxDeg) };
    }
    const projectileType = symbol(task, "Projectile Task Type");
    const g = ZOOM_TAG_DEFAULTS.grenade;
    const grenade =
      projectileType === "TASKTYPE_GRENADE"
        ? {
            damage: Math.fround(tagValue(task, "Grenade - Explosion damage factor") ?? g.damage),
            radiusM: Math.fround(tagValue(task, "Grenade - Explosion radius (meters)") ?? g.radiusM),
            falloffM: Math.fround(tagValue(task, "Grenade - Explosion falloff (meters)") ?? g.falloffM),
          }
        : null;
    const medipackFactor =
      taskType === "TASKTYPE_MEDIPACK" ? Math.fround(tagValue(task, "Factor of human max damage to add for each round") ?? ZOOM_TAG_DEFAULTS.medipackFactor) : null;
    const tagString = (name: string): string | null => {
      for (const child of task.children) if (child.type.startsWith("TagItem") && child.params["Name"] === name && typeof child.params["Value"] === "string") return child.params["Value"] as string;
      return null;
    };
    const m203 =
      taskType === "TASKTYPE_GUNM16A2"
        ? {
            muzzleKmh: Math.fround(tagValue(task, "M203 - Muzzle velocity (km/h)") ?? 270),
            explosionRadiusM: Math.fround(tagValue(task, "M203 - Explosion radius (meters)") ?? 5),
            activateRadius: Math.fround(tagValue(task, "M203 - Activate radius (meters)") ?? 1),
            model: tagString("M203 - Model") ?? "108_05_1",
          }
        : null;
    out.set(scriptId, {
      scriptId,
      taskType,
      m203,
      missileModel: projectileType === "TASKTYPE_MISSILE" ? tagString("Missile - Model") : null,
      projectileType,
      grenade,
      medipackFactor,
      selectableWhenEmpty: task.params["Is weapon selectable when empty"] === true || task.params["Is weapon selectable when empty"] === 1,
      zoomMinFovDeg,
      zoomMinTan: zoomMinFovDeg === null ? null : zoomTangent(zoomMinFovDeg),
      binocular,
    });
  }
  return out;
}

/**
 * Extras for a weapon when weaponconfig.qvm was not read: the handler class
 * follows the weapon type (knife -> KNIFESTAB projectile, binoculars ->
 * TASKTYPE_BINOCULAR with the exe defaults); guns get TASKTYPE_GUN (no zoom).
 * A fallback only: the zoom guns need readWeaponExtras.
 */
export function fallbackExtras(scriptId: string, weaponType: string | null): WeaponExtras {
  const knife = weaponType === "WEAPONTYPE_KNIFE";
  const bino = weaponType === "WEAPONTYPE_BINOCULAR";
  // weaponconfig.qvm [observed]: grenades / flashbangs are TASKTYPE_GUN firing TASKTYPE_GRENADE; the medipack is TASKTYPE_MEDIPACK.
  const grenade = weaponType === "WEAPONTYPE_GRENADE";
  const medipack = weaponType === "WEAPONTYPE_MEDIPACK";
  const d = ZOOM_TAG_DEFAULTS.binocular;
  return {
    scriptId,
    taskType: bino ? "TASKTYPE_BINOCULAR" : medipack ? "TASKTYPE_MEDIPACK" : "TASKTYPE_GUN",
    projectileType: bino || medipack ? null : knife ? "TASKTYPE_KNIFESTAB" : grenade ? "TASKTYPE_GRENADE" : "TASKTYPE_GUNSHOT",
    grenade: grenade ? { ...ZOOM_TAG_DEFAULTS.grenade } : null,
    medipackFactor: medipack ? ZOOM_TAG_DEFAULTS.medipackFactor : null,
    selectableWhenEmpty: true,
    zoomMinFovDeg: null,
    zoomMinTan: null,
    binocular: bino
      ? { defaultDeg: d.defaultDeg, maxDeg: d.maxDeg, minDeg: d.minDeg, tanDefault: zoomTangent(d.defaultDeg), tanMin: zoomTangent(d.minDeg), tanMax: zoomTangent(d.maxDeg) }
      : null,
  };
}
