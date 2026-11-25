/**
 * Dig for Treasure, on the beach. Tap a sand mound and the dog runs over and
 * digs it up: coins, an item, a rare treasure for the café, or a bone (which
 * ends the dig while the dog has a chew). Six digs.
 */
import * as THREE from 'three';
import { audio } from '../audio/audio.js';
import { Beach, sandY } from './beach.js';
import { World, WorldMode } from './engine.js';
import { ball, box, burst, cyl, mat, popIn, shadowed } from './models.js';

export type DigFind =
  | { kind: 'coins'; amount: number }
  | { kind: 'item'; id: string; icon: string; name: string }
  | { kind: 'rare'; id: string; icon: string; name: string }
  | { kind: 'bone' }
  | { kind: 'sand' };

export interface DigSetup {
  field: DigFind[];
  digs: number;
}

const CENTRE = new THREE.Vector3(12, 0, -3);
const GAP = 1.45;

export class DigMode implements WorldMode {
  readonly ownsCamera = true;
  /** Digging is tap-driven: tap a mound and the dog goes to it. */
  readonly controls = 'none' as const;
  private world!: World;
  private props = new THREE.Group();
  private mounds: THREE.Object3D[] = [];
  private dug = new Set<number>();
  private digsLeft: number;
  private over = false;
  private busy = false;
  private found: DigFind[] = [];

  constructor(
    private beach: Beach,
    private setup: DigSetup,
    private finish: (found: DigFind[], endedOnBone: boolean) => void,
  ) {
    this.digsLeft = setup.digs;
  }

  private spot(i: number): THREE.Vector3 {
    const x = CENTRE.x + ((i % 5) - 2) * GAP;
    const z = CENTRE.z + (Math.floor(i / 5) - 2) * GAP;
    return new THREE.Vector3(x, sandY(x, z), z);
  }

  enter(world: World): void {
    this.world = world;
    // Games are played in daylight; the café keeps its own clock otherwise.
    if (world.night > 0.3) world.time = 0.38;
    world.tappables = [];
    world.bounds = (p) => this.beach.clamp(p);
    const sandMat = mat('#f0d29a', 1);
    for (let i = 0; i < 25; i++) {
      const at = this.spot(i);
      const mound = new THREE.Group();
      const heap = ball(0.5, sandMat, 14);
      heap.scale.set(1, 0.42, 1);
      mound.add(heap);
      // A little shell or pebble on some, so the field looks natural.
      if (i % 3 === 0) {
        const shell = ball(0.1, mat(i % 2 ? '#ffd0dc' : '#fbf7ef', 0.5), 8);
        shell.scale.y = 0.5;
        shell.position.set(0.15, 0.2, 0.1);
        mound.add(shell);
      }
      mound.position.copy(at);
      mound.userData.onTap = () => this.dig(i);
      shadowed(mound, true, true);
      this.props.add(mound);
      this.mounds.push(mound);
    }
    world.scene.add(this.props);
    world.tappables = this.mounds;

    const dog = world.dog;
    dog.stop();
    dog.speed = 5;
    dog.group.position.set(CENTRE.x - 0.4, 0, CENTRE.z + 3.9);

    world.topbar.innerHTML = `<div class="world-title center"><strong>🦴 Dig for Treasure</strong><small id="d-status"></small></div>`;
    world.hud.innerHTML = `
      <div class="fetch3d-pop" id="d-pop"></div>
      <div class="world-hint big" id="d-hint">Tap a sand mound to dig. Watch out for bones!</div>`;
    this.status();
  }

  exit(): void {
    this.world.scene.remove(this.props);
    this.props.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
  }

  private status(): void {
    const coins = this.found.reduce((s, f) => s + (f.kind === 'coins' ? f.amount : 0), 0);
    const el = this.world.root.querySelector('#d-status');
    if (el) el.textContent = `Digs left ${this.digsLeft} · ${coins} coins found`;
  }

  private popText(text: string, big = false): void {
    const el = this.world.root.querySelector<HTMLElement>('#d-pop');
    if (!el) return;
    el.textContent = text;
    el.className = `fetch3d-pop show${big ? ' big' : ''}`;
    window.setTimeout(() => el.classList.remove('show'), 1600);
  }

  private dig(i: number): void {
    if (this.over || this.busy || this.dug.has(i)) return;
    this.busy = true;
    this.world.root.querySelector('#d-hint')?.classList.add('fade');
    const at = this.spot(i);
    const dog = this.world.dog;
    audio.sfx('tap');
    // Stand just in front of the mound, facing it.
    const stand = at.clone().add(new THREE.Vector3(0, 0, 0.85));
    dog.goTo(stand, () => {
      // Arrived from wherever; turn to face the mound before digging.
      dog.face(at);
      dog.dig(1.1);
      audio.sfx('scoot');
      const sand = () => burst(this.world.scene, this.world.animators, at.clone().add(new THREE.Vector3(0, 0.2, 0)), '#e8cf98', 14, 2.6);
      sand();
      window.setTimeout(sand, 350);
      window.setTimeout(sand, 700);
      window.setTimeout(() => this.reveal(i), 1100);
    });
  }

