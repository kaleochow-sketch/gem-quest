/**
 * The Sunrise Shore beach and its café, in 3D.
 *
 * The beach itself (sand, sea, dunes, palms, clouds, gulls) is built once.
 * The café is rebuilt from the save whenever it changes, so every task —
 * clearing trash, fixing the roof, painting the walls — shows up as a real
 * change in the place, and colour previews are just a rebuild with a
 * different choice.
 */
import * as THREE from 'three';
import { CafeState, DECOR, choiceOf } from '../game/cafe.js';
import { World, TAU } from './engine.js';
import type { Ferry, Seat, Site, Spot } from './site.js';
import { ball, box, cyl, makePalm, makeGrass, makeRock, mat, shadowed } from './models.js';

/** Height of the sand at (x, z): flat beach, sloping into the sea, dunes behind. */
export function sandY(x: number, z: number): number {
  let y = 0;
  if (z > 4) y -= (z - 4) * 0.13;
  if (z < -13) y += (-13 - z) * 0.16 + Math.sin(x * 0.25) * 0.4 * Math.min(1, (-13 - z) / 6);
  y += Math.sin(x * 0.7 + z * 0.3) * 0.04 + Math.sin(x * 0.23 - z * 0.41) * 0.06;
  return y;
}

/** The shack's footprint, which the dog walks around. */
export const SHACK = { x0: -3.6, x1: 3.6, z0: -9.2, z1: -4.1 };

/** The pier: a walkway from a ramp on the sand out over the water. */
export const PIER = { x0: 12.1, x1: 13.9, rampZ: 4.3, z0: 6.5, z1: 19.2, deck: 0.66 };

export type { Spot } from './site.js';

/** The beach's own palms: x, z, height, lean. */
const PALMS: [number, number, number, number][] = [
  [-16, -6, 6.5, 0.25],
  [-13.5, -2, 5.6, -0.15],
  [-10.5, -1.6, 6, 0.2],
  [16, -5, 6.8, -0.3],
  [19, 1, 5.4, 0.35],
  [-19, 2, 5.8, -0.25],
  [10, -11, 6.2, 0.1],
];

const TOP_TEXT_CACHE = new Map<string, THREE.CanvasTexture>();

/** A painted wooden sign with lettering. */
function signTexture(text: string, bg: string): THREE.CanvasTexture {
  const keyName = `${text}|${bg}`;
  const hit = TOP_TEXT_CACHE.get(keyName);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, 512, 128);
  g.strokeStyle = 'rgba(255,255,255,0.8)';
  g.lineWidth = 10;
  g.strokeRect(8, 8, 496, 112);
  g.font = '900 62px ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(40,40,60,0.55)';
  g.strokeText(text, 256, 68);
  g.fillStyle = '#ffffff';
  g.fillText(text, 256, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  TOP_TEXT_CACHE.set(keyName, tex);
  return tex;
}

export class Beach implements Site {
  readonly world: World;
  readonly root = new THREE.Group();
  readonly anim = new Set<(dt: number, t: number) => void>();
  readonly walkables: THREE.Object3D[] = [];
  readonly prints: [string, string] = ['#c9a970', '#f0dba8'];
  readonly cafe = new THREE.Group();
  /** Lamps that glow after dark: material plus optional light. */
  private glows: { m: THREE.MeshStandardMaterial; light?: THREE.PointLight; power: number; always: number; flicker: boolean }[] = [];
  private flames: THREE.Mesh[] = [];
  private fireworksAt = 0;
  private opened = false;
  private sand!: THREE.Mesh;
  /** Objects a player can tap to repaint, keyed by task id. */
  readonly paintable = new Map<string, THREE.Object3D>();
  private deckBuilt = false;
  private pierFixed = false;
  /** Round obstacles the dog walks around (trunks, tables, the boat…). */
  colliders: { x: number; z: number; r: number }[] = [];
  /** Things to interact with, rebuilt with the café. */
  spots: Spot[] = [];
  /** The lounger and table seats, for the dog and for visitors. */
  seats: Seat[] = [];
  readonly queue: [number, number][] = [[0, -0.55], [0.15, 0.6], [-0.15, 1.75]];
  readonly workerAt: [number, number, number] = [0, 0.36, -2.85];
  readonly start: [number, number] = [0, 3];

  get content(): THREE.Group {
    return this.cafe;
  }

  walkRoutes(): [number, number][][] {
    return [
      [[-23, 3.4], [-3.4, 3.0]],
      [[23, 3.6], [4.2, 3.4]],
    ];
  }

  ferry(): Ferry | null {
    if (!this.pierFixed) return null;
    return {
      kind: 'boat',
      from: [19, -0.3, 48],
      dock: [15.1, -0.3, 18.6],
      land: [15.1, PIER.deck, 18.6],
      walk: [[13, 18.2], [13, 7], [13, PIER.rampZ - 0.4], [6, 3.6]],
    };
  }

  constructor(world: World) {
    this.world = world;
    this.buildEnvironment();
    this.root.add(this.cafe);
    this.anim.add((dt, t) => this.animate(dt, t));
  }

  /** Where the dog stands: sand, the deck, or the pier once repaired. */
  groundAt(x: number, z: number): number {
    if (this.deckBuilt && x > -3.8 && x < 3.8 && z > -4.3 && z < -1.2) return 0.36;
    if (this.onPier(x, z)) {
      if (z < PIER.z0) {
        const start = sandY(x, PIER.rampZ);
        return start + (PIER.deck - start) * ((z - PIER.rampZ) / (PIER.z0 - PIER.rampZ));
      }
      return PIER.deck;
    }
    return sandY(x, z);
  }

  private onPier(x: number, z: number): boolean {
    return this.pierFixed && x > PIER.x0 - 0.05 && x < PIER.x1 + 0.05 && z > PIER.rampZ && z < PIER.z1 + 0.05;
  }

  /** Keeps a point on the beach (or pier), out of the shack and furniture. */
  clamp(p: THREE.Vector3): void {
    p.x = THREE.MathUtils.clamp(p.x, -22, 22);
    // Out over the water only along a repaired pier.
    if (this.pierFixed && p.z > 8.5 && p.x > PIER.x0 - 0.6 && p.x < PIER.x1 + 0.6) {
      p.x = THREE.MathUtils.clamp(p.x, PIER.x0, PIER.x1);
      p.z = Math.min(p.z, PIER.z1);
    } else {
      p.z = THREE.MathUtils.clamp(p.z, -12, 8.5);
    }
    for (const c of this.colliders) {
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      const d = Math.hypot(dx, dz);
      if (d < c.r && d > 0.0001) {
        p.x = c.x + (dx / d) * c.r;
        p.z = c.z + (dz / d) * c.r;
      }
    }
    if (p.x > SHACK.x0 && p.x < SHACK.x1 && p.z > SHACK.z0 && p.z < SHACK.z1) {
      const out = [p.x - SHACK.x0, SHACK.x1 - p.x, p.z - SHACK.z0, SHACK.z1 - p.z];
      const m = Math.min(...out);
      if (m === out[0]) p.x = SHACK.x0;
      else if (m === out[1]) p.x = SHACK.x1;
      else if (m === out[2]) p.z = SHACK.z0;
      else p.z = SHACK.z1;
    }
    p.y = this.groundAt(p.x, p.z);
  }

  /* ---------------------------------------------------------------- *
   * The beach
   * ---------------------------------------------------------------- */

  private buildEnvironment(): void {
    const w = this.world;

    // Sand, coloured by height: wet near the water, pale on the beach,
    // grassy green on the dunes.
    const geo = new THREE.PlaneGeometry(170, 90, 120, 64);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -14);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors: number[] = [];
    const wet = new THREE.Color('#d9b980');
    const dry = new THREE.Color('#f4dfae');
    const dune = new THREE.Color('#e9d39b');
    const grass = new THREE.Color('#a7c97a');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = sandY(x, z);
      pos.setY(i, y);
      const c = dry.clone();
      if (z > 3) c.lerp(wet, Math.min(1, (z - 3) / 3));
      if (z < -13) c.lerp(dune, Math.min(1, (-13 - z) / 4)).lerp(grass, Math.min(0.75, Math.max(0, (-17 - z) / 8)));
      const n = (Math.sin(x * 3.1) * Math.sin(z * 2.7) + Math.sin(x * 9.3 + z * 7.1) * 0.5) * 0.025;
      c.offsetHSL(0, 0, n);
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    this.sand = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    this.sand.receiveShadow = true;
    this.root.add(this.sand);
    this.walkables.push(this.sand);

