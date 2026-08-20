/**
 * Gem Quest global leaderboard — a single Cloudflare Worker.
 *
 * Deploy this and put its URL in src/game/config.ts. It needs one KV
 * namespace bound as SCORES.
 *
 * Scores arrive from a browser running open-source code, so nothing the
 * client says can be trusted. Everything here is defensive: submissions are
 * range-checked against what the level can plausibly produce, names are
 * filtered, and each IP is rate limited. This raises the cost of spoofing;
 * it cannot make it impossible without running the game on the server.
 */

const MAX_NAME = 14;
const TOP_N = 100;
/** Submissions allowed per IP per window. */
const RATE_LIMIT = 20;
const RATE_WINDOW_S = 60;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });

/**
 * Loose upper bound on a believable score. This is a sanity check against
 * absurd values, not a judgement on skill — a strong run with deep cascades
 * and a big leftover-move bonus can score far above a typical clear, and
 * rejecting a real score is worse than admitting an inflated one. The client
 * is open source, so this can never be airtight; it raises the cost of
 * casual spoofing and nothing more.
 */
function plausibleMax(level) {
  return 250000 + level * 2500;
}

function cleanName(raw) {
  const stripped = String(raw ?? '')
    .replace(/[^\p{L}\p{N} _.\-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
  return stripped || 'Player';
}

const BLOCKED = /\b(fuck|shit|cunt|nigg|fagg|rape|nazi)/i;

async function rateLimited(env, ip) {
  const key = `rl:${ip}`;
  const current = Number((await env.SCORES.get(key)) ?? 0);
  if (current >= RATE_LIMIT) return true;
  await env.SCORES.put(key, String(current + 1), { expirationTtl: RATE_WINDOW_S });
  return false;
}

async function readBoard(env, level) {
  const raw = await env.SCORES.get(`board:${level}`);
  return raw ? JSON.parse(raw) : [];
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/top') {
      const level = Number(url.searchParams.get('level') ?? 0);
      if (!Number.isInteger(level) || level < 0 || level > 1000) {
        return json({ error: 'bad level' }, 400);
      }
      return json({ level, entries: (await readBoard(env, level)).slice(0, 50) });
    }

    if (request.method === 'POST' && url.pathname === '/submit') {
      const ip = request.headers.get('cf-connecting-ip') ?? 'anon';
      if (await rateLimited(env, ip)) return json({ error: 'slow down' }, 429);

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'bad json' }, 400);
      }

      const level = Number(body.level);
      const score = Number(body.score);
      const stars = Number(body.stars);
      if (!Number.isInteger(level) || level < 1 || level > 1000) return json({ error: 'bad level' }, 400);
      if (!Number.isFinite(score) || score <= 0 || score > plausibleMax(level)) {
        return json({ error: 'implausible score' }, 400);
      }
      if (!Number.isInteger(stars) || stars < 0 || stars > 3) return json({ error: 'bad stars' }, 400);

      const name = cleanName(body.name);
      if (BLOCKED.test(name)) return json({ error: 'name rejected' }, 400);
      // A stable per-player id so one player holds one row, not many.
      const player = String(body.player ?? '').slice(0, 40) || `anon-${ip}`;

      for (const key of [level, 0]) {
        const board = await readBoard(env, key);
        const existing = board.findIndex((e) => e.player === player);
        const entry = { name, score: Math.round(score), stars, level, at: Date.now(), player };
        if (key === 0) {
          // The all-levels board ranks a player's single best run.
          if (existing >= 0 && board[existing].score >= entry.score) continue;
        } else if (existing >= 0 && board[existing].score >= entry.score) {
          continue;
        }
        if (existing >= 0) board.splice(existing, 1);
        board.push(entry);
        board.sort((a, b) => b.score - a.score);
        await env.SCORES.put(`board:${key}`, JSON.stringify(board.slice(0, TOP_N)));
      }

      const board = await readBoard(env, level);
      return json({ ok: true, rank: board.findIndex((e) => e.player === player) + 1, entries: board.slice(0, 50) });
    }

    return json({ error: 'not found' }, 404);
  },
};
