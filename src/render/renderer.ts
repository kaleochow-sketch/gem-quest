import { audio } from '../audio/audio.js';
import { Board } from '../engine/board.js';
import { Blocker, BlockerKind, Gem, GemKind, Pos, Special, Step } from '../engine/types.js';

/**
 * Gem palette. Each colour also gets its own silhouette, so the board stays
 * readable without relying on hue alone.
 */
export const GEM_COLORS = ['#e5372f', '#2f3e6b', '#43a047', '#1e88e5', '#8e24aa', '#ec407a', '#00bcd4'];
const GEM_LIGHT = ['#ff8b7d', '#6d7fb8', '#8ee6a0', '#8ec9ff', '#d79cf0', '#ffa3c9', '#7ef0ff'];
const GEM_DEEP = ['#8e1109', '#141a33', '#1b5e20', '#0d47a1', '#4a148c', '#ad1457', '#00707d'];

/** Plural names, used so collect goals read as objects rather than colours. */
export const GEM_NAMES = [
  'flags',
  'dogs',
  'tennis balls',
  'onigiri',
  'sewing machines',
  'yarn balls',
  'paws',
];

interface Sprite {
  id: number;
  gem: Gem;
  r: number;
  c: number;
  /** Visual position in grid units; equals (c, r) at rest. */
  x: number;
  y: number;
  scale: number;
  alpha: number;
  spin: number;
  bornAt: number;
  /** Time the gem last landed, used for the squash-on-impact bounce. */
  landedAt: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  /** Four-point sparkles read better than dots for the bigger bursts. */
  star: boolean;
  spin: number;
}

interface Floater {
  x: number;
  y: number;
  text: string;
  life: number;
  color: string;
  size: number;
}

interface Shockwave {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  life: number;
  color: string;
  width: number;
}

/** The dog dragging his rear along a row or column to wipe it out. */
interface Scoot {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** 1 -> 0 over the sweep. */
  life: number;
  vertical: boolean;
  color: string;
  /** Last shove index that played a scrape, so each shove sounds once. */
  shove: number;
}

/** A patch of brown he leaves behind; the tile under it goes when it fades. */
interface Smear {
  x: number;
  y: number;
  size: number;
  life: number;
  seed: number;
}

interface Beam {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  life: number;
  color: string;
}

interface Banner {
  text: string;
  sub: string;
  life: number;
}

interface ActiveStep {
  step: Step;
  elapsed: number;
  duration: number;
  dying: Sprite[];
  from: Map<number, { x: number; y: number }>;
  to: Map<number, { x: number; y: number }>;
  /**
   * Normalised time at which each dying sprite should pop, so a rocket's
   * row empties as the dog reaches it rather than all at once.
   */
  wipeAt: Map<number, number>;
  /** Furniture changes held back until the dog has passed over them. */
  pending: { at: number; done: boolean; apply: () => void }[];
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2);
const easeInQuad = (t: number) => t * t;
const easeInOutQuad = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** How long the dog takes to cross the board, in seconds. */
const SCOOT_SECONDS = 2.6;
/** How long his brown streak lingers on a tile before it clears. */
const BROWN_SECONDS = 1.05;
/** Number of shoves in one crossing. */
const SCOOT_SHOVES = 6;
/** Fraction of each shove spent moving; the rest is the pause after it. */
const SHOVE_PUSH = 0.55;

/**
 * Start-stop travel: a real dog shoves forward, stops, shoves again. Progress
 * advances during the first `SHOVE_PUSH` of each shove and holds still for the
 * remainder.
 */
function shuffleEase(t: number): number {
  const seg = 1 / SCOOT_SHOVES;
  const i = Math.min(SCOOT_SHOVES - 1, Math.floor(t / seg));
  const local = Math.min(1, (t - i * seg) / seg / SHOVE_PUSH);
  return (i + easeInOutQuad(local)) / SCOOT_SHOVES;
}

/** Inverse of `shuffleEase`: when does he reach a point `p` along the path? */
function shuffleArrival(p: number): number {
  const clamped = Math.max(0, Math.min(1, p));
  const i = Math.min(SCOOT_SHOVES - 1, Math.floor(clamped * SCOOT_SHOVES));
  const frac = Math.min(1, clamped * SCOOT_SHOVES - i);
  const push = frac < 0.5 ? Math.sqrt(frac / 2) : 1 - Math.sqrt((1 - frac) / 2);
  return (i + push * SHOVE_PUSH) / SCOOT_SHOVES;
}

const COMBO_WORDS = ['', '', 'Nice!', 'Sweet!', 'Tasty!', 'Delicious!', 'Divine!'];

/** Draws the board and replays engine step timelines as animation. */
export class GameRenderer {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private board!: Board;

  private sprites = new Map<number, Sprite>();
  private particles: Particle[] = [];
  private floaters: Floater[] = [];
  private shockwaves: Shockwave[] = [];
  private beams: Beam[] = [];
  private scoots: Scoot[] = [];
  private smears: Smear[] = [];
  /** Cached full-size scoot sprite, rebuilt whenever the cell size changes. */
  private scootSprite: HTMLCanvasElement | null = null;
  private banner: Banner | null = null;

  private queue: Step[] = [];
  private active: ActiveStep | null = null;

  /** Renderer-side copies of board furniture, updated as steps replay. */
  private jelly: number[] = [];
  private blockers: (Blocker | null)[] = [];
  private locked: boolean[] = [];

  /** Gems are pre-rendered once per size so each frame is a cheap blit. */
  private gemCache = new Map<string, HTMLCanvasElement>();
  /** Tray and cell wells never change between layouts, so they are painted once. */
  private staticLayer: HTMLCanvasElement | null = null;
  private jellyCache = new Map<number, HTMLCanvasElement>();
  private blockerCache = new Map<string, HTMLCanvasElement>();

  private cell = 40;
  private originX = 0;
  private originY = 0;
  private dpr = 1;
  private time = 0;
  private shake = 0;
  private nextSparkle = 0;
  private resizeObserver: ResizeObserver | null = null;

  /** Draws a frame-rate readout, switched on with the dev tools. */
  showFps = false;
  private frameMs = 16.7;
  /**
   * Drops decoration when frames get expensive. Set from the settings toggle,
   * and turned on automatically if the device cannot keep up.
   */
  lowFx = false;
  private autoLowFx = false;
  private slowFrames = 0;
  /** Particles are the one thing that can grow without bound. */
  private maxParticles = 220;

  selection: Pos | null = null;
  hint: { a: Pos; b: Pos } | null = null;
  targeting = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;

