"""Build the stylized Sherman. Run inside Blender:
exec(open('/Users/stellanjohansson/Cursor/Blender-Test01/scripts/build_sherman.py').read())

Axes: +X = front, +Z = up, +Y = tank's left side. Units: metres.
"""
import sys
import importlib

SCRIPT_DIR = "/Users/stellanjohansson/Cursor/Blender-Test01/scripts"
if SCRIPT_DIR not in sys.path:
    sys.path.append(SCRIPT_DIR)
import sherman_lib
import sherman_rig
importlib.reload(sherman_lib)
importlib.reload(sherman_rig)
from sherman_lib import *  # noqa: F401,F403
from sherman_rig import loop_segments, place_link

# ---------------------------------------------------------------- layout
TRACK_Y = 1.35           # track centre line, each side
TRACK_W = 0.54
SPROCKET = (2.18, 0.80, 0.36)   # x, z, tooth tip radius
IDLER = (-2.44, 0.83, 0.33)
WHEEL_Z = 0.42
WHEEL_R = 0.335
WHEEL_X = (1.605, 0.867, 0.032, -0.77, -1.67)
ROLLER_Z = 1.05
ROLLER_R = 0.10
ROLLER_X = (1.38, -0.32, -1.83)
BRACKET_X = (0.45, -1.22)
LINK_T = 0.07
LINK_PITCH = 0.15

REAR_SLOPE_X = -1.55     # engine deck and fender tops start falling toward the rear here
REAR_SLOPE_K = 0.10      # drop per metre (~6 degrees)
REAR_SLOPE = atan2(REAR_SLOPE_K, 1.0)


def deck_z(x):
    return DECK_Z - max(0.0, REAR_SLOPE_X - x) * REAR_SLOPE_K


TURRET_ORIGIN = (-0.16, 0.0, 1.93)
ROOF = 0.88              # turret roof height above the turret origin
DECK_Z = 1.93


# ---------------------------------------------------------------- hull
def build_hull(root):
    parts = [Builder() for _ in range(4)]
    # centre: engine deck falls gently, then a sloped upper rear plate creasing into a steeper lower one
    parts[0].prism_xz([(2.85, 1.25), (2.85, 1.45), (1.80, DECK_Z), (REAR_SLOPE_X, DECK_Z),
                       (-2.45, deck_z(-2.45)), (-2.76, 1.46), (-2.86, 1.25)], -0.85, 0.85)
    parts[1].prism_xz([(2.80, 1.27), (2.45, 0.55), (-2.60, 0.55), (-2.92, 0.95), (-2.92, 1.27)],
                      -1.05, 1.05)
    # sponsons: fender tops follow the same fall, ending in a flap plate that leans back at the top
    spon = [(2.95, 1.25), (2.95, 1.52), (1.95, 1.56), (1.55, DECK_Z), (REAR_SLOPE_X, DECK_Z),
            (-2.85, deck_z(-2.85)), (-2.96, deck_z(-2.85) - 0.07), (-2.88, 1.30), (-2.88, 1.25)]
    for b, s in zip(parts[2:], (1, -1)):
        b.prism_xz(spon, s * 0.85, s * 1.65)
    return union(parts).finish("Hull_Body", root, bevel=(0.04, 3))


# ---------------------------------------------------------------- running gear
def wheel_profile(s):
    p = [(0.0, -0.21), (0.27, -0.23, "rubber"), (WHEEL_R, -0.215, "rubber"), (WHEEL_R, -0.045, "rubber"),
         (0.26, -0.03), (0.25, 0.0),
         (0.26, 0.03, "rubber"), (WHEEL_R, 0.045, "rubber"), (WHEEL_R, 0.215, "rubber"),
         (0.27, 0.23), (0.25, 0.215), (0.13, 0.20), (0.11, 0.235), (0.065, 0.255), (0.0, 0.255)]
    return [(q[0], q[1] * s) + tuple(q[2:]) for q in p]


def gear_wheel(b, s, r_tip, teeth):
    """Toothed wheel (sprocket / idler) built around the local origin, axle along Y."""
    M = AX_Y
    prof = gear_profile(teeth, r_tip - 0.06, r_tip)
    for off in (-0.13, 0.13):
        z0 = off * s - 0.035
        b.prism(prof, z0, z0 + 0.07, M)
    b.lathe([(0.0, -0.17 * s), (0.22, -0.17 * s), (0.24, -0.10 * s), (0.24, 0.10 * s),
             (0.20, 0.17 * s), (0.11, 0.19 * s), (0.08, 0.25 * s), (0.0, 0.25 * s)], 24, M)
    for k in range(6):
        a = 2 * pi * k / 6
        b.cyl((0, 0, 0), (0, 0, 1), 0.018, 0.03, "metal", segs=6,
              M=M @ T(0.15 * cos(a), 0.15 * sin(a), 0.175 * s))


