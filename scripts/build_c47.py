"""Placeholder low-poly C-47 for supply drops. Export GLB.

Run inside Blender:
  exec(open('/Users/stellanjohansson/Cursor/Blender-Test01/scripts/build_c47.py').read())

Axes: +X = nose, +Z = up, +Y = left. Units: metres.
Roughly real size (length ~19 m, span ~29 m) so it reads bigger than the P-51.
"""
import bpy
import bmesh
import os
from mathutils import Vector
from math import pi, cos, sin

ROOT = "/Users/stellanjohansson/Cursor/Blender-Test01"
GAME_MODEL = os.path.join(ROOT, "proto", "public", "models", "c47.glb")

N = 12  # fuselage / nacelle sides


def wipe_previous():
    col = bpy.data.collections.get("C47")
    if col:
        for obj in list(col.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.collections.remove(col)
    cube = bpy.data.objects.get("Cube")
    if cube:
        bpy.data.objects.remove(cube, do_unlink=True)
    for block in (bpy.data.meshes, bpy.data.materials):
        for item in list(block):
            if item.name.startswith("C47") and item.users == 0:
                block.remove(item)


wipe_previous()

coll = bpy.data.collections.new("C47")
bpy.context.scene.collection.children.link(coll)


def link(obj):
    coll.objects.link(obj)
    return obj


def mat(name, color, rough=0.9, metal=0.02, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        try:
            m.blend_method = "BLEND"
            m.show_transparent_back = False
        except Exception:
            pass
    m.diffuse_color = (*color, alpha)
    return m


olive = mat("C47_Olive", (0.24, 0.26, 0.14))
black = mat("C47_Black", (0.035, 0.035, 0.032), rough=0.55)
white = mat("C47_White", (0.82, 0.81, 0.74), rough=0.7)
star_blue = mat("C47_InsigniaBlue", (0.05, 0.11, 0.32), rough=0.65)
star_white = mat("C47_InsigniaWhite", (0.93, 0.93, 0.9), rough=0.65)
prop_mat = mat("C47_PropBlur", (0.05, 0.05, 0.05), rough=0.6, alpha=0.9)

parts = []


def finish(bm, name, material, recalc=True):
    if recalc:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    else:
        bm.normal_update()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = False
    ob = bpy.data.objects.new(name, me)
    me.materials.append(material)
    link(ob)
    parts.append(ob)
    return ob


def ring(bm, x, ry, rz, zc=0.0, n=N):
    vs = []
    for i in range(n):
        a = 2 * pi * i / n
        vs.append(bm.verts.new((x, ry * cos(a), zc + rz * sin(a))))
    return vs


def bridge(bm, rings):
    for a, b in zip(rings, rings[1:]):
        n = len(a)
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((a[i], b[i], b[j], a[j]))


def cap(bm, loop, center):
    c = bm.verts.new(center)
    n = len(loop)
    for i in range(n):
        bm.faces.new((c, loop[i], loop[(i + 1) % n]))


def loft(bm, stations, n=N):
    rings = [ring(bm, *s, n=n) for s in stations]
    bridge(bm, rings)
    nose, tail = stations[0], stations[-1]
    cap(bm, list(reversed(rings[0])), (nose[0] + 0.02, 0.0, nose[3] if len(nose) > 3 else 0.0))
    cap(bm, rings[-1], (tail[0] - 0.02, 0.0, tail[3] if len(tail) > 3 else 0.0))
    return rings


def box(bm, x0, x1, y0, y1, z0, z1):
    vs = [bm.verts.new(p) for p in (
        (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
        (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
    )]
    for q in (
        (0, 1, 2, 3), (4, 7, 6, 5),
        (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0),
    ):
        bm.faces.new(tuple(vs[i] for i in q))
    return vs


# --- fuselage: blunt black nose, olive tube, long tail cone ---
# station: x, ry, rz, zc
NOSE = [
    (9.20, 0.22, 0.18, -0.02),
    (8.85, 0.74, 0.66, -0.01),
    (8.40, 1.00, 0.92, 0.05),
    (8.00, 1.12, 1.04, 0.08),
]
BODY = [
    (8.00, 1.12, 1.04, 0.08),
    (6.70, 1.18, 1.20, 0.10),
    (4.90, 1.28, 1.36, 0.04),
    (2.60, 1.34, 1.42, 0.00),
    (0.30, 1.32, 1.40, -0.02),
    (-1.90, 1.22, 1.28, -0.02),
    (-3.70, 1.04, 1.08, 0.00),
    (-5.20, 0.74, 0.80, 0.02),
    (-6.60, 0.44, 0.48, 0.04),
    (-7.85, 0.24, 0.26, 0.05),
    (-9.05, 0.07, 0.08, 0.06),
]

bm = bmesh.new()
loft(bm, NOSE)
finish(bm, "C47_Nose", black)

bm = bmesh.new()
loft(bm, BODY)
finish(bm, "C47_Fuselage", olive)


def fuse_r(x):
    """Skin radius (max of ry, rz) at station x, for things that sit on the tube."""
    best = None
    for s in BODY:
        if best is None or abs(s[0] - x) < abs(best[0] - x):
            best = s
    return max(best[1], best[2])


# Cabin windows, both sides.
bm = bmesh.new()
for side in (1, -1):
    for x in (5.6, 4.5, 3.4, 2.3, 1.2, 0.1, -1.0):
        r = fuse_r(x) + 0.02
        box(bm, x - 0.16, x + 0.16, side * r, side * (r + 0.06), 0.18, 0.52)
finish(bm, "C47_Windows", black)


# --- high wing, mild dihedral, straight-ish leading edge ---
# Root crosses the centreline so the wing is buried in the fuselage crown.
# Dihedral starts once the wing has cleared the tube.
TIP_Y = 14.5
DIH_Y = 1.45


def wing_frame(ay):
    u = max(0.0, min(1.0, ay / TIP_Y))
    le = 3.35 + (2.15 - 3.35) * u
    te = -0.85 + (0.45 - (-0.85)) * u
    half = 0.26 + (0.05 - 0.26) * u
    dih = max(0.0, ay - DIH_Y) / (TIP_Y - DIH_Y)
    z = 1.22 + 1.05 * dih
    return le, te, z, half


def wing_section(bm, y):
    le, te, z, half = wing_frame(abs(y))
    return [
        bm.verts.new((le, y, z + half)),
        bm.verts.new((te, y, z + half * 0.75)),
        bm.verts.new((te, y, z - half)),
        bm.verts.new((le - 0.05, y, z - half * 0.15)),
    ]


bm = bmesh.new()
for sign in (1, -1):
    # Inboard station crosses the centreline so the two halves overlap inside the body.
    ys = [-0.2 * sign, 1.5 * sign, 5.0 * sign, 9.6 * sign, TIP_Y * sign]
    secs = [wing_section(bm, y) for y in ys]
    for a, b in zip(secs, secs[1:]):
        for k in range(4):
            k2 = (k + 1) % 4
            if sign > 0:
                bm.faces.new((a[k], a[k2], b[k2], b[k]))
            else:
                bm.faces.new((a[k], b[k], b[k2], a[k2]))
    root, tip = secs[0], secs[-1]
    if sign > 0:
        bm.faces.new((root[0], root[3], root[2], root[1]))
        bm.faces.new((tip[0], tip[1], tip[2], tip[3]))
    else:
        bm.faces.new((root[0], root[1], root[2], root[3]))
        bm.faces.new((tip[0], tip[3], tip[2], tip[1]))
finish(bm, "C47_Wings", olive)


def upper_skin(ay):
    """Upper fuselage skin at the cabin, used to tuck the wing fillet inside the tube."""
    ry, rz = 1.32, 1.38
    t = min(0.98, ay / ry)
    return rz * (1 - t * t) ** 0.5


def add_fairing(bm, sign):
    """Fillet from inside the fuselage shoulder out to the wing underside."""
    s = sign
    ys = [0.35 * s, 1.05 * s, 1.75 * s, 2.45 * s]
    secs = []
    for y in ys:
        ay = abs(y)
        le, te, z, half = wing_frame(ay)
        wing_bot = z - half
        u = max(0.0, min(1.0, (ay - 0.35) / 2.1))
        skin = upper_skin(ay) - 0.1
        bot = skin * (1 - u) + wing_bot * u
        top = wing_bot + 0.06
        flare = 0.42 * (1 - u)
        secs.append([
            bm.verts.new((le - 0.04, y, top)),
            bm.verts.new((te + 0.04, y, top)),
            bm.verts.new((te + 0.04 + flare, y, bot)),
            bm.verts.new((le - 0.04 - flare, y, bot)),
        ])
    for a, b in zip(secs, secs[1:]):
        for k in range(4):
            k2 = (k + 1) % 4
            if s > 0:
                bm.faces.new((a[k], a[k2], b[k2], b[k]))
            else:
                bm.faces.new((a[k], b[k], b[k2], a[k2]))
    root, tip = secs[0], secs[-1]
    if s > 0:
        bm.faces.new((root[0], root[3], root[2], root[1]))
        bm.faces.new((tip[0], tip[1], tip[2], tip[3]))
    else:
        bm.faces.new((root[0], root[1], root[2], root[3]))
        bm.faces.new((tip[0], tip[3], tip[2], tip[1]))


bm = bmesh.new()
add_fairing(bm, 1)
add_fairing(bm, -1)
finish(bm, "C47_WingFairing", olive)


def stripe_slab(bm, y0, y1):
    """Paint band across the chord, proud of the top and bottom skins."""
    for y_a, y_b in ((y0, y1),):
        samples = []
        for y in (y_a, y_b):
            le, te, z, half = wing_frame(abs(y))
            samples.append((le - 0.12, te + 0.12, z, half))
        (le0, te0, z0, h0), (le1, te1, z1, h1) = samples
        top = [
            bm.verts.new((le0, y_a, z0 + h0 + 0.035)),
            bm.verts.new((te0, y_a, z0 + h0 * 0.75 + 0.035)),
            bm.verts.new((te1, y_b, z1 + h1 * 0.75 + 0.035)),
            bm.verts.new((le1, y_b, z1 + h1 + 0.035)),
        ]
        bot = [
            bm.verts.new((le0, y_a, z0 - h0 - 0.035)),
            bm.verts.new((te0, y_a, z0 - h0 - 0.035)),
            bm.verts.new((te1, y_b, z1 - h1 - 0.035)),
            bm.verts.new((le1, y_b, z1 - h1 - 0.035)),
        ]
        bm.faces.new(top)
        bm.faces.new(list(reversed(bot)))
        for i in range(4):
            j = (i + 1) % 4
            bm.faces.new((top[i], bot[i], bot[j], top[j]))


# Invasion stripes outboard of the props: white, black, white, black, white.
bands = (7.15, 8.15, 9.15, 10.15, 11.15, 12.15)
stripe_ranges = [(bands[i], bands[i + 1], white if i % 2 == 0 else black) for i in range(5)]

for y0, y1, colour in stripe_ranges:
    bm = bmesh.new()
    stripe_slab(bm, y0, y1)
    stripe_slab(bm, -y1, -y0)
    finish(bm, "C47_WingStripe", colour)

# Fuselage stripes ahead of the tail cone.
FUSE_STRIPE_X = (-3.15, -3.70, -4.25, -4.80, -5.35, -5.90)
for i in range(5):
    x0, x1 = FUSE_STRIPE_X[i], FUSE_STRIPE_X[i + 1]
    r = max(fuse_r(x0), fuse_r(x1)) + 0.045
    zc = 0.0
    bm = bmesh.new()
    a = ring(bm, x0, r, r, zc)
    b = ring(bm, x1, r * 0.97, r * 0.97, zc)
    bridge(bm, [a, b])
    bm.faces.ensure_lookup_table()
    bm.normal_update()
    face = bm.faces[0]
    radial = face.calc_center_median().copy()
    radial.x = 0.0
    if face.normal.dot(radial) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    finish(bm, "C47_FuseStripe", white if i % 2 == 0 else black, recalc=False)


# --- nacelles, cowlings, props ---
ENG_Y = 4.95
NAC_R = 0.72


def nacelle_center_z():
    _le, _te, z, _h = wing_frame(ENG_Y)
    return z - 0.62


NZ = nacelle_center_z()

for side in (1, -1):
    y = ENG_Y * side
    bm = bmesh.new()
    # olive body of the nacelle, behind the black cowling
    stations = [
        (4.15, NAC_R * 0.96, NAC_R * 0.90, NZ),
        (3.15, NAC_R, NAC_R * 0.92, NZ - 0.02),
        (1.70, NAC_R * 0.78, NAC_R * 0.70, NZ + 0.02),
        (0.15, NAC_R * 0.42, NAC_R * 0.36, NZ + 0.04),
    ]
    # ring() uses ry, rz around y=0. Offset the whole mesh after.
    loft(bm, [(s[0], s[1], s[2], s[3]) for s in stations])
    for v in bm.verts:
        v.co.y += y
    finish(bm, "C47_Nacelle", olive)

    bm = bmesh.new()
    cowling = [
        (4.72, NAC_R * 0.55, NAC_R * 0.50, NZ),
        (4.45, NAC_R * 1.02, NAC_R * 0.96, NZ),
        (4.15, NAC_R * 0.96, NAC_R * 0.90, NZ),
    ]
    loft(bm, cowling)
    for v in bm.verts:
        v.co.y += y
    finish(bm, "C47_Cowling", black)

    # a few exhaust stubs on the outboard side
    bm = bmesh.new()
    for x in (3.55, 3.15, 2.75):
        box(
            bm,
            x - 0.08, x + 0.08,
            y + side * (NAC_R * 0.2), y + side * (NAC_R + 0.28),
            NZ - 0.08, NZ + 0.08,
        )
    finish(bm, "C47_Exhaust", black)

# --- tail ---
bm = bmesh.new()
fin = [
    (-5.55, 0.95),
    (-6.45, 2.20),
    (-7.10, 3.30),
    (-7.65, 3.85),
    (-8.40, 3.75),
    (-8.95, 2.35),
    (-9.20, 0.65),
    (-7.00, 0.50),
]
y0, y1 = -0.08, 0.08
side_a = [bm.verts.new((x, y0, z)) for x, z in fin]
side_b = [bm.verts.new((x, y1, z)) for x, z in fin]
n = len(fin)
for i in range(n):
    j = (i + 1) % n
    bm.faces.new((side_a[i], side_a[j], side_b[j], side_b[i]))
bm.faces.new(list(reversed(side_a)))
bm.faces.new(side_b)
finish(bm, "C47_Fin", olive)

# Dorsal fillet so the fin grows out of the fuselage.
bm = bmesh.new()
fillet = [
    (-4.15, 1.25),
    (-5.55, 0.95),
    (-6.35, 2.05),
    (-5.15, 1.55),
]
fa = [bm.verts.new((x, -0.05, z)) for x, z in fillet]
fb = [bm.verts.new((x, 0.05, z)) for x, z in fillet]
for i in range(4):
    j = (i + 1) % 4
    bm.faces.new((fa[i], fa[j], fb[j], fb[i]))
bm.faces.new(list(reversed(fa)))
bm.faces.new(fb)
finish(bm, "C47_Fillet", olive)


def stab_section(bm, y, le, te, z, half):
    return [
        bm.verts.new((le, y, z + half)),
        bm.verts.new((te, y, z + half * 0.8)),
        bm.verts.new((te, y, z - half)),
        bm.verts.new((le, y, z - half * 0.4)),
    ]


bm = bmesh.new()
for sign in (1, -1):
    root = stab_section(bm, 0.12 * sign, -6.40, -9.10, 0.72, 0.07)
    tip = stab_section(bm, 4.25 * sign, -7.05, -8.90, 0.78, 0.035)
    for k in range(4):
        k2 = (k + 1) % 4
        if sign > 0:
            bm.faces.new((root[k], root[k2], tip[k2], tip[k]))
        else:
            bm.faces.new((root[k], tip[k], tip[k2], root[k2]))
    if sign > 0:
        bm.faces.new((tip[0], tip[1], tip[2], tip[3]))
        bm.faces.new((root[0], root[3], root[2], root[1]))
    else:
        bm.faces.new((tip[0], tip[3], tip[2], tip[1]))
        bm.faces.new((root[0], root[1], root[2], root[3]))
finish(bm, "C47_Stab", olive)


def insignia(x, y, z, radius, normal):
    """Star-and-bar painted on a surface. normal = ('y'|'z', outward vector)."""
    axis = normal[0]
    out = Vector(normal[1])
    sign = 1 if (out.y if axis == "y" else out.z) >= 0 else -1

    def at(px, py, pz, lift):
        return Vector((px, py, pz)) + out * lift

    def face(bm, verts):
        bm.faces.new(verts if sign > 0 else list(reversed(verts)))

    # Bar runs fore-aft on the fuselage and spanwise on the wing.
    bm = bmesh.new()
    bar = radius * 1.65
    thick = radius * 0.38
    if axis == "y":
        pts = [
            (x - bar, y, z - thick),
            (x + bar, y, z - thick),
            (x + bar, y, z + thick),
            (x - bar, y, z + thick),
        ]
    else:
        pts = [
            (x - thick, y - bar, z),
            (x + thick, y - bar, z),
            (x + thick, y + bar, z),
            (x - thick, y + bar, z),
        ]
    face(bm, [bm.verts.new(at(*p, 0.012)) for p in pts])
    finish(bm, "C47_StarBar", star_white, recalc=False)

    def disc(bm, rad_for, lift, segs=12, ang0=0.0):
        center = bm.verts.new(at(x, y, z, lift))
        loop = []
        for i in range(segs):
            a = ang0 + 2 * pi * i / segs
            rr = rad_for(i)
            if axis == "y":
                loop.append(bm.verts.new(at(x + rr * cos(a), y, z + rr * sin(a), lift)))
            else:
                loop.append(bm.verts.new(at(x + rr * cos(a), y + rr * sin(a), z, lift)))
        for i in range(segs):
            j = (i + 1) % segs
            tri = (center, loop[i], loop[j])
            bm.faces.new(tri if sign > 0 else (center, loop[j], loop[i]))

    bm = bmesh.new()
    disc(bm, lambda i: radius, 0.02)
    finish(bm, "C47_StarDisc", star_blue, recalc=False)

    bm = bmesh.new()
    disc(bm, lambda i: radius * (0.72 if i % 2 == 0 else 0.30), 0.032, segs=10, ang0=pi / 2)
    finish(bm, "C47_Star", star_white, recalc=False)


# Fuselage roundels, both sides, between the wing and the stripes.
insignia(-1.35, fuse_r(-1.35) + 0.02, 0.15, 0.62, ("y", (0, 1, 0)))
insignia(-1.35, -(fuse_r(-1.35) + 0.02), 0.15, 0.62, ("y", (0, -1, 0)))

# Wing roundels, top and bottom, outboard of the stripes. Underside is what tanks see.
for sign in (1, -1):
    y = 13.15 * sign
    le, te, z, half = wing_frame(abs(y))
    cx = (le + te) * 0.5
    insignia(cx, y, z + half + 0.02, 0.78, ("z", (0, 0, 1)))
    insignia(cx, y, z - half - 0.02, 0.78, ("z", (0, 0, -1)))


# Props: separate spin meshes, local XY disk in the YZ plane (normal +X).
PROP_R = 1.78
prop_obs = []
for side, name in ((1, "C47_Prop_L"), (-1, "C47_Prop_R")):
    bm = bmesh.new()
    c = bm.verts.new((0.0, 0.0, 0.0))
    loop = [bm.verts.new((0.0, PROP_R * cos(2 * pi * i / 16), PROP_R * sin(2 * pi * i / 16))) for i in range(16)]
    for i in range(16):
        bm.faces.new((c, loop[i], loop[(i + 1) % 16]))
    uv = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        for loop_ in f.loops:
            co = loop_.vert.co
            loop_[uv].uv = (0.5 + co.y / (2 * PROP_R), 0.5 + co.z / (2 * PROP_R))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = False
    ob = bpy.data.objects.new(name, me)
    me.materials.append(prop_mat)
    link(ob)
    ob.location = Vector((4.78, ENG_Y * side, NZ))
    prop_obs.append(ob)

root = bpy.data.objects.new("C47", None)
root.empty_display_type = "PLAIN_AXES"
link(root)

bpy.ops.object.select_all(action="DESELECT")
for p in parts:
    p.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.join()
joined = bpy.context.view_layer.objects.active
joined.name = "C47_Mesh"
joined.parent = root
for ob in prop_obs:
    ob.parent = root

joined.data.calc_loop_triangles()
tris = len(joined.data.loop_triangles)
for ob in prop_obs:
    ob.data.calc_loop_triangles()
    tris += len(ob.data.loop_triangles)

mins = Vector((1e9,) * 3)
maxs = Vector((-1e9,) * 3)
for v in joined.data.vertices:
    w = joined.matrix_world @ v.co
    mins = Vector(tuple(min(mins[i], w[i]) for i in range(3)))
    maxs = Vector(tuple(max(maxs[i], w[i]) for i in range(3)))
print("tris", tris)
print("bounds", tuple(round(x, 2) for x in (*mins, *maxs)))
print("size", tuple(round(maxs[i] - mins[i], 2) for i in range(3)))

os.makedirs(os.path.dirname(GAME_MODEL), exist_ok=True)
bpy.ops.object.select_all(action="DESELECT")
for ob in (root, joined, *prop_obs):
    ob.select_set(True)
bpy.context.view_layer.objects.active = root
props = {p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties}
kw = dict(
    filepath=GAME_MODEL, export_format="GLB", use_selection=True, export_apply=True,
    export_yup=True, export_extras=True, export_animations=False,
)
bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in props})
print("exported", GAME_MODEL)
