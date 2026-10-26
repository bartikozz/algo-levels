import os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from optflow import OptionFlow, _day
from providers.theta_stream import parse


def test_sides_premium_sweep():
    f = OptionFlow(min_prem=10_000)
    now = time.time(); exp = _day(now)
    kc, kp = (exp, 725.0, 'C'), (exp, 720.0, 'P')
    f.greek[kc] = (0.5, 0.2); f.greek[kp] = (-0.3, 0.22); f.spot = 724.0
    # bought calls at the ask, swept over 3 exchanges → one SWEEP order
    for ex in (1, 2, 3):
        f.on_trade(kc, now + ex * 0.05, 2.00, 100, bid=1.95, ask=2.00, exch=ex)
    # sold puts at the bid → also bullish
    f.on_trade(kp, now + 1, 1.00, 200, bid=1.00, ask=1.05, exch=4)
    f._flush(force=True)
    s = f.summary()
    assert s['call_buy'] == 2.00 * 300 * 100
    assert s['put_sell'] == 1.00 * 200 * 100
    assert s['bear'] == 0 and s['bull'] == 60_000 + 20_000 and s['bias'] == 1
    assert abs(s['delta'] - (0.5 * 300 * 100 + 0.3 * 200 * 100)) < 1e-6   # sold puts add +delta
    kinds = sorted(o['kind'] for o in f.tape(min_prem=0))
    assert kinds == ['BLOCK', 'SWEEP'], kinds
    st = {r['strike']: r for r in f.by_strike(pct=0.05)}
    assert st[725.0]['net'] == 60_000 and st[720.0]['net'] == 20_000


def test_mid_and_lean():
    f = OptionFlow()
    k = ('2030-01-17', 700.0, 'P')
    assert f.classify(k, 1.02, 1.00, 1.10)[0] == 'sell'
    assert f.classify(k, 1.05, 1.00, 1.10)[0] == 'MID'
    assert f.classify(k, 1.10, 1.00, 1.10)[0] == 'BUY'


def test_parse_v2():
    m = {"header": {"type": "TRADE", "status": "CONNECTED"},
         "contract": {"security_type": "OPTION", "root": "QQQ", "expiration": 20261026, "strike": 725000, "right": "C"},
         "trade": {"ms_of_day": 36000000, "sequence": 1, "size": 10, "condition": 18, "price": 2.15, "exchange": 5, "date": 20261026}}
    kind, key, d = parse(m)
    assert kind == 'trade' and key == ('2026-10-26', 725.0, 'C') and d['size'] == 10 and d['price'] == 2.15
