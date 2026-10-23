"""Procedural WW2 water tower -> proto/public/models/water_tower.glb. Run inside Blender:

    import sys; sys.path.append('/Users/stellanjohansson/Cursor/Blender-Test01/scripts')
    import build_water_tower, importlib; importlib.reload(build_water_tower)
    build_water_tower.build(export=True)

Built in its own scene ("WaterTower") as a single mesh + single material. Geometry, UVs and the
1024² colour / metal-rough atlas are generated here, so the asset can be rebuilt from scratch.
Units are metres, Z up, origin at ground centre (between the four footings).
"""
import math
import os
import random

import bpy
import bmesh
import numpy as np
from mathutils import Vector

ROOT = "/Users/stellanjohansson/Cursor/Blender-Test01"
GAME_MODEL = os.path.join(ROOT, "proto", "public", "models", "water_tower.glb")
NAME = "WaterTower"
TEX = 1024

# --- Dimensions (m) ---
FOOT_HALF = 2.6      # leg centre offset at ground
TOP_HALF = 1.75      # leg centre offset under the deck
FOOT_H = 0.6         # concrete footing height
DECK_Z = 10.6
DECK_T = 0.18
DECK_R = 2.95
RAIL_R = 2.8
RAIL_H = 1.0
TANK_R = 2.2
TANK_Z0 = DECK_Z + DECK_T
TANK_H = 4.6
TANK_Z1 = TANK_Z0 + TANK_H
ROOF_R = 2.5
ROOF_RISE = 1.5
BAY_Z = [FOOT_H + 0.25, 3.9, 7.2, DECK_Z - 0.1]
LADDER_X = DECK_R + 0.12
LADDER_HW = 0.25

# Atlas regions (u0, v0, u1, v1)
R_TANK = (0.0, 0.5, 1.0, 1.0)
R_ROOF = (0.0, 0.0, 0.5, 0.5)
R_STEEL = (0.5, 0.25, 1.0, 0.5)
R_CONC = (0.5, 0.0, 1.0, 0.25)

CORNERS = [(1, 1), (-1, 1), (-1, -1), (1, -1)]


def _ruv(reg, u, v):
    return (reg[0] + (reg[2] - reg[0]) * u, reg[1] + (reg[3] - reg[1]) * v)


class MeshBuilder:
    def __init__(self, seed=3):
        self.verts, self.faces, self.uvs, self.smooth = [], [], [], []
        self.rng = random.Random(seed)

    def v(self, p):
        self.verts.append(tuple(p))
        return len(self.verts) - 1

    def face(self, ids, uvs, smooth=False):
        self.faces.append(ids)
        self.uvs.append(uvs)
        self.smooth.append(smooth)

    def patch(self, reg, along=1.0):
        """Random sub-rect of a noise region so repeated parts don't look stamped."""
        du = 0.06
        dv = min(0.9, 0.05 + 0.06 * along)
        u0 = self.rng.uniform(0, 1 - du)
        v0 = self.rng.uniform(0, 1 - dv)
        return [_ruv(reg, u0, v0), _ruv(reg, u0 + du, v0),
                _ruv(reg, u0 + du, v0 + dv), _ruv(reg, u0, v0 + dv)]

    def beam(self, a, b, w, h, reg=R_STEEL, hint=None):
        """Box of section w (along side vector) x h from a to b."""
        a, b = Vector(a), Vector(b)
        d = b - a
        length = d.length
        d.normalize()
        if hint is None:
            s = d.cross(Vector((0, 0, 1)))
            if s.length < 1e-4:
                s = Vector((1, 0, 0))
        else:
            hv = Vector(hint)
            s = hv - d * d.dot(hv)
        s.normalize()
        t = s.cross(d).normalized()
        offs = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
        A = [self.v(a + s * (ox * w / 2) + t * (oy * h / 2)) for ox, oy in offs]
        B = [self.v(b + s * (ox * w / 2) + t * (oy * h / 2)) for ox, oy in offs]
        for k in range(4):
            k2 = (k + 1) % 4
            p = self.patch(reg, length)
            self.face([A[k], B[k], B[k2], A[k2]], [p[0], p[3], p[2], p[1]])
        self.face(A, self.patch(reg))
        self.face(B[::-1], self.patch(reg))

    def lathe(self, prof, n, reg, cx=0.0, cy=0.0, smooth=True, cap_top=False, cap_bot=False,
              theta0=0.0, cap_reg=None):
        """prof: [(z, r, v)] bottom->top. Shared verts within the lathe; caps get their own."""
        ang = [theta0 + 2 * math.pi * k / n for k in range(n)]
        rings = [[self.v((cx + r * math.cos(a), cy + r * math.sin(a), z)) for a in ang]
                 for z, r, _ in prof]
        for i in range(len(prof) - 1):
            va, vb = prof[i][2], prof[i + 1][2]
            for k in range(n):
                k2 = (k + 1) % n
                ua, ub = k / n, (k + 1) / n
                self.face([rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]],
                          [_ruv(reg, ua, va), _ruv(reg, ub, va), _ruv(reg, ub, vb), _ruv(reg, ua, vb)],
                          smooth)
        creg = cap_reg or reg

        def cap(z, r, up):
            ids = [self.v((cx + r * math.cos(a), cy + r * math.sin(a), z)) for a in ang]
            uvs = [_ruv(creg, 0.5 + 0.45 * math.cos(a), 0.5 + 0.45 * math.sin(a)) for a in ang]
            if not up:
                ids, uvs = ids[::-1], uvs[::-1]
            self.face(ids, uvs)

        if cap_bot:
            cap(prof[0][0], prof[0][1], False)
        if cap_top:
            cap(prof[-1][0], prof[-1][1], True)

    def block(self, cx, cy, prof, reg=R_CONC):
        """Square loft (prof [(z, half)]) - footings and pads."""
        self.lathe([(z, hlf * math.sqrt(2), i / max(1, len(prof) - 1)) for i, (z, hlf) in enumerate(prof)],
                   4, reg, cx, cy, smooth=False, cap_top=True, cap_bot=True, theta0=math.pi / 4)


