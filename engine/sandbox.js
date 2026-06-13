'use strict';
// 用 vm 执行玩家代码：每手强制挂钟超时（阻断死循环/长耗时），并按手注入计量实例 Rules。
//
// 安全声明：Node 的 vm 不是安全边界——上下文里仍可经宿主对象（game.rules、game.board 等）
// 的原型链触达宿主 realm，无法在进程内彻底防住 RCE。本模块只做三件事：
//   1) 用挂钟超时阻断死循环/超长耗时（解决可用性/DoS）；
//   2) 不再向沙箱注入宿主内置对象（Math/JSON/… 用上下文自带版本），收敛最易用的逃逸面；
//   3) 交给脚本的 Rules 是「每手计量实例」，只含安全 API（无 _reset/_rawApply 可绕过计量）。
// 生产部署必须叠加 OS 级隔离（独立低权限进程/容器、只读 FS、禁网、密钥与 DB 不可达）。详见 SECURITY.md。
const vm = require('vm');
const { makeRules } = require('./rules_metered');

const COMPILE_TIMEOUT_MS = 2000; // 顶层代码（定义 onTurn）最长运行时间
const MOVE_TIMEOUT_MS = 3000;    // 单次 onTurn 调用最长挂钟时间

// 编译用户代码，返回 { onTurn, ctx, error }。onTurn 为上下文内的函数引用。
function compile(code) {
  try {
    const wrapped = `(function(module,exports){${code}\n})(module,exports)`;
    const mod = { exports: {} };
    // 仅注入 Rules 占位 + console（其余 Math/JSON/… 由上下文自带，不引宿主 realm）。
    // 占位用 0 预算实例：若脚本在顶层捕获 Rules，其 apply 立即抛配额异常，无法绕过每手计量。
    const ctx = vm.createContext({
      module: mod, exports: mod.exports,
      Rules: makeRules(0),
      console: { log() {}, warn() {}, error() {} },
    });
    new vm.Script(wrapped, { filename: 'bot.js' }).runInContext(ctx, { timeout: COMPILE_TIMEOUT_MS });

    let onTurn = mod.exports;
    if (typeof onTurn !== 'function' && mod.exports && typeof mod.exports.onTurn === 'function') onTurn = mod.exports.onTurn;
    if (typeof onTurn !== 'function') throw new Error('代码必须 export 一个函数，或 exports.onTurn = function...');
    return { onTurn, ctx, error: null };
  } catch (e) {
    return { onTurn: null, ctx: null, error: e };
  }
}

// 从代码字符串构造 bot 对象（格式与 engine_quota.js 一致）。
// 每手：注入该手的计量实例（game.rules）为 Rules → 通过预编译 invoker 在超时保护下调用 onTurn。
function makeBot(code) {
  const { onTurn, ctx, error } = compile(code);
  if (error) return { bot: null, error };
  ctx.__onTurn = onTurn;
  const invoker = new vm.Script('__onTurn(__me, __opp, __game)', { filename: 'invoke.js' });
  const bot = {
    name: 'user',
    onTurn(me, opponent, game) {
      ctx.Rules = game.rules; // 本手计量实例（每手开始替换占位）
      ctx.__me = me; ctx.__opp = opponent; ctx.__game = game;
      try {
        return invoker.runInContext(ctx, { timeout: MOVE_TIMEOUT_MS });
      } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        const timedOut = /timed out/i.test(msg);
        const err = new Error(timedOut ? '挂钟超时（onTurn 超过单手时限）' : msg);
        // 超时与超点同归 runtime 负（e.quota 由计量实例在超点时置位）
        err.quota = !!(e && e.quota) || timedOut;
        throw err;
      } finally {
        ctx.__me = ctx.__opp = ctx.__game = null; // 释放对入参的引用
      }
    },
  };
  return { bot, error: null };
}

module.exports = { compile, makeBot, COMPILE_TIMEOUT_MS, MOVE_TIMEOUT_MS };
