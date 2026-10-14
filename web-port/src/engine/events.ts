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
} as const;
