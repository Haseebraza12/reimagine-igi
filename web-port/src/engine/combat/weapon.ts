/**
 * The player's weapons and items, as igi.exe's HumanPlayer runs them
 * (docs/weapons-view.md, docs/gameplay.md "Weapons"). One update() is the
 * weapon part of the player tick FUN_00410a30, in its order:
 *
 *   1. selection inputs: WeaponCategory keys (FUN_00410fa0) and the
 *      next / previous cycle (FUN_0040f890) set the requested weapon;
 *   2. the movement state's arms mode (FUN_00413a00: 1 stand, 2 walk,
 *      3 run, 4 crouch, 5 crouch-move);
 *   3. the weapon state machine at human+0xcf8 (table 0x5366d0, FUN_004e2d60);
 *   4. the view object update FUN_00463840: shake / dip, sway, arms clip;
 *   5. the gun task's cooldown (FUN_00476d60);
 *   6. the held item's use FUN_00461a90: gun fire (FUN_00477ea0 ->
 *      FUN_004772c0), knife stab (TASKTYPE_KNIFESTAB), GunMP5SD zoom
 *      (FUN_00472310), GunDRAGUNOV scope (FUN_00471670), binoculars
 *      (FUN_0046f500); the view kick ((kick + offset) x 0.9).
 *
 * Weapon state machine [recovered; state = slot in 0x5366d0]:
 *   S1 ready (FUN_0040ead0): Binoculars key swaps the binoculars in at once
 *     (no animation) and remembers the weapon; while they are out nothing
 *     else is handled. Else, with a weapon: Fire -> S9 knife / S2 fire (clip
 *     > 0) / S12 dry fire (clip 0); (Reload or clip 0) and pool > 0 and clip <
 *     Rounds/Clip -> S3; Peek -> S5; then a requested weapon -> S4.
 *     Arms mode follows the movement (12-tick blend).
 *   S2 fire (FUN_0040f070): Fire released -> reload as in S1; Fire held:
 *     clip 0 and clip anim ended -> S12, else request a shot; a shot last tick
 *     -> FireAnim1 restarted (random start 0..0.175 s, no blend); clip anim
 *     ended and Fire released -> S1.
 *   S3 reload (FUN_0040f280 -> FUN_004780b0): weapon inactive, ReloadAnim
 *     (no blend); when it ends the ammo moves (FUN_00477fe0) -> S1.
 *   S4 switch (FUN_0040f330 / FUN_0040f380 / FUN_0040f400): inactive, sway
 *     to (-35, -20) deg at (3.33, 1.90) deg/tick = 11 ticks, swap, new
 *     StandAnim (12-tick blend), sway back (11 ticks), active -> S1.
 *   S5 peek (FUN_0040f470): arms mode 1, the player's lean starts
 *     (player.beginLean: "in use" +0x7b8, movement state 44 entered at once),
 *     arms lowered like S4; Peek released (FUN_0040f4f0) -> player.endLean
 *     (release, lean offsets 0 at once, movement state 0), sway target 0, S1.
 *   S11 map computer (FUN_0040fea0 / 0x40fef0): entered from S1 on a
 *     MapComputer press (channel 32 edge, after the weapon request and
 *     Activate; FUN_00464650 first): movement state 45 entered at once
 *     (player.openMapComputer), weapon inactive (+0x4d0 = 0); once the
 *     movement state is no longer 45: active, S1.
 *   S9 knife (FUN_0040fbb0): Fire held and < 3 stabs -> stab request; a stab
 *     last tick -> FireAnim1/2/3 by count; clip anim ended -> S1.
 *   S12 dry fire (FUN_0040f1d0): "guns_dry_1" once, waits for the release.
 *   S0 holstered (FUN_0040ea70 / FUN_0040ea90): arms mode 0 while the body is
 *     attached or using (+0xd44: ladder, wire, fence, terminal); S1 when cleared.
 *   S1's Fire test goes by WEAPONTYPE (+0x610): 3 knife -> S9; 4 grenade -> S7
 *     with a round in the clip; 6 medipack -> S10 with AMMO_ID_MEDIPACK left and
 *     damage taken; 7 mine -> S8 with a round; others -> S2 / S12. A grenade,
 *     medipack or mine that cannot be used falls through to reload / peek /
 *     switch.
 *   S7 grenade (FUN_0040f620 enter, FUN_0040f6c0, 0x40f770, FUN_0040fb50):
 *     FireAnim1 (no loop, no blend); its trigger 4 pulls the pin ("grenade_tick_1"
 *     on the view, the cook count +0x4e0 runs from then on); FireAnim1 ended
 *     and Fire released -> FireAnim2; its trigger 3 is the throw (fire request:
 *     the TASKTYPE_GUN fires a TASKTYPE_GRENADE projectile, combat/grenade.ts,
 *     at (pow(50 h, 0.7) + 0.1 h) x Muzzle Velocity along the view, h = cook
 *     ticks clamped to 3..60; FUN_00461a90) and the tick sound stops;
 *     FireAnim2 ended -> StandAnim (no loop), the sway snapped to (-35, -20)
 *     deg and raised (11 ticks); with the pool empty the next weapon of the
 *     cycle is requested (FUN_0040f890) and S4's lower tick swaps it in once
 *     the arms are up, else the clip refills from the pool at once
 *     (FUN_004e8fd0 -> FUN_00477fe0) and S1 follows once the arms are up.
 *   S10 medipack (FUN_0040fc60 enter, 0x40fcc0, 0x40fd10, FUN_0040f5f0):
 *     FireAnim1 (its trigger 1050 plays "syringe"), then FireAnim2 looped;
 *     each trunc(60 / rpm x 30) ticks (8 at 220 rpm) one AMMO_ID_MEDIPACK
 *     round heals "Factor of human max damage to add for each round" x the
 *     maximum (0.01 x 3), damage clamped to [0, max]; Fire released ->
 *     FireAnim3 (that tick still heals); pool empty or no damage -> FireAnim3;
 *     S1 when FireAnim3 ends. The medipack's own clip is never used.
 * Not in level 1 and not implemented: S6 M203, S8 mine, the Activate
 * dispatch (player.ts / interact.ts handle it). S11 is driven by the
 * movement-state work (player.ts openMapComputer, movement state 45).
 *
 * Gun fire [recovered FUN_004772c0]: request held -> shots counted up to
 * "Maximum Rounds/Burst"; no shot while the cooldown runs or with an empty
 * clip; spread draws only when the spread is non-zero; cooldown =
 * FISTP(60 / rpm x 30); every gun starts with a full clip (+0x144 = -2 ->
 * Rounds/Clip, FUN_00476d60). The player starts with no weapon in the hand
 * and the first tick selects the first carried weapon of
 * DefineHumanPlayerWeaponCycle (level 1: the knife).
 * Not modelled: the eye collision of the shake / lean offset.
 */
import * as THREE from "three";
import type { Vec3 } from "../../contracts";
import {
  fireCooldownTicks,
  readAnimations,
  sampleViewKick,
  spreadForShot,
  x87Mul,
  x87StoreF32,
  type AnimationFile,
  type LevelWeapon,
} from "../../loaders";
import { GameEvent } from "../events";
import type { GameContext, WeaponState } from "../context";
import { computeEye } from "../player/camera";
import {
  FIRST_PERSON_CONSTANTS as FPC,
  createFirstPersonState,
  resetFirstPersonFov,
  type FirstPersonState,
} from "../player/first-person";
import { TRI_BULLET } from "../world/collision";
import { traceBullet } from "./bullet";
import type { EnemyHitResult } from "./enemy";
import { knifeStab } from "./melee";
import { DAMAGE_EVENTS, damageSystemOf, type PlayerExplosionPayload } from "./object-damage";
import { drawPellet, pelletDirection, spreadRadians } from "./pellet";
import { addCappedAmmo, type PickupInventory } from "./pickups";
import { fallbackExtras, type WeaponExtras } from "./weapon-tags";
import type { Mat3 } from "../../loaders/coords";
import { grenadeSystemOf, playerThrowVelocity } from "./grenade";

