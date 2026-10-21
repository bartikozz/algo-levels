// ════════════════════════════════════════════════════════════════
//  Algo Levels — core engine (no DOM). Used by index.html, testable in node.
//  Input: NQ 1m bars, NQ daily bars, VIX daily, GEXbot classic responses.
//  Output: clustered confluence levels with tags, direction and status.
// ════════════════════════════════════════════════════════════════
(function (root) {
  'use strict';

  // ───────── ET time helpers
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const etCache = new Map();
  function et(t) {
    let p = etCache.get(t);
    if (p) return p;
    const o = {};
    for (const x of fmt.formatToParts(new Date(t * 1000))) o[x.type] = x.value;
    const h = (+o.hour) % 24, mi = +o.minute;
    p = {
      date: `${o.year}-${o.month}-${o.day}`, h, mi, min: h * 60 + mi,
      disp: Date.UTC(+o.year, +o.month - 1, +o.day, h, mi) / 1000, // ET wall-clock as "UTC" for the chart
    };
    if (etCache.size > 50000) etCache.clear();
    etCache.set(t, p);
    return p;
  }
  // Globex trading date: 18:00 ET starts the next trading day
  const tdate = t => et(t + 6 * 3600).date;
  const isRTH = t => { const m = et(t).min; return m >= 570 && m < 960; };
  const hhmm = t => { const p = et(t); return String(p.h).padStart(2, '0') + ':' + String(p.mi).padStart(2, '0'); };

  // ───────── Yahoo chart JSON → bars
  function parseYF(j) {
    const r = j && j.chart && j.chart.result && j.chart.result[0];
    if (!r || !r.timestamp) return [];
    const q = r.indicators.quote[0];
    const out = [];
    r.timestamp.forEach((t, i) => {
      if (q.open[i] == null || q.close[i] == null || q.high[i] == null || q.low[i] == null) return;
      out.push({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
    });
    return out;
  }

  // ───────── Volume profile (POC / VAH / VAL, 70 %)
  function volumeProfile(bars, step) {
    if (!bars.length) return null;
    const m = new Map();
    for (const b of bars) {
      const lo = Math.floor(b.l / step), hi = Math.floor(b.h / step), n = hi - lo + 1;
      for (let k = lo; k <= hi; k++) m.set(k, (m.get(k) || 0) + (b.v || 1) / n);
    }
    const keys = [...m.keys()].sort((a, b) => a - b);
    const tot = keys.reduce((s, k) => s + m.get(k), 0);
    if (!tot) return null;
    let pi = 0;
    keys.forEach((k, i) => { if (m.get(k) > m.get(keys[pi])) pi = i; });
    let lo = pi, hi = pi, acc = m.get(keys[pi]);
    while (acc < tot * 0.7 && (lo > 0 || hi < keys.length - 1)) {
      const up = hi < keys.length - 1 ? m.get(keys[hi + 1]) : -1;
      const dn = lo > 0 ? m.get(keys[lo - 1]) : -1;
      if (up >= dn) { hi++; acc += up; } else { lo--; acc += dn; }
    }
    return { poc: (keys[pi] + 0.5) * step, vah: (keys[hi] + 1) * step, val: keys[lo] * step };
  }

  // ───────── GEX walls from classic strikes [strike, gex_vol, gex_oi, priors]
  function walls(resp, idx, n) {
    const s = ((resp && resp.strikes) || [])
      .map(x => [x[0], x[idx]])
      .filter(x => Number.isFinite(x[0]) && Number.isFinite(x[1]));
    return {
      pos: s.filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, n),
      neg: s.filter(x => x[1] < 0).sort((a, b) => a[1] - b[1]).slice(0, n),
    };
  }

  // ───────── Candidate levels from every layer
  function buildCandidates(ctx, S) {
    const { bars, daily, vix, gex: g, last, today } = ctx;
    const L = S.layers;
    const c = [];
    const info = {};
    const add = (p, tag, w, src) => { if (Number.isFinite(p) && p > 0) c.push({ p, tag, w, src }); };
    // NQ_NDX should already be in NQ terms; if spot is far from NQ, shift by basis
    const off = r => (r && Number.isFinite(r.spot) && Math.abs(r.spot - last) > 40) ? last - r.spot : 0;
    const calToday = et(bars[bars.length - 1].t).date;

    // 0DTE
    if (L.gex0 && g.zero) {
      const o = off(g.zero), w = walls(g.zero, 1, 3);
      w.pos.forEach((x, i) => add(x[0] + o, `0DTE CW ${i + 1}`, [3, 2, 1.5][i], 'opt'));
      w.neg.forEach((x, i) => add(x[0] + o, `0DTE PW ${i + 1}`, [3, 2, 1.5][i], 'opt'));
      add(g.zero.zero_gamma + o, '0DTE ZG', 2, 'opt');
    }
    // 1DTE
    if (L.gex1 && g.one) {
      const o = off(g.one), w = walls(g.one, 1, 2);
      w.pos.forEach((x, i) => add(x[0] + o, `1DTE CW ${i + 1}`, [2, 1][i], 'opt'));
      w.neg.forEach((x, i) => add(x[0] + o, `1DTE PW ${i + 1}`, [2, 1][i], 'opt'));
    }
    // Full chain
    if (L.gexFull && g.full) {
      const o = off(g.full), w = walls(g.full, 1, 3);
      w.pos.forEach((x, i) => add(x[0] + o, `CW ${i + 1}`, [2.5, 1.5, 1][i], 'opt'));
      w.neg.forEach((x, i) => add(x[0] + o, `PW ${i + 1}`, [2.5, 1.5, 1][i], 'opt'));
      add(g.full.zero_gamma + o, 'ZG', 2.5, 'opt');
      add(g.full.major_pos_oi + o, 'OI CW', 2, 'opt');
      add(g.full.major_neg_oi + o, 'OI PW', 2, 'opt');
    }
    // Biggest GEX change in last 15 min (0DTE)
    if (L.maxchg && g.mx && Array.isArray(g.mx.fifteen) && Number.isFinite(g.mx.fifteen[0])) {
      add(g.mx.fifteen[0] + off(g.zero || g.full), 'ΔGEX 15m', 1.5, 'opt');
    }
    // QQQ → NQ (live ratio), walls only on 0/5 strikes
    const kq = g.qqq && g.qqq.spot > 0 ? last / g.qqq.spot : NaN;
    if (kq > 20 && kq < 80) { // sanity: NQ/QQQ ≈ 41
      const k = kq;
      info.ratio = k;
      const wallStrikes = new Set();
      if (L.qqq) {
        const w = walls({ strikes: (g.qqq.strikes || []).filter(x => Math.round(x[0] * 100) % 500 === 0) }, 2, 2);
        w.pos.forEach((x, i) => { wallStrikes.add(x[0]); add(x[0] * k, `QQQ CW ${x[0]}`, [2, 1][i], 'qqq'); });
        w.neg.forEach((x, i) => { wallStrikes.add(x[0]); add(x[0] * k, `QQQ PW ${x[0]}`, [2, 1][i], 'qqq'); });
      }
      if (L.qqqMain) {
        const s = g.qqq.spot;
        for (let q = Math.ceil(s * 0.98 / 5) * 5; q <= s * 1.02; q += 5) {
          if (!wallStrikes.has(q)) add(q * k, `QQQ ${q}`, 1, 'qqq');
        }
      }
    }

    const todayBars = bars.filter(b => tdate(b.t) === today);
    const rthBars = todayBars.filter(b => isRTH(b.t));

    // VIX expected move, RTH-open anchor
    if (L.em && vix && vix.length) {
      const v = [...vix].reverse().find(b => et(b.t).date < calToday);
      if (v && v.c > 5 && v.c < 100) {
        const anchor = rthBars.length ? rthBars[0].o : last;
        const em = anchor * v.c / 100 / 15.87;
        info.em = { anchor, em, vix: v.c, provisional: !rthBars.length };
        [[-1, 'EM −1'], [-0.5, 'EM −½'], [0.5, 'EM +½'], [1, 'EM +1']]
          .forEach(([m, t]) => add(anchor + m * em, t, 1.5, 'em'));
      }
    }

    // σ Grid: 20-day stdev of daily log returns, Globex-open anchor
    if (L.sigma && daily && daily.length) {
      const d = daily.filter(b => et(b.t).date < calToday).map(b => b.c);
      if (d.length > 21) {
        const r = [];
        for (let i = d.length - 20; i < d.length; i++) r.push(Math.log(d[i] / d[i - 1]));
        const m = r.reduce((a, b) => a + b, 0) / r.length;
        const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
        const anc = todayBars.length ? todayBars[0].o : last;
        const sp = anc * sd;
        info.sigma = { anchor: anc, pts: sp };
        [[-1, 'σ −1'], [-0.5, 'σ −½'], [0.5, 'σ +½'], [1, 'σ +1']]
          .forEach(([k, t]) => add(anc + k * sp, t, Math.abs(k) === 1 ? 1.5 : 1, 'sig'));
      }
    }

    // Previous RTH volume profile
    if (L.vp) {
      const dates = [...new Set(bars.filter(b => isRTH(b.t)).map(b => tdate(b.t)))].sort();
      const prev = dates.filter(d => d < today).pop();
      if (prev) {
        const vp = volumeProfile(bars.filter(b => tdate(b.t) === prev && isRTH(b.t)), 5);
        if (vp) {
          info.vp = vp;
          add(vp.poc, 'pPOC', 1.5, 'vp');
          add(vp.vah, 'pVAH', 1, 'vp');
          add(vp.val, 'pVAL', 1, 'vp');
        }
      }
    }
    return { cands: c, info };
  }

  // ───────── Confluence clustering
  function cluster(c, tol) {
    const s = [...c].sort((a, b) => a.p - b.p);
    const groups = [];
    let cur = null;
    for (const x of s) {
      if (cur && x.p - cur.items[cur.items.length - 1].p <= tol && x.p - cur.lo <= tol * 2) cur.items.push(x);
      else { cur = { lo: x.p, items: [x] }; groups.push(cur); }
    }
    const rank = x => x.w + (x.src === 'opt' ? 0.01 : 0); // ties → options strike wins
    return groups.map(k => {
      const best = k.items.reduce((a, b) => (rank(b) > rank(a) ? b : a));
      const score = k.items.reduce((sum, x) => sum + x.w, 0);
      const tags = [...k.items].sort((a, b) => b.w - a.w).map(x => x.tag);
      return {
        price: Math.round(best.p * 4) / 4,
        score: Math.round(score * 10) / 10,
        tags: [...new Set(tags)],
        n: k.items.length,
        srcs: [...new Set(k.items.map(x => x.src))],
      };
    });
  }

  // ───────── Reaction / break status of one level over a bar series
  function statusOf(price, last, bars, S) {
    const L = price, short = L > last;
    const ev = [];
    let i = 0;
    const inZone = b => short ? b.h >= L - S.touch : b.l <= L + S.touch;
    while (i < bars.length) {
      if (!inZone(bars[i])) { i++; continue; }
      const t0 = bars[i].t;
      let res = null, j = i;
      for (; j < Math.min(bars.length, i + S.lookahead); j++) {
        const x = bars[j];
        if (short ? x.c > L + S.brk : x.c < L - S.brk) { res = 'broken'; break; }
        if (short ? x.l <= L - S.react : x.h >= L + S.react) { res = 'reacted'; break; }
      }
      if (res) {
        ev.push({ type: res, t: t0, tEnd: bars[j].t });
        i = j + 1;
        while (i < bars.length && inZone(bars[i])) i++; // re-arm only after leaving the zone
      } else if (j >= bars.length) {
        ev.push({ type: 'testing', t: t0 });
        break;
      } else {
        i = j; // stalled in zone without resolution
      }
    }
    return ev;
  }

  function summarize(ev) {
    if (!ev.length) return { key: 'untested', text: 'Untested' };
    const lastEv = ev[ev.length - 1];
    const reacts = ev.filter(e => e.type === 'reacted').length;
    if (lastEv.type === 'testing') return { key: 'testing', text: 'Testing' + (reacts ? ` · R×${reacts}` : '') };
    if (lastEv.type === 'broken') return { key: 'broken', text: `Broken ${hhmm(lastEv.t)}` };
    return { key: 'reacted', text: `Reacted ${hhmm(lastEv.t)}${reacts > 1 ? ' ×' + reacts : ''}` };
  }

  // ───────── Full pipeline
  function compute(data, S) {
    const bars = data.bars || [];
    if (!bars.length) return null;
    const last = bars[bars.length - 1].c;
    const today = tdate(bars[bars.length - 1].t);
    const { cands, info } = buildCandidates({ ...data, last, today }, S);
    const lo = last * (1 - S.range / 100), hi = last * (1 + S.range / 100);
    const todayBars = bars.filter(b => tdate(b.t) === today);
    const rth = todayBars.filter(b => isRTH(b.t));
    const scan = (S.scanRTH && rth.length) ? rth : todayBars;

    const levels = cluster(cands.filter(x => x.p > lo && x.p < hi), S.tol)
      .filter(l => l.score >= S.minScore)
      .map(l => {
        const ev = statusOf(l.price, last, scan, S);
        return {
          ...l,
          dir: Math.abs(l.price - last) <= S.touch ? 0 : (l.price > last ? -1 : 1),
          dist: l.price - last,
          events: ev,
          status: summarize(ev),
        };
      })
      .sort((a, b) => b.price - a.price);

    const z = data.gex && (data.gex.zero || data.gex.full);
    const pick = (...v) => v.find(Number.isFinite);
    const net = z ? pick(z.sum_gex_vol, z.net_gex_vol, z.sum_gex_oi, z.net_gex_oi) : NaN;
    return {
      last, today, levels, info,
      regime: Number.isFinite(net) ? Math.sign(net) : 0,
      gexTs: z && z.timestamp,
      candCount: cands.length,
    };
  }

  // ───────── Demo data (synthetic) to preview the UI without a worker
  function makeDemo(seed) {
    let s = seed || 7;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const gauss = () => { let u = 0; for (let k = 0; k < 6; k++) u += rnd(); return u - 3; };
    const now = Math.floor(Date.now() / 60000) * 60;
    const bars = [];
    let p = 29400;
    for (let t = now - 3 * 86400; t <= now; t += 60) {
      const m = et(t).min;
      if (m >= 17 * 60 && m < 18 * 60) continue;           // CME maintenance hour
      const wd = new Date(t * 1000).getUTCDay();
      if (wd === 6) continue;
      const vol = isRTH(t) ? 6 : 2.2;
      const o = p;
      p += gauss() * vol + (29400 - p) * 0.004;
      const h = Math.max(o, p) + Math.abs(gauss()) * vol * 0.6;
      const l = Math.min(o, p) - Math.abs(gauss()) * vol * 0.6;
      bars.push({ t, o, h, l, c: p, v: Math.round((isRTH(t) ? 900 : 150) * (0.5 + rnd())) });
    }
    const last = bars[bars.length - 1].c;
    const strikes = (center, step, n, scale) => {
      const out = [];
      const c0 = Math.round(center / step) * step;
      for (let k = -n; k <= n; k++) {
        const k0 = c0 + k * step;
        const base = (k > 0 ? 1 : -1) * Math.exp(-Math.abs(k) / 6) * scale * (0.4 + rnd());
        const spike = rnd() > 0.85 ? (k > 0 ? 1 : -1) * scale * 2.5 * rnd() : 0;
        const v = base + spike;
        out.push([k0, +v.toFixed(2), +(v * (0.6 + rnd() * 0.8)).toFixed(2), [v, v, v, v, v]]);
      }
      return out;
    };
    const ts = Math.floor(Date.now() / 1000);
    const mk = (scale) => ({
      timestamp: ts, ticker: 'NQ_NDX', spot: last, zero_gamma: last - 40 + rnd() * 30,
      strikes: strikes(last, 25, 20, scale), sum_gex_vol: 1500 * (rnd() > 0.25 ? 1 : -1),
      major_pos_oi: Math.round((last + 150) / 25) * 25, major_neg_oi: Math.round((last - 175) / 25) * 25,
    });
    const qSpot = last / 41.5;
    const daily = [], vix = [];
    let dp = 27000, vp = 17;
    for (let k = 120; k >= 1; k--) {
      const t = now - k * 86400;
      dp *= Math.exp(gauss() * 0.011); vp = Math.max(11, vp + gauss() * 0.6);
      daily.push({ t, o: dp, h: dp, l: dp, c: dp, v: 0 });
      vix.push({ t, o: vp, h: vp, l: vp, c: vp, v: 0 });
    }
    return {
      bars, daily, vix,
      gex: {
        zero: mk(220), one: mk(140), full: mk(600),
        qqq: { timestamp: ts, ticker: 'QQQ', spot: qSpot, strikes: strikes(qSpot, 1, 20, 300) },
        mx: { timestamp: ts, fifteen: [Math.round((last + 60) / 25) * 25, 820] },
      },
    };
  }

  const API = { makeDemo, et, tdate, isRTH, hhmm, parseYF, volumeProfile, walls, buildCandidates, cluster, statusOf, summarize, compute };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.AlgoLevels = API;
})(typeof window !== 'undefined' ? window : globalThis);
