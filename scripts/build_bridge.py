"""Concrete road bridge -> proto/public/models/bridge.glb. Run inside Blender:

    import sys; sys.path.append('/Users/stellanjohansson/Cursor/Blender-Test01/scripts')
    import build_bridge, importlib; importlib.reload(build_bridge)
    build_bridge.build(export=True)

Rural slab bridge matching the creek-crossing reference: concrete deck + abutments
+ wing walls, galvanized 3-rail fence. Units are metres, Z up. Origin is the top
centre of the deck; +X is the span (main island → satellite), +Y is across.
Clear roadway is 5.0 m (≈ 1.5 Sherman widths).
"""
import math
import os

import bpy
import bmesh
from mathutils import Vector

ROOT = "/Users/stellanjohansson/Cursor/Blender-Test01"
GAME_MODEL = os.path.join(ROOT, "proto", "public", "models", "bridge.glb")
NAME = "Bridge"

# --- Dimensions (m) ---
SPAN = 25.0
CLEAR_W = 5.0          # inner face to inner face of the posts
POST_W = 0.12
POST_D = 0.12
DECK_T = 0.42
DECK_W = CLEAR_W + 2 * POST_W + 0.16
RAIL_H = 1.07
RAIL_T = 0.05
RAIL_W = 0.08
POST_SPACING = 2.5
APPROACH_POSTS = 1     # extra post past each abutment, like the photo
GIRDER_H = 0.55
GIRDER_W = 0.30
ABUT_T = 0.70          # along the span
ABUT_DROP = 1.45       # stem into the creek — short, the channel is shallow
WING_L = 2.20          # along the span, mostly landward of the deck end
WING_T = 0.46
WING_H = 1.10          # above deck, matches the photo end-block
WING_DROP = 0.12       # just under the deck so it sits on the bank, not a pier
RAMP_LEN = 2.0         # landward slope so a tank climbs the 20 cm lip
RAMP_DROP = 0.20
RAMP_T = 0.12
# AmbientCG Planks023B: boards run along U. Map U across the road (Y), V along the span (X).
PLANK_TILE = 2.0


class MeshBuilder:
    def __init__(self):
        self.verts, self.faces, self.uvs = [], [], []

    def v(self, p):
        self.verts.append(tuple(p))
        return len(self.verts) - 1

    def face(self, ids, uvs):
        self.faces.append(ids)
        self.uvs.append(uvs)

    def box(self, center, sx, sy, sz, tile=4.0):
        """Axis-aligned box. sx/sy/sz are full sizes. UVs in metres / tile."""
        cx, cy, cz = center
        hx, hy, hz = sx * 0.5, sy * 0.5, sz * 0.5
        # 8 corners: -x-y-z, +x-y-z, +x+y-z, -x+y-z, then +z
        c = [
            (cx - hx, cy - hy, cz - hz),
            (cx + hx, cy - hy, cz - hz),
            (cx + hx, cy + hy, cz - hz),
            (cx - hx, cy + hy, cz - hz),
            (cx - hx, cy - hy, cz + hz),
            (cx + hx, cy - hy, cz + hz),
            (cx + hx, cy + hy, cz + hz),
            (cx - hx, cy + hy, cz + hz),
        ]
        ids = [self.v(p) for p in c]
        # (corners, u_axis_size, v_axis_size)
        faces = [
            ([0, 1, 5, 4], sx, sz),  # -Y
            ([2, 3, 7, 6], sx, sz),  # +Y
            ([3, 0, 4, 7], sy, sz),  # -X
            ([1, 2, 6, 5], sy, sz),  # +X
            ([3, 2, 1, 0], sx, sy),  # -Z
            ([4, 5, 6, 7], sx, sy),  # +Z
        ]
        for corners, uu, vv in faces:
            self.face(
                [ids[i] for i in corners],
                [(0, 0), (uu / tile, 0), (uu / tile, vv / tile), (0, vv / tile)],
            )

    def sloped_slab(self, x0, x1, hy, z0, z1, thick, tile=4.0):
        """Thin slab from x0 (top z0) to x1 (top z1). Width 2*hy, thickness down."""
        y0, y1 = -hy, hy
        b0, b1 = z0 - thick, z1 - thick
        c = [
            (x0, y0, b0), (x1, y0, b1), (x1, y1, b1), (x0, y1, b0),
            (x0, y0, z0), (x1, y0, z1), (x1, y1, z1), (x0, y1, z0),
        ]
        ids = [self.v(p) for p in c]
        slen = math.hypot(x1 - x0, z1 - z0)
        sy = 2 * hy
        faces = [
            ([0, 1, 5, 4], slen, thick),
            ([2, 3, 7, 6], slen, thick),
            ([3, 0, 4, 7], sy, thick),
            ([1, 2, 6, 5], sy, thick),
            ([3, 2, 1, 0], slen, sy),
            ([4, 5, 6, 7], slen, sy),
        ]
        for corners, uu, vv in faces:
            self.face(
                [ids[i] for i in corners],
                [(0, 0), (uu / tile, 0), (uu / tile, vv / tile), (0, vv / tile)],
            )

    def face_plank(self, ids, tile):
        # Texture boards run along U. U = across (Y), V = along the span (X).
        self.face(ids, [(self.verts[i][1] / tile, self.verts[i][0] / tile) for i in ids])

    def box_plank(self, center, sx, sy, sz, tile=PLANK_TILE):
        cx, cy, cz = center
        hx, hy, hz = sx * 0.5, sy * 0.5, sz * 0.5
        c = [
            (cx - hx, cy - hy, cz - hz),
            (cx + hx, cy - hy, cz - hz),
            (cx + hx, cy + hy, cz - hz),
            (cx - hx, cy + hy, cz - hz),
            (cx - hx, cy - hy, cz + hz),
            (cx + hx, cy - hy, cz + hz),
            (cx + hx, cy + hy, cz + hz),
            (cx - hx, cy + hy, cz + hz),
        ]
        ids = [self.v(p) for p in c]
        for corners in ([0, 1, 5, 4], [2, 3, 7, 6], [3, 0, 4, 7], [1, 2, 6, 5], [3, 2, 1, 0], [4, 5, 6, 7]):
            self.face_plank([ids[i] for i in corners], tile)

    def sloped_slab_plank(self, x0, x1, hy, z0, z1, thick, tile=PLANK_TILE):
        y0, y1 = -hy, hy
        b0, b1 = z0 - thick, z1 - thick
        c = [
            (x0, y0, b0), (x1, y0, b1), (x1, y1, b1), (x0, y1, b0),
            (x0, y0, z0), (x1, y0, z1), (x1, y1, z1), (x0, y1, z0),
        ]
        ids = [self.v(p) for p in c]
        for corners in ([0, 1, 5, 4], [2, 3, 7, 6], [3, 0, 4, 7], [1, 2, 6, 5], [3, 2, 1, 0], [4, 5, 6, 7]):
            self.face_plank([ids[i] for i in corners], tile)


def build_deck():
    """Driving surface only — plank UVs, boards run across the road."""
    mb = MeshBuilder()
    mb.box_plank((0, 0, -DECK_T * 0.5), SPAN, DECK_W, DECK_T)
    half = SPAN * 0.5
    hy = DECK_W * 0.5
    mb.sloped_slab_plank(-half, -half - RAMP_LEN, hy, 0.0, -RAMP_DROP, RAMP_T)
    mb.sloped_slab_plank(half, half + RAMP_LEN, hy, 0.0, -RAMP_DROP, RAMP_T)
    return mb


