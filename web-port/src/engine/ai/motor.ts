/**
 * Soldier body driven by the AI's virtual controller (docs/ai.md 4.1, 4.3;
 * docs/characters.md "Soldier state graph"): the HumanSoldier side of the 40
 * input channels. Headless: it plays clips on a BodyAnimator (SoldierBody in
 * the browser, a ClipPlayer in tests) and returns the root-motion delta; the
 * engine adapter moves and collides the body.
 *
 * Recovered (FUN_0045bcc0 -> FUN_0045bd00, one call per soldier tick, with
 * the channels the AI wrote on its previous frame):
 *   1. The HumanSoldier state graph (soldier-graph.ts): pre-update
 *      FUN_0045b6a0 builds the condition bits from the channels, the
 *      animation's finished flag, the walking flag, the grounded / roof bits
 *      of the last move and the flinch / dead bits of the damage handlers;
 *      the state's tick function may switch state, whose entry plays its
 *      clip at once (blend 0).
 *   2. A non-zero channel 20 toggles the walking flag (+0xd00, initially 1);
 *      the flinch bit is cleared.
 *   3. FUN_0045fd00 turns: x = (channel0 + previous channel0) / 2 while the
 *      view factor is tan(45 deg) (always for soldiers), else channel0;
 *      T = x * pi * factor; for |x| < 0.06, T /= (2 - 16.667 |x|); heading
 *      -= T. The body matrix uses heading + the gun's yaw kick (+0x508).
 *      FUN_00463470 turns the view pitch by the same formula (clamped to
 *      +-pi/2); the upper-body pitch is that plus the pitch kick (+0x120).
 *   4. The root delta (FUN_004c9650) is the translation sampled BEFORE the
 *      advance minus the stored sample; then FUN_00460010 advances the clip
 *      (events, finished flag) and keeps the advance's first event
 *      (+0x538 trigger, +0x53c clip), read by the next tick's states 8 / 9
 *      (grenade release on event 11, close-combat blow on event 12).
 *   5. FUN_00461a90: the gun fires when the state set the trigger (+0x4d1:
 *      only states 6, 18, 22, 27 do); each shot's view kick (FUN_00477ea0,
 *      two level-RNG draws per unit-disk try) is added to the kick offsets,
 *      which decay x0.9 every tick.
 *   - Damage (FUN_0045bfe0 bullets, FUN_004592a0 explosions, FUN_0045c1a0
 *     melee): the zone-multiplied damage is added to +0xd08; lethal damage
 *     sets the dead bit and the death type (0 explosion, 1 shotgun, 2 other)
 *     with its direction; otherwise damage since the last flinch above the
 *     "Recoil threshold" (+0xd04, default 0.33) sets the flinch bit and
 *     restarts the sum.
 *   - Deaths (FUN_0045aea0 / 0045b000 / 0045b0b0): standing: HumanAI
 *     SetDeathAnimation if set, else r = rand % 2 (level RNG) and type 0/1:
 *     clip 71 (the blast from behind: heading = the blast direction) or 28
 *     (facing it; heading + pi; also for a zero direction); type 2: head
 *     zones 15 / 16 the zone table's clip (30 / 22), else {23, 22}[r].
 *     Kneeling 24, prone 25. The gun is dropped, the upper-body aim switched
 *     off; FUN_0045c3b0's slide (engine side) applies until the clip ends.
 *   - Body-state values read by the AI (table 0x53f4fc): stand 0, kneel 19,
 *     liedown 26, animation 35, stationary gun 36 = graph states.
 *   - Gun: rate of fire FISTP(60 / rpm x 30) ticks; "Maximum Rounds/Burst"
 *     counts shots per trigger hold (docs/gameplay.md).
 *
 * Inferred / not ported:
 *   - The trigger hold is counted per tick of the state's trigger (the gun's
 *     own fire handler FUN_004772c0 is ported in weapon.ts for the player).
 *   - Soldiers have an unlimited reserve; one grenade per grenade item.
 *   - Channel 24 (use: FUN_0045b940, states 36 / 37) and channel 28 (weapon
 *     change) are not handled: the port's soldiers never use tasks or switch
 *     weapons.
 */
import { fireCooldownTicks, sampleViewKick, x87F32Add, x87F32Mul, x87Fistp, x87StoreF32 } from "../../loaders";
import { phaseTime, type AnimTrigger, type BodyAnimator } from "./clip-player";
import {
  BLOWN_DEATH_CLIP,
  COND,
  COND_KEEP,
  DEATH_TYPE,
  DEFAULT_RECOIL_THRESHOLD,
  KNEELING_DEATH_CLIP,
  PHASE_SYNC_FROM,
  PRONE_DEATH_CLIP,
  SOLDIER_STATE as ST,
  SOLDIER_STATES,
  SOLDIER_ZONES,
  STANDING_DEATH_CLIPS,
  headingOfDirection,
  soldierActionTable,
  soldierTick,
  type SoldierActionEntry,
} from "./soldier-graph";
import {
  FEMALE_ACTIONS,
  FEMALE_CROUCH,
  FEMALE_KEEP,
  FEMALE_STATE,
  FEMALE_ZONES,
  RPG_ACTIONS,
  RPG_CROUCH,
  RPG_KEEP,
  RPG_STATE,
  RPG_ZONES,
  VBIT,
  aiBodyState,
  femaleTick,
  rpgTick,
  type SoldierClass,
} from "./soldier-variants";