def spinner(ob, radius):
    """Tag a wheel for the game: spins about its local Y; angular speed = track speed / radius."""
    ob["spin_axis"] = "Y"
    ob["spin_radius"] = radius
    return ob


def build_running_gear(root, hull):
    """Per side: RunningGear_<side> > Wheels_<side> (one pivot per wheel) + Track_<side>.
    Suspension brackets are static and live under the hull."""
    groups = {}
    for s, side in ((1, "L"), (-1, "R")):
        yc = s * TRACK_Y
        rg = make_empty(f"RunningGear_{side}", root)
        wg = make_empty(f"Wheels_{side}", rg)
        groups[side] = rg

        w = Builder()
        w.lathe(wheel_profile(s), 24, AX_Y)
        w.cyl((0, 0, 0.26 * s), (0, 0, 1), 0.045, 0.04, "metal", segs=6, M=AX_Y)
        for k in range(5):  # odd bolt count keeps the spin readable at speed
            a = 2 * pi * k / 5
            w.cyl((0.17 * cos(a), 0.17 * sin(a), 0.215 * s), (0, 0, 1), 0.02, 0.03, "metal",
                  segs=6, M=AX_Y)
        first = w.finish(f"RoadWheel_{side}_0", wg, loc=(WHEEL_X[0], yc, WHEEL_Z))
        first.data.name = geo_name(f"RoadWheel_{side}")
        spinner(first, WHEEL_R)
        for i, x in enumerate(WHEEL_X[1:], 1):
            spinner(instance(f"RoadWheel_{side}_{i}", first.data, wg, (x, yc, WHEEL_Z)), WHEEL_R)

        r = Builder()
        r.lathe([(0, -0.075 * s), (0.085, -0.075 * s), (ROLLER_R, -0.06 * s, "rubber"),
                 (ROLLER_R, 0.06 * s, "rubber"), (0.085, 0.075 * s), (0.04, 0.09 * s),
                 (0, 0.09 * s)], 16, AX_Y)
        for k in range(3):  # 3-fold, so ~44 deg/frame at cruise still reads as forward spin
            a = 2 * pi * k / 3
            r.cyl((0.055 * cos(a), 0.055 * sin(a), 0.085 * s), (0, 0, 1), 0.014, 0.025, "metal",
                  segs=6, M=AX_Y)
        first = r.finish(f"ReturnRoller_{side}_0", wg, loc=(ROLLER_X[0], yc, ROLLER_Z))
        first.data.name = geo_name(f"ReturnRoller_{side}")
        spinner(first, ROLLER_R)
        for i, x in enumerate(ROLLER_X[1:], 1):
            spinner(instance(f"ReturnRoller_{side}_{i}", first.data, wg, (x, yc, ROLLER_Z)), ROLLER_R)

        for name, (x, z, r_tip), teeth in (("Sprocket", SPROCKET, 13), ("Idler", IDLER, 12)):
            g = Builder()
            gear_wheel(g, s, r_tip, teeth)
            spinner(g.finish(f"{name}_{side}", wg, loc=(x, yc, z)), r_tip - 0.03 + LINK_T / 2)

        b = Builder()
        y_in, y_out = s * 1.04, s * 1.66
        for bx in BRACKET_X:
            b.box((bx, (y_in + y_out) / 2, 1.02), (0.46, abs(y_out - y_in), 0.15))
            plate = [(bx - 0.23, 1.00), (bx + 0.23, 1.00), (bx + 0.24, 0.90), (bx + 0.13, 0.50),
                     (bx - 0.13, 0.50), (bx - 0.24, 0.90)]
            b.prism_xz(plate, s * 1.62, s * 1.70)
            b.box((bx, s * 1.72, 0.78), (0.14, 0.05, 0.30))
            b.cyl((bx, s * 1.68, 0.58), (0, 1, 0), 0.07, 0.12, segs=16)
            for dx, dz in ((-0.17, 0.93), (0.17, 0.93), (-0.10, 0.60), (0.10, 0.60)):
                b.cyl((bx + dx, s * 1.705, dz), (0, 1, 0), 0.018, 0.02, "metal", segs=6)
            # arms out to neighbouring wheel hubs
            for wx in WHEEL_X:
                if 0.2 < abs(wx - bx) < 0.9:
                    p0 = Vector((bx, s * 1.67, 0.60))
                    p1 = Vector((wx, s * 1.67, WHEEL_Z))
                    d = p1 - p0
                    ang = atan2(d.z, d.x)
                    b.box((p0 + p1) / 2, (d.length, 0.06, 0.08), R=Euler((0, -ang, 0)))
        # return roller brackets
        for rx in ROLLER_X:
            b.box((rx, s * 1.15, ROLLER_Z), (0.10, 0.24, 0.14))
        b.finish(f"Suspension_{side}", hull, bevel=(0.015, 2))
    return groups


