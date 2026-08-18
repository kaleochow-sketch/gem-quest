import { Board } from '../engine/board.js';
import { Rng, hashSeed } from '../engine/rng.js';
import { BoardConfig, GemKind, Pos, Special } from '../engine/types.js';

export const TOTAL_LEVELS = 150;
export const LEVELS_PER_EPISODE = 10;

export type ObjectiveType = 'score' | 'collect' | 'jelly' | 'ingredients' | 'blockers';

export interface Objective {
  type: ObjectiveType;
  target: number;
  /** Palette index, for `collect` objectives. */
  color?: number;
}

export type BoardShape =
  | 'full'
  | 'notched'
  | 'diamond'
  | 'hourglass'
  | 'well'
  | 'pillars'
  | 'cross'
  | 'arrow';

export interface LevelDef {
  id: number;
  episode: number;
  episodeName: string;
  width: number;
  height: number;
  colorCount: number;
  moves: number;
  shape: BoardShape;
  objectives: Objective[];
  /** Score needed for 1, 2 and 3 stars. */
  starScores: [number, number, number];
  jellySingle: number;
  jellyDouble: number;
  crates: number;
  stones: number;
  locks: number;
  ingredients: number;
  /** 0..1, drives the difficulty pips on the map. */
  difficulty: number;
  seed: number;
}

export const EPISODES: { name: string; hue: number }[] = [
  { name: 'Sunrise Shore', hue: 32 },
  { name: 'Emerald Grove', hue: 140 },
  { name: 'Frostpeak Pass', hue: 196 },
  { name: 'Amber Desert', hue: 40 },
  { name: 'Coral Depths', hue: 178 },
  { name: 'Thunder Mesa', hue: 268 },
  { name: 'Twilight Bazaar', hue: 300 },
  { name: 'Obsidian Mines', hue: 220 },
  { name: 'Aurora Fields', hue: 160 },
  { name: 'Clockwork City', hue: 24 },
  { name: 'Sunken Temple', hue: 190 },
  { name: 'Ember Caldera', hue: 8 },
  { name: 'Starfall Reach', hue: 250 },
  { name: 'Mirage Spires', hue: 320 },
  { name: 'Prism Citadel', hue: 280 },
];

