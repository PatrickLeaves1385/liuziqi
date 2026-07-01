'use strict';
// 囚徒困境烟雾测试（策划案 §4）：
//   与 3 名训练囚徒（AllC / AllD / Random50）各完整对战 2 场（a/b 身份各 1），共 6 场，固定种子。
//   任一场出现 illegal / runtime / error → 失败；不拦截"输"。
const { playPrisonerMatch } = require('./engine');
const { getTrainingBot } = require('./training_bots');
const { makePrisonerBot } = require('./sandbox');

const SMOKE_PLAN = [
  { trainerId: 'allc', trainerName: '老好人', userIs: 'a', seed: 11001 },
  { trainerId: 'allc', trainerName: '老好人', userIs: 'b', seed: 11002 },
  { trainerId: 'alld', trainerName: '冷面人', userIs: 'a', seed: 22001 },
  { trainerId: 'alld', trainerName: '冷面人', userIs: 'b', seed: 22002 },
  { trainerId: 'rand', trainerName: '抛硬币', userIs: 'a', seed: 33001 },
  { trainerId: 'rand', trainerName: '抛硬币', userIs: 'b', seed: 33002 },
];

const FAIL_REASONS = new Set(['illegal', 'runtime', 'error']);

function runPrisonerSmokeTests(code) {
  const { bot: userBot, error: compileError } = makePrisonerBot(code);
  if (compileError) {
    return {
      passed: false,
      failures: [{ opponent: '—', userIs: '—', seed: 0, reason: 'error', round: 0, detail: `编译失败: ${compileError.message}` }],
    };
  }
  const failures = [];
  for (const plan of SMOKE_PLAN) {
    const trainer = getTrainingBot(plan.trainerId);
    const bots = plan.userIs === 'a' ? { a: userBot, b: trainer } : { a: trainer, b: userBot };
    const r = playPrisonerMatch(bots, plan.seed);
    if (FAIL_REASONS.has(r.reason) && r.failure && r.failure.side === plan.userIs) {
      failures.push({
        opponent: plan.trainerName,
        userIs: plan.userIs,
        seed: plan.seed,
        reason: r.reason,
        round: r.failure.round,
        detail: r.failure.message,
      });
    }
  }
  return { passed: failures.length === 0, failures };
}

module.exports = { runPrisonerSmokeTests, SMOKE_PLAN };
