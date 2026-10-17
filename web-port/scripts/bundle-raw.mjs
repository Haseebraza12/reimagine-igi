#!/usr/bin/env node
/**
 * Copy game-data/ into dist/raw/ so a PRODUCTION build serves the original
 * game files at /raw/* exactly like the dev/preview middleware in
 * vite.config.ts does. Vite does not emit the /raw/ route from `vite build`
 * (it only exists in configureServer/configurePreviewServer), so without this
 * step a deployed site boots to the menu but cannot load any level.
 *
 * Usage:
 *   node scripts/bundle-raw.mjs                 # warn + skip if game-data/ absent
 *   REQUIRE_RAW=1 node scripts/bundle-raw.mjs    # hard-fail if game-data/ absent
 *
 * REQUIRE_RAW=1 is what the Vercel build command should use: it turns "the
 * game files never made it into the deploy" into a loud build failure instead
 * of a silently broken live site.
 *
 * game-data/ is populated by `npm run stage` (scripts/stage-raw.mjs) and is
 * gitignored; it must never be committed or published without a redistribution
 * arrangement. Bundling it into dist/ therefore publishes it — only do this
 * when you have the rights to distribute the data.
 */
import { cp, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webPort = resolve(here, "..");
const src = join(webPort, "game-data");
const out = join(webPort, "dist", "raw");

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(src))) {
    const msg = "game-data/ not found — run `npm run stage` to copy the original game files.";
    if (process.env.REQUIRE_RAW === "1") {
      console.error(`[bundle-raw] ERROR: ${msg}`);
      process.exit(1);
    }
    console.warn(`[bundle-raw] WARNING: ${msg} Building WITHOUT game data.`);
    return;
  }
  await rm(out, { recursive: true, force: true });
  await cp(src, out, { recursive: true });
  console.log(`[bundle-raw] bundled game-data/ into ${out}`);
}

await main();