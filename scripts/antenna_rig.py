"""Skinned antenna for the Sherman. Run inside Blender after bake_ao (it reuses the baked UVs), before
export_glb:

    import sys; sys.path.append('/Users/stellanjohansson/Cursor/Blender-Test01/scripts')
    import antenna_rig, importlib; importlib.reload(antenna_rig)
    antenna_rig.rig_antenna()

Splits the whip out of Turret_Details into its own mesh, slices it into rings so it can bend, and skins
it to a bone chain:
    Turret > Antenna_Rig (armature, origin at the whip base) > Antenna (mesh)
             bones Antenna_0 > Antenna_1 > Antenna_2 > Antenna_3, pointing up local +Z
The game bends the chain from the hull's acceleration (proto/src/tank.js).
"""
import bpy
import bmesh
from math import hypot, radians, floor
from mathutils import Vector
from sherman_lib import get_collection, geo_name

AXIS_XY = (0.20, 0.62)      # whip axis in Turret space (build_sherman.build_turret)
BONES = 4
RINGS_PER_BONE = 4


def _load(me):
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    return bm


def _whip_island(bm):
    """Indices of the whip's vertices: everything connected to the highest vertex on the antenna axis."""
    top = max((v for v in bm.verts if hypot(v.co.x - AXIS_XY[0], v.co.y - AXIS_XY[1]) < 0.02),
              key=lambda v: v.co.z)
    seen, stack = {top}, [top]
    while stack:
        v = stack.pop()
        for e in v.link_edges:
            o = e.other_vert(v)
            if o not in seen:
                seen.add(o)
                stack.append(o)
    return {v.index for v in seen}


def rig_antenna():
    if "Antenna_Rig" in bpy.data.objects:
        print("antenna already rigged")
        return bpy.data.objects["Antenna_Rig"]
    src = bpy.data.objects["Turret_Details"]
    tur = src.parent

    whip = _load(src.data)
    island = _whip_island(whip)
    bmesh.ops.delete(whip, geom=[v for v in whip.verts if v.index not in island], context='VERTS')
    rest = _load(src.data)
    bmesh.ops.delete(rest, geom=[rest.verts[i] for i in island], context='VERTS')
    rest.to_mesh(src.data)
    rest.free()

    z0 = min(v.co.z for v in whip.verts)
    length = max(v.co.z for v in whip.verts) - z0
    base = Vector((AXIS_XY[0], AXIS_XY[1], z0))
    bmesh.ops.translate(whip, verts=whip.verts[:], vec=-base)
    n = BONES * RINGS_PER_BONE
    for k in range(1, n):
        geom = whip.verts[:] + whip.edges[:] + whip.faces[:]
        bmesh.ops.bisect_plane(whip, geom=geom, plane_co=(0, 0, length * k / n), plane_no=(0, 0, 1))
    me = bpy.data.meshes.new(geo_name("Antenna"))
    whip.to_mesh(me)
    whip.free()
    if "custom_normal" in me.attributes:
        me.attributes.remove(me.attributes["custom_normal"])
    for m in src.data.materials:
        me.materials.append(m)
    me.shade_smooth()
    me.set_sharp_from_angle(angle=radians(30))

    rig = bpy.data.objects.new("Antenna_Rig", bpy.data.armatures.new("Antenna_Rig_data"))
    get_collection().objects.link(rig)
    rig.parent = tur
    rig.location = base
    rig.show_in_front = True
    seg = length / BONES
    vl = bpy.context.view_layer
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    vl.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    prev = None
    for i in range(BONES):
        b = rig.data.edit_bones.new(f"Antenna_{i}")
        b.head = (0, 0, seg * i)
        b.tail = (0, 0, seg * (i + 1))
        b.roll = 0.0
        b.parent = prev
        b.use_connect = prev is not None
        prev = b
    bpy.ops.object.mode_set(mode='OBJECT')
    rig.select_set(False)

    ob = bpy.data.objects.new("Antenna", me)
    get_collection().objects.link(ob)
    ob.parent = rig
    groups = [ob.vertex_groups.new(name=f"Antenna_{i}") for i in range(BONES)]
    # linear blend between neighbouring bone midpoints, so every joint bends smoothly
    for v in me.vertices:
        s = min(max(v.co.z / seg - 0.5, 0.0), BONES - 1.0)
        i = min(int(floor(s)), BONES - 2)
        f = s - i
        groups[i].add([v.index], 1.0 - f, 'REPLACE')
        groups[i + 1].add([v.index], f, 'REPLACE')
    ob.modifiers.new("Armature", 'ARMATURE').object = rig
    print(f"antenna: {len(me.vertices)} verts, {BONES} bones, length {length:.3f} m, base {tuple(base)}")
    return rig


def bend(deg=20.0):
    """Preview pose: deg > 0 leans the whip backwards (Turret -X), tip bending most. bend(0) = rest."""
    rig = bpy.data.objects["Antenna_Rig"]
    share = [0.1, 0.2, 0.3, 0.4]
    for i, pb in enumerate(rig.pose.bones):
        pb.rotation_mode = 'XYZ'
        # bone local Z is Turret -Y, so +Z rotation tips the bone towards -X
        pb.rotation_euler = (0.0, 0.0, radians(deg) * share[i])
