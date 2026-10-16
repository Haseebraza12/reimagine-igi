/**
 * The full game's object tasks (src/loaders/objects, docs/objects.md): the
 * recovered update rules on synthetic task trees, and the use tests / stances
 * the player runs for them (engine/player/use-objects.ts).
 */
import { describe, expect, it } from "vitest";
import {
  DRAWER_CLOSE_STEP,
  DRAWER_OPEN_SLIDE,
  DRAWER_OPEN_STEP,
  ELEVATOR_UNITS_PER_TICK,
  MissionRuntime,
  buildMissionTasks,
  cabinetAbort,
  cabinetSearched,
  elevatorRig,
  finishTba,
  touchGenericPickup,
  useObjectTick,
  type IgiTask,
  type MissionHost,
  type TaskParam,
} from "../src/loaders";
import { LevelRng } from "../src/engine/ai/rng";
import { x87StoreF32 } from "../src/loaders/x87";
import {
  CABINET_STANCE,
  TBA_STANCE,
  UseSearch,
  placeExplosiveStance,
  searchUseTarget,
  tbaSprite,
  timedUseStance,
  type M3,
  type TimedUseTarget,
  type UseView,
} from "../src/engine/player/use-objects";

const t = (type: string, id: number, params: Record<string, TaskParam> = {}, children: IgiTask[] = []): IgiTask => ({ id, type, name: "", params, children });
const f32 = Math.fround;

function run(roots: IgiTask[], host: MissionHost = {}) {
  const events: Array<{ type: string; event: string; data: unknown }> = [];
  const rt = new MissionRuntime(buildMissionTasks(roots), {
    ...host,
    onTaskEvent: (node, event, data) => events.push({ type: node.type, event, data }),
  });
  const node = (id: number) => rt.tasks.byId.get(id)!;
  return { rt, events, node, state: (id: number) => rt.nodeState(node(id)) };
}

/** A LevelFlow (its nTick is the use clock) and the tasks under test. */
const flow = () => t("LevelFlow", 1, { Complete: "", Failed: "" });

