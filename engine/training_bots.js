'use strict';
// 三档训练棋手：牧童（随机）/ 石郎（贪吃）/ 棋圣（2 层子力）
// 仅保证棋局正常进行，不纳入四套评估流派（§P1-1 不采纳）
// UMD：Node 下 require rules_metered；浏览器复用 window.GameRulesMetered（/builtin-bots.js）。
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./rules_metered'));
  else root.ClawTraining = factory(root.GameRulesMetered);
})(typeof self !== 'undefined' ? self : this, function (metered) {
const { Rules } = metered;

function makeRandom(rnd) {
  return {
    name: '牧童',
    onTurn(me, _opp, game) {
      const mvs = game.legalMoves;
      return mvs[Math.floor(game.random() * mvs.length)];
    },
  };
}

function makeGreedy(_rnd) {
  return {
    name: '石郎',
    onTurn(me, _opp, game) {
      const mvs = game.legalMoves;
      // 优先能吃子的走法
      for (const mv of mvs) {
        const r = Rules._rawApply(game.board, me.side, mv);
        if (r.captured.length > 0) return mv;
      }
      return mvs[Math.floor(game.random() * mvs.length)];
    },
  };
}

function makeTwoply(_rnd) {
  const WIN = 1e6;
  function material(board, side) {
    let s = 0, k = 0;
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {
      if (board[x][y] === 'black') s++;
      else if (board[x][y] === 'red') k++;
    }
    return side === 'black' ? s - k : k - s;
  }
  function score1(board, side, ncm) {
    const v = Rules.judge(board, ncm);
    if (v) return v.winner === side ? WIN : v.winner === 'draw' ? 0 : -WIN;
    return material(board, side);
  }
  return {
    name: '棋圣',
    onTurn(me, opp, game) {
      const mvs = game.legalMoves;
      let best = mvs[0], bestV = -Infinity;
      for (const mv of mvs) {
        const r1 = Rules._rawApply(game.board, me.side, mv);
        const ncm1 = r1.captured.length > 0 ? 0 : game.noCaptureMoves + 1;
        const v1 = Rules.judge(r1.board, ncm1);
        if (v1) {
          const s = v1.winner === me.side ? WIN : v1.winner === 'draw' ? 0 : -WIN;
          if (s > bestV) { bestV = s; best = mv; }
          continue;
        }
        const oMvs = Rules.legalMoves(r1.board, opp.side);
        let worstOpponent = WIN;
        for (const om of oMvs) {
          const r2 = Rules._rawApply(r1.board, opp.side, om);
          const ncm2 = r2.captured.length > 0 ? 0 : ncm1 + 1;
          const s = score1(r2.board, me.side, ncm2);
          if (s < worstOpponent) worstOpponent = s;
        }
        const v = oMvs.length === 0 ? score1(r1.board, me.side, ncm1 + 1) : worstOpponent;
        if (v > bestV) { bestV = v; best = mv; }
      }
      return best;
    },
  };
}

const TRAINING_BOTS = [
  { id: 'moutong', make: makeRandom },
  { id: 'shilang', make: makeGreedy },
  { id: 'qisheng', make: makeTwoply },
];

function getTrainingBot(id) {
  const def = TRAINING_BOTS.find((b) => b.id === id);
  if (!def) throw new Error(`未知训练棋手: ${id}`);
  return def.make();
}

return { TRAINING_BOTS, getTrainingBot };
});
