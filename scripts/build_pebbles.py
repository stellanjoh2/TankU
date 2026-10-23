"""Small pebbles and stones -> proto/public/models/pebbles.glb. Run inside Blender:

    import sys; sys.path.append('/Users/stellanjohansson/Cursor/Blender-Test01/scripts')
    import build_pebbles, importlib; importlib.reload(build_pebbles)
    build_pebbles.build(export=True)

Units are metres, Z up. Each mesh origin is the bounding-box centre, so placing
that origin on the ground buries the stone halfway. The game replaces the
viewport material with the terrain ground shader.
"""
import json
import os
import random
import struct

import bpy
import bmesh
from mathutils import Vector, noise

ROOT = "/Users/stellanjohansson/Cursor/Blender-Test01"
GAME_MODEL = os.path.join(ROOT, "proto", "public", "models", "pebbles.glb")
ROCK_COLOR = os.path.join(ROOT, "proto", "public", "textures", "ground", "rock_color.jpg")

# Full extents in metres (X, Y, height). Pebbles first, then the small stones.
VARIANTS = [
    # name, subdiv, seed, size, lumps, chips
    ("Pebble_A", 2, 11, (1.08, 0.76, 0.40), 0.12, 1),
    ("Pebble_B", 2, 27, (1.44, 1.04, 0.64), 0.16, 2),
    ("Pebble_C", 2, 43, (0.88, 0.68, 0.56), 0.14, 2),
    ("Stone_A", 3, 71, (2.64, 1.92, 1.32), 0.18, 2),
    ("Stone_B", 3, 93, (4.08, 2.76, 1.88), 0.20, 3),
]


def _ground_material():
    mat = bpy.data.materials.get("PebbleGround")
    if mat is None:
        mat = bpy.data.materials.new("PebbleGround")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    tex = next((n for n in nt.nodes if n.type == "TEX_IMAGE"), None)
    if tex is None:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.location = (-360, 280)
    img = bpy.data.images.load(ROCK_COLOR, check_existing=True)
    img.colorspace_settings.name = "sRGB"
    tex.image = img
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    if "Roughness" in bsdf.inputs:
        bsdf.inputs["Roughness"].default_value = 0.94
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.15
    return mat


def _collection():
    col = bpy.data.collections.get("Pebbles")
    if col is None:
        col = bpy.data.collections.new("Pebbles")
        bpy.context.scene.collection.children.link(col)
    return col


def _clear_old():
    doomed = [
        o for o in list(bpy.data.objects)
        if o.name.startswith("Pebble_") or o.name.startswith("Stone_")
        or o.name == "PebblePreviewGround"
    ]
    for obj in doomed:
        mesh = obj.data if obj.type == "MESH" else None
        bpy.data.objects.remove(obj, do_unlink=True)
        if mesh is not None and mesh.users == 0:
            bpy.data.meshes.remove(mesh)


def _lump(bm, rng, amp):
    seed = Vector((rng.random() * 8, rng.random() * 8, rng.random() * 8))
    for v in bm.verts:
        p = v.co * 1.6 + seed
        n = noise.noise(p) + 0.45 * noise.noise(p * 2.3 + Vector((2.0, 0.4, 1.1)))
        direction = v.co.normalized() if v.co.length > 1e-6 else Vector((0, 0, 1))
        v.co += direction * (amp * n)


def _pinch(bm, rng):
    axis = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.4, 0.8))).normalized()
    keep = rng.uniform(0.45, 0.75)
    for v in bm.verts:
        d = v.co.dot(axis)
        v.co -= axis * d * (1 - keep)


def _chip(bm, rng):
    axis = Vector((
        rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-0.2, 1),
    )).normalized()
    rad = max((v.co.length for v in bm.verts), default=1.0)
    plane = rad * rng.uniform(0.12, 0.42)
    for v in bm.verts:
        d = v.co.dot(axis)
        if d > plane:
            v.co -= axis * (d - plane)


def _fit(bm, size):
    xs = [v.co.x for v in bm.verts]
    ys = [v.co.y for v in bm.verts]
    zs = [v.co.z for v in bm.verts]
    spans = (max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))
    center = (
        (min(xs) + max(xs)) * 0.5,
        (min(ys) + max(ys)) * 0.5,
        (min(zs) + max(zs)) * 0.5,
    )
    scale = tuple(size[i] / spans[i] if spans[i] > 1e-8 else 1.0 for i in range(3))
    for v in bm.verts:
        v.co.x = (v.co.x - center[0]) * scale[0]
        v.co.y = (v.co.y - center[1]) * scale[1]
        v.co.z = (v.co.z - center[2]) * scale[2]


def _uv(bm, size, seed):
    layer = bm.loops.layers.uv.verify()
    ox = (seed % 7) * 0.13
    oy = ((seed * 3) % 5) * 0.17
    sx = size[0] if size[0] else 1
    sy = size[1] if size[1] else 1
    for face in bm.faces:
        for loop in face.loops:
            co = loop.vert.co
            loop[layer].uv = (ox + (co.x / sx + 0.5) * 0.35, oy + (co.y / sy + 0.5) * 0.35)


