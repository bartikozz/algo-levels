"""ThetaData live stream (Theta Terminal websocket) → OptionFlow.

Options Standard allows per-contract trade streams (up to 15 000 contracts); Options Pro adds the bulk
"every trade" stream. Mode via env:
  THETA_STREAM_MODE = contracts (default) | bulk
  THETA_WS          = ws://127.0.0.1:25520/v1/events       (v2 terminal stream endpoint)
  STREAM_DAYS = 7, STREAM_PCT = 0.06, STREAM_MAX = 3000      (which contracts to follow in 'contracts' mode)
  THETA_STREAM_QUOTES = 1                                     (also stream NBBO quotes for the same contracts)

The message format is parsed flexibly (v2: {"header":{"type":"TRADE"},"contract":{...},"trade":{...}}).
Run `python -m providers.theta_stream` on the VPS to print the first raw messages.
"""
from __future__ import annotations
import asyncio, json, os, sys, threading, time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from exposure import expiry_ts  # noqa: E402

ET = ZoneInfo('America/New_York')
WS = os.environ.get('THETA_WS', 'ws://127.0.0.1:25520/v1/events')
MODE = os.environ.get('THETA_STREAM_MODE', 'contracts')
DAYS = float(os.environ.get('STREAM_DAYS', '7'))
PCT = float(os.environ.get('STREAM_PCT', '0.06'))
MAX = int(os.environ.get('STREAM_MAX', '3000'))
QUOTES = os.environ.get('THETA_STREAM_QUOTES', '1') == '1'


def _exp_int(e: str) -> int:
    return int(e.replace('-', ''))


def _exp_str(x) -> str:
    s = str(x)
    return f'{s[:4]}-{s[4:6]}-{s[6:8]}' if len(s) == 8 and s.isdigit() else s[:10]


def _strike(x) -> float:
    v = float(x)
    return v / 1000.0 if v > 20000 else v


def _ts(d: dict) -> float:
    date, ms = d.get('date'), d.get('ms_of_day')
    if date and ms is not None:
        s = str(date)
        base = datetime(int(s[:4]), int(s[4:6]), int(s[6:8]), tzinfo=ET)
        return (base + timedelta(milliseconds=int(ms))).timestamp()
    for k in ('timestamp', 'ts', 'time'):
        if k in d:
            v = float(d[k]); return v / 1000 if v > 1e12 else v
    return time.time()


def parse(msg: dict):
    """→ ('trade'|'quote', key, payload) or None"""
    h = msg.get('header') or {}
    typ = str(h.get('type') or msg.get('type') or '').upper()
    c = msg.get('contract') or {}
    if not c or not typ:
        return None
    try:
        key = (_exp_str(c.get('expiration')), _strike(c.get('strike')), str(c.get('right', '')).upper()[:1])
    except Exception:
        return None
    if key[2] not in ('C', 'P'):
        return None
    if typ == 'TRADE' and isinstance(msg.get('trade'), dict):
        t = msg['trade']; q = msg.get('quote') if isinstance(msg.get('quote'), dict) else {}
        return 'trade', key, dict(ts=_ts(t), price=float(t.get('price') or 0), size=float(t.get('size') or 0),
                                  exch=t.get('exchange'), cond=t.get('condition'),
                                  bid=float(q['bid']) if q.get('bid') else None, ask=float(q['ask']) if q.get('ask') else None)
    if typ == 'QUOTE' and isinstance(msg.get('quote'), dict):
        q = msg['quote']
        return 'quote', key, dict(ts=_ts(q), bid=float(q.get('bid') or 0), ask=float(q.get('ask') or 0))
    return None


