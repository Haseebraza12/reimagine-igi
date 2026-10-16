/**
 * Loads every original interface file the HUD, loading screen and menus use,
 * through the IAssetSource the engine passes in (never bundled; read from the
 * user's installation). Evidence for each file: docs/hud.md section 1.
 */
import type { IAssetSource } from "../../contracts";
import type { MissionLocation } from "../../loaders";
import {
  composeUiPicture,
  flattenTasks,
  readIlffMembers,
  readQvmCallTree,
  readTaskTree,
  readUiArchive,
  UI_PATHS,
  type DecodedTexture,
  type IgiTask,
  type UiFont,
  type UiSprite,
} from "../../loaders";

/** A decoded UI archive: sprites and fonts keyed by lower-case member name ("anya.spr"). */
export interface UiArchive {
  sprites: Map<string, UiSprite>;
  fonts: Map<string, UiFont>;
  /** Composed pictures (.pic) keyed by lower-case name. */
  pictures: Map<string, DecodedTexture>;
}

export interface WeaponHudInfo {
  /** Weapon ID (weaponconfig "Weapon ID"), selects the status.res icon. */
  weaponId: number;
  scriptId: string;
  /** Config "Name" (drawn on the HUD; builds "PICKEDUPWEAPON<Name>"). */
  name: string;
  /** AMMODISPLAYTYPE_* value. */
  ammoDisplay: number;
  /** SIGHTDISPLAYTYPE_* value (1 = crosshair). */
  sightDisplay: number;
  weaponType: string | null;
  roundsPerClip: number;
}

export interface MissionInfo {
  id: number;
  /** Resolved names (missions.res). */
  name: string;
  description: string;
  /** missionsprites.res member, e.g. "mission1.spr". */
  sprite: string;
  nextMission: number;
  /** DefineMission's level / common directories, location and level names (loaders/level.ts levelPathsFor). */
  location: MissionLocation;
  /** The mission's MISSION:sounds listing from the staging manifest; null = not known (level 1: built in). */
  soundFiles: string[] | null;
}

/**
 * game-data/missions.json, written by `npm run stage`: the mission.qvm of every staged mission and
 * the listing of its sounds directory (the browser cannot list directories). Optional: without it
 * the port knows mission 1 only.
 */
export const MISSION_MANIFEST = "missions.json";

export interface UiAssets {
  status: UiArchive;
  computer: UiArchive;
  ingame: UiArchive;
  main: UiArchive;
  loading: UiArchive;
  missionSprites: UiArchive;
  /** common/sprites/sprites.res (binocular / sniper overlays); empty when unreadable. */
  commonSprites: UiArchive;
  /** Language strings keyed by lower-case key. */
  menuStrings: Map<string, string>;
  messages: Map<string, string>;
  missionStrings: Map<string, string>;
  weapons: Map<string, WeaponHudInfo>;
  mainMenu: IgiTask[];
  ingameMenu: IgiTask[];
  missions: MissionInfo[];
  /**
   * The string resources the map computer resolves keys in (FUN_004ac210 looks a key
   * up in every loaded .res): language computer.res (MAP, LOG, INITIALIZING...),
   * objectives.res (OBJECTIVE, COMPLETE, M1_OBJ1...) and messages.res (GARAGE_TITLE...).
   */
  computerStrings: Map<string, string>;
}

export const UI_EXTRA_PATHS = {
  missionStrings: "language/english/missions.res",
  computerStrings: "language/english/computer.res",
  objectiveStrings: "language/english/objectives.res",
  weaponConfig: "weapons/weaponconfig.qvm",
  /** Mission 1's script, used when there is no staging manifest (MISSION_MANIFEST). */
  missionScripts: ["missions/location0/level1/mission.qvm"],
} as const;

/** Every file the UI needs (for "missing files" checks). */
export const UI_REQUIRED_FILES: readonly string[] = [
  UI_PATHS.status,
  UI_PATHS.computer,
  UI_PATHS.ingameMenu,
  UI_PATHS.ingameMenuScript,
  UI_PATHS.loading,
  UI_PATHS.mainMenu,
  UI_PATHS.mainMenuScript,
  UI_PATHS.missionSprites,
  UI_PATHS.menuStrings,
  UI_PATHS.messages,
  UI_EXTRA_PATHS.missionStrings,
  UI_EXTRA_PATHS.weaponConfig,
];

export function toArchive(buffer: ArrayBuffer): UiArchive {
  const out: UiArchive = { sprites: new Map(), fonts: new Map(), pictures: new Map() };
  for (const [name, asset] of readUiArchive(buffer)) {
    const key = name.toLowerCase();
    if (asset.kind === "font") out.fonts.set(key, asset.font);
    else {
      out.sprites.set(key, asset.sprite);
      if (key.endsWith(".pic")) out.pictures.set(key, composeUiPicture(asset.sprite, name));
    }
  }
  return out;
}