# ---------------------------------------------------------------- tracks
def track_loop():
    rc = LINK_T / 2
    circles = [(SPROCKET[0], SPROCKET[1], SPROCKET[2] - 0.03 + rc),
               (IDLER[0], IDLER[1], IDLER[2] - 0.03 + rc)]
    circles += [(x, WHEEL_Z, WHEEL_R + rc) for x in WHEEL_X]
    circles += [(x, ROLLER_Z, ROLLER_R + rc) for x in ROLLER_X]
    pts = []
    for cx, cz, r in circles:
        for k in range(96):
            a = 2 * pi * k / 96
            pts.append((round(cx + r * cos(a), 5), round(cz + r * sin(a), 5)))
    return convex_hull(pts)


def track_link_mesh():
    """One link around its own origin: X along the track, Y across, -Z = ground side (outward)."""
    h = LINK_T / 2
    pad = [(-0.065, h), (0.065, h), (0.065, -h + 0.015), (0.045, -h), (-0.045, -h), (-0.065, -h + 0.015)]
    b = Builder()
    for y0, y1 in ((0.03, TRACK_W / 2), (-TRACK_W / 2, -0.03)):
        b.prism([(x, -z) for x, z in pad], y0, y1, AX_Y, "track")
    b.cube(T(0, 0, h + 0.025) @ Matrix.Diagonal((0.07, 0.05, 0.06, 1)), "track")
    for ye in (TRACK_W / 2 + 0.012, -TRACK_W / 2 - 0.012):
        b.cube(T(0.075, ye, 0) @ Matrix.Diagonal((0.05, 0.03, 0.045, 1)), "track")
    ob = b.finish("_TrackLink_template", None, smooth_angle=40)
    me = ob.data
    me.name = geo_name("TrackLink")
    bpy.data.objects.remove(ob, do_unlink=True)
    return me


def build_tracks(groups):
    """Track_<side> holds every link as its own object (all sharing one mesh).
    Game data: Track_<side>['path_xz'] is the closed loop (x0, z0, x1, z1, ...) in the group's
    local X/Z plane, 'length' its arc length; each link's 'track_s' is its rest position along it.
    Driving forward by distance d puts a link at track_s - d (see sherman_rig.drive())."""
    poly = track_loop()
    segs, L = loop_segments(poly)
    n = round(L / LINK_PITCH)
    step = L / n
    me = track_link_mesh()
    for s, side in ((1, "L"), (-1, "R")):
        tg = make_empty(f"Track_{side}", groups[side], (0, s * TRACK_Y, 0))
        tg["path_xz"] = [c for p in poly for c in p]
        tg["length"] = L
        tg["link_count"] = n
        tg["link_pitch"] = step
        for k in range(n):
            ob = instance(f"TrackLink_{side}_{k:03d}", me, tg)
            ob["track_s"] = k * step
            place_link(ob, segs, L, k * step)
    return n


# ---------------------------------------------------------------- shared props
def crate(b, c, size, R=None, wood=True, strap_axis=0):
    """Stowage box: body, lid lip, two straps/latches. size = (x, y, z) in the box's local frame."""
    sx, sy, sz = size
    Rm = Matrix.Identity(4) if R is None else (R.to_matrix() if isinstance(R, Euler) else R).to_4x4()
    M = T(c) @ Rm
    body = "wood" if wood else "paint"
    b.cube(M @ Matrix.Diagonal((sx, sy, sz, 1)), body)
    b.cube(M @ T(0, 0, sz * 0.5 - 0.03) @ Matrix.Diagonal((sx + 0.02, sy + 0.02, 0.05, 1)), body)
    strap = "metal" if wood else "paint"
    for f in (-0.28, 0.28):
        if strap_axis == 0:
            m = T(f * sx, 0, 0) @ Matrix.Diagonal((0.035, sy + 0.025, sz + 0.012, 1))
        else:
            m = T(0, f * sy, 0) @ Matrix.Diagonal((sx + 0.025, 0.035, sz + 0.012, 1))
        b.cube(M @ m, strap)


