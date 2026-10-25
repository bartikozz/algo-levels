/* Backtest of the fade setups on NQ intraday bars (Yahoo 5m ≈ 60 days, 1h ≈ 2 years).
 * Rules per setup and day: limit fade at the entry band (short above / long below the anchor),
 * one trade per side per day, stop/target in the same units, flat at the RTH close.
 * Conservative fills: if stop and target are both inside one bar after entry → stop; the entry bar
 * itself can only stop out. Costs: costPts NQ points per round trip, charged in R.
 * window.Backtest = { SETUPS, run }
 */
(function (root) {
  'use strict';
  const SETUPS = [
    { id: 'em05', name: 'EM ±½ → Ref', unit: 'em', entry: 0.5, stop: 1.0, target: 0, color: '#5ee0c8' },
    { id: 'em1', name: 'EM ±1 → ±½', unit: 'em', entry: 1.0, stop: 1.5, target: 0.5, color: '#c9a66b' },
    { id: 'em1r', name: 'EM ±1 → Ref', unit: 'em', entry: 1.0, stop: 1.5, target: 0, color: '#e6e8eb' },
    { id: 'em15', name: 'EM ±1.5 → ±1', unit: 'em', entry: 1.5, stop: 2.0, target: 1.0, color: '#ff5fa2' },
    { id: 'sig1', name: 'σ ±1 → ±½', unit: 'sig', entry: 1.0, stop: 1.5, target: 0.5, color: '#8ab4ff' },
  ];

  /** run({ bars, vix:[daily], daily:[NQ daily], A (AlgoLevels), costPts, emMult }) → { days, results:[{setup, trades, stats, pts}] } */
  function run(o) {
    const A = o.A, cost = o.costPts == null ? 1 : o.costPts, mult = o.emMult == null ? 0.8 : o.emMult;
    const bars = (o.bars || []).filter(b => [b.o, b.h, b.l, b.c].every(Number.isFinite));
    const vix = (o.vix || []).map(b => ({ d: A.et(b.t).date, c: b.c })).sort((a, b) => a.d < b.d ? -1 : 1);
    const daily = (o.daily || []).map(b => ({ d: A.et(b.t).date, c: b.c })).sort((a, b) => a.d < b.d ? -1 : 1);
    const vixBefore = d => { let v = null; for (const x of vix) { if (x.d < d) v = x.c; else break; } return v; };
    const sigmaBefore = d => { // 20-day stdev of daily log returns before d
      const prev = daily.filter(x => x.d < d).slice(-21); if (prev.length < 21) return null;
      const r = prev.slice(1).map((x, i) => Math.log(x.c / prev[i].c)), m = r.reduce((s, x) => s + x, 0) / r.length;
      return Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / r.length);
    };
    // group by Globex trading date
    const byDay = new Map();
    for (const b of bars) { const d = A.tdate(b.t); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(b); }
    const sessions = [];
    for (const [d, bs] of byDay) {
      const rth = bs.filter(b => { const e = A.et(b.t); return e.min >= 570 && e.min < 960; });
      if (rth.length < 4) continue;
      const ref = rth[0].o, globOpen = bs[0].o, v = vixBefore(A.et(rth[0].t).date), sd = sigmaBefore(A.et(rth[0].t).date);
      if (!v) continue;
      sessions.push({ d, rth, ref, globOpen, em: ref * v / 100 / Math.sqrt(252) * mult, sig: sd ? globOpen * sd : null });
    }
    sessions.sort((a, b) => a.d < b.d ? -1 : 1);

    const results = SETUPS.map(S => {
      const trades = [];
      for (const s of sessions) {
        const u = S.unit === 'em' ? s.em : s.sig, anc = S.unit === 'em' ? s.ref : s.globOpen;
        if (!u) continue;
        for (const side of [-1, 1]) {   // -1 = short above, +1 = long below
          const E = anc - side * S.entry * u, ST = anc - side * S.stop * u, TG = anc - side * S.target * u, risk = Math.abs(ST - E);
          if (!(risk >= 5)) continue;   // degenerate band (bad vol data)
          let fill = null, i0 = -1;
          for (let i = 0; i < s.rth.length; i++) {
            const b = s.rth[i];
            const touched = side < 0 ? b.h >= E : b.l <= E;
            if (!touched) continue;
            if (side < 0 ? b.o >= ST : b.o <= ST) break;          // gapped through the stop: no trade
            fill = side < 0 ? Math.max(E, b.o) : Math.min(E, b.o); i0 = i; break;
          }
          if (fill == null) continue;
          let exit = null, how = 'close', te = s.rth[s.rth.length - 1].t;
          const b0 = s.rth[i0];
          if (side < 0 ? b0.h >= ST : b0.l <= ST) { exit = ST; how = 'stop'; te = b0.t; }
          for (let j = i0 + 1; exit == null && j < s.rth.length; j++) {
            const b = s.rth[j];
            const hitS = side < 0 ? b.h >= ST : b.l <= ST, hitT = side < 0 ? b.l <= TG : b.h >= TG;
            if (hitS) { exit = ST; how = 'stop'; te = b.t; } else if (hitT) { exit = TG; how = 'target'; te = b.t; }
          }
          if (exit == null) exit = s.rth[s.rth.length - 1].c;
          const R = (side < 0 ? fill - exit : exit - fill) / risk - cost / risk;
          trades.push({ d: s.d, t: te, side: side < 0 ? 'short' : 'long', fill, exit, how, R });
        }
      }
      trades.sort((a, b) => a.t - b.t);
      let cum = 0, peak = 0, dd = 0, win = 0, gw = 0, gl = 0;
      const pts = [], years = {};
      for (const t of trades) {
        cum += t.R; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak);
        if (t.R > 0) { win++; gw += t.R; } else gl -= t.R;
        pts.push({ t: t.t, v: cum });
        const y = t.d.slice(0, 4); (years[y] = years[y] || { n: 0, R: 0 }); years[y].n++; years[y].R += t.R;
      }
      const n = trades.length;
      return { setup: S, trades, pts, stats: { n, win: n ? win / n : NaN, avg: n ? cum / n : NaN, total: cum, pf: gl ? gw / gl : (gw ? Infinity : NaN), dd, years } };
    });
    return { days: sessions.length, from: sessions.length ? sessions[0].d : null, to: sessions.length ? sessions[sessions.length - 1].d : null, results };
  }

  root.Backtest = { SETUPS, run };
})(typeof window !== 'undefined' ? window : globalThis);
