/**
 * igi.exe's animation blend tree (engine/world/bone-anim.ts; docs/characters.md
 * "Blending"): fade weights, root motion and pelvis height during a blend,
 * nested blends, the outgoing clip's events, instant switches; then the
 * player's body (000.iff: stop from a run, crouch -> stand -> jump) and a
 * soldier's walk -> stop (001.iff).
 */
import { existsSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ClipPlayer } from "../src/engine/ai/clip-player";
import { SoldierMotor, type GunSpec } from "../src/engine/ai/motor";
import { SOLDIER_STATE } from "../src/engine/ai/soldier-graph";
import type { GameContext } from "../src/engine/context";
import { EventBus } from "../src/engine/events";
import { BodyAnimator } from "../src/engine/player/body";
import { PLAYER_STATE as S } from "../src/engine/player/movement-graph";
import { createPlayerController, type PlayerController } from "../src/engine/player/player";
import { BoneAnim, PLAY_LOOP, blendUpdates, type PlaybackClip } from "../src/engine/world/bone-anim";
import { CollisionWorldBuilder, TRI_BULLET, TRI_SIGHT, TRI_SOLID } from "../src/engine/world/collision";
import { blendRotation, readAnimations, sampleRotation, sampleTranslation, x87Div, x87StoreF32, x87Sub, type AnimationFile, type IgiLevel } from "../src/loaders";
import { RAW_ROOT, readRaw } from "./helpers";

const HAVE_000 = existsSync(`${RAW_ROOT}/common/anims/000.iff`);
const HAVE_001 = existsSync(`${RAW_ROOT}/common/anims/001.iff`);

type Vec = [number, number, number];

/** A clip whose root moves linearly from `from` to `to` over `duration` ticks (Hermite controls c = slope, d = -slope). */
function linearClip(duration: number, from: Vec, to: Vec, events: Array<{ time: number; trigger: number }> = []): PlaybackClip {
  const s = to.map((v, i) => (v - from[i]) / duration);
  const n = s.map((v) => -v);
  return {
    duration,
    events,
    translation: {
      times: Float32Array.of(0, duration),
      values: Float32Array.of(...from, ...to),
      c: Float32Array.of(...s, ...s),
      d: Float32Array.of(...n, ...n),
    },
  };
}

/** The exe's fade weight after k of n updates (LAB_004cca40): f32(1 - k/n), 0 from k = n. */
const fadeWeight = (k: number, n: number) => (k >= n ? 0 : x87StoreF32(x87Sub(1, x87Div(k, n))));

