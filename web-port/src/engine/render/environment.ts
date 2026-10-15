/**
 * Sky, clouds, fog and lights of the level, as igi.exe draws them
 * (docs/rendering.md sections 3-4; sky.ts and fog.ts hold the details):
 *
 *   - Clear colour = FlatSky "Fog Color" (FUN_00518670 -> Clear) [recovered]:
 *     scene.background, which Three clears inside the 4:3 frame.
 *   - Sky dome (render-params buildSkyDome) drawn first, then every
 *     FlatSkyLayer in task order, both unfogged and without depth.
 *   - Cloud scroll advances per 30 Hz game TICK (ctx.tick), not per frame.
 *   - Fog: exponential; terrain fog (view depth) is applied by
 *     terrain-render.ts, object fog (radial) by the object/decal materials and,
 *     for built-in Three materials, through scene.fog = FogExp2 with the
 *     patched EXP chunks (fog.ts). Shared uniforms: `fog`.
 *   - Lights: an AmbientLight + DirectionalLight for built-in Lambert/Phong
 *     materials other modules create (characters); colours from the level's
 *     object lighting (GlobalLight ambient, DirlightKeyframe front colour).
 *     Placed models do not use these: their lighting is baked per vertex or
 *     lightmapped (world-builder.ts), exactly as the original.
 */
import * as THREE from "three";
import type { DecodedTexture } from "../../contracts";
import type { IgiLevel } from "../../loaders";
import { readFlatSky, readSkyLayers } from "../../loaders";
import {
  createFogUniforms,
  installObjectFogChunks,
  objectSceneFog,
  readFogParams,
  setSharedFogUniforms,
  type FogUniforms,
} from "./fog";
import { addSceneHook } from "./scene-hooks";
import { cloudOffsetAfterTicks, cloudTexture, createCloudLayer, createSkyDome, type CloudLayer } from "./sky";

export interface Environment {
  sun: THREE.DirectionalLight;
  ambient: THREE.AmbientLight;
  sky: THREE.Object3D;
  /** Shared fog uniforms (terrain and object categories). */
  fog: FogUniforms;
  /** Per-frame update: cloud scroll from the game tick count. Placement follows the camera automatically. */
  update(dt: number, camera: THREE.Camera): void;
  dispose(): void;
}

export interface EnvironmentOptions {
  /** Decoded FlatSkyLayer textures by "Texture File Name" path. */
  cloudTextures: Map<string, DecodedTexture>;
  /** Game ticks so far (30 Hz); cloud offsets = speed x ticks, wrapped. */
  ticks: () => number;
}

const color = (v: readonly [number, number, number]) => new THREE.Color().setRGB(v[0], v[1], v[2]);

export function applyEnvironment(scene: THREE.Scene, level: IgiLevel, options: EnvironmentOptions): Environment {
  const flatSky = readFlatSky(level.tasks);
  const layers = readSkyLayers(level.tasks);
  const fogParams = readFogParams(level);
  const fog = createFogUniforms(fogParams);
  setSharedFogUniforms(fog);

  // Clear colour (FlatSky "Fog Color"); without a FlatSky task use the fog colour.
  scene.background = flatSky ? color(flatSky.clearColour) : fogParams.objects.colour.clone();
  installObjectFogChunks();
  scene.fog = objectSceneFog(fogParams);

  // Lights for built-in materials only (see header). Lambert divides by pi.
  const light = level.objectLight;
  const ambient = new THREE.AmbientLight(color(light.ambient), Math.PI);
  const sun = new THREE.DirectionalLight(color(light.front), Math.PI);
  sun.position.set(light.sunDirection[0], light.sunDirection[1], light.sunDirection[2]).multiplyScalar(1000);
  sun.target.position.set(0, 0, 0);
  scene.add(ambient, sun, sun.target);

  const sky = new THREE.Group();
  sky.name = "sky";
  const disposables: Array<{ dispose(): void }> = [];
  const clouds: Array<{ layer: CloudLayer; speed: readonly [number, number] }> = [];
  if (flatSky) {
    const dome = createSkyDome(flatSky, light.sunDirection);
    // Centred on the camera of each render (the dome has no parallax).
    const yaw = dome.rotation.y;
    dome.matrixAutoUpdate = false;
    dome.matrixWorldAutoUpdate = false;
    const rotation = new THREE.Matrix4().makeRotationY(yaw);
    const position = new THREE.Vector3();
    dome.onBeforeRender = (_r, _s, camera) => {
      position.setFromMatrixPosition(camera.matrixWorld);
      dome.matrixWorld.copy(rotation).setPosition(position);
    };
    sky.add(dome);
    disposables.push(dome.geometry, dome.material as THREE.Material);

    const gpuTextures = new Map<string, THREE.DataTexture>();
    layers.forEach((layer, i) => {
      const decoded = layer.texturePath ? options.cloudTextures.get(layer.texturePath) : undefined;
      if (!layer.texturePath || !decoded) return;
      let texture = gpuTextures.get(layer.texturePath);
      if (!texture) {
        texture = cloudTexture(decoded);
        gpuTextures.set(layer.texturePath, texture);
        disposables.push(texture);
      }
      const cloud = createCloudLayer(flatSky, layer, texture, i);
      sky.add(cloud.mesh);
      disposables.push(cloud);
      clouds.push({ layer: cloud, speed: layer.speedPerTick });
    });
  }
  scene.add(sky);
  // Fit the cloud passes to the screen above the horizon of each render's camera.
  const removeHook = addSceneHook(scene, (_r, _s, camera) => {
    for (const c of clouds) c.layer.prepare(camera);
  });

  const updateClouds = () => {
    const ticks = options.ticks();
    for (const c of clouds) {
      const [u, v] = cloudOffsetAfterTicks(c.speed, ticks);
      c.layer.setOffset(u, v);
    }
  };
  updateClouds();

  return {
    sun,
    ambient,
    sky,
    fog,
    update() {
      updateClouds();
    },
    dispose() {
      removeHook();
      scene.remove(ambient, sun, sun.target, sky);
      scene.fog = null;
      for (const d of disposables) d.dispose();
    },
  };
}
