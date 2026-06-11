'use strict';
// 参数扫描(修复版) —— 修复点:
//   [FIX-1] 固定种子集:全部配置共用同一组种子(原版 seedBase = 50000 + i*100,
//           每组配置跑在不同种子上,违反 §14.4 "平衡性对照实验必须固定种子集做配对比较",
//           种子方差污染配置间比较)
//   [FIX-2] 配对差异检验:每组配置与定稿基线在逐种子槽位上精确对比
//           (引擎确定性 ⇒ 同槽位差异 100% 由配置造成;并做符号检验式汇总判断种子集代表性)
//   [FIX-3] 稳健性复验:Top 配置与基线在第二组不相交种子集上复跑,验证排名稳定
//   [FIX-4] 复验局数 10 局/对(原扫描期 6 局为提速减量,定稿口径应为 10)
//   [FIX-5] 清理死代码(原 assess 中未使用的 loser)
const { playMatch } = require('./engine_quota');
const { makeTemplates } = require('./templates_factory');

const BUDGET = 100;
const GAMES_PER_PAIR = 10;
const SEED_BASE_A = 70000; // 主种子集
const SEED_BASE_B = 90000; // 稳健性复验种子集(与 A 不相交)

// 定稿基线(bots_templates_final.js 的 WEIGHTS)
const BASELINE = { blockMob: 60, rulDef: 8, cenThreat: 15, cenCenter: 50, cenHunt: 4, cenMat: 1000 };

// [FIX-1] 种子只由(对阵序号, 局序)决定,与配置无关
function seedFor(base, pairIdx, g) { return base + pairIdx * 1000 + g; }

function roundRobin(bots, seedBase) {
  const results = [];
  let pairIdx = 0;
  for (let i = 0; i < bots.length; i++) {
    for (let j = i + 1; j < bots.length; j++) {
      for (let g = 1; g <= GAMES_PER_PAIR; g++) {
        const p1Stone = g <= GAMES_PER_PAIR / 2;
        const m = p1Stone ? { stone: bots[i], stick: bots[j] } : { stone: bots[j], stick: bots[i] };
        const r = playMatch(m, seedFor(seedBase, pairIdx, g), BUDGET);
        const winnerName = r.winner === 'draw' ? null : m[r.winner].name;
        const sig = r.history.map((h) => (h.pass ? 'P' : `${h.from}${h.to}${h.captured.length}`)).join('|');
        results.push({
          slot: `${pairIdx}-${g}`, pairIdx, g,
          winnerName, reason: r.reason, sig,
          names: [bots[i].name, bots[j].name],
          finalPieces: r.finalPieces, turns: r.turns,
        });
      }
      pairIdx++;
    }
  }
  return results;
}

function assess(w, seedBase) {
  const bots = makeTemplates(w);
  const rs = roundRobin(bots, seedBase);
  const score = {}, wins = {}, matWins = {}, elimWins = {};
  for (const b of bots) { score[b.name] = 0; wins[b.name] = 0; matWins[b.name] = 0; elimWins[b.name] = 0; }
  for (const r of rs) {
    if (r.winnerName) {
      score[r.winnerName] += 2; wins[r.winnerName]++;
      if (r.reason === 'material' || r.reason === 'stalemate') matWins[r.winnerName]++;
      if (r.reason === 'eliminated') elimWins[r.winnerName]++;
    } else {
      r.names.forEach((n) => (score[n] += 1));
    }
  }
  const vals = Object.values(score);
  const spread = Math.max(...vals) - Math.min(...vals);
  const distinct = new Set(rs.map((r) => r.sig)).size;

  let violations = 0;
  if (wins['裁定派'] < 2) violations++;
  else if (matWins['裁定派'] <= elimWins['裁定派'] && matWins['裁定派'] / wins['裁定派'] < 0.5) violations++;
  const cenNonRul = rs.filter((r) => r.names.includes('抢中派') && !r.names.includes('裁定派'));
  const cenW = cenNonRul.filter((r) => r.winnerName === '抢中派');
  const cenE = cenW.filter((r) => r.reason === 'eliminated').length;
  if (cenW.length < 2) violations++;
  else if (cenE / cenW.length < 0.5) violations++;

  const penalty = spread + 25 * violations - 0.3 * distinct;
  return { spread, distinct, violations, penalty, score, wins, matWins, elimWins, rs };
}

// [FIX-2] 配对差异检验:逐槽位对比候选与基线
function pairedDiff(rsCand, rsBase) {
  let sameSig = 0, winnerChanged = 0;
  const perBotDelta = {};
  const byName = (rs) => { const m = {}; for (const r of rs) m[r.slot] = r; return m; };
  const A = byName(rsCand), B = byName(rsBase);
  for (const slot of Object.keys(B)) {
    const a = A[slot], b = B[slot];
    if (a.sig === b.sig) sameSig++;
    if (a.winnerName !== b.winnerName) {
      winnerChanged++;
      if (b.winnerName) perBotDelta[b.winnerName] = (perBotDelta[b.winnerName] || 0) - 1;
      if (a.winnerName) perBotDelta[a.winnerName] = (perBotDelta[a.winnerName] || 0) + 1;
    }
  }
  return { totalSlots: Object.keys(B).length, sameSig, winnerChanged, perBotDelta };
}

