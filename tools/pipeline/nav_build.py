"""Navigation graph build: missions/.../graphs/*.dat -> NavGraph / nav.json.

Emits the `NavGraph` contract from web-port/src/contracts.ts:

    { "nodes": [ { "position": [x, y, z], "links": [<index>, ...] }, ... ] }

RECORD FORMAT  (confidence: "observed")
---------------------------------------
Every graph file is a stream of self-describing records::

    signature (4 bytes) | flags u16 | type u16 | payload

The 8-byte prefix after the 4-byte signature is always ``00 00 TT TT`` where
TT is a small type code (5 = integer, 6 = float, 8 = double x3, 9 = string).
The payload width is then fixed by the field, so the stream parses forward
without any length fields.

    File header
      0x00  u32 magic                0xFFEEDDCC   ("CC DD EE FF" on disk)
      0x04  'max nodes' record       04E63A0D  payload u32 node capacity
      ...   a large fixed-size block (8 * capacity^2 bytes in the measured
            files; content not decoded - skipped by searching for the first
            node signature rather than by trusting the arithmetic)

    Node record (six fields, in this order)
      04CE3507  node id      u32
      0495421D  position     3 x float64        (see AXIS note below)
      049C7E0F  gamma        float32
      04233014  radius       float32
      0429B61B  material     i32                (-1 == 0xFFFFFFFF)
      04E5D31B  criteria     u8 length + bytes  (NUL-terminated name)

    Link record (three fields, one undirected edge)
      044A1009  node A id    u32
      04F61809  node B id    u32
      0423A90D  link type    u32

The signatures, field order and payload widths come from
tools/igi-research/Research/GRAPH/{Graph-Structure,Graph_Items,Graph_Nodes}.md
("Graph Hex Signatures ... CC DD EE FF").

VALIDATION PERFORMED
--------------------
The parser reproduces tools/igi-research/Research/GRAPH/Level1/Graph_7.md
exactly: all 11 node positions to 0.1, gamma 0, radius 0.5, materials 3 / -1,
both criteria strings, and all 8 edges.  Every one of the 11 Mission-1 graph
files parses forward and consumes the file to exactly EOF, which is strong
evidence the record walk is correct rather than coincidental.

AXIS + SCALE  (confidence: "inferred" - strongly supported)
----------------------------------------------------------
The three doubles are stored in IGI's own coordinate space, which is NOT the
same space as the terrain heightfield:

* Scale: 4096 IGI units = 1 metre (Research/AMAZING_DISCOVERIES.md, "Unit
  Scale").  Output positions are therefore divided by `units_per_meter`.
* Axis: IGI graph data is Z-up.  In every Mission-1 graph the third component
  varies by <1.5 m while the first two span 20-150 m (graph8: z spans 1.0 m
  against a 20 m x 20 m footprint; graph4019: z spans 0.5 m against 151 m x
  135 m).  A heightfield's elevation is by definition its low-variance axis,
  so component 3 is height.  Output is therefore swapped to the y-up
  convention used by `TerrainData.heights` ("y-up" per contracts.ts).

Note the community doc AMAZING_DISCOVERIES.md also contains a helicopter
snippet implying Y-up ("vertical_force = {0, collective*819.2, 0}", "Yaw (Y
axis)").  The measured graph statistics contradict it for nav data, so Z-up is
used; `up_axis` is a parameter so this can be flipped without editing code.

WORLD REGISTRATION  (confidence: "recovered", validated)
-------------------------------------------------------
Node positions are offsets from the "Graph position" of the AIGraph task in
objects.qvm whose task id equals the graph file number (graph4019.dat <->
AIGraph task 4019, whose Graphdata (264, 300, 876) also matches the file's
node count, capacity and link count). World position = graph position + node
offset, in IGI units. Validated against the decoded terrain
(tools/terrain_ctr.py): 206 of 289 nodes lie on the surface within 0.25 m
(median residual 0) and 82 stand on floors/roofs. Five nodes in placeholder
graphs (e.g. graph2) have graph-local coordinates and no meaningful world
position.
"""

from __future__ import annotations

import json
import math
import struct
from pathlib import Path

# --- file header -------------------------------------------------------------
GRAPH_MAGIC = 0xFFEEDDCC

