# LOOP v8 QVM: static call and constant recovery

`tools/igi_qvm.py` (Python) and `web-port/src/loaders/qvm.ts` (browser) read
user-owned game files without executing bytecode or calling the original
engine. They name only encodings supported by evidence (below); unknown
instructions stay unknown and stop decoding. This is a disassembler, constant
reader and call-tree parser for declarative scripts, not a QVM interpreter.

> **Superseded for execution:** the complete VM (all 49 opcodes, the host-call
> convention, the expression language and an interpreter that runs every
> shipped script) is recovered from `igi.exe` in [qvm-vm.md](qvm-vm.md)
> (`tools/igi_qvm_vm.py`, `web-port/src/loaders/qvm-vm.ts`). Corrections from
> that work: opcodes `03`/`04` push **sign-extended** 8/16-bit integers (no
> shipped value is affected), and header fields +8 (must be > 4), +0x34
> (data-stack bytes) and +0x38 (type-stack entries) are known.

```bash
python tools/igi_qvm.py 'Game Files/config.qvm' --validate-config
python tools/level_tasks.py 'Game Files/missions/location0/level1/objects.qvm'
python tools/igi_qvm.py 'Game Files/config.qvm' --disassemble
python tools/igi_qvm.py 'Game Files/humanplayer/humanplayer.qvm'
python tools/igi_qvm.py 'Game Files/weapons/AK47/weapon.qvm'
python -m unittest discover -s tools -p 'test_igi_qvm.py' -v
```

Offsets in reports are decimal JSON integers. `file_offset` includes the header;
`code_offset` is relative to the code section. Argument indices start at zero.
Every recovered value retains its instruction bytes and original offsets.
Strings retain a separate offset to their literal/symbol text.

## Observed sections and instruction encodings

All measured header fields below are little-endian 32-bit integers. These
layouts agree with the three investigated QVM files; they do not establish
other LOOP versions.

| Header byte offset | Observed field |
| --- | --- |
| 0 / 4 | `LOOP` / version 8 |
| 12 / 16 | Symbol-offset table / symbol-string data offset |
| 20 / 24 | Symbol-offset table byte length / symbol-string byte length |
| 28 / 32 | Literal-offset table / literal-string data offset |
| 36 / 40 | Literal-offset table byte length / literal-string byte length |
| 44 / 48 | Bytecode offset / bytecode byte length |

String-table entries are 32-bit offsets relative to their respective string
section; text is NUL terminated. Header fields at 8, 52, and 56 have no assigned
semantics here.

| Opcode | Measured encoding | Meaning | Evidence |
| --- | --- | --- | --- |
| `00` | One byte | `BRK` | paired config |
| `02` | Opcode + four little-endian bytes | `PUSH` u32 | recovered (see below) |
| `03` | Opcode + one observed positive integer byte | `PUSH` | paired config |
| `04` | Opcode + two little-endian observed positive integer bytes | `PUSH` | paired config |
| `05` | Opcode + four little-endian IEEE float bytes | `PUSHF` | paired config |
| `09` | Opcode + one-byte literal-table index | `PUSHS` | paired config |
| `0a` | Opcode + two-byte literal-table index | `PUSHS` (wide) | recovered (see below) |
| `0d` | Opcode + one-byte symbol-table index | `PUSHI` | paired config |
| `0f` | One byte | Compact numeric zero | paired config |
| `10` | One byte | Compact numeric one | paired config |
| `12` | One byte | `POP` | paired config |
| `14` | Opcode + signed 32-bit displacement from the end of this instruction | `BRA` | paired config |
| `18` | Opcode + 32-bit argument count + that many 32-bit code-relative offsets | `CALL` | paired config |
| `2c` | One byte | unary `MINUS` | recovered (see below) |

There are **14** named encodings. "Paired config" means validated against the
shipped `config.qsc` + `config.qas` + `config.qvm` triplet. The other three:

- `0a`: `objects.qvm` uses it for every literal index ≥ 256 (the first is 256
  → "Playback"), and the resulting strings match the community decompile.
- `2c`: all 2,380 `<number>; 2c; BRK` blocks in `objects.qvm` decompile as
  the negated number, and the full call tree (below) agrees with the decompile.
  The readers fold exactly `<number literal>; MINUS; BRK` into a negative value.
