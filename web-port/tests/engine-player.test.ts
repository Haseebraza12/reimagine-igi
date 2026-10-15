/**
 * Player-side engine logic against the original data: action bindings from
 * config.qvm names, animation-driven movement speed and footstep triggers.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codeFor } from "../src/engine/input";
import { BodyAnimator } from "../src/engine/player/body";
import { PLAYER_LOCOMOTION_ANIMS, readAnimations } from "../src/loaders";
import { RAW_ROOT, readRaw } from "./helpers";

describe("control bindings", () => {
  it("maps the shipped config.qvm key names to browser codes", () => {
    expect(codeFor("KEY_UP")).toBe("ArrowUp");
    expect(codeFor("KEY_RIGHT_CTRL")).toBe("ControlRight");
    expect(codeFor("KEY_NUMPAD0")).toBe("Numpad0");
    expect(codeFor("KEY_RETURN")).toBe("Enter");
    expect(codeFor("KEY_W")).toBe("KeyW");
    expect(codeFor("KEY_7")).toBe("Digit7");
    expect(codeFor("MOUSE_BUTTON_1")).toBe("Mouse0");
    expect(codeFor("MOUSE_BUTTON_2")).toBe("Mouse2");
    expect(codeFor("KEY_NO_SUCH_KEY")).toBeNull();
  });
});

describe.skipIf(!existsSync(`${RAW_ROOT}/common/anims/000.iff`))("animation-driven player motion (000.iff)", () => {
  it("runs forward at root speed x 1.75 = 5.88 m/s with two footsteps per stride", async () => {
    const anim = readAnimations(await readRaw("common/anims/000.iff"));
    const body = new BodyAnimator(anim);
    body.play(PLAYER_LOCOMOTION_ANIMS.runForward, true);
    // The play tick moves nothing: FUN_004c9650 samples before the advance and a new
    // instance's stored sample is its first key (docs/characters.md "Blending").
    expect(body.step().delta).toEqual([0, 0, 0]);
    const clip = anim.clips.get(PLAYER_LOCOMOTION_ANIMS.runForward)!;
    const ticks = Math.round(clip.seconds * 30) * 4; // four strides
    let forward = 0;
    let sideways = 0;
    let footsteps = 0;
    for (let i = 0; i < ticks; i++) {
      const step = body.step();
      forward += step.delta[1];
      sideways += step.delta[0];
      footsteps += step.triggers.filter((t) => t === 1010).length;
    }
    const speed = ((forward / 4096) * 1.75) / (ticks / 30);
    expect(speed).toBeGreaterThan(5.8);
    expect(speed).toBeLessThan(5.95);
    expect(Math.abs(sideways) / 4096).toBeLessThan(0.05);
    expect(footsteps).toBe(8);
  });

  it("stands still in the idle clip with the pelvis 0.95 m above the feet", async () => {
    const anim = readAnimations(await readRaw("common/anims/000.iff"));
    const body = new BodyAnimator(anim);
    body.play(PLAYER_LOCOMOTION_ANIMS.stand, true);
    let moved = 0;
    let rootZ = 0;
    for (let i = 0; i < 60; i++) {
      const step = body.step();
      moved += Math.hypot(step.delta[0], step.delta[1]);
      rootZ = step.rootZ;
    }
    expect(moved).toBe(0);
    expect(rootZ / 4096).toBeCloseTo(0.95, 2);
  });

  it("crouches through clip 14 to a 0.43 m pelvis, blending over 6 ticks", async () => {
    const anim = readAnimations(await readRaw("common/anims/000.iff"));
    const body = new BodyAnimator(anim);
    body.play(PLAYER_LOCOMOTION_ANIMS.stand, true);
    body.step();
    body.play(PLAYER_LOCOMOTION_ANIMS.crouchDown, false);
    let finished = false;
    let rootZ = 0;
    for (let i = 0; i < 30 && !finished; i++) {
      const step = body.step();
      finished = step.finished;
      rootZ = step.rootZ;
    }
    expect(finished).toBe(true);
    expect(rootZ / 4096).toBeCloseTo(0.43, 1);
  });
});

describe.skipIf(!existsSync(`${RAW_ROOT}/common/anims/000.iff`))("the player's body collision (000_01_1 set 0, posed)", () => {
  it("is hit on the torso at chest height, on a limb at the shin, and missed above the head", async () => {
    const { createFsAssetSource } = await import("../src/loaders/fs-source");
    const { loadIgiLevel, poseSkeleton, sampleClip, hitZoneForBone, HIT_ZONE } = await import("../src/loaders");
    const { BodyCollision } = await import("../src/engine/combat/body-collision");
    const level = await loadIgiLevel(createFsAssetSource(RAW_ROOT));
    expect(level.player.model).toBe("000_01_1");
    const body = BodyCollision.fromModel(level.boneModels.get("000_01_1")!.buffer)!;
    const anim = readAnimations(level.animations.get(0)!);
    const idle = sampleClip(anim.clips.get(PLAYER_LOCOMOTION_ANIMS.stand)!, 0);
    body.pose(poseSkeleton(anim.skeleton, idle.rotations, [0, 0, 0, 1]), idle.translation[2]);
    // Yaw 0 faces engine -z; shoot from 5 m in front (z = -5) towards +z.
    const at = (h: number) => body.raycast(0, h, -5, 0, 0, 1, 0, 10);
    const chest = at(1.3)!;
    expect(chest.front).toBe(true);
    expect(hitZoneForBone(chest.bone)).toBe(HIT_ZONE.TORSO);
    expect(chest.distance).toBeGreaterThan(4.6);
    expect(chest.distance).toBeLessThan(5);
    const shin = at(0.35)!;
    expect(hitZoneForBone(shin.bone)).toBeLessThan(12); // a limb zone
    expect(level.humanPlayer!.zoneMultipliers[hitZoneForBone(shin.bone)]).toBeLessThan(1);
    expect(at(2.1)).toBeNull();
  }, 120000);
});
