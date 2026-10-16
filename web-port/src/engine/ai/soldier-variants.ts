/**
 * The HumanSoldier subclasses the levels place besides HumanSoldier (full exe):
 * HumanSoldierRPG (mission 10 #431, the RPG guard) and HumanSoldierFemale
 * (mission 14: Ekk x4 012_01_1, Anya 015_01_1). Same schema and size (0xd50)
 * as HumanSoldier, their own body graphs, action and zone tables. Pure rules;
 * SoldierMotor (motor.ts) runs them.
 *
 * HumanSoldierFemale (FUN_00454970) [recovered]:
 *   - Create 0x454b10: graph FUN_004ec190(+0x2ec, pre-update 0x454ba0, entries
 *     0x53e400 (13 states), state 0, 1 sequence 0x53e468), action table
 *     0x53e4a0 for every AI type (HumanSoldier switches it by AI type in
 *     FUN_0045cf90), zone table 0x53e508; skeleton +0xcf8 = 6, Stand
 *     Animation -1, walking 1, recoil threshold 0.33.
 *   - Compile 0x454f10: Stand Animation -1 -> clip 6 one-shot (FUN_00489ea0),
 *     else that clip (missing: "Animation %d not found", clip 6).
 *   - Pre-update 0x454ba0: keep bits & 0xffc3e01c; channels 2..9 as the
 *     soldier's (0x20..0x1000); channel 21 -> 0x80000 and +0xd0c =
 *     fistp(ch 21) (the scripted animation); 22 -> 0x100000, +0xd10 = fistp,
 *     the use FUN_00454da0 (switch / door only, no StationaryGun), cleared;
 *     23 -> 0x200000 (aim); 24 -> weapon change (FUN_00413cc0). The AI's
 *     request map for ANYA / EKK (0x541454: 0 -> 20, 3 -> 21, 4 -> 22, 6 -> 23,
 *     7 -> 24, the others -1) lands the soldier requests there.
 *   - Body states the AI reads (0x5415f4): stand 0, animation 11 (no kneel,
 *     liedown or stationary gun).
 *   - Hits 0x4553e0 / 0x455570 / 0x455780: as HumanSoldier's but the flinch
 *     bit is never set (the damage sum only restarts above the threshold):
 *     the flinch state 9 is unreachable; death type +0xd18 is not read.
 *   - Tick 0x455070 -> 0x4550b0: as the soldier's; root motion x
 *     DefineHumanPlayerGeneral arg 0 (DAT_0056e1e8, 1.75) for AITYPE_EKK.
 * HumanSoldierRPG (FUN_00456ad0): graph 0x53e6a8 (15 states), action table
 * 0x53e720, zone table 0x53e798, pre-update FUN_00456cf0 (keep & 0xffe3e01c;
 * 21 -> 0x80000 kneel; 22 -> 0x100000 and +0xd04 = fistp(ch 22) the scripted
 * animation; request map 0x54138c: 0 -> 20, 1 -> 21, 3 -> 22, 6 -> 23),
 * body states (0x541590): stand 0, kneel 7, animation 14; skeleton 2 and
 * Stand Animation 2 by default (FUN_00456c70).
 * The port's AI writes the HumanSoldier channel of each request (23 animation,
 * 24 use, 27 aim, 21 kneel, 28 weapon change); the variant motors read those
 * slots as the class's own channels, which is the same mapping.
 */
import type { SoldierZoneEntry } from "./soldier-graph";

export type SoldierClass = "soldier" | "female" | "rpg";

/** objects.qvm task type -> soldier class (HumanSoldierPistol is registered but placed nowhere). */
export const SOLDIER_CLASS_OF_TYPE: Readonly<Record<string, SoldierClass>> = {
  HumanSoldier: "soldier",
  HumanSoldierFemale: "female",
  HumanSoldierRPG: "rpg",
};

/** Create defaults (FUN_0045cc50 / 0x454b10 / FUN_00456c70): "Bone Heirachy" and "Stand Animation". */
export const SOLDIER_CLASS_DEFAULTS: Readonly<Record<SoldierClass, { skeleton: number; standAnimation: number }>> = {
  soldier: { skeleton: 1, standAnimation: -1 },
  female: { skeleton: 6, standAnimation: -1 },
  rpg: { skeleton: 2, standAnimation: 2 },
};

