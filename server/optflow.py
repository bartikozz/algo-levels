"""Options flow engine: every QQQ option trade → aggressor side, premium, delta, sweeps / blocks, and the
day's aggregates (bullish vs bearish premium, net delta, flow by strike, a tape of large orders).

Side (aggressor) from the NBBO at the time of the trade:
  price ≥ ask        → 'BUY'   (lifted the offer)       sign +1
  price ≤ bid        → 'SELL'  (hit the bid)            sign −1
  above / below mid  → 'buy' / 'sell' (leaning)         sign ±0.5
  at mid / no quote  → 'MID'                            sign  0
Bullish premium: bought calls and sold puts are bullish, sold calls and bought puts are bearish.
Delta flow (shares): sign × delta × size × 100 → what the customer added in delta (dealers hold the opposite).

Orders: prints of the same contract and side within SWEEP_MS are merged into one order. An order filled on
≥ 2 exchanges is a SWEEP (urgent, takes liquidity everywhere); a single print ≥ BLOCK_SIZE contracts is a BLOCK.
"""
from __future__ import annotations
import json, os, threading, time
from collections import deque
from datetime import datetime
from zoneinfo import ZoneInfo

ET = ZoneInfo('America/New_York')
SWEEP_MS = 350
BLOCK_SIZE = 200


def _day(ts):
    return datetime.fromtimestamp(ts, ET).strftime('%Y-%m-%d')


