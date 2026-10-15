/**
 * Security-camera vision and alarm light (docs/mission.md "SCamera vision",
 * "SCamera light"): the lens detector rules (cone, team lists, perception
 * schedule, target choice, tracking bearing), the light table and blink, and
 * level 1 with the real data: a camera sees the player, isDetection rises after
 * 90 ticks and the level script raises the alarm. Real-data checks are skipped
 * when the staged original files are absent.
 */
import { existsSync } from "node:fs";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { LEVEL1_PATHS, loadIgiLevel, type IgiLevel } from "../src/loaders";
import { igiPointToEngine } from "../src/loaders/coords";
import {
  SCAMERA_DETECTION_TICKS,
  SecurityCameraDetector,
  apply3,
  buildMissionTasks,
  eulerToMatrix,
  perceptionPhases,
  securityCameraBearing,
  securityCameraCone,
  securityCameraInViewCone,
  securityCameraLensMatrix,
  securityCameraLight,
  type CameraDetectable,
  type Mat3,
  type Vec3,
} from "../src/loaders/mission";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { loadDamageModelData, type DamageModelData } from "../src/loaders/damage-data";
import { LevelRng } from "../src/engine/ai/rng";
import type { Enemy, GameContext } from "../src/engine/context";
import { EventBus, GameEvent } from "../src/engine/events";
import { attachDamageSystem, createDamageSystem, damageModelNames } from "../src/engine/combat/object-damage";
import { buildWorld, type BuiltWorld } from "../src/engine/world/world-builder";
import { TERRAIN_HIT_MATERIAL, TRI_BULLET, TRI_SIGHT, TRI_SOLID, TRI_TERRAIN } from "../src/engine/world/collision";
import { dynamicTaskKeys } from "../src/engine/level";
import { createMissionSystem, type MissionSystem } from "../src/engine/mission/mission-system";
import { ALARM_LIGHT_SPRITE, alarmLightChannel, createAlarmLightRenderer } from "../src/engine/fx/alarm-lights";
import { loadEffectAssets } from "../src/engine/fx/effect-assets";
import { RAW_ROOT } from "./helpers";

const DEG = Math.fround(0.01745329238474369);
const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const at = (deg: number, r = 1000): Vec3 => [-Math.sin(deg * Math.PI / 180) * r, Math.cos(deg * Math.PI / 180) * r, 0];

