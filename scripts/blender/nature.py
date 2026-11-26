"""
Nature models for Matcha: trees, palms, rocks and small plants.

    npm run models -- nature
    (Blender -b --factory-startup -P scripts/blender/nature.py -- public/models/nature.glb [--preview dir])

Every asset is its own top-level object with its origin at the base centre on
the ground; 1 Blender unit = 1 game unit, and each one is about 1 unit tall
(code scales it). Trees that sway have a child object named "<name>_crown"
whose origin is the pivot the game rocks in the wind.

Materials are named so code can recolour them per copy:
  Leaves, Leaves2 (foliage, theme treeColors), Trunk, Trunk2, Snow, Blossom,
  Nut, Grate, Crystal, Crystal2, Rock, Petal, Center, Stem, Bush, Berry,
  Coral, Cap, Spots, MushStem.

Native sizes:
  tree_*            1 tall (palm: trunk top at 1, fronds reach ~1.15)
  rock_*            about 2 wide, 1.3 tall (radius ~1)
  plant_*           about 1 tall
"""
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector, noise

TAU = math.tau

# --------------------------------------------------------------------------
# Materials
# --------------------------------------------------------------------------


def srgb(h):
    h = h.lstrip('#')
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return out


MATS = {}


def material(name, color, rough=0.85, emit=0.0, metal=0.0):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    rgb = srgb(color)
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if emit:
        bsdf.inputs['Emission Color'].default_value = (*rgb, 1)
        bsdf.inputs['Emission Strength'].default_value = emit
    m.diffuse_color = (*rgb, 1)
    # Only leaf blades (single surfaces) need both sides.
    m.use_backface_culling = name not in ('Leaves', 'Leaves2', 'Stem')
    MATS[name] = m
    return m


def init_materials():
    material('Leaves', '#4fae5e', 0.8)
    material('Leaves2', '#86d68e', 0.8)
    material('Trunk', '#8a6044', 0.95)
    material('Trunk2', '#6e4c33', 0.95)
    material('Snow', '#ffffff', 0.6)
    material('Blossom', '#fff0f6', 0.6)
    material('Nut', '#6b4a2b', 0.7)
    material('Grate', '#3a3348', 0.5, metal=0.6)
    material('Crystal', '#7fe3ff', 0.15, emit=0.6)
    material('Crystal2', '#ff8fe0', 0.15, emit=0.6)
    material('Rock', '#9aa0a8', 0.95)
    material('Petal', '#ff5a6e', 0.6)
    material('Center', '#ffd23f', 0.6)
    material('Stem', '#3f8f4f', 0.8)
    material('Bush', '#3f6e4f', 0.9)
    material('Berry', '#e8455a', 0.4)
    material('Coral', '#ff7f6e', 0.6)
    material('Cap', '#c46cff', 0.4, emit=0.6)
    material('Spots', '#fff6ea', 0.6)
    material('MushStem', '#f2ece0', 0.7)


# --------------------------------------------------------------------------
# Mesh building
# --------------------------------------------------------------------------


class Builder:
    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []

    def mi(self, name):
        m = MATS[name]
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    def finish(self, name, parent=None, pivot=(0, 0, 0), sharp=None):
        bm = self.bm
        pv = Vector(pivot)
        if pv.length:
            bmesh.ops.translate(bm, verts=bm.verts, vec=-pv)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        for m in self.mats:
            me.materials.append(m)
        if sharp is not None:
            try:
                me.set_sharp_from_angle(angle=math.radians(sharp))
            except Exception:
                pass
        obj = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(obj)
        if parent is not None:
            obj.parent = parent
        obj.location = pv
        return obj


def rings_surface(b, rings, mname, cap0=None, cap1=None, smooth=True):
    """Quads between rings (bottom->top, each ring CCW about the axis), with
    optional pole vertices closing the bottom (cap0) and top (cap1)."""
    bm = b.bm
    idx = b.mi(mname)
    vr = [[bm.verts.new(c) for c in ring] for ring in rings]
    faces = []
    n = len(rings[0])
    for i in range(len(vr) - 1):
        a, c = vr[i], vr[i + 1]
        for s in range(n):
            s2 = (s + 1) % n
            faces.append(bm.faces.new([a[s], a[s2], c[s2], c[s]]))
    if cap1 is not None:
        top = bm.verts.new(cap1)
        r = vr[-1]
        for s in range(n):
            faces.append(bm.faces.new([r[s], r[(s + 1) % n], top]))
    if cap0 is not None:
        bot = bm.verts.new(cap0)
        r = vr[0]
        for s in range(n):
            faces.append(bm.faces.new([bot, r[(s + 1) % n], r[s]]))
    for f in faces:
        f.material_index = idx
        f.smooth = smooth
    return faces