  private reveal(i: number): void {
    const at = this.spot(i);
    this.dug.add(i);
    this.digsLeft--;
    const find = this.setup.field[i];
    const mound = this.mounds[i];
    mound.clear();
    const hole = new THREE.Mesh(new THREE.CircleGeometry(0.45, 20), mat('#a8834f', 1));
    hole.rotation.x = -Math.PI / 2;
    hole.position.y = 0.03;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.12, 6, 20), mat('#f0d29a', 1));
    rim.rotation.x = Math.PI / 2;
    rim.scale.z = 0.6;
    rim.position.y = 0.05;
    mound.add(hole, rim);
    mound.userData.onTap = undefined;

    const prize = this.prizeModel(find);
    if (prize) {
      prize.position.set(0, 0.35, 0);
      mound.add(prize);
      popIn(prize, this.world.animators);
      const spin = (dt: number) => {
        if (!prize.parent) {
          this.world.animators.delete(spin);
          return;
        }
        prize.rotation.y += dt * 1.5;
      };
      this.world.animators.add(spin);
    }
    this.found.push(find);
    let ended = false;
    switch (find.kind) {
      case 'coins':
        this.popText(`+${find.amount} coins!`);
        audio.sfx('coin');
        burst(this.world.scene, this.world.animators, at.clone().add(new THREE.Vector3(0, 0.6, 0)), '#ffd23f', 18, 3);
        break;
      case 'item':
        this.popText(`${find.icon} ${find.name}!`);
        audio.sfx('special');
        break;
      case 'rare':
        this.popText(`✨ ${find.icon} ${find.name}! It’s going in the café!`, true);
        audio.sfx('rainbow');
        burst(this.world.scene, this.world.animators, at.clone().add(new THREE.Vector3(0, 0.8, 0)), '#ffe27a', 40, 4.5);
        break;
      case 'bone':
        this.popText('A bone! The dog stops to chew it…', true);
        audio.sfx('crate');
        ended = true;
        break;
      default:
        this.popText('Just sand.');
    }
    this.status();
    this.busy = false;
    if (ended || this.digsLeft <= 0) {
      this.over = true;
      if (ended) this.world.dog.dig(2.4);
      window.setTimeout(() => this.finish(this.found, ended), 2200);
    }
  }

  private prizeModel(find: DigFind): THREE.Object3D | null {
    const g = new THREE.Group();
    const gold = mat('#ffcf4a', 0.25, 0.85);
    switch (find.kind) {
      case 'coins':
        for (let k = 0; k < 4; k++) {
          const coin = cyl(0.18, 0.18, 0.06, gold, 18);
          coin.position.set((k % 2) * 0.08, k * 0.07, 0);
          g.add(coin);
        }
        break;
      case 'item': {
        const gift = box(0.4, 0.4, 0.4, mat('#74c8ff', 0.6));
        const ribbon1 = box(0.42, 0.42, 0.08, mat('#ff5a6e', 0.5));
        const ribbon2 = box(0.08, 0.42, 0.42, mat('#ff5a6e', 0.5));
        const bow = ball(0.09, mat('#ff5a6e', 0.5), 8);
        bow.position.y = 0.24;
        g.add(gift, ribbon1, ribbon2, bow);
        break;
      }
      case 'rare': {
        const chest = box(0.5, 0.32, 0.36, mat('#9a5f35', 0.8));
        const band = box(0.52, 0.06, 0.38, gold);
        band.position.y = 0.06;
        const glowBall = ball(0.18, new THREE.MeshStandardMaterial({ color: '#fff3a8', emissive: new THREE.Color('#ffd23f'), emissiveIntensity: 1.4 }), 12);
        glowBall.position.y = 0.32;
        g.add(chest, band, glowBall);
        break;
      }
      case 'bone': {
        const shaft = cyl(0.06, 0.06, 0.55, mat('#fbf7ef', 0.6), 8);
        shaft.rotation.z = Math.PI / 2;
        g.add(shaft);
        for (const s of [-1, 1]) for (const d of [-1, 1]) {
          const knob = ball(0.08, mat('#fbf7ef', 0.6), 8);
          knob.position.set(s * 0.28, d * 0.06, 0);
          g.add(knob);
        }
        break;
      }
      default:
        return null;
    }
    return shadowed(g, true, false);
  }

  update(dt: number): void {
    const cam = this.world.camera;
    const want = new THREE.Vector3(CENTRE.x - 1.5, 8.5, CENTRE.z + 8.5);
    cam.position.lerp(want, 1 - Math.pow(0.05, dt));
    cam.lookAt(CENTRE.x - 0.4, 0, CENTRE.z + 0.4);
  }
}
