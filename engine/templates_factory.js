'use strict';
// 模板工厂:四套评估的关键权重参数化
// w = { blockMob: 封锁派机动权重, rulDef: 裁定派被威胁惩罚, cenThreat: 抢中派威胁权重, cenCenter: 抢中派中心权重 }
const { Rules } = require('./rules_metered');
 
const WIN = 1000000;
const CENTER = new Set(['1,1', '2,1', '1,2', '2,2']);
class Stop extends Error {}
 
// R = 本手计量实例(game.rules)；apply 计点、remaining 自查余量
function safeApply(R, board, side, mv) {
  if (R.remaining() < 1) throw new Stop();
  return R.apply(board, side, mv);
}
function counts(board) {
  let ns = 0, nk = 0;
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {
    if (board[x][y] === 'black') ns++; else if (board[x][y] === 'red') nk++;
  }
  return { black: ns, red: nk };
}
function mobility(board, side) { return Rules.legalMoves(board, side).length; }
function centerCount(board, side) {
  let c = 0;
  for (const k of CENTER) { const [x, y] = k.split(',').map(Number); if (board[x][y] === side) c++; }
  return c;
}
function cohesion(board, side) {
  let c = 0;
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {
    if (board[x][y] !== side) continue;
    if (x + 1 < 4 && board[x + 1][y] === side) c++;
    if (y + 1 < 4 && board[x][y + 1] === side) c++;
  }
  return c;
}
function threats(board, side) {
  const opp = Rules.other(side);
  let t = 0;
  const lines = [];
  for (let y = 0; y < 4; y++) lines.push([[0, y], [1, y], [2, y], [3, y]]);
  for (let x = 0; x < 4; x++) lines.push([[x, 0], [x, 1], [x, 2], [x, 3]]);
  for (const line of lines) {
    const s = line.map(([x, y]) => board[x][y]);
    const occ = [];
    for (let i = 0; i < 4; i++) if (s[i] !== null) occ.push(i);
    if (occ.length !== 3) continue;
    if (occ[1] - occ[0] !== 1 || occ[2] - occ[1] !== 1) continue;
    const p = occ.map((i) => s[i]);
    if ((p[0] === side && p[1] === side && p[2] === opp) ||
        (p[0] === opp && p[1] === side && p[2] === side)) t++;
  }
  return t;
}
function orderHint(board, side, mv) {
  const [tx, ty] = mv.to;
  let h = 0;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = tx + dx, y = ty + dy;
    if (x >= 0 && x < 4 && y >= 0 && y < 4 && board[x][y] === side) h++;
  }
  return h;
}
function negamax(R, board, side, depth, alpha, beta, ncm, prevPass, ply, evalFn) {
  const verdict = Rules.judge(board, ncm);
  if (verdict) {
    if (verdict.winner === 'draw') return 0;
    return verdict.winner === side ? WIN - ply : -WIN + ply;
  }
  if (depth === 0) return evalFn(board, side, ncm);
  const moves = Rules.legalMoves(board, side);
  if (moves.length === 0) {
    if (prevPass) {
      const c = counts(board);
      if (c.black === c.red) return 0;
      const w = c.black > c.red ? 'black' : 'red';
      return w === side ? WIN - ply : -WIN + ply;
    }
    return -negamax(R, board, Rules.other(side), depth - 1, -beta, -alpha, ncm + 1, true, ply + 1, evalFn);
  }
  moves.sort((a, b) => orderHint(board, side, b) - orderHint(board, side, a));
  let best = -Infinity;
  for (const mv of moves) {
    const r = safeApply(R, board, side, mv);
    const nNcm = r.captured.length > 0 ? 0 : ncm + 1;
    const v = -negamax(R, r.board, Rules.other(side), depth - 1, -beta, -alpha, nNcm, false, ply + 1, evalFn);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}
function makeBot(name, evalFn) {
  const bot = { name, meta: { depthSum: 0, depthN: 0 } };
  bot.onTurn = function (me, opponent, game) {
    const R = game.rules; // 本手计量实例
    const roots = game.legalMoves.slice();
    for (let i = roots.length - 1; i > 0; i--) {
      const j = Math.floor(game.random() * (i + 1));
      [roots[i], roots[j]] = [roots[j], roots[i]];
    }
    roots.sort((a, b) => orderHint(game.board, me.side, b) - orderHint(game.board, me.side, a));
    let best = roots[0], completed = 0;
    for (let depth = 1; depth <= 6; depth++) {
      let layerBest = null, layerV = -Infinity;
      try {
        for (const mv of roots) {
          const r = safeApply(R, game.board, me.side, mv);
          const ncm = r.captured.length > 0 ? 0 : game.noCaptureMoves + 1;
          const v = -negamax(R, r.board, opponent.side, depth - 1, -Infinity, Infinity, ncm, false, 1, evalFn);
          if (v > layerV) { layerV = v; layerBest = mv; }
        }
        best = layerBest; completed = depth;
        const idx = roots.indexOf(layerBest);
        if (idx > 0) { roots.splice(idx, 1); roots.unshift(layerBest); }
      } catch (e) {
        if (e instanceof Stop) break;
        throw e;
      }
    }
    bot.meta.depthSum += completed; bot.meta.depthN++;
    return best;
  };
  return bot;
}
 
function makeTemplates(w) {
  const evalMaterial = (board, side, ncm) => {
    const c = counts(board); const opp = Rules.other(side);
    const diff = (side === 'black' ? c.black - c.red : c.red - c.black);
    return 1000 * diff + 4 * (mobility(board, side) - mobility(board, opp))
      + 6 * (centerCount(board, side) - centerCount(board, opp));
  };
  const evalBlockade = (board, side, ncm) => {
    const c = counts(board); const opp = Rules.other(side);
    const diff = (side === 'black' ? c.black - c.red : c.red - c.black);
    const myMob = mobility(board, side), opMob = mobility(board, opp);
    let s = 500 * diff + w.blockMob * (myMob - opMob);
    if (opMob === 0) s += 250;
    if (myMob === 0) s -= 250;
    return s + 2 * (centerCount(board, side) - centerCount(board, opp));
  };
  const evalRuling = (board, side, ncm) => {
    const c = counts(board); const opp = Rules.other(side);
    const diff = (side === 'black' ? c.black - c.red : c.red - c.black);
    let s = 1000 * diff + 8 * cohesion(board, side)
      + 3 * (mobility(board, side) - mobility(board, opp))
      - w.rulDef * threats(board, opp);
    if (diff > 0) s += 35 * ncm; else if (diff < 0) s -= 15 * ncm;
    return s;
  };
  const evalCenter = (board, side, ncm) => {
    const c = counts(board); const opp = Rules.other(side);
    const diff = (side === 'black' ? c.black - c.red : c.red - c.black);
    return (w.cenMat || 800) * diff
      + w.cenThreat * threats(board, side)
      - (w.cenOppThreat || w.cenThreat) * threats(board, opp)  // 非对称威胁规避(结构项)
      + w.cenCenter * (centerCount(board, side) - centerCount(board, opp))
      + 4 * (mobility(board, side) - mobility(board, opp))
      - (diff > 0 ? (w.cenHunt || 3) : 3) * ncm; // 领先时狩猎:拒绝守成,持续制造吃子打 eliminated
  };
  return [
    makeBot('子力派', evalMaterial),
    makeBot('封锁派', evalBlockade),
    makeBot('裁定派', evalRuling),
    makeBot('抢中派', evalCenter),
  ];
}
 
module.exports = { makeTemplates };
 