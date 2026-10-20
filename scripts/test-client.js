/**
 * Cliente de prueba por consola (para testear el servidor sin front).
 * Uso: node scripts/test-client.js <username> [password]
 * Comandos: escribir JSON crudo, o atajos:
 *   /bad          -> envía JSON malformado (prueba de validación)
 *   /raw {...}    -> envía el texto tal cual
 *   /quit
 */
const WebSocket = require('ws');
const readline = require('readline');
const { randomUUID } = require('crypto');

const username = process.argv[2] || 'Tester';
const password = process.argv[3] || '1234';
const ws = new WebSocket(process.env.WS_URL || 'ws://localhost:3000');

const pdu = (type, body) => JSON.stringify({
  head: { type, messageId: randomUUID(), timestamp: new Date().toISOString() }, body,
});

ws.on('open', () => {
  console.log(`[conectado] autenticando como ${username}...`);
  ws.send(pdu('AUTH_REGISTER', { username, password, status: 'Online' }));
});
ws.on('message', (d) => console.log('<<', d.toString()));
ws.on('close', (c) => { console.log('[cerrado]', c); process.exit(0); });
ws.on('error', (e) => console.error('[error]', e.message));

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (line === '/quit') return ws.close(1000);
  if (line === '/bad') return ws.send('{esto no es json');
  if (line.startsWith('/raw ')) return ws.send(line.slice(5));
  const [type, ...rest] = line.split(' ');
  try { ws.send(pdu(type, rest.length ? JSON.parse(rest.join(' ')) : {})); }
  catch { console.log('Formato: TIPO {json body}'); }
});
