/**
 * Original-file data read by the object-damage and explosion code
 * (engine/combat/object-damage.ts, docs/damage.md):
 *
 *   - Model header bounds. igi.exe keeps a pointer to each model's HSEM
 *     chunk payload (object +0x6c -> [0] -> +0xc -> +0xc; the model type is
 *     its u32 at +0x20 = HSEM +32, the documented type field) and reads
 *       +0x30..+0x3c  a bounding sphere: centre xyz, radius (glass explosion
 *                     handler LAB_004489e0) [recovered use],
 *       +0x78         the largest distance of any vertex (render and both
 *                     collision sets) from the model origin (FUN_004c59a0,
 *                     every other damage handler) [recovered use; the
 *                     meaning is observed: equal on every checked model],
 *     in IGI model units.
 *   - XTVM magic vertices (FUN_004c5aa0: object +0x20 + R * (scale * v)):
 *     ExplodeObject explodes at magic vertex 0 (FUN_0047fdd0).
 *   - TASKTYPE_EXPLODEMAGICOBJ definitions of magicobj.qvm (FUN_0043b3b0).
 *   - Engine-space LevelModels for models the level does not place (the
 *     "Destroyed model"s, the explosion model 1006_01_1), built exactly like
 *     loaders/level.ts builds placed models.
 */
import type { IAssetSource } from "../contracts";
import { readCollisionModel, NO_MATERIAL, type CollisionSet } from "./collision-mesh";
import { IGI_UNITS_PER_METRE, igiDirToEngine } from "./coords";
import { readIlffMembers } from "./ilff";
import { LEVEL1_PATHS, type IgiLevelPaths, type LevelCollisionSet, type LevelModel, type LevelModelGroup } from "./level";
import { readMef } from "./mef";
import { readMtp } from "./mtp";
import { isQvmSymbol, readQvmCallTree, type QvmValue } from "./qvm";
import { readMefMagicVertices } from "./vehicles";

type Vec3 = [number, number, number];

/** HSEM bounds and magic vertices of a model, IGI model units. */
export interface MefBounds {
  /** HSEM +48 (runtime +0x30): bounding-sphere centre. */
  sphereCentre: Vec3;
  /** HSEM +60 (runtime +0x3c): bounding-sphere radius. */
  sphereRadius: number;
  /** HSEM +120 (runtime +0x78): farthest vertex from the model origin (FUN_004c59a0). */
  originRadius: number;
  /** XTVM magic vertices. */
  magic: Vec3[];
}

function alignUp(value: number, alignment: number): number {
  return alignment > 1 ? Math.ceil(value / alignment) * alignment : value;
}

/** HSEM bounds (+48 sphere, +120 origin radius) and the XTVM magic vertices of a `.mef`. */
export function readMefBounds(buffer: ArrayBuffer): MefBounds {
  const view = new DataView(buffer);
  const tag = (o: number) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (buffer.byteLength < 20 || tag(0) !== "ILFF" || tag(16) !== "OCEM") throw new Error("damage-data: not an ILFF/OCEM model");
  let pos = alignUp(20, view.getUint32(8, true));
  for (;;) {
    const size = view.getUint32(pos + 4, true);
    const payload = alignUp(pos + 16, view.getUint32(pos + 8, true));
    const delta = view.getUint32(pos + 12, true);
    if (tag(pos) === "HSEM") {
      if (size < 124) throw new Error("damage-data: HSEM too short");
      const f = (o: number) => view.getFloat32(payload + o, true);
      return {
        sphereCentre: [f(48), f(52), f(56)],
        sphereRadius: f(60),
        originRadius: f(120),
        magic: readMefMagicVertices(buffer),
      };
    }
    if (delta === 0) throw new Error("damage-data: model has no HSEM chunk");
    pos += delta;
  }
}

/** One TASKTYPE_EXPLODEMAGICOBJ definition (FUN_0043b3b0 stores the arguments after the type). */
export interface ExplodeMagicDef {
  /** Model the definition applies to (DefineMagicObj argument 0). */
  model: string;
  /** Arg 3 -> def +0x00: model shown after the explosion. */
  destroyedModel: string;
  /** Arg 4 -> def +0x2c: explosion sound. */
  sound: string;
  /** Arg 5 -> def +0x10: accumulated damage that sets it off (object +0x140). */
  hitPoints: number;
  /** Arg 6 -> def +0x28: fireballs. */
  fireballs: number;
  /** Arg 7 -> def +0x24: fragments. */
  fragments: number;
  /** Arg 8 -> def +0x20: stored, no reader found. */
  unused: number;
  /** Arg 9 -> def +0x18: falloff, metres. */
  falloffM: number;
  /** Arg 10 -> def +0x1c: explosion damage factor (object +0x144). */
  damage: number;
  /** Arg 11 -> def +0x14: blast radius, metres. */
  radiusM: number;
}

/** TASKTYPE_EXPLODEMAGICOBJ definitions of magicobj.qvm by model name (lower case). */
export function readExplodeMagicDefs(magicobjQvm: ArrayBuffer): Map<string, ExplodeMagicDef> {
  const out = new Map<string, ExplodeMagicDef>();
  for (const call of readQvmCallTree(magicobjQvm)) {
    if (call.fn !== "DefineMagicObj") continue;
    const a = call.args as QvmValue[];
    const type = a[2];
    if (!isQvmSymbol(type) || (type as { symbol: string }).symbol !== "TASKTYPE_EXPLODEMAGICOBJ") continue;
    const str = (v: QvmValue | undefined) => (typeof v === "string" ? v : "");
    const num = (v: QvmValue | undefined) => (typeof v === "number" ? v : 0);
    const model = str(a[0]).toLowerCase();
    out.set(model, {
      model,
      destroyedModel: str(a[3]),
      sound: str(a[4]),
      hitPoints: Math.fround(num(a[5])),
      fireballs: Math.trunc(num(a[6])),
      fragments: Math.trunc(num(a[7])),
      unused: Math.fround(num(a[8])),
      falloffM: Math.fround(num(a[9])),
      damage: Math.fround(num(a[10])),
      radiusM: Math.fround(num(a[11])),
    });
  }
  return out;
}

