"""Procedural destroyed Sherman swap mesh -> proto/public/models/sherman_destroyed.glb.

Same origin / axes as the intact tank (+X front, +Z up, metres, origin at ground centre).
Run inside Blender:

    import sys; sys.path.append('/Users/stellanjohansson/Cursor/Blender-Test01/scripts')
    import build_sherman_destroyed, importlib; importlib.reload(build_sherman_destroyed)
    build_sherman_destroyed.build(export=True)
"""
import os
import sys
import importlib
from math import pi, sin, cos, radians

import bpy
from mathutils import Vector, Euler

SCRIPT_DIR = "/Users/stellanjohansson/Cursor/Blender-Test01/scripts"
ROOT = "/Users/stellanjohansson/Cursor/Blender-Test01"
RUIN_MODEL = os.path.join(ROOT, "proto", "public", "models", "sherman_destroyed.glb")
RUIN = "Sherman_Destroyed"
SCENE = "ShermanDestroyed"

if SCRIPT_DIR not in sys.path:
    sys.path.append(SCRIPT_DIR)
import sherman_lib
importlib.reload(sherman_lib)
from sherman_lib import Builder, ensure_materials, MAT_DEFS, ALIAS  # noqa: E402

# Match intact Sherman proportions (see build_sherman.py).
TRACK_Y = 1.35
TRACK_W = 0.54
WHEEL_Z = 0.42
WHEEL_R = 0.335
WHEEL_X = (1.605, 0.867, 0.032, -0.77, -1.67)
SPROCKET = (2.18, 0.80, 0.36)
IDLER = (-2.44, 0.83, 0.33)
DECK_Z = 1.93
TURRET_ORIGIN = (-0.16, 0.0, 1.93)

# Charred olive for scorched plates.
MAT_DEFS["M_Paint_Burnt"] = ((0.04, 0.035, 0.025), 0.12, 0.92, 0.0)
ALIAS["burnt"] = "M_Paint_Burnt"


def _ensure_burnt():
    ensure_materials()
    name = "M_Paint_Burnt"
    rgb, metal, rough, emit = MAT_DEFS[name]
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Metallic"].default_value = metal
    bsdf.inputs["Roughness"].default_value = rough
    em = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
    if em is not None:
        em.default_value = (*rgb, 1.0)
    estr = bsdf.inputs.get("Emission Strength")
    if estr is not None:
        estr.default_value = emit
    m.diffuse_color = (*rgb, 1.0)


class RuinBuilder(Builder):
    """Builder + torn-sheet helpers (same idea as the army-truck ruin)."""

    def plate(self, corners, mat="paint", both=True):
        ids = [self.bm.verts.new(Vector(c)) for c in corners]
        with self.plain():
            self._tag([self.bm.faces.new(ids)], mat)
            if both:
                ids2 = [self.bm.verts.new(Vector(c)) for c in corners]
                self._tag([self.bm.faces.new(ids2[::-1])], mat)

    def curl_sheet(self, p0, p1, outward, segs, reach, drop, mat="paint"):
        p0, p1 = Vector(p0), Vector(p1)
        outward = Vector(outward).normalized()
        side = Vector((-outward.y, outward.x, 0.0))
        prev = [p0, p1]
        for i in range(1, segs + 1):
            t = i / segs
            ang = t * radians(120)
            hang = sin(ang) * reach * t + drop * (t ** 1.5)
            off = outward * (sin(ang) * reach * 0.85) + Vector((0, 0, -hang))
            twist = side * (0.16 * sin(t * pi))
            shrink = 1.0 - 0.35 * t
            a = p0 + off + twist * t
            b = p1 + off - twist * t
            c = (a + b) * 0.5
            a, b = c + (a - c) * shrink, c + (b - c) * shrink
            self.plate([prev[0], prev[1], b, a], mat)
            prev = [a, b]

    def ribbon(self, a, b, width, mat="metal"):
        a, b = Vector(a), Vector(b)
        d = b - a
        side = d.cross(Vector((0, 0, 1)))
        if side.length < 1e-4:
            side = Vector((1, 0, 0))
        side.normalize()
        hw = width * 0.5
        self.plate([a + side * hw, a - side * hw, b - side * hw, b + side * hw], mat)