def leg_pt(sx, sy, z):
    t = (z - FOOT_H) / (DECK_Z - FOOT_H)
    hlf = FOOT_HALF + (TOP_HALF - FOOT_HALF) * t
    return Vector((sx * hlf, sy * hlf, z))


def frame_half(z):
    return leg_pt(1, 1, z).x


def build_geometry():
    mb = MeshBuilder()

    # Concrete footings + legs
    for sx, sy in CORNERS:
        mb.block(sx * FOOT_HALF, sy * FOOT_HALF,
                 [(0.0, 0.5), (0.32, 0.5), (FOOT_H, 0.3)])
        mb.beam(leg_pt(sx, sy, FOOT_H - 0.05), leg_pt(sx, sy, DECK_Z), 0.24, 0.24, hint=(1, 0, 0))

    # Bracing: horizontal ties + flat X-straps in three bays per side
    for i in range(4):
        c1, c2 = CORNERS[i], CORNERS[(i + 1) % 4]
        n = Vector(((c1[0] + c2[0]) * 0.5, (c1[1] + c2[1]) * 0.5, 0)).normalized()
        for z in BAY_Z[:-1]:
            mb.beam(leg_pt(*c1, z), leg_pt(*c2, z), 0.12, 0.16)
        for b in range(3):
            za, zb = BAY_Z[b], BAY_Z[b + 1]
            mb.beam(leg_pt(*c1, za) + n * 0.03, leg_pt(*c2, zb) + n * 0.03, 0.05, 0.12)
            mb.beam(leg_pt(*c2, za) - n * 0.03, leg_pt(*c1, zb) - n * 0.03, 0.05, 0.12)

    # Deck joists (also tie the leg tops)
    jz = DECK_Z - 0.11
    span = DECK_R - 0.15
    for s in (-1, 1):
        mb.beam((-span, s * TOP_HALF, jz), (span, s * TOP_HALF, jz), 0.2, 0.22)
        mb.beam((s * TOP_HALF, -span, jz), (s * TOP_HALF, span, jz), 0.2, 0.22)

    # Deck plate
    mb.lathe([(DECK_Z, DECK_R, 0.0), (DECK_Z + DECK_T, DECK_R, 0.15)], 16, R_STEEL,
             smooth=False, cap_top=True, cap_bot=True)

    # Railing with a gap facing +X for the ladder
    posts = 16
    rail_ang = [2 * math.pi * (k + 0.5) / posts for k in range(posts)]
    rz0 = DECK_Z + DECK_T
    pts = [(RAIL_R * math.cos(a), RAIL_R * math.sin(a)) for a in rail_ang]
    for x, y in pts:
        mb.beam((x, y, rz0), (x, y, rz0 + RAIL_H), 0.05, 0.05, hint=(1, 0, 0))
    for k in range(posts - 1):
        (x1, y1), (x2, y2) = pts[k], pts[k + 1]
        for hz in (RAIL_H, RAIL_H * 0.5):
            mb.beam((x1, y1, rz0 + hz), (x2, y2, rz0 + hz), 0.05, 0.05)

    # Tank: bottom chamfer + barrel (separate lathes so the crease stays sharp)
    mb.lathe([(TANK_Z0, TANK_R - 0.18, 0.0), (TANK_Z0 + 0.2, TANK_R, 0.04)], 24, R_TANK,
             cap_bot=True, cap_reg=R_STEEL)
    mb.lathe([(TANK_Z0 + 0.2, TANK_R, 0.04), (TANK_Z1, TANK_R, 1.0)], 24, R_TANK, cap_top=True,
             cap_reg=R_ROOF)

    # Conical roof with eave lip + finial
    eave = TANK_Z1 - 0.06
    apex = TANK_Z1 + ROOF_RISE
    mb.lathe([(eave - 0.12, ROOF_R, 0.0), (eave, ROOF_R, 0.03)], 24, R_ROOF, smooth=False,
             cap_bot=True)
    mb.lathe([(eave, ROOF_R, 0.03), (apex, 0.08, 1.0)], 24, R_ROOF, cap_top=True)
    for k in range(8):
        a = 2 * math.pi * k / 8
        nrm = Vector((math.cos(a) * ROOF_RISE, math.sin(a) * ROOF_RISE, ROOF_R)).normalized()
        p0 = Vector((ROOF_R * math.cos(a), ROOF_R * math.sin(a), eave)) + nrm * 0.03
        p1 = Vector((0.12 * math.cos(a), 0.12 * math.sin(a), apex - 0.05)) + nrm * 0.03
        mb.beam(p0, p1, 0.07, 0.06, R_ROOF)
    mb.lathe([(apex - 0.05, 0.09, 0.0), (apex + 0.25, 0.05, 1.0)], 6, R_STEEL, smooth=False,
             cap_top=True)

    # Riser pipe down the middle + small pad
    mb.block(0.0, 0.0, [(0.0, 0.38), (0.28, 0.32)])
    mb.lathe([(0.28, 0.16, 0.0), (TANK_Z0, 0.16, 1.0)], 8, R_STEEL, cap_top=True)
    mb.lathe([(1.2, 0.22, 0.0), (1.45, 0.22, 1.0)], 8, R_STEEL, smooth=False)  # valve collar

    # Ladder on +X face, up through the railing gap
    top = DECK_Z + DECK_T + RAIL_H + 0.1
    for s in (-1, 1):
        y = s * LADDER_HW
        mb.beam((LADDER_X, y, 0.0), (LADDER_X, y, top), 0.06, 0.05, hint=(1, 0, 0))
        for z in BAY_Z[1:3] + [DECK_Z - 0.11]:
            mb.beam((LADDER_X - 0.03, y, z), (frame_half(z), y, z), 0.05, 0.05)
    z = 0.3
    while z < DECK_Z + DECK_T - 0.1:
        mb.beam((LADDER_X, -LADDER_HW, z), (LADDER_X, LADDER_HW, z), 0.035, 0.035)
        z += 0.3

    return mb


