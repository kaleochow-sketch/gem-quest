import { ResolveContext } from '../engine/board.js';
import { Special } from '../engine/types.js';

export type UpgradeId =
  | 'deepPockets'
  | 'momentum'
  | 'luckyDrops'
  | 'goldRush'
  | 'vitality'
  | 'defuser'
  | 'demolition'
  | 'prospector'
  | 'alchemy'
  | 'starlight'
  | 'quartermaster'
  | 'secondWind';

export type BoosterId = 'extraMoves' | 'rocketPair' | 'rainbowStart' | 'bombStart' | 'colorPurge';
export type PowerupId = 'hammer' | 'shuffle' | 'freeswap' | 'lightning';

export interface UpgradeDef {
  id: UpgradeId;
  name: string;
  icon: string;
  maxRank: number;
  /** Cost of moving from rank r to r+1. */
  cost: (rank: number) => number;
  /** Player-facing effect at a given rank. */
  describe: (rank: number) => string;
  /** Total stars needed before this upgrade can be bought at all. */
  starsRequired: number;
  /** Which column of the tree it belongs to. */
  branch: 'power' | 'fortune' | 'endurance';
}

export interface ShopItem {
  id: BoosterId | PowerupId;
  name: string;
  icon: string;
  cost: number;
  blurb: string;
}

/**
 * Permanent upgrades, in three branches. Later ones are gated behind stars so
 * the tree opens up as the run progresses rather than all at once.
 */
export const UPGRADES: UpgradeDef[] = [
  {
    id: 'deepPockets',
    name: 'Deep Pockets',
    icon: '👝',
    maxRank: 8,
    branch: 'endurance',
    starsRequired: 0,
    cost: (rank) => 350 + rank * 450,
    describe: (rank) => `+${rank} move on every level`,
  },
  {
    id: 'momentum',
    name: 'Momentum',
    icon: '🌀',
    maxRank: 8,
    branch: 'power',
    starsRequired: 0,
    cost: (rank) => 450 + rank * 520,
    describe: (rank) => `+${rank * 7}% score per cascade`,
  },
  {
    id: 'goldRush',
    name: 'Gold Rush',
    icon: '💰',
    maxRank: 8,
    branch: 'fortune',
    starsRequired: 0,
    cost: (rank) => 400 + rank * 480,
    describe: (rank) => `+${rank * 10}% coins earned`,
  },
  {
    id: 'luckyDrops',
    name: 'Lucky Drops',
    icon: '🍀',
    maxRank: 6,
    branch: 'fortune',
    starsRequired: 12,
    cost: (rank) => 700 + rank * 700,
    describe: (rank) => `${(rank * 2.5).toFixed(1)}% chance a 3-match makes a rocket`,
  },
  {
    id: 'vitality',
    name: 'Vitality',
    icon: '❤️',
    maxRank: 5,
    branch: 'endurance',
    starsRequired: 15,
    cost: (rank) => 650 + rank * 750,
    describe: (rank) => `+${rank} max life, ${rank * 12}% faster refill`,
  },
  {
    id: 'demolition',
    name: 'Demolition',
    icon: '💥',
    maxRank: 5,
    branch: 'power',
    starsRequired: 30,
    cost: (rank) => 900 + rank * 850,
    describe: (rank) => `Rockets and bombs clear ${rank} extra ring of blockers`,
  },
  {
    id: 'prospector',
    name: 'Prospector',
    icon: '⛏️',
    maxRank: 5,
    branch: 'fortune',
    starsRequired: 45,
    cost: (rank) => 1000 + rank * 900,
    describe: (rank) => `+${rank * 8}% score from blockers and jelly`,
  },
  {
    id: 'defuser',
    name: 'Defuser',
    icon: '🧯',
    maxRank: 4,
    branch: 'endurance',
    starsRequired: 60,
    cost: (rank) => 1200 + rank * 1000,
    describe: (rank) => `Fuse gems start with +${rank * 2} moves on the clock`,
  },
  {
    id: 'alchemy',
    name: 'Alchemy',
    icon: '⚗️',
    maxRank: 5,
    branch: 'power',
    starsRequired: 90,
    cost: (rank) => 1400 + rank * 1200,
    describe: (rank) => `${rank * 3}% chance a 4-match becomes a bomb instead`,
  },
  {
    id: 'quartermaster',
    name: 'Quartermaster',
    icon: '📦',
    maxRank: 4,
    branch: 'fortune',
    starsRequired: 140,
    cost: (rank) => 1800 + rank * 1400,
    describe: (rank) => `${rank * 12}% chance a used power-up is not consumed`,
  },
  {
    id: 'secondWind',
    name: 'Second Wind',
    icon: '🌬️',
    maxRank: 3,
    branch: 'endurance',
    starsRequired: 200,
    cost: (rank) => 2400 + rank * 2000,
    describe: (rank) => `${rank * 25}% chance to refund the life on a loss`,
  },
  {
    id: 'starlight',
    name: 'Starlight',
    icon: '✨',
    maxRank: 3,
    branch: 'power',
    starsRequired: 300,
    cost: (rank) => 3000 + rank * 2500,
    describe: (rank) => `Begin every level with ${rank} random special gem${rank === 1 ? '' : 's'}`,
  },
];

