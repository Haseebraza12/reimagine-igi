/// <reference types="vitest/config" />
import { createReadStream, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Connect, Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Original game files are staged into game-data/ by `npm run stage` and served
 * at /raw/ by the dev and preview servers only. They are deliberately NOT in
 * public/, because Vite copies public/ into every production build.
 *
 * The handler is installed as a post middleware (returned from the configure
 * hooks), so Vite's own request checks (invalid requests, CORS, the
 * allowed-hosts DNS-rebinding check) run first. By then the SPA fallback may
 * have rewritten req.url to /index.html, so the original URL is used.
 */
const GAME_DATA = fileURLToPath(new URL("./game-data", import.meta.url));

function serveGameData(): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.originalUrl ?? req.url ?? "";
    if (!url.startsWith("/raw/") || (req.method !== "GET" && req.method !== "HEAD")) return next();
    let relative: string;
    try {
      relative = decodeURIComponent(url.slice("/raw/".length).split("?")[0]);
    } catch {
      res.statusCode = 400; // malformed %-escape
      res.end();
      return;
    }
    const file = resolve(GAME_DATA, relative);
    if (!file.startsWith(GAME_DATA + sep)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    let size: number;
    try {
      const info = statSync(file);
      if (!info.isFile()) throw new Error("not a file");
      size = info.size;
    } catch {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(size));
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    // On a read error or a client abort, pipeline() destroys both streams: the
    // file handle is closed and the client sees a failed request, never a
    // silently truncated one.
    pipeline(createReadStream(file), res, () => {});
  };
  return {
    name: "igi-game-data",
    configureServer(server) {
      return () => server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      return () => server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [serveGameData()],
  publicDir: "public",
  server: {
    port: 5173,
  },
  build: {
    target: "es2022",
    outDir: "dist",
    rollupOptions: {
      output: {
        // Split the large, rarely-changing Three.js runtime into its own chunk
        // so game-code edits don't force players to re-download it (caching).
        manualChunks: {
          three: ["three"],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
