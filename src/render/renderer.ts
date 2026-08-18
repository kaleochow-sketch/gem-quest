import { Board } from '../engine/board.js';
import { Blocker, Gem, GemKind, Pos, Special, Step } from '../engine/types.js';

/** Gem palette. Each colour also gets its own silhouette, so the board stays
 *  readable without relying on hue alone. */
export const GEM_COLORS = ['#ff4d5e', '#ffb020', '#34d17a', '#3fa9ff', '#a869ff', '#ff6fd8'];
const GEM_DARK = ['#b52233', '#b8710a', '#189a52', '#1a6fb8', '#6c37bf', '#c23c9c'];

interface Sprite {
  id: number;
  gem: Gem;
  /** Logical cell. */
  r: number;
  c: number;
  /** Visual position in grid units; equals (c, r) at rest. */
  x: number;
  y: number;
  scale: number;
  alpha: number;
  spin: number;
  bornAt: number;
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
}

interface Floater {
  x: number;
  y: number;
  text: string;
  life: number;
  color: string;
}

interface ActiveStep {
  step: Step;
  elapsed: number;
  duration: number;
  /** Sprites vanishing during a clear step. */
  dying: Sprite[];
  /** Start positions for tweened sprites, keyed by sprite id. */
  from: Map<number, { x: number; y: number }>;
  to: Map<number, { x: number; y: number }>;
  applied: boolean;
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInQuad = (t: number) => t * t;
const easeInOutQuad = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** Draws the board and replays engine step timelines as animation. */
export class GameRenderer {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private board!: Board;

  private sprites = new Map<number, Sprite>();
  private particles: Particle[] = [];
  private floaters: Floater[] = [];

  private queue: Step[] = [];
  private active: ActiveStep | null = null;

  /** Renderer-side copies of board furniture, so they update as steps replay. */
  private jelly: number[] = [];
  private blockers: (Blocker | null)[] = [];
  private locked: boolean[] = [];

  private cell = 40;
  private originX = 0;
  private originY = 0;
  private dpr = 1;
  private time = 0;

  selection: Pos | null = null;
  hint: { a: Pos; b: Pos } | null = null;
  /** Cell being targeted by the hammer power-up, drawn with a marker. */
  targeting = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;

