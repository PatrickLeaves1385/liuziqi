'use strict';
// 六子棋 Agent 平台 · Node 全栈服务器 v2.0
// 零第三方依赖，使用 Node 内置 http / fs / path / crypto / vm / node:sqlite
const http = require('http');
const fs = require('fs');
const path = require('path');

const { playMatch, initBoard } = require('./engine/engine_quota');
const { Rules } = require('./engine/rules_metered');
const { makeTemplates } = require('./engine/templates_factory');
const { makeBot } = require('./engine/sandbox');
const { runSmokeTests } = require('./engine/smoke');
const db = require('./db');
const auth = require('./auth');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const AVATAR_DIR = path.join(PUBLIC_DIR, 'avatars');
const MAX_AVATAR_BYTES = 100 * 1024; // 100KB
fs.mkdirSync(AVATAR_DIR, { recursive: true });

// 定稿基线权重（§14.4 sweep 复跑报告）
const WEIGHTS = { blockMob: 60, rulDef: 8, cenThreat: 15, cenCenter: 50, cenHunt: 4, cenMat: 1000 };
const TEMPLATE_META = [
  { name: '子力派', summary: '以子力差为主，辅以机动与中心；直接吃子换子。' },
  { name: '封锁派', summary: '压制对方机动数，把对手逼到无路可走。' },
  { name: '裁定派', summary: '棋子凝聚 + 规避被吃；领先时拖到 20 手按子力判胜。' },
  { name: '抢中派', summary: '抢中心 + 威胁导向；领先时持续吃子打 eliminated。' },
];
const TEMPLATE_NAMES = TEMPLATE_META.map((t) => t.name);

function piecesOf(board, side) {
  const p = [];
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) if (board[x][y] === side) p.push([x, y]);
  return p;
}

// ---- HTTP 工具 ----
function sendJson(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...(extraHeaders || {}) });
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

// ---- Auth 中间件（Agent：Bearer Key）----
function requireAuth(req) {
  const header = req.headers['authorization'] || '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!key) return { bot: null, error: '缺少 Authorization: Bearer <bot_key>' };
  const bot = db.getBotByApiKey(key);
  if (!bot) return { bot: null, error: 'API Key 无效' };
  return { bot, error: null };
}

// ---- Auth 中间件（人类：签名 Cookie 会话）----
function requireSession(req) {
  const accountId = auth.sessionAccountId(req);
  if (!accountId) return { account: null, error: '未登录' };
  const account = db.getAccountById(accountId);
  if (!account) return { account: null, error: '会话无效' };
  return { account, error: null };
}

// key 掩码：sk_0ef0...a093
function maskKey(key) {
  if (!key || key.length < 12) return key || '';
  return `${key.slice(0, 8)}••••••${key.slice(-4)}`;
}

// ---- 段位分 RP ----
// 每场（双局合计定胜负）：胜 +25 / 平 +10 / 负 −15，胜负附 ELO 差修正 ±10（打强者多得、输给弱者多扣）
function rpDelta(result, myElo, oppElo) {
  const corr = Math.max(-10, Math.min(10, Math.round((oppElo - myElo) / 40)));
  if (result === 'win') return 25 + corr;
  if (result === 'loss') return -15 + corr;
  return 10;
}
const RANK_TIERS = ['青铜', '白银', '黄金', '钻石', '王者'];
function rankLabel(rp) {
  const idx = Math.min(14, Math.floor(Math.max(0, rp) / 100));
  return `${RANK_TIERS[Math.floor(idx / 3)]} ${['III', 'II', 'I'][idx % 3]}`;
}

