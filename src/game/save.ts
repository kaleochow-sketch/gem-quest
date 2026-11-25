import {
  BoosterId,
  PowerupId,
  UpgradeId,
  UpgradeRanks,
  emptyRanks,
  lifeRefillMs,
  maxLives,
  upgradeById,
} from './upgrades.js';

const STORAGE_KEY = 'gem-quest/profile/v1';
/** Bumped when a saved profile needs migrating. */
const PROFILE_VERSION = 2;

export interface LevelRecord {
  stars: number;
  bestScore: number;
}

export interface Profile {
  version: number;
  coins: number;
  /** Highest level the player may enter. */
  unlocked: number;
  levels: Record<number, LevelRecord>;
  upgrades: UpgradeRanks;
  inventory: Record<string, number>;
  lives: number;
  /** Epoch ms the life timer last ticked. */
  livesUpdatedAt: number;
  soundOn: boolean;
  musicOn: boolean;
  /** Drop decorative effects for speed. */
  lowFx?: boolean;
  /** Shown on challenge links you send. */
  playerName?: string;
  /** Stable anonymous id used to hold one row on the global board. */
  playerId?: string;
  /** Purchased coins already credited on this device. */
  coinsClaimed?: number;
  /** Permanent things bought with real money. */
  perks?: Record<string, boolean>;
  /** Results other players have sent you. */
  challenges?: import('./leaderboard.js').Challenge[];
  /** Permanent entitlements bought with real money. */
  purchases?: string[];
  /** Tutorial cards already shown. */
  seen?: string[];
  /** The install banner was dismissed. */
  installDismissed?: boolean;
  /** Developer tools unlocked (see the Dev tab in the shop). */
  dev?: boolean;
  /** Purchases stop deducting coins. */
  infiniteCoins?: boolean;
  /** Lives are never spent. */
  infiniteLives?: boolean;
  /** Pieces built per project id (see build.ts). */
  build?: Record<string, number>;
  /** Minigame bookkeeping. */
  fun?: FunState;
  /** 3D places being restored (see cafe.ts). */
  world?: {
    cafe?: import('./cafe.js').CafeState;
    /** The real day the dog last slept, in any place. */
    slept?: string;
    /** Other places, keyed by id (see places.ts). */
    [place: string]: unknown;
  };
}

export type MinigameKind = 'fetch' | 'wheel' | 'memory' | 'dig';

export interface FunState {
  /** Local date (YYYY-MM-DD) each minigame's free daily play was last used. */
  played?: Partial<Record<MinigameKind, string>>;
  /** Bonus rounds earned between levels and not yet played. */
  pending?: MinigameKind[];
}

/** Today's local date, for once-a-day rewards. */
export function today(now = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

function defaultProfile(): Profile {
  return {
    version: PROFILE_VERSION,
    coins: 500,
    unlocked: 1,
    levels: {},
    upgrades: emptyRanks(),
    inventory: { hammer: 1, shuffle: 1, freeswap: 1, lightning: 1 },
    lives: 5,
    livesUpdatedAt: Date.now(),
    soundOn: true,
    musicOn: true,
    lowFx: false,
    playerName: '',
    coinsClaimed: 0,
    perks: {},
    challenges: [],
    purchases: [],
    seen: [],
    installDismissed: false,
    dev: false,
    infiniteCoins: false,
    infiniteLives: false,
    build: {},
    fun: { played: {}, pending: [] },
  };
}

/** Reads the saved profile, repairing anything missing or corrupt. */
export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultProfile();
    const parsed = JSON.parse(raw) as Partial<Profile>;
    const base = defaultProfile();
    const profile: Profile = {
      ...base,
      ...parsed,
      upgrades: { ...base.upgrades, ...(parsed.upgrades ?? {}) },
      inventory: { ...base.inventory, ...(parsed.inventory ?? {}) },
      levels: parsed.levels ?? {},
      challenges: parsed.challenges ?? [],
      purchases: parsed.purchases ?? [],
      seen: parsed.seen ?? [],
      build: parsed.build ?? {},
      fun: { played: parsed.fun?.played ?? {}, pending: parsed.fun?.pending ?? [] },
      version: PROFILE_VERSION,
    };
    // v2 introduced Lightning; make sure existing saves get one to try.
    if ((parsed.version ?? 1) < 2) {
      profile.inventory.lightning = Math.max(1, profile.inventory.lightning ?? 0);
    }
    return refillLives(profile);
  } catch {
    return defaultProfile();
  }
}

