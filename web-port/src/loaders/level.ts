/**
 * Level assembly from ORIGINAL game files (no pre-conversion step).
 *
 * Reads the mission task tree (objects.qvm), model/texture archives and their
 * .mtp tables, the magic-object registry, weapon configuration, localized
 * text and weapon sounds, and produces engine-ready data:
 *   - model geometry in engine space (metres, y up; see coords.ts)
 *   - every placed model instance with its verified transform, including the
 *     ATTA sub-models (stairs, windows, furniture) of each placed model
 *   - player spawn/loadout, soldiers, objectives, area messages, lighting.
 *
 * Everything here is pure data handling and runs in Node (tests) and in the
 * browser. Sources and confidence of each interpretation: docs/formats.md.
 */
import { SOLDIER_TYPE_DEFAULTS, isSoldierTaskType } from "./soldier-types";
import type { DecodedTexture, IAssetSource, Vec3 } from "../contracts";
import {
  IDENTITY3,
  IGI_UNITS_PER_METRE,
  engineMatrix4,
  igiDirToEngine,
  igiEulerToMat3,
  igiPointToEngine,
  igiRotationToEngine,
  mulMat3,
  mulMat3Vec,
  transposeMat3,
  type Mat3,
} from "./coords";
import { readIlffMembers } from "./ilff";
import { decodeIlsf, type DecodedSound } from "./ilsf";
import { decodeTex } from "./loop-tex";
import { readMef, type MefModel } from "./mef";
import { readMtp } from "./mtp";
import { decodeOlm } from "./olm";
import { TERRAIN_GAME_MAX_LEVEL, TerrainOctree, type HeightMapTask, type TerrainMesh } from "./terrain-octree";
import { TerrainLook, type TerrainMaterialLevel } from "./terrain-look";
import { isQvmSymbol, readQvmCallTree, readQvmLiteralCalls, type QvmValue } from "./qvm";
import { decodeHumanPlayerParams, type HumanPlayerParams } from "./gameplay-params";
import { loadAmmoTypes, type AmmoType } from "./render-params";
import { NO_MATERIAL, readCollisionModel, readSurfaceMaterials, type CollisionModel, type CollisionSet, type SurfaceMaterial } from "./collision-mesh";
import { flattenTasks, numberParam, readTaskTree, stringParam, vec3Param, type IgiTask } from "./tasks";
import { wirePose } from "./wire";
import { loadLevelVehicles, type LevelVehicles } from "./level-vehicles";
import { railSplineFromTask, segmentDeformer, segmentModelRange, splineParamsFromTask, splineSegmentFrames } from "./spline-segment";
import { attaMatrix, placeTrain, readMefMagicVertices, trainCar, type RailSpline } from "./vehicles";
import { securityCameraLensMatrix, securityCameraLensPivot } from "./mission";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface ModelArchivePaths {
  /** Short id used in texture keys ("level1", "location0"). */
  id: string;
  models: string;
  mtp: string;
  textures: string;
}

export interface IgiLevelPaths {
  objects: string;
  /** Baked object lightmaps (objNNNNN_MMMMM.olm). */
  lightmaps: string;
  terrain: { ctr: string; cmd: string; hmp: string; tex: string; bit: string; lmp: string; qvm: string };
  /** Searched in order when resolving a model name. */
  archives: ModelArchivePaths[];
  magicObjects: string;
  weaponConfig: string;
  sounds: string;
  objectiveText: string;
  messageText: string;
  missionText: string;
  /** Mission number used for the "Mission N Name/Desc" strings. */
  missionNumber: number;
  /** Game configuration (GOGameDiff difficulty). */
  config: string;
  /** HumanAIConfigItem combat settings per AI type and difficulty. */
  aiSettings: string;
  /** Directory of the shared AI scripts ("guard.qvm", "sniper.qvm", ...). */
  aiScripts: string;
  /** Directory of the mission's per-soldier AI scripts ("<HumanAI task id>.qvm"). */
  missionAiScripts: string;
  /** Skeleton/animation files "<id>.iff" (location0.mtp BANM; docs/characters.md). */
  anims: string;
  /** Player definition (DefineHumanPlayerGeneral etc.; docs/gameplay.md). */
  humanPlayer: string;
  /** Surface materials (SetActiveMaterial / DefineQMaterial / DefineGameMaterial; docs/collision.md 9). */
  materials: string;
}

/**
 * Where a mission's files are: DefineMission(id, name, desc, "", next, level path, common path,
 * level path, location, level, sprite) in the level's mission.qvm (the exe builds its LOCAL /
 * MISSION / LOCATION names from these [recovered FUN_0041ab50 argument order, docs/hud.md]).
 */
export interface MissionLocation {
  /** Mission number ("Mission N Name" / "Mission N Desc" in missions.res). */
  id: number;
  /** "missions/location0/level1" */
  levelDir: string;
  /** "missions/location0/common" */
  commonDir: string;
  /** "location0" */
  location: string;
  /** "level1" */
  level: string;
}

/** The mission files the port reads, by igi.exe's layout of a mission and its location. */
export function levelPathsFor(m: MissionLocation): IgiLevelPaths {
  const L = m.levelDir.replace(/\/+$/, "");
  const C = m.commonDir.replace(/\/+$/, "");
  return {
    objects: `${L}/objects.qvm`,
    lightmaps: `${L}/lightmaps/lightmaps.res`,
    terrain: {
      ctr: `${L}/terrain/terrain.ctr`,
      cmd: `${L}/terrain/terrain.cmd`,
      hmp: `${L}/terrain/terrain.hmp`,
      tex: `${L}/terrain/terrain.tex`,
      bit: `${L}/terrain/terrain.bit`,
      lmp: `${L}/terrain/terrain.lmp`,
      qvm: `${L}/terrain/terrain.qvm`,
    },
    archives: [
      { id: m.level, models: `${L}/models/${m.level}.res`, mtp: `${L}/${m.level}.mtp`, textures: `${L}/textures/${m.level}.res` },
      { id: m.location, models: `${C}/models/${m.location}.res`, mtp: `${C}/${m.location}.mtp`, textures: `${C}/textures/${m.location}.res` },
    ],
    magicObjects: "magicobj/magicobj.qvm",
    weaponConfig: "weapons/weaponconfig.qvm",
    sounds: "common/sounds/sounds.res",
    objectiveText: "language/english/objectives.res",
    messageText: "language/english/messages.res",
    missionText: "language/english/missions.res",
    missionNumber: m.id,
    config: "config.qvm",
    aiSettings: "common/ai/settings.qvm",
    aiScripts: "common/ai/",
    missionAiScripts: `${L}/ai/`,
    anims: "common/anims/",
    humanPlayer: "humanplayer/humanplayer.qvm",
    materials: "material/material.qvm",
  };
}

/** Mission 1, Trainyard (the only mission of the supplied installation). */
export const LEVEL1_MISSION: MissionLocation = {
  id: 1,
  levelDir: "missions/location0/level1",
  commonDir: "missions/location0/common",
  location: "location0",
  level: "level1",
};

export const LEVEL1_PATHS: IgiLevelPaths = levelPathsFor(LEVEL1_MISSION);

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface LevelModelGroup {
  start: number;
  count: number;
  /** Texture key "<archive>:<name>", or null when the slot has no texture. */
  texture: string | null;
  /**
   * The block has no material (slot -1 / 0xffff): igi.exe draws it untextured
   * (D3DTSS_COLOROP = SELECTARG2, texture NULL: the lit vertex colour) in
   * type-0 models and skips it in lightmapped ones [recovered FUN_0052e5d0].
   */
  noMaterial?: true;
}

/** Model geometry in engine space (metres, y up), counter-clockwise faces. */
/**
 * One HSMC collision set of a model in engine space (metres, model-local),
 * portal faces removed (docs/collision.md). Triangles are stored (a, c, b)
 * so that (v1 - v0) x (v2 - v0) is the exe's outward normal (c - a) x (b - a).
 */
export interface LevelCollisionSet {
  positions: Float32Array;
  indices: Uint32Array;
  /** material.qvm SetActiveMaterial index per triangle, or -1 (none). */
  material: Int16Array;
}

export interface LevelModel {
  name: string;
  modelType: 0 | 1 | 3;
  /**
   * The model's original collision: [set 0 = visible geometry with materials
   * (bullets, sight, footstep materials), set 1 = character hull (movement)],
   * or null when the model has none (LOD variants). Spline segments carry
   * their sets bent along the curve like the render geometry.
   */
  collision?: [LevelCollisionSet, LevelCollisionSet] | null;
  positions: Float32Array;
  normals: Float32Array;
  uv: Float32Array;
  /** Lightmap coordinates (type 3), addressing the instance's .olm. */
  lightmapUv: Float32Array | null;
  indices: Uint32Array;
  groups: LevelModelGroup[];
}

export interface LevelInstance {
  model: string;
  /** Column-major 4x4 model->world matrix (engine space). */
  matrix: number[];
  /** Task that placed the root of this instance. */
  taskId: number;
  taskType: string;
  taskName: string;
  /** Magic-object type when this is an ATTA sub-model (e.g. "TASKTYPE_GLASS"). */
  magicType: string | null;
  glass: boolean;
  /** Key into IgiLevel.lightmaps when the instance has a baked .olm, else null (vertex-lit). */
  lightmap: string | null;
  /**
   * Column-major model -> world matrix for the collision faces when it
   * differs from `matrix` (wires: rigid, unstretched; docs/wire.md).
   */
  collisionMatrix?: number[];
  /**
   * Pre-order index of the placing task in `IgiLevel.tasks` (the same order
   * as the mission runtime's node index). Unique even where task ids are -1
   * (most doors, train wagons): moving entries are keyed by it.
   */
  taskIndex?: number;
  /** ATTA path below the task's model: "" = the model itself, "2" = its attachment 2, "0/1" = attachment 1 of attachment 0. */
  attachmentPath?: string;
  /**
   * An object the task creates besides its own model. "scameraLens": the
   * SCamera's lens / camera head (class SCameraLens, its "Camera Model"),
   * placed at its compile pose (pitch = Camera Alpha, no sweep); it turns
   * every tick and takes the bullets (docs/mission.md, docs/damage.md).
   */
  part?: "scameraLens";
}

/** Axis-aligned box in engine space. */
export interface LevelArea {
  taskId: number;
  center: Vec3;
  halfExtents: Vec3;
}

export interface LevelObjective {
  id: string;
  text: string;
  area: LevelArea;
}

export interface LevelMessage {
  id: string;
  text: string;
  area: LevelArea;
}

