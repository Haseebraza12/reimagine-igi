/**
 * Vehicle data a level needs at run time (docs/vehicles.md): the
 * DefinePhysicsObjType records of the physicsobj scripts, the magic-object
 * registry, and the magic vertices (XTVM) and attachments (ATTA) of every
 * model a Heli, Car or Train task uses (and of their attached models).
 *
 * igi.exe loads every script under "LOCAL:physicsobj" (string 0x5343b0) by
 * enumerating the directory [recovered: path string; the enumeration order is
 * not traced].  A browser asset source cannot list directories, so the shipped
 * script paths are listed here [observed] and read in sorted order (the
 * order tests/vehicles.test.ts uses); the first type with a model wins
 * (FUN_004e4cc0), and no level-1 vehicle model is defined twice.
 */
import type { IAssetSource } from "../contracts";
import { readMef } from "./mef";
import type { IgiTask } from "./tasks";
import { stringParam } from "./tasks";
import {
  readMagicObjects,
  readMefMagicVertices,
  readPhysicsObjTypes,
  type MagicObjectDef,
  type PhysicsObjType,
  type VehicleModelData,
} from "./vehicles";

/** Every physicsobj script of the shipped game [observed], sorted. */
export const PHYSICSOBJ_SCRIPTS = [
  "physicsobj/cars/APC/car.qvm",
  "physicsobj/cars/Limo/car.qvm",
  "physicsobj/cars/buggy/car.qvm",
  "physicsobj/cars/cutscene_truck/car.qvm",
  "physicsobj/cars/t80/car.qvm",
  "physicsobj/cars/truck/car.qvm",
  "physicsobj/helis/bell/heli.qvm",
  "physicsobj/helis/mil/heli.qvm",
  "physicsobj/missiles/HIND/missile.qvm",
  "physicsobj/missiles/RPG18/missile.qvm",
  "physicsobj/missiles/cgm2/missile.qvm",
  "physicsobj/physicsobj.qvm",
  "physicsobj/planes/CutSceneMissile/plane.qvm",
  "physicsobj/planes/JSF/plane.qvm",
  "physicsobj/planes/SU27/plane.qvm",
  "physicsobj/trains/train.qvm",
  "physicsobj/weapons/physicsobj.qvm",
];

/** Task types whose "Model" is a vehicle (docs/vehicles.md). */
export const VEHICLE_TASK_TYPES = new Set(["Heli", "Car", "Train"]);

export interface LevelVehicles {
  /** DefinePhysicsObjType records (PHYSICSOBJ_SCRIPTS order). */
  types: PhysicsObjType[];
  /** magicobj.qvm DefineMagicObj by lower-case model name. */
  magic: Map<string, MagicObjectDef>;
  /** XTVM + ATTA of the vehicle task models and of every model attached to them (by model name). */
  models: Map<string, VehicleModelData>;
}

export async function loadLevelVehicles(
  raw: IAssetSource,
  tasks: readonly IgiTask[],
  modelBuffer: (name: string) => ArrayBuffer | null,
  magicObjectsPath: string,
  warnings: string[],
): Promise<LevelVehicles> {
  const types: PhysicsObjType[] = [];
  for (const path of PHYSICSOBJ_SCRIPTS) {
    if (!(await raw.exists(path))) continue;
    try {
      types.push(...readPhysicsObjTypes(await raw.readBinary(path), path));
    } catch {
      // The three plane scripts use argument expressions the call-tree reader does not evaluate (vehicles.ts).
    }
  }
  const magic = (await raw.exists(magicObjectsPath)) ? readMagicObjects(await raw.readBinary(magicObjectsPath)) : new Map<string, MagicObjectDef>();
  const models = new Map<string, VehicleModelData>();
  const visit = (name: string, depth: number) => {
    if (models.has(name) || depth > 4) return;
    const buffer = modelBuffer(name);
    if (!buffer) {
      warnings.push(`vehicle model ${name} is not in any archive`);
      return;
    }
    try {
      const data: VehicleModelData = { magicVertices: readMefMagicVertices(buffer), attachments: readMef(buffer).attachments };
      models.set(name, data);
      for (const a of data.attachments) visit(a.name, depth + 1);
    } catch (error) {
      warnings.push(`vehicle model ${name}: ${(error as Error).message}`);
    }
  };
  for (const task of tasks) {
    if (!VEHICLE_TASK_TYPES.has(task.type)) continue;
    const model = stringParam(task, "Model");
    if (model) visit(model, 0);
  }
  return { types, magic, models };
}
