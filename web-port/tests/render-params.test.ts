/**
 * Recovered renderer parameters (src/loaders/render-params.ts; evidence in
 * docs/rendering.md, constants re-read from igi.exe by
 * tools/igi_render_params.py). Reference values below were produced by
 * tools/igi_render_params.py from the level-1 data.
 */
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { readIlffMembers } from "../src/loaders/ilff";
import { decodeTex } from "../src/loaders/loop-tex";
import { readQvmCallTree } from "../src/loaders/qvm";
import {
  BLOB_SHADOW,
  CAMERA,
  DEPTH_LAYERS,
  DRAW_STATES,
  MUZZLE_FLASH,
  buildSkyDome,
  cloudFadeStartM,
  cloudLayerAlpha,
  cloudUv,
  colourByte,
  d3dProjection,
  decodeLoopV2Tex,
  fogDensityPerMetre,
  fogFactor,
  horizontalFovDeg,
  muzzleFlashVisible,
  readFlatSky,
  readGlobalLight,
  readImpactMaterials,
  readLodSettings,
  readMipMapControl,
  readModelLodTable,
  readSkyLayers,
  selectLodExplicit,
  selectLodRelative,
  skyDomeYawRad,
  terrainFoggedColour,
  threeCameraParams,
  verticalFovDeg,
  type FlatSkyParams,
} from "../src/loaders/render-params";
import { flattenTasks, readTaskTree, type IgiTask } from "../src/loaders/tasks";
import { RAW_ROOT, readRaw } from "./helpers";

/** Level-1 FlatSky values (objects.qvm, observed). */
const LEVEL1_SKY: FlatSkyParams = {
  clearColour: [0.20000000298023224, 0.2884620130062103, 0.4000000059604645],
  zPosM: 4,
  distanceM: 100,
  fogAmount: 0.9416670203208923,
  angleDeg: 15,
  snapColours: true,
  top: [0.11538500338792801, 0.1923079937696457, 0.6153849959373474],
  middle1: [0.40384599566459656, 0.596153974533081, 0.6730769872665405],
  middle2: [0.40384599566459656, 0.596153974533081, 0.6730769872665405],
  bottom1: [0.7115380167961121, 0.6153849959373474, 0.5192310214042664],
  bottom2: [0.7115380167961121, 0.6153849959373474, 0.5192310214042664],
};

/**
 * Ring colours from tools/igi_render_params.py (pole, then 84 .. 0 degrees):
 * float32 store + fistp, both truncating in igi.exe's chop mode (FUN_00526c10).
 */
const LEVEL1_RINGS = [
  "1d319c", "23399e", "29419f", "2f49a0", "3451a1", "3a5aa2", "4062a3", "466aa5",
  "4c72a6", "527ba7", "5883a8", "5e8ba9", "6493ab", "86999b", "b59c84", "b59c84",
];

const hex = (c: Uint8Array, i: number) => Array.from(c.subarray(i * 3, i * 3 + 3), (v) => v.toString(16).padStart(2, "0")).join("");

describe("camera and depth layers", () => {
  it("90 x 73.74 degree player view and 60 degree gun view, 4:3 hard-wired", () => {
    expect(horizontalFovDeg(CAMERA.worldTanHalfFovX)).toBeCloseTo(90, 9);
    expect(verticalFovDeg(CAMERA.worldTanHalfFovX)).toBeCloseTo(73.7397953, 6);
    expect(horizontalFovDeg(CAMERA.gunTanHalfFovX)).toBeCloseTo(60, 9);
    expect(verticalFovDeg(CAMERA.gunTanHalfFovX)).toBeCloseTo(46.8264, 3);
    expect(threeCameraParams(1, 16 / 9, "stretch").aspect).toBeCloseTo(4 / 3, 12);
    expect(threeCameraParams(1, 16 / 9).aspect).toBeCloseTo(16 / 9, 12);
  });

  it("projection matches FUN_00495c70 (row-vector D3D, y down)", () => {
    const m = d3dProjection(1, DEPTH_LAYERS.world.nearM, DEPTH_LAYERS.world.farM);
    expect(m[0]).toBeCloseTo(1, 12);
    expect(m[5]).toBeCloseTo(-1 / 0.75, 12);
    expect(m[11]).toBe(1);
    expect(m[14] / m[10]).toBeCloseTo(-0.1, 9);
  });

  it("gun layer is entirely in front of the world layer", () => {
    expect(DEPTH_LAYERS.gun.nearM).toBeCloseTo(0.05, 12);
    expect(DEPTH_LAYERS.gun.farM).toBeCloseTo(1.5, 12);
    expect(DEPTH_LAYERS.world.nearM).toBeCloseTo(0.1, 12);
    expect(DEPTH_LAYERS.world.farM).toBeCloseTo(100000, 6);
    expect(DEPTH_LAYERS.gun.depthMax).toBeLessThan(DEPTH_LAYERS.world.depthMin);
    expect(CAMERA.eyeAboveOriginStandM).toBeCloseTo(0.69, 12);
    expect(CAMERA.eyeAboveOriginCrouchM).toBeCloseTo(0.35, 12);
  });
});

