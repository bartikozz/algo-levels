/* Analysis drawings: Strike Profile columns, GEX "Surfaces" heatmap, Backtest equity curves.
 * Pure canvas drawing, no app state. window.Analysis = { drawStrikes, drawHeat, drawEquity }
 */
(function (root) {
  'use strict';
  const C = { bg: '#07080a', grid: '#141820', txt: '#7b828c', txt2: '#c9ccd2', pos: '94,224,200', neg: '255,95,162', gold: '#c9a66b' };
  const FONT = '10px JetBrains Mono, monospace';

  function setup(cv) {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = C.bg; c.fillRect(0, 0, w, h); c.font = FONT; c.textBaseline = 'middle';
    return { c, w, h };
  }
  const fmt = v => Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v).toString();
  const niceStep = range => { const r = range / 8, p = Math.pow(10, Math.floor(Math.log10(r))); return [1, 2, 2.5, 5, 10].map(x => x * p).find(x => x >= r) || p * 10; };

  // ── Strike Profile: one column per expiry/metric, bars right = +GEX (teal), left = −GEX (pink)
  function drawStrikes(cv, cols, o) {
    const { c, w, h } = setup(cv);
    const top = 34, bot = h - 8, ax = 56, gap = 10;
    const lo = o.lo, hi = o.hi, Y = p => top + (hi - p) / (hi - lo) * (bot - top);
    // price grid
    const st = niceStep(hi - lo);
    c.fillStyle = C.txt; c.textAlign = 'right';
    for (let p = Math.ceil(lo / st) * st; p <= hi; p += st) {
      const y = Y(p); c.fillStyle = C.grid; c.fillRect(ax, y, w - ax, 1); c.fillStyle = C.txt; c.fillText(p.toFixed(0), ax - 6, y);
    }
    const n = cols.length, cw = (w - ax - gap * (n + 1)) / n;
    cols.forEach((col, i) => {
      const x0 = ax + gap + i * (cw + gap), xm = x0 + cw / 2;
      const vis = (col.strikes || []).filter(s => s[0] >= lo && s[0] <= hi && Number.isFinite(s[1]));
      const mx = Math.max(1e-9, ...vis.map(s => Math.abs(s[1])));
      const sorted = [...vis].sort((a, b) => a[0] - b[0]);
      let sp = Infinity; for (let k = 1; k < sorted.length; k++) sp = Math.min(sp, sorted[k][0] - sorted[k - 1][0]);
      const th = Math.max(1.5, Math.min(10, (Number.isFinite(sp) ? sp : 25) / (hi - lo) * (bot - top) * 0.75));
      c.fillStyle = 'rgba(255,255,255,.06)'; c.fillRect(xm, top, 1, bot - top);
      for (const [p, v] of vis) {
        const len = Math.abs(v) / mx * (cw / 2 - 2), y = Y(p);
        c.fillStyle = `rgba(${v >= 0 ? C.pos : C.neg},${0.35 + 0.6 * Math.abs(v) / mx})`;
        c.fillRect(v >= 0 ? xm : xm - len, y - th / 2, len, th);
      }
      // biggest +/− strike label
      const bp = vis.filter(s => s[1] > 0).sort((a, b) => b[1] - a[1])[0], bn = vis.filter(s => s[1] < 0).sort((a, b) => a[1] - b[1])[0];
      c.textAlign = 'center'; c.fillStyle = C.txt2; c.fillText(col.title, xm, 10);
      c.fillStyle = C.txt; c.fillText(`${bp ? '+' + bp[0].toFixed(0) : ''}${bp && bn ? '  ' : ''}${bn ? '−' + bn[0].toFixed(0) : ''}`, xm, 23);
      c.textAlign = 'left';
      if (bp) { c.fillStyle = `rgb(${C.pos})`; c.fillText(fmt(bp[1]), xm + 3, Y(bp[0]) - 9); }
      if (bn) { c.fillStyle = `rgb(${C.neg})`; c.textAlign = 'right'; c.fillText(fmt(bn[1]), xm - 3, Y(bn[0]) + 9); }
    });
    for (const l of o.levels || []) {
      const y = Y(l.p); if (y < top || y > bot) continue;
      c.setLineDash(l.dash ? [5, 4] : []); c.strokeStyle = l.color; c.lineWidth = 1; c.beginPath(); c.moveTo(ax, y); c.lineTo(w, y); c.stroke(); c.setLineDash([]);
      c.fillStyle = l.color; c.textAlign = 'right'; c.fillText(l.label, w - 4, y - 7);
    }
  }

  // ── Surfaces: GEX by strike over time (x = time, y = strike), price path on top
  function drawHeat(cv, rows, path, o) {
    const { c, w, h } = setup(cv);
    const top = 10, bot = h - 22, ax = 56, rx = w - 6;
    if (!rows.length) { c.fillStyle = C.txt; c.textAlign = 'center'; c.fillText('Zatím žádná historie GEX pro tento den.', w / 2, h / 2); return; }
    const lo = o.lo, hi = o.hi, t0 = o.t0, t1 = o.t1;
    const X = t => ax + (t - t0) / Math.max(1, t1 - t0) * (rx - ax), Y = p => top + (hi - p) / (hi - lo) * (bot - top);
    let mx = 1e-9; for (const r of rows) for (const s of r.hs) if (s[0] >= lo && s[0] <= hi) mx = Math.max(mx, Math.abs(s[1]));
    rows.forEach((r, i) => {
      const xa = X(r.t), xb = i + 1 < rows.length ? X(rows[i + 1].t) : Math.min(rx, xa + Math.max(3, (rx - ax) / 60));
      const hs = r.hs.filter(s => s[0] >= lo - 50 && s[0] <= hi + 50).sort((a, b) => a[0] - b[0]);
      hs.forEach((s, k) => {
        const pa = k > 0 ? (s[0] + hs[k - 1][0]) / 2 : s[0] - 12.5, pb = k + 1 < hs.length ? (s[0] + hs[k + 1][0]) / 2 : s[0] + 12.5;
        const a = Math.sqrt(Math.abs(s[1]) / mx);
        if (a < 0.04) return;
        c.fillStyle = `rgba(${s[1] >= 0 ? C.pos : C.neg},${Math.min(0.95, a)})`;
        c.fillRect(xa, Y(pb), Math.max(1, xb - xa + 0.5), Math.max(1, Y(pa) - Y(pb)));
      });
    });
    // axes
    c.fillStyle = C.txt; c.textAlign = 'right';
    const st = niceStep(hi - lo);
    for (let p = Math.ceil(lo / st) * st; p <= hi; p += st) { const y = Y(p); c.fillStyle = 'rgba(255,255,255,.05)'; c.fillRect(ax, y, rx - ax, 1); c.fillStyle = C.txt; c.fillText(p.toFixed(0), ax - 6, y); }
    c.textAlign = 'center';
    const span = t1 - t0, tstep = span > 4 * 3600 ? 3600 : span > 3600 ? 1800 : 600;
    for (let t = Math.ceil(t0 / tstep) * tstep; t <= t1; t += tstep) c.fillText(o.label(t), X(t), h - 9);
    // price path
    const pts = (path || []).filter(b => b.t >= t0 && b.t <= t1);
    if (pts.length > 1) {
      c.strokeStyle = 'rgba(255,255,255,.9)'; c.lineWidth = 1.3; c.beginPath();
      pts.forEach((b, i) => { const x = X(b.t), y = Y(b.c); i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.stroke();
    }
    for (const l of o.levels || []) {
      const y = Y(l.p); if (y < top || y > bot) continue;
      c.setLineDash([5, 4]); c.strokeStyle = l.color; c.beginPath(); c.moveTo(ax, y); c.lineTo(rx, y); c.stroke(); c.setLineDash([]);
      c.fillStyle = l.color; c.textAlign = 'right'; c.fillText(l.label, rx - 2, y - 7);
    }
  }

  // ── Backtest: cumulative R per setup over time
  function drawEquity(cv, series, o) {
    const { c, w, h } = setup(cv);
    const top = 12, bot = h - 22, ax = 8, rx = w - 52;
    const all = series.flatMap(s => s.pts);
    if (!all.length) { c.fillStyle = C.txt; c.textAlign = 'center'; c.fillText('Žádné obchody.', w / 2, h / 2); return; }
    const t0 = Math.min(...all.map(p => p.t)), t1 = Math.max(...all.map(p => p.t));
    const vmin = Math.min(0, ...all.map(p => p.v)), vmax = Math.max(1, ...all.map(p => p.v));
    const X = t => ax + (t - t0) / Math.max(1, t1 - t0) * (rx - ax), Y = v => top + (vmax - v) / (vmax - vmin) * (bot - top);
    const st = niceStep(vmax - vmin);
    c.textAlign = 'left';
    for (let v = Math.ceil(vmin / st) * st; v <= vmax; v += st) { const y = Y(v); c.fillStyle = v === 0 ? 'rgba(255,255,255,.18)' : C.grid; c.fillRect(ax, y, rx - ax, 1); c.fillStyle = C.txt; c.fillText((v >= 0 ? '+' : '') + v.toFixed(0) + 'R', rx + 6, y); }
    c.textAlign = 'center';
    const months = new Set();
    for (const p of all) { const d = new Date(p.t * 1000); months.add(d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0')); }
    const ms = [...months].sort(), every = Math.max(1, Math.ceil(ms.length / 8));
    ms.forEach((m, i) => { if (i % every) return; const t = Date.parse(m + '-01T00:00:00Z') / 1000; if (t < t0) return; c.fillStyle = C.txt; c.fillText(m.slice(2).replace('-', '/'), X(t), h - 9); });
    for (const s of series) {
      if (s.pts.length < 1) continue;
      c.strokeStyle = s.color; c.lineWidth = s.hl ? 2 : 1.1; c.globalAlpha = s.hl ? 1 : 0.75; c.beginPath();
      c.moveTo(X(s.pts[0].t), Y(0));
      for (const p of s.pts) c.lineTo(X(p.t), Y(p.v));
      c.stroke(); c.globalAlpha = 1;
      const lp = s.pts[s.pts.length - 1]; c.fillStyle = s.color; c.beginPath(); c.arc(X(lp.t), Y(lp.v), s.hl ? 3 : 2, 0, 7); c.fill();
    }
  }

  root.Analysis = { drawStrikes, drawHeat, drawEquity };
})(typeof window !== 'undefined' ? window : globalThis);
