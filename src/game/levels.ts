import { Board } from '../engine/board.js';
import { Rng, hashSeed } from '../engine/rng.js';
import { BoardConfig, GemKind, Pos, Special } from '../engine/types.js';

export const TOTAL_LEVELS = 1000;
export const LEVELS_PER_EPISODE = 10;
export const EPISODES_PER_REGION = 10;

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
  regionName: string;
  region: number;
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
  jellyTriple: number;
  crates: number;
  stones: number;
  locks: number;
  ingredients: number;
  /** Countdown gems that end the level if any reaches zero. */
  fuses: number;
  fuseTimer: number;
  /** 0..1, drives the difficulty pips on the map. */
  difficulty: number;
  seed: number;
}

/** Ten regions of ten episodes each; the run spans all 1000 levels. */
export const REGIONS: { name: string; hue: number; areas: string[] }[] = [
  {
    name: 'Sunrise Shore',
    hue: 32,
    areas: ['Tidepools', 'Driftwood Bay', 'Coral Steps', 'Gull Cliffs', 'Salt Flats',
            'Lantern Pier', 'Shell Hollow', 'Dune Walk', 'Anchor Cove', 'Morning Reef'],
  },
  {
    name: 'Emerald Grove',
    hue: 140,
    areas: ['Fern Hollow', 'Mosswood', 'Thistle Run', 'Willow Bend', 'Bramble Gate',
            'Hollow Oak', 'Fox Warren', 'Cedar Rise', 'Ivy Steps', 'Green Cathedral'],
  },
  {
    name: 'Frostpeak Pass',
    hue: 196,
    areas: ['Rime Gate', 'Snowbreak', 'Icefall', 'Glacier Stair', 'Windscour',
            'Frozen Tarn', 'Cairn Ridge', 'Hoarfrost', 'Whiteout', 'Summit Watch'],
  },
  {
    name: 'Amber Desert',
    hue: 40,
    areas: ['Sunstone Waste', 'Scarab Dunes', 'Dry Wells', 'Glass Sea', 'Caravan Road',
            'Sandveil', 'Bone Mesa', 'Mirage Wells', 'Kiln Flats', 'Golden Tomb'],
  },
  {
    name: 'Coral Depths',
    hue: 178,
    areas: ['Kelp Maze', 'Sunken Prow', 'Pearl Grotto', 'Anemone Fields', 'The Shelf',
            'Nautilus Hall', 'Blackwater', 'Siren Shoal', 'Abyss Ledge', 'Leviathan Rest'],
  },
  {
    name: 'Thunder Mesa',
    hue: 268,
    areas: ['Static Flats', 'Ironrock', 'Stormbreak', 'Copper Spires', 'Fulgurite',
            'The Anvil', 'Skyfracture', 'Ozone Ridge', 'Boltfall', 'Tempest Crown'],
  },
  {
    name: 'Obsidian Mines',
    hue: 220,
    areas: ['Cinder Gate', 'Slagworks', 'Deep Cut', 'Vein Seven', 'Blackglass',
            'Collapse', 'Under-market', 'Magma Drift', 'The Foundry', 'Heartstone'],
  },
  {
    name: 'Clockwork City',
    hue: 24,
    areas: ['Cog Quarter', 'Brass Row', 'Steam Yards', 'The Escapement', 'Gearfall',
            'Mainspring', 'Tick Lane', 'Automata Hall', 'Regulator', 'Grand Movement'],
  },
  {
    name: 'Aurora Reach',
    hue: 160,
    areas: ['Lightfall', 'Polar Veil', 'Shimmer Flats', 'Ghost Lights', 'Solar Wind',
            'Halo Ridge', 'Nightbloom', 'The Curtain', 'Zenith', 'Crown of Dawn'],
  },
  {
    name: 'Prism Citadel',
    hue: 288,
    areas: ['Outer Facet', 'Refraction', 'Spectrum Gate', 'Hall of Mirrors', 'The Lattice',
            'Starfall Reach', 'Mirage Spires', 'Inner Light', 'Throne of Colour', 'Last Prism'],
  },
];

