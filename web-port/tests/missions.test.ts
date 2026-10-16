/**
 * Missions by DefineMission: the generic path builders reproduce level 1's
 * hand-written tables exactly, and the mission script yields the folders.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEVEL1_MISSION, LEVEL1_PATHS, levelPathsFor } from "../src/loaders";
import { LEVEL1_AUDIO_PATHS, LEVEL1_SOUND_FILES, audioPathsFor } from "../src/engine/audio/igi-audio";
import { readMissionDefinition } from "../src/engine/ui/assets";
import { RAW_ROOT, readRaw } from "./helpers";

/** LEVEL1_PATHS as it was written by hand before missions were generic (git 2fdacff). */
const HAND_WRITTEN = {
  objects: "missions/location0/level1/objects.qvm",
  lightmaps: "missions/location0/level1/lightmaps/lightmaps.res",
  terrain: {
    ctr: "missions/location0/level1/terrain/terrain.ctr",
    cmd: "missions/location0/level1/terrain/terrain.cmd",
    hmp: "missions/location0/level1/terrain/terrain.hmp",
    tex: "missions/location0/level1/terrain/terrain.tex",
    bit: "missions/location0/level1/terrain/terrain.bit",
    lmp: "missions/location0/level1/terrain/terrain.lmp",
    qvm: "missions/location0/level1/terrain/terrain.qvm",
  },
  archives: [
    {
      id: "level1",
      models: "missions/location0/level1/models/level1.res",
      mtp: "missions/location0/level1/level1.mtp",
      textures: "missions/location0/level1/textures/level1.res",
    },
    {
      id: "location0",
      models: "missions/location0/common/models/location0.res",
      mtp: "missions/location0/common/location0.mtp",
      textures: "missions/location0/common/textures/location0.res",
    },
  ],
  magicObjects: "magicobj/magicobj.qvm",
  weaponConfig: "weapons/weaponconfig.qvm",
  sounds: "common/sounds/sounds.res",
  objectiveText: "language/english/objectives.res",
  messageText: "language/english/messages.res",
  missionText: "language/english/missions.res",
  missionNumber: 1,
  config: "config.qvm",
  aiSettings: "common/ai/settings.qvm",
  aiScripts: "common/ai/",
  missionAiScripts: "missions/location0/level1/ai/",
  anims: "common/anims/",
  humanPlayer: "humanplayer/humanplayer.qvm",
  materials: "material/material.qvm",
};

describe("mission paths", () => {
  it("levelPathsFor(mission 1) is the former hand-written level-1 table", () => {
    expect(levelPathsFor(LEVEL1_MISSION)).toEqual(HAND_WRITTEN);
    expect(LEVEL1_PATHS).toEqual(HAND_WRITTEN);
  });

  it("another mission follows igi.exe's layout (level folder, location common folder)", () => {
    const p = levelPathsFor({ id: 5, levelDir: "missions/location1/level2/", commonDir: "missions/location1/common", location: "location1", level: "level2" });
    expect(p.objects).toBe("missions/location1/level2/objects.qvm");
    expect(p.terrain.tex).toBe("missions/location1/level2/terrain/terrain.tex");
    expect(p.archives).toEqual([
      { id: "level2", models: "missions/location1/level2/models/level2.res", mtp: "missions/location1/level2/level2.mtp", textures: "missions/location1/level2/textures/level2.res" },
      { id: "location1", models: "missions/location1/common/models/location1.res", mtp: "missions/location1/common/location1.mtp", textures: "missions/location1/common/textures/location1.res" },
    ]);
    expect(p.missionAiScripts).toBe("missions/location1/level2/ai/");
    expect(p.missionNumber).toBe(5);
    expect(p.weaponConfig).toBe(LEVEL1_PATHS.weaponConfig);
  });

  it("audioPathsFor(level 1) is the former level-1 audio table", () => {
    expect(audioPathsFor("missions/location0/level1", LEVEL1_SOUND_FILES)).toEqual(LEVEL1_AUDIO_PATHS);
    expect(LEVEL1_AUDIO_PATHS.missionSoundDir).toBe("missions/location0/level1/sounds/");
    expect(LEVEL1_AUDIO_PATHS.missionDefinitions).toBe("missions/location0/level1/sounds/sounds.qvm");
    expect(LEVEL1_AUDIO_PATHS.missionSoundFiles.length).toBe(29);
  });
});

describe.skipIf(!existsSync(`${RAW_ROOT}/missions/location0/level1/mission.qvm`))("DefineMission", () => {
  it("mission 1's script gives its folders, picture and (in this build) no next mission", async () => {
    const [m] = readMissionDefinition(await readRaw("missions/location0/level1/mission.qvm"), new Map([["mission 1 name", "Trainyard"]]));
    expect(m).toMatchObject({ id: 1, name: "Trainyard", sprite: "mission1.spr", nextMission: -1, soundFiles: null });
    expect(m.location).toEqual(LEVEL1_MISSION);
  });
});
