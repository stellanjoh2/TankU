"""US flag on a steel flagpole -> proto/public/models/flag.glb. Run inside Blender:

    import sys; sys.path.append('/Users/stellanjohansson/Cursor/Blender-Test01/scripts')
    import build_flag, importlib; importlib.reload(build_flag)
    build_flag.build(export=True)

Built in its own scene ("FlagPole") as two meshes: "FlagPole" (pole, base, finial, halyard) and
"Flag" (a flat, finely subdivided cloth plane textured with textures/us_flag.png). The flag is
exported flat; the game waves it in a vertex shader (proto/src/flag.js), so the grid density here
is what the wave bends. Units are metres, Z up, origin at ground centre of the pole.
"""
import math
import os

import bpy
import bmesh

ROOT = "/Users/stellanjohansson/Cursor/Blender-Test01"
GAME_MODEL = os.path.join(ROOT, "proto", "public", "models", "flag.glb")
FLAG_TEX = os.path.join(ROOT, "textures", "us_flag.png")
NAME = "FlagPole"

# --- Dimensions (m) --- keep in sync with proto/src/flag.js
PAD_HALF = 0.5
PAD_H = 0.2
FOOT_R0, FOOT_R1, FOOT_Z1 = 0.3, 0.1, 0.62     # flared steel foot
SLEEVE_R, SLEEVE_Z1 = 0.1, 1.25                # ground sleeve
POLE_R0, POLE_R1, POLE_H = 0.075, 0.045, 9.0   # tapered mast
TRUCK_R, TRUCK_H = 0.07, 0.09
BALL_R = 0.11
FLAG_W = 3.0
FLAG_H = FLAG_W * 538 / 1024                   # texture aspect (official 1:1.9)
FLAG_X0 = POLE_R1 + 0.035                      # hoist edge, just off the mast
FLAG_TOP = POLE_H - 0.22
FLAG_NX, FLAG_NY = 15, 10  # −25% from 20×10; still enough for the shader wave
ROPE_X = POLE_R1 + 0.02
ROPE_R = 0.008
CLEAT_Z = 1.55

MAT_STEEL, MAT_CONC, MAT_ROPE = 0, 1, 2
SIDES = 20


class MeshBuilder:
    def __init__(self):
        self.verts, self.faces, self.mats, self.smooth = [], [], [], []

    def v(self, p):
        self.verts.append(tuple(p))
        return len(self.verts) - 1

    def face(self, ids, mat, smooth=False):
        self.faces.append(ids)
        self.mats.append(mat)
        self.smooth.append(smooth)

    def lathe(self, prof, mat, n=SIDES, cx=0.0, cy=0.0, cap_top=False, cap_bot=False, smooth=True):
        """prof: [(z, r)] bottom->top."""
        ang = [2 * math.pi * k / n for k in range(n)]
        rings = [[self.v((cx + r * math.cos(a), cy + r * math.sin(a), z)) for a in ang] for z, r in prof]
        for i in range(len(prof) - 1):
            for k in range(n):
                k2 = (k + 1) % n
                self.face([rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]], mat, smooth)
        if cap_bot:
            self.face(rings[0][::-1], mat)
        if cap_top:
            self.face(rings[-1], mat)

    def sphere(self, c, r, mat, n=16, rings=10):
        prof = []
        for i in range(rings + 1):
            t = math.pi * i / rings
            prof.append((c[2] - r * math.cos(t), max(1e-4, r * math.sin(t))))
        self.lathe(prof, mat, n, c[0], c[1])

    def box(self, c, h, mat):
        x, y, z = c
        hx, hy, hz = h
        p = [self.v((x + sx * hx, y + sy * hy, z + sz * hz))
             for sz in (-1, 1) for sy in (-1, 1) for sx in (-1, 1)]
        for ids in ([0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]):
            self.face([p[i] for i in ids], mat)


def build_pole():
    mb = MeshBuilder()
    # Concrete pad with a small chamfered top
    mb.lathe([(0.0, PAD_HALF * math.sqrt(2)), (PAD_H - 0.04, PAD_HALF * math.sqrt(2)),
              (PAD_H, (PAD_HALF - 0.04) * math.sqrt(2))], MAT_CONC, n=4, cap_top=True,
             cap_bot=True, smooth=False)
    # Rotate the 4-sided lathe 45 deg so the pad is axis-aligned
    c45 = math.cos(math.pi / 4)
    mb.verts = [(c45 * (x - y), c45 * (x + y), z) for x, y, z in mb.verts]

    # Flared foot, collar ring, sleeve, mast
    mb.lathe([(PAD_H - 0.01, FOOT_R0), (PAD_H + 0.05, FOOT_R0), (PAD_H + 0.1, FOOT_R0 * 0.72),
              (FOOT_Z1, FOOT_R1)], MAT_STEEL)
    mb.lathe([(FOOT_Z1, FOOT_R1 + 0.02), (FOOT_Z1 + 0.06, FOOT_R1 + 0.02)], MAT_STEEL,
             cap_top=True, cap_bot=True, smooth=False)
    mb.lathe([(FOOT_Z1, SLEEVE_R), (SLEEVE_Z1, SLEEVE_R * 0.95)], MAT_STEEL, cap_top=True)
    mb.lathe([(SLEEVE_Z1 - 0.05, POLE_R0), (POLE_H, POLE_R1)], MAT_STEEL)

    # Truck (pulley cap) + steel ball finial
    mb.lathe([(POLE_H, TRUCK_R), (POLE_H + TRUCK_H, TRUCK_R)], MAT_STEEL, cap_top=True,
             cap_bot=True, smooth=False)
    mb.lathe([(POLE_H + TRUCK_H, 0.018), (POLE_H + TRUCK_H + 0.06, 0.018)], MAT_STEEL, n=8)
    mb.sphere((0.0, 0.0, POLE_H + TRUCK_H + 0.06 + BALL_R * 0.92), BALL_R, MAT_STEEL)

    # Halyard: truck -> cleat, plus the two clips on the flag's hoist corners
    rz1 = POLE_H + TRUCK_H * 0.5
    mb.lathe([(CLEAT_Z, ROPE_R), (rz1, ROPE_R)], MAT_ROPE, n=6, cx=ROPE_X)
    mb.lathe([(CLEAT_Z - 0.35, ROPE_R), (CLEAT_Z, ROPE_R)], MAT_ROPE, n=6, cx=ROPE_X * 0.6, cy=0.03)
    mb.box((POLE_R0 + 0.012, 0.0, CLEAT_Z), (0.012, 0.02, 0.09), MAT_STEEL)
    for z in (FLAG_TOP, FLAG_TOP - FLAG_H):
        mb.box((ROPE_X + 0.005, 0.0, z), (0.018, 0.012, 0.022), MAT_STEEL)
    return mb


