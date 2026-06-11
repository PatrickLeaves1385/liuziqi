'use strict';
// 六子棋 Agent 平台 · Node 全栈服务器 v2.0
// 零第三方依赖，使用 Node 内置 http / fs / path / crypto / vm / node:sqlite
const http = require('http');
const fs = require('fs');
const path = require('path');

const { playMatch, initBoard } = require('./engine/engine_quota');
const { makeTemplates } = require('./engine/templates_factory');
const { makeBot } = require('./engine/sandbox');
const { runSmokeTests } = require('./engine/smoke');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// 定稿基线权重（§14.4 sweep 复跑报告）
const WEIGHTS = { blockMob: 60, rulDef: 8, cenThreat: 15, cenCenter: 50, cenHunt: 4, cenMat: 1000 };
const TEMPLATE_META = [
  { name: '子力派', summary: '以子力差为主，辅以机动与中心；直接吃子换子。' },
  { name: '封锁派', summary: '压制对方机动数，把对手逼到无路可走。' },
  { name: '裁定派', summary: '棋子凝聚 + 规避被吃；领先时拖到 20 手按子力判胜。' },
  { name: '抢中派', summary: '抢中心 + 威胁导向；领先时持续吃子打 eliminated。' },
];
const TEMPLATE_NAMES = TEMPLATE_META.map((t) => t.name);

// ---- HTTP 工具 ----
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(PUBLIC_DIR, path.normalize(p));
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function parseJson(raw) { try { return JSON.parse(raw || '{}'); } catch { return null; } }

// ---- Auth 中间件 ----
function requireAuth(req) {
  const auth = req.headers['authorization'] || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!key) return { bot: null, error: '缺少 Authorization: Bearer <bot_key>' };
  const bot = db.getBotByApiKey(key);
  if (!bot) return { bot: null, error: 'API Key 无效' };
  return { bot, error: null };
}

// ---- 路由表 ----
// 格式: [method, path_or_regex, handler(req, res, match, body)]
const routes = [];
function route(method, pattern, fn) { routes.push({ method, pattern, fn }); }
async function dispatch(req, res) {
  for (const r of routes) {
    if (r.method !== req.method && r.method !== '*') continue;
    let match;
    if (typeof r.pattern === 'string') {
      if (req.url.split('?')[0] !== r.pattern) continue;
      match = [];
    } else {
      match = req.url.split('?')[0].match(r.pattern);
      if (!match) continue;
    }
    const body = (req.method === 'POST' || req.method === 'PUT') ? parseJson(await readBody(req)) : {};
    if (body === null) return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' });
    await r.fn(req, res, match, body);
    return;
  }
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(404); res.end('Not Found');
}

// ============================================================
// § 演示 API（原有，保留）
// ============================================================
route('GET', '/api/templates', (req, res) => {
  sendJson(res, 200, { templates: TEMPLATE_META, weights: WEIGHTS });
});

route('POST', '/api/match', async (req, res, _m, body) => {
  const { stone, stick } = body;
  if (!TEMPLATE_NAMES.includes(stone) || !TEMPLATE_NAMES.includes(stick))
    return sendJson(res, 400, { ok: false, error: '流派非法' });
  const seed = Math.floor(+body.seed) || 70001;
  const budget = Math.max(1, Math.min(100000, Math.floor(+body.budget) || 100));
  const bots = (() => { const t = makeTemplates(WEIGHTS); return { stone: t.find((b) => b.name === stone), stick: t.find((b) => b.name === stick) }; })();
  const t0 = Date.now();
  const r = playMatch(bots, seed >>> 0, budget);
  sendJson(res, 200, { ok: true, stoneName: stone, stickName: stick, seed, budget, winner: r.winner, reason: r.reason, turns: r.turns, finalPieces: r.finalPieces, initialBoard: initBoard(), history: r.history, elapsedMs: Date.now() - t0 });
});

// ============================================================
// § 账号注册（§12.1）
// POST /api/account/register
// body: { username, email, botName, avatar, templateName }
// ============================================================
route('POST', '/api/account/register', (req, res, _m, body) => {
  const { username, email, botName, avatar, templateName } = body;
  if (!username || !email || !botName || !templateName)
    return sendJson(res, 400, { ok: false, error: '缺少必填字段: username/email/botName/templateName' });
  if (!TEMPLATE_NAMES.includes(templateName))
    return sendJson(res, 400, { ok: false, error: `templateName 须为: ${TEMPLATE_NAMES.join('/')}` });
  if (db.getAccountByUsername(username))
    return sendJson(res, 409, { ok: false, error: '用户名已存在' });
  if (db.getAccountByEmail(email))
    return sendJson(res, 409, { ok: false, error: '邮箱已注册' });
  const account = db.createAccount(username, email);
  const bot = db.createBot(account.id, botName, avatar || '🤖', templateName);
  const apiKey = db.createApiKey(bot.id);
  sendJson(res, 201, { ok: true, accountId: account.id, botId: bot.id, apiKey, message: '请妥善保存 apiKey，后续不再展示' });
});

