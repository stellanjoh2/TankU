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
RUIN_MODEL = os.path.join(ROOT, "proto", "public", "models", "water_tower_destroyed.glb")
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


# --------------------------------------------------------------------------- ruined swap mesh
# Same origin and footprint as the intact tower. Tank roof and upper wall are gone;
# the stump is torn open and the steel frame below is buckled and shredded.

RUIN = "WaterTower_Destroyed"


def _axis(sx, sy):
    o = Vector((sx, sy, 0))
    o.normalize()
    return o, Vector((-o.y, o.x, 0))


def _plate(mb, corners, reg):
    ids = [mb.v(c) for c in corners]
    uvs = mb.patch(reg, 1.2)
    mb.face(ids, uvs)
    mb.face(ids[::-1], uvs[::-1])


def _curl_sheet(mb, p0, p1, outward, segs, reach, drop, reg):
    """Torn sheet whose free edge curls away and down. p0/p1 are the attached edge."""
    p0, p1 = Vector(p0), Vector(p1)
    prev = [mb.v(p0), mb.v(p1)]
    for i in range(1, segs + 1):
        t = i / segs
        ang = t * math.radians(125)
        hang = math.sin(ang) * reach * t + drop * (t ** 1.5)
        off = outward * (math.sin(ang) * reach * 0.85) + Vector((0, 0, -hang))
        twist = Vector((-outward.y, outward.x, 0)) * (0.18 * math.sin(t * math.pi))
        shrink = 1 - 0.4 * t
        mid_off = off
        a = p0 + mid_off + twist * t
        b = p1 + mid_off - twist * t
        c = (a + b) * 0.5
        a, b = c + (a - c) * shrink, c + (b - c) * shrink
        ids = [mb.v(a), mb.v(b)]
        u0, u1 = 0.15, 0.85
        v0, v1 = 0.2 + 0.6 * (i - 1) / segs, 0.2 + 0.6 * i / segs
        mb.face([prev[0], prev[1], ids[1], ids[0]],
                [_ruv(reg, u0, v0), _ruv(reg, u1, v0), _ruv(reg, u1, v1), _ruv(reg, u0, v1)])
        prev = ids
    return


def _ribbon(mb, a, b, width, reg=R_STEEL):
    """Flat torn strap. Both sides, so it reads edge-on."""
    a, b = Vector(a), Vector(b)
    d = b - a
    side = d.cross(Vector((0, 0, 1)))
    if side.length < 1e-4:
        side = Vector((1, 0, 0))
    side.normalize()
    hw = width * 0.5
    _plate(mb, [a + side * hw, a - side * hw, b - side * hw, b + side * hw], reg)


def _torn_end(mb, tip, axis, n=3, length=(0.45, 1.15)):
    """Flat straps peeling off a sheared end and drooping."""
    tip = Vector(tip)
    axis = Vector(axis).normalized()
    side = axis.cross(Vector((0, 0, 1)))
    if side.length < 1e-4:
        side = Vector((1, 0, 0))
    side.normalize()
    up = side.cross(axis).normalized()
    for i in range(n):
        a = math.tau * i / n + mb.rng.random()
        d = side * math.cos(a) + up * math.sin(a) * 0.4 + axis * 0.2
        d = (d + Vector((0, 0, -0.9))).normalized()
        end = tip + d * mb.rng.uniform(*length) + side * mb.rng.uniform(-0.12, 0.12)
        _ribbon(mb, tip, end, mb.rng.uniform(0.08, 0.2))


def _leg_points(sx, sy, samples):
    """samples: (z, outward, sideways) offsets from the straight leg line."""
    outward, side = _axis(sx, sy)
    pts = []
    for z, o, s in samples:
        pts.append(leg_pt(sx, sy, z) + outward * o + side * s)
    return pts


def _beams(mb, pts, w=0.2, h=0.2):
    for a, b in zip(pts, pts[1:]):
        mb.beam(a, b, w, h, hint=(1, 0, 0))


