/**
 * First-person camera controller. OWNED BY: engine/player agent.
 *
 * Applies ctx.player yaw/pitch to ctx.camera each frame and positions the
 * camera at eye height above the player's feet. Replaces this stub.
 */
import type { GameContext } from "../context";

export interface CameraController {
  update(_dt: number): void;
}

export function createCameraController(ctx: GameContext): CameraController {
  return {
    update(_dt: number): void {
      const p = ctx.player;
      const eye = p.crouching ? ctx.tuning.crouchEyeHeight : ctx.tuning.eyeHeight;
      ctx.camera.position.set(p.position[0], p.position[1] + eye, p.position[2]);
      ctx.camera.rotation.set(0, 0, 0);
      ctx.camera.rotateY(p.yaw);
      ctx.camera.rotateX(p.pitch);
    },
  };
}