/** HSMC set in engine metres (model-local), portal faces dropped, winding (a, c, b) as loaders/level.ts. */
function engineCollisionSet(set: CollisionSet): LevelCollisionSet {
  const count = set.positions.length / 3;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const v = igiDirToEngine([set.positions[i * 3], set.positions[i * 3 + 1], set.positions[i * 3 + 2]]);
    positions[i * 3] = v[0] / IGI_UNITS_PER_METRE;
    positions[i * 3 + 1] = v[1] / IGI_UNITS_PER_METRE;
    positions[i * 3 + 2] = v[2] / IGI_UNITS_PER_METRE;
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
}

/**
 * Engine-space LevelModel of a `.mef` payload, built as loaders/level.ts
 * builds placed models (positions / normals to engine axes and metres,
 * texture keys "<archive>:<name>", HSMC sets).
 */
export function levelModelFromMef(
  name: string,
  buffer: ArrayBuffer,
  archiveId: string,
  textureNames: readonly string[],
  hasTexture: (key: string) => boolean,
): LevelModel {
  const source = readMef(buffer);
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
    if (g.materialSlot < 0) return { start: g.start, count: source.modelType === 3 ? 0 : g.count, texture: null, noMaterial: true };
    const textureName = textureNames[g.materialSlot];
    const key = textureName === undefined ? null : `${archiveId}:${textureName}`;
    return { start: g.start, count: g.count, texture: key && hasTexture(key) ? key : null };
  });
  let collision: [LevelCollisionSet, LevelCollisionSet] | null = null;
  try {
    const c = readCollisionModel(buffer);
    if (c) collision = [engineCollisionSet(c.sets[0]), engineCollisionSet(c.sets[1])];
  } catch {
    collision = null;
  }
  return { name, modelType: source.modelType, collision, positions, normals, uv: source.uv, lightmapUv: source.lightmapUv, indices: source.indices, groups };
}

export interface DamageModelData {
  /** Bounds of every requested model found in the archives (lower-case names). */
  bounds: Map<string, MefBounds>;
  /** Engine-space models built for the requested names (lower-case). */
  models: Map<string, LevelModel>;
  /** Texture names of each built model (frame textures of 1006_01_1, ...). */
  modelTextures: Map<string, string[]>;
  /** Archive id of each built model. */
  modelArchive: Map<string, string>;
  /** TASKTYPE_EXPLODEMAGICOBJ definitions (magicobj.qvm). */
  explodeMagic: Map<string, ExplodeMagicDef>;
  warnings: string[];
}

/**
 * Read the model archives (earlier archives win, as the level loader) for
 * the bounds of `boundsOf` and the full models of `build`, plus the
 * explode-magic definitions. `hasTexture` says which "<archive>:<name>"
 * texture keys the level holds (IgiLevel.textures).
 */
export async function loadDamageModelData(
  raw: IAssetSource,
  boundsOf: Iterable<string>,
  build: Iterable<string>,
  hasTexture: (key: string) => boolean,
  paths: IgiLevelPaths = LEVEL1_PATHS,
): Promise<DamageModelData> {
  const wantBounds = new Set([...boundsOf].map((n) => n.toLowerCase()));
  const wantModels = new Set([...build].map((n) => n.toLowerCase()));
  const out: DamageModelData = { bounds: new Map(), models: new Map(), modelTextures: new Map(), modelArchive: new Map(), explodeMagic: new Map(), warnings: [] };
  const seen = new Set<string>();
  for (const archive of paths.archives) {
    if (!(await raw.exists(archive.models)) || !(await raw.exists(archive.mtp))) continue;
    const mtp = readMtp(await raw.readBinary(archive.mtp));
    for (const member of readIlffMembers(await raw.readBinary(archive.models))) {
      const file = member.name.slice(member.name.lastIndexOf("/") + 1).replace(/\\/g, "/");
      const name = file.slice(file.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "").toLowerCase();
      if (seen.has(name)) continue; // earlier archives win
      seen.add(name);
      if (!wantBounds.has(name) && !wantModels.has(name)) continue;
      try {
        if (wantBounds.has(name) || wantModels.has(name)) out.bounds.set(name, readMefBounds(member.payload));
        if (wantModels.has(name)) {
          const textures = mtp.modelTextures.get(name) ?? [];
          out.models.set(name, levelModelFromMef(name, member.payload, archive.id, textures, hasTexture));
          out.modelTextures.set(name, textures);
          out.modelArchive.set(name, archive.id);
        }
      } catch (error) {
        out.warnings.push(`model ${name}: ${(error as Error).message}`);
      }
    }
  }
  for (const name of new Set([...wantBounds, ...wantModels])) if (!out.bounds.has(name)) out.warnings.push(`model ${name} is not in any archive`);
  if (await raw.exists(paths.magicObjects)) {
    try {
      out.explodeMagic = readExplodeMagicDefs(await raw.readBinary(paths.magicObjects));
    } catch (error) {
      out.warnings.push(`magicobj.qvm: ${(error as Error).message}`);
    }
  }
  return out;
}
