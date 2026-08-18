import { Rng } from './rng.js';
import {
  BlockerKind,
  BoardConfig,
  Cell,
  ClearStep,
  FallStep,
  Gem,
  GemKind,
  Pos,
  Special,
  Step,
  isAdjacent,
} from './types.js';

/** Tunables the upgrade tree feeds into the engine. */
export interface ResolveContext {
  /** Extra score multiplier added per cascade beyond the first. */
  cascadeBonus: number;
  /** Chance a plain 3-match also yields a rocket. */
  specialLuck: number;
  /**
   * Reshuffle whenever fewer than this many legal moves remain. Clears only
   * disturb the cells above them, so a region with no moves can never gain
   * one on its own — without this, the bottom rows freeze permanently and
   * goals that need them (ingredients, low jelly) become unreachable.
   */
  minMoves?: number;
}

export const DEFAULT_CONTEXT: ResolveContext = { cascadeBonus: 0.35, specialLuck: 0, minMoves: 4 };

const SCORE_PER_GEM = 60;
const SCORE_PER_DETONATION = 120;
const SCORE_PER_BLOCKER = 90;
const SCORE_PER_JELLY = 110;
const SCORE_PER_INGREDIENT = 1000;

interface MatchGroup {
  cells: Pos[];
  color: number;
  maxH: number;
  maxV: number;
  /** Longest horizontal run, for placing a horizontal rocket. */
  hRun: Pos[] | null;
  vRun: Pos[] | null;
}

export class Board {
  readonly width: number;
  readonly height: number;
  readonly colorCount: number;
  readonly spawnColumns: number[];
  readonly exits: Pos[];
  readonly cells: Cell[];

  private rng: Rng;
  private nextId = 1;
  /** Ingredients still to be spawned from the top, decremented on each spawn. */
  ingredientQueue = 0;
  /** Cap on how many ingredients may sit on the board at the same time. */
  maxIngredientsOnBoard = 2;
  private spawnedIngredientThisFall = false;
  /** Ingredients that fell off the board this level. */
  ingredientsCollected = 0;

