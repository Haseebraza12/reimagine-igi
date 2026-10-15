/**
 * Minimal typed event bus used to decouple engine subsystems (input/weapons/
 * AI/audio/HUD). Systems emit semantic events; listeners react without importing
 * each other. Confidence note: this is engine scaffolding, not recovered game
 * behaviour — event *names* are chosen by this project.
 */

export type EventPayload = unknown;

export type EventHandler = (payload?: EventPayload) => void;

export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();

  /** Subscribe to `event`. Returns an unsubscribe function. */
  on(event: string, handler: EventHandler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  /** Unsubscribe a previously-registered handler. */
  off(event: string, handler: EventHandler): void {
    const set = this.handlers.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.handlers.delete(event);
  }

  /** Deliver `payload` to every handler of `event` (errors in one handler do
   *  not stop the others). */
  emit(event: string, payload?: EventPayload): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (error) {
        // A misbehaving listener must never break the frame loop.
        console.error(`[events] handler for "${event}" threw:`, error);
      }
    }
  }

  /** Remove every handler (used on teardown). */
  clear(): void {
    this.handlers.clear();
  }
}

/**
 * Well-known engine events. Keeping them central avoids stringly-typed typos
 * across the codebase. Payload shapes are documented per-event.
 */
export const GameEvent = {
  /** Weapon fired. payload: { weaponId: string } */
  Fire: "game:fire",
  /** Weapon dry-fired (trigger pulled, no ammo). payload: undefined */
  DryFire: "game:dryfire",
  /** Reload started. payload: { weaponId: string } */
  ReloadStart: "game:reload-start",
  /** Reload finished. payload: { weaponId: string } */
  ReloadEnd: "game:reload-end",
  /** A shot connected with a target. payload: { damage: number, point: Vec3 } */
  Hit: "game:hit",
  /** An enemy died. payload: { enemyId: number } */
  EnemyKilled: "game:enemy-killed",
  /** Player took damage. payload: { amount: number } */
  PlayerHit: "game:player-hit",
  /** Player died. payload: undefined */
  PlayerDied: "game:player-died",
  /** An objective was completed. payload: { id: string } */
  ObjectiveComplete: "game:objective-complete",
  /** All objectives completed (mission success). payload: undefined */
  MissionComplete: "game:mission-complete",
  /** A status message for the HUD. payload: { text: string, ttl?: number } */
  Status: "game:status",
  /** Trigger released. payload: { weaponId: string } */
  TriggerReleased: "game:trigger-released",
  /**
   * A run of shots ended: trigger released, magazine empty, burst limit
   * reached, reload started or weapon switched. payload: { weaponId: string }
   */
  FireStopped: "game:fire-stopped",
  /** Player switched weapon. payload: { weaponId: string, name: string } */
  WeaponChanged: "game:weapon-changed",
  /** A soldier fired. payload: { position: Vec3, weaponId: string } */
  EnemyFire: "game:enemy-fire",
  /** Mission failed. payload: { text: string } */
  MissionFailed: "game:mission-failed",

  // --- Contract for the recovered subsystems (payload types below) ---------
  /** A StatusMessage task (radio message / pickup / cut-scene line) is sent. payload: StatusMessagePayload */
  StatusMessage: "game:status-message",
  /** A bullet hit world geometry. payload: ImpactPayload */
  Impact: "game:impact",
  /** A character's foot touched down (animation trigger 1010). payload: FootstepPayload */
  Footstep: "game:footstep",
  /** A character landed after falling/jumping. payload: LandPayload */
  Land: "game:land",
  /** An animation sound trigger (ids >= 1000, animtrigger.qvm) fired. payload: AnimTriggerPayload */
  AnimTrigger: "game:anim-trigger",
  /** A soldier took damage. payload: EnemyHitPayload */
  EnemyHit: "game:enemy-hit",
  /** A soldier detected the player (AIEVENT_ENEMYDETECTION). payload: { enemyId: number; position: Vec3 } */
  Detected: "game:detected",
  /** The player picked something up. payload: { kind: "weapon" | "ammo"; name: string } */
  Pickup: "game:pickup",
  /** The player jumped. payload: { actor: "player" } (plays jump_1, docs/audio.md) */
  Jump: "game:jump",
  /** An enemy bullet passed close to the player. payload: { point: Vec3 } (the bullet path's closest point) */
  NearMiss: "game:near-miss",
  /** StatusMessageScreen_ClearMessages() from a task expression: remove every radio message. payload: undefined */
  StatusClear: "game:status-clear",
  /** A cut-scene started / ended. payload: { id: number } */
  CutsceneStart: "game:cutscene-start",
  CutsceneEnd: "game:cutscene-end",
} as const;

type Vec3 = [number, number, number];

/** Who did something: the player, or a soldier by Enemy.id. */
export type Actor = "player" | number;

/** payload of GameEvent.Fire / FireStopped (and EnemyFire with shooter = enemy id). */
export interface FirePayload {
  weaponId: string;
  shooter: Actor;
  /** Muzzle position, engine space. */
  position: Vec3;
}

/** payload of GameEvent.StatusMessage (StatusMessage task fields, docs/hud.md). */
export interface StatusMessagePayload {
  text: string;
  /** Portrait sprite name, or null. */
  sprite: string | null;
  /** Sound definition/sample to play when sent, or null. */
  sound: string | null;
  /** Hold time after typing finishes, seconds (default 2). */
  durationSeconds: number;
  /** Cut-scene subtitle (font4, no box) instead of a radio message. */
  cutscene: boolean;
}

/** payload of GameEvent.Impact. */
export interface ImpactPayload {
  point: Vec3;
  /** Unit surface normal facing the shooter. */
  normal: Vec3;
  /** Game material name (material.qvm DefineGameMaterial), or null when unknown. */
  material: string | null;
  shooter: Actor;
  /** The bullet ricocheted off this surface (second ricochet sound attempt, 0x47a45b). */
  ricochet?: boolean;
  /** The surface was a human body (no decal). */
  human?: boolean;
}

/** payload of GameEvent.Footstep. */
export interface FootstepPayload {
  actor: Actor;
  position: Vec3;
  material: string | null;
  /** Quiet walk: volume x 0.66 (docs/audio.md). */
  quiet: boolean;
}

/** payload of GameEvent.Land. */
export interface LandPayload {
  actor: Actor;
  position: Vec3;
  material: string | null;
  /** The landing caused fall damage. */
  damaged: boolean;
  /** Fall damage / damage capacity (selects player_fall_1/2/3). */
  damageFraction?: number;
  /** Landing speed, m/s (FUN_00408570; the player's view dip). */
  speed?: number;
}

/** payload of GameEvent.AnimTrigger. */
export interface AnimTriggerPayload {
  actor: Actor;
  trigger: number;
  position: Vec3;
}

/** payload of GameEvent.EnemyHit. */
export interface EnemyHitPayload {
  enemyId: number;
  position: Vec3;
  damage: number;
  /** Damage came from an explosion. */
  explosion: boolean;
}
