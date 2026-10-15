# Loader API (integration boundary)

The web port decodes the **original game files at runtime**; there is no
conversion step. `web-port/src/loaders/` reads the formats, and
`web-port/src/engine/` consumes only `src/contracts.ts` plus
`src/loaders/index.ts`.

## Asset source

```ts
interface IAssetSource {
  exists(path: string): Promise<boolean>;
  readBinary(path: string): Promise<ArrayBuffer>; // forward slashes, no leading slash
}
createHttpAssetSource(baseUrl = "/raw/"): IAssetSource;   // browser (HEAD for exists)
createFsAssetSource(rootDir): IAssetSource;              // Node/tests: import "src/loaders/fs-source"
```

`/raw/` is served from `web-port/game-data/` by the Vite dev and preview
servers (`vite.config.ts`), filled from your installation by `npm run stage`
(`web-port/scripts/stage-raw.mjs`; set `IGI_GAME_DIR` to point elsewhere).
Paths mirror the installation (`missions/location0/level1/...`). The folder is
gitignored and deliberately not under `public/`, so `vite build` never copies
game files into `dist/`. A static deployment must serve your files at `/raw/`
itself.

## Whole level

```ts
loadIgiLevel(raw: IAssetSource, paths = LEVEL1_PATHS): Promise<IgiLevel>
decodeLevelTexture(level, textureKey): DecodedTexture
```

`IgiLevel` (engine space: metres, y up, −z = IGI north; see
`loaders/coords.ts`):

| Field | Content |
|---|---|
| `name`, `description` | From `language/english/missions.res` ("Trainyard") |
| `origin` | IGI position mapped to engine (0, 0, 0): player x/y, base ground z |
| `models` | `LevelModel` geometry per used model (positions, normals, uv, CCW indices, groups with texture keys) |
| `instances` | Every placed model incl. ATTA sub-models and spline segments, with a column-major 4×4 matrix |
| `terrain` | Collision mesh (`detail`), textured render meshes (`detailRender`, `farRender`), light colours, and the `TerrainOctree` for height queries |
| `textures` | Raw `.tex` payloads by key `"<archive>:<name>"` |
| `lightmaps` | Decoded baked object lightmaps by `.olm` name; `instances[i].lightmap` names the one an instance uses (null = vertex-lit) |
| `objectLight` | Vertex-lit path inputs: sun direction (engine axes), front colour, object ambient |
| `viewModels` | Per carried weapon id: the gun model and its attached parts, in gun-local space |
| `player` | Spawn position (feet), yaw, weapon ids, ammo pools |
| `soldiers` | Position, yaw, team, AI type, weapon id, `view` (AI-script view length/angles) and `combat` (`settings.qvm` fields at `difficulty`) |
| `difficulty` | `GOGameDiff` from `config.qvm` (`"GD_2"`) |
| `objectives`, `messages` | Text plus engine-space trigger boxes (`AreaActivate`) |
| `environment` | Sky/fog/ambient/sun colours, sun direction, cloud layer |
| `weapons` | `LevelWeapon` per `WEAPON_ID_*` from `weaponconfig.qvm` |
| `sounds` | Decoded PCM for the weapons in use |
| `warnings` | Non-fatal decoding notes (e.g. message conditions ignored) |

## Format readers

| Function | File | Notes |
|---|---|---|
| `readIlffMembers(buf)` | `.res` | ILFF/IRES members with virtual names |
| `decodeTex(buf)` / `decodeTexLayers(buf)` | `.tex` v11 / v9 | RGBA8888, rows top-down |
| `readQvmCallTree(buf)` / `readQvmFile(buf)` | `.qvm` | Call trees; throws on unknown opcodes |
| `readQvmLiteralCalls(buf, names)` | executable `.qvm` (AI scripts) | Single-literal arguments of the named calls; each call site's layout is validated |
| `readTaskTree(calls)` / `flattenTasks(tasks)` | `objects.qvm` | Schema-decoded `IgiTask` tree |
| `readMef(buf)` | `.mef` | IGI model space; CCW indices; attachments; collision meshes |
| `readMtp(buf)` | `.mtp` | Model → texture names |
| `decodeIlsf(buf)` | `.wav` (ILSF PCM) | Float samples |
| `decodeOlm(buf)` | `.olm` | Baked object lightmap as RGBA8888 (alpha 255) |
| `new TerrainOctree(ctr, cmd, hmp?, heightMaps?)` | terrain | `mesh()`, `cells()`, `ringCells()`, `heightsAt()` in IGI units |
| `new TerrainLook(octree, input, bit, lmp)` | terrain | `buildRenderMesh(cells)`: layers, UVs, lightmap values |

Every reader validates sizes and offsets and throws an `Error` naming the
file offset instead of returning partial or guessed data.

## Engine rules

- Import only `src/contracts.ts` and `src/loaders/index.ts` from the engine.
- Without staged files the game shows instructions for `npm run stage`; it
  never substitutes invented content.
- Gameplay values that are not recovered (movement speeds, AI behaviour,
  damage scaling) are marked "inferred" where they are defined.
