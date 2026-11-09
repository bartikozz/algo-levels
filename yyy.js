/* YYY framework (mentor's Practitioner's Guide to Modern Markets) — pure functions, no DOM.
 *   regime()      ch. 11  entropy E(t) of 5-min log returns, adaptive threshold T(t), ρ = E/T, NORMAL / ELEVATED / CRITICAL,
 *                         PCA state S(t), momentum M(t), vol component (PCA3), distance d(t), size f* = f·k(ρ)·c(S,M)
 *   garch()       ch. 8.3 GARCH(1,1) persistence α+β, conditional / long-run variance → Normal / Elevated / Critical
 *   sigmaGrid()   ch. 15  σ = ATR(10)·√(5/390), anchor = close of the 18:00 ET Globex bar, ±0.5…±3σ + PDH / PDL
 *   dayType()     ch. 1.3 live day-type diagnosis from the initial balance, open rotation and range position
 *   tpo9()        ch. 4.3 9:00–9:30 pre-open TPO skew → open bias
 *   singlePrints()ch. 4.3 30-min TPO single prints (session) that have not been revisited
 *   cvdDiv()      ch. 2.2 / 4.4 price vs cumulative delta divergence (needs real delta)
 *   macro()       ch. 12.1–12.2, 13, 14  monthly / weekly layers
 *   synth()       ch. 12.3–12.4  six-layer synthesis → bias post (lean, levels, range, size rule, context)
 * window.YYY = { … }
 */
