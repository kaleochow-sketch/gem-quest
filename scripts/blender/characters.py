"""
Matcha's characters: the dog (the player) and the people (visitors, the
worker, the ball thrower). Run headless by `npm run models -- characters`:

  blender -b --factory-startup -noaudio -P scripts/blender/characters.py -- public/models/characters.glb

Everything is written in GAME coordinates (three.js: x right, y up, z forward)
and converted to Blender's Z-up frame only when meshes are made, so the
numbers here line up with src/world/models.ts.

Every exported part is its own top-level object whose ORIGIN IS ITS PIVOT, so
the code can swing legs, turn heads and wag the tail:

  dog_body        origin at the body centre (game 0, 0.68, 0)     -> `body` group
  dog_collar      origin at the dog's feet (bodyPivot frame)       -> bodyPivot
  dog_head        origin at the neck pivot (0, 1.02, 0.52)         -> headPivot
  dog_leg_front   origin at the hip, paw on the ground 0.5 below   -> front leg pivots
  dog_leg_back    (same)                                           -> back leg pivots
  dog_tail        origin at the tail base (0, 0.8, -0.4), points up-back with
                  the pivot un-tilted (rotation.x = 0), wags about y

  person_torso    origin at the feet (bodyPivot frame)
  person_head     origin at the head centre (0, 1.9, 0)
  person_hair_*   short / bob / bun / curly, same origin as the head
  person_hat_*    sun / cap / beanie, same origin as the head
  person_leg      origin at the hip (±0.17, 0.85, 0), shoe on the ground
  person_arm      origin at the shoulder (±0.37, 1.55, 0), hand centre 0.63 below

Materials are named for recolouring in code (Fur, Tan, Skin, Top, Hair, ...).
"""
import math
import sys

import bpy
import bmesh
from mathutils import Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = ARGV[0] if ARGV else 'characters.glb'

# --------------------------------------------------------------------------
# Scene and materials
# --------------------------------------------------------------------------

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.metaballs, bpy.data.cameras, bpy.data.lights):
    for d in list(coll):
        coll.remove(d)
SCENE = bpy.context.scene


def G(x, y=None, z=None):
    """Game (x, y, z) -> Blender vector."""
    if y is None:
        x, y, z = x
    return Vector((x, -z, y))


def UNG(v):
    """Blender vector -> game vector."""
    return Vector((v.x, v.z, -v.y))


def srgb(hexstr):
    h = hexstr.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]


