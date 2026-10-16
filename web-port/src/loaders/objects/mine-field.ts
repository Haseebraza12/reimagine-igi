/**
 * MineField (missions 7 and 9): while its expression holds it blows up the
 * ground under a task (the player: "Explode close to task ID" 0) every N
 * seconds. No mine is placed or drawn (docs/damage.md "MineField").
 *
 * Recovered (full exe; class FUN_0043a840, size 0xd0):
 *   - Create FUN_0043ab50: radius 3 m (+0x88), falloff 1.5 m (+0x8c), damage
 *     3 (+0x90), delay 0 (+0x94), 3 fragments (+0x98), 3 fireballs (+0x9c),
 *     sound "" (+0xa0), task id 0 (+0xc0), repeat 5 s (+0xc4), snap 1 (+0xc8),
 *     timer 0 (+0xcc); the parameters are written over them. The Position
 *     (+0x20) is never read by its methods.
 *   - Update FUN_0043abc0: timer -1 -> nothing; timer != 0 -> timer - 1 and
 *     nothing else (a negative timer keeps counting down: "-1: explode once"
 *     gives fistp(-30) = -30, which never reaches 0 or -1 again); timer 0 ->
 *     when the "Explode" expression is valid and evaluates != 0 (float mode,
 *     compared with 0.0): explode, then timer = fistp(f32 repeat x 30.0f)
 *     (chop mode: 5 s -> 150).
 *   - Explode FUN_0043ac40: the task named by "Explode close to task ID"
 *     (FUN_004f1030; none -> no explosion), its position record through
 *     method 7 (table 0xa994e0); with snap FUN_004149b0 casts a ray 1638400
 *     units (400 m) down from it, else (no hit) the same up, and takes the
 *     hit's z (no hit at all: z unchanged). Then FUN_00480fe0(centre, count 1,
 *     interval fistp(delay x 30), damage, radius x 4096.0f, falloff x
 *     4096.0f, scorch 6144, fragments, fireballs, scorch target none,
 *     "1009_01_1", sound, AI type -1 (no AI event), 0, 102400, source 0).
 * Engine protocol (MissionHost): query "minefield.position" (task id) -> the
 * task's IGI position or null; query "minefield.snap" (IGI position) -> the
 * snapped z or null; event "minefield.explode" with MineFieldExplosion.
 */
import { registerTaskBehaviour } from "../mission";
import { x87Fistp, x87Mul, x87StoreF32 } from "../x87";

type V3 = [number, number, number];

export const MINEFIELD_EVENTS = {
  position: "minefield.position",
  snap: "minefield.snap",
  explode: "minefield.explode",
} as const;

/** FUN_00480fe0's arguments for one MineField explosion (IGI units). */
export interface MineFieldExplosion {
  position: V3;
  count: number;
  /** fistp(delay x 30). */
  interval: number;
  damage: number;
  /** radius / falloff x 4096.0f (float32). */
  radius: number;
  falloff: number;
  scorch: number;
  fragments: number;
  fireballs: number;
  fragmentModel: string;
  sound: string;
  /** AI event range: null (argument 13 = -1, no event). */
  aiRange: null;
}

/** The scorch size argument (0x45c00000) and the fragment model (0x53bc88). */
export const MINEFIELD_SCORCH = 6144;
export const MINEFIELD_FRAGMENT_MODEL = "1009_01_1";
/** FUN_004149b0's snap ray: 1638400 units (double -1638400.0) down, then up. */
export const MINEFIELD_SNAP_RAY = 1638400;

const f32 = x87StoreF32;
const num = (p: Record<string, unknown>, key: string, fallback: number): number => {
  const v = p[key];
  return typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : fallback;
};

/** The task's fields after create + parameters [recovered FUN_0043ab50 defaults]. */
export function mineFieldParams(params: Record<string, unknown>) {
  const sound = params["Explosion sound"];
  return {
    radiusM: f32(num(params, "Explosion radius (meter)", 3)),
    falloffM: f32(num(params, "Explosion falloff radius (meter)", 1.5)),
    damage: f32(num(params, "Explosion damage scale", 3)),
    delaySeconds: f32(num(params, "Explosion delay (seconds)", 0)),
    fragments: Math.trunc(num(params, "Explosion fragments", 3)),
    fireballs: Math.trunc(num(params, "Explosion fireballs", 3)),
    sound: typeof sound === "string" ? sound : "",
    taskId: Math.trunc(num(params, "Explode close to task ID", 0)),
    repeatSeconds: f32(num(params, "Explosion delay between explosions (seconds) -1: explode once", 5)),
    snap: num(params, "Snap explosion to ground", 1) !== 0,
  };
}

/** The timer after an explosion: fistp(f32 repeat x 30.0f) in chop mode. */
export function mineFieldRepeatTicks(repeatSeconds: number): number {
  return x87Fistp(x87Mul(f32(repeatSeconds), 30));
}

/** FUN_0043ac40's explosion record for a centre (already snapped). */
export function mineFieldExplosion(p: ReturnType<typeof mineFieldParams>, centre: V3): MineFieldExplosion {
  return {
    position: [centre[0], centre[1], centre[2]],
    count: 1,
    interval: x87Fistp(x87Mul(p.delaySeconds, 30)),
    damage: p.damage,
    radius: f32(p.radiusM * 4096),
    falloff: f32(p.falloffM * 4096),
    scorch: MINEFIELD_SCORCH,
    fragments: p.fragments,
    fireballs: p.fireballs,
    fragmentModel: MINEFIELD_FRAGMENT_MODEL,
    sound: p.sound,
    aiRange: null,
  };
}

const paramsOf = new WeakMap<object, ReturnType<typeof mineFieldParams>>();

registerTaskBehaviour("MineField", {
  expressions: ["Explode"],
  create(c) {
    paramsOf.set(c.node, mineFieldParams(c.node.task.params));
    c.state.timer = 0; // +0xcc
    c.state.explosions = 0;
  },
  update(c) {
    const s = c.state;
    if (s.timer === -1) return;
    if (s.timer !== 0) {
      s.timer -= 1;
      return;
    }
    const v = c.eval("Explode");
    if (v === null || v === 0) return;
    const p = paramsOf.get(c.node) ?? mineFieldParams(c.node.task.params);
    // FUN_0043ac40: the named task's position record (method 7), snapped to the ground.
    const at = c.host.query?.(MINEFIELD_EVENTS.position, p.taskId) as V3 | null | undefined;
    if (at) {
      const centre: V3 = [at[0], at[1], at[2]];
      if (p.snap) {
        const z = c.host.query?.(MINEFIELD_EVENTS.snap, centre) as number | null | undefined;
        if (typeof z === "number") centre[2] = z;
      }
      s.explosions += 1;
      c.emit(MINEFIELD_EVENTS.explode, mineFieldExplosion(p, centre));
    }
    s.timer = mineFieldRepeatTicks(p.repeatSeconds);
  },
});
