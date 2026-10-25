"""ThetaData adapter (Theta Terminal running on the same machine).

The Theta Terminal is ThetaData's local Java gateway; it exposes an HTTP API on localhost.
Two API generations exist (v2 on port 25510, v3 on port 25503). Endpoint paths are configurable via
environment variables so they can be corrected without code changes; `python -m providers.thetadata`
probes the terminal and prints raw samples + the parsed result.

We only need, for one root (QQQ): bid/ask quote, open interest and today's volume for every contract of
every expiration. Spot is derived from ATM put-call parity (no stock subscription needed).
"""
from __future__ import annotations
import csv, io, json, math, os, sys, time
from datetime import datetime

import httpx

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from exposure import Contract, expiry_ts  # noqa: E402

BASE = os.environ.get('THETA_BASE', 'http://127.0.0.1:25503')
API = os.environ.get('THETA_API', 'v3')  # 'v3' | 'v2'
PATHS = {
    'v3': dict(quote=os.environ.get('THETA_QUOTE_PATH', '/v3/option/snapshot/quote?symbol={root}&expiration=*&format=json'),
               oi=os.environ.get('THETA_OI_PATH', '/v3/option/snapshot/open_interest?symbol={root}&expiration=*&format=json'),
               ohlc=os.environ.get('THETA_OHLC_PATH', '/v3/option/snapshot/ohlc?symbol={root}&expiration=*&format=json')),
    'v2': dict(quote=os.environ.get('THETA_QUOTE_PATH', '/v2/bulk_snapshot/option/quote?root={root}&exp=0'),
               oi=os.environ.get('THETA_OI_PATH', '/v2/bulk_snapshot/option/open_interest?root={root}&exp=0'),
               ohlc=os.environ.get('THETA_OHLC_PATH', '/v2/bulk_snapshot/option/ohlc?root={root}&exp=0')),
}


# ── flexible parsing ────────────────────────────────────────────────────────
def _norm_right(x):
    s = str(x).strip().upper()
    return 'C' if s in ('C', 'CALL', 'CALLS') else 'P' if s in ('P', 'PUT', 'PUTS') else None


def _norm_exp(x):
    s = str(x).strip()
    if len(s) == 8 and s.isdigit():
        return f'{s[:4]}-{s[4:6]}-{s[6:]}'
    return s[:10]


def _norm_strike(x):
    v = float(x)
    return v / 1000.0 if v > 20000 else v   # v2 sends strikes in 1/10 cent units


def _rows_v2(j):
    """v2: {"header": {"format": [...]}, "response": [{"ticks": [[...]], "contract": {...}}]}"""
    fmt = j['header']['format']
    for it in j.get('response', []):
        c = it.get('contract', {})
        ticks = it.get('ticks') or []
        if not ticks:
            continue
        row = dict(zip(fmt, ticks[-1]))
        row.update(root=c.get('root'), expiration=c.get('expiration'), strike=c.get('strike'), right=c.get('right'))
        yield row


def _rows_generic(payload: str):
    payload = payload.strip()
    if not payload:
        return []
    if payload[0] in '{[':
        j = json.loads(payload)
        if isinstance(j, dict) and 'header' in j and 'format' in (j.get('header') or {}):
            return list(_rows_v2(j))
        if isinstance(j, dict):
            for key in ('response', 'data', 'results'):
                if isinstance(j.get(key), list):
                    j = j[key]
                    break
        if isinstance(j, list):
            out = []
            for r in j:
                if isinstance(r, dict) and 'contract' in r and isinstance(r['contract'], dict):
                    rr = {**r, **r['contract']}
                    data = rr.get('data')
                    if isinstance(data, list) and data and isinstance(data[-1], dict):
                        rr.update(data[-1])
                    out.append(rr)
                elif isinstance(r, dict):
                    out.append(r)
            return out
        return []
    return list(csv.DictReader(io.StringIO(payload)))   # CSV with header


def _pick(r, *names, default=None):
    low = {str(k).lower(): v for k, v in r.items()}
    for n in names:
        if n in low and low[n] not in (None, ''):
            return low[n]
    return default


