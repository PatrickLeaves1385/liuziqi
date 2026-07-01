'use strict';
// 子进程：执行不可信对局/烟雾/试玩，与 Web/DB 进程隔离。
// 父进程经 IPC 下发一个任务，本进程跑完回传结果即退出（fork-per-task）。
// 安全：本进程 env 已被父进程剥离机密；但 vm 逃逸后仍可读文件系统——须靠 OS 级隔离（见 SECURITY.md）。
const { playMatch } = require('./engine_quota');
const { makeBot } = require('./sandbox');
const { runSmokeTests } = require('./smoke');
const { runPlay } = require('./play_session');
const { findBuiltin } = require('./builtins'); // 内置对手构造（与主进程试玩快路径共用）

// 囚徒困境
const { makePrisonerBot } = require('./prisoner/sandbox');
const { playPrisonerMatch } = require('./prisoner/engine');
const { runPrisonerSmokeTests } = require('./prisoner/smoke');

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

  // 囚徒困境
  if (task.type === 'prisoner-smoke') return runPrisonerSmokeTests(task.code);
  if (task.type === 'prisoner-challenge') {
    const { bot: aBot } = makePrisonerBot(task.aCode);
    const { bot: bBot } = makePrisonerBot(task.bCode);
    if (!aBot || !bBot) return { loadFailed: true };
    return playPrisonerMatch({ a: aBot, b: bBot }, task.seed);
  }
  // 囚徒试玩单回合推进：服务器接收完整 history + myMove → 调用一次玩家 bot 给出本回合选择
  if (task.type === 'prisoner-play-one') {
    const { bot, error } = makePrisonerBot(task.code);
    if (!bot) return { loadFailed: true, error: error && error.message };
    // 玩家视角：history.me = 玩家选择数组；history.opp = bot 历史选择
    // 对 bot 来说：opponent.history = 玩家选择；me.history = bot 之前选择
    const me = { score: task.botScore || 0, history: task.botHistory.slice() };
    const opp = { score: task.myScore || 0, history: task.myHistory.slice() };
    Object.freeze(me.history); Object.freeze(opp.history);
    const game = { roundNumber: task.roundNumber, random: () => Math.random() };
    let raw;
    try { raw = bot.onRound(me, opp, game); }
    catch (e) {
      return { failure: { kind: (e && e.runtime) ? 'runtime' : 'error', message: (e && e.message) || String(e) } };
    }
    const { normalizeChoice } = require('./prisoner/rules');
    const ch = normalizeChoice(raw);
    if (ch == null) return { failure: { kind: 'illegal', message: `返回非法选择: ${JSON.stringify(raw)}` } };
    return { move: ch };
  }
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
