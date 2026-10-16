/**
 * Vehicles of the full game (spec vehicles: Plane, CarAI, Car / Heli / Train
 * in missions 2-14): synthetic tests of the recovered rules (always run) and
 * tests on the staged full game (game-data, skipped when absent).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { levelPathsFor, loadIgiLevel, type IgiLevel } from "../src/loaders/level";
import { readQvmCallTree } from "../src/loaders/qvm";
import { MissionRuntime, buildMissionTasks, stepAnimRecords, type Mat3, type Vec3 } from "../src/loaders/mission";
import {
  CarSim,
  RailSpline,
  attaMatrix,
  autoOrientMatrix,
  flatWorld,
  placeTrain,
  readPhysicsObjTypes,
  trainCar,
  vehicleParamsFromTask,
  type DragElement,
  type VehicleBaseConfig,
} from "../src/loaders/vehicles";
import { PLANE_V0_K, PlaneSim, planeFlagsFromTask } from "../src/loaders/plane";
import { CAR_AI_ARRIVED_D2, CarAi, VehicleDetector, angleOf, headingFromY, patrolCommandsOf, vehicleInCone, type CarAiCar } from "../src/loaders/car-ai";
import type { AiGraph, AiGraphNode } from "../src/loaders/ai-graph";
import { PATROL_COMMAND } from "../src/loaders/ai-rules";
import { railSplineFromTask } from "../src/loaders/spline-segment";
import { createVehicleSystem } from "../src/engine/world/vehicles";
import { readMissionDefinition } from "../src/engine/ui/assets";
import { CollisionWorldBuilder, TRI_BULLET, type CollisionWorld } from "../src/engine/world/collision";

const FULL = fileURLToPath(new URL("../game-data", import.meta.url));
const haveFull = existsSync(`${FULL}/missions/location0/level14/mission.qvm`);
const bytes = (path: string): ArrayBuffer => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const f32 = Math.fround;
const I3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// ---------------------------------------------------------------------------
// Synthetic
// ---------------------------------------------------------------------------

describe("ATTA matrices and automatic orientation (synthetic)", () => {
  it("FUN_004c4950: a proper rotation is the transpose, a mirror becomes the rotation keeping columns 0 and 1", () => {
    const c = Math.cos(0.3);
    const s = Math.sin(0.3);
    const rz = [c, -s, 0, s, c, 0, 0, 0, 1];
    const m = attaMatrix(rz);
    const t = [rz[0], rz[3], rz[6], rz[1], rz[4], rz[7], rz[2], rz[5], rz[8]];
    m.forEach((v, i) => expect(v).toBeCloseTo(t[i], 6));
    // The SU-27's left gear 702_15_1 and left taileron 702_14_1: diag(-1, 1, 1) -> diag(-1, 1, -1) (Ry(pi)).
    expect(attaMatrix([-1, 0, 0, 0, 1, 0, 0, 0, 1]).map((v) => v + 0)).toEqual([-1, 0, 0, 0, 1, 0, 0, 0, -1]);
  });

  it("waypoint compile 0x500f28: column 0 = the unit tangent (P - P_prev) + (P_next - P), y horizontal, z up", () => {
    const m = autoOrientMatrix([100, 0, 0], [0, 0, 0], [200, 100, 50]);
    const t = [200, 100, 50];
    const n = Math.hypot(...t);
    expect(m[0]).toBeCloseTo(t[0] / n, 6);
    expect(m[3]).toBeCloseTo(t[1] / n, 6);
    expect(m[6]).toBeCloseTo(t[2] / n, 6);
    expect(m[7]).toBeCloseTo(0, 6); // column 1 horizontal
    expect(m[8]).toBeGreaterThan(0.9); // column 2 up
    // orthonormal and right handed
    const col = (k: number) => [m[k], m[3 + k], m[6 + k]];
    const [x, y, z] = [col(0), col(1), col(2)];
    expect(x[0] * y[0] + x[1] * y[1] + x[2] * y[2]).toBeCloseTo(0, 6);
    expect(x[1] * y[2] - x[2] * y[1]).toBeCloseTo(z[0], 6);
    // no neighbour difference -> (1, 0, 0); a vertical tangent -> h = (0, 1, 0)
    expect(autoOrientMatrix([5, 5, 5], [5, 5, 5], null).slice(0, 1)).toEqual([1]);
    const v = autoOrientMatrix([0, 0, 0], [0, 0, -10], null);
    expect([v[0], v[3], v[6]]).toEqual([0, 0, 1]);
  });

  it("SplineObj compile FUN_00502740: Position moves every waypoint by Rz(gamma) Position; Automatic Orientation replaces the matrices", () => {
    const wp = (x: number, y: number) => ({ position: [x, y, 0] as Vec3, orientation: [0, 0, 1] as Vec3, segmentModel: "", pieces: 4 });
    const base = { linear: false, gamma: Math.PI, waypoints: [wp(0, 0), wp(40960, 0), wp(81920, 40960)] };
    const plain = new RailSpline(base);
    const moved = new RailSpline({ ...base, position: [4096, 0, 0], gamma: f32(Math.PI) });
    expect(moved.waypoints[1].position[0] - plain.waypoints[1].position[0]).toBeCloseTo(-4096, 2); // Rz(pi) (4096, 0, 0)
    const auto = new RailSpline({ ...base, autoOrient: true });
    const m = auto.waypoints[1].matrix;
    const t = [81920, 40960, 0];
    expect(m[0]).toBeCloseTo(t[0] / Math.hypot(...t), 6);
    expect(m[3]).toBeCloseTo(t[1] / Math.hypot(...t), 6);
    // linear splines keep their Euler matrices
    const lin = new RailSpline({ ...base, linear: true, autoOrient: true });
    expect(lin.waypoints[1].matrix).toEqual(plain.waypoints[1].matrix);
  });
});

/** A straight graph 0 - 1 - 2 along +y (40 m apart), full route table. */
function lineGraph(): AiGraph {
  const nodes: AiGraphNode[] = [0, 1, 2].map((id) => ({ id, position: [0, id * 163840, 0], gamma: 0, radius: 1, material: 0, criteria: "", flags: 0, neighbours: [] }));
  const cap = 3;
  const routeNext = new Int32Array(cap * cap).fill(-1);
  const routeCost = new Float32Array(cap * cap).fill(-1);
  for (let from = 0; from < 3; from++) {
    for (let to = 0; to < 3; to++) {
      if (from === to) continue;
      routeNext[cap * to + from] = from + Math.sign(to - from);
      routeCost[cap * to + from] = Math.abs(to - from) * 163840;
    }
  }
  return { maxNodes: cap, nodes, nodeById: new Map(nodes.map((n) => [n.id, n])), links: [], routeNext, routeCost };
}