export type { BodyAnimator } from "./clip-player";

export interface BodyStep {
  /** Root displacement this tick in object space (x right, y forward, z up), IGI units. */
  delta: [number, number, number];
  rootZ: number;
  triggers: number[];
  finished: boolean;
  /** A death state's tick ran and its clip had not finished before: apply FUN_0045c3b0's slide this tick. */
  deathSlide: boolean;
}

export interface GunSpec {
  weaponId: string;
  roundsPerClip: number;
  maxRoundsPerBurst: number;
  roundsPerMinute: number;
  grenade: boolean;
  /** WEAPONTYPE_SHOTGUN (bullet deaths of its victims are death type 1). */
  shotgun?: boolean;
  /** "Fixed / Random view change around X / Z axis (degrees)": per-shot kick (FUN_00477ea0). */
  kick?: { kickFixedXDeg: number; kickRandomXDeg: number; kickFixedZDeg: number; kickRandomZDeg: number };
}

/** Channels (H+0x3c6c + 4i) [recovered]. */
export const CH = {
  TURN: 0, PITCH: 1, LEFT: 2, RIGHT: 3, FORWARD: 4, BACK: 5, FIRE: 6, CH7: 7, RELOAD: 8, CH9: 9,
  WALK_TOGGLE: 20, KNEEL: 21, LIEDOWN: 22, ANIMATION: 23, USE: 24, PANIC: 25, CH26: 26, AIM: 27, CH28: 28,
  GRENADE: 29, CLOSE_COMBAT: 30,
} as const;

/** Body states read back by the AI [recovered table 0x53f4fc]. */
export const BODY = { STAND: 0, KNEEL: 19, LIEDOWN: 26, ANIMATION: 35, STATIONARY_GUN: 36 } as const;

export type Stance = "stand" | "kneel" | "prone";

/** Recovered FUN_0045fd00 per-tick heading change for a channel value (and the previous tick's). */
export function turnFromChannel(channel: number, previous: number, averaged = true): number {
  const x = averaged ? (channel + previous) * 0.5 : channel;
  let t = Math.fround(x * Math.PI);
  const ax = Math.abs(x);
  if (ax < 0.06) t = t / (2 - 16.666666666666668 * ax);
  return t;
}

/** Per-tick decay of the kick offsets (0x5315bc as float32) [recovered FUN_00461a90]. */
const KICK_DECAY = Math.fround(0.9);
const PI_F32 = Math.fround(Math.PI);

/** One damage event on the body [recovered FUN_0045bfe0 / FUN_004592a0 / FUN_0045c1a0]. */
export interface SoldierHit {
  /** Damage after the zone multiplier. */
  amount: number;
  /** Hit zone (+0x2e8): bullets the bone's zone, explosions 13, melee 13 (front) / 14 (back). */
  zone: number;
  /** +0xd1c: 0 explosion, 1 shotgun, 2 other. */
  deathType: number;
  /** +0xd20 (IGI axes): bullet travel direction; explosion: body - centre; melee: body - attacker. */
  direction: readonly number[];
  /** Accumulated damage reached the maximum. */
  lethal: boolean;
}

export interface MotorEvents {
  /** A round left the gun (trigger pulled, gun ready). */
  shot?(): void;
  /** Firing stopped: trigger released after shooting, clip empty, burst cap, reload or death. */
  fireStopped?(): void;
  /** The grenade leaves the hand (state 8, animation event 11). */
  grenadeRelease?(): void;
  /** The close-combat blow is rolled (state 9, animation event 12). */
  closeCombatStrike?(): void;
  /** Animation sound / footstep triggers (ids >= 1000); quiet = crouch flag +0x33d. */
  trigger?(id: number, quiet: boolean): void;
  /** HumanAI target record present (FUN_00451700); default true. */
  hasTarget?(): boolean;
  /** HumanAI SetDeathAnimation (H+0x3acc), -1 = none; read when the standing death starts. */
  deathAnimation?(): number;
  /** A death state started: its clip and the body matrix yaw before any blown-death turn (FUN_0045c3b0 input). */
  died?(info: { state: number; clip: number; matrixYaw: number }): void;
  /** State 29 started (FUN_0045ac20: the air velocity takes the last movement). */
  fell?(): void;
  /**
   * combat: channel 24 pressed outside state 36 (the pre-update, 0x459c2b full exe): +0xd10 =
   * fistp(channel 24) and FUN_00459d50 uses that task; returns its use kind (6 = a StationaryGun:
   * the engine placed and attached the body, FUN_0045c8b0) or 0 when nothing was used.
   */
  use?(taskId: number): number;
  /** combat: state 36 left (0x45c9b0: a fresh channel-24 press or death): release the gun, detach. */
  gunReleased?(): void;
}

