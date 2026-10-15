/**
 * Recovered gameplay rules (src/loaders/gameplay-params.ts). Formula tests run
 * everywhere; data tests read the staged original files (npm run stage) and
 * skip when they are absent. Evidence: docs/gameplay.md, tools/igi_gameplay.py.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  aiHitProbability,
  aiRoundsInSequence,
  BONE_TO_HIT_ZONE,
  bulletPenetrates,
  decodeHumanPlayerParams,
  DETECTION_EVENT_RANGE_M,
  explosionDamage,
  fallDamage,
  fireCooldownTicks,
  fistp,
  GRAVITY_MPS2,
  grenadeThrowSpeed,
  HIT_ZONE,
  hitZoneForBone,
  isInViewCone,
  kmhToUnitsPerTick,
  medipackHeal,
  playerBulletDamage,
  playerLocomotionSpeeds,
  readAiCombatConfig,
  readAnimRootMotion,
  readGameMaterials,
  readWeaponRules,
  sampleSpreadDeviation,
  sampleViewKick,
  secondsToTicks,
  slopeSlide,
  soldierBulletDamage,
  spreadForShot,
  torsoZone,
  type AiView,
} from "../src/loaders/gameplay-params";
import { x87Add, x87Div, x87F32Div, x87Fistp, x87Mul, x87StoreF32 } from "../src/loaders/x87";
import { RAW_ROOT, readRaw } from "./helpers";

const has = (p: string) => existsSync(`${RAW_ROOT}/${p}`);

describe("unit conversion (recovered constants)", () => {
  it("km/h -> units per 1/30 s tick: 27 km/h is exactly 0.25 m per tick", () => {
    expect(kmhToUnitsPerTick(27)).toBeCloseTo(1024, 6);
    expect(kmhToUnitsPerTick(17.5)).toBeCloseTo(663.7037, 3);
  });
  it("FISTP truncates toward zero (igi.exe runs the FPU in chop mode, FUN_004966d0)", () => {
    expect(fistp(7.5)).toBe(7);
    expect(fistp(4.5)).toBe(4);
    expect(fistp(2.9)).toBe(2);
    expect(fistp(-1.75)).toBe(-1); // the value WinMain checks every frame (0x48dbc1)
    expect(fistp(-0.5)).toBe(0);
    expect(Object.is(fistp(-0.5), 0)).toBe(true);
    expect(secondsToTicks(0.25)).toBe(7);
  });
  it("x87 chop-mode arithmetic rounds every result toward zero", () => {
    expect(x87Div(60, 50)).toBe(1.2); // the double 1.2 is already below 6/5
    expect(x87Mul(x87Div(60, 50), 30)).toBe(35.99999999999999); // RN would give 36
    expect(x87Div(60, 150)).toBe(0.39999999999999997); // RN gives 0.4000000000000000222
    expect(x87Mul(24.7, 30)).toBe(740.9999999999999);
    expect(x87Add(0.1, 0.2)).toBe(0.3); // RN gives 0.30000000000000004
    expect(x87StoreF32(0.3)).toBe(0.29999998211860657); // RN float32 is 0.30000001192092896
    expect(x87F32Div(1, 3)).toBe(0.3333333134651184);
    expect(x87Fistp(3e9)).toBe(-1294967296); // fistp QWORD, low dword
    expect(x87Fistp(Number.NaN)).toBe(0);
  });
  it("gravity 84.74 units/tick^2 is 18.62 m/s^2", () => {
    expect(GRAVITY_MPS2).toBeCloseTo(18.62, 2);
  });
});

describe("weapon rules", () => {
  it("cooldown ticks = FISTP(60/rpm x 30), every step chopped", () => {
    expect(fireCooldownTicks(700)).toBe(2); // MP5SD: trunc(2.57) -> 900 rpm effective
    expect(fireCooldownTicks(400)).toBe(4); // Glock: 4.5 -> 4
    expect(fireCooldownTicks(650)).toBe(2); // AK47: 2.77
    expect(fireCooldownTicks(500)).toBe(3); // M16A2: 3.6
    expect(fireCooldownTicks(1200)).toBe(1); // UziX2: 1.5
    expect(fireCooldownTicks(60)).toBe(30); // Colt: 60/60 = 1 exactly
    expect(fireCooldownTicks(40)).toBe(45); // SPAS12: 1.5 x 30 exactly
    expect(fireCooldownTicks(50)).toBe(35); // Dragunov: 60/50 = 1.2 is inexact -> 35.999.. -> 35
    expect(fireCooldownTicks(150)).toBe(11); // knife: 0.4 inexact -> 11.999.. -> 11
  });
  it("first four shots of a burst use the minimum spread", () => {
    expect(spreadForShot(3, 10, 0)).toBe(3);
    expect(spreadForShot(3, 10, 3)).toBe(3);
    expect(spreadForShot(3, 10, 4)).toBe(10);
    expect(spreadForShot(-15, 15, 0)).toBe(15);
  });
  it("spread deviation is cube-distributed up to the spread angle", () => {
    const values = [0.5, 0.5, 0.5, 0.25];
    let i = 0;
    const d = sampleSpreadDeviation(8, () => values[i++]);
    expect(d.deviationRad).toBeCloseTo((8 * 0.125 * Math.PI) / 180, 9);
    expect(d.azimuthRad).toBeCloseTo(Math.PI / 2, 9);
  });
  it("view kick = fixed + random x unit-disk sample", () => {
    const seq = [1, 0.5]; // u = 1, v = 0
    let i = 0;
    const k = sampleViewKick({ kickFixedXDeg: 0.7, kickRandomXDeg: 0.2, kickFixedZDeg: 0, kickRandomZDeg: 0 }, () => seq[i++]);
    expect(k.pitchRad).toBeCloseTo((0.9 * Math.PI) / 180, 9);
    expect(k.yawRad).toBe(0);
  });
  it("penetration: power - hardness >= 1 passes, == 0 is a 60% roll", () => {
    expect(bulletPenetrates(2, 1, () => 0.99)).toBe(true);
    expect(bulletPenetrates(1, 1, () => 0.59)).toBe(true);
    expect(bulletPenetrates(1, 1, () => 0.61)).toBe(false);
    expect(bulletPenetrates(1, 5, () => 0)).toBe(false);
  });
  it("grenade throw speed grows with hold time", () => {
    expect(grenadeThrowSpeed(0, 15)).toBeCloseTo(grenadeThrowSpeed(3, 15), 9);
    expect((grenadeThrowSpeed(60, 15) * 30) / 4096).toBeCloseTo(30.5, 0);
  });
});

describe("damage rules", () => {
  it("player: zone x damage factor x difficulty", () => {
    expect(playerBulletDamage(0.3, 1, "GD_2")).toBeCloseTo(0.3, 9);
    expect(playerBulletDamage(0.3, 0.5, "GD_3")).toBeCloseTo(0.1875, 9);
    expect(playerBulletDamage(0.3, 1, "GD_1")).toBeCloseTo(0.225, 9);
  });
  it("soldiers: head x100, limbs 0.5/0.75/1, head-proof flag", () => {
    expect(soldierBulletDamage(0.2, HIT_ZONE.HEAD)).toBeCloseTo(20, 9);
    expect(soldierBulletDamage(0.2, HIT_ZONE.LIMB_A_DISTAL)).toBeCloseTo(0.1, 9);
    expect(soldierBulletDamage(0.2, HIT_ZONE.HEAD, { headshotProof: true })).toBeCloseTo(0.2, 9);
  });
  it("bone and direction -> zone", () => {
    expect(BONE_TO_HIT_ZONE).toHaveLength(30);
    expect(hitZoneForBone(0)).toBe(HIT_ZONE.TORSO);
    expect(hitZoneForBone(5)).toBe(HIT_ZONE.HEAD);
    expect(hitZoneForBone(27)).toBe(HIT_ZONE.LIMB_A_DISTAL);
    expect(torsoZone(0, 1)).toBe(HIT_ZONE.TORSO_FRONT);
    expect(torsoZone(0, -1)).toBe(HIT_ZONE.TORSO_BACK);
    expect(torsoZone(1, 0.2)).toBe(HIT_ZONE.TORSO);
  });
  it("fall damage starts at 14 m/s and kills (max 3) at 27 m/s", () => {
    expect(fallDamage(13.9, 3)).toBe(0);
    expect(fallDamage(27, 3)).toBeCloseTo(3, 9);
    expect(fallDamage(20.5, 3)).toBeCloseTo(1.5, 9);
  });
  it("medipack heals 1% of max per round, clamped", () => {
    expect(medipackHeal(1, 3)).toBeCloseTo(0.97, 9);
    expect(medipackHeal(0.01, 3)).toBe(0);
  });
  it("explosion: full inside radius, linear over falloff", () => {
    expect(explosionDamage(5, 0.3, 7, 3, 1)).toBe(1);
    expect(explosionDamage(8.8, 0.3, 7, 3, 1)).toBeCloseTo(0.5, 9);
    expect(explosionDamage(20, 0.3, 7, 3, 1)).toBe(0);
  });
  it("slopes slide above 45 degrees", () => {
    expect(slopeSlide(40)).toBeNull();
    expect(slopeSlide(47)?.mode).toBe("add");
    expect(slopeSlide(85)).toEqual({ mode: "set", unitsPerTick: 1137 });
  });
});

describe("AI combat and detection rules", () => {
  it("hit probability is linear from 0 m to the view length", () => {
    expect(aiHitProbability(0, 40, 1, 0.4)).toBe(1);
    expect(aiHitProbability(20, 40, 1, 0.4)).toBeCloseTo(0.7, 9);
    expect(aiHitProbability(80, 40, 1, 0.4)).toBeCloseTo(0.4, 9);
  });
  it("rounds per sequence from the clip fractions", () => {
    const cfg = { minClipFraction: 0.3, randomClipFraction: 0.3, maxRoundsPerSequence: 30 };
    // float32 store (chop: 0.3 -> 0.29999998) then fistp: trunc(9.5999994) = 9
    expect(aiRoundsInSequence({ roundsPerClip: 32, maxRoundsPerBurst: 32 }, cfg, () => 0)).toBe(9);
    expect(aiRoundsInSequence({ roundsPerClip: 32, maxRoundsPerBurst: 32 }, cfg, () => 0.999)).toBe(19);
    expect(aiRoundsInSequence({ roundsPerClip: 100, maxRoundsPerBurst: 100 }, { ...cfg, maxRoundsPerSequence: 12 }, () => 0.5)).toBe(12);
  });
  it("alpha bounds the vertical angle, gamma the horizontal one", () => {
    const guard: AiView = { lengthM: 40, alarmLengthM: 50, verticalHalfAngleDeg: 50, horizontalHalfAngleDeg: 45 };
    const sniper: AiView = { lengthM: 100, alarmLengthM: 110, verticalHalfAngleDeg: 30, horizontalHalfAngleDeg: 15 };
    const right40: [number, number, number] = [Math.sin((40 * Math.PI) / 180) * 10, Math.cos((40 * Math.PI) / 180) * 10, 0];
    const up40: [number, number, number] = [0, Math.cos((40 * Math.PI) / 180) * 10, Math.sin((40 * Math.PI) / 180) * 10];
    expect(isInViewCone(right40, guard, false)).toBe(true);
    expect(isInViewCone(right40, sniper, false)).toBe(false);
    expect(isInViewCone(up40, guard, false)).toBe(true);
    expect(isInViewCone(up40, sniper, false)).toBe(false);
    expect(isInViewCone([0, 45, 0], guard, false)).toBe(false);
    expect(isInViewCone([0, 45, 0], guard, true)).toBe(true);
  });
  it("hearing ranges are whole metres", () => {
    expect(DETECTION_EVENT_RANGE_M.HUMANAI_DETECTIONEVENT_GUNSHOT_RANGE).toBe(30);
    expect(DETECTION_EVENT_RANGE_M.HUMANAI_DETECTIONEVENT_GUNSHOT_SILENCED_RANGE).toBe(1);
  });
});

describe.skipIf(!has("humanplayer/humanplayer.qvm"))("humanplayer.qvm", () => {
  it("decodes DefineHumanPlayerGeneral into named fields", async () => {
    const p = decodeHumanPlayerParams(await readRaw("humanplayer/humanplayer.qvm"));
    expect(p.rawGeneral).toHaveLength(43);
    expect(p.animationSpeedScale).toBe(1.75);
    expect(p.jumpVerticalSpeedMps).toBeCloseTo(7.5, 9);
    expect(p.jumpHorizontalSpeedMps).toBeCloseTo(4.8611, 3);
    expect(p.airControlAccelMps2).toBeCloseTo(4.1667, 3);
    expect(p.leanSideM).toBeCloseTo(0.85, 6);
    expect(p.leanTicks).toBe(7); // FISTP(0.25 x 30 = 7.5) truncates (0x4101ff)
    expect(p.maxDamage).toBe(3);
    expect(p.fenceShockDamage).toBe(0.5);
    expect(p.zoneMultipliers).toEqual([0.5, 0.75, 1, 0.5, 0.75, 1, 0.5, 0.75, 1, 0.5, 0.75, 1, 1, 1, 1, 1, 1]);
    expect(p.unusedZoneTable.slice(15)).toEqual([100000, 100000]);
    expect(p.weaponCategories).toHaveLength(9);
    expect(p.weaponCategories[2]).toEqual(["WEAPON_ID_UZI", "WEAPON_ID_UZIX2", "WEAPON_ID_MP5SD"]);
    expect(p.ammoLimits.AMMO_ID_919).toBe(196);
    expect(p.weaponCycle).toHaveLength(18);
  });
});

describe.skipIf(!has("weapons/weaponconfig.qvm"))("weaponconfig.qvm", () => {
  it("decodes the rules the game uses", async () => {
    const w = readWeaponRules(await readRaw("weapons/weaponconfig.qvm"));
    expect(w.size).toBe(24);
    const mp5 = w.get("WEAPON_ID_MP5SD")!;
    expect(mp5.damageFactor).toBeCloseTo(0.2, 6); // weaponconfig, not weapon.qvm's 0.15
    expect(mp5.cooldownTicks).toBe(2);
    expect(w.get("WEAPON_ID_DRAGUNOV")!.cooldownTicks).toBe(35);
    expect(mp5.noiseRangeM).toBe(1);
    expect(w.get("WEAPON_ID_AK47")!.noiseRangeM).toBe(30);
    expect(w.get("WEAPON_ID_DRAGUNOV")!.noiseRangeM).toBe(1);
    expect(w.get("WEAPON_ID_SPAS12")!.pellets).toBe(30);
    expect(w.get("WEAPON_ID_MEDIPACK")!.tags["Factor of human max damage to add for each round"]).toBeCloseTo(0.01, 6);
    expect(w.get("WEAPON_ID_GRENADE")!.tags["Grenade - Explosion radius (meters)"]).toBe(7);
  });
});

describe.skipIf(!has("common/ai/settings.qvm"))("settings.qvm", () => {
  it("soldier health is the Damage scale", async () => {
    const ai = readAiCombatConfig(await readRaw("common/ai/settings.qvm"), "GD_2");
    expect(ai.get("AITYPE_GUARD_AK")!.health).toBe(1);
    expect(ai.get("AITYPE_SPETNAZ_GUARD_AK")!.health).toBe(1.5);
    expect(ai.get("AITYPE_EKK")!.health).toBe(2.5);
    expect(ai.get("AITYPE_GUARD_AK")!.hitProbabilityAt0m).toBe(1);
    expect(ai.get("AITYPE_GUARD_AK")!.hitProbabilityAtViewLength).toBeCloseTo(0.4, 6);
    expect(ai.get("AITYPE_GUARD_AK")!.flinchThreshold).toBeCloseTo(0.7, 6);
  });
});

describe.skipIf(!has("common/anims/000.iff") || !has("humanplayer/humanplayer.qvm"))("000.iff root motion", () => {
  it("gives the player's locomotion speeds (root x 1.75)", async () => {
    const anims = readAnimRootMotion(await readRaw("common/anims/000.iff"));
    expect(anims.get(4)?.loops).toBe(true);
    expect(anims.get(4)?.durationTicks).toBe(3360);
    const p = decodeHumanPlayerParams(await readRaw("humanplayer/humanplayer.qvm"));
    const v = playerLocomotionSpeeds(anims, p.animationSpeedScale);
    expect(v.runForward).toBeCloseTo(5.875, 2);
    expect(v.runLeft).toBeCloseTo(4.806, 2);
    expect(v.walkForward).toBeCloseTo(2.177, 2);
    expect(v.crouchForward).toBeCloseTo(2.788, 2);
    expect(v.stand).toBe(0);
  });
});

describe.skipIf(!has("material/material.qvm"))("material.qvm", () => {
  it("footstep noise ranges", async () => {
    const m = readGameMaterials(await readRaw("material/material.qvm"));
    expect(m.find((x) => x.name === "Gravel")?.footstepNoiseM).toBe(10);
    expect(m.find((x) => x.name === "Concrete")?.hardness).toBe(5);
  });
});
