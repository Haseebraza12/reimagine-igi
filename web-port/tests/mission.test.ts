/**
 * Mission task runtime (src/loaders/mission.ts, docs/mission.md).
 * Synthetic tests run everywhere; level-1 tests read the staged objects.qvm
 * and are skipped when web-port/game-data is absent.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { RAW_ROOT, readRaw } from "./helpers";
import {
  MissionRuntime,
  applyCameraLink,
  areaActiveCount,
  areaContains,
  areaCriteriaMask,
  cameraHermite,
  cameraLookAt,
  cutSceneFinishTick,
  decodeAnimData,
  doorPose,
  eulerToMatrix,
  letterboxBarHeight,
  newAnimPlayback,
  newDoorState,
  readMissionTasks,
  sampleCutSceneCamera,
  seekAnimPlayback,
  stepDoor,
  trainAnimInput,
  type AreaActivateTask,
  type DoorTask,
  type MissionHost,
  type MissionTasks,
  type TrainTask,
  type Vec3,
} from "../src/loaders/mission";

const OBJECTS = "missions/location0/level1/objects.qvm";
const hasData = existsSync(`${RAW_ROOT}/${OBJECTS}`);

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

describe("recovered helpers (synthetic)", () => {
  it("Real32x9 / camera matrix is Rz(gamma) Ry(beta) Rx(alpha); alpha -pi/2 looks along +y", () => {
    const m = eulerToMatrix(-Math.PI / 2, 0, 0);
    // columns = right, down, forward
    close(m[0], 1); close(m[3], 0); close(m[6], 0);
    close(m[1], 0); close(m[4], 0); close(m[7], -1);
    close(m[2], 0); close(m[5], 1); close(m[8], 0);
    const g = eulerToMatrix(0, 0, Math.PI / 2); // CCW about +z: x -> y
    close(g[3], 1); close(g[0], 0);
  });

  it("AreaActivate: Dimensions are full sizes, boundaries count, rotation applied", () => {
    const area: AreaActivateTask = {
      id: 1, nodeIndex: 0, position: [100, 200, 300], euler: [0, 0, Math.PI / 2], dimensions: [40, 20, 10],
      halfExtents: [20, 10, 5], criteria: "CRITERIA_HUMAN0",
    };
    expect(areaContains(area, [100, 200, 300])).toBe(true);
    // rotated 90 deg: local x (half 20) lies along world y
    expect(areaContains(area, [100, 219, 300])).toBe(true);
    expect(areaContains(area, [119, 200, 300])).toBe(false);
    expect(areaContains(area, [109, 200, 305])).toBe(true);
    expect(areaContains(area, [100, 200, 305.5])).toBe(false);
    const mask = areaCriteriaMask("CRITERIA_HUMAN0\n");
    expect(mask).toBe(areaCriteriaMask("CRITERIA_HUMAN0"));
    expect(areaActiveCount(area, [
      { position: [100, 200, 300], team: 0, kind: "human" },
      { position: [101, 200, 300], team: 1, kind: "human" },
      { position: [101, 201, 300], team: 0, kind: "human" },
    ], mask)).toBe(2);
    expect(areaActiveCount(area, [{ position: [100, 200, 300], team: 1, kind: "human" }], areaCriteriaMask("CRITERIA_HUMAN"))).toBe(1);
  });

  it("camera Hermite: endpoints, hold when t2 == t1, m1 uses (t1 - t0)", () => {
    close(cameraHermite([0, 10, 20, 30], [0, 1, 2, 3], 1), 10);
    close(cameraHermite([0, 10, 20, 30], [0, 1, 2, 3], 2), 20);
    close(cameraHermite([0, 10, 20, 30], [0, 1, 2, 3], 1.5), 15); // uniform: linear data stays linear
    close(cameraHermite([0, 10, 20, 30], [0, 1, 1, 1], 1.7), 10); // non-smooth key: hold
    // Non-uniform times: tangent m1 = (p2 - p0)(t1 - t0)/(t2 - t0) = 20 * 4 / 5 = 16, m2 = 0 (t3 == t1? no: (30-10)*1/2 = 10).
    const s = 0.5;
    const [p1, p2, m1, m2] = [10, 20, 16, 10];
    const expected = p1 + m1 * s + (3 * (p2 - p1) - 2 * m1 - m2) * s * s + (2 * (p1 - p2) + m1 + m2) * s * s * s;
    close(cameraHermite([0, 10, 20, 30], [0, 4, 5, 6], 4.5), expected);
  });

  it("camera link and look-at", () => {
    const init = { position: [0, 0, 0] as Vec3, matrix: eulerToMatrix(0, 0, 0) };
    const cur = { position: [100, 0, 0] as Vec3, matrix: eulerToMatrix(0, 0, Math.PI / 2) };
    const p = applyCameraLink([10, 0, 0], eulerToMatrix(0, 0, 0), init, cur);
    close(p.position[0], 100); close(p.position[1], 10);
    const m = cameraLookAt([0, 0, 0], [0, 10, 0]);
    close(m[2], 0); close(m[5], 1); close(m[8], 0); // forward +y
    close(m[0], 1); close(m[7], -1); // right +x, down -z
  });

  it("letterbox: two bars of (1 - f)(H + 1)/2 + 1 pixels", () => {
    close(letterboxBarHeight(480, 0.7), 0.3 * 481 * 0.5 + 1, 1e-3);
    expect(letterboxBarHeight(480, 1)).toBe(0);
  });

  it("AnimTask records: waits hold the cursor, tick 0 applies the records before the first wait", () => {
    const records = decodeAnimData([4, 0, 0.5, 32, 3, 0, 1, 32, 2]);
    const p = newAnimPlayback();
    const seen: Array<[number, number]> = [];
    seekAnimPlayback(p, records, 0, (t, ch) => seen.push([t, ch[0]]));
    expect(seen).toEqual([[0, 0.5]]);
    for (let n = 1; n <= 5; n++) seekAnimPlayback(p, records, n, (t, ch) => seen.push([t, ch[0]]));
    // the first update re-sends nTick 0 (message carries the pre-increment tick)
    expect(seen.map((x) => x[0])).toEqual([0, 0, 1, 2, 3, 4]);
    expect(seen.map((x) => x[1])).toEqual([0.5, 0.5, 0.5, 1, 1, 1]);
  });

  it("train: thrust ramps by ThrustStep, speed = MaxSpeed * thrust * 37.926 units/tick", () => {
    const train: TrainTask = {
      id: 1, nodeIndex: 0, distance: 1000, originalThrust: 0.35, railroadTaskId: 1500, model: "", thrustStep: 0.002,
      maxSpeed: 200, flipDirection: true, displacement: [0, 0], playSound: "",
    };
    const ch = new Float32Array(34);
    ch[0] = -1;
    const s = trainAnimInput(train, { thrust: 0, targetThrust: 0, speed: 0, distance: 0 }, 0, ch);
    close(s.distance, 1000);
    trainAnimInput(train, s, 1, ch);
    close(s.speed, 200 * Math.fround(0.35) * 37.925926, 0.05);
    close(s.distance, 1000 - s.speed, 0.01);
    ch[0] = 0;
    trainAnimInput(train, s, 2, ch);
    close(s.thrust, 0.348, 1e-6);
  });

  it("door: sliding door opens in Open time * 30 (+1, chop mode) ticks with open/close/move events", () => {
    const door: DoorTask = {
      id: 7, nodeIndex: 0, start: [0, 0, 0], stopX: -1, stopY: 0, slider: 0, euler: [0, 0, 0], model: "", maxAngleDeg: 0,
      openTimeSeconds: 1, pickable: false, pickLockSeconds: 4, locked: "", open: "", close: "", openSound: "", closeSound: "", moveSound: "",
    };
    const s = newDoorState(door);
    s.wantOpen = true;
    let ticks = 0;
    let started = 0;
    for (; ticks < 40 && !s.isOpen; ticks++) if (stepDoor(door, s, () => null).startMoveSound) started++;
    // Chop mode: the float32 step 1/30 truncates, 30 steps stop just short of 1, tick 31 clamps.
    expect(ticks).toBe(31);
    expect(started).toBe(1);
    expect(doorPose(door, s).position[0]).toBeCloseTo(-4096, 2);
    s.wantOpen = false;
    let closeSound = false;
    for (let k = 0; k < 31; k++) closeSound ||= stepDoor(door, s, () => null).closeSound;
    expect(s.isClosed).toBe(true);
    expect(closeSound).toBe(true);
  });
});

describe.skipIf(!hasData)("level 1 mission runtime", () => {
  let tasks: MissionTasks;
  const load = async () => (tasks ??= readMissionTasks(await readRaw(OBJECTS)));

  it("inventory", async () => {
    const t = await load();
    expect(t.nodes.length).toBe(1362);
    expect(Object.keys(t.inventory).length).toBe(59);
    expect(t.inventory).toMatchObject({
      StatusMessage: 23, CutScene: 5, EditCamera: 48, AreaActivate: 8, Door: 23, EditVariable: 4, LevelTimer: 3,
      ConditionalContainer: 8, AnimTask: 8, ConditionalSound: 21, AmbientArea: 22, Switch: 6, Terminal: 3, SCamera: 5,
      SCameraControl: 2, AlarmControl: 1, ExplodeObject: 6, Train: 23, Heli: 2, Car: 1, LevelFlow: 1, DefineComputerObjective: 1,
    });
    expect(t.player?.loadout.map((w) => w.id)).toEqual(["WEAPON_ID_BINOCULARS", "WEAPON_ID_MP5SD", "WEAPON_ID_GLOCK", "WEAPON_ID_KNIFE", "AMMO_ID_919"]);
    expect(t.levelFlow).toMatchObject({ complete: "CutScene_1204.isFinished\n", failed: "StatusMessage_1391.isSendt" });
    expect(t.objectives[0].objectives).toEqual([
      { index: 1, textResource: "M1_OBJ1", linkToPosition: 1120, complete: "EditVariable_105.nValue == 1", failed: "" },
    ]);
  });

  it("cut-scene timelines (float32 key sums and finish ticks)", async () => {
    const t = await load();
    const byId = new Map(t.cutScenes.map((c) => [c.id, c]));
    const totals = [1200, 1201, 1202, 1203, 1204].map((id) => byId.get(id)!.totalSeconds);
    [18.6, 2.2, 71.066, 5.4, 25].forEach((v, k) => close(totals[k], v, 1e-3));
    expect([1200, 1201, 1202, 1203, 1204].map((id) => cutSceneFinishTick(byId.get(id)!))).toEqual([559, 67, 2132, 163, 751]);
    const c1200 = byId.get(1200)!;
    expect(c1200.keys.map((k) => k.start)).toEqual([0, 6, 9, 11.5, 11.5, 16, 16].map(Math.fround));
    const s0 = sampleCutSceneCamera(c1200, 0)!;
    expect(s0.keyIndex).toBe(0);
    expect(s0.position).toEqual(c1200.keys[0].position);
    expect(s0.link).toEqual({ taskId: 1502, update: true });
    close(s0.viewportFactor, 0.7);
    // zero-duration keys only end a segment: at 11.5 s the current key is 4, not 3
    expect(sampleCutSceneCamera(c1200, 345)!.keyIndex).toBe(4);
    // key 6 'Heli flyby' does not smooth: the camera holds its values, looking at the heli
    const hold = sampleCutSceneCamera(c1200, 500)!;
    expect(hold.keyIndex).toBe(6);
    expect(hold.position).toEqual(c1200.keys[6].position);
    expect(hold.target).toEqual({ taskId: 1502, update: true });
    expect(sampleCutSceneCamera(c1200, 558)!.finished).toBe(false);
    expect(sampleCutSceneCamera(c1200, 559)!.finished).toBe(true);
    const c1202 = byId.get(1202)!;
    expect(c1202.keys.filter((k) => k.filterName === "CAMERAFILTER_TYPE_HANDICAM").length).toBe(11);
  });

  /** Run the level with a scripted host; returns the event log. */
  const run = (t: MissionTasks, script: (tick: number, rt: MissionRuntime) => void, until: (rt: MissionRuntime) => boolean,
    extra: Partial<MissionHost> = {}) => {
    const log: string[] = [];
    let rt!: MissionRuntime;
    const at = () => rt.levelTick + 1;
    const host: MissionHost = {
      onStatusMessage: (m) => log.push(`${at()} msg ${m.text}`),
      onContainerWorld: (c, w) => log.push(`${at()} cc ${c.id} ${w ? "add" : "remove"}`),
      onCutSceneCamera: (s) => { if (s.nTick === 0) log.push(`${at()} cut ${s.cutSceneId} start`); if (s.finished) log.push(`${at()} cut ${s.cutSceneId} finished`); },
      call: (n, a) => { log.push(`${at()} call ${n}(${a.join(",")})`); },
      onSound: (s, on) => { if (on) log.push(`${at()} snd ${s.soundDef}`); },
      ...extra,
    };
    rt = new MissionRuntime(t, host);
    for (let k = 0; k < 6000 && !until(rt); k++) {
      script(rt.levelTick + 1, rt);
      rt.tick();
    }
    return { log, rt };
  };

  it("intro: cut-scene chain, subtitles, voice-over, hand-over to gameplay", async () => {
    const t = await load();
    const { log, rt } = run(t, () => {}, (r) => r.levelTick >= 2930);
    const has = (line: string) => expect(log).toContain(line);
    for (const l of ["1 cut 1200 start", "1 snd _cut01_01", "1 call MenuManager_SetEnabled(0)", "1 cc 1495 remove",
      "2 cc 4002 add", "560 cut 1200 finished", "560 cut 1201 start", "627 cut 1201 finished", "627 cut 1202 start",
      "2759 cut 1202 finished", "2759 cut 1203 start", "2922 cut 1203 finished", "2923 call MenuManager_SetEnabled(1)",
      "2923 cc 1495 add", "2923 call StatusMessageScreen_ClearMessages()", "2924 cc 1497 add", "2924 cc 4001 remove"]) has(l);
    const subtitles = log.filter((l) => l.includes("msg M1_CUT")).map((l) => Number(l.split(" ")[0]));
    // 24.7 / 59.8 x GAME_FREQUENCY are chop-mode FMULs (740.999.., 1793.999..): sent on ticks 741 / 1794.
    expect(subtitles).toEqual([2, 361, 481, 741, 811, 931, 991, 1261, 1591, 1666, 1711, 1794, 1981, 2251, 2326, 2611]);
    expect(rt.member("ConditionalContainer_4001.isRun")).toBe(0);
    expect(rt.member("ConditionalContainer_1495.isRun")).toBe(1);
  });

  it("Esc skips the intro on the same tick", async () => {
    const t = await load();
    let esc = false;
    const { log } = run(t, (tick) => { esc = tick === 101; }, (r) => r.levelTick >= 110, { escapePressed: () => esc });
    expect(log).toContain("101 call MenuManager_SetEnabled(1)");
    expect(log).toContain("101 cc 1495 add");
    expect(log).toContain("102 cc 4001 remove");
  });

  it("alarm: camera sighting -> 90 ticks -> SCameraControl -> AlarmControl -> radio message", async () => {
    const t = await load();
    let sight = false;
    const { log, rt } = run(t, (tick) => { sight = tick >= 3001 && tick < 3200; }, (r) => r.levelTick >= 3200,
      { cameraSighting: (c) => (sight && c.id === 1301 ? { key: "player", alert: false } : null) });
    expect(log).toContain("3092 snd alarmsystem_working");
    expect(log).toContain("3092 msg M1_MSG_5");
    expect(rt.member("AlarmControl_98.isAlarm")).toBe(1);
    expect(rt.member("EditVariable_97.nValue")).toBe(1);
  });

  it("truck reached: objective, outro cut-scene, gates, mission complete", async () => {
    const t = await load();
    let inTruckArea = false;
    const { log, rt } = run(t, (tick) => { inTruckArea = tick >= 3001; }, (r) => r.missionComplete, {
      humans: () => (inTruckArea ? [{ position: [24956964, -56099004, 174417760] as Vec3, team: 0 }] : []),
    });
    expect(log).toContain("3001 cut 1204 start");
    expect(log).toContain("3002 cc 1495 remove");
    expect(log).toContain("3752 cut 1204 finished");
    expect(rt.objectives[0]).toMatchObject({ textResource: "M1_OBJ1", complete: 1 });
    expect(rt.member("EditVariable_199.nValue")).toBe(1);
    expect(rt.member("Door_400.isOpen")).toBe(1);
    expect(rt.member("LevelFlow_10.isComplete")).toBe(1);
    expect(rt.levelTick).toBe(3752);
  });

  it("failure: player dead -> MISSION_FAILED sent and LevelFlow.isFailed on the same tick", async () => {
    const t = await load();
    let dead = false;
    const { log, rt } = run(t, (tick) => { dead = tick >= 3001; }, (r) => r.levelTick >= 3005, {
      value: (name) => (name === "HumanPlayer_0.isDead" ? Number(dead) : undefined),
    });
    expect(log).toContain("3001 msg MISSION_FAILED");
    expect(rt.member("LevelFlow_10.isFailed")).toBe(1);
    expect(rt.member("LevelFlow_10.isComplete")).toBe(0);
  });

  it("intro trains move from their AnimTask at 70 km/h", async () => {
    const t = await load();
    const { rt } = run(t, () => {}, (r) => r.levelTick >= 100);
    const train = t.trains.find((x) => x.id === 1501)!;
    const s = rt.trainStateAt(train.nodeIndex)!;
    close(s.speed, 200 * Math.fround(0.35) * 37.925926, 0.05);
    expect(s.distance).toBeLessThan(train.distance); // Flip Direction: distance decreases
  });
});
