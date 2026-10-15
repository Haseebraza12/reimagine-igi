/**
 * Per-render hooks on a scene: run before Three.js builds the render lists
 * (Scene.onBeforeRender is called by WebGLRenderer.render before
 * projectObject), with the camera of that render call. Used for per-frame
 * model LOD / cutoff culling, sky and cloud placement and the muzzle-flash
 * frame rule, so they apply in the same frame without game-loop changes.
 *
 * Several modules can hook the same scene; hooks run in install order.
 */
import type * as THREE from "three";

export type SceneHook = (renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) => void;

const HOOKS = Symbol("igi.sceneHooks");

interface HookedScene extends THREE.Scene {
  [HOOKS]?: SceneHook[];
}

/** Install `hook`; returns an uninstall function. */
export function addSceneHook(scene: THREE.Scene, hook: SceneHook): () => void {
  const hooked = scene as HookedScene;
  let list = hooked[HOOKS];
  if (!list) {
    list = [];
    hooked[HOOKS] = list;
    const previous = scene.onBeforeRender;
    const hooks = list;
    scene.onBeforeRender = function (this: THREE.Scene, renderer, sceneArg, camera, target, material, group) {
      previous.call(this, renderer, sceneArg, camera, target, material, group);
      for (const h of hooks.slice()) h(renderer, sceneArg as THREE.Scene, camera);
    };
  }
  list.push(hook);
  return () => {
    const i = list.indexOf(hook);
    if (i >= 0) list.splice(i, 1);
  };
}
