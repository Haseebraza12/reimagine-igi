/**
 * AITYPE_RPG combat (the RPG guard of mission 10; full exe) [recovered]:
 *   - Start FUN_0048cb40: the kneel tick 0x48cdf0 when the body's crouch
 *     flag (+0x33d) is set, else the stand tick 0x48cbd0; stop FUN_0048d7d0;
 *     "last" H+0x3dd0 = -1; the target record of the first event with an
 *     "other" object.
 *   - Both ticks: not-visible count data +0x20 (kept only while not visible);
 *     the common target refresh FUN_0048a920 (no target slot -> end). With no
 *     sub-state: once the body is in the tick's stance (stand: body state 0;
 *     kneel: request 1 = kneel every tick, body state 7): not visible -> count,
 *     above the targeting timeout (H+0x3d50) -> end; outside the cone (slot
 *     +0x28) -> "Turning to target" (FUN_004525b0, 2 deg) and wait. Then: an
 *     empty clip and last != 1 -> the reload sub-state 0x48dd10 (FUN_0048ae70:
 *     from the stand tick it also runs the kneel tick once at once; the combat
 *     tick is not switched), last = 1; else after a shot (last = 0) rand <
 *     0.4 (f32 0x5335d4) -> switch stand <-> kneel tick, last = 2; else a
 *     visible target -> a fire sequence (FUN_0048b9c0: the first one halves the
 *     hit probability) with the stand fire tick 0x48d8b0 or the kneel one
 *     0x48dcd0 (kneel request, then FUN_0048d8e0), last = 0.
 *   - Reload 0x48dd10: request kneel; a loaded clip while kneeling -> flip
 *     H+0x3df1 and done; else channel 6 = 0 and with H+0x3df1 set channel 8
 *     (the body's animated kneel reload, state 9) else the clip refills at once
 *     (FUN_004f2350): reloads alternate between the two [alternation inferred].
 *   - Request map 0x54138c: 1 -> channel 21 (kneel); the port's AI writes the
 *     soldier channels and the RPG body reads them as its own (soldier-variants.ts).
 */
import { AI_TURN_CLAMP, aiInViewCone } from "../../loaders";
import type { ActionRecord, HumanAi } from "./human-ai";
import { FireSequence } from "./combat";
import { BODY, CH } from "./motor";
import type { V3 } from "./types";

const AIM_TOL = Math.fround(2 * (Math.PI / 180));
/** f32 0x5335d4. */
export const RPG_STANCE_SWITCH = Math.fround(0.4000000059604645);

export type RpgSub = "reload" | "fireStand" | "fireKneel" | null;

/** The RPG's part of the combat data. */
export interface RpgData {
  kneel: boolean;
  last: number;
  notVisible: number;
  sub: RpgSub;
  fire: FireSequence | null;
}

export interface RpgHost {
  data: RpgData;
  first: boolean;
  /** FUN_0048a920; false when the action ended. */
  refresh(): boolean;
  visible(): boolean;
  inCone(): boolean;
  aim(): V3;
  end(): void;
}

/** Per-soldier toggle H+0x3df1 (kept across combat actions). */
const reloadToggle = new WeakMap<HumanAi, boolean>();

function reloadSub(ai: HumanAi): boolean {
  ai.ch[CH.KNEEL] = 1;
  if (!ai.motor.clipEmpty && ai.motor.state === BODY.KNEEL) {
    reloadToggle.set(ai, !(reloadToggle.get(ai) ?? false));
    return true;
  }
  ai.ch[CH.FIRE] = 0;
  if (reloadToggle.get(ai)) {
    ai.ch[CH.RELOAD] = 1;
    return false;
  }
  ai.motor.refill();
  return false;
}

function runSub(ai: HumanAi, h: RpgHost): boolean {
  const d = h.data;
  switch (d.sub) {
    case "reload":
      return reloadSub(ai);
    case "fireKneel":
    case "fireStand": {
      if (d.sub === "fireKneel") ai.ch[CH.KNEEL] = 1;
      if (!d.fire) return true;
      return d.fire.tick(ai, h.aim());
    }
    default:
      return true;
  }
}

/** FUN_0048cbd0 (stand) / FUN_0048cdf0 (kneel). */
export function rpgTick(ai: HumanAi, rec: ActionRecord, h: RpgHost, kneelTick = h.data.kneel): void {
  void rec;
  const d = h.data;
  const nv = d.notVisible;
  d.notVisible = 0;
  if (!h.refresh()) return;
  if (d.sub) {
    if (runSub(ai, h)) {
      d.sub = null;
      d.fire = null;
    }
    return;
  }
  const visible = h.visible();
  const loaded = !ai.motor.clipEmpty;
  if (kneelTick) ai.ch[CH.KNEEL] = 1;
  if (ai.motor.state !== (kneelTick ? BODY.KNEEL : BODY.STAND)) return;
  if (!visible) {
    d.notVisible = nv + 1;
    if (ai.cfg && d.notVisible > ai.cfg.targetingTimeoutTicks) {
      h.end();
      return;
    }
    if (!h.inCone()) {
      ai.turnTo(h.aim(), AI_TURN_CLAMP.normal, AIM_TOL);
      return;
    }
  }
  if (!loaded && d.last !== 1) {
    d.sub = "reload";
    d.last = 1;
    // FUN_0048ae70: from the stand tick the kneel tick runs once at once (it runs the new sub-state).
    if (!kneelTick) rpgTick(ai, rec, h, true);
    return;
  }
  if (d.last === 0 && ai.world.rng.float() < RPG_STANCE_SWITCH) {
    d.kneel = !kneelTick;
    d.last = 2;
    return;
  }
  if (visible) {
    d.fire = new FireSequence(ai, h.aim(), h.first);
    h.first = false;
    d.sub = kneelTick ? "fireKneel" : "fireStand";
    d.last = 0;
  }
}

/** The view-cone test of the target's aim point (the slot's +0x28 between perception runs). */
export function rpgInCone(ai: HumanAi, aim: V3): boolean {
  return aiInViewCone(ai.eye, aim, ai.view, ai.alarmFlag);
}
