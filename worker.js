// ════════════════════════════════════════════════════════════════
//  Algo Levels — Cloudflare Worker proxy
//  Holds the GEXbot API key (secret), solves CORS, whitelists paths,
//  caches responses so the browser can poll without burning quota.
//
//  Secrets (Workers → Settings → Variables and Secrets):
//    GEXBOT_API_KEY  = gexbot_custom_xxxxxxxx   (full key incl. prefix)
//    ACCESS_TOKEN    = any random string (the web app sends it as ?t=)
//
//  Routes:
//    /health
//    /gex/{ticker}/{classic|state}/{category}[/majors|/maxchange]
//    /yf/{symbol}?interval=1m&range=5d     (Yahoo chart data)
// ════════════════════════════════════════════════════════════════

const ALLOWED_ORIGINS = [
  'https://bartikozz.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'null', // opening index.html as a local file
];

const GEX_TICKERS = new Set(['NQ_NDX', 'NDX', 'QQQ', 'ES_SPX', 'SPX', 'SPY']);
const GEX_PACKAGES = new Set(['classic', 'state']);
const GEX_CATS = new Set([
  'gex_full', 'gex_zero', 'gex_one',
  'gamma_zero', 'delta_zero', 'vanna_zero', 'charm_zero',
  'gamma_one', 'delta_one',
]);
const GEX_SUBS = new Set(['majors', 'maxchange']);

const YF_SYMBOLS = new Set(['NQ=F', 'ES=F', '^VIX', '^VXN', 'QQQ', 'SPY']);
const YF_INTERVALS = new Set(['1m', '2m', '5m', '15m', '1d']);
const YF_RANGES = new Set(['1d', '2d', '5d', '1mo', '3mo', '6mo', '1y']);

// per-isolate memory cache
const MEM = new Map();

// what gets stored after each close (needs a KV binding named SNAP + a cron trigger)
const SNAP_SET = [
  ['NQ_NDX', 'gex_zero'],
  ['NQ_NDX', 'gex_one'],
  ['NQ_NDX', 'gex_full'],
  ['QQQ', 'gex_full'],
];

function etDate(sec) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(sec * 1000));
}

async function takeSnapshots(env) {
  const out = {};
  for (const [t, c] of SNAP_SET) {
    try {
      const r = await fetch(`https://api.gex.bot/v2/${t}/classic/${c}`, {
        headers: { Authorization: `Bearer ${env.GEXBOT_API_KEY}`, 'User-Agent': 'algo-levels/1.0', Accept: 'application/json' },
      });
      if (!r.ok) { out[`${t}:${c}`] = `HTTP ${r.status}`; continue; }
      const j = await r.json();
      if (!Number.isFinite(j.timestamp)) { out[`${t}:${c}`] = 'no timestamp'; continue; }
      // keep only what the terminal needs (smaller than the full response)
      const slim = {
        timestamp: j.timestamp, ticker: j.ticker, spot: j.spot, zero_gamma: j.zero_gamma,
        major_pos_oi: j.major_pos_oi, major_neg_oi: j.major_neg_oi,
        sum_gex_vol: j.sum_gex_vol, sum_gex_oi: j.sum_gex_oi,
        strikes: (j.strikes || []).map(s => [s[0], s[1], s[2]]),
      };
      const d = etDate(j.timestamp);
      await env.SNAP.put(`snap:${t}:${c}:${d}`, JSON.stringify(slim), { expirationTtl: 60 * 60 * 24 * 45 });
      out[`${t}:${c}`] = d;
    } catch (e) {
      out[`${t}:${c}`] = String(e && e.message || e);
    }
  }
  return out;
}

