/**
 * Visitors to a place. Before the shop is built, the odd sightseer wanders
 * in to look at the work (say hi for a tip). Once it is open, customers turn
 * up: on foot, or by the place's own ride (a rowboat to the pier, a balloon
 * to the island). They queue at the counter, pay when served, sit at a table
 * to eat if there is a free stool, and head home. A hired worker stands
 * behind the counter and serves them; otherwise the dog does.
 */
import * as THREE from 'three';
import type { Ferry, Site } from './site.js';
import { World } from './engine.js';
import { ThrowerRig, box, cyl, makeMarker, makePerson, mat, shadowed } from './models.js';

type Stage = 'rowing-in' | 'walking-in' | 'looking' | 'queue' | 'to-seat' | 'eating' | 'leaving' | 'rowing-out' | 'gone';

export interface Visitor {
  rig: ThrowerRig;
  stage: Stage;
  path: THREE.Vector3[];
  /** The way home, walked in reverse. */
  home: THREE.Vector3[];
  byBoat: boolean;
  /** Their ride (boat or balloon), waiting while they visit. */
  boat?: THREE.Group;
  ferry?: Ferry;
  /** Just here to look around; the shop is not open yet. */
  sightseer: boolean;
  greeted: boolean;
  timer: number;
  patience: number;
  bubble?: THREE.Sprite;
  seat?: number;
}

export interface VisitorHooks {
  /** The counter exists, so customers come (sightseers come anyway). */
  open(): boolean;
  /** What they order, shown in their bubble. */
  icon(): string;
  hasWorker(): boolean;
  /** Pays for one onigiri; `byWorker` sales go to the tip jar. */
  sold(byWorker: boolean, at: THREE.Vector3): void;
  /** Someone gave up waiting. */
  leftHungry(): void;
}

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

/** A hot-air balloon with a wicker basket; the basket floor is at y = 0. */
function makeBalloon(color: string): THREE.Group {
  const group = new THREE.Group();
  const basket = box(1.05, 0.85, 1.05, mat('#b5844f', 0.95));
  basket.position.y = 0.42;
  const rim = box(1.15, 0.1, 1.15, mat('#8a5e3c', 0.9));
  rim.position.y = 0.88;
  group.add(basket, rim);
  for (const [x, z] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
    const rope = cyl(0.015, 0.015, 2.4, mat('#5a4632', 0.9), 4);
    rope.position.set(x * 1.3, 2.05, z * 1.3);
    rope.rotation.set(z * 0.28, 0, -x * 0.28);
    group.add(rope);
  }
  const envelope = new THREE.Group();
  envelope.position.y = 4.4;
  const stripes = [color, '#fbf7ef'];
  for (let i = 0; i < 8; i++) {
    const g = new THREE.SphereGeometry(1.9, 6, 14, (i / 8) * Math.PI * 2, Math.PI / 4);
    envelope.add(new THREE.Mesh(g, mat(stripes[i % 2], 0.7)));
  }
  envelope.scale.set(1, 1.15, 1);
  const neck = cyl(0.55, 0.9, 0.7, mat(color, 0.7), 12);
  neck.position.y = 2.25;
  group.add(envelope, neck);
  return shadowed(group, true, false);
}

export class Visitors {
  private list: Visitor[] = [];
  private spawnIn = 4;
  private worker: ThrowerRig | null = null;
  private seatsTaken = new Set<number>();
  readonly root = new THREE.Group();