# --- record signatures (4-byte tags from Research/GRAPH/Graph_Items.md) ------
SIG_MAX_NODES = b"\x04\xe6\x3a\x0d"
SIG_NODE_ID = b"\x04\xce\x35\x07"
SIG_NODE_POSITION = b"\x04\x95\x42\x1d"
SIG_NODE_GAMMA = b"\x04\x9c\x7e\x0f"
SIG_NODE_RADIUS = b"\x04\x23\x30\x14"
SIG_NODE_MATERIAL = b"\x04\x29\xb6\x1b"
SIG_NODE_CRITERIA = b"\x04\xe5\xd3\x1b"
SIG_LINK_A = b"\x04\x4a\x10\x09"
SIG_LINK_B = b"\x04\xf6\x18\x09"
SIG_LINK_TYPE = b"\x04\x23\xa9\x0d"


RECORD_PREFIX = 8  # 4-byte signature + u16 flags + u16 type code


# ---------------------------------------------------------------------------
# record reader
# ---------------------------------------------------------------------------

def _read_record(data: bytes, pos: int, signature: bytes, width: int):
    """Read one ``signature | flags | type | payload`` record at `pos`.

    `width` is the payload size implied by the field's type code, which is what
    makes the stream self-delimiting.  Returns ``(payload, next_pos)`` with
    `next_pos` already past the payload.  Raises GraphError when the signature
    does not match or the record runs past EOF.
    """
    if pos < 0 or pos + RECORD_PREFIX + width > len(data):
        raise GraphError(
            f"record {signature.hex()} at 0x{pos:x} runs past EOF")
    if data[pos:pos + 4] != signature:
        raise GraphError(
            f"expected signature {signature.hex()} at 0x{pos:x}, "
            f"found {data[pos:pos + 4].hex()}")
    start = pos + RECORD_PREFIX
    return data[start:start + width], start + width


def _read_criteria(data: bytes, pos: int, source: str):
    """Read the variable-width criteria record at `pos`.

    Payload is ``u8 length`` followed by that many bytes (a NUL-terminated
    name).  Returns ``(text, next_pos)``.
    """
    if pos < 0 or pos + RECORD_PREFIX + 1 > len(data):
        raise GraphError(f"{source}: criteria record at 0x{pos:x} runs past EOF")
    if data[pos:pos + 4] != SIG_NODE_CRITERIA:
        raise GraphError(
            f"{source}: expected signature {SIG_NODE_CRITERIA.hex()} at "
            f"0x{pos:x}, found {data[pos:pos + 4].hex()}")
    start = pos + RECORD_PREFIX
    length = data[start]
    end = start + 1 + length
    if end > len(data):
        raise GraphError(
            f"{source}: criteria length {length} overruns file at 0x{pos:x}")
    raw = data[start + 1:end]
    if raw.endswith(b"\x00"):
        raw = raw[:-1]
    return raw.decode("ascii", "replace"), end


def _u32_at(payload: bytes, source: str) -> int:
    if len(payload) < 4:
        raise GraphError(f"{source}: u32 payload is {len(payload)} bytes")
    return struct.unpack_from("<I", payload, 0)[0]


def _f32_at(payload: bytes, source: str) -> float:
    if len(payload) < 4:
        raise GraphError(f"{source}: float payload is {len(payload)} bytes")
    return struct.unpack_from("<f", payload, 0)[0]


def _f64x3_at(payload: bytes, source: str):
    if len(payload) < 24:
        raise GraphError(f"{source}: float64x3 payload is {len(payload)} bytes")
    return struct.unpack_from("<3d", payload, 0)


