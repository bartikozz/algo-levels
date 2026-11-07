"""Algo Levels data server (runs on the VPS).

  futures tape  : Databento live NQ trades → bars / footprint / CVD / profile / TPO
  options engine: ThetaData QQQ chain every POLL_SEC → exposures by strike × expiry, smile, IV peaks, landscape
  API           : REST + websocket for the web terminal (token = ACCESS_TOKEN, passed as ?t=)

Run:  uvicorn app:app --host 127.0.0.1 --port 8090      (exposed via Cloudflare Tunnel)
DEMO=1 runs with synthetic trades + a synthetic chain (no subscriptions needed).
"""
from __future__ import annotations
import asyncio, json, math, os, random, threading, time
from datetime import datetime
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from exposure import snapshot, heatmap, smile
import volframe
from futures import Tape, DatabentoFeed
from optflow import OptionFlow

ET = ZoneInfo('America/New_York')
TOKEN = os.environ.get('ACCESS_TOKEN', '')
DEMO = os.environ.get('DEMO', '0') == '1'
ROOT = os.environ.get('OPTIONS_ROOT', 'QQQ')
POLL = float(os.environ.get('POLL_SEC', '30'))
DATA_DIR = os.environ.get('DATA_DIR', os.path.join(os.path.dirname(__file__), 'data'))
os.makedirs(DATA_DIR, exist_ok=True)

app = FastAPI(title='Algo Levels server')
app.add_middleware(CORSMiddleware, allow_origins=os.environ.get('CORS_ORIGINS', 'https://bartikozz.github.io').split(','),
                   allow_methods=['GET'], allow_headers=['*'])


@app.middleware('http')
async def token_check(request, call_next):
    """local requests (this PC) are always allowed; requests through the tunnel need ?t=ACCESS_TOKEN"""
    from fastapi.responses import JSONResponse
    path = request.url.path
    if request.method != 'OPTIONS' and path not in ('/health',) and not path.startswith('/setup') and TOKEN:
        if request.query_params.get('t') != TOKEN and not is_local(request.headers, request.client.host if request.client else ''):
            o = request.headers.get('origin')
            return JSONResponse({'detail': 'unauthorized'}, status_code=401,
                                headers={'Access-Control-Allow-Origin': o} if o in ORIGINS else {})
    return await call_next(request)


@app.middleware('http')
async def private_network(request, call_next):
    """Chrome 'Private/Local Network Access': the public terminal page may call this server on localhost"""
    resp = await call_next(request)
    resp.headers['Access-Control-Allow-Private-Network'] = 'true'
    return resp

tape = Tape(state_file=os.path.join(DATA_DIR, 'tape.json'))
oflow = OptionFlow(min_prem=float(os.environ.get('FLOW_MIN_PREM', '25000')), state_file=os.path.join(DATA_DIR, 'optflow.json'))
state = dict(chain=None, snap=None, k=None, opt_err=None, opt_ts=0, feed=None, hist=[], ostream=None, sent={})


def auth(t: str | None):
    pass   # token is checked in the middleware below (it needs the request to tell local from tunnel)


ORIGINS = os.environ.get('CORS_ORIGINS', 'https://bartikozz.github.io').split(',')
ENV_FILE = os.path.join(os.path.dirname(__file__), '.env')
TUNNEL_FILE = os.path.join(os.path.dirname(__file__), '..', 'tunnel.url')
WORKER = dict(url=os.environ.get('WORKER_URL', '').rstrip('/'), status='—', registered=None)


def is_local(headers, host) -> bool:
    """request made on this PC directly (not through the Cloudflare tunnel, which always adds cf-* headers)"""
    return host in ('127.0.0.1', '::1', 'localhost') and not any(h in headers for h in ('cf-connecting-ip', 'cf-ray', 'x-forwarded-for'))


def _write_env(key, value):
    lines = open(ENV_FILE).read().splitlines() if os.path.exists(ENV_FILE) else []
    out, done = [], False
    for l in lines:
        if l.split('=', 1)[0].strip() == key:
            out.append(f'{key}={value}'); done = True
        else:
            out.append(l)
    if not done: out.append(f'{key}={value}')
    with open(ENV_FILE, 'w') as f: f.write('\n'.join(out) + '\n')