def build_ruined_geometry():
    mb = MeshBuilder(seed=9)
    rng = mb.rng

    # Concrete footings stay. Legs buckle; the NE leg is sheared off mid-height
    # and the SE leg folds outward instead of reaching the deck.
    # corners: 0 NE (1,1), 1 NW (-1,1), 2 SW (-1,-1), 3 SE (1,-1)
    profiles = [
        [(FOOT_H - 0.05, 0.0, 0.0), (3.3, 0.18, 0.1), (6.5, 0.5, -0.15),
         (8.8, 0.22, 0.2), (10.4, 0.05, 0.04)],
        [(FOOT_H - 0.05, 0.0, 0.0), (2.9, 0.12, -0.18), (5.2, 0.42, 0.16), (6.55, 0.62, -0.08)],
        [(FOOT_H - 0.05, 0.0, 0.0), (3.0, -0.08, 0.22), (6.1, 0.28, 0.38),
         (8.4, 0.05, -0.16), (10.45, -0.12, 0.06)],
        [(FOOT_H - 0.05, 0.0, 0.0), (3.5, 0.2, -0.12), (6.4, 0.55, 0.28), (8.15, 0.95, 0.15)],
    ]
    for i, (sx, sy) in enumerate(CORNERS):
        mb.block(sx * FOOT_HALF, sy * FOOT_HALF, [(0.0, 0.5), (0.32, 0.5), (FOOT_H, 0.3)])
        pts = _leg_points(sx, sy, profiles[i])
        _beams(mb, pts, 0.22, 0.2)
        axis = pts[-1] - pts[-2]
        _torn_end(mb, pts[-1], axis, n=4 if i in (1, 3) else 2, length=(0.7, 1.4))
        # a flange peeled off the upper leg
        peel = pts[-2].lerp(pts[-1], 0.35)
        _ribbon(mb, peel, peel + _axis(sx, sy)[0] * 0.9 + Vector((0, 0, -1.1)), 0.16)
        if i == 3:
            # upper length folded down beside the tear
            fold = pts[-1] + _axis(sx, sy)[0] * 0.7 + Vector((0.2, -0.3, -1.7))
            mb.beam(pts[-1], fold, 0.16, 0.14, hint=(1, 0, 0))
            _torn_end(mb, fold, fold - pts[-1], n=3, length=(0.5, 1.0))

    # Lowest bay still ties the tower together. Mid bay is snapped and hanging.
    # The top bay is gone apart from short stubs.
    for i in range(4):
        c1, c2 = CORNERS[i], CORNERS[(i + 1) % 4]
        n = Vector(((c1[0] + c2[0]) * 0.5, (c1[1] + c2[1]) * 0.5, 0)).normalized()
        za, zb = BAY_Z[0], BAY_Z[1]
        mb.beam(leg_pt(*c1, za), leg_pt(*c2, za), 0.11, 0.14)
        # X-straps snapped. One diagonal on the south face is still whole.
        a = leg_pt(*c1, za) + n * 0.03
        b = leg_pt(*c2, zb) + n * 0.03
        if i == 2:
            mb.beam(a, b, 0.05, 0.1)
        else:
            mid = a.lerp(b, 0.3)
            mb.beam(a, mid, 0.05, 0.09)
            _ribbon(mb, mid, mid + n * 0.55 + Vector((rng.uniform(-0.25, 0.25), rng.uniform(-0.25, 0.25), -1.45)), 0.12)

        # mid-height ties: short stubs, a few hanging straps
        z = BAY_Z[2]
        a = leg_pt(*c1, z)
        b = leg_pt(*c2, z)
        stub = a.lerp(b, 0.34 if i % 2 == 0 else 0.2)
        mb.beam(a, stub, 0.09, 0.1)
        _ribbon(mb, stub, stub + n * 0.15 + Vector((0, 0, -0.95)), 0.08)

    # Torn deck: a bitten plate on the two legs that still reach it.
    # The NW wedge (sheared leg) is missing; the SE edge droops toward the fold.
    nd = 16
    angs = [math.tau * k / nd for k in range(nd)]
    z_top, z_bot = DECK_Z + DECK_T, DECK_Z + 0.02
    inner = 0.7

    def _deck_pt(a, rad, z, edge=False):
        d = math.degrees(a) % 360
        drop = 0.0
        if edge and (70 < d < 105 or 175 < d < 215):
            rad *= rng.uniform(0.62, 0.88)
            drop = rng.uniform(0.15, 0.55)
        if edge and 250 < d < 340:
            drop = 0.85 + 0.4 * math.sin(math.radians(d))
            rad += 0.2
        return Vector((rad * math.cos(a), rad * math.sin(a), z - drop))

    for k in range(nd):
        a0, a1 = angs[k], angs[(k + 1) % nd]
        d0, d1 = math.degrees(a0) % 360, math.degrees(a1) % 360
        if 95 <= d0 <= 185 and 95 <= d1 <= 185:
            continue
        o0, o1 = _deck_pt(a0, DECK_R, z_top, True), _deck_pt(a1, DECK_R, z_top, True)
        i0, i1 = _deck_pt(a0, inner, z_top), _deck_pt(a1, inner, z_top)
        _plate(mb, [i0, i1, o1, o0], R_STEEL)
        ob0, ob1 = _deck_pt(a0, DECK_R, z_bot, True), _deck_pt(a1, DECK_R, z_bot, True)
        ib0, ib1 = _deck_pt(a0, inner, z_bot), _deck_pt(a1, inner, z_bot)
        # match the top's jag so the rim isn't a separate shape
        ob0.x, ob0.y, ob1.x, ob1.y = o0.x, o0.y, o1.x, o1.y
        ob0.z, ob1.z = o0.z - 0.1, o1.z - 0.1
        ib0.z, ib1.z = i0.z - 0.1, i1.z - 0.1
        _plate(mb, [ib0, ob0, ob1, ib1], R_STEEL)
        _plate(mb, [o0, o1, ob1, ob0], R_STEEL)

    # A few railing posts bent outward on the surviving rim, no continuous rail.
    for deg, lean in ((20, 0.7), (250, 0.9), (310, 1.1), (200, 0.45)):
        a = math.radians(deg)
        p = Vector((RAIL_R * math.cos(a), RAIL_R * math.sin(a), DECK_Z + DECK_T))
        if 95 < deg < 185:
            continue
        tip = p + Vector((math.cos(a) * lean, math.sin(a) * lean, 0.35 - lean * 0.5))
        mb.beam(p, tip, 0.045, 0.045, hint=(1, 0, 0))

    # Tank bottom ring survives; the wall is a jagged stump with a blown-out side
    # facing the sheared leg (NW). Roof is gone.
    n = 24
    gap = set(range(4, 15))  # ~165° bite facing NW
    z0 = TANK_Z0 + 0.2
    th = 0.07
    heights, curls = [], []
    for k in range(n):
        h = 1.15 + rng.uniform(0, 0.85)
        if k in (5, 13, 18):
            h += 0.7
        if k in (16, 17):
            h = 0.4
        heights.append(h)
        if k in (3, 4, 15, 16):
            curls.append(rng.uniform(0.4, 0.75))
        elif k not in gap:
            curls.append(rng.uniform(-0.16, 0.22))
        else:
            curls.append(0.0)
    ang = [math.tau * k / n for k in range(n)]

    def _ring(z_of, rad_of):
        ids = []
        for k, a in enumerate(ang):
            r = rad_of(k)
            ids.append(mb.v((r * math.cos(a), r * math.sin(a), z_of(k))))
        return ids

    outer_bot = _ring(lambda k: z0, lambda k: TANK_R)
    outer_top = _ring(lambda k: z0 + heights[k], lambda k: TANK_R + curls[k])
    inner_bot = _ring(lambda k: z0, lambda k: TANK_R - th)
    inner_top = _ring(lambda k: z0 + heights[k], lambda k: TANK_R - th + curls[k] * 0.35)

    def _wall_uv(k, k2, v0, v1):
        return [_ruv(R_TANK, k / n, v0), _ruv(R_TANK, k2 / n, v0),
                _ruv(R_TANK, k2 / n, v1), _ruv(R_TANK, k / n, v1)]

    for k in range(n):
        if k in gap:
            continue
        k2 = (k + 1) % n
        if k2 in gap and k in gap:
            continue
        v1 = 0.15 + 0.35 * (heights[k] / 2.6)
        mb.face([outer_bot[k], outer_bot[k2], outer_top[k2], outer_top[k]], _wall_uv(k, k2, 0.08, v1))
        mb.face([inner_bot[k], inner_top[k], inner_top[k2], inner_bot[k2]],
                [_ruv(R_STEEL, k / n, 0.1), _ruv(R_STEEL, k2 / n, 0.1),
                 _ruv(R_STEEL, k2 / n, v1), _ruv(R_STEEL, k / n, v1)])
        mb.face([outer_top[k], outer_top[k2], inner_top[k2], inner_top[k]],
                [_ruv(R_STEEL, 0.1, 0.2), _ruv(R_STEEL, 0.4, 0.2),
                 _ruv(R_STEEL, 0.4, 0.45), _ruv(R_STEEL, 0.1, 0.45)])
    for cut in (4, 15):
        mb.face([outer_bot[cut], outer_top[cut], inner_top[cut], inner_bot[cut]],
                [_ruv(R_STEEL, 0.2, 0.1), _ruv(R_STEEL, 0.2, 0.8),
                 _ruv(R_STEEL, 0.45, 0.8), _ruv(R_STEEL, 0.45, 0.1)])

    # Bottom chamfer + floor, same as the intact tank's base.
    mb.lathe([(TANK_Z0, TANK_R - 0.18, 0.0), (z0, TANK_R, 0.04)], n, R_TANK,
             cap_bot=True, cap_reg=R_STEEL)

    # Short burrs on the torn rim, not a second crown of spikes.
    for k in (1, 17, 20, 22):
        a = ang[k]
        tip = Vector(((TANK_R + curls[k]) * math.cos(a), (TANK_R + curls[k]) * math.sin(a), z0 + heights[k]))
        _torn_end(mb, tip, Vector((math.cos(a), math.sin(a), 0.15)), n=1, length=(0.25, 0.45))

    # Skin peeled off the bite and hanging down the NW side, plus a deck flap.
    a_lo, a_hi = ang[15], ang[15] - 0.95
    rim_z = z0 + max(heights[15], heights[14]) * 0.55
    p0 = Vector((TANK_R * math.cos(a_lo), TANK_R * math.sin(a_lo), rim_z))
    p1 = Vector((TANK_R * math.cos(a_hi), TANK_R * math.sin(a_hi), rim_z - 0.15))
    outward = Vector((math.cos(ang[14]), math.sin(ang[14]), 0)).normalized()
    _curl_sheet(mb, p0, p1, outward, segs=6, reach=1.1, drop=3.2, reg=R_TANK)
    flap = math.radians(125)
    f0 = Vector((2.2 * math.cos(flap), 2.2 * math.sin(flap), DECK_Z + 0.02))
    f1 = Vector((2.2 * math.cos(flap + 0.4), 2.2 * math.sin(flap + 0.4), DECK_Z - 0.1))
    _curl_sheet(mb, f0, f1, Vector((math.cos(flap), math.sin(flap), 0)),
                segs=4, reach=0.9, drop=1.6, reg=R_STEEL)

    # Riser sheared under the deck, mouth flared.
    mb.block(0.0, 0.0, [(0.0, 0.38), (0.28, 0.32)])
    mb.lathe([(0.28, 0.16, 0.0), (3.5, 0.16, 1.0)], 8, R_STEEL)
    mb.lathe([(3.5, 0.16, 0.0), (5.15, 0.15, 1.0)], 8, R_STEEL, cx=0.4, cy=-0.25)
    mb.lathe([(5.15, 0.15, 0.0), (5.4, 0.32, 1.0)], 8, R_STEEL, cx=0.4, cy=-0.25, smooth=False)
    mb.lathe([(1.2, 0.22, 0.0), (1.45, 0.22, 1.0)], 8, R_STEEL, smooth=False)
    for k in range(4):
        a = math.tau * k / 4
        lip = Vector((0.4 + 0.32 * math.cos(a), -0.25 + 0.32 * math.sin(a), 5.4))
        _ribbon(mb, lip, lip + Vector((math.cos(a) * 0.35, math.sin(a) * 0.35, -0.25)), 0.06)

    # Ladder ripped off above the first bay and peeled outward.
    top = 3.7
    for s in (-1, 1):
        y = s * LADDER_HW
        mb.beam((LADDER_X, y, 0.0), (LADDER_X, y, top), 0.06, 0.05, hint=(1, 0, 0))
        tip = Vector((LADDER_X + 0.85 + 0.2 * s, y * 1.4, top + 0.15))
        mb.beam((LADDER_X, y, top), tip, 0.05, 0.04, hint=(0, 1, 0))
        _ribbon(mb, tip, tip + Vector((0.4, 0.15 * s, -0.7)), 0.05)
    z = 0.3
    while z < top - 0.15:
        mb.beam((LADDER_X, -LADDER_HW, z), (LADDER_X, LADDER_HW, z), 0.035, 0.035)
        z += 0.3

    # Blown-off skin on the ground, still inside the footing span.
    _plate(mb, [
        Vector((1.6, 1.7, 0.05)), Vector((3.7, 1.3, 0.42)),
        Vector((3.2, 3.2, 0.14)), Vector((1.3, 2.9, 0.04)),
    ], R_ROOF)
    _plate(mb, [
        Vector((-2.4, 1.5, 0.06)), Vector((-0.5, 1.9, 0.48)),
        Vector((0.5, 3.5, 0.16)), Vector((-1.8, 3.4, 0.04)),
    ], R_TANK)

    return mb


