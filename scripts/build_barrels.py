"""Sketchfab "FREE Lowpoly Barrels Set" (Gamefruit, CC-BY-4.0) -> proto/public/models/barrels.glb.

Headless:
    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
        --python scripts/build_barrels.py

Or inside Blender:
    import sys; sys.path.append('/Users/stellanjohansson/Cursor/Blender-Test01/scripts')
    import build_barrels, importlib; importlib.reload(build_barrels)
    build_barrels.build(export=True)

The source holds four copies of the same drum mesh, one per material (BLUE / RED / YELLOW / OLD),
with 2K PNG textures (~68 MB). Output: four objects named by colour code (Barrel_Red, ...), each
scaled to a 55 US-gal drum, origin at the base centre, Z up, plus 512² JPEG textures.
Each object carries a `barrel_kind` custom prop (-> three.js userData.barrel_kind).
"""
import os

import bpy
from mathutils import Matrix, Vector

ROOT = "/Users/stellanjohansson/Cursor/Blender-Test01"
SOURCE = os.path.join(ROOT, "3D assets", "free_lowpoly_barrels_set.glb")
GAME_MODEL = os.path.join(ROOT, "proto", "public", "models", "barrels.glb")
COLLECTION = "Barrels"
HEIGHT = 0.88   # m, standard 55-gal steel drum
TEX = 512
KINDS = ("RED", "BLUE", "YELLOW", "OLD")
LOD_RATIOS = (0.4, 0.12)   # collapse ratios for <name>_LOD1, _LOD2 (LOD0 is the source, 962 tris)


def _kind_of(obj):
    for o in (obj, *_ancestors(obj)):
        for k in KINDS:
            if f"barrel_{k}" in o.name:
                return k
    for slot in obj.material_slots:
        for k in KINDS:
            if slot.material and slot.material.name.endswith(k):
                return k
    return None


def _ancestors(obj):
    p = obj.parent
    while p:
        yield p
        p = p.parent


def _make_lods(src, col):
    """Decimated copies `<name>_LOD1..` beside the source (same material, stacked +Y for viewing)."""
    base = len(src.data.polygons)
    for lvl, ratio in enumerate(LOD_RATIOS, start=1):
        obj = src.copy()
        obj.data = src.data.copy()
        obj.name = obj.data.name = f"{src.name}_LOD{lvl}"
        obj.location.y = lvl * 0.8
        col.objects.link(obj)
        mod = obj.modifiers.new("Decimate", 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        ev = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        mesh = bpy.data.meshes.new_from_object(ev)
        obj.modifiers.clear()
        old = obj.data
        obj.data = mesh
        bpy.data.meshes.remove(old)
        mesh.name = obj.name
        print(f"  {obj.name}: {base} -> {len(mesh.polygons)} faces")


def build(export=False):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=SOURCE)

    col = bpy.data.collections.new(COLLECTION)
    bpy.context.scene.collection.children.link(col)

    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    assert len(meshes) == 4, f"expected 4 barrel meshes, got {len(meshes)}"

    for i, obj in enumerate(sorted(meshes, key=lambda o: KINDS.index(_kind_of(o)))):
        kind = _kind_of(obj)
        assert kind, obj.name
        mw = obj.matrix_world.copy()
        obj.parent = None
        obj.data.transform(mw)
        obj.matrix_world = Matrix.Identity(4)

        vs = [v.co for v in obj.data.vertices]
        lo = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
        hi = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
        size = hi - lo
        assert size.z > size.x and size.z > size.y, f"{kind}: drum axis not Z ({size})"
        s = HEIGHT / size.z
        obj.data.transform(Matrix.Scale(s, 4) @ Matrix.Translation(
            Vector((-(lo.x + hi.x) * 0.5, -(lo.y + hi.y) * 0.5, -lo.z))))

        name = f"Barrel_{kind.capitalize()}"
        obj.name = obj.data.name = name
        obj["barrel_kind"] = kind.lower()
        mat = obj.material_slots[0].material
        mat.name = f"M_{name}"
        for c in obj.users_collection:
            c.objects.unlink(obj)
        col.objects.link(obj)
        obj.location.x = i * 0.8   # spread out for viewing; the game ignores node transforms
        print(f"{name}: {size.x * s:.3f} x {size.y * s:.3f} x {HEIGHT:.3f} m")
        _make_lods(obj, col)

    for o in [o for o in bpy.data.objects if o.type != 'MESH']:
        bpy.data.objects.remove(o)

    for img in bpy.data.images:
        if img.size[0] > TEX:
            img.scale(TEX, TEX)

    if export:
        export_glb(GAME_MODEL)


def export_glb(path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in bpy.data.collections[COLLECTION].all_objects:
        o.select_set(True)
    props = {p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties}
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_apply=True,
              export_yup=True, export_extras=True, export_animations=False,
              export_image_format='JPEG', export_jpeg_quality=88, export_image_quality=88)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in props})
    print("exported", path, f"{os.path.getsize(path) / 1024:.0f} KB")


if __name__ == "__main__":
    build(export=True)
