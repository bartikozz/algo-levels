import math, random, sys; sys.path.insert(0, '.')
from greeks import price, implied_vol, greeks
random.seed(1)
worst = {}
for _ in range(400):
    S = random.uniform(300, 800); K = S * random.uniform(0.8, 1.2); T = random.choice([0.5/365, 1/365, 5/365, 30/365, 0.5])
    r, q, s = 0.045, 0.006, random.uniform(0.08, 0.6); c = random.random() < .5
    g = greeks(S, K, T, r, q, s, c)
    h = 1e-3 * S
    fd_delta = (price(S+h,K,T,r,q,s,c) - price(S-h,K,T,r,q,s,c)) / (2*h)
    fd_gamma = (price(S+h,K,T,r,q,s,c) - 2*price(S,K,T,r,q,s,c) + price(S-h,K,T,r,q,s,c)) / h**2
    ds = 1e-4
    dl = lambda ss: greeks(S,K,T,r,q,ss,c)['delta']
    fd_vanna = (dl(s+ds) - dl(s-ds)) / (2*ds)
    dt = min(T*0.01, 1e-5)
    fd_charm = -(greeks(S,K,T+dt,r,q,s,c)['delta'] - greeks(S,K,T-dt,r,q,s,c)['delta']) / (2*dt)
    p = price(S,K,T,r,q,s,c); iv = implied_vol(p,S,K,T,r,q,c)
    for k,a,b,tol in [('delta',g['delta'],fd_delta,1e-3),('gamma',g['gamma'],fd_gamma,max(1e-4, abs(fd_gamma)*0.02)),('vanna',g['vanna'],fd_vanna,max(1e-3,abs(fd_vanna)*0.01)),('charm',g['charm'],fd_charm,max(1e-2,abs(fd_charm)*0.02))]:
        err = abs(a-b)/tol; worst[k] = max(worst.get(k,0), err)
    if g['vega']*0.01 > 0.02 and iv is not None: worst['iv'] = max(worst.get('iv',0), abs(iv-s)/1e-3)
print({k: round(v,3) for k,v in worst.items()}, 'OK' if all(v <= 1 for v in worst.values()) else 'FAIL')