def lathe(b, profile, sides, mname, xf=None, rib=None, cap0=None, cap1=None, smooth=True):
    """Revolves (r, z) points (bottom->top on the outer surface) about Z.
    A first/last point with r == 0 becomes a pole."""
    xf = xf or Matrix.Identity(4)
    pts = list(profile)
    p0 = p1 = None
    if pts[0][0] <= 1e-6:
        p0 = xf @ Vector((0, 0, pts[0][1]))
        pts = pts[1:]
    if pts[-1][0] <= 1e-6:
        p1 = xf @ Vector((0, 0, pts[-1][1]))
        pts = pts[:-1]
    rings = []
    for k, (r, z) in enumerate(pts):
        ring = []
        for s in range(sides):
            a = TAU * s / sides
            rr = r * (rib(a, k) if rib else 1)
            ring.append(xf @ Vector((math.cos(a) * rr, math.sin(a) * rr, z)))
        rings.append(ring)
    return rings_surface(b, rings, mname, cap0 or p0, cap1 or p1, smooth)


def tube(b, pts, radii, sides, mname, tip=True, rib=None, base_cap=False):
    """A tapered tube along a path; parallel-transported frames so it bends
    smoothly. `tip` closes the end with a rounded point."""
    pts = [Vector(p) for p in pts]
    n = len(pts)
    tans = []
    for i in range(n):
        if i == 0:
            t = pts[1] - pts[0]
        elif i == n - 1:
            t = pts[-1] - pts[-2]
        else:
            t = pts[i + 1] - pts[i - 1]
        tans.append(t.normalized())
    up = Vector((1, 0, 0)) if abs(tans[0].z) > 0.9 else Vector((0, 0, 1))
    nrm = (up - tans[0] * up.dot(tans[0])).normalized()
    rings = []
    for i in range(n):
        if i > 0:
            axis = tans[i - 1].cross(tans[i])
            if axis.length > 1e-7:
                nrm = Matrix.Rotation(tans[i - 1].angle(tans[i]), 3, axis.normalized()) @ nrm
        bi = tans[i].cross(nrm)
        ring = []
        for s in range(sides):
            a = TAU * s / sides
            r = radii[i] * (rib(a, i) if rib else 1)
            ring.append(pts[i] + (nrm * math.cos(a) + bi * math.sin(a)) * r)
        rings.append(ring)
    cap1 = pts[-1] + tans[-1] * radii[-1] * 0.8 if tip else None
    cap0 = pts[0] - tans[0] * radii[0] * 0.2 if base_cap else None
    return rings_surface(b, rings, mname, cap0, cap1)


def blob(b, c, r, mname, sc=(1, 1, 1), sub=2, lump=0.16, freq=2.0, seed=0.0,
         flat=None, rot=None, hide_below=None):
    """A lumpy ball. `flat` flattens the underside below that height (in unit
    space); `hide_below` pulls the lower part inwards (used for snow caps)."""
    res = bmesh.ops.create_icosphere(b.bm, subdivisions=sub + 1, radius=1.0)
    off = Vector((seed * 7.13 + 1.1, seed * 3.71 + 2.3, seed * 1.93 + 3.7))
    R = (Euler(rot).to_matrix() if rot else Matrix.Identity(3))
    for v in res['verts']:
        n = v.co.normalized()
        d = 1 + lump * noise.noise(n * freq + off) + lump * 0.4 * noise.noise(n * freq * 2.7 + off * 2)
        p = n * d
        if flat is not None and p.z < flat:
            p.z = flat + (p.z - flat) * 0.25
        if hide_below is not None and n.z < hide_below:
            p *= 0.75
        p = Vector((p.x * sc[0], p.y * sc[1], p.z * sc[2]))
        v.co = Vector(c) + (R @ p) * r
    idx = b.mi(mname)
    faces = {f for v in res['verts'] for f in v.link_faces}
    for f in faces:
        f.material_index = idx
        f.smooth = True
    return res['verts']


def strip(b, spine, widths, side, mname, fold=0.3, serrate=0.0):
    """A leaf blade: a surface along `spine` points, `widths` half-widths,
    `side` the sideways unit vector at each point. Folded into a V."""
    bm = b.bm
    idx = b.mi(mname)
    L, M, R = [], [], []
    for i, p in enumerate(spine):
        p = Vector(p)
        w = widths[i]
        if serrate and i % 2 == 1:
            w *= 1 - serrate
        s = Vector(side[i])
        if i + 1 < len(spine):
            fwd = (Vector(spine[i + 1]) - p).normalized()
        else:
            fwd = (p - Vector(spine[i - 1])).normalized()
        up = s.cross(fwd).normalized()
        drop = -up * w * fold
        back = fwd * w * 0.6 if serrate and i % 2 == 0 else Vector()
        L.append(bm.verts.new(p - s * w + drop + back))
        M.append(bm.verts.new(p))
        R.append(bm.verts.new(p + s * w + drop + back))
    faces = []
    for i in range(len(spine) - 1):
        faces.append(bm.faces.new([L[i], M[i], M[i + 1], L[i + 1]]))
        faces.append(bm.faces.new([M[i], R[i], R[i + 1], M[i + 1]]))
    for f in faces:
        f.material_index = idx
        f.smooth = True
    return faces


def bezier(p0, p1, p2, n):
    p0, p1, p2 = Vector(p0), Vector(p1), Vector(p2)
    return [p0 * (1 - t) ** 2 + p1 * 2 * t * (1 - t) + p2 * t * t for t in (i / (n - 1) for i in range(n))]


