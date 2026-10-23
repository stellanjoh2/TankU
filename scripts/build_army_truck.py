"""WWII US 6x6 cargo truck (GMC CCKW-style) -> proto/public/models/army_truck.glb.

Run inside Blender:
    import sys; sys.path.append('/Users/stellanjohansson/Cursor/Blender-Test01/scripts')
    import build_army_truck, importlib; importlib.reload(build_army_truck)
    build_army_truck.build(export=True)

Axes: +X front, +Z up, +Y left. Units: metres. Origin at ground centre.
LOD0 is the full mesh (target < 40k tris). LOD1 / LOD2 sit beside it for viewing;
the game reads geometry only and ignores those offsets.
"""
import math
import os
from contextlib import contextmanager
from math import pi, sin, cos, radians

import bpy
import bmesh
from mathutils import Vector, Matrix, Euler

ROOT = "/Users/stellanjohansson/Cursor/Blender-Test01"
GAME_MODEL = os.path.join(ROOT, "proto", "public", "models", "army_truck.glb")
RUIN_MODEL = os.path.join(ROOT, "proto", "public", "models", "army_truck_destroyed.glb")
NAME = "ArmyTruck"
RUIN = "ArmyTruck_Destroyed"
COLLECTION = "ArmyTruck"

AX_Y = Matrix.Rotation(radians(-90), 4, 'X')
AX_X = Matrix.Rotation(radians(90), 4, 'Y')

MAT_DEFS = {
    # name: (linear rgb, metallic, roughness)
    "M_Truck_Olive":  ((0.145, 0.15, 0.055), 0.0, 0.64),
    "M_Truck_Canvas": ((0.38, 0.33, 0.20), 0.0, 0.90),
    "M_Truck_Rubber": ((0.018, 0.018, 0.02), 0.0, 0.9),
    "M_Truck_Metal":  ((0.04, 0.04, 0.042), 0.75, 0.42),
    "M_Truck_Glass":  ((0.05, 0.06, 0.05), 0.05, 0.08),
    "M_Truck_Wood":   ((0.16, 0.14, 0.07), 0.0, 0.72),
    "M_Truck_Mark":   ((0.78, 0.76, 0.68), 0.0, 0.45),
    "M_Truck_Head":   ((0.85, 0.82, 0.7), 0.0, 0.06),
    "M_Truck_Tail":   ((0.45, 0.03, 0.03), 0.0, 0.18),
    "M_Truck_Burnt":  ((0.035, 0.03, 0.025), 0.15, 0.92),
}
ALIAS = {
    "paint": "M_Truck_Olive",
    "canvas": "M_Truck_Canvas",
    "rubber": "M_Truck_Rubber",
    "metal": "M_Truck_Metal",
    "glass": "M_Truck_Glass",
    "wood": "M_Truck_Wood",
    "mark": "M_Truck_Mark",
    "head": "M_Truck_Head",
    "tail": "M_Truck_Tail",
    "burnt": "M_Truck_Burnt",
}

# --- Dimensions (m) ---
WHEEL_R = 0.47
WHEEL_W = 0.23
TRACK = 0.92
AXLE_Z = 0.47
AXLE_X = (2.10, -1.30, -2.52)

BODY_HW = 0.98
CAB_HW = 0.92
FRAME_Z = 0.70
BED_Z = 1.10
SLAT_TOP = 1.84
CAB_ROOF = 2.14
HOOD_Z = 1.56
CANVAS_Z = 2.64

X_BUMPER = 2.98
X_GRILLE = 2.86
X_COWL = 1.42
X_CAB_REAR = 0.18
X_BED0 = 0.16
X_TAIL = -3.46

LOD_VIEW_Y = (0.0, 8.0, 16.0)


def T(x, y=0.0, z=0.0):
    if isinstance(x, (tuple, list, Vector)):
        return Matrix.Translation(Vector(x))
    return Matrix.Translation(Vector((x, y, z)))


def rot_to(axis):
    return Vector((0, 0, 1)).rotation_difference(Vector(axis).normalized()).to_matrix().to_4x4()


def star_pts(r_out, r_in=None, n=5):
    if r_in is None:
        r_in = r_out * 0.38
    pts = []
    for i in range(n * 2):
        a = -pi / 2 + i * pi / n
        r = r_out if i % 2 == 0 else r_in
        pts.append((r * cos(a), r * sin(a)))
    return pts


