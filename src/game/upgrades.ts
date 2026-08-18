import { ResolveContext } from '../engine/board.js';
import { Special } from '../engine/types.js';

export type UpgradeId = 'deepPockets' | 'momentum' | 'luckyDrops' | 'goldRush' | 'vitality';
export type BoosterId = 'extraMoves' | 'rocketPair' | 'rainbowStart';
export type PowerupId = 'hammer' | 'shuffle' | 'freeswap';

export interface UpgradeDef {
  id: UpgradeId;
  name: string;
  icon: string;
  maxRank: number;
  /** Cost of moving from rank r to r+1. */
  cost: (rank: number) => number;
  /** Player-facing effect at a given rank. */
  describe: (rank: number) => string;
}

export interface ShopItem {
  id: BoosterId | PowerupId;
  name: string;
  icon: string;
  cost: number;
  blurb: string;
}

/** Permanent upgrades — bought once, felt in every level afterwards. */
export const UPGRADES: UpgradeDef[] = [
  {
    id: 'deepPockets',
    name: 'Deep Pockets',
    icon: '👝',
    maxRank: 5,
    cost: (rank) => 400 + rank * 500,
    describe: (rank) => (rank ? `+${rank} move on every level` : '+1 move on every level'),
  },
  {
    id: 'momentum',
    name: 'Momentum',
    icon: '🌀',
    maxRank: 5,
    cost: (rank) => 500 + rank * 600,
    describe: (rank) => `+${(rank || 1) * 8}% score per cascade`,
  },
  {
    id: 'luckyDrops',
    name: 'Lucky Drops',
    icon: '🍀',
    maxRank: 5,
    cost: (rank) => 600 + rank * 700,
    describe: (rank) => `${(rank || 1) * 3}% chance a 3-match makes a rocket`,
  },
  {
    id: 'goldRush',
    name: 'Gold Rush',
    icon: '💰',
    maxRank: 5,
    cost: (rank) => 450 + rank * 550,
    describe: (rank) => `+${(rank || 1) * 12}% coins earned`,
  },
  {
    id: 'vitality',
    name: 'Vitality',
    icon: '❤️',
    maxRank: 3,
    cost: (rank) => 700 + rank * 900,
    describe: (rank) => `+${rank || 1} max life, faster refill`,
  },
];

/** Consumables chosen before the level starts. */
export const BOOSTERS: ShopItem[] = [
  { id: 'extraMoves', name: '+5 Moves', icon: '➕', cost: 250, blurb: 'Start with five extra moves.' },
  { id: 'rocketPair', name: 'Twin Rockets', icon: '🚀', cost: 400, blurb: 'Two rockets on the opening board.' },
  { id: 'rainbowStart', name: 'Prism Gem', icon: '🌈', cost: 600, blurb: 'Begin with a colour bomb in play.' },
];

/** Consumables used mid-level. */
export const POWERUPS: ShopItem[] = [
  { id: 'hammer', name: 'Hammer', icon: '🔨', cost: 200, blurb: 'Smash any single gem or blocker.' },
  { id: 'shuffle', name: 'Shuffle', icon: '🔀', cost: 150, blurb: 'Reshuffle the whole board.' },
  { id: 'freeswap', name: 'Free Swap', icon: '🔁', cost: 300, blurb: 'Swap two gems with no match needed.' },
];

export const BASE_MAX_LIVES = 5;
/** Milliseconds to regenerate one life. */
export const LIFE_REFILL_MS = 20 * 60 * 1000;

export type UpgradeRanks = Record<UpgradeId, number>;

export function emptyRanks(): UpgradeRanks {
  return { deepPockets: 0, momentum: 0, luckyDrops: 0, goldRush: 0, vitality: 0 };
}

/** Engine tuning derived from the player's permanent upgrades. */
export function contextFor(ranks: UpgradeRanks): ResolveContext {
  return {
    cascadeBonus: 0.35 + ranks.momentum * 0.08,
    specialLuck: ranks.luckyDrops * 0.03,
    minMoves: 4,
  };
}

export function extraMovesFrom(ranks: UpgradeRanks): number {
  return ranks.deepPockets;
}

export function maxLives(ranks: UpgradeRanks): number {
  return BASE_MAX_LIVES + ranks.vitality;
}

export function lifeRefillMs(ranks: UpgradeRanks): number {
  return Math.round(LIFE_REFILL_MS * (1 - ranks.vitality * 0.15));
}

export function coinMultiplier(ranks: UpgradeRanks): number {
  return 1 + ranks.goldRush * 0.12;
}

/** Specials a set of chosen boosters seeds onto the board. */
export function boosterSpecials(chosen: BoosterId[]): Special[] {
  const specials: Special[] = [];
  if (chosen.includes('rocketPair')) specials.push(Special.RocketH, Special.RocketV);
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
): number {
  const base = 60 + stars * 45 + leftoverMoves * 3 + (firstClear ? 100 : 0);
  return Math.round(base * coinMultiplier(ranks));
}

export function upgradeById(id: UpgradeId): UpgradeDef {
  return UPGRADES.find((u) => u.id === id)!;
}

export function shopItemById(id: BoosterId | PowerupId): ShopItem {
  return [...BOOSTERS, ...POWERUPS].find((i) => i.id === id)!;
}