def j(x):
    """numpy/float cleanup for JSON"""
    if isinstance(x, float):
        return None if math.isnan(x) or math.isinf(x) else round(x, 6)
    if isinstance(x, dict):
        return {str(k): j(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [j(v) for v in x]
    try:
        import numpy as np
        if isinstance(x, np.generic):
            return j(x.item())
    except Exception:
        pass
    return x


# ── options loop ────────────────────────────────────────────────────────────
def options_loop():
    from providers.thetadata import ThetaData, parity_spot
    td = None if DEMO else ThetaData(ROOT)
    while True:
        t0 = time.time()
        try:
            if DEMO:
                import sys; sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'tests'))
                from synth import synth_chain
                S = 725.0 + 2 * math.sin(time.time() / 600)
                chain = synth_chain(S, time.time())
            else:
                chain = td.chain()
                S = parity_spot(chain)
                if not S:
                    raise RuntimeError('no spot from put-call parity')
            nq = tape.last if tape.last_ts and time.time() - tape.last_ts < 120 else None
            k_new = nq / S if nq and S and 20 < nq / S < 80 else None
            if k_new is None and not DEMO:
                k_new = yahoo_ratio()   # no live futures feed → NQ/QQQ from Yahoo 1m bars (time-aligned)
            state['k'] = k_new if state['k'] is None or k_new is None else 0.8 * state['k'] + 0.2 * k_new
            snap = snapshot(chain, S, time.time(), k_nq=state['k'])
            state.update(chain=chain, snap=snap, opt_err=None, opt_ts=time.time(), spot=S)
            oflow.set_chain(chain, S)          # deltas / IV + fallback quotes for the flow engine
            # intraday surface history: 0DTE (or nearest) GEX by strike, every poll
            b = snap['buckets'].get('0D') or snap['buckets'].get('1D') or []
            row = dict(t=int(time.time()), spot=S, k=state['k'],
                       s=[[r['strike'], round(r['gex_oi']), round(r['gex_vol'])] for r in b if abs(r['strike'] / S - 1) < 0.03])
            day = datetime.now(ET).strftime('%Y-%m-%d')
            if state['hist'] and datetime.fromtimestamp(state['hist'][-1]['t'], ET).strftime('%Y-%m-%d') != day:
                state['hist'] = []
            state['hist'].append(row)
            with open(os.path.join(DATA_DIR, f'surface-{day}.jsonl'), 'a') as f:
                f.write(json.dumps(row) + '\n')
        except Exception as e:
            state['opt_err'] = f'{type(e).__name__}: {e}'
        time.sleep(max(1.0, POLL - (time.time() - t0)))


# ── sentiment roots (SPX, VIX) from ThetaData: gamma by strike in the same shape as GEXbot classic
SENT_ROOTS = {'SPX': ['SPX', 'SPXW'], 'VIX': ['VIX', 'VIXW']}
SENT_POLL = float(os.environ.get('SENT_POLL_SEC', '120'))


def _gex_view(chain, S, now, rows_full, rows_zero, land):
    as_strikes = lambda rows: [[r['strike'], round(r['gex_vol'], 2), round(r['gex_oi'], 2), []] for r in rows]
    return dict(timestamp=int(now), spot=S, zero_gamma=(land or {}).get('flip'),
                full=dict(timestamp=int(now), spot=S, zero_gamma=(land or {}).get('flip'), strikes=as_strikes(rows_full)),
                zero=dict(timestamp=int(now), spot=S, strikes=as_strikes(rows_zero)) if rows_zero else None)


def sentiment_loop():
    from providers.thetadata import ThetaData, parity_spot
    from exposure import enrich, aggregate, landscape, expiry_ts as _ets
    clients = {name: [ThetaData(r) for r in roots] for name, roots in SENT_ROOTS.items()}
    while True:
        for name, cls in clients.items():
            try:
                now = time.time()
                chain, errs = [], []
                for c in cls:
                    try: chain += c.chain()
                    except Exception as e: errs.append(f'{c.root}: {type(e).__name__}')
                if not chain:
                    raise RuntimeError('no chain (' + ', '.join(errs) + ')')
                chain = [c for c in chain if 0 < _ets(c.exp) - now <= 60 * 86400]
                S = parity_spot(chain)
                if not S: raise RuntimeError('no spot from parity')
                chain = [c for c in chain if abs(c.strike / S - 1) <= (0.35 if name == 'VIX' else 0.08)]
                enrich(chain, S, now)
                buckets, _ = aggregate(chain, S, now)
                zero = buckets.get('0D') or buckets.get('1D') or buckets.get('W') or []
                land = landscape(chain, S, now) if name != 'VIX' else None
                st_ = volframe.surface_stats(chain, S, now)
                rg = volframe.regime_stats(chain, S, now)
                v = dict(_gex_view(chain, S, now, buckets.get('ALL', []), zero, land), err=None, n=len(chain), stats=st_, regime=rg,
                         flow=_oi_delta(name, chain, S, 0.35 if name == 'VIX' else 0.06))
                if name == 'VIX':
                    v.update(_vix_fwd(S, now))
                state['sent'][name] = v
            except Exception as e:
                state['sent'][name] = dict(state['sent'].get(name) or {}, err=f'{type(e).__name__}: {e}')
        try:
            d = datetime.now(ET)
            if d.weekday() < 5 and 570 <= d.hour * 60 + d.minute <= 980:   # RTH + 20 min → today's record ends with the final volume
                _cboe_hist(_cboe_rec()[4])
        except Exception:
            pass
        time.sleep(SENT_POLL)


