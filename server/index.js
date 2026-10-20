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
const storage = require('./storage');

const fs = require('fs');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 3000;
const HEARTBEAT_MS = 30_000;   // ping cada 30 s
const MAX_MISSED_PINGS = 2;    // 2 pings sin pong => desconexión

// ---------- HTTP ----------
const app = express();
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(express.static(path.join(__dirname, '..', 'client')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.json({ limit: '10mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, clients: state.clients.size }));

app.post('/api/upload', (req, res) => {
  try {
    const { fileName, fileData } = req.body || {};
    if (!fileName || typeof fileName !== 'string' || !fileData || typeof fileData !== 'string') {
      return res.status(400).json({ ok: false, error: 'Parámetros "fileName" y "fileData" requeridos' });
    }

    const matches = fileData.match(/^data:([^;]+);base64,(.+)$/);
    const base64Content = matches ? matches[2] : fileData;
    const buffer = Buffer.from(base64Content, 'base64');

    if (buffer.length === 0) {
      return res.status(400).json({ ok: false, error: 'El archivo está vacío o el formato Base64 es inválido' });
    }

    const ext = path.extname(fileName).slice(0, 10).replace(/[^a-zA-Z0-9.]/g, '') || '.bin';
    const uniqueName = `${randomUUID()}${ext}`;
    const targetPath = path.join(UPLOADS_DIR, uniqueName);

    fs.writeFileSync(targetPath, buffer);

    const fileUrl = `/uploads/${uniqueName}`;
    logger.info(req.ip || 'HTTP', 'UPLOAD', `Archivo subido: '${fileName}' (${(buffer.length / 1024).toFixed(1)} KB) -> ${fileUrl}`);

    res.json({
      ok: true,
      fileUrl,
      fileName: path.basename(fileName).slice(0, 100),
      fileSize: buffer.length,
    });
  } catch (err) {
    logger.error('HTTP', 'UPLOAD_ERROR', err.message);
    res.status(500).json({ ok: false, error: 'Error interno al procesar el archivo' });
  }
});

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
  server.close(() => { storage.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 1000);
});

// Última red de seguridad: registrar en vez de morir sin rastro
process.on('uncaughtException', (err) => logger.error('-', 'UNCAUGHT', err.stack || err.message));
process.on('unhandledRejection', (err) => logger.error('-', 'UNHANDLED', err?.stack || String(err)));
