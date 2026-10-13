# Measured file formats

These notes apply to the supplied installation only. They are independent
observations of bytes, with explicit limits; they are not complete engine
documentation.

## Resource containers: ILFF / IRES

All 53 `.res` files parse with the current implementation. Root fields:

| Offset | Type | Observed meaning |
| --- | --- | --- |
| 0 | four bytes | `ILFF` |
| 4 | u32 little endian | total file size, including header |
| 8 | u32 little endian | initial alignment, 4 or 32 in this corpus |
| 12 | u32 little endian | zero |
| 16 | four bytes | `IRES` |

The first child header begins at `align_up(20, root_alignment)`.
Each child header is 16 bytes:

| Relative offset | Type | Observed meaning |
| --- | --- | --- |
| 0 | four bytes | `NAME`, `BODY`, `CSTR`, or `PATH` |
| 4 | u32 little endian | payload length |
| 8 | u32 little endian | payload alignment against file origin |
| 12 | u32 little endian | next header delta from this header; zero for final child |

Payload starts at `align_up(header_offset + 16, alignment)`. `NAME` supplies a
NUL-terminated virtual name for the next `BODY`, `CSTR`, or `PATH` payload.
`PATH` records are preserved as opaque data, not treated as embedded assets.
The final payload ends at EOF; a terminal payload need not have trailing
alignment padding. `common/textures/common.res` uses 32-byte root/payload
alignment and is an important counterexample to a hard-coded 20-byte start.

Evidence: `research/resources.json` includes every measured header and payload
offset, tag, size, virtual name, and payload hash. Boundary tests use synthetic
archives; the complete real corpus also parses without errors.

## LOOP v11 textures

The first-level texture archive has 393 `.tex` payloads. All use `LOOP` with
u32 version 11 at offset 4. The experimental preview decoder reads:

| Offset | Type | Interpretation |
| --- | --- | --- |
| 8 | u32 little endian | format identifier |
| 22, 24 | u16 little endian | width, height |
| 26, 28 | u16 little endian | repeated storage dimensions |
| 30 | u16 little endian | bytes per pixel |
| 32 | bytes | base-level pixel data |

365 payloads have format 2 and two-byte pixels, interpreted as A1R5G5B5.
28 have format 67 and four-byte pixels, interpreted as BGRA8888. The latter
have extra bytes after the base image, consistent with additional levels, but
the decoder does not claim to have decoded those levels. Some virtual names
explicitly contain `argb8888`, which supports that color interpretation.

Visual inspection of the local contact sheet shows coherent original faces,
uniforms and architectural textures. This supports plausibility of base-level
channel decoding; it does not validate alpha blending, gamma, UV orientation,
filtering, mip layout or final scene fidelity. Those need native loader evidence
and comparison with the running original.

Other LOOP texture versions (including terrain v9 and effect v2) are deliberately
unsupported. A `LOOP` magic alone does not identify a texture or a script.

## LOOP v8 scripts

All 118 `.qvm` files contain the measured LOOP v8 layout. Recovering names does
not imply recovering procedures or their semantics.

| Offset | Type | Observed meaning |
| --- | --- | --- |
| 12 | u32 little endian | symbol-offset table location |
| 16 | u32 little endian | symbol-string pool location |
| 20 | u32 little endian | symbol-offset table byte length |
| 24 | u32 little endian | symbol-string pool byte length |
| 44 | u32 little endian | bytecode location |
| 48 | u32 little endian | bytecode length |

Symbol offsets are u32 relative to the string pool. The bytecode section ends
at EOF in this corpus. Symbols include host function names and constants; there
is no assumption that each symbol is a function. The supplied `config.qsc`
and `config.qas` provide source and assembly for comparison with `config.qvm`.

## Formats not yet decoded

Model `.mef` payloads use nested ILFF containers with additional chunk types.
They have been indexed but not converted to meshes. `.mtp` files use big-endian
`FORM` chunk sizes and differ from the little-endian resource containers.
Terrain `.hmp`, `.ctr`, `.bit`, `.lmp`, `.cmd`, and v9 `.tex` structures have not
been established. Do not interpret terrain `.hmp` as a raw height grid just
because of its extension.
