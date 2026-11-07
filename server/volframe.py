"""Volatility / skew / dealer-positioning report for the nightly bias routine (YYY Practitioner's Guide, ch. 6, 8, 9, 10).

Everything is computed from one enriched chain snapshot (IV + greeks already solved by exposure.enrich):

  term structure      ATM IV per expiry, contango / backwardation (front vs ~30–60 DTE), forward vol between tenors
                      σ²_fwd = (σ²(T2)·T2 − σ²(T1)·T1) / (T2 − T1)
  skew                25-delta put IV − 25-delta call IV, near term (0–7 DTE) vs medium term (20–50 DTE),
                      left-wing steepness IV(0.90 K/S) − ATM, call-side elevation (squeeze flag)
  vol map Sig(x)      IV at moneyness (1+x) − ATM IV for x = ±2, 5, 8, 10 %   (chain-extracted vol response, ch. 10.3)
  shadow gamma        dealer delta re-priced at V + Sig(x) for the move (ch. 8.2):
                        up   = [Δ(x, V+Sig(x)) − Δ(x0, V)] / (x − x0)
                        down = [Δ(x0, V) − Δ(x′, V+Sig(x′))] / (x0 − x′)
                      reported next to conventional gamma (same sign convention as GEX: calls +, puts −)
  GEX (0–21 DTE)      NET and ABS dollar gamma per 1 %, call wall (max call OI), put wall (max put OI below spot),
                      0DTE wall = multi-expiry wall flag, range width and spot position inside it
  max pain            nearest expiry, end-of-week expiry, monthly opex
  expected move       1-day / 1-week / 1-month brackets from ATM IV, plus asymmetric down / up brackets from 25Δ IVs
  checks              ATM IV bucket, sigma consistency across DTEs, front-edge event spikes, IV holes ("negative dips")
"""
from __future__ import annotations
import math, statistics
from datetime import datetime, timedelta

from exposure import Contract, expiry_ts, ET, YEAR
from greeks import greeks

R, Q = 0.045, 0.006


def _interp(pts, x):
    """linear interpolation in a sorted [(x, y)] list, flat outside"""
    if not pts:
        return None
    if x <= pts[0][0]:
        return pts[0][1]
    if x >= pts[-1][0]:
        return pts[-1][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 <= x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0) if x1 > x0 else y0
    return pts[-1][1]


def _smiles(chain, S, now, max_days=70):
    """{exp: dict(T, dte, pts=[(K, iv)], d=[(delta, iv, right)])} for expiries ≤ max_days"""
    out = {}
    for c in chain:
        if not c.iv:
            continue
        T = (expiry_ts(c.exp) - now) / YEAR
        if T <= 0 or T * 365 > max_days:
            continue
        e = out.setdefault(c.exp, dict(T=max(T, 60 / YEAR), dte=T * 365, k={}, d=[]))
        e['k'][c.strike] = c.iv
        if c.g and 'delta' in c.g:
            e['d'].append((c.g['delta'], c.iv, c.right))
    for e in out.values():
        e['pts'] = sorted(e['k'].items())
        del e['k']
    return dict(sorted(out.items()))


def _delta_iv(e, target, right):
    """IV of the contract whose delta is closest to target (e.g. −0.25 put, +0.25 call)"""
    c = [x for x in e['d'] if x[2] == right]
    if not c:
        return None
    b = min(c, key=lambda x: abs(x[0] - target))
    return b[1] if abs(b[0] - target) < 0.12 else None


def _atm(e, S):
    return _interp(e['pts'], S)


