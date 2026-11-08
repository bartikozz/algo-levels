// node tests/yyy.test.js — pivots / VIX map on the 6.11 setup (mentor: QQQ pivot 655, res 660, sup 653/650; SPX 7350 → 7300; VIX +γ to 30, trigger 27)
const assert = require('assert');
global.window = {}; require('../yyy.js'); const Y = window.YYY;
const mk = o => ({ strikes: Object.entries(o).map(([k, v]) => [+k, v, v, []]) });
const q = mk({ 645:-20, 648:-5, 650:-60, 652:-10, 653:-45, 654:-8, 655:-90, 656:-10, 657:5, 658:8, 659:12, 660:70, 661:5, 662:10, 665:40, 670:30 });
const Q = Y.keyLevels(q, 658.3, 0.012, 2, 5, [[655, 100, 9000], [653, 0, 4000]], 0);
assert.strictEqual(Q.pivot, 655); assert.deepStrictEqual(Q.up, [660, 665]); assert.deepStrictEqual(Q.dn, [653, 650]);
const sp = mk({ 7250:-30, 7300:-80, 7325:-20, 7340:-15, 7350:-120, 7355:-130, 7360:-40, 7375:20, 7400:90, 7450:50 });
const X = Y.keyLevels(sp, 7370, 0.008, 1, 50, [[7350, 0, 30000]], 50);
assert.strictEqual(X.pivot, 7350); assert.strictEqual(X.dn[0], 7300);
const V = Y.vixMap(mk({ 20:5, 22:10, 24:20, 25:40, 26:30, 27:25, 28:20, 29:15, 30:10, 32:-20, 35:-30, 40:-15 }), 27.2, 2);
assert.strictEqual(V.regime, 1); assert.strictEqual(V.edge, 30); assert.strictEqual(V.trigger, 27);
console.log('yyy ok');
