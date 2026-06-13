'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');

const db = new DatabaseSync(path.join(__dirname, 'sixchess.db'));

db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname      TEXT    UNIQUE NOT NULL,
  email         TEXT    UNIQUE NOT NULL,
  password_hash TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bots (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id           INTEGER UNIQUE NOT NULL,
  name                 TEXT    NOT NULL,
  avatar               TEXT    NOT NULL DEFAULT 'preset:1',  -- 'preset:1..6' 或 'upload:<botId>'
  template_name        TEXT,                                 -- 可空：建棋手不再选流派
  current_version      INTEGER NOT NULL DEFAULT 0,
  rating               INTEGER NOT NULL DEFAULT 1200,        -- ELO 内部实力分（不对外展示）
  rp                   INTEGER NOT NULL DEFAULT 0,           -- 段位分（对外展示，决定段位）
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  delete_cooldown_until INTEGER,
  created_at           INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id     INTEGER NOT NULL,
  key_hash   TEXT    NOT NULL,
  key_prefix TEXT    NOT NULL,
  key_plain  TEXT    NOT NULL,   -- 明文留存：详情页掩码展示 + 组装 Prompt 需完整 key（demo 取舍）
  created_at INTEGER NOT NULL,
  FOREIGN KEY (bot_id) REFERENCES bots(id)
);

CREATE TABLE IF NOT EXISTS code_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id       INTEGER NOT NULL,
  version      INTEGER NOT NULL,
  code         TEXT    NOT NULL,
  code_hash    TEXT    NOT NULL,
  notes        TEXT,
  submitted_by TEXT,
  smoke_status TEXT    NOT NULL DEFAULT 'pending',
  smoke_detail TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE(bot_id, version),
  FOREIGN KEY (bot_id) REFERENCES bots(id)
);

CREATE TABLE IF NOT EXISTS battles (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  battle_url_id     TEXT    UNIQUE NOT NULL,
  challenger_bot_id INTEGER NOT NULL,
  challenged_bot_id INTEGER NOT NULL,
  result            TEXT    NOT NULL,   -- 'challenger' | 'challenged' | 'draw'（双局合计的本场结果）
  ch_rp_delta       INTEGER,            -- 本场挑战者 RP 增减（历史回填数据为 NULL）
  cd_rp_delta       INTEGER,
  played_at         INTEGER NOT NULL,
  FOREIGN KEY (challenger_bot_id) REFERENCES bots(id),
  FOREIGN KEY (challenged_bot_id) REFERENCES bots(id)
);

CREATE TABLE IF NOT EXISTS matches (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  match_url_id             TEXT    UNIQUE NOT NULL,
  challenger_bot_id        INTEGER NOT NULL,
  challenged_bot_id        INTEGER NOT NULL,
  ch_code_version          INTEGER NOT NULL,
  cd_code_version          INTEGER NOT NULL,
  ch_code_hash             TEXT    NOT NULL,
  cd_code_hash             TEXT    NOT NULL,
  winner                   TEXT    NOT NULL,
  reason                   TEXT    NOT NULL,
  turns                    INTEGER NOT NULL,
  final_challenger_pieces  INTEGER NOT NULL,
  final_challenged_pieces  INTEGER NOT NULL,
  game_json                TEXT    NOT NULL,
  challenger_side          TEXT    NOT NULL,
  seed                     INTEGER NOT NULL,
  played_at                INTEGER NOT NULL,
  FOREIGN KEY (challenger_bot_id) REFERENCES bots(id),
  FOREIGN KEY (challenged_bot_id) REFERENCES bots(id)
);

CREATE TABLE IF NOT EXISTS hash_pair_scores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id     INTEGER NOT NULL,
  my_hash    TEXT    NOT NULL,
  opp_hash   TEXT    NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(bot_id, my_hash, opp_hash),
  FOREIGN KEY (bot_id) REFERENCES bots(id)
);

