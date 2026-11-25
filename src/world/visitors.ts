/**
 * Visitors to the café. Once the counter is built, people turn up for
 * onigiri: rowing in to the pier once it is repaired, or strolling along the
 * beach before that. They queue at the counter, pay when served, sit at a
 * table to eat if there is a free stool, and head home. A hired worker
 * stands behind the counter and serves them; otherwise the dog does.
 */
import * as THREE from 'three';
import { Beach, PIER } from './beach.js';
import { World } from './engine.js';
import { ThrowerRig, box, cyl, makeMarker, makePerson, mat, shadowed } from './models.js';

type Stage = 'rowing-in' | 'walking-in' | 'queue' | 'to-seat' | 'eating' | 'leaving' | 'rowing-out' | 'gone';

interface Visitor {
  rig: ThrowerRig;
  stage: Stage;
  path: THREE.Vector3[];
  /** The way home, walked in reverse. */
  home: THREE.Vector3[];
  byBoat: boolean;
  boat?: THREE.Group;
  timer: number;
  patience: number;
  bubble?: THREE.Sprite;
  seat?: number;
}

export interface VisitorHooks {
  /** The counter exists, so people come. */
  open(): boolean;
  hasWorker(): boolean;
  /** Pays for one onigiri; `byWorker` sales go to the tip jar. */
  sold(byWorker: boolean, at: THREE.Vector3): void;
  /** Someone gave up waiting. */
  leftHungry(): void;
}

const QUEUE: [number, number][] = [
  [0, -0.55],
  [0.15, 0.6],
  [-0.15, 1.75],
];
const SPEED = 1.7;

/** Floating text above something, rising and fading. */
export function floatText(world: World, at: THREE.Vector3, text: string, color = '#ffd23f'): void {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 96;
  const g = c.getContext('2d')!;
  g.font = '900 56px ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 12;
  g.strokeStyle = '#2f3a56';
  g.strokeText(text, 128, 50);
  g.fillStyle = color;
  g.fillText(text, 128, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(m);
  sprite.scale.set(1.6, 0.6, 1);
  sprite.position.copy(at);
  sprite.renderOrder = 12;
  world.scene.add(sprite);
  let life = 1.4;
  const fn = (dt: number) => {
    life -= dt;
    sprite.position.y += dt * 0.9;
    m.opacity = Math.min(1, life);
    if (life <= 0) {
      world.scene.remove(sprite);
      tex.dispose();
      m.dispose();
      world.animators.delete(fn);
    }
  };
  world.animators.add(fn);
}

/** A little rowboat for visitors, with a pair of oars that pull. */
function makeVisitorBoat(color: string): { group: THREE.Group; oars: THREE.Object3D[] } {
  const group = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), mat(color, 0.6, 0, 'double'));
  hull.scale.set(0.75, 0.45, 1.7);
  hull.position.y = 0.25;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1, 0.05, 6, 20), mat('#fbf7ef', 0.6));
  rim.scale.set(0.75, 1.7, 1);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.25;
  group.add(hull, rim);
  const oars: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.7, 0.35, 0);
    const oar = cyl(0.03, 0.03, 1.8, mat('#c98b52', 0.8), 6);
    oar.rotation.z = (s * Math.PI) / 2 - s * 0.35;
    oar.position.x = s * 0.7;
    const blade = box(0.06, 0.04, 0.3, mat('#c98b52', 0.8));
    blade.position.set(s * 1.45, -0.35, 0);
    pivot.add(oar, blade);
    group.add(pivot);
    oars.push(pivot);
  }
  return { group: shadowed(group, true, false), oars };
}

export class Visitors {
  private list: Visitor[] = [];
  private spawnIn = 4;
  private worker: ThrowerRig | null = null;
  private seatsTaken = new Set<number>();
  readonly root = new THREE.Group();

  constructor(private world: World, private beach: Beach, private hooks: VisitorHooks) {
    world.scene.add(this.root);
  }

