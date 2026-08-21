import { LEADERBOARD_URL, hasLeaderboard } from './config.js';
import { Profile, saveProfile } from './save.js';

/**
 * Email sign-in.
 *
 * A link is emailed, exchanged once for a session token, and that token is
 * what the client keeps. There is no password to store, leak or reset.
 *
 * The point of an account is durability: local storage is tied to one browser
 * on one device, so clearing data or changing phone loses everything. An
 * account makes progress and leaderboard identity portable.
 */

const SESSION_KEY = 'gem-quest/session/v1';

export interface Account {
  uid: string;
  name: string;
  email: string;
  xp: number;
  stars: number;
  cleared: number;
  levels?: Record<string, { bestScore: number; stars: number }>;
}

export function sessionToken(): string {
  try {
    return localStorage.getItem(SESSION_KEY) ?? '';
  } catch {
    return '';
  }
}

function setSession(token: string): void {
  try {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode */
  }
}

export function signedIn(): boolean {
  return hasLeaderboard() && sessionToken().length > 0;
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

/** Asks for a sign-in link. Returns an error string, or null on success. */
export async function requestSignIn(email: string): Promise<string | null> {
  if (!hasLeaderboard()) return 'Accounts are not available yet';
  try {
    const res = await api('/auth/request', { method: 'POST', body: JSON.stringify({ email }) });
    if (res.status === 503) return 'Email sending is not configured on the server yet';
    if (res.status === 429) return 'Too many attempts — wait a minute';
    if (!res.ok) return 'Could not send the link';
    return null;
  } catch {
    return 'Could not reach the server';
  }
}

/** Exchanges a link token for a session. */
export async function verifyToken(token: string): Promise<Account | null> {
  try {
    const res = await api('/auth/verify', { method: 'POST', body: JSON.stringify({ token }) });
    if (!res.ok) return null;
    const data = (await res.json()) as { session?: string; user?: Account };
    if (!data.session || !data.user) return null;
    setSession(data.session);
    return data.user;
  } catch {
    return null;
  }
}

export async function me(): Promise<{ user: Account; rank: number } | null> {
  if (!signedIn()) return null;
  try {
    const res = await api('/me');
    if (res.status === 401) {
      setSession('');
      return null;
    }
    if (!res.ok) return null;
    return (await res.json()) as { user: Account; rank: number };
  } catch {
    return null;
  }
}

/** Pushes local progress up and takes back the merged result. */
export async function sync(profile: Profile): Promise<{ user: Account; rank: number } | null> {
  if (!signedIn()) return null;
  try {
    const res = await api('/sync', {
      method: 'POST',
      body: JSON.stringify({ name: profile.playerName || undefined, levels: profile.levels }),
    });
    if (res.status === 401) {
      setSession('');
      return null;
    }
    if (!res.ok) return null;
    return (await res.json()) as { user: Account; rank: number };
  } catch {
    return null;
  }
}

/** Folds the account's records into the local profile, keeping the better. */
export function adoptAccountProgress(profile: Profile, account: Account): boolean {
  let changed = false;
  for (const [id, rec] of Object.entries(account.levels ?? {})) {
    const level = Number(id);
    const local = profile.levels[level];
    const bestScore = Math.max(local?.bestScore ?? 0, rec.bestScore ?? 0);
    const stars = Math.max(local?.stars ?? 0, rec.stars ?? 0);
    if (!local || local.bestScore !== bestScore || local.stars !== stars) {
      profile.levels[level] = { bestScore, stars };
      changed = true;
    }
    if (level >= profile.unlocked) {
      profile.unlocked = Math.min(1000, level + 1);
      changed = true;
    }
  }
  if (account.name && profile.playerName !== account.name) {
    profile.playerName = account.name;
    changed = true;
  }
  if (changed) saveProfile(profile);
  return changed;
}

export async function signOut(): Promise<void> {
  try {
    await api('/auth/signout', { method: 'POST' });
  } catch {
    /* best effort */
  }
  setSession('');
}

export interface XpRow {
  name: string;
  xp: number;
  stars: number;
  cleared: number;
  uid: string;
}

/** A neighbouring row, which carries its absolute position. */
export interface XpNeighbour {
  rank: number;
  name: string;
  xp: number;
  uid: string;
}

/** The global XP table, plus exactly where you stand in it. */
export async function fetchXpBoard(
  uid?: string,
): Promise<{ entries: XpRow[]; total: number; you: { rank: number; around: XpNeighbour[] } | null }> {
  const res = await fetch(`${LEADERBOARD_URL}/xp/top?limit=50${uid ? `&uid=${encodeURIComponent(uid)}` : ''}`);
  if (!res.ok) throw new Error(`xp board ${res.status}`);
  return (await res.json()) as {
    entries: XpRow[];
    total: number;
    you: { rank: number; around: XpNeighbour[] } | null;
  };
}