describe("lens cone (FUN_00441290 tail, FUN_00487d80)", () => {
  it("halves the shorts as integers: 90 x 55 x 25 m -> 45 deg vertical, 27 deg horizontal, 102400 units", () => {
    const c = securityCameraCone({ viewconeAlphaDeg: 90, viewconeGammaDeg: 55, viewconeLengthMetres: 25 });
    expect(c.alpha).toBe(45 * DEG);
    expect(c.gamma).toBe(27 * DEG);
    expect(c.length).toBe(102400);
  });

  it("tests length (<=), |vertical| < alpha and |horizontal| < gamma in the eye matrix (columns right, forward, up)", () => {
    const c = securityCameraCone({ viewconeAlphaDeg: 90, viewconeGammaDeg: 55, viewconeLengthMetres: 25 });
    const o: Vec3 = [0, 0, 0];
    expect(securityCameraInViewCone(o, IDENTITY, [0, 102400, 0], c)).toBe(true);
    expect(securityCameraInViewCone(o, IDENTITY, [0, 102401, 0], c)).toBe(false);
    expect(securityCameraInViewCone(o, IDENTITY, at(26.9), c)).toBe(true);
    expect(securityCameraInViewCone(o, IDENTITY, at(-26.9), c)).toBe(true);
    expect(securityCameraInViewCone(o, IDENTITY, at(27.1), c)).toBe(false);
    // vertical: 44.9 deg up / down in, 45.1 out (alpha is vertical)
    const up = (deg: number): Vec3 => [0, Math.cos(deg * Math.PI / 180) * 1000, Math.sin(deg * Math.PI / 180) * 1000];
    expect(securityCameraInViewCone(o, IDENTITY, up(44.9), c)).toBe(true);
    expect(securityCameraInViewCone(o, IDENTITY, up(-44.9), c)).toBe(true);
    expect(securityCameraInViewCone(o, IDENTITY, up(45.1), c)).toBe(false);
    expect(securityCameraInViewCone(o, IDENTITY, [0, -1000, 0], c)).toBe(false);
    // the frame is the lens matrix: Rz(90 deg) turns the view to -x
    const r = eulerToMatrix(0, 0, Math.PI / 2);
    expect(securityCameraInViewCone(o, r, [-1000, 0, 0], c)).toBe(true);
    expect(securityCameraInViewCone(o, r, [0, 1000, 0], c)).toBe(false);
  });

  it("bearing (FUN_00486950 from the lens origin): positive to the left, the side the sweep yaw grows", () => {
    expect(securityCameraBearing([0, 0, 0], IDENTITY, at(30))).toBeCloseTo(30 * Math.PI / 180, 12);
    expect(securityCameraBearing([0, 0, 0], IDENTITY, at(-10))).toBeCloseTo(-10 * Math.PI / 180, 12);
    // the vertical offset is ignored (z zeroed before the angle)
    expect(securityCameraBearing([0, 0, 0], IDENTITY, [-1000, 1000, 5000])).toBeCloseTo(Math.PI / 4, 12);
    // Rz(gamma) with gamma = the yaw: a target at the yaw's own bearing is straight ahead
    const r = eulerToMatrix(0, 0, 0.3);
    expect(securityCameraBearing([0, 0, 0], r, apply3(r, [0, 1000, 0]))).toBeCloseTo(0, 12);
  });
});

describe("lens detector (FUN_00487b70 / FUN_00487cf0 / FUN_00440db0 head)", () => {
  const human = (key: string, team: number, alive = true, inWorld = true): CameraDetectable => ({ key, kind: "human", node: 100, team, alive, inWorld, point: [0, 0, 0] });
  const camera = (node: number, exploded: boolean): CameraDetectable => ({ key: `c${node}`, kind: "scamera", node, team: 1, alive: !exploded, inWorld: true, point: [0, 0, 0] });

  it("team rule (team 1, flags 6): other team alive -> +0x1a0, team 1 dead -> +0x1ac, own holder and out-of-world skipped", () => {
    const L = SecurityCameraDetector.listOf;
    expect(L(human("player", 0), 5)).toBe(0);
    expect(L(human("player", 0, false), 5)).toBeNull();
    expect(L(human("soldier", 1), 5)).toBeNull();
    expect(L(human("body", 1, false), 5)).toBe(1);
    expect(L(human("away", 0, true, false), 5)).toBeNull();
    expect(L(camera(6, false), 5)).toBeNull(); // another camera, intact: team 1 alive
    expect(L(camera(6, true), 5)).toBe(1); // destroyed: team 1 "dead"
    expect(L(camera(5, true), 5)).toBeNull(); // its own holder
  });

  it("runs on its phase only; cone every 2nd run (8 ticks), sight ray every 3rd run (12 ticks) while in the cone", () => {
    const d = new SecurityCameraDetector(2);
    const cones: number[] = [];
    const rays: number[] = [];
    for (let tick = 0; tick < 50; tick++) {
      d.perceive(tick, 5, [human("player", 0)], () => (cones.push(tick), true), () => (rays.push(tick), true));
    }
    expect(cones).toEqual([2, 10, 18, 26, 34, 42]);
    expect(rays).toEqual([2, 14, 26, 38]);
    expect(d.target()).toEqual({ key: "player", alert: false });
  });

  it("a failed cone test clears 'visible' at once; leaving the world drops the slot", () => {
    const d = new SecurityCameraDetector(0);
    let inCone = true;
    let present = true;
    const objs = () => [human("player", 0, true, present)];
    d.perceive(0, 5, objs(), () => inCone, () => true);
    expect(d.target()?.key).toBe("player");
    inCone = false;
    d.perceive(4, 5, objs(), () => inCone, () => true); // no cone test this run (every 2nd)
    expect(d.target()?.key).toBe("player");
    d.perceive(8, 5, objs(), () => inCone, () => true);
    expect(d.target()).toBeNull();
    inCone = true;
    present = false;
    d.perceive(12, 5, objs(), () => inCone, () => true);
    expect(d.slots.size).toBe(0);
    expect(d.lists).toEqual([[], []]);
  });

  it("target: the first visible of +0x1ac (alert) unless one of +0x1a0 is visible; lists keep AddTail order", () => {
    const d = new SecurityCameraDetector(0);
    const vis = new Set(["b1", "b2"]);
    const objs = [human("b1", 1, false), human("b2", 1, false), human("p", 0)];
    d.perceive(0, 5, objs, () => true, (o) => vis.has(String(o.key)));
    expect(d.lists).toEqual([["p"], ["b1", "b2"]]);
    expect(d.target()).toEqual({ key: "b1", alert: true });
    vis.add("p");
    d.perceive(4, 5, objs, () => true, (o) => vis.has(String(o.key))); // no ray this run
    expect(d.target()).toEqual({ key: "b1", alert: true });
    d.perceive(8, 5, objs, () => true, (o) => vis.has(String(o.key)));
    expect(d.target()).toEqual({ key: "b1", alert: true }); // ray every 3rd run: still the old verdicts
    d.perceive(12, 5, objs, () => true, (o) => vis.has(String(o.key)));
    expect(d.target()).toEqual({ key: "p", alert: false });
  });
});