def make_pole_materials():
    out = []
    for name, col, metal, rough in (
        ("FlagPole_Steel", (0.80, 0.81, 0.82), 0.9, 0.28),
        ("FlagPole_Concrete", (0.55, 0.53, 0.49), 0.0, 0.95),
        ("FlagPole_Rope", (0.86, 0.84, 0.78), 0.0, 0.9),
    ):
        old = bpy.data.materials.get(name)
        if old:
            bpy.data.materials.remove(old)
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Base Color"].default_value = (*col, 1.0)
        bsdf.inputs["Metallic"].default_value = metal
        bsdf.inputs["Roughness"].default_value = rough
        out.append(m)
    return out


def make_flag_material():
    old = bpy.data.materials.get("Flag")
    if old:
        bpy.data.materials.remove(old)
    img = bpy.data.images.get("us_flag.png")
    if img:
        bpy.data.images.remove(img)
    img = bpy.data.images.load(FLAG_TEX)
    img.pack()
    m = bpy.data.materials.new("Flag")
    m.use_nodes = True
    m.use_backface_culling = False  # -> glTF doubleSided
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.85
    bsdf.inputs["Metallic"].default_value = 0.0
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.location = (-400, 300)
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    return m


def build_flag_mesh():
    """Flat cloth in the XZ plane, hoist at x = FLAG_X0, u = 0 at the pole, v = 1 at the top."""
    verts, faces, uvs = [], [], []
    for j in range(FLAG_NY + 1):
        for i in range(FLAG_NX + 1):
            u, v = i / FLAG_NX, j / FLAG_NY
            verts.append((FLAG_X0 + u * FLAG_W, 0.0, FLAG_TOP - FLAG_H + v * FLAG_H))
    row = FLAG_NX + 1
    for j in range(FLAG_NY):
        for i in range(FLAG_NX):
            a = j * row + i
            faces.append((a, a + 1, a + row + 1, a + row))
    me = bpy.data.meshes.new("Flag")
    me.from_pydata(verts, [], faces)
    uv = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        for li in poly.loop_indices:
            x, _, z = verts[me.loops[li].vertex_index]
            uv.data[li].uv = ((x - FLAG_X0) / FLAG_W, (z - (FLAG_TOP - FLAG_H)) / FLAG_H)
    me.polygons.foreach_set("use_smooth", [True] * len(faces))
    me.update()
    return me


def _scene():
    sc = bpy.data.scenes.get(NAME) or bpy.data.scenes.new(NAME)
    bpy.context.window.scene = sc
    for o in list(sc.collection.all_objects):
        bpy.data.objects.remove(o, do_unlink=True)
    sc.unit_settings.system = "METRIC"
    return sc


def build(export=False):
    sc = _scene()
    for name in (NAME, "Flag"):
        old = bpy.data.meshes.get(name)
        if old:
            bpy.data.meshes.remove(old)

    mb = build_pole()
    me = bpy.data.meshes.new(NAME)
    me.from_pydata(mb.verts, [], mb.faces)
    me.polygons.foreach_set("material_index", mb.mats)
    me.polygons.foreach_set("use_smooth", mb.smooth)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    for m in make_pole_materials():
        me.materials.append(m)
    me.update()
    pole = bpy.data.objects.new(NAME, me)
    sc.collection.objects.link(pole)

    fme = build_flag_mesh()
    fme.materials.append(make_flag_material())
    flag = bpy.data.objects.new("Flag", fme)
    sc.collection.objects.link(flag)

    if not any(o.type == "LIGHT" for o in sc.objects):
        ld = bpy.data.lights.new(NAME + "_Sun", "SUN")
        ld.energy = 3.0
        lo = bpy.data.objects.new(NAME + "_Sun", ld)
        lo.rotation_euler = (0.8, 0.2, 0.6)
        sc.collection.objects.link(lo)

    tris = sum(len(f) - 2 for f in mb.faces) + FLAG_NX * FLAG_NY * 2
    print(f"[flag] pole verts={len(mb.verts)} tris={tris} height={POLE_H + TRUCK_H + 0.06 + BALL_R * 1.9:.2f} m "
          f"flag={FLAG_W:.2f}x{FLAG_H:.2f} m")

    if export:
        bpy.ops.object.select_all(action="DESELECT")
        pole.select_set(True)
        flag.select_set(True)
        bpy.context.view_layer.objects.active = pole
        props = {p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties}
        kw = dict(filepath=GAME_MODEL, export_format="GLB", use_selection=True, use_active_scene=True,
                  export_apply=True, export_yup=True, export_materials="EXPORT",
                  export_image_format="AUTO", export_animations=False)
        bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in props})
        print("[flag] exported", GAME_MODEL)
    return pole, flag
