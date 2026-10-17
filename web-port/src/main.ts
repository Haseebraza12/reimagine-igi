/**
 * Browser entry point. Mounts the canvas, boots the engine, and surfaces fatal
 * errors to the HUD overlay so a blank page is never silent.
 */
import { createGame } from "./engine/game";
import { gameAssetSource, setGameAssetSource } from "./engine/asset-source";
import { pickGameFolder } from "./engine/ui/folder-picker";

/**
 * The dev / preview servers serve the staged files at /raw/ (vite.config.ts); a static host
 * (Vercel) has none, so the player opens their own installation folder first.
 */
async function chooseSource(): Promise<void> {
  try {
    const r = await fetch("/raw/menusystem/mainmenu.qvm", { method: "HEAD" });
    const type = r.headers.get("content-type") ?? "";
    if (r.ok && !type.includes("text/html")) {
      gameAssetSource();
      return;
    }
  } catch {
    /* no server-side game files */
  }
  setGameAssetSource(await pickGameFolder());
}

async function boot(): Promise<void> {
  await chooseSource();
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
  document.addEventListener("DOMContentLoaded", () => void boot());
} else {
  void boot();
}
