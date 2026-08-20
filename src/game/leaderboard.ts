import { LEADERBOARD_URL, hasLeaderboard } from './config.js';
import { Profile } from './save.js';

/**
 * Competition without a server.
 *
 * The game is a static site with no backend, so there is nowhere to host a
 * shared table of scores. Instead a result is encoded into a link: opening it
 * records the sender's score as a challenge to beat, and beating it produces a
 * link back. That gives real head-to-head play with no account, no server and
 * nothing to moderate.
 */

export interface Challenge {
  /** Who set it. */
  name: string;
  level: number;
  score: number;
  stars: number;
  /** Epoch ms the challenge was received. */
  at: number;
  /** Best the local player has managed on this level since receiving it. */
  beatenWith?: number;
}

export interface RankRow {
  level: number;
  score: number;
  stars: number;
}

const MAX_NAME = 14;

export function cleanName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || 'Player';
}

/* ------------------------------------------------------------------ *
 * Encoding
 * ------------------------------------------------------------------ */

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Packs a result into the shortest sensible payload. */
export function encodeChallenge(name: string, level: number, score: number, stars: number): string {
  return toBase64Url(JSON.stringify([cleanName(name), level, Math.round(score), stars]));
}

/** Returns null for anything malformed — this arrives from a URL. */
export function decodeChallenge(payload: string): Challenge | null {
  try {
    const parsed = JSON.parse(fromBase64Url(payload));
    if (!Array.isArray(parsed) || parsed.length < 4) return null;
    const [name, level, score, stars] = parsed;
    if (typeof name !== 'string' || typeof level !== 'number' || typeof score !== 'number') return null;
    if (!Number.isFinite(level) || !Number.isFinite(score)) return null;
    if (level < 1 || level > 1000 || score < 0 || score > 1e9) return null;
    return {
      name: cleanName(name),
      level: Math.round(level),
      score: Math.round(score),
      stars: Math.max(0, Math.min(3, Math.round(Number(stars) || 0))),
      at: Date.now(),
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Standings
 * ------------------------------------------------------------------ */

export function personalBest(profile: Profile, limit = 15): RankRow[] {
  return Object.entries(profile.levels)
    .map(([id, rec]) => ({ level: Number(id), score: rec.bestScore, stars: rec.stars }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function totalScore(profile: Profile): number {
  return Object.values(profile.levels).reduce((sum, r) => sum + r.bestScore, 0);
}

export function levelsCleared(profile: Profile): number {
  return Object.keys(profile.levels).length;
}

export function bestOn(profile: Profile, level: number): number {
  return profile.levels[level]?.bestScore ?? 0;
}

/** Challenges still unbeaten, hardest first. */
export function sortChallenges(profile: Profile): Challenge[] {
  const list = profile.challenges ?? [];
  return [...list].sort((a, b) => {
    const aBeat = bestOn(profile, a.level) >= a.score ? 1 : 0;
    const bBeat = bestOn(profile, b.level) >= b.score ? 1 : 0;
    if (aBeat !== bBeat) return aBeat - bBeat;
    return b.at - a.at;
  });
}

/** Records an incoming challenge, replacing any weaker one for that level. */
export function addChallenge(profile: Profile, challenge: Challenge): void {
  if (!profile.challenges) profile.challenges = [];
  const existing = profile.challenges.findIndex(
    (c) => c.level === challenge.level && c.name === challenge.name,
  );
  if (existing >= 0) {
    if (profile.challenges[existing].score >= challenge.score) return;
    profile.challenges[existing] = challenge;
  } else {
    profile.challenges.push(challenge);
  }
  // Keep the list bounded; it lives in local storage.
  profile.challenges = profile.challenges.slice(-40);
}


/* ------------------------------------------------------------------ *
 * Global board
 * ------------------------------------------------------------------ */

export interface GlobalEntry {
  name: string;
  score: number;
  stars: number;
  level: number;
  player: string;
}

/** A stable anonymous id, so one player holds one row on the board. */
export function playerId(profile: Profile): string {
  if (!profile.playerId) {
    profile.playerId =
      'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }
  return profile.playerId;
}

/** Top entries for a level, or level 0 for the all-levels board. */
export async function fetchTop(level: number, signal?: AbortSignal): Promise<GlobalEntry[]> {
  if (!hasLeaderboard()) return [];
  const res = await fetch(`${LEADERBOARD_URL}/top?level=${level}`, { signal });
  if (!res.ok) throw new Error(`leaderboard ${res.status}`);
  const data = (await res.json()) as { entries?: GlobalEntry[] };
  return data.entries ?? [];
}

/** Sends a result. Failure is never fatal — the game is playable offline. */
export async function submitScore(
  profile: Profile,
  level: number,
  score: number,
  stars: number,
): Promise<{ rank: number; entries: GlobalEntry[] } | null> {
  if (!hasLeaderboard() || score <= 0) return null;
  try {
    const res = await fetch(`${LEADERBOARD_URL}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: cleanName(profile.playerName || 'Player'),
        player: playerId(profile),
        level,
        score: Math.round(score),
        stars,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { rank?: number; entries?: GlobalEntry[] };
    return { rank: data.rank ?? 0, entries: data.entries ?? [] };
  } catch {
    return null;
  }
}
