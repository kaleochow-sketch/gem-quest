/**
 * A region's 3D place, built from its theme (themes.ts). The yard follows the
 * same layout as the café beach (building at the back, porch and counter in
 * front, tables to the left, shade to the right, tower and fire pit by the
 * front edge) so every job list lines up; the look comes from the theme:
 * ground, backdrop, water, trees, weather, and the building kit (planks,
 * logs, plaster, stone, brick, ice, glass or crystal; gable, steep, flat,
 * dome or cone roofs; square or round).
 */
import * as THREE from 'three';
import type { PlaceData, PlaceState } from '../game/places.js';
import { World, TAU } from './engine.js';
import { ball, box, cyl, makeGrass, makePalm, makeRock, mat, shadowed } from './models.js';
import { model, modelNames, recolor, shadows } from './assets.js';
import { prop, signProp, useMaterial } from './props.js';
import type { Ferry, Seat, Site, Spot } from './site.js';
import type { HouseStyle, MessKind, Theme } from './themes.js';

interface Glow {
  m: THREE.MeshStandardMaterial;
  light?: THREE.PointLight;
  power: number;
  always: number;
  flicker: boolean;
}

const HOUSE = { x: 0, z: -6.65, W: 7, D: 5, H: 2.6 };
const POND = { x: 14, z: 6, r: 5.2 };
const JETTY = { x0: 8.4, x1: 12.2, z0: 4.5, z1: 5.5, y: 0.24 };
const YARD_TREES: [number, number, number][] = [
  [-16, -6, 6.2],
  [-13.5, -1.8, 5.4],
  [16, -5, 6.4],
  [-19, 2, 5.6],
  [10, -11, 6],
  [-8, -12, 5.6],
  [19.5, -1.5, 5.2],
];

