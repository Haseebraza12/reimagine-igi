/**
 * The player's movement state graph (human+0x2ec, docs/gameplay.md "Player
 * movement state graph"): the recovered transition rules, the lean tick
 * FUN_0040e0c0, and the controller on a flat floor with the real 000.iff
 * clips (walk/run toggle, held crouch and the roof, no jump while crouched,
 * lean edge step and snap-back, the map computer). The weapon machine's S5
 * (peek) and S11 (map computer) hooks run against level-1 data.
 */
import { existsSync } from "node:fs";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { createWeaponSystem, WEAPON_STATE } from "../src/engine/combat/weapon";
import type { GameContext } from "../src/engine/context";
import { EventBus } from "../src/engine/events";
import {
  COND,
  NO_CHANNELS,
  PLAYER_STATE as S,
  STATE_ENTRIES,
  TICK_RULES,
  conditionBits,
  createLeanState,
  groundTransition,
  landingState,
  leanTick,
  type PlayerChannels,
} from "../src/engine/player/movement-graph";
import { MAP_COMPUTER_EVENT, createPlayerController, type PlayerController } from "../src/engine/player/player";
import { CollisionWorldBuilder, TRI_BULLET, TRI_SIGHT, TRI_SOLID } from "../src/engine/world/collision";
import { PLAYER_CLIP_SLOTS, PLAYER_LOCOMOTION_ANIMS, loadIgiLevel, type IgiLevel } from "../src/loaders";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { RAW_ROOT, readRaw } from "./helpers";

const ch = (over: Partial<PlayerChannels> = {}): PlayerChannels => ({ ...NO_CHANNELS, ...over });
const bits = (over: Partial<PlayerChannels> = {}, flags: { walking?: boolean; roof?: boolean; grounded?: boolean } = {}) =>
  conditionBits(
    { grounded: flags.grounded ?? true, roof: !!flags.roof, finished: false, blending: false, walking: !!flags.walking, dead: false },
    ch(over),
  );

describe("player clip slots (table 0x5368c8)", () => {
  it("has 49 slots; each movement state plays its own slot", () => {
    expect(PLAYER_CLIP_SLOTS).toHaveLength(49);
    expect(PLAYER_CLIP_SLOTS[S.jump]).toEqual({ clip: 25, flag: 1 });
    expect(PLAYER_CLIP_SLOTS[S.fall]).toEqual({ clip: 2, flag: 1 });
    expect(PLAYER_CLIP_SLOTS[S.lean]).toEqual({ clip: 2, flag: 1 });
    expect(PLAYER_CLIP_SLOTS[S.mapComputer]).toEqual({ clip: 19, flag: 1 });
    expect(PLAYER_CLIP_SLOTS[S.ladderMountTop]).toEqual({ clip: 170, flag: 2 });
    expect(PLAYER_LOCOMOTION_ANIMS.runForward).toBe(4);
    expect(PLAYER_LOCOMOTION_ANIMS.walkForward).toBe(57);
    expect(PLAYER_LOCOMOTION_ANIMS.crouchIdle).toBe(19);
  });
});

