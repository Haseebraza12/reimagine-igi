/**
 * Game events -> sounds, with the original's selection rules, gates and
 * limiters (docs/audio.md §4 event table). Every rule names its igi.exe
 * source; "inferred" marks assumptions.
 *
 * Positions are engine space. "Attached" sounds are children of the actor
 * (they follow it); the others are children of the global root, placed once.
 */
import type { Vec3 } from "../../contracts";
import {
  DETECTED_SOUNDS,
  FOOTSTEP_SEQUENCE,
  IGI_AUDIO,
  x87Fistp,
  type IgiTask,
  type LevelWeapon,
  type MaterialSounds,
} from "../../loaders";
import type { TaskRuntimeApi } from "../context";
import {
  GameEvent,
  type Actor,
  type AnimTriggerPayload,
  type EnemyHitPayload,
  type EventBus,
  type FirePayload,
  type FootstepPayload,
  type ImpactPayload,
  type LandPayload,
  type StatusMessagePayload,
} from "../events";
import type { IgiAudioData } from "./igi-audio";
import type { SoundHandle, SoundMixer, SoundParent } from "./mixer";

/**
 * Extra event names the audio system listens to (not in GameEvent yet).
 * Emitters may use these strings directly; GameEvent can adopt them as-is.
 */
export const AUDIO_EVENTS = {
  /** The player jumped (jump_1, 0x40bbfd). payload: { actor: Actor } */
  Jump: "game:jump",
  /** A bullet passed close to the player (gunshotmiss, 0x45f3ff). payload: { point: Vec3 } */
  NearMiss: "game:near-miss",
} as const;

/** The slice of GameContext the audio system reads (GameContext satisfies it). */
export interface AudioHostContext {
  events: EventBus;
  player: { position: Vec3; maxHealth: number };
  enemies: ReadonlyArray<{ id: number; position: Vec3; weapon: LevelWeapon | null }>;
  weapon: { spec: LevelWeapon } | null;
  level: { weapons: Map<string, LevelWeapon>; tasks: IgiTask[]; originIgi: Vec3 } | null;
  systems: { tasks: TaskRuntimeApi | null };
}

/** Height of a character's model origin above its feet (pelvis; inferred, docs/gameplay.md "Collision"). */
export const BODY_HEIGHT = 1.0;

/** Ricochet names (table 0x53e7c8). */
export const RICOCHET_SOUNDS: readonly string[] = ["riccochet_1", "riccochet_2", "riccochet_3", "riccochet_4"];

/** Optional payload fields this module understands beyond the shared contract. */
export interface ImpactAudioFields {
  /** The bullet ricocheted off this surface (second ricochet attempt, 0x47a45b). */
  ricochet?: boolean;
}
export interface LandAudioFields {
  /** Fall damage / max health (selects player_fall_1/2/3 at 0.1 / 0.2, FUN_00408570). */
  damageFraction?: number;
  /** Fall damage in health points (used with player.maxHealth when damageFraction is absent). */
  damage?: number;
}
export interface PlayerHitAudioFields {
  amount?: number;
  /** Explosion damage: player_xplhit_1 instead of player_hit_N. */
  explosion?: boolean;
  /** Fall damage plays player_fall_N via Land instead (set to keep PlayerHit silent). */
  fall?: boolean;
  /** The hit killed the player: no hit speech (+0xcf5 test; the death speech comes from state 47). */
  dead?: boolean;
}

interface GunState {
  shooter: Actor;
  weapon: LevelWeapon;
  /** Loop instance handle (gun +0x194). */
  handle: SoundHandle | null;
  lastFire: number;
  /** Gun position minus the shooter's feet at the last shot (the loop follows the shooter). */
  offset: Vec3;
  position: Vec3;
}

const key = (a: Actor) => (a === "player" ? "player" : `ai:${a}`);

