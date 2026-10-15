/**
 * Soldier-AI engine: the AIFunction / AIAction host against the real level-1
 * scripts, the level RNG and the action-commit rules (docs/qvm-vm.md 6-7,
 * docs/ai.md 1).
 */
import { describe, expect, it } from "vitest";
import { LevelRng } from "../src/engine/ai/rng";
import { EV, PLAYER_KEY } from "../src/engine/ai/types";
import { HAVE_LEVEL, createHarness } from "./ai-engine-harness";

const DEG = Math.PI / 180;
const PATROL_PRIORITIES = [
  EV.DEAD, EV.ALARMOFF, EV.FLASHBANG, EV.GRENADETHROWN, EV.GRENADELAND, EV.COMBAT, EV.ALERT, EV.ENEMYDETECTION,
  EV.GUNSHOT, EV.TAKINGDAMAGE, EV.GUNSHOTMISS, EV.WALK, EV.GROUNDIMPACT, EV.DOOR, EV.FENCE, EV.ALARMON,
  EV.EXPLOSION, EV.ANIMATION, EV.IDLE, EV.CREATE,
];

describe("level RNG (FUN_004aaa00 / FUN_004aaac0 / FUN_004aaa50)", () => {
  it("is seeded with 0x19111911 and steps s2 ^= s0 >> 7; s1 ^= s2; s0 += s1", () => {
    const r = new LevelRng();
    // Reference values computed independently (Python, 32-bit wrap).
    expect(r.step()).toBe(1817722035);
    expect(r.float()).toBe(0.515167236328125);
    expect(r.float()).toBe(0.75189208984375);
    expect(r.int(1000)).toBe(2486899499 % 1000);
    expect(r.draws).toBe(4);
  });
});

describe.skipIf(!HAVE_LEVEL)("AI host on the level-1 scripts", () => {
  it("CREATE: priority list, view setters (units), alarm control, mission override", async () => {
    const h = await createHarness({ only: [2009] });
    const ai = h.byTask.get(2009)!.ai;
    expect(ai.active).toBe(true);
    h.step();
    expect(ai.created).toBe(true);
    expect(ai.priorities).toEqual(PATROL_PRIORITIES);
    // patrol.qvm: SetViewLength(40), SetAlarmViewLength(50), alpha 50, gamma 45; 2209.qvm then SetViewLength(20).
    expect(ai.view.primary.length).toBe(20 * 4096);
    expect(ai.view.primary.alarmLength).toBe(50 * 4096);
    expect(ai.view.primary.alpha).toBeCloseTo(50 * DEG, 5);
    expect(ai.view.primary.gamma).toBeCloseTo(45 * DEG, 5);
    expect(ai.view.secondary.length).toBe(10 * 4096); // unscripted 80 deg / 10 m peripheral cone
    expect(ai.alarmControlId).toBe(98);
    expect(ai.stack.length).toBe(0); // CREATE queues no action
    expect(h.world.rng.draws).toBe(0);
  });

  it("IDLE runs the mission script: Patrol(2409) queued with IDLE's priority index, non-pushable, one delay draw", async () => {
    const h = await createHarness({ only: [2009] });
    const ai = h.byTask.get(2009)!.ai;
    h.step();
    h.step();
    expect(ai.top?.impl.name).toBe("Patrol");
    expect(ai.top?.priority).toBe(PATROL_PRIORITIES.indexOf(EV.IDLE));
    expect(ai.top?.flags).toBe(0);
    expect((ai.top?.data as { pathId: number }).pathId).toBe(2409);
    expect(h.world.rng.draws).toBe(1); // FUN_0044fc40 reaction delay
    expect(ai.top!.delay).toBeGreaterThanOrEqual(6);
    expect(ai.top!.delay).toBeLessThanOrEqual(12);
  });

  it("3201 (Jones): IDLE is its first priority, invulnerable, and plays animation 61 forever", async () => {
    const h = await createHarness({ only: [4023] });
    const ai = h.byTask.get(4023)!.ai;
    for (let i = 0; i < 40; i++) h.step();
    expect(ai.priorities[0]).toBe(EV.IDLE);
    expect(ai.invulnerable).toBe(true);
    expect(ai.top?.impl.name).toBe("PlayAnimation");
    expect(ai.top?.priority).toBe(0);
    expect(h.byTask.get(4023)!.motor.state).toBe(35);
  });

  it("sniper: the unregistered AIAction_LookAtToEvent faults the run (error 7) and queues nothing", async () => {
    const h = await createHarness({ only: [2000] });
    const s = h.byTask.get(2000)!;
    h.step();
    h.step();
    const ai = s.ai;
    expect(ai.priorities).toEqual(PATROL_PRIORITIES);
    expect(ai.view.primary.length).toBe(100 * 4096);
    const before = ai.top;
    // A DOOR noise in front of the sniper (not behind): sniper.qvm calls AIAction_LookAtToEvent.
    const f = [-Math.sin(s.motor.yaw), Math.cos(s.motor.yaw)];
    ai.receive({ type: EV.DOOR, team: 0, flags: 0x46, range: 20480, position: [s.feet[0] + f[0] * 8192, s.feet[1] + f[1] * 8192, s.feet[2]], source: PLAYER_KEY, other: PLAYER_KEY });
    expect(ai.queues[EV.DOOR].length).toBe(1);
    h.step();
    expect(ai.lastError).toMatch(/unknown identifier "AIAction_LookAtToEvent"/);
    expect(ai.top).toBe(before);
    expect(ai.counts[EV.DOOR]).toBe(1);
  });

  it("receive filter: an enemy gunshot inside 30 m is queued, outside or same-team is dropped", async () => {
    const h = await createHarness({ only: [2009] });
    const s = h.byTask.get(2009)!;
    h.step();
    const shot = (dx: number, team: number) => s.ai.receive({ type: EV.GUNSHOT, team, flags: 0x46, range: 0x1e000, position: [s.feet[0] + dx, s.feet[1], s.feet[2]], source: PLAYER_KEY, other: PLAYER_KEY });
    shot(29 * 4096, 0);
    shot(31 * 4096, 0);
    shot(5 * 4096, 1);
    expect(s.ai.queues[EV.GUNSHOT].length).toBe(1);
  });

  it("script slots and GetRandomValue draw from the level RNG in order", async () => {
    const h = await createHarness({ only: [2009] });
    const s = h.byTask.get(2009)!;
    h.step();
    h.step(); // Patrol queued (1 draw)
    // GUNSHOTMISS: patrol.qvm draws GetRandomValue(1) into real slot 0, then branches on it.
    s.ai.receive({ type: EV.GUNSHOTMISS, team: 0, flags: 0x46, range: 8192, position: [s.feet[0] + 4096, s.feet[1], s.feet[2]], source: PLAYER_KEY, other: PLAYER_KEY });
    const ref = new LevelRng();
    ref.float();
    const r = Math.fround(ref.float());
    h.step();
    expect(s.ai.realSlots.get(0)).toBeCloseTo(r, 6);
  });
});