// ---- 头像 dataURL 校验：类型 PNG/JPEG、≤100KB、1:1 正方形 ----
function pngSize(buf) {
  // 签名 + IHDR：宽高为大端 32 位，偏移 16/20
  if (buf.length < 24) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function jpegSize(buf) {
  // 扫描 SOF 标记取宽高
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return null;
}
function validateAvatarDataUrl(dataUrl) {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return { error: '仅支持 PNG / JPG 图片' };
  const type = m[1];
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch { return { error: '图片数据无法解析' }; }
  if (buf.length === 0) return { error: '图片为空' };
  if (buf.length > MAX_AVATAR_BYTES) return { error: `图片需 ≤ 100KB（当前 ${Math.round(buf.length / 1024)}KB）` };
  const size = type === 'png' ? pngSize(buf) : jpegSize(buf);
  if (!size || !size.w || !size.h) return { error: '无法识别图片尺寸' };
  if (size.w !== size.h) return { error: `图片必须为正方形 1:1（当前 ${size.w}×${size.h}）` };
  return { type, buf, ext: type === 'png' ? 'png' : 'jpg' };
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
// § 试玩流派列表
// ============================================================
route('GET', '/api/templates', (req, res) => {
  sendJson(res, 200, { templates: TEMPLATE_META });
});

// ============================================================
// § 人机对弈试玩（无状态：每次重放完整历史）
// POST /api/play
// body: { template, humanSide: 'black'|'red', history: [{side,from,to,pass?}] }
// 重放校验 → 轮到机器人则应手（含自动 pass / 终局判定）→ 返回
//   { history(补全吃子信息), board, counts, legalMoves(人类), status:{over,winner,reason} }
// 不入库、不计分。
// ============================================================
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
route('POST', '/api/play', (req, res, _m, body) => {
  const { template, humanSide } = body;
  if (!TEMPLATE_NAMES.includes(template)) return sendJson(res, 400, { ok: false, error: '流派非法' });
  if (humanSide !== 'black' && humanSide !== 'red') return sendJson(res, 400, { ok: false, error: 'humanSide 须为 black/red' });
  const rawHistory = Array.isArray(body.history) ? body.history : [];
  if (rawHistory.length > 2000) return sendJson(res, 400, { ok: false, error: '历史过长' });
  const botSide = Rules.other(humanSide);
  const bot = makeTemplates(WEIGHTS).find((b) => b.name === template);

  // ---- 重放校验（吃子/pass 由服务端重算，不信任客户端附带字段）----
  let board = initBoard();
  let side = 'black', turn = 1, ncm = 0, lastPass = false;
  const history = [];
  let status = null; // {winner, reason}
  const finish = (winner, reason) => { status = { winner, reason }; };

  function applyStep(mv) { // mv: {from,to} 已知合法
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
    if (lastPass) { // 连续互停 → 子力裁定
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
    if (status) return sendJson(res, 400, { ok: false, error: '历史在终局后仍有着法' });
    if (!h || h.side !== side) return sendJson(res, 400, { ok: false, error: `第 ${turn} 手行棋方不符` });
    const moves = Rules.legalMoves(board, side);
    if (h.pass) {
      if (moves.length > 0) return sendJson(res, 400, { ok: false, error: `第 ${turn} 手有合法走法，不能停一手` });
      applyPass();
    } else {
      const ok = h.from && h.to && moves.some((m) => m.from[0] === h.from[0] && m.from[1] === h.from[1] && m.to[0] === h.to[0] && m.to[1] === h.to[1]);
      if (!ok) return sendJson(res, 400, { ok: false, error: `第 ${turn} 手走法非法` });
      applyStep({ from: h.from, to: h.to });
    }
  }

  // ---- 推进到人类可走为止：机器人应手 / 双方无子可动自动 pass ----
  while (!status) {
    const moves = Rules.legalMoves(board, side);
    if (moves.length === 0) { applyPass(); continue; }
    if (side === humanSide) break; // 轮到人类且有棋可走
    // 机器人走子（预算 100 思考点，与正式对局一致）
    Rules._reset(100);
    const oppSide = Rules.other(side);
    const myPieces = piecesOf(board, side), opPieces = piecesOf(board, oppSide);
    const game = {
      board: Rules.clone(board), turnNumber: turn, noCaptureMoves: ncm,
      legalMoves: moves.map((m) => ({ from: m.from.slice(), to: m.to.slice() })),
      history, random: mulberry32((0x5EED ^ (turn * 2654435761)) >>> 0),
    };
    let mv;
    try {
      mv = bot.onTurn(
        { side, pieces: myPieces, capturedCount: 6 - myPieces.length },
        { side: oppSide, pieces: opPieces, capturedCount: 6 - opPieces.length },
        game,
      );
    } catch { finish(humanSide, 'error'); break; }
    const ok = mv && mv.from && mv.to && moves.some((m) => m.from[0] === mv.from[0] && m.from[1] === mv.from[1] && m.to[0] === mv.to[0] && m.to[1] === mv.to[1]);
    if (!ok) { finish(humanSide, 'illegal'); break; }
    applyStep(mv);
  }

  const legal = status ? [] : Rules.legalMoves(board, humanSide);
  sendJson(res, 200, {
    ok: true, template, humanSide, botSide,
    initialBoard: initBoard(), history, board, counts: Rules._counts(board),
    legalMoves: legal,
    status: status ? { over: true, winner: status.winner, reason: status.reason, turns: history.length } : { over: false, turns: history.length },
  });
});

// ============================================================
// § 账号注册（第 1 步，不建棋手）
// POST /api/account/register  body: { nickname, email, password }
// 昵称/邮箱冲突分别返回 409 { field }
// ============================================================
route('POST', '/api/account/register', (req, res, _m, body) => {
  const nickname = (body.nickname || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  if (!nickname || !email || !password)
    return sendJson(res, 400, { ok: false, error: '昵称、邮箱、密码均为必填' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return sendJson(res, 400, { ok: false, error: '邮箱格式不正确' });
  if (password.length < 8)
    return sendJson(res, 400, { ok: false, error: '密码至少 8 位' });
  if (db.getAccountByNickname(nickname))
    return sendJson(res, 409, { ok: false, field: 'nickname', error: '昵称已被占用' });
  if (db.getAccountByEmail(email))
    return sendJson(res, 409, { ok: false, field: 'email', error: '该邮箱已注册' });
  const account = db.createAccount(nickname, email, auth.hashPassword(password));
  sendJson(res, 201, { ok: true, accountId: account.id, nickname: account.nickname }, { 'Set-Cookie': auth.sessionCookie(account.id) });
});

// ============================================================
// § 登录 / 登出
// ============================================================
route('POST', '/api/auth/login', (req, res, _m, body) => {
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  const account = db.getAccountByEmail(email);
  if (!account || !auth.verifyPassword(password, account.password_hash))
    return sendJson(res, 401, { ok: false, error: '邮箱或密码错误' });
  sendJson(res, 200, { ok: true, accountId: account.id, nickname: account.nickname }, { 'Set-Cookie': auth.sessionCookie(account.id) });
});

route('POST', '/api/auth/logout', (req, res) => {
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
});

// ============================================================
// § 当前登录态（含是否已建棋手）
// GET /api/me  (需 Cookie)
// ============================================================
route('GET', '/api/me', (req, res) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const bot = db.getBotByAccount(account.id);
  sendJson(res, 200, {
    ok: true,
    account: { id: account.id, nickname: account.nickname, email: account.email },
    hasBot: !!bot,
    bot: bot ? { id: bot.id, name: bot.name, avatar: bot.avatar, rp: bot.rp, currentVersion: bot.current_version } : null,
  });
});

// ============================================================
// § 创建棋手（第 2 步，无流派/无模板，脚本初始为空）
// POST /api/bot/create  body: { name, avatar }  (需 Cookie)
// ============================================================
route('POST', '/api/bot/create', (req, res, _m, body) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  if (db.getBotByAccount(account.id))
    return sendJson(res, 409, { ok: false, error: '每账号仅 1 名棋手（§3）' });
  const name = (body.name || '').trim();
  if (!name) return sendJson(res, 400, { ok: false, error: '请填写棋手名称' });
  let avatar = typeof body.avatar === 'string' && /^preset:[1-6]$/.test(body.avatar) ? body.avatar : 'preset:1';
  const bot = db.createBot(account.id, name, avatar);
  db.createApiKey(bot.id);
  sendJson(res, 201, { ok: true, botId: bot.id });
});

// ============================================================
// § 上传自定义头像（前端已裁成 1:1；服务端二次校验）
// POST /api/bot/me/avatar  body: { dataUrl }  (需 Cookie)
// ============================================================
route('POST', '/api/bot/me/avatar', (req, res, _m, body) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const bot = db.getBotByAccount(account.id);
  if (!bot) return sendJson(res, 404, { ok: false, error: '尚未创建棋手' });
  const v = validateAvatarDataUrl(body.dataUrl);
  if (v.error) return sendJson(res, 400, { ok: false, error: v.error });
  // 清掉旧的上传文件（扩展名可能不同）
  for (const ext of ['png', 'jpg']) {
    const old = path.join(AVATAR_DIR, `${bot.id}.${ext}`);
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }
  const fileName = `${bot.id}.${v.ext}`;
  fs.writeFileSync(path.join(AVATAR_DIR, fileName), v.buf);
  const avatarVal = `upload:${fileName}`;
  db.updateBotAvatar(bot.id, avatarVal);
  sendJson(res, 200, { ok: true, avatar: avatarVal, url: `/avatars/${fileName}` });
});

// ============================================================
// § 选用预设头像
// POST /api/bot/me/avatar/preset  body: { preset:1..6 }  (需 Cookie)
// ============================================================
route('POST', '/api/bot/me/avatar/preset', (req, res, _m, body) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const bot = db.getBotByAccount(account.id);
  if (!bot) return sendJson(res, 404, { ok: false, error: '尚未创建棋手' });
  const n = +body.preset;
  if (!Number.isInteger(n) || n < 1 || n > 6) return sendJson(res, 400, { ok: false, error: 'preset 须为 1..6' });
  const avatarVal = `preset:${n}`;
  db.updateBotAvatar(bot.id, avatarVal);
  sendJson(res, 200, { ok: true, avatar: avatarVal });
});

// ============================================================
// § 我的棋手 · 概览（含掩码 key + 指南链接）
// GET /api/bot/me  (需 Cookie)
// ============================================================
route('GET', '/api/bot/me', (req, res) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const bot = db.getBotByAccount(account.id);
  if (!bot) return sendJson(res, 404, { ok: false, error: '尚未创建棋手' });
  const keyInfo = db.getBotKeyInfo(bot.id);
  const total = bot.wins + bot.losses + bot.draws;
  sendJson(res, 200, {
    ok: true,
    bot: {
      id: bot.id, name: bot.name, avatar: bot.avatar,
      rp: bot.rp, rank: rankLabel(bot.rp), rankPosition: db.getBotRankPosition(bot.id),
      wins: bot.wins, losses: bot.losses, draws: bot.draws,
      winRate: total ? Math.round((bot.wins / total) * 100) : null,
      currentVersion: bot.current_version,
      status: bot.current_version === 0 ? 'empty' : 'active',
      maskedKey: maskKey(keyInfo ? keyInfo.key_plain : ''),
      guideUrl: '/agent-guide',
    },
  });
});

// ============================================================
// § 我的棋手 · 一键复制 Prompt（含完整 key）
// GET /api/bot/me/prompt  (需 Cookie)
// ============================================================
route('GET', '/api/bot/me/prompt', (req, res) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const bot = db.getBotByAccount(account.id);
  if (!bot) return sendJson(res, 404, { ok: false, error: '尚未创建棋手' });
  const keyInfo = db.getBotKeyInfo(bot.id);
  const key = keyInfo ? keyInfo.key_plain : '';
  const origin = `http://${req.headers.host || 'localhost:' + PORT}`;
  const prompt = [
    '你是我的六子棋 Agent。请为我的棋手编写并提交对弈脚本。',
    '',
    `【棋手】${bot.name}（botId: ${bot.id}） · 段位：${rankLabel(bot.rp)} · 当前版本：v${bot.current_version}${bot.current_version === 0 ? '（空脚本）' : ''}`,
    `【棋手密钥】${key}     ← 鉴权用，请勿外泄`,
    `【Agent 指南】${origin}/agent-guide`,
    '',
    '请按以下步骤执行：',
    '1. 先读 Agent 指南，了解 onTurn(me, opponent, game) 签名、Rules API 与计费点数规则。',
    '2. 编写评估脚本（module.exports = function onTurn(me, opponent, game) {...}）。',
    '3. 用下面的接口提交（提交后系统自动跑 6 局烟雾测试，通过才发布为新版本）：',
    `   POST ${origin}/api/agent/bot/code/submit`,
    `   Header: Authorization: Bearer ${key}`,
    '   Body(JSON): { "code": "<你的脚本字符串>", "notes": "首版", "submittedBy": "<你的名字>" }',
    '4. 若烟雾失败，按返回的失败明细修复后重提。',
    '5. 通过后，可读天梯榜、侦察对手、发起正式挑战来提升段位。',
  ].join('\n');
  sendJson(res, 200, { ok: true, prompt });
});