  dispose(): void {
    this.world.scene.remove(this.root);
    this.list = [];
    this.root.clear();
    this.worker = null;
  }

  /** The first person in line, if they are waiting to be served. */
  front(): Visitor | null {
    const v = this.list.find((x) => x.stage === 'queue' && x.path.length === 0);
    if (!v) return null;
    const q = this.queueIndex(v);
    return q === 0 ? v : null;
  }

  waitingCount(): number {
    return this.list.filter((v) => v.stage === 'queue').length;
  }

  /** The dog serves the person at the front. */
  serve(): boolean {
    const v = this.front();
    if (!v) return false;
    this.finishOrder(v, false);
    return true;
  }

  private queueIndex(v: Visitor): number {
    return this.list.filter((x) => x.stage === 'queue').indexOf(v);
  }

  /** Shows or hides the worker behind the counter. */
  private syncWorker(): void {
    const want = this.hooks.open() && this.hooks.hasWorker();
    if (want && !this.worker) {
      this.worker = makePerson({ skin: '#c98b6a', top: '#ff6b6b', bottom: '#2f3a56', hat: '#ffffff', band: '#ff6b6b' });
      // A little apron.
      const apron = box(0.5, 0.55, 0.04, mat('#ffffff', 0.7));
      apron.position.set(0, 1.05, 0.33);
      this.worker.group.add(apron);
      this.worker.group.position.set(0, 0.36, -2.85);
      this.worker.face(new THREE.Vector3(0, 0, 10));
      this.worker.group.rotation.y = 0;
      this.root.add(this.worker.group);
    } else if (!want && this.worker) {
      this.root.remove(this.worker.group);
      this.worker = null;
    }
  }

  private spawn(): void {
    const look = makePerson();
    const v: Visitor = {
      rig: look,
      stage: 'walking-in',
      path: [],
      home: [],
      byBoat: false,
      timer: 0,
      patience: 32,
    };
    const pier = this.beach.spots.some((s) => s.kind === 'pier');
    const boating = this.list.some((x) => x.byBoat && (x.stage === 'rowing-in' || x.stage === 'rowing-out'));
    if (pier && !boating && Math.random() < 0.6) {
      // Row in to the end of the pier.
      v.byBoat = true;
      v.stage = 'rowing-in';
      const colors = ['#ff9a8b', '#74c8ff', '#ffd66b', '#8fe3c0', '#c3a6f5'];
      const { group, oars } = makeVisitorBoat(colors[Math.floor(Math.random() * colors.length)]);
      group.userData.oars = oars;
      group.position.set(16 + Math.random() * 6, -0.3, 48);
      v.boat = group;
      look.seated = true;
      look.group.position.set(0, 0.35, 0);
      look.group.rotation.y = Math.PI;
      group.add(look.group);
      this.root.add(group);
      v.home = [
        new THREE.Vector3(15.1, PIER.deck, 18.6),
        new THREE.Vector3(13, PIER.deck, 18.2),
        new THREE.Vector3(13, PIER.deck, 7),
        new THREE.Vector3(13, 0, PIER.rampZ - 0.4),
        new THREE.Vector3(6, 0, 3.6),
      ];
    } else {
      const left = Math.random() < 0.5;
      const start = left ? new THREE.Vector3(-23, 0, 3.4) : new THREE.Vector3(23, 0, 3.6);
      v.home = [start, left ? new THREE.Vector3(-3.4, 0, 3.0) : new THREE.Vector3(4.2, 0, 3.4)];
      look.group.position.copy(start);
      this.root.add(look.group);
      v.path = v.home.slice(1).map((p) => p.clone());
    }
    this.list.push(v);
  }

