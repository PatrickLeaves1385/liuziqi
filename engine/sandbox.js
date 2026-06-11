'use strict';
// 用 vm 沙箱执行玩家代码，暴露 Rules 供调用。
// 安全声明：vm 沙箱在 Node 中不提供硬性隔离，仅为演示用途。
const vm = require('vm');
const { Rules } = require('./rules_metered');

const SANDBOX_TIMEOUT_MS = 5000; // 单次 onTurn 调用最长运行时间

// 编译用户代码，返回 { bot, error }
function compile(code) {
  try {
    const wrapped = `(function(module,exports,require){${code}\n})(module,exports)`;
    const mod = { exports: {} };
    const ctx = vm.createContext({
      module: mod, exports: mod.exports,
      Rules,
      console: { log: () => {}, warn: () => {}, error: () => {} },
      Math, JSON, Date, isFinite, isNaN, parseInt, parseFloat,
      Array, Object, Number, String, Boolean, Error,
    });
    const script = new vm.Script(wrapped, { filename: 'bot.js' });
    script.runInContext(ctx, { timeout: SANDBOX_TIMEOUT_MS });

    let onTurn = mod.exports;
    if (typeof onTurn !== 'function') onTurn = mod.exports.onTurn;
    if (typeof onTurn !== 'function') throw new Error('代码必须 export 一个函数，或 exports.onTurn = function...');
    return { onTurn, error: null };
  } catch (e) {
    return { onTurn: null, error: e };
  }
}

// 从代码字符串构造 bot 对象（格式与 engine_quota.js 一致）
function makeBot(code, budget) {
  const { onTurn, error } = compile(code);
  if (error) return { bot: null, error };
  const bot = {
    name: 'user',
    onTurn(me, opponent, game) {
      Rules._reset(budget);
      let mv;
      try {
        mv = onTurn(me, opponent, game);
      } catch (e) {
        const err = new Error(e && e.message ? e.message : String(e));
        err.quota = e && e.quota;
        throw err;
      }
      return mv;
    },
  };
  return { bot, error: null };
}

module.exports = { compile, makeBot };
