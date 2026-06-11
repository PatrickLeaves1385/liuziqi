'use strict';
// 对局引擎(按规则 v2.1 §4 与策划案 §7.1 重建)
// - 石子先行;每手前重置走棋方思考点为 budget
// - 无合法走法由引擎自动 pass(计入 noCaptureMoves),连续互停 → stalemate 按子力裁定
// - illegal / error / runtime(超点)立即判负
const { Rules } = require('./rules_metered');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function initBoard() {
  const b = Array.from({ length: 4 }, () => Array(4).fill(null));
  for (const [x, y] of [[0, 3], [1, 3], [2, 3], [3, 3], [0, 2], [3, 2]]) b[x][y] = 'stone';
  for (const [x, y] of [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [3, 1]]) b[x][y] = 'stick';
  return b;
}

function piecesOf(board, side) {
  const p = [];
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) if (board[x][y] === side) p.push([x, y]);
  return p;
}

// bots = { stone: bot, stick: bot }
function playMatch(bots, seed, budget) {
  const rnd = mulberry32(seed);
  let board = initBoard();
  let side = 'stone', turn = 1, ncm = 0, lastPass = false;
  const history = [];

  const fin = (winner, reason) => ({
    winner, reason, history, turns: history.length, finalPieces: Rules._counts(board),
  });

  while (true) {
    const moves = Rules.legalMoves(board, side);

    if (moves.length === 0) { // 停一手:引擎自动 pass,不调用 onTurn
      history.push({ turn, side, from: null, to: null, captured: [], pass: true });
      ncm++;
      if (lastPass) { // 双方连续互停 → 按子力裁定(规则四.5)
        const c = Rules._counts(board);
        if (c.stone === c.stick) return fin('draw', 'draw');
        return fin(c.stone > c.stick ? 'stone' : 'stick', 'stalemate');
      }
      lastPass = true;
      const v = Rules.judge(board, ncm); // pass 计入 20 手计数
      if (v) return fin(v.winner, v.reason);
      turn++; side = Rules.other(side);
      continue;
    }

    lastPass = false;
    Rules._reset(budget); // 每手重置思考点
    const oppSide = Rules.other(side);
    const myPieces = piecesOf(board, side), opPieces = piecesOf(board, oppSide);
    const me = { side, pieces: myPieces, capturedCount: 6 - myPieces.length };
    const opponent = { side: oppSide, pieces: opPieces, capturedCount: 6 - opPieces.length };
    const game = {
      board: Rules.clone(board),
      turnNumber: turn,
      noCaptureMoves: ncm,
      legalMoves: moves.map((m) => ({ from: m.from.slice(), to: m.to.slice() })),
      history,
      random: rnd,
    };

    let mv;
    try {
      mv = bots[side].onTurn(me, opponent, game);
    } catch (e) {
      return fin(oppSide, e && e.quota ? 'runtime' : 'error');
    }
    const ok = mv && mv.from && mv.to && moves.some((m) =>
      m.from[0] === mv.from[0] && m.from[1] === mv.from[1] &&
      m.to[0] === mv.to[0] && m.to[1] === mv.to[1]);
    if (!ok) return fin(oppSide, 'illegal');

    const r = Rules._rawApply(board, side, mv); // 引擎结算不占脚本预算
    board = r.board;
    ncm = r.captured.length > 0 ? 0 : ncm + 1;
    history.push({ turn, side, from: mv.from.slice(), to: mv.to.slice(), captured: r.captured, pass: false });
    turn++;
    const v = Rules.judge(board, ncm);
    if (v) return fin(v.winner, v.reason);
    side = oppSide;
    if (turn > 2000) return fin('draw', 'draw'); // 理论不可达的安全阀
  }
}

module.exports = { playMatch, initBoard };
