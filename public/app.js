'use strict';
// 前端 JS：登录态 + 我的棋手/详情 + 公开棋手页 + 人机试玩 + 回放 + 天梯
const $ = (id) => document.getElementById(id);
const SIDE_LABEL = { black: '黑方', red: '红方', draw: '和棋' };
const REASON_LABEL = { eliminated:'≤1子判负', material:'20手子力裁定', stalemate:'互停子力裁定', draw:'平局', illegal:'非法走法判负', runtime:'思考点超额判负', error:'运行异常判负' };
const SMOKE_LABEL = { passed: '已通过', failed: '未通过', pending: '测试中' };

let ME = null; // { account, hasBot, bot } | null

// 开局布局（与引擎 initBoard 一致）
function initialBoard() {
  const b = Array.from({ length: 4 }, () => Array(4).fill(null));
  for (const [x, y] of [[0,3],[1,3],[2,3],[3,3],[0,2],[3,2]]) b[x][y] = 'black';
  for (const [x, y] of [[0,0],[1,0],[2,0],[3,0],[0,1],[3,1]]) b[x][y] = 'red';
  return b;
}

// ============================================================
// 段位
// ============================================================
const RANK_TIERS = ['青铜', '白银', '黄金', '钻石', '王者'];
function rankLabel(rp) {
  const idx = Math.min(14, Math.floor(Math.max(0, rp || 0) / 100));
  return `${RANK_TIERS[Math.floor(idx / 3)]} ${['III', 'II', 'I'][idx % 3]}`;
}

// ============================================================
// 通用工具
// ============================================================
async function apiFetch(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  let json; try { json = await res.json(); } catch { json = { ok: false, error: 'HTTP ' + res.status }; }
  json.__status = res.status;
  return json;
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
let toastTimer = null;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
}
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
document.querySelectorAll('.modal-mask').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); }));

function popup({ icon = '✉', title, text, actions }) {
  $('popupIcon').textContent = icon; $('popupTitle').textContent = title; $('popupText').textContent = text || '';
  const box = $('popupActions'); box.innerHTML = '';
  (actions || [{ label: '知道了', primary: true }]).forEach((a) => {
    const btn = document.createElement('button'); btn.textContent = a.label; if (a.primary) btn.className = 'primary';
    btn.addEventListener('click', () => { closeModal('popupModal'); a.onClick && a.onClick(); });
    box.appendChild(btn);
  });
  openModal('popupModal');
}

// 复制：clipboard API → textarea+execCommand 降级 → 最后弹窗
async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg); return true; } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'absolute'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) { toast(okMsg); return true; }
  } catch {}
  popup({ icon: '📋', title: '请手动复制', text: text });
  return false;
}