def lamp(b, c, facing, glass):
    """Head/tail light: bracket, housing, lens and a horseshoe guard. facing = +1 (front) / -1 (rear)."""
    x, y, z = c
    b.box((x, y, z - 0.07), (0.10, 0.10, 0.06))
    b.cyl((x, y, z), (facing, 0, 0), 0.085, 0.16, segs=16)
    b.cyl((x + facing * 0.082, y, z), (facing, 0, 0), 0.068, 0.012, glass, segs=16)
    M = T(x + facing * 0.03, y, z) @ AX_X
    b.torus(0.13, 0.014, M, "paint", maj=10, mnr=6, arc=pi, a0=0)
    for sy in (-1, 1):
        b.box((x + facing * 0.03, y + sy * 0.13, z - 0.06), (0.03, 0.03, 0.12))


def shackle(b, c, facing, k=1.7):
    """Tow clevis: base plate + two lugs on the hull, a pin across them and a U-shackle hanging off it.
    c is a point on the hull plate surface; facing = +1 (front) / -1 (rear); k scales the whole part."""
    x, y, z = c
    px = x + facing * 0.09 * k                   # pin axis, out from the plate
    b.box((x, y, z), (0.06 * k, 0.22 * k, 0.16 * k))
    for sy in (-1, 1):
        b.box((x + facing * 0.06 * k, y + sy * 0.075 * k, z), (0.12 * k, 0.035 * k, 0.12 * k))
    b.cyl((px, y, z), (0, 1, 0), 0.022 * k, 0.20 * k, segs=8)
    for sy in (-1, 1):
        b.cyl((px, y + sy * 0.105 * k, z), (0, 1, 0), 0.034 * k, 0.025 * k, segs=8)
    # U-shackle in the YZ plane: eyes on the pin, legs down, round bottom
    leg_y, leg_top, leg_bot, r = 0.045 * k, z - 0.02 * k, z - 0.11 * k, 0.019 * k
    for sy in (-1, 1):
        b.cyl((px, y + sy * leg_y, z), (0, 1, 0), 0.034 * k, 0.03 * k, segs=8)
        b.cyl((px, y + sy * leg_y, (leg_top + leg_bot) / 2), (0, 0, 1), r, leg_top - leg_bot, segs=8)
    b.torus(leg_y, r, T(px, y, leg_bot) @ AX_X, "paint", maj=8, mnr=6, arc=pi, a0=-pi / 2)


def tool(b, x0, x1, y, z, head=None):
    """Wooden-handled pioneer tool lying along X with metal end fittings and clamps."""
    xm, L = (x0 + x1) / 2, abs(x1 - x0)
    b.cyl((xm, y, z), (1, 0, 0), 0.035, L, "wood", segs=8)
    for xe in (x0, x1):
        b.cyl((xe, y, z), (1, 0, 0), 0.042, 0.10, "metal", segs=8)
    for xc in (x0 + 0.25 * (x1 - x0), x0 + 0.75 * (x1 - x0)):
        b.box((xc, y, z), (0.05, 0.10, 0.10), "metal")
    if head is not None:
        b.box((x1 + head / 2 * (1 if x1 > x0 else -1), y, z), (head, 0.05, 0.20), "metal")


