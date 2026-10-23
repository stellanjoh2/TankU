"""Decimated LODs for the tropical vegetation pack. Run inside Blender (scene imported from vegetation.glb):

    import sys; sys.path.append('/Users/stellanjohansson/Cursor/Blender-Test01/scripts')
    import build_vegetation_lods, importlib; importlib.reload(build_vegetation_lods)
    build_vegetation_lods.build_and_export()

Each source mesh `<name>` gets unparented copies `<name>_LOD1..3` (same world transform) in the
`VegetationLODs` collection, which lives in its own `VegetationLODs` scene. Only the LOD meshes are exported; the game reuses LOD0 materials.
"""
import os
import bpy

ROOT = "/Users/stellanjohansson/Cursor/Blender-Test01"
OUT = os.path.join(ROOT, "proto", "public", "models", "vegetation_lods.glb")
COLL = "VegetationLODs"
PREFIXES = ("Palm_", "Bush_", "Plant_", "Dry_Plant_", "Rocks_low")

# Collapse ratios for LOD1..3. Leaf cards keep more so their curvature doesn't fold flat too early.
RATIOS = {
    "solid": (0.5, 0.25, 0.1),
    "foliage": (0.6, 0.35, 0.2),
}
# Below this many faces a level is skipped (the game falls back to the previous level).
MIN_FACES = 24


def _kind(obj):
    names = " ".join(m.name.lower() for m in obj.data.materials if m)
    return "foliage" if any(k in names for k in ("leaf", "leaves", "veget", "plant", "atlas")) else "solid"


def sources():
    return [o for o in bpy.data.objects
            if o.type == 'MESH' and "_LOD" not in o.name and o.parent and o.parent.name.startswith(PREFIXES)]


def build():
    coll = bpy.data.collections.get(COLL)
    if coll:
        for o in list(coll.objects):
            bpy.data.objects.remove(o, do_unlink=True)
        for sc in bpy.data.scenes:
            if coll.name in sc.collection.children:
                sc.collection.children.unlink(coll)
    else:
        coll = bpy.data.collections.new(COLL)
    bpy.data.scenes[COLL].collection.children.link(coll)

    made = []
    for src in sources():
        base = len(src.data.polygons)
        prev = base
        for lvl, ratio in enumerate(RATIOS[_kind(src)], start=1):
            obj = src.copy()
            obj.data = src.data.copy()
            obj.name = obj.data.name = f"{src.name}_LOD{lvl}"
            obj.parent = None
            obj.matrix_world = src.matrix_world.copy()
            coll.objects.link(obj)
            mod = obj.modifiers.new("Decimate", 'DECIMATE')
            mod.decimate_type = 'COLLAPSE'
            mod.ratio = ratio
            ev = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
            mesh = bpy.data.meshes.new_from_object(ev)
            obj.modifiers.clear()
            old = obj.data
            obj.data = mesh
            mesh.name = obj.name
            bpy.data.meshes.remove(old)
            faces = len(mesh.polygons)
            if faces < MIN_FACES or faces >= prev:
                bpy.data.objects.remove(obj, do_unlink=True)
                bpy.data.meshes.remove(mesh)
                break
            prev = faces
            made.append((obj.name, base, faces))
    for name, base, faces in made:
        print(f"{name}: {base} -> {faces}")
    return coll


def export(coll):
    props = {p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties}
    kw = dict(filepath=OUT, export_format='GLB', use_selection=False, use_active_scene=True,
              export_apply=True, export_yup=True, export_materials='PLACEHOLDER',
              export_animations=False, export_texcoords=True, export_normals=True)
    bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in props})
    print("exported", OUT, len(coll.objects), "meshes")


def build_and_export():
    """Build + export with the dedicated LOD scene active (depsgraph and exporter follow it)."""
    scene = bpy.data.scenes.get(COLL) or bpy.data.scenes.new(COLL)
    win = bpy.context.window
    prev = win.scene
    win.scene = scene
    try:
        export(build())
    finally:
        win.scene = prev