def _ruin_scene():
    sc = bpy.data.scenes.get(SCENE) or bpy.data.scenes.new(SCENE)
    win = bpy.context.window
    if win:
        win.scene = sc
    for ob in list(sc.objects):
        me = ob.data if ob.type == "MESH" else None
        bpy.data.objects.remove(ob, do_unlink=True)
        if me and getattr(me, "users", 1) == 0:
            bpy.data.meshes.remove(me)
    # Drop old ruin if it lives in another scene's Sherman collection.
    old = bpy.data.objects.get(RUIN)
    if old:
        me = old.data
        bpy.data.objects.remove(old, do_unlink=True)
        if me and getattr(me, "users", 1) == 0:
            bpy.data.meshes.remove(me)
    return sc


def build_ruined_geometry():
    """Knocked-out Sherman: hull scorched, turret blown askew, tracks shredded."""
    b = RuinBuilder()
    hw = 1.55

    # --- Hull stump (buckled, lower than intact deck) ---
    # Centre body, slightly collapsed
    b.prism_xz(
        [(2.75, 1.15), (2.70, 1.35), (1.6, 1.78), (-0.4, 1.72),
         (-2.35, 1.55), (-2.70, 1.25), (-2.75, 1.05)],
        -0.9, 0.9, "burnt",
    )
    # Lower hull / sponson remnants
    b.prism_xz(
        [(2.70, 1.10), (2.40, 0.55), (-2.50, 0.52), (-2.80, 0.95), (-2.80, 1.10)],
        -1.05, 1.05, "burnt",
    )
    # Left sponson still vaguely there; right blown open
    b.prism_xz(
        [(2.85, 1.15), (2.80, 1.40), (1.5, 1.75), (-1.2, 1.68), (-2.70, 1.35), (-2.75, 1.15)],
        0.85, 1.55, "paint",
    )
    # Right side shredded low remnant
    b.box((0.4, -hw + 0.12, 1.25), (3.2, 0.18, 0.45), "burnt",
          R=Euler((radians(18), radians(-4), radians(-8))))
    b.box((-1.2, -hw + 0.08, 1.45), (0.9, 0.12, 0.35), "paint",
          R=Euler((radians(35), 0, radians(-22))))

    # Engine deck hole / burnt grille cavity
    b.box((-1.9, 0.05, 1.55), (1.1, 1.1, 0.12), "burnt")
    b.box((-1.85, 0.1, 1.35), (0.7, 0.55, 0.35), "metal")
    for s in (-1, 1):
        b.cyl((-1.55, s * 0.28, 1.45), (0.2, 0, 1), 0.05, 0.35, "metal", segs=6)

    # Front glacis crumpled
    b.box((2.35, 0.1, 1.35), (0.7, 1.6, 0.18), "paint",
          R=Euler((0, radians(-18), radians(6))))
    b.box((2.55, -0.4, 1.15), (0.45, 0.7, 0.2), "burnt",
          R=Euler((radians(20), radians(-25), radians(-15))))

    # --- Turret blown off to the left / aft, sitting crooked ---
    tx, ty, tz = -0.55, 1.05, 1.55
    # Bustle / ring remnant still on the deck
    b.cyl((-0.1, 0.05, DECK_Z - 0.05), (0, 0, 1), 0.95, 0.12, "burnt", segs=12)
    b.cyl((-0.1, 0.05, DECK_Z + 0.02), (0, 0, 1), 0.72, 0.08, "metal", segs=10)
    # Turret body askew
    b.box((tx, ty, tz + 0.35), (1.55, 1.35, 0.7), "burnt",
          R=Euler((radians(22), radians(18), radians(55))))
    b.box((tx - 0.15, ty + 0.1, tz + 0.75), (1.2, 1.0, 0.25), "paint",
          R=Euler((radians(28), radians(12), radians(50))))
    # Mantlet remnant
    b.box((tx + 0.7, ty - 0.15, tz + 0.4), (0.35, 0.55, 0.45), "metal",
          R=Euler((radians(15), radians(-10), radians(48))))
    # Barrel bent / broken — stub on turret + piece on the ground
    b.cyl((tx + 1.3, ty - 0.35, tz + 0.35), (0.7, -0.5, -0.35), 0.08, 1.4, "metal", segs=8)
    b.cyl((1.8, -1.4, 0.12), (0.3, 0.9, 0.05), 0.07, 1.1, "metal", segs=8)

    # Cupola knocked beside the hull
    b.cyl((-0.9, 2.0, 0.22), (0.2, 0.1, 1), 0.28, 0.35, "paint", segs=10)
    b.cyl((-0.9, 2.0, 0.42), (0.2, 0.1, 1), 0.22, 0.08, "metal", segs=8)

    # --- Running gear ---
    # Left track mostly present but sagging
    for i, x in enumerate(WHEEL_X):
        sink = 0.04 if i % 2 else 0.1
        b.cyl((x, TRACK_Y, WHEEL_Z - sink), (0, 1, 0), WHEEL_R * 0.95, TRACK_W * 0.85,
              "rubber", segs=10)
        b.cyl((x, TRACK_Y, WHEEL_Z - sink), (0, 1, 0), 0.12, TRACK_W * 0.4, "metal", segs=8)
    b.cyl((SPROCKET[0], TRACK_Y, SPROCKET[1] - 0.08), (0, 1, 0), 0.28, TRACK_W * 0.7,
          "metal", segs=10)
    b.cyl((IDLER[0], TRACK_Y, IDLER[1] - 0.15), (0, 1, 0), 0.26, TRACK_W * 0.7,
          "metal", segs=10)
    # Sagging left track ribbon (upper + lower)
    b.box((0.0, TRACK_Y, 0.12), (4.4, TRACK_W * 0.9, 0.06), "track",
          R=Euler((0, radians(3), 0)))
    b.box((0.2, TRACK_Y, 1.05), (3.6, TRACK_W * 0.7, 0.05), "track",
          R=Euler((radians(8), radians(-4), 0)))

    # Right track blown — scattered wheels
    b.cyl((1.4, -TRACK_Y - 0.15, WHEEL_Z - 0.2), (0.2, 1, 0.15), WHEEL_R, TRACK_W * 0.8,
          "rubber", segs=10)
    b.cyl((0.2, -TRACK_Y + 0.25, 0.15), (0.5, 0.3, 0.8), WHEEL_R * 0.9, TRACK_W * 0.7,
          "rubber", segs=10)
    b.cyl((-1.2, -TRACK_Y - 0.4, WHEEL_R * 0.55), (0.1, 0.2, 1), WHEEL_R * 0.85, TRACK_W * 0.6,
          "rubber", segs=10)
    b.cyl((2.3, -1.9, 0.18), (0.4, 0.8, 0.2), 0.22, 0.35, "metal", segs=8)
    # Track chunks on the ground
    b.box((0.8, -2.1, 0.05), (1.2, 0.45, 0.08), "track",
          R=Euler((0, 0, radians(35))))
    b.box((-1.5, -1.95, 0.06), (0.9, 0.4, 0.07), "track",
          R=Euler((radians(12), 0, radians(-50))))
    b.box((2.6, -1.5, 0.05), (0.7, 0.35, 0.06), "track")

    # --- Peeled armour / curled sheets ---
    b.curl_sheet(
        (1.6, hw - 0.05, 1.65), (0.2, hw - 0.05, 1.70),
        (0, 1, 0.15), segs=5, reach=0.95, drop=1.05, mat="paint",
    )
    b.curl_sheet(
        (-0.8, -0.9, 1.55), (-2.0, -0.9, 1.45),
        (0, -1, 0.1), segs=4, reach=0.8, drop=0.95, mat="burnt",
    )
    b.curl_sheet(
        (2.4, 0.6, 1.45), (2.4, -0.3, 1.40),
        (1, 0.1, 0.2), segs=4, reach=0.9, drop=0.85, mat="paint",
    )
    # Engine-deck hatch flung open
    b.box((-1.7, 0.85, 1.85), (0.55, 0.45, 0.05), "burnt",
          R=Euler((radians(-55), radians(10), radians(25))))

    # --- Ground scrap ---
    b.box((1.5, 2.0, 0.05), (0.7, 0.4, 0.04), "paint",
          R=Euler((0, radians(8), radians(40))))
    b.box((-2.2, 1.7, 0.06), (0.5, 0.3, 0.08), "metal")
    b.box((0.3, -2.3, 0.05), (0.45, 0.25, 0.06), "burnt",
          R=Euler((0, 0, radians(-30))))
    for tip, end, w in (
        ((1.2, hw, 1.5), (1.8, hw + 0.55, 0.85), 0.1),
        ((-2.0, -1.0, 1.4), (-2.5, -1.55, 0.7), 0.09),
        ((2.2, -0.6, 1.3), (2.7, -1.15, 0.55), 0.11),
    ):
        b.ribbon(tip, end, w, "metal")

    # Antenna stump bent over
    b.cyl((-0.9, 0.55, 1.85), (0.3, 0.4, 0.85), 0.012, 1.1, "metal", segs=5)

    # .50 cal mount scrap on the deck
    b.box((-0.5, -0.4, 1.78), (0.35, 0.2, 0.15), "metal",
          R=Euler((radians(20), 0, radians(-35))))
    b.cyl((-0.35, -0.55, 1.85), (0.8, -0.4, 0.1), 0.025, 0.55, "metal", segs=5)

    return b


