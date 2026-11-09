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
// 9.11 (mentor: QQQ 662 above 660 = pivot, watch 663 / 658, 655 → 650s even though 670 is heavier)
const q2 = mk({ 650:-40, 655:-50, 658:-30, 660:60, 661:3, 662:5, 663:35, 664:4, 670:200, 675:80 });
const Q2 = Y.keyLevels(q2, 662.1, 0.012, 2, 5, [], 0);
assert.strictEqual(Q2.pivot, 660); assert.deepStrictEqual(Q2.inner, [663, 658]); assert.strictEqual(Q2.dn[0], 655);
// lost the level overhead today → that level is the pivot (bearish)
const bars = [{ t: Date.UTC(2026, 10, 9, 15, 0) / 1000, o: 671, h: 671.5, l: 669, c: 669.5 }];
assert.strictEqual(Y.keyLevels(q2, 662.1, 0.012, 2, 5, [], 0, bars).pivot, 670);
// SPX 7441: pivot 7400, reclaim 7450, magnet 7490 (big +GEX)
const s2 = mk({ 7350:-60, 7390:-20, 7400:110, 7420:10, 7450:70, 7470:20, 7490:160, 7500:40 });
const X2 = Y.keyLevels(s2, 7441.4, 0.008, 1, 50, [], 50);
assert.strictEqual(X2.pivot, 7400); assert.strictEqual(X2.other, 7450); assert.strictEqual(X2.magnet, 7490);
console.log('yyy ok');