class Builder:
    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []
        self.flag = self.bm.faces.layers.int.new("nobev")
        self.no_bevel = False

    @contextmanager
    def plain(self):
        old = self.no_bevel
        self.no_bevel = True
        yield
        self.no_bevel = old

    def mi(self, mat):
        name = ALIAS.get(mat, mat)
        if name not in self.mats:
            self.mats.append(name)
        return self.mats.index(name)

    def _tag(self, faces, mat):
        idx = self.mi(mat)
        nb = 1 if self.no_bevel else 0
        for f in faces:
            f.material_index = idx
            f[self.flag] = nb

    @staticmethod
    def _faces_of(verts):
        return {f for v in verts for f in v.link_faces}

    def cube(self, M, mat="paint"):
        ret = bmesh.ops.create_cube(self.bm, size=1.0, matrix=M)
        self._tag(self._faces_of(ret["verts"]), mat)

    def box(self, c, s, mat="paint", R=None):
        Rm = Matrix.Identity(4)
        if R is not None:
            Rm = (R.to_matrix() if isinstance(R, Euler) else R).to_4x4()
        self.cube(T(c) @ Rm @ Matrix.Diagonal((s[0], s[1], s[2], 1.0)), mat)

    def cyl(self, c, axis, r, d, mat="paint", segs=16, r2=None):
        Mx = T(c) @ rot_to(axis)
        ret = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=segs,
                                    radius1=r, radius2=r if r2 is None else r2, depth=d, matrix=Mx)
        old = self.no_bevel
        self.no_bevel = old or segs < 12
        self._tag(self._faces_of(ret["verts"]), mat)
        self.no_bevel = old

    def prism(self, prof, z0, z1, M, mat="paint"):
        bot = [self.bm.verts.new(M @ Vector((x, y, z0))) for x, y in prof]
        top = [self.bm.verts.new(M @ Vector((x, y, z1))) for x, y in prof]
        n = len(prof)
        faces = [self.bm.faces.new(bot), self.bm.faces.new(top[::-1])]
        for i in range(n):
            j = (i + 1) % n
            faces.append(self.bm.faces.new((bot[i], bot[j], top[j], top[i])))
        self._tag(faces, mat)

    def prism_xz(self, prof_xz, y0, y1, mat="paint"):
        prof = [(x, -z) for x, z in prof_xz]
        self.prism(prof, min(y0, y1), max(y0, y1), AX_Y, mat)

    def prism_yz(self, prof_yz, x0, x1, mat="paint", cap=True):
        """Profile in world (y, z), extruded along world X."""
        bot = [self.bm.verts.new(Vector((x0, y, z))) for y, z in prof_yz]
        top = [self.bm.verts.new(Vector((x1, y, z))) for y, z in prof_yz]
        n = len(prof_yz)
        faces = []
        if cap:
            faces.append(self.bm.faces.new(bot))
            faces.append(self.bm.faces.new(top[::-1]))
        for i in range(n):
            j = (i + 1) % n
            faces.append(self.bm.faces.new((bot[i], bot[j], top[j], top[i])))
        self._tag(faces, mat)

    def sheet_x(self, cross, xs, mat="canvas"):
        """Open loft: `cross` is [(y,z),…] along each X in `xs`. No end caps."""
        rings = [[self.bm.verts.new(Vector((x, y, z))) for y, z in cross] for x in xs]
        faces = []
        n = len(cross)
        for a, b in zip(rings, rings[1:]):
            for i in range(n - 1):
                faces.append(self.bm.faces.new((a[i], a[i + 1], b[i + 1], b[i])))
        self._tag(faces, mat)

    def lathe(self, prof, segs, M, mat="paint"):
        angles = [2 * pi * j / segs for j in range(segs)]
        rings = []
        for p in prof:
            r, z = p[0], p[1]
            if r < 1e-6:
                rings.append([self.bm.verts.new(M @ Vector((0, 0, z)))])
            else:
                rings.append([self.bm.verts.new(M @ Vector((r * cos(a), r * sin(a), z))) for a in angles])
        for i in range(len(rings) - 1):
            A, B = rings[i], rings[i + 1]
            idx = self.mi(prof[i][2] if len(prof[i]) > 2 else mat)
            if len(A) == 1 and len(B) == 1:
                continue
            for j in range(segs):
                jn = (j + 1) % segs
                if len(A) == 1:
                    f = self.bm.faces.new((A[0], B[jn], B[j]))
                elif len(B) == 1:
                    f = self.bm.faces.new((A[j], A[jn], B[0]))
                else:
                    f = self.bm.faces.new((A[j], A[jn], B[jn], B[j]))
                f.material_index = idx
                f[self.flag] = 1 if self.no_bevel else 0

    def plate(self, corners, mat="paint", both=True):
        """Open quad (and optional backface) from 4 world-space corners."""
        ids = [self.bm.verts.new(Vector(c)) for c in corners]
        with self.plain():
            self._tag([self.bm.faces.new(ids)], mat)
            if both:
                # Fresh verts so Blender doesn't treat the reverse as a dup face.
                ids2 = [self.bm.verts.new(Vector(c)) for c in corners]
                self._tag([self.bm.faces.new(ids2[::-1])], mat)

    def curl_sheet(self, p0, p1, outward, segs, reach, drop, mat="paint"):
        """Torn sheet curling away and down from attached edge p0–p1 (water-tower style)."""
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

    def finish(self, name, loc=(0, 0, 0), bevel=None, smooth_angle=35):
        bm = self.bm
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        if bevel:
            bw = bm.edges.layers.float.get("bevel_weight_edge") or bm.edges.layers.float.new("bevel_weight_edge")
            lim = radians(28)
            for e in bm.edges:
                fs = e.link_faces
                if len(fs) == 2 and not (fs[0][self.flag] or fs[1][self.flag]) and e.calc_face_angle(0) > lim:
                    e[bw] = 1.0
        bm.faces.layers.int.remove(self.flag)
        me = bpy.data.meshes.new(name + "_geo")
        bm.to_mesh(me)
        bm.free()
        for mn in self.mats:
            me.materials.append(bpy.data.materials[mn])
        ob = bpy.data.objects.new(name, me)
        get_collection().objects.link(ob)
        ob.location = loc
        me.shade_smooth()
        me.set_sharp_from_angle(angle=radians(smooth_angle))
        if bevel:
            w, seg = bevel
            mod = ob.modifiers.new("Bevel", "BEVEL")
            mod.width = w
            mod.segments = seg
            mod.limit_method = "WEIGHT"
            mod.harden_normals = True
        return ob


def get_collection():
    col = bpy.data.collections.get(COLLECTION)
    if col is None:
        col = bpy.data.collections.new(COLLECTION)
    return col


def ensure_materials():
    for name, (rgb, metal, rough) in MAT_DEFS.items():
        m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        m.use_nodes = True
        bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
        bsdf.inputs["Metallic"].default_value = metal
        bsdf.inputs["Roughness"].default_value = rough
        m.diffuse_color = (*rgb, 1.0)


def ensure_scene():
    sc = bpy.data.scenes.get(NAME) or bpy.data.scenes.new(NAME)
    bpy.context.window.scene = sc
    sc.unit_settings.system = "METRIC"
    world = bpy.data.worlds.get(NAME + "_World") or bpy.data.worlds.new(NAME + "_World")
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs[0].default_value = (0.55, 0.57, 0.60, 1.0)
    bg.inputs[1].default_value = 1.15
    sc.world = world
    col = get_collection()
    if col.name not in sc.collection.children:
        sc.collection.children.link(col)
    return sc


def clear_truck():
    """Remove intact LOD meshes; keep the ruined swap if present."""
    col = get_collection()
    for ob in list(col.all_objects):
        if ob.name == RUIN or ob.name.startswith(RUIN):
            continue
        data = ob.data
        bpy.data.objects.remove(ob, do_unlink=True)
        if data is not None and getattr(data, "users", 1) == 0 and isinstance(data, bpy.types.Mesh):
            bpy.data.meshes.remove(data)


def add_star(b, c, axis, r, thick, mat="mark"):
    """Thin 5-point star centred at c, facing `axis`."""
    M = T(c) @ rot_to(axis)
    b.prism(star_pts(r), -thick * 0.5, thick * 0.5, M, mat)


def add_usa(b, origin, normal, h=0.10, thick=0.012, mat="mark"):
    """Block 'U.S.A.' on a face. `normal` is +X or -X; letters run along +Y, up +Z."""
    nx = 1.0 if normal[0] >= 0 else -1.0
    # Front (+X) is viewed looking −X, so +Y is screen-left — flip to keep U.S.A. reading L→R.
    fy = -1.0 if nx > 0 else 1.0
    s = h
    ox, oy, oz = origin
    # (y, z, sy, sz) per stroke, letter-local, height 1, centred
    strokes = [
        # U
        (-1.55, 0.02, 0.14, 0.84), (-1.15, 0.02, 0.14, 0.84), (-1.35, -0.40, 0.54, 0.14),
        # .
        (-0.88, -0.40, 0.08, 0.08),
        # S
        (-0.48, 0.38, 0.50, 0.14), (-0.48, 0.00, 0.50, 0.14), (-0.48, -0.38, 0.50, 0.14),
        (-0.66, 0.19, 0.14, 0.24), (-0.30, -0.19, 0.14, 0.24),
        # .
        (0.00, -0.40, 0.08, 0.08),
        # A
        (0.28, 0.00, 0.14, 0.80), (0.68, 0.00, 0.14, 0.80), (0.48, 0.06, 0.40, 0.12),
        (0.48, 0.36, 0.28, 0.14),
        # .
        (1.02, -0.40, 0.08, 0.08),
    ]
    with b.plain():
        for ly, lz, sy, sz in strokes:
            b.box((ox + nx * thick * 0.5, oy + fy * ly * s, oz + lz * s),
                  (thick, sy * s, sz * s), mat)