def _key(r):
    try:
        return (_norm_exp(_pick(r, 'expiration', 'exp', 'expiry')), _norm_strike(_pick(r, 'strike')), _norm_right(_pick(r, 'right', 'type', 'option_type')))
    except Exception:
        return None


class ThetaData:
    def __init__(self, root='QQQ', base=BASE, api=API, timeout=20.0):
        self.root, self.base, self.api = root, base.rstrip('/'), api
        self.http = httpx.Client(timeout=timeout)

    def _get(self, kind):
        url = self.base + PATHS[self.api][kind].format(root=self.root)
        r = self.http.get(url)
        r.raise_for_status()
        # v2 pagination: header.next_page
        rows = _rows_generic(r.text)
        try:
            j = r.json()
            nxt = (j.get('header') or {}).get('next_page')
            while nxt and nxt != 'null':
                r2 = self.http.get(nxt); r2.raise_for_status(); rows += _rows_generic(r2.text)
                nxt = (r2.json().get('header') or {}).get('next_page')
        except Exception:
            pass
        return rows

    def chain(self):
        quotes = self._get('quote')
        oi, vol = {}, {}
        try:
            for r in self._get('oi'):
                k = _key(r)
                if k: oi[k] = float(_pick(r, 'open_interest', 'oi', default=0) or 0)
        except Exception as e:
            print('ThetaData OI failed:', e, file=sys.stderr)
        try:
            for r in self._get('ohlc'):
                k = _key(r)
                if k: vol[k] = float(_pick(r, 'volume', 'vol', default=0) or 0)
        except Exception as e:
            print('ThetaData OHLC/volume failed:', e, file=sys.stderr)
        out = []
        for r in quotes:
            k = _key(r)
            if not k or not k[2]:
                continue
            bid = float(_pick(r, 'bid', 'bid_price', default=0) or 0)
            ask = float(_pick(r, 'ask', 'ask_price', default=0) or 0)
            out.append(Contract(k[0], k[1], k[2], bid, ask, oi.get(k, 0.0), vol.get(k, 0.0)))
        return out


def parity_spot(chain, now=None, r=0.045, q=0.006):
    """Spot from the nearest expiry's ATM call/put mids: F = K + e^{rT}(C − P), S = F e^{−(r−q)T}."""
    now = now or time.time()
    from exposure import mid
    exps = sorted({c.exp for c in chain if expiry_ts(c.exp) > now})
    for e in exps[:3]:
        pairs = {}
        for c in chain:
            if c.exp == e:
                pairs.setdefault(c.strike, {})[c.right] = c
        cands = []
        for K, p in pairs.items():
            if 'C' in p and 'P' in p:
                mc, mp = mid(p['C']), mid(p['P'])
                if mc is not None and mp is not None:
                    cands.append((abs(mc - mp), K, mc, mp))
        if len(cands) < 3:
            continue
        cands.sort()
        T = max(60.0, expiry_ts(e) - now) / (365 * 86400)
        est = [ (K + math.exp(r * T) * (mc - mp)) * math.exp(-(r - q) * T) for _, K, mc, mp in cands[:3] ]
        est.sort()
        return est[1]
    return None


if __name__ == '__main__':   # probe: python -m providers.thetadata  (run on the VPS)
    td = ThetaData(os.environ.get('THETA_ROOT', 'QQQ'))
    for kind in ('quote', 'oi', 'ohlc'):
        url = td.base + PATHS[td.api][kind].format(root=td.root)
        try:
            r = td.http.get(url)
            print(f'── {kind}: {url} → HTTP {r.status_code}, {len(r.text)} bytes')
            print(r.text[:600].replace('\n', ' ⏎ '))
        except Exception as e:
            print(f'── {kind}: {url} → {e}')
    try:
        ch = td.chain()
        print(f'parsed contracts: {len(ch)}; sample: {ch[:2]}')
        print('parity spot:', parity_spot(ch))
    except Exception as e:
        print('parse failed:', e)