export interface MotorOptions {
  /** HumanAI type: picks the action table (FUN_0045bab0). */
  aiType?: string | null;
  /** Level RNG float for the gun's view kick (FUN_00477ea0); default: no random part. */
  randFloat?: () => number;
  /** combat: the task's class (HumanSoldier / HumanSoldierFemale / HumanSoldierRPG: soldier-variants.ts). */
  cls?: SoldierClass;
  /** Root-motion scale (FUN_004550b0: DefineHumanPlayerGeneral arg 0 for an AITYPE_EKK female; default 1). */
  rootScale?: number;
}

export interface MotorEnv {
  /** Bit 0x4 from the last move (FUN_004600f0); default true. */
  grounded?: boolean;
  /** Bit 0x10 "Roof!" from the last ground probe; default false. */
  roof?: boolean;
}

const STANCE_KNEEL = new Set<number>([ST.ROLL_LEFT, ST.ROLL_RIGHT, ST.KNEEL_TO_STAND, ST.KNEEL, ST.KNEEL_ROLL_LEFT, ST.KNEEL_ROLL_RIGHT, ST.KNEEL_FIRE, ST.KNEEL_RELOAD, ST.KNEEL_AIM, ST.KNEEL_TO_PRONE, ST.DEATH_KNEEL]);
const STANCE_PRONE = new Set<number>([ST.PRONE_TO_STAND, ST.PRONE, ST.PRONE_FIRE, ST.PRONE_RELOAD, ST.PRONE_FLINCH, ST.DEATH_PRONE]);

export class SoldierMotor {
  /** Heading +0x50c (IGI gamma = engine yaw), radians. */
  yaw: number;
  /** Accumulated view pitch (arms +0x124), radians, up positive. */
  pitch = 0;
  /** Gun kick offsets (arms +0x128 pitch, +0x134 yaw), decaying x0.9 per tick. */
  kickPitch = 0;
  kickYaw = 0;
  /** Upper-body aim pitch (arms +0x120 = kick + pitch) and body-matrix yaw (+0x508 = heading + yaw kick), as of this tick's turn. */
  aimPitch = 0;
  bodyYaw: number;
  /** Walking flag (soldier +0xd00, constructor 1); 0 = run. */
  walking = true;
  /**
   * combat: attached to a StationaryGun (FUN_00463310): FUN_0045fd00 takes the heading from the
   * object's matrix and the relative orientation (E100), so the turn channel does not turn the body.
   */
  attachedToGun = false;
  /** Graph condition bits (+0x2f4). */
  bits = 0;
  /** Graph state (+0x2fc) and previous state (+0xc). */
  private stateIndex: number = ST.STAND;
  private previousState = -1;
  private entered = false;
  /** Low-profile flag +0x33d (collision heights, eye / aim height, quiet footsteps). */
  crouched = false;
  /** Upper-body aim enabled (+0x64c; FUN_00488740 / FUN_00488750). */
  aimEnabled = true;
  /** The gun left the hand (death). */
  weaponDropped = false;
  /** +0xd0c: scripted clip requested through channel 23. */
  scripted = 0;
  /** Last scripted clip played (diagnostics). */
  scriptedClip = -1;
  /** Hit zone of the last damage (+0x2e8). */
  hitZone = -1;
  /** Death type (+0xd1c) and direction (+0xd20). */
  deathType: number = DEATH_TYPE.EXPLOSION;
  deathDirection: [number, number, number] = [0, 0, 0];
  /** Damage since the last flinch (+0xd08) and the threshold (+0xd04, settings.qvm "Recoil threshold"). */
  recoilAccum = 0;
  recoilThreshold = DEFAULT_RECOIL_THRESHOLD;
  /** SetDeathAnimation given to kill() (when no deathAnimation hook). */
  private deathOverride = -1;
  private deathHold = false;
  private counter = 0;
  private thrown = false;
  private struck = false;
  private eventTrigger = -1;
  private eventClip = -1;
  private triggerThisTick = false;
  rootZ = 0.97 * 4096;
  readonly previous = new Float32Array(40);
  readonly actions: readonly SoldierActionEntry[];
  /** combat: the body graph class and its root-motion scale. */
  readonly cls: SoldierClass;
  private readonly rootScale: number;

  // Gun
  gun: GunSpec | null;
  grenades: number;
  ammo: number;
  private cooldown = 0;
  private burst = 0;
  private firing = false;
  /** Hit probability carried by this soldier's bullets (soldier +0x4d4). */
  hitProbability = 1;
  private readonly randFloat: (() => number) | null;

