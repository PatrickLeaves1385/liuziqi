'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');

const db = new DatabaseSync(path.join(__dirname, 'sixchess.db'));

db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS accounts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT    UNIQUE NOT NULL,
  email      TEXT    UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bots (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id           INTEGER UNIQUE NOT NULL,
  name                 TEXT    NOT NULL,
  avatar               TEXT    NOT NULL DEFAULT '🤖',
  template_name        TEXT    NOT NULL,
  current_version      INTEGER NOT NULL DEFAULT 0,
  rating               INTEGER NOT NULL DEFAULT 1200,
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
`);

// ---- 工具函数 ----
function hashKey(key) { return crypto.createHash('sha256').update(key).digest('hex'); }
function codeHash(code) { return crypto.createHash('sha256').update(code.trim()).digest('hex').slice(0, 16); }
function generateKey() { return 'sk_' + crypto.randomBytes(24).toString('base64url'); }
function urlId() { return crypto.randomBytes(8).toString('hex'); }
function now() { return Date.now(); }

// ---- 账号 ----
const stmtInsertAccount = db.prepare('INSERT INTO accounts(username,email,created_at) VALUES(?,?,?)');
const stmtGetAccountByEmail = db.prepare('SELECT * FROM accounts WHERE email=?');
const stmtGetAccountByUsername = db.prepare('SELECT * FROM accounts WHERE username=?');

// ---- 棋手 ----
const stmtInsertBot = db.prepare('INSERT INTO bots(account_id,name,avatar,template_name,created_at) VALUES(?,?,?,?,?)');
const stmtGetBotById = db.prepare('SELECT * FROM bots WHERE id=?');
const stmtGetBotByAccount = db.prepare('SELECT * FROM bots WHERE account_id=?');
const stmtUpdateBotVersion = db.prepare('UPDATE bots SET current_version=? WHERE id=?');
const stmtUpdateBotRating = db.prepare('UPDATE bots SET rating=?,wins=wins+?,losses=losses+?,draws=draws+? WHERE id=?');
const stmtListBots = db.prepare('SELECT b.*,a.username FROM bots b JOIN accounts a ON b.account_id=a.id ORDER BY b.rating DESC LIMIT 100');

// ---- API Key ----
const stmtInsertKey = db.prepare('INSERT INTO api_keys(bot_id,key_hash,key_prefix,created_at) VALUES(?,?,?,?)');
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
const stmtUpdateSmokeStatus = db.prepare('UPDATE code_versions SET smoke_status=?,smoke_detail=? WHERE bot_id=? AND version=?');
const stmtGetVersion = db.prepare('SELECT * FROM code_versions WHERE bot_id=? AND version=?');
const stmtListVersions = db.prepare('SELECT id,bot_id,version,code_hash,notes,submitted_by,smoke_status,created_at FROM code_versions WHERE bot_id=? ORDER BY version DESC LIMIT 50');
const stmtGetCurrentCode = db.prepare('SELECT * FROM code_versions WHERE bot_id=? AND smoke_status=? ORDER BY version DESC LIMIT 1');

// ---- 对局 ----
const stmtInsertMatch = db.prepare(`
  INSERT INTO matches(match_url_id,challenger_bot_id,challenged_bot_id,ch_code_version,cd_code_version,
    ch_code_hash,cd_code_hash,winner,reason,turns,final_challenger_pieces,final_challenged_pieces,
    game_json,challenger_side,seed,played_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
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
  createAccount(username, email) {
    stmtInsertAccount.run(username, email, now());
    return stmtGetAccountByEmail.get(email);
  },
  getAccountByEmail: (email) => stmtGetAccountByEmail.get(email),
  getAccountByUsername: (username) => stmtGetAccountByUsername.get(username),

  // 棋手
  createBot(accountId, name, avatar, templateName) {
    stmtInsertBot.run(accountId, name, avatar, templateName, now());
    return stmtGetBotByAccount.get(accountId);
  },
  getBotById: (id) => stmtGetBotById.get(id),
  getBotByAccount: (accountId) => stmtGetBotByAccount.get(accountId),
  listBots: () => stmtListBots.all(),

  // API Key
  createApiKey(botId) {
    const key = generateKey();
    stmtInsertKey.run(botId, hashKey(key), key.slice(0, 8), now());
    return key;
  },
  getBotByApiKey: (key) => stmtGetBotByKey.get(hashKey(key)),

  // 代码版本
  submitCodeVersion(botId, version, code, notes, submittedBy) {
    const hash = codeHash(code);
    stmtInsertVersion.run(botId, version, code, hash, notes || null, submittedBy || null, 'pending', null, now());
    return stmtGetVersion.get(botId, version);
  },
  updateSmokeStatus(botId, version, status, detail) {
    stmtUpdateSmokeStatus.run(status, detail || null, botId, version);
    if (status === 'passed') stmtUpdateBotVersion.run(version, botId);
  },
  getVersion: (botId, version) => stmtGetVersion.get(botId, version),
  listVersions: (botId) => stmtListVersions.all(botId),
  getLatestPassedVersion(botId) { return stmtGetCurrentCode.get(botId, 'passed'); },

  // 对局
  saveMatch({ urlId: uid, challengerBotId, challengedBotId, chVer, cdVer, chHash, cdHash, winner, reason, turns, finalCh, finalCd, gameJson, challengerSide, seed }) {
    stmtInsertMatch.run(uid, challengerBotId, challengedBotId, chVer, cdVer, chHash, cdHash, winner, reason, turns, finalCh, finalCd, JSON.stringify(gameJson), challengerSide, seed, now());
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
  updateRating(botId, newRating, wins, losses, draws) {
    stmtUpdateBotRating.run(newRating, wins, losses, draws, botId);
  },
  eloUpdate,

  db, // 供直接查询
};
