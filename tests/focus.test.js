// node tests/focus.test.js — ★ main-wall selection (levels.js) and the Focus zones (fzMajors / driftSig from index.html)
const assert = require('assert');
const fs = require('fs'), path = require('path');
global.window = global; require('../yyy.js');
const A = require('../levels.js');

// ── ★ wall picked on GEX smoothed with the GEXbot priors (now, 1 min, 5 min ago): a one-poll spike does not take over
const LAY = ['gex0','gex1','gexFull','maxchg','qqq','qqqMain','gexProf','em','sigma','vp'];
const S = { tol:10, minScore:3, range:3, touch:3, zone:25, brk:6, react:15, lookahead:15, scanRTH:true, volIndex:'VXN', emStraddle:true, majorStrong:10, layers:Object.fromEntries(LAY.map(l => [l, true])) };
const data = A.makeDemo(777);
const spot = data.gex.qqq.spot;
const base = Math.round(spot / 5) * 5;
// 670-style wall that has been the biggest for a while, and a strike that spikes only in the latest poll
data.gex.qqq.strikes = [
  [base - 10, -50, -50, [-50, -50, -50, -50, -50]],
  [base - 5, -400, -400, [-390, -380, -370, -360, -350]],   // steady put wall
  [base + 5, 300, 300, [290, 280, 270, 260, 250]],           // steady call wall
  [base + 10, 420, 420, [40, 30, 20, 20, 20]],               // spiked this minute only
];
const r = A.compute(data, S);
const cw = r.info.majors.find(m => m.type === 'CW'), pw = r.info.majors.find(m => m.type === 'PW');
assert.strictEqual(cw.qqq, base + 5, 'spike must not take the ★ call wall');
assert.strictEqual(cw.gex, 300, 'reported GEX stays the current value');
assert.strictEqual(pw.qqq, base - 5);
// without priors (tests / old data) the current value decides
data.gex.qqq.strikes = data.gex.qqq.strikes.map(x => [x[0], x[1], x[2], []]);
assert.strictEqual(A.compute(data, S).info.majors.find(m => m.type === 'CW').qqq, base + 10);

// ── Focus zones from index.html, run with stubs
const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const grab = n => { const i = src.indexOf('function ' + n + '('); let d = 0; for (let k = src.indexOf('{', i); ; k++) { if (src[k] === '{') d++; if (src[k] === '}' && !--d) return src.slice(i, k + 1); } };
global.st = { data:{ bars:[] }, drift:null }; global.S = {}; global.fzW = () => 16.5; global.fmtP = x => x.toFixed(2);
global.A = { tdate:() => 'd', isRTH:() => true };
eval(grab('driftSig') + ';' + grab('fzMajors') + ';global.fzMajors = fzMajors;');
const bar = (t, l, h) => ({ t, o:l, h, l, c:h });
const R = { today:'d', last:27976, info:{ ratio:41.25, em:{ em:250, anchor:27750 }, majors:[{ type:'CW', qqq:680, price:28051 }, { type:'PW', qqq:670, price:27639 }] },
  levels:[{ price:28091, base:6.75, tags:['1DTE CW 1', 'OI PW', '0DTE CW 3'] }] };
st.data.bars = [bar(1, 27600, 27700), bar(2, 27900, 27990)];
let z = fzMajors(R);
assert.strictEqual(z[0].label, '★ RESISTANCE · QQQ 680 + 1DTE CW 1, 0DTE CW 3');
assert.deepStrictEqual([z[0].lo, z[0].hi], [28034.5, 28051]);
assert.strictEqual(z[1].label, '★ SUPPORT · QQQ 670');
// price came from below and now chops just above the wall: the zone keeps its side (no flip-flop)
st.data.bars.push(bar(3, 28040, 28060)); R.last = 28058;
assert.strictEqual(fzMajors(R)[0].side, 'short');
// once a bar is fully above the wall's zone it flips to support (polarity flip)
st.data.bars.push(bar(4, 28070, 28090)); R.last = 28085;
z = fzMajors(R).find(x => x.q === 680);
assert.strictEqual(z.side, 'long'); assert.deepStrictEqual([z.lo, z.hi], [28051, 28067.5]);
// net drift: put heavy into the resistance → "drift ✓"
st.data.bars = [bar(1, 27600, 27700), bar(2, 27900, 27990)]; R.last = 27976;
st.drift = Array.from({ length:20 }, (_, i) => [i, 0, 100000 - i * 8000, i * 9000, 0]);
z = fzMajors(R);
assert.ok(z[0].label.endsWith('drift ✓') && z[1].label.endsWith('drift ✗'));
console.log('focus ok');

// ── every local script is loaded with the page version (stale cached engine + new page = wrong levels)
const ver = (src.match(/<small[^>]*>v([\d.]+[a-z]?)<\/small>/) || [])[1];
const tags = [...src.matchAll(/<script src="(\w+)\.js\?v=([^"]+)"/g)];
assert.ok(ver && tags.length >= 6, 'version tag / script tags missing');
for (const [, f, v] of tags) assert.strictEqual(v, ver, `${f}.js?v=${v} ≠ page v${ver}`);
console.log('versions ok');
// a wall that keeps growing does take over
{
  const d2 = A.makeDemo(777), b2 = Math.round(d2.gex.qqq.spot / 5) * 5;
  d2.gex.qqq.strikes = [[b2 + 5, 300, 300, [290, 280, 270, 260, 250]], [b2 + 10, 420, 420, [380, 250, 120, 60, 20]], [b2 - 5, -400, -400, [-390, -380, -370, -360, -350]]];
  assert.strictEqual(A.compute(d2, S).info.majors.find(m => m.type === 'CW').qqq, b2 + 10);
  console.log('growing wall ok');
}