  constructor(
    private readonly body: BodyAnimator,
    yaw: number,
    readonly standAnimation: number,
    gun: GunSpec | null,
    grenade: GunSpec | null,
    private readonly events: MotorEvents = {},
    private readonly randInt: (n: number) => number = (n) => Math.floor(Math.random() * n),
    options: MotorOptions = {},
  ) {
    this.yaw = yaw;
    this.bodyYaw = yaw;
    this.gun = gun;
    this.ammo = gun ? gun.roundsPerClip : 0;
    this.grenades = grenade ? 1 : 0;
    this.cls = options.cls ?? "soldier";
    this.rootScale = options.rootScale ?? 1;
    this.actions = this.cls === "female" ? FEMALE_ACTIONS : this.cls === "rpg" ? RPG_ACTIONS : soldierActionTable(options.aiType);
    this.randFloat = options.randFloat ?? null;
    // Activation (FUN_0045bb60): the Stand Animation (or clip 2) one-shot; the
    // first graph run then runs state 0's entry. The female's compile (0x454f10) plays clip 6.
    const fallback = this.cls === "female" ? 6 : 2;
    const first = this.standAnimation >= 0 && this.body.hasClip(this.standAnimation) ? this.standAnimation : fallback;
    this.body.playClip(first, false);
    this.rootZ = this.body.rootZ;
  }

  /**
   * Body state as read by the AI (soldier +0x2fc through table 0x53f4fc); the variants' states are
   * reported in the soldier numbering through their tables (FUN_0048efe0, soldier-variants.ts).
   */
  get state(): number {
    if (this.cls === "soldier") return this.stateIndex;
    return aiBodyState(this.cls, this.stateIndex, [BODY.STAND, BODY.KNEEL, BODY.LIEDOWN, BODY.ANIMATION, BODY.STATIONARY_GUN]);
  }

  /** The class's own graph state (+0x2fc). */
  get graphState(): number {
    return this.stateIndex;
  }

  /** Old name of `state`. */
  get action(): number {
    return this.stateIndex;
  }

  get dead(): boolean {
    return (this.bits & COND.DEAD) !== 0;
  }

  /** +0x33c: the death clip has finished (the death state's end tick 0x45c740 / the dead hold). */
  get deathFinished(): boolean {
    return this.deathHold;
  }

  /** Pose class of the state (stand / kneel / prone). */
  get stance(): Stance {
    if (this.cls === "rpg") return this.stateIndex >= RPG_STATE.TO_KNEEL && this.stateIndex <= RPG_STATE.KNEEL_SHOULDER && this.stateIndex !== RPG_STATE.KNEEL_TO_STAND ? "kneel" : "stand";
    if (this.cls === "female") return "stand";
    if (STANCE_PRONE.has(this.stateIndex)) return "prone";
    if (STANCE_KNEEL.has(this.stateIndex)) return "kneel";
    return "stand";
  }

  /** Rounds fired in the current trigger hold. */
  get burstCount(): number {
    return this.burst;
  }

  get clipEmpty(): boolean {
    return !this.gun || this.ammo <= 0;
  }

  /** Refill the clip at once (FireAt* without reload). */
  refill(): void {
    if (this.gun) this.ammo = this.gun.roundsPerClip;
  }

  /** Damage on the body: flinch / dead bits, zone, death type and direction (FUN_0045bfe0 and siblings). */
  hit(h: SoldierHit): void {
    this.hitZone = h.zone;
    this.recoilAccum = x87F32Add(this.recoilAccum, h.amount);
    if (h.lethal) {
      if (!this.dead) this.stopFiring();
      this.deathType = h.deathType;
      this.deathDirection = [h.direction[0] ?? 0, h.direction[1] ?? 0, h.direction[2] ?? 0];
      this.bits |= COND.DEAD;
    } else if (this.recoilThreshold < this.recoilAccum) {
      this.recoilAccum = 0;
      // HumanSoldierFemale (0x4553e0 / 0x455570 / 0x455780): the sum restarts but no flinch bit is set.
      if (this.cls !== "female") this.bits |= COND.FLINCH;
    }
  }

  /**
   * Kill the body (convenience): lethal damage of the given kind with no
   * direction. The death state starts on the next step (the graph reads the
   * dead bit). deathClip >= 0 = SetDeathAnimation.
   */
  kill(explosion: boolean, deathClip = -1): void {
    if (this.dead) return;
    this.deathOverride = deathClip;
    this.hit({ amount: 0, zone: this.hitZone, deathType: explosion ? DEATH_TYPE.EXPLOSION : DEATH_TYPE.OTHER, direction: [0, 0, 0], lethal: true });
  }

  private stopFiring(): void {
    if (this.firing) {
      this.firing = false;
      this.events.fireStopped?.();
    }
  }

  private playSlot(state: number): void {
    const e = this.actions[state];
    if (e) this.body.playClip(e.clip, e.loop);
  }

