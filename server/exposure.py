"""Options chain → dealer exposures by strike × expiry, IV smile, IV peaks, MM landscape.

Conventions (same as GEXbot / SpotGamma style):
  GEX  = sign · gamma · N · 100 · S² · 0.01      $ delta change per 1 % move  (calls +, puts −)
  VEX  = sign · vanna · N · 100 · S · 0.01       $ delta change per +1 vol point
  CEX  = sign · charm/365 · N · 100 · S          $ delta change per calendar day (time decay)
  DEX  = delta · N · 100 · S                     customer net delta in $ (calls +, puts −)
  N = open interest (…_oi) or today's volume (…_vol).
  Positive GEX at a strike ⇒ dealers assumed long gamma there (they sell rallies / buy dips → pinning).

IV for each strike comes from the OTM side (call above forward, put below) and is applied to both rights,
so deep-ITM quote noise does not distort greeks.
"""
from __future__ import annotations
import math, statistics, time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from greeks import implied_vol, greeks, price

ET = ZoneInfo('America/New_York')
YEAR = 365.0 * 86400


@dataclass
class Contract:
    exp: str          # YYYY-MM-DD
    strike: float
    right: str        # 'C' | 'P'
    bid: float
    ask: float
    oi: float = 0.0
    volume: float = 0.0
    iv: float | None = None
    g: dict = field(default_factory=dict)


def expiry_ts(exp: str) -> float:
    y, m, d = map(int, exp.split('-'))
    return datetime(y, m, d, 16, 0, tzinfo=ET).timestamp()


def mid(c: Contract):
    if c.bid is None or c.ask is None or c.ask <= 0:
        return None
    if c.bid <= 0:
        return c.ask / 2
    if c.ask / max(c.bid, 1e-9) > 3:  # extremely wide market
        return None
    return (c.bid + c.ask) / 2


def enrich(chain: list[Contract], S: float, now: float, r: float = 0.045, q: float = 0.006):
    """Solve IV (OTM side) and greeks for every contract, in place. Returns {exp: T}."""
    by = {}
    for c in chain:
        by.setdefault((c.exp, c.strike), {})[c.right] = c
    Ts = {}
    for (exp, K), pair in by.items():
        T = max(60.0, expiry_ts(exp) - now) / YEAR
        Ts[exp] = T
        F = S * math.exp((r - q) * T)
        order = ['C', 'P'] if K >= F else ['P', 'C']
        iv = None
        for side in order:
            c = pair.get(side)
            if c is None:
                continue
            m = mid(c)
            if m is None:
                continue
            iv = implied_vol(m, S, K, T, r, q, side == 'C')
            if iv is not None and 0.01 < iv < 4.0:
                break
            iv = None
        for c in pair.values():
            c.iv = iv
            c.g = greeks(S, K, T, r, q, iv, c.right == 'C') if iv else {}
    return Ts


def _bucket_of(exp: str, exps_sorted: list[str], today: str, days: float):
    b = ['ALL']
    if exp == today:
        b.append('0D')
    if len(exps_sorted) > 1 and exp == next((e for e in exps_sorted if e > today), None):
        b.append('1D')
    if days <= 7.5:
        b.append('W')
    if days <= 45:
        b.append('M')
    return b


def aggregate(chain: list[Contract], S: float, now: float):
    """Per bucket → per strike exposures. Returns dict bucket → sorted list of rows."""
    today = datetime.fromtimestamp(now, ET).strftime('%Y-%m-%d')
    exps = sorted({c.exp for c in chain if c.exp >= today})
    out = {}
    for c in chain:
        if not c.g or c.exp < today:
            continue
        days = (expiry_ts(c.exp) - now) / 86400
        sign = 1.0 if c.right == 'C' else -1.0
        g = c.g
        vals = {
            'gex_oi': sign * g['gamma'] * c.oi * 100 * S * S * 0.01,
            'gex_vol': sign * g['gamma'] * c.volume * 100 * S * S * 0.01,
            'dex_oi': g['delta'] * c.oi * 100 * S,
            'vex_oi': sign * g['vanna'] * c.oi * 100 * S * 0.01,
            'cex_oi': sign * g['charm'] / 365 * c.oi * 100 * S,
            'oi_c': c.oi if c.right == 'C' else 0.0, 'oi_p': c.oi if c.right == 'P' else 0.0,
            'vol_c': c.volume if c.right == 'C' else 0.0, 'vol_p': c.volume if c.right == 'P' else 0.0,
        }
        for b in _bucket_of(c.exp, exps, today, days):
            row = out.setdefault(b, {}).setdefault(c.strike, {k: 0.0 for k in vals})
            for k, v in vals.items():
                row[k] += v
    return {b: [dict(strike=k, **v) for k, v in sorted(rows.items())] for b, rows in out.items()}, exps


