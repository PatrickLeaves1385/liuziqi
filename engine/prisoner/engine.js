'use strict';
// 囚徒困境对局引擎：同时出手 · 区间随机回合数 · 对 Bot 隐藏总长度。
// 与 v1.0 策划案 §2.2 / §3 一致。
//
// playPrisonerMatch({ a, b }, seed, opts?):
//   - a, b: { name, onRound(me, opponent, game) -> 'C'|'D' }
//   - seed: 整数，用于派生回合长度与每回合 Bot 可见的 random()
//   - opts.maxMatchMs: 单场挂钟上限（默认 5000）
//   返回 { actualRounds, scoreA, scoreB, result:'a'|'b'|'draw', reason, history, failure? }
//   - history: Array<{a:'C'|'D'|null, b:'C'|'D'|null}>，长度 = 实际进行的回合数（败局可少于 actualRounds）
//   - reason: 'completed' | 'illegal' | 'runtime' | 'error'
//   - failure（非 completed 时存在）: { side:'a'|'b', kind:'illegal'|'runtime'|'error', round, message }
const { PAYOFF, MIN_ROUNDS, MAX_ROUNDS, normalizeChoice, sampleRounds } = require('./rules');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 派生独立随机源：长度抽样、a 的 random、b 的 random，互不串扰
function deriveRng(seed) {
  return {
    len: mulberry32((seed ^ 0xA17C13) >>> 0),
    a: mulberry32((seed ^ 0x5E3DA2B5) >>> 0),
    b: mulberry32((seed ^ 0x9C7E11D3) >>> 0),
  };
}

function playPrisonerMatch(bots, seed, opts = {}) {
  const maxMatchMs = opts.maxMatchMs || 5000;
  const rng = deriveRng(seed);
  const actualRounds = sampleRounds(rng.len());

  let scoreA = 0, scoreB = 0;
  const history = [];
  const aHistMe = [], aHistOpp = []; // a 视角下自己/对方的选择序列
  const bHistMe = [], bHistOpp = []; // b 视角下自己/对方的选择序列

  const deadline = Date.now() + maxMatchMs;

  function failure(sideKey, kind, round, message) {
    // sideKey: 'a' | 'b' —— 失败方
    return {
      actualRounds,
      scoreA,
      scoreB,
      // 失败方判负 → 对手胜
      result: sideKey === 'a' ? 'b' : 'a',
      reason: kind,
      history,
      failure: { side: sideKey, kind, round, message: String(message || '') },
    };
  }

  function askOne(bot, sideKey, roundNumber, rndFn, myHist, oppHist) {
    // 历史不可变：返回 frozen 浅拷贝防 Bot 修改影响后续回合
    const me = { score: sideKey === 'a' ? scoreA : scoreB, history: myHist.slice() };
    const opp = { score: sideKey === 'a' ? scoreB : scoreA, history: oppHist.slice() };
    // game：故意不暴露 totalRounds / remaining
    const game = { roundNumber, random: rndFn };
    Object.freeze(me.history); Object.freeze(opp.history);
    let raw;
    try {
      raw = bot.onRound(me, opp, game);
    } catch (e) {
      const kind = (e && e.runtime) ? 'runtime' : 'error';
      throw { kind, message: (e && e.message) || String(e) };
    }
    const ch = normalizeChoice(raw);
    if (ch == null) throw { kind: 'illegal', message: `返回非法选择: ${JSON.stringify(raw)}` };
    return ch;
  }

  for (let r = 1; r <= actualRounds; r++) {
    if (Date.now() > deadline) {
      // 整场挂钟超时：判定当前回合双方各为 runtime —— 按"先手序"约定先归咎于 a
      return failure('a', 'runtime', r, '整场挂钟超时');
    }
    let aMove, bMove;
    try {
      aMove = askOne(bots.a, 'a', r, rng.a, aHistMe, aHistOpp);
    } catch (e) {
      return failure('a', e.kind, r, e.message);
    }
    try {
      bMove = askOne(bots.b, 'b', r, rng.b, bHistMe, bHistOpp);
    } catch (e) {
      return failure('b', e.kind, r, e.message);
    }
    scoreA += PAYOFF[aMove][bMove];
    scoreB += PAYOFF[bMove][aMove];
    history.push({ a: aMove, b: bMove });
    aHistMe.push(aMove); aHistOpp.push(bMove);
    bHistMe.push(bMove); bHistOpp.push(aMove);
  }

  const result = scoreA > scoreB ? 'a' : scoreA < scoreB ? 'b' : 'draw';
  return { actualRounds, scoreA, scoreB, result, reason: 'completed', history };
}

module.exports = { playPrisonerMatch, MIN_ROUNDS, MAX_ROUNDS };
