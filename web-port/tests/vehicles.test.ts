/**
 * Vehicle physics (src/loaders/vehicles.ts, docs/vehicles.md).
 * Synthetic tests run everywhere; level-1 tests read the staged game files
 * and are skipped when web-port/game-data is absent.  Reference values come
 * from tools/igi_vehicles.py (`--golden`), which the TS port matches.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { RAW_ROOT, readRaw } from "./helpers";
import { MissionRuntime, readMissionTasks, sampleCutSceneCamera, type MissionTasks, type Vec3 } from "../src/loaders/mission";
import { readIlffMembers } from "../src/loaders/ilff";
import { readMef } from "../src/loaders/mef";
import {
  CarSim,
  EMPTY_WORLD,
  HeliSim,
  RailSpline,
  RigidBody,
  approxLength,
  decodePhysicsObjType,
  driveFromAnimTask,
  eulerF,
  flatWorld,
  placeTrain,
  railParamsFromTask,
  readMagicObjects,
  readMefMagicVertices,
  readPhysicsObjTypes,
  trainCar,
  vehicleParamsFromTask,
  type CarConfig,
  type MagicObjectDef,
  type PhysicsObjType,
  type RotorConfig,
  type VehicleBaseConfig,
  type VehicleModelData,
  type VehicleTaskParams,
} from "../src/loaders/vehicles";

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// DefinePhysicsObjType arguments as decoded from physicsobj/helis/bell/heli.qvm and
// physicsobj/cars/cutscene_truck/car.qvm (tools/igi_vehicles.py prints them).
const SYM = (symbol: string) => ({ symbol });
const BELL = [SYM("TASKTYPE_HELI"), 0, 3000, 2.2, 7.8, 3, "<BELL>", "<BELLDESC>", "709_01_1", 0, 68, 0.001, 200, 50, 0.4, 50, 0.4, 50, 0.4, 3000, 0.027,
  0.003, 3, 20, 0, 0, 0, 1, 0, 0, 3, 0, 0, 0, 0, 1, 0, 50, 0, 0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 1, 0];
const MAIN_ROTOR = [SYM("TASKTYPE_ROTOR"), 1, 200, 0.5, 0.4, 0.3, "<ROTOR>", "<ROTORDESC>", "711_01_1", 2, 0, 0, 6, 0.5, 1, 1, 1, 0, 6, 0.5, 1, 1, 0.7, 0.001,
  1, 0, 1, 0, 0.1, "711_01_1"];
const TAIL_ROTOR = [SYM("TASKTYPE_ROTOR"), 3, 100, 0.5, 0.4, 1, "<ROTOR>", "<ROTORDESC>", "712_01_1", 2, 0, 0, 6, 0.5, 1, 1, 1, 0, 6, 0.5, 1, 1, 0.7, 0.001,
  0, 1, 10, 0, 0.12, "712_02_1"];
const TRUCK = [SYM("TASKTYPE_CAR"), 0, 3000, 2.2, 7.8, 3, "<TRUCK>", "<TRUCKDESC>", "622_01_1", 4, 0, 0, 5, 0, 0.95, 0.05, 1, 0, 5, 0, 0.95, 0.05, 2, 0, 5, 0,
  0.95, 0.05, 3, 0, 5, 0, 0.95, 0.05, 30, 0.001, 90, 0, 0, 0, 0, 45, 0.95, 5000, 0.95, 0.95, 0, 0, 0, 0, 6, 1, 1, 45, 1, 0.3, 0.5, 0, 0, 0, 0, 0.3, 0.5,
  0, 0, 0, -10, 0.3, 0.5, 1, 1, 45, 2, 0.3, 0.5, 0, 0, 0, -13, 0.3, 0.5, 0, 0, 0, 3, 0.3, 0.5, 0.2, 1, 0, "truck_sounds", 2, 6, 7, ""];
const WHEEL = [SYM("TASKTYPE_WHEEL"), 1, 3, 0.3, 0.9, 0.9, "<TANKWHEEL>", "<TANKWHEELDESC>", "600_02_1", 0, 0.7, 0.001, "600_02_1", 0.5, 0.2];

/** The .qvm stores numbers as float32: feed the literals as the file holds them. */
const asFile = (args: unknown[]) => args.map((v) => (typeof v === "number" ? Math.fround(v) : v));
const TYPES: PhysicsObjType[] = [BELL, MAIN_ROTOR, TAIL_ROTOR, TRUCK, WHEEL].map((a) => decodePhysicsObjType(asFile(a) as typeof a));
const MAGIC = new Map<string, MagicObjectDef>([
  ["711_01_1", { model: "711_01_1", taskType: "TASKTYPE_ROTOR", params: [] }],
  ["712_01_1", { model: "712_01_1", taskType: "TASKTYPE_ROTOR", params: [] }],
  ["709_02_1", { model: "709_02_1", taskType: "TASKTYPE_HELIWHEEL", params: [Math.fround(0.15), Math.fround(0.3)] }],
  ["709_03_1", { model: "709_03_1", taskType: "TASKTYPE_HELIWHEEL", params: [Math.fround(0.15), Math.fround(0.3)] }],
  ["600_02_1", { model: "600_02_1", taskType: "TASKTYPE_WHEEL", params: [] }],
]);
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const att = (name: string, position: Vec3) => ({ name, position, matrix: I3, bone: 0 });
/** 709_01_1 attachments (rotors, skids) and 622_01_1 magic vertices / wheels, rounded from the models. */
const BELL_MODEL: VehicleModelData = {
  magicVertices: [],
  attachments: [att("711_01_1", [0, -0.1, 8894.8]), att("712_01_1", [-503.4, -34107.8, 7310.2]), att("709_02_1", [-5464.8, 5223.7, -4768.2]),
    att("709_03_1", [-5464.8, -3420, -5116.4]), att("709_03_1", [5398.8, -3420, -5116.4]), att("709_02_1", [5398.9, 5223.7, -4768.2])],
};
const TRUCK_MODEL: VehicleModelData = {
  magicVertices: [[-3253.8, -9381.5, 31.27], [-3253.8, 11523.6, 31.27], [3492.1, 11523.6, 31.27], [3492.1, -9381.5, 31.27]],
  attachments: [[-4053, 11589], [-4060, -4964], [-4060, -9403], [2856, 11589], [2856, -4998], [2856, -9403]].map(([x, y]) => att("600_02_1", [x, y, 1838.8])),
};
const task = (model: string, position: Vec3, extra: Partial<VehicleTaskParams> = {}): VehicleTaskParams => ({
  id: 1, position, orientation: [0, 0, 0], originalThrust: 1, speed: [0, 0, 0], model, collision: true, forceZ: false, ...extra,
});