    // The canvas is stretched to its flex box, which changes as the HUD, goal
    // row and power bar fill in. Without this the backing store keeps a stale
    // aspect ratio and the cells render non-square.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.board) this.layout();
      });
      this.resizeObserver.observe(canvas);
    }
  }

  private resizeObserver: ResizeObserver | null = null;

  /** Binds a fresh board and rebuilds all visual state from it. */
  setBoard(board: Board): void {
    this.board = board;
    this.sprites.clear();
    this.particles = [];
    this.floaters = [];
    this.queue = [];
    this.active = null;
    this.selection = null;
    this.hint = null;

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
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);

    const pad = 10;
    const usableW = rect.width - pad * 2;
    const usableH = rect.height - pad * 2;
    this.cell = Math.floor(Math.min(usableW / this.board.width, usableH / this.board.height));
    this.originX = (rect.width - this.cell * this.board.width) / 2;
    this.originY = (rect.height - this.cell * this.board.height) / 2;
  }

  /** Board cell under a client-space point, or null. */
  cellAt(clientX: number, clientY: number): Pos | null {
    const rect = this.canvas.getBoundingClientRect();
    const c = Math.floor((clientX - rect.left - this.originX) / this.cell);
    const r = Math.floor((clientY - rect.top - this.originY) / this.cell);
    if (!this.board.inBounds(r, c) || this.board.at(r, c)!.hole) return null;
    return { r, c };
  }

  /* ---------------------------------------------------------------- *
   * Timeline playback
   * ---------------------------------------------------------------- */

  enqueue(steps: Step[]): void {
    this.queue.push(...steps);
  }

  /** True while animations are still playing; input should stay locked. */
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
        duration = step.valid ? 190 : 360;
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
        duration = 260;
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
        duration = Math.min(520, 130 + maxDrop * 55);
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

    this.active = { step, elapsed: 0, duration, dying, from, to, applied: false };
  }

  /** Particles, score popups and furniture updates for a clear step. */
  private spawnClearEffects(step: Extract<Step, { type: 'clear' }>): void {
    for (const { pos, gem } of step.cleared) {
      const color = gem.kind === GemKind.Ingredient ? '#ffd166' : GEM_COLORS[gem.color % GEM_COLORS.length];
      const count = gem.special === Special.None ? 5 : 12;
      for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i) / count + Math.random();
        const speed = 1.6 + Math.random() * 3.4;
        this.particles.push({
          x: this.originX + (pos.c + 0.5) * this.cell,
          y: this.originY + (pos.r + 0.5) * this.cell,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 1.5,
          life: 1,
          maxLife: 0.5 + Math.random() * 0.4,
          color,
          size: this.cell * (0.06 + Math.random() * 0.08),
        });
      }
    }

    for (const { pos } of step.collected) {
      for (let i = 0; i < 20; i++) {
        const angle = (Math.PI * 2 * i) / 20;
        this.particles.push({
          x: this.originX + (pos.c + 0.5) * this.cell,
          y: this.originY + (pos.r + 0.5) * this.cell,
          vx: Math.cos(angle) * 4,
          vy: Math.sin(angle) * 4 - 2,
          life: 1,
          maxLife: 0.9,
          color: '#ffd166',
          size: this.cell * 0.1,
        });
      }
    }

    if (step.score > 0 && (step.cleared.length || step.collected.length)) {
      const sample = step.cleared[0]?.pos ?? step.collected[0]?.pos;
      if (sample) {
        this.floaters.push({
          x: this.originX + (sample.c + 0.5) * this.cell,
          y: this.originY + (sample.r + 0.3) * this.cell,
          text: `+${step.score}`,
          life: 1,
          color: step.cascade > 1 ? '#ffd166' : '#ffffff',
        });
      }
    }
  }

  /** Commits a finished step to the renderer's own board copy. */
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
        for (const entry of step.jelly) {
          this.jelly[this.index(entry.pos)] = entry.layersLeft;
        }
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
        }
        for (const spawn of step.spawns) {
          const sprite = this.sprites.get(spawn.gem.id);
          if (!sprite) continue;
          sprite.r = spawn.to.r;
          sprite.c = spawn.to.c;
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
      p.vy += dt * 34;
      p.life -= dt / p.maxLife;
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    for (const f of this.floaters) {
      f.y -= dt * 46;
      f.life -= dt * 1.1;
    }
    this.floaters = this.floaters.filter((f) => f.life > 0);

    this.draw();
  }

  private updateActive(t: number): void {
    const { step, from, to, dying } = this.active!;

    if (step.type === 'swap' && !step.valid) {
      // Out and back, with a shake at the turn.
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
      step.type === 'fall' ? easeOutCubic(t) : step.type === 'shuffle' ? easeInOutQuad(t) : easeOutCubic(t);

    for (const [id, start] of from) {
      const sprite = this.sprites.get(id);
      const end = to.get(id);
      if (!sprite || !end) continue;
      sprite.x = start.x + (end.x - start.x) * eased;
      sprite.y = start.y + (end.y - start.y) * eased;
    }

    if (step.type === 'shuffle') {
      const dip = 1 - Math.sin(t * Math.PI) * 0.55;
      for (const sprite of this.sprites.values()) sprite.alpha = dip;
    }

    if (step.type === 'clear') {
      const k = easeInQuad(t);
      for (const sprite of dying) {
        sprite.scale = 1 + k * 0.35 - k * 1.35;
        sprite.alpha = 1 - k;
        sprite.spin = k * 1.6;
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

    this.drawWells();
    this.drawSprites();
    this.drawOverlays();
    this.drawParticles();
    this.drawFloaters();
  }

  /** Cell backgrounds, jelly and blockers. */
  private drawWells(): void {
    const ctx = this.ctx;

    const boardW = this.cell * this.board.width;
    const boardH = this.cell * this.board.height;
    const inset = this.cell * 0.16;
    const frame = ctx.createLinearGradient(0, this.originY, 0, this.originY + boardH);
    frame.addColorStop(0, 'rgba(255,255,255,0.09)');
    frame.addColorStop(1, 'rgba(255,255,255,0.035)');
    ctx.fillStyle = frame;
    this.roundRect(this.originX - inset, this.originY - inset, boardW + inset * 2, boardH + inset * 2, this.cell * 0.4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();

    for (let r = 0; r < this.board.height; r++) {
      for (let c = 0; c < this.board.width; c++) {
        const cell = this.board.at(r, c)!;
        if (cell.hole) continue;
        const x = this.originX + c * this.cell;
        const y = this.originY + r * this.cell;
        const i = r * this.board.width + c;

        ctx.fillStyle = (r + c) % 2 === 0 ? 'rgba(255,255,255,0.055)' : 'rgba(255,255,255,0.03)';
        this.roundRect(x + 1.5, y + 1.5, this.cell - 3, this.cell - 3, this.cell * 0.22);
        ctx.fill();

        const jelly = this.jelly[i];
        if (jelly > 0) {
          ctx.fillStyle = jelly >= 2 ? 'rgba(126, 214, 255, 0.42)' : 'rgba(126, 214, 255, 0.22)';
          this.roundRect(x + 2.5, y + 2.5, this.cell - 5, this.cell - 5, this.cell * 0.2);
          ctx.fill();
          ctx.strokeStyle = jelly >= 2 ? 'rgba(190,240,255,0.65)' : 'rgba(190,240,255,0.35)';
          ctx.lineWidth = jelly >= 2 ? 2 : 1;
          ctx.stroke();
        }

        const blocker = this.blockers[i];
        if (blocker) this.drawBlocker(blocker, x, y);
      }
    }
  }

  private drawBlocker(blocker: Blocker, x: number, y: number): void {
    const ctx = this.ctx;
    const pad = this.cell * 0.08;
    const size = this.cell - pad * 2;

    if (blocker.kind === 'crate') {
      const grad = ctx.createLinearGradient(x, y, x, y + this.cell);
      grad.addColorStop(0, blocker.hp >= 2 ? '#a4703c' : '#c98b4b');
      grad.addColorStop(1, blocker.hp >= 2 ? '#6d4720' : '#8e5c2b');
      ctx.fillStyle = grad;
      this.roundRect(x + pad, y + pad, size, size, this.cell * 0.14);
      ctx.fill();
      ctx.strokeStyle = 'rgba(60,34,12,0.85)';
      ctx.lineWidth = Math.max(2, this.cell * 0.05);
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
    } else {
      const grad = ctx.createRadialGradient(
        x + this.cell * 0.38,
        y + this.cell * 0.34,
        this.cell * 0.08,
        x + this.cell / 2,
        y + this.cell / 2,
        this.cell * 0.55,
      );
      grad.addColorStop(0, '#8d94a6');
      grad.addColorStop(1, '#4a5162');
      ctx.fillStyle = grad;
      this.roundRect(x + pad, y + pad, size, size, this.cell * 0.28);
      ctx.fill();
      ctx.strokeStyle = 'rgba(20,24,34,0.8)';
      ctx.lineWidth = Math.max(2, this.cell * 0.045);
      ctx.stroke();
    }
  }

  private drawSprites(): void {
    for (const sprite of this.sprites.values()) {
      const born = sprite.bornAt >= 0 ? Math.min(1, (this.time - sprite.bornAt) / 0.24) : 1;
      const pop = born < 1 ? 0.4 + easeOutCubic(born) * 0.75 : 1;
      this.drawGem(sprite, sprite.scale * pop);
    }
  }

  private drawGem(sprite: Sprite, scale: number): void {
    const ctx = this.ctx;
    const cx = this.originX + (sprite.x + 0.5) * this.cell;
    const cy = this.originY + (sprite.y + 0.5) * this.cell;
    const radius = this.cell * 0.38 * scale;
    if (radius <= 0.5) return;

    ctx.save();
    ctx.globalAlpha = sprite.alpha;
    ctx.translate(cx, cy);
    if (sprite.spin) ctx.rotate(sprite.spin);

    if (sprite.gem.kind === GemKind.Ingredient) {
      this.drawIngredient(radius);
      ctx.restore();
      return;
    }

    if (sprite.gem.special === Special.Rainbow) {
      this.drawRainbow(radius);
      ctx.restore();
      return;
    }

    const idx = sprite.gem.color % GEM_COLORS.length;
    const light = GEM_COLORS[idx];
    const dark = GEM_DARK[idx];

    const grad = ctx.createLinearGradient(-radius, -radius, radius, radius);
    grad.addColorStop(0, light);
    grad.addColorStop(1, dark);
    ctx.fillStyle = grad;
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = Math.max(1.5, radius * 0.09);

    this.gemPath(idx, radius);
    ctx.fill();
    ctx.stroke();

    // Specular highlight.
    ctx.globalAlpha = sprite.alpha * 0.55;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.ellipse(-radius * 0.28, -radius * 0.38, radius * 0.26, radius * 0.16, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = sprite.alpha;

    if (sprite.gem.special !== Special.None) this.drawSpecialMark(sprite.gem.special, radius);
    ctx.restore();
  }

  /** One silhouette per colour, so hue is never the only signal. */
  private gemPath(idx: number, radius: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    switch (idx) {
      case 0:
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        break;
      case 1: {
        const r = radius * 0.92;
        this.roundRect(-r, -r, r * 2, r * 2, r * 0.34);
        break;
      }
      case 2:
        this.polygon(3, radius * 1.08, -Math.PI / 2);
        break;
      case 3:
        this.polygon(4, radius * 1.06, 0);
        break;
      case 4:
        this.polygon(5, radius * 1.04, -Math.PI / 2);
        break;
      default:
        this.polygon(6, radius * 1.02, 0);
        break;
    }
  }

  private polygon(sides: number, radius: number, rotation: number): void {
    const ctx = this.ctx;
    for (let i = 0; i < sides; i++) {
      const a = rotation + (Math.PI * 2 * i) / sides;
      const x = Math.cos(a) * radius;
      const y = Math.sin(a) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  private drawSpecialMark(special: Special, radius: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = Math.max(2, radius * 0.15);
    ctx.lineCap = 'round';

    if (special === Special.RocketH || special === Special.RocketV) {
      if (special === Special.RocketV) ctx.rotate(Math.PI / 2);
      for (const dy of [-radius * 0.3, 0, radius * 0.3]) {
        ctx.beginPath();
        ctx.moveTo(-radius * 0.6, dy);
        ctx.lineTo(radius * 0.6, dy);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(radius * 0.15, -radius * 0.34);
      ctx.lineTo(radius * 0.62, 0);
      ctx.lineTo(radius * 0.15, radius * 0.34);
      ctx.stroke();
    } else if (special === Special.Bomb) {
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.52, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.2, 0, Math.PI * 2);
      ctx.fill();
      const pulse = 0.6 + Math.sin(this.time * 6) * 0.4;
      ctx.globalAlpha = pulse;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.78, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawRainbow(radius: number): void {
    const ctx = this.ctx;
    const spin = this.time * 1.2;
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, spin + (i * Math.PI) / 3, spin + ((i + 1) * Math.PI) / 3);
      ctx.closePath();
      ctx.fillStyle = GEM_COLORS[i];
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(2, radius * 0.12);
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.24, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawIngredient(radius: number): void {
    const ctx = this.ctx;
    const grad = ctx.createRadialGradient(-radius * 0.3, -radius * 0.4, radius * 0.1, 0, 0, radius);
    grad.addColorStop(0, '#fff3c4');
    grad.addColorStop(0.5, '#ffd166');
    grad.addColorStop(1, '#c98a12');
    ctx.fillStyle = grad;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (Math.PI * 2 * i) / 10;
      const rad = i % 2 === 0 ? radius * 1.1 : radius * 0.5;
      const x = Math.cos(a) * rad;
      const y = Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,74,6,0.85)';
    ctx.lineWidth = Math.max(1.5, radius * 0.1);
    ctx.stroke();
  }

  /** Selection ring, chains, hint pulse and hammer targeting. */
  private drawOverlays(): void {
    const ctx = this.ctx;

    for (let r = 0; r < this.board.height; r++) {
      for (let c = 0; c < this.board.width; c++) {
        if (!this.locked[r * this.board.width + c]) continue;
        const x = this.originX + c * this.cell;
        const y = this.originY + r * this.cell;
        ctx.strokeStyle = 'rgba(226,232,240,0.92)';
        ctx.lineWidth = Math.max(2.5, this.cell * 0.07);
        ctx.lineCap = 'round';
        const inset = this.cell * 0.16;
        ctx.beginPath();
        ctx.moveTo(x + inset, y + inset);
        ctx.lineTo(x + this.cell - inset, y + this.cell - inset);
        ctx.moveTo(x + this.cell - inset, y + inset);
        ctx.lineTo(x + inset, y + this.cell - inset);
        ctx.stroke();
      }
    }

    if (this.selection) {
      const x = this.originX + this.selection.c * this.cell;
      const y = this.originY + this.selection.r * this.cell;
      const pulse = 0.65 + Math.sin(this.time * 8) * 0.35;
      ctx.strokeStyle = `rgba(255,255,255,${pulse})`;
      ctx.lineWidth = Math.max(2.5, this.cell * 0.06);
      this.roundRect(x + 2, y + 2, this.cell - 4, this.cell - 4, this.cell * 0.22);
      ctx.stroke();
    }

    if (this.targeting) {
      const pulse = 0.4 + Math.sin(this.time * 7) * 0.25;
      ctx.fillStyle = `rgba(255,120,120,${pulse * 0.35})`;
      ctx.fillRect(this.originX, this.originY, this.cell * this.board.width, this.cell * this.board.height);
    }

    if (this.hint && !this.busy) {
      const pulse = 0.35 + Math.sin(this.time * 5) * 0.3;
      ctx.strokeStyle = `rgba(255,214,102,${pulse + 0.3})`;
      ctx.lineWidth = Math.max(2.5, this.cell * 0.06);
      for (const p of [this.hint.a, this.hint.b]) {
        const x = this.originX + p.c * this.cell;
        const y = this.originY + p.r * this.cell;
        this.roundRect(x + 3, y + 3, this.cell - 6, this.cell - 6, this.cell * 0.22);
        ctx.stroke();
      }
    }
  }

  private drawParticles(): void {
    const ctx = this.ctx;
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * Math.max(0.2, p.life), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawFloaters(): void {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.font = `700 ${Math.round(this.cell * 0.36)}px ui-rounded, system-ui, sans-serif`;
    for (const f of this.floaters) {
      ctx.globalAlpha = Math.max(0, Math.min(1, f.life));
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
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
