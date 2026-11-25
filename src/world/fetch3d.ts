/**
 * Fetch on the big beach. A friend throws the ball; you run the dog (WASD,
 * arrows, or the touch joystick) to where it will land and catch it, then
 * bring it back.
 *
 * Scoring is only paid on delivery, because that is the fetch:
 *   air catch 100 · jumping catch 150 · picked up off the sand 40
 *   × streak for clean catches in a row (up to ×3)
 *   + a quick-return bonus.
 * Throws get longer and lower as the round goes on. 75 seconds.
 */
import * as THREE from 'three';
import { audio } from '../audio/audio.js';
import { BigBeach, PLAY, bigSandY } from './bigbeach.js';
import { World, WorldMode } from './engine.js';
import { ThrowerRig, ball, burst, makeThrower, mat, shadowed } from './models.js';

export interface FetchResult {
  points: number;
  /** Clean catches before the ball touched the sand. */
  catches: number;
  /** Catches made mid-jump. */
  bullseyes: number;
}

const ROUND_SECONDS = 75;
const THROWER = new THREE.Vector3(-22, 0, -3);
const GRAVITY = 9.8;

type Phase = 'windup' | 'flying' | 'loose' | 'carry' | 'over';

export class FetchMode implements WorldMode {
  readonly ownsCamera = true;
  readonly controls = 'full' as const;
  private world!: World;
  private props = new THREE.Group();
  private thrower!: ThrowerRig;
  private ballMesh!: THREE.Group;
  private shadow!: THREE.Mesh;
  private ring!: THREE.Mesh;
  private ringMat!: THREE.MeshBasicMaterial;
  private pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private landing = new THREE.Vector3();
  private flightTime = 1;
  private flightT = 0;
  private looseT = 0;
  private phase: Phase = 'windup';
  private timeLeft = ROUND_SECONDS;
  private throws = 0;
  private streak = 0;
  private pending = 0;
  private caughtAt = 0;
  private clock = 0;
  private timers: number[] = [];
  private result: FetchResult = { points: 0, catches: 0, bullseyes: 0 };
  private camLook = new THREE.Vector3();

  constructor(private beach: BigBeach, private finish: (r: FetchResult) => void) {}