const TICK = 1 / 30;
/** S7: arms trigger 4 of FireAnim1 pulls the pin, trigger 3 of FireAnim2 throws (005.iff clips 24 / 25) [observed]. */
const GRENADE_PIN_TRIGGER = 4;
const GRENADE_THROW_TRIGGER = 3;
/** FUN_0040f6c0: the sound attached to the view while the pin is out (0x536ebc). */
const GRENADE_TICK_SOUND = "grenade_tick_1";
/** S1 / S10 read this pool by name (FUN_00413cb0("AMMO_ID_MEDIPACK"), 0x536e84). */
const MEDIPACK_POOL = "AMMO_ID_MEDIPACK";
/** Arms skeleton (005.iff). */
const ARMS_SKELETON = 5;
/** Binocular range ray: 4096000 units = 1000 m (double 0x531550, FUN_0046ff00). */
const BINOCULAR_RANGE_M = 1000;

/** Weapon state machine states (slots of the table at 0x5366d0); 13 = S4's raise half (FUN_0040f400). */
export const WEAPON_STATE = {
  /** S0: arms off while the body is attached or using (ladder, wire, fence, terminal: human +0xd44). */
  holstered: 0,
  ready: 1,
  fire: 2,
  reload: 3,
  switchLower: 4,
  peek: 5,
  knife: 9,
  /** S11: the map computer is open (movement state 45). */
  mapComputer: 11,
  dryFire: 12,
  switchRaise: 13,
  /** S7 grenade: pin / cook tick (FUN_0040f6c0); 14 = throw tick (0x40f770); 15 = arms up -> S1 (FUN_0040fb50). */
  grenade: 7,
  grenadeThrow: 14,
  grenadeRaise: 15,
  /** S10 medipack: FireAnim1 tick (0x40fcc0); 16 = heal loop (0x40fd10); 17 = FireAnim3 -> S1 (FUN_0040f5f0). */
  medipack: 10,
  medipackHeal: 16,
  medipackEnd: 17,
} as const;
type WeaponStateId = (typeof WEAPON_STATE)[keyof typeof WEAPON_STATE];

/** Also the pickups' inventory (combat/pickups.ts, FUN_0045ec30 / FUN_0047b4c0 / FUN_00476370). */
export interface WeaponSystem extends PickupInventory {
  update(dt: number): void;
  /** The binoculars are in the hand with their view started (the HUD's target squares). */
  readonly binocularZoomed: boolean;
  /** "Weapon Task Type" of the weapon in the hand (weaponconfig.qvm), or null. */
  readonly handTaskType: string | null;
  /** Rounds in an ammo pool (AMMO_ID_*). */
  reserveOf(pool: string): number;
  /**
   * FUN_0040e720 / FUN_004534d0: the dead human releases the item in its hand (FUN_004e9010; a gun
   * becomes a GunPickup), the hand slot is emptied (FUN_004e8cf0) and the machine returns to S1.
   * Returns the released weapon id.
   */
  releaseHand(): string | null;
  /** Where the first-person gun body is (world matrix, last render), for the shell casings. */
  setGunMatrixSource(source: (() => THREE.Matrix4 | null) | null): void;
  /** Reload request (as if Reload were held this tick). */
  reload(): void;
  /**
   * Cheat All Weapons: carry `id` (a full clip when it is new) and fill its pool to the level's
   * ammo limit (DefineHumanPlayerAmmoLimit), or to five clips for a pool the level leaves unlimited.
   */
  giveFull(id: string): void;
  /** Next (+1) or previous (-1) weapon of DefineHumanPlayerWeaponCycle (applied in the next update). */
  cycle(direction?: number): void;
  /** WeaponCategory key 1-9: the next carried weapon of that category (applied in the next update). */
  selectCategory(key: number): void;
  /** (Re)arm the player from the level loadout: hand empty, as FUN_00410460 leaves it. */
  reset(): void;
  /** Kept for callers: igi.exe never reads "Reload Time"; the reload lasts as long as the reload clip. */
  reloadSeconds: (weaponId: string) => number;
  readonly carried: readonly WeaponState[];
  /** weaponconfig.qvm task types and zoom tags (readWeaponExtras); without them guns have no zoom. */
  setWeaponExtras(extras: ReadonlyMap<string, WeaponExtras>): void;
  /** The view object shared with the camera and the arms renderer (also ctx.firstPerson). */
  readonly firstPerson: FirstPersonState;
  /** Current state machine state (WEAPON_STATE). */
  readonly state: number;
  /** The weapon the player asked for and has not got yet, or null. */
  readonly requested: string | null;
  /** The binoculars are out (Binoculars key). */
  readonly binocularMode: boolean;
}

interface Item {
  state: WeaponState;
  spec: LevelWeapon;
  extras: WeaponExtras;
  /** Ammo pool key (AMMO_ID_<calibre>), null without one (knife: calibre -1). */
  pool: string | null;
  /** +0x144: rounds in the clip (-1 for the knife). */
  clip: number;
  /** +0x140: shots of the current trigger hold. */
  shots: number;
  /** +0x13c: ticks until the next shot. */
  cooldown: number;
  /** +0x1ac: reload phase. */
  reloadPhase: number;
  /** +0x1b0: GunMP5SD zoom on / GunDRAGUNOV scoped / Binocular view started. */
  zoomed: boolean;
  /** Binocular +0x1bc (AlternateFire toggle) and +0x1b8 (skip one update after deselect). */
  binoToggle: boolean;
  binoSkip: boolean;
  /** A FireStopped is owed (shots fired since the request started). */
  firing: boolean;
}

interface Inputs {
  fire: boolean;
  alt: boolean;
  reload: boolean;
  peek: boolean;
  zoomIn: boolean;
  zoomOut: boolean;
  /** Channel 32 (MapComputer), read as a press edge in S1. */
  mapComputer: boolean;
}

const NO_INPUT: Inputs = { fire: false, alt: false, reload: false, peek: false, zoomIn: false, zoomOut: false, mapComputer: false };

