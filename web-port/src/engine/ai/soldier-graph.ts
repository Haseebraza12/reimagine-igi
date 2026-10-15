/**
 * The HumanSoldier body state graph of igi.exe (docs/characters.md
 * "Soldier state graph", docs/ai.md 4.3). Pure data and rules; SoldierMotor
 * (motor.ts) runs it.
 *
 * Recovered (Ghidra names, image base 0x400000):
 *   - The graph object is human+0x2ec, built by FUN_004e2d10(graph,
 *     pre-update 0x45b6a0, entry table 0x53cbc0, state 0, 1 sequence,
 *     0x53cc88) in the HumanSoldier constructor (0x45b64b). Layout: +0
 *     pre-update, +4 entry table, +8 condition bits (human+0x2f4), +0xc
 *     previous state, +0x10 state (human+0x2fc, the "body state" the AI reads
 *     through table 0x53f4fc), +0x14 the running state's tick function.
 *   - FUN_004e2d60 runs it once per soldier tick from FUN_0045bd00: the
 *     pre-update (FUN_0045b6a0) recomputes the input bits, then the current
 *     tick function runs. A tick that changes state stores previous/state,
 *     installs entry[state] and calls it at once; the entry plays the clip
 *     and installs the state's own tick function, which first runs on the
 *     next game tick (at most one transition per tick).
 *   - Entries play action-table slot = state (FUN_00488290 -> FUN_004cc860
 *     with blend 0: soldiers never blend; every entry restarts its clip).
 *   - The one gesture sequence (0x53cc58: press, release, press, release
 *     of bit 0x200 within 4 ticks each) is detected but nothing in the
 *     HumanSoldier reads its result (graph +0x1c).
 */

/** Condition bits (graph +8 = human+0x2f4) [recovered FUN_0045b6a0 and the users named]. */
export const COND = {
  /** Bone 0's clip reached its end this advance (flag 0x100; set at every loop wrap too, FUN_004cb1f0). */
  FINISHED: 0x1,
  /** Bone 0 is blending (flag 0x10000); soldiers never blend. */
  BLENDING: 0x2,
  /** Standing on ground (FUN_004600f0). */
  GROUNDED: 0x4,
  /** Low roof above ("Roof!", FUN_004606b0): forces kneeling. */
  ROOF: 0x10,
  LEFT: 0x20, // channel 2
  RIGHT: 0x40, // channel 3
  FORWARD: 0x80, // channel 4
  BACK: 0x100, // channel 5
  FIRE: 0x200, // channel 6
  CH7: 0x400,
  RELOAD: 0x800, // channel 8
  CH9: 0x1000,
  /** Damage since the last flinch exceeded "Recoil threshold" (FUN_0045bfe0 / FUN_004592a0 / FUN_0045c1a0); cleared after every graph run. */
  FLINCH: 0x10000,
  /** Accumulated damage reached the maximum (same functions); never cleared. */
  DEAD: 0x20000,
  /** Walking flag human+0xd00 (channel 20 toggles it after the graph run). */
  WALKING: 0x40000,
  KNEEL: 0x80000, // channel 21
  LIEDOWN: 0x100000, // channel 22
  /** Channel 23: human+0xd0c = fistp(channel 23) (chop: truncation). */
  ANIMATION: 0x200000,
  USE: 0x400000, // channel 24
  PANIC: 0x800000, // channel 25
  CH26: 0x1000000, // channel 26
  AIM: 0x2000000, // channel 27
  GRENADE: 0x4000000, // channel 29
  CLOSE_COMBAT: 0x8000000, // channel 30
} as const;

/** Bits the pre-update keeps from the previous tick (`bits & 0xf003e01c`, FUN_0045b6a0). */
export const COND_KEEP = 0xf003e01c;

/** Bits that end a scripted animation (FUN_0045b230: `bits & 0xfd81fe1`). */
export const COND_ANIMATION_EXIT = 0xfd81fe1;

/** The 38 states = handler / action-table index [recovered 0x53cbc0, meanings from the clips and transitions]. */
export const SOLDIER_STATE = {
  STAND: 0,
  RUN_PANIC: 1,
  RUN: 2,
  WALK: 3,
  ROLL_LEFT: 4,
  ROLL_RIGHT: 5,
  FIRE: 6,
  RELOAD: 7,
  GRENADE: 8,
  CLOSE_COMBAT: 9,
  AIM: 10,
  RAISE: 11,
  LOWER: 12,
  TO_KNEEL: 13,
  KNEEL_TO_STAND: 14,
  DIVE: 15,
  PRONE_TO_STAND: 16,
  RUN_GUN: 17,
  RUN_FIRE: 18,
  KNEEL: 19,
  KNEEL_ROLL_LEFT: 20,
  KNEEL_ROLL_RIGHT: 21,
  KNEEL_FIRE: 22,
  KNEEL_RELOAD: 23,
  KNEEL_AIM: 24,
  KNEEL_TO_PRONE: 25,
  PRONE: 26,
  PRONE_FIRE: 27,
  PRONE_RELOAD: 28,
  FALL: 29,
  FLINCH: 30,
  PRONE_FLINCH: 31,
  DEATH_STAND: 32,
  DEATH_KNEEL: 33,
  DEATH_PRONE: 34,
  ANIMATION: 35,
  STATIONARY_GUN: 36,
  USE: 37,
} as const;

