"""Futures tape engine: every NQ trade → time / range / volume bars, footprint, CVD, volume profile, TPO.

side: 'B' = buy aggressor (lifts the offer → "ask volume"), 'A' = sell aggressor (hits the bid → "bid volume").
Session = CME Globex day starting 18:00 ET; RTH = 09:30–16:00 ET.
"""
from __future__ import annotations
import json, os, threading, time
from collections import deque
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

ET = ZoneInfo('America/New_York')
TICK = 0.25


def session_start(ts: float) -> float:
    d = datetime.fromtimestamp(ts, ET)
    s = d.replace(hour=18, minute=0, second=0, microsecond=0)
    if d < s:
        s -= timedelta(days=1)
    return s.timestamp()


def is_rth(ts: float) -> bool:
    d = datetime.fromtimestamp(ts, ET)
    m = d.hour * 60 + d.minute
    return d.weekday() < 5 and 570 <= m < 960


class Bars:
    """Generic bar builder. kind: 'time' (n = seconds), 'range' (n = ticks), 'volume' (n = contracts)."""

    def __init__(self, kind: str, n: float, keep: int = 3000, fp_step: float | None = None):
        self.kind, self.n, self.fp_step = kind, n, fp_step
        self.bars: deque = deque(maxlen=keep)
        self.cur = None

    def _new(self, t, p):
        b = dict(t=t, o=p, h=p, l=p, c=p, v=0, buy=0, sell=0)
        if self.fp_step:
            b['fp'] = {}
        return b

    def add(self, t, p, size, side):
        if self.kind == 'time':
            bt = int(t // self.n * self.n)
            if self.cur is None or bt != self.cur['t']:
                if self.cur is not None:
                    self.bars.append(self.cur)
                self.cur = self._new(bt, p)
        elif self.cur is None:
            self.cur = self._new(int(t), p)
        b = self.cur
        if self.kind == 'range' and (max(b['h'], p) - min(b['l'], p)) > self.n * TICK + 1e-9:
            # close the bar at its range limit, open a new one with this trade
            self.bars.append(b)
            b = self.cur = self._new(int(t), p)
        b['h'] = max(b['h'], p); b['l'] = min(b['l'], p); b['c'] = p; b['v'] += size
        if side == 'B':
            b['buy'] += size
        elif side == 'A':
            b['sell'] += size
        if self.fp_step:
            k = round(p / self.fp_step) * self.fp_step
            cell = b['fp'].setdefault(k, [0, 0])    # [bid volume (sells), ask volume (buys)]
            cell[0 if side == 'A' else 1] += size if side in ('A', 'B') else 0
        if self.kind == 'volume' and b['v'] >= self.n:
            self.bars.append(b)
            self.cur = None

    def tail(self, n=500):
        out = list(self.bars)[-n:]
        if self.cur is not None:
            out.append(self.cur)
        return out


class Tape:
    TIME = (1, 5, 15, 30, 60, 300)
    RANGE = (16, 40, 80)       # ticks (4 / 10 / 20 NQ points)
    VOLUME = (250, 600, 1500)  # contracts

    def __init__(self, fp_step: float = 1.0, prof_step: float = 5.0, state_file: str | None = None):
        self.lock = threading.Lock()
        self.fp_step, self.prof_step, self.state_file = fp_step, prof_step, state_file
        self.reset(time.time())
        self.last_ts = 0.0
        self.trades = 0

    def reset(self, ts):
        self.sess = session_start(ts)
        self.series = {f'{s}s': Bars('time', s, fp_step=self.fp_step if s in (60, 300) else None) for s in self.TIME}
        self.series.update({f'{r}R': Bars('range', r) for r in self.RANGE})
        self.series.update({f'{v}V': Bars('volume', v) for v in self.VOLUME})
        self.cvd = 0.0
        self.cvd_pts: deque = deque(maxlen=6000)   # (minute, cvd)
        self.profile = {'eth': {}, 'rth': {}}       # bucket → [bid vol, ask vol]
        self.tpo = {}                               # bucket → set(period letters)
        self.last = None

    def on_trade(self, ts: float, price: float, size: float, side: str):
        with self.lock:
            if ts - self.sess >= 86400 or ts < self.sess:
                if ts >= self.sess + 86400:
                    self.reset(ts)
            self.trades += 1
            self.last_ts, self.last = ts, price
            for b in self.series.values():
                b.add(ts, price, size, side)
            if side == 'B':
                self.cvd += size
            elif side == 'A':
                self.cvd -= size
            m = int(ts // 60 * 60)
            if not self.cvd_pts or self.cvd_pts[-1][0] != m:
                self.cvd_pts.append([m, self.cvd])
            else:
                self.cvd_pts[-1][1] = self.cvd
            k = round(price / self.prof_step) * self.prof_step
            prof = self.profile['rth' if is_rth(ts) else 'eth']
            cell = prof.setdefault(k, [0, 0])
            if side in ('A', 'B'):
                cell[0 if side == 'A' else 1] += size
            if is_rth(ts):
                d = datetime.fromtimestamp(ts, ET)
                period = (d.hour * 60 + d.minute - 570) // 30            # 0 = A (09:30–10:00) …
                self.tpo.setdefault(k, set()).add(chr(ord('A') + period))

    # ── views ───────────────────────────────────────────────────────────────
    def bars(self, key='60s', n=500, footprint=False):
        with self.lock:
            out = []
            for b in self.series[key].tail(n):
                x = {k: v for k, v in b.items() if k != 'fp'}
                x['delta'] = b['buy'] - b['sell']
                if footprint and 'fp' in b:
                    x['fp'] = [[p, v[0], v[1]] for p, v in sorted(b['fp'].items())]
                out.append(x)
            return out

    def volume_profile(self, which='rth'):
        with self.lock:
            prof = dict(self.profile[which]) if which != 'all' else self._merged()
        rows = sorted(prof.items())
        if not rows:
            return dict(rows=[], poc=None, vah=None, val=None, lvn=[], hvn=[])
        vols = [b + a for _, (b, a) in rows]
        tot = sum(vols)
        pi = max(range(len(rows)), key=lambda i: vols[i])
        lo = hi = pi; acc = vols[pi]
        while acc < 0.7 * tot and (lo > 0 or hi < len(rows) - 1):
            up = vols[hi + 1] if hi < len(rows) - 1 else -1
            dn = vols[lo - 1] if lo > 0 else -1
            if up >= dn: hi += 1; acc += up
            else: lo -= 1; acc += dn
        sm = [sum(vols[max(0, i - 2):i + 3]) / len(vols[max(0, i - 2):i + 3]) for i in range(len(vols))]
        peak = max(sm) or 1
        lvn, hvn = [], []
        for i in range(3, len(sm) - 3):
            L, R = max(sm[max(0, i - 8):i]), max(sm[i + 1:i + 9])
            if sm[i] <= sm[i - 1] and sm[i] <= sm[i + 1] and sm[i] < 0.55 * min(L, R) and min(L, R) > 0.15 * peak:
                lvn.append(rows[i][0])
            if sm[i] >= sm[i - 1] and sm[i] >= sm[i + 1] and sm[i] >= 0.6 * peak:
                hvn.append(rows[i][0])
        return dict(rows=[[p, b, a] for p, (b, a) in rows], poc=rows[pi][0], vah=rows[hi][0], val=rows[lo][0], lvn=lvn, hvn=hvn, step=self.prof_step)

    def _merged(self):
        m = {}
        for prof in self.profile.values():
            for k, (b, a) in prof.items():
                c = m.setdefault(k, [0, 0]); c[0] += b; c[1] += a
        return m

    def tpo_profile(self):
        with self.lock:
            rows = sorted((k, ''.join(sorted(v))) for k, v in self.tpo.items())
        if not rows:
            return dict(rows=[], poc=None)
        poc = max(rows, key=lambda r: len(r[1]))[0]
        return dict(rows=rows, poc=poc, step=self.prof_step)

    def summary(self):
        with self.lock:
            return dict(last=self.last, ts=self.last_ts, cvd=self.cvd, trades=self.trades, session=self.sess)

    def cvd_series(self, n=1500):
        with self.lock:
            return list(self.cvd_pts)[-n:]

    # ── persistence (survive restarts within a session) ─────────────────────
    def save(self):
        if not self.state_file:
            return
        with self.lock:
            st = dict(sess=self.sess, cvd=self.cvd, cvd_pts=list(self.cvd_pts),
                      profile={w: {str(k): v for k, v in p.items()} for w, p in self.profile.items()},
                      tpo={str(k): sorted(v) for k, v in self.tpo.items()},
                      series={k: dict(bars=[{**b, **({'fp': {str(p): v for p, v in b['fp'].items()}} if 'fp' in b else {})} for b in s.bars],
                                      cur=None) for k, s in self.series.items()})
        tmp = self.state_file + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(st, f)
        os.replace(tmp, self.state_file)

    def load(self):
        if not self.state_file or not os.path.exists(self.state_file):
            return False
        with open(self.state_file) as f:
            st = json.load(f)
        if st.get('sess') != session_start(time.time()):
            return False
        with self.lock:
            self.cvd = st['cvd']; self.cvd_pts = deque(st['cvd_pts'], maxlen=6000)
            self.profile = {w: {float(k): v for k, v in p.items()} for w, p in st['profile'].items()}
            self.tpo = {float(k): set(v) for k, v in st['tpo'].items()}
            for k, s in st['series'].items():
                if k in self.series:
                    for b in s['bars']:
                        if 'fp' in b:
                            b['fp'] = {float(p): v for p, v in b['fp'].items()}
                        self.series[k].bars.append(b)
        return True


class DatabentoFeed(threading.Thread):
    """Live NQ trades from Databento (CME Globex MDP 3.0). Replays the current session on (re)connect."""

    def __init__(self, tape: Tape, key: str, symbol: str = 'NQ.v.0'):
        super().__init__(daemon=True)
        self.tape, self.key, self.symbol = tape, key, symbol
        self.status = 'starting'
        self.err = None

    def run(self):
        import databento as db
        while True:
            try:
                start = max(self.tape.last_ts + 1e-3, self.tape.sess) if self.tape.last_ts else self.tape.sess
                client = db.Live(key=self.key, reconnect_policy='reconnect')
                client.subscribe(dataset='GLBX.MDP3', schema='trades', symbols=[self.symbol], stype_in='continuous',
                                 start=datetime.fromtimestamp(start).astimezone().isoformat())
                self.status = 'live'
                for rec in client:
                    if type(rec).__name__ != 'TradeMsg':
                        continue
                    sv = getattr(rec.side, 'value', rec.side)
                    side = sv if sv in ('A', 'B') else (chr(sv) if isinstance(sv, int) else 'N')
                    self.tape.on_trade(rec.ts_event / 1e9, rec.price / 1e9, rec.size, side)
            except Exception as e:  # keep the service alive; retry after a pause
                self.status, self.err = 'error', str(e)
                time.sleep(5)