describe("player movement graph (recovered rules)", () => {
  it("maps the channels and flags to the FUN_004106b0 bits", () => {
    expect(bits({ left: true, right: true, forward: true, back: true })).toBe(COND.grounded | 0x20 | 0x40 | 0x80 | 0x100);
    expect(bits({ crouch: true, jump: true }, { walking: true, roof: true })).toBe(COND.grounded | 0x2000 | 0x4000 | 0x40000 | 0x10);
  });

  it("runs by default and walks with the walking flag; the toggle switches the move state", () => {
    expect(groundTransition(S.stand, bits({ forward: true }), false)).toBe(S.runForward);
    expect(groundTransition(S.stand, bits({ forward: true }, { walking: true }), false)).toBe(S.walkForward);
    expect(groundTransition(S.runForward, bits({ forward: true }, { walking: true }), false)).toBe(S.walkForward);
    expect(groundTransition(S.walkForward, bits({ forward: true }), false)).toBe(S.runForward);
    expect(groundTransition(S.runBackLeft, bits({ back: true, left: true }, { walking: true }), false)).toBe(S.walkBackLeft);
    // Priority in state 0: forward, back, right, left.
    expect(groundTransition(S.stand, bits({ forward: true, back: true, left: true }), false)).toBe(S.runForward);
    expect(groundTransition(S.stand, bits({ right: true, left: true }), false)).toBe(S.runRight);
  });

  it("keeps the exe's detours: walk 9 + right -> run 2, walk 13 without back -> run 7, walk 14 without back -> walk right 15", () => {
    expect(groundTransition(S.walkForward, bits({ forward: true, right: true }, { walking: true }), false)).toBe(S.runForwardRight);
    expect(groundTransition(S.runForwardRight, bits({ forward: true, right: true }, { walking: true }), false)).toBe(S.walkForwardRight);
    expect(groundTransition(S.walkBackRight, bits({ right: true }, { walking: true }), false)).toBe(S.runRight);
    expect(groundTransition(S.walkBackLeft, bits({ left: true }, { walking: true }), false)).toBe(S.walkRight);
    expect(groundTransition(S.walkBackLeft, bits({ back: true, left: true, crouch: true }, { walking: true }), false)).toBe(S.crouchBack);
  });

  it("crouches while Crouch is held or the roof flag is set, straight between 0 and 19 (17 / 18 never entered)", () => {
    expect(groundTransition(S.stand, bits({ crouch: true }), false)).toBe(S.crouch);
    expect(groundTransition(S.crouch, bits({ crouch: true }), false)).toBeNull();
    expect(groundTransition(S.crouch, bits(), false)).toBe(S.stand);
    expect(groundTransition(S.crouch, bits({}, { roof: true }), false)).toBeNull();
    expect(groundTransition(S.crouch, bits({ forward: true }, { roof: true }), false)).toBe(S.crouchForward);
    expect(groundTransition(S.crouchForward, bits({ forward: true }), false)).toBe(S.runForward);
    expect(groundTransition(S.crouchForward, bits({ forward: true }, { walking: true }), false)).toBe(S.walkForward);
    expect(groundTransition(S.runForward, bits({ forward: true, crouch: true }), false)).toBe(S.crouchForward);
    const targets = new Set<number>();
    for (const rules of Object.values(TICK_RULES)) for (const [, t] of rules) if (typeof t === "number") targets.add(t);
    expect(targets.has(S.crouchDown)).toBe(false);
    expect(targets.has(S.standUp)).toBe(false);
  });

  it("offers the jump (press edge) only from the standing / walking / running states 0-16", () => {
    for (let s = 0; s <= 16; s++) expect(groundTransition(s, bits(stateKeys(s), { walking: s >= 9 }), true)).toBe(S.jump);
    for (let s = 19; s <= 27; s++) expect(groundTransition(s, bits({ ...stateKeys(s), crouch: true }), true)).not.toBe(S.jump);
  });

  it("falls when the ground is lost and lands by the held direction", () => {
    for (let s = 0; s <= 27; s++) expect(groundTransition(s, bits({}, { grounded: false }), false)).toBe(S.fall);
    expect(landingState(bits({ forward: true }))).toBe(S.runForward);
    expect(landingState(bits({ back: true, right: true }, { walking: true }))).toBe(S.walkBack);
    expect(landingState(bits())).toBe(S.stand);
  });

  it("blends 0.2 s except the jump, the fall and the run states entered from the jump", () => {
    expect(STATE_ENTRIES[S.runForward]).toMatchObject({ blend: 0.2, instantAfterJump: true, armsMode: 3, crouched: false });
    expect(STATE_ENTRIES[S.walkBack]).toMatchObject({ blend: 0.2, armsMode: 2 });
    expect(STATE_ENTRIES[S.crouch]).toMatchObject({ blend: 0.2, armsMode: 4, crouched: true });
    expect(STATE_ENTRIES[S.crouchLeft]).toMatchObject({ armsMode: 5, crouched: true, phaseFrom: [8] });
    expect(STATE_ENTRIES[S.jump].blend).toBe(0);
    expect(STATE_ENTRIES[S.fall].blend).toBe(0);
    expect(STATE_ENTRIES[S.lean].crouched).toBeNull();
  });
});

