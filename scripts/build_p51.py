"""Build the low-poly backdrop P-51 Mustang and export GLB.

Run inside Blender (MCP execute or Scripting):
  exec(open('/Users/stellanjohansson/Cursor/Blender-Test01/scripts/build_p51.py').read())

Axes: +X = nose, +Z = up, +Y = left. Units: metres. Target: ≤1000 tris, no AO.
"""
import bpy
import bmesh
import os
from mathutils import Vector, Matrix
from math import pi, cos, sin

ROOT = "/Users/stellanjohansson/Cursor/Blender-Test01"
GAME_MODEL = os.path.join(ROOT, "proto", "public", "models", "p51.glb")

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
for m in list(bpy.data.meshes):
    bpy.data.meshes.remove(m)
for mat in list(bpy.data.materials):
    bpy.data.materials.remove(mat)

coll = bpy.data.collections.new("P51")
bpy.context.scene.collection.children.link(coll)


def link(obj):
    coll.objects.link(obj)
    return obj


def mat(name, color, rough=0.85, metal=0.05, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        m.blend_method = "BLEND"
        m.show_transparent_back = False
    return m


olive = mat("P51_Olive", (0.18, 0.20, 0.11), rough=0.9)
olive_light = mat("P51_OliveFade", (0.26, 0.27, 0.14), rough=0.88)
glass = mat("P51_Glass", (0.15, 0.22, 0.18), rough=0.12, metal=0.1, alpha=0.35)
star_blue = mat("P51_InsigniaBlue", (0.05, 0.12, 0.35), rough=0.7)
star_white = mat("P51_InsigniaWhite", (0.92, 0.92, 0.9), rough=0.7)
black = mat("P51_Black", (0.02, 0.02, 0.02), rough=0.5)


def finish(bm, name, material):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    me.materials.append(material)
    link(ob)
    for p in me.polygons:
        p.use_smooth = False
    return ob


def fuselage_section(bm, x, ry, rz, n=8):
    verts = []
    for i in range(n):
        a = 2 * pi * i / n - pi / 2
        yy = ry * cos(a)
        zz = rz * sin(a)
        if -pi * 0.15 < a < pi * 0.15:
            zz = min(zz, -rz * 0.55)
        verts.append(bm.verts.new((x, yy, zz)))
    return verts


bm = bmesh.new()
stations = [
    (4.85, 0.08, 0.08), (4.55, 0.38, 0.38), (4.15, 0.55, 0.52),
    (3.40, 0.62, 0.58), (2.55, 0.68, 0.62), (1.40, 0.70, 0.68),
    (0.40, 0.62, 0.72), (-0.60, 0.52, 0.55), (-2.00, 0.38, 0.40),
    (-3.40, 0.22, 0.28), (-4.55, 0.08, 0.12),
]
rings = [fuselage_section(bm, *s) for s in stations]
for ri in range(len(rings) - 1):
    a, b = rings[ri], rings[ri + 1]
    n = len(a)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((a[i], a[j], b[j], b[i]))
cn = bm.verts.new((stations[0][0] + 0.02, 0, 0))
for i in range(len(rings[0])):
    bm.faces.new((cn, rings[0][(i + 1) % len(rings[0])], rings[0][i]))
ct = bm.verts.new((stations[-1][0] - 0.05, 0, 0.02))
for i in range(len(rings[-1])):
    bm.faces.new((ct, rings[-1][i], rings[-1][(i + 1) % len(rings[-1])]))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
parts = [finish(bm, "P51_Fuselage", olive)]

bm = bmesh.new()
chin = [
    (4.20, 0.18, -0.45), (4.20, -0.18, -0.45), (3.50, -0.22, -0.62), (3.50, 0.22, -0.62),
    (2.70, 0.20, -0.55), (2.70, -0.20, -0.55), (2.70, -0.12, -0.35), (2.70, 0.12, -0.35),
    (3.50, 0.14, -0.38), (3.50, -0.14, -0.38), (4.20, -0.10, -0.28), (4.20, 0.10, -0.28),
]
vs = [bm.verts.new(p) for p in chin]
bm.faces.new((vs[0], vs[1], vs[10], vs[11]))
bm.faces.new((vs[1], vs[2], vs[9], vs[10]))
bm.faces.new((vs[2], vs[3], vs[8], vs[9]))
bm.faces.new((vs[3], vs[0], vs[11], vs[8]))
bm.faces.new((vs[4], vs[5], vs[6], vs[7]))
bm.faces.new((vs[3], vs[4], vs[7], vs[8]))
bm.faces.new((vs[2], vs[5], vs[6], vs[9]))
bm.faces.new((vs[0], vs[3], vs[4], vs[5], vs[1]))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
parts.append(finish(bm, "P51_Chin", olive))

bm = bmesh.new()


def make_wing(bm, y_sign):
    s = y_sign
    top = [
        bm.verts.new((2.55, 0.50 * s, 0.02)),
        bm.verts.new((2.35, 5.35 * s, 0.22)),
        bm.verts.new((1.50, 5.35 * s, 0.18)),
        bm.verts.new((0.85, 0.50 * s, -0.05)),
    ]
    bot = [
        bm.verts.new((2.55, 0.50 * s, -0.14)),
        bm.verts.new((2.35, 5.35 * s, 0.08)),
        bm.verts.new((1.50, 5.35 * s, 0.06)),
        bm.verts.new((0.85, 0.50 * s, -0.20)),
    ]
    if s > 0:
        bm.faces.new(top)
        bm.faces.new(list(reversed(bot)))
        for i in range(4):
            j = (i + 1) % 4
            bm.faces.new((top[i], top[j], bot[j], bot[i]))
    else:
        bm.faces.new(list(reversed(top)))
        bm.faces.new(bot)
        for i in range(4):
            j = (i + 1) % 4
            bm.faces.new((top[j], top[i], bot[i], bot[j]))


make_wing(bm, 1)
make_wing(bm, -1)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
parts.append(finish(bm, "P51_Wings", olive_light))

bm = bmesh.new()


def stab(bm, y_sign):
    s = y_sign
    top = [
        bm.verts.new((-3.55, 0.12 * s, 0.18)),
        bm.verts.new((-3.70, 1.80 * s, 0.18)),
        bm.verts.new((-4.15, 1.80 * s, 0.18)),
        bm.verts.new((-4.35, 0.12 * s, 0.18)),
    ]
    bot = [
        bm.verts.new((-3.55, 0.12 * s, 0.08)),
        bm.verts.new((-3.70, 1.80 * s, 0.08)),
        bm.verts.new((-4.15, 1.80 * s, 0.08)),
        bm.verts.new((-4.35, 0.12 * s, 0.08)),
    ]
    if s > 0:
        bm.faces.new(top)
        bm.faces.new(list(reversed(bot)))
        for i in range(4):
            j = (i + 1) % 4
            bm.faces.new((top[i], top[j], bot[j], bot[i]))
    else:
        bm.faces.new(list(reversed(top)))
        bm.faces.new(bot)
        for i in range(4):
            j = (i + 1) % 4
            bm.faces.new((top[j], top[i], bot[i], bot[j]))


stab(bm, 1)
stab(bm, -1)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
parts.append(finish(bm, "P51_HStab", olive))

bm = bmesh.new()
vo = [
    bm.verts.new((-3.20, 0.04, 0.25)),
    bm.verts.new((-3.55, 0.04, 1.55)),
    bm.verts.new((-4.20, 0.04, 1.50)),
    bm.verts.new((-4.55, 0.04, 0.20)),
]
vi = [
    bm.verts.new((-3.20, -0.04, 0.25)),
    bm.verts.new((-3.55, -0.04, 1.55)),
    bm.verts.new((-4.20, -0.04, 1.50)),
    bm.verts.new((-4.55, -0.04, 0.20)),
]
bm.faces.new(vo)
bm.faces.new(list(reversed(vi)))
for i in range(4):
    j = (i + 1) % 4
    bm.faces.new((vo[i], vo[j], vi[j], vi[i]))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
parts.append(finish(bm, "P51_VStab", olive))

bm = bmesh.new()
cy = [
    bm.verts.new((1.55, 0.35, 0.55)),
    bm.verts.new((1.55, -0.35, 0.55)),
    bm.verts.new((0.15, -0.38, 0.58)),
    bm.verts.new((0.15, 0.38, 0.58)),
    bm.verts.new((1.45, 0.28, 1.05)),
    bm.verts.new((1.45, -0.28, 1.05)),
    bm.verts.new((0.25, -0.30, 1.08)),
    bm.verts.new((0.25, 0.30, 1.08)),
]
bm.faces.new((cy[4], cy[5], cy[6], cy[7]))
bm.faces.new((cy[0], cy[1], cy[5], cy[4]))
bm.faces.new((cy[1], cy[2], cy[6], cy[5]))
bm.faces.new((cy[2], cy[3], cy[7], cy[6]))
bm.faces.new((cy[3], cy[0], cy[4], cy[7]))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
parts.append(finish(bm, "P51_Canopy", glass))

bm = bmesh.new()
for side in (1, -1):
    for x in (3.55, 3.35, 3.15, 2.95, 2.75, 2.55):
        y0, z0 = 0.62 * side, 0.15
        v0 = bm.verts.new((x, y0, z0))
        v1 = bm.verts.new((x - 0.12, y0, z0))
        v2 = bm.verts.new((x - 0.12, y0 + 0.05 * side, z0 + 0.06))
        v3 = bm.verts.new((x, y0 + 0.05 * side, z0 + 0.06))
        bm.faces.new((v0, v1, v2, v3) if side > 0 else (v0, v3, v2, v1))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
parts.append(finish(bm, "P51_Exhaust", black))

bm = bmesh.new()
for y_sign in (1, -1):
    for y_off in (1.7, 2.5):
        y = y_off * y_sign
        x0, z0, n, r = 2.45, -0.08, 5, 0.035
        rf, rb = [], []
        for i in range(n):
            a = 2 * pi * i / n
            rf.append(bm.verts.new((x0 + 0.35, y + r * cos(a), z0 + r * sin(a))))
            rb.append(bm.verts.new((x0, y + r * cos(a), z0 + r * sin(a))))
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((rb[i], rb[j], rf[j], rf[i]))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
parts.append(finish(bm, "P51_Guns", black))

bm = bmesh.new()
n, r = 8, 0.36
front, back = [], []
for i in range(n):
    a = 2 * pi * i / n
    front.append(bm.verts.new((4.72, r * 0.3 * cos(a), r * 0.3 * sin(a))))
    back.append(bm.verts.new((4.55, r * cos(a), r * sin(a))))
cf = bm.verts.new((4.85, 0, 0))
for i in range(n):
    j = (i + 1) % n
    bm.faces.new((cf, front[j], front[i]))
    bm.faces.new((front[i], front[j], back[j], back[i]))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
parts.append(finish(bm, "P51_Spinner", black))

# Flat prop disk — textured + alpha in planes.js (proto/public/models/prop_blur.png)
prop_mat = mat("P51_PropBlur", (0.05, 0.05, 0.05), rough=0.6, alpha=0.9)
bm = bmesh.new()
n, r = 16, 1.9
center = bm.verts.new((0.0, 0.0, 0.0))
ring = [bm.verts.new((0.0, r * cos(2 * pi * i / n), r * sin(2 * pi * i / n))) for i in range(n)]
for i in range(n):
    bm.faces.new((center, ring[i], ring[(i + 1) % n]))
uv_lay = bm.loops.layers.uv.new()
for f in bm.faces:
    for loop in f.loops:
        co = loop.vert.co
        loop[uv_lay].uv = (0.5 + co.y / (2 * r), 0.5 + co.z / (2 * r))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
prop_ob = finish(bm, "P51_Prop", prop_mat)


def insignia(side):
    x, y, z = -0.3, 0.58 * side, 0.15
    yy = y + 0.03 * side
    bm = bmesh.new()
    n, size = 10, 0.42
    c = bm.verts.new((x, yy, z))
    ring = [bm.verts.new((x + size * cos(2 * pi * i / n), yy, z + size * sin(2 * pi * i / n))) for i in range(n)]
    for i in range(n):
        face = (c, ring[i], ring[(i + 1) % n]) if side > 0 else (c, ring[(i + 1) % n], ring[i])
        bm.faces.new(face)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    parts.append(finish(bm, f"P51_Star_{'R' if side > 0 else 'L'}", star_blue))
    bm = bmesh.new()
    yy2 = yy + 0.015 * side
    r_out, r_in = 0.28, 0.11
    pts = []
    for i in range(10):
        a = -pi / 2 + i * pi / 5
        rr = r_out if i % 2 == 0 else r_in
        pts.append(bm.verts.new((x + rr * cos(a), yy2, z + rr * sin(a))))
    c2 = bm.verts.new((x, yy2, z))
    for i in range(10):
        face = (c2, pts[i], pts[(i + 1) % 10]) if side > 0 else (c2, pts[(i + 1) % 10], pts[i])
        bm.faces.new(face)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    parts.append(finish(bm, f"P51_StarWhite_{'R' if side > 0 else 'L'}", star_white))


insignia(1)
insignia(-1)

bm = bmesh.new()
x, y, z, n, size = 0.35, 2.8, 0.55, 10, 0.55
c = bm.verts.new((x, y, z))
ring = [bm.verts.new((x + size * cos(2 * pi * i / n), y + size * sin(2 * pi * i / n), z)) for i in range(n)]
for i in range(n):
    bm.faces.new((c, ring[i], ring[(i + 1) % n]))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
parts.append(finish(bm, "P51_WingStar", star_blue))

root = bpy.data.objects.new("P51_Mustang", None)
root.empty_display_type = "PLAIN_AXES"
link(root)

bpy.ops.object.select_all(action="DESELECT")
for p in parts:
    p.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.join()
joined = bpy.context.view_layer.objects.active
joined.name = "P51_Mesh"

mins = Vector((1e9,) * 3)
maxs = Vector((-1e9,) * 3)
for v in joined.data.vertices:
    mins = Vector(tuple(min(mins[i], v.co[i]) for i in range(3)))
    maxs = Vector(tuple(max(maxs[i], v.co[i]) for i in range(3)))
off = (mins + maxs) * 0.5
for v in joined.data.vertices:
    v.co -= off
joined.data.update()
joined.parent = root
# Prop hub sits just aft of spinner tip; keep as separate spin axis
prop_ob.location = Vector((max(v.co.x for v in joined.data.vertices) - 0.12, 0.0, 0.0))
prop_ob.parent = root

joined.data.calc_loop_triangles()
prop_ob.data.calc_loop_triangles()
print("body tris", len(joined.data.loop_triangles), "prop tris", len(prop_ob.data.loop_triangles))

os.makedirs(os.path.dirname(GAME_MODEL), exist_ok=True)
bpy.ops.object.select_all(action="DESELECT")
root.select_set(True)
joined.select_set(True)
prop_ob.select_set(True)
bpy.context.view_layer.objects.active = root
props = {p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties}
kw = dict(
    filepath=GAME_MODEL, export_format="GLB", use_selection=True, export_apply=True,
    export_yup=True, export_extras=True, export_animations=False,
)
bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in props})
print("exported", GAME_MODEL)
