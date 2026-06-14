'use strict';
// 规则核心（按《钳王争霸规则 v2.1》）——纯函数，无副作用、无计量、无第三方依赖。
// 单一事实源：Node 端 rules_metered/engine_quota 引用本文件；浏览器经 /game-rules.js 直接加载
// （见 server.js 路由）。这样前端「本地落子」与服务器重放/裁定走的是同一套规则，杜绝漂移。
// UMD：在 Node 下挂到 module.exports；在浏览器下挂到 window.GameRules。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GameRules = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function clone(board) { return board.map((col) => col.slice()); }
  function other(side) { return side === 'black' ? 'red' : 'black'; }

  // 开局布局（黑先行）：黑 (0,3)(1,3)(2,3)(3,3)(0,2)(3,2)；红 (0,0)(1,0)(2,0)(3,0)(0,1)(3,1)
  function initBoard() {
    const b = Array.from({ length: 4 }, () => Array(4).fill(null));
    for (const [x, y] of [[0, 3], [1, 3], [2, 3], [3, 3], [0, 2], [3, 2]]) b[x][y] = 'black';
    for (const [x, y] of [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [3, 1]]) b[x][y] = 'red';
    return b;
  }

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

  // 吃子结算（规则 v2.1 §5）：
  // - 仅走棋方可吃（只识别"走棋方 2 连 + 对方 1 子"，送上门不吃）
  // - 只查新位置所在横线与竖线（离开的线不结算）
  // - 两线在落子后的同一棋盘状态上同时判定（双线同吃），判定后一并移除（不连锁）
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
      // (side,opp,side) 交错不吃；(opp,opp,side) 为送上门，走棋方无 2 连，不吃
    }
    for (const [x, y] of captured) board[x][y] = null; // 同时移除，不连锁
    return captured;
  }

  function apply(board, side, move) {
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

  // 终局裁定（规则 v2.1 §6）：≤1 子判负；连续 20 手无吃子按子力裁定（领先 1 子即判胜）
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

  return { clone, other, initBoard, legalMoves, apply, counts, judge };
});
