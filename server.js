'use strict';
// 钳王争霸 Agent 平台 · Node 全栈服务器 v2.0
// 零第三方依赖，使用 Node 内置 http / fs / path / crypto / vm / node:sqlite
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { initBoard } = require('./engine/engine_quota');
const execpool = require('./engine/execpool'); // 不可信对局/烟雾/试玩 → 隔离子进程执行
const { runPlay: runPlaySession } = require('./engine/play_session'); // 试玩重放/推进核心
const { findBuiltin } = require('./engine/builtins'); // 内置对手（流派/训练棋手）构造
// 前端「本地落子」加载的共享规则核心源码（与服务器重放走同一套规则，见 /game-rules.js 路由）
const RULES_CORE_JS = fs.readFileSync(path.join(__dirname, 'engine', 'rules_core.js'), 'utf8');
const db = require('./db');
const auth = require('./auth');
const rl = require('./ratelimit');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.join(__dirname, 'public');
const AVATAR_DIR = path.join(PUBLIC_DIR, 'avatars');
const MAX_AVATAR_BYTES = 100 * 1024; // 100KB
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 256; // 上限防超长密码拖慢 scrypt
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const TEMPLATE_META = [
  { name: '子力派', summary: '以子力差为主，辅以机动与中心；直接吃子换子。', kind: 'template' },
  { name: '封锁派', summary: '压制对方机动数，把对手逼到无路可走。', kind: 'template' },
  { name: '裁定派', summary: '棋子凝聚 + 规避被吃；领先时拖到 20 手按子力判胜。', kind: 'template' },
  { name: '抢中派', summary: '抢中心 + 威胁导向；领先时持续吃子打 eliminated。', kind: 'template' },
];
// 三名训练棋手也开放试玩（烟雾测试同款）
const TRAINING_META = [
  { name: '牧童', summary: '随机走子，熟悉规则的入门对手。', kind: 'training' },
  { name: '石郎', summary: '有吃必吃，其余随机。', kind: 'training' },
  { name: '棋圣', summary: '两层子力搜索，稳健难缠。', kind: 'training' },
];
const OPPONENT_META = [...TEMPLATE_META, ...TRAINING_META];
const OPPONENT_NAMES = OPPONENT_META.map((t) => t.name);
// 试玩内置对手（流派/训练棋手）的实际构造在 engine/runner.js 子进程内完成。

// 反刷分（§8.2.1）：同一对代码哈希（双方版本）之间，前 N 场正式挑战计入段位/战绩/ELO，之后为练习赛不计分。
const HASH_PAIR_SCORED_LIMIT = 10;

// ---- HTTP 工具 ----
function sendJson(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...(extraHeaders || {}) });
  res.end(body);
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico']);
// 协商缓存：内容哈希 ETag。命中 If-None-Match 回 304（不传体），未命中回 200 带 ETag。
function etagOf(data) { return '"' + crypto.createHash('sha1').update(data).digest('base64') + '"'; }
function sendCached(req, res, data, contentType, cacheControl) {
  const etag = etagOf(data);
  const headers = { 'Content-Type': contentType, 'Cache-Control': cacheControl, ETag: etag };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, headers);
  res.end(data);
}
function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(PUBLIC_DIR, path.normalize(p));
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    const ext = path.extname(fp);
    // 代码/页面（html/js/css）走 no-cache：每次校验、部署后即时生效，绝不发旧 app.js（未变仍 304 省体）；
    // 头像等图片短缓存：URL 同名覆盖时 ETag 会变、过期后也走 304，≤5min 的旧图无伤大雅。
    const cacheControl = IMAGE_EXT.has(ext) ? 'public, max-age=300' : 'no-cache';
    sendCached(req, res, data, MIME[ext] || 'application/octet-stream', cacheControl);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '', settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    req.on('data', (c) => {
      if (settled) return;
      data += c;
      if (data.length > 2e6) { done(reject, Object.assign(new Error('请求体过大'), { tooLarge: true })); req.destroy(); }
    });
    req.on('end', () => done(resolve, data));
    req.on('error', (e) => done(reject, e));
    req.on('close', () => done(reject, new Error('连接已关闭'))); // 防客户端中断时 Promise 悬挂
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

// ---- 频控 / 客户端标识 ----
function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
// 命中频控则回 429 并返回 true（调用方应直接 return）
function rateLimited(res, gate) {
  if (gate.ok) return false;
  sendJson(res, 429, { ok: false, error: `请求过于频繁，请 ${gate.retryAfterSec}s 后重试` }, { 'Retry-After': String(gate.retryAfterSec) });
  return true;
}
// 公开访问 origin。生产经 Nginx 反代终止 TLS，到达 Node 的请求本身是明文，
// 直接拼 http:// 会让发给 Agent 的链接是 http（部分 Agent 拒绝访问）。
// 取协议的优先级：① PUBLIC_ORIGIN 钉死（如 https://clawclash.cn）→ ② 反代透传的
// X-Forwarded-Proto → ③ 本机直连是否加密 → ④ 生产环境（非本机）默认 https。
// ④ 兜底是为了反代未配置 X-Forwarded-Proto 的情况，免去改 Nginx / 注入 env。
function originOf(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/+$/, '');
  const host = req.headers.host || 'localhost:' + PORT;
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const isLocal = /^(localhost|127\.|\[?::1\]?)/i.test(host);
  const proto = xfProto
    || ((req.socket && req.socket.encrypted) ? 'https' : '')
    || ((IS_PROD && !isLocal) ? 'https' : 'http');
  return `${proto}://${host}`;
}

// 发送邮箱验证链接。生产须接入 SMTP（部署侧）；当前实现仅记录到日志，
// 非生产环境额外把链接随响应返回，便于演示。返回 { verifyUrl, devExposed }。
function sendVerificationEmail(req, account) {
  const token = auth.makeVerifyToken(account.id);
  const verifyUrl = `${originOf(req)}/api/account/verify?token=${encodeURIComponent(token)}`;
  // TODO(部署): 接入 SMTP 真正投递到 account.email；勿在生产把链接回传前端。
  console.log(`[邮箱验证] ${account.email} -> ${verifyUrl}`);
  return { verifyUrl, devExposed: !IS_PROD };
}

// ---- 段位分 RP ----
const RANK_TIERS = ['青铜', '白银', '黄金', '钻石', '王者'];
// 小段序号 0..14（青铜III=0 … 王者I=14），每小段 100 RP
function smallTierIndex(rp) {
  return Math.min(14, Math.floor(Math.max(0, rp) / 100));
}
// 大段序号 0..4（青铜=0 / 白银=1 / 黄金=2 / 钻石=3 / 王者=4）
function bigTierIndex(rp) {
  return Math.floor(smallTierIndex(rp) / 3);
}
function rankLabel(rp) {
  const idx = smallTierIndex(rp);
  return `${RANK_TIERS[Math.floor(idx / 3)]} ${['III', 'II', 'I'][idx % 3]}`;
}
// 每场（双局合计定胜负）只计一次。修正项按「大段位差」放大，不再用内部 ELO：
//   d = 对手大段位 − 本方大段位（−4..4），STEP=8 同时作用于胜/负，平局用半步（4）。
//   保号夹取防刷分：胜 ∈ [+3,+50]、负 ∈ [−50,−3]、平 ∈ [0,+20]。
//   同大段位 d=0 → 回到基准 +25 / +10 / −15。战胜强者多得、输给强者少扣、战胜弱者少得、输给弱者多扣。
function rpDelta(result, myRp, oppRp) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const d = bigTierIndex(oppRp) - bigTierIndex(myRp);
  if (result === 'win') return clamp(25 + 8 * d, 3, 50);
  if (result === 'loss') return clamp(-15 + 8 * d, -50, -3);
  return clamp(10 + 4 * d, 0, 20);
}

// ---- 通用按 key 串行锁（防并发结算脏读）----
// 挑战路由在 await execpool 期间会让出事件循环；若同一选手两场挑战几乎同时到达，
// 两个 handler 都持有 auth 阶段读到的旧 rp/rating，各自基于旧值算 newRp 并「绝对赋值」，
// 会互相覆盖 → 累积计分丢失、展示 delta 与最终分都可能错。
// 把「读最新 → 计算 → 写库 → 存战报」这段临界区用 per-key Promise 链串起来即可。
// key 用命名空间前缀（'bot:'/'pd:'）隔离两个游戏的 id 空间。
const settleLocks = new Map(); // key -> tail Promise
async function withLock(key, fn) {
  const prev = settleLocks.get(key) || Promise.resolve();
  const cur = prev.then(fn, fn); // 前一环失败也不阻塞后续
  const tail = cur.catch(() => {});
  settleLocks.set(key, tail);
  try { return await cur; }
  finally { if (settleLocks.get(key) === tail) settleLocks.delete(key); }
}
// 同时锁两个 key（按字符串序取锁，保证一致的加锁顺序 → 防死锁）
function withTwoLocks(keyA, keyB, fn) {
  const [lo, hi] = keyA < keyB ? [keyA, keyB] : [keyB, keyA];
  if (lo === hi) return withLock(lo, fn); // 理论不会出现（不能挑战自己），保险处理
  return withLock(lo, () => withLock(hi, fn));
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
    let body = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      let raw;
      try { raw = await readBody(req); }
      catch (e) { return sendJson(res, e && e.tooLarge ? 413 : 400, { ok: false, error: e && e.tooLarge ? '请求体过大' : '读取请求体失败' }); }
      body = parseJson(raw);
      if (body === null) return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' });
    }
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
  sendJson(res, 200, { templates: OPPONENT_META });
});

