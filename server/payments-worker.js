/**
 * Gem Quest payments — a Cloudflare Worker in front of Stripe Checkout.
 *
 * The card never touches this code or the game: the player is sent to a
 * Stripe-hosted page. This Worker only creates the session and, afterwards,
 * asks Stripe whether it was actually paid.
 *
 * Entitlements are granted to the device that paid, because the game has no
 * accounts. A session can be redeemed once; replaying the return URL will not
 * grant anything twice.
 *
 * Needs:
 *   secret  STRIPE_SECRET_KEY   (npx wrangler secret put STRIPE_SECRET_KEY)
 *   kv      ORDERS              (npx wrangler kv namespace create ORDERS)
 *   var     SITE_URL            the deployed game URL
 */

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
 * The catalogue lives on the server. Prices must never come from the client,
 * or a player could pay one cent for anything.
 */
const CATALOGUE = {
  coins_small: { name: 'Pouch of 5,000 coins', amount: 199, currency: 'usd' },
  coins_large: { name: 'Chest of 30,000 coins', amount: 799, currency: 'usd' },
  golden_paw: { name: 'Golden Paw — +2 moves on every level, forever', amount: 499, currency: 'usd' },
  treasure_hound: { name: 'Treasure Hound — +50% coins, forever', amount: 499, currency: 'usd' },
  nine_lives: { name: 'Nine Lives — +5 maximum lives, forever', amount: 399, currency: 'usd' },
};

async function stripe(env, path, form) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: form ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
  return { ok: res.ok, data: await res.json() };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/catalogue') {
      return json({
        items: Object.entries(CATALOGUE).map(([sku, i]) => ({
          sku,
          name: i.name,
          amount: i.amount,
          currency: i.currency,
        })),
      });
    }

    if (request.method === 'POST' && url.pathname === '/checkout') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'bad json' }, 400);
      }
      const item = CATALOGUE[body.sku];
      if (!item) return json({ error: 'unknown item' }, 400);
      const player = String(body.player ?? '').slice(0, 40);
      if (!player) return json({ error: 'missing player' }, 400);

      const { ok, data } = await stripe(env, 'checkout/sessions', {
        mode: 'payment',
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': item.currency,
        'line_items[0][price_data][unit_amount]': String(item.amount),
        'line_items[0][price_data][product_data][name]': item.name,
        'metadata[sku]': body.sku,
        'metadata[player]': player,
        success_url: `${env.SITE_URL}?purchase={CHECKOUT_SESSION_ID}`,
        cancel_url: `${env.SITE_URL}?purchase=cancelled`,
      });
      if (!ok) return json({ error: data?.error?.message ?? 'stripe error' }, 502);
      return json({ url: data.url });
    }

    if (request.method === 'GET' && url.pathname === '/redeem') {
      const id = url.searchParams.get('session_id') ?? '';
      if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return json({ error: 'bad session' }, 400);

      // One redemption per session.
      if (await env.ORDERS.get(`done:${id}`)) return json({ error: 'already redeemed' }, 409);

      const { ok, data } = await stripe(env, `checkout/sessions/${id}`);
      if (!ok) return json({ error: 'lookup failed' }, 502);
      if (data.payment_status !== 'paid') return json({ error: 'not paid' }, 402);

      const sku = data.metadata?.sku;
      if (!CATALOGUE[sku]) return json({ error: 'unknown item' }, 400);

      await env.ORDERS.put(`done:${id}`, JSON.stringify({ sku, at: Date.now() }), {
        expirationTtl: 60 * 60 * 24 * 365,
      });
      return json({ ok: true, sku, name: CATALOGUE[sku].name });
    }

    return json({ error: 'not found' }, 404);
  },
};