describe("fog", () => {
  it("exp fog with density * 0.0005 per D3D unit (1 D3D unit = 1000 IGI units)", () => {
    expect(fogDensityPerMetre(1.89)).toBeCloseTo(0.00387072, 8);
    expect(fogFactor(1.89, 100)).toBeCloseTo(Math.exp(-0.387072), 6);
    expect(fogFactor(1.89, 0)).toBe(1);
  });

  it("terrain multi-pass fog differs from a single mix when fog and lightmap meet", () => {
    expect(terrainFoggedColour(0.8, 0.5, 0.6, 1)).toBeCloseTo(0.4, 12);
    expect(terrainFoggedColour(0.8, 0.5, 0.6, 0)).toBeCloseTo(0.6, 12);
    expect(terrainFoggedColour(1, 0.5, 0.6, 0.5)).toBeCloseTo(0.6, 12); // a single mix would give 0.55
  });
});

describe("sky dome", () => {
  const dome = buildSkyDome(LEVEL1_SKY);

  it("has the original vertex and index counts (0x141, 0x744)", () => {
    expect(dome.positions.length / 3).toBe(321);
    expect(dome.indices.length).toBe(1860);
    expect(Math.max(...dome.indices)).toBe(320);
  });

  it("reproduces the level-1 ring colours of tools/igi_render_params.py", () => {
    expect(hex(dome.colours, 0)).toBe(LEVEL1_RINGS[0]);
    for (let ring = 0; ring < 15; ring++) {
      expect(hex(dome.colours, 1 + ring * 20 + 10)).toBe(LEVEL1_RINGS[ring + 1]);
      expect(hex(dome.colours, 1 + ring * 20)).toBe(LEVEL1_RINGS[ring + 1]);
    }
  });

  it("puts a skirt ring at z = -0.5 R with the horizon colour", () => {
    for (let j = 0; j < 20; j++) {
      expect(dome.positions[(301 + j) * 3 + 2]).toBeCloseTo(-0.5, 9);
      expect(hex(dome.colours, 301 + j)).toBe(hex(dome.colours, 281 + j));
    }
  });

  it("uses colour 1 toward the sun and colour 2 away from it", () => {
    const sky = { ...LEVEL1_SKY, snapColours: false, middle2: [0, 0, 0] as [number, number, number], bottom2: [0, 0, 0] as [number, number, number] };
    const d = buildSkyDome(sky);
    const horizon = 1 + 14 * 20;
    expect(hex(d.colours, horizon + 10)).toBe("b59c84"); // azimuth 180 in dome space: colour 1
    expect(hex(d.colours, horizon)).toBe("000000"); // azimuth 0: colour 2
    // Dome azimuth 180 deg rotated by the yaw lands on the sun azimuth.
    for (const [x, y] of [[1, 0], [0, 1], [-0.6, 0.8], [0.3, -0.95]]) {
      const yaw = skyDomeYawRad(x, y);
      const a = Math.PI + yaw;
      expect(Math.cos(a)).toBeCloseTo(x / Math.hypot(x, y), 9);
      expect(Math.sin(a)).toBeCloseTo(y / Math.hypot(x, y), 9);
    }
  });

  it("converts colours like igi.exe (float32 store and fistp, both truncating in chop mode)", () => {
    expect(colourByte(1)).toBe(255);
    expect(colourByte(Math.fround(0.2))).toBe(51); // 0.2000000030 * 255 = 51.0000008
    expect(colourByte(0.2)).toBe(50); // the double 0.2 chops to float32 0.19999999 first: 50.99999
    expect(colourByte(0.5)).toBe(127);
    expect(colourByte(1.5)).toBe(255);
  });
});