def _oi_delta(name, chain, S, band):
    """Day-over-day open-interest change by strike (new positioning since yesterday's OI print).
    Persisted per day in data/oi-<name>.json; returns [[strike, dCallOI, dPutOI, callOI, putOI]] near spot."""
    fn = os.path.join(DATA_DIR, f'oi-{name}.json')
    try:
        with open(fn) as f: H = json.load(f)
    except Exception:
        H = {}
    day = datetime.now(ET).strftime('%Y-%m-%d')
    cur = {}
    for c in chain:
        r = cur.setdefault(str(c.strike), [0.0, 0.0])
        r[0 if c.right == 'C' else 1] += c.oi or 0.0
    if sum(a + b for a, b in cur.values()) > 0 and datetime.now(ET).weekday() < 5:
        H[day] = cur
        H = dict(sorted(H.items())[-6:])
        try:
            with open(fn + '.tmp', 'w') as f: json.dump(H, f)
            os.replace(fn + '.tmp', fn)
        except Exception:
            pass
    prev = [d for d in H if d < day]
    if day not in H and prev:                      # weekend: compare the last two stored days
        cur, prev = H[prev[-1]], prev[:-1]
    if not prev:
        return None
    P = H[prev[-1]]
    # OI is published once a day; if today's print equals yesterday's (not updated yet) compare the two previous days
    if all(P.get(k) == v for k, v in cur.items()) and len(prev) > 1:
        cur, P = P, H[prev[-2]]
    out = []
    for k, (c, p) in cur.items():
        K = float(k)
        if abs(K / S - 1) > band: continue
        pc, pp = P.get(k, [0.0, 0.0])
        out.append([K, round(c - pc), round(p - pp), round(c), round(p)])
    return sorted(out)


def _vix_fwd(F, now):
    """VIX options price off the VIX future, so put-call parity gives the forward, not spot (backwardation → forward < spot).
    Keep the forward seen at the cash close (16:00–16:20 ET) so the terminal can scale the last ^VIX close:
    spot_est = vix_close × F_now / F_close."""
    fn = os.path.join(DATA_DIR, 'vix-fwd.json')
    try:
        with open(fn) as f: H = json.load(f)
    except Exception:
        H = {}
    d = datetime.fromtimestamp(now, ET); m = d.hour * 60 + d.minute
    if d.weekday() < 5 and 960 <= m <= 980:
        H[d.strftime('%Y-%m-%d')] = F
        H = dict(sorted(H.items())[-10:])
        try:
            with open(fn, 'w') as f: json.dump(H, f)
        except Exception:
            pass
    last = sorted(H.items())[-1] if H else None
    return dict(fwd=F, fwd_close=last[1] if last else None, fwd_close_date=last[0] if last else None)


