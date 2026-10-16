/**
 * The player-used objects of the full game (docs/objects.md; full exe):
 * Cabinet (+ its Drawer), GenericPickup, GenericTBA, PlaceExplosiveTBA and
 * BinocularOverlayHolder. The use tests, the player states 31 / 35 / 36 and
 * the pickup touch run in the engine (player/interact.ts); these are the
 * tasks' own updates, members and the entry points the player calls.
 *
 * Cabinet [recovered: create FUN_00444420, update FUN_00444590, active call
 * FUN_00444940, searched FUN_00444b90, abort FUN_00444ba0, members
 * FUN_004449c0; Drawer create FUN_00444150, update FUN_00444260]:
 *   update = children; the drawer tick while enabled (+0x130); isInUse
 *   drops 2 ticks after the last use (LevelFlow nTick); isLastInUse =
 *   isInUse. The active call sets isInUse and the use tick and reads the
 *   tick's anim trigger: 0 opens the drawer, 1 closes it. Drawer tick:
 *   opening adds 153.6 units up to 1843.2 (then disabled), closing takes
 *   102.4 down to 0, reset (an aborted search) snaps it shut; the drawer
 *   sits at rest + R (0, slide, 0).
 * GenericPickup [recovered: create LAB_0046c2b0, touch FUN_0046c630, update
 *   FUN_0046c3c0, member LAB_0046c570]: the player's touch (alive only, no
 *   in-world test) sets isPickedUp; the next update plays the 2-D "pickup"
 *   and removes it from the world. No inventory change.
 * GenericTBA [recovered: update LAB_004480b0, members LAB_004482d0, active
 *   LAB_004484f0, finish FUN_00443ea0]: only an "Explodable" one runs the
 *   ExplodeObject update; isOn = exploded ? 0 : byte(On); isInUse /
 *   isFinishedThisTick drop 2 ticks after the last use / finish.
 * PlaceExplosiveTBA inherits all of GenericTBA's update (FUN_004388b0).
 * BinocularOverlayHolder [recovered FUN_00470fa0, update LAB_00471330]:
 *   visible = byte(Visible expression) when present; the engine shows the
 *   binocular overlay while it is set.
 */
import { numberParam } from "../tasks";
import { registerTaskBehaviour, type MissionRuntime, type TaskBehaviourContext } from "../mission";
import { x87StoreF32 } from "../x87";
import { explodeObjectState } from "./power";

const f32 = x87StoreF32;

/** 0x5338a0 / 0x53389c / 0x533898: drawer opening step, open slide, closing step (units). */
export const DRAWER_OPEN_STEP = Math.fround(153.6);
export const DRAWER_OPEN_SLIDE = Math.fround(1843.2);
export const DRAWER_CLOSE_STEP = Math.fround(102.4);
/** A use / finish "pulse" stays set this many LevelFlow ticks (the + 2 of the updates). */
const PULSE_TICKS = 2;

/** Drop isInUse 2 ticks after the last active call; isLastInUse = isInUse. */
function inUsePulse(c: TaskBehaviourContext): void {
  const s = c.state;
  if (s.useTick + PULSE_TICKS < c.runtime.levelFlowTick()) s.isInUse = 0;
  s.isLastInUse = s.isInUse;
}

/** FUN_00444260: one drawer tick (only while the cabinet's +0x130 is set). */
export function drawerTick(s: Record<string, number>): void {
  if (s.opening) {
    s.slide = f32(s.slide + DRAWER_OPEN_STEP);
    if (DRAWER_OPEN_SLIDE < s.slide) {
      s.slide = DRAWER_OPEN_SLIDE;
      s.drawerOn = 0;
    }
  }
  if (s.closing) {
    s.slide = f32(s.slide - DRAWER_CLOSE_STEP);
    if (s.slide < 0) {
      s.slide = 0;
      s.drawerOn = 0;
    }
  }
  if (s.reset) {
    s.slide = 0;
    s.reset = 0;
    s.drawerOn = 0;
  }
}

registerTaskBehaviour("Cabinet", {
  members: { isInUse: "char", isLastInUse: "char", isSearched: "char" },
  create(c) {
    Object.assign(c.state, { isInUse: 0, isLastInUse: 0, useTick: 0, isSearched: 0, opening: 0, closing: 0, reset: 0, drawerOn: 0, slide: 0 });
  },
  update(c) {
    c.updateChildren();
    if (c.state.drawerOn) drawerTick(c.state);
    inUsePulse(c);
  },
});