/** Keys that keep state `s` (0-27) where it is. */
function stateKeys(s: number): Partial<PlayerChannels> {
  const dirs: Record<number, Partial<PlayerChannels>> = {
    1: { forward: true }, 2: { forward: true, right: true }, 3: { forward: true, left: true }, 4: { back: true },
    5: { back: true, right: true }, 6: { back: true, left: true }, 7: { right: true }, 8: { left: true },
  };
  if (s >= 1 && s <= 8) return dirs[s];
  if (s >= 9 && s <= 16) return dirs[s - 8];
  if (s >= 20 && s <= 27) return [dirs[1], dirs[2], dirs[3], dirs[4], dirs[5], dirs[6], dirs[7], dirs[8]][s - 20];
  return {};
}

describe("lean tick FUN_0040e0c0", () => {
  const params = { side: Math.fround(Math.fround(0.85) * 4096), up: Math.fround(Math.fround(0.85) * 4096), ticks: 7 };

  it("sets the step on the press edge, reaches -d in 7 ticks and decays back by the step when released", () => {
    const lean = createLeanState();
    let prev = ch();
    const run = (cur: PlayerChannels, crouched = false) => {
      leanTick(lean, cur, prev, crouched, params);
      prev = cur;
    };
    const values: number[] = [];
    for (let i = 0; i < 8; i++) {
      run(ch({ left: true }));
      values.push(lean.side);
    }
    expect(lean.sideStep).toBe(Math.fround(params.side / 7));
    // Seven float32 steps end 0.00024 units short of -d (the clamp compares the unrounded sum); the 8th clamps.
    expect(values[5]).toBeGreaterThan(-params.side);
    expect(values[6]).toBe(-3481.599853515625);
    expect(values[7]).toBe(-params.side);
    run(ch());
    expect(lean.side).toBeCloseTo(-params.side + lean.sideStep, 3);
    for (let i = 0; i < 6; i++) run(ch());
    expect(Math.abs(lean.side)).toBeLessThan(0.001); // float32 residue after 7 steps
    run(ch());
    expect(lean.side).toBe(0);
  });

  it("does not move without an edge while the step is still 0 (key held before the lean)", () => {
    const lean = createLeanState();
    for (let i = 0; i < 10; i++) leanTick(lean, ch({ right: true }), ch({ right: true }), false, params);
    expect(lean.side).toBe(0);
    expect(lean.sideStep).toBe(0);
  });

  it("raises the view with MoveUp only while crouched", () => {
    const lean = createLeanState();
    leanTick(lean, ch({ forward: true }), ch(), false, params);
    expect(lean.up).toBe(0);
    let prev = ch();
    for (let i = 0; i < 8; i++) {
      leanTick(lean, ch({ forward: true }), prev, true, params);
      prev = ch({ forward: true });
    }
    expect(lean.up).toBe(params.up);
  });
});

// --- the controller on a flat floor ---------------------------------------------------------

const haveAnims = existsSync(`${RAW_ROOT}/common/anims/000.iff`);

interface Rig {
  ctx: GameContext;
  player: PlayerController;
  held: Set<string>;
  events: Array<{ open?: boolean }>;
  tick(n?: number): void;
}

