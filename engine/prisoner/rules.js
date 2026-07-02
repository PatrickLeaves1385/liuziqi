'use strict';
// 囚徒困境规则核心：收益矩阵 + 回合数区间。
// 与策划案 v1.0 §2 一致；前后端共享同一事实源。
// UMD：Node 下 module.exports；浏览器经 /builtin-bots.js 挂到 window.PdRules。
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PdRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {

// 单回合收益：[我的选择][对方选择] -> 我的得分。
//   CC=3 / CD=0 / DC=5 / DD=1
const PAYOFF = {
  C: { C: 3, D: 0 },
  D: { C: 5, D: 1 },
};

// 每场实际回合数在 [MIN_ROUNDS, MAX_ROUNDS] 均匀随机抽取。
// **对 Bot 隐藏**：Bot 仅可见 roundNumber，不可见 totalRounds / remaining。
// 对人类玩家**透明**：规则页 / Agent 指南 / 回放页都显式标注该区间。
const MIN_ROUNDS = 900;
const MAX_ROUNDS = 1100;

// 将 Bot 返回值归一化为 'C' / 'D'；非法返回值 → null
function normalizeChoice(v) {
  if (v === 'C' || v === 'D') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'c' || s === 'cooperate' || s === 'coop') return 'C';
    if (s === 'd' || s === 'defect') return 'D';
  }
  return null;
}

// 抽样本场实际回合数（基于一个 [0,1) 随机数）
function sampleRounds(rnd01) {
  const span = MAX_ROUNDS - MIN_ROUNDS + 1;
  return MIN_ROUNDS + Math.floor(rnd01 * span);
}

return { PAYOFF, MIN_ROUNDS, MAX_ROUNDS, normalizeChoice, sampleRounds };
});