describe("vehicle physics (synthetic)", () => {
  it("decodes DefinePhysicsObjType configs (FUN_004e48a0, FUN_004f9e10, FUN_0042cda0, FUN_0042ccc0)", () => {
    const [bell, main, tail, truck, wheel] = TYPES;
    expect(bell.restSpeed).toBe(68);
    const bc = bell.config as VehicleBaseConfig;
    expect(bc.c).toEqual([200, 50, 0.4, 50, 0.4, 50, 0.4, 3000, 0.027, 0.003].map(Math.fround));
    expect(bc.drag.map((e) => [e.coef, ...e.normal])).toEqual([[20, 1, 0, 0], [3, 0, 1, 0], [50, 0, 0, 1]]);
    expect((main.config as RotorConfig).main).toBe(true);
    expect((tail.config as RotorConfig).tail).toBe(true);
    const tc = truck.config as CarConfig;
    expect(truck.points.map((p) => [p.vertex, p.gripLateral, p.gripRolling])).toEqual([0, 1, 2, 3].map((v) => [v, Math.fround(0.95), Math.fround(0.05)]));
    expect(tc.wheels.map((w) => [w.steerable, w.driven, w.contact])).toEqual([[true, true, 1], [false, false, 0], [false, false, -10], [true, true, 2], [false, false, -13], [false, false, 3]]);
    expect(tc.wheels[0].travel).toBe(Math.fround(Math.fround(0.3) * 4096));
    expect(tc.suspensionOffset).toBe(Math.fround(Math.fround(0.2) * 4096));
    expect(tc.wheelsFromModel).toBe(true);
    expect(tc.wreckModel).toBe("");
    expect(wheel.config).toEqual({ model: "600_02_1", radius: 2048, bounce: Math.fround(Math.fround(0.2) * 4096) });
  });

  it("approximate length (FUN_004a8cf0) and the box inertia (FUN_004e3a50, x 1.01)", () => {
    close(approxLength([3, -4, 0]), 4 + 3 * Math.fround(0.414213568), 1e-9);
    const b = new RigidBody();
    b.setup(3000, [2.2, 7.8, 3]);
    const iz = (3000 * ((2.2 * 4096) ** 2 + (7.8 * 4096) ** 2)) / 12;
    close(1.01 / b.invInertia[2] / iz, 1, 1e-5);
  });

  it("integrates force (world = M F / m) and torque (body-frame momentum, quaternion turn)", () => {
    const b = new RigidBody();
    b.setup(1000, [1, 1, 1]);
    const m = eulerF(0, 0, Math.PI / 2); // local x -> world y
    b.add([1000, 0, 0], [0, 0, 0]);
    const m1 = b.integrate(m);
    close(b.velocity[0], 0, 1e-6);
    close(b.velocity[1], 1, 1e-6);
    expect(m1).toEqual(m); // no torque, orientation unchanged
    b.add([0, 1, 0], [4096, 0, 0]); // torque about local z
    const m2 = b.integrate(m1);
    expect(b.angularMomentum[2]).toBe(4096);
    const turn = Math.atan2(m2[3], m2[0]) - Math.atan2(m1[3], m1[0]);
    expect(turn).toBeGreaterThan(0);
    for (let c = 0; c < 3; c++) close(Math.hypot(m2[c], m2[3 + c], m2[6 + c]), 1, 1e-6);
  });

  it("heli: thrust 1 hovers exactly, 1.5 climbs (main rotor lift m g thrust)", () => {
    const hover = new HeliSim(task("709_01_1", [0, 0, 1e8]), TYPES, BELL_MODEL, MAGIC);
    expect(hover.rotors.map((r) => r.model)).toEqual(["711_01_1", "712_01_1"]);
    expect(hover.skids.map((s) => [s.depth, s.hard])[0]).toEqual([Math.fround(Math.fround(0.3) * 4096), Math.fround(Math.fround(0.15) * 4096)]);
    const ch = new Float32Array(34);
    hover.animInput(0, ch, EMPTY_WORLD);
    expect([ch[3], ch[4]]).toEqual([-1, -2]);
    for (let k = 1; k <= 60; k++) hover.animInput(k, ch, EMPTY_WORLD);
    expect(hover.position[2]).toBe(1e8);
    const climb = new HeliSim(task("709_01_1", [0, 0, 1e8], { originalThrust: 1.5 }), TYPES, BELL_MODEL, MAGIC);
    const ch2 = new Float32Array(34);
    climb.animInput(0, ch2, EMPTY_WORLD);
    for (let k = 1; k <= 30; k++) climb.animInput(k, ch2, EMPTY_WORLD);
    const rise = climb.position[2] - 1e8;
    expect(rise).toBeGreaterThan(8000); // 0.5 g net, minus drag: about 2.4 m in 1 s
    expect(rise).toBeLessThan(11000);
  });

  it("heli skids: with thrust 0 it comes to rest on its skids (FUN_004317d0)", () => {
    const h = new HeliSim(task("709_01_1", [0, 0, 5000], { originalThrust: 0 }), TYPES, BELL_MODEL, MAGIC);
    const ch = new Float32Array(34);
    h.animInput(0, ch, flatWorld(0));
    for (let k = 1; k <= 120; k++) h.animInput(k, ch, flatWorld(0));
    // skids at local z -4768 (front) / -5116 (rear): it comes to rest on the rear skids'
    // stiff zone, 0.15 m (`hard`) above the ground, the front ones in the spring zone
    expect(h.contacts).toBe(4);
    close(h.position[2] - 5116.4, h.skids[1].hard, 30);
    expect(h.body.speed).toBeLessThan(40.96); // below the move threshold: the position stays put
  });

  it("truck settles on its springs (equilibrium compression = travel / 2) and drives forward", () => {
    const floor = 1e6;
    const car = new CarSim(task("622_01_1", [0, 0, floor + 500], { originalThrust: 0 }), TYPES, TRUCK_MODEL, MAGIC);
    const ch = new Float32Array(34);
    ch[3] = -1;
    car.animInput(0, ch, flatWorld(floor));
    for (let k = 1; k <= 300; k++) car.animInput(k, ch, flatWorld(floor));
    // contact point local z = 31.27 - 819.2; spring force m g at compression 614.4 => origin = floor + 173.5
    close(car.position[2], floor + (819.2 - 31.27) - 614.4, 25);
    close(car.position[0], 0, 100); // the contact points are not symmetric in x
    ch[1] = 0.25; // thrust
    for (let k = 301; k <= 400; k++) car.animInput(k, ch, flatWorld(floor));
    expect(car.position[1]).toBeGreaterThan(4096 * 5); // models face +y
    expect(Math.abs(car.position[0])).toBeLessThan(4096 * 0.2);
    expect(car.wheelPoses().length).toBe(6);
  });

  it("rail: chord-length couplings on a straight spline, cars face the direction of travel", () => {
    const wps = [0, 1, 2].map((i) => ({ position: [i * 409600, 0, 0] as Vec3, orientation: [0, 0, 0] as Vec3, segmentModel: "", pieces: 10 }));
    const rail = new RailSpline({ linear: false, gamma: Math.PI, waypoints: wps });
    close(rail.total, 819200, 0.5);
    const cars = [0, 1, 2].map((i) => trainCar(i, "x", [[-34652.4, 0, 0], [34457.5, 0, 0]]));
    const poses = placeTrain(rail, cars, 300000, true)!;
    for (const p of poses) close(dist(p.front, p.back), cars[0].length, 0.05);
    close(poses[0].front[0], 300000, 0.05);
    expect(poses[0].matrix[0]).toBe(-1); // flipped: distance decreases => travel toward -x
  });
});