async function rig(options: { ceiling?: number; platform?: boolean } = {}): Promise<Rig> {
  const anims = await readRaw("common/anims/000.iff");
  const b = new CollisionWorldBuilder();
  const flags = TRI_SOLID | TRI_BULLET | TRI_SIGHT;
  // Floor at y = 0 over [-50, 50]^2 (normal up); optional ceiling facing down.
  // With `platform`: the floor is dynamic body 5 (an Elevator task, pre-order index 5) and the ground is 2 m below.
  if (options.platform) {
    b.addIndexed([-50, -2, -50, -50, -2, 50, 50, -2, 50, 50, -2, -50], [0, 1, 2, 0, 2, 3], flags);
    b.setTarget(5);
  }
  b.addIndexed([-50, 0, -50, -50, 0, 50, 50, 0, 50, 50, 0, -50], [0, 1, 2, 0, 2, 3], flags);
  b.setTarget(null);
  if (options.ceiling !== undefined) {
    const y = options.ceiling;
    b.addIndexed([-50, y, -50, 50, y, -50, 50, y, 50, -50, y, 50], [0, 1, 2, 0, 2, 3], flags);
  }
  const world = b.build();
  const held = new Set<string>();
  const level = {
    animations: new Map([[0, anims]]),
    humanPlayer: null,
    surfaceMaterials: [],
    player: { position: [0, 0.5, 0], yaw: 0, model: null, weapons: [], ammo: {} },
    instances: options.platform ? [{ model: "lift", taskType: "Elevator", taskIndex: 5, taskId: 1, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] : [],
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
  const player = createPlayerController(ctx, { interactions: { source: source as never } });
  const events: Array<{ open?: boolean }> = [];
  ctx.events.on(MAP_COMPUTER_EVENT, (p) => events.push(p as { open?: boolean }));
  player.reset();
  const r: Rig = {
    ctx,
    player,
    held,
    events,
    tick(n = 1) {
      for (let i = 0; i < n; i++) {
        player.update(1 / 30);
        ctx.tick++;
      }
    },
  };
  r.tick(2); // first run enters state 0, second runs its tick
  return r;
}

function speed(r: Rig, ticks: number): number {
  const a = [...r.ctx.player.position];
  r.tick(ticks);
  const b = r.ctx.player.position;
  return Math.hypot(b[0] - a[0], b[2] - a[2]) / (ticks / 30);
}

describe.skipIf(!haveAnims)("player controller state graph (flat floor, 000.iff)", () => {
  it("runs at 5.9 m/s; one ToggleWalkRun press walks at 2.2 m/s from the next tick", async () => {
    const r = await rig();
    expect(r.player.movementState).toBe(S.stand);
    expect(r.ctx.player.grounded).toBe(true);
    r.held.add("MoveUp");
    r.tick();
    expect(r.player.movementState).toBe(S.runForward);
    r.tick(20);
    expect(speed(r, 60)).toBeGreaterThan(5.7);
    r.held.add("ToggleWalkRun");
    r.tick();
    expect(r.player.movementState).toBe(S.runForward); // the flag flips after the graph
    expect(r.ctx.player.walking).toBe(true);
    r.tick(); // still held: no second edge
    expect(r.player.movementState).toBe(S.walkForward);
    r.held.delete("ToggleWalkRun");
    r.tick(20);
    const v = speed(r, 60);
    expect(v).toBeGreaterThan(2.0);
    expect(v).toBeLessThan(2.4);
    expect(r.ctx.player.walking).toBe(true);
    expect(r.player.armsMode).toBe(2);
  });

  it("crouches only while Crouch is held, with the crouched eye; no jump while crouched", async () => {
    const r = await rig();
    const standingEye = r.ctx.player.eyeHeight;
    r.held.add("Crouch");
    r.tick();
    expect(r.player.movementState).toBe(S.crouch);
    expect(r.ctx.player.crouching).toBe(true);
    r.tick(15);
    expect(r.ctx.player.eyeHeight).toBeLessThan(standingEye - 0.5);
    r.held.add("Jump");
    r.tick(3);
    expect(r.player.movementState).toBe(S.crouch);
    expect(r.ctx.player.grounded).toBe(true);
    r.held.delete("Jump");
    r.held.delete("Crouch");
    r.tick();
    expect(r.player.movementState).toBe(S.stand);
    expect(r.ctx.player.crouching).toBe(false);
    r.tick(10); // the 0.2 s blend up to the standing pelvis
    r.held.add("Jump");
    r.tick();
    expect(r.player.movementState).toBe(S.jump);
    expect(r.ctx.player.grounded).toBe(false);
    r.tick(10);
    expect(r.ctx.player.position[1]).toBeGreaterThan(1);
  });

  it("stays crouched under a 1.5 m ceiling (the roof flag) after Crouch is released", async () => {
    const r = await rig({ ceiling: 1.5 });
    r.held.add("Crouch");
    r.tick(20);
    expect(r.player.movementState).toBe(S.crouch);
    r.held.delete("Crouch");
    r.tick(10);
    expect(r.player.movementState).toBe(S.crouch);
    expect(r.ctx.player.crouching).toBe(true);
  });

  it("leans from the S5 hook: the press edge sets the step, 7 ticks to 0.85 m, endLean snaps back at once", async () => {
    const r = await rig();
    r.player.beginLean();
    expect(r.player.movementState).toBe(S.lean);
    r.tick(); // no key: nothing moves
    r.held.add("MoveLeft");
    r.tick(6);
    expect(r.ctx.player.leanSide).toBeLessThan(0);
    expect(r.ctx.player.leanSide).toBeGreaterThan(-0.85);
    r.tick();
    expect(r.ctx.player.leanSide).toBeCloseTo(-0.85, 5);
    // MoveLeft does not walk while leaning.
    const at = [...r.ctx.player.position];
    r.tick(10);
    expect(Math.hypot(r.ctx.player.position[0] - at[0], r.ctx.player.position[2] - at[2])).toBeLessThan(1e-6);
    r.player.endLean();
    expect(r.ctx.player.leanSide).toBe(0);
    expect(r.player.movementState).toBe(S.stand);
  });

  it("does not lean while the strafe key was already held before the first lean (step 0)", async () => {
    const r = await rig();
    r.held.add("MoveRight");
    r.tick(3);
    r.player.beginLean();
    r.tick(10);
    expect(r.ctx.player.leanSide).toBe(0);
    r.held.delete("MoveRight");
    r.tick(); // release edge sets the step
    r.held.add("MoveRight");
    r.tick(7);
    expect(r.ctx.player.leanSide).toBeCloseTo(0.85, 5);
  });

  it("opens the map computer crouched and closes it on the next MapComputer press", async () => {
    const r = await rig();
    r.player.openMapComputer();
    expect(r.events).toEqual([{ open: true }]);
    expect(r.player.movementState).toBe(S.mapComputer);
    expect(r.player.mapComputerOpen).toBe(true);
    expect(r.ctx.player.crouching).toBe(true);
    r.held.add("MoveUp");
    r.tick(5);
    expect(r.player.movementState).toBe(S.mapComputer);
    r.held.add("MapComputer");
    r.tick();
    expect(r.events).toEqual([{ open: true }, { open: false }]);
    expect(r.player.movementState).toBe(S.stand);
    expect(r.ctx.player.crouching).toBe(false);
  });

  it("exposes the body pose: the state's clip and time, the root z and the pelvis", async () => {
    const r = await rig();
    r.tick(10);
    const pose = r.player.bodyPose()!;
    expect(pose.clipId).toBe(PLAYER_CLIP_SLOTS[S.stand].clip);
    expect(pose.loop).toBe(true);
    expect(pose.time).toBeGreaterThan(0);
    expect(pose.rootZ / 4096).toBeCloseTo(0.95, 1);
    expect(pose.pelvis[1] - pose.rootZ / 4096).toBeCloseTo(r.ctx.player.position[1], 1);
    expect(pose.crouched).toBe(false);
    r.held.add("Crouch");
    r.tick(2);
    expect(r.player.bodyPose()).toMatchObject({ clipId: PLAYER_CLIP_SLOTS[S.crouch].clip, crouched: true });
  });

  it("is carried by a moving platform task and turns with it; a jump keeps its motion", async () => {
    const r = await rig({ platform: true });
    const world = r.ctx.world!;
    const x0 = r.ctx.player.position[0];
    for (let k = 1; k <= 10; k++) {
      world.setBodyTransform(5, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.1 * k, 0, 0, 1]);
      r.tick();
    }
    expect(r.ctx.player.position[0] - x0).toBeCloseTo(1, 2);
    expect(r.ctx.player.grounded).toBe(true);
    // A small turn about the task origin turns the heading by the same angle (FUN_0045fd00).
    const yaw0 = r.ctx.player.yaw;
    const a = 0.05;
    world.setBodyTransform(5, [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 1, 0, 0, 1]);
    r.tick();
    expect(r.ctx.player.yaw - yaw0).toBeCloseTo(a, 6);
    // Moving again at 0.1 m/tick, the jump's air velocity includes the platform's.
    world.setBodyTransform(5, [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 1.1, 0, 0, 1]);
    r.tick(12); // the stand clip's blend is over
    for (let k = 2; k <= 4; k++) {
      world.setBodyTransform(5, [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 1 + 0.1 * k, 0, 0, 1]);
      r.tick();
    }
    world.setBodyTransform(5, [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 1.5, 0, 0, 1]);
    r.held.add("Jump");
    r.tick();
    expect(r.player.movementState).toBe(S.jump);
    expect(r.ctx.player.velocity[0]).toBeCloseTo(3, 1); // 0.1 m/tick carried into the jump
  });

  it("adds explosion knock-back that decays x0.9 per tick", async () => {
    const r = await rig();
    const x0 = r.ctx.player.position[0];
    r.player.addKnock([0.1, 0, 0]);
    r.tick();
    const d1 = r.ctx.player.position[0] - x0;
    expect(d1).toBeGreaterThan(0.08);
    r.tick();
    const d2 = r.ctx.player.position[0] - x0 - d1;
    expect(d2 / d1).toBeCloseTo(0.9, 2);
  });
});

// --- weapon machine hooks (level-1 data) -----------------------------------------------------

const haveLevel = existsSync(`${RAW_ROOT}/missions/location0/level1`) || existsSync(`${RAW_ROOT}/common/anims/005.iff`);

describe.skipIf(!haveLevel)("weapon S5 / S11 hooks into the movement graph", () => {
  let level: IgiLevel;
  beforeAll(async () => {
    level = await loadIgiLevel(createFsAssetSource(RAW_ROOT));
  }, 60000);

  function weaponRig() {
    const held = new Set<string>();
    const calls: string[] = [];
    let movement = 0;
    const playerStub = {
      interactions: { weaponHolstered: false },
      get movementState() {
        return movement;
      },
      beginLean: () => {
        calls.push("beginLean");
        movement = 44;
      },
      endLean: () => {
        calls.push("endLean");
        movement = 0;
      },
      openMapComputer: () => {
        calls.push("openMapComputer");
        movement = 45;
      },
    };
    const ctx = {
      level,
      world: null,
      events: new EventBus(),
      input: { get isFiring() { return held.has("Fire"); }, action: (a: string) => held.has(a), actionPressed: () => false, forward: 0, strafe: 0 },
      rng: { float: () => 0.5, int: () => 0 },
      player: {
        position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0, grounded: true, crouching: false, running: false, health: 3, maxHealth: 3,
        alive: true, walking: false, eyeHeight: 1.64, kickPitch: 0, kickYaw: 0, leanSide: 0, leanUp: 0,
      },
      weapon: null,
      systems: { weapon: null, enemies: null, objectives: null, audio: null, hud: null, effects: null, tasks: null, player: playerStub },
      running: true,
      camera: new THREE.PerspectiveCamera(),
    } as unknown as GameContext;
    const ws = createWeaponSystem(ctx);
    ws.reset();
    return { ws, held, calls, closeMap: () => (movement = 0) };
  }

  it("enters the lean only from S1: Peek held while the knife is raised waits for S1, release ends it", () => {
    const r = weaponRig();
    r.held.add("Peek");
    for (let i = 0; i < 24; i++) r.ws.update(1 / 30);
    expect(r.calls).toEqual([]); // S4 raising the first weapon
    for (let i = 0; i < 3 && r.ws.state !== WEAPON_STATE.peek; i++) r.ws.update(1 / 30);
    expect(r.ws.state).toBe(WEAPON_STATE.peek);
    expect(r.calls).toEqual(["beginLean"]);
    r.ws.update(1 / 30);
    expect(r.calls).toEqual(["beginLean"]);
    r.held.delete("Peek");
    r.ws.update(1 / 30);
    expect(r.calls).toEqual(["beginLean", "endLean"]);
    expect(r.ws.state).toBe(WEAPON_STATE.ready);
  });

  it("does not lean while stabbing (S9); the lean starts when S1 is back", () => {
    const r = weaponRig();
    for (let i = 0; i < 26; i++) r.ws.update(1 / 30);
    expect(r.ws.state).toBe(WEAPON_STATE.ready);
    r.held.add("Fire");
    r.ws.update(1 / 30);
    expect(r.ws.state).toBe(WEAPON_STATE.knife);
    r.held.delete("Fire");
    r.held.add("Peek");
    r.ws.update(1 / 30);
    expect(r.calls).toEqual([]);
    for (let i = 0; i < 60 && r.ws.state !== WEAPON_STATE.peek; i++) r.ws.update(1 / 30);
    expect(r.ws.state).toBe(WEAPON_STATE.peek);
    expect(r.calls).toEqual(["beginLean"]);
  });

  it("opens the map computer on a MapComputer press in S1 and returns to S1 once the movement leaves 45", () => {
    const r = weaponRig();
    for (let i = 0; i < 26; i++) r.ws.update(1 / 30);
    r.held.add("MapComputer");
    r.ws.update(1 / 30);
    expect(r.ws.state).toBe(WEAPON_STATE.mapComputer);
    expect(r.calls).toEqual(["openMapComputer"]);
    r.ws.update(1 / 30);
    expect(r.ws.state).toBe(WEAPON_STATE.mapComputer);
    r.closeMap();
    r.ws.update(1 / 30);
    expect(r.ws.state).toBe(WEAPON_STATE.ready);
    // Still held: no second press edge.
    r.ws.update(1 / 30);
    expect(r.calls).toEqual(["openMapComputer"]);
  });
});

describe.skipIf(!haveAnims)("player death (state 47, FUN_0040e660 / FUN_0040e720)", () => {
  it("plays the zone record's death clip [rand(2)], announces the state and holds once grounded and finished", async () => {
    const r = await rig();
    const draws: number[] = [];
    (r.ctx as unknown as { rng: unknown }).rng = { float: () => 0.5, int: (n: number) => (draws.push(n), 1) };
    const announced: unknown[] = [];
    r.ctx.events.on("game:player-death-state", (p) => announced.push(p));
    r.tick(5);
    r.player.damage(10, [1, 0, 0], 16); // zone 16: record clips (204, 204)
    expect(r.ctx.player.alive).toBe(false);
    r.tick(1);
    expect(draws).toEqual([2]);
    expect(announced).toEqual([{ clip: 204 }]);
    expect(r.player.bodyPose()!.clipId).toBe(204);
    expect(r.player.movementState).toBe(47);
    // The clip runs to its end on the ground; the pose then holds.
    r.tick(400);
    const a = r.player.bodyPose()!;
    r.tick(5);
    expect(r.player.bodyPose()!.time).toBe(a.time);
  });

  it("uses zone 13's clips (201 / 202) for fall and explosion damage", async () => {
    const r = await rig();
    (r.ctx as unknown as { rng: unknown }).rng = { float: () => 0.5, int: () => 0 };
    r.tick(3);
    r.player.damage(10);
    r.tick(1);
    expect(r.player.bodyPose()!.clipId).toBe(201);
  });
});