export interface SoundEventsOptions {
  /** Uniform [0, 1) source standing in for the game RNG (FUN_004aaa50 / FUN_004aaaa0). */
  random?: () => number;
  /** The level RNG itself: when given, picks use its float / s0 % n / raw step like igi.exe. */
  rng?: GameRng;
  /**
   * Stop an automatic-weapon loop when no Fire arrived for ceil(1800/rpm)+3
   * ticks (port safety net for shooters that never send FireStopped).
   */
  fireWatchdog?: boolean;
  /**
   * Material used when a Footstep / Land / Impact payload has material null
   * (null = silent, as in igi.exe; the engine sends the collision materials).
   */
  fallbackMaterial?: string | null;
}

/** The level RNG interface (engine/ai/rng.ts LevelRng): FUN_004aaa50, FUN_004aaaa0, FUN_004aaa20. */
export interface GameRng {
  float(): number;
  int(n: number): number;
  step(): number;
}

export class SoundEvents {
  private readonly random: () => number;
  private readonly rng: GameRng | null;
  private readonly watchdog: boolean;
  private readonly guns = new Map<string, GunState>();
  /** Per-character speech gate (+0x844) and speech handle (+0x840). */
  private readonly speechNext = new Map<string, number>();
  private readonly speechHandle = new Map<string, SoundHandle>();
  /** Per-walker footstep index (+0x84c). */
  private readonly footIndex = new Map<string, number>();
  private readonly lastActorPos = new Map<string, Vec3>();
  private impactLast = -1;
  private impactLimit = 0;
  private ricochetLast = -1;
  private ricochetLimit = 0;
  private detectedLast = -1;
  private nearMissNext = 0;
  /** Set once a Fire event names an AI shooter; the legacy EnemyFire event is then ignored. */
  private sawAiFire = false;
  /** Rain adds walk_rain_N footsteps (FUN_00415eb0); level 1 is dry. */
  raining = false;
  /** See SoundEventsOptions.fallbackMaterial. */
  fallbackMaterial: string | null;

  constructor(
    private readonly host: AudioHostContext,
    private readonly mixer: SoundMixer,
    private readonly getData: () => IgiAudioData | null,
    private readonly now: () => number,
    options: SoundEventsOptions = {},
  ) {
    this.random = options.random ?? Math.random;
    this.rng = options.rng ?? null;
    this.watchdog = options.fireWatchdog ?? true;
    this.fallbackMaterial = options.fallbackMaterial ?? null;
  }

  /** Subscribe to the event bus; returns the unsubscribe function. */
  bind(events: EventBus = this.host.events): () => void {
    const offs = [
      events.on(GameEvent.Fire, (p) => this.fire((p ?? {}) as Partial<FirePayload>)),
      events.on(GameEvent.FireStopped, (p) => this.fireStopped(((p ?? {}) as Partial<FirePayload>).shooter ?? "player")),
      events.on(GameEvent.EnemyFire, (p) => this.enemyFireLegacy((p ?? {}) as { position?: Vec3; weaponId?: string })),
      events.on(GameEvent.DryFire, () => this.dryFire()),
      events.on(GameEvent.Impact, (p) => this.impact(p as ImpactPayload & ImpactAudioFields)),
      events.on(GameEvent.Footstep, (p) => this.footstep(p as FootstepPayload)),
      events.on(GameEvent.Land, (p) => this.land(p as LandPayload & LandAudioFields)),
      events.on(GameEvent.AnimTrigger, (p) => this.animTrigger(p as AnimTriggerPayload)),
      events.on(GameEvent.PlayerHit, (p) => this.playerHit((p ?? {}) as PlayerHitAudioFields)),
      events.on(GameEvent.PlayerDied, () => this.fireStopped("player")),
      // State 47's enter (FUN_0040e660): the death clip's rand(2) first, then FUN_004624e0's rand(3).
      events.on("game:player-death-state", () => this.playerDied()),
      events.on(GameEvent.EnemyHit, (p) => this.enemyHit(p as EnemyHitPayload)),
      events.on(GameEvent.EnemyKilled, (p) => this.enemyKilled(p as { enemyId: number })),
      events.on(GameEvent.Detected, (p) => this.detected(p as { enemyId: number })),
      events.on(GameEvent.StatusMessage, (p) => this.statusMessage(p as StatusMessagePayload)),
      events.on(GameEvent.Pickup, (p) => this.pickup(p as { kind: string })),
      events.on(AUDIO_EVENTS.Jump, (p) => this.jump(((p ?? {}) as { actor?: Actor }).actor ?? "player")),
      events.on(AUDIO_EVENTS.NearMiss, (p) => this.nearMiss((p as { point: Vec3 }).point)),
    ];
    return () => offs.forEach((off) => off());
  }