def add_wheel(b, x, y, z, detail):
    """Wheel centred at (x,y,z), axle along Y."""
    segs = {"high": 20, "med": 12, "low": 8}[detail]
    M = T(x, y, z) @ Matrix.Rotation(radians(90), 4, "X")
    wr, ww = WHEEL_R, WHEEL_W
    with b.plain():
        if detail == "low":
            b.cyl((x, y, z), (0, 1, 0), wr, ww, "rubber", segs=segs)
            b.cyl((x, y, z), (0, 1, 0), wr * 0.55, ww * 0.7, "metal", segs=segs)
            return
        # Tire lathe (local Z is axle)
        sidewall = 0.04 if detail == "high" else 0.03
        b.lathe([
            (wr * 0.62, -ww * 0.5, "rubber"),
            (wr * 0.86, -ww * 0.5, "rubber"),
            (wr, -ww * 0.32, "rubber"),
            (wr, ww * 0.32, "rubber"),
            (wr * 0.86, ww * 0.5, "rubber"),
            (wr * 0.62, ww * 0.5, "rubber"),
            (wr * 0.55, ww * 0.28, "rubber"),
            (wr * 0.55, -ww * 0.28, "rubber"),
        ], segs, M, "rubber")
        # Rim dish
        b.lathe([
            (0.0, -ww * 0.18, "metal"),
            (wr * 0.22, -ww * 0.18, "metal"),
            (wr * 0.42, -ww * 0.08, "metal"),
            (wr * 0.54, -ww * 0.12, "metal"),
            (wr * 0.54, ww * 0.12, "metal"),
            (wr * 0.42, ww * 0.08, "metal"),
            (wr * 0.22, ww * 0.18, "metal"),
            (0.0, ww * 0.18, "metal"),
        ], segs, M, "metal")
        # Hub + lugs
        b.cyl((x, y, z), (0, 1, 0), wr * 0.14, ww * 0.55, "metal", segs=max(8, segs // 2))
        if detail == "high":
            sign = 1 if y >= 0 else -1
            for i in range(5):
                a = i * 2 * pi / 5 + 0.2
                lx = x + 0.09 * cos(a)
                lz = z + 0.09 * sin(a)
                b.cyl((lx, y + sign * ww * 0.28, lz), (0, 1, 0), 0.016, 0.03, "metal", segs=6)
            # Tread blocks
            n_t = 16
            for i in range(n_t):
                a = i * 2 * pi / n_t
                ca, sa = cos(a), sin(a)
                for row, off in ((-1, -0.055), (1, 0.055)):
                    cx = x + (wr + 0.028) * ca
                    cz = z + (wr + 0.028) * sa
                    # rotate block so it sits on the tire (clear of the carcass to avoid z-fight)
                    R = Matrix.Rotation(a, 4, "Y")
                    b.box((cx, y + off, cz), (0.05, 0.08, 0.022), "rubber", R=R)
        else:
            # med: simple rim ring
            b.cyl((x, y, z), (0, 1, 0), wr * 0.58, ww * 0.2, "metal", segs=segs, r2=wr * 0.50)


def add_leaf_spring(b, x, y, z, length=0.85):
    with b.plain():
        for i, (w, drop) in enumerate(((0.10, 0.0), (0.08, 0.03), (0.06, 0.055))):
            b.box((x, y, z - drop), (length - i * 0.08, 0.045, 0.018), "metal")
        b.box((x - length * 0.42, y, z + 0.04), (0.06, 0.07, 0.08), "metal")
        b.box((x + length * 0.42, y, z + 0.04), (0.06, 0.07, 0.08), "metal")


def add_chassis(b, detail):
    rail_h = 0.12 if detail != "low" else 0.14
    rail_w = 0.07
    for s in (-1, 1):
        b.box(((-0.15), s * 0.36, FRAME_Z), (5.9, rail_w, rail_h), "metal")
    # Cross members
    for x in (2.2, 1.0, -0.4, -1.9, -3.1):
        b.box((x, 0, FRAME_Z), (0.08, 0.78, 0.07), "metal")
    if detail == "low":
        return
    # Axles
    for x in AXLE_X:
        b.cyl((x, 0, AXLE_Z), (0, 1, 0), 0.055, TRACK * 2 - 0.15, "metal", segs=10)
        if detail == "high":
            b.cyl((x, 0, AXLE_Z), (0, 1, 0), 0.12, 0.28, "metal", segs=10)  # diff
            for s in (-1, 1):
                add_leaf_spring(b, x, s * 0.42, FRAME_Z - 0.08, 0.78 if x == AXLE_X[0] else 0.70)
    if detail == "high":
        # Driveshaft
        b.cyl((0.35, 0, AXLE_Z + 0.02), (1, 0, 0), 0.032, 3.4, "metal", segs=8)
        # Exhaust, right side
        b.cyl((1.1, -0.55, 0.42), (1, 0.05, -0.08), 0.04, 1.6, "metal", segs=8)
        b.cyl((-0.2, -0.62, 0.38), (1, 0, 0), 0.045, 0.7, "metal", segs=8)
        # Fuel tank under right cab
        b.box((0.85, -0.72, 0.78), (0.70, 0.28, 0.32), "paint")
        b.cyl((0.55, -0.72, 0.92), (0, 1, 0), 0.04, 0.12, "metal", segs=8)


def add_hood_cab(b, detail):
    hw = CAB_HW
    # Long rounded hood — top slopes down to the grille, sides drop to the fenders.
    hood = [
        (X_GRILLE + 0.02, 1.02),
        (X_GRILLE + 0.06, 1.22),
        (X_GRILLE + 0.02, HOOD_Z - 0.06),
        (X_GRILLE - 0.16, HOOD_Z + 0.01),
        (X_COWL + 0.06, HOOD_Z + 0.05),
        (X_COWL + 0.06, 1.08),
    ]
    b.prism_xz(hood, -hw + 0.06, hw - 0.06, "paint")
    if detail != "low":
        b.box(((X_GRILLE + X_COWL) * 0.5, 0, HOOD_Z + 0.04),
              (X_GRILLE - X_COWL - 0.12, 0.05, 0.055), "paint")
        # Hood side panels
        for s in (-1, 1):
            b.box(((X_GRILLE + X_COWL) * 0.5 - 0.02, s * (hw - 0.01), 1.30),
                  (X_GRILLE - X_COWL - 0.08, 0.05, 0.46), "paint")
            if detail == "high":
                # Louver rows
                for i in range(4):
                    b.box((2.35 - i * 0.18, s * (hw + 0.01), 1.34), (0.04, 0.02, 0.22), "metal")

    # Grille frame + recessed well
    gh, gw = 0.78, hw * 2 - 0.14
    b.box((X_GRILLE - 0.01, 0, 1.30), (0.10, gw + 0.08, gh + 0.10), "paint")
    with b.plain():
        b.box((X_GRILLE + 0.03, 0, 1.30), (0.05, gw - 0.08, gh - 0.10), "metal")
        if detail == "high":
            for i in range(11):
                y = -0.72 + i * 0.144
                b.box((X_GRILLE + 0.06, y, 1.30), (0.018, 0.024, gh - 0.18), "paint")
            b.box((X_GRILLE + 0.055, 0, 1.48), (0.016, gw - 0.14, 0.018), "paint")
            b.box((X_GRILLE + 0.055, 0, 1.12), (0.016, gw - 0.14, 0.018), "paint")
        elif detail == "med":
            for i in range(6):
                y = -0.62 + i * 0.248
                b.box((X_GRILLE + 0.055, y, 1.30), (0.02, 0.035, gh - 0.20), "paint")

    segs = {"high": 14, "med": 10, "low": 6}[detail]
    for s in (-1, 1):
        hx, hy, hz = X_GRILLE + 0.10, s * 0.42, 1.32
        b.cyl((hx, hy, hz), (1, 0, 0), 0.125, 0.09, "head", segs=segs)
        if detail != "low":
            b.cyl((hx - 0.02, hy, hz), (1, 0, 0), 0.132, 0.05, "metal", segs=segs)
            if detail == "high":
                b.cyl((hx + 0.04, hy, hz), (1, 0, 0), 0.138, 0.018, "metal", segs=segs, r2=0.128)
                for k in range(4):
                    a = k * pi / 4
                    R = Euler((0, a, 0))
                    b.box((hx + 0.05, hy, hz), (0.01, 0.01, 0.26), "metal", R=R)
            b.cyl((X_GRILLE + 0.06, s * 0.40, 1.58), (1, 0, 0), 0.032, 0.04, "head", segs=8)

    # Bumper, tight to the frame with two stays
    b.box((X_BUMPER, 0, 0.56), (0.10, 2.12, 0.12), "paint")
    for s in (-1, 1):
        b.box(((X_BUMPER + X_GRILLE) * 0.5 - 0.02, s * 0.50, 0.55),
              (X_BUMPER - X_GRILLE + 0.10, 0.10, 0.08), "paint")
        if detail != "low":
            b.box((X_BUMPER + 0.02, s * 0.90, 0.40), (0.07, 0.09, 0.14), "metal")
    if detail == "high":
        add_usa(b, (X_BUMPER + 0.05, 0.52, 0.57), (1, 0, 0), 0.085)
        add_star(b, (X_BUMPER + 0.05, -0.58, 0.57), (1, 0, 0), 0.07, 0.012)
    elif detail == "med":
        add_star(b, (X_BUMPER + 0.05, 0, 0.57), (1, 0, 0), 0.075, 0.012)

    # Front fenders wrapping the front wheels
    for s in (-1, 1):
        y0, y1 = (s * 0.70, s * 1.20) if s > 0 else (s * 1.20, s * 0.70)
        fender = [
            (2.82, 0.82),
            (2.92, 1.02),
            (2.70, 1.22),
            (2.28, 1.34),
            (1.88, 1.34),
            (1.52, 1.18),
            (1.38, 0.88),
            (1.48, 0.82),
            (1.70, 1.08),
            (2.20, 1.16),
            (2.64, 1.06),
            (2.82, 0.82),
        ]
        b.prism_xz(fender, y0, y1, "paint")

    # Cab — taller greenhouse, raked windshield
    cab = [
        (X_COWL + 0.04, 1.08),
        (X_COWL - 0.02, 1.68),
        (X_COWL - 0.16, CAB_ROOF + 0.02),
        (X_CAB_REAR + 0.06, CAB_ROOF + 0.04),
        (X_CAB_REAR, 1.10),
    ]
    b.prism_xz(cab, -hw, hw, "paint")
    if detail != "low":
        b.box(((X_COWL + X_CAB_REAR) * 0.5 - 0.04, 0, CAB_ROOF + 0.04),
              (X_COWL - X_CAB_REAR - 0.10, hw * 2 + 0.05, 0.05), "paint")

    if detail != "low":
        with b.plain():
            rake = Euler((0, radians(-14), 0))
            # Recessed well so the glass reads as a dark opening
            b.box((X_COWL - 0.02, 0, 1.90), (0.06, 1.72, 0.58), "metal", R=rake)
            for s in (-1, 1):
                b.box((X_COWL - 0.05, s * 0.44, 1.90), (0.03, 0.74, 0.52), "glass", R=rake)
            b.box((X_COWL - 0.04, 0, 1.90), (0.04, 0.06, 0.54), "paint", R=rake)
            if detail == "high":
                for s in (-1, 1):
                    b.box((X_COWL + 0.01, s * 0.20, 1.60), (0.012, 0.44, 0.012), "metal",
                          R=Euler((0, radians(18), s * radians(16))))
                b.box((X_COWL + 0.18, hw + 0.09, 1.74), (0.04, 0.13, 0.09), "metal")
                b.box((X_COWL + 0.18, hw + 0.16, 1.74), (0.01, 0.02, 0.11), "glass")
                b.cyl((X_COWL + 0.14, hw + 0.03, 1.56), (0, 0.35, 1), 0.012, 0.30, "metal", segs=6)

    for s in (-1, 1):
        if detail != "low":
            with b.plain():
                b.box(((X_COWL + X_CAB_REAR) * 0.5 - 0.04, s * (hw + 0.014), 1.80),
                      (0.70, 0.02, 0.40), "glass")
                if detail == "high":
                    b.box((0.82, s * (hw + 0.03), 1.40), (0.08, 0.03, 0.03), "metal")
                    add_star(b, ((X_COWL + X_CAB_REAR) * 0.5, s * (hw + 0.028), 1.34),
                             (0, s, 0), 0.14, 0.01)
        else:
            add_star(b, ((X_COWL + X_CAB_REAR) * 0.5, s * (hw + 0.02), 1.38),
                     (0, s, 0), 0.14, 0.012)

    add_star(b, ((X_GRILLE + X_COWL) * 0.5 + 0.10, 0, HOOD_Z + 0.07), (0, 0, 1), 0.17, 0.012)

    for s in (-1, 1):
        b.box((0.80, s * 1.00, 0.90), (1.20, 0.24, 0.045), "paint")

    if detail != "low":
        b.box((0.98, -1.10, 1.14), (0.17, 0.34, 0.44), "paint")
        if detail == "high":
            b.box((0.98, -1.10, 1.38), (0.19, 0.12, 0.04), "metal")
            b.cyl((0.98, -1.10, 1.40), (0, 0, 1), 0.028, 0.05, "metal", segs=8)

    if detail == "high":
        with b.plain():
            b.box((0.82, 0.38, 1.30), (0.40, 0.46, 0.36), "wood")
            b.box((0.82, -0.32, 1.30), (0.40, 0.46, 0.36), "wood")
            b.cyl((1.16, 0.38, 1.60), (0.35, 0, 0.15), 0.13, 0.03, "metal", segs=10)
            b.box((1.20, 0.0, 1.44), (0.20, 0.52, 0.07), "metal")


def add_cargo(b, detail):
    hw = BODY_HW
    b.box(((X_BED0 + X_TAIL) * 0.5, 0, BED_Z - 0.03), (X_BED0 - X_TAIL, hw * 2 - 0.04, 0.07), "wood")
    b.box((X_BED0 + 0.03, 0, (BED_Z + SLAT_TOP) * 0.5), (0.06, hw * 2, SLAT_TOP - BED_Z), "paint")

    # Slats with real gaps so the interior reads from the side.
    n_slats = {"high": 6, "med": 3, "low": 1}[detail]
    gap = 0.045 if detail == "high" else 0.02
    usable = SLAT_TOP - BED_Z - 0.04
    slat_h = (usable - (n_slats - 1) * gap) / n_slats
    post_xs = [X_BED0 + 0.10, (X_BED0 + X_TAIL) * 0.5, X_TAIL + 0.12]
    if detail == "low":
        for s in (-1, 1):
            b.box(((X_BED0 + X_TAIL) * 0.5, s * hw, (BED_Z + SLAT_TOP) * 0.5),
                  (X_BED0 - X_TAIL, 0.05, SLAT_TOP - BED_Z), "paint")
    else:
        with b.plain():
            for s in (-1, 1):
                z = BED_Z + 0.02 + slat_h * 0.5
                for _i in range(n_slats):
                    b.box(((X_BED0 + X_TAIL) * 0.5, s * hw, z),
                          (X_BED0 - X_TAIL - 0.06, 0.04, slat_h), "paint")
                    z += slat_h + gap
                for x in post_xs:
                    b.box((x, s * hw, (BED_Z + SLAT_TOP) * 0.5),
                          (0.06, 0.06, SLAT_TOP - BED_Z + 0.02), "paint")

    b.box((X_TAIL, 0, (BED_Z + SLAT_TOP) * 0.5 - 0.02),
          (0.05, hw * 2 - 0.08, SLAT_TOP - BED_Z - 0.06), "paint")
    if detail == "high":
        add_usa(b, (X_TAIL - 0.03, 0.48, 1.30), (-1, 0, 0), 0.10)
        add_star(b, (X_TAIL - 0.03, -0.22, 1.32), (-1, 0, 0), 0.15, 0.012)
        for s in (-1, 1):
            b.cyl((X_TAIL - 0.03, s * 0.84, 1.16), (-1, 0, 0), 0.038, 0.04, "tail", segs=8)
            b.box((X_TAIL - 0.07, s * 0.74, 0.70), (0.10, 0.12, 0.10), "metal")
            b.cyl((X_TAIL + 0.02, s * (hw - 0.04), 1.50), (0, 0, 1), 0.008, 0.50, "metal", segs=6)
    elif detail == "med":
        add_star(b, (X_TAIL - 0.03, 0, 1.32), (-1, 0, 0), 0.15, 0.012)

    # Open canvas roof (no end walls) + short side valances.
    x0, x1 = X_BED0 + 0.02, X_TAIL + 0.04
    n_x = {"high": 7, "med": 4, "low": 2}[detail]
    xs = [x0 + (x1 - x0) * i / (n_x - 1) for i in range(n_x)]
    # Slight sag between bows
    def cross_at(i):
        sag = 0.0
        if detail == "high" and 0 < i < n_x - 1:
            sag = 0.035 * sin(pi * i / (n_x - 1))
        zt = CANVAS_Z - sag
        return [
            (-hw - 0.03, SLAT_TOP + 0.10),
            (-hw + 0.02, SLAT_TOP + 0.48),
            (-hw * 0.50, zt - 0.04),
            (0.0, zt),
            (hw * 0.50, zt - 0.04),
            (hw - 0.02, SLAT_TOP + 0.48),
            (hw + 0.03, SLAT_TOP + 0.10),
        ]
    with b.plain():
        rings_cross = [cross_at(i) for i in range(n_x)]
        bm = b.bm
        rings = [[bm.verts.new(Vector((xs[i], y, z))) for y, z in rings_cross[i]] for i in range(n_x)]
        faces = []
        for a, br in zip(rings, rings[1:]):
            for k in range(len(a) - 1):
                faces.append(bm.faces.new((a[k], a[k + 1], br[k + 1], br[k])))
        b._tag(faces, "canvas")

    if detail == "high":
        with b.plain():
            for i in range(4):
                t = i / 3
                x = x0 + (x1 - x0) * t
                # Keep bows clearly under the canvas skin (no coplanar metal/canvas).
                b.box((x, 0, CANVAS_Z - 0.10), (0.028, hw * 2 - 0.16, 0.028), "metal")
                for s in (-1, 1):
                    b.box((x, s * (hw - 0.04), (SLAT_TOP + CANVAS_Z) * 0.5),
                          (0.028, 0.028, CANVAS_Z - SLAT_TOP - 0.18), "metal")
            for s in (-1, 1):
                b.cyl((X_TAIL + 0.10, s * hw, SLAT_TOP + 0.18), (0, 0, 1), 0.008, 0.32, "metal", segs=5)

    if detail == "high":
        with b.plain():
            for s in (-1, 1):
                b.box(((X_BED0 + X_TAIL) * 0.5, s * (hw - 0.24), BED_Z + 0.17),
                      (X_BED0 - X_TAIL - 0.30, 0.18, 0.055), "wood")
                b.box(((X_BED0 + X_TAIL) * 0.5, s * (hw - 0.24), BED_Z + 0.08),
                      (X_BED0 - X_TAIL - 0.50, 0.055, 0.14), "wood")
            b.box((-0.85, 0.30, BED_Z + 0.10), (0.55, 0.28, 0.18), "paint")
            b.box((-1.65, -0.24, BED_Z + 0.08), (0.42, 0.22, 0.16), "paint")
            b.box((-2.45, 0.12, BED_Z + 0.12), (0.18, 0.35, 0.22), "paint")


def count_tris(ob):
    deps = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(deps)
    me = ev.to_mesh()
    n = sum(len(p.vertices) - 2 for p in me.polygons)
    ev.to_mesh_clear()
    return n


def build_lod(level):
    detail = ("high", "med", "low")[level]
    b = Builder()
    add_chassis(b, detail)
    add_hood_cab(b, detail)
    add_cargo(b, detail)
    for x in AXLE_X:
        for s in (-1, 1):
            add_wheel(b, x, s * TRACK, AXLE_Z, detail)
    name = NAME if level == 0 else f"{NAME}_LOD{level}"
    bevel = (0.008, 2) if level == 0 else None
    ob = b.finish(name, loc=(0.0, LOD_VIEW_Y[level], 0.0), bevel=bevel)
    if level:
        ob.hide_set(True)
        ob.hide_render = True
    tris = count_tris(ob)
    print(f"{ob.name}: {tris} tris  detail={detail}")
    return ob, tris


def setup_view(sc):
    # Studio sun so look() reads form
    light = bpy.data.objects.get(NAME + "_Sun")
    if light is None:
        data = bpy.data.lights.new(NAME + "_Sun", "SUN")
        data.energy = 4.0
        data.angle = 0.15
        light = bpy.data.objects.new(NAME + "_Sun", data)
        sc.collection.objects.link(light)
    light.rotation_euler = (radians(50), radians(-15), radians(35))
    # Ground card under LOD0 only, not exported (not in the truck collection)
    ground = bpy.data.objects.get(NAME + "_Ground")
    if ground is None:
        me = bpy.data.meshes.new(NAME + "_Ground_geo")
        bm = bmesh.new()
        bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=8.0)
        bm.to_mesh(me)
        bm.free()
        ground = bpy.data.objects.new(NAME + "_Ground", me)
        sc.collection.objects.link(ground)
        mat = bpy.data.materials.get(NAME + "_GroundMat") or bpy.data.materials.new(NAME + "_GroundMat")
        mat.use_nodes = True
        bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Base Color"].default_value = (0.45, 0.45, 0.46, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.85
        me.materials.append(mat)
    ground.location = (0, 0, -0.002)


def cleanup_zfight(ob, dist=0.012):
    """Drop coplanar overlaps from stacked boxes (same-facing dups + opposite internal walls)."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.faces.ensure_lookup_table()
    before = len(bm.faces)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    bm.faces.ensure_lookup_table()
    cell = dist
    buckets = {}
    for f in bm.faces:
        p = f.calc_center_median()
        buckets.setdefault((int(p.x / cell), int(p.y / cell), int(p.z / cell)), []).append(f)
    kill = set()
    for key, faces in buckets.items():
        neigh = []
        for ox in (-1, 0, 1):
            for oy in (-1, 0, 1):
                for oz in (-1, 0, 1):
                    neigh.extend(buckets.get((key[0] + ox, key[1] + oy, key[2] + oz), []))
        for fa in faces:
            if fa in kill or not fa.is_valid:
                continue
            pa, na = fa.calc_center_median(), fa.normal
            aa = fa.calc_area()
            for fb in neigh:
                if fb is fa or fb in kill or not fb.is_valid:
                    continue
                pb = fb.calc_center_median()
                if (pa - pb).length > dist:
                    continue
                ab = fb.calc_area()
                if max(aa, ab) < 1e-8 or min(aa, ab) / max(aa, ab) < 0.4:
                    continue
                dot = na.dot(fb.normal)
                if abs(dot) < 0.97:
                    continue
                if abs(na.dot(pb - pa)) > dist * 0.5:
                    continue
                if dot < 0:
                    kill.add(fa)
                    kill.add(fb)
                else:
                    kill.add(fa if aa < ab else fb)
    if kill:
        bmesh.ops.delete(bm, geom=list(kill), context="FACES")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    ob.data.update()
    bm.free()
    print(f"  zfight clean {ob.name}: {before} -> {len(ob.data.polygons)} faces")


def export_glb(path):
    """Export only the three intact LOD meshes (ruin stays out of this file)."""
    names = (NAME, f"{NAME}_LOD1", f"{NAME}_LOD2")
    tmp = bpy.data.scenes.new("_TruckExport")
    win = bpy.context.window
    prev = win.scene
    win.scene = tmp
    try:
        for name in names:
            o = bpy.data.objects[name]
            o.hide_set(False)
            o.hide_viewport = False
            o.hide_render = False
            tmp.collection.objects.link(o)
        props = {p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties}
        kw = dict(filepath=path, export_format="GLB", export_apply=True,
                  export_yup=True, export_extras=True, export_animations=False,
                  use_active_scene=True)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in props})
        print("exported", path, f"{os.path.getsize(path) / 1024:.0f} KB")
    finally:
        win.scene = prev
        bpy.data.scenes.remove(tmp)


def build(export=False):
    sc = ensure_scene()
    ensure_materials()
    clear_truck()
    setup_view(sc)
    total = 0
    for lvl in range(3):
        ob, tris = build_lod(lvl)
        # Apply bevel before cleanup so z-fight pass sees final faces.
        if ob.modifiers:
            dg = bpy.context.evaluated_depsgraph_get()
            new = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True,
                                                  depsgraph=dg)
            old = ob.data
            name = old.name
            ob.modifiers.clear()
            ob.data = new
            if old.users == 0:
                bpy.data.meshes.remove(old)
            new.name = name
            tris = sum(len(p.vertices) - 2 for p in new.polygons)
        cleanup_zfight(ob)
        if lvl == 0:
            total = tris
    print(f"LOD0 tris={total}  (budget 40000)")
    if export:
        export_glb(GAME_MODEL)
        for lvl in (1, 2):
            o = bpy.data.objects.get(f"{NAME}_LOD{lvl}")
            if o:
                o.hide_set(True)
    return total


# --------------------------------------------------------------------------- ruined swap mesh
# Same origin / scale as the intact truck. Cab crushed, hood peeled, canvas torn,
# one side of the bed blown out, debris on the ground — water-tower energy.


def _clear_ruin():
    ob = bpy.data.objects.get(RUIN)
    if not ob:
        return
    me = ob.data
    bpy.data.objects.remove(ob, do_unlink=True)
    if me and getattr(me, "users", 1) == 0:
        bpy.data.meshes.remove(me)


def build_ruined_geometry():
    """Procedural wreck. Axes match the intact truck (+X front, +Z up)."""
    b = Builder()
    hw = BODY_HW

    # --- Bent frame (right rail kinked / broken mid-bed) ---
    b.box((-0.2, 0.36, FRAME_Z - 0.04), (5.6, 0.08, 0.12), "metal")
    # Left rail in two pieces with a sag
    b.box((1.4, -0.36, FRAME_Z - 0.02), (2.4, 0.08, 0.12), "metal")
    b.box((-1.6, -0.42, FRAME_Z - 0.18), (2.8, 0.08, 0.12), "metal",
          R=Euler((0, radians(8), radians(-4))))
    for x in (2.0, -0.2, -2.4):
        b.box((x, 0, FRAME_Z - 0.08), (0.08, 0.72, 0.07), "metal")

    # --- Axles: front intact-ish, mid bent, rear sheared ---
    b.cyl((AXLE_X[0], 0, AXLE_Z - 0.04), (0, 1, 0), 0.05, TRACK * 2 - 0.2, "metal", segs=8)
    b.cyl((AXLE_X[1], 0.1, AXLE_Z - 0.1), (0.15, 1, -0.1), 0.05, TRACK * 1.6, "metal", segs=8)
    b.cyl((AXLE_X[2], -0.15, AXLE_Z), (0, 1, 0), 0.05, TRACK * 1.1, "metal", segs=8)

    # --- Wheels: FL missing (on ground), FR flat, rears present ---
    add_wheel(b, AXLE_X[0], -TRACK, AXLE_Z - 0.12, "med")   # flat-ish (sunk)
    add_wheel(b, AXLE_X[1], TRACK, AXLE_Z - 0.02, "low")
    add_wheel(b, AXLE_X[1], -TRACK, AXLE_Z - 0.06, "low")
    add_wheel(b, AXLE_X[2], TRACK, AXLE_Z, "low")
    # Blown wheel in the dirt ahead-left
    add_wheel(b, 3.6, 1.55, WHEEL_R * 0.55, "med")
    # Spare / wheel shard
    b.cyl((2.8, -1.7, 0.12), (0.4, 0.2, 0.9), WHEEL_R * 0.7, WHEEL_W * 0.7, "rubber", segs=10)

    # --- Crushed cab ---
    # Floor / cowl stump
    b.box((0.85, 0, 1.05), (1.1, hw * 2 - 0.1, 0.08), "burnt")
    # Driver side wall still up, roof caved toward −Y
    cab_wall = [
        (X_COWL - 0.05, 1.08),
        (X_COWL - 0.12, 1.70),
        (X_CAB_REAR + 0.05, 1.55),
        (X_CAB_REAR, 1.10),
    ]
    b.prism_xz(cab_wall, 0.15, hw - 0.02, "paint")
    # Passenger side blown out — jagged low remnant
    b.box((0.75, -hw + 0.08, 1.22), (0.9, 0.08, 0.35), "burnt")
    b.box((0.55, -hw + 0.05, 1.45), (0.35, 0.06, 0.25), "paint",
          R=Euler((radians(25), 0, radians(-18))))
    # Crushed roof slab, slumped
    b.box((0.7, 0.15, 1.55), (1.0, 1.1, 0.06), "burnt",
          R=Euler((radians(18), radians(-6), radians(12))))
    # Seat husks
    b.box((0.8, 0.35, 1.22), (0.35, 0.4, 0.28), "burnt")
    b.box((0.75, -0.15, 1.18), (0.3, 0.35, 0.2), "burnt")
    # Steering column bent
    b.cyl((1.15, 0.35, 1.35), (0.5, 0.2, 0.6), 0.03, 0.45, "metal", segs=6)

    # Door hanging off the driver side
    b.box((0.7, hw + 0.35, 1.25), (0.7, 0.05, 0.85), "paint",
          R=Euler((radians(-8), radians(5), radians(55))))
    add_star(b, (0.7, hw + 0.38, 1.15), (0, 1, 0), 0.11, 0.012)

    # --- Hood peeled back and curled ---
    # Remaining hood stub at the cowl
    b.box((1.55, 0, 1.35), (0.35, hw * 1.5, 0.08), "burnt")
    b.curl_sheet(
        (1.75, hw - 0.15, 1.42), (1.75, -hw + 0.15, 1.42),
        (1, 0.1, 0.2), segs=6, reach=1.6, drop=0.85, mat="paint",
    )
    # Second peel off the passenger fender line
    b.curl_sheet(
        (2.4, -hw + 0.1, 1.2), (1.9, -hw + 0.1, 1.15),
        (0.2, -1, 0.1), segs=4, reach=0.9, drop=0.7, mat="paint",
    )
    # Grille fragment on the ground
    b.box((3.5, -0.3, 0.08), (0.12, 0.7, 0.45), "metal",
          R=Euler((radians(70), radians(10), radians(-20))))
    b.box((3.2, 0.6, 0.06), (0.5, 0.35, 0.05), "paint")

    # Bumper twisted
    b.box((X_BUMPER - 0.15, 0.2, 0.45), (0.1, 1.6, 0.1), "paint",
          R=Euler((radians(25), 0, radians(12))))
    b.box((X_BUMPER - 0.05, -0.9, 0.25), (0.1, 0.5, 0.1), "metal",
          R=Euler((0, radians(-20), radians(-35))))

    # --- Engine block exposed ---
    b.box((2.2, 0, 1.05), (0.7, 0.55, 0.5), "burnt")
    b.box((2.35, 0.15, 1.35), (0.35, 0.25, 0.2), "metal")
    for s in (-1, 1):
        b.cyl((2.5, s * 0.35, 1.15), (1, 0, 0.1), 0.04, 0.35, "metal", segs=6)

    # Front fender — left gone, right crumpled
    b.box((2.2, -1.0, 1.05), (0.9, 0.25, 0.2), "paint",
          R=Euler((radians(-35), radians(15), radians(-25))))

    # --- Cargo bed: right side mostly gone, left partial, floor buckled ---
    b.box(((X_BED0 + X_TAIL) * 0.5 + 0.2, 0.05, BED_Z - 0.06),
          (X_BED0 - X_TAIL - 0.4, hw * 1.6, 0.07), "burnt",
          R=Euler((0, radians(4), radians(3))))
    # Left slats (partial, charred)
    for i, z in enumerate((1.25, 1.45, 1.65)):
        b.box((-1.2, hw - 0.02, z), (2.8 - i * 0.3, 0.04, 0.08), "paint" if i else "burnt")
    for x in (X_BED0 + 0.1, -1.5):
        b.box((x, hw, (BED_Z + SLAT_TOP) * 0.5 - 0.1), (0.05, 0.05, 0.55), "metal")
    # Right side: shredded posts + dangling slat
    b.box((X_BED0 + 0.1, -hw, 1.35), (0.05, 0.05, 0.4), "metal")
    b.box((-0.8, -hw - 0.15, 1.2), (1.2, 0.04, 0.08), "paint",
          R=Euler((radians(40), 0, radians(-15))))
    b.box((-2.2, -hw + 0.05, 1.15), (0.06, 0.06, 0.5), "metal",
          R=Euler((0, radians(20), radians(25))))
    # Bulkhead scorched
    b.box((X_BED0 + 0.03, 0.1, 1.35), (0.06, hw * 1.7, 0.55), "burnt")
    # Tailgate blown open / on the ground
    b.box((X_TAIL - 0.4, 0.3, 0.08), (0.06, 1.5, 0.7), "paint",
          R=Euler((radians(85), radians(-10), radians(8))))
    add_star(b, (X_TAIL - 0.38, 0.1, 0.35), (1, 0.1, 0), 0.12, 0.012)

    # Interior crates smashed
    b.box((-1.0, 0.2, BED_Z + 0.08), (0.45, 0.25, 0.12), "wood",
          R=Euler((0, 0, radians(35))))
    b.box((-1.8, -0.3, BED_Z + 0.05), (0.3, 0.35, 0.15), "burnt")

    # --- Canvas: mostly gone; torn flaps on remaining bows ---
    # Front bow bent
    b.box((X_BED0 + 0.15, 0.1, CANVAS_Z - 0.35), (0.03, hw * 1.5, 0.03), "metal",
          R=Euler((0, radians(-25), radians(8))))
    for s in (-1, 1):
        b.box((X_BED0 + 0.15, s * (hw - 0.05), 1.9), (0.03, 0.03, 0.45), "metal",
              R=Euler((s * radians(15), 0, 0)))
    # Mid bow snapped, hanging
    b.box((-1.2, 0.3, 1.7), (0.03, 0.9, 0.03), "metal",
          R=Euler((radians(55), radians(10), 0)))
    b.box((-1.2, -0.5, 1.4), (0.03, 0.5, 0.03), "metal",
          R=Euler((radians(-40), 0, radians(20))))
    # Canvas flaps
    b.curl_sheet(
        (X_BED0 + 0.2, hw - 0.2, SLAT_TOP + 0.35),
        (X_BED0 + 0.2, -0.1, SLAT_TOP + 0.5),
        (0.3, 0.4, 1), segs=5, reach=1.15, drop=1.4, mat="canvas",
    )
    b.curl_sheet(
        (-0.5, hw - 0.05, SLAT_TOP + 0.15),
        (-1.8, hw - 0.05, SLAT_TOP + 0.1),
        (0, 1, 0.25), segs=5, reach=0.95, drop=1.15, mat="canvas",
    )
    # Rear canvas rag draping out the open bed
    b.curl_sheet(
        (X_TAIL + 0.3, 0.5, SLAT_TOP - 0.05),
        (X_TAIL + 0.3, -0.4, SLAT_TOP),
        (-1, 0.1, 0.2), segs=4, reach=0.8, drop=0.9, mat="canvas",
    )
    # Charred canvas scrap on the bed
    b.box((-2.0, 0.1, BED_Z + 0.04), (0.8, 0.5, 0.03), "burnt",
          R=Euler((0, 0, radians(-20))))

    # --- Peeled side panel (left cargo) hanging down ---
    b.curl_sheet(
        (-0.3, hw + 0.02, SLAT_TOP - 0.05),
        (-1.6, hw + 0.02, SLAT_TOP - 0.1),
        (0, 1, 0), segs=5, reach=0.85, drop=1.0, mat="paint",
    )

    # --- Ground debris around the wreck ---
    b.box((1.2, 1.8, 0.05), (0.7, 0.45, 0.04), "paint",
          R=Euler((0, radians(5), radians(40))))
    b.box((-0.5, -1.9, 0.04), (0.55, 0.35, 0.03), "canvas",
          R=Euler((radians(10), 0, radians(-50))))
    b.box((-2.8, 1.4, 0.06), (0.4, 0.25, 0.08), "wood",
          R=Euler((0, 0, radians(70))))
    b.box((0.2, 1.6, 0.07), (0.25, 0.15, 0.12), "metal")
    # Torn metal straps
    for tip, end, w in (
        ((1.4, hw, 1.5), (1.9, hw + 0.6, 0.9), 0.1),
        ((-2.5, -hw, 1.3), (-2.9, -hw - 0.5, 0.7), 0.08),
        ((2.0, -0.5, 1.2), (2.6, -1.0, 0.5), 0.12),
    ):
        b.ribbon(tip, end, w, "metal")

    # Jerry can knocked over
    b.box((1.1, -1.35, 0.18), (0.17, 0.35, 0.42), "paint",
          R=Euler((radians(90), 0, radians(25))))

    # Exhaust bent out
    b.cyl((0.5, -0.7, 0.45), (0.6, -0.5, -0.2), 0.04, 1.2, "burnt", segs=6)

    return b


def export_ruin_glb(path):
    ob = bpy.data.objects[RUIN]
    ob.hide_set(False)
    ob.hide_viewport = False
    ob.hide_render = False
    # Temp scene so we don't drag intact LODs / leftovers into the file.
    tmp = bpy.data.scenes.new("_TruckRuinExport")
    win = bpy.context.window
    prev = win.scene
    win.scene = tmp
    try:
        tmp.collection.objects.link(ob)
        props = {p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties}
        kw = dict(filepath=path, export_format="GLB", export_apply=True,
                  export_yup=True, export_extras=True, export_animations=False,
                  use_active_scene=True)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in props})
        print("exported", path, f"{os.path.getsize(path) / 1024:.0f} KB")
    finally:
        win.scene = prev
        bpy.data.scenes.remove(tmp)


def _flat_ruin_materials(ob):
    """Ruin must not sample the intact truck's lightmap atlas (wrong UVs)."""
    for i, slot in enumerate(ob.material_slots):
        src = slot.material
        if not src:
            continue
        base = src.name.replace("_Flat", "").replace("_Ruin", "")
        rn = base + "_Ruin"
        flat = bpy.data.materials.get(rn)
        if flat is None:
            # Prefer the un-textured definition from MAT_DEFS.
            key = next((k for k, v in MAT_DEFS.items() if k == base), None)
            flat = bpy.data.materials.new(rn)
            flat.use_nodes = True
            bsdf = next(n for n in flat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
            if key:
                rgb, metal, rough = MAT_DEFS[key]
                bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
                bsdf.inputs["Metallic"].default_value = metal
                bsdf.inputs["Roughness"].default_value = rough
                flat.diffuse_color = (*rgb, 1.0)
            else:
                # Copy values off the source BSDF (ignore image links).
                sbsdf = next(n for n in src.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
                bsdf.inputs["Base Color"].default_value = sbsdf.inputs["Base Color"].default_value
                bsdf.inputs["Metallic"].default_value = sbsdf.inputs["Metallic"].default_value
                bsdf.inputs["Roughness"].default_value = sbsdf.inputs["Roughness"].default_value
        ob.material_slots[i].material = flat


def build_ruined(export=False):
    """Destroyed swap mesh in the ArmyTruck scene. Leaves intact LODs alone."""
    sc = ensure_scene()
    ensure_materials()
    _clear_ruin()
    setup_view(sc)
    b = build_ruined_geometry()
    # Park it beside LOD2 for viewing in Blender
    ob = b.finish(RUIN, loc=(0.0, 24.0, 0.0), bevel=None, smooth_angle=40)
    cleanup_zfight(ob, dist=0.01)
    _flat_ruin_materials(ob)
    tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
    print(f"{RUIN}: {tris} tris")
    if export:
        # Export from origin
        saved = ob.location.copy()
        ob.location = (0, 0, 0)
        bpy.context.view_layer.update()
        export_ruin_glb(RUIN_MODEL)
        ob.location = saved
    return ob


if __name__ == "__main__":
    build(export=True)
    build_ruined(export=True)