    // The sea, with rolling waves.
    const seaGeo = new THREE.PlaneGeometry(320, 200, 96, 60);
    seaGeo.rotateX(-Math.PI / 2);
    seaGeo.translate(0, -0.32, 104);
    // Turquoise in the shallows, deepening to blue further out.
    const seaColors: number[] = [];
    const shallow = new THREE.Color('#58d6d2');
    const deep = new THREE.Color('#1d6fae');
    const sp = seaGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < sp.count; i++) {
      const c = shallow.clone().lerp(deep, Math.min(1, Math.max(0, (sp.getZ(i) - 7) / 45)));
      seaColors.push(c.r, c.g, c.b);
    }
    seaGeo.setAttribute('color', new THREE.Float32BufferAttribute(seaColors, 3));
    const sea = new THREE.Mesh(
      seaGeo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.06, metalness: 0.02, transparent: true, opacity: 0.86 }),
    );
    sea.receiveShadow = true;
    this.root.add(sea);
    const seaPos = seaGeo.attributes.position as THREE.BufferAttribute;
    const base = Float32Array.from(seaPos.array as Float32Array);
    let waveTick = 0;
    this.anim.add((dt, t) => {
      waveTick += dt;
      if (waveTick < 1 / 30) return;
      waveTick = 0;
      const wind = w.windUniforms.uWind.value;
      for (let i = 0; i < seaPos.count; i++) {
        const x = base[i * 3];
        const z = base[i * 3 + 2];
        const y =
          base[i * 3 + 1] +
          (Math.sin(x * 0.28 + t * 1.1) * 0.1 + Math.sin(z * 0.45 - t * 1.5) * 0.09 + Math.sin((x + z) * 0.9 + t * 2.4) * 0.035) *
            (0.6 + wind * 0.6);
        seaPos.setY(i, y);
      }
      seaPos.needsUpdate = true;
      seaGeo.computeVertexNormals();
    });

    // Foam that washes up and back.
    // Sits right at the waterline (where the sand dips below the sea at
    // about z = 6.5) so it reads as surf, not a stripe on the beach.
    const foamMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.4, depthWrite: false });
    const foam = new THREE.Mesh(new THREE.PlaneGeometry(170, 0.55, 60, 1), foamMat);
    foam.rotation.x = -Math.PI / 2;
    this.root.add(foam);
    this.anim.add((_dt, t) => {
      const s = Math.sin(t * 0.7);
      foam.position.set(0, -0.3 + s * 0.03, 6.55 - s * 0.55);
      foamMat.opacity = 0.18 + (s + 1) * 0.14;
    });

    // Far islands on the horizon.
    for (const [x, z, s] of [[-70, 150, 16], [40, 170, 22], [110, 140, 12]] as const) {
      const isle = new THREE.Mesh(new THREE.SphereGeometry(s, 20, 10, 0, TAU, 0, Math.PI / 2), mat('#5f9a74', 1));
      isle.scale.y = 0.35;
      isle.position.set(x, -0.6, z);
      this.root.add(isle);
    }

    // Palms that frame the beach (the café adds more later).
    for (const [x, z, h, lean] of PALMS) {
      const palm = makePalm(h, lean, w.windUniforms, this.anim);
      palm.position.set(x, sandY(x, z), z);
      palm.rotation.y = Math.random() * TAU;
      this.root.add(palm);
    }

    // Rocks along the edges.
    for (const [x, z, r] of [[-21, 6, 1.4], [-20, 7.5, 0.8], [21, 7, 1.6], [19.5, 5.4, 0.7], [-8, -12, 1], [14, -9, 0.9]] as const) {
      const rock = makeRock(r);
      rock.position.set(x, sandY(x, z) + r * 0.2, z);
      rock.rotation.y = x;
      this.root.add(rock);
    }

    // Dune grass behind the beach, rippling in the wind.
    const dunes = makeGrass(
      1600,
      () => {
        const x = (Math.random() - 0.5) * 80;
        const z = -14 - Math.random() * 16;
        return [x, z];
      },
      ['#7fb85a', '#93c96a', '#a9c76e'],
      0.75,
      w.windUniforms,
    );
    dunes.children.forEach((m) => {
      const mesh = m as THREE.InstancedMesh;
      const tmp = new THREE.Matrix4();
      const p = new THREE.Vector3();
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, tmp);
        p.setFromMatrixPosition(tmp);
        tmp.setPosition(p.x, sandY(p.x, p.z), p.z);
        mesh.setMatrixAt(i, tmp);
      }
      mesh.instanceMatrix.needsUpdate = true;
    });
    this.root.add(dunes);

    // Puffy clouds drifting slowly across.
    const cloudMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, transparent: true, opacity: 0.95 });
    const clouds: THREE.Group[] = [];
    for (let i = 0; i < 7; i++) {
      const c = new THREE.Group();
      for (let k = 0; k < 5; k++) {
        const puff = ball(3 + Math.random() * 3, cloudMat, 12);
        puff.position.set(k * 3.5 - 7, Math.random() * 1.5, Math.random() * 2);
        puff.scale.y = 0.6;
        c.add(puff);
      }
      c.position.set(-120 + i * 40, 34 + Math.random() * 12, 40 + Math.random() * 100);
      clouds.push(c);
      this.root.add(c);
    }
    this.anim.add((dt) => {
      for (const c of clouds) {
        c.position.x += dt * (1 + w.windUniforms.uWind.value * 2);
        if (c.position.x > 160) c.position.x = -160;
      }
      cloudMat.color.setScalar(1 - w.night * 0.65);
    });

    // A pair of gulls circling over the water.
    const gullMat = mat('#ffffff', 0.7, 0, 'double');
    for (let i = 0; i < 3; i++) {
      const gull = new THREE.Group();
      const wingL = box(0.9, 0.04, 0.25, gullMat);
      const wingR = box(0.9, 0.04, 0.25, gullMat);
      wingL.position.x = -0.45;
      wingR.position.x = 0.45;
      const pivL = new THREE.Group();
      const pivR = new THREE.Group();
      pivL.add(wingL);
      pivR.add(wingR);
      gull.add(pivL, pivR, ball(0.14, gullMat, 8));
      this.root.add(gull);
      const r = 14 + i * 5;
      const speed = 0.18 + i * 0.05;
      this.anim.add((_dt, t) => {
        const a = t * speed + i * 2;
        gull.position.set(Math.cos(a) * r, 10 + i * 2 + Math.sin(t * 0.8 + i) * 1.2, 22 + Math.sin(a) * r * 0.6);
        gull.rotation.y = -a;
        const flap = Math.sin(t * 7 + i) * 0.5;
        pivL.rotation.z = flap;
        pivR.rotation.z = -flap;
      });
    }
  }

  /* ---------------------------------------------------------------- *
   * The café, rebuilt from the save
   * ---------------------------------------------------------------- */

  /** Clears and rebuilds the café for a state. `preview` overrides one choice. */
  build(state: CafeState, preview?: { task: string; swatch: string }): void {
    this.cafe.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) mesh.geometry.dispose();
    });
    for (const g of this.glows) if (g.light) g.light.dispose();
    this.cafe.clear();
    this.glows = [];
    this.flames = [];
    this.paintable.clear();
    this.colliders = [];
    this.spots = [];
    this.seats = [];
    this.pierFixed = state.done.includes('pier');
    // The beach's own palms are solid, and can be shaken for coconuts.
    PALMS.forEach(([x, z], i) => {
      this.colliders.push({ x, z, r: 0.55 });
      this.spots.push({ kind: 'palm', x, z, r: 1.7, key: `palm-${i}`, label: 'Shake the palm', icon: '🥥', reward: 10 });
    });

    const has = (id: string) => state.done.includes(id);
    const pick = (id: string, fallback: string): string => {
      if (preview && preview.task === id) return preview.swatch;
      return choiceOf(state, id)?.color ?? fallback;
    };
    const add = (o: THREE.Object3D, x: number, z: number, y?: number) => {
      o.position.set(x, y ?? sandY(x, z), z);
      shadowed(o);
      this.cafe.add(o);
      return o;
    };
    const tag = (o: THREE.Object3D, task: string) => {
      o.userData.paintTask = task;
      this.paintable.set(task, o);
      return o;
    };
    this.deckBuilt = has('deck');
    this.opened = has('opening');

    this.buildShack(state, has, pick, add, tag, preview);
    this.buildBeachMess(has, add);
    this.buildCafeFurniture(has, pick, add, tag);
    this.buildBeachLife(has, pick, add, tag);
    for (const d of DECOR) if (state.decor.includes(d.id)) this.buildDecor(d.id, add);
  }

  /**
   * Registers something that lights up. `always` is how much it glows by day
   * (a fire), `power` how much more at full night (lamps), and fires flicker.
   */
  private glow(m: THREE.MeshStandardMaterial, power: number, light?: THREE.PointLight, always = 0, flicker = false): void {
    this.glows.push({ m, power, light, always, flicker });
  }

  private buildShack(
    _state: CafeState,
    has: (id: string) => boolean,
    pick: (id: string, fallback: string) => string,
    add: (o: THREE.Object3D, x: number, z: number, y?: number) => THREE.Object3D,
    tag: (o: THREE.Object3D, task: string) => THREE.Object3D,
    preview?: { task: string; swatch: string },
  ): void {
    const shack = new THREE.Group();
    const cx = 0;
    const cz = -6.65;
    const W = 7;
    const D = 5;
    const H = 2.6;

    // Floor: dusty and sandy at first, swept, then polished to a shine.
    const floorColor = has('polish') ? '#d9a46c' : has('floor') ? '#b98b5c' : '#8f7a5c';
    const floor = box(W, 0.3, D, mat(floorColor, has('polish') ? 0.28 : 0.95));
    floor.position.set(0, 0.15, 0);
    shack.add(floor);
    for (let i = 0; i < 8; i++) {
      const seam = box(0.03, 0.02, D, mat('#6e5640', 1));
      seam.position.set(-W / 2 + (i + 0.5) * (W / 8), 0.31, 0);
      shack.add(seam);
    }
    if (!has('floor')) {
      for (const [x, z, r] of [[-1.5, 1, 0.5], [1.2, 1.6, 0.4], [2.4, -0.5, 0.35], [-2.5, -1.2, 0.45]]) {
        const pile = ball(r, mat('#e8cf98', 1), 10);
        pile.scale.y = 0.3;
        pile.position.set(x, 0.32, z);
        shack.add(pile);
      }
    }

    // Walls are solid panels with real openings for the windows and door, and
    // boards laid over them. (They used to be separate planks with gaps
    // between them, which read as see-through slits.) Run-down walls keep
    // their missing and crooked boards, but over a dark backing.
    const fixed = has('walls');
    const paintColor = has('paint') || preview?.task === 'paint' ? pick('paint', '#b98758') : '#b98758';
    const wallMat = fixed ? mat(paintColor, 0.8) : mat('#9a958b', 1);
    const backMat = fixed ? wallMat : mat('#5f5a53', 1);
    const trim = mat(fixed ? '#8a5e3c' : '#7d776d', 0.9);
    const T = 0.14;
    const wallGroup = new THREE.Group();
    const top = 0.3 + H;
    /** A solid rectangle of wall in the wall's own plane. */
    const panel = (along: 'x' | 'z', ox: number, oz: number, u0: number, u1: number, y0: number, y1: number) => {
      const len = u1 - u0;
      const b = box(along === 'x' ? len : T, y1 - y0, along === 'z' ? len : T, backMat);
      const mid = (u0 + u1) / 2;
      b.position.set(along === 'x' ? ox + mid : ox, (y0 + y1) / 2, along === 'z' ? oz + mid : oz);
      wallGroup.add(b);
    };
    /** Boards over a stretch of wall, skipping openings. */
    const boards = (along: 'x' | 'z', ox: number, oz: number, len: number, outward: number, skip?: (u: number) => boolean) => {
      const n = Math.round(len / 0.46);
      for (let i = 0; i < n; i++) {
        const u = -len / 2 + (i + 0.5) * (len / n);
        if (skip && skip(u)) continue;
        if (!fixed && (i * 7 + Math.round(ox * 3 + oz * 5)) % 5 === 0) continue;
        const h = fixed ? H : H - ((i * 13) % 4) * 0.18;
        const w = fixed ? 0.08 : len / n - 0.02;
        const b = box(along === 'x' ? w : 0.05, h, along === 'z' ? w : 0.05, fixed ? trim : wallMat);
        const off = (T / 2 + 0.025) * outward;
        b.position.set(along === 'x' ? ox + u : ox + off, 0.3 + h / 2, along === 'z' ? oz + u : oz + off);
        if (fixed) b.position[along] += len / n / 2 - 0.04;
        if (!fixed && i % 4 === 1) b.rotation[along === 'x' ? 'z' : 'x'] = 0.08;
        wallGroup.add(b);
      }
    };
    // Back and sides: solid.
    panel('x', 0, -D / 2, -W / 2, W / 2, 0.3, top);
    panel('z', -W / 2, 0, -D / 2, D / 2, 0.3, top);
    panel('z', W / 2, 0, -D / 2, D / 2, 0.3, top);
    boards('x', 0, -D / 2, W, -1);
    boards('z', -W / 2, 0, D, -1);
    boards('z', W / 2, 0, D, 1);
    // Front: windows at ±2.1 (1.5 wide, sill 1.4, head 2.4) and a 1.6-wide door.
    for (const s of [-1, 1]) {
      panel('x', 0, D / 2, s > 0 ? 2.85 : -W / 2, s > 0 ? W / 2 : -2.85, 0.3, top);
      panel('x', 0, D / 2, s > 0 ? 0.8 : -1.35, s > 0 ? 1.35 : -0.8, 0.3, top);
      panel('x', 0, D / 2, s > 0 ? 1.35 : -2.85, s > 0 ? 2.85 : -1.35, 0.3, 1.4);
      panel('x', 0, D / 2, s > 0 ? 1.35 : -2.85, s > 0 ? 2.85 : -1.35, 2.4, top);
    }
    panel('x', 0, D / 2, -0.8, 0.8, 2.4, top);
    boards('x', 0, D / 2, W, 1, (u) => Math.abs(u) < 0.8 || Math.abs(Math.abs(u) - 2.1) < 0.75);
    // Corner posts and a sill along the base.
    for (const [x, z] of [[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2]]) {
      const post = box(0.24, H + 0.3, 0.24, trim);
      post.position.set(x, 0.3 + (H + 0.3) / 2, z);
      wallGroup.add(post);
    }
    for (const [w, d, x, z] of [[W + 0.2, 0.22, 0, D / 2], [W + 0.2, 0.22, 0, -D / 2], [0.22, D, -W / 2, 0], [0.22, D, W / 2, 0]]) {
      const plate = box(w, 0.14, d, trim);
      plate.position.set(x, top + 0.07, z);
      wallGroup.add(plate);
    }
    shack.add(wallGroup);
    if (fixed) tag(wallGroup, 'paint');

    // Windows: boarded and cracked, or framed glass that glows at night.
    for (const s of [-1, 1]) {
      const wx = s * 2.1;
      if (has('windows')) {
        const frame = box(1.5, 1.2, 0.16, mat('#fbf7ef', 0.6));
        frame.position.set(wx, 1.9, D / 2);
        shack.add(frame);
        const glassMat = new THREE.MeshStandardMaterial({
          color: '#bfe6ff',
          roughness: 0.05,
          metalness: 0.1,
          emissive: new THREE.Color('#ffc76b'),
          emissiveIntensity: 0,
        });
        const glass = box(1.3, 1.0, 0.18, glassMat);
        glass.position.set(wx, 1.9, D / 2);
        shack.add(glass);
        this.glow(glassMat, 0.9);
        const bar = box(0.06, 1.0, 0.2, mat('#fbf7ef', 0.6));
        bar.position.set(wx, 1.9, D / 2);
        shack.add(bar);
      } else {
        const hole = box(1.3, 1.0, 0.05, mat('#2b2622', 1));
        hole.position.set(wx, 1.9, D / 2 - 0.05);
        shack.add(hole);
        for (const r of [0.6, -0.6]) {
          const board = box(1.6, 0.16, 0.06, mat('#8a8378', 1));
          board.position.set(wx, 1.9, D / 2 + 0.08);
          board.rotation.z = r;
          shack.add(board);
        }
      }
    }

    // Door: hanging off one hinge, or new and painted.
    if (has('door')) {
      const door = box(1.4, 2.1, 0.1, mat(pick('door', '#7cc6f2'), 0.6));
      door.position.set(0, 1.35, D / 2 + 0.02);
      const knob = ball(0.07, mat('#e8c15a', 0.3, 0.8), 8);
      knob.position.set(0.5, 0, 0.08);
      door.add(knob);
      shack.add(tag(door, 'door'));
    } else {
      const door = box(1.3, 2.0, 0.08, mat('#857e73', 1));
      door.position.set(-0.6, 1.2, D / 2 + 0.4);
      door.rotation.set(0.12, 0.9, 0.18);
      shack.add(door);
    }

    // Roof: a few sticks and patches, or a proper gable roof in the chosen style.
    const roofY = 0.3 + H;
    if (has('roof')) {
      const roofMat = mat(pick('roof', '#d9b26a'), 0.9);
      for (const s of [-1, 1]) {
        const slab = box(W + 1.2, 0.22, D / 2 + 1.1, roofMat);
        slab.position.set(0, roofY + 0.7, s * (D / 4 + 0.25));
        slab.rotation.x = s * 0.5;
        shack.add(slab);
        tag(slab, 'roof');
        // Ridges along the slope give it texture.
        for (let i = 0; i < 6; i++) {
          const ridge = box(W + 1.2, 0.08, 0.12, roofMat);
          ridge.position.set(0, 0.13, -1.25 + i * 0.55);
          slab.add(ridge);
        }
      }
      const cap = cyl(0.16, 0.16, W + 1.3, mat('#8a5e3c', 0.9), 8);
      cap.rotation.z = Math.PI / 2;
      cap.position.set(0, roofY + 1.35, 0);
      shack.add(cap);
      // Gable ends: close the triangles under the roof at both sides.
      const gable = new THREE.Shape();
      gable.moveTo(-D / 2 - 0.05, 0);
      gable.lineTo(D / 2 + 0.05, 0);
      gable.lineTo(0, 1.32);
      gable.closePath();
      for (const sx of [-1, 1]) {
        const tri = new THREE.Mesh(new THREE.ExtrudeGeometry(gable, { depth: T, bevelEnabled: false }), wallMat);
        tri.rotation.y = Math.PI / 2;
        tri.position.set(sx * (W / 2) - T / 2, roofY + 0.07, 0);
        shack.add(tri);
        const vent = new THREE.Mesh(new THREE.CircleGeometry(0.22, 18), mat('#2f3a56', 0.6));
        vent.rotation.y = sx * Math.PI / 2;
        vent.position.set(sx * (W / 2 + 0.08), roofY + 0.55, 0);
        shack.add(vent);
      }
    } else {
      for (let i = 0; i < 6; i++) {
        const stick = cyl(0.05, 0.05, D + 0.6, mat('#7d6a55', 1), 6);
        stick.rotation.x = Math.PI / 2;
        stick.position.set(-W / 2 + 0.5 + i * 1.2, roofY + 0.05, 0);
        shack.add(stick);
      }
      for (const [x, z, r] of [[-2.2, -0.8, 0.2], [1.8, 0.6, -0.25], [0.2, -1.6, 0.1]]) {
        const patch = box(1.6, 0.12, 1.4, mat('#a89064', 1));
        patch.position.set(x, roofY + 0.18, z);
        patch.rotation.y = r;
        shack.add(patch);
      }
    }

    // Café sign over the door.
    if (has('sign')) {
      const color = pick('sign', '#ff9a8b');
      const sign = new THREE.Mesh(
        new THREE.BoxGeometry(3.4, 0.85, 0.12),
        [mat(color), mat(color), mat(color), mat(color), new THREE.MeshStandardMaterial({ map: signTexture('ONIGIRI CAFÉ', color), roughness: 0.7 }), mat(color)],
      );
      sign.position.set(0, roofY + 0.55, D / 2 + 0.35);
      shack.add(tag(sign, 'sign'));
    }

    // Paper lanterns along the front, glowing warm at night.
    if (has('lanterns')) {
      const light = new THREE.PointLight('#ffb35c', 0, 12, 1.6);
      light.position.set(0, roofY - 0.3, D / 2 + 1.4);
      shack.add(light);
      for (let i = 0; i < 4; i++) {
        const m = new THREE.MeshStandardMaterial({ color: '#ff5a4e', roughness: 0.7, emissive: new THREE.Color('#ff9a4a'), emissiveIntensity: 0 });
        const lantern = ball(0.28, m, 14);
        lantern.scale.y = 1.25;
        lantern.position.set(-3 + i * 2, roofY - 0.35, D / 2 + 1.25);
        const capTop = cyl(0.12, 0.12, 0.1, mat('#2b2230', 0.6), 8);
        capTop.position.y = 0.38;
        lantern.add(capTop);
        shack.add(lantern);
        this.glow(m, 1.6, i === 0 ? light : undefined);
        const phase = i;
        this.anim.add(this.swing(lantern, phase));
      }
    }

    add(shack, cx, cz, 0);
  }

  /** A gentle wind swing for hanging things; removed with the café. */
  private swing(o: THREE.Object3D, phase: number): (dt: number, t: number) => void {
    const fn = (_dt: number, t: number) => {
      if (!o.parent) {
        this.anim.delete(fn);
        return;
      }
      o.rotation.z = Math.sin(t * 2 + phase) * 0.12 * this.world.windUniforms.uWind.value;
    };
    return fn;
  }

  private buildBeachMess(
    has: (id: string) => boolean,
    add: (o: THREE.Object3D, x: number, z: number, y?: number) => THREE.Object3D,
  ): void {
    if (!has('trash')) {
      const spots: [number, number][] = [[-6, 3], [-7.5, 2.2], [-4.6, 4.1], [-8.4, 4.4], [2.5, 3.5], [9, -1], [-1, 5]];
      spots.forEach(([x, z], i) => {
        const g = new THREE.Group();
        if (i % 3 === 0) {
          const bottle = cyl(0.08, 0.1, 0.42, mat(i % 2 ? '#3f8f4f' : '#8a5a2b', 0.2), 10);
          bottle.rotation.z = Math.PI / 2;
          bottle.position.y = 0.09;
          g.add(bottle);
        } else if (i % 3 === 1) {
          const can = cyl(0.08, 0.08, 0.22, mat('#c9ccd3', 0.3, 0.8), 10);
          can.rotation.set(Math.PI / 2, 0, 0.6);
          can.position.y = 0.08;
          g.add(can);
        } else {
          const bag = ball(0.22, mat('#f3f3f3', 0.6), 7);
          bag.scale.set(1.2, 0.5, 0.9);
          bag.position.y = 0.1;
          g.add(bag);
        }
        g.rotation.y = i * 1.7;
        add(g, x, z);
      });
    }
    if (!has('seaweed')) {
      for (const [x, z, s] of [[6, 5, 1], [3, 6.2, 0.8], [-3, 6, 1.1], [10, 5.6, 0.7], [-9, 5.8, 0.9]] as const) {
        const pile = new THREE.Group();
        for (let k = 0; k < 5; k++) {
          const blob = ball(0.35 * s, mat(k % 2 ? '#3c5a2a' : '#5a5a2a', 0.6), 8);
          blob.scale.set(1.4, 0.3, 1);
          blob.position.set((k - 2) * 0.3 * s, 0.05, Math.sin(k) * 0.3);
          blob.rotation.y = k;
          pile.add(blob);
        }
        add(pile, x, z);
      }
    }
    if (!has('weeds')) {
      for (const [x, z] of [[-4.6, -3], [-4.2, -6], [4.6, -4], [4.3, -7.5], [-2, -3.6], [2.6, -3.4], [-5.2, -8.4], [5.4, -9]] as const) {
        const clump = new THREE.Group();
        for (let k = 0; k < 7; k++) {
          const blade = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.7, 4), mat('#6b7a3a', 0.9));
          blade.position.set(Math.cos(k * 1.3) * 0.18, 0.35, Math.sin(k * 1.3) * 0.18);
          blade.rotation.set(Math.cos(k) * 0.4, 0, Math.sin(k) * 0.4);
          clump.add(blade);
        }
        add(clump, x, z);
      }
    }
    if (!has('crates')) {
      for (const [x, z, r] of [[5, -2, 0.3], [6.2, -2.8, 1], [5.6, -1, -0.5]] as const) {
        const crate = new THREE.Group();
        for (let k = 0; k < 4; k++) {
          if (k === 2) continue;
          const side = box(0.9, 0.1, 0.9, mat('#a88b62', 1));
          side.position.y = k * 0.25;
          side.rotation.z = k === 3 ? 0.4 : 0;
          crate.add(side);
        }
        const slat = box(0.1, 0.8, 0.9, mat('#8f7550', 1));
        slat.position.set(0.4, 0.35, 0);
        slat.rotation.z = 0.2;
        crate.add(slat);
        crate.rotation.y = r;
        add(crate, x, z);
      }
    }
    if (!has('driftwood')) {
      for (const [x, z, r, l] of [[-12, 4, 0.4, 3.4], [-14.5, 2.4, -0.8, 2.6], [-10.5, 6, 1.4, 2]] as const) {
        const log = cyl(0.22, 0.26, l, mat('#b5a48c', 1), 9);
        log.rotation.set(0, r, Math.PI / 2);
        add(log, x, z, sandY(x, z) + 0.2);
      }
    }
  }

  private buildCafeFurniture(
    has: (id: string) => boolean,
    pick: (id: string, fallback: string) => string,
    add: (o: THREE.Object3D, x: number, z: number, y?: number) => THREE.Object3D,
    tag: (o: THREE.Object3D, task: string) => THREE.Object3D,
  ): void {
    if (has('deck')) {
      const deck = new THREE.Group();
      const color = pick('deck', '#c98b52');
      for (let i = 0; i < 12; i++) {
        const board = box(0.58, 0.12, 3, mat(color, 0.8));
        board.position.set(-3.3 + i * 0.6, 0.3, 0);
        deck.add(board);
      }
      for (const x of [-3.6, 3.6]) {
        for (const z of [-1.3, 1.3]) {
          const post = box(0.14, 0.95, 0.14, mat('#8a5e3c', 0.9));
          post.position.set(x, 0.75, z);
          deck.add(post);
        }
        const rail = box(0.1, 0.1, 2.8, mat('#8a5e3c', 0.9));
        rail.position.set(x, 1.15, 0);
        deck.add(rail);
      }
      add(tag(deck, 'deck'), 0, -2.75, 0);
    }
    if (has('counter')) {
      const counter = new THREE.Group();
      const color = pick('counter', '#ffd66b');
      const front = box(3.2, 1.0, 0.7, mat(color, 0.7));
      front.position.y = 0.85;
      const top = box(3.4, 0.1, 0.9, mat('#fbf7ef', 0.4));
      top.position.y = 1.4;
      counter.add(front, top);
      // A row of onigiri, nori and all.
      for (let i = 0; i < 4; i++) {
        const rice = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.26, 3), mat('#ffffff', 0.8));
        rice.rotation.set(Math.PI / 2, 0, Math.PI / 6);
        rice.position.set(-1.1 + i * 0.7, 1.58, 0);
        const nori = box(0.16, 0.1, 0.03, mat('#1f2a22', 0.6));
        nori.position.set(0, -0.06, 0.12);
        rice.add(nori);
        counter.add(rice);
      }
      add(tag(counter, 'counter'), 0, -2.0, has('deck') ? 0.36 : sandY(0, -2));
      for (const cx of [-1.2, 0, 1.2]) this.colliders.push({ x: cx, z: -2.0, r: 0.55 });
      this.spots.push({ kind: 'counter', x: 0, z: -1.9, r: 2.6, key: 'counter' });
    }
    if (has('kitchen')) {
      const k = new THREE.Group();
      const table = box(1.2, 0.9, 0.8, mat('#c98b52', 0.8));
      table.position.y = 0.45;
      const cooker = cyl(0.32, 0.36, 0.5, mat('#fbfbfb', 0.3), 18);
      cooker.position.y = 1.15;
      const lid = ball(0.32, mat('#ff9a8b', 0.4), 16);
      lid.scale.y = 0.45;
      lid.position.y = 1.4;
      k.add(table, cooker, lid);
      // Steam puffs.
      const steamMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, depthWrite: false });
      const puffs = [0, 1, 2].map(() => {
        const p = ball(0.12, steamMat, 8);
        k.add(p);
        return p;
      });
      const fn = (_dt: number, t: number) => {
        if (!k.parent) {
          this.anim.delete(fn);
          return;
        }
        puffs.forEach((p, i) => {
          const s = (t * 0.5 + i / 3) % 1;
          p.position.set(Math.sin(s * 6 + i) * 0.08, 1.55 + s * 1.1, 0);
          p.scale.setScalar(0.6 + s * 1.6);
        });
        steamMat.opacity = 0.45;
      };
      this.anim.add(fn);
      add(k, 2.7, -3.4, has('deck') ? 0.36 : undefined);
      this.colliders.push({ x: 2.7, z: -3.4, r: 0.75 });
      this.spots.push({ kind: 'kitchen', x: 2.7, z: -3.4, r: 1.9, key: 'kitchen' });
    }
    if (has('tables')) {
      const color = pick('tables', '#8fe3c0');
      for (const [x, z] of [[-6, 0.6], [-7.6, -1.8]] as const) {
        const set = new THREE.Group();
        const top = cyl(0.65, 0.65, 0.08, mat(color, 0.6), 20);
        top.position.y = 0.85;
        const leg = cyl(0.07, 0.07, 0.85, mat('#ffffff', 0.5), 8);
        leg.position.y = 0.42;
        set.add(top, leg);
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * TAU + 0.4;
          const stool = cyl(0.25, 0.25, 0.08, mat(color, 0.6), 14);
          stool.position.set(Math.cos(a) * 1.05, 0.5, Math.sin(a) * 1.05);
          const sleg = cyl(0.05, 0.05, 0.5, mat('#ffffff', 0.5), 6);
          sleg.position.set(stool.position.x, 0.25, stool.position.z);
          set.add(stool, sleg);
        }
        add(tag(set, 'tables'), x, z);
        this.colliders.push({ x, z, r: 0.75 });
        this.spots.push({ kind: 'table', x, z, r: 2.1, key: `table-${x}` });
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * TAU + 0.4;
          this.seats.push({ x: x + Math.cos(a) * 1.05, z: z + Math.sin(a) * 1.05, y: sandY(x, z) + 0.55, facing: Math.atan2(-Math.cos(a), -Math.sin(a)) });
        }
      }
    }
    if (has('parasols')) {
      const color = pick('parasols', '#ff9a8b');
      for (const [x, z, tilt] of [[5.2, 1.6, 0.12], [-6, 0.6, -0.1], [7.4, -0.8, 0.08]] as const) {
        const p = new THREE.Group();
        const pole = cyl(0.05, 0.05, 2.6, mat('#ffffff', 0.4), 8);
        pole.position.y = 1.3;
        p.add(pole);
        for (let i = 0; i < 8; i++) {
          const wedge = new THREE.Mesh(
            new THREE.ConeGeometry(1.6, 0.6, 3, 1, true, (i / 8) * TAU, TAU / 8),
            mat(i % 2 ? color : '#ffffff', 0.7, 0, 'double'),
          );
          wedge.position.y = 2.7;
          p.add(wedge);
        }
        p.rotation.z = tilt;
        add(tag(p, 'parasols'), x, z);
      }
    }
    if (has('path')) {
      for (let i = 0; i < 8; i++) {
        const z = -0.6 + i * 0.95;
        const x = Math.sin(i * 0.9) * 0.6;
        const stone = makeRock(0.38, '#cfc6b8');
        stone.scale.y = 0.25;
        stone.receiveShadow = true;
        add(stone, x, z, sandY(x, z) + 0.02);
      }
    }
  }

  private buildBeachLife(
    has: (id: string) => boolean,
    pick: (id: string, fallback: string) => string,
    add: (o: THREE.Object3D, x: number, z: number, y?: number) => THREE.Object3D,
    tag: (o: THREE.Object3D, task: string) => THREE.Object3D,
  ): void {
    if (has('flowers')) {
      const color = pick('flowers', '#ff5a6e');
      for (const s of [-1, 1]) {
        const bed = new THREE.Group();
        const soil = box(2.2, 0.3, 0.8, mat('#6b4a33', 1));
        soil.position.y = 0.15;
        bed.add(soil);
        for (let i = 0; i < 9; i++) {
          const stem = cyl(0.02, 0.02, 0.45, mat('#3f8f4f', 0.8), 5);
          stem.position.set(-0.9 + i * 0.22, 0.5, (i % 2) * 0.25 - 0.12);
          const bloom = ball(0.14, mat(i % 3 ? color : '#ffd23f', 0.6), 10);
          bloom.position.set(stem.position.x, 0.75, stem.position.z);
          bed.add(stem, bloom);
        }
        add(tag(bed, 'flowers'), s * 4.8, -3.6);
        this.spots.push({ kind: 'flowers', x: s * 4.8, z: -3.6, r: 1.7, key: `flowers-${s}` });
      }
    }
    if (has('palms')) {
      for (const [x, z, h, lean] of [[-9, -4.5, 5.2, 0.12], [8.5, -6, 5.8, -0.18], [-6.5, -10, 6.2, 0.05]] as const) {
        const palm = makePalm(h, lean, this.world.windUniforms, this.anim);
        add(palm, x, z);
        this.colliders.push({ x, z, r: 0.5 });
        this.spots.push({ kind: 'palm', x, z, r: 1.7, key: `palm-new-${x}`, label: 'Shake the palm', icon: '🥥', reward: 10 });
      }
    } else {
      // A dead palm stump where the new palms will go.
      const dead = makePalm(3.2, 0.3, this.world.windUniforms, this.anim, '#3fae5a', true);
      add(dead, -9, -4.5);
    }
    // The rowboat: upside down and cracked, or restored and painted.
    {
      const boat = new THREE.Group();
      const color = has('boat') ? pick('boat', '#3e8fb8') : '#7f7a72';
      const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 10, 0, TAU, Math.PI / 2, Math.PI / 2), mat(color, 0.7, 0, 'double'));
      hull.scale.set(0.9, 0.55, 2.2);
      boat.add(hull);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 6, 24), mat('#fbf7ef', 0.6));
      rim.scale.set(0.9, 2.2, 1);
      rim.rotation.x = Math.PI / 2;
      boat.add(rim);
      if (has('boat')) {
        const seat = box(1.5, 0.08, 0.35, mat('#c98b52', 0.8));
        seat.position.y = -0.15;
        const oar = cyl(0.04, 0.04, 2.4, mat('#c98b52', 0.8), 6);
        oar.rotation.set(0.2, 0, Math.PI / 2 - 0.3);
        oar.position.set(0.3, 0.1, 0.4);
        boat.add(seat, oar);
        boat.position.y = 0.55;
        tag(boat, 'boat');
      } else {
        boat.rotation.z = Math.PI;
        boat.rotation.y = 0.4;
        boat.position.y = 0.3;
        const crack = box(0.05, 0.02, 1.4, mat('#3a3530', 1));
        crack.position.set(0.2, -0.56, 0);
        boat.add(crack);
      }
      const holder = new THREE.Group();
      holder.add(boat);
      holder.rotation.y = 0.5;
      add(holder, 9, 5.6);
      // Solid: the dog walks around it (or hops in, once it is restored).
      const ax = Math.sin(0.5);
      const az = Math.cos(0.5);
      for (const k of [-1.15, 0, 1.15]) this.colliders.push({ x: 9 + ax * k, z: 5.6 + az * k, r: k ? 0.8 : 1.0 });
      if (has('boat')) this.spots.push({ kind: 'boat', x: 9, z: 5.6, r: 2.8, key: 'boat', at: [9, 0.38, 5.6], exit: [10.9, 4.0], facing: 0.5 });
    }
    // The pier: missing planks and leaning posts, or solid with rails.
    {
      const pier = new THREE.Group();
      const fixed = has('pier');
      for (let i = 0; i < 22; i++) {
        if (!fixed && (i % 4 === 2 || i % 7 === 5)) continue;
        const board = box(2.2, 0.12, 0.55, mat(fixed ? '#c98b52' : '#9a8f7e', 0.9));
        board.position.set(0, 0.6, i * 0.6);
        if (!fixed && i % 5 === 1) board.rotation.z = 0.15;
        pier.add(board);
      }
      for (let i = 0; i < 6; i++) {
        for (const s of [-1, 1]) {
          const post = cyl(0.12, 0.12, 2.6, mat(fixed ? '#8a5e3c' : '#7a7266', 0.9), 8);
          post.position.set(s * 1.05, -0.4, i * 2.4);
          if (!fixed && (i + s) % 3 === 0) post.rotation.z = s * 0.25;
          pier.add(post);
          if (fixed) {
            const rail = box(0.08, 0.08, 2.4, mat('#8a5e3c', 0.9));
            rail.position.set(s * 1.05, 1.1, i * 2.4 + 1.2);
            pier.add(rail);
          }
        }
      }
      if (fixed) {
        // A ramp up from the sand, so the dog can walk out along it.
        const run = PIER.z0 - PIER.rampZ;
        const rise = PIER.deck - sandY(13, PIER.rampZ);
        const ramp = box(2.2, 0.1, Math.hypot(run, rise), mat('#c98b52', 0.9));
        ramp.rotation.x = -Math.atan2(rise, run);
        ramp.position.set(0, (PIER.deck + sandY(13, PIER.rampZ)) / 2 - 0.06, -run / 2);
        pier.add(ramp);
        this.spots.push({ kind: 'pier', x: 13, z: 18.4, r: 1.8, key: 'pier', at: [13, PIER.deck, 18.6], exit: [13, 17.6], facing: 0, bob: [13.2, -0.25, 22.5] });
      }
      add(pier, 13, 6.5, 0);
    }
    if (has('loungers')) {
      const color = pick('loungers', '#ffd66b');
      for (const [x, z] of [[8.2, 2.2], [10.4, 1.4]] as const) {
        const l = new THREE.Group();
        const bed = box(0.8, 0.1, 2, mat('#fbf7ef', 0.6));
        bed.position.y = 0.4;
        const back = box(0.8, 0.1, 0.9, mat('#fbf7ef', 0.6));
        back.position.set(0, 0.7, -1.05);
        back.rotation.x = -0.9;
        const towel = box(0.7, 0.04, 1.8, mat(color, 0.9));
        towel.position.y = 0.47;
        for (const [lx, lz] of [[-0.35, -0.85], [0.35, -0.85], [-0.35, 0.85], [0.35, 0.85]]) {
          const leg = cyl(0.03, 0.03, 0.4, mat('#ffffff', 0.4), 6);
          leg.position.set(lx, 0.2, lz);
          l.add(leg);
        }
        l.add(bed, back, towel);
        l.rotation.y = Math.PI + 0.25;
        add(tag(l, 'loungers'), x, z);
        this.colliders.push({ x, z: z - 0.5, r: 0.6 }, { x, z: z + 0.5, r: 0.6 });
        this.spots.push({ kind: 'lounger', x, z, r: 1.8, key: `lounger-${x}`, at: [x, sandY(x, z) + 0.55, z], exit: [x - 1.3, z], facing: Math.PI + 0.25 });
      }
    }
    if (has('tower')) {
      const t = new THREE.Group();
      for (const [x, z] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) {
        const leg = cyl(0.08, 0.1, 2.4, mat('#fbf7ef', 0.6), 8);
        leg.position.set(x, 1.2, z);
        t.add(leg);
      }
      const deck = box(1.8, 0.15, 1.8, mat('#c98b52', 0.8));
      deck.position.y = 2.4;
      const hut = box(1.5, 1.1, 1.5, mat('#ff6b6b', 0.6));
      hut.position.y = 3.0;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.3, 0.7, 4), mat('#fbf7ef', 0.6));
      roof.position.y = 3.9;
      roof.rotation.y = Math.PI / 4;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.09, 8, 16), mat('#ff6b6b', 0.5));
      ring.position.set(0, 3.0, 0.77);
      t.add(deck, hut, roof, ring);
      add(t, -10.5, 6.4);
      this.colliders.push({ x: -10.5, z: 6.4, r: 1.05 });
      this.spots.push({ kind: 'tower', x: -10.5, z: 6.4, r: 2.3, key: 'tower', at: [-10.5, sandY(-10.5, 6.4) + 2.48, 6.6], exit: [-10.5, 4.6], facing: 0 });
    }
    if (has('bonfire')) {
      const f = new THREE.Group();
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * TAU;
        const stone = makeRock(0.22, '#8d8a86');
        stone.position.set(Math.cos(a) * 0.75, 0.08, Math.sin(a) * 0.75);
        f.add(stone);
      }
      for (let i = 0; i < 3; i++) {
        const log = cyl(0.09, 0.09, 1.0, mat('#7a5233', 1), 7);
        log.rotation.set(Math.PI / 2, (i / 3) * Math.PI, 0.3);
        log.position.y = 0.15;
        f.add(log);
      }
      const light = new THREE.PointLight('#ff8a3c', 0, 14, 1.5);
      light.position.y = 1;
      f.add(light);
      for (let i = 0; i < 3; i++) {
        const m = new THREE.MeshStandardMaterial({ color: i === 2 ? '#ffe27a' : '#ff8a3c', emissive: new THREE.Color(i === 2 ? '#ffd23f' : '#ff6a1c'), emissiveIntensity: 1.2, transparent: true, opacity: 0.9 });
        const flame = new THREE.Mesh(new THREE.ConeGeometry(0.35 - i * 0.08, 0.9 - i * 0.15, 8), m);
        flame.position.y = 0.5;
        f.add(flame);
        this.flames.push(flame);
        this.glow(m, 1.4, i === 0 ? light : undefined, 1.0, true);
      }
      add(f, -7, 6);
      this.colliders.push({ x: -7, z: 6, r: 0.95 });
      this.spots.push({ kind: 'bonfire', x: -7, z: 6, r: 2.3, key: 'bonfire' });
    }
    if (has('hammock')) {
      // A fabric hammock that sags under its own weight, with spreader bars,
      // ropes and two A-frame posts. Stripes in the chosen colour.
      const color = new THREE.Color(pick('hammock', '#ff9a8b'));
      const white = new THREE.Color('#fbf7ef');
      const h = new THREE.Group();
      const L = 2.6;
      const Wd = 0.95;
      const hang = 1.25;
      const sag = 0.5;
      const geo = new THREE.PlaneGeometry(L, Wd, 24, 6);
      geo.rotateX(-Math.PI / 2);
      const p = geo.attributes.position as THREE.BufferAttribute;
      const cols: number[] = [];
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        const z = p.getZ(i);
        const u = x / (L / 2);
        // Catenary-ish sag along, and a gentle cradle across.
        p.setY(i, hang - sag * (1 - u * u) + (z / (Wd / 2)) ** 2 * 0.14 * (1 - u * u));
        const stripe = Math.floor((z + Wd / 2) / (Wd / 6)) % 2 === 0;
        const c = stripe ? color : white;
        cols.push(c.r, c.g, c.b);
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      geo.computeVertexNormals();
      const bed = new THREE.Group();
      const cloth = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide }));
      bed.add(cloth);
      const wood = mat('#8a5e3c', 0.85);
      for (const sx of [-1, 1]) {
        const bar = cyl(0.04, 0.04, Wd + 0.1, wood, 6);
        bar.rotation.x = Math.PI / 2;
        bar.position.set(sx * (L / 2), hang, 0);
        bed.add(bar);
        // Ropes fan from the bar to a ring on the post.
        const ring = new THREE.Vector3(sx * (L / 2 + 0.6), hang + 0.35, 0);
        for (const rz of [-Wd / 2, 0, Wd / 2]) {
          const from = new THREE.Vector3(sx * (L / 2), hang, rz);
          const len = from.distanceTo(ring);
          const rope = cyl(0.012, 0.012, len, mat('#efe3c4', 0.9), 4);
          rope.position.copy(from).lerp(ring, 0.5);
          rope.lookAt(ring);
          rope.rotateX(Math.PI / 2);
          bed.add(rope);
        }
        // An A-frame post at each end.
        for (const lz of [-0.35, 0.35]) {
          const leg = cyl(0.07, 0.09, 1.9, wood, 8);
          leg.position.set(sx * (L / 2 + 0.75), 0.9, lz);
          leg.rotation.x = lz > 0 ? -0.2 : 0.2;
          leg.rotation.z = sx * 0.12;
          h.add(leg);
        }
      }
      h.add(bed);
      h.rotation.y = 0.2;
      add(tag(h, 'hammock'), -12, -4.4);
      this.colliders.push({ x: -12 - 2.05 * Math.cos(0.2), z: -4.4 + 2.05 * Math.sin(0.2), r: 0.5 });
      this.colliders.push({ x: -12 + 2.05 * Math.cos(0.2), z: -4.4 - 2.05 * Math.sin(0.2), r: 0.5 });
      this.spots.push({ kind: 'hammock', x: -12, z: -3.2, r: 2.0, key: 'hammock', at: [-12, sandY(-12, -4.4) + 0.85, -4.4], exit: [-12, -2.8], facing: 0.2 + Math.PI / 2 });
      const sway = (_dt: number, t: number) => {
        if (!bed.parent) {
          this.anim.delete(sway);
          return;
        }
        bed.rotation.x = Math.sin(t * 1.2) * 0.06 * (0.4 + this.world.windUniforms.uWind.value);
      };
      this.anim.add(sway);
    }
    if (has('lights')) {
      const bulbs = new THREE.MeshStandardMaterial({ color: '#fff3c4', emissive: new THREE.Color('#ffd36b'), emissiveIntensity: 0, roughness: 0.3 });
      const line = new THREE.LineBasicMaterial({ color: '#3a3530' });
      const runs: [THREE.Vector3, THREE.Vector3][] = [
        [new THREE.Vector3(-3.6, 3.1, -4.1), new THREE.Vector3(-7.6, 2.4, 0.6)],
        [new THREE.Vector3(3.6, 3.1, -4.1), new THREE.Vector3(7.6, 2.4, -0.8)],
        [new THREE.Vector3(-3.6, 3.1, -4.1), new THREE.Vector3(3.6, 3.1, -4.1)],
      ];
      const lights = new THREE.Group();
      for (const [a, b] of runs) {
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= 12; i++) {
          const t = i / 12;
          const p = a.clone().lerp(b, t);
          p.y -= Math.sin(t * Math.PI) * 0.5;
          pts.push(p);
          if (i % 2 === 1) {
            const bulb = ball(0.08, bulbs, 8);
            bulb.position.copy(p).add(new THREE.Vector3(0, -0.1, 0));
            lights.add(bulb);
          }
        }
        lights.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), line));
      }
      this.glow(bulbs, 2.4);
      for (const [x, z] of [[-7.6, 0.6], [7.6, -0.8]] as const) {
        const pole = cyl(0.05, 0.05, 2.5, mat('#8a5e3c', 0.9), 6);
        pole.position.set(x, sandY(x, z) + 1.25, z);
        lights.add(pole);
      }
      add(lights, 0, 0, 0);
    }
    if (has('opening')) {
      // Bunting across the front, and a red ribbon cut in half.
      const bunting = new THREE.Group();
      const colors = ['#ff6b6b', '#ffd23f', '#5fdbab', '#74c8ff', '#b18cff'];
      for (let i = 0; i < 14; i++) {
        const t = i / 13;
        const flag = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.35, 3), mat(colors[i % colors.length], 0.7, 0, 'double'));
        flag.rotation.x = Math.PI;
        flag.position.set(-3.6 + t * 7.2, 3.35 - Math.sin(t * Math.PI) * 0.35, -1.4);
        bunting.add(flag);
      }
      add(bunting, 0, 0, 0);
    }
  }

  private buildDecor(id: string, add: (o: THREE.Object3D, x: number, z: number, y?: number) => THREE.Object3D): void {
    const d = DECOR.find((x) => x.id === id)!;
    const g = new THREE.Group();
    const gold = mat('#ffcf4a', 0.25, 0.85);
    switch (id) {
      case 'golden-shell': {
        for (let i = 0; i < 7; i++) {
          const rib = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.9, 6), gold);
          rib.position.y = 0.45;
          rib.rotation.z = (i - 3) * 0.28;
          g.add(rib);
        }
        const plinth = cyl(0.45, 0.5, 0.3, mat('#fbf7ef', 0.5), 16);
        plinth.position.y = -0.1;
        g.add(plinth);
        g.position.y = 0.2;
        break;
      }
      case 'treasure-chest': {
        const body = box(1.2, 0.7, 0.8, mat('#9a5f35', 0.8));
        body.position.y = 0.35;
        const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 1.2, 12, 1, false, 0, Math.PI), mat('#9a5f35', 0.8));
        lid.rotation.z = Math.PI / 2;
        lid.position.y = 0.7;
        const band = box(1.25, 0.1, 0.85, gold);
        band.position.y = 0.55;
        const coins = ball(0.35, gold, 10);
        coins.scale.y = 0.4;
        coins.position.y = 0.75;
        g.add(body, lid, band, coins);
        break;
      }
      case 'ship-wheel': {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.07, 8, 24), mat('#8a5e3c', 0.7));
        ring.position.y = 1.2;
        g.add(ring);
        for (let i = 0; i < 8; i++) {
          const spoke = cyl(0.04, 0.04, 1.8, mat('#c98b52', 0.7), 6);
          spoke.rotation.z = (i / 8) * Math.PI;
          spoke.position.y = 1.2;
          g.add(spoke);
        }
        const post = cyl(0.08, 0.1, 1.2, mat('#8a5e3c', 0.8), 8);
        post.position.y = 0.6;
        g.add(post);
        break;
      }
      case 'giant-pearl': {
        const shell = new THREE.Mesh(new THREE.SphereGeometry(0.7, 18, 8, 0, TAU, Math.PI / 2, Math.PI / 2), mat('#ffd0dc', 0.5, 0, 'double'));
        shell.position.y = 0.55;
        const pearl = ball(0.38, mat('#fbf7ff', 0.08, 0.3), 24);
        pearl.position.y = 0.55;
        g.add(shell, pearl);
        break;
      }
      case 'starfish': {
        const shape = new THREE.Shape();
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * TAU - Math.PI / 2;
          const r = i % 2 ? 0.28 : 0.75;
          if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
          else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        const star = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.22, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06 }), mat('#ff9f5a', 0.6));
        star.position.y = 1.1;
        const stand = cyl(0.08, 0.12, 0.7, mat('#fbf7ef', 0.5), 8);
        stand.position.y = 0.35;
        g.add(star, stand);
        break;
      }
      case 'anchor': {
        const shaft = cyl(0.09, 0.09, 1.8, mat('#5c6470', 0.5, 0.6), 8);
        shaft.position.y = 0.9;
        shaft.rotation.z = 0.3;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.09, 8, 16, Math.PI), mat('#5c6470', 0.5, 0.6));
        ring.rotation.z = Math.PI + 0.3;
        ring.position.set(-0.2, 0.25, 0);
        g.add(shaft, ring);
        break;
      }
      case 'coral-arch': {
        const arch = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.22, 10, 24, Math.PI), mat('#ff7fa8', 0.6));
        g.add(arch);
        for (let i = 0; i < 6; i++) {
          const branch = cyl(0.05, 0.09, 0.6, mat('#ff9fbe', 0.6), 6);
          const a = (i / 5) * Math.PI;
          branch.position.set(Math.cos(a) * 1.4, Math.sin(a) * 1.4 + 0.2, 0);
          branch.rotation.z = a - Math.PI / 2;
          g.add(branch);
        }
        break;
      }
      case 'flag': {
        const pole = cyl(0.06, 0.06, 4, mat('#8a5e3c', 0.8), 8);
        pole.position.y = 2;
        const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.9, 8, 1), mat('#2b2230', 0.9, 0, 'double'));
        cloth.position.set(0.72, 3.5, 0);
        g.add(pole, cloth);
        const fn = (_dt: number, t: number) => {
          if (!g.parent) {
            this.anim.delete(fn);
            return;
          }
          const p = cloth.geometry.attributes.position as THREE.BufferAttribute;
          for (let i = 0; i < p.count; i++) {
            const x = p.getX(i);
            p.setZ(i, Math.sin(x * 4 - t * 6) * 0.12 * (x + 0.7) * this.world.windUniforms.uWind.value);
          }
          p.needsUpdate = true;
        };
        this.anim.add(fn);
        break;
      }
    }
    add(g, d.spot[0], d.spot[1]);
  }

  /* ---------------------------------------------------------------- *
   * Per frame
   * ---------------------------------------------------------------- */

  private animate(dt: number, t: number): void {
    const night = this.world.night;
    for (const g of this.glows) {
      const f = g.flicker ? 0.85 + Math.sin(t * 17) * 0.1 + Math.sin(t * 31) * 0.05 : 1;
      const level = (g.always + night * g.power) * f;
      g.m.emissiveIntensity = level;
      if (g.light) g.light.intensity = level * 6;
    }
    // Fires always burn; they just matter more after dark.
    this.flames.forEach((f, i) => {
      f.scale.set(1 + Math.sin(t * 9 + i) * 0.12, 1 + Math.sin(t * 13 + i * 2) * 0.2, 1 + Math.cos(t * 8 + i) * 0.12);
      f.rotation.y += dt * (1 + i);
    });
    // Fireworks over the sea on the nights after the grand opening.
    if (this.opened && night > 0.6 && t > this.fireworksAt) {
      this.fireworksAt = t + 1.2 + Math.random() * 1.8;
      this.firework();
    }
  }

  private firework(): void {
    const colors = ['#ff6b6b', '#ffd23f', '#5fdbab', '#74c8ff', '#b18cff', '#ff9ae0'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const at = new THREE.Vector3((Math.random() - 0.5) * 40, 16 + Math.random() * 8, 24 + Math.random() * 20);
    const m = new THREE.PointsMaterial({ color, size: 0.6, transparent: true, depthWrite: false, fog: false });
    const n = 70;
    const geo = new THREE.BufferGeometry();
    const p = new Float32Array(n * 3);
    const v: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      p.set([at.x, at.y, at.z], i * 3);
      const u = Math.random() * TAU;
      const w = Math.acos(Math.random() * 2 - 1);
      v.push(new THREE.Vector3(Math.sin(w) * Math.cos(u), Math.cos(w), Math.sin(w) * Math.sin(u)).multiplyScalar(6 + Math.random() * 2));
    }
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const pts = new THREE.Points(geo, m);
    this.root.add(pts);
    let life = 1.6;
    const fn = (dt: number) => {
      life -= dt;
      for (let i = 0; i < n; i++) {
        v[i].y -= 4 * dt;
        v[i].multiplyScalar(1 - dt * 0.9);
        p[i * 3] += v[i].x * dt;
        p[i * 3 + 1] += v[i].y * dt;
        p[i * 3 + 2] += v[i].z * dt;
      }
      geo.attributes.position.needsUpdate = true;
      m.opacity = Math.max(0, life / 1.6);
      if (life <= 0) {
        this.root.remove(pts);
        geo.dispose();
        m.dispose();
        this.anim.delete(fn);
      }
    };
    this.anim.add(fn);
  }
}
