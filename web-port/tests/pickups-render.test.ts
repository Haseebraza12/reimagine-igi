/**
 * Ammo types (DefineAmmoType, render-params.ts readAmmoTypes / loadAmmoTypes),
 * the AmmoPickup model and radius (combat/pickups.ts) and the pickup renderer
 * (render/pickups.ts). Real-data checks use the staged game-data/ files.
 */
import { existsSync } from "node:fs";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import type { Vec3 } from "../src/contracts";
import type { GameContext } from "../src/engine/context";
import { EventBus } from "../src/engine/events";
import { PICKUP_MIN_RADIUS, createPickupSystem, type Pickup } from "../src/engine/combat/pickups";
import { interactionModels, loadModelInfo, type ModelInfo } from "../src/engine/player/interact";
import { createPickupRenderer, pickupMatrix, pickupVertexLight } from "../src/engine/render/pickups";
import { AMMO_DIRS, loadAmmoTypes, loadIgiLevel, readAmmoTypes, readQvmCallTree, type IgiLevel, type LevelModel, type QvmCall } from "../src/loaders";
import { igiEulerToMat3, igiRotationToEngine } from "../src/loaders/coords";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { memorySource, RAW_ROOT, readRaw } from "./helpers";

const haveAmmo = existsSync(`${RAW_ROOT}/ammo/919/ammo.qvm`);
const haveRaw =
  haveAmmo &&
  existsSync(`${RAW_ROOT}/missions/location0/level1/objects.qvm`) &&
  existsSync(`${RAW_ROOT}/missions/location0/common/models/location0.res`) &&
  existsSync(`${RAW_ROOT}/magicobj/magicobj.qvm`);

describe("DefineAmmoType (FUN_0047b1b0)", () => {
  const call: QvmCall = {
    fn: "DefineAmmoType",
    codeOffset: 0,
    args: [4, "AMMO_ID_919", "<919>", "<919DESC>", 919, 3.5, 250, 200, 0, 255, 255, 0, 1, "116_01_1", "Sound0"],
  };

  it("maps all 15 arguments to the 0x168-byte record fields", () => {
    expect(readAmmoTypes([call])).toEqual([
      {
        index: 4, id: "AMMO_ID_919", name: "<919>", description: "<919DESC>", calibre: 919, arg5: 3.5,
        tracerNear: [250, 200, 0], tracerFar: [255, 255, 0], tracer: true, model: "116_01_1", sound: "Sound0",
      },
    ]);
  });

  it("rejects a short call and ignores other functions", () => {
    expect(() => readAmmoTypes([{ ...call, args: call.args.slice(0, 14) }])).toThrow(/15/);
    expect(readAmmoTypes([{ fn: "DefineWeapon", codeOffset: 0, args: [] }])).toEqual([]);
  });

  it("loadAmmoTypes skips directories that are not staged", async () => {
    const warnings: string[] = [];
    expect((await loadAmmoTypes(memorySource({}), warnings)).size).toBe(0);
    expect(warnings).toEqual([]);
  });
});

describe.skipIf(!haveAmmo)("ammo/*/ammo.qvm (staged)", () => {
  it("defines 13 ammo types; the pickup model is arg 13 (\"\" for .50 cal)", async () => {
    const types = await loadAmmoTypes(createFsAssetSource(RAW_ROOT));
    expect(types.size).toBe(AMMO_DIRS.length);
    const models = Object.fromEntries([...types].map(([id, t]) => [id, t.model]));
    expect(models).toEqual({
      AMMO_ID_12: "114_01_1", AMMO_ID_127: "", AMMO_ID_357: "118_01_1", AMMO_ID_44: "120_01_1", AMMO_ID_556: "115_01_1",
      AMMO_ID_762: "119_01_1", AMMO_ID_919: "116_01_1", AMMO_ID_DRAGUNOV: "137_01_1", AMMO_ID_FLASHBANG: "137_01_1",
      AMMO_ID_GRENADE: "135_01_1", AMMO_ID_M203: "108_05_1", AMMO_ID_MEDIPACK: "104_01_1", AMMO_ID_PROXIMITYMINE: "136_01_1",
    });
    const t919 = readAmmoTypes(readQvmCallTree(await readRaw("ammo/919/ammo.qvm")))[0];
    expect(t919).toMatchObject({ index: 4, calibre: 919, name: "<919>", description: "<919DESC>", sound: "Sound0", tracer: true });
    expect(t919.arg5).toBeCloseTo(3.5, 6);
    // Every index is distinct (FUN_0047b420 finds the type by it).
    expect(new Set([...types.values()].map((t) => t.index)).size).toBe(types.size);
  });
});