describe("CarAI (synthetic)", () => {
  const host = { dead: () => false, position: () => null };
  const car = (position: Vec3, matrix: Mat3 = I3, speed = 0, thrust = 0): CarAiCar => ({ position, matrix, speed, thrust, canFire: false, seen: () => null });

  it("FUN_00414950 / FUN_004b31f0: heading from +y is negative to the right; angle between vectors", () => {
    expect(headingFromY([0, 1, 0])).toBe(0);
    expect(headingFromY([1, 1, 0])).toBeCloseTo(-Math.PI / 4, 9);
    expect(headingFromY([-1, 1, 0])).toBeCloseTo(Math.PI / 4, 9);
    expect(headingFromY([0, 0, 0])).toBe(0);
    expect(angleOf([1, 0, 0], [-1, 0, 0])).toBeCloseTo(Math.PI, 9);
    expect(angleOf([0, 0, 0], [1, 0, 0])).toBe(0);
  });

  it("FUN_00425de0: SETSPEED, then WALKTO drives the next hop with full speed straight ahead; END parks and brakes", () => {
    const route = [
      { command: PATROL_COMMAND.SETSPEED, parameter: 20 },
      { command: PATROL_COMMAND.WALKTO, parameter: 2 },
      { command: PATROL_COMMAND.END, parameter: -1 },
    ];
    const ai = new CarAi(1, { graph: lineGraph(), position: [0, 0, 0] }, route);
    // tick 1: SETSPEED only (no recompute), the outputs stay 0; nTick 0 is sent again (second reset)
    let out = ai.update(car([0, -8192, 0]), host)!;
    expect(out.nTick).toBe(0);
    expect(ai.setSpeed).toBe(20);
    expect([...out.channels.slice(0, 4)]).toEqual([0, 0, 0, -1]);
    // tick 2: WALKTO 2 from near node 0: next hop = node 1 straight ahead, desired = S (heading 0)
    out = ai.update(car([0, -8192, 0]), host)!;
    expect(out.nTick).toBe(1);
    expect(ai.next?.id).toBe(1);
    expect(ai.desired).toBeCloseTo(20, 5);
    expect(ai.thrust).toBeCloseTo(0.2, 5); // (20 - 0) x 0.01 + 0
    expect(ai.steer + 0).toBe(0);
    expect(ai.brake).toBe(0);
    // a node to the right (x > 0) -> full right lock -1, scaled by (1 - thrust) 0.95 + 0.05
    ai.update(car([-81920, 163840 * 2 - 1, 0]), host); // nearest node 2 is the destination -> peeks END
    // arrived at node 2 -> advance to END -> parked: brake 1, steer 0, speed 0
    out = ai.update(car([0, 163840 * 2, 0]), host)!;
    out = ai.update(car([0, 163840 * 2, 0]), host)!;
    expect(ai.cursor?.command()?.command).toBe(PATROL_COMMAND.END);
    expect(out.channels[3]).toBe(1);
    expect(out.channels[0]).toBe(0);
    expect(ai.desired).toBe(0);
  });

  it("steering: +-1 beyond 10 deg, a x (-6 / pi) inside, x ((1 - thrust) 0.95 + 0.05) on patrol", () => {
    const route = [{ command: PATROL_COMMAND.SETSPEED, parameter: 10 }, { command: PATROL_COMMAND.WALKTO, parameter: 2 }];
    const ai = new CarAi(1, { graph: lineGraph(), position: [0, 0, 0] }, route);
    ai.update(car([0, 0, 0]), host);
    // the car faces +x (Rz(-90deg)): node 1 at +y is 90 deg to its left -> +1 (turn left)
    const faceX: Mat3 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
    ai.update(car([0, 0, 0], faceX), host);
    expect(ai.next?.id).toBe(1);
    expect(ai.steer).toBeCloseTo((1 - ai.thrust) * f32(0.95) + f32(0.05), 5);
    // 5 deg to the right: a = -5 deg -> steer = a x (-6/pi) x scale > 0? (target right => a < 0 => positive steer value turns right)
    const a = (-5 * Math.PI) / 180;
    const r: Mat3 = [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
    ai.update(car([0, 0, 0], r), host);
    const k = (1 - ai.thrust) * f32(0.95) + f32(0.05);
    expect(ai.steer).toBeCloseTo(f32(f32(-a) * f32(-1.909859299659729)) * k * -1 * -1, 3);
  });

  it("DELAY n holds n + 2 ticks with the brake request; the reached-node radius is 3 m", () => {
    expect(CAR_AI_ARRIVED_D2).toBe(12288 * 12288);
    const route = [{ command: PATROL_COMMAND.DELAY, parameter: 2 }, { command: PATROL_COMMAND.WALKTO, parameter: 1 }];
    const ai = new CarAi(1, { graph: lineGraph(), position: [0, 0, 0] }, route);
    let ticks = 0;
    while (ai.cursor === null || ai.cursor.command()?.command === PATROL_COMMAND.DELAY) {
      ai.update(car([0, 0, 0]), host);
      ticks++;
      expect(ticks).toBeLessThan(10);
    }
    expect(ticks).toBe(4);
  });

  it("attack (FUN_004262f0): a seen target -> 20 km/h toward the graph node nearest it, memory 600 ticks", () => {
    const route = [{ command: PATROL_COMMAND.SETSPEED, parameter: 30 }, { command: PATROL_COMMAND.WALKTO, parameter: 0 }];
    const ai = new CarAi(1, { graph: lineGraph(), position: [0, 0, 0] }, route);
    const target: Vec3 = [0, 163840 * 2, 0];
    const seeing = { ...car([0, 0, 0]), canFire: true, seen: () => ({ key: "player", position: target }) };
    ai.update(seeing, { dead: () => false, position: () => target });
    expect(ai.attacking).toBe(true);
    expect(ai.speed).toBe(20);
    expect(ai.next?.id).toBe(1);
    expect(ai.memory).toBe(600);
    // out of sight: the old target is kept while the memory lasts
    ai.update({ ...seeing, seen: () => null }, { dead: () => false, position: () => target });
    expect(ai.attacking).toBe(true);
    expect(ai.memory).toBe(599);
    // dead target -> back to patrol
    ai.update({ ...seeing, seen: () => null }, { dead: () => true, position: () => target });
    expect(ai.attacking).toBe(false);
  });
});

describe("vehicle perception (synthetic)", () => {
  it("FUN_00489750: phase ticks, alive humans of another team, cone every 2nd run, sight every 3rd", () => {
    const eye = { position: [0, 0, 0] as Vec3, matrix: I3, alpha: Math.PI, gamma: 2 * Math.PI, length: 30 * 4096 };
    const d = new VehicleDetector(1);
    const humans = [
      { key: "player", team: 0, alive: true, inWorld: true, point: [0, 40960, 0] as Vec3 },
      { key: "soldier:1", team: 1, alive: true, inWorld: true, point: [0, 4096, 0] as Vec3 },
      { key: "soldier:2", team: 0, alive: false, inWorld: true, point: [0, 4096, 0] as Vec3 },
    ];
    let sights = 0;
    const run = (tick: number) => d.perceive(tick, humans, (o) => vehicleInCone(eye, o.point), () => (sights++, true));
    run(0); // not this vehicle's phase
    expect(d.list).toEqual([]);
    run(1);
    expect(d.list).toEqual(["player"]);
    expect(d.seen()).toBe("player");
    for (let t = 5; t <= 25; t += 4) run(t);
    expect(sights).toBe(3); // runs 1, 4, 7
    // the cone: 30 m long, alpha 30 deg about the forward / up plane
    expect(vehicleInCone({ ...eye, length: 4096 }, [0, 40960, 0])).toBe(false);
    expect(vehicleInCone({ ...eye, alpha: (30 * Math.PI) / 180 }, [0, 4096, 4096])).toBe(false);
    expect(vehicleInCone({ ...eye, gamma: (30 * Math.PI) / 180 }, [4096, 4096, 0])).toBe(false);
    d.clear();
    expect(d.seen()).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Full game
// ---------------------------------------------------------------------------

const levels = new Map<number, Promise<IgiLevel>>();
function mission(id: number): Promise<IgiLevel> {
  let p = levels.get(id);
  if (!p) {
    const [def] = readMissionDefinition(bytes(`${FULL}/missions/location0/level${id}/mission.qvm`), new Map());
    p = loadIgiLevel(createFsAssetSource(FULL), levelPathsFor(def.location));
    levels.set(id, p);
  }
  return p;
}

/** Flat ground at IGI height z as collision triangles (the engine's castDown path). */
function flatCollision(level: IgiLevel, z: number): CollisionWorld {
  const b = new CollisionWorldBuilder();
  const y = (z - level.originIgi[2]) / 4096;
  b.addIndexed([-50000, y, -50000, -50000, y, 50000, 50000, y, 50000, 50000, y, -50000], [0, 1, 2, 0, 2, 3], TRI_BULLET);
  return b.build(64);
}

describe.skipIf(!haveFull)("full game vehicles", () => {
  it("plane.qvm: SU27 and CutSceneMissile share the recovered config and drag elements; JSF has 8 contact points", () => {
    const types = ["SU27", "CutSceneMissile", "JSF"].flatMap((p) => readPhysicsObjTypes(bytes(`${FULL}/physicsobj/planes/${p}/plane.qvm`), p));
    expect(types.map((t) => [t.model, t.mass, t.size, t.points.length])).toEqual([
      ["702_02_1", 10000, [5, 16, 2.5], 0], ["714_01_1", 10000, [5, 16, 2.5], 0], ["701_01_1", 10000, [5, 16, 2.5], 8],
    ]);
    const cfg = types[0].config as VehicleBaseConfig;
    expect(cfg.c[7]).toBe(22500);
    const el = (e: DragElement) => [e.coef, ...e.point.map((v) => Math.round(v) + 0), ...e.normal.map((v) => Math.round(v * 1e4) / 1e4 + 0)];
    expect(cfg.drag.map(el)).toEqual([
      [6, 0, 0, 0, 1, 0, 0], [2, 0, 0, 0, 0, 1, 0], [60, 0, 32768, 0, 0, -0.0871, 0.9962] /* (0, -0.0871, 0.9961) normalised */, [0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0], [10, 0, -32768, 0, 1, 0, 0],
    ]);
    expect((types[1].config as VehicleBaseConfig).drag.map(el)).toEqual(cfg.drag.map(el));
    expect(types[0].restSpeed).toBe(f32(0.7));
  });

  it("mission 3: the three SU-27s are placed with gear, hatch, canopy and rudders (afterburners are never drawn)", async () => {
    const level = await mission(3);
    const tasks = buildMissionTasks(level.taskRoots);
    const keyOf = (id: number) => tasks.byId.get(id)!;
    for (const id of [1988, 600, 601]) {
      const inst = level.instances.filter((i) => i.taskIndex === keyOf(id));
      expect(inst.find((i) => i.attachmentPath === "")?.model).toBe("702_02_1");
      expect(inst.map((i) => i.model).sort()).toEqual(["702_02_1", "702_03_1", "702_06_1", "702_07_1", "702_08_1", "702_09_1", "702_10_1", "702_11_1", "702_12_1", "702_13_1", "702_14_1", "702_15_1", "715_01_1"].sort());
    }
    const vehicles = createVehicleSystem(level, tasks, { collision: () => null, runtime: () => null });
    expect(vehicles.planes.map((p) => p.id).sort((a, b) => a - b)).toEqual([600, 601, 1988]);
    const p600 = vehicles.planes.find((p) => p.id === 600)!.sim;
    expect([p600.canopy, p600.gear]).toEqual([true, true]);
    // compile: v0 = Original Thrust x 700 x 30.34 along local +y (Speed is 0)
    const p1988 = vehicles.planes.find((p) => p.id === 1988)!.sim;
    const v0 = f32(f32(700 * f32(1.0499999523162842)) * PLANE_V0_K);
    expect(Math.hypot(...p1988.body.velocity)).toBeCloseTo(v0, 0);
    // the left main gear 702_15_1 (mirroring ATTA): its wheel vertex is below the plane as the right one's
    const gears = p600.parts.filter((q) => q.kind === "gear");
    const z = gears.map((g) => { const w = p600.partWorld(g); const v = g.vertex!; return w.position[2] + w.matrix[6] * v[0] + w.matrix[7] * v[1] + w.matrix[8] * v[2] - p600.position[2]; });
    for (const dz of z) expect(dz).toBeLessThan(-8000);
  }, 60_000);

  it("mission 3 plane 601 (takeoff and fly away): rolls on its three gears, lifts off along the runway, retracts the gear", async () => {
    const level = await mission(3);
    const tasks = buildMissionTasks(level.taskRoots);
    const node = tasks.nodes[tasks.byId.get(601)!];
    const sim = new PlaneSim(vehicleParamsFromTask(node.task), level.vehicles!.types, level.vehicles!.models.get("702_02_1")!, level.vehicles!.magic,
      (n) => level.vehicles!.models.get(n), planeFlagsFromTask(node.task.params));
    const ground = sim.position[2] - 8934; // the gear vertices 2.18 m below the origin
    const world = flatWorld(ground);
    const anim = tasks.animTasks.find((a) => a.targetId === 601)!;
    const st = { channels: new Float32Array(34), nTick: 0 };
    stepAnimRecords(st, anim.records);
    sim.animInput(0, st.channels, world);
    st.nTick = 1;
    const start = [...sim.position];
    let minZ = Infinity;
    for (let i = 1; i < 600; i++) {
      stepAnimRecords(st, anim.records);
      sim.animInput(st.nTick++, st.channels, world);
      if (i < 200) minZ = Math.min(minZ, sim.position[2] - start[2]);
      if (i === 100) expect(Math.abs(sim.matrix[2])).toBeLessThan(0.05); // level on three gears
    }
    expect(minZ).toBeGreaterThan(-4096 * 0.3); // settles ~0.13 m on the springs
    expect(sim.position[2] - start[2]).toBeGreaterThan(100 * 4096);
    expect(sim.position[0] - start[0]).toBeGreaterThan(1000 * 4096); // the runway heading (+x)
    expect(sim.gear).toBe(false);
    expect(sim.gearState).toBe(0);
    for (const g of sim.parts.filter((q) => q.kind === "gear")) expect(Math.abs(g.angle)).toBeGreaterThan(1.4);
  }, 60_000);

  it("CarAI tasks of missions 6, 7, 8, 10 and 14: 16 tasks, the working ones drive their car along the route", async () => {
    let total = 0;
    let driving = 0;
    for (const id of [6, 7, 8, 10, 14]) {
      const level = await mission(id);
      const tasks = buildMissionTasks(level.taskRoots);
      const vehicles = createVehicleSystem(level, tasks, { collision: () => null, runtime: () => null });
      total += vehicles.carAis.length;
      driving += vehicles.carAis.filter((c) => c.ai.graph && c.ai.route && c.car).length;
    }
    expect(total).toBe(16);
    expect(driving).toBe(13); // the three "Fake" parked twins have no graph / route
  }, 120_000);

  it("mission 6 APC 800 (CarAI 850): drives W1, W3, W9, passes the END and continues with W17", async () => {
    const level = await mission(6);
    const tasks = buildMissionTasks(level.taskRoots);
    const car = tasks.nodes[tasks.byId.get(800)!].task;
    const flat = flatCollision(level, vehicleParamsFromTask(car).position[2] - 7800);
    const vehicles = createVehicleSystem(level, tasks, { collision: () => flat, runtime: () => null });
    const ai = vehicles.carAis.find((c) => c.id === 850)!;
    const route = patrolCommandsOf(tasks.nodes[tasks.byId.get(602)!].task.children);
    expect(route.filter((c) => c.command === PATROL_COMMAND.WALKTO).map((c) => c.parameter)).toEqual([1, 3, 9, 17, 10, 20, 6]);
    const reached: number[] = [];
    for (let t = 0; t < 1400; t++) {
      vehicles.taskUpdate(tasks.byId.get(800)!);
      vehicles.taskUpdate(ai.key);
      const cmd = ai.ai.cursor?.command();
      if (cmd?.command === PATROL_COMMAND.WALKTO && reached[reached.length - 1] !== cmd.parameter) reached.push(cmd.parameter);
    }
    expect(reached.slice(0, 4)).toEqual([1, 3, 9, 17]);
    const sim = vehicles.cars.find((c) => c.id === 800)!.sim;
    expect(sim.body.speed * 0.0263671875).toBeLessThan(40);
  }, 60_000);

  it("mission 10 rail 870 (Automatic Orientation): waypoint x axes follow the tangent; the trains' couplings sit on the rail", async () => {
    const level = await mission(10);
    const tasks = buildMissionTasks(level.taskRoots);
    const spline = level.tasks.find((t) => t.type === "SplineObj" && t.id === 870)!;
    const rail = railSplineFromTask(spline);
    const wps = rail.waypoints;
    for (let k = 1; k + 1 < wps.length; k++) {
      const t = [0, 1, 2].map((i) => wps[k + 1].position[i] - wps[k - 1].position[i]);
      const n = Math.hypot(...t);
      const m = wps[k].matrix;
      expect(m[0] * t[0] / n + m[3] * t[1] / n + m[6] * t[2] / n).toBeGreaterThan(0.99999);
    }
    let trains = 0;
    for (const train of tasks.trains) {
      const node = tasks.nodes[train.nodeIndex];
      if (train.railroadTaskId !== 870 || tasks.nodes[node.parent].type === "Train") continue;
      const carTasks = [node.task, ...node.task.children.filter((c) => c.type === "Train")];
      const cars = carTasks.map((c) => trainCar(c.id, String(c.params["Model"]), level.vehicles!.models.get(String(c.params["Model"]))!.magicVertices, [Number(c.params["Displacement X"]), Number(c.params["Displacement Y"])]));
      const poses = placeTrain(rail, cars, train.distance, train.flipDirection)!;
      poses.forEach((p, j) => expect(Math.abs(Math.hypot(...[0, 1, 2].map((i) => p.front[i] - p.back[i])) - cars[j].length)).toBeLessThan(8));
      trains++;
    }
    expect(trains).toBeGreaterThan(0);
  }, 60_000);

  it("mission 7: a destroyed APC explodes at its explosion vertices, waits 30 ticks, becomes its wreck, isExploded = 1", async () => {
    const level = await mission(7);
    const tasks = buildMissionTasks(level.taskRoots);
    const apc = tasks.byId.get(352)!;
    const explosions: Vec3[] = [];
    let wreck: string | null = null;
    const vehicles = createVehicleSystem(level, tasks, {
      collision: () => null, runtime: () => null,
      carDamaged: (node) => node === apc, explode: (e) => explosions.push(e.position), wreck: (_n, m) => { wreck = m; },
    });
    vehicles.taskUpdate(apc); // the damage flag is seen
    vehicles.taskUpdate(apc); // FUN_0042e5a0: explosions, countdown 30
    expect(explosions.length).toBe(5); // explosion vertices 4..8
    for (let t = 0; t < 29; t++) vehicles.taskUpdate(apc);
    expect(vehicles.isExploded(352)).toBe(0);
    vehicles.taskUpdate(apc);
    expect(vehicles.isExploded(352)).toBe(1);
    expect(wreck).toBe("601_08_1");
  }, 60_000);

  it("mission 8: the runtime drives the CarAI APCs through the mission system path without errors", async () => {
    const level = await mission(8);
    const tasks = buildMissionTasks(level.taskRoots);
    let runtime: MissionRuntime | null = null;
    const vehicles = createVehicleSystem(level, tasks, { collision: () => null, runtime: () => runtime, evaluate: (t) => runtime?.evaluate(t) ?? 0 });
    runtime = new MissionRuntime(tasks, {
      onAnimInput: (a, n, ch) => vehicles.animInput(a, n, ch),
      updateTask: (node) => {
        if (node.type === "Car" || node.type === "CarAI" || node.type === "Plane") vehicles.taskUpdate(node.index);
        return false;
      },
    });
    for (let t = 0; t < 300; t++) runtime.tick();
    const plane = vehicles.planes.find((p) => p.id === 806);
    expect(plane).toBeDefined();
    expect(Number.isFinite(plane!.sim.position[0])).toBe(true);
  }, 60_000);

  it("mission 6 Mil 802: \"Open door\" slides the HeliDoor 700_05_1 2.65 m along y at 0.6 m/s; sound groups and CRITERIA_VEHICLE objects", async () => {
    const level = await mission(6);
    const tasks = buildMissionTasks(level.taskRoots);
    const vehicles = createVehicleSystem(level, tasks, { collision: () => null, runtime: () => null, evaluate: () => 1 });
    const heli = tasks.byId.get(802)!;
    const door = level.instances.findIndex((i) => i.taskIndex === heli && i.model === "700_05_1");
    expect(door).toBeGreaterThanOrEqual(0);
    const before = vehicles.instanceMatrices(door)[0];
    vehicles.taskUpdate(heli); // "Open door" -> 1
    const ch = new Float32Array(34).fill(-1);
    ch[0] = ch[1] = ch[2] = 0;
    const anim = { id: -1, nodeIndex: -1, targetId: 802, targetType: "Heli", run: "", initialRun: true, records: [] };
    vehicles.animInput(anim, 0, ch);
    const heliSim = vehicles.helis.find((h) => h.id === 802)!.sim;
    const m = heliSim.matrix;
    for (let t = 1; t <= 200; t++) {
      heliSim.position = [...heliSim.initPosition] as Vec3; // keep the heli still: only the door moves
      heliSim.matrix = [...heliSim.initMatrix] as Mat3;
      vehicles.animInput(anim, t, ch);
    }
    heliSim.position = [...heliSim.initPosition] as Vec3;
    heliSim.matrix = [...heliSim.initMatrix] as Mat3;
    const after = vehicles.instanceMatrices(door)[0];
    const moved = Math.hypot(after[12] - before[12], after[13] - before[13], after[14] - before[14]);
    expect(moved).toBeCloseTo(2.65, 2);
    expect(m.length).toBe(9);
    const groups = new Set(vehicles.sounds().map((s) => s.group));
    expect(groups.has("helicopter_1")).toBe(true);
    expect(groups.has("apc_sounds")).toBe(true);
    const area = vehicles.areaVehicles();
    expect(area.length).toBe(vehicles.helis.length + vehicles.cars.length + vehicles.planes.length + vehicles.trains.reduce((n, t) => n + t.keys.length, 0));
  }, 60_000);

  it("objects.qvm of every mission still parses (constant-expression arguments only change the plane scripts)", () => {
    for (let id = 1; id <= 14; id++) expect(readQvmCallTree(bytes(`${FULL}/missions/location0/level${id}/objects.qvm`)).length).toBeGreaterThan(0);
  });

  it("CarSim types of missions 2-14: APC, T80 and Limo build with their wheels; the T80 sound group is absent", async () => {
    const level = await mission(7);
    const types = level.vehicles!.types;
    const t80 = types.find((t) => t.model === "614_01_1")!.config as { sound: string; wreckModel: string; differential: boolean };
    expect([t80.sound, t80.wreckModel, t80.differential]).toEqual(["t80_sounds", "614_08_1", true]);
    const tasks = buildMissionTasks(level.taskRoots);
    const node = tasks.nodes[tasks.byId.get(357)!];
    const sim = new CarSim(vehicleParamsFromTask(node.task), types, level.vehicles!.models.get("614_01_1")!, level.vehicles!.magic);
    expect(sim.nDriven).toBe(4);
  }, 60_000);
});
