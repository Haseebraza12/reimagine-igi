/**
 * HUD.
 *
 * Binds to the DOM scaffold in index.html (#status, #objective, #crosshair,
 * #overlay) and reflects ctx state: health, ammo, objective count, status
 * messages and the mission-complete / death overlays. Everything is looked up
 * defensively — the HUD silently does nothing when the DOM scaffold is absent
 * (SSR, unit tests, headless runs).
 *
 * Confidence: scaffolding. Text layout is this project's choice; the numbers
 * come straight from ctx (player health, weapon ammo, objective flags).
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

/** CSS class toggled on #status for the event/damage flash. */
const FLASH_CLASS = "flash";
/** How long the flash class stays on #status, in milliseconds. */
const FLASH_MS = 260;
/** Id of the <style> element injected for the flash animation. */
const FLASH_STYLE_ID = "igi-hud-flash-style";
const DEFAULT_MESSAGE_TTL = 3;
/** Health fraction at/below which a "LOW HEALTH" hint appears. */
const LOW_HEALTH_FRACTION = 0.3;

function el(id: string): HTMLElement | null {
  return typeof document !== "undefined" ? document.getElementById(id) : null;
}

/**
 * index.html ships no flash keyframes, so inject them once from here (we own
 * only presentation files). Returns the node so dispose() can remove it.
 */
function ensureFlashStyles(): HTMLStyleElement | null {
  if (typeof document === "undefined") return null;
  if (document.getElementById(FLASH_STYLE_ID)) return null;
  const style = document.createElement("style");
  style.id = FLASH_STYLE_ID;
  style.textContent = [
    "@keyframes igi-status-flash {",
    "  0% { color: #ff6a4d; background: rgba(255,70,50,0.45); }",
    "  100% { color: inherit; background: transparent; }",
    "}",
    `#status.${FLASH_CLASS} { animation: igi-status-flash ${FLASH_MS}ms ease-out; }`,
  ].join("\n");
  const parent = document.head ?? document.body;
  if (!parent) return null;
  parent.appendChild(style);
  return style;
}


export function createHud(ctx: GameContext): Hud {
  const status = el("status");
  const objectiveEl = el("objective");
  const overlay = el("overlay");
  const flashStyle = ensureFlashStyles();
  const events = ctx.events ?? null;

  let messageText = "";
  let messageTTL = 0;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last written strings — avoids touching the DOM when nothing changed. */
  let lastStatus = "";
  let lastObjective = "";

  // #status is a plain block; make "\n" render as a real line break.
  if (status) status.style.whiteSpace = "pre-line";

  /** Briefly highlight #status (damage taken, objective chime, ...). */
  function flash(): void {
    if (!status || typeof status.classList?.add !== "function") return;
    status.classList.add(FLASH_CLASS);
    if (flashTimer !== null) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashTimer = null;
      status.classList.remove(FLASH_CLASS);
    }, FLASH_MS);
  }

  function showMessage(text: string, ttl: number): void {
    messageText = text;
    messageTTL = ttl;
    renderStatus();
    flash();
  }

  function renderStatus(): void {
    if (!status) return;
    const health = ctx.player
      ? Math.max(0, Math.round(Number.isFinite(ctx.player.health) ? ctx.player.health : 0))
      : 0;
    const weapon = ctx.weapon;
    const ammo = weapon
      ? `${Math.max(0, Math.round(weapon.ammo))} / ${Math.max(0, Math.round(weapon.reserve))}`
      : "-- / --";
    const line = `HP ${health}   AMMO ${ammo}`;
    const text = messageTTL > 0 && messageText ? `${line}\n${messageText}` : line;
    if (text !== lastStatus) {
      status.textContent = text;
      lastStatus = text;
    }
  }

  function renderObjective(): void {
    if (!objectiveEl) return;
    const objectives = ctx.objectives ?? [];
    let text: string;
    if (objectives.length === 0) {
      text = "";
    } else {
      const remaining = objectives.filter((o) => o && !o.completed).length;
      text = remaining === 0 ? "OBJECTIVES COMPLETE" : `OBJECTIVES: ${remaining}`;
    }
    if (text !== lastObjective) {
      objectiveEl.textContent = text;
      lastObjective = text;
    }
  }

  // --- Event wiring (each returns an unsubscribe function) -----------------
  const offStatus = events
    ? events.on(GameEvent.Status, (payload) => {
        const p = payload as { text?: string; ttl?: number } | undefined;
        if (p && typeof p.text === "string") {
          const ttl =
            typeof p.ttl === "number" && Number.isFinite(p.ttl)
              ? Math.max(0, p.ttl)
              : DEFAULT_MESSAGE_TTL;
          showMessage(p.text, ttl);
        }
      })
    : () => {};

  const offObjective = events
    ? events.on(GameEvent.ObjectiveComplete, (payload) => {
        const p = payload as { id?: string } | undefined;
        showMessage(
          p && typeof p.id === "string" ? `OBJECTIVE COMPLETE: ${p.id}` : "OBJECTIVE COMPLETE",
          2.5,
        );
        renderObjective();
      })
    : () => {};

  const offMission = events
    ? events.on(GameEvent.MissionComplete, () => {
        showMessage("ALL OBJECTIVES COMPLETE", 5);
        renderObjective();
      })
    : () => {};

  const offPlayerHit = events
    ? events.on(GameEvent.PlayerHit, () => {
        flash();
        const player = ctx.player;
        if (player && player.maxHealth > 0 && player.health > 0) {
          if (player.health / player.maxHealth <= LOW_HEALTH_FRACTION) {
            messageText = "LOW HEALTH";
            messageTTL = 1.5;
            renderStatus();
          }
        }
      })
    : () => {};

  const offPlayerDied = events
    ? events.on(GameEvent.PlayerDied, () => {
        messageText = "";
        messageTTL = 0;
        renderStatus();
        flash();
      })
    : () => {};

  return {
    update(dt = 0): void {
      const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
      if (messageTTL > 0) {
        messageTTL = Math.max(0, messageTTL - step);
        if (messageTTL === 0) messageText = "";
      }
      renderStatus();
      renderObjective();
    },
    message(text: string, ttlSeconds = DEFAULT_MESSAGE_TTL): void {
      const ttl =
        Number.isFinite(ttlSeconds) ? Math.max(0, ttlSeconds) : DEFAULT_MESSAGE_TTL;
      messageText = text;
      messageTTL = ttl;
      renderStatus();
      // Documented contract: messages are broadcast as GameEvent.Status too.
      events?.emit(GameEvent.Status, { text, ttl });
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
      offObjective();
      offMission();
      offPlayerHit();
      offPlayerDied();
      if (flashTimer !== null) {
        clearTimeout(flashTimer);
        flashTimer = null;
      }
      if (status) status.classList.remove(FLASH_CLASS);
      flashStyle?.remove();
      messageText = "";
      messageTTL = 0;
    },
  };
}


