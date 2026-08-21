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


/* ------------------------------------------------------------------ *
 * Accounts
 *
 * Sign-in is a link emailed to the address given: no passwords to store,
 * leak or reset. A link token is single use and short lived; it is
 * exchanged for an opaque session token that the client keeps.
 *
 * An account exists so progress and leaderboard identity survive clearing a
 * browser or changing phone, which device-local storage cannot do.
 * ------------------------------------------------------------------ */

const LINK_TTL_S = 15 * 60;
const SESSION_TTL_S = 60 * 60 * 24 * 365;
/** Exact ranking is served from one blob, which is fine at this scale. */
const XP_BOARD_MAX = 5000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** XP is the career number: every best score, plus a bonus per star. */
function xpFrom(levels) {
  let xp = 0;
  let stars = 0;
  let cleared = 0;
  for (const rec of Object.values(levels ?? {})) {
    const s = Math.max(0, Math.min(3, Number(rec?.stars) || 0));
    const best = Math.max(0, Number(rec?.bestScore) || 0);
    xp += best + s * 2000;
    stars += s;
    cleared += 1;
  }
  return { xp, stars, cleared };
}

async function sendSignInEmail(env, email, link) {
  if (!env.RESEND_API_KEY) return { ok: false, reason: 'email not configured' };
  let detail = '';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'Gem Quest <onboarding@resend.dev>',
      to: [email],
      subject: 'Your Gem Quest sign-in link',
      text: `Tap to sign in to Gem Quest:\n\n${link}\n\nThe link works once and expires in 15 minutes. If you did not ask for it, ignore this email.`,
      html: `<p>Tap to sign in to Gem Quest:</p><p><a href="${link}">Sign in</a></p><p style="color:#666;font-size:13px">The link works once and expires in 15 minutes. If you did not ask for it, ignore this email.</p>`,
    }),
  });
  if (!res.ok) {
    // Surface why, rather than telling the player a link is on its way when
    // it is not. A rejected send is usually a bad key, or the sender domain
    // not being verified with the provider.
    try {
      const body = await res.json();
      detail = body?.message || body?.error?.message || `HTTP ${res.status}`;
    } catch {
      detail = `HTTP ${res.status}`;
    }
    console.log('sign-in email failed:', detail);
    return { ok: false, reason: 'could not send the email', detail };
  }
  return { ok: true };
}

async function sessionUser(env, request) {
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const uid = await env.SCORES.get(`sess:${token}`);
  if (!uid) return null;
  const raw = await env.SCORES.get(`user:${uid}`);
  return raw ? { uid, ...JSON.parse(raw) } : null;
}