registerTaskBehaviour("GenericPickup", {
  members: { isPickedUp: "char" },
  create(c) {
    Object.assign(c.state, { isPickedUp: 0, inWorld: 1 });
  },
  update(c) {
    const s = c.state;
    if (s.isPickedUp && s.inWorld) {
      c.emit("sound2d", { name: "pickup" });
      s.inWorld = 0;
    }
  },
});

const tbaUpdate = (c: TaskBehaviourContext): void => {
  const s = c.state;
  if (c.node.task.params["Explodable"] === true) c.runtime.updateExplodeObject(c.node.index);
  if (s.isExploded) s.isOn = 0;
  else {
    const on = c.evalByte("On Expression");
    if (on !== null) s.isOn = on;
  }
  inUsePulse(c);
  if (s.finishTick + PULSE_TICKS < c.runtime.levelFlowTick()) s.isFinishedThisTick = 0;
};

for (const type of ["GenericTBA", "PlaceExplosiveTBA"]) {
  registerTaskBehaviour(type, {
    expressions: ["Explosion expression", "On Expression"],
    members: { isExploded: "char", isInUse: "char", isLastInUse: "char", isOn: "char", isFinished: "char", isFinishedThisTick: "char" },
    create(c) {
      Object.assign(c.state, explodeObjectState(), { isInUse: 0, isLastInUse: 0, isOn: 1, isFinished: 0, isFinishedThisTick: 0, useTick: 0, finishTick: 0 });
    },
    update: tbaUpdate,
  });
}

registerTaskBehaviour("BinocularOverlayHolder", {
  expressions: ["Visible expression"],
  create(c) {
    c.state.visible = 0;
  },
  update(c) {
    const v = c.evalByte("Visible expression");
    if (v !== null) c.state.visible = v;
  },
});

// ---- player entry points ----

/**
 * The "active" call of an object in use, every tick of the use (method 0x539544 from
 * FUN_00460ee0): isInUse and the use tick; a Cabinet also takes the tick's anim trigger
 * (FUN_00444940: 0 opens the drawer, 1 closes it; -1 = none).
 */
export function useObjectTick(runtime: MissionRuntime, index: number, trigger = -1): void {
  const s = runtime.behaviourState(index);
  s.isInUse = 1;
  s.useTick = runtime.levelFlowTick();
  if (runtime.tasks.nodes[index].type !== "Cabinet") return;
  if (trigger === 0) Object.assign(s, { opening: 1, closing: 0, drawerOn: 1 });
  if (trigger === 1) Object.assign(s, { closing: 1, opening: 0, drawerOn: 1 });
}

/** FUN_00444b90: the search finished. */
export function cabinetSearched(runtime: MissionRuntime, index: number): void {
  runtime.behaviourState(index).isSearched = 1;
}

/** FUN_00444ba0: an aborted search snaps the drawer shut. */
export function cabinetAbort(runtime: MissionRuntime, index: number): void {
  Object.assign(runtime.behaviourState(index), { reset: 1, drawerOn: 1 });
}

/** FUN_00443ea0: a GenericTBA / PlaceExplosiveTBA use finished. */
export function finishTba(runtime: MissionRuntime, index: number): void {
  Object.assign(runtime.behaviourState(index), { isFinished: 1, isFinishedThisTick: 1, finishTick: runtime.levelFlowTick() });
}

/** Model radius floor of the pickup touch (FUN_0046c630): 0.7 m. */
export const PICKUP_MIN_RADIUS = Math.fround(2867.2);

/**
 * FUN_0046c630, from the player's pickup loop FUN_00410f70 (alive only): within
 * r = max(model radius x max scale, 2867.2) horizontally and 1 m vertically of the
 * pickup, isPickedUp = 1. No in-world test.
 */
export function touchGenericPickup(runtime: MissionRuntime, index: number, position: readonly number[], player: readonly number[], modelRadius: number): boolean {
  const r = Math.max(f32(modelRadius), PICKUP_MIN_RADIUS);
  const dx = player[0] - position[0];
  const dy = player[1] - position[1];
  const dz = player[2] - position[2];
  if (!(Math.sqrt(dx * dx + dy * dy) < r && Math.abs(dz) < 4096)) return false;
  runtime.behaviourState(index).isPickedUp = 1;
  return true;
}

/** "Activate Time (s)" / "Search Time (s)" as the use limit: int(seconds x 30). */
export function useLimitTicks(task: { params: Record<string, unknown> }, key: string, fallback: number): number {
  return Math.trunc(f32(numberParam(task as never, key) ?? fallback) * 30);
}