  update(dt: number, t: number): void {
    this.syncWorker();
    this.worker?.update(dt, t);
    if (this.hooks.open()) {
      this.spawnIn -= dt;
      const active = this.list.filter((v) => v.stage !== 'gone').length;
      if (this.spawnIn <= 0 && active < 5 && this.waitingCount() < 3) {
        this.spawn();
        this.spawnIn = 9 + Math.random() * 7;
      }
    }

    for (const v of this.list) this.step(v, dt, t);
    // Drop the ones who have gone home.
    for (const v of this.list.filter((x) => x.stage === 'gone')) {
      if (v.boat) this.root.remove(v.boat);
      this.root.remove(v.rig.group);
    }
    this.list = this.list.filter((v) => v.stage !== 'gone');
  }

  private walk(v: Visitor, dt: number): boolean {
    const g = v.rig.group;
    const next = v.path[0];
    if (!next) {
      v.rig.walking = false;
      return true;
    }
    const to = new THREE.Vector3(next.x - g.position.x, 0, next.z - g.position.z);
    const d = to.length();
    v.rig.walking = true;
    v.rig.face(next);
    if (d < 0.08) {
      v.path.shift();
    } else {
      g.position.addScaledVector(to.normalize(), Math.min(d, SPEED * dt));
    }
    g.position.y = this.beach.groundAt(g.position.x, g.position.z);
    return false;
  }

  private step(v: Visitor, dt: number, t: number): void {
    v.rig.update(dt, t);
    switch (v.stage) {
      case 'rowing-in': {
        const b = v.boat!;
        const dock = new THREE.Vector3(15.1, -0.3, 18.6);
        const to = dock.clone().sub(b.position).setY(0);
        const d = to.length();
        b.rotation.y = Math.atan2(to.x, to.z) + Math.PI;
        this.row(b, t, d > 0.2);
        if (d < 0.2) {
          // Climb out onto the pier.
          b.remove(v.rig.group);
          v.rig.seated = false;
          v.rig.group.position.set(15.1, PIER.deck, 18.6);
          this.root.add(v.rig.group);
          v.stage = 'walking-in';
          v.path = v.home.slice(1).map((p) => p.clone());
        } else {
          b.position.addScaledVector(to.normalize(), Math.min(d, 3.2 * dt));
        }
        b.position.y = -0.3 + Math.sin(t * 1.6) * 0.05;
        break;
      }
      case 'walking-in':
        if (this.walk(v, dt)) {
          v.stage = 'queue';
          v.timer = 0;
        }
        break;
      case 'queue': {
        const i = this.queueIndex(v);
        const [qx, qz] = QUEUE[Math.min(i, QUEUE.length - 1)];
        const spot = new THREE.Vector3(qx, 0, qz);
        if (v.rig.group.position.distanceTo(spot.clone().setY(v.rig.group.position.y)) > 0.1) {
          v.path = [spot];
          this.walk(v, dt);
        } else {
          v.path = [];
          v.rig.walking = false;
          v.rig.face(new THREE.Vector3(0, 0, -3));
        }
        if (i === 0 && v.path.length === 0) {
          v.timer += dt;
          if (!v.bubble) {
            v.bubble = makeMarker('🍙', '#ffffff');
            v.bubble.scale.multiplyScalar(0.8);
            this.root.add(v.bubble);
          }
          v.bubble.position.set(v.rig.group.position.x, v.rig.group.position.y + 2.75 + Math.sin(t * 3) * 0.06, v.rig.group.position.z);
          // The worker serves after a moment; otherwise the dog has to.
          if (this.worker && v.timer > 2.2) this.finishOrder(v, true);
          else if (v.timer > v.patience) this.giveUp(v);
        }
        break;
      }
      case 'to-seat':
        if (this.walk(v, dt)) {
          const seat = this.beach.seats[v.seat!];
          v.rig.group.position.set(seat.x, seat.y - 0.12, seat.z);
          v.rig.group.rotation.y = seat.facing;
          v.rig.face(new THREE.Vector3(seat.x + Math.sin(seat.facing), 0, seat.z + Math.cos(seat.facing)));
          v.rig.seated = true;
          v.stage = 'eating';
          v.timer = 8 + Math.random() * 6;
        }
        break;
      case 'eating':
        v.timer -= dt;
        if (v.timer <= 0) {
          v.rig.seated = false;
          if (v.seat !== undefined) this.seatsTaken.delete(v.seat);
          this.goHome(v);
        }
        break;
      case 'leaving':
        if (this.walk(v, dt)) {
          if (v.byBoat && v.boat) {
            this.root.remove(v.rig.group);
            v.rig.group.position.set(0, 0.35, 0);
            v.rig.group.rotation.y = Math.PI;
            v.rig.seated = true;
            v.boat.add(v.rig.group);
            v.stage = 'rowing-out';
          } else {
            v.stage = 'gone';
          }
        }
        break;
      case 'rowing-out': {
        const b = v.boat!;
        const away = new THREE.Vector3(b.position.x + 4, 0, 60).sub(b.position).setY(0);
        b.rotation.y = Math.atan2(away.x, away.z) + Math.PI;
        this.row(b, t, true);
        b.position.addScaledVector(away.normalize(), 3.2 * dt);
        b.position.y = -0.3 + Math.sin(t * 1.6) * 0.05;
        if (b.position.z > 55) v.stage = 'gone';
        break;
      }
    }
  }