export interface LevelWeapon {
  scriptId: string;
  name: string;
  /** "Weapon Type" symbol: WEAPONTYPE_PISTOL / _GUN / _SHOTGUN / _KNIFE / _BINOCULAR / ... */
  weaponType: string | null;
  damageFactor: number;
  reloadSeconds: number;
  roundsPerMinute: number;
  roundsPerClip: number;
  maxRoundsPerBurst: number;
  minSpread: number;
  maxSpread: number;
  /** "Fixed/Random view change around X/Z axis (degrees)": recoil per shot. */
  recoilPitch: number;
  recoilYaw: number;
  recoilPitchRandom: number;
  recoilYawRandom: number;
  /** Calibre ID (e.g. 919 = 9 mm); ammo pools are AMMO_ID_<calibre>. */
  calibreId: number;
  /** "AI Detection Event Range" symbol, e.g. HUMANAI_DETECTIONEVENT_GUNSHOT_SILENCED_RANGE. */
  aiDetection: string | null;
  rangeMetres: number;
  fireSound: string | null;
  fireSoundEnd: string | null;
  /** Reload sample sequence, e.g. ["glock_reload_1", ..., "glock_reload_3"] (pairing inferred). */
  reloadSounds: string[];
  /** "Gun Model" (e.g. MP5SD 103_01_1). */
  gunModel: string | null;
  /** "Weapon ID" number (HUD weapon icon table, docs/hud.md). */
  weaponNumber: number;
  /** "Ammo Display Type" symbol, e.g. AMMODISPLAYTYPE_CLIP. */
  ammoDisplay: string | null;
  /** "Penetration Power", "Muzzle Velocity", "Bullets/Round" (docs/gameplay.md). */
  penetration: number;
  muzzleVelocity: number;
  bulletsPerRound: number;
  /** First-person arms clips in 005.iff: StandAnim, MoveAnim, FireAnim1-3 (-1 = none), ReloadAnim [observed; docs/characters.md]. */
  firstPersonAnims: { stand: number; move: number; fire: number[]; reload: number };
}

/**
 * sounds.res holds numbered reload sequences per gun (glock_reload_1..3,
 * mp5_reload_1..5, ...). Which sequence belongs to which weapon is matched by
 * name here (inferred; the game drives these from animation events).
 */
const RELOAD_SOUND_PREFIX: Record<string, string> = {
  WEAPON_ID_GLOCK: "glock_reload",
  WEAPON_ID_COLT: "colt_reload",
  WEAPON_ID_MP5SD: "mp5_reload",
  WEAPON_ID_UZI: "uzi_reload",
  WEAPON_ID_UZIX2: "uzix2_reload",
  WEAPON_ID_M16A2: "m16_reload",
  WEAPON_ID_AK47: "ak47_reload",
  WEAPON_ID_MINIMI: "minimi_reload",
  WEAPON_ID_SPAS12: "spas12_reload",
  WEAPON_ID_JACKHAMMER: "jackh_reload",
  WEAPON_ID_DRAGUNOV: "dragu_reload",
};

/**
 * A soldier's view, as set by its AI script on AIEVENT_CREATE
 * (AIFunction_SetViewLength / SetAlarmViewLength / SetViewAlpha /
 * SetViewGamma). Values observed; units recovered (metres, degrees):
 * alpha = VERTICAL half-angle, gamma = HORIZONTAL half-angle in the eye
 * frame (FUN_00487d80, docs/ai.md).
 */
export interface LevelAiView {
  length: number;
  alarmLength: number;
  alpha: number;
  gamma: number;
}

/** HumanAIConfigItem fields for the soldier's AI type at the configured difficulty (observed values). */
export interface LevelAiCombat {
  damageScale: number;
  initialMovementDelay: number;
  targetingTimeout: number;
  trackingDistance: number;
  hitProbabilityMinRange: number;
  hitProbabilityMaxRange: number;
  maxRoundsPerSequence: number;
  minClipFraction: number;
  randomClipFraction: number;
  minDelay: number;
  randomDelay: number;
  minShotDelay: number;
  randomShotDelay: number;
}

/** Part of a gun model in gun-local engine space (metres); role from magicobj.qvm. */
export interface LevelGunPart {
  model: string;
  /** body = the Gun Model itself; clip = TASKTYPE_GUNCLIP; moving = TASKTYPE_GUNMOVINGPART; flame = TASKTYPE_GUNFLAME; part = other attachment. */
  role: "body" | "clip" | "moving" | "flame" | "part";
  /** Column-major 4x4, gun-local (ATTA offsets applied). */
  matrix: number[];
  /**
   * DNER flags per render block (same order as the model's groups): deferred =
   * alpha-blended after the opaque pass, additive = ONE/ONE (docs/rendering.md).
   */
  blocks: { deferred: boolean; additive: boolean }[];
}

/** A skinned (HSEM type 1) model: the raw .mef for readSkinnedModel and its textures per material slot. */
export interface LevelBoneModel {
  name: string;
  buffer: ArrayBuffer;
  /** Level texture key per material slot (decodeLevelTexture), null when missing. */
  textureKeys: (string | null)[];
}

export interface LevelSoldier {
  taskId: number;
  /** objects.qvm type: HumanSoldier, HumanSoldierFemale or HumanSoldierRPG (soldier-types.ts); absent = HumanSoldier. */
  taskType?: string;
  name: string;
  position: Vec3;
  yaw: number;
  team: number;
  model: string;
  aiType: string | null;
  weapon: string | null;
  /** Null when the AI scripts are not available. */
  view: LevelAiView | null;
  combat: LevelAiCombat | null;
  /** 'Bone Heirachy': skeleton id = animation file number (docs/characters.md). */
  skeleton: number;
  /** 'Stand Animation' clip replacing the idle action, or -1. */
  standAnimation: number;
  /** HumanAI task id (mission AI script "<id>.qvm"), or null. */
  aiTaskId: number | null;
  /** HumanAI 'Graph ID', or null. */
  graphId: number | null;
  /**
   * Pre-order index of the HumanSoldier task in IgiLevel.tasks (= the mission runtime's node
   * index). Task ids are not unique: three level-1 soldiers have id -1.
   */
  taskIndex?: number;
  /** Pre-order index of its HumanAI task, or null. */
  aiTaskIndex?: number | null;
}

export interface LevelEnvironment {
  skyTop: Vec3;
  skyMiddle: Vec3;
  skyBottom: Vec3;
  fogColor: Vec3;
  ambient: Vec3;
  /** Unit vector pointing TOWARDS the sun, engine space (direction inferred). */
  sunDirection: Vec3;
  sunColor: Vec3;
  skyLayerTexture: string | null;
  skyLayerColor: Vec3;
  /** FlatSkyLayer "Scale" (texture repeats per IGI unit, inferred unit). */
  skyLayerScale: number;
  /** FlatSkyLayer "X Speed" / "Y Speed". */
  skyLayerSpeed: [number, number];
}

/** Terrain triangles in engine space (metres, y up, counter-clockwise). */
export interface LevelTerrainMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Textured terrain triangles (non-indexed), engine space. See terrain-look.ts. */
export interface LevelTerrainRenderMesh {
  positions: Float32Array;
  uv: Float32Array;
  /** Per vertex: the triangle's three vertex-material layers. */
  layers: Uint8Array;
  /** Lightmap value 0..255 per vertex, or 256 = no lightmap (no multiply). */
  light: Float32Array;
}

export interface LevelTerrain {
  /**
   * Full-detail (level 16) surface around the mission area, for collision
   * (igi.exe's terrain ray / sweep tests use level 16 + HeightMap relief).
   * Rendering selects cells per frame from `octree` and `look`
   * (engine/world/terrain-render.ts), as igi.exe does.
   */
  detail: LevelTerrainMesh;
  /** Terrain light palette colours (device 0..1): light(i) = min(1, (i*sun + 255*ambient)/255). */
  sun: Vec3;
  ambient: Vec3;
  /** Decoder, for height queries in IGI units. */
  octree: TerrainOctree;
  /** Texturing/lighting model (per-cell queries; used by tests and tools). */
  look: TerrainLook;
}