- `02`: never present in the paired config. Every occurrence
  (`humanplayer.qvm` `02 a0 86 01 00 00`, `weaponconfig.qvm`
  `02 70 94 00 00 00`) is an argument block that ends with `BRK` exactly when
  the operand is four bytes; the community opcode table names the same
  encoding. Read as unsigned.

Compact `10` represents both `PUSH 1` and `PUSHF 1.000000` in the paired
assembly; the reader preserves numeric one without inventing a type. Symbol
references remain names, not resolved integer constants or pointers.

The observed top-level sequence is `PUSHI function; CALL argument-offsets;
BRA skip-arguments; [argument blocks]; POP`, followed eventually by `BRK`.
Each constant argument block is exactly one literal instruction and `BRK`.
The reader checks this structure, section bounds, ordered argument targets,
and that the branch ends at `POP`. It can inspect later arguments using the
explicit CALL offset table when an earlier argument contains an unknown
opcode. Linear disassembly stops immediately on an unknown opcode, without
guessing its size or scanning for a plausible next instruction.

## Call trees

Declarative scripts (`objects.qvm`, `terrain.qvm`, `magicobj.qvm`,
`weaponconfig.qvm`) nest calls inside arguments. The recovered grammar:

```
statement := PUSHI fn; CALL offsets; BRA end; arg*; end: POP
nested    := PUSHI fn; CALL offsets; BRA end; arg*; end: BRK
arg       := (literal [MINUS] | nested) BRK
```

CALL's offset table must partition the region skipped by BRA exactly.
`QVM.call_tree()` / `readQvmCallTree()` parse every shipped mission-1 script
completely: `objects.qvm` 60 statements / 1,418 calls, `magicobj.qvm` 372,
`weaponconfig.qvm` 5 / 52, `terrain.qvm` 14, `humanplayer.qvm` 4,
`config.qvm` 43. Compared node by node with the community decompile
`objects.qsc`, 18,105 of 18,127 tree nodes agree; all 22 differences are in
two statements the decompile has evidently been edited in (for example it
adds `&& Game_DisableMusic()` to a cut-scene expression), not decoding errors.
Task schemas inside `objects.qvm` are described in [formats.md](formats.md).

## Finding ledger

Evidence IDs below refer to immutable input hashes and locations in this
document; no native-analysis or runtime result is implied.

| Evidence ID | Question / conclusion | Confidence and boundary | Remaining unknown |
| --- | --- | --- | --- |
| QVM-CONFIG | All 43 calls, 102 argument blocks, 377 instructions and 1,268 code bytes align with the paired assembly structure. All source function names and arities align. | Direct static comparison of the config triplet; every assembly CALL/BRA label checked against bytecode targets. | One source/assembly value differs from bytecode, below. |
| QVM-CONFIG-DIFF | `GOInMouInv` argument at code `0x5e`, file `0x539`, is `0f 00`: numeric zero followed by BRK. Both `.qsc` and `.qas` say one. | Direct bytes; zero independently corroborated by `GOStart` and `GOGfxPerformance` elsewhere in the triplet. | Why the text and compiled config differ; neither text is assumed to be the authoritative runtime input. |
| QVM-CONFIG-FLOAT | `GOInMouSens` at code `0x71`, file `0x54c`, stores `05 cc cc cc 3e 00`, i.e. `0.3999999761581421`. | Direct float32 bytes; agrees with the printed `0.400000` at six-decimal source precision. | Compiler float parsing/rounding mechanism. |
| QVM-HUMAN | Four complete top-level call structures; all 98 constants recovered. `DefineHumanPlayerGeneral` has 43 arguments, weapon cycle 18, weapon category 27, ammo limit 10. | Validated encodings plus recovered `02`; code base `0x291`, length 800. | General numeric parameter meanings and units. |
| QVM-AK47 | One `DefineWeaponType` structure with 49 arguments; all 49 recovered. | Validated encodings plus recovered `2c`; code base `0x186`, length 391. | Numeric parameter meanings and units. |
| QVM-OBJECTS | `objects.qvm` call tree: 60 statements, 1,418 calls, 1,362 `Task_New`. | Grammar above; 18,105/18,127 nodes agree with the community decompile. | Execution semantics of expression strings (`"AreaActivate_200.nActive"` etc.) are not interpreted beyond simple area tests. |

