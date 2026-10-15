/**
 * Render integration (engine side of docs/rendering.md): the wiring of the
 * recovered rules into the engine - sky/cloud mapping, fog, LOD choice,
 * block kinds, terrain tiling, muzzle-flash frames, decals, blob shadows.
 * Pure logic; no WebGL needed.
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  BLOB_SHADOW,
  CAMERA,
  cloudLayerAlpha,
  cloudUv,
  fogFactor,
  selectLodExplicit,
  selectLodRelative,
  skyDomeYawRad,
  terrainFoggedColour,
  verticalFovDeg,
  type FlatSkyParams,
  type ImpactMaterial,
  type LodSettings,
  type SkyLayerParams,
} from "../src/loaders";
import { expFog, readFogParams, terrainPassesColour, createFogUniforms } from "../src/engine/render/fog";
import {
  aboveHorizonPolygon,
  cloudOffsetAfterTicks,
  cloudSample,
  engineDirToIgiAxes,
  igiDirToEngineAxes,
  skyDomeGeometry,
  skyDomeYawForEngineLight,
} from "../src/engine/render/sky";
import { DECAL_DEPTH_SCALE, OBJECT_ZBIAS_PER_METRE, zBiasPerMetre } from "../src/engine/render/object-material";
import { chooseLod, tanHalfFovX } from "../src/engine/world/lod";
import { boundingSphereOf, lodLightmapName, splitLodName } from "../src/engine/world/model-lods";
import { blockKind } from "../src/engine/world/world-builder";
import { tileTriangles } from "../src/engine/world/terrain-render";
import { FlashSequence } from "../src/engine/fx/muzzle-flash";
import { decalFor, decalMatrix, defaultImpactMaterial } from "../src/engine/fx/decals";
import { blobShadowTransform } from "../src/engine/fx/blob-shadow";
import type { IgiTask } from "../src/loaders";

/** Level-1 FlatSky / FlatSkyLayer values (objects.qvm, observed). */
const SKY: FlatSkyParams = {
  clearColour: [0.2, 0.288462, 0.4],
  zPosM: 4,
  distanceM: 100,
  fogAmount: 0.941667,
  angleDeg: 15,
  snapColours: true,
  top: [0.115385, 0.192308, 0.615385],
  middle1: [0.403846, 0.596154, 0.673077],
  middle2: [0.403846, 0.596154, 0.673077],
  bottom1: [0.711538, 0.615385, 0.519231],
  bottom2: [0.711538, 0.615385, 0.519231],
};
const LAYER: SkyLayerParams = {
  texturePath: "missions/location0/common/textures/sky_layer1.tex",
  scale: 1e-5,
  speedPerTick: [0.00031, 0.00006],
  alpha: 1,
  colour: [0.75, 0.961538, 0.980769],
};