export interface IgiLevel {
  /** The files this level was read from (its mission's paths; the other loaders take them from here). */
  paths: IgiLevelPaths;
  /** Every objects.qvm task, depth-first with parents first (tasks.ts), for the task runtime. */
  tasks: IgiTask[];
  /** The objects.qvm task tree roots (buildMissionTasks). */
  taskRoots: IgiTask[];
  /** language/<lang>/messages.res strings by key (status messages, cut-scene subtitles). */
  messageStrings: Map<string, string>;
  /** Gun models (weaponconfig 'Gun Model' + ATTA parts) of every weapon the player or a soldier carries or a GunPickup holds. */
  guns: Map<string, LevelGunPart[]>;
  /** DefineAmmoType by AMMO_ID (ammo/<dir>/ammo.qvm, render-params.ts); the AmmoPickup models are in `models`. Empty when ammo/ is not staged. */
  ammoTypes: Map<string, AmmoType>;
  /** Skinned models of the soldiers and the first-person arms (005_01_1). */
  boneModels: Map<string, LevelBoneModel>;
  /** Raw animation files by skeleton id (readAnimations). */
  animations: Map<number, ArrayBuffer>;
  /** humanplayer.qvm decoded (movement scale, jump, lean, damage capacity and zones), or null when absent. */
  humanPlayer: HumanPlayerParams | null;
  /**
   * material.qvm surface materials by SetActiveMaterial index (the material
   * numbers collision triangles carry); empty when the file is absent.
   */
  surfaceMaterials: SurfaceMaterial[];
  /** config.qvm: control bindings (GOInRemap) and mouse settings. */
  controls: { bindings: Array<{ action: string; device: string; key: string }>; mouseSensitivity: number | null; invertMouse: boolean };
  /** IGI position mapped to engine (0, 0, 0), for converting task positions (coords.ts). */
  originIgi: Vec3;
  name: string;
  description: string;
  /** IGI world position (units) mapped to engine (0, 0, 0). */
  origin: Vec3;
  models: Map<string, LevelModel>;
  instances: LevelInstance[];
  terrain: LevelTerrain;
  /** Baked object lightmaps by .olm name (e.g. "obj00014_00000"). */
  lightmaps: Map<string, DecodedTexture>;
  /** Vertex lighting for models without a lightmap (recovered D3D7 fixed-function state). */
  objectLight: { sunDirection: Vec3; front: Vec3; ambient: Vec3 };
  /** Raw .tex payloads by texture key; decode with `decodeLevelTexture`. */
  textures: Map<string, ArrayBuffer>;
  player: {
    position: Vec3;
    yaw: number;
    weapons: string[];
    ammo: Record<string, number>;
    /** HumanPlayer 'Model' (skeleton 0 body; level 1: 000_01_1), in boneModels; null when absent. */
    model: string | null;
  };
  soldiers: LevelSoldier[];
  /** Configured game difficulty ("GD_2"), or null when config.qvm is unavailable. */
  difficulty: string | null;
  objectives: LevelObjective[];
  messages: LevelMessage[];
  failedText: string;
  completeText: string;
  environment: LevelEnvironment;
  weapons: Map<string, LevelWeapon>;
  sounds: Map<string, DecodedSound>;
  /** Engine-space boxes of the placed geometry (for terrain/ground fitting). */
  bounds: { min: Vec3; max: Vec3 };
  /** Physics types, magic objects and vehicle model data for the Heli / Car / Train tasks (docs/vehicles.md). */
  vehicles?: LevelVehicles;
  /** combat: DefineMagicObj arguments of the TASKTYPE_AISTATIONARYGUN definitions, by model name (lower case). */
  aiTurretDefs?: Map<string, unknown[]>;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseName(virtualName: string): string {
  const slash = virtualName.lastIndexOf("/");
  const file = slash >= 0 ? virtualName.slice(slash + 1) : virtualName;
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

function cstr(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  let out = "";
  for (let i = 0; i < end; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

async function readStrings(raw: IAssetSource, path: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const member of readIlffMembers(await raw.readBinary(path))) {
    out.set(baseName(member.name), cstr(member.payload));
  }
  return out;
}

function rgb(task: IgiTask | undefined, name: string, fallback: Vec3): Vec3 {
  const value = task ? vec3Param(task, name) : null;
  return value ?? fallback;
}

/** Placement fields per task type (parameter names from objects.qvm schemas). */
interface PoseSpec {
  position: string;
  orientation?: string;
  gamma?: string;
  model: (task: IgiTask) => string | null;
}

const MODEL = (key: string) => (task: IgiTask) => stringParam(task, key);

const POSE_SPECS: Record<string, PoseSpec> = {
  Building: { position: "Position", orientation: "Orientation", model: MODEL("Model") },
  EditRigidObj: { position: "Position", orientation: "Orientation", model: MODEL("Model") },
  Door: { position: "Position start", orientation: "Orientation", model: MODEL("Model") },
  ExplodeObject: { position: "Position", orientation: "Orientation", model: MODEL("Model") },
  Terminal: { position: "Position", orientation: "Orientation", model: MODEL("Model") },
  AlarmControl: { position: "Position", orientation: "Orientation", model: MODEL("Model") },
  SCameraControl: { position: "Position", orientation: "Orientation", model: MODEL("Model") },
  Car: { position: "Position", orientation: "Orientation", model: MODEL("Model") },
  Switch: {
    position: "Position",
    orientation: "Orientation",
    model: (t) => stringParam(t, t.params["Initial on"] === true ? "On model" : "Off model"),
  },
  Fence: { position: "Position", gamma: "Gamma", model: MODEL("Model") },
  // Full game (docs/objects.md): the elevator is placed here and moved to its spline pose by the
  // engine; Generator / Radio / GenericTBA are ExplodeObjects; the Cabinet's Orientation is one
  // yaw angle (Angle type, Rz [inferred]); a GenericPickup's Euler angles go straight into its
  // render matrix (LAB_0046c2b0). PlaceExplosiveTBA has no model in the data.
  Elevator: { position: "Position", orientation: "Orientation", model: MODEL("Model") },
  Generator: { position: "Position", orientation: "Orientation", model: MODEL("Model") },
  Radio: { position: "Position", orientation: "Orientation", model: MODEL("Model") },
  Cabinet: { position: "Position", gamma: "Orientation", model: MODEL("Model") },
  GenericPickup: { position: "Position", orientation: "Orientation", model: MODEL("Model") },
  GenericTBA: { position: "Position", orientation: "Orientation", model: MODEL("Model") },
  PlaceExplosiveTBA: { position: "Position", orientation: "Orientation", model: MODEL("Model") },
  SCamera: { position: "Holder Position", gamma: "Holder Gamma", model: MODEL("Holder Model") },
  // World types of missions 3-14 (loaders/objects/*): the Siren is an ExplodeObject
  // (FUN_00481c40 compile); the AlarmLight compile (FUN_0043a450, full exe) shows the "Off
  // model" and makes its ATTA magic objects (the 344_02_1 reflector, placed as attachment
  // "0"); the RotatingObject compile (FUN_004395d0) overwrites Orientation with the identity.
  Siren: { position: "Position", orientation: "Orientation", model: MODEL("Model") },
  AlarmLight: { position: "Position", orientation: "Orientation", model: MODEL("Off model") },
  RotatingObject: { position: "Position", model: MODEL("Model") },
  // combat: the stationary gun's tripod (it turns with the gun's yaw) and the turret holder (its ATTA is the turret).
  StationaryGun: { position: "Position", orientation: "Orientation", model: MODEL("Holder model") },
  AIStationaryGunHolder: { position: "Position", orientation: "Orientation", model: MODEL("Holder model") },
  // SplineObjWaypoint "Waypoint Model" is an editor gizmo: every SplineObj in
  // level 1 has "Display waypoints" = FALSE. Segment models: see buildSplines.
};

/** Magic-object types that are invisible helpers, not rendered geometry. */
const HIDDEN_MAGIC = new Set(["TASKTYPE_DEATHZONE", "TASKTYPE_GUNFLAME", "TASKTYPE_SCAMERALENSVIEWCONE"]);
/** turrets: the rocket the Mil's RocketPods fire (string 0x53bb60, FUN_00427a70, full exe). */
export const ROCKET_POD_MISSILE_MODEL = "700_10_1";

// Plane afterburners (vehicles): the Afterburner draw (slot 4, FUN_0042bd40, full exe) only queues an
// "AfterburnerPrimitive" whose draw FUN_0042c4b0 calls FUN_004c1780, a bare `ret`: never drawn [recovered].
HIDDEN_MAGIC.add("TASKTYPE_AFTERBURNER");

/** First-person arms model and skeleton (FUN_004632d0) and the player's body skeleton [recovered, docs/characters.md]. */
const FIRST_PERSON_ARMS_MODEL = "005_01_1";
const FIRST_PERSON_ARMS_SKELETON = 5;
const PLAYER_BODY_SKELETON = 0;

/**
 * Editor marker meshes. "waypoint" is the gizmo used by logic-only tasks
 * (AlarmControl, SCameraControl, Terminal); its single render block has
 * material slot -1, i.e. no material, so it is never drawn in game.
 */
const EDITOR_MARKER_MODELS = new Set(["waypoint"]);

const ATTACHMENT_DEPTH_LIMIT = 4;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loadIgiLevel(raw: IAssetSource, paths: IgiLevelPaths = LEVEL1_PATHS): Promise<IgiLevel> {
  const warnings: string[] = [];

  // --- Mission tasks -------------------------------------------------------
  const taskRoots = readTaskTree(readQvmCallTree(await raw.readBinary(paths.objects)));
  const tasks = flattenTasks(taskRoots);
  const byId = new Map<number, IgiTask>();
  for (const task of tasks) if (task.id >= 0 && !byId.has(task.id)) byId.set(task.id, task);
  const ofType = (type: string) => tasks.filter((t) => t.type === type);

  // --- Archives ------------------------------------------------------------
  const modelPayloads = new Map<string, { buffer: ArrayBuffer; archive: string; textures: string[] }>();
  const textures = new Map<string, ArrayBuffer>();
  for (const archive of paths.archives) {
    const mtp = readMtp(await raw.readBinary(archive.mtp));
    const modelMembers = readIlffMembers(await raw.readBinary(archive.models));
    const textureMembers = readIlffMembers(await raw.readBinary(archive.textures));
    const modelNames = modelMembers.map((m) => baseName(m.name));
    const textureNames = textureMembers.map((m) => baseName(m.name));
    if (modelNames.join("\n") !== mtp.models.join("\n")) {
      throw new Error(`level: ${archive.mtp} MODS does not list ${archive.models} in member order`);
    }
    if (textureNames.join("\n") !== mtp.textures.join("\n")) {
      throw new Error(`level: ${archive.mtp} TEXF does not list ${archive.textures} in member order`);
    }
    textureMembers.forEach((m, i) => textures.set(`${archive.id}:${textureNames[i]}`, m.payload));
    modelMembers.forEach((m, i) => {
      const name = modelNames[i];
      if (modelPayloads.has(name)) return; // earlier archives win
      modelPayloads.set(name, {
        buffer: m.payload,
        archive: archive.id,
        textures: mtp.modelTextures.get(name) ?? [],
      });
    });
  }

  const decoded = new Map<string, MefModel | null>();
  const mef = (name: string): MefModel | null => {
    if (!decoded.has(name)) {
      const entry = modelPayloads.get(name);
      if (!entry) {
        warnings.push(`model ${name} is not in any archive`);
        decoded.set(name, null);
      } else {
        try {
          decoded.set(name, readMef(entry.buffer));
        } catch (error) {
          warnings.push(`model ${name}: ${(error as Error).message}`);
          decoded.set(name, null);
        }
      }
    }
    return decoded.get(name) ?? null;
  };

  // --- Magic objects -------------------------------------------------------
  const magic = new Map<string, string>();
  /** combat: TASKTYPE_AISTATIONARYGUN definitions -> their gun model (DefineMagicObj argument 3, FUN_0046fa50). */
  const turretGunModels = new Map<string, string>();
  const aiTurretDefs = new Map<string, unknown[]>();
  for (const call of readQvmCallTree(await raw.readBinary(paths.magicObjects))) {
    if (call.fn !== "DefineMagicObj") continue;
    const [name, , type] = call.args;
    if (typeof name === "string" && isQvmSymbol(type as QvmValue)) magic.set(name, (type as { symbol: string }).symbol);
    if (typeof name === "string" && magic.get(name) === "TASKTYPE_AISTATIONARYGUN" && typeof call.args[3] === "string") {
      turretGunModels.set(name, call.args[3]);
      aiTurretDefs.set(name.toLowerCase(), [...call.args]);
    }
  }

  // --- Origin: player x/y, base ground z -----------------------------------
  const playerTask = ofType("HumanPlayer")[0];
  if (!playerTask) throw new Error("level: objects.qvm has no HumanPlayer task");
  const playerPos = vec3Param(playerTask, "Position");
  if (!playerPos) throw new Error("level: HumanPlayer has no Position");
  const buildingZ = ofType("Building")
    .map((t) => vec3Param(t, "Position")?.[2])
    .filter((z): z is number => typeof z === "number")
    .sort((a, b) => a - b);
  const groundZ = buildingZ.length ? buildingZ[Math.floor(buildingZ.length / 2)] : playerPos[2];
  const origin: Vec3 = [playerPos[0], playerPos[1], groundZ];

  // --- Baked object lightmaps: which .olm belongs to which placed model -----
  // igi.exe loads "<mission>lightmaps/<Filename>_%05d.olm" for every entry of a
  // building's instance list (FUN_0051daa0, list loop 0x51d7e0). The list
  // order, recovered and reproduced for 22/22 level-1 buildings (all 1,308
  // file sizes in order): emit(model) = every LOD variant model_1..model_n,
  // then model_1's ATTA entries without attachments (ATTA order), then the
  // ATTA entries with attachments, recursively; list = emit(building Model)
  // + emit(Model) of each descendant task with a Model, in task order.
  const taskIndex = new Map<IgiTask, number>();
  tasks.forEach((t, i) => taskIndex.set(t, i));
  const lods = (model: string): string[] => {
    const base = model.includes("_") ? model.slice(0, model.lastIndexOf("_")) : model;
    const out: string[] = [];
    for (let k = 1; modelPayloads.has(`${base}_${k}`); k++) out.push(`${base}_${k}`);
    return out;
  };
  const olmPayloads = new Map<string, ArrayBuffer>();
  for (const member of readIlffMembers(await raw.readBinary(paths.lightmaps))) {
    olmPayloads.set(baseName(member.name), member.payload);
  }
  /** Instance path ("t<task index>/<ATTA index>/...") -> .olm name, for LOD-1 entries. */
  const lightmapByPath = new Map<string, string>();
  for (const building of ofType("Building")) {
    const info = building.children.find((c) => c.type === "LightmapInfo");
    const filename = info ? stringParam(info, "Filename") : null;
    const rootModel = stringParam(building, "Model");
    if (!filename || !rootModel) continue;
    const entries: Array<{ lod: number; path: string; model: string }> = [];
    const emit = (model: string, path: string, depth: number) => {
      lods(model).forEach((m, k) => entries.push({ lod: k + 1, path, model: m }));
      const geometry = modelPayloads.has(model) ? mef(model) : null;
      if (!geometry || depth >= ATTACHMENT_DEPTH_LIMIT) return;
      const indexed = geometry.attachments.map((a, i) => ({ a, i }));
      const hasChildren = (name: string) => (modelPayloads.has(name) ? (mef(name)?.attachments.length ?? 0) > 0 : false);
      const ordered = [...indexed.filter((x) => !hasChildren(x.a.name)), ...indexed.filter((x) => hasChildren(x.a.name))];
      for (const { a, i } of ordered) emit(a.name, `${path}/${i}`, depth + 1);
    };
    emit(rootModel, `t${taskIndex.get(building)}`, 0);
    const walk = (task: IgiTask) => {
      for (const child of task.children) {
        const model = stringParam(child, "Model");
        if (model) emit(model, `t${taskIndex.get(child)}`, 0);
        walk(child);
      }
    };
    walk(building);
    entries.forEach((entry, index) => {
      if (entry.lod !== 1) return;
      const name = `${filename}_${String(index).padStart(5, "0")}`;
      if (!olmPayloads.has(name)) {
        warnings.push(`lightmap ${name} for ${entry.model} is missing`);
        return;
      }
      lightmapByPath.set(entry.path, name);
    });
    const files = [...olmPayloads.keys()].filter((n) => n.startsWith(`${filename}_`)).length;
    if (files !== entries.length) {
      warnings.push(`${filename}: instance list has ${entries.length} entries but ${files} .olm files exist`);
    }
  }
  const lightmaps = new Map<string, DecodedTexture>();
  const lightmapFor = (path: string, model: string, geometry: MefModel): string | null => {
    const name = lightmapByPath.get(path);
    if (!name || geometry.modelType !== 3 || !geometry.lightmapUv) return null;
    if (!lightmaps.has(name)) {
      try {
        const decoded = decodeOlm(olmPayloads.get(name)!);
        const [w, h] = geometry.lightmapSizes[0] ?? [0, 0];
        if (decoded.width !== w || decoded.height !== h) {
          warnings.push(`lightmap ${name} is ${decoded.width}x${decoded.height} but ${model} expects ${w}x${h}`);
          return null;
        }
        lightmaps.set(name, decoded);
      } catch (error) {
        warnings.push(`lightmap ${name}: ${(error as Error).message}`);
        return null;
      }
    }
    return name;
  };

  // --- Instances -----------------------------------------------------------
  const instances: LevelInstance[] = [];
  const usedModels = new Set<string>();
  const place = (
    task: IgiTask,
    model: string,
    position: Vec3,
    rotation: Mat3,
    magicType: string | null,
    chain: string[],
    path: string,
  ) => {
    if (EDITOR_MARKER_MODELS.has(model)) return;
    const geometry = mef(model);
    if (!geometry) return;
    usedModels.add(model);
    instances.push({
      model,
      matrix: engineMatrix4(igiRotationToEngine(rotation), igiPointToEngine(position, origin)),
      taskId: task.id,
      taskType: task.type,
      taskName: task.name,
      magicType,
      glass: magicType === "TASKTYPE_GLASS",
      lightmap: lightmapFor(path, model, geometry),
      taskIndex: taskIndex.get(task),
      attachmentPath: path.includes("/") ? path.slice(path.indexOf("/") + 1) : "",
    });
    if (chain.length >= ATTACHMENT_DEPTH_LIMIT) {
      if (geometry.attachments.length) warnings.push(`attachment depth limit reached under ${chain.join(" > ")}`);
      return;
    }
    for (const [attIndex, attachment] of geometry.attachments.entries()) {
      if (chain.includes(attachment.name)) {
        warnings.push(`attachment cycle ${chain.join(" > ")} > ${attachment.name}`);
        continue;
      }
      const type = magic.get(attachment.name) ?? null;
      if (type && HIDDEN_MAGIC.has(type)) continue;
      if (!modelPayloads.has(attachment.name)) {
        warnings.push(`attachment ${attachment.name} of ${model} is not in any archive`);
        continue;
      }
      // ATTA matrices are applied as row vectors (v * M) => column form is M^T, re-orthonormalised
      // by the child create FUN_004c4950 (full exe): mirroring records become rotations (vehicles.ts attaMatrix).
      const local = attaMatrix(attachment.matrix);
      const offset = mulMat3Vec(rotation, attachment.position);
      place(
        task,
        attachment.name,
        [position[0] + offset[0], position[1] + offset[1], position[2] + offset[2]],
        mulMat3(rotation, local),
        type,
        [...chain, attachment.name],
        `${path}/${attIndex}`,
      );
    }
  };

  // SCamera [recovered, docs/mission.md]: the task draws the "Holder Model" (POSE_SPECS) and
  // creates a child SCameraLens object (FUN_004415b0 -> FUN_004012e0) whose compile
  // (FUN_00441290) gives it the "Camera Model", puts it at the holder's magic vertex 0 and
  // turns it to Rz(Holder Gamma + Camera Gamma) Rx(Camera Alpha). Only FUN_004baaf0 sets
  // its model (no FUN_004bab70), so the model's ATTA children (313_04_1, the
  // TASKTYPE_SCAMERALENSVIEWCONE helper) are not built. The engine turns it every tick.
  const placeSecurityCameraLens = (task: IgiTask, holderPosition: Vec3) => {
    const model = stringParam(task, "Camera Model");
    const holderModel = stringParam(task, "Holder Model");
    if (!model || EDITOR_MARKER_MODELS.has(model)) return;
    const geometry = mef(model);
    if (!geometry) return;
    const holderBuffer = holderModel ? modelPayloads.get(holderModel)?.buffer : undefined;
    const magic = holderBuffer ? readMefMagicVertices(holderBuffer) : [];
    const holderGamma = numberParam(task, "Holder Gamma") ?? 0;
    const pivot = securityCameraLensPivot(holderPosition, holderGamma, magic[0] ?? null);
    const rotation = securityCameraLensMatrix(holderGamma, numberParam(task, "Camera Gamma") ?? 0, 0, numberParam(task, "Camera Alpha") ?? 0);
    usedModels.add(model);
    instances.push({
      model,
      matrix: engineMatrix4(igiRotationToEngine(rotation), igiPointToEngine(pivot, origin)),
      taskId: task.id,
      taskType: task.type,
      taskName: task.name,
      magicType: null,
      glass: false,
      lightmap: null, // vertex-lit: no LightmapInfo lists it
      taskIndex: taskIndex.get(task),
      attachmentPath: "",
      part: "scameraLens",
    });
  };

  /** IGI positions that define the mission area (for the terrain detail region). */
  const missionPoints: Vec3[] = [playerPos];
  for (const [ti, task] of tasks.entries()) {
    const spec = POSE_SPECS[task.type];
    if (!spec) continue;
    const model = spec.model(task);
    if (!model) continue;
    const position = vec3Param(task, spec.position);
    if (!position) {
      warnings.push(`${task.type} ${task.id} has no ${spec.position}`);
      continue;
    }
    missionPoints.push(position);
    let rotation: Mat3 = IDENTITY3;
    if (spec.orientation) {
      const angles = vec3Param(task, spec.orientation);
      if (angles) rotation = igiEulerToMat3(angles[0], angles[1], angles[2]);
    } else if (spec.gamma) {
      rotation = igiEulerToMat3(0, 0, numberParam(task, spec.gamma) ?? 0);
    }
    place(task, model, position, rotation, null, [model], `t${ti}`);
    if (task.type === "SCamera") placeSecurityCameraLens(task, position);
  }

  // Wires (FUN_0043e590, docs/wire.md): one instance of the model, rotated so
  // model +y runs Start -> Stop, stretched along y by length / 4096, pivot at
  // the midpoint. Bullets test its faces unstretched about the midpoint
  // (FUN_004b7a60 divides by scale.x = 1), hence the separate collision matrix.
  for (const [ti, task] of tasks.entries()) {
    if (task.type !== "Wire") continue;
    const model = stringParam(task, "Model");
    const start = vec3Param(task, "Start position");
    const stop = vec3Param(task, "Stop position");
    if (!model || !start || !stop) continue;
    const pose = wirePose(start, stop);
    if (!pose) {
      warnings.push(`Wire ${task.id} has zero length`);
      continue;
    }
    missionPoints.push(start, stop);
    const first = instances.length;
    place(task, model, pose.position, pose.linear, null, [model], `t${ti}`);
    const collisionMatrix = engineMatrix4(igiRotationToEngine(pose.rotation), igiPointToEngine(pose.position, origin));
    for (let i = first; i < instances.length; i++) instances[i].collisionMatrix = collisionMatrix;
  }

  // --- Vehicles (docs/vehicles.md) -------------------------------------------
  // Their placements are not mission points: helicopters and trains run far
  // outside the base and must not widen the terrain detail region.
  const vehicles = await loadLevelVehicles(raw, tasks, (name) => modelPayloads.get(name)?.buffer ?? null, paths.magicObjects, warnings,
    paths.missionAiScripts.replace(/ai\/?$/, "graphs/"));
  // Helicopters: compile FUN_00431bd0 poses the model at "Position" /
  // "Orientation"; the model's ATTA rotors and HeliWheel skids become attached
  // children (they move with the heli; rotor spin: engine/world/vehicles.ts).
  // Planes the same (compile FUN_00434770, full exe): gear, hatch, canopy and rudders are
  // ATTA children animated by engine/world/vehicles.ts (loaders/plane.ts).
  for (const [ti, task] of tasks.entries()) {
    if (task.type !== "Heli" && task.type !== "Plane") continue;
    const model = stringParam(task, "Model");
    const position = vec3Param(task, "Position");
    if (!model || !position) continue;
    const angles = vec3Param(task, "Orientation") ?? [0, 0, 0];
    place(task, model, position, igiEulerToMat3(angles[0], angles[1], angles[2]), null, [model], `t${ti}`);
  }
  // Trains: the locomotive and its wagons (the child Train tasks in file
  // order, FUN_00401c20 / FUN_00401c80) at their compile pose: distance =
  // "Position" (FUN_00429560), placed along the RailroadQTaskID spline by
  // FUN_004296d0 / FUN_00429bd0 (vehicles.ts placeTrain).
  const parentOf = new Map<IgiTask, IgiTask>();
  for (const t of tasks) for (const c of t.children) parentOf.set(c, t);
  const rails = new Map<number, RailSpline | null>();
  for (const task of tasks) {
    if (task.type !== "Train" || parentOf.get(task)?.type === "Train") continue;
    const railId = numberParam(task, "RailroadQTaskID") ?? -1;
    let rail = rails.get(railId);
    if (rail === undefined) {
      const spline = byId.get(railId);
      rail = spline && spline.type === "SplineObj" ? railSplineFromTask(spline) : null;
      rails.set(railId, rail);
    }
    if (!rail) {
      warnings.push(`Train ${task.id}: RailroadQTaskID ${railId} is not a SplineObj`);
      continue;
    }
    const carTasks = [task, ...task.children.filter((c) => c.type === "Train")];
    const cars = carTasks.map((c) => {
      const model = stringParam(c, "Model") ?? "";
      const data = vehicles.models.get(model);
      if (!data || data.magicVertices.length < 2) return null;
      return trainCar(c.id, model, data.magicVertices, [numberParam(c, "Displacement X") ?? 0, numberParam(c, "Displacement Y") ?? 0]);
    });
    if (cars.some((c) => c === null)) {
      warnings.push(`Train ${task.id}: a car model has no coupling vertices`);
      continue;
    }
    const poses = placeTrain(rail, cars as NonNullable<(typeof cars)[number]>[], numberParam(task, "Position") ?? 0, task.params["Flip Direction"] === true);
    poses?.forEach((pose, j) => {
      const model = cars[j]!.model;
      place(carTasks[j], model, pose.position, pose.matrix as Mat3, null, [model], `t${taskIndex.get(carTasks[j])}`);
    });
  }

  // --- Engine-space geometry for every used model --------------------------
  const models = new Map<string, LevelModel>();
  /** HSMC sets in engine space (docs/collision.md); null when the model has none. */
  const collisionSetsOf = (name: string, buffer: ArrayBuffer): [LevelCollisionSet, LevelCollisionSet] | null =>
    collisionSetsFrom(name, buffer, (x, y, z) => {
      const v = igiDirToEngine([x, y, z]);
      return [v[0] / IGI_UNITS_PER_METRE, v[1] / IGI_UNITS_PER_METRE, v[2] / IGI_UNITS_PER_METRE];
    }, warnings);
  const addModel = (name: string) => {
    if (models.has(name)) return;
    const source = mef(name)!;
    const entry = modelPayloads.get(name)!;
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
    const groups = source.groups.map((g): LevelModelGroup => {
      // Material 0xffff (the locomotive 605_01_1 has one such block): untextured, see LevelModelGroup.noMaterial.
      if (g.materialSlot < 0) return { start: g.start, count: source.modelType === 3 ? 0 : g.count, texture: null, noMaterial: true };
      const textureName = entry.textures[g.materialSlot];
      let texture: string | null = null;
      if (textureName === undefined) {
        warnings.push(`model ${name} block slot ${g.materialSlot} has no .mtp texture`);
      } else {
        texture = `${entry.archive}:${textureName}`;
        if (!textures.has(texture)) {
          warnings.push(`texture ${texture} for model ${name} is missing`);
          texture = null;
        }
      }
      return { start: g.start, count: g.count, texture };
    });
    models.set(name, {
      name,
      modelType: source.modelType,
      collision: collisionSetsOf(name, entry.buffer),
      positions,
      normals,
      uv: source.uv,
      lightmapUv: source.lightmapUv,
      indices: source.indices,
      groups,
    });
  };
  for (const name of usedModels) addModel(name);

  for (const spline of ofType("SplineObj")) {
    for (const waypoint of spline.children) {
      const position = vec3Param(waypoint, "Position");
      if (position) missionPoints.push(position);
    }
  }

  // --- Spline objects (railway embankment, cables) ------------------------
  const hasTexture = (key: string) => textures.has(key);
  for (const segment of buildSplineSegments(ofType("SplineObj"), mef, modelPayloads, hasTexture, origin, warnings, (t) => taskIndex.get(t))) {
    models.set(segment.model.name, segment.model);
    instances.push(segment.instance);
  }

  // Bounds over instance origins (cheap and sufficient for ground fitting).
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const instance of instances) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], instance.matrix[12 + k]);
      max[k] = Math.max(max[k], instance.matrix[12 + k]);
    }
  }

  // --- Player -----------------------------------------------------------
  const weapons: string[] = [];
  const ammo: Record<string, number> = {};
  for (const child of playerTask.children) {
    const values = child.children.length === 0 ? Object.values(child.params) : [];
    if (child.type.startsWith("Gun") || child.type === "Binocular") {
      const id = values.find((v): v is string => typeof v === "string" && v.startsWith("WEAPON_ID_"));
      if (id) weapons.push(id);
    } else if (child.type === "AddAmmo") {
      const id = values.find((v): v is string => typeof v === "string" && v.startsWith("AMMO_ID_"));
      const count = values.find((v): v is number => typeof v === "number");
      if (id && count !== undefined) ammo[id] = (ammo[id] ?? 0) + count;
    }
  }
  const player = {
    position: igiPointToEngine(playerPos, origin),
    yaw: numberParam(playerTask, "Gamma") ?? 0,
    weapons,
    ammo,
    model: stringParam(playerTask, "Model")?.toLowerCase() || null,
  };

  // --- Soldier AI: view (AI scripts) and combat settings (settings.qvm) ----
  let difficulty: string | null = null;
  if (await raw.exists(paths.config)) {
    for (const call of readQvmCallTree(await raw.readBinary(paths.config))) {
      const [value] = call.args;
      if (call.fn === "GOGameDiff" && value !== undefined && isQvmSymbol(value)) difficulty = value.symbol;
    }
  }
  if (!difficulty) warnings.push("config.qvm has no GOGameDiff difficulty; soldiers use placeholder combat values");
  const controls: IgiLevel["controls"] = { bindings: [], mouseSensitivity: null, invertMouse: false };
  if (await raw.exists(paths.config)) {
    for (const call of readQvmCallTree(await raw.readBinary(paths.config))) {
      const [a, b, c] = call.args;
      const name = (v: QvmValue | undefined) => (v !== undefined && isQvmSymbol(v) ? v.symbol : typeof v === "string" ? v : null);
      if (call.fn === "GOInRemap") {
        const action = name(a);
        const device = name(b);
        const key = name(c);
        if (action && device && key) controls.bindings.push({ action, device, key });
      } else if (call.fn === "GOInMouSens" && typeof a === "number") controls.mouseSensitivity = a;
      // The raw field (config +0x538): 1 negates the look channel (FUN_0045cde0), i.e. the menu shows "Invert Mouse: No".
      else if (call.fn === "GOInMouInv") controls.invertMouse = a === 1 || a === true;
    }
  }
  const humanPlayer = (await raw.exists(paths.humanPlayer)) ? decodeHumanPlayerParams(await raw.readBinary(paths.humanPlayer)) : null;
  if (!humanPlayer) warnings.push("humanplayer.qvm is missing; the player uses placeholder movement");
  const surfaceMaterials = (await raw.exists(paths.materials)) ? readSurfaceMaterials(await raw.readBinary(paths.materials)) : [];
  if (surfaceMaterials.length === 0) warnings.push("material.qvm is missing; surfaces have no sounds or see-through values");
  const combatByType = new Map<string, LevelAiCombat>();
  if (difficulty && (await raw.exists(paths.aiSettings))) {
    for (const item of flattenTasks(readTaskTree(readQvmCallTree(await raw.readBinary(paths.aiSettings))))) {
      if (item.type !== "HumanAIConfigItem" || stringParam(item, "Difficulty") !== difficulty) continue;
      const type = stringParam(item, "AI Type");
      const num = (name: string): number => {
        const value = numberParam(item, name);
        if (value === null) throw new Error(`level: ${type} ${difficulty} lacks "${name}"`);
        return value;
      };
      if (!type) continue;
      combatByType.set(type, {
        damageScale: num("Damage scale"),
        initialMovementDelay: num("Combat initial movement delay (in seconds)"),
        targetingTimeout: num("Combat targeting timeout (in seconds)"),
        trackingDistance: num("Combat tracking distance (in meters)"),
        hitProbabilityMinRange: num("Combat firing hit probability at minimum range"),
        hitProbabilityMaxRange: num("Combat firing hit probability at maximum range"),
        maxRoundsPerSequence: num("Combat Firing Max Number Of Rounds per sequence"),
        minClipFraction: num("Combat firing minimum clip percentage"),
        randomClipFraction: num("Combat firing random clip percentage"),
        minDelay: num("Combat firing minimum delay (in seconds)"),
        randomDelay: num("Combat firing random delay (in seconds)"),
        minShotDelay: num("Combat firing minimum shot delay (in seconds)"),
        randomShotDelay: num("Combat firing random shot delay (in seconds)"),
      });
    }
  }
  const VIEW_CALLS = [
    "AIFunction_SetViewLength",
    "AIFunction_SetAlarmViewLength",
    "AIFunction_SetViewAlpha",
    "AIFunction_SetViewGamma",
  ] as const;
  /** Single literal per view call in a script (more than one call site is ambiguous and ignored). */
  const viewCalls = async (path: string): Promise<Partial<Record<(typeof VIEW_CALLS)[number], number>>> => {
    if (!(await raw.exists(path))) return {};
    const found = readQvmLiteralCalls(await raw.readBinary(path), VIEW_CALLS);
    const out: Partial<Record<(typeof VIEW_CALLS)[number], number>> = {};
    for (const name of VIEW_CALLS) {
      const values = found.get(name) ?? [];
      if (values.length === 1) out[name] = values[0];
      else if (values.length > 1) warnings.push(`${path}: ${values.length} ${name} calls; ignored`);
    }
    return out;
  };
  // Shared script per AI type, by name: *_GUARD_* -> guard, *_PATROL_* ->
  // patrol, AITYPE_SNIPER -> sniper, ... (igi.exe lists common/ai/<name>.qsc;
  // the type -> script mapping itself is inferred from the names).
  const aiScriptFor = (aiType: string): string | null => {
    const family = /^AITYPE_(?:[A-Z]+_)?(GUARD|PATROL)_[A-Z0-9]+$/.exec(aiType)?.[1] ?? /^AITYPE_([A-Z]+)$/.exec(aiType)?.[1];
    return family ? `${paths.aiScripts}${family.toLowerCase()}.qvm` : null;
  };
  const sharedViews = new Map<string, Awaited<ReturnType<typeof viewCalls>>>();
  const viewFor = async (aiType: string | null, aiTaskId: number | null): Promise<LevelAiView | null> => {
    const script = aiType ? aiScriptFor(aiType) : null;
    if (!script) return null;
    if (!sharedViews.has(script)) sharedViews.set(script, await viewCalls(script));
    // The mission's own script runs AIFunction_DefaultHandler first on
    // AIEVENT_CREATE, then its own calls, so its values override (level 1:
    // 2209.qvm sets view length 20).
    const own = aiTaskId !== null ? await viewCalls(`${paths.missionAiScripts}${aiTaskId}.qvm`) : {};
    const merged = { ...sharedViews.get(script)!, ...own };
    const [length, alarmLength, alpha, gamma] = VIEW_CALLS.map((name) => merged[name]);
    if (length === undefined || alarmLength === undefined || alpha === undefined || gamma === undefined) {
      warnings.push(`${aiType}: view parameters not found in ${script}`);
      return null;
    }
    return { length, alarmLength, alpha, gamma };
  };

  // --- Soldiers -------------------------------------------------------------
  const soldiers: LevelSoldier[] = [];
  const taskIndexOf = new Map<IgiTask, number>(tasks.map((t, i) => [t, i]));
  // combat: every soldier class (HumanSoldier, HumanSoldierFemale, HumanSoldierRPG; soldier-types.ts), in task order.
  for (const task of tasks.filter((t) => isSoldierTaskType(t.type))) {
    const defaults = SOLDIER_TYPE_DEFAULTS[task.type] ?? SOLDIER_TYPE_DEFAULTS.HumanSoldier;
    const position = vec3Param(task, "Position");
    if (!position) continue;
    const ai = task.children.find((c) => c.type === "HumanAI");
    const gun = task.children.find((c) => c.type.startsWith("Gun"));
    const aiType = ai ? stringParam(ai, "AI Type") : null;
    let gunId = gun ? Object.values(gun.params).find((v): v is string => typeof v === "string" && v.startsWith("WEAPON_ID_")) : undefined;
    // Two AITYPE_PATROL_AK soldiers carry no Gun task; their AI type names the
    // AK, so they get one (inferred).
    if (!gunId && aiType?.endsWith("_AK")) gunId = "WEAPON_ID_AK47";
    missionPoints.push(position);
    soldiers.push({
      taskId: task.id,
      taskType: task.type,
      name: task.name,
      position: igiPointToEngine(position, origin),
      yaw: numberParam(task, "Gamma") ?? 0,
      team: numberParam(task, "Team") ?? 1,
      model: stringParam(task, "Model") ?? "",
      aiType,
      weapon: gunId ?? null,
      view: await viewFor(aiType, ai ? ai.id : null),
      combat: (aiType && combatByType.get(aiType)) || null,
      skeleton: numberParam(task, "Bone Heirachy") ?? defaults.skeleton,
      standAnimation: numberParam(task, "Stand Animation") ?? defaults.standAnimation,
      aiTaskId: ai ? ai.id : null,
      graphId: ai ? numberParam(ai, "Graph ID") : null,
      taskIndex: taskIndexOf.get(task) ?? -1,
      aiTaskIndex: ai ? (taskIndexOf.get(ai) ?? null) : null,
    });
    if (aiType && difficulty && !combatByType.has(aiType)) warnings.push(`no ${difficulty} combat settings for ${aiType}`);
  }

  // --- Light keyframes ---------------------------------------------------------
  // igi.exe initialises time-of-day to 0 and never advances it here, which is
  // below every keyframe, so the earliest keyframe applies (level 1: Time 12).
  // [recovered: FUN_00521230(0) / FUN_005221c0(0); docs/terrain.md]
  const earliest = (type: string) =>
    ofType(type).reduce<IgiTask | undefined>(
      (best, t) => (best === undefined || (numberParam(t, "Time") ?? Infinity) < (numberParam(best, "Time") ?? Infinity) ? t : best),
      undefined,
    );
  const light = earliest("GlobalLightKeyframe");
  const sun = earliest("DirlightKeyframe");

  // --- Terrain (octree + HeightMap relief) -----------------------------------
  const heightMaps: HeightMapTask[] = [];
  for (const task of ofType("HeightMap")) {
    const position = vec3Param(task, "Position");
    const heightLevel = numberParam(task, "Level");
    const size = numberParam(task, "Size");
    const bitmapId = numberParam(task, "Bitmap ID");
    if (position && heightLevel !== null && size !== null && bitmapId !== null) {
      heightMaps.push({ position, level: heightLevel, size, bitmapId });
    }
  }
  // terrain.hmp holds the HeightMap tasks' relief grids; a mission without HeightMap tasks has no
  // such file (level 2, 4, 5, 7, 11-14 of the full game).
  let hmp: ArrayBuffer | undefined;
  if (heightMaps.length) {
    try {
      hmp = await raw.readBinary(paths.terrain.hmp);
    } catch (error) {
      warnings.push(`terrain: ${heightMaps.length} HeightMap tasks but ${paths.terrain.hmp} is not readable (${(error as Error).message}); no relief`);
    }
  }
  const octree = new TerrainOctree(await raw.readBinary(paths.terrain.ctr), await raw.readBinary(paths.terrain.cmd), hmp, heightMaps);
  if (octree.invalidSlots) warnings.push(`terrain: ${octree.invalidSlots} octree child slots point outside terrain.ctr (dropped)`);
  // DiscardTerrain (full game: basements and lift shafts below grade; schema Position, Level = 10).
  for (const task of ofType("DiscardTerrain")) {
    const position = vec3Param(task, "Position");
    if (position) octree.addDiscard(position, numberParam(task, "Level") ?? 10);
  }
  // Collision: full detail over the mission area padded by 256 m, snapped to
  // the level-16 cell grid (2^15 units). Rendering picks its own cells per
  // frame (TerrainOctree.selectCells).
  const pad = 2 ** 20;
  const snap = 2 ** 15;
  // Each mission point gets its padded square; overlapping squares merge into one box. One box
  // over everything would be 28 x 14 km of full detail in mission 4 (GOD), whose planes start 30 km
  // from the player; the other missions' areas come out as before (one box).
  const boxes: Array<[number, number, number, number]> = missionPoints.map((q) => [
    Math.floor((q[0] - pad) / snap) * snap,
    Math.floor((q[1] - pad) / snap) * snap,
    Math.ceil((q[0] + pad) / snap) * snap,
    Math.ceil((q[1] + pad) / snap) * snap,
  ]);
  const terrainBoxes = mergeBoxes(boxes);
  const toEngineMesh = (mesh: { positions: Float64Array; indices: Uint32Array }): LevelTerrainMesh => {
    const positions = new Float32Array(mesh.positions.length);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      // Subtract the origin in float64 before narrowing (world z ~ 1.7e8).
      const p = igiPointToEngine([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]], origin);
      positions[i] = p[0];
      positions[i + 1] = p[1];
      positions[i + 2] = p[2];
    }
    return { positions, indices: mesh.indices };
  };
  // Texturing inputs: terrain.qvm materials/tile maps + objects.qvm modifiers and lightmap tiles.
  const materials = new Map<number, TerrainMaterialLevel[]>();
  const tilemaps = new Map<number, number[]>();
  for (const call of readQvmCallTree(await raw.readBinary(paths.terrain.qvm))) {
    const values = call.args.map((v) => (v === true ? 1 : v === false ? 0 : v));
    if (!values.every((v): v is number => typeof v === "number")) {
      throw new Error(`level: unexpected argument in terrain.qvm ${call.fn}`);
    }
    if (call.fn === "CreateTerrainMaterial") {
      const [id, , ...records] = values;
      if (records.length % 7 !== 0) throw new Error("level: CreateTerrainMaterial records are not 7 values each");
      const levels: TerrainMaterialLevel[] = [];
      for (let i = 0; i < records.length; i += 7) {
        levels.push({ scaleA: records[i + 3], tilemapA: records[i + 4], scaleB: records[i + 5], tilemapB: records[i + 6] });
      }
      materials.set(id, levels);
    } else if (call.fn === "CreateTerrainTileMap") {
      const [id, ...entries] = values;
      if (entries.length !== 64) throw new Error("level: CreateTerrainTileMap does not have 64 entries");
      tilemaps.set(id, entries);
    }
  }
  const look = new TerrainLook(
    octree,
    {
      materials,
      tilemaps,
      modifiers: ofType("TextureModifier").flatMap((t) => {
        const position = vec3Param(t, "Position");
        const level = numberParam(t, "Level");
        const material = numberParam(t, "Material Index");
        const bitmapId = numberParam(t, "Bitmap ID");
        return position && level !== null && material !== null && bitmapId !== null ? [{ position, level, material, bitmapId }] : [];
      }),
      lightmaps: ofType("TerrainLightMap").flatMap((t) => {
        const position = vec3Param(t, "Position");
        const level = numberParam(t, "Level");
        const textureIndex = numberParam(t, "TextureIndex");
        return position && level !== null && textureIndex !== null ? [{ position, level, textureIndex }] : [];
      }),
      ambient: rgb(light, "Ambient color terrain", [0.27, 0.29, 0.33]),
      sun: rgb(sun, "Front Color", [1, 0.77, 0.62]),
    },
    await raw.readBinary(paths.terrain.bit),
    await raw.readBinary(paths.terrain.lmp),
  );
  const terrain: LevelTerrain = {
    detail: toEngineMesh(joinMeshes(terrainBoxes.map((b) => octree.mesh(b, TERRAIN_GAME_MAX_LEVEL)))),
    sun: rgb(sun, "Front Color", [1, 0.77, 0.62]),
    ambient: rgb(light, "Ambient color terrain", [0.27, 0.29, 0.33]),
    octree,
    look,
  };

  // --- Areas, objectives, messages ----------------------------------------
  const areaOf = (id: number): LevelArea | null => {
    const task = byId.get(id);
    if (!task || task.type !== "AreaActivate") return null;
    const position = vec3Param(task, "Position");
    const dims = vec3Param(task, "Dimensions");
    if (!position || !dims) return null;
    // Dimensions are read as FULL box sizes in IGI axes (inferred: objective
    // area 200 then spans the truck cab, 4.6 m x 2.6 m; as half sizes it
    // would be twice the truck's width).
    return {
      taskId: id,
      center: igiPointToEngine(position, origin),
      halfExtents: [
        dims[0] / 2 / IGI_UNITS_PER_METRE,
        dims[2] / 2 / IGI_UNITS_PER_METRE,
        dims[1] / 2 / IGI_UNITS_PER_METRE,
      ],
    };
  };
  const areaRefs = (expression: string): number[] =>
    [...expression.matchAll(/AreaActivate_(\d+)\.nActive/g)].map((m) => Number(m[1]));
  /** AreaActivate ids an expression depends on, following EditVariable "Add" rules one level. */
  const resolveAreas = (expression: string): number[] => {
    const ids = areaRefs(expression);
    for (const m of expression.matchAll(/EditVariable_(\d+)\.nValue/g)) {
      const variable = byId.get(Number(m[1]));
      const add = variable ? stringParam(variable, "Add") : null;
      if (add) ids.push(...areaRefs(add));
    }
    return [...new Set(ids)];
  };

  const objectiveText = await readStrings(raw, paths.objectiveText);
  const messageText = await readStrings(raw, paths.messageText);
  const missionText = await readStrings(raw, paths.missionText);

  const objectives: LevelObjective[] = [];
  for (const task of ofType("DefineComputerObjective")) {
    for (let n = 1; n <= 6; n++) {
      const resource = stringParam(task, `Objective ${n} Text Resource`);
      const complete = stringParam(task, `Objective ${n} Complete Expression`);
      if (!resource || !complete) continue;
      const ids = resolveAreas(complete);
      const area = ids.length === 1 ? areaOf(ids[0]) : null;
      if (!area) {
        warnings.push(`objective ${resource}: completion "${complete.trim()}" is not a single area`);
        continue;
      }
      objectives.push({ id: resource, text: objectiveText.get(resource) ?? resource, area });
    }
  }

  const messages: LevelMessage[] = [];
  for (const task of ofType("StatusMessage")) {
    const send = stringParam(task, "Send");
    const text = stringParam(task, "Text");
    if (!send || !text) continue;
    const ids = areaRefs(send);
    // Only messages gated purely on the player entering an area are wired;
    // any extra condition (doors, alarms) is reported and ignored.
    if (ids.length !== 1) continue;
    const area = areaOf(ids[0]);
    if (!area) continue;
    if (send.replace(/AreaActivate_\d+\.nActive/, "").trim() !== "") {
      warnings.push(`message ${text}: extra condition ignored in "${send.trim()}"`);
    }
    messages.push({ id: text, text: messageText.get(text) ?? text, area });
  }

  // --- Environment (time-of-day 12 keyframes) ------------------------------
  const sky = ofType("FlatSky")[0];
  const beta = sun ? numberParam(sun, "Beta") ?? Math.PI / 4 : Math.PI / 4;
  const gamma = sun ? numberParam(sun, "Gamma") ?? 0 : 0;
  // Beta read as elevation and gamma as azimuth from +x (inferred).
  // Toward the light: Rz(2pi - Gamma) Ry(2pi - Beta) e_x (FUN_00521080), i.e.
  // (cos G cos B, -sin G cos B, sin B). Level 1: (0.180, -0.847, 0.500), 7.6
  // degrees from the direction fitted to the baked terrain lightmaps.
  const sunIgi: Vec3 = [Math.cos(gamma) * Math.cos(beta), -Math.sin(gamma) * Math.cos(beta), Math.sin(beta)];
  const skyLayer = ofType("FlatSkyLayer")[0];
  const environment: LevelEnvironment = {
    skyTop: rgb(sky, "SkyDome Top Colour", [0.12, 0.19, 0.62]),
    skyMiddle: rgb(sky, "SkyDome Middle Colour 1", [0.4, 0.6, 0.67]),
    skyBottom: rgb(sky, "SkyDome Bottom Colour 1", [0.71, 0.62, 0.52]),
    fogColor: rgb(light, "Fog color terrain", [0.58, 0.54, 0.48]),
    ambient: rgb(light, "Ambient color object category 1", [0.27, 0.29, 0.33]),
    sunDirection: igiDirToEngine(sunIgi),
    sunColor: rgb(sun, "Front Color", [1, 0.77, 0.62]),
    skyLayerTexture: skyLayer ? stringParam(skyLayer, "Texture File Name") : null,
    skyLayerColor: rgb(skyLayer, "Color", [1, 1, 1]),
    skyLayerScale: (skyLayer && numberParam(skyLayer, "Scale")) || 1e-5,
    skyLayerSpeed: [skyLayer ? numberParam(skyLayer, "X Speed") ?? 0 : 0, skyLayer ? numberParam(skyLayer, "Y Speed") ?? 0 : 0],
  };

  // --- Weapons ---------------------------------------------------------------
  const weaponTable = new Map<string, LevelWeapon>();
  const weaponTasks = flattenTasks(readTaskTree(readQvmCallTree(await raw.readBinary(paths.weaponConfig))));
  for (const task of weaponTasks) {
    if (task.type !== "WeaponConfig") continue;
    const scriptId = stringParam(task, "Script ID");
    if (!scriptId) continue;
    const num = (key: string) => numberParam(task, key) ?? 0;
    const symbolParam = (key: string): string | null => {
      const v = task.params[key];
      return v !== undefined && !Array.isArray(v) && isQvmSymbol(v) ? v.symbol : null;
    };
    weaponTable.set(scriptId, {
      scriptId,
      name: stringParam(task, "Name") ?? scriptId,
      weaponType: symbolParam("Weapon Type"),
      damageFactor: num("Damage Factor"),
      reloadSeconds: num("Reload Time"),
      roundsPerMinute: num("Rounds/Minute"),
      roundsPerClip: num("Rounds/Clip"),
      maxRoundsPerBurst: num("Maximum Rounds/Burst"),
      minSpread: num("Minimum random spread"),
      maxSpread: num("Maximum random spread"),
      recoilPitch: num("Fixed view change around X axis (degrees)"),
      recoilYaw: num("Fixed view change around Z axis (degrees)"),
      recoilPitchRandom: num("Random view change around X axis (degrees)"),
      recoilYawRandom: num("Random view change around Z axis (degrees)"),
      calibreId: num("Calibre ID"),
      aiDetection: symbolParam("AI Detection Event Range"),
      rangeMetres: num("Effective Range of Weapon"),
      fireSound: stringParam(task, "Fire Sound Loop/Single Sample") || null,
      fireSoundEnd: stringParam(task, "Fire Sound Loop End Sample") || null,
      reloadSounds: [],
      gunModel: stringParam(task, "Gun Model") || null,
      weaponNumber: num("Weapon ID"),
      ammoDisplay: symbolParam("Ammo Display Type"),
      penetration: num("Penetration Power"),
      muzzleVelocity: num("Muzzle Velocity"),
      bulletsPerRound: num("Bullets/Round"),
      firstPersonAnims: {
        stand: numberParam(task, "StandAnim") ?? -1,
        move: numberParam(task, "MoveAnim") ?? -1,
        fire: ["FireAnim1", "FireAnim2", "FireAnim3"].map((k) => numberParam(task, k) ?? -1).filter((v) => v >= 0),
        reload: numberParam(task, "ReloadAnim") ?? -1,
      },
    });
  }

  // --- Gun models (gun + attached magazine / moving part / flame) ----------
  // First person: the body follows arms bone 3, GUNCLIP bone 52 and
  // GUNMOVINGPART bone 55 (docs/characters.md); third person: the whole gun
  // on soldier bone 22 with the parts at their ATTA offsets. GUNFLAME parts
  // are the muzzle flash (drawn additively, docs/rendering.md).
  const ROLE: Record<string, LevelGunPart["role"]> = {
    TASKTYPE_GUNCLIP: "clip",
    TASKTYPE_GUNMOVINGPART: "moving",
    TASKTYPE_GUNFLAME: "flame",
  };
  const guns = new Map<string, LevelGunPart[]>();
  const carriedWeapons = new Set<string>([...weapons, ...soldiers.map((s) => s.weapon).filter((w): w is string => w !== null)]);
  // GunPickup weapons too: the pickup draws the Gun Model (render/pickups.ts) and the player can then carry it.
  for (const t of ofType("GunPickup")) carriedWeapons.add(stringParam(t, "ID") ?? "");
  // combat: the StationaryGun's weapon ("Weapon ID", default WEAPON_ID_M2HB) and the turrets' (the weaponconfig whose
  // "Gun Model" is the turret definition's gun model, FUN_00413c00): their gun models, flames and fire sounds.
  for (const t of ofType("StationaryGun")) carriedWeapons.add(stringParam(t, "Weapon ID") || "WEAPON_ID_M2HB");
  const placedTurretGuns = new Set(instances.filter((i) => i.magicType === "TASKTYPE_AISTATIONARYGUN").map((i) => turretGunModels.get(i.model) ?? ""));
  for (const w of weaponTable.values()) if (w.gunModel && placedTurretGuns.has(w.gunModel)) carriedWeapons.add(w.scriptId);
  // AmmoPickup models: DefineAmmoType arg 13 (FUN_0046c350).
  const ammoTypes = await loadAmmoTypes(raw, warnings);
  for (const t of ofType("AmmoPickup")) {
    const model = ammoTypes.get(stringParam(t, "ID") ?? "")?.model;
    if (model && modelPayloads.has(model) && mef(model)) addModel(model);
  }
  for (const id of carriedWeapons) {
    const gun = weaponTable.get(id)?.gunModel;
    if (!gun || !modelPayloads.has(gun)) continue;
    const parts: LevelGunPart[] = [];
    const collect = (model: string, position: Vec3, rotation: Mat3, depth: number, role: LevelGunPart["role"]) => {
      const geometry = mef(model);
      if (!geometry || EDITOR_MARKER_MODELS.has(model)) return;
      addModel(model);
      parts.push({
        model,
        role,
        matrix: engineMatrix4(igiRotationToEngine(rotation), igiDirToEngine(position).map((v) => v / IGI_UNITS_PER_METRE) as Vec3),
        blocks: geometry.groups.map((g) => ({ deferred: g.deferredFlag !== 0, additive: (g.blendFlags & 1) !== 0 })),
      });
      if (depth >= ATTACHMENT_DEPTH_LIMIT) return;
      for (const a of geometry.attachments) {
        const type = magic.get(a.name) ?? null;
        if ((type && HIDDEN_MAGIC.has(type) && type !== "TASKTYPE_GUNFLAME") || !modelPayloads.has(a.name)) continue;
        const offset = mulMat3Vec(rotation, a.position);
        collect(
          a.name,
          [position[0] + offset[0], position[1] + offset[1], position[2] + offset[2]],
          mulMat3(rotation, transposeMat3(a.matrix as Mat3)),
          depth + 1,
          (type && ROLE[type]) || "part",
        );
      }
    };
    collect(gun, [0, 0, 0], IDENTITY3, 0, "body");
    guns.set(id, parts);
  }

  // combat: models drawn at run time outside the placed instances (render/combat-models.ts): the weaponconfig
  // projectile tags ("M203 - Model" 108_05_1, "Missile - Model" 110_02_1) of the weapons in the level.
  for (const task of weaponTasks) {
    if (task.type !== "WeaponConfig" || !carriedWeapons.has(stringParam(task, "Script ID") ?? "")) continue;
    for (const c of task.children) {
      const name = c.params["Name"];
      const value = c.params["Value"];
      if (c.type.startsWith("TagItem") && typeof name === "string" && / - Model$/i.test(name) && typeof value === "string" && modelPayloads.has(value) && mef(value)) addModel(value);
    }
  }

  // turrets (combat/vehicle-weapons.ts, combat/missile.ts): the Mil rocket pods' HIND rocket (700_10_1,
  // hard-wired in the RocketPod update FUN_00427a70, full exe) is drawn; the run-time models' magic
  // vertices (the vehicle turrets' gun models: muzzle = vertex 2; the missiles: contact point = vertex 0,
  // smoke at vertex 1) join the vehicle model data.
  if (instances.some((i) => i.magicType === "TASKTYPE_ROCKETPOD") && modelPayloads.has(ROCKET_POD_MISSILE_MODEL) && mef(ROCKET_POD_MISSILE_MODEL)) addModel(ROCKET_POD_MISSILE_MODEL);
  for (const name of [...placedTurretGuns, ...models.keys()]) {
    if (!name || vehicles.models.has(name)) continue;
    const isMissile = vehicles.types.some((t) => t.taskType === "TASKTYPE_MISSILE" && t.model.toLowerCase() === name.toLowerCase());
    if (!placedTurretGuns.has(name) && !isMissile) continue;
    const buffer = modelPayloads.get(name)?.buffer;
    if (!buffer) continue;
    try {
      vehicles.models.set(name, { magicVertices: readMefMagicVertices(buffer), attachments: readMef(buffer).attachments });
    } catch (error) {
      warnings.push(`turret / missile model ${name}: ${(error as Error).message}`);
    }
  }

  // --- Skinned models and animations (soldiers, first-person arms) ---------
  const boneModels = new Map<string, LevelBoneModel>();
  const addBoneModel = (name: string) => {
    if (boneModels.has(name)) return;
    const entry = modelPayloads.get(name);
    if (!entry) {
      warnings.push(`bone model ${name} is not in any archive`);
      return;
    }
    const geometry = mef(name);
    const slots = new Set((geometry?.groups ?? []).map((g) => g.materialSlot));
    const textureKeys: (string | null)[] = [];
    for (let slot = 0; slot <= Math.max(-1, ...slots); slot++) {
      const textureName = entry.textures[slot];
      const key = textureName === undefined ? null : `${entry.archive}:${textureName}`;
      if (slots.has(slot) && (key === null || !textures.has(key))) warnings.push(`bone model ${name} slot ${slot} has no texture`);
      textureKeys.push(key !== null && textures.has(key) ? key : null);
    }
    boneModels.set(name, { name, buffer: entry.buffer, textureKeys });
  };
  for (const s of soldiers) if (s.model) addBoneModel(s.model);
  addBoneModel(FIRST_PERSON_ARMS_MODEL);
  // The player's own body: it is never drawn in first person, but AI bullets hit it (its collision set 0).
  if (player.model) addBoneModel(player.model);
  const animations = new Map<number, ArrayBuffer>();
  for (const id of new Set([...soldiers.map((s) => s.skeleton), FIRST_PERSON_ARMS_SKELETON, PLAYER_BODY_SKELETON])) {
    const path = `${paths.anims}${String(id).padStart(3, "0")}.iff`;
    if (await raw.exists(path)) animations.set(id, await raw.readBinary(path));
    else warnings.push(`animation file ${path} is missing`);
  }

  // --- Sounds used by the carried and enemy weapons ------------------------
  const soundMembers = readIlffMembers(await raw.readBinary(paths.sounds));
  const soundNames = soundMembers.map((m) => baseName(m.name));
  for (const weapon of weaponTable.values()) {
    const prefix = RELOAD_SOUND_PREFIX[weapon.scriptId];
    if (!prefix) continue;
    weapon.reloadSounds = soundNames
      .filter((n) => new RegExp(`^${prefix}_\\d+$`).test(n))
      .sort((a, b) => Number(a.slice(prefix.length + 1)) - Number(b.slice(prefix.length + 1)));
  }
  const wanted = new Set<string>(["guns_dry_1"]);
  for (const id of [...weapons, ...soldiers.map((s) => s.weapon ?? "")]) {
    const w = weaponTable.get(id);
    if (w?.fireSound) wanted.add(w.fireSound);
    if (w?.fireSoundEnd) wanted.add(w.fireSoundEnd);
    if (w && weapons.includes(id)) w.reloadSounds.forEach((n) => wanted.add(n));
  }
  const sounds = new Map<string, DecodedSound>();
  for (const member of soundMembers) {
    const name = baseName(member.name);
    if (!wanted.has(name)) continue;
    try {
      sounds.set(name, decodeIlsf(member.payload));
    } catch (error) {
      warnings.push(`sound ${name}: ${(error as Error).message}`);
    }
  }

  const n = paths.missionNumber;
  return {
    paths,
    name: missionText.get(`Mission ${n} Name`) ?? `Mission ${n}`,
    description: missionText.get(`Mission ${n} Desc`) ?? "",
    origin,
    models,
    instances,
    terrain,
    lightmaps,
    objectLight: {
      sunDirection: igiDirToEngine(sunIgi),
      front: rgb(sun, "Front Color", [1, 0.77, 0.62]),
      ambient: rgb(light, "Ambient color object category 1", [0.27, 0.29, 0.33]),
    },
    textures,
    player,
    soldiers,
    difficulty,
    tasks,
    taskRoots,
    messageStrings: messageText,
    originIgi: origin,
    guns,
    ammoTypes,
    boneModels,
    animations,
    humanPlayer,
    surfaceMaterials,
    controls,
    objectives,
    messages,
    failedText: messageText.get("MISSION_FAILED") ?? "Mission Failed!",
    completeText: "Mission complete",
    environment,
    weapons: weaponTable,
    sounds,
    bounds: { min, max },
    vehicles,
    aiTurretDefs,
    warnings,
  };
}

