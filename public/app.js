'use strict';
// 前端：拉取对局历史，重建逐手棋盘，提供播放控制。
// 棋盘坐标 board[x][y]，x=列 0..3（左→右），y=行 0..3；显示时 y=3 在上、y=0 在下。

const $ = (id) => document.getElementById(id);
const SIDE_LABEL = { stone: '石子方', stick: '木棍方', draw: '和棋' };
const REASON_LABEL = {
  eliminated: '对方被吃至 ≤1 子', material: '连续 20 手无吃子，按子力裁定（领先即胜）',
  stalemate: '双方无路可走，按子力裁定', draw: '子力相等，和棋',
  illegal: '非法走法判负', runtime: '思考点超额判负', error: '运行异常判负',
};

let state = {
  match: null,      // /api/match 返回
  frames: [],       // 逐手棋盘快照
  cur: 0,           // 当前帧索引 0..frames.length-1
  timer: null,
  playing: false,
};

// ---- 初始化流派下拉 ----
async function loadTemplates() {
  const res = await fetch('/api/templates');
  const data = await res.json();
  const opts = data.templates.map((t) =>
    `<option value="${t.name}" title="${t.summary}">${t.name}</option>`).join('');
  $('stoneSel').innerHTML = opts;
  $('stickSel').innerHTML = opts;
  $('stoneSel').value = '子力派';
  $('stickSel').value = '抢中派';
}

// ---- 重建逐手棋盘 ----
function cloneBoard(b) { return b.map((col) => col.slice()); }
function countOf(b) {
  let stone = 0, stick = 0;
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {
    if (b[x][y] === 'stone') stone++; else if (b[x][y] === 'stick') stick++;
  }
  return { stone, stick };
}
function buildFrames(initialBoard, history) {
  const frames = [];
  let b = cloneBoard(initialBoard);
  let ncm = 0, turn = 0;
  frames.push({ board: cloneBoard(b), move: null, ncm, turn, counts: countOf(b) });
  for (const h of history) {
    if (!h.pass) {
      const [fx, fy] = h.from, [tx, ty] = h.to;
      b[fx][fy] = null;
      b[tx][ty] = h.side;
      for (const [cx, cy] of h.captured) b[cx][cy] = null;
      ncm = h.captured.length > 0 ? 0 : ncm + 1;
    } else {
      ncm = ncm + 1; // 停一手计入无吃子手数（与引擎一致）
    }
    frames.push({ board: cloneBoard(b), move: h, ncm, turn: h.turn, counts: countOf(b) });
  }
  return frames;
}

// ---- 渲染棋盘 ----
function buildBoardCells() {
  const board = $('board');
  board.innerHTML = '';
  // 从上到下 y=3..0，从左到右 x=0..3
  for (let y = 3; y >= 0; y--) {
    for (let x = 0; x < 4; x++) {
      const cell = document.createElement('div');
      cell.className = 'cell' + ((x + y) % 2 ? ' alt' : '');
      cell.dataset.x = x; cell.dataset.y = y;
      board.appendChild(cell);
    }
  }
}
function cellAt(x, y) { return document.querySelector(`.cell[data-x="${x}"][data-y="${y}"]`); }

function renderFrame() {
  const f = state.frames[state.cur];
  if (!f) return;
  // 清空
  document.querySelectorAll('.cell').forEach((c) => {
    c.classList.remove('lastfrom', 'lastto', 'captured');
    c.innerHTML = '';
  });
  // 棋子
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {
    const v = f.board[x][y];
    if (!v) continue;
    const t = document.createElement('div');
    t.className = 'token ' + v;
    t.textContent = v === 'stone' ? '石' : '木';
    cellAt(x, y).appendChild(t);
  }
  // 高亮上一手
  const mv = f.move;
  if (mv && !mv.pass) {
    cellAt(mv.from[0], mv.from[1])?.classList.add('lastfrom');
    cellAt(mv.to[0], mv.to[1])?.classList.add('lastto');
    for (const [cx, cy] of mv.captured) cellAt(cx, cy)?.classList.add('captured');
  }
  // 信息面板
  $('stoneCount').textContent = f.counts.stone;
  $('stickCount').textContent = f.counts.stick;
  $('turnNo').textContent = f.turn;
  $('ncm').textContent = f.ncm;
  const toMove = nextSideToMove();
  $('toMove').textContent = toMove ? SIDE_LABEL[toMove] : '—';
  $('infoStoneName').textContent = `石子 · ${state.match.stoneName}`;
  $('infoStickName').textContent = `木棍 · ${state.match.stickName}`;
  document.querySelector('.stone-side').classList.toggle('active', toMove === 'stone');
  document.querySelector('.stick-side').classList.toggle('active', toMove === 'stick');
  // 棋谱当前项
  document.querySelectorAll('.move-list li').forEach((li, i) => li.classList.toggle('cur', i === state.cur - 1));
  if (state.cur > 0) {
    const cur = document.querySelector('.move-list li.cur');
    cur?.scrollIntoView({ block: 'nearest' });
  }
  // 状态行 / 结果
  updateStatusLine();
  $('plyIndicator').textContent = `第 ${state.cur} / ${state.frames.length - 1} 手`;
}