const S = SOLDIER_STATE;

export interface SoldierStateInfo {
  name: string;
  /** Entry handler (table 0x53cbc0) and tick function it installs [recovered]. */
  entry: number;
  tick: number;
  /** human+0x33d (low-profile flag: sweep heights, eye / aim height, quiet footsteps) set by the entry; null = unchanged. */
  crouch: 0 | 1 | null;
}

const I = (name: string, entry: number, tick: number, crouch: 0 | 1 | null): SoldierStateInfo => ({ name, entry, tick, crouch });

/** Per-state entry / tick addresses and the crouch flag each entry writes [recovered]. */
export const SOLDIER_STATES: readonly SoldierStateInfo[] = [
  I("stand", 0x459620, 0x4596d0, 0),
  I("panic run", 0x459980, 0x459a00, 0),
  I("run", 0x459cc0, 0x459d30, 0),
  I("walk", 0x459f80, 0x456ce0, 0),
  I("roll left", 0x459ff0, 0x45a050, 1),
  I("roll right", 0x45a020, 0x45a050, 1),
  I("fire", 0x45a0e0, 0x456fc0, 1),
  I("reload", 0x45a110, 0x457120, null),
  I("throw grenade", 0x45a140, 0x45a170, null),
  I("close combat", 0x45a380, 0x45a3b0, null),
  I("aim", 0x45a530, 0x457430, 0),
  I("raise to aim", 0x45a560, 0x45a590, 0),
  I("lower", 0x45a640, 0x457570, 0),
  I("stand to kneel", 0x45a670, 0x45a050, 0),
  I("kneel to stand", 0x45a6a0, 0x45a6d0, 0),
  I("dive prone", 0x45a760, 0x45a790, 0),
  I("prone to stand", 0x45a820, 0x45a850, 0),
  I("combat run", 0x459c20, 0x456840, 0),
  I("combat run firing", 0x459c90, 0x456a60, 1),
  I("kneel", 0x45a8e0, 0x457920, 1),
  I("kneel roll left", 0x45a910, 0x45a050, 1),
  I("kneel roll right", 0x45a940, 0x45a050, 1),
  I("kneel fire", 0x45a970, 0x457be0, null),
  I("kneel reload", 0x45a9a0, 0x457d10, null),
  I("kneel aim", 0x45a9d0, 0x457e10, null),
  I("kneel to prone", 0x45aa00, 0x45aa30, 1),
  I("prone", 0x45aac0, 0x458000, 0),
  I("prone fire", 0x45aaf0, 0x458130, null),
  I("prone reload", 0x45ab20, 0x45ab50, null),
  I("fall", 0x45ac20, 0x45ac70, 0),
  I("flinch", 0x45ad40, 0x4582d0, 0),
  I("prone flinch", 0x45ad90, 0x45add0, 0),
  I("standing death", 0x45aea0, 0x45b160, 0),
  I("kneeling death", 0x45b000, 0x45b160, 0),
  I("prone death", 0x45b0b0, 0x45b160, 0),
  I("scripted animation", 0x45b1a0, 0x45b230, null),
  I("stationary gun", 0x45b300, 0x458830, null),
  I("use", 0x45b400, 0x45b430, null),
];

export interface SoldierActionEntry {
  clip: number;
  loop: boolean;
}

const table = (pairs: ReadonlyArray<readonly [number, number]>): SoldierActionEntry[] => pairs.map(([clip, loop]) => ({ clip, loop: loop === 1 }));

/**
 * HumanSoldier action tables, 38 x {i32 clip, i32 loop} [recovered]. The
 * class's activation (FUN_0045bab0) picks one by HumanAI type: PRIBOI
 * (type 5) 0x53cf20, CIVILIAN (6) 0x53d050, SPETNAZ_* (23..28) 0x53cdf0,
 * every other type 0x53ccc0. Slots 30 and 32..35 are not played through the
 * table (zone flinch, deaths, scripted animation); slot 36's entry plays
 * clip 31 one-shot directly.
 */
