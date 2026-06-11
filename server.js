'use strict';
// 六子棋 · AI 对战观战 —— 零依赖 Node 全栈服务器
// 运行: node server.js  然后浏览器打开 http://localhost:3000
// 仅用 Node 内置 http/fs/path，无需 npm install。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { playMatch, initBoard } = require('./engine/engine_quota');
const { makeTemplates } = require('./engine/templates_factory');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// 定稿基线权重（来自 sweep 复跑报告 / sweep_templates_fixed.js 的 BASELINE）
const WEIGHTS = { blockMob: 60, rulDef: 8, cenThreat: 15, cenCenter: 50, cenHunt: 4, cenMat: 1000 };

// 四套评估流派（顺序须与 makeTemplates 返回顺序一致）
const TEMPLATE_META = [
  { name: '子力派', summary: '算子力差为主，辅以机动与中心微调；直来直去地吃子换子。' },
  { name: '封锁派', summary: '重机动差，压制对方走法数，把对手逼到无路可走（stalemate）。' },
  { name: '裁定派', summary: '重棋子凝聚、规避被吃威胁；领先时拖到 20 手按子力判胜。' },
  { name: '抢中派', summary: '抢占中心 2×2 + 威胁导向；领先时持续制造吃子打 eliminated。' },
];
const TEMPLATE_NAMES = TEMPLATE_META.map((t) => t.name);

function botByName(name) {
  // 每次对局新建一组棋手，避免 meta 状态跨局污染
  const bots = makeTemplates(WEIGHTS);
  const bot = bots.find((b) => b.name === name);
  if (!bot) throw new Error(`未知流派: ${name}`);
  return bot;
}

function runMatch({ stone, stick, seed, budget }) {
  const bots = { stone: botByName(stone), stick: botByName(stick) };
  const r = playMatch(bots, seed >>> 0, budget);
  return {
    ok: true,
    stoneName: stone,
    stickName: stick,
    seed: seed >>> 0,
    budget,
    winner: r.winner,
    reason: r.reason,
    turns: r.turns,
    finalPieces: r.finalPieces,
    initialBoard: initBoard(),
    history: r.history,
  };
}

// ---- HTTP 工具 ----
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  // 防目录穿越
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url.split('?')[0] === '/api/templates') {
      return sendJson(res, 200, { templates: TEMPLATE_META, weights: WEIGHTS });
    }
    if (req.method === 'POST' && req.url.split('?')[0] === '/api/match') {
      const body = await readBody(req);
      let p;
      try { p = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const stone = p.stone, stick = p.stick;
      if (!TEMPLATE_NAMES.includes(stone) || !TEMPLATE_NAMES.includes(stick)) {
        return sendJson(res, 400, { ok: false, error: '石子方/木棍方流派非法' });
      }
      let seed = Number.isFinite(+p.seed) ? Math.floor(+p.seed) : 70001;
      let budget = Number.isFinite(+p.budget) ? Math.floor(+p.budget) : 100;
      budget = Math.max(1, Math.min(100000, budget));
      const t0 = Date.now();
      const result = runMatch({ stone, stick, seed, budget });
      result.elapsedMs = Date.now() - t0;
      return sendJson(res, 200, result);
    }
    if (req.method === 'GET') return serveStatic(req, res);
    res.writeHead(405); res.end('Method Not Allowed');
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`六子棋观战服务器已启动: http://localhost:${PORT}`);
  console.log(`流派: ${TEMPLATE_NAMES.join(' / ')}  权重基线: ${JSON.stringify(WEIGHTS)}`);
});