  /** Forget gates, limiters, counters and gun loops (mission restart). */
  reset(): void {
    this.guns.clear();
    this.speechNext.clear();
    this.speechHandle.clear();
    this.footIndex.clear();
    this.lastActorPos.clear();
    this.impactLast = -1;
    this.impactLimit = 0;
    this.ricochetLast = -1;
    this.ricochetLimit = 0;
    this.detectedLast = -1;
    this.nearMissNext = 0;
  }

  // ------------------------------------------------------------ helpers

  private rand(): number {
    if (this.rng) return this.rng.float();
    const r = this.random();
    return r >= 1 ? 0.9999999 : r < 0 ? 0 : r;
  }

  /** FUN_004aaaa0(n): 0..n-1. */
  private randInt(n: number): number {
    if (this.rng) return this.rng.int(n);
    return Math.floor(this.rand() * n);
  }

  private material(requested: string | null | undefined): MaterialSounds | undefined {
    const name = requested ?? this.fallbackMaterial;
    if (!name) return undefined;
    const map = this.getData()?.materials;
    if (!map) return undefined;
    const exact = map.get(name);
    if (exact) return exact;
    const lower = name.toLowerCase();
    for (const [k, v] of map) if (k.toLowerCase() === lower) return v;
    return undefined;
  }

  /** Feet position of an actor (last known when it no longer exists). */
  actorFeet(actor: Actor): Vec3 {
    const k = key(actor);
    let p: Vec3 | null = null;
    if (actor === "player") p = this.host.player.position;
    else p = this.host.enemies.find((e) => e.id === actor)?.position ?? null;
    if (p) {
      const copy: Vec3 = [p[0], p[1], p[2]];
      this.lastActorPos.set(k, copy);
      return copy;
    }
    return this.lastActorPos.get(k) ?? [0, 0, 0];
  }

  /** The actor's model as a sound parent: children follow its origin (feet + BODY_HEIGHT). */
  actorParent(actor: Actor): SoundParent {
    return {
      position: () => {
        const f = this.actorFeet(actor);
        return [f[0], f[1] + BODY_HEIGHT, f[2]];
      },
    };
  }

  private attached(name: string, actor: Actor): SoundHandle | null {
    return this.mixer.spawn(name, { parent: this.actorParent(actor) });
  }

  private placed(name: string, position: Vec3): SoundHandle | null {
    return this.mixer.spawn(name, { position });
  }

  private weaponOf(weaponId: string | undefined, shooter: Actor): LevelWeapon | null {
    const byId = weaponId ? this.host.level?.weapons.get(weaponId) : undefined;
    if (byId) return byId;
    if (shooter === "player") return this.host.weapon?.spec ?? null;
    return this.host.enemies.find((e) => e.id === shooter)?.weapon ?? null;
  }

  // ------------------------------------------------------------ weapons

