/**
 * Browser entry point. Mounts the canvas, boots the engine, and surfaces fatal
 * errors to the HUD overlay so a blank page is never silent.
 */
import { createGame } from "./engine/game";

function boot(): void {
  const app = document.getElementById("app");
  if (!app) throw new Error("missing #app container");

  const canvas = document.createElement("canvas");
  canvas.id = "game-canvas";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.tabIndex = 0;
  app.appendChild(canvas);

  try {
    createGame(canvas);
  } catch (error) {
    console.error("[boot] failed to start engine:", error);
    const overlay = document.getElementById("overlay");
    if (overlay) {
      overlay.classList.remove("hidden");
      overlay.textContent = "ENGINE ERROR — see console";
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