def tris(obj):
    count = 0
    for o in [obj, *obj.children_recursive]:
        if o.type == 'MESH':
            count += sum(len(p.vertices) - 2 for p in o.data.polygons)
    return count


# --------------------------------------------------------------------------
# Trees (all about 1 unit tall)
# --------------------------------------------------------------------------


def trunk_path(rng, top, bend=0.04, n=7):
    lean = Vector((rng.uniform(-bend, bend), rng.uniform(-bend, bend), 0))
    return bezier((0, 0, 0), Vector((0, 0, top * 0.5)) - lean, Vector((0, 0, top)) + lean, n)


def flared(n, r0, r1, flare=1.6):
    """Radii for a trunk: flared at the base, tapering up."""
    out = []
    for i in range(n):
        t = i / (n - 1)
        out.append(r1 + (r0 - r1) * (1 - t) ** 1.4 + r0 * (flare - 1) * max(0, 1 - t * 5) ** 2)
    return out


def canopy(b, rng, puffs, seed, sub_big=2, lump=0.14):
    for k, (x, y, z, r, mname) in enumerate(puffs):
        blob(b, (x, y, z), r, mname, sc=(1, 1, 0.88), sub=sub_big if r > 0.12 else 1,
             lump=lump, freq=2.2, seed=seed * 10 + k, flat=-0.55)


def tree_round(name, seed):
    rng = random.Random(seed)
    b = Builder()
    path = trunk_path(rng, 0.62)
    tube(b, path, flared(len(path), 0.07, 0.035), 9, 'Trunk', tip=False, base_cap=False)
    # Two branches reaching up into the canopy.
    for a in (rng.uniform(0, TAU), rng.uniform(0, TAU)):
        d = Vector((math.cos(a), math.sin(a), 0))
        st = Vector(path[3])
        tube(b, bezier(st, st + d * 0.08 + Vector((0, 0, 0.08)), st + d * 0.17 + Vector((0, 0, 0.22)), 5),
             [0.03, 0.026, 0.022, 0.018, 0.014], 6, 'Trunk')
    root = b.finish(name)
    c = Builder()
    puffs = [(0, 0, 0.68, 0.25, 'Leaves')]
    n = 5
    for k in range(n):
        a = k / n * TAU + rng.uniform(-0.3, 0.3)
        rr = rng.uniform(0.17, 0.21)
        h = rng.uniform(0.58, 0.72)
        puffs.append((math.cos(a) * 0.2, math.sin(a) * 0.2, h, rr, 'Leaves' if k % 2 else 'Leaves2'))
    puffs.append((rng.uniform(-0.05, 0.05), rng.uniform(-0.05, 0.05), 0.83, 0.18, 'Leaves2'))
    canopy(c, rng, puffs, seed)
    c.finish(name + '_crown', parent=root, pivot=(0, 0, 0.45))
    return root


def tree_street(name, seed):
    rng = random.Random(seed)
    b = Builder()
    path = trunk_path(rng, 0.6, 0.015)
    tube(b, path, flared(len(path), 0.045, 0.03, 1.3), 8, 'Trunk', tip=False)
    lathe(b, [(0.11, 0.0), (0.135, 0.012), (0.12, 0.02), (0.06, 0.02)], 16, 'Grate', cap1=None)
    root = b.finish(name)
    c = Builder()
    puffs = [(0, 0, 0.72, 0.24, 'Leaves')]
    for k in range(4):
        a = k / 4 * TAU + rng.uniform(0, 1)
        puffs.append((math.cos(a) * 0.14, math.sin(a) * 0.14, rng.uniform(0.66, 0.8), 0.15, 'Leaves2' if k % 2 else 'Leaves'))
    puffs.append((0, 0, 0.86, 0.14, 'Leaves2'))
    canopy(c, rng, puffs, seed)
    c.finish(name + '_crown', parent=root, pivot=(0, 0, 0.45))
    return root


def tree_pastel(name, seed):
    rng = random.Random(seed)
    b = Builder()
    s = rng.choice((-1, 1))
    path = bezier((0, 0, 0), (0.12 * s, 0, 0.25), (-0.02 * s, 0.02, 0.6), 8)
    tube(b, path, flared(len(path), 0.055, 0.03), 8, 'Trunk', tip=False)
    root = b.finish(name)
    c = Builder()
    top = Vector(path[-1])
    puffs = [(top.x, top.y, 0.7, 0.2, 'Leaves')]
    for k in range(6):
        a = k / 6 * TAU + rng.uniform(-0.2, 0.2)
        puffs.append((top.x + math.cos(a) * 0.2, top.y + math.sin(a) * 0.2, rng.uniform(0.6, 0.74),
                      rng.uniform(0.13, 0.16), 'Leaves2' if k % 2 else 'Leaves'))
    for k in range(3):
        a = k / 3 * TAU + 0.5
        puffs.append((top.x + math.cos(a) * 0.1, top.y + math.sin(a) * 0.1, 0.84, 0.14, 'Leaves2' if k % 2 else 'Leaves'))
    for k, (x, y, z, r, m) in enumerate(puffs):
        blob(c, (x, y, z), r, m, sc=(1, 1, 0.9), sub=2 if r > 0.15 else 1, lump=0.08, freq=1.6,
             seed=seed * 10 + k, flat=-0.5)
    # Little blossoms dotted over the canopy.
    for k in range(8):
        a = rng.uniform(0, TAU)
        el = rng.uniform(0.2, 1.0)
        p = Vector((math.cos(a) * math.cos(el), math.sin(a) * math.cos(el), math.sin(el)))
        blob(c, top + Vector((0, 0, 0.1)) + p * 0.29, 0.025, 'Blossom', sub=0, lump=0)
    c.finish(name + '_crown', parent=root, pivot=(0, 0, 0.45))
    return root