// --- renderer on a synthetic level -------------------------------------------------

/** One triangle with a +y (IGI +z, up) normal, in engine metres. */
function triangle(name: string): LevelModel {
  return {
    name,
    modelType: 0,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, -1]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uv: new Float32Array(6),
    lightmapUv: null,
    indices: new Uint32Array([0, 1, 2]),
    groups: [{ start: 0, count: 3, texture: null }],
  };
}

const origin: Vec3 = [1000, 2000, 3000];
const light = { sunDirection: [0, 1, 0] as Vec3, front: [0.5, 0.5, 0.5] as Vec3, ambient: [0.2, 0.2, 0.2] as Vec3 };
const fakeLevel = {
  originIgi: origin,
  models: new Map([["box", triangle("box")]]),
  guns: new Map(),
  objectLight: light,
  tasks: [],
} as unknown as IgiLevel;

function pickup(over: Partial<Pickup> = {}): Pickup {
  return {
    kind: "ammo", id: "AMMO_ID_919", rounds: 16, position: [origin[0] + 4096, origin[1], origin[2] + 8192], rest: origin[2] + 8192,
    speed: 0, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], model: "box", radius: PICKUP_MIN_RADIUS, nodeIndex: 0, taken: false, ...over,
  };
}

describe("pickup renderer (RigidDynCubeObj draw FUN_00506540 -> DrawRigidMesh)", () => {
  it("places the model at the IGI position with the row-major rotation (engine = (x, z, -y) / 4096)", () => {
    const m = new THREE.Matrix4().fromArray(pickupMatrix(pickup(), origin));
    expect(new THREE.Vector3(0, 0, 0).applyMatrix4(m).toArray().map((v) => v + 0)).toEqual([1, 2, 0]);
    // gamma = 90 deg: model IGI +x -> IGI +y -> engine -z.
    const turned = pickup({ rotation: igiEulerToMat3(0, 0, Math.PI / 2) });
    const p = new THREE.Vector3(1, 0, 0).applyMatrix4(new THREE.Matrix4().fromArray(pickupMatrix(turned, origin)));
    expect(p.x).toBeCloseTo(1, 9);
    expect(p.y).toBeCloseTo(2, 9);
    expect(p.z).toBeCloseTo(-1, 9);
  });

  it("vertex light = clamp(ambient + front x max(0, n.l)) with the world normal", () => {
    const model = triangle("box");
    expect([...pickupVertexLight(model, igiRotationToEngine(igiEulerToMat3(0, 0, 0)), light).slice(0, 3)].map((v) => +v.toFixed(6))).toEqual([0.7, 0.7, 0.7]);
    // alpha = 90 deg turns the up normal sideways: ambient only.
    const side = pickupVertexLight(model, igiRotationToEngine(igiEulerToMat3(Math.PI / 2, 0, 0)), light);
    expect(side[0]).toBeCloseTo(0.2, 6);
  });

  it("adds a mesh per pickup, follows a falling one, hides out-of-world ones and removes taken ones", () => {
    const scene = new THREE.Scene();
    const r = createPickupRenderer({ level: fakeLevel } as Pick<GameContext, "level">, scene);
    const a = pickup();
    const b = pickup({ kind: "weapon", id: "WEAPON_ID_UZI", model: "box", position: [origin[0], origin[1], origin[2] + 40960], nodeIndex: -1 });
    const none = pickup({ model: "missing" });
    r.update([a, b, none]);
    expect(r.count).toBe(2);
    expect(r.group.parent).toBe(scene);
    const meshOf = (p: Pickup) => r.group.children.find((c) => c.name.startsWith(`pickup:${p.id}`)) as THREE.Mesh;
    expect(meshOf(b).matrix.elements[13]).toBeCloseTo(10, 9);
    // The drop falls (FUN_0046ba20 moves +0xf0): the mesh follows on the next update.
    b.position[2] -= 4096;
    r.update([a, b, none], (p) => p !== a);
    expect(meshOf(b).matrix.elements[13]).toBeCloseTo(9, 9);
    expect(meshOf(a).visible).toBe(false);
    // Taken: gone at once; dropped from the list: gone too.
    a.taken = true;
    r.update([a, b]);
    expect(r.count).toBe(1);
    r.update([]);
    expect(r.count).toBe(0);
    expect(r.group.children).toHaveLength(0);
    r.dispose();
    expect(scene.children).not.toContain(r.group);
  });
});