(function (root) {
  'use strict';
  const fmtET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  function et(t) {
    const p = {}; for (const x of fmtET.formatToParts(new Date(t * 1000))) p[x.type] = x.value;
    return { date: `${p.year}-${p.month}-${p.day}`, h: +p.hour, mi: +p.minute };
  }
  const isRTH = t => { const e = et(t), m = e.h * 60 + e.mi; return m >= 570 && m < 960; };
  const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const std = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
  const sign = x => x > 0 ? 1 : x < 0 ? -1 : 0;

  // ───────── 5-minute bars from 1-minute bars
  function bars5(b1, rthOnly) {
    const out = []; let cur = null;
    for (const b of b1) {
      if (rthOnly && !isRTH(b.t)) continue;
      const k = Math.floor(b.t / 300) * 300;
      if (!cur || cur.t !== k) { cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }; out.push(cur); }
      else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v || 0; }
    }
    return out;
  }

  // ───────── symmetric eigen-decomposition (Jacobi) → [{val, vec}] sorted by val desc
  function eig(A) {
    const n = A.length, a = A.map(r => r.slice()), V = A.map((_, i) => A.map((_, j) => +(i === j)));
    for (let sweep = 0; sweep < 60; sweep++) {
      let off = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] ** 2;
      if (off < 1e-14) break;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
        for (let k = 0; k < n; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
        for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
      }
    }
    return a.map((r, i) => ({ val: r[i], vec: V.map(row => row[i]) })).sort((x, y) => y.val - x.val);
  }
  // PCA on rows X (n × K): standardize columns, returns scores (unit variance) for components
  function pca(X) {
    const K = X[0].length, n = X.length;
    const mu = [], sd = [];
    for (let j = 0; j < K; j++) { const col = X.map(r => r[j]); mu.push(mean(col)); sd.push(std(col) || 1); }
    const Z = X.map(r => r.map((x, j) => (x - mu[j]) / sd[j]));
    const C = Array.from({ length: K }, (_, i) => Array.from({ length: K }, (_, j) => Z.reduce((s, r) => s + r[i] * r[j], 0) / n));
    const E = eig(C);
    const score = (z, k) => z.reduce((s, x, j) => s + x * E[k].vec[j], 0) / Math.sqrt(Math.max(E[k].val, 1e-12));
    return { E, Z, score, explained: E.map(e => e.val / K) };
  }

  // ───────── ch. 11 — entropy, regime, PCA topology, size rule
  function regime(b1, opt = {}) {
    const N = opt.N || 20, L = opt.L || 100;
    let b5 = bars5(b1, true), rthOnly = true;           // NDX cash = RTH bars; fall back to 24h NQ bars when history is short
    if (b5.length < N + L + 80) { b5 = bars5(b1, false); rthOnly = false; }
    if (b5.length < N + L + 30) return null;
    const r = b5.map((b, i) => i ? Math.log(b.c / b5[i - 1].c) : 0);
    const E = r.map((_, i) => i >= N ? std(r.slice(i - N + 1, i + 1)) * Math.sqrt(252) : null);
    const T = E.map((_, i) => i >= N + L - 1 ? mean(E.slice(i - L + 1, i + 1)) : null);
    const last = b5.length - 1;
    const rho = E[last] / T[last];
    const label = rho < 1.0 ? 'NORMAL' : rho < 1.2 ? 'ELEVATED' : 'CRITICAL';
    const k = rho < 1.0 ? 1 : rho < 1.2 ? 0.5 : 0;
    const slope = E[last] - E[last - 6];
    // feature rows: return block (cumulative log return over 1, 3, 6, 12, 24 bars) and volatility block
    const H = [1, 3, 6, 12, 24], start = N + 24;
    const cum = (i, h) => { let s = 0; for (let j = i - h + 1; j <= i; j++) s += r[j]; return s; };
    const rows = [], vrows = [];
    for (let i = Math.max(start, last - (opt.W || 780)); i <= last; i++) {
      if (E[i] == null || E[i - 2] == null) continue;
      rows.push(H.map(h => cum(i, h)));
      vrows.push([E[i], E[i - 1], E[i - 2], std(r.slice(Math.max(1, i - 49), i + 1)) * Math.sqrt(252), Math.abs(r[i])]);
    }
    if (rows.length < 60) return { E: E[last], T: T[last], rho, label, k, slope };
    const P = pca(rows), V = pca(vrows);
    // orientation: PC1 = level (positive when all horizons are up), PC2 = slope (positive when short horizons beat long ones)
    if (P.E[0].vec.reduce((s, x) => s + x, 0) < 0) P.E[0].vec = P.E[0].vec.map(x => -x);
    if (P.E[1].vec[0] - P.E[1].vec[H.length - 1] < 0) P.E[1].vec = P.E[1].vec.map(x => -x);
    if (V.E[0].vec[0] < 0) V.E[0].vec = V.E[0].vec.map(x => -x);
    const sc = (Pc, k2, j) => Pc.score(Pc.Z[j], k2);
    const n = rows.length, S = sc(P, 0, n - 1), M = sc(P, 1, n - 1), V3 = sc(V, 0, n - 1);
    const hist = []; for (let j = Math.max(0, n - 40); j < n; j++) hist.push({ S: sc(P, 0, j), M: sc(P, 1, j) });
    const Mprev = hist.length > 3 ? hist[hist.length - 4].M : M;
    const d = Math.hypot(S, M);
    const aligned = sign(S) === sign(M) && sign(S) !== 0;
    const c = aligned ? 1 : 0.5;
    return {
      E: E[last], T: T[last], rho, label, k, slope, rising: slope > 0,
      S, M, Mrising: M > Mprev, V3, d, aligned, c, size: k * c,
      lean: Math.abs(S) < 0.5 ? 0 : sign(S), unusual: d > 2.5, explained: P.explained.slice(0, 2),
      spark: E.slice(-78).map((e, i) => ({ e, t: T.slice(-78)[i] })), bars: b5.length, rthOnly,
    };
  }

  // ───────── ch. 8.3 — GARCH(1,1) by variance targeting + Nelder–Mead on (α, β)
  function garch(daily) {
    const c = daily.map(b => b.c).filter(x => x > 0);
    if (c.length < 120) return null;
    const r = []; for (let i = 1; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1]));
    const m = mean(r), e = r.map(x => x - m), v0 = mean(e.map(x => x * x));
    const nll = ([a, b]) => {
      if (a <= 0 || b <= 0 || a + b >= 0.999) return 1e12;
      const w = v0 * (1 - a - b); let s2 = v0, L = 0;
      for (const x of e) { L += Math.log(s2) + x * x / s2; s2 = w + a * x * x + b * s2; }
      return L;
    };
    // Nelder–Mead 2-D
    let P = [[0.08, 0.88], [0.15, 0.80], [0.05, 0.93]].map(p => ({ p, f: nll(p) }));
    for (let it = 0; it < 200; it++) {
      P.sort((x, y) => x.f - y.f);
      const [B, G, W] = P, cen = [(B.p[0] + G.p[0]) / 2, (B.p[1] + G.p[1]) / 2];
      const pt = k => [cen[0] + k * (W.p[0] - cen[0]), cen[1] + k * (W.p[1] - cen[1])];
      const R = pt(-1), fR = nll(R);
      if (fR < B.f) { const X = pt(-2), fX = nll(X); P[2] = fX < fR ? { p: X, f: fX } : { p: R, f: fR }; }
      else if (fR < G.f) P[2] = { p: R, f: fR };
      else { const Cc = pt(0.5), fC = nll(Cc); if (fC < W.f) P[2] = { p: Cc, f: fC }; else P = P.map((q, i) => i ? { p: [(q.p[0] + B.p[0]) / 2, (q.p[1] + B.p[1]) / 2], f: nll([(q.p[0] + B.p[0]) / 2, (q.p[1] + B.p[1]) / 2]) } : q); }
      if (Math.abs(P[2].f - P[0].f) < 1e-7) break;
    }
    P.sort((x, y) => x.f - y.f);
    const [a, b] = P[0].p, w = v0 * (1 - a - b);
    let s2 = v0; for (const x of e) s2 = w + a * x * x + b * s2;   // σ² for the next session
    const ratio = s2 / v0;
    const rv21 = std(r.slice(-21)) * Math.sqrt(252), rvLong = std(r.slice(-252)) * Math.sqrt(252);
    const shock = Math.abs(r[r.length - 1]) >= 0.02 ? r[r.length - 1] : 0;
    return { alpha: a, beta: b, pers: a + b, ratio, label: ratio <= 1 ? 'NORMAL' : ratio <= 1.5 ? 'ELEVATED' : 'CRITICAL',
      volNext: Math.sqrt(s2 * 252), volLong: Math.sqrt(v0 * 252), rv21, rvLong, shock,
      halfLife: Math.log(0.5) / Math.log(a + b) };
  }

  // ───────── ch. 15 — ATR sigma grid anchored to the 18:00 ET Globex open
  function sigmaGrid(daily, b1, mults) {
    if (!daily || daily.length < 12 || !b1 || !b1.length) return null;
    // the Globex session that contains the latest bar starts at 18:00 ET; anchor = close of the 18:00 5-min bar
    let ancT = null;
    for (let i = b1.length - 1; i >= 0; i--) { const e = et(b1[i].t); if (e.h === 18 && e.mi < 5) { ancT = Math.floor(b1[i].t / 300) * 300; break; } }
    if (ancT == null) return null;
    let ancClose = null; for (const b of b1) if (b.t >= ancT && b.t < ancT + 300) ancClose = b.c;
    const sessDate = et(ancT + 7 * 3600).date;             // trading date the Globex session belongs to
    const d = daily.filter(x => et(x.t).date < sessDate);
    if (d.length < 11) return null;
    const tr = []; for (let i = d.length - 10; i < d.length; i++) tr.push(Math.max(d[i].h - d[i].l, Math.abs(d[i].h - d[i - 1].c), Math.abs(d[i].l - d[i - 1].c)));
    const atr = mean(tr), sigma = atr * Math.sqrt(5 / 390);
    const M = mults || [0.5, 0.7, 1, 1.5, 2, 2.5, 3];
    const levels = [];
    for (const m of M) { levels.push({ m, p: ancClose + m * sigma }); levels.push({ m: -m, p: ancClose - m * sigma }); }
    const pd = d[d.length - 1];
    return { atr, sigma, anchor: ancClose, anchorT: ancT, levels: levels.sort((x, y) => x.p - y.p), pdh: pd.h, pdl: pd.l, sessDate };
  }

  // ───────── ch. 1.3 — live day type
  function dayType(b1, date, prevIB) {
    const rth = b1.filter(b => et(b.t).date === date && isRTH(b.t));
    if (rth.length < 30) return { type: rth.length ? 'čeká se na 30 min' : 'před RTH', n: rth.length };
    const open = rth[0].o, ibBars = rth.filter(b => b.t < rth[0].t + 3600);
    const ibH = Math.max(...ibBars.map(b => b.h)), ibL = Math.min(...ibBars.map(b => b.l)), ib = ibH - ibL;
    const H = Math.max(...rth.map(b => b.h)), L = Math.min(...rth.map(b => b.l)), R = H - L, last = rth[rth.length - 1].c;
    const extUp = Math.max(0, H - ibH), extDn = Math.max(0, ibL - L), ext = (extUp + extDn) / (ib || 1);
    const openPos = R ? (open - L) / R : 0.5, lastPos = R ? (last - L) / R : 0.5;
    // rotation back to the open within the first 45 minutes after leaving it
    const first45 = rth.filter(b => b.t < rth[0].t + 45 * 60 && b.t > rth[0].t + 5 * 60);
    const rotated = first45.some(b => b.l <= open && b.h >= open);
    const narrowIB = prevIB && ib < 0.6 * prevIB;
    const minutes = rth.length;
    let type, why;
    if (!rotated && ext >= 1 && ((openPos < 0.2 && lastPos > 0.75) || (openPos > 0.8 && lastPos < 0.25))) { type = 'TREND'; why = 'otevření u jednoho extrému, bez rotace k open v prvních 45 min, IB rozšířený ≥ 1×'; }
    else if (narrowIB && ext < 0.25 && minutes >= 90) { type = 'NON-TREND'; why = 'úzký IB (< 60 % průměru) a bez rozšíření'; }
    else if (ext < 0.3) { type = 'NORMAL'; why = 'IB drží, rotace kolem value'; }
    else if (ext <= 1.2) { type = 'NORMAL VARIATION'; why = `IB rozšířený ${extUp > extDn ? 'nahoru' : 'dolů'} (${(ext * 100).toFixed(0)} %), retrace drží`; }
    else { type = 'TREND?'; why = 'silné rozšíření IB, ale s rotací – potvrď deltou'; }
    const side = extUp > extDn ? 1 : extDn > extUp ? -1 : 0;
    const plays = { TREND: 'Nefadeovat. Každý pullback je pokračování, cíl další struktura profilu, drž pozici.', 'NON-TREND': 'Výrazně menší size nebo nic. Malé cíle, okamžitě ven, když to nejde.', NORMAL: 'Fade extrémů IB, cíl POC.', 'NORMAL VARIATION': 'Fade jen proti směru s malými cíli, ve směru delší cíle.', 'TREND?': 'Ještě nepotvrzeno – sleduj CVD a rotaci k open.' };
    return { type, why, play: plays[type], ib, ibH, ibL, ext, side, openPos, lastPos, rotated, n: minutes };
  }

  // ───────── ch. 4.3 — 9:00–9:30 pre-open TPO
  function tpo9(b1, date, tick) {
    const w = b1.filter(b => { const e = et(b.t); return e.date === date && e.h === 9 && e.mi < 30; });
    if (w.length < 20) return null;
    const step = tick || 1, H = Math.max(...w.map(b => b.h)), L = Math.min(...w.map(b => b.l));
    if (H - L < step * 3) return { skew: 0.5, label: 'BALANCED', H, L };
    const rows = new Map();
    for (const b of w) for (let p = Math.floor(b.l / step) * step; p <= b.h; p += step) rows.set(p, (rows.get(p) || 0) + 1);
    let tot = 0, acc = 0; for (const v of rows.values()) tot += v;
    let med = L; for (const [p, v] of [...rows.entries()].sort((a, b) => a[0] - b[0])) { acc += v; if (acc >= tot / 2) { med = p; break; } }
    const skew = (med - L) / (H - L);
    return { skew, H, L, label: skew >= 0.65 ? 'UPSIDE' : skew <= 0.35 ? 'DOWNSIDE' : 'BALANCED' };
  }

  // ───────── ch. 4.3 — session single prints on the 30-min TPO (not revisited since)
  function singlePrints(b1, date, step, minLen) {
    step = step || 1; minLen = minLen || 3;
    const rth = b1.filter(b => et(b.t).date === date && isRTH(b.t));
    if (rth.length < 60) return [];
    const t0 = rth[0].t, per = new Map(), cnt = new Map();
    for (const b of rth) {
      const k = Math.floor((b.t - t0) / 1800);
      for (let p = Math.floor(b.l / step) * step; p <= b.h + 1e-9; p += step) {
        const key = Math.round(p / step);
        if (per.get(key) !== k) { per.set(key, k); cnt.set(key, (cnt.get(key) || 0) + 1); }
      }
    }
    const keys = [...cnt.keys()].sort((a, b) => a - b), kMin = keys[0], kMax = keys[keys.length - 1], out = [];
    let a = null, bb = null;
    for (let key = kMin; key <= kMax + 1; key++) {
      const single = cnt.get(key) === 1 && key !== kMin && key !== kMax;
      if (single) { if (a == null) a = key; bb = key; }
      else if (a != null) { if ((bb - a + 1) * step >= minLen) out.push({ lo: a * step, hi: (bb + 1) * step, date }); a = null; }
    }
    // drop the ones price has traded back into since the session
    const after = b1.filter(b => b.t > rth[rth.length - 1].t);
    return out.filter(z => !after.some(b => b.h >= z.lo && b.l <= z.hi));
  }

  // ───────── ch. 2.2 / 4.4 — price vs cumulative delta divergence over the last n bars
  function cvdDiv(pts, n) {
    n = n || 30;
    if (!pts || pts.length < n + 5) return null;
    const w = pts.slice(-n), half = Math.floor(n / 2), A = w.slice(0, half), B = w.slice(half);
    const pH = [Math.max(...A.map(x => x.h)), Math.max(...B.map(x => x.h))], pL = [Math.min(...A.map(x => x.l)), Math.min(...B.map(x => x.l))];
    const dH = [Math.max(...A.map(x => x.cvd)), Math.max(...B.map(x => x.cvd))], dL = [Math.min(...A.map(x => x.cvd)), Math.min(...B.map(x => x.cvd))];
    if (pH[1] > pH[0] && dH[1] < dH[0]) return { type: 'bear', text: 'Cena dělá vyšší high, CVD nižší high → kupci slábnou (bearish divergence)' };
    if (pL[1] < pL[0] && dL[1] > dL[0]) return { type: 'bull', text: 'Cena dělá nižší low, CVD vyšší low → absorpce, prodejci slábnou (bullish divergence)' };
    return { type: 'none', text: 'Cena a CVD jdou spolu – pohyb má motor' };
  }

  // ───────── ch. 12.1–12.2, 13, 14 — macro layers
  function lastObs(series, n) { const s = (series || []).filter(x => Number.isFinite(x.v)); return s.slice(-(n || 1)); }
  function macro(inp) {
    const out = { monthly: {}, weekly: {}, notes: [] };
    // WALCL direction: latest vs ~4 weeks earlier
    const w = lastObs(inp.walcl, 6);
    if (w.length >= 5) { const d = w[w.length - 1].v - w[0].v; out.monthly.walcl = { dir: d > 0 ? 'UP' : 'DOWN', change: d, date: w[w.length - 1].d }; }
    const tone = inp.fomcTone || '';
    out.monthly.tone = tone;
    const wd = out.monthly.walcl && out.monthly.walcl.dir;
    out.monthly.bias = wd === 'UP' && tone === 'DOVISH' ? 'BULL' : wd === 'DOWN' && tone === 'HAWKISH' ? 'BEAR'
      : (wd === 'UP' && !tone) ? 'BULL?' : (wd === 'DOWN' && !tone) ? 'BEAR?' : 'NEUTRAL';
    // reserves + RRP (weekly change)
    const res = lastObs(inp.reserves, 2);
    const resCh = res.length === 2 ? res[1].v - res[0].v : null;
    let rrpCh = null;
    if (inp.rrp && inp.rrp.length >= 8) { const r = inp.rrp.filter(x => Number.isFinite(x.v)); const a = mean(r.slice(-5).map(x => x.v)), b = mean(r.slice(-10, -5).map(x => x.v)); rrpCh = a - b; }
    out.weekly.reserves = resCh; out.weekly.rrp = rrpCh; out.weekly.resDate = res.length ? res[res.length - 1].d : null;
    if (resCh != null) {
      const ru = resCh > 0, pu = rrpCh != null ? rrpCh > 0 : null;
      out.weekly.bias = ru && pu === false ? 'BUY DIPS (max)' : !ru && pu === true ? 'SELL RALLIES (max)' : ru && pu === true ? 'BUY DIPS (mixed)' : !ru && pu === false ? 'SELL RALLIES (mixed)' : ru ? 'BUY DIPS' : 'SELL RALLIES';
      out.weekly.dir = ru ? 1 : -1;
    }
    // HY OAS level + direction (4 weeks)
    const hy = lastObs(inp.hy, 25);
    if (hy.length) {
      const v = hy[hy.length - 1].v, d = hy.length > 20 ? v - hy[hy.length - 21].v : null;
      out.weekly.oas = { v, d, state: v < 3 ? 'HEALTHY' : v < 4 ? 'MILD' : v < 5 ? 'ELEVATED' : 'CRISIS', widening: d != null && d > 0.15, tightening: d != null && d < -0.15 };
    }
    // DXY trend over several weeks
    if (inp.dxy && inp.dxy.length > 40) {
      const c = inp.dxy.map(b => b.c), n = c.length, m20 = mean(c.slice(-20)), m20p = mean(c.slice(-40, -20));
      const up = c[n - 1] > m20 && m20 > m20p, dn = c[n - 1] < m20 && m20 < m20p;
      out.dxy = { last: c[n - 1], trend: up ? 'UP' : dn ? 'DOWN' : 'FLAT', ch4w: c[n - 1] / c[Math.max(0, n - 21)] - 1 };
    }
    // alignment notes
    if (out.weekly.oas && out.weekly.oas.v >= 4 && wd === 'UP') out.notes.push('HY OAS ≥ 4 % přebíjí rostoucí WALCL (stres v kreditu).');
    if (out.dxy && out.dxy.trend === 'UP' && wd === 'DOWN') out.notes.push('WALCL klesá a dolar posiluje – zarovnaný medvědí podklad.');
    if (out.dxy && out.dxy.trend === 'UP' && wd === 'UP') out.notes.push('WALCL roste, ale dolar posiluje – smíšený podklad, nižší přesvědčení.');
    return out;
  }

  // ───────── ch. 12.3–12.4 — synthesis
  function synth(x) {
    const R = x.regime, G = x.gex || {}, V = x.vol, M = x.macro || {}, out = { layers: [], caveats: [], levels: {} };
    let score = 0;
    // gate
    const gate = R ? R.label : null;
    let sizeMult = R ? R.size : null, sizeWhy = [];
    if (R) sizeWhy.push(`entropie ${R.label} (k=${R.k})`, `PCA ${R.aligned ? 'souhlasí' : 'nesouhlasí'} (c=${R.c})`);
    if (x.garch && x.garch.label !== 'NORMAL' && sizeMult != null) { sizeMult *= x.garch.label === 'ELEVATED' ? 0.75 : 0.5; sizeWhy.push(`GARCH ${x.garch.label}`); }
    if (x.auctionToday && sizeMult) { sizeMult *= 0.5; sizeWhy.push('aukce 10/20/30Y dnes'); }
    // topology
    if (R && R.S != null) {
      const t = R.lean * (R.aligned ? 2 : 1);
      score += t;
      if (R.unusual) out.caveats.push('Bod PCA je daleko od běžného shluku (d > 2.5) – snížit přesvědčení.');
      if (R.V3 > 1 && R.label !== 'NORMAL') out.caveats.push('PCA3 (vola v struktuře) i entropie zvýšené – erratická session, menší size.');
    }
    // GEX
    const spot = x.spot;
    if (G.trigger && spot) {
      out.levels.trigger = G.trigger;
      const above = spot > G.trigger;
      out.gexRegime = above ? 'LONG GAMMA' : 'SHORT GAMMA';
      if (!above) out.caveats.push('Pod vol triggerem: nefadeovat silný směrový pohyb, trail po 20 b.');
    }
    if (G.callWall) out.levels.callWall = G.callWall;
    if (G.putWall) out.levels.putWall = G.putWall;
    if (G.maxPain) out.levels.maxPain = G.maxPain;
    if (G.netSign) score += 0.5 * G.netSign;
    if (G.pos != null) score += G.pos > 0.6 ? 0.5 : G.pos < 0.4 ? -0.5 : 0;
    // skew / IV
    if (V) {
      const pn = V.hist && V.hist.pct && V.hist.pct.near, pm = V.hist && V.hist.pct && V.hist.pct.medium;
      if (pn != null && pn >= 0.8) { score -= 1; out.caveats.push('Krátkodobý put skew je strmý vůči historii – bearish lean / zajištění.'); }
      if (pn != null && pn <= 0.3 && pm != null && pm >= 0.8) out.caveats.push('Krátkodobě klid, ale 20–50 DTE silně zajištěné – něco se chystá dál.');
      if (V.skew && V.skew.squeeze) { score += 1; out.caveats.push('Call skew se blíží put skew – reálná poptávka po callech (squeeze setup).'); }
      if (V.contango === false) out.caveats.push('QQQ IV křivka v backwardation (front > 30–65 DTE; VIX/VIX3M může být v contangu): nefadeovat velké směrové pohyby, GEX levely se snáz prorazí.');
      if (V.brackets && V.brackets.d1_down && V.brackets.d1_up && V.brackets.d1_down > V.brackets.d1_up * 1.1) { score -= 0.5; out.caveats.push('Dolní 1D bracket je širší než horní – opce se kloní dolů.'); }
    }
    // macro tie-break
    const mb = M.monthly && M.monthly.bias;
    if (mb && mb.startsWith('BULL')) score += 0.5; else if (mb && mb.startsWith('BEAR')) score -= 0.5;
    if (M.weekly && M.weekly.dir) score += 0.5 * M.weekly.dir;
    if (M.weekly && M.weekly.oas && M.weekly.oas.v >= 4) score -= 0.5;
    out.score = score;
    if (gate === 'CRITICAL') { out.lean = 'NO TRADE'; out.size = 'ZERO'; }
    else {
      out.lean = score >= 2 ? 'BULL' : score <= -2 ? 'BEAR' : (gate === 'ELEVATED' || (R && !R.aligned)) ? 'CHOPPY' : 'NEUTRAL';
      out.size = sizeMult == null ? '—' : sizeMult >= 0.99 ? 'FULL' : sizeMult >= 0.49 ? 'HALF' : sizeMult > 0 ? 'QUARTER' : 'ZERO';
    }
    out.sizeMult = sizeMult; out.sizeWhy = sizeWhy;
    if (mb && ((mb.startsWith('BEAR') && score > 1) || (mb.startsWith('BULL') && score < -1))) out.caveats.push(`Měsíční makro ${mb} jde proti session setupu – session podle nočních vrstev, makro jako výhrada.`);
    if (R && R.label === 'ELEVATED' && G.trigger && spot > G.trigger) out.caveats.push('GEX pozitivní, ale entropie zvýšená – levely budou trhanější.');
    return out;
  }


  // ───────── Sentiment engine (mentor's daily read): QQQ all-expiry pivot, SPX pivot, VIX gamma regime, sectors
  //  weight     = |net dealer gamma| at the strike (normalised) + 0.6 × new positioning (day-over-day put OI + ½ call OI, ThetaData)
  //  bracket    = nearest heavy strike on the round grid below and above spot (QQQ 5, SPX 50); the heavier one (distance-
  //               discounted) is today's PIVOT, the other is RESISTANCE (above) / SUPPORT (below)  — mentor: QQQ 658 → pivot 655,
  //               resistance 660; SPX 7370 → focus 7350 (big customer put position), lose it → 7300
  //  POIs       = next heavy strikes beyond the bracket (QQQ any strike, e.g. 653 / 650; SPX on its POI grid)
  //  status     = above / below the pivot, held ≥ 10 min = reclaimed / lost, else testing; prior session failed reclaim
  //  mentor style (9.11: QQQ 662 → "trading above 660 = pivot", 663 / 658 watch, 655 → 650s; SPX 7441 → 7450 reclaim →
  //  7490 big +GEX, 7400 pivot): the pivot is the heavy round strike price trades ABOVE (just below spot) – unless price
  //  already traded above the strike overhead today and lost it, then that one is the pivot (bearish). inner = the nearest
  //  heavy strikes off the round grid (663 / 658), magnet = biggest positive GEX above spot, outer levels only within ±1 %.
  function keyLevels(g, spot, band, idx, round, flow, poiGrid, bars) {
    if (!g || !Array.isArray(g.strikes) || !spot) return null;
    const rows = g.strikes.map(r => ({ k: +r[0], v: +r[idx] || 0 })).filter(r => Number.isFinite(r.k) && Math.abs(r.k / spot - 1) <= band * 3);
    if (!rows.length) return null;
    const fm = new Map((flow || []).map(r => [+r[0], Math.max(0, +r[2] || 0) + 0.5 * Math.max(0, +r[1] || 0)]));
    const mg = Math.max(...rows.map(r => Math.abs(r.v))) || 1, mf = Math.max(0, ...rows.map(r => fm.get(r.k) || 0)) || 1;
    rows.forEach(r => { r.f = fm.get(r.k) || 0; r.w = Math.abs(r.v) / mg + (fm.size ? 0.6 * r.f / mf : 0); });
    const near = rows.filter(r => Math.abs(r.k / spot - 1) <= band);
    if (!near.length) return null;
    const rnd = round || 1, onG = (k, gr) => Math.abs(k / gr - Math.round(k / gr)) < 1e-9;
    const mxN = Math.max(...near.map(r => r.w)) || 1;
    let cand = near.filter(r => r.w >= 0.25 * mxN && onG(r.k, rnd));
    if (cand.length < 2) cand = near.filter(r => r.w >= 0.25 * mxN);
    const above = cand.filter(r => r.k >= spot).sort((a, b) => a.k - b.k)[0], below = cand.filter(r => r.k < spot).sort((a, b) => b.k - a.k)[0];
    let dayHi = null;
    if (bars && bars.length) { const d = et(bars[bars.length - 1].t).date; const td = bars.filter(b => et(b.t).date === d); if (td.length) dayHi = Math.max(...td.map(b => b.h)); }
    const lost = above && dayHi != null && dayHi > above.k + rnd * 0.1;
    const pivot = above && below ? (lost ? above : below) : (above || below);
    const other = above && below ? (pivot === below ? above : below) : null;
    const mx = Math.max(...rows.map(r => r.w)) || 1, pg = poiGrid || 0;
    const heavy = rows.filter(r => r.w >= 0.25 * mx && r.k !== pivot.k && (!other || r.k !== other.k) && (!pg || onG(r.k, pg)));
    const hi = Math.max(spot, pivot.k, other ? other.k : -Infinity), lo = Math.min(spot, pivot.k, other ? other.k : Infinity);
    let up = heavy.filter(r => r.k > hi).sort((a, b) => a.k - b.k).slice(0, 2).map(r => r.k);
    let dn = heavy.filter(r => r.k < lo).sort((a, b) => b.k - a.k).slice(0, 2).map(r => r.k);
    if (other && other.k > pivot.k) up = [other.k, ...up].slice(0, 2); else if (other) dn = [other.k, ...dn].slice(0, 2);
    // outer levels only near spot, ±1.5 % (keep the nearest one per side even if farther)
    const in1 = k => Math.abs(k / spot - 1) <= 0.015;
    up = up.filter((k, i) => i === 0 || in1(k)); dn = dn.filter((k, i) => i === 0 || in1(k));
    // inner levels: nearest heavy off-grid strikes between spot and the bracket
    const used = new Set([pivot.k, ...(other ? [other.k] : []), ...up, ...dn]);
    const tight = rows.filter(r => Math.abs(r.k / spot - 1) <= 0.008), mxT = Math.max(0, ...tight.map(r => r.w)) || 1;
    const inr = tight.filter(r => r.w >= 0.25 * mxT && !used.has(r.k) && !onG(r.k, rnd));
    const iUp = inr.filter(r => r.k > spot && r.k < (up[0] != null ? up[0] : Infinity)).sort((a, b) => a.k - b.k)[0];
    const iDn = inr.filter(r => r.k < spot && r.k > (dn[0] != null ? dn[0] : -Infinity) && r.k !== pivot.k).sort((a, b) => b.k - a.k)[0];
    const mag = rows.filter(r => r.k > spot && r.v > 0 && Math.abs(r.k / spot - 1) <= 0.012).sort((a, b) => b.v - a.v)[0];
    return { pivot: pivot.k, pivotNet: pivot.v, pivotFlow: pivot.f, other: other ? other.k : null, up, dn, lost: !!lost,
      inner: [iUp ? iUp.k : null, iDn ? iDn.k : null], magnet: mag ? mag.k : null,
      zero: Number.isFinite(g.zero_gamma) ? g.zero_gamma : null };
  }
  // VIX: where dealer gamma changes sign around spot (mentor: "positive gamma up to 30") + trigger just below spot ("breaking 27")
  function vixMap(g, spot, idx) {
    if (!g || !Array.isArray(g.strikes) || !spot) return null;
    const rows = g.strikes.map(r => ({ k: +r[0], v: +r[idx] || 0 })).filter(r => Number.isFinite(r.k) && r.k > spot * 0.6 && r.k < spot * 1.8).sort((a, b) => a.k - b.k);
    if (rows.length < 4) return null;
    const mx = Math.max(...rows.map(r => Math.abs(r.v))) || 1, sig = rows.filter(r => Math.abs(r.v) >= 0.05 * mx);
    const loc = sig.filter(r => Math.abs(r.k - spot) <= Math.max(1.5, spot * 0.06)).reduce((a, r) => a + r.v, 0);
    const regime = loc >= 0 ? 1 : -1;
    let edge = null;
    if (regime > 0) {   // last strike of the positive run above spot
      for (let i = 0; i < sig.length; i++) { const r = sig[i]; if (r.k <= spot) continue;
        if (r.v < 0 && (!sig[i + 1] || sig[i + 1].v <= 0)) { edge = i > 0 && sig[i - 1].k > spot ? sig[i - 1].k : r.k; break; } }
    } else {            // negative gamma around spot: where the positive zone (below) ends
      for (let i = sig.length - 1; i >= 0; i--) { const r = sig[i]; if (r.k >= spot) continue; if (r.v > 0) { edge = r.k; break; } }
    }
    const peak = rows.filter(r => Math.abs(r.k / spot - 1) <= 0.15).reduce((a, r) => Math.abs(r.v) > Math.abs(a.v) ? r : a, { k: null, v: 0 });
    return { regime, edge, trigger: Math.floor(spot), peak: peak.k, peakNet: peak.v, pivot: Math.floor(spot), up: [], dn: [] };
  }
  function sideOf(bars, level, spot) {
    const last = bars && bars.length ? bars[bars.length - 1].c : spot;
    if (!Number.isFinite(last) || !Number.isFinite(level)) return { side: 0, state: '—' };
    const side = last >= level ? 1 : -1;
    let n = 0; if (bars) for (let i = bars.length - 1; i >= 0 && (bars[i].c >= level ? 1 : -1) === side; i--) n++;
    const held = !bars || n >= 10;
    // previous session: traded above the level but closed below (failed reclaim) or the opposite
    let prevFail = null;
    if (bars && bars.length) {
      const days = [...new Set(bars.map(b => et(b.t).date))];
      if (days.length > 1) {
        const pd = bars.filter(b => et(b.t).date === days[days.length - 2] && isRTH(b.t));
        if (pd.length) { const hi = Math.max(...pd.map(b => b.h)), lo = Math.min(...pd.map(b => b.l)), cl = pd[pd.length - 1].c;
          if (hi > level && cl < level) prevFail = 'reclaim'; else if (lo < level && cl > level) prevFail = 'breakdown'; }
      }
    }
    return { side, held, mins: n, last, state: side > 0 ? (held ? 'NAD (drží)' : 'nad – testuje') : (held ? 'POD (ztraceno)' : 'pod – testuje'), prevFail };
  }
  function sentiment(x) {
    const out = { assets: {}, drivers: [], score: 0, lines: [] };
    const add = (v, why) => { out.score += v; out.drivers.push([why, v]); };
    // QQQ — all-expiry gamma (OI) + new positioning
    const qb = x.qqq && x.qqq.bars;
    const qL = keyLevels(x.qqq && x.qqq.full, x.qqq && x.qqq.spot, 0.012, 2, 5, x.qqq && x.qqq.flow, 0, qb) || keyLevels(x.qqq && x.qqq.zero, x.qqq && x.qqq.spot, 0.012, 1, 5, x.qqq && x.qqq.flow, 0, qb);
    if (qL) {
      const s = sideOf(x.qqq.bars, qL.pivot, x.qqq.spot), o = qL.other != null ? sideOf(x.qqq.bars, qL.other, x.qqq.spot) : null;
      out.assets.QQQ = { ...qL, ...s, otherFail: o && o.prevFail };
      add(s.side * (s.held ? 1.5 : 0.5), `QQQ ${s.side > 0 ? 'nad' : 'pod'} pivotem ${qL.pivot}`);
      if (o && o.prevFail === 'reclaim' && qL.other > qL.pivot) add(-0.5, `QQQ včera nedokázalo reclaimnout ${qL.other}`);
      if (s.prevFail === 'reclaim' && s.side < 0) add(-0.5, `QQQ včera nedokázalo reclaimnout ${qL.pivot}`);
      if (qL.zero) add(x.qqq.spot > qL.zero ? 0.5 : -0.5, `QQQ ${x.qqq.spot > qL.zero ? 'nad' : 'pod'} zero gamma ${qL.zero.toFixed(1)}`);
    }
    // SPX — 0DTE + all-expiry profile, round 50 bracket, POIs on the 50 grid
    const sb = x.spx && x.spx.bars;
    const sL = keyLevels(x.spx && x.spx.zero, x.spx && x.spx.spot, 0.008, 1, 50, x.spx && x.spx.flow, 50, sb) || keyLevels(x.spx && x.spx.full, x.spx && x.spx.spot, 0.008, 2, 50, x.spx && x.spx.flow, 50, sb)
      || keyLevels(x.spx && x.spx.full, x.spx && x.spx.spot, 0.012, 2, 25, x.spx && x.spx.flow, 25, sb);
    if (sL) {
      const s = sideOf(x.spx.bars, sL.pivot, x.spx.spot);
      out.assets.SPX = { ...sL, ...s };
      add(s.side * (s.held ? 1.5 : 0.5), `SPX ${s.side > 0 ? 'nad' : 'pod'} pivotem ${sL.pivot}`);
    }
    // VIX — gamma regime edge + trigger
    const vL = vixMap(x.vix && x.vix.full, x.vix && x.vix.spot, 2) || vixMap(x.vix && x.vix.zero, x.vix && x.vix.spot, 1);
    if (vL) {
      const s = sideOf(x.vix.bars, vL.trigger, x.vix.spot);
      out.assets.VIX = { ...vL, ...s, last: x.vix.spot, est: x.vix.est, at: x.vix.at };
      if (vL.regime > 0) add(0.3, `VIX v pozitivní gammě${vL.edge ? ' do ' + vL.edge : ''} – růst VIX tlumený`);
      else add(-0.5, `VIX v negativní gammě${vL.edge ? ' nad ' + vL.edge : ''} – VIX může vystřelit`);
    }
    // sectors: semis + tech breadth (AI / data-center risk shows up here first)
    const sec = x.sectors || {};
    if (sec.SMH && Number.isFinite(sec.SMH.d1)) add(sec.SMH.d1 > 0.005 ? 0.5 : sec.SMH.d1 < -0.005 ? -0.5 : 0, `polovodiče (SMH) ${(sec.SMH.d1 * 100).toFixed(1)} % dnes`);
    if (sec.XLK && Number.isFinite(sec.XLK.d5) && sec.XLK.d5 < -0.03) add(-0.5, `tech (XLK) ${(sec.XLK.d5 * 100).toFixed(1)} % za 5 dní`);
    const names = Object.keys(sec).filter(k => /^XL/.test(k) && Number.isFinite(sec[k].d1));
    if (names.length >= 8) { const up = names.filter(k => sec[k].d1 > 0).length; out.breadth = { up, n: names.length };
      if (up >= names.length - 2 && sec.XLK && sec.XLK.d1 <= 0) out.drivers.push([`rotace: ${up}/${names.length} sektorů nahoru, ale tech ne – SPX/DOW drží, tech zaostává`, 0]); }
    const sc = out.score;
    out.lean = sc >= 2.5 ? 'BULLISH' : sc <= -2.5 ? 'BEARISH' : sc >= 1 ? 'LEAN BULL' : sc <= -1 ? 'LEAN BEAR' : 'NEUTRÁL';
    // chart lines on QQQ (→ NQ via k): pivot, the other bracket strike, POIs
    const Q = out.assets.QQQ;
    if (Q) {
      out.lines.push({ q: Q.pivot, role: Q.side < 0 && sc < 0 ? 'PIVOT · SHORT pod ním' : Q.side > 0 && sc > 0 ? 'PIVOT · LONG nad ním' : 'PIVOT', color: '#ef5350' });
      Q.up.forEach((k, i) => out.lines.push({ q: k, role: i === 0 ? 'RESISTANCE' : 'UPSIDE POI', color: '#ef5350' }));
      Q.dn.forEach((k, i) => out.lines.push({ q: k, role: i === Q.dn.length - 1 ? 'SUPPORT · break = sellers' : 'SUPPORT', color: '#66bb6a' }));
      if (Q.inner[0] != null) out.lines.push({ q: Q.inner[0], role: 'LEVEL', color: '#9aa3b2' });
      if (Q.inner[1] != null) out.lines.push({ q: Q.inner[1], role: 'LEVEL', color: '#9aa3b2' });
    }
    // short read (tooltip / Focus card)
    const t = [], SPX = out.assets.SPX, V = out.assets.VIX;
    if (Q) t.push(`QQQ ${Q.side > 0 ? 'nad' : 'pod'} ${Q.pivot} = pivot${Q.lost ? ' (dnes ztracený)' : ''}. Hlídám ${Q.inner.filter(k => k != null).join(' a ') || '—'}. Nahoru ${Q.up.join(' / ') || '—'}, dolů ${Q.dn.join(' / ') || '—'}${Q.dn.length ? `, ztráta ${Q.dn[Q.dn.length - 1]} otevře cestu níž` : ''}.`);
    if (SPX) t.push(`SPX pivot ${SPX.pivot} (${SPX.side > 0 ? 'drží' : 'pod'})${SPX.other != null && SPX.other > SPX.pivot ? `, reclaim ${SPX.other}` : ''}${SPX.magnet ? ` → ${SPX.magnet} (největší +GEX)` : SPX.up[0] ? ` → ${SPX.up[0]}` : ''}${SPX.side > 0 && SPX.dn[0] ? `; ztráta pivotu → ${SPX.dn[0]}` : ''}.`);
    if (V) t.push(`VIX ${V.regime > 0 ? `pozitivní gamma${V.edge ? ' do ' + V.edge : ''}, průraz pod ${V.trigger} = pullback/odraz indexů` : `negativní gamma${V.edge ? ' nad ' + V.edge : ''} – VIX může vystřelit`}.`);
    out.text = t;
    return out;
  }

  root.YYY = { et, isRTH, bars5, eig, pca, regime, garch, sigmaGrid, dayType, tpo9, singlePrints, cvdDiv, macro, synth, keyLevels, vixMap, sentiment };
})(typeof window !== 'undefined' ? window : globalThis);