// ============================================================
// 棋子图标：黑色梭子蟹（黑方）/ 红色龙虾（红方）
// ============================================================
function tokenSvg(side) {
  if (side === 'black') {
    return `<svg viewBox="0 0 40 40">
      <g stroke="#34424c" stroke-width="2" stroke-linecap="round">
        <line x1="7" y1="20" x2="12" y2="23"/><line x1="5" y1="26" x2="11" y2="27"/><line x1="7" y1="32" x2="12" y2="30"/>
        <line x1="33" y1="20" x2="28" y2="23"/><line x1="35" y1="26" x2="29" y2="27"/><line x1="33" y1="32" x2="28" y2="30"/>
        <line x1="12" y1="15" x2="15" y2="18"/><line x1="28" y1="15" x2="25" y2="18"/>
      </g>
      <circle cx="10" cy="11" r="4.5" fill="#5d7282"/><path d="M7 8 L10 11 L6 12 Z" fill="#eaf6ff"/>
      <circle cx="30" cy="11" r="4.5" fill="#5d7282"/><path d="M33 8 L30 11 L34 12 Z" fill="#eaf6ff"/>
      <ellipse cx="20" cy="24" rx="12" ry="8.5" fill="#4a5a66"/>
      <circle cx="16" cy="21" r="1.9" fill="#fff"/><circle cx="24" cy="21" r="1.9" fill="#fff"/>
      <circle cx="16.4" cy="21.3" r="0.9" fill="#2f4858"/><circle cx="24.4" cy="21.3" r="0.9" fill="#2f4858"/>
      <path d="M16 28 q4 2.5 8 0" stroke="#34424c" stroke-width="1.5" fill="none" stroke-linecap="round"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 40 40">
    <g stroke="#a8281c" stroke-width="1.8" stroke-linecap="round" fill="none">
      <path d="M16 8 q-4 -4 -9 -4"/><path d="M24 8 q4 -4 9 -4"/>
      <line x1="14" y1="20" x2="9" y2="18"/><line x1="14" y1="24" x2="9" y2="24"/>
      <line x1="26" y1="20" x2="31" y2="18"/><line x1="26" y1="24" x2="31" y2="24"/>
    </g>
    <ellipse cx="11" cy="11" rx="4" ry="5" fill="#e34d3c" transform="rotate(-25 11 11)"/>
    <path d="M9 6.5 L11 10 L6.5 10.5 Z" fill="#fde8e0"/>
    <ellipse cx="29" cy="11" rx="4" ry="5" fill="#e34d3c" transform="rotate(25 29 11)"/>
    <path d="M31 6.5 L29 10 L33.5 10.5 Z" fill="#fde8e0"/>
    <path d="M20 10 q7 0 7 8.5 q0 8.5 -7 8.5 q-7 0 -7 -8.5 q0 -8.5 7 -8.5 Z" fill="#d9483b"/>
    <path d="M14.5 20 h11 M15 24 h10" stroke="#a8281c" stroke-width="1.4" stroke-linecap="round"/>
    <circle cx="17" cy="15" r="1.5" fill="#fff"/><circle cx="23" cy="15" r="1.5" fill="#fff"/>
    <circle cx="17.3" cy="15.3" r="0.8" fill="#5a120b"/><circle cx="23.3" cy="15.3" r="0.8" fill="#5a120b"/>
    <path d="M20 26 L13 36 q7 -3.5 7 -3.5 t7 3.5 Z" fill="#e34d3c" stroke="#a8281c" stroke-width="1.4" stroke-linejoin="round"/>
  </svg>`;
}
function miniIcon(side) { return `<span class="mini-icon">${tokenSvg(side)}</span>`; }

// ============================================================
// 头像（6 款像素预设）
// ============================================================
function presetSvg(n) {
  const s = {
    1: `<rect width="40" height="40" fill="#cdeffb"/><rect x="14" y="14" width="12" height="12" fill="#ffd45e"/><rect x="18" y="6" width="4" height="5" fill="#ffb13b"/><rect x="18" y="29" width="4" height="5" fill="#ffb13b"/><rect x="6" y="18" width="5" height="4" fill="#ffb13b"/><rect x="29" y="18" width="5" height="4" fill="#ffb13b"/>`,
    2: `<rect width="40" height="40" fill="#e7f7ea"/><path d="M6 34 A20 20 0 0 1 34 34 Z" fill="#ff8a73"/><path d="M6 34 A20 20 0 0 1 34 34" fill="none" stroke="#7cc46a" stroke-width="4"/><rect x="15" y="24" width="2" height="2" fill="#2f4858"/><rect x="22" y="22" width="2" height="2" fill="#2f4858"/><rect x="19" y="28" width="2" height="2" fill="#2f4858"/>`,
    3: `<rect width="40" height="40" fill="#d9f0ff"/><path d="M0 26 q6 -8 12 0 t12 0 t12 0 v14 H0 Z" fill="#5bb8e8"/><path d="M0 30 q6 -7 12 0 t12 0 t12 0" fill="none" stroke="#fff" stroke-width="3"/>`,
    4: `<rect width="40" height="40" fill="#fff3da"/><rect x="18" y="18" width="4" height="18" fill="#b07a3c"/><path d="M20 6 q-14 2 -16 12 q12 -4 16 2 q4 -6 16 -2 q-2 -10 -16 -12 Z" fill="#3fb39e"/>`,
    5: `<rect width="40" height="40" fill="#fdeaf1"/><path d="M14 16 h12 l-6 18 Z" fill="#f4c08a"/><circle cx="20" cy="14" r="7" fill="#ff9ec2"/><circle cx="15" cy="14" r="6" fill="#fff0a8"/><circle cx="25" cy="14" r="6" fill="#a8e6c2"/>`,
    6: `<rect width="40" height="40" fill="#eef0f3"/><circle cx="15" cy="22" r="8" fill="#4a5a66"/><circle cx="13" cy="19" r="2.5" fill="#7d8b95"/><rect x="22" y="9" width="5" height="24" rx="2.5" fill="#e0a557" transform="rotate(18 24 21)"/>`,
  }[n] || '';
  return `<svg viewBox="0 0 40 40">${s}</svg>`;
}
function avatarHtml(avatar) {
  if (typeof avatar === 'string' && avatar.startsWith('upload:'))
    return `<img src="/avatars/${esc(avatar.slice(7))}" alt="头像" />`;
  const n = typeof avatar === 'string' && avatar.startsWith('preset:') ? +avatar.slice(7) : 1;
  return presetSvg(n);
}

// ============================================================
// 登录态
// ============================================================
async function refreshMe() {
  const r = await apiFetch('GET', '/api/me');
  ME = r.ok ? r : null;
  renderAuthState();
  return ME;
}
function renderAuthState() {
  const el = $('authState');
  if (ME && ME.account) {
    el.innerHTML = `<span class="who">${avatarBadge()}${esc(ME.account.nickname)}</span><button class="mini" id="logoutBtn">登出</button>`;
    $('logoutBtn').addEventListener('click', async () => { await apiFetch('POST', '/api/auth/logout'); await refreshMe(); showTab('play'); toast('已登出'); });
  } else {
    el.innerHTML = `<button class="primary mini" id="openRegisterBtn">注册</button><button class="mini" id="openLoginBtn">登录</button>`;
    $('openRegisterBtn').addEventListener('click', () => openAuth('register'));
    $('openLoginBtn').addEventListener('click', () => openAuth('login'));
  }
}
function avatarBadge() {
  if (!ME || !ME.bot) return '';
  return `<span style="width:24px;height:24px;border-radius:7px;overflow:hidden;display:inline-block;vertical-align:middle">${avatarHtml(ME.bot.avatar)}</span>`;
}

// ============================================================
// Tab 切换（含登录守卫）
// ============================================================
function showTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  const panel = $('tab-' + name); if (panel) panel.classList.add('active');
  if (name === 'leaderboard') loadLeaderboard();
  if (name === 'mybot') renderMyBot();
}
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.tab;
    if (name === 'mybot' && !(ME && ME.account)) { openAuth('register'); return; }
    showTab(name);
  });
});

// ============================================================
// 注册 / 登录 弹窗
// ============================================================
function openAuth(mode) {
  $('authRegister').classList.toggle('hidden', mode !== 'register');
  $('authLogin').classList.toggle('hidden', mode === 'register');
  $('authTitle').textContent = mode === 'register' ? '注册账号' : '登录';
  openModal('authModal');
}
$('toLogin').addEventListener('click', () => openAuth('login'));
$('toRegister').addEventListener('click', () => openAuth('register'));

function validateRegister() {
  const pw = $('reg-pw').value, pw2 = $('reg-pw2').value;
  const errEl = $('err-pw2');
  if (pw2 && pw !== pw2) { errEl.textContent = '两次密码不一致'; errEl.classList.remove('ok'); }
  else if (pw2 && pw === pw2) { errEl.textContent = '密码一致 ✓'; errEl.classList.add('ok'); }
  else { errEl.textContent = ''; }
  const ready = $('reg-nick').value.trim() && $('reg-email').value.trim() && pw.length >= 8 && pw === pw2;
  $('regBtn').disabled = !ready;
}
['reg-nick','reg-email','reg-pw','reg-pw2'].forEach((id) => $(id).addEventListener('input', () => { validateRegister(); if (id === 'reg-nick') $('err-nick').textContent = ''; }));

$('regBtn').addEventListener('click', async () => {
  const body = { nickname: $('reg-nick').value.trim(), email: $('reg-email').value.trim(), password: $('reg-pw').value };
  const r = await apiFetch('POST', '/api/account/register', body);
  if (r.ok) { closeModal('authModal'); await refreshMe(); showTab('mybot'); toast('注册成功，来创建棋手吧'); return; }
  if (r.field === 'nickname') { $('err-nick').textContent = r.error; return; }
  if (r.field === 'email') {
    popup({ icon: '✉', title: '该邮箱已注册', text: '你可以直接登录，或换一个邮箱注册新账号。', actions: [
      { label: '去登录', primary: true, onClick: () => openAuth('login') },
      { label: '换个邮箱', onClick: () => { openModal('authModal'); $('reg-email').focus(); } },
    ] });
    return;
  }
  $('err-pw2').textContent = r.error || '注册失败'; $('err-pw2').classList.remove('ok');
});

$('loginBtn').addEventListener('click', async () => {
  const body = { email: $('login-email').value.trim(), password: $('login-pw').value };
  const r = await apiFetch('POST', '/api/auth/login', body);
  if (r.ok) { closeModal('authModal'); await refreshMe(); showTab('mybot'); toast('欢迎回来'); return; }
  $('err-login').textContent = r.error || '登录失败';
});