# --------------------------------------------------------------------------- textures

def _ss(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _vnoise(h, w, cx, cy, rng):
    g = rng.random((cy + 1, cx + 1))
    g[:, -1] = g[:, 0]  # wrap in u (tank/roof go all the way round)
    ys = np.linspace(0, cy, h, endpoint=False)
    xs = np.linspace(0, cx, w, endpoint=False)
    y0, x0 = ys.astype(int), xs.astype(int)
    fy, fx = ys - y0, xs - x0
    fy, fx = fy * fy * (3 - 2 * fy), fx * fx * (3 - 2 * fx)
    a, b = g[y0][:, x0], g[y0][:, x0 + 1]
    c, d = g[y0 + 1][:, x0], g[y0 + 1][:, x0 + 1]
    top = a + (b - a) * fx[None]
    bot = c + (d - c) * fx[None]
    return top + (bot - top) * fy[:, None]


def _fbm(h, w, cx, cy, rng, octaves=4):
    s, amp, tot = 0.0, 1.0, 0.0
    for o in range(octaves):
        s = s + amp * _vnoise(h, w, cx * 2 ** o, cy * 2 ** o, rng)
        tot += amp
        amp *= 0.5
    return s / tot


def _grid(h, w):
    u = (np.arange(w) + 0.5) / w
    v = (np.arange(h) + 0.5) / h
    return np.meshgrid(u, v)


def _streaks(U, V, rng, count, starts, width, length, noise):
    m = np.zeros_like(U)
    for _ in range(count):
        u0 = rng.random()
        vs = starts(rng)
        wd = rng.uniform(*width)
        ln = rng.uniform(*length)
        st = rng.uniform(0.35, 1.0)
        du = ((U - u0 + 0.5) % 1.0) - 0.5
        t = (vs - V) / ln
        along = np.clip(1 - t, 0, 1) * (t > 0)
        m = np.maximum(m, st * np.exp(-(du / wd) ** 2) * along ** 1.5 * (0.55 + 0.45 * noise))
    return m


RUST = np.array([0.46, 0.24, 0.11])
RUST_DARK = np.array([0.24, 0.13, 0.07])


def _paint_tank(h, w, rng):
    U, V = _grid(h, w)
    n1 = _fbm(h, w, 8, 3, rng)
    n2 = _fbm(h, w, 32, 10, rng)
    split = 0.5 + 0.004 * np.sin(U * 2 * np.pi * 3)
    white = np.array([0.80, 0.79, 0.74])
    blue = np.array([0.20, 0.36, 0.50])
    col = np.where((V > split)[..., None], white, blue) * (0.86 + 0.26 * n1)[..., None]
    seam = (np.abs((U * 12) % 1 - 0.5) > 0.494) | (np.abs(V - 0.26) < 0.003) | (np.abs(V - 0.76) < 0.003)
    col[seam] *= 0.72
    starts = lambda r: [0.995, 0.5, r.uniform(0.3, 0.95)][r.integers(0, 3)]
    m = _streaks(U, V, rng, 70, starts, (0.002, 0.012), (0.12, 0.7), n2)
    patches = _ss(0.62, 0.78, _fbm(h, w, 16, 5, rng))
    m = np.clip(np.maximum.reduce([m, patches * 0.9, _ss(0.1, 0.0, V) * 0.85,
                                   _ss(0.04, 0.0, np.abs(V - 0.5)) * 0.5]), 0, 1)
    rust = RUST_DARK + (RUST - RUST_DARK) * n2[..., None]
    col = col * (1 - m[..., None]) + rust * m[..., None]
    return col, 0.55 + 0.35 * m, 0.2 + 0.2 * m


def _paint_roof(h, w, rng):
    U, V = _grid(h, w)
    n1 = _fbm(h, w, 8, 4, rng)
    n2 = _fbm(h, w, 32, 16, rng)
    col = np.array([0.18, 0.32, 0.46]) * (0.8 + 0.35 * n1)[..., None]
    seam = np.abs((U * 8) % 1 - 0.5) > 0.49
    col[seam] *= 0.7
    m = _streaks(U, V, rng, 50, lambda r: r.uniform(0.6, 1.0), (0.004, 0.02), (0.2, 0.8), n2)
    patches = _ss(0.58, 0.75, _fbm(h, w, 12, 6, rng))
    m = np.clip(np.maximum.reduce([m, patches, _ss(0.18, 0.0, V) * 0.9]), 0, 1)
    rust = RUST_DARK + (RUST - RUST_DARK) * n2[..., None]
    col = col * (1 - m[..., None]) + rust * m[..., None]
    return col, 0.5 + 0.4 * m, 0.3 + 0.15 * m


def _paint_steel(h, w, rng):
    n1 = _fbm(h, w, 16, 8, rng)
    n2 = _fbm(h, w, 64, 32, rng)
    t = _ss(0.45, 0.85, n1)[..., None] * 0.8
    col = np.array([0.15, 0.12, 0.10]) * (1 - t) + RUST_DARK * 1.3 * t
    col = col * (0.75 + 0.4 * n2)[..., None]
    return col, 0.75 + 0.15 * n2, 0.45 - 0.15 * t[..., 0]


def _paint_concrete(h, w, rng):
    n1 = _fbm(h, w, 12, 6, rng)
    n2 = _fbm(h, w, 96, 48, rng)
    col = np.array([0.52, 0.51, 0.48]) * (0.78 + 0.3 * n1 + 0.12 * n2)[..., None]
    dirt = _ss(0.6, 0.8, n1)[..., None] * 0.35
    col = col * (1 - dirt) + np.array([0.33, 0.29, 0.22]) * dirt
    return col, 0.92 + 0.06 * n2, np.zeros_like(n1)


def _image(name, arr, non_color=False):
    old = bpy.data.images.get(name)
    if old:
        bpy.data.images.remove(old)
    h, w, _ = arr.shape
    img = bpy.data.images.new(name, w, h, alpha=False)
    if non_color:
        try:
            img.colorspace_settings.name = "Non-Color"
        except TypeError:
            pass
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :3] = np.clip(arr, 0, 1)
    img.pixels.foreach_set(rgba.ravel())
    img.pack()
    return img


