// ════════════════════════════════════════════════════════════════
//  Algo Levels — Cloudflare Worker proxy
//  Holds the GEXbot API key (secret), solves CORS, whitelists paths,
//  caches responses so the browser can poll without burning quota.
//
//  Secrets (Workers → Settings → Variables and Secrets):
//    GEXBOT_API_KEY  = gexbot_custom_xxxxxxxx   (full key incl. prefix)
//    ACCESS_TOKEN    = any random string (the web app sends it as ?t=)
//    ANTHROPIC_API_KEY = sk-ant-...  (NY AM Macro Outlook, optional)
//    FRED_API_KEY    = FRED key (Bias tab: WALCL, WRESBAL, HY OAS; optional)
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
const YF_INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '1h', '1d']);
const YF_RANGES = new Set(['1d', '2d', '5d', '1mo', '3mo', '6mo', '60d', '1y', '2y', '730d', '5y', '10y']);

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
  // compact 0DTE strike history (±3 % around spot) for the GEX heatmap
  const hs = (z.strikes || []).filter(x => Math.abs(x[0] - z.spot) <= z.spot * 0.03).map(x => [x[0], Math.round(x[1])]);
  const doc = { t: Math.round(z.timestamp), spot: z.spot, regime: Math.sign(net || 0), levels: buildLevels(z, f, q), hs };
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


// ════════════════════════════════════════════════════════════════
//  NY AM Macro Outlook — Claude (with live web search) writes the session
//  thesis for NQ from news + our own data; stored per day, graded at noon.
// ════════════════════════════════════════════════════════════════
const OUTLOOK_MODEL = 'claude-sonnet-5-5';
const OUTLOOK_SLOTS = [{ id: 'pre', from: 540, to: 554 }, { id: 'upd', from: 615, to: 629 }]; // 9:00 and 10:15 ET

async function lastDaily(sym) {
  const b = (await yfBars(sym, '1d', '5d')).filter(x => x.t % 1 === 0);
  if (b.length < 2) return null;
  const a = b[b.length - 1], p = b[b.length - 2];
  return { last: a.c, prev: p.c, chg: a.c - p.c, pct: (a.c / p.c - 1) * 100 };
}

async function gatherContext(env) {
  const now = Date.now() / 1000, et = etParts(now);
  const ctx = { asof_et: `${et.date} ${String(Math.floor(et.min / 60)).padStart(2, '0')}:${String(et.min % 60).padStart(2, '0')} ET` };
  const safe = (p, k) => p.then(v => { ctx[k] = v; }).catch(e => { ctx[k] = { error: String(e.message || e) }; });
  await Promise.all([
    safe((async () => {
      const bars = (await yfBars('NQ=F', '1m', '2d')).filter(b => b.t % 60 === 0);
      const today = bars.filter(b => etParts(b.t).date === et.date);
      const prevRth = bars.filter(b => { const e = etParts(b.t); return e.date < et.date && e.min >= 570 && e.min < 960; });
      const on = today.filter(b => etParts(b.t).min < 570);
      return {
        last_nq_yahoo_delayed_10min: bars.length ? bars[bars.length - 1].c : null,
        prev_rth_close: prevRth.length ? prevRth[prevRth.length - 1].c : null,
        prev_rth_high: prevRth.length ? Math.max(...prevRth.map(b => b.h)) : null,
        prev_rth_low: prevRth.length ? Math.min(...prevRth.map(b => b.l)) : null,
        overnight_high: on.length ? Math.max(...on.map(b => b.h)) : null,
        overnight_low: on.length ? Math.min(...on.map(b => b.l)) : null,
      };
    })(), 'nq'),
    safe((async () => {
      const o = {};
      for (const [k, sym] of [['ES', 'ES=F'], ['VIX', '^VIX'], ['VXN', '^VXN'], ['US10Y_yield', '^TNX'], ['DXY', 'DX-Y.NYB'], ['WTI', 'CL=F']]) o[k] = await lastDaily(sym).catch(() => null);
      return o;
    })(), 'cross_asset_daily'),
    safe((async () => {
      const [z, q] = await Promise.all([gx(env, 'NQ_NDX/classic/gex_zero'), gx(env, 'QQQ/classic/gex_zero').catch(() => null)]);
      const net = Number.isFinite(z.sum_gex_vol) ? z.sum_gex_vol : z.net_gex_vol;
      const lv = buildLevels(z, null, q);
      return { gexbot_spot_nq: z.spot, data_age_min: Math.round((now - z.timestamp) / 60), zero_gamma: z.zero_gamma,
        regime: net > 0 ? 'positive gamma (mean reversion)' : net < 0 ? 'negative gamma (trend / expansion)' : 'flat',
        biggest_call_wall_0dte: (lv.find(l => l.kind === '★CW') || {}).p || null, biggest_put_wall_0dte: (lv.find(l => l.kind === '★PW') || {}).p || null,
        note: 'GEX is computed only during RTH; before 09:30 ET it reflects the previous session.' };
    })(), 'gex_0dte'),
    safe((async () => {
      const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error('calendar ' + r.status);
      return (await r.json()).filter(e => e.country === 'USD' && ['High', 'Medium'].includes(e.impact) && String(e.date).slice(0, 10) === et.date)
        .map(e => ({ time: e.date, title: e.title, impact: e.impact, forecast: e.forecast, previous: e.previous }));
    })(), 'us_calendar_today'),
  ]);
  return ctx;
}