def heatmap(chain: list[Contract], S: float, now: float, metric='gex_oi', max_days=60, pct=0.04):
    """strike × expiry matrix of one exposure metric (expiries up to max_days, strikes within ±pct)."""
    today = datetime.fromtimestamp(now, ET).strftime('%Y-%m-%d')
    cells, exps, strikes = {}, set(), set()
    for c in chain:
        if not c.g or c.exp < today or (expiry_ts(c.exp) - now) / 86400 > max_days or abs(c.strike / S - 1) > pct:
            continue
        sign = 1.0 if c.right == 'C' else -1.0
        g = c.g
        v = {
            'gex_oi': sign * g['gamma'] * c.oi * 100 * S * S * 0.01,
            'gex_vol': sign * g['gamma'] * c.volume * 100 * S * S * 0.01,
            'dex_oi': g['delta'] * c.oi * 100 * S,
            'vex_oi': sign * g['vanna'] * c.oi * 100 * S * 0.01,
            'cex_oi': sign * g['charm'] / 365 * c.oi * 100 * S,
            'oi': c.oi, 'vol': c.volume,
        }[metric]
        cells[(c.exp, c.strike)] = cells.get((c.exp, c.strike), 0.0) + v
        exps.add(c.exp); strikes.add(c.strike)
    exps, strikes = sorted(exps), sorted(strikes)
    return dict(expiries=exps, strikes=strikes, metric=metric,
                z=[[round(cells.get((e, k), 0.0)) for e in exps] for k in strikes])


def smile(chain: list[Contract], exp: str, S: float):
    pts = {}
    for c in chain:
        if c.exp == exp and c.iv:
            pts[c.strike] = c.iv
    return [dict(strike=k, iv=v) for k, v in sorted(pts.items())]


def _quadfit(xs, ys, ws):
    """weighted least squares y = a + b x + c x²"""
    import numpy as np
    X = np.vstack([np.ones(len(xs)), xs, np.square(xs)]).T
    W = np.sqrt(np.asarray(ws))
    coef, *_ = np.linalg.lstsq(X * W[:, None], np.asarray(ys) * W, rcond=None)
    return coef


def iv_peaks(sm: list[dict], S: float, T: float, min_pts=0.005):
    """IV walls = strikes where the smile bulges above a smooth quadratic fit in log-moneyness
    (concentrated demand). IVPK HI / LO = nearest significant bulge above / below spot."""
    if len(sm) < 9:
        return dict(hi=None, lo=None, walls=[])
    sd = max(0.002, (statistics.median(p['iv'] for p in sm)) * math.sqrt(T))
    xs, ys, ws, ks = [], [], [], []
    for p in sm:
        k = math.log(p['strike'] / S)
        if abs(k) > 6 * sd:
            continue
        xs.append(k); ys.append(p['iv']); ws.append(math.exp(-0.5 * (k / (3 * sd)) ** 2)); ks.append(p['strike'])
    if len(xs) < 9:
        return dict(hi=None, lo=None, walls=[])
    a, b, c = _quadfit(xs, ys, ws)
    res = [y - (a + b * x + c * x * x) for x, y in zip(xs, ys)]
    mad = statistics.median(abs(x) for x in res) or 1e-6
    walls = []
    for i in range(1, len(res) - 1):
        if res[i] > res[i - 1] and res[i] >= res[i + 1] and res[i] > max(min_pts, 1.5 * mad):
            walls.append(dict(strike=float(ks[i]), excess=round(float(res[i]) * 100, 2)))
    above = [w for w in walls if w['strike'] > S]
    below = [w for w in walls if w['strike'] < S]
    return dict(hi=min(above, key=lambda w: w['strike']) if above else None,
                lo=max(below, key=lambda w: w['strike']) if below else None, walls=walls)


