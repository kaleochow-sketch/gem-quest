import { Board } from '../engine/board.js';
import { Blocker, Gem, GemKind, Pos, Special, Step } from '../engine/types.js';

/**
 * Gem palette. Each colour also gets its own silhouette, so the board stays
 * readable without relying on hue alone.
 */
export const GEM_COLORS = ['#ff4d6d', '#ffc233', '#3ddc84', '#45b7ff', '#b57bff', '#ff6fd8', '#14d6c4'];
const GEM_LIGHT = ['#ffa3b4', '#ffe4a0', '#a8f5c8', '#a9dcff', '#dcc0ff', '#ffbaec', '#9af5ec'];
const GEM_DEEP = ['#a8123a', '#a76a00', '#0f8f4d', '#0d5f9e', '#6332b8', '#b32b8f', '#068077'];

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
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2);
const easeInQuad = (t: number) => t * t;
const easeInOutQuad = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

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
  private banner: Banner | null = null;

  private queue: Step[] = [];
  private active: ActiveStep | null = null;

  /** Renderer-side copies of board furniture, updated as steps replay. */
  private jelly: number[] = [];
  private blockers: (Blocker | null)[] = [];
  private locked: boolean[] = [];

  /** Gems are pre-rendered once per size so each frame is a cheap blit. */
  private gemCache = new Map<string, HTMLCanvasElement>();

  private cell = 40;
  private originX = 0;
  private originY = 0;
  private dpr = 1;
  private time = 0;
  private shake = 0;
  private nextSparkle = 0;
  private resizeObserver: ResizeObserver | null = null;

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
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
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

  /** Draws one gem into its own canvas: shadow, faceted body, rim and gloss. */
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
    const mid = GEM_COLORS[idx];
    const light = GEM_LIGHT[idx];
    const deep = GEM_DEEP[idx];

    // Contact shadow.
    g.save();
    g.globalAlpha = 0.4;
    g.fillStyle = '#000';
    g.filter = `blur(${Math.max(1, radius * 0.14)}px)`;
    g.beginPath();
    g.ellipse(0, radius * 0.42, radius * 0.82, radius * 0.34, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();

    // Body.
    const body = g.createLinearGradient(-radius, -radius, radius * 0.6, radius);
    body.addColorStop(0, light);
    body.addColorStop(0.42, mid);
    body.addColorStop(1, deep);
    g.fillStyle = body;
    this.gemPath(g, idx, radius);
    g.fill();

    // Top facet: the same silhouette, shrunk and lifted, reads as a cut face.
    g.save();
    g.globalAlpha = 0.5;
    const facet = g.createLinearGradient(0, -radius, 0, 0);
    facet.addColorStop(0, 'rgba(255,255,255,0.92)');
    facet.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = facet;
    g.translate(0, -radius * 0.16);
    this.gemPath(g, idx, radius * 0.66);
    g.fill();
    g.restore();

    // Bottom bounce light.
    g.save();
    g.globalAlpha = 0.34;
    const bounce = g.createLinearGradient(0, radius * 0.2, 0, radius);
    bounce.addColorStop(0, 'rgba(255,255,255,0)');
    bounce.addColorStop(1, light);
    g.fillStyle = bounce;
    g.translate(0, radius * 0.2);
    this.gemPath(g, idx, radius * 0.7);
    g.fill();
    g.restore();

    // Outline.
    g.strokeStyle = 'rgba(12,6,24,0.45)';
    g.lineWidth = Math.max(1.2, radius * 0.08);
    this.gemPath(g, idx, radius);
    g.stroke();

    // Specular gloss and a small secondary glint.
    g.save();
    g.globalAlpha = 0.85;
    g.fillStyle = '#fff';
    g.beginPath();
    g.ellipse(-radius * 0.3, -radius * 0.4, radius * 0.24, radius * 0.14, -0.6, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 0.45;
    g.beginPath();
    g.ellipse(radius * 0.3, radius * 0.28, radius * 0.1, radius * 0.06, -0.6, 0, Math.PI * 2);
    g.fill();
    g.restore();

    if (gem.special !== Special.None) this.paintSpecialMark(g, gem.special, radius);
    return sprite;
  }

  /** One silhouette per colour, so hue is never the only signal. */
  private gemPath(g: CanvasRenderingContext2D, idx: number, radius: number): void {
    g.beginPath();
    switch (idx) {
      case 0:
        g.arc(0, 0, radius, 0, Math.PI * 2);
        break;
      case 1: {
        const r = radius * 0.9;
        const c = r * 0.36;
        g.moveTo(-r + c, -r);
        g.arcTo(r, -r, r, r, c);
        g.arcTo(r, r, -r, r, c);
        g.arcTo(-r, r, -r, -r, c);
        g.arcTo(-r, -r, r, -r, c);
        g.closePath();
        break;
      }
      case 2:
        this.polygon(g, 3, radius * 1.1, -Math.PI / 2);
        break;
      case 3:
        this.polygon(g, 4, radius * 1.08, 0);
        break;
      case 4:
        this.polygon(g, 5, radius * 1.05, -Math.PI / 2);
        break;
      case 5:
        this.polygon(g, 6, radius * 1.02, 0);
        break;
      default: {
        // Rounded cross for the seventh colour.
        const a = radius * 0.42;
        const b = radius * 1.02;
        const k = a * 0.5;
        g.moveTo(-a, -b + k);
        g.quadraticCurveTo(-a, -b, -a + k, -b);
        g.lineTo(a - k, -b);
        g.quadraticCurveTo(a, -b, a, -b + k);
        g.lineTo(a, -a);
        g.lineTo(b - k, -a);
        g.quadraticCurveTo(b, -a, b, -a + k);
        g.lineTo(b, a - k);
        g.quadraticCurveTo(b, a, b - k, a);
        g.lineTo(a, a);
        g.lineTo(a, b - k);
        g.quadraticCurveTo(a, b, a - k, b);
        g.lineTo(-a + k, b);
        g.quadraticCurveTo(-a, b, -a, b - k);
        g.lineTo(-a, a);
        g.lineTo(-b + k, a);
        g.quadraticCurveTo(-b, a, -b, a - k);
        g.lineTo(-b, -a + k);
        g.quadraticCurveTo(-b, -a, -b + k, -a);
        g.lineTo(-a, -a);
        g.closePath();
        break;
      }
    }
  }

  private polygon(g: CanvasRenderingContext2D, sides: number, radius: number, rotation: number): void {
    for (let i = 0; i < sides; i++) {
      const a = rotation + (Math.PI * 2 * i) / sides;
      const x = Math.cos(a) * radius;
      const y = Math.sin(a) * radius;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
  }

  private paintSpecialMark(g: CanvasRenderingContext2D, special: Special, radius: number): void {
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';

    if (special === Special.RocketH || special === Special.RocketV) {
      if (special === Special.RocketV) g.rotate(Math.PI / 2);
      g.strokeStyle = 'rgba(10,6,20,0.5)';
      g.lineWidth = radius * 0.3;
      for (const dy of [-radius * 0.34, 0, radius * 0.34]) {
        g.beginPath();
        g.moveTo(-radius * 0.66, dy);
        g.lineTo(radius * 0.66, dy);
        g.stroke();
      }
      g.strokeStyle = '#fff';
      g.lineWidth = radius * 0.17;
      for (const dy of [-radius * 0.34, 0, radius * 0.34]) {
        g.beginPath();
        g.moveTo(-radius * 0.62, dy);
        g.lineTo(radius * 0.62, dy);
        g.stroke();
      }
    } else if (special === Special.Bomb) {
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
    let duration = 220;

    switch (step.type) {
      case 'swap': {
        const sa = this.spriteAt(step.a.r, step.a.c);
        const sb = this.spriteAt(step.b.r, step.b.c);
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
        this.spawnClearEffects(step);
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

    this.active = { step, elapsed: 0, duration, dying, from, to };
  }

  private centreOf(p: Pos): { x: number; y: number } {
    return {
      x: this.originX + (p.c + 0.5) * this.cell,
      y: this.originY + (p.r + 0.5) * this.cell,
    };
  }

  private burst(p: Pos, color: string, count: number, power: number, star: boolean): void {
    const { x, y } = this.centreOf(p);
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.8;
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

  /** Particles, beams, shockwaves and popups for a clear step. */
  private spawnClearEffects(step: Extract<Step, { type: 'clear' }>): void {
    for (const { pos, gem } of step.cleared) {
      const color =
        gem.kind === GemKind.Ingredient
          ? '#ffd166'
          : gem.special === Special.Rainbow
            ? '#ffffff'
            : GEM_COLORS[gem.color % GEM_COLORS.length];
      this.burst(pos, color, gem.special === Special.None ? 5 : 10, gem.special === Special.None ? 1 : 1.5, false);
    }

    for (const detonation of step.detonations) {
      const { x, y } = this.centreOf(detonation.pos);
      const color = GEM_COLORS[detonation.color % GEM_COLORS.length];

      if (detonation.special === Special.RocketH) {
        this.beams.push({ x1: this.originX, y1: y, x2: this.originX + this.cell * this.board.width, y2: y, life: 1, color });
        this.shake = Math.max(this.shake, 5);
      } else if (detonation.special === Special.RocketV) {
        this.beams.push({ x1: x, y1: this.originY, x2: x, y2: this.originY + this.cell * this.board.height, life: 1, color });
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

    for (const entry of step.damaged) {
      this.burst(entry.pos, entry.kind === 'crate' ? '#c98b4b' : '#8d94a6', entry.destroyed ? 9 : 4, 1, false);
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

    if (this.banner) {
      this.banner.life -= dt * 0.85;
      if (this.banner.life <= 0) this.banner = null;
    }

    this.shake = Math.max(0, this.shake - dt * 34);

    // Occasional glint on an idle gem, so a still board still feels alive.
    if (!this.busy && this.time > this.nextSparkle && this.sprites.size) {
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
      const k = easeInQuad(t);
      for (const sprite of dying) {
        sprite.scale = 1 + k * 0.45 - k * 1.45;
        sprite.alpha = 1 - k;
        sprite.spin = k * 1.8;
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

    this.drawFrame();
    this.drawWells();
    this.drawBeams();
    this.drawSprites();
    this.drawOverlays();
    this.drawShockwaves();
    this.drawParticles();
    this.drawFloaters();
    this.drawBanner();
  }

  /** The tray the board sits in. */
  private drawFrame(): void {
    const ctx = this.ctx;
    const w = this.cell * this.board.width;
    const h = this.cell * this.board.height;
    const inset = this.cell * 0.2;
    const x = this.originX - inset;
    const y = this.originY - inset;
    const rw = w + inset * 2;
    const rh = h + inset * 2;
    const radius = this.cell * 0.45;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = this.cell * 0.6;
    ctx.shadowOffsetY = this.cell * 0.16;
    const fill = ctx.createLinearGradient(0, y, 0, y + rh);
    fill.addColorStop(0, 'rgba(96, 74, 168, 0.42)');
    fill.addColorStop(1, 'rgba(28, 20, 58, 0.55)');
    ctx.fillStyle = fill;
    this.roundRect(x, y, rw, rh, radius);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1.5;
    this.roundRect(x + 0.75, y + 0.75, rw - 1.5, rh - 1.5, radius);
    ctx.stroke();

    // Top edge catch-light.
    ctx.save();
    ctx.globalAlpha = 0.5;
    const sheen = ctx.createLinearGradient(0, y, 0, y + rh * 0.35);
    sheen.addColorStop(0, 'rgba(255,255,255,0.3)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    this.roundRect(x + 2, y + 2, rw - 4, rh * 0.35, radius);
    ctx.fill();
    ctx.restore();
  }

  private drawWells(): void {
    const ctx = this.ctx;
    for (let r = 0; r < this.board.height; r++) {
      for (let c = 0; c < this.board.width; c++) {
        const cell = this.board.at(r, c)!;
        if (cell.hole) continue;
        const x = this.originX + c * this.cell;
        const y = this.originY + r * this.cell;
        const i = r * this.board.width + c;

        const well = ctx.createLinearGradient(0, y, 0, y + this.cell);
        if ((r + c) % 2 === 0) {
          well.addColorStop(0, 'rgba(0,0,0,0.26)');
          well.addColorStop(1, 'rgba(255,255,255,0.07)');
        } else {
          well.addColorStop(0, 'rgba(0,0,0,0.18)');
          well.addColorStop(1, 'rgba(255,255,255,0.04)');
        }
        ctx.fillStyle = well;
        this.roundRect(x + 1.5, y + 1.5, this.cell - 3, this.cell - 3, this.cell * 0.24);
        ctx.fill();

        const jelly = this.jelly[i];
        if (jelly > 0) {
          const pulse = 0.85 + Math.sin(this.time * 2 + (r + c) * 0.6) * 0.15;
          const grad = ctx.createLinearGradient(x, y, x + this.cell, y + this.cell);
          const strength = jelly >= 3 ? 0.72 : jelly >= 2 ? 0.5 : 0.26;
          grad.addColorStop(0, `rgba(140, 226, 255, ${strength * pulse})`);
          grad.addColorStop(1, `rgba(76, 150, 255, ${strength * 0.9 * pulse})`);
          ctx.fillStyle = grad;
          this.roundRect(x + 2.5, y + 2.5, this.cell - 5, this.cell - 5, this.cell * 0.22);
          ctx.fill();
          ctx.strokeStyle = `rgba(214,246,255,${jelly >= 3 ? 0.95 : jelly >= 2 ? 0.8 : 0.4})`;
          ctx.lineWidth = jelly >= 3 ? 3 : jelly >= 2 ? 2 : 1;
          ctx.stroke();
          // Layer pips so the remaining count is readable at a glance.
          if (jelly >= 2) {
            ctx.fillStyle = 'rgba(255,255,255,0.9)';
            for (let k = 0; k < jelly; k++) {
              ctx.beginPath();
              ctx.arc(
                x + this.cell / 2 + (k - (jelly - 1) / 2) * this.cell * 0.16,
                y + this.cell - this.cell * 0.15,
                this.cell * 0.038,
                0,
                Math.PI * 2,
              );
              ctx.fill();
            }
          }
        }

        const blocker = this.blockers[i];
        if (blocker) this.drawBlocker(blocker, x, y);
      }
    }
  }

  private drawBlocker(blocker: Blocker, x: number, y: number): void {
    const ctx = this.ctx;
    const pad = this.cell * 0.07;
    const size = this.cell - pad * 2;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = this.cell * 0.16;
    ctx.shadowOffsetY = this.cell * 0.05;

    if (blocker.kind === 'crate') {
      const grad = ctx.createLinearGradient(x, y, x + this.cell * 0.4, y + this.cell);
      grad.addColorStop(0, blocker.hp >= 2 ? '#c08850' : '#e0a768');
      grad.addColorStop(1, blocker.hp >= 2 ? '#6b4318' : '#8d5b25');
      ctx.fillStyle = grad;
      this.roundRect(x + pad, y + pad, size, size, this.cell * 0.16);
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = 'rgba(52,28,8,0.9)';
      ctx.lineWidth = Math.max(2, this.cell * 0.05);
      this.roundRect(x + pad, y + pad, size, size, this.cell * 0.16);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + pad, y + this.cell / 2);
      ctx.lineTo(x + pad + size, y + this.cell / 2);
      ctx.stroke();
      if (blocker.hp >= 2) {
        ctx.beginPath();
        ctx.moveTo(x + this.cell / 2, y + pad);
        ctx.lineTo(x + this.cell / 2, y + pad + size);
        ctx.stroke();
      }
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = '#ffe4bd';
      ctx.lineWidth = Math.max(1, this.cell * 0.03);
      ctx.beginPath();
      ctx.moveTo(x + pad * 2, y + pad * 2);
      ctx.lineTo(x + pad + size - pad, y + pad * 2);
      ctx.stroke();
      ctx.restore();
    } else {
      const grad = ctx.createRadialGradient(
        x + this.cell * 0.36,
        y + this.cell * 0.32,
        this.cell * 0.06,
        x + this.cell / 2,
        y + this.cell / 2,
        this.cell * 0.58,
      );
      grad.addColorStop(0, '#a8afc0');
      grad.addColorStop(0.6, '#6f7688');
      grad.addColorStop(1, '#3c4252');
      ctx.fillStyle = grad;
      this.roundRect(x + pad, y + pad, size, size, this.cell * 0.3);
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = 'rgba(16,20,30,0.85)';
      ctx.lineWidth = Math.max(2, this.cell * 0.045);
      this.roundRect(x + pad, y + pad, size, size, this.cell * 0.3);
      ctx.stroke();
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(x + this.cell * 0.36, y + this.cell * 0.32, this.cell * 0.1, this.cell * 0.06, -0.6, 0, Math.PI * 2);
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
        ctx.shadowColor = urgent ? 'rgba(255,60,80,0.95)' : 'rgba(255,150,60,0.8)';
        ctx.shadowBlur = this.cell * 0.3 * pulse;
        ctx.strokeStyle = urgent ? `rgba(255,70,90,${0.6 + pulse * 0.4})` : `rgba(255,170,70,${0.55 + pulse * 0.35})`;
        ctx.lineWidth = Math.max(2, this.cell * 0.075);
        ctx.beginPath();
        ctx.arc(0, 0, this.cell * 0.42, 0, Math.PI * 2);
        ctx.stroke();
        ctx.shadowBlur = 0;

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
      ctx.shadowColor = 'rgba(255,255,255,0.9)';
      ctx.shadowBlur = this.cell * 0.3;
      ctx.strokeStyle = `rgba(255,255,255,${pulse})`;
      ctx.lineWidth = Math.max(2.5, this.cell * 0.06);
      this.roundRect(x + 2, y + 2, this.cell - 4, this.cell - 4, this.cell * 0.24);
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
      ctx.shadowColor = 'rgba(255,214,102,0.9)';
      ctx.shadowBlur = this.cell * 0.28;
      ctx.strokeStyle = `rgba(255,214,102,${pulse + 0.35})`;
      ctx.lineWidth = Math.max(2.5, this.cell * 0.06);
      for (const p of [this.hint.a, this.hint.b]) {
        const x = this.originX + p.c * this.cell;
        const y = this.originY + p.r * this.cell;
        this.roundRect(x + 3, y + 3, this.cell - 6, this.cell - 6, this.cell * 0.24);
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
      ctx.shadowColor = b.color;
      ctx.shadowBlur = this.cell * 0.6;
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

  private drawShockwaves(): void {
    const ctx = this.ctx;
    for (const s of this.shockwaves) {
      const life = Math.max(0, s.life);
      ctx.save();
      ctx.globalAlpha = life * 0.85;
      ctx.strokeStyle = s.color;
      ctx.shadowColor = s.color;
      ctx.shadowBlur = this.cell * 0.5;
      ctx.lineWidth = s.width * life;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawParticles(): void {
    const ctx = this.ctx;
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