/**
 * A model's two HSMC collision sets (docs/collision.md) mapped by `place`
 * (model-space IGI point -> engine point). Faces keep the outward winding
 * (a, c, b) (outward normal (c - a) x (b - a) in IGI space, and the engine
 * frame is a proper rotation of it); portal polygons are dropped because no
 * traced query tests them (0x4b84c0, 0x4ba07e). Null when the model has no
 * collision chunks (LOD variants).
 */
function collisionSetsFrom(
  name: string,
  buffer: ArrayBuffer,
  place: (x: number, y: number, z: number) => Vec3,
  warnings: string[],
): [LevelCollisionSet, LevelCollisionSet] | null {
  let model: CollisionModel | null;
  try {
    model = readCollisionModel(buffer);
  } catch (error) {
    warnings.push(`collision of ${name}: ${(error as Error).message}`);
    return null;
  }
  if (!model) return null;
  const convert = (set: CollisionSet): LevelCollisionSet => {
    const count = set.positions.length / 3;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const v = place(set.positions[i * 3], set.positions[i * 3 + 1], set.positions[i * 3 + 2]);
      positions[i * 3] = v[0];
      positions[i * 3 + 1] = v[1];
      positions[i * 3 + 2] = v[2];
    }
    const indices: number[] = [];
    const material: number[] = [];
    for (let f = 0; f < set.faces.length / 3; f++) {
      const surface = set.surfaces[set.faceSurface[f]];
      if (!surface || surface.portal >= 0) continue;
      indices.push(set.faces[f * 3], set.faces[f * 3 + 2], set.faces[f * 3 + 1]);
      material.push(surface.material === NO_MATERIAL ? -1 : surface.material);
    }
    return { positions, indices: Uint32Array.from(indices), material: Int16Array.from(material) };
  };
  return [convert(model.sets[0]), convert(model.sets[1])];
}

