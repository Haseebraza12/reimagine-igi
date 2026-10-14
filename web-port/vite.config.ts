/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Original game data lives in public/raw and is never committed to git.
  publicDir: "public",
  server: {
    port: 5173,
    fs: {
      allow: [".."],
    },
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