# ---------------------------------------------------------------- hull details
def build_hull_details(root):
    b = Builder()
    gz = lambda x: DECK_Z - (x - 1.80) * (DECK_Z - 1.45) / (2.85 - 1.80)  # glacis surface height
    slope = atan2(DECK_Z - 1.45, 2.85 - 1.80)

    # glacis crate (wood planks along X, two straps across)
    cx = 2.12
    Rg = Euler((0, slope, 0))
    up = Vector((sin(slope), 0, cos(slope)))
    base = Vector((cx, 0, gz(cx))) + up * 0.10
    for i in range(5):
        y = -0.48 + i * 0.24
        b.box(base + Vector((0, y, 0)), (0.52, 0.22, 0.18), "wood", R=Rg)
    for fx in (-0.15, 0.15):
        d = Vector((cos(slope), 0, -sin(slope))) * fx
        b.box(base + d + up * 0.005, (0.04, 1.24, 0.19), "metal", R=Rg)

    # hatches on the front deck, fuel caps on the sponsons
    for s in (1, -1):
        b.cyl((1.35, s * 0.52, DECK_Z + 0.025), (0, 0, 1), 0.24, 0.05, segs=24)
        b.cyl((1.35, s * 0.52, DECK_Z + 0.06), (0, 0, 1), 0.16, 0.03, segs=24)
        b.box((1.35, s * 0.52 + s * 0.24, DECK_Z + 0.05), (0.16, 0.06, 0.06))
        b.cyl((-1.1, s * 1.28, DECK_Z + 0.03), (0, 0, 1), 0.10, 0.06, segs=12)
        b.cyl((-1.1, s * 1.28, DECK_Z + 0.07), (0, 0, 1), 0.05, 0.04, segs=8)

    # engine deck (sloped): grille frame + slats, access plate on the flat part
    Rs = Euler((0, -REAR_SLOPE, 0))
    gx0, gx1 = -1.72, -2.32
    gxm = (gx0 + gx1) / 2
    b.box((gxm, 0, deck_z(gxm) + 0.02), (abs(gx1 - gx0) + 0.08, 1.48, 0.04), R=Rs)
    with b.plain():
        for i in range(11):
            x = gx0 - 0.03 - i * (abs(gx1 - gx0) - 0.06) / 10
            b.box((x, 0, deck_z(x) + 0.065), (0.025, 1.36, 0.05), "metal", R=Rs)
    for s in (1, -1):
        b.box((gxm, s * 0.70, deck_z(gxm) + 0.065), (abs(gx1 - gx0) + 0.04, 0.06, 0.06), R=Rs)
    b.box((-1.44, 0, DECK_Z + 0.012), (0.22, 1.30, 0.025))

    # lights
    for s in (1, -1):
        lamp(b, (2.55, s * 1.30, 1.62), 1, "head")
        lamp(b, (-2.62, s * 1.46, deck_z(-2.62) + 0.10), -1, "tail")

    # tow shackles front + rear
    lower_front_x = lambda z: 2.45 + (z - 0.55) * (2.80 - 2.45) / (1.27 - 0.55)
    for s in (1, -1):
        shackle(b, (lower_front_x(1.05), s * 0.62, 1.05), 1)
        shackle(b, (-2.92, s * 0.62, 1.10), -1)

    # exhaust deflector on the rear plate
    b.box((-2.97, 0, 1.12), (0.06, 1.5, 0.22))
    for yy in (-0.5, 0.0, 0.5):
        b.box((-2.995, yy, 1.12), (0.03, 0.04, 0.24))

    # stowage on the sponsons
    zf = 1.52                     # fender box top
    crate(b, (1.25, 1.30, DECK_Z + 0.13), (0.38, 0.34, 0.26), wood=True)
    crate(b, (0.86, 1.30, DECK_Z + 0.11), (0.34, 0.30, 0.22), wood=False, strap_axis=1)
    crate(b, (2.10, -1.28, zf + 0.12), (0.30, 0.34, 0.24), wood=False, strap_axis=1)
    crate(b, (1.25, -1.30, DECK_Z + 0.10), (0.42, 0.30, 0.20), wood=False)
    for x, y, size, wood, ax in ((-2.28, 1.18, (0.50, 0.40, 0.40), True, 0),
                                 (-2.12, -1.18, (0.44, 0.38, 0.30), True, 0),
                                 (-2.53, -1.18, (0.28, 0.34, 0.26), False, 1)):
        crate(b, (x, y, deck_z(x) + size[2] / 2), size, R=Rs, wood=wood, strap_axis=ax)

    # boxes on the sponson side walls
    for x, sy, w, z0, z1 in ((0.70, 1, 0.42, 1.36, 1.72), (-1.35, 1, 0.32, 1.44, 1.78),
                             (0.25, -1, 0.40, 1.36, 1.72), (-1.38, -1, 0.34, 1.44, 1.78)):
        crate(b, (x, sy * 1.72, (z0 + z1) / 2), (w, 0.16, z1 - z0), wood=False, strap_axis=0)

    # pioneer tools
    tool(b, 0.80, -0.55, 1.71, 1.84)
    tool(b, 0.55, -1.45, -1.48, DECK_Z + 0.05, head=0.35)
    return b.finish("Hull_Details", root, bevel=(0.012, 1))


