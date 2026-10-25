import sys, time; sys.path.insert(0, '.'); sys.path.insert(0, 'tests')
from synth import synth_chain
from exposure import snapshot
now = time.time(); S = 725.0
ch = synth_chain(S, now)
t = time.time(); snap = snapshot(ch, S, now, k_nq=41.4); dt = time.time() - t
print('contracts', len(ch), 'time %.2fs' % dt)
print('levels ALL', snap['levels']['ALL'])
print('iv peaks', snap['iv_peaks']['hi'], snap['iv_peaks']['lo'], len(snap['iv_peaks']['walls']))
L = snap['landscape']; print('flip', L['flip'] and round(L['flip'],2), 'peak', L['peak'] and round(L['peak'],2), 'ceil', L['ceiling'], 'floor', L['floor'], 'dead', L['dead_zone'], L['regime'])
print('em0', snap['em0'], 'atm iv', snap['atm_iv'] and round(snap['atm_iv'],3), 'buckets', list(snap['buckets']))
ok = 740 in snap['levels']['ALL']['call_walls'][:1] and 710 in snap['levels']['ALL']['put_walls'][:1] and snap['iv_peaks']['hi'] and abs(snap['iv_peaks']['hi']['strike'] - 731) <= 1 and abs(snap['atm_iv'] - 0.2) < 0.01
print('OK' if ok else 'FAIL')