/** Variant condition bits (graph +8) [recovered pre-updates]. */
export const VBIT = {
  FINISHED: 0x1,
  BLENDING: 0x2,
  GROUNDED: 0x4,
  ROOF: 0x10,
  LEFT: 0x20,
  RIGHT: 0x40,
  FORWARD: 0x80,
  BACK: 0x100,
  FIRE: 0x200,
  CH7: 0x400,
  RELOAD: 0x800,
  CH9: 0x1000,
  FLINCH: 0x10000,
  DEAD: 0x20000,
  WALKING: 0x40000,
  /** Female: ch 21 (animation); RPG: ch 21 (kneel). */
  CH21: 0x80000,
  /** Female: ch 22 (use); RPG: ch 22 (animation). */
  CH22: 0x100000,
  /** Female: ch 23 (aim). */
  CH23: 0x200000,
} as const;

export const FEMALE_KEEP = 0xffc3e01c;
export const RPG_KEEP = 0xffe3e01c;

/** Action tables {clip, loop} per state [observed 0x53e4a0 / 0x53e720]. */
export const FEMALE_ACTIONS: ReadonlyArray<{ clip: number; loop: boolean }> = [
  [6, 1], [3, 1], [2, 1], [9, 1], [15, 0], [14, 0], [7, 0], [8, 0], [6, 1], [0, 0], [0, 0], [0, 0], [6, 0],
].map(([clip, loop]) => ({ clip, loop: loop === 1 }));
export const RPG_ACTIONS: ReadonlyArray<{ clip: number; loop: boolean }> = [
  [2, 1], [3, 1], [4, 1], [6, 1], [5, 0], [7, 0], [9, 0], [8, 0], [11, 1], [19, 0], [10, 0], [2, 1], [0, 0], [0, 0], [0, 0],
].map(([clip, loop]) => ({ clip, loop: loop === 1 }));

/** Zone tables (17 x {multiplier, flinch clip, death clip, death clip}) [observed 0x53e508 / 0x53e798]. */
const zones = (rows: number[][]): SoldierZoneEntry[] =>
  rows.map(([multiplier, flinchClip, a, b]) => ({ multiplier, flinchClip, deathClips: [a, b] as const }));
const cycle = (flinch: number, death: number): number[][] =>
  Array.from({ length: 12 }, (_, i) => [[0.5, 0.75, 1][i % 3], flinch, death, death]);
export const FEMALE_ZONES = zones([...cycle(6, 13), [1, 6, 13, 13], [1, 6, 13, 13], [1, 6, 13, 13], [100, 6, 13, 13], [100, 6, 13, 13]]);
export const RPG_ZONES = zones([...cycle(13, 15), [1, 13, 15, 15], [1, 13, 15, 15], [1, 13, 16, 16], [100, 13, 18, 18], [100, 13, 12, 12]]);

export const FEMALE_STATE = { STAND: 0, RUN: 1, WALK: 2, FIRE: 3, RELOAD: 4, AIM: 5, RAISE: 6, LOWER: 7, FALL: 8, FLINCH: 9, DEATH: 10, ANIMATION: 11, USE: 12 } as const;
export const RPG_STATE = {
  STAND: 0, RUN: 1, WALK: 2, FIRE: 3, SHOULDER: 4, TO_KNEEL: 5, KNEEL_TO_STAND: 6, KNEEL: 7, KNEEL_FIRE: 8,
  KNEEL_RELOAD: 9, KNEEL_SHOULDER: 10, FALL: 11, FLINCH: 12, DEATH: 13, ANIMATION: 14,
} as const;

/** The body-state tables the AI compares with (FUN_0048efe0): [stand, kneel, liedown, animation, stationary gun]. */
export const AI_BODY_STATE_MAP: Readonly<Record<SoldierClass, readonly number[] | null>> = {
  soldier: null,
  female: [0, -1, -1, 11, -1],
  rpg: [0, 7, -1, 14, -1],
};

/** Entry crouch flag (+0x33d) per state (null = unchanged) [recovered entries]. */
export const FEMALE_CROUCH: ReadonlyArray<0 | 1 | null> = [0, 0, 0, 1, null, 0, 0, 0, 0, 0, 0, null, null];
export const RPG_CROUCH: ReadonlyArray<0 | 1 | null> = [0, 0, 0, 1, 0, 0, 0, 1, null, null, null, 0, 0, 0, null];

