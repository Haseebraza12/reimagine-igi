"""Mission task tree (objects.qvm) and terrain script (terrain.qvm) decoding.

Python counterpart of web-port/src/loaders/tasks.ts. Built on
igi_qvm.QVM.call_tree(); nothing is executed.

objects.qvm declares parameter schemas with
    Task_DeclareParameters(type, name0, kind0, name1, kind1, ...)
and instantiates tasks with
    Task_New(id, type, name, <params per schema>..., <child Task_New>...)
Serialized widths (with these, every declared task in level 1 consumes its
arguments exactly and the remainder are always child Task_New calls):
    ObjectPos, RGB, Real32x3, Real64x3 -> 3; Real32x9 -> 3 (alpha, beta, gamma
    Euler angles); Graph -> 3 (node count, capacity, link count);
    AnimData -> 1 + 2n (count n, then n pairs); everything else -> 1.
"""
from pathlib import Path

from igi_formats import FormatError
from igi_qvm import QVM

WIDTH = {"ObjectPos": 3, "RGB": 3, "Real32x3": 3, "Real64x3": 3, "Real32x9": 3, "Graph": 3}


def _is_task(value):
    return isinstance(value, dict) and value.get("fn") == "Task_New"


def read_tasks(objects_qvm_bytes):
    """Every Task_New in file (depth-first, parents first) as dicts:
    {"order", "id", "type", "name", "params", "children", "parent"}."""
    tree = QVM(objects_qvm_bytes).call_tree()
    schemas = {}
    for statement in tree:
        if statement["fn"] == "Task_DeclareParameters":
            args = statement["args"]
            schemas[args[0]] = list(zip(args[1::2], args[2::2]))
    out = []

    def decode(call, parent):
        task_id, task_type, name, *rest = call["args"]
        params = {}
        i = 0
        for pname, kind in schemas.get(task_type, []):
            if kind == "AnimData":
                width = 1 + 2 * int(rest[i])
            else:
                width = WIDTH.get(kind, 1)
            if i + width > len(rest):
                raise FormatError(f"{task_type} task {task_id} is missing parameter {pname!r}")
            params[pname] = rest[i:i + width] if width > 1 else rest[i]
            i += width
        task = {"order": len(out), "id": task_id, "type": task_type, "name": name,
                "params": params, "children": [], "parent": parent}
        out.append(task)
        for child in rest[i:]:
            if not _is_task(child):
                raise FormatError(f"{task_type} task {task_id} has a non-task argument after its parameters")
            task["children"].append(decode(child, task))
        return task

    for statement in tree:
        if statement["fn"] == "Task_New":
            decode(statement, None)
    return out


def terrain_script(terrain_qvm_bytes):
    """(materials, tilemaps) from terrain.qvm CreateTerrainMaterial / CreateTerrainTileMap."""
    materials, tilemaps = {}, {}
    for call in QVM(terrain_qvm_bytes).call_tree():
        values = [int(v) if isinstance(v, bool) else v for v in call["args"]]
        if call["fn"] == "CreateTerrainMaterial":
            material_id, arg1, *records = values
            if len(records) % 7:
                raise FormatError("CreateTerrainMaterial records are not 7 values each")
            levels = [{"enabled": bool(records[k]), "p2": records[k + 1], "p3": records[k + 2],
                       "scaleA_arg": records[k + 3], "tilemapA": records[k + 4],
                       "scaleB_arg": records[k + 5], "tilemapB": records[k + 6]}
                      for k in range(0, len(records), 7)]
            materials[material_id] = {"arg1": arg1, "levels": levels}
        elif call["fn"] == "CreateTerrainTileMap":
            if len(values) != 65:
                raise FormatError("CreateTerrainTileMap does not have 64 entries")
            tilemaps[values[0]] = values[1:]
    return materials, tilemaps


