import math, random, sys, time; sys.path.insert(0, '.')
from datetime import datetime, timedelta
from exposure import Contract, ET, expiry_ts
from greeks import price
def synth_chain(S=725.0, now=None, bump=731.0, seed=3):
    random.seed(seed); now = now or time.time()
    d0 = datetime.fromtimestamp(now, ET).date()
    exps = []; d = d0
    while len(exps) < 12:
        if d.weekday() < 5: exps.append(d.isoformat())
        d += timedelta(days=1)
    exps += [(d0 + timedelta(days=x)).isoformat() for x in (30, 58)]
    chain = []
    for e in exps:
        T = max(60, expiry_ts(e) - now) / (365 * 86400)
        for K in range(int(S * 0.9), int(S * 1.1) + 1):
            k = math.log(K / S)
            iv = 0.20 - 0.35 * k + 1.2 * k * k
            if e == exps[0] and abs(K - bump) < 0.5: iv += 0.03          # hidden IV wall
            for right in 'CP':
                p = price(S, K, T, 0.045, 0.006, iv, right == 'C')
                spr = max(0.01, p * 0.03)
                oi = 2000 * math.exp(-((K - S) / 15) ** 2) + (25000 if (K == 740 and right == 'C') else 0) + (30000 if (K == 710 and right == 'P') else 0)
                chain.append(Contract(e, float(K), right, max(0, p - spr / 2), p + spr / 2, oi, oi * 0.3 * random.random()))
    return chain
