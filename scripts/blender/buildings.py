"""
Buildings, furniture and props for Matcha's places.

  Blender -b --factory-startup -noaudio -P scripts/blender/buildings.py -- out.glb [preview.png]

Every asset is one top-level mesh object, origin at its base centre on the
ground (exceptions noted on the builder), front facing Blender -Y (three.js +Z).
Materials are named so the game can recolour them per copy: Paint (the
player's chosen colour), Trim, Wood, WoodDark, Metal, Gold, Glass, Lamp (glows
at night), Fabric, Fabric2, Stone, StoneDark, Roof, Leaf, Old, OldDark,
SignFace (gets the lettering texture). "Paint.cloth" is a double-sided Paint.
Wood grain comes from a per-plank tint stored as vertex colour (COLOR_0),
which three.js multiplies with the material colour, so recolouring keeps it.
"""
import bpy
import bmesh
import math
import random
import sys
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else 'public/models/buildings.glb'
PREVIEW = argv[1] if len(argv) > 1 else None

random.seed(7)
TAU = math.pi * 2

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
for m in list(bpy.data.meshes):
    bpy.data.meshes.remove(m)
for m in list(bpy.data.materials):
    bpy.data.materials.remove(m)

# --------------------------------------------------------------------------
# Materials
# --------------------------------------------------------------------------


def srgb(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]


MATS = {}
SPEC = {
    'Paint': ('#7cc6f2', 0.6, 0.0, False),
    'Paint.cloth': ('#ff9a8b', 0.85, 0.0, True),
    'Trim': ('#fbf7ef', 0.6, 0.0, False),
    'Wood': ('#c98b52', 0.8, 0.0, False),
    'WoodDark': ('#8a5e3c', 0.85, 0.0, False),
    'Metal': ('#3d3a40', 0.45, 0.6, False),
    'Gold': ('#e8c15a', 0.3, 0.8, False),
    'Glass': ('#bfe6ff', 0.05, 0.1, False),
    'Lamp': ('#ffd08a', 0.6, 0.0, False),
    'Fabric': ('#fbf7ef', 0.9, 0.0, True),
    'Fabric2': ('#ff5a4e', 0.8, 0.0, False),
    'Stone': ('#9a5a3d', 0.9, 0.0, False),
    'StoneDark': ('#6e625c', 0.9, 0.0, False),
    'Roof': ('#fbf7ef', 0.7, 0.0, False),
    'Leaf': ('#4f9a52', 0.8, 0.0, False),
    'Soil': ('#5a3f2c', 1.0, 0.0, False),
    'Old': ('#8a8378', 1.0, 0.0, False),
    'OldDark': ('#2b2622', 1.0, 0.0, False),
    'Ash': ('#3a3530', 1.0, 0.0, False),
    'Rock': ('#8d8a86', 0.95, 0.0, False),
    'SignFace': ('#ffffff', 0.7, 0.0, False),
}


def material(name):
    if name in MATS:
        return MATS[name]
    hexc, rough, metal, double = SPEC[name]
    m = bpy.data.materials.new(name)
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*srgb(hexc), 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    m.use_backface_culling = not double
    MATS[name] = m
    return m


# --------------------------------------------------------------------------
# Geometry helpers (each returns a fresh bmesh)
# --------------------------------------------------------------------------


def xf(bm, loc=(0, 0, 0), rot=(0, 0, 0), scale=None):
    m = Matrix.Translation(Vector(loc))
    m = m @ Matrix.Rotation(rot[2], 4, 'Z') @ Matrix.Rotation(rot[1], 4, 'Y') @ Matrix.Rotation(rot[0], 4, 'X')
    if scale:
        m = m @ Matrix.Diagonal((*scale, 1))
    bmesh.ops.transform(bm, matrix=m, verts=bm.verts[:])
    return bm


def bevel_sharp(bm, off, segs=2, angle=30):
    edges = [e for e in bm.edges if e.is_manifold and e.calc_face_angle(0) > math.radians(angle)]
    if edges and off > 0:
        bmesh.ops.bevel(bm, geom=edges, offset=off, segments=segs, affect='EDGES', profile=0.5, clamp_overlap=True)
    return bm


def box(sx, sy, sz, bevel=0.02, segs=1, loc=(0, 0, 0), rot=(0, 0, 0)):
    """A bevelled box, sized sx×sy×sz, centred at loc."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts[:])
    if bevel > 0:
        bevel_sharp(bm, min(bevel, min(sx, sy, sz) * 0.45), segs)
    return xf(bm, loc, rot)


def zbox(sx, sy, z0, z1, x=0, y=0, bevel=0.02, segs=1, rot=(0, 0, 0)):
    """A box from height z0 to z1."""
    return box(sx, sy, z1 - z0, bevel, segs, (x, y, (z0 + z1) / 2), rot)


def cyl(r1, r2, h, segs=16, bevel=0.0, bsegs=2, loc=(0, 0, 0), rot=(0, 0, 0)):
    """A cylinder/cone along Z, centred at loc."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs, radius1=r1, radius2=r2, depth=h)
    if bevel > 0:
        bevel_sharp(bm, bevel, bsegs, 40)
    return xf(bm, loc, rot)


def rod(a, b, r, segs=8, bevel=0.0):
    """A cylinder from point a to point b."""
    a, b = Vector(a), Vector(b)
    d = b - a
    bm = cyl(r, r, d.length, segs, bevel)
    q = Vector((0, 0, 1)).rotation_difference(d.normalized())
    bmesh.ops.transform(bm, matrix=Matrix.Translation((a + b) / 2) @ q.to_matrix().to_4x4(), verts=bm.verts[:])
    return bm


def sphere(r, u=12, v=8, loc=(0, 0, 0), scale=(1, 1, 1)):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=r)
    return xf(bm, loc, (0, 0, 0), scale)