  /** Switch state and run the new state's entry handler [recovered SOLDIER_STATES entries]. */
  private enter(state: number): void {
    this.previousState = this.stateIndex;
    this.stateIndex = state;
    const info = SOLDIER_STATES[state];
    if (info && info.crouch !== null) this.crouched = info.crouch === 1;
    switch (state) {
      case ST.STAND:
        if (this.standAnimation !== -1 && this.body.hasClip(this.standAnimation)) this.body.playClip(this.standAnimation, false);
        else this.playSlot(ST.STAND);
        break;
      case ST.RUN_PANIC:
      case ST.RUN:
      case ST.WALK:
      case ST.RUN_GUN: {
        const phase = this.body.phase();
        this.playSlot(state);
        if (PHASE_SYNC_FROM[state]?.includes(this.previousState)) {
          this.body.setTime(phaseTime(phase, this.body.clipDuration(this.body.currentClip)));
        }
        break;
      }
      case ST.GRENADE:
        this.thrown = false;
        this.playSlot(state);
        break;
      case ST.CLOSE_COMBAT:
        this.struck = false;
        this.playSlot(state);
        break;
      case ST.FALL:
        this.playSlot(state);
        this.events.fell?.();
        break;
      case ST.FLINCH: {
        this.aimEnabled = false;
        const zone = SOLDIER_ZONES[this.hitZone];
        if (zone) this.body.playClip(zone.flinchClip, false);
        break;
      }
      case ST.PRONE_FLINCH:
        this.aimEnabled = false;
        this.counter = 0;
        this.playSlot(state);
        break;
      case ST.DEATH_STAND:
      case ST.DEATH_KNEEL:
      case ST.DEATH_PRONE:
        this.enterDeath(state);
        break;
      case ST.ANIMATION: {
        const id = this.scripted;
        if (id !== -1 && this.body.hasClip(id)) {
          this.body.playClip(id, false);
          this.scriptedClip = id;
        } else {
          this.playSlot(ST.RUN); // FUN_00488290(h, 2, 0): table slot 2
          this.scriptedClip = -1;
        }
        this.scripted = 0;
        this.aimEnabled = false;
        break;
      }
      case ST.STATIONARY_GUN:
        this.body.playClip(31, false);
        break;
      default:
        this.playSlot(state);
        break;
    }
  }

  private enterDeath(state: number): void {
    this.stopFiring();
    this.weaponDropped = true;
    this.aimEnabled = false;
    this.deathHold = false;
    const matrixYaw = this.bodyYaw;
    let clip: number;
    if (state === ST.DEATH_KNEEL) clip = KNEELING_DEATH_CLIP;
    else if (state === ST.DEATH_PRONE) clip = PRONE_DEATH_CLIP;
    else {
      const override = this.events.deathAnimation ? this.events.deathAnimation() : this.deathOverride;
      if (override !== -1 && override !== undefined) clip = override;
      else {
        const r = this.randInt(2);
        const type = this.deathType;
        clip = -1;
        if (type === DEATH_TYPE.EXPLOSION || type === DEATH_TYPE.SHOTGUN) clip = this.blownDeath();
        else if (type === DEATH_TYPE.OTHER) {
          const zone = this.hitZone === 15 || this.hitZone === 16 ? SOLDIER_ZONES[this.hitZone] : null;
          clip = zone ? zone.deathClips[r] : STANDING_DEATH_CLIPS[r];
        }
      }
    }
    this.body.playClip(clip, false);
    this.events.died?.({ state, clip, matrixYaw });
  }

  /** FUN_0045c820: blown-down death clip and the heading it sets. */
  private blownDeath(): number {
    const v = this.deathDirection;
    if (v[0] === 0 && v[1] === 0 && v[2] === 0) return BLOWN_DEATH_CLIP.BACKWARD;
    const n = Math.hypot(v[0], v[1], v[2]);
    // Forward = column 1 of the body matrix Rz(+0x508).
    const dot = (v[0] / n) * -Math.sin(this.bodyYaw) + (v[1] / n) * Math.cos(this.bodyYaw);
    const heading = headingOfDirection(v);
    if (dot > 0) {
      this.yaw = x87StoreF32(heading);
      return BLOWN_DEATH_CLIP.FORWARD;
    }
    this.yaw = x87StoreF32(heading + PI_F32);
    return BLOWN_DEATH_CLIP.BACKWARD;
  }

