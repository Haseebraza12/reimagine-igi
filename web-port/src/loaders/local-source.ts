/**
 * `IAssetSource` over a folder the player picked in the browser (their own
 * Project I.G.I. installation). The files stay on the player's computer and
 * are read on demand; nothing is uploaded or copied.
 *
 * Paths are matched without regard to letter case (installations differ, and
 * the staging script lower-cases the mission folders). The staging manifest
 * `missions.json` (scripts/stage-raw.mjs) is built from the folder listing.
 */
import type { IAssetSource } from "../contracts";

/** One file of the picked folder: its path inside the installation and a reader. */
export interface LocalFile {
  /** Relative to the installation root, forward slashes ("menusystem/mainmenu.qvm"). */
  path: string;
  read(): Promise<ArrayBuffer>;
}

/** Files that mark an installation root (relative, lower case). */
export const INSTALL_MARKERS = ["menusystem/mainmenu.qvm", "common/sounds/sounds.qvm"] as const;

/**
 * The installation root inside a picked tree: the prefix (possibly "") under which every
 * INSTALL_MARKERS file exists, so picking the game folder or its parent both work. Null when the
 * tree holds no installation.
 */
export function findInstallRoot(paths: Iterable<string>): string | null {
  const lower = new Set<string>();
  for (const p of paths) lower.add(p.toLowerCase());
  let best: string | null = null;
  for (const p of lower) {
    if (!p.endsWith(INSTALL_MARKERS[0])) continue;
    const prefix = p.slice(0, p.length - INSTALL_MARKERS[0].length);
    if (prefix && !prefix.endsWith("/")) continue;
    if (INSTALL_MARKERS.every((m) => lower.has(prefix + m)) && (best === null || prefix.length < best.length)) best = prefix;
  }
  return best;
}

/**
 * The staging manifest for a file listing (relative paths): every missions/<location>/<level> with a
 * mission.qvm and the .wav files of its sounds folder, as scripts/stage-raw.mjs writes it.
 */
export function missionManifest(paths: Iterable<string>): { version: 1; missions: Array<{ script: string; sounds: string[] }> } {
  const scripts: string[] = [];
  const sounds = new Map<string, string[]>();
  for (const raw of paths) {
    const p = raw.toLowerCase();
    const m = /^missions\/([^/]+)\/([^/]+)\/(.+)$/.exec(p);
    if (!m) continue;
    const dir = `missions/${m[1]}/${m[2]}`;
    if (m[3] === "mission.qvm") scripts.push(`${dir}/mission.qvm`);
    const s = /^sounds\/([^/]+\.wav)$/.exec(m[3]);
    if (s) {
      const list = sounds.get(dir) ?? [];
      list.push(s[1]);
      sounds.set(dir, list);
    }
  }
  scripts.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  return {
    version: 1,
    missions: scripts.map((script) => ({ script, sounds: (sounds.get(script.slice(0, -"/mission.qvm".length)) ?? []).sort() })),
  };
}

/** An asset source over `files`, rooted at `root` (findInstallRoot); paths are case-insensitive. */
export function createLocalAssetSource(files: Iterable<LocalFile>, root = ""): IAssetSource {
  const byPath = new Map<string, LocalFile>();
  const rootLower = root.toLowerCase();
  for (const f of files) {
    const p = f.path.toLowerCase();
    if (!p.startsWith(rootLower)) continue;
    byPath.set(p.slice(rootLower.length), f);
  }
  const manifest = new TextEncoder().encode(JSON.stringify(missionManifest(byPath.keys())) + "\n");
  const key = (path: string) => path.replace(/^\/+/, "").toLowerCase();
  return {
    async exists(path: string): Promise<boolean> {
      const k = key(path);
      return k === "missions.json" || byPath.has(k);
    },
    async readBinary(path: string): Promise<ArrayBuffer> {
      const k = key(path);
      if (k === "missions.json") return manifest.slice().buffer;
      const f = byPath.get(k);
      if (!f) throw new Error(`not in the game folder: ${path}`);
      return await f.read();
    },
  };
}