async function updateXpBoard(env, user) {
  const raw = await env.SCORES.get('board:xp');
  const board = raw ? JSON.parse(raw) : [];
  const i = board.findIndex((e) => e.uid === user.uid);
  const entry = { uid: user.uid, name: user.name, xp: user.xp, stars: user.stars, cleared: user.cleared };
  if (i >= 0) board[i] = entry;
  else board.push(entry);
  board.sort((a, b) => b.xp - a.xp);
  await env.SCORES.put('board:xp', JSON.stringify(board.slice(0, XP_BOARD_MAX)));
  return board.findIndex((e) => e.uid === user.uid) + 1;
}

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


    /* ---------------- accounts ---------------- */

    if (request.method === 'POST' && url.pathname === '/auth/request') {
      const ip = request.headers.get('cf-connecting-ip') ?? 'anon';
      if (await rateLimited(env, `auth:${ip}`)) return json({ error: 'slow down' }, 429);

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'bad json' }, 400);
      }
      const email = String(body.email ?? '').trim().toLowerCase().slice(0, 200);
      // Always answer the same way, so this cannot be used to discover
      // which addresses have accounts.
      if (!EMAIL_RE.test(email)) return json({ ok: true });

      const token = randomToken();
      await env.SCORES.put(`auth:${token}`, email, { expirationTtl: LINK_TTL_S });
      const link = `${env.SITE_URL}?signin=${token}`;
      const sent = await sendSignInEmail(env, email, link);
      if (!sent.ok) {
        // The token is useless if the mail never left, so do not leave it
        // sitting in storage.
        await env.SCORES.delete(`auth:${token}`);
        return json(
          { error: sent.reason, detail: sent.detail },
          sent.reason === 'email not configured' ? 503 : 502,
        );
      }
      return json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/auth/verify') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'bad json' }, 400);
      }
      const token = String(body.token ?? '');
      if (!/^[a-f0-9]{64}$/.test(token)) return json({ error: 'bad token' }, 400);

      const email = await env.SCORES.get(`auth:${token}`);
      if (!email) return json({ error: 'link expired' }, 401);
      // Single use.
      await env.SCORES.delete(`auth:${token}`);

      let uid = await env.SCORES.get(`email:${email}`);
      if (!uid) {
        uid = `u_${randomToken().slice(0, 24)}`;
        await env.SCORES.put(`email:${email}`, uid);
        await env.SCORES.put(
          `user:${uid}`,
          JSON.stringify({ email, name: email.split('@')[0].slice(0, 14), levels: {}, xp: 0, stars: 0, cleared: 0 }),
        );
      }
      const session = randomToken();
      await env.SCORES.put(`sess:${session}`, uid, { expirationTtl: SESSION_TTL_S });
      const user = JSON.parse(await env.SCORES.get(`user:${uid}`));
      return json({ ok: true, session, user: { uid, name: user.name, email: user.email, xp: user.xp, stars: user.stars, cleared: user.cleared } });
    }

    if (request.method === 'GET' && url.pathname === '/me') {
      const user = await sessionUser(env, request);
      if (!user) return json({ error: 'not signed in' }, 401);
      const rank = await updateXpBoard(env, user);
      return json({ user: { uid: user.uid, name: user.name, email: user.email, xp: user.xp, stars: user.stars, cleared: user.cleared, levels: user.levels }, rank });
    }

    if (request.method === 'POST' && url.pathname === '/sync') {
      const user = await sessionUser(env, request);
      if (!user) return json({ error: 'not signed in' }, 401);

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'bad json' }, 400);
      }

      // Merge best-of per level; the account is the source of truth.
      const merged = { ...(user.levels ?? {}) };
      const incoming = body.levels ?? {};
      for (const [id, rec] of Object.entries(incoming).slice(0, 1000)) {
        const level = Number(id);
        if (!Number.isInteger(level) || level < 1 || level > 1000) continue;
        const best = Math.max(0, Math.min(plausibleMax(level), Number(rec?.bestScore) || 0));
        const stars = Math.max(0, Math.min(3, Number(rec?.stars) || 0));
        const prev = merged[level] ?? { bestScore: 0, stars: 0 };
        merged[level] = {
          bestScore: Math.max(prev.bestScore, best),
          stars: Math.max(prev.stars, stars),
        };
      }

      const name = body.name ? cleanName(body.name) : user.name;
      if (BLOCKED.test(name)) return json({ error: 'name rejected' }, 400);

      const totals = xpFrom(merged);
      const updated = { email: user.email, name, levels: merged, ...totals };
      await env.SCORES.put(`user:${user.uid}`, JSON.stringify(updated));
      const rank = await updateXpBoard(env, { uid: user.uid, ...updated });
      return json({ ok: true, user: { uid: user.uid, ...updated }, rank });
    }

    if (request.method === 'POST' && url.pathname === '/auth/signout') {
      const auth = request.headers.get('authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (token) await env.SCORES.delete(`sess:${token}`);
      return json({ ok: true });
    }

    /* ---------------- global XP board ---------------- */

    if (request.method === 'GET' && url.pathname === '/xp/top') {
      const raw = await env.SCORES.get('board:xp');
      const board = raw ? JSON.parse(raw) : [];
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 50)));
      const uid = url.searchParams.get('uid');
      const you = uid ? board.findIndex((e) => e.uid === uid) : -1;
      return json({
        total: board.length,
        entries: board.slice(0, limit).map((e) => ({ name: e.name, xp: e.xp, stars: e.stars, cleared: e.cleared, uid: e.uid })),
        // Position and neighbours, so a player outside the top still sees
        // exactly where they stand.
        you: you >= 0
          ? {
              rank: you + 1,
              around: board
                .slice(Math.max(0, you - 2), you + 3)
                .map((e, i) => ({ rank: Math.max(0, you - 2) + i + 1, name: e.name, xp: e.xp, uid: e.uid })),
            }
          : null,
      });
    }

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
