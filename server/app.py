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

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from exposure import snapshot, heatmap, smile
from futures import Tape, DatabentoFeed

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

tape = Tape(state_file=os.path.join(DATA_DIR, 'tape.json'))
state = dict(chain=None, snap=None, k=None, opt_err=None, opt_ts=0, feed=None, hist=[])


def auth(t: str | None):
    if TOKEN and t != TOKEN:
        raise HTTPException(401, 'unauthorized')


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
            nq = tape.last
            k_new = nq / S if nq and S and 20 < nq / S < 80 else None
            state['k'] = k_new if state['k'] is None or k_new is None else 0.8 * state['k'] + 0.2 * k_new
            snap = snapshot(chain, S, time.time(), k_nq=state['k'])
            state.update(chain=chain, snap=snap, opt_err=None, opt_ts=time.time())
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


def demo_trades():
    p = 30000.0
    while True:
        for _ in range(5):
            p += random.choice([-0.25, 0, 0.25]); p = round(p * 4) / 4
            tape.on_trade(time.time(), p, random.randint(1, 6), random.choice('AB'))
        time.sleep(0.2)


def saver():
    while True:
        time.sleep(60)
        try:
            tape.save()
        except Exception:
            pass


@app.on_event('startup')
def start():
    tape.load()
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
    threading.Thread(target=saver, daemon=True).start()


# ── API ─────────────────────────────────────────────────────────────────────
def nq(x):
    k = state['k']
    return round(x * k * 4) / 4 if (x is not None and k) else None


@app.get('/health')
def health():
    f = state['feed']
    return dict(ok=True, demo=DEMO, futures=('demo' if DEMO else (f.status if f else 'no key')), futures_err=f.err if f else None,
                last=tape.last, last_age=round(time.time() - tape.last_ts, 1) if tape.last_ts else None,
                options_age=round(time.time() - state['opt_ts'], 1) if state['opt_ts'] else None, options_err=state['opt_err'], k=state['k'])


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
    em = s['em0']
    return j(dict(ts=s['ts'], spot=s['spot'], k=state['k'], nq_last=tape.last, exp0=s['exp0'], atm_iv=s['atm_iv'],
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


@app.websocket('/ws')
async def ws(sock: WebSocket, t: str | None = None, key: str = '60s'):
    if TOKEN and t != TOKEN:
        await sock.close(code=4401); return
    await sock.accept()
    try:
        while True:
            k = key if key in tape.series else '60s'
            await sock.send_text(json.dumps(j(dict(type='tick', key=k, bars=tape.bars(k, 2, footprint=k in ('60s', '300s')), **tape.summary()))))
            await asyncio.sleep(1.0)
    except (WebSocketDisconnect, RuntimeError):
        pass
