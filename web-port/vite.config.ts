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
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