    // The canvas stretches to its flex box, which changes as the HUD, goal row
    // and power bar fill in. Without this the backing store keeps a stale
    // aspect ratio and the cells render non-square.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.board) this.layout();
      });
      this.resizeObserver.observe(canvas);
    }
  }

  setBoard(board: Board): void {
    this.board = board;
    this.sprites.clear();
    this.particles = [];
    this.floaters = [];
    this.shockwaves = [];
    this.beams = [];
    this.scoots = [];
    this.smears = [];
    this.banner = null;
    this.queue = [];
    this.active = null;
    this.selection = null;
    this.hint = null;
    this.shake = 0;

    this.jelly = board.cells.map((c) => c.jelly);
    this.blockers = board.cells.map((c) => (c.blocker ? { ...c.blocker } : null));
    this.locked = board.cells.map((c) => c.locked);

    for (let r = 0; r < board.height; r++) {
      for (let c = 0; c < board.width; c++) {
        const gem = board.gemAt(r, c);
        if (gem) this.addSprite(gem, r, c, -1);
      }
    }
    this.layout();
  }

  private addSprite(gem: Gem, r: number, c: number, bornAt: number): Sprite {
    const sprite: Sprite = {
      id: gem.id,
      gem,
      r,
      c,
      x: c,
      y: r,
      scale: 1,
      alpha: 1,
      spin: 0,
      bornAt,
      landedAt: -1,
    };
    this.sprites.set(gem.id, sprite);
    return sprite;
  }

  private spriteAt(r: number, c: number): Sprite | null {
    for (const sprite of this.sprites.values()) {
      if (sprite.r === r && sprite.c === c) return sprite;
    }
    return null;
  }

  /* ---------------------------------------------------------------- *
   * Layout and hit testing
   * ---------------------------------------------------------------- */

  layout(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);

    const pad = 3;
    this.cell = Math.floor(
      Math.min((rect.width - pad * 2) / this.board.width, (rect.height - pad * 2) / this.board.height),
    );
    this.originX = (rect.width - this.cell * this.board.width) / 2;
    this.originY = (rect.height - this.cell * this.board.height) / 2;
    // Cached art is size-specific.
    this.gemCache.clear();
    this.jellyCache.clear();
    this.blockerCache.clear();
    this.scootSprite = null;
    this.staticLayer = null;
  }

  cellAt(clientX: number, clientY: number): Pos | null {
    const rect = this.canvas.getBoundingClientRect();
    const c = Math.floor((clientX - rect.left - this.originX) / this.cell);
    const r = Math.floor((clientY - rect.top - this.originY) / this.cell);
    if (!this.board.inBounds(r, c) || this.board.at(r, c)!.hole) return null;
    return { r, c };
  }

  /* ---------------------------------------------------------------- *
   * Pre-rendered gem art
   * ---------------------------------------------------------------- */

  private gemImage(gem: Gem): HTMLCanvasElement {
    const key = `${gem.kind}:${gem.color}:${gem.special}`;
    let img = this.gemCache.get(key);
    if (!img) {
      img = this.renderGemSprite(gem);
      this.gemCache.set(key, img);
    }
    return img;
  }

  /** Draws one gem into its own canvas: shadow, coloured tile, then its icon. */
  private renderGemSprite(gem: Gem): HTMLCanvasElement {
    const side = Math.max(8, Math.ceil(this.cell * 1.3 * this.dpr));
    const sprite = document.createElement('canvas');
    sprite.width = side;
    sprite.height = side;
    const g = sprite.getContext('2d')!;
    g.translate(side / 2, side / 2);

    const radius = this.cell * 0.4 * this.dpr;

    if (gem.kind === GemKind.Ingredient) {
      this.paintIngredient(g, radius);
      return sprite;
    }
    if (gem.special === Special.Rainbow) {
      this.paintRainbow(g, radius);
      return sprite;
    }

    const idx = gem.color % GEM_COLORS.length;
    this.paintTile(g, idx, radius);
    this.paintIcon(g, idx, radius);
    if (gem.special !== Special.None) this.paintSpecialMark(g, gem.special, radius);
    return sprite;
  }

  /**
   * The coloured plate every icon sits on. Three of the icons are mostly
   * white, so the plate — not the artwork — is what keeps the colours
   * separable at a glance.
   */
  private paintTile(g: CanvasRenderingContext2D, idx: number, radius: number): void {
    const mid = GEM_COLORS[idx];
    const light = GEM_LIGHT[idx];
    const deep = GEM_DEEP[idx];

    g.save();
    g.globalAlpha = 0.4;
    g.fillStyle = '#000';
    g.filter = `blur(${Math.max(1, radius * 0.14)}px)`;
    g.beginPath();
    g.ellipse(0, radius * 0.44, radius * 0.84, radius * 0.32, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();

    const body = g.createLinearGradient(-radius, -radius, radius * 0.6, radius);
    body.addColorStop(0, light);
    body.addColorStop(0.45, mid);
    body.addColorStop(1, deep);
    g.fillStyle = body;
    this.tilePath(g, radius);
    g.fill();

    g.save();
    g.globalAlpha = 0.42;
    const sheen = g.createLinearGradient(0, -radius, 0, 0);
    sheen.addColorStop(0, 'rgba(255,255,255,0.95)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sheen;
    this.tilePath(g, radius * 0.94);
    g.fill();
    g.restore();

    g.strokeStyle = 'rgba(10,5,20,0.5)';
    g.lineWidth = Math.max(1.2, radius * 0.09);
    this.tilePath(g, radius);
    g.stroke();
  }

  private tilePath(g: CanvasRenderingContext2D, radius: number): void {
    const r = radius * 0.98;
    const c = r * 0.42;
    g.beginPath();
    g.moveTo(-r + c, -r);
    g.arcTo(r, -r, r, r, c);
    g.arcTo(r, r, -r, r, c);
    g.arcTo(-r, r, -r, -r, c);
    g.arcTo(-r, -r, r, -r, c);
    g.closePath();
  }

  /** Each colour gets its own object, drawn at roughly 70% of the tile. */
  private paintIcon(g: CanvasRenderingContext2D, idx: number, radius: number): void {
    g.save();
    const u = radius * 0.72;
    switch (idx) {
      case 0:
        this.paintJapanFlag(g, u);
        break;
      case 1:
        this.paintDogFace(g, u);
        break;
      case 2:
        this.paintTennisBall(g, u);
        break;
      case 3:
        this.paintOnigiri(g, u);
        break;
      case 4:
        this.paintSewingMachine(g, u);
        break;
      case 5:
        this.paintYarn(g, u);
        break;
      default:
        this.paintPaw(g, u);
        break;
    }
    g.restore();
  }

  private paintJapanFlag(g: CanvasRenderingContext2D, u: number): void {
    const w = u * 1.25;
    const h = u * 0.86;
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.4)';
    g.shadowBlur = u * 0.16;
    g.shadowOffsetY = u * 0.06;
    g.fillStyle = '#fdfdfd';
    g.beginPath();
    // A gentle wave along the bottom edge so it reads as cloth.
    g.moveTo(-w / 2, -h / 2);
    g.lineTo(w / 2, -h / 2);
    g.lineTo(w / 2, h / 2);
    g.quadraticCurveTo(w / 6, h / 2 - u * 0.16, -w / 6, h / 2);
    g.quadraticCurveTo(-w / 3, h / 2 + u * 0.1, -w / 2, h / 2);
    g.closePath();
    g.fill();
    g.restore();

    g.fillStyle = '#bc002d';
    g.beginPath();
    g.arc(0, 0, h * 0.32, 0, Math.PI * 2);
    g.fill();

    g.strokeStyle = 'rgba(90,90,110,0.5)';
    g.lineWidth = Math.max(1, u * 0.06);
    g.strokeRect(-w / 2, -h / 2, w, h);
  }

  /** A cluster of overlapping puffs, filled as one shape, so the edge reads
   *  as fur rather than a smooth ellipse. */
  private fluff(
    g: CanvasRenderingContext2D,
    puffs: [number, number, number][],
    grow = 1,
  ): void {
    g.beginPath();
    for (const [px, py, pr] of puffs) {
      g.moveTo(px + pr * grow, py);
      g.arc(px, py, pr * grow, 0, Math.PI * 2);
    }
    g.closePath();
  }

  private paintDogFace(g: CanvasRenderingContext2D, u: number): void {
    // Ears: shorter than before and built from puffs so they look fluffy.
    const earPuffs: [number, number, number][] = [
      [0, -u * 0.16, u * 0.25],
      [-u * 0.04, u * 0.06, u * 0.27],
      [u * 0.02, u * 0.26, u * 0.22],
      [0, u * 0.4, u * 0.16],
    ];
    for (const sx of [-1, 1]) {
      g.save();
      g.translate(sx * u * 0.66, u * 0.12);
      g.rotate(sx * 0.1);
      g.scale(sx, 1);

      g.fillStyle = 'rgba(74, 44, 14, 0.55)';
      this.fluff(g, earPuffs, 1.1);
      g.fill();

      const ear = g.createLinearGradient(0, -u * 0.45, 0, u * 0.6);
      ear.addColorStop(0, '#eec08e');
      ear.addColorStop(0.55, '#c98d52');
      ear.addColorStop(1, '#9c6733');
      g.fillStyle = ear;
      this.fluff(g, earPuffs, 1);
      g.fill();
      g.restore();
    }

    const head = g.createRadialGradient(-u * 0.22, -u * 0.3, u * 0.1, 0, 0, u);
    head.addColorStop(0, '#ffffff');
    head.addColorStop(0.65, '#f9f4ea');
    head.addColorStop(1, '#e6d2b6');
    g.fillStyle = head;
    g.beginPath();
    g.ellipse(0, 0, u * 0.82, u * 0.76, 0, 0, Math.PI * 2);
    g.fill();

    // Muzzle.
    g.fillStyle = '#fffdf9';
    g.beginPath();
    g.ellipse(0, u * 0.3, u * 0.46, u * 0.33, 0, 0, Math.PI * 2);
    g.fill();

    g.fillStyle = '#241d1a';
    for (const sx of [-1, 1]) {
      g.beginPath();
      g.ellipse(sx * u * 0.3, -u * 0.18, u * 0.11, u * 0.14, 0, 0, Math.PI * 2);
      g.fill();
    }
    // Nose.
    g.beginPath();
    g.moveTo(-u * 0.15, u * 0.1);
    g.lineTo(u * 0.15, u * 0.1);
    g.lineTo(0, u * 0.28);
    g.closePath();
    g.fill();

    // Smile: the two arcs that make a dog muzzle read as happy.
    g.strokeStyle = '#241d1a';
    g.lineWidth = Math.max(1, u * 0.075);
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(0, u * 0.28);
    g.lineTo(0, u * 0.4);
    g.stroke();
    g.beginPath();
    g.arc(-u * 0.15, u * 0.38, u * 0.16, 0.05 * Math.PI, 0.95 * Math.PI);
    g.stroke();
    g.beginPath();
    g.arc(u * 0.15, u * 0.38, u * 0.16, 0.05 * Math.PI, 0.95 * Math.PI);
    g.stroke();

    // Eye glints.
    g.fillStyle = 'rgba(255,255,255,0.95)';
    for (const sx of [-1, 1]) {
      g.beginPath();
      g.arc(sx * u * 0.26, -u * 0.23, u * 0.04, 0, Math.PI * 2);
      g.fill();
    }
  }

  private paintTennisBall(g: CanvasRenderingContext2D, u: number): void {
    const R = u * 0.88;

    const ball = g.createRadialGradient(-u * 0.3, -u * 0.34, u * 0.08, 0, 0, R * 1.05);
    ball.addColorStop(0, '#f6ff9c');
    ball.addColorStop(0.5, '#dced52');
    ball.addColorStop(0.85, '#b7cf33');
    ball.addColorStop(1, '#8ba31f');
    g.fillStyle = ball;
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.fill();

    // Felt fuzz: a soft rim so it does not read as flat plastic.
    g.save();
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.clip();
    g.globalAlpha = 0.28;
    g.strokeStyle = '#f2ffa8';
    g.lineWidth = Math.max(0.8, u * 0.05);
    for (let i = 0; i < 26; i++) {
      const a = (Math.PI * 2 * i) / 26;
      g.beginPath();
      g.moveTo(Math.cos(a) * R * 0.9, Math.sin(a) * R * 0.9);
      g.lineTo(Math.cos(a) * R * 1.06, Math.sin(a) * R * 1.06);
      g.stroke();
    }
    g.restore();

    // The two seams: each bows inward from one edge, which is what gives a
    // tennis ball its shape rather than the X two crossing arcs produce.
    g.save();
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.clip();
    g.lineCap = 'round';

    for (const sx of [-1, 1]) {
      g.strokeStyle = 'rgba(120,140,20,0.45)';
      g.lineWidth = Math.max(1.6, u * 0.19);
      g.beginPath();
      g.moveTo(sx * R * 1.02, -R * 1.02);
      g.bezierCurveTo(sx * R * 0.1, -R * 0.5, sx * R * 0.1, R * 0.5, sx * R * 1.02, R * 1.02);
      g.stroke();

      g.strokeStyle = '#fffef2';
      g.lineWidth = Math.max(1.2, u * 0.13);
      g.beginPath();
      g.moveTo(sx * R * 1.02, -R * 1.02);
      g.bezierCurveTo(sx * R * 0.12, -R * 0.5, sx * R * 0.12, R * 0.5, sx * R * 1.02, R * 1.02);
      g.stroke();
    }
    g.restore();

    g.strokeStyle = 'rgba(70,84,10,0.55)';
    g.lineWidth = Math.max(1, u * 0.06);
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.stroke();

    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.beginPath();
    g.ellipse(-u * 0.32, -u * 0.38, u * 0.22, u * 0.13, -0.6, 0, Math.PI * 2);
    g.fill();
  }

  private paintOnigiri(g: CanvasRenderingContext2D, u: number): void {
    const rice = g.createLinearGradient(0, -u, 0, u);
    rice.addColorStop(0, '#ffffff');
    rice.addColorStop(1, '#e8e2d4');
    g.fillStyle = rice;
    // Rounded triangle.
    const R = u * 0.9;
    const k = u * 0.3;
    g.beginPath();
    g.moveTo(0, -R);
    g.quadraticCurveTo(k * 0.6, -R + k * 0.2, R * 0.86, R * 0.62);
    g.quadraticCurveTo(R * 0.9, R * 0.9, R * 0.5, R * 0.9);
    g.lineTo(-R * 0.5, R * 0.9);
    g.quadraticCurveTo(-R * 0.9, R * 0.9, -R * 0.86, R * 0.62);
    g.quadraticCurveTo(-k * 0.6, -R + k * 0.2, 0, -R);
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(120,110,90,0.45)';
    g.lineWidth = Math.max(1, u * 0.06);
    g.stroke();

    // Nori band across the base.
    g.save();
    g.beginPath();
    g.rect(-R * 0.62, R * 0.16, R * 1.24, R * 0.74);
    g.clip();
    g.fillStyle = '#22303a';
    g.fillRect(-R, R * 0.16, R * 2, R);
    g.restore();

    g.fillStyle = '#241d1a';
    for (const sx of [-1, 1]) {
      g.beginPath();
      g.ellipse(sx * u * 0.26, -u * 0.06, u * 0.07, u * 0.1, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = '#241d1a';
    g.lineWidth = Math.max(1, u * 0.06);
    g.lineCap = 'round';
    g.beginPath();
    g.arc(0, u * 0.02, u * 0.14, 0.15 * Math.PI, 0.85 * Math.PI);
    g.stroke();
  }

  private paintSewingMachine(g: CanvasRenderingContext2D, u: number): void {
    g.save();
    g.translate(0, u * 0.1);
    const shell = g.createLinearGradient(0, -u * 0.8, 0, u * 0.7);
    shell.addColorStop(0, '#ffffff');
    shell.addColorStop(1, '#c9c9d6');
    g.fillStyle = shell;
    g.strokeStyle = 'rgba(30,20,50,0.55)';
    g.lineWidth = Math.max(1, u * 0.07);

    // Base.
    g.beginPath();
    g.roundRect(-u * 0.95, u * 0.42, u * 1.9, u * 0.34, u * 0.12);
    g.fill();
    g.stroke();

    // Upright column on the right.
    g.beginPath();
    g.roundRect(u * 0.36, -u * 0.72, u * 0.56, u * 1.16, u * 0.16);
    g.fill();
    g.stroke();

    // Arm reaching left over the needle.
    g.beginPath();
    g.roundRect(-u * 0.92, -u * 0.78, u * 1.5, u * 0.42, u * 0.16);
    g.fill();
    g.stroke();

    // Needle bar and needle.
    g.beginPath();
    g.roundRect(-u * 0.82, -u * 0.36, u * 0.24, u * 0.3, u * 0.06);
    g.fill();
    g.stroke();
    g.strokeStyle = '#3a3550';
    g.lineWidth = Math.max(1, u * 0.06);
    g.beginPath();
    g.moveTo(-u * 0.7, -u * 0.06);
    g.lineTo(-u * 0.7, u * 0.34);
    g.stroke();

    // Handwheel.
    g.fillStyle = '#8e7bd6';
    g.beginPath();
    g.arc(u * 0.64, -u * 0.1, u * 0.2, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(30,20,50,0.55)';
    g.lineWidth = Math.max(1, u * 0.06);
    g.stroke();

    // Thread spool on top.
    g.fillStyle = '#ff8fbf';
    g.beginPath();
    g.roundRect(-u * 0.1, -u * 1.06, u * 0.3, u * 0.3, u * 0.05);
    g.fill();
    g.stroke();
    g.restore();
  }

  private paintYarn(g: CanvasRenderingContext2D, u: number): void {
    const ball = g.createRadialGradient(-u * 0.26, -u * 0.3, u * 0.08, 0, 0, u * 0.9);
    ball.addColorStop(0, '#fff1e0');
    ball.addColorStop(0.55, '#ffd0a8');
    ball.addColorStop(1, '#d98a5a');
    g.fillStyle = ball;
    g.beginPath();
    g.arc(0, 0, u * 0.85, 0, Math.PI * 2);
    g.fill();

    g.save();
    g.beginPath();
    g.arc(0, 0, u * 0.85, 0, Math.PI * 2);
    g.clip();
    g.strokeStyle = 'rgba(150,80,40,0.55)';
    g.lineWidth = Math.max(1, u * 0.09);
    for (let i = -2; i <= 2; i++) {
      g.beginPath();
      g.ellipse(0, 0, u * 0.85, u * 0.34, i * 0.6, 0, Math.PI * 2);
      g.stroke();
    }
    g.restore();

    // Loose thread tail.
    g.strokeStyle = '#ffd0a8';
    g.lineWidth = Math.max(1, u * 0.09);
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(u * 0.7, u * 0.5);
    g.quadraticCurveTo(u * 1.1, u * 0.75, u * 0.82, u * 0.98);
    g.stroke();

    g.strokeStyle = 'rgba(120,60,25,0.5)';
    g.lineWidth = Math.max(1, u * 0.06);
    g.beginPath();
    g.arc(0, 0, u * 0.85, 0, Math.PI * 2);
    g.stroke();
  }

  private paintPaw(g: CanvasRenderingContext2D, u: number): void {
    g.fillStyle = '#fffaf6';
    g.strokeStyle = 'rgba(30,40,50,0.4)';
    g.lineWidth = Math.max(1, u * 0.05);

    // Main pad.
    g.beginPath();
    g.ellipse(0, u * 0.36, u * 0.52, u * 0.42, 0, 0, Math.PI * 2);
    g.fill();
    g.stroke();

    // Toes.
    const toes: [number, number, number][] = [
      [-u * 0.58, -u * 0.18, u * 0.21],
      [-u * 0.2, -u * 0.46, u * 0.22],
      [u * 0.2, -u * 0.46, u * 0.22],
      [u * 0.58, -u * 0.18, u * 0.21],
    ];
    for (const [x, y, r] of toes) {
      g.beginPath();
      g.ellipse(x, y, r, r * 1.15, 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
  }

  private paintSpecialMark(g: CanvasRenderingContext2D, special: Special, radius: number): void {
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';

    if (special === Special.RocketH || special === Special.RocketV) {
      if (special === Special.RocketV) g.rotate(Math.PI / 2);
      // A dark band with the dog mid-scoot, so the direction is obvious.
      g.fillStyle = 'rgba(12,8,24,0.55)';
      g.beginPath();
      g.roundRect(-radius, -radius * 0.42, radius * 2, radius * 0.84, radius * 0.2);
      g.fill();

      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.lineWidth = radius * 0.09;
      for (const dy of [-radius * 0.2, 0, radius * 0.2]) {
        g.beginPath();
        g.moveTo(-radius * 0.86, dy);
        g.lineTo(-radius * 0.4, dy);
        g.stroke();
      }
      this.paintScootDog(g, radius * 0.55, radius * 0.3, radius * 0.16);
      g.restore();
      return;
    }

    if (special === Special.Bomb) {
      g.strokeStyle = 'rgba(10,6,20,0.5)';
      g.lineWidth = radius * 0.26;
      g.beginPath();
      g.arc(0, 0, radius * 0.5, 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = '#fff';
      g.lineWidth = radius * 0.15;
      g.beginPath();
      g.arc(0, 0, radius * 0.5, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(0, 0, radius * 0.19, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  /**
   * The white dog mid-scoot, facing +X with its rear on the ground line at
   * y = 0. Used both as the rocket badge and as the full-size sweep sprite.
   */
  private paintScootDog(
    g: CanvasRenderingContext2D,
    cx: number,
    groundY: number,
    u: number,
  ): void {
    g.save();
    g.translate(cx, groundY);

    const coat = g.createLinearGradient(0, -u * 2.2, 0, 0);
    coat.addColorStop(0, '#ffffff');
    coat.addColorStop(1, '#ded6c8');
    g.fillStyle = coat;
    g.strokeStyle = 'rgba(40,32,28,0.55)';
    g.lineWidth = Math.max(0.8, u * 0.16);

    // Tail, up and curled behind.
    g.save();
    g.strokeStyle = '#f2ece1';
    g.lineWidth = Math.max(1, u * 0.42);
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(-u * 1.5, -u * 1.1);
    g.quadraticCurveTo(-u * 2.4, -u * 1.9, -u * 1.6, -u * 2.4);
    g.stroke();
    g.restore();

    // Body, tilted back so the rear sits on the ground.
    g.beginPath();
    g.ellipse(-u * 0.35, -u * 1.15, u * 1.5, u * 1.02, -0.22, 0, Math.PI * 2);
    g.fill();
    g.stroke();

    // Front legs, stretched forward — the scoot pose.
    g.lineCap = 'round';
    g.strokeStyle = '#efe8dc';
    g.lineWidth = Math.max(1, u * 0.44);
    for (const dy of [-u * 0.1, u * 0.12]) {
      g.beginPath();
      g.moveTo(u * 0.5, -u * 1.0 + dy);
      g.lineTo(u * 1.5, -u * 0.2 + dy);
      g.stroke();
    }

    // Head.
    g.fillStyle = coat;
    g.strokeStyle = 'rgba(40,32,28,0.55)';
    g.lineWidth = Math.max(0.8, u * 0.16);
    g.beginPath();
    g.ellipse(u * 1.25, -u * 1.85, u * 0.86, u * 0.78, 0.1, 0, Math.PI * 2);
    g.fill();
    g.stroke();

    // Fluffy caramel ear: shorter, and built from puffs like the tile face.
    const earPuffs: [number, number, number][] = [
      [0, -u * 0.34, u * 0.3],
      [0, u * 0.06, u * 0.32],
      [u * 0.04, u * 0.42, u * 0.24],
    ];
    g.save();
    g.translate(u * 0.8, -u * 1.62);
    g.fillStyle = 'rgba(74, 44, 14, 0.5)';
    this.fluff(g, earPuffs, 1.12);
    g.fill();
    const ear = g.createLinearGradient(0, -u * 0.7, 0, u * 0.7);
    ear.addColorStop(0, '#eec08e');
    ear.addColorStop(1, '#9c6733');
    g.fillStyle = ear;
    this.fluff(g, earPuffs, 1);
    g.fill();
    g.restore();

    // Face.
    g.fillStyle = '#241d1a';
    g.beginPath();
    g.arc(u * 1.5, -u * 1.98, u * 0.15, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.ellipse(u * 2.02, -u * 1.72, u * 0.2, u * 0.16, 0, 0, Math.PI * 2);
    g.fill();
    // Open, smiling mouth with the tongue out.
    g.strokeStyle = '#241d1a';
    g.lineWidth = Math.max(0.8, u * 0.16);
    g.lineCap = 'round';
    g.beginPath();
    g.arc(u * 1.78, -u * 1.6, u * 0.34, 0.1 * Math.PI, 0.72 * Math.PI);
    g.stroke();
    g.fillStyle = '#ff8fa8';
    g.beginPath();
    g.ellipse(u * 1.84, -u * 1.28, u * 0.19, u * 0.28, 0.3, 0, Math.PI * 2);
    g.fill();

    g.restore();
  }

  private paintRainbow(g: CanvasRenderingContext2D, radius: number): void {
    g.save();
    g.globalAlpha = 0.4;
    g.fillStyle = '#000';
    g.filter = `blur(${Math.max(1, radius * 0.14)}px)`;
    g.beginPath();
    g.ellipse(0, radius * 0.42, radius * 0.82, radius * 0.34, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();

    for (let i = 0; i < 6; i++) {
      g.beginPath();
      g.moveTo(0, 0);
      g.arc(0, 0, radius, (i * Math.PI) / 3, ((i + 1) * Math.PI) / 3);
      g.closePath();
      g.fillStyle = GEM_COLORS[i];
      g.fill();
    }

    const sheen = g.createRadialGradient(-radius * 0.3, -radius * 0.4, 0, 0, 0, radius);
    sheen.addColorStop(0, 'rgba(255,255,255,0.75)');
    sheen.addColorStop(0.5, 'rgba(255,255,255,0.08)');
    sheen.addColorStop(1, 'rgba(0,0,0,0.25)');
    g.fillStyle = sheen;
    g.beginPath();
    g.arc(0, 0, radius, 0, Math.PI * 2);
    g.fill();

    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = radius * 0.11;
    g.beginPath();
    g.arc(0, 0, radius, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(0, 0, radius * 0.22, 0, Math.PI * 2);
    g.fill();
  }

  private paintIngredient(g: CanvasRenderingContext2D, radius: number): void {
    g.save();
    g.globalAlpha = 0.45;
    g.fillStyle = '#000';
    g.filter = `blur(${Math.max(1, radius * 0.14)}px)`;
    g.beginPath();
    g.ellipse(0, radius * 0.45, radius * 0.8, radius * 0.3, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();

    g.save();
    g.shadowColor = 'rgba(255,190,60,0.85)';
    g.shadowBlur = radius * 0.7;
    const grad = g.createRadialGradient(-radius * 0.3, -radius * 0.4, radius * 0.08, 0, 0, radius);
    grad.addColorStop(0, '#fffbe8');
    grad.addColorStop(0.45, '#ffd166');
    grad.addColorStop(1, '#c8790a');
    g.fillStyle = grad;
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (Math.PI * 2 * i) / 10;
      const rad = i % 2 === 0 ? radius * 1.15 : radius * 0.52;
      const x = Math.cos(a) * rad;
      const y = Math.sin(a) * rad;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.fill();
    g.restore();

    g.strokeStyle = 'rgba(120,66,0,0.75)';
    g.lineWidth = radius * 0.09;
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath();
    g.ellipse(-radius * 0.24, -radius * 0.3, radius * 0.16, radius * 0.09, -0.6, 0, Math.PI * 2);
    g.fill();
  }

  /* ---------------------------------------------------------------- *
   * Timeline playback
   * ---------------------------------------------------------------- */

  enqueue(steps: Step[]): void {
    this.queue.push(...steps);
  }

  get busy(): boolean {
    return this.active !== null || this.queue.length > 0;
  }

  private beginStep(step: Step): void {
    const from = new Map<number, { x: number; y: number }>();
    const to = new Map<number, { x: number; y: number }>();
    const dying: Sprite[] = [];
    const wipeAt = new Map<number, number>();
    const pending: { at: number; done: boolean; apply: () => void }[] = [];
    let duration = 220;

    switch (step.type) {
      case 'swap': {
        const sa = this.spriteAt(step.a.r, step.a.c);
        const sb = this.spriteAt(step.b.r, step.b.c);
        audio.sfx(step.valid ? 'swap' : 'invalid');
        duration = step.valid ? 175 : 340;
        if (sa) {
          from.set(sa.id, { x: sa.x, y: sa.y });
          to.set(sa.id, { x: step.b.c, y: step.b.r });
        }
        if (sb) {
          from.set(sb.id, { x: sb.x, y: sb.y });
          to.set(sb.id, { x: step.a.c, y: step.a.r });
        }
        break;
      }
      case 'clear': {
        duration = 250;
        for (const { pos } of step.cleared) {
          const sprite = this.spriteAt(pos.r, pos.c);
          if (sprite) dying.push(sprite);
        }
        for (const { pos } of step.collected) {
          const sprite = this.spriteAt(pos.r, pos.c);
          if (sprite) dying.push(sprite);
        }

        const sweeps = this.spawnClearEffects(step);

        if (sweeps.length) {
          // The step now outlasts the sweep: the dog crosses, then his brown
          // takes a moment to clear, and only then does the tile go.
          const total = SCOOT_SECONDS + BROWN_SECONDS;
          duration = total * 1000;
          const dogSpan = SCOOT_SECONDS / total;
          const brownSpan = BROWN_SECONDS / total;

          /** Normalised step time at which the dog reaches a cell. */
          const arriveAt = (pos: Pos): number => {
            let soonest = 1;
            for (const sc of sweeps) {
              const cx = this.originX + (pos.c + 0.5) * this.cell;
              const cy = this.originY + (pos.r + 0.5) * this.cell;
              const p = sc.vertical
                ? (cy - sc.fromY) / (sc.toY - sc.fromY)
                : (cx - sc.fromX) / (sc.toX - sc.fromX);
              soonest = Math.min(soonest, shuffleArrival(p));
            }
            return soonest * dogSpan;
          };

          for (const { pos, gem } of step.cleared) {
            const sprite = this.spriteAt(pos.r, pos.c);
            const arrive = arriveAt(pos);
            if (sprite) wipeAt.set(sprite.id, arrive + brownSpan);
            const color =
              gem.kind === GemKind.Ingredient
                ? '#ffd166'
                : gem.special === Special.Rainbow
                  ? '#ffffff'
                  : GEM_COLORS[gem.color % GEM_COLORS.length];
            const centre = this.centreOf(pos);
            pending.push({
              at: arrive,
              done: false,
              apply: () =>
                this.smears.push({
                  x: centre.x,
                  y: centre.y,
                  size: this.cell * 0.96,
                  life: 1,
                  seed: pos.r * 31 + pos.c * 17,
                }),
            });
            pending.push({
              at: arrive + brownSpan,
              done: false,
              apply: () => this.burst(pos, color, 7, 1.2, false),
            });
          }
          // Crates, jelly and chains give way with the tile above them.
          for (const entry of step.jelly) {
            pending.push({
              at: arriveAt(entry.pos) + brownSpan,
              done: false,
              apply: () => (this.jelly[this.index(entry.pos)] = entry.layersLeft),
            });
          }
          for (const entry of step.damaged) {
            pending.push({
              at: arriveAt(entry.pos) + brownSpan,
              done: false,
              apply: () => {
                const i = this.index(entry.pos);
                if (entry.destroyed) this.blockers[i] = null;
                else if (this.blockers[i]) this.blockers[i]!.hp = entry.hpLeft;
                this.burst(entry.pos, entry.kind === 'crate' ? '#c98b4b' : '#8d94a6', 8, 1.1, false);
              },
            });
          }
          for (const pos of step.unlocked) {
            pending.push({
              at: arriveAt(pos) + brownSpan,
              done: false,
              apply: () => (this.locked[this.index(pos)] = false),
            });
          }
        }
        break;
      }
      case 'fall': {
        let maxDrop = 1;
        for (const move of step.moves) {
          const sprite = this.sprites.get(move.id);
          if (!sprite) continue;
          from.set(sprite.id, { x: sprite.x, y: sprite.y });
          to.set(sprite.id, { x: move.to.c, y: move.to.r });
          maxDrop = Math.max(maxDrop, Math.abs(move.to.r - move.from.r));
        }
        for (const spawn of step.spawns) {
          const sprite = this.addSprite(spawn.gem, spawn.to.r, spawn.to.c, -1);
          sprite.x = spawn.to.c;
          sprite.y = spawn.fromRow;
          from.set(sprite.id, { x: sprite.x, y: sprite.y });
          to.set(sprite.id, { x: spawn.to.c, y: spawn.to.r });
          maxDrop = Math.max(maxDrop, spawn.to.r - spawn.fromRow);
        }
        duration = Math.min(500, 125 + maxDrop * 52);
        break;
      }
      case 'shuffle': {
        duration = 460;
        for (const entry of step.layout) {
          const sprite = this.sprites.get(entry.gem.id);
          if (!sprite) continue;
          from.set(sprite.id, { x: sprite.x, y: sprite.y });
          to.set(sprite.id, { x: entry.pos.c, y: entry.pos.r });
        }
        break;
      }
    }

    this.active = { step, elapsed: 0, duration, dying, from, to, wipeAt, pending };
  }

  private centreOf(p: Pos): { x: number; y: number } {
    return {
      x: this.originX + (p.c + 0.5) * this.cell,
      y: this.originY + (p.r + 0.5) * this.cell,
    };
  }

  private burst(p: Pos, color: string, count: number, power: number, star: boolean): void {
    if (this.particles.length > this.maxParticles) return;
    const n = this.lowFx ? Math.ceil(count / 3) : count;
    const { x, y } = this.centreOf(p);
    for (let i = 0; i < n; i++) {
      const angle = (Math.PI * 2 * i) / n + Math.random() * 0.8;
      const speed = (1.4 + Math.random() * 3.2) * power;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1.4,
        life: 1,
        maxLife: 0.45 + Math.random() * 0.45,
        color,
        size: this.cell * (0.05 + Math.random() * 0.08) * power,
        star,
        spin: Math.random() * Math.PI,
      });
    }
  }

  /** Particles, sweeps, shockwaves and popups for a clear step. */
  private spawnClearEffects(step: Extract<Step, { type: 'clear' }>): Scoot[] {
    const sweeps: Scoot[] = [];
    if (step.cleared.length) audio.sfx('match', step.cascade);
    for (const detonation of step.detonations) {
      if (detonation.special === Special.Bomb) audio.sfx('bomb');
      else if (detonation.special === Special.Rainbow) audio.sfx('rainbow');
    }
    if (step.created.length) audio.sfx('special');
    if (step.collected.length) audio.sfx('ingredient');
    if (step.jelly.length) audio.sfx('jelly');
    if (step.defused.length) audio.sfx('fuse');
    if (step.damaged.some((d) => d.destroyed)) audio.sfx('crate');

    const hasSweep = step.detonations.some(
      (d) => d.special === Special.RocketH || d.special === Special.RocketV,
    );
    if (!hasSweep) {
      for (const { pos, gem } of step.cleared) {
        const color =
          gem.kind === GemKind.Ingredient
            ? '#ffd166'
            : gem.special === Special.Rainbow
              ? '#ffffff'
              : GEM_COLORS[gem.color % GEM_COLORS.length];
        this.burst(pos, color, gem.special === Special.None ? 5 : 10, gem.special === Special.None ? 1 : 1.5, false);
      }
    }

    for (const detonation of step.detonations) {
      const { x, y } = this.centreOf(detonation.pos);
      const color = GEM_COLORS[detonation.color % GEM_COLORS.length];

      if (detonation.special === Special.RocketH) {
        sweeps.push({
          fromX: this.originX - this.cell * 0.6,
          fromY: y,
          toX: this.originX + this.cell * (this.board.width + 0.6),
          toY: y,
          life: 1,
          vertical: false,
          color,
          shove: -1,
        });
        this.shake = Math.max(this.shake, 5);
      } else if (detonation.special === Special.RocketV) {
        sweeps.push({
          fromX: x,
          fromY: this.originY - this.cell * 0.6,
          toX: x,
          toY: this.originY + this.cell * (this.board.height + 0.6),
          life: 1,
          vertical: true,
          color,
          shove: -1,
        });
        this.shake = Math.max(this.shake, 5);
      } else if (detonation.special === Special.Bomb) {
        this.shockwaves.push({ x, y, radius: 0, maxRadius: this.cell * 2.2, life: 1, color, width: this.cell * 0.3 });
        this.burst(detonation.pos, '#fff', 14, 1.6, true);
        this.shake = Math.max(this.shake, 9);
      } else if (detonation.special === Special.Rainbow) {
        this.shockwaves.push({
          x,
          y,
          radius: 0,
          maxRadius: this.cell * Math.max(this.board.width, this.board.height),
          life: 1,
          color: '#ffffff',
          width: this.cell * 0.4,
        });
        this.shake = Math.max(this.shake, 12);
      }
    }

    if (!sweeps.length) {
      for (const entry of step.damaged) {
        this.burst(entry.pos, entry.kind === 'crate' ? '#c98b4b' : '#8d94a6', entry.destroyed ? 9 : 4, 1, false);
      }
    }

    for (const { pos } of step.collected) {
      this.burst(pos, '#ffd166', 22, 1.8, true);
      const { x, y } = this.centreOf(pos);
      this.shockwaves.push({ x, y, radius: 0, maxRadius: this.cell * 2, life: 1, color: '#ffd166', width: this.cell * 0.22 });
      this.shake = Math.max(this.shake, 7);
    }

    for (const { pos } of step.created) {
      this.burst(pos, '#ffffff', 12, 1.3, true);
    }

    for (const pos of step.defused) {
      this.burst(pos, '#ff8a5c', 16, 1.5, true);
      const { x, y } = this.centreOf(pos);
      this.shockwaves.push({ x, y, radius: 0, maxRadius: this.cell * 1.6, life: 1, color: '#ff8a5c', width: this.cell * 0.2 });
    }

    if (step.score > 0 && (step.cleared.length || step.collected.length)) {
      const sample = step.cleared[0]?.pos ?? step.collected[0]?.pos;
      if (sample) {
        const { x, y } = this.centreOf(sample);
        this.floaters.push({
          x,
          y: y - this.cell * 0.2,
          text: `+${step.score.toLocaleString()}`,
          life: 1,
          color: step.cascade > 1 ? '#ffd166' : '#ffffff',
          size: this.cell * (step.cascade > 1 ? 0.42 : 0.34),
        });
      }
    }

    if (step.cascade >= 3) {
      this.banner = {
        text: COMBO_WORDS[Math.min(step.cascade, COMBO_WORDS.length - 1)],
        sub: `${step.cascade} chain`,
        life: 1,
      };
    }

    this.scoots.push(...sweeps);
    return sweeps;
  }

  private applyStep(step: Step): void {
    switch (step.type) {
      case 'swap': {
        if (!step.valid) break;
        const sa = this.spriteAt(step.a.r, step.a.c);
        const sb = this.spriteAt(step.b.r, step.b.c);
        if (sa) {
          sa.r = step.b.r;
          sa.c = step.b.c;
        }
        if (sb) {
          sb.r = step.a.r;
          sb.c = step.a.c;
        }
        break;
      }
      case 'clear': {
        for (const entry of this.active?.pending ?? []) {
          if (!entry.done) {
            entry.done = true;
            entry.apply();
          }
        }
        for (const sprite of this.active?.dying ?? []) this.sprites.delete(sprite.id);
        for (const { pos, gem } of step.created) {
          const existing = this.spriteAt(pos.r, pos.c);
          if (existing) this.sprites.delete(existing.id);
          this.addSprite(gem, pos.r, pos.c, this.time);
        }
        for (const entry of step.jelly) this.jelly[this.index(entry.pos)] = entry.layersLeft;
        for (const entry of step.damaged) {
          const i = this.index(entry.pos);
          if (entry.destroyed) this.blockers[i] = null;
          else if (this.blockers[i]) this.blockers[i]!.hp = entry.hpLeft;
        }
        for (const pos of step.unlocked) this.locked[this.index(pos)] = false;
        break;
      }
      case 'fall': {
        for (const move of step.moves) {
          const sprite = this.sprites.get(move.id);
          if (!sprite) continue;
          sprite.r = move.to.r;
          sprite.c = move.to.c;
          sprite.landedAt = this.time;
        }
        for (const spawn of step.spawns) {
          const sprite = this.sprites.get(spawn.gem.id);
          if (!sprite) continue;
          sprite.r = spawn.to.r;
          sprite.c = spawn.to.c;
          sprite.landedAt = this.time;
        }
        break;
      }
      case 'shuffle': {
        for (const entry of step.layout) {
          const sprite = this.sprites.get(entry.gem.id);
          if (!sprite) continue;
          sprite.r = entry.pos.r;
          sprite.c = entry.pos.c;
        }
        break;
      }
    }

    for (const sprite of this.sprites.values()) {
      sprite.x = sprite.c;
      sprite.y = sprite.r;
      sprite.scale = 1;
      sprite.alpha = 1;
      sprite.spin = 0;
    }
  }

  private index(p: Pos): number {
    return p.r * this.board.width + p.c;
  }

  /* ---------------------------------------------------------------- *
   * Frame
   * ---------------------------------------------------------------- */

  tick(dt: number): void {
    this.time += dt;
    // Smoothed, so the number is readable rather than flickering.
    this.frameMs += (Math.min(200, dt * 1000) - this.frameMs) * 0.1;

    // If the device cannot hold a reasonable rate, shed decoration rather
    // than let the board itself become unresponsive.
    if (!this.lowFx) {
      if (this.frameMs > 26) this.slowFrames++;
      else this.slowFrames = Math.max(0, this.slowFrames - 1);
      if (this.slowFrames > 90 && !this.autoLowFx) {
        this.autoLowFx = true;
        this.lowFx = true;
        document.body.classList.add('low-fx');
      }
    }

    if (!this.active && this.queue.length) this.beginStep(this.queue.shift()!);

    if (this.active) {
      this.active.elapsed += dt * 1000;
      const t = Math.min(1, this.active.elapsed / this.active.duration);
      this.updateActive(t);
      if (t >= 1) {
        this.applyStep(this.active.step);
        this.active = null;
      }
    }

    for (const p of this.particles) {
      p.x += p.vx * dt * 60;
      p.y += p.vy * dt * 60;
      p.vy += dt * 32;
      // Dust puffs slow down and hang in the air instead of dropping.
      if (p.size > this.cell * 0.085) {
        p.vx *= 1 - dt * 2.4;
        p.vy *= 1 - dt * 3.2;
      }
      p.spin += dt * 6;
      p.life -= dt / p.maxLife;
    }
    if (this.particles.length) this.particles = this.particles.filter((p) => p.life > 0);

    for (const f of this.floaters) {
      f.y -= dt * 52;
      f.life -= dt * 1.05;
    }
    if (this.floaters.length) this.floaters = this.floaters.filter((f) => f.life > 0);

    for (const s of this.shockwaves) {
      s.life -= dt * 1.9;
      s.radius = s.maxRadius * (1 - Math.pow(Math.max(0, s.life), 2));
    }
    if (this.shockwaves.length) this.shockwaves = this.shockwaves.filter((s) => s.life > 0);

    for (const b of this.beams) b.life -= dt * 2.6;
    if (this.beams.length) this.beams = this.beams.filter((b) => b.life > 0);

    for (const sm of this.smears) sm.life -= dt / BROWN_SECONDS;
    if (this.smears.length) this.smears = this.smears.filter((sm) => sm.life > 0);

    for (const sc of this.scoots) {
      sc.life -= dt / SCOOT_SECONDS;
      const raw = 1 - Math.max(0, sc.life);
      const shove = Math.min(SCOOT_SHOVES - 1, Math.floor(raw * SCOOT_SHOVES));
      if (shove !== sc.shove) {
        sc.shove = shove;
        audio.sfx('scoot');
      }
      // A little dust off his back feet. Kept light: it used to bury both
      // the brown streak and the dog himself.
      if (sc.life > 0.08 && Math.random() < 0.55) {
        const t = shuffleEase(1 - Math.max(0, sc.life));
        const x = sc.fromX + (sc.toX - sc.fromX) * t;
        const y = sc.fromY + (sc.toY - sc.fromY) * t;
        const spread = (Math.random() - 0.5) * this.cell * 0.3;
        this.particles.push({
          x: x - (sc.vertical ? spread : this.cell * (0.34 + Math.random() * 0.2)),
          y: y - (sc.vertical ? this.cell * (0.34 + Math.random() * 0.2) : -spread) + this.cell * 0.2,
          vx: sc.vertical ? (Math.random() - 0.5) * 1.4 : -0.9 - Math.random(),
          vy: sc.vertical ? -0.9 - Math.random() : -0.5 - Math.random() * 0.6,
          life: 1,
          maxLife: 0.4 + Math.random() * 0.25,
          color: 'rgba(214, 198, 176, 0.55)',
          size: this.cell * (0.05 + Math.random() * 0.05),
          star: false,
          spin: 0,
        });
      }
    }
    if (this.scoots.length) this.scoots = this.scoots.filter((sc) => sc.life > 0);

    if (this.banner) {
      this.banner.life -= dt * 0.85;
      if (this.banner.life <= 0) this.banner = null;
    }

    this.shake = Math.max(0, this.shake - dt * 34);

    // Occasional glint on an idle gem, so a still board still feels alive.
    if (!this.lowFx && !this.busy && this.time > this.nextSparkle && this.sprites.size) {
      this.nextSparkle = this.time + 0.5 + Math.random();
      const list = [...this.sprites.values()];
      const sprite = list[Math.floor(Math.random() * list.length)];
      this.particles.push({
        x: this.originX + (sprite.x + 0.5) * this.cell + (Math.random() - 0.5) * this.cell * 0.4,
        y: this.originY + (sprite.y + 0.5) * this.cell + (Math.random() - 0.5) * this.cell * 0.4,
        vx: 0,
        vy: -0.25,
        life: 1,
        maxLife: 0.7,
        color: '#ffffff',
        size: this.cell * 0.07,
        star: true,
        spin: 0,
      });
    }

    this.draw();
  }

  private updateActive(t: number): void {
    const { step, from, to, dying } = this.active!;

    if (step.type === 'swap' && !step.valid) {
      const wave = t < 0.5 ? easeOutCubic(t * 2) * 0.42 : easeOutCubic((1 - t) * 2) * 0.42;
      for (const [id, start] of from) {
        const sprite = this.sprites.get(id);
        const end = to.get(id);
        if (!sprite || !end) continue;
        sprite.x = start.x + (end.x - start.x) * wave;
        sprite.y = start.y + (end.y - start.y) * wave;
      }
      return;
    }

    const eased =
      step.type === 'fall'
        ? easeOutCubic(t)
        : step.type === 'shuffle'
          ? easeInOutQuad(t)
          : step.type === 'swap'
            ? easeOutBack(t)
            : easeOutCubic(t);

    for (const [id, start] of from) {
      const sprite = this.sprites.get(id);
      const end = to.get(id);
      if (!sprite || !end) continue;
      sprite.x = start.x + (end.x - start.x) * eased;
      sprite.y = start.y + (end.y - start.y) * eased;
    }

    if (step.type === 'shuffle') {
      const dip = 1 - Math.sin(t * Math.PI) * 0.55;
      for (const sprite of this.sprites.values()) {
        sprite.alpha = dip;
        sprite.spin = Math.sin(t * Math.PI) * 0.5;
      }
    }

    if (step.type === 'clear') {
      const { wipeAt, pending } = this.active!;
      for (const sprite of dying) {
        const start = wipeAt.get(sprite.id);
        // Without a sweep every piece pops together; with one, each waits
        // until the dog is on top of it and then pops quickly.
        const local = start === undefined ? t : Math.max(0, Math.min(1, (t - start) / 0.14));
        const k = easeInQuad(local);
        sprite.scale = 1 + k * 0.45 - k * 1.45;
        sprite.alpha = 1 - k;
        sprite.spin = k * 1.8;
      }
      for (const entry of pending) {
        if (!entry.done && t >= entry.at) {
          entry.done = true;
          entry.apply();
        }
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Drawing
   * ---------------------------------------------------------------- */

  private draw(): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    if (this.shake > 0.1) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }

    this.drawStatic();
    this.drawBlockers();
    this.drawBeams();
    this.drawSprites();
    this.drawJelly();
    this.drawOverlays();
    // Drawn after the pieces so the brown and the dog pass in front of them.
    this.drawSmears();
    this.drawScoots();
    this.drawShockwaves();
    this.drawParticles();
    this.drawFloaters();
    this.drawBanner();
    if (this.showFps) this.drawFps();
  }

  private drawFps(): void {
    const ctx = this.ctx;
    const fps = Math.round(1000 / Math.max(1, this.frameMs));
    ctx.save();
    ctx.font = '700 12px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const label = `${fps} fps  ${this.frameMs.toFixed(1)}ms`;
    const w = ctx.measureText(label).width + 12;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(4, 4, w, 20);
    ctx.fillStyle = fps >= 50 ? '#3ddc84' : fps >= 25 ? '#ffc233' : '#ff5c7a';
    ctx.fillText(label, 10, 8);
    ctx.restore();
  }

  /**
   * The tray and the empty cell wells, painted once per layout into an
   * offscreen canvas. These used to be repainted every frame, gradients and
   * drop shadow included, which is pure waste — they never change.
   */
  private buildStaticLayer(): HTMLCanvasElement {
    const layer = document.createElement('canvas');
    layer.width = this.canvas.width;
    layer.height = this.canvas.height;
    const ctx = layer.getContext('2d')!;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const w = this.cell * this.board.width;
    const h = this.cell * this.board.height;
    const inset = this.cell * 0.2;
    const x = this.originX - inset;
    const y = this.originY - inset;
    const rw = w + inset * 2;
    const rh = h + inset * 2;
    const radius = this.cell * 0.45;

    const round = (rx: number, ry: number, rwid: number, rhei: number, r: number) => {
      const rr = Math.min(r, rwid / 2, rhei / 2);
      ctx.beginPath();
      ctx.moveTo(rx + rr, ry);
      ctx.arcTo(rx + rwid, ry, rx + rwid, ry + rhei, rr);
      ctx.arcTo(rx + rwid, ry + rhei, rx, ry + rhei, rr);
      ctx.arcTo(rx, ry + rhei, rx, ry, rr);
      ctx.arcTo(rx, ry, rx + rwid, ry, rr);
      ctx.closePath();
    };

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = this.cell * 0.6;
    ctx.shadowOffsetY = this.cell * 0.16;
    const fill = ctx.createLinearGradient(0, y, 0, y + rh);
    fill.addColorStop(0, 'rgba(96, 74, 168, 0.42)');
    fill.addColorStop(1, 'rgba(28, 20, 58, 0.55)');
    ctx.fillStyle = fill;
    round(x, y, rw, rh, radius);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1.5;
    round(x + 0.75, y + 0.75, rw - 1.5, rh - 1.5, radius);
    ctx.stroke();

    ctx.save();
    ctx.globalAlpha = 0.5;
    const sheen = ctx.createLinearGradient(0, y, 0, y + rh * 0.35);
    sheen.addColorStop(0, 'rgba(255,255,255,0.3)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    round(x + 2, y + 2, rw - 4, rh * 0.35, radius);
    ctx.fill();
    ctx.restore();

    for (let r = 0; r < this.board.height; r++) {
      for (let c = 0; c < this.board.width; c++) {
        if (this.board.at(r, c)!.hole) continue;
        const cx = this.originX + c * this.cell;
        const cy = this.originY + r * this.cell;
        const well = ctx.createLinearGradient(0, cy, 0, cy + this.cell);
        if ((r + c) % 2 === 0) {
          well.addColorStop(0, 'rgba(0,0,0,0.26)');
          well.addColorStop(1, 'rgba(255,255,255,0.07)');
        } else {
          well.addColorStop(0, 'rgba(0,0,0,0.18)');
          well.addColorStop(1, 'rgba(255,255,255,0.04)');
        }
        ctx.fillStyle = well;
        round(cx + 1.5, cy + 1.5, this.cell - 3, this.cell - 3, this.cell * 0.24);
        ctx.fill();
      }
    }
    return layer;
  }

  private drawStatic(): void {
    if (!this.staticLayer) this.staticLayer = this.buildStaticLayer();
    this.ctx.drawImage(
      this.staticLayer,
      0,
      0,
      this.staticLayer.width / this.dpr,
      this.staticLayer.height / this.dpr,
    );
  }

  /** Blockers, cached per kind and hit points and blitted. */
  private blockerImage(kind: BlockerKind, hp: number): HTMLCanvasElement {
    const key = `${kind}:${hp >= 2 ? 2 : 1}`;
    let img = this.blockerCache.get(key);
    if (img) return img;

    const side = Math.ceil(this.cell * this.dpr);
    img = document.createElement('canvas');
    img.width = side;
    img.height = side;
    const g = img.getContext('2d')!;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.paintBlocker(g, kind, hp, this.cell);
    this.blockerCache.set(key, img);
    return img;
  }

  private drawBlockers(): void {
    for (let r = 0; r < this.board.height; r++) {
      for (let c = 0; c < this.board.width; c++) {
        const blocker = this.blockers[r * this.board.width + c];
        if (!blocker) continue;
        const img = this.blockerImage(blocker.kind, blocker.hp);
        this.ctx.drawImage(
          img,
          this.originX + c * this.cell,
          this.originY + r * this.cell,
          this.cell,
          this.cell,
        );
      }
    }
  }

  /** Paints one blocker into a cache canvas at the origin. */
  private paintBlocker(
    ctx: CanvasRenderingContext2D,
    kind: BlockerKind,
    hp: number,
    cell: number,
  ): void {
    const blocker = { kind, hp };
    const x = 0;
    const y = 0;
    const pad = cell * 0.07;
    const size = cell - pad * 2;

    ctx.save();

    if (blocker.kind === 'crate') {
      const grad = ctx.createLinearGradient(x, y, x + cell * 0.4, y + cell);
      grad.addColorStop(0, blocker.hp >= 2 ? '#c08850' : '#e0a768');
      grad.addColorStop(1, blocker.hp >= 2 ? '#6b4318' : '#8d5b25');
      ctx.fillStyle = grad;
      this.roundRect(x + pad, y + pad, size, size, cell * 0.16);
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = 'rgba(52,28,8,0.9)';
      ctx.lineWidth = Math.max(2, cell * 0.05);
      this.roundRect(x + pad, y + pad, size, size, cell * 0.16);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + pad, y + cell / 2);
      ctx.lineTo(x + pad + size, y + cell / 2);
      ctx.stroke();
      if (blocker.hp >= 2) {
        ctx.beginPath();
        ctx.moveTo(x + cell / 2, y + pad);
        ctx.lineTo(x + cell / 2, y + pad + size);
        ctx.stroke();
      }
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = '#ffe4bd';
      ctx.lineWidth = Math.max(1, cell * 0.03);
      ctx.beginPath();
      ctx.moveTo(x + pad * 2, y + pad * 2);
      ctx.lineTo(x + pad + size - pad, y + pad * 2);
      ctx.stroke();
      ctx.restore();
    } else {
      const grad = ctx.createRadialGradient(
        x + cell * 0.36,
        y + cell * 0.32,
        cell * 0.06,
        x + cell / 2,
        y + cell / 2,
        cell * 0.58,
      );
      grad.addColorStop(0, '#a8afc0');
      grad.addColorStop(0.6, '#6f7688');
      grad.addColorStop(1, '#3c4252');
      ctx.fillStyle = grad;
      this.roundRect(x + pad, y + pad, size, size, cell * 0.3);
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = 'rgba(16,20,30,0.85)';
      ctx.lineWidth = Math.max(2, cell * 0.045);
      this.roundRect(x + pad, y + pad, size, size, cell * 0.3);
      ctx.stroke();
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(x + cell * 0.36, y + cell * 0.32, cell * 0.1, cell * 0.06, -0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawSprites(): void {
    const ctx = this.ctx;
    for (const sprite of this.sprites.values()) {
      const img = this.gemImage(sprite.gem);
      const size = img.width / this.dpr;

      let scaleX = sprite.scale;
      let scaleY = sprite.scale;

      if (sprite.bornAt >= 0) {
        const k = Math.min(1, (this.time - sprite.bornAt) / 0.26);
        if (k < 1) {
          const pop = 0.35 + easeOutBack(k) * 0.8;
          scaleX *= pop;
          scaleY *= pop;
        }
      }
      if (sprite.landedAt >= 0) {
        const k = (this.time - sprite.landedAt) / 0.22;
        if (k < 1) {
          const squash = Math.sin((1 - k) * Math.PI) * 0.16;
          scaleX *= 1 + squash;
          scaleY *= 1 - squash;
        }
      }
      const selected =
        this.selection && this.selection.r === sprite.r && this.selection.c === sprite.c && !this.busy;
      if (selected) {
        const pulse = 1 + Math.sin(this.time * 9) * 0.06;
        scaleX *= pulse;
        scaleY *= pulse;
      }

      const cx = this.originX + (sprite.x + 0.5) * this.cell;
      const cy = this.originY + (sprite.y + 0.5) * this.cell;

      ctx.save();
      ctx.globalAlpha = sprite.alpha;
      ctx.translate(cx, cy);
      if (sprite.gem.special === Special.Rainbow) ctx.rotate(this.time * 0.9);
      else if (sprite.spin) ctx.rotate(sprite.spin);
      ctx.scale(scaleX, scaleY);
      ctx.drawImage(img, -size / 2, -size / 2, size, size);
      ctx.restore();

      // Fuse countdown: a red ring plus the remaining moves.
      const fuse = sprite.gem.fuse;
      if (fuse && fuse > 0) {
        const urgent = fuse <= 3;
        const pulse = 0.55 + Math.sin(this.time * (urgent ? 11 : 5)) * 0.45;
        ctx.save();
        ctx.globalAlpha = sprite.alpha;
        ctx.translate(cx, cy);
        ctx.strokeStyle = urgent ? `rgba(255,70,90,${0.6 + pulse * 0.4})` : `rgba(255,170,70,${0.55 + pulse * 0.35})`;
        ctx.lineWidth = Math.max(2, this.cell * 0.075);
        ctx.beginPath();
        ctx.arc(0, 0, this.cell * 0.42, 0, Math.PI * 2);
        ctx.stroke();

        const badge = this.cell * 0.19;
        ctx.fillStyle = urgent ? '#ff3b58' : '#1b1430';
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = Math.max(1.2, this.cell * 0.028);
        ctx.beginPath();
        ctx.arc(0, this.cell * 0.3, badge, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = `900 ${Math.round(this.cell * 0.26)}px ui-rounded, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(fuse), 0, this.cell * 0.31);
        ctx.restore();
      }

      // Bombs keep a live pulse ring, which cannot be baked into the sprite.
      if (sprite.gem.special === Special.Bomb) {
        const pulse = 0.45 + Math.sin(this.time * 6) * 0.35;
        ctx.save();
        ctx.globalAlpha = sprite.alpha * pulse;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = Math.max(1.5, this.cell * 0.035);
        ctx.beginPath();
        ctx.arc(cx, cy, this.cell * 0.34 * sprite.scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  /**
   * Jelly, drawn over the pieces as a pane of tinted glass. The pieces are
   * opaque and fill their cell, so anything drawn underneath them is simply
   * not visible — this is the layer the player actually reads.
   */
  /** One cached tile per layer count, so jelly costs a blit instead of a
   *  clipped gradient and a blurred stroke on every cell, every frame. */
  private jellyImage(layers: number): HTMLCanvasElement {
    let img = this.jellyCache.get(layers);
    if (img) return img;

    const side = Math.ceil(this.cell * this.dpr);
    img = document.createElement('canvas');
    img.width = side;
    img.height = side;
    const g = img.getContext('2d')!;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const cell = this.cell;
    const round = (x: number, y: number, w: number, h: number, r: number) => {
      const rr = Math.min(r, w / 2, h / 2);
      g.beginPath();
      g.moveTo(x + rr, y);
      g.arcTo(x + w, y, x + w, y + h, rr);
      g.arcTo(x + w, y + h, x, y + h, rr);
      g.arcTo(x, y + h, x, y, rr);
      g.arcTo(x, y, x + w, y, rr);
      g.closePath();
    };

    const alpha = layers >= 3 ? 0.46 : layers >= 2 ? 0.34 : 0.22;
    g.save();
    round(1.5, 1.5, cell - 3, cell - 3, cell * 0.24);
    g.clip();
    const pane = g.createLinearGradient(0, 0, cell, cell);
    pane.addColorStop(0, `rgba(150, 232, 255, ${alpha})`);
    pane.addColorStop(1, `rgba(60, 140, 255, ${alpha})`);
    g.fillStyle = pane;
    g.fillRect(0, 0, cell, cell);

    g.globalAlpha = 0.4;
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.beginPath();
    g.moveTo(-cell * 0.1, cell * 0.72);
    g.lineTo(cell * 0.5, -cell * 0.1);
    g.lineTo(cell * 0.72, -cell * 0.1);
    g.lineTo(cell * 0.12, cell * 0.72);
    g.closePath();
    g.fill();
    g.restore();

    // The rim glow is baked in here rather than blurred every frame.
    g.strokeStyle = `rgba(196, 246, 255, ${0.55 + layers * 0.15})`;
    g.lineWidth = Math.max(1.5, cell * (layers >= 2 ? 0.07 : 0.045));
    g.shadowColor = 'rgba(120, 220, 255, 0.9)';
    g.shadowBlur = cell * 0.18;
    round(2.5, 2.5, cell - 5, cell - 5, cell * 0.22);
    g.stroke();
    g.shadowBlur = 0;

    if (layers >= 2) {
      g.fillStyle = 'rgba(255,255,255,0.95)';
      g.strokeStyle = 'rgba(20,60,90,0.6)';
      g.lineWidth = Math.max(0.8, cell * 0.018);
      for (let k = 0; k < layers; k++) {
        g.beginPath();
        g.arc(
          cell / 2 + (k - (layers - 1) / 2) * cell * 0.17,
          cell - cell * 0.14,
          cell * 0.05,
          0,
          Math.PI * 2,
        );
        g.fill();
        g.stroke();
      }
    }

    this.jellyCache.set(layers, img);
    return img;
  }

  /**
   * Jelly, drawn over the pieces as a pane of tinted glass. The pieces are
   * opaque and fill their cell, so anything drawn underneath them is simply
   * not visible — this is the layer the player actually reads.
   */
  private drawJelly(): void {
    const ctx = this.ctx;
    for (let r = 0; r < this.board.height; r++) {
      for (let c = 0; c < this.board.width; c++) {
        const layers = this.jelly[r * this.board.width + c];
        if (!layers) continue;
        // A cheap shimmer that does not need the tile repainting.
        ctx.globalAlpha = this.lowFx ? 1 : 0.85 + Math.sin(this.time * 2.2 + (r + c) * 0.7) * 0.15;
        const img = this.jellyImage(Math.min(3, layers));
        ctx.drawImage(
          img,
          this.originX + c * this.cell,
          this.originY + r * this.cell,
          this.cell,
          this.cell,
        );
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawOverlays(): void {
    const ctx = this.ctx;

    for (let r = 0; r < this.board.height; r++) {
      for (let c = 0; c < this.board.width; c++) {
        if (!this.locked[r * this.board.width + c]) continue;
        const x = this.originX + c * this.cell;
        const y = this.originY + r * this.cell;
        const inset = this.cell * 0.14;

        ctx.save();
        ctx.strokeStyle = 'rgba(20,16,30,0.75)';
        ctx.lineWidth = Math.max(4, this.cell * 0.13);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x + inset, y + inset);
        ctx.lineTo(x + this.cell - inset, y + this.cell - inset);
        ctx.moveTo(x + this.cell - inset, y + inset);
        ctx.lineTo(x + inset, y + this.cell - inset);
        ctx.stroke();

        const chain = ctx.createLinearGradient(x, y, x + this.cell, y + this.cell);
        chain.addColorStop(0, '#f1f5ff');
        chain.addColorStop(0.5, '#9aa4bd');
        chain.addColorStop(1, '#e2e8f5');
        ctx.strokeStyle = chain;
        ctx.lineWidth = Math.max(2.5, this.cell * 0.08);
        ctx.beginPath();
        ctx.moveTo(x + inset, y + inset);
        ctx.lineTo(x + this.cell - inset, y + this.cell - inset);
        ctx.moveTo(x + this.cell - inset, y + inset);
        ctx.lineTo(x + inset, y + this.cell - inset);
        ctx.stroke();
        ctx.restore();
      }
    }

    if (this.selection) {
      const x = this.originX + this.selection.c * this.cell;
      const y = this.originY + this.selection.r * this.cell;
      const pulse = 0.6 + Math.sin(this.time * 8) * 0.4;
      ctx.save();
      ctx.strokeStyle = `rgba(255,255,255,${pulse * 0.35})`;
      ctx.lineWidth = Math.max(5, this.cell * 0.13);
      this.roundRect(x + 2, y + 2, this.cell - 4, this.cell - 4, this.cell * 0.24);
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${pulse})`;
      ctx.lineWidth = Math.max(2.5, this.cell * 0.06);
      ctx.stroke();
      ctx.restore();
    }

    if (this.targeting) {
      const pulse = 0.3 + Math.sin(this.time * 7) * 0.2;
      ctx.fillStyle = `rgba(255,110,110,${pulse * 0.3})`;
      this.roundRect(
        this.originX - this.cell * 0.2,
        this.originY - this.cell * 0.2,
        this.cell * this.board.width + this.cell * 0.4,
        this.cell * this.board.height + this.cell * 0.4,
        this.cell * 0.45,
      );
      ctx.fill();
    }

    if (this.hint && !this.busy) {
      const pulse = 0.4 + Math.sin(this.time * 5) * 0.3;
      ctx.save();
      for (const p of [this.hint.a, this.hint.b]) {
        const x = this.originX + p.c * this.cell;
        const y = this.originY + p.r * this.cell;
        ctx.strokeStyle = `rgba(255,214,102,${pulse * 0.3})`;
        ctx.lineWidth = Math.max(5, this.cell * 0.13);
        this.roundRect(x + 3, y + 3, this.cell - 6, this.cell - 6, this.cell * 0.24);
        ctx.stroke();
        ctx.strokeStyle = `rgba(255,214,102,${pulse + 0.35})`;
        ctx.lineWidth = Math.max(2.5, this.cell * 0.06);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawBeams(): void {
    const ctx = this.ctx;
    for (const b of this.beams) {
      const life = Math.max(0, b.life);
      const thickness = this.cell * (0.15 + life * 0.5);
      ctx.save();
      ctx.globalAlpha = life;
      ctx.strokeStyle = b.color;
      ctx.lineCap = 'round';
      ctx.lineWidth = thickness;
      ctx.beginPath();
      ctx.moveTo(b.x1, b.y1);
      ctx.lineTo(b.x2, b.y2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = thickness * 0.35;
      ctx.beginPath();
      ctx.moveTo(b.x1, b.y1);
      ctx.lineTo(b.x2, b.y2);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Full-size scoot sprite, drawn once per cell size and then blitted. */
  private getScootSprite(): HTMLCanvasElement {
    if (this.scootSprite) return this.scootSprite;
    const side = Math.max(16, Math.ceil(this.cell * 3.0 * this.dpr));
    const sprite = document.createElement('canvas');
    sprite.width = side;
    sprite.height = side;
    const g = sprite.getContext('2d')!;
    g.translate(side / 2, side / 2);
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.45)';
    g.shadowBlur = side * 0.06;
    // Ground line sits just below centre so his rear drags along the row.
    this.paintScootDog(g, -this.cell * 0.3 * this.dpr, this.cell * 0.5 * this.dpr, this.cell * 0.26 * this.dpr);
    g.restore();
    this.scootSprite = sprite;
    return sprite;
  }

  /** The brown he drags along, drawn over the tiles it still covers. */
  private drawSmears(): void {
    const ctx = this.ctx;
    for (const sm of this.smears) {
      const life = Math.max(0, Math.min(1, sm.life));
      ctx.save();
      ctx.globalAlpha = Math.min(1, life * 1.15);
      const grad = ctx.createLinearGradient(sm.x - sm.size / 2, sm.y, sm.x + sm.size / 2, sm.y);
      grad.addColorStop(0, 'rgba(63, 36, 12, 0.85)');
      grad.addColorStop(0.5, '#6b3f14');
      grad.addColorStop(1, 'rgba(63, 36, 12, 0.85)');
      ctx.fillStyle = grad;
      const h = sm.size * 0.74;
      this.roundRect(sm.x - sm.size / 2, sm.y - h / 2, sm.size, h, h * 0.42);
      ctx.fill();
      // A couple of streaks so it reads as smeared, not painted.
      ctx.globalAlpha = life * 0.5;
      ctx.strokeStyle = '#5c3512';
      ctx.lineWidth = Math.max(1, sm.size * 0.06);
      ctx.lineCap = 'round';
      for (let k = 0; k < 3; k++) {
        const off = ((sm.seed + k * 37) % 100) / 100 - 0.5;
        ctx.beginPath();
        ctx.moveTo(sm.x - sm.size * 0.42, sm.y + off * h * 0.7);
        ctx.lineTo(sm.x + sm.size * 0.42, sm.y + off * h * 0.5);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawScoots(): void {
    const ctx = this.ctx;
    const img = this.getScootSprite();
    const size = img.width / this.dpr;

    for (const sc of this.scoots) {
      const life = Math.max(0, Math.min(1, sc.life));
      const raw = 1 - life;
      const t = shuffleEase(raw);
      const x = sc.fromX + (sc.toX - sc.fromX) * t;
      const y = sc.fromY + (sc.toY - sc.fromY) * t;

      // He rocks as he shoves, and sits still between shoves.
      const seg = 1 / SCOOT_SHOVES;
      const within = Math.min(1, ((raw % seg) / seg) / SHOVE_PUSH);
      const wobble = Math.sin(within * Math.PI * 2) * this.cell * 0.07;

      ctx.save();
      ctx.translate(x, y);
      if (sc.vertical) ctx.rotate(Math.PI / 2);
      ctx.translate(0, wobble);
      ctx.drawImage(img, -size / 2, -size / 2, size, size);
      ctx.restore();
    }
  }

  private drawShockwaves(): void {
    const ctx = this.ctx;
    for (const s of this.shockwaves) {
      const life = Math.max(0, s.life);
      ctx.save();
      ctx.globalAlpha = life * 0.85;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width * life;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawParticles(): void {
    const ctx = this.ctx;
    // Clipped to the tray: dust used to spill down the screen below the board.
    ctx.save();
    const inset = this.cell * 0.2;
    this.roundRect(
      this.originX - inset,
      this.originY - inset,
      this.cell * this.board.width + inset * 2,
      this.cell * this.board.height + inset * 2,
      this.cell * 0.45,
    );
    ctx.clip();
    for (const p of this.particles) {
      const life = Math.max(0, p.life);
      ctx.save();
      ctx.globalAlpha = life;
      ctx.fillStyle = p.color;
      ctx.translate(p.x, p.y);
      if (p.star) {
        ctx.rotate(p.spin);
        const r = p.size * (0.4 + life);
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = (Math.PI * 2 * i) / 8;
          const rad = i % 2 === 0 ? r : r * 0.34;
          const x = Math.cos(a) * rad;
          const y = Math.sin(a) * rad;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.size * Math.max(0.2, life), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  private drawFloaters(): void {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of this.floaters) {
      const life = Math.max(0, Math.min(1, f.life));
      ctx.save();
      ctx.globalAlpha = life;
      ctx.font = `800 ${Math.round(f.size)}px ui-rounded, system-ui, sans-serif`;
      ctx.lineWidth = Math.max(3, f.size * 0.22);
      ctx.strokeStyle = 'rgba(12,8,24,0.75)';
      ctx.lineJoin = 'round';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
      ctx.restore();
    }
  }

  private drawBanner(): void {
    if (!this.banner) return;
    const ctx = this.ctx;
    const life = Math.max(0, this.banner.life);
    const grow = easeOutBack(Math.min(1, (1 - life) * 3));
    const cx = this.originX + (this.cell * this.board.width) / 2;
    const cy = this.originY + (this.cell * this.board.height) / 2;

    ctx.save();
    ctx.globalAlpha = Math.min(1, life * 1.6);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.translate(cx, cy);
    ctx.scale(grow, grow);

    const size = this.cell * 0.9;
    ctx.font = `900 ${Math.round(size)}px ui-rounded, system-ui, sans-serif`;
    ctx.lineWidth = size * 0.16;
    ctx.strokeStyle = 'rgba(12,8,24,0.8)';
    ctx.lineJoin = 'round';
    ctx.strokeText(this.banner.text, 0, 0);
    const fill = ctx.createLinearGradient(0, -size / 2, 0, size / 2);
    fill.addColorStop(0, '#fff6d6');
    fill.addColorStop(1, '#ffc233');
    ctx.fillStyle = fill;
    ctx.fillText(this.banner.text, 0, 0);

    ctx.font = `800 ${Math.round(size * 0.34)}px ui-rounded, system-ui, sans-serif`;
    ctx.lineWidth = size * 0.08;
    ctx.strokeText(this.banner.sub, 0, size * 0.68);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(this.banner.sub, 0, size * 0.68);
    ctx.restore();
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }
}
