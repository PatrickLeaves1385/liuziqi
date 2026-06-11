'use strict';
// 前端 JS：Tab 切换 + 观战回放 + 天梯 + 注册/提交/挑战 表单
const $ = (id) => document.getElementById(id);
const SIDE_LABEL = { stone: '石子方', stick: '木棍方', draw: '和棋' };
const REASON_LABEL = { eliminated:'≤1子判负', material:'20手子力裁定', stalemate:'互停子力裁定', draw:'平局', illegal:'非法走法判负', runtime:'思考点超额判负', error:'运行异常判负' };

// ============================================================
// Tab 切换
// ============================================================
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    const panel = $('tab-' + btn.dataset.tab);
    panel.classList.add('active');
    if (btn.dataset.tab === 'leaderboard') loadLeaderboard();
  });
});

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
        <td>${b.avatar} ${esc(b.name)}</td>
        <td>${esc(b.username)}</td>
        <td>${esc(b.templateName)}</td>
        <td>v${b.currentVersion}</td>
        <td><b>${b.rating}</b></td>
        <td>${b.wins}胜 / ${b.losses}负 / ${b.draws}平</td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted-center">暂无棋手</td></tr>';
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted-center">${esc(e.message)}</td></tr>`;
  }
}
$('refreshLb').addEventListener('click', loadLeaderboard);

// ============================================================
// 注册
// ============================================================
$('regBtn').addEventListener('click', async () => {
  const body = { username: $('reg-username').value.trim(), email: $('reg-email').value.trim(), botName: $('reg-botname').value.trim(), avatar: $('reg-avatar').value.trim() || '🤖', templateName: $('reg-template').value };
  const res = await apiFetch('POST', '/api/account/register', body);
  showResult('regResult', res, res.ok);
});

// ============================================================
// 提交代码
// ============================================================
$('subBtn').addEventListener('click', async () => {
  const key = $('sub-key').value.trim();
  if (!key) return showResult('subResult', { error: '请填写 API Key' }, false);
  const body = { code: $('sub-code').value, notes: $('sub-notes').value.trim(), submittedBy: $('sub-by').value.trim() || 'user' };
  const res = await apiFetch('POST', '/api/agent/bot/code/submit', body, key);
  showResult('subResult', res, res.ok);
});

$('listVerBtn').addEventListener('click', async () => {
  const key = $('sub-key').value.trim();
  if (!key) return showResult('subResult', { error: '请填写 API Key' }, false);
  const res = await apiFetch('GET', '/api/agent/bot/code/versions', null, key);
  showResult('subResult', res, res.ok);
});

$('revBtn').addEventListener('click', async () => {
  const key = $('sub-key').value.trim();
  if (!key) return showResult('revResult', { error: '请填写 API Key（提交代码区）' }, false);
  const body = { toVersion: +$('rev-version').value, submittedBy: $('rev-by').value.trim() || 'user' };
  const res = await apiFetch('POST', '/api/agent/bot/code/revert', body, key);
  showResult('revResult', res, res.ok);
});

// ============================================================
// 挑战 / 侦察
// ============================================================
$('chBtn').addEventListener('click', async () => {
  const key = $('ch-key').value.trim();
  if (!key) return showResult('chResult', { error: '请填写 API Key' }, false);
  const body = { challengedBotId: +$('ch-target').value };
  const res = await apiFetch('POST', '/api/agent/challenge', body, key);
  showResult('chResult', res, res.ok);
});

$('scBtn').addEventListener('click', async () => {
  const key = $('sc-key').value.trim();
  const targetId = +$('sc-target').value;
  if (!key || !targetId) return showResult('scResult', { error: '请填写 API Key 和目标 ID' }, false);
  const res = await apiFetch('GET', `/api/agent/opponents/${targetId}/matches?limit=10`, null, key);
  showResult('scResult', res, res.ok);
});

// ============================================================
// 观战回放（原有逻辑）
// ============================================================
let state = { match: null, frames: [], cur: 0, timer: null, playing: false };

