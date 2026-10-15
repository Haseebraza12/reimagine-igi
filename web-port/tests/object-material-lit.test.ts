/**
 * Deferred lightmapped blocks are drawn with D3D lighting on and stage 0
 * MODULATE (FUN_0052f780 0x52f943), so they are texture x vertex light x
 * lightmap (docs/rendering.md section 5); opaque and additive blocks are not.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { NO_FOG } from "../src/engine/render/fog";
import { createObjectMaterial } from "../src/engine/render/object-material";

const base = { map: null, fog: NO_FOG, mipBias: { value: 0 } };
const lightMap = new THREE.DataTexture(new Uint8Array(4), 1, 1);

describe("object material: vertex light on deferred lightmapped blocks", () => {
  it("defines LIT_LIGHTMAPPED only for lightmapped deferred blocks that opt in", () => {
    const lit = createObjectMaterial({ ...base, lightMap, kind: "deferred", litLightmap: true });
    expect(lit.defines.LIGHTMAPPED).toBeDefined();
    expect(lit.defines.LIT_LIGHTMAPPED).toBeDefined();
    expect(lit.name).toBe("igi-object-deferred-lm-lit");
    expect(lit.fragmentShader).toContain("tex.rgb * vLight * texture( lightMap, vLmUv ).rgb");
    for (const kind of ["opaque", "additive"] as const) {
      const m = createObjectMaterial({ ...base, lightMap, kind, litLightmap: true });
      expect(m.defines.LIT_LIGHTMAPPED).toBeUndefined();
    }
    expect(createObjectMaterial({ ...base, lightMap, kind: "deferred" }).defines.LIT_LIGHTMAPPED).toBeUndefined();
    expect(createObjectMaterial({ ...base, lightMap: null, kind: "deferred", litLightmap: true }).defines.LIT_LIGHTMAPPED).toBeUndefined();
  });
});