def ico(r, sub=1, loc=(0, 0, 0), scale=(1, 1, 1), rot=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
    return xf(bm, loc, rot, scale)


def torus(R, r, nu=24, nv=8, a0=0.0, a1=TAU, loc=(0, 0, 0), rot=(0, 0, 0)):
    """A torus (or arc of one) in the XY plane."""
    bm = bmesh.new()
    full = abs(a1 - a0 - TAU) < 1e-6
    cols = nu if full else nu + 1
    rings = []
    for i in range(cols):
        a = a0 + (a1 - a0) * i / nu
        ring = []
        for j in range(nv):
            b = TAU * j / nv
            rr = R + r * math.cos(b)
            ring.append(bm.verts.new((rr * math.cos(a), rr * math.sin(a), r * math.sin(b))))
        rings.append(ring)
    for i in range(nu if full else nu):
        r0, r1 = rings[i], rings[(i + 1) % cols]
        for j in range(nv):
            bm.faces.new((r0[j], r1[j], r1[(j + 1) % nv], r0[(j + 1) % nv]))
    if not full:
        for ring in (rings[0], rings[-1]):
            bm.faces.new(ring)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return xf(bm, loc, rot)


def quad(w, h, loc=(0, 0, 0), uv=True):
    """A plane facing -Y (front), w wide (X) and h tall (Z), UV 0..1."""
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new('UVMap')
    vs = [bm.verts.new((x * w / 2, 0, z * h / 2)) for x, z in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    f = bm.faces.new(vs)
    if f.normal.y > 0:
        f.normal_flip()
    for loop in f.loops:
        co = loop.vert.co
        loop[uvl].uv = (co.x / w + 0.5, co.z / h + 0.5)
    return xf(bm, loc)


def grid_surface(fn, nu, nv):
    """A surface from fn(u, v) -> (x, y, z) over a (nu+1)×(nv+1) grid."""
    bm = bmesh.new()
    vs = [[bm.verts.new(fn(i / nu, j / nv)) for j in range(nv + 1)] for i in range(nu + 1)]
    for i in range(nu):
        for j in range(nv):
            bm.faces.new((vs[i][j], vs[i + 1][j], vs[i + 1][j + 1], vs[i][j + 1]))
    return bm


# --------------------------------------------------------------------------
# Assets
# --------------------------------------------------------------------------

ASSETS = []


class Asset:
    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.float_color.new('Color')
        self.uv = None
        self.mats = []

    def add(self, src, mat, tint=1.0, warm=0.0, jitter=0.0):
        """Merges a part in with a material and a wood-grain tint."""
        if mat not in self.mats:
            self.mats.append(mat)
        idx = self.mats.index(mat)
        src.verts.index_update()
        src.verts.ensure_lookup_table()
        vs = [self.bm.verts.new(v.co) for v in src.verts]
        vt = []
        for v in src.verts:
            n = math.sin(v.co.x * 9.1 + v.co.y * 7.3) * math.sin(v.co.z * 11.7 + v.co.x * 3.1)
            vt.append(tint * (1 + jitter * n))
        uvl = src.loops.layers.uv.active
        if uvl is not None and self.uv is None:
            self.uv = self.bm.loops.layers.uv.new('UVMap')
        for f in src.faces:
            try:
                nf = self.bm.faces.new([vs[v.index] for v in f.verts])
            except ValueError:
                continue
            nf.material_index = idx
            for ln, lo in zip(nf.loops, f.loops):
                t = vt[lo.vert.index]
                ln[self.col] = (t * (1 + warm * 0.08), t, t * (1 - warm * 0.1), 1.0)
                if uvl is not None and self.uv is not None:
                    ln[self.uv].uv = lo[uvl].uv
        src.free()
        return self

    def wood(self, src, mat='Wood', base=1.0, spread=0.12):
        """A plank: random warm tint and a few streaks of grain."""
        return self.add(src, mat, base * (1 - random.random() * spread), warm=random.uniform(-0.5, 1), jitter=0.05)

    def finish(self):
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(material(m))
        for p in me.polygons:
            p.use_smooth = True
        me.set_sharp_from_angle(angle=math.radians(38))
        if 'Color' in me.color_attributes:
            me.color_attributes.active_color = me.color_attributes['Color']
            me.color_attributes.render_color_index = me.color_attributes.find('Color')
        ob = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(ob)
        ASSETS.append(ob)
        return ob


def asset(fn):
    a = Asset(fn.__name__)
    fn(a)
    a.finish()
    return fn


# --- doors ------------------------------------------------------------------


@asset
def bld_door(a):
    """A 1.3 × 2.0 plank door in a chunky frame. Origin at the sill; the door's
    centre plane is y = 0 (sits in the wall)."""
    W, H = 1.3, 2.0
    n = 4
    pw = W / n
    for i in range(n):
        x = -W / 2 + pw * (i + 0.5)
        a.wood(zbox(pw - 0.012, 0.1, 0.0, H, x, 0, bevel=0.022, segs=2), 'Paint', 1.0, 0.1)
    for z in (0.42, 1.58):
        a.wood(zbox(W - 0.12, 0.05, z - 0.07, z + 0.07, 0, -0.07, bevel=0.018), 'Paint', 0.86, 0.04)
    # Iron strap hinges on the left.
    for z in (0.42, 1.58):
        a.add(zbox(0.5, 0.025, z - 0.035, z + 0.035, -0.4, -0.1, bevel=0.01), 'Metal')
        a.add(cyl(0.05, 0.05, 0.025, 10, loc=(-0.15, -0.1, z), rot=(math.pi / 2, 0, 0)), 'Metal')
    # Knob and plate.
    a.add(zbox(0.09, 0.02, 0.9, 1.12, 0.5, -0.065, bevel=0.008), 'Gold')
    a.add(sphere(0.06, 10, 6, (0.5, -0.12, 1.0)), 'Gold')
    # A little peephole window.
    a.add(cyl(0.16, 0.16, 0.03, 16, loc=(0, -0.055, 1.08), rot=(math.pi / 2, 0, 0)), 'Glass')
    a.add(torus(0.17, 0.035, 18, 6, loc=(0, -0.075, 1.08), rot=(math.pi / 2, 0, 0)), 'Gold')
    # Frame: jambs, header and a cap.
    for s in (-1, 1):
        a.add(zbox(0.17, 0.26, 0.0, 2.16, s * 0.73, 0, bevel=0.03, segs=2), 'Trim')
    a.add(zbox(1.8, 0.28, 2.0, 2.2, 0, 0, bevel=0.03), 'Trim')
    a.add(zbox(1.96, 0.34, 2.2, 2.28, 0, -0.01, bevel=0.025), 'Trim')
    # Doorstep.
    a.add(zbox(1.6, 0.36, -0.06, 0.02, 0, -0.12, bevel=0.02), 'StoneDark')


@asset
def bld_door_old(a):
    """A grey, broken 1.2 × 1.9 door (lies wherever it fell). Origin at its base."""
    W, H = 1.2, 1.9
    n = 4
    pw = W / n
    for i in range(n):
        x = -W / 2 + pw * (i + 0.5)
        h = H - (0.35 if i == 2 else 0.0) - (0.12 if i == 0 else 0)
        a.wood(zbox(pw - 0.03, 0.08, 0.0, h, x, 0, bevel=0.015, segs=1, rot=(0, (i - 1.5) * 0.015, 0)), 'Old', 1.0, 0.18)
    a.wood(zbox(W - 0.05, 0.05, 0.4, 0.52, 0, -0.06, bevel=0.012, rot=(0, 0.05, 0)), 'Old', 0.85)
    a.wood(zbox(W * 0.7, 0.05, 1.42, 1.54, -0.15, -0.06, bevel=0.012, rot=(0, -0.12, 0)), 'Old', 0.85)
    a.add(zbox(0.32, 0.025, 0.43, 0.5, -0.42, -0.095, bevel=0.008), 'Metal', 0.8)
    for x, z in ((0.3, 0.46), (-0.2, 1.48), (0.1, 1.5)):
        a.add(sphere(0.022, 6, 4, (x, -0.09, z)), 'Metal', 0.8)


# --- windows ----------------------------------------------------------------


@asset
def bld_window(a):
    """A 1.6 × 1.2 framed window; origin at the bottom, centre at z 0.6, centre
    plane at y 0."""
    W, H = 1.6, 1.2
    c = 0.6
    fw = 0.15
    for s in (-1, 1):
        a.add(zbox(fw, 0.22, 0, H, s * (W / 2 - fw / 2), 0, bevel=0.03), 'Trim')
    a.add(zbox(W, 0.22, H - fw, H, 0, 0, bevel=0.03), 'Trim')
    a.add(zbox(W, 0.22, 0, fw, 0, 0, bevel=0.03), 'Trim')
    a.add(box(W - 0.2, 0.04, H - 0.2, 0, loc=(0, 0, c)), 'Glass')
    a.add(box(0.06, 0.1, H - 0.2, 0.015, loc=(0, 0, c)), 'Trim')
    a.add(box(W - 0.2, 0.1, 0.06, 0.015, loc=(0, 0, c)), 'Trim')
    # Sill and head.
    a.add(zbox(W + 0.24, 0.38, -0.08, 0.03, 0, -0.09, bevel=0.03), 'Trim')
    a.add(zbox(W + 0.18, 0.3, H - 0.02, H + 0.08, 0, -0.04, bevel=0.03), 'Trim')
    a.add(zbox(W + 0.06, 0.14, -0.16, -0.08, 0, -0.04, bevel=0.02), 'Trim', 0.9)


@asset
def bld_window_old(a):
    """A boarded-up window hole, same placement as bld_window."""
    a.add(box(1.32, 0.05, 1.02, 0, loc=(0, 0.02, 0.6)), 'OldDark')
    for r, z, l in ((0.55, 0.62, 1.7), (-0.5, 0.58, 1.65), (0.04, 0.95, 1.5)):
        a.wood(box(l, 0.06, 0.17, 0.015, 1, loc=(0, -0.06, z), rot=(0, r, 0)), 'Old', 1.0, 0.2)
    for x, z in ((-0.62, 0.12), (0.62, 0.12), (-0.62, 1.1), (0.62, 1.1), (-0.66, 0.94), (0.66, 0.96)):
        a.add(sphere(0.025, 6, 4, (x, -0.1, z)), 'Metal')
    # What's left of the frame.
    a.add(zbox(0.12, 0.2, 0.0, 1.1, -0.74, 0, bevel=0.02, rot=(0, 0.04, 0)), 'Old', 0.8)
    a.add(zbox(1.7, 0.3, -0.08, 0.02, 0, -0.06, bevel=0.02, rot=(0, -0.03, 0)), 'Old', 0.75)


@asset
def bld_window_round(a):
    """A round porthole window, radius ~0.55; origin at the bottom, centre z 0.55."""
    c = 0.55
    rx = (math.pi / 2, 0, 0)
    a.add(cyl(0.45, 0.45, 0.04, 24, loc=(0, 0, c), rot=rx), 'Glass')
    a.add(torus(0.47, 0.085, 28, 8, loc=(0, -0.02, c), rot=rx), 'Trim')
    a.add(box(0.05, 0.08, 0.9, 0.01, loc=(0, 0, c)), 'Trim')
    a.add(box(0.9, 0.08, 0.05, 0.01, loc=(0, 0, c)), 'Trim')
    a.add(zbox(0.5, 0.2, -0.02, 0.06, 0, -0.08, bevel=0.025), 'Trim')
    a.add(sphere(0.05, 8, 6, (0, -0.1, c + 0.55)), 'Gold')


@asset
def bld_window_round_old(a):
    """A boarded-up porthole, same placement as bld_window_round."""
    c = 0.55
    a.add(cyl(0.45, 0.45, 0.04, 20, loc=(0, 0.01, c), rot=(math.pi / 2, 0, 0)), 'OldDark')
    a.wood(box(1.0, 0.05, 0.15, 0.012, 1, loc=(0, -0.04, c), rot=(0, 0.5, 0)), 'Old', 1.0, 0.2)
    a.wood(box(0.8, 0.05, 0.14, 0.012, 1, loc=(0.05, -0.08, c + 0.1), rot=(0, -0.35, 0)), 'Old', 0.9, 0.2)
    for x, z in ((-0.38, c - 0.2), (0.38, c + 0.2), (-0.3, c + 0.25)):
        a.add(sphere(0.022, 6, 4, (x, -0.1, z)), 'Metal')


@asset
def bld_shutters(a):
    """A pair of louvred shutters for bld_window (1.5 opening): same origin and
    centre as the window, opened flat against the wall at y -0.12."""
    sw, sh = 0.42, 1.1
    for s in (-1, 1):
        x = s * (0.82 + sw / 2)
        y = -0.12
        for xx in (-1, 1):
            a.add(zbox(0.07, 0.05, 0.05, 0.05 + sh, x + xx * (sw / 2 - 0.035), y, bevel=0.015), 'Paint')
        for z in (0.05, 0.05 + sh / 2 - 0.035, 0.05 + sh - 0.07):
            a.add(zbox(sw, 0.05, z, z + 0.07, x, y, bevel=0.015), 'Paint')
        for k in range(2):
            z0 = 0.12 + k * (sh / 2 - 0.02)
            for i in range(5):
                z = z0 + 0.045 + i * 0.095
                a.add(box(sw - 0.12, 0.012, 0.085, 0.0, 1, loc=(x, y, z), rot=(0.55, 0, 0)), 'Paint', 0.88)
        for z in (0.25, 0.95):
            a.add(zbox(0.1, 0.03, z - 0.02, z + 0.02, x - s * (sw / 2 - 0.02), y + 0.01, bevel=0.008), 'Metal')


@asset
def bld_flowerbox(a):
    """A 1.4-wide window box with blooms (Paint) and leaves. Origin at the base."""
    W, D, H = 1.4, 0.3, 0.25
    for z in (0.0, 0.125):
        a.wood(zbox(W, 0.04, z, z + 0.12, 0, -D / 2 + 0.02, bevel=0.012), 'Wood')
    for s in (-1, 1):
        a.wood(zbox(0.04, D, 0.0, H, s * (W / 2 - 0.02), 0, bevel=0.012), 'Wood')
        a.add(zbox(0.07, 0.07, -0.02, H + 0.02, s * (W / 2 - 0.02), -D / 2 + 0.02, bevel=0.015), 'WoodDark')
    a.wood(zbox(W - 0.06, 0.04, 0.0, H, 0, D / 2 - 0.02, bevel=0.012), 'Wood', 0.9)
    a.add(zbox(W - 0.06, D - 0.06, 0, 0.21, 0, 0, bevel=0), 'Soil')
    for i in range(9):
        x = -0.6 + i * 0.15
        a.add(ico(0.1, 1, (x, (i % 2) * 0.06 - 0.03, 0.26), (1.3, 1, 0.65), (0, 0, i)), 'Leaf', 0.85 + (i % 3) * 0.08)
    for i in range(6):
        x = -0.55 + i * 0.22
        z = 0.36 + (i % 2) * 0.05
        y = -0.04 + (i % 2) * 0.05
        for p in range(5):
            ang = p * TAU / 5 + i
            a.add(ico(0.05, 0, (x + math.cos(ang) * 0.05, y - 0.02, z + math.sin(ang) * 0.05), (1, 0.6, 1)), 'Paint')
        a.add(ico(0.032, 0, (x, y - 0.045, z)), 'Gold')


@asset
def bld_chimney(a):
    """A 0.7-square brick chimney 1.8 tall with a crown and pots. Origin at the base."""
    a.add(zbox(0.64, 0.64, 0, 1.6, bevel=0.03), 'Stone', 0.85)
    # Brick courses: bricks proud of the core, staggered.
    for k in range(7):
        z = 0.12 + k * 0.21
        off = 0.08 if k % 2 else -0.08
        for face in range(4):
            for i in (-1, 0, 1):
                u = i * 0.23 + off
                if abs(u) > 0.3:
                    continue
                t = 1.0 - random.random() * 0.16
                bw = 0.2
                rot = face * math.pi / 2
                px, py = u, -0.33
                c, s = math.cos(rot), math.sin(rot)
                a.add(box(bw, 0.04, 0.17, 0.0, 1, loc=(px * c - py * s, px * s + py * c, z), rot=(0, 0, rot)), 'Stone', t, warm=random.uniform(-1, 1))
    a.add(zbox(0.84, 0.84, 1.56, 1.7, bevel=0.035), 'StoneDark')
    a.add(zbox(0.74, 0.74, 1.7, 1.78, bevel=0.025), 'StoneDark', 0.9)
    for x in (-0.15, 0.17):
        a.add(cyl(0.12, 0.1, 0.24, 14, 0.02, loc=(x, 0.02, 1.9)), 'Stone', 1.1, warm=1)
        a.add(torus(0.11, 0.03, 14, 6, loc=(x, 0.02, 2.02)), 'Stone', 1.15, warm=1)


# --- shop furniture -----------------------------------------------------------


@asset
def prop_counter(a):
    """The shop counter: 3.4 × 0.9, worktop surface at z 1.45. Paint is the
    board front, Trim the worktop."""
    W, D = 3.2, 0.7
    a.add(zbox(W - 0.1, D - 0.1, 0.0, 0.12, bevel=0.02), 'WoodDark')
    a.add(zbox(W - 0.06, D - 0.06, 0.1, 1.36, bevel=0.0), 'Paint', 0.8)
    n = 10
    for i in range(n):
        x = -W / 2 + 0.12 + (W - 0.24) * (i + 0.5) / n
        a.wood(zbox((W - 0.24) / n - 0.015, 0.05, 0.14, 1.22, x, -D / 2 - 0.01, bevel=0.015), 'Paint', 1.0, 0.1)
    for sx in (-1, 1):
        for sy in (-1, 1):
            a.add(zbox(0.13, 0.13, 0.0, 1.36, sx * (W / 2 - 0.04), sy * (D / 2 - 0.04), bevel=0.03), 'Wood')
    a.wood(zbox(W, 0.08, 1.22, 1.35, 0, -D / 2 - 0.01, bevel=0.025), 'Wood', 0.95)
    a.wood(zbox(W, 0.08, 0.1, 0.2, 0, -D / 2 - 0.01, bevel=0.025), 'Wood', 0.9)
    a.add(zbox(3.4, 0.9, 1.35, 1.45, 0, -0.03, bevel=0.035, segs=3), 'Trim')
    # A little hanging menu board on the front.
    a.add(zbox(0.7, 0.04, 0.5, 0.95, 0.95, -D / 2 - 0.07, bevel=0.02), 'WoodDark')
    a.add(zbox(0.6, 0.02, 0.56, 0.89, 0.95, -D / 2 - 0.09, bevel=0.0), 'Ash')
    for i, w in enumerate((0.4, 0.3, 0.36)):
        a.add(zbox(w, 0.01, 0.8 - i * 0.09, 0.82 - i * 0.09, 0.95 - (0.4 - w) / 2, -D / 2 - 0.105, bevel=0), 'Trim')


@asset
def prop_kitchen(a):
    """A 1.2 × 0.8 worktable, top at z 0.9, with jars on a lower shelf."""
    W, D = 1.2, 0.8
    for i in range(3):
        y = -D / 2 + D * (i + 0.5) / 3
        a.wood(zbox(W, D / 3 - 0.01, 0.82, 0.9, 0, y, bevel=0.018), 'Wood')
    for sx in (-1, 1):
        for sy in (-1, 1):
            a.add(zbox(0.08, 0.08, 0, 0.82, sx * (W / 2 - 0.08), sy * (D / 2 - 0.08), bevel=0.02), 'WoodDark')
    a.add(zbox(W - 0.08, 0.06, 0.7, 0.8, 0, -D / 2 + 0.08, bevel=0.015), 'WoodDark')
    for i in range(3):
        y = -D / 2 + 0.1 + (D - 0.2) * (i + 0.5) / 3
        a.wood(zbox(W - 0.1, (D - 0.2) / 3 - 0.01, 0.22, 0.26, 0, y, bevel=0.01), 'Wood', 0.9)
    for x, h, m in ((-0.35, 0.24, 'Glass'), (-0.12, 0.18, 'Glass')):
        a.add(cyl(0.08, 0.08, h, 14, 0.015, loc=(x, 0, 0.26 + h / 2)), m)
        a.add(cyl(0.085, 0.085, 0.04, 14, 0.01, loc=(x, 0, 0.28 + h)), 'Fabric2')
    a.add(sphere(0.18, 12, 8, (0.28, 0.02, 0.4), (1.1, 0.9, 0.85)), 'Fabric', 0.92)
    a.add(torus(0.08, 0.025, 12, 6, loc=(0.28, 0.02, 0.56)), 'WoodDark')


@asset
def prop_table(a):
    """A round café table: top r 0.65 at z 0.81–0.89 (Paint), white pedestal."""
    a.add(cyl(0.65, 0.65, 0.08, 32, 0.03, 3, loc=(0, 0, 0.85)), 'Paint')
    a.add(cyl(0.56, 0.56, 0.05, 28, 0.0, loc=(0, 0, 0.785)), 'Paint', 0.8)
    a.add(cyl(0.12, 0.08, 0.06, 16, 0.01, loc=(0, 0, 0.73)), 'Trim')
    a.add(cyl(0.055, 0.055, 0.66, 12, loc=(0, 0, 0.38)), 'Trim')
    a.add(cyl(0.1, 0.12, 0.08, 16, 0.02, loc=(0, 0, 0.1)), 'Trim')
    for i in range(4):
        ang = i * math.pi / 2 + math.pi / 4
        a.add(box(0.5, 0.08, 0.05, 0.02, 2, loc=(math.cos(ang) * 0.22, math.sin(ang) * 0.22, 0.03), rot=(0, 0, ang)), 'Trim')
        a.add(sphere(0.04, 8, 5, (math.cos(ang) * 0.45, math.sin(ang) * 0.45, 0.02), (1, 1, 0.6)), 'Metal')


@asset
def prop_stool(a):
    """A round stool: cushioned seat r 0.25, top at z 0.55 (Paint)."""
    a.add(cyl(0.26, 0.25, 0.08, 24, 0.035, 3, loc=(0, 0, 0.51)), 'Paint')
    a.add(cyl(0.2, 0.2, 0.04, 18, 0.0, loc=(0, 0, 0.455)), 'Trim')
    pts = []
    for i in range(3):
        ang = i * TAU / 3 + 0.5
        top = (math.cos(ang) * 0.14, math.sin(ang) * 0.14, 0.45)
        bot = (math.cos(ang) * 0.22, math.sin(ang) * 0.22, 0.0)
        a.add(rod(top, bot, 0.025, 8), 'Trim')
        pts.append(ang)
    a.add(torus(0.18, 0.015, 24, 5, loc=(0, 0, 0.17)), 'Trim')


@asset
def prop_parasol(a):
    """A beach parasol: pole 2.75 tall, scalloped canopy rim r 1.6 at z 2.42,
    apex at z 3.0. Panels alternate Paint.cloth and Fabric."""
    R, apex, rim, n = 1.6, 3.0, 2.42, 8
    a.add(cyl(0.035, 0.035, 2.95, 10, loc=(0, 0, 1.475)), 'Trim')
    a.add(cyl(0.06, 0.06, 0.08, 10, 0.01, loc=(0, 0, 1.3)), 'Metal')
    a.add(sphere(0.07, 10, 6, (0, 0, apex + 0.06)), 'Trim')
    a.add(cyl(0.06, 0.04, 0.1, 10, loc=(0, 0, 2.86)), 'Trim')
    for i in range(n):
        a0, a1 = i * TAU / n, (i + 1) * TAU / n
        mat = 'Paint.cloth' if i % 2 == 0 else 'Fabric'

        def fn(u, v, a0=a0, a1=a1):
            ang = a0 + (a1 - a0) * v
            sv = math.sin(math.pi * v)
            t = max(u, 0.002)
            r = R * t * (1 - 0.05 * sv)
            z = apex - (apex - rim) * t ** 1.15 - 0.07 * sv * t
            return (r * math.cos(ang), r * math.sin(ang), z)

        a.add(grid_surface(fn, 6, 5), mat)

        def flap(u, v, a0=a0, a1=a1):
            ang = a0 + (a1 - a0) * v
            sv = math.sin(math.pi * v)
            r = R * (1 - 0.05 * sv)
            z = rim - 0.07 * sv - u * (0.08 + 0.1 * sv)
            return (r * math.cos(ang), r * math.sin(ang), z)

        a.add(grid_surface(flap, 1, 6), mat)
        # A rib under each seam.
        rib_a = a0
        a.add(rod((0, 0, 2.84), (math.cos(rib_a) * R * 0.97, math.sin(rib_a) * R * 0.97, rim - 0.01), 0.013, 4), 'Trim')
        a.add(sphere(0.025, 6, 4, (math.cos(rib_a) * R, math.sin(rib_a) * R, rim - 0.02)), 'Trim')


@asset
def prop_awning(a):
    """A striped awning 4 wide (scale X for other widths): back edge at y 0.8
    z 2.75, front edge y -0.8 z 2.35, scalloped valance. No poles. Stripes
    alternate Paint.cloth and Fabric."""
    W, n = 4.0, 8
    sw = W / n
    for i in range(n):
        x0 = -W / 2 + i * sw
        mat = 'Paint.cloth' if i % 2 == 0 else 'Fabric'

        def fn(u, v, x0=x0):
            y = 0.8 - 1.6 * v
            z = 2.75 - 0.4 * v + 0.06 * math.sin(math.pi * v)
            return (x0 + sw * u, y, z - 0.025 * math.sin(math.pi * u))

        a.add(grid_surface(fn, 3, 4), mat)

        def flap(u, v, x0=x0):
            su = math.sin(math.pi * u)
            return (x0 + sw * u, -0.8, 2.35 - v * (0.1 + 0.12 * su) - 0.025 * su)

        a.add(grid_surface(flap, 6, 1), mat)
    a.add(rod((-W / 2, 0.82, 2.76), (W / 2, 0.82, 2.76), 0.05, 10), 'WoodDark')
    a.add(rod((-W / 2, -0.8, 2.34), (W / 2, -0.8, 2.34), 0.03, 8), 'Trim')


@asset
def prop_pole(a):
    """A wooden pole 2.5 tall with a knob on top (awning and light poles)."""
    a.wood(cyl(0.06, 0.065, 2.45, 10, 0.01, loc=(0, 0, 1.225)), 'WoodDark', 1.0, 0.05)
    a.add(sphere(0.085, 10, 6, (0, 0, 2.5)), 'WoodDark', 0.85)
    a.add(cyl(0.075, 0.075, 0.06, 10, 0.01, loc=(0, 0, 2.38)), 'Metal')
    a.add(cyl(0.08, 0.1, 0.1, 10, 0.02, loc=(0, 0, 0.04)), 'WoodDark', 0.8)


@asset
def prop_lantern(a):
    """A hanging paper lantern. Origin at the TOP hook (it swings from there);
    body (Lamp, glows at night) centre at z -0.51, about 0.56 wide."""
    a.add(torus(0.04, 0.012, 10, 4, loc=(0, 0, -0.03), rot=(math.pi / 2, 0, 0)), 'Metal')
    a.add(cyl(0.13, 0.13, 0.08, 14, 0.015, loc=(0, 0, -0.11)), 'Metal')
    a.add(sphere(0.28, 16, 10, (0, 0, -0.51), (1, 1, 1.25)), 'Lamp')
    for k in range(1, 6):
        t = -1 + k / 3
        if abs(t) >= 1:
            continue
        r = 0.285 * math.sqrt(1 - t * t)
        a.add(torus(r, 0.008, 18, 4, loc=(0, 0, -0.51 + t * 0.35)), 'WoodDark')
    a.add(cyl(0.11, 0.11, 0.06, 14, 0.012, loc=(0, 0, -0.89)), 'Metal')
    a.add(cyl(0.012, 0.012, 0.12, 4, loc=(0, 0, -0.98)), 'Fabric2')
    a.add(cyl(0.02, 0.05, 0.12, 8, loc=(0, 0, -1.08)), 'Fabric2')


@asset
def prop_lamp_post(a):
    """A wooden lamp post 2.7 tall with an iron lantern (Lamp glows) hanging
    from an arm out front; the lantern's centre is at (0, -0.4, 2.3)."""
    a.add(zbox(0.32, 0.32, 0, 0.2, bevel=0.04), 'StoneDark')
    a.wood(zbox(0.13, 0.13, 0.15, 2.7, bevel=0.03), 'WoodDark', 1.0, 0.05)
    a.add(zbox(0.18, 0.18, 2.66, 2.76, bevel=0.03), 'WoodDark', 0.85)
    a.add(sphere(0.07, 10, 6, (0, 0, 2.8)), 'Gold')
    a.wood(zbox(0.08, 0.55, 2.52, 2.6, 0, -0.28, bevel=0.02), 'WoodDark', 0.95)
    a.add(rod((0, -0.06, 2.3), (0, -0.4, 2.54), 0.02, 6), 'Metal')
    a.add(rod((0, -0.4, 2.52), (0, -0.4, 2.62), 0.012, 4), 'Metal')
    y, c = -0.4, 2.3
    a.add(box(0.2, 0.2, 0.26, 0.0, loc=(0, y, c)), 'Lamp')
    for sx in (-1, 1):
        for sy in (-1, 1):
            a.add(box(0.03, 0.03, 0.28, 0.006, 1, loc=(sx * 0.105, y + sy * 0.105, c)), 'Metal')
    a.add(zbox(0.26, 0.26, c - 0.17, c - 0.13, 0, y, bevel=0.012), 'Metal')
    a.add(cyl(0.2, 0.04, 0.14, 4, loc=(0, y, c + 0.2), rot=(0, 0, math.pi / 4)), 'Metal')
    a.add(sphere(0.03, 6, 4, (0, y, c + 0.28)), 'Metal')


@asset
def prop_sign(a):
    """The shop sign: board 3.2 × 0.9 (Paint) with a chunky wooden frame and a
    4:1 lettering face (SignFace, UV 0..1) facing front, iron brackets back to
    the wall 0.3 behind. Origin at the bottom; face centre at z 0.45."""
    c = 0.45
    a.add(box(3.1, 0.1, 0.84, 0.03, 2, loc=(0, 0.02, c)), 'Paint')
    a.add(quad(2.96, 0.74, (0, -0.035, c)), 'SignFace')
    for z in (c - 0.41, c + 0.41):
        a.wood(box(3.2, 0.1, 0.09, 0.035, 2, loc=(0, -0.02, z)), 'Wood')
    for s in (-1, 1):
        a.wood(box(0.09, 0.1, 0.9, 0.035, 2, loc=(s * 1.555, -0.02, c)), 'Wood')
        a.add(sphere(0.04, 8, 5, (s * 1.555, -0.075, c + 0.41)), 'Gold')
        a.add(sphere(0.04, 8, 5, (s * 1.555, -0.075, c - 0.41)), 'Gold')
    for x in (-1.1, 1.1):
        a.add(rod((x, 0.05, c + 0.3), (x, 0.32, c + 0.3), 0.025, 6), 'Metal')
        a.add(rod((x, 0.06, c + 0.3), (x, 0.32, c + 0.62), 0.02, 6), 'Metal')
        a.add(zbox(0.12, 0.03, c + 0.2, c + 0.7, x, 0.32, bevel=0.01), 'Metal')


# --- outdoors -----------------------------------------------------------------


@asset
def prop_firepit(a):
    """A fire pit: ring of stones r 0.75, ash bed and crossed logs (flames are
    added by the game)."""
    a.add(cyl(0.68, 0.68, 0.04, 24, 0.0, loc=(0, 0, 0.02)), 'Ash')
    for i in range(10):
        ang = i * TAU / 10 + random.uniform(-0.08, 0.08)
        r = 0.75 + random.uniform(-0.04, 0.04)
        s = random.uniform(0.18, 0.24)
        a.add(ico(s, 2, (math.cos(ang) * r, math.sin(ang) * r, s * 0.45), (1.25, 1.0, 0.75), (random.random(), random.random(), ang)), 'Rock', random.uniform(0.85, 1.05))
    for i in range(4):
        ang = i * math.pi / 2 + 0.3
        out = (math.cos(ang) * 0.5, math.sin(ang) * 0.5, 0.06)
        mid = (math.cos(ang) * 0.05, math.sin(ang) * 0.05, 0.42)
        a.add(rod(out, mid, 0.075, 8, 0.015), 'WoodDark', random.uniform(0.85, 1))
        a.add(cyl(0.065, 0.065, 0.02, 8, loc=out), 'Wood')
    for i in range(6):
        ang = i * 1.1
        a.add(ico(0.06, 0, (math.cos(ang) * 0.25, math.sin(ang) * 0.25, 0.06)), 'Ash', 0.7)


@asset
def prop_crate(a):
    """A slatted crate 0.8 × 0.8 × 0.6, open top. Wood takes the colour."""
    S, H = 0.8, 0.6
    for face in range(4):
        rot = face * math.pi / 2
        c, s = math.cos(rot), math.sin(rot)
        for k in range(3):
            z = 0.03 + k * 0.19
            px, py = 0, -S / 2 + 0.025
            a.wood(box(S - 0.1, 0.04, 0.16, 0.015, 1, loc=(px * c - py * s, px * s + py * c, z + 0.08), rot=(0, 0, rot)), 'Wood')
        px, py = 0, -S / 2 - 0.005
        a.add(box(0.1, 0.03, 0.55, 0.012, 1, loc=(px * c - py * s, px * s + py * c, 0.3), rot=(0.0, 0.9, rot)), 'Wood', 0.82)
    for sx in (-1, 1):
        for sy in (-1, 1):
            a.add(zbox(0.08, 0.08, 0, H, sx * (S / 2 - 0.04), sy * (S / 2 - 0.04), bevel=0.015), 'WoodDark')
    a.add(zbox(S - 0.06, S - 0.06, 0.0, 0.04, bevel=0), 'WoodDark', 0.8)


@asset
def prop_crate_lid(a):
    """A loose plank lid for prop_crate, 0.85 square."""
    for i in range(4):
        x = -0.32 + i * 0.213
        a.wood(zbox(0.2, 0.85, 0.0, 0.05, x, 0, bevel=0.012), 'Wood')
    for y in (-0.28, 0.28):
        a.wood(zbox(0.8, 0.1, 0.05, 0.08, 0, y, bevel=0.012), 'Wood', 0.85)


@asset
def prop_crate_old(a):
    """A smashed, weathered crate (beach junk), about 0.9 wide."""
    for k in range(4):
        if k == 2:
            continue
        for i in range(3):
            if k == 3 and i == 1:
                continue
            y = -0.3 + i * 0.3
            a.wood(zbox(0.9, 0.26, k * 0.25, k * 0.25 + 0.06, 0, y, bevel=0.012, rot=(0.0, 0.35 if k == 3 else 0.02 * i, 0)), 'Old', 1.05, 0.2)
    a.wood(zbox(0.1, 0.9, 0.0, 0.8, 0.4, 0, bevel=0.015, rot=(0, 0.2, 0)), 'Old', 0.85)
    for sx, sy in ((-1, -1), (-1, 1), (1, 1)):
        a.add(zbox(0.07, 0.07, 0, 0.55 if sx < 0 else 0.35, sx * 0.42, sy * 0.42, bevel=0.012), 'Old', 0.7)
    for x, y in ((-0.3, 0.1), (0.1, -0.35), (0.25, 0.3)):
        a.add(sphere(0.025, 6, 4, (x, y, 0.07)), 'Metal')


@asset
def prop_barrel(a):
    """A wooden barrel, 0.9 tall, r ~0.36, with iron hoops."""
    n = 14
    H = 0.9
    for i in range(n):
        ang = i * TAU / n
        w = TAU / n * 0.97

        def stave(u, v, ang=ang, w=w):
            z = H * u
            bulge = 0.3 + 0.06 * math.sin(math.pi * u)
            aa = ang + w * (v - 0.5)
            return (math.cos(aa) * bulge, math.sin(aa) * bulge, z)

        bm = grid_surface(stave, 6, 1)
        bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=0.03)
        a.wood(bm, 'Wood')
    for z in (0.12, 0.78):
        a.add(torus(0.3 + 0.06 * math.sin(math.pi * z / H) + 0.008, 0.018, 28, 4, loc=(0, 0, z)), 'Metal')
    a.add(cyl(0.3, 0.3, 0.03, 20, loc=(0, 0, H - 0.04)), 'WoodDark')
    a.add(cyl(0.3, 0.3, 0.03, 20, loc=(0, 0, 0.04)), 'WoodDark')


@asset
def prop_lounger(a):
    """A beach lounger 0.8 × 2.1: flat bed from y -1.0 to 0.3, backrest rising
    to y 0.95 at the back (+Y); cushion (Paint.cloth) top at ~z 0.5."""
    W = 0.8
    for s in (-1, 1):
        a.wood(zbox(0.06, 1.35, 0.33, 0.41, s * (W / 2 - 0.03), -0.35, bevel=0.015), 'WoodDark')
    for i in range(9):
        y = -0.98 + i * 0.145
        a.wood(zbox(W - 0.04, 0.12, 0.4, 0.44, 0, y, bevel=0.015, segs=1), 'Wood')
    back_ang = math.radians(48)
    by, bz = 0.32, 0.42
    for i in range(6):
        d = 0.08 + i * 0.13
        a.wood(box(W - 0.06, 0.11, 0.04, 0.015, 2, loc=(0, by + math.cos(back_ang) * d, bz + math.sin(back_ang) * d), rot=(back_ang, 0, 0)), 'Wood')
    for s in (-1, 1):
        a.add(box(0.05, 0.9, 0.05, 0.012, 1, loc=(s * (W / 2 - 0.05), by + math.cos(back_ang) * 0.42, bz - 0.03 + math.sin(back_ang) * 0.42), rot=(back_ang, 0, 0)), 'WoodDark')
        a.add(rod((s * (W / 2 - 0.05), 0.62, 0.38), (s * (W / 2 - 0.05), 0.62, 0.7), 0.025, 6), 'WoodDark')
    for sx in (-1, 1):
        for y in (-0.88, 0.2):
            a.add(zbox(0.07, 0.07, 0, 0.36, sx * (W / 2 - 0.05), y, bevel=0.015), 'WoodDark')
    a.add(zbox(W - 0.1, 1.24, 0.44, 0.52, 0, -0.36, bevel=0.035, segs=3), 'Paint.cloth')
    a.add(box(W - 0.12, 0.62, 0.07, 0.03, 3, loc=(0, by + math.cos(back_ang) * 0.36, bz + 0.06 + math.sin(back_ang) * 0.36), rot=(back_ang, 0, 0)), 'Paint.cloth')
    a.add(sphere(0.17, 12, 8, (0, by + math.cos(back_ang) * 0.6 - 0.05, bz + 0.15 + math.sin(back_ang) * 0.6), (1.6, 0.6, 0.7)), 'Fabric')


@asset
def prop_tower(a):
    """A lookout tower: deck top at z 2.48 (1.8 square), open-front hut
    (Paint) with a pointed roof (Roof), ladder at the front."""
    for sx in (-1, 1):
        for sy in (-1, 1):
            a.add(rod((sx * 0.8, sy * 0.8, 0), (sx * 0.7, sy * 0.7, 2.35), 0.075, 8, 0.0), 'Trim')
            a.add(cyl(0.12, 0.14, 0.12, 10, 0.02, loc=(sx * 0.8, sy * 0.8, 0.06)), 'StoneDark')
    for s in (-1, 1):
        a.add(rod((s * 0.79, -0.79, 0.3), (s * 0.71, 0.71, 1.9), 0.035, 6), 'Trim', 0.92)
        a.add(rod((-0.79, s * 0.79, 0.3), (0.71, s * 0.71, 1.9), 0.035, 6), 'Trim', 0.92)
    a.add(zbox(1.66, 1.66, 2.2, 2.32, bevel=0.02), 'WoodDark')
    for i in range(7):
        x = -0.9 + (i + 0.5) * (1.8 / 7)
        a.wood(zbox(1.8 / 7 - 0.015, 1.9, 2.36, 2.48, x, 0, bevel=0.018, segs=1), 'Wood')
    # Hut: back and side walls, corner posts, a front rail.
    for sx in (-1, 1):
        for sy in (-1, 1):
            a.add(zbox(0.12, 0.12, 2.48, 3.58, sx * 0.72, sy * 0.72, bevel=0.03), 'Paint', 0.85)
    for i in range(6):
        x = -0.66 + (i + 0.5) * (1.32 / 6)
        a.wood(zbox(1.32 / 6 - 0.012, 0.06, 2.48, 3.5, x, 0.72, bevel=0.015), 'Paint', 1.0, 0.08)
    for s in (-1, 1):
        for i in range(6):
            y = -0.66 + (i + 0.5) * (1.32 / 6)
            a.wood(zbox(0.06, 1.32 / 6 - 0.012, 2.48, 3.0, s * 0.72, y, bevel=0.015), 'Paint', 1.0, 0.08)
        a.add(zbox(0.1, 1.5, 3.0, 3.08, s * 0.72, 0, bevel=0.02), 'Trim')
    a.add(zbox(1.56, 0.1, 3.0, 3.08, 0, -0.72, bevel=0.02), 'Trim')
    a.add(zbox(1.56, 0.12, 3.5, 3.6, 0, -0.72, bevel=0.02), 'Paint', 0.85)
    a.add(zbox(1.6, 1.6, 3.58, 3.66, bevel=0.02), 'Trim')
    a.add(cyl(1.38, 0.05, 0.72, 4, 0.03, loc=(0, 0, 3.66 + 0.36), rot=(0, 0, math.pi / 4)), 'Roof')
    a.add(rod((0, 0, 4.3), (0, 0, 4.75), 0.018, 6), 'Metal')
    flag = bmesh.new()
    vs = [flag.verts.new(p) for p in ((0, 0, 4.72), (0.36, 0, 4.63), (0, 0, 4.52))]
    flag.faces.new(vs)
    a.add(flag, 'Fabric2')
    # Ladder up the front.
    for s in (-1, 1):
        a.add(rod((s * 0.3, -1.45, 0.0), (s * 0.3, -0.92, 2.45), 0.04, 8), 'WoodDark')
    for k in range(7):
        t = (k + 0.6) / 7.6
        a.wood(rod((-0.3, -1.45 + 0.53 * t, 2.45 * t), (0.3, -1.45 + 0.53 * t, 2.45 * t), 0.03, 6), 'Wood')


@asset
def prop_buoy(a):
    """A ring buoy, r 0.3, red and white quarters; origin at its centre, facing front."""
    for q in range(4):
        a.add(torus(0.3, 0.09, 8, 8, q * math.pi / 2, (q + 1) * math.pi / 2, rot=(math.pi / 2, 0, 0)), 'Fabric2' if q % 2 == 0 else 'Fabric')
    for k in range(4):
        ang = k * math.pi / 2 + math.pi / 4
        a.add(torus(0.1, 0.012, 8, 4, loc=(math.cos(ang) * 0.3, 0, math.sin(ang) * 0.3), rot=(0, 0, ang + math.pi / 2)), 'Trim', 0.9)


@asset
def prop_deck(a):
    """A 7.2 × 3 porch deck: 12 boards (Paint, the chosen colour) top at
    z 0.36, beams and a front fascia below."""
    for i in range(12):
        x = -3.3 + i * 0.6
        a.wood(zbox(0.57, 3.0, 0.24, 0.36, x, 0, bevel=0.025, segs=2), 'Paint', 1.0, 0.14)
        for y in (-1.3, 1.3):
            for dx in (-0.16, 0.16):
                a.add(box(0.03, 0.03, 0.01, 0, loc=(x + dx, y, 0.362)), 'Metal')
    for y in (-1.3, 0, 1.3):
        a.add(zbox(7.1, 0.14, 0.04, 0.24, 0, y, bevel=0.02), 'WoodDark', 0.85)
    a.wood(zbox(7.24, 0.06, 0.04, 0.34, 0, -1.52, bevel=0.02), 'WoodDark', 1.0)
    for x in (-3.6, 3.6):
        a.wood(zbox(0.06, 3.0, 0.04, 0.34, x, 0, bevel=0.02), 'WoodDark', 0.95)


@asset
def prop_deck_rail(a):
    """One side rail of the deck: posts at y ±1.3, rail top at z 1.22, along Y."""
    for y in (-1.3, 1.3):
        a.wood(zbox(0.14, 0.14, 0.28, 1.22, 0, y, bevel=0.03), 'WoodDark')
        a.add(zbox(0.18, 0.18, 1.2, 1.27, 0, y, bevel=0.025), 'WoodDark', 0.85)
    a.wood(zbox(0.12, 2.6, 1.1, 1.2, 0, 0, bevel=0.03), 'Wood')
    a.wood(zbox(0.08, 2.6, 0.58, 0.66, 0, 0, bevel=0.02), 'Wood', 0.9)
    for k in range(6):
        y = -1.05 + k * 0.42
        a.add(cyl(0.025, 0.025, 0.46, 8, loc=(0, y, 0.88)), 'Wood', 0.85)


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------

# Lay them out in a lineup (positions don't matter to the game).
x = 0.0
for ob in ASSETS:
    ob.location = (x, 0, 0)
    dims = ob.dimensions
    x += max(dims.x, 1.0) + 0.8

for ob in bpy.data.objects:
    ob.select_set(ob in ASSETS)
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format='GLB',
    export_apply=True,
    export_yup=True,
    use_selection=True,
    export_vertex_color='ACTIVE',
    export_cameras=False,
    export_lights=False,
    export_extras=False,
)

