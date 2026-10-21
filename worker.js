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
const YF_RANGES = new Set(['1d', '2d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y']);

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


// ════════════════════════════════════════════════════════════════
//  Level journal: capture levels every 15 min during RTH, evaluate after close
//  KV keys:  lv:YYYY-MM-DD:HHMM  (captured levels)   ev:YYYY-MM-DD  (evaluated events)
// ════════════════════════════════════════════════════════════════
const EV = { touch: 3, brk: 6, react: 15, look: 15 };   // same thresholds as the terminal

function etParts(sec) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const o = {};
  for (const x of f.formatToParts(new Date(sec * 1000))) o[x.type] = x.value;
  return { date: `${o.year}-${o.month}-${o.day}`, min: (+o.hour % 24) * 60 + +o.minute };
}

async function gx(env, path) {
  const r = await fetch(`https://api.gex.bot/v2/${path}`, {
    headers: { Authorization: `Bearer ${env.GEXBOT_API_KEY}`, 'User-Agent': 'algo-levels/1.0', Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return r.json();
}

function topWalls(strikes, n, filter) {
  const s = (strikes || []).filter(x => Number.isFinite(x[0]) && Number.isFinite(x[1])).filter(filter || (() => true));
  return {
    pos: s.filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, n),   // idx 1 = GEX by volume
    neg: s.filter(x => x[1] < 0).sort((a, b) => a[1] - b[1]).slice(0, n),
  };
}

function buildLevels(z, f, q) {
  const L = [];
  const add = (p, kind, tag) => { if (Number.isFinite(p) && p > 0) L.push({ p: Math.round(p * 4) / 4, kind, tag: tag || kind }); };
  const w0 = topWalls(z.strikes, 3);
  w0.pos.forEach((x, i) => add(x[0], `0DTE CW${i + 1}`));
  w0.neg.forEach((x, i) => add(x[0], `0DTE PW${i + 1}`));
  add(z.zero_gamma, '0DTE ZG');
  if (f) {
    const wf = topWalls(f.strikes, 1);
    wf.pos.forEach(x => add(x[0], 'CW1'));
    wf.neg.forEach(x => add(x[0], 'PW1'));
    add(f.zero_gamma, 'ZG');
  }
  if (q && q.spot > 0 && z.spot > 0) {
    const k = z.spot / q.spot;
    if (k > 20 && k < 80) {
      const wq = topWalls(q.strikes, 1, x => Math.round(x[0] * 100) % 500 === 0);
      const star = {};
      if (wq.pos[0]) { star[wq.pos[0][0]] = 1; add(wq.pos[0][0] * k, '★CW', `QQQ ${wq.pos[0][0]}`); }
      if (wq.neg[0]) { star[wq.neg[0][0]] = 1; add(wq.neg[0][0] * k, '★PW', `QQQ ${wq.neg[0][0]}`); }
      for (let s = Math.ceil(q.spot * 0.99 / 5) * 5; s <= q.spot * 1.01; s += 5) if (!star[s]) add(s * k, 'QQQ 0/5', `QQQ ${s}`);
    }
  }
  return L;
}

async function captureLevels(env, force) {
  const now = Date.now() / 1000, et = etParts(now);
  if (!force && (et.min < 570 || et.min > 960)) return { skip: 'outside RTH' };
  const [z, f, q] = await Promise.all([
    gx(env, 'NQ_NDX/classic/gex_zero'),
    gx(env, 'NQ_NDX/classic/gex_full').catch(() => null),
    gx(env, 'QQQ/classic/gex_zero').catch(() => null),
  ]);
  if (!force && now - z.timestamp > 600) return { skip: 'gex stale' };
  const net = Number.isFinite(z.sum_gex_vol) ? z.sum_gex_vol : z.net_gex_vol;
  const doc = { t: Math.round(z.timestamp), spot: z.spot, regime: Math.sign(net || 0), levels: buildLevels(z, f, q) };
  const hhmm = String(Math.floor(et.min / 60)).padStart(2, '0') + String(et.min % 60).padStart(2, '0');
  const key = `lv:${et.date}:${hhmm}`;
  await env.SNAP.put(key, JSON.stringify(doc), { expirationTtl: 60 * 60 * 24 * 180 });
  return { saved: key, levels: doc.levels.length };
}

async function yfBars(sym, interval, range) {
  const q = `/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}&includePrePost=true`;
  for (const h of ['query1', 'query2']) {
    const r = await fetch(`https://${h}.finance.yahoo.com${q}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' } });
    if (!r.ok) continue;
    const res = (await r.json()).chart.result[0], qq = res.indicators.quote[0], out = [];
    res.timestamp.forEach((t, i) => {
      if ([qq.open[i], qq.high[i], qq.low[i], qq.close[i]].some(v => v == null)) return;
      out.push({ t, o: qq.open[i], h: qq.high[i], l: qq.low[i], c: qq.close[i] });
    });
    return out;
  }
  throw new Error(`yahoo ${sym}`);
}

// first touch of level p inside bars[i0..i1) and what happened next (fade logic)
function evalLevel(bars, i0, i1, p) {
  for (let i = i0; i < i1; i++) {
    const b = bars[i];
    if (b.h < p - EV.touch || b.l > p + EV.touch) continue;
    const prev = i > 0 ? bars[i - 1].c : b.o;
    const side = prev < p ? 'short' : 'long';           // came from below → fade short, from above → fade long
    let res = 'chop', mfe = 0, mae = 0, bars_ = 0;
    for (let j = i; j < Math.min(bars.length, i + EV.look); j++) {
      const x = bars[j];
      const fav = side === 'short' ? p - x.l : x.h - p;
      const adv = side === 'short' ? x.h - p : p - x.l;
      mfe = Math.max(mfe, fav); mae = Math.max(mae, adv); bars_ = j - i + 1;
      if (side === 'short' ? x.c > p + EV.brk : x.c < p - EV.brk) { res = 'broken'; break; }
      if (fav >= EV.react) { res = 'reacted'; break; }
    }
    return { t: b.t, side, res, mfe: Math.round(mfe * 4) / 4, mae: Math.round(mae * 4) / 4, bars: bars_ };
  }
  return null;
}

async function evaluateDay(env, date) {
  const list = await env.SNAP.list({ prefix: `lv:${date}:` });
  const snaps = [];
  for (const k of list.keys) { const d = await env.SNAP.get(k.name, 'json'); if (d) snaps.push(d); }
  snaps.sort((a, b) => a.t - b.t);
  const all = await yfBars('NQ=F', '1m', '5d');
  const bars = all.filter(b => b.t % 60 === 0).filter(b => { const e = etParts(b.t); return e.date === date && e.min >= 570 && e.min < 960; });
  if (!bars.length) return { date, error: 'no RTH bars' };
  const idxAt = t => { const i = bars.findIndex(b => b.t >= t); return i < 0 ? bars.length : i; };
  const events = [], seen = [];
  const dup = (kind, p) => seen.some(s => s.kind === kind && Math.abs(s.p - p) <= EV.touch);
  snaps.forEach((s, si) => {
    const i0 = idxAt(s.t), i1 = si + 1 < snaps.length ? idxAt(snaps[si + 1].t) : bars.length;
    for (const l of s.levels) {
      if (dup(l.kind, l.p)) continue;
      const e = evalLevel(bars, i0, i1, l.p);
      if (e) { seen.push(l); events.push({ kind: l.kind, tag: l.tag, p: l.p, regime: s.regime, ...e }); }
    }
  });
  // EM levels (VXN × 0.8, RTH open) are valid the whole session
  try {
    const vx = (await yfBars('^VXN', '1d', '1mo')).filter(b => etParts(b.t).date < date).pop();
    const ref = bars[0].o, em = ref * vx.c / 100 / Math.sqrt(252) * 0.8;
    const regime = snaps.length ? snaps[0].regime : 0;
    for (const [m, kind] of [[0, 'EM Ref'], [0.5, 'EM ±½'], [-0.5, 'EM ±½'], [1, 'EM ±1'], [-1, 'EM ±1'], [1.5, 'EM ±1.5'], [-1.5, 'EM ±1.5']]) {
      const p = Math.round((ref + m * em) * 4) / 4;
      const e = evalLevel(bars, m === 0 ? Math.max(1, bars.findIndex(b => Math.abs(b.c - ref) > EV.react)) : 0, bars.length, p);
      if (e) events.push({ kind, tag: kind, p, regime, ...e });
    }
  } catch (e) { /* EM optional */ }
  events.sort((a, b) => a.t - b.t);
  const doc = { date, snaps: snaps.length, bars: bars.length, events };
  await env.SNAP.put(`ev:${date}`, JSON.stringify(doc), { expirationTtl: 60 * 60 * 24 * 400 });
  return { date, snaps: snaps.length, events: events.length };
}

async function statsAll(env, days) {
  const list = await env.SNAP.list({ prefix: 'ev:' });
  const keys = list.keys.map(k => k.name).sort().slice(-(days || 120));
  const docs = [];
  for (const k of keys) { const d = await env.SNAP.get(k, 'json'); if (d) docs.push(d); }
  return { days: docs.map(d => ({ date: d.date, snaps: d.snaps, events: d.events })) };
}

export default {
  async scheduled(event, env, ctx) {
    if (!env.SNAP || !env.GEXBOT_API_KEY) return;
    if (String(event.cron).startsWith('*/15')) {
      ctx.waitUntil(captureLevels(env).catch(() => {}));
    } else {
      ctx.waitUntil((async () => {
        await takeSnapshots(env).catch(() => {});
        await evaluateDay(env, etParts(Date.now() / 1000).date).catch(() => {});
      })());
    }
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
      // ── level journal
      if (['capture', 'evaluate', 'journal', 'stats'].includes(parts[0]) && !env.SNAP) return json({ error: 'KV binding SNAP missing' }, 500, cors);
      if (parts[0] === 'capture') return json(await captureLevels(env, true), 200, cors);
      if (parts[0] === 'evaluate') {
        const d = url.searchParams.get('date') || etParts(Date.now() / 1000).date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return json({ error: 'bad date' }, 400, cors);
        return json(await evaluateDay(env, d), 200, cors);
      }
      if (parts[0] === 'journal') {
        const d = url.searchParams.get('date') || etParts(Date.now() / 1000).date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return json({ error: 'bad date' }, 400, cors);
        const list = await env.SNAP.list({ prefix: `lv:${d}:` });
        return json({ date: d, captures: list.keys.map(k => k.name.slice(-4)), evaluated: await env.SNAP.get(`ev:${d}`, 'json') }, 200, cors);
      }
      if (parts[0] === 'stats') return json(await statsAll(env, +url.searchParams.get('days') || 120), 200, cors);
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
        }, cors, sub === 'majors' ? 1 : 20); // majors = live price tick; GEXbot recomputes once per second
      }

      // ── FRED (no key: public graph CSV) — Fed liquidity series for the Bias tab
      if (parts[0] === 'fred') { const id = parts[1] || ''; if (!['WALCL', 'WTREGEN', 'RRPONTSYD', 'WRESBAL', 'BAMLH0A0HYM2'].includes(id)) return json({ error: 'route not allowed' }, 400, cors); return proxy([...(env.FRED_API_KEY ? [`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${env.FRED_API_KEY}&file_type=json`] : []), `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`], { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: '*/*' }, cors, 3600); }
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

  // after an upstream 429 serve the cached copy for 30 s instead of hammering the API
  if (hit && hit.coolUntil && now < hit.coolUntil) return out(hit.body, hit.status, cors, 'STALE');
  let last = null;
  for (const t of targets) {
    const up = await fetch(t, { headers });
    if (up.status === 429 && hit) { hit.coolUntil = now + 30000; return out(hit.body, hit.status, cors, 'STALE'); }
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