describe("sky", () => {
  it("maps IGI axes to engine axes and back", () => {
    expect(igiDirToEngineAxes(1, 2, 3)).toEqual([1, 3, -2]);
    expect(engineDirToIgiAxes(...igiDirToEngineAxes(1, 2, 3))).toEqual([1, 2, 3]);
  });

  it("builds the 321-vertex dome in engine axes with the pole straight up", () => {
    const g = skyDomeGeometry(SKY);
    const pos = g.getAttribute("position");
    expect(pos.count).toBe(321);
    expect(g.getIndex()!.count).toBe(1860);
    expect([pos.getX(0), pos.getY(0), pos.getZ(0)].map((v) => Math.round(v) + 0)).toEqual([0, 1000, 0]);
    // Skirt ring at z = -0.5 R (IGI) -> engine y = -500.
    expect(pos.getY(301)).toBeCloseTo(-500, 3);
    const col = g.getAttribute("color");
    expect(col.normalized).toBe(true);
  });

  it("rotates the dome toward the light: engine yaw = IGI yaw", () => {
    const l: [number, number, number] = [0.18, -0.847, 0.5]; // level 1 toward-light (IGI)
    const e = igiDirToEngineAxes(...l);
    expect(skyDomeYawForEngineLight(e)).toBeCloseTo(skyDomeYawRad(l[0], l[1]), 12);
    // A dome vertex at IGI azimuth t ends at t - alpha after the rotation (render-params doc):
    const yaw = skyDomeYawRad(l[0], l[1]);
    const v = new THREE.Vector3(...igiDirToEngineAxes(1, 0, 0)).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const back = engineDirToIgiAxes(v.x, v.y, v.z);
    expect(Math.atan2(back[1], back[0])).toBeCloseTo(Math.atan2(Math.sin(yaw), Math.cos(yaw)), 9);
  });

  it("cloud fragment math equals render-params cloudUv / cloudLayerAlpha", () => {
    const forward = igiDirToEngineAxes(0, 1, 0); // looking along IGI +y, level
    for (const ray of [
      [0.2, 1, 0.3],
      [-0.5, 1, 0.05],
      [0, 0.2, 1],
    ] as Array<[number, number, number]>) {
      const s = cloudSample(igiDirToEngineAxes(...ray), forward, SKY, LAYER, [0.25, 0.5])!;
      const [u, v] = cloudUv(ray, SKY, LAYER, [0.25, 0.5]);
      expect(s.u).toBeCloseTo(u, 9);
      expect(s.v).toBeCloseTo(v, 9);
      // Camera depth of the hit = (zPos / r.z) * (r . forward) for unit forward.
      const depth = (SKY.zPosM / ray[2]) * ray[1];
      expect(s.depthM).toBeCloseTo(depth, 9);
      expect(s.alpha).toBeCloseTo(cloudLayerAlpha(depth, SKY, LAYER.alpha), 9);
    }
    // Below the horizon nothing is drawn.
    expect(cloudSample(igiDirToEngineAxes(0, 1, -0.1), forward, SKY, LAYER, [0, 0])).toBeNull();
    // Opaque near, transparent from Distance on (level 1: 100 m).
    expect(cloudSample(igiDirToEngineAxes(0, 1, 1), forward, SKY, LAYER, [0, 0])!.alpha).toBe(1);
    expect(cloudSample(igiDirToEngineAxes(0, 1, 0.03), forward, SKY, LAYER, [0, 0])!.alpha).toBe(0);
  });

  it("draws the clouds only on the screen part above the horizon", () => {
    const cam = new THREE.PerspectiveCamera(verticalFovDeg(1), 4 / 3, 0.1, 1000);
    const area = (poly: Array<[number, number]>) =>
      Math.abs(poly.reduce((s, p, i) => s + p[0] * poly[(i + 1) % poly.length][1] - poly[(i + 1) % poly.length][0] * p[1], 0)) / 2;
    const at = (pitchDeg: number) => {
      cam.rotation.set((pitchDeg * Math.PI) / 180, 0, 0);
      cam.updateMatrixWorld();
      return aboveHorizonPolygon(cam.matrixWorld, cam.projectionMatrixInverse);
    };
    expect(area(at(0))).toBeCloseTo(2, 9); // level: the upper half of the 2 x 2 NDC square
    expect(Math.min(...at(0).map((p) => p[1]))).toBeCloseTo(0, 9);
    expect(area(at(40))).toBeCloseTo(4, 9); // 40 deg up: horizon below the screen (tan 40 / 0.75 > 1)
    expect(at(-60)).toEqual([]); // looking down past the half-FOV: no sky
    // Horizon row at NDC y = -tan(pitch) / tan(half vertical FOV).
    expect(Math.min(...at(20).map((p) => p[1]))).toBeCloseTo(-Math.tan((20 * Math.PI) / 180) / 0.75, 9);
  });

  it("scrolls per 30 Hz tick, wrapped to [0, 1)", () => {
    expect(cloudOffsetAfterTicks([0.00031, 0.00006], 0)).toEqual([0, 0]);
    const [u, v] = cloudOffsetAfterTicks([0.00031, 0.00006], 30);
    expect(u).toBeCloseTo(0.0093, 9); // 0.0093 UV per second
    expect(v).toBeCloseTo(0.0018, 9);
    expect(cloudOffsetAfterTicks([0.4, 0], 5)[0]).toBeCloseTo(0, 9);
  });
});