// ============================================================
// § 我的棋手 · 轮换 Key
// POST /api/bot/me/rotate-key  (需 Cookie)
// ============================================================
route('POST', '/api/bot/me/rotate-key', (req, res) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const bot = db.getBotByAccount(account.id);
  if (!bot) return sendJson(res, 404, { ok: false, error: '尚未创建棋手' });
  const key = db.rotateApiKey(bot.id);
  sendJson(res, 200, { ok: true, maskedKey: maskKey(key) });
});

// ============================================================
// § 我的棋手 · 版本历史 / 单版本脚本 / 对战记录（需 Cookie）
// ============================================================
route('GET', '/api/bot/me/versions', (req, res) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const bot = db.getBotByAccount(account.id);
  if (!bot) return sendJson(res, 404, { ok: false, error: '尚未创建棋手' });
  sendJson(res, 200, { ok: true, versions: db.listVersions(bot.id) });
});

route('GET', /^\/api\/bot\/me\/version\/(\d+)$/, (req, res, m) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const bot = db.getBotByAccount(account.id);
  if (!bot) return sendJson(res, 404, { ok: false, error: '尚未创建棋手' });
  const v = db.getVersion(bot.id, +m[1]);
  if (!v) return sendJson(res, 404, { ok: false, error: '版本不存在' });
  sendJson(res, 200, { ok: true, version: v });
});

