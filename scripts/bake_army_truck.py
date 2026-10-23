"""UV layout + AO bake for the army truck. Run inside Blender after build_army_truck.py:

    import sys; sys.path.append('/Users/stellanjohansson/Cursor/Blender-Test01/scripts')
    import bake_army_truck, importlib; importlib.reload(bake_army_truck)
    bake_army_truck.apply_modifiers(); bake_army_truck.unwrap()
    for st in ('ao', 'color', 'material'): bake_army_truck.bake(st)
    bake_army_truck.combine()
    # or: bake_army_truck.run_all_async(), then poll bake_army_truck.STATUS

LOD0 gets the full 512² atlas (Color×AO + ORM, same combine as bake_ao.py).
LOD1 / LOD2 keep flat material clones so they don't sample the lightmap.
"""
import os
from math import radians

import bpy
import numpy as np

COLLECTION = "ArmyTruck"
LOD0_NAME = "ArmyTruck"
OUT_DIR = "/Users/stellanjohansson/Cursor/Blender-Test01/textures"
RES = 512
PACK_MARGIN = 0.004          # fraction of UV space (~2 px at 512)
BAKE_MARGIN = 2
AO_DISTANCE = 0.8            # metres — truck is taller / longer than a drum
SAMPLES = 32
TEXTURE_NODES = ("ColorAO", "RoughMetal", "RoughMetalSplit")
CREVICE_ROUGHNESS = 0.12
PREFIX = "ArmyTruck"


def meshes():
    """LOD0 only — lightmap atlas is for the near mesh."""
    o = bpy.data.objects.get(LOD0_NAME)
    return [o] if o and o.type == "MESH" else []


def unique_mesh_objects():
    return meshes()


def _materials():
    return {s.material for o in meshes() for s in o.material_slots if s.material}


def _bsdf(mat):
    return next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")


def _strip_texture_nodes():
    for mat in _materials():
        for nm in TEXTURE_NODES:
            old = mat.node_tree.nodes.get(nm)
            if old:
                mat.node_tree.nodes.remove(old)


def apply_modifiers():
    dg = bpy.context.evaluated_depsgraph_get()
    n = 0
    for o in meshes():
        if not o.modifiers:
            continue
        new = bpy.data.meshes.new_from_object(o.evaluated_get(dg), preserve_all_data_layers=True,
                                              depsgraph=dg)
        old = o.data
        name = old.name
        o.modifiers.clear()
        o.data = new
        if old.users == 0:
            bpy.data.meshes.remove(old)
        new.name = name
        n += 1
    print("applied modifiers on", n, "objects")


def _view3d_override():
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type == "VIEW_3D":
                region = next(r for r in area.regions if r.type == "WINDOW")
                return dict(window=win, area=area, region=region, screen=win.screen)
    raise RuntimeError("no 3D viewport found")


def unwrap():
    objs = unique_mesh_objects()
    for o in objs:
        if not o.data.uv_layers:
            o.data.uv_layers.new(name="UVMap")
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    with bpy.context.temp_override(**_view3d_override()):
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=radians(66), island_margin=0.0,
                                 area_weight=1.0, correct_aspect=True, scale_to_bounds=False)
        bpy.ops.uv.select_all(action="SELECT")
        bpy.ops.uv.average_islands_scale()
        bpy.ops.uv.pack_islands(rotate=True, rotate_method="ANY", shape_method="CONCAVE",
                                margin_method="FRACTION", margin=PACK_MARGIN)
        bpy.ops.object.mode_set(mode="OBJECT")
    print("unwrapped", len(objs), "unique meshes @", RES)


def _image(name, color):
    img = bpy.data.images.get(name)
    if img is None or tuple(img.size) != (RES, RES):
        if img:
            bpy.data.images.remove(img)
        img = bpy.data.images.new(name, RES, RES, alpha=False, float_buffer=True)
    img.colorspace_settings.name = "Non-Color"
    px = np.empty((RES * RES, 4), dtype=np.float32)
    px[:] = color
    img.pixels.foreach_set(px.ravel())
    return img


def _set_bake_target(img):
    for mat in _materials():
        nt = mat.node_tree
        node = nt.nodes.get("BakeTarget") or nt.nodes.new("ShaderNodeTexImage")
        node.name = node.label = "BakeTarget"
        node.location = (-600, -300)
        node.image = img
        nt.nodes.active = node


