/**
 * The player's movement state graph (HumanPlayer, graph object human+0x2ec),
 * as igi.exe runs it (docs/gameplay.md "Player movement state graph").
 *
 * Recovered [igi.exe]:
 *   - The HumanPlayer constructor (0x41059c) calls FUN_004e2d10(human+0x2ec,
 *     pre-update FUN_004106b0, entry table 0x53660c, initial state 0, two
 *     input combos at 0x536768). The first run calls entry 0 (the enter
 *     function is installed as the first tick); every later run calls the
 *     pre-update, the combo matcher and the installed tick (FUN_004e2d60).
 *   - A tick that switches state stores previous = state, state = n, calls
 *     entry n at once; the entry plays the clip slot (FUN_00488290, slot =
 *     state id, table 0x5368c8 = PLAYER_CLIP_SLOTS) and installs the tick,
 *     which first runs on the next game tick: at most one transition per tick.
 *   - Condition bits (graph +8 = human+0x2f4), FUN_004106b0: kept from the
 *     previous tick `& 0xfff7001c` (0x4 grounded and 0x10 roof from the
 *     move FUN_004600f0, 0x20000 dead from FUN_00408530 / the damage code),
 *     then 0x1 bone 0 finished (flag 0x100), 0x2 blending (0x10000),
 *     0x40000 walking flag human+0xd45, and one bit per held input channel:
 *     0x20 ch2 MoveLeft, 0x40 ch3 MoveRight, 0x80 ch4 MoveUp, 0x100 ch5
 *     MoveDown, 0x200 ch6 Fire, 0x400 ch7 AlternateFire, 0x800 ch8 Reload,
 *     0x1000 ch9 Activate, 0x2000 ch10 Crouch, 0x4000 ch11 Jump, 0x80000
 *     ch21 NextWeapon. Channels are the held state of the bound keys
 *     (FUN_0045cde0 from the action mask built at 0x4e3bb4: no toggles), so
 *     Crouch is held, not toggled.
 *   - Jump is the edge of ch11 (current +0x1dc != 0, previous +0x13c == 0),
 *     read directly by the ticks of states 0-16.
 *   - The two combos (0x536708: Fire tap-release-tap-release, 0x536738:
 *     NextWeapon twice, 6-tick windows) set graph +0x1c; no player code
 *     reads it.
 */

/** Movement states (entries of the table at 0x53660c). */
export const PLAYER_STATE = {
  stand: 0,
  runForward: 1, runForwardRight: 2, runForwardLeft: 3, runBack: 4, runBackRight: 5, runBackLeft: 6, runRight: 7, runLeft: 8,
  walkForward: 9, walkForwardRight: 10, walkForwardLeft: 11, walkBack: 12, walkBackRight: 13, walkBackLeft: 14, walkRight: 15, walkLeft: 16,
  crouchDown: 17, standUp: 18, crouch: 19,
  crouchForward: 20, crouchForwardRight: 21, crouchForwardLeft: 22, crouchBack: 23, crouchBackRight: 24, crouchBackLeft: 25,
  crouchRight: 26, crouchLeft: 27,
  jump: 28, fall: 29,
  /** 30-36: use objects (lock pick, cabinet, terminal, stationary gun, ?, TBA, explosive; docs/interactions.md). */
  lockPick: 30, cabinet: 31, terminal: 32, tba: 35, placeExplosive: 36,
  /** 37-43: ladder climb / mount top / exit top / slide, fence, wire traverse / slide (player/attach.ts). */
  ladderClimb: 37, ladderMountTop: 38, ladderExitTop: 39, ladderSlide: 40, fence: 41, wireTraverse: 42, wireSlide: 43,
  lean: 44,
  mapComputer: 45,
  hit: 46,
  dead: 47,
  /** Debug fly, toggled by channel 33, which FUN_0045cde0 always writes 0 for the player: unreachable. */
  debugFly: 48,
} as const;

/** Condition bits of the graph (FUN_004106b0). */
export const COND = {
  finished: 0x1,
  blending: 0x2,
  grounded: 0x4,
  roof: 0x10,
  left: 0x20,
  right: 0x40,
  forward: 0x80,
  back: 0x100,
  fire: 0x200,
  altFire: 0x400,
  reload: 0x800,
  activate: 0x1000,
  crouch: 0x2000,
  jump: 0x4000,
  hit: 0x10000,
  dead: 0x20000,
  walking: 0x40000,
  nextWeapon: 0x80000,
} as const;

/** The player's input channels a tick reads (held state; FUN_0045cde0). */
export interface PlayerChannels {
  left: boolean;
  right: boolean;
  forward: boolean;
  back: boolean;
  fire: boolean;
  altFire: boolean;
  reload: boolean;
  activate: boolean;
  crouch: boolean;
  jump: boolean;
  peek: boolean;
  walkToggle: boolean;
  nextWeapon: boolean;
  mapComputer: boolean;
}

export const NO_CHANNELS: PlayerChannels = {
  left: false, right: false, forward: false, back: false, fire: false, altFire: false, reload: false, activate: false,
  crouch: false, jump: false, peek: false, walkToggle: false, nextWeapon: false, mapComputer: false,
};

/** The flags FUN_004106b0 combines with the channels. */
export interface GraphFlags {
  grounded: boolean;
  roof: boolean;
  finished: boolean;
  blending: boolean;
  walking: boolean;
  dead: boolean;
  hit?: boolean;
}

/** FUN_004106b0: the condition bits for this tick. */
export function conditionBits(f: GraphFlags, ch: PlayerChannels): number {
  let b = 0;
  if (f.grounded) b |= COND.grounded;
  if (f.roof) b |= COND.roof;
  if (f.finished) b |= COND.finished;
  if (f.blending) b |= COND.blending;
  if (f.walking) b |= COND.walking;
  if (f.dead) b |= COND.dead;
  if (f.hit) b |= COND.hit;
  if (ch.left) b |= COND.left;
  if (ch.right) b |= COND.right;
  if (ch.forward) b |= COND.forward;
  if (ch.back) b |= COND.back;
  if (ch.fire) b |= COND.fire;
  if (ch.altFire) b |= COND.altFire;
  if (ch.reload) b |= COND.reload;
  if (ch.activate) b |= COND.activate;
  if (ch.crouch) b |= COND.crouch;
  if (ch.jump) b |= COND.jump;
  if (ch.nextWeapon) b |= COND.nextWeapon;
  return b;
}

/** What a state's enter function does besides installing its tick. */
export interface StateEntry {
  /** Enter function (table 0x53660c). */
  enter: number;
  /** Tick function it installs. */
  tick: number;
  /** Low-profile flag human+0x33d written by the enter (null: unchanged). */
  crouched: boolean | null;
  /** Blend seconds passed to FUN_00488290 (0x3e4ccccd = 0.2). */
  blend: number;
  /** Blend 0 instead when the previous state is the jump 28 (the landing). */
  instantAfterJump?: boolean;
  /** Previous states whose stride phase the new clip keeps (FUN_004ccbb0 -> FUN_004ccc40). */
  phaseFrom?: readonly number[];
  /** FUN_00413a00: arms mode wanted by the movement (human+0xd5c); null: unchanged. */
  armsMode: number | null;
}

const run = (enter: number, tick: number, phaseFrom: readonly number[] | undefined, instantAfterJump = false): StateEntry => ({
  enter, tick, crouched: false, blend: 0.2, instantAfterJump, phaseFrom, armsMode: 3,
});
const walk = (enter: number, tick: number, phaseFrom: readonly number[]): StateEntry => ({
  enter, tick, crouched: false, blend: 0.2, phaseFrom, armsMode: 2,
});
const low = (enter: number, tick: number, phaseFrom: readonly number[]): StateEntry => ({
  enter, tick, crouched: true, blend: 0.2, phaseFrom, armsMode: 5,
});

/**
 * Enter functions of the ground states 0-29, 44, 45 and 48 [recovered].
 * (States 30-43 are the use objects and attachments: player/interact.ts,
 * player/attach.ts; 46 / 47 play hit-zone clips.)
 */