describe("blend tree (FUN_004cc860 / FUN_004c9940 / FUN_004c96c0)", () => {
  // A walks 10 units per update at z 300; B 40 per update at z 100.
  const A = linearClip(3200, [0, 0, 300], [0, 200, 300]);
  const B = linearClip(3200, [0, 0, 100], [0, 800, 100]);

  it("converts the blend time like FUN_004cc860: f32(f32(s) x 4800 / 160) updates", () => {
    expect(blendUpdates(0.2)).toBe(6);
    expect(blendUpdates(0.4)).toBe(12);
    expect(blendUpdates(1 / 60)).toBeLessThan(1); // under one update: an instant switch
  });

  it("keeps the old clip at weight 1 on the play tick, then f32(1 - k/6); root change and height are linear in it", () => {
    const t = new BoneAnim();
    t.play(1, A, PLAY_LOOP, 0);
    for (let i = 0; i < 3; i++) {
      t.sampleRoot();
      t.advance();
    }
    t.play(2, B, PLAY_LOOP, 0.2);
    expect(t.blending).toBe(true);
    expect(t.newest()?.clip).toBe(2);
    const changes: number[] = [];
    const heights: number[] = [];
    const weights: number[] = [];
    for (let k = 0; k < 8; k++) {
      weights.push(t.fade?.w ?? 0);
      const r = t.sampleRoot();
      changes.push(r.change[1]);
      heights.push(r.abs[2]);
      t.advance();
    }
    // B's first sample is its first key (change 0); afterwards 40 per update.
    const expected = [0, 1, 2, 3, 4, 5].map((k) => {
      const w = k === 0 ? 1 : fadeWeight(k, 6);
      return { w, change: 10 * w + (k === 0 ? 0 : 40) * (1 - w), z: 300 * w + 100 * (1 - w) };
    });
    for (let k = 0; k < 6; k++) {
      expect(weights[k]).toBe(expected[k].w);
      expect(changes[k]).toBeCloseTo(expected[k].change, 6);
      expect(heights[k]).toBeCloseTo(expected[k].z, 6);
    }
    // The 6th advance freed A: B alone, no longer blending.
    expect(changes[6]).toBeCloseTo(40, 6);
    expect(heights[6]).toBeCloseTo(100, 6);
    expect(t.blending).toBe(false);
    expect(t.instances().map((l) => l.clip)).toEqual([2]);
  });

  it("frees the old instance on the last fade update without advancing it", () => {
    const t = new BoneAnim();
    const a = t.play(1, A, PLAY_LOOP, 0);
    t.play(2, B, PLAY_LOOP, 0.2);
    for (let k = 1; k <= 5; k++) {
      t.advance();
      expect(a.time).toBe(160 * k);
    }
    t.advance();
    expect(a.time).toBe(800); // not advanced on the 6th update
    expect(t.instances().length).toBe(1);
  });

  it("nests a blend started during a blend: the running fade continues as the older branch", () => {
    const C = linearClip(3200, [0, 0, 0], [0, 1600, 0]); // 80 per update
    const t = new BoneAnim();
    t.play(1, A, PLAY_LOOP, 0);
    t.sampleRoot();
    t.advance();
    t.play(2, B, PLAY_LOOP, 0.2);
    t.sampleRoot();
    t.advance(); // inner fade: 1 update
    t.sampleRoot();
    t.advance(); // 2 updates
    t.play(3, C, PLAY_LOOP, 0.2);
    expect(t.instances().map((l) => l.clip)).toEqual([1, 2, 3]);
    expect(t.newest()?.clip).toBe(3);
    // Sample with the outer fade at 1 (play tick): the inner blend A/B at w = 4/6.
    let r = t.sampleRoot();
    const w1 = fadeWeight(2, 6);
    expect(r.change[1]).toBeCloseTo(10 * w1 + 40 * (1 - w1), 6);
    t.advance(); // outer 1/6, inner 3/6
    r = t.sampleRoot();
    const wi = fadeWeight(3, 6);
    const wo = fadeWeight(1, 6);
    expect(r.change[1]).toBeCloseTo((10 * wi + 40 * (1 - wi)) * wo + 80 * (1 - wo), 6);
    // The inner fade ends 3 updates later: A is freed, the outer fade goes on between B and C.
    for (let i = 0; i < 3; i++) t.advance();
    expect(t.instances().map((l) => l.clip)).toEqual([2, 3]);
    expect(t.fade?.w).toBe(fadeWeight(4, 6));
    expect(t.blending).toBe(true);
    for (let i = 0; i < 2; i++) t.advance();
    expect(t.instances().map((l) => l.clip)).toEqual([3]);
    expect(t.blending).toBe(false);
  });

  it("fires the outgoing clip's events first; the bone's finished flag is the newest instance's", () => {
    const E = linearClip(480, [0, 0, 0], [0, 0, 0], [{ time: 320, trigger: 1010 }]);
    const F = linearClip(3200, [0, 0, 0], [0, 0, 0], [{ time: 320, trigger: 1006 }]);
    const t = new BoneAnim();
    t.play(1, E, PLAY_LOOP, 0);
    t.advance(); // 160
    t.play(2, F, 0, 0.2);
    const first = t.advance(); // E 160 -> 320 fires 1010; F's first advance 0 -> 160
    expect(first.map((e) => [e.trigger, e.clip])).toEqual([[1010, 1]]);
    const second = t.advance(); // E 320 -> 480 wraps (finished); F 160 -> 320 fires 1006
    expect(second.map((e) => [e.trigger, e.clip])).toEqual([[1006, 2]]);
    expect(t.finished).toBe(false); // E's wrap set it, F's advance cleared it
  });

  it("a play under one update frees the whole tree: first change 0, the new root height at once", () => {
    const t = new BoneAnim();
    t.play(1, A, PLAY_LOOP, 0);
    t.sampleRoot();
    t.advance();
    t.play(2, B, PLAY_LOOP, 0.2);
    t.sampleRoot();
    t.advance();
    t.play(3, A, 0, 0);
    expect(t.blending).toBe(false);
    expect(t.instances().map((l) => l.clip)).toEqual([3]);
    const r = t.sampleRoot();
    expect(r.change).toEqual([0, 0, 0]);
    expect(r.abs[2]).toBe(300);
  });
});