def parse_graph(source, name: str = "graph"):
    """Parse one graphs/*.dat file into raw nodes and links.

    Returns ``{name, max_nodes, nodes, links, consumed, node_offset,
    warnings}``.  Node dicts keep the on-disk values (position is the raw
    float64 triple in IGI units, material as signed int) plus `criteria`.
    Link dicts are ``{a, b, type}`` using on-disk node ids.

    Raises GraphError on any structural problem; the caller decides whether to
    skip the file or abort the build.
    """
    data = Path(source).read_bytes() if isinstance(source, (str, Path)) else bytes(source)
    warnings = []

    if len(data) < 32:
        raise GraphError(f"file too small ({len(data)} bytes)")
    magic = struct.unpack_from("<I", data, 0)[0]
    if magic != GRAPH_MAGIC:
        raise GraphError(
            f"bad magic 0x{magic:08x}, expected 0x{GRAPH_MAGIC:08x}")

    payload, pos = _read_record(data, 4, SIG_MAX_NODES, 4)
    max_nodes = _u32_at(payload, f"{name}: max nodes")

    # The block between the header and the first node record is not decoded
    # (see module docstring), so locate the node section by signature search
    # rather than by trusting size arithmetic.
    node_offset = data.find(SIG_NODE_ID, pos)
    if node_offset < 0:
        raise GraphError(f"{name}: no node records found")

    # --- node records -------------------------------------------------------
    nodes = []
    pos = node_offset
    seen_ids = set()
    while pos + RECORD_PREFIX <= len(data) and data[pos:pos + 4] == SIG_NODE_ID:
        node_payload, pos = _read_record(data, pos, SIG_NODE_ID, 4)
        node_id = _u32_at(node_payload, f"{name}: node id")

        pos_payload, pos = _read_record(data, pos, SIG_NODE_POSITION, 24)
        position = _f64x3_at(pos_payload, f"{name}: node {node_id} position")

        gamma_payload, pos = _read_record(data, pos, SIG_NODE_GAMMA, 4)
        gamma = _f32_at(gamma_payload, f"{name}: node {node_id} gamma")

        radius_payload, pos = _read_record(data, pos, SIG_NODE_RADIUS, 4)
        radius = _f32_at(radius_payload, f"{name}: node {node_id} radius")

        material_payload, pos = _read_record(data, pos, SIG_NODE_MATERIAL, 4)
        material_u32 = _u32_at(material_payload, f"{name}: node {node_id} material")
        material = struct.unpack("<i", struct.pack("<I", material_u32))[0]

        criteria, pos = _read_criteria(data, pos, f"{name}: node {node_id}")

        if node_id in seen_ids:
            warnings.append(f"duplicate node id {node_id}; keeping the first")
            continue
        seen_ids.add(node_id)
        nodes.append({"id": node_id, "position": position, "gamma": gamma,
                      "radius": radius, "material": material,
                      "criteria": criteria})

    # --- link records -------------------------------------------------------
    links = []
    while pos + RECORD_PREFIX <= len(data) and data[pos:pos + 4] == SIG_LINK_A:
        a_payload, pos = _read_record(data, pos, SIG_LINK_A, 4)
        link_a = _u32_at(a_payload, f"{name}: link a")
        b_payload, pos = _read_record(data, pos, SIG_LINK_B, 4)
        link_b = _u32_at(b_payload, f"{name}: link b")
        type_payload, pos = _read_record(data, pos, SIG_LINK_TYPE, 4)
        link_type = _u32_at(type_payload, f"{name}: link type")
        links.append({"a": link_a, "b": link_b, "type": link_type})

    if pos != len(data):
        warnings.append(
            f"stopped at 0x{pos:x} with {len(data) - pos} trailing bytes; "
            f"ignored (conservative)")

    return {"name": name, "max_nodes": max_nodes, "nodes": nodes,
            "links": links, "node_offset": node_offset, "consumed": pos,
            "warnings": warnings}


# --- transform defaults ------------------------------------------------------
DEFAULT_UNITS_PER_METER = 4096.0
DEFAULT_UP_AXIS = "z"
DEFAULT_MAX_EXTENT = 2000.0


class GraphError(ValueError):
    """Raised when a graph file does not match the documented record layout."""



# ---------------------------------------------------------------------------
# coordinate transform
# ---------------------------------------------------------------------------

def transform_position(raw, units_per_meter: float = DEFAULT_UNITS_PER_METER,
                       up_axis: str = DEFAULT_UP_AXIS,
                       offset=(0.0, 0.0, 0.0)):
    """Convert an on-disk float64 triple into the runtime y-up world position.

    IGI units -> metres (`units_per_meter`), then rotated so the height
    component lands on Y.  `offset` is subtracted from X and Z only (it is a
    horizontal registration offset, never a vertical one).
    """
    if units_per_meter <= 0:
        raise GraphError(f"units_per_meter must be positive, got {units_per_meter}")
    scale = 1.0 / units_per_meter
    x, y, z = raw
    if up_axis == "z":       # measured IGI convention: third component is height
        out = (x * scale, z * scale, y * scale)
    elif up_axis == "y":     # hypothetical; see module docstring
        out = (x * scale, y * scale, z * scale)
    else:
        raise GraphError(f"unsupported up_axis {up_axis!r} (use 'z' or 'y')")
    return [out[0] - offset[0], out[1], out[2] - offset[2]]


