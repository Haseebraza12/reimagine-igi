/**
 * Player movement controller.
 *
 * Reads ctx.input + ctx.terrain + ctx.tuning each frame and integrates
 * ctx.player (walk/run/crouch/jump, gravity, ground clamp, friction/accel).
 */
import type { Vec3 } from "../../contracts";
import type { GameContext } from "../context";

/** Maximum terrain rise the player may step onto without being blocked (m). */
const STEP_UP = 1.0;

export interface PlayerController {
  update(dt: number): void;
  /** Re-seed the player at the manifest spawn point. */
  reset(): void;
}

export function createPlayerController(ctx: GameContext): PlayerController {
  /** Re-seed position/velocity/look/health from the manifest spawn point. */
  function reset(): void {
    const p = ctx.player;
    const spawn = ctx.manifest?.playerSpawn;
    if (spawn) {
      p.position = [...spawn.position] as Vec3;
      p.yaw = (spawn.yaw * Math.PI) / 180;
    }
    if (ctx.terrain) {
      const g = ctx.terrain.heightAt(p.position[0], p.position[2]);
      p.position[1] = Math.max(p.position[1], g + 0.1);
    }
    p.velocity = [0, 0, 0] as Vec3;
    p.pitch = 0;
    p.grounded = true;
    p.health = p.maxHealth;
    p.alive = true;
  }

  /**
   * Integrate FPS movement: wish-direction accel/friction, gravity, jump, and a
   * terrain ground-snap with a step-up limit and wall/ledge handling.
   *
   * Confidence: inferred. Tuning values are recovered placeholders; the concrete
   * accel/friction model is a conventional Quake-style web interpretation.
   */
  function update(dt: number): void {
    if (!ctx.running || !ctx.player.alive) return;
    const p = ctx.player;
    const t = ctx.tuning;

    // Look basis from yaw. Forward is -Z rotated by yaw; right is +X rotated.
    const sinY = Math.sin(p.yaw);
    const cosY = Math.cos(p.yaw);
    const fwdX = -sinY;
    const fwdZ = -cosY;
    const rightX = cosY;
    const rightZ = -sinY;

    const fwdInput = ctx.input.forward;
    const strafeInput = ctx.input.strafe;
    const hasInput = fwdInput !== 0 || strafeInput !== 0;

    // Horizontal wish direction (normalized so diagonals are not faster).
    let wishX = fwdX * fwdInput + rightX * strafeInput;
    let wishZ = fwdZ * fwdInput + rightZ * strafeInput;
    const wishLen = Math.hypot(wishX, wishZ);
    if (wishLen > 1e-6) {
      wishX /= wishLen;
      wishZ /= wishLen;
    }

    const speed = ctx.input.crouch
      ? t.crouchSpeed
      : ctx.input.run
        ? t.runSpeed
        : t.walkSpeed;

    const vel = p.velocity;
    if (hasInput) {
      // Accelerate horizontal velocity toward wish*speed at tuning.acceleration.
      const dvx = wishX * speed - vel[0];
      const dvz = wishZ * speed - vel[2];
      const dist = Math.hypot(dvx, dvz);
      if (dist > 1e-6) {
        const step = Math.min(dist, t.acceleration * dt);
        vel[0] += (dvx / dist) * step;
        vel[2] += (dvz / dist) * step;
      }
    } else {
      // No input: apply friction, decaying horizontal velocity toward zero.
      const hs = Math.hypot(vel[0], vel[2]);
      if (hs > 1e-6) {
        const drop = Math.min(hs, t.friction * dt);
        const scale = (hs - drop) / hs;
        vel[0] *= scale;
        vel[2] *= scale;
      } else {
        vel[0] = 0;
        vel[2] = 0;
      }
    }

    // Jump (only from the ground).
    if (p.grounded && ctx.input.jump) {
      vel[1] = t.jumpVelocity;
      p.grounded = false;
    }

    // Gravity.
    vel[1] -= t.gravity * dt;

    // Tentative horizontal move.
    let nx = p.position[0] + vel[0] * dt;
    let nz = p.position[2] + vel[2] * dt;

    const terrain = ctx.terrain;
    if (terrain) {
      // Keep the player inside the terrain grid.
      const minX = terrain.offsetX;
      const maxX = terrain.offsetX + (terrain.size - 1) * terrain.cellSize;
      const minZ = terrain.offsetZ;
      const maxZ = terrain.offsetZ + (terrain.size - 1) * terrain.cellSize;
      nx = Math.min(maxX, Math.max(minX, nx));
      nz = Math.min(maxZ, Math.max(minZ, nz));

      const ground = terrain.heightAt(nx, nz);
      const dh = ground - p.position[1];

      if (p.grounded) {
        if (dh > STEP_UP) {
          // Wall too steep: block the horizontal move, stay planted.
          p.grounded = true;
          vel[1] = 0;
        } else if (dh < -STEP_UP) {
          // Walked off a ledge: keep moving horizontally, begin falling.
          p.position[0] = nx;
          p.position[2] = nz;
          p.position[1] += vel[1] * dt;
          p.grounded = false;
        } else {
          // Walkable step (small rise or drop): snap feet to the ground.
          p.position[0] = nx;
          p.position[2] = nz;
          p.position[1] = ground;
          p.grounded = true;
          vel[1] = 0;
        }
      } else {
        // Airborne: integrate vertical motion and land when we reach the ground.
        p.position[0] = nx;
        p.position[2] = nz;
        p.position[1] += vel[1] * dt;
        if (p.position[1] <= ground) {
          p.position[1] = ground;
          vel[1] = 0;
          p.grounded = true;
        }
      }
    } else {
      // No terrain loaded: free move.
      p.position[0] = nx;
      p.position[2] = nz;
      p.position[1] += vel[1] * dt;
    }
  }

  return { update, reset };
}
