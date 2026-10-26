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

  root.Pro = { levelsChart, matrix, vol, landscape, flow, optflow, flowStrikes, footprint, fmtM };
})(typeof window !== 'undefined' ? window : globalThis);
