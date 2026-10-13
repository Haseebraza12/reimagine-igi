#!/usr/bin/env python3
"""Local IGI research CLI. Standard library only; never runs the game."""
import argparse
from collections import Counter
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess
import sys
import zlib

from igi_formats import (FormatError, file_offset_to_va, pe_sections,
                         qvm_symbols, resource_members, texture_preview)

ROOT = Path(__file__).resolve().parents[1]
GAME = ROOT / "Game Files"
RESEARCH = ROOT / "research"


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def source_file(path):
    return path.resolve().is_relative_to(GAME.resolve())


def output_directory(value):
    path = Path(value).resolve()
    if source_file(path) or GAME.resolve().is_relative_to(path):
        raise FormatError("output must be separate from the original Game Files tree")
    return path


def scan(args):
    files, resources, scripts, errors = [], [], [], []
    for path in sorted(GAME.rglob("*")):
        if path.is_symlink():
            raise FormatError(f"unexpected symlink in source tree: {path}")
        if not path.is_file():
            continue
        data = path.read_bytes()
        relative = path.relative_to(GAME).as_posix()
        files.append({"path": relative, "size": len(data), "sha256": digest(data),
                      "extension": path.suffix.lower(), "magic_hex": data[:16].hex()})
        try:
            if path.suffix.lower() == ".res":
                members = []
                for name, chunk in resource_members(data):
                    members.append({"name": name, **asdict(chunk),
                                    "sha256": digest(chunk.payload(data))})
                resources.append({"path": relative, "member_count": len(members), "members": members})
            elif path.suffix.lower() == ".qvm":
                scripts.append({"path": relative, **qvm_symbols(data)})
        except FormatError as error:
            errors.append({"path": relative, "error": str(error)})
    if not files:
        raise FormatError(f"no files found at {GAME}")
    levels = sorted(p.parent.relative_to(GAME).as_posix() for p in GAME.glob("missions/**/mission.qvm"))
    summary = {"file_count": len(files), "total_bytes": sum(f["size"] for f in files),
               "extensions": dict(sorted(Counter(f["extension"] for f in files).items())),
               "level_directories": levels, "resource_archives": len(resources),
               "resource_members": sum(r["member_count"] for r in resources),
               "qvm_files": len(scripts), "errors": errors}
    # Never replace the preservation baseline implicitly on a later scan.
    baseline = RESEARCH / "baseline.json"
    if not baseline.exists():
        write_json(baseline, {"files": files})
    write_json(RESEARCH / "inventory.json", {"summary": summary, "files": files})
    write_json(RESEARCH / "resources.json", resources)
    write_json(RESEARCH / "qvm-symbols.json", scripts)
    print(json.dumps(summary, indent=2))
    return 1 if errors else 0


def verify(args):
    baseline = json.loads((RESEARCH / "baseline.json").read_text())["files"]
    original = {f["path"]: f["sha256"] for f in baseline}
    current = {p.relative_to(GAME).as_posix(): digest(p.read_bytes())
               for p in GAME.rglob("*") if p.is_file()}
    changed = sorted(name for name in original.keys() & current.keys() if original[name] != current[name])
    result = {"changed": changed, "missing": sorted(original.keys() - current.keys()),
              "added": sorted(current.keys() - original.keys())}
    print(json.dumps(result, indent=2))
    return int(any(result.values()))


def resources(args):
    data = Path(args.archive).read_bytes()
    rows = [{"name": name, **asdict(chunk)} for name, chunk in resource_members(data)]
    print(json.dumps(rows, indent=2))
    return 0


def png_bytes(width, height, rgba):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))
    scanlines = b"".join(b"\0" + rgba[y * width * 4:(y + 1) * width * 4] for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">2I5B", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(scanlines, 9)) + chunk(b"IEND", b""))


def textures(args):
    archive = Path(args.archive).resolve()
    data = archive.read_bytes()
    out = output_directory(args.out)
    out.mkdir(parents=True, exist_ok=True)
    converted, skipped = [], []
    for i, (name, chunk) in enumerate(resource_members(data)):
        if chunk.tag != "BODY" or not name.lower().endswith(".tex"):
            continue
        try:
            meta, rgba = texture_preview(chunk.payload(data))
        except FormatError as error:
            skipped.append({"name": name, "reason": str(error)})
            continue
        # Generated numeric filenames prevent virtual names from writing paths.
        filename = f"{i:04d}.png"
        target = out / filename
        if target.is_symlink():
            raise FormatError(f"output is a symlink: {target}")
        image_data = png_bytes(meta["width"], meta["height"], rgba)
        target.write_bytes(image_data)
        converted.append({"name": name, "png": filename, **meta,
                          "source_payload_offset": chunk.payload_offset,
                          "source_sha256": digest(chunk.payload(data)),
                          "png_sha256": digest(image_data)})
    write_json(out / "manifest.json", {"archive": str(archive), "archive_sha256": digest(data),
        "notice": "Local research previews. Pixel layout inferred; fidelity not yet validated.",
        "converted": converted, "skipped": skipped})
    print(f"Converted {len(converted)} experimental base-level previews; skipped {len(skipped)}. Output: {out}")
    return int(not converted)


def triage(args):
    path = GAME / "igi.exe"
    data = path.read_bytes()
    info = pe_sections(data)
    needles = (b"DefineHumanPlayer", b"CreateTerrain", b"Direct3D", b"DirectDraw",
               b".hmp", b".qvm", b".mef", b".tex", b".res")
    candidates = []
    for match in re.finditer(rb"[\x20-\x7e]{4,}", data):
        value = match.group()
        if any(needle in value for needle in needles):
            va = file_offset_to_va(info, match.start())
            candidates.append({"text": value.decode("ascii"), "file_offset": hex(match.start()),
                "va": hex(va) if va is not None else None,
                "status": "string anchor; function and xrefs not yet recovered"})
    write_json(RESEARCH / "native-triage.json", {"sha256": digest(data), **info, "string_anchors": candidates})
    for flags, filename in ((["-p"], "pe-imports.txt"), (["-h"], "pe-sections.txt")):
        result = subprocess.run(["objdump", *flags, str(path)], capture_output=True, text=True, check=True)
        (RESEARCH / filename).write_text(result.stdout, encoding="utf-8")
    print(json.dumps({**info, "string_anchor_count": len(candidates)}, indent=2))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("scan", help="hash originals and inventory resources/scripts").set_defaults(run=scan)
    sub.add_parser("verify", help="compare originals to the first scan").set_defaults(run=verify)
    sub.add_parser("triage", help="PE sections, imports and string anchors").set_defaults(run=triage)
    res = sub.add_parser("resources", help="list an ILFF resource archive")
    res.add_argument("archive")
    res.set_defaults(run=resources)
    tex = sub.add_parser("textures", help="experimental texture PNG previews")
    tex.add_argument("archive")
    tex.add_argument("--out", required=True)
    tex.set_defaults(run=textures)
    args = parser.parse_args()
    try:
        return args.run(args)
    except (FormatError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
