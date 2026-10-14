/**
 * Three.js renderer/scene/camera setup.
 *
 * Confidence: implementation choice (docs/roadmap Phase 5 nominates Three.js +
 * WebGL2). Reproducing IGI's baked lighting is the goal; we deliberately keep a
 * simple light rig (ambient + hemisphere + one sun) rather than inventing a new
 * physically-based model.
 */
import * as THREE from "three";

export interface RendererBundle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Re-sync renderer size + camera aspect to the current canvas client size. */
  resize(): void;
  dispose(): void;
}

/** Day-sky clear colour, also used as the fog colour for distance blending. */
export const SKY_COLOR = 0x9fb6cc;

export function createRenderer(canvas: HTMLCanvasElement): RendererBundle {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = false; // baked lightmaps, not real-time shadows

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY_COLOR);
  // Exponential fog fades distant terrain into the sky for scale + perf.
  scene.fog = new THREE.Fog(SKY_COLOR, 220, 640);

  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 2000);
  camera.position.set(0, 40, 0);

  // Simple light rig; baked vertex lightmaps carry most of the shading.
  const hemisphere = new THREE.HemisphereLight(0xcfe8ff, 0x4a4032, 0.9);
  scene.add(hemisphere);
  const sun = new THREE.DirectionalLight(0xfff2d8, 1.1);
  sun.position.set(120, 200, 80);
  scene.add(sun);
  const ambient = new THREE.AmbientLight(0xffffff, 0.25);
  scene.add(ambient);

  const resize = () => {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  };
  resize();

  return {
    renderer,
    scene,
    camera,
    resize,
    dispose() {
      renderer.dispose();
    },
  };
}