CREATE INDEX IF NOT EXISTS idx_matches_challenger ON matches(challenger_bot_id);
CREATE INDEX IF NOT EXISTS idx_matches_challenged ON matches(challenged_bot_id);
CREATE INDEX IF NOT EXISTS idx_code_bot ON code_versions(bot_id);
CREATE INDEX IF NOT EXISTS idx_battles_challenger ON battles(challenger_bot_id);
CREATE INDEX IF NOT EXISTS idx_battles_challenged ON battles(challenged_bot_id);
`);

// ---- 增量迁移：matches 关联到场（battle）----
const matchCols = db.prepare('PRAGMA table_info(matches)').all().map((c) => c.name);
if (!matchCols.includes('battle_id')) db.exec('ALTER TABLE matches ADD COLUMN battle_id INTEGER');
if (!matchCols.includes('game_no')) db.exec('ALTER TABLE matches ADD COLUMN game_no INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS idx_matches_battle ON matches(battle_id)');

// 战绩口径为「场」：从 battles 全量重算各棋手 W/L/D（幂等）
function recomputeBotStats() {
  const calc = db.prepare(`
    SELECT
      SUM(CASE WHEN (challenger_bot_id=? AND result='challenger') OR (challenged_bot_id=? AND result='challenged') THEN 1 ELSE 0 END) AS w,
      SUM(CASE WHEN (challenger_bot_id=? AND result='challenged') OR (challenged_bot_id=? AND result='challenger') THEN 1 ELSE 0 END) AS l,
      SUM(CASE WHEN result='draw' THEN 1 ELSE 0 END) AS d
    FROM battles WHERE challenger_bot_id=? OR challenged_bot_id=?`);
  const setStats = db.prepare('UPDATE bots SET wins=?,losses=?,draws=? WHERE id=?');
  for (const b of db.prepare('SELECT id FROM bots').all()) {
    const r = calc.get(b.id, b.id, b.id, b.id, b.id, b.id);
    setStats.run(r.w || 0, r.l || 0, r.d || 0, b.id);
  }
}

// 历史数据回填：旧两局记录按 urlId 前缀（…a / …b）归并为一场。
// 本场结果按双局合计分（胜2/平1/负0）判定；当时的 RP 增减未记录，留 NULL。
// 回填后顺带把旧的按局战绩重算为按场。
(function backfillBattles() {
  const orphans = db.prepare(
    'SELECT id,match_url_id,challenger_bot_id,challenged_bot_id,winner,played_at FROM matches WHERE battle_id IS NULL ORDER BY id'
  ).all();
  if (!orphans.length) return;
  const groups = new Map();
  for (const m of orphans) {
    const suffix = m.match_url_id.slice(-1);
    if (suffix !== 'a' && suffix !== 'b') continue;
    const prefix = m.match_url_id.slice(0, -1);
    if (!groups.has(prefix)) groups.set(prefix, {});
    groups.get(prefix)[suffix] = m;
  }
  const insBattle = db.prepare('INSERT INTO battles(battle_url_id,challenger_bot_id,challenged_bot_id,result,ch_rp_delta,cd_rp_delta,played_at) VALUES(?,?,?,?,?,?,?)');
  const linkMatch = db.prepare('UPDATE matches SET battle_id=?,game_no=? WHERE id=?');
  for (const [prefix, g] of groups) {
    if (!g.a || !g.b) continue;
    let ch = 0, cd = 0;
    for (const m of [g.a, g.b]) {
      if (m.winner === 'challenger') ch += 2;
      else if (m.winner === 'challenged') cd += 2;
      else { ch += 1; cd += 1; }
    }
    const result = ch > cd ? 'challenger' : ch < cd ? 'challenged' : 'draw';
    const r = insBattle.run(prefix, g.a.challenger_bot_id, g.a.challenged_bot_id, result, null, null, Math.max(g.a.played_at, g.b.played_at));
    linkMatch.run(r.lastInsertRowid, 1, g.a.id);
    linkMatch.run(r.lastInsertRowid, 2, g.b.id);
  }
  recomputeBotStats();
})();

// ---- 工具函数 ----
function hashKey(key) { return crypto.createHash('sha256').update(key).digest('hex'); }
function codeHash(code) { return crypto.createHash('sha256').update(code.trim()).digest('hex').slice(0, 16); }
function generateKey() { return 'sk_' + crypto.randomBytes(24).toString('base64url'); }
function urlId() { return crypto.randomBytes(8).toString('hex'); }
function now() { return Date.now(); }

// ---- 账号 ----
const stmtInsertAccount = db.prepare('INSERT INTO accounts(nickname,email,password_hash,created_at) VALUES(?,?,?,?)');
const stmtGetAccountByEmail = db.prepare('SELECT * FROM accounts WHERE email=?');
const stmtGetAccountByNickname = db.prepare('SELECT * FROM accounts WHERE nickname=?');
const stmtGetAccountById = db.prepare('SELECT * FROM accounts WHERE id=?');

// ---- 棋手 ----
const stmtInsertBot = db.prepare('INSERT INTO bots(account_id,name,avatar,created_at) VALUES(?,?,?,?)');
const stmtGetBotById = db.prepare('SELECT * FROM bots WHERE id=?');
const stmtGetBotByName = db.prepare('SELECT * FROM bots WHERE name=?');
const stmtSearchBots = db.prepare(`
  SELECT b.id,b.name,b.avatar,b.rp,b.current_version,a.nickname
  FROM bots b JOIN accounts a ON b.account_id=a.id
  WHERE b.name LIKE ? ESCAPE '\\'
  ORDER BY b.rp DESC, b.id ASC LIMIT 20`);
const stmtGetBotByAccount = db.prepare('SELECT * FROM bots WHERE account_id=?');
const stmtUpdateBotVersion = db.prepare('UPDATE bots SET current_version=? WHERE id=?');
const stmtUpdateBotAvatar = db.prepare('UPDATE bots SET avatar=? WHERE id=?');
const stmtUpdateBotRating = db.prepare('UPDATE bots SET rating=?,rp=?,wins=wins+?,losses=losses+?,draws=draws+? WHERE id=?');
const stmtListBots = db.prepare('SELECT b.*,a.nickname FROM bots b JOIN accounts a ON b.account_id=a.id ORDER BY b.rp DESC, b.rating DESC LIMIT 100');
// 当前排名：RP 高者在前，同 RP 比 ELO
const stmtBotRankPos = db.prepare(`
  SELECT COUNT(*)+1 AS pos FROM bots b, (SELECT rp, rating FROM bots WHERE id=?) me
  WHERE b.rp > me.rp OR (b.rp = me.rp AND b.rating > me.rating)`);

// ---- API Key ----
const stmtInsertKey = db.prepare('INSERT INTO api_keys(bot_id,key_hash,key_prefix,key_plain,created_at) VALUES(?,?,?,?,?)');
const stmtDeleteKeysForBot = db.prepare('DELETE FROM api_keys WHERE bot_id=?');
const stmtGetKeyByBot = db.prepare('SELECT key_plain,key_prefix FROM api_keys WHERE bot_id=? ORDER BY id DESC LIMIT 1');
const stmtGetBotByKey = db.prepare(`
  SELECT b.* FROM bots b
  JOIN api_keys k ON k.bot_id=b.id
  WHERE k.key_hash=?
  LIMIT 1