def make_textures():
    rng = np.random.default_rng(11)
    col = np.zeros((TEX, TEX, 3), np.float32)
    mr = np.ones((TEX, TEX, 3), np.float32)  # R = 1, G = roughness, B = metallic (glTF)
    for reg, fn in ((R_TANK, _paint_tank), (R_ROOF, _paint_roof),
                    (R_STEEL, _paint_steel), (R_CONC, _paint_concrete)):
        ys = slice(int(reg[1] * TEX), int(reg[3] * TEX))
        xs = slice(int(reg[0] * TEX), int(reg[2] * TEX))
        h, w = ys.stop - ys.start, xs.stop - xs.start
        c, rough, metal = fn(h, w, rng)
        col[ys, xs] = c
        mr[ys, xs, 1] = rough
        mr[ys, xs, 2] = metal
    return _image(NAME + "_Color", col), _image(NAME + "_MR", mr, non_color=True)


def make_material(img_col, img_mr):
    old = bpy.data.materials.get(NAME)
    if old:
        bpy.data.materials.remove(old)
    mat = bpy.data.materials.new(NAME)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    tc = nt.nodes.new("ShaderNodeTexImage")
    tc.image = img_col
    tc.location = (-600, 300)
    tm = nt.nodes.new("ShaderNodeTexImage")
    tm.image = img_mr
    tm.location = (-600, -50)
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    sep.location = (-300, -50)
    nt.links.new(tc.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(tm.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs[1], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs[2], bsdf.inputs["Metallic"])
    return mat


# --------------------------------------------------------------------------- assembly

def _scene():
    sc = bpy.data.scenes.get(NAME) or bpy.data.scenes.new(NAME)
    bpy.context.window.scene = sc
    for o in list(sc.collection.all_objects):
        bpy.data.objects.remove(o, do_unlink=True)
    sc.unit_settings.system = "METRIC"
    return sc


def build(export=False):
    sc = _scene()
    mb = build_geometry()

    old = bpy.data.meshes.get(NAME)
    if old:
        bpy.data.meshes.remove(old)
    me = bpy.data.meshes.new(NAME)
    me.from_pydata(mb.verts, [], mb.faces)
    uv = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        for j, li in enumerate(poly.loop_indices):
            uv.data[li].uv = mb.uvs[poly.index][j]
    me.polygons.foreach_set("use_smooth", mb.smooth)

    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.update()

    img_col, img_mr = make_textures()
    me.materials.append(make_material(img_col, img_mr))

    obj = bpy.data.objects.new(NAME, me)
    sc.collection.objects.link(obj)
    if not any(o.type == "LIGHT" for o in sc.objects):
        ld = bpy.data.lights.new(NAME + "_Sun", "SUN")
        ld.energy = 3.0
        lo = bpy.data.objects.new(NAME + "_Sun", ld)
        lo.rotation_euler = (0.8, 0.2, 0.6)
        sc.collection.objects.link(lo)

    tris = sum(len(f) - 2 for f in mb.faces)
    print(f"[water_tower] verts={len(mb.verts)} faces={len(mb.faces)} tris={tris} "
          f"height={TANK_Z1 + ROOF_RISE + 0.25:.2f} m")

    if export:
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        props = {p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties}
        # use_active_scene: selections left in other scenes would otherwise leak into the GLB
        kw = dict(filepath=GAME_MODEL, export_format="GLB", use_selection=True, use_active_scene=True,
                  export_apply=True, export_yup=True, export_materials="EXPORT",
                  export_image_format="JPEG", export_jpeg_quality=88, export_image_quality=88,
                  export_animations=False)
        bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in props})
        print("[water_tower] exported", GAME_MODEL)
    return obj, tris