  /**
   * Gun update FUN_004772c0 (0x4773e1-0x4774e7): burst > 1 keeps one "Fire
   * Sound Loop" instance at the gun while firing; burst <= 1 plays "Fire
   * Sound" or "Loop End" per round, 50/50 on the RNG's low bit.
   */
  fire(p: Partial<FirePayload>): void {
    const shooter: Actor = p.shooter ?? "player";
    if (typeof shooter === "number") this.sawAiFire = true;
    const w = this.weaponOf(p.weaponId, shooter);
    if (!w) return;
    const feet = this.actorFeet(shooter);
    const pos: Vec3 = p.position ? [p.position[0], p.position[1], p.position[2]] : [feet[0], feet[1] + BODY_HEIGHT, feet[2]];
    if (w.maxRoundsPerBurst > 1) {
      let g = this.guns.get(key(shooter));
      if (g && g.weapon !== w && g.handle) this.fireStopped(shooter);
      if (!g) {
        g = { shooter, weapon: w, handle: null, lastFire: 0, offset: [0, 0, 0], position: pos };
        this.guns.set(key(shooter), g);
      }
      g.weapon = w;
      g.lastFire = this.now();
      g.position = pos;
      g.offset = [pos[0] - feet[0], pos[1] - feet[1], pos[2] - feet[2]];
      if (!g.handle) {
        g.handle = w.fireSound ? this.placed(w.fireSound, pos) : null;
      } else if (g.handle.alive) {
        g.handle.setPosition(pos);
      }
      return;
    }
    // 0x4774a2: FUN_004aaa20 (raw step of the level RNG) & 1.
    const odd = this.rng ? (this.rng.step() & 1) === 1 : (Math.floor(this.rand() * 0x7fffffff) & 1) === 1;
    const name = odd ? w.fireSound : w.fireSoundEnd;
    if (name) this.placed(name, pos);
  }

  /** Firing stopped (release, burst cap, empty clip, reload, switch): kill the loop, play "Loop End" at the gun. */
  fireStopped(shooter: Actor): void {
    const g = this.guns.get(key(shooter));
    if (!g || !g.handle) return;
    if (g.handle.alive) g.handle.kill();
    g.handle = null;
    if (g.weapon.fireSoundEnd) this.placed(g.weapon.fireSoundEnd, g.position);
  }

  /** Legacy EnemyFire { position, weaponId }: used only until Fire carries AI shooters. */
  private enemyFireLegacy(p: { position?: Vec3; weaponId?: string }): void {
    if (this.sawAiFire || !p.position) return;
    let best: number | null = null;
    let bestD = 4;
    for (const e of this.host.enemies) {
      const d = Math.hypot(e.position[0] - p.position[0], e.position[2] - p.position[2]);
      if (d < bestD) {
        bestD = d;
        best = e.id;
      }
    }
    if (best === null) return;
    this.fire({ weaponId: p.weaponId, shooter: best, position: p.position });
    this.sawAiFire = false;
  }

  /** guns_dry_1, child of the player model (FUN_0040f1d0). */
  dryFire(): void {
    this.attached("guns_dry_1", "player");
  }

  // ------------------------------------------------------------ impacts

  /**
   * FUN_00479e30 0x47a139: global limiter, now - last > limit (limit = 6 +
   * rand(6)); material impact[rand(6)] at the hit point, then a ricochet
   * attempt. A ricocheting bullet makes a second attempt (0x47a45b).
   */
  impact(p: ImpactPayload & ImpactAudioFields): void {
    const now = this.now();
    if (this.impactLast === -1 || Math.abs(now - this.impactLast) > this.impactLimit) {
      const idx = this.randInt(6);
      const name = this.material(p.material)?.impact[idx] ?? "";
      if (name) this.placed(name, p.point);
      this.ricochet(p.point);
      this.impactLast = now;
      this.impactLimit = this.randInt(6) + IGI_AUDIO.impactLimiterTicks[0];
    }
    if (p.ricochet) this.ricochet(p.point);
  }