export const SOLDIER_ACTION_TABLES = {
  /** 0x53ccc0 */
  default: table([
    [2, 1], [34, 1], [3, 1], [57, 1], [10, 0], [11, 0], [56, 1], [14, 0], [58, 0], [70, 0], [54, 0], [53, 0], [55, 0],
    [7, 0], [19, 0], [12, 0], [13, 0], [48, 1], [52, 1], [18, 0], [33, 0], [32, 0], [9, 1], [15, 0], [8, 0], [20, 0],
    [16, 0], [17, 0], [21, 0], [2, 1], [0, 0], [26, 0], [0, 0], [0, 0], [0, 0], [0, 0], [31, 1], [2, 0],
  ]),
  /** 0x53cdf0 */
  spetnaz: table([
    [62, 1], [60, 1], [60, 1], [81, 1], [10, 0], [11, 0], [63, 1], [14, 0], [58, 0], [70, 0], [80, 0], [78, 0], [79, 0],
    [7, 0], [19, 0], [12, 0], [13, 0], [48, 1], [52, 1], [18, 0], [33, 0], [32, 0], [9, 1], [15, 0], [8, 0], [20, 0],
    [16, 0], [17, 0], [21, 0], [2, 1], [0, 0], [26, 0], [0, 0], [0, 0], [0, 0], [0, 0], [31, 1], [2, 0],
  ]),
  /** 0x53cf20 */
  priboi: table([
    [64, 1], [65, 1], [65, 1], [66, 1], [10, 0], [11, 0], [69, 1], [14, 0], [58, 0], [70, 0], [5, 0], [67, 0], [68, 0],
    [7, 0], [19, 0], [12, 0], [13, 0], [48, 1], [52, 1], [18, 0], [33, 0], [32, 0], [9, 1], [15, 0], [8, 0], [20, 0],
    [16, 0], [17, 0], [21, 0], [2, 1], [0, 0], [26, 0], [0, 0], [0, 0], [0, 0], [0, 0], [31, 1], [2, 0],
  ]),
  /** 0x53d050 */
  civilian: table([
    [77, 1], [76, 1], [76, 1], [75, 1], [10, 0], [11, 0], [69, 1], [14, 0], [58, 0], [70, 0], [5, 0], [67, 0], [68, 0],
    [93, 0], [95, 0], [12, 0], [13, 0], [76, 1], [52, 1], [94, 0], [33, 0], [32, 0], [9, 1], [15, 0], [8, 0], [20, 0],
    [16, 0], [17, 0], [21, 0], [2, 1], [0, 0], [26, 0], [0, 0], [0, 0], [0, 0], [0, 0], [31, 1], [2, 0],
  ]),
} as const;

/** FUN_0045bab0: the action table for a HumanAI type name ("AITYPE_GUARD_AK"). */
export function soldierActionTable(aiType: string | null | undefined): readonly SoldierActionEntry[] {
  if (aiType === "AITYPE_PRIBOI") return SOLDIER_ACTION_TABLES.priboi;
  if (aiType === "AITYPE_CIVILIAN") return SOLDIER_ACTION_TABLES.civilian;
  if (aiType && aiType.startsWith("AITYPE_SPETNAZ_")) return SOLDIER_ACTION_TABLES.spetnaz;
  return SOLDIER_ACTION_TABLES.default;
}

export interface SoldierZoneEntry {
  /** Damage multiplier (copied to human+0x264 + 8 zone by FUN_00488250). */
  multiplier: number;
  /** Hit-reaction clip played by state 30 (FUN_0045ad40). */
  flinchClip: number;
  /** Standing-death clips for random 0 / 1, used for the head zones 15 / 16 (FUN_0045aea0). */
  deathClips: readonly [number, number];
}

/**
 * HumanSoldier hit-zone table 0x53d180 (17 x {f32 multiplier, i32 flinch
 * clip, i32 death clip, i32 death clip}) [recovered]; zones as
 * docs/gameplay.md (0..11 limbs, 12 torso, 13 torso front, 14 torso back,
 * 15 head front, 16 head).
 */
export const SOLDIER_ZONES: readonly SoldierZoneEntry[] = [
  [0.5, 44, 23], [0.75, 44, 23], [1, 44, 23],
  [0.5, 47, 28], [0.75, 47, 28], [1, 47, 28],
  [0.5, 45, 23], [0.75, 45, 23], [1, 45, 23],
  [0.5, 46, 28], [0.75, 46, 28], [1, 46, 28],
  [1, 27, 28], [1, 27, 28], [1, 27, 29], [100, 27, 30], [100, 27, 22],
].map(([multiplier, flinchClip, death]) => ({ multiplier, flinchClip, deathClips: [death, death] as const }));

