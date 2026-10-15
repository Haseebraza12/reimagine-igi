/**
 * HumanCamera view modes (FUN_00480dc0; docs/interactions.md section 10):
 * mode 1 first person, 3 third-person orbit while attached / using, 5 death.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { GameContext } from "../src/engine/context";
import { THIRD_PERSON, createCameraController, playerViewMode } from "../src/engine/player/camera";
import { createFirstPersonState } from "../src/engine/player/first-person";
import { CollisionWorldBuilder, TRI_BULLET, TRI_SIGHT, TRI_SOLID } from "../src/engine/world/collision";

const ALL = TRI_SOLID | TRI_BULLET | TRI_SIGHT;
const U = 1 / 4096;

function makeCtx(world: GameContext["world"] = null) {
  const interactions = { busy: null as null | "attached" | "hacking" | "picking" };
  const ctx = {
    player: {
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      yaw: 0,
      pitch: 0.3,
      grounded: true,
      crouching: false,
      running: false,
      health: 3,
      maxHealth: 3,
      alive: true,
      walking: false,
      eyeHeight: 1.64,
      kickPitch: 0,
      kickYaw: 0,
      leanSide: 0,
      leanUp: 0,
    },
    firstPerson: createFirstPersonState(() => null),
    systems: { player: { interactions } },
    camera: new THREE.PerspectiveCamera(),
    world,
    level: null,
  } as unknown as GameContext;
  return { ctx, interactions };
}

describe("HumanCamera view mode", () => {
  it("follows the player's state: 3 attached or using, 5 dead, else 1", () => {
    const { ctx, interactions } = makeCtx();
    expect(playerViewMode(ctx)).toBe(1);
    interactions.busy = "attached";
    expect(playerViewMode(ctx)).toBe(3);
    interactions.busy = "hacking";
    expect(playerViewMode(ctx)).toBe(3);
    interactions.busy = "picking";
    expect(playerViewMode(ctx)).toBe(3);
    ctx.player.alive = false;
    expect(playerViewMode(ctx)).toBe(5);
  });

  it("orbits 2.5 m behind the body, looking at the eye, without zoom; arms flagged hidden", () => {
    const { ctx, interactions } = makeCtx();
    const cam = createCameraController(ctx);
    cam.update(0);
    expect(ctx.camera.position.y).toBeCloseTo(1.64, 9); // first person: at the eye
    interactions.busy = "attached";
    ctx.firstPerson!.tanX = 0.2; // a zoom is ignored in mode 3
    cam.update(0);
    expect(cam.viewMode()).toBe(3);
    expect(ctx.firstPerson!.viewMode).toBe(3);
    // Facing -z (yaw 0): the camera is behind, at +z, at eye height (orbit angles reset to 0).
    expect(ctx.camera.position.x).toBeCloseTo(0, 9);
    expect(ctx.camera.position.y).toBeCloseTo(1.64, 9);
    expect(ctx.camera.position.z).toBeCloseTo(THIRD_PERSON.distance * U, 9);
    const dir = new THREE.Vector3();
    ctx.camera.getWorldDirection(dir);
    expect(dir.z).toBeCloseTo(-1, 9);
    expect(ctx.camera.fov).toBeCloseTo(73.74, 2);
    // Mouse right turns the orbit like the view (yaw -0.698 x channel), up / down pitch +-75 deg max.
    cam.orbitTick(255, 0);
    cam.update(0);
    expect(ctx.camera.position.x).toBeLessThan(0);
    for (let i = 0; i < 10; i++) cam.orbitTick(0, 255);
    cam.update(0);
    const behind = ctx.camera.position.clone().sub(new THREE.Vector3(0, 1.64, 0));
    expect(Math.asin(-behind.y / behind.length())).toBeCloseTo(THIRD_PERSON.pitchLimit, 6);
    // Back to first person: the orbit is reset on the next entry.
    interactions.busy = null;
    cam.update(0);
    expect(ctx.firstPerson!.viewMode).toBe(1);
    interactions.busy = "attached";
    cam.update(0);
    expect(ctx.camera.position.z).toBeCloseTo(THIRD_PERSON.distance * U, 9);
  });

  it("pulls the camera in front of a wall only when the body cannot be seen from it", () => {
    const b = new CollisionWorldBuilder();
    // An opaque wall 1 m behind the player (the plane z = 1), wider and taller than the pelvis box.
    b.addIndexed([-5, -1, 1, 5, -1, 1, 5, 5, 1, -5, 5, 1], [0, 1, 2, 0, 2, 3], ALL, -1, -1);
    const { ctx, interactions } = makeCtx(b.build());
    interactions.busy = "attached";
    const cam = createCameraController(ctx);
    cam.update(0);
    expect(ctx.camera.position.z).toBeCloseTo(1 - THIRD_PERSON.pullIn * U, 6);
  });
});