`);

// ---- 代码版本 ----
const stmtInsertVersion = db.prepare(`
  INSERT INTO code_versions(bot_id,version,code,code_hash,notes,submitted_by,smoke_status,smoke_detail,created_at)
  VALUES(?,?,?,?,?,?,?,?,?)`);
const stmtGetVersion = db.prepare('SELECT * FROM code_versions WHERE bot_id=? AND version=?');
// 历史遗留：早期"先存后测"流程留下的未通过记录会占用版本号，发布前清掉同号及以上的幽灵记录
const stmtDeleteStaleVersions = db.prepare("DELETE FROM code_versions WHERE bot_id=? AND version>=? AND smoke_status<>'passed'");
const stmtListVersions = db.prepare('SELECT id,bot_id,version,code_hash,notes,submitted_by,smoke_status,created_at FROM code_versions WHERE bot_id=? ORDER BY version DESC LIMIT 50');
const stmtGetCurrentCode = db.prepare('SELECT * FROM code_versions WHERE bot_id=? AND smoke_status=? ORDER BY version DESC LIMIT 1');

// ---- 场（battle，一场 = 双局）----
const stmtInsertBattle = db.prepare(`
  INSERT INTO battles(battle_url_id,challenger_bot_id,challenged_bot_id,result,ch_rp_delta,cd_rp_delta,played_at)
  VALUES(?,?,?,?,?,?,?)`);
const stmtListBotBattles = db.prepare(`
  SELECT bt.*, cb.name AS challenger_name, db2.name AS challenged_name,
    cb.avatar AS challenger_avatar, db2.avatar AS challenged_avatar
  FROM battles bt
  JOIN bots cb ON bt.challenger_bot_id=cb.id
  JOIN bots db2 ON bt.challenged_bot_id=db2.id
  WHERE bt.challenger_bot_id=? OR bt.challenged_bot_id=?
  ORDER BY bt.played_at DESC LIMIT ?`);
const stmtBattleGames = db.prepare('SELECT game_no,match_url_id,winner,reason,turns,challenger_side FROM matches WHERE battle_id=? ORDER BY game_no');

// ---- 对局 ----
const stmtInsertMatch = db.prepare(`
  INSERT INTO matches(match_url_id,challenger_bot_id,challenged_bot_id,ch_code_version,cd_code_version,
    ch_code_hash,cd_code_hash,winner,reason,turns,final_challenger_pieces,final_challenged_pieces,
    game_json,challenger_side,seed,played_at,battle_id,game_no)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const stmtGetMatch = db.prepare('SELECT * FROM matches WHERE match_url_id=?');
