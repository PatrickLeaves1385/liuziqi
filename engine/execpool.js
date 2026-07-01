'use strict';
// 父进程侧：把不可信对局/烟雾/试玩 fork 到独立子进程执行（fork-per-task），
// 不阻塞主事件循环；超时硬杀子进程。配合 env 剥离机密，收敛 RCE 影响面。
// 注意：这不是完整 RCE 防护（子进程仍可读 FS）——生产须叠加 OS 级隔离，见 SECURITY.md。
const { fork } = require('child_process');
const path = require('path');

const RUNNER = path.join(__dirname, 'runner.js');
const MAX_CONCURRENT = 8;   // 全局同时在跑的子进程上限，超出回 busy
const MAX_PER_OWNER = 2;    // 单账号/IP 同时在跑上限，防单个来源占满全局池
let inFlight = 0;
const perOwner = new Map(); // ownerKey -> 在跑数

// 子进程 env 白名单：仅保留 OS/Node 运行必需项，剥离 SESSION_SECRET、SMTP 等机密
const ENV_WHITELIST = ['PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'NODE_OPTIONS'];
function childEnv() {
  const e = {};
  for (const k of ENV_WHITELIST) if (process.env[k] !== undefined) e[k] = process.env[k];
  return e;
}

function runTask(task, hardMs, ownerKey) {
  const ownerCount = ownerKey ? (perOwner.get(ownerKey) || 0) : 0;
  if (inFlight >= MAX_CONCURRENT || (ownerKey && ownerCount >= MAX_PER_OWNER)) {
    return Promise.reject(Object.assign(new Error('执行繁忙，请稍后重试'), { busy: true }));
  }
  inFlight++;
  if (ownerKey) perOwner.set(ownerKey, ownerCount + 1);
  return new Promise((resolve, reject) => {
    const child = fork(RUNNER, [], { env: childEnv(), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      fn(v);
    };
    const timer = setTimeout(() => done(reject, Object.assign(new Error('执行超时'), { timeout: true })), hardMs);
    child.on('message', (msg) => {
      if (msg && msg.ok) done(resolve, msg.result);
      else done(reject, Object.assign(new Error((msg && msg.error) || '执行失败'), { execError: true }));
    });
    child.on('error', (e) => done(reject, e));
    child.on('exit', () => done(reject, new Error('子进程提前退出')));
    child.send(task);
  }).finally(() => {
    inFlight--;
    if (ownerKey) {
      const n = (perOwner.get(ownerKey) || 1) - 1;
      if (n <= 0) perOwner.delete(ownerKey); else perOwner.set(ownerKey, n);
    }
  });
}

module.exports = {
  // 烟雾：6 局（每局封顶 ~10s）→ 硬超时给足余量
  runSmoke: (code, ownerKey) => runTask({ type: 'smoke', code }, 90000, ownerKey),
  // 正式挑战：2 局
  runChallenge: (chCode, cdCode, seed, budget, ownerKey) => runTask({ type: 'challenge', chCode, cdCode, seed, budget }, 40000, ownerKey),
  // 试玩：单请求推进若干手
  runPlay: (spec, ownerKey) => runTask({ type: 'play', spec }, 20000, ownerKey),

  // 囚徒困境：烟雾 6 场（每场 ≤1100 回合 × 50ms = 55s，总硬超时给足余量）
  runPrisonerSmoke: (code, ownerKey) => runTask({ type: 'prisoner-smoke', code }, 90000, ownerKey),
  // 囚徒困境：单场正式挑战
  runPrisonerChallenge: (aCode, bCode, seed, ownerKey) => runTask({ type: 'prisoner-challenge', aCode, bCode, seed }, 30000, ownerKey),
  // 囚徒困境：试玩单回合推进（玩家囚徒走子进程，主进程不载入用户脚本）
  runPrisonerPlayOne: (args, ownerKey) => runTask({ type: 'prisoner-play-one', ...args }, 5000, ownerKey),
};
