import { PAYMENTS_URL, hasPayments } from './config.js';
import { playerId } from './leaderboard.js';
import { Profile } from './save.js';

/**
 * Real-money items.
 *
 * The catalogue and its prices are authoritative on the server; this list is
 * only for display, so a tampered client can misdescribe an item but cannot
 * change what it costs. Entitlements are granted to the device that paid,
 * because the game has no accounts — see `server/payments-worker.js`.
 */

export type Sku = 'coins_small' | 'coins_large' | 'golden_paw' | 'treasure_hound' | 'nine_lives';

export interface StoreItem {
  sku: Sku;
  name: string;
  blurb: string;
  icon: string;
  /** Display only. The server charges its own price. */
  price: string;
  /** One-off consumable, or a permanent entitlement. */
  permanent: boolean;
}

export const STORE: StoreItem[] = [
  {
    sku: 'coins_small',
    name: 'Pouch of coins',
    blurb: '5,000 coins, straight away.',
    icon: '💰',
    price: '$1.99',
    permanent: false,
  },
  {
    sku: 'coins_large',
    name: 'Chest of coins',
    blurb: '30,000 coins — the better value.',
    icon: '🧰',
    price: '$7.99',
    permanent: false,
  },
  {
    sku: 'golden_paw',
    name: 'Golden Paw',
    blurb: '+2 moves on every level, forever.',
    icon: '🐾',
    price: '$4.99',
    permanent: true,
  },
  {
    sku: 'treasure_hound',
    name: 'Treasure Hound',
    blurb: '+50% coins from every level, forever.',
    icon: '🦴',
    price: '$4.99',
    permanent: true,
  },
  {
    sku: 'nine_lives',
    name: 'Nine Lives',
    blurb: '+5 maximum lives, forever.',
    icon: '❤️‍🔥',
    price: '$3.99',
    permanent: true,
  },
];

export function owns(profile: Profile, sku: Sku): boolean {
  return (profile.purchases ?? []).includes(sku);
}

/** Applies what was bought. Coins stack; entitlements are recorded once. */
export function grant(profile: Profile, sku: Sku): string {
  if (!profile.purchases) profile.purchases = [];
  switch (sku) {
    case 'coins_small':
      profile.coins += 5000;
      return '5,000 coins added';
    case 'coins_large':
      profile.coins += 30000;
      return '30,000 coins added';
    default:
      if (!profile.purchases.includes(sku)) profile.purchases.push(sku);
      return 'Unlocked';
  }
}

/* ------------------------------------------------------------------ *
 * Entitlement effects
 * ------------------------------------------------------------------ */

export function purchasedExtraMoves(profile: Profile): number {
  return owns(profile, 'golden_paw') ? 2 : 0;
}

export function purchasedCoinMultiplier(profile: Profile): number {
  return owns(profile, 'treasure_hound') ? 1.5 : 1;
}

export function purchasedExtraLives(profile: Profile): number {
  return owns(profile, 'nine_lives') ? 5 : 0;
}

/* ------------------------------------------------------------------ *
 * Checkout
 * ------------------------------------------------------------------ */

/** Sends the player to Stripe's hosted page. Cards never reach this app. */
export async function startCheckout(profile: Profile, sku: Sku): Promise<string | null> {
  if (!hasPayments()) return null;
  const res = await fetch(`${PAYMENTS_URL}/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku, player: playerId(profile) }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { url?: string };
  return data.url ?? null;
}

/** Verifies a completed session with the server before granting anything. */
export async function redeem(sessionId: string): Promise<Sku | null> {
  if (!hasPayments()) return null;
  try {
    const res = await fetch(`${PAYMENTS_URL}/redeem?session_id=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { ok?: boolean; sku?: Sku };
    return data.ok && data.sku ? data.sku : null;
  } catch {
    return null;
  }
}