# ---------------------------------------------------------------- turret
def build_turret(root):
    tur = make_empty("Turret", root, TURRET_ORIGIN)
    b = Builder()
    b.cyl((0, 0, 0.05), (0, 0, 1), 1.12, 0.10, segs=48)
    b.lathe([(0, 0.08), (0.98, 0.08), (1.02, 0.20), (1.04, 0.50), (1.01, 0.72),
             (0.94, 0.84), (0.84, ROOF), (0, ROOF)], 48, Matrix.Identity(4))
    b.finish("Turret_Body", tur, bevel=(0.02, 2))

    d = Builder()
    roof = ROOF
    # commander's cupola
    cx, cy = 0.0, -0.22
    M = T(cx, cy, 0)
    d.lathe([(0, roof), (0.40, roof), (0.42, roof + 0.02), (0.42, roof + 0.08), (0.37, roof + 0.10),
             (0.35, roof + 0.18), (0.28, roof + 0.25), (0.15, roof + 0.29), (0, roof + 0.30)], 32, M)
    for k in range(6):
        a = 2 * pi * k / 6 + 0.3
        d.box((cx + 0.41 * cos(a), cy + 0.41 * sin(a), roof + 0.06), (0.06, 0.12, 0.07),
              R=Euler((0, 0, a)))
    d.cyl((cx, cy, roof + 0.30), (0, 0, 1), 0.20, 0.02, segs=24)
    d.box((cx - 0.30, cy, roof + 0.24), (0.10, 0.18, 0.06), R=Euler((0, 0.5, 0)))
    # loader's hatch
    d.cyl((-0.30, 0.40, roof + 0.02), (0, 0, 1), 0.24, 0.05, segs=24)
    d.cyl((-0.30, 0.40, roof + 0.055), (0, 0, 1), 0.17, 0.03, segs=24)
    d.box((-0.52, 0.40, roof + 0.04), (0.06, 0.18, 0.06))
    # periscopes
    for x, y, a in ((0.50, 0.42, 0.2), (0.28, 0.62, 0.5), (0.45, -0.60, -0.3)):
        d.box((x, y, roof + 0.05), (0.12, 0.16, 0.10), R=Euler((0, 0, a)))
        d.box((x + 0.05 * cos(a), y + 0.05 * sin(a), roof + 0.11), (0.05, 0.15, 0.05),
              R=Euler((0, 0, a)))
    # lifting rings
    for x, y, a in ((0.62, 0.20, 0.0), (0.58, -0.30, 0.0), (-0.70, 0.30, 1.2), (-0.62, -0.62, 0.7)):
        d.box((x, y, roof + 0.015), (0.08, 0.05, 0.03))
        d.torus(0.06, 0.013, T(x, y, roof + 0.06) @ Matrix.Rotation(a, 4, 'Z') @ AX_Y,
                "paint", maj=10, mnr=6)
    # antenna
    ax, ay = 0.20, 0.62
    d.cyl((ax, ay, roof + 0.05), (0, 0, 1), 0.06, 0.10, segs=12)
    d.cyl((ax, ay, roof + 0.16), (0, 0, 1), 0.025, 0.14, "metal", segs=8)
    d.cyl((ax, ay, roof + 0.80), (0, 0, 1), 0.012, 1.15, "metal", segs=6, r2=0.005)
    # stowage boxes on the rear cheeks, small housings on the front cheeks
    for a in (radians(128), radians(-128)):
        R = Euler((0, 0, a))
        c = Vector((1.10 * cos(a), 1.10 * sin(a), 0.42))
        crate(d, c, (0.22, 0.44, 0.36), R=R, wood=False, strap_axis=1)
        for f in (-0.12, 0.12):
            t = Vector((-sin(a), cos(a), 0)) * f
            d.box(c + t + Vector((cos(a), sin(a), 0)) * 0.12, (0.03, 0.05, 0.08), "metal", R=R)
    # large stowage box across the turret rear: inner corners touch the wall, centre sinks into it
    a = pi
    R = Euler((0, 0, a))
    rad = Vector((cos(a), sin(a), 0))
    tan = Vector((-sin(a), cos(a), 0))
    w, dep, h, zc = 0.86, 0.30, 0.38, 0.42
    c = rad * (sqrt(1.03 ** 2 - (w / 2) ** 2) + dep / 2) + Vector((0, 0, zc))
    crate(d, c, (dep, w, h), R=R, wood=False, strap_axis=1)
    face = c + rad * (dep / 2)
    for f in (-0.16, 0.16):
        d.box(face + tan * f + Vector((0, 0, h / 2 - 0.09)), (0.03, 0.06, 0.10), R=R)
        d.box(face + tan * f + Vector((0, 0, h / 2 - 0.15)), (0.025, 0.035, 0.03), R=R)
    for sy in (-1, 1):
        end = c + tan * (sy * (w / 2 + 0.014)) + Vector((0, 0, 0.06))
        Mh = Matrix(((rad.x, 0, tan.x, end.x), (rad.y, 0, tan.y, end.y),
                     (0, 1, 0, end.z), (0, 0, 0, 1)))   # handle hangs flat against the end face
        d.torus(0.06, 0.011, Mh, "paint", maj=8, mnr=6, arc=pi, a0=pi)
        d.box(c + tan * (sy * 0.30) - rad * 0.06 + Vector((0, 0, -h / 2 - 0.03)), (0.20, 0.05, 0.06), R=R)
    for a in (radians(58), radians(-58)):
        R = Euler((0, 0, a))
        d.box((1.06 * cos(a), 1.06 * sin(a), 0.42), (0.10, 0.16, 0.24), R=R)
        d.box((1.12 * cos(a), 1.12 * sin(a), 0.42), (0.04, 0.10, 0.16), R=R)
    # weld line / ring lip around the turret base
    d.torus(1.01, 0.02, T(0, 0, 0.14), "paint", maj=48, mnr=4)
    d.finish("Turret_Details", tur, bevel=(0.01, 1))
    return tur