describe("Elevator (FUN_0043d280 / FUN_0043d6e0 / FUN_0043d960)", () => {
  // Two floors 30.5 m apart on a "Linear Segments" spline, like L3 Elevator_330 but vertical.
  const spline = (z1: number) => t("SplineObj", 50, { "Linear Segments": true, "Gamma Orientation": f32(Math.PI), "Number of Matrices / Segment": 20 }, [
    t("SplineObjWaypoint", -1, { Position: [1000, 2000, 0], Orientation: [0, 0, 0], NumAreas: 20 }),
    t("SplineObjWaypoint", -1, { Position: [1000, 2000, z1], Orientation: [0, 0, 0], NumAreas: 20 }),
  ]);
  const lift = (params: Record<string, TaskParam>) =>
    t("Elevator", 60, {
      Position: [1000, 2000, 0], Orientation: [0, 0, 0], Model: "200_01_1", "SplineObj taskid": 50, Linear: true, "Force orientation": false,
      Pos: 0, "Max speed": 5, "Speed inertia": f32(0.99), "Start sound": "elv_start_1", "Stop sound": "elv_stop_1", "Move sound": "elv_move_1",
      ...params,
    });

  it("floors are the spline's arc lengths; a wanted floor starts the trip with the start sound and the move loop", () => {
    const z1 = 124928; // 30.5 m
    const { rt, events, node, state } = run([flow(), t("EditVariable", 2, { "Initial value": 0, Add: "", Sub: "" }), spline(z1), lift({ "Wanted floor 1": "EditVariable_2.nValue == 1" })]);
    const rig = elevatorRig(rt, node(60))!;
    expect(rig.floors).toEqual([0, z1]);
    rt.tick();
    expect(state(60).isMoving).toBe(0);
    expect(state(60).vFloor).toBe(0);
    expect(state(60).nInactive).toBe(1);
    rt.behaviourState(node(2)).nValue = 1;
    rt.tick();
    // At rest the move kept speed = max(0 x Max / 4 m, 0.1); far from the floor: + Inertia.
    const s = state(60);
    expect(s.nWantedFloor).toBe(1);
    expect(s.isWantedFloor1).toBe(1);
    // Float stores truncate (the FPU's chop mode, x87StoreF32).
    expect(s.speed).toBe(x87StoreF32(f32(0.1) + f32(0.99)));
    expect(s.pos).toBe(x87StoreF32(s.speed * ELEVATOR_UNITS_PER_TICK));
    expect(s.isMoving).toBe(1);
    expect(s.isStart).toBe(1);
    expect(events.map((e) => e.event)).toEqual(["loop", "sound"]);
    expect((events[1].data as { name: string }).name).toBe("elv_start_1");
    // Linear: the car is at lerp(wp0, wp1, pos / total); vFloor interpolates.
    expect(rig.pose.position[2]).toBeCloseTo((s.pos / z1) * z1, 6);
    expect(s.vFloor).toBeCloseTo(s.pos / z1, 12);
    // Cruise at Max after a few ticks, then the 4 m slow-down, then the stop sound and floor 1.
    let ticks = 2;
    while (state(60).isMoving && ticks < 2000) {
      rt.tick();
      ticks++;
      if (state(60).pos < z1 - 16384) expect(state(60).speed).toBeLessThanOrEqual(5);
    }
    expect(state(60).pos).toBe(z1);
    expect(state(60).vFloor).toBe(1);
    expect(state(60).isStop).toBe(1);
    expect(events.map((e) => e.event)).toEqual(["loop", "sound", "loop-stop", "sound"]);
    expect((events[3].data as { name: string }).name).toBe("elv_stop_1");
    // 26.5 m at 5 m/s (after ~5 ticks of acceleration) + the 4 m slow-down (down to 0.1 m/s).
    expect(ticks).toBeGreaterThan(160);
    expect(ticks).toBeLessThan(400);
  });

  it("Can start holds the car (still isMoving); Floor up is a rising edge", () => {
    const { rt, node, state } = run([
      flow(), t("EditVariable", 2, { "Initial value": 0, Add: "", Sub: "" }), t("EditVariable", 3, { "Initial value": 1, Add: "", Sub: "" }), spline(40960),
      lift({ "Floor up": "EditVariable_2.nValue", "Can start": "EditVariable_3.nValue" }),
    ]);
    rt.behaviourState(node(3)).nValue = 0;
    rt.behaviourState(node(2)).nValue = 1;
    rt.tick();
    expect(state(60).nWantedFloor).toBe(1);
    expect(state(60).pos).toBe(0);
    expect(state(60).isMoving).toBe(1);
    expect(state(60).isStart).toBe(0);
    rt.tick(); // still up: no second step (and floor 1 is the last anyway)
    expect(state(60).nWantedFloor).toBe(1);
    rt.behaviourState(node(3)).nValue = 1;
    rt.tick();
    expect(state(60).pos).toBeGreaterThan(0);
    // isStart needs posOld == the target at the start of the tick: a held car leaves silently.
    expect(state(60).isStart).toBe(0);
  });

  it("an early update (a rider's platform call) runs once per tick", () => {
    const { rt, node, state } = run([flow(), spline(40960), lift({ "Floor up": "1" })]);
    rt.updateBehaviourNow(node(60));
    const pos = state(60).pos;
    expect(pos).toBeGreaterThan(0);
    rt.tick();
    expect(state(60).pos).toBe(pos); // the guard: the tree walk's update was a no-op
    rt.tick();
    expect(state(60).pos).toBeGreaterThan(pos);
  });
});

describe("Generator (FUN_0043b500) and Radio (FUN_0043af90)", () => {
  it("the backup timer turns an off generator on for good after int(seconds x 30) ticks", () => {
    const { rt, events, state } = run([flow(), t("Generator", 99, { Position: [0, 0, 0], "On expression": "0", "Use backup timer": true, "Seconds until power backup": 1, "Run sound": "generator_run", "Shutdown sound": "generator_stop" })]);
    for (let i = 0; i < 30; i++) {
      rt.tick();
      expect(state(99).isOn).toBe(0);
    }
    expect(state(99).nBackupTimer).toBe(0);
    rt.tick(); // On "0" sets it off, the timer at 0 turns it back on
    expect(state(99).isOn).toBe(1);
    expect(events.map((e) => e.event)).toEqual(["loop"]);
    expect((events[0].data as { name: string }).name).toBe("generator_run");
  });

  it("without an On expression or backup it stays off; isExploded forces it off", () => {
    const { rt, state, node } = run([flow(), t("Generator", 99, { Position: [0, 0, 0], "Use backup timer": false, "Explosion expression": "" })]);
    for (let i = 0; i < 5; i++) rt.tick();
    expect(state(99).isOn).toBe(0);
    rt.behaviourState(node(99)).isOn = 1;
    rt.detonate(node(99)); // delay 0
    rt.tick();
    expect(state(99).isExploded).toBe(1);
    expect(state(99).isOn).toBe(0);
  });

  it("the radio draws two level-RNG values per cycle even with empty sample names", () => {
    const rng = new LevelRng();
    const { rt } = run([flow(), t("Radio", 3366, { Position: [0, 0, 0], "On expression": "1" })], { randomInt: (n) => rng.int(n) });
    rt.tick();
    expect(rng.draws).toBe(2);
    const twin = new LevelRng();
    twin.int(4);
    const countdown = twin.int(150) + 150;
    for (let i = 0; i < countdown; i++) rt.tick();
    expect(rng.draws).toBe(2);
    rt.tick();
    expect(rng.draws).toBe(4);
  });
});

