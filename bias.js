/* Bias engine — Fed liquidity + COT → probability that the NY session (QQQ RTH open→close) closes up.
 * Every factor is evaluated point-in-time (only data that was already published that morning),
 * its historical up-rate per state is measured on QQQ daily bars, shrunk toward the base rate,
 * and the states are combined in log-odds with a damping factor fitted out-of-sample.
 * Pure functions, no DOM. window.Bias = { parseFred, parseCot, build, ... }
 */
(function (root) {
  'use strict';
  const DAY = 86400;
  const etDate = t => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(t * 1000));
  const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const logit = p => Math.log(p / (1 - p));
  const sigm = x => 1 / (1 + Math.exp(-x));
  const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const std = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))) || 0; };

  // ── parsing
  // FRED graph CSV: "observation_date,ID\n2024-01-03,123.4\n" ('.' or '' = missing)
  function parseFred(csv) {
    const out = [];
    if (/^\s*\{/.test(csv)) { // FRED API JSON {observations:[{date,value}]}
      try { for (const o of JSON.parse(csv).observations || []) { const x = parseFloat(o.value); if (Number.isFinite(x)) out.push({ d: o.date, v: x }); } } catch (e) {}
      return out;
    }
    for (const line of String(csv || '').split(/\r?\n/).slice(1)) {
      const [d, v] = line.split(',');
      const x = parseFloat(v);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(x)) out.push({ d, v: x });
    }
    return out;
  }
  // to billions of USD whatever FRED's unit is (WALCL is millions, RRP billions, TGA varies)
  const toBn = (rows, typicalBn) => {
    if (!rows.length) return rows;
    const last = rows[rows.length - 1].v;
    const k = last > typicalBn * 50 ? 1 / 1000 : 1;
    return rows.map(r => ({ d: r.d, v: r.v * k }));
  };
  // Treasury Daily Statement → TGA closing balance (bn); account naming changed over the years
  function parseTga(rows) {
    const by = new Map();
    for (const r of rows || []) {
      const d = r.record_date, t = r.account_type || '';
      let v = null, pr = 0;
      if (/TGA\) Closing Balance/.test(t)) { v = +r.open_today_bal; pr = 3; }
      else if (t === 'Treasury General Account (TGA)') { v = +r.close_today_bal; pr = 2; }
      else if (t === 'Federal Reserve Account') { v = +r.close_today_bal; pr = 1; }
      if (!Number.isFinite(v) || !pr) continue;
      const cur = by.get(d); if (!cur || pr > cur.pr) by.set(d, { v: v / 1000, pr });
    }
    return [...by].map(([d, x]) => ({ d, v: x.v })).sort((a, b) => a.d < b.d ? -1 : 1);
  }
  // NY Fed ON RRP operations → daily total accepted (bn)
  function parseRrp(j) {
    const by = new Map();
    for (const o of (j && j.repo && j.repo.operations) || []) {
      if (!/Reverse Repo/i.test(o.operationType || '')) continue;
      const d = o.operationDate, v = +o.totalAmtAccepted;
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(v)) by.set(d, (by.get(d) || 0) + v / 1e9);
    }
    return [...by].map(([d, v]) => ({ d, v })).sort((a, b) => a.d < b.d ? -1 : 1);
  }
  function parseCot(rows) {
    return (rows || []).map(r => ({
      d: String(r.report_date_as_yyyy_mm_dd || '').slice(0, 10),
      lev: (+r.lev_money_positions_long) - (+r.lev_money_positions_short),
      am: (+r.asset_mgr_positions_long) - (+r.asset_mgr_positions_short),
      oi: +r.open_interest_all,
    })).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.d) && Number.isFinite(r.lev) && Number.isFinite(r.am) && r.oi > 0)
      .sort((a, b) => a.d < b.d ? -1 : 1);
  }

  // ── point-in-time series: value known on the morning of session date S
  // lag = calendar days after the observation date when it is safely public before 09:30 ET
  function asOf(rows, lag) {
    const av = rows.map(r => ({ a: addDays(r.d, lag), d: r.d, v: r.v }));
    return S => { // last row whose availability date <= S (binary search)
      let lo = 0, hi = av.length - 1, ans = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (av[m].a <= S) { ans = m; lo = m + 1; } else hi = m - 1; }
      return ans < 0 ? null : { i: ans, row: av[ans], rows: av };
    };
  }
  const back = (hit, n) => hit && hit.i - n >= 0 ? hit.rows[hit.i - n] : null;

  // ── factor definitions: value(S) → number (or null); state from value via deadband
  function makeFactors(src) {
    const F = [];
    const walcl = asOf(src.WALCL, 2), tga = asOf(src.WTREGEN, 2), rrp = asOf(src.RRPONTSYD, 1);
    const res = asOf(src.WRESBAL, 2), hy = asOf(src.HY, 1), cot = asOf(src.COT.map(r => ({ d: r.d, v: r })), 6);
    // net liquidity = Fed balance sheet − TGA − RRP (bn), evaluated as of a date
    // (if WALCL is unavailable, the slow-moving Fed balance sheet is treated as constant)
    const hasW = src.WALCL.length > 0;
    const netAt = S => { const a = hasW ? walcl(S) : { row: { v: 0 } }, b = tga(S), c = rrp(S); return a && b && c ? a.row.v - b.row.v - c.row.v : null; };
    const at = fn => S => { const h = fn(S); return h ? h.row.v : null; };
    const chg = (fn, S, days) => { const a = fn(S), b = fn(addDays(S, -days)); return a == null || b == null ? null : a - b; };
    const val = h => h ? h.row.v : null;

    F.push({ id: 'nl1w', name: 'Net likvidita 1 týden', unit: 'mld $', grp: 'Fed',
      value: S => chg(netAt, S, 7), hint: hasW ? 'WALCL − TGA − RRP, změna za 7 dní' : '− TGA − RRP (bez WALCL), změna za 7 dní' });
    F.push({ id: 'nl4w', name: 'Net likvidita 4 týdny', unit: 'mld $', grp: 'Fed',
      value: S => chg(netAt, S, 28), hint: 'trend likvidity za 4 týdny' });
    F.push({ id: 'res', name: 'Rezervy bank (H.4.1)', unit: 'mld $', grp: 'Fed',
      value: S => { const h = res(S), p = back(h, 1); return h && p ? h.row.v - p.v : null; }, hint: 'WRESBAL týden/týden' });
    F.push({ id: 'rrp', name: 'Reverse repo 1 týden', unit: 'mld $', grp: 'Fed',
      value: S => chg(at(rrp), S, 7), hint: 'NY Fed ON RRP; pokles = likvidita do trhu' });
    F.push({ id: 'tga', name: 'TGA 1 týden', unit: 'mld $', grp: 'Fed',
      value: S => chg(at(tga), S, 7), hint: 'Treasury DTS; růst TGA = odčerpání likvidity' });
    F.push({ id: 'hy5', name: 'HY spread 5 dní', unit: 'b.b.', grp: 'Kredit', invert: true,
      value: S => { const h = hy(S), p = back(h, 5); return h && p ? (h.row.v - p.v) * 100 : null; }, hint: 'ICE BofA HY OAS, rozšiřování = risk-off' });
    F.push({ id: 'hyl', name: 'HY spread vs 50d průměr', unit: 'b.b.', grp: 'Kredit', invert: true,
      value: S => { const h = hy(S); if (!h || h.i < 50) return null; const w = h.rows.slice(h.i - 49, h.i + 1).map(r => r.v); return (h.row.v - mean(w)) * 100; } });
    F.push({ id: 'levw', name: 'COT Lev. Funds net Δ', unit: 'kontr.', grp: 'COT',
      value: S => { const h = cot(S), p = back(h, 1); return h && p ? h.row.v.lev - p.v.lev : null; }, hint: 'hedge fondy, změna net pozice za týden' });
    F.push({ id: 'amw', name: 'COT Asset Mgr net Δ', unit: 'kontr.', grp: 'COT',
      value: S => { const h = cot(S), p = back(h, 1); return h && p ? h.row.v.am - p.v.am : null; }, hint: 'instituce, změna net pozice za týden' });
    F.push({ id: 'levx', name: 'COT Lev. Funds index (3r)', unit: '%', grp: 'COT',
      value: S => { const h = cot(S); if (!h || h.i < 52) return null; const w = h.rows.slice(Math.max(0, h.i - 155), h.i + 1).map(r => r.v.lev);
        const lo = Math.min(...w), hi = Math.max(...w); return hi > lo ? (h.row.v.lev - lo) / (hi - lo) * 100 : null; },
      fixed: [20, 80], hint: 'kde je net pozice v 3letém rozsahu (0–100)' });
    F.push({ id: 'amx', name: 'COT Asset Mgr index (3r)', unit: '%', grp: 'COT',
      value: S => { const h = cot(S); if (!h || h.i < 52) return null; const w = h.rows.slice(Math.max(0, h.i - 155), h.i + 1).map(r => r.v.am);
        const lo = Math.min(...w), hi = Math.max(...w); return hi > lo ? (h.row.v.am - lo) / (hi - lo) * 100 : null; },
      fixed: [20, 80] });
    return F;
  }

  const stateOf = (f, v) => {
    if (v == null || !Number.isFinite(v)) return null;
    if (f.fixed) return v <= f.fixed[0] ? -1 : v >= f.fixed[1] ? 1 : 0;
    return v > f.band ? 1 : v < -f.band ? -1 : 0;
  };

  // per-state up-rates on a set of sample indices, shrunk toward the base rate (m pseudo-obs)
  function fitTable(f, samples, idx, base, m) {
    const t = { '-1': [0, 0], '0': [0, 0], '1': [0, 0] };
    for (const i of idx) { const s = samples[i].st[f.id]; if (s == null) continue; t[s][0] += samples[i].y; t[s][1]++; }
    const out = {};
    for (const k of ['-1', '0', '1']) { const [u, n] = t[k]; const p = (u + m * base) / (n + m); out[k] = { n, up: n ? u / n : NaN, p, llr: logit(p) - logit(base) }; }
    return out;
  }
  const predict = (tables, st, base, lam) => {
    let z = logit(base); const parts = {};
    for (const id in tables) { const s = st[id]; if (s == null) continue; const c = tables[id][s].llr * lam; parts[id] = c; z += c; }
    return { p: sigm(z), parts };
  };

  /** build({fred:{WALCL,WTREGEN,RRPONTSYD,WRESBAL,HY}, cot:[...], qqq:[{t,o,c}], now, horizon:1|5}) */
  function build(o) {
    const H = o.horizon || 1;
    const src = {
      WALCL: toBn(o.fred.WALCL || [], 7000), WTREGEN: o.tga || toBn(o.fred.WTREGEN || [], 800), RRPONTSYD: o.rrp || toBn(o.fred.RRPONTSYD || [], 500),
      WRESBAL: toBn(o.fred.WRESBAL || [], 3000), HY: o.fred.HY || [], COT: o.cot || [],
    };
    const F = makeFactors(src);
    // sessions: QQQ daily bars = RTH open→close; target = close[i+H-1] > open[i]
    const nowS = etDate(o.now || Date.now() / 1000);
    const nowET = new Date(new Date((o.now || Date.now() / 1000) * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const afterClose = nowET.getHours() * 60 + nowET.getMinutes() >= 16 * 60;
    const bars = (o.qqq || []).map(b => ({ S: etDate(b.t), o: b.o, c: b.c })).filter(b => b.o > 0 && b.c > 0);
    const done = bars.filter(b => b.S < nowS || (b.S === nowS && afterClose));
    const samples = [];
    for (let i = 0; i + H - 1 < done.length; i++) {
      const S = done[i].S, ret = done[i + H - 1].c / done[i].o - 1;
      const v = {}; for (const f of F) v[f.id] = f.value(S);
      samples.push({ S, y: ret > 0 ? 1 : 0, ret, v });
    }
    // deadband per factor = 0.25 σ of its historical values (ignores tiny noise moves)
    for (const f of F) { const xs = samples.map(s => s.v[f.id]).filter(Number.isFinite); f.band = 0.25 * std(xs); f.nAll = xs.length; }
    for (const s of samples) { s.st = {}; for (const f of F) s.st[f.id] = stateOf(f, s.v[f.id]); }
    const usable = samples.map((s, i) => i).filter(i => Object.values(samples[i].st).some(x => x != null));
    const m = H === 1 ? 60 : 150; // stronger shrinkage for overlapping multi-day targets
    // out-of-sample check: fit on first 65 %, test on the rest, pick damping λ by test log-loss
    const cut = Math.floor(usable.length * 0.65), tr = usable.slice(0, cut), te = usable.slice(cut);
    const baseTr = mean(tr.map(i => samples[i].y)) || 0.5;
    const tabTr = {}; for (const f of F) tabTr[f.id] = fitTable(f, samples, tr, baseTr, m);
    let best = { lam: 0, ll: Infinity };
    for (const lam of [0, 0.15, 0.3, 0.5, 0.75, 1]) {
      let ll = 0; for (const i of te) { const p = predict(tabTr, samples[i].st, baseTr, lam).p; ll -= samples[i].y ? Math.log(p) : Math.log(1 - p); }
      if (ll < best.ll) best = { lam, ll };
    }
    // test hit rate of the model's calls vs simply always betting the majority side
    let hit = 0, nCall = 0, hitBase = 0;
    if (best.lam > 0) for (const i of te) {
      const p = predict(tabTr, samples[i].st, baseTr, best.lam).p; if (Math.abs(p - baseTr) < 0.01) continue;
      nCall++; if ((p > 0.5) === (samples[i].y === 1)) hit++; if ((baseTr > 0.5) === (samples[i].y === 1)) hitBase++;
    }
    const llBase = te.reduce((s, i) => s - (samples[i].y ? Math.log(baseTr) : Math.log(1 - baseTr)), 0);
    // final model on all data
    const base = mean(usable.map(i => samples[i].y)) || 0.5;
    const tab = {}; for (const f of F) tab[f.id] = fitTable(f, samples, usable, base, m);
    const lam = best.lam;
    // today's (or next) session: data public by this morning
    const target = afterClose || [0, 6].includes(nowET.getDay()) ? nextSession(nowS, afterClose) : nowS;
    const cur = {}, vals = {};
    for (const f of F) { vals[f.id] = f.value(target); cur[f.id] = stateOf(f, vals[f.id]); }
    const pr = predict(tab, cur, base, lam);
    const raw = predict(tab, cur, base, 0.3); // indicative only (fixed damping), shown when the tested model finds no edge
    const factors = F.map(f => {
      const s = cur[f.id], row = s == null ? null : tab[f.id][s];
      return { id: f.id, name: f.name, grp: f.grp, unit: f.unit, hint: f.hint, value: vals[f.id], state: s,
        up: row ? row.up : NaN, n: row ? row.n : 0, contrib: (lam > 0 ? pr.parts[f.id] : raw.parts[f.id]) || 0, edge: row ? row.p - base : 0 };
    });
    const last = k => { const r = src[k]; return r && r.length ? r[r.length - 1].d : null; };
    return {
      horizon: H, target, p: pr.p, pRaw: raw.p, base, lam,
      side: pr.p > 0.51 ? 'bull' : pr.p < 0.49 ? 'bear' : 'flat', strength: Math.abs(pr.p - base), sideRaw: raw.p >= base ? 'bull' : 'bear',
      factors: factors.sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib)),
      oos: { n: te.length, calls: nCall, hit: nCall ? hit / nCall : NaN, hitBase: nCall ? hitBase / nCall : NaN, lam, gain: llBase - best.ll, from: te.length ? samples[te[0]].S : null },
      samples: usable.length, from: usable.length ? samples[usable[0]].S : null,
      fresh: { h41: last('WALCL') || last('WRESBAL'), rrp: last('RRPONTSYD'), tga: last('WTREGEN'), hy: last('HY'), cot: src.COT.length ? src.COT[src.COT.length - 1].d : null },
      netLiq: (() => { const v = []; const wa = src.WALCL.length ? src.WALCL : src.WTREGEN.filter((r, i) => i % 5 === 0); for (const r of wa.slice(-60)) { const S = addDays(r.d, 2); const a = src.WALCL.length ? asOf(src.WALCL, 2)(S) : { row: { v: 0 } }, b = asOf(src.WTREGEN, 2)(S), c = asOf(src.RRPONTSYD, 1)(S); if (a && b && c) v.push({ d: r.d, v: a.row.v - b.row.v - c.row.v }); } return v; })(),
    };
  }
  function nextSession(S, afterClose) {
    let d = afterClose ? addDays(S, 1) : S;
    for (let k = 0; k < 7; k++) { const wd = new Date(d + 'T12:00:00Z').getUTCDay(); if (wd !== 0 && wd !== 6) return d; d = addDays(d, 1); }
    return d;
  }

  // ── rule-based Czech commentary from the strongest contributions
  function commentary(r) {
    const fmt = (v, u) => v == null || !Number.isFinite(v) ? '—' : (Math.abs(v) >= 100 ? Math.round(v).toLocaleString('cs-CZ') : v.toFixed(1)) + (u ? ' ' + u : '');
    const top = r.factors.filter(f => f.state != null && Math.abs(f.contrib) > 0.005).slice(0, 3);
    const side = r.side === 'bull' ? 'bullish' : r.side === 'bear' ? 'bearish' : 'neutrální';
    const pu = Math.round(r.p * 100), pb = Math.round(r.base * 100), dlt = pu - pb;
    let s = `${r.horizon === 1 ? 'NY session' : 'Týden od'} ${r.target}: ${side} – pravděpodobnost up close ${pu} % (normálně ${pb} %, ${dlt === 0 ? 'beze změny' : (dlt > 0 ? '+' : '') + dlt + ' b. vůči normálu'}). `;
    if (r.lam === 0) s += `Model v testu nenašel výhodu nad základem. Orientačně faktory ukazují ${r.pRaw >= r.base ? 'spíš nahoru' : 'spíš dolů'} (${Math.round(r.pRaw * 100)} %), ale to v testu neobstálo. `;
    if (!top.length) return s + 'Žádný faktor teď nemá historicky měřitelnou výhodu.';
    s += top.map(f => {
      const dir = f.contrib > 0 ? 'pro long' : 'pro short';
      return `${f.name} ${fmt(f.value, f.unit)} → v tomhle stavu historicky ${Math.round(f.up * 100)} % nahoru (n=${f.n}), ${dir}`;
    }).join('; ') + '.';
    const against = r.factors.filter(f => !top.includes(f) && f.state != null && Math.sign(f.contrib) === (r.p >= r.base ? -1 : 1) && Math.abs(f.contrib) > 0.005);
    if (against.length) s += ` Proti: ${against.slice(0, 2).map(f => f.name).join(', ')}.`;
    return s;
  }

  root.Bias = { parseFred, parseCot, parseTga, parseRrp, build, commentary, etDate, addDays };
})(typeof window !== 'undefined' ? window : globalThis);
