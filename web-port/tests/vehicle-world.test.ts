/**
 * The rail spline drawing and the vehicles in the engine (docs/vehicles.md
 * sections 6 and 8): loaders/spline-segment.ts (SplineObjSegment frames and
 * vertex deformation), the train / heli placement in loaders/level.ts, and
 * engine/world/vehicles.ts driven by the mission runtime, moving render
 * entries and collision bodies. Synthetic tests run everywhere; level-1 tests
 * read the staged files and are skipped when web-port/game-data is absent.
 */
import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { readIlffMembers } from "../src/loaders/ilff";
import { readMef } from "../src/loaders/mef";
import { loadIgiLevel, type IgiLevel } from "../src/loaders/level";
import { igiPointToEngine } from "../src/loaders/coords";
import { MissionRuntime, buildMissionTasks, type Vec3 } from "../src/loaders/mission";
import {
  railSplineFromTask,
  segmentDeformer,
  segmentModelRange,
  splineParamsFromTask,
  splineSegmentFrames,
  type SplineParams,
} from "../src/loaders/spline-segment";
import { x87StoreF32 } from "../src/loaders/x87";
import { EMPTY_WORLD, HeliSim, CarSim, driveFromAnimTask, eulerF, placeTrain, rotZ, vehicleParamsFromTask, type VehicleWorld } from "../src/loaders/vehicles";
import { buildWorld, type BuiltWorld } from "../src/engine/world/world-builder";
import { CollisionWorldBuilder, TERRAIN_HIT_MATERIAL, TRI_BULLET, TRI_SIGHT, TRI_SOLID, TRI_TERRAIN, type CollisionWorld } from "../src/engine/world/collision";
import { dynamicTaskKeys } from "../src/engine/level";
import { createVehicleSystem, vehicleRenderCopies, ROTOR_DRAW_ANGLE_SCALE } from "../src/engine/world/vehicles";
import { createMissionSystem, type MissionSystem } from "../src/engine/mission/mission-system";
import type { GameContext } from "../src/engine/context";
import { RAW_ROOT } from "./helpers";

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const fileBuffer = (path: string): ArrayBuffer => {
  const b = readFileSync(path);
  const out = new ArrayBuffer(b.byteLength);
  new Uint8Array(out).set(b);
  return out;
};

// ---------------------------------------------------------------------------

describe("SplineObjSegment deformation (synthetic)", () => {
  const params = (linear: boolean, flip = false): SplineParams => ({
    linear,
    gamma: Math.PI,
    matricesPerSegment: 20,
    waypoints: [0, 1, 2].map((i) => ({
      position: [i * 409600, i * i * 40960, 0] as Vec3, orientation: [0, 0, 0] as Vec3, segmentModel: i ? "m" : "", pieces: 10, align: false, flip,
    })),
  });

  it("maps model x onto the polyline and carries the cross-section on the piece frames (FUN_0052d340)", () => {
    const p = params(false);
    const frames = splineSegmentFrames(p);
    expect(frames.map((f) => [f.index, f.pieces, f.model])).toEqual([[1, 10, "m"], [2, 10, "m"]]);
    const seg = frames[1];
    expect(seg.matrices.length).toBe(11);
    expect(seg.matrices[0]).toEqual(eulerF(0, 0, 0)); // M_0 = start waypoint matrix
    const d = segmentDeformer(seg, [0, 1000]);
    for (let i = 0; i <= 10; i++) {
      // x on a piece boundary lands exactly on polyline point p_i
      const v = d.position(i * 100, 0, 0);
      expect(dist(v, seg.points[i])).toBeLessThan(0.05);
    }
    // halfway along piece 3: halfway between p_3 and p_4, lateral y along M's local y
    const mid = d.position(350, 0, 0);
    const half = [0, 1, 2].map((k) => (seg.points[3][k] + seg.points[4][k]) / 2);
    expect(dist(mid, half)).toBeLessThan(0.05);
    const lateral = d.position(300, 1000, 0);
    const m = seg.matrices[3];
    expect(dist(lateral, [seg.points[3][0] + m[1] * 1000, seg.points[3][1] + m[4] * 1000, seg.points[3][2] + m[7] * 1000])).toBeLessThan(0.05);
    expect(d.mirrored).toBe(false);
    // interior frames follow the curve's heading (the second segment bends towards +y)
    expect(Math.atan2(seg.matrices[5][3], seg.matrices[5][0])).toBeGreaterThan(0.05);
  });

  it("flip runs the model backwards; linear segments stretch along the chord with Rz(heading) lateral axes", () => {
    const flipped = segmentDeformer(splineSegmentFrames(params(false, true))[0], [0, 1000]);
    const seg = splineSegmentFrames(params(false, true))[0];
    expect(dist(flipped.position(1000, 0, 0), seg.points[0])).toBeLessThan(0.05);
    expect(dist(flipped.position(0, 0, 0), seg.points[10])).toBeLessThan(0.05);
    expect(flipped.mirrored).toBe(true);
    const lin = splineSegmentFrames(params(true));
    expect(lin.map((f) => f.pieces)).toEqual([1, 1]);
    const d = segmentDeformer(lin[1], [-500, 500]);
    const chord = lin[1].chord;
    const a = d.position(-500, 0, 0);
    const b = d.position(500, 0, 0);
    expect(dist([b[0] - a[0], b[1] - a[1], b[2] - a[2]], chord)).toBeLessThan(0.5); // float32 at 400k units
    const h = Math.atan2(chord[1], chord[0]);
    const r = rotZ(h);
    const side = d.position(0, 100, 0);
    expect(dist(side, [r[1] * 100, r[4] * 100, 0])).toBeLessThan(0.05);
    expect(d.normal(0, [1, 0, 0])).toEqual([1, 0, 0]); // linear: normals are not rotated
  });

  it("the model x range includes 0 and every LOD (+0xfc / +0x100)", () => {
    expect(segmentModelRange([new Float32Array([10, 0, 0, 20, 0, 0]), new Float32Array([25, 0, 0])])).toEqual([0, 25]);
  });
});

