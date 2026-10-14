/**
 * Loader layer — IGI binary format parsers exposed to the engine.
 *
 * Public API frozen by docs/loader-api.md; engine imports ONLY this module
 * plus src/contracts.ts. See the individual modules for measured-format
 * documentation and confidence notes:
 *
 *   ilff.ts      ILFF/IRES .res containers (port of tools/igi_formats.py)
 *   loop-tex.ts  LOOP v11 .tex bitmaps   (port of tools/igi_formats.py)
 *   hmp.ts       .hmp heightfields       (measured from real game data)
 *   lmp.ts       .lmp lightmap tiles     (measured + QSC cross-checked)
 *   terrain.ts   loadTerrain assembly with manifest precedence
 *   manifest.ts  level manifest.json fetching
 *   http-source.ts HTTP asset source ("/raw/", "/assets/", ...)
 *
 * NOTE: fs-source.ts (createFsAssetSource) is intentionally NOT re-exported
 * here so the browser bundle never pulls in node:fs; tests import it
 * directly from "../src/loaders/fs-source".
 */
export type { IlffMember } from "./ilff";
export { readIlffMembers } from "./ilff";
export { decodeTex } from "./loop-tex";
export { readHmp } from "./hmp";
export { readLmp } from "./lmp";
export { createHttpAssetSource } from "./http-source";
export { loadTerrain } from "./terrain";
export { loadLevelManifest } from "./manifest";