export const STATE_ENTRIES: Readonly<Record<number, StateEntry>> = {
  0: { enter: 0x408880, tick: 0x4088c0, crouched: false, blend: 0.2, armsMode: 1 },
  1: run(0x408b50, 0x408bb0, undefined, true),
  2: run(0x408d40, 0x408d90, undefined),
  3: run(0x408f00, 0x408f80, [1, 11, 22]),
  4: run(0x4090f0, 0x4091a0, [5, 6, 12, 23], true),
  5: run(0x409330, 0x4093b0, [4, 13, 24]),
  6: run(0x409520, 0x4095a0, [4, 14, 25]),
  7: run(0x409710, 0x409770, undefined, true),
  8: run(0x409900, 0x409960, undefined, true),
  9: walk(0x409af0, 0x409b90, [1, 10, 11, 20]),
  10: walk(0x409d20, 0x409da0, [2, 9, 21]),
  11: walk(0x409f10, 0x409f90, [3, 9, 22]),
  12: walk(0x40a100, 0x40a1a0, [4, 13, 14, 23]),
  13: walk(0x40a330, 0x40a3b0, [5, 12, 24]),
  14: walk(0x40a520, 0x40a5a0, [6, 12, 25]),
  15: walk(0x40a710, 0x40a780, [26]),
  16: walk(0x40a910, 0x40a980, [27]),
  17: { enter: 0x40ab10, tick: 0x40ab40, crouched: false, blend: 0.2, armsMode: null },
  18: { enter: 0x40aba0, tick: 0x40abd0, crouched: false, blend: 0.2, armsMode: null },
  19: { enter: 0x40ac30, tick: 0x40ac70, crouched: true, blend: 0.2, armsMode: 4 },
  20: low(0x40adc0, 0x40ae30, [1]),
  21: low(0x40af80, 0x40b000, [2, 20, 26]),
  22: low(0x40b130, 0x40b1b0, [3, 20, 27]),
  23: low(0x40b2e0, 0x40b350, [12]),
  24: low(0x40b4a0, 0x40b520, [5, 13, 23]),
  25: low(0x40b650, 0x40b6d0, [6, 14, 23]),
  26: low(0x40b800, 0x40b870, [7]),
  27: low(0x40b9c0, 0x40ba30, [8]),
  28: { enter: 0x40bb80, tick: 0x40bce0, crouched: false, blend: 0, armsMode: null },
  29: { enter: 0x40bec0, tick: 0x40bf50, crouched: false, blend: 0, armsMode: null },
  44: { enter: 0x40e070, tick: 0x40e0c0, crouched: null, blend: 0.2, armsMode: null },
  45: { enter: 0x40e470, tick: 0x40e4c0, crouched: true, blend: 0.2, armsMode: 4 },
  48: { enter: 0x40e7f0, tick: 0x40e850, crouched: false, blend: 0.2, armsMode: null },
};

type Test = (bits: number, jumpPressed: boolean) => boolean;
type Rule = readonly [Test, number | ((bits: number) => number)];

const on = (mask: number): Test => (b) => (b & mask) !== 0;
const off = (mask: number): Test => (b) => (b & mask) === 0;
const both = (a: Test, c: Test): Test => (b, j) => a(b, j) && c(b, j);
const JUMP: Test = (_b, j) => j;
/** Neither Crouch held nor the "Roof!" flag: stand up (`(bits & 0x2010) == 0`). */
const STAND_UP: Test = off(COND.crouch | COND.roof);
const { grounded: G, hit: HIT, dead: DEAD, walking: W, forward: F, back: BK, left: L, right: R, crouch: C, finished: FIN } = COND;
const byWalking = (walkState: number, runState: number) => (b: number) => ((b & W) !== 0 ? walkState : runState);

/** Every ground state first tests: not grounded -> fall 29; hit -> 46; dead -> 47. */
const FIRST: readonly Rule[] = [[off(G), 29], [on(HIT), 46], [on(DEAD), 47]];

/**
 * Tick functions of the ground states 0-27 as ordered rule lists (first
 * match wins) [recovered from the decompiled ticks and checked against the
 * disassembly]. Quirks kept as the exe has them: walk forward 9 goes to the
 * RUN diagonals 2 / 3 (their tick then sees the walking flag and goes on to
 * 10 / 11 one tick later); walk back-right 13 without MoveDown goes to run
 * right 7 (then 15); walk back-left 14 without MoveDown goes to walk RIGHT
 * 15 (then 0 / 16); walk back diagonals 13 / 14 crouch into crouch back 23.
 * The run state 1 (forward), 2, 7 and 8 compute the old phase but discard
 * it (no stride sync).
 */