/** Death types human+0xd1c [recovered FUN_004592a0 (0), FUN_0045bfe0 (1 = WEAPONTYPE_SHOTGUN, else 2), FUN_0045c1a0 (2)]. */
export const DEATH_TYPE = { EXPLOSION: 0, SHOTGUN: 1, OTHER: 2 } as const;

/** Standing bullet / melee deaths outside the head zones: {23, 22}[rand % 2] (stack array at FUN_0045aea0) [recovered]. */
export const STANDING_DEATH_CLIPS: readonly [number, number] = [23, 22];
/** Blown-down deaths (types 0 / 1): 28 facing the blast (falls back), 71 with the blast from behind (falls forward) [recovered]. */
export const BLOWN_DEATH_CLIP = { BACKWARD: 28, FORWARD: 71 } as const;
export const KNEELING_DEATH_CLIP = 24;
export const PRONE_DEATH_CLIP = 25;
/** Recoil threshold before the AI sets it: 0.33 (constructor 0x45b68a) [recovered]. */
export const DEFAULT_RECOIL_THRESHOLD = 0.33;
/** State 31 ignores new flinches for 20 ticks (FUN_0045add0) [recovered]. */
export const PRONE_FLINCH_GUARD_TICKS = 20;

/** Inputs of one state tick. */
export interface SoldierTickInput {
  /** Condition bits after the pre-update. */
  bits: number;
  /** human+0xd0c: requested scripted clip (fistp(channel 23); -1 = cancel; 0 after the entry). */
  scripted: number;
  /** human+0xd14: state-31 guard counter. */
  counter: number;
  /** Last animation event of the previous advance (human+0x538) and its clip (+0x53c); -1 = none. */
  eventTrigger: number;
  eventClip: number;
  /** The clip bone 0 plays now (FUN_004ccb50). */
  currentClip: number;
  /** HumanAI target record present (FUN_00451700: H+0x3aa8 != 0). */
  aiHasTarget: boolean;
  /** human+0xd18 / +0xd19: grenade thrown / close-combat blow done in this state. */
  thrown: boolean;
  struck: boolean;
  /** Channel 24 now and on the previous tick (state 36). */
  use: boolean;
  usePrevious: boolean;
}

export interface SoldierTickResult {
  /** New state, or -1 to stay. */
  next: number;
  /** Trigger held for the gun this tick (human+0x4d1). */
  trigger: boolean;
  /** FUN_004e8fd0(gun, 1): the clip is refilled from nothing. */
  refill: boolean;
  throwGrenade: boolean;
  /** The close-combat blow is rolled (rand <= hit probability, target required). */
  strike: boolean;
  /** FUN_00488740: upper-body aim back on (before the transition). */
  aimOn: boolean;
  /** State 29 touched the ground (landing sound, air velocity zeroed). */
  landed: boolean;
  /** Updated human+0xd14. */
  counter: number;
}

/**
 * One state tick [recovered: the tick functions listed in SOLDIER_STATES].
 * The order of the tests is the exe's; the first matching transition wins.
 * Death states (32..34) are handled by the caller (FUN_0045b160: slide, then
 * the dead hold once the clip finished).
 */
