/**
 * Soldier-AI engine: the per-frame driver order (FUN_0044e260), priority
 * dispatch (FUN_0044eb80), action commits (FUN_0044fc40), ALERT propagation
 * and the perception schedule (FUN_00487b70 / FUN_00487cf0).
 */
import { describe, expect, it } from "vitest";
import { EV, PLAYER_KEY, type V3 } from "../src/engine/ai/types";
import { HAVE_LEVEL, createHarness } from "./ai-engine-harness";

describe.skipIf(!HAVE_LEVEL)("AI driver", () => {
  it("GUNSHOT -> SetCombat (pops the non-pushable patrol, ends at once) -> next frame COMBAT -> Combat; ALERT reaches the teammate 1.75 m away, not the one 16 m away", async () => {
    // 2007 and 2008 stand 1.75 m apart, 2009 16 m away; the player is far away (tracked, never seen).
    const h = await createHarness({ only: [2007, 2008, 2009], playerAt: [0, 0, 0] });
    const [a, b, c] = [2007, 2008, 2009].map((id) => h.byTask.get(id)!);
    h.step(); // CREATE
    h.step(); // IDLE -> Patrol
    // Slots are made on phase ticks only (FUN_00487b70): phases 0, 1, 2 track the player on ticks 4, 1, 2.
    h.step();
    h.step();
    h.step();
    expect([a, b, c].map((s) => s.ai.slots.has(PLAYER_KEY))).toEqual([true, true, true]);
    expect(a.ai.top?.impl.name).toBe("Patrol");
    a.ai.receive({ type: EV.GUNSHOT, team: 0, flags: 0x46, range: 0x1e000, position: [a.feet[0] + 8 * 4096, a.feet[1], a.feet[2]], source: PLAYER_KEY, other: PLAYER_KEY });
    h.step();
    // SetCombat ran in the same frame: COMBAT is queued for the next frame, the patrol was popped.
    expect(a.ai.stack.length).toBe(0);
    expect(a.ai.counts[EV.GUNSHOT]).toBe(1);
    expect(a.ai.queues[EV.COMBAT].length).toBe(1);
    expect(a.ai.queues[EV.COMBAT][0].other).toBe(PLAYER_KEY);
    h.step();
    expect(a.ai.top?.impl.name).toBe("Combat(patrol)");
    expect(a.ai.top?.priority).toBe(a.ai.priorities.indexOf(EV.COMBAT));
    expect(a.ai.target?.key).toBe(PLAYER_KEY);
    expect(a.ai.alarmFlag).toBe(false); // set by the next frame's bookkeeping
    // The first combat tick broadcast ALERT (7 m, same team): 2008 answered in the same tick.
    expect(b.ai.counts[EV.ALERT]).toBe(1);
    expect(b.ai.stack.length).toBe(0);
    expect(c.ai.counts[EV.ALERT]).toBe(0);
    h.step();
    expect(a.ai.alarmFlag).toBe(true); // target record still perceived (H+0x3ab7)
    expect(b.ai.top?.impl.name).toBe("Combat(patrol)");
    expect(b.ai.target).toBe(a.ai.target); // one shared target record
    expect(c.ai.top?.impl.name).toBe("Patrol");
    expect([...a.ai.target!.attackers.keys()]).toEqual([a.ai, b.ai]);
  });

  it("an event whose priority index is not better than the top action's is not dispatched but still cleared and counted", async () => {
    const h = await createHarness({ only: [2007], playerAt: [0, 0, 0] });
    const a = h.byTask.get(2007)!;
    for (let i = 0; i < 5; i++) h.step(); // CREATE, Patrol; the player is tracked on phase tick 4
    a.ai.receive({ type: EV.GUNSHOT, team: 0, flags: 0x46, range: 0x1e000, position: [...a.feet] as V3, source: PLAYER_KEY, other: PLAYER_KEY });
    h.step();
    h.step(); // Combat (priority index 5)
    const runs = a.ai.scriptRuns;
    a.ai.receive({ type: EV.WALK, team: 0, flags: 0x46, range: 4096, position: [...a.feet] as V3, source: PLAYER_KEY, other: PLAYER_KEY });
    h.step();
    expect(a.ai.scriptRuns).toBe(runs); // WALK (index 11) cannot preempt Combat (5)
    expect(a.ai.counts[EV.WALK]).toBe(1);
    expect(a.ai.queues[EV.WALK].length).toBe(0);
    expect(a.ai.top?.impl.name).toBe("Combat(patrol)");
  });

  it("perception runs on the soldier's phase every 4 ticks; cone every 2nd run, sight ray every 3rd run while in the cone", async () => {
    // 3099 plays its relaxed idle (clip 41) and never turns.
    const h = await createHarness({ onlyAi: [3099] });
    const s = h.byAi.get(3099)!;
    const yaw = s.motor.yaw;
    h.player.feet = [s.feet[0] - Math.sin(yaw) * 10 * 4096, s.feet[1] + Math.cos(yaw) * 10 * 4096, s.feet[2]];
    h.ray = () => false; // in the cone, sight blocked
    expect(s.ai.phase).toBe(0);
    const rayTicks: number[] = [];
    for (let i = 0; i < 48; i++) {
      const before = h.rays;
      h.step();
      if (h.rays !== before) rayTicks.push(i);
    }
    // Phase 0: tick 0 is the CREATE frame; runs on ticks 4, 8, ...; cone tests on runs 0, 2, 4, ...;
    // rays on runs 0, 3, 6, 9 while in the cone.
    expect(rayTicks).toEqual([4, 16, 28, 40]);
    expect(s.ai.slots.get(PLAYER_KEY)!.inCone).toBe(true);
    expect(s.ai.slots.get(PLAYER_KEY)!.visible).toBe(false);
    // Sight clears: visible at the next ray (tick 52), ENEMYDETECTION every frame from then on.
    h.ray = () => true;
    for (let t = 48; t < 52; t++) h.step();
    expect(s.ai.slots.get(PLAYER_KEY)!.visible).toBe(false);
    h.step(); // tick 52
    expect(s.ai.slots.get(PLAYER_KEY)!.visible).toBe(true);
    expect(s.ai.counts[EV.ENEMYDETECTION]).toBe(1);
    h.step();
    expect(s.ai.counts[EV.ENEMYDETECTION]).toBe(1);
  });

  it("the out-of-world player / soldier is neither tracked nor heard", async () => {
    const h = await createHarness({ only: [2007, 2008] });
    const [a, b] = [2007, 2008].map((id) => h.byTask.get(id)!);
    h.step();
    h.step();
    // Phase 0: no slot before its first phase tick after CREATE (tick 4).
    expect(a.ai.slots.has(PLAYER_KEY)).toBe(false);
    h.step();
    h.step();
    h.step();
    expect(a.ai.slots.has(PLAYER_KEY)).toBe(true);
    b.present = false;
    h.world.broadcast({ type: EV.GUNSHOT, team: 0, flags: 0x46, range: 0x1e000, position: [...b.feet] as V3, source: PLAYER_KEY, other: PLAYER_KEY });
    expect(b.ai.queues[EV.GUNSHOT].length).toBe(0);
    expect(a.ai.queues[EV.GUNSHOT].length).toBe(1);
  });
});