export function createWeaponSystem(ctx: GameContext): WeaponSystem {
  const eye = new THREE.Vector3();
  const view = new THREE.Quaternion();
  const aim = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();

  let anim: AnimationFile | null = null;
  let animFor: unknown = null;
  const fp = createFirstPersonState((id) => anim?.clips.get(id) ?? null);
  ctx.firstPerson = fp;

  let extrasTable: ReadonlyMap<string, WeaponExtras> | null = null;
  let items: Item[] = [];
  let reserves: Record<string, number> = {};
  let hand: Item | null = null;
  /** d4c: weapon asked for. */
  let requested: string | null = null;
  /** d48: index in the weapon cycle, -1 = none yet. */
  let cycleIndex = -1;
  /** d50 / d54: last category key and the position inside it. */
  let lastCategory = -1;
  let categoryIndex = 0;
  /** de4: weapon to return to when the binoculars are put away (binocular mode while set). */
  let binoReturn: Item | null = null;
  /** 4d0 weapon active, 4d1 fire request, 4d3 fired last use. */
  let active = false;
  let fireRequest = false;
  let fired = false;
  /** d58 / d5c: arms mode playing / wanted by the movement. */
  let armsMode = 0;
  let desiredMode = 0;
  /** 4e8: knife stabs in this S9 visit. */
  let knifeCount = 0;
  /** S7: +0x4d8 pin pulled, +0x4e0 cook ticks, +0x4e4 the "grenade_tick_1" sound. */
  let grenadePin = false;
  let grenadeCook = 0;
  let grenadeTickSound: { kill(): void } | null = null;
  /** S10: +0xd6c ticks to the next medipack round. */
  let healWait = 0;
  let state: WeaponStateId = WEAPON_STATE.ready;
  /** The state machine starts on S1's enter function (FUN_004e2d10 stores the enter function as the first tick). */
  let firstTick = true;
  let prev: Inputs = NO_INPUT;
  let latchedNext = false;
  let latchedPrev = false;
  let latchedCategory = -1;
  let latchedReload = false;
  let zoomSound: { kill(): void; alive?: boolean } | null = null;
  let effectsBound = false;
  let lastScope: string | null = null;

  const rand = () => ctx.rng.float();
  let gunMatrixSource: (() => THREE.Matrix4 | null) | null = null;
  const cycleOrder = () => ctx.level?.humanPlayer?.weaponCycle ?? [];
  const categories = () => ctx.level?.humanPlayer?.weaponCategories ?? [];
  const itemOf = (id: string | null): Item | null => (id === null ? null : items.find((i) => i.spec.scriptId === id) ?? null);
  const reserveOf = (it: Item) => (it.pool !== null ? reserves[it.pool] ?? 0 : 0);
  const isKnife = (it: Item) => it.spec.weaponType === "WEAPONTYPE_KNIFE";
  const isBinocular = (it: Item) => it.extras.taskType === "TASKTYPE_BINOCULAR";
  /** FUN_00408830: selectable when it has ammo, or when "selectable when empty". */
  const selectable = (it: Item) => it.clip + reserveOf(it) !== 0 || it.extras.selectableWhenEmpty;

  function ensureAnimations(): void {
    const level = ctx.level;
    if (!level || animFor === level) return;
    animFor = level;
    const buffer = level.animations.get(ARMS_SKELETON);
    anim = buffer ? readAnimations(buffer) : null;
  }

  function extrasFor(spec: LevelWeapon): WeaponExtras {
    return extrasTable?.get(spec.scriptId) ?? fallbackExtras(spec.scriptId, spec.weaponType);
  }

  function publish(): void {
    for (const it of items) {
      it.state.ammo = Math.max(0, it.clip);
      it.state.reserve = reserveOf(it);
      it.state.reloading = it === hand && state === WEAPON_STATE.reload;
      it.state.cooldownRemaining = it.cooldown * TICK;
      it.state.reloadRemaining = it.state.reloading && fp.arms.current ? remainingSeconds() : 0;
    }
    ctx.weapon = hand?.state ?? null;
  }

  function remainingSeconds(): number {
    const c = fp.arms.current;
    const clip = c ? anim?.clips.get(c.clip) : undefined;
    return c && clip ? Math.max(0, clip.duration - c.time) / 4800 : 0;
  }

  // --- view effects driven by events (bound after the audio / HUD listeners, see reset) ---
  function bindEffects(): void {
    if (effectsBound) return;
    effectsBound = true;
    ctx.events.on(GameEvent.PlayerHit, (payload) => {
      const p = (payload ?? {}) as { explosion?: boolean; effectsDriven?: boolean };
      // Explosions shake the view through DAMAGE_EVENTS.PlayerExplosion (below); game.ts drives the
      // hit effects itself (effectsDriven) to keep the exe's RNG order (speech, shake, tint).
      if (p.explosion || p.effectsDriven) return;
      // FUN_004123e0 / FUN_00412c80: bullet or melee hit.
      fp.effects.hitShake(rand);
    });
    // FUN_00412930 -> FUN_004645e0: the blast's view shake (combat/explosion-rules.ts explosionShake).
    ctx.events.on(DAMAGE_EVENTS.PlayerExplosion, (payload) => {
      const shake = (payload as PlayerExplosionPayload | undefined)?.shake;
      if (shake) fp.effects.shake(shake.amplitudeM * 4096, shake.angle, shake.ticks);
    });
    ctx.events.on(GameEvent.Land, (payload) => {
      const p = (payload ?? {}) as { actor?: unknown; speed?: number };
      if (p.actor === "player" && typeof p.speed === "number") fp.effects.landingDip(p.speed);
    });
  }

  // --- arms modes (FUN_00413780) ---------------------------------------------
  function applyMode(mode: number): void {
    armsMode = mode;
    if (mode === 0 || !hand) return;
    const a = hand.spec.firstPersonAnims;
    let clip = -1;
    let loop = false;
    let blend = 0;
    let start = 0;
    switch (mode) {
      case 1:
      case 4:
      case 5:
      case 9:
      case 10:
        clip = a.stand;
        loop = true;
        blend = FPC.blendSeconds;
        break;
      case 2:
      case 3:
        clip = a.move;
        loop = true;
        blend = FPC.blendSeconds;
        break;
      case 6: {
        clip = a.fire[0] ?? -1;
        // local_8 = 160 x f32(rand x 0.175) x 30 animation ticks (0x4138b3).
        const r = x87StoreF32(x87Mul(rand(), 0.17499999701976776));
        start = x87StoreF32(x87Mul(x87Mul(160, r), 30));
        break;
      }
      case 7:
        clip = a.reload;
        break;
      case 8:
        clip = a.fire[knifeCount] ?? -1;
        break;
      default:
        return;
    }
    if (clip < 0) return;
    fp.arms.play(clip, loop, blend);
    if (start !== 0) fp.arms.setTime(start);
  }

  // --- hand changes ------------------------------------------------------------
  function deselect(it: Item): void {
    stopFiring(it);
    if (it.extras.taskType === "TASKTYPE_BINOCULAR") {
      stopZoomSound();
      it.zoomed = false;
      it.binoSkip = true;
    } else if (it.extras.taskType === "TASKTYPE_GUNMP5SD") {
      it.zoomed = false;
    }
  }

  /** FUN_004e8cf0(inventory, 0, item). */
  function swapHand(next: Item | null): void {
    if (hand === next) return;
    if (hand) deselect(hand);
    hand = next;
    fp.handWeapon = next?.spec.scriptId ?? null;
    ctx.weapon = next?.state ?? null; // WeaponChanged listeners read ctx.weapon
    if (next) ctx.events.emit(GameEvent.WeaponChanged, { weaponId: next.spec.scriptId, name: next.spec.name });
  }

  function stopFiring(it: Item): void {
    if (!it.firing) return;
    it.firing = false;
    ctx.events.emit(GameEvent.FireStopped, { weaponId: it.spec.scriptId, shooter: "player", position: [eye.x, eye.y, eye.z] as Vec3 });
  }

  function stopZoomSound(): void {
    zoomSound?.kill();
    zoomSound = null;
  }

  function startZoomSound(): void {
    const audio = ctx.systems.audio as { attachTo?: (name: string, actor: "player") => { kill(): void } | null } | null;
    zoomSound = audio?.attachTo?.("bin_zoom_1", "player") ?? null;
  }

  // --- selection (FUN_00410fa0, FUN_0040f890) ------------------------------------
  function selection(): void {
    let selectId: string | null = null;
    if (latchedCategory >= 0) {
      const key = latchedCategory;
      if (key !== lastCategory) categoryIndex = 0;
      const list = categories()[key] ?? [];
      for (let n = 0; n < list.length; n++) {
        const id = list[categoryIndex];
        categoryIndex++;
        if (categoryIndex >= list.length) categoryIndex = 0;
        if (itemOf(id)) {
          selectId = id;
          break;
        }
      }
      lastCategory = key;
    }
    const current = hand?.spec.scriptId ?? null;
    const order = cycleOrder();
    let step = cycleIndex === -1 || latchedNext ? 1 : 0;
    if (latchedPrev) step = -1;
    let target: string | null = null;
    if (step !== 0) {
      if (!binoReturn) {
        for (let n = order.length; n > 0; n--) {
          cycleIndex += step;
          if (cycleIndex >= order.length) cycleIndex = 0;
          else if (cycleIndex < 0) cycleIndex = order.length - 1;
          const it = itemOf(order[cycleIndex]);
          if (it && selectable(it)) {
            target = it.spec.scriptId;
            break;
          }
        }
      } else {
        target = binoReturn.spec.scriptId;
        binoReturn = null;
      }
    }
    if (target === null && selectId !== null) {
      const it = itemOf(selectId);
      if (it && selectable(it)) {
        target = selectId;
        order.forEach((id, i) => {
          if (id === selectId) cycleIndex = i;
        });
      }
    }
    if (target !== null && target !== current && itemOf(target)) requested = target;
    latchedNext = latchedPrev = false;
    latchedCategory = -1;
  }

  /** FUN_00413a00 from the movement state (inferred mapping from stance, walk/run and the move keys). */
  function movementMode(): void {
    // +0xd5c, written by every movement state's enter (player/movement-graph.ts STATE_ENTRIES):
    // 0 -> 1, 1-8 -> 3, 9-16 -> 2, 19 and 45 -> 4, 20-27 -> 5; jump / fall keep it.
    const wanted = (ctx.systems.player as { armsMode?: number } | null)?.armsMode;
    if (wanted !== undefined) {
      desiredMode = wanted;
      return;
    }
    const p = ctx.player;
    if (!p.grounded) return;
    const moving = ctx.running && (ctx.input.forward !== 0 || ctx.input.strafe !== 0);
    desiredMode = moving ? (p.crouching ? 5 : p.walking ? 2 : 3) : p.crouching ? 4 : 1;
  }

  // --- state machine ---------------------------------------------------------------
  function enter(next: WeaponStateId): void {
    state = next;
    switch (next) {
      case WEAPON_STATE.reload:
        break;
      case WEAPON_STATE.switchLower:
        applyMode(9);
        fp.sway.setTarget(FPC.swayLowered.alpha, FPC.swayLowered.gamma, FPC.swayRate.alpha, FPC.swayRate.gamma);
        active = false;
        break;
      case WEAPON_STATE.peek:
        // FUN_0040f470: arms mode 1, FUN_00462250 + movement state 44 (the lean), the sway target.
        applyMode(1);
        ctx.systems.player?.beginLean?.();
        fp.sway.setTarget(FPC.swayLowered.alpha, FPC.swayLowered.gamma, FPC.swayRate.alpha, FPC.swayRate.gamma);
        break;
      case WEAPON_STATE.mapComputer:
        // FUN_0040fea0: movement state 45 entered at once, weapon inactive.
        ctx.systems.player?.openMapComputer?.();
        active = false;
        break;
      case WEAPON_STATE.knife:
        knifeCount = 0;
        break;
      case WEAPON_STATE.grenade:
        // FUN_0040f620: FireAnim1 (no loop, no blend); pin flag, cook count and tick sound cleared
        // (+0x4dc = fistp(fuse x 30) is stored but never read).
        playFireClip(0, false);
        grenadePin = false;
        grenadeCook = 0;
        grenadeTickSound = null;
        break;
      case WEAPON_STATE.medipack:
        // FUN_0040fc60: FireAnim1 (no loop, no blend); +0xd6c = 0.
        playFireClip(0, false);
        healWait = 0;
        break;
      case WEAPON_STATE.dryFire:
        applyMode(1);
        ctx.events.emit(GameEvent.DryFire);
        break;
      case WEAPON_STATE.holstered:
        // FUN_0040ea70: FUN_00413780(human, 0) - arms mode 0 (wanted mode 0 too).
        applyMode(0);
        desiredMode = 0;
        break;
      default:
        break;
    }
  }

  /** (Reload held or clip empty) and ammo in the pool and room in the clip (FUN_0040ead0 / FUN_0040f070). */
  /** 0x40ee6d: (Reload held or the clip empty) and (rounds in the pool or igi.exe's UnlimitedAmmo flag) and the clip not full. */
  function wantsReload(it: Item, reloadHeld: boolean): boolean {
    return (reloadHeld || it.clip === 0) && (reserveOf(it) !== 0 || (unlimitedAmmo() && it.pool !== null)) && it.clip < it.spec.roundsPerClip;
  }

  /** Port cheat Unlimited Ammo (ctx.cheats); its reloads follow igi.exe's DAT_0056a384 rules. */
  function unlimitedAmmo(): boolean {
    return ctx.cheats?.unlimitedAmmo === true;
  }

  function stateTick(cur: Inputs, binocularPressed: boolean): void {
    const animEnded = fp.arms.ended;
    // +0xd44: set by the attach / use states and by state 47 (FUN_0040e660 -> FUN_0040c600).
    const holstered = !!ctx.systems.player?.interactions.weaponHolstered || !ctx.player.alive;
    switch (state) {
      case WEAPON_STATE.holstered:
        // FUN_0040ea90: back to S1 once the holster flag is cleared (S1's enter only sets its tick).
        if (!holstered) state = WEAPON_STATE.ready;
        return;
      case WEAPON_STATE.ready: {
        if (armsMode !== desiredMode) applyMode(desiredMode);
        if (holstered) {
          // 0x40eb17: FUN_00464650 (default FOV) and S0.
          resetFirstPersonFov(fp);
          enter(WEAPON_STATE.holstered);
          return;
        }
        if (binocularPressed) {
          const bino = items.find(isBinocular) ?? null;
          if (bino) {
            if (bino === hand) {
              deselect(bino);
              requested = binoReturn?.spec.scriptId ?? null;
              binoReturn = null;
            } else {
              const previous = hand;
              swapHand(bino);
              binoReturn = previous;
            }
          }
        }
        if (binoReturn) return;
        if (hand) {
          if (cur.fire) {
            // FUN_0040ead0: by WEAPONTYPE (+0x610). A grenade, medipack or mine that cannot be used falls through.
            const type = hand.spec.weaponType;
            if (isKnife(hand)) {
              enter(WEAPON_STATE.knife);
              return;
            }
            if (type === "WEAPONTYPE_GRENADE") {
              if (hand.clip !== 0) {
                enter(WEAPON_STATE.grenade);
                return;
              }
            } else if (type === "WEAPONTYPE_MEDIPACK") {
              // AMMO_ID_MEDIPACK left and damage taken (+0x254 != 0).
              if ((reserves[MEDIPACK_POOL] ?? 0) !== 0 && ctx.player.health !== ctx.player.maxHealth) {
                enter(WEAPON_STATE.medipack);
                return;
              }
            } else if (type !== "WEAPONTYPE_PROXIMITYMINE") {
              // (WEAPONTYPE 7, the mine, would enter S8 with a round: not implemented.)
              enter(hand.clip !== 0 ? WEAPON_STATE.fire : WEAPON_STATE.dryFire);
              return;
            }
          }
          if (wantsReload(hand, cur.reload)) {
            resetFirstPersonFov(fp);
            enter(WEAPON_STATE.reload);
            return;
          }
          if (cur.peek) {
            resetFirstPersonFov(fp);
            enter(WEAPON_STATE.peek);
            return;
          }
        }
        if (requested !== null) {
          resetFirstPersonFov(fp);
          enter(WEAPON_STATE.switchLower);
          return;
        }
        // MapComputer pressed (channel 32: +0x230 set, +0x190 clear): FUN_00464650, S11.
        if (cur.mapComputer && !prev.mapComputer) {
          resetFirstPersonFov(fp);
          enter(WEAPON_STATE.mapComputer);
        }
        return;
      }
      case WEAPON_STATE.fire: {
        if (holstered) {
          enter(WEAPON_STATE.holstered); // 0x40f0a2
          return;
        }
        const it = hand;
        if (!it) {
          enter(WEAPON_STATE.ready);
          return;
        }
        if (!cur.fire) {
          if (wantsReload(it, cur.reload)) {
            resetFirstPersonFov(fp);
            enter(WEAPON_STATE.reload);
            return;
          }
        } else {
          if (it.clip === 0 && animEnded) {
            enter(WEAPON_STATE.dryFire);
            return;
          }
          fireRequest = true;
        }
        if (fired) applyMode(6);
        if (animEnded && !cur.fire) enter(WEAPON_STATE.ready);
        return;
      }
      case WEAPON_STATE.reload: {
        active = false;
        const it = hand;
        if (!it) {
          active = true;
          enter(WEAPON_STATE.ready);
          return;
        }
        let done = false;
        if (it.reloadPhase === 0) {
          applyMode(7);
          it.reloadPhase = 1;
          ctx.events.emit(GameEvent.ReloadStart, { weaponId: it.spec.scriptId });
        } else if (animEnded) {
          // FUN_00477fe0: min(clip - loaded, pool) rounds move from the pool; with the
          // UnlimitedAmmo flag (the cheat) the clip is filled and the pool is not touched.
          if (it.pool !== null && unlimitedAmmo()) {
            it.clip = Math.max(it.clip, it.spec.roundsPerClip);
          } else if (it.pool !== null) {
            const take = Math.min(it.spec.roundsPerClip - it.clip, reserves[it.pool] ?? 0);
            if (take > 0) {
              it.clip += take;
              reserves[it.pool] = (reserves[it.pool] ?? 0) - take;
            }
          }
          it.reloadPhase = 0;
          done = true;
          ctx.events.emit(GameEvent.ReloadEnd, { weaponId: it.spec.scriptId });
        }
        if (done) {
          active = true;
          enter(WEAPON_STATE.ready);
        }
        return;
      }
      case WEAPON_STATE.switchLower: {
        if (!fp.sway.reached()) return;
        const next = itemOf(requested);
        if (next) swapHand(next);
        requested = null;
        applyMode(10);
        fp.sway.setTarget(0, 0, FPC.swayRate.alpha, FPC.swayRate.gamma);
        state = WEAPON_STATE.switchRaise;
        return;
      }
      case WEAPON_STATE.switchRaise: {
        if (requested !== null) {
          enter(WEAPON_STATE.switchLower);
          return;
        }
        if (fp.sway.reached()) {
          active = true;
          enter(WEAPON_STATE.ready);
        }
        return;
      }
      case WEAPON_STATE.peek: {
        if (!cur.peek) {
          // FUN_0040f4f0: release, lean offsets 0 and movement state 0 (endLean), sway target 0, S1.
          ctx.systems.player?.endLean?.();
          fp.sway.setTarget(0, 0, FPC.swayRate.alpha, FPC.swayRate.gamma);
          enter(WEAPON_STATE.ready);
        }
        return;
      }
      case WEAPON_STATE.mapComputer: {
        // 0x40fef0: back to S1 (active) once the movement left state 45.
        if (ctx.systems.player?.movementState !== 45) {
          active = true;
          enter(WEAPON_STATE.ready);
        }
        return;
      }
      case WEAPON_STATE.knife: {
        if (cur.fire && knifeCount < 3) fireRequest = true;
        if (fired) {
          applyMode(8);
          knifeCount++;
        }
        if (animEnded) enter(WEAPON_STATE.ready);
        return;
      }
      case WEAPON_STATE.dryFire: {
        if (holstered) {
          enter(WEAPON_STATE.holstered); // 0x40f204
          return;
        }
        if (!cur.fire) enter(WEAPON_STATE.ready);
        return;
      }
      case WEAPON_STATE.grenade: {
        // FUN_0040f6c0: arms trigger 4 pulls the pin ("grenade_tick_1" on the view); the cook count runs while
        // the pin is out; FireAnim1 ended and Fire released -> FireAnim2 and the throw tick.
        if (fp.arms.triggers.includes(GRENADE_PIN_TRIGGER)) {
          grenadePin = true;
          grenadeTickSound = attachSound(GRENADE_TICK_SOUND);
        }
        if (grenadePin) grenadeCook++;
        if (animEnded && !cur.fire) {
          playFireClip(1, false);
          state = WEAPON_STATE.grenadeThrow;
        }
        return;
      }
      case WEAPON_STATE.grenadeThrow: {
        // 0x40f770: count; trigger 3 = the throw (fire request, used this tick) and the tick sound stops.
        grenadeCook++;
        if (fp.arms.triggers.includes(GRENADE_THROW_TRIGGER)) {
          fireRequest = true;
          grenadeTickSound?.kill();
          grenadeTickSound = null;
        }
        if (!animEnded) return;
        // FireAnim2 ended: StandAnim (no loop, no blend), sway snapped down (FUN_00463410) and raised (FUN_004633e0).
        const it = hand;
        if (it && it.spec.firstPersonAnims.stand >= 0) fp.arms.play(it.spec.firstPersonAnims.stand, false, 0);
        fp.sway.snap(FPC.swayLowered.alpha, FPC.swayLowered.gamma);
        fp.sway.setTarget(0, 0, FPC.swayRate.alpha, FPC.swayRate.gamma);
        if (!it || (reserveOf(it) === 0 && !(unlimitedAmmo() && it.clip > 0))) {
          // The last grenade: FUN_0040f890(human, 1) requests the next weapon of the cycle; S4's lower tick
          // (FUN_0040f380) swaps it in once the arms are up.
          latchedNext = true;
          selection();
          state = WEAPON_STATE.switchLower;
        } else {
          // FUN_004e8fd0 -> FUN_00477fe0: the clip refills from the pool at once; S1 once the arms are up.
          // With the UnlimitedAmmo flag (0x40f840) the grenade stays and the pool is not touched.
          const take = unlimitedAmmo() ? 0 : Math.min(it.spec.roundsPerClip - it.clip, reserveOf(it));
          if (take > 0 && it.pool !== null) {
            it.clip += take;
            reserves[it.pool] = (reserves[it.pool] ?? 0) - take;
          }
          state = WEAPON_STATE.grenadeRaise;
        }
        return;
      }
      case WEAPON_STATE.grenadeRaise:
        // FUN_0040fb50: S1 once the sway is back on its target.
        if (fp.sway.reached()) enter(WEAPON_STATE.ready);
        return;
      case WEAPON_STATE.medipack:
        // 0x40fcc0: FireAnim1 ended -> FireAnim2 looped (no blend).
        if (animEnded) {
          playFireClip(1, true);
          state = WEAPON_STATE.medipackHeal;
        }
        return;
      case WEAPON_STATE.medipackHeal: {
        // 0x40fd10: Fire released -> FireAnim3 and FUN_0040f5f0 (this tick still heals).
        if (!cur.fire) {
          playFireClip(2, false);
          state = WEAPON_STATE.medipackEnd;
        }
        if (healWait !== 0) {
          healWait--;
          return;
        }
        const pool = reserves[MEDIPACK_POOL];
        if (pool === undefined) return; // no AMMO_ID_MEDIPACK record (FUN_0047b5a0 = 0)
        const p = ctx.player;
        if (pool !== 0 && p.health !== p.maxHealth) {
          if (!unlimitedAmmo()) reserves[MEDIPACK_POOL] = pool - 1;
          // damage (+0x254) -= max (+0x258) x factor (+0x6e4), stored as float, clamped to [0, max].
          const max = p.maxHealth;
          const factor = hand?.extras.medipackFactor ?? 0;
          const exact = max - p.health - max * factor;
          const damage = exact < 0 ? 0 : max < exact ? max : x87StoreF32(exact);
          p.health = max - damage;
          // +0xd6c = fistp(60 / Rounds/Minute x 30).
          healWait = hand ? fireCooldownTicks(hand.spec.roundsPerMinute) : 0;
          return;
        }
        playFireClip(2, false);
        state = WEAPON_STATE.medipackEnd;
        return;
      }
      case WEAPON_STATE.medipackEnd:
        // FUN_0040f5f0: S1 when the clip ends.
        if (animEnded) enter(WEAPON_STATE.ready);
        return;
    }
  }

  /** FUN_004cc860(arms, 0, FireAnim[k], loop, 0): S7 / S10 play their clips directly (no arms mode). */
  function playFireClip(k: number, loop: boolean): void {
    const clip = hand?.spec.firstPersonAnims.fire[k] ?? -1;
    if (clip >= 0) fp.arms.play(clip, loop, 0);
  }

  /** FUN_004dd750(view, name): a sound that follows the player (killed with FUN_004dd850). */
  function attachSound(name: string): { kill(): void } | null {
    const audio = ctx.systems.audio as { attachTo?: (name: string, actor: "player") => { kill(): void } | null } | null;
    return audio?.attachTo?.(name, "player") ?? null;
  }

  /**
   * FUN_00461a90 -> the gun's TASKTYPE_GRENADE projectile (FUN_00413cd0 -> FUN_004756c0 -> FUN_00475760):
   * at the eye, (pow(50 h, 0.7) + 0.1 h) x Muzzle Velocity along the view's forward axis, cooked 0 (the
   * Human method 0x4feb90). The grenade starts with the view's orientation [inferred: the exe passes the
   * held gun's +0x70].
   */
  function throwGrenade(it: Item): void {
    const o = ctx.level?.originIgi;
    if (!o) return;
    const axis = (x: number, y: number, z: number): [number, number, number] => {
      const v = new THREE.Vector3(x, y, z).applyQuaternion(view);
      return [v.x, -v.z, v.y];
    };
    const r = axis(1, 0, 0);
    const f = axis(0, 0, -1);
    const u = axis(0, 1, 0);
    const matrix: Mat3 = [r[0], f[0], u[0], r[1], f[1], u[1], r[2], f[2], u[2]];
    const forward: [number, number, number] = [x87StoreF32(f[0]), x87StoreF32(f[1]), x87StoreF32(f[2])];
    grenadeSystemOf(ctx).spawn({
      weaponId: it.spec.scriptId,
      model: it.spec.gunModel ?? "",
      position: [eye.x * 4096 + o[0], -eye.z * 4096 + o[1], eye.y * 4096 + o[2]],
      matrix,
      velocity: playerThrowVelocity(grenadeCook, it.spec.muzzleVelocity, forward),
      cooked: 0,
      tags: it.extras.grenade,
      thrower: "player",
    });
  }

  // --- use (FUN_00461a90) ---------------------------------------------------------
  interface Use {
    fire: boolean;
    fired: boolean;
    active: boolean;
    scoped: boolean;
    kickPitch: number;
    kickYaw: number;
  }

  /** One bullet ray (combat/bullet.ts: FUN_00479e30 with ricochet and penetration). */
  function shoot(from: Vec3, d: Vec3, range: number, it: Item): void {
    const result = traceBullet({
      world: ctx.world,
      from,
      dir: d,
      range,
      penetration: it.spec.penetration,
      materials: ctx.level?.surfaceMaterials ?? [],
      random: rand,
      human(o, hd, max, exclude) {
        let best: EnemyHitResult | null = null;
        for (const h of ctx.systems.enemies?.hitTest(o, hd, max) ?? []) {
          if (!exclude.has(h.enemy) && (!best || h.distance < best.distance)) best = h;
        }
        if (!best) return null;
        const hit = best;
        return {
          distance: hit.distance,
          point: hit.point,
          key: hit.enemy,
          material: hit.material,
          apply() {
            const damage = it.spec.damageFactor * hit.zoneMultiplier;
            ctx.events.emit(GameEvent.Hit, { damage, point: hit.point, head: hit.head });
            // Blood (FUN_0045e5b0 -> FUN_00462710) runs before the damage.
            ctx.systems.effects?.humanHit({ key: hit.enemy, point: hit.point, direction: d });
            ctx.systems.enemies?.damage(hit.enemy, damage, from);
          },
        };
      },
      // Glass, barrels, terminals, camera lenses (combat/object-damage.ts): the weapon's Damage Factor.
      object: (h) => void damageSystemOf(ctx)?.bulletHit(h, it.spec.damageFactor),
      onImpact: (i) =>
        ctx.events.emit(GameEvent.Impact, {
          point: i.point,
          normal: i.normal,
          material: i.material,
          shooter: "player",
          ricochet: i.ricochet,
          human: i.human,
        }),
    });
    // Tracers, bullet holes, fragments, dust: the FUN_00479e30 tail (fx/effects.ts bullet()).
    ctx.systems.effects?.bullet({
      shooter: "player",
      weaponId: it.spec.scriptId,
      calibreId: it.spec.calibreId,
      rangeMetres: range,
      hits: result.hits,
      segments: result.segments,
      ricocheted: result.ricocheted,
    });
  }

  /** FUN_00477ea0 -> FUN_004772c0: the gun's fire, then the view kick. */
  function gunUse(it: Item, u: Use): void {
    let req = u.fire;
    if (!req) it.shots = 0;
    else if (it.shots === it.spec.maxRoundsPerBurst) req = false;
    let fire = req;
    if (it.cooldown !== 0) fire = false;
    if (it.pool !== null && it.clip === 0) {
      fire = false;
      req = false;
    }
    if (!req) stopFiring(it);
    u.fired = fire;
    if (!fire) return;

    const position: Vec3 = [eye.x, eye.y, eye.z];
    it.firing = true;
    // The sound pick (burst <= 1: the RNG low bit) comes first (0x47749a), then the pellets.
    ctx.events.emit(GameEvent.Fire, { weaponId: it.spec.scriptId, shooter: "player", position });
    aim.set(0, 0, -1).applyQuaternion(view);
    right.crossVectors(aim, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    up.crossVectors(right, aim).normalize();
    const spread = spreadRadians(spreadForShot(it.spec.minSpread, it.spec.maxSpread, it.shots));
    const pellets = Math.max(1, it.spec.bulletsPerRound);
    const knife = it.extras.projectileType === "TASKTYPE_KNIFESTAB";
    const aimV: Vec3 = [aim.x, aim.y, aim.z];
    for (let k = 0; k < pellets; k++) {
      dir.copy(aim);
      if (spread !== 0) {
        // FUN_004772c0: four draws per pellet, D = frame(aim) Ry(b) Rx(a) (combat/pellet.ts).
        const { angle, azimuth } = drawPellet(spread, rand);
        dir.fromArray(pelletDirection(aimV, angle, azimuth));
      }
      if (knife) {
        knifeStab(ctx, position, [dir.x, dir.y, dir.z], [right.x, right.y, right.z], it.spec);
      } else if (it.extras.projectileType === "TASKTYPE_GRENADE") {
        throwGrenade(it);
      } else if (it.extras.projectileType !== null) {
        shoot(position, [dir.x, dir.y, dir.z], Math.max(1, it.spec.rangeMetres), it);
      }
    }
    // 0x477b80: the player's gun ejects its casing after the pellets (RNG draws before the kick).
    const gunMatrix = gunMatrixSource?.();
    if (gunMatrix && it.spec.gunModel) ctx.systems.effects?.ejectCasing(it.spec.scriptId, it.spec.gunModel, gunMatrix);
    // Cheat Unlimited Ammo (engine/cheats.ts): the round is not used.
    if (it.pool !== null && it.clip > 0 && !unlimitedAmmo()) it.clip--;
    it.shots++;
    it.cooldown = fireCooldownTicks(it.spec.roundsPerMinute);
    // FUN_00477ea0: the AI hears the shot through the Fire event (combat/enemy.ts); then the kick.
    const kick = sampleViewKick(
      { kickFixedXDeg: it.spec.recoilPitch, kickRandomXDeg: it.spec.recoilPitchRandom, kickFixedZDeg: it.spec.recoilYaw, kickRandomZDeg: it.spec.recoilYawRandom },
      rand,
    );
    u.kickPitch = kick.pitchRad;
    u.kickYaw = kick.yawRad;
  }

  /** GunMP5SD FUN_00472310: AlternateFire toggles; FOV x0.8 per tick down to the tag, x1.25 back to 90 deg. */
  function mp5Zoom(it: Item, u: Use, cur: Inputs): void {
    if (!u.active) {
      fp.tanX = FPC.tanWorld;
      fp.gunTanX = FPC.tanGun;
      it.zoomed = false;
      return;
    }
    const altPressed = cur.alt && !prev.alt;
    let t = fp.tanX;
    let g = fp.gunTanX;
    if (!it.zoomed) {
      if (altPressed) it.zoomed = true;
      const w = FPC.tanWorld;
      if (t < w) {
        t = t * FPC.mp5ZoomOut; // f32 x f32 is exact in the 53-bit register
        g = x87StoreF32(g * FPC.mp5ZoomOut);
      }
      if (t > w) {
        t = w;
        g = FPC.tanGun;
      }
    } else {
      if (altPressed) it.zoomed = false;
      const min = it.extras.zoomMinTan ?? FPC.tanWorld;
      if (t > min) {
        g = x87StoreF32(g * FPC.mp5ZoomIn);
        t = t * FPC.mp5ZoomIn;
      }
    }
    fp.tanX = x87StoreF32(t);
    fp.gunTanX = g;
  }

  /** GunDRAGUNOV FUN_00471670: AlternateFire scopes (arms hidden); held AltFire / ZoomIn x0.96, ZoomOut x1.04; kick x0.05 scoped. */
  function dragunovZoom(it: Item, u: Use, cur: Inputs): void {
    it.zoomed = u.scoped;
    if (!u.active) return;
    const altPressed = cur.alt && !prev.alt;
    if (!u.scoped) {
      if (altPressed) fp.scoped = true;
      return;
    }
    u.kickPitch *= FPC.scopeKickScale;
    u.kickYaw *= FPC.scopeKickScale;
    if (altPressed) resetFirstPersonFov(fp);
    if (!cur.zoomIn && !prev.alt) {
      if (cur.zoomOut) {
        const w = FPC.tanWorldExtended;
        if (fp.tanX < w) {
          fp.tanX = x87StoreF32(fp.tanX * FPC.zoomOutBinocular);
          fp.gunTanX = x87StoreF32(fp.gunTanX * FPC.zoomOutBinocular);
        }
        if (w < fp.tanX) {
          fp.tanX = FPC.tanWorld;
          fp.gunTanX = FPC.tanGun;
        }
      }
    } else if ((it.extras.zoomMinTan ?? 0) < fp.tanX) {
      fp.tanX = x87StoreF32(fp.tanX * FPC.zoomIn);
      fp.gunTanX = x87StoreF32(fp.gunTanX * FPC.zoomIn);
    }
  }

  /** Binocular FUN_0046f500. */
  function binocularUse(it: Item, u: Use, cur: Inputs): void {
    const b = it.extras.binocular;
    if (u.active && !it.binoSkip && b) {
      if (!it.zoomed) {
        fp.scoped = true; // FUN_00464640
        fp.tanX = b.tanDefault;
        it.zoomed = true;
        it.binoToggle = false;
      } else {
        if (!cur.alt && prev.alt) it.binoToggle = !it.binoToggle;
        if (cur.alt && !prev.alt && it.binoToggle) {
          fp.tanX = b.tanDefault;
          stopZoomSound();
          it.binoSkip = false;
          return;
        }
        let previousKey: boolean;
        let next: number;
        if (!cur.zoomIn && (!cur.alt || it.binoToggle)) {
          if (!cur.zoomOut || b.tanMax <= fp.tanX) {
            stopZoomSound();
            it.binoSkip = false;
            return;
          }
          previousKey = prev.zoomOut;
          next = x87StoreF32(fp.tanX * FPC.zoomOutBinocular);
        } else {
          previousKey = prev.zoomIn;
          if (fp.tanX <= b.tanMin) {
            stopZoomSound();
            it.binoSkip = false;
            return;
          }
          next = x87StoreF32(fp.tanX * FPC.zoomIn);
        }
        fp.tanX = next;
        if (!previousKey) {
          stopZoomSound();
          startZoomSound();
        }
      }
    }
    it.binoSkip = false;
  }

  function use(cur: Inputs): void {
    const it = hand;
    if (!it) return;
    const u: Use = { fire: fireRequest, fired: false, active, scoped: fp.scoped, kickPitch: 0, kickYaw: 0 };
    switch (it.extras.taskType) {
      case "TASKTYPE_BINOCULAR":
        binocularUse(it, u, cur);
        break;
      case "TASKTYPE_GUNMP5SD":
        gunUse(it, u);
        mp5Zoom(it, u, cur);
        break;
      case "TASKTYPE_GUNDRAGUNOV":
        gunUse(it, u);
        dragunovZoom(it, u, cur);
        break;
      default:
        gunUse(it, u);
        break;
    }
    fireRequest = false;
    fired = u.fired;
    // arms+0x128 / +0x134 = (kick + offset) x 0.9: the player controller applies the x0.9 to the
    // old offset each tick, so the new kick enters scaled by 0.9 here.
    ctx.player.kickPitch += u.kickPitch * FPC.kickDecay;
    ctx.player.kickYaw += u.kickYaw * FPC.kickDecay;
  }

  /** The HUD overlay of the zoomed binoculars / Dragunov (FUN_0046f780, FUN_00471860). */
  function updateScope(): void {
    const hud = ctx.systems.hud as { setScope?: (s: unknown) => void } | null;
    if (!hud?.setScope) return;
    if (hand && isBinocular(hand) && hand.zoomed) {
      aim.set(0, 0, -1).applyQuaternion(view);
      const hit = ctx.world?.raycast(eye.x, eye.y, eye.z, aim.x, aim.y, aim.z, BINOCULAR_RANGE_M, TRI_BULLET);
      hud.setScope({ kind: "binoculars", yaw: ctx.player.yaw + ctx.player.kickYaw, rangeMetres: hit ? hit.distance : null });
      lastScope = "binoculars";
    } else if (hand && hand.extras.taskType === "TASKTYPE_GUNDRAGUNOV" && hand.zoomed) {
      if (lastScope !== "sniper") hud.setScope({ kind: "sniper" });
      lastScope = "sniper";
    } else if (lastScope !== null) {
      hud.setScope(null);
      lastScope = null;
    }
  }

  function readInputs(): Inputs {
    if (!ctx.running || !ctx.player.alive) return NO_INPUT;
    const i = ctx.input;
    return {
      fire: i.isFiring,
      alt: i.action("AlternateFire"),
      reload: i.action("Reload") || latchedReload,
      peek: i.action("Peek"),
      zoomIn: i.action("ZoomIn"),
      zoomOut: i.action("ZoomOut"),
      mapComputer: i.action("MapComputer"),
    };
  }

  function newItem(spec: LevelWeapon, clip: number): Item {
    return {
      state: { spec, ammo: 0, reserve: 0, reloading: false, reloadRemaining: 0, cooldownRemaining: 0, heldSeconds: 0 },
      spec,
      extras: extrasFor(spec),
      // The DefineAmmoType whose calibre is the weapon's "Calibre ID" (AMMO_ID_GRENADE = 10000, AMMO_ID_MEDIPACK = 10005).
      pool: spec.calibreId > 0 ? ([...(ctx.level?.ammoTypes.values() ?? [])].find((a) => a.calibre === spec.calibreId)?.id ?? `AMMO_ID_${spec.calibreId}`) : null,
      clip,
      shots: 0,
      cooldown: 0,
      reloadPhase: 0,
      zoomed: false,
      binoToggle: false,
      binoSkip: false,
      firing: false,
    };
  }

  /** FUN_0047b4c0: pool + n, clamped to the DefineHumanPlayerAmmoLimit cap. */
  function addToPool(pool: string, rounds: number): void {
    reserves[pool] = addCappedAmmo(reserves[pool] ?? 0, rounds, ctx.level?.humanPlayer?.ammoLimits[pool]);
  }

  function reset(): void {
    bindEffects();
    ensureAnimations();
    const level = ctx.level;
    stopZoomSound();
    reserves = { ...(level?.player.ammo ?? {}) };
    items = [];
    for (const id of level?.player.weapons ?? []) {
      const spec = level?.weapons.get(id);
      if (spec) items.push(newItem(spec, spec.roundsPerClip));
    }
    hand = null;
    requested = null;
    cycleIndex = -1;
    lastCategory = -1;
    categoryIndex = 0;
    binoReturn = null;
    active = false;
    fireRequest = fired = false;
    armsMode = desiredMode = 0;
    knifeCount = 0;
    grenadeTickSound?.kill();
    grenadeTickSound = null;
    grenadePin = false;
    grenadeCook = 0;
    healWait = 0;
    state = WEAPON_STATE.ready;
    firstTick = true;
    prev = NO_INPUT;
    latchedNext = latchedPrev = latchedReload = false;
    latchedCategory = -1;
    const fresh = createFirstPersonState((id) => anim?.clips.get(id) ?? null);
    fp.arms = fresh.arms;
    fp.sway = fresh.sway;
    fp.effects.reset();
    resetFirstPersonFov(fp);
    fp.handWeapon = null;
    if (lastScope !== null) (ctx.systems.hud as { setScope?: (s: unknown) => void } | null)?.setScope?.(null);
    lastScope = null;
    publish();
  }

  const system: WeaponSystem = {
    get carried() {
      return items.map((i) => i.state);
    },
    get firstPerson() {
      return fp;
    },
    get state() {
      return state;
    },
    get requested() {
      return requested;
    },
    get binocularMode() {
      return binoReturn !== null;
    },
    get binocularZoomed() {
      return !!hand && isBinocular(hand) && hand.zoomed;
    },
    get handTaskType() {
      return hand?.extras.taskType ?? null;
    },
    reserveOf: (pool: string) => reserves[pool] ?? 0,
    reloadSeconds: (id: string) => {
      const clip = anim?.clips.get(ctx.level?.weapons.get(id)?.firstPersonAnims.reload ?? -1);
      return clip ? clip.seconds : 0;
    },
    setWeaponExtras(extras) {
      extrasTable = extras;
      for (const it of items) it.extras = extrasFor(it.spec);
      // The soldiers' grenades read the same weaponconfig tags (FUN_00413b70 -> +0x6e0; combat/grenade.ts).
      grenadeSystemOf(ctx).setWeaponTags(new Map([...extras].map(([id, x]) => [id, x.grenade])));
    },
    reset,
    setGunMatrixSource(source) {
      gunMatrixSource = source;
    },
    releaseHand() {
      const it = hand;
      if (!it) return null;
      stopFiring(it);
      // The item leaves the inventory (it is a pickup now).
      items = items.filter((x) => x !== it);
      hand = null;
      fp.handWeapon = null;
      ctx.weapon = null;
      state = WEAPON_STATE.ready;
      publish();
      return it.spec.scriptId;
    },
    hasWeapon: (id: string) => itemOf(id) !== null,
    addWeaponAmmo(id: string, rounds: number) {
      const it = itemOf(id);
      if (it?.pool) addToPool(it.pool, rounds);
      publish();
    },
    addAmmo(ammoId: string, rounds: number) {
      addToPool(ammoId, rounds);
      publish();
    },
    addWeapon(id: string, rounds: number) {
      // FUN_00476370(human, 0, id, rounds, 1): a new inventory weapon with `rounds` in its clip (not selected).
      const spec = ctx.level?.weapons.get(id);
      if (!spec || itemOf(id)) return;
      items.push(newItem(spec, rounds));
      publish();
    },
    reload() {
      latchedReload = true;
    },
    giveFull(id: string) {
      const spec = ctx.level?.weapons.get(id);
      if (!spec) return;
      if (!itemOf(id)) items.push(newItem(spec, Math.max(0, spec.roundsPerClip)));
      const it = itemOf(id);
      if (it?.pool) {
        const limit = ctx.level?.humanPlayer?.ammoLimits[it.pool];
        const target = limit !== undefined && limit !== -1 ? limit : 5 * Math.max(1, spec.roundsPerClip);
        const have = reserves[it.pool] ?? 0;
        if (have < target) addToPool(it.pool, target - have);
      }
      publish();
    },
    cycle(direction = 1) {
      if (direction >= 0) latchedNext = true;
      else latchedPrev = true;
    },
    selectCategory(key: number) {
      if (key >= 1 && key <= 9) latchedCategory = key - 1;
    },
    update(_dt: number): void {
      if (!ctx.level) return;
      ensureAnimations();
      const cur = readInputs();
      const binocularPressed = ctx.running && ctx.player.alive && ctx.input.actionPressed("Binoculars");
      // 1-2: selection inputs and the movement's arms mode.
      selection();
      movementMode();
      // 3: weapon state machine (the first tick runs S1's enter function only).
      if (firstTick) firstTick = false;
      else stateTick(cur, binocularPressed);
      // 4: view object update (FUN_00463840): shake / dip draws, sway, arms clip.
      fp.effects.step(rand);
      fp.sway.step();
      fp.arms.step();
      computeEye(ctx, eye, view);
      // 5: gun cooldowns (FUN_00476d60).
      for (const it of items) if (it.cooldown !== 0) it.cooldown--;
      // 6: the held item's use.
      use(cur);
      updateScope();
      publish();
      prev = cur;
      latchedReload = false;
    },
  };
  return system;
}