def _cboe_hist(rec):
    fn = os.path.join(DATA_DIR, 'cboe-hist.json')
    try:
        with open(fn) as f: H = json.load(f)
    except Exception:
        H = {}
    day = datetime.now(ET).strftime('%Y-%m-%d')
    if datetime.now(ET).weekday() < 5:
        H[day] = rec
    H = dict(sorted(H.items())[-400:])
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(fn + '.tmp', 'w') as f: json.dump(H, f)
        os.replace(fn + '.tmp', fn)
    except Exception:
        pass
    prev = [v for d, v in H.items() if d < day]
    def pct(key):
        xs = [v.get(key) for v in prev if v.get(key) is not None]
        x = rec.get(key)
        if x is None or len(xs) < 5: return None
        return round(sum(1 for v in xs if v <= x) / len(xs), 3)
    def z(key):
        xs = [v.get(key) for v in prev if v.get(key) is not None]
        x = rec.get(key)
        if x is None or len(xs) < 10: return None
        m = sum(xs) / len(xs); sd = (sum((v - m) ** 2 for v in xs) / (len(xs) - 1)) ** 0.5
        return round((x - m) / sd, 2) if sd > 0 else None
    keys = [k for k in rec if rec[k] is not None]
    pdays = sorted(d for d in H if d < day)
    last = H[pdays[-1]] if pdays else None
    def pct_prev(key):
        if not last or last.get(key) is None: return None
        xs = [H[d].get(key) for d in pdays[:-1] if H[d].get(key) is not None]
        if len(xs) < 5: return None
        return round(sum(1 for v in xs if v <= last[key]) / len(xs), 3)
    return dict(n=len(prev), pct={k: pct(k) for k in keys}, z={k: z(k) for k in keys},
                prev=dict(last, date=pdays[-1]) if last else None,
                prev_pct={k: pct_prev(k) for k in (last or {})},
                prev_avg20={k: (sum(xs) / len(xs) if xs else None) for k in ('spx_pvol', 'spx_cvol')
                            for xs in [[H[d].get(k) for d in pdays[-21:-1] if H[d].get(k) is not None]]})


def _cboe_rec():
    s = state['snap']
    q = volframe.surface_stats(state['chain'], s['spot'], s['ts']) if s else None
    x = (state['sent'].get('SPX') or {}).get('stats')
    rec = dict(qqq_atm=q and q['atm30'], spx_atm=x and x['atm30'],
               spread=(q['atm30'] - x['atm30']) if (q and x and q['atm30'] and x['atm30']) else None,
               qqq_skew=q and q['skew'], spx_skew=x and x['skew'], qqq_conv=q and q['convexity'], spx_conv=x and x['convexity'])
    rg = (state['sent'].get('SPX') or {}).get('regime')
    qr = _qqq_regime()
    if rg:
        rec.update(spx_gex=rg['gex'], spx_iv0=rg['iv0'], spx_iv1=rg['iv1'], spx_pvol=rg['pvol'], spx_cvol=rg['cvol'],
                   spx_pcr=(rg['pvol'] / rg['cvol']) if rg['cvol'] else None)
    if qr:
        rec.update(qqq_gex=qr['gex'], qqq_iv0=qr['iv0'], qqq_iv1=qr['iv1'])
    return q, x, rg, qr, rec


@app.get('/cboe')
def cboe(t: str | None = None):
    """QQQ and SPX 1M ATM IV, QQQ−SPX spread, 1M 25Δ skew ratio, downside convexity (10Δ/25Δ), regime (dealer gamma, 0DTE/1DTE IV,
    put/call volume) + daily history percentiles / z-scores (the sentiment loop also saves it, so the final daily values get stored)."""
    auth(t)
    q, x, rg, qr, rec = _cboe_rec()
    return j(dict(qqq=q, spx=x, now=rec, regime=dict(SPX=rg, QQQ=qr), hist=_cboe_hist(rec)))


_qr = dict(ts=None, v=None, flow=None)
def _qqq_regime():
    s = state['snap']
    if not s or not state['chain']: return None
    if _qr['ts'] != s['ts']:
        _qr.update(ts=s['ts'], v=volframe.regime_stats(state['chain'], s['spot'], s['ts']),
                   flow=_oi_delta('QQQ', state['chain'], s['spot'], 0.06))
    return _qr['v']


@app.get('/sentiment')
def sentiment(t: str | None = None):
    """QQQ (main chain) + SPX + VIX gamma by strike from ThetaData, GEXbot-compatible (full = all expiries, zero = 0DTE/nearest)."""
    auth(t)
    out = {}
    s = state['snap']
    if s:
        land = s.get('landscape') or {}
        out['QQQ'] = _gex_view(state['chain'], s['spot'], s['ts'], s['buckets'].get('ALL', []), s['buckets'].get('0D') or s['buckets'].get('1D') or [], land)
        out['QQQ'].update(regime=_qqq_regime(), flow=_qr['flow'])
    for k, v in state['sent'].items():
        out[k] = v
    return j(out)


