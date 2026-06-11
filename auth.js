'use strict';
// 鉴权工具：密码哈希（scrypt 加盐）+ 无状态签名 Cookie 会话（HMAC-SHA256）
// 零第三方依赖，仅用 Node 内置 crypto。
const crypto = require('crypto');

// 会话签名密钥：优先环境变量，否则启动时随机生成（重启即登出，demo 可接受）。
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'sx_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

// ---- 密码 ----
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}$${derived}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes('$')) return false;
  const [salt, derived] = stored.split('$');
  const candidate = crypto.scryptSync(password, salt, 32);
  const expected = Buffer.from(derived, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// ---- 签名 Cookie 会话 ----
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}
// 生成会话 token：payload = accountId|exp，附 HMAC 签名
function makeToken(accountId) {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${accountId}|${exp}`;
  return `${b64url(payload)}.${sign(payload)}`;
}
// 验签并取 accountId；失败返回 null
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  let payload;
  try { payload = Buffer.from(body, 'base64url').toString('utf8'); } catch { return null; }
  const expectedMac = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [accountIdStr, expStr] = payload.split('|');
  const exp = +expStr;
  if (!exp || Date.now() > exp) return null;
  const accountId = +accountIdStr;
  return Number.isInteger(accountId) ? accountId : null;
}

// ---- Cookie 解析 / 下发 ----
function parseCookies(req) {
  const header = req.headers['cookie'] || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
function sessionCookie(accountId) {
  const token = makeToken(accountId);
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
// 从请求取已登录 accountId（无效/未登录返回 null）
function sessionAccountId(req) {
  return verifyToken(parseCookies(req)[COOKIE_NAME]);
}

module.exports = {
  COOKIE_NAME,
  hashPassword, verifyPassword,
  parseCookies, sessionCookie, clearCookie, sessionAccountId,
};