def _ruin_scene():
    sc = bpy.data.scenes.get(NAME) or bpy.data.scenes.new(NAME)
    bpy.context.window.scene = sc
    sc.unit_settings.system = "METRIC"
    for obj in list(sc.objects):
        if obj.name == RUIN or obj.name.startswith(RUIN):
            bpy.data.objects.remove(obj, do_unlink=True)
    world = bpy.data.worlds.get(NAME + "_World") or bpy.data.worlds.new(NAME + "_World")
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs[0].default_value = (0.62, 0.66, 0.7, 1.0)
    bg.inputs[1].default_value = 1.0
    sc.world = world
    return sc


def _link_mesh(sc, mesh_name, mb, mat):
    old = bpy.data.meshes.get(mesh_name)
    if old:
        bpy.data.meshes.remove(old)
    me = bpy.data.meshes.new(mesh_name)
    me.from_pydata(mb.verts, [], mb.faces)
    uv = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        for j, li in enumerate(poly.loop_indices):
            uv.data[li].uv = mb.uvs[poly.index][j]
    me.polygons.foreach_set("use_smooth", mb.smooth)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    loose = [v for v in bm.verts if not v.link_faces]
    if loose:
        bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(me)
    bm.free()
    me.update()
    me.materials.append(mat)
    obj = bpy.data.objects.new(mesh_name, me)
    sc.collection.objects.link(obj)
    return obj


