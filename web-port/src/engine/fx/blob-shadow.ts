/**
 * Blob shadow under each human [recovered FUN_0045d850 -> FUN_004d7960, draw
 * FUN_004d7670 as a PolyListDynCubeObj with flags 0; render-params
 * BLOB_SHADOW; docs/rendering.md section 7]:
 *   - textures.res "shadow1.tex" (32x32 black, soft alpha <= 199);
 *   - one quad of half-size 0.45 m on the ground under the human, oriented to
 *     the ground normal, lifted 10 IGI units along it;
 *   - vertex colour 0.9 * clamp(0.8 (1 - h / 1000 m), 0.3, 1), h = height of
 *     the human above the ground hit (no visible effect with the black
 *     texture [inferred]);
 *   - SRCALPHA/INVSRCALPHA, alpha test > 0, Z test without write, object fog,
 *     near plane x 1.01.
 * All shadows share one InstancedMesh (one draw call).
 */
import * as THREE from "three";
import type { DecodedTexture, Vec3 } from "../../contracts";
import { BLOB_SHADOW } from "../../loaders";
import type { FogUniforms } from "../render/fog";
import { applyObjectSampler, createDecalMaterial } from "../render/object-material";

export interface BlobShadow {
  /**
   * groundPoint: where the vertical ray under the human meets the ground
   * (engine space); groundNormal: that surface's unit normal; heightAboveGround:
   * metres from the human's origin down to groundPoint (shading only).
   */
  update(groundPoint: Vec3, groundNormal: Vec3, heightAboveGround: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

export interface BlobShadowPool {
  readonly mesh: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.Material>;
  create(): BlobShadow;
  /** Provide shadow1.tex once loaded (shadows stay hidden until then). */
  setTexture(decoded: DecodedTexture | null, fog: FogUniforms, mipBias: THREE.IUniform<number>): void;
  dispose(): void;
}

export const BLOB_SHADOW_CAPACITY = 128;

/** Instance transform and grey level of one blob shadow (pure; exported for tests). */
export function blobShadowTransform(groundPoint: Vec3, groundNormal: Vec3, heightAboveGround: number, target = new THREE.Matrix4()): { matrix: THREE.Matrix4; grey: number } {
  const n = new THREE.Vector3(groundNormal[0], groundNormal[1], groundNormal[2]);
  if (n.lengthSq() < 1e-12) n.set(0, 1, 0);
  n.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  const p = new THREE.Vector3(groundPoint[0], groundPoint[1], groundPoint[2]).addScaledVector(n, BLOB_SHADOW.liftM);
  const size = 2 * BLOB_SHADOW.halfSizeM;
  target.compose(p, q, new THREE.Vector3(size, size, 1));
  return { matrix: target, grey: BLOB_SHADOW.baseGrey * BLOB_SHADOW.intensity(heightAboveGround) };
}

export function createBlobShadowPool(): BlobShadowPool {
  const quad = new THREE.PlaneGeometry(1, 1);
  const placeholder = new THREE.MeshBasicMaterial({ visible: false });
  const mesh = new THREE.InstancedMesh<THREE.PlaneGeometry, THREE.Material>(quad, placeholder, BLOB_SHADOW_CAPACITY);
  mesh.name = "blob-shadows";
  mesh.frustumCulled = false;
  mesh.visible = false;
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  const black = new THREE.Color(0, 0, 0);
  for (let i = 0; i < BLOB_SHADOW_CAPACITY; i++) {
    mesh.setMatrixAt(i, hidden);
    mesh.setColorAt(i, black);
  }
  mesh.count = 0;
  const free: number[] = [];
  let used = 0;
  let texture: THREE.DataTexture | null = null;
  let material: THREE.ShaderMaterial | null = null;
  const colour = new THREE.Color();

  return {
    mesh,
    create() {
      const slot = free.length ? free.pop()! : used < BLOB_SHADOW_CAPACITY ? used++ : -1;
      mesh.count = Math.max(mesh.count, slot + 1);
      let visible = true;
      let last: { matrix: THREE.Matrix4; grey: number } | null = null;
      const apply = () => {
        if (slot < 0) return;
        mesh.setMatrixAt(slot, visible && last ? last.matrix : hidden);
        if (last) mesh.setColorAt(slot, colour.setScalar(last.grey));
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      };
      return {
        update(groundPoint, groundNormal, heightAboveGround) {
          last = blobShadowTransform(groundPoint, groundNormal, heightAboveGround, last?.matrix ?? new THREE.Matrix4());
          apply();
        },
        setVisible(v) {
          visible = v;
          apply();
        },
        dispose() {
          if (slot < 0) return;
          visible = false;
          apply();
          free.push(slot);
        },
      };
    },
    setTexture(decoded, fog, mipBias) {
      texture?.dispose();
      material?.dispose();
      texture = null;
      material = null;
      if (!decoded) {
        mesh.material = placeholder;
        mesh.visible = false;
        return;
      }
      texture = new THREE.DataTexture(
        new Uint8Array(decoded.rgba.buffer as ArrayBuffer, decoded.rgba.byteOffset, decoded.rgba.byteLength),
        decoded.width,
        decoded.height,
        THREE.RGBAFormat,
      );
      texture.flipY = false;
      applyObjectSampler(texture); // decal state: LINEAR, nearest mip, WRAP
      texture.needsUpdate = true;
      material = createDecalMaterial(texture, fog, mipBias);
      mesh.material = material;
      mesh.visible = true;
    },
    dispose() {
      mesh.removeFromParent();
      quad.dispose();
      placeholder.dispose();
      texture?.dispose();
      material?.dispose();
      mesh.dispose();
    },
  };
}
