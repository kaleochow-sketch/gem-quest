/**
 * The 3D world: renderer, sky with a full day/night cycle, sun and moon,
 * wind, the dog you walk around as, and a third-person camera you can orbit
 * and zoom. Places (the café) and minigames plug in as "modes" that add
 * their own objects, HUD and tap handling.
 */
import * as THREE from 'three';
import { makeDog, DogRig, Footprints } from './models.js';

/**
 * A location in the 3D world (the café beach, the big fetch beach). Only
 * the active place is in the scene and only its animations run.
 */
export interface Place {
  readonly root: THREE.Group;
  readonly anim: Set<(dt: number, t: number) => void>;
  readonly walkables: THREE.Object3D[];
  groundAt(x: number, z: number): number;
  /** Keeps a point inside the walkable area and sets its height. */
  clamp(p: THREE.Vector3): void;
  /** Sand colours for paw prints: fresh and smoothed over. */
  readonly prints?: [string, string];
}

export interface WorldMode {
  enter(world: World): void;
  exit(): void;
  update(dt: number, t: number): void;
  /** A tap that was not a drag. `hit` is the first thing under the finger. */
  tap?(hit: THREE.Intersection | null): void;
  /** Swipe gestures, for modes that want them instead of camera orbit. */
  swipe?(dx: number, dy: number, ms: number): boolean;
  /** Modes that drive the camera themselves return true. */
  ownsCamera?: boolean;
  /**
   * How the player moves the dog: 'half' puts the touch joystick on the left
   * half (the right half looks around), 'full' uses the whole screen, 'none'
   * turns direct control off. Keys (WASD / arrows) work in both.
   */
  controls?: 'half' | 'full' | 'none';
  /** Space or the jump button. */
  onJump?(): void;
}

interface SkyKey {
  at: number;
  top: THREE.Color;
  horizon: THREE.Color;
  sun: THREE.Color;
  sunPower: number;
  ambient: number;
}

const key = (at: number, top: string, horizon: string, sun: string, sunPower: number, ambient: number): SkyKey => ({
  at,
  top: new THREE.Color(top),
  horizon: new THREE.Color(horizon),
  sun: new THREE.Color(sun),
  sunPower,
  ambient,
});

/** Sky colours through the day; time runs 0 (midnight) to 1. */
const SKY: SkyKey[] = [
  key(0.0, '#0a1330', '#1c2a55', '#8fa8ff', 0.0, 0.28),
  key(0.21, '#1a2557', '#4a3f78', '#8fa8ff', 0.0, 0.3),
  key(0.26, '#4c79c9', '#ffb38a', '#ffb070', 0.7, 0.45),
  key(0.33, '#5fb0ff', '#ffe3c4', '#ffe3b8', 1.6, 0.6),
  key(0.5, '#3f9cf5', '#cfeaff', '#fff6e6', 2.4, 0.75),
  key(0.67, '#5d9de6', '#ffe0bf', '#ffd9a8', 1.7, 0.62),
  key(0.74, '#5b6fc0', '#ff9a6a', '#ff8a4c', 0.8, 0.45),
  key(0.79, '#243066', '#8a5a86', '#ff8a4c', 0.08, 0.32),
  key(1.0, '#0a1330', '#1c2a55', '#8fa8ff', 0.0, 0.28),
];

/** Seconds for one full day. */
const DAY_SECONDS = 360;

export const TAU = Math.PI * 2;