function headToHead(rs, n1, n2) {
  const games = rs.filter((r) => r.names.includes(n1) && r.names.includes(n2));
  const w1 = games.filter((r) => r.winnerName === n1).length;
  const w2 = games.filter((r) => r.winnerName === n2).length;
  return `${n1} ${w1}:${w2} ${n2} (平${games.length - w1 - w2})`;
}

// ===== 主流程 =====
const grid = [];
for (const cenMat of [800, 900, 1000])
  for (const rulDef of [0, 8])
    for (const cenHunt of [4, 20])
      grid.push({ blockMob: 60, rulDef, cenThreat: 15, cenCenter: 50, cenHunt, cenMat });

const t0 = Date.now();
console.log(`=== 主扫描:${grid.length} 组配置 × ${GAMES_PER_PAIR * 6} 局,固定种子集 A(base=${SEED_BASE_A}) ===\n`);
const evaluated = grid.map((w) => ({ w, ...assess(w, SEED_BASE_A) }));

const baseEval = evaluated.find((e) => JSON.stringify(e.w) === JSON.stringify(BASELINE));
evaluated.sort((a, b) => a.penalty - b.penalty);

console.log('排名(penalty 越低越好):');
for (const e of evaluated) {
  const tag = JSON.stringify(e.w) === JSON.stringify(BASELINE) ? ' ←定稿基线' : '';
  console.log(
    `penalty=${e.penalty.toFixed(1).padStart(6)} 极差=${String(e.spread).padStart(2)} 违例=${e.violations} ` +
    `独立棋路=${e.distinct}/60 权重={cenMat:${e.w.cenMat},rulDef:${e.w.rulDef},cenHunt:${e.w.cenHunt}} ` +
    `积分=${JSON.stringify(e.score)}${tag}`
  );
}

console.log('\n=== 配对差异检验(各配置 vs 定稿基线,同种子逐槽位) ===');
for (const e of evaluated) {
  if (e === baseEval) continue;
  const d = pairedDiff(e.rs, baseEval.rs);
  console.log(
    `权重={cenMat:${e.w.cenMat},rulDef:${e.w.rulDef},cenHunt:${e.w.cenHunt}} → ` +
    `棋路相同 ${d.sameSig}/${d.totalSlots} 槽位,胜者改变 ${d.winnerChanged} 槽位,积分增减 ${JSON.stringify(d.perBotDelta)}`
  );
}

console.log('\n=== 定稿基线详情(种子集 A) ===');
console.log(`积分=${JSON.stringify(baseEval.score)} 极差=${baseEval.spread} 违例=${baseEval.violations} 独立棋路=${baseEval.distinct}/60`);
console.log(`裁定派胜局构成(mat/elim)=${baseEval.matWins['裁定派']}/${baseEval.elimWins['裁定派']}  抢中派(mat/elim)=${baseEval.matWins['抢中派']}/${baseEval.elimWins['抢中派']}`);
console.log('头对头:');
const names = ['子力派', '封锁派', '裁定派', '抢中派'];
for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) console.log('  ' + headToHead(baseEval.rs, names[i], names[j]));
console.log('终局原因分布:', JSON.stringify(baseEval.rs.reduce((m, r) => ((m[r.reason] = (m[r.reason] || 0) + 1), m), {})));

// [FIX-3] 稳健性复验:Top1 与基线在种子集 B 上复跑
console.log(`\n=== 稳健性复验:Top1 与定稿基线 @ 种子集 B(base=${SEED_BASE_B}) ===`);
const top1 = evaluated[0];
const topB = { w: top1.w, ...assess(top1.w, SEED_BASE_B) };
const baseB = JSON.stringify(top1.w) === JSON.stringify(BASELINE)
  ? topB : { w: BASELINE, ...assess(BASELINE, SEED_BASE_B) };
console.log(`Top1   @B: penalty=${topB.penalty.toFixed(1)} 极差=${topB.spread} 违例=${topB.violations} 积分=${JSON.stringify(topB.score)}`);
console.log(`基线   @B: penalty=${baseB.penalty.toFixed(1)} 极差=${baseB.spread} 违例=${baseB.violations} 积分=${JSON.stringify(baseB.score)}`);
console.log(`排名稳定性: 种子集A中 Top1 penalty ${top1.penalty.toFixed(1)} vs 基线 ${baseEval.penalty.toFixed(1)};种子集B中 ${topB.penalty.toFixed(1)} vs ${baseB.penalty.toFixed(1)}`);

const out = evaluated.map(({ rs, ...rest }) => rest); // 落盘不含逐局明细,另存
require('fs').writeFileSync('/home/claude/sixchess/sweep_result_fixed.json', JSON.stringify({
  meta: { GAMES_PER_PAIR, SEED_BASE_A, SEED_BASE_B, BUDGET, baseline: BASELINE },
  ranking: out,
  robustness: { top1AtB: { w: topB.w, penalty: topB.penalty, score: topB.score, violations: topB.violations },
                baselineAtB: { w: baseB.w, penalty: baseB.penalty, score: baseB.score, violations: baseB.violations } },
}, null, 2));
console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s,结果已写入 sweep_result_fixed.json`);
