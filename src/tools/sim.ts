/**
 * Headless balance harness. Plays every level with a heuristic bot and
 * reports win rates, so the difficulty curve can be measured rather than
 * assumed. Run with `npm run sim`.
 */
import { Board } from '../engine/board.js';
import { Rng } from '../engine/rng.js';
import { GemKind, Pos } from '../engine/types.js';
import { LevelDef, TOTAL_LEVELS, allLevels, isBossLevel } from '../game/levels.js';
import { LevelSession } from '../game/session.js';

interface Snapshot {
  jelly: number;
  blockers: number;
  ingredients: number;
  ingredientDepth: number;
  colors: number[];
  score: number;
}

/** Sum of ingredient row indices — higher means closer to the exits. */
function ingredientDepth(board: Board): number {
  let depth = 0;
  for (let r = 0; r < board.height; r++) {
    for (let c = 0; c < board.width; c++) {
      const gem = board.gemAt(r, c);
      if (gem && gem.kind === GemKind.Ingredient) depth += r;
    }
  }
  return depth;
}

function snapshot(board: Board, colorCount: number): Snapshot {
  return {
    jelly: board.jellyRemaining(),
    blockers: board.blockersRemaining(),
    ingredients: board.ingredientsCollected,
    ingredientDepth: ingredientDepth(board),
    colors: new Array(colorCount).fill(0),
    score: 0,
  };
}

/** How much a candidate move advances this level's goals. */
function scoreMove(board: Board, def: LevelDef, move: { a: Pos; b: Pos }): number {
  const trial = board.clone();
  const before = snapshot(trial, def.colorCount);
  const result = trial.trySwap(move.a, move.b);
  if (!result.valid) return -1;

  let gained = 0;
  const cleared = new Array(def.colorCount).fill(0);
  let specialsMade = 0;
  for (const step of result.steps) {
    if (step.type !== 'clear') continue;
    gained += step.score;
    specialsMade += step.created.length;
    for (const { gem } of step.cleared) {
      if (gem.kind === GemKind.Normal && gem.color < cleared.length) cleared[gem.color]++;
    }
  }

  let utility = gained * 0.02 + specialsMade * 40;
  for (const objective of def.objectives) {
    switch (objective.type) {
      case 'jelly':
        utility += (before.jelly - trial.jellyRemaining()) * 120;
        break;
      case 'blockers':
        utility += (before.blockers - trial.blockersRemaining()) * 130;
        break;
      case 'ingredients':
        utility += (trial.ingredientsCollected - before.ingredients) * 900;
        // Clearing underneath an ingredient is progress even before it lands.
        utility += (ingredientDepth(trial) - before.ingredientDepth) * 60;
        break;
      case 'collect':
        utility += cleared[objective.color ?? 0] * 45;
        break;
      case 'score':
        utility += gained * 0.05;
        break;
    }
  }
  return utility;
}

/** Plays one level to completion. `skill` in 0..1 controls move quality. */
function playLevel(
  def: LevelDef,
  seedOffset: number,
  skill: number,
  rng: Rng,
): { won: boolean; stars: number; score: number; completion: number } {
  const session = new LevelSession(def, { seedOffset });
  let guard = 0;

  while (session.state === 'playing' && guard++ < 400) {
    const moves = session.board.findMoves();
    if (!moves.length) {
      session.usePowerup('shuffle');
      continue;
    }

    // Evaluate a sample of the legal moves, then pick imperfectly.
    const sample = rng.shuffle(moves.slice()).slice(0, 22);
    const ranked = sample
      .map((move) => ({ move, value: scoreMove(session.board, def, move) }))
      .sort((x, y) => y.value - x.value);

    const window = Math.max(1, Math.round((1 - skill) * ranked.length));
    const chosen = ranked[rng.int(Math.min(window, ranked.length))];
    session.swap(chosen.move.a, chosen.move.b);
  }

  return {
    won: session.state === 'won',
    stars: session.stars(),
    score: session.score,
    completion: session.completion(),
  };
}

function main(): void {
  const trials = Number(process.env.TRIALS ?? 12);
  const skill = Number(process.env.SKILL ?? 0.8);
  const levels = allLevels();
  const rng = new Rng(0xc0ffee);

  console.log(`Gem Quest balance run — ${trials} trials/level at skill ${skill}\n`);
  console.log('lvl  diff  moves  goal                              win%   ★   score   done%');

  const rates: number[] = [];
  for (const def of levels) {
    let wins = 0;
    let stars = 0;
    let score = 0;
    let completion = 0;
    for (let t = 0; t < trials; t++) {
      const outcome = playLevel(def, t, skill, rng);
      if (outcome.won) wins++;
      stars += outcome.stars;
      score += outcome.score;
      completion += outcome.completion;
    }
    const rate = wins / trials;
    rates.push(rate);
    const goal = def.objectives
      .map((o) => `${o.type}${o.color !== undefined ? `#${o.color}` : ''}:${o.target}`)
      .join(' + ');
    const bar = '█'.repeat(Math.round(rate * 20)).padEnd(20, '·');
    console.log(
      `${String(def.id).padStart(3)}  ${def.difficulty.toFixed(2)}  ${String(def.moves).padStart(5)}  ${goal.padEnd(32).slice(0, 32)}  ${bar} ${(rate * 100).toFixed(0).padStart(3)}%  ${(stars / trials).toFixed(1)}  ${Math.round(score / trials).toString().padStart(6)}  ${((completion / trials) * 100).toFixed(0).padStart(3)}%${isBossLevel(def.id) ? '  BOSS' : ''}`,
    );
  }

  console.log('\nEpisode summary (mean win rate):');
  for (let e = 0; e < TOTAL_LEVELS / 10; e++) {
    const slice = rates.slice(e * 10, e * 10 + 10);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    console.log(
      `  ep${String(e + 1).padStart(2)} ${levels[e * 10].episodeName.padEnd(16)} ${'█'.repeat(Math.round(mean * 30)).padEnd(30, '·')} ${(mean * 100).toFixed(0)}%`,
    );
  }
  const overall = rates.reduce((a, b) => a + b, 0) / rates.length;
  console.log(`\noverall ${(overall * 100).toFixed(1)}%  |  first10 ${(rates.slice(0, 10).reduce((a, b) => a + b, 0) / 10 * 100).toFixed(0)}%  last10 ${(rates.slice(-10).reduce((a, b) => a + b, 0) / 10 * 100).toFixed(0)}%`);
}

main();