describe("alarm light table (LAB_00441c50)", () => {
  it("idle green blinks big / dim, counting or detecting red blinks big / small, nothing while off", () => {
    expect(securityCameraLight({ isOn: 0, lightPhase: 1 })).toBeNull();
    expect(securityCameraLight({ isOn: 1, lightPhase: 1 })).toEqual({ rgb: [0, 128, 0], halfSize: 819.2 });
    expect(securityCameraLight({ isOn: 1, lightPhase: 0 })).toEqual({ rgb: [0, 64, 0], halfSize: 307.2 });
    expect(securityCameraLight({ isOn: 1, nDetectionTime: 40, lightPhase: 1 })).toEqual({ rgb: [128, 0, 0], halfSize: 1433.6 });
    expect(securityCameraLight({ isOn: 1, isDetection: 1, lightPhase: 0 })).toEqual({ rgb: [128, 0, 0], halfSize: 512 });
  });
});

const haveLevel = existsSync(`${RAW_ROOT}/${LEVEL1_PATHS.objects}`);
const haveSprites = existsSync(`${RAW_ROOT}/common/sprites/sprites.res`);

describe.skipIf(!haveSprites)("alarm light quad (fx/alarm-lights.ts, TL flags 0x1040008)", () => {
  it("loads alarmlight.spr from common/sprites and draws a camera-facing additive square at the light", async () => {
    const assets = await loadEffectAssets(createFsAssetSource(RAW_ROOT), { weapons: new Map() }, []);
    const sprite = assets.sprites.get(ALARM_LIGHT_SPRITE)!;
    expect(sprite.frames).toHaveLength(1);
    expect([sprite.frames[0].width, sprite.frames[0].height]).toEqual([16, 16]);
    const r = createAlarmLightRenderer(sprite)!;
    const mesh = r.object as THREE.Mesh;
    const mat = mesh.material as THREE.ShaderMaterial;
    expect([mat.blending, mat.blendSrc, mat.blendDst]).toEqual([THREE.CustomBlending, THREE.SrcAlphaFactor, THREE.OneFactor]);
    expect([mat.depthTest, mat.depthWrite, mat.fog, mat.transparent]).toEqual([true, false, false, true]);
    expect(mat.fragmentShader).toContain("<= 10.0");
    const tex = mat.uniforms.map.value as THREE.DataTexture;
    expect([tex.magFilter, tex.minFilter, tex.wrapS, tex.generateMipmaps]).toEqual([THREE.LinearFilter, THREE.LinearFilter, THREE.ClampToEdgeWrapping, false]);
    // diffuse bytes trunc(c / 128 x 255): 128 -> 255, 64 -> 127
    expect(alarmLightChannel(128)).toBe(1);
    expect(alarmLightChannel(64)).toBe(127 / 255);
    expect(alarmLightChannel(0)).toBe(0);
    const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 1000);
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, -1);
    r.draw(camera, [{ position: [1, 2, -10], rgb: [128, 0, 0], halfSize: 0.35 }, { position: [0, 0, 10], rgb: [0, 128, 0], halfSize: 0.2 }]);
    expect(r.count).toBe(1); // the second light is behind the camera (depth <= 0)
    const pos = mesh.geometry.getAttribute("position");
    const tint = mesh.geometry.getAttribute("tint");
    const corners = [0, 1, 2, 3].map((k) => [pos.getX(k), pos.getY(k), pos.getZ(k)]);
    expect(corners).toEqual([[0.65, 2.35, -10], [1.35, 2.35, -10], [0.65, 1.65, -10], [1.35, 1.65, -10]].map((c) => c.map((v) => expect.closeTo(v, 6))));
    expect([tint.getX(0), tint.getY(0), tint.getZ(0)]).toEqual([1, 0, 0]);
    r.dispose();
  });
});

