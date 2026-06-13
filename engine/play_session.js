'use strict';
// 试玩对局核心（无状态重放 + 推进到人类可走）。由子进程 runner 调用，与 Web/DB 进程隔离。
// 重放校验完全由本端重算（不信任客户端附带的吃子/pass 字段）。不入库、不计分。
const { initBoard, mulberry32, piecesOf } = require('./engine_quota');
const { Rules, makeRules } = require('./rules_metered');

// spec: { mode, humanSide, history, opponent }
//   opponent: { kind:'bot', code, name } | { kind:'builtin', name } | null(local)
// deps:  { makeBot, findBuiltin }
// 返回 { ok:false, status, error } 或 { ok:true, payload }
function runPlay(spec, { makeBot, findBuiltin }) {
  const local = spec.mode === 'local';
  let humanSide = null, botSide = null, bot = null, oppName = null;
  if (!local) {
    humanSide = spec.humanSide;
    if (humanSide !== 'black' && humanSide !== 'red') return { ok: false, status: 400, error: 'humanSide 须为 black/red' };
    botSide = Rules.other(humanSide);
    const opp = spec.opponent || {};
    if (opp.kind === 'bot') {
      const made = makeBot(opp.code);
      if (!made.bot) return { ok: false, status: 500, error: '棋手脚本加载失败' };
      bot = made.bot; oppName = opp.name || '玩家棋手';
    } else if (opp.kind === 'builtin') {
      bot = findBuiltin(opp.name);
      if (!bot) return { ok: false, status: 400, error: '对手非法' };
      oppName = opp.name;
    } else {
      return { ok: false, status: 400, error: '缺少对手' };
    }
  }
  const rawHistory = Array.isArray(spec.history) ? spec.history : [];
  if (rawHistory.length > 2000) return { ok: false, status: 400, error: '历史过长' };

  let board = initBoard();
  let side = 'black', turn = 1, ncm = 0, lastPass = false;
  const history = [];
  let status = null;
  const finish = (winner, reason) => { status = { winner, reason }; };

  function applyStep(mv) {
    const r = Rules._rawApply(board, side, mv);
    board = r.board;
    ncm = r.captured.length > 0 ? 0 : ncm + 1;
    history.push({ turn, side, from: mv.from.slice(), to: mv.to.slice(), captured: r.captured, pass: false });
    lastPass = false; turn++;
    const v = Rules.judge(board, ncm);
    if (v) finish(v.winner, v.reason);
    else side = Rules.other(side);
  }
  function applyPass() {
    history.push({ turn, side, from: null, to: null, captured: [], pass: true });
    ncm++;
    if (lastPass) {
      const c = Rules._counts(board);
      finish(c.black === c.red ? 'draw' : (c.black > c.red ? 'black' : 'red'), c.black === c.red ? 'draw' : 'stalemate');
      return;
    }
    lastPass = true; turn++;
    const v = Rules.judge(board, ncm);
    if (v) finish(v.winner, v.reason);
    else side = Rules.other(side);
  }

  for (const h of rawHistory) {
    if (status) return { ok: false, status: 400, error: '历史在终局后仍有着法' };
    if (!h || h.side !== side) return { ok: false, status: 400, error: `第 ${turn} 手行棋方不符` };
    const moves = Rules.legalMoves(board, side);
    if (h.pass) {
      if (moves.length > 0) return { ok: false, status: 400, error: `第 ${turn} 手有合法走法，不能停一手` };
      applyPass();
    } else {
      const okMv = h.from && h.to && moves.some((m) => m.from[0] === h.from[0] && m.from[1] === h.from[1] && m.to[0] === h.to[0] && m.to[1] === h.to[1]);
      if (!okMv) return { ok: false, status: 400, error: `第 ${turn} 手走法非法` };
      applyStep({ from: h.from, to: h.to });
    }
  }

  // 推进到人类可走为止：机器人应手 / 双方无子可动自动 pass
  while (!status) {
    const moves = Rules.legalMoves(board, side);
    if (moves.length === 0) { applyPass(); continue; }
    if (local || side === humanSide) break;
    const oppSide = Rules.other(side);
    const myPieces = piecesOf(board, side), opPieces = piecesOf(board, oppSide);
    const game = {
      board: Rules.clone(board), turnNumber: turn, noCaptureMoves: ncm,
      legalMoves: moves.map((m) => ({ from: m.from.slice(), to: m.to.slice() })),
      history, random: mulberry32((0x5EED ^ (turn * 2654435761)) >>> 0),
      rules: makeRules(100),
    };
    let mv;
    try {
      mv = bot.onTurn(
        { side, pieces: myPieces, capturedCount: 6 - myPieces.length },
        { side: oppSide, pieces: opPieces, capturedCount: 6 - opPieces.length },
        game,
      );
    } catch { finish(humanSide, 'error'); break; }
    const okMv = mv && mv.from && mv.to && moves.some((m) => m.from[0] === mv.from[0] && m.from[1] === mv.from[1] && m.to[0] === mv.to[0] && m.to[1] === mv.to[1]);
    if (!okMv) { finish(humanSide, 'illegal'); break; }
    applyStep(mv);
  }

  const toMove = status ? null : (local ? side : humanSide);
  const legal = status ? [] : Rules.legalMoves(board, toMove);
  return {
    ok: true,
    payload: {
      ok: true, mode: local ? 'local' : 'vs', opponent: oppName, humanSide, botSide, toMove,
      initialBoard: initBoard(), history, board, counts: Rules._counts(board),
      legalMoves: legal,
      status: status ? { over: true, winner: status.winner, reason: status.reason, turns: history.length } : { over: false, turns: history.length },
    },
  };
}

module.exports = { runPlay };