/**
 * SplineObj segments drawn as igi.exe draws them (docs/vehicles.md section 6,
 * loaders/spline-segment.ts) [recovered]: waypoint k >= 1 owns the segment
 * from waypoint k-1 to k and its "Segment Model" (an empty one is not drawn);
 * the model's x range [min(0, min x), max(0, max x)] over all its LODs maps
 * onto the n-piece polyline of the rail (the trains' polyline); each vertex
 * takes its piece i = trunc(f) and fraction t from x and blends the
 * cross-section (0, y, z) between the frames M_i, M_{i+1} at the piece ends
 * (FUN_0052d340); draw normals are M_i n. Linear segments stretch the model
 * along the 3D chord with the lateral axes of Rz(heading) and keep their
 * normals. The segment's HSMC sets are deformed the same way (FUN_004db1d0 ->
 * FUN_004d80e0; the ray handler FUN_004d8380 tests them), with the winding
 * reversed for flipped segments (the handler negates their normals).
 */
function buildSplineSegments(
  splines: IgiTask[],
  mef: (name: string) => MefModel | null,
  payloads: Map<string, { archive: string; textures: string[]; buffer: ArrayBuffer }>,
  hasTexture: (key: string) => boolean,
  origin: Vec3,
  warnings: string[],
  taskIndexOf: (task: IgiTask) => number | undefined = () => undefined,
): Array<{ model: LevelModel; instance: LevelInstance }> {
  const out: Array<{ model: LevelModel; instance: LevelInstance }> = [];
  splines.forEach((spline, splineIndex) => {
    const params = splineParamsFromTask(spline);
    if (params.waypoints.length < 2) return;
    for (const seg of splineSegmentFrames(params)) {
      const name = seg.model;
      if (!name) continue; // FUN_004c82b0("") = no model: the segment is not drawn
      const source = mef(name);
      const entry = payloads.get(name);
      if (!source || !entry) continue;
      // +0xfc / +0x100: x range over the render vertices of every LOD of the model.
      const base = name.includes("_") ? name.slice(0, name.lastIndexOf("_")) : name;
      const lodPositions: Float32Array[] = [source.positions];
      for (let k = 2; payloads.has(`${base}_${k}`); k++) {
        const lod = mef(`${base}_${k}`);
        if (lod) lodPositions.push(lod.positions);
      }
      const range = segmentModelRange(lodPositions);
      if (!(range[1] - range[0] > 0)) {
        warnings.push(`spline segment ${name} has no length`);
        continue;
      }
      const deformer = segmentDeformer(seg, range);
      /** Model-space IGI point -> engine point (midpoint + float offset, then engine axes). */
      const place = (x: number, y: number, z: number): Vec3 => {
        const d = deformer.position(x, y, z);
        return igiPointToEngine([seg.mid[0] + d[0], seg.mid[1] + d[1], seg.mid[2] + d[2]], origin);
      };
      const count = source.positions.length / 3;
      const positions = new Float32Array(count * 3);
      const normals = new Float32Array(count * 3);
      for (let v = 0; v < count; v++) {
        const x = source.positions[v * 3];
        const world = place(x, source.positions[v * 3 + 1], source.positions[v * 3 + 2]);
        const normal = igiDirToEngine(deformer.normal(x, [source.normals[v * 3], source.normals[v * 3 + 1], source.normals[v * 3 + 2]]));
        for (let k = 0; k < 3; k++) {
          positions[v * 3 + k] = world[k];
          normals[v * 3 + k] = normal[k];
        }
      }
      const collision = collisionSetsFrom(name, entry.buffer, place, warnings);
      if (collision && deformer.mirrored) {
        for (const set of collision) {
          for (let i = 0; i + 2 < set.indices.length; i += 3) {
            const t = set.indices[i + 1];
            set.indices[i + 1] = set.indices[i + 2];
            set.indices[i + 2] = t;
          }
        }
      }
      if (deformer.outOfRange > 0) warnings.push(`spline segment ${name}: ${deformer.outOfRange} vertices beyond the model's x range (clamped)`);
      const groups = source.groups.map((g) => {
        const textureName = entry.textures[g.materialSlot];
        const key = textureName === undefined ? null : `${entry.archive}:${textureName}`;
        if (key === null || !hasTexture(key)) warnings.push(`spline segment ${name} slot ${g.materialSlot} has no texture`);
        return { start: g.start, count: g.count, texture: key !== null && hasTexture(key) ? key : null };
      });
      const modelName = `spline${splineIndex}_${seg.index}:${name}`;
      out.push({
        model: { name: modelName, modelType: source.modelType, collision, positions, normals, uv: source.uv, lightmapUv: null, indices: source.indices, groups },
        instance: {
          model: modelName,
          matrix: engineMatrix4(IDENTITY3, [0, 0, 0]),
          taskId: spline.id,
          taskType: "SplineObj",
          taskName: spline.name,
          magicType: null,
          glass: false,
          lightmap: null, // spline objects are not part of a building's lightmap list
          taskIndex: taskIndexOf(spline),
          attachmentPath: "",
        },
      });
    }
  });
  return out;
}