def _flat_ruin_materials(ob):
    """Solid colours only — no intact Sherman lightmap atlas."""
    for i, slot in enumerate(ob.material_slots):
        src = slot.material
        if not src:
            continue
        base = src.name.replace("_Flat", "").replace("_Ruin", "")
        rn = base + "_Ruin"
        flat = bpy.data.materials.get(rn)
        if flat is None:
            key = next((k for k in MAT_DEFS if k == base), None)
            flat = bpy.data.materials.new(rn)
            flat.use_nodes = True
            bsdf = next(n for n in flat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
            if key:
                rgb, metal, rough, _emit = MAT_DEFS[key]
                bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
                bsdf.inputs["Metallic"].default_value = metal
                bsdf.inputs["Roughness"].default_value = rough
                flat.diffuse_color = (*rgb, 1.0)
            else:
                sbsdf = next(n for n in src.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
                bsdf.inputs["Base Color"].default_value = sbsdf.inputs["Base Color"].default_value
                bsdf.inputs["Metallic"].default_value = sbsdf.inputs["Metallic"].default_value
                bsdf.inputs["Roughness"].default_value = sbsdf.inputs["Roughness"].default_value
        ob.material_slots[i].material = flat


def export_ruin_glb(path):
    ob = bpy.data.objects[RUIN]
    ob.hide_set(False)
    ob.hide_viewport = False
    ob.hide_render = False
    tmp = bpy.data.scenes.new("_ShermanRuinExport")
    win = bpy.context.window
    prev = win.scene
    win.scene = tmp
    try:
        tmp.collection.objects.link(ob)
        props = {p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties}
        kw = dict(
            filepath=path, export_format="GLB", export_apply=True,
            export_yup=True, export_extras=True, export_animations=False,
            use_active_scene=True,
        )
        os.makedirs(os.path.dirname(path), exist_ok=True)
        bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in props})
        print("exported", path, f"{os.path.getsize(path) / 1024:.0f} KB")
    finally:
        win.scene = prev
        bpy.data.scenes.remove(tmp)