  /** FUN_0045b6a0: the condition bits for this tick. */
  private preUpdate(ch: Float32Array, env: MotorEnv): void {
    let b = this.bits & COND_KEEP;
    if (env.grounded ?? true) b |= COND.GROUNDED;
    else b &= ~COND.GROUNDED;
    if (env.roof) b |= COND.ROOF;
    else b &= ~COND.ROOF;
    if (this.body.finished) b |= COND.FINISHED;
    if (this.walking) b |= COND.WALKING;
    const set = (k: number, m: number) => {
      if (ch[k] !== 0) b |= m;
    };
    set(CH.LEFT, COND.LEFT);
    set(CH.RIGHT, COND.RIGHT);
    set(CH.FORWARD, COND.FORWARD);
    set(CH.BACK, COND.BACK);
    set(CH.FIRE, COND.FIRE);
    set(CH.CH7, COND.CH7);
    set(CH.RELOAD, COND.RELOAD);
    set(CH.CH9, COND.CH9);
    set(CH.KNEEL, COND.KNEEL);
    set(CH.LIEDOWN, COND.LIEDOWN);
    if (ch[CH.ANIMATION] !== 0) {
      b |= COND.ANIMATION;
      this.scripted = x87Fistp(ch[CH.ANIMATION]);
    }
    set(CH.USE, COND.USE);
    set(CH.PANIC, COND.PANIC);
    set(CH.CH26, COND.CH26);
    set(CH.AIM, COND.AIM);
    set(CH.GRENADE, COND.GRENADE);
    set(CH.CLOSE_COMBAT, COND.CLOSE_COMBAT);
    this.bits = b;
  }

  // --- HumanSoldierFemale / HumanSoldierRPG (soldier-variants.ts) ----------------------------

  /**
   * The variant pre-update (0x454ba0 / FUN_00456cf0) and state tick. The AI's soldier-layout request
   * channels are read as the class's own (female: 23 animation, 24 use, 27 aim; RPG: 21 kneel, 23
   * animation); the female's use (switches, doors) and weapon change are not modelled.
   */
  private variantGraph(ch: Float32Array, env: MotorEnv): { refill: boolean; deathSlide: boolean } {
    const female = this.cls === "female";
    let b = this.bits & (female ? FEMALE_KEEP : RPG_KEEP);
    if (env.grounded ?? true) b |= VBIT.GROUNDED;
    else b &= ~VBIT.GROUNDED;
    if (env.roof) b |= VBIT.ROOF;
    else b &= ~VBIT.ROOF;
    if (this.body.finished) b |= VBIT.FINISHED;
    if (this.walking) b |= VBIT.WALKING;
    const bitsOf: Array<[number, number]> = [[CH.LEFT, VBIT.LEFT], [CH.RIGHT, VBIT.RIGHT], [CH.FORWARD, VBIT.FORWARD], [CH.BACK, VBIT.BACK], [CH.FIRE, VBIT.FIRE], [CH.CH7, VBIT.CH7], [CH.RELOAD, VBIT.RELOAD], [CH.CH9, VBIT.CH9]];
    for (const [k, m] of bitsOf) if (ch[k] !== 0) b |= m;
    if (female) {
      if (ch[CH.ANIMATION] !== 0) {
        b |= VBIT.CH21;
        this.scripted = x87Fistp(ch[CH.ANIMATION]);
      }
      if (ch[CH.USE] !== 0) b |= VBIT.CH22;
      if (ch[CH.AIM] !== 0) b |= VBIT.CH23;
    } else {
      if (ch[CH.KNEEL] !== 0) b |= VBIT.CH21;
      if (ch[CH.ANIMATION] !== 0) {
        b |= VBIT.CH22;
        this.scripted = x87Fistp(ch[CH.ANIMATION]);
      }
    }
    this.bits = b;
    let refill = false;
    let deathSlide = false;
    const deathState = female ? FEMALE_STATE.DEATH : RPG_STATE.DEATH;
    if (!this.entered) {
      this.entered = true;
      this.enterVariant(0);
    } else if (this.stateIndex === deathState) {
      // 0x4547b0 / 0x456920: the slide, then the dead hold (0x45c740) once the clip finished.
      if (!this.deathHold) {
        deathSlide = true;
        if (b & VBIT.FINISHED) this.deathHold = true;
      }
    } else {
      const input = { bits: b, scripted: this.scripted, fireChannel: ch[CH.FIRE] !== 0 };
      const r = female ? femaleTick(this.stateIndex, input) : rpgTick(this.stateIndex, input);
      this.triggerThisTick = r.trigger;
      refill = r.refill;
      if (r.aimOn) this.aimEnabled = true;
      if (r.next >= 0) this.enterVariant(r.next);
    }
    return { refill, deathSlide };
  }