/** Consumables chosen before the level starts. */
export const BOOSTERS: ShopItem[] = [
  { id: 'extraMoves', name: '+5 Moves', icon: '➕', cost: 250, blurb: 'Start with five extra moves.' },
  { id: 'rocketPair', name: 'Twin Rockets', icon: '🚀', cost: 400, blurb: 'Two rockets on the opening board.' },
  { id: 'bombStart', name: 'Twin Bombs', icon: '💣', cost: 500, blurb: 'Two bombs on the opening board.' },
  { id: 'rainbowStart', name: 'Prism Gem', icon: '🌈', cost: 700, blurb: 'Begin with a colour bomb in play.' },
  { id: 'colorPurge', name: 'Purge', icon: '🧹', cost: 900, blurb: 'Clears one whole colour the moment you start.' },
];

/** Consumables used mid-level. */
export const POWERUPS: ShopItem[] = [
  { id: 'hammer', name: 'Hammer', icon: '🔨', cost: 200, blurb: 'Smash any single gem or blocker.' },
  { id: 'shuffle', name: 'Shuffle', icon: '🔀', cost: 150, blurb: 'Reshuffle the whole board.' },
  { id: 'freeswap', name: 'Free Swap', icon: '🔁', cost: 300, blurb: 'Swap two gems with no match needed.' },
  { id: 'lightning', name: 'Lightning', icon: '⚡', cost: 450, blurb: 'Strike a full row and column at once.' },
];

export const BASE_MAX_LIVES = 5;
/** Milliseconds to regenerate one life. */
export const LIFE_REFILL_MS = 20 * 60 * 1000;

export type UpgradeRanks = Record<UpgradeId, number>;

export function emptyRanks(): UpgradeRanks {
  const ranks = {} as UpgradeRanks;
  for (const upgrade of UPGRADES) ranks[upgrade.id] = 0;
  return ranks;
}

/** Engine tuning derived from the player's permanent upgrades. */
export function contextFor(ranks: UpgradeRanks): ResolveContext {
  return {
    cascadeBonus: 0.35 + ranks.momentum * 0.07,
    specialLuck: ranks.luckyDrops * 0.025,
    bombLuck: ranks.alchemy * 0.03,
    blastRadiusBonus: ranks.demolition,
    furnitureScoreBonus: ranks.prospector * 0.08,
    minMoves: 4,
  };
}

export function extraMovesFrom(ranks: UpgradeRanks): number {
  return ranks.deepPockets;
}

export function fuseBonus(ranks: UpgradeRanks): number {
  return ranks.defuser * 2;
}

export function maxLives(ranks: UpgradeRanks): number {
  return BASE_MAX_LIVES + ranks.vitality;
}

export function lifeRefillMs(ranks: UpgradeRanks): number {
  return Math.round(LIFE_REFILL_MS * Math.max(0.25, 1 - ranks.vitality * 0.12));
}

export function coinMultiplier(ranks: UpgradeRanks): number {
  return 1 + ranks.goldRush * 0.1;
}

/** Chance a spent power-up is refunded. */
export function powerupRefundChance(ranks: UpgradeRanks): number {
  return ranks.quartermaster * 0.12;
}

/** Chance a lost life is given back. */
export function lifeRefundChance(ranks: UpgradeRanks): number {
  return ranks.secondWind * 0.25;
}

/** Free specials seeded on every board by the Starlight upgrade. */
export function starlightSpecials(ranks: UpgradeRanks): Special[] {
  const pool = [Special.RocketH, Special.RocketV, Special.Bomb];
  const out: Special[] = [];
  for (let i = 0; i < ranks.starlight; i++) out.push(pool[i % pool.length]);
  return out;
}

/** Specials a set of chosen boosters seeds onto the board. */
export function boosterSpecials(chosen: BoosterId[]): Special[] {
  const specials: Special[] = [];
  if (chosen.includes('rocketPair')) specials.push(Special.RocketH, Special.RocketV);
  if (chosen.includes('bombStart')) specials.push(Special.Bomb, Special.Bomb);
  if (chosen.includes('rainbowStart')) specials.push(Special.Rainbow);
  return specials;
}

export function boosterExtraMoves(chosen: BoosterId[]): number {
  return chosen.includes('extraMoves') ? 5 : 0;
}

/** Coins awarded for finishing a level. */
export function coinReward(
  stars: number,
  leftoverMoves: number,
  firstClear: boolean,
  ranks: UpgradeRanks,
  levelId: number,
): number {
  // Later levels pay more, so the deep tree stays reachable.
  const depth = 1 + Math.floor(levelId / 100) * 0.25;
  const base = (60 + stars * 45 + leftoverMoves * 3 + (firstClear ? 120 : 0)) * depth;
  return Math.round(base * coinMultiplier(ranks));
}

export function upgradeById(id: UpgradeId): UpgradeDef {
  return UPGRADES.find((u) => u.id === id)!;
}

export function shopItemById(id: BoosterId | PowerupId): ShopItem {
  return [...BOOSTERS, ...POWERUPS].find((i) => i.id === id)!;
}
