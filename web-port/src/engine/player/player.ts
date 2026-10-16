/**
 * Player movement, one call per 30 Hz game tick, in the order of igi.exe's
 * player tick FUN_00410a30 (docs/gameplay.md, docs/characters.md,
 * docs/collision.md):
 *
 *   0. FUN_0045f930: the motion since the last tick of the task the player
 *      stands on or is attached to (Train, Car, Elevator, StationaryGun:
 *      updatePlatform, docs/collision.md section 13); its yaw is added to
 *      the heading (FUN_0045fd00), its displacement moves the start of the
 *      move and joins the air velocity of a jump (0x40bc87) or fall (0x40bee0).
 *   1. Movement state graph (human+0x2ec, FUN_004e2d60; player/movement-graph.ts,
 *      docs/gameplay.md "Player movement state graph") [recovered]: the
 *      condition bits (FUN_004106b0: grounded, roof, walking flag, the held
 *      input channels), then the installed tick of the current state. A
 *      switch calls the new state's enter at once: low-profile flag +0x33d,
 *      clip slot = state (table 0x5368c8) with a 0.2 s blend (0 for the jump,
 *      the fall and the run states entered from the jump), the stride phase
 *      kept from listed neighbours, the arms mode wanted (+0xd5c).
 *      - stand 0 / run 1-8 (walking flag clear) / walk 9-16 (set) /
 *        crouched 19-27 while Crouch is held or the "Roof!" flag is set;
 *        stance changes blend straight between them (17 / 18 are never
 *        entered); Jump (press edge) only from 0-16;
 *      - ground lost -> fall 29 (FUN_0040bec0): stance standing, slot 29
 *        (clip 2), air velocity = the previous tick's root motion;
 *      - Jump -> jump 28 (FUN_0040bb80): stance standing, slot 28 (clip 25)
 *        at 0.4 x speed, air velocity = previous root-motion direction x
 *        jump horizontal speed (0 when standing still) + jump vertical
 *        speed, the ground is released (FUN_00461f10); "jump_1";
 *      - airborne (FUN_0040bce0 / FUN_0040bf50 -> FUN_00408570): vz -= 84.74
 *        units/tick, each held direction adds the air-control speed along the
 *        body axes; once the last move ended grounded, the landing is taken:
 *        v = |vz| x 30/4096 m/s, fall damage (v - 14)/13 x capacity, the land
 *        sound of the ground material, air velocity and knock-back cleared;
 *        the jump lands in the move state of the held direction, the fall in 0;
 *      - lean 44 (entered by the weapon machine's S5, beginLean / endLean;
 *        FUN_0040e0c0) and map computer 45 (weapon S11, openMapComputer;
 *        FUN_0040e470 / FUN_0040e4c0).
 *   ToggleWalkRun's press edge flips the walking flag +0xd45 after the graphs.
 *   2. Body animation (player/body.ts): FUN_004c9650 samples the root (the
 *      blended change since the last sample x DefineHumanPlayerGeneral arg 0
 *      (1.75), rotated by the body yaw, is this tick's root motion; its z is
 *      the pelvis height), then FUN_00460010 advances the blend tree.
 *   3. FUN_004600f0 moves the body (world/character.ts moveHuman).
 *   4. Footsteps (FUN_00462560, animation trigger 1010) use the material of
 *      the ground record; crouched steps are quiet (+0x33d).
 *   Bullet hits push: knock-back += normalised shot direction (x, y) x 5 km/h
 *   (FUN_004123e0, 0x531504); explosions add theirs (addKnock, FUN_00412930);
 *   it decays x0.9 per tick in the move.
 *
 * Use / Activate (player/interact.ts, docs/interactions.md): at the start of
 * the tick FUN_0045fb20 searches the use target (grounded, not in use); the
 * Activate dispatch FUN_0040ce30 presses switches, opens doors, starts
 * hacking or attaches to a ladder, fence or wire. While attached
 * (player/attach.ts) the tick runs the attached state handler and moves the
 * body by the clip's root change without collision, mirroring FUN_00410a30's
 * `+0x694 ? no collision : FUN_004600f0` (the ladder slide collides). After
 * the move FUN_00410f10 offers the pickups (combat/pickups.ts) to the player.
 *
 * Not implemented: the landing camera dip (FUN_00464620, weapon.ts has it),
 * the hit view shake (FUN_004645e0), the jump refusal on a moving platform
 * (FUN_0040bb80 +0x768) and the flinch / death states 46 / 47 (no setter of
 * the player's flinch bit 0x10000 was found; death ends the controller).
 */
import type { Vec3 } from "../../contracts";
import {
  GRAVITY_UNITS_PER_TICK2,
  HIT_ZONE,
  PLAYER_CLIP_SLOTS,
  fallDamage,
  hitZoneForBone,
  poseSkeleton,
  readAnimations,
  sampleClip,
  sampleTranslation,
  torsoZone,
  touchGenericPickup,
  type MissionRuntime,
} from "../../loaders";
import { stringParam, vec3Param } from "../../loaders/tasks";
import { phaseTime } from "../ai/clip-player";
import { BodyCollision } from "../combat/body-collision";
import { x87Mul, x87StoreF32 } from "../../loaders/x87";
import type { GameContext } from "../context";
import { GameEvent } from "../events";
import {
  PLATFORM_TASK_TYPES,
  attachHuman,
  createHumanMoveState,
  detachHuman,
  groundBelow,
  leaveGround,
  moveHuman,
  updatePlatform,
  type HumanMoveOptions,
  type HumanMoveState,
} from "../world/character";
import type { AttachState } from "./attach";
import { BodyAnimator } from "./body";
import { INTERACT_EVENTS, createInteractions, engineToIgi, igiToEngine, type InteractionController, type InteractionOptions } from "./interact";
import {
  NO_CHANNELS,
  PLAYER_STATE,
  STATE_ENTRIES,
  conditionBits,
  createLeanState,
  groundTransition,
  landingState,
  leanTick,
  type LeanParams,
  type PlayerChannels,
} from "./movement-graph";
import { createPickupSystem, type PickupSystem } from "../combat/pickups";
import { STATIONARY_GUN, stationaryGunsOf } from "../combat/stationary-guns";

/** combat: movement state 33, the StationaryGun (FUN_0040c970 enter, 0x40cae0 tick; table 0x5385b4 entry 0x538638, full exe). */
const STATIONARY_GUN_STATE = 33;

const U = 1 / 4096;
const TICKS_PER_SECOND = 30;
/** Gravity per tick, metres (0x5313f0). */
const GRAVITY_M_PER_TICK2 = GRAVITY_UNITS_PER_TICK2 * U;
/** Bullet knock-back: 5 km/h in units/tick (f32 189.6296 at 0x531504). */
const BULLET_KNOCK_M_PER_TICK = Math.fround(189.62962341308594) * U;
/** Eye above the pelvis: 0.69 m standing / 0.35 m crouched (FUN_00464490). */
const EYE_ABOVE_PELVIS = { standing: 2826.24 * U, crouched: 1433.6 * U };
/** Falling this far below the spawn means the player dropped through a gap: fatal, never a respawn. */
const KILL_DEPTH = 400;
const FOOTSTEP_TRIGGER = 1010;
/** The weapon machine's idle state S1 (FUN_0040ead0), where Activate is read (combat/weapon.ts WEAPON_STATE.ready). */
const WEAPON_READY_STATE = 1;
/** Knock-back decay per tick (f32 0x5315bc, FUN_004600f0). */
const KNOCK_DECAY = Math.fround(0.9);
/** DefineHumanPlayerGeneral arguments 0-3 and 4-7 as shipped, when humanplayer.qvm is missing. */
const DEFAULT_GENERAL = [1.75, 17.5, 27, 0.5, 0.85, 0.85, 0.25, 3];
/** FISTP(0.25 x 30) in chop mode = 7 (FUN_00410160). */
const DEFAULT_LEAN_TICKS = 7;
/**
 * The player's zone records at 0x536a50 (FUN_00488050 at 0x4105a1; 16 bytes:
 * multiplier, flinch clip, death clip A, death clip B) [recovered]: the death
 * clips per hit zone 0-16. State 47 (FUN_0040e660) plays record[zone][rand(2)].
 */