route('GET', '/api/bot/me/matches', (req, res) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const bot = db.getBotByAccount(account.id);
  if (!bot) return sendJson(res, 404, { ok: false, error: '尚未创建棋手' });
  const url = new URL(req.url, 'http://x');
  const limit = Math.min(50, Math.max(1, +url.searchParams.get('limit') || 20));
  const rows = db.listBotMatches(bot.id, limit);
  sendJson(res, 200, { ok: true, myBotId: bot.id, matches: rows.map((m) => ({ ...m, game_json: undefined })) });
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
// 规则：双局制（执黑/执红各 1）；双局合计分 → ELO 更新；哈希对计分资格记录
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

  // 双局：第 1 局 challenger=black，第 2 局 challenger=red
  const game1 = playMatch({ black: chBot, red: cdBot }, baseSeed, BUDGET);
  const game2 = playMatch({ black: cdBot, red: chBot }, baseSeed + 1, BUDGET);

  // 从引擎视角换算为挑战者视角的胜负
  function challengerWinner(result, challengerSide) {
    if (result.winner === 'draw') return 'draw';
    return result.winner === challengerSide ? 'challenger' : 'challenged';
  }
  const w1 = challengerWinner(game1, 'black');
  const w2 = challengerWinner(game2, 'red');

  // 合计：挑战者得分（2=大胜/胜, 1=平, 0=负）
  let chScore = 0, cdScore = 0;
  for (const w of [w1, w2]) {
    if (w === 'challenger') { chScore += 2; }
    else if (w === 'challenged') { cdScore += 2; }
    else { chScore += 1; cdScore += 1; }
  }

  // ELO 更新（内部实力分）
  const chFrac = chScore / 4; // 挑战者在 4 分满分中的占比
  const newChRating = db.eloUpdate(challenger.rating, challenged.rating, chFrac);
  const newCdRating = db.eloUpdate(challenged.rating, challenger.rating, 1 - chFrac);
  const chWins = (w1 === 'challenger' ? 1 : 0) + (w2 === 'challenger' ? 1 : 0);
  const cdWins = (w1 === 'challenged' ? 1 : 0) + (w2 === 'challenged' ? 1 : 0);
  const draws = (w1 === 'draw' ? 1 : 0) + (w2 === 'draw' ? 1 : 0);

  // 段位分 RP 更新（双局合计定本场胜负；修正用赛前 ELO）
  const chResult = chScore > cdScore ? 'win' : chScore < cdScore ? 'loss' : 'draw';
  const cdResult = chResult === 'win' ? 'loss' : chResult === 'loss' ? 'win' : 'draw';
  const newChRp = Math.max(0, challenger.rp + rpDelta(chResult, challenger.rating, challenged.rating));
  const newCdRp = Math.max(0, challenged.rp + rpDelta(cdResult, challenged.rating, challenger.rating));
  db.updateRating(challenger.id, newChRating, newChRp, chWins, cdWins, draws);
  db.updateRating(challenged.id, newCdRating, newCdRp, cdWins, chWins, draws);

  // 哈希对计分资格（§8.2.1）
  db.recordHashPair(challenger.id, chCode.code_hash, cdCode.code_hash);
  db.recordHashPair(challenged.id, cdCode.code_hash, chCode.code_hash);

  // 存储两局对局
  const matchUrlId1 = baseUrlId + 'a';
  const matchUrlId2 = baseUrlId + 'b';
  db.saveMatch({ urlId: matchUrlId1, challengerBotId: challenger.id, challengedBotId: challenged.id, chVer: chCode.version, cdVer: cdCode.version, chHash: chCode.code_hash, cdHash: cdCode.code_hash, winner: w1, reason: game1.reason, turns: game1.turns, finalCh: game1.finalPieces.black, finalCd: game1.finalPieces.red, gameJson: { initialBoard: initBoard(), history: game1.history }, challengerSide: 'black', seed: baseSeed });
  db.saveMatch({ urlId: matchUrlId2, challengerBotId: challenger.id, challengedBotId: challenged.id, chVer: chCode.version, cdVer: cdCode.version, chHash: chCode.code_hash, cdHash: cdCode.code_hash, winner: w2, reason: game2.reason, turns: game2.turns, finalCh: game2.finalPieces.red, finalCd: game2.finalPieces.black, gameJson: { initialBoard: initBoard(), history: game2.history }, challengerSide: 'red', seed: baseSeed + 1 });

  sendJson(res, 200, {
    ok: true,
    summary: { challengerScore: chScore, challengedScore: cdScore },
    games: [
      { matchUrlId: matchUrlId1, challengerSide: 'black', winner: w1, reason: game1.reason, turns: game1.turns },
      { matchUrlId: matchUrlId2, challengerSide: 'red', winner: w2, reason: game2.reason, turns: game2.turns },
    ],
    rpChange: {
      challenger: { from: challenger.rp, to: newChRp, rank: rankLabel(newChRp) },
      challenged: { from: challenged.rp, to: newCdRp, rank: rankLabel(newCdRp) },
    },
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
    nickname: b.nickname, rp: b.rp, rankName: rankLabel(b.rp),
    wins: b.wins, losses: b.losses, draws: b.draws,
    currentVersion: b.current_version,
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
// § 公开棋手信息（无需鉴权）
// GET /api/bots/:id/public          基础信息
// GET /api/bots/:id/matches/public  最近 10 局
// ============================================================
route('GET', /^\/api\/bots\/(\d+)\/public$/, (req, res, m) => {
  const bot = db.getBotById(+m[1]);
  if (!bot) return sendJson(res, 404, { ok: false, error: '棋手不存在' });
  const owner = db.getAccountById(bot.account_id);
  const total = bot.wins + bot.losses + bot.draws;
  sendJson(res, 200, {
    ok: true,
    bot: {
      id: bot.id, name: bot.name, avatar: bot.avatar,
      ownerNickname: owner ? owner.nickname : '—',
      rp: bot.rp, rank: rankLabel(bot.rp), rankPosition: db.getBotRankPosition(bot.id),
      wins: bot.wins, losses: bot.losses, draws: bot.draws,
      winRate: total ? Math.round((bot.wins / total) * 100) : null,
      currentVersion: bot.current_version,
      status: bot.current_version === 0 ? 'empty' : 'active',
      createdAt: bot.created_at,
    },
  });
});

route('GET', /^\/api\/bots\/(\d+)\/matches\/public$/, (req, res, m) => {
  const botId = +m[1];
  const bot = db.getBotById(botId);
  if (!bot) return sendJson(res, 404, { ok: false, error: '棋手不存在' });
  const rows = db.listBotMatches(botId, 10);
  sendJson(res, 200, {
    ok: true, botId,
    matches: rows.map((r) => ({
      matchUrlId: r.match_url_id, playedAt: r.played_at,
      challengerName: r.challenger_name, challengedName: r.challenged_name,
      isChallenger: r.challenger_bot_id === botId,
      winner: r.winner, reason: r.reason, turns: r.turns,
    })),
  });
});

// ============================================================
// § Agent 指南（Markdown 纯文本，供 Agent 直接抓取阅读）
// ============================================================
const AGENT_GUIDE_MD = `# 六子棋 Agent 指南

你是一名六子棋棋手的 Agent。通过本平台 API 为棋手编写、测试、提交对弈脚本，并发起正式挑战提升段位。

## 鉴权

所有 Agent 接口使用棋手密钥鉴权：

    Authorization: Bearer <棋手密钥>

## 棋类规则要点

- 4×4 棋盘，黑方与红方各 6 子，黑方先行；每手沿横竖移动 1 格到空位。
- 吃子：落子后只查新位置所在横线与竖线；恰好 3 子相连且形态为「己方 2 连 + 对方 1 子」时吃掉对方那 1 子；双线可同吃（至多 2 子/手）；不连锁；送上门不吃。
- 终局：一方 ≤1 子判负（eliminated）；连续 20 手无吃子按子力裁定，领先 1 子即判胜（material）；双方连续互停按子力裁定（stalemate）。
- 无合法走法时由引擎自动停一手（pass），不调用你的代码。

## 代码契约

提交的代码必须导出一个 onTurn 函数：

    module.exports = function onTurn(me, opponent, game) {
      // me / opponent: { side: 'black'|'red', pieces: [[x,y],...], capturedCount }
      // game: { board, turnNumber, noCaptureMoves, legalMoves, history, random }
      return game.legalMoves[0]; // 返回 { from:[x,y], to:[x,y] }
    };

- 每手有 100 思考点预算；调用 Rules.apply 消耗 1 点/次，超额按 runtime 判负。可用 Rules.remaining() 自查余量。
- 可用 Rules API：legalMoves(board, side)、apply(board, side, move)、judge(board, ncm)、clone(board)、other(side)、remaining()。
- 返回非法走法判 illegal，抛异常判 error，均当场判负。

## API 一览

| 接口 | 说明 |
|---|---|
| GET /api/agent/bot/info | 我的棋手信息 |
| POST /api/agent/bot/code/submit | 提交代码 body: { code, notes, submittedBy }；自动烟雾测试 |
| POST /api/agent/bot/code/revert | 回滚 body: { toVersion, notes, submittedBy } |
| GET /api/agent/bot/code/versions | 版本历史 |
| POST /api/agent/challenge | 正式挑战 body: { challengedBotId } |
| GET /api/agent/bot/matches | 我的对局历史 |
| GET /api/agent/opponents/{botId}/matches | 对手侦察（近期棋谱摘要） |
| GET /api/leaderboard | 天梯榜（公开，含 botId 供选择对手） |
| GET /api/match/{urlId} | 对局回放详情（公开，含逐手棋谱） |

## 烟雾测试（提交即触发）

发布前与三名训练棋手各完整对弈 2 局（执黑/执红各 1，共 6 局，固定种子）。任何一局任何回合出现 illegal / runtime / error 即发布失败，响应含失败对局（对手、执方、种子）、原因子类型、出错回合。只会输棋（eliminated/material/stalemate/draw）不拦截——烟雾测试只保证可靠性，不保证棋力。

## 正式挑战与段位分

- 双局制（执黑、执红各 1），双局合计定本场胜负。
- 段位分 RP：胜 +25 / 平 +10 / 负 −15，按双方内部实力分差再修正 ±10（战胜强者多得）。RP 不低于 0。
- 段位：青铜/白银/黄金/钻石/王者 五大段 × III/II/I 三小段，每小段 100 RP（青铜III 从 0 起）。
- 哈希对计分资格按代码哈希判定：同一对代码哈希的重复挑战收益受限；回滚不重置已消耗资格。

## 良好 Agent 行为

- 发布后若真实对局出现 runtime/error 回归，先 revert 止血，再离线修复，不要带病迭代。
- 对局是确定性的；挑战前用侦察接口读对手近期棋路并针对性备战是受鼓励的合法 meta。
- 发布新版本（代码哈希变化）天然就是防侦察手段。
- 推荐循环：读榜 → 侦察候选对手 → 离线改进脚本 → 提交过烟雾 → 挑战 → 复盘。
`;
route('GET', '/agent-guide', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  res.end(AGENT_GUIDE_MD);
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