const OUTLOOK_SYSTEM = `You are a sell-side macro strategist writing a short pre-market / morning outlook for an intraday NQ (Nasdaq-100 E-mini) futures trader.
Horizon: from now until 12:00 ET today (the NY AM session). The trader fades GEX levels (call/put walls, zero gamma) and uses this outlook only as directional context.
Rules:
- Use web search to find what actually moved or will move Nasdaq this morning: overnight/pre-market news, earnings of index heavyweights and AI/semis supply chain, US data releases and their actual vs forecast, Fed speakers, yields, dollar, oil, geopolitics. Prefer reputable sources (Reuters, Bloomberg, CNBC, WSJ, FT, MarketWatch, Investing.com, company IR). Only use information published before the cutoff time.
- Combine it with the provided market data (cross-asset changes, overnight range, GEX regime and walls, calendar).
- Be calibrated. Default conviction is LOW. Use MEDIUM only when several independent drivers clearly align; HIGH only for an obvious dominant catalyst. If drivers conflict, say neutral.
- Never invent numbers. If something is unknown, say so.
Write your analysis as plain notes: the side (bullish/bearish/neutral), conviction, the overall idea, bullish drivers, bearish drivers, key timed events today (ET), what changed vs the previous outlook (if given), what would invalidate the view, and how it relates to the GEX levels / overnight range.`;

// JSON schema for structured outputs (no maxItems / string limits — not supported there)
const OUTLOOK_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    side: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
    conviction: { type: 'string', enum: ['low', 'medium', 'high'] },
    idea: { type: 'string', description: '2-3 sentences, the overall thesis until 12:00 ET' },
    drivers_bull: { type: 'array', items: { type: 'string' } },
    drivers_bear: { type: 'array', items: { type: 'string' } },
    key_events: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { time_et: { type: 'string' }, event: { type: 'string' }, why: { type: 'string' } }, required: ['time_et', 'event', 'why'] } },
    what_changed: { type: 'string' },
    invalidation: { type: 'string' },
    levels_note: { type: 'string' },
  },
  required: ['side', 'conviction', 'idea', 'drivers_bull', 'drivers_bear', 'key_events', 'what_changed', 'invalidation', 'levels_note'],
};

async function anthropic(env, body) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: OUTLOOK_MODEL, ...body }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('anthropic ' + r.status + ': ' + ((j.error && j.error.message) || ''));
  return j;
}

