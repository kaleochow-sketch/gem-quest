/**
 * Deployment configuration.
 *
 * Both of these are empty by default, which keeps the game fully playable
 * with no backend: the leaderboard falls back to local scores and challenge
 * links, and the paid shop stays hidden. Fill them in once the services in
 * `server/` are deployed.
 */

/** Base URL of the leaderboard Worker, e.g. https://gem-quest-leaderboard.you.workers.dev */
export const LEADERBOARD_URL = 'https://gem-quest-leaderboard.kaleo-chow.workers.dev';

/**
 * Payments are served by the same Worker as the leaderboard, so there is no
 * separate URL. Whether the shop appears is decided by the server, which
 * reports it only once a Stripe key is configured.
 */

export const hasLeaderboard = (): boolean => LEADERBOARD_URL.length > 0;

