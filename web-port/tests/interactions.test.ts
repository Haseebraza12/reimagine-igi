/**
 * The player's use / Activate interactions, ladders, wires, fences and
 * pickups (src/engine/player/{use-objects,clip-track,attach,interact}.ts,
 * src/engine/combat/pickups.ts; docs/interactions.md). Real-data checks use
 * the staged original files and are skipped when they are absent.
 */
import { existsSync, readFileSync } from "node:fs";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import type { Vec3 } from "../src/contracts";
import { EventBus, GameEvent } from "../src/engine/events";
import type { GameContext } from "../src/engine/context";
import { AttachController, LADDER_SOUND_SEQUENCE, type AttachHost } from "../src/engine/player/attach";
import { ANIM_SPEED, ClipTrack } from "../src/engine/player/clip-track";
import {
  INTERACT_EVENTS,
  createInteractions,
  engineToIgi,
  igiRotationFromEngineMatrix,
  igiToEngine,
  interactionModels,
  loadModelInfo,
  type ModelInfo,
} from "../src/engine/player/interact";
import {
  LADDER_BOTTOM_HOLD,
  LADDER_TOP_HOLD,
  USE_ICON,
  USE_KIND,
  UseSearch,
  fenceMount,
  fenceUseTest,
  headingOf,
  ladderMount,
  ladderRungs,
  ladderUseTest,
  makeWire,
  panelUseTest,
  searchUseTarget,
  useIconOf,
  useKindOf,
  wireInRange,
  wireMount,
  worldPoint,
  type FenceTarget,
  type Ladder,
  type M3,
  type PanelTarget,
  type UseView,
  type V3,
  type Wire,
} from "../src/engine/player/use-objects";
import {
  DROP_GRAVITY,
  PICKUP_MIN_RADIUS,
  addCappedAmmo,
  createPickupSystem,
  dropFallStep,
  pickupRadius,
  pickupTouched,
  type PickupInventory,
} from "../src/engine/combat/pickups";
import { eulerToMatrix, loadIgiLevel, readAnimations, type AnimClip, type IgiLevel } from "../src/loaders";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { numberParam, stringParam, vec3Param } from "../src/loaders/tasks";
import { wireHoldPoint, wirePose } from "../src/loaders/wire";
import { RAW_ROOT } from "./helpers";

const haveRaw =
  existsSync(`${RAW_ROOT}/missions/location0/level1/objects.qvm`) &&
  existsSync(`${RAW_ROOT}/missions/location0/level1/models/level1.res`) &&
  existsSync(`${RAW_ROOT}/common/anims/000.iff`) &&
  existsSync(`${RAW_ROOT}/magicobj/magicobj.qvm`);

