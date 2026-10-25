import sys, time, random, math, os, tempfile; sys.path.insert(0, '.')
from futures import Tape, session_start
from datetime import datetime
from zoneinfo import ZoneInfo
ET = ZoneInfo('America/New_York')
random.seed(2)
t0 = datetime(2026, 10, 26, 9, 30, tzinfo=ET).timestamp()
f = os.path.join(tempfile.mkdtemp(), 'st.json')
tp = Tape(state_file=f); tp.reset(t0)
p = 30000.0; n = 0
for i in range(60 * 60 * 2 * 5):   # 2 hours, 5 trades/s
    t = t0 + i / 5
    p += random.choice([-0.25, 0, 0.25]) + 0.02 * math.sin(i / 3000)
    p = round(p * 4) / 4
    tp.on_trade(t, p, random.randint(1, 5), random.choice('AB'))
    n += 1
b1 = tp.bars('60s', 5, footprint=True)
print('1m bars', len(tp.bars('60s', 1000)), 'last', {k: b1[-1][k] for k in 'tohlcv'}, 'delta', b1[-1]['delta'], 'fp levels', len(b1[-1]['fp']))
fpv = sum(c[1] + c[2] for c in b1[-2]['fp']); print('footprint sums to volume:', fpv == b1[-2]['v'])
r = tp.bars('40R', 1000); print('40R bars', len(r), 'max range', max(x['h'] - x['l'] for x in r[:-1]))
v = tp.bars('250V', 1000); print('250V bars', len(v), 'vols', sorted({x['v'] for x in v[:-1]})[:3])
vp = tp.volume_profile('rth'); print('VP poc', vp['poc'], 'va', vp['val'], vp['vah'], 'lvn', vp['lvn'][:3])
tpo = tp.tpo_profile(); print('TPO rows', len(tpo['rows']), 'poc', tpo['poc'], 'sample', tpo['rows'][len(tpo['rows'])//2])
print('cvd', tp.summary()['cvd'], 'cvd pts', len(tp.cvd_series()))
tp.save(); print('saved KB', os.path.getsize(f) // 1024)