class OptionFlow:
    def __init__(self, min_prem: float = 25_000, state_file: str | None = None):
        self.lock = threading.Lock()
        self.min_prem, self.state_file = min_prem, state_file
        self.book: dict = {}      # key → (bid, ask, ts)
        self.greek: dict = {}     # key → (delta, iv)
        self.spot = None
        self.today = None
        self._reset(time.time())

    def _reset(self, ts):
        self.today = _day(ts)
        self.tot = dict(call_buy=0.0, call_sell=0.0, put_buy=0.0, put_sell=0.0, mid=0.0, delta=0.0, trades=0, contracts=0,
                        bull=0.0, bear=0.0, bull_0d=0.0, bear_0d=0.0, sweeps=0, blocks=0)
        self.minutes: dict = {}   # minute → [bull prem, bear prem, delta shares, contracts]
        self.strikes: dict = {}   # (strike, right, is0d) → [bull prem, bear prem, contracts, delta]
        self.orders: deque = deque(maxlen=1500)
        self.pending: dict = {}   # (key, side) → open order being aggregated

    # ── reference data ──────────────────────────────────────────────────────
    def set_chain(self, chain, S):
        """chain = enriched Contracts (greeks solved): refreshes quotes (fallback when no live quote) and deltas."""
        now = time.time()
        with self.lock:
            self.spot = S
            for c in chain:
                k = (c.exp, c.strike, c.right)
                q = self.book.get(k)
                if not q or now - q[2] > 60:           # live quotes win over the 30 s snapshot
                    self.book[k] = (c.bid, c.ask, now)
                d = (c.g or {}).get('delta')
                if d is not None:
                    self.greek[k] = (d, c.iv)

    def on_quote(self, key, bid, ask, ts=None):
        if bid is None or ask is None:
            return
        self.book[key] = (bid, ask, ts or time.time())

    # ── trades ──────────────────────────────────────────────────────────────
    def classify(self, key, price, bid=None, ask=None):
        if bid is None or ask is None:
            q = self.book.get(key)
            if q:
                bid, ask = q[0], q[1]
        if not bid and not ask:
            return 'MID', 0.0
        eps = 1e-6
        if ask and price >= ask - eps:
            return 'BUY', 1.0
        if bid is not None and price <= bid + eps:
            return 'SELL', -1.0
        m = ((bid or 0) + ask) / 2 if ask else None
        if m is None or abs(price - m) < 0.005:
            return 'MID', 0.0
        return ('buy', 0.5) if price > m else ('sell', -0.5)

    def on_trade(self, key, ts, price, size, bid=None, ask=None, exch=None, cond=None):
        """key = (exp 'YYYY-MM-DD', strike, 'C'|'P'); ts = epoch seconds; price per share; size in contracts."""
        if not price or not size or price <= 0:
            return
        with self.lock:
            if _day(ts) != self.today:
                self._flush(force=True)
                self._reset(ts)
            side, sign = self.classify(key, price, bid, ask)
            exp, K, right = key
            d = (self.greek.get(key) or (None, None))[0]
            if d is None:   # rough fallback before the first chain snapshot: ATM 0.5, decays with distance
                S = self.spot or K
                m = (S - K) / max(S, 1) * (1 if right == 'C' else -1)
                d = max(0.02, min(0.98, 0.5 + m * 25)) * (1 if right == 'C' else -1)
            prem = price * size * 100
            bull = sign * prem if right == 'C' else -sign * prem
            dsh = sign * d * size * 100
            is0d = exp == self.today
            T = self.tot
            T['trades'] += 1; T['contracts'] += size; T['delta'] += dsh
            if side == 'MID': T['mid'] += prem
            elif right == 'C': T['call_buy' if sign > 0 else 'call_sell'] += prem
            else: T['put_buy' if sign > 0 else 'put_sell'] += prem
            if bull > 0: T['bull'] += bull; T['bull_0d'] += bull if is0d else 0
            elif bull < 0: T['bear'] -= bull; T['bear_0d'] -= bull if is0d else 0
            mi = int(ts // 60 * 60)
            row = self.minutes.setdefault(mi, [0.0, 0.0, 0.0, 0])
            if bull > 0: row[0] += bull
            elif bull < 0: row[1] -= bull
            row[2] += dsh; row[3] += size
            sr = self.strikes.setdefault((K, right, is0d), [0.0, 0.0, 0, 0.0])
            if bull > 0: sr[0] += bull
            elif bull < 0: sr[1] -= bull
            sr[2] += size; sr[3] += dsh
            # order aggregation (sweeps)
            pk = (key, side)
            o = self.pending.get(pk)
            if o and (ts - o['t_last']) * 1000 <= SWEEP_MS:
                o['size'] += size; o['prem'] += prem; o['bull'] += bull; o['dsh'] += dsh; o['prints'] += 1
                o['px_hi'] = max(o['px_hi'], price); o['px_lo'] = min(o['px_lo'], price); o['t_last'] = ts
                if exch is not None: o['ex'].add(exch)
            else:
                if o: self._close(pk)
                self.pending[pk] = dict(t=ts, t_last=ts, exp=exp, strike=K, right=right, side=side, size=size, prem=prem, bull=bull, dsh=dsh,
                                        prints=1, px_lo=price, px_hi=price, ex=set([exch]) if exch is not None else set(), d=d, is0d=is0d,
                                        iv=(self.greek.get(key) or (None, None))[1])
            self._flush()

    def _close(self, pk):
        o = self.pending.pop(pk)
        sweep = len(o['ex']) >= 2 or (not o['ex'] and o['prints'] >= 3)
        block = o['prints'] == 1 and o['size'] >= BLOCK_SIZE
        o['kind'] = 'SWEEP' if sweep else 'BLOCK' if block else 'ORDER'
        if sweep: self.tot['sweeps'] += 1
        if block: self.tot['blocks'] += 1
        if o['prem'] >= self.min_prem or sweep and o['prem'] >= self.min_prem / 2:
            o['ex'] = len(o['ex']); o['px'] = round(o['prem'] / o['size'] / 100, 4)
            self.orders.append(o)

    def _flush(self, force=False):
        now = time.time()
        for pk in [pk for pk, o in self.pending.items() if force or (now - o['t_last']) * 1000 > SWEEP_MS * 3]:
            self._close(pk)

    # ── views ───────────────────────────────────────────────────────────────
    def summary(self):
        with self.lock:
            self._flush()
            T = dict(self.tot)
        cp = T['call_buy'] + T['call_sell']; pp = T['put_buy'] + T['put_sell']
        T['pc_prem'] = pp / cp if cp else None
        T['net'] = T['bull'] - T['bear']
        T['net_0d'] = T['bull_0d'] - T['bear_0d']
        T['bias'] = T['net'] / (T['bull'] + T['bear']) if (T['bull'] + T['bear']) else 0.0   # −1 … +1
        T['day'] = self.today; T['spot'] = self.spot
        return T

    def series(self):
        with self.lock:
            rows = sorted(self.minutes.items())
        out, cb, cr, cd = [], 0.0, 0.0, 0.0
        for t, (b, r, d, n) in rows:
            cb += b; cr += r; cd += d
            out.append([t, round(cb), round(cr), round(cd), n])
        return out

    def by_strike(self, pct=0.04, only0d=False):
        S = self.spot
        with self.lock:
            items = list(self.strikes.items())
        agg = {}
        for (K, right, is0d), (b, r, n, d) in items:
            if only0d and not is0d: continue
            if S and abs(K / S - 1) > pct: continue
            a = agg.setdefault(K, dict(strike=K, call_bull=0.0, call_bear=0.0, put_bull=0.0, put_bear=0.0, contracts=0, delta=0.0))
            if right == 'C': a['call_bull'] += b; a['call_bear'] += r
            else: a['put_bull'] += b; a['put_bear'] += r
            a['contracts'] += n; a['delta'] += d
        out = sorted(agg.values(), key=lambda x: x['strike'])
        for a in out:
            a['net'] = a['call_bull'] + a['put_bull'] - a['call_bear'] - a['put_bear']
        return out

    def tape(self, n=200, min_prem=None, only0d=False, kind=None):
        with self.lock:
            self._flush()
            os_ = list(self.orders)
        m = min_prem if min_prem is not None else self.min_prem
        os_ = [o for o in os_ if o['prem'] >= m and (not only0d or o['is0d']) and (not kind or o['kind'] == kind)]
        return [{k: v for k, v in o.items() if k not in ('t_last',)} for o in os_[-n:]][::-1]

    def flow_levels(self, n=2):
        """Strikes with the most one-sided premium today (0DTE + 1DTE weighted) → candidate levels."""
        rows = self.by_strike(pct=0.03)
        if not rows: return []
        tot = sum(abs(r['net']) for r in rows) or 1
        top = sorted(rows, key=lambda r: -abs(r['net']))[:n]
        return [dict(strike=r['strike'], net=r['net'], share=abs(r['net']) / tot) for r in top if abs(r['net']) / tot > 0.08]

    # ── persistence ─────────────────────────────────────────────────────────
    def save(self):
        if not self.state_file: return
        with self.lock:
            st = dict(today=self.today, tot=self.tot, minutes={str(k): v for k, v in self.minutes.items()},
                      strikes=[[list(k), v] for k, v in self.strikes.items()],
                      orders=[{**o, 'ex': o['ex'] if isinstance(o['ex'], int) else len(o['ex'])} for o in self.orders])
        tmp = self.state_file + '.tmp'
        with open(tmp, 'w') as f: json.dump(st, f)
        os.replace(tmp, self.state_file)

    def load(self):
        if not self.state_file or not os.path.exists(self.state_file): return False
        with open(self.state_file) as f: st = json.load(f)
        if st.get('today') != _day(time.time()): return False
        with self.lock:
            self.today, self.tot = st['today'], st['tot']
            self.minutes = {int(k): v for k, v in st['minutes'].items()}
            self.strikes = {tuple(k): v for k, v in st['strikes']}
            self.orders = deque(st['orders'], maxlen=1500)
        return True
