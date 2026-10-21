/**
 * scripts/clean-db.js
 * Utilidad para limpiar o reiniciar la base de datos SQLite (data/chat.db).
 *
 * Uso:
 *   npm run reset-db                   -> Reinicio completo (deja solo #General, #Redes, #Random)
 *   node scripts/clean-db.js --list    -> Ver lista actual de canales y usuarios
 *   node scripts/clean-db.js --channel <nombre>  -> Borrar un canal específico
 *   node scripts/clean-db.js --user <username>   -> Borrar un usuario específico
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'chat.db');
const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');

if (!fs.existsSync(DB_PATH)) {
  console.log('[CLEAN-DB] La base de datos no existe en ' + DB_PATH);
  process.exit(0);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const args = process.argv.slice(2);
const DEFAULT_CHANNELS = ['General', 'Redes', 'Random'];

if (args.includes('--list')) {
  console.log('\n--- CANALES REGISTRADOS ---');
  const channels = db.prepare('SELECT name, created_at FROM channels').all();
  channels.forEach((c) => console.log(`  #${c.name} (creado: ${c.created_at})`));

  console.log('\n--- USUARIOS REGISTRADOS ---');
  const users = db.prepare('SELECT id, username, status, last_seen FROM users').all();
  users.forEach((u) => console.log(`  ${u.username} (${u.status}, last_seen: ${u.last_seen || 'nunca'})`));
  console.log('');
  db.close();
  process.exit(0);
}

const channelArgIndex = args.indexOf('--channel');
if (channelArgIndex >= 0 && args[channelArgIndex + 1]) {
  const targetChannel = args[channelArgIndex + 1].replace(/^#/, '');
  console.log(`[CLEAN-DB] Eliminando canal #${targetChannel}...`);

  const deleteMsg = db.prepare("DELETE FROM messages WHERE target_type = 'CHANNEL' AND LOWER(target_id) = LOWER(?)");
  const msgResult = deleteMsg.run(targetChannel);

  const deleteCh = db.prepare('DELETE FROM channels WHERE LOWER(name) = LOWER(?)');
  const chResult = deleteCh.run(targetChannel);

  console.log(`[CLEAN-DB] Canal eliminado (${chResult.changes} canal, ${msgResult.changes} mensajes borrados).`);
  db.close();
  process.exit(0);
}

const userArgIndex = args.indexOf('--user');
if (userArgIndex >= 0 && args[userArgIndex + 1]) {
  const targetUser = args[userArgIndex + 1];
  console.log(`[CLEAN-DB] Eliminando usuario '${targetUser}'...`);

  const user = db.prepare('SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)').get(targetUser);
  if (!user) {
    console.log(`[CLEAN-DB] Usuario '${targetUser}' no encontrado.`);
    db.close();
    process.exit(1);
  }

  // Borrar mensajes enviados o recibidos
  const deleteMsgs = db.prepare(`
    DELETE FROM messages
    WHERE sender_id = ? OR (target_type = 'PRIVATE' AND target_id = ?)
  `);
  const msgResult = deleteMsgs.run(user.id, user.id);

  // Borrar usuario
  const deleteUsr = db.prepare('DELETE FROM users WHERE id = ?');
  const usrResult = deleteUsr.run(user.id);

  console.log(`[CLEAN-DB] Usuario eliminado (${usrResult.changes} usuario, ${msgResult.changes} mensajes borrados).`);
  db.close();
  process.exit(0);
}

// Por defecto o con --all / reset-db: Limpieza total
console.log('[CLEAN-DB] Ejecutando reinicio completo de base de datos...');

db.transaction(() => {
  // 1. Borrar todos los mensajes
  db.prepare('DELETE FROM messages').run();

  // 2. Borrar usuarios de prueba
  db.prepare('DELETE FROM users').run();

  // 3. Dejar solo los canales por defecto
  db.prepare("DELETE FROM channels WHERE name NOT IN ('General', 'Redes', 'Random')").run();

  // Asegurar que existan los canales por defecto
  const insertCh = db.prepare('INSERT OR IGNORE INTO channels (name, created_by, created_at) VALUES (?, NULL, ?)');
  const now = new Date().toISOString();
  for (const ch of DEFAULT_CHANNELS) {
    insertCh.run(ch, now);
  }
})();

// Limpiar archivos huérfanos de uploads si existe el directorio
if (fs.existsSync(UPLOADS_DIR)) {
  const files = fs.readdirSync(UPLOADS_DIR);
  for (const f of files) {
    try {
      fs.unlinkSync(path.join(UPLOADS_DIR, f));
    } catch (e) {
      // Ignorar si está en uso
    }
  }
  console.log(`[CLEAN-DB] Archivos subidos eliminados (${files.length} archivos).`);
}

db.pragma('vacuum');
db.close();

console.log('[CLEAN-DB] Base de datos reiniciada con exito.');
console.log('[CLEAN-DB] Canales restablecidos a: #General, #Redes, #Random.');
console.log('[CLEAN-DB] Todos los usuarios y mensajes de prueba fueron eliminados.');