// step 1: research with live web search (free text + citations); step 2: forced tool call → always valid structured output
async function callClaude(env, userText) {
  const messages = [{ role: 'user', content: userText }];
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6, user_location: { type: 'approximate', city: 'New York', region: 'New York', country: 'US', timezone: 'America/New_York' } }];
  let resp, searches = 0;
  for (let turn = 0; turn < 4; turn++) {
    resp = await anthropic(env, { max_tokens: 3000, system: OUTLOOK_SYSTEM, messages, tools });
    searches += (resp.content || []).filter(b => b.type === 'server_tool_use').length;
    if (resp.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: resp.content }); // continue the paused search turn unchanged
  }
  const sources = [], seen = new Set();
  for (const b of resp.content || []) {
    for (const c of b.citations || []) if (c.url && !seen.has(c.url)) { seen.add(c.url); sources.push({ title: c.title || c.url, url: c.url }); }
  }
  const notes = (resp.content || []).filter(b => b.type === 'text').map(t => t.text).join('');
  if (!notes.trim()) throw new Error('model returned no analysis');
  const s2 = await anthropic(env, {
    max_tokens: 2500, output_config: { format: { type: 'json_schema', schema: OUTLOOK_SCHEMA } },
    messages: [{ role: 'user', content: `Convert these analyst notes into the NY AM outlook card for NQ. All text in Czech (trading terms may stay English), concise and concrete: idea = 2-3 sentences; max 6 drivers per side; max 6 key events (time_et as HH:MM ET); what_changed = vs. previous outlook or empty string; levels_note = 1 sentence linking the thesis to GEX levels / overnight range. Keep the analyst's side and conviction. Do not add facts that are not in the notes.\n\n${notes}` }],
  });
  const txt = (s2.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  let tu;
  try { tu = { input: JSON.parse(txt) }; } catch (e) { throw new Error('structured output parse: ' + e.message); }
  return { out: tu.input, sources: sources.slice(0, 12), searches, usage: resp.usage || null };
}

async function makeOutlook(env, slot) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY secret missing');
  const now = Date.now() / 1000, et = etParts(now);
  const key = `ol:${et.date}`;
  const day = (await env.SNAP.get(key, 'json')) || { date: et.date, items: [] };
  const prev = day.items[day.items.length - 1] || null;
  const ctx = await gatherContext(env);
  const prompt = `Cutoff: ${ctx.asof_et} (${new Date(now * 1000).toISOString()}).\nMarket data (JSON):\n${JSON.stringify(ctx)}\n\n`
    + (prev ? `Previous outlook published today at ${prev.cutoff_et}:\n${JSON.stringify({ side: prev.side, conviction: prev.conviction, idea: prev.idea })}\n\n` : 'No previous outlook today.\n\n')
    + 'Write the NY AM outlook for NQ now.';
  const r = await callClaude(env, prompt);
  const o = r.out, side = ['bullish', 'bearish', 'neutral'].includes(o.side) ? o.side : 'neutral';
  const item = {
    t: Math.round(now), slot, cutoff_et: ctx.asof_et, side, conviction: ['low', 'medium', 'high'].includes(o.conviction) ? o.conviction : 'low',
    idea: String(o.idea || ''), drivers_bull: (o.drivers_bull || []).slice(0, 6), drivers_bear: (o.drivers_bear || []).slice(0, 6),
    key_events: (o.key_events || []).slice(0, 6), what_changed: String(o.what_changed || ''), invalidation: String(o.invalidation || ''),
    levels_note: String(o.levels_note || ''), sources: r.sources, searches: r.searches, ctx: { nq: ctx.nq, gex: ctx.gex_0dte, x: ctx.cross_asset_daily },
  };
  day.items.push(item);
  await env.SNAP.put(key, JSON.stringify(day), { expirationTtl: 60 * 60 * 24 * 400 });
  return item;
}

// grade every outlook of the day: NQ move from publish time to 12:00 ET
async function gradeOutlooks(env, date) {
  const key = `ol:${date}`, day = await env.SNAP.get(key, 'json');
  if (!day || !day.items.length) return { date, graded: 0 };
  const bars = (await yfBars('NQ=F', '1m', '5d')).filter(b => b.t % 60 === 0 && etParts(b.t).date === date);
  const at = t => { const b = bars.find(x => x.t >= t); return b ? b.o : null; };
  const noonBar = bars.filter(b => etParts(b.t).min < 720).pop();
  if (!noonBar || etParts(noonBar.t).min < 715) return { date, graded: 0, error: 'noon not reached' };
  let n = 0;
  for (const it of day.items) {
    const t0 = Math.max(it.t, bars.find(b => etParts(b.t).min >= 570) ? bars.find(b => etParts(b.t).min >= 570).t : it.t); // from publish or RTH open
    const p0 = at(t0), p1 = noonBar.c;
    if (p0 == null) continue;
    const move = Math.round((p1 - p0) * 4) / 4, flat = Math.abs(move) < p0 * 0.0015; // < 0.15 % = flat
    const hit = it.side === 'neutral' ? flat : flat ? null : (it.side === 'bullish') === (move > 0);
    it.grade = { from: p0, to: p1, move, hit }; n++;
  }
  await env.SNAP.put(key, JSON.stringify(day), { expirationTtl: 60 * 60 * 24 * 400 });
  return { date, graded: n };
}

