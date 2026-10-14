/**
 * HUD. OWNED BY: engine/presentation agent.
 *
 * Binds to the DOM scaffold in index.html (#status, #objective, #crosshair,
 * #overlay) and reflects ctx state: health, ammo, objective text, status
 * messages, and the mission-complete / death overlays. Replaces this stub.
 */
import { GameEvent } from "../events";
import type { GameContext } from "../context";

export interface Hud {
  /** Refresh DOM from ctx (call once per frame). `dt` drives message TTL. */
  update(dt?: number): void;
  /** Show a transient status message (also emitted via GameEvent.Status). */
  message(text: string, ttlSeconds?: number): void;
  /** Show a full-screen overlay (mission complete / death / start prompt). */
  showOverlay(text: string | null): void;
  /** Detach listeners (teardown). */
  dispose(): void;
}

function el(id: string): HTMLElement | null {
  return typeof document !== "undefined" ? document.getElementById(id) : null;
}

export function createHud(ctx: GameContext): Hud {
  const status = el("status");
  const objectiveEl = el("objective");
  const overlay = el("overlay");
  let messageText = "";
  let messageTTL = 0;

  const offStatus = ctx.events.on(GameEvent.Status, (payload) => {
    const p = payload as { text: string; ttl?: number } | undefined;
    if (p) {
      messageText = p.text;
      messageTTL = p.ttl ?? 3;
    }
  });

  return {
    update(dt = 0): void {
      if (messageTTL > 0) messageTTL = Math.max(0, messageTTL - dt);
      if (status) {
        const ammo = ctx.weapon ? `${ctx.weapon.ammo} / ${ctx.weapon.reserve}` : "--";
        const health = Math.max(0, Math.round(ctx.player.health));
        status.textContent = `HP ${health}   AMMO ${ammo}`;
        if (messageTTL > 0 && messageText) status.textContent += `\n${messageText}`;
      }
      if (objectiveEl && ctx.objectives.length > 0) {
        const remaining = ctx.objectives.filter((o) => !o.completed).length;
        objectiveEl.textContent =
          remaining === 0 ? "OBJECTIVES COMPLETE" : `OBJECTIVES: ${remaining}`;
      }
    },
    message(text: string, ttlSeconds = 3): void {
      messageText = text;
      messageTTL = ttlSeconds;
    },
    showOverlay(text: string | null): void {
      if (!overlay) return;
      if (text === null) {
        overlay.classList.add("hidden");
        overlay.textContent = "";
      } else {
        overlay.classList.remove("hidden");
        overlay.textContent = text;
      }
    },
    dispose(): void {
      offStatus();
    },
  };
}

