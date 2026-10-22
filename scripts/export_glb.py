"""GLB export for the Sherman. Run inside Blender:

    import sys; sys.path.append('/Users/stellanjohansson/Cursor/Blender-Test01/scripts')
    import export_glb, importlib; importlib.reload(export_glb)
    export_glb.export_all()

Custom properties (track paths, link positions, spin radii, pivots...) go out as glTF extras, which
three.js exposes as Object3D.userData. Animated exports still need merge_glb_animations.py afterwards.
"""
import os
import bpy

ROOT = "/Users/stellanjohansson/Cursor/Blender-Test01"
EXPORT_DIR = os.path.join(ROOT, "exports")
GAME_MODEL = os.path.join(ROOT, "proto", "public", "models", "sherman.glb")


def export(path, animations=False):
    sc = bpy.context.scene
    sc.frame_set(0)
    bpy.ops.object.select_all(action='DESELECT')
    for o in bpy.data.collections["Sherman"].all_objects:
        o.hide_set(False)
        o.select_set(True)
    props = {p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties}
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_apply=True,
              export_yup=True, export_extras=True, export_animations=animations,
              export_animation_mode='SCENE', export_frame_range=True, export_force_sampling=True,
              export_optimize_animation_size=True)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in props})
    bpy.ops.object.select_all(action='DESELECT')
    print("exported", path)


def export_all():
    export(os.path.join(EXPORT_DIR, "sherman_anim.glb"), animations=True)
    export(os.path.join(EXPORT_DIR, "sherman_static.glb"))
    export(GAME_MODEL)
