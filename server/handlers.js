/**
 * Handlers de cada primitiva JMP.
 * Etapa 1: AUTH_REGISTER + USER_PRESENCE + desconexión.
 * El resto de primitivas se implementan en las próximas etapas.
 */
const { randomUUID } = require('crypto');
const { build, TYPES } = require('./protocol');
const state = require('./state');
const logger = require('./logger');

/** Envío seguro: captura EPIPE / socket cerrado sin romper el servidor. */
function safeSend(socket, data) {
  try {
    if (socket.readyState === socket.OPEN) socket.send(data);
  } catch (err) {
    logger.warn('-', 'SEND_ERROR', `${err.code || ''} ${err.message}`);
  }
}

/** Envía a todos los clientes autenticados (opcionalmente excluyendo uno). */
function broadcast(data, exceptUserId = null) {
  for (const [id, c] of state.clients) {
    if (id !== exceptUserId) safeSend(c.socket, data);
  }
}

function sendError(ctx, error) {
  logger.warn(ctx.addr, 'REJECTED', error);
  safeSend(ctx.socket, build(TYPES.ERROR, { error }));
}

// ---------- A. Sesión ----------
function onAuthRegister(ctx, body) {
  if (ctx.userId) return sendError(ctx, 'Ya estás autenticado');

  const username = body.username.trim();
  if (!/^[\w.\-áéíóúñÁÉÍÓÚÑ]{2,20}$/.test(username)) {
    return sendError(ctx, 'Username inválido (2-20 caracteres alfanuméricos)');
  }
  if (state.findByUsername(username)) {
    return sendError(ctx, `El usuario '${username}' ya está conectado`);
  }

  const userId = 'user_' + randomUUID().slice(0, 8);
  ctx.userId = userId;
  state.addClient(userId, {
    socket: ctx.socket,
    username,
    status: typeof body.status === 'string' ? body.status : 'Online',
    avatar: typeof body.avatar === 'string' ? body.avatar : null,
    ip: ctx.ip,
    port: ctx.port,
  });

  logger.info(ctx.addr, 'AUTH', `Usuario '${username}' autenticado exitosamente (${userId}).`);

  // Respuesta al propio cliente con su id + estado global
  safeSend(ctx.socket, build(TYPES.AUTH_OK, {
    userId, username,
    users: state.publicUsers(),
    channels: state.channelList(),
  }));

  // Notificación de presencia al resto
  const c = state.clients.get(userId);
  broadcast(build(TYPES.USER_PRESENCE, {
    userId, username, status: c.status, avatar: c.avatar, event: 'CONNECTED',
  }), userId);
}

function onDisconnect(ctx) {
  if (!ctx.userId) return;
  const c = state.clients.get(ctx.userId);
  state.removeClient(ctx.userId);
  if (c) {
    broadcast(build(TYPES.USER_PRESENCE, {
      userId: ctx.userId, username: c.username, status: 'Offline', event: 'DISCONNECTED',
    }));
  }
}

// ---------- Router ----------
const routes = {
  [TYPES.AUTH_REGISTER]: onAuthRegister,
};

function dispatch(ctx, pdu) {
  const { type } = pdu.head;

  // Todo excepto AUTH_REGISTER requiere sesión
  if (type !== TYPES.AUTH_REGISTER && !ctx.userId) {
    logger.warn(ctx.addr, 'UNAUTHORIZED', `Intento de ${type} sin autenticar.`);
    return sendError(ctx, 'Debes autenticarte primero (AUTH_REGISTER)');
  }

  const handler = routes[type];
  if (!handler) return sendError(ctx, `Primitiva ${type} aún no implementada`);
  handler(ctx, pdu.body, pdu);
}

module.exports = { dispatch, onDisconnect, safeSend, broadcast };