GUN_RECOIL = 0.25        # metres the barrel slides back on fire


def build_gun(tur):
    """Gun_Mount (elevation pivot at the trunnions, rotate local Y) > Gun_Mantlet + Gun_Barrel.
    Gun_Barrel recoils along its local -X; its breech runs deep enough to stay hidden when recoiled."""
    mount = make_empty("Gun_Mount", tur, (0.86, 0.0, 0.51))
    mount["pivot_role"] = "elevation"
    mount["rotate_axis"] = "Y"

    m = Builder()
    mantlet = [(-0.22, -0.25)] + [(0.10 + 0.25 * cos(a), 0.25 * sin(a))
                                  for a in (radians(-90 + 15 * i) for i in range(13))] + [(-0.22, 0.25)]
    m.prism_xz(mantlet, -0.33, 0.33)
    for s in (1, -1):
        m.cyl((0.0, s * 0.36, 0.0), (0, 1, 0), 0.07, 0.06, "metal", segs=10)
    m.cyl((0.43, 0, 0), (1, 0, 0), 0.17, 0.22, segs=24)
    m.cyl((0.58, 0, 0), (1, 0, 0), 0.13, 0.08, segs=20)
    m.finish("Gun_Mantlet", mount, bevel=(0.012, 2))

    # barrel + muzzle brake as one hollow tube: outer surface forward, then back down the bore
    g = Builder()
    bore = 0.045
    g.lathe([(0.0, 0.62 - GUN_RECOIL - 0.05), (0.085, 0.62 - GUN_RECOIL - 0.05), (0.085, 0.62),
             (0.07, 2.03), (0.10, 2.03), (0.10, 2.09),
             (0.125, 2.09), (0.125, 2.21), (0.088, 2.21), (0.088, 2.32), (0.125, 2.32),
             (0.125, 2.44), (bore, 2.44), (bore, 0.75), (0.0, 0.75)], 20, AX_X)
    barrel = g.finish("Gun_Barrel", mount, bevel=(0.012, 2))
    barrel["recoil_axis"] = "-X"
    barrel["recoil_distance"] = GUN_RECOIL
    barrel["muzzle_local"] = [2.44, 0.0, 0.0]
    return mount


