/**
 * AlarmLight and its AlarmLightReflector (missions 6, 7, 8, 9, 14)
 * [recovered, full exe: class FUN_004397c0 = FUN_00401900("AlarmLight",
 * 0x1f8, SectorInteriorObject); create FUN_0043a0e0, update FUN_0043a270,
 * compile FUN_0043a450, bullet hit LAB_0043a5e0 -> FUN_0043a5f0, explosion
 * hit FUN_0043a660, members LAB_0043a710 / LAB_0043a790; the same
 * registration creates "AlarmLightReflector" (0x140, MagicObj: create
 * FUN_00439a50, update FUN_00439b70, draw FUN_00439ec0 -> glow FUN_00439f10)
 * and loads alarmlight.spr]:
 *
 *   - create: in the damage list (FUN_004168d0 -> FUN_004c1790), identity
 *     matrices, isOn (+0x1a0) = isDestroyed (+0x1a1) = 0, no sound;
 *   - compile: model = the "Off model" (+0x140), +0x70 = Orientation, a new
 *     magic container (+0xe8) gets every ATTA of that model as a magic object
 *     (FUN_004c4950): 344_01_1's ATTA "344_02_1" is TASKTYPE_ALARMLIGHTREFLECTOR
 *     (magicobj.qvm), so each lamp owns one reflector for its whole life
 *     (the loader places it as the lamp instance's attachment "0");
 *   - update: prev = isOn; the "On sound" instance (+0x1f4) is deleted while
 *     !prev or destroyed, else started when absent (it starts the tick after
 *     isOn rises); destroyed -> return (nothing else updates, the reflector
 *     stops); isOn = (char)fistp(On expression) when compiled; on a rising edge
 *     model = +0x140 (Off model), on a falling edge model = +0x130 (On model):
 *     the fields are the OPPOSITE of their names (exact asm 0x43a30c-0x43a328),
 *     so a lamp starts and stays 344_01_1 when the alarm goes on and becomes
 *     344_03_1 (same mesh, textures and collision, no ATTA) when it goes off;
 *     then the task's children, then the container: the reflector update
 *     turns theta (+0x138) by f32(pi/30) (0x53381c, 180 deg/s) while the lamp
 *     isOn and not destroyed (the angle holds while off) and sets its matrix
 *     to M_lamp x M_attach x Rx(theta) (FUN_004b3b60, about the reflector's
 *     local x);
 *   - damage: ANY bullet hit, or an explosion whose damage factor
 *     (FUN_00416c90 with the lamp origin and its model radius) is non-zero,
 *     destroys it once (FUN_0043a5f0): explosion at the lamp origin
 *     (FUN_00480fe0: 1 explosion, interval 0, damage 0.05, radius 4096, falloff
 *     0, scorch 2048, 5 fragments, 2 fireballs, "1009_01_1", "Explode sound",
 *     AI event 21 / flags 2 / range 20480), isDestroyed = 1, model = the
 *     "Destroyde model" (every lamp: "" -> no model, it vanishes [inferred]);
 *     the reflector stays but is no longer drawn (its draw tests the owner).
 * Members (`%s.isOn` +0x1a0, `%s.isDestroyed` +0x1a1) exist for ids >= 0
 * only (L8 #1400 / #1401, unreferenced).
 * The engine (engine/world/world-tasks.ts) applies `model`, turns the
 * reflector and draws the glow (alarmLightGlow); combat/object-damage.ts runs
 * the damage handlers.
 */
import { registerTaskBehaviour } from "../mission";
import { x87F32Add, x87StoreF32 } from "../x87";

/** f32(pi/30) (0x53381c): the reflector's turn per tick while the lamp is on. */
export const ALARM_REFLECTOR_STEP = Math.fround(0.10471975803375244);
/** Glow half-size, world units (6144.0f at 0x439ff0; FUN_00498040 scales it by the depth). */
export const ALARM_GLOW_HALF_SIZE = 6144;
/** Glow colour scale 128 (0x5335b4) in the 1/128 colour scale. */
export const ALARM_GLOW_SCALE = 128;
/** pi (double 0x533618) and f32(1/pi) (0x533820) of the glow pulse. */
const PI_D = 3.1415926535897944;
const INV_PI = Math.fround(0.31830987334251404);

