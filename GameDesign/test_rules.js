'use strict';
// 用规则 v2.1 §5.3 官方示例验证 rawApply 吃子结算
const { Rules } = require('./rules_metered');

function emptyBoard() { return Array.from({ length: 4 }, () => Array(4).fill(null)); }
function put(b, cells, side) { for (const [x, y] of cells) b[x][y] = side; }
function capSet(c) { return c.map(([x, y]) => `${x},${y}`).sort().join(';'); }

let pass = 0, fail = 0;
function check(name, got, expect) {
  const g = capSet(got), e = capSet(expect);
  if (g === e) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}: got [${g}] expect [${e}]`); }
}

// 情况1: 石子方走 (1,2)->(1,1) 后形成 (0,1)石 (1,1)石 (2,1)木,(3,1)空 → 吃 (2,1)
{
  const b = emptyBoard();
  put(b, [[0, 1], [1, 2]], 'stone'); put(b, [[2, 1]], 'stick');
  const r = Rules._rawApply(b, 'stone', { from: [1, 2], to: [1, 1] });
  check('情况1 石2连吃木', r.captured, [[2, 1]]);
}
// 情况2: 4子线无吃 — 石子走入后该线4子
{
  const b = emptyBoard();
  put(b, [[0, 1], [1, 2], [3, 1]], 'stone'); put(b, [[2, 1]], 'stick');
  const r = Rules._rawApply(b, 'stone', { from: [1, 2], to: [1, 1] });
  check('情况2 横线4子无吃', r.captured.filter(([x, y]) => y === 1 && x === 2), []);
}
// 情况4: 交错排列无吃 — 石子走 (2,2)->(2,1) 后 (0,1)石 (1,1)木 (2,1)石
{
  const b = emptyBoard();
  put(b, [[0, 1], [2, 2]], 'stone'); put(b, [[1, 1]], 'stick');
  const r = Rules._rawApply(b, 'stone', { from: [2, 2], to: [2, 1] });
  check('情况4 交错无吃', r.captured, []);
}
// 情况5: 木棍方走 (3,2)->(3,1) 后 (1,1)石 (2,1)木 (3,1)木 → 吃 (1,1)
{
  const b = emptyBoard();
  put(b, [[2, 1], [3, 2]], 'stick'); put(b, [[1, 1]], 'stone');
  const r = Rules._rawApply(b, 'stick', { from: [3, 2], to: [3, 1] });
  check('情况5 木2连吃石', r.captured, [[1, 1]]);
}
// 情况6: 竖线 (2,0)木 (2,1)木 (2,2)石 → 木走入后吃 (2,2)
{
  const b = emptyBoard();
  put(b, [[2, 0], [1, 1]], 'stick'); put(b, [[2, 2]], 'stone');
  const r = Rules._rawApply(b, 'stick', { from: [1, 1], to: [2, 1] });
  check('情况6 竖线吃石', r.captured, [[2, 2]]);
}
// 情况8: 三子不相连无吃 — 木走 (1,0)->(2,0),竖线 (2,0)木 (2,1)木? 改:直接构造 (2,0)(2,1)木 (2,3)石,走入者形成…
{
  const b = emptyBoard();
  put(b, [[2, 1], [1, 0]], 'stick'); put(b, [[2, 3]], 'stone');
  const r = Rules._rawApply(b, 'stick', { from: [1, 0], to: [2, 0] });
  check('情况8 不相连无吃', r.captured, []);
}
// 情况9: 双线同吃 — 木 (1,0)->(1,1);横线吃 (2,1) 石,竖线吃 (1,3) 石
{
  const b = emptyBoard();
  put(b, [[1, 0], [0, 1], [1, 2]], 'stick'); put(b, [[2, 1], [1, 3]], 'stone');
  const r = Rules._rawApply(b, 'stick', { from: [1, 0], to: [1, 1] });
  check('情况9 双线同吃', r.captured, [[2, 1], [1, 3]]);
}
// 情况10: 送上门不吃 — 石 (0,2)->(0,1),线上 (1,1)(2,1) 木2连
{
  const b = emptyBoard();
  put(b, [[1, 1], [2, 1]], 'stick'); put(b, [[0, 2]], 'stone');
  const r = Rules._rawApply(b, 'stone', { from: [0, 2], to: [0, 1] });
  check('情况10 送上门不吃', r.captured, []);
}
// 情况11: 离开的线不结算 — x=2 上 (2,0)石 (2,1)(2,2)(2,3)木,木 (2,3)->(3,3)
{
  const b = emptyBoard();
  put(b, [[2, 1], [2, 2], [2, 3]], 'stick'); put(b, [[2, 0]], 'stone');
  const r = Rules._rawApply(b, 'stick', { from: [2, 3], to: [3, 3] });
  check('情况11 离线不结算', r.captured, []);
}
// 补充: 不连锁 — 双线吃后即便他线出现新 2+1 也不再结算(由 rawApply 单次调用语义保证,验证返回吃子数 ≤2)
{
  const b = emptyBoard();
  put(b, [[1, 0], [0, 1], [1, 2]], 'stick'); put(b, [[2, 1], [1, 3], [3, 0]], 'stone');
  const r = Rules._rawApply(b, 'stick', { from: [1, 0], to: [1, 1] });
  check('补充 单手至多2子', r.captured, [[2, 1], [1, 3]]);
}
// 终局: 20手裁定领先1子判胜(维持现行规则)
{
  const b = emptyBoard();
  put(b, [[0, 0], [2, 2], [3, 3]], 'stone'); put(b, [[0, 3], [3, 0]], 'stick');
  const v = Rules.judge(b, 20);
  if (v && v.winner === 'stone' && v.reason === 'material') { pass++; console.log('PASS 20手裁定领先1子判胜'); }
  else { fail++; console.log('FAIL 20手裁定', JSON.stringify(v)); }
}
// 终局: ≤1子判负
{
  const b = emptyBoard();
  put(b, [[0, 0]], 'stone'); put(b, [[0, 3], [3, 0]], 'stick');
  const v = Rules.judge(b, 3);
  if (v && v.winner === 'stick' && v.reason === 'eliminated') { pass++; console.log('PASS ≤1子判负'); }
  else { fail++; console.log('FAIL ≤1子判负', JSON.stringify(v)); }
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