// ============================================================
// 我的棋手
// ============================================================
function renderMyBot() {
  const box = $('mybotBody');
  if (!(ME && ME.account)) { box.innerHTML = '<div class="empty-hero"><h2>请先登录</h2><p>登录后即可创建并管理你的棋手。</p></div>'; return; }
  if (!ME.hasBot) {
    box.innerHTML = `<div class="empty-hero"><h2>你还没有棋手</h2><p>创建一名棋手，拿到它的棋手密钥，交给你的 Agent 来编写策略。</p><button class="primary" id="createBotOpen">创建棋手 →</button></div>`;
    $('createBotOpen').addEventListener('click', openCreateBot);
    return;
  }
  const b = ME.bot;
  const empty = b.currentVersion === 0;
  box.innerHTML = `
    <div class="bot-card">
      <div class="av">${avatarHtml(b.avatar)}</div>
      <div class="grow">
        <h2>${esc(b.name)} ${empty ? '<span class="chip empty">空脚本</span>' : '<span class="chip active">可对战</span>'} <span class="chip ver">v${b.currentVersion}</span></h2>
        <div class="stat-row"><span>${rankLabel(b.rp)} · 段位分 ${b.rp || 0} · 天梯排名 ${b.rankPosition ? '#' + b.rankPosition : '—'}</span></div>
        ${empty ? '<div class="warn-box" style="margin-top:10px">脚本为空，棋手尚不能对战 —— 进入详情，复制 Prompt 交给 Agent 提交首个版本。</div>' : ''}
      </div>
      <div class="actions"><button class="primary" id="goDetail">详情</button></div>
    </div>`;
  $('goDetail').addEventListener('click', () => showDetail());
}

// ============================================================
// 创建棋手 + 头像选择
// ============================================================
let selectedAvatar = 'preset:1';
let pendingUploadDataUrl = null;
let avatarMode = 'create';

function renderAvatarPicker() {
  const box = $('avatarPicker'); box.innerHTML = '';
  for (let n = 1; n <= 6; n++) {
    const tile = document.createElement('div');
    tile.className = 'av-tile' + (selectedAvatar === 'preset:' + n ? ' sel' : '');
    tile.innerHTML = presetSvg(n) + (selectedAvatar === 'preset:' + n ? '<span class="check">✓</span>' : '');
    tile.addEventListener('click', () => onPickPreset(n));
    box.appendChild(tile);
  }
  if (pendingUploadDataUrl) {
    const tile = document.createElement('div');
    tile.className = 'av-tile' + (selectedAvatar === 'upload' ? ' sel' : '');
    tile.style.gridColumn = 'span 2';
    tile.innerHTML = `<img src="${pendingUploadDataUrl}" alt="自定义" />` + (selectedAvatar === 'upload' ? '<span class="check">✓</span>' : '');
    tile.addEventListener('click', () => { selectedAvatar = 'upload'; renderAvatarPicker(); });
    box.appendChild(tile);
  }
  const up = document.createElement('div');
  up.className = 'av-upload'; up.innerHTML = '<span style="font-size:20px">⬆</span><span>上传头像<br>PNG/JPG · 1:1 · ≤100KB</span>';
  up.addEventListener('click', () => $('avatarFile').click());
  box.appendChild(up);
}
async function onPickPreset(n) {
  selectedAvatar = 'preset:' + n; pendingUploadDataUrl = null;
  renderAvatarPicker();
  if (avatarMode === 'edit') {
    const r = await apiFetch('POST', '/api/bot/me/avatar/preset', { preset: n });
    if (r.ok) { await refreshMe(); toast('头像已更新'); closeModal('createBotModal'); showDetail(); }
    else toast(r.error || '更新失败');
  }
}

function openCreateBot() {
  avatarMode = 'create'; selectedAvatar = 'preset:1'; pendingUploadDataUrl = null;
  $('bot-name').value = ''; $('err-botname').textContent = '';
  $('bot-name').closest('.field').classList.remove('hidden');
  $('createBotBtn').classList.remove('hidden');
  document.querySelector('#createBotModal h2').textContent = '创建棋手';
  renderAvatarPicker(); openModal('createBotModal');
}
function openAvatarEditor() {
  avatarMode = 'edit'; pendingUploadDataUrl = null;
  selectedAvatar = (ME && ME.bot && ME.bot.avatar.startsWith('preset:')) ? ME.bot.avatar : 'preset:1';
  $('bot-name').closest('.field').classList.add('hidden');
  $('createBotBtn').classList.add('hidden');
  document.querySelector('#createBotModal h2').textContent = '更换头像';
  renderAvatarPicker(); openModal('createBotModal');
}

$('createBotBtn').addEventListener('click', async () => {
  const name = $('bot-name').value.trim();
  if (!name) { $('err-botname').textContent = '请填写棋手名称'; return; }
  const presetForCreate = selectedAvatar === 'upload' ? 'preset:1' : selectedAvatar;
  const r = await apiFetch('POST', '/api/bot/create', { name, avatar: presetForCreate });
  if (!r.ok) { $('err-botname').textContent = r.error || '创建失败'; return; }
  if (pendingUploadDataUrl) await apiFetch('POST', '/api/bot/me/avatar', { dataUrl: pendingUploadDataUrl });
  closeModal('createBotModal'); await refreshMe(); showDetail(); toast('棋手已创建');
});

$('avatarFile').addEventListener('change', (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  if (!['image/png','image/jpeg'].includes(file.type)) { toast('仅支持 PNG / JPG'); return; }
  const reader = new FileReader();
  reader.onload = () => { const img = new Image(); img.onload = () => openCropper(img); img.src = reader.result; };
  reader.readAsDataURL(file);
});

// ---- 方形裁剪器 ----
const crop = { img: null, base: 1, zoom: 1, x: 0, y: 0, dragging: false, lx: 0, ly: 0 };
function drawCrop() {
  const cv = $('cropCanvas'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, 256, 256);
  if (!crop.img) return;
  const s = crop.base * crop.zoom, w = crop.img.width * s, h = crop.img.height * s;
  ctx.drawImage(crop.img, crop.x, crop.y, w, h);
}
function clampCrop() {
  const s = crop.base * crop.zoom, w = crop.img.width * s, h = crop.img.height * s;
  crop.x = Math.min(0, Math.max(256 - w, crop.x));
  crop.y = Math.min(0, Math.max(256 - h, crop.y));
}
function openCropper(img) {
  crop.img = img; crop.zoom = 1;
  crop.base = Math.max(256 / img.width, 256 / img.height);
  const w = img.width * crop.base, h = img.height * crop.base;
  crop.x = (256 - w) / 2; crop.y = (256 - h) / 2;
  $('cropZoom').value = 100;
  openModal('cropModal'); drawCrop();
}
const cv = $('cropCanvas');
cv.addEventListener('pointerdown', (e) => { crop.dragging = true; crop.lx = e.offsetX; crop.ly = e.offsetY; cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointermove', (e) => { if (!crop.dragging) return; crop.x += e.offsetX - crop.lx; crop.y += e.offsetY - crop.ly; crop.lx = e.offsetX; crop.ly = e.offsetY; clampCrop(); drawCrop(); });
cv.addEventListener('pointerup', () => { crop.dragging = false; });
$('cropZoom').addEventListener('input', (e) => { crop.zoom = +e.target.value / 100; clampCrop(); drawCrop(); });
$('cropConfirm').addEventListener('click', async () => {
  let dataUrl = $('cropCanvas').toDataURL('image/png');
  if (dataUrl.length * 0.75 > 100 * 1024) dataUrl = $('cropCanvas').toDataURL('image/jpeg', 0.85);
  pendingUploadDataUrl = dataUrl; selectedAvatar = 'upload';
  closeModal('cropModal'); renderAvatarPicker();
  if (avatarMode === 'edit') {
    const r = await apiFetch('POST', '/api/bot/me/avatar', { dataUrl });
    if (r.ok) { await refreshMe(); toast('头像已更新'); closeModal('createBotModal'); showDetail(); }
    else toast(r.error || '更新失败');
  }
});

// ============================================================
// 棋手详情（自己）
// ============================================================
async function showDetail() {
  showTab('detail');
  const box = $('detailBody'); box.innerHTML = '<div class="muted-center">加载中…</div>';
  const r = await apiFetch('GET', '/api/bot/me');
  if (!r.ok) { box.innerHTML = `<div class="muted-center">${esc(r.error)}</div>`; return; }
  const b = r.bot;
  const empty = b.status === 'empty';
  box.innerHTML = `
    <div class="detail-head">
      <div class="av">${avatarHtml(b.avatar)}</div>
      <div><h2>${esc(b.name)}</h2><div class="muted">当前工作版本：v${b.currentVersion}${empty ? '（空脚本）' : ''}</div></div>
      <div style="margin-left:auto"><button class="mini" id="editAvatarBtn">更换头像</button></div>
    </div>
    <div class="detail-grid">
      <div class="card">
        <h3>概览</h3>
        <div class="ov-row"><span>段位</span><b>${esc(b.rank)}</b></div>
        <div class="ov-row"><span>段位分</span><b>${b.rp}</b></div>
        <div class="ov-row"><span>当前排名</span><b>#${b.rankPosition || '—'}</b></div>
        <div class="ov-row"><span>胜率</span><b>${b.winRate == null ? '—' : b.winRate + '%'}</b></div>
        <div class="ov-row"><span>战绩</span><b>${b.wins}-${b.losses}-${b.draws}</b></div>
        <div class="ov-row"><span>当前版本</span><b>v${b.currentVersion}</b></div>
        <div class="ov-row"><span>状态</span>${empty ? '<span class="chip empty">待提交脚本</span>' : '<span class="chip active">可对战</span>'}</div>
      </div>
      <div class="card">
        <h3>Agent 接入</h3>
        <p class="muted" style="margin-top:0">用「Agent 指南 + 棋手密钥」让你的 Agent 阅读规则、编写并提交这名棋手的脚本。</p>
        <div class="access-row"><span class="lbl">棋手密钥</span><span class="val">${esc(b.maskedKey)}</span></div>
        <div class="access-row"><span class="lbl">Agent 指南</span><span class="val"><a href="/agent-guide" target="_blank">/agent-guide</a></span></div>
        <div class="access-actions">
          <button class="primary" id="copyPromptBtn">📋 一键复制 Agent Prompt</button>
          <button class="secondary" id="rotateKeyBtn">轮换密钥</button>
        </div>
      </div>
    </div>
    <div class="subtabs">
      <button class="subtab active" data-sub="versions">版本</button>
      <button class="subtab" data-sub="matches">对战记录</button>
    </div>
    <div id="subBody"></div>`;

  $('editAvatarBtn').addEventListener('click', openAvatarEditor);
  $('copyPromptBtn').addEventListener('click', async () => {
    const p = await apiFetch('GET', '/api/bot/me/prompt');
    if (!p.ok) return toast(p.error || '获取失败');
    copyText(p.prompt, '复制成功，粘贴并发送给你的 Agent 即可。');
  });
  $('rotateKeyBtn').addEventListener('click', () => popup({ icon: '🔑', title: '轮换密钥？', text: '旧密钥会立即失效，需重新复制 Prompt 给 Agent。', actions: [
    { label: '确认轮换', primary: true, onClick: async () => { const r2 = await apiFetch('POST', '/api/bot/me/rotate-key'); if (r2.ok) { toast('密钥已轮换'); showDetail(); } else toast(r2.error || '失败'); } },
    { label: '取消' },
  ] }));
  box.querySelectorAll('.subtab').forEach((s) => s.addEventListener('click', () => {
    box.querySelectorAll('.subtab').forEach((x) => x.classList.toggle('active', x === s));
    s.dataset.sub === 'versions' ? loadVersions() : loadMyMatches();
  }));
  loadVersions();
}

async function loadVersions() {
  const box = $('subBody'); box.innerHTML = '<div class="muted-center">加载中…</div>';
  const r = await apiFetch('GET', '/api/bot/me/versions');
  if (!r.ok) { box.innerHTML = `<div class="muted-center">${esc(r.error)}</div>`; return; }
  if (!r.versions.length) { box.innerHTML = '<div class="muted-center">还没有版本 —— 复制 Prompt 让 Agent 提交首个脚本。</div>'; return; }
  box.innerHTML = r.versions.map((v) => `
    <div class="ver-row">
      <div class="grow">
        <b>v${v.version}</b> <span class="chip ${v.smoke_status}">${SMOKE_LABEL[v.smoke_status] || v.smoke_status}</span>
        <div class="vmeta">${esc(v.notes || '（无说明）')} · 提交者 ${esc(v.submitted_by || '—')} · ${new Date(v.created_at).toLocaleString()}</div>
      </div>
      <button class="mini" data-ver="${v.version}">查看脚本</button>
    </div>`).join('');
  box.querySelectorAll('[data-ver]').forEach((b) => b.addEventListener('click', () => viewCode(+b.dataset.ver)));
}
async function viewCode(version) {
  const r = await apiFetch('GET', '/api/bot/me/version/' + version);
  if (!r.ok) return toast(r.error || '读取失败');
  $('codeTitle').textContent = `脚本 v${version}`;
  $('codeBody').textContent = r.version.code;
  $('codeCopy').onclick = () => copyText(r.version.code, '已复制');
  openModal('codeModal');
}
async function loadMyMatches() {
  const box = $('subBody'); box.innerHTML = '<div class="muted-center">加载中…</div>';
  const r = await apiFetch('GET', '/api/bot/me/matches');
  if (!r.ok) { box.innerHTML = `<div class="muted-center">${esc(r.error)}</div>`; return; }
  if (!r.matches.length) { box.innerHTML = '<div class="muted-center">还没有正式对战记录。</div>'; return; }
  const mine = r.myBotId;
  box.innerHTML = r.matches.map((m) => {
    const iAmCh = m.challenger_bot_id === mine;
    const opp = iAmCh ? m.challenged_name : m.challenger_name;
    const meWon = (m.winner === 'challenger' && iAmCh) || (m.winner === 'challenged' && !iAmCh);
    const res = m.winner === 'draw' ? '平' : (meWon ? '胜' : '负');
    const cls = m.winner === 'draw' ? 'pending' : (meWon ? 'passed' : 'failed');
    return `<div class="match-row">
      <span class="chip ${cls}">${res}</span>
      <div class="grow"><b>vs ${esc(opp)}</b><div class="vmeta">${REASON_LABEL[m.reason] || m.reason} · ${m.turns} 手 · ${new Date(m.played_at).toLocaleString()}</div></div>
      <button class="mini" data-url="${m.match_url_id}">回放</button>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-url]').forEach((b) => b.addEventListener('click', () => replaySavedMatch(b.dataset.url)));
}

// ============================================================
// 公开棋手详情页（他人）
// ============================================================
async function showPublicBot(botId) {
  showTab('publicbot');
  const box = $('publicBody'); box.innerHTML = '<div class="muted-center">加载中…</div>';
  const [info, ms] = await Promise.all([
    apiFetch('GET', `/api/bots/${botId}/public`),
    apiFetch('GET', `/api/bots/${botId}/matches/public`),
  ]);
  if (!info.ok) { box.innerHTML = `<div class="muted-center">${esc(info.error)}</div>`; return; }
  const b = info.bot;
  const matches = ms.ok ? ms.matches : [];
  box.innerHTML = `
    <div class="detail-head">
      <div class="av">${avatarHtml(b.avatar)}</div>
      <div>
        <h2>${esc(b.name)}</h2>
        <div class="muted">玩家 ${esc(b.ownerNickname)} · ${b.status === 'empty' ? '待提交脚本' : '可对战'}</div>
      </div>
      <div style="margin-left:auto"><button class="mini" id="backToLb">← 返回天梯榜</button></div>
    </div>
    <div class="detail-grid">
      <div class="card">
        <h3>概览</h3>
        <div class="ov-row"><span>段位</span><b>${esc(b.rank)}</b></div>
        <div class="ov-row"><span>段位分</span><b>${b.rp}</b></div>
        <div class="ov-row"><span>当前排名</span><b>#${b.rankPosition || '—'}</b></div>
        <div class="ov-row"><span>胜率</span><b>${b.winRate == null ? '—' : b.winRate + '%'}</b></div>
        <div class="ov-row"><span>战绩</span><b>${b.wins}-${b.losses}-${b.draws}</b></div>
        <div class="ov-row"><span>当前版本</span><b>v${b.currentVersion}</b></div>
      </div>
      <div class="card">
        <h3>最近对战（${matches.length}）</h3>
        <div id="pubMatches">${matches.length ? '' : '<div class="muted-center">还没有正式对战记录。</div>'}</div>
      </div>
    </div>`;
  $('backToLb').addEventListener('click', () => showTab('leaderboard'));
  const list = $('pubMatches');
  if (matches.length) {
    list.innerHTML = matches.map((m) => {
      const opp = m.isChallenger ? m.challengedName : m.challengerName;
      const won = (m.winner === 'challenger' && m.isChallenger) || (m.winner === 'challenged' && !m.isChallenger);
      const res = m.winner === 'draw' ? '平' : (won ? '胜' : '负');
      const cls = m.winner === 'draw' ? 'pending' : (won ? 'passed' : 'failed');
      return `<div class="match-row" style="box-shadow:none;border:1.5px solid var(--line);margin-bottom:8px">
        <span class="chip ${cls}">${res}</span>
        <div class="grow"><b>vs ${esc(opp)}</b><div class="vmeta">${REASON_LABEL[m.reason] || m.reason} · ${m.turns} 手 · ${new Date(m.playedAt).toLocaleString()}</div></div>
        <button class="mini" data-url="${m.matchUrlId}">回放</button>
      </div>`;
    }).join('');
    list.querySelectorAll('[data-url]').forEach((btn) => btn.addEventListener('click', () => replaySavedMatch(btn.dataset.url)));
  }
}

// ============================================================
// 天梯
// ============================================================
async function loadLeaderboard() {
  const tbody = $('lbBody');
  tbody.innerHTML = '<tr><td colspan="7" class="muted-center">加载中…</td></tr>';
  try {
    const data = await apiFetch('GET', '/api/leaderboard');
    if (!data.ok) throw new Error(data.error);
    tbody.innerHTML = data.leaderboard.map((b) => `
      <tr class="rank-${b.rank}">
        <td>${b.rank}</td>
        <td><div class="lb-name"><span style="width:28px;height:28px;border-radius:8px;overflow:hidden;display:inline-block">${avatarHtml(b.avatar)}</span>${esc(b.name)}</div></td>
        <td>${esc(b.nickname)}</td>
        <td><span class="chip rank-chip">${esc(b.rankName)}</span></td>
        <td><b>${b.rp}</b></td>
        <td>${b.wins}胜 / ${b.losses}负 / ${b.draws}平</td>
        <td><button class="mini" data-bot="${b.botId}">详情</button></td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted-center">暂无棋手</td></tr>';
    tbody.querySelectorAll('[data-bot]').forEach((btn) => btn.addEventListener('click', () => {
      const id = +btn.dataset.bot;
      if (ME && ME.bot && ME.bot.id === id) showDetail();
      else showPublicBot(id);
    }));
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted-center">${esc(e.message)}</td></tr>`;
  }
}
$('refreshLb').addEventListener('click', loadLeaderboard);

// ============================================================
// 棋盘渲染（试玩棋盘；正式对局回放在独立弹窗，见文末）
// ============================================================
let state = { match: null, frames: [], cur: 0 };

function cloneBoard(b) { return b.map((col) => col.slice()); }
function countOf(b) { let black=0,red=0; for(let x=0;x<4;x++) for(let y=0;y<4;y++){if(b[x][y]==='black')black++;else if(b[x][y]==='red')red++;} return{black,red}; }
function buildFrames(initBoard, history) {
  const frames=[];let b=cloneBoard(initBoard),ncm=0;
  frames.push({board:cloneBoard(b),move:null,ncm,turn:0,counts:countOf(b)});
  for(const h of history){
    if(!h.pass){ const[fx,fy]=h.from,[tx,ty]=h.to; b[fx][fy]=null;b[tx][ty]=h.side; for(const[cx,cy] of h.captured)b[cx][cy]=null; ncm=h.captured.length>0?0:ncm+1; }
    else ncm=ncm+1;
    frames.push({board:cloneBoard(b),move:h,ncm,turn:h.turn,counts:countOf(b)});
  }
  return frames;
}
function buildBoardCells(){
  const board=$('board');board.innerHTML='';
  for(let y=3;y>=0;y--)for(let x=0;x<4;x++){
    const cell=document.createElement('div');
    cell.className='cell'+((x+y)%2?' alt':'');
    cell.dataset.x=x;cell.dataset.y=y;
    cell.addEventListener('click',()=>onCellClick(x,y));
    board.appendChild(cell);
  }
}
function cellAt(x,y){return document.querySelector(`#board .cell[data-x="${x}"][data-y="${y}"]`);}
function renderFrame(){
  const f=state.frames[state.cur];if(!f)return;
  document.querySelectorAll('#board .cell').forEach((c)=>{c.classList.remove('lastfrom','lastto','captured','sel','hint','clickable');c.innerHTML='';});
  for(let x=0;x<4;x++)for(let y=0;y<4;y++){
    const v=f.board[x][y];if(!v)continue;
    const t=document.createElement('div');t.className='token '+v;t.innerHTML=tokenSvg(v);
    cellAt(x,y).appendChild(t);
  }
  const mv=f.move;
  if(mv&&!mv.pass){
    cellAt(mv.from[0],mv.from[1])?.classList.add('lastfrom');
    cellAt(mv.to[0],mv.to[1])?.classList.add('lastto');
    for(const[cx,cy]of mv.captured)cellAt(cx,cy)?.classList.add('captured');
  }
  $('blackCount').textContent=f.counts.black;
  $('redCount').textContent=f.counts.red;
  $('turnNo').textContent=f.turn;
  $('ncm').textContent=f.ncm;
  const tm=nextSideToMove();
  $('toMove').innerHTML=tm?`${SIDE_LABEL[tm]}`:'—';
  if(state.match){
    $('infoBlackName').innerHTML=`${miniIcon('black')} ${esc(state.match.blackName||'黑方')}`;
    $('infoRedName').innerHTML=`${miniIcon('red')} ${esc(state.match.redName||'红方')}`;
  }
  document.querySelector('.black-side').classList.toggle('active',tm==='black');
  document.querySelector('.red-side').classList.toggle('active',tm==='red');
  document.querySelectorAll('#moveList li').forEach((li,i)=>li.classList.toggle('cur',i===state.cur-1));
  document.querySelector('#moveList li.cur')?.scrollIntoView({block:'nearest'});
  updateStatusLine();
  $('plyIndicator').textContent=state.frames.length>1?`第 ${state.cur} / ${state.frames.length-1} 手`:'—';
  paintPlayHints();
}
function nextSideToMove(){
  if(play.started&&!play.over)return play.toMove;
  if(state.cur>=state.frames.length-1)return null;
  const next=state.frames[state.cur+1];
  return next&&next.move?next.move.side:null;
}
function updateStatusLine(){
  const banner=$('resultBanner');
  if(!play.started){banner.className='result-banner hidden';$('statusLine').textContent='选择对手与执方，点击「开始对局」试玩';return;}
  if(play.over){
    const m=state.match;
    const who=m.winner==='draw'?'和棋':`${SIDE_LABEL[m.winner]}（${m.winner==='black'?m.blackName:m.redName}）胜`;
    const youWon=m.winner===play.humanSide;
    banner.className='result-banner '+(m.winner==='draw'?'':(youWon?'win':''));
    banner.innerHTML=`${m.winner==='draw'?'和棋':(youWon?'🎉 你赢了！':'你输了')}<small>${REASON_LABEL[m.reason]||m.reason} · 共 ${m.turns} 手</small>`;
    $('statusLine').textContent=`终局：${who}`;
    return;
  }
  banner.className='result-banner hidden';
  $('statusLine').textContent=play.sel?'点击高亮格完成走子，或点其他己方棋子换选':'轮到你走子：点击你的棋子';
}
function renderMoveList(){
  const ol=$('moveList');ol.innerHTML='';
  if(!state.match||!state.match.history)return;
  state.match.history.forEach((h,i)=>{
    const li=document.createElement('li');
    li.innerHTML=moveLiHtml(h,i);
    ol.appendChild(li);
  });
}
// 棋谱行 HTML（试玩 / 回放共用）
function moveLiHtml(h,i){
  const icon=`<span class="mv-side">${tokenSvg(h.side)}</span>`;
  if(h.pass)return `<span class="mv-no">${i+1}</span>${icon}<span class="mv-pass">停一手</span>`;
  const cap=h.captured.length?`<span class="mv-cap">吃${h.captured.length}</span>`:'';
  return `<span class="mv-no">${i+1}</span>${icon}<span>(${h.from})→(${h.to})</span>${cap}`;
}

// ============================================================
// 人机试玩
// ============================================================
const play = { started:false, over:false, template:null, humanSide:'black', toMove:null, history:[], legal:[], sel:null, undosLeft:3, busy:false, resultShown:false };

// ---- 终局弹窗动画 ----
function showResultOverlay() {
  const m = state.match; if (!m || !m.winner) return;
  const draw = m.winner === 'draw';
  const win = m.winner === play.humanSide;
  $('rpEmoji').textContent = draw ? '🤝' : (win ? '🎉' : '🌊');
  $('rpTitle').textContent = draw ? '和棋' : (win ? '胜利！' : '惜败');
  $('rpSub').textContent = `${REASON_LABEL[m.reason] || m.reason} · 共 ${m.turns} 手 · 对手「${play.template}」`;
  $('resultPop').className = 'result-pop ' + (draw ? 'draw' : (win ? 'win' : 'loss'));
  const box = $('confettiBox'); box.innerHTML = '';
  if (win) { // 胜利撒彩带
    const glyphs = ['🎉','✨','🦀','🦞','⭐','💧','🐚'];
    for (let i = 0; i < 26; i++) {
      const s = document.createElement('span');
      s.className = 'confetti'; s.textContent = glyphs[i % glyphs.length];
      s.style.left = Math.random() * 100 + '%';
      s.style.fontSize = (14 + Math.random() * 16) + 'px';
      s.style.animationDuration = (2.2 + Math.random() * 1.8) + 's';
      s.style.animationDelay = (Math.random() * 0.7) + 's';
      box.appendChild(s);
    }
  }
  openModal('resultOverlay');
}
function maybeShowResult() {
  if (play.over && !play.resultShown) {
    play.resultShown = true;
    setTimeout(showResultOverlay, 420); // 等最后一帧落子动画
  }
}
$('rpAgain').addEventListener('click', () => { closeModal('resultOverlay'); startPlay(); });
$('rpClose').addEventListener('click', () => closeModal('resultOverlay'));

function updateUndoBtn(){
  $('undoBtn').textContent=`悔棋（剩 ${play.undosLeft} 次）`;
  const hasHumanMove=play.history.some((h)=>h.side===play.humanSide&&!h.pass);
  $('undoBtn').disabled=!play.started||play.busy||play.undosLeft<=0||!hasHumanMove;
}
function paintPlayHints(){
  if(!play.started||play.over||play.busy)return;
  const froms=new Set(play.legal.map((m)=>m.from[0]+','+m.from[1]));
  for(const key of froms){const[x,y]=key.split(',').map(Number);cellAt(x,y)?.classList.add('clickable');}
  if(play.sel){
    cellAt(play.sel[0],play.sel[1])?.classList.add('sel');
    for(const m of play.legal)if(m.from[0]===play.sel[0]&&m.from[1]===play.sel[1])cellAt(m.to[0],m.to[1])?.classList.add('hint');
  }
}
async function postPlay(history,{animate}={}){
  play.busy=true;updateUndoBtn();
  const prevFrames=state.frames.length;
  const r=await apiFetch('POST','/api/play',{template:play.template,humanSide:play.humanSide,history});
  if(!r.ok){play.busy=false;updateUndoBtn();toast(r.error||'走子失败');return null;}
  play.history=r.history;
  play.legal=r.legalMoves;
  play.over=r.status.over;
  play.toMove=play.over?null:play.humanSide;
  play.sel=null;
  state.match={
    blackName:play.humanSide==='black'?'你':play.template,
    redName:play.humanSide==='red'?'你':play.template,
    winner:r.status.winner,reason:r.status.reason,turns:r.status.turns,
    history:r.history,
  };
  state.frames=buildFrames(r.initialBoard,r.history);
  renderMoveList();
  if(animate&&state.frames.length>prevFrames&&prevFrames>0){
    // 逐帧播放新增着法（人类落子 → 机器人应手）
    let i=prevFrames-1;
    const stepAnim=()=>{
      i++;state.cur=Math.min(i,state.frames.length-1);renderFrame();
      if(i<state.frames.length-1)setTimeout(stepAnim,380);
      else{play.busy=false;updateUndoBtn();renderFrame();maybeShowResult();}
    };
    stepAnim();
  }else{
    state.cur=state.frames.length-1;
    play.busy=false;updateUndoBtn();renderFrame();maybeShowResult();
  }
  return r;
}
async function startPlay(){
  play.started=true;play.over=false;play.template=$('oppSel').value;play.humanSide=$('sideSel').value;
  play.history=[];play.legal=[];play.sel=null;play.undosLeft=3;play.busy=false;play.resultShown=false;
  state.match=null;state.frames=[];state.cur=0;
  $('statusLine').textContent='对局开始…';
  await postPlay([]);
  toast(`对局开始：你执${play.humanSide==='black'?'梭子蟹（黑方 · 先手）':'龙虾（红方 · 后手）'}，对手「${play.template}」`);
}
function onCellClick(x,y){
  if(!play.started||play.over||play.busy)return;
  // 点击合法目标 → 走子
  if(play.sel){
    const mv=play.legal.find((m)=>m.from[0]===play.sel[0]&&m.from[1]===play.sel[1]&&m.to[0]===x&&m.to[1]===y);
    if(mv){
      const newHistory=play.history.concat([{side:play.humanSide,from:mv.from,to:mv.to,pass:false}]);
      postPlay(newHistory,{animate:true});
      return;
    }
  }
  // 点击己方可动棋子 → 选中/换选
  if(play.legal.some((m)=>m.from[0]===x&&m.from[1]===y)){
    play.sel=(play.sel&&play.sel[0]===x&&play.sel[1]===y)?null:[x,y];
    renderFrame();
  }
}
async function undoMove(){
  if(play.undosLeft<=0||play.busy)return;
  let lastHuman=-1;
  for(let i=play.history.length-1;i>=0;i--){
    if(play.history[i].side===play.humanSide&&!play.history[i].pass){lastHuman=i;break;}
  }
  if(lastHuman<0)return toast('还没有可悔的着法');
  play.undosLeft--;play.over=false;play.resultShown=false;closeModal('resultOverlay');
  const truncated=play.history.slice(0,lastHuman).map((h)=>({side:h.side,from:h.from,to:h.to,pass:h.pass}));
  await postPlay(truncated);
  toast(`已悔棋（剩 ${play.undosLeft} 次）`);
}
$('startPlayBtn').addEventListener('click',startPlay);
$('undoBtn').addEventListener('click',undoMove);

// ============================================================
// 对局回放（正式对局 · 独立弹窗，与试玩棋盘完全隔离）
// ============================================================
const rstate = { match: null, frames: [], cur: 0, timer: null, playing: false };

function rCellAt(x,y){return document.querySelector(`#rBoard .cell[data-x="${x}"][data-y="${y}"]`);}
function buildReplayCells(){
  const board=$('rBoard');board.innerHTML='';
  for(let y=3;y>=0;y--)for(let x=0;x<4;x++){
    const cell=document.createElement('div');
    cell.className='cell'+((x+y)%2?' alt':'');
    cell.dataset.x=x;cell.dataset.y=y;
    board.appendChild(cell);
  }
}
function rRenderFrame(){
  const f=rstate.frames[rstate.cur];if(!f)return;
  document.querySelectorAll('#rBoard .cell').forEach((c)=>{c.classList.remove('lastfrom','lastto','captured');c.innerHTML='';});
  for(let x=0;x<4;x++)for(let y=0;y<4;y++){
    const v=f.board[x][y];if(!v)continue;
    const t=document.createElement('div');t.className='token '+v;t.innerHTML=tokenSvg(v);
    rCellAt(x,y).appendChild(t);
  }
  const mv=f.move;
  if(mv&&!mv.pass){
    rCellAt(mv.from[0],mv.from[1])?.classList.add('lastfrom');
    rCellAt(mv.to[0],mv.to[1])?.classList.add('lastto');
    for(const[cx,cy]of mv.captured)rCellAt(cx,cy)?.classList.add('captured');
  }
  $('rBlackCount').textContent=f.counts.black;
  $('rRedCount').textContent=f.counts.red;
  $('rTurnNo').textContent=f.turn;
  $('rNcm').textContent=f.ncm;
  const next=rstate.cur<rstate.frames.length-1?rstate.frames[rstate.cur+1]:null;
  const tm=next&&next.move?next.move.side:null;
  $('rToMove').textContent=tm?SIDE_LABEL[tm]:'—';
  document.querySelector('#replayModal .black-side').classList.toggle('active',tm==='black');
  document.querySelector('#replayModal .red-side').classList.toggle('active',tm==='red');
  document.querySelectorAll('#rMoveList li').forEach((li,i)=>li.classList.toggle('cur',i===rstate.cur-1));
  document.querySelector('#rMoveList li.cur')?.scrollIntoView({block:'nearest'});
  // 终局横幅：播到最后一手时展示
  const m=rstate.match,banner=$('rResultBanner');
  if(m&&rstate.cur===rstate.frames.length-1){
    const who=m.winnerSide==='draw'?'和棋':`${esc(m.winnerSide==='black'?m.blackName:m.redName)}（${SIDE_LABEL[m.winnerSide]}）胜`;
    banner.className='result-banner '+(m.winnerSide==='draw'?'':'win');
    banner.innerHTML=`${who}<small>${REASON_LABEL[m.reason]||m.reason} · 共 ${m.turns} 手</small>`;
  }else banner.className='result-banner hidden';
  $('rPlyIndicator').textContent=rstate.frames.length>1?`第 ${rstate.cur} / ${rstate.frames.length-1} 手`:'—';
}
function rGoTo(i){rstate.cur=Math.max(0,Math.min(rstate.frames.length-1,i));rRenderFrame();}
function rStep(d){rGoTo(rstate.cur+d);}
function rPause(){rstate.playing=false;clearTimeout(rstate.timer);$('rPlayPause').textContent='▶ 播放';}
function rTick(){clearTimeout(rstate.timer);if(!rstate.playing)return;if(rstate.cur>=rstate.frames.length-1){rPause();return;}rStep(1);rstate.timer=setTimeout(rTick,+$('rSpeed').value);}
function rPlay(){if(rstate.cur>=rstate.frames.length-1)rstate.cur=0;rstate.playing=true;$('rPlayPause').textContent='⏸ 暂停';rTick();}
function rTogglePlay(){rstate.playing?rPause():rPlay();}
function rRenderMoveList(){
  const ol=$('rMoveList');ol.innerHTML='';
  rstate.match.history.forEach((h,i)=>{
    const li=document.createElement('li');
    li.innerHTML=moveLiHtml(h,i);
    li.addEventListener('click',()=>{rPause();rGoTo(i+1);});
    ol.appendChild(li);
  });
}
async function replaySavedMatch(urlId) {
  const r = await apiFetch('GET', '/api/match/' + urlId);
  if (!r.ok) return toast(r.error || '加载失败');
  // 挑战双方执方由 challenger_side 决定（第 2 局挑战者执红）
  const chSide = r.challenger_side === 'red' ? 'red' : 'black';
  const cdSide = chSide === 'black' ? 'red' : 'black';
  const names = { [chSide]: r.challengerName, [cdSide]: r.challengedName };
  const winnerSide = r.winner === 'draw' ? 'draw' : (r.winner === 'challenger' ? chSide : cdSide);
  rstate.match = { blackName: names.black, redName: names.red, winnerSide, reason: r.reason, turns: r.turns, history: r.gameData.history };
  rstate.frames = buildFrames(r.gameData.initialBoard, r.gameData.history);
  rstate.cur = 0; rPause();
  $('replayTitle').textContent = `对局回放 · ${names.black} vs ${names.red}`;
  $('rBlackName').innerHTML = `${miniIcon('black')} ${esc(names.black || '黑方')}`;
  $('rRedName').innerHTML = `${miniIcon('red')} ${esc(names.red || '红方')}`;
  rRenderMoveList(); rRenderFrame();
  openModal('replayModal');
}
$('rPlayPause').addEventListener('click',rTogglePlay);
$('rNext').addEventListener('click',()=>{rPause();rStep(1);});
$('rPrev').addEventListener('click',()=>{rPause();rStep(-1);});
$('rToStart').addEventListener('click',()=>{rPause();rGoTo(0);});
$('rToEnd').addEventListener('click',()=>{rPause();rGoTo(rstate.frames.length-1);});
// 关闭弹窗（✕ 或点遮罩）时停止自动播放
$('replayModal').addEventListener('click',(e)=>{
  if(e.target===$('replayModal')||e.target.dataset.close==='replayModal')rPause();
});
document.addEventListener('keydown',(e)=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT'||e.target.tagName==='TEXTAREA')return;
  if($('replayModal').classList.contains('hidden'))return;
  if(e.key==='ArrowRight'){rPause();rStep(1);}
  else if(e.key==='ArrowLeft'){rPause();rStep(-1);}
  else if(e.key===' '){e.preventDefault();rTogglePlay();}
  else if(e.key==='Escape'){rPause();closeModal('replayModal');}
});

$('rulesHint').addEventListener('click',()=>$('rulesPanel').classList.toggle('hidden'));

async function loadTemplates(){
  const data=await apiFetch('GET','/api/templates');
  const opt=(t)=>`<option value="${esc(t.name)}" title="${esc(t.summary)}">${esc(t.name)} — ${esc(t.summary)}</option>`;
  const tpl=data.templates.filter((t)=>t.kind!=='training');
  const train=data.templates.filter((t)=>t.kind==='training');
  $('oppSel').innerHTML=
    `<optgroup label="评估流派">${tpl.map(opt).join('')}</optgroup>`+
    (train.length?`<optgroup label="训练棋手">${train.map(opt).join('')}</optgroup>`:'');
}

// ============================================================
// 初始化
// ============================================================
(async function init(){
  buildBoardCells();
  buildReplayCells();
  state.frames=buildFrames(initialBoard(),[]);
  state.cur=0;renderFrame();
  await refreshMe();
  await loadTemplates();
  updateUndoBtn();
})();