def tree_mesquite(name, seed):
    rng = random.Random(seed)
    b = Builder()
    lean = Vector((0.08, 0.02, 0))
    path = bezier((0, 0, 0), (0.0, 0, 0.16), Vector((0, 0, 0.32)) + lean, 6)
    tube(b, path, flared(len(path), 0.06, 0.04), 8, 'Trunk', tip=False)
    top = Vector(path[-1])
    ends = []
    for k in range(3):
        a = k / 3 * TAU + rng.uniform(-0.3, 0.3)
        d = Vector((math.cos(a), math.sin(a), 0))
        end = top + d * rng.uniform(0.26, 0.34) + Vector((0, 0, rng.uniform(0.2, 0.28)))
        mid = top + d * 0.08 + Vector((0, 0, 0.14))
        tube(b, bezier(top - Vector((0, 0, 0.03)), mid, end, 6), [0.034, 0.03, 0.026, 0.022, 0.017, 0.012], 6, 'Trunk')
        ends.append(end)
    root = b.finish(name)
    c = Builder()
    k = 0
    for e in ends:
        blob(c, e + Vector((0, 0, 0.05)), 0.23, 'Leaves', sc=(1, 1, 0.45), lump=0.2, freq=2.6, seed=seed * 10 + k, flat=-0.3)
        k += 1
    blob(c, top + Vector((0, 0, 0.36)), 0.3, 'Leaves2', sc=(1, 1, 0.42), lump=0.2, freq=2.6, seed=seed * 10 + k, flat=-0.3)
    for e in ends[:2]:
        k += 1
        blob(c, e * 0.6 + top * 0.4 + Vector((0, 0, 0.12)), 0.15, 'Leaves2', sc=(1, 1, 0.5), sub=1, lump=0.2, seed=seed * 10 + k)
    c.finish(name + '_crown', parent=root, pivot=(top.x, top.y, top.z))
    return root


def pine_tier(b, z0, z1, r, mname, rng, n=16, droop=0.05, jag=0.22, seed=0, rings=4, snow=False):
    """One drooping skirt of a fir: apex at z1, a jagged rim at z0."""
    rows = []
    off = rng.uniform(0, 10)
    for k in range(rings, 0, -1):  # rim first (bottom) up to near apex
        t = k / rings
        ring = []
        for s in range(n):
            a = TAU * s / n
            rr = r * t ** 0.8
            zz = z1 - (z1 - z0) * t
            if k == rings:
                tip = 1 if s % 2 == 0 else -1
                rr *= 1 + jag * 0.5 * tip
                zz -= droop * (1 if tip > 0 else -0.2)
            rr *= 1 + 0.06 * noise.noise(Vector((math.cos(a) * 2, math.sin(a) * 2, off + t * 2)))
            ring.append(Vector((math.cos(a) * rr, math.sin(a) * rr, zz)))
        rows.append(ring)
    # underside: from the rim inward and up to a hidden point
    under = [Vector((p.x * 0.55, p.y * 0.55, z0 + (z1 - z0) * 0.18)) for p in rows[0]]
    rings_surface(b, [under] + rows, mname, cap0=Vector((0, 0, z0 + (z1 - z0) * 0.3)), cap1=Vector((0, 0, z1)))


def tree_pine(name, seed):
    rng = random.Random(seed)
    b = Builder()
    path = trunk_path(rng, 0.3, 0.01, 4)
    tube(b, path, flared(len(path), 0.06, 0.04, 1.3), 8, 'Trunk', tip=False)
    root = b.finish(name)
    c = Builder()
    tiers = 5
    for i in range(tiers):
        f = i / (tiers - 1)
        z0 = 0.12 + f * 0.62
        z1 = z0 + 0.36 - f * 0.08
        r = 0.36 - f * 0.22 + rng.uniform(-0.015, 0.015)
        pine_tier(c, z0, z1, r, 'Leaves', rng, droop=0.05 - f * 0.02, seed=seed * 10 + i)
        # snow resting on the upper part of the skirt
        zs0 = z0 + (z1 - z0) * 0.45
        pine_tier(c, zs0, z1 + 0.012, r * 0.68 + 0.012, 'Snow', rng, n=16, droop=0.025, jag=0.3, rings=3, seed=seed * 10 + i + 5)
    c.finish(name + '_crown', parent=root, pivot=(0, 0, 0.2))
    # A snowless twin of the crown is not needed: code recolours Snow.
    return root


