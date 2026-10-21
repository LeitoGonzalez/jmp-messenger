/**
 * Test automático de la Etapa 2 (requiere el servidor corriendo).
 * Uso: node scripts/test-etapa2.js
 *
 * Usa nombres con sufijo aleatorio para poder correrlo muchas veces
 * sobre la misma base sin colisiones.
 */
const WebSocket = require('ws');
const assert = require('assert/strict');
const { randomUUID } = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');

const URL = process.env.WS_URL || 'ws://localhost:3000';
const PASSWORD = '1234';
const PROJECT_USERS = ['Julieta', 'Daniela', 'Santiago', 'Alexandra', 'Leonardo'];

const pdu = (type, body) => JSON.stringify({
  head: { type, messageId: randomUUID(), timestamp: new Date().toISOString() }, body,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cliente de test: guarda todo lo recibido y permite esperar un tipo de PDU. */
class TestClient {
  constructor(label) {
    this.label = label;
    this.inbox = [];
    this.waiters = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        const i = this.waiters.findIndex((w) => w.match(msg));
        if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
        else this.inbox.push(msg);
      });
    });
  }
  send(type, body) { this.ws.send(pdu(type, body)); }
  /** Espera (o toma del buzón) una PDU del tipo dado que cumpla el predicado. */
  waitFor(type, pred = () => true, ms = 3000) {
    const match = (m) => m.head.type === type && pred(m.body);
    const i = this.inbox.findIndex(match);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const j = this.waiters.indexOf(w);
        if (j >= 0) { this.waiters.splice(j, 1); reject(new Error(`${this.label}: timeout esperando ${type}`)); }
      }, ms);
    });
  }
  has(type, pred = () => true) { return this.inbox.some((m) => m.head.type === type && pred(m.body)); }
  clear() { this.inbox = []; }
  close() { this.ws.close(1000); return sleep(100); }
}

async function tryLogin(username, password = PASSWORD) {
  const c = new TestClient(username);
  await c.connect();
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(async () => {
      if (done) return;
      done = true;
      const idx = c.waiters.indexOf(w);
      if (idx >= 0) c.waiters.splice(idx, 1);
      await c.close();
      resolve(null);
    }, 2000);

    const w = {
      match: (m) => m.head.type === 'AUTH_OK' || m.head.type === 'ERROR',
      resolve: async (msg) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (msg.head.type === 'AUTH_OK') {
          resolve({ c, ok: msg.body });
        } else {
          await c.close();
          resolve(null);
        }
      },
    };
    c.waiters.push(w);
    c.send('AUTH_REGISTER', { username, password, mode: 'login' });
  });
}