// --- level 1 ----------------------------------------------------------------------------

describe.skipIf(!haveRaw)("level-1 pickups (ammo types loaded with the level)", () => {
  const raw = createFsAssetSource(RAW_ROOT);
  let level: IgiLevel;
  let models: Map<string, ModelInfo>;
  beforeAll(async () => {
    level = await loadIgiLevel(raw);
    models = await loadModelInfo(raw, interactionModels(level));
  }, 120_000);

  const ctxFor = () =>
    ({
      level, events: new EventBus(), systems: { tasks: null, audio: null, weapon: null }, enemies: [], world: null,
      player: { alive: true }, rng: { float: () => 0.25 },
    }) as unknown as GameContext;

  it("IgiLevel.ammoTypes holds every DefineAmmoType; the pickup models and GunPickup guns are loaded", () => {
    expect(level.ammoTypes.get("AMMO_ID_919")?.model).toBe("116_01_1");
    for (const m of ["116_01_1", "115_01_1", "104_01_1"]) expect(level.models.has(m)).toBe(true);
    for (const id of ["WEAPON_ID_UZI", "WEAPON_ID_GRENADE", "WEAPON_ID_MEDIPACK", "WEAPON_ID_MINIMI"]) expect(level.guns.has(id)).toBe(true);
  });

  it("AmmoPickups take DefineAmmoType's model and touch radius max(model radius, 0.7 m)", () => {
    const pickups = createPickupSystem(ctxFor(), { modelRadius: (m) => models.get(m)?.radius ?? null });
    pickups.reset();
    const ammo = pickups.items.filter((p) => p.kind === "ammo");
    expect(ammo.map((p) => `${p.id}:${p.model}`).sort()).toEqual([
      "AMMO_ID_556:115_01_1", "AMMO_ID_919:116_01_1", "AMMO_ID_919:116_01_1", "AMMO_ID_919:116_01_1", "AMMO_ID_MEDIPACK:104_01_1",
    ]);
    for (const p of ammo) {
      const r = models.get(p.model!)!.radius;
      expect(r).toBeGreaterThan(0);
      expect(p.radius).toBe(Math.max(r, PICKUP_MIN_RADIUS));
    }
    pickups.dispose();
  });

  it("draws every placed pickup (gun body only, DNER kinds kept) at its position", () => {
    const pickups = createPickupSystem(ctxFor(), { modelRadius: (m) => models.get(m)?.radius ?? null });
    pickups.reset();
    const scene = new THREE.Scene();
    const r = createPickupRenderer({ level }, scene);
    r.update(pickups.items, (p) => pickups.inWorld(p));
    expect(r.count).toBe(11);
    const meshes = r.group.children as THREE.Mesh[];
    for (const p of pickups.items) {
      const mesh = meshes.find((m) => m.name === `pickup:${p.id}:${p.model}` && m.matrix.elements[12] === pickupMatrix(p, level.originIgi)[12])!;
      expect(mesh).toBeDefined();
      expect(mesh.visible).toBe(true);
    }
    // UZI: one mesh, the body 111_01_1 (no clip / moving part / flame children).
    expect(meshes.filter((m) => m.name.startsWith("pickup:WEAPON_ID_UZI:")).map((m) => m.name)).toEqual(["pickup:WEAPON_ID_UZI:111_01_1"]);
    // MEDIPACK 121_01_1 block 4 is a deferred (alpha-blended) block.
    const medi = meshes.find((m) => m.name === "pickup:WEAPON_ID_MEDIPACK:121_01_1")!;
    expect((medi.material as THREE.ShaderMaterial[]).some((m) => m.transparent)).toBe(true);
    r.dispose();
    pickups.dispose();
  });
});