function signTexture(text: string, bg: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, 512, 128);
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = 10;
  g.strokeRect(8, 8, 496, 112);
  g.font = '900 64px ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(40,40,60,0.55)';
  g.strokeText(text, 256, 68);
  g.fillStyle = '#ffffff';
  g.fillText(text, 256, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class RegionSite implements Site {
  readonly root = new THREE.Group();
  readonly anim = new Set<(dt: number, t: number) => void>();
  readonly walkables: THREE.Object3D[] = [];
  readonly prints: [string, string];
  readonly content = new THREE.Group();
  readonly paintable = new Map<string, THREE.Object3D>();
  spots: Spot[] = [];
  seats: Seat[] = [];
  colliders: { x: number; z: number; r: number }[] = [];
  readonly queue: [number, number][] = [[0, -0.55], [0.15, 0.6], [-0.15, 1.75]];
  readonly workerAt: [number, number, number] = [0, 0.36, -2.85];
  readonly start: [number, number] = [0, 3];
  private deck = false;
  private glows: Glow[] = [];
  /** Glows that belong to the scenery (city windows) and survive rebuilds. */
  private envGlows: Glow[] = [];
  private flames: THREE.Mesh[] = [];
  private opened = false;
  private fireworksAt = 0;
  private flash: THREE.PointLight | null = null;

  constructor(private world: World, private theme: Theme, private data: PlaceData) {
    this.prints = theme.prints;
    this.environment();
    this.root.add(this.content);
    this.anim.add((dt, t) => this.animate(dt, t));
  }

  private get round(): boolean {
    return this.theme.house.round;
  }

  /* ---------------------------------------------------------------- *
   * Ground
   * ---------------------------------------------------------------- */

  /** Terrain height: a flat yard, shaped by the backdrop beyond it. */
  terrain(x: number, z: number): number {
    const b = this.theme.backdrop;
    let y = Math.sin(x * 0.7 + z * 0.3) * 0.035 + Math.sin(x * 0.23 - z * 0.41) * 0.05;
    const out = Math.max(0, Math.abs(x) - 23) + Math.max(0, -14 - z) + Math.max(0, z - 11);
    if (b === 'hills') y += out * 0.28 + Math.sin(x * 0.15) * Math.min(1, out / 4) * 1.2;
    else if (b === 'mountains') y += out * 0.4;
    else if (b === 'dunes') y += out * 0.3 + Math.sin(x * 0.21) * Math.sin(z * 0.17) * 1.4 * Math.min(1, out / 3);
    else if (b === 'mesas') y += out * 0.12;
    else if (b === 'quarry') y += out * 0.75;
    else if (b === 'lagoon') {
      if (z > 6) y -= (z - 6) * 0.13;
      y += Math.max(0, Math.abs(x) - 23) * 0.15;
    } else if (b === 'sky') {
      const r = Math.hypot(x, (z + 2) * 1.2);
      if (r > 31) y -= (r - 31) * 2.5;
    }
    const w = this.theme.water;
    if (w === 'pond' || w === 'lagoon') {
      const d = Math.hypot(x - POND.x, z - POND.z);
      if (d < POND.r) y -= 0.9 * (1 - (d / POND.r) ** 2);
    }
    return y;
  }

  groundAt(x: number, z: number): number {
    if (this.onJetty(x, z)) return JETTY.y;
    if (this.deck && x > -3.8 && x < 3.8 && z > -4.3 && z < -1.2) return 0.36;
    if (this.theme.water === 'ice' && Math.hypot(x - POND.x, z - POND.z) < POND.r) return 0.02;
    return this.terrain(x, z);
  }

  private onJetty(x: number, z: number): boolean {
    const w = this.theme.water;
    return (w === 'pond' || w === 'lagoon') && x > JETTY.x0 && x < JETTY.x1 && z > JETTY.z0 && z < JETTY.z1;
  }

  clamp(p: THREE.Vector3): void {
    p.x = THREE.MathUtils.clamp(p.x, -22, 22);
    p.z = THREE.MathUtils.clamp(p.z, -12, 9);
    // The building.
    if (this.round) {
      const R = this.theme.house.tall ? 2.9 : 3.5;
      const dx = p.x - HOUSE.x;
      const dz = p.z - HOUSE.z;
      const d = Math.hypot(dx, dz);
      if (d < R && d > 0.001) {
        p.x = HOUSE.x + (dx / d) * R;
        p.z = HOUSE.z + (dz / d) * R;
      }
    } else {
      const x0 = -3.6;
      const x1 = 3.6;
      const z0 = -9.2;
      const z1 = -4.1;
      if (p.x > x0 && p.x < x1 && p.z > z0 && p.z < z1) {
        const out = [p.x - x0, x1 - p.x, p.z - z0, z1 - p.z];
        const m = Math.min(...out);
        if (m === out[0]) p.x = x0;
        else if (m === out[1]) p.x = x1;
        else if (m === out[2]) p.z = z0;
        else p.z = z1;
      }
    }
    // Water: stay on the bank unless walking out along the jetty.
    const w = this.theme.water;
    if ((w === 'pond' || w === 'lagoon') && !this.onJetty(p.x, p.z)) {
      const dx = p.x - POND.x;
      const dz = p.z - POND.z;
      const d = Math.hypot(dx, dz);
      const r = POND.r - 0.4;
      if (d < r && d > 0.001) {
        p.x = POND.x + (dx / d) * r;
        p.z = POND.z + (dz / d) * r;
      }
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
    p.y = this.groundAt(p.x, p.z);
  }

  walkRoutes(): [number, number][][] {
    return [
      [[-23, 3.4], [-3.4, 3.0]],
      // Round the pond, not through it, and past the tree.
      [[23, 0.6], [17, 0.2], [9, -0.5], [4.2, 3.2]],
      // In from behind the building.
      [[23, -12], [7, -1], [4.2, 3.2]],
    ];
  }

  ferry(): Ferry | null {
    if (this.theme.water === 'lagoon') {
      // Rowing in from the sea to the end of the jetty.
      return {
        kind: 'boat',
        from: [18, -0.3, 45],
        dock: [13.1, -0.3, 4.2],
        land: [JETTY.x1 - 0.3, JETTY.y, 5],
        walk: [[8.7, 5], [4.2, 3.2]],
      };
    }
    if (this.theme.backdrop === 'sky') {
      // Drifting down by hot-air balloon to a meadow by the tower.
      const y = this.terrain(-16.5, 6.5);
      return {
        kind: 'balloon',
        from: [-42, 26, 16],
        dock: [-16.5, y, 6.5],
        land: [-15.1, this.terrain(-15.1, 5.4), 5.4],
        walk: [[-12.8, 3.6], [-3.4, 3.0]],
      };
    }
    return null;
  }

  /* ---------------------------------------------------------------- *
   * The environment, built once
   * ---------------------------------------------------------------- */

  private environment(): void {
    const th = this.theme;
    const root = this.root;
    const w = this.world;

    const geo = new THREE.PlaneGeometry(190, 110, 130, 76);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -12);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const cols: number[] = [];
    const dry = new THREE.Color(th.ground.dry);
    const damp = new THREE.Color(th.ground.damp);
    const far = new THREE.Color(th.ground.far);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = this.terrain(x, z);
      pos.setY(i, y);
      const c = dry.clone();
      const edge = Math.max(0, Math.abs(x) - 22) + Math.max(0, -14 - z);
      c.lerp(far, Math.min(1, edge / 10));
      if (y < -0.15) c.lerp(damp, Math.min(1, -y * 2));
      c.offsetHSL(0, 0, (Math.sin(x * 3.1) * Math.sin(z * 2.7) + Math.sin(x * 9.3 + z * 7.1) * 0.5) * 0.02);
      cols.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: th.backdrop === 'ice' || th.region === 2 ? 0.75 : 1 }));
    ground.receiveShadow = true;
    root.add(ground);
    this.walkables.push(ground);

    this.water();
    this.backdrop();

    // Trees around the yard. They sway, and each can be gathered from daily.
    YARD_TREES.forEach(([x, z, h], i) => {
      if (this.theme.water && Math.hypot(x - POND.x, z - POND.z) < POND.r + 1.5) return;
      const tree = this.makeTree(th.trees, h, i);
      tree.position.set(x, this.terrain(x, z), z);
      root.add(tree);
      this.envColliders.push({ x, z, r: 0.6 });
      this.envSpots.push({ kind: 'gather', x, z, r: 1.8, key: `tree-${i}`, label: th.gather.label, icon: th.gather.icon, reward: th.gather.reward });
    });

    if (th.grass) {
      const grass = makeGrass(
        2200,
        () => {
          const x = (Math.random() - 0.5) * 90;
          const z = -40 + Math.random() * 52;
          // Keep the paths and yard centre clear-ish.
          if (Math.abs(x) < 9 && z > -10 && z < 6) return null;
          if (this.theme.water && Math.hypot(x - POND.x, z - POND.z) < POND.r) return null;
          return [x, z];
        },
        th.grass,
        0.55,
        w.windUniforms,
      );
      grass.children.forEach((m) => {
        const mesh = m as THREE.InstancedMesh;
        const tmp = new THREE.Matrix4();
        const p = new THREE.Vector3();
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, tmp);
          p.setFromMatrixPosition(tmp);
          tmp.setPosition(p.x, this.terrain(p.x, p.z), p.z);
          mesh.setMatrixAt(i, tmp);
        }
        mesh.instanceMatrix.needsUpdate = true;
      });
      root.add(grass);
    }

    this.weather();
  }

  /** Spots and obstacles from the environment, re-added on every rebuild. */
  private envSpots: Spot[] = [];
  private envColliders: { x: number; z: number; r: number }[] = [];

  private water(): void {
    const th = this.theme;
    const w = this.world;
    if (!th.water) return;
    if (th.water === 'ice') {
      // A frozen lake with a fishing hole.
      const ice = new THREE.Mesh(new THREE.CircleGeometry(POND.r, 40), new THREE.MeshStandardMaterial({ color: th.waterColor, roughness: 0.08, metalness: 0.1 }));
      ice.rotation.x = -Math.PI / 2;
      ice.position.set(POND.x, 0.01, POND.z);
      ice.receiveShadow = true;
      this.root.add(ice);
      const hole = new THREE.Mesh(new THREE.CircleGeometry(0.55, 24), new THREE.MeshStandardMaterial({ color: '#1d4f78', roughness: 0.1 }));
      hole.rotation.x = -Math.PI / 2;
      hole.position.set(POND.x, 0.02, POND.z);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.08, 8, 24), mat('#ffffff', 0.4));
      rim.rotation.x = Math.PI / 2;
      rim.position.set(POND.x, 0.03, POND.z);
      this.root.add(hole, rim);
      this.envSpots.push({ kind: 'pier', x: POND.x - 0.9, z: POND.z, r: 1.6, key: 'fish', at: [POND.x - 0.9, 0.02, POND.z], exit: [POND.x - 2.2, POND.z], facing: Math.PI / 2, bob: [POND.x, 0.0, POND.z] });
      return;
    }
    // Rippling water in the pond (and the sea, for the lagoon).
    const make = (size: number, segs: number, at: THREE.Vector3, color: string) => {
      const g = new THREE.PlaneGeometry(size, size, segs, segs);
      g.rotateX(-Math.PI / 2);
      g.translate(at.x, at.y, at.z);
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.06, metalness: 0.03, transparent: true, opacity: 0.82 }));
      this.root.add(m);
      const p = g.attributes.position as THREE.BufferAttribute;
      const base = Float32Array.from(p.array as Float32Array);
      let tick = 0;
      this.anim.add((dt, t) => {
        tick += dt;
        if (tick < 1 / 30) return;
        tick = 0;
        const wind = w.windUniforms.uWind.value;
        for (let i = 0; i < p.count; i++) {
          const x = base[i * 3];
          const z = base[i * 3 + 2];
          p.setY(i, base[i * 3 + 1] + (Math.sin(x * 0.6 + t * 1.4) * 0.04 + Math.sin(z * 0.8 - t * 1.8) * 0.035) * (0.6 + wind));
        }
        p.needsUpdate = true;
        g.computeVertexNormals();
      });
    };
    make(POND.r * 2.2, 22, new THREE.Vector3(POND.x, -0.32, POND.z), th.waterColor);
    if (th.water === 'lagoon') make(240, 60, new THREE.Vector3(0, -0.34, 110), '#2a9fd0');
    // A little jetty out over the water.
    const jetty = new THREE.Group();
    for (let i = 0; i < 7; i++) {
      const board = box(0.5, 0.1, 1.2, mat('#b98b5c', 0.9));
      board.position.set(JETTY.x0 + 0.3 + i * 0.55, JETTY.y - 0.05, (JETTY.z0 + JETTY.z1) / 2);
      jetty.add(board);
    }
    for (const x of [JETTY.x0 + 1.4, JETTY.x1 - 0.2]) {
      for (const z of [JETTY.z0 + 0.05, JETTY.z1 - 0.05]) {
        const post = cyl(0.07, 0.07, 1.2, mat('#7a5233', 0.9), 6);
        post.position.set(x, -0.35, z);
        jetty.add(post);
      }
    }
    this.root.add(shadowed(jetty));
    this.envSpots.push({ kind: 'pier', x: JETTY.x1 - 0.4, z: 5, r: 1.6, key: 'fish', at: [JETTY.x1 - 0.4, JETTY.y, 5], exit: [JETTY.x0 + 0.2, 5], facing: Math.PI / 2, bob: [POND.x + 0.6, -0.32, POND.z - 0.3] });
  }

  private backdrop(): void {
    const th = this.theme;
    const root = this.root;
    switch (th.backdrop) {
      case 'hills': {
        for (const [x, z, s, c] of [[-60, -70, 30, '#7cc46a'], [10, -85, 40, '#6fb85e'], [70, -65, 28, '#86cf6a'], [-95, -40, 26, '#7cc46a'], [100, -30, 24, '#8fd17a']] as const) {
          const hill = ball(s, mat(c, 1), 24);
          hill.scale.y = 0.35;
          hill.position.set(x, -2, z);
          root.add(hill);
        }
        break;
      }
      case 'mountains': {
        for (const [x, z, h, r] of [[-60, -95, 55, 40], [0, -110, 70, 48], [60, -95, 50, 38], [-110, -60, 40, 34], [115, -60, 44, 34]] as const) {
          const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7), mat('#a8b8d8', 1, 0, 'flat'));
          m.position.set(x, h / 2 - 3, z);
          const cap = new THREE.Mesh(new THREE.ConeGeometry(r * 0.42, h * 0.42, 7), mat('#ffffff', 0.9, 0, 'flat'));
          cap.position.y = h * 0.29;
          m.add(cap);
          root.add(m);
        }
        break;
      }
      case 'dunes': {
        for (let i = 0; i < 9; i++) {
          const d = ball(18 + (i % 3) * 6, mat(i % 2 ? '#f0c98a' : '#e8bd78', 1), 20);
          d.scale.set(1.6, 0.28, 1);
          d.position.set(-110 + i * 28, -1.5, -55 - (i % 2) * 20);
          root.add(d);
        }
        // Pyramids on the horizon.
        for (const [x, s] of [[-40, 18], [-15, 12]] as const) {
          const p = new THREE.Mesh(new THREE.ConeGeometry(s, s * 0.9, 4), mat('#e3b878', 1, 0, 'flat'));
          p.rotation.y = Math.PI / 4;
          p.position.set(x, s * 0.45 - 1, -95);
          root.add(p);
        }
        break;
      }
      case 'lagoon': {
        for (const [x, z, s] of [[-70, 150, 16], [40, 170, 22], [110, 140, 12]] as const) {
          const isle = new THREE.Mesh(new THREE.SphereGeometry(s, 20, 10, 0, TAU, 0, Math.PI / 2), mat('#5f9a74', 1));
          isle.scale.y = 0.35;
          isle.position.set(x, -0.6, z);
          root.add(isle);
        }
        break;
      }
      case 'mesas': {
        for (const [x, z, wd, h] of [[-60, -80, 30, 22], [0, -100, 44, 30], [55, -75, 26, 18], [-100, -40, 22, 16], [100, -45, 24, 20]] as const) {
          const mesa = new THREE.Mesh(new THREE.CylinderGeometry(wd * 0.42, wd * 0.5, h, 8), mat('#c06f4f', 1, 0, 'flat'));
          mesa.position.set(x, h / 2 - 1, z);
          for (let k = 1; k < 4; k++) {
            const band = new THREE.Mesh(new THREE.CylinderGeometry(wd * 0.5 - k * 0.02 * wd, wd * 0.5 - k * 0.02 * wd, 0.6, 8), mat('#e3a07c', 1, 0, 'flat'));
            band.position.y = -h / 2 + k * (h / 4);
            mesa.add(band);
          }
          root.add(mesa);
        }
        break;
      }
      case 'quarry': {
        // Rock walls all round, with glowing crystals set in them.
        for (let i = 0; i < 26; i++) {
          const a = (i / 26) * TAU;
          const r = 34 + Math.sin(i * 1.7) * 4;
          const x = Math.cos(a) * r;
          const z = -8 + Math.sin(a) * r * 0.8;
          // Only behind and beside the yard, so the walls never block the view.
          if (z > 4) continue;
          const rock = makeRock(6 + (i % 4) * 2, i % 2 ? '#4a4360' : '#3d3752');
          rock.scale.y = 1.6;
          rock.position.set(x, 2, z);
          root.add(rock);
          if (i % 2 === 0) {
            const color = ['#7fe3ff', '#ff8fe0', '#b7a4ff'][i % 3];
            const c = new THREE.Mesh(new THREE.ConeGeometry(0.9, 3, 6), new THREE.MeshStandardMaterial({ color, emissive: new THREE.Color(color), emissiveIntensity: 0.8, roughness: 0.2 }));
            c.position.set(x * 0.9, 3, z * 0.9);
            c.rotation.z = (Math.random() - 0.5) * 0.6;
            root.add(c);
          }
        }
        break;
      }
      case 'city': {
        // A skyline of rooftops with windows that light up at night.
        const winMat = new THREE.MeshStandardMaterial({ color: '#3a3348', emissive: new THREE.Color('#ffd36b'), emissiveIntensity: 0 });
        for (let i = 0; i < 18; i++) {
          const wd = 6 + (i % 3) * 3;
          const h = 10 + ((i * 7) % 5) * 4;
          const x = -80 + i * 9.5;
          const z = -38 - (i % 3) * 8;
          const b = box(wd, h, 6, mat(['#c98a67', '#b5603d', '#a8998a', '#d9a27c'][i % 4], 0.9));
          b.position.set(x, h / 2 - 1, z);
          root.add(b);
          for (let k = 0; k < Math.floor(h / 3); k++) {
            const win = box(wd * 0.6, 0.8, 0.1, winMat);
            win.position.set(x, 1 + k * 3, z + 3.05);
            root.add(win);
          }
        }
        this.envGlows.push({ m: winMat, power: 1.4, always: 0, flicker: false });
        // Giant turning gears.
        for (const [x, y, z, r, dir] of [[-26, 10, -26, 6, 1], [-18, 6, -24, 3.5, -1.8], [28, 9, -27, 5, -1]] as const) {
          const gear = new THREE.Group();
          const n = 12;
          const body = cyl(r * 0.82, r * 0.82, 0.8, mat('#c9a04a', 0.4, 0.6), 24);
          body.rotation.x = Math.PI / 2;
          gear.add(body);
          for (let k = 0; k < n; k++) {
            const tooth = box(r * 0.25, r * 0.3, 0.8, mat('#c9a04a', 0.4, 0.6));
            const a = (k / n) * TAU;
            tooth.position.set(Math.cos(a) * r * 0.92, Math.sin(a) * r * 0.92, 0);
            tooth.rotation.z = a;
            gear.add(tooth);
          }
          gear.position.set(x, y, z);
          root.add(gear);
          this.anim.add((dt) => (gear.rotation.z += dt * 0.2 * dir));
        }
        break;
      }
      case 'ice': {
        const sea = new THREE.Mesh(new THREE.PlaneGeometry(400, 220), new THREE.MeshStandardMaterial({ color: '#cfe6f7', roughness: 0.2, metalness: 0.05 }));
        sea.rotation.x = -Math.PI / 2;
        sea.position.set(0, -0.6, 110);
        root.add(sea);
        for (let i = 0; i < 10; i++) {
          const berg = makeRock(4 + (i % 3) * 3, '#f2f8ff');
          berg.position.set(-90 + i * 20, 0, 50 + (i % 3) * 25);
          berg.scale.y = 1.4;
          root.add(berg);
        }
        break;
      }
      case 'sky': {
        // The island floats: a rocky underside, clouds below, little islands
        // drifting, and a rainbow.
        const under = new THREE.Mesh(new THREE.ConeGeometry(33, 26, 18), mat('#9a8a7a', 1, 0, 'flat'));
        under.rotation.x = Math.PI;
        under.position.set(0, -13.5, -2);
        root.add(under);
        for (let i = 0; i < 6; i++) {
          const isle = new THREE.Group();
          const top = ball(4, mat('#a8e08c', 1), 14);
          top.scale.y = 0.3;
          const rock = new THREE.Mesh(new THREE.ConeGeometry(4, 6, 10), mat('#9a8a7a', 1, 0, 'flat'));
          rock.rotation.x = Math.PI;
          rock.position.y = -3;
          isle.add(top, rock);
          const a = (i / 6) * TAU;
          isle.position.set(Math.cos(a) * 75, 6 + (i % 3) * 5, Math.sin(a) * 60 - 20);
          root.add(isle);
          const phase = i;
          this.anim.add((_dt, t) => (isle.position.y = 6 + (phase % 3) * 5 + Math.sin(t * 0.4 + phase) * 1.2));
        }
        const colors = ['#ff9aa2', '#ffc78a', '#fff19a', '#a8f0b8', '#9ed8ff', '#c7a8ff'];
        colors.forEach((c, i) => {
          const arc = new THREE.Mesh(new THREE.TorusGeometry(60 - i * 2.2, 1.1, 8, 64, Math.PI), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.55, fog: false }));
          arc.position.set(0, -5, -90);
          root.add(arc);
        });
        for (let i = 0; i < 14; i++) {
          const puff = ball(6 + (i % 3) * 2, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1 }), 12);
          puff.scale.y = 0.45;
          const a = (i / 14) * TAU;
          puff.position.set(Math.cos(a) * 52, -16, Math.sin(a) * 44 - 4);
          root.add(puff);
        }
        break;
      }
    }
  }

  /**
   * A Blender tree from nature.glb ("tree_<kind>_N", 1 unit tall), coloured
   * from the theme. Its "_crown" child sways like the simple tree's crown.
   */
  private modelTree(kind: Theme['trees'], h: number, seed: number): THREE.Group | null {
    const names = modelNames(`tree_${kind}_`);
    if (!names.length) return null;
    const name = names[Math.abs(seed) % names.length];
    const tree = model(name);
    if (!tree) return null;
    const w = this.world;
    const [c1, c2] = this.theme.treeColors;
    const trunk = kind === 'mesquite' ? '#6b5038' : kind === 'pine' ? '#6b4a33' : '#8a6044';
    if (kind === 'crystal') {
      // Glowing shards: emissive copies of the two crystal colours.
      const glow = (color: string) => new THREE.MeshStandardMaterial({ color, emissive: new THREE.Color(color), emissiveIntensity: 0.6, roughness: 0.15, metalness: 0.1 });
      const swap: Record<string, THREE.Material> = { Crystal: glow(c1), Crystal2: glow(c2) };
      tree.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || Array.isArray(mesh.material)) return;
        const m = swap[mesh.material.name.split('.')[0]];
        if (m) mesh.material = m;
      });
    } else {
      // Pines carry snow when the second colour is white; otherwise it's foliage.
      const snow = kind === 'pine' && c2.toLowerCase() !== '#ffffff' ? c1 : c2;
      recolor(tree, { Leaves: c1, Leaves2: kind === 'pine' ? c1 : c2, Snow: snow, Trunk: trunk });
    }
    // Trees are 1 unit tall; cacti and crystals stand a little lower, like the simple ones.
    const s = kind === 'cactus' ? h * 0.62 : kind === 'crystal' ? h * 0.72 : h;
    tree.scale.setScalar(s);
    tree.rotation.y = seed * 2.39;
    const g = new THREE.Group();
    g.add(tree);
    shadows(g);
    const crown = tree.getObjectByName(`${name}_crown`);
    if (crown) {
      const phase = seed * 1.7;
      this.anim.add((_dt, t) => {
        const wind = w.windUniforms.uWind.value;
        crown.rotation.z = Math.sin(t * 1.3 + phase) * 0.035 * wind;
        crown.rotation.x = Math.sin(t * 0.9 + phase * 1.3) * 0.025 * wind;
      });
    }
    return g;
  }

  private makeTree(kind: Theme['trees'], h: number, seed: number): THREE.Group {
    const w = this.world;
    const [c1, c2] = this.theme.treeColors;
    if (kind === 'palm') return makePalm(h, ((seed % 3) - 1) * 0.2, w.windUniforms, this.anim, c1);
    const fromModel = this.modelTree(kind, h, seed);
    if (fromModel) return fromModel;
    const g = new THREE.Group();
    const crown = new THREE.Group();
    const phase = seed * 1.7;
    if (kind === 'pine') {
      const trunk = cyl(0.16, 0.24, h * 0.3, mat('#6b4a33', 0.95), 8);
      trunk.position.y = h * 0.15;
      g.add(trunk);
      for (let i = 0; i < 4; i++) {
        const r = h * (0.28 - i * 0.05);
        const tier = new THREE.Mesh(new THREE.ConeGeometry(r, h * 0.32, 9), mat(c1, 0.9));
        tier.position.y = h * (0.35 + i * 0.17);
        crown.add(tier);
        if (c2 === '#ffffff') {
          const snow = new THREE.Mesh(new THREE.ConeGeometry(r * 0.75, h * 0.12, 9), mat('#ffffff', 0.8));
          snow.position.y = h * (0.44 + i * 0.17);
          crown.add(snow);
        }
      }
    } else if (kind === 'cactus') {
      const body = cyl(0.3, 0.35, h * 0.6, mat(c1, 0.8), 10);
      body.position.y = h * 0.3;
      g.add(body);
    } else if (kind === 'crystal') {
      for (let i = 0; i < 5; i++) {
        const color = i % 2 ? c1 : c2;
        const shard = new THREE.Mesh(
          new THREE.ConeGeometry(0.35 + (i % 3) * 0.15, h * (0.35 + (i % 3) * 0.12), 6),
          new THREE.MeshStandardMaterial({ color, emissive: new THREE.Color(color), emissiveIntensity: 0.6, roughness: 0.15, metalness: 0.1 }),
        );
        shard.position.set(Math.cos(i * 1.3) * 0.5, h * 0.2, Math.sin(i * 1.3) * 0.5);
        shard.rotation.set(Math.cos(i) * 0.35, 0, Math.sin(i * 2) * 0.35);
        crown.add(shard);
      }
    } else {
      // round, street, mesquite, pastel: a trunk and a puffy canopy.
      const trunkColor = kind === 'mesquite' ? '#6b5038' : '#8a6044';
      const trunk = cyl(0.18, 0.26, h * 0.5, mat(trunkColor, 0.95), 8);
      trunk.position.y = h * 0.25;
      if (kind === 'mesquite') trunk.rotation.z = 0.18;
      g.add(trunk);
      const puffs: [number, number, number, number][] =
        kind === 'mesquite'
          ? [[0, 0.62, 0, 1.6], [0.9, 0.58, 0.3, 1.1], [-0.8, 0.6, -0.2, 1.2]]
          : [[0, 0.7, 0, 1.25], [0.75, 0.6, 0.3, 0.9], [-0.7, 0.62, -0.3, 0.95], [0.2, 0.86, -0.4, 0.85]];
      puffs.forEach(([x, y, z, r], i) => {
        const p = ball(r * (h / 5.5), mat(i % 2 ? c2 : c1, 0.85), 14);
        if (kind === 'mesquite') p.scale.y = 0.55;
        p.position.set(x * (h / 5.5), y * h, z * (h / 5.5));
        crown.add(p);
      });
      if (kind === 'street') {
        const grate = cyl(0.8, 0.8, 0.06, mat('#3a3348', 0.5, 0.6), 16);
        grate.position.y = 0.03;
        g.add(grate);
      }
    }
    g.add(crown);
    shadowed(g);
    this.anim.add((_dt, t) => {
      const wind = w.windUniforms.uWind.value;
      crown.rotation.z = Math.sin(t * 1.3 + phase) * 0.035 * wind;
      crown.rotation.x = Math.sin(t * 0.9 + phase * 1.3) * 0.025 * wind;
    });
    return g;
  }

  /* --- weather ------------------------------------------------------------ */

  private weather(): void {
    const kind = this.theme.weather;
    const w = this.world;
    if (kind === 'aurora') {
      const bands: [string, number][] = [['#78ffc8', 0], ['#aa8cff', 1.6], ['#6edcff', 3.1]];
      for (const [color, phase] of bands) {
        const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
        const g = new THREE.PlaneGeometry(260, 22, 60, 1);
        const mesh = new THREE.Mesh(g, m);
        mesh.position.set(0, 60, -120 + phase * 8);
        mesh.rotation.x = 0.25;
        this.root.add(mesh);
        const p = g.attributes.position as THREE.BufferAttribute;
        const base = Float32Array.from(p.array as Float32Array);
        this.anim.add((_dt, t) => {
          m.opacity = w.night * 0.35;
          if (!w.night) return;
          for (let i = 0; i < p.count; i++) {
            const x = base[i * 3];
            p.setZ(i, Math.sin(x * 0.04 + t * 0.4 + phase) * 10 + Math.sin(x * 0.11 - t * 0.6) * 3);
          }
          p.needsUpdate = true;
        });
      }
    }
    // Falling or drifting particles.
    const n = kind === 'snow' || kind === 'aurora' ? 700 : kind === 'storm' ? 900 : 260;
    const geo = new THREE.BufferGeometry();
    const p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) p.set([(Math.random() - 0.5) * 70, Math.random() * 22, -26 + Math.random() * 40], i * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const color: Record<string, string> = { petals: '#ffc0d8', snow: '#ffffff', aurora: '#ffffff', dust: '#f6dcaa', bubbles: '#e8fbff', storm: '#cfe0ff', embers: '#ffb36b', steam: '#ffffff', sparkles: '#fff6b0' };
    const size: Record<string, number> = { petals: 0.22, snow: 0.16, aurora: 0.14, dust: 0.1, bubbles: 0.2, storm: 0.09, embers: 0.12, steam: 0.5, sparkles: 0.18 };
    const m = new THREE.PointsMaterial({ color: color[kind], size: size[kind], transparent: true, opacity: 0.85, depthWrite: false });
    const pts = new THREE.Points(geo, m);
    pts.frustumCulled = false;
    this.root.add(pts);
    if (kind === 'storm') {
      this.flash = new THREE.PointLight('#e8f0ff', 0, 200, 1);
      this.flash.position.set(10, 40, -20);
      this.root.add(this.flash);
    }
    let storm = 0;
    this.anim.add((dt, t) => {
      const wind = w.windUniforms.uWind.value;
      // Storms come and go.
      const raining = kind !== 'storm' || Math.sin(t * 0.05) > -0.2;
      m.opacity = kind === 'storm' ? (raining ? 0.7 : 0) : kind === 'sparkles' ? 0.5 + Math.sin(t * 3) * 0.4 : 0.85;
      for (let i = 0; i < n; i++) {
        let x = p[i * 3];
        let y = p[i * 3 + 1];
        let z = p[i * 3 + 2];
        switch (kind) {
          case 'snow':
          case 'aurora':
            y -= dt * (1.2 + (i % 5) * 0.2);
            x += Math.sin(t + i) * dt * 0.5 + wind * dt * 0.6;
            break;
          case 'petals':
            y -= dt * 0.7;
            x += dt * (0.8 + wind);
            z += Math.sin(t * 2 + i) * dt * 0.5;
            break;
          case 'dust':
            x += dt * (3 + wind * 5);
            y = Math.min(y, 3) + Math.sin(t * 2 + i) * dt;
            break;
          case 'bubbles':
          case 'embers':
          case 'steam':
            y += dt * (kind === 'steam' ? 0.8 : 1.1);
            x += Math.sin(t + i) * dt * 0.4;
            break;
          case 'storm':
            y -= dt * 22;
            x += dt * 4 * wind;
            break;
          case 'sparkles':
            y += Math.sin(t + i) * dt * 0.3;
            break;
        }
        if (y < 0 || y > 22) y = y < 0 ? 22 : 0;
        if (x > 35) x = -35;
        if (x < -35) x = 35;
        p[i * 3] = x;
        p[i * 3 + 1] = y;
        p[i * 3 + 2] = z;
      }
      geo.attributes.position.needsUpdate = true;
      if (this.flash) {
        storm -= dt;
        if (raining && storm <= 0 && Math.random() < dt * 0.25) storm = 0.25;
        this.flash.intensity = storm > 0 ? 4000 * storm : 0;
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * The place, rebuilt from the save
   * ---------------------------------------------------------------- */

  build(state: PlaceState, preview?: { task: string; swatch: string }): void {
    this.content.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) mesh.geometry.dispose();
    });
    for (const g of this.glows) if (g.light) g.light.dispose();
    this.content.clear();
    this.glows = [];
    this.flames = [];
    this.paintable.clear();
    this.spots = [...this.envSpots];
    this.colliders = [...this.envColliders];
    this.seats = [];

    const has = (id: string) => state.done.includes(id);
    const pick = (id: string, fallback: string): string => {
      if (preview && preview.task === id) return preview.swatch;
      return this.data.choice(state, id)?.color ?? fallback;
    };
    const add = (o: THREE.Object3D, x: number, z: number, y?: number) => {
      o.position.set(x, y ?? this.terrain(x, z), z);
      shadowed(o);
      this.content.add(o);
      return o;
    };
    const tag = (o: THREE.Object3D, task: string) => {
      o.userData.paintTask = task;
      this.paintable.set(task, o);
      return o;
    };
    this.deck = has('deck');
    this.opened = has('opening');

    this.buildHouse(has, pick, tag, preview);
    this.buildMess(has, add);
    this.buildShop(has, pick, add, tag);
    this.buildLife(has, pick, add, tag);
  }

  /* --- the building kit ---------------------------------------------------- */

  private wallMaterial(style: HouseStyle, fixed: boolean, color: string): THREE.MeshStandardMaterial {
    if (!fixed) return mat(style.wall === 'ice' ? '#b8c8d8' : style.wall === 'glass' ? '#8a9a9a' : style.wall === 'crystal' ? '#a8a0b8' : '#8a857c', 1);
    if (style.wall === 'glass') {
      const m = new THREE.MeshStandardMaterial({ color, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.55 });
      return m;
    }
    if (style.wall === 'ice') return mat(color, 0.25, 0.05);
    if (style.wall === 'crystal') {
      const m = new THREE.MeshStandardMaterial({ color, roughness: 0.12, metalness: 0.15, emissive: new THREE.Color(color), emissiveIntensity: 0.15, flatShading: true });
      return m;
    }
    return mat(color, style.wall === 'plaster' ? 0.95 : 0.85);
  }

  private buildHouse(
    has: (id: string) => boolean,
    pick: (id: string, fallback: string) => string,
    tag: (o: THREE.Object3D, task: string) => THREE.Object3D,
    preview?: { task: string; swatch: string },
  ): void {
    const style = this.theme.house;
    const fixed = has('walls');
    const color = has('paint') || preview?.task === 'paint' ? pick('paint', style.base) : style.base;
    const wallMat = this.wallMaterial(style, fixed, color);
    const trim = mat(fixed ? style.trim : '#6f6a62', 0.9);
    const house = new THREE.Group();
    house.position.set(HOUSE.x, 0, HOUSE.z);
    this.content.add(house);

    // Floor: dusty until swept.
    const floorColor = has('floor') ? '#c9a070' : '#8f7a5c';
    const floor = this.round
      ? cyl(this.theme.house.tall ? 2.6 : 3.2, this.theme.house.tall ? 2.6 : 3.2, 0.3, mat(floorColor, 0.9), 32)
      : box(HOUSE.W, 0.3, HOUSE.D, mat(floorColor, 0.9));
    floor.position.y = 0.15;
    house.add(floor);
    if (!has('floor')) {
      for (const [x, z, r] of [[-1.5, 1, 0.5], [1.2, 1.2, 0.4], [1.6, -0.8, 0.35]]) {
        const pile = ball(r, mat(this.theme.ground.dry, 1), 10);
        pile.scale.y = 0.3;
        pile.position.set(x, 0.32, z);
        house.add(pile);
      }
    }

    if (this.round) this.roundHouse(house, style, fixed, wallMat, trim, has, pick, tag);
    else this.squareHouse(house, style, fixed, wallMat, trim, has, pick, tag);
    shadowed(house);

    // Door: hanging off its hinge, or new and painted.
    const front = this.round ? (style.tall ? 2.6 : 3.2) : HOUSE.D / 2;
    const doorModel = has('door') ? prop('bld_door', { Paint: pick('door', '#7cc6f2'), Trim: fixed ? style.trim : '#b8b2a6' }) : prop('bld_door_old');
    if (doorModel && has('door')) {
      doorModel.position.set(0, 0.3, front + 0.04);
      house.add(shadowed(tag(doorModel, 'door')));
    } else if (doorModel) {
      // Hanging off its hinge: the model's origin is its base, so pivot about its middle.
      const pivot = new THREE.Group();
      pivot.position.set(-0.6, 1.15, front + 0.4);
      pivot.rotation.set(0.12, 0.9, 0.18);
      doorModel.position.y = -0.95;
      pivot.add(doorModel);
      house.add(shadowed(pivot));
    } else if (has('door')) {
      const door = box(1.3, 2.0, 0.12, mat(pick('door', '#7cc6f2'), 0.6));
      door.position.set(0, 1.3, front + 0.04);
      const knob = ball(0.07, mat('#e8c15a', 0.3, 0.8), 8);
      knob.position.set(0.45, 0, 0.08);
      door.add(knob);
      house.add(shadowed(tag(door, 'door')));
    } else {
      const door = box(1.2, 1.9, 0.08, mat('#857e73', 1));
      door.position.set(-0.6, 1.15, front + 0.4);
      door.rotation.set(0.12, 0.9, 0.18);
      house.add(shadowed(door));
    }

    // Sign over the door.
    const signModel = has('sign') ? signProp(pick('sign', '#ff9a8b'), signTexture(this.theme.sign, pick('sign', '#ff9a8b'))) : null;
    if (signModel) {
      signModel.position.set(0, (style.tall ? 3.1 : 2.95) - 0.45, front + 0.3);
      house.add(shadowed(tag(signModel, 'sign')));
    } else if (has('sign')) {
      const c = pick('sign', '#ff9a8b');
      const sign = new THREE.Mesh(
        new THREE.BoxGeometry(3.2, 0.8, 0.12),
        [mat(c), mat(c), mat(c), mat(c), new THREE.MeshStandardMaterial({ map: signTexture(this.theme.sign, c), roughness: 0.7 }), mat(c)],
      );
      sign.position.set(0, style.tall ? 3.1 : 2.95, front + 0.3);
      house.add(shadowed(tag(sign, 'sign')));
    }

    // Lanterns along the front, glowing at night.
    if (has('lanterns')) {
      const light = new THREE.PointLight(this.theme.lamp, 0, 12, 1.6);
      light.position.set(0, 2.4, front + 1.4);
      house.add(light);
      for (let i = 0; i < 4; i++) {
        const m = new THREE.MeshStandardMaterial({ color: this.theme.lamp, roughness: 0.6, emissive: new THREE.Color(this.theme.lamp), emissiveIntensity: 0 });
        const post = prop('prop_lamp_post');
        if (post) {
          // The lantern hangs 0.4 out in front of the post.
          post.position.set(-3 + i * 2, 0, front + 0.8);
          house.add(shadowed(useMaterial(post, 'Lamp', m)));
          this.glows.push({ m, power: 1.6, always: 0, flicker: false, light: i === 0 ? light : undefined });
          continue;
        }
        const lantern = ball(0.26, m, 14);
        lantern.scale.y = 1.25;
        lantern.position.set(-3 + i * 2, 2.45, front + 1.2);
        const capTop = cyl(0.11, 0.11, 0.1, mat('#2b2230', 0.6), 8);
        capTop.position.y = 0.36;
        lantern.add(capTop);
        const pole = cyl(0.04, 0.04, 2.3, mat('#6b4a33', 0.8), 6);
        pole.position.set(-3 + i * 2, 1.15, front + 1.2);
        house.add(lantern, pole);
        this.glows.push({ m, power: 1.6, always: 0, flicker: false, light: i === 0 ? light : undefined });
      }
    }

  }

  private squareHouse(
    house: THREE.Group,
    style: HouseStyle,
    fixed: boolean,
    wallMat: THREE.MeshStandardMaterial,
    trim: THREE.MeshStandardMaterial,
    has: (id: string) => boolean,
    pick: (id: string, fallback: string) => string,
    tag: (o: THREE.Object3D, task: string) => THREE.Object3D,
  ): void {
    const { W, D, H } = HOUSE;
    const T = 0.16;
    const top = 0.3 + H;
    const walls = new THREE.Group();
    const panel = (along: 'x' | 'z', ox: number, oz: number, u0: number, u1: number, y0: number, y1: number) => {
      const len = u1 - u0;
      const b = box(along === 'x' ? len : T, y1 - y0, along === 'z' ? len : T, wallMat);
      const mid = (u0 + u1) / 2;
      b.position.set(along === 'x' ? ox + mid : ox, (y0 + y1) / 2, along === 'z' ? oz + mid : oz);
      walls.add(b);
    };
    panel('x', 0, -D / 2, -W / 2, W / 2, 0.3, top);
    panel('z', -W / 2, 0, -D / 2, D / 2, 0.3, top);
    panel('z', W / 2, 0, -D / 2, D / 2, 0.3, top);
    for (const s of [-1, 1]) {
      panel('x', 0, D / 2, s > 0 ? 2.85 : -W / 2, s > 0 ? W / 2 : -2.85, 0.3, top);
      panel('x', 0, D / 2, s > 0 ? 0.8 : -1.35, s > 0 ? 1.35 : -0.8, 0.3, top);
      panel('x', 0, D / 2, s > 0 ? 1.35 : -2.85, s > 0 ? 2.85 : -1.35, 0.3, 1.4);
      panel('x', 0, D / 2, s > 0 ? 1.35 : -2.85, s > 0 ? 2.85 : -1.35, 2.4, top);
    }
    panel('x', 0, D / 2, -0.8, 0.8, 2.4, top);

    // Surface detail by wall kind, on the outside faces.
    const faces: { along: 'x' | 'z'; ox: number; oz: number; len: number; out: number; front?: boolean }[] = [
      { along: 'x', ox: 0, oz: -D / 2, len: W, out: -1 },
      { along: 'z', ox: -W / 2, oz: 0, len: D, out: -1 },
      { along: 'z', ox: W / 2, oz: 0, len: D, out: 1 },
      { along: 'x', ox: 0, oz: D / 2, len: W, out: 1, front: true },
    ];
    const opening = (u: number, y: number) => Math.abs(u) < 0.8 && y < 2.4 ? true : Math.abs(Math.abs(u) - 2.1) < 0.75 && y > 1.4 && y < 2.4;
    const detail = mat(style.wall === 'logs' ? '#7a5233' : style.wall === 'brick' ? '#e8d8c8' : style.wall === 'stone' ? '#ffffff' : style.trim, 0.9);
    for (const f of faces) {
      const off = (T / 2 + 0.03) * f.out;
      const place = (m: THREE.Mesh, u: number, y: number) => {
        m.position.set(f.along === 'x' ? f.ox + u : f.ox + off, y, f.along === 'z' ? f.oz + u : f.oz + off);
        walls.add(m);
      };
      if (style.wall === 'planks') {
        const n = Math.round(f.len / 0.46);
        for (let i = 0; i < n; i++) {
          const u = -f.len / 2 + (i + 1) * (f.len / n) - 0.02;
          if (f.front && opening(u, 1.2)) continue;
          if (!fixed && i % 4 === 2) continue;
          place(box(f.along === 'x' ? 0.07 : 0.05, H, f.along === 'z' ? 0.07 : 0.05, fixed ? trim : mat('#7d776d', 1)), u, 0.3 + H / 2);
        }
      } else if (style.wall === 'logs') {
        for (let k = 0; k < 9; k++) {
          const y = 0.45 + k * 0.29;
          if (f.front) {
            for (const [u0, u1] of [[-W / 2, -2.85], [-1.35, -0.8], [0.8, 1.35], [2.85, W / 2]]) {
              const len = u1 - u0;
              const log = cyl(0.15, 0.15, len, fixed ? wallMat : mat('#7d776d', 1), 8);
              log.rotation[f.along === 'x' ? 'z' : 'x'] = Math.PI / 2;
              place(log, (u0 + u1) / 2, y);
            }
            continue;
          }
          if (!fixed && k % 3 === 1) continue;
          const log = cyl(0.15, 0.15, f.len + 0.3, fixed ? wallMat : mat('#7d776d', 1), 8);
          log.rotation[f.along === 'x' ? 'z' : 'x'] = Math.PI / 2;
          place(log, 0, y);
        }
      } else if (style.wall === 'brick') {
        for (let k = 1; k < 10; k++) {
          const y = 0.3 + k * 0.26;
          if (f.front && y > 1.4 && y < 2.4) continue;
          place(box(f.along === 'x' ? f.len : 0.02, 0.03, f.along === 'z' ? f.len : 0.02, detail), 0, y);
        }
      } else if (style.wall === 'stone') {
        const rnd = (i: number) => Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
        for (let i = 0; i < 26; i++) {
          const u = (rnd(i + f.len) - 0.5) * (f.len - 0.4);
          const y = 0.5 + rnd(i * 3.1 + f.ox) * (H - 0.4);
          if (f.front && opening(u, y)) continue;
          const st = box(f.along === 'x' ? 0.5 : 0.06, 0.32, f.along === 'z' ? 0.5 : 0.06, mat(fixed ? '#d8cfc4' : '#8a857c', 0.95));
          place(st, u, y);
        }
      }
      // Cracks and grime on a run-down building.
      if (!fixed) {
        for (let i = 0; i < 3; i++) {
          const crack = box(f.along === 'x' ? 0.06 : 0.03, 1.2, f.along === 'z' ? 0.06 : 0.03, mat('#3a3530', 1));
          crack.rotation[f.along === 'x' ? 'z' : 'x'] = 0.5 - i * 0.4;
          const u = -f.len / 3 + i * (f.len / 3);
          if (f.front && opening(u, 1.6)) continue;
          place(crack, u, 1.6);
        }
      }
    }
    for (const [x, z] of [[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2]]) {
      const post = box(0.26, H + 0.3, 0.26, trim);
      post.position.set(x, 0.3 + (H + 0.3) / 2, z);
      walls.add(post);
    }
    house.add(walls);
    if (fixed) tag(walls, 'paint');

    // Windows.
    for (const s of [-1, 1]) {
      const wx = s * 2.1;
      const winModel = prop(has('windows') ? 'bld_window' : 'bld_window_old');
      if (winModel && has('windows')) {
        const glassMat = new THREE.MeshStandardMaterial({ color: '#bfe6ff', roughness: 0.05, metalness: 0.1, emissive: new THREE.Color('#ffc76b'), emissiveIntensity: 0 });
        winModel.position.set(wx, 1.3, D / 2);
        house.add(useMaterial(winModel, 'Glass', glassMat));
        this.glows.push({ m: glassMat, power: 0.9, always: 0, flicker: false });
        const shutters = prop('bld_shutters', { Paint: has('door') ? pick('door', style.trim) : style.trim });
        if (shutters) {
          shutters.position.set(wx, 1.3, D / 2);
          house.add(shutters);
        }
        if (this.theme.plants === 'flowers' || this.theme.place === 'toyshop') {
          const fb = prop('bld_flowerbox', { Paint: pick('flowers', '#ff5a6e') });
          if (fb) {
            fb.position.set(wx, 0.92, D / 2 + 0.3);
            house.add(fb);
          }
        }
      } else if (winModel) {
        winModel.position.set(wx, 1.3, D / 2);
        house.add(winModel);
      } else if (has('windows')) {
        const frame = box(1.5, 1.2, 0.18, mat('#fbf7ef', 0.6));
        frame.position.set(wx, 1.9, D / 2);
        const glassMat = new THREE.MeshStandardMaterial({ color: '#bfe6ff', roughness: 0.05, metalness: 0.1, emissive: new THREE.Color('#ffc76b'), emissiveIntensity: 0 });
        const glass = box(1.3, 1.0, 0.2, glassMat);
        glass.position.set(wx, 1.9, D / 2);
        const bar = box(0.06, 1.0, 0.22, mat('#fbf7ef', 0.6));
        bar.position.set(wx, 1.9, D / 2);
        house.add(frame, glass, bar);
        this.glows.push({ m: glassMat, power: 0.9, always: 0, flicker: false });
        if (this.theme.plants === 'flowers' || this.theme.place === 'toyshop') {
          const boxMesh = box(1.4, 0.25, 0.3, mat('#8a5e3c', 0.8));
          boxMesh.position.set(wx, 1.25, D / 2 + 0.25);
          house.add(boxMesh);
          for (let i = 0; i < 5; i++) {
            const bloom = ball(0.1, mat(pick('flowers', '#ff5a6e'), 0.6), 8);
            bloom.position.set(wx - 0.5 + i * 0.25, 1.45, D / 2 + 0.28);
            house.add(bloom);
          }
        }
      } else {
        const hole = box(1.3, 1.0, 0.05, mat('#2b2622', 1));
        hole.position.set(wx, 1.9, D / 2 - 0.05);
        house.add(hole);
        for (const r of [0.6, -0.6]) {
          const board = box(1.6, 0.16, 0.06, mat('#8a8378', 1));
          board.position.set(wx, 1.9, D / 2 + 0.1);
          board.rotation.z = r;
          house.add(board);
        }
      }
    }

    // Roof.
    const roofColor = pick('roof', this.data.tasks.find((t) => t.id === 'roof')?.swatches?.[0].color ?? '#d9b26a');
    if (style.roof === 'flat') {
      if (has('roof')) {
        const slab = box(W + 0.6, 0.3, D + 0.6, mat(roofColor, 0.85));
        slab.position.y = top + 0.15;
        house.add(tag(slab, 'roof'));
        // A rounded parapet, adobe-style.
        for (const [w, d, x, z] of [[W + 0.6, 0.3, 0, D / 2 + 0.15], [W + 0.6, 0.3, 0, -D / 2 - 0.15], [0.3, D + 0.6, W / 2 + 0.15, 0], [0.3, D + 0.6, -W / 2 - 0.15, 0]]) {
          const lip = box(w, 0.4, d, mat(roofColor, 0.85));
          lip.position.set(x, top + 0.45, z);
          house.add(lip);
        }
      } else {
        for (const [x, z] of [[-2, -1], [1.5, 1], [2, -1.5]]) {
          const patch = box(2, 0.15, 1.6, mat('#7d776d', 1));
          patch.position.set(x, top + 0.08, z);
          house.add(patch);
        }
      }
    } else {
      const steep = style.roof === 'steep';
      const pitch = steep ? 0.75 : 0.5;
      const rise = steep ? 2.1 : 1.32;
      if (has('roof')) {
        const roofMat = mat(roofColor, 0.85);
        for (const s of [-1, 1]) {
          const half = D / 2 + 1.0;
          const slab = box(W + 1.0, 0.22, half / Math.cos(pitch) * 0.9, roofMat);
          slab.position.set(0, top + rise / 2 + 0.05, s * (D / 4 + 0.2));
          slab.rotation.x = s * pitch;
          house.add(tag(slab, 'roof'));
          if (style.snow) {
            const snow = box(W + 1.05, 0.16, half / Math.cos(pitch) * 0.85, mat('#ffffff', 0.8));
            snow.position.copy(slab.position).add(new THREE.Vector3(0, 0.16, 0));
            snow.rotation.x = slab.rotation.x;
            house.add(snow);
          }
        }
        const gable = new THREE.Shape();
        gable.moveTo(-D / 2 - 0.05, 0);
        gable.lineTo(D / 2 + 0.05, 0);
        gable.lineTo(0, rise);
        gable.closePath();
        for (const sx of [-1, 1]) {
          const tri = new THREE.Mesh(new THREE.ExtrudeGeometry(gable, { depth: T, bevelEnabled: false }), wallMat);
          tri.rotation.y = Math.PI / 2;
          tri.position.set(sx * (W / 2) - T / 2, top, 0);
          house.add(tri);
        }
        const ridge = cyl(0.14, 0.14, W + 1.1, trim, 8);
        ridge.rotation.z = Math.PI / 2;
        ridge.position.set(0, top + rise + 0.05, 0);
        house.add(ridge);
      } else {
        for (let i = 0; i < 6; i++) {
          const stick = cyl(0.05, 0.05, D + 0.6, mat('#7d6a55', 1), 6);
          stick.rotation.x = Math.PI / 2;
          stick.position.set(-W / 2 + 0.5 + i * 1.2, top + 0.05, 0);
          house.add(stick);
        }
        for (const [x, z, r] of [[-2.2, -0.8, 0.2], [1.8, 0.6, -0.25]]) {
          const patch = box(1.6, 0.12, 1.4, mat('#8a7a64', 1));
          patch.position.set(x, top + 0.18, z);
          patch.rotation.y = r;
          house.add(patch);
        }
      }
    }
    this.extras(house, style, has, top);
  }

  private roundHouse(
    house: THREE.Group,
    style: HouseStyle,
    fixed: boolean,
    wallMat: THREE.MeshStandardMaterial,
    trim: THREE.MeshStandardMaterial,
    has: (id: string) => boolean,
    pick: (id: string, fallback: string) => string,
    tag: (o: THREE.Object3D, task: string) => THREE.Object3D,
  ): void {
    const R = style.tall ? 2.6 : 3.2;
    const H = style.tall ? 6 : style.roof === 'dome' ? 1.6 : 2.6;
    const top = 0.3 + H;
    const segs = style.wall === 'crystal' ? 10 : 32;
    // The wall, with a gap for the door at the front.
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(R, R, H, segs, 1, true, Math.PI / 2 + 0.24, TAU - 0.48), wallMat);
    wall.material.side = THREE.DoubleSide;
    wall.position.y = 0.3 + H / 2;
    house.add(wall);
    if (fixed) tag(wall, 'paint');
    // Door frame.
    const lintel = box(1.5, 0.3, 0.3, trim);
    lintel.position.set(0, 2.45, R);
    const jambL = box(0.2, 2.2, 0.3, trim);
    jambL.position.set(-0.72, 1.3, R - 0.05);
    const jambR = jambL.clone();
    jambR.position.x = 0.72;
    house.add(lintel, jambL, jambR);
    // Detail rings: ice blocks, stone courses, glass ribs.
    const rings = style.wall === 'ice' ? 4 : style.wall === 'stone' ? Math.floor(H / 0.5) : 0;
    for (let k = 1; k <= rings; k++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(R + 0.02, 0.035, 6, 48), mat(style.wall === 'ice' ? '#bcd8f0' : '#a89888', 0.6));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.3 + (k * H) / (rings + 1);
      house.add(ring);
    }
    if (style.wall === 'glass' || style.wall === 'crystal') {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * TAU;
        if (Math.abs(Math.sin(a / 2 - Math.PI / 4)) < 0.15) continue;
        const rib = box(0.08, H, 0.08, trim);
        rib.position.set(Math.sin(a) * R, 0.3 + H / 2, Math.cos(a) * R);
        house.add(rib);
      }
    }
    if (!fixed) {
      for (let i = 0; i < 4; i++) {
        const a = Math.PI * 0.6 + i * 0.9;
        const crack = box(0.05, H * 0.6, 0.05, mat('#3a3530', 1));
        crack.position.set(Math.sin(a) * (R + 0.03), 0.3 + H / 2, Math.cos(a) * (R + 0.03));
        crack.rotation.z = 0.4;
        house.add(crack);
      }
    }
    // Round windows either side of the door (two storeys on the tower).
    const levels = style.tall ? [1.9, 4.4] : [1.5];
    for (const y of levels) {
      for (const s of [-1, 1]) {
        const a = s * 0.75;
        const wx = Math.sin(a) * (R + 0.02);
        const wz = Math.cos(a) * (R + 0.02);
        const win = new THREE.Group();
        const roundModel = prop(has('windows') ? 'bld_window_round' : 'bld_window_round_old');
        if (roundModel) {
          roundModel.position.y = -0.55;
          if (has('windows')) {
            const glassMat = new THREE.MeshStandardMaterial({ color: '#bfe6ff', roughness: 0.05, metalness: 0.1, emissive: new THREE.Color('#ffc76b'), emissiveIntensity: 0 });
            useMaterial(roundModel, 'Glass', glassMat);
            this.glows.push({ m: glassMat, power: 0.9, always: 0, flicker: false });
          }
          win.add(roundModel);
        } else if (has('windows')) {
          const glassMat = new THREE.MeshStandardMaterial({ color: '#bfe6ff', roughness: 0.05, metalness: 0.1, emissive: new THREE.Color('#ffc76b'), emissiveIntensity: 0 });
          const glass = new THREE.Mesh(new THREE.CircleGeometry(0.45, 20), glassMat);
          const frame = new THREE.Mesh(new THREE.TorusGeometry(0.47, 0.07, 8, 24), mat('#fbf7ef', 0.5));
          win.add(glass, frame);
          this.glows.push({ m: glassMat, power: 0.9, always: 0, flicker: false });
        } else {
          const hole = new THREE.Mesh(new THREE.CircleGeometry(0.45, 16), mat('#2b2622', 1));
          const board = box(1.0, 0.14, 0.05, mat('#8a8378', 1));
          board.rotation.z = 0.5;
          board.position.z = 0.03;
          win.add(hole, board);
        }
        win.position.set(wx, y, wz);
        win.lookAt(wx * 2, y, wz * 2);
        house.add(win);
      }
    }
    // Igloo tunnel.
    if (style.wall === 'ice') {
      const tunnel = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 1.4, 16, 1, true, -Math.PI / 2, Math.PI), mat(fixed ? '#e8f4ff' : '#b8c8d8', 0.3));
      tunnel.material.side = THREE.DoubleSide;
      tunnel.rotation.x = Math.PI / 2;
      tunnel.rotation.y = Math.PI / 2;
      tunnel.position.set(0, 0.3, R + 0.4);
      house.add(tunnel);
    }

    // Roof: dome, cone or flat with a parapet.
    const roofColor = pick('roof', this.data.tasks.find((t) => t.id === 'roof')?.swatches?.[0].color ?? '#d9b26a');
    const roofMat =
      style.wall === 'glass'
        ? new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
        : style.wall === 'crystal'
          ? new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.15, emissive: new THREE.Color(roofColor), emissiveIntensity: 0.2, flatShading: true })
          : mat(roofColor, style.wall === 'ice' ? 0.25 : 0.85);
    const broken = !has('roof');
    if (style.roof === 'dome') {
      const pieces = broken ? 3 : 4;
      for (let i = 0; i < pieces; i++) {
        const q = new THREE.Mesh(new THREE.SphereGeometry(R, 24, 12, (i * Math.PI) / 2, Math.PI / 2, 0, Math.PI / 2), broken ? mat('#8a857c', 1) : roofMat);
        q.position.y = top;
        house.add(broken ? q : tag(q, 'roof'));
      }
      if (style.wall === 'glass' && !broken) {
        for (let k = 0; k < 8; k++) {
          const rib = new THREE.Mesh(new THREE.TorusGeometry(R, 0.05, 6, 24, Math.PI), trim);
          rib.rotation.y = (k / 8) * Math.PI;
          rib.position.y = top;
          house.add(rib);
        }
      }
      if (style.snow && !broken) {
        const cap = new THREE.Mesh(new THREE.SphereGeometry(R * 0.6, 18, 8, 0, TAU, 0, Math.PI / 4), mat('#ffffff', 0.8));
        cap.position.y = top + R * 0.26;
        house.add(cap);
      }
    } else if (style.roof === 'cone') {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(R + 0.5, broken ? 1.4 : 3.2, segs), broken ? mat('#8a857c', 1) : roofMat);
      cone.position.y = top + (broken ? 0.7 : 1.6);
      house.add(broken ? cone : tag(cone, 'roof'));
      if (!broken) {
        const tip = new THREE.Mesh(new THREE.OctahedronGeometry(0.35), new THREE.MeshStandardMaterial({ color: '#fff3a8', emissive: new THREE.Color('#ffd23f'), emissiveIntensity: 0.8 }));
        tip.position.y = top + 3.45;
        house.add(tip);
        this.anim.add((dt) => (tip.rotation.y += dt));
      }
    } else {
      const lidMat = broken ? mat('#7d776d', 1) : mat(roofColor, 0.8);
      const lid = cyl(R + 0.2, R + 0.2, 0.3, lidMat, segs);
      lid.position.y = top + 0.15;
      if (broken) lid.scale.set(0.7, 1, 0.7);
      house.add(broken ? lid : tag(lid, 'roof'));
      if (!broken) {
        const parapet = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.2, R + 0.2, 0.5, segs, 1, true), lidMat);
        parapet.material.side = THREE.DoubleSide;
        parapet.position.y = top + 0.5;
        house.add(parapet);
      }
    }
    this.extras(house, style, has, top + (style.roof === 'flat' ? 0.3 : 0));
  }

  /** Chimney smoke, a clock face, or a turning radar dish. */
  private extras(house: THREE.Group, style: HouseStyle, has: (id: string) => boolean, top: number): void {
    if (!has('walls')) return;
    if (style.extra === 'chimney') {
      const chColor = style.wall === 'stone' ? '#5a5268' : '#9a5a3d';
      const chModel = prop('bld_chimney', { Stone: chColor });
      if (chModel) {
        chModel.position.set(2.2, top, -1);
        house.add(shadowed(chModel));
      } else {
        const ch = box(0.7, 1.8, 0.7, mat(chColor, 0.9));
        ch.position.set(2.2, top + 0.9, -1);
        house.add(ch);
      }
      const smokeMat = new THREE.MeshBasicMaterial({ color: '#e8e8ef', transparent: true, opacity: 0.5, depthWrite: false });
      const puffs = [0, 1, 2, 3].map(() => {
        const p = ball(0.25, smokeMat, 8);
        house.add(p);
        return p;
      });
      const fn = (_dt: number, t: number) => {
        if (!house.parent) {
          this.anim.delete(fn);
          return;
        }
        puffs.forEach((p, i) => {
          const s = (t * 0.25 + i / 4) % 1;
          p.position.set(2.2 + Math.sin(s * 5) * 0.3 + s * this.world.windUniforms.uWind.value, top + 1.9 + s * 2.6, -1);
          p.scale.setScalar(0.6 + s * 2);
        });
        smokeMat.opacity = 0.4;
      };
      this.anim.add(fn);
    } else if (style.extra === 'clock') {
      const face = cyl(0.75, 0.75, 0.1, mat('#fbf7ef', 0.4), 32);
      face.rotation.x = Math.PI / 2;
      face.position.set(0, top + 0.85, HOUSE.D / 2 + 0.12);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.76, 0.07, 8, 32), mat('#c9a04a', 0.3, 0.7));
      rim.position.copy(face.position);
      const hour = box(0.06, 0.4, 0.04, mat('#2f3a56', 0.5));
      hour.geometry.translate(0, 0.2, 0);
      const minute = box(0.05, 0.6, 0.04, mat('#2f3a56', 0.5));
      minute.geometry.translate(0, 0.3, 0);
      hour.position.copy(face.position).add(new THREE.Vector3(0, 0, 0.08));
      minute.position.copy(hour.position);
      house.add(face, rim, hour, minute);
      const fn = () => {
        if (!house.parent) {
          this.anim.delete(fn);
          return;
        }
        // Shows the world's time of day.
        const h = this.world.time * 24;
        hour.rotation.z = -(h / 12) * TAU;
        minute.rotation.z = -(h % 1) * TAU;
      };
      this.anim.add(fn);
    } else if (style.extra === 'radar') {
      const mast = cyl(0.08, 0.08, 1.4, mat('#8a94a8', 0.4, 0.6), 8);
      mast.position.set(0, top + 1.0, 0);
      const dish = new THREE.Mesh(new THREE.SphereGeometry(0.8, 18, 8, 0, TAU, 0, Math.PI / 3), mat('#f2f2f2', 0.4, 0.3, 'double'));
      dish.rotation.x = -1.1;
      const pivot = new THREE.Group();
      pivot.position.set(0, top + 1.7, 0);
      pivot.add(dish);
      house.add(mast, pivot);
      const fn = (dt: number) => {
        if (!house.parent) {
          this.anim.delete(fn);
          return;
        }
        pivot.rotation.y += dt * 0.6;
      };
      this.anim.add(fn);
    }
  }

  /* --- mess to clear ------------------------------------------------------- */

  private buildMess(has: (id: string) => boolean, add: (o: THREE.Object3D, x: number, z: number, y?: number) => THREE.Object3D): void {
    const areas: [number, number][][] = [
      [[-6, 3], [-7.5, 2.2], [-4.6, 4.1], [-8.4, 4.4], [-2.6, 5.2]],
      [[6, 5], [3, 6.2], [8.5, 3.6], [1, 7], [5, 7.4]],
      [[-4.6, -3], [-4.4, -6], [4.6, -4], [4.5, -7.5], [-2, -3.4], [2.6, -3.2]],
      [[5, -2], [6.2, -2.8], [5.6, -1], [7.2, -1.8]],
    ];
    this.theme.mess.forEach(([kind, color], i) => {
      if (has(`mess${i}`)) return;
      areas[i].forEach(([x, z], k) => {
        const piece = this.messPiece(kind, color, k);
        piece.rotation.y = k * 1.7 + i;
        add(piece, x, z);
      });
    });
  }

  private messPiece(kind: MessKind, color: string, k: number): THREE.Group {
    const g = new THREE.Group();
    switch (kind) {
      case 'litter':
        if (k % 2) {
          const bottle = cyl(0.08, 0.1, 0.42, mat(k % 3 ? '#3f8f4f' : '#8a5a2b', 0.2), 10);
          bottle.rotation.z = Math.PI / 2;
          bottle.position.y = 0.09;
          g.add(bottle);
        } else {
          const can = cyl(0.08, 0.08, 0.22, mat(color, 0.3, 0.8), 10);
          can.rotation.set(Math.PI / 2, 0, 0.6);
          can.position.y = 0.08;
          g.add(can);
        }
        break;
      case 'sticks':
        for (let i = 0; i < 3; i++) {
          const s = cyl(0.06 + (k % 2) * 0.05, 0.08, 1.2 + (i % 2) * 0.8, mat(color, 0.95), 7);
          s.rotation.set(0, i * 0.8, Math.PI / 2);
          s.position.y = 0.1 + i * 0.08;
          g.add(s);
        }
        break;
      case 'spiky':
        for (let i = 0; i < 7; i++) {
          const blade = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.7, 4), mat(color, 0.9));
          blade.position.set(Math.cos(i * 1.3) * 0.2, 0.35, Math.sin(i * 1.3) * 0.2);
          blade.rotation.set(Math.cos(i) * 0.45, 0, Math.sin(i) * 0.45);
          g.add(blade);
        }
        break;
      case 'tumble': {
        const ball2 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45, 1), new THREE.MeshStandardMaterial({ color, wireframe: true }));
        ball2.position.y = 0.45;
        g.add(ball2);
        break;
      }
      case 'mounds': {
        const m = ball(0.5 + (k % 3) * 0.15, mat(color, 1), 12);
        m.scale.y = 0.4;
        g.add(m);
        break;
      }
      case 'rocks': {
        const r = makeRock(0.35 + (k % 3) * 0.15, color);
        r.position.y = 0.12;
        g.add(r);
        break;
      }
      case 'boxes': {
        const crate = prop('prop_crate', { Wood: color });
        const crateLid = prop('prop_crate_lid', { Wood: color });
        if (crate && crateLid) {
          crate.rotation.z = (k % 2) * 0.25;
          crateLid.position.set(0.3, 0.0, 0.4);
          crateLid.rotation.y = 0.6;
          g.add(crate, crateLid);
          break;
        }
        const b = box(0.8, 0.6, 0.8, mat(color, 0.9));
        b.position.y = 0.3;
        b.rotation.z = (k % 2) * 0.25;
        const lid = box(0.85, 0.08, 0.85, mat(color, 0.9));
        lid.position.set(0.3, 0.05, 0.4);
        lid.rotation.y = 0.6;
        g.add(b, lid);
        break;
      }
      case 'puddles': {
        const p = new THREE.Mesh(new THREE.CircleGeometry(0.6 + (k % 2) * 0.3, 18), mat(color, 0.1, 0.4));
        p.rotation.x = -Math.PI / 2;
        p.position.y = 0.02;
        g.add(p);
        break;
      }
      case 'stars': {
        const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.28), new THREE.MeshStandardMaterial({ color, emissive: new THREE.Color(color), emissiveIntensity: 0.5 }));
        s.position.y = 0.2;
        s.rotation.z = 0.6;
        g.add(s);
        break;
      }
      case 'cogs': {
        for (let i = 0; i < 2; i++) {
          const c = new THREE.Mesh(new THREE.TorusGeometry(0.22 + i * 0.1, 0.07, 6, 10), mat(color, 0.35, 0.7));
          c.rotation.x = Math.PI / 2;
          c.position.set(i * 0.4, 0.07 + i * 0.05, 0);
          g.add(c);
        }
        break;
      }
    }
    return g;
  }

  /* --- the shop ------------------------------------------------------------ */

  private buildShop(
    has: (id: string) => boolean,
    pick: (id: string, fallback: string) => string,
    add: (o: THREE.Object3D, x: number, z: number, y?: number) => THREE.Object3D,
    tag: (o: THREE.Object3D, task: string) => THREE.Object3D,
  ): void {
    if (has('deck')) {
      const deck = new THREE.Group();
      const color = pick('deck', '#c98b52');
      const boards = prop('prop_deck', { Paint: color });
      if (boards) deck.add(boards);
      else {
        for (let i = 0; i < 12; i++) {
          const board = box(0.58, 0.12, 3, mat(color, 0.8));
          board.position.set(-3.3 + i * 0.6, 0.3, 0);
          deck.add(board);
        }
      }
      add(tag(deck, 'deck'), 0, -2.75, 0);
    }
    if (has('counter')) {
      const counter = new THREE.Group();
      const counterModel = prop('prop_counter', { Paint: pick('counter', '#ffd66b') });
      if (counterModel) counter.add(counterModel);
      else {
        const front = box(3.2, 1.0, 0.7, mat(pick('counter', '#ffd66b'), 0.7));
        front.position.y = 0.85;
        const top = box(3.4, 0.1, 0.9, mat('#fbf7ef', 0.4));
        top.position.y = 1.4;
        counter.add(front, top);
      }
      for (let i = 0; i < 4; i++) {
        const item = ball(0.16, mat(this.theme.goods, 0.6), 12);
        item.scale.y = 0.8;
        item.position.set(-1.1 + i * 0.7, 1.58, 0);
        counter.add(item);
      }
      const jar = cyl(0.16, 0.16, 0.3, new THREE.MeshStandardMaterial({ color: '#dff4ff', transparent: true, opacity: 0.6, roughness: 0.05 }), 12);
      jar.position.set(1.45, 1.6, 0.2);
      counter.add(jar);
      add(tag(counter, 'counter'), 0, -2.0, has('deck') ? 0.36 : this.terrain(0, -2));
      for (const cx of [-1.2, 0, 1.2]) this.colliders.push({ x: cx, z: -2.0, r: 0.55 });
      this.spots.push({ kind: 'counter', x: 0, z: -1.9, r: 2.6, key: 'counter' });
    }
    if (has('kitchen')) {
      const k = new THREE.Group();
      const tableModel = prop('prop_kitchen');
      const table = tableModel ?? box(1.2, 0.9, 0.8, mat('#c98b52', 0.8));
      if (!tableModel) table.position.y = 0.45;
      const pot = cyl(0.32, 0.36, 0.45, mat('#5a6478', 0.3, 0.6), 18);
      pot.position.y = 1.12;
      const lid = ball(0.3, mat(this.theme.goods, 0.4), 16);
      lid.scale.y = 0.4;
      lid.position.y = 1.36;
      k.add(table, pot, lid);
      const steamMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.45, depthWrite: false });
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
          p.position.set(Math.sin(s * 6 + i) * 0.08, 1.5 + s * 1.1, 0);
          p.scale.setScalar(0.6 + s * 1.6);
        });
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
        const tableModel = prop('prop_table', { Paint: color });
        if (tableModel) set.add(tableModel);
        else {
          const top = cyl(0.65, 0.65, 0.08, mat(color, 0.6), 20);
          top.position.y = 0.85;
          const leg = cyl(0.07, 0.07, 0.85, mat('#ffffff', 0.5), 8);
          leg.position.y = 0.42;
          set.add(top, leg);
        }
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * TAU + 0.4;
          const stoolModel = prop('prop_stool', { Paint: color });
          if (stoolModel) {
            stoolModel.position.set(Math.cos(a) * 1.05, 0, Math.sin(a) * 1.05);
            stoolModel.rotation.y = -a;
            set.add(stoolModel);
          } else {
            const stool = cyl(0.25, 0.25, 0.08, mat(color, 0.6), 14);
            stool.position.set(Math.cos(a) * 1.05, 0.5, Math.sin(a) * 1.05);
            const sleg = cyl(0.05, 0.05, 0.5, mat('#ffffff', 0.5), 6);
            sleg.position.set(stool.position.x, 0.25, stool.position.z);
            set.add(stool, sleg);
          }
          this.seats.push({ x: x + Math.cos(a) * 1.05, z: z + Math.sin(a) * 1.05, y: this.terrain(x, z) + 0.55, facing: Math.atan2(-Math.cos(a), -Math.sin(a)) });
        }
        add(tag(set, 'tables'), x, z);
        this.colliders.push({ x, z, r: 0.75 });
        this.spots.push({ kind: 'table', x, z, r: 2.1, key: `table-${x}` });
      }
    }
    if (has('parasols')) {
      const color = pick('parasols', '#ff9a8b');
      if (this.theme.shade === 'parasol') {
        for (const [x, z, tilt] of [[5.2, 1.6, 0.12], [-6, 0.6, -0.1], [7.4, -0.8, 0.08]] as const) {
          const p = new THREE.Group();
          const parasol = prop('prop_parasol', { Paint: color });
          if (parasol) {
            parasol.rotation.y = x;
            p.add(parasol);
          } else {
            const pole = cyl(0.05, 0.05, 2.6, mat('#ffffff', 0.4), 8);
            pole.position.y = 1.3;
            p.add(pole);
            for (let i = 0; i < 8; i++) {
              const wedge = new THREE.Mesh(new THREE.ConeGeometry(1.6, 0.6, 3, 1, true, (i / 8) * TAU, TAU / 8), mat(i % 2 ? color : '#ffffff', 0.7, 0, 'double'));
              wedge.position.y = 2.7;
              p.add(wedge);
            }
          }
          p.rotation.z = tilt;
          add(tag(p, 'parasols'), x, z);
        }
      } else {
        // A striped awning over the porch and a canopy by the tables.
        for (const [x, z, w] of [[0, -0.9, 7.6], [-6.8, -0.6, 4]] as const) {
          const aw = new THREE.Group();
          const canopy = prop('prop_awning', { Paint: color });
          if (canopy) {
            canopy.scale.x = w / 4;
            aw.add(canopy);
          } else {
            for (let i = 0; i < 8; i++) {
              const stripe = box(w / 8, 0.06, 1.6, mat(i % 2 ? color : '#fbf7ef', 0.8));
              stripe.position.set(-w / 2 + (i + 0.5) * (w / 8), 2.55, 0);
              stripe.rotation.x = 0.25;
              aw.add(stripe);
            }
          }
          for (const s of [-1, 1]) {
            const pm = prop('prop_pole');
            if (pm) {
              pm.position.set((s * w) / 2, 0, 0.7);
              aw.add(pm);
              continue;
            }
            const pole = cyl(0.05, 0.05, 2.5, mat('#6b4a33', 0.8), 6);
            pole.position.set((s * w) / 2, 1.25, 0.7);
            aw.add(pole);
          }
          add(tag(aw, 'parasols'), x, z);
        }
      }
    }
    if (has('path')) {
      for (let i = 0; i < 8; i++) {
        const z = -0.6 + i * 0.95;
        const x = Math.sin(i * 0.9) * 0.6;
        const stone = makeRock(0.38, this.theme.path);
        stone.scale.y = 0.25;
        add(stone, x, z, this.terrain(x, z) + 0.02);
      }
    }
  }

  /* --- life around the place ----------------------------------------------- */

  private buildLife(
    has: (id: string) => boolean,
    pick: (id: string, fallback: string) => string,
    add: (o: THREE.Object3D, x: number, z: number, y?: number) => THREE.Object3D,
    tag: (o: THREE.Object3D, task: string) => THREE.Object3D,
  ): void {
    const th = this.theme;
    if (has('flowers')) {
      const color = pick('flowers', '#ff5a6e');
      for (const s of [-1, 1]) {
        const bed = new THREE.Group();
        const soil = box(2.2, 0.3, 0.8, mat(th.plants === 'coral' ? '#e8dcc4' : '#6b4a33', 1));
        soil.position.y = 0.15;
        bed.add(soil);
        const kinds = modelNames(`plant_${th.plants}_`);
        for (let i = 0; i < 7; i++) {
          const x = -0.85 + i * 0.28;
          const z = (i % 2) * 0.25 - 0.12;
          const plant = kinds.length ? model(kinds[(i + (s > 0 ? 1 : 0)) % kinds.length]) : null;
          if (plant) {
            // Blender plants are 1 unit tall; the bloom colour comes from the place.
            const petal = th.plants === 'flowers' && i % 3 === 0 ? '#ffd23f' : color;
            recolor(plant, { Petal: petal, Center: petal === '#ffd23f' ? '#c86a2a' : '#ffd23f', Berry: color, Coral: color, Cap: color });
            if (th.plants === 'mushrooms') {
              plant.traverse((o) => {
                const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
                if (m?.name?.startsWith('Cap')) m.emissive?.set(color);
              });
            }
            const size = { flowers: 0.6, shrubs: 0.42, cacti: 0.55, coral: 0.55, mushrooms: 0.5 }[th.plants];
            plant.scale.setScalar(size * (0.85 + ((i * 37) % 10) * 0.03));
            plant.position.set(x, 0.3, z);
            plant.rotation.y = i * 2.1;
            bed.add(shadows(plant));
            continue;
          }
          if (th.plants === 'cacti') {
            const c = cyl(0.09, 0.1, 0.5 + (i % 3) * 0.15, mat('#5fae6a', 0.8), 8);
            c.position.set(x, 0.55, z);
            const bloom = ball(0.08, mat(color, 0.6), 8);
            bloom.position.set(x, 0.85 + (i % 3) * 0.08, z);
            bed.add(c, bloom);
          } else if (th.plants === 'coral') {
            for (let b = -1; b <= 1; b++) {
              const br = cyl(0.03, 0.05, 0.45, mat(color, 0.6), 5);
              br.position.set(x + b * 0.08, 0.5, z);
              br.rotation.z = b * 0.5;
              bed.add(br);
            }
          } else if (th.plants === 'mushrooms') {
            const stem = cyl(0.04, 0.05, 0.3, mat('#f2ece0', 0.7), 6);
            stem.position.set(x, 0.45, z);
            const capM = new THREE.MeshStandardMaterial({ color, emissive: new THREE.Color(color), emissiveIntensity: 0.6, roughness: 0.4 });
            const cap = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8, 0, TAU, 0, Math.PI / 2), capM);
            cap.position.set(x, 0.6, z);
            bed.add(stem, cap);
          } else if (th.plants === 'shrubs') {
            const bush = ball(0.2, mat('#3f6e4f', 0.9), 10);
            bush.position.set(x, 0.42, z);
            const berry = ball(0.06, mat(color, 0.5), 6);
            berry.position.set(x + 0.1, 0.55, z + 0.12);
            bed.add(bush, berry);
          } else {
            const stem = cyl(0.02, 0.02, 0.45, mat('#3f8f4f', 0.8), 5);
            stem.position.set(x, 0.5, z);
            const bloom = ball(0.14, mat(i % 3 ? color : '#ffd23f', 0.6), 10);
            bloom.position.set(x, 0.75, z);
            bed.add(stem, bloom);
          }
        }
        add(tag(bed, 'flowers'), s * 4.8, -3.6);
        this.spots.push({ kind: 'flowers', x: s * 4.8, z: -3.6, r: 1.7, key: `flowers-${s}` });
      }
    }
    if (has('palms')) {
      for (const [x, z, h] of [[-9, -4.5, 5.2], [8.5, -6, 5.8], [-6.5, -10, 6.2]] as const) {
        const tree = this.makeTree(th.trees, h, Math.round(x));
        add(tree, x, z);
        this.colliders.push({ x, z, r: 0.5 });
        this.spots.push({ kind: 'gather', x, z, r: 1.7, key: `tree-new-${x}`, label: th.gather.label, icon: th.gather.icon, reward: th.gather.reward });
      }
    }
    if (has('landmark')) {
      const lm = this.landmark();
      add(lm, 8, 3);
      this.colliders.push({ x: 8, z: 3, r: 1.2 });
      const words = this.data.tasks.find((t) => t.id === 'landmark');
      this.spots.push({ kind: 'landmark', x: 8, z: 3, r: 2.4, key: 'landmark', label: 'Admire it', icon: words?.icon ?? '✨' });
    }
    if (has('tower')) {
      const t = new THREE.Group();
      const towerModel = prop('prop_tower', { Paint: th.house.trim });
      if (towerModel) t.add(towerModel);
      else {
        for (const [x, z] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) {
          const leg = cyl(0.08, 0.1, 2.4, mat('#fbf7ef', 0.6), 8);
          leg.position.set(x, 1.2, z);
          t.add(leg);
        }
        const deck = box(1.8, 0.15, 1.8, mat('#c98b52', 0.8));
        deck.position.y = 2.4;
        const hut = box(1.5, 1.1, 1.5, mat(th.house.trim, 0.6));
        hut.position.y = 3.0;
        const roof = new THREE.Mesh(new THREE.ConeGeometry(1.3, 0.7, 4), mat('#fbf7ef', 0.6));
        roof.position.y = 3.9;
        roof.rotation.y = Math.PI / 4;
        t.add(deck, hut, roof);
      }
      add(t, -10.5, 6.4);
      this.colliders.push({ x: -10.5, z: 6.4, r: 1.05 });
      this.spots.push({ kind: 'tower', x: -10.5, z: 6.4, r: 2.3, key: 'tower', at: [-10.5, this.terrain(-10.5, 6.4) + 2.48, 6.6], exit: [-10.5, 4.6], facing: 0 });
    }
    if (has('bonfire')) {
      const f = new THREE.Group();
      const pit = prop('prop_firepit');
      if (pit) f.add(pit);
      else {
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
        this.glows.push({ m, power: 1.4, always: 1.0, flicker: true, light: i === 0 ? light : undefined });
      }
      add(f, -7, 6);
      this.colliders.push({ x: -7, z: 6, r: 0.95 });
      this.spots.push({ kind: 'bonfire', x: -7, z: 6, r: 2.3, key: 'bonfire' });
    }
    if (has('hammock')) {
      const color = pick('hammock', '#ff9a8b');
      const bed = new THREE.Group();
      if (th.bed === 'hammock') {
        const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(-1.3, 1.2, 0), new THREE.Vector3(0, 0.7, 0), new THREE.Vector3(1.3, 1.2, 0)]);
        const cloth = new THREE.Mesh(new THREE.TubeGeometry(curve, 20, 0.3, 10), mat(color, 0.9));
        cloth.scale.z = 1.5;
        cloth.scale.y = 0.6;
        bed.add(cloth);
        for (const s of [-1, 1]) {
          for (const lz of [-0.3, 0.3]) {
            const leg = cyl(0.07, 0.09, 1.7, mat('#8a5e3c', 0.85), 8);
            leg.position.set(s * 1.75, 0.8, lz);
            leg.rotation.x = lz > 0 ? -0.18 : 0.18;
            bed.add(leg);
          }
        }
      } else if (th.bed === 'cloud') {
        for (let i = 0; i < 6; i++) {
          const puff = ball(0.5, mat('#ffffff', 1), 12);
          puff.position.set(-1 + i * 0.4, 0.45 + Math.sin(i) * 0.08, (i % 2) * 0.3 - 0.15);
          bed.add(puff);
        }
        const pillow = ball(0.3, mat(color, 0.9), 10);
        pillow.scale.set(1.2, 0.5, 0.9);
        pillow.position.set(-1, 0.85, 0);
        bed.add(pillow);
      } else {
        const base = box(2.2, 0.35, 1.2, mat('#8a5e3c', 0.8));
        base.position.y = 0.18;
        const mattress = box(2.0, 0.3, 1.05, mat(color, 0.95));
        mattress.position.y = 0.5;
        const pillow = ball(0.3, mat('#fbf7ef', 0.9), 10);
        pillow.scale.set(0.8, 0.45, 1.4);
        pillow.position.set(-0.75, 0.72, 0);
        bed.add(base, mattress, pillow);
      }
      bed.rotation.y = 0.2;
      add(tag(bed, 'hammock'), -12, -4.4);
      this.colliders.push({ x: -12, z: -4.4, r: 0.9 });
      const y = this.terrain(-12, -4.4) + (th.bed === 'hammock' ? 0.75 : 0.7);
      this.spots.push({ kind: 'hammock', x: -12, z: -3.2, r: 2.0, key: 'bed', at: [-12, y, -4.4], exit: [-12, -2.6], facing: 0.2 + Math.PI / 2 });
    }
    if (has('lights')) {
      const bulbs = new THREE.MeshStandardMaterial({ color: '#fff3c4', emissive: new THREE.Color('#ffd36b'), emissiveIntensity: 0, roughness: 0.3 });
      const line = new THREE.LineBasicMaterial({ color: '#3a3530' });
      const runs: [THREE.Vector3, THREE.Vector3][] = [
        [new THREE.Vector3(-3.6, 3.1, -4.1), new THREE.Vector3(-7.6, 2.4, 0.6)],
        [new THREE.Vector3(3.6, 3.1, -4.1), new THREE.Vector3(7.6, 2.4, -0.8)],
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
      this.glows.push({ m: bulbs, power: 2.4, always: 0, flicker: false });
      for (const [x, z] of [[-7.6, 0.6], [7.6, -0.8]] as const) {
        const pm = prop('prop_pole');
        if (pm) {
          pm.position.set(x, this.terrain(x, z), z);
          lights.add(pm);
          continue;
        }
        const pole = cyl(0.05, 0.05, 2.5, mat('#8a5e3c', 0.9), 6);
        pole.position.set(x, this.terrain(x, z) + 1.25, z);
        lights.add(pole);
      }
      add(lights, 0, 0, 0);
    }
    if (has('opening')) {
      const bunting = new THREE.Group();
      const colors = ['#ff6b6b', '#ffd23f', '#5fdbab', '#74c8ff', '#b18cff'];
      for (let i = 0; i < 14; i++) {
        const t = i / 13;
        const flag = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.35, 3), mat(colors[i % colors.length], 0.7, 0, 'double'));
        flag.rotation.x = Math.PI;
        flag.position.set(-3.6 + t * 7.2, 3.35 - Math.sin(t * Math.PI) * 0.35, -1.0);
        bunting.add(flag);
      }
      add(bunting, 0, 0, 0);
    }
  }

  /** The region's showpiece. */
  private landmark(): THREE.Group {
    const g = new THREE.Group();
    const th = this.theme;
    switch (th.landmark) {
      case 'fountain':
      case 'whale': {
        const basin = cyl(1.3, 1.4, 0.5, mat('#d8d2c8', 0.6), 24);
        basin.position.y = 0.25;
        const water = cyl(1.15, 1.15, 0.05, new THREE.MeshStandardMaterial({ color: '#5fc7e8', roughness: 0.05, transparent: true, opacity: 0.85 }), 24);
        water.position.y = 0.45;
        g.add(basin, water);
        if (th.landmark === 'whale') {
          const whale = ball(0.6, mat('#5b8def', 0.5), 18);
          whale.scale.set(1.4, 0.8, 1);
          whale.position.y = 0.9;
          const tail = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.6, 3), mat('#5b8def', 0.5));
          tail.position.set(-0.9, 1.1, 0);
          tail.rotation.z = 1.2;
          g.add(whale, tail);
        } else {
          const column = cyl(0.18, 0.25, 1.4, mat('#d8d2c8', 0.6), 12);
          column.position.y = 1.0;
          const bowl = cyl(0.6, 0.3, 0.25, mat('#d8d2c8', 0.6), 18);
          bowl.position.y = 1.7;
          g.add(column, bowl);
        }
        // Spray.
        const sprayMat = new THREE.MeshBasicMaterial({ color: '#dff4ff', transparent: true, opacity: 0.7, depthWrite: false });
        const drops = Array.from({ length: 18 }, () => {
          const d = ball(0.05, sprayMat, 6);
          g.add(d);
          return d;
        });
        const top = th.landmark === 'whale' ? 1.3 : 1.85;
        const fn = (_dt: number, t: number) => {
          if (!g.parent) {
            this.anim.delete(fn);
            return;
          }
          drops.forEach((d, i) => {
            const s = (t * 0.9 + i / drops.length) % 1;
            const a = (i / drops.length) * TAU;
            d.position.set(Math.cos(a) * s * 0.9, top + s * 1.4 - s * s * 2.2, Math.sin(a) * s * 0.9);
          });
        };
        this.anim.add(fn);
        break;
      }
      case 'snowman': {
        for (const [y, r] of [[0.6, 0.65], [1.45, 0.48], [2.1, 0.34]]) {
          const b = ball(r, mat('#ffffff', 0.8), 18);
          b.position.y = y;
          g.add(b);
        }
        const nose = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.35, 8), mat('#ff8c42', 0.6));
        nose.rotation.x = Math.PI / 2;
        nose.position.set(0, 2.1, 0.45);
        const hat = cyl(0.25, 0.25, 0.4, mat('#2f3a56', 0.6), 14);
        hat.position.y = 2.6;
        const brim = cyl(0.38, 0.38, 0.05, mat('#2f3a56', 0.6), 14);
        brim.position.y = 2.42;
        const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.08, 8, 20), mat('#ff6b6b', 0.7));
        scarf.rotation.x = Math.PI / 2;
        scarf.position.y = 1.85;
        g.add(nose, hat, brim, scarf);
        break;
      }
      case 'well': {
        const ring = cyl(0.9, 1.0, 0.9, mat('#c9a77a', 0.9), 20);
        ring.position.y = 0.45;
        const water = cyl(0.75, 0.75, 0.05, mat('#3fc7c8', 0.1), 20);
        water.position.y = 0.8;
        for (const s of [-1, 1]) {
          const post = box(0.15, 1.8, 0.15, mat('#8a5e3c', 0.8));
          post.position.set(s * 0.9, 1.3, 0);
          g.add(post);
        }
        const roof = new THREE.Mesh(new THREE.ConeGeometry(1.3, 0.7, 4), mat('#d9895a', 0.8));
        roof.rotation.y = Math.PI / 4;
        roof.position.y = 2.5;
        const bucket = cyl(0.15, 0.12, 0.25, mat('#8a5e3c', 0.8), 10);
        bucket.position.set(0, 1.4, 0);
        g.add(ring, water, roof, bucket);
        break;
      }
      case 'windmill': {
        const tower = cyl(0.2, 0.35, 5, mat('#e8e8ef', 0.6), 10);
        tower.position.y = 2.5;
        g.add(tower);
        const hub = new THREE.Group();
        hub.position.set(0, 5, 0.35);
        for (let i = 0; i < 4; i++) {
          const blade = box(0.25, 1.8, 0.05, mat('#ffffff', 0.6));
          blade.position.y = 0.9;
          const arm = new THREE.Group();
          arm.rotation.z = (i / 4) * TAU;
          arm.add(blade);
          hub.add(arm);
        }
        g.add(hub);
        const fn = (dt: number) => {
          if (!g.parent) {
            this.anim.delete(fn);
            return;
          }
          hub.rotation.z += dt * (1 + this.world.windUniforms.uWind.value * 3);
        };
        this.anim.add(fn);
        break;
      }
      case 'crystal': {
        const m = new THREE.MeshStandardMaterial({ color: '#b7a4ff', emissive: new THREE.Color('#b7a4ff'), emissiveIntensity: 0.9, roughness: 0.1 });
        const c = new THREE.Mesh(new THREE.OctahedronGeometry(1.2), m);
        c.scale.y = 1.8;
        c.position.y = 2.6;
        g.add(c);
        const base = makeRock(1.1, '#4a4360');
        base.position.y = 0.4;
        g.add(base);
        const light = new THREE.PointLight('#b7a4ff', 0, 10, 1.6);
        light.position.y = 2.6;
        g.add(light);
        this.glows.push({ m, power: 1.2, always: 0.9, flicker: false, light });
        const fn = (dt: number, t: number) => {
          if (!g.parent) {
            this.anim.delete(fn);
            return;
          }
          c.rotation.y += dt * 0.5;
          c.position.y = 2.6 + Math.sin(t * 1.5) * 0.15;
        };
        this.anim.add(fn);
        break;
      }
      case 'clock': {
        const tower = box(1.6, 5, 1.6, mat('#b5603d', 0.85));
        tower.position.y = 2.5;
        const roof = new THREE.Mesh(new THREE.ConeGeometry(1.4, 1.4, 4), mat('#5fae9a', 0.6));
        roof.rotation.y = Math.PI / 4;
        roof.position.y = 5.7;
        const face = cyl(0.6, 0.6, 0.1, mat('#fbf7ef', 0.4), 24);
        face.rotation.x = Math.PI / 2;
        face.position.set(0, 4.2, 0.82);
        const hand = box(0.05, 0.45, 0.04, mat('#2f3a56', 0.5));
        hand.geometry.translate(0, 0.22, 0);
        hand.position.set(0, 4.2, 0.9);
        g.add(tower, roof, face, hand);
        const fn = () => {
          if (!g.parent) {
            this.anim.delete(fn);
            return;
          }
          hand.rotation.z = -this.world.time * 24 * (TAU / 12);
        };
        this.anim.add(fn);
        break;
      }
      case 'telescope': {
        const tri = new THREE.Group();
        for (let i = 0; i < 3; i++) {
          const leg = cyl(0.04, 0.05, 1.8, mat('#8a5e3c', 0.8), 6);
          const a = (i / 3) * TAU;
          leg.position.set(Math.cos(a) * 0.4, 0.85, Math.sin(a) * 0.4);
          leg.rotation.set(Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25);
          tri.add(leg);
        }
        const tube = cyl(0.18, 0.28, 2.2, mat('#c9a04a', 0.3, 0.7), 16);
        tube.rotation.z = 1.0;
        tube.position.set(0.4, 2.1, 0);
        g.add(tri, tube);
        break;
      }
      case 'rainbow': {
        ['#ff9aa2', '#ffc78a', '#fff19a', '#a8f0b8', '#9ed8ff', '#c7a8ff'].forEach((c, i) => {
          const arc = new THREE.Mesh(new THREE.TorusGeometry(2.2 - i * 0.18, 0.09, 8, 32, Math.PI), mat(c, 0.5));
          g.add(arc);
        });
        break;
      }
    }
    return g;
  }

  /* --- per frame ------------------------------------------------------------ */

  private animate(dt: number, t: number): void {
    const night = this.world.night;
    for (const g of [...this.glows, ...this.envGlows]) {
      const f = g.flicker ? 0.85 + Math.sin(t * 17) * 0.1 + Math.sin(t * 31) * 0.05 : 1;
      const level = (g.always + night * g.power) * f;
      g.m.emissiveIntensity = level;
      if (g.light) g.light.intensity = level * 6;
    }
    this.flames.forEach((f, i) => {
      f.scale.set(1 + Math.sin(t * 9 + i) * 0.12, 1 + Math.sin(t * 13 + i * 2) * 0.2, 1 + Math.cos(t * 8 + i) * 0.12);
      f.rotation.y += dt * (1 + i);
    });
    if (this.opened && night > 0.6 && t > this.fireworksAt) {
      this.fireworksAt = t + 1.4 + Math.random() * 1.8;
      this.firework();
    }
  }

  private firework(): void {
    const colors = ['#ff6b6b', '#ffd23f', '#5fdbab', '#74c8ff', '#b18cff', '#ff9ae0'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const at = new THREE.Vector3((Math.random() - 0.5) * 40, 16 + Math.random() * 8, -20 - Math.random() * 20);
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