def terrain_inputs(objects_qvm_bytes, terrain_qvm_bytes):
    """Everything tools/terrain_tex.py needs, from the original files."""
    tasks = read_tasks(objects_qvm_bytes)
    materials, tilemaps = terrain_script(terrain_qvm_bytes)

    def of(task_type):
        return [t for t in tasks if t["type"] == task_type]

    return {
        "source": "objects.qvm + terrain.qvm (tools/level_tasks.py)",
        "materials": materials,
        "tilemaps": tilemaps,
        "texture_modifiers": [
            {"order": t["order"], "name": t["name"], "position": t["params"]["Position"],
             "level": t["params"]["Level"], "material": t["params"]["Material Index"],
             "bitmap_id": t["params"]["Bitmap ID"], "size": t["params"]["Size"],
             "is_edit": t["params"]["isEdit"]} for t in of("TextureModifier")],
        "terrain_lightmaps": [
            {"order": t["order"], "position": t["params"]["Position"], "level": t["params"]["Level"],
             "size": t["params"]["Size"], "texture_index": t["params"]["TextureIndex"]}
            for t in of("TerrainLightMap")],
        "heightmaps": [
            {"position": t["params"]["Position"], "level": t["params"]["Level"],
             "size": t["params"]["Size"], "bitmap_id": t["params"]["Bitmap ID"]} for t in of("HeightMap")],
        "global_light_keyframes": [
            {"time": t["params"]["Time"], "ambient_terrain": t["params"]["Ambient color terrain"],
             "fog_color_terrain": t["params"]["Fog color terrain"],
             "fog_density_terrain": t["params"]["Fog density terrain"]} for t in of("GlobalLightKeyframe")],
        "dirlight_keyframes": [
            {"time": t["params"]["Time"], "beta": t["params"]["Beta"], "gamma": t["params"]["Gamma"],
             "front_color": t["params"]["Front Color"], "back_color": t["params"]["Back Color"]}
            for t in of("DirlightKeyframe")],
    }


if __name__ == "__main__":
    import argparse
    import collections
    import json
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("objects_qvm", type=Path)
    args = parser.parse_args()
    tasks = read_tasks(args.objects_qvm.read_bytes())
    print(json.dumps({"tasks": len(tasks),
                      "types": dict(collections.Counter(t["type"] for t in tasks).most_common())}, indent=2))


def building_inputs(objects_qvm_bytes):
    """Buildings, their LightmapInfo and model-bearing descendant tasks (pre-order),
    plus object light keyframes: everything tools/object_lighting.py needs."""
    tasks = read_tasks(objects_qvm_bytes)
    buildings = []
    for t in tasks:
        if t["type"] != "Building":
            continue
        info = [c for c in t["children"] if c["type"] == "LightmapInfo"]
        descendants = []

        def walk(parent, depth):
            for child in parent["children"]:
                model = child["params"].get("Model")
                if isinstance(model, str) and model:
                    descendants.append({"type": child["type"], "model": model, "depth": depth,
                                        "position": child["params"].get("Position"),
                                        "orientation": child["params"].get("Orientation")})
                walk(child, depth + 1)

        walk(t, 1)
        buildings.append({"id": t["id"], "name": t["name"], "model": t["params"]["Model"],
                          "position": t["params"]["Position"], "orientation": t["params"]["Orientation"],
                          "lightmap_info": info[0]["params"] if info else None,
                          "descendant_models": descendants})
    effects = {}
    for t in tasks:
        if t["type"] == "EditRigidObj":
            key = (tuple(t["params"]["Dirlight Angular Effect"]), tuple(t["params"]["Dirlight Ambient Effect"]))
            effects[key] = effects.get(key, 0) + 1
    return {
        "source": "objects.qvm (tools/level_tasks.py)",
        "buildings": buildings,
        "edit_rigid_effects": [{"angular": list(k[0]), "ambient": list(k[1]), "count": v}
                               for k, v in sorted(effects.items(), key=lambda kv: -kv[1])],
        "global_light_keyframes": [
            {"time": t["params"]["Time"], "ambient_terrain": t["params"]["Ambient color terrain"],
             "ambient_object": [t["params"]["Ambient color object category %d" % k] for k in (1, 2, 3, 4)],
             "fog_color_object": [t["params"]["Fog color object category %d" % k] for k in (1, 2, 3, 4)],
             "fog_density_object": [t["params"]["Fog density object category %d" % k] for k in (1, 2, 3, 4)]}
            for t in tasks if t["type"] == "GlobalLightKeyframe"],
        "dirlight_keyframes": [
            {"time": t["params"]["Time"], "beta": t["params"]["Beta"], "gamma": t["params"]["Gamma"],
             "front_color": t["params"]["Front Color"], "back_color": t["params"]["Back Color"]}
            for t in tasks if t["type"] == "DirlightKeyframe"],
    }