export const TICK_RULES: Readonly<Record<number, readonly Rule[]>> = {
  0: [
    ...FIRST,
    [both(off(W), on(F)), 1], [both(off(W), on(BK)), 4], [both(off(W), on(R)), 7], [both(off(W), on(L)), 8],
    [both(on(W), on(F)), 9], [both(on(W), on(BK)), 12], [both(on(W), on(R)), 15], [both(on(W), on(L)), 16],
    [JUMP, 28], [on(C), 19],
  ],
  1: [...FIRST, [on(W), 9], [JUMP, 28], [on(R), 2], [on(L), 3], [off(F), 0], [on(C), 20]],
  2: [...FIRST, [on(W), 10], [JUMP, 28], [off(F), 7], [off(R), 1], [on(C), 21]],
  3: [...FIRST, [on(W), 11], [JUMP, 28], [off(F), 8], [off(L), 1], [on(C), 22]],
  4: [...FIRST, [on(W), 12], [JUMP, 28], [on(R), 5], [on(L), 6], [off(BK), 0], [on(C), 23]],
  5: [...FIRST, [on(W), 13], [JUMP, 28], [off(BK), 7], [off(R), 4], [on(C), 24]],
  6: [...FIRST, [on(W), 14], [JUMP, 28], [off(BK), 8], [off(L), 4], [on(C), 25]],
  7: [...FIRST, [on(W), 15], [JUMP, 28], [off(R), 0], [on(F), 2], [on(BK), 5], [on(C), 26]],
  8: [...FIRST, [on(W), 16], [JUMP, 28], [off(L), 0], [on(F), 3], [on(BK), 6], [on(C), 27]],
  9: [...FIRST, [off(W), 1], [JUMP, 28], [on(R), 2], [on(L), 3], [off(F), 0], [on(C), 20]],
  10: [...FIRST, [off(W), 2], [JUMP, 28], [off(F), 15], [off(R), 9], [on(C), 21]],
  11: [...FIRST, [off(W), 3], [JUMP, 28], [off(F), 16], [off(L), 9], [on(C), 22]],
  12: [...FIRST, [off(W), 4], [JUMP, 28], [on(R), 13], [on(L), 14], [off(BK), 0], [on(C), 23]],
  13: [...FIRST, [off(W), 5], [JUMP, 28], [off(BK), 7], [off(R), 12], [on(C), 23]],
  14: [...FIRST, [off(W), 6], [JUMP, 28], [off(BK), 15], [off(L), 12], [on(C), 23]],
  15: [...FIRST, [off(W), 7], [JUMP, 28], [off(R), 0], [on(F), 10], [on(BK), 13], [on(C), 26]],
  16: [...FIRST, [off(W), 8], [JUMP, 28], [off(L), 0], [on(F), 11], [on(BK), 14], [on(C), 27]],
  17: [[off(G), 29], [on(FIN), 19]],
  18: [[off(G), 29], [on(FIN), 0]],
  19: [...FIRST, [on(R), 26], [on(L), 27], [STAND_UP, 0], [on(F), 20], [on(BK), 23]],
  20: [...FIRST, [on(R), 21], [on(L), 22], [off(F), 19], [STAND_UP, byWalking(9, 1)]],
  21: [...FIRST, [off(R), 20], [off(F), 26], [STAND_UP, byWalking(10, 2)]],
  22: [...FIRST, [off(L), 20], [off(F), 27], [STAND_UP, byWalking(11, 3)]],
  23: [...FIRST, [on(R), 24], [on(L), 25], [off(BK), 19], [STAND_UP, byWalking(12, 4)]],
  24: [...FIRST, [off(BK), 26], [off(R), 23], [STAND_UP, byWalking(13, 5)]],
  25: [...FIRST, [off(BK), 27], [off(L), 23], [STAND_UP, byWalking(14, 6)]],
  26: [...FIRST, [off(R), 19], [on(F), 21], [on(BK), 24], [STAND_UP, byWalking(15, 7)]],
  27: [...FIRST, [off(L), 19], [on(F), 22], [on(BK), 25], [STAND_UP, byWalking(16, 8)]],
};