  constructor(config: BoardConfig, rng: Rng, holes: boolean[] = []) {
    this.width = config.width;
    this.height = config.height;
    this.colorCount = config.colorCount;
    this.spawnColumns = config.spawnColumns.slice();
    this.exits = config.exits.map((p) => ({ ...p }));
    this.rng = rng;
    this.cells = new Array(this.width * this.height);
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i] = { hole: holes[i] === true, gem: null, jelly: 0, blocker: null, locked: false };
    }
  }

  /** Deep copy, used to score candidate moves without touching the real board. */
  clone(): Board {
    const copy = Object.create(Board.prototype) as Board;
    const self = this as unknown as Record<string, unknown>;
    const dst = copy as unknown as Record<string, unknown>;
    for (const key of Object.keys(self)) dst[key] = self[key];
    dst.rng = this.rng.clone();
    dst.spawnColumns = this.spawnColumns.slice();
    dst.exits = this.exits.map((p) => ({ ...p }));
    dst.cells = this.cells.map((cell) => ({
      hole: cell.hole,
      gem: cell.gem ? { ...cell.gem } : null,
      jelly: cell.jelly,
      blocker: cell.blocker ? { ...cell.blocker } : null,
      locked: cell.locked,
    }));
    return copy;
  }

  /* ---------------------------------------------------------------- *
   * Cell access
   * ---------------------------------------------------------------- */

  idx(r: number, c: number): number {
    return r * this.width + c;
  }

  inBounds(r: number, c: number): boolean {
    return r >= 0 && r < this.height && c >= 0 && c < this.width;
  }

  at(r: number, c: number): Cell | null {
    return this.inBounds(r, c) ? this.cells[this.idx(r, c)] : null;
  }

  /** A cell gems can occupy: on the board and not a hole. */
  playable(r: number, c: number): boolean {
    const cell = this.at(r, c);
    return cell !== null && !cell.hole;
  }

  gemAt(r: number, c: number): Gem | null {
    const cell = this.at(r, c);
    return cell && !cell.hole ? cell.gem : null;
  }

  /** A normal gem that participates in colour matching. */
  private matchable(r: number, c: number): Gem | null {
    const gem = this.gemAt(r, c);
    if (!gem) return null;
    if (gem.kind !== GemKind.Normal) return null;
    if (gem.special === Special.Rainbow) return null;
    return gem;
  }

  makeGem(color: number, special: Special = Special.None, kind: GemKind = GemKind.Normal): Gem {
    return { kind, color, special, id: this.nextId++ };
  }

  /* ---------------------------------------------------------------- *
   * Initial fill
   * ---------------------------------------------------------------- */

  /** Fills every empty playable cell with gems that form no immediate match. */
  fillInitial(colorWeights?: number[]): void {
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        const cell = this.at(r, c)!;
        if (cell.hole || cell.blocker || cell.gem) continue;
        cell.gem = this.rollSafeGem(r, c, colorWeights);
      }
    }
    this.ensureSolvable();
  }

  /** Guarantees the opening board has no free matches and at least one legal move. */
  private ensureSolvable(minMoves = 4): void {
    for (let guard = 0; guard < 40; guard++) {
      if (!this.findMatchGroups().length && this.countMoves(minMoves) >= minMoves) return;
      this.shuffle(minMoves);
    }
  }

  /** A random gem that does not complete a run of three at (r, c). */
  private rollSafeGem(r: number, c: number, colorWeights?: number[]): Gem {
    const banned = new Set<number>();
    const left1 = this.matchable(r, c - 1);
    const left2 = this.matchable(r, c - 2);
    if (left1 && left2 && left1.color === left2.color) banned.add(left1.color);
    const up1 = this.matchable(r - 1, c);
    const up2 = this.matchable(r - 2, c);
    if (up1 && up2 && up1.color === up2.color) banned.add(up1.color);

    const options: number[] = [];
    for (let color = 0; color < this.colorCount; color++) {
      if (!banned.has(color)) options.push(color);
    }
    const pool = options.length ? options : [this.rng.int(this.colorCount)];
    if (colorWeights) {
      const weights = pool.map((color) => colorWeights[color] ?? 1);
      return this.makeGem(pool[this.rng.weighted(weights)]);
    }
    return this.makeGem(this.rng.pick(pool));
  }

  /* ---------------------------------------------------------------- *
   * Match detection
   * ---------------------------------------------------------------- */

  private findRuns(): { cells: Pos[]; horizontal: boolean; color: number }[] {
    const runs: { cells: Pos[]; horizontal: boolean; color: number }[] = [];

    for (let r = 0; r < this.height; r++) {
      let start = 0;
      while (start < this.width) {
        const gem = this.matchable(r, start);
        if (!gem) {
          start++;
          continue;
        }
        let end = start + 1;
        while (end < this.width) {
          const next = this.matchable(r, end);
          if (!next || next.color !== gem.color) break;
          end++;
        }
        if (end - start >= 3) {
          const cells: Pos[] = [];
          for (let c = start; c < end; c++) cells.push({ r, c });
          runs.push({ cells, horizontal: true, color: gem.color });
        }
        start = end;
      }
    }

    for (let c = 0; c < this.width; c++) {
      let start = 0;
      while (start < this.height) {
        const gem = this.matchable(start, c);
        if (!gem) {
          start++;
          continue;
        }
        let end = start + 1;
        while (end < this.height) {
          const next = this.matchable(end, c);
          if (!next || next.color !== gem.color) break;
          end++;
        }
        if (end - start >= 3) {
          const cells: Pos[] = [];
          for (let r = start; r < end; r++) cells.push({ r, c });
          runs.push({ cells, horizontal: false, color: gem.color });
        }
        start = end;
      }
    }

    return runs;
  }

  /** Runs merged into groups, so an L/T shape is recognised as one match. */
  findMatchGroups(): MatchGroup[] {
    const runs = this.findRuns();
    if (!runs.length) return [];

    const owner = new Map<number, number>(); // cell index -> group id
    const groups: MatchGroup[] = [];

    for (const run of runs) {
      // Any existing group sharing a cell absorbs this run.
      let target = -1;
      for (const p of run.cells) {
        const found = owner.get(this.idx(p.r, p.c));
        if (found !== undefined) {
          target = found;
          break;
        }
      }
      if (target === -1) {
        target = groups.length;
        groups.push({ cells: [], color: run.color, maxH: 0, maxV: 0, hRun: null, vRun: null });
      }
      const group = groups[target];
      for (const p of run.cells) {
        const key = this.idx(p.r, p.c);
        if (!owner.has(key)) {
          owner.set(key, target);
          group.cells.push(p);
        }
      }
      if (run.horizontal) {
        if (run.cells.length > group.maxH) {
          group.maxH = run.cells.length;
          group.hRun = run.cells;
        }
      } else if (run.cells.length > group.maxV) {
        group.maxV = run.cells.length;
        group.vRun = run.cells;
      }
    }

    return groups.filter((g) => g.cells.length > 0);
  }

  /* ---------------------------------------------------------------- *
   * Swapping
   * ---------------------------------------------------------------- */

  /** Can the player pick this cell up at all? */
  swappable(p: Pos): boolean {
    const cell = this.at(p.r, p.c);
    if (!cell || cell.hole || cell.blocker || cell.locked || !cell.gem) return false;
    return cell.gem.kind === GemKind.Normal;
  }

  private rawSwap(a: Pos, b: Pos): void {
    const ca = this.at(a.r, a.c)!;
    const cb = this.at(b.r, b.c)!;
    [ca.gem, cb.gem] = [cb.gem, ca.gem];
  }

  /** Does the gem now sitting at `p` complete a run? */
  private matchesAt(p: Pos): boolean {
    const gem = this.matchable(p.r, p.c);
    if (!gem) return false;

    let count = 1;
    for (let c = p.c - 1; c >= 0 && this.matchable(p.r, c)?.color === gem.color; c--) count++;
    for (let c = p.c + 1; c < this.width && this.matchable(p.r, c)?.color === gem.color; c++) count++;
    if (count >= 3) return true;

    count = 1;
    for (let r = p.r - 1; r >= 0 && this.matchable(r, p.c)?.color === gem.color; r--) count++;
    for (let r = p.r + 1; r < this.height && this.matchable(r, p.c)?.color === gem.color; r++) count++;
    return count >= 3;
  }

  /** A pairing of two specials (or a rainbow with anything) always fires. */
  private isComboSwap(a: Pos, b: Pos): boolean {
    const ga = this.gemAt(a.r, a.c);
    const gb = this.gemAt(b.r, b.c);
    if (!ga || !gb) return false;
    if (ga.special === Special.Rainbow || gb.special === Special.Rainbow) return true;
    return ga.special !== Special.None && gb.special !== Special.None;
  }

  /**
   * Attempts the swap. On success returns the full animation timeline;
   * on failure returns a single bounced-swap step and leaves the board untouched.
   */
  trySwap(a: Pos, b: Pos, ctx: ResolveContext = DEFAULT_CONTEXT): { valid: boolean; steps: Step[] } {
    if (!isAdjacent(a, b) || !this.swappable(a) || !this.swappable(b)) {
      return { valid: false, steps: [] };
    }

    if (this.isComboSwap(a, b)) {
      const seeds = this.comboSeeds(a, b);
      this.rawSwap(a, b);
      const steps: Step[] = [{ type: 'swap', a, b, valid: true }];
      steps.push(...this.resolve(ctx, seeds, [a, b]));
      return { valid: true, steps };
    }

    this.rawSwap(a, b);
    if (!this.matchesAt(a) && !this.matchesAt(b)) {
      this.rawSwap(a, b);
      return { valid: false, steps: [{ type: 'swap', a, b, valid: false }] };
    }

    const steps: Step[] = [{ type: 'swap', a, b, valid: true }];
    steps.push(...this.resolve(ctx, null, [a, b]));
    return { valid: true, steps };
  }

  /**
   * Swaps two adjacent gems regardless of whether a match results
   * (the Free Swap power-up).
   */
  swapForced(a: Pos, b: Pos, ctx: ResolveContext = DEFAULT_CONTEXT): Step[] {
    if (!isAdjacent(a, b) || !this.swappable(a) || !this.swappable(b)) return [];
    if (this.isComboSwap(a, b)) {
      const seeds = this.comboSeeds(a, b);
      this.rawSwap(a, b);
      return [{ type: 'swap', a, b, valid: true } as Step, ...this.resolve(ctx, seeds, [a, b])];
    }
    this.rawSwap(a, b);
    return [{ type: 'swap', a, b, valid: true } as Step, ...this.resolve(ctx, null, [a, b])];
  }

  /** Destroys whatever sits at `p` (the Hammer power-up). */
  strike(p: Pos, ctx: ResolveContext = DEFAULT_CONTEXT): Step[] {
    const cell = this.at(p.r, p.c);
    if (!cell || cell.hole || (!cell.gem && !cell.blocker)) return [];
    if (cell.locked) cell.locked = false;
    return this.resolve(ctx, [p], []);
  }

  /** Cells a special-on-special swap should destroy. */
  private comboSeeds(a: Pos, b: Pos): Pos[] {
    const ga = this.gemAt(a.r, a.c)!;
    const gb = this.gemAt(b.r, b.c)!;
    const seeds: Pos[] = [];
    const push = (r: number, c: number) => {
      if (this.playable(r, c)) seeds.push({ r, c });
    };

    const rainbowA = ga.special === Special.Rainbow;
    const rainbowB = gb.special === Special.Rainbow;

    if (rainbowA && rainbowB) {
      for (let r = 0; r < this.height; r++) for (let c = 0; c < this.width; c++) push(r, c);
      return seeds;
    }

    if (rainbowA || rainbowB) {
      const other = rainbowA ? gb : ga;
      const otherPos = rainbowA ? b : a;
      // Rainbow + special: upgrade every gem of that colour, then fire them all.
      if (other.special !== Special.None) {
        for (let r = 0; r < this.height; r++) {
          for (let c = 0; c < this.width; c++) {
            const gem = this.matchable(r, c);
            if (gem && gem.color === other.color) {
              gem.special =
                other.special === Special.Bomb
                  ? Special.Bomb
                  : this.rng.chance(0.5)
                    ? Special.RocketH
                    : Special.RocketV;
              push(r, c);
            }
          }
        }
      } else {
        for (let r = 0; r < this.height; r++) {
          for (let c = 0; c < this.width; c++) {
            const gem = this.matchable(r, c);
            if (gem && gem.color === other.color) push(r, c);
          }
        }
      }
      push(otherPos.r, otherPos.c);
      push(rainbowA ? a.r : b.r, rainbowA ? a.c : b.c);
      return seeds;
    }

    const isRocket = (s: Special) => s === Special.RocketH || s === Special.RocketV;
    const rocketCount = (isRocket(ga.special) ? 1 : 0) + (isRocket(gb.special) ? 1 : 0);
    const bombCount = (ga.special === Special.Bomb ? 1 : 0) + (gb.special === Special.Bomb ? 1 : 0);
    // After the swap `b` holds gem A; centre the blast on b.
    const cr = b.r;
    const cc = b.c;

    if (rocketCount === 2) {
      for (let c = 0; c < this.width; c++) push(cr, c);
      for (let r = 0; r < this.height; r++) push(r, cc);
    } else if (rocketCount === 1 && bombCount === 1) {
      for (let dr = -1; dr <= 1; dr++) for (let c = 0; c < this.width; c++) push(cr + dr, c);
      for (let dc = -1; dc <= 1; dc++) for (let r = 0; r < this.height; r++) push(r, cc + dc);
    } else {
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) push(cr + dr, cc + dc);
    }
    return seeds;
  }

  /* ---------------------------------------------------------------- *
   * Resolution
   * ---------------------------------------------------------------- */

  /**
   * Runs matches, gravity and cascades until the board is stable,
   * reshuffling if the result has no legal move left.
   */
  resolve(ctx: ResolveContext, initialSeeds: Pos[] | null, origins: Pos[] = []): Step[] {
    const steps: Step[] = [];
    let cascade = 1;
    let seeds = initialSeeds;

    for (let guard = 0; guard < 200; guard++) {
      let step: ClearStep | null;
      if (seeds) {
        step = this.clearCells(seeds, [], cascade, ctx);
        seeds = null;
      } else {
        const groups = this.findMatchGroups();
        if (!groups.length) break;
        step = this.clearGroups(groups, cascade, ctx, cascade === 1 ? origins : []);
      }
      if (!step) break;
      steps.push(step);

      const fall = this.applyGravity();
      if (fall) steps.push(fall);

      const collect = this.collectIngredients(cascade);
      if (collect) {
        steps.push(collect);
        const afterCollect = this.applyGravity();
        if (afterCollect) steps.push(afterCollect);
      }
      cascade++;
    }

    const floor = Math.max(1, ctx.minMoves ?? 1);
    for (let guard = 0; guard < 12 && this.countMoves(floor) < floor; guard++) {
      steps.push(this.shuffle(floor));
    }
    return steps;
  }

  /** Turns match groups into a clear step, minting specials for 4+ matches. */
  private clearGroups(
    groups: MatchGroup[],
    cascade: number,
    ctx: ResolveContext,
    origins: Pos[],
  ): ClearStep | null {
    const seeds: Pos[] = [];
    const created: { pos: Pos; gem: Gem }[] = [];

    for (const group of groups) {
      const special = this.specialFor(group, ctx);
      if (special !== Special.None) {
        const pos = this.specialPosition(group, origins, special);
        created.push({ pos, gem: this.makeGem(group.color, special) });
      }
      seeds.push(...group.cells);
    }

    return this.clearCells(seeds, created, cascade, ctx);
  }

  private specialFor(group: MatchGroup, ctx: ResolveContext): Special {
    if (group.maxH >= 5 || group.maxV >= 5) return Special.Rainbow;
    if (group.maxH >= 3 && group.maxV >= 3) return Special.Bomb;
    if (group.maxH === 4) return Special.RocketH;
    if (group.maxV === 4) return Special.RocketV;
    if (ctx.specialLuck > 0 && this.rng.chance(ctx.specialLuck)) {
      return this.rng.chance(0.5) ? Special.RocketH : Special.RocketV;
    }
    return Special.None;
  }

  /** Prefer the cell the player moved, then the L/T corner, then the run centre. */
  private specialPosition(group: MatchGroup, origins: Pos[], special: Special): Pos {
    for (const o of origins) {
      if (group.cells.some((p) => p.r === o.r && p.c === o.c)) return o;
    }
    if (special === Special.Bomb && group.hRun && group.vRun) {
      for (const h of group.hRun) {
        if (group.vRun.some((v) => v.r === h.r && v.c === h.c)) return h;
      }
    }
    const run =
      special === Special.RocketV ? group.vRun ?? group.cells : group.hRun ?? group.cells;
    return run[Math.floor(run.length / 2)];
  }

  /**
   * Expands `seeds` through special-gem chain reactions and applies the
   * result to the board.
   */
  private clearCells(
    seeds: Pos[],
    created: { pos: Pos; gem: Gem }[],
    cascade: number,
    ctx: ResolveContext,
  ): ClearStep | null {
    const protectedCells = new Set(created.map((c) => this.idx(c.pos.r, c.pos.c)));
    const clearSet = new Set<number>();
    const detonated = new Set<number>();
    const detonations: { pos: Pos; special: Special; color: number }[] = [];
    const unlocked: Pos[] = [];
    const blockerDamage = new Map<number, number>();

    const queue: Pos[] = [];
    const enqueue = (p: Pos) => {
      if (!this.playable(p.r, p.c)) return;
      queue.push(p);
    };
    seeds.forEach(enqueue);

    while (queue.length) {
      const p = queue.shift()!;
      const key = this.idx(p.r, p.c);
      const cell = this.cells[key];

      if (cell.blocker) {
        blockerDamage.set(key, (blockerDamage.get(key) ?? 0) + 1);
        continue;
      }
      if (!cell.gem || clearSet.has(key)) continue;

      // A chained gem spends the hit breaking its chain instead of clearing.
      if (cell.locked) {
        if (!unlocked.some((u) => u.r === p.r && u.c === p.c)) unlocked.push(p);
        continue;
      }
      if (protectedCells.has(key)) continue;

      clearSet.add(key);

      const gem = cell.gem;
      if (gem.special !== Special.None && !detonated.has(key)) {
        detonated.add(key);
        detonations.push({ pos: p, special: gem.special, color: gem.color });
        for (const t of this.blastArea(p, gem)) enqueue(t);
      }
      // Ordinary clears chip the crates beside them.
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nb = this.at(p.r + dr, p.c + dc);
        if (nb && !nb.hole && nb.blocker && nb.blocker.kind === 'crate') {
          const nk = this.idx(p.r + dr, p.c + dc);
          if (!blockerDamage.has(nk)) blockerDamage.set(nk, 1);
        }
      }
    }

    if (!clearSet.size && !blockerDamage.size && !unlocked.length) return null;

    const step: ClearStep = {
      type: 'clear',
      cleared: [],
      detonations,
      damaged: [],
      created: [],
      jelly: [],
      unlocked,
      collected: [],
      score: 0,
      cascade,
    };

    let raw = 0;
    for (const key of clearSet) {
      const cell = this.cells[key];
      const pos = { r: Math.floor(key / this.width), c: key % this.width };
      step.cleared.push({ pos, gem: cell.gem! });
      cell.gem = null;
      raw += SCORE_PER_GEM;
      if (cell.jelly > 0) {
        cell.jelly--;
        step.jelly.push({ pos, layersLeft: cell.jelly });
        raw += SCORE_PER_JELLY;
      }
    }

    for (const [key, hits] of blockerDamage) {
      const cell = this.cells[key];
      if (!cell.blocker) continue;
      const kind: BlockerKind = cell.blocker.kind;
      cell.blocker.hp -= hits;
      const destroyed = cell.blocker.hp <= 0;
      const pos = { r: Math.floor(key / this.width), c: key % this.width };
      step.damaged.push({ pos, kind, hpLeft: Math.max(0, cell.blocker.hp), destroyed });
      raw += SCORE_PER_BLOCKER;
      if (destroyed) {
        cell.blocker = null;
        if (cell.jelly > 0) {
          cell.jelly--;
          step.jelly.push({ pos, layersLeft: cell.jelly });
        }
      }
    }

    for (const p of unlocked) this.cells[this.idx(p.r, p.c)].locked = false;

    for (const c of created) {
      const cell = this.cells[this.idx(c.pos.r, c.pos.c)];
      cell.gem = c.gem;
      step.created.push(c);
      raw += SCORE_PER_DETONATION;
    }

    raw += detonations.length * SCORE_PER_DETONATION;
    step.score = Math.round(raw * (1 + ctx.cascadeBonus * (cascade - 1)));
    return step;
  }

  private blastArea(p: Pos, gem: Gem): Pos[] {
    const out: Pos[] = [];
    const push = (r: number, c: number) => {
      if (this.playable(r, c)) out.push({ r, c });
    };
    switch (gem.special) {
      case Special.RocketH:
        for (let c = 0; c < this.width; c++) push(p.r, c);
        break;
      case Special.RocketV:
        for (let r = 0; r < this.height; r++) push(r, p.c);
        break;
      case Special.Bomb:
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) push(p.r + dr, p.c + dc);
        break;
      case Special.Rainbow: {
        // Caught in a chain reaction: takes out the most common colour.
        const counts = new Array(this.colorCount).fill(0);
        for (let r = 0; r < this.height; r++) {
          for (let c = 0; c < this.width; c++) {
            const g = this.matchable(r, c);
            if (g) counts[g.color]++;
          }
        }
        let best = 0;
        for (let i = 1; i < counts.length; i++) if (counts[i] > counts[best]) best = i;
        for (let r = 0; r < this.height; r++) {
          for (let c = 0; c < this.width; c++) {
            if (this.matchable(r, c)?.color === best) push(r, c);
          }
        }
        break;
      }
      default:
        break;
    }
    return out;
  }

  /* ---------------------------------------------------------------- *
   * Gravity
   * ---------------------------------------------------------------- */

  /** Settles the board, merging each gem's micro-steps into one from→to move. */
  applyGravity(): FallStep | null {
    this.spawnedIngredientThisFall = false;
    const origin = new Map<number, Pos>();
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        const gem = this.gemAt(r, c);
        if (gem) origin.set(gem.id, { r, c });
      }
    }

    const spawnOrigin = new Map<number, number>(); // gem id -> row above the board
    const spawnDepth = new Map<number, number>(); // column -> gems spawned so far
    let moved = false;

    for (let pass = 0; pass < this.width * this.height + 8; pass++) {
      let movedThisPass = false;

      for (let r = this.height - 1; r >= 0; r--) {
        for (let c = 0; c < this.width; c++) {
          const cell = this.at(r, c)!;
          if (cell.hole || cell.blocker || cell.gem) continue;

          const above = this.at(r - 1, c);
          if (above && !above.hole && above.gem && !above.blocker) {
            cell.gem = above.gem;
            above.gem = null;
            movedThisPass = true;
            continue;
          }

          // Straight path is a hole, a blocker or off-board — slide in diagonally.
          if (!above || above.hole || above.blocker) {
            const order = (r + c) % 2 === 0 ? [-1, 1] : [1, -1];
            for (const dc of order) {
              const src = this.at(r - 1, c + dc);
              if (!src || src.hole || src.blocker || !src.gem) continue;
              // Only slide if it cannot simply fall straight down.
              const under = this.at(r, c + dc);
              if (under && !under.hole && !under.blocker && !under.gem) continue;
              cell.gem = src.gem;
              src.gem = null;
              movedThisPass = true;
              break;
            }
          }
        }
      }

      for (const c of this.spawnColumns) {
        const topRow = this.topPlayableRow(c);
        if (topRow < 0) continue;
        const cell = this.at(topRow, c)!;
        if (cell.blocker || cell.gem) continue;
        const gem = this.rollSpawn(c);
        cell.gem = gem;
        const depth = (spawnDepth.get(c) ?? 0) + 1;
        spawnDepth.set(c, depth);
        spawnOrigin.set(gem.id, topRow - depth);
        movedThisPass = true;
      }

      if (!movedThisPass) break;
      moved = true;
    }

    if (!moved) return null;

    const step: FallStep = { type: 'fall', moves: [], spawns: [] };
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        const gem = this.gemAt(r, c);
        if (!gem) continue;
        const from = origin.get(gem.id);
        if (from) {
          if (from.r !== r || from.c !== c) step.moves.push({ from, to: { r, c }, id: gem.id });
        } else {
          step.spawns.push({ to: { r, c }, gem, fromRow: spawnOrigin.get(gem.id) ?? -1 });
        }
      }
    }
    return step.moves.length || step.spawns.length ? step : null;
  }

  private topPlayableRow(c: number): number {
    for (let r = 0; r < this.height; r++) {
      if (!this.at(r, c)!.hole) return r;
    }
    return -1;
  }

  /**
   * Ingredients drip in rather than flooding the board: at most one per
   * settle, and never more than `maxIngredientsOnBoard` in play at once.
   */
  private rollSpawn(_c: number): Gem {
    if (
      this.ingredientQueue > 0 &&
      !this.spawnedIngredientThisFall &&
      this.countIngredientsOnBoard() < this.maxIngredientsOnBoard &&
      this.rng.chance(0.85)
    ) {
      this.ingredientQueue--;
      this.spawnedIngredientThisFall = true;
      return this.makeGem(0, Special.None, GemKind.Ingredient);
    }
    return this.makeGem(this.rng.int(this.colorCount));
  }

  private countIngredientsOnBoard(): number {
    let n = 0;
    for (const cell of this.cells) {
      if (cell.gem && cell.gem.kind === GemKind.Ingredient) n++;
    }
    return n;
  }

  /** Removes ingredients that have reached an exit cell. */
  private collectIngredients(cascade: number): ClearStep | null {
    if (!this.exits.length) return null;
    const collected: { pos: Pos; gem: Gem }[] = [];
    for (const exit of this.exits) {
      const cell = this.at(exit.r, exit.c);
      if (!cell || cell.hole || !cell.gem) continue;
      if (cell.gem.kind !== GemKind.Ingredient) continue;
      collected.push({ pos: { ...exit }, gem: cell.gem });
      cell.gem = null;
      this.ingredientsCollected++;
    }
    if (!collected.length) return null;
    return {
      type: 'clear',
      cleared: [],
      detonations: [],
      damaged: [],
      created: [],
      jelly: [],
      unlocked: [],
      collected,
      score: collected.length * SCORE_PER_INGREDIENT,
      cascade,
    };
  }

  /* ---------------------------------------------------------------- *
   * Deadlocks and hints
   * ---------------------------------------------------------------- */

  /** First legal swap found, or null when the board is dead. */
  findMove(): { a: Pos; b: Pos } | null {
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        const a = { r, c };
        if (!this.swappable(a)) continue;
        for (const [dr, dc] of [[0, 1], [1, 0]] as const) {
          const b = { r: r + dr, c: c + dc };
          if (!this.swappable(b)) continue;
          if (this.isComboSwap(a, b)) return { a, b };
          this.rawSwap(a, b);
          const ok = this.matchesAt(a) || this.matchesAt(b);
          this.rawSwap(a, b);
          if (ok) return { a, b };
        }
      }
    }
    return null;
  }

  /** Every legal swap on the board. */
  findMoves(): { a: Pos; b: Pos }[] {
    const out: { a: Pos; b: Pos }[] = [];
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        const a = { r, c };
        if (!this.swappable(a)) continue;
        for (const [dr, dc] of [[0, 1], [1, 0]] as const) {
          const b = { r: r + dr, c: c + dc };
          if (!this.swappable(b)) continue;
          if (this.isComboSwap(a, b)) {
            out.push({ a, b });
            continue;
          }
          this.rawSwap(a, b);
          const ok = this.matchesAt(a) || this.matchesAt(b);
          this.rawSwap(a, b);
          if (ok) out.push({ a, b });
        }
      }
    }
    return out;
  }

  hasMove(): boolean {
    return this.findMove() !== null;
  }

  /** Number of legal swaps, stopping early once `limit` have been found. */
  countMoves(limit = Infinity): number {
    let found = 0;
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        const a = { r, c };
        if (!this.swappable(a)) continue;
        for (const [dr, dc] of [[0, 1], [1, 0]] as const) {
          const b = { r: r + dr, c: c + dc };
          if (!this.swappable(b)) continue;
          let ok = this.isComboSwap(a, b);
          if (!ok) {
            this.rawSwap(a, b);
            ok = this.matchesAt(a) || this.matchesAt(b);
            this.rawSwap(a, b);
          }
          if (ok && ++found >= limit) return found;
        }
      }
    }
    return found;
  }

  /** Redistributes the movable gems until at least `minMoves` swaps exist. */
  shuffle(minMoves = 1): Step {
    const positions: Pos[] = [];
    const gems: Gem[] = [];
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        const cell = this.at(r, c)!;
        if (cell.hole || cell.blocker || cell.locked || !cell.gem) continue;
        if (cell.gem.kind !== GemKind.Normal) continue;
        positions.push({ r, c });
        gems.push(cell.gem);
      }
    }

    for (let attempt = 0; attempt < 60; attempt++) {
      this.rng.shuffle(gems);
      positions.forEach((p, i) => {
        this.cells[this.idx(p.r, p.c)].gem = gems[i];
      });
      if (!this.findMatchGroups().length && this.countMoves(minMoves) >= minMoves) break;
    }

    const layout = positions.map((p) => ({ pos: p, gem: this.cells[this.idx(p.r, p.c)].gem! }));
    return { type: 'shuffle', layout };
  }

  /* ---------------------------------------------------------------- *
   * Level-goal queries
   * ---------------------------------------------------------------- */

  jellyRemaining(): number {
    let total = 0;
    for (const cell of this.cells) total += cell.jelly;
    return total;
  }

  blockersRemaining(): number {
    let total = 0;
    for (const cell of this.cells) if (cell.blocker) total++;
    return total;
  }

  /** Ingredients on the board plus those still queued to spawn. */
  ingredientsInPlay(): number {
    let total = this.ingredientQueue;
    for (const cell of this.cells) {
      if (cell.gem && cell.gem.kind === GemKind.Ingredient) total++;
    }
    return total;
  }
}