  /** FUN_0047aa10: riccochet_1..4 (rand(4)) with its own 6 + rand(6) tick limiter. */
  ricochet(point: Vec3): void {
    const now = this.now();
    if (this.ricochetLast !== -1 && Math.abs(now - this.ricochetLast) <= this.ricochetLimit) return;
    this.placed(RICOCHET_SOUNDS[this.randInt(4)], point);
    this.ricochetLast = now;
    this.ricochetLimit = this.randInt(6) + IGI_AUDIO.impactLimiterTicks[0];
  }

  /** gunshotmiss at the closest point; now > next, next = now + 5 (0x45f3ff). */
  nearMiss(point: Vec3): void {
    const now = this.now();
    if (!(now > this.nearMissNext)) return;
    this.placed("gunshotmiss", point);
    this.nearMissNext = now + IGI_AUDIO.nearMissTicks;
  }

  // ------------------------------------------------------------ movement

  /**
   * FUN_00462560 (animation event 1010): walk[FOOTSTEP_SEQUENCE[k]] at the
   * feet, k per walker mod 12 (advanced even without a material), pitch
   * 0.8 + 0.5 rand, x0.66 volume when quiet; walk_rain_(seq+1) when raining.
   */
  footstep(p: FootstepPayload): void {
    const k = this.footIndex.get(key(p.actor)) ?? 0;
    const seq = FOOTSTEP_SEQUENCE[k];
    this.footIndex.set(key(p.actor), (k + 1) % FOOTSTEP_SEQUENCE.length);
    const mat = this.material(p.material);
    if (!mat) return;
    const pitch = this.rand() * 0.5 + 1 - 0.2;
    const h = this.placed(mat.walk[seq] ?? "", p.position);
    if (h) {
      if (p.quiet) h.setVolume(IGI_AUDIO.footstepQuietVolume);
      h.setPitch(pitch);
    }
    if (this.raining) this.placed(`walk_rain_${seq + 1}`, p.position)?.setPitch(pitch);
  }

  /**
   * FUN_0040bce0 / FUN_00408570: the player's fall-damage line
   * (player_fall_1/2/3 for damage < 0.1, < 0.2, >= 0.2 of max health, child of
   * the player model), then the material's land sound at the feet.
   */
  land(p: LandPayload & LandAudioFields): void {
    if (p.actor === "player" && p.damaged) {
      const max = this.host.player.maxHealth || 1;
      const frac = p.damageFraction ?? (p.damage !== undefined ? p.damage / max : 0);
      this.attached(frac < 0.1 ? "player_fall_1" : frac < 0.2 ? "player_fall_2" : "player_fall_3", "player");
    }
    const land = this.material(p.material)?.land;
    if (land) this.placed(land, p.position);
  }

  /** jump_1, child of the player model (0x40bbfd). */
  jump(actor: Actor): void {
    if (actor === "player") this.attached("jump_1", "player");
  }

  /** animtrigger.qvm (FUN_005152c0): attach -> child of the animated actor, else at the trigger point. */
  animTrigger(p: AnimTriggerPayload): void {
    const t = this.getData()?.animTriggers.get(p.trigger);
    if (!t) return;
    if (t.attach) this.attached(t.sound, p.actor);
    else this.placed(t.sound, p.position);
  }

  // ------------------------------------------------------------ speech

  /**
   * FUN_00462400: ignored while now < next; next = now + 30 + trunc(30 rand) (fistp 0x462468, chop mode: 30..59);
   * "<prefix><rand(n)+1>" as a child of the character. The previous line is
   * not stopped in practice: 0x4624bf stores the handle of the instance it
   * just killed, never the new one, so the slot stays empty.
   */
  private hitSpeech(actor: Actor, prefix: string, n: number): void {
    const k = key(actor);
    const now = this.now();
    if ((this.speechNext.get(k) ?? 0) > now) return;
    let killed: SoundHandle | null = null;
    const prev = this.speechHandle.get(k);
    if (prev) {
      if (prev.alive) {
        prev.kill();
        killed = prev;
      }
      this.speechHandle.delete(k);
    }
    const r = x87Fistp(this.rand() * -30);
    this.speechNext.set(k, IGI_AUDIO.speechCooldownTicks[0] - r + now);
    this.attached(`${prefix}${this.randInt(n) + 1}`, actor);
    if (killed) this.speechHandle.set(k, killed);
  }

