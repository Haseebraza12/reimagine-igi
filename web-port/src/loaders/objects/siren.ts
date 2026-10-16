/**
 * Siren (missions 6, 7, 8, 9, 11) [recovered, full exe: class FUN_00449360 =
 * FUN_00401900("Siren", 0x2d8, ExplodeObject); create LAB_004492a0, update
 * FUN_004494d0, compile FUN_00449610, members LAB_00449660 / LAB_00449710,
 * sound host LAB_004497b0 (+0x20 position, +0x70 matrix, no vars); bullet and
 * explosion handlers inherited from ExplodeObject (FUN_00481e60 /
 * FUN_00481ea0)]:
 *
 *   - schema: ExplodeObject's (FUN_004f1980(FUN_00481350(), 3)) plus "Working
 *     Sound" (+0x238, String32), "Faulty Sound" (+0x258, String32), "On
 *     Expression" (+0x278); create overrides the ExplodeObject defaults
 *     (FUN_00481360: damage scale 1, radius 0.5, falloff 0.5, explosion damage
 *     1, delay 0, 5 fragments, 4 fireballs, "explosion_1");
 *   - update: (1) the ExplodeObject update (FUN_00481970: children, then the
 *     Explosion expression / countdown; at 0 it explodes: destroyed model when
 *     it resolves, explosion at magic vertex 0 or the origin, isExploded);
 *     (2) isLastOn (+0x2d1) = isOn (+0x2d0); isOn = (char)fistp(eval(On
 *     Expression)) - evaluated without the "compiled?" test (FUN_004f16e0
 *     only; every shipped siren has one, an absent one is read as 0 here
 *     [inferred]); (3) sounds (FUN_004e6b00 start, FUN_004e6c00 stop):
 *       !isOn && !exploded: stop Working;
 *       !isOn &&  exploded: stop Faulty; return;
 *        isOn && !exploded: start Working (+0x2c8) when absent;
 *        isOn &&  exploded: stop Working, start Faulty (+0x2cc) when absent;
 *     an empty name never makes an instance. Destroying a siren does not
 *     touch the alarm: with Faulty = "alarmsystem_working" (L6, L9, L11, 3 of
 *     L8) it keeps wailing, with "" (L7, 4 of L8) it falls silent.
 * Members: `%s.isOn`, `%s.isLastOn`, ExplodeObject's `%s.isExploded`.
 * "alarmsystem_working" = ALARM_1, volume 1, 40 m / 80 m, loop, positional;
 * "explosion_1" has no DefineSound in any sounds.qvm (a silent explosion)
 * [observed]. The engine (engine/world/world-tasks.ts) plays the sounds at
 * Position; combat/object-damage.ts treats the siren as an ExplodeObject.
 */
import { registerTaskBehaviour, type TaskBehaviourContext } from "../mission";

/** The sound state machine of FUN_004494d0 on the node state (`working` / `faulty` = instance flags). */
export function sirenSounds(s: Record<string, number>, working: string, faulty: string): void {
  if (!s.isOn && !s.isExploded) s.working = 0;
  if (!s.isOn) {
    if (s.isExploded) s.faulty = 0;
    return;
  }
  if (!s.isExploded && !s.working && working !== "") s.working = 1;
  if (s.isExploded) {
    s.working = 0;
    if (!s.faulty && faulty !== "") s.faulty = 1;
  }
}

const str = (c: TaskBehaviourContext, key: string): string => {
  const v = c.node.task.params[key];
  return typeof v === "string" ? v : "";
};

registerTaskBehaviour("Siren", {
  expressions: ["Explosion expression", "On Expression"],
  members: { isExploded: "char", isOn: "char", isLastOn: "char" },
  create(c) {
    // ExplodeObject create (LAB_0047faf0 state) + LAB_004492a0.
    Object.assign(c.state, { isExploded: 0, countdown: -1, exprFlag: 0, isOn: 0, isLastOn: 0, working: 0, faulty: 0 });
  },
  update(c) {
    c.runtime.updateExplodeObject(c.node.index); // FUN_00481970
    const s = c.state;
    s.isLastOn = s.isOn;
    s.isOn = c.evalByte("On Expression") ?? 0;
    sirenSounds(s, str(c, "Working Sound"), str(c, "Faulty Sound"));
  },
});
