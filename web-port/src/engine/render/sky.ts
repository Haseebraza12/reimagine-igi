/**
 * Sky dome.
 *
 * IGI levels carry two sky layers (bottom->top). We render the top layer on a
 * large inward-facing sphere with an unlit material so it reads as distant sky
 * and blends with the fog colour at the horizon. If no sky texture is available
 * the scene's background colour (set in renderer.ts) stands in.
 *
 * Confidence: recovered (two-layer sky from the manifest); the single-dome
 * reproduction is an inferred approximation of the original sky rendering.
 */
import * as THREE from "three";

export function buildSky(skyTexture: THREE.Texture | null): THREE.Mesh | null {
  if (!skyTexture) return null;
  const geometry = new THREE.SphereGeometry(900, 32, 16);
  const material = new THREE.MeshBasicMaterial({
    map: skyTexture,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const dome = new THREE.Mesh(geometry, material);
  dome.name = "sky";
  return dome;
}