describe("fog", () => {
  const keyframe = (time: number, density: number): IgiTask => ({
    id: time,
    type: "GlobalLightKeyframe",
    name: "",
    children: [],
    params: {
      Time: time,
      "Fog density terrain": density,
      "Fog color terrain": [0.6, 0.5, 1.2],
      "Fog density object category 1": density / 2,
      "Fog color object category 1": [0.1, 0.2, 0.3],
    },
  });

  it("uses the earliest keyframe (time of day 0) and the recovered EXP coefficient", () => {
    const p = readFogParams({ tasks: [keyframe(100, 0.5), keyframe(12, 1.89)] });
    expect(p.terrain.perMetre).toBeCloseTo(1.89 * 0.002048, 12);
    expect(p.objects.perMetre).toBeCloseTo(0.945 * 0.002048, 12);
    // Terrain fog colour clamped to [0, 1] (FUN_00508f60).
    expect(p.terrain.colour.b).toBe(1);
    expect([p.objects.colour.r, p.objects.colour.g, p.objects.colour.b]).toEqual([0.1, 0.2, 0.3].map((x) => expect.closeTo(x, 6)));
    const u = createFogUniforms(p);
    expect(u.terrainFogK.value).toBeCloseTo(p.terrain.perMetre, 12);
    expect(readFogParams({ tasks: [] }).objects.perMetre).toBe(0);
  });

  it("matches render-params fogFactor and the three-pass terrain colour", () => {
    expect(expFog(1.89 * 0.002048, 179)).toBeCloseTo(fogFactor(1.89, 179), 12);
    expect(fogFactor(1.89, 179)).toBeCloseTo(0.5, 2); // level 1: 50 % at 179 m
    for (const [l, lm, fog, f] of [
      [0.5, 0.8, 0.57, 0.3],
      [1, 0.27, 0.2, 0.9],
    ]) {
      expect(terrainPassesColour(l, lm, fog, f)).toBeCloseTo(terrainFoggedColour(l, lm, fog, f), 12);
    }
    // Not mix(fog, layers * lightmap, f):
    expect(terrainPassesColour(0.5, 0.5, 0.6, 0.5)).not.toBeCloseTo(0.6 * 0.5 + 0.25 * 0.5, 3);
  });

  it("depth nudges: ZBIAS 3 at the 0.1 m near plane, decals near x 1.01", () => {
    expect(zBiasPerMetre(3)).toBeCloseTo((3 / 2 ** 24) / 0.1, 15);
    expect(OBJECT_ZBIAS_PER_METRE).toBeCloseTo(zBiasPerMetre(3), 15);
    // z_eff = z / (1 + k z): about 4.5 mm closer at 50 m.
    const z = 50;
    expect(z - z / (1 + OBJECT_ZBIAS_PER_METRE * z)).toBeCloseTo(0.00447, 4);
    expect(DECAL_DEPTH_SCALE).toBeCloseTo(1 / 1.01, 12);
  });
});

