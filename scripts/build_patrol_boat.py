"""Enemy patrol boat placeholder -> proto/public/models/patrol_boat.glb.

Run inside Blender:
    import sys; sys.path.append('/Users/stellanjohansson/Cursor/Blender-Test01/scripts')
    import build_patrol_boat, importlib; importlib.reload(build_patrol_boat)
    build_patrol_boat.build(export=True)

Axes: +X front (bow), +Z up, +Y left. Units: metres.
Origin at waterline centre (keel below Z=0).

Hierarchy (gameplay-ready):
  PatrolBoat              hull / cabin / deck / mast (static)
  FrontTurret             MG + pedestal; origin at pedestal base on deck
                          rotate local Z for 360° traverse
LODs: PatrolBoat_LOD{1,2} and FrontTurret_LOD{1,2} parked on +Y for viewing.
LOD0 target ~50k tris. No rear turret (omitted by design).
"""
import math
import os
from contextlib import contextmanager
from math import pi, sin, cos, radians

import bpy
import bmesh
from mathutils import Vector, Matrix, Euler

ROOT = "/Users/stellanjohansson/Cursor/Blender-Test01"
GAME_MODEL = os.path.join(ROOT, "proto", "public", "models", "patrol_boat.glb")
NAME = "PatrolBoat"
TURRET = "FrontTurret"
COLLECTION = "PatrolBoat"

AX_Y = Matrix.Rotation(radians(-90), 4, "X")
AX_X = Matrix.Rotation(radians(90), 4, "Y")

MAT_DEFS = {
    "M_Boat_Olive":  ((0.145, 0.155, 0.055), 0.05, 0.68),
    "M_Boat_Hull":   ((0.02, 0.02, 0.022), 0.15, 0.55),
    "M_Boat_Metal":  ((0.04, 0.04, 0.042), 0.75, 0.40),
    "M_Boat_Glass":  ((0.04, 0.05, 0.045), 0.05, 0.06),
    "M_Boat_Mark":   ((0.82, 0.80, 0.72), 0.0, 0.42),
    "M_Boat_Rubber": ((0.03, 0.03, 0.032), 0.0, 0.9),
}
ALIAS = {
    "paint": "M_Boat_Olive",
    "hull": "M_Boat_Hull",
    "metal": "M_Boat_Metal",
    "glass": "M_Boat_Glass",
    "mark": "M_Boat_Mark",
    "rubber": "M_Boat_Rubber",
}

# --- Dimensions (m) ---
DECK_Z = 1.18
KEEL_Z = -0.58
BEAM = 1.48          # half-beam at deck
BOW_X = 5.15
STERN_X = -5.35
CABIN_X0, CABIN_X1 = 0.95, -1.35
CABIN_HW = 1.05
CABIN_ROOF = 2.55
TURRET_X = 3.35       # pedestal centre on deck
TURRET_Y = 0.0

LOD_VIEW_Y = (0.0, 14.0, 28.0)


def T(x, y=0.0, z=0.0):
    if isinstance(x, (tuple, list, Vector)):
        return Matrix.Translation(Vector(x))
    return Matrix.Translation(Vector((x, y, z)))


def rot_to(axis):
    return Vector((0, 0, 1)).rotation_difference(Vector(axis).normalized()).to_matrix().to_4x4()


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
        ret = bmesh.ops.create_cone(
            self.bm, cap_ends=True, cap_tris=False, segments=segs,
            radius1=r, radius2=r if r2 is None else r2, depth=d, matrix=Mx,
        )
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

    def lathe(self, prof, segs, M, mat="paint"):
        angles = [2 * pi * j / segs for j in range(segs)]
        rings = []
        for p in prof:
            r, z = p[0], p[1]
            if r < 1e-6:
                rings.append([self.bm.verts.new(M @ Vector((0, 0, z)))])
            else:
                rings.append([
                    self.bm.verts.new(M @ Vector((r * cos(a), r * sin(a), z)))
                    for a in angles
                ])
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

    def finish(self, name, loc=(0, 0, 0), bevel=None, smooth_angle=35, parent=None):
        bm = self.bm
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        if bevel:
            bw = bm.edges.layers.float.get("bevel_weight_edge") or bm.edges.layers.float.new(
                "bevel_weight_edge"
            )
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
        if parent is not None:
            ob.parent = parent
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