describe.skipIf(!HAVE_000)("player body blends (000.iff)", () => {
  let anim: AnimationFile;
  const load = async () => (anim ??= readAnimations(await readRaw("common/anims/000.iff")));

  it("blends the bone rotations with the exe slerp by the old pose's weight", async () => {
    const a = await load();
    const body = new BodyAnimator(a);
    body.start(4, true, 0);
    for (let i = 0; i < 7; i++) body.step();
    body.start(2, true, 0.2);
    const run = a.clips.get(4)!;
    const stand = a.clips.get(2)!;
    const at = (clip: typeof run, bone: number, time: number) => {
      const q = new Float32Array(4);
      sampleRotation(clip, bone, time, q);
      return q;
    };
    // Play tick: w = 1, the run pose exactly.
    let pose = body.sample()!;
    for (const bone of [1, 9, 24]) expect(Array.from(pose.rotations.subarray(4 * bone, 4 * bone + 4))).toEqual(Array.from(at(run, bone, 1120)));
    body.step();
    body.step(); // w = 4/6; run at 1440, stand at 320
    pose = body.sample()!;
    expect(body.blendWeight).toBe(fadeWeight(2, 6));
    for (const bone of [1, 9, 24]) {
      const want = new Float32Array(4);
      blendRotation(want, 0, at(run, bone, 1440), 0, at(stand, bone, 320), 0, fadeWeight(2, 6));
      expect(Array.from(pose.rotations.subarray(4 * bone, 4 * bone + 4))).toEqual(Array.from(want));
    }
  });

  it("stops from a run in 0.6-0.7 m: the run keeps its full change on the play tick, then fades by 5/6 ... 1/6", async () => {
    const a = await load();
    const body = new BodyAnimator(a);
    body.start(4, true, 0);
    for (let i = 0; i < 26; i++) body.step();
    const runTime = body.state!.time; // 26 x 160 - 3360 = 800: the fade window does not wrap
    body.start(2, true, 0.2);
    let travelled = 0;
    for (let i = 0; i < 12; i++) travelled += body.step().delta[1];
    // Independent: run change over each of the next 6 samples x w_k + stand change x (1 - w_k).
    const run = a.clips.get(4)!;
    const stand = a.clips.get(2)!;
    const y = (clip: typeof run, t: number) => sampleTranslation(clip, t)[1];
    let expected = 0;
    for (let k = 0; k < 6; k++) {
      const w = k === 0 ? 1 : fadeWeight(k, 6);
      const t1 = runTime + 160 * k;
      const runChange = t1 === 0 ? 0 : y(run, t1) - y(run, t1 - 160); // no wrap in this window
      const standChange = k === 0 ? 0 : y(stand, 160 * k) - y(stand, 160 * (k - 1));
      expected += w * runChange + (1 - w) * standChange;
    }
    for (let k = 6; k < 12; k++) expected += y(stand, 160 * k) - y(stand, 160 * (k - 1));
    expect(runTime + 160 * 5).toBeLessThan(run.duration);
    expect(travelled).toBeCloseTo(expected, 6);
    // 0.715 m at this phase (0.59-0.72 m over a stride; a fade from w = 5/6 without the play tick would give 0.42-0.51 m).
    expect((travelled * 1.75) / 4096).toBeCloseTo(0.7146, 3);
  });

  it("still fires the outgoing run's footstep event during the fade, but the footstep is dropped (not the newest clip)", async () => {
    const a = await load();
    const body = new BodyAnimator(a);
    body.start(4, true, 0);
    for (let i = 0; i < 11; i++) body.step(); // run time 1760
    body.start(2, true, 0.2);
    expect(body.step().events).toEqual([]); // 1760 -> 1920
    const step = body.step(); // 1920 -> 2080: clip 4's 1010
    expect(step.events.map((e) => [e.trigger, e.clip])).toEqual([[1010, 4]]);
    expect(step.triggers).toEqual([]);
  });

  it("runs at root speed x 1.75 once the clip plays (the play tick's change is 0)", async () => {
    const a = await load();
    const body = new BodyAnimator(a);
    body.start(4, true, 0);
    expect(body.step().delta).toEqual([0, 0, 0]);
    let y = 0;
    for (let i = 0; i < 21; i++) y += body.step().delta[1];
    const run = a.clips.get(4)!;
    expect(y).toBeCloseTo(sampleTranslation(run, run.duration)[1] - sampleTranslation(run, 0)[1], 0);
  });
});

