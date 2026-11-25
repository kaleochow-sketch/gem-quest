/**
 * The big beach where Fetch is played: a long, wide bay of pale sand, well
 * away from the café. A lighthouse on the headland (its lamp turns at
 * night), a row of painted beach huts, parasols, surfboards, a volleyball
 * net, sandcastles and kites over the sea give it its own character.
 */
import * as THREE from 'three';
import { Place, TAU, World } from './engine.js';
import { ball, box, cyl, makeGrass, makePalm, makeRock, mat, shadowed } from './models.js';

/** Sand height: a broad flat beach that shelves into the sea, dunes behind. */
export function bigSandY(x: number, z: number): number {
  let y = 0;
  if (z > 12) y -= (z - 12) * 0.12;
  if (z < -20) y += (-20 - z) * 0.18 + Math.sin(x * 0.18) * 0.5 * Math.min(1, (-20 - z) / 6);
  y += Math.sin(x * 0.31 + z * 0.17) * 0.05 + Math.sin(x * 0.11 - z * 0.27) * 0.08;
  return y;
}

export const PLAY = { x0: -34, x1: 34, z0: -18, z1: 15 };

export class BigBeach implements Place {
  readonly root = new THREE.Group();
  readonly anim = new Set<(dt: number, t: number) => void>();
  readonly walkables: THREE.Object3D[] = [];
  readonly prints: [string, string] = ['#c7ab72', '#efdcb0'];
  private lamp!: THREE.Group;
  private beamMat!: THREE.MeshBasicMaterial;
  private lampLight!: THREE.PointLight;

  constructor(private world: World) {
    this.build();
  }

  groundAt(x: number, z: number): number {
    return bigSandY(x, z);
  }

  clamp(p: THREE.Vector3): void {
    p.x = THREE.MathUtils.clamp(p.x, PLAY.x0, PLAY.x1);
    p.z = THREE.MathUtils.clamp(p.z, PLAY.z0, PLAY.z1);
    p.y = bigSandY(p.x, p.z);
  }