def landscape(chain: list[Contract], S: float, now: float, r=0.045, q=0.006, span=0.03, steps=61, max_days=45, only_today=False):
    """Total dealer GEX as a function of a hypothetical spot (re-pricing gamma at each grid point).
    Returns grid, gamma flip, peak, ceiling/floor strikes and the 'dead zone' (|GEX| < 15 % of max)."""
    today = datetime.fromtimestamp(now, ET).strftime('%Y-%m-%d')
    use = [c for c in chain if c.iv and c.oi > 0 and c.exp >= today and (expiry_ts(c.exp) - now) / 86400 <= max_days
           and (not only_today or c.exp == today) and abs(c.strike / S - 1) < span * 2.5]
    grid = []
    for i in range(steps):
        x = S * (1 - span + 2 * span * i / (steps - 1))
        tot = 0.0
        for c in use:
            T = max(60.0, expiry_ts(c.exp) - now) / YEAR
            gm = greeks(x, c.strike, T, r, q, c.iv, c.right == 'C')['gamma']
            tot += (1 if c.right == 'C' else -1) * gm * c.oi * 100 * x * x * 0.01
        grid.append(dict(spot=x, gex=tot))
    flip = None
    for a, b in zip(grid, grid[1:]):
        if (a['gex'] <= 0 < b['gex']) or (a['gex'] >= 0 > b['gex']):
            x = a['spot'] + (b['spot'] - a['spot']) * (0 - a['gex']) / (b['gex'] - a['gex'])
            if flip is None or abs(x - S) < abs(flip - S):
                flip = x
    peak = max(grid, key=lambda p: p['gex']) if grid else None
    mx = max((abs(p['gex']) for p in grid), default=0) or 1
    dead = None
    if flip is not None:
        inside = [p['spot'] for p in grid if abs(p['gex']) < 0.15 * mx and abs(p['spot'] - flip) < S * span]
        if inside:
            dead = dict(lo=min(inside), hi=max(inside))
    # strike walls from per-strike OI GEX
    per = {}
    for c in use:
        per[c.strike] = per.get(c.strike, 0.0) + (1 if c.right == 'C' else -1) * (c.g.get('gamma', 0)) * c.oi * 100 * S * S * 0.01
    ceil_ = max(((k, v) for k, v in per.items() if k > S and v > 0), key=lambda kv: kv[1], default=None)
    floor_ = min(((k, v) for k, v in per.items() if k < S and v < 0), key=lambda kv: kv[1], default=None)
    return dict(grid=grid, flip=flip, peak=peak['spot'] if peak else None, peak_gex=peak['gex'] if peak else None,
                ceiling=ceil_[0] if ceil_ else None, floor=floor_[0] if floor_ else None, dead_zone=dead,
                regime='positive' if (grid and min(grid, key=lambda p: abs(p['spot'] - S))['gex'] > 0) else 'negative')


def straddle_em(chain: list[Contract], exp: str, S: float):
    by = {}
    for c in chain:
        if c.exp == exp:
            by.setdefault(c.strike, {})[c.right] = c
    if not by:
        return None
    K = min(by, key=lambda k: abs(k - S))
    pr = by[K]
    if 'C' not in pr or 'P' not in pr:
        return None
    mc, mp = mid(pr['C']), mid(pr['P'])
    if mc is None or mp is None:
        return None
    return dict(strike=K, straddle=mc + mp, em=0.85 * (mc + mp))   # ≈ 1σ move ≈ 0.8–0.85 × ATM straddle


def snapshot(chain: list[Contract], S: float, now: float | None = None, k_nq: float | None = None):
    """Everything the terminal needs from one chain snapshot."""
    now = now or time.time()
    Ts = enrich(chain, S, now)
    buckets, exps = aggregate(chain, S, now)
    today = datetime.fromtimestamp(now, ET).strftime('%Y-%m-%d')
    e0 = next((e for e in exps if e >= today), None)
    sm0 = smile(chain, e0, S) if e0 else []
    pk = iv_peaks(sm0, S, Ts.get(e0, 1 / 365)) if e0 else dict(hi=None, lo=None, walls=[])
    land_all = landscape(chain, S, now)
    land_0d = landscape(chain, S, now, only_today=True) if e0 == today else None
    em0 = straddle_em(chain, e0, S) if e0 else None

    def top(rows, key, n=3, sign=1):
        rr = [r for r in rows if sign * r[key] > 0]
        return [r['strike'] for r in sorted(rr, key=lambda r: -sign * r[key])[:n]]

    levels = {}
    for b, rows in buckets.items():
        levels[b] = dict(call_walls=top(rows, 'gex_oi', 3, 1), put_walls=top(rows, 'gex_oi', 3, -1),
                         call_walls_vol=top(rows, 'gex_vol', 3, 1), put_walls_vol=top(rows, 'gex_vol', 3, -1),
                         max_oi_c=max(rows, key=lambda r: r['oi_c'])['strike'] if rows else None,
                         max_oi_p=max(rows, key=lambda r: r['oi_p'])['strike'] if rows else None)
    return dict(ts=now, spot=S, k_nq=k_nq, expiries=exps[:40], today=today, exp0=e0,
                buckets=buckets, levels=levels, smile0=sm0, iv_peaks=pk, em0=em0,
                landscape=land_all, landscape_0d=land_0d,
                atm_iv=min(sm0, key=lambda p: abs(p['strike'] - S))['iv'] if sm0 else None)