def material(name, color, rough=0.8, metal=0.0, sheen=0.0):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    lin = srgb(color)
    m.diffuse_color = (*lin, 1)
    m.roughness = rough
    tree = m.node_tree
    bsdf = next(n for n in tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (*lin, 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    return m


MATS = {
    # dog
    'Fur': ('#fbf8f2', 0.95), 'Tan': ('#d29a5c', 0.9), 'Dark': ('#2a2230', 0.3),
    'Pink': ('#ff8fa3', 0.6), 'Collar': ('#ff6b6b', 0.5), 'Tag': ('#ffd15c', 0.35),
    'White': ('#ffffff', 0.2),
    # people
    'Skin': ('#e8b896', 0.75), 'Top': ('#5fdbab', 0.8), 'Stripe': ('#ffffff', 0.8),
    'Bottom': ('#3d5a99', 0.8), 'Shoe': ('#ff6b6b', 0.6), 'Sole': ('#ffffff', 0.7),
    'Hair': ('#6b4a2b', 0.7), 'Hat': ('#f6d98b', 0.9), 'Band': ('#ff6b6b', 0.6),
    'Eye': ('#2a2230', 0.3), 'Blush': ('#ff9aa5', 0.7), 'Mouth': ('#8a3b45', 0.6),
}
for n, (c, r) in MATS.items():
    material(n, c, r)


# --------------------------------------------------------------------------
# Geometry pieces (game coordinates)
# --------------------------------------------------------------------------

class Piece:
    def __init__(self, verts, faces, mat):
        self.verts = [Vector(v) for v in verts]
        self.faces = faces
        self.mat = mat

    def transform(self, m):
        self.verts = [m @ v for v in self.verts]
        return self

    def move(self, x, y=0.0, z=0.0):
        return self.transform(Matrix.Translation(Vector((x, y, z))))

    def rot(self, axis, angle):
        return self.transform(Quaternion(Vector(axis), angle).to_matrix().to_4x4())

    def scale(self, sx, sy, sz):
        return self.transform(Matrix.Diagonal((sx, sy, sz, 1)))

    def copy(self):
        return Piece(self.verts, [list(f) for f in self.faces], self.mat)

    def tris(self):
        return sum(len(f) - 2 for f in self.faces)


def lathe(profile, mat, seg=20):
    """Surface of revolution around game +y. profile: [(radius, y), ...]; r=0 is a pole."""
    verts, rings = [], []
    for r, y in profile:
        if r <= 1e-6:
            rings.append([len(verts)])
            verts.append((0, y, 0))
        else:
            ring = []
            for i in range(seg):
                a = i / seg * math.tau
                ring.append(len(verts))
                verts.append((r * math.sin(a), y, r * math.cos(a)))
            rings.append(ring)
    faces = []
    for a, b in zip(rings, rings[1:]):
        if len(a) == 1 and len(b) == 1:
            continue
        if len(a) == 1:
            faces += [[a[0], b[(i + 1) % seg], b[i]] for i in range(seg)]
        elif len(b) == 1:
            faces += [[a[i], a[(i + 1) % seg], b[0]] for i in range(seg)]
        else:
            faces += [[a[i], a[(i + 1) % seg], b[(i + 1) % seg], b[i]] for i in range(seg)]
    # Orient faces outward: a profile running clockwise in (r, y) winds inward.
    pts = list(profile)
    area = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))
    if area < 0:
        faces = [list(reversed(f)) for f in faces]
    return Piece(verts, faces, mat)


def fix_winding(p):
    """Flips faces so normals point away from the piece's centroid (convex-ish shapes)."""
    c = sum(p.verts, Vector()) / max(1, len(p.verts))
    out = []
    for f in p.faces:
        a, b, d = p.verts[f[0]], p.verts[f[1]], p.verts[f[-1]]
        n = (b - a).cross(d - a)
        fc = sum((p.verts[i] for i in f), Vector()) / len(f)
        out.append(list(reversed(f)) if n.dot(fc - c) < 0 else f)
    p.faces = out


def sphere(sx, sy, sz, mat, seg=16, rings=10):
    prof = [(math.sin(math.pi * i / rings), math.cos(math.pi * i / rings)) for i in range(rings + 1)]
    return lathe(prof, mat, seg).scale(sx, sy, sz)


def torus(R, r, mat, seg=28, sides=10, arc=math.tau):
    """A ring around game +y (or an open arc of it)."""
    verts, faces = [], []
    closed = arc >= math.tau - 1e-6
    n = seg if closed else seg + 1
    for i in range(n):
        a = arc * i / seg
        for j in range(sides):
            b = math.tau * j / sides
            rr = R + r * math.cos(b)
            verts.append((rr * math.sin(a), r * math.sin(b), rr * math.cos(a)))
    for i in range(seg):
        i2 = (i + 1) % n
        for j in range(sides):
            j2 = (j + 1) % sides
            faces.append([i * sides + j, i2 * sides + j, i2 * sides + j2, i * sides + j2])
    p = Piece(verts, faces, mat)
    # torus normals: point away from the core circle
    out = []
    for f in p.faces:
        a, b, d = p.verts[f[0]], p.verts[f[1]], p.verts[f[-1]]
        nrm = (b - a).cross(d - a)
        fc = sum((p.verts[i] for i in f), Vector()) / len(f)
        core = Vector((fc.x, 0, fc.z))
        core = core.normalized() * R if core.length > 1e-6 else core
        out.append(list(reversed(f)) if nrm.dot(fc - core) < 0 else f)
    p.faces = out
    if not closed:
        # cap the ends with balls so the arc looks rounded
        for a in (0, arc):
            cap = sphere(r, r, r, mat, 8, 6).move(R * math.sin(a), 0, R * math.cos(a))
            p = merge_pieces([p, cap], mat)
    return p