const norm = (v: readonly number[]): V3 => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
};
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** IGI view at `eye` looking at `target` (columns right, forward, up). */
function lookAt(eye: V3, target: readonly number[]): UseView {
  const f = norm([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
  const r = norm(cross(f, [0, 0, 1]));
  const u = cross(r, f);
  return { eye, axes: [r[0], f[0], u[0], r[1], f[1], u[1], r[2], f[2], u[2]] };
}
const add = (a: readonly number[], b: readonly number[]): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

// --- pure rules -------------------------------------------------------------------

describe("use search (FUN_004159d0) and kinds", () => {
  it("keeps the candidate with both angles smaller, within 2 m and in front", () => {
    const view = lookAt([0, 0, 0], [0, 1, 0]);
    const s = new UseSearch<string>(view);
    expect(s.consider([0, 9000, 0], "far")).toBe(false); // beyond 8192 units
    expect(s.consider([0, -1000, 0], "behind")).toBe(false);
    expect(s.consider([1000, 1000, 0], "45deg")).toBe(false); // horizontal angle pi/4 is not < pi/4
    expect(s.consider([500, 2000, 300], "a")).toBe(true);
    expect(s.consider([600, 2000, 0], "b")).toBe(false); // smaller vertical, larger horizontal
    expect(s.consider([100, 2000, 100], "c")).toBe(true);
    expect(s.winner).toBe("c");
    s.claim("ladder");
    expect(s.consider([0, 1000, 0], "dead ahead")).toBe(false); // strict <: nothing beats a claim
    expect(s.winner).toBe("ladder");
  });

  it("maps object kinds to the exe's use kinds and HUD icons", () => {
    expect(USE_KIND).toEqual({ SWITCH: 2, DOOR: 3, CABINET: 4, TERMINAL: 5, STATIONARY_GUN: 6, WIRE: 9, LADDER: 10, FENCE: 11, GENERIC_TBA: 12, PLACE_EXPLOSIVE_TBA: 13 });
    expect(USE_ICON.ladder).toBe("a_ladder.spr");
    expect(USE_ICON.doorLocked).toBe("action_picklock.spr");
  });
});

describe("clip track (FUN_004cb1f0 / FUN_004cb450)", () => {
  const clip: AnimClip = {
    id: 1, duration: 1000, seconds: 1000 / 4800, loop: true,
    translation: { times: new Float32Array([0, 1000]), values: new Float32Array([0, 0, 0, 0, 0, 1000]), c: new Float32Array(6), d: new Float32Array(6) },
    rotation: [], offset: 0,
    events: [{ trigger: 8, time: 0, values: [0, 0, 0] }, { trigger: 8, time: 500, values: [0, 0, 0] }],
  } as unknown as AnimClip;

  it("fires the start events once, then (t, t'] forward and [t', t) backward, wrapping a loop", () => {
    const t = new ClipTrack(clip);
    t.start(clip, 1);
    expect(t.advance().events.map((e) => e.time)).toEqual([0]); // just started: events at t = 0
    expect(t.time).toBe(ANIM_SPEED);
    t.advance(); // 320
    t.advance(); // 480
    expect(t.advance().events.map((e) => e.time)).toEqual([500]); // (480, 640]
    t.setSpeed(0);
    expect(t.advance().events).toEqual([]); // stopped at 640, not on an event
    t.setSpeed(-1);
    expect(t.advance().events.map((e) => e.time)).toEqual([500]); // [480, 640)
    expect(t.advance().events).toEqual([]); // [320, 480)
    t.advance(); // 160
    const wrap = t.advance(); // [0, 160), then t = 0 wraps to the duration
    expect(wrap.events.map((e) => e.time)).toEqual([0]);
    expect(wrap.finished).toBe(true);
    expect(t.time).toBe(1000);
    expect(t.advance().finished).toBe(false);
    expect(t.time).toBe(840);
  });

  it("plays a reversed one-shot from the end and raises finished at 0", () => {
    const t = new ClipTrack(clip);
    t.start(clip, 2);
    expect(t.time).toBe(1000);
    let finished = false;
    for (let i = 0; i < 10 && !finished; i++) finished = t.advance().finished;
    expect(finished).toBe(true);
    expect(t.time).toBe(0);
  });
});

describe("pickup rules (FUN_0046bdb0, FUN_0046ba20, FUN_0047b4c0)", () => {
  it("touches within the horizontal radius (min 0.7 m) and 1 m of height", () => {
    expect(pickupRadius(721.9)).toBe(PICKUP_MIN_RADIUS);
    expect(pickupRadius(4000)).toBe(4000);
    const p = { position: [0, 0, 0], radius: PICKUP_MIN_RADIUS };
    expect(pickupTouched(p, [2000, 2000, 3900])).toBe(true); // 2828 < 2867.2, dz 3900 < 4096
    expect(pickupTouched(p, [2100, 2000, 0])).toBe(false);
    expect(pickupTouched(p, [0, 0, 4096])).toBe(false);
  });

  it("caps ammo to [0, cap] only when the pool has a cap", () => {
    expect(addCappedAmmo(90, 32, 100)).toBe(100);
    expect(addCappedAmmo(10, -20, 100)).toBe(0);
    expect(addCappedAmmo(90, 32, undefined)).toBe(122);
    expect(addCappedAmmo(90, 32, -1)).toBe(122);
  });

  it("drops a gun with gravity, bounces x -0.5 and comes to rest", () => {
    const p = { position: [0, 0, 4096] as Vec3, rest: 409.6, speed: 0 };
    let bounces = 0;
    const zs: number[] = [];
    for (let i = 0; i < 60; i++) {
      dropFallStep(p, () => bounces++);
      zs.push(p.position[2]);
    }
    expect(zs[0]).toBe(4096); // z -= 0, then v = 44.6
    expect(zs[1]).toBeCloseTo(4096 - DROP_GRAVITY, 6);
    // Hits the rest height after 14 ticks at ~624 units/tick; the bounce (-312) is already below 409.6.
    expect(bounces).toBe(1);
    expect(p.speed).toBe(0);
    expect(p.position[2]).toBeCloseTo(409.6, 1);
  });
});

// --- real data ----------------------------------------------------------------------

describe.skipIf(!haveRaw)("interactions in level 1", () => {
  let level: IgiLevel;
  let models: Map<string, ModelInfo>;
  let clips: Map<number, AnimClip>;
  let ladders: Ladder[];
  const raw = createFsAssetSource(RAW_ROOT);

  beforeAll(async () => {
    level = await loadIgiLevel(raw);
    models = await loadModelInfo(raw, interactionModels(level));
    const b = readFileSync(`${RAW_ROOT}/common/anims/000.iff`);
    clips = readAnimations(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer).clips;
    ladders = level.instances
      .filter((i) => i.magicType === "TASKTYPE_LADDER")
      .map((i): Ladder => {
        const info = models.get(i.model)!;
        return {
          kind: "ladder", model: i.model, taskId: i.taskId, points: info.points, rungs: ladderRungs(info.points),
          position: engineToIgi(level, [i.matrix[12], i.matrix[13], i.matrix[14]]), rotation: igiRotationFromEngineMatrix(i.matrix),
        };
      });
  }, 120_000);

  const recorder = () => {
    const log: string[] = [];
    const host: AttachHost = {
      clip: (id) => clips.get(id) ?? null,
      soundAt: (n) => log.push(n),
      soundOnPlayer: (n) => log.push(n),
      loopOnPlayer: (n) => {
        log.push(`loop ${n}`);
        return { stop: () => log.push(`stop ${n}`) };
      },
      noise: (t) => log.push(`noise ${t}`),
    };
    return { log, host };
  };

  const wireTask = (id: number): Wire => {
    const t = level.tasks.find((x) => x.type === "Wire" && x.id === id)!;
    const info = models.get(stringParam(t, "Model")!)!;
    const model = { originRadius: info.radius, magicVertices: info.points };
    return makeWire(id, level.tasks.indexOf(t), wirePose(vec3Param(t, "Start position")!, vec3Param(t, "Stop position")!, model)!, model);
  };

  it("finds the six TASKTYPE_LADDER objects with their four model points and rung counts", () => {
    expect(ladders.map((l) => l.model)).toEqual(["400_18_1", "400_17_1", "435_02_1", "314_01_1", "417_02_1", "417_02_1"]);
    expect(ladders.map((l) => l.rungs)).toEqual([24, 20, 59, 38, 24, 24]);
    for (const l of ladders) {
      expect(l.points).toHaveLength(4);
      // p2 is the foot (z ~ 0), p3 the top hold base 2611 units under p1.
      expect(Math.abs(l.points[2][2])).toBeLessThan(10);
      expect(l.points[1][2] - l.points[3][2]).toBeCloseTo(2611.2, 0);
    }
  });

  it("claims a ladder from the bottom when facing it, and from the top through its top point", () => {
    const l = ladders[1]; // 400_17_1, identity rotation: climbers stand on its +y side
    expect(l.rotation.map((v) => Math.round(v) + 0)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const bottomEye = add(l.position, [0, 4000, 6500]);
    let s = new UseSearch<Ladder>(lookAt(bottomEye, add(bottomEye, [0, -1, 0])));
    expect(ladderUseTest(s, l, l)).toBe("bottom");
    expect(s.winner).toBe(l);
    // Facing away: no claim.
    s = new UseSearch<Ladder>(lookAt(bottomEye, add(bottomEye, [0, 1, 0])));
    expect(ladderUseTest(s, l, l)).toBe(null);
    // On the roof behind the ladder, looking at its top point.
    const p1 = worldPoint(l, 1);
    const topEye = add(p1, [0, -4000, 3000]);
    s = new UseSearch<Ladder>(lookAt(topEye, p1));
    expect(ladderUseTest(s, l, l)).toBe("top");
    const r = searchUseTarget(lookAt(topEye, p1), ladders);
    expect(r.target).toBe(l);
    expect(r.ladderSide).toBe("top");
    expect(useKindOf(l)).toBe(10);
    expect(useIconOf(l)).toBe("a_ladder.spr");
  });

  it("climbs a ladder rung by rung on its root motion and steps off at the top where the top mount starts", () => {
    const l = ladders[0]; // 400_18_1, 24 rungs
    const { log, host } = recorder();
    const a = new AttachController(host);
    a.attachLadder(l, "bottom");
    const mount = ladderMount(l, "bottom");
    expect(mount.heading).toBeCloseTo(headingOf(l.rotation) + Math.PI, 5);
    expect(mount.position[2] - worldPoint(l, 2)[2]).toBeCloseTo(LADDER_BOTTOM_HOLD[2], 3);
    let p = [...a.position] as V3;
    let detach: string | null = null;
    let ticks = 0;
    const rungAt: number[] = [];
    for (; ticks < 1000 && !detach; ticks++) {
      const r = a.tick({ up: true, down: false, activatePressed: false, grounded: false, dead: false }, p);
      detach = r.detach;
      p = add(p, r.root);
      if (rungAt[a.rung] === undefined) rungAt[a.rung] = ticks;
    }
    expect(detach).toBe("ground");
    // 18 rungs (24 - 6) at ~10.5 ticks each, then the 2.33 s exit clip.
    expect(rungAt[18]).toBeGreaterThan(180);
    expect(rungAt[18]).toBeLessThan(195);
    // The exit ends where the reversed top mount begins (within 5 cm).
    const top = ladderMount(l, "top").position;
    expect(Math.hypot(p[0] - top[0], p[1] - top[1], p[2] - top[2])).toBeLessThan(0.05 * 4096);
    expect(top[2] - worldPoint(l, 3)[2]).toBeCloseTo(LADDER_TOP_HOLD[2], 3);
    // Rung sounds follow the 0x536c70 sequence, each with an AI LADDER noise.
    const steps = log.filter((x) => x.startsWith("walk_ladder_"));
    expect(steps.slice(0, 12)).toEqual(LADDER_SOUND_SEQUENCE.map((n) => `walk_ladder_${n + 1}`));
    expect(log.filter((x) => x === "noise 14")).toHaveLength(steps.length);
  });

  it("mounts from the top, climbs down and steps off at rung 0", () => {
    const l = ladders[0];
    const { host } = recorder();
    const a = new AttachController(host);
    a.attachLadder(l, "top");
    expect(a.state).toBe("ladder-mount-top");
    let p = [...a.position] as V3;
    let detach: string | null = null;
    for (let i = 0; i < 2000 && !detach; i++) {
      const r = a.tick({ up: false, down: a.state === "ladder-climb", activatePressed: false, grounded: false, dead: false }, p);
      detach = r.detach;
      p = add(p, r.root);
    }
    expect(detach).toBe("ground");
    const bottom = ladderMount(l, "bottom").position;
    expect(Math.abs(p[2] - bottom[2])).toBeLessThan(0.3 * 4096);
  });

  it("slides down a ladder on Activate: gravity x 0.99 with collision, wire_slide_1 looping until grounded", () => {
    const l = ladders[0];
    const { log, host } = recorder();
    const a = new AttachController(host);
    a.attachLadder(l, "bottom");
    const p = [...a.position] as V3;
    a.tick({ up: false, down: false, activatePressed: true, grounded: false, dead: false }, p);
    expect(a.state).toBe("ladder-slide");
    expect(log).toContain("loop wire_slide_1");
    const r = a.tick({ up: false, down: false, activatePressed: false, grounded: false, dead: false }, p);
    expect(r.collide).toBe(true);
    expect(r.air[2]).toBeCloseTo(-44.600887 * 0.99, 3);
    expect(a.tick({ up: false, down: false, activatePressed: false, grounded: true, dead: false }, p).detach).toBe("ground");
    expect(log).toContain("stop wire_slide_1");
  });

  it("crosses wire 3500 hand over hand and slides wires 3501 / 3502 to their low end", () => {
    const w0 = wireTask(3500);
    const w1 = wireTask(3501);
    expect(w0.mode).toBe("traverse");
    expect(w1.mode).toBe("slide");
    // The candidate under the wire goes through FUN_004159d0.
    const below = add(w0.pose.position, [1024, 0, -4096]);
    const r = searchUseTarget(lookAt(below, w0.pose.position), [w0]);
    expect(r.target).toBe(w0);
    // Traverse mount = wire.ts's hold point; MoveUp steps 0.5 m along the facing.
    const pelvis = add(w0.pose.position, [0, 0, -6000]);
    const m = wireMount(w0, pelvis, "traverse");
    const ref = wireHoldPoint(w0.pose, w0.model, pelvis, "traverse");
    expect(Math.hypot(m.position[0] - ref[0], m.position[1] - ref[1], m.position[2] - ref[2])).toBeLessThan(1);
    const { log, host } = recorder();
    const a = new AttachController(host);
    a.attachWire(w0, pelvis);
    let p = [...a.position] as V3;
    for (let i = 0; i < 40; i++) p = add(p, a.tick({ up: true, down: false, activatePressed: false, grounded: false, dead: false }, p).root);
    const moved = Math.hypot(p[0] - a.position[0] + (a.position[0] - m.position[0]), p[1] - m.position[1]);
    expect(moved).toBeGreaterThan(4000);
    expect(log.filter((x) => x.startsWith("wire_drag_")).slice(0, 2)).toEqual(["wire_drag_1", "wire_drag_2"]);
    // Slide: speed grows by -dir.z x 88.3 per tick (x 0.99) and the ride ends 0.5 m before the low end.
    const b = new AttachController(recorder().host);
    const start = wireMount(w1, add(w1.pose.position, [0, 0, -4096]), "slide").position;
    b.attachWire(w1, add(w1.pose.position, [0, 0, -4096]));
    let q = [...b.position] as V3;
    let detach: string | null = null;
    let ticks = 0;
    for (; ticks < 2000 && !detach; ticks++) {
      const t = b.tick({ up: false, down: false, activatePressed: false, grounded: false, dead: false }, q);
      detach = t.detach;
      q = add(q, add(t.root, t.air));
    }
    expect(detach).toBe("fall");
    expect(wireInRange(w1, q, "slide")).toBe(false);
    expect(q[2]).toBeLessThan(start[2]);
    // From the middle of the 85 m wire: s -> 0.0865 x 88.31 / 0.01 = 764 units/tick (5.6 m/s), ~42 m in ~11 s.
    expect(ticks).toBeGreaterThan(250);
    expect(ticks).toBeLessThan(400);
  });

  it("claims the fence when facing it and mounts on the near side", () => {
    const t = level.tasks.find((x) => x.type === "Fence")!;
    const info = models.get(stringParam(t, "Model")!)!;
    const fence: FenceTarget = {
      kind: "fence", taskId: t.id, nodeIndex: level.tasks.indexOf(t), position: vec3Param(t, "Position")! as V3,
      rotation: eulerToMatrix(0, 0, numberParam(t, "Gamma") ?? 0) as M3, points: info.points, electric: false,
    };
    const r = fence.rotation;
    const local = [15000, 3000, 6500];
    const eye: V3 = add(fence.position, [r[0] * local[0] + r[1] * local[1] + r[2] * local[2], r[3] * local[0] + r[4] * local[1] + r[5] * local[2], r[6] * local[0] + r[7] * local[1] + r[8] * local[2]]);
    const view = lookAt(eye, add(eye, [-r[1], -r[4], -r[7]]));
    const s = new UseSearch<FenceTarget>(view);
    expect(fenceUseTest(s, fence, fence)).toBe(true);
    expect(s.bestHorizontal).toBe(0);
    const m = fenceMount(fence, eye);
    expect(m.heading).toBeCloseTo(headingOf(r) + Math.PI, 5);
  });

  it("finds switch 94 in front of its button point", () => {
    const t = level.tasks.find((x) => x.type === "Switch" && x.id === 94)!;
    const angles = vec3Param(t, "Orientation")!;
    const sw: PanelTarget = {
      kind: "switch", type: "Switch", taskId: 94, nodeIndex: level.tasks.indexOf(t), position: vec3Param(t, "Position")! as V3,
      rotation: eulerToMatrix(angles[0], angles[1], angles[2]) as M3, points: models.get("234_01_1")!.points, enabled: true, hackSeconds: 0,
    };
    const p0 = worldPoint(sw, 0);
    const s = new UseSearch<PanelTarget>(lookAt(add(p0, [0, 3000, 0]), p0));
    expect(panelUseTest(s, sw, sw)).toBe(true);
    expect(useIconOf(sw)).toBe("action_pressbutton.spr");
    const behind = new UseSearch<PanelTarget>(lookAt(add(p0, [0, -3000, 0]), p0));
    expect(panelUseTest(behind, sw, sw)).toBe(false);
  });

  it("drives the controller: camera target -> HUD icon -> Activate attaches to the ladder", async () => {
    const camera = new THREE.PerspectiveCamera();
    const events = new EventBus();
    const used: unknown[] = [];
    events.on(INTERACT_EVENTS.Used, (p) => used.push(p));
    const ctx = {
      level, camera, events, systems: { tasks: null, audio: null, weapon: null },
      player: { position: [0, 0, 0], eyeHeight: 1.64, alive: true },
    } as unknown as GameContext;
    const it = createInteractions(ctx, { source: raw, clips: (id) => clips.get(id) ?? null });
    await it.load();
    const l = ladders[1];
    const eye = add(l.position, [0, 4000, 6500]);
    const e = igiToEngine(level, eye);
    camera.position.set(e[0], e[1], e[2]);
    const target = igiToEngine(level, add(eye, [0, -4000, 0]));
    camera.lookAt(target[0], target[1], target[2]);
    camera.updateMatrixWorld();
    it.search(true);
    expect(it.target?.kind).toBe("ladder");
    expect(it.actionIcon).toBe("a_ladder.spr");
    const pelvis = add(l.position, [0, 4000, 3900]);
    expect(it.activate({ held: true, blocked: true, pelvis })).toBe(null); // firing takes the tick
    const out = it.activate({ held: true, blocked: false, pelvis });
    expect(out?.kind).toBe(USE_KIND.LADDER);
    expect(it.busy).toBe("attached");
    expect(it.attach.state).toBe("ladder-climb");
    expect(it.viewLocked).toBe(true);
    expect(it.weaponHolstered).toBe(true);
    expect(used).toHaveLength(1);
    // In use: no search, no icon.
    it.search(true);
    expect(it.actionIcon).toBe(null);
    // Released while Activate is still held: latched until it goes up.
    it.attach.reset();
    it.release();
    it.search(true);
    expect(it.activate({ held: true, blocked: false, pelvis })).toBe(null);
    expect(it.activate({ held: false, blocked: false, pelvis })).toBe(null);
    it.search(true);
    expect(it.activate({ held: true, blocked: false, pelvis })?.kind).toBe(USE_KIND.LADDER);
  });

  it("collects the level's placed pickups by walking over them and grants weapon / ammo through the inventory hooks", () => {
    const events = new EventBus();
    const got: string[] = [];
    const carried = new Set<string>(["WEAPON_ID_MP5SD"]);
    const inventory: PickupInventory = {
      hasWeapon: (id) => carried.has(id),
      addWeaponAmmo: (id, n) => got.push(`ammo-of ${id} ${n}`),
      addAmmo: (id, n) => got.push(`ammo ${id} ${n}`),
      addWeapon: (id, n) => {
        carried.add(id);
        got.push(`weapon ${id} ${n}`);
      },
    };
    const messages: unknown[] = [];
    events.on(GameEvent.Pickup, (p) => messages.push(p));
    const ctx = {
      level, events, systems: { tasks: null, audio: null, weapon: null }, enemies: [], world: null,
      player: { alive: true }, rng: { float: () => 0.25 },
    } as unknown as GameContext;
    const pickups = createPickupSystem(ctx, { inventory: () => inventory, modelRadius: (m) => models.get(m)?.radius ?? null });
    pickups.reset();
    expect(pickups.items.filter((p) => p.kind === "weapon")).toHaveLength(6);
    expect(pickups.items.filter((p) => p.kind === "ammo")).toHaveLength(5);
    const uzi = pickups.items.find((p) => p.id === "WEAPON_ID_UZI")!;
    expect(uzi.rounds).toBe(level.weapons.get("WEAPON_ID_UZI")!.roundsPerClip);
    // Standing next to it (pelvis 0.9 m above, 0.5 m away): both the UZI and the 9 mm box next to it.
    const pelvis = igiToEngine(level, add(uzi.position, [2048, 0, 3700]));
    pickups.update(pelvis);
    expect(got).toContain(`weapon WEAPON_ID_UZI ${uzi.rounds}`);
    expect(got).toContain("ammo AMMO_ID_919 32");
    expect(messages).toContainEqual(expect.objectContaining({ kind: "weapon", name: "WEAPON_ID_UZI" }));
    expect(pickups.items.find((p) => p.id === "WEAPON_ID_UZI")).toBeUndefined();
    // Dropped gun: falls to the rest height and can be collected for its clip.
    const drop = pickups.drop("WEAPON_ID_UZI", pelvis, 1)!;
    expect(drop.rest).toBe(drop.position[2]); // no world: no ray hit
    pickups.update(pelvis);
    expect(got).toContain(`ammo-of WEAPON_ID_UZI ${uzi.rounds}`);
    pickups.dispose();
  });
});

// --- end to end through the player controller --------------------------------------

describe.skipIf(!haveRaw)("player controller on a level-1 ladder (end to end)", () => {
  it("Activate in front of ladder 400_17_1 mounts it, MoveUp climbs it and the player stands on the roof", async () => {
    const { buildWorld } = await import("../src/engine/world/world-builder");
    const { TERRAIN_HIT_MATERIAL, TRI_BULLET, TRI_SIGHT, TRI_SOLID, TRI_TERRAIN } = await import("../src/engine/world/collision");
    const { createPlayerController } = await import("../src/engine/player/player");
    const raw = createFsAssetSource(RAW_ROOT);
    const level = await loadIgiLevel(raw);
    const built = buildWorld(level, (b) =>
      b.addIndexed(level.terrain.detail.positions, level.terrain.detail.indices, TRI_SOLID | TRI_BULLET | TRI_SIGHT | TRI_TERRAIN, TERRAIN_HIT_MATERIAL),
    );
    const held = new Set<string>();
    let forward = 0;
    const camera = new THREE.PerspectiveCamera();
    const ctx = {
      level, world: built.collision, playArea: null, running: true, tick: 0, camera, events: new EventBus(), enemies: [],
      systems: { tasks: null, audio: null, weapon: null },
      rng: { float: () => 0.5 },
      input: { action: (n: string) => held.has(n), actionPressed: () => false, get forward() { return forward; }, strafe: 0 },
      player: {
        position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0, grounded: false, crouching: false, running: true, health: 3, maxHealth: 3,
        alive: true, walking: false, eyeHeight: 1.64, kickPitch: 0, kickYaw: 0, leanSide: 0, leanUp: 0,
      },
    } as unknown as GameContext;
    const player = createPlayerController(ctx, { interactions: { source: raw } });
    player.reset();
    await player.interactions.load();
    const inst = level.instances.find((i) => i.model === "400_17_1")!;
    const ladderPos = engineToIgi(level, [inst.matrix[12], inst.matrix[13], inst.matrix[14]]);
    // Feet 1 m in front of the ladder (its +y side), on the floor under that point; facing it (IGI -y = engine +z).
    const start = igiToEngine(level, add(ladderPos, [0, 4096, 4096]));
    const floor = built.collision.raycast(start[0], start[1], start[2], 0, -1, 0, 10, TRI_SOLID)!;
    ctx.player.position = [start[0], floor.point[1], start[2]];
    ctx.player.yaw = Math.PI; // body forward (-sin, cos) = (0, -1): towards the ladder
    const syncCamera = () => {
      const p = ctx.player;
      camera.position.set(p.position[0], p.position[1] + p.eyeHeight, p.position[2]);
      camera.rotation.set(p.pitch, p.yaw, 0, "YXZ");
      camera.updateMatrixWorld();
    };
    for (let i = 0; i < 10; i++) {
      syncCamera();
      player.update(1 / 30);
    }
    expect(player.interactions.actionIcon).toBe("a_ladder.spr");
    held.add("Activate");
    syncCamera();
    player.update(1 / 30);
    expect(player.interactions.attach.state).toBe("ladder-climb");
    held.delete("Activate");
    forward = 1;
    const startY = ctx.player.position[1];
    let ticks = 0;
    while (ticks < 600 && player.interactions.busy) {
      syncCamera();
      player.update(1 / 30);
      ticks++;
    }
    expect(player.interactions.busy).toBe(null);
    forward = 0;
    for (let i = 0; i < 30; i++) {
      syncCamera();
      player.update(1 / 30);
    }
    // Standing on the roof: ~ (20 rungs) higher, grounded, the top point p1 within 1 m.
    const p1 = (await loadModelInfo(raw, ["400_17_1"])).get("400_17_1")!.points[1];
    const top = igiToEngine(level, add(ladderPos, p1));
    expect(ctx.player.grounded).toBe(true);
    expect(ctx.player.position[1] - startY).toBeGreaterThan(5);
    expect(Math.abs(ctx.player.position[1] - (top[1] - 0.64))).toBeLessThan(0.5);
  }, 180_000);
});