// ---------------------------------------------------------------------------

const OBJECTS = "missions/location0/level1/objects.qvm";
const hasData = existsSync(`${RAW_ROOT}/${OBJECTS}`) && existsSync(`${RAW_ROOT}/physicsobj`);

/** tools/igi_vehicles.py --golden (positions in units). */
const GOLDEN_HELI: Record<number, Vec3> = {
  29: [22681159.833, -60962730.1149, 174938815.8742], 179: [22781455.3484, -60311839.2169, 174752433.7413], 359: [22827198.641, -59251716.6979, 174533910.7119], 539: [22757788.0745, -58138392.7091, 174652584.7371], 559: [22775430.6279, -57996110.9806, 174641789.216],
};
const GOLDEN_TRUCK: Record<number, Vec3> = {
  89: [24956722.3723, -56091754.5645, 174414116.0563], 269: [24933971.4099, -56146840.3219, 174414089.3543], 449: [24983150.8817, -56207921.9045, 174414100.789], 749: [25002589.8095, -56377528.0014, 174414096.7626],
};

describe.skipIf(!hasData)("level 1 vehicles", () => {
  let cache: { tasks: MissionTasks; types: PhysicsObjType[]; skipped: string[]; magic: Map<string, MagicObjectDef>; models: Map<string, ArrayBuffer> } | null = null;
  const load = async () => {
    if (cache) return cache;
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    const types: PhysicsObjType[] = [];
    const skipped: string[] = [];
    for (const file of walk(join(RAW_ROOT, "physicsobj")).filter((f) => f.endsWith(".qvm")).sort()) {
      const rel = file.slice(RAW_ROOT.length + 1);
      try {
        types.push(...readPhysicsObjTypes(await readRaw(rel), rel));
      } catch {
        skipped.push(rel);
      }
    }
    const models = new Map<string, ArrayBuffer>();
    for (const arch of ["missions/location0/level1/models/level1.res", "missions/location0/common/models/location0.res"]) {
      for (const m of readIlffMembers(await readRaw(arch))) {
        const name = m.name.replace(/^.*\//, "").replace(/\.[^.]*$/, "").toLowerCase();
        if (!models.has(name)) models.set(name, m.payload as ArrayBuffer);
      }
    }
    cache = { tasks: readMissionTasks(await readRaw(OBJECTS)), types, skipped, magic: readMagicObjects(await readRaw("magicobj/magicobj.qvm")), models };
    return cache;
  };
  const modelData = (c: NonNullable<typeof cache>, name: string): VehicleModelData => {
    const b = c.models.get(name.toLowerCase())!;
    return { magicVertices: readMefMagicVertices(b), attachments: readMef(b).attachments };
  };
  const node = (c: NonNullable<typeof cache>, id: number) => c.tasks.nodes[c.tasks.byId.get(id)!].task;
  const trainCars = (c: NonNullable<typeof cache>, id: number) => {
    const t = node(c, id);
    return [t, ...t.children.filter((k) => k.type === "Train")].map((k) => {
      const model = String(k.params["Model"]);
      return trainCar(k.id, model, modelData(c, model).magicVertices, [Number(k.params["Displacement X"]), Number(k.params["Displacement Y"])]);
    });
  };

  it("physicsobj: 37 types from 17 scripts (the plane scripts' constant expressions fold, qvm.ts)", async () => {
    const c = await load();
    expect(c.types.length).toBe(37);
    expect(c.skipped).toEqual([]);
    const su27 = c.types.find((t) => t.model === "702_02_1")!;
    expect(su27.taskType).toBe("TASKTYPE_PLANE");
    // 15000 * 1.5 and 0.027 * 2 / 0.003 * 2 (float32 products, spec vehicles §1.4)
    expect((su27.config as VehicleBaseConfig).c).toEqual([700, 1.7, 0.9, 0.9, 0.9, 40, 0.9, 22500, 0.054, 0.006].map(Math.fround));
    const truck = c.types.find((t) => t.model === "622_01_1")!;
    expect(truck.source).toContain("cutscene_truck");
    expect((truck.config as CarConfig).wheels.length).toBe(6);
  });

  it("rail spline 1500: length, couplings and the trains' AnimTask (editor) positions", async () => {
    const c = await load();
    const rail = new RailSpline(railParamsFromTask(node(c, 1500)));
    expect(rail.total).toBe(4461265); // float32 sums of the piece chords, chopped (chop-mode FPU)
    expect(rail.segments.slice(1).reduce((n, s) => n + s!.pieces, 0)).toBe(130);
    const anim = new Map(c.tasks.animTasks.map((a) => [a.targetId, a.nodeIndex]));
    for (const id of [1499, 1501, 1999, 2099]) {
      const train = c.tasks.trains.find((t) => t.id === id)!;
      const cars = trainCars(c, id);
      const poses = placeTrain(rail, cars, train.distance, train.flipDirection)!;
      poses.forEach((p, j) => close(dist(p.front, p.back), cars[j].length, 4));
      const editor = c.tasks.nodes[anim.get(id)!].task.params["Position"] as number[];
      expect(Math.hypot(poses[0].position[0] - editor[0], poses[0].position[1] - editor[1])).toBeLessThan(4);
    }
  });

  it("matches tools/igi_vehicles.py: heli 1502 and truck 1099 driven by their AnimTasks", async () => {
    const c = await load();
    const anim = new Map(c.tasks.animTasks.map((a) => [a.targetId, a]));
    const heli = new HeliSim(vehicleParamsFromTask(node(c, 1502)), c.types, modelData(c, "709_01_1"), c.magic);
    const hr = driveFromAnimTask(heli, anim.get(1502)!.records, 560, EMPTY_WORLD);
    for (const [k, g] of Object.entries(GOLDEN_HELI)) hr[+k].position.forEach((v, i) => close(v, g[i], 1));
    const car = new CarSim(vehicleParamsFromTask(node(c, 1099)), c.types, modelData(c, "622_01_1"), c.magic);
    const cr = driveFromAnimTask(car, anim.get(1099)!.records, 750, flatWorld(174413931));
    for (const [k, g] of Object.entries(GOLDEN_TRUCK)) cr[+k].position.forEach((v, i) => close(v, g[i], 1));
  });

  it("intro through MissionRuntime: the heli passes the flyby camera, train 1999 the drive-by camera", async () => {
    const c = await load();
    const heliNode = node(c, 1502);
    const vehicles = new Map<number, HeliSim>();
    for (const id of [1502, 1508]) {
      const t = node(c, id);
      vehicles.set(id, new HeliSim(vehicleParamsFromTask(t), c.types, modelData(c, String(t.params["Model"])), c.magic));
    }
    const rail = new RailSpline(railParamsFromTask(node(c, 1500)));
    const train = c.tasks.trains.find((t) => t.id === 1999)!;
    const cars = trainCars(c, 1999);
    const cuts = new Map(c.tasks.cutScenes.map((k) => [k.id, k]));
    let flyby = Infinity;
    let driveBy = Infinity;
    let rt!: MissionRuntime;
    rt = new MissionRuntime(c.tasks, {
      onAnimInput: (a, n, ch) => vehicles.get(a.targetId)?.animInput(n, ch, EMPTY_WORLD),
      onCutSceneCamera: (s) => {
        if (s.cutSceneId === 1200 && s.keyIndex === 6) flyby = Math.min(flyby, dist(vehicles.get(1502)!.position, s.position));
        if (s.cutSceneId === 1202 && s.keyIndex <= 2) {
          const loco = placeTrain(rail, cars, rt.trainStateAt(train.nodeIndex)!.distance, true)![0];
          driveBy = Math.min(driveBy, dist(loco.position, s.position));
        }
      },
    });
    expect(heliNode.type).toBe("Heli");
    while (rt.levelTick < 760) rt.tick();
    expect(sampleCutSceneCamera(cuts.get(1200)!, 500)!.target?.taskId).toBe(1502);
    expect(flyby / 4096).toBeLessThan(15); // tools/igi_vehicles.py: 10.6 m
    expect(driveBy / 4096).toBeLessThan(10); // 3.6 m
  });
});