function nextSideToMove() {
  // 终局帧不再有行棋方
  if (state.cur >= state.frames.length - 1) return null;
  const next = state.frames[state.cur + 1];
  return next && next.move ? next.move.side : null;
}

function updateStatusLine() {
  const atEnd = state.cur === state.frames.length - 1;
  const banner = $('resultBanner');
  if (atEnd) {
    const m = state.match;
    const who = m.winner === 'draw' ? '和棋'
      : `${SIDE_LABEL[m.winner]}（${m.winner === 'stone' ? m.stoneName : m.stickName}）胜`;
    banner.className = 'result-banner ' + (m.winner === 'draw' ? '' : 'win');
    banner.innerHTML = `${who}<small>${REASON_LABEL[m.reason] || m.reason} · 共 ${m.turns} 手 · 种子 ${m.seed}</small>`;
    $('statusLine').textContent = `终局：${who}`;
  } else {
    banner.className = 'result-banner hidden';
    const mv = state.frames[state.cur].move;
    $('statusLine').textContent = mv
      ? `${SIDE_LABEL[mv.side]} ${mv.pass ? '停一手' : `(${mv.from})→(${mv.to})`}${mv && mv.captured && mv.captured.length ? ` 吃 ${mv.captured.length} 子` : ''}`
      : '开局布局';
  }
}

// ---- 棋谱列表 ----
function renderMoveList() {
  const ol = $('moveList');
  ol.innerHTML = '';
  state.match.history.forEach((h, i) => {
    const li = document.createElement('li');
    const sideCls = h.side === 'stone' ? 's-stone' : 's-stick';
    const sideCh = h.side === 'stone' ? '石' : '木';
    if (h.pass) {
      li.innerHTML = `<span class="mv-no">${i + 1}</span><span class="mv-side ${sideCls}">${sideCh}</span><span class="mv-pass">停一手 (pass)</span>`;
    } else {
      const cap = h.captured.length ? `<span class="mv-cap">吃${h.captured.length}</span>` : '';
      li.innerHTML = `<span class="mv-no">${i + 1}</span><span class="mv-side ${sideCls}">${sideCh}</span>` +
        `<span>(${h.from})→(${h.to})</span>${cap}`;
    }
    li.addEventListener('click', () => { pause(); goTo(i + 1); });
    ol.appendChild(li);
  });
}

// ---- 播放控制 ----
function goTo(i) {
  state.cur = Math.max(0, Math.min(state.frames.length - 1, i));
  renderFrame();
}
function step(d) { goTo(state.cur + d); }
function play() {
  if (state.cur >= state.frames.length - 1) state.cur = 0;
  state.playing = true;
  $('playPause').textContent = '⏸ 暂停';
  tick();
}
function tick() {
  clearTimeout(state.timer);
  if (!state.playing) return;
  if (state.cur >= state.frames.length - 1) { pause(); return; }
  step(1);
  state.timer = setTimeout(tick, +$('speed').value);
}
function pause() {
  state.playing = false;
  clearTimeout(state.timer);
  $('playPause').textContent = '▶ 播放';
}
function togglePlay() { state.playing ? pause() : play(); }

// ---- 开始对局 ----
async function startMatch() {
  pause();
  $('startBtn').disabled = true;
  $('statusLine').textContent = '对弈计算中…';
  try {
    const body = {
      stone: $('stoneSel').value, stick: $('stickSel').value,
      seed: +$('seed').value, budget: +$('budget').value,
    };
    const res = await fetch('/api/match', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '对局失败');
    state.match = data;
    state.frames = buildFrames(data.initialBoard, data.history);
    state.cur = 0;
    renderMoveList();
    renderFrame();
    $('statusLine').textContent = `已生成 ${data.turns} 手对局（用时 ${data.elapsedMs}ms），点击播放观战`;
  } catch (e) {
    $('statusLine').textContent = '出错：' + e.message;
  } finally {
    $('startBtn').disabled = false;
  }
}

// ---- 绑定 ----
function bind() {
  $('startBtn').addEventListener('click', startMatch);
  $('randSeed').addEventListener('click', () => { $('seed').value = Math.floor(Math.random() * 1e6); });
  $('playPause').addEventListener('click', togglePlay);
  $('next').addEventListener('click', () => { pause(); step(1); });
  $('prev').addEventListener('click', () => { pause(); step(-1); });
  $('toStart').addEventListener('click', () => { pause(); goTo(0); });
  $('toEnd').addEventListener('click', () => { pause(); goTo(state.frames.length - 1); });
  $('rulesHint').addEventListener('click', () => $('rulesPanel').classList.toggle('hidden'));
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'ArrowRight') { pause(); step(1); }
    else if (e.key === 'ArrowLeft') { pause(); step(-1); }
    else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  });
}

(async function init() {
  buildBoardCells();
  bind();
  await loadTemplates();
  await startMatch(); // 启动即演示一局
})();