def build_concrete():
    mb = MeshBuilder()
    # Edge girders under the long sides (reads as a real span, not a pancake)
    gy = DECK_W * 0.5 - GIRDER_W * 0.5 - 0.04
    gz = -DECK_T - GIRDER_H * 0.5
    for s in (-1, 1):
        mb.box((0, s * gy, gz), SPAN - 0.3, GIRDER_W, GIRDER_H, tile=4.0)

    # Abutment stems under each deck end (narrower than the deck so the creek reads)
    for sx in (-1, 1):
        mx = sx * (SPAN * 0.5 - ABUT_T * 0.5)
        mb.box((mx, 0, -DECK_T - ABUT_DROP * 0.5), ABUT_T, DECK_W - 0.15, ABUT_DROP, tile=4.0)

    # Wing walls — the photo's concrete end-blocks, one each corner, sitting on the bank
    for sx in (-1, 1):
        for sy in (-1, 1):
            wx = sx * (SPAN * 0.5 + WING_L * 0.5 - 0.45)
            wy = sy * (DECK_W * 0.5 + WING_T * 0.5 + 0.04)
            top = WING_H
            bot = -WING_DROP
            mb.box((wx, wy, (top + bot) * 0.5), WING_L, WING_T, top - bot, tile=4.0)
            # small top cap so the block isn't a perfect slab
            mb.box((wx, wy, top + 0.04), WING_L + 0.04, WING_T + 0.04, 0.08, tile=4.0)
    return mb


def build_steel():
    mb = MeshBuilder()
    n_span = int(round(SPAN / POST_SPACING))
    xs = [(-SPAN * 0.5) + i * (SPAN / n_span) for i in range(n_span + 1)]
    extra = POST_SPACING * 0.85
    xs = [-SPAN * 0.5 - extra] * APPROACH_POSTS + xs + [SPAN * 0.5 + extra] * APPROACH_POSTS
    y_post = CLEAR_W * 0.5 + POST_W * 0.5
    rail_ys = (0.18, RAIL_H * 0.55, RAIL_H - RAIL_T * 0.5)

    for sy in (-1, 1):
        py = sy * y_post
        posts = []
        for x in xs:
            mb.box((x, py, RAIL_H * 0.5), POST_D, POST_W, RAIL_H, tile=1.5)
            posts.append(x)
        # three horizontal rails between the first and last post
        x0, x1 = posts[0], posts[-1]
        length = x1 - x0
        mid = (x0 + x1) * 0.5
        for z in rail_ys:
            mb.box((mid, py, z), length + POST_D, RAIL_W, RAIL_T, tile=1.5)
    return mb


def _to_mesh(name, mb):
    old = bpy.data.meshes.get(name)
    if old:
        bpy.data.meshes.remove(old)
    me = bpy.data.meshes.new(name)
    me.from_pydata(mb.verts, [], mb.faces)
    uv = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        for j, li in enumerate(poly.loop_indices):
            uv.data[li].uv = mb.uvs[poly.index][j]
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # merge the shared box corners so it's one solid per part
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bm.to_mesh(me)
    bm.free()
    me.update()
    return me


def _principled(mat):
    return next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")


def make_concrete_mat():
    old = bpy.data.materials.get("BridgeConcrete")
    if old:
        bpy.data.materials.remove(old)
    mat = bpy.data.materials.new("BridgeConcrete")
    mat.use_nodes = True
    bsdf = _principled(mat)
    bsdf.inputs["Base Color"].default_value = (0.72, 0.70, 0.64, 1)
    bsdf.inputs["Roughness"].default_value = 0.92
    bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def make_plank_mat():
    old = bpy.data.materials.get("BridgeDeck")
    if old:
        bpy.data.materials.remove(old)
    mat = bpy.data.materials.new("BridgeDeck")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = _principled(mat)
    tex = nt.nodes.new("ShaderNodeTexImage")
    img_path = os.path.join(ROOT, "proto", "public", "textures", "planks", "color.jpg")
    old_img = bpy.data.images.get("planks_color")
    if old_img:
        bpy.data.images.remove(old_img)
    tex.image = bpy.data.images.load(img_path)
    tex.image.name = "planks_color"
    tex.location = (-400, 300)
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.85
    bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def make_steel_mat():
    old = bpy.data.materials.get("BridgeSteel")
    if old:
        bpy.data.materials.remove(old)
    mat = bpy.data.materials.new("BridgeSteel")
    mat.use_nodes = True
    bsdf = _principled(mat)
    # galvanized: pale, slightly metallic
    bsdf.inputs["Base Color"].default_value = (0.62, 0.64, 0.66, 1)
    bsdf.inputs["Roughness"].default_value = 0.38
    bsdf.inputs["Metallic"].default_value = 0.85
    return mat