  private row(boat: THREE.Group, t: number, moving: boolean): void {
    const oars = boat.userData.oars as THREE.Object3D[];
    oars.forEach((o, i) => {
      o.rotation.y = moving ? Math.sin(t * 4) * 0.5 * (i ? -1 : 1) : 0;
      o.rotation.x = moving ? Math.cos(t * 4) * 0.2 : 0;
    });
  }

  private finishOrder(v: Visitor, byWorker: boolean): void {
    if (v.bubble) {
      this.root.remove(v.bubble);
      v.bubble = undefined;
    }
    const at = v.rig.group.position.clone().add(new THREE.Vector3(0, 2.4, 0));
    this.hooks.sold(byWorker, at);
    v.rig.cheer();
    // An onigiri in hand.
    const rice = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.16, 3), mat('#ffffff', 0.8));
    rice.rotation.set(Math.PI / 2, 0, Math.PI / 6);
    rice.position.set(0.3, 1.25, 0.25);
    const nori = box(0.1, 0.06, 0.02, mat('#1f2a22', 0.6));
    nori.position.set(0, -0.04, 0.07);
    rice.add(nori);
    v.rig.group.add(rice);
    // Sit and eat if a stool is free.
    const free = this.beach.seats.findIndex((_, i) => !this.seatsTaken.has(i));
    if (free >= 0) {
      this.seatsTaken.add(free);
      v.seat = free;
      const seat = this.beach.seats[free];
      v.stage = 'to-seat';
      v.path = [new THREE.Vector3(seat.x * 0.5, 0, 1.6), new THREE.Vector3(seat.x, 0, seat.z)];
    } else {
      this.goHome(v);
    }
  }

  private giveUp(v: Visitor): void {
    if (v.bubble) {
      this.root.remove(v.bubble);
      v.bubble = undefined;
    }
    const sad = makeMarker('😞', '#e3eaf2');
    sad.scale.multiplyScalar(0.7);
    sad.position.copy(v.rig.group.position).add(new THREE.Vector3(0, 2.7, 0));
    this.root.add(sad);
    window.setTimeout(() => this.root.remove(sad), 2000);
    v.rig.shrug();
    this.hooks.leftHungry();
    this.goHome(v);
  }

  private goHome(v: Visitor): void {
    v.stage = 'leaving';
    v.path = v.home
      .slice()
      .reverse()
      .map((p) => p.clone());
    // Walk from wherever they are; the last point is their arrival spot.
    if (v.byBoat) v.path.unshift(new THREE.Vector3(6, 0, 3.6));
  }

  /** Visitors sit on these, so they should not be counted as free. */
  seatTaken(i: number): boolean {
    return this.seatsTaken.has(i);
  }
}