export function saveProfile(profile: Profile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Private-mode browsers block writes; the session still plays fine.
  }
}

export function resetProfile(): Profile {
  const fresh = defaultProfile();
  saveProfile(fresh);
  return fresh;
}

/* ------------------------------------------------------------------ *
 * Lives
 * ------------------------------------------------------------------ */

/**
 * Upgrade cap plus any purchased entitlement. Store purchases land in
 * `perks`; `purchases` is the older field, still honoured for old saves.
 */
export function livesCap(profile: Profile): number {
  const nineLives =
    Boolean(profile.perks?.nine_lives) || (profile.purchases ?? []).includes('nine_lives');
  return maxLives(profile.upgrades) + (nineLives ? 5 : 0);
}

/** Credits any lives earned since the last tick. */

export function refillLives(profile: Profile, now = Date.now()): Profile {
  const cap = livesCap(profile);
  if (profile.lives >= cap) {
    profile.lives = Math.min(profile.lives, cap);
    profile.livesUpdatedAt = now;
    return profile;
  }
  const interval = lifeRefillMs(profile.upgrades);
  const elapsed = now - profile.livesUpdatedAt;
  if (elapsed < interval) return profile;
  const earned = Math.floor(elapsed / interval);
  profile.lives = Math.min(cap, profile.lives + earned);
  profile.livesUpdatedAt =
    profile.lives >= cap ? now : profile.livesUpdatedAt + earned * interval;
  return profile;
}

/** Milliseconds until the next life, or 0 when full. */
export function msToNextLife(profile: Profile, now = Date.now()): number {
  if (profile.lives >= livesCap(profile)) return 0;
  return Math.max(0, profile.livesUpdatedAt + lifeRefillMs(profile.upgrades) - now);
}

export function spendLife(profile: Profile): boolean {
  refillLives(profile);
  if (profile.infiniteLives) return true;
  if (profile.lives <= 0) return false;
  if (profile.lives >= livesCap(profile)) profile.livesUpdatedAt = Date.now();
  profile.lives--;
  return true;
}

/* ------------------------------------------------------------------ *
 * Progress and purchases
 * ------------------------------------------------------------------ */

export function recordResult(
  profile: Profile,
  levelId: number,
  stars: number,
  score: number,
): { firstClear: boolean } {
  const existing = profile.levels[levelId];
  const firstClear = !existing;
  profile.levels[levelId] = {
    stars: Math.max(stars, existing?.stars ?? 0),
    bestScore: Math.max(score, existing?.bestScore ?? 0),
  };
  if (levelId >= profile.unlocked) profile.unlocked = levelId + 1;
  return { firstClear };
}

/** True the first time a tutorial card is requested; false thereafter. */
export function markSeen(profile: Profile, key: string): boolean {
  const seen = profile.seen ?? (profile.seen = []);
  if (seen.includes(key)) return false;
  seen.push(key);
  return true;
}

export function hasSeen(profile: Profile, key: string): boolean {
  return (profile.seen ?? []).includes(key);
}

export function totalStars(profile: Profile): number {
  return Object.values(profile.levels).reduce((sum, r) => sum + r.stars, 0);
}

export function starsFor(profile: Profile, levelId: number): number {
  return profile.levels[levelId]?.stars ?? 0;
}

export function buyUpgrade(profile: Profile, id: UpgradeId): boolean {
  const def = upgradeById(id);
  const rank = profile.upgrades[id] ?? 0;
  if (rank >= def.maxRank) return false;
  // Star gate is enforced in the model, not only in the shop UI.
  if (totalStars(profile) < def.starsRequired) return false;
  const cost = def.cost(rank);
  if (!profile.infiniteCoins) {
    if (profile.coins < cost) return false;
    profile.coins -= cost;
  }
  profile.upgrades[id] = rank + 1;
  if (id === 'vitality') profile.lives = Math.min(livesCap(profile), profile.lives + 1);
  return true;
}

export function buyItem(profile: Profile, id: BoosterId | PowerupId, cost: number): boolean {
  if (!profile.infiniteCoins) {
    if (profile.coins < cost) return false;
    profile.coins -= cost;
  }
  profile.inventory[id] = (profile.inventory[id] ?? 0) + 1;
  return true;
}

export function countItem(profile: Profile, id: BoosterId | PowerupId): number {
  return profile.inventory[id] ?? 0;
}

export function consumeItem(profile: Profile, id: BoosterId | PowerupId): boolean {
  if (countItem(profile, id) <= 0) return false;
  if (!profile.infiniteCoins) profile.inventory[id]--;
  return true;
}
