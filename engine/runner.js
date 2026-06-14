'use strict';
// 子进程：执行不可信对局/烟雾/试玩，与 Web/DB 进程隔离。
// 父进程经 IPC 下发一个任务，本进程跑完回传结果即退出（fork-per-task）。
// 安全：本进程 env 已被父进程剥离机密；但 vm 逃逸后仍可读文件系统——须靠 OS 级隔离（见 SECURITY.md）。
const { playMatch } = require('./engine_quota');
const { makeBot } = require('./sandbox');
const { runSmokeTests } = require('./smoke');
const { runPlay } = require('./play_session');
const { findBuiltin } = require('./builtins'); // 内置对手构造（与主进程试玩快路径共用）

function pick(g) { return { winner: g.winner, reason: g.reason, turns: g.turns, history: g.history, finalPieces: g.finalPieces }; }

function handle(task) {
  if (task.type === 'smoke') return runSmokeTests(task.code);
  if (task.type === 'challenge') {
    const { bot: chBot } = makeBot(task.chCode);
    const { bot: cdBot } = makeBot(task.cdCode);
    if (!chBot || !cdBot) return { loadFailed: true };
    const g1 = playMatch({ black: chBot, red: cdBot }, task.seed, task.budget);
    const g2 = playMatch({ black: cdBot, red: chBot }, task.seed + 1, task.budget);
    return { game1: pick(g1), game2: pick(g2) };
  }
  if (task.type === 'play') return runPlay(task.spec, { makeBot, findBuiltin });
  throw new Error('unknown task type: ' + task.type);
}

process.on('message', (task) => {
  let out;
  try { out = { ok: true, result: handle(task) }; }
  catch (e) { out = { ok: false, error: String((e && e.message) || e) }; }
  try { process.send(out, () => process.exit(0)); }
  catch { process.exit(1); }
});

// 兜底：父进程若迟迟不下发任务，自退避免悬挂
setTimeout(() => process.exit(0), 120000).unref();
