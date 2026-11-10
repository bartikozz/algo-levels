/* PRO views (data server): options levels chart, strike × expiry matrix, volatility smile/term,
 * MM landscape, flow (CVD + bid/ask volume profile + TPO), and the footprint overlay for the main chart.
 * Pure canvas drawing. window.Pro = { levelsChart, matrix, vol, landscape, flow, footprint }
 */
(function (root) {
  'use strict';
  const C = { bg: '#07080a', grid: '#141820', txt: '#7b828c', txt2: '#c9ccd2', pos: '94,224,200', neg: '255,95,162', gold: '#c9a66b', white: '#e6e8eb' };
  const FONT = '10px JetBrains Mono, monospace';
  function setup(cv) {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = C.bg; c.fillRect(0, 0, w, h); c.font = FONT; c.textBaseline = 'middle';
    return { c, w, h };
  }
  const nice = r => { const x = r / 8, p = Math.pow(10, Math.floor(Math.log10(x))); return [1, 2, 2.5, 5, 10].map(m => m * p).find(m => m >= x) || p * 10; };
  const fmtM = v => { const a = Math.abs(v); return (v < 0 ? '−' : '') + (a >= 1e9 ? (a / 1e9).toFixed(1) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(0) + 'k' : a.toFixed(0)); };
  const empty = (c, w, h, msg) => { c.fillStyle = C.txt; c.textAlign = 'center'; c.fillText(msg, w / 2, h / 2); };

  // ── Options Levels: session bars + every options level, QQQ axis left, NQ axis right (Residual style)
  function levelsChart(cv, bars, levels, o) {
    const { c, w, h } = setup(cv);
    if (!bars.length) return empty(c, w, h, 'Čekám na svíčky ze serveru…');
    const L = 64, R = w - 78, top = 14, bot = h - 22, k = o.k || 41;
    const ps = bars.flatMap(b => [b.h, b.l]);
    let lo = Math.min(...ps), hi = Math.max(...ps); const pad = (hi - lo) * 0.12 + 5; lo -= pad; hi += pad;
    // always show at least ±EM (or ±0.5 %) around the last price so nearby levels are visible
    const last = bars[bars.length - 1].c, half = Math.max(o.em || 0, last * 0.005);
    lo = Math.min(lo, last - half); hi = Math.max(hi, last + half);
    const lv = levels.filter(l => l.nq >= lo && l.nq <= hi);
    const Y = p => top + (hi - p) / (hi - lo) * (bot - top), X = i => L + (i + 0.5) * (R - L) / bars.length;
    const st = nice(hi - lo);
    c.textAlign = 'right';
    for (let p = Math.ceil(lo / st) * st; p <= hi; p += st) { const y = Y(p); c.fillStyle = C.grid; c.fillRect(L, y, R - L, 1); c.fillStyle = C.txt; c.fillText((p / k).toFixed(2), L - 6, y); c.textAlign = 'left'; c.fillText(p.toFixed(2), R + 6, y); c.textAlign = 'right'; }
    const bw = Math.max(1, (R - L) / bars.length * 0.7);
    bars.forEach((b, i) => {
      const x = X(i), up = b.c >= b.o;
      c.strokeStyle = up ? `rgb(${C.pos})` : `rgb(${C.neg})`; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x, Y(b.h)); c.lineTo(x, Y(b.l)); c.stroke();
      if (bw > 2) { c.fillStyle = c.strokeStyle; c.fillRect(x - bw / 2, Y(Math.max(b.o, b.c)), bw, Math.max(1, Math.abs(Y(b.o) - Y(b.c)))); }
    });
    // levels: label pill on the left of the line + value boxes on both axes
    cv._hits = lv.map(l => ({ y: Y(l.nq), kind: l.kind, q: l.q, nq: l.nq, w: l.w }));
    cv._dead = o.dead ? { y0: Y(o.dead.hi * k), y1: Y(o.dead.lo * k), lo: o.dead.lo * k, hi: o.dead.hi * k } : null;
    cv._last = last;
    const used = [];
    for (const l of lv.sort((a, b) => b.w - a.w)) {
      const y = Y(l.nq); if (used.some(u => Math.abs(u - y) < 11)) continue; used.push(y);
      const col = /CW|CEIL|HI/.test(l.kind) ? `rgb(${C.pos})` : /PW|FLOOR|LO/.test(l.kind) ? `rgb(${C.neg})` : /FLIP/.test(l.kind) ? '#f0a020' : C.txt2;
      c.strokeStyle = col; c.globalAlpha = 0.85; c.beginPath(); c.moveTo(L, y); c.lineTo(R, y); c.stroke(); c.globalAlpha = 1;
      const tw = c.measureText(l.kind).width + 12;
      c.fillStyle = C.bg; c.strokeStyle = col; c.beginPath(); c.roundRect ? c.roundRect(L + 6, y - 7, tw, 14, 7) : c.rect(L + 6, y - 7, tw, 14); c.fill(); c.stroke();
      c.fillStyle = col; c.textAlign = 'left'; c.fillText(l.kind, L + 12, y);
      c.fillStyle = C.bg; c.fillRect(R + 2, y - 7, 74, 14); c.strokeStyle = col; c.strokeRect(R + 2, y - 7, 74, 14);
      c.fillStyle = col; c.fillText(l.nq.toFixed(2), R + 6, y);
      c.textAlign = 'right'; c.fillStyle = C.bg; c.fillRect(2, y - 7, L - 6, 14); c.strokeRect(2, y - 7, L - 6, 14); c.fillStyle = col; c.fillText(l.q.toFixed(2), L - 6, y);
    }
    if (o.dead) {
      const a = Y(o.dead.hi * k), b = Y(o.dead.lo * k);
      c.fillStyle = 'rgba(240,160,32,.07)'; c.fillRect(L, a, R - L, b - a);
    }
    c.fillStyle = C.txt; c.textAlign = 'left';
    c.fillText(o.note || '', L + 6, top + 2);
    c.textAlign = 'center';
    const step = Math.max(1, Math.floor(bars.length / 6));
    for (let i = 0; i < bars.length; i += step) c.fillText(o.label(bars[i].t), X(i), h - 9);
  }

  // ── strike × expiry matrix (Strike Heatmap by Expiry)
  function matrix(cv, H, o) {
    const { c, w, h } = setup(cv);
    if (!H || !H.strikes || !H.strikes.length) return empty(c, w, h, 'Žádná data.');
    const L = 70, top = 34, bot = h - 8, R = w - 8;
    const ne = H.expiries.length, ns = H.strikes.length, cw = (R - L) / ne, ch = (bot - top) / ns;
    let mx = 1; for (const row of H.z) for (const v of row) mx = Math.max(mx, Math.abs(v));
    c.textAlign = 'center';
    H.expiries.forEach((e, j) => { c.fillStyle = C.txt; c.save(); c.translate(L + (j + 0.5) * cw, top - 14); c.fillText(e.slice(5).replace('-', '/'), 0, 0); c.restore(); });
    for (let i = 0; i < ns; i++) {
      const y = bot - (i + 1) * ch, kq = H.strikes[i];
      for (let j = 0; j < ne; j++) {
        const v = H.z[i][j]; if (!v) continue;
        const a = Math.sqrt(Math.abs(v) / mx);
        c.fillStyle = `rgba(${v > 0 ? C.pos : C.neg},${Math.min(0.95, 0.08 + a)})`;
        c.fillRect(L + j * cw + 1, y + 0.5, cw - 2, Math.max(1, ch - 1));
        if (cw > 46 && ch > 11 && a > 0.35) { c.fillStyle = '#07080a'; c.fillText(fmtM(v), L + (j + 0.5) * cw, y + ch / 2); }
      }
      const isSpot = o.spot && Math.abs(kq - o.spot) < (H.strikes[1] - H.strikes[0] || 1) / 2;
      if (ch > 9 || i % Math.ceil(10 / ch) === 0 || isSpot) { c.textAlign = 'right'; c.fillStyle = isSpot ? C.white : C.txt; c.fillText(`${kq}${H.nq && H.nq[i] ? '  ' + Math.round(H.nq[i]) : ''}`, L - 4, y + ch / 2); c.textAlign = 'center'; }
    }
    if (o.spot) {
      const i = H.strikes.findIndex(kq => kq >= o.spot); if (i >= 0) { const y = bot - i * ch; c.strokeStyle = C.white; c.setLineDash([4, 3]); c.beginPath(); c.moveTo(L, y); c.lineTo(R, y); c.stroke(); c.setLineDash([]); }
    }
  }

  // ── Volatility: smile of one expiry (+ IV peaks) and the ATM term structure
  function vol(cv, sm, term, o) {
    const { c, w, h } = setup(cv);
    if (!sm || !sm.length) return empty(c, w, h, 'Žádná data.');
    const half = Math.floor(h * 0.62), L = 50, R = w - 12;
    const S = o.spot, pts = sm.filter(p => Math.abs(p.strike / S - 1) < (o.pct || 0.05));
    if (pts.length > 1) {
      const xs = pts.map(p => p.strike), ys = pts.map(p => p.iv * 100);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys) - 1, y1 = Math.max(...ys) + 1;
      const X = x => L + (x - x0) / (x1 - x0) * (R - L), Y = y => 14 + (y1 - y) / (y1 - y0) * (half - 34);
      c.textAlign = 'right';
      const sy = nice(y1 - y0); for (let y = Math.ceil(y0 / sy) * sy; y <= y1; y += sy) { c.fillStyle = C.grid; c.fillRect(L, Y(y), R - L, 1); c.fillStyle = C.txt; c.fillText(y.toFixed(1) + '%', L - 4, Y(y)); }
      c.textAlign = 'center';
      const sx = nice(x1 - x0); for (let x = Math.ceil(x0 / sx) * sx; x <= x1; x += sx) { c.fillStyle = C.txt; c.fillText(x.toFixed(0), X(x), half - 12); }
      c.strokeStyle = C.white; c.lineWidth = 1.5; c.beginPath(); pts.forEach((p, i) => i ? c.lineTo(X(p.strike), Y(p.iv * 100)) : c.moveTo(X(p.strike), Y(p.iv * 100))); c.stroke();
      c.strokeStyle = 'rgba(255,255,255,.35)'; c.setLineDash([4, 4]); c.beginPath(); c.moveTo(X(S), 14); c.lineTo(X(S), half - 22); c.stroke(); c.setLineDash([]);
      for (const wl of (o.peaks && o.peaks.walls) || []) {
        if (wl.strike < x0 || wl.strike > x1) continue;
        const p = pts.find(q => q.strike === wl.strike) || {}; const x = X(wl.strike), y = Y((p.iv || 0) * 100);
        c.fillStyle = C.gold; c.beginPath(); c.arc(x, y, 4, 0, 7); c.fill(); c.fillText(`IV wall ${wl.strike} (+${wl.excess})`, x, y - 12);
      }
      c.fillStyle = C.txt2; c.textAlign = 'left'; c.fillText(`Smile ${o.exp || ''} · OTM IV · bílá čárka = spot`, L, 6);
    }
    // term structure
    if (term && term.length > 1) {
      const top = half + 16, bot = h - 18, X = i => L + i * (R - L) / (term.length - 1);
      const ys = term.flatMap(t => [t.atm, t.put3, t.call3]).map(v => v * 100), y0 = Math.min(...ys) - 0.5, y1 = Math.max(...ys) + 0.5;
      const Y = y => top + (y1 - y) / (y1 - y0) * (bot - top);
      c.fillStyle = C.txt2; c.textAlign = 'left'; c.fillText('Term structure: ATM IV (bílá), put −3 % (růžová), call +3 % (tyrkysová)', L, top - 8);
      for (const [key, col] of [['put3', `rgb(${C.neg})`], ['call3', `rgb(${C.pos})`], ['atm', C.white]]) {
        c.strokeStyle = col; c.lineWidth = key === 'atm' ? 1.6 : 1; c.beginPath(); term.forEach((t, i) => i ? c.lineTo(X(i), Y(t[key] * 100)) : c.moveTo(X(i), Y(t[key] * 100))); c.stroke();
      }
      c.textAlign = 'center'; c.fillStyle = C.txt;
      term.forEach((t, i) => { if (i % Math.ceil(term.length / 8) === 0) c.fillText(t.exp.slice(5).replace('-', '/'), X(i), h - 7); });
      c.textAlign = 'right'; c.fillText(y1.toFixed(1) + '%', L - 4, Y(y1)); c.fillText(y0.toFixed(1) + '%', L - 4, Y(y0));
    }
  }

  // ── MM Landscape: dealer GEX vs hypothetical spot
  function landscape(cv, A, B, o) {
    const { c, w, h } = setup(cv);
    if (!A || !A.grid) return empty(c, w, h, 'Žádná data.');
    const L = 70, R = w - 12, top = 16, bot = h - 24, k = o.k || 1;
    const xs = A.grid.map(p => p.spot), gs = A.grid.map(p => p.gex).concat(B && B.grid ? B.grid.map(p => p.gex) : []);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), g0 = Math.min(0, ...gs), g1 = Math.max(0, ...gs);
    const X = x => L + (x - x0) / (x1 - x0) * (R - L), Y = g => top + (g1 - g) / (g1 - g0 || 1) * (bot - top);
    if (A.dead_zone) { c.fillStyle = 'rgba(240,160,32,.10)'; c.fillRect(X(A.dead_zone.lo), top, X(A.dead_zone.hi) - X(A.dead_zone.lo), bot - top); c.fillStyle = '#f0a020'; c.textAlign = 'center'; c.fillText('dead zone', (X(A.dead_zone.lo) + X(A.dead_zone.hi)) / 2, top + 6); }
    c.fillStyle = 'rgba(255,255,255,.25)'; c.fillRect(L, Y(0), R - L, 1);
    const draw = (G, col, wdt) => { c.strokeStyle = col; c.lineWidth = wdt; c.beginPath(); G.grid.forEach((p, i) => i ? c.lineTo(X(p.spot), Y(p.gex)) : c.moveTo(X(p.spot), Y(p.gex))); c.stroke(); };
    // fill above/below zero
    c.globalAlpha = 0.18; c.fillStyle = `rgb(${C.pos})`; c.beginPath(); c.moveTo(X(x0), Y(0)); A.grid.forEach(p => c.lineTo(X(p.spot), Y(Math.max(0, p.gex)))); c.lineTo(X(x1), Y(0)); c.fill();
    c.fillStyle = `rgb(${C.neg})`; c.beginPath(); c.moveTo(X(x0), Y(0)); A.grid.forEach(p => c.lineTo(X(p.spot), Y(Math.min(0, p.gex)))); c.lineTo(X(x1), Y(0)); c.fill(); c.globalAlpha = 1;
    draw(A, C.white, 1.6); if (B && B.grid) draw(B, C.gold, 1.2);
    const mark = (x, label, col, y) => { if (x == null || x < x0 || x > x1) return; c.strokeStyle = col; c.setLineDash([4, 4]); c.beginPath(); c.moveTo(X(x), top); c.lineTo(X(x), bot); c.stroke(); c.setLineDash([]); c.fillStyle = col; c.textAlign = X(x) > (L + R) / 2 ? 'right' : 'left'; c.fillText(`${label} ${x.toFixed(2)} · NQ ${(x * k).toFixed(0)}`, X(x) + (c.textAlign === 'left' ? 4 : -4), y); };
    mark(o.spot, 'SPOT', C.white, bot - 8); mark(A.flip, 'FLIP', '#f0a020', bot + 12);
    c.textAlign = 'left'; c.fillStyle = C.txt2;
    c.fillText(`Celková dealer gamma podle ceny (bílá = do 45 dní${B ? ', zlatá = jen 0DTE' : ''}). Peak ${A.peak ? A.peak.toFixed(2) : '—'} · ceiling ${A.ceiling ?? '—'} · floor ${A.floor ?? '—'} · režim ${A.regime === 'positive' ? '+γ' : '−γ'}`, L, 6);
    c.textAlign = 'right'; c.fillStyle = C.txt; c.fillText(fmtM(g1), L - 4, Y(g1)); c.fillText('0', L - 4, Y(0)); c.fillText(fmtM(g0), L - 4, Y(g0));
  }

  // ── Flow: CVD line + bid/ask volume profile + TPO
  function flow(cv, F, o) {
    const { c, w, h } = setup(cv);
    if (!F) return empty(c, w, h, 'Žádná data.');
    const cvd = F.cvd_series || [], half = Math.floor(w * 0.55), L = 8;
    if (cvd.length > 1) {
      const vs = cvd.map(p => p[1]), v0 = Math.min(...vs), v1 = Math.max(...vs), top = 20, bot = h - 20;
      const X = i => L + i * (half - L - 10) / (cvd.length - 1), Y = v => top + (v1 - v) / (v1 - v0 || 1) * (bot - top);
      c.fillStyle = 'rgba(255,255,255,.2)'; if (v0 < 0 && v1 > 0) c.fillRect(L, Y(0), half - L - 10, 1);
      c.strokeStyle = vs[vs.length - 1] >= 0 ? `rgb(${C.pos})` : `rgb(${C.neg})`; c.lineWidth = 1.5;
      c.beginPath(); cvd.forEach((p, i) => i ? c.lineTo(X(i), Y(p[1])) : c.moveTo(X(i), Y(p[1]))); c.stroke();
      c.fillStyle = C.txt2; c.textAlign = 'left'; c.fillText(`CVD session: ${fmtM(vs[vs.length - 1])} kontraktů`, L, 8);
      c.fillStyle = C.txt; c.fillText(o.label(cvd[0][0]), L, h - 8); c.textAlign = 'right'; c.fillText(o.label(cvd[cvd.length - 1][0]), half - 10, h - 8);
    }
    const P = (F.profile_rth && F.profile_rth.rows.length ? F.profile_rth : F.profile_eth) || { rows: [] };
    if (P.rows.length) {
      const rows = P.rows, top = 20, bot = h - 8, x0 = half + 50, W = w - x0 - 8;
      const p0 = rows[0][0], p1 = rows[rows.length - 1][0], Y = p => top + (p1 - p) / (p1 - p0 || 1) * (bot - top), rh = Math.max(2, (bot - top) / rows.length - 1);
      const mx = Math.max(...rows.map(r => r[1] + r[2])) || 1;
      const tpo = new Map(((F.tpo && F.tpo.rows) || []).map(r => [r[0], r[1]]));
      c.fillStyle = C.txt2; c.textAlign = 'left'; c.fillText(`Profil ${P === F.profile_rth ? 'RTH' : 'ETH'} · POC ${P.poc} · VA ${P.val}–${P.vah}`, x0, 8);
      for (const [p, b, a] of rows) {
        const y = Y(p) - rh / 2, lb = b / mx * W, la = a / mx * W;
        c.fillStyle = `rgba(${C.neg},.7)`; c.fillRect(x0, y, lb, rh); c.fillStyle = `rgba(${C.pos},.7)`; c.fillRect(x0 + lb, y, la, rh);
        if (p === P.poc) { c.strokeStyle = C.gold; c.strokeRect(x0 - 1, y - 1, lb + la + 2, rh + 2); }
        if ((P.lvn || []).includes(p)) { c.fillStyle = 'rgba(168,85,247,.25)'; c.fillRect(half, y, w - half, rh); }
        if (rh >= 8) { c.fillStyle = C.txt; c.textAlign = 'right'; c.fillText(String(p), x0 - 4, y + rh / 2); }
        const t = tpo.get(p); if (t && rh >= 8) { c.fillStyle = 'rgba(201,166,107,.75)'; c.textAlign = 'left'; c.fillText(t, x0 + lb + la + 4, y + rh / 2); }
      }
    }
  }

  // ── Options flow: cumulative bullish vs bearish premium + net delta (left), net premium by strike (right)
  function optflow(cv, D, o) {
    const { c, w, h } = setup(cv);
    if (!D || !D.series || !D.series.length) return empty(c, w, h, 'Zatím žádné obchody s opcemi (stream ' + ((D && D.stream) || '—') + ').');
    const S = D.summary, ser = D.series, half = Math.floor(w * 0.6), L = 8, top = 34, bot = h - 18;
    // header stats
    c.textAlign = 'left'; c.fillStyle = C.txt2;
    const bias = S.bias || 0, bc = bias > 0.1 ? `rgb(${C.pos})` : bias < -0.1 ? `rgb(${C.neg})` : C.gold;
    c.fillText(`Bullish ${fmtM(S.bull)} $  ·  Bearish ${fmtM(S.bear)} $  ·  P/C prémie ${S.pc_prem != null ? S.pc_prem.toFixed(2) : '—'}  ·  Sweepy ${S.sweeps} · Bloky ${S.blocks}`, L, 9);
    c.fillStyle = bc; c.fillText(`NET ${S.net >= 0 ? '+' : ''}${fmtM(S.net)} $ (${(bias * 100).toFixed(0)} %)  ·  0DTE ${S.net_0d >= 0 ? '+' : ''}${fmtM(S.net_0d)} $  ·  Δ ${S.delta >= 0 ? '+' : ''}${fmtM(S.delta)} akcií${S.delta_nq != null ? ` ≈ ${S.delta_nq >= 0 ? '+' : ''}${S.delta_nq.toFixed(0)} NQ` : ''}`, L, 23);
    // cumulative premium lines
    const X = i => L + i * (half - L - 50) / Math.max(1, ser.length - 1);
    const vmax = Math.max(1, ...ser.map(r => Math.max(r[1], r[2])));
    const Y = v => top + (1 - v / vmax) * (bot - top);
    const dv = ser.map(r => r[3]), d0 = Math.min(0, ...dv), d1 = Math.max(0, ...dv);
    const YD = v => top + (d1 - v) / (d1 - d0 || 1) * (bot - top);
    c.strokeStyle = C.grid; c.lineWidth = 1;
    for (let i = 0; i <= 4; i++) { const y = top + i * (bot - top) / 4; c.beginPath(); c.moveTo(L, y); c.lineTo(half - 50, y); c.stroke(); c.fillStyle = C.txt; c.textAlign = 'left'; c.fillText(fmtM(vmax * (1 - i / 4)), half - 46, y); }
    const line = (idx, col, Yf, wdt) => { c.strokeStyle = col; c.lineWidth = wdt; c.beginPath(); ser.forEach((r, i) => i ? c.lineTo(X(i), Yf(r[idx])) : c.moveTo(X(i), Yf(r[idx]))); c.stroke(); };
    c.fillStyle = 'rgba(201,166,107,.35)'; if (d0 < 0 && d1 > 0) c.fillRect(L, YD(0), half - L - 50, 1);
    line(3, 'rgba(201,166,107,.85)', YD, 1);
    line(1, `rgb(${C.pos})`, Y, 2); line(2, `rgb(${C.neg})`, Y, 2);
    c.fillStyle = C.txt; c.textAlign = 'left'; c.fillText(o.label(ser[0][0]), L, h - 7); c.textAlign = 'right'; c.fillText(o.label(ser[ser.length - 1][0]), half - 50, h - 7);
    c.textAlign = 'left'; c.fillStyle = `rgb(${C.pos})`; c.fillText('■ bullish $', L + 80, h - 7); c.fillStyle = `rgb(${C.neg})`; c.fillText('■ bearish $', L + 170, h - 7); c.fillStyle = C.gold; c.fillText('— Δ akcie', L + 260, h - 7);
    // net premium by strike (axis in NQ)
    const rows = (D.strikes || []).filter(r => r.contracts > 0);
    if (rows.length) {
      const x0 = half + 70, W = w - x0 - 8, mid = x0 + W / 2, mx = Math.max(1, ...rows.map(r => Math.abs(r.net)));
      const p0 = rows[0].strike, p1 = rows[rows.length - 1].strike, YS = p => top + (p1 - p) / (p1 - p0 || 1) * (bot - top), rh = Math.max(2, Math.min(12, (bot - top) / rows.length - 1));
      c.fillStyle = C.txt2; c.textAlign = 'left'; c.fillText('Net prémie po strikech (call+put, bull − bear)', half + 10, top - 12);
      c.fillStyle = 'rgba(255,255,255,.15)'; c.fillRect(mid, top, 1, bot - top);
      const step = Math.max(1, Math.ceil(rows.length / Math.max(1, (bot - top) / 12)));
      rows.forEach((r, i) => { const y = YS(r.strike) - rh / 2, len = Math.abs(r.net) / mx * (W / 2);
        c.fillStyle = r.net >= 0 ? `rgba(${C.pos},.8)` : `rgba(${C.neg},.8)`; c.fillRect(r.net >= 0 ? mid : mid - len, y, len, rh);
        if (i % step === 0 || Math.abs(r.net) > mx * 0.5) { c.fillStyle = Math.abs(r.net) > mx * 0.5 ? C.txt2 : C.txt; c.textAlign = 'right'; c.fillText(`${r.strike} · ${r.nq ? r.nq.toFixed(0) : ''}`, x0 - 4, y + rh / 2); }
        if (Math.abs(r.net) > mx * 0.5) { const t = fmtM(r.net), tw = c.measureText(t).width, out = r.net >= 0 ? mid + len + 3 + tw < w : mid - len - 3 - tw > x0; c.textAlign = (r.net >= 0) === out ? 'left' : 'right'; c.fillStyle = out ? C.txt2 : C.bg; c.fillText(t, r.net >= 0 ? (out ? mid + len + 3 : mid + len - 3) : (out ? mid - len - 3 : mid - len + 3), y + rh / 2); } });
      if (S.spot && S.spot >= p0 && S.spot <= p1) { const y = YS(S.spot); c.strokeStyle = C.white; c.setLineDash([4, 3]); c.beginPath(); c.moveTo(x0, y); c.lineTo(w - 8, y); c.stroke(); c.setLineDash([]); }
    }
  }

  // ── Options flow: net premium by strike (bull − bear) with QQQ reference levels; hit regions for hover
  function flowStrikes(cv, D, o) {
    const { c, w, h } = setup(cv);
    const rows = (D && D.strikes || []).filter(r => r.contracts > 0);
    if (!rows.length) return empty(c, w, h, 'Zatím žádné obchody po strikech.');
    const top = 26, bot = h - 10, x0 = 74, W = w - x0 - 10, mid = x0 + W / 2, mx = Math.max(1, ...rows.map(r => Math.abs(r.net)));
    const p0 = rows[0].strike, p1 = rows[rows.length - 1].strike, Y = p => top + (p1 - p) / (p1 - p0 || 1) * (bot - top);
    const rh = Math.max(2, Math.min(12, (bot - top) / rows.length - 1));
    c.fillStyle = C.txt2; c.textAlign = 'left'; c.fillText('Net prémie po strikech · bull − bear', 8, 10);
    // QQQ reference levels (dashed, behind the bars)
    const grp = new Map(); for (const L of o.levels || []) { const k = Math.round(L.q * 100) / 100, g = grp.get(k); if (g) g.label += ' · ' + L.label; else grp.set(k, { ...L, q:k }); }
    for (const L of grp.values()) {
      if (L.q < p0 - 0.5 || L.q > p1 + 0.5) continue;
      const y = Y(L.q); c.strokeStyle = L.col; c.globalAlpha = 0.6; c.setLineDash([4, 4]); c.beginPath(); c.moveTo(x0, y); c.lineTo(w - 8, y); c.stroke(); c.setLineDash([]); c.globalAlpha = 1;
      c.fillStyle = L.col; c.textAlign = 'right'; c.fillText(L.label, w - 10, y - 7);
    }
    c.fillStyle = 'rgba(255,255,255,.12)'; c.fillRect(mid, top, 1, bot - top);
    const step = Math.max(1, Math.ceil(rows.length / Math.max(1, (bot - top) / 13)));
    cv._hits = [];
    rows.forEach((r, i) => {
      const y = Y(r.strike) - rh / 2, len = Math.abs(r.net) / mx * (W / 2 - 4);
      const hot = o.hover === r.strike;
      c.fillStyle = r.net >= 0 ? `rgba(${C.pos},${hot ? 1 : .78})` : `rgba(${C.neg},${hot ? 1 : .78})`;
      c.fillRect(r.net >= 0 ? mid : mid - len, y, Math.max(1, len), rh);
      cv._hits.push({ y: y + rh / 2, r });
      if (i % step === 0 || Math.abs(r.net) > mx * 0.5 || hot) { c.fillStyle = Math.abs(r.net) > mx * 0.5 || hot ? C.txt2 : C.txt; c.textAlign = 'right'; c.fillText(`${r.strike}${r.nq ? ' · ' + r.nq.toFixed(0) : ''}`, x0 - 4, y + rh / 2); }
    });
    if (o.spot && o.spot >= p0 && o.spot <= p1) { const y = Y(o.spot); c.strokeStyle = C.white; c.setLineDash([2, 3]); c.beginPath(); c.moveTo(x0, y); c.lineTo(w - 8, y); c.stroke(); c.setLineDash([]); c.fillStyle = C.white; c.textAlign = 'left'; c.fillText('QQQ ' + o.spot.toFixed(2), x0 + 4, y - 7); }
  }

  // ── Customer contracts per minute × strike (mentor's map): spikes up = customers buying, down = selling;
  //    QQQ price path on top, net drift (cumulative customer delta) strip at the bottom; hit cells for hover
  function customer(cv, D, o) {
    const { c, w, h } = setup(cv);
    const cells = (D && D.cells) || [];
    if (!cells.length) return empty(c, w, h, 'Zatím žádné obchody zákazníků (customer flow).');
    const L = 8, R = w - 74, top = 22, driftH = Math.min(150, h * 0.3), bot = h - 18 - driftH - 8;
    const ks0 = cells.map(x => x[1]).sort((x, y) => x - y), mid = ks0[ks0.length >> 1];
    const path = (o.bars || []).filter(b => b.t >= cells[0][0] - 60 && Math.abs(b.c / mid - 1) < 0.04);
    const t0 = Math.min(cells[0][0], path.length ? path[0].t : Infinity), t1 = Math.max(cells[cells.length - 1][0] + 60, path.length ? path[path.length - 1].t : 0);
    const ks = cells.map(x => x[1]), pv = path.map(b => b.c);
    let lo = Math.min(...ks, ...pv), hi = Math.max(...ks, ...pv); lo -= 0.5; hi += 0.5;
    const X = t => L + (t - t0) / (t1 - t0 || 1) * (R - L), Y = p => top + (hi - p) / (hi - lo || 1) * (bot - top);
    const thr = Math.max(1, D.threshold || 1), mx = Math.max(thr, D.tallest || thr), row = (bot - top) / Math.max(1, hi - lo);
    c.fillStyle = C.txt2; c.textAlign = 'left';
    c.fillText(`Customer contracts / min · ▲ nákup  ▼ prodej · spike ≥ ${Math.round(thr)} kontr./min · max ${Math.round(mx)}`, L, 9);
    // strike grid + labels (QQQ · NQ)
    const step = row >= 12 ? 1 : row >= 6 ? 2 : 5;
    c.textAlign = 'left';
    for (let k = Math.ceil(lo / step) * step; k <= hi; k += step) { const y = Y(k);
      c.fillStyle = k % 5 === 0 ? '#1b2029' : C.grid; c.fillRect(L, y, R - L, 1);
      c.fillStyle = k % 5 === 0 ? C.txt2 : C.txt; c.fillText(`${k}${o.k ? ' · ' + Math.round(k * o.k) : ''}`, R + 4, y); }
    for (const L0 of o.levels || []) { if (L0.q < lo || L0.q > hi) continue; const y = Y(L0.q); c.strokeStyle = L0.col; c.globalAlpha = .5; c.setLineDash([4, 4]); c.beginPath(); c.moveTo(L, y); c.lineTo(R, y); c.stroke(); c.setLineDash([]); c.globalAlpha = 1; }
    // spikes
    cv._cells = [];
    const bw = Math.max(1, Math.min(4, (R - L) / ((t1 - t0) / 60) * 0.6)), maxLen = Math.max(8, row * 3);
    for (const [t, k, cn, pn] of cells) {
      const n = cn + pn, m = Math.abs(cn) + Math.abs(pn); if (!n) continue;
      const big = m >= thr, x = X(t + 30), y = Y(k), len = Math.max(1.5, Math.min(maxLen, Math.sqrt(m / mx) * maxLen));
      c.fillStyle = n > 0 ? `rgba(${C.pos},${big ? .95 : .28})` : `rgba(${C.neg},${big ? .95 : .28})`;
      c.fillRect(x - bw / 2, n > 0 ? y - len : y, bw, len);
      cv._cells.push({ x, y, t, k, cn, pn, big });
    }
    // price path
    if (path.length) { c.strokeStyle = C.white; c.lineWidth = 1.4; c.beginPath(); path.forEach((b, i) => i ? c.lineTo(X(b.t + 30), Y(b.c)) : c.moveTo(X(b.t + 30), Y(b.c))); c.stroke();
      const lb = path[path.length - 1]; c.fillStyle = C.white; c.textAlign = 'right'; c.fillText(`QQQ ${lb.c.toFixed(2)}`, R - 2, Y(lb.c) - 9); }
    if (o.hover) { c.strokeStyle = 'rgba(255,255,255,.35)'; c.setLineDash([2, 3]); c.beginPath(); c.moveTo(o.hover.x, top); c.lineTo(o.hover.x, bot); c.stroke(); c.setLineDash([]); }
    // net drift strip (QuantData style): cumulative bought − sold premium, calls green / puts red, net volume shaded below
    const dr = (D.drift || []).filter(r => r[0] >= t0), dt = bot + 8, db = dt + driftH;
    if (dr.length > 1 && dr[0].length >= 5) {
      const vals = dr.flatMap(r => [r[2], r[3]]), d0 = Math.min(0, ...vals), d1 = Math.max(0, ...vals), YD = v => dt + (d1 - v) / (d1 - d0 || 1) * (db - dt);
      const vv = dr.map(r => r[4]), vm = Math.max(1, ...vv.map(Math.abs)), vb = db, YV = v => vb - Math.abs(v) / vm * driftH * 0.35;
      c.fillStyle = 'rgba(255,95,162,.12)'; dr.forEach(r => { if (r[4] < 0) c.fillRect(X(r[0]), YV(r[4]), Math.max(1, (R - L) / ((t1 - t0) / 60)), vb - YV(r[4])); });
      c.fillStyle = 'rgba(94,224,200,.12)'; dr.forEach(r => { if (r[4] > 0) c.fillRect(X(r[0]), YV(r[4]), Math.max(1, (R - L) / ((t1 - t0) / 60)), vb - YV(r[4])); });
      c.fillStyle = C.grid; c.fillRect(L, YD(0), R - L, 1);
      const ln = (i, col) => { c.strokeStyle = col; c.lineWidth = 1.5; c.beginPath(); dr.forEach((r, j) => j ? c.lineTo(X(r[0] + 30), YD(r[i])) : c.moveTo(X(r[0] + 30), YD(r[i]))); c.stroke(); };
      ln(2, `rgb(${C.pos})`); ln(3, `rgb(${C.neg})`);
      const lr = dr[dr.length - 1];
      c.textAlign = 'left'; c.fillStyle = C.txt2; c.fillText(`Net drift${D.otm ? ' (OTM)' : ''}:`, L + 2, dt + 6);
      c.fillStyle = `rgb(${C.pos})`; c.fillText(`Calls ${lr[2] >= 0 ? '+' : ''}${fmtM(lr[2])} $`, L + 100, dt + 6);
      c.fillStyle = `rgb(${C.neg})`; c.fillText(`Puts ${lr[3] >= 0 ? '+' : ''}${fmtM(lr[3])} $`, L + 210, dt + 6);
      c.fillStyle = C.txt; c.fillText(`net vol ${lr[4] >= 0 ? '+' : ''}${fmtM(lr[4])}${D.excluded ? ` · vyřazeno ${fmtM(D.excluded)} complex/tied/floor/cancel/late` : ''}`, L + 320, dt + 6);
      c.textAlign = 'right'; c.fillText(fmtM(d1), R + 40, dt + 4); c.fillText(fmtM(d0), R + 40, db - 4);
    }
    c.fillStyle = C.txt; c.textAlign = 'center';
    const lt = o.label || (t => String(t)); const span = t1 - t0, tick = span > 4 * 3600 ? 3600 : span > 3600 ? 1800 : 600;
    for (let t = Math.ceil(t0 / tick) * tick; t <= t1; t += tick) c.fillText(lt(t), X(t), h - 7);
    cv._geo = { X, Y, t0, t1 };
  }

  // ── footprint overlay on the main chart: "bid × ask" per price inside each visible bar
  function footprint(cv, bars, map, o) {
    const dpr = window.devicePixelRatio || 1, w = o.w, h = o.h;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + 'px'; cv.style.height = h + 'px'; }
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    if (!bars || !bars.length || o.spacing < 34) return;
    c.font = `${Math.max(8, Math.min(11, o.spacing / 6))}px JetBrains Mono, monospace`; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const b of bars) {
      if (!b.fp) continue;
      const x = map.x(b); if (x == null || x < -o.spacing || x > w + o.spacing) continue;
      const vmax = Math.max(1, ...b.fp.map(r => r[1] + r[2]));
      for (const [p, bid, ask] of b.fp) {
        const y = map.y(p); if (y == null || y < 0 || y > h) continue;
        const imbA = ask >= 3 * Math.max(1, bid), imbB = bid >= 3 * Math.max(1, ask);
        c.fillStyle = `rgba(160,168,180,${0.05 + 0.25 * (bid + ask) / vmax})`;
        c.fillRect(x - o.spacing * 0.45, y - o.row / 2, o.spacing * 0.9, o.row - 1);
        c.fillStyle = imbB ? `rgb(${C.neg})` : '#9aa1ab'; c.fillText(String(bid), x - o.spacing * 0.2, y);
        c.fillStyle = imbA ? `rgb(${C.pos})` : '#9aa1ab'; c.fillText(String(ask), x + o.spacing * 0.2, y);
      }
    }
  }

  // ── Breakdown By Strike (Options Depth style): net customer position per strike in contracts (bought − sold since the
  //    open), calls green / puts red / net blue, QQQ strikes with NQ alongside, price line, premarket levels dashed
  function breakdown(cv, D, o) {
    const { c, w, h } = setup(cv);
    const spot = D && D.spot, k = o.k || (D && D.k);
    const rows = ((D && D.pos) || []).filter(r => r[1] || r[2]).map(r => ({ K: +r[0], c: +r[1] || 0, p: +r[2] || 0, n: (+r[1] || 0) + (+r[2] || 0) }))
      .filter(r => !spot || Math.abs(r.K / spot - 1) <= (o.pct || 0.025)).sort((a, b) => b.K - a.K);
    cv._rows = [];
    if (!rows.length) return empty(c, w, h, 'Zatím žádné obchody zákazníků v tomhle rozsahu.');
    const L = 96, R = w - 16, top = 34, bot = h - 26, mid = L + (R - L) / 2;
    const mx = Math.max(1, ...rows.flatMap(r => [Math.abs(r.c), Math.abs(r.p), Math.abs(r.n)]));
    const K0 = rows[rows.length - 1].K, K1 = rows[0].K, Y = K => top + (K1 - K) / (K1 - K0 || 1) * (bot - top);
    const rh = Math.max(4, Math.min(22, (bot - top) / Math.max(1, rows.length) - 2));
    const X = v => mid + v / mx * ((R - L) / 2 - 6);
    c.textAlign = 'left'; c.fillStyle = C.txt2;
    c.fillText(`Breakdown By Strike · net customer position (kontrakty) · ${o.title || '0DTE'}`, 8, 10);
    [['Calls', `rgb(52,211,90)`], ['Puts', `rgb(244,67,54)`], ['Net', `rgb(66,133,244)`]].forEach(([t, col], i) => { const x = 8 + i * 70; c.fillStyle = col; c.fillRect(x, 20, 10, 8); c.fillStyle = C.txt; c.fillText(t, x + 14, 24); });
    // x grid
    const stp = nice(2 * mx); c.textAlign = 'center';
    for (let v = -Math.floor(mx / stp) * stp; v <= mx; v += stp) { const x = X(v); c.fillStyle = v === 0 ? 'rgba(255,255,255,.25)' : C.grid; c.fillRect(x, top - 4, 1, bot - top + 8); c.fillStyle = C.txt; c.fillText(fmtM(v), x, h - 10); }
    // premarket levels behind the bars
    for (const lv of o.levels || []) { if (lv.q < K0 - 0.5 || lv.q > K1 + 0.5) continue; const y = Y(lv.q);
      c.strokeStyle = lv.col || C.gold; c.globalAlpha = .55; c.setLineDash([5, 4]); c.beginPath(); c.moveTo(L, y); c.lineTo(R, y); c.stroke(); c.setLineDash([]); c.globalAlpha = 1;
      c.fillStyle = lv.col || C.gold; c.textAlign = 'right'; c.fillText(lv.label, R - 2, y - 7); }
    const step = Math.max(1, Math.ceil(rows.length / Math.max(1, (bot - top) / 14)));
    rows.forEach((r, i) => {
      const y = Y(r.K), hot = o.hover === r.K, bh = Math.max(2, rh * 0.42);
      if (hot) { c.fillStyle = 'rgba(255,255,255,.06)'; c.fillRect(L, y - rh / 2 - 1, R - L, rh + 2); }
      const bar = (v, y0, hh, col) => { const x0 = X(0), x1 = X(v); c.fillStyle = col; c.fillRect(Math.min(x0, x1), y0, Math.max(1, Math.abs(x1 - x0)), hh); };
      bar(r.c, y - bh - 0.5, bh, `rgba(52,211,90,${hot ? 1 : .85})`);
      bar(r.p, y + 0.5, bh, `rgba(244,67,54,${hot ? 1 : .85})`);
      bar(r.n, y - 1, 2, `rgba(66,133,244,${hot ? 1 : .9})`);
      cv._rows.push({ y0: y - rh / 2 - 1, y1: y + rh / 2 + 1, r });
      if (i % step === 0 || hot || Math.abs(r.n) > mx * 0.6 || r.K % 5 === 0) {
        c.textAlign = 'right'; c.fillStyle = hot || r.K % 5 === 0 ? C.txt2 : C.txt;
        c.fillText(`${r.K}${k ? ' · ' + Math.round(r.K * k).toLocaleString('en-US') : ''}`, L - 6, y);
      }
    });
    // price line
    if (spot && spot >= K0 - 1 && spot <= K1 + 1) {
      const y = Y(spot); c.strokeStyle = 'rgba(244,67,54,.9)'; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(L, y); c.lineTo(R, y); c.stroke(); c.setLineDash([]);
      const t = `QQQ ${spot.toFixed(2)}${k ? ' · ' + Math.round(spot * k).toLocaleString('en-US') : ''}`, tw = c.measureText(t).width + 8;
      c.fillStyle = 'rgb(244,67,54)'; c.fillRect(L - tw - 2, y - 8, tw, 16); c.fillStyle = '#fff'; c.textAlign = 'left'; c.fillText(t, L - tw + 2, y);
    }
  }

  // ── IV surface in 3D (strike × days to expiry × implied vol, plasma colours) — painter's algorithm on a 2D canvas,
  //    rotate by dragging (o.rot = { yaw, pitch, zoom })
  const PLASMA = [[13,8,135],[75,3,161],[125,3,168],[168,34,150],[203,70,121],[229,107,93],[248,148,65],[253,195,40],[240,249,33]];
  const plasma = t => { t = Math.max(0, Math.min(1, t)) * (PLASMA.length - 1); const i = Math.min(PLASMA.length - 2, Math.floor(t)), f = t - i, a = PLASMA[i], b = PLASMA[i + 1];
    return [0, 1, 2].map(j => Math.round(a[j] + (b[j] - a[j]) * f)); };
  function surface3d(cv, G, o) {
    const { c, w, h } = setup(cv);
    if (!G || !G.iv || G.iv.length < 2 || !G.strikes || G.strikes.length < 3) return empty(c, w, h, 'Málo dat pro IV povrch (čekám na IV z options serveru).');
    const rot = o.rot || { yaw: -0.75, pitch: 0.55, zoom: 1 };
    const K = G.strikes, Dd = G.dte, V = G.iv, nI = Dd.length, nJ = K.length;
    const all = V.flat().filter(Number.isFinite).sort((a, b) => a - b);
    const zLo = Math.max(0, all[Math.floor(all.length * 0.01)] * 0.95), zHi = all[Math.floor(all.length * 0.985)] * 1.03;
    const dMax = Math.max(...Dd), kLo = K[0], kHi = K[nJ - 1];
    const nx = x => (x - kLo) / (kHi - kLo) * 2 - 1, ny = d => d / (dMax || 1) * 2 - 1, nz = v => (Math.min(zHi, Math.max(zLo, v)) - zLo) / (zHi - zLo || 1) * 1.25;
    const cy = Math.cos(rot.yaw), sy = Math.sin(rot.yaw), cp = Math.cos(rot.pitch), sp = Math.sin(rot.pitch);
    const sc = Math.min(w, h) * 0.30 * (rot.zoom || 1), ox = w / 2, oy = h * 0.60;
    const P = (x, y, z) => { const X1 = x * cy - y * sy, Y1 = x * sy + y * cy; return { x: ox + X1 * sc, y: oy - (z * cp + Y1 * sp) * sc, d: Y1 * cp - z * sp }; };
    // back walls + floor grid (drawn first, behind the surface)
    c.lineWidth = 1;
    const line = (a, b, col) => { c.strokeStyle = col; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); };
    const fl = 'rgba(255,255,255,.10)';
    for (let i = 0; i <= 8; i++) { const t = -1 + i / 4; line(P(t, -1, 0), P(t, 1, 0), fl); line(P(-1, t, 0), P(1, t, 0), fl); }
    // the two walls facing away from the viewer
    const wx = P(1, 0, 0).d > P(-1, 0, 0).d ? 1 : -1, wy = P(0, 1, 0).d > P(0, -1, 0).d ? 1 : -1;
    for (let i = 0; i <= 4; i++) { const z = i / 4 * 1.25; line(P(-1, wy, z), P(1, wy, z), fl); line(P(wx, -1, z), P(wx, 1, z), fl); }
    for (let i = 0; i <= 4; i++) { const t = -1 + i / 2; line(P(t, wy, 0), P(t, wy, 1.25), fl); line(P(wx, t, 0), P(wx, t, 1.25), fl); }
    // quads, farthest first
    const pts = V.map((row, i) => row.map((v, j) => Number.isFinite(v) ? P(nx(K[j]), ny(Dd[i]), nz(v)) : null));
    const quads = [];
    for (let i = 0; i < nI - 1; i++) for (let j = 0; j < nJ - 1; j++) {
      const q = [pts[i][j], pts[i][j + 1], pts[i + 1][j + 1], pts[i + 1][j]]; if (q.some(p => !p)) continue;
      const v = (V[i][j] + V[i][j + 1] + V[i + 1][j + 1] + V[i + 1][j]) / 4;
      quads.push({ q, d: (q[0].d + q[1].d + q[2].d + q[3].d) / 4, t: (v - zLo) / (zHi - zLo || 1) });
    }
    quads.sort((a, b) => b.d - a.d);
    for (const Q of quads) {
      const [r, g, b] = plasma(Q.t);
      c.fillStyle = `rgb(${r},${g},${b})`; c.strokeStyle = 'rgba(255,255,255,.28)'; c.lineWidth = 0.6;
      c.beginPath(); c.moveTo(Q.q[0].x, Q.q[0].y); for (let n = 1; n < 4; n++) c.lineTo(Q.q[n].x, Q.q[n].y); c.closePath(); c.fill(); c.stroke();
    }
    // ATM line (spot strike across expiries)
    if (G.spot && G.spot > kLo && G.spot < kHi) {
      const j = K.findIndex(x => x >= G.spot), f = j > 0 ? (G.spot - K[j - 1]) / (K[j] - K[j - 1]) : 0;
      c.strokeStyle = 'rgba(255,255,255,.95)'; c.lineWidth = 1.6; c.beginPath();
      V.forEach((row, i) => { const v = j > 0 ? row[j - 1] + (row[j] - row[j - 1]) * f : row[0]; if (!Number.isFinite(v)) return; const p = P(nx(G.spot), ny(Dd[i]), nz(v)); i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y); });
      c.stroke(); c.lineWidth = 1;
      const lv = V[V.length - 1], va = j > 0 ? lv[j - 1] + (lv[j] - lv[j - 1]) * f : lv[0];
      if (Number.isFinite(va)) { const p = P(nx(G.spot), ny(Dd[Dd.length - 1]), nz(va)); c.fillStyle = C.white; c.textAlign = 'left'; c.fillText(`ATM ${G.spot.toFixed(2)}`, p.x + 6, p.y - 8); }
    }
    // axis labels: strikes along the near floor edge, DTE along the other near edge, IV on the back corner
    c.fillStyle = C.txt2; c.textAlign = 'center';
    const ey = -wy, ex = -wx;
    for (let i = 0; i <= 4; i++) { const kk = kLo + (kHi - kLo) * i / 4, p = P(nx(kk), ey * 1.12, 0); c.fillText(`${kk.toFixed(0)}${G.k ? ' · ' + Math.round(kk * G.k / 10) * 10 : ''}`, p.x, p.y + 8); }
    for (let i = 0; i <= 4; i++) { const dd = dMax * i / 4, p = P(ex * 1.16, ny(dd), 0); c.fillText(dd < 1 ? '0' : dd.toFixed(0), p.x, p.y + 6); }
    for (let i = 0; i <= 4; i++) { const v = zLo + (zHi - zLo) * i / 4, p = P(wx, wy, nz(v)); c.textAlign = 'left'; c.fillText((v * 100).toFixed(0) + ' %', p.x + 6, p.y); }
    const pk = P(0, ey * 1.34, 0), pd = P(ex * 1.62, 0, 0), pz = P(wx, wy, 1.42);
    c.fillStyle = C.txt; c.textAlign = 'center'; c.fillText('Strike (QQQ · NQ)', pk.x, pk.y + 8); c.fillText('Dny do expirace', pd.x, pd.y + 6); c.fillText('Implied volatility', pz.x, pz.y);
    // colour bar
    const bx = w - 26, by0 = 40, by1 = h - 60;
    for (let y = by0; y < by1; y++) { const [r, g, b] = plasma(1 - (y - by0) / (by1 - by0)); c.fillStyle = `rgb(${r},${g},${b})`; c.fillRect(bx, y, 10, 1); }
    c.fillStyle = C.txt; c.textAlign = 'right'; c.fillText((zHi * 100).toFixed(0) + ' %', bx - 4, by0 + 4); c.fillText((zLo * 100).toFixed(0) + ' %', bx - 4, by1 - 4);
    c.textAlign = 'left'; c.fillStyle = C.txt2; c.fillText(o.title || 'IV povrch', 8, 12);
    c.fillStyle = C.txt; c.fillText('táhni = otočit · kolečko = zoom · dvojklik = výchozí pohled', 8, h - 10);
  }

  root.Pro = { levelsChart, matrix, vol, landscape, flow, optflow, flowStrikes, customer, breakdown, surface3d, footprint, fmtM };
})(typeof window !== 'undefined' ? window : globalThis);