export interface EpisodeInfo {
  /** Episode name, e.g. "Coral Steps". */
  name: string;
  /** Region it belongs to, e.g. "Sunrise Shore". */
  region: string;
  regionIndex: number;
  hue: number;
}

/** All 100 episodes, flattened from the regions. */
export const EPISODES: EpisodeInfo[] = REGIONS.flatMap((region, ri) =>
  region.areas.map((area, ai) => ({
    name: area,
    region: region.name,
    regionIndex: ri,
    // Drift the hue slightly across each region so episodes read as distinct.
    hue: (region.hue + ai * 4) % 360,
  })),
);

export const TOTAL_REGIONS = REGIONS.length;
export const LEVELS_PER_REGION = LEVELS_PER_EPISODE * EPISODES_PER_REGION;

export function regionOf(levelId: number): number {
  return Math.min(TOTAL_REGIONS - 1, Math.floor((levelId - 1) / LEVELS_PER_REGION));
}

/** Level at which each mechanic first appears. */
const UNLOCKS: Record<ObjectiveType, number> = {
  score: 1,
  collect: 5,
  jelly: 8,
  blockers: 16,
  ingredients: 26,
};

/** Countdown gems join the hazard pool here. */
const FUSE_UNLOCK = 120;
/** Triple-layer jelly appears from here on. */
const JELLY3_UNLOCK = 600;
/** A seventh gem colour, which sharply cuts the number of available moves. */
const SEVEN_COLOR_UNLOCK = 700;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Difficulty rises across the run but breathes within each episode: the first
 * level of an episode is a breather, the tenth is a boss. The exponent is
 * below 1 so the curve bites early rather than saving everything for the end.
 */
export function difficultyFor(id: number): number {
  const progress = (id - 1) / (TOTAL_LEVELS - 1);
  const posInEpisode = (id - 1) % LEVELS_PER_EPISODE;
  const isBoss = posInEpisode === LEVELS_PER_EPISODE - 1;

  const base = Math.pow(progress, 0.9) * 0.84;
  const wave = (posInEpisode / (LEVELS_PER_EPISODE - 1)) * 0.11;
  const boss = isBoss ? 0.08 : 0;
  const relief = posInEpisode === 0 ? -0.06 : 0;
  return clamp01(base + wave + boss + relief);
}

export function isBossLevel(id: number): boolean {
  return id % LEVELS_PER_EPISODE === 0;
}

/** Every 100th level closes a region and is the hardest of its stretch. */
export function isRegionFinale(id: number): boolean {
  return id % LEVELS_PER_REGION === 0;
}

function boardSizeFor(id: number): { width: number; height: number } {
  if (id <= 20) return { width: 7, height: 7 };
  if (id <= 60) return { width: 7, height: 8 };
  if (id <= 150) return { width: 8, height: 8 };
  if (id <= 350) return { width: 8, height: 9 };
  return { width: 9, height: 9 };
}

function colorCountFor(id: number, posInEpisode: number): number {
  if (id <= 3) return 4;
  if (id <= 24) return 5;
  if (id < SEVEN_COLOR_UNLOCK) return posInEpisode === 0 && id > 120 ? 5 : 6;
  // The seventh colour sharply cuts available moves, so it is a spike on the
  // harder half of each late episode rather than the standing default.
  return posInEpisode >= 5 ? 7 : 6;
}