describe("model LOD wiring", () => {
  const settings: LodSettings = {
    firstSwitch: { spline: 50, rigid: 65, bone: 65 },
    cutoff: { spline: 2450, rigid: 2450, bone: 1600 },
    radiusWeight: 0.25,
    idealRadiusM: 15,
  };

  it("player camera tan(hFOV/2) is 1 (90 x 73.74 deg, 4:3)", () => {
    expect(tanHalfFovX(verticalFovDeg(CAMERA.worldTanHalfFovX), 4 / 3)).toBeCloseTo(1, 9);
  });

  it("explicit lod.qvm distances take precedence and are clamped to the variants", () => {
    const input = { kind: "rigid" as const, faces: [26, 16, 12], radiusM: 4.55, explicit: [5, 30, 40, 50, 200] };
    expect(chooseLod(input, 3, 1, settings)).toBe(0);
    expect(chooseLod(input, 20, 1, settings)).toBe(selectLodExplicit(20, 4.55, input.explicit, 3));
    expect(chooseLod(input, 60, 1, settings)).toBe(2); // LOD index capped at the last variant
    expect(chooseLod(input, 210, 1, settings)).toBe(-1); // beyond the cutoff
    // Single-variant model with a table entry: drawn until the cutoff.
    const one = { kind: "rigid" as const, faces: [12], radiusM: 0.52, explicit: [10, 10, 17, 20, 40] };
    expect(chooseLod(one, 30, 1, settings)).toBe(0);
    expect(chooseLod(one, 41, 1, settings)).toBe(-1);
  });

  it("relative rule per kind, culled past the cutoff", () => {
    const rigid = { kind: "rigid" as const, faces: [1000, 500], radiusM: 10, explicit: null };
    expect(chooseLod(rigid, 31, 1, settings)).toBe(0);
    expect(chooseLod(rigid, 32, 1, settings)).toBe(selectLodRelative(32, 10, [1000, 500], 65, 2450, 0.25, 15));
    expect(chooseLod(rigid, 32, 1, settings)).toBe(1);
    // 10 m radius: culled beyond r' + 49 r' = 687.5 m.
    expect(chooseLod(rigid, 680, 1, settings)).toBe(1);
    expect(chooseLod(rigid, 700, 1, settings)).toBe(-1);
    // Zoom (smaller tan) keeps it.
    expect(chooseLod(rigid, 700, 0.5, settings)).toBe(1);
    const spline = { kind: "spline" as const, faces: [100], radiusM: 65, explicit: null };
    expect(chooseLod(spline, 1300, 1, settings)).toBe(0);
    expect(chooseLod(spline, 1400, 1, settings)).toBe(-1); // r' = 27.5, cutoff 49 r' + r' = 1375 m
    expect(chooseLod(rigid, 5000, 1, null)).toBe(0); // no LODSettings task: always LOD 0
    expect(chooseLod({ kind: "rigid", faces: [], radiusM: 1, explicit: null }, 1, 1, settings)).toBe(-1);
  });

  it("names LOD variants and their consecutive .olm lightmaps", () => {
    expect(splitLodName("438_01_1")).toEqual(["438_01", 1]);
    expect(splitLodName("spline")).toBeNull();
    expect(lodLightmapName("obj00014_00003", 0)).toBe("obj00014_00003");
    expect(lodLightmapName("obj00014_00003", 2)).toBe("obj00014_00005");
    expect(lodLightmapName("bad", 1)).toBeNull();
  });

  it("bounding sphere = box centre and farthest vertex", () => {
    const s = boundingSphereOf(new Float32Array([0, 0, 0, 2, 0, 0, 0, 4, 0]));
    expect(s.centre).toEqual([1, 2, 0]);
    expect(s.radius).toBeCloseTo(Math.sqrt(5), 9);
  });

  it("block kind from the DNER flags", () => {
    expect(blockKind(undefined)).toBe("opaque");
    expect(blockKind({ deferred: false, additive: false })).toBe("opaque");
    expect(blockKind({ deferred: true, additive: false })).toBe("deferred");
    expect(blockKind({ deferred: true, additive: true })).toBe("additive");
  });
});

describe("terrain tiling", () => {
  it("splits a triangle soup by centroid without losing or reordering corners", () => {
    const tri = (x: number, z: number) => [x, 0, z, x + 1, 0, z, x, 0, z + 1];
    const positions = new Float32Array([...tri(1, 1), ...tri(300, 1), ...tri(2, 2)]);
    const mesh = {
      positions,
      uv: new Float32Array(18).map((_, i) => i),
      layers: new Uint8Array(27).map((_, i) => i),
      light: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    };
    const tiles = tileTriangles(mesh, 256);
    expect(tiles).toHaveLength(2);
    const total = tiles.reduce((n, t) => n + t.positions.length / 9, 0);
    expect(total).toBe(3);
    const first = tiles.find((t) => t.positions.length === 18)!;
    expect(Array.from(first.light)).toEqual([1, 2, 3, 7, 8, 9]);
    expect(Array.from(first.uv.subarray(6, 12))).toEqual([12, 13, 14, 15, 16, 17]);
  });
});