// ============================================================
// § 棋手信息
// GET /api/agent/bot/info  (需 Auth)
// ============================================================
route('GET', '/api/agent/bot/info', (req, res) => {
  const { bot, error } = requireAuth(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  sendJson(res, 200, { ok: true, bot });
});

// ============================================================
// § 提交代码（§6.2）
// POST /api/agent/bot/code/submit  (需 Auth)
// body: { code, notes, submittedBy }
// ============================================================
route('POST', '/api/agent/bot/code/submit', (req, res, _m, body) => {
  const { bot, error } = requireAuth(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const { code, notes, submittedBy } = body;
  if (!code || typeof code !== 'string') return sendJson(res, 400, { ok: false, error: '缺少 code 字段' });
  if (!submittedBy) return sendJson(res, 400, { ok: false, error: '缺少 submittedBy 字段（§6.2）' });

  const newVersion = (bot.current_version || 0) + 1;
  db.submitCodeVersion(bot.id, newVersion, code, notes, submittedBy);

  // 同步执行烟雾测试（6 局，毫秒级）
  const { passed, failures } = runSmokeTests(code);
  const smokeDetail = passed ? null : JSON.stringify(failures);
  db.updateSmokeStatus(bot.id, newVersion, passed ? 'passed' : 'failed', smokeDetail);

  if (!passed) {
    return sendJson(res, 422, {
      ok: false, version: newVersion, smokeStatus: 'failed',
      message: '烟雾测试未通过，代码未发布（§6.2）',
      failures,
    });
  }
  sendJson(res, 200, { ok: true, version: newVersion, codeHash: db.codeHash ? undefined : db.getVersion(bot.id, newVersion).code_hash, smokeStatus: 'passed', message: `v${newVersion} 发布成功` });
});

// ============================================================
// § 版本回滚（§6.2a）
// POST /api/agent/bot/code/revert
// body: { toVersion, notes, submittedBy }
// ============================================================
route('POST', '/api/agent/bot/code/revert', (req, res, _m, body) => {
  const { bot, error } = requireAuth(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const { toVersion, submittedBy } = body;
  if (!submittedBy) return sendJson(res, 400, { ok: false, error: '缺少 submittedBy' });
  const target = db.getVersion(bot.id, +toVersion);
  if (!target) return sendJson(res, 400, { ok: false, error: `v${toVersion} 不存在` });
  // 与当前版本代码一致则拒绝
  const current = db.getVersion(bot.id, bot.current_version);
  if (current && current.code_hash === target.code_hash)
    return sendJson(res, 400, { ok: false, error: '目标版本代码与当前版本一致，无需回滚（§6.2a）' });

  const newVersion = (bot.current_version || 0) + 1;
  const autoNotes = body.notes || `revert to v${toVersion}`;
  db.submitCodeVersion(bot.id, newVersion, target.code, autoNotes, submittedBy);

  // 回滚同样执行烟雾测试（§6.2a：计费费率可能已变更，旧代码不保证合规）
  const { passed, failures } = runSmokeTests(target.code);
  const smokeDetail = passed ? null : JSON.stringify(failures);
  db.updateSmokeStatus(bot.id, newVersion, passed ? 'passed' : 'failed', smokeDetail);

  if (!passed) {
    return sendJson(res, 422, {
      ok: false, version: newVersion, smokeStatus: 'failed',
      message: '回滚目标代码烟雾测试未通过（旧代码在当前费率下不合规，§6.2a）',
      failures,
    });
  }

  // 回滚版本的哈希与目标版本相同 → 不重置哈希对计分资格（§6.2a）
  sendJson(res, 200, {
    ok: true, version: newVersion, revertedToVersion: toVersion,
    codeHash: target.code_hash, smokeStatus: 'passed',
    message: `已回滚至 v${toVersion} 的代码内容（新版本号 v${newVersion}）。注意：哈希对计分资格按哈希判定，回滚不重置已消耗资格（§6.2a）`,
  });
});

// ============================================================
// § 代码版本历史
// GET /api/agent/bot/code/versions  (需 Auth)
// ============================================================
route('GET', '/api/agent/bot/code/versions', (req, res) => {
  const { bot, error } = requireAuth(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  sendJson(res, 200, { ok: true, versions: db.listVersions(bot.id) });
});

// ============================================================
// § 正式挑战（§7 / §8）
// POST /api/agent/challenge
// body: { challengedBotId }  (需 Auth，以 challenger 身份)
// 规则：双局制（执石/执木各 1）；双局合计分 → ELO 更新；哈希对计分资格记录
// ============================================================
route('POST', '/api/agent/challenge', (req, res, _m, body) => {
  const { bot: challenger, error } = requireAuth(req);
  if (error) return sendJson(res, 401, { ok: false, error });

  const challengedId = +body.challengedBotId;
  if (!challengedId || challengedId === challenger.id)
    return sendJson(res, 400, { ok: false, error: '不能挑战自己或无效 botId' });
  const challenged = db.getBotById(challengedId);
  if (!challenged) return sendJson(res, 404, { ok: false, error: '被挑战棋手不存在' });

  const chCode = db.getLatestPassedVersion(challenger.id);
  const cdCode = db.getLatestPassedVersion(challenged.id);
  if (!chCode) return sendJson(res, 422, { ok: false, error: '你尚未发布可用代码（需先通过烟雾测试）' });
  if (!cdCode) return sendJson(res, 422, { ok: false, error: '对手尚未发布可用代码' });

  const { bot: chBot } = makeBot(chCode.code, 100);
  const { bot: cdBot } = makeBot(cdCode.code, 100);
  if (!chBot || !cdBot) return sendJson(res, 500, { ok: false, error: '棋手代码加载失败' });

  const BUDGET = 100;
  const baseUrlId = db.urlId();
  const baseSeed = Date.now() % 1000000;

  // 双局：第 1 局 challenger=stone，第 2 局 challenger=stick
  const game1 = playMatch({ stone: chBot, stick: cdBot }, baseSeed, BUDGET);
  const game2 = playMatch({ stone: cdBot, stick: chBot }, baseSeed + 1, BUDGET);

  // 从引擎视角换算为挑战者视角的胜负
  function challengerWinner(result, challengerSide) {
    if (result.winner === 'draw') return 'draw';
    return result.winner === challengerSide ? 'challenger' : 'challenged';
  }
  const w1 = challengerWinner(game1, 'stone');
  const w2 = challengerWinner(game2, 'stick');

  // 合计：挑战者得分（2=大胜/胜, 1=平, 0=负）
  let chScore = 0, cdScore = 0;
  for (const w of [w1, w2]) {
    if (w === 'challenger') { chScore += 2; }
    else if (w === 'challenged') { cdScore += 2; }
    else { chScore += 1; cdScore += 1; }
  }

  // ELO 更新
  const totalGames = 4; // 2 局各按 1 分制
  const chFrac = chScore / 4; // 挑战者在 4 分满分中的占比
  const newChRating = db.eloUpdate(challenger.rating, challenged.rating, chFrac);
  const newCdRating = db.eloUpdate(challenged.rating, challenger.rating, 1 - chFrac);
  const chWins = (w1 === 'challenger' ? 1 : 0) + (w2 === 'challenger' ? 1 : 0);
  const cdWins = (w1 === 'challenged' ? 1 : 0) + (w2 === 'challenged' ? 1 : 0);
  const draws = (w1 === 'draw' ? 1 : 0) + (w2 === 'draw' ? 1 : 0);
  db.updateRating(challenger.id, newChRating, chWins, cdWins, draws);
  db.updateRating(challenged.id, newCdRating, cdWins, chWins, draws);

  // 哈希对计分资格（§8.2.1）
  db.recordHashPair(challenger.id, chCode.code_hash, cdCode.code_hash);
  db.recordHashPair(challenged.id, cdCode.code_hash, chCode.code_hash);

  // 存储两局对局
  const matchUrlId1 = baseUrlId + 'a';
  const matchUrlId2 = baseUrlId + 'b';
  db.saveMatch({ urlId: matchUrlId1, challengerBotId: challenger.id, challengedBotId: challenged.id, chVer: chCode.version, cdVer: cdCode.version, chHash: chCode.code_hash, cdHash: cdCode.code_hash, winner: w1, reason: game1.reason, turns: game1.turns, finalCh: game1.finalPieces.stone, finalCd: game1.finalPieces.stick, gameJson: { initialBoard: initBoard(), history: game1.history }, challengerSide: 'stone', seed: baseSeed });
  db.saveMatch({ urlId: matchUrlId2, challengerBotId: challenger.id, challengedBotId: challenged.id, chVer: chCode.version, cdVer: cdCode.version, chHash: chCode.code_hash, cdHash: cdCode.code_hash, winner: w2, reason: game2.reason, turns: game2.turns, finalCh: game2.finalPieces.stick, finalCd: game2.finalPieces.stone, gameJson: { initialBoard: initBoard(), history: game2.history }, challengerSide: 'stick', seed: baseSeed + 1 });

  sendJson(res, 200, {
    ok: true,
    summary: { challengerScore: chScore, challengedScore: cdScore },
    games: [
      { matchUrlId: matchUrlId1, challengerSide: 'stone', winner: w1, reason: game1.reason, turns: game1.turns },
      { matchUrlId: matchUrlId2, challengerSide: 'stick', winner: w2, reason: game2.reason, turns: game2.turns },
    ],
    ratingChange: { challenger: { from: challenger.rating, to: newChRating }, challenged: { from: challenged.rating, to: newCdRating } },
    hashPairNote: '哈希对计分资格已记录；回滚不重置已消耗资格（§6.2a）',
  });
});

// ============================================================
// § 天梯排行榜
// GET /api/leaderboard
// ============================================================
route('GET', '/api/leaderboard', (req, res) => {
  const bots = db.listBots();
  sendJson(res, 200, { ok: true, leaderboard: bots.map((b, i) => ({
    rank: i + 1, botId: b.id, name: b.name, avatar: b.avatar,
    username: b.username, rating: b.rating, wins: b.wins, losses: b.losses, draws: b.draws,
    currentVersion: b.current_version, templateName: b.template_name,
  })) });
});

// ============================================================
// § 我的对局历史
// GET /api/agent/bot/matches  (需 Auth)
// ============================================================
route('GET', '/api/agent/bot/matches', (req, res) => {
  const { bot, error } = requireAuth(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const url = new URL(req.url, 'http://x');
  const limit = Math.min(50, Math.max(1, +url.searchParams.get('limit') || 20));
  const rows = db.listBotMatches(bot.id, limit);
  sendJson(res, 200, { ok: true, matches: rows.map((m) => ({ ...m, game_json: undefined })) });
});

// ============================================================
// § 对手侦察 API（§6.6a）
// GET /api/agent/opponents/:botId/matches  (需 Auth)
// ============================================================
route('GET', /^\/api\/agent\/opponents\/(\d+)\/matches$/, (req, res, match) => {
  const { bot, error } = requireAuth(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const targetBotId = +match[1];
  const target = db.getBotById(targetBotId);
  if (!target) return sendJson(res, 404, { ok: false, error: '目标棋手不存在' });
  const url = new URL(req.url, 'http://x');
  const limit = Math.min(50, Math.max(1, +url.searchParams.get('limit') || 10));
  const offset = Math.max(0, +url.searchParams.get('offset') || 0);
  const { rows, total, hasMore } = db.listOpponentMatches(targetBotId, limit, offset);
  sendJson(res, 200, {
    ok: true, botId: targetBotId, botName: target.name,
    total, hasMore, limit, offset,
    matches: rows.map((m) => ({
      matchUrlId: m.match_url_id, played_at: m.played_at,
      challenger: m.challenger_name, challenged: m.challenged_name,
      winner: m.winner, reason: m.reason, turns: m.turns,
      challengerSide: m.challenger_side,
      chCodeHash: m.ch_code_hash, cdCodeHash: m.cd_code_hash,
    })),
  });
});

// ============================================================
// § 对局回放详情
// GET /api/match/:urlId  (公开)
// ============================================================
route('GET', /^\/api\/match\/([a-z0-9]+)$/, (req, res, match) => {
  const row = db.getMatch(match[1]);
  if (!row) return sendJson(res, 404, { ok: false, error: '对局不存在' });
  const gameJson = JSON.parse(row.game_json);
  const chBot = db.getBotById(row.challenger_bot_id);
  const cdBot = db.getBotById(row.challenged_bot_id);
  sendJson(res, 200, { ok: true, ...row, game_json: undefined, gameData: gameJson, challengerName: chBot?.name, challengedName: cdBot?.name });
});

// ============================================================
// 启动
// ============================================================
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); return res.end(); }
  try { await dispatch(req, res); }
  catch (e) { sendJson(res, 500, { ok: false, error: String(e?.message || e) }); }
});

server.listen(PORT, () => {
  console.log(`六子棋 Agent 平台已启动: http://localhost:${PORT}`);
  console.log('API: /api/account/register | /api/agent/bot/code/submit | /api/agent/challenge | /api/leaderboard');
});