def _plausible(position, max_extent: float) -> bool:
    """Reject non-finite nodes and nodes far outside any playable area.

    graph2.dat carries one uninitialised node at roughly (-26077, 127767,
    9269) metres.  Emitting it would be exactly the "garbage" this pipeline is
    meant to avoid, so nodes beyond `max_extent` metres on any axis are
    dropped and reported.
    """
    if not all(math.isfinite(v) for v in position):
        return False
    return all(abs(v) <= max_extent for v in position)


# ---------------------------------------------------------------------------
# entry points
# ---------------------------------------------------------------------------

def build_nav_with_stats(raw_graphs_dir,
                         units_per_meter: float = DEFAULT_UNITS_PER_METER,
                         up_axis: str = DEFAULT_UP_AXIS,
                         offset=(0.0, 0.0, 0.0),
                         max_extent: float = DEFAULT_MAX_EXTENT):
    """Parse every graphs/*.dat under `raw_graphs_dir` into one NavGraph.

    Node ids are per-graph, so each graph's ids are remapped onto the merged
    node array; links are rewritten to those indices.  Links pointing at an id
    that was dropped or is absent from its own graph are discarded and
    counted, never guessed.

    Returns ``(graph, report)`` where `graph` is the contracts.ts `NavGraph`.
    """
    raw_graphs_dir = Path(raw_graphs_dir)
    files = sorted(raw_graphs_dir.glob("*.dat"))
    if not files:
        raise GraphError(f"no *.dat graph files under {raw_graphs_dir}")

    nodes = []
    report = {"graphs": [], "nodeCount": 0, "linkCount": 0,
              "droppedNodes": 0, "droppedLinks": 0, "failed": [],
              "unitsPerMeter": units_per_meter, "upAxis": up_axis,
              "offset": list(offset), "maxExtent": max_extent}

    for path in files:
        try:
            parsed = parse_graph(path, name=path.name)
        except (GraphError, OSError) as exc:
            report["failed"].append({"file": path.name, "error": str(exc)})
            continue

        local_to_global = {}
        kept = dropped = 0
        for node in parsed["nodes"]:
            position = transform_position(node["position"], units_per_meter,
                                          up_axis, offset)
            if not _plausible(position, max_extent):
                dropped += 1
                continue
            local_to_global[node["id"]] = len(nodes)
            nodes.append({"position": [round(v, 4) for v in position],
                          "links": []})
            kept += 1

        graph_links = missing = 0
        for link in parsed["links"]:
            a = local_to_global.get(link["a"])
            b = local_to_global.get(link["b"])
            if a is None or b is None or a == b:
                missing += 1
                continue
            # Undirected: record once in each direction, avoiding duplicates.
            if b not in nodes[a]["links"]:
                nodes[a]["links"].append(b)
            if a not in nodes[b]["links"]:
                nodes[b]["links"].append(a)
            graph_links += 1

        for entry in nodes:
            entry["links"].sort()

        report["graphs"].append({
            "file": path.name,
            "bytes": path.stat().st_size,
            "maxNodes": parsed["max_nodes"],
            "parsedNodes": len(parsed["nodes"]),
            "keptNodes": kept,
            "droppedNodes": dropped,
            "parsedLinks": len(parsed["links"]),
            "keptLinks": graph_links,
            "droppedLinks": missing,
            "nodeOffset": parsed["node_offset"],
            "exactEof": parsed["consumed"] == path.stat().st_size,
            "warnings": parsed["warnings"],
        })
        report["droppedNodes"] += dropped
        report["droppedLinks"] += missing

    report["nodeCount"] = len(nodes)
    report["linkCount"] = sum(len(n["links"]) for n in nodes) // 2
    return {"nodes": nodes}, report


def build_nav(raw_graphs_dir, **kwargs):
    """Parse graphs/*.dat into a `NavGraph` (contracts.ts).

    See `build_nav_with_stats` for the keyword arguments and diagnostics.
    """
    graph, _ = build_nav_with_stats(raw_graphs_dir, **kwargs)
    return graph


def write_nav(graph, path):
    """Write a NavGraph to `path` as nav.json.  Returns the byte count."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(graph, separators=(",", ":"), sort_keys=False)
    path.write_text(text + "\n", encoding="utf-8")
    return len(text) + 1


__all__ = [
    "GraphError", "parse_graph", "transform_position", "build_nav",
    "build_nav_with_stats", "write_nav", "GRAPH_MAGIC",
    "DEFAULT_UNITS_PER_METER", "DEFAULT_UP_AXIS", "DEFAULT_MAX_EXTENT",
]