def merge_pieces(pieces, mat):
    verts, faces = [], []
    for q in pieces:
        off = len(verts)
        verts += q.verts
        faces += [[i + off for i in f] for f in q.faces]
    return Piece(verts, faces, mat)


# ---- metaballs: soft, blended organic shapes ------------------------------

# With Blender's default stiffness 2 / threshold 0.6 a ball's surface sits at
# 0.5747 of its field radius.
K = math.sqrt(1 - (0.6 / 2) ** (1 / 3))
_mb_count = [0]


def ball(c, r, neg=False, stiff=2.0):
    return {'t': 'BALL', 'c': c, 'r': r, 'neg': neg, 'stiff': stiff}


def ell(c, s, q=None, neg=False, stiff=2.0):
    """Ellipsoid with game semi-axes s=(sx, sy, sz), optional game rotation (axis, angle)."""
    return {'t': 'ELLIPSOID', 'c': c, 's': s, 'q': q, 'neg': neg, 'stiff': stiff}


def cap(a, b, r, neg=False, stiff=2.0):
    return {'t': 'CAPSULE', 'a': a, 'b': b, 'r': r, 'neg': neg, 'stiff': stiff}


def blob(elems, mat, res=0.03, max_tris=None):
    _mb_count[0] += 1
    name = f'MB{_mb_count[0]}'
    mb = bpy.data.metaballs.new(name)
    mb.resolution = res
    mb.render_resolution = res
    mb.threshold = 0.6
    obj = bpy.data.objects.new(name, mb)
    SCENE.collection.objects.link(obj)
    for e in elems:
        el = mb.elements.new(type=e['t'])
        el.use_negative = e['neg']
        el.stiffness = e['stiff']
        if e['t'] == 'BALL':
            el.co = G(e['c'])
            el.radius = e['r'] / K
        elif e['t'] == 'ELLIPSOID':
            el.co = G(e['c'])
            el.radius = 1 / K
            sx, sy, sz = e['s']
            el.size_x, el.size_y, el.size_z = sx, sz, sy
            if e['q']:
                axis, ang = e['q']
                el.rotation = Quaternion(G(axis), ang)
        else:
            a, b = Vector(e['a']), Vector(e['b'])
            el.co = G((a + b) / 2)
            el.radius = e['r'] / K
            el.size_x = max(1e-4, (b - a).length / 2)
            el.rotation = Vector((1, 0, 0)).rotation_difference(G(b - a).normalized())
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
    bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.metaballs.remove(mb)
    if max_tris:
        me = decimate(me, max_tris)
    verts = [UNG(v.co) for v in me.vertices]
    faces = [list(p.vertices) for p in me.polygons]
    bpy.data.meshes.remove(me)
    return Piece(verts, faces, mat)


def decimate(me, max_tris):
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    if tris <= max_tris:
        return me
    tmp = bpy.data.objects.new('dec', me)
    SCENE.collection.objects.link(tmp)
    mod = tmp.modifiers.new('d', 'DECIMATE')
    mod.ratio = max_tris / tris
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    out = bpy.data.meshes.new_from_object(tmp.evaluated_get(dg))
    bpy.data.objects.remove(tmp, do_unlink=True)
    bpy.data.meshes.remove(me)
    return out


# ---- sticking features onto a surface ------------------------------------

