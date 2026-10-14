/**
 * Build a renderable terrain mesh from a recovered heightfield.
 *
 * Geometry mapping matches the pipeline manifest and engine TerrainField:
 *   vertex (gx, gz) -> world( offsetX + gx*cellSize, heights[gz*size+gx],
 *                              offsetZ + gz*cellSize )
 * Baked lightmap intensities (if present) are folded into per-vertex colours so
 * the terrain reproduces the original's baked shading under a simple light rig.
 *
 * Confidence: geometry/UV mapping recovered; material choice (Lambert +
 * vertex-coloured lightmap) is an inferred reproduction of the baked look.
 */
import * as THREE from "three";
import type { TerrainData, Vec3 } from "../../contracts";

export function buildTerrainMesh(
  terrain: TerrainData,
  worldOffset: Vec3 = [0, 0, 0],
  texture: THREE.Texture | null = null,
): THREE.Mesh {
  const { size, cellSize, heights, lightmap } = terrain;
  const vertexCount = size * size;

  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const colors = new Float32Array(vertexCount * 3);

  for (let gz = 0; gz < size; gz++) {
    for (let gx = 0; gx < size; gx++) {
      const i = gz * size + gx;
      const h = heights[i];
      positions[i * 3] = worldOffset[0] + gx * cellSize;
      positions[i * 3 + 1] = h;
      positions[i * 3 + 2] = worldOffset[2] + gz * cellSize;

      const u = gx / (size - 1);
      const v = gz / (size - 1);
      uvs[i * 2] = u;
      uvs[i * 2 + 1] = v;

      // Lightmap as a grey vertex tint; default to full brightness when absent.
      const l = lightmap ? lightmap[i] : 1;
      colors[i * 3] = l;
      colors[i * 3 + 1] = l;
      colors[i * 3 + 2] = l;
    }
  }

  const indices: number[] = [];
  for (let gz = 0; gz < size - 1; gz++) {
    for (let gx = 0; gx < size - 1; gx++) {
      const a = gz * size + gx;
      const b = a + 1;
      const c = a + size;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  if (texture) material.map = texture;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "terrain";
  mesh.receiveShadow = false;
  return mesh;
}