def clear_boat():
    col = get_collection()
    for ob in list(col.all_objects):
        data = ob.data
        bpy.data.objects.remove(ob, do_unlink=True)
        if data is not None and getattr(data, "users", 1) == 0 and isinstance(data, bpy.types.Mesh):
            bpy.data.meshes.remove(data)
    # Orphan empties / lights in the scene named for this asset
    for ob in list(bpy.data.objects):
        if ob.name.startswith(NAME) or ob.name.startswith(TURRET):
            data = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            if data is not None and getattr(data, "users", 1) == 0 and hasattr(data, "users"):
                try:
                    if isinstance(data, bpy.types.Mesh):
                        bpy.data.meshes.remove(data)
                    elif isinstance(data, bpy.types.Light):
                        bpy.data.lights.remove(data)
                except Exception:
                    pass


# --------------------------------------------------------------------------- digits "658"
_DIGIT = {
    # strokes as (cx, cz, sx, sz) in unit square centred, height 1
    "6": [
        (-0.28, 0.00, 0.14, 0.90), (0.00, 0.38, 0.56, 0.14), (0.00, -0.38, 0.56, 0.14),
        (0.28, -0.19, 0.14, 0.40), (0.00, 0.00, 0.56, 0.12),
    ],
    "5": [
        (0.00, 0.38, 0.56, 0.14), (-0.28, 0.19, 0.14, 0.40), (0.00, 0.00, 0.56, 0.12),
        (0.28, -0.19, 0.14, 0.40), (0.00, -0.38, 0.56, 0.14),
    ],
    "8": [
        (0.00, 0.38, 0.56, 0.14), (0.00, 0.00, 0.56, 0.12), (0.00, -0.38, 0.56, 0.14),
        (-0.28, 0.19, 0.14, 0.40), (0.28, 0.19, 0.14, 0.40),
        (-0.28, -0.19, 0.14, 0.40), (0.28, -0.19, 0.14, 0.40),
    ],
}


def add_number(b, text, origin, normal, h=0.28, thick=0.018, spacing=0.72):
    """Block numerals on a face. normal is roughly +X or -Y etc."""
    n = Vector(normal).normalized()
    # Build tangent (along text) and up
    up = Vector((0, 0, 1))
    tan = up.cross(n).normalized()
    if tan.length < 0.5:
        tan = Vector((0, 1, 0)).cross(n).normalized()
    # Flip so +X faces read L→R when viewed from bow
    if n.x > 0.5:
        tan = -tan
    o = Vector(origin)
    with b.plain():
        for i, ch in enumerate(text):
            strokes = _DIGIT.get(ch)
            if not strokes:
                continue
            base = o + tan * ((i - (len(text) - 1) * 0.5) * spacing * h)
            for cx, cz, sx, sz in strokes:
                c = base + tan * (cx * h) + up * (cz * h) + n * (thick * 0.5)
                # Local axes: depth along n, width along tan, height along up
                Rm = Matrix((
                    (n.x, tan.x, up.x, 0),
                    (n.y, tan.y, up.y, 0),
                    (n.z, tan.z, up.z, 0),
                    (0, 0, 0, 1),
                ))
                b.cube(T(c) @ Rm @ Matrix.Diagonal((thick, sx * h, sz * h, 1.0)), "mark")


# --------------------------------------------------------------------------- hull / cabin / deck
def _beam_at(x):
    """Half-beam at deck vs longitudinal station (pointed bow, slight stern taper)."""
    if x >= BOW_X:
        return 0.04
    if x >= 3.8:
        t = (BOW_X - x) / (BOW_X - 3.8)
        return 0.04 + (1.15 - 0.04) * (t * t)
    if x >= 2.0:
        t = (3.8 - x) / (3.8 - 2.0)
        return 1.15 + (BEAM - 1.15) * t
    if x >= -3.5:
        return BEAM
    t = (-3.5 - x) / (-3.5 - STERN_X)
    return BEAM - 0.18 * max(0.0, min(1.0, t))


def _chine_z(x):
    if x >= 4.5:
        return 0.45
    if x >= 3.0:
        return 0.45 - 0.55 * (4.5 - x) / 1.5
    if x >= -4.0:
        return -0.22
    return -0.22 + 0.12 * min(1.0, (-4.0 - x) / (-4.0 - STERN_X))