function cloneBoard(b) { return b.map((col) => col.slice()); }
function countOf(b) {
  let stone=0,stick=0;
  for(let x=0;x<4;x++) for(let y=0;y<4;y++){if(b[x][y]==='stone')stone++;else if(b[x][y]==='stick')stick++;}
  return{stone,stick};
}
function buildFrames(initialBoard,history){
  const frames=[];let b=cloneBoard(initialBoard),ncm=0,turn=0;
  frames.push({board:cloneBoard(b),move:null,ncm,turn,counts:countOf(b)});
  for(const h of history){
    if(!h.pass){
      const[fx,fy]=h.from,[tx,ty]=h.to;
      b[fx][fy]=null;b[tx][ty]=h.side;
      for(const[cx,cy] of h.captured)b[cx][cy]=null;
      ncm=h.captured.length>0?0:ncm+1;
    }else ncm=ncm+1;
    frames.push({board:cloneBoard(b),move:h,ncm,turn:h.turn,counts:countOf(b)});
  }
  return frames;
}
function buildBoardCells(){
  const board=$('board');board.innerHTML='';
  for(let y=3;y>=0;y--)for(let x=0;x<4;x++){
    const cell=document.createElement('div');
    cell.className='cell'+((x+y)%2?' alt':'');
    cell.dataset.x=x;cell.dataset.y=y;board.appendChild(cell);
  }
}
function cellAt(x,y){return document.querySelector(`.cell[data-x="${x}"][data-y="${y}"]`);}
function renderFrame(){
  const f=state.frames[state.cur];if(!f)return;
  document.querySelectorAll('.cell').forEach((c)=>{c.classList.remove('lastfrom','lastto','captured');c.innerHTML='';});
  for(let x=0;x<4;x++)for(let y=0;y<4;y++){
    const v=f.board[x][y];if(!v)continue;
    const t=document.createElement('div');t.className='token '+v;t.textContent=v==='stone'?'石':'木';
    cellAt(x,y).appendChild(t);
  }
  const mv=f.move;
  if(mv&&!mv.pass){
    cellAt(mv.from[0],mv.from[1])?.classList.add('lastfrom');
    cellAt(mv.to[0],mv.to[1])?.classList.add('lastto');
    for(const[cx,cy]of mv.captured)cellAt(cx,cy)?.classList.add('captured');
  }
  $('stoneCount').textContent=f.counts.stone;
  $('stickCount').textContent=f.counts.stick;
  $('turnNo').textContent=f.turn;
  $('ncm').textContent=f.ncm;
  const tm=nextSideToMove();
  $('toMove').textContent=tm?SIDE_LABEL[tm]:'—';
  if(state.match){
    $('infoStoneName').textContent=`石子 · ${state.match.stoneName}`;
    $('infoStickName').textContent=`木棍 · ${state.match.stickName}`;
  }
  document.querySelector('.stone-side').classList.toggle('active',tm==='stone');
  document.querySelector('.stick-side').classList.toggle('active',tm==='stick');
  document.querySelectorAll('.move-list li').forEach((li,i)=>li.classList.toggle('cur',i===state.cur-1));
  document.querySelector('.move-list li.cur')?.scrollIntoView({block:'nearest'});
  updateStatusLine();
  $('plyIndicator').textContent=`第 ${state.cur} / ${state.frames.length-1} 手`;
}
function nextSideToMove(){
  if(state.cur>=state.frames.length-1)return null;
  const next=state.frames[state.cur+1];
  return next&&next.move?next.move.side:null;
}
function updateStatusLine(){
  const atEnd=state.cur===state.frames.length-1;
  const banner=$('resultBanner');
  if(atEnd&&state.match){
    const m=state.match;
    const who=m.winner==='draw'?'和棋':`${SIDE_LABEL[m.winner]}（${m.winner==='stone'?m.stoneName:m.stickName}）胜`;
    banner.className='result-banner '+(m.winner==='draw'?'':'win');
    banner.innerHTML=`${who}<small>${REASON_LABEL[m.reason]||m.reason} · 共 ${m.turns} 手 · 种子 ${m.seed}</small>`;
    $('statusLine').textContent=`终局：${who}`;
  }else{
    banner.className='result-banner hidden';
    const mv=state.frames[state.cur].move;
    $('statusLine').textContent=mv?(mv.pass?`${SIDE_LABEL[mv.side]} 停一手`:`${SIDE_LABEL[mv.side]} (${mv.from})→(${mv.to})${mv.captured.length?` 吃${mv.captured.length}子`:''}`):'开局布局';
  }
}
function renderMoveList(){
  const ol=$('moveList');ol.innerHTML='';
  state.match.history.forEach((h,i)=>{
    const li=document.createElement('li');
    const sc=h.side==='stone'?'s-stone':'s-stick';
    const ch=h.side==='stone'?'石':'木';
    if(h.pass)li.innerHTML=`<span class="mv-no">${i+1}</span><span class="mv-side ${sc}">${ch}</span><span class="mv-pass">停一手</span>`;
    else{const cap=h.captured.length?`<span class="mv-cap">吃${h.captured.length}</span>`:'';li.innerHTML=`<span class="mv-no">${i+1}</span><span class="mv-side ${sc}">${ch}</span><span>(${h.from})→(${h.to})</span>${cap}`;}
    li.addEventListener('click',()=>{pause();goTo(i+1);});
    ol.appendChild(li);
  });
}
function goTo(i){state.cur=Math.max(0,Math.min(state.frames.length-1,i));renderFrame();}
function step(d){goTo(state.cur+d);}
function play(){if(state.cur>=state.frames.length-1)state.cur=0;state.playing=true;$('playPause').textContent='⏸ 暂停';tick();}
function tick(){clearTimeout(state.timer);if(!state.playing)return;if(state.cur>=state.frames.length-1){pause();return;}step(1);state.timer=setTimeout(tick,+$('speed').value);}
function pause(){state.playing=false;clearTimeout(state.timer);$('playPause').textContent='▶ 播放';}
function togglePlay(){state.playing?pause():play();}