describe("effects", () => {
  it("muzzle flash: one frame per isolated shot, alternate frames while firing, cumulative 0/4/7 deg roll", () => {
    const rolls = [0.5, 0.9, 0.1, 0.5];
    let i = 0;
    const seq = new FlashSequence(() => rolls[i++ % rolls.length]);
    expect(seq.step()).toBe(false); // nothing fired
    seq.fire();
    expect(seq.step()).toBe(true); // frame after the shot
    // Degrees x f32 0.017453292 (0x531684), as FUN_00476000 converts them.
    const DEG = Math.fround(0.01745329238474369);
    expect(seq.roll).toBeCloseTo(4 * DEG, 12);
    expect(seq.step()).toBe(false); // odd frame of the sequence
    expect(seq.step()).toBe(false); // shot too old: sequence over
    // Continuous fire (a shot every frame): shown on every other frame.
    const shown: boolean[] = [];
    for (let k = 0; k < 6; k++) {
      seq.fire();
      shown.push(seq.step());
    }
    expect(shown).toEqual([true, false, true, false, true, false]);
    // The random roll is drawn on shown frames only: 4 (first shot), then 7, 0, 4.
    expect(seq.roll).toBeCloseTo((4 + 7 + 0 + 4) * DEG, 12);
  });

  const materials: ImpactMaterial[] = [
    {
      index: 11,
      name: "Concrete",
      effects: [
        { effectTask: "TASKTYPE_GUNSHOTEFFECT", flagA: true, flagB: true, decalTextures: ["bullethole_concrete.tex", "dent_concrete.tex"], size: 0.05, model: "1012_01_1" },
        { effectTask: "TASKTYPE_GUNSHOTEFFECT", flagA: false, flagB: false, decalTextures: ["bullethole_concrete.tex", "bullethole_concrete.tex"], size: 0.06, model: "1012_01_1" },
      ],
    },
    {
      index: 0,
      name: "Air",
      effects: [
        { effectTask: "TASKTYPE_GUNSHOTEFFECT", flagA: true, flagB: true, decalTextures: ["", ""], size: 0.03, model: "1009_01_1" },
        { effectTask: "TASKTYPE_GUNSHOTEFFECT", flagA: false, flagB: false, decalTextures: ["", ""], size: 0.03, model: "1009_01_1" },
      ],
    },
  ];

  it("decal per material from material.qvm", () => {
    expect(decalFor(materials, "Concrete")).toEqual({ textures: ["bullethole_concrete.tex", "dent_concrete.tex"], halfSizeM: 0.05 });
    expect(decalFor(materials, "concrete")?.halfSizeM).toBe(0.05);
    expect(decalFor(materials, "Air")).toBeNull();
    expect(decalFor(materials, "Unknown")).toBeNull();
    expect(defaultImpactMaterial([0, 1, 0])).toBe("Ground");
    expect(defaultImpactMaterial([1, 0, 0])).toBe("Concrete");
  });

  it("decal quad lies on the hit plane, sized 2 x half-size", () => {
    const m = decalMatrix([1, 2, 3], [1, 0, 0], 0.05, 0.7);
    const corner = new THREE.Vector3(0.5, 0.5, 0).applyMatrix4(m);
    expect(corner.x).toBeCloseTo(1, 9); // on the plane x = 1
    expect(corner.distanceTo(new THREE.Vector3(1, 2, 3))).toBeCloseTo(Math.SQRT2 * 0.05, 9);
    const n = new THREE.Vector3(0, 0, 1).transformDirection(m);
    expect(n.x).toBeCloseTo(1, 9);
  });

  it("blob shadow: 0.45 m half-size, lifted 10 IGI units along the ground normal, grey 0.9 x intensity", () => {
    const { matrix, grey } = blobShadowTransform([0, 5, 0], [0, 1, 0], 1);
    const centre = new THREE.Vector3().setFromMatrixPosition(matrix);
    expect(centre.y).toBeCloseTo(5 + 10 / 4096, 9);
    const corner = new THREE.Vector3(0.5, 0.5, 0).applyMatrix4(matrix);
    expect(Math.abs(corner.x)).toBeCloseTo(0.45, 9);
    expect(corner.y).toBeCloseTo(5 + 10 / 4096, 9); // flat on the ground
    expect(grey).toBeCloseTo(0.9 * BLOB_SHADOW.intensity(1), 12);
  });
});