/** Level at which each mechanic first appears. */
const UNLOCKS: Record<ObjectiveType, number> = {
  score: 1,
  collect: 7,
  jelly: 11,
  blockers: 22,
  ingredients: 33,
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Difficulty rises across the run but breathes within each episode:
 * the first level of an episode is a breather, the tenth is a boss.
 */
export function difficultyFor(id: number): number {
  const progress = (id - 1) / (TOTAL_LEVELS - 1);
  const posInEpisode = (id - 1) % LEVELS_PER_EPISODE;
  const isBoss = posInEpisode === LEVELS_PER_EPISODE - 1;

  const base = Math.pow(progress, 0.88) * 0.8;
  const wave = (posInEpisode / (LEVELS_PER_EPISODE - 1)) * 0.13;
  const boss = isBoss ? 0.09 : 0;
  const relief = posInEpisode === 0 ? -0.07 : 0;
  return clamp01(base + wave + boss + relief);
}

export function isBossLevel(id: number): boolean {
  return id % LEVELS_PER_EPISODE === 0;
}

function boardSizeFor(id: number): { width: number; height: number } {
  if (id <= 10) return { width: 7, height: 7 };
  if (id <= 30) return { width: 7, height: 8 };
  if (id <= 70) return { width: 8, height: 8 };
  if (id <= 110) return { width: 8, height: 9 };
  return { width: 9, height: 9 };
}

function colorCountFor(id: number, posInEpisode: number): number {
  if (id <= 6) return 4;
  if (id <= 40) return 5;
  // Breather levels late on drop back to five colours.
  if (posInEpisode === 0 && id > 60) return 5;
  return 6;
}

function shapeFor(id: number, rng: Rng): BoardShape {
  if (id < 26) return 'full';
  const pool: BoardShape[] = ['full', 'full', 'notched'];
  if (id >= 36) pool.push('well', 'diamond');
  if (id >= 56) pool.push('hourglass', 'cross');
  if (id >= 76) pool.push('pillars', 'arrow');
  return rng.pick(pool);
}

/** Objective types available at this level, in unlock order. */
function unlockedTypes(id: number): ObjectiveType[] {
  return (Object.keys(UNLOCKS) as ObjectiveType[]).filter((t) => id >= UNLOCKS[t]);
}

function pickObjectiveTypes(id: number, difficulty: number, rng: Rng): ObjectiveType[] {
  // The level a mechanic unlocks always teaches that mechanic on its own.
  for (const type of Object.keys(UNLOCKS) as ObjectiveType[]) {
    if (UNLOCKS[type] === id) return [type];
  }

  const available = unlockedTypes(id);
  const weights = available.map((type) => {
    switch (type) {
      case 'score':
        return id < 20 ? 5 : 2;
      case 'collect':
        return 3;
      case 'jelly':
        return 3.5;
      case 'blockers':
        return 2.5;
      case 'ingredients':
        return 2;
      default:
        return 1;
    }
  });

  const primary = available[rng.weighted(weights)];
  const types = [primary];

  // Compound goals start once the player knows every mechanic.
  const dualChance = id >= 61 ? lerp(0.12, 0.45, difficulty) : 0;
  if (primary !== 'score' && rng.chance(dualChance)) {
    const others = available.filter((t) => t !== primary && t !== 'score' && t !== 'ingredients');
    if (others.length) types.push(rng.pick(others));
  }
  return types;
}

/** Hole mask for a board shape. */
function holesFor(shape: BoardShape, width: number, height: number): boolean[] {
  const holes = new Array(width * height).fill(false);
  const set = (r: number, c: number) => {
    if (r >= 0 && r < height && c >= 0 && c < width) holes[r * width + c] = true;
  };

  switch (shape) {
    case 'notched':
      for (const [r, c] of [[0, 0], [0, width - 1], [height - 1, 0], [height - 1, width - 1]]) set(r, c);
      break;
    case 'diamond': {
      const cut = Math.floor(Math.min(width, height) / 3);
      for (let r = 0; r < height; r++) {
        const depth = cut - Math.min(r, height - 1 - r);
        for (let d = 0; d < depth; d++) {
          set(r, d);
          set(r, width - 1 - d);
        }
      }
      break;
    }
    case 'well':
      for (let c = 0; c < width; c++) {
        if (c > 1 && c < width - 2) continue;
        set(0, c);
      }
      set(1, 0);
      set(1, width - 1);
      break;
    case 'hourglass': {
      const mid = Math.floor(height / 2);
      set(mid, 0);
      set(mid, width - 1);
      set(mid - 1, 0);
      set(mid - 1, width - 1);
      break;
    }
    case 'cross': {
      const cut = 2;
      for (let r = 0; r < cut; r++) {
        for (let c = 0; c < cut - r; c++) {
          set(r, c);
          set(r, width - 1 - c);
          set(height - 1 - r, c);
          set(height - 1 - r, width - 1 - c);
        }
      }
      break;
    }
    case 'pillars':
      for (let r = 2; r < height - 2; r++) {
        set(r, 1);
        set(r, width - 2);
      }
      break;
    case 'arrow': {
      for (let r = 0; r < Math.floor(height / 2); r++) {
        for (let d = 0; d < Math.floor(height / 2) - r; d++) {
          set(height - 1 - r, d);
          set(height - 1 - r, width - 1 - d);
        }
      }
      break;
    }
    case 'full':
    default:
      break;
  }
  return holes;
}

function playableCount(holes: boolean[]): number {
  let n = 0;
  for (const h of holes) if (!h) n++;
  return n;
}

/** Fully deterministic definition for one level. */
export function makeLevel(id: number): LevelDef {
  const seed = hashSeed(`gem-quest/level/${id}`);
  const rng = new Rng(seed);
  const episode = Math.floor((id - 1) / LEVELS_PER_EPISODE);
  const posInEpisode = (id - 1) % LEVELS_PER_EPISODE;
  const difficulty = difficultyFor(id);
  const boss = isBossLevel(id);

  const { width, height } = boardSizeFor(id);
  const colorCount = colorCountFor(id, posInEpisode);
  const shape = shapeFor(id, rng);
  const holes = holesFor(shape, width, height);
  const cells = playableCount(holes);

  const types = pickObjectiveTypes(id, difficulty, rng);
  const dual = types.length > 1;
  /** Compound goals get each half sized down so the pair stays winnable. */
  const scale = dual ? 0.62 : 1;

  let jellySingle = 0;
  let jellyDouble = 0;
  let crates = 0;
  let stones = 0;
  let locks = 0;
  let ingredients = 0;
  const objectives: Objective[] = [];

  // The move budget is fixed first; every target is then sized against it,
  // which is what keeps late levels hard-but-winnable instead of impossible.
  let moves = Math.round(lerp(30, 19, difficulty));

  for (const type of types) {
    switch (type) {
      case 'score': {
        const perMove = lerp(640, 1040, difficulty);
        objectives.push({ type: 'score', target: Math.round((moves * perMove * scale) / 100) * 100 });
        break;
      }
      case 'collect': {
        const twoColors = !dual && id >= 70 && rng.chance(lerp(0.1, 0.5, difficulty));
        const chosen = rng.shuffle([...Array(colorCount).keys()]).slice(0, twoColors ? 2 : 1);
        for (const color of chosen) {
          const target = Math.round(
            moves * lerp(1.15, 2.05, difficulty) * (twoColors ? 0.62 : 1) * scale,
          );
          objectives.push({ type: 'collect', target: Math.max(10, target), color });
        }
        break;
      }
      case 'jelly': {
        const byBoard = cells * lerp(0.3, 0.95, difficulty);
        const byMoves = moves * lerp(1.0, 1.9, difficulty);
        const layers = Math.max(6, Math.round(Math.min(byBoard, byMoves) * scale));
        jellyDouble = Math.round((layers * lerp(0, 0.42, difficulty)) / 2);
        jellySingle = Math.max(0, layers - jellyDouble * 2);
        objectives.push({ type: 'jelly', target: jellySingle + jellyDouble * 2 });
        moves += 2;
        break;
      }
      case 'blockers': {
        const byBoard = cells * lerp(0.12, 0.34, difficulty);
        const byMoves = moves * lerp(0.4, 0.85, difficulty);
        const total = Math.max(4, Math.round(Math.min(byBoard, byMoves) * scale));
        stones = id >= 55 ? Math.round(total * lerp(0, 0.28, difficulty)) : 0;
        crates = Math.max(1, total - stones);
        objectives.push({ type: 'blockers', target: crates + stones });
        moves += 2;
        break;
      }
      case 'ingredients': {
        // Each ingredient has to be walked down the whole board, so these
        // levels need both a smaller count and a much larger move budget.
        ingredients = Math.max(1, Math.round(lerp(1, 4, difficulty)));
        objectives.push({ type: 'ingredients', target: ingredients });
        moves += 8 + ingredients * 4;
        break;
      }
    }
  }

  // Hazards that flavour a level without being the goal itself.
  if (!types.includes('blockers') && id >= 24 && rng.chance(0.55)) {
    crates = Math.round(lerp(1, 7, difficulty));
    if (id >= 60 && rng.chance(0.45)) stones = Math.round(lerp(0, 3, difficulty));
  }
  if (!types.includes('jelly') && id >= 40 && rng.chance(0.3)) {
    jellySingle = Math.round(lerp(2, 8, difficulty));
  }
  if (id >= 44 && rng.chance(0.4)) {
    locks = Math.round(lerp(2, 10, difficulty));
  }

  // Jelly and blockers compete for the same cells.
  const furnitureBudget = Math.max(0, cells - 4);
  const jellyCells = Math.min(jellySingle + jellyDouble, Math.max(0, furnitureBudget - crates - stones));
  if (jellyCells < jellySingle + jellyDouble) {
    jellyDouble = Math.min(jellyDouble, jellyCells);
    jellySingle = Math.max(0, jellyCells - jellyDouble);
    const jellyObjective = objectives.find((o) => o.type === 'jelly');
    if (jellyObjective) jellyObjective.target = jellySingle + jellyDouble * 2;
  }
  locks = Math.min(locks, Math.max(0, cells - crates - stones - 6));

  if (boss) {
    moves -= 2;
    if (crates) crates += 2;
    if (jellyDouble) jellyDouble += 2;
  }

  moves = Math.max(12, moves);

  const starScores = starThresholds(moves, objectives);

  return {
    id,
    episode,
    episodeName: EPISODES[episode].name,
    width,
    height,
    colorCount,
    moves,
    shape,
    objectives,
    starScores,
    jellySingle,
    jellyDouble,
    crates,
    stones,
    locks,
    ingredients,
    difficulty,
    seed,
  };
}

/** Hand-tuned overrides applied on top of the generated curve. */
const MILESTONES: Record<number, Partial<LevelDef>> = {
  10: { moves: 24, objectives: [{ type: 'score', target: 22000 }] },
  20: { moves: 22, jellySingle: 16, jellyDouble: 4, objectives: [{ type: 'jelly', target: 24 }] },
  30: {
    moves: 24,
    crates: 18,
    stones: 0,
    objectives: [{ type: 'blockers', target: 18 }],
    shape: 'notched',
  },
  40: {
    moves: 26,
    objectives: [
      { type: 'collect', target: 30, color: 0 },
      { type: 'collect', target: 30, color: 2 },
    ],
  },
  50: { moves: 34, ingredients: 3, objectives: [{ type: 'ingredients', target: 3 }], shape: 'well' },
  60: {
    moves: 22,
    jellySingle: 18,
    jellyDouble: 10,
    locks: 6,
    objectives: [{ type: 'jelly', target: 38 }],
    shape: 'diamond',
  },
  70: {
    moves: 24,
    crates: 20,
    stones: 6,
    objectives: [{ type: 'blockers', target: 26 }],
    shape: 'cross',
  },
  80: {
    moves: 21,
    jellySingle: 14,
    jellyDouble: 14,
    objectives: [{ type: 'jelly', target: 42 }],
    shape: 'hourglass',
  },
  90: {
    moves: 38,
    ingredients: 4,
    crates: 8,
    objectives: [{ type: 'ingredients', target: 4 }],
    shape: 'well',
  },
  100: {
    moves: 28,
    locks: 8,
    jellySingle: 12,
    jellyDouble: 9,
    objectives: [
      { type: 'jelly', target: 30 },
      { type: 'collect', target: 22, color: 3 },
    ],
    shape: 'pillars',
  },
  110: {
    moves: 26,
    crates: 16,
    stones: 5,
    objectives: [{ type: 'blockers', target: 21 }],
    shape: 'arrow',
  },
  120: {
    moves: 26,
    jellySingle: 12,
    jellyDouble: 14,
    locks: 8,
    objectives: [{ type: 'jelly', target: 40 }],
    shape: 'diamond',
  },
  130: {
    moves: 40,
    ingredients: 4,
    crates: 10,
    stones: 4,
    objectives: [{ type: 'ingredients', target: 4 }],
    shape: 'well',
  },
  140: {
    moves: 24,
    locks: 12,
    crates: 14,
    objectives: [
      { type: 'blockers', target: 14 },
      { type: 'collect', target: 30, color: 1 },
    ],
    shape: 'cross',
  },
  150: {
    moves: 32,
    jellySingle: 14,
    jellyDouble: 13,
    crates: 9,
    stones: 3,
    locks: 8,
    objectives: [
      { type: 'jelly', target: 40 },
      { type: 'blockers', target: 12 },
    ],
    shape: 'diamond',
  },
};

/**
 * Star cut-offs, calibrated against what a competent player actually scores:
 * winning a level should reliably earn one star, two is a good run,
 * three needs a strong cascade chain.
 */
function starThresholds(moves: number, objectives: Objective[]): [number, number, number] {
  const scoreObjective = objectives.find((o) => o.type === 'score');
  if (scoreObjective) {
    const base = scoreObjective.target;
    return [base, Math.round((base * 1.3) / 100) * 100, Math.round((base * 1.7) / 100) * 100];
  }
  return [
    Math.round((moves * 700) / 100) * 100,
    Math.round((moves * 1000) / 100) * 100,
    Math.round((moves * 1400) / 100) * 100,
  ];
}

let cache: LevelDef[] | null = null;

/** All 150 levels, generated once and memoised. */
export function allLevels(): LevelDef[] {
  if (cache) return cache;
  cache = [];
  for (let id = 1; id <= TOTAL_LEVELS; id++) {
    const level = makeLevel(id);
    const override = MILESTONES[id];
    if (override) {
      Object.assign(level, override);
      level.starScores = starThresholds(level.moves, level.objectives);
    }
    cache.push(level);
  }
  return cache;
}

export function getLevel(id: number): LevelDef {
  return allLevels()[Math.max(0, Math.min(TOTAL_LEVELS - 1, id - 1))];
}

/* ------------------------------------------------------------------ *
 * Board construction
 * ------------------------------------------------------------------ */

/** Cells eligible for furniture, ordered so placement clusters sensibly. */
function furnitureCandidates(def: LevelDef, holes: boolean[], rng: Rng): Pos[] {
  const out: Pos[] = [];
  for (let r = 0; r < def.height; r++) {
    for (let c = 0; c < def.width; c++) {
      if (!holes[r * def.width + c]) out.push({ r, c });
    }
  }
  return rng.shuffle(out);
}

/** Builds a playable board from a level definition. */
export function buildBoard(def: LevelDef, seedOffset = 0): Board {
  const rng = new Rng(def.seed + seedOffset * 0x9e3779b1);
  const holes = holesFor(def.shape, def.width, def.height);

  const spawnColumns: number[] = [];
  for (let c = 0; c < def.width; c++) {
    for (let r = 0; r < def.height; r++) {
      if (!holes[r * def.width + c]) {
        spawnColumns.push(c);
        break;
      }
    }
  }

  const exits: Pos[] = [];
  if (def.ingredients > 0) {
    for (let c = 0; c < def.width; c++) {
      for (let r = def.height - 1; r >= 0; r--) {
        if (!holes[r * def.width + c]) {
          exits.push({ r, c });
          break;
        }
      }
    }
  }

  const config: BoardConfig = {
    width: def.width,
    height: def.height,
    colorCount: def.colorCount,
    spawnColumns,
    exits,
  };

  const board = new Board(config, rng, holes);
  const candidates = furnitureCandidates(def, holes, rng);
  let cursor = 0;
  const take = (n: number): Pos[] => {
    const slice = candidates.slice(cursor, cursor + n);
    cursor += n;
    return slice;
  };

  // Crates and stones occupy their cell, so they go down before gems exist.
  for (const p of take(def.crates)) {
    const cell = board.at(p.r, p.c)!;
    cell.blocker = { kind: 'crate', hp: rng.chance(Math.min(0.5, def.difficulty)) ? 2 : 1 };
  }
  for (const p of take(def.stones)) {
    const cell = board.at(p.r, p.c)!;
    cell.blocker = { kind: 'stone', hp: 1 };
  }

  // Jelly sits under gems; prefer the lower half so it is not trivially cleared.
  const jellyCells = candidates.slice(cursor).filter((p) => !board.at(p.r, p.c)!.blocker);
  jellyCells.sort((a, b) => b.r - a.r);
  const jellyPool = def.jellyDouble + def.jellySingle;
  const weighted = rng.shuffle(jellyCells.slice(0, Math.max(jellyPool, Math.ceil(jellyCells.length * 0.8))));
  weighted.slice(0, def.jellyDouble).forEach((p) => (board.at(p.r, p.c)!.jelly = 2));
  weighted.slice(def.jellyDouble, def.jellyDouble + def.jellySingle).forEach((p) => {
    board.at(p.r, p.c)!.jelly = 1;
  });

  board.ingredientQueue = def.ingredients;
  board.maxIngredientsOnBoard = Math.min(4, Math.max(2, def.ingredients));

  board.fillInitial();

  // Chains go on after the fill so they lock real gems.
  if (def.locks > 0) {
    const lockable = rng
      .shuffle(furnitureCandidates(def, holes, rng))
      .filter((p) => {
        const cell = board.at(p.r, p.c)!;
        return cell.gem !== null && !cell.blocker && cell.gem.kind === GemKind.Normal;
      })
      .slice(0, def.locks);
    for (const p of lockable) board.at(p.r, p.c)!.locked = true;
  }

  return board;
}

/** Starting specials granted by pre-level boosters. */
export function grantStartingSpecials(board: Board, rng: Rng, specials: Special[]): void {
  const spots: Pos[] = [];
  for (let r = 0; r < board.height; r++) {
    for (let c = 0; c < board.width; c++) {
      if (board.swappable({ r, c })) spots.push({ r, c });
    }
  }
  rng.shuffle(spots);
  specials.forEach((special, i) => {
    const p = spots[i];
    if (!p) return;
    const cell = board.at(p.r, p.c)!;
    if (cell.gem) cell.gem.special = special;
  });
}