def build_mg(tur):
    """M2 .50 cal on its pintle. Modelled pointing +X; the object is turned to face the rear."""
    pivot = make_empty("MG50_Mount", tur, (-0.60, -0.35, ROOF))
    pivot.rotation_euler = (0, 0, pi)
    pivot["pivot_role"] = "traverse"
    pivot["rotate_axis"] = "Z"
    b = Builder()
    b.cyl((0, 0, 0.02), (0, 0, 1), 0.13, 0.04, segs=16)
    b.cyl((0, 0, 0.07), (0, 0, 1), 0.09, 0.06, segs=6)
    for k in range(6):
        a = 2 * pi * k / 6
        b.cyl((0.11 * cos(a), 0.11 * sin(a), 0.045), (0, 0, 1), 0.012, 0.015, "metal", segs=6)
    b.cyl((0, 0, 0.20), (0, 0, 1), 0.045, 0.22, segs=12)
    b.cyl((0, 0, 0.25), (0, 0, 1), 0.06, 0.04, segs=12)
    b.box((0, 0, 0.33), (0.12, 0.15, 0.03), "metal")
    for s in (1, -1):
        b.box((0, s * 0.065, 0.38), (0.10, 0.02, 0.10), "metal")
    b.cyl((0, 0, 0.40), (0, 1, 0), 0.018, 0.17, "metal", segs=8)
    mount = b.finish("MG50_Pintle", pivot, bevel=(0.004, 1))

    g = Builder()
    z = 0.43
    g.box((-0.05, 0, z), (0.38, 0.12, 0.13), "metal")
    g.box((-0.06, 0, z + 0.075), (0.32, 0.11, 0.025), "metal")
    for x in (-0.18, 0.06):
        g.cyl((x, 0, z + 0.09), (0, 1, 0), 0.012, 0.10, "metal", segs=6)
    g.box((-0.05, 0.07, z + 0.01), (0.10, 0.03, 0.04), "metal")
    g.cyl((-0.02, 0.10, z + 0.01), (0, 1, 0), 0.015, 0.05, "metal", segs=6)
    g.box((-0.255, 0, z), (0.03, 0.15, 0.13), "metal")
    for s in (1, -1):
        g.cyl((-0.31, s * 0.06, z - 0.01), (1, 0, 0), 0.016, 0.10, "metal", segs=8)
        g.cyl((-0.37, s * 0.06, z - 0.01), (1, 0, 0), 0.022, 0.03, "metal", segs=8)
    g.cyl((-0.30, 0, z - 0.04), (0, 0, 1), 0.008, 0.05, "metal", segs=6)
    g.box((0.16, 0, z), (0.05, 0.10, 0.10), "metal")
    g.cyl((0.335, 0, z), (1, 0, 0), 0.034, 0.30, "metal", segs=12)
    for x in (0.23, 0.30, 0.37, 0.44):
        g.cyl((x, 0, z), (1, 0, 0), 0.038, 0.02, "metal", segs=12)
    g.cyl((0.84, 0, z), (1, 0, 0), 0.021, 0.72, "metal", segs=10, r2=0.017)
    for x in (0.70, 0.95):
        g.cyl((x, 0, z), (1, 0, 0), 0.024, 0.03, "metal", segs=10)
    g.box((1.10, 0, z + 0.035), (0.015, 0.012, 0.04), "metal")
    g.cyl((1.24, 0, z), (1, 0, 0), 0.026, 0.08, "metal", segs=10)
    g.cyl((0.36, 0, z - 0.05), (1, 0, 0), 0.008, 0.40, "metal", segs=6)
    g.box((0.18, 0, z - 0.05), (0.03, 0.02, 0.05), "metal")
    # ammo can on a side bracket (olive paint, embossed X)
    ac = Vector((0.28, -0.15, z - 0.12))
    g.box(ac, (0.32, 0.13, 0.22))
    g.box(ac + Vector((0, 0, 0.115)), (0.33, 0.14, 0.02))
    g.box(ac + Vector((0, 0, 0.13)), (0.08, 0.02, 0.015), "metal")
    for a in (0.6, -0.6):
        g.box(ac + Vector((0, -0.067, 0)), (0.34, 0.01, 0.02), R=Euler((0, a, 0)))
    g.box(ac + Vector((-0.05, 0.08, 0.06)), (0.06, 0.05, 0.03), "metal")
    g.box((0.0, -0.08, z - 0.06), (0.05, 0.06, 0.04), "metal")
    elev = make_empty("MG50_Elevation", pivot, (0, 0, 0.40))
    elev["pivot_role"] = "elevation"
    elev["rotate_axis"] = "Y"
    g.finish("MG50", elev, loc=(0, 0, -0.40), bevel=(0.004, 1))
    return pivot


def build_base():
    """Hierarchy (all empties are pivots for the game):
    Sherman_Root
      Hull                 Hull_Body, Hull_Details, Suspension_L/R (static)
      RunningGear_L/R      Wheels_<side> (each wheel spins on local Y), Track_<side> (links)
      Turret               traverse (local Z): Turret_Body, Turret_Details,
                           Gun_Mount (elevation) > Gun_Mantlet, Gun_Barrel (recoil),
                           MG50_Mount (traverse) > MG50_Pintle, MG50_Elevation > MG50
    """
    ensure_materials()
    clear_objects()
    root = make_empty("Sherman_Root")
    hull = make_empty("Hull", root)
    build_hull(hull)
    groups = build_running_gear(root, hull)
    n_links = build_tracks(groups)
    build_hull_details(hull)
    tur = build_turret(root)
    tur["pivot_role"] = "traverse"
    tur["rotate_axis"] = "Z"
    build_gun(tur)
    build_mg(tur)
    return root, n_links


def group_tris(names):
    out = {}
    for name in names:
        ob = bpy.data.objects[name]
        out[name] = tri_count([ob] + list(ob.children_recursive))[0]
    return out


if __name__ == "__main__" or True:
    root, n_links = build_base()
    total, _ = tri_count(get_collection().all_objects)
    print("links per side:", n_links)
    print("tris total:", total)
    for k, v in group_tris(["Hull", "RunningGear_L", "RunningGear_R", "Turret"]).items():
        print(f"  {k}: {v}")
