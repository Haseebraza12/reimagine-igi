/**
 * First-person camera controller.
 *
 * Applies ctx.player yaw/pitch to ctx.camera each frame and positions the
 * camera at eye height above the player's feet.
 */
import type { GameContext } from "../context";

export interface CameraController {
  update(dt: number): void;
}

export function createCameraController(ctx: GameContext): CameraController {
  return {
    update(_dt: number): void {
      const p = ctx.player;
      // Eye height above the feet (lower when crouching).
      const eye = p.crouching ? ctx.tuning.crouchEyeHeight : ctx.tuning.eyeHeight;
      // YXZ so yaw is applied around world-up first, then pitch around the
      // (yawed) local X axis — the standard FPS look order. The camera's -Z
      // then points where the player looks, which the weapon hitscan uses.
      ctx.camera.rotation.order = "YXZ";
      ctx.camera.rotation.set(p.pitch, p.yaw, 0);
      ctx.camera.position.set(p.position[0], p.position[1] + eye, p.position[2]);
    },
  };
}