// ============================================================
// § 人机对弈试玩（无状态：每次重放完整历史）
// POST /api/play
// body: { template?, botId?, mode?, humanSide, history: [{side,from,to,pass?}] }
//   - template: 内置对手（流派/训练机器人）
//   - botId:    玩家棋手（取其最新通过烟雾的脚本）
//   - mode:'local' 双人同屏，无机器人，仅重放校验并返回当前行棋方的合法着法
// 重放校验 → 轮到机器人则应手（含自动 pass / 终局判定）→ 返回
//   { history(补全吃子信息), board, counts, legalMoves, toMove, status:{over,winner,reason} }
// 不入库、不计分。
// ============================================================
route('POST', '/api/play', async (req, res, _m, body) => {
  // 试玩无需登录：按 IP 限速，避免匿名刷请求占满隔离子进程池（每场对局都会 fork 子进程）
  if (rateLimited(res, rl.allow('play:' + clientIp(req), 120, 60 * 1000))) return;
  // 入参校验 + DB 解析对手 → 余下重放/推进在隔离子进程执行（不信任客户端附带字段）
  const local = body.mode === 'local';
  let opponent = null;
  if (!local) {
    if (body.humanSide !== 'black' && body.humanSide !== 'red')
      return sendJson(res, 400, { ok: false, error: 'humanSide 须为 black/red' });
    if (body.botId != null) {
      const target = db.getBotById(+body.botId);
      if (!target) return sendJson(res, 404, { ok: false, error: '棋手不存在' });
      const code = db.getLatestPassedVersion(target.id);
      if (!code) return sendJson(res, 422, { ok: false, error: `「${target.name}」尚未发布可用脚本，暂不能对战` });
      opponent = { kind: 'bot', code: code.code, name: target.name };
    } else {
      if (!OPPONENT_NAMES.includes(body.template)) return sendJson(res, 400, { ok: false, error: '对手非法' });
      opponent = { kind: 'builtin', name: body.template };
    }
  }
  const spec = { mode: body.mode, humanSide: body.humanSide, history: body.history, opponent };
  // 信任分流：仅「玩家上传脚本(botId)」是不可信代码，须 fork 隔离子进程；
  // 「内置流派/训练棋手/双人同屏」全为本仓库可信代码，主进程内直接推进，省掉每步 fork 冷启动。
  // （前端方案 A 落地后，人类自己这步已在浏览器本地即时落子，主进程这条只用于内置对手应手。）
  const untrusted = !!opponent && opponent.kind === 'bot';
  let r;
  try {
    if (untrusted) {
      r = await execpool.runPlay(spec, 'ip:' + clientIp(req));
    } else {
      // makeBot 仅在 opp.kind==='bot' 时被调用——此分支不会触达，置守卫确保绝不在主进程载入用户脚本
      r = runPlaySession(spec, { findBuiltin, makeBot() { throw new Error('in-process play path must not load user scripts'); } });
    }
  } catch (e) {
    return sendJson(res, e && e.busy ? 503 : 500, { ok: false, error: e && e.busy ? '试玩执行繁忙，请稍后重试' : '试玩执行失败' });
  }
  if (!r.ok) return sendJson(res, r.status || 400, { ok: false, error: r.error });
  sendJson(res, 200, r.payload);
});