function shapeFor(id: number, rng: Rng): BoardShape {
  if (id < 18) return 'full';
  const pool: BoardShape[] = ['full', 'full', 'notched'];
  if (id >= 26) pool.push('well', 'diamond');
  if (id >= 42) pool.push('hourglass', 'cross');
  if (id >= 60) pool.push('pillars', 'arrow');
  // Later on, plain boards become rare.
  if (id >= 200) pool.shift();
  if (id >= 500) pool.shift();
  return rng.pick(pool);
}

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
        return id < 16 ? 5 : 1.6;
      case 'collect':
        return 3;
      case 'jelly':
        return 3.5;
      case 'blockers':
        return 2.8;
      case 'ingredients':
        return 2.2;
      default:
        return 1;
    }
  });

  const primary = available[rng.weighted(weights)];
  const types = [primary];

  // Compound goals start early and become the norm late.
  const dualChance = id >= 45 ? lerp(0.12, 0.45, difficulty) : 0;
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
    case 'arrow':
      for (let r = 0; r < Math.floor(height / 2); r++) {
        for (let d = 0; d < Math.floor(height / 2) - r; d++) {
          set(height - 1 - r, d);
          set(height - 1 - r, width - 1 - d);
        }
      }
      break;
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

/**
 * Star cut-offs, calibrated against what a competent player actually scores:
 * winning should reliably earn one star, two is a good run, three needs a
 * strong cascade chain.
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

/** Fully deterministic definition for one level. */
export function makeLevel(id: number): LevelDef {
  const seed = hashSeed(`gem-quest/level/${id}`);
  const rng = new Rng(seed);
  const episode = Math.floor((id - 1) / LEVELS_PER_EPISODE);
  const posInEpisode = (id - 1) % LEVELS_PER_EPISODE;
  const difficulty = difficultyFor(id);
  const boss = isBossLevel(id);
  const finale = isRegionFinale(id);

  const { width, height } = boardSizeFor(id);
  const colorCount = colorCountFor(id, posInEpisode);
  const shape = shapeFor(id, rng);
  const holes = holesFor(shape, width, height);
  const cells = playableCount(holes);

  const types = pickObjectiveTypes(id, difficulty, rng);
  const dual = types.length > 1;
  /** Compound goals get each half sized down so the pair stays winnable. */
  const scale = dual ? 0.64 : 1;

  let jellySingle = 0;
  let jellyDouble = 0;
  let jellyTriple = 0;
  let crates = 0;
  let stones = 0;
  let locks = 0;
  let ingredients = 0;
  let fuses = 0;
  const objectives: Objective[] = [];

  // The move budget is fixed first; every target is then sized against it,
  // which is what keeps late levels hard-but-winnable instead of impossible.
  let moves = Math.round(lerp(29, 17, difficulty));

  for (const type of types) {
    switch (type) {
      case 'score': {
        const perMove = lerp(690, 1020, difficulty);
        objectives.push({ type: 'score', target: Math.round((moves * perMove * scale) / 100) * 100 });
        break;
      }
      case 'collect': {
        const twoColors = !dual && id >= 60 && rng.chance(lerp(0.12, 0.55, difficulty));
        const chosen = rng.shuffle([...Array(colorCount).keys()]).slice(0, twoColors ? 2 : 1);
        for (const color of chosen) {
          const target = Math.round(
            moves * lerp(1.1, 1.7, difficulty) * (twoColors ? 0.6 : 1) * scale,
          );
          objectives.push({ type: 'collect', target: Math.max(10, target), color });
        }
        break;
      }
      case 'jelly': {
        const byBoard = cells * lerp(0.32, 0.82, difficulty);
        const byMoves = moves * lerp(0.95, 1.6, difficulty);
        const layers = Math.max(6, Math.round(Math.min(byBoard, byMoves) * scale));
        if (id >= JELLY3_UNLOCK) {
          jellyTriple = Math.round((layers * lerp(0, 0.3, difficulty)) / 3);
        }
        const afterTriple = Math.max(0, layers - jellyTriple * 3);
        jellyDouble = Math.round((afterTriple * lerp(0.1, 0.5, difficulty)) / 2);
        jellySingle = Math.max(0, afterTriple - jellyDouble * 2);
        objectives.push({ type: 'jelly', target: jellySingle + jellyDouble * 2 + jellyTriple * 3 });
        moves += 2;
        break;
      }
      case 'blockers': {
        const byBoard = cells * lerp(0.13, 0.3, difficulty);
        const byMoves = moves * lerp(0.4, 0.72, difficulty);
        const total = Math.max(4, Math.round(Math.min(byBoard, byMoves) * scale));
        stones = id >= 45 ? Math.round(total * lerp(0.05, 0.32, difficulty)) : 0;
        crates = Math.max(1, total - stones);
        objectives.push({ type: 'blockers', target: crates + stones });
        moves += 2;
        break;
      }
      case 'ingredients': {
        // Each one has to be walked down the whole board, so these levels need
        // both a modest count and a much larger move budget.
        ingredients = Math.max(1, Math.round(lerp(1, 4, difficulty)));
        objectives.push({ type: 'ingredients', target: ingredients });
        moves += 9 + Math.round(ingredients * 4.5);
        break;
      }
    }
  }

  // Hazards that flavour a level without being the goal itself.
  if (!types.includes('blockers') && id >= 16 && rng.chance(0.6)) {
    crates = Math.round(lerp(2, 10, difficulty));
    if (id >= 45 && rng.chance(0.5)) stones = Math.round(lerp(0, 5, difficulty));
  }
  if (!types.includes('jelly') && id >= 30 && rng.chance(0.35)) {
    jellySingle = Math.round(lerp(3, 12, difficulty));
  }
  if (id >= 40 && rng.chance(0.45)) {
    locks = Math.round(lerp(3, 14, difficulty));
  }
  if (id >= FUSE_UNLOCK && rng.chance(lerp(0.08, 0.3, difficulty))) {
    fuses = Math.max(1, Math.round(lerp(1, 4, difficulty)));
  }

  if (boss) {
    moves -= 2;
    if (crates) crates += 2;
    if (jellyDouble) jellyDouble += 2;
  }
  if (finale) {
    moves -= 1;
    if (id >= FUSE_UNLOCK) fuses = Math.max(fuses, 2);
  }

  // Jelly and blockers compete for the same cells.
  const furnitureBudget = Math.max(0, cells - 4);
  const jellyWanted = jellySingle + jellyDouble + jellyTriple;
  const jellyRoom = Math.max(0, furnitureBudget - crates - stones);
  if (jellyWanted > jellyRoom) {
    jellyTriple = Math.min(jellyTriple, jellyRoom);
    jellyDouble = Math.min(jellyDouble, Math.max(0, jellyRoom - jellyTriple));
    jellySingle = Math.max(0, jellyRoom - jellyTriple - jellyDouble);
    const jellyObjective = objectives.find((o) => o.type === 'jelly');
    if (jellyObjective) {
      jellyObjective.target = jellySingle + jellyDouble * 2 + jellyTriple * 3;
    }
  }
  locks = Math.min(locks, Math.max(0, cells - crates - stones - 6));

  moves = Math.max(11, moves);
  fuses = Math.min(fuses, Math.max(0, Math.floor(cells / 12)));
  // A fuse must be tight enough to force action but long enough to be solvable.
  const fuseTimer = fuses ? Math.max(8, Math.round(moves * lerp(1.05, 0.8, difficulty))) : 0;

  const info = EPISODES[episode];
  return {
    id,
    episode,
    episodeName: info.name,
    regionName: info.region,
    region: info.regionIndex,
    width,
    height,
    colorCount,
    moves,
    shape,
    objectives,
    starScores: starThresholds(moves, objectives),
    jellySingle,
    jellyDouble,
    jellyTriple,
    crates,
    stones,
    locks,
    ingredients,
    fuses,
    fuseTimer,
    difficulty,
    seed,
  };
}