describe.skipIf(!haveLevel)("level-1 security camera vision", () => {
  let level: IgiLevel;
  let world: BuiltWorld;
  let data: DamageModelData;

  beforeAll(async () => {
    const raw = createFsAssetSource(RAW_ROOT);
    level = await loadIgiLevel(raw);
    world = buildWorld(
      level,
      (b) => b.addIndexed(level.terrain.detail.positions, level.terrain.detail.indices, TRI_SOLID | TRI_BULLET | TRI_SIGHT | TRI_TERRAIN, TERRAIN_HIT_MATERIAL),
      { dynamicTasks: dynamicTaskKeys(level) },
    );
    const names = damageModelNames(level);
    data = await loadDamageModelData(raw, names.bounds, names.build, (key) => level.textures.has(key));
  }, 240_000);

  const node = (id: number) => level.tasks.findIndex((t) => t.type === "SCamera" && t.id === id);
  /** An engine point more than 60 m from every camera. */
  const FAR_AWAY: Vec3 = [200, 0, 300];

  it("perception phases: the five lenses take 0, 1, 2, 3, 0 at create, then the compile pass (vehicles, HumanAIs) continues", () => {
    const tasks = buildMissionTasks(level.taskRoots);
    const { phases, next } = perceptionPhases(tasks, 0);
    expect([1301, 1302, 1303, 1304, 1305].map((id) => phases.get(node(id)))).toEqual([0, 1, 2, 3, 0]);
    const order = tasks.nodes.filter((n) => phases.has(n.index) && n.type !== "SCamera").map((n) => `${n.type}_${n.id}:${phases.get(n.index)}`);
    expect(order.slice(0, 5)).toEqual(["Car_1099:1", "Heli_1502:2", "HumanAI_1506:3", "Heli_1508:0", "HumanAI_2022:1"]);
    expect(next).toBe((5 + order.length) & 3);
    // a restarted mission continues the process-wide counter
    expect(perceptionPhases(tasks, next).phases.get(node(1301))).toBe(next);
  });

  /** A context with the player in it, the built world and the damage data (magic vertices). */
  function setup() {
    const events = new EventBus();
    const messages: Array<{ tick: number; text: string }> = [];
    const ctx = {
      world: world.collision,
      level,
      tick: 0,
      events,
      rng: new LevelRng(),
      scene: new THREE.Scene(),
      input: { isDown: () => false },
      player: { position: [0, 0, 0] as Vec3, crouching: false, eyeHeight: 1.62, alive: true },
      enemies: [] as Enemy[],
      systems: { enemies: null, audio: null },
    } as unknown as GameContext;
    events.on(GameEvent.StatusMessage, (p) => messages.push({ tick: ctx.tick, text: String((p as { text: string }).text) }));
    const damage = createDamageSystem(ctx, { fx: false });
    damage.attach(level, world, data);
    attachDamageSystem(ctx, damage);
    const mission = createMissionSystem(ctx);
    mission.start(level);
    mission.attachWorld(world);
    const step = () => {
      mission.beginTick();
      mission.tick();
      ctx.tick++;
    };
    // Esc through the intro (game.ts skipIntro): the player enters the world.
    for (let i = 0; i < 4000 && (i < 2 || !(mission.playerInWorld && !mission.cutscene)); i++) {
      mission.requestBreak();
      step();
    }
    expect(mission.playerInWorld).toBe(true);
    return { ctx, mission, step, messages };
  }

  /** Engine point `metres` in front of a camera's eye (horizontal view direction), on the ground. */
  function inFront(mission: MissionSystem, id: number, metres: number, side = 0): Vec3 {
    const t = level.tasks[node(id)];
    const s = mission.runtime!.nodeState(node(id));
    const r = securityCameraLensMatrix(t.params["Holder Gamma"] as number, t.params["Camera Gamma"] as number, s.yaw, s.pitch);
    const lens = level.instances.find((i) => i.part === "scameraLens" && i.taskIndex === node(id))!;
    const f = new THREE.Vector3(r[1], 0, -r[4]).normalize(); // IGI forward (x, y) -> engine (x, -z)
    const sideways = new THREE.Vector3(-f.z, 0, f.x);
    const p = new THREE.Vector3(lens.matrix[12], 0, lens.matrix[14]).addScaledVector(f, metres).addScaledVector(sideways, side);
    const hit = world.collision.raycast(p.x, 20, p.z, 0, -1, 0, 40, TRI_SOLID);
    return [p.x, hit ? hit.point[1] : 0, p.z];
  }

  it("camera 1304 sees the player in front of it: 90 ticks of sighting -> isDetection -> SCameraControl_90 -> alarm", () => {
    const { ctx, mission, step, messages } = setup();
    const rt = mission.runtime!;
    const n1304 = node(1304);
    expect(rt.nodeState(n1304).isOn).toBe(1);
    expect(mission.cameraDetector(n1304)!.phase).toBe(3);
    // stand 8 m in front of the camera
    ctx.player.position = inFront(mission, 1304, 8);
    let first = -1;
    let detection = -1;
    for (let k = 0; k < 200 && detection < 0; k++) {
      const tick = ctx.tick;
      step();
      if (first < 0 && rt.nodeState(n1304).nDetectionTime > 0) first = tick;
      if (rt.member("SCamera_1304.isDetection")) detection = tick;
    }
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first & 3).toBe(3); // the lens perceives on its phase ticks
    expect(detection - first).toBe(SCAMERA_DETECTION_TICKS - 1); // 90 ticks of continuous sighting, inclusive
    // SCameraControl_90 is after the SCameras in the tree: same tick
    expect(rt.member("SCameraControl_90.isDetection")).toBe(1);
    const alarmTick = detection + 2;
    while (ctx.tick <= alarmTick) step();
    expect(rt.member("AlarmControl_98.isAlarm")).toBe(1);
    expect(rt.member("EditVariable_97.nValue")).toBe(1);
    expect(messages.some((m) => m.tick === alarmTick)).toBe(true);
    // the other cameras did not see the player
    for (const id of [1301, 1302, 1303, 1305]) expect(rt.nodeState(node(id)).nDetectionTime).toBe(0);
  });

  /** Camera eye (IGI) and lens matrix as the vision uses them (the lens matrix of the last update). */
  function eyeOf(mission: MissionSystem, id: number): { eye: Vec3; r: Mat3 } {
    const t = level.tasks[node(id)];
    const s = mission.runtime!.nodeState(node(id));
    const r = securityCameraLensMatrix(t.params["Holder Gamma"] as number, t.params["Camera Gamma"] as number, s.rotYaw, s.rotPitch);
    const lens = level.instances.find((i) => i.part === "scameraLens" && i.taskIndex === node(id))!;
    const o = level.originIgi;
    const pivot: Vec3 = [o[0] + lens.matrix[12] * 4096, o[1] - lens.matrix[14] * 4096, o[2] + lens.matrix[13] * 4096];
    const e = apply3(r, data.bounds.get("313_02_1")!.magic[1] as Vec3);
    return { eye: [pivot[0] + e[0], pivot[1] + e[1], pivot[2] + e[2]], r };
  }
  const toIgi = (p: Vec3): Vec3 => [level.originIgi[0] + p[0] * 4096, level.originIgi[1] - p[2] * 4096, level.originIgi[2] + p[1] * 4096];

  it("the sight ray: in the cone but behind 319_04_1 (20 m out, 4 m aside) camera 1304 does not see the player", () => {
    const { ctx, mission, step } = setup();
    const rt = mission.runtime!;
    const feet = inFront(mission, 1304, 20, 4);
    ctx.player.position = feet;
    const { eye, r } = eyeOf(mission, 1304);
    const t = level.tasks[node(1304)];
    const cone = securityCameraCone({ viewconeAlphaDeg: t.params["Viewcone Alpha (d)"] as number, viewconeGammaDeg: t.params["Viewcone Gamma (d)"] as number, viewconeLengthMetres: t.params["Viewcone length (m)"] as number });
    expect(securityCameraInViewCone(eye, r, toIgi([feet[0], feet[1] + 1.62, feet[2]]), cone)).toBe(true);
    for (let k = 0; k < 150; k++) step();
    const slot = mission.cameraDetector(node(1304))!.slots.get("player")!;
    expect(slot.inCone).toBe(true);
    expect(slot.visible).toBe(false);
    expect(rt.nodeState(node(1304)).nDetectionTime).toBe(0);
    expect(rt.member("SCamera_1304.isDetection")).toBe(0);
    // behind the camera: out of the cone
    ctx.player.position = inFront(mission, 1304, -6);
    for (let k = 0; k < 20; k++) step();
    expect(mission.cameraDetector(node(1304))!.slots.get("player")!.inCone).toBe(false);
  });

  it("a destroyed camera is a team-1 'dead' object: camera 1301's sweep finds holder 1304 and alerts at once", () => {
    const { ctx, mission, step } = setup();
    const rt = mission.runtime!;
    ctx.player.position = FAR_AWAY; // out of every camera's 25 m
    (rt.nodeState(node(1304)) as Record<string, number>).isExploded = 1;
    let detection = -1;
    for (let k = 0; k < 2400 && detection < 0; k++) {
      const tick = ctx.tick;
      step();
      if (rt.member("SCamera_1301.isDetection")) detection = tick;
    }
    expect(detection).toBeGreaterThanOrEqual(0);
    expect(detection & 3).toBe(0); // 1301's phase
    expect(mission.cameraDetector(node(1301))!.target()).toEqual({ key: `scamera:${node(1304)}`, alert: true });
    expect(rt.member("SCameraControl_90.isDetection")).toBe(1);
  });

  it("with node ticks (humans ticked at their tree place, after the SCameras) the lens reads the humans live", () => {
    const { ctx, mission } = setup();
    const rt = mission.runtime!;
    const seen: string[] = [];
    mission.setNodeTick((type) => seen.push(type));
    ctx.player.position = inFront(mission, 1304, 8);
    while ((ctx.tick & 3) !== 3) {
      mission.tick();
      ctx.tick++;
    }
    mission.tick(); // the phase-3 tick: no beginTick, the player is read where it stands now
    ctx.tick++;
    mission.setNodeTick(null);
    expect(seen).toContain("HumanPlayer");
    expect(rt.nodeState(node(1304)).nDetectionTime).toBe(SCAMERA_DETECTION_TICKS - 1);
  });

  it("a team-1 body in view raises isDetection at once (list +0x1ac, no 3 s delay)", () => {
    const { ctx, mission, step } = setup();
    const rt = mission.runtime!;
    ctx.player.position = FAR_AWAY; // out of every camera's 25 m
    const soldier = level.soldiers.find((s) => s.team === 1 && s.taskId >= 0 && mission.inWorld!(s.taskId))!;
    const body = { id: 900, taskId: soldier.taskId, position: inFront(mission, 1304, 7, 1), alive: false } as unknown as Enemy;
    ctx.enemies.push(body);
    let detection = -1;
    for (let k = 0; k < 20 && detection < 0; k++) {
      const tick = ctx.tick;
      step();
      if (rt.member("SCamera_1304.isDetection")) detection = tick;
    }
    expect(detection).toBeGreaterThanOrEqual(0);
    expect(detection & 3).toBe(3);
    expect(mission.cameraDetector(node(1304))!.target()).toEqual({ key: "soldier:900", alert: true });
  });

  it("alarm light: one quad per switched-on lens at magic vertex 0, green blink, red while counting", () => {
    const { ctx, mission, step } = setup();
    const rt = mission.runtime!;
    const lights = mission.securityCameraLights();
    expect(lights).toHaveLength(5);
    const n = node(1304);
    const t = level.tasks[n];
    const s = rt.nodeState(n);
    const lens = level.instances.find((i) => i.part === "scameraLens" && i.taskIndex === n)!;
    const r = securityCameraLensMatrix(t.params["Holder Gamma"] as number, t.params["Camera Gamma"] as number, s.yaw, s.pitch);
    const m0 = data.bounds.get("313_02_1")!.magic[0];
    const o = apply3(r, m0 as Vec3);
    // lens origin (the pivot) + R x magic vertex 0, IGI (x, y, z) -> engine (x, z, -y)
    const want = new THREE.Vector3(lens.matrix[12] + o[0] / 4096, lens.matrix[13] + o[2] / 4096, lens.matrix[14] - o[1] / 4096);
    const l = lights[[1301, 1302, 1303, 1304, 1305].indexOf(1304)];
    expect(new THREE.Vector3(...l.position).distanceTo(want)).toBeLessThan(1e-6);
    const pivotIgi = toIgi([lens.matrix[12], lens.matrix[13], lens.matrix[14]]);
    expect(new THREE.Vector3(...igiPointToEngine([pivotIgi[0] + o[0], pivotIgi[1] + o[1], pivotIgi[2] + o[2]], level.originIgi)).distanceTo(want)).toBeLessThan(1e-6);
    // idle: green, (0, 128, 0) at 0.2 m or (0, 64, 0) at 0.075 m
    expect([JSON.stringify([[0, 128, 0], 0.2]), JSON.stringify([[0, 64, 0], 0.075])]).toContain(JSON.stringify([l.rgb, l.halfSize]));
    // the blink toggles every 8 ticks
    const phases: number[] = [];
    for (let k = 0; k < 24; k++) {
      step();
      phases.push(rt.nodeState(n).lightPhase);
    }
    const flips = phases.map((p, i) => (i > 0 && p !== phases[i - 1] ? i : -1)).filter((i) => i > 0);
    expect(flips.length).toBeGreaterThanOrEqual(2);
    expect(flips[1] - flips[0]).toBe(8);
    // counting: red
    ctx.player.position = inFront(mission, 1304, 8);
    for (let k = 0; k < 12; k++) step();
    expect(rt.nodeState(n).nDetectionTime).toBeGreaterThan(0);
    const red = mission.securityCameraLights()[3];
    expect(red.rgb).toEqual([128, 0, 0]);
    expect([0.35, 0.125]).toContain(red.halfSize);
  });
});