export function soldierTick(state: number, c: SoldierTickInput): SoldierTickResult {
  const b = c.bits;
  const r: SoldierTickResult = { next: -1, trigger: false, refill: false, throwGrenade: false, strike: false, aimOn: false, landed: false, counter: c.counter };
  const on = (m: number) => (b & m) !== 0;
  const grounded = on(COND.GROUNDED);
  const finished = on(COND.FINISHED);
  const go = (s: number): SoldierTickResult => {
    r.next = s;
    return r;
  };
  switch (state) {
    case S.STAND: // 0x4596d0
      if (!grounded) return go(S.FALL);
      if (on(COND.FLINCH)) return go(S.FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_STAND);
      if (on(COND.KNEEL | COND.ROOF)) return go(S.TO_KNEEL);
      if (on(COND.LIEDOWN)) return go(S.DIVE);
      if (on(COND.AIM)) return go(S.RAISE);
      if (on(COND.GRENADE)) return go(S.GRENADE);
      if (on(COND.RELOAD)) return go(S.RELOAD);
      if (on(COND.ANIMATION)) return go(S.ANIMATION);
      if (on(COND.CLOSE_COMBAT)) return go(S.CLOSE_COMBAT);
      if (on(COND.CH26) && on(COND.FORWARD)) return go(S.RUN_GUN);
      if (on(COND.PANIC) && on(COND.FORWARD)) return go(S.RUN_PANIC);
      if (on(COND.FORWARD)) return go(on(COND.WALKING) ? S.WALK : S.RUN);
      if (on(COND.LEFT)) return go(S.ROLL_LEFT);
      if (on(COND.RIGHT)) return go(S.ROLL_RIGHT);
      return r;
    case S.RUN_PANIC: // 0x459a00
      if (!grounded) return go(S.FALL);
      if (on(COND.FLINCH)) return go(S.FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_STAND);
      if (on(COND.KNEEL)) return go(S.TO_KNEEL);
      if (on(COND.LIEDOWN)) return go(S.DIVE);
      if (on(COND.AIM)) return go(S.RAISE);
      if (on(COND.GRENADE)) return go(S.GRENADE);
      if (on(COND.RELOAD)) return go(S.RELOAD);
      if (!on(COND.PANIC)) return go(on(COND.WALKING) ? S.WALK : S.RUN);
      if (on(COND.LEFT)) return go(S.ROLL_LEFT);
      if (on(COND.RIGHT)) return go(S.ROLL_RIGHT);
      if (!on(COND.FORWARD)) return go(S.STAND);
      return r;
    case S.RUN: // 0x459d30
    case S.WALK: // 0x456ce0
      if (!grounded) return go(S.FALL);
      if (on(COND.FLINCH)) return go(S.FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_STAND);
      if (on(COND.KNEEL)) return go(S.TO_KNEEL);
      if (on(COND.LIEDOWN)) return go(S.DIVE);
      if (on(COND.AIM)) return go(S.RAISE);
      if (on(COND.GRENADE)) return go(S.GRENADE);
      if (on(COND.RELOAD)) return go(S.RELOAD);
      if (on(COND.CH26)) return go(S.RUN_GUN);
      if (on(COND.PANIC)) return go(S.RUN_PANIC);
      if (state === S.RUN && on(COND.WALKING)) return go(S.WALK);
      if (state === S.WALK && !on(COND.WALKING)) return go(S.RUN);
      if (on(COND.LEFT)) return go(S.ROLL_LEFT);
      if (on(COND.RIGHT)) return go(S.ROLL_RIGHT);
      if (!on(COND.FORWARD)) return go(S.STAND);
      return r;
    case S.ROLL_LEFT: // 0x45a050 (shared)
    case S.ROLL_RIGHT:
    case S.TO_KNEEL:
    case S.KNEEL_ROLL_LEFT:
    case S.KNEEL_ROLL_RIGHT:
      if (!grounded) return go(S.FALL);
      if (on(COND.DEAD)) return go(S.DEATH_KNEEL);
      if (finished) return go(S.KNEEL);
      return r;
    case S.FIRE: // 0x456fc0
      if (!grounded) return go(S.FALL);
      if (on(COND.FLINCH)) return go(S.FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_STAND);
      r.trigger = on(COND.FIRE);
      if (finished && !on(COND.FIRE)) return go(on(COND.AIM) ? S.AIM : S.LOWER);
      return r;
    case S.RELOAD: // 0x457120
      if (!grounded) return go(S.FALL);
      if (on(COND.FLINCH)) return go(S.FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_STAND);
      if (finished) {
        r.refill = true;
        return go(on(COND.AIM) ? S.AIM : S.STAND);
      }
      return r;
    case S.GRENADE: // 0x45a170
      if (!grounded) return go(S.FALL);
      if (on(COND.FLINCH)) return go(S.FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_STAND);
      if (c.aiHasTarget && c.eventTrigger === 11 && c.eventClip === c.currentClip && !c.thrown) r.throwGrenade = true;
      if (finished) return go(on(COND.AIM) ? S.AIM : S.STAND);
      return r;
    case S.CLOSE_COMBAT: // 0x45a3b0
      if (!grounded) return go(S.FALL);
      if (on(COND.FLINCH)) return go(S.FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_STAND);
      if (c.eventClip === c.currentClip && c.eventTrigger === 12 && !c.struck) r.strike = true;
      if (finished) return go(S.STAND);
      return r;
    case S.AIM: // 0x457430
      if (!grounded) return go(S.FALL);
      if (on(COND.FLINCH)) return go(S.FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_STAND);
      if (!on(COND.AIM)) return go(S.LOWER);
      if (on(COND.FIRE)) return go(S.FIRE);
      return r;
    case S.RAISE: // 0x45a590
      if (!grounded) return go(S.FALL);
      if (on(COND.FLINCH)) return go(S.FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_STAND);
      if (finished) return go(S.AIM);
      return r;
    case S.LOWER: // 0x457570
      if (!grounded) return go(S.FALL);
      if (on(COND.FLINCH)) return go(S.FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_STAND);
      if (finished) return go(S.STAND);
      return r;
    case S.KNEEL_TO_STAND: // 0x45a6d0
      if (!grounded) return go(S.FALL);
      if (on(COND.DEAD)) return go(S.DEATH_KNEEL);
      if (finished) return go(S.STAND);
      return r;
    case S.DIVE: // 0x45a790
      if (!grounded) return go(S.FALL);
      if (on(COND.DEAD)) return go(S.DEATH_PRONE);
      if (finished) return go(S.PRONE);
      return r;
    case S.PRONE_TO_STAND: // 0x45a850
      if (!grounded) return go(S.FALL);
      if (on(COND.DEAD)) return go(S.DEATH_PRONE);
      if (finished) return go(S.STAND);
      return r;
    case S.RUN_GUN: // 0x456840
      if (!grounded) return go(S.FALL);
      if (on(COND.FLINCH)) return go(S.FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_STAND);
      if (on(COND.KNEEL)) return go(S.TO_KNEEL);
      if (on(COND.LIEDOWN)) return go(S.DIVE);
      if (on(COND.FIRE)) return go(S.RUN_FIRE);
      if (!on(COND.CH26)) return go(on(COND.PANIC) ? S.RUN_PANIC : on(COND.WALKING) ? S.WALK : S.RUN);
      if (on(COND.LEFT)) return go(S.ROLL_LEFT);
      if (on(COND.RIGHT)) return go(S.ROLL_RIGHT);
      if (!on(COND.FORWARD)) return go(S.STAND);
      return r;
    case S.RUN_FIRE: // 0x456a60
      if (!grounded) return go(S.FALL);
      if (on(COND.FLINCH)) return go(S.FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_STAND);
      r.refill = true; // every tick: running fire never empties the clip
      r.trigger = on(COND.FIRE);
      if (!on(COND.CH26)) return go(on(COND.WALKING) ? S.WALK : S.RUN);
      if (!on(COND.FORWARD)) return go(S.STAND);
      if (finished && !on(COND.FIRE)) return go(S.RUN_GUN);
      return r;
    case S.KNEEL: // 0x457920
      if (!grounded) return go(S.FALL);
      if (on(COND.FLINCH)) return go(S.FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_KNEEL);
      if (on(COND.LIEDOWN)) return go(S.KNEEL_TO_PRONE);
      if (!on(COND.KNEEL | COND.ROOF)) return go(S.STAND); // no kneel-to-stand clip: state 14 is never entered
      if (on(COND.FIRE)) return go(S.KNEEL_AIM);
      if (on(COND.RELOAD)) return go(S.KNEEL_RELOAD);
      if (on(COND.LEFT)) return go(S.KNEEL_ROLL_LEFT);
      if (on(COND.RIGHT)) return go(S.KNEEL_ROLL_RIGHT);
      return r;
    case S.KNEEL_FIRE: // 0x457be0
      if (!grounded) return go(S.FALL);
      if (on(COND.FLINCH)) return go(S.FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_KNEEL);
      r.trigger = on(COND.FIRE);
      if (finished && !on(COND.FIRE)) return go(on(COND.AIM) ? S.KNEEL_AIM : S.KNEEL);
      return r;
    case S.KNEEL_RELOAD: // 0x457d10
      if (!grounded) return go(S.FALL);
      if (on(COND.FLINCH)) return go(S.FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_KNEEL);
      if (finished) {
        r.refill = true;
        return go(S.KNEEL);
      }
      return r;
    case S.KNEEL_AIM: // 0x457e10
      if (!grounded) return go(S.FALL);
      if (on(COND.FLINCH)) return go(S.FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_KNEEL);
      if (!on(COND.AIM)) return go(S.KNEEL);
      if (finished && on(COND.FIRE)) return go(S.KNEEL_FIRE);
      return r;
    case S.KNEEL_TO_PRONE: // 0x45aa30
      if (!grounded) return go(S.FALL);
      if (on(COND.DEAD)) return go(S.DEATH_KNEEL);
      if (finished) return go(S.PRONE);
      return r;
    case S.PRONE: // 0x458000
      if (!grounded) return go(S.FALL);
      if (on(COND.FLINCH)) return go(S.PRONE_FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_PRONE);
      if (!on(COND.LIEDOWN)) return go(S.PRONE_TO_STAND);
      if (on(COND.FIRE)) return go(S.PRONE_FIRE);
      if (on(COND.RELOAD)) return go(S.PRONE_RELOAD);
      return r;
    case S.PRONE_FIRE: // 0x458130
      if (!grounded) return go(S.FALL);
      if (on(COND.FLINCH)) return go(S.PRONE_FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_PRONE);
      r.trigger = on(COND.FIRE);
      if (finished && !on(COND.FIRE)) return go(S.PRONE);
      return r;
    case S.PRONE_RELOAD: // 0x45ab50
      if (!grounded) return go(S.FALL);
      if (on(COND.FLINCH)) return go(S.PRONE_FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_PRONE);
      if (finished) {
        r.refill = true;
        return go(S.PRONE);
      }
      return r;
    case S.FALL: // 0x45ac70
      if (on(COND.FLINCH)) return go(S.FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_STAND);
      if (grounded) {
        r.landed = true;
        return go(S.STAND);
      }
      return r;
    case S.FLINCH: // 0x4582d0
      if (!grounded) return go(S.FALL);
      if (on(COND.DEAD)) return go(S.DEATH_STAND);
      if (finished) {
        r.aimOn = true;
        return go(S.STAND);
      }
      return r;
    case S.PRONE_FLINCH: // 0x45add0
      if (!grounded) return go(S.FALL);
      if (on(COND.DEAD)) return go(S.DEATH_PRONE);
      if (c.counter < PRONE_FLINCH_GUARD_TICKS) r.counter = c.counter + 1;
      else if (on(COND.FLINCH)) return go(S.PRONE_FLINCH);
      if (finished) {
        r.aimOn = true;
        return go(S.PRONE);
      }
      return r;
    case S.ANIMATION: // 0x45b230
      if (!grounded) return go(S.FALL);
      if (on(COND.FLINCH)) return go(S.FLINCH);
      if (on(COND.DEAD)) return go(S.DEATH_STAND);
      if ((b & COND_ANIMATION_EXIT) !== 0 || c.scripted === -1) {
        r.aimOn = true;
        return go(S.STAND);
      }
      return r;
    case S.STATIONARY_GUN: // 0x458830: a fresh use press or death detaches
      if ((c.use && !c.usePrevious) || on(COND.DEAD)) return go(S.STAND);
      return r;
    case S.USE: // 0x45b430
      if (finished) return go(S.STAND);
      return r;
    default:
      return r;
  }
}