class Surface:
    def __init__(self, piece):
        self.bvh = BVHTree.FromPolygons(piece.verts, piece.faces)

    def hit(self, x, y, frm=Vector((0, 0, 0)), dirn=None):
        """Ray from far in front at (x, y) toward -z (or from frm along dirn)."""
        if dirn is None:
            o, d = Vector((x, y, 3)), Vector((0, 0, -1))
        else:
            o, d = Vector(frm), Vector(dirn).normalized()
        loc, nrm, _, _ = self.bvh.ray_cast(o, d)
        if loc is None:
            raise RuntimeError(f'no surface hit at {x},{y}')
        if nrm.dot(d) > 0:
            nrm = -nrm
        return loc, nrm

    def stick(self, piece, x, y, sink=0.0, spin=0.0, **kw):
        """Places a piece (modelled facing +z at the origin) on the surface at (x, y)."""
        loc, nrm = self.hit(x, y, **kw)
        q = Vector((0, 0, 1)).rotation_difference(nrm)
        # keep the piece upright: roll so its +y stays as close to game up as possible
        up = q @ Vector((0, 1, 0))
        want = Vector((0, 1, 0)) - nrm * nrm.dot(Vector((0, 1, 0)))
        if want.length > 1e-4:
            ang = up.angle(want.normalized())
            if up.cross(want).dot(nrm) < 0:
                ang = -ang
            q = Quaternion(nrm, ang) @ q
        if spin:
            q = Quaternion(nrm, spin) @ q
        m = Matrix.Translation(loc - nrm * sink) @ q.to_matrix().to_4x4()
        return piece.transform(m)


# ---- making objects -------------------------------------------------------

EXPORTED = []


def make_object(name, pieces, pivot=(0, 0, 0)):
    """Joins pieces into one smooth-shaded mesh object, origin at its pivot."""
    me = bpy.data.meshes.new(name)
    names = []
    verts, faces, mats = [], [], []
    for p in pieces:
        if p.mat not in names:
            names.append(p.mat)
        off = len(verts)
        verts += [G(v) for v in p.verts]
        faces += [[i + off for i in f] for f in p.faces]
        mats += [names.index(p.mat)] * len(p.faces)
    me.from_pydata(verts, [], faces)
    for n in names:
        me.materials.append(bpy.data.materials[n])
    for poly, mi in zip(me.polygons, mats):
        poly.material_index = mi
    # merge seams inside each piece (metaball output is already welded)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(me)
    bm.free()
    me.shade_smooth()
    me.validate()
    obj = bpy.data.objects.new(name, me)
    SCENE.collection.objects.link(obj)
    obj.location = G(pivot)
    EXPORTED.append(obj)
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    print(f'[characters] {name}: {tris} tris')
    return obj


# ==========================================================================
# The dog
# ==========================================================================

