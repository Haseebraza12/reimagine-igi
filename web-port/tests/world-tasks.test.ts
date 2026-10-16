/**
 * World task types of missions 3-14 (synthetic inputs): RotatingObject,
 * AlarmLight + reflector glow, Siren, RainEffect (the Rain object's step,
 * trace, cull and cell rules), CubeModifier (inert). Recovered rules in
 * src/loaders/objects/*.ts and src/engine/fx/rain.ts (full exe addresses).
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  ALARM_LIGHT_EXPLOSION,
  ALARM_LIGHT_MODEL,
  ALARM_REFLECTOR_STEP,
  MissionRuntime,
  alarmGlowRed,
  alarmLightDestroy,
  alarmLightUpdate,
  alarmReflectorUpdate,
  buildMissionTasks,
  rainEffectParams,
  rotatingObjectCompile,
  rotatingObjectMatrix,
  rotatingObjectParams,
  rotatingObjectUpdate,
  sirenSounds,
  type IgiTask,
  type MissionHost,
} from "../src/loaders";
import { LevelRng } from "../src/engine/ai/rng";
import {
  RAIN,
  RainColumns,
  RainSim,
  rainBandBase,
  rainBatches,
  rainColour,
  rainGroups,
  rainLayerCount,
  type RainCamera,
} from "../src/engine/fx/rain";
import { createAlarmLightRenderer } from "../src/engine/fx/alarm-lights";
import { sameModelContent } from "../src/engine/world/world-tasks";
import { missionRuntimeBridge } from "../src/engine/combat/object-damage";
import type { LevelModel } from "../src/loaders";

const task = (type: string, id: number, params: IgiTask["params"] = {}, children: IgiTask[] = []): IgiTask => ({ type, id, name: "", params, children });
const timer = (id: number) => task("LevelTimer", id, { "Initial run": true, On: "", Reset: "" });
const dish = (extra: IgiTask["params"] = {}) =>
  task("RotatingObject", -1, {
    Position: [0, 0, 0], Orientation: [0, 0, 0], Model: "436_02_1", "Rotate sound": "",
    "Degrees per second X-axis": 0, "Degrees per second Y-axis": 0, "Degrees per second Z-axis": 90,
    "Acceleration, degrees per second X-axis": 0, "Acceleration, degrees per second Y-axis": 0, "Acceleration, degrees per second Z-axis": 1,
    Destructable: false, "On expression": "1", ...extra,
  });

describe("RotatingObject (FUN_00439090 / FUN_004395d0, full exe)", () => {
  it("starts at full speed, turns speed / 30 per tick and wraps only upwards at 360", () => {
    const p = rotatingObjectParams(dish());
    const s: Record<string, number> = { destroyed: 0 };
    rotatingObjectCompile(s, p);
    expect([s.cz, s.tz, s.az]).toEqual([90, 90, 0]);
    for (let i = 0; i < 30; i++) rotatingObjectUpdate(s, p, 1);
    expect(s.az).toBeCloseTo(90, 3);
    for (let i = 0; i < 91; i++) rotatingObjectUpdate(s, p, 1);
    // 121 ticks x 3 deg = 363 deg -> 3 deg after the wrap.
    expect(s.az).toBeGreaterThan(2.9);
    expect(s.az).toBeLessThan(3.1);
    const m = rotatingObjectMatrix({ ax: 0, ay: 0, az: 90 });
    expect(m[0]).toBeCloseTo(0, 6);
    expect(m[3]).toBeCloseTo(1, 6); // Rz(+90): x -> y
  });

  it("L5: On 0 zeroes the target but acceleration 0 keeps the speed (spins forever)", () => {
    const p = rotatingObjectParams(dish({ "Degrees per second Z-axis": 25, "Acceleration, degrees per second Z-axis": 0, "On expression": "0" }));
    const s: Record<string, number> = { destroyed: 0 };
    rotatingObjectCompile(s, p);
    for (let i = 0; i < 300; i++) rotatingObjectUpdate(s, p, 0);
    expect(s.tz).toBe(0);
    expect(s.cz).toBe(25);
    // Degrees per second X / Y are 0: the sound var is 0/0 = NaN (generator_run reads no var).
    expect(Number.isNaN(s.var0)).toBe(true);
  });

  it("L8: decelerates at 1 deg/s^2 once On is 0, stops after 25 s and never restarts", () => {
    const p = rotatingObjectParams(dish({ "Degrees per second Z-axis": 25, "Acceleration, degrees per second Z-axis": 1 }));
    const s: Record<string, number> = { destroyed: 0 };
    rotatingObjectCompile(s, p);
    rotatingObjectUpdate(s, p, 1);
    expect(s.cz).toBe(25);
    rotatingObjectUpdate(s, p, 0); // the press tick
    for (let i = 0; i < 29; i++) rotatingObjectUpdate(s, p, 1); // On back to 1: the target stays 0
    expect(s.tz).toBe(0);
    expect(s.cz).toBeCloseTo(24, 4);
    for (let i = 0; i < 730; i++) rotatingObjectUpdate(s, p, 1);
    expect(s.cz).toBe(0);
    const a = s.az;
    rotatingObjectUpdate(s, p, 1);
    expect(s.az).toBe(a);
  });

  it("the sound var is the clamped sum of the speed ratios; destroyed stops it (Destructable)", () => {
    const p = rotatingObjectParams(dish({ "Degrees per second X-axis": 10, "Degrees per second Y-axis": 10 }));
    const s: Record<string, number> = { destroyed: 0 };
    rotatingObjectCompile(s, p);
    rotatingObjectUpdate(s, p, null); // absent On: keeps the targets
    expect(s.var0).toBe(1); // 1 + 1 + 1 clamped
    s.destroyed = 1;
    rotatingObjectUpdate(s, p, null);
    expect([s.tx, s.ty, s.tz]).toEqual([0, 0, 0]);
    expect(rotatingObjectParams(task("RotatingObject", -1)).degreesPerSecond).toEqual([10, 10, 10]); // create defaults
  });

  it("runs in the task runtime from its node (On expression)", () => {
    const tasks = buildMissionTasks([timer(1), dish({ "On expression": "LevelTimer_1.nTick < 10" })]);
    const rt = new MissionRuntime(tasks);
    for (let i = 0; i < 40; i++) rt.tick();
    const s = rt.nodeState(1);
    expect(s.tz).toBe(0);
    // The timer updates first (nTick = k on tick k): On is 0 from tick 10, 31 ticks of deceleration.
    expect(s.cz).toBeCloseTo(90 - 31 / 30, 3);
  });

  it("a bullet on a Destructable dish (LAB_00439750, through the damage bridge) zeroes its targets", () => {
    const rt = new MissionRuntime(buildMissionTasks([dish({ Destructable: true })]));
    rt.tick();
    missionRuntimeBridge(rt).setRotatingObjectDestroyed!(0);
    rt.tick();
    expect([rt.nodeState(0).destroyed, rt.nodeState(0).tz]).toEqual([1, 0]);
    expect(rt.nodeState(0).cz).toBeCloseTo(90 - 1 / 30, 4);
  });
});

describe("AlarmLight and its reflector (FUN_0043a270 / FUN_00439b70 / FUN_00439f10, full exe)", () => {
  it("swaps to the OPPOSITE model field on each edge and starts the On sound a tick after isOn rises", () => {
    const s: Record<string, number> = { isOn: 0, isDestroyed: 0, model: ALARM_LIGHT_MODEL.off, sound: 0, theta: 0 };
    const seq = [0, 1, 1, 0, 0, 1];
    const models: number[] = [];
    const sounds: number[] = [];
    for (const on of seq) {
      alarmLightUpdate(s, on, "lamp_on");
      models.push(s.model);
      sounds.push(s.sound);
    }
    // rising -> +0x140 (Off model), falling -> +0x130 (On model).
    expect(models).toEqual([0, 0, 0, 1, 1, 0]);
    // the sound follows the previous isOn: on at the tick after the rise, off the tick after the fall.
    expect(sounds).toEqual([0, 0, 1, 1, 0, 0]);
    // An empty On sound never makes an instance (every shipped lamp).
    const t: Record<string, number> = { isOn: 1, isDestroyed: 0, model: 0, sound: 0, theta: 0 };
    alarmLightUpdate(t, 1, "");
    expect(t.sound).toBe(0);
  });

  it("the reflector turns pi/30 per tick only while the lamp is on and intact; destroy stops everything once", () => {
    const s: Record<string, number> = { isOn: 1, isDestroyed: 0, model: 0, sound: 1, theta: 0 };
    for (let i = 0; i < 30; i++) alarmReflectorUpdate(s);
    expect(s.theta).toBeCloseTo(Math.PI, 5);
    expect(ALARM_REFLECTOR_STEP).toBe(Math.fround(Math.PI / 30));
    s.isOn = 0;
    alarmReflectorUpdate(s);
    expect(s.theta).toBeCloseTo(Math.PI, 5);
    expect(alarmLightDestroy(s)).toBe(true);
    expect(alarmLightDestroy(s)).toBe(false);
    expect([s.isDestroyed, s.model]).toEqual([1, ALARM_LIGHT_MODEL.destroyed]);
    expect(alarmLightUpdate(s, 1, "x")).toBe(false); // destroyed: the expression is not read
    expect([s.isOn, s.sound]).toEqual([0, 0]);
    expect(ALARM_LIGHT_EXPLOSION).toMatchObject({ damage: Math.fround(0.05), radius: 4096, falloff: 0, scorch: 2048, fragments: 5, fireballs: 2, aiRange: 20480 });
  });

  it("glow red 128 |2 fmod(theta, pi)/pi - 1|: full every 30 ticks, dark in between", () => {
    expect(alarmGlowRed(0)).toBe(128);
    expect(alarmGlowRed(Math.PI / 2)).toBeCloseTo(0, 4);
    expect(alarmGlowRed(Math.fround(Math.PI / 4))).toBeCloseTo(64, 3);
    let theta = 0;
    for (let i = 0; i < 30; i++) theta = Math.fround(theta + ALARM_REFLECTOR_STEP);
    expect(alarmGlowRed(theta)).toBeGreaterThan(127);
  });

  it("runs in the task runtime: members for ids >= 0, children before the reflector, bridge destroy", () => {
    const lamp = task("AlarmLight", 1400, {
      Position: [0, 0, 0], Orientation: [0, 0, 0], "On expression": "LevelTimer_1.nTick >= 3 && LevelTimer_1.nTick < 6",
      "On model": "344_03_1", "Off model": "344_01_1", "Destroyde model": "", "On sound": "", "Explode sound": "explo_01_s",
    });
    const rt = new MissionRuntime(buildMissionTasks([timer(1), lamp]));
    const seen: Array<[number, number, number]> = [];
    for (let i = 0; i < 8; i++) {
      rt.tick();
      seen.push([rt.member("AlarmLight_1400.isOn")!, rt.nodeState(1).model, rt.nodeState(1).theta > 0 ? 1 : 0]);
    }
    expect(seen.map((x) => x[0])).toEqual([0, 0, 1, 1, 1, 0, 0, 0]);
    expect(seen.map((x) => x[1])).toEqual([0, 0, 0, 0, 0, 1, 1, 1]);
    expect(rt.nodeState(1).theta).toBeCloseTo(3 * ALARM_REFLECTOR_STEP, 5);
    const bridge = missionRuntimeBridge(rt);
    expect(bridge.destroyAlarmLight!(1)).toBe(true);
    expect(bridge.destroyAlarmLight!(1)).toBe(false);
    expect(rt.member("AlarmLight_1400.isDestroyed")).toBe(1);
    expect(rt.nodeState(1).model).toBe(ALARM_LIGHT_MODEL.destroyed);
  });

  it("the glow quad is drawn only from the lamp's +y side and in front of the camera", () => {
    const rgba = new Uint8Array(4 * 4 * 4).fill(255);
    const r = createAlarmLightRenderer({ frames: [{ width: 4, height: 4, rgba }] } as never)!;
    const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    const quad = (axis: [number, number, number]) => ({ position: [0, 0, 0] as [number, number, number], rgb: [128, 0, 0] as [number, number, number], halfSize: 1.5, facing: { origin: [0, 0, 0] as [number, number, number], axis } });
    r.draw(camera, [quad([0, 0, 1])]);
    expect(r.count).toBe(1);
    r.draw(camera, [quad([0, 0, -1])]);
    expect(r.count).toBe(0);
    r.dispose();
  });
});

describe("Siren (FUN_004494d0, full exe)", () => {
  it("Working while on and intact, Faulty while on and exploded, silent otherwise", () => {
    const s: Record<string, number> = { isOn: 0, isExploded: 0, working: 0, faulty: 0 };
    const step = (on: number, exploded: number, faulty = "alarmsystem_working") => {
      s.isOn = on;
      s.isExploded = exploded;
      sirenSounds(s, "alarmsystem_working", faulty);
      return [s.working, s.faulty];
    };
    expect(step(0, 0)).toEqual([0, 0]);
    expect(step(1, 0)).toEqual([1, 0]);
    expect(step(1, 1)).toEqual([0, 1]);
    expect(step(0, 1)).toEqual([0, 0]);
    expect(step(1, 1, "")).toEqual([0, 0]); // L7: "" falls silent
  });

  it("is an ExplodeObject in the runtime: countdown 0 explodes it and the alarm keeps running", () => {
    const siren = task("Siren", 93, {
      Position: [0, 0, 0], Orientation: [0, 0, 0], Model: "310_01_1", "Destroyed model": "", "Damage scale": 1,
      "Explosion radius": 0.5, "Explosion falloff radius": 0.5, "Explosion damage scale": 1, "Explosion delay": 0,
      "Explosion fragments": 5, "Explosion fireballs": 4, "Explosion expression": "", "Explosion sound": "explosion_1",
      "Working Sound": "alarmsystem_working", "Faulty Sound": "alarmsystem_working", "On Expression": "LevelTimer_1.nTick >= 2",
    });
    const exploded: string[] = [];
    const host: MissionHost = { onExplode: (id, type) => exploded.push(`${type}_${id}`) };
    const rt = new MissionRuntime(buildMissionTasks([timer(1), siren]), host);
    for (let i = 0; i < 3; i++) rt.tick();
    expect([rt.member("Siren_93.isOn"), rt.member("Siren_93.isLastOn"), rt.nodeState(1).working]).toEqual([1, 1, 1]);
    missionRuntimeBridge(rt).setCountdown(1, 0); // a bullet reached the damage limit
    rt.tick();
    expect(exploded).toEqual(["Siren_93"]);
    expect(rt.member("Siren_93.isExploded")).toBe(1);
    expect([rt.nodeState(1).working, rt.nodeState(1).faulty]).toEqual([0, 1]);
  });
});

describe("RainEffect / Rain object (FUN_00499cf0 ... FUN_00499430, full exe)", () => {
  it("colour = trunc(alpha x -255) x -0x1000000 + 0xFFFFFF: L3 0x21FFFFFF, L9 38, L10 34", () => {
    expect(rainColour(0.12999999523162842)).toBe(0x21ffffff);
    expect(rainColour(0.15000000596046448) >>> 24).toBe(38);
    expect(rainColour(0.13500000536441803) >>> 24).toBe(34);
    expect(rainColour(0.3125) >>> 24).toBe(79);
    expect(rainEffectParams(task("RainEffect", -1, {}))).toEqual({ isRain: true, traceStartM: 50, traceEndM: 20, alpha: 0.3125 });
  });

  it("rain fills 80 drops on its 13th tick (f32 307.2 is a hair above 2048 x 12 / 80) and fades in over 60; inactive it never starts", () => {
    const sim = new RainSim({ snow: false, alpha: 0.13, traceStartM: 50, traceEndM: 20 });
    expect([sim.traceStart, sim.traceLength]).toEqual([204800, 286720]);
    const rng = new LevelRng(0);
    sim.step(rng);
    expect(sim.count).toBe(0); // inactive: fade stays 0, nothing moves
    sim.active = 1;
    for (let i = 0; i < 12; i++) sim.step(rng);
    expect(sim.count).toBe(79);
    sim.step(rng);
    expect(sim.count).toBe(80);
    for (let i = 0; i < 60; i++) sim.step(rng);
    expect(sim.fade).toBe(1);
    // All drops fall 2048 per tick and stay in [0, H).
    for (let i = 0; i < 80; i++) {
      expect(sim.drops[i * 7 + 2]).toBeGreaterThanOrEqual(0);
      expect(sim.drops[i * 7 + 2]).toBeLessThan(RAIN.height);
    }
    sim.active = 0;
    for (let i = 0; i < 60; i++) sim.step(rng);
    expect(sim.fade).toBe(0);
    const z = sim.drops[2];
    sim.step(rng);
    expect(sim.drops[2]).toBe(z); // frozen at fade 0
  });

  it("snow takes 121 ticks to fill, drifts at most 0.5 m/s and wraps its tile, flipping the group", () => {
    const sim = new RainSim({ snow: true, alpha: 0.06, traceStartM: 50, traceEndM: 20 });
    sim.active = 1;
    const rng = new LevelRng(0);
    for (let i = 0; i < 120; i++) sim.step(rng);
    expect(sim.count).toBe(79);
    sim.step(rng);
    expect(sim.count).toBe(80);
    for (let i = 0; i < 400; i++) sim.step(rng);
    for (let i = 0; i < 80; i++) {
      const o = i * 7;
      expect(Math.abs(sim.drops[o + 4])).toBeLessThanOrEqual(RAIN.drift / 2);
      expect(sim.drops[o]).toBeGreaterThanOrEqual(0);
      expect(sim.drops[o]).toBeLessThanOrEqual(RAIN.tile);
      expect([0, 1, 2, 3]).toContain(sim.drops[o + 6]);
    }
  });

  it("the fill order starts at the highest of drops 0..n-2 and lists the NEXT drop's z (0x4992d5)", () => {
    const drops = new Float32Array(80 * 7);
    const set = (i: number, z: number, g: number) => {
      drops[i * 7 + 2] = z;
      drops[i * 7 + 6] = g;
    };
    set(0, 100, 0);
    set(1, 300, 1);
    set(2, 200, 0);
    set(3, 900, 0); // the last drop is never compared: the start is drop 1
    const groups = rainGroups({ drops, count: 4 });
    expect(groups[1].drops).toEqual([1]);
    expect(groups[1].z).toEqual([100]); // drop 0 follows drop 1
    expect(groups[0].drops).toEqual([0, 3, 2]);
    expect(groups[0].z).toEqual([900, 200, 300]);
    expect(rainLayerCount(groups[0], -1)).toBe(3);
    expect(rainLayerCount(groups[0], 25000)).toBe(0);
    expect(rainLayerCount(groups[0], 500)).toBe(1);
    expect(rainLayerCount(groups[0], 100)).toBe(3);
  });

  it("traces the 12 x 12 ring once, then only the columns the camera move brings in (budget)", () => {
    const cols = new RainColumns();
    const casts: Array<[number, number]> = [];
    const cast = (x: number, y: number) => {
      casts.push([x, y]);
      return 1000;
    };
    const cam: [number, number, number] = [5.5 * RAIN.tile, 5.5 * RAIN.tile, 50000];
    cols.trace(cam, 204800, 286720, cast);
    expect(casts.length).toBe(144);
    expect(cols.ix0).toBe(0);
    cols.trace(cam, 204800, 286720, cast);
    expect(cols.lastTraces).toBe(0);
    // One tile in x: ceil(1 x 12) = 12 traces for the new column row.
    cols.trace([cam[0] + RAIN.tile, cam[1], cam[2]], 204800, 286720, cast);
    expect(cols.lastTraces).toBe(12);
    expect(cols.ix0).toBe(1);
    // 1.1 tiles: budget ceil(13.2) = 14 >= the 12 new columns.
    cols.trace([cam[0] + 2.1 * RAIN.tile, cam[1], cam[2]], 204800, 286720, cast);
    expect(cols.lastTraces).toBe(12);
    // A small move across a column line: budget ceil(0.1 x 12) = 2 of the 12 needed; the rest
    // wait for later draws (cells touching them are not drawn meanwhile).
    const slow = new RainColumns();
    slow.trace([5.95 * RAIN.tile, cam[1], cam[2]], 204800, 286720, cast);
    slow.trace([6.05 * RAIN.tile, cam[1], cam[2]], 204800, 286720, cast);
    expect(slow.lastTraces).toBe(2);
    slow.trace([6.05 * RAIN.tile, cam[1], cam[2]], 204800, 286720, cast);
    expect(slow.lastTraces).toBe(0); // no move, no budget
    // A miss stores the previous hit of the pass (else camZ - Traceline end).
    const fresh = new RainColumns();
    fresh.trace(cam, 204800, 286720, () => null);
    expect(fresh.floor[0]).toBe(50000 - 81920);
  });

  it("culls cells against the frustum and draws each layer above the column floor only", () => {
    const cols = new RainColumns();
    const floorZ = 50000;
    const cam: [number, number, number] = [5.5 * RAIN.tile, 5.5 * RAIN.tile, floorZ + 1.7 * 4096];
    cols.trace(cam, 204800, 286720, () => floorZ);
    const view: RainCamera = { position: cam, right: [1, 0, 0], down: [0, 0, -1], forward: [0, 1, 0], sx: 1, sy: 4 / 3 };
    const bandBase = rainBandBase(cam[2]);
    expect(bandBase).toBe(Math.floor(cam[2] / RAIN.height - 1) * RAIN.height);
    const cells = cols.cull(view, bandBase);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThan(81);
    // Looking along +y: every queued cell reaches in front of the camera; sorted far to near.
    for (let k = 1; k < cells.length; k++) expect(cells[k - 1].key).toBeGreaterThanOrEqual(cells[k].key);
    const drops = new Float32Array(80 * 7);
    // As the step leaves them: newer drops (higher index) higher.
    for (let i = 0; i < 80; i++) {
      drops[i * 7 + 2] = ((i + 1) / 80) * RAIN.height - 1;
      drops[i * 7 + 6] = i % 4;
    }
    const groups = rainGroups({ drops, count: 80 });
    const batches = rainBatches(cols, cells, groups, bandBase);
    for (const b of batches) {
      // Nothing is drawn below the floor: layer bottom + listed z of the last drawn drop > floor.
      const top = b.origin[2] + RAIN.height;
      expect(top).toBeGreaterThan(floorZ);
    }
    // The layer holding the floor draws part of the group, the ones above all of it.
    const counts = new Set(batches.map((b) => b.count));
    expect(counts.size).toBeGreaterThan(1);
  });
});

describe("CubeModifier and model identity helpers", () => {
  it("CubeModifier is never updated (Static) and does nothing when it is (no update slot)", () => {
    const cube = task("CubeModifier", -1, { Position: [0, 0, 0], Level: 10, Expression: "VILLAGE" });
    const rt = new MissionRuntime(buildMissionTasks([task("Static", -1, {}, [cube]), task("Container", -1, {}, [{ ...cube }])]));
    rt.tick();
    expect(rt.nodeState(1)).toEqual({});
    expect(rt.nodeState(3)).toEqual({});
  });

  it("sameModelContent compares mesh, blocks and collision", () => {
    const mk = (tex: string): LevelModel => ({
      name: "a", modelType: 3, collision: null, positions: new Float32Array([0, 1, 2]), normals: new Float32Array(3), uv: new Float32Array(2),
      lightmapUv: null, indices: new Uint32Array([0, 0, 0]), groups: [{ start: 0, count: 3, texture: tex }],
    });
    expect(sameModelContent(mk("t"), { ...mk("t"), name: "b" })).toBe(true);
    expect(sameModelContent(mk("t"), mk("u"))).toBe(false);
    expect(sameModelContent(mk("t"), null)).toBe(false);
  });
});