/** Decode a level texture by key (see LevelModelGroup.texture). */
export function decodeLevelTexture(level: IgiLevel, key: string): DecodedTexture {
  const payload = level.textures.get(key);
  if (!payload) throw new Error(`level: unknown texture ${key}`);
  return decodeTex(payload);
}

/** Merge axis-aligned boxes [x0, y0, x1, y1] until none overlap or touch (each result is a bounding box). */
export function mergeBoxes(input: ReadonlyArray<readonly [number, number, number, number]>): Array<[number, number, number, number]> {
  let boxes = input.map((b) => [b[0], b[1], b[2], b[3]] as [number, number, number, number]);
  for (let merged = true; merged; ) {
    merged = false;
    const out: Array<[number, number, number, number]> = [];
    for (const b of boxes) {
      const hit = out.find((o) => b[0] <= o[2] && o[0] <= b[2] && b[1] <= o[3] && o[1] <= b[3]);
      if (hit) {
        hit[0] = Math.min(hit[0], b[0]);
        hit[1] = Math.min(hit[1], b[1]);
        hit[2] = Math.max(hit[2], b[2]);
        hit[3] = Math.max(hit[3], b[3]);
        merged = true;
      } else out.push(b);
    }
    boxes = out;
  }
  return boxes;
}

/** Concatenate terrain meshes (disjoint regions: no shared vertices to weld). */
function joinMeshes(meshes: readonly TerrainMesh[]): TerrainMesh {
  if (meshes.length === 1) return meshes[0];
  const vertexCount = meshes.reduce((n, m) => n + m.positions.length, 0);
  const indexCount = meshes.reduce((n, m) => n + m.indices.length, 0);
  const positions = new Float64Array(vertexCount);
  const indices = new Uint32Array(indexCount);
  let pv = 0;
  let pi = 0;
  let cells = 0;
  for (const m of meshes) {
    positions.set(m.positions, pv);
    const base = pv / 3;
    for (let i = 0; i < m.indices.length; i++) indices[pi + i] = m.indices[i] + base;
    pv += m.positions.length;
    pi += m.indices.length;
    cells += m.cells;
  }
  return { positions, indices, cells };
}