def add_hull(b, detail):
    """Planing hull from station prisms: olive topsides, black bottom, pointed bow."""
    n_sta = {"high": 22, "med": 12, "low": 7}[detail]
    xs = [STERN_X + (BOW_X - STERN_X) * i / (n_sta - 1) for i in range(n_sta)]

    def bottom_prof(x):
        bd = max(0.05, _beam_at(x))
        zc = _chine_z(x)
        bc = max(0.04, bd * 0.88)
        z_top = max(zc, 0.06)
        return [
            (0.0, KEEL_Z),
            (-bc * 0.22, KEEL_Z + 0.06),
            (-bc, zc),
            (-bc * 0.98, z_top),
            (bc * 0.98, z_top),
            (bc, zc),
            (bc * 0.22, KEEL_Z + 0.06),
        ]

    def top_prof(x):
        bd = max(0.05, _beam_at(x))
        zc = _chine_z(x)
        bc = max(0.04, bd * 0.90)
        z0 = max(zc, 0.0)
        return [
            (-bc, z0),
            (-bd, DECK_Z),
            (-0.02, DECK_Z),
            (0.02, DECK_Z),
            (bd, DECK_Z),
            (bc, z0),
        ]

    def avg(pa, pb):
        return [((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5) for a, b in zip(pa, pb)]

    for i in range(n_sta - 1):
        x0, x1 = xs[i], xs[i + 1]
        b.prism_yz(avg(bottom_prof(x0), bottom_prof(x1)), x0, x1, "hull")
        b.prism_yz(avg(top_prof(x0), top_prof(x1)), x0, x1, "paint")

    # Deck plate — panelled
    n_deck = {"high": 14, "med": 7, "low": 3}[detail]
    for i in range(n_deck):
        t0, t1 = i / n_deck, (i + 1) / n_deck
        x0 = STERN_X + 0.08 + (BOW_X - STERN_X - 0.25) * t0
        x1 = STERN_X + 0.08 + (BOW_X - STERN_X - 0.25) * t1
        bd = _beam_at(0.5 * (x0 + x1)) - 0.04
        b.box((0.5 * (x0 + x1), 0, DECK_Z + 0.02), (max(0.05, x1 - x0 - 0.01), bd * 2, 0.025), "paint")
        if detail == "high":
            b.box((x1, 0, DECK_Z + 0.035), (0.015, bd * 2 - 0.1, 0.01), "metal")
            # Centreline walkway strip
            b.box((0.5 * (x0 + x1), 0, DECK_Z + 0.028), (x1 - x0 - 0.02, 0.35, 0.012), "metal")

    # Transom
    bd_s = _beam_at(STERN_X)
    b.prism_yz(
        [(-bd_s, KEEL_Z), (-bd_s, DECK_Z), (bd_s, DECK_Z), (bd_s, KEEL_Z)],
        STERN_X - 0.06, STERN_X, "paint",
    )
    b.box((STERN_X - 0.03, 0, -0.15), (0.05, bd_s * 1.7, 0.50), "hull")

    # Stem
    tip_segs = {"high": 16, "med": 10, "low": 6}[detail]
    b.cyl((BOW_X - 0.12, 0, 0.70), (1, 0, 0), 0.10, 0.28, "paint", segs=tip_segs, r2=0.015)
    b.cyl((BOW_X - 0.18, 0, 0.15), (1, 0, 0), 0.12, 0.32, "hull", segs=tip_segs, r2=0.02)

    # Rub rail + gunwale following beam
    for s in (-1, 1):
        for i in range(n_sta - 1):
            x0, x1 = xs[i], xs[i + 1]
            xm = 0.5 * (x0 + x1)
            y = s * _beam_at(xm)
            b.box((xm, y * 0.99, 0.04), (x1 - x0, 0.04, 0.07), "hull")
            b.box((xm, y, DECK_Z + 0.04), (x1 - x0, 0.05, 0.07), "paint")

    # Deck hatch
    hsegs = {"high": 24, "med": 12, "low": 8}[detail]
    b.cyl((2.10, 0, DECK_Z + 0.025), (0, 0, 1), 0.34, 0.045, "metal", segs=hsegs)
    b.cyl((2.10, 0, DECK_Z + 0.05), (0, 0, 1), 0.27, 0.02, "paint", segs=hsegs)
    if detail == "high":
        b.box((2.10, 0.12, DECK_Z + 0.06), (0.08, 0.04, 0.03), "metal")
        # Scuppers / drain holes along gunwale
        for x in (4.0, 3.0, 1.6, -1.8, -3.2, -4.5):
            for s in (-1, 1):
                b.cyl((x, s * (_beam_at(x) - 0.08), DECK_Z - 0.08), (0, s, 0), 0.03, 0.08, "hull", segs=8)


def add_cabin(b, detail):
    """Forward-leaning bridge with dual windshields, spotlight, side ladders."""
    segs = {"high": 12, "med": 8, "low": 6}[detail]
    x0, x1 = CABIN_X0, CABIN_X1
    hw = CABIN_HW
    # Main cabin body — raked front
    rake = 0.35
    # Floor plinth
    b.box((0.5 * (x0 + x1), 0, DECK_Z + 0.08), (x0 - x1, hw * 2, 0.16), "paint")
    # Walls: approximate with boxes + raked front slab
    b.box((0.5 * (x0 + x1) - 0.1, 0, 0.5 * (DECK_Z + CABIN_ROOF)),
          (x0 - x1 - 0.2, hw * 2 - 0.08, CABIN_ROOF - DECK_Z - 0.05), "paint")
    # Raked front face
    front_c = (x0 + rake * 0.15, 0, 0.5 * (DECK_Z + 0.25 + CABIN_ROOF - 0.1))
    b.box(front_c, (0.12, hw * 2 - 0.12, CABIN_ROOF - DECK_Z - 0.35),
          "paint", R=Euler((0, radians(-18), 0)))
    # Roof
    b.box((0.5 * (x0 + x1) - 0.05, 0, CABIN_ROOF), (x0 - x1 - 0.15, hw * 2 + 0.06, 0.08), "paint")
    # Windshields
    for sy in (-0.38, 0.38):
        b.box((x0 + 0.18, sy, DECK_Z + 0.95), (0.04, 0.55, 0.48), "glass",
              R=Euler((0, radians(-18), 0)))
        if detail == "high":
            # Wipers
            b.box((x0 + 0.22, sy - 0.05, DECK_Z + 0.72), (0.02, 0.02, 0.42), "metal",
                  R=Euler((0, radians(-18), radians(8))))
    # Side windows
    if detail != "low":
        for s in (-1, 1):
            b.box((0.1, s * (hw - 0.02), DECK_Z + 1.05), (0.55, 0.04, 0.38), "glass")
            b.box((-0.55, s * (hw - 0.02), DECK_Z + 1.05), (0.45, 0.04, 0.32), "glass")
    # Spotlight on roof
    b.cyl((0.55, 0, CABIN_ROOF + 0.12), (0, 0, 1), 0.10, 0.10, "metal", segs=segs)
    b.cyl((0.55, 0, CABIN_ROOF + 0.22), (1, 0, 0.15), 0.12, 0.18, "metal", segs=segs)
    b.cyl((0.68, 0, CABIN_ROOF + 0.24), (1, 0, 0.15), 0.10, 0.06, "mark", segs=segs)
    # Side handrails / ladder rungs
    if detail != "low":
        for s in (-1, 1):
            for z in (DECK_Z + 0.35, DECK_Z + 0.70, DECK_Z + 1.05):
                b.box((x0 - 0.05, s * (hw + 0.05), z), (0.55, 0.03, 0.03), "metal")
            b.cyl((x0 - 0.30, s * (hw + 0.08), DECK_Z + 0.70), (0, 0, 1), 0.02, 1.1, "metal", segs=6)
    # Cabin number on front face
    if detail == "high":
        add_number(b, "658", (x0 + 0.28, 0, DECK_Z + 0.55), (1, 0, -0.32), h=0.22, thick=0.02)
    elif detail == "med":
        add_number(b, "658", (x0 + 0.28, 0, DECK_Z + 0.55), (1, 0, -0.32), h=0.22, thick=0.02)


def add_mast(b, detail):
    """Lattice tripod mast + radome + whip antennas behind cabin."""
    segs = {"high": 12, "med": 8, "low": 6}[detail]
    mx, my = -0.55, 0.0
    base_z = CABIN_ROOF
    top_z = base_z + 1.85
    # Tripod legs
    spread = 0.55 if detail != "low" else 0.35
    legs = [
        (mx + 0.25, my + spread * 0.6),
        (mx + 0.25, my - spread * 0.6),
        (mx - 0.35, my),
    ]
    for lx, ly in legs:
        # Leg from roof outboard up to apex
        dx, dy = mx - lx, my - ly
        length = math.sqrt(dx * dx + dy * dy + (top_z - 0.4 - base_z) ** 2)
        mid = ((lx + mx) * 0.5, (ly + my) * 0.5, 0.5 * (base_z + top_z - 0.4))
        axis = (mx - lx, my - ly, top_z - 0.4 - base_z)
        b.cyl(mid, axis, 0.035 if detail == "high" else 0.045, length, "metal",
              segs=6 if detail != "high" else 8)
        b.cyl((lx, ly, base_z + 0.04), (0, 0, 1), 0.06, 0.08, "metal", segs=segs)
    # Cross braces
    if detail == "high":
        for t in (0.25, 0.45, 0.65, 0.82):
            z = base_z + (top_z - base_z) * t
            pts = [(lx + (mx - lx) * t, ly + (my - ly) * t) for lx, ly in legs]
            for i in range(3):
                a, c = pts[i], pts[(i + 1) % 3]
                mid = (0.5 * (a[0] + c[0]), 0.5 * (a[1] + c[1]), z)
                axis = (c[0] - a[0], c[1] - a[1], 0)
                b.cyl(mid, axis, 0.016, math.hypot(c[0] - a[0], c[1] - a[1]), "metal", segs=6)
    # Platform + radome
    b.cyl((mx, my, top_z - 0.35), (0, 0, 1), 0.28, 0.06, "metal", segs=segs)
    b.cyl((mx, my, top_z - 0.15), (0, 0, 1), 0.12, 0.25, "metal", segs=segs)
    # Radome sphere approx
    b.lathe(
        [(0, top_z - 0.05), (0.32, top_z - 0.05), (0.38, top_z + 0.15),
         (0.32, top_z + 0.38), (0.0, top_z + 0.42)],
        segs, Matrix.Identity(4), "paint",
    )
    # Whip antennas
    ants = {"high": 4, "med": 3, "low": 2}[detail]
    for i in range(ants):
        a = 2 * pi * i / ants + 0.4
        ax = mx + 0.22 * cos(a)
        ay = my + 0.22 * sin(a)
        h = 1.4 + 0.35 * (i % 3)
        b.cyl((ax, ay, top_z + 0.05), (0, 0, 1), 0.012, h, "metal", segs=6, r2=0.006)


def add_railings(b, detail):
    """Perimeter rail: stanchions + top/mid rail along gunwales (skip cabin sides)."""
    if detail == "low":
        for s in (-1, 1):
            b.box((2.5, s * (BEAM - 0.05), DECK_Z + 0.45), (4.5, 0.04, 0.04), "metal")
            b.box((-3.2, s * (BEAM - 0.05), DECK_Z + 0.45), (3.5, 0.04, 0.04), "metal")
        return
    spacing = 0.38 if detail == "high" else 0.70
    rail_z = DECK_Z + 0.55
    mid_z = DECK_Z + 0.32
    post_segs = 8 if detail == "high" else 6

    def rail_posts(x_start, x_end):
        xs = []
        x = x_start
        step = -spacing if x_end < x_start else spacing
        while (x > x_end) if step < 0 else (x < x_end):
            xs.append(x)
            x += step
        return xs

    xs_fwd = rail_posts(BOW_X - 0.55, CABIN_X0 + 0.2)
    xs_aft = rail_posts(CABIN_X1 - 0.15, STERN_X + 0.35)

    for s in (-1, 1):
        for px in xs_fwd + xs_aft:
            y = s * (_beam_at(px) - 0.06)
            b.cyl((px, y, DECK_Z + 0.28), (0, 0, 1), 0.02, 0.55, "metal", segs=post_segs)
            if detail == "high":
                b.cyl((px, y, DECK_Z + 0.04), (0, 0, 1), 0.035, 0.05, "metal", segs=post_segs)
        for group in (xs_fwd, xs_aft):
            if len(group) < 2:
                continue
            for i in range(len(group) - 1):
                x0, x1 = group[i], group[i + 1]
                ym = s * (_beam_at(0.5 * (x0 + x1)) - 0.06)
                b.cyl((0.5 * (x0 + x1), ym, rail_z), (1, 0, 0), 0.016, abs(x0 - x1), "metal", segs=6)
                if detail == "high":
                    b.cyl((0.5 * (x0 + x1), ym, mid_z), (1, 0, 0), 0.012, abs(x0 - x1), "metal", segs=6)
        # Stern posts + crossbar
        y = s * (_beam_at(STERN_X + 0.3) - 0.06)
        b.cyl((STERN_X + 0.3, y, DECK_Z + 0.28), (0, 0, 1), 0.02, 0.55, "metal", segs=post_segs)
    b.cyl((STERN_X + 0.3, 0, rail_z), (0, 1, 0), 0.016, BEAM * 2 - 0.2, "metal", segs=6)
    if detail == "high":
        b.cyl((STERN_X + 0.3, 0, mid_z), (0, 1, 0), 0.012, BEAM * 2 - 0.2, "metal", segs=6)
        # Bow pulpit
        for i in range(7):
            t = i / 6
            a = radians(-70 + 140 * t)
            px = BOW_X - 0.35 - 0.70 * abs(sin(a))
            py = 0.95 * sin(a)
            b.cyl((px, py, DECK_Z + 0.28), (0, 0, 1), 0.02, 0.55, "metal", segs=post_segs)
        b.cyl((BOW_X - 0.75, 0, rail_z), (0, 1, 0), 0.016, 1.6, "metal", segs=6)


def add_deck_gear(b, detail):
    """Cylindrical tanks, crates, bollards. No rear turret tub."""
    segs = {"high": 16, "med": 10, "low": 8}[detail]
    # Side tanks — four total (two per side), mid + aft
    tank_xs = (0.15, -2.55)
    for tx in tank_xs:
        for s in (-1, 1):
            y = s * 0.95
            b.cyl((tx, y, DECK_Z + 0.28), (1, 0, 0), 0.28, 1.35, "paint", segs=segs)
            # End caps / straps
            if detail != "low":
                b.cyl((tx + 0.68, y, DECK_Z + 0.28), (1, 0, 0), 0.29, 0.04, "metal", segs=segs)
                b.cyl((tx - 0.68, y, DECK_Z + 0.28), (1, 0, 0), 0.29, 0.04, "metal", segs=segs)
                b.box((tx, y, DECK_Z + 0.02), (1.2, 0.35, 0.06), "metal")
                for ox in (-0.35, 0.35):
                    b.box((tx + ox, y, DECK_Z + 0.55), (0.04, 0.04, 0.12), "metal")

    # Storage crates
    crates = [
        (1.55, 0.85, 0.35, 0.45, 0.28),
        (1.55, -0.85, 0.40, 0.38, 0.30),
        (-1.85, 0.55, 0.50, 0.42, 0.32),
        (-3.60, -0.70, 0.45, 0.38, 0.28),
        (-4.20, 0.60, 0.55, 0.40, 0.30),
        (-0.2, 0.0, 0.48, 0.55, 0.25),  # centreline aft of cabin
    ]
    for cx, cy, sx, sy, sz in crates:
        b.box((cx, cy, DECK_Z + sz * 0.5 + 0.02), (sx, sy, sz), "paint")
        if detail == "high":
            b.box((cx, cy, DECK_Z + sz + 0.03), (sx * 0.92, sy * 0.92, 0.03), "metal")
            b.box((cx, cy + sy * 0.35, DECK_Z + sz * 0.55), (0.08, 0.04, 0.06), "metal")

    # Bollards / cleats along edges
    bollard_x = [4.2, 2.6, -2.0, -3.8, -4.9]
    for bx in bollard_x:
        for s in (-1, 1):
            by = s * (BEAM - 0.22)
            b.cyl((bx, by, DECK_Z + 0.08), (0, 0, 1), 0.06, 0.14, "metal", segs=segs)
            b.cyl((bx, by, DECK_Z + 0.18), (0, 1, 0), 0.035, 0.16, "metal", segs=8)

    # Bow number on hull side
    if detail != "low":
        add_number(b, "658", (4.35, BEAM - 0.02, 0.72), (0, 1, 0), h=0.32, thick=0.02)
        add_number(b, "658", (4.35, -(BEAM - 0.02), 0.72), (0, -1, 0), h=0.32, thick=0.02)

    # Aft open deck pad where rear tub would have been — flat plate + a couple crates already cover it
    if detail == "high":
        b.cyl((-4.55, 0, DECK_Z + 0.02), (0, 0, 1), 0.55, 0.03, "metal", segs=segs)
        # Fill plate instead of gun tub
        b.box((-4.55, 0, DECK_Z + 0.05), (1.0, 1.0, 0.04), "paint")


def add_greebles(b, detail):
    """Extra mid-poly detail for the ~50k LOD0 budget (rivets, vents, cleats, trim)."""
    if detail != "high":
        return
    # Hull rivet rows along topsides
    for s in (-1, 1):
        for x in [STERN_X + 0.4 + i * 0.35 for i in range(28)]:
            y = s * (_beam_at(x) - 0.03)
            for z in (0.35, 0.70, 1.00):
                b.cyl((x, y, z), (0, s, 0), 0.012, 0.02, "metal", segs=6)
    # Cabin roof vents / antenna bases
    for y in (-0.45, 0.45):
        b.cyl((0.1, y, CABIN_ROOF + 0.06), (0, 0, 1), 0.07, 0.08, "metal", segs=10)
        b.box((0.1, y, CABIN_ROOF + 0.12), (0.12, 0.12, 0.04), "metal")
    # Deck drain grates
    for x, y in ((3.0, 0.6), (3.0, -0.6), (-3.8, 0.5), (-3.8, -0.5), (-2.2, 0)):
        b.box((x, y, DECK_Z + 0.03), (0.35, 0.22, 0.015), "metal")
        for i in range(4):
            b.box((x - 0.12 + i * 0.08, y, DECK_Z + 0.04), (0.02, 0.18, 0.01), "hull")
    # Life-ring brackets on cabin sides
    for s in (-1, 1):
        b.cyl((-0.2, s * (CABIN_HW + 0.08), DECK_Z + 1.15), (0, s, 0), 0.16, 0.04, "mark", segs=14)
        b.cyl((-0.2, s * (CABIN_HW + 0.08), DECK_Z + 1.15), (0, s, 0), 0.10, 0.05, "paint", segs=12)
    # Propeller / rudder hint at stern (placeholder silhouette)
    b.box((STERN_X - 0.15, 0, KEEL_Z + 0.35), (0.08, 0.04, 0.55), "metal")
    b.cyl((STERN_X - 0.35, 0, KEEL_Z + 0.25), (1, 0, 0), 0.04, 0.35, "metal", segs=10)
    for blade in range(3):
        a = 2 * pi * blade / 3
        b.box(
            (STERN_X - 0.55, 0.18 * cos(a), KEEL_Z + 0.25 + 0.18 * sin(a)),
            (0.04, 0.28, 0.08), "metal",
            R=Euler((a, 0, 0)),
        )
    # Extra crates / jerry cans
    for i, (cx, cy) in enumerate(((4.0, 0.7), (4.0, -0.7), (-4.8, 0.0), (1.2, 0.0))):
        b.box((cx, cy, DECK_Z + 0.18), (0.22, 0.28, 0.32), "paint")
        b.box((cx, cy, DECK_Z + 0.36), (0.08, 0.04, 0.04), "metal")


def add_body(b, detail):
    add_hull(b, detail)
    add_cabin(b, detail)
    add_mast(b, detail)
    add_railings(b, detail)
    add_deck_gear(b, detail)
    add_greebles(b, detail)


# --------------------------------------------------------------------------- front turret (separate object)
def add_front_turret(b, detail):
    """M2-style HMG on pedestal. Geometry in local space: origin = pedestal base (deck).
    Gun points +X. Rotate whole object about local Z for traverse."""
    segs = {"high": 16, "med": 10, "low": 8}[detail]
    # Deck ring / base plate (stays with turret so it turns)
    b.cyl((0, 0, 0.02), (0, 0, 1), 0.38, 0.04, "metal", segs=segs)
    b.cyl((0, 0, 0.05), (0, 0, 1), 0.28, 0.04, "paint", segs=segs)
    # Pedestal column
    b.cyl((0, 0, 0.45), (0, 0, 1), 0.09, 0.80, "metal", segs=segs)
    b.cyl((0, 0, 0.12), (0, 0, 1), 0.14, 0.12, "metal", segs=segs)
    b.cyl((0, 0, 0.82), (0, 0, 1), 0.12, 0.08, "metal", segs=segs)
    # Trunnion cradle
    for s in (-1, 1):
        b.box((0.02, s * 0.10, 0.95), (0.22, 0.04, 0.16), "metal")
    b.cyl((0.02, 0, 0.95), (0, 1, 0), 0.03, 0.22, "metal", segs=8)
    # Receiver
    z = 0.98
    b.box((0.05, 0, z), (0.42, 0.14, 0.14), "metal")
    b.box((0.05, 0, z + 0.08), (0.38, 0.12, 0.03), "metal")
    # Spade grips
    for s in (-1, 1):
        b.cyl((-0.22, s * 0.07, z - 0.02), (1, 0, 0), 0.018, 0.12, "metal", segs=8)
        b.cyl((-0.30, s * 0.07, z - 0.02), (1, 0, 0), 0.025, 0.04, "metal", segs=8)
    # Charging handle / top
    b.box((0.12, 0.08, z + 0.02), (0.08, 0.04, 0.04), "metal")
    # Barrel shroud with cooling holes (high detail)
    b.cyl((0.55, 0, z), (1, 0, 0), 0.038, 0.55, "metal", segs=segs)
    if detail == "high":
        for i in range(8):
            bx = 0.35 + i * 0.06
            for a in (0, pi * 0.5, pi, pi * 1.5):
                oy, oz = 0.042 * cos(a), 0.042 * sin(a)
                b.cyl((bx, oy, z + oz), (1, 0, 0), 0.008, 0.03, "metal", segs=6)
    elif detail == "med":
        for bx in (0.40, 0.52, 0.64):
            b.cyl((bx, 0, z), (1, 0, 0), 0.042, 0.03, "metal", segs=8)
    # Outer barrel
    b.cyl((1.05, 0, z), (1, 0, 0), 0.022, 0.55, "metal", segs=max(8, segs - 4), r2=0.018)
    b.cyl((1.35, 0, z), (1, 0, 0), 0.028, 0.08, "metal", segs=8)
    # Flash hider
    b.cyl((1.42, 0, z), (1, 0, 0), 0.032, 0.06, "metal", segs=8, r2=0.022)
    # Front sight
    b.box((1.20, 0, z + 0.04), (0.02, 0.015, 0.05), "metal")
    # Ammo box on left (gunner's left = +Y in our +X-forward frame… use −Y for typical right-feed look)
    ac = Vector((0.22, -0.18, z - 0.10))
    b.box(ac, (0.34, 0.14, 0.24), "paint")
    b.box(ac + Vector((0, 0, 0.13)), (0.35, 0.15, 0.02), "metal")
    if detail != "low":
        for a in (0.5, -0.5):
            b.box(ac + Vector((0, -0.07, 0.02)), (0.32, 0.01, 0.02), "metal",
                  R=Euler((0, a, 0)))
        b.box(ac + Vector((-0.05, 0.09, 0.05)), (0.06, 0.04, 0.03), "metal")
    # Feed chute
    b.box((0.10, -0.10, z - 0.02), (0.12, 0.08, 0.05), "metal")
    # Pintle / elevation stop
    b.box((0.0, 0, 0.88), (0.16, 0.16, 0.04), "metal")


def count_tris(ob):
    deps = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(deps)
    me = ev.to_mesh()
    n = sum(len(p.vertices) - 2 for p in me.polygons)
    ev.to_mesh_clear()
    return n


def apply_bevel(ob):
    if not ob.modifiers:
        return count_tris(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    new = bpy.data.meshes.new_from_object(
        ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg,
    )
    old = ob.data
    name = old.name
    ob.modifiers.clear()
    ob.data = new
    if old.users == 0:
        bpy.data.meshes.remove(old)
    new.name = name
    return sum(len(p.vertices) - 2 for p in new.polygons)


def cleanup_zfight(ob, dist=0.012):
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


def setup_view(sc):
    light = bpy.data.objects.get(NAME + "_Sun")
    if light is None:
        data = bpy.data.lights.new(NAME + "_Sun", "SUN")
        data.energy = 4.0
        data.angle = 0.15
        light = bpy.data.objects.new(NAME + "_Sun", data)
        sc.collection.objects.link(light)
    light.rotation_euler = (radians(50), radians(-15), radians(35))
    ground = bpy.data.objects.get(NAME + "_Ground")
    if ground is None:
        me = bpy.data.meshes.new(NAME + "_Ground_geo")
        bm = bmesh.new()
        bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=10.0)
        bm.to_mesh(me)
        bm.free()
        ground = bpy.data.objects.new(NAME + "_Ground", me)
        sc.collection.objects.link(ground)
        mat = bpy.data.materials.get(NAME + "_GroundMat") or bpy.data.materials.new(NAME + "_GroundMat")
        mat.use_nodes = True
        bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Base Color"].default_value = (0.42, 0.44, 0.46, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.85
        me.materials.append(mat)
    ground.location = (0, 0, KEEL_Z - 0.02)


def build_lod(level):
    detail = ("high", "med", "low")[level]
    y_off = LOD_VIEW_Y[level]

    # Hull / body
    b = Builder()
    add_body(b, detail)
    body_name = NAME if level == 0 else f"{NAME}_LOD{level}"
    bevel = (0.01, 2) if level == 0 else None
    body = b.finish(body_name, loc=(0.0, y_off, 0.0), bevel=bevel)
    if level:
        body.hide_set(True)
        body.hide_render = True

    # Front turret — separate mesh, origin at pedestal base
    t = Builder()
    add_front_turret(t, detail)
    tur_name = TURRET if level == 0 else f"{TURRET}_LOD{level}"
    tur_bevel = (0.004, 1) if level == 0 else None
    tur = t.finish(tur_name, loc=(TURRET_X, y_off + TURRET_Y, DECK_Z), bevel=tur_bevel)
    tur["pivot_role"] = "traverse"
    tur["rotate_axis"] = "Z"
    tur["muzzle_local"] = [1.48, 0.0, 0.98]
    if level:
        tur.hide_set(True)
        tur.hide_render = True

    return body, tur


def export_glb(path):
    names = (
        NAME, f"{NAME}_LOD1", f"{NAME}_LOD2",
        TURRET, f"{TURRET}_LOD1", f"{TURRET}_LOD2",
    )
    # Park everything at export origin (body at 0, turret at mount)
    saved = {}
    for name in names:
        o = bpy.data.objects[name]
        saved[name] = o.location.copy()
        if name.startswith(TURRET):
            o.location = (TURRET_X, TURRET_Y, DECK_Z)
        else:
            o.location = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()

    tmp = bpy.data.scenes.new("_BoatExport")
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
        for name, loc in saved.items():
            bpy.data.objects[name].location = loc
        for lvl in (1, 2):
            for base in (NAME, TURRET):
                o = bpy.data.objects.get(f"{base}_LOD{lvl}")
                if o:
                    o.hide_set(True)


def build(export=False):
    sc = ensure_scene()
    ensure_materials()
    clear_boat()
    setup_view(sc)
    total = 0
    for lvl in range(3):
        body, tur = build_lod(lvl)
        for ob in (body, tur):
            tris = apply_bevel(ob)
            cleanup_zfight(ob)
            tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
            print(f"{ob.name}: {tris} tris")
            if lvl == 0:
                total += tris
    print(f"LOD0 total tris={total}  (budget ~50000)")
    if export:
        export_glb(GAME_MODEL)
    return total


if __name__ == "__main__":
    build(export=True)