describe("Cabinet, GenericTBA, PlaceExplosiveTBA, GenericPickup, BinocularOverlayHolder", () => {
  it("the cabinet's active call opens / closes the drawer from the anim trigger; an abort snaps it shut", () => {
    const { rt, node, state } = run([flow(), t("Cabinet", 1500, { Position: [0, 0, 0], Orientation: 0, Model: "206_01_1", "Search Time (s)": 4 })]);
    const i = node(1500);
    rt.tick();
    useObjectTick(rt, i, 0);
    expect(state(1500).isInUse).toBe(1);
    const slides: number[] = [];
    for (let k = 0; k < 14; k++) {
      rt.tick();
      slides.push(state(1500).slide);
    }
    expect(slides[0]).toBe(DRAWER_OPEN_STEP);
    expect(slides[13]).toBe(DRAWER_OPEN_SLIDE);
    expect(state(1500).drawerOn).toBe(0);
    // isInUse drops 2 ticks after the last active call (LevelFlow nTick).
    expect(state(1500).isInUse).toBe(0);
    useObjectTick(rt, i, 1);
    rt.tick();
    expect(state(1500).slide).toBe(f32(DRAWER_OPEN_SLIDE - DRAWER_CLOSE_STEP));
    cabinetAbort(rt, i);
    rt.tick();
    expect(state(1500).slide).toBe(0);
    expect(state(1500).isSearched).toBe(0);
    cabinetSearched(rt, i);
    expect(state(1500).isSearched).toBe(1);
  });

  it("a TBA's isOn follows its expression; finishing pulses isFinishedThisTick", () => {
    const { rt, node, state } = run([
      flow(), t("EditVariable", 270, { "Initial value": 0, Add: "", Sub: "" }),
      t("GenericTBA", 282, { Position: [0, 0, 0], Orientation: [0, 0, 0], Model: "202_01_1", Explodable: false, "On Expression": "EditVariable_270.nValue == 1", "Activate Anim": 245, "Activate Time (s)": 4 }),
    ]);
    expect(state(282).isOn).toBe(1); // create
    rt.tick();
    expect(state(282).isOn).toBe(0);
    rt.behaviourState(node(270)).nValue = 1;
    rt.tick();
    expect(state(282).isOn).toBe(1);
    finishTba(rt, node(282));
    expect(rt.member("GenericTBA_282.isFinished")).toBe(1);
    rt.tick();
    rt.tick();
    expect(state(282).isFinishedThisTick).toBe(1);
    rt.tick();
    expect(state(282).isFinishedThisTick).toBe(0);
    expect(state(282).isFinished).toBe(1);
  });

  it("a GenericPickup is touched within max(radius, 0.7 m) and 1 m; the next update removes it with the 2-D sound", () => {
    const { rt, events, node, state } = run([flow(), t("GenericPickup", 200, { Position: [10000, 0, 0], Orientation: [0, 0, 0], Model: "139_02_1" })]);
    const i = node(200);
    expect(touchGenericPickup(rt, i, [10000, 0, 0], [10000 + 2867, 0, 4000], 100)).toBe(true);
    expect(state(200).isPickedUp).toBe(1);
    rt.tick();
    expect(state(200).inWorld).toBe(0);
    expect(events).toEqual([{ type: "GenericPickup", event: "sound2d", data: { name: "pickup" } }]);
    const b = run([flow(), t("GenericPickup", 201, { Position: [0, 0, 0] })]);
    expect(touchGenericPickup(b.rt, b.node(201), [0, 0, 0], [2868, 0, 0], 0)).toBe(false);
    expect(touchGenericPickup(b.rt, b.node(201), [0, 0, 0], [0, 0, 4096], 0)).toBe(false);
    expect(touchGenericPickup(b.rt, b.node(201), [0, 0, 0], [4000, 0, 0], 4096)).toBe(true);
  });

  it("the binocular holder's visible flag is byte(Visible expression)", () => {
    const { rt, node, state } = run([flow(), t("EditVariable", 2, { "Initial value": 0, Add: "", Sub: "" }), t("BinocularOverlayHolder", -1, { "Visible expression": "EditVariable_2.nValue" })]);
    rt.tick();
    const holder = rt.tasks.nodes.find((n) => n.type === "BinocularOverlayHolder")!.index;
    expect(rt.nodeState(holder).visible).toBe(0);
    rt.behaviourState(node(2)).nValue = 1;
    rt.tick();
    expect(rt.nodeState(holder).visible).toBe(1);
    void state;
  });
});