total = 0
for ob in ASSETS:
    me = ob.data
    me.calc_loop_triangles()
    n = len(me.loop_triangles)
    total += n
    print(f'ASSET {ob.name:24s} {n:6d} tris')
print(f'ASSET total {total} tris -> {OUT}')

# --------------------------------------------------------------------------
# Preview lineup render
# --------------------------------------------------------------------------

if PREVIEW:
    for m in bpy.data.materials:
        nt = m.node_tree
        b = nt.nodes.get('Principled BSDF')
        col = nt.nodes.new('ShaderNodeVertexColor')
        col.layer_name = 'Color'
        mul = nt.nodes.new('ShaderNodeVectorMath')
        mul.operation = 'MULTIPLY'
        mul.inputs[1].default_value = b.inputs['Base Color'].default_value[:3]
        nt.links.new(col.outputs['Color'], mul.inputs[0])
        nt.links.new(mul.outputs[0], b.inputs['Base Color'])
        if m.name == 'Lamp':
            b.inputs['Emission Color'].default_value = (1.0, 0.6, 0.25, 1)
            b.inputs['Emission Strength'].default_value = 1.5
    import numpy as np
    import os
    for i, ob in enumerate(ASSETS):
        ob.location = (i * 60, 0, 0)
        low = min((ob.matrix_world @ Vector(c)).z for c in ob.bound_box)
        if low < -0.1:
            ob.location.z = -low
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE'
    T = 420
    scene.render.resolution_x = T
    scene.render.resolution_y = T
    scene.view_settings.view_transform = 'Standard'
    world = bpy.data.worlds.new('W')
    scene.world = world
    bg = world.node_tree.nodes.get('Background')
    bg.inputs[0].default_value = (0.62, 0.72, 0.86, 1)
    bg.inputs[1].default_value = 1.0
    ground = bpy.data.meshes.new('ground')
    gbm = bmesh.new()
    bmesh.ops.create_grid(gbm, x_segments=1, y_segments=1, size=2000)
    gbm.to_mesh(ground)
    gob = bpy.data.objects.new('ground', ground)
    gm = bpy.data.materials.new('groundmat')
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (*srgb('#d8c9a3'), 1)
    ground.materials.append(gm)
    scene.collection.objects.link(gob)
    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = 3.5
    sun.angle = 0.15
    so = bpy.data.objects.new('sun', sun)
    so.rotation_euler = (math.radians(48), 0, math.radians(-30))
    scene.collection.objects.link(so)
    cam = bpy.data.cameras.new('cam')
    cam.lens = 50
    co = bpy.data.objects.new('cam', cam)
    scene.collection.objects.link(co)
    scene.camera = co
    tiles = []
    tmp = os.path.dirname(os.path.abspath(PREVIEW))
    for ob in ASSETS:
        corners = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
        lo = Vector([min(c[k] for c in corners) for k in range(3)])
        hi = Vector([max(c[k] for c in corners) for k in range(3)])
        t = (lo + hi) / 2
        rad = max((hi - lo).length / 2, 0.4)
        elev, az = 0.38, -0.55
        d = Vector((math.sin(az) * math.cos(elev), -math.cos(az) * math.cos(elev), math.sin(elev)))
        co.location = t + d * rad * 2.9
        co.rotation_euler = (t - co.location).to_track_quat('-Z', 'Y').to_euler()
        path = os.path.join(tmp, f'_tile_{ob.name}.png')
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        tiles.append(path)
    cols = 6
    rows_n = (len(tiles) + cols - 1) // cols
    sheet = np.ones((rows_n * T, cols * T, 4), dtype=np.float32)
    for k, path in enumerate(tiles):
        img = bpy.data.images.load(path)
        px = np.array(img.pixels[:], dtype=np.float32).reshape(T, T, 4)
        r, c = k // cols, k % cols
        y0 = (rows_n - 1 - r) * T
        sheet[y0:y0 + T, c * T:(c + 1) * T] = px
        bpy.data.images.remove(img)
        os.remove(path)
    out = bpy.data.images.new('sheet', cols * T, rows_n * T, alpha=True)
    out.pixels[:] = sheet.ravel()
    out.filepath_raw = PREVIEW
    out.file_format = 'PNG'
    out.save()
    print('PREVIEW', PREVIEW, [o.name for o in ASSETS])