async function startMatch(){
  pause();$('startBtn').disabled=true;$('statusLine').textContent='对弈计算中…';
  try{
    const body={stone:$('stoneSel').value,stick:$('stickSel').value,seed:+$('seed').value,budget:+$('budget').value};
    const data=await apiFetch('POST','/api/match',body);
    if(!data.ok)throw new Error(data.error||'对局失败');
    state.match=data;
    state.frames=buildFrames(data.initialBoard,data.history);
    state.cur=0;renderMoveList();renderFrame();
    $('statusLine').textContent=`已生成 ${data.turns} 手对局（${data.elapsedMs}ms），点击播放观战`;
  }catch(e){$('statusLine').textContent='出错：'+e.message;}
  finally{$('startBtn').disabled=false;}
}

async function loadTemplates(){
  const data=await apiFetch('GET','/api/templates');
  const opts=data.templates.map((t)=>`<option value="${t.name}">${t.name}</option>`).join('');
  $('stoneSel').innerHTML=opts;$('stickSel').innerHTML=opts;
  $('stoneSel').value='子力派';$('stickSel').value='抢中派';
}

$('startBtn').addEventListener('click',startMatch);
$('randSeed').addEventListener('click',()=>{$('seed').value=Math.floor(Math.random()*1e6);});
$('playPause').addEventListener('click',togglePlay);
$('next').addEventListener('click',()=>{pause();step(1);});
$('prev').addEventListener('click',()=>{pause();step(-1);});
$('toStart').addEventListener('click',()=>{pause();goTo(0);});
$('toEnd').addEventListener('click',()=>{pause();goTo(state.frames.length-1);});
$('rulesHint').addEventListener('click',()=>$('rulesPanel').classList.toggle('hidden'));
document.addEventListener('keydown',(e)=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT'||e.target.tagName==='TEXTAREA')return;
  if(e.key==='ArrowRight'){pause();step(1);}
  else if(e.key==='ArrowLeft'){pause();step(-1);}
  else if(e.key===' '){e.preventDefault();togglePlay();}
});

// ============================================================
// 工具函数
// ============================================================
async function apiFetch(method, url, body, apiKey){
  const headers={'Content-Type':'application/json'};
  if(apiKey)headers['Authorization']='Bearer '+apiKey;
  const opts={method,headers};
  if(body&&method!=='GET')opts.body=JSON.stringify(body);
  const res=await fetch(url,opts);
  return res.json();
}
function showResult(id,data,ok){
  const el=$(id);
  el.className='api-result '+(ok?'ok':'err');
  el.classList.remove('hidden');
  el.textContent=JSON.stringify(data,null,2);
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

(async function init(){
  buildBoardCells();
  await loadTemplates();
  await startMatch();
})();
