/**
 * Servidor Central / Broker del chat.
 *  - HTTP (Express): sirve el cliente web y (más adelante) /api/upload.
 *  - WebSocket (ws): canal persistente full-duplex sobre TCP con cada cliente.
 * Concurrencia: event loop asíncrono de Node.js (E/S no bloqueante).
 */
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const logger = require('./logger');
const { parse, build, TYPES } = require('./protocol');
const state = require('./state');
const handlers = require('./handlers');

const PORT = process.env.PORT || 3000;
const HEARTBEAT_MS = 30_000;   // ping cada 30 s
const MAX_MISSED_PINGS = 2;    // 2 pings sin pong => desconexión

// ---------- HTTP ----------
const app = express();
app.use(express.static(path.join(__dirname, '..', 'client')));
app.get('/api/health', (_req, res) => res.json({ ok: true, clients: state.clients.size }));

const server = http.createServer(app);

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });

wss.on('connection', (socket, req) => {
  // Demultiplexación L4: cada socket queda identificado por IP:PUERTO remoto.
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
  const port = req.socket.remotePort;
  const ctx = { socket, ip, port, addr: `${ip}:${port}`, userId: null, missedPings: 0 };

  logger.info(ctx.addr, 'CONNECT', 'Nueva conexión socket establecida.');

  socket.on('pong', () => { ctx.missedPings = 0; });

  socket.on('message', (raw) => {
    try {
      const result = parse(raw);
      if (!result.ok) {
        logger.warn(ctx.addr, 'BAD_PDU', result.error);
        handlers.safeSend(socket, build(TYPES.ERROR, { error: result.error }));
        return;
      }
      handlers.dispatch(ctx, result.pdu);
    } catch (err) {
      // Nunca dejamos que un paquete tire abajo el servidor.
      logger.error(ctx.addr, 'HANDLER', err.stack || err.message);
    }
  });

  socket.on('close', (code) => {
    const who = ctx.userId ? state.clients.get(ctx.userId)?.username : ctx.addr;
    if (code === 1000 || code === 1001) {
      logger.info(ctx.addr, 'DISCONNECT', `Conexión cerrada por el cliente (${who}).`);
    } else {
      logger.warn(ctx.addr, 'DISCONNECT', `Conexión cerrada inesperadamente (code ${code}) (${who}).`);
    }
    handlers.onDisconnect(ctx);
  });

  socket.on('error', (err) => {
    // ECONNRESET, EPIPE, etc. (errores de la capa de transporte)
    logger.warn(ctx.addr, 'SOCKET_ERROR', `${err.code || ''} ${err.message}`);
  });

  socket._ctx = ctx;
});

// ---------- Heartbeat (Ping/Pong) ----------
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    const ctx = socket._ctx;
    if (ctx.missedPings >= MAX_MISSED_PINGS) {
      logger.warn(ctx.addr, 'TIMEOUT', `Sin respuesta a ${MAX_MISSED_PINGS} pings. Cerrando socket.`);
      socket.terminate(); // dispara 'close' => onDisconnect => USER_PRESENCE offline
      continue;
    }
    ctx.missedPings++;
    try { socket.ping(); } catch (err) {
      logger.warn(ctx.addr, 'PING_ERROR', err.message);
    }
  }
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  logger.info(`0.0.0.0:${PORT}`, 'START', `Servidor escuchando en http://localhost:${PORT} (HTTP + WebSocket)`);
});

// Cierre limpio con Ctrl+C
process.on('SIGINT', () => {
  logger.info(`0.0.0.0:${PORT}`, 'SHUTDOWN', 'Apagando servidor...');
  for (const s of wss.clients) s.close(1001, 'Server shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
});