async function login(label, username, password = PASSWORD, force = true) {
  const c = new TestClient(label);
  await c.connect();
  c.send('AUTH_REGISTER', { username, password, mode: 'login', force });
  const ok = await c.waitFor('AUTH_OK');
  return { c, ok: ok.body };
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  OK   ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

(async () => {
  let carlos = null, ana = null, pedro = null;

  // Marca de agua: al final solo se borran los mensajes creados por esta corrida
  let baselineRowid = 0;
  let baselineMemberRowid = 0;
  try {
    const d = new Database(path.join(__dirname, '..', 'data', 'chat.db'), { readonly: true });
    baselineRowid = d.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM messages').get().m;
    baselineMemberRowid = d.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM channel_members').get().m;
    d.close();
  } catch (err) {}

  try {
    const CANDIDATES = ['Alexandra', 'Santiago', 'Julieta', 'Daniela', 'Leonardo'];
    const freeClients = [];

    for (const cand of CANDIDATES) {
      if (freeClients.length >= 3) break;
      const res = await tryLogin(cand);
      if (res) {
        freeClients.push({ username: cand, client: res.c, ok: res.ok });
      }
    }

    if (freeClients.length < 3) {
      for (const f of freeClients) await f.client.close();
      throw new Error('Se necesitan al menos 3 usuarios libres para ejecutar los tests.');
    }

    const [carlosData, anaData, pedroData] = freeClients;
    const names = {
      carlos: carlosData.username,
      ana: anaData.username,
      pedro: pedroData.username,
    };
    carlos = carlosData.client;
    const carlosOk = carlosData.ok;
    ana = anaData.client;
    pedro = pedroData.client;

    console.log(`\nEtapa 2 - usando usuarios existentes del proyecto: ${names.carlos}, ${names.ana}, ${names.pedro}\n`);

  await test('Autenticación con usuario existente y auto-join a #General', async () => {
    assert.deepEqual(carlosOk.joined, ['General']);
  });

  await test('Contraseña incorrecta es rechazada', async () => {
    const x = new TestClient('Intruso');
    await x.connect();
    x.send('AUTH_REGISTER', { username: names.carlos, password: 'password_erroneo', mode: 'login' });
    const err = await x.waitFor('ERROR');
    assert.match(err.body.error, /incorrect/);
    await x.close();
  });

  await test('Sesión duplicada es rechazada', async () => {
    const x = new TestClient('Duplicado');
    await x.connect();
    x.send('AUTH_REGISTER', { username: names.carlos, password: PASSWORD, mode: 'login' });
    const err = await x.waitFor('ERROR');
    assert.match(err.body.error, /sesión abierta/);
    await x.close();
  });

  await test('Los demás reciben USER_PRESENCE al conectarse alguien', async () => {
    await carlos.waitFor('USER_PRESENCE', (b) => b.username === names.ana && b.event === 'CONNECTED');
  });

  // --- Canales ---
  await test('JOIN_CHANNEL a #Redes', async () => {
    carlos.send('JOIN_CHANNEL', { channel: '#Redes' });
    const r = await carlos.waitFor('JOIN_CHANNEL');
    assert.equal(r.body.channel, 'Redes');
  });

  await test('No miembro no puede escribir en #Redes', async () => {
    ana.send('CHANNEL_MSG', { channel: 'Redes', content: 'hola?' });
    const err = await ana.waitFor('ERROR', (b) => b.refType === 'CHANNEL_MSG');
    assert.match(err.body.error, /unirte/);
  });

  await test('CHANNEL_MSG en #Redes solo llega a miembros', async () => {
    ana.clear();
    carlos.send('CHANNEL_MSG', { channel: 'Redes', content: 'Mensaje en Redes' });
    const m = await carlos.waitFor('CHANNEL_MSG', (b) => b.channel === 'Redes');
    assert.equal(m.body.from.username, names.carlos);
    await sleep(200);
    assert.equal(ana.has('CHANNEL_MSG', (b) => b.channel === 'Redes'), false, 'Ana no debería recibirlo');
  });

  await test('CHANNEL_MSG en #General llega a todos', async () => {
    ana.send('CHANNEL_MSG', { channel: 'General', content: 'Hola a todos' });
    await carlos.waitFor('CHANNEL_MSG', (b) => b.content === 'Hola a todos');
    await pedro.waitFor('CHANNEL_MSG', (b) => b.content === 'Hola a todos');
  });

  await test('Unirse a canal existente #Random con JOIN_CHANNEL', async () => {
    ana.send('JOIN_CHANNEL', { channel: 'Random' });
    const r = await ana.waitFor('JOIN_CHANNEL', (b) => b.channel === 'Random');
    assert.equal(r.body.channel, 'Random');
  });

  await test('Nombre de canal inválido es rechazado', async () => {
    ana.send('JOIN_CHANNEL', { channel: 'canal con espacios!' });
    await ana.waitFor('ERROR', (b) => b.refType === 'JOIN_CHANNEL');
  });

  // --- Privados ---
  await test('PRIVATE_MSG a usuario conectado: entrega inmediata', async () => {
    carlos.send('PRIVATE_MSG', { to: names.ana, content: 'Hola Ana (privado)' });
    const recv = await ana.waitFor('PRIVATE_MSG', (b) => b.content === 'Hola Ana (privado)');
    assert.equal(recv.body.from.username, names.carlos);
    const echo = await carlos.waitFor('PRIVATE_MSG', (b) => b.content === 'Hola Ana (privado)');
    assert.equal(echo.body.delivered, true);
  });

  await test('PRIVATE_MSG a usuario offline: queda pendiente y se entrega al reconectar', async () => {
    await pedro.close();
    await sleep(150);
    carlos.send('PRIVATE_MSG', { to: names.pedro, content: 'Te escribo offline' });
    const echo = await carlos.waitFor('PRIVATE_MSG', (b) => b.content === 'Te escribo offline');
    assert.equal(echo.body.delivered, false);

    const { c: pedro2 } = await login('Pedro2', names.pedro);
    const m = await pedro2.waitFor('PRIVATE_MSG', (b) => b.content === 'Te escribo offline');
    assert.equal(m.body.offline, true);
    await pedro2.close();
  });

  await test('PRIVATE_MSG a usuario inexistente es rechazado', async () => {
    carlos.send('PRIVATE_MSG', { to: 'NoExiste_zzz', content: 'hola' });
    await carlos.waitFor('ERROR', (b) => b.refType === 'PRIVATE_MSG');
  });

  // --- Historial ---
  await test('FETCH_HISTORY de canal devuelve los mensajes en orden', async () => {
    carlos.send('FETCH_HISTORY', { targetType: 'CHANNEL', targetId: 'Redes' });
    const h = await carlos.waitFor('HISTORY_RESPONSE', (b) => b.targetType === 'CHANNEL');
    assert.ok(h.body.messages.some((m) => m.content === 'Mensaje en Redes'));
    const ts = h.body.messages.map((m) => m.timestamp);
    assert.deepEqual(ts, [...ts].sort(), 'debe estar en orden cronológico');
  });

  await test('FETCH_HISTORY privado devuelve la conversación', async () => {
    ana.send('FETCH_HISTORY', { targetType: 'PRIVATE', targetId: names.carlos });
    const h = await ana.waitFor('HISTORY_RESPONSE', (b) => b.targetType === 'PRIVATE');
    assert.equal(h.body.messages.length, 1);
    assert.equal(h.body.messages[0].content, 'Hola Ana (privado)');
  });

  await test('Un tercero no ve conversaciones privadas ajenas', async () => {
    const { c: pedro3 } = await login('Pedro3', names.pedro);
    pedro3.send('FETCH_HISTORY', { targetType: 'PRIVATE', targetId: names.ana });
    const h = await pedro3.waitFor('HISTORY_RESPONSE');
    assert.equal(h.body.messages.length, 0);
    await pedro3.close();
  });

    // --- Desconexión ---
    await test('Al salir, los demás reciben USER_PRESENCE offline', async () => {
      await ana.close();
      await carlos.waitFor('USER_PRESENCE', (b) => b.username === names.ana && b.event === 'DISCONNECTED');
    });
  } finally {
    // Cerrar siempre todos los clientes de prueba
    await Promise.allSettled([
      carlos?.close(),
      ana?.close(),
      pedro?.close(),
    ]);

    // Limpiar mensajes temporales generados durante el test para dejar la base limpia
    try {
      const db = new Database(path.join(__dirname, '..', 'data', 'chat.db'));
      db.prepare('DELETE FROM messages WHERE rowid > ?').run(baselineRowid);
      db.prepare('DELETE FROM channel_members WHERE rowid > ?').run(baselineMemberRowid);
      db.close();
    } catch (err) {}
  }

  console.log(`\n${passed} tests OK${process.exitCode ? ' (con fallos)' : ''}\n`);
  process.exit();
})().catch((e) => { console.error(e); process.exit(1); });
