'use strict';
// 发布烟雾测试（§6.2）：三名训练棋手各执黑、执红各 1 局，共 6 局，固定种子集。
// 任何一局以 illegal/runtime/error 终局 → 发布失败。
const { playMatch } = require('./engine_quota');
const { getTrainingBot } = require('./training_bots');
const { makeBot } = require('./sandbox');

const BUDGET = 100;

// 固定种子集（§6.2：与版本无关，同代码重复发布结果一致）
const SMOKE_PLAN = [
  { trainerId: 'moutong', trainerName: '牧童', userSide: 'black', seed: 10101 },
  { trainerId: 'moutong', trainerName: '牧童', userSide: 'red', seed: 10102 },
  { trainerId: 'shilang', trainerName: '石郎', userSide: 'black', seed: 20201 },
  { trainerId: 'shilang', trainerName: '石郎', userSide: 'red', seed: 20202 },
  { trainerId: 'qisheng', trainerName: '棋圣', userSide: 'black', seed: 30301 },
  { trainerId: 'qisheng', trainerName: '棋圣', userSide: 'red', seed: 30302 },
];

const FAIL_REASONS = new Set(['illegal', 'runtime', 'error']);

// 运行烟雾测试，返回 { passed, failures }
// failures: 数组，每条 { opponent, side, seed, reason, turn, detail }
function runSmokeTests(code) {
  const { bot: userBot, error: compileError } = makeBot(code);
  if (compileError) {
    return {
      passed: false,
      failures: [{
        opponent: '—', side: '—', seed: 0, reason: 'error',
        turn: 0, detail: `编译失败: ${compileError.message}`,
      }],
    };
  }

  const failures = [];

  for (const plan of SMOKE_PLAN) {
    const trainer = getTrainingBot(plan.trainerId);
    const bots = plan.userSide === 'black'
      ? { black: userBot, red: trainer }
      : { black: trainer, red: userBot };

    const result = playMatch(bots, plan.seed, BUDGET);

    if (FAIL_REASONS.has(result.reason) && result.winner !== plan.userSide) {
      // 用户方输于非法/超点/异常才算烟雾测试失败
      // （会输棋的 eliminated/material/stalemate/draw 不拦截）
      const lastTurn = result.history[result.history.length - 1];
      failures.push({
        opponent: plan.trainerName,
        side: plan.userSide,
        seed: plan.seed,
        reason: result.reason,
        turn: lastTurn ? lastTurn.turn : 0,
        detail: `终局原因: ${result.reason}`,
      });
    }
  }

  return { passed: failures.length === 0, failures };
}

module.exports = { runSmokeTests, SMOKE_PLAN, BUDGET };