export class World {
  readonly root: HTMLElement;
  readonly hud: HTMLElement;
  readonly topbar: HTMLElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 600);

  readonly sun = new THREE.DirectionalLight('#ffffff', 2);
  readonly moon = new THREE.DirectionalLight('#8fa8ff', 0.0);
  readonly hemi = new THREE.HemisphereLight('#cfe8ff', '#e6d3a8', 0.6);
  private skyMat: THREE.ShaderMaterial;
  private stars: THREE.Points;

  /** 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset. */
  time = 0.36;
  /** Shared with every wind-driven shader. */
  readonly windUniforms = { uTime: { value: 0 }, uWind: { value: 0.6 } };
  /** 0 by day, 1 at full night; lamps read this. */
  night = 0;

  readonly dog: DogRig;
  /** Things the dog may walk on. */
  walkables: THREE.Object3D[] = [];
  /** Things with `userData.onTap`. */
  tappables: THREE.Object3D[] = [];
  /** Per-frame callbacks registered by scenery (waves, swaying, glows). */
  readonly animators = new Set<(dt: number, t: number) => void>();
  /** Keeps the dog on the sand and out of buildings. */
  bounds: (p: THREE.Vector3) => void = () => {};

  private mode: WorldMode | null = null;
  place: Place | null = null;
  private keys = new Set<string>();
  private stick = { id: -1, active: false, ox: 0, oy: 0, x: 0, y: 0 };
  private stickEl!: HTMLElement;
  readonly prints = new Footprints();
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envTime = -1;
  private raf = 0;
  private last = 0;
  private elapsed = 0;
  private raycaster = new THREE.Raycaster();

  // Orbit camera.
  yaw = -0.35;
  pitch = 0.42;
  dist = 11;
  readonly focus = new THREE.Vector3();
  private pointers = new Map<number, { x: number; y: number; sx: number; sy: number; t: number }>();
  private pinchStart = 0;
  private dragged = false;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'world-overlay';
    this.root.innerHTML = `
      <canvas class="world-canvas"></canvas>
      <div class="world-top"></div>
      <div class="world-hud"></div>
      <div class="joystick" hidden><i></i></div>`;
    document.body.appendChild(this.root);
    const canvas = this.root.querySelector('canvas')!;
    this.topbar = this.root.querySelector('.world-top')!;
    this.hud = this.root.querySelector('.world-hud')!;
    this.stickEl = this.root.querySelector('.joystick')!;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene.fog = new THREE.Fog('#cfeaff', 60, 240);

    // Sky dome with a sun glow, coloured from the SKY keys every frame.
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color() },
        horizon: { value: new THREE.Color() },
        sunDir: { value: new THREE.Vector3() },
        sunColor: { value: new THREE.Color() },
        sunVis: { value: 1 },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunColor; uniform float sunVis;
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, -0.1, 1.0);
          vec3 col = mix(horizon, top, pow(max(h, 0.0), 0.55));
          float d = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
          col += sunColor * (pow(d, 600.0) * 2.5 + pow(d, 12.0) * 0.35) * sunVis;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), this.skyMat);
    this.scene.add(sky);
    // A copy of the sky lights every material with reflections of the real
    // sky: blue at noon, gold at sunset, dark at night.
    this.envScene.add(new THREE.Mesh(sky.geometry, this.skyMat));
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    // Stars that fade in after dusk.
    const starGeo = new THREE.BufferGeometry();
    const pts: number[] = [];
    for (let i = 0; i < 700; i++) {
      const u = Math.random() * TAU;
      const v = Math.acos(Math.random() * 0.95);
      const r = 380;
      pts.push(Math.sin(v) * Math.cos(u) * r, Math.cos(v) * r, Math.sin(v) * Math.sin(u) * r);
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: '#ffffff', size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }),
    );
    this.scene.add(this.stars);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1536, 1536);
    const sc = this.sun.shadow.camera;
    sc.left = -34;
    sc.right = 34;
    sc.top = 34;
    sc.bottom = -34;
    sc.near = 1;
    sc.far = 160;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target, this.moon, this.moon.target, this.hemi);

    this.dog = makeDog();
    this.scene.add(this.dog.group);
    this.scene.add(this.prints.mesh);
    this.dog.onStep = (side) => {
      const p = this.dog.group.position;
      if (!this.place?.prints) return;
      // Only on sand above the waterline.
      if (this.place.groundAt(p.x, p.z) < -0.3) return;
      this.prints.add(p.x, p.y - this.dog.hop, p.z, this.dog.group.rotation.y, side);
    };
    window.addEventListener('keydown', (e) => this.key(e, true));
    window.addEventListener('keyup', (e) => this.key(e, false));
    window.addEventListener('blur', () => this.keys.clear());

    this.bindInput(canvas);
    window.addEventListener('resize', () => this.resize());
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  open(mode: WorldMode): void {
    this.setMode(mode);
    this.root.dataset.open = 'true';
    // The 2D scenery behind is fully covered; let it rest.
    document.body.classList.add('in-3d');
    this.resize();
    if (!this.raf) {
      this.last = performance.now();
      const loop = (now: number) => {
        this.raf = requestAnimationFrame(loop);
        const dt = Math.min(0.05, (now - this.last) / 1000);
        this.last = now;
        this.step(dt);
      };
      this.raf = requestAnimationFrame(loop);
    }
  }

  setMode(mode: WorldMode): void {
    this.mode?.exit();
    this.hud.innerHTML = '';
    this.topbar.innerHTML = '';
    this.mode = mode;
    mode.enter(this);
  }

  /** Shows a place; only one is in the scene at a time. */
  setPlace(place: Place): void {
    if (this.place === place) return;
    if (this.place) this.scene.remove(this.place.root);
    this.place = place;
    this.scene.add(place.root);
    this.walkables = place.walkables;
    this.bounds = (p) => place.clamp(p);
    this.prints.clear();
    const [fresh, faded] = place.prints ?? ['#c9a970', '#ecd6a4'];
    this.prints.setColors(fresh, faded);
  }

  close(): void {
    this.mode?.exit();
    this.mode = null;
    this.keys.clear();
    this.stick = { id: -1, active: false, ox: 0, oy: 0, x: 0, y: 0 };
    this.showStick(false);
    this.dog.steer(null);
    this.root.dataset.open = 'false';
    document.body.classList.remove('in-3d');
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  get isOpen(): boolean {
    return this.root.dataset.open === 'true';
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Portrait phones need a wider vertical view to see enough of the beach.
    this.camera.fov = w < h ? 62 : 50;
    this.camera.updateProjectionMatrix();
  }

  /** Skips to the next part of the day: morning, noon, sunset, night. */
  advanceTime(): string {
    const marks: [number, string][] = [[0.3, 'Morning'], [0.5, 'Noon'], [0.73, 'Sunset'], [0.95, 'Night']];
    const next = marks.find(([at]) => at > this.time + 0.02) ?? marks[0];
    this.time = next[0];
    return next[1];
  }

  /* ---------------------------------------------------------------- *
   * Frame
   * ---------------------------------------------------------------- */

  private step(dt: number): void {
    this.elapsed += dt;
    const t = this.elapsed;
    this.time = (this.time + dt / DAY_SECONDS) % 1;
    // Wind comes in gusts.
    const wind = 0.45 + 0.35 * Math.sin(t * 0.13) + 0.2 * Math.sin(t * 0.47 + 1.3) + 0.1 * Math.sin(t * 1.7);
    this.windUniforms.uTime.value = t;
    this.windUniforms.uWind.value = wind;
    this.updateSky();

    this.applyControls();
    this.dog.update(dt, t);
    this.bounds(this.dog.group.position);
    this.dog.group.position.y += this.dog.hop;
    this.prints.update(dt);
    if (this.place) for (const fn of this.place.anim) fn(dt, t);
    for (const fn of this.animators) fn(dt, t);
    this.mode?.update(dt, t);
    if (!this.mode?.ownsCamera) this.followCamera(dt);
    this.renderer.render(this.scene, this.camera);
  }

  private updateSky(): void {
    let i = 0;
    while (i < SKY.length - 2 && SKY[i + 1].at <= this.time) i++;
    const a = SKY[i];
    const b = SKY[i + 1];
    const f = THREE.MathUtils.clamp((this.time - a.at) / (b.at - a.at), 0, 1);
    const top = a.top.clone().lerp(b.top, f);
    const horizon = a.horizon.clone().lerp(b.horizon, f);
    const sunColor = a.sun.clone().lerp(b.sun, f);
    const power = THREE.MathUtils.lerp(a.sunPower, b.sunPower, f);
    const ambient = THREE.MathUtils.lerp(a.ambient, b.ambient, f);

    const angle = (this.time - 0.25) * TAU;
    const dir = new THREE.Vector3(Math.cos(angle) * 0.8, Math.sin(angle), 0.45).normalize();
    this.skyMat.uniforms.top.value.copy(top);
    this.skyMat.uniforms.horizon.value.copy(horizon);
    this.skyMat.uniforms.sunDir.value.copy(dir);
    this.skyMat.uniforms.sunColor.value.copy(sunColor);
    this.skyMat.uniforms.sunVis.value = THREE.MathUtils.clamp(dir.y * 6 + 0.3, 0, 1);

    const centre = this.dog.group.position;
    this.sun.position.copy(centre).addScaledVector(dir, 80);
    this.sun.target.position.copy(centre);
    this.sun.color.copy(sunColor);
    this.sun.intensity = dir.y > -0.02 ? power : 0;
    this.sun.castShadow = power > 0.05;

    const moonDir = dir.clone().negate();
    this.moon.position.copy(centre).addScaledVector(moonDir, 80);
    this.moon.target.position.copy(centre);
    this.night = THREE.MathUtils.clamp(1 - power / 0.6, 0, 1);
    this.moon.intensity = this.night * 0.45;

    this.hemi.intensity = ambient;
    this.hemi.color.copy(top).lerp(new THREE.Color('#ffffff'), 0.5);
    (this.stars.material as THREE.PointsMaterial).opacity = this.night * 0.9;
    (this.scene.fog as THREE.Fog).color.copy(horizon);
    this.renderer.toneMappingExposure = 1.0 + this.night * 0.25;

    // Re-light reflections as the sky changes (not every frame: it is a
    // cube render plus filtering).
    if (Math.abs(this.time - this.envTime) > 0.004 || !this.envTarget) {
      this.envTime = this.time;
      this.envTarget?.dispose();
      this.envTarget = this.pmrem.fromScene(this.envScene, 0, 1, 1000);
      this.scene.environment = this.envTarget.texture;
      // Reflections add realism, but too much washes pale sand out to white.
      this.scene.environmentIntensity = 0.12 + (1 - this.night) * 0.2;
    }
  }

  /* ---------------------------------------------------------------- *
   * Direct control: WASD / arrows, the touch joystick, and jumping
   * ---------------------------------------------------------------- */

  private key(e: KeyboardEvent, down: boolean): void {
    if (!this.isOpen) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const k = e.key.toLowerCase();
    const map: Record<string, string> = { w: 'f', arrowup: 'f', s: 'b', arrowdown: 'b', a: 'l', arrowleft: 'l', d: 'r', arrowright: 'r' };
    if (k === ' ' || k === 'spacebar') {
      if (down && !e.repeat) this.jump();
      e.preventDefault();
      return;
    }
    const dir = map[k];
    if (!dir) return;
    e.preventDefault();
    if (down) this.keys.add(dir);
    else this.keys.delete(dir);
  }

  /** Makes the dog hop, and tells the mode (catching uses it). */
  jump(): void {
    if (this.mode?.controls === 'none') return;
    if (this.dog.jump()) this.mode?.onJump?.();
  }

  /** Turns keys and the joystick into a ground direction relative to the camera. */
  private applyControls(): void {
    const mode = this.mode?.controls ?? 'none';
    if (mode === 'none') return;
    let fx = 0;
    let fy = 0;
    if (this.keys.has('f')) fy += 1;
    if (this.keys.has('b')) fy -= 1;
    if (this.keys.has('r')) fx += 1;
    if (this.keys.has('l')) fx -= 1;
    if (this.stick.active) {
      fx += this.stick.x;
      fy += this.stick.y;
    }
    const len = Math.hypot(fx, fy);
    if (len < 0.05) {
      if (this.steering) this.dog.steer(null);
      this.steering = false;
      return;
    }
    const scale = Math.min(1, len) / len;
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    const dir = forward.multiplyScalar(fy * scale).add(right.multiplyScalar(fx * scale));
    this.dog.steer(dir);
    this.steering = true;
  }

  private steering = false;

  private showStick(on: boolean): void {
    this.stickEl.hidden = !on;
    if (!on) return;
    this.stickEl.style.left = `${this.stick.ox}px`;
    this.stickEl.style.top = `${this.stick.oy}px`;
    const knob = this.stickEl.firstElementChild as HTMLElement;
    knob.style.transform = `translate(${this.stick.x * 38}px, ${-this.stick.y * 38}px)`;
  }

  private followCamera(dt: number): void {
    const target = this.dog.group.position.clone().add(new THREE.Vector3(0, 1.2, 0));
    this.focus.lerp(target, 1 - Math.pow(0.002, dt));
    const offset = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    ).multiplyScalar(this.dist);
    this.camera.position.copy(this.focus).add(offset);
    this.camera.position.y = Math.max(this.camera.position.y, 1.2);
    this.camera.lookAt(this.focus);
  }

  /* ---------------------------------------------------------------- *
   * Input: drag to orbit, pinch or wheel to zoom, tap to act
   * ---------------------------------------------------------------- */

  private bindInput(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() });
      this.dragged = false;
      if (this.pointers.size === 2 && !this.stick.active) this.pinchStart = this.pinchDistance();
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      // Touch joystick: a finger dragged on the stick side moves the dog.
      const controls = this.mode?.controls ?? 'none';
      const stickSide = controls === 'full' || (controls === 'half' && p.sx < window.innerWidth * 0.5);
      const isTouch = e.pointerType !== 'mouse' || controls === 'full';
      if (controls !== 'none' && stickSide && isTouch && (this.stick.id === e.pointerId || !this.stick.active)) {
        const dist = Math.hypot(e.clientX - p.sx, e.clientY - p.sy);
        if (this.stick.active || dist > 10) {
          if (!this.stick.active) {
            this.stick.active = true;
            this.stick.id = e.pointerId;
            this.stick.ox = p.sx;
            this.stick.oy = p.sy;
          }
          const dx = e.clientX - this.stick.ox;
          const dy = e.clientY - this.stick.oy;
          const r = Math.min(1, Math.hypot(dx, dy) / 46);
          const a = Math.atan2(-dy, dx);
          this.stick.x = Math.cos(a) * r;
          this.stick.y = Math.sin(a) * r;
          this.dragged = true;
          p.x = e.clientX;
          p.y = e.clientY;
          this.showStick(true);
          return;
        }
      }
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 8) this.dragged = true;
      if (this.pointers.size === 2) {
        const d = this.pinchDistance();
        if (this.pinchStart > 0) this.dist = THREE.MathUtils.clamp(this.dist * (this.pinchStart / d), 5, 22);
        this.pinchStart = d;
        return;
      }
      if (this.dragged && !this.mode?.swipe && !this.mode?.ownsCamera) {
        this.yaw -= dx * 0.006;
        this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, 0.12, 1.2);
      }
    });
    const end = (e: PointerEvent) => {
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (this.stick.id === e.pointerId) {
        this.stick = { id: -1, active: false, ox: 0, oy: 0, x: 0, y: 0 };
        this.showStick(false);
        return;
      }
      if (!p || this.pointers.size) return;
      const dx = e.clientX - p.sx;
      const dy = e.clientY - p.sy;
      if (this.dragged) {
        this.mode?.swipe?.(dx, dy, performance.now() - p.t);
        return;
      }
      this.handleTap(e.clientX, e.clientY);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', (e) => {
      this.pointers.delete(e.pointerId);
      if (this.stick.id === e.pointerId) {
        this.stick = { id: -1, active: false, ox: 0, oy: 0, x: 0, y: 0 };
        this.showStick(false);
      }
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.dist = THREE.MathUtils.clamp(this.dist * (1 + e.deltaY * 0.001), 5, 22);
      },
      { passive: false },
    );
  }

  private pinchDistance(): number {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** Raycasts from a screen point. */
  pick(clientX: number, clientY: number, targets: THREE.Object3D[]): THREE.Intersection | null {
    const ndc = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.intersectObjects(targets, true)[0] ?? null;
  }

  private handleTap(x: number, y: number): void {
    const hit = this.pick(x, y, [...this.tappables, ...this.walkables]);
    if (hit) {
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        if (typeof o.userData.onTap === 'function') {
          o.userData.onTap(hit);
          return;
        }
        o = o.parent;
      }
    }
    this.mode?.tap?.(hit);
  }
}