def build(export=False):
    """Build the destroyed Sherman swap mesh and optionally export the GLB."""
    sc = _ruin_scene()
    _ensure_burnt()
    # Quiet viewport: sun + ground like the truck scene
    if "Ruin_Sun" not in sc.objects:
        light_data = bpy.data.lights.new("Ruin_Sun", "SUN")
        light_data.energy = 2.5
        sun = bpy.data.objects.new("Ruin_Sun", light_data)
        sc.collection.objects.link(sun)
        sun.rotation_euler = (radians(50), radians(15), radians(30))
    b = build_ruined_geometry()
    # Link into this scene's collection (sherman_lib links to Sherman collection).
    ob = b.finish(RUIN, loc=(0, 0, 0), bevel=None, smooth_angle=40)
    # Move from Sherman collection into our scene if needed.
    for col in list(ob.users_collection):
        col.objects.unlink(ob)
    sc.collection.objects.link(ob)
    _flat_ruin_materials(ob)
    # UVs for the in-game burnt-metal placeholder (ground/rock_color.jpg).
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=radians(66), island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")
    tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
    print(f"{RUIN}: {tris} tris, uvs={len(ob.data.uv_layers) > 0}")
    if export:
        export_ruin_glb(RUIN_MODEL)
    return ob


if __name__ == "__main__":
    build(export=True)