def _make_mesh(name, subdiv, seed, size, amp, chips):
    rng = random.Random(seed)
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=1.0)
    bm.verts.ensure_lookup_table()
    # Start as a rough ellipsoid so the noise isn't spherical.
    squash = (rng.uniform(0.75, 1.15), rng.uniform(0.7, 1.1), rng.uniform(0.45, 0.85))
    for v in bm.verts:
        v.co.x *= squash[0]
        v.co.y *= squash[1]
        v.co.z *= squash[2]
    _lump(bm, rng, amp)
    _pinch(bm, rng)
    for _ in range(chips):
        _chip(bm, rng)
    bmesh.ops.smooth_vert(
        bm, verts=list(bm.verts), factor=0.06,
        use_axis_x=True, use_axis_y=True, use_axis_z=True,
    )
    _fit(bm, size)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    _uv(bm, size, seed)
    bm.to_mesh(mesh)
    bm.free()
    for poly in mesh.polygons:
        poly.use_smooth = True
    return mesh


def export_glb(objects):
    # The open file is the bridge. Its geometry-node instances export even when
    # nothing is selected, so the pebbles go out from a scene that contains only them.
    if bpy.context.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    src = bpy.context.window.scene
    tmp = bpy.data.scenes.new("_PebbleExport")
    col = bpy.data.collections.new("_PebbleExport")
    tmp.collection.children.link(col)
    for obj in objects:
        col.objects.link(obj)
        obj.hide_set(False)
    bpy.context.window.scene = tmp
    try:
        bpy.ops.object.select_all(action="SELECT")
        props = {p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties}
        kw = dict(
            filepath=GAME_MODEL,
            export_format="GLB",
            use_selection=True,
            export_apply=True,
            export_yup=True,
        )
        os.makedirs(os.path.dirname(GAME_MODEL), exist_ok=True)
        kw["use_active_scene"] = True
        bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in props})
    finally:
        bpy.context.window.scene = src
        for obj in list(col.objects):
            col.objects.unlink(obj)
        bpy.data.scenes.remove(tmp)
        bpy.data.collections.remove(col)
    _strip_other_meshes(GAME_MODEL, {o.name for o in objects})
    print("exported", GAME_MODEL, os.path.getsize(GAME_MODEL))


def _strip_other_meshes(path, keep_names):
    """Drop bridge geometry-node instances the exporter refuses to filter out."""
    data = open(path, "rb").read()
    off = 12
    chunks = []
    while off < len(data):
        ln, typ = struct.unpack_from("<I4s", data, off)
        chunks.append((typ, data[off + 8:off + 8 + ln]))
        off += 8 + ln
    js = json.loads(chunks[0][1])
    nodes = js.get("nodes", [])
    keep_idx = [i for i, n in enumerate(nodes) if n.get("name") in keep_names]
    remap = {old: new for new, old in enumerate(keep_idx)}
    new_nodes = []
    for i in keep_idx:
        node = dict(nodes[i])
        if "children" in node:
            kids = [remap[c] for c in node["children"] if c in remap]
            if kids:
                node["children"] = kids
            else:
                del node["children"]
        new_nodes.append(node)
    used = sorted({n["mesh"] for n in new_nodes if "mesh" in n})
    mesh_map = {old: new for new, old in enumerate(used)}
    js["meshes"] = [js["meshes"][i] for i in used]
    for node in new_nodes:
        if "mesh" in node:
            node["mesh"] = mesh_map[node["mesh"]]
    js["nodes"] = new_nodes
    for scene in js.get("scenes", []):
        scene["nodes"] = [remap[i] for i in scene.get("nodes", []) if i in remap]
    raw = json.dumps(js, separators=(",", ":")).encode("utf-8")
    raw += b" " * ((4 - len(raw) % 4) % 4)
    blob = chunks[1][1]
    out = bytearray()
    out += struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(raw) + 8 + len(blob))
    out += struct.pack("<I4s", len(raw), b"JSON")
    out += raw
    out += struct.pack("<I4s", len(blob), b"BIN\x00")
    out += blob
    open(path, "wb").write(out)
    print("glb nodes", [n.get("name") for n in new_nodes])


def build(export=True):
    _clear_old()
    col = _collection()
    mat = _ground_material()
    objects = []
    gap = 4.6
    for i, (name, subdiv, seed, size, amp, chips) in enumerate(VARIANTS):
        mesh = _make_mesh(name, subdiv, seed, size, amp, chips)
        obj = bpy.data.objects.new(name, mesh)
        col.objects.link(obj)
        obj.data.materials.append(mat)
        # Parked off the bridge the file was open on. Mesh data stays centred.
        obj.location = (40 + i * gap, -20, 0)
        objects.append(obj)
        xs = [v.co.x for v in mesh.vertices]
        ys = [v.co.y for v in mesh.vertices]
        zs = [v.co.z for v in mesh.vertices]
        print(
            f"{name} faces={len(mesh.polygons)} "
            f"size=({max(xs)-min(xs):.3f}, {max(ys)-min(ys):.3f}, {max(zs)-min(zs):.3f}) "
            f"center=({(min(xs)+max(xs))*0.5:.4f}, {(min(ys)+max(ys))*0.5:.4f}, {(min(zs)+max(zs))*0.5:.4f})"
        )
    if export:
        saved = [o.location.copy() for o in objects]
        for obj in objects:
            obj.location = (0, 0, 0)
        export_glb(objects)
        for obj, loc in zip(objects, saved):
            obj.location = loc
    return objects