def _setup_cycles():
    sc = bpy.context.scene
    try:
        sc.render.engine = "CYCLES"
    except TypeError as e:
        raise RuntimeError(f"Cycles unavailable: {e}")
    sc.cycles.samples = SAMPLES
    try:
        bpy.context.preferences.addons["cycles"].preferences.compute_device_type = "NONE"
    except Exception as e:
        print("could not reset compute device:", e)
    sc.cycles.device = "CPU"
    if sc.world is None:
        sc.world = bpy.data.worlds.new("World")
    sc.world.light_settings.distance = AO_DISTANCE
    b = sc.render.bake
    b.margin = BAKE_MARGIN
    b.margin_type = "EXTEND"
    b.use_clear = False
    b.use_selected_to_active = False
    print("cycles device:", sc.cycles.device, "samples:", SAMPLES)


def _ground():
    me = bpy.data.meshes.new("_AO_Ground")
    me.from_pydata([(-10, -10, 0), (10, -10, 0), (10, 10, 0), (-10, 10, 0)], [], [(0, 1, 2, 3)])
    ob = bpy.data.objects.new("_AO_Ground", me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def _bake(objs, bake_type, **kw):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.bake(type=bake_type, **kw)


def _bake_all(bake_type, **kw):
    objs = unique_mesh_objects()
    # Hide LOD1/2 so they don't occlude the AO bake (they sit nearby for viewing).
    others = [o for o in bpy.data.collections[COLLECTION].all_objects
              if o.type == "MESH" and o not in objs and not o.hide_render]
    for x in others:
        x.hide_render = True
    ground = _ground() if bake_type == "AO" else None
    try:
        _bake(objs, bake_type, **kw)
    finally:
        for x in others:
            x.hide_render = False
        if ground:
            me = ground.data
            bpy.data.objects.remove(ground, do_unlink=True)
            bpy.data.meshes.remove(me)


def _bake_flat_color(img, color_of):
    bpy.context.scene.cycles.samples = 1
    _set_bake_target(img)
    saved = {}
    for mat in _materials():
        bsdf = _bsdf(mat)
        col, met = bsdf.inputs["Base Color"], bsdf.inputs["Metallic"]
        saved[mat.name] = (tuple(col.default_value), met.default_value)
        col.default_value = color_of(bsdf)
        met.default_value = 0.0
    try:
        _bake_all("DIFFUSE", pass_filter={"COLOR"})
    finally:
        for mat in _materials():
            bsdf = _bsdf(mat)
            bsdf.inputs["Base Color"].default_value, bsdf.inputs["Metallic"].default_value = saved[mat.name]


def bake(stage):
    """One stage per call: 'ao', 'color', 'material'."""
    sc = bpy.data.scenes.get(COLLECTION)
    if sc:
        bpy.context.window.scene = sc
    _setup_cycles()
    if stage != "ao":
        _strip_texture_nodes()
    if stage == "ao":
        _strip_texture_nodes()
        _set_bake_target(_image(f"{PREFIX}_AO", (1, 1, 1, 1)))
        _bake_all("AO")
    elif stage == "color":
        _bake_flat_color(_image(f"{PREFIX}_BaseColor", (0, 0, 0, 1)),
                         lambda bsdf: tuple(bsdf.inputs["Base Color"].default_value))
    elif stage == "material":
        _bake_flat_color(_image(f"{PREFIX}_RoughMetal", (0.6, 0, 0, 1)),
                         lambda bsdf: (bsdf.inputs["Roughness"].default_value,
                                       bsdf.inputs["Metallic"].default_value, 0.0, 1.0))
    else:
        raise ValueError(stage)
    print("baked", stage)


STATUS = {"state": "idle", "log": []}


def run_all_async(export=True):
    """apply → unwrap → bake → combine → optional glb export, via a timer."""
    import time
    import traceback
    STATUS.update(state="running", log=[])

    def job():
        try:
            t0 = time.time()
            apply_modifiers()
            STATUS["log"].append(f"modifiers: {time.time() - t0:.0f}s")
            t = time.time()
            unwrap()
            STATUS["log"].append(f"unwrap: {time.time() - t:.0f}s")
            for stage in ("ao", "color", "material"):
                t = time.time()
                bake(stage)
                STATUS["log"].append(f"{stage}: {time.time() - t:.0f}s")
            t = time.time()
            combine()
            STATUS["log"].append(f"combine: {time.time() - t:.0f}s")
            if export:
                t = time.time()
                import build_army_truck
                build_army_truck.export_glb(build_army_truck.GAME_MODEL)
                STATUS["log"].append(f"export: {time.time() - t:.0f}s")
            STATUS["state"] = "done"
        except Exception:
            STATUS["state"] = "error"
            STATUS["log"].append(traceback.format_exc())
        return None

    bpy.app.timers.register(job, first_interval=0.5)


def _pixels(name):
    px = np.empty(RES * RES * 4, dtype=np.float32)
    bpy.data.images[name].pixels.foreach_get(px)
    return px.reshape(-1, 4)


def _to_srgb(lin):
    lin = np.clip(lin, 0.0, 1.0)
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)