export interface VariantTickInput {
  bits: number;
  /** The scripted animation id (+0xd0c / +0xd04). */
  scripted: number;
  /** Channel 6 (fire) is non-zero (the fire-hold states set the trigger +0x4d1). */
  fireChannel: boolean;
}

export interface VariantTickResult {
  next: number;
  trigger: boolean;
  refill: boolean;
  aimOn: boolean;
  /** RPG state 11 re-enters itself every airborne tick. */
  reenter: boolean;
  landed: boolean;
}

/** One HumanSoldierFemale state tick [recovered 0x453ae0 ... 0x45ca80]; death (10) is the caller's. */
export function femaleTick(state: number, c: VariantTickInput): VariantTickResult {
  const b = c.bits;
  const r: VariantTickResult = { next: -1, trigger: false, refill: false, aimOn: false, reenter: false, landed: false };
  const on = (m: number) => (b & m) !== 0;
  const go = (s: number) => ((r.next = s), r);
  const F = FEMALE_STATE;
  const common = (flinch = true): boolean => {
    if (!on(VBIT.GROUNDED)) return (go(F.FALL), true);
    if (flinch && on(VBIT.FLINCH)) return (go(F.FLINCH), true);
    if (on(VBIT.DEAD)) return (go(F.DEATH), true);
    return false;
  };
  switch (state) {
    case F.STAND:
      if (common()) return r;
      if (on(VBIT.CH23)) return go(F.RAISE);
      if (on(VBIT.RELOAD)) return go(F.RELOAD);
      if (on(VBIT.CH21)) return go(F.ANIMATION);
      if (on(VBIT.FORWARD)) return go(on(VBIT.WALKING) ? F.WALK : F.RUN);
      return r;
    case F.RUN:
      if (common()) return r;
      if (on(VBIT.CH23)) return go(F.RAISE);
      if (on(VBIT.RELOAD)) return go(F.RELOAD);
      if (on(VBIT.WALKING)) return go(F.WALK);
      if (!on(VBIT.FORWARD)) return go(F.STAND);
      return r;
    case F.WALK:
      if (common()) return r;
      if (on(VBIT.CH23)) return go(F.RAISE);
      if (on(VBIT.RELOAD)) return go(F.RELOAD);
      if (!on(VBIT.WALKING)) return go(F.RUN);
      if (!on(VBIT.FORWARD)) return go(F.STAND);
      return r;
    case F.FIRE:
      if (common()) return r;
      if (c.fireChannel) r.trigger = true;
      if (on(VBIT.FINISHED) && !on(VBIT.FIRE)) return go(on(VBIT.CH23) ? F.AIM : F.LOWER);
      return r;
    case F.RELOAD:
      if (common()) return r;
      if (on(VBIT.FINISHED)) {
        r.refill = true;
        return go(on(VBIT.CH23) ? F.AIM : F.STAND);
      }
      return r;
    case F.AIM:
      if (common()) return r;
      if (!on(VBIT.CH23)) return go(F.LOWER);
      if (on(VBIT.FIRE)) return go(F.FIRE);
      return r;
    case F.RAISE:
      if (common()) return r;
      if (on(VBIT.FINISHED)) return go(F.AIM);
      return r;
    case F.LOWER:
      if (common()) return r;
      if (on(VBIT.FINISHED)) return go(F.STAND);
      return r;
    case F.FALL:
      if (on(VBIT.FLINCH)) return go(F.FLINCH);
      if (on(VBIT.DEAD)) return go(F.DEATH);
      if (on(VBIT.GROUNDED)) {
        r.landed = true;
        return go(F.STAND);
      }
      return r;
    case F.FLINCH:
      if (!on(VBIT.GROUNDED)) return go(F.FALL);
      if (on(VBIT.DEAD)) return go(F.DEATH);
      if (on(VBIT.FINISHED)) {
        r.aimOn = true;
        return go(F.STAND);
      }
      return r;
    case F.ANIMATION:
      if (common()) return r;
      if ((b & 0x301fe1) !== 0 || c.scripted === -1) {
        r.aimOn = true;
        return go(F.STAND);
      }
      return r;
    case F.USE:
      if (on(VBIT.FINISHED)) return go(F.STAND);
      return r;
    default:
      return r;
  }
}

