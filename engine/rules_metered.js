'use strict';
// 规则计量层：在纯规则核心（rules_core.js，前后端共享）之上叠加「思考点计量」。
// 计费模型:"仅计 apply"(每次 apply = 1 点,其余 0 点)。
//
// 计量为「每手一个实例」(makeRules(budget)),不用模块级全局计数:
//   - 杜绝并发对局相互串改预算(为对局进子进程隔离做准备);
//   - 交给玩家代码的计量对象只暴露安全 API,不含 _reset/_rawApply 等内部方法,
//     避免脚本调用 _reset 自行重置预算、或用 _rawApply 绕过计量。
//   - 引擎与训练棋手用无计量的静态 Rules(含 _rawApply/_counts)。
// UMD：Node 下 require rules_core；浏览器经 /builtin-bots.js 复用 window.GameRules（同一事实源）。
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./rules_core'));
  else root.GameRulesMetered = factory(root.GameRules);
})(typeof self !== 'undefined' ? self : this, function (core) {
const { clone, other, legalMoves, judge, counts, apply: rawApply } = core;

// 每手一个计量实例:交给棋手代码使用。只暴露安全 API(legalMoves/apply/judge/clone/other/remaining)。
function makeRules(budget) {
  let pts = budget;
  return {
    legalMoves, judge, clone, other,
    remaining() { return pts; },
    apply(board, side, move) {
      if (pts < 1) { const e = new Error('compute quota exceeded'); e.quota = true; throw e; }
      pts -= 1;
      return rawApply(board, side, move);
    },
  };
}

// 引擎/训练棋手用的无计量静态视图(含内部 _rawApply/_counts,绝不注入玩家沙箱)
const Rules = { legalMoves, judge, clone, other, _counts: counts, _rawApply: rawApply };

return { Rules, makeRules };
});
