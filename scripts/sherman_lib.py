"""Shared helpers for building the Sherman in Blender (run inside Blender)."""
import bpy
import bmesh
from contextlib import contextmanager
from math import radians, sin, cos, pi, atan2, sqrt
from mathutils import Vector, Matrix, Euler

COLLECTION = "Sherman"

# Rotates local Z onto world Y (local XY profile -> world XZ plane, with world z = -local y).
AX_Y = Matrix.Rotation(radians(-90), 4, 'X')
# Rotates local Z onto world X.
AX_X = Matrix.Rotation(radians(90), 4, 'Y')

MAT_DEFS = {
    # name: (linear rgb, metallic, roughness, emission strength)
    "M_Paint_Olive": ((0.20, 0.19, 0.075), 0.0, 0.6, 0.0),
    "M_Metal_Dark": ((0.035, 0.035, 0.035), 0.8, 0.45, 0.0),
    "M_Track": ((0.07, 0.055, 0.045), 0.6, 0.65, 0.0),
    "M_Rubber": ((0.02, 0.02, 0.022), 0.0, 0.85, 0.0),
    "M_Wood": ((0.30, 0.13, 0.05), 0.0, 0.7, 0.0),
    "M_Glass_Headlight": ((0.9, 0.88, 0.8), 0.0, 0.05, 0.0),
    "M_Glass_Taillight": ((0.6, 0.02, 0.02), 0.0, 0.1, 0.0),
}

ALIAS = {
    "paint": "M_Paint_Olive",
    "metal": "M_Metal_Dark",
    "track": "M_Track",
    "rubber": "M_Rubber",
    "wood": "M_Wood",
    "head": "M_Glass_Headlight",
    "tail": "M_Glass_Taillight",
}


def get_collection():
    col = bpy.data.collections.get(COLLECTION)
    if col is None:
        col = bpy.data.collections.new(COLLECTION)
        bpy.context.scene.collection.children.link(col)
    return col


def ensure_materials():
    for name, (rgb, metal, rough, emit) in MAT_DEFS.items():
        m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        try:
            m.use_nodes = True
        except Exception:
            pass
        bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
        bsdf.inputs["Metallic"].default_value = metal
        bsdf.inputs["Roughness"].default_value = rough
        # Emission tint matches base (taillight red, headlight warm) — never leave default white.
        em = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
        if em is not None:
            em.default_value = (*rgb, 1.0)
        estr = bsdf.inputs.get("Emission Strength")
        if estr is not None:
            estr.default_value = emit
        m.diffuse_color = (*rgb, 1.0)


def clear_objects(prefixes=None):
    col = get_collection()
    for ob in list(col.all_objects):
        if prefixes is None or any(ob.name.startswith(p) for p in prefixes):
            data = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            if data is not None and data.users == 0 and isinstance(data, bpy.types.Mesh):
                bpy.data.meshes.remove(data)


def geo_name(name):
    """Mesh data name. three.js names multi-material sub-meshes '<mesh>', '<mesh>_1', ... and binds
    animation tracks by name, so mesh names must never collide with object (node) names."""
    return name + "_geo"


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
        """Geometry created inside this block is excluded from the bevel modifier."""
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
        """Unit cube transformed by a full matrix."""
        ret = bmesh.ops.create_cube(self.bm, size=1.0, matrix=M)
        self._tag(self._faces_of(ret["verts"]), mat)

    def box(self, c, s, mat="paint", R=None):
        Rm = Matrix.Identity(4)
        if R is not None:
            Rm = (R.to_matrix() if isinstance(R, Euler) else R).to_4x4()
        self.cube(T(c) @ Rm @ Matrix.Diagonal((s[0], s[1], s[2], 1.0)), mat)

    def cyl(self, c, axis, r, d, mat="paint", segs=16, r2=None, M=None):
        Mx = T(c) @ rot_to(axis)
        if M is not None:
            Mx = M @ Mx
        ret = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=segs,
                                    radius1=r, radius2=r if r2 is None else r2, depth=d, matrix=Mx)
        old = self.no_bevel
        self.no_bevel = old or segs < 12
        self._tag(self._faces_of(ret["verts"]), mat)
        self.no_bevel = old

    def prism(self, prof, z0, z1, M, mat="paint"):
        """Extrude a 2D polygon (local XY) from z0 to z1 along local Z, transformed by M."""
        bot = [self.bm.verts.new(M @ Vector((x, y, z0))) for x, y in prof]
        top = [self.bm.verts.new(M @ Vector((x, y, z1))) for x, y in prof]
        n = len(prof)
        faces = [self.bm.faces.new(bot), self.bm.faces.new(top[::-1])]
        for i in range(n):
            j = (i + 1) % n
            faces.append(self.bm.faces.new((bot[i], bot[j], top[j], top[i])))
        self._tag(faces, mat)

    def prism_xz(self, prof_xz, y0, y1, mat="paint", M=None):
        """Profile given in world (x, z), extruded along world Y from y0 to y1."""
        prof = [(x, -z) for x, z in prof_xz]
        Mx = AX_Y if M is None else M @ AX_Y
        self.prism(prof, min(y0, y1), max(y0, y1), Mx, mat)

    def lathe(self, prof, segs, M, mat="paint"):
        """Revolve (r, z[, mat]) profile around local Z. Points with r == 0 collapse to the axis."""
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

    def torus(self, R, r, M, mat="metal", maj=16, mnr=6, arc=2 * pi, a0=0.0):
        closed = arc >= 2 * pi - 1e-6
        nm = maj if closed else maj + 1
        rings = []
        for i in range(nm):
            a = a0 + arc * i / maj
            ca, sa = cos(a), sin(a)
            ring = []
            for k in range(mnr):
                b = 2 * pi * k / mnr
                rr = R + r * cos(b)
                ring.append(self.bm.verts.new(M @ Vector((rr * ca, rr * sa, r * sin(b)))))
            rings.append(ring)
        for i in range(nm if closed else nm - 1):
            A, B = rings[i], rings[(i + 1) % nm]
            for k in range(mnr):
                kn = (k + 1) % mnr
                self.bm.faces.new((A[k], A[kn], B[kn], B[k]))
        if not closed:
            self.bm.faces.new(rings[0][::-1])
            self.bm.faces.new(rings[-1])
        with self.plain():
            self._tag(self._faces_of([v for ring in rings for v in ring]), mat)

    def finish(self, name, parent=None, loc=(0, 0, 0), rot=None, bevel=None, smooth_angle=30):
        bm = self.bm
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        if bevel:
            bw = bm.edges.layers.float.get("bevel_weight_edge") or bm.edges.layers.float.new("bevel_weight_edge")
            lim = radians(30)
            for e in bm.edges:
                fs = e.link_faces
                if len(fs) == 2 and not (fs[0][self.flag] or fs[1][self.flag]) and e.calc_face_angle(0) > lim:
                    e[bw] = 1.0
        bm.faces.layers.int.remove(self.flag)
        me = bpy.data.meshes.new(geo_name(name))
        bm.to_mesh(me)
        bm.free()
        for mn in self.mats:
            me.materials.append(bpy.data.materials[mn])
        ob = bpy.data.objects.new(name, me)
        get_collection().objects.link(ob)
        if parent is not None:
            ob.parent = parent
        ob.location = loc
        if rot is not None:
            ob.rotation_euler = rot
        me.shade_smooth()
        me.set_sharp_from_angle(angle=radians(smooth_angle))
        if bevel:
            w, seg = bevel
            mod = ob.modifiers.new("Bevel", 'BEVEL')
            mod.width = w
            mod.segments = seg
            mod.limit_method = 'WEIGHT'
            mod.harden_normals = True
        return ob