def _export_glb(obj, path):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    props = {p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties}
    kw = dict(filepath=path, export_format="GLB", use_selection=True, use_active_scene=True,
              export_apply=True, export_yup=True, export_materials="EXPORT",
              export_image_format="JPEG", export_jpeg_quality=88, export_image_quality=88,
              export_animations=False)
    bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in props})
    print("[water_tower] exported", path)


def build_ruined(export=False):
    """Destroyed swap mesh in the WaterTower scene. Does not touch other scenes."""
    sc = _ruin_scene()
    mb = build_ruined_geometry()
    img_col, img_mr = make_textures()
    obj = _link_mesh(sc, RUIN, mb, make_material(img_col, img_mr))
    if not any(o.type == "LIGHT" for o in sc.objects):
        ld = bpy.data.lights.new(NAME + "_Sun", "SUN")
        ld.energy = 4.0
        lo = bpy.data.objects.new(NAME + "_Sun", ld)
        lo.rotation_euler = (0.75, 0.15, -0.4)
        sc.collection.objects.link(lo)
    for area in bpy.context.screen.areas:
        if area.type == "VIEW_3D":
            for space in area.spaces:
                if space.type == "VIEW_3D":
                    space.shading.type = "MATERIAL"
    tris = sum(len(f) - 2 for f in mb.faces)
    zs = [v[2] for v in mb.verts]
    print(f"[water_tower] ruined verts={len(mb.verts)} faces={len(mb.faces)} tris={tris} "
          f"z={min(zs):.2f}..{max(zs):.2f}")
    if export:
        _export_glb(obj, RUIN_MODEL)
    return obj
