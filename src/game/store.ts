import { LEADERBOARD_URL, hasLeaderboard } from './config.js';
import { Profile, saveProfile } from './save.js';
import { sessionToken } from './account.js';

/**
 * Real-money purchases.
 *
 * The catalogue and the prices come from the server, never from here: if the
 * client proposed a price, a player could pay a penny for anything. The card
 * is entered on a Stripe-hosted page, so no payment detail touches this game.
 *
 * Entitlements belong to the account rather than the device, which is why
 * buying requires signing in — otherwise clearing a browser would destroy
 * something someone paid for.
 */

export interface StoreItem {
  sku: string;
  name: string;
  /** Minor units, e.g. 199 = $1.99. */
  amount: number;
  coins: number;
  perk: string | null;
}

export interface Entitlements {
  coinsGranted: number;
  perks: Record<string, boolean>;
}

const ICONS: Record<string, string> = {
  coins_small: '🪙',
  coins_large: '💰',
  golden_paw: '🐾',
  treasure_hound: '🦴',
  nine_lives: '❤️',
};

export const iconFor = (sku: string): string => ICONS[sku] ?? '💎';

export function priceLabel(amount: number, currency = 'usd'): string {
  const symbol = currency === 'usd' ? '$' : '';
  return `${symbol}${(amount / 100).toFixed(2)}`;
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const token = sessionToken();
  return fetch(`${LEADERBOARD_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

export async function fetchCatalogue(): Promise<{ enabled: boolean; currency: string; items: StoreItem[] }> {
  if (!hasLeaderboard()) return { enabled: false, currency: 'usd', items: [] };
  const res = await fetch(`${LEADERBOARD_URL}/store`);
  if (!res.ok) throw new Error(`store ${res.status}`);
  return (await res.json()) as { enabled: boolean; currency: string; items: StoreItem[] };
}

/** Returns the Stripe URL to send the player to, or an error string. */
export async function startCheckout(sku: string): Promise<{ url?: string; error?: string }> {
  try {
    const res = await api('/checkout', { method: 'POST', body: JSON.stringify({ sku }) });
    if (res.status === 401) return { error: 'Sign in before buying' };
    if (res.status === 503) return { error: 'Payments are not switched on yet' };
    const body = (await res.json()) as { url?: string; error?: string };
    if (!res.ok || !body.url) return { error: body.error ?? 'Could not start checkout' };
    return { url: body.url };
  } catch {
    return { error: 'Could not reach the payment service' };
  }
}

/** Asks the server to confirm a completed checkout with Stripe. */
export async function confirmPurchase(session: string): Promise<Entitlements | null> {
  try {
    const res = await api('/purchase/confirm', { method: 'POST', body: JSON.stringify({ session }) });
    if (!res.ok) return null;
    const body = (await res.json()) as { entitlements?: Entitlements };
    return body.entitlements ?? null;
  } catch {
    return null;
  }
}

/**
 * Credits any purchased coins not yet applied on this device, and mirrors the
 * perks locally. Comparing against a claimed total makes this safe to run on
 * every load and on every device.
 */
export function applyEntitlements(profile: Profile, ent: Entitlements | null | undefined): number {
  if (!ent) return 0;
  const granted = ent.coinsGranted ?? 0;
  const claimed = profile.coinsClaimed ?? 0;
  let credited = 0;
  if (granted > claimed) {
    credited = granted - claimed;
    profile.coins += credited;
    profile.coinsClaimed = granted;
  }
  profile.perks = { ...(profile.perks ?? {}), ...(ent.perks ?? {}) };
  saveProfile(profile);
  return credited;
}

export const hasPerk = (profile: Profile, perk: string): boolean => Boolean(profile.perks?.[perk]);