/**
 * Language resource (.res of NUL-terminated strings). Member names are
 * "LOCAL:english/<key>" (menusystem.res, missions.res) or the bare key
 * (messages.res). Keys are matched case-insensitively (the exe uses strcmpi
 * for resource names). Bytes map 1:1 to character codes (the fonts index the
 * 8-bit code page directly).
 */
export function readLanguageStrings(buffer: ArrayBuffer): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of readIlffMembers(buffer)) {
    let key = m.name;
    if (key.startsWith("LOCAL:")) {
      key = key.slice(6);
      const slash = key.indexOf("/");
      if (slash < 0) continue; // the archive's own index member
      key = key.slice(slash + 1);
    }
    const bytes = new Uint8Array(m.payload);
    let end = bytes.indexOf(0);
    if (end < 0) end = bytes.length;
    let text = "";
    for (let i = 0; i < end; i++) text += String.fromCharCode(bytes[i]);
    out.set(key.toLowerCase(), text);
  }
  return out;
}

const SYMBOL_VALUES: Record<string, number> = {
  AMMODISPLAYTYPE_NONE: 0,
  AMMODISPLAYTYPE_NORMAL: 1,
  AMMODISPLAYTYPE_CLIP: 2,
  AMMODISPLAYTYPE_BARREL: 3,
  AMMODISPLAYTYPE_SHELL: 4,
  AMMODISPLAYTYPE_GRENADE: 5,
  SIGHTDISPLAYTYPE_NONE: 0,
  SIGHTDISPLAYTYPE_CROSSHAIR: 1,
};

function symbolOrNumber(v: unknown, what: string): number {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "symbol" in v) {
    const s = (v as { symbol: string }).symbol;
    if (s in SYMBOL_VALUES) return SYMBOL_VALUES[s];
    throw new Error(`weaponconfig: unknown ${what} symbol ${s}`);
  }
  throw new Error(`weaponconfig: ${what} is not a number or symbol`);
}

export function readWeaponHudInfo(buffer: ArrayBuffer): Map<string, WeaponHudInfo> {
  const out = new Map<string, WeaponHudInfo>();
  for (const t of flattenTasks(readTaskTree(readQvmCallTree(buffer)))) {
    if (t.type !== "WeaponConfig") continue;
    const p = t.params;
    const scriptId = p["Script ID"];
    if (typeof scriptId !== "string") continue;
    const weaponType = p["Weapon Type"];
    out.set(scriptId, {
      weaponId: Number(p["Weapon ID"]),
      scriptId,
      name: typeof p.Name === "string" ? p.Name : scriptId,
      ammoDisplay: symbolOrNumber(p["Ammo Display Type"], "Ammo Display Type"),
      sightDisplay: symbolOrNumber(p["Sight Display Type"], "Sight Display Type"),
      weaponType: weaponType && typeof weaponType === "object" && "symbol" in weaponType ? (weaponType as { symbol: string }).symbol : null,
      roundsPerClip: Number(p["Rounds/Clip"]),
    });
  }
  return out;
}

/** DefineMission(id, nameKey, descKey, s, next, path x3, location, level, sprite) from mission.qvm. */
export function readMissionDefinition(buffer: ArrayBuffer, strings: Map<string, string>): MissionInfo[] {
  const out: MissionInfo[] = [];
  for (const call of readQvmCallTree(buffer)) {
    if (call.fn !== "DefineMission") continue;
    const a = call.args;
    const id = typeof a[0] === "number" ? a[0] : NaN;
    const nameKey = typeof a[1] === "string" ? a[1] : "";
    const descKey = typeof a[2] === "string" ? a[2] : "";
    const next = typeof a[4] === "number" ? a[4] : -1;
    const sprite = typeof a[10] === "string" ? a[10] : `mission${id}.spr`;
    const text = (i: number) => (typeof a[i] === "string" ? (a[i] as string).replace(/\\/g, "/") : "");
    const levelDir = text(5) || text(7);
    const level = text(9) || levelDir.split("/").pop() || `level${id}`;
    const location = text(8) || levelDir.split("/").slice(-2, -1)[0] || "location0";
    out.push({
      id,
      name: strings.get(nameKey.toLowerCase()) ?? `RM: ${nameKey}`,
      description: strings.get(descKey.toLowerCase()) ?? `RM: ${descKey}`,
      sprite: sprite.toLowerCase(),
      nextMission: next,
      location: {
        id,
        levelDir: levelDir.toLowerCase(),
        commonDir: (text(6) || `missions/${location}/common`).toLowerCase(),
        location: location.toLowerCase(),
        level: level.toLowerCase(),
      },
      soundFiles: null,
    });
  }
  return out;
}