describe("cloud layers", () => {
  it("fade from alpha 1 at 5.93 m depth to 0 at Distance", () => {
    const s = cloudFadeStartM(LEVEL1_SKY);
    expect(s).toBeCloseTo(5.92746, 4);
    expect(cloudLayerAlpha(1, LEVEL1_SKY)).toBe(1);
    expect(cloudLayerAlpha(s + 1e-9, LEVEL1_SKY)).toBeCloseTo(0.999, 6);
    expect(cloudLayerAlpha(100, LEVEL1_SKY)).toBe(0);
    expect(cloudLayerAlpha(500, LEVEL1_SKY)).toBe(0);
    expect(cloudLayerAlpha(20, LEVEL1_SKY)).toBeLessThan(cloudLayerAlpha(10, LEVEL1_SKY));
    expect(cloudLayerAlpha(10, LEVEL1_SKY, 0.5)).toBeCloseTo(cloudLayerAlpha(10, LEVEL1_SKY) * 0.5, 12);
  });

  it("maps the camera-relative plane point to texture space", () => {
    const layer = { texturePath: null, scale: 1e-5, speedPerTick: [0, 0] as [number, number], alpha: 1, colour: [1, 1, 1] as [number, number, number] };
    // Straight up: the plane point is the camera's own xy.
    expect(cloudUv([0, 0, 1], LEVEL1_SKY, layer, [0.25, 0.5])).toEqual([0.25, 0.5]);
    // 45 deg toward +x: 4 m along x -> 16384 IGI * 1e-5.
    const [u] = cloudUv([1, 0, 1], LEVEL1_SKY, layer, [0, 0]);
    expect(u).toBeCloseTo(0.16384, 9);
  });
});

describe("model LOD", () => {
  it("relative rule: finest near, coarser with distance and zoom-out, culled beyond the cutoff", () => {
    const faces = [1000, 500, 250];
    const args = [65, 2450, 0.25, 15] as const;
    expect(selectLodRelative(5, 10, faces, ...args)).toBe(0);
    // r' = 0.75 * 15 + 0.25 * 10 = 13.75 m; LOD 1 from depth r' + 1.3 r' = 31.625 m.
    expect(selectLodRelative(31.5, 10, faces, ...args)).toBe(0);
    expect(selectLodRelative(31.8, 10, faces, ...args)).toBe(1);
    // LOD 2 from r' + 1.3 r' (1000/500)^2.
    expect(selectLodRelative(13.75 + 1.3 * 13.75 * 4 + 0.1, 10, faces, ...args)).toBe(2);
    expect(selectLodRelative(13.75 + 49 * 13.75 + 1, 10, faces, ...args)).toBe(-1);
    // Zooming in (smaller tan) keeps the finer level.
    expect(selectLodRelative(31.8, 10, faces, ...args, 0.5)).toBe(0);
  });

  it("explicit lod.qvm distances", () => {
    const d = [7, 17, 30, 35, 50];
    expect(selectLodExplicit(5, 1, d, 4)).toBe(0);
    expect(selectLodExplicit(10, 1, d, 4)).toBe(1);
    expect(selectLodExplicit(40, 1, d, 4)).toBe(3);
    expect(selectLodExplicit(60, 1, d, 4)).toBe(-1);
    expect(selectLodExplicit(5, 1, [0, 5, 10, 10, 20], 3)).toBe(1);
  });
});

describe("effects and states", () => {
  it("muzzle flash flickers on alternate frames while firing", () => {
    expect(muzzleFlashVisible(10, 10, 10)).toBe(true);
    expect(muzzleFlashVisible(11, 10, 10)).toBe(false);
    expect(muzzleFlashVisible(12, 12, 10)).toBe(true);
    expect(muzzleFlashVisible(13, 11, 10)).toBe(false);
    expect(MUZZLE_FLASH.models).toContain("1005_01_1");
  });

  it("blob shadow and state tables", () => {
    expect(BLOB_SHADOW.halfSizeM).toBeCloseTo(0.45, 12);
    expect(BLOB_SHADOW.intensity(0)).toBeCloseTo(0.8, 12);
    expect(BLOB_SHADOW.intensity(900)).toBeCloseTo(0.3, 12);
    expect(DRAW_STATES.objectAdditive.blend).toEqual({ src: "ONE", dst: "ONE" });
    expect(DRAW_STATES.skyDome.zTest).toBe(false);
    expect(DRAW_STATES.cloudLayer.fog).toBe("none");
  });

  it("decodes a LOOP v2 bitmap", () => {
    const buf = new ArrayBuffer(0x18 + 2 * 2 * 1);
    const v = new DataView(buf);
    new Uint8Array(buf).set([0x4c, 0x4f, 0x4f, 0x50]);
    v.setUint32(4, 2, true);
    v.setUint16(0x10, 4, true);
    v.setUint16(0x12, 2, true);
    v.setUint16(0x14, 1, true);
    v.setUint16(0x16, 2, true);
    v.setUint16(0x18, 0xfc00, true); // opaque red
    v.setUint16(0x1a, 0x001f, true); // transparent blue
    const t = decodeLoopV2Tex(buf);
    expect(Array.from(t.rgba)).toEqual([255, 0, 0, 255, 0, 0, 255, 0]);
    expect(() => decodeLoopV2Tex(new ArrayBuffer(8))).toThrow();
  });
});