const stmtListBotMatches = db.prepare(`
  SELECT m.*,
    cb.name AS challenger_name, db2.name AS challenged_name
  FROM matches m
  JOIN bots cb ON m.challenger_bot_id=cb.id
  JOIN bots db2 ON m.challenged_bot_id=db2.id
  WHERE m.challenger_bot_id=? OR m.challenged_bot_id=?
  ORDER BY m.played_at DESC LIMIT ?`);
const stmtListOpponentMatches = db.prepare(`
  SELECT m.*,
    cb.name AS challenger_name, db2.name AS challenged_name
  FROM matches m
  JOIN bots cb ON m.challenger_bot_id=cb.id
  JOIN bots db2 ON m.challenged_bot_id=db2.id
  WHERE m.challenger_bot_id=? OR m.challenged_bot_id=?
  ORDER BY m.played_at DESC LIMIT ? OFFSET ?`);
const stmtCountOpponentMatches = db.prepare('SELECT COUNT(*) AS cnt FROM matches WHERE challenger_bot_id=? OR challenged_bot_id=?');

// ---- Hash pair 计分资格 ----
const stmtUpsertHashPair = db.prepare(`
  INSERT INTO hash_pair_scores(bot_id,my_hash,opp_hash,used_count) VALUES(?,?,?,1)
  ON CONFLICT(bot_id,my_hash,opp_hash) DO UPDATE SET used_count=used_count+1`);
const stmtGetHashPair = db.prepare('SELECT * FROM hash_pair_scores WHERE bot_id=? AND my_hash=? AND opp_hash=?');

// ---- ELO ----
function eloExpected(rA, rB) { return 1 / (1 + Math.pow(10, (rB - rA) / 400)); }
function eloUpdate(rA, rB, scoreA, K = 32) {
  const exp = eloExpected(rA, rB);
  return Math.round(rA + K * (scoreA - exp));
}