/**
 * Hand-tuned overrides for the opening region, which is the stretch every
 * player sees. Beyond level 100 the generated curve stands on its own — at a
 * thousand levels, per-level authoring is not practical.
 */
const MILESTONES: Record<number, Partial<LevelDef>> = {
  10: { moves: 20, objectives: [{ type: 'score', target: 20000 }] },
  20: { moves: 19, jellySingle: 14, jellyDouble: 5, objectives: [{ type: 'jelly', target: 24 }] },
  30: { moves: 20, crates: 15, stones: 0, objectives: [{ type: 'blockers', target: 15 }], shape: 'notched' },
  40: {
    moves: 22,
    objectives: [
      { type: 'collect', target: 26, color: 0 },
      { type: 'collect', target: 26, color: 2 },
    ],
  },
  50: { moves: 30, ingredients: 3, objectives: [{ type: 'ingredients', target: 3 }], shape: 'well' },
  60: {
    moves: 20,
    jellySingle: 16,
    jellyDouble: 9,
    locks: 6,
    objectives: [{ type: 'jelly', target: 34 }],
    shape: 'diamond',
  },
  70: {
    moves: 21,
    crates: 16,
    stones: 5,
    objectives: [{ type: 'blockers', target: 21 }],
    shape: 'cross',
  },
  80: {
    moves: 19,
    jellySingle: 12,
    jellyDouble: 12,
    objectives: [{ type: 'jelly', target: 36 }],
    shape: 'hourglass',
  },
  90: {
    moves: 34,
    ingredients: 4,
    crates: 8,
    objectives: [{ type: 'ingredients', target: 4 }],
    shape: 'well',
  },
  100: {
    moves: 24,
    locks: 8,
    crates: 10,
    jellySingle: 10,
    jellyDouble: 10,
    objectives: [
      { type: 'jelly', target: 30 },
      { type: 'blockers', target: 10 },
    ],
    shape: 'pillars',
  },
};