def build_dog():
    # ---- body (origin at the body centre, game y = 0.68) ----------------
    # A slim puppy: chest a touch fuller than the rump, a soft waist, a fluffy bib.
    body = blob([
        ell((0, -0.02, 0.19), (0.225, 0.27, 0.24)),   # deep puppy chest
        ell((0, -0.07, -0.01), (0.205, 0.23, 0.22)),  # round belly
        ell((0, 0.0, -0.24), (0.2, 0.21, 0.2)),       # rump (small!)
        ell((0, -0.06, 0.31), (0.16, 0.18, 0.12)),    # fluffy bib
        ball((0, 0.12, 0.3), 0.13),                   # shoulders up toward the neck
    ], 'Fur', res=0.028, max_tris=2600)
    make_object('dog_body', [body], pivot=(0, 0.68, 0))

    # ---- collar (bodyPivot frame) ---------------------------------------
    neck_c = Vector((0, 0.86, 0.38))
    tilt = 0.9  # tips the ring so it follows the neck
    ring = torus(0.2, 0.04, 'Collar', seg=28, sides=10).rot((1, 0, 0), tilt).move(*neck_c)
    tag = sphere(0.045, 0.045, 0.016, 'Tag', 12, 8)
    tag.move(0, -0.06, 0)
    # hang the tag at the front-bottom of the ring
    front = Quaternion((1, 0, 0), tilt) @ Vector((0, 0, 0.2 + 0.035))
    tag.move(*(neck_c + front))
    make_object('dog_collar', [ring, tag], pivot=(0, 0, 0))

    # ---- head (origin at the neck pivot) --------------------------------
    skull = blob([
        ell((0, 0.03, -0.02), (0.31, 0.28, 0.28)),    # round skull
        ball((-0.13, -0.09, 0.1), 0.15),              # cheek fluff
        ball((0.13, -0.09, 0.1), 0.15),
        ell((0, -0.08, 0.22), (0.13, 0.1, 0.13)),     # short muzzle
        ell((0, -0.04, 0.17), (0.09, 0.08, 0.1)),     # bridge
    ], 'Fur', res=0.022, max_tris=1700)
    surf = Surface(skull)
    parts = [skull]
    # big shiny eyes
    for s in (-1, 1):
        eye = sphere(0.048, 0.06, 0.03, 'Dark', 12, 7)
        parts.append(surf.stick(eye, s * 0.125, 0.04, sink=0.008))
        glint = sphere(0.016, 0.016, 0.01, 'White', 8, 5)
        parts.append(surf.stick(glint.move(0.016, 0.022, 0.026), s * 0.125, 0.04, sink=0.008))
        glint2 = sphere(0.008, 0.008, 0.006, 'White', 6, 4)
        parts.append(surf.stick(glint2.move(-0.018, -0.02, 0.026), s * 0.125, 0.04, sink=0.008))
        # tan eyebrow dots
        brow = sphere(0.032, 0.02, 0.012, 'Tan', 10, 6)
        parts.append(surf.stick(brow, s * 0.12, 0.155, sink=0.004))
        # rosy cheeks
        blush = sphere(0.045, 0.028, 0.012, 'Pink', 12, 6)
        parts.append(surf.stick(blush, s * 0.205, -0.075, sink=0.004))
    # button nose
    nose = merge_pieces([sphere(0.058, 0.04, 0.038, 'Dark', 16, 10)], 'Dark')
    parts.append(surf.stick(nose, 0, -0.03, sink=0.012))
    nglint = sphere(0.014, 0.009, 0.006, 'White', 8, 5).move(0.01, 0.022, 0.034)
    parts.append(surf.stick(nglint, 0, -0.03, sink=0.012))
    # a little pink tongue under the muzzle
    tongue = blob([ell((0, -0.0, 0.0), (0.05, 0.022, 0.06)), ell((0, -0.01, 0.03), (0.045, 0.02, 0.04))],
                  'Pink', res=0.012, max_tris=250)
    tongue.rot((1, 0, 0), 0.5).move(0, -0.165, 0.27)
    parts.append(tongue)
    # floppy tan ears
    for s in (-1, 1):
        ear = blob([
            ell((0, 0.05, 0), (0.05, 0.09, 0.09)),
            ell((0, -0.07, 0.0), (0.06, 0.12, 0.12)),
        ], 'Tan', res=0.018, max_tris=450)
        ear.rot((0, 0, 1), s * 0.32).rot((0, 1, 0), s * -0.15).move(s * 0.29, 0.05, -0.03)
        parts.append(ear)
    make_object('dog_head', parts, pivot=(0, 1.02, 0.52))

    # ---- legs (origin at the hip, ground 0.5 below) ---------------------
    def leg(back):
        el = [
            cap((0, 0.02, 0), (0, -0.4, 0.01), 0.084 if back else 0.08),
            ell((0, -0.452, 0.04), (0.092, 0.055, 0.112)),   # paw
        ]
        if back:
            el.append(ell((0, 0.04, -0.03), (0.08, 0.12, 0.1)))  # haunch, hidden in the body
        return blob(el, 'Fur', res=0.02, max_tris=850)

    for back in (False, True):
        p = leg(back)
        # toe beans hinted with two tiny grooves? keep it clean: a pink pad underneath
        pad = sphere(0.05, 0.012, 0.06, 'Pink', 12, 6).move(0, -0.502, 0.04)
        make_object('dog_leg_back' if back else 'dog_leg_front', [p, pad],
                    pivot=(0.15, 0.5, -0.3 if back else 0.3))

    # ---- tail (origin at the base, pointing up and back) -----------------
    tail = blob([
        cap((0, 0, 0.02), (0, 0.12, -0.08), 0.055),
        cap((0, 0.12, -0.08), (0, 0.24, -0.1), 0.06),
        cap((0, 0.24, -0.1), (0, 0.33, -0.05), 0.055),
    ], 'Tan', res=0.018, max_tris=800)
    tip = blob([ball((0, 0.34, -0.035), 0.052)], 'Fur', res=0.016, max_tris=200)
    make_object('dog_tail', [tail, tip], pivot=(0, 0.8, -0.4))


