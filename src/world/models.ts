/**
 * Models built from simple shapes: the dog, palms, grass, rocks, and the
 * little effects (poofs, sparkles, task markers). Everything is generated in
 * code, so the game still downloads as one file and works offline.
 */
import * as THREE from 'three';

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ *
 * Materials
 * ------------------------------------------------------------------ */

const matCache = new Map<string, THREE.MeshStandardMaterial>();

/** A shared standard material for a colour and finish. */
export function mat(color: string, rough = 0.85, metal = 0, extra = ''): THREE.MeshStandardMaterial {
  const keyName = `${color}|${rough}|${metal}|${extra}`;
  let m = matCache.get(keyName);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    if (extra === 'flat') m.flatShading = true;
    if (extra === 'double') m.side = THREE.DoubleSide;
    matCache.set(keyName, m);
  }
  return m;
}

/** Marks a whole object as casting and receiving shadows. */
export function shadowed<T extends THREE.Object3D>(o: T, cast = true, receive = true): T {
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) {
      c.castShadow = cast;
      c.receiveShadow = receive;
    }
  });
  return o;
}

export function box(w: number, h: number, d: number, m: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
}

export function cyl(rTop: number, rBottom: number, h: number, m: THREE.Material, seg = 12): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, seg), m);
}

export function ball(r: number, m: THREE.Material, seg = 16): THREE.Mesh {
  return new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(8, seg - 4)), m);
}

/**
 * Bends a material in the wind: vertices sway more the higher they sit above
 * the object's origin, with a phase taken from where it stands so a field of
 * grass ripples rather than moving in lockstep.
 */