  /** The variant entries (0x453a30 ... 0x454940, 0x455990 ... 0x456960) [recovered]. */
  private enterVariant(state: number): void {
    const female = this.cls === "female";
    this.previousState = this.stateIndex;
    this.stateIndex = state;
    const crouch = (female ? FEMALE_CROUCH : RPG_CROUCH)[state];
    if (crouch !== null && crouch !== undefined) this.crouched = crouch === 1;
    const zones = female ? FEMALE_ZONES : RPG_ZONES;
    const F = FEMALE_STATE;
    const R = RPG_STATE;
    if (state === 0) {
      if (this.standAnimation !== -1 && this.body.hasClip(this.standAnimation)) this.body.playClip(this.standAnimation, false);
      else this.playSlot(0);
      return;
    }
    if (female) {
      switch (state) {
        case F.RUN:
        case F.WALK: {
          const phase = this.body.phase();
          this.playSlot(state);
          if (this.previousState === (state === F.RUN ? F.WALK : F.RUN)) this.body.setTime(phaseTime(phase, this.body.clipDuration(this.body.currentClip)));
          return;
        }
        case F.FALL:
          this.playSlot(state);
          this.events.fell?.();
          return;
        case F.FLINCH: {
          const zone = zones[this.hitZone];
          if (zone) this.body.playClip(zone.flinchClip, false);
          this.aimEnabled = false;
          return;
        }
        case F.DEATH:
          this.enterVariantDeath(state, zones);
          return;
        case F.ANIMATION: {
          const id = this.scripted;
          // 0x4547f0: -1 -> slot 6; else the clip LOOPED (FUN_00489ea0(h, id, 1, 0)); missing -> slot 6.
          if (id !== -1 && this.body.hasClip(id)) {
            this.body.playClip(id, true);
            this.scriptedClip = id;
          } else {
            this.playSlot(F.RAISE);
            this.scriptedClip = -1;
          }
          this.scripted = 0;
          this.aimEnabled = false;
          return;
        }
        default:
          this.playSlot(state);
          return;
      }
    }
    switch (state) {
      case R.WALK: {
        const phase = this.body.phase();
        this.playSlot(state);
        if (this.previousState === R.RUN) this.body.setTime(phaseTime(phase, this.body.clipDuration(this.body.currentClip)));
        return;
      }
      case R.FALL:
        this.playSlot(state);
        this.events.fell?.();
        return;
      case R.FLINCH: {
        const zone = zones[this.hitZone];
        if (zone) this.body.playClip(zone.flinchClip, false);
        return;
      }
      case R.DEATH:
        this.enterVariantDeath(state, zones);
        return;
      case R.ANIMATION: {
        // 0x456960: +0xd04 == -1 -> slot 2; else the clip one-shot; missing -> slot 2.
        const id = this.scripted;
        if (id !== -1 && this.body.hasClip(id)) {
          this.body.playClip(id, false);
          this.scriptedClip = id;
        } else {
          this.playSlot(R.WALK);
          this.scriptedClip = -1;
        }
        this.scripted = 0;
        return;
      }
      default:
        this.playSlot(state);
        return;
    }
  }

  /**
   * Female 0x4546c0: the AI's death animation, else the zone record's death clip (13 for every zone).
   * RPG 0x4567c0: the AI's, else r = rand(2); death type 0 / 1 (explosion, shotgun): FUN_0045daa0 -> 16
   * with the blast in front (heading = its direction), else 15 (heading + pi); type 2: head zones 15 /
   * 16 their record's clips[r], else {14, 12}[r]. The gun drops, the aim goes off.
   */
  private enterVariantDeath(state: number, zones: readonly { deathClips: readonly [number, number] }[]): void {
    this.stopFiring();
    this.weaponDropped = true;
    this.aimEnabled = false;
    this.deathHold = false;
    const matrixYaw = this.bodyYaw;
    const override = this.events.deathAnimation ? this.events.deathAnimation() : this.deathOverride;
    let clip = -1;
    if (override !== -1 && override !== undefined) clip = override;
    else if (this.cls === "female") clip = zones[this.hitZone]?.deathClips[0] ?? zones[13].deathClips[0];
    else {
      const r = this.randInt(2);
      if (this.deathType === DEATH_TYPE.EXPLOSION || this.deathType === DEATH_TYPE.SHOTGUN) {
        clip = this.blownDeath() === BLOWN_DEATH_CLIP.FORWARD ? 16 : 15;
      } else if (this.deathType === DEATH_TYPE.OTHER) {
        clip = this.hitZone === 15 || this.hitZone === 16 ? zones[this.hitZone].deathClips[r] : [14, 12][r];
      }
    }
    this.body.playClip(clip, false);
    this.events.died?.({ state, clip, matrixYaw });
  }

