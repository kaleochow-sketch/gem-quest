/**
 * Deployment configuration.
 *
 * Both of these are empty by default, which keeps the game fully playable
 * with no backend: the leaderboard falls back to local scores and challenge
 * links, and the paid shop stays hidden. Fill them in once the services in
 * `server/` are deployed.
 */

/** Base URL of the leaderboard Worker, e.g. https://gem-quest-leaderboard.you.workers.dev */
export const LEADERBOARD_URL = '';

/** Base URL of the payments Worker. Leave empty to hide paid items entirely. */
export const PAYMENTS_URL = '';

export const hasLeaderboard = (): boolean => LEADERBOARD_URL.length > 0;
export const hasPayments = (): boolean => PAYMENTS_URL.length > 0;
