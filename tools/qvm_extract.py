"""Extract QVM gameplay constants into web-port runtime JSON (GeneratedData<T>).

Writes three documents consumed by the web engine; shapes come from
web-port/src/contracts.ts:

  player.json            GeneratedData<PlayerTuning>
  weapons.json           GeneratedData<WeaponSpec[]>
  level1-gameplay.json   GeneratedData<{playerSpawn, objectives, enemyPatrols}>

Everything is recovered statically with tools/igi_qvm.py; no bytecode runs.
Fields without recoverable evidence carry the committed DEFAULT_* values
parsed live from web-port/src/contracts.ts and are listed per-field as
"inferred" in source.notes. Every recovered value records its file and
bytecode offset. See docs/qvm-findings.md for the evidence tables.

Usage:
  python3 tools/qvm_extract.py --out web-port/public/generated
  python3 tools/qvm_extract.py --out web-port/public/generated --validate
"""
import argparse
import json
import math
import re
from pathlib import Path

from igi_formats import FormatError
from igi_qvm import QVM, validate_config

ROOT = Path(__file__).resolve().parents[1]
CONTRACTS_TS = ROOT / "web-port/src/contracts.ts"
GAME_FILES = ROOT / "Game Files"

REPO = {                       # repo-relative paths as cited in source.files
    "contracts": "web-port/src/contracts.ts",
    "humanplayer": "Game Files/humanplayer/humanplayer.qvm",
    "weaponconfig": "Game Files/weapons/weaponconfig.qvm",
    "objects_qvm": "Game Files/missions/location0/level1/objects.qvm",
    "objects_qsc": "tools/igi-research/Research/QSC/level1/objects.qsc",
    "mission_qvm": "Game Files/missions/location0/level1/mission.qvm",
    "ai_qsc": "tools/igi-research/Research/QSC/level1/ai/*.qsc",
    "qvm_reference": "tools/igi-research/Research/QVM/QVM_REFERENCE.md",
}

PLAYER_FIELDS = ["walkSpeed", "runSpeed", "crouchSpeed", "jumpVelocity",
                 "gravity", "eyeHeight", "crouchEyeHeight", "pitchMinDeg",
                 "pitchMaxDeg", "acceleration", "friction"]
WEAPON_FIELDS = ["id", "name", "damage", "rpm", "magSize",
                 "reloadSeconds", "spreadDeg", "range", "automatic"]

# WeaponSpec field -> DefineWeaponType argument index; these indices were
# cross-checked against the Task_DeclareParameters("WeaponConfig", ...) schema
# in weaponconfig.qvm (field names verified at build time) and against the
# physical plausibility of every extracted value (e.g. AK47 mass 4300 g,
# calibre 7.62, muzzle velocity 710 m/s, 30-round clip, 650 rounds/minute).
WEAPON_ARG = {"id": 1, "name": 2, "damage": 10, "reloadSeconds": 12,
              "rpm": 15, "magSize": 16, "automatic": 17, "spreadDeg": 19,
              "range": 25}
EXPECTED_SCHEMA = {"id": "Script ID", "name": "Name",
                   "damage": "Damage Factor", "reloadSeconds": "Reload Time",
                   "rpm": "Rounds/Minute", "magSize": "Rounds/Clip",
                   "automatic": "Maximum Rounds/Burst",
                   "spreadDeg": "Maximum random spread",
                   "range": "Effective Range of Weapon"}

# --- chunk-1-end ---