def _scene():
    sc = bpy.data.scenes.get(NAME) or bpy.data.scenes.new(NAME)
    bpy.context.window.scene = sc
    for o in list(sc.collection.all_objects):
        bpy.data.objects.remove(o, do_unlink=True)
    sc.unit_settings.system = "METRIC"
    sc.unit_settings.length_unit = "METERS"
    return sc


def _look_at(cam, target):
    direction = Vector(target) - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def build(export=False):
    sc = _scene()
    concrete = make_concrete_mat()
    planks = make_plank_mat()
    steel = make_steel_mat()

    root = bpy.data.objects.new(NAME, None)
    sc.collection.objects.link(root)

    road_me = _to_mesh("BridgeDeck", build_deck())
    road_me.materials.append(planks)
    road = bpy.data.objects.new("BridgeDeck", road_me)
    sc.collection.objects.link(road)
    road.parent = root

    conc_me = _to_mesh("BridgeConcrete", build_concrete())
    conc_me.materials.append(concrete)
    conc = bpy.data.objects.new("BridgeConcrete", conc_me)
    sc.collection.objects.link(conc)
    conc.parent = root

    rail_me = _to_mesh("BridgeSteel", build_steel())
    rail_me.materials.append(steel)
    rails = bpy.data.objects.new("BridgeSteel", rail_me)
    sc.collection.objects.link(rails)
    rails.parent = root

    # Preview lighting + a camera so look() has a useful view
    if not any(o.type == "LIGHT" for o in sc.objects):
        ld = bpy.data.lights.new(NAME + "_Sun", "SUN")
        ld.energy = 4.0
        lo = bpy.data.objects.new(NAME + "_Sun", ld)
        lo.rotation_euler = (0.95, 0.15, 0.85)
        sc.collection.objects.link(lo)
    cam_data = bpy.data.cameras.new(NAME + "_Cam")
    cam_data.lens = 35
    cam = bpy.data.objects.new(NAME + "_Cam", cam_data)
    cam.location = (14.0, -16.0, 5.5)
    _look_at(cam, (0.0, 0.0, 0.4))
    sc.collection.objects.link(cam)
    sc.camera = cam

    # World backdrop: pale overcast so the galvanized rails read
    world = sc.world or bpy.data.worlds.new(NAME + "World")
    sc.world = world
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (0.62, 0.70, 0.66, 1)
    bg.inputs["Strength"].default_value = 0.85

    tris = (
        sum(len(p.vertices) - 2 for p in road_me.polygons)
        + sum(len(p.vertices) - 2 for p in conc_me.polygons)
        + sum(len(p.vertices) - 2 for p in rail_me.polygons)
    )
    print(
        f"[bridge] deck {SPAN:.1f}×{DECK_W:.2f} m  clear={CLEAR_W:.1f} m  "
        f"rails={RAIL_H:.2f} m  tris={tris}"
    )

    if export:
        bpy.ops.object.select_all(action="DESELECT")
        road.select_set(True)
        conc.select_set(True)
        rails.select_set(True)
        root.select_set(True)
        bpy.context.view_layer.objects.active = root
        props = {p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties}
        os.makedirs(os.path.dirname(GAME_MODEL), exist_ok=True)
        kw = dict(
            filepath=GAME_MODEL,
            export_format="GLB",
            use_selection=True,
            use_active_scene=True,
            export_apply=True,
            export_yup=True,
            export_materials="EXPORT",
            export_animations=False,
        )
        bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in props})
        print("[bridge] exported", GAME_MODEL)
    return root, tris