const haveLevel = existsSync(`${RAW_ROOT}/missions/location0/level1/objects.qvm`);

describe.skipIf(!haveLevel)("level-1 data (staged)", () => {
  let tasks: IgiTask[];
  beforeAll(async () => {
    tasks = flattenTasks(readTaskTree(readQvmCallTree(await readRaw("missions/location0/level1/objects.qvm"))));
  });

  it("reads FlatSky and its layers", () => {
    const sky = readFlatSky(tasks);
    expect(sky).not.toBeNull();
    expect(sky?.zPosM).toBe(4);
    expect(sky?.distanceM).toBe(100);
    expect(sky?.snapColours).toBe(true);
    const dome = buildSkyDome(sky as FlatSkyParams);
    expect(hex(dome.colours, 1 + 13 * 20)).toBe("b59c84");
    const layers = readSkyLayers(tasks);
    expect(layers).toHaveLength(2);
    expect(layers[0].texturePath).toBe("missions/location0/common/textures/sky_layer1.tex");
    expect(layers[0].speedPerTick[0]).toBeCloseTo(0.00031, 9);
  });

  it("uses the earliest light keyframe at time 0 and reads fog", () => {
    const light = readGlobalLight(tasks, 0);
    expect(light?.time).toBe(12);
    expect(light?.terrain.fogDensity).toBeCloseTo(1.89, 6);
    expect(light?.objects.fogPerMetre).toBeCloseTo(0.00387072, 7);
    expect(light?.terrain.fogColour[0]).toBeCloseTo(0.576923, 5);
    // Interpolation half-way between the Time 12 and Time 100 keyframes.
    expect(readGlobalLight(tasks, 56)?.terrain.fogDensity).toBeCloseTo(0.945, 5);
  });

  it("reads MipMapControl and LODSettings", () => {
    expect(readMipMapControl(tasks)?.lodBias).toBeCloseTo(-0.4, 6);
    const lod = readLodSettings(tasks);
    expect(lod?.firstSwitch.rigid).toBe(65);
    expect(lod?.cutoff.bone).toBe(1600);
    expect(lod?.idealRadiusM).toBe(15);
  });

  it("decodes the flare and shadow LOOP v2 bitmaps and shadow1.tex", async () => {
    for (const n of ["flare00", "flare06", "shadow00", "shadow01"]) {
      const t = decodeLoopV2Tex(await readRaw(`common/textures/${n}.tex`));
      expect([t.width, t.height]).toEqual([64, 64]);
    }
    const shadow = decodeLoopV2Tex(await readRaw("common/textures/shadow00.tex"));
    expect(Array.from(shadow.rgba.subarray((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 4))).toEqual([255, 255, 255, 255]);
    const members = readIlffMembers(await readRaw("common/textures/textures.res"));
    const shadow1 = members.find((m) => m.name.endsWith("shadow1.tex"));
    expect(shadow1).toBeDefined();
    const s1 = decodeTex(shadow1!.payload);
    let maxA = 0;
    let maxRgb = 0;
    for (let i = 0; i < s1.width * s1.height; i++) {
      maxA = Math.max(maxA, s1.rgba[i * 4 + 3]);
      maxRgb = Math.max(maxRgb, s1.rgba[i * 4], s1.rgba[i * 4 + 1], s1.rgba[i * 4 + 2]);
    }
    expect([s1.width, s1.height, maxA, maxRgb]).toEqual([32, 32, 199, 0]);
    const cloud = decodeTex(await readRaw("missions/location0/common/textures/sky_layer1.tex"));
    expect([cloud.width, cloud.height]).toEqual([64, 64]);
  });
});

const haveMaterial = existsSync(`${RAW_ROOT}/material/material.qvm`);
describe.skipIf(!haveMaterial)("material.qvm impact decals (staged)", () => {
  it("lists per-material decal textures", async () => {
    const mats = readImpactMaterials(readQvmCallTree(await readRaw("material/material.qvm")));
    const concrete = mats.find((m) => m.name === "Concrete");
    expect(concrete?.effects[0].decalTextures).toEqual(["bullethole_concrete.tex", "dent_concrete.tex"]);
    expect(concrete?.effects[0].size).toBeCloseTo(0.05, 6);
    expect(mats.find((m) => m.name === "Glass")?.effects[0].decalTextures[0]).toBe("hole_plexi1.tex");
  });
});

const haveLod = existsSync(`${RAW_ROOT}/lod.qvm`);
describe.skipIf(!haveLod)("lod.qvm (staged)", () => {
  it("reads per-model LOD distances", async () => {
    const table = readModelLodTable(flattenTasks(readTaskTree(readQvmCallTree(await readRaw("lod.qvm")))));
    expect(table.get("300_02_1")).toEqual([7, 18, 30, 35, 50]);
  });
});