def _avg(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def _atm_at_tenor(sm, S, days):
    """ATM IV interpolated in total variance at a given tenor (days)"""
    pts = [(e['dte'], _atm(e, S)) for e in sm.values() if _atm(e, S)]
    pts = [(d, v) for d, v in pts if d >= 0.5]
    if not pts:
        return None
    if days <= pts[0][0]:
        return pts[0][1]
    if days >= pts[-1][0]:
        return pts[-1][1]
    tv = [(d, v * v * d) for d, v in pts]
    w = _interp(tv, days)
    return math.sqrt(max(w, 1e-12) / days)


def max_pain(chain, exp):
    oi = {}
    for c in chain:
        if c.exp == exp and c.oi:
            r = oi.setdefault(c.strike, [0.0, 0.0])
            r[0 if c.right == 'C' else 1] += c.oi
    if len(oi) < 5:
        return None
    ks = sorted(oi)
    best = min(ks, key=lambda P: sum(v[0] * max(P - K, 0) + v[1] * max(K - P, 0) for K, v in oi.items()))
    return best


def _dealer_delta(book, x, shift_fn):
    """Σ sign · Δ(x, iv + shift) · OI · 100  (calls +, puts − : same convention as GEX)"""
    tot = 0.0
    for (K, T, iv, is_call, oi, sm) in book:
        s = iv + shift_fn(sm, x)
        if s <= 0.01:
            s = 0.01
        d = greeks(x, K, T, R, Q, s, is_call)['delta']
        tot += (1.0 if is_call else -1.0) * d * oi * 100
    return tot


def shadow_gamma(chain, S, now, sm, max_days=21, moves=(0.01, 0.02, 0.05)):
    """Conventional vs shadow (vol-adjusted) dealer gamma, $ per 1 % move, for small and larger moves."""
    book = []
    for c in chain:
        if not c.iv or not c.oi:
            continue
        T = (expiry_ts(c.exp) - now) / YEAR
        if T <= 0 or T * 365 > max_days or abs(c.strike / S - 1) > 0.15:
            continue
        e = sm.get(c.exp)
        if not e:
            continue
        book.append((c.strike, max(T, 60 / YEAR), c.iv, c.right == 'C', c.oi, e))
    if not book:
        return None

    def sig(e, x):  # chain-implied vol response for spot at x: IV at moneyness x/S − ATM IV (ch. 10.3)
        a = _atm(e, S)
        v = _interp(e['pts'], x)
        return (v - a) if (a is not None and v is not None) else 0.0

    zero = lambda e, x: 0.0
    d0 = _dealer_delta(book, S, zero)
    out = []
    for m in moves:
        h = S * m
        up_c = (_dealer_delta(book, S + h, zero) - d0) / h
        dn_c = (d0 - _dealer_delta(book, S - h, zero)) / h
        up_s = (_dealer_delta(book, S + h, sig) - d0) / h
        dn_s = (d0 - _dealer_delta(book, S - h, sig)) / h
        k = S * S * 0.01   # shares per point → $ per 1 % move (GEX units)
        out.append(dict(move=m, conv_up=up_c * k, conv_down=dn_c * k, shadow_up=up_s * k, shadow_down=dn_s * k,
                        ratio_down=(dn_s / dn_c) if abs(dn_c) > 1e-9 else None,
                        ratio_up=(up_s / up_c) if abs(up_c) > 1e-9 else None))
    return out


def gex_structure(chain, S, now, max_days=21):
    net = absg = 0.0
    oi_c, oi_p, g0 = {}, {}, {}
    today = datetime.fromtimestamp(now, ET).strftime('%Y-%m-%d')
    for c in chain:
        if not c.g or not c.oi:
            continue
        T = (expiry_ts(c.exp) - now) / YEAR
        if T < -1e-9 or T * 365 > max_days:
            continue
        g = (1.0 if c.right == 'C' else -1.0) * c.g['gamma'] * c.oi * 100 * S * S * 0.01
        net += g
        absg += abs(g)
        d = oi_c if c.right == 'C' else oi_p
        d[c.strike] = d.get(c.strike, 0.0) + c.oi
        if c.exp == today:
            g0[c.strike] = g0.get(c.strike, 0.0) + g
    above = {k: v for k, v in oi_c.items() if k > S}
    below = {k: v for k, v in oi_p.items() if k < S}
    cw = max(above, key=above.get) if above else None
    pw = max(below, key=below.get) if below else None
    cw0 = max((k for k in g0 if k > S and g0[k] > 0), key=lambda k: g0[k], default=None)
    pw0 = min((k for k in g0 if k < S and g0[k] < 0), key=lambda k: g0[k], default=None)
    top = lambda d, n: [k for k, _ in sorted(d.items(), key=lambda kv: -kv[1])[:n]]
    return dict(net=net, abs=absg, coiled=(absg > 0 and abs(net) / absg < 0.15),
                call_wall=cw, put_wall=pw, call_wall_0d=cw0, put_wall_0d=pw0,
                wall_match_c=(cw is not None and cw0 == cw), wall_match_p=(pw is not None and pw0 == pw),
                width=(cw - pw) if (cw and pw) else None,
                pos=((S - pw) / (cw - pw)) if (cw and pw and cw > pw) else None,
                big_calls=top(oi_c, 3), big_puts=top(oi_p, 3))


def surface_stats(chain, S, now):
    """Cboe Macro Volatility Digest style stats from one chain (IV/greeks already solved):
    1M ATM IV (30 calendar days, total-variance interpolation), 1M skew = 25Δ put IV / 25Δ call IV,
    downside convexity = 10Δ put IV / 25Δ put IV (tail-hedge demand), from the expiry closest to 30 days."""
    sm = _smiles(chain, S, now, max_days=70)
    if not sm:
        return None
    e = min(sm.values(), key=lambda x: abs(x['dte'] - 30))
    p25, c25, p10 = _delta_iv(e, -0.25, 'P'), _delta_iv(e, 0.25, 'C'), _delta_iv(e, -0.10, 'P')
    return dict(atm30=_atm_at_tenor(sm, S, 30), dte=round(e['dte'], 1),
                skew=(p25 / c25) if (p25 and c25) else None, convexity=(p10 / p25) if (p10 and p25) else None,
                put25=p25, call25=c25, put10=p10)


def report(chain: list[Contract], S: float, now: float, snap: dict | None = None):
    sm = _smiles(chain, S, now)
    if not sm:
        return None
    rows = []
    for exp, e in sm.items():
        a = _atm(e, S)
        p25, c25 = _delta_iv(e, -0.25, 'P'), _delta_iv(e, 0.25, 'C')
        rows.append(dict(exp=exp, dte=round(e['dte'], 2), atm=a, put25=p25, call25=c25,
                         skew25=(p25 - c25) if (p25 is not None and c25 is not None) else None,
                         wing90=(_interp(e['pts'], S * 0.90) - a) if a else None,
                         holes=sum(1 for c in chain if c.exp == exp and c.iv is None and abs(c.strike / S - 1) < 0.15)))
    near = [r for r in rows if 0 <= r['dte'] <= 7.5]
    med = [r for r in rows if 20 <= r['dte'] <= 50]
    front = next((r for r in rows if r['dte'] >= 1 and r['atm']), None) or (rows[0] if rows else None)
    back = [r for r in rows if 30 <= r['dte'] <= 65 and r['atm']]
    back_atm = _avg([r['atm'] for r in back])
    contango = (back_atm > front['atm']) if (front and front['atm'] and back_atm) else None

    a1, a7, a30, a60 = (_atm_at_tenor(sm, S, d) for d in (1, 7, 30, 60))
    def fwd(v1, t1, v2, t2):
        if not (v1 and v2) or t2 <= t1:
            return None
        w = (v2 * v2 * t2 - v1 * v1 * t1) / (t2 - t1)
        return math.sqrt(w) if w > 0 else None
    fwd_7_30 = fwd(a7, 7 / 365, a30, 30 / 365)
    fwd_30_60 = fwd(a30, 30 / 365, a60, 60 / 365)

    # Sig(x) vol map from the ~7 DTE and ~30 DTE smiles
    def nearest(days):
        return min(sm.values(), key=lambda e: abs(e['dte'] - days)) if sm else None
    vmap = {}
    for name, days in (('7d', 7), ('30d', 30)):
        e = nearest(days)
        a = _atm(e, S) if e else None
        if not a:
            continue
        vmap[name] = [dict(move=m, iv=_interp(e['pts'], S * (1 + m)), sig=_interp(e['pts'], S * (1 + m)) - a)
                      for m in (-0.10, -0.08, -0.05, -0.02, 0.02, 0.05, 0.08, 0.10)]

    # expected-move brackets (1σ): S · IV · √(days/252)
    def em(iv, td):
        return S * iv * math.sqrt(td / 252) if iv else None
    p25n = _avg([r['put25'] for r in near]) or (front and front['put25'])
    c25n = _avg([r['call25'] for r in near]) or (front and front['call25'])
    brackets = dict(d1=em(a1, 1), w1=em(a7, 5), m1=em(a30, 21),
                    d1_down=em(p25n, 1), d1_up=em(c25n, 1))

    atm_ref = a1 or (front and front['atm'])
    bucket = None
    if atm_ref:
        v = atm_ref * 100
        bucket = 'REAL MOVES' if v > 35 else 'NORMAL' if v >= 20 else 'COMPRESSED' if v >= 15 else 'NOTHING PRICED'
    atms = [r['atm'] for r in rows if r['atm'] and r['dte'] >= 0.5][:8]
    jumps = [abs(b - a) for a, b in zip(atms, atms[1:])]
    consistency = (statistics.pstdev(jumps) / statistics.mean(atms)) if len(jumps) >= 3 else None
    spikes = []
    for i in range(1, len(rows) - 1):
        r = rows[i]
        if r['dte'] <= 7.5 and r['atm'] and rows[i - 1]['atm'] and rows[i + 1]['atm'] \
                and r['atm'] - max(rows[i - 1]['atm'], rows[i + 1]['atm']) > 0.02:
            spikes.append(r['exp'])

    # max pain: nearest expiry, end-of-week, monthly opex (3rd Friday)
    exps = sorted(sm)
    today = datetime.fromtimestamp(now, ET).date()
    fri = today + timedelta(days=(4 - today.weekday()) % 7)
    wk = max((e for e in exps if e <= fri.isoformat()), default=None)
    d1 = today.replace(day=1)
    third = d1 + timedelta(days=(4 - d1.weekday()) % 7 + 14)
    if third < today:
        n1 = (d1 + timedelta(days=32)).replace(day=1)
        third = n1 + timedelta(days=(4 - n1.weekday()) % 7 + 14)
    mo = min((e for e in exps if e >= third.isoformat()), default=None)
    mp = dict(near=max_pain(chain, exps[0]) if exps else None, week=max_pain(chain, wk) if wk else None,
              month=max_pain(chain, mo) if mo else None, exp_near=exps[0] if exps else None, exp_week=wk, exp_month=mo)

    land = (snap or {}).get('landscape') or {}
    return dict(
        ts=now, spot=S,
        term=rows, front=front, back_atm=back_atm, contango=contango,
        atm=dict(d1=a1, d7=a7, d30=a30, d60=a60), fwd=dict(f7_30=fwd_7_30, f30_60=fwd_30_60),
        skew=dict(near=_avg([r['skew25'] for r in near]), medium=_avg([r['skew25'] for r in med]),
                  near_put25=p25n, near_call25=c25n,
                  wing90=_avg([r['wing90'] for r in med]) or _avg([r['wing90'] for r in near]),
                  squeeze=(p25n is not None and c25n is not None and c25n >= p25n - 0.005)),
        vmap=vmap, shadow=shadow_gamma(chain, S, now, sm), gex=gex_structure(chain, S, now),
        vol_trigger=land.get('flip'), regime=land.get('regime'),
        max_pain=mp, brackets=brackets, atm_bucket=bucket, sigma_consistency=consistency,
        front_spikes=spikes, holes=sum(r['holes'] for r in near))


def _last_rth_close(now):
    """Timestamp of the most recent 16:00 ET close at or before now (weekends skipped)."""
    d = datetime.fromtimestamp(now, ET)
    c = d.replace(hour=16, minute=0, second=0, microsecond=0)
    if d < c:
        c -= timedelta(days=1)
    while c.weekday() >= 5:
        c -= timedelta(days=1)
    return c.timestamp()


def _in_rth(now):
    d = datetime.fromtimestamp(now, ET)
    m = d.hour * 60 + d.minute
    return d.weekday() < 5 and 570 <= m < 960


def regime_stats(chain, S, now):
    """Mentor's 'regime first' read from one enriched chain:
    gex      net dealer gamma $ per 1 % (calls +, puts −), all expiries in the chain
    iv0/iv1  ATM IV of the two nearest expiries (0DTE / 1DTE); outside RTH the quotes are the last close,
             so time to expiry is measured from that close (otherwise a stale 0DTE quote looks like 2× IV)
    pvol/cvol, poi/coi  total put / call volume and open interest."""
    from greeks import implied_vol
    from exposure import mid
    gex = sum((1 if c.right == 'C' else -1) * c.g['gamma'] * c.oi * 100 * S * S * 0.01 for c in chain if c.g and 'gamma' in c.g)
    pvol = sum(c.volume for c in chain if c.right == 'P'); cvol = sum(c.volume for c in chain if c.right == 'C')
    poi = sum(c.oi for c in chain if c.right == 'P'); coi = sum(c.oi for c in chain if c.right == 'C')
    t_eff = now if _in_rth(now) else _last_rth_close(now)
    exps = sorted({c.exp for c in chain if expiry_ts(c.exp) > t_eff + 600})
    ivs = []
    for e in exps[:2]:
        T = max(600.0, expiry_ts(e) - t_eff) / YEAR
        side = [c for c in chain if c.exp == e]
        if not side:
            ivs.append(None); continue
        K = min({c.strike for c in side}, key=lambda k: abs(k - S))
        v = []
        for c in side:
            if c.strike == K:
                m = mid(c)
                iv = implied_vol(m, S, K, T, R, Q, c.right == 'C') if m else None
                if iv and 0.02 < iv < 4: v.append(iv)
        ivs.append(sum(v) / len(v) if v else None)
    while len(ivs) < 2: ivs.append(None)
    return dict(gex=gex, iv0=ivs[0], iv1=ivs[1], exp0=exps[0] if exps else None, exp1=exps[1] if len(exps) > 1 else None,
                stale=not _in_rth(now), pvol=pvol, cvol=cvol, poi=poi, coi=coi)