def tree_palm(name, seed):
    """Trunk top at z = 1; the fronds arch out and droop ~0.5."""
    rng = random.Random(seed)
    b = Builder()
    bend = rng.uniform(0.12, 0.22)
    a = rng.uniform(0, TAU)
    d = Vector((math.cos(a), math.sin(a), 0))
    n = 34
    path = bezier((0, 0, 0), d * bend * 0.1 + Vector((0, 0, 0.55)), d * bend + Vector((0, 0, 1.0)), n)
    radii = []
    for i in range(n):
        t = i / (n - 1)
        base = 0.055 - 0.022 * t + 0.05 * max(0, 1 - t * 8) ** 2
        ring = (i % 3) / 2  # stacked bulges like old leaf scars
        radii.append(base * (1 + 0.12 * ring))
    faces = tube(b, path, radii, 9, 'Trunk', tip=True)
    # darker band at every third ring for the scarred look
    k2 = b.mi('Trunk2')
    for i, f in enumerate(faces[: (n - 1) * 9]):
        if (i // 9) % 3 == 0:
            f.material_index = k2
    root = b.finish(name)
    top = Vector(path[-1])
    c = Builder()
    blob(c, top + Vector((0, 0, 0.02)), 0.05, 'Leaves2', lump=0.1, sub=1)
    for k in range(3):
        aa = k / 3 * TAU + 0.4
        blob(c, top + Vector((math.cos(aa) * 0.045, math.sin(aa) * 0.045, -0.04)), 0.032, 'Nut', sub=1, lump=0.05)
    fronds = 9
    for k in range(fronds):
        ang = k / fronds * TAU + rng.uniform(-0.15, 0.15)
        dirv = Vector((math.cos(ang), math.sin(ang), 0))
        side = Vector((-math.sin(ang), math.cos(ang), 0))
        L = rng.uniform(0.5, 0.6) * (0.85 if k % 2 else 1.0)
        rise = rng.uniform(0.1, 0.2)
        segs = 21
        sag = 0.26 if k % 2 else 0.4
        spine, widths, sides = [], [], []
        for i in range(segs):
            t = i / (segs - 1)
            p = top + dirv * L * t * (1 - 0.15 * t) + Vector((0, 0, rise * t - (rise + sag) * t * t + 0.02))
            twist = 0.25 * t * (1 if k % 2 else -1)
            spine.append(p)
            widths.append(0.01 + L * 0.24 * math.sin(math.pi * min(1, 0.05 + t * 1.05)) ** 0.6 * (1 - t * 0.4))
            sides.append(side * math.cos(twist) + Vector((0, 0, math.sin(twist))))
        strip(c, spine, widths, sides, 'Leaves' if k % 2 else 'Leaves2', fold=0.55, serrate=0.7)
    c.finish(name + '_crown', parent=root, pivot=top)
    return root


def tree_cactus(name, seed):
    """A saguaro: ribbed trunk, an arm or two, a pink flower on top."""
    rng = random.Random(seed)
    b = Builder()
    rib = lambda a, i: 1 + 0.1 * math.cos(a * 8)
    n = 10
    pts = [(0, 0, 0.88 * i / (n - 1)) for i in range(n)]
    rad = [0.11 + 0.012 * (1 - i / (n - 1)) for i in range(n)]
    rad[-1] *= 0.92
    tube(b, pts, rad, 24, 'Leaves', tip=True, rib=rib)
    arms = [1, -1] if seed % 2 == 0 else [1]
    for s in arms:
        h0 = rng.uniform(0.28, 0.4)
        out = rng.uniform(0.24, 0.28)
        hi = h0 + rng.uniform(0.25, 0.35)
        ax = Vector((s, rng.uniform(-0.3, 0.3), 0)).normalized()
        p0 = Vector((0, 0, h0)) + ax * 0.05
        p1 = Vector((0, 0, h0 - 0.02)) + ax * out
        p2 = Vector((0, 0, hi)) + ax * out
        path = bezier(p0, p1 + Vector((0, 0, -0.04)), p1 + Vector((0, 0, 0.1)), 5)[:-1] + bezier(p1 + Vector((0, 0, 0.1)), p1 + Vector((0, 0, 0.2)), p2, 4)
        tube(b, path, [0.065] * (len(path) - 1) + [0.06], 18, 'Leaves', tip=True,
             rib=lambda a, i: 1 + 0.1 * math.cos(a * 6))
    for k in range(5):
        a = k / 5 * TAU
        blob(b, (math.cos(a) * 0.035, math.sin(a) * 0.035, 0.985), 0.03, 'Blossom', sc=(1.3, 1.3, 0.6), sub=0, lump=0, rot=(0, 0.4, a))
    blob(b, (0, 0, 0.995), 0.02, 'Center', sub=0, lump=0)
    return b.finish(name)


def crystal_prism(b, base, r, h, mname, tilt, yaw):
    xf = Matrix.Translation(base) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Rotation(tilt, 4, 'Y')
    lathe(b, [(0, -0.05), (r, -0.05), (r, h), (r * 0.9, h + r * 0.15), (0, h + r * 1.6)], 6, mname, xf=xf, smooth=False)


def tree_crystal(name, seed):
    rng = random.Random(seed)
    b = Builder()
    blob(b, (0, 0, 0.02), 0.22, 'Rock', sc=(1.2, 1.1, 0.5), sub=1, lump=0.2, seed=seed)
    shards = [(0, 0, 0.11, 0.72, 0.05, 0)]
    for k in range(6):
        a = k / 6 * TAU + rng.uniform(-0.3, 0.3)
        dist = rng.uniform(0.09, 0.17)
        shards.append((math.cos(a) * dist, math.sin(a) * dist, rng.uniform(0.05, 0.08),
                       rng.uniform(0.2, 0.48), rng.uniform(0.35, 0.6), a))
    for k, (x, y, r, h, tilt, yaw) in enumerate(shards):
        crystal_prism(b, Vector((x, y, 0.02)), r, h, 'Crystal' if k % 2 == 0 else 'Crystal2', tilt, yaw)
    return b.finish(name, sharp=30)


# --------------------------------------------------------------------------
# Rocks (about 2 wide, 1.3 tall)
# --------------------------------------------------------------------------


def rock(name, seed, sc=(1, 0.85, 0.68), sub=2, lump=0.28):
    b = Builder()
    blob(b, (0, 0, 0), 1.0, 'Rock', sc=sc, sub=sub, lump=lump, freq=1.3, seed=seed + 0.37, flat=-0.35)
    bm = b.bm
    zmin = min(v.co.z for v in bm.verts)
    for v in bm.verts:
        v.co.z -= zmin
        for f in v.link_faces:
            f.smooth = True
    return b.finish(name, sharp=38)


# --------------------------------------------------------------------------
# Small plants (about 1 tall)
# --------------------------------------------------------------------------


def leaf_pair(b, rng, base_z, n=2, length=0.32, width=0.06, mname='Stem'):
    for k in range(n):
        a = k / n * TAU + rng.uniform(0, 1)
        d = Vector((math.cos(a), math.sin(a), 0))
        side = Vector((-math.sin(a), math.cos(a), 0))
        segs = 7
        spine, w, sides = [], [], []
        for i in range(segs):
            t = i / (segs - 1)
            spine.append(Vector((0, 0, base_z)) + d * length * t + Vector((0, 0, length * (0.6 * t - 0.45 * t * t))))
            w.append(width * math.sin(math.pi * min(1, 0.08 + t * 0.95)) ** 0.8)
            sides.append(side)
        strip(b, spine, w, sides, mname, fold=0.35)


def plant_flowers(name, seed, style):
    rng = random.Random(seed)
    b = Builder()
    heads = [(0, 0, 0.78)] if style != 2 else [(-0.12, 0.02, 0.6), (0.1, -0.05, 0.78), (0.02, 0.1, 0.5)]
    for hx, hy, hz in heads:
        top = Vector((hx, hy, hz))
        path = bezier((hx * 0.3, hy * 0.3, 0), (hx * 0.5 + rng.uniform(-0.05, 0.05), hy * 0.5, hz * 0.5), top, 6)
        tube(b, path, [0.022, 0.02, 0.018, 0.017, 0.016, 0.015], 6, 'Stem', tip=False)
        if style == 1:
            # tulip: cupped petals
            for k in range(5):
                a = k / 5 * TAU
                blob(b, top + Vector((math.cos(a) * 0.055, math.sin(a) * 0.055, 0.09)), 0.1, 'Petal',
                     sc=(0.42, 0.62, 1.1), sub=1, lump=0.04, rot=(0, -0.28, a), seed=k)
            blob(b, top + Vector((0, 0, 0.06)), 0.05, 'Center', sub=1, lump=0)
        else:
            # daisy: a ring of petals around a domed centre
            n = 9 if style == 0 else 7
            s = 1.0 if style == 0 else 0.75
            for k in range(n):
                a = k / n * TAU
                blob(b, top + Vector((math.cos(a) * 0.11 * s, math.sin(a) * 0.11 * s, 0.01)), 0.11 * s, 'Petal',
                     sc=(0.85, 0.36, 0.14), sub=0, lump=0.03, rot=(0, -0.25, a), seed=k)
            blob(b, top + Vector((0, 0, 0.025)), 0.065 * s, 'Center', sc=(1, 1, 0.6), sub=1, lump=0.05)
    leaf_pair(b, rng, 0.08, 2 if style != 2 else 3)
    return b.finish(name)


def plant_shrubs(name, seed, snowy):
    rng = random.Random(seed)
    b = Builder()
    puffs = [(0, 0, 0.42, 0.36)]
    for k in range(4):
        a = k / 4 * TAU + rng.uniform(-0.3, 0.3)
        puffs.append((math.cos(a) * 0.3, math.sin(a) * 0.3, 0.3, rng.uniform(0.24, 0.3)))
    for k, (x, y, z, r) in enumerate(puffs):
        blob(b, (x, y, z), r, 'Bush', sub=2 if k == 0 else 1, lump=0.15, freq=2.4, seed=seed * 10 + k, flat=-0.6)
    if snowy:
        blob(b, (0, 0, 0.45), 0.37, 'Snow', sc=(1.02, 1.02, 1.0), sub=2, lump=0.15, freq=2.4, seed=seed * 10, hide_below=0.45)
    for k in range(9):
        a = rng.uniform(0, TAU)
        el = rng.uniform(0.1, 0.9)
        p = Vector((math.cos(a) * math.cos(el), math.sin(a) * math.cos(el), math.sin(el)))
        c = Vector((0, 0, 0.36)) + p * 0.43
        if snowy and c.z > 0.62:
            continue
        blob(b, c, 0.045, 'Berry', sub=0, lump=0)
    return b.finish(name)


def plant_cacti(name, seed, style):
    rng = random.Random(seed)
    b = Builder()
    if style == 0:
        # barrel cactus with a crown of flowers
        prof = [(0.0, 0.0), (0.3, 0.0), (0.38, 0.15), (0.4, 0.35), (0.36, 0.55), (0.24, 0.7), (0.1, 0.76), (0, 0.77)]
        lathe(b, prof, 24, 'Leaves', rib=lambda a, i: 1 + 0.08 * math.cos(a * 12))
        for k in range(5):
            a = k / 5 * TAU + 0.3
            for j in range(4):
                aa = j / 4 * TAU
                blob(b, (math.cos(a) * 0.1 + math.cos(aa) * 0.04, math.sin(a) * 0.1 + math.sin(aa) * 0.04, 0.78),
                     0.05, 'Petal', sc=(1, 0.5, 0.35), sub=0, lump=0, rot=(0, -0.4, aa))
    else:
        # prickly pear: flat pads stacked up
        pads = [((0, 0, 0.24), 0.26, 0), ((0.14, 0.0, 0.55), 0.2, -0.5), ((-0.15, 0.02, 0.52), 0.19, 0.45),
                ((0.02, 0.0, 0.8), 0.15, 0.1)]
        for k, (c, r, tilt) in enumerate(pads):
            blob(b, c, r, 'Leaves', sc=(0.8, 0.28, 1.0), sub=2 if k == 0 else 1, lump=0.06, rot=(0, tilt, 0.3 * k), seed=k)
        for c in ((0.24, 0, 0.72), (-0.27, 0.02, 0.68), (0.04, 0, 0.96)):
            blob(b, c, 0.05, 'Petal', sc=(1, 1, 1.2), sub=0, lump=0)
    return b.finish(name)


def plant_coral(name, seed, style):
    rng = random.Random(seed)
    b = Builder()
    if style == 0:
        # branching staghorn coral
        def branch(p, d, length, r, depth):
            end = p + d * length
            mid = p + d * length * 0.5 + Vector((rng.uniform(-0.04, 0.04), rng.uniform(-0.04, 0.04), 0.03))
            tube(b, bezier(p, mid, end, 4), [r, r * 0.93, r * 0.86, r * 0.8], 6, 'Coral', tip=depth == 0)
            if depth > 0:
                for s in (-1, 1):
                    nd = (d + Vector((s * rng.uniform(0.4, 0.7), rng.uniform(-0.4, 0.4), 0.25))).normalized()
                    branch(end, nd, length * 0.72, r * 0.75, depth - 1)
        for k in range(3):
            a = k / 3 * TAU
            d = Vector((math.cos(a) * 0.35, math.sin(a) * 0.35, 1)).normalized()
            branch(Vector((0, 0, 0)), d, 0.36, 0.06, 2)
    else:
        # tube coral: a bunch of open-topped tubes
        for k in range(6):
            a = k / 6 * TAU + rng.uniform(-0.2, 0.2)
            dist = 0 if k == 0 else rng.uniform(0.14, 0.22)
            h = 0.95 if k == 0 else rng.uniform(0.45, 0.8)
            r = rng.uniform(0.06, 0.08)
            xf = Matrix.Translation((math.cos(a) * dist, math.sin(a) * dist, 0)) @ Matrix.Rotation(0.15 if k else 0, 4, Vector((-math.sin(a), math.cos(a), 0)))
            lathe(b, [(r * 0.8, 0), (r, h * 0.5), (r * 1.2, h), (r * 0.8, h * 1.0), (r * 0.7, h * 0.85)], 10, 'Coral', xf=xf)
    return b.finish(name)


def mushroom(b, base, h, r, rng):
    lathe(b, [(r * 0.28, 0), (r * 0.22, h * 0.5), (r * 0.24, h)], 10, 'MushStem', xf=Matrix.Translation(base))
    cap = [(r * 0.2, h * 0.95), (r * 0.8, h * 0.93), (r * 1.0, h * 0.97), (r * 1.02, h * 1.08), (r * 0.85, h * 1.25),
           (r * 0.5, h * 1.36), (0, h * 1.4)]
    lathe(b, cap, 14, 'Cap', xf=Matrix.Translation(base))
    for k in range(5):
        a = rng.uniform(0, TAU)
        el = rng.uniform(0.35, 1.0)
        p = Vector((math.cos(a) * math.cos(el) * r * 1.0, math.sin(a) * math.cos(el) * r * 1.0, h * 1.02 + math.sin(el) * h * 0.4))
        blob(b, Vector(base) + p, r * 0.15, 'Spots', sc=(1, 1, 0.5), sub=0, lump=0, rot=(0, el - math.pi / 2, a))


def plant_mushrooms(name, seed):
    rng = random.Random(seed)
    b = Builder()
    mushroom(b, (0, 0, 0), 0.6, 0.3, rng)
    mushroom(b, (0.28, 0.08, 0), 0.35, 0.18, rng)
    if seed % 2:
        mushroom(b, (-0.22, -0.12, 0), 0.25, 0.14, rng)
    return b.finish(name)


# --------------------------------------------------------------------------


def build():
    objs = []
    for i in range(3):
        objs.append(tree_round(f'tree_round_{i + 1}', 11 + i))
        objs.append(tree_pine(f'tree_pine_{i + 1}', 21 + i))
        objs.append(tree_palm(f'tree_palm_{i + 1}', 31 + i))
    for i in range(2):
        objs.append(tree_street(f'tree_street_{i + 1}', 41 + i))
        objs.append(tree_pastel(f'tree_pastel_{i + 1}', 51 + i))
        objs.append(tree_mesquite(f'tree_mesquite_{i + 1}', 61 + i))
        objs.append(tree_cactus(f'tree_cactus_{i + 1}', 70 + i))
        objs.append(tree_crystal(f'tree_crystal_{i + 1}', 81 + i))
    objs.append(rock('rock_1', 1))
    objs.append(rock('rock_2', 2, sc=(1, 0.8, 0.6)))
    objs.append(rock('rock_3', 3, sc=(0.95, 0.9, 0.8), lump=0.32))
    objs.append(rock('rock_4', 4, sc=(1, 0.7, 0.55), sub=1, lump=0.22))
    for i in range(3):
        objs.append(plant_flowers(f'plant_flowers_{i + 1}', 100 + i, i))
    objs.append(plant_shrubs('plant_shrubs_1', 110, False))
    objs.append(plant_shrubs('plant_shrubs_2', 111, True))
    objs.append(plant_cacti('plant_cacti_1', 120, 0))
    objs.append(plant_cacti('plant_cacti_2', 121, 1))
    objs.append(plant_coral('plant_coral_1', 130, 0))
    objs.append(plant_coral('plant_coral_2', 131, 1))
    objs.append(plant_mushrooms('plant_mushrooms_1', 140))
    objs.append(plant_mushrooms('plant_mushrooms_2', 141))
    return objs


def preview(objs, outdir):
    """Renders lineups (not exported): trees, then rocks and plants."""
    scene = bpy.context.scene
    engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
    scene.render.engine = 'BLENDER_EEVEE' if 'BLENDER_EEVEE' in engines else ('BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in engines else 'BLENDER_WORKBENCH')
    scene.render.resolution_x = 2000
    scene.render.resolution_y = 800
    scene.view_settings.view_transform = 'Standard'
    world = bpy.data.worlds.new('W')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (*srgb('#bfe3ff'), 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.45
    scene.world = world
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 5.0
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    scene.collection.objects.link(sun)
    gm = bpy.data.meshes.new('ground')
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=60)
    bm.to_mesh(gm)
    gm.materials.append(material('PreviewGround', '#e9dcc0', 1))
    ground = bpy.data.objects.new('ground', gm)
    scene.collection.objects.link(ground)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.type = 'ORTHO'

    trees = [o for o in objs if o.name.startswith('tree_')]
    rest = [o for o in objs if not o.name.startswith('tree_')]
    groups = {}
    for gi in range(0, len(trees), 6):
        groups[f'trees{gi // 6 + 1}'] = trees[gi:gi + 6]
    for gi in range(0, len(rest), 7):
        groups[f'plants{gi // 7 + 1}'] = rest[gi:gi + 7]
    for gname, group in groups.items():
        for o in objs:
            o.hide_render = o not in group
            for ch in o.children_recursive:
                ch.hide_render = o.hide_render
        x = 0
        for o in group:
            s = 0.5 if o.name.startswith('rock') else 1.0
            o.scale = (s, s, s)
            o.location = (x, 0, 0)
            o.rotation_euler = (0, 0, 0.4)
            x += 1.3
        width = x
        cam.data.ortho_scale = width
        cam.rotation_euler = (math.radians(72), 0, 0)
        cam.location = (width / 2 - 0.65, -20, 0.62 + 20 / math.tan(math.radians(72)))
        scene.render.resolution_x = 1800
        scene.render.resolution_y = int(1800 * 1.45 / width)
        scene.render.filepath = os.path.join(outdir, f'nature_{gname}.png')
        bpy.ops.render.render(write_still=True)
    for o in objs:
        o.location = (0, 0, 0)
        o.scale = (1, 1, 1)
        o.rotation_euler = (0, 0, 0)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = argv[0] if argv else 'public/models/nature.glb'
    prev = argv[argv.index('--preview') + 1] if '--preview' in argv else None
    bpy.ops.wm.read_factory_settings(use_empty=True)
    init_materials()
    objs = build()
    for o in objs:
        print(f'{o.name}: {tris(o)} tris')
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=os.path.abspath(out), export_format='GLB', export_apply=True, export_yup=True)
    if prev:
        os.makedirs(prev, exist_ok=True)
        preview(objs, prev)


main()