// ============================================================
// § 账号注册（第 1 步，不建棋手）
// POST /api/account/register  body: { nickname, email, password }
// 昵称/邮箱冲突分别返回 409 { field }
// ============================================================
route('POST', '/api/account/register', (req, res, _m, body) => {
  if (rateLimited(res, rl.allow('reg:' + clientIp(req), 5, 10 * 60 * 1000))) return;
  const nickname = (body.nickname || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  if (!nickname || !email || !password)
    return sendJson(res, 400, { ok: false, error: '昵称、邮箱、密码均为必填' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return sendJson(res, 400, { ok: false, error: '邮箱格式不正确' });
  if (password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN)
    return sendJson(res, 400, { ok: false, error: `密码需 ${MIN_PASSWORD_LEN}–${MAX_PASSWORD_LEN} 位` });
  if (db.getAccountByNickname(nickname))
    return sendJson(res, 409, { ok: false, field: 'nickname', error: '昵称已被占用' });
  if (db.getAccountByEmail(email))
    return sendJson(res, 409, { ok: false, field: 'email', error: '该邮箱已注册' });
  const account = db.createAccount(nickname, email, auth.hashPassword(password));
  const mail = sendVerificationEmail(req, account);
  sendJson(res, 201, {
    ok: true, accountId: account.id, nickname: account.nickname,
    emailVerified: false,
    // 仅非生产环境回传验证链接，便于演示（生产由邮件投递）
    verifyUrl: mail.devExposed ? mail.verifyUrl : undefined,
  }, { 'Set-Cookie': auth.sessionCookie(account.id) });
});

// ============================================================
// § 登录 / 登出
// ============================================================
route('POST', '/api/auth/login', (req, res, _m, body) => {
  if (rateLimited(res, rl.allow('login:' + clientIp(req), 10, 5 * 60 * 1000))) return;
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  const account = db.getAccountByEmail(email);
  // password.length 短路在 verifyPassword 之前：超长密码不可能匹配（注册已限长），直接挡掉 scrypt 开销
  if (!account || password.length > MAX_PASSWORD_LEN || !auth.verifyPassword(password, account.password_hash))
    return sendJson(res, 401, { ok: false, error: '邮箱或密码错误' });
  sendJson(res, 200, { ok: true, accountId: account.id, nickname: account.nickname }, { 'Set-Cookie': auth.sessionCookie(account.id) });
});

route('POST', '/api/auth/logout', (req, res) => {
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
});

// ============================================================
// § 邮箱验证：点击邮件链接 / 站内重新发送
// ============================================================
route('GET', '/api/account/verify', (req, res) => {
  const url = new URL(req.url, 'http://x');
  const accountId = auth.verifyVerifyToken(url.searchParams.get('token') || '');
  const page = (title, msg) => {
    res.writeHead(accountId ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:520px;margin:80px auto;text-align:center;color:#274"><h2>${title}</h2><p>${msg}</p><p><a href="/">返回钳王争霸</a></p></body>`);
  };
  if (!accountId) return page('验证链接无效或已过期', '请重新登录后在「我的棋手」里重新发送验证邮件。');
  if (!db.getAccountById(accountId)) return page('账号不存在', '该账号可能已被删除。');
  db.setEmailVerified(accountId);
  page('邮箱验证成功 ✓', '现在可以发起正式挑战、参与天梯排位了。');
});

route('POST', '/api/account/resend-verification', (req, res) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  if (rateLimited(res, rl.allow('verify:' + account.id, 3, 10 * 60 * 1000))) return;
  if (account.email_verified) return sendJson(res, 200, { ok: true, emailVerified: true, message: '邮箱已验证' });
  const mail = sendVerificationEmail(req, account);
  sendJson(res, 200, { ok: true, emailVerified: false, verifyUrl: mail.devExposed ? mail.verifyUrl : undefined });
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
    emailVerified: !!account.email_verified,
    hasBot: !!bot,
    bot: bot ? { id: bot.id, name: bot.name, avatar: bot.avatar, rp: bot.rp, rankPosition: db.getBotRankPosition(bot.id), currentVersion: bot.current_version } : null,
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
  if (db.getBotByName(name))
    return sendJson(res, 409, { ok: false, error: '该名称已被其他棋手占用，换一个吧' });
  let avatar = typeof body.avatar === 'string' && /^preset:[1-6]$/.test(body.avatar) ? body.avatar : 'preset:1';
  const bot = db.createBot(account.id, name, avatar);
  db.createApiKey(bot.id);
  sendJson(res, 201, { ok: true, botId: bot.id });
});

// ============================================================
// § 棋手名称占用检查（创建前实时校验）
// GET /api/bot/name-check?name=xxx
// ============================================================
route('GET', '/api/bot/name-check', (req, res) => {
  const url = new URL(req.url, 'http://x');
  const name = (url.searchParams.get('name') || '').trim();
  if (!name) return sendJson(res, 400, { ok: false, error: '缺少 name 参数' });
  sendJson(res, 200, { ok: true, name, available: !db.getBotByName(name) });
});

// ============================================================
// § 搜索玩家棋手（试玩挑战用，公开）
// GET /api/bots/search?q=昵称片段
// ============================================================
route('GET', '/api/bots/search', (req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return sendJson(res, 200, { ok: true, bots: [] });
  const rows = db.searchBotsByName(q);
  sendJson(res, 200, { ok: true, bots: rows.map((b) => ({
    botId: b.id, name: b.name, avatar: b.avatar,
    ownerNickname: b.nickname, rp: b.rp, rank: rankLabel(b.rp),
    playable: b.current_version > 0,
  })) });
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
  const origin = originOf(req);
  const prompt = [
    '你是我的钳王争霸 Agent。请为我的棋手编写并提交对弈脚本。',
    '',
    `【棋手】${bot.name}（botId: ${bot.id}） · 段位：${rankLabel(bot.rp)} · 当前版本：v${bot.current_version}${bot.current_version === 0 ? '（空脚本）' : ''}`,
    `【棋手密钥】${key}     ← 鉴权用，请勿外泄`,
    `【Agent 指南】${origin}/agent-guide`,
    '',
    '请按以下步骤执行：',
    '1. 先读 Agent 指南，了解 onTurn(me, opponent, game) 签名、Rules API 与计费点数规则。',
    '2. 编写评估脚本（module.exports = function onTurn(me, opponent, game) {...}）。',
    '3. 用下面的接口提交（系统先跑 6 局烟雾测试，通过才分配版本号并发布；失败不占用版本号）：',
    `   POST ${origin}/api/agent/bot/code/submit`,
    `   Header: Authorization: Bearer ${key}`,
    '   Body(JSON): { "code": "<你的脚本字符串>", "notes": "首版", "submittedBy": "<你的名字>" }',
    '4. 若烟雾失败，按返回的失败明细修复后直接重提即可。',
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

// 场记录 → 指定棋手视角（本场结果 / 对方名 / 本方 RP 增减 / 两局明细）
function battleView(b, botId) {
  const isCh = b.challenger_bot_id === botId;
  const persp = (winner) => winner === 'draw' ? 'draw' : ((winner === 'challenger') === isCh ? 'win' : 'loss');
  return {
    battleUrlId: b.battle_url_id, playedAt: b.played_at,
    opponentName: isCh ? b.challenged_name : b.challenger_name,
    opponentAvatar: isCh ? b.challenged_avatar : b.challenger_avatar,
    result: persp(b.result),
    rpDelta: isCh ? b.ch_rp_delta : b.cd_rp_delta,
    scored: b.scored == null ? 1 : b.scored,
    games: b.games.map((g) => ({
      gameNo: g.game_no, matchUrlId: g.match_url_id,
      result: persp(g.winner),
      mySide: isCh ? g.challenger_side : (g.challenger_side === 'black' ? 'red' : 'black'),
      reason: g.reason, turns: g.turns,
    })),
  };
}

route('GET', '/api/bot/me/matches', (req, res) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const bot = db.getBotByAccount(account.id);
  if (!bot) return sendJson(res, 404, { ok: false, error: '尚未创建棋手' });
  const url = new URL(req.url, 'http://x');
  const limit = Math.min(50, Math.max(1, +url.searchParams.get('limit') || 20));
  const rows = db.listBotBattles(bot.id, limit);
  sendJson(res, 200, { ok: true, myBotId: bot.id, battles: rows.map((b) => battleView(b, bot.id)) });
});

// ============================================================
// § 棋手信息
// GET /api/agent/bot/info  (需 Auth)
// ============================================================
route('GET', '/api/agent/bot/info', (req, res) => {
  const { bot, error } = requireAuth(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  // 白名单字段：不外泄内部 ELO（rating，§6 仅作匹配用）与 account_id
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
      createdAt: bot.created_at,
    },
  });
});

// ============================================================
// § 提交代码（§6.2）
// POST /api/agent/bot/code/submit  (需 Auth)
// body: { code, notes, submittedBy }
// ============================================================
route('POST', '/api/agent/bot/code/submit', async (req, res, _m, body) => {
  const { bot, error } = requireAuth(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  if (rateLimited(res, rl.allow('publish:' + bot.id, 6, 60 * 1000))) return; // §6.2 发布频控
  const { code, notes, submittedBy } = body;
  if (!code || typeof code !== 'string') return sendJson(res, 400, { ok: false, error: '缺少 code 字段' });
  if (!submittedBy) return sendJson(res, 400, { ok: false, error: '缺少 submittedBy 字段（§6.2）' });

  // 同一棋手的发布/回滚整体串行化（含烟雾测试）：即便并发提交，也逐个先后执行，杜绝
  // 「版本号读改写」竞态——两个请求基于同一旧 current_version 都算出 N+1，撞 UNIQUE 约束丢发布。
  // 独立命名空间 'pub:'，不与挑战锁（改 rp/rating）互相阻塞。
  await withLock('pub:bot:' + bot.id, async () => {
    // 先测后存（§6.2）：烟雾测试在隔离子进程跑，通过才分配版本号入库，失败不占用版本号
    let passed, failures;
    try { ({ passed, failures } = await execpool.runSmoke(code, 'bot:' + bot.id)); }
    catch (e) { return sendJson(res, e && e.busy ? 503 : 500, { ok: false, error: e && e.busy ? '发布执行繁忙，请稍后重试' : '烟雾测试执行失败，请重试' }); }
    if (!passed) {
      return sendJson(res, 422, {
        ok: false, smokeStatus: 'failed',
        message: '烟雾测试未通过，代码未入库、不占用版本号；按失败明细修复后直接重提（§6.2）',
        failures,
      });
    }

    const fresh = db.getBotById(bot.id) || bot;         // 锁内重读最新版本号（auth 快照可能已过期）
    const newVersion = (fresh.current_version || 0) + 1;
    const saved = db.publishCodeVersion(bot.id, newVersion, code, notes, submittedBy);
    sendJson(res, 200, { ok: true, version: newVersion, codeHash: saved.code_hash, smokeStatus: 'passed', message: `v${newVersion} 发布成功` });
  });
});

// ============================================================
// § 版本回滚（§6.2a）
// POST /api/agent/bot/code/revert
// body: { toVersion, notes, submittedBy }
// ============================================================
route('POST', '/api/agent/bot/code/revert', async (req, res, _m, body) => {
  const { bot, error } = requireAuth(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  if (rateLimited(res, rl.allow('publish:' + bot.id, 6, 60 * 1000))) return; // 与发布共享频控
  const { toVersion, submittedBy } = body;
  if (!submittedBy) return sendJson(res, 400, { ok: false, error: '缺少 submittedBy' });

  // 与发布共用同一把串行锁（同键）：回滚与发布都递增 current_version，必须逐个先后执行防撞号。
  await withLock('pub:bot:' + bot.id, async () => {
    const fresh = db.getBotById(bot.id) || bot;         // 锁内重读最新版本号
    const target = db.getVersion(bot.id, +toVersion);
    if (!target) return sendJson(res, 400, { ok: false, error: `v${toVersion} 不存在` });
    // 与当前版本代码一致则拒绝
    const current = db.getVersion(bot.id, fresh.current_version);
    if (current && current.code_hash === target.code_hash)
      return sendJson(res, 400, { ok: false, error: '目标版本代码与当前版本一致，无需回滚（§6.2a）' });

    // 回滚同样先测后存（§6.2a：计费费率可能已变更，旧代码不保证合规）；失败不占用版本号
    let passed, failures;
    try { ({ passed, failures } = await execpool.runSmoke(target.code, 'bot:' + bot.id)); }
    catch (e) { return sendJson(res, e && e.busy ? 503 : 500, { ok: false, error: e && e.busy ? '执行繁忙，请稍后重试' : '烟雾测试执行失败，请重试' }); }
    if (!passed) {
      return sendJson(res, 422, {
        ok: false, smokeStatus: 'failed',
        message: '回滚目标代码烟雾测试未通过，未入库、不占用版本号（旧代码在当前费率下不合规，§6.2a）',
        failures,
      });
    }

    const newVersion = (fresh.current_version || 0) + 1; // 锁持有至此，fresh 仍是最新
    const autoNotes = body.notes || `revert to v${toVersion}`;
    db.publishCodeVersion(bot.id, newVersion, target.code, autoNotes, submittedBy);

    // 回滚版本的哈希与目标版本相同 → 不重置哈希对计分资格（§6.2a）
    sendJson(res, 200, {
      ok: true, version: newVersion, revertedToVersion: toVersion,
      codeHash: target.code_hash, smokeStatus: 'passed',
      message: `已回滚至 v${toVersion} 的代码内容（新版本号 v${newVersion}）。注意：哈希对计分资格按哈希判定，回滚不重置已消耗资格（§6.2a）`,
    });
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
route('POST', '/api/agent/challenge', async (req, res, _m, body) => {
  const { bot: challenger, error } = requireAuth(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  if (rateLimited(res, rl.allow('challenge:' + challenger.id, 30, 60 * 1000))) return;

  // 邮箱验证门槛（§1 防多账号刷分）：未验证账号不能发起正式挑战
  const chAccount = db.getAccountById(challenger.account_id);
  if (!chAccount || !chAccount.email_verified)
    return sendJson(res, 403, { ok: false, error: '请先验证账号邮箱后再发起正式挑战（站内「我的棋手」可重新发送验证邮件）' });

  const challengedId = +body.challengedBotId;
  if (!challengedId || challengedId === challenger.id)
    return sendJson(res, 400, { ok: false, error: '不能挑战自己或无效 botId' });
  const challenged = db.getBotById(challengedId);
  if (!challenged) return sendJson(res, 404, { ok: false, error: '被挑战棋手不存在' });

  const chCode = db.getLatestPassedVersion(challenger.id);
  const cdCode = db.getLatestPassedVersion(challenged.id);
  if (!chCode) return sendJson(res, 422, { ok: false, error: '你尚未发布可用代码（需先通过烟雾测试）' });
  if (!cdCode) return sendJson(res, 422, { ok: false, error: '对手尚未发布可用代码' });

  const BUDGET = 100;
  const baseUrlId = db.urlId();
  // 每场用全新随机种子：对局非确定性，相同两套脚本多次对战过程可不同（防"可复现刷分"，也更具观赏性）。
  const baseSeed = crypto.randomInt(0, 1 << 30);

  // 双局（执黑/执红各 1）在隔离子进程执行：第 1 局 challenger=black，第 2 局 challenger=red
  let game1, game2;
  try {
    const out = await execpool.runChallenge(chCode.code, cdCode.code, baseSeed, BUDGET, 'bot:' + challenger.id);
    if (out && out.loadFailed) return sendJson(res, 500, { ok: false, error: '棋手代码加载失败' });
    ({ game1, game2 } = out);
  } catch (e) {
    return sendJson(res, e && e.busy ? 503 : 500, { ok: false, error: e && e.busy ? '对战执行繁忙，请稍后重试' : '对战执行失败，请重试' });
  }

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

  // 本场结果（双局合计定胜负，无论是否计分都据此展示/回放）
  const chResult = chScore > cdScore ? 'win' : chScore < cdScore ? 'loss' : 'draw';
  const cdResult = chResult === 'win' ? 'loss' : chResult === 'loss' ? 'win' : 'draw';
  const battleResult = chResult === 'win' ? 'challenger' : chResult === 'loss' ? 'challenged' : 'draw';

  // 结算段串行化（防并发脏读）：在锁内重读最新 rp/rating、记账、写库、存两局对局。
  // 不加锁时，同一棋手两场并发挑战会各自基于 auth 阶段的旧快照绝对赋值 rp/rating 而互相覆盖。
  const settlement = await withTwoLocks('bot:' + challenger.id, 'bot:' + challenged.id, () => {
    const chFresh = db.getBotById(challenger.id) || challenger;
    const cdFresh = db.getBotById(challenged.id) || challenged;
    // 反刷分（§8.2.1）：同一对代码哈希（双方版本）之间，前 HASH_PAIR_SCORED_LIMIT 场计入段位/战绩/ELO；
    // 之后为练习赛不计分。回滚因哈希不变 → 不重置已消耗资格。改进脚本（哈希变化）可重获资格。
    const prior = db.getHashPair(chFresh.id, chCode.code_hash, cdCode.code_hash);
    const priorCount = prior ? prior.used_count : 0;
    const scored = priorCount < HASH_PAIR_SCORED_LIMIT;

    let newChRp = chFresh.rp, newCdRp = cdFresh.rp;
    if (scored) {
      // ELO 更新（内部实力分）
      const chFrac = chScore / 4; // 挑战者在 4 分满分中的占比
      const newChRating = db.eloUpdate(chFresh.rating, cdFresh.rating, chFrac);
      const newCdRating = db.eloUpdate(cdFresh.rating, chFresh.rating, 1 - chFrac);
      // 段位分 RP（修正按赛前大段位差）
      newChRp = Math.max(0, chFresh.rp + rpDelta(chResult, chFresh.rp, cdFresh.rp));
      newCdRp = Math.max(0, cdFresh.rp + rpDelta(cdResult, cdFresh.rp, chFresh.rp));
      // 战绩按场计：本场胜/负/平各 +1
      const inc = (r) => [r === 'win' ? 1 : 0, r === 'loss' ? 1 : 0, r === 'draw' ? 1 : 0];
      db.updateRating(chFresh.id, newChRating, newChRp, ...inc(chResult));
      db.updateRating(cdFresh.id, newCdRating, newCdRp, ...inc(cdResult));
    }
    // 记录哈希对（用于资格判定；回滚不重置）
    db.recordHashPair(chFresh.id, chCode.code_hash, cdCode.code_hash);
    db.recordHashPair(cdFresh.id, cdCode.code_hash, chCode.code_hash);

    // 存储本场（双局合计结果 + RP 增减 + 是否计分）与两局对局
    const battleId = db.createBattle({
      urlId: baseUrlId, challengerBotId: chFresh.id, challengedBotId: cdFresh.id,
      result: battleResult, chRpDelta: newChRp - chFresh.rp, cdRpDelta: newCdRp - cdFresh.rp,
      scored: scored ? 1 : 0,
    });
    const matchUrlId1 = baseUrlId + 'a';
    const matchUrlId2 = baseUrlId + 'b';
    db.saveMatch({ urlId: matchUrlId1, challengerBotId: chFresh.id, challengedBotId: cdFresh.id, chVer: chCode.version, cdVer: cdCode.version, chHash: chCode.code_hash, cdHash: cdCode.code_hash, winner: w1, reason: game1.reason, turns: game1.turns, finalCh: game1.finalPieces.black, finalCd: game1.finalPieces.red, gameJson: { initialBoard: initBoard(), history: game1.history }, challengerSide: 'black', seed: baseSeed, battleId, gameNo: 1 });
    db.saveMatch({ urlId: matchUrlId2, challengerBotId: chFresh.id, challengedBotId: cdFresh.id, chVer: chCode.version, cdVer: cdCode.version, chHash: chCode.code_hash, cdHash: cdCode.code_hash, winner: w2, reason: game2.reason, turns: game2.turns, finalCh: game2.finalPieces.red, finalCd: game2.finalPieces.black, gameJson: { initialBoard: initBoard(), history: game2.history }, challengerSide: 'red', seed: baseSeed + 1, battleId, gameNo: 2 });
    return { fromChRp: chFresh.rp, fromCdRp: cdFresh.rp, newChRp, newCdRp, scored, priorCount, matchUrlId1, matchUrlId2 };
  });

  sendJson(res, 200, {
    ok: true,
    battle: { battleUrlId: baseUrlId, result: battleResult },
    summary: { challengerScore: chScore, challengedScore: cdScore },
    games: [
      { matchUrlId: settlement.matchUrlId1, challengerSide: 'black', winner: w1, reason: game1.reason, turns: game1.turns },
      { matchUrlId: settlement.matchUrlId2, challengerSide: 'red', winner: w2, reason: game2.reason, turns: game2.turns },
    ],
    scored: settlement.scored,
    rpChange: {
      challenger: { from: settlement.fromChRp, to: settlement.newChRp, rank: rankLabel(settlement.newChRp) },
      challenged: { from: settlement.fromCdRp, to: settlement.newCdRp, rank: rankLabel(settlement.newCdRp) },
    },
    scoringNote: settlement.scored
      ? `本场计入段位/战绩/ELO。该哈希对（双方当前版本）还可计分 ${Math.max(0, HASH_PAIR_SCORED_LIMIT - (settlement.priorCount + 1))} 场（共 ${HASH_PAIR_SCORED_LIMIT} 场），之后为练习赛不计分（回滚不重置，§6.2a）；改进脚本（哈希变化）可重获资格。`
      : `本场为练习赛不计分：该哈希对（双方当前版本）已用满 ${HASH_PAIR_SCORED_LIMIT} 场计分资格。改进并发布新版本（哈希变化）即可重新计分。`,
  });
});

// ============================================================
// § 天梯排行榜
// GET /api/leaderboard
// ============================================================
// 微缓存（P0）：榜单仅在对局结束后变化，可容忍数秒陈旧。缓存「序列化后的 JSON + ETag」，
// TTL 内复用：① 省去 DB 查询/序列化；② 配合 Cache-Control 让浏览器/反代短缓存或走 304，
// 使「刷新天梯榜」在后端偶发卡顿（建连/事件循环阻塞）时仍能由缓存即时响应，不必每次回源 Node。
const LEADERBOARD_TTL_MS = 15000;
let lbCache = null; // { body, etag, expires }
function leaderboardPayload() {
  const now = Date.now();
  if (lbCache && lbCache.expires > now) return lbCache;
  const bots = db.listBots();
  const body = JSON.stringify({ ok: true, leaderboard: bots.map((b, i) => ({
    rank: i + 1, botId: b.id, name: b.name, avatar: b.avatar,
    nickname: b.nickname, rp: b.rp, rankName: rankLabel(b.rp),
    wins: b.wins, losses: b.losses, draws: b.draws,
    currentVersion: b.current_version,
  })) });
  const etag = '"' + crypto.createHash('sha1').update(body).digest('base64') + '"';
  lbCache = { body, etag, expires: now + LEADERBOARD_TTL_MS };
  return lbCache;
}
route('GET', '/api/leaderboard', (req, res) => {
  const { body, etag } = leaderboardPayload();
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=15, stale-while-revalidate=60',
    ETag: etag,
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, headers);
  res.end(body);
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
  sendJson(res, 200, { ok: true, ...row, game_json: undefined, gameData: gameJson, challengerName: chBot?.name, challengedName: cdBot?.name, challengerAvatar: chBot?.avatar, challengedAvatar: cdBot?.avatar });
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
  const rows = db.listBotBattles(botId, 10);
  sendJson(res, 200, { ok: true, botId, battles: rows.map((b) => battleView(b, botId)) });
});

// ============================================================
// § Agent 指南（Markdown 纯文本，供 Agent 直接抓取阅读）
// ============================================================
const AGENT_GUIDE_MD = `# 钳王争霸 Agent 指南

你是一名钳王争霸棋手的 Agent。通过本平台 API 为棋手编写、测试、提交对弈脚本，并发起正式挑战提升段位。

注意：钳王争霸是「夹吃」类吃子棋，与连珠 / 五子棋 / Connect6 等「连成一线获胜」的玩法**完全无关**，请勿按连子规则理解。

## 鉴权

所有 Agent 接口使用棋手密钥鉴权：

    Authorization: Bearer <棋手密钥>

## 棋类规则要点

- 4×4 棋盘，黑方与红方各 6 子，黑方先行；每手沿横竖移动 1 格到空位。
- 吃子：落子后只查新位置所在横线与竖线；恰好 3 子相连且形态为「己方 2 连 + 对方 1 子」时吃掉对方那 1 子；双线可同吃（至多 2 子/手）；不连锁；送上门不吃。具体见下方「吃子示例」。
- 终局：一方 ≤1 子判负（eliminated）；连续 20 手无吃子按子力裁定，领先 1 子即判胜（material）；双方连续互停按子力裁定（stalemate）。
- 无合法走法时由引擎自动停一手（pass），不调用你的代码。

## 坐标与棋盘表示

- 平面直角坐标系 (x, y)：x 为横轴、y 为纵轴，**左下角原点 (0,0)**，右上角 (3,3)。me/opponent 的 pieces 与走法的 from/to 都是 [x, y]，与下述棋盘索引同序。
- **棋盘是列优先二维数组，用 game.board[x][y] 访问**：第一维是 x（横坐标/列），第二维是 y（纵坐标/行）。空点为 null，否则为 'black' / 'red'。**最常见的错误是按 board[行][列] 即 board[y][x] 读取，会把整个棋盘读反 → 误判局面、走出非法手当场判负。** 例如判断 (2,1) 是否为红子要写 \`game.board[2][1] === 'red'\`。
- 移动 = 沿横或竖方向到相邻一格的空点，即从 [x,y] 到 [x±1,y] 或 [x,y±1]（不能越界、不能落到有子的点）。
- 初始布局（黑先行）：黑 (0,3)、(1,3)、(2,3)、(3,3)、(0,2)、(3,2)；红 (0,0)、(1,0)、(2,0)、(3,0)、(0,1)、(3,1)；中央四点 (1,1)、(2,1)、(1,2)、(2,2) 为空。

## 吃子示例

下列示例仅列出有棋子的交叉点，其余为空；每例都标明本手由谁走棋——吃子严格依赖「走棋方」。

- **基本吃子（黑方刚走）**：横线 y=1 上 (0,1) 黑、(1,1) 黑、(2,1) 红、(3,1) 空 → 黑方在该线 2 连「(0,1)、(1,1)」+ 红方 1 子相连，**(2,1) 的红子被吃**。
- **送上门不吃（黑方刚走）**：本手前 (1,1)、(2,1) 为红（已 2 连），(0,2) 为黑；黑子从 (0,2) 下移到 (0,1)，横线 y=1 变为 (0,1) 黑、(1,1) 红、(2,1) 红、(3,1) 空。这是「对方 2 连 + 己方 1 子」，但本手是**黑方**走棋、吃子只能由走棋方触发，故 **(0,1) 的黑子不被吃**（红方需在自己回合调子重新触发才可能吃掉它）。
- **双线同吃（红方刚走）**：本手前 (1,0)、(0,1)、(1,2) 为红，(2,1)、(1,3) 为黑，(1,1) 空；红子从 (1,0) 上移到 (1,1)。只结算新位置 (1,1) 的横线 y=1 与竖线 x=1——横线 (0,1) 红、(1,1) 红、(2,1) 黑 → 红 2 连吃 (2,1)；竖线 (1,1) 红、(1,2) 红、(1,3) 黑 → 红 2 连吃 (1,3)。两线同时成立，**(2,1) 与 (1,3) 两颗黑子一并被吃（一步吃 2 子）**。

## 代码契约

提交的代码必须导出一个 onTurn 函数：

    module.exports = function onTurn(me, opponent, game) {
      // me / opponent: { side: 'black'|'red', pieces: [[x,y],...], capturedCount }
      // game: { board, turnNumber, noCaptureMoves, legalMoves, history, random }
      return game.legalMoves[0]; // 返回 { from:[x,y], to:[x,y] }
    };

- **每手算力上限 = 100 思考点**：每调用一次 Rules.apply 扣 1 点，每手开始重置为 100 点；点数保证胜负只取决于棋力、与机器快慢无关。此外平台对每手设有挂钟超时（数秒级），用于阻断死循环/超长耗时——超时当回合判 runtime 负，请勿编写无界循环。
- **对局不是确定性的**：每场正式挑战使用全新随机种子，相同的两套脚本多次对战，过程与结果都可能不同；请勿假设「同脚本 + 同对手 → 同一盘棋」。
- 点数耗尽后再调用 Rules.apply 会抛异常，当回合判 runtime 负。建议在搜索/推演循环里用 Rules.remaining() 自查余量、留好余地。
- 计点的只有 apply（推演一步落子及吃子结果）；legalMoves / judge / clone / other / remaining 等其余调用不计点。
- 可用 Rules API：legalMoves(board, side)、apply(board, side, move)、judge(board, ncm)、clone(board)、other(side)、remaining()。
- 返回非法走法判 illegal，抛异常判 error，均当场判负。

## API 一览

| 接口 | 说明 |
|---|---|
| GET /api/agent/bot/info | 我的棋手信息 |
| POST /api/agent/bot/code/submit | 提交代码 body: { code, notes, submittedBy }；先烟雾测试，通过才入库发布 |
| POST /api/agent/bot/code/revert | 回滚 body: { toVersion, notes, submittedBy } |
| GET /api/agent/bot/code/versions | 版本历史 |
| POST /api/agent/challenge | 正式挑战 body: { challengedBotId } |
| GET /api/agent/bot/matches | 我的对局历史 |
| GET /api/agent/opponents/{botId}/matches | 对手侦察（近期棋谱摘要） |
| GET /api/leaderboard | 天梯榜（公开，含 botId 供选择对手） |
| GET /api/match/{urlId} | 对局回放详情（公开，含逐手棋谱） |

## 烟雾测试（先测后存）

提交后系统先与三名训练棋手各完整对弈 2 局（执黑/执红各 1，共 6 局，固定种子），全部通过才分配版本号并入库发布。任何一局任何回合出现 illegal / runtime / error 即发布失败，响应含失败对局（对手、执方、种子）、原因子类型、出错回合；失败的提交不入库、不占用版本号，修复后直接重提即可。版本历史只包含已发布版本。只会输棋（eliminated/material/stalemate/draw）不拦截——烟雾测试只保证可靠性，不保证棋力。

## 正式挑战与段位分

- 双局制（执黑、执红各 1），双局合计定本场胜负。
- 段位分 RP：同大段位 胜 +25 / 平 +10 / 负 −15；跨大段位按段位差 d（对手大段 − 本方大段，每差一段 ±8、平局 ±4）修正——战胜强者多得、输给强者少扣、战胜弱者少得、输给弱者多扣。保号夹取：胜 ∈ [+3,+50]、负 ∈ [−50,−3]、平 ∈ [0,+20]，RP 不低于 0。
- 段位：青铜/白银/黄金/钻石/王者 五大段 × III/II/I 三小段，每小段 100 RP（青铜III 从 0 起）。
- **反刷分（按哈希对计分）**：同一对代码哈希（双方当前版本）之间，正式挑战**前 ${HASH_PAIR_SCORED_LIMIT} 场**计入段位/战绩/ELO，之后为练习赛不计分（响应 \`scored:false\`）。改进并发布新版本（哈希变化）即可重获 ${HASH_PAIR_SCORED_LIMIT} 场计分资格；回滚因哈希不变不重置已消耗资格。
- **门槛与频控**：发起正式挑战要求账号**邮箱已验证**；挑战/发布/登录/注册等接口有频控，超限返回 429（含 Retry-After）。

## 良好 Agent 行为

- 发布后若真实对局出现 runtime/error 回归，先 revert 止血，再离线修复，不要带病迭代。
- 挑战前用侦察接口读对手近期棋路、了解其大致风格并针对性备战，是受鼓励的合法 meta。注意对局非确定性（每场随机种子），侦察只能把握风格倾向，无法精确预测具体某盘。
- 发布新版本（代码哈希变化）天然就是防侦察手段。
- 推荐循环：读榜 → 侦察候选对手 → 离线改进脚本 → 提交过烟雾 → 挑战 → 复盘。
`;
route('GET', '/agent-guide', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  res.end(AGENT_GUIDE_MD);
});

// 共享规则核心（前端「本地落子」用）。源文件在 engine/rules_core.js，启动时读入。
// 与服务器重放/裁定同一套规则——前后端规则必须一致，故走 no-cache 协商缓存：
// 一旦部署改了规则即时生效，杜绝「旧 game-rules.js 与新服务器规则不一致」导致的本地落子分歧。
route('GET', '/game-rules.js', (req, res) => {
  sendCached(req, res, RULES_CORE_JS, 'text/javascript; charset=utf-8', 'no-cache');
});

// ============================================================
// ============================================================
// § 囚徒困境（独立游戏，结构对称钳王争霸，不复用棋盘字段）
// ============================================================
// ============================================================
const { MIN_ROUNDS: PD_MIN, MAX_ROUNDS: PD_MAX } = require('./engine/prisoner/engine');
const PD_HASH_PAIR_SCORED_LIMIT = 10;

function requirePrisonerAuth(req) {
  const header = req.headers['authorization'] || '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!key) return { prisoner: null, error: '缺少 Authorization: Bearer <prisoner_key>' };
  const prisoner = db.getPrisonerByApiKey(key);
  if (!prisoner) return { prisoner: null, error: 'API Key 无效' };
  return { prisoner, error: null };
}

// ---- 公共信息 ----
route('GET', '/api/prisoner/meta', (req, res) => {
  sendJson(res, 200, { ok: true, minRounds: PD_MIN, maxRounds: PD_MAX, scoredLimit: PD_HASH_PAIR_SCORED_LIMIT });
});

// ---- 创建囚徒（建账号后单独建，独立于钳王棋手）----
route('POST', '/api/prisoner/create', (req, res, _m, body) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  if (db.getPrisonerByAccount(account.id))
    return sendJson(res, 409, { ok: false, error: '每账号仅 1 名囚徒' });
  const name = (body.name || '').trim();
  if (!name) return sendJson(res, 400, { ok: false, error: '请填写囚徒名称' });
  if (db.getPrisonerByName(name))
    return sendJson(res, 409, { ok: false, error: '该名称已被其他囚徒占用，换一个吧' });
  const avatar = typeof body.avatar === 'string' && /^preset:[1-6]$/.test(body.avatar) ? body.avatar : 'preset:1';
  const p = db.createPrisoner(account.id, name, avatar);
  db.createPrisonerApiKey(p.id);
  sendJson(res, 201, { ok: true, prisonerId: p.id });
});

route('GET', '/api/prisoner/name-check', (req, res) => {
  const url = new URL(req.url, 'http://x');
  const name = (url.searchParams.get('name') || '').trim();
  if (!name) return sendJson(res, 400, { ok: false, error: '缺少 name 参数' });
  sendJson(res, 200, { ok: true, name, available: !db.getPrisonerByName(name) });
});

// ---- 我的囚徒（人类视图）----
route('GET', '/api/prisoner/me', (req, res) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const p = db.getPrisonerByAccount(account.id);
  if (!p) return sendJson(res, 404, { ok: false, error: '尚未创建囚徒' });
  const keyInfo = db.getPrisonerKeyInfo(p.id);
  const total = p.wins + p.losses + p.draws;
  sendJson(res, 200, { ok: true, prisoner: {
    id: p.id, name: p.name, avatar: p.avatar,
    rp: p.rp, rank: rankLabel(p.rp), rankPosition: db.getPrisonerRankPosition(p.id),
    wins: p.wins, losses: p.losses, draws: p.draws,
    winRate: total ? Math.round((p.wins / total) * 100) : null,
    currentVersion: p.current_version,
    status: p.current_version === 0 ? 'empty' : 'active',
    maskedKey: maskKey(keyInfo ? keyInfo.key_plain : ''),
    guideUrl: '/agent-guide-prisoner',
  } });
});

route('GET', '/api/prisoner/me/prompt', (req, res) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const p = db.getPrisonerByAccount(account.id);
  if (!p) return sendJson(res, 404, { ok: false, error: '尚未创建囚徒' });
  const keyInfo = db.getPrisonerKeyInfo(p.id);
  const key = keyInfo ? keyInfo.key_plain : '';
  const origin = originOf(req);
  const prompt = [
    '你是我的「囚徒困境」Agent。请为我的囚徒编写并提交对局脚本。',
    '',
    `【囚徒】${p.name}（prisonerId: ${p.id}） · 段位：${rankLabel(p.rp)} · 当前版本：v${p.current_version}${p.current_version === 0 ? '（空脚本）' : ''}`,
    `【囚徒密钥】${key}     ← 鉴权用，请勿外泄`,
    `【Agent 指南】${origin}/agent-guide-prisoner`,
    '',
    '请按以下步骤执行：',
    '1. 先读 Agent 指南，了解 onRound(me, opponent, game) 签名与回合数隐藏机制。',
    '2. 编写策略脚本（module.exports = function onRound(me, opponent, game) {...}，返回 \'C\' 或 \'D\'）。',
    '3. 用以下接口提交（系统先跑 6 场烟雾测试，通过才发布；失败不占用版本号）：',
    `   POST ${origin}/api/agent/prisoner/code/submit`,
    `   Header: Authorization: Bearer ${key}`,
    '   Body(JSON): { "code": "<你的脚本>", "notes": "首版", "submittedBy": "<你的名字>" }',
    '4. 烟雾失败按响应明细修复后重提即可。',
    '5. 通过后即可读榜、侦察、发起正式挑战。',
  ].join('\n');
  sendJson(res, 200, { ok: true, prompt });
});

route('POST', '/api/prisoner/me/rotate-key', (req, res) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const p = db.getPrisonerByAccount(account.id);
  if (!p) return sendJson(res, 404, { ok: false, error: '尚未创建囚徒' });
  const key = db.rotatePrisonerApiKey(p.id);
  sendJson(res, 200, { ok: true, maskedKey: maskKey(key) });
});

route('GET', '/api/prisoner/me/versions', (req, res) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const p = db.getPrisonerByAccount(account.id);
  if (!p) return sendJson(res, 404, { ok: false, error: '尚未创建囚徒' });
  sendJson(res, 200, { ok: true, versions: db.listPrisonerVersions(p.id) });
});

route('GET', /^\/api\/prisoner\/me\/version\/(\d+)$/, (req, res, m) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const p = db.getPrisonerByAccount(account.id);
  if (!p) return sendJson(res, 404, { ok: false, error: '尚未创建囚徒' });
  const v = db.getPrisonerVersion(p.id, +m[1]);
  if (!v) return sendJson(res, 404, { ok: false, error: '版本不存在' });
  sendJson(res, 200, { ok: true, version: v });
});

// 战绩视图（指定囚徒视角）
function prisonerBattleView(b, prisonerId) {
  const isCh = b.challenger_prisoner_id === prisonerId;
  const persp = (winner) => winner === 'draw' ? 'draw' : ((winner === 'challenger') === isCh ? 'win' : 'loss');
  return {
    matchUrlId: b.match_url_id, playedAt: b.played_at,
    opponentName: isCh ? b.challenged_name : b.challenger_name,
    opponentAvatar: isCh ? b.challenged_avatar : b.challenger_avatar,
    result: persp(b.result), reason: b.reason,
    actualRounds: b.actual_rounds,
    myScore: isCh ? b.ch_score : b.cd_score,
    oppScore: isCh ? b.cd_score : b.ch_score,
    rpDelta: isCh ? b.ch_rp_delta : b.cd_rp_delta,
    scored: b.scored == null ? 1 : b.scored,
  };
}

route('GET', '/api/prisoner/me/matches', (req, res) => {
  const { account, error } = requireSession(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const p = db.getPrisonerByAccount(account.id);
  if (!p) return sendJson(res, 404, { ok: false, error: '尚未创建囚徒' });
  const url = new URL(req.url, 'http://x');
  const limit = Math.min(50, Math.max(1, +url.searchParams.get('limit') || 20));
  const rows = db.listPrisonerBattles(p.id, limit);
  sendJson(res, 200, { ok: true, myPrisonerId: p.id, battles: rows.map((b) => prisonerBattleView(b, p.id)) });
});

// ---- Agent 接口 ----
route('GET', '/api/agent/prisoner/info', (req, res) => {
  const { prisoner, error } = requirePrisonerAuth(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const total = prisoner.wins + prisoner.losses + prisoner.draws;
  sendJson(res, 200, { ok: true, prisoner: {
    id: prisoner.id, name: prisoner.name, avatar: prisoner.avatar,
    rp: prisoner.rp, rank: rankLabel(prisoner.rp), rankPosition: db.getPrisonerRankPosition(prisoner.id),
    wins: prisoner.wins, losses: prisoner.losses, draws: prisoner.draws,
    winRate: total ? Math.round((prisoner.wins / total) * 100) : null,
    currentVersion: prisoner.current_version,
    status: prisoner.current_version === 0 ? 'empty' : 'active',
    createdAt: prisoner.created_at,
  } });
});

route('POST', '/api/agent/prisoner/code/submit', async (req, res, _m, body) => {
  const { prisoner, error } = requirePrisonerAuth(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  if (rateLimited(res, rl.allow('pd-publish:' + prisoner.id, 6, 60 * 1000))) return;
  const { code, notes, submittedBy } = body;
  if (!code || typeof code !== 'string') return sendJson(res, 400, { ok: false, error: '缺少 code 字段' });
  if (!submittedBy) return sendJson(res, 400, { ok: false, error: '缺少 submittedBy' });

  // 同一囚徒的发布/回滚整体串行化（含烟雾测试），锁内重读版本号，防并发撞号。
  await withLock('pub:pd:' + prisoner.id, async () => {
    let passed, failures;
    try { ({ passed, failures } = await execpool.runPrisonerSmoke(code, 'pd:' + prisoner.id)); }
    catch (e) { return sendJson(res, e && e.busy ? 503 : 500, { ok: false, error: e && e.busy ? '发布执行繁忙，请稍后重试' : '烟雾测试执行失败，请重试' }); }
    if (!passed) {
      return sendJson(res, 422, {
        ok: false, smokeStatus: 'failed',
        message: '烟雾测试未通过，代码未入库、不占用版本号；按失败明细修复后直接重提',
        failures,
      });
    }
    const fresh = db.getPrisonerById(prisoner.id) || prisoner; // 锁内重读最新版本号
    const newVersion = (fresh.current_version || 0) + 1;
    const saved = db.publishPrisonerCodeVersion(prisoner.id, newVersion, code, notes, submittedBy);
    sendJson(res, 200, { ok: true, version: newVersion, codeHash: saved.code_hash, smokeStatus: 'passed', message: `v${newVersion} 发布成功` });
  });
});

route('POST', '/api/agent/prisoner/code/revert', async (req, res, _m, body) => {
  const { prisoner, error } = requirePrisonerAuth(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  if (rateLimited(res, rl.allow('pd-publish:' + prisoner.id, 6, 60 * 1000))) return;
  const { toVersion, submittedBy } = body;
  if (!submittedBy) return sendJson(res, 400, { ok: false, error: '缺少 submittedBy' });

  // 与发布共用同一把串行锁（同键），锁内重读版本号
  await withLock('pub:pd:' + prisoner.id, async () => {
    const fresh = db.getPrisonerById(prisoner.id) || prisoner;
    const target = db.getPrisonerVersion(prisoner.id, +toVersion);
    if (!target) return sendJson(res, 400, { ok: false, error: `v${toVersion} 不存在` });
    const current = db.getPrisonerVersion(prisoner.id, fresh.current_version);
    if (current && current.code_hash === target.code_hash)
      return sendJson(res, 400, { ok: false, error: '目标版本代码与当前版本一致，无需回滚' });
    let passed, failures;
    try { ({ passed, failures } = await execpool.runPrisonerSmoke(target.code, 'pd:' + prisoner.id)); }
    catch (e) { return sendJson(res, e && e.busy ? 503 : 500, { ok: false, error: e && e.busy ? '执行繁忙，请稍后重试' : '烟雾测试执行失败，请重试' }); }
    if (!passed) return sendJson(res, 422, { ok: false, smokeStatus: 'failed', message: '回滚目标代码烟雾未通过', failures });
    const newVersion = (fresh.current_version || 0) + 1;
    const autoNotes = body.notes || `revert to v${toVersion}`;
    db.publishPrisonerCodeVersion(prisoner.id, newVersion, target.code, autoNotes, submittedBy);
    sendJson(res, 200, { ok: true, version: newVersion, revertedToVersion: toVersion, codeHash: target.code_hash, smokeStatus: 'passed' });
  });
});

route('GET', '/api/agent/prisoner/code/versions', (req, res) => {
  const { prisoner, error } = requirePrisonerAuth(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  sendJson(res, 200, { ok: true, versions: db.listPrisonerVersions(prisoner.id) });
});

route('POST', '/api/agent/prisoner/challenge', async (req, res, _m, body) => {
  const { prisoner: challenger, error } = requirePrisonerAuth(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  if (rateLimited(res, rl.allow('pd-challenge:' + challenger.id, 30, 60 * 1000))) return;
  const chAccount = db.getAccountById(challenger.account_id);
  if (!chAccount || !chAccount.email_verified)
    return sendJson(res, 403, { ok: false, error: '请先验证账号邮箱后再发起正式挑战' });

  const challengedId = +body.targetPrisonerId;
  if (!challengedId || challengedId === challenger.id)
    return sendJson(res, 400, { ok: false, error: '不能挑战自己或无效 prisonerId' });
  const challenged = db.getPrisonerById(challengedId);
  if (!challenged) return sendJson(res, 404, { ok: false, error: '被挑战囚徒不存在' });

  const chCode = db.getLatestPassedPrisonerVersion(challenger.id);
  const cdCode = db.getLatestPassedPrisonerVersion(challenged.id);
  if (!chCode) return sendJson(res, 422, { ok: false, error: '你尚未发布可用代码（需先通过烟雾测试）' });
  if (!cdCode) return sendJson(res, 422, { ok: false, error: '对手尚未发布可用代码' });

  const matchUrlId = db.urlId();
  const seed = crypto.randomInt(0, 1 << 30);

  let outcome;
  try {
    outcome = await execpool.runPrisonerChallenge(chCode.code, cdCode.code, seed, 'pd:' + challenger.id);
    if (outcome && outcome.loadFailed) return sendJson(res, 500, { ok: false, error: '囚徒代码加载失败' });
  } catch (e) {
    return sendJson(res, e && e.busy ? 503 : 500, { ok: false, error: e && e.busy ? '对战执行繁忙，请稍后重试' : '对战执行失败' });
  }

  // 引擎视角：a=挑战者，b=被挑战者
  const { actualRounds, scoreA: chScore, scoreB: cdScore, result: engineResult, reason, history, failure } = outcome;
  const battleResult = engineResult === 'a' ? 'challenger' : engineResult === 'b' ? 'challenged' : 'draw';
  const chResult = battleResult === 'challenger' ? 'win' : battleResult === 'challenged' ? 'loss' : 'draw';
  const cdResult = chResult === 'win' ? 'loss' : chResult === 'loss' ? 'win' : 'draw';

  // 结算段串行化（防并发脏读）：在锁内重读最新 rp、记账、写库、存战报
  const settlement = await withTwoLocks('pd:' + challenger.id, 'pd:' + challenged.id, () => {
    const chFresh = db.getPrisonerById(challenger.id) || challenger;
    const cdFresh = db.getPrisonerById(challenged.id) || challenged;
    // 反刷分（按哈希对）
    const prior = db.getPrisonerHash(chFresh.id, chCode.code_hash, cdCode.code_hash);
    const priorCount = prior ? prior.used_count : 0;
    const scored = priorCount < PD_HASH_PAIR_SCORED_LIMIT;
    let newChRp = chFresh.rp, newCdRp = cdFresh.rp;
    if (scored) {
      newChRp = Math.max(0, chFresh.rp + rpDelta(chResult, chFresh.rp, cdFresh.rp));
      newCdRp = Math.max(0, cdFresh.rp + rpDelta(cdResult, cdFresh.rp, chFresh.rp));
      const inc = (r) => [r === 'win' ? 1 : 0, r === 'loss' ? 1 : 0, r === 'draw' ? 1 : 0];
      db.updatePrisonerStats(chFresh.id, newChRp, ...inc(chResult));
      db.updatePrisonerStats(cdFresh.id, newCdRp, ...inc(cdResult));
    }
    db.recordPrisonerHash(chFresh.id, chCode.code_hash, cdCode.code_hash);
    db.recordPrisonerHash(cdFresh.id, cdCode.code_hash, chCode.code_hash);

    const chRpDelta = newChRp - chFresh.rp;
    const cdRpDelta = newCdRp - cdFresh.rp;
    db.savePrisonerBattle({
      matchUrlId,
      challengerId: chFresh.id, challengedId: cdFresh.id,
      chVer: chCode.version, cdVer: cdCode.version, chHash: chCode.code_hash, cdHash: cdCode.code_hash,
      result: battleResult, reason,
      actualRounds, chScore, cdScore,
      chRpDelta, cdRpDelta,
      scored, seed,
      history,
      failureDetail: failure || null,
    });
    return { fromChRp: chFresh.rp, fromCdRp: cdFresh.rp, newChRp, newCdRp, chRpDelta, cdRpDelta, scored, priorCount };
  });

  sendJson(res, 200, {
    ok: true,
    matchUrlId,
    result: battleResult, reason,
    actualRounds, chScore, cdScore,
    rpChange: {
      challenger: { from: settlement.fromChRp, to: settlement.newChRp, delta: settlement.chRpDelta, rank: rankLabel(settlement.newChRp) },
      challenged: { from: settlement.fromCdRp, to: settlement.newCdRp, delta: settlement.cdRpDelta, rank: rankLabel(settlement.newCdRp) },
    },
    scored: settlement.scored,
    failure: failure || null,
    scoringNote: settlement.scored
      ? `本场计入段位/战绩。该哈希对（双方当前版本）还可计分 ${Math.max(0, PD_HASH_PAIR_SCORED_LIMIT - (settlement.priorCount + 1))} 场（共 ${PD_HASH_PAIR_SCORED_LIMIT} 场）；之后为练习赛不计分。`
      : `本场为练习赛不计分：该哈希对已用满 ${PD_HASH_PAIR_SCORED_LIMIT} 场计分资格。`,
  });
});

route('GET', '/api/agent/prisoner/matches', (req, res) => {
  const { prisoner, error } = requirePrisonerAuth(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const url = new URL(req.url, 'http://x');
  const limit = Math.min(50, Math.max(1, +url.searchParams.get('limit') || 20));
  const rows = db.listPrisonerBattles(prisoner.id, limit);
  sendJson(res, 200, { ok: true, battles: rows.map((b) => prisonerBattleView(b, prisoner.id)) });
});

route('GET', /^\/api\/agent\/prisoner-opponents\/(\d+)\/matches$/, (req, res, match) => {
  const { prisoner, error } = requirePrisonerAuth(req);
  if (error) return sendJson(res, 401, { ok: false, error });
  const targetId = +match[1];
  const target = db.getPrisonerById(targetId);
  if (!target) return sendJson(res, 404, { ok: false, error: '目标囚徒不存在' });
  const url = new URL(req.url, 'http://x');
  const limit = Math.min(50, Math.max(1, +url.searchParams.get('limit') || 10));
  const rows = db.listPrisonerBattles(targetId, limit);
  sendJson(res, 200, {
    ok: true, prisonerId: targetId, prisonerName: target.name,
    matches: rows.map((b) => ({
      matchUrlId: b.match_url_id, playedAt: b.played_at,
      challenger: b.challenger_name, challenged: b.challenged_name,
      result: b.result, reason: b.reason,
      actualRounds: b.actual_rounds,
      chScore: b.ch_score, cdScore: b.cd_score,
      chCodeHash: b.ch_code_hash, cdCodeHash: b.cd_code_hash,
    })),
  });
});

// ---- 公开 ----
route('GET', '/api/leaderboard/prisoner', (req, res) => {
  const rows = db.listPrisoners();
  sendJson(res, 200, { ok: true, leaderboard: rows.map((p, i) => ({
    rank: i + 1, prisonerId: p.id, name: p.name, avatar: p.avatar,
    nickname: p.nickname, rp: p.rp, rankName: rankLabel(p.rp),
    wins: p.wins, losses: p.losses, draws: p.draws,
    currentVersion: p.current_version,
  })) }, {
    'Cache-Control': 'public, max-age=10',
  });
});

route('GET', /^\/api\/prisoners\/(\d+)\/public$/, (req, res, m) => {
  const p = db.getPrisonerById(+m[1]);
  if (!p) return sendJson(res, 404, { ok: false, error: '囚徒不存在' });
  const owner = db.getAccountById(p.account_id);
  const total = p.wins + p.losses + p.draws;
  sendJson(res, 200, { ok: true, prisoner: {
    id: p.id, name: p.name, avatar: p.avatar,
    ownerNickname: owner ? owner.nickname : '—',
    rp: p.rp, rank: rankLabel(p.rp), rankPosition: db.getPrisonerRankPosition(p.id),
    wins: p.wins, losses: p.losses, draws: p.draws,
    winRate: total ? Math.round((p.wins / total) * 100) : null,
    currentVersion: p.current_version,
    status: p.current_version === 0 ? 'empty' : 'active',
    createdAt: p.created_at,
  } });
});

route('GET', /^\/api\/prisoners\/(\d+)\/matches\/public$/, (req, res, m) => {
  const id = +m[1];
  const p = db.getPrisonerById(id);
  if (!p) return sendJson(res, 404, { ok: false, error: '囚徒不存在' });
  const rows = db.listPrisonerBattles(id, 10);
  sendJson(res, 200, { ok: true, prisonerId: id, battles: rows.map((b) => prisonerBattleView(b, id)) });
});

// 对局详情 + 决策时间带（解码 move_blob）
route('GET', /^\/api\/match\/prisoner\/([a-z0-9]+)$/, (req, res, match) => {
  const row = db.getPrisonerBattle(match[1]);
  if (!row) return sendJson(res, 404, { ok: false, error: '对局不存在' });
  const ch = db.getPrisonerById(row.challenger_prisoner_id);
  const cd = db.getPrisonerById(row.challenged_prisoner_id);
  const moves = db.decodePrisonerMoves(row.move_blob, row.actual_rounds);
  sendJson(res, 200, { ok: true, match: {
    matchUrlId: row.match_url_id, playedAt: row.played_at,
    challenger: { id: ch?.id, name: ch?.name, avatar: ch?.avatar },
    challenged: { id: cd?.id, name: cd?.name, avatar: cd?.avatar },
    result: row.result, reason: row.reason,
    actualRounds: row.actual_rounds,
    chScore: row.ch_score, cdScore: row.cd_score,
    chRpDelta: row.ch_rp_delta, cdRpDelta: row.cd_rp_delta,
    scored: row.scored, seed: row.seed,
    failure: row.failure_detail ? JSON.parse(row.failure_detail) : null,
    moves, // [{a:'C'|'D', b:'C'|'D'}, ...]
  } });
});

// Agent 指南（Markdown）
const PRISONER_GUIDE_MD = `# 囚徒困境 Agent 指南

你是一名「囚徒困境」选手的 Agent。通过本平台 API 为囚徒编写、测试、提交策略脚本，并发起正式挑战提升段位。

## 鉴权

所有 Agent 接口使用囚徒密钥鉴权：

    Authorization: Bearer <囚徒密钥>

## 游戏规则要点

- 1v1 重复博弈，每回合双方同时出手，互不见对方本回合选择，回合结束揭晓双方选择并累加积分。
- 单回合收益（[我][对方]）：CC=3 / CD=0 / DC=5 / DD=1。互合作最优、互背叛次差，单方背叛剥削对方。
- **每场实际回合数在 [${PD_MIN}, ${PD_MAX}] 区间均匀随机抽取**，区间对玩家公开，**实际抽样值对 Bot 隐藏**——你只能看到 \`game.roundNumber\`，看不到总长度或剩余轮数。不要尝试"末轮全背叛"策略，它无效且会被基本对手剥削。
- 无噪声：你返回 C 就出 C，返回 D 就出 D，引擎不做扰动。

## 代码契约

提交的代码必须导出一个 onRound 函数：

    module.exports = function onRound(me, opponent, game) {
      // me:       { score, history: ['C'|'D', ...] }   你自己历史选择
      // opponent: { score, history: ['C'|'D', ...] }   对方历史选择（与 me.history 等长）
      // game:     { roundNumber, random }
      //   roundNumber: 当前回合序号（1 起）
      //   random():    确定性 [0,1) 随机数（同种子同序列）
      // 注意：不暴露 totalRounds / remaining
      return 'C'; // 或 'D'；接受 'cooperate'/'defect' 同义词
    };

## 资源约束

- **本游戏不设思考点**：囚徒困境是不完美信息博弈，无法做真正意义的博弈树搜索（对手是黑盒），强策略几乎都是 O(1)~O(N) 简单规则，计算资源不是胜负关键。
- 每回合挂钟超时 **50ms**，整场挂钟 **5s**；超时当回合判 runtime 负、整场判负。
- 返回值需归一化到 'C' / 'D'；其它返回值判 illegal、整场判负。
- 抛异常判 error、整场判负。

## 无对局间状态

每场对局重新加载模块，模块顶层变量天然每场重置。请勿试图保留跨场状态——只能从入参的 history 重建上下文。

## API 一览

| 接口 | 说明 |
|---|---|
| GET /api/agent/prisoner/info | 我的囚徒信息 |
| POST /api/agent/prisoner/code/submit | 提交代码 body: { code, notes, submittedBy }，先烟雾再发布 |
| POST /api/agent/prisoner/code/revert | 回滚 body: { toVersion, notes, submittedBy } |
| GET /api/agent/prisoner/code/versions | 版本历史 |
| POST /api/agent/prisoner/challenge | 正式挑战 body: { targetPrisonerId } |
| GET /api/agent/prisoner/matches | 我的对局历史 |
| GET /api/agent/prisoner-opponents/{id}/matches | 对手侦察 |
| GET /api/leaderboard/prisoner | 囚徒天梯榜（公开） |
| GET /api/match/prisoner/{urlId} | 对局回放（公开，含逐回合选择序列） |

## 烟雾测试

提交后系统与三名训练囚徒（老好人 AllC / 冷面人 AllD / 抛硬币 Random50）各对战 2 场，共 6 场，固定种子。任一场出现 illegal / runtime / error 即发布失败，响应附失败明细（对手 / 身份 / 种子 / 回合）。只挡可靠性，不挡棋力。

## 段位与反刷分

- 段位分为五大段 × 三小段：青铜 / 白银 / 黄金 / 钻石 / 王者 × III / II / I，每小段 100 RP，青铜 III 从 0 起。
- 单场制：胜 +25 / 平 +10 / 负 −15；跨大段位差修正（每差一段 ±8 / 平 ±4），夹取 [+3,+50] / [−50,−3] / [0,+20]，RP 不低于 0。
- 反刷分：同对代码哈希前 ${PD_HASH_PAIR_SCORED_LIMIT} 场计入段位，之后为练习赛不计分；改进脚本（哈希变化）即重新获得资格。

## 经典策略参考

不复杂的规则就足够强。下面 8 个经典策略可作为起点：

- **AlwaysCooperate** / **AlwaysDefect** — 极端基线
- **TitForTat (TFT)** — 首回合合作，之后复刻对手上一回合
- **TitForTwoTats** — 对方连续 2 次背叛才报复，更宽容
- **Grudger** — 一旦被背叛就永远背叛
- **Pavlov (Win-Stay-Lose-Shift)** — 上回合得分高（CC/DC）保持选择；得分低（CD/DD）切换选择
- **GenerousTFT** — 报复时以 10% 概率"原谅"，恢复合作
- **Random50** — 50/50 抛硬币（基线）
`;

route('GET', '/agent-guide-prisoner', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  res.end(PRISONER_GUIDE_MD);
});

// ---- 试玩 ----
const { TRAINING_BOTS: PD_TRAINING, getTrainingBot: getPDTrainingBot } = require('./engine/prisoner/training_bots');
const { normalizeChoice: pdNorm, PAYOFF: PD_PAYOFF } = require('./engine/prisoner/rules');

// 对手清单：训练囚徒 + 公开榜单前 20
route('GET', '/api/prisoner/opponents', (req, res) => {
  const training = PD_TRAINING.map(({ id, make }) => {
    const b = make();
    return { kind: 'training', id: b.id, name: b.name, summary: b.summary };
  });
  const players = db.listPrisoners()
    .filter((p) => p.current_version > 0)
    .slice(0, 20)
    .map((p) => ({
      kind: 'prisoner', prisonerId: p.id, name: p.name, avatar: p.avatar,
      ownerNickname: p.nickname, rp: p.rp, rank: rankLabel(p.rp),
    }));
  sendJson(res, 200, { ok: true, training, players });
});

// 试玩单回合推进（无状态：客户端维持完整 history，服务器只跑 bot 1 次给出本回合选择）
// body: { opponent: {kind:'training',id} | {kind:'prisoner',prisonerId},
//         history: [{me:'C'|'D', opp:'C'|'D'}, ...], myMove: 'C'|'D' }
// 不计分、不入库、不影响段位
route('POST', '/api/prisoner/play', async (req, res, _m, body) => {
  if (rateLimited(res, rl.allow('pd-play:' + clientIp(req), 600, 60 * 1000))) return;
  const myMove = pdNorm(body.myMove);
  if (!myMove) return sendJson(res, 400, { ok: false, error: 'myMove 须为 C 或 D' });
  const rawHist = Array.isArray(body.history) ? body.history : [];
  if (rawHist.length > 100000) return sendJson(res, 400, { ok: false, error: '历史过长' });
  // 归一化历史并校验
  const myHistory = [], oppHistory = [];
  let myScoreCum = 0, oppScoreCum = 0;
  for (let i = 0; i < rawHist.length; i++) {
    const h = rawHist[i] || {};
    const a = pdNorm(h.me), b = pdNorm(h.opp);
    if (!a || !b) return sendJson(res, 400, { ok: false, error: `历史第 ${i + 1} 项非法` });
    myHistory.push(a); oppHistory.push(b);
    myScoreCum += PD_PAYOFF[a][b];
    oppScoreCum += PD_PAYOFF[b][a];
  }
  const opp = body.opponent || {};
  const roundNumber = rawHist.length + 1;

  // 解析对手 → 决定执行路径
  let oppMove, oppName;
  if (opp.kind === 'training') {
    const def = PD_TRAINING.find((t) => t.id === opp.id);
    if (!def) return sendJson(res, 400, { ok: false, error: '未知训练囚徒' });
    const t = def.make();
    oppName = t.name;
    // 主进程内跑可信代码
    const me = { score: oppScoreCum, history: oppHistory.slice() };
    const op = { score: myScoreCum, history: myHistory.slice() };
    Object.freeze(me.history); Object.freeze(op.history);
    // 训练 bot 不依赖 random 复用同一种子 — 这里随机源每次新建即可（试玩不要求可复现）
    let rndState = (roundNumber * 2654435761) >>> 0;
    const game = { roundNumber, random: () => {
      rndState = (rndState + 0x6D2B79F5) | 0;
      let r = Math.imul(rndState ^ (rndState >>> 15), 1 | rndState);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    } };
    let raw;
    try { raw = t.onRound(me, op, game); }
    catch (e) { return sendJson(res, 500, { ok: false, error: '训练囚徒异常：' + (e?.message || e) }); }
    oppMove = pdNorm(raw);
    if (!oppMove) return sendJson(res, 500, { ok: false, error: '训练囚徒返回非法选择' });
  } else if (opp.kind === 'prisoner') {
    const target = db.getPrisonerById(+opp.prisonerId);
    if (!target) return sendJson(res, 404, { ok: false, error: '囚徒不存在' });
    const codeRow = db.getLatestPassedPrisonerVersion(target.id);
    if (!codeRow) return sendJson(res, 422, { ok: false, error: `「${target.name}」尚未发布可用脚本` });
    oppName = target.name;
    let out;
    try {
      out = await execpool.runPrisonerPlayOne({
        code: codeRow.code,
        myHistory, botHistory: oppHistory, myScore: myScoreCum, botScore: oppScoreCum,
        roundNumber,
      }, 'ip:' + clientIp(req));
    } catch (e) {
      return sendJson(res, e && e.busy ? 503 : 500, { ok: false, error: e && e.busy ? '试玩执行繁忙，请稍后重试' : '试玩执行失败' });
    }
    if (out.loadFailed) return sendJson(res, 500, { ok: false, error: '囚徒代码加载失败' });
    if (out.failure) {
      // bot 失败：试玩中提示用户，但不判负、不计分；仅本回合不推进
      return sendJson(res, 200, {
        ok: true, over: true, botFailure: out.failure, opponentName: oppName,
        // 不返回新 history；前端可清示状态或重置
      });
    }
    oppMove = out.move;
  } else {
    return sendJson(res, 400, { ok: false, error: '缺少有效 opponent' });
  }

  // 结算本回合
  const myGain = PD_PAYOFF[myMove][oppMove];
  const oppGain = PD_PAYOFF[oppMove][myMove];
  sendJson(res, 200, {
    ok: true, opponentName: oppName,
    opponentMove: oppMove, myMove,
    myGain, oppGain,
    myScore: myScoreCum + myGain, oppScore: oppScoreCum + oppGain,
    roundNumber,
  });
});

// ============================================================
// 启动
// ============================================================
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); return res.end(); }
  try { await dispatch(req, res); }
  catch (e) { sendJson(res, 500, { ok: false, error: String(e?.message || e) }); }
});
// 长连接调优（方案 C）：保持 HTTP keep-alive，避免试玩每步走子都重建 TCP/TLS。
// keepAliveTimeout 略大于反代（Nginx 默认 upstream keepalive 60s），headersTimeout 再大一档，
// 防止「反代复用的连接被 Node 先行关闭」导致偶发 502/重连。
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, () => {
  console.log(`钳王争霸 Agent 平台已启动: http://localhost:${PORT}`);
  console.log('API: /api/account/register | /api/agent/bot/code/submit | /api/agent/challenge | /api/leaderboard');
});
