/**
 * The player's own body in the third-person views [recovered, docs/interactions.md §10]:
 * FUN_0045ddd0 / FUN_0045dd70 skip the camera owner's body and hand item
 * only in view mode 1, so the HumanPlayer model (000_01_1 on skeleton 0) and
 * the item in its hand are drawn in mode 3 (attached / using), mode 5 (dead)
 * and whenever a cut-scene camera is active. It is posed with the clip that
 * plays on the player's body animator (player.ts bodyPose()) and lit like the
 * soldiers (combat/soldier-body.ts).
 *
 * Inferred: the hand item is the inventory hand slot while holstered (S0
 * does not swap the hand), on bone 22 like the soldiers' guns.
 */
import * as THREE from "three";
import type { Vec3 } from "../../contracts";
import type { LevelSoldier } from "../../loaders";
import { SoldierAssets, SoldierBody } from "../combat/soldier-body";
import type { GameContext } from "../context";

/** The player's body pose for one tick (player.ts bodyPose()). */
export interface PlayerBodyPose {
  clipId: number;
  /** Clip time, animation ticks (160 per game tick). */
  time: number;
  loop: boolean;
  /** Root height (IGI units) the clip puts the pelvis at. */
  rootZ: number;
  /** Feet position, engine metres. */
  feet: Vec3;
  /** Body heading (engine yaw = IGI gamma). */
  yaw: number;
  /** The blend tree's bone rotations (both clips during a fade); null = sample clipId at time. */
  rotations?: ArrayLike<number> | null;
}

export interface PlayerBodyRenderer {
  /** Draw the body with `pose` (null hides it) and the hand item `weaponId`. */
  update(pose: PlayerBodyPose | null, weaponId: string | null): void;
  /** World position of the hand item (bone 22) from the last pose, engine space, or null. */
  gunPosition(): [number, number, number] | null;
  dispose(): void;
}

export function createPlayerBodyRenderer(ctx: GameContext, scene: THREE.Scene): PlayerBodyRenderer {
  let assets: SoldierAssets | null = null;
  let body: SoldierBody | null = null;
  let bodyLevel: unknown = null;
  let bodyWeapon: string | null = null;

  function build(weaponId: string | null): SoldierBody | null {
    const level = ctx.level;
    if (!level) return null;
    const model = level.player.model;
    if (!model) return null;
    if (bodyLevel !== level) {
      assets?.dispose();
      assets = new SoldierAssets(level);
      bodyLevel = level;
      body = null;
    }
    if (body && bodyWeapon === weaponId) return body;
    if (body) scene.remove(body.object);
    const record: LevelSoldier = {
      taskId: -1,
      name: "HumanPlayer",
      position: [0, 0, 0],
      yaw: 0,
      team: 0,
      model,
      aiType: null,
      weapon: weaponId,
      view: null,
      combat: null,
      skeleton: 0,
      standAnimation: -1,
      aiTaskId: null,
      graphId: null,
    };
    body = new SoldierBody(assets!, record, -1, weaponId);
    bodyWeapon = weaponId;
    body.object.visible = false;
    scene.add(body.object);
    return body;
  }

  return {
    update(pose, weaponId) {
      if (!pose) {
        if (body) body.object.visible = false;
        return;
      }
      const b = build(weaponId);
      if (!b) return;
      b.animator.clip = { id: pose.clipId, loop: pose.loop, time: pose.time };
      b.pose(pose.feet, pose.yaw, { rootZ: pose.rootZ, gunVisible: weaponId !== null, rotations: pose.rotations ?? null });
      b.object.visible = true;
    },
    gunPosition() {
      return body && body.hasPose && body.object.visible ? body.gunPosition() : null;
    },
    dispose() {
      if (body) scene.remove(body.object);
      body = null;
      assets?.dispose();
      assets = null;
      bodyLevel = null;
    },
  };
}
