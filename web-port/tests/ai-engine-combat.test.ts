/**
 * Soldier-AI engine: combat and firing (docs/ai.md 6-7): a guard that sees
 * the player fires sequences of aiRoundsPerSequence rounds, the first at
 * half the hit probability; the per-bullet player filter draws the level RNG
 * only for rays reaching the hitbox.
 */
import { describe, expect, it } from "vitest";
import { aiHitProbability, aiRoundsPerSequence } from "../src/loaders/ai-rules";
import { aiBulletVsPlayer, rayCapsule } from "../src/engine/ai/ballistics";
import type { FireSequence } from "../src/engine/ai/combat";
import { PLAYER_KEY } from "../src/engine/ai/types";
import { HAVE_LEVEL, createHarness } from "./ai-engine-harness";

describe("AI bullet vs the player (FUN_0045d100)", () => {
  it("draws rand only when the ray reaches the hitbox and collides when rand <= p", () => {
    const player = { feet: [0, 0, 10] as const, crouched: false };
    let draws = 0;
    const rand = (v: number) => () => (draws++, v);
    // Straight at the chest from 10 m.
    expect(rayCapsule([0, 1.2, 0], [0, 0, 1], 50, player.feet, 1.8, 0.35)).toBeCloseTo(9.65, 5);
    expect(aiBulletVsPlayer([0, 1.2, 0], [0, 0, 1], 50, player, 0.5, rand(0.4)).hit).toBe(true);
    const pass = aiBulletVsPlayer([0, 1.2, 0], [0, 0, 1], 50, player, 0.5, rand(0.6));
    expect(pass.hit).toBe(false);
    expect(pass.nearMiss).not.toBeNull(); // passed through: near-miss sound
    expect(draws).toBe(2);
    // 1.5 m to the side: no hitbox contact, no draw, but a near miss; 3 m: nothing.
    const side = aiBulletVsPlayer([1.5, 1.2, 0], [0, 0, 1], 50, player, 1, rand(0));
    expect(side.hit).toBe(false);
    expect(side.nearMiss![0]).toBeCloseTo(1.5, 5);
    expect(aiBulletVsPlayer([3, 1.2, 0], [0, 0, 1], 50, player, 1, rand(0)).nearMiss).toBeNull();
    expect(draws).toBe(2);
    // A wall before the player (limit) stops the ray.
    expect(aiBulletVsPlayer([0, 1.2, 0], [0, 0, 1], 5, player, 1, rand(0)).hit).toBe(false);
    // Crouched: a ray at 1.5 m height passes over the 1.3 m hitbox.
    expect(rayCapsule([0, 1.5, 0], [0, 0, 1], 50, player.feet, 1.3, 0.35)).toBeNull();
  });
});

describe.skipIf(!HAVE_LEVEL)("guard combat on level-1 data", () => {
  it("guard 2225 detects the player 10 m in front and fires sequences of the recovered length; first sequence at p/2", async () => {
    const h = await createHarness({ only: [2025] });
    const s = h.byTask.get(2025)!;
    h.ray = () => true;
    // Let the guard settle at its post (WALKTO 125, LOOKATNODE 184).
    for (let i = 0; i < 400; i++) h.step();
    expect(s.ai.top?.impl.name === "Patrol" || s.ai.top === null).toBe(true);
    const yaw = s.motor.yaw;
    h.player.feet = [s.feet[0] - Math.sin(yaw) * 10 * 4096, s.feet[1] + Math.cos(yaw) * 10 * 4096, s.feet[2]];
    const sequences: Array<{ rounds: number; p: number; shots: number }> = [];
    let current: FireSequence | null = null;
    let shotsAtStart = 0;
    for (let i = 0; i < 400 && sequences.length < 3; i++) {
      h.step();
      const top = s.ai.top;
      const fire = top?.impl.name.startsWith("Combat") ? (top.data as { fire: FireSequence | null }).fire : null;
      if (fire !== current) {
        if (current) sequences.push({ rounds: current.rounds, p: current.p, shots: s.shots - shotsAtStart });
        current = fire;
        shotsAtStart = s.shots;
      }
    }
    expect(s.ai.top?.impl.name).toBe("Combat(guard)");
    expect(s.ai.target?.key).toBe(PLAYER_KEY);
    expect(sequences.length).toBeGreaterThanOrEqual(2);
    const settings = h.data.combat.get("AITYPE_GUARD_AK")!;
    const d = 10 * 4096;
    const full = aiHitProbability(d, s.ai.view.primary.length, settings, false);
    // p is computed from the eye-to-aim-point distance: within a few percent of 10 m.
    expect(sequences[0].p).toBeGreaterThan(full / 2 - 0.03);
    expect(sequences[0].p).toBeLessThan(full / 2 + 0.03);
    expect(sequences[1].p).toBeGreaterThan(full - 0.05);
    for (const q of sequences) {
      // AK47: Rounds/Clip 32 = Maximum Rounds/Burst -> FISTP(32 x (r x 0.3 + 0.3)), at most 30.
      expect(q.rounds).toBeGreaterThanOrEqual(aiRoundsPerSequence(settings, 32, 32, 0));
      expect(q.rounds).toBeLessThanOrEqual(aiRoundsPerSequence(settings, 32, 32, 0.9999));
      expect(q.shots).toBe(q.rounds);
    }
  });

  it("a guard that loses sight turns toward the last known position and gives up after the targeting timeout", async () => {
    const h = await createHarness({ only: [2025] });
    const s = h.byTask.get(2025)!;
    for (let i = 0; i < 400; i++) h.step();
    const yaw = s.motor.yaw;
    h.player.feet = [s.feet[0] - Math.sin(yaw) * 10 * 4096, s.feet[1] + Math.cos(yaw) * 10 * 4096, s.feet[2]];
    for (let i = 0; i < 60 && !s.ai.top?.impl.name.startsWith("Combat"); i++) h.step();
    expect(s.ai.top?.impl.name).toBe("Combat(guard)");
    h.ray = () => false; // the player hides
    const cfg = h.data.combat.get("AITYPE_GUARD_AK")!;
    let ticks = 0;
    while (s.ai.top?.impl.name.startsWith("Combat") && ticks < cfg.targetingTimeoutTicks + 100) {
      h.step();
      ticks++;
    }
    expect((s.ai.top?.impl.name ?? "-").startsWith("Combat")).toBe(false);
    expect(ticks).toBeGreaterThan(cfg.targetingTimeoutTicks);
    // The running fire / reload sub-state finishes before the not-visible count starts.
    expect(ticks).toBeLessThan(cfg.targetingTimeoutTicks + 120);
  });
});