/** Locomotion phase carry-over on entry [recovered FUN_00459980 / 00459cc0 / 00459f80 / 00459c20]: the states whose clip phase the new state keeps. */
export const PHASE_SYNC_FROM: Readonly<Record<number, readonly number[]>> = {
  [S.RUN_PANIC]: [S.RUN, S.WALK, S.RUN_GUN],
  [S.RUN]: [S.RUN_PANIC, S.WALK, S.RUN_GUN],
  [S.WALK]: [S.RUN_PANIC, S.RUN],
  [S.RUN_GUN]: [S.RUN_PANIC, S.RUN, S.WALK],
};

/** Upper-body aim clamp on bone 1 (0x532228 / 0x53222c as float32) [recovered FUN_00488390]. */
export const AIM_SPINE_LIMIT = Math.fround(0.95993114);
/** Bones the upper-body aim rotates (with their subtrees) [recovered FUN_00488390: records +0x84 / +0x210]. */
export const AIM_SPINE_BONE = 1;
export const AIM_NECK_BONE = 4;

/**
 * Split an aim angle between the spine and the neck as FUN_00488390 does:
 * the spine takes the angle clamped to +-0.96 rad, the neck the excess.
 */
export function splitAimAngle(angle: number): { spine: number; neck: number } {
  const a = Math.fround(angle);
  if (a === 0) return { spine: 0, neck: 0 };
  let spine = a;
  if (a < -AIM_SPINE_LIMIT) spine = -AIM_SPINE_LIMIT;
  else if (a > AIM_SPINE_LIMIT) spine = AIM_SPINE_LIMIT;
  let neck = 0;
  if (a < -AIM_SPINE_LIMIT) neck = Math.fround(a + AIM_SPINE_LIMIT);
  else if (a > AIM_SPINE_LIMIT) neck = Math.fround(a - AIM_SPINE_LIMIT);
  return { spine, neck };
}

