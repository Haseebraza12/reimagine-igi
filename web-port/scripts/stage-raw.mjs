#!/usr/bin/env node
/**
 * Copy the original game files the web port reads into game-data/.
 *
 * The browser loads ORIGINAL files at runtime (decoders live in
 * src/loaders/); nothing is converted. The dev/preview servers serve
 * game-data/ at /raw/ (vite.config.ts). It is gitignored, kept out of public/
 * so production builds never contain it, and must never be committed or
 * deployed without a redistribution arrangement.
 *
 *   npm run stage                       # reads ../Game Files
 *   IGI_GAME_DIR=/path/to/IGI npm run stage
 *
 * Every copied file is verified byte-for-byte after copying.
 */
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webPort = resolve(here, "..");
const source = resolve(process.env.IGI_GAME_DIR ?? join(webPort, "..", "Game Files"));
const target = join(webPort, "game-data");

/** Files (or whole directories, trailing "/") the runtime needs. */
const REQUIRED = [
  "missions/location0/level1/objects.qvm",
  "missions/location0/level1/level1.mtp",
  "missions/location0/level1/models/level1.res",
  "missions/location0/level1/textures/level1.res",
  "missions/location0/level1/lightmaps/lightmaps.res",
  "missions/location0/level1/terrain/",
  "missions/location0/level1/graphs/",
  "missions/location0/level1/ai/",
  "missions/location0/common/location0.mtp",
  "missions/location0/common/models/location0.res",
  "missions/location0/common/textures/location0.res",
  "missions/location0/common/textures/sky_layer1.tex",
  "missions/location0/common/textures/sky_layer2.tex",
  "magicobj/magicobj.qvm",
  "weapons/weaponconfig.qvm",
  "humanplayer/humanplayer.qvm",
  "config.qvm",
  "common/ai/",
  "common/sounds/sounds.res",
  "language/english/objectives.res",
  "language/english/messages.res",
  "language/english/missions.res",
  // Sound, character, interface and rendering data (audio, animation, HUD,
  // menus, effects).
  "missions/location0/level1/sounds/",
  "missions/location0/level1/mission.qvm",
  "missions/location0/level1/level1.dat",
  "missions/location0/common/location0.dat",
  "common/",
  "screens/",
  "menusystem/",
  "weapons/",
  // DefineAmmoType per calibre ("LOCAL:ammo", FUN_0047b3d0): tracers, pickup models.
  "ammo/",
  "physicsobj/",
  "computer/",
  "material/",
  "animtrigger/",
  "lod.qvm",
  "language/english/",
];

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function main() {
  try {
    if (!(await stat(source)).isDirectory()) throw new Error("not a directory");
  } catch {
    console.error(`Game directory not found: ${source}\nSet IGI_GAME_DIR to your Project I.G.I. installation.`);
    process.exit(1);
  }
  let copied = 0;
  let bytes = 0;
  const missing = [];
  for (const item of REQUIRED) {
    const from = join(source, item);
    let files;
    try {
      files = item.endsWith("/") ? await listFiles(from) : [from];
      await stat(files[0] ?? from);
    } catch {
      missing.push(item);
      continue;
    }
    for (const file of files) {
      const rel = relative(source, file);
      const to = join(target, rel);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(file, to);
      const [a, b] = await Promise.all([readFile(file), readFile(to)]);
      if (!a.equals(b)) throw new Error(`verification failed for ${rel}`);
      copied++;
      bytes += a.length;
    }
  }
  // Every mission of the installation (missions/<location>/<level>/mission.qvm): its level folder
  // and its location's common folder, at lower-case paths (DefineMission names them in lower case),
  // and game-data/missions.json listing each mission script and its MISSION:sounds files.
  const manifest = { version: 1, missions: [] };
  const staged = new Set();
  const copyTree = async (dirRel) => {
    let files;
    try {
      files = await listFiles(join(source, dirRel));
    } catch {
      return;
    }
    for (const file of files) {
      const rel = relative(source, file).split("\\").join("/");
      const relLower = rel.toLowerCase();
      if (staged.has(relLower)) continue;
      staged.add(relLower);
      const to = join(target, relLower);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(file, to);
      const [a, b] = await Promise.all([readFile(file), readFile(to)]);
      if (!a.equals(b)) throw new Error(`verification failed for ${rel}`);
      copied++;
      bytes += a.length;
    }
  };
  const missionsDir = join(source, "missions");
  let locations = [];
  try {
    locations = (await readdir(missionsDir, { withFileTypes: true })).filter((e) => e.isDirectory());
  } catch {
    /* no missions folder: reported as missing above */
  }
  for (const loc of locations) {
    const levels = (await readdir(join(missionsDir, loc.name), { withFileTypes: true })).filter((e) => e.isDirectory());
    for (const lvl of levels) {
      const files = await readdir(join(missionsDir, loc.name, lvl.name)).catch(() => []);
      const script = files.find((f) => f.toLowerCase() === "mission.qvm");
      if (!script) continue;
      await copyTree(join("missions", loc.name, lvl.name));
      const common = (await readdir(join(missionsDir, loc.name))).find((f) => f.toLowerCase() === "common");
      if (common) await copyTree(join("missions", loc.name, common));
      const soundDir = files.find((f) => f.toLowerCase() === "sounds");
      const sounds = soundDir
        ? (await readdir(join(missionsDir, loc.name, lvl.name, soundDir))).filter((f) => f.toLowerCase().endsWith(".wav")).map((f) => f.toLowerCase()).sort()
        : [];
      manifest.missions.push({ script: `missions/${loc.name}/${lvl.name}/mission.qvm`.toLowerCase(), sounds });
    }
  }
  // The installation's own igi.exe, read only for the Credits screen's original-team table
  // (src/loaders/exe-credits.ts); optional, staged as game-data/igi.exe.
  const exe = (await readdir(source).catch(() => [])).find((f) => f.toLowerCase() === "igi.exe");
  if (exe) {
    const to = join(target, "igi.exe");
    await copyFile(join(source, exe), to);
    const [a, b] = await Promise.all([readFile(join(source, exe)), readFile(to)]);
    if (!a.equals(b)) throw new Error(`verification failed for ${exe}`);
    copied++;
    bytes += a.length;
  }
  manifest.missions.sort((a, b) => a.script.localeCompare(b.script, "en", { numeric: true }));
  await writeFile(join(target, "missions.json"), JSON.stringify(manifest, null, 1) + "\n");
  console.log(`Missions found: ${manifest.missions.length} (${manifest.missions.map((m) => m.script.replace(/^missions\//, "").replace(/\/mission\.qvm$/, "")).join(", ")})`);
  console.log(`Staged ${copied} files (${(bytes / 1048576).toFixed(1)} MiB) from ${source} into ${target}`);
  if (missing.length) {
    console.error(`Missing from the game directory:\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }
}

await main();