const PLAYER_DEATH_CLIPS: ReadonlyArray<readonly [number, number]> = [
  [201, 202], [201, 202], [201, 202], [201, 202], [201, 202], [201, 202],
  [201, 202], [201, 202], [201, 202], [201, 202], [201, 202], [201, 202],
  [201, 202], [201, 202], [215, 215], [112, 112], [204, 204],
];
/** Zone of fall damage, explosions and melee from the front (0x408570 writes 0xd to +0x2e8). */
const DEFAULT_HIT_ZONE = 13;
/** FUN_0040bb80: the jump clip's speed (FUN_004ccc10(human+0x68, 0, 0.4f), 0x3ecccccd). */
const JUMP_CLIP_SPEED = Math.fround(0.4);
/** Lean and map-computer enters blend their clip over 0.2 s (0x3e4ccccd). */
const BLEND_02 = Math.fround(0.2);
/** km/h -> units/tick as FUN_00410160 stores it: arg x 4096000f x (1/108000)f, float32, chop mode. */
const kmhToUnitsPerTickF32 = (kmh: number) => x87StoreF32(x87Mul(x87Mul(kmh, 4096000), Math.fround(1 / 108000)));

/**
 * Emitted when the movement state 45 opens (`{ open: true }`, FUN_0040e470
 * creates the Computer, FUN_0046aba0) and closes (`{ open: false }`,
 * FUN_0040e4c0 destroys it, FUN_0046abd0). game.ts opens / closes the HUD's
 * map computer on it.
 */
export const MAP_COMPUTER_EVENT = "game:map-computer";
/** State 47 entered (FUN_0040e660): payload { clip }. The death speech player_death_{rand(3)} plays here. */
export const PLAYER_DEATH_EVENT = "game:player-death-state";
/** The dead player released its hand item: payload { weaponId }. game.ts drops it at the hand (pickups.drop). */
export const PLAYER_RELEASE_EVENT = "game:player-release-item";

/** Attached states 37-43 by attach.ts state name. */
const ATTACH_STATE: Record<AttachState, number> = {
  "ladder-climb": PLAYER_STATE.ladderClimb,
  "ladder-mount-top": PLAYER_STATE.ladderMountTop,
  "ladder-exit-top": PLAYER_STATE.ladderExitTop,
  "ladder-slide": PLAYER_STATE.ladderSlide,
  fence: PLAYER_STATE.fence,
  "wire-traverse": PLAYER_STATE.wireTraverse,
  "wire-slide": PLAYER_STATE.wireSlide,
};

/** A hit on the player's own body (its bone model's collision set 0). */
export interface PlayerBodyHit {
  distance: number;
  point: Vec3;
  /** Hit zone (FUN_00488080: bone table, torso front/back, head front). */
  zone: number;
  /** The player's damage multiplier for the zone (humanplayer.qvm args 9-25). */
  multiplier: number;
  material: number;
}

/**
 * The player's body pose for drawing the skinned model (000_01_1, skeleton 0)
 * in the third-person views (attached / in use, death) and cut-scenes: the
 * clip playing on bone 0 and its time, the same pose bodyHit uses.
 * Draw it as bodyHit poses it: sampleClip(clip, time) on the skeleton, body
 * rotation = yaw about the up axis, the model origin (feet) at
 * pelvis - (0, rootZ / 4096, 0) so that the animated root lands on `pelvis`.
 */
export interface PlayerBodyPose {
  /** Animation id in common/anims/000.iff (ctx.level.animations.get(0)). */
  clipId: number;
  /** Clip time in animation ticks (4800 per second), within [0, duration]. */
  time: number;
  /** The clip loops (one-shot clips hold their last frame). */
  loop: boolean;
  /** Root translation z of the clip at `time`, IGI units (pelvis height above the feet). */
  rootZ: number;
  /** The human's position = the animated root (pelvis), engine metres. */
  pelvis: Vec3;
  /** Body heading, radians (ctx.player.yaw convention: 0 faces engine -z, counter-clockwise). */
  yaw: number;
  /** Low-profile flag +0x33d. */
  crouched: boolean;
  /** The blend tree's bone rotations (FUN_004c9f50, both clips during a fade), or null when attached (one clip). */
  rotations: Float32Array | null;
}

export interface PlayerController {
  update(dt: number): void;
  /** Place the player at the level spawn, standing on the ground below it. */
  reset(): void;
  /**
   * Apply damage in the original's units; kills the player at the capacity.
   * `shotDirection` (engine, any length) adds the bullet knock-back.
   */
  /** `zone`: the hit zone (+0x2e8) that picks the death clip; fall, explosion and melee use 13. */
  damage(amount: number, shotDirection?: Vec3, zone?: number): void;
  /** Add knock-back (engine metres per tick), e.g. an explosion's (FUN_00412930); it decays x0.9 per tick. */
  addKnock(v: Vec3): void;
  /**
   * Ray (engine, unit `dir`) against the player's posed body collision: the
   * hit, null for a miss, undefined when the body model is not available.
   */
  bodyHit(from: Vec3, dir: Vec3, maxDistance: number): PlayerBodyHit | null | undefined;
  /** Use target, Activate dispatch, timed uses and the attached states (ladders, fences, wires). */
  readonly interactions: InteractionController;
  /** Weapon / ammo pickups and soldier weapon drops. */
  readonly pickups: PickupSystem;
  /** Current movement state (human+0x2fc; movement-graph.ts PLAYER_STATE). */
  readonly movementState: number;
  /** Arms mode the movement wants (human+0xd5c, FUN_00413a00 in the state enters; 0 until the first enter). */
  readonly armsMode: number;
  /** The map computer (state 45) is open. */
  readonly mapComputerOpen: boolean;
  /**
   * Weapon S5 enter (FUN_0040f470): "in use" (+0x7b8 = 1, FUN_00462250)
   * stops the use-target search; movement state 44 entered at once.
   */
  beginLean(): void;
  /**
   * Weapon S5 exit (FUN_0040f4f0, Peek released): release (+0x7b8 = 0, the
   * Activate latch +0x7b9 = 1, FUN_00462260), the lean offsets 0 at once,
   * movement state 0 entered.
   */
  endLean(): void;
  /** Weapon S11 enter (FUN_0040fea0): movement state 45 entered at once. */
  openMapComputer(): void;
  /** The body pose (clip, time, root) for the third-person renderer; null without the animations. */
  bodyPose(): PlayerBodyPose | null;
}

export interface PlayerControllerOptions {
  interactions?: InteractionOptions;
}


/** Head-front zone radius around skeleton bone 4: 614.4 units (0x532220). */
const HEAD_FRONT_RADIUS_M = 614.4 * U;

export function createPlayerController(ctx: GameContext, options: PlayerControllerOptions = {}): PlayerController {
  let spawnY = 0;
  let body: BodyAnimator | null = null;
  let bodySource: ArrayBuffer | null = null;
  const mv: HumanMoveState = createHumanMoveState([0, 0, 0]);
  /** Root motion of the previous tick, world metres (human+0x520 when the state machine runs). */
  let lastRoot: Vec3 = [0, 0, 0];
  /** Pelvis height above the feet, metres (root translation z). */
  let rootHeight = 0.95;
  /** Input channels of the previous tick (human+0x110 + 4i). */
  let lastCh: PlayerChannels = NO_CHANNELS;
  /** Graph state (human+0x2fc) and previous state (+0x2f8). */
  let state: number = PLAYER_STATE.stand;
  let prevState = -1;
  /** FUN_004e2d10 installs entry 0 as the first tick: the first run only enters state 0. */
  let firstRun = true;
  /** Low-profile flag human+0x33d (written by the state enters). */
  let crouched = false;
  /** Walking flag human+0xd45 (constructor 0 = run; ToggleWalkRun flips it). */
  let walking = false;
  /** Arms mode wanted by the movement, human+0xd5c (constructor 0). */
  let armsMode = 0;
  /** "In use" human+0x7b8 set by the lean (weapon S5); the use objects keep their own (interactions.busy). */
  let leanInUse = false;
  /** The HumanView's lean values (IGI units). */
  let lean = createLeanState();
  /** Bone 0 finished flag of the last animation advance (condition bit 0x1). */
  let bodyFinished = false;
  let mapOpen = false;
  /** +0x2e8: the zone of the last damage. */
  let lastZone = DEFAULT_HIT_ZONE;
  /** State 47 reached its hold (0x40e7e0, +0x33c = 1). */
  let deadHold = false;
  const interactions = createInteractions(ctx, {
    ...options.interactions,
    clips: options.interactions?.clips ?? ((id) => ensureBody()?.animation.clips.get(id) ?? null),
  });
  const pickups = createPickupSystem(ctx, { modelRadius: (model) => interactions.modelRadius(model) });

  /** Movement parameters per tick from DefineHumanPlayerGeneral (km/h -> units/tick, FUN_00410160). */
  const motion = () => {
    const g = ctx.level?.humanPlayer?.rawGeneral ?? DEFAULT_GENERAL;
    return {
      rootScale: g[0],
      jumpHorizontal: kmhToUnitsPerTickF32(g[1]) * U,
      jumpVertical: kmhToUnitsPerTickF32(g[2]) * U,
      airControl: kmhToUnitsPerTickF32(g[3]) * U,
    };
  };
  /** DAT_0056a368 / 0x56a36c = float32(metres x 4096.0), DAT_0056a370 = lean ticks (FUN_00410160). */
  const leanParams = (): LeanParams => {
    const hp = ctx.level?.humanPlayer;
    return {
      side: Math.fround(Math.fround(hp?.leanSideM ?? DEFAULT_GENERAL[4]) * 4096),
      up: Math.fround(Math.fround(hp?.leanUpM ?? DEFAULT_GENERAL[5]) * 4096),
      ticks: hp?.leanTicks ?? DEFAULT_LEAN_TICKS,
    };
  };
  const maxDamage = () => ctx.level?.humanPlayer?.maxDamage ?? DEFAULT_GENERAL[7];

  /**
   * The bodies that carry a human standing on them: tasks of
   * PLATFORM_TASK_TYPES (Train, Car, Elevator, StationaryGun: the "delta
   * move" method 0x537436), body id = the task's pre-order index, pivot =
   * the task object's origin = its first instance's translation
   * (docs/collision.md section 13).
   */
  let platformLevel: unknown = undefined;
  let platformOptions: HumanMoveOptions = {};
  function platforms(): HumanMoveOptions {
    const level = ctx.level;
    if (platformLevel === level) return platformOptions;
    platformLevel = level;
    const pivots = new Map<number, Vec3>();
    for (const inst of level?.instances ?? []) {
      if (!PLATFORM_TASK_TYPES.has(inst.taskType) || inst.taskIndex === undefined || pivots.has(inst.taskIndex)) continue;
      pivots.set(inst.taskIndex, [inst.matrix[12], inst.matrix[13], inst.matrix[14]]);
    }
    platformOptions = { carries: (b) => pivots.has(b), pivotOf: (b) => pivots.get(b) ?? null };
    return platformOptions;
  }
  const materialName = (index: number | undefined): string | null =>
    index === undefined || index < 0 ? null : (ctx.level?.surfaceMaterials[index]?.name ?? null);
  const airborne = () => state === PLAYER_STATE.jump || state === PLAYER_STATE.fall;

  function ensureBody(): BodyAnimator | null {
    const buffer = ctx.level?.animations.get(0) ?? null;
    if (buffer && buffer !== bodySource) {
      body = new BodyAnimator(readAnimations(buffer));
      bodySource = buffer;
    }
    return body;
  }

  /** The held input channels this tick (FUN_0045cde0: the bound keys' held state). */
  function readChannels(): PlayerChannels {
    const i = ctx.input;
    const forward = i.forward;
    const strafe = i.strafe;
    return {
      left: i.action("MoveLeft") || strafe < 0,
      right: i.action("MoveRight") || strafe > 0,
      forward: i.action("MoveUp") || forward > 0,
      back: i.action("MoveDown") || forward < 0,
      fire: i.action("Fire"),
      altFire: i.action("AlternateFire"),
      reload: i.action("Reload"),
      activate: i.action("Activate"),
      crouch: i.action("Crouch"),
      jump: i.action("Jump"),
      peek: i.action("Peek"),
      walkToggle: i.action("ToggleWalkRun"),
      nextWeapon: i.action("NextWeapon"),
      mapComputer: i.action("MapComputer"),
    };
  }

  let bodyCollision: BodyCollision | null | undefined;
  /** The posed collision is valid for this many player updates and this heading (sight rays and bullets may query it before or after the player's node in a tick). */
  let bodyPoseKey = "";
  let playerUpdates = 0;
  let bodyBones: Float32Array | null = null;
  let bodyRootZ = 0;

  function bodyHit(from: Vec3, dir: Vec3, maxDistance: number): PlayerBodyHit | null | undefined {
    const level = ctx.level;
    const b = ensureBody();
    if (!level || !b) return undefined;
    if (bodyCollision === undefined) {
      const data = level.player.model ? level.boneModels.get(level.player.model) : undefined;
      bodyCollision = data ? BodyCollision.fromModel(data.buffer) : null;
    }
    if (!bodyCollision) return undefined;
    const p = ctx.player;
    const poseKey = `${playerUpdates}|${p.yaw}|${interactions.attach.attached}`;
    if (bodyPoseKey !== poseKey || !bodyBones) {
      const pose = bodyPose();
      const poseClip = pose ? b.animation.clips.get(pose.clipId) : undefined;
      // Not attached: the body's blend tree as FUN_004c9f50 poses it (both clips during a 0.2 s fade).
      const sample = interactions.attach.attached ? (pose && poseClip ? sampleClip(poseClip, pose.time) : null) : pose ? b.sample() : null;
      const half = p.yaw / 2;
      bodyBones = poseSkeleton(b.animation.skeleton, sample ? sample.rotations : null, [0, 0, Math.sin(half), Math.cos(half)]);
      bodyRootZ = sample ? sample.translation[2] : rootHeight / U;
      bodyCollision.pose(bodyBones, bodyRootZ);
      bodyPoseKey = poseKey;
    }
    const f = p.position;
    const hit = bodyCollision.raycast(from[0] - f[0], from[1] - f[1], from[2] - f[2], dir[0], dir[1], dir[2], 0, maxDistance);
    if (!hit) return null;
    const point: Vec3 = [from[0] + dir[0] * hit.distance, from[1] + dir[1] * hit.distance, from[2] + dir[2] * hit.distance];
    // Direction toward the shooter in the body frame (x right, y forward).
    const sinY = Math.sin(p.yaw), cosY = Math.cos(p.yaw);
    const tx = -(dir[0] * cosY - dir[2] * sinY);
    const ty = -(-dir[0] * sinY - dir[2] * cosY);
    let zone = hitZoneForBone(hit.bone);
    if (zone === HIT_ZONE.TORSO) zone = torsoZone(tx, ty);
    const fromFront = ty >= 0 && Math.abs(tx) < ty;
    if (fromFront && bodyBones) {
      // Bone 4 position (IGI object space) -> engine, relative to the feet.
      const o = 4 * 16;
      const hx = bodyBones[o + 12] * U, hy = (bodyBones[o + 14] + bodyRootZ) * U, hz = -bodyBones[o + 13] * U;
      if (Math.hypot(point[0] - f[0] - hx, point[1] - f[1] - hy, point[2] - f[2] - hz) < HEAD_FRONT_RADIUS_M) zone = HIT_ZONE.HEAD_FRONT;
    }
    const table = level.humanPlayer?.zoneMultipliers;
    return { distance: hit.distance, point, zone, multiplier: table?.[zone] ?? 1, material: hit.material };
  }

  /** The clip on bone 0 and its time: the attached clip track while attached (attach.ts), else the body animator. */
  function bodyPose(): PlayerBodyPose | null {
    const b = ensureBody();
    if (!b) return null;
    const a = interactions.attach.attached ? interactions.attach.clip : null;
    const st = b.state;
    const clip = a ? b.animation.clips.get(a.id) : st?.clip;
    if (!clip) return null;
    const time = a ? Math.max(0, Math.min(a.time, clip.duration)) : st!.time;
    // Not attached: the blended pose and pelvis height (+0x51c, mixed by the same weight).
    const blended = a ? null : b.sample();
    return {
      clipId: clip.id,
      time,
      loop: a ? a.loop : st!.loop,
      rootZ: blended ? blended.translation[2] : sampleTranslation(clip, time)[2],
      rotations: blended ? (blended.rotations as Float32Array) : null,
      pelvis: [mv.position[0], mv.position[1], mv.position[2]],
      yaw: ctx.player.yaw,
      crouched,
    };
  }

  /** Publish the mover state on ctx.player (feet position, m/s velocity). */
  function publish(): void {
    const p = ctx.player;
    p.position = [mv.position[0], mv.position[1] - rootHeight, mv.position[2]];
    p.velocity = [mv.moved[0] * TICKS_PER_SECOND, mv.moved[1] * TICKS_PER_SECOND, mv.moved[2] * TICKS_PER_SECOND];
    p.grounded = mv.grounded;
  }

  /** The stance flags derived from +0x33d and +0xd45. */
  function publishStance(): void {
    const p = ctx.player;
    p.crouching = crouched;
    p.walking = walking;
    p.running = !walking && !crouched;
    mv.crouched = crouched;
  }

  /** The HumanView lean offsets (+0x19c side, +0x1a4 up) in metres. */
  function publishLean(): void {
    ctx.player.leanSide = lean.side * U;
    ctx.player.leanUp = lean.up * U;
  }

  function setCrouched(value: boolean): void {
    crouched = value;
    publishStance();
  }

  // --- state graph: enters ----------------------------------------------------------

  /** FUN_00488290(human, slot, blend): the slot's clip from the table 0x5368c8. */
  function playSlot(slot: number, blend: number): void {
    const s = PLAYER_CLIP_SLOTS[slot];
    if (s) ensureBody()?.start(s.clip, s.flag === 1, blend);
  }

  /** previous = state, state = next, next's enter at once (the graph's switch). */
  function transition(next: number): void {
    prevState = state;
    state = next;
    enter(next);
  }

  function enter(n: number): void {
    switch (n) {
      case PLAYER_STATE.jump:
        return enterJump();
      case PLAYER_STATE.fall:
        return enterFall();
      case PLAYER_STATE.lean:
        // FUN_0040e070: slot 19 when crouched, else its own slot 44 (clip 2); +0x33d unchanged.
        playSlot(crouched ? PLAYER_STATE.crouch : PLAYER_STATE.lean, BLEND_02);
        return;
      case PLAYER_STATE.mapComputer:
        return enterMapComputer();
    }
    const e = STATE_ENTRIES[n];
    if (!e) return;
    if (e.crouched !== null) setCrouched(e.crouched);
    const b = ensureBody();
    const keepPhase = !!b && (e.phaseFrom?.includes(prevState) ?? false);
    const phase = keepPhase ? b!.phase() : 0;
    playSlot(n, e.instantAfterJump && prevState === PLAYER_STATE.jump ? 0 : e.blend);
    if (keepPhase) b!.setTime(phaseTime(phase, b!.duration));
    if (e.armsMode !== null) armsMode = e.armsMode;
  }

  /** FUN_0040bb80 (no platform: the refusal on a moving ground task is not ported). */
  function enterJump(): void {
    const m = motion();
    setCrouched(false);
    playSlot(PLAYER_STATE.jump, 0);
    ensureBody()?.setSpeed(JUMP_CLIP_SPEED);
    ctx.events.emit(GameEvent.Jump, { actor: "player" });
    const h = Math.hypot(lastRoot[0], lastRoot[2]);
    mv.air = h > 0 ? [(lastRoot[0] / h) * m.jumpHorizontal, m.jumpVertical, (lastRoot[2] / h) * m.jumpHorizontal] : [0, m.jumpVertical, 0];
    // 0x40bc87: + the platform displacement of this tick (+0x728), before FUN_00461f10 clears it.
    const pm = mv.platformMove;
    mv.air = [mv.air[0] + pm[0], mv.air[1] + pm[1], mv.air[2] + pm[2]];
    leaveGround(mv);
  }

  /** FUN_0040bec0 (0x40bee0): air velocity = the previous tick's root motion (x, y) + the platform displacement (+0x728). */
  function enterFall(): void {
    setCrouched(false);
    playSlot(PLAYER_STATE.fall, 0);
    const pm = mv.platformMove;
    mv.air = [lastRoot[0] + pm[0], pm[1], lastRoot[2] + pm[2]];
  }

  /**
   * FUN_0040e470: crouched (+0x33d = 1: crouched eye and probes), slot 45
   * (clip 19), arms mode 4, view pitch / yaw input off (camera +0x138,
   * +0x510), the Computer created.
   */
  function enterMapComputer(): void {
    setCrouched(true);
    playSlot(PLAYER_STATE.mapComputer, BLEND_02);
    armsMode = 4;
    if (!mapOpen) {
      mapOpen = true;
      ctx.events.emit(MAP_COMPUTER_EVENT, { open: true });
    }
  }

  /** FUN_0040e4c0's exit: FUN_0046abd0 destroys the Computer, the view locks are cleared. */
  function closeMapComputer(): void {
    if (!mapOpen) return;
    mapOpen = false;
    ctx.events.emit(MAP_COMPUTER_EVENT, { open: false });
  }

  // --- state graph: ticks --------------------------------------------------------

  /** FUN_00408570: gravity and air control (the airborne ticks). */
  function airTick(cur: PlayerChannels): void {
    const m = motion();
    const p = ctx.player;
    const sinY = Math.sin(p.yaw);
    const cosY = Math.cos(p.yaw);
    const forwardIn = (cur.forward ? 1 : 0) - (cur.back ? 1 : 0);
    const strafeIn = (cur.right ? 1 : 0) - (cur.left ? 1 : 0);
    mv.air[1] -= GRAVITY_M_PER_TICK2;
    mv.air[0] += (cosY * strafeIn - sinY * forwardIn) * m.airControl;
    mv.air[2] += (-sinY * strafeIn - cosY * forwardIn) * m.airControl;
  }

  /** One run of the graph (FUN_004e2d60): the condition bits and the current state's tick. */
  function runGraph(cur: PlayerChannels, prev: PlayerChannels): void {
    if (firstRun) {
      firstRun = false;
      enter(state);
      return;
    }
    const bits = conditionBits(
      { grounded: mv.grounded, roof: mv.roof, finished: bodyFinished, blending: body?.blending ?? false, walking, dead: !ctx.player.alive },
      cur,
    );
    switch (state) {
      case PLAYER_STATE.jump:
      case PLAYER_STATE.fall:
        // FUN_0040bce0 / FUN_0040bf50: FUN_00408570, then the landing once the last move ended grounded.
        airTick(cur);
        if (mv.grounded) {
          land();
          transition(state === PLAYER_STATE.jump ? landingState(bits) : PLAYER_STATE.stand);
        }
        return;
      case PLAYER_STATE.lean:
        leanTick(lean, cur, prev, crouched, leanParams());
        publishLean();
        return;
      case PLAYER_STATE.mapComputer:
        // FUN_0040e4c0: MapComputer pressed again (channel 32 edge) or dead.
        if ((cur.mapComputer && !prev.mapComputer) || !ctx.player.alive) {
          closeMapComputer();
          transition(ctx.player.alive ? PLAYER_STATE.stand : PLAYER_STATE.dead);
        }
        return;
      default: {
        const next = groundTransition(state, bits, cur.jump && !prev.jump);
        if (next !== null) transition(next);
      }
    }
  }

  // --- reset, damage -------------------------------------------------------------------

  function reset(): void {
    const p = ctx.player;
    const spawn = ctx.level?.player;
    const feet: Vec3 = spawn ? [...spawn.position] : [...p.position];
    if (spawn) p.yaw = spawn.yaw;
    // The recorded spawn is above the ground; stand it on the surface below.
    const hit = ctx.world ? groundBelow(ctx.world, feet) : null;
    if (hit) feet[1] = hit.point[1];
    spawnY = feet[1];
    p.pitch = 0;
    p.maxHealth = maxDamage();
    p.health = p.maxHealth;
    p.alive = true;
    p.kickPitch = 0;
    p.kickYaw = 0;
    // The HumanPlayer constructor: state 0 pending (entered on the first run), +0x33d / +0xd45 / +0xd5c = 0.
    closeMapComputer();
    state = PLAYER_STATE.stand;
    prevState = -1;
    firstRun = true;
    crouched = false;
    walking = false;
    armsMode = 0;
    leanInUse = false;
    lastZone = DEFAULT_HIT_ZONE;
    deadHold = false;
    // FUN_00462fe0 (the HumanView constructor): lean values and steps 0.
    lean = createLeanState();
    publishLean();
    publishStance();
    bodyFinished = false;
    lastRoot = [0, 0, 0];
    lastCh = NO_CHANNELS;
    detachHuman(mv);
    interactions.reset();
    pickups.reset();
    const b = ensureBody();
    // 0x4104ff: FUN_004882c0(human, clip 2, one shot, blend 0).
    const clip = b && b.start(PLAYER_CLIP_SLOTS[PLAYER_STATE.stand].clip, false, 0) ? b.state?.clip : undefined;
    rootHeight = clip ? sampleTranslation(clip, 0)[2] * U : 0.95;
    Object.assign(mv, createHumanMoveState([feet[0], feet[1] + rootHeight, feet[2]]));
    mv.grounded = Boolean(hit);
    publishStance();
    // One zero move fills the ground record (material, normal) at the spawn.
    if (ctx.world) moveHuman(ctx.world, mv, [0, 0, 0], rootHeight, ctx.playArea ?? undefined, platforms());
    publish();
    p.velocity = [0, 0, 0];
    p.eyeHeight = rootHeight + EYE_ABOVE_PELVIS.standing;
  }

  function damage(amount: number, shotDirection?: Vec3, zone: number = DEFAULT_HIT_ZONE): void {
    const p = ctx.player;
    if (!p.alive) return;
    lastZone = zone;
    // Cheat Unlimited Health (engine/cheats.ts): the hit still pushes, the health stays.
    if (amount > 0 && ctx.cheats?.unlimitedHealth !== true) {
      p.health = Math.max(0, p.health - amount);
      if (p.health <= 0) {
        p.alive = false;
        ctx.events.emit(GameEvent.PlayerDied);
      }
    }
    if (shotDirection) {
      const len = Math.hypot(shotDirection[0], shotDirection[1], shotDirection[2]);
      if (len > 0) {
        // Also while attached: FUN_004600f0 adds the knock-back even without collision (+0x694).
        mv.knock[0] += (shotDirection[0] / len) * BULLET_KNOCK_M_PER_TICK;
        mv.knock[2] += (shotDirection[2] / len) * BULLET_KNOCK_M_PER_TICK;
      }
    }
  }

  function addKnock(v: Vec3): void {
    mv.knock[0] += v[0];
    mv.knock[1] += v[1];
    mv.knock[2] += v[2];
  }

  /** FUN_00408570 landing + FUN_0040bce0: fall damage, sounds, noise; velocities cleared. */
  function land(): void {
    const p = ctx.player;
    const speed = Math.abs(mv.air[1]) * TICKS_PER_SECOND;
    const capacity = p.maxHealth;
    const amount = fallDamage(speed, capacity);
    const ground = mv.ground;
    ctx.events.emit(GameEvent.Land, {
      actor: "player",
      position: ground ? ([...ground.point] as Vec3) : ([...p.position] as Vec3),
      material: materialName(ground?.material),
      damaged: amount > 0,
      damageFraction: capacity > 0 ? amount / capacity : 0,
      // FUN_00408570: the same speed drives the view dip (FUN_00464620, weapon.ts) and the damage.
      speed,
    });
    if (amount > 0) damage(amount);
    mv.air = [0, 0, 0];
    mv.knock = [0, 0, 0];
  }

  /** The view follows the body while in use (+0x510 yaw, camera +0x138 / FUN_00463390 pitch 0). */
  function lockView(): void {
    const p = ctx.player;
    const yaw = interactions.lockedYaw;
    if (yaw !== null) p.yaw = yaw;
    p.pitch = 0;
    p.leanSide = 0;
    p.leanUp = 0;
  }

  /** FUN_00410f10, after the move: the pickups the player touches (alive only). */
  function touchPickups(): void {
    pickups.update(ctx.player.alive ? ([...mv.position] as Vec3) : null);
    if (ctx.player.alive) touchGenericPickups();
  }

  /**
   * The pickup loop's GenericPickups (FUN_00410f70 -> FUN_0046c630, full exe; docs/objects.md):
   * every one, in or out of the world, with the player's pelvis (+0x20), only while alive.
   */
  function touchGenericPickups(): void {
    const rt = (ctx.systems.tasks as unknown as { runtime?: MissionRuntime | null } | null)?.runtime ?? null;
    if (!rt) return;
    const pelvis = engineToIgi(ctx.level, mv.position);
    for (const node of rt.tasks.nodes) {
      if (node.type !== "GenericPickup") continue;
      const position = vec3Param(node.task, "Position");
      if (!position || rt.behaviourState(node.index).isPickedUp) continue;
      const model = stringParam(node.task, "Model");
      touchGenericPickup(rt, node.index, position, pelvis, (model ? interactions.modelRadius(model) : null) ?? 0);
    }
  }

  /** Mount / stance placement: the pelvis at an IGI point, facing `heading`. */
  function placePelvis(igi: Vec3, heading: number, pelvisHeight: number): void {
    const e = igiToEngine(ctx.level, igi);
    rootHeight = pelvisHeight;
    mv.position = [e[0], e[1], e[2]];
    mv.air = [0, 0, 0];
    mv.knock = [0, 0, 0];
    mv.slide = [0, 0, 0];
    mv.grounded = false;
    mv.ground = null;
    ctx.player.yaw = heading;
    setCrouched(false);
    lastRoot = [0, 0, 0];
    publish();
    ctx.player.velocity = [0, 0, 0];
    ctx.player.eyeHeight = rootHeight + EYE_ABOVE_PELVIS.standing;
  }

  /**
   * One attached tick (ladder, fence, wire): the state handler and attach
   * checks (attach.ts), then FUN_004600f0 with +0x694 = 1 (position += root +
   * air + knock-back, no collision) or, sliding down a ladder, the normal move.
   * Returns false when the player detached (state 0 or the fall 29 entered;
   * the tick continues without another graph run).
   */
  function attachedTick(forward: boolean, back: boolean, activatePressed: boolean, b: BodyAnimator | null): boolean {
    const world = ctx.world!;
    const a = interactions.attach;
    const r = a.tick(
      { up: forward, down: back, activatePressed, grounded: mv.grounded, dead: !ctx.player.alive },
      engineToIgi(ctx.level, mv.position),
    );
    if (r.detach) {
      interactions.release();
      const last = a.lastRootMove;
      lastRoot = [last[0] * U, last[2] * U, -last[1] * U];
      mv.air = [0, 0, 0];
      if (r.detach === "dead") {
        state = PLAYER_STATE.dead;
      } else if (r.detach === "fall") {
        // Wires and the fence: the fall state 29, air = the last root change (FUN_0040bec0).
        mv.grounded = false;
        transition(PLAYER_STATE.fall);
      } else {
        transition(PLAYER_STATE.stand);
      }
      return false;
    }
    if (a.state) state = ATTACH_STATE[a.state];
    const clip = a.clip;
    if (b && clip) b.play(clip.id, clip.loop);
    rootHeight = r.rootZ * U;
    const root: Vec3 = [r.root[0] * U, r.root[2] * U, -r.root[1] * U];
    if (r.collide) {
      mv.air = [r.air[0] * U, r.air[2] * U, -r.air[1] * U];
      moveHuman(world, mv, root, rootHeight, ctx.playArea ?? undefined, platforms());
    } else {
      mv.knock = [mv.knock[0] * KNOCK_DECAY, mv.knock[1] * KNOCK_DECAY, mv.knock[2] * KNOCK_DECAY];
      const air: Vec3 = [r.air[0] * U, r.air[2] * U, -r.air[1] * U];
      const move: Vec3 = [root[0] + air[0] + mv.knock[0], root[1] + air[1] + mv.knock[1], root[2] + air[2] + mv.knock[2]];
      mv.position = [mv.position[0] + move[0], mv.position[1] + move[1], mv.position[2] + move[2]];
      mv.moved = move;
      mv.grounded = false;
      mv.ground = null;
    }
    lastRoot = root;
    publish();
    lockView();
    ctx.player.eyeHeight = rootHeight + EYE_ABOVE_PELVIS.standing;
    return true;
  }

  // --- state 33: the StationaryGun (combat) ------------------------------------------------

  /**
   * FUN_0040c970 [recovered, full exe]: the use point P (origin + object x magic 0) and the
   * object matrix M (FUN_00444b30); M turned by pi when the human is in front; x, y = P + col1(M)
   * x 0.7 m, z kept; heading gamma(M) + pi; arms mode 0, the weapon holstered (FUN_0040c140), body
   * clip 198 (FUN_00489ea0, no loop, no blend), the view locked, attached to the gun (FUN_00463310:
   * the platform carry, E100), weapon inactive. The gun takes the player as its user.
   */
  function mountStationaryGun(node: number, b: BodyAnimator | null): boolean {
    const guns = stationaryGunsOf(ctx);
    const world = ctx.world;
    const human = engineToIgi(ctx.level, mv.position);
    const m = guns && world ? guns.mountPlayer(node, human) : null;
    if (!m || !world) {
      interactions.release();
      return false;
    }
    const e = igiToEngine(ctx.level, [m.x, m.y, human[2]]);
    mv.position = [e[0], mv.position[1], e[2]];
    mv.air = [0, 0, 0];
    mv.knock = [0, 0, 0];
    mv.slide = [0, 0, 0];
    ctx.player.yaw = m.heading;
    ctx.player.pitch = 0;
    armsMode = 0;
    prevState = state;
    state = STATIONARY_GUN_STATE;
    b?.start(STATIONARY_GUN.playerClip, false, 0);
    leaveGround(mv);
    attachHuman(world, mv, node);
    lastRoot = [0, 0, 0];
    publish();
    ctx.player.velocity = [0, 0, 0];
    return true;
  }

  /** FUN_00475340 (release) + FUN_00462190 (detach) + FUN_00462260 (the use released, Activate latched). */
  function leaveStationaryGun(): void {
    stationaryGunsOf(ctx)?.releasePlayer();
    detachHuman(mv);
    interactions.release();
  }

  /**
   * 0x40cae0 [recovered]: a fresh Activate press (channel 9 now, not on the previous tick) or death
   * leaves: weapon active, unholstered (FUN_0040c2d0), the gun released, detached, state 0 at once (the
   * player stays where he stood). Otherwise the body plays its clip, attached to the gun (FUN_00461930:
   * the gun's yaw carries it, FUN_0045fd00 turns the heading with it). Returns false when it left.
   */
  function stationaryGunTick(activatePressed: boolean, b: BodyAnimator | null): boolean {
    const world = ctx.world!;
    if (activatePressed || !ctx.player.alive) {
      leaveStationaryGun();
      transition(PLAYER_STATE.stand);
      return false;
    }
    const p = ctx.player;
    const rootDelta: Vec3 = [0, 0, 0];
    if (b) {
      const step = b.step();
      bodyFinished = step.finished;
      rootHeight = step.rootZ * U;
      const k = motion().rootScale * U;
      const sinY = Math.sin(p.yaw);
      const cosY = Math.cos(p.yaw);
      rootDelta[0] = cosY * step.delta[0] * k - sinY * step.delta[1] * k;
      rootDelta[1] = step.delta[2] * k;
      rootDelta[2] = -sinY * step.delta[0] * k - cosY * step.delta[1] * k;
    }
    moveHuman(world, mv, rootDelta, rootHeight, ctx.playArea ?? undefined, platforms());
    lastRoot = rootDelta;
    publish();
    p.pitch = 0;
    p.eyeHeight = rootHeight + EYE_ABOVE_PELVIS.standing;
    return true;
  }

  // --- state 47: dead ---------------------------------------------------------------------

  /**
   * FUN_0040e660 (state 47 enter) [recovered]: +0x33d = 0; the zone record's
   * death clip [rand(2)] (level RNG) one-shot with blend 0.2; arms mode 0; the
   * weapon holstered (+0xd44: weapon S0); view mode 5 with the pitch / yaw
   * input off; player_death_{rand(3)}; air velocity = the last move (+0x688).
   */
  function enterDeath(): void {
    setCrouched(false);
    const pair = PLAYER_DEATH_CLIPS[lastZone] ?? PLAYER_DEATH_CLIPS[DEFAULT_HIT_ZONE];
    const clip = pair[ctx.rng.int(2)];
    ensureBody()?.start(clip, false, 0.2);
    armsMode = 0;
    ctx.events.emit(PLAYER_DEATH_EVENT, { clip });
    mv.air = [mv.moved[0], mv.moved[1], mv.moved[2]];
    deadHold = false;
  }

  /**
   * FUN_0040e720 (state 47 tick): FUN_00408570 (gravity, no input while dead;
   * while grounded the landing dip and the AI GROUNDIMPACT noise, type 11 /
   * flags 0x46 / 20480 units); grounded: air velocity and knock-back
   * cleared; grounded with the clip finished: the hand item is released and
   * the state holds (0x40e7e0). The body still moves by the clip's root
   * motion (x 1.75) through FUN_004600f0.
   */
  function deathTick(): void {
    const world = ctx.world!;
    const p = ctx.player;
    if (state !== PLAYER_STATE.dead) {
      if (interactions.busy === "gun") leaveStationaryGun(); // 0x40cae0: death (graph flag 0x20000) releases the gun
      if (interactions.busy) {
        interactions.attach.reset();
        interactions.release();
      }
      closeMapComputer();
      prevState = state;
      state = PLAYER_STATE.dead;
      enterDeath();
    } else if (!deadHold) {
      mv.air[1] -= GRAVITY_M_PER_TICK2;
      if (mv.grounded) {
        ctx.events.emit(INTERACT_EVENTS.Noise, { type: 11, flags: 0x46, range: 20480, position: [...p.position] as Vec3 });
        mv.air = [0, 0, 0];
        mv.knock = [0, 0, 0];
        if (bodyFinished) {
          // FUN_0040e720: the hand item is released (a gun drops as a GunPickup, as FUN_004534d0 for
          // soldiers), the weapon machine goes to S1, and the state holds (0x40e7e0).
          deadHold = true;
          const weaponId = (ctx.systems.weapon as { releaseHand?(): string | null } | null)?.releaseHand?.() ?? null;
          if (weaponId) ctx.events.emit(PLAYER_RELEASE_EVENT, { weaponId });
        }
      }
    }
    const b = ensureBody();
    const rootDelta: Vec3 = [0, 0, 0];
    if (b) {
      const step = b.step();
      bodyFinished = step.finished;
      rootHeight = step.rootZ * U;
      const k = motion().rootScale * U;
      const dx = step.delta[0] * k;
      const dy = step.delta[1] * k;
      const sinY = Math.sin(p.yaw);
      const cosY = Math.cos(p.yaw);
      rootDelta[0] = cosY * dx - sinY * dy;
      rootDelta[1] = step.delta[2] * k;
      rootDelta[2] = -sinY * dx - cosY * dy;
    }
    moveHuman(world, mv, rootDelta, rootHeight, ctx.playArea ?? undefined, platforms());
    lastRoot = rootDelta;
    publish();
    p.eyeHeight = rootHeight + EYE_ABOVE_PELVIS.standing;
  }

  // --- the tick --------------------------------------------------------------------------

  function update(_dt: number): void {
    const world = ctx.world;
    const p = ctx.player;
    if (!world || !ctx.running) return;
    playerUpdates++;
    if (!p.alive) {
      deathTick();
      return;
    }
    const cur = readChannels();
    const prev = lastCh;
    lastCh = cur;
    tick(cur, prev);
    // FUN_00410a30 after both graphs: ToggleWalkRun's press edge flips the walking flag +0xd45.
    if (cur.walkToggle && !prev.walkToggle) {
      walking = !walking;
      publishStance();
    }
  }

  function tick(cur: PlayerChannels, prev: PlayerChannels): void {
    const world = ctx.world!;
    const p = ctx.player;
    const m = motion();
    const b = ensureBody();
    // Something else placed the player (teleport, test harness): follow it.
    const fx = mv.position[0], fy = mv.position[1] - rootHeight, fz = mv.position[2];
    if (p.position[0] !== fx || p.position[1] !== fy || p.position[2] !== fz) {
      mv.position = [p.position[0], p.position[1] + rootHeight, p.position[2]];
      mv.ground = null;
    }
    // FUN_0045f930, before the use search and the state graph: the motion of the attach or ground task
    // since the last tick; FUN_0045fd00 adds its yaw to the heading even while the yaw input is locked.
    const ride = mv.attach?.body ?? (mv.grounded ? mv.platform?.body : undefined);
    if (ride !== undefined) (ctx.systems.tasks as unknown as { prepareRide?(node: number): void } | null)?.prepareRide?.(ride);
    updatePlatform(world, mv, platforms());
    p.yaw += mv.platformYaw;

    // View kick decays x0.9 per tick (FUN_00461a90 / 0x5315bc).
    p.kickPitch *= 0.9;
    p.kickYaw *= 0.9;

    // --- 0. Use / Activate (player/interact.ts, docs/interactions.md) -----------
    const activatePressed = cur.activate && !prev.activate;
    /** A use or attached state switched this tick: the graph has run for it. */
    let graphDone = false;
    // FUN_0045fb20: the use target, only grounded and not in use (+0x7b8, the lean sets it too).
    interactions.search(mv.grounded && !airborne() && !leanInUse);
    if (interactions.useState !== null) {
      const useState = interactions.useState;
      if (state !== useState) {
        // A use started without a stance placement (lock picking): its enter's clip.
        prevState = state;
        state = useState;
        const clip = interactions.useClip;
        if (clip) b?.start(clip.id, clip.loop, clip.blend);
      }
      // FUN_0040c980 / FUN_0040c260 / LAB_0040c510 / LAB_0040d580: the body stays at its stance while Activate is held.
      const going = interactions.tickTimedUse({
        held: cur.activate, dead: !p.alive, pelvis: engineToIgi(ctx.level, mv.position), clipFinished: bodyFinished,
        play: (clip) => b?.start(clip.id, clip.loop, clip.blend),
      });
      if (going) {
        // The use clip advances (pose only: the stance does not move); its first event is human+0x538
        // (the cabinet's drawer triggers 0 / 1), sound triggers (the cabinet's 1051) play on the body.
        if (b) {
          const step = b.step();
          bodyFinished = step.finished;
          interactions.setTrigger(step.triggers[0] ?? -1);
          for (const t of step.triggers) {
            if (t >= 1000 && t !== FOOTSTEP_TRIGGER) ctx.events.emit(GameEvent.AnimTrigger, { actor: "player", trigger: t, position: [...p.position] as Vec3 });
          }
        }
        lockView();
        mv.moved = [0, 0, 0];
        publish();
        touchPickups();
        return;
      }
      interactions.setTrigger(-1);
      // The use ended in its state tick: state 0.
      transition(PLAYER_STATE.stand);
      graphDone = true;
    }
    if (interactions.attach.attached) {
      if (attachedTick(cur.forward, cur.back, activatePressed, b)) {
        touchPickups();
        return;
      }
      graphDone = true;
    }
    if (interactions.busy === "gun") {
      if (stationaryGunTick(activatePressed, b)) {
        touchPickups();
        return;
      }
      graphDone = true;
    }
    // Activate is read in the weapon machine's idle state S1 (FUN_0040ead0) after fire, alternate
    // fire, reload and weapon selection had their turn; binoculars out (+0xde4) skip it.
    const weaponMachine = ctx.systems.weapon as unknown as { state?: number; binocularMode?: boolean } | null;
    const upperIdle = weaponMachine?.state === undefined || weaponMachine.state === WEAPON_READY_STATE;
    const used = interactions.activate({
      held: cur.activate,
      blocked: !upperIdle || !!weaponMachine?.binocularMode || ctx.input.action("Fire") || ctx.input.action("AlternateFire") || !!ctx.weapon?.reloading,
      pelvis: engineToIgi(ctx.level, mv.position),
    });
    if (used && used.object.kind === "stationaryGun") {
      if (mountStationaryGun(used.object.nodeIndex, b)) {
        touchPickups();
        return;
      }
    }
    if (used && interactions.attach.attached) {
      // FUN_00411380 / FUN_00411710 / FUN_00411a80 / FUN_00411ec0 placed the body.
      const clip = interactions.attach.clip;
      if (b && clip) b.play(clip.id, clip.loop);
      const clipData = clip ? ensureBody()?.animation.clips.get(clip.id) : undefined;
      const z = clipData ? sampleTranslation(clipData, clip!.time)[2] * U : rootHeight;
      prevState = state;
      if (interactions.attach.state) state = ATTACH_STATE[interactions.attach.state];
      placePelvis(interactions.attach.position, interactions.attach.heading, z);
      lockView();
      touchPickups();
      return;
    }
    if (used && interactions.stance) {
      // FUN_0040c780 / FUN_0040c2f0 / FUN_0040cf70 / FUN_0040d180: the stance in front of the object,
      // then FUN_00461ea0 / FUN_00463260 stand it on the ground below.
      prevState = state;
      state = interactions.useState ?? PLAYER_STATE.terminal;
      // The TBA states clear the low-profile flag +0x33d.
      if (state === PLAYER_STATE.tba || state === PLAYER_STATE.placeExplosive) setCrouched(false);
      // FUN_004882c0 / FUN_00489ea0: 89 picklock / 90 typecomp looped, 84 (cabinet) once, the Activate Anim looped; no blend.
      const clip = interactions.useClip;
      if (clip) b?.start(clip.id, clip.loop, clip.blend);
      bodyFinished = false;
      interactions.setTrigger(-1);
      placePelvis(interactions.stance.position, interactions.stance.heading, rootHeight);
      const hit = groundBelow(world, [mv.position[0], mv.position[1] - rootHeight, mv.position[2]]);
      if (hit) mv.position = [mv.position[0], hit.point[1] + rootHeight, mv.position[2]];
      mv.grounded = !!hit;
      publish();
      lockView();
      touchPickups();
      return;
    }

    // --- 1. Movement state graph ----------------------------------------------------
    if (!graphDone) runGraph(cur, prev);

    // --- 2. Body animation and root motion ------------------------------------
    const sinY = Math.sin(p.yaw);
    const cosY = Math.cos(p.yaw);
    // Engine directions of the body's model axes (+y forward, +x right).
    const fwdX = -sinY;
    const fwdZ = -cosY;
    const rightX = cosY;
    const rightZ = -sinY;
    const rootDelta: Vec3 = [0, 0, 0];
    let triggers: number[] = [];
    if (b) {
      const step = b.step();
      bodyFinished = step.finished;
      rootHeight = step.rootZ * U;
      const k = m.rootScale * U;
      const dx = step.delta[0] * k;
      const dy = step.delta[1] * k;
      rootDelta[0] = rightX * dx + fwdX * dy;
      rootDelta[1] = step.delta[2] * k;
      rootDelta[2] = rightZ * dx + fwdZ * dy;
      triggers = step.triggers;
    } else {
      rootHeight = crouched ? 0.43 : 0.95;
    }

    // --- 3. Move ---------------------------------------------------------------
    moveHuman(world, mv, rootDelta, rootHeight, ctx.playArea ?? undefined, platforms());
    lastRoot = rootDelta;
    publish();

    // --- 4. Footsteps and other animation events (after the move) -------------
    for (const trigger of triggers) {
      if (trigger === FOOTSTEP_TRIGGER) {
        ctx.events.emit(GameEvent.Footstep, {
          actor: "player",
          position: [...p.position] as Vec3,
          material: materialName(mv.ground?.material),
          quiet: crouched,
        });
      } else if (trigger >= 1000) {
        ctx.events.emit(GameEvent.AnimTrigger, { actor: "player", trigger, position: [...p.position] as Vec3 });
      }
    }

    // FUN_00464490: the eye above the pelvis by the low-profile flag.
    p.eyeHeight = rootHeight + (crouched ? EYE_ABOVE_PELVIS.crouched : EYE_ABOVE_PELVIS.standing);

    touchPickups();

    if (p.position[1] < spawnY - KILL_DEPTH) {
      p.velocity = [0, 0, 0];
      p.health = 0;
      p.alive = false;
      ctx.events.emit(GameEvent.PlayerDied);
    }
  }

  return {
    update,
    reset,
    damage,
    addKnock,
    bodyHit,
    interactions,
    pickups,
    get movementState() {
      return state;
    },
    get armsMode() {
      return armsMode;
    },
    get mapComputerOpen() {
      return mapOpen;
    },
    beginLean() {
      // FUN_0040f470: FUN_00462250 (+0x7b8 = 1), then state 44's enter.
      leanInUse = true;
      transition(PLAYER_STATE.lean);
    },
    endLean() {
      // FUN_0040f4f0: FUN_00462260 (+0x7b8 = 0, latch +0x7b9 = 1), view +0x19c / +0x1a0 / +0x1a4 = 0, state 0.
      interactions.release();
      leanInUse = false;
      lean.side = 0;
      lean.up = 0;
      publishLean();
      transition(PLAYER_STATE.stand);
    },
    openMapComputer() {
      transition(PLAYER_STATE.mapComputer);
    },
    bodyPose,
  };
}