async function playerRig() {
  const anims = await readRaw("common/anims/000.iff");
  const b = new CollisionWorldBuilder();
  b.addIndexed([-50, 0, -50, -50, 0, 50, 50, 0, 50, 50, 0, -50], [0, 1, 2, 0, 2, 3], TRI_SOLID | TRI_BULLET | TRI_SIGHT);
  const world = b.build();
  const held = new Set<string>();
  const level = {
    animations: new Map([[0, anims]]),
    humanPlayer: null,
    surfaceMaterials: [],
    player: { position: [0, 0.5, 0], yaw: 0, model: null, weapons: [], ammo: {} },
    instances: [],
    tasks: [],
    weapons: new Map(),
    ammoTypes: new Map(),
    boneModels: new Map(),
    originIgi: [0, 0, 0],
  } as unknown as IgiLevel;
  const ctx = {
    level,
    world,
    playArea: null,
    running: true,
    tick: 0,
    camera: new THREE.PerspectiveCamera(),
    events: new EventBus(),
    enemies: [],
    weapon: null,
    systems: { tasks: null, audio: null, weapon: null },
    rng: { float: () => 0.5 },
    input: {
      action: (n: string) => held.has(n),
      actionPressed: () => false,
      get forward() {
        return (held.has("MoveUp") ? 1 : 0) - (held.has("MoveDown") ? 1 : 0);
      },
      get strafe() {
        return (held.has("MoveRight") ? 1 : 0) - (held.has("MoveLeft") ? 1 : 0);
      },
    },
    player: {
      position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0, grounded: false, crouching: false, running: true, health: 3, maxHealth: 3,
      alive: true, walking: false, eyeHeight: 1.64, kickPitch: 0, kickYaw: 0, leanSide: 0, leanUp: 0,
    },
  } as unknown as GameContext;
  const source = { exists: async () => false, readBinary: async () => new ArrayBuffer(0), readText: async () => "" };
  const player: PlayerController = createPlayerController(ctx, { interactions: { source: source as never } });
  player.reset();
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      player.update(1 / 30);
      ctx.tick++;
    }
  };
  tick(2);
  return { ctx, player, held, tick };
}

