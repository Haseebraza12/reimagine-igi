/**
 * Generator and Radio (docs/objects.md; full exe): ExplodeObject subclasses
 * (FUN_00481340 parent) with an on / off state and sounds.
 *
 * Generator [recovered: schema FUN_0043b2f0, create FUN_0043b490, update
 * FUN_0043b500, members FUN_0043b6e0]: isOn starts 0 (the compile keeps it),
 * nBackupTimer -1. Per tick: the ExplodeObject update; isOn = exploded ? 0 :
 * byte(On expression) when present; with "Use backup timer" an off generator
 * arms the timer once (int(seconds x 30)) and is on for good when it runs
 * out; off -> the run loop stops and, on the tick it went off, the shutdown
 * sound plays at the generator; on -> the run loop (a child of the
 * generator) starts if it has none.
 *
 * Radio [recovered: schema FUN_0043ad80, create FUN_0043af20, update
 * FUN_0043af90, members FUN_0043b1c0]: isOn and the countdown start 0 at
 * compile. While on and its sound has ended: count down, else play radio
 * sound rand(4) and set countdown = rand(150) + 150 (two level-RNG draws
 * even when every name is empty, as in L7). Off -> the sound stops; the
 * shutdown sound on the tick it went off.
 */
import { numberParam, stringParam } from "../tasks";
import { registerTaskBehaviour, type TaskBehaviourContext } from "../mission";
import { x87Fistp, x87StoreF32 } from "../x87";

/**
 * The ExplodeObject class and its subclasses (damage, explosion, destroyed model; docs/damage.md):
 * the Terminal family, and in the full game Generator / Radio / GenericTBA (FUN_00481340 parent)
 * and PlaceExplosiveTBA (GenericTBA's child), Siren (FUN_00449360) [recovered, full exe].
 */
export const EXPLODE_OBJECT_TYPES: ReadonlySet<string> = new Set([
  "ExplodeObject", "Terminal", "AlarmControl", "SCameraControl", "Generator", "Radio", "GenericTBA", "PlaceExplosiveTBA", "Siren",
]);

/** ExplodeObject's own run-time fields (LAB_0047faf0). */
export const explodeObjectState = (): Record<string, number> => ({ isExploded: 0, countdown: -1, exprFlag: 0 });

/** 0x5333bc: ticks per second of the backup timer. */
const TICKS_PER_SECOND = 30;

/** isOn = isExploded ? 0 : (present(On) ? byte(eval) : isOn). */
function updateIsOn(c: TaskBehaviourContext, field: string): void {
  const s = c.state;
  if (s.isExploded) {
    s.isOn = 0;
    return;
  }
  const on = c.evalByte(field);
  if (on !== null) s.isOn = on;
}

registerTaskBehaviour("Generator", {
  expressions: ["Explosion expression", "On expression"],
  members: { isExploded: "char", isOn: "char", nBackupTimer: "int" },
  create(c) {
    Object.assign(c.state, explodeObjectState(), { isOn: 0, nBackupTimer: -1, loop: 0 });
  },
  update(c) {
    const s = c.state;
    const t = c.node.task;
    const wasOn = s.isOn;
    c.runtime.updateExplodeObject(c.node.index);
    updateIsOn(c, "On expression");
    if (t.params["Use backup timer"] !== false) {
      if (!s.isOn && s.nBackupTimer === -1) s.nBackupTimer = x87Fistp(x87StoreF32(numberParam(t, "Seconds until power backup") ?? 10) * TICKS_PER_SECOND);
      if (s.nBackupTimer < 1) s.isOn = 1;
      else s.nBackupTimer -= 1;
    }
    if (!s.isOn) {
      if (s.loop) {
        s.loop = 0;
        c.emit("loop-stop", { slot: "run" });
      }
      const shutdown = stringParam(t, "Shutdown sound") ?? "";
      if (wasOn && shutdown) c.emit("sound", { name: shutdown, follow: true });
    } else if (!s.loop) {
      const run = stringParam(t, "Run sound") ?? "";
      if (run) {
        s.loop = 1;
        c.emit("loop", { slot: "run", name: run, follow: true });
      }
    }
  },
});

/** Level-RNG next() mod n (FUN_004b47c0 on FUN_00416d20()). */
function rand(c: TaskBehaviourContext, n: number): number {
  return c.host.randomInt?.(n) ?? 0;
}

registerTaskBehaviour("Radio", {
  expressions: ["Explosion expression", "On expression"],
  members: { isExploded: "char", isOn: "char" },
  create(c) {
    Object.assign(c.state, explodeObjectState(), { isOn: 0, countdown2: 0, playing: 0 });
  },
  compile(c) {
    c.state.isOn = 0;
    c.state.countdown2 = 0;
  },
  update(c) {
    const s = c.state;
    const t = c.node.task;
    const wasOn = s.isOn;
    c.runtime.updateExplodeObject(c.node.index);
    updateIsOn(c, "On expression");
    if (!s.isOn) {
      if (s.playing) {
        s.playing = 0;
        c.emit("loop-stop", { slot: "radio" });
      }
      const shutdown = stringParam(t, "Shutdown sound") ?? "";
      if (wasOn && shutdown) c.emit("sound", { name: shutdown, follow: true });
      return;
    }
    if (s.playing && c.host.query?.("soundPlaying", c.node.index, "radio") === true) return;
    s.playing = 0;
    if (s.countdown2 !== 0) {
      s.countdown2 -= 1;
      return;
    }
    const k = rand(c, 4);
    const name = stringParam(t, `Radio sound ${k}`) ?? "";
    if (name) {
      s.playing = 1;
      c.emit("loop", { slot: "radio", name, follow: true, once: true });
    }
    s.countdown2 = rand(c, 150) + 150;
  },
});