/**
 * FUN_00486950: heading of a direction (double): 0 for the zero vector, else
 * acos(y / |v|) negated when x > 0 (the 3D length is used).
 */
export function headingOfDirection(v: readonly number[]): number {
  if (v[0] === 0 && v[1] === 0 && v[2] === 0) return 0;
  const n = Math.hypot(v[0], v[1], v[2]);
  const a = Math.acos(Math.max(-1, Math.min(1, v[1] / n)));
  return v[0] / n > 0 ? -a : a;
}

/** Bones of the subtree rooted at `root` (parents precede children in every skeleton). */
export function boneSubtree(parents: ArrayLike<number>, root: number): number[] {
  const inTree = new Uint8Array(parents.length);
  const out: number[] = [];
  for (let b = 0; b < parents.length; b++) {
    if (b === root || (parents[b] >= 0 && inTree[parents[b]])) {
      inTree[b] = 1;
      out.push(b);
    }
  }
  return out;
}

/**
 * FUN_004cd700 for one subtree: world rotation q (x, y, z, w) is pre-multiplied
 * onto every bone of the subtree (world_q' = q * world_q, checked against the
 * exe's 8-multiply product) and the positions follow their parents, i.e. the
 * subtree turns about the root bone's position. Bone matrices as poseSkeleton
 * (column-major 4x4, object space).
 */