class ThetaStream(threading.Thread):
    def __init__(self, flow, root='QQQ', get_chain=None):
        super().__init__(daemon=True)
        self.flow, self.root, self.get_chain = flow, root, get_chain
        self.status, self.err, self.subs, self.msgs = 'starting', None, set(), 0
        self.last_msg = 0.0

    def select(self):
        """contracts to follow: expirations ≤ DAYS, strikes within ±PCT of spot, nearest-to-spot first, capped at MAX"""
        chain, S = self.get_chain() if self.get_chain else (None, None)
        if not chain or not S:
            return []
        now = time.time()
        cs = [c for c in chain if 0 < expiry_ts(c.exp) - now <= DAYS * 86400 + 3600 and abs(c.strike / S - 1) <= PCT]
        cs.sort(key=lambda c: (expiry_ts(c.exp), abs(c.strike - S)))
        return [(c.exp, c.strike, c.right) for c in cs[:MAX]]

    def _req(self, kind, key=None, add=True, rid=0):
        r = dict(msg_type='STREAM' if key else 'STREAM_BULK', sec_type='OPTION', req_type=kind, add=add, id=rid)
        if key:
            r['contract'] = dict(root=self.root, expiration=_exp_int(key[0]), strike=int(round(key[1] * 1000)), right=key[2])
        return json.dumps(r)

    async def _run(self):
        import websockets
        async with websockets.connect(WS, max_size=None, ping_interval=20) as ws:
            self.status, self.subs = 'connected', set()
            rid = 0

            async def sync():
                nonlocal rid
                if MODE == 'bulk':
                    if not self.subs:
                        await ws.send(self._req('TRADE')); self.subs.add('bulk')
                        if QUOTES: await ws.send(self._req('QUOTE'))
                    return
                want = set(self.select())
                for k in sorted(want - self.subs):
                    rid += 1; await ws.send(self._req('TRADE', k, True, rid))
                    if QUOTES: rid += 1; await ws.send(self._req('QUOTE', k, True, rid))
                    self.subs.add(k); await asyncio.sleep(0.002)
                for k in list(self.subs - want):
                    rid += 1; await ws.send(self._req('TRADE', k, False, rid))
                    if QUOTES: rid += 1; await ws.send(self._req('QUOTE', k, False, rid))
                    self.subs.discard(k)

            await sync()
            self.status = f'live ({len(self.subs)} contracts)' if MODE != 'bulk' else 'live (bulk)'
            last_sync = time.time()
            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=5)
                except asyncio.TimeoutError:
                    raw = None
                if raw:
                    self.msgs += 1; self.last_msg = time.time()
                    try:
                        p = parse(json.loads(raw))
                    except Exception:
                        p = None
                    if p:
                        kind, key, d = p
                        if kind == 'trade':
                            self.flow.on_trade(key, d['ts'], d['price'], d['size'], d['bid'], d['ask'], d['exch'], d['cond'])
                        else:
                            self.flow.on_quote(key, d['bid'], d['ask'], d['ts'])
                if time.time() - last_sync > 120:      # follow the spot / roll expirations
                    await sync(); last_sync = time.time()
                    self.status = f'live ({len(self.subs)} contracts)' if MODE != 'bulk' else 'live (bulk)'

    def run(self):
        while True:
            try:
                while self.get_chain and not self.get_chain()[0]:
                    self.status = 'waiting for chain'; time.sleep(3)
                asyncio.run(self._run())
            except Exception as e:
                self.status, self.err = 'error', f'{type(e).__name__}: {e}'
                time.sleep(5)


if __name__ == '__main__':     # probe: python -m providers.theta_stream   (prints the first raw stream messages)
    import websockets

    async def probe():
        from providers.thetadata import ThetaData, parity_spot
        ch = ThetaData(os.environ.get('THETA_ROOT', 'QQQ')).chain(); S = parity_spot(ch)
        print('chain', len(ch), 'spot', S)
        near = sorted([c for c in ch if abs(c.strike - (S or 0)) < 3], key=lambda c: (expiry_ts(c.exp), abs(c.strike - S)))[:4]
        st = ThetaStream(None, os.environ.get('THETA_ROOT', 'QQQ'))
        async with websockets.connect(WS, max_size=None) as ws:
            for i, c in enumerate(near):
                await ws.send(st._req('TRADE', (c.exp, c.strike, c.right), True, i + 1))
                await ws.send(st._req('QUOTE', (c.exp, c.strike, c.right), True, 100 + i))
            print('subscribed', [(c.exp, c.strike, c.right) for c in near])
            t0 = time.time()
            while time.time() - t0 < 30:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=30)
                except asyncio.TimeoutError:
                    break
                print(raw[:400]); print('  → parsed:', parse(json.loads(raw)) if raw.startswith('{') else None)
    asyncio.run(probe())