  /** One 30 Hz tick with the channels the AI wrote on its previous frame. Returns the root step. */
  step(ch: Float32Array, env: MotorEnv = {}): BodyStep {
    this.triggerThisTick = false;
    let refill = false;
    let deathSlide = false;
    // 1. Graph (FUN_004e2d60).
    if (this.cls !== "soldier") {
      ({ refill, deathSlide } = this.variantGraph(ch, env));
    } else {
    this.preUpdate(ch, env);
    // combat: the pre-update's use (0x459c2b): channel 24 outside state 36 uses task fistp(ch 24) (FUN_00459d50);
    // a StationaryGun switches to state 36 at once and the record's channel 24 is cleared (0x459c5c).
    if (ch[CH.USE] !== 0 && this.stateIndex !== ST.STATIONARY_GUN && this.entered) {
      const kind = this.events.use?.(x87Fistp(ch[CH.USE])) ?? 0;
      if (kind === 6) {
        this.enter(ST.STATIONARY_GUN);
        ch = Float32Array.from(ch);
        ch[CH.USE] = 0;
      }
    }
    if (!this.entered) {
      this.entered = true;
      this.enter(ST.STAND);
    } else if (this.stateIndex >= ST.DEATH_STAND && this.stateIndex <= ST.DEATH_PRONE) {
      // FUN_0045b160: slide, then the dead hold (0x40e7e0) once the clip finished.
      if (!this.deathHold) {
        deathSlide = true;
        if (this.bits & COND.FINISHED) this.deathHold = true;
      }
    } else {
      const r = soldierTick(this.stateIndex, {
        bits: this.bits,
        scripted: this.scripted,
        counter: this.counter,
        eventTrigger: this.eventTrigger,
        eventClip: this.eventClip,
        currentClip: this.body.currentClip,
        aiHasTarget: this.events.hasTarget ? this.events.hasTarget() : true,
        thrown: this.thrown,
        struck: this.struck,
        use: ch[CH.USE] !== 0,
        usePrevious: this.previous[CH.USE] !== 0,
      });
      this.counter = r.counter;
      this.triggerThisTick = r.trigger;
      refill = r.refill;
      if (r.throwGrenade) {
        this.thrown = true;
        if (this.grenades > 0) {
          this.grenades--;
          this.events.grenadeRelease?.();
        }
      }
      if (r.strike) {
        this.struck = true;
        this.events.closeCombatStrike?.();
      }
      if (r.aimOn) this.aimEnabled = true;
      if (r.next >= 0 && this.stateIndex === ST.STATIONARY_GUN && r.next !== ST.STATIONARY_GUN) this.events.gunReleased?.();
      if (r.next >= 0) this.enter(r.next);
    }
    }
    // 2. Walking toggle, flinch bit cleared.
    if (ch[CH.WALK_TOGGLE] !== 0) this.walking = !this.walking;
    this.bits &= ~COND.FLINCH;
    // 3. Turn (FUN_0045fd00) and view pitch (FUN_00463470).
    if (!this.attachedToGun) this.yaw -= turnFromChannel(ch[CH.TURN], this.previous[CH.TURN]);
    this.bodyYaw = this.yaw + this.kickYaw;
    this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pitch + turnFromChannel(ch[CH.PITCH], this.previous[CH.PITCH])));
    this.aimPitch = Math.fround(this.kickPitch + this.pitch);
    // 4. Root delta, then the advance.
    const delta = this.body.rootDelta();
    if (this.rootScale !== 1) for (let k = 0; k < 3; k++) delta[k] = Math.fround(delta[k] * this.rootScale);
    this.rootZ = this.body.rootZ;
    const adv = this.body.advance();
    const first: AnimTrigger | undefined = adv.triggers[0];
    this.eventTrigger = first ? first.trigger : -1;
    this.eventClip = first ? first.clip : -1;
    // 5. Weapon (FUN_00461a90).
    if (refill && this.gun) this.ammo = this.gun.roundsPerClip;
    this.weaponTick();
    const quiet = this.crouched;
    const triggers: number[] = [];
    for (const t of adv.triggers) {
      triggers.push(t.trigger);
      if (t.trigger >= 1000) this.events.trigger?.(t.trigger, quiet);
    }
    this.previous.set(ch);
    return { delta, rootZ: this.rootZ, triggers, finished: adv.finished, deathSlide };
  }

  private weaponTick(): void {
    if (this.cooldown > 0) this.cooldown--;
    const trigger = this.triggerThisTick && !this.dead;
    if (!trigger && this.burst > 0) {
      this.burst = 0;
      this.stopFiring();
    }
    let kickPitch = 0;
    let kickYaw = 0;
    if (trigger && this.pullTrigger() && this.gun?.kick) {
      const k = sampleViewKick(this.gun.kick, this.randFloat ?? (() => 0.5));
      kickPitch = k.pitchRad;
      kickYaw = k.yawRad;
    }
    if (this.gun) {
      this.kickPitch = x87F32Mul(x87F32Add(kickPitch, this.kickPitch), KICK_DECAY);
      this.kickYaw = x87F32Mul(x87F32Add(kickYaw, this.kickYaw), KICK_DECAY);
    }
  }

  /** True when a round left the gun. */
  private pullTrigger(): boolean {
    const gun = this.gun;
    if (!gun || gun.grenade) return false;
    if (this.ammo <= 0) {
      this.stopFiring();
      return false;
    }
    if (this.cooldown > 0) return false;
    if (this.burst >= Math.max(1, gun.maxRoundsPerBurst)) {
      this.stopFiring();
      return false;
    }
    this.ammo--;
    this.burst++;
    this.cooldown = gun.roundsPerMinute > 0 ? Math.max(1, fireCooldownTicks(gun.roundsPerMinute)) : 1;
    this.firing = true;
    this.events.shot?.();
    if (this.ammo <= 0) this.stopFiring();
    return true;
  }
}
