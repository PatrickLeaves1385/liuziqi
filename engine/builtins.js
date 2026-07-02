'use strict';
// 内置试玩对手（流派模板 + 训练棋手）的构造。均为本仓库可信代码（非用户上传脚本），
// 因此既可在隔离子进程（runner.js）内构造，也可在主进程（server.js 试玩快路径）内直接构造，
// 亦可经 /builtin-bots.js 在浏览器内直接构造（试玩纯前端应手，零网络）。
// UMD：Node 下 require；浏览器复用 window.ClawTemplates / window.ClawTraining。
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./templates_factory'), require('./training_bots'));
  else root.ClawBuiltins = factory(root.ClawTemplates, root.ClawTraining);
})(typeof self !== 'undefined' ? self : this, function (tf, tb) {
const { makeTemplates } = tf;
const { TRAINING_BOTS } = tb;

// 定稿基线权重（§14.4）——试玩内置对手（流派）用
const WEIGHTS = { blockMob: 60, rulDef: 8, cenThreat: 15, cenCenter: 50, cenHunt: 4, cenMat: 1000 };

function findBuiltin(name) {
  const t = makeTemplates(WEIGHTS).find((b) => b.name === name);
  if (t) return t;
  const def = TRAINING_BOTS.find((d) => d.make().name === name);
  return def ? def.make() : null;
}

return { WEIGHTS, findBuiltin };
});