describe.skipIf(!HAVE_000)("player controller blends (flat floor, 000.iff)", () => {
  it("slides 0.6-0.7 m after MoveUp is released from a run", async () => {
    for (const run of [20, 25, 36]) {
      const r = await playerRig();
      r.held.add("MoveUp");
      r.tick(run);
      r.held.delete("MoveUp");
      const z0 = r.ctx.player.position[2];
      r.tick(); // the run tick sees !Up: state 0, clip 2 with the 0.2 s blend
      expect(r.player.movementState).toBe(S.stand);
      r.tick(12);
      const slide = z0 - r.ctx.player.position[2];
      expect(slide).toBeGreaterThan(0.59);
      expect(slide).toBeLessThan(0.72);
    }
  });

  /** Crouch, release it (state 0 entered with the blend), wait, press Jump; the feet's apex and the jump state's ticks. */
  async function jumpAfterStandUp(wait: number) {
    const r = await playerRig();
    r.held.add("Crouch");
    r.tick(20);
    r.held.delete("Crouch");
    r.tick();
    expect(r.player.movementState).toBe(S.stand);
    r.tick(wait);
    r.held.add("Jump");
    r.tick();
    expect(r.player.movementState).toBe(S.jump);
    const pose = r.player.bodyPose()!;
    const rootZ = (pose.pelvis[1] - r.ctx.player.position[1]) * 4096;
    let apex = r.ctx.player.position[1];
    let jumpTicks = 1;
    for (let i = 0; i < 40; i++) {
      r.tick();
      apex = Math.max(apex, r.ctx.player.position[1]);
      if (r.player.movementState === S.jump) jumpTicks++;
    }
    return { rootZ, apex, jumpTicks };
  }

  it("snaps the pelvis to the jump clip at once (blend 0): a jump in the first 5 ticks of standing up is cut short", async () => {
    const a = readAnimations(await readRaw("common/anims/000.iff"));
    const jumpZ = sampleTranslation(a.clips.get(25)!, 0)[2];
    const early = await jumpAfterStandUp(0);
    expect(early.rootZ).toBeCloseTo(jumpZ, 2);
    // The pelvis was at the crouched height (w = 1 on the stand tick): the feet start 0.52 m in the floor.
    expect(early.jumpTicks).toBe(1);
    expect(early.apex).toBeLessThan(0.01);
    const late = await jumpAfterStandUp(4);
    expect(late.jumpTicks).toBe(1);
    const partial = await jumpAfterStandUp(5);
    expect(partial.apex).toBeGreaterThan(1.5);
    expect(partial.apex).toBeLessThan(1.6);
    const full = await jumpAfterStandUp(6);
    expect(full.rootZ).toBeCloseTo(jumpZ, 2);
    expect(full.apex).toBeCloseTo(1.637, 2);
    expect(full.jumpTicks).toBeGreaterThan(20);
  });
});

describe.skipIf(!HAVE_001)("soldier walk -> stop (001.iff)", () => {
  it("switches at once (blend 0): no blend, the release tick's root change is 0", async () => {
    const anim = readAnimations(await readRaw("common/anims/001.iff"));
    const body = new ClipPlayer(anim);
    const gun: GunSpec = { weaponId: "WEAPON_ID_AK47", roundsPerClip: 30, maxRoundsPerBurst: 30, roundsPerMinute: 600, grenade: false };
    const motor = new SoldierMotor(body, 0, -1, gun, null, {}, () => 0);
    const channels = (forward: boolean) => {
      const c = new Float32Array(40);
      if (forward) c[4] = 1;
      return c;
    };
    motor.step(channels(false));
    let walked = 0;
    for (let i = 0; i < 40; i++) {
      walked += motor.step(channels(true)).delta[1];
      expect(body.blending).toBe(false);
    }
    expect(motor.state).toBe(SOLDIER_STATE.WALK);
    expect(walked / 4096).toBeGreaterThan(1.4); // 1.26 m/s for 1.3 s
    const release = motor.step(channels(false));
    expect(motor.state).toBe(SOLDIER_STATE.STAND);
    expect(body.currentClip).toBe(2);
    expect(body.blending).toBe(false);
    expect(release.delta).toEqual([0, 0, 0]);
    let after = 0;
    for (let i = 0; i < 20; i++) after += Math.hypot(...motor.step(channels(false)).delta.slice(0, 2));
    expect(after / 4096).toBeLessThan(0.01);
  });

  it("walk -> run mid-stride: the instant play + phase carry-over moves the soldier by the run clip's root offset at once", async () => {
    const anim = readAnimations(await readRaw("common/anims/001.iff"));
    const body = new ClipPlayer(anim);
    const motor = new SoldierMotor(body, 0, -1, null, null, {}, () => 0);
    const c = (...pairs: Array<[number, number]>) => {
      const v = new Float32Array(40);
      for (const [k, x] of pairs) v[k] = x;
      return v;
    };
    motor.step(c());
    for (let i = 0; i < 37; i++) motor.step(c([4, 1]));
    motor.step(c([4, 1], [20, 1])); // walking flag off after this graph run
    const step = motor.step(c([4, 1]));
    expect([motor.state, body.currentClip]).toEqual([SOLDIER_STATE.RUN, 3]);
    const run = anim.clips.get(3)!;
    const t = body.clip!.time - 160; // the phase-carried time the root was sampled at
    const s = sampleTranslation(run, t);
    const k0 = sampleTranslation(run, 0);
    expect(step.delta[1]).toBeCloseTo(s[1] - k0[1], 3);
    expect(step.delta[1] / 4096).toBeGreaterThan(0.3);
  });
});