// ---- 公开 API ----
module.exports = {
  hashKey, codeHash, generateKey, urlId, now,

  // 账号
  createAccount(nickname, email, passwordHash) {
    stmtInsertAccount.run(nickname, email, passwordHash, now());
    return stmtGetAccountByEmail.get(email);
  },
  getAccountByEmail: (email) => stmtGetAccountByEmail.get(email),
  getAccountByNickname: (nickname) => stmtGetAccountByNickname.get(nickname),
  getAccountById: (id) => stmtGetAccountById.get(id),

  // 棋手
  createBot(accountId, name, avatar) {
    stmtInsertBot.run(accountId, name, avatar || 'preset:1', now());
    return stmtGetBotByAccount.get(accountId);
  },
  getBotById: (id) => stmtGetBotById.get(id),
  getBotByName: (name) => stmtGetBotByName.get(name),
  searchBotsByName(q) {
    const escaped = q.replace(/[\\%_]/g, (c) => '\\' + c);
    return stmtSearchBots.all(`%${escaped}%`);
  },
  getBotByAccount: (accountId) => stmtGetBotByAccount.get(accountId),
  updateBotAvatar: (botId, avatar) => stmtUpdateBotAvatar.run(avatar, botId),
  listBots: () => stmtListBots.all(),

  // API Key
  createApiKey(botId) {
    const key = generateKey();
    stmtInsertKey.run(botId, hashKey(key), key.slice(0, 8), key, now());
    return key;
  },
  // 轮换：删旧 key、发新 key
  rotateApiKey(botId) {
    stmtDeleteKeysForBot.run(botId);
    return this.createApiKey(botId);
  },
  getBotKeyInfo: (botId) => stmtGetKeyByBot.get(botId),
  getBotByApiKey: (key) => stmtGetBotByKey.get(hashKey(key)),

  // 代码版本（先测后存：仅烟雾测试通过的代码才入库，入库即发布）
  publishCodeVersion(botId, version, code, notes, submittedBy) {
    const hash = codeHash(code);
    db.exec('BEGIN');
    try {
      stmtDeleteStaleVersions.run(botId, version);
      stmtInsertVersion.run(botId, version, code, hash, notes || null, submittedBy || null, 'passed', null, now());
      stmtUpdateBotVersion.run(version, botId);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return stmtGetVersion.get(botId, version);
  },
  getVersion: (botId, version) => stmtGetVersion.get(botId, version),
  listVersions: (botId) => stmtListVersions.all(botId),
  getLatestPassedVersion(botId) { return stmtGetCurrentCode.get(botId, 'passed'); },

  // 场（一场 = 双局）
  createBattle({ urlId: uid, challengerBotId, challengedBotId, result, chRpDelta, cdRpDelta }) {
    const r = stmtInsertBattle.run(uid, challengerBotId, challengedBotId, result, chRpDelta, cdRpDelta, now());
    return r.lastInsertRowid;
  },
  listBotBattles(botId, limit = 20) {
    return stmtListBotBattles.all(botId, botId, limit).map((b) => ({ ...b, games: stmtBattleGames.all(b.id) }));
  },

  // 对局
  saveMatch({ urlId: uid, challengerBotId, challengedBotId, chVer, cdVer, chHash, cdHash, winner, reason, turns, finalCh, finalCd, gameJson, challengerSide, seed, battleId, gameNo }) {
    stmtInsertMatch.run(uid, challengerBotId, challengedBotId, chVer, cdVer, chHash, cdHash, winner, reason, turns, finalCh, finalCd, JSON.stringify(gameJson), challengerSide, seed, now(), battleId ?? null, gameNo ?? null);
    return stmtGetMatch.get(uid);
  },
  getMatch: (urlId) => stmtGetMatch.get(urlId),
  listBotMatches: (botId, limit = 20) => stmtListBotMatches.all(botId, botId, limit),
  listOpponentMatches(botId, limit = 10, offset = 0) {
    const rows = stmtListOpponentMatches.all(botId, botId, limit, offset);
    const { cnt } = stmtCountOpponentMatches.get(botId, botId);
    return { rows, total: cnt, hasMore: offset + rows.length < cnt };
  },

  // 评分
  recordHashPair(botId, myHash, oppHash) { stmtUpsertHashPair.run(botId, myHash, oppHash); },
  getHashPair: (botId, myHash, oppHash) => stmtGetHashPair.get(botId, myHash, oppHash),
  updateRating(botId, newRating, newRp, wins, losses, draws) {
    stmtUpdateBotRating.run(newRating, newRp, wins, losses, draws, botId);
  },
  recomputeBotStats,
  getBotRankPosition(botId) { const r = stmtBotRankPos.get(botId); return r ? r.pos : null; },
  eloUpdate,

  db, // 供直接查询
};