/** One tick of ground state `state` (0-27): the state to switch to, or null to stay. */
export function groundTransition(state: number, bits: number, jumpPressed: boolean): number | null {
  const rules = TICK_RULES[state];
  if (!rules) return null;
  for (const [test, target] of rules) {
    if (test(bits, jumpPressed)) return typeof target === "number" ? target : target(bits);
  }
  return null;
}

/**
 * Jump tick FUN_0040bce0 once grounded: the landing goes to the move state
 * of the held direction (MoveUp, then MoveDown, MoveRight, MoveLeft) by the
 * walking flag, else stand 0. The fall tick FUN_0040bf50 always lands in 0.
 */
export function landingState(bits: number): number {
  const walking = (bits & W) !== 0;
  if (bits & F) return walking ? 9 : 1;
  if (bits & BK) return walking ? 12 : 4;
  if (bits & R) return walking ? 15 : 7;
  if (bits & L) return walking ? 16 : 8;
  return 0;
}

// ---------------------------------------------------------------------------
// Lean (state 44, FUN_0040e0c0)
// ---------------------------------------------------------------------------

/**
 * The lean values of the HumanView (human+0x4ec), IGI units: +0x19c side
 * (+ right), +0x1a4 up, +0x1a8 side step, +0x1b0 up step. The view's
 * constructor FUN_00462fe0 zeroes all four (0x463038-0x463056).
 */
export interface LeanState {
  side: number;
  up: number;
  sideStep: number;
  upStep: number;
}

export function createLeanState(): LeanState {
  return { side: 0, up: 0, sideStep: 0, upStep: 0 };
}

/** DefineHumanPlayerGeneral args 4-6 as FUN_00410160 stores them. */
export interface LeanParams {
  /** DAT_0056a368: float32(arg 4 x 4096.0). */
  side: number;
  /** DAT_0056a36c: float32(arg 5 x 4096.0). */
  up: number;
  /** DAT_0056a370: FISTP(arg 6 x 30.0), chop (7 for 0.25 s). */
  ticks: number;
}

/** Store float32 of d / ticks (fild ticks; fdivr d; fstp). */
const stepOf = (d: number, ticks: number) => Math.fround(d / ticks);

/**
 * One axis toward `target` by `step`, as the lean tick writes it: the sum is
 * stored float32 (fst) and the clamp compares the unrounded x87 result.
 */
function toward(value: number, target: number, step: number): number {
  if (target <= value) {
    if (target < value) {
      const x = value - step;
      return x < target ? target : Math.fround(x);
    }
    return value;
  }
  const x = step + value;
  return x > target ? target : Math.fround(x);
}

/**
 * FUN_0040e0c0, one tick of the lean state 44 [recovered]:
 *   - MoveLeft held: on its press edge (previous +0x118 == 0) the side step
 *     becomes d / ticks; side moves by the step toward -d and clamps there;
 *   - MoveRight held: the same toward +d (both held: left then right);
 *   - neither held: if either was held last tick the step is set again;
 *     side returns toward 0 by the step;
 *   - crouched only (+0x33d): MoveUp held -> up toward DAT_0056a36c, the up
 *     step set on its press edge; not held -> back toward 0, the step set
 *     on its release edge.
 * A key already held when the lean starts has no edge: the step keeps its
 * old value (0 until the first edge since the view was created).
 */
export function leanTick(lean: LeanState, cur: PlayerChannels, prev: PlayerChannels, crouched: boolean, p: LeanParams): void {
  const d = p.side;
  if (cur.left) {
    if (!prev.left) lean.sideStep = stepOf(d, p.ticks);
    lean.side = toward(lean.side, -d, lean.sideStep);
  }
  if (cur.right) {
    if (!prev.right) lean.sideStep = stepOf(d, p.ticks);
    lean.side = toward(lean.side, d, lean.sideStep);
  }
  if (!cur.left && !cur.right) {
    if (prev.left || prev.right) lean.sideStep = stepOf(d, p.ticks);
    lean.side = toward(lean.side, 0, lean.sideStep);
  }
  if (!crouched) return;
  if (!cur.forward) {
    if (prev.forward) lean.upStep = stepOf(p.up, p.ticks);
    lean.up = toward(lean.up, 0, lean.upStep);
  } else {
    if (!prev.forward) lean.upStep = stepOf(p.up, p.ticks);
    lean.up = toward(lean.up, p.up, lean.upStep);
  }
}