def union(builders, mat="paint"):
    """Exact boolean union of several closed Builder solids into one new Builder (single material),
    so overlapping parts leave no coplanar or buried faces behind."""
    scene_col = bpy.context.scene.collection
    base_col = bpy.data.collections.new("_union_base")
    ops_col = bpy.data.collections.new("_union_ops")
    scene_col.children.link(base_col)
    scene_col.children.link(ops_col)
    objs = []
    for i, b in enumerate(builders):
        bmesh.ops.remove_doubles(b.bm, verts=b.bm.verts[:], dist=1e-6)
        bmesh.ops.recalc_face_normals(b.bm, faces=b.bm.faces[:])
        me = bpy.data.meshes.new(f"_union_{i}")
        b.bm.to_mesh(me)
        b.bm.free()
        ob = bpy.data.objects.new(me.name, me)
        (base_col if i == 0 else ops_col).objects.link(ob)
        objs.append(ob)
    mod = objs[0].modifiers.new("Union", 'BOOLEAN')
    mod.operation = 'UNION'
    mod.operand_type = 'COLLECTION'
    mod.collection = ops_col
    mod.solver = 'EXACT'
    dg = bpy.context.evaluated_depsgraph_get()
    merged = bpy.data.meshes.new_from_object(objs[0].evaluated_get(dg), depsgraph=dg)
    for ob in objs:
        me = ob.data
        bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.meshes.remove(me)
    bpy.data.collections.remove(base_col)
    bpy.data.collections.remove(ops_col)

    out = Builder()
    out.bm.from_mesh(merged)
    bpy.data.meshes.remove(merged)
    out.flag = out.bm.faces.layers.int.get("nobev") or out.bm.faces.layers.int.new("nobev")
    out._tag(out.bm.faces, mat)
    return out


def instance(name, data, parent=None, loc=(0, 0, 0), rot=None):
    """New object sharing existing mesh data (exported to glTF as one shared mesh)."""
    ob = bpy.data.objects.new(name, data)
    get_collection().objects.link(ob)
    ob.parent = parent
    ob.location = loc
    if rot is not None:
        ob.rotation_euler = rot
    return ob


def make_empty(name, parent=None, loc=(0, 0, 0)):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = 'PLAIN_AXES'
    ob.empty_display_size = 0.3
    get_collection().objects.link(ob)
    ob.parent = parent
    ob.location = loc
    return ob


def gear_profile(n, r_root, r_tip, root_frac=0.42, tip_frac=0.22):
    pts = []
    step = 2 * pi / n
    flank = (1 - root_frac - tip_frac) / 2
    for i in range(n):
        a = step * i
        for r, f in ((r_root, 0), (r_root, root_frac), (r_tip, root_frac + flank),
                     (r_tip, root_frac + flank + tip_frac)):
            pts.append((r * cos(a + step * f), r * sin(a + step * f)))
    return pts


def convex_hull(points):
    pts = sorted(set(points))

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]  # counter-clockwise


def tri_count(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    total = 0
    per = {}
    for ob in objs:
        if ob.type != 'MESH':
            continue
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        me.calc_loop_triangles()
        n = len(me.loop_triangles)
        ev.to_mesh_clear()
        per[ob.name] = n
        total += n
    return total, per
