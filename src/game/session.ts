import { Board, ResolveContext } from '../engine/board.js';
import { Rng } from '../engine/rng.js';
import { GemKind, Pos, Special, Step } from '../engine/types.js';
import { LevelDef, Objective, buildBoard, grantStartingSpecials } from './levels.js';

export type SessionState = 'playing' | 'won' | 'lost';
export type PowerupKind = 'hammer' | 'shuffle' | 'freeswap';

/** Score awarded for each unused move once the goals are met. */
const LEFTOVER_MOVE_BONUS = 500;

export interface ObjectiveProgress extends Objective {
  current: number;
  done: boolean;
}

export interface SessionOptions {
  /** Bonus moves from the Deep Pockets upgrade and the +Moves booster. */
  extraMoves?: number;
  /** Specials seeded onto the board by boosters. */
  startingSpecials?: Special[];
  context?: ResolveContext;
  /** Varies the board between replays of the same level. */
  seedOffset?: number;
}

/** One playthrough of one level: board plus goals, moves and power-ups. */
export class LevelSession {
  readonly def: LevelDef;
  readonly board: Board;
  readonly context: ResolveContext;

  movesLeft: number;
  score = 0;
  state: SessionState = 'playing';
  /** Moves that were left over when the level was won. */
  leftoverMoves = 0;

  private readonly collectedByColor: number[];
  private readonly initialBlockers: number;
  private readonly initialJelly: number;
  private readonly progress: ObjectiveProgress[];
  private readonly rng: Rng;

  constructor(def: LevelDef, options: SessionOptions = {}) {
    this.def = def;
    this.rng = new Rng(def.seed ^ ((options.seedOffset ?? 0) * 0x85ebca6b));
    this.board = buildBoard(def, options.seedOffset ?? 0);
    this.context = options.context ?? { cascadeBonus: 0.35, specialLuck: 0, minMoves: 4 };
    this.movesLeft = def.moves + (options.extraMoves ?? 0);

    if (options.startingSpecials?.length) {
      grantStartingSpecials(this.board, this.rng, options.startingSpecials);
    }

    this.collectedByColor = new Array(def.colorCount).fill(0);
    this.initialBlockers = this.board.blockersRemaining();
    this.initialJelly = this.board.jellyRemaining();
    this.progress = def.objectives.map((o) => ({ ...o, current: 0, done: false }));
    this.refreshProgress();
  }

  get objectives(): readonly ObjectiveProgress[] {
    return this.progress;
  }

  /** Player-initiated swap. Costs a move only when it is legal. */
  swap(a: Pos, b: Pos): { valid: boolean; steps: Step[] } {
    if (this.state !== 'playing') return { valid: false, steps: [] };
    const result = this.board.trySwap(a, b, this.context);
    if (result.valid) {
      this.movesLeft--;
      this.ingest(result.steps);
      this.evaluate();
    }
    return result;
  }

  /** Power-ups act on the board without consuming a move. */
  usePowerup(kind: PowerupKind, a?: Pos, b?: Pos): Step[] {
    if (this.state !== 'playing') return [];
    let steps: Step[] = [];
    if (kind === 'hammer' && a) steps = this.board.strike(a, this.context);
    else if (kind === 'shuffle') {
      steps = [this.board.shuffle(this.context.minMoves ?? 1), ...this.board.resolve(this.context, null, [])];
    } else if (kind === 'freeswap' && a && b) steps = this.board.swapForced(a, b, this.context);

    if (steps.length) {
      this.ingest(steps);
      this.evaluate();
    }
    return steps;
  }

  hint(): { a: Pos; b: Pos } | null {
    return this.board.findMove();
  }

  /** Folds a resolution timeline into score and objective progress. */
  private ingest(steps: Step[]): void {
    for (const step of steps) {
      if (step.type !== 'clear') continue;
      this.score += step.score;
      for (const { gem } of step.cleared) {
        if (gem.kind === GemKind.Normal && gem.color < this.collectedByColor.length) {
          this.collectedByColor[gem.color]++;
        }
      }
    }
    this.refreshProgress();
  }

  private refreshProgress(): void {
    for (const p of this.progress) {
      switch (p.type) {
        case 'score':
          p.current = this.score;
          break;
        case 'collect':
          p.current = this.collectedByColor[p.color ?? 0] ?? 0;
          break;
        case 'jelly':
          p.current = Math.max(0, this.initialJelly - this.board.jellyRemaining());
          break;
        case 'blockers':
          p.current = Math.max(0, this.initialBlockers - this.board.blockersRemaining());
          break;
        case 'ingredients':
          p.current = this.board.ingredientsCollected;
          break;
      }
      p.done = p.current >= p.target;
    }
  }

  private evaluate(): void {
    if (this.state !== 'playing') return;
    if (this.progress.every((p) => p.done)) {
      this.state = 'won';
      this.leftoverMoves = Math.max(0, this.movesLeft);
      this.score += this.leftoverMoves * LEFTOVER_MOVE_BONUS;
      this.refreshProgress();
      return;
    }
    if (this.movesLeft <= 0) this.state = 'lost';
  }

  /** 0-3, from the level's score thresholds. */
  stars(): number {
    const [one, two, three] = this.def.starScores;
    if (this.score >= three) return 3;
    if (this.score >= two) return 2;
    if (this.score >= one) return 1;
    return 0;
  }

  /** How close the player got, for the "so close!" copy on the fail screen. */
  completion(): number {
    if (!this.progress.length) return 1;
    const total = this.progress.reduce(
      (sum, p) => sum + Math.min(1, p.target === 0 ? 1 : p.current / p.target),
      0,
    );
    return total / this.progress.length;
  }

  /** Objectives still unmet, for the fail screen. */
  remaining(): ObjectiveProgress[] {
    return this.progress.filter((p) => !p.done);
  }
}