/** Load every UI file. Rejects naming the first file that is missing or malformed. */
export async function loadUiAssets(source: IAssetSource): Promise<UiAssets> {
  const read = async (path: string): Promise<ArrayBuffer> => {
    try {
      return await source.readBinary(path);
    } catch (error) {
      throw new Error(`UI: cannot read ${path}: ${(error as Error).message}`);
    }
  };
  const parse = <T>(path: string, fn: (b: ArrayBuffer) => T) => async (): Promise<T> => {
    const buffer = await read(path);
    try {
      return fn(buffer);
    } catch (error) {
      throw new Error(`UI: ${path}: ${(error as Error).message}`);
    }
  };
  const [status, computer, ingame, main, loading, missionSprites, menuStrings, messages, missionStrings, weapons, mainMenu, ingameMenu] =
    await Promise.all([
      parse(UI_PATHS.status, toArchive)(),
      parse(UI_PATHS.computer, toArchive)(),
      parse(UI_PATHS.ingameMenu, toArchive)(),
      parse(UI_PATHS.mainMenu, toArchive)(),
      parse(UI_PATHS.loading, toArchive)(),
      parse(UI_PATHS.missionSprites, toArchive)(),
      parse(UI_PATHS.menuStrings, readLanguageStrings)(),
      parse(UI_PATHS.messages, readLanguageStrings)(),
      parse(UI_EXTRA_PATHS.missionStrings, readLanguageStrings)(),
      parse(UI_EXTRA_PATHS.weaponConfig, readWeaponHudInfo)(),
      parse(UI_PATHS.mainMenuScript, (b) => readTaskTree(readQvmCallTree(b)))(),
      parse(UI_PATHS.ingameMenuScript, (b) => readTaskTree(readQvmCallTree(b)))(),
    ]);
  let commonSprites: UiArchive = { sprites: new Map(), fonts: new Map(), pictures: new Map() };
  try {
    commonSprites = toArchive(await source.readBinary(UI_PATHS.sprites));
  } catch (error) {
    console.warn(`[ui] ${UI_PATHS.sprites}: ${(error as Error).message} (binocular / sniper overlays disabled)`);
  }
  const computerStrings = new Map<string, string>();
  for (const path of [UI_EXTRA_PATHS.computerStrings, UI_EXTRA_PATHS.objectiveStrings]) {
    try {
      for (const [k, v] of readLanguageStrings(await source.readBinary(path))) computerStrings.set(k, v);
    } catch (error) {
      console.warn(`[ui] ${path}: ${(error as Error).message} (map computer texts show "RM: key")`);
    }
  }
  for (const [k, v] of messages) if (!computerStrings.has(k)) computerStrings.set(k, v);
  const missions = await readMissions(source, missionStrings, parse);
  return { status, computer, ingame, main, loading, missionSprites, commonSprites, menuStrings, messages, missionStrings, weapons, mainMenu, ingameMenu, missions, computerStrings };
}

/** The staged missions (MISSION_MANIFEST), by mission number; mission 1 alone without a manifest. */
async function readMissions(
  source: IAssetSource,
  strings: Map<string, string>,
  parse: <T>(path: string, fn: (b: ArrayBuffer) => T) => () => Promise<T>,
): Promise<MissionInfo[]> {
  let entries: Array<{ script: string; sounds: string[] | null }> = UI_EXTRA_PATHS.missionScripts.map((script) => ({ script, sounds: null }));
  try {
    if (await source.exists(MISSION_MANIFEST)) {
      const json = JSON.parse(new TextDecoder().decode(await source.readBinary(MISSION_MANIFEST))) as { missions?: unknown };
      const list = Array.isArray(json.missions) ? json.missions : [];
      const read = list
        .filter((m): m is { script: string; sounds?: unknown } => !!m && typeof (m as { script?: unknown }).script === "string")
        .map((m) => ({ script: m.script, sounds: Array.isArray(m.sounds) ? m.sounds.filter((f): f is string => typeof f === "string") : null }));
      if (read.length) entries = read;
    }
  } catch (error) {
    console.warn(`[ui] ${MISSION_MANIFEST}: ${(error as Error).message} (only mission 1 is listed)`);
  }
  const byId = new Map<number, MissionInfo>();
  for (const e of entries) {
    let defs: MissionInfo[] = [];
    try {
      defs = await parse(e.script, (b) => readMissionDefinition(b, strings))();
    } catch (error) {
      console.warn(`[ui] ${e.script}: ${(error as Error).message}`);
      continue;
    }
    for (const d of defs) {
      if (!Number.isFinite(d.id) || byId.has(d.id)) continue;
      d.soundFiles = e.sounds;
      byId.set(d.id, d);
    }
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