export function windy(
  m: THREE.MeshStandardMaterial,
  uniforms: { uTime: { value: number }; uWind: { value: number } },
  strength = 0.3,
): THREE.MeshStandardMaterial {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWind = uniforms.uWind;
    shader.vertexShader =
      'uniform float uTime;\nuniform float uWind;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec4 wOrigin = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        #else
          vec4 wOrigin = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        #endif
        float wH = max(position.y, 0.0);
        float wPhase = uTime * 2.2 + wOrigin.x * 0.45 + wOrigin.z * 0.3;
        float wSway = (sin(wPhase) * 0.7 + sin(wPhase * 2.3) * 0.3) * uWind * wH * wH * ${strength.toFixed(3)};
        transformed.x += wSway;
        transformed.z += wSway * 0.45;`,
      );
  };
  m.customProgramCacheKey = () => `windy-${strength}`;
  return m;
}

/* ------------------------------------------------------------------ *
 * The dog
 * ------------------------------------------------------------------ */

export interface DogRig {
  group: THREE.Group;
  speed: number;
  readonly moving: boolean;
  goTo(target: THREE.Vector3, onArrive?: () => void): void;
  stop(): void;
  /** Turns to look at a point. */
  face(point: THREE.Vector3): void;
  /** Plays the digging pose for `seconds`. */
  dig(seconds: number): void;
  /** Puts something in the dog's mouth (or takes it away with null). */
  carry(o: THREE.Object3D | null): void;
  /**
   * Analog movement from keys or the joystick: a direction on the ground
   * whose length (0..1) is how hard to run. Cancels any walk-to target.
   */
  steer(dir: THREE.Vector3 | null): void;
  /** Hops into the air; returns false if already airborne. */
  jump(): boolean;
  /** Height above the ground from a jump, added after the ground clamp. */
  readonly hop: number;
  /** Called on each footfall while moving, with the paw's side. */
  onStep?: (side: number) => void;
  update(dt: number, t: number): void;
}

export function makeDog(): DogRig {
  const fur = mat('#fbf8f2', 0.95);
  const tan = mat('#d29a5c', 0.9);
  const dark = mat('#2a2230', 0.35);
  const pink = mat('#ff8fa3', 0.6);
  const collar = mat('#ff6b6b', 0.5);

  const group = new THREE.Group();
  const bodyPivot = new THREE.Group();
  group.add(bodyPivot);

  const body = ball(0.42, fur, 20);
  body.scale.set(0.95, 0.85, 1.3);
  body.position.set(0, 0.62, 0);
  bodyPivot.add(body);
  // Fluffy chest and rump.
  for (const [x, y, z, r] of [[0, 0.62, 0.42, 0.3], [0.14, 0.7, -0.4, 0.24], [-0.14, 0.7, -0.4, 0.24], [0, 0.5, 0.2, 0.3]] as const) {
    const puff = ball(r, fur, 14);
    puff.position.set(x, y, z);
    bodyPivot.add(puff);
  }

  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.98, 0.52);
  bodyPivot.add(headPivot);
  const head = ball(0.33, fur, 20);
  headPivot.add(head);
  const snout = ball(0.16, fur, 14);
  snout.scale.set(1.15, 0.85, 1);
  snout.position.set(0, -0.08, 0.27);
  headPivot.add(snout);
  const nose = ball(0.06, dark, 10);
  nose.position.set(0, -0.02, 0.42);
  headPivot.add(nose);
  for (const s of [-1, 1]) {
    const eye = ball(0.048, dark, 10);
    eye.position.set(s * 0.12, 0.06, 0.28);
    headPivot.add(eye);
    const glint = ball(0.015, mat('#ffffff', 0.2), 6);
    glint.position.set(s * 0.12 + 0.015, 0.08, 0.325);
    headPivot.add(glint);
    const ear = ball(0.17, tan, 14);
    ear.scale.set(0.55, 1.1, 0.8);
    ear.position.set(s * 0.3, -0.02, -0.02);
    ear.rotation.z = s * 0.35;
    headPivot.add(ear);
    const cheek = ball(0.05, pink, 8);
    cheek.scale.set(1, 0.6, 0.4);
    cheek.position.set(s * 0.2, -0.08, 0.26);
    headPivot.add(cheek);
  }
  const tongue = ball(0.06, pink, 8);
  tongue.scale.set(1, 0.4, 1.2);
  tongue.position.set(0, -0.2, 0.33);
  headPivot.add(tongue);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.04, 8, 20), collar);
  ring.rotation.x = Math.PI / 2 - 0.5;
  ring.position.set(0, 0.84, 0.42);
  bodyPivot.add(ring);

  // Legs pivot at the hip so they can swing.
  const legs: THREE.Group[] = [];
  for (const [x, z] of [[0.2, 0.32], [-0.2, 0.32], [0.2, -0.32], [-0.2, -0.32]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.46, z);
    const leg = cyl(0.09, 0.08, 0.4, fur);
    leg.position.y = -0.2;
    const paw = ball(0.1, fur, 10);
    paw.scale.set(1, 0.6, 1.2);
    paw.position.set(0, -0.4, 0.03);
    pivot.add(leg, paw);
    bodyPivot.add(pivot);
    legs.push(pivot);
  }

  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.78, -0.55);
  const tail = ball(0.13, tan, 12);
  tail.scale.set(0.8, 0.8, 1.6);
  tail.position.set(0, 0.12, -0.08);
  tailPivot.add(tail);
  tailPivot.rotation.x = -0.7;
  bodyPivot.add(tailPivot);

  const mouth = new THREE.Group();
  mouth.position.set(0, -0.16, 0.42);
  headPivot.add(mouth);

  shadowed(group, true, false);

  let target: THREE.Vector3 | null = null;
  let arrive: (() => void) | undefined;
  let walkPhase = 0;
  let digLeft = 0;
  let heading = 0;
  let steerDir: THREE.Vector3 | null = null;
  let hop = 0;
  let hopV = 0;
  let lastStep = 0;

  const rig: DogRig = {
    group,
    speed: 4,
    get moving() {
      return target !== null;
    },
    goTo(to, onArrive) {
      target = to.clone();
      target.y = 0;
      arrive = onArrive;
    },
    stop() {
      target = null;
      arrive = undefined;
    },
    face(point) {
      heading = Math.atan2(point.x - group.position.x, point.z - group.position.z);
    },
    dig(seconds) {
      digLeft = seconds;
    },
    carry(o) {
      mouth.clear();
      if (o) mouth.add(o);
    },
    steer(dir) {
      if (dir && dir.lengthSq() > 0.0025) {
        steerDir = dir.clone().setY(0);
        if (steerDir.length() > 1) steerDir.normalize();
        target = null;
        arrive = undefined;
      } else {
        steerDir = null;
      }
    },
    jump() {
      if (hop > 0.02) return false;
      hopV = 6.2;
      hop = 0.001;
      return true;
    },
    get hop() {
      return hop;
    },
    update(dt, t) {
      const pos = group.position;
      let moving = false;
      let pace = 1;
      // Jumping: a quick hop with a squash on landing.
      if (hop > 0) {
        hopV -= 20 * dt;
        hop += hopV * dt;
        if (hop <= 0) {
          hop = 0;
          hopV = 0;
          body.scale.y = 0.72;
        }
      }
      if (steerDir) {
        const want = Math.atan2(steerDir.x, steerDir.z);
        let delta = want - heading;
        while (delta > Math.PI) delta -= TAU;
        while (delta < -Math.PI) delta += TAU;
        heading += delta * Math.min(1, dt * 12);
        pace = steerDir.length();
        pos.addScaledVector(steerDir, rig.speed * dt);
        moving = pace > 0.05;
      } else if (target) {
        const to = target.clone().sub(pos);
        to.y = 0;
        const d = to.length();
        if (d < 0.08) {
          target = null;
          const cb = arrive;
          arrive = undefined;
          cb?.();
        } else {
          moving = true;
          const want = Math.atan2(to.x, to.z);
          let delta = want - heading;
          while (delta > Math.PI) delta -= TAU;
          while (delta < -Math.PI) delta += TAU;
          heading += delta * Math.min(1, dt * 10);
          pos.addScaledVector(to.normalize(), Math.min(d, rig.speed * dt));
        }
      }
      group.rotation.y = heading;

      if (moving) {
        const before = Math.floor(walkPhase / Math.PI);
        walkPhase += dt * rig.speed * 3.2 * Math.max(0.5, pace);
        const after = Math.floor(walkPhase / Math.PI);
        if (after !== before && hop === 0 && t - lastStep > 0.08) {
          lastStep = t;
          rig.onStep?.(after % 2 ? 1 : -1);
        }
        const swing = Math.sin(walkPhase) * 0.7;
        legs[0].rotation.x = swing;
        legs[3].rotation.x = swing;
        legs[1].rotation.x = -swing;
        legs[2].rotation.x = -swing;
        bodyPivot.position.y = Math.abs(Math.sin(walkPhase)) * 0.06;
        headPivot.rotation.x = Math.sin(walkPhase * 2) * 0.05;
        tailPivot.rotation.y = Math.sin(t * 14) * 0.35;
      } else if (digLeft > 0) {
        digLeft -= dt;
        // Nose down, front paws paddling.
        headPivot.rotation.x = 0.55;
        bodyPivot.rotation.x = 0.22;
        legs[0].rotation.x = Math.sin(t * 22) * 0.9 - 0.4;
        legs[1].rotation.x = Math.sin(t * 22 + Math.PI) * 0.9 - 0.4;
        tailPivot.rotation.y = Math.sin(t * 20) * 0.5;
      } else {
        for (const l of legs) l.rotation.x *= 0.8;
        bodyPivot.position.y *= 0.8;
        bodyPivot.rotation.x *= 0.85;
        headPivot.rotation.x = Math.sin(t * 1.3) * 0.06;
        headPivot.rotation.z = Math.sin(t * 0.7) * 0.08;
        // Happy idle wag, and a little breathing.
        tailPivot.rotation.y = Math.sin(t * 9) * 0.5;
        body.scale.y += (0.85 + Math.sin(t * 2.2) * 0.012 - body.scale.y) * Math.min(1, dt * 10);
      }
      if (hop > 0) {
        // Legs tuck up mid-air, ears flop.
        for (const l of legs) l.rotation.x = -0.6;
        headPivot.rotation.x = -0.25;
      } else if (body.scale.y < 0.84) {
        body.scale.y += (0.85 - body.scale.y) * Math.min(1, dt * 12);
      }
    },
  };
  return rig;
}

/* ------------------------------------------------------------------ *
 * Plants and rocks
 * ------------------------------------------------------------------ */

/** A drooping palm leaf, built along +x. */
function frondGeometry(length: number, droop: number): THREE.BufferGeometry {
  const seg = 10;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const w = 0.42 * Math.sin(Math.PI * (0.12 + 0.88 * t)) * (1 - t * 0.35);
    const x = t * length;
    const y = -t * t * droop;
    pos.push(x, y, -w, x, y + 0.04, w);
    if (i < seg) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A palm tree. Its crown sways with the wind; the trunk leans and curves a
 * little so no two palms look the same.
 */
export function makePalm(
  height: number,
  lean: number,
  wind: { uWind: { value: number } },
  animators: Set<(dt: number, t: number) => void>,
  frondColor = '#3fae5a',
  dead = false,
): THREE.Group {
  const g = new THREE.Group();
  const trunkMat = mat(dead ? '#9b8a77' : '#a8805a', 0.95);
  const segs = 7;
  let x = 0;
  let y = 0;
  for (let i = 0; i < segs; i++) {
    const t = i / segs;
    const h = height / segs;
    const piece = cyl(0.2 - t * 0.08, 0.23 - t * 0.08, h * 1.05, trunkMat, 9);
    const dx = Math.sin(lean) * h * (0.6 + t);
    piece.position.set(x + dx / 2, y + h / 2, 0);
    piece.rotation.z = -lean * (0.6 + t * 0.8);
    g.add(piece);
    // Ring scars on the trunk.
    const band = cyl(0.21 - t * 0.08, 0.21 - t * 0.08, 0.05, mat('#8a6644', 1), 9);
    band.position.copy(piece.position);
    band.rotation.copy(piece.rotation);
    g.add(band);
    x += dx;
    y += h * Math.cos(lean * 0.6);
  }
  const crown = new THREE.Group();
  crown.position.set(x, y, 0);
  g.add(crown);
  if (!dead) {
    const leafMat = mat(frondColor, 0.7, 0, 'double');
    const leafDark = mat('#2d8a47', 0.75, 0, 'double');
    const n = 8;
    for (let i = 0; i < n; i++) {
      const leaf = new THREE.Mesh(frondGeometry(2.4 + (i % 3) * 0.3, 1.1 + (i % 2) * 0.3), i % 2 ? leafMat : leafDark);
      leaf.rotation.y = (i / n) * TAU + 0.3;
      leaf.rotation.z = 0.25 + (i % 3) * 0.08;
      crown.add(leaf);
    }
    for (let i = 0; i < 3; i++) {
      const nut = ball(0.13, mat('#6b4a2b', 0.8), 10);
      nut.position.set(Math.cos(i * 2.1) * 0.18, -0.15, Math.sin(i * 2.1) * 0.18);
      crown.add(nut);
    }
  } else {
    // A bare, broken top for the run-down beach.
    const stub = cyl(0.12, 0.14, 0.35, trunkMat, 7);
    stub.rotation.z = 0.6;
    crown.add(stub);
  }
  shadowed(g);

  const phase = Math.random() * TAU;
  animators.add((_dt, t) => {
    const w = wind.uWind.value;
    crown.rotation.z = Math.sin(t * 1.6 + phase) * 0.07 * w;
    crown.rotation.x = Math.sin(t * 1.1 + phase * 1.7) * 0.05 * w;
    crown.children.forEach((leaf, i) => {
      if (leaf instanceof THREE.Mesh && leaf.geometry.type === 'BufferGeometry') {
        leaf.rotation.z = 0.25 + (i % 3) * 0.08 + Math.sin(t * 3 + i + phase) * 0.06 * w;
      }
    });
  });
  return g;
}

/** A field of grass blades that ripple in the wind. */
export function makeGrass(
  count: number,
  place: () => [number, number] | null,
  colors: string[],
  height: number,
  uniforms: { uTime: { value: number }; uWind: { value: number } },
): THREE.Group {
  const group = new THREE.Group();
  const blade = new THREE.ConeGeometry(0.05, height, 3, 1);
  blade.translate(0, height / 2, 0);
  const per = Math.ceil(count / colors.length);
  colors.forEach((color) => {
    const m = windy(new THREE.MeshStandardMaterial({ color, roughness: 0.9 }), uniforms, 0.55 / height);
    const mesh = new THREE.InstancedMesh(blade, m, per);
    const tmp = new THREE.Object3D();
    let n = 0;
    for (let i = 0; i < per * 4 && n < per; i++) {
      const at = place();
      if (!at) continue;
      tmp.position.set(at[0], 0, at[1]);
      tmp.rotation.set((Math.random() - 0.5) * 0.4, Math.random() * TAU, (Math.random() - 0.5) * 0.4);
      const s = 0.6 + Math.random() * 0.8;
      tmp.scale.set(s, s, s);
      tmp.updateMatrix();
      mesh.setMatrixAt(n++, tmp.matrix);
    }
    mesh.count = n;
    mesh.receiveShadow = true;
    group.add(mesh);
  });
  return group;
}

/** A lumpy, flat-shaded rock. */
export function makeRock(r: number, color = '#9aa0a8'): THREE.Mesh {
  const g = new THREE.IcosahedronGeometry(r, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const k = 0.82 + Math.random() * 0.3;
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.7, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return shadowed(new THREE.Mesh(g, mat(color, 0.95, 0, 'flat')));
}

/* ------------------------------------------------------------------ *
 * Effects
 * ------------------------------------------------------------------ */

/** A burst of little cubes or stars that fly up and fade. */
export function burst(
  scene: THREE.Scene,
  animators: Set<(dt: number, t: number) => void>,
  at: THREE.Vector3,
  color: string,
  count = 26,
  power = 3,
): void {
  const m = new THREE.MeshBasicMaterial({ color, transparent: true });
  const geo = new THREE.OctahedronGeometry(0.09, 0);
  const bits: { mesh: THREE.Mesh; v: THREE.Vector3 }[] = [];
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.copy(at);
    const a = Math.random() * TAU;
    const up = 0.6 + Math.random();
    bits.push({ mesh, v: new THREE.Vector3(Math.cos(a), up, Math.sin(a)).multiplyScalar(power * (0.5 + Math.random() * 0.6)) });
    scene.add(mesh);
  }
  let life = 1;
  const fn = (dt: number) => {
    life -= dt * 1.1;
    for (const b of bits) {
      b.v.y -= 9 * dt;
      b.mesh.position.addScaledVector(b.v, dt);
      b.mesh.rotation.x += dt * 6;
      b.mesh.rotation.y += dt * 5;
      if (b.mesh.position.y < 0.05) {
        b.mesh.position.y = 0.05;
        b.v.multiplyScalar(0.4);
      }
    }
    m.opacity = Math.max(0, life);
    if (life <= 0) {
      for (const b of bits) scene.remove(b.mesh);
      geo.dispose();
      m.dispose();
      animators.delete(fn);
    }
  };
  animators.add(fn);
}

/** A floating, bobbing marker with an icon, drawn on a canvas sprite. */
export function makeMarker(icon: string, color = '#ffd15c'): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(40,55,90,0.25)';
  g.beginPath();
  g.ellipse(64, 150, 26, 7, 0, 0, TAU);
  g.fill();
  g.fillStyle = color;
  g.strokeStyle = '#ffffff';
  g.lineWidth = 9;
  g.beginPath();
  g.moveTo(64, 132);
  g.lineTo(42, 104);
  g.arc(64, 64, 52, Math.PI * 0.72, Math.PI * 0.28);
  g.closePath();
  g.fill();
  g.stroke();
  g.font = '58px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(icon, 64, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(1.1, 1.375, 1);
  sprite.renderOrder = 10;
  return sprite;
}

/** Eases an object in from nothing with a little overshoot. */
export function popIn(o: THREE.Object3D, animators: Set<(dt: number, t: number) => void>, delay = 0): void {
  const final = o.scale.clone();
  o.scale.setScalar(0.0001);
  let t = -delay;
  const fn = (dt: number) => {
    t += dt;
    if (t < 0) return;
    const p = Math.min(1, t / 0.6);
    const s = 1 + 2.2 * Math.pow(p - 1, 3) + 1.4 * Math.pow(p - 1, 2);
    o.scale.copy(final).multiplyScalar(Math.max(0.0001, s));
    if (p >= 1) {
      o.scale.copy(final);
      animators.delete(fn);
    }
  };
  animators.add(fn);
}

/**
 * Paw prints pressed into the sand, fading back to smooth sand over a few
 * seconds. One instanced mesh, so a long run costs a single draw call.
 */
export class Footprints {
  readonly mesh: THREE.InstancedMesh;
  private ages: number[] = [];
  private next = 0;
  private tmp = new THREE.Object3D();
  private fresh: THREE.Color;
  private faded: THREE.Color;
  private colour = new THREE.Color();

  constructor(fresh = '#c9a970', faded = '#ecd6a4', count = 160) {
    const g = new THREE.CircleGeometry(0.09, 10);
    g.rotateX(-Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(g, new THREE.MeshLambertMaterial({ color: '#ffffff' }), count);
    this.mesh.receiveShadow = true;
    this.fresh = new THREE.Color(fresh);
    this.faded = new THREE.Color(faded);
    for (let i = 0; i < count; i++) {
      this.ages.push(99);
      this.tmp.scale.setScalar(0);
      this.tmp.updateMatrix();
      this.mesh.setMatrixAt(i, this.tmp.matrix);
      this.mesh.setColorAt(i, this.faded);
    }
    this.mesh.frustumCulled = false;
  }

  /** Matches the prints to a place's sand. */
  setColors(fresh: string, faded: string): void {
    this.fresh.set(fresh);
    this.faded.set(faded);
  }

  /** Presses a print at (x, y, z) beside the dog's path. */
  add(x: number, y: number, z: number, heading: number, side: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.ages.length;
    const ox = Math.cos(heading) * 0.14 * side;
    const oz = -Math.sin(heading) * 0.14 * side;
    this.tmp.position.set(x + ox, y + 0.015, z + oz);
    this.tmp.rotation.set(0, heading, 0);
    this.tmp.scale.set(1, 1, 1.35);
    this.tmp.updateMatrix();
    this.mesh.setMatrixAt(i, this.tmp.matrix);
    this.ages[i] = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number): void {
    let dirty = false;
    for (let i = 0; i < this.ages.length; i++) {
      if (this.ages[i] > 8) continue;
      this.ages[i] += dt;
      const f = Math.min(1, this.ages[i] / 7);
      this.colour.copy(this.fresh).lerp(this.faded, f * f);
      this.mesh.setColorAt(i, this.colour);
      if (this.ages[i] > 8) {
        this.mesh.getMatrixAt(i, this.tmp.matrix);
        this.tmp.matrix.decompose(this.tmp.position, this.tmp.quaternion, this.tmp.scale);
        this.tmp.scale.setScalar(0);
        this.tmp.updateMatrix();
        this.mesh.setMatrixAt(i, this.tmp.matrix);
        this.mesh.instanceMatrix.needsUpdate = true;
      }
      dirty = true;
    }
    if (dirty && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear(): void {
    for (let i = 0; i < this.ages.length; i++) this.ages[i] = 8.5;
    this.tmp.scale.setScalar(0);
    this.tmp.position.set(0, -10, 0);
    this.tmp.updateMatrix();
    for (let i = 0; i < this.ages.length; i++) this.mesh.setMatrixAt(i, this.tmp.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ *
 * The friend who throws the ball
 * ------------------------------------------------------------------ */

export interface ThrowerRig {
  group: THREE.Group;
  /** World position of the throwing hand. */
  hand(): THREE.Vector3;
  /** Plays a wind-up and throw; calls `release` at the moment of letting go. */
  throwBall(release: () => void): void;
  cheer(): void;
  shrug(): void;
  /** Turns to look at a point. */
  face(p: THREE.Vector3): void;
  update(dt: number, t: number): void;
}

/** A cheerful beach-goer in a sun hat, built from simple shapes. */
export function makeThrower(): ThrowerRig {
  const skin = mat('#d9a27c', 0.8);
  const tee = mat('#5fdbab', 0.8);
  const stripe = mat('#ffffff', 0.8);
  const shorts = mat('#3d5a99', 0.8);
  const hatMat = mat('#f6d98b', 0.9);
  const dark = mat('#2a2230', 0.4);

  const group = new THREE.Group();
  const bodyPivot = new THREE.Group();
  group.add(bodyPivot);

  // Legs.
  const legs: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(s * 0.17, 0.85, 0);
    const leg = cyl(0.1, 0.09, 0.8, skin, 10);
    leg.position.y = -0.4;
    const short = cyl(0.14, 0.13, 0.32, shorts, 10);
    short.position.y = -0.12;
    const shoe = ball(0.12, mat('#ffffff', 0.6), 10);
    shoe.scale.set(1, 0.6, 1.5);
    shoe.position.set(0, -0.82, 0.05);
    hip.add(leg, short, shoe);
    bodyPivot.add(hip);
    legs.push(hip);
  }
  // Body: a rounded striped tee.
  const torso = cyl(0.3, 0.33, 0.75, tee, 16);
  torso.position.y = 1.25;
  bodyPivot.add(torso);
  for (let i = 0; i < 3; i++) {
    const band = cyl(0.315 + i * 0.006, 0.315 + i * 0.006, 0.07, stripe, 16);
    band.position.y = 1.05 + i * 0.2;
    bodyPivot.add(band);
  }
  // Head with a sun hat and a friendly face.
  const head = new THREE.Group();
  head.position.y = 1.9;
  const face = ball(0.27, skin, 18);
  head.add(face);
  for (const s of [-1, 1]) {
    const eye = ball(0.035, dark, 8);
    eye.position.set(s * 0.09, 0.04, 0.24);
    const cheek = ball(0.045, mat('#ff9aa5', 0.6), 8);
    cheek.scale.set(1, 0.6, 0.4);
    cheek.position.set(s * 0.15, -0.05, 0.2);
    head.add(eye, cheek);
  }
  const smile = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.014, 6, 12, Math.PI), dark);
  smile.rotation.z = Math.PI;
  smile.position.set(0, -0.06, 0.25);
  head.add(smile);
  const brim = cyl(0.5, 0.5, 0.04, hatMat, 24);
  brim.position.y = 0.17;
  const crown = cyl(0.24, 0.27, 0.22, hatMat, 18);
  crown.position.y = 0.28;
  const ribbon = cyl(0.272, 0.272, 0.06, mat('#ff6b6b', 0.6), 18);
  ribbon.position.y = 0.2;
  head.add(brim, crown, ribbon);
  bodyPivot.add(head);
  // Arms pivot at the shoulder.
  const arms: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(s * 0.37, 1.55, 0);
    const sleeve = ball(0.12, tee, 10);
    const arm = cyl(0.07, 0.06, 0.62, skin, 8);
    arm.position.y = -0.33;
    const handMesh = ball(0.08, skin, 8);
    handMesh.position.y = -0.66;
    shoulder.add(sleeve, arm, handMesh);
    shoulder.rotation.z = s * 0.15;
    bodyPivot.add(shoulder);
    arms.push(shoulder);
  }
  shadowed(group, true, false);

  const throwArm = arms[1];
  let action: 'idle' | 'throw' | 'cheer' | 'shrug' = 'idle';
  let actionT = 0;
  let release: (() => void) | null = null;
  let heading = 0;

  const rig: ThrowerRig = {
    group,
    hand() {
      const p = new THREE.Vector3(0, -0.66, 0);
      throwArm.localToWorld(p);
      return p;
    },
    throwBall(cb) {
      action = 'throw';
      actionT = 0;
      release = cb;
    },
    cheer() {
      action = 'cheer';
      actionT = 0;
    },
    shrug() {
      action = 'shrug';
      actionT = 0;
    },
    face(p) {
      heading = Math.atan2(p.x - group.position.x, p.z - group.position.z);
    },
    update(dt, t) {
      actionT += dt;
      group.rotation.y += (heading - group.rotation.y) * Math.min(1, dt * 6);
      bodyPivot.position.y = 0;
      arms[0].rotation.set(0, 0, -0.15);
      if (action === 'throw') {
        // Wind up (arm back), whip forward, follow through.
        if (actionT < 0.45) throwArm.rotation.x = THREE.MathUtils.lerp(0, 2.4, actionT / 0.45);
        else if (actionT < 0.6) {
          throwArm.rotation.x = THREE.MathUtils.lerp(2.4, -1.4, (actionT - 0.45) / 0.15);
          if (release && actionT > 0.52) {
            const cb = release;
            release = null;
            cb();
          }
        } else if (actionT < 1.0) throwArm.rotation.x = THREE.MathUtils.lerp(-1.4, 0, (actionT - 0.6) / 0.4);
        else action = 'idle';
        bodyPivot.rotation.y = actionT < 0.45 ? -0.3 * (actionT / 0.45) : 0.2;
      } else if (action === 'cheer') {
        const hop = Math.abs(Math.sin(actionT * 9)) * 0.25;
        bodyPivot.position.y = hop;
        throwArm.rotation.set(Math.PI, 0, 0.3 + Math.sin(actionT * 18) * 0.2);
        arms[0].rotation.set(Math.PI, 0, -0.3 - Math.sin(actionT * 18) * 0.2);
        if (actionT > 1.2) action = 'idle';
      } else if (action === 'shrug') {
        throwArm.rotation.set(0, 0, 0.9);
        arms[0].rotation.set(0, 0, -0.9);
        head.rotation.z = Math.sin(actionT * 6) * 0.12;
        if (actionT > 1.0) {
          action = 'idle';
          head.rotation.z = 0;
        }
      } else {
        throwArm.rotation.set(Math.sin(t * 1.4) * 0.08, 0, 0.15);
        bodyPivot.rotation.y *= 0.9;
        head.rotation.y = Math.sin(t * 0.8) * 0.2;
        bodyPivot.position.y = Math.sin(t * 2) * 0.01;
      }
      for (const l of legs) l.rotation.x = 0;
    },
  };
  return rig;
}