  private build(): void {
    const w = this.world;
    const root = this.root;

    // Pale, fine sand; damp and darker where the waves reach.
    const geo = new THREE.PlaneGeometry(260, 130, 140, 70);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -15);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const cols: number[] = [];
    const dry = new THREE.Color('#efdcb0');
    const wet = new THREE.Color('#d2b77f');
    const dune = new THREE.Color('#efdcac');
    const green = new THREE.Color('#9cc77a');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, bigSandY(x, z));
      const c = dry.clone();
      if (z > 11) c.lerp(wet, Math.min(1, (z - 11) / 4));
      if (z < -20) c.lerp(dune, Math.min(1, (-20 - z) / 4)).lerp(green, Math.min(0.7, Math.max(0, (-25 - z) / 10)));
      c.offsetHSL(0, 0, (Math.sin(x * 2.3) * Math.sin(z * 3.1) + Math.sin(x * 7 + z * 5) * 0.5) * 0.02);
      cols.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    geo.computeVertexNormals();
    const sand = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
    sand.receiveShadow = true;
    root.add(sand);
    this.walkables.push(sand);

    // A clear turquoise lagoon that deepens to blue.
    const seaGeo = new THREE.PlaneGeometry(360, 220, 100, 60);
    seaGeo.rotateX(-Math.PI / 2);
    seaGeo.translate(0, -0.34, 124);
    const sp = seaGeo.attributes.position as THREE.BufferAttribute;
    const seaCols: number[] = [];
    const shallow = new THREE.Color('#6fe3d8');
    const deep = new THREE.Color('#1a78b8');
    for (let i = 0; i < sp.count; i++) {
      const c = shallow.clone().lerp(deep, Math.min(1, Math.max(0, (sp.getZ(i) - 14) / 50)));
      seaCols.push(c.r, c.g, c.b);
    }
    seaGeo.setAttribute('color', new THREE.Float32BufferAttribute(seaCols, 3));
    const sea = new THREE.Mesh(
      seaGeo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.05, metalness: 0.02, transparent: true, opacity: 0.85 }),
    );
    root.add(sea);
    const base = Float32Array.from(sp.array as Float32Array);
    let tick = 0;
    this.anim.add((dt, t) => {
      tick += dt;
      if (tick < 1 / 30) return;
      tick = 0;
      const wind = w.windUniforms.uWind.value;
      for (let i = 0; i < sp.count; i++) {
        const x = base[i * 3];
        const z = base[i * 3 + 2];
        sp.setY(
          i,
          base[i * 3 + 1] +
            (Math.sin(x * 0.22 + t * 1.0) * 0.12 + Math.sin(z * 0.4 - t * 1.4) * 0.1 + Math.sin((x - z) * 0.8 + t * 2.2) * 0.04) *
              (0.6 + wind * 0.6),
        );
      }
      sp.needsUpdate = true;
      seaGeo.computeVertexNormals();
    });
    const foamMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.4, depthWrite: false });
    const foam = new THREE.Mesh(new THREE.PlaneGeometry(260, 0.7, 80, 1), foamMat);
    foam.rotation.x = -Math.PI / 2;
    root.add(foam);
    this.anim.add((_dt, t) => {
      const s = Math.sin(t * 0.6);
      foam.position.set(0, -0.32 + s * 0.03, 14.8 - s * 0.7);
      foamMat.opacity = 0.2 + (s + 1) * 0.15;
    });

    // The headland and its lighthouse.
    const head = new THREE.Group();
    for (const [x, z, r] of [[0, 0, 7], [5, 3, 5], [-4, 4, 4.5], [2, 8, 3.5]] as const) {
      const rock = makeRock(r, '#a7a29a');
      rock.position.set(x, r * 0.25, z);
      head.add(rock);
    }
    const tower = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const band = cyl(1.25 - i * 0.08, 1.3 - i * 0.08, 1.6, mat(i % 2 ? '#ffffff' : '#e84a4a', 0.6), 20);
      band.position.y = 0.8 + i * 1.6;
      tower.add(band);
    }
    const gallery = cyl(1.3, 1.3, 0.25, mat('#2f3a56', 0.5), 20);
    gallery.position.y = 9.8;
    const lampHouse = cyl(0.75, 0.75, 1.2, new THREE.MeshStandardMaterial({ color: '#fff7d6', emissive: new THREE.Color('#ffe08a'), emissiveIntensity: 0.3, roughness: 0.2 }), 16);
    lampHouse.position.y = 10.5;
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.95, 1.0, 16), mat('#e84a4a', 0.5));
    cap.position.y = 11.6;
    tower.add(gallery, lampHouse, cap);
    this.lamp = new THREE.Group();
    this.lamp.position.y = 10.5;
    this.beamMat = new THREE.MeshBasicMaterial({ color: '#fff3c0', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const beam = new THREE.Mesh(new THREE.ConeGeometry(3.2, 40, 20, 1, true), this.beamMat);
    beam.rotation.z = Math.PI / 2;
    beam.position.x = 20;
    this.lamp.add(beam);
    this.lampLight = new THREE.PointLight('#ffe9a8', 0, 40, 1.4);
    this.lamp.add(this.lampLight);
    tower.add(this.lamp);
    tower.position.set(0, 4, 0);
    head.add(tower);
    head.position.set(-58, 0, 24);
    root.add(shadowed(head));
    this.anim.add((dt) => {
      this.lamp.rotation.y += dt * 0.8;
      this.beamMat.opacity = w.night * 0.22;
      this.lampLight.intensity = w.night * 30;
      (lampHouse.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.3 + w.night * 2.5;
    });

    // A row of painted beach huts behind the beach.
    const hutColors = ['#ff8fa3', '#74c8ff', '#ffd66b', '#8fe3c0', '#c3a6f5', '#ffb36b', '#6fd3e8'];
    hutColors.forEach((c, i) => {
      const hut = new THREE.Group();
      const body = box(2.4, 2.4, 2.2, mat(c, 0.7));
      body.position.y = 1.2;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.95, 1.1, 4), mat('#ffffff', 0.6));
      roof.rotation.y = Math.PI / 4;
      roof.position.y = 2.95;
      const door = box(0.9, 1.7, 0.06, mat('#ffffff', 0.5));
      door.position.set(0, 0.95, 1.12);
      const stripe = box(2.42, 0.25, 2.22, mat('#ffffff', 0.6));
      stripe.position.y = 2.25;
      hut.add(body, roof, door, stripe);
      const x = -30 + i * 9;
      hut.position.set(x, bigSandY(x, -22), -22);
      root.add(shadowed(hut));
    });

    // Parasols and towels dotted along the sand, out of the main play area.
    const stripes = ['#ff6b6b', '#3fa7a0', '#ffd23f', '#5b8def', '#ff9a8b'];
    for (const [x, z, k] of [[-30, -6, 0], [-26, 8, 1], [27, -8, 2], [31, 6, 3], [-12, -16, 4], [14, -15, 0]] as const) {
      const p = new THREE.Group();
      const pole = cyl(0.05, 0.05, 2.6, mat('#ffffff', 0.4), 8);
      pole.position.y = 1.3;
      p.add(pole);
      for (let i = 0; i < 8; i++) {
        const wedge = new THREE.Mesh(new THREE.ConeGeometry(1.7, 0.6, 3, 1, true, (i / 8) * TAU, TAU / 8), mat(i % 2 ? stripes[k] : '#ffffff', 0.7, 0, 'double'));
        wedge.position.y = 2.7;
        p.add(wedge);
      }
      const towel = box(1.0, 0.03, 1.9, mat(stripes[(k + 2) % stripes.length], 0.9));
      towel.position.set(0.9, 0.02, 0.6);
      towel.rotation.y = 0.3;
      p.add(towel);
      p.position.set(x, bigSandY(x, z), z);
      root.add(shadowed(p));
    }

    // Surfboards stuck upright in the sand.
    [['#ff6b6b', -33, -12], ['#5b8def', -31.8, -12.4], ['#ffd23f', -30.6, -12.1]].forEach(([c, x, z]) => {
      const board = ball(0.5, mat(c as string, 0.4), 16);
      board.scale.set(0.9, 3.2, 0.18);
      board.position.set(x as number, bigSandY(x as number, z as number) + 1.3, z as number);
      board.rotation.z = (Math.random() - 0.5) * 0.2;
      root.add(shadowed(board));
    });

    // A volleyball net.
    {
      const net = new THREE.Group();
      for (const s of [-1, 1]) {
        const post = cyl(0.08, 0.08, 2.6, mat('#ffffff', 0.5), 8);
        post.position.set(s * 4, 1.3, 0);
        net.add(post);
      }
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(8, 0.9, 16, 3), new THREE.MeshStandardMaterial({ color: '#2f3a56', wireframe: true }));
      mesh.position.y = 2.1;
      net.add(mesh);
      net.position.set(24, bigSandY(24, -12), -12);
      net.rotation.y = 0.3;
      root.add(shadowed(net));
    }

    // Sandcastles.
    for (const [x, z, s] of [[-22, 10, 1], [20, 11, 0.8], [-6, -14, 0.9]] as const) {
      const castle = new THREE.Group();
      const sandMat = mat('#e9d29b', 1);
      const keep = cyl(0.6 * s, 0.7 * s, 0.9 * s, sandMat, 10);
      keep.position.y = 0.45 * s;
      castle.add(keep);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + 0.4;
        const t = cyl(0.25 * s, 0.3 * s, 0.6 * s, sandMat, 8);
        t.position.set(Math.cos(a) * 0.9 * s, 0.3 * s, Math.sin(a) * 0.9 * s);
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.28 * s, 0.35 * s, 8), sandMat);
        cone.position.set(t.position.x, 0.78 * s, t.position.z);
        castle.add(t, cone);
      }
      const flag = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 3), mat('#ff6b6b', 0.6));
      flag.rotation.z = -Math.PI / 2;
      flag.position.set(0.15, 1.35 * s, 0);
      const stick = cyl(0.015, 0.015, 0.6, mat('#8a5e3c', 0.8), 4);
      stick.position.y = 1.2 * s;
      castle.add(flag, stick);
      castle.position.set(x, bigSandY(x, z), z);
      root.add(shadowed(castle));
    }

    // Palms at the back and ends of the beach.
    for (const [x, z, h, lean] of [[-36, -16, 7, 0.2], [-33, -19, 6, -0.2], [36, -14, 6.8, -0.25], [34, -18, 6, 0.2], [-8, -21, 6.2, 0.1], [9, -21, 5.8, -0.15]] as const) {
      const palm = makePalm(h, lean, w.windUniforms, this.anim);
      palm.position.set(x, bigSandY(x, z), z);
      palm.rotation.y = x;
      root.add(palm);
    }

    // Dune grass along the back.
    const grass = makeGrass(
      1800,
      () => [(Math.random() - 0.5) * 110, -24 - Math.random() * 18],
      ['#86bf5f', '#9ccf6e', '#b0cc72'],
      0.8,
      w.windUniforms,
    );
    grass.children.forEach((m) => {
      const mesh = m as THREE.InstancedMesh;
      const tmp = new THREE.Matrix4();
      const p = new THREE.Vector3();
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, tmp);
        p.setFromMatrixPosition(tmp);
        tmp.setPosition(p.x, bigSandY(p.x, p.z), p.z);
        mesh.setMatrixAt(i, tmp);
      }
      mesh.instanceMatrix.needsUpdate = true;
    });
    root.add(grass);

    // Shells and pebbles scattered on the sand.
    {
      const shellGeo = new THREE.SphereGeometry(0.09, 8, 4, 0, TAU, 0, Math.PI / 2);
      const shells = new THREE.InstancedMesh(shellGeo, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6 }), 160);
      const tmp = new THREE.Object3D();
      const tints = ['#fff1f4', '#ffd0dc', '#fbe7c6', '#e8eef7'].map((c) => new THREE.Color(c));
      for (let i = 0; i < 160; i++) {
        const x = (Math.random() - 0.5) * 70;
        const z = -16 + Math.random() * 30;
        tmp.position.set(x, bigSandY(x, z), z);
        tmp.rotation.y = Math.random() * TAU;
        tmp.scale.set(1, 0.6, 1.3).multiplyScalar(0.7 + Math.random() * 0.8);
        tmp.updateMatrix();
        shells.setMatrixAt(i, tmp.matrix);
        shells.setColorAt(i, tints[i % tints.length]);
      }
      shells.receiveShadow = true;
      root.add(shells);
    }

    // Kites tugging on their strings over the waterline.
    [['#ff6b6b', -14], ['#5fdbab', 6], ['#b18cff', 22]].forEach(([c, x], i) => {
      const kite = new THREE.Group();
      const shape = new THREE.Shape();
      shape.moveTo(0, 0.9);
      shape.lineTo(0.6, 0);
      shape.lineTo(0, -1.2);
      shape.lineTo(-0.6, 0);
      shape.closePath();
      const sail = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat(c as string, 0.6, 0, 'double'));
      kite.add(sail);
      const tail: THREE.Mesh[] = [];
      for (let k = 0; k < 5; k++) {
        const bow = box(0.25, 0.08, 0.02, mat(k % 2 ? '#ffffff' : (c as string), 0.6));
        bow.position.y = -1.4 - k * 0.4;
        kite.add(bow);
        tail.push(bow);
      }
      const anchor = new THREE.Vector3(x as number, 0, 12);
      const string = new THREE.Line(new THREE.BufferGeometry().setFromPoints([anchor, anchor]), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.6 }));
      root.add(kite, string);
      this.anim.add((_dt, t) => {
        const wind = w.windUniforms.uWind.value;
        kite.position.set((x as number) + Math.sin(t * 0.7 + i) * 3, 14 + Math.sin(t * 1.1 + i * 2) * 2 + wind * 3, 22 + Math.cos(t * 0.5 + i) * 2);
        kite.rotation.set(0, 0, Math.sin(t * 1.3 + i) * 0.35);
        tail.forEach((b, k) => (b.position.x = Math.sin(t * 4 + k * 0.8) * 0.2 * (k + 1) * 0.4));
        string.geometry.setFromPoints([anchor, kite.position]);
      });
    });

    // Buoys bobbing offshore.
    for (const [x, z] of [[-18, 26], [0, 30], [18, 27]] as const) {
      const buoy = new THREE.Group();
      const body = ball(0.6, mat('#ff6b4a', 0.5), 14);
      const band = cyl(0.62, 0.62, 0.2, mat('#ffffff', 0.5), 14);
      buoy.add(body, band);
      root.add(buoy);
      const phase = x;
      this.anim.add((_dt, t) => {
        buoy.position.set(x, -0.2 + Math.sin(t * 1.2 + phase) * 0.15, z);
        buoy.rotation.z = Math.sin(t * 0.9 + phase) * 0.15;
      });
    }
  }
}
