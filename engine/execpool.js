'use strict';
// 父进程侧：把不可信对局/烟雾/试玩 fork 到独立子进程执行（fork-per-task），
// 不阻塞主事件循环；超时硬杀子进程。配合 env 剥离机密 + Node 权限模型收敛 RCE 影响面。
// 注意：仍非完整 RCE 防护（权限模型不拦网络出站）——生产须叠加 OS 级隔离，见 SECURITY.md。
const { fork } = require('child_process');
const path = require('path');

const RUNNER = path.join(__dirname, 'runner.js');
const MAX_CONCURRENT = 8;   // 全局同时在跑的子进程上限，超出回 busy
const MAX_PER_OWNER = 2;    // 单账号/IP 同时在跑上限，防单个来源占满全局池
let inFlight = 0;
const perOwner = new Map(); // ownerKey -> 在跑数

// Node 权限模型（Node ≥22 稳定）：给不可信子进程加一道进程内闸门，作为 OS 级隔离之下的纵深防御。
// 即便 vm 逃逸拿到真实的 fs / child_process，越权操作也会在 C++ 层被拒（ERR_ACCESS_DENIED）：
//   --permission              开启权限模型 → 默认拒绝 fs 写、child_process、worker、原生插件
//   --allow-fs-read=<engine>  只放行读取 engine/ 目录（跑对局所需的本仓库代码，非机密）。
//     app 根目录下的 ecosystem.config.js（含 SESSION_SECRET）与 sixchess.db 都在 engine/ 之外
//     → 逃逸后也读不到；不放行任何 fs 写、不放行 child_process/worker。
// 网络出站权限模型「不」拦截，仍须靠部署侧防火墙禁止子进程对外连接（见 SECURITY.md）。
// 兜底开关：极端不兼容时设 CHILD_PERMISSION=off 可关闭本闸门回退，无需改代码。
const CHILD_PERMISSION = process.env.CHILD_PERMISSION !== 'off';
const PERMISSION_ARGS = ['--permission', `--allow-fs-read=${__dirname}`];

// 可选：以专用低权限用户运行 runner 子进程（仅 POSIX）。设 RUNNER_UID（必要时 RUNNER_GID）为目标
// 用户的数字 id（`id -u clawbot` / `id -g clawbot`）。这样即可用 iptables owner 匹配禁掉「该用户」的
// 网络出站——权限模型不拦网络，须靠这层堵住逃逸后的数据外带/打内网（见 SECURITY.md）。
// 前置条件：主进程有权 setuid（生产 PM2 以 root 跑）；目标用户须能读 engine/ 与 node 可执行文件。
// Windows 不支持 setuid → 自动跳过，不影响本地开发。
const posix = process.platform !== 'win32';
const RUNNER_UID = posix && Number.isInteger(+process.env.RUNNER_UID) && process.env.RUNNER_UID !== '' ? +process.env.RUNNER_UID : undefined;
const RUNNER_GID = posix && Number.isInteger(+process.env.RUNNER_GID) && process.env.RUNNER_GID !== '' ? +process.env.RUNNER_GID : undefined;

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
    const forkOpts = { env: childEnv(), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] };
    if (CHILD_PERMISSION) forkOpts.execArgv = PERMISSION_ARGS; // 关闭时继承父进程默认，不加权限闸门
    if (RUNNER_UID !== undefined) forkOpts.uid = RUNNER_UID;   // POSIX 且已配置时降权到专用用户
    if (RUNNER_GID !== undefined) forkOpts.gid = RUNNER_GID;
    const child = fork(RUNNER, [], forkOpts);
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