let cache: LevelDef[] | null = null;

/** All levels, generated once and memoised. */
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
    board.at(p.r, p.c)!.blocker = {
      kind: 'crate',
      hp: rng.chance(Math.min(0.55, def.difficulty)) ? 2 : 1,
    };
  }
  for (const p of take(def.stones)) {
    board.at(p.r, p.c)!.blocker = { kind: 'stone', hp: 1 };
  }

  // Jelly sits under gems; prefer the lower half so it is not trivially cleared.
  const jellyCells = candidates.slice(cursor).filter((p) => !board.at(p.r, p.c)!.blocker);
  jellyCells.sort((a, b) => b.r - a.r);
  const jellyPool = def.jellySingle + def.jellyDouble + def.jellyTriple;
  const weighted = rng.shuffle(
    jellyCells.slice(0, Math.max(jellyPool, Math.ceil(jellyCells.length * 0.8))),
  );
  let jc = 0;
  for (let i = 0; i < def.jellyTriple && jc < weighted.length; i++, jc++) {
    board.at(weighted[jc].r, weighted[jc].c)!.jelly = 3;
  }
  for (let i = 0; i < def.jellyDouble && jc < weighted.length; i++, jc++) {
    board.at(weighted[jc].r, weighted[jc].c)!.jelly = 2;
  }
  for (let i = 0; i < def.jellySingle && jc < weighted.length; i++, jc++) {
    board.at(weighted[jc].r, weighted[jc].c)!.jelly = 1;
  }

  board.ingredientQueue = def.ingredients;
  board.maxIngredientsOnBoard = Math.min(4, Math.max(2, def.ingredients));

  board.fillInitial();

  // Chains and fuses go on after the fill so they attach to real gems.
  const placeable = rng
    .shuffle(furnitureCandidates(def, holes, rng))
    .filter((p) => {
      const cell = board.at(p.r, p.c)!;
      return cell.gem !== null && !cell.blocker && cell.gem.kind === GemKind.Normal;
    });

  let idx = 0;
  for (let i = 0; i < def.locks && idx < placeable.length; i++, idx++) {
    board.at(placeable[idx].r, placeable[idx].c)!.locked = true;
  }
  for (let i = 0; i < def.fuses && idx < placeable.length; i++, idx++) {
    const cell = board.at(placeable[idx].r, placeable[idx].c)!;
    // Stagger the timers so they do not all expire on the same move.
    cell.gem!.fuse = def.fuseTimer + i * 2;
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