def combine():
    """Color×AO + ORM, wired into every truck material (same layout as bake_ao.combine)."""
    os.makedirs(OUT_DIR, exist_ok=True)
    a = _pixels(f"{PREFIX}_AO")
    c = _pixels(f"{PREFIX}_BaseColor")
    rm = _pixels(f"{PREFIX}_RoughMetal")
    out = np.ones_like(c)
    out[:, :3] = _to_srgb(c[:, :3] * a[:, :1])
    plain = np.ones_like(c)
    plain[:, :3] = _to_srgb(c[:, :3])
    orm = np.ones_like(c)
    orm[:, 0] = a[:, 0]
    orm[:, 1] = np.clip(rm[:, 0] + (1.0 - a[:, 0]) * CREVICE_ROUGHNESS, 0.0, 1.0)
    orm[:, 2] = rm[:, 1]

    def save(name, data, colorspace):
        img = bpy.data.images.get(name) or bpy.data.images.new(name, RES, RES, alpha=False)
        if tuple(img.size) != (RES, RES):
            bpy.data.images.remove(img)
            img = bpy.data.images.new(name, RES, RES, alpha=False)
        img.colorspace_settings.name = colorspace
        img.pixels.foreach_set(data.ravel())
        img.filepath_raw = os.path.join(OUT_DIR, name + ".png")
        img.file_format = "PNG"
        img.save()
        return img

    ao_png = a.copy()
    ao_png[:, 1] = ao_png[:, 2] = ao_png[:, 0]
    ao_png[:, 3] = 1.0
    save(f"{PREFIX}_AO_map", ao_png, "Non-Color")
    color_img = save(f"{PREFIX}_Color_AO", out, "sRGB")
    save(f"{PREFIX}_Color", plain, "sRGB")
    orm_img = save(f"{PREFIX}_ORM", orm, "Non-Color")

    for mat in _materials():
        nt = mat.node_tree
        bake_node = nt.nodes.get("BakeTarget")
        if bake_node:
            nt.nodes.remove(bake_node)
        bsdf = _bsdf(mat)
        tex = nt.nodes.get("ColorAO") or nt.nodes.new("ShaderNodeTexImage")
        tex.name = tex.label = "ColorAO"
        tex.location = (-450, 250)
        tex.image = color_img
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        rmt = nt.nodes.get("RoughMetal") or nt.nodes.new("ShaderNodeTexImage")
        rmt.name = rmt.label = "RoughMetal"
        rmt.location = (-650, -100)
        rmt.image = orm_img
        split = nt.nodes.get("RoughMetalSplit") or nt.nodes.new("ShaderNodeSeparateColor")
        split.name = split.label = "RoughMetalSplit"
        split.location = (-350, -100)
        nt.links.new(rmt.outputs["Color"], split.inputs["Color"])
        nt.links.new(split.outputs[1], bsdf.inputs["Roughness"])
        nt.links.new(split.outputs[2], bsdf.inputs["Metallic"])
    _flatten_lod_materials()
    print("saved", color_img.filepath_raw, orm_img.filepath_raw)


def _flatten_lod_materials():
    """LOD1/2 keep the original flat PBR values (no lightmap UVs)."""
    for name in (f"{LOD0_NAME}_LOD1", f"{LOD0_NAME}_LOD2"):
        ob = bpy.data.objects.get(name)
        if not ob:
            continue
        for i, slot in enumerate(ob.material_slots):
            src = slot.material
            if not src or src.name.endswith("_Flat"):
                continue
            flat_name = src.name + "_Flat"
            flat = bpy.data.materials.get(flat_name)
            if flat is None:
                flat = src.copy()
                flat.name = flat_name
                for nm in TEXTURE_NODES + ("BakeTarget",):
                    node = flat.node_tree.nodes.get(nm)
                    if node:
                        flat.node_tree.nodes.remove(node)
            ob.material_slots[i].material = flat
        print(f"{name}: flat materials")