describe("use tests and stances (LAB_00444860 / LAB_00443c80 / LAB_004389e0; FUN_0040c2f0 / FUN_0040cf70 / FUN_0040d180)", () => {
  const view = (eye: [number, number, number]): UseView => ({ eye, axes: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
  const target = (kind: TimedUseTarget["kind"], extra: Partial<TimedUseTarget> = {}): TimedUseTarget => ({
    kind, taskId: 1, nodeIndex: 1, position: [0, 0, 0], rotation: [-1, 0, 0, 0, -1, 0, 0, 0, 1] as M3, points: [], enabled: true,
    seconds: 4, anim: 245, icon: null, range: 0, placeTaskId: -1, ...extra,
  });

  it("cabinet / TBA: only from the front (R col 1), within 2 m and the view angles", () => {
    // R = Rz(pi): the front is -y; the eye looks along +y from y = -6000.
    expect(searchUseTarget(view([0, -6000, 0]), [target("cabinet")]).target?.kind).toBe("cabinet");
    expect(searchUseTarget(view([0, 6000, 0]), [target("cabinet")]).target).toBeNull();
    expect(searchUseTarget(view([0, -9000, 0]), [target("cabinet")]).target).toBeNull(); // > 2 m
    expect(searchUseTarget(view([0, -6000, 0]), [target("tba", { enabled: false })]).target).toBeNull();
  });

  it("PlaceExplosiveTBA: its own radius, no front test, and only when nothing earlier won", () => {
    const far = target("placeExplosive", { range: f32(f32(6.8) * 4096) });
    expect(searchUseTarget(view([0, -20000, 0]), [far]).target?.kind).toBe("placeExplosive");
    const s = new UseSearch(view([0, -20000, 0]));
    s.winner = "earlier" as never;
    expect(s.considerFirst([0, 0, 0], "explosive" as never, far.range)).toBe(false);
  });

  it("stances: cabinet R (778.24, 2457.6, 0) at point 0, TBA R (0, 3481.6, 0) at point 1, facing the object", () => {
    const cab = timedUseStance(target("cabinet", { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] as M3, position: [100, 200, 300] }));
    expect(cab.position).toEqual([Math.fround(100 + CABINET_STANCE[0]), 200 + CABINET_STANCE[1], 300]);
    expect(cab.heading).toBe(Math.fround(Math.PI));
    const tba = timedUseStance(target("tba", { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] as M3, points: [[0, 0, 0], [0, 100, 0]] }));
    expect(tba.position).toEqual([0, 100 + TBA_STANCE[1], 0]);
  });

  it("state 36: the charge at the hit, the player 2048 back along the eye ray, facing against the hit normal", () => {
    const at = placeExplosiveStance([0, -10000, 4096], [0, 0, 4096], { point: [0, -2000, 4096], normal: [0, -1, 0] });
    expect(at.charge).toEqual([0, -2000, 4096]);
    expect(at.position).toEqual([0, -4048, 4096]);
    // FUN_004b2d00 gives 0 for n.x == 0 (not atan2(-1, 0)): gamma = pi/2.
    expect(at.heading).toBe(Math.fround(Math.PI / 2));
    // A normal with an x part: gamma = atan2(n.y, n.x) + pi/2, the body faces -n.
    const oblique = placeExplosiveStance([0, -10000, 4096], [0, 0, 4096], { point: [0, -2000, 4096], normal: [-1, -1, 0] });
    const h = oblique.heading;
    expect(-Math.sin(h)).toBeCloseTo(Math.SQRT1_2, 6);
    expect(Math.cos(h)).toBeCloseTo(Math.SQRT1_2, 6);
    const miss = placeExplosiveStance([0, 0, 0], [4096, 0, 0], null);
    expect(miss.charge).toEqual([0, 0, 0]);
    expect(miss.heading).toBe(Math.fround(0 + Math.fround(Math.PI / 2)));
  });

  it("TBA sprites resolve by exact name from the list of 10", () => {
    expect(tbaSprite("STATUSSCREEN:a_c4.spr")).toBe("a_c4.spr");
    expect(tbaSprite("STATUSSCREEN:nothing.spr")).toBeNull();
    expect(tbaSprite("")).toBeNull();
  });
});
