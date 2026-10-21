/**
 * StorageEngine: persistencia física en SQLite (data/chat.db).
 *
 * Tablas:
 *   users    -> perfiles (credenciales con hash scrypt, estado, avatar)
 *   channels -> canales creados (sobreviven a reinicios)
 *   messages -> historial de canales y privados (+ flag delivered para offline)
 *
 * Nota: better-sqlite3 es síncrono, pero cada consulta tarda microsegundos
 * (base local, consultas indexadas), por lo que no bloquea el event loop
 * de forma perceptible.
 */
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'chat.db'));
db.pragma('journal_mode = WAL');   // lecturas y escrituras concurrentes sin bloquearse
db.pragma('foreign_keys = ON');

// ---------- Esquema ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    status        TEXT DEFAULT 'Online',
    avatar        TEXT,
    created_at    TEXT NOT NULL,
    last_seen     TEXT
  );

  CREATE TABLE IF NOT EXISTS channels (
    name       TEXT PRIMARY KEY COLLATE NOCASE,
    created_by TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    sender_id   TEXT NOT NULL REFERENCES users(id),
    target_type TEXT NOT NULL CHECK (target_type IN ('CHANNEL', 'PRIVATE')),
    target_id   TEXT NOT NULL,          -- nombre del canal o id del destinatario
    content     TEXT NOT NULL,
    msg_type    TEXT NOT NULL DEFAULT 'TEXT',  -- 'TEXT', 'FILE', 'IMAGE'
    delivered   INTEGER NOT NULL DEFAULT 1,    -- 0 = privado pendiente (unread)
    timestamp   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_msg_target  ON messages(target_type, target_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_msg_pending ON messages(target_id, delivered) WHERE delivered = 0;
`);

// Canales por defecto
const DEFAULT_CHANNELS = ['General', 'Redes', 'Random'];
const insertChannelStmt = db.prepare(
  'INSERT OR IGNORE INTO channels (name, created_by, created_at) VALUES (?, ?, ?)'
);
for (const name of DEFAULT_CHANNELS) insertChannelStmt.run(name, null, new Date().toISOString());

// ---------- Sentencias preparadas (se compilan una vez, evitan SQL injection) ----------
const stmts = {
  getUserByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  getUserById:   db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser:    db.prepare(`INSERT INTO users (id, username, password_hash, status, avatar, created_at, last_seen)
                             VALUES (@id, @username, @password_hash, @status, @avatar, @created_at, @created_at)`),
  updateProfile: db.prepare('UPDATE users SET status = COALESCE(@status, status), avatar = COALESCE(@avatar, avatar) WHERE id = @id'),
  touchUser:     db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),
  listUsers:     db.prepare('SELECT id, username, status, avatar, last_seen FROM users ORDER BY username'),

  listChannels:  db.prepare('SELECT name FROM channels ORDER BY created_at, name'),
  getChannel:    db.prepare('SELECT name FROM channels WHERE name = ?'),

  insertMsg: db.prepare(`INSERT INTO messages (id, sender_id, target_type, target_id, content, msg_type, delivered, timestamp)
                         VALUES (@id, @sender_id, @target_type, @target_id, @content, @msg_type, @delivered, @timestamp)`),
  pendingFor: db.prepare(`SELECT m.*, u.username AS sender_name FROM messages m
                          JOIN users u ON u.id = m.sender_id
                          WHERE m.target_type = 'PRIVATE' AND m.target_id = ? AND m.delivered = 0
                          ORDER BY m.timestamp`),
  markDelivered: db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?'),

  channelHistory: db.prepare(`SELECT * FROM (
                                SELECT m.*, u.username AS sender_name FROM messages m
                                JOIN users u ON u.id = m.sender_id
                                WHERE m.target_type = 'CHANNEL' AND m.target_id = ?
                                ORDER BY m.timestamp DESC, m.rowid DESC LIMIT ?
                              ) ORDER BY timestamp ASC`),
  privateHistory: db.prepare(`SELECT * FROM (
                                SELECT m.*, u.username AS sender_name FROM messages m
                                JOIN users u ON u.id = m.sender_id
                                WHERE m.target_type = 'PRIVATE'
                                  AND ((m.sender_id = @a AND m.target_id = @b) OR (m.sender_id = @b AND m.target_id = @a))
                                ORDER BY m.timestamp DESC, m.rowid DESC LIMIT @limit
                              ) ORDER BY timestamp ASC`),

  channelLastMsg: db.prepare(`SELECT target_id AS channel, MAX(timestamp) AS last_ts
                              FROM messages WHERE target_type = 'CHANNEL' GROUP BY target_id`),
  privateLastMsg: db.prepare(`SELECT u.username, MAX(m.timestamp) AS last_ts
                              FROM messages m
                              JOIN users u ON u.id = CASE WHEN m.sender_id = ? THEN m.target_id ELSE m.sender_id END
                              WHERE m.target_type = 'PRIVATE' AND (m.sender_id = ? OR m.target_id = ?)
                              GROUP BY u.username`),
};

// ---------- API ----------
function getUserByName(username) { return stmts.getUserByName.get(username) || null; }
function getUserById(id) { return stmts.getUserById.get(id) || null; }

function createUser({ username, passwordHash, status = 'Online', avatar = null }) {
  const user = {
    id: 'u_' + randomUUID().slice(0, 8),
    username,
    password_hash: passwordHash,
    status,
    avatar,
    created_at: new Date().toISOString(),
  };
  stmts.insertUser.run(user);
  return getUserById(user.id);
}

function updateProfile(id, { status = null, avatar = null }) {
  return stmts.updateProfile.run({ id, status: status || null, avatar: avatar || null });
}

function touchUser(id) { stmts.touchUser.run(new Date().toISOString(), id); }
function listUsers() { return stmts.listUsers.all(); }

function listChannels() { return stmts.listChannels.all().map((r) => r.name); }
function getChannel(name) { return stmts.getChannel.get(name)?.name || null; }
function createChannel(name, createdBy) {
  insertChannelStmt.run(name, createdBy, new Date().toISOString());
  return getChannel(name);
}

/** INSERT de un mensaje. Devuelve el registro guardado. */
function saveMessage({ senderId, targetType, targetId, content, msgType = 'TEXT', delivered = 1 }) {
  const row = {
    id: randomUUID(),
    sender_id: senderId,
    target_type: targetType,
    target_id: targetId,
    content,
    msg_type: msgType,
    delivered: delivered ? 1 : 0,
    timestamp: new Date().toISOString(),
  };
  stmts.insertMsg.run(row);
  return row;
}

function getPendingFor(userId) { return stmts.pendingFor.all(userId); }

/** Marca varios mensajes como entregados en una sola transacción. */
const markDelivered = db.transaction((ids) => {
  for (const id of ids) stmts.markDelivered.run(id);
});

function getHistory(targetType, targetId, { requesterId, limit = 50 } = {}) {
  limit = Math.min(Math.max(1, limit | 0), 200);
  if (targetType === 'CHANNEL') return stmts.channelHistory.all(targetId, limit);
  return stmts.privateHistory.all({ a: requesterId, b: targetId, limit });
}

function getLastActivity(userId) {
  const activity = {};
  if (!userId) return activity;
  try {
    const channelRows = stmts.channelLastMsg.all();
    for (const r of channelRows) activity[`CHANNEL:${r.channel}`] = r.last_ts;

    const privateRows = stmts.privateLastMsg.all(userId, userId, userId);
    for (const r of privateRows) activity[`PRIVATE:${r.username}`] = r.last_ts;
  } catch (err) {
    // Si la tabla no tuviese mensajes o fallara la consulta
  }
  return activity;
}

function close() { db.close(); }

module.exports = {
  getUserByName, getUserById, createUser, updateProfile, touchUser, listUsers,
  listChannels, getChannel, createChannel,
  saveMessage, getPendingFor, markDelivered, getHistory, getLastActivity,
  close,
};