async function outlookRecord(env, days) {
  const list = await env.SNAP.list({ prefix: 'ol:' });
  const keys = list.keys.map(k => k.name).sort().slice(-(days || 60));
  const out = [];
  for (const k of keys) { const d = await env.SNAP.get(k, 'json'); if (d) for (const it of d.items) out.push({ date: d.date, slot: it.slot, side: it.side, conviction: it.conviction, grade: it.grade || null }); }
  return out;
}

export default {
  async scheduled(event, env, ctx) {
    if (!env.SNAP || !env.GEXBOT_API_KEY) return;
    if (String(event.cron).startsWith('*/15')) {
      ctx.waitUntil(captureLevels(env).catch(() => {}));
      // NY AM outlook at 9:00 and 10:15 ET (weekdays), graded after noon
      const et = etParts(Date.now() / 1000);
      const slot = OUTLOOK_SLOTS.find(s => et.min >= s.from && et.min <= s.to);
      if (slot && env.ANTHROPIC_API_KEY) ctx.waitUntil((async () => {
        const day = await env.SNAP.get(`ol:${et.date}`, 'json');
        if (!day || !day.items.some(i => i.slot === slot.id)) await makeOutlook(env, slot.id);
      })().catch(() => {}));
      if (et.min >= 720 && et.min < 765) ctx.waitUntil(gradeOutlooks(env, et.date).catch(() => {})); // Yahoo is ~10 min late
    } else {
      ctx.waitUntil((async () => {
        await takeSnapshots(env).catch(() => {});
        await evaluateDay(env, etParts(Date.now() / 1000).date).catch(() => {});
        await gradeOutlooks(env, etParts(Date.now() / 1000).date).catch(() => {});
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
      return json({ ok: true, key: !!env.GEXBOT_API_KEY, token: !!env.ACCESS_TOKEN, kv: !!env.SNAP, ai: !!env.ANTHROPIC_API_KEY, fred: !!env.FRED_API_KEY }, 200, cors);
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
      // ── GEX heatmap history: 0DTE strikes from the 15-min captures
      if (parts[0] === 'heat') {
        if (!env.SNAP) return json({ error: 'KV binding SNAP missing' }, 500, cors);
        const d = url.searchParams.get('date') || etParts(Date.now() / 1000).date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return json({ error: 'bad date' }, 400, cors);
        const list = await env.SNAP.list({ prefix: `lv:${d}:` });
        const rows = [];
        for (const k of list.keys) { const x = await env.SNAP.get(k.name, 'json'); if (x && x.hs) rows.push({ t: x.t, spot: x.spot, hs: x.hs }); }
        return json({ date: d, rows: rows.sort((a, b) => a.t - b.t) }, 200, cors);
      }
      // ── NY AM outlook: /outlook (today + track record), /outlook/new (generate now, max 1 per 20 min)
      if (parts[0] === 'outlook') {
        if (!env.SNAP) return json({ error: 'KV binding SNAP missing' }, 500, cors);
        const d = url.searchParams.get('date') || etParts(Date.now() / 1000).date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return json({ error: 'bad date' }, 400, cors);
        if (parts[1] === 'new') {
          const day = await env.SNAP.get(`ol:${d}`, 'json');
          const last = day && day.items[day.items.length - 1];
          if (last && Date.now() / 1000 - last.t < 1200) return json({ error: 'poslední outlook je mladší než 20 min', item: last }, 429, cors);
          return json(await makeOutlook(env, 'manual'), 200, cors);
        }
        if (parts[1] === 'grade') return json(await gradeOutlooks(env, d), 200, cors);
        return json({ ai: !!env.ANTHROPIC_API_KEY, day: await env.SNAP.get(`ol:${d}`, 'json'), record: await outlookRecord(env, 60) }, 200, cors);
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

