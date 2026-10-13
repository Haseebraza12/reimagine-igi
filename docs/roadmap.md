# Desktop browser implementation roadmap

The desired result is one original-looking mission that runs locally in a
desktop browser, followed by broader compatibility. The supplied directory
contains only `missions/location0/level1`; other missions will require their
reference data. There is no honest fixed timeline until the asset and world
formats are understood.

## 1. Recover an asset pipeline

Current: file hashes, complete resource-member index, script symbol tables,
PE triage, and experimental first-level texture previews.

Next: trace the resource and texture readers, recover model vertex/index/UV
layouts, materials, lightmaps, terrain and object placements. Keep every
conversion tied to source hashes and file ranges. Validate representative
objects against native rendering before treating a conversion as correct.

Acceptance: one actual textured IGI building renders in a browser with verified
dimensions, orientation, UVs, material and lighting. A textured placeholder
cube does not establish this milestone.

## 2. Reconstruct one static level

Combine terrain, placed objects, shared assets, skies and baked lighting.
Build a dependency manifest so a mission loads only the resources it uses.
Investigate object collision geometry separately from visible geometry.

Acceptance: freely inspect the first mission and compare fixed camera views
with the original. Record unresolved visual differences.

## 3. Add player movement and collision

Trace player initialization and movement, input state, camera and collision.
Recover candidate constants from QVM calls but establish their units and
meaning in the native host functions. Measure walking, running, crouching,
jumping, slopes and camera motion in the original.

Acceptance: replay fixed input sequences and compare displacement and camera
angles at multiple frame rates. Use a fixed simulation timestep as an initial
implementation choice, then validate it against the reference behavior.

## 4. Make one mission playable

Recover one weapon, ammo/reload/damage rules, one enemy's perception and state
transitions, mission triggers and an objective. Add native-format animation and
browser audio only as their formats and behavior become established.

Acceptance: start the first mission, move and collide correctly, use one weapon,
encounter one functional enemy, complete an objective and reach a completion
state. Until then this is a viewer/prototype, not a playable IGI port.

## 5. Optimize with measurements

The reference data is already only about 74 MiB, so preserving graphics does
not require reducing polygon counts or texture resolution at the outset.
Browser memory and frame cost still need measurement: download size is not
decoded texture memory, and asset conversions can increase either.

Proposed starting renderer: TypeScript and Three.js with WebGL2. This is an
implementation choice, not recovered evidence. Three.js provides a
[glTF loader](https://threejs.org/docs/pages/GLTFLoader.html); evaluate GLB after
model recovery. Keep shaders simple and reproduce original baked lighting
rather than introducing a new lighting model.

Profile first, then evaluate visibility culling, original LOD behavior,
instancing, mission-based loading and audio compression. Evaluate
[KTX2](https://registry.khronos.org/KTX/specs/2.0/ktxspec.v2.html) texture storage
against image comparisons and GPU support. Lossy compression and visual fidelity
are a tradeoff; no promised download size or frame rate has been measured yet.

Use WebAssembly only if profiling justifies porting an isolated CPU subsystem.
It does not supply Windows/DirectX compatibility. The
[Emscripten portability guide](https://emscripten.org/docs/porting/guidelines/portability_guidelines.html)
describes source-porting constraints; it is not an EXE conversion workflow.

## Evidence discipline

Each subsystem should have a source-bound finding, a behavior specification,
an implementation and a reference comparison. Record observed, recovered and
inferred claims separately. Unknowns remain unknown until tested.

Keep game binaries and converted assets local. A potential release can load
player-selected local files, or use assets with redistribution arrangements.
Hosting and release packaging come after a playable, validated slice exists.
