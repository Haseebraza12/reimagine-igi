/** The player's own game folder as the asset source (loaders/local-source.ts, static hosting). */
import { describe, expect, it } from "vitest";
import { createLocalAssetSource, findInstallRoot, missionManifest, type LocalFile } from "../src/loaders/local-source";

const file = (path: string, text = path): LocalFile => ({ path, read: async () => new TextEncoder().encode(text).buffer });
const install = (prefix: string) => [
  file(`${prefix}MenuSystem/MainMenu.qvm`, "menu"),
  file(`${prefix}common/sounds/sounds.qvm`),
  file(`${prefix}Missions/Location0/Level2/mission.qvm`),
  file(`${prefix}Missions/Location0/Level2/Sounds/B.WAV`),
  file(`${prefix}Missions/Location0/Level2/Sounds/a.wav`),
  file(`${prefix}missions/location0/level10/mission.qvm`),
  file(`${prefix}missions/location0/level1/mission.qvm`),
];

describe("local game folder", () => {
  it("finds the installation root whether the game folder or its parent was picked", () => {
    expect(findInstallRoot(install("").map((f) => f.path))).toBe("");
    expect(findInstallRoot(install("Games/Project IGI/").map((f) => f.path))).toBe("games/project igi/");
    expect(findInstallRoot(["readme.txt", "menusystem/mainmenu.qvm"])).toBeNull();
  });

  it("builds the staging manifest: missions in numeric order, their .wav files in lower case", () => {
    const m = missionManifest(install("").map((f) => f.path));
    expect(m.missions.map((x) => x.script)).toEqual([
      "missions/location0/level1/mission.qvm", "missions/location0/level2/mission.qvm", "missions/location0/level10/mission.qvm",
    ]);
    expect(m.missions[1].sounds).toEqual(["a.wav", "b.wav"]);
  });

  it("reads paths without regard to case, under the root, and serves missions.json", async () => {
    const src = createLocalAssetSource(install("IGI/"), "igi/");
    expect(await src.exists("menusystem/mainmenu.qvm")).toBe(true);
    expect(new TextDecoder().decode(await src.readBinary("MENUSYSTEM/mainmenu.qvm"))).toBe("menu");
    expect(await src.exists("missions.json")).toBe(true);
    const manifest = JSON.parse(new TextDecoder().decode(await src.readBinary("missions.json")));
    expect(manifest.missions).toHaveLength(3);
    expect(await src.exists("nothing.res")).toBe(false);
    await expect(src.readBinary("nothing.res")).rejects.toThrow(/not in the game folder/);
  });
});