  /** FUN_004624e0: kills the speech slot, then "<prefix><rand(n)>" with no +1 (index 0 does not exist: silent). */
  private deathSpeech(actor: Actor, prefix: string, n: number): void {
    const k = key(actor);
    const prev = this.speechHandle.get(k);
    if (prev) {
      if (prev.alive) prev.kill();
      this.speechHandle.delete(k);
    }
    this.attached(`${prefix}${this.randInt(n)}`, actor);
  }

  playerHit(p: PlayerHitAudioFields): void {
    if (p.fall || p.dead) return;
    if (p.explosion) this.hitSpeech("player", "player_xplhit_", 1);
    else this.hitSpeech("player", "player_hit_", 4);
  }

  playerDied(): void {
    this.fireStopped("player");
    this.deathSpeech("player", "player_death_", 3);
  }

  enemyHit(p: EnemyHitPayload): void {
    this.hitSpeech(p.enemyId, p.explosion ? "ai_xplhit_" : "ai_hit_", 3);
  }

  enemyKilled(p: { enemyId: number }): void {
    this.fireStopped(p.enemyId);
    this.deathSpeech(p.enemyId, "ai_death_", 4);
  }

  /** FUN_00488d40: detected_01..06 (rand(6)) as a child of the AI; global, now - last > 90 ticks. */
  detected(p: { enemyId: number }): void {
    const now = this.now();
    if (this.detectedLast !== -1 && !(now - this.detectedLast > IGI_AUDIO.detectedCooldownTicks)) return;
    this.attached(DETECTED_SOUNDS[this.randInt(DETECTED_SOUNDS.length)], p.enemyId);
    this.detectedLast = now;
  }

  // ------------------------------------------------------------ 2D

  /** FUN_004845c0 -> FUN_004dddc0: the definition's sample, 2D, volume 1. */
  statusMessage(p: StatusMessagePayload): void {
    if (p?.sound) this.mixer.play2DByName(p.sound);
  }

  /**
   * weaponpickup_1 for GunPickup (FUN_0045ec30, 0x45ecc7) and AmmoPickup (FUN_0045ebf0, 0x45ec19);
   * pickup for the other pickable objects (FUN_0046af40, 0x46af5d). 2D.
   */
  pickup(p: { kind: string }): void {
    this.mixer.play2DByName(p?.kind === "weapon" || p?.kind === "ammo" ? "weaponpickup_1" : "pickup");
  }

  // ------------------------------------------------------------ tick

  /** Per tick: running gun loops follow their shooter; the watchdog closes loops nobody stopped. */
  tick(): void {
    const now = this.now();
    for (const g of this.guns.values()) {
      if (!g.handle) continue;
      if (this.watchdog) {
        const interval = Math.ceil((60 * IGI_AUDIO.tickHz) / Math.max(1, g.weapon.roundsPerMinute || 1));
        if (now - g.lastFire > Math.max(4, interval + 3)) {
          this.fireStopped(g.shooter);
          continue;
        }
      }
      if (!g.handle.alive) continue;
      const f = this.actorFeet(g.shooter);
      g.position = [f[0] + g.offset[0], f[1] + g.offset[1], f[2] + g.offset[2]];
      g.handle.setPosition(g.position);
    }
  }

  /** Number of automatic-weapon loops currently held. */
  get activeGunLoops(): number {
    let n = 0;
    for (const g of this.guns.values()) if (g.handle) n++;
    return n;
  }
}
