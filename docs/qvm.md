# LOOP v8 QVM: static call and constant recovery

`tools/igi_qvm.py` reads user-owned game files without executing bytecode or
calling the original engine. It recognizes only instruction encodings supported
by the shipped `config.qsc`, `config.qas`, and `config.qvm` evidence. Unknown
instructions stay unknown. This is a partial disassembler and constant reader,
not a QVM interpreter or a complete scripting-language specification.

```bash
python tools/igi_qvm.py 'Game Files/config.qvm' --validate-config
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

| Opcode | Measured encoding | Paired assembly meaning |
| --- | --- | --- |
| `00` | One byte | `BRK` |
| `03` | Opcode + one observed positive integer byte | `PUSH` |
| `04` | Opcode + two little-endian observed positive integer bytes | `PUSH` |
| `05` | Opcode + four little-endian IEEE float bytes | `PUSHF` |
| `09` | Opcode + one-byte literal-table index | `PUSHS` |
| `0d` | Opcode + one-byte symbol-table index | `PUSHI` |
| `0f` | One byte | Compact numeric zero |
| `10` | One byte | Compact numeric one |
| `12` | One byte | `POP` |
| `14` | Opcode + signed 32-bit displacement from the end of this instruction | `BRA` |
| `18` | Opcode + 32-bit argument count + that many 32-bit code-relative offsets | `CALL` |

There are **11** named encodings in this bounded investigation. Signedness of
the immediate integer encodings beyond the observed positive range remains
unverified. Compact `10` represents both `PUSH 1` and `PUSHF 1.000000` in the
paired assembly; the reader preserves numeric one without inventing a type.
Symbol references remain names, not resolved integer constants or pointers.

The observed top-level sequence is `PUSHI function; CALL argument-offsets;
BRA skip-arguments; [argument blocks]; POP`, followed eventually by `BRK`.
Each constant argument block is exactly one literal instruction and `BRK`.
The reader checks this structure, section bounds, ordered argument targets,
and that the branch ends at `POP`. It can inspect later arguments using the
explicit CALL offset table when an earlier argument contains an unknown
opcode. Linear disassembly stops immediately on an unknown opcode, without
guessing its size or scanning for a plausible next instruction.

## Finding ledger

Evidence IDs below refer to immutable input hashes and locations in this
document; no native-analysis or runtime result is implied.

| Evidence ID | Question / conclusion | Confidence and boundary | Remaining unknown |
| --- | --- | --- | --- |
| QVM-CONFIG | All 43 calls, 102 argument blocks, 377 instructions and 1,268 code bytes align with the paired assembly structure. All source function names and arities align. | Direct static comparison of the config triplet; every assembly CALL/BRA label checked against bytecode targets. | One source/assembly value differs from bytecode, below. |
| QVM-CONFIG-DIFF | `GOInMouInv` argument at code `0x5e`, file `0x539`, is `0f 00`: numeric zero followed by BRK. Both `.qsc` and `.qas` say one. | Direct bytes; zero independently corroborated by `GOStart` and `GOGfxPerformance` elsewhere in the triplet. | Why the text and compiled config differ; neither text is assumed to be the authoritative runtime input. |
| QVM-CONFIG-FLOAT | `GOInMouSens` at code `0x71`, file `0x54c`, stores `05 cc cc cc 3e 00`, i.e. `0.3999999761581421`. | Direct float32 bytes; agrees with the printed `0.400000` at six-decimal source precision. | Compiler float parsing/rounding mechanism. |
| QVM-HUMAN | Four complete top-level call structures; 96 of 98 constants recovered. `DefineHumanPlayerGeneral` has 43 arguments, weapon cycle 18, weapon category 27, ammo limit 10. | Same validated encodings and explicit bytecode targets; code base `0x291`, length 800. | General argument positions 41 and 42 start with unsupported `02`; general numeric parameter meanings and units. |
| QVM-AK47 | One `DefineWeaponType` structure with 49 arguments; 46 constants recovered. | Same validated encodings and explicit bytecode targets; code base `0x186`, length 391. | Argument positions 18, 34 and 35 contain unsupported `2c`; numeric parameter meanings and units. |

Human-player general argument positions 0–8 recover as
`[1.75, 17.5, 27, 0.5, 0.8500000238418579, 0.8500000238418579, 0.25, 3.0, 0.5]`.
These are **positional constants**, not named movement, camera, or physics
properties. A host-function trace is required before assigning such meanings.
The two unresolved blocks at file `0x3fc` and `0x402` are both
`02 a0 86 01 00 00`. Although their bytes resemble an integer encoding, `02`
does not occur in the paired config, so the reader deliberately leaves them
unresolved.

The weapon-cycle call contains these 18 symbolic references in order:
`KNIFE, GLOCK, COLT, DESERTEAGLE, UZI, UZIX2, MP5SD, M16A2, AK47, SPAS12,
JACKHAMMER, DRAGUNOV, MINIMI, GRENADE, FLASHBANG, RPG18, PROXIMITYMINE,
MEDIPACK`, each with the `WEAPON_ID_` prefix in the actual file. Numeric IDs
and native behavior are not established by these names alone.

The ammo-limit call contains alternating symbolic/numeric arguments:
`AMMO_ID_12, 32, AMMO_ID_357, 32, AMMO_ID_556, 200, AMMO_ID_762, 128,
AMMO_ID_919, 196`. Their positional order is directly observed; interpreting
the pairs as enforced runtime caps still requires tracing the host function.

AK47 argument 18 at file `0x295` is `05 00 00 60 40 2c 00`; arguments 34 and
35 at `0x2d7` and `0x2da` are `10 2c 00`. A negative-number transformation is
one possible hypothesis for `2c`, but this investigation has no paired source
or native-dispatch evidence proving that. The reader does not incorrectly
return positive 3.5 or 1 for those unresolved expressions.

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

Eight tests pass, covering literal recovery, source/assembly validation and
the known discrepancy, raw offset evidence, malformed references and tables,
truncated operands, out-of-range branches, invalid argument partitions,
unknown argument encodings, and unknown transformations. Synthetic fixtures
contain no proprietary game assets; the paired-config test uses local files
when available and otherwise skips.

No target executable, game bytecode, or host call was run. No claim is made
about execution order in the original VM, full QVM coverage, the native ABI,
or how these parameters should behave in a browser implementation.