  constructor(private world: World, private beach: Site, private hooks: VisitorHooks) {
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
      this.worker.group.position.set(...this.beach.workerAt);
      this.worker.face(new THREE.Vector3(0, 0, 10));
      this.worker.group.rotation.y = 0;
      this.root.add(this.worker.group);
    } else if (!want && this.worker) {
      this.root.remove(this.worker.group);
      this.worker = null;
    }
  }

  private spawn(sightseer: boolean): void {
    const look = makePerson();
    const v: Visitor = {
      rig: look,
      stage: 'walking-in',
      path: [],
      home: [],
      byBoat: false,
      sightseer,
      greeted: false,
      timer: 0,
      patience: 32,
    };
    const ferry = this.beach.ferry();
    // One ride at a time, so two never park on the same spot.
    const riding = this.list.some((x) => x.boat);
    if (ferry && !riding && Math.random() < 0.6) {
      v.byBoat = true;
      v.stage = 'rowing-in';
      v.ferry = ferry;
      const colors = ['#ff9a8b', '#74c8ff', '#ffd66b', '#8fe3c0', '#c3a6f5'];
      const color = colors[Math.floor(Math.random() * colors.length)];
      let group: THREE.Group;
      if (ferry.kind === 'boat') {
        const made = makeVisitorBoat(color);
        group = made.group;
        group.userData.oars = made.oars;
        look.seated = true;
        look.group.position.set(0, 0.35, 0);
      } else {
        group = makeBalloon(color);
        look.group.position.set(0, 0.08, 0);
      }
      look.face(new THREE.Vector3(0, 0, -10));
      group.position.set(ferry.from[0] + (Math.random() - 0.5) * 6, ferry.from[1], ferry.from[2]);
      group.add(look.group);
      v.boat = group;
      this.root.add(group);
      v.home = [new THREE.Vector3(...ferry.land), ...ferry.walk.map(([x, z]) => new THREE.Vector3(x, 0, z))];
    } else {
      const routes = this.beach.walkRoutes();
      const route = routes[Math.floor(Math.random() * routes.length)];
      v.home = route.map(([x, z]) => new THREE.Vector3(x, 0, z));
      const start = v.home[0];
      look.group.position.copy(start);
      this.root.add(look.group);
      v.path = v.home.slice(1).map((p) => p.clone());
    }
    this.list.push(v);
  }

  update(dt: number, t: number): void {
    this.syncWorker();
    this.worker?.update(dt, t);
    this.spawnIn -= dt;
    const active = this.list.filter((v) => v.stage !== 'gone').length;
    if (this.hooks.open()) {
      if (this.spawnIn <= 0 && active < 5 && this.waitingCount() < 3) {
        this.spawn(false);
        this.spawnIn = 9 + Math.random() * 7;
      }
    } else if (this.spawnIn <= 0 && active < 2) {
      // Not open yet: now and then someone drops by to see how it's going.
      this.spawn(true);
      this.spawnIn = 16 + Math.random() * 12;
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
        const f = v.ferry!;
        if (this.ride(b, f, new THREE.Vector3(...f.dock), dt, t)) {
          // Climb out onto the pier (or out of the basket).
          b.remove(v.rig.group);
          v.rig.seated = false;
          v.rig.group.position.set(...f.land);
          this.root.add(v.rig.group);
          v.stage = 'walking-in';
          v.path = v.home.slice(1).map((p) => p.clone());
        }
        break;
      }
      case 'walking-in':
        if (this.walk(v, dt)) {
          if (v.sightseer) {
            // Find a place to stand and admire the work.
            v.stage = 'looking';
            v.timer = 8 + Math.random() * 5;
            const [qx, qz] = this.beach.queue[Math.floor(Math.random() * this.beach.queue.length)];
            v.path = [new THREE.Vector3(qx + (Math.random() - 0.5) * 4, 0, qz + 1 + Math.random() * 1.5)];
          } else {
            v.stage = 'queue';
            v.timer = 0;
          }
        }
        break;
      case 'looking': {
        if (!this.walk(v, dt)) break;
        v.rig.face(new THREE.Vector3(this.beach.workerAt[0], 0, this.beach.workerAt[2] - 2));
        v.timer -= dt;
        if (!v.bubble) {
          const moods = ['👀', '😍', '📸', '✨'];
          v.bubble = makeMarker(v.greeted ? '💛' : moods[Math.floor(Math.random() * moods.length)], '#ffffff');
          v.bubble.scale.multiplyScalar(0.7);
          this.root.add(v.bubble);
        }
        v.bubble.position.set(v.rig.group.position.x, v.rig.group.position.y + 2.75 + Math.sin(t * 3) * 0.06, v.rig.group.position.z);
        if (v.timer <= 0) {
          this.dropBubble(v);
          this.goHome(v);
        }
        break;
      }
      case 'queue': {
        const i = this.queueIndex(v);
        const q = this.beach.queue;
        const [qx, qz] = q[Math.min(i, q.length - 1)];
        const spot = new THREE.Vector3(qx, 0, qz);
        if (v.rig.group.position.distanceTo(spot.clone().setY(v.rig.group.position.y)) > 0.1) {
          v.path = [spot];
          this.walk(v, dt);
        } else {
          v.path = [];
          v.rig.walking = false;
          v.rig.face(new THREE.Vector3(this.beach.workerAt[0], 0, this.beach.workerAt[2]));
        }
        if (i === 0 && v.path.length === 0) {
          v.timer += dt;
          if (!v.bubble) {
            v.bubble = makeMarker(this.hooks.icon(), '#ffffff');
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
            const inBoat = v.ferry!.kind === 'boat';
            v.rig.group.position.set(0, inBoat ? 0.35 : 0.08, 0);
            v.rig.group.rotation.y = Math.PI;
            v.rig.face(new THREE.Vector3(0, 0, -10));
            v.rig.seated = inBoat;
            v.boat.add(v.rig.group);
            v.stage = 'rowing-out';
          } else {
            v.stage = 'gone';
          }
        }
        break;
      case 'rowing-out': {
        const b = v.boat!;
        const f = v.ferry!;
        if (!b.userData.away) b.userData.away = new THREE.Vector3(f.from[0] + (Math.random() - 0.5) * 8, f.from[1], f.from[2] + 6);
        if (this.ride(b, f, b.userData.away as THREE.Vector3, dt, t)) v.stage = 'gone';
        break;
      }
    }
  }

  /** Moves a ride toward `to`; true once it is there. */
  private ride(b: THREE.Group, f: Ferry, to: THREE.Vector3, dt: number, t: number): boolean {
    if (f.kind === 'boat') {
      const d3 = to.clone().sub(b.position).setY(0);
      const d = d3.length();
      if (d > 0.2) b.rotation.y = Math.atan2(d3.x, d3.z) + Math.PI;
      this.row(b, t, d > 0.2);
      b.position.addScaledVector(d3.normalize(), Math.min(d, 3.2 * dt));
      b.position.y = to.y + Math.sin(t * 1.6) * 0.05;
      return d < 0.2;
    }
    // A balloon drifts, easing down as it lands and swaying a little.
    const d3 = to.clone().sub(b.position);
    const d = d3.length();
    const speed = Math.min(3, 0.6 + d * 0.25);
    b.position.addScaledVector(d3.normalize(), Math.min(d, speed * dt));
    b.rotation.z = Math.sin(t * 0.9) * 0.04 * Math.min(1, d);
    b.rotation.x = Math.cos(t * 0.7) * 0.03 * Math.min(1, d);
    return d < 0.05;
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

  private dropBubble(v: Visitor): void {
    if (v.bubble) {
      this.root.remove(v.bubble);
      v.bubble = undefined;
    }
  }

  /** A sightseer the dog is next to, who hasn't been greeted yet. */
  nearSightseer(p: THREE.Vector3, r = 2.2): Visitor | null {
    return (
      this.list.find(
        (v) => v.sightseer && !v.greeted && (v.stage === 'looking' || v.stage === 'walking-in') && v.rig.group.position.distanceTo(p) < r,
      ) ?? null
    );
  }

  /** Say hi: they cheer, maybe tip, and stay a little longer. Returns the tip. */
  greet(v: Visitor): { coins: number; at: THREE.Vector3 } {
    v.greeted = true;
    v.rig.cheer();
    this.dropBubble(v);
    if (v.stage === 'looking') v.timer += 4;
    return { coins: 3 + Math.floor(Math.random() * 6), at: v.rig.group.position.clone().add(new THREE.Vector3(0, 2.4, 0)) };
  }

  private giveUp(v: Visitor): void {
    this.dropBubble(v);
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
  }

  /** Visitors sit on these, so they should not be counted as free. */
  seatTaken(i: number): boolean {
    return this.seatsTaken.has(i);
  }
}
