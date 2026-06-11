'use strict';
// 规则库(按《六子棋规则 v2.1》重建) + 思考点计量
// 计费模型沿用内部模拟基线:"仅计 apply"(Rules.apply = 1 点/次,其余 0 点)
// —— 与策划案 §14.2 遗留复测义务的口径一致:历史扫描数据均产生于该简化模型。

let _pts = Infinity;

function _reset(budget) { _pts = budget; }
function remaining() { return _pts; }

function clone(board) { return board.map((col) => col.slice()); }
function other(side) { return side === 'stone' ? 'stick' : 'stone'; }

function legalMoves(board, side) {
  const mv = [];
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {
    if (board[x][y] !== side) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < 4 && ny >= 0 && ny < 4 && board[nx][ny] === null) {
        mv.push({ from: [x, y], to: [nx, ny] });
      }
    }
  }
  return mv;
}

// 吃子结算(规则 v2.1 §5):
// - 仅走棋方可吃(只识别"走棋方 2 连 + 对方 1 子",送上门不吃)
// - 只查新位置所在横线与竖线(离开的线不结算)
// - 两线在落子后的同一棋盘状态上同时判定(双线同吃),判定后一并移除(不连锁)
function resolveCaptures(board, side, tx, ty) {
  const opp = other(side);
  const captured = [];
  const lines = [
    [[0, ty], [1, ty], [2, ty], [3, ty]], // 横线 y = ty
    [[tx, 0], [tx, 1], [tx, 2], [tx, 3]], // 竖线 x = tx
  ];
  for (const line of lines) {
    const occ = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = line[i];
      if (board[x][y] !== null) occ.push(i);
    }
    if (occ.length !== 3) continue;                              // 恰好 3 子
    if (occ[1] - occ[0] !== 1 || occ[2] - occ[1] !== 1) continue; // 位置相连
    const v = occ.map((i) => { const [x, y] = line[i]; return board[x][y]; });
    if (v[0] === side && v[1] === side && v[2] === opp) captured.push(line[occ[2]]);
    else if (v[0] === opp && v[1] === side && v[2] === side) captured.push(line[occ[0]]);
    // (side,opp,side) 交错不吃;(opp,opp,side) 为送上门,走棋方无 2 连,不吃
  }
  for (const [x, y] of captured) board[x][y] = null; // 同时移除,不连锁
  return captured;
}

function rawApply(board, side, move) {
  const nb = clone(board);
  const [fx, fy] = move.from, [tx, ty] = move.to;
  nb[fx][fy] = null;
  nb[tx][ty] = side;
  const captured = resolveCaptures(nb, side, tx, ty);
  return { board: nb, captured };
}

function apply(board, side, move) {
  if (_pts < 1) {
    const e = new Error('compute quota exceeded');
    e.quota = true;
    throw e;
  }
  _pts -= 1;
  return rawApply(board, side, move);
}

function counts(board) {
  let s = 0, k = 0;
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {
    if (board[x][y] === 'stone') s++; else if (board[x][y] === 'stick') k++;
  }
  return { stone: s, stick: k };
}

// 终局裁定(规则 v2.1 §6):≤1 子判负;连续 20 手无吃子按子力裁定(领先 1 子即判胜,维持现行规则)
function judge(board, ncm) {
  const c = counts(board);
  if (c.stone <= 1) return { winner: 'stick', reason: 'eliminated' };
  if (c.stick <= 1) return { winner: 'stone', reason: 'eliminated' };
  if (ncm >= 20) {
    if (c.stone === c.stick) return { winner: 'draw', reason: 'draw' };
    return { winner: c.stone > c.stick ? 'stone' : 'stick', reason: 'material' };
  }
  return null;
}

const Rules = {
  legalMoves, apply, judge, clone, other, remaining,
  _reset, _rawApply: rawApply, _counts: counts,
};

module.exports = { Rules };
