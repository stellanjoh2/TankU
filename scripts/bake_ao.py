"""UV layout + AO bake for the Sherman. Run inside Blender after build_sherman.py:

    import sys; sys.path.append('/Users/stellanjohansson/Cursor/Blender-Test01/scripts')
    import bake_ao, importlib; importlib.reload(bake_ao)
    bake_ao.apply_modifiers(); bake_ao.unwrap()
    for st in ('ao_static', 'ao_moving', 'color', 'material'): bake_ao.bake(st)
    bake_ao.combine()
    # or, without blocking the caller: bake_ao.run_all_async(), then poll bake_ao.STATUS

Static parts (hull, turret, guns, suspension) bake together with everything visible plus a ground
plane. Moving parts (track links, wheels, sprocket, idler, rollers) bake alone, so their AO is only
self-occlusion and stays valid however they spin. Shared meshes are unwrapped and baked once.
"""
import bpy
import numpy as np
from math import radians

COLLECTION = "Sherman"
OUT_DIR = "/Users/stellanjohansson/Cursor/Blender-Test01/textures"
RES = 2048
PACK_MARGIN = 0.0025         # fraction of UV space (~5 px at 2048)
BAKE_MARGIN = 2              # px; must stay below half the pack margin
AO_DISTANCE = 0.6            # metres
SAMPLES = 16
MOVING_PREFIXES = ("TrackLink_", "RoadWheel_", "ReturnRoller_", "Sprocket_", "Idler_")
TEXTURE_NODES = ("ColorAO", "RoughMetal", "RoughMetalSplit")
CREVICE_ROUGHNESS = 0.15     # extra roughness in fully occluded areas (placeholder wear/dirt)


def meshes():
    return [o for o in bpy.data.collections[COLLECTION].all_objects if o.type == 'MESH']


def unique_mesh_objects():
    seen, out = set(), []
    for o in sorted(meshes(), key=lambda o: o.name):
        if o.data.name not in seen:
            seen.add(o.data.name)
            out.append(o)
    return out


def _materials():
    return {s.material for o in meshes() for s in o.material_slots if s.material}


def _bsdf(mat):
    return next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")


def _strip_texture_nodes():
    """Remove the combined-map nodes so bakes read the materials' plain values."""
    for mat in _materials():
        for nm in TEXTURE_NODES:
            old = mat.node_tree.nodes.get(nm)
            if old:
                mat.node_tree.nodes.remove(old)


def is_moving(o):
    return o.name.startswith(MOVING_PREFIXES)


def apply_modifiers():
    """Bake bevel modifiers into the mesh so UVs cover the real geometry."""
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
            if area.type == 'VIEW_3D':
                region = next(r for r in area.regions if r.type == 'WINDOW')
                return dict(window=win, area=area, region=region, screen=win.screen)
    raise RuntimeError("no 3D viewport found")


def unwrap():
    objs = unique_mesh_objects()
    for o in objs:
        if not o.data.uv_layers:
            o.data.uv_layers.new(name="UVMap")
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    with bpy.context.temp_override(**_view3d_override()):
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=radians(60), island_margin=0.0,
                                 area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
        bpy.ops.uv.select_all(action='SELECT')
        bpy.ops.uv.average_islands_scale()
        bpy.ops.uv.pack_islands(rotate=True, rotate_method='ANY', shape_method='CONCAVE',
                                margin_method='FRACTION', margin=PACK_MARGIN)
        bpy.ops.object.mode_set(mode='OBJECT')
    print("unwrapped", len(objs), "unique meshes")


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
    for mat in {s.material for o in meshes() for s in o.material_slots if s.material}:
        nt = mat.node_tree
        node = nt.nodes.get("BakeTarget") or nt.nodes.new("ShaderNodeTexImage")
        node.name = node.label = "BakeTarget"
        node.location = (-600, -300)
        node.image = img
        nt.nodes.active = node


def _setup_cycles():
    sc = bpy.context.scene
    try:
        sc.render.engine = 'CYCLES'
    except TypeError as e:
        raise RuntimeError(f"Cycles unavailable: {e}")
    sc.cycles.samples = SAMPLES
    # CPU only: enabling Metal makes Cycles compile GPU kernels in the background, which crashed
    # Blender 5.2 mid-bake on this machine.
    try:
        bpy.context.preferences.addons["cycles"].preferences.compute_device_type = 'NONE'
    except Exception as e:
        print("could not reset compute device:", e)
    sc.cycles.device = 'CPU'
    if sc.world is None:
        sc.world = bpy.data.worlds.new("World")
    sc.world.light_settings.distance = AO_DISTANCE
    b = sc.render.bake
    b.margin = BAKE_MARGIN
    b.margin_type = 'EXTEND'
    b.use_clear = False
    b.use_selected_to_active = False
    print("cycles device:", sc.cycles.device)


