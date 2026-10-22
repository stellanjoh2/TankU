"""Runtime helpers for the Sherman rig (also the reference for the three.js port).

Track_<side>['path_xz'] holds the closed track loop as (x0, z0, x1, z1, ...) in the group's local
X/Z plane (counter-clockwise seen from +Y); each TrackLink's 'track_s' is its rest arc length.
Driving forward by d metres: link at track_s - d along the loop, wheel angle about Y = d / spin_radius.
"""
import bpy
from math import atan2, radians
from mathutils import Vector


def loop_segments(poly):
    segs, L = [], 0.0
    for i in range(len(poly)):
        a, b = Vector(poly[i]), Vector(poly[(i + 1) % len(poly)])
        segs.append((L, a, b))
        L += (b - a).length
    return segs, L


def point_on_loop(segs, L, d):
    """Position and unit tangent at arc length d (wraps)."""
    d %= L
    lo, hi = 0, len(segs) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if segs[mid][0] <= d:
            lo = mid
        else:
            hi = mid - 1
    s0, a, b = segs[lo]
    t = (b - a).normalized()
    return a + t * (d - s0), t


def place_link(ob, segs, L, d):
    p, t = point_on_loop(segs, L, d)
    ob.location = (p.x, 0.0, p.y)
    ob.rotation_euler = (0.0, atan2(-t.y, t.x), 0.0)


def drive(distance, side=None):
    """Move the running gear as if the tank drove `distance` metres forward (per side for turning)."""
    for sd in ((side,) if side else ("L", "R")):
        tg = bpy.data.objects[f"Track_{sd}"]
        flat = list(tg["path_xz"])
        segs, L = loop_segments([(flat[i], flat[i + 1]) for i in range(0, len(flat), 2)])
        for ob in tg.children:
            place_link(ob, segs, L, ob["track_s"] - distance)
        for ob in bpy.data.objects[f"Wheels_{sd}"].children:
            ob.rotation_euler = (0.0, distance / ob["spin_radius"], 0.0)


def _fcurves(ob):
    """Fresh action on ob; returns its channelbag's fcurve collection (Blender 4.4+ slotted actions)."""
    from bpy_extras import anim_utils
    ad = ob.animation_data_create()
    if ad.action:
        bpy.data.actions.remove(ad.action)
    act = bpy.data.actions.new(f"Loop_{ob.name}")
    ad.action = act
    if ad.action_slot is None:
        ad.action_slot = act.slots.new(id_type='OBJECT', name=ob.name)
    return anim_utils.action_ensure_channelbag_for_slot(act, ad.action_slot).fcurves


def _key(fcurves, path, index, frames, values):
    fc = fcurves.new(path, index=index)
    fc.keyframe_points.add(len(frames))
    co = [c for fv in zip(frames, values) for c in fv]
    fc.keyframe_points.foreach_set("co", co)
    fc.keyframe_points.foreach_set("interpolation", [1] * len(frames))  # LINEAR
    fc.update()


def animate_loop(seconds=10, fps=30, laps=2, scan_deg=70.0, gun_deg=3.0):
    """Seamless test loop: constant forward drive (tracks travel `laps` full loops, every wheel spins
    whole turns) while the turret sweeps +-scan_deg. Frame 0 == frame seconds*fps."""
    from math import cos, sin, tau
    sc = bpy.context.scene
    for act in [a for a in bpy.data.actions if a.name.startswith("Loop_") and a.users == 0]:
        bpy.data.actions.remove(act)
    n = seconds * fps
    sc.render.fps = fps
    sc.frame_start, sc.frame_end = 0, n
    frames = list(range(n + 1))

    for sd in ("L", "R"):
        tg = bpy.data.objects[f"Track_{sd}"]
        flat = list(tg["path_xz"])
        segs, L = loop_segments([(flat[i], flat[i + 1]) for i in range(0, len(flat), 2)])
        dist = laps * L
        for ob in tg.children:
            xs, zs, ry, prev = [], [], [], None
            for f in frames:
                p, t = point_on_loop(segs, L, ob["track_s"] - dist * f / n)
                a = atan2(-t.y, t.x)
                if prev is not None:
                    a += round((prev - a) / tau) * tau
                xs.append(p.x); zs.append(p.y); ry.append(a); prev = a
            fcs = _fcurves(ob)
            _key(fcs, "location", 0, frames, xs)
            _key(fcs, "location", 1, frames, [0.0] * len(frames))
            _key(fcs, "location", 2, frames, zs)
            for i, v in ((0, 0.0), (1, None), (2, 0.0)):
                _key(fcs, "rotation_euler", i, frames, ry if v is None else [v] * len(frames))
        for ob in bpy.data.objects[f"Wheels_{sd}"].children:
            turns = max(1, round(dist / (tau * ob["spin_radius"])))
            fcs = _fcurves(ob)
            _key(fcs, "rotation_euler", 1, [0, n], [0.0, turns * tau])

    tur = bpy.data.objects["Turret"]
    _key(_fcurves(tur), "rotation_euler", 2, frames,
         [radians(scan_deg) * sin(tau * f / n) for f in frames])
    gun = bpy.data.objects["Gun_Mount"]
    _key(_fcurves(gun), "rotation_euler", 1, frames,
         [-radians(gun_deg) * (0.5 - 0.5 * cos(2 * tau * f / n)) for f in frames])
    sc.frame_set(0)
    print(f"loop: {n} frames, track travel {dist:.2f} m/side")


def pose(drive_m=0.0, turret_deg=0.0, gun_deg=0.0, recoil=0.0, mg_deg=0.0, mg_elev_deg=0.0):
    """Set the whole rig. recoil is 0..1 of the barrel's recoil_distance. gun_deg > 0 raises the gun."""
    drive(drive_m)
    bpy.data.objects["Turret"].rotation_euler.z = radians(turret_deg)
    bpy.data.objects["Gun_Mount"].rotation_euler.y = -radians(gun_deg)
    barrel = bpy.data.objects["Gun_Barrel"]
    barrel.location.x = -recoil * barrel["recoil_distance"]
    bpy.data.objects["MG50_Mount"].rotation_euler.z = radians(180 + mg_deg)
    bpy.data.objects["MG50_Elevation"].rotation_euler.y = -radians(mg_elev_deg)