_yr = dict(k=None, at=0)
def yahoo_ratio():
    """Average NQ=F / QQQ close over the last 30 time-aligned 1-minute bars (cached 5 min)."""
    if time.time() - _yr['at'] < 300 and _yr['k']:
        return _yr['k']
    import httpx
    def bars(sym):
        r = httpx.get(f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1m&range=1d&includePrePost=true',
                      headers={'User-Agent': 'Mozilla/5.0'}, timeout=15)
        res = r.json()['chart']['result'][0]
        return {t: c for t, c in zip(res['timestamp'], res['indicators']['quote'][0]['close']) if c}
    try:
        a, b = bars('NQ=F'), bars('QQQ')
        rs = [a[t] / b[t] for t in sorted(set(a) & set(b))[-30:] if 20 < a[t] / b[t] < 80]
        if len(rs) >= 5:
            _yr.update(k=sum(rs) / len(rs), at=time.time())
    except Exception:
        pass
    return _yr['k']


def demo_trades():
    p = 30000.0
    while True:
        for _ in range(5):
            p += random.choice([-0.25, 0, 0.25]); p = round(p * 4) / 4
            tape.on_trade(time.time(), p, random.randint(1, 6), random.choice('AB'))
        time.sleep(0.2)


def demo_opt_trades():
    """synthetic option prints: mostly small, some large orders and multi-exchange sweeps, slight bullish tilt"""
    while not state['chain']:
        time.sleep(1)
    while True:
        chain, S = state['chain'], state.get('spot') or 725
        near = [c for c in chain if abs(c.strike / S - 1) < 0.03 and c.ask > 0.05]
        if not near:
            time.sleep(1); continue
        c = random.choice(near[:400])
        key = (c.exp, c.strike, c.right)
        big = random.random() < 0.06
        size = random.choice([1, 2, 5, 10, 20]) if not big else random.choice([150, 300, 500, 1000])
        r = random.random() + (0.08 if c.right == 'C' else -0.08)
        px = c.ask if r > 0.6 else c.bid if r < 0.35 else round((c.bid + c.ask) / 2, 2)
        if big and random.random() < 0.5:   # sweep across 3 exchanges
            for ex in (1, 5, 9):
                oflow.on_trade(key, time.time(), px, size // 3, c.bid, c.ask, ex); time.sleep(0.03)
        else:
            oflow.on_trade(key, time.time(), max(0.01, px), size, c.bid, c.ask, random.randint(1, 12))
        time.sleep(random.uniform(0.02, 0.15))


def saver():
    while True:
        time.sleep(60)
        for x in (tape, oflow):
            try:
                x.save()
            except Exception:
                pass


@app.get('/setup/token')
def setup_token(request: Request, t: str = '', w: str = ''):
    """the terminal on this PC hands over its Worker token + address (only local, only from the terminal's origin)"""
    global TOKEN
    if not is_local(request.headers, request.client.host if request.client else '') or request.headers.get('origin') not in ORIGINS:
        raise HTTPException(403, 'local terminal only')
    t, w = t.strip(), w.strip().rstrip('/')
    if len(t) < 6 or any(c in t for c in ' #\n\r'):
        raise HTTPException(400, 'bad token')
    changed = False
    if t != TOKEN:
        TOKEN = t; _write_env('ACCESS_TOKEN', t); changed = True
    if w.startswith('https://') and w != WORKER['url']:
        WORKER['url'] = w; _write_env('WORKER_URL', w); changed = True
    if changed:
        WORKER['registered'] = None
    return dict(ok=True, changed=changed, worker=bool(WORKER['url']))


def register_loop():
    """publish the Cloudflare tunnel address (written by tunnel.ps1) in the Worker so phones find this server"""
    import httpx
    last = 0.0
    while True:
        try:
            url = open(TUNNEL_FILE).read().strip() if os.path.exists(TUNNEL_FILE) else ''
            if not url: WORKER['status'] = 'tunel neběží'
            elif not WORKER['url'] or not TOKEN: WORKER['status'] = 'čekám na token z terminálu (otevři Algo Levels na PC)'
            elif WORKER['registered'] != url or time.time() - last > 600:
                r = httpx.get(WORKER['url'] + '/srv/set', params=dict(url=url, t=TOKEN), timeout=15)
                if r.status_code == 200:
                    WORKER.update(registered=url, status='ok ' + url); last = time.time()
                else:
                    WORKER['status'] = f'Worker {r.status_code}'; WORKER['registered'] = None
        except Exception as e:
            WORKER['status'] = f'{type(e).__name__}: {e}'
        time.sleep(15)


@app.on_event('startup')
def start():
    tape.load()
    try:
        oflow.load()
    except Exception:
        pass
    day = datetime.now(ET).strftime('%Y-%m-%d')
    fn = os.path.join(DATA_DIR, f'surface-{day}.jsonl')
    if os.path.exists(fn):
        with open(fn) as f:
            state['hist'] = [json.loads(l) for l in f if l.strip()]
    if DEMO:
        threading.Thread(target=demo_trades, daemon=True).start()
    elif os.environ.get('DATABENTO_API_KEY'):
        state['feed'] = DatabentoFeed(tape, os.environ['DATABENTO_API_KEY'], os.environ.get('FUT_SYMBOL', 'NQ.v.0'))
        state['feed'].start()
    threading.Thread(target=options_loop, daemon=True).start()
    if DEMO:
        threading.Thread(target=demo_opt_trades, daemon=True).start()
    elif os.environ.get('THETA_STREAM', '1') == '1':
        from providers.theta_stream import ThetaStream
        state['ostream'] = ThetaStream(oflow, ROOT, get_chain=lambda: (state['chain'], state.get('spot')))
        state['ostream'].start()
    threading.Thread(target=saver, daemon=True).start()
    if not DEMO and os.environ.get('SENT_ROOTS', '1') == '1':
        threading.Thread(target=sentiment_loop, daemon=True).start()
    if not DEMO:
        threading.Thread(target=register_loop, daemon=True).start()


# ── API ─────────────────────────────────────────────────────────────────────
def nq(x):
    k = state['k']
    return round(x * k * 4) / 4 if (x is not None and k) else None


@app.get('/health')
def health():
    f = state['feed']
    return dict(ok=True, demo=DEMO, futures=('demo' if DEMO else (f.status if f else 'no key')), futures_err=f.err if f else None,
                last=tape.last, last_age=round(time.time() - tape.last_ts, 1) if tape.last_ts else None,
                options_age=round(time.time() - state['opt_ts'], 1) if state['opt_ts'] else None, options_err=state['opt_err'], k=state['k'],
                opt_stream=('demo' if DEMO else (state['ostream'].status if state['ostream'] else 'off')),
                opt_stream_err=state['ostream'].err if state['ostream'] else None, opt_trades=oflow.tot['trades'],
                token_set=bool(TOKEN), tunnel=WORKER['status'])


@app.get('/levels')
def levels(t: str | None = None):
    """Consolidated options levels in QQQ and NQ terms (for the chart / Focus confluence)."""
    auth(t)
    s = state['snap']
    if not s:
        raise HTTPException(503, state['opt_err'] or 'options not ready')
    out = []
    def add(q, kind, w):
        if q is not None:
            out.append(dict(q=q, nq=nq(q), kind=kind, w=w))
    for b, L in s['levels'].items():
        if b not in ('0D', '1D', 'ALL'):
            continue
        for i, x in enumerate(L['call_walls'][:2]): add(x, f'{b} CW{i+1}', [3, 2][i] if b == '0D' else [2.5, 1.5][i])
        for i, x in enumerate(L['put_walls'][:2]): add(x, f'{b} PW{i+1}', [3, 2][i] if b == '0D' else [2.5, 1.5][i])
        for i, x in enumerate(L['call_walls_vol'][:1]): add(x, f'{b} CWv', 2)
        for i, x in enumerate(L['put_walls_vol'][:1]): add(x, f'{b} PWv', 2)
    pk = s['iv_peaks']
    if pk['hi']: add(pk['hi']['strike'], 'IVPK HI', 2)
    if pk['lo']: add(pk['lo']['strike'], 'IVPK LO', 2)
    for name, L in (('', s['landscape']), ('0D ', s['landscape_0d'])):
        if not L: continue
        add(L['flip'], name + 'γ FLIP', 2.5); add(L['ceiling'], name + 'CEILING', 2); add(L['floor'], name + 'FLOOR', 2); add(L['peak'], name + 'γ PEAK', 1.5)
    for x in oflow.flow_levels(2):     # strikes with the most one-sided premium today
        add(x['strike'], 'FLOW ' + ('+' if x['net'] > 0 else '−'), 1.5 + min(1.0, x['share'] * 2))
    em = s['em0']
    # per-strike greek exposure near spot (dealer GEX / VEX by OI) → level tags (G±) (V±)
    grid = {}
    for b in ('0D', 'ALL'):
        grid[b] = [[r['strike'], nq(r['strike']), round(r['gex_oi']), round(r['vex_oi'])]
                   for r in s['buckets'].get(b, []) if abs(r['strike'] / s['spot'] - 1) <= 0.03]
    return j(dict(ts=s['ts'], spot=s['spot'], k=state['k'], nq_last=tape.last, exp0=s['exp0'], atm_iv=s['atm_iv'], grid=grid,
                  em0=dict(qqq=em['em'], nq=em['em'] * state['k'] if state['k'] else None) if em else None,
                  regime=s['landscape']['regime'], dead_zone=s['landscape']['dead_zone'], dead_zone_0d=(s['landscape_0d'] or {}).get('dead_zone'),
                  levels=out))


@app.get('/options/strikes')
def strikes(bucket: str = '0D', pct: float = 0.03, t: str | None = None):
    auth(t)
    s = state['snap']
    if not s: raise HTTPException(503, state['opt_err'] or 'options not ready')
    rows = [dict(r, nq=nq(r['strike'])) for r in s['buckets'].get(bucket, []) if abs(r['strike'] / s['spot'] - 1) <= pct]
    return j(dict(ts=s['ts'], spot=s['spot'], k=state['k'], bucket=bucket, buckets=list(s['buckets']), rows=rows))


@app.get('/options/heatmap')
def opt_heatmap(metric: str = 'gex_oi', days: int = 45, pct: float = 0.04, t: str | None = None):
    auth(t)
    s = state['snap']
    if not s: raise HTTPException(503, state['opt_err'] or 'options not ready')
    h = heatmap(state['chain'], s['spot'], s['ts'], metric=metric, max_days=days, pct=pct)
    h['nq'] = [nq(k) for k in h['strikes']]
    return j(dict(ts=s['ts'], spot=s['spot'], **h))


@app.get('/options/smile')
def opt_smile(exp: str | None = None, t: str | None = None):
    auth(t)
    s = state['snap']
    if not s: raise HTTPException(503, state['opt_err'] or 'options not ready')
    exp = exp or s['exp0']
    return j(dict(ts=s['ts'], spot=s['spot'], exp=exp, expiries=s['expiries'], smile=smile(state['chain'], exp, s['spot']),
                  peaks=s['iv_peaks'] if exp == s['exp0'] else None))


@app.get('/options/term')
def opt_term(t: str | None = None):
    """ATM IV per expiry (term structure) + 25-delta-ish skew proxy (IV at ±3 % strikes)"""
    auth(t)
    s = state['snap']
    if not s: raise HTTPException(503, state['opt_err'] or 'options not ready')
    S, out = s['spot'], []
    for e in s['expiries'][:20]:
        sm = smile(state['chain'], e, S)
        if len(sm) < 5: continue
        at = lambda x: min(sm, key=lambda p: abs(p['strike'] - x))['iv']
        out.append(dict(exp=e, atm=at(S), put3=at(S * 0.97), call3=at(S * 1.03)))
    return j(dict(ts=s['ts'], spot=S, term=out))


_vol_cache = dict(at=0.0, ts=None, rep=None)


def _vol_hist_update(rep):
    """one record per day (latest wins) → percentile of skew / wing / ABS GEX vs recent history"""
    fn = os.path.join(DATA_DIR, 'vol-hist.json')
    try:
        with open(fn) as f: H = json.load(f)
    except Exception:
        H = {}
    day = datetime.now(ET).strftime('%Y-%m-%d')
    H[day] = dict(near=rep['skew']['near'], medium=rep['skew']['medium'], wing90=rep['skew']['wing90'],
                  abs_gex=rep['gex']['abs'], holes=rep['holes'], front=(rep['front'] or {}).get('atm'))
    H = dict(sorted(H.items())[-120:])
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(fn + '.tmp', 'w') as f: json.dump(H, f)
        os.replace(fn + '.tmp', fn)
    except Exception:
        pass
    prev = [v for d, v in H.items() if d < day][-60:]
    def pct(key):
        xs = [v[key] for v in prev if v.get(key) is not None]
        x = H[day].get(key)
        if x is None or len(xs) < 5: return None
        return round(sum(1 for v in xs if v <= x) / len(xs), 3)
    last = prev[-1] if prev else None
    return dict(n=len(prev), pct={k: pct(k) for k in ('near', 'medium', 'wing90', 'abs_gex')},
                prev=last, holes_change=(rep['holes'] - last['holes']) if last and last.get('holes') is not None else None,
                front_change=(rep['front']['atm'] - last['front']) if (last and last.get('front') and rep['front'] and rep['front'].get('atm')) else None)


@app.get('/vol')
def vol(t: str | None = None):
    """Nightly-routine volatility report: term structure, skew, Sig(x) vol map, shadow gamma, GEX structure,
    max pain, expected-move brackets (YYY guide ch. 6, 8, 9, 10). NQ prices via the QQQ→NQ ratio."""
    auth(t)
    s = state['snap']
    if not s: raise HTTPException(503, state['opt_err'] or 'options not ready')
    if _vol_cache['ts'] != s['ts'] or time.time() - _vol_cache['at'] > 120:
        rep = volframe.report(state['chain'], s['spot'], s['ts'], s)
        if not rep: raise HTTPException(503, 'no IV data yet')
        rep['hist'] = _vol_hist_update(rep)
        _vol_cache.update(at=time.time(), ts=s['ts'], rep=rep)
    rep = _vol_cache['rep']
    k = state['k']
    g = rep['gex']
    toNQ = lambda x: nq(x) if x is not None else None
    rep = dict(rep, k=k, nq=dict(call_wall=toNQ(g['call_wall']), put_wall=toNQ(g['put_wall']),
                                 call_wall_0d=toNQ(g['call_wall_0d']), put_wall_0d=toNQ(g['put_wall_0d']),
                                 vol_trigger=toNQ(rep['vol_trigger']),
                                 max_pain={kk: toNQ(v) for kk, v in rep['max_pain'].items() if not str(kk).startswith('exp')},
                                 big_calls=[toNQ(x) for x in g['big_calls']], big_puts=[toNQ(x) for x in g['big_puts']],
                                 brackets={kk: (v * k if (v is not None and k) else None) for kk, v in rep['brackets'].items()}))
    return j(rep)


@app.get('/options/landscape')
def opt_landscape(which: str = 'all', t: str | None = None):
    auth(t)
    s = state['snap']
    if not s: raise HTTPException(503, state['opt_err'] or 'options not ready')
    L = s['landscape_0d'] if which == '0d' else s['landscape']
    if not L: raise HTTPException(404, 'no 0DTE expiry today')
    return j(dict(ts=s['ts'], spot=s['spot'], k=state['k'], **L))


@app.get('/options/surface')
def opt_surface(t: str | None = None):
    """intraday history of 0DTE GEX by strike (every poll) for the heatmap-over-time view"""
    auth(t)
    return j(dict(rows=state['hist'][-1500:], k=state['k']))


@app.get('/bars')
def bars(key: str = '60s', n: int = 600, fp: int = 0, t: str | None = None):
    auth(t)
    if key not in tape.series: raise HTTPException(400, 'unknown series; use ' + ', '.join(tape.series))
    return j(dict(key=key, bars=tape.bars(key, min(n, 3000), footprint=bool(fp)), **tape.summary()))


@app.get('/flow')
def flow(t: str | None = None):
    auth(t)
    return j(dict(cvd_series=tape.cvd_series(), profile_rth=tape.volume_profile('rth'), profile_eth=tape.volume_profile('eth'), tpo=tape.tpo_profile(), **tape.summary()))


@app.get('/options/flow')
def opt_flow(min_prem: float | None = None, only0d: int = 0, kind: str | None = None, pct: float = 0.04, n: int = 150, t: str | None = None):
    """options flow: day totals, cumulative bullish/bearish premium + delta per minute, net premium by strike, tape of large orders"""
    auth(t)
    k = state['k']
    tp = oflow.tape(min(n, 500), min_prem, bool(only0d), kind)
    for o in tp:
        o['nq'] = nq(o['strike'])
    st_ = oflow.by_strike(pct, bool(only0d))
    for r in st_:
        r['nq'] = nq(r['strike'])
    sm = oflow.summary()
    sm['delta_nq'] = (sm['delta'] * (sm['spot'] or 0) / ((sm['spot'] or 0) * k * 20)) if k and sm['spot'] else None   # ≈ NQ contracts
    return j(dict(summary=sm, series=oflow.series(), strikes=st_, tape=tp, k=k, min_prem=min_prem or oflow.min_prem,
                  stream=('demo' if DEMO else (state['ostream'].status if state['ostream'] else 'off'))))


@app.websocket('/ws')
async def ws(sock: WebSocket, t: str | None = None, key: str = '60s'):
    if TOKEN and t != TOKEN and not is_local(sock.headers, sock.client.host if sock.client else ''):
        await sock.close(code=4401); return
    await sock.accept()
    try:
        while True:
            k = key if key in tape.series else '60s'
            await sock.send_text(json.dumps(j(dict(type='tick', key=k, bars=tape.bars(k, 2, footprint=k in ('60s', '300s')), **tape.summary()))))
            await asyncio.sleep(1.0)
    except (WebSocketDisconnect, RuntimeError):
        pass
