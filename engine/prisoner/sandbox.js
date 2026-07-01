'use strict';
// 用 vm 执行囚徒玩家代码：每回合挂钟超时阻断死循环；不向沙箱注入宿主内置对象。
//
// 安全声明：与 ../sandbox.js 同——Node vm 不是安全边界；本模块仅做
//   1) 每回合挂钟超时（可用性 / DoS）；
//   2) 不引宿主 realm（Math/JSON 用上下文自带版本）；
//   3) 沙箱不能 require / 不暴露 process/fs/net；
// 生产部署必须叠加 OS 级隔离（独立低权限进程/容器），详见 SECURITY.md。
const vm = require('vm');

const COMPILE_TIMEOUT_MS = 2000; // 顶层代码（定义 onRound）最长运行时间
const ROUND_TIMEOUT_MS = 50;     // 单次 onRound 调用最长挂钟时间（策划案 §3.2）

// 编译用户代码，返回 { onRound, ctx, error }
function compile(code) {
  try {
    const wrapped = `(function(module,exports){${code}\n})(module,exports)`;
    const mod = { exports: {} };
    const ctx = vm.createContext({
      module: mod, exports: mod.exports,
      console: { log() {}, warn() {}, error() {} },
    });
    new vm.Script(wrapped, { filename: 'prisoner_bot.js' }).runInContext(ctx, { timeout: COMPILE_TIMEOUT_MS });
    let onRound = mod.exports;
    if (typeof onRound !== 'function' && mod.exports && typeof mod.exports.onRound === 'function') onRound = mod.exports.onRound;
    if (typeof onRound !== 'function') throw new Error('代码必须 export 一个函数，或 exports.onRound = function...');
    return { onRound, ctx, error: null };
  } catch (e) {
    return { onRound: null, ctx: null, error: e };
  }
}

// 从代码字符串构造 bot 对象 { name, onRound }
function makePrisonerBot(code) {
  const { onRound, ctx, error } = compile(code);
  if (error) return { bot: null, error };
  ctx.__onRound = onRound;
  const invoker = new vm.Script('__onRound(__me, __opp, __game)', { filename: 'invoke.js' });
  const bot = {
    name: 'user',
    onRound(me, opponent, game) {
      ctx.__me = me; ctx.__opp = opponent; ctx.__game = game;
      try {
        return invoker.runInContext(ctx, { timeout: ROUND_TIMEOUT_MS });
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        const timedOut = /timed out/i.test(msg);
        const err = new Error(timedOut ? '挂钟超时（onRound 超过 50ms）' : msg);
        err.runtime = timedOut;
        throw err;
      } finally {
        ctx.__me = ctx.__opp = ctx.__game = null;
      }
    },
  };
  return { bot, error: null };
}

module.exports = { compile, makePrisonerBot, COMPILE_TIMEOUT_MS, ROUND_TIMEOUT_MS };
