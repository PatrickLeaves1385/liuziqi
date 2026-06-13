'use strict';
// 规则库(按《钳王争霸规则 v2.1》重建) + 思考点计量
// 计费模型:"仅计 apply"(每次 apply = 1 点,其余 0 点)。
//
// 计量改为「每手一个实例」(makeRules(budget)),不再用模块级全局计数:
//   - 杜绝并发对局相互串改预算(为对局进子进程隔离做准备);
//   - 交给玩家代码的计量对象只暴露安全 API,不含 _reset/_rawApply 等内部方法,
//     避免脚本调用 _reset 自行重置预算、或用 _rawApply 绕过计量。
//   - 引擎与训练棋手用无计量的静态 Rules(含 _rawApply/_counts)。

function clone(board) { return board.map((col) => col.slice()); }
function other(side) { return side === 'black' ? 'red' : 'black'; }

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

function counts(board) {
  let s = 0, k = 0;
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {
    if (board[x][y] === 'black') s++; else if (board[x][y] === 'red') k++;
  }
  return { black: s, red: k };
}

// 终局裁定(规则 v2.1 §6):≤1 子判负;连续 20 手无吃子按子力裁定(领先 1 子即判胜,维持现行规则)
function judge(board, ncm) {
  const c = counts(board);
  if (c.black <= 1) return { winner: 'red', reason: 'eliminated' };
  if (c.red <= 1) return { winner: 'black', reason: 'eliminated' };
  if (ncm >= 20) {
    if (c.black === c.red) return { winner: 'draw', reason: 'draw' };
    return { winner: c.black > c.red ? 'black' : 'red', reason: 'material' };
  }
  return null;
}

// 每手一个计量实例:交给棋手代码使用。只暴露安全 API(legalMoves/apply/judge/clone/other/remaining)。
function makeRules(budget) {
  let pts = budget;
  return {
    legalMoves, judge, clone, other,
    remaining() { return pts; },
    apply(board, side, move) {
      if (pts < 1) { const e = new Error('compute quota exceeded'); e.quota = true; throw e; }
      pts -= 1;
      return rawApply(board, side, move);
    },
  };
}

// 引擎/训练棋手用的无计量静态视图(含内部 _rawApply/_counts,绝不注入玩家沙箱)
const Rules = { legalMoves, judge, clone, other, _counts: counts, _rawApply: rawApply };

module.exports = { Rules, makeRules };