# ==========================================================================
# People
# ==========================================================================

def build_person():
    # ---- torso (origin at the feet) -------------------------------------
    prof = [(0, 0.84), (0.2, 0.845), (0.27, 0.87), (0.29, 0.92), (0.292, 0.97),     # shorts waist
            (0.33, 0.985), (0.335, 1.02), (0.322, 1.1), (0.31, 1.18), (0.3, 1.26),  # shirt hem up
            (0.29, 1.34), (0.28, 1.42), (0.262, 1.5), (0.23, 1.57), (0.16, 1.625), (0, 1.645)]
    torso = lathe(prof, 'Top', seg=24).scale(1, 1, 0.8)
    pieces = []
    # split the faces by height into shorts / shirt / stripes
    by = {'Top': [], 'Bottom': [], 'Stripe': []}
    for f in torso.faces:
        y = sum(torso.verts[i].y for i in f) / len(f)
        m = 'Bottom' if y < 0.975 else ('Stripe' if 1.18 < y < 1.26 or 1.34 < y < 1.42 else 'Top')
        by[m].append(f)
    for m, fs in by.items():
        pieces.append(Piece(torso.verts, fs, m))
    # a soft collar trim at the neck
    pieces.append(torus(0.15, 0.025, 'Stripe', seg=24, sides=8).scale(1, 1, 0.85).move(0, 1.6, 0))
    make_object('person_torso', pieces, pivot=(0, 0, 0))

    # ---- head (origin at the head centre) -------------------------------
    face = blob([
        ell((0, 0.04, -0.01), (0.34, 0.32, 0.32)),
        ball((-0.13, -0.12, 0.1), 0.17),
        ball((0.13, -0.12, 0.1), 0.17),
        ell((-0.33, -0.03, 0.0), (0.05, 0.08, 0.065)),   # ears
        ell((0.33, -0.03, 0.0), (0.05, 0.08, 0.065)),
    ], 'Skin', res=0.022, max_tris=1700)
    surf = Surface(face)
    parts = [face]
    for s in (-1, 1):
        eye = sphere(0.038, 0.055, 0.022, 'Eye', 14, 8)
        parts.append(surf.stick(eye, s * 0.115, -0.02, sink=0.006))
        g1 = sphere(0.014, 0.014, 0.008, 'White', 8, 5).move(0.012, 0.022, 0.018)
        parts.append(surf.stick(g1, s * 0.115, -0.02, sink=0.006))
        brow = torus(0.05, 0.011, 'Hair', seg=8, sides=6, arc=1.4)
        brow.rot((1, 0, 0), math.pi / 2)        # arc in the face plane
        brow.rot((0, 0, 1), math.pi - 0.7)      # arch upward
        brow.move(0, -0.045, 0)
        parts.append(surf.stick(brow, s * 0.115, 0.1, sink=0.0))
        blush = sphere(0.05, 0.03, 0.012, 'Blush', 12, 6)
        parts.append(surf.stick(blush, s * 0.2, -0.11, sink=0.004))
    nose = sphere(0.032, 0.026, 0.022, 'Skin', 10, 6)
    parts.append(surf.stick(nose, 0, -0.08, sink=0.006))
    smile = torus(0.042, 0.011, 'Mouth', seg=10, sides=6, arc=math.pi)
    smile.rot((1, 0, 0), math.pi / 2).rot((0, 0, 1), -math.pi / 2)   # U shape in the xy plane
    parts.append(surf.stick(smile, 0, -0.15, sink=0.004))
    make_object('person_head', parts, pivot=(0, 1.9, 0))

    # ---- hair styles (same origin as the head) --------------------------
    carve_face = ell((0, -0.2, 0.3), (0.33, 0.3, 0.2), neg=True)
    fringe = [ball((x, 0.2 - abs(x) * 0.25, 0.25 - abs(x) * 0.3), 0.085) for x in (-0.18, -0.06, 0.06, 0.18)]
    short = blob([
        ell((0, 0.08, -0.03), (0.365, 0.33, 0.35)),
        ell((0, -0.08, -0.13), (0.33, 0.2, 0.24)),       # nape
        carve_face,
        ell((0, -0.4, 0.2), (0.55, 0.2, 0.5), neg=True),   # higher at the front, lower at the nape
        *fringe,
    ], 'Hair', res=0.024, max_tris=1800)
    make_object('person_hair_short', [short], pivot=(0, 1.9, 0))

    bob = blob([
        ell((0, 0.03, -0.03), (0.39, 0.37, 0.37)),
        ell((0, -0.22, 0.33), (0.3, 0.3, 0.2), neg=True),
        ell((0, -0.5, 0.0), (0.6, 0.18, 0.6), neg=True),
        ball((-0.3, -0.18, -0.02), 0.11), ball((0.3, -0.18, -0.02), 0.11),
        *fringe,
    ], 'Hair', res=0.024, max_tris=1900)
    make_object('person_hair_bob', [bob], pivot=(0, 1.9, 0))

    bun = blob([
        ell((0, 0.08, -0.03), (0.365, 0.33, 0.35)),
        ell((0, -0.08, -0.13), (0.33, 0.2, 0.24)),       # nape
        carve_face,
        ell((0, -0.4, 0.2), (0.55, 0.2, 0.5), neg=True),   # higher at the front, lower at the nape
        *fringe,
    ], 'Hair', res=0.024, max_tris=1800)
    knot = blob([ball((0, 0.43, -0.1), 0.13)], 'Hair', res=0.02, max_tris=600)
    make_object('person_hair_bun', [bun, knot], pivot=(0, 1.9, 0))

    curls = [ell((0, 0.06, -0.03), (0.35, 0.32, 0.34))]
    n = 46
    for i in range(n):
        yv = 1 - (i + 0.5) / n * 1.4          # upper part of a sphere
        rr = math.sqrt(max(0, 1 - yv * yv))
        a = i * 2.39996
        p = Vector((rr * math.sin(a), yv, rr * math.cos(a))) * 0.36 + Vector((0, 0.06, -0.03))
        if p.z > 0.12 and p.y < 0.22:
            continue  # keep the face clear
        curls.append(ball(tuple(p), 0.085))
    curls += [carve_face, ell((0, -0.35, 0.0), (0.5, 0.15, 0.5), neg=True)]
    curly = blob(curls, 'Hair', res=0.022, max_tris=2400)
    make_object('person_hair_curly', [curly], pivot=(0, 1.9, 0))

    # ---- hats (same origin as the head, sit over the short hair) ---------
    hat_tilt = -0.12  # a little back on the head
    sun = lathe([(0, 0.6), (0.12, 0.595), (0.22, 0.56), (0.29, 0.49), (0.32, 0.4), (0.335, 0.3),
                 (0.38, 0.265), (0.5, 0.245), (0.6, 0.215), (0.635, 0.19), (0.62, 0.17),
                 (0.5, 0.2), (0.38, 0.225), (0.3, 0.24), (0, 0.24)], 'Hat', seg=32)
    ribbon = lathe([(0.333, 0.37), (0.346, 0.36), (0.352, 0.32), (0.346, 0.285), (0.336, 0.28),
                    (0.3, 0.3), (0.3, 0.36)], 'Band', seg=32)
    bow = blob([ell((0.08, 0.0, 0), (0.07, 0.04, 0.03), q=((0, 0, 1), 0.3)),
                ell((-0.08, 0.0, 0), (0.07, 0.04, 0.03), q=((0, 0, 1), -0.3)),
                ball((0, 0, 0), 0.035)], 'Band', res=0.012, max_tris=500)
    bow.rot((0, 1, 0), 0.5).move(0.17, 0.33, 0.29)
    make_object('person_hat_sun', [q.rot((1, 0, 0), hat_tilt) for q in (sun, ribbon, bow)], pivot=(0, 1.9, 0))

    capdome = lathe([(0, 0.46), (0.16, 0.45), (0.28, 0.4), (0.36, 0.31), (0.39, 0.21), (0.392, 0.15),
                     (0.37, 0.14), (0.0, 0.22)], 'Hat', seg=28)
    bill = blob([ell((0, 0, 0), (0.25, 0.024, 0.2))], 'Hat', res=0.012, max_tris=700)
    bill.move(0, 0.16, 0.34).rot((1, 0, 0), 0.22)
    button = sphere(0.04, 0.025, 0.04, 'Band', 10, 6).move(0, 0.47, 0)
    make_object('person_hat_cap', [q.rot((1, 0, 0), hat_tilt * 0.5) for q in (capdome, bill, button)], pivot=(0, 1.9, 0))

    beanie = lathe([(0, 0.56), (0.13, 0.55), (0.25, 0.5), (0.34, 0.4), (0.38, 0.27), (0.385, 0.16),
                    (0.36, 0.15), (0, 0.25)], 'Hat', seg=28)
    cuff = torus(0.385, 0.05, 'Band', seg=28, sides=10).scale(1, 1.1, 1).move(0, 0.17, 0)
    pom = blob([ball((0, 0.6, 0), 0.1)] + [ball((0.06 * math.sin(a), 0.6 + 0.05 * math.cos(a * 1.7), 0.06 * math.cos(a)), 0.06)
                                             for a in (0, 1.3, 2.6, 3.9, 5.2)], 'Band', res=0.016, max_tris=800)
    make_object('person_hat_beanie', [q.rot((1, 0, 0), hat_tilt * 0.5) for q in (beanie, cuff, pom)], pivot=(0, 1.9, 0))

    # ---- leg (origin at the hip) ----------------------------------------
    shorts = lathe([(0, 0.06), (0.12, 0.055), (0.15, 0.0), (0.158, -0.12), (0.16, -0.24), (0.155, -0.29),
                    (0.13, -0.305), (0.0, -0.29)], 'Bottom', seg=16)
    shin = lathe([(0, -0.22), (0.072, -0.25), (0.075, -0.4), (0.07, -0.55), (0.066, -0.7), (0, -0.74)], 'Skin', seg=14)
    shoe = blob([
        ell((0, -0.755, 0.035), (0.105, 0.085, 0.15)),
        ball((0, -0.73, 0.1), 0.09),
    ], 'Shoe', res=0.018, max_tris=600)
    sole = blob([ell((0, -0.825, 0.04), (0.115, 0.028, 0.165))], 'Sole', res=0.014, max_tris=300)
    make_object('person_leg', [shorts, shin, shoe, sole], pivot=(0.17, 0.85, 0))

    # ---- arm (origin at the shoulder) ------------------------------------
    sleeve = lathe([(0, 0.1), (0.08, 0.09), (0.112, 0.045), (0.118, -0.04), (0.116, -0.13),
                    (0.1, -0.145), (0.0, -0.13)], 'Top', seg=16)
    arm = lathe([(0, -0.08), (0.062, -0.12), (0.06, -0.35), (0.054, -0.55), (0, -0.58)], 'Skin', seg=12)
    hand = blob([
        ell((0, -0.625, 0.0), (0.068, 0.085, 0.055)),
        cap((0, -0.585, 0.03), (0, -0.625, 0.07), 0.026),      # thumb forward
    ], 'Skin', res=0.014, max_tris=600)
    make_object('person_arm', [sleeve, arm, hand], pivot=(0.37, 1.55, 0))


build_dog()
build_person()

# --------------------------------------------------------------------------
# Export only the finished parts.
# --------------------------------------------------------------------------
for o in list(SCENE.objects):
    if o not in EXPORTED:
        bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format='GLB',
    export_apply=True,
    export_yup=True,
    export_texcoords=False,
    export_materials='EXPORT',
    export_cameras=False,
    export_lights=False,
)
print(f'[characters] wrote {OUT}')