Human-player general argument positions 0–8 recover as
`[1.75, 17.5, 27, 0.5, 0.8500000238418579, 0.8500000238418579, 0.25, 3.0, 0.5]`.
These are **positional constants**, not named movement, camera, or physics
properties. A host-function trace is required before assigning such meanings.
Positions 41 and 42 (file `0x3fc` and `0x402`) are both `02 a0 86 01 00 00`
= 100,000 under the recovered `02` encoding.

The weapon-cycle call contains these 18 symbolic references in order:
`KNIFE, GLOCK, COLT, DESERTEAGLE, UZI, UZIX2, MP5SD, M16A2, AK47, SPAS12,
JACKHAMMER, DRAGUNOV, MINIMI, GRENADE, FLASHBANG, RPG18, PROXIMITYMINE,
MEDIPACK`, each with the `WEAPON_ID_` prefix in the actual file. Numeric IDs
and native behavior are not established by these names alone.

The ammo-limit call contains alternating symbolic/numeric arguments:
`AMMO_ID_12, 32, AMMO_ID_357, 32, AMMO_ID_556, 200, AMMO_ID_762, 128,
AMMO_ID_919, 196`. Their positional order is directly observed; interpreting
the pairs as enforced runtime caps still requires tracing the host function.

AK47 argument 18 at file `0x295` is `05 00 00 60 40 2c 00` = −3.5; arguments
34 and 35 at `0x2d7` and `0x2da` are `10 2c 00` = −1 (recovered `2c`; the
reports mark these values `negated: true`).

## Input identity and validation

All files remained unchanged; these SHA-256 digests bind the observations to
the supplied installation.

| Relative path under `Game Files/` | SHA-256 |
| --- | --- |
| `config.qsc` | `175a561c1ae1026458fecc1bdd13e95e2489b719bcaf43d96b28f557bab6d678` |
| `config.qas` | `42aac283947bcd33a82c050de857982d2c8c71b65d6eff811a831d6b9aa4e2c3` |
| `config.qvm` | `827c5c1f8ebe2f644470c86eee11a7f9327610b635744be60b5abfc49ecbf995` |
| `humanplayer/humanplayer.qvm` | `c1d863e57f9a71a3a1ad2b6b0f3432d652297c93f32b8fbd24c8e1e9fb1b78df` |
| `weapons/AK47/weapon.qvm` | `0b9b2c7c9ee2eda5caf16d3684efb9834e62c7b9a4cfdb8e20278fd739cf9114` |
| `weapons/weaponconfig.qvm` | `553308ac1fe3a58d1438792ac77af0b78bf7c6878218aa9346b9062814d5e78d` |
| `missions/location0/level1/objects.qvm` | `8c16ff3eb6251e2d3b7e16b07ce6b71b9ea4f54e8a17fcd866fc58bb44ed85cd` |
| `missions/location0/level1/terrain/terrain.qvm` | `353608aa6b254f8cabc604034b6067041a6c73d103170e5377210552a805474c` |
| `magicobj/magicobj.qvm` | `481936fc9f54806e7ccd037e0752906c748061fa8e61e5064c5c6bb566da3c11` |

The Python suite (`tools/test_igi_qvm.py`, 12 tests) covers literal
recovery, `PUSH_U32`, `MINUS` folding (and refusing it on strings),
source/assembly validation and the known discrepancy, raw offset evidence,
malformed references and tables, truncated operands, out-of-range branches,
invalid argument partitions, unknown opcodes and call trees. The browser
reader is tested in `web-port/tests/formats.test.ts` against synthetic
fixtures and the real `objects.qvm` / `weaponconfig.qvm`. Synthetic fixtures
contain no proprietary game assets; tests that need local game files skip
when they are absent.

No target executable, game bytecode, or host call was run. No claim is made
about execution order in the original VM, full QVM coverage, the native ABI,
or how these parameters should behave in a browser implementation.