// ---------------------------------------------------------------------------

const haveLevel = existsSync(`${RAW_ROOT}/missions/location0/level1/objects.qvm`) && existsSync(`${RAW_ROOT}/physicsobj`);

/** tools/igi_vehicles.py --golden (tests/vehicles.test.ts): positions after driveFromAnimTask update u = after the AnimTask input with nTick u. */
const GOLDEN_HELI: Record<number, Vec3> = {
  29: [22681159.833, -60962730.1149, 174938815.8742], 179: [22781455.3484, -60311839.2169, 174752433.7413], 359: [22827198.641, -59251716.6979, 174533910.7119], 559: [22775430.6279, -57996110.9806, 174641789.216],
};
const GOLDEN_TRUCK: Record<number, Vec3> = {
  89: [24956722.3723, -56091754.5645, 174414116.0563], 269: [24933971.4099, -56146840.3219, 174414089.3543], 449: [24983150.8817, -56207921.9045, 174414100.789], 749: [25002589.8095, -56377528.0014, 174414096.7626],
};
const FLAT_Z = 174413931;

describe.skipIf(!haveLevel)("rail and vehicles in the engine (level 1)", () => {
  let level: IgiLevel;
  let world: BuiltWorld;
  const spline = () => level.tasks.find((t) => t.id === 1500)!;
  const keyOf = (id: number) => level.tasks.findIndex((t) => t.id === id);

  beforeAll(async () => {
    level = await loadIgiLevel(createFsAssetSource(RAW_ROOT));
    world = buildWorld(
      level,
      (b) => b.addIndexed(level.terrain.detail.positions, level.terrain.detail.indices, TRI_SOLID | TRI_BULLET | TRI_SIGHT | TRI_TERRAIN, TERRAIN_HIT_MATERIAL),
      { dynamicTasks: dynamicTaskKeys(level), renderCopies: vehicleRenderCopies(level) },
    );
  }, 120_000);

  it("segment k is drawn with the END waypoint's Segment Model; an empty model draws nothing", () => {
    const splines = level.tasks.filter((t) => t.type === "SplineObj");
    const drawn = level.instances.filter((i) => i.taskType === "SplineObj").map((i) => i.model);
    // Rail 1500: waypoints 1..11 own segments 1..11 (322_01_1, 323_01_1 x 3, 368_01_1 x 7).
    const rail = splines.indexOf(spline());
    expect(drawn.filter((m) => m.startsWith(`spline${rail}_`))).toEqual([
      `spline${rail}_1:322_01_1`, `spline${rail}_2:323_01_1`, `spline${rail}_3:323_01_1`, `spline${rail}_4:323_01_1`,
      ...[5, 6, 7, 8, 9, 10, 11].map((k) => `spline${rail}_${k}:368_01_1`),
    ]);
    // Cable spline 1 (waypoint 1 has no Segment Model): only its segment 2 is drawn.
    expect(drawn.filter((m) => m.startsWith("spline1_"))).toEqual(["spline1_2:320_02_1"]);
    expect(level.instances.filter((i) => i.taskType === "SplineObj").every((i) => i.taskIndex === level.tasks.indexOf(splines[+/^spline(\d+)/.exec(i.model)![1]]))).toBe(true);
  });

  it("frames: waypoint matrices at the ends, the Hermite tangent's pitch inside (ramp after waypoint 5)", () => {
    const params = splineParamsFromTask(spline());
    const rail = railSplineFromTask(spline());
    const frames = splineSegmentFrames(params, rail);
    expect(frames.reduce((n, f) => n + f.pieces, 0)).toBe(130);
    const ramp = frames.find((f) => f.index === 6)!;
    expect(ramp.matrices[0]).toEqual(rail.waypoints[5].matrix);
    expect(ramp.matrices[ramp.pieces]).toEqual(rail.waypoints[6].matrix);
    // waypoint 5 is pitched up by 15 deg (beta = -15 deg): its local x climbs; the frames level off towards waypoint 6
    expect(ramp.matrices[0][6]).toBeCloseTo(Math.sin((15 * Math.PI) / 180), 4);
    const climbs = ramp.matrices.slice(1, -1).map((m) => m[6]);
    expect(climbs[0]).toBeGreaterThan(0.1);
    expect(Math.abs(climbs[climbs.length - 1])).toBeLessThan(climbs[0]);
  });

  it("the rail's centreline lies on the trains' polyline at sample distances", () => {
    const params = splineParamsFromTask(spline());
    const rail = railSplineFromTask(spline());
    const frames = splineSegmentFrames(params, rail);
    let worst = 0;
    for (let d = 1000; d < rail.total; d += 150_000) {
      const [p] = rail.evaluate(d, [])!;
      // segment / piece / fraction of distance d with FUN_004f5830's own float accumulation
      const at = rail.locate(d)!;
      const seg = frames.find((f) => f.index === at.seg)!;
      const i = at.piece;
      const t = at.fraction;
      const def = segmentDeformer(seg, [-0.004059393890202045, 532480]);
      const x = -0.004059393890202045 + ((i + t) / seg.pieces) * (532480 + 0.004059393890202045);
      const v = def.position(x, 0, 0);
      worst = Math.max(worst, dist([seg.mid[0] + v[0], seg.mid[1] + v[1], seg.mid[2] + v[2]], p));
    }
    expect(worst).toBeLessThan(1); // units (1 / 4096 m)
  });

  it("the placed segment geometry and its collision faces are the recovered deformation", () => {
    const rail = railSplineFromTask(spline());
    const frames = splineSegmentFrames(splineParamsFromTask(spline()), rail);
    const seg = frames.find((f) => f.index === 6)!;
    const inst = level.instances.find((i) => i.model.endsWith("_6:368_01_1"))!;
    const model = level.models.get(inst.model)!;
    // FUN_0052d340 on the original vertices, x range over the render vertices of 368_01_1.._4
    const raw = new Map<string, ArrayBuffer>();
    for (const m of readIlffMembers(fileBuffer(`${RAW_ROOT}/missions/location0/level1/models/level1.res`))) {
      raw.set(m.name.replace(/^.*\//, "").replace(/\.[^.]*$/, ""), m.payload as ArrayBuffer);
    }
    for (const m of readIlffMembers(fileBuffer(`${RAW_ROOT}/missions/location0/common/models/location0.res`))) {
      const n = m.name.replace(/^.*\//, "").replace(/\.[^.]*$/, "");
      if (!raw.has(n)) raw.set(n, m.payload as ArrayBuffer);
    }
    const lods = [1, 2, 3, 4].map((k) => raw.get(`368_01_${k}`)).filter((b): b is ArrayBuffer => !!b).map((b) => readMef(b).positions);
    expect(lods.length).toBe(4);
    const range = segmentModelRange(lods);
    expect(range[0]).toBeLessThanOrEqual(0);
    const def = segmentDeformer(seg, range);
    const src = lods[0];
    let worst = 0;
    for (let v = 0; v < src.length; v += 3) {
      const d = def.position(src[v], src[v + 1], src[v + 2]);
      const e = igiPointToEngine([seg.mid[0] + d[0], seg.mid[1] + d[1], seg.mid[2] + d[2]], level.originIgi);
      worst = Math.max(worst, dist(e, [model.positions[v], model.positions[v + 1], model.positions[v + 2]]));
    }
    expect(worst).toBeLessThan(1e-4); // metres (float32 storage)
    const sets = model.collision!;
    expect(sets[0].indices.length).toBeGreaterThan(0);
    expect(sets[1].indices.length).toBeGreaterThan(0);
    // a bullet ray straight down onto the embankment's centreline hits its deformed set 0
    const at = rail.segments.slice(1, 6).reduce((n, s) => n + s!.length, 0) + rail.segments[6]!.length / 2;
    const [c] = rail.evaluate(at, [])!;
    const o = igiPointToEngine([c[0], c[1], c[2] + 4 * 4096], level.originIgi);
    const hit = world.collision.raycast(o[0], o[1], o[2], 0, -1, 0, 8, TRI_BULLET);
    expect(hit).not.toBeNull();
    expect(level.instances[hit!.owner]?.model).toBe(inst.model);
  });

  it("trains are placed at their compile pose: placeTrain at Position, wagons = child Train tasks", () => {
    const rail = railSplineFromTask(spline());
    const tasks = buildMissionTasks(level.taskRoots);
    const vehicles = createVehicleSystem(level, tasks, { collision: () => null, runtime: () => null });
    expect(vehicles.trains.map((t) => [t.train.id, t.keys.length])).toEqual([[1499, 3], [1501, 5], [1507, 5], [1999, 5], [2099, 5]]);
    for (const t of vehicles.trains) {
      const poses = placeTrain(rail, t.cars, t.train.distance, t.train.flipDirection)!;
      t.keys.forEach((key, j) => {
        const root = level.instances.find((i) => i.taskIndex === key && i.attachmentPath === "")!;
        expect(root.taskType).toBe("Train");
        expect(root.model).toBe(t.cars[j].model);
        const e = igiPointToEngine(poses[j].position, level.originIgi);
        expect(Math.hypot(root.matrix[12] - e[0], root.matrix[13] - e[1], root.matrix[14] - e[2])).toBeLessThan(1e-6);
      });
    }
    // the locomotive's glass windows ride along with it (same task key)
    const loco = level.instances.filter((i) => i.taskIndex === keyOf(1999));
    expect(loco.map((i) => i.model)).toEqual(["605_01_1", "605_02_1", "605_03_1", "605_04_1", "605_05_1", "605_06_1", "605_07_1"]);
  });

  it("heli 1502 and truck 1099 through the engine path match the vehicles.ts reference", () => {
    // Flat ground at FLAT_Z (the reference's flatWorld) as collision triangles, queried like the engine does.
    const b = new CollisionWorldBuilder();
    const y = (FLAT_Z - level.originIgi[2]) / 4096;
    b.addIndexed([-5000, y, -5000, -5000, y, 5000, 5000, y, 5000, 5000, y, -5000], [0, 1, 2, 0, 2, 3], TRI_BULLET);
    const flat: CollisionWorld = b.build(64);
    const tasks = buildMissionTasks(level.taskRoots);
    let runtime: MissionRuntime | null = null;
    const vehicles = createVehicleSystem(level, tasks, { collision: () => flat, runtime: () => runtime });
    const heli = vehicles.helis.find((h) => h.id === 1502)!.sim;
    const truck = vehicles.cars.find((c) => c.id === 1099)!.sim;
    const heliAt = new Map<number, Vec3>();
    const truckAt = new Map<number, Vec3>();
    let inTruckArea = false;
    runtime = new MissionRuntime(tasks, {
      humans: () => (inTruckArea ? [{ position: [24956964, -56099004, 174417760] as Vec3, team: 0 }] : []),
      onAnimInput: (anim, nTick, ch) => {
        vehicles.animInput(anim, nTick, ch);
        // the first playback only (a later restart sends nTick 0, 1, ... again)
        const record = (at: Map<number, Vec3>, pose: Vec3) => {
          if (at.get(-1)) return;
          if (nTick === 0 && at.has(1)) at.set(-1, [0, 0, 0]);
          else at.set(nTick, [...pose]);
        };
        if (anim.targetId === 1502) record(heliAt, heli.position);
        if (anim.targetId === 1099) record(truckAt, truck.position);
      },
    });
    while (runtime.levelTick < 3800 && !runtime.missionComplete) {
      inTruckArea = runtime.levelTick + 1 >= 3001;
      runtime.tick();
    }
    for (const [u, g] of Object.entries(GOLDEN_HELI)) expect(dist(heliAt.get(+u)!, g)).toBeLessThan(1);
    for (const [u, g] of Object.entries(GOLDEN_TRUCK)) expect(dist(truckAt.get(+u)!, g)).toBeLessThan(2);
    // and bit for bit against the standalone reference driver on the same world
    const anim = tasks.animTasks.find((a) => a.targetId === 1502)!;
    const ref = new HeliSim(vehicleParamsFromTask(tasks.nodes[tasks.byId.get(1502)!].task), level.vehicles!.types, level.vehicles!.models.get("709_01_1")!, level.vehicles!.magic);
    const refPoses = driveFromAnimTask(ref, anim.records, 300, EMPTY_WORLD);
    for (const u of [0, 1, 50, 150, 299]) expect(heliAt.get(u)).toEqual(refPoses[u].position);
    const carAnim = tasks.animTasks.find((a) => a.targetId === 1099)!;
    const refCar = new CarSim(vehicleParamsFromTask(tasks.nodes[tasks.byId.get(1099)!].task), level.vehicles!.types, level.vehicles!.models.get("622_01_1")!, level.vehicles!.magic);
    const query: VehicleWorld = {
      castDown: (x, yy, top, bottom) => {
        const o = igiPointToEngine([x, yy, top], level.originIgi);
        const hit = flat.raycast(o[0], o[1], o[2], 0, -1, 0, (top - bottom) / 4096, TRI_BULLET);
        return hit ? { distance: hit.distance * 4096, normal: [hit.normal[0], -hit.normal[2], hit.normal[1]] } : null;
      },
    };
    const refCarPoses = driveFromAnimTask(refCar, carAnim.records, 750, query);
    for (const u of [0, 1, 89, 269, 449, 749]) expect(truckAt.get(u)).toEqual(refCarPoses[u].position);
    // wheel 0 (ATTA 2 of 622_01_1) drawn at W_car Rz(steer) Rx(spin) L_atta, at the compressed ATTA offset (FUN_0042f8c0)
    const car = vehicles.cars.find((c) => c.id === 1099)!;
    const wheel = level.instances.findIndex((i) => i.taskIndex === car.key && i.attachmentPath === "2");
    expect(level.instances[wheel].model).toBe("600_02_1");
    const [m] = vehicles.instanceMatrices(wheel);
    const w = truck.wheelPoses()[0];
    const R = truck.matrix;
    const off = [0, 1, 2].map((r) => R[r * 3] * w.offset[0] + R[r * 3 + 1] * w.offset[1] + R[r * 3 + 2] * w.offset[2]);
    const e = igiPointToEngine([truck.position[0] + off[0], truck.position[1] + off[1], truck.position[2] + off[2]], level.originIgi);
    expect(dist([m[12], m[13], m[14]], e)).toBeLessThan(1e-6);
    // ATTA rotation Rz(pi): the wheel's x axis is R (-cos steer, -sin steer, 0); engine axes (x, z, -y)
    const ax = [0, 1, 2].map((r) => -R[r * 3] * Math.cos(w.steer) - R[r * 3 + 1] * Math.sin(w.steer));
    expect(dist([m[0], m[1], m[2]], [ax[0], ax[2], -ax[1]])).toBeLessThan(1e-5);
  }, 60_000);

  describe("mission system", () => {
    let mission: MissionSystem;
    const ctx = {
      world: null as CollisionWorld | null,
      level: null as IgiLevel | null,
      events: { emit() {} },
      input: { isDown: () => false },
      player: { position: [0, 0, 0], crouching: false, eyeHeight: 1.7, alive: true },
      enemies: [],
      systems: { enemies: null },
    };
    beforeAll(() => {
      ctx.world = world.collision;
      ctx.level = level;
      mission = createMissionSystem(ctx as unknown as GameContext);
      mission.start(level);
      mission.attachWorld(world);
    });

    it("train cars: taskPose and the world follow placeTrain at the runtime's distance (looping on the rail)", () => {
      const rail = railSplineFromTask(spline());
      const vehicles = mission.vehicles!;
      const t1999 = vehicles.trains.find((t) => t.train.id === 1999)!;
      const runtime = mission.runtime!;
      // before any tick: the compile placement (what the cut-scene link captures)
      const start = placeTrain(rail, t1999.cars, t1999.train.distance, true)!;
      expect(dist(mission.vehicles!.pose(2333)!.position, start[3].position)).toBe(0);
      const startBody = igiPointToEngine([start[0].position[0], start[0].position[1], start[0].position[2] + 40000], level.originIgi);
      while (runtime.levelTick < 1100) mission.tick();
      const d = runtime.trainStateAt(t1999.train.nodeIndex)!.distance;
      expect(d).not.toBe(t1999.train.distance);
      const now = placeTrain(rail, t1999.cars, d, true)!;
      for (const [j, id] of [[0, 1999], [1, 2334], [3, 2333]] as const) expect(vehicles.pose(id)!.position).toEqual(now[j].position);
      // the locomotive's collision body moved with it (ray down onto its roof hits body -1 - key)...
      const o = igiPointToEngine([now[0].position[0], now[0].position[1], now[0].position[2] + 40000], level.originIgi);
      const inWorld = mission.inWorld!(1999);
      const hit = world.collision.raycast(o[0], o[1], o[2], 0, -1, 0, 20, TRI_BULLET);
      if (inWorld) expect(hit?.triangle).toBe(-1 - t1999.keys[0]);
      // ...and is gone from its compile place (it moved > 100 m)
      expect(dist(now[0].position, start[0].position) / 4096).toBeGreaterThan(100);
      const old = world.collision.raycast(startBody[0], startBody[1], startBody[2], 0, -1, 0, 20, TRI_BULLET);
      expect(old?.triangle).not.toBe(-1 - t1999.keys[0]);
    }, 60_000);

    it("helicopter: rigid body parts and rotor blur fans (FUN_0042b940)", () => {
      const vehicles = mission.vehicles!;
      const heli = vehicles.helis.find((h) => h.id === 1502)!;
      const tail = level.instances.findIndex((i) => i.taskIndex === heli.key && i.model === "712_01_1");
      const blade = level.instances.findIndex((i) => i.taskIndex === heli.key && i.model === "711_02_1");
      const tailCopies = vehicles.instanceMatrices(tail);
      const bladeCopies = vehicles.instanceMatrices(blade);
      expect(tailCopies.length).toBe(10);
      expect(bladeCopies.length).toBe(17);
      // all copies share the rotor's position; consecutive copies differ by spin x thrust about the rotor's x axis
      const m0 = new THREE.Matrix4().fromArray(tailCopies[0]);
      const m1 = new THREE.Matrix4().fromArray(tailCopies[1]);
      expect(new THREE.Vector3().setFromMatrixPosition(m0).distanceTo(new THREE.Vector3().setFromMatrixPosition(m1))).toBeLessThan(1e-9);
      const axis0 = new THREE.Vector3().setFromMatrixColumn(m0, 0);
      const axis1 = new THREE.Vector3().setFromMatrixColumn(m1, 0);
      expect(axis0.distanceTo(axis1)).toBeLessThan(1e-6); // rotation about local x keeps the x axis
      const y0 = new THREE.Vector3().setFromMatrixColumn(m0, 1);
      const y1 = new THREE.Vector3().setFromMatrixColumn(m1, 1);
      // drawn angles a_0 = f32(21.362831 angle), a_1 = f32(a_0 + f32(0.12 thrust)) (float stores, as at 0x42c4c7)
      const angle = heli.sim.rotors.find((r) => r.model === "712_01_1")!.angle;
      const a0 = x87StoreF32(angle * ROTOR_DRAW_ANGLE_SCALE);
      const a1 = x87StoreF32(a0 + x87StoreF32(Math.fround(0.12) * heli.sim.thrust));
      expect(Math.acos(Math.min(1, y0.dot(y1)))).toBeCloseTo(a1 - a0, 5);
      expect(ROTOR_DRAW_ANGLE_SCALE).toBeCloseTo(21.362831, 5);
    });

    it("doors with task id -1 are separate dynamic bodies keyed by node index", () => {
      const runtime = mission.runtime!;
      const anonymous = runtime.tasks.doors.filter((d) => d.id < 0);
      expect(anonymous.length).toBeGreaterThan(10);
      for (const door of anonymous) {
        expect(world.dynamicTasks.has(door.nodeIndex)).toBe(true);
        expect(mission.doorOfBody(door.nodeIndex)).toBe(door.nodeIndex);
      }
      expect(world.collision.bodyIds.filter((id) => anonymous.some((d) => d.nodeIndex === id)).length).toBe(anonymous.length);
      expect(mission.doorOfBody(keyOf(1999))).toBeNull();
    });
  });
});
