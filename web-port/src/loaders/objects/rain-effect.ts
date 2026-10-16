/**
 * RainEffect (missions 3, 4, 7, 8, 9, 10, 11, 12) [recovered, full exe: class
 * FUN_00436780 = FUN_00401900("RainEffect", 0x88, QTask); create LAB_00436950,
 * update LAB_00436990, destroy FUN_004369e0, compile FUN_00436a50, members
 * none; the registration loads snow.tex (LOCAL:common/textures/)]:
 *
 *   - schema: "Is Rain" bool8 +0x24 (default 1), "Traceline start" Real32 m
 *     +0x28 (50), "Traceline end" Real32 m +0x2c (20), "Rain Alpha" Real32
 *     +0x30 (0.3125; +0x34 = the previous alpha), "Is Active" VarString +0x38;
 *   - compile: unless only the alpha changed, the world object "Rain" is
 *     (re)created: FUN_00498960(world, snow.tex, Is Rain, start x 4096, end x
 *     4096) (snow = Is Rain == 0), then its colour FUN_00499fa0(Alpha) and Is
 *     Active compiled;
 *   - update (every tick from its Container): when Is Active is compiled,
 *     Rain +0x56ac (active) = (char)fistp(eval) (FUN_00499f90); then the
 *     particle step FUN_00499cf0. An absent Is Active leaves active 0: no rain.
 * Data [observed]: L3 rain "1" alpha 0.13; L9 rain "TRUE\n" 0.15; L10 rain
 * "TRUE" 0.135; L7 snow "1"; L12 snow "1" (alpha 0.3125, unused by snow);
 * L4 / L8 / L11 "FALSE\n" (never shown). No sound, no position, no members:
 * the "Rain" object follows the render camera. The particle step, the floor
 * trace and the draw are engine/fx/rain.ts; this behaviour keeps `active` and
 * counts the steps (`steps`) the engine must run.
 * Unrelated: the footstep / ambient rain sounds need a RainDynCubeObj, which
 * no mission has, so RainEffect plays nothing.
 */
import { registerTaskBehaviour } from "../mission";
import type { IgiTask } from "../tasks";

/** Rain parameters as the compile reads them (Traceline values in metres). */
export interface RainEffectParams {
  /** "Is Rain" (false = snow). */
  isRain: boolean;
  traceStartM: number;
  traceEndM: number;
  alpha: number;
}

export function rainEffectParams(task: IgiTask): RainEffectParams {
  const p = task.params;
  const num = (key: string, fallback: number) => (typeof p[key] === "number" ? Math.fround(p[key] as number) : fallback);
  const rain = p["Is Rain"];
  return {
    isRain: typeof rain === "boolean" ? rain : typeof rain === "number" ? rain !== 0 : true,
    traceStartM: num("Traceline start", 50),
    traceEndM: num("Traceline end", 20),
    alpha: num("Rain Alpha", Math.fround(0.3125)),
  };
}

registerTaskBehaviour("RainEffect", {
  expressions: ["Is Active"],
  create(c) {
    Object.assign(c.state, { active: 0, steps: 0 });
  },
  update(c) {
    const v = c.evalByte("Is Active");
    if (v !== null) c.state.active = v & 0xff;
    c.state.steps += 1; // FUN_00499cf0, run by the engine's Rain object
  },
});

/**
 * CubeModifier (L6 x4, L8 x8, L9 x2, L10 x1) [recovered, full exe: class
 * FUN_0052b3b0 = FUN_00401900("CubeModifier", 0x178, EditorRigidObj); create
 * LAB_0052b320 appends the task to DAT_00a843ac[100], destroy LAB_0052b4d0
 * removes it, compile LAB_0052b510 snaps an AABB to the "Level" octree node
 * like DiscardTerrain, transform LAB_0052b630]: create does not add it to the
 * world (no model, no collision, never drawn), the class has no update slot,
 * the "Expression" (String256) is never compiled, and DAT_00a843ac is read
 * nowhere else in the exe (every reference lies in 0x52b37e-0x52b4fd). The
 * expressions are labels ("compound 1 entrance", "tank", "VILLAGE", ...):
 * editor region bookmarks [inferred]. All of them sit under Static (never
 * updated). The port reads them with the task tree and does nothing: no
 * POSE_SPECS entry, no expression, and this no-op update in case one were
 * ever placed outside Static.
 * DiscardTerrainArea (FUN_0052b6c0, 0 instances) is the editor generator of
 * the DiscardTerrain lists; it has no run-time effect either.
 */
registerTaskBehaviour("CubeModifier", { update() {} });