/** Which model field the lamp shows (node state `model`). */
export const ALARM_LIGHT_MODEL = {
  /** "Off model" (+0x140): the compile model and the one set on a rising edge. */
  off: 0,
  /** "On model" (+0x130): set on a falling edge. */
  on: 1,
  /** "Destroyde model" (+0x150): set by the destroy. */
  destroyed: 2,
} as const;

/** Parameter names of the three model fields, by ALARM_LIGHT_MODEL index ("Destroyde" is the schema's spelling). */
export const ALARM_LIGHT_MODEL_PARAMS = ["Off model", "On model", "Destroyde model"] as const;

/** The explosion of a destroyed lamp (FUN_0043a5f0 -> FUN_00480fe0 arguments). */
export const ALARM_LIGHT_EXPLOSION = {
  count: 1,
  interval: 0,
  damage: Math.fround(0.05000000074505806), // 0x3d4ccccd
  radius: 4096, // 0x45800000
  falloff: 0,
  scorch: 2048, // 0x45000000
  fragments: 5,
  fireballs: 2,
  fragmentModel: "1009_01_1",
  aiRange: 20480, // 0x46a00000
} as const;

/**
 * FUN_0043a270 on the node state (the lamp's own part; the children follow).
 * `on` = (char)fistp(eval(On expression)), null when absent. `onSound` = the
 * "On sound" name (an empty name never makes an instance). Returns false when
 * the lamp is destroyed (nothing else updates: no children, no reflector).
 */
export function alarmLightUpdate(s: Record<string, number>, on: number | null, onSound: string): boolean {
  const prev = s.isOn;
  if (!prev || s.isDestroyed) s.sound = 0;
  else if (!s.sound && onSound !== "") s.sound = 1;
  if (s.isDestroyed) return false;
  if (on !== null) s.isOn = on;
  if (!prev && s.isOn) s.model = ALARM_LIGHT_MODEL.off;
  else if (prev && !s.isOn) s.model = ALARM_LIGHT_MODEL.on;
  return true;
}

/** FUN_00439b70 (the reflector, in the lamp's container after its children): theta += pi/30 while on and intact. */
export function alarmReflectorUpdate(s: Record<string, number>): void {
  if (s.isOn && !s.isDestroyed) s.theta = x87F32Add(s.theta, ALARM_REFLECTOR_STEP);
}

/** FUN_0043a5f0: destroy once (the caller spawns the explosion when this returns true). */
export function alarmLightDestroy(s: Record<string, number>): boolean {
  if (s.isDestroyed) return false;
  s.isDestroyed = 1;
  s.model = ALARM_LIGHT_MODEL.destroyed;
  return true;
}

/**
 * Glow red (1/128 scale) of FUN_00439f10: 2 x |fmod(theta, pi) x f32(1/pi) - 0.5| x 128 =
 * 128 |2 fmod(theta, pi)/pi - 1|: full at theta = 0, pi, 2 pi ... (every 30 ticks), 0 in between.
 */
export function alarmGlowRed(theta: number): number {
  let f = (theta % PI_D) * INV_PI - 0.5;
  if (f < 0) f = -f;
  return x87StoreF32((f + f) * ALARM_GLOW_SCALE);
}

registerTaskBehaviour("AlarmLight", {
  expressions: ["On expression"],
  members: { isOn: "char", isDestroyed: "char" },
  create(c) {
    Object.assign(c.state, { isOn: 0, isDestroyed: 0, model: ALARM_LIGHT_MODEL.off, sound: 0, theta: 0 });
  },
  compile(c) {
    // FUN_0043a450: the Off model; the reflector is (re)created with theta 0 (FUN_00439a50).
    c.state.model = ALARM_LIGHT_MODEL.off;
    c.state.theta = 0;
  },
  update(c) {
    const sound = c.node.task.params["On sound"];
    if (!alarmLightUpdate(c.state, c.evalByte("On expression"), typeof sound === "string" ? sound : "")) return;
    c.updateChildren();
    alarmReflectorUpdate(c.state);
  },
});