export function rotateBoneSubtree(bones: Float32Array, subtree: readonly number[], q: readonly number[]): void {
  if (subtree.length === 0) return;
  const [x, y, z, w] = q;
  // Row-major rotation matrix of q (column vectors).
  const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - z * w), r02 = 2 * (x * z + y * w);
  const r10 = 2 * (x * y + z * w), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - x * w);
  const r20 = 2 * (x * z - y * w), r21 = 2 * (y * z + x * w), r22 = 1 - 2 * (x * x + y * y);
  const o0 = 16 * subtree[0];
  const px = bones[o0 + 12], py = bones[o0 + 13], pz = bones[o0 + 14];
  for (const b of subtree) {
    const o = 16 * b;
    for (let c = 0; c < 3; c++) {
      const a0 = bones[o + 4 * c], a1 = bones[o + 4 * c + 1], a2 = bones[o + 4 * c + 2];
      bones[o + 4 * c] = r00 * a0 + r01 * a1 + r02 * a2;
      bones[o + 4 * c + 1] = r10 * a0 + r11 * a1 + r12 * a2;
      bones[o + 4 * c + 2] = r20 * a0 + r21 * a1 + r22 * a2;
    }
    const dx = bones[o + 12] - px, dy = bones[o + 13] - py, dz = bones[o + 14] - pz;
    bones[o + 12] = px + r00 * dx + r01 * dy + r02 * dz;
    bones[o + 13] = py + r10 * dx + r11 * dy + r12 * dz;
    bones[o + 14] = pz + r20 * dx + r21 * dy + r22 * dz;
  }
}

/** FUN_004aa940: quaternion of `angle` about the unit `axis` (half angle 0.5, float32 results). */
export function axisAngleQuat(axis: readonly number[], angle: number): [number, number, number, number] {
  const s = Math.sin(angle * 0.5);
  return [Math.fround(s * axis[0]), Math.fround(s * axis[1]), Math.fround(s * axis[2]), Math.fround(Math.cos(angle * 0.5))];
}

/**
 * FUN_00488390, the upper-body aim, applied after posing (FUN_0045e150) when
 * human+0x64c is set: the view pitch (arms +0x120) turns bone 1's subtree
 * about the body's right axis (column 0 of the body matrix), clamped to
 * +-0.96 rad, and the excess turns bone 4's subtree about the same axis; the
 * view yaw (arms +0x12c; 0 for AI soldiers, whose look-at target is cleared
 * every AI frame by FUN_0044e260 -> FUN_00464590) turns bone 1 about the
 * body's up axis and the excess bone 4 about the bone 4 -> 5 axis.
 * bodyYaw: the yaw of the body matrix (Rz); bones posed with that rotation.
 */
export function applyUpperBodyAim(bones: Float32Array, parents: ArrayLike<number>, pitch: number, yaw: number, bodyYaw: number): void {
  if (parents.length <= AIM_NECK_BONE + 1) return;
  const spine = boneSubtree(parents, AIM_SPINE_BONE);
  const neck = boneSubtree(parents, AIM_NECK_BONE);
  const right = [Math.cos(bodyYaw), Math.sin(bodyYaw), 0];
  const p = splitAimAngle(pitch);
  if (p.spine !== 0) {
    rotateBoneSubtree(bones, spine, axisAngleQuat(right, p.spine));
    if (p.neck !== 0) rotateBoneSubtree(bones, neck, axisAngleQuat(right, p.neck));
  }
  const y = splitAimAngle(yaw);
  if (y.spine !== 0) {
    rotateBoneSubtree(bones, spine, axisAngleQuat([0, 0, 1], y.spine));
    if (y.neck !== 0) {
      const o4 = 16 * AIM_NECK_BONE, o5 = 16 * (AIM_NECK_BONE + 1);
      const ax = [bones[o5 + 12] - bones[o4 + 12], bones[o5 + 13] - bones[o4 + 13], bones[o5 + 14] - bones[o4 + 14]];
      const n = Math.hypot(ax[0], ax[1], ax[2]);
      if (n > 0) rotateBoneSubtree(bones, neck, axisAngleQuat([ax[0] / n, ax[1] / n, ax[2] / n], y.neck));
    }
  }
}