  enter(world: World): void {
    this.world = world;
    world.setPlace(this.beach);
    world.tappables = [];
    if (world.night > 0.3) world.time = 0.4;

    this.thrower = makeThrower();
    this.thrower.group.position.set(THROWER.x, bigSandY(THROWER.x, THROWER.z), THROWER.z);
    this.thrower.face(new THREE.Vector3(0, 0, 0));
    this.props.add(this.thrower.group);

    this.ballMesh = new THREE.Group();
    const core = ball(0.15, mat('#d7f24a', 1), 16);
    const seam = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.013, 6, 24), mat('#ffffff', 0.8));
    seam.rotation.x = 0.6;
    this.ballMesh.add(core, seam);
    shadowed(this.ballMesh, true, false);
    this.props.add(this.ballMesh);

    // A soft shadow under the ball helps judge where it is.
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.22, 16),
      new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.25, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.props.add(this.shadow);

    // The landing ring: where the ball will come down.
    this.ringMat = new THREE.MeshBasicMaterial({ color: '#ffd23f', transparent: true, opacity: 0.85, depthWrite: false });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 1, 32), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.props.add(this.ring);

    world.scene.add(this.props);

    const dog = world.dog;
    dog.stop();
    dog.steer(null);
    dog.speed = 7.5;
    dog.group.position.set(THROWER.x + 3, 0, THROWER.z + 1.5);
    dog.face(new THREE.Vector3(0, 0, 0));
    this.camLook.copy(dog.group.position);
    world.camera.position.set(THROWER.x - 13, 10, THROWER.z);

    world.topbar.innerHTML = `
      <div class="world-title center">
        <strong>🎾 Fetch!</strong>
        <small><span id="f-time">${ROUND_SECONDS}</span>s · <b id="f-score">0</b> pts · streak <b id="f-streak">0</b></small>
      </div>`;
    world.hud.innerHTML = `
      <div class="fetch3d-pop" id="f-pop"></div>
      <div class="fetch-carry" id="f-carry" hidden>Bring it back! 🐾</div>
      <div class="world-hint big" id="f-hint">Run with WASD / arrows, or drag anywhere like a joystick · Space or ⤴ to jump · catch it before it lands!</div>
      <button class="jump-btn" id="f-jump" type="button" aria-label="Jump">⤴</button>`;
    world.root.querySelector<HTMLElement>('#f-jump')!.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      world.jump();
    });
    this.later(6500, () => world.root.querySelector('#f-hint')?.classList.add('fade'));
    this.nextThrow(1.6);
  }

  exit(): void {
    for (const id of this.timers) clearTimeout(id);
    this.timers = [];
    this.world.scene.remove(this.props);
    this.props.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.world.dog.carry(null);
    this.world.dog.speed = 4;
  }

  onJump(): void {
    audio.sfx('swap');
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(window.setTimeout(fn, ms));
  }

  /* ---------------------------------------------------------------- *
   * Throwing
   * ---------------------------------------------------------------- */

  private nextThrow(delay: number): void {
    this.phase = 'windup';
    this.ballMesh.visible = false;
    this.ring.visible = false;
    this.shadow.visible = false;
    this.later(delay * 1000, () => {
      if (this.phase !== 'windup' || this.timeLeft <= 0) return;
      // Later throws go further and lower, so they are harder to get under.
      const k = Math.min(1, this.throws / 10);
      const dist = 11 + Math.random() * (8 + k * 16);
      const angle = (Math.random() - 0.5) * (1.1 + k * 0.5);
      const land = new THREE.Vector3(THROWER.x + Math.cos(angle) * dist, 0, THROWER.z + Math.sin(angle) * dist * 1.1);
      land.x = THREE.MathUtils.clamp(land.x, PLAY.x0 + 3, PLAY.x1 - 3);
      land.z = THREE.MathUtils.clamp(land.z, PLAY.z0 + 3, PLAY.z1 - 2.5);
      land.y = bigSandY(land.x, land.z) + 0.15;
      this.thrower.face(land);
      this.thrower.throwBall(() => this.launch(land, 1.9 - k * 0.45 + Math.random() * 0.35 + dist * 0.02));
    });
  }

  private launch(land: THREE.Vector3, time: number): void {
    if (this.phase !== 'windup') return;
    const from = this.thrower.hand();
    this.pos.copy(from);
    this.landing.copy(land);
    this.flightTime = time;
    this.flightT = 0;
    this.vel.set(
      (land.x - from.x) / time,
      (land.y - from.y + 0.5 * GRAVITY * time * time) / time,
      (land.z - from.z) / time,
    );
    this.ballMesh.visible = true;
    this.shadow.visible = true;
    this.ring.visible = true;
    this.ring.position.set(land.x, land.y - 0.12, land.z);
    this.phase = 'flying';
    this.throws++;
    audio.sfx('scoot');
  }

  /* ---------------------------------------------------------------- *
   * Frame
   * ---------------------------------------------------------------- */

  update(dt: number, t: number): void {
    const dog = this.world.dog;
    this.thrower.update(dt, t);
    this.clock += dt;
    if (this.phase !== 'over') {
      this.timeLeft = Math.max(0, this.timeLeft - dt);
      const el = this.world.root.querySelector('#f-time');
      if (el) el.textContent = String(Math.ceil(this.timeLeft));
      if (this.timeLeft <= 0) this.end();
    }

    if (this.phase === 'flying') {
      this.flightT += dt;
      this.vel.y -= GRAVITY * dt;
      this.pos.addScaledVector(this.vel, dt);
      const ground = bigSandY(this.pos.x, this.pos.z) + 0.15;
      // The ring tightens as the ball comes down.
      const left = Math.max(0, 1 - this.flightT / this.flightTime);
      const s = 0.8 + left * 1.6;
      this.ring.scale.set(s, s, s);
      this.ringMat.opacity = 0.55 + Math.sin(t * 12) * 0.25;
      if (this.flightT > 0.15 && this.tryCatch(true)) return;
      if (this.pos.y <= ground && this.vel.y < 0) {
        this.pos.y = ground;
        this.vel.y *= -0.45;
        this.vel.x *= 0.6;
        this.vel.z *= 0.6;
        this.phase = 'loose';
        this.looseT = 0;
        this.ring.visible = false;
        burst(this.world.scene, this.world.animators, this.pos.clone(), '#f7ecd0', 10, 1.6);
        audio.sfx('tap');
      }
    } else if (this.phase === 'loose') {
      // Bouncing, then rolling to a stop.
      this.looseT += dt;
      this.vel.y -= GRAVITY * dt;
      this.pos.addScaledVector(this.vel, dt);
      const ground = bigSandY(this.pos.x, this.pos.z) + 0.15;
      if (this.pos.y <= ground) {
        this.pos.y = ground;
        if (Math.abs(this.vel.y) > 1) {
          this.vel.y *= -0.4;
        } else {
          this.vel.y = 0;
          this.vel.x *= Math.max(0, 1 - dt * 2.2);
          this.vel.z *= Math.max(0, 1 - dt * 2.2);
        }
      }
      if (this.tryCatch(false)) return;
      if (this.looseT > 6 || this.pos.z > PLAY.z1 + 1) this.missed();
    } else if (this.phase === 'carry') {
      const d = Math.hypot(dog.group.position.x - THROWER.x, dog.group.position.z - THROWER.z);
      this.thrower.face(dog.group.position);
      if (d < 2.4) this.deliver();
    }

    if (this.ballMesh.visible) {
      this.ballMesh.position.copy(this.pos);
      this.ballMesh.rotation.x += this.vel.length() * dt * 2.5;
      const g = bigSandY(this.pos.x, this.pos.z);
      this.shadow.position.set(this.pos.x, g + 0.02, this.pos.z);
      const h = Math.max(0, this.pos.y - g);
      this.shadow.scale.setScalar(1 + h * 0.08);
      (this.shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.08, 0.3 - h * 0.02);
    }
    this.driveCamera(dt);
  }

  /** Is the dog's mouth where the ball is? */
  private tryCatch(inAir: boolean): boolean {
    const dog = this.world.dog;
    const dx = dog.group.position.x - this.pos.x;
    const dz = dog.group.position.z - this.pos.z;
    const ground = bigSandY(dog.group.position.x, dog.group.position.z);
    const above = this.pos.y - ground;
    const reach = 1.25 + dog.hop;
    if (Math.hypot(dx, dz) > 0.95 || above > reach || above < -0.2) return false;

    const jumping = dog.hop > 0.25;
    let points: number;
    let label: string;
    if (inAir) {
      this.streak++;
      this.result.catches++;
      if (jumping) this.result.bullseyes++;
      points = jumping ? 150 : 100;
      label = jumping ? 'Leaping catch!' : 'Great catch!';
      audio.sfx(jumping ? 'rainbow' : 'special');
      burst(this.world.scene, this.world.animators, this.pos.clone(), '#ffe27a', 26, 3.5);
      this.thrower.cheer();
    } else {
      this.streak = 0;
      points = 40;
      label = 'Got it!';
      audio.sfx('match');
    }
    const mult = inAir ? Math.min(3, 1 + (this.streak - 1) * 0.5) : 1;
    this.pending = Math.round(points * mult);
    this.popText(`${mult > 1 ? `${label} ×${mult}` : label} Bring it back!`, inAir);
    this.caughtAt = this.clock;

    this.phase = 'carry';
    this.ring.visible = false;
    this.shadow.visible = false;
    this.ballMesh.visible = false;
    const carried = this.ballMesh.clone();
    carried.visible = true;
    carried.position.set(0, 0, 0);
    dog.carry(carried);
    this.world.root.querySelector('#f-carry')?.removeAttribute('hidden');
    this.updateHud();
    return true;
  }

  private deliver(): void {
    const quick = Math.max(0, Math.round(30 - (this.clock - this.caughtAt) * 6));
    const total = this.pending + quick;
    this.result.points += total;
    this.popText(quick > 0 ? `+${total} (+${quick} quick return!)` : `+${total}`, total >= 150);
    audio.sfx('coin');
    this.world.dog.carry(null);
    this.world.root.querySelector('#f-carry')?.setAttribute('hidden', '');
    this.pending = 0;
    this.updateHud();
    this.nextThrow(0.6);
  }

  private missed(): void {
    this.streak = 0;
    this.thrower.shrug();
    this.popText('Too slow! Next one…');
    audio.sfx('invalid');
    this.updateHud();
    this.nextThrow(0.9);
  }

  private end(): void {
    this.phase = 'over';
    this.ring.visible = false;
    this.ballMesh.visible = false;
    this.shadow.visible = false;
    this.world.dog.steer(null);
    this.world.root.querySelector('#f-carry')?.setAttribute('hidden', '');
    this.popText(`Time! ${this.result.points} points`, true);
    this.later(1600, () => this.finish(this.result));
  }

  private updateHud(): void {
    const s = this.world.root.querySelector('#f-score');
    if (s) s.textContent = String(this.result.points);
    const k = this.world.root.querySelector('#f-streak');
    if (k) k.textContent = String(this.streak);
  }

  private popText(text: string, big = false): void {
    const el = this.world.root.querySelector<HTMLElement>('#f-pop');
    if (!el) return;
    el.textContent = text;
    el.className = `fetch3d-pop show${big ? ' big' : ''}`;
    this.later(1500, () => el.classList.remove('show'));
  }

  /**
   * A chase camera behind the thrower's line, looking down the beach the way
   * the ball flies: throws sail away up the screen, the sea is on the left,
   * and "forward" (W, or pushing the stick up) runs after the ball. Pulled
   * back far enough to see both the dog and where the ball will land.
   */
  private driveCamera(dt: number): void {
    const dog = this.world.dog.group.position;
    const cam = this.world.camera;
    let focus = dog.clone();
    if (this.phase === 'flying') focus = dog.clone().lerp(this.landing, 0.45);
    else if (this.phase === 'carry') focus = dog.clone().lerp(THROWER, 0.35);
    else if (this.phase === 'windup') focus = dog.clone().lerp(THROWER, 0.25);
    const want = new THREE.Vector3(focus.x - 13, 10, focus.z);
    const k = 1 - Math.pow(0.03, dt);
    cam.position.lerp(want, k);
    this.camLook.lerp(focus.clone().add(new THREE.Vector3(5, 0, 0)), k);
    cam.lookAt(this.camLook);
  }
}
