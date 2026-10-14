"""ILFF/IRES (.res) container extraction.

Wraps tools/igi_formats.py's measured `resource_members()` walker (imported by
path, never copied) and adds: sha256 hashing, safe on-disk names, and a JSON
manifest mapping virtual resource names -> offset/size/sha256.
"""

import hashlib
import re
import sys
from pathlib import Path

_TOOLS_DIR = Path(__file__).resolve().parent.parent
if str(_TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_TOOLS_DIR))

from igi_formats import FormatError, ilff_chunks, resource_members  # noqa: E402


def _safe_filename(virtual_name: str) -> str:
    """LOCAL:textures/000_03_1.tex -> 000_03_1.tex (sanitized, collision-safe).

    Path separators and anything outside [A-Za-z0-9._-] collapse to '_'; the
    result is guaranteed non-empty and never escapes a directory.
    """
    base = virtual_name.replace("\\", "/").rsplit("/", 1)[-1]
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._") or "unnamed"
    return base[:180]


def is_ilff(data: bytes) -> bool:
    return len(data) >= 20 and data[:4] == b"ILFF" and data[16:20] == b"IRES"


def list_members(data: bytes):
    """Return [{name, offset, size, sha256, safe_name}] for a .res container.

    offset is the payload offset inside the container file.
    """
    out = []
    used = {}
    for name, chunk in resource_members(data):
        payload = chunk.payload(data)
        digest = hashlib.sha256(payload).hexdigest()
        safe = _safe_filename(name)
        if safe in used:  # rare name collisions inside one container
            stem, dot, ext = safe.partition(".")
            safe = f"{stem}_{used[safe]}{dot}{ext}"
        used[safe] = used.get(safe, 0) + 1
        out.append({
            "name": name,
            "safe_name": safe,
            "offset": chunk.payload_offset,
            "size": chunk.size,
            "sha256": digest,
        })
    return out


def extract_container(res_path, out_dir=None):
    """Parse one .res; optionally write member payloads into out_dir.

    Returns (members, manifest_dict).  Each member gains a "path" key when
    out_dir is given.  Raises igi_formats.FormatError on malformed containers.
    """
    res_path = Path(res_path)
    data = res_path.read_bytes()
    if not is_ilff(data):
        raise FormatError(f"{res_path} is not an ILFF/IRES container")
    members = list_members(data)
    if out_dir is not None:
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        for m in members:
            target = out_dir / m["safe_name"]
            target.write_bytes(data[m["offset"]:m["offset"] + m["size"]])
            m["path"] = str(target)
    manifest = {
        "source": res_path.name,
        "source_size": len(data),
        "member_count": len(members),
        "members": [
            {k: m[k] for k in ("name", "safe_name", "offset", "size", "sha256")}
            for m in members
        ],
    }
    return members, manifest


def walk_ilff_sizes(data: bytes):
    """Low-level chunk walk (tags/sizes only) - useful for debugging."""
    return [
        {"tag": c.tag, "header_offset": c.header_offset,
         "payload_offset": c.payload_offset, "size": c.size,
         "alignment": c.alignment}
        for c in ilff_chunks(data)
    ]