export default {
  async scheduled(event, env, ctx) {
    if (env.SNAP && env.GEXBOT_API_KEY) ctx.waitUntil(takeSnapshots(env));
  },

  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (parts[0] === 'health') {
      return json({ ok: true, key: !!env.GEXBOT_API_KEY, token: !!env.ACCESS_TOKEN, kv: !!env.SNAP }, 200, cors);
    }

    if (env.ACCESS_TOKEN && url.searchParams.get('t') !== env.ACCESS_TOKEN) {
      return json({ error: 'unauthorized' }, 401, cors);
    }

    try {
      // ── daily snapshots (KV): /snap = take one now, /prev/{ticker}/{cat}?before=YYYY-MM-DD
      if (parts[0] === 'snap') {
        if (!env.SNAP) return json({ error: 'KV binding SNAP missing' }, 500, cors);
        return json(await takeSnapshots(env), 200, cors);
      }
      if (parts[0] === 'prev') {
        if (!env.SNAP) return json({ error: 'KV binding SNAP missing' }, 500, cors);
        const [, ticker, cat] = parts;
        if (!SNAP_SET.some(([t, c]) => t === ticker && c === cat)) return json({ error: 'route not allowed' }, 400, cors);
        const before = url.searchParams.get('before') || etDate(Date.now() / 1000);
        const prefix = `snap:${ticker}:${cat}:`;
        const list = await env.SNAP.list({ prefix });
        const dates = list.keys.map(k => k.name.slice(prefix.length)).filter(d => d < before).sort();
        if (!dates.length) return json({ error: 'no snapshot yet', before }, 404, cors);
        const date = dates[dates.length - 1];
        const data = await env.SNAP.get(prefix + date, 'json');
        return json({ date, data }, 200, cors);
      }

      // ── GEXbot
      if (parts[0] === 'gex') {
        const [, ticker, pkg, cat, sub] = parts;
        if (!GEX_TICKERS.has(ticker) || !GEX_PACKAGES.has(pkg) || !GEX_CATS.has(cat) || (sub && !GEX_SUBS.has(sub))) {
          return json({ error: 'route not allowed' }, 400, cors);
        }
        if (!env.GEXBOT_API_KEY) return json({ error: 'GEXBOT_API_KEY secret missing' }, 500, cors);
        const target = `https://api.gex.bot/v2/${ticker}/${pkg}/${cat}${sub ? '/' + sub : ''}`;
        return proxy([target], {
          Authorization: `Bearer ${env.GEXBOT_API_KEY}`,
          'User-Agent': 'algo-levels/1.0',
          Accept: 'application/json',
        }, cors, sub === 'majors' ? 4 : 20); // majors = small payload, used as live price tick
      }

      // ── Yahoo chart
      if (parts[0] === 'yf') {
        const sym = parts[1] || '';
        const interval = url.searchParams.get('interval') || '1m';
        const range = url.searchParams.get('range') || '5d';
        if (!YF_SYMBOLS.has(sym) || !YF_INTERVALS.has(interval) || !YF_RANGES.has(range)) {
          return json({ error: 'route not allowed' }, 400, cors);
        }
        const q = `/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}&includePrePost=true`;
        return proxy(
          [`https://query1.finance.yahoo.com${q}`, `https://query2.finance.yahoo.com${q}`],
          { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' },
          cors,
          interval === '1d' ? 300 : 15,
        );
      }

      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502, cors);
    }
  },
};

async function proxy(targets, headers, cors, ttlSec) {
  const key = targets[0];
  const now = Date.now();
  const hit = MEM.get(key);
  if (hit && now - hit.at < ttlSec * 1000) return out(hit.body, hit.status, cors, 'HIT');

  let last = null;
  for (const t of targets) {
    const up = await fetch(t, { headers });
    const body = await up.text();
    last = { body, status: up.status };
    if (up.ok) {
      MEM.set(key, { body, status: up.status, at: now });
      if (MEM.size > 200) MEM.delete(MEM.keys().next().value);
      return out(body, up.status, cors, 'MISS');
    }
  }
  // upstream failed: serve stale copy if we have one
  if (hit) return out(hit.body, hit.status, cors, 'STALE');
  return out(last.body, last.status, cors, 'MISS');
}

function out(body, status, cors, cache) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Cache': cache, ...cors },
  });
}

function json(o, status, cors) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