/** One HumanSoldierRPG state tick [recovered 0x455a40 ... 0x456a10]; death (13) is the caller's. */
export function rpgTick(state: number, c: VariantTickInput): VariantTickResult {
  const b = c.bits;
  const r: VariantTickResult = { next: -1, trigger: false, refill: false, aimOn: false, reenter: false, landed: false };
  const on = (m: number) => (b & m) !== 0;
  const go = (s: number) => ((r.next = s), r);
  const R = RPG_STATE;
  const common = (flinch = true): boolean => {
    if (!on(VBIT.GROUNDED)) return (go(R.FALL), true);
    if (flinch && on(VBIT.FLINCH)) return (go(R.FLINCH), true);
    if (on(VBIT.DEAD)) return (go(R.DEATH), true);
    return false;
  };
  switch (state) {
    case R.STAND:
      if (common()) return r;
      if (on(VBIT.FIRE)) return go(R.SHOULDER);
      if (on(VBIT.RELOAD)) return go(R.TO_KNEEL);
      if (on(VBIT.CH22)) return go(R.ANIMATION);
      if (on(VBIT.WALKING)) {
        if (on(VBIT.FORWARD)) return go(R.WALK);
      } else if (on(VBIT.FORWARD)) return go(R.RUN);
      if ((b & 0x80010) !== 0) return go(R.TO_KNEEL);
      return r;
    case R.RUN:
    case R.WALK:
      if (common()) return r;
      if (on(VBIT.FIRE)) return go(R.SHOULDER);
      if (on(VBIT.RELOAD)) return go(R.TO_KNEEL);
      if (state === R.RUN ? on(VBIT.WALKING) : !on(VBIT.WALKING)) return go(state === R.RUN ? R.WALK : R.RUN);
      if (!on(VBIT.FORWARD)) return go(R.STAND);
      if (on(VBIT.CH21)) return go(R.TO_KNEEL);
      return r;
    case R.FIRE:
    case R.KNEEL_FIRE:
      if (common()) return r;
      if (c.fireChannel) r.trigger = true;
      if (on(VBIT.FINISHED) && !on(VBIT.FIRE)) return go(state === R.FIRE ? R.STAND : R.KNEEL);
      return r;
    case R.SHOULDER:
    case R.KNEEL_SHOULDER:
      if (common()) return r;
      if (on(VBIT.FINISHED)) return go(state === R.SHOULDER ? R.FIRE : R.KNEEL_FIRE);
      return r;
    case R.TO_KNEEL:
    case R.KNEEL_TO_STAND:
    case R.FLINCH:
      // 0x4560f0 / 0x4561a0: no flinch test.
      if (common(false)) return r;
      if (on(VBIT.FINISHED)) return go(state === R.TO_KNEEL ? R.KNEEL : R.STAND);
      return r;
    case R.KNEEL:
      if (common()) return r;
      if (on(VBIT.FIRE)) return go(R.KNEEL_SHOULDER);
      if (on(VBIT.RELOAD)) return go(R.KNEEL_RELOAD);
      if ((b & 0x80010) === 0) return go(R.STAND);
      return r;
    case R.KNEEL_RELOAD:
      if (common()) return r;
      if (on(VBIT.FINISHED)) {
        r.refill = true;
        return go(R.KNEEL);
      }
      return r;
    case R.FALL:
      if (!on(VBIT.GROUNDED)) {
        r.reenter = true;
        return go(R.FALL);
      }
      if (on(VBIT.DEAD)) return go(R.DEATH);
      r.landed = true;
      return go(R.STAND);
    case R.ANIMATION:
      if (common()) return r;
      if ((b & 0x81fe1) !== 0 || c.scripted === -1) return go(R.STAND);
      return r;
    default:
      return r;
  }
}

/** The state the AI sees (soldier numbering of table 0x53f4fc), or a value no AI test matches. */
export function aiBodyState(cls: SoldierClass, state: number, soldierBody: readonly number[]): number {
  const map = AI_BODY_STATE_MAP[cls];
  if (!map) return state;
  const i = map.indexOf(state);
  return i >= 0 ? soldierBody[i] : 1000 + state;
}
