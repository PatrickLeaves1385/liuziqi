'use strict';
// 三名训练囚徒：永远合作 / 永远背叛 / 50% 抛硬币
// 仅用于烟雾测试 + 试玩页对手名册；不计入段位。
// 严格无状态：仅依赖 game.random / opponent.history 等入参。

function makeAlwaysCooperate() {
  return {
    id: 'allc', name: '老好人', summary: '永远合作。',
    onRound() { return 'C'; },
  };
}

function makeAlwaysDefect() {
  return {
    id: 'alld', name: '冷面人', summary: '永远背叛。',
    onRound() { return 'D'; },
  };
}

function makeRandom50() {
  return {
    id: 'rand', name: '抛硬币', summary: '每回合 50/50 抛硬币。',
    onRound(_me, _opp, game) { return game.random() < 0.5 ? 'C' : 'D'; },
  };
}

const TRAINING_BOTS = [
  { id: 'allc', make: makeAlwaysCooperate },
  { id: 'alld', make: makeAlwaysDefect },
  { id: 'rand', make: makeRandom50 },
];

function getTrainingBot(id) {
  const def = TRAINING_BOTS.find((b) => b.id === id);
  if (!def) throw new Error(`未知训练囚徒: ${id}`);
  return def.make();
}

module.exports = { TRAINING_BOTS, getTrainingBot };