def _ground():
    me = bpy.data.meshes.new("_AO_Ground")
    me.from_pydata([(-8, -8, 0), (8, -8, 0), (8, 8, 0), (-8, 8, 0)], [], [(0, 1, 2, 3)])
    ob = bpy.data.objects.new("_AO_Ground", me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def _bake(objs, bake_type, **kw):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.bake(type=bake_type, **kw)


def _bake_static(bake_type, **kw):
    """Static parts with the whole tank (+ a ground plane for AO) as occluders."""
    static = [o for o in unique_mesh_objects() if not is_moving(o)]
    ground = _ground() if bake_type == 'AO' else None
    try:
        _bake(static, bake_type, **kw)
    finally:
        if ground:
            me = ground.data
            bpy.data.objects.remove(ground, do_unlink=True)
            bpy.data.meshes.remove(me)


def _bake_moving(bake_type, **kw):
    """Each moving part alone, so its AO is pure self-occlusion."""
    every = meshes()
    for o in [o for o in unique_mesh_objects() if is_moving(o)]:
        hidden = [x for x in every if x is not o and not x.hide_render]
        for x in hidden:
            x.hide_render = True
        try:
            _bake([o], bake_type, **kw)
        finally:
            for x in hidden:
                x.hide_render = False


def _bake_flat_color(img, color_of):
    """Bake color_of(bsdf) per material as a DIFFUSE COLOR pass. Metallic is zeroed meanwhile,
    since Cycles scales the diffuse colour pass by (1 - metallic)."""
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
        _bake_static('DIFFUSE', pass_filter={'COLOR'})
        _bake_moving('DIFFUSE', pass_filter={'COLOR'})
    finally:
        for mat in _materials():
            bsdf = _bsdf(mat)
            bsdf.inputs["Base Color"].default_value, bsdf.inputs["Metallic"].default_value = saved[mat.name]


def bake(stage):
    """Run one stage per call (each stays well under the MCP timeout):
    'ao_static', 'ao_moving', 'color'."""
    _setup_cycles()
    if stage != 'ao_moving':
        _strip_texture_nodes()
    if stage == 'ao_static':
        _set_bake_target(_image("Sherman_AO", (1, 1, 1, 1)))
        _bake_static('AO')
    elif stage == 'ao_moving':
        _set_bake_target(bpy.data.images["Sherman_AO"])
        _bake_moving('AO')
    elif stage == 'color':
        _bake_flat_color(_image("Sherman_BaseColor", (0, 0, 0, 1)),
                         lambda bsdf: tuple(bsdf.inputs["Base Color"].default_value))
    elif stage == 'material':
        # per-material roughness/metallic carried through Base Color as (roughness, metallic, 0)
        _bake_flat_color(_image("Sherman_RoughMetal", (0.6, 0, 0, 1)),  # gaps = paint values
                         lambda bsdf: (bsdf.inputs["Roughness"].default_value,
                                       bsdf.inputs["Metallic"].default_value, 0.0, 1.0))
    else:
        raise ValueError(stage)
    print("baked", stage)


STATUS = {"state": "idle", "log": []}


def run_all_async():
    """Run every stage plus combine() from a timer so the calling MCP request returns immediately.
    Poll bake_ao.STATUS for progress."""
    import time
    import traceback
    STATUS.update(state="running", log=[])

    def job():
        try:
            for stage in ("ao_static", "ao_moving", "color", "material"):
                t = time.time()
                bake(stage)
                STATUS["log"].append(f"{stage}: {time.time() - t:.0f}s")
            combine()
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
    """Writes the texture set and wires it into every material (Material IDs stay separate):
    Sherman_Color_AO   base colour x AO (sRGB)          -> Base Color
    Sherman_Color      base colour only (sRGB)
    Sherman_AO_map     AO only (greyscale)
    Sherman_ORM        glTF layout: R = AO, G = roughness, B = metallic -> Roughness / Metallic
    """
    import os
    os.makedirs(OUT_DIR, exist_ok=True)
    a = _pixels("Sherman_AO")
    c = _pixels("Sherman_BaseColor")
    rm = _pixels("Sherman_RoughMetal")
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
        img.colorspace_settings.name = colorspace
        img.pixels.foreach_set(data.ravel())
        img.filepath_raw = os.path.join(OUT_DIR, name + ".png")
        img.file_format = 'PNG'
        img.save()
        return img

    ao_png = a.copy()
    ao_png[:, 1] = ao_png[:, 2] = ao_png[:, 0]
    ao_png[:, 3] = 1.0
    save("Sherman_AO_map", ao_png, "Non-Color")
    color_img = save("Sherman_Color_AO", out, "sRGB")
    save("Sherman_Color", plain, "sRGB")
    orm_img = save("Sherman_ORM", orm, "Non-Color")

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
    print("saved", color_img.filepath_raw, orm_img.filepath_raw)
