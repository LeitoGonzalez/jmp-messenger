/**
 * Handlers de cada primitiva JMP + router.
 *
 * Etapa 1: AUTH_REGISTER, USER_PRESENCE, desconexión.
 * Etapa 2: login con contraseña, JOIN/LEAVE_CHANNEL, CHANNEL_MSG (pub/sub),
 *          PRIVATE_MSG (unicast + entrega diferida), FETCH_HISTORY.
 */
const path = require('path');
const crypto = require('crypto');
const { build, TYPES } = require('./protocol');
const state = require('./state');
const storage = require('./storage');
const { hashPassword, verifyPassword } = require('./auth');
const logger = require('./logger');

const USERNAME_RE = /^[\w.\-áéíóúñÁÉÍÓÚÑ]{2,20}$/;
const CHANNEL_RE = /^[\w\-áéíóúñÁÉÍÓÚÑ]{2,24}$/;
const MIN_PASSWORD = 4;
const MAX_CONTENT = 4000;
const DEFAULT_CHANNEL = 'General';

// Validación estricta de datos que luego el cliente renderiza (evita XSS almacenado)
const AVATAR_RE = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const FILE_URL_RE = /^\/uploads\/[A-Za-z0-9-]+\.[A-Za-z0-9]{1,10}$/;

// Tokens de sesión (en memoria): permiten reanudar sesión y autorizar /api/upload
// sin guardar la contraseña en el navegador.
const tokens = new Map(); // token -> userId
function issueToken(userId) {
  for (const [t, id] of tokens) if (id === userId) tokens.delete(t);
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, userId);
  return token;
}
function isValidToken(token) { return typeof token === 'string' && tokens.has(token); }

// ======================================================================
// Utilidades de envío
// ======================================================================

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

/** Envía a los miembros conectados de un canal. Devuelve cuántos lo recibieron. */
function sendToChannel(channel, data, exceptUserId = null) {
  let n = 0;
  for (const userId of state.channelMembers(channel)) {
    if (userId === exceptUserId) continue;
    const c = state.clients.get(userId);
    if (c) { safeSend(c.socket, data); n++; }
  }
  return n;
}

function sendError(ctx, error, refType = null) {
  logger.warn(ctx.username || ctx.addr, 'REJECTED', error);
  safeSend(ctx.socket, build(TYPES.ERROR, { error, refType }));
}

function broadcastChannelList() {
  broadcast(build(TYPES.CHANNEL_LIST, { channels: state.channelList() }));
}

/** Normaliza el nombre de canal: quita '#' y espacios. */
function cleanChannelName(raw) {
  return raw.trim().replace(/^#/, '');
}

/** Convierte una fila de messages a la forma que viaja en el protocolo. */
function toWire(row, senderName) {
  return {
    id: row.id,
    from: { userId: row.sender_id, username: senderName ?? row.sender_name },
    targetType: row.target_type,
    targetId: row.target_id,
    content: row.content,
    msgType: row.msg_type,
    timestamp: row.timestamp,
  };
}

// ======================================================================
// A. Sesión
// ======================================================================

/**
 * AUTH_REGISTER: si el username no existe lo REGISTRA; si existe hace LOGIN
 * verificando la contraseña. Es async porque scrypt corre en el thread pool.
 */
async function onAuthRegister(ctx, body) {
  if (ctx.userId) return sendError(ctx, 'Ya estás autenticado', TYPES.AUTH_REGISTER);
  if (ctx.authPending) return sendError(ctx, 'Autenticación en curso', TYPES.AUTH_REGISTER);

  const username = body.username.trim();
  const { password } = body;
  if (!USERNAME_RE.test(username)) {
    return sendError(ctx, 'Username inválido (2-20 caracteres: letras, números, . _ -)', TYPES.AUTH_REGISTER);
  }
  if (password.length < MIN_PASSWORD) {
    return sendError(ctx, `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`, TYPES.AUTH_REGISTER);
  }

  ctx.authPending = true;
  let user, isNew = false;
  try {
    user = storage.getUserByName(username);
    const mode = typeof body.mode === 'string' ? body.mode.toLowerCase() : 'login';

    if (mode === 'resume') {
      // Reanudar sesión con el token del login anterior (el campo password lleva el token)
      if (!user || tokens.get(password) !== user.id) {
        return sendError(ctx, 'Sesión expirada, iniciá sesión nuevamente', TYPES.AUTH_REGISTER);
      }
    } else if (mode === 'login') {
      // Modo LOGIN estricto: el usuario DEBE existir en la base de datos
      if (!user) {
        logger.warn(ctx.addr, 'AUTH_FAIL', `Intento de login con usuario inexistente: '${username}'.`);
        return sendError(ctx, 'El usuario no existe. Seleccioná "Crear Cuenta" para registrarte.', TYPES.AUTH_REGISTER);
      }
      if (!(await verifyPassword(password, user.password_hash))) {
        logger.warn(ctx.addr, 'AUTH_FAIL', `Contraseña incorrecta para '${username}'.`);
        return sendError(ctx, 'Contraseña incorrecta', TYPES.AUTH_REGISTER);
      }
    } else if (mode === 'register') {
      // Modo REGISTRO estricto: el usuario NO debe existir previamente
      if (user) {
        logger.warn(ctx.addr, 'AUTH_FAIL', `Intento de registro con usuario ya existente: '${username}'.`);
        return sendError(ctx, `El usuario '${username}' ya está registrado. Iniciá sesión con tu contraseña.`, TYPES.AUTH_REGISTER);
      }
      const passwordHash = await hashPassword(password);
      if (storage.getUserByName(username)) {
        return sendError(ctx, 'Ese usuario acaba de ser registrado, probá de nuevo', TYPES.AUTH_REGISTER);
      }
      user = storage.createUser({ username, passwordHash });
      isNew = true;
    } else {
      return sendError(ctx, `Modo de autenticación inválido: '${mode}'`, TYPES.AUTH_REGISTER);
    }
  } finally {
    ctx.authPending = false;
  }

  // El socket pudo cerrarse mientras se calculaba el hash
  if (ctx.socket.readyState !== ctx.socket.OPEN) return;
  if (state.isOnline(user.id)) {
    return sendError(ctx, `El usuario '${user.username}' ya tiene una sesión abierta`, TYPES.AUTH_REGISTER);
  }

  // Perfil opcional enviado en el registro/login
  const status = typeof body.status === 'string' ? body.status.slice(0, 30) : 'Online';
  const avatar = typeof body.avatar === 'string' && AVATAR_RE.test(body.avatar) ? body.avatar : null;
  storage.updateProfile(user.id, { status, avatar });
  storage.touchUser(user.id);

  ctx.userId = user.id;
  ctx.username = user.username;
  state.addClient(user.id, {
    socket: ctx.socket,
    username: user.username,
    status,
    avatar: avatar ?? user.avatar,
    ip: ctx.ip,
    port: ctx.port,
  });

  logger.info(ctx.addr, 'AUTH',
    `Usuario '${user.username}' ${isNew ? 'registrado' : 'autenticado'} exitosamente (${user.id}).`);

  // Auto-join a #General y restauración de los canales a los que el usuario ya pertenecía
  state.joinChannel(DEFAULT_CHANNEL, user.id);
  storage.addMember(user.id, DEFAULT_CHANNEL);
  const joined = new Set([DEFAULT_CHANNEL]);
  for (const name of storage.getMemberships(user.id)) {
    const ch = state.resolveChannel(name);
    if (ch) { state.joinChannel(ch, user.id); joined.add(ch); }
  }
  logger.action(user.username, 'JOIN_CHANNEL', `Canales restaurados: ${[...joined].map((c) => '#' + c).join(', ')}.`);

  // Respuesta al propio cliente
  safeSend(ctx.socket, build(TYPES.AUTH_OK, {
    userId: user.id,
    username: user.username,
    isNew,
    joined: [...joined],
    token: issueToken(user.id),
    users: state.publicUsers(),
    channels: state.channelList(),
    lastActivity: storage.getLastActivity(user.id),
  }));

  // Presencia al resto
  const c = state.clients.get(user.id);
  broadcast(build(TYPES.USER_PRESENCE, {
    userId: user.id, username: user.username, status: c.status, avatar: c.avatar,
    online: true, event: 'CONNECTED',
  }), user.id);

  sendToChannel(DEFAULT_CHANNEL, build(TYPES.CHANNEL_EVENT, {
    channel: DEFAULT_CHANNEL, userId: user.id, username: user.username, event: 'JOINED',
  }), user.id);
  broadcastChannelList();

  deliverPending(ctx);
}

/** Entrega los PRIVATE_MSG que llegaron mientras el usuario estaba offline. */
function deliverPending(ctx) {
  const pending = storage.getPendingFor(ctx.userId);
  if (!pending.length) return;

  for (const row of pending) {
    const isFile = row.msg_type === 'FILE';
    const type = isFile ? TYPES.FILE_OFFER : TYPES.PRIVATE_MSG;
    safeSend(ctx.socket, build(type, {
      ...toWire(row),
      fileUrl: isFile ? row.content : undefined,
      fileName: isFile ? path.basename(row.content) : undefined,
      offline: true,
    }));
  }
  storage.markDelivered(pending.map((r) => r.id));
  logger.action(ctx.username, 'DELIVER_PENDING', `${pending.length} mensaje(s) / archivo(s) entregado(s) al reconectar.`);
}

function onDisconnect(ctx) {
  if (!ctx.userId) return;
  const c = state.clients.get(ctx.userId);
  const leftChannels = state.removeClient(ctx.userId);
  storage.touchUser(ctx.userId);
  if (!c) return;

  for (const channel of leftChannels) {
    sendToChannel(channel, build(TYPES.CHANNEL_EVENT, {
      channel, userId: ctx.userId, username: c.username, event: 'LEFT',
    }));
  }
  broadcast(build(TYPES.USER_PRESENCE, {
    userId: ctx.userId, username: c.username, status: 'Offline', online: false, event: 'DISCONNECTED',
  }));
  broadcastChannelList();
}

function onProfileUpdate(ctx, body) {
  if (!ctx.userId) return sendError(ctx, 'Debes autenticarte primero', TYPES.PROFILE_UPDATE);

  const status = typeof body.status === 'string' && body.status.trim() ? body.status.trim().slice(0, 30) : null;
  const avatar = typeof body.avatar === 'string' && AVATAR_RE.test(body.avatar) ? body.avatar : null;

  if (!status && !avatar) {
    return sendError(ctx, 'Debe proporcionar al menos status o avatar válido', TYPES.PROFILE_UPDATE);
  }

  storage.updateProfile(ctx.userId, { status, avatar });

  const client = state.clients.get(ctx.userId);
  if (client) {
    if (status) client.status = status;
    if (avatar) client.avatar = avatar;
  }

  const currentStatus = client ? client.status : (status || 'Online');
  const currentAvatar = client ? client.avatar : avatar;

  // Confirmación al propio cliente
  safeSend(ctx.socket, build(TYPES.PROFILE_UPDATE, {
    userId: ctx.userId,
    username: ctx.username,
    status: currentStatus,
    avatar: currentAvatar,
    ok: true,
  }));

  // Notificación en broadcast con USER_PRESENCE a todos
  broadcast(build(TYPES.USER_PRESENCE, {
    userId: ctx.userId,
    username: ctx.username,
    status: currentStatus,
    avatar: currentAvatar,
    online: true,
    event: 'PROFILE_UPDATED',
  }));

  logger.action(ctx.username, 'PROFILE_UPDATE', `Perfil actualizado (${status ? 'estado: "' + status + '"' : ''}${status && avatar ? ', ' : ''}${avatar ? 'avatar Base64' : ''}).`);
}

// ======================================================================
// B. Canales y mensajería
// ======================================================================

function onJoinChannel(ctx, body) {
  const requested = cleanChannelName(body.channel);
  if (!CHANNEL_RE.test(requested)) {
    return sendError(ctx, 'Nombre de canal inválido (2-24 caracteres: letras, números, _ -)', TYPES.JOIN_CHANNEL);
  }

  let channel = state.resolveChannel(requested);
  let created = false;
  if (!channel) {
    channel = storage.createChannel(requested, ctx.userId);
    state.createChannel(channel);
    created = true;
    logger.action(ctx.username, 'CREATE_CHANNEL', `Canal '#${channel}' creado.`);
  }
  if (state.isMember(channel, ctx.userId)) {
    return sendError(ctx, `Ya sos miembro de '#${channel}'`, TYPES.JOIN_CHANNEL);
  }

  state.joinChannel(channel, ctx.userId);
  storage.addMember(ctx.userId, channel);
  logger.action(ctx.username, 'JOIN_CHANNEL', `Unido a canal '#${channel}'.`);

  safeSend(ctx.socket, build(TYPES.JOIN_CHANNEL, { channel, created, ok: true }));
  sendToChannel(channel, build(TYPES.CHANNEL_EVENT, {
    channel, userId: ctx.userId, username: ctx.username, event: 'JOINED',
  }), ctx.userId);
  broadcastChannelList();
}

function onLeaveChannel(ctx, body) {
  const channel = state.resolveChannel(cleanChannelName(body.channel));
  if (!channel || !state.leaveChannel(channel, ctx.userId)) {
    return sendError(ctx, `No sos miembro de '#${body.channel}'`, TYPES.LEAVE_CHANNEL);
  }
  storage.removeMember(ctx.userId, channel);
  logger.action(ctx.username, 'LEAVE_CHANNEL', `Salió del canal '#${channel}'.`);

  safeSend(ctx.socket, build(TYPES.LEAVE_CHANNEL, { channel, ok: true }));
  sendToChannel(channel, build(TYPES.CHANNEL_EVENT, {
    channel, userId: ctx.userId, username: ctx.username, event: 'LEFT',
  }));
  broadcastChannelList();
}

function validateContent(ctx, content, refType) {
  const text = content.trim();
  if (!text) { sendError(ctx, 'Mensaje vacío', refType); return null; }
  if (text.length > MAX_CONTENT) { sendError(ctx, `Mensaje demasiado largo (máx ${MAX_CONTENT})`, refType); return null; }
  return text;
}

/**
 * CHANNEL_MSG (Pub/Sub): channels[canal] -> userIds -> clients[userId].socket
 * El emisor también lo recibe (confirmación con id y timestamp del servidor).
 */
function onChannelMsg(ctx, body) {
  const channel = state.resolveChannel(cleanChannelName(body.channel));
  if (!channel) return sendError(ctx, `El canal '#${body.channel}' no existe`, TYPES.CHANNEL_MSG);
  if (!state.isMember(channel, ctx.userId)) {
    return sendError(ctx, `Debés unirte a '#${channel}' antes de escribir`, TYPES.CHANNEL_MSG);
  }
  const content = validateContent(ctx, body.content, TYPES.CHANNEL_MSG);
  if (content === null) return;

  const row = storage.saveMessage({
    senderId: ctx.userId, targetType: 'CHANNEL', targetId: channel, content,
  });
  const n = sendToChannel(channel, build(TYPES.CHANNEL_MSG, { ...toWire(row, ctx.username), channel }));
  logger.action(ctx.username, 'CHANNEL_MSG', `'#${channel}' -> ${n} destinatario(s) (${content.length} caracteres).`);
}

/**
 * PRIVATE_MSG (Unicast): busca el socket del destinatario.
 *  - Conectado    -> entrega inmediata (delivered = 1).
 *  - Desconectado -> queda en SQLite con delivered = 0 hasta que se conecte.
 */
function onPrivateMsg(ctx, body) {
  const target = storage.getUserByName(body.to.trim());
  if (!target) return sendError(ctx, `El usuario '${body.to}' no existe`, TYPES.PRIVATE_MSG);
  if (target.id === ctx.userId) return sendError(ctx, 'No podés enviarte mensajes a vos mismo', TYPES.PRIVATE_MSG);

  const content = validateContent(ctx, body.content, TYPES.PRIVATE_MSG);
  if (content === null) return;

  const targetClient = state.clients.get(target.id);
  const delivered = Boolean(targetClient);
  const row = storage.saveMessage({
    senderId: ctx.userId, targetType: 'PRIVATE', targetId: target.id, content, delivered,
  });

  const wire = { ...toWire(row, ctx.username), to: { userId: target.id, username: target.username } };
  if (targetClient) safeSend(targetClient.socket, build(TYPES.PRIVATE_MSG, wire));
  // Copia al emisor con el estado de entrega
  safeSend(ctx.socket, build(TYPES.PRIVATE_MSG, { ...wire, delivered }));

  logger.action(`${ctx.username} -> ${target.username}`, 'PRIVATE_MSG',
    delivered ? 'Entregado.' : 'Destinatario offline: guardado como pendiente.');
}

// ======================================================================
// D. Historial
// ======================================================================

function onFetchHistory(ctx, body) {
  const targetType = body.targetType.toUpperCase();
  const limit = Number.isInteger(body.limit) ? body.limit : 50;
  let targetId, label;

  if (targetType === 'CHANNEL') {
    targetId = state.resolveChannel(cleanChannelName(body.targetId));
    if (!targetId) return sendError(ctx, `El canal '#${body.targetId}' no existe`, TYPES.FETCH_HISTORY);
    label = `#${targetId}`;
  } else if (targetType === 'PRIVATE') {
    // Solo se puede pedir el historial de conversaciones propias
    const other = storage.getUserByName(body.targetId.trim());
    if (!other) return sendError(ctx, `El usuario '${body.targetId}' no existe`, TYPES.FETCH_HISTORY);
    targetId = other.id;
    label = other.username;
  } else {
    return sendError(ctx, 'targetType debe ser CHANNEL o PRIVATE', TYPES.FETCH_HISTORY);
  }

  const rows = storage.getHistory(targetType, targetId, { requesterId: ctx.userId, limit });
  safeSend(ctx.socket, build(TYPES.HISTORY_RESPONSE, {
    targetType,
    targetId: targetType === 'CHANNEL' ? targetId : label,
    messages: rows.map((r) => toWire(r)),
  }));
  logger.action(ctx.username, 'FETCH_HISTORY', `${label}: ${rows.length} mensaje(s).`);
}

// ======================================================================
// C. Transferencia de Archivos
// ======================================================================

function onFileOffer(ctx, body) {
  if (!ctx.userId) return sendError(ctx, 'Debes autenticarte primero', TYPES.FILE_OFFER);

  const targetType = body.targetType ? body.targetType.toUpperCase() : '';
  const { fileUrl } = body;
  if (typeof fileUrl !== 'string' || !FILE_URL_RE.test(fileUrl)) {
    return sendError(ctx, 'URL de archivo inválida (debe ser un archivo subido a /uploads/)', TYPES.FILE_OFFER);
  }
  const fileName = String(body.fileName).slice(0, 100);
  const fileSize = Number.isFinite(body.fileSize) && body.fileSize >= 0 ? body.fileSize : 0;

  if (targetType === 'CHANNEL') {
    const channel = state.resolveChannel(cleanChannelName(body.targetId));
    if (!channel) return sendError(ctx, `El canal '#${body.targetId}' no existe`, TYPES.FILE_OFFER);
    if (!state.isMember(channel, ctx.userId)) {
      return sendError(ctx, `Debes unirte a '#${channel}' antes de compartir archivos`, TYPES.FILE_OFFER);
    }

    const row = storage.saveMessage({
      senderId: ctx.userId,
      targetType: 'CHANNEL',
      targetId: channel,
      content: fileUrl,
      msgType: 'FILE',
    });

    const wire = {
      ...toWire(row, ctx.username),
      targetType: 'CHANNEL',
      targetId: channel,
      channel,
      fileName,
      fileUrl,
      fileSize,
    };

    const n = sendToChannel(channel, build(TYPES.FILE_OFFER, wire));
    logger.transfer(ctx.username, 'FILE_OFFER', `Canal '#${channel}': archivo '${fileName}' (${(fileSize / 1024).toFixed(1)} KB) -> ${n} destinatario(s).`);
  } else if (targetType === 'PRIVATE') {
    const target = storage.getUserByName(body.targetId.trim());
    if (!target) return sendError(ctx, `El usuario '${body.targetId}' no existe`, TYPES.FILE_OFFER);
    if (target.id === ctx.userId) return sendError(ctx, 'No puedes enviarte archivos a ti mismo', TYPES.FILE_OFFER);

    const targetClient = state.clients.get(target.id);
    const delivered = Boolean(targetClient);

    const row = storage.saveMessage({
      senderId: ctx.userId,
      targetType: 'PRIVATE',
      targetId: target.id,
      content: fileUrl,
      msgType: 'FILE',
      delivered,
    });

    const wire = {
      ...toWire(row, ctx.username),
      targetType: 'PRIVATE',
      targetId: target.id,
      to: { userId: target.id, username: target.username },
      fileName,
      fileUrl,
      fileSize,
    };

    if (targetClient) {
      safeSend(targetClient.socket, build(TYPES.FILE_OFFER, wire));
    }

    // Copia al emisor con confirmación de entrega
    safeSend(ctx.socket, build(TYPES.FILE_OFFER, { ...wire, delivered }));

    logger.transfer(`${ctx.username} -> ${target.username}`, 'FILE_OFFER',
      `Archivo '${fileName}' (${(fileSize / 1024).toFixed(1)} KB) - ${delivered ? 'Entregado.' : 'Guardado pendiente (offline).'}`);
  } else {
    return sendError(ctx, 'targetType debe ser CHANNEL o PRIVATE', TYPES.FILE_OFFER);
  }
}

// ======================================================================
// Router
// ======================================================================

const routes = {
  [TYPES.AUTH_REGISTER]: onAuthRegister,
  [TYPES.PROFILE_UPDATE]: onProfileUpdate,
  [TYPES.JOIN_CHANNEL]: onJoinChannel,
  [TYPES.LEAVE_CHANNEL]: onLeaveChannel,
  [TYPES.CHANNEL_MSG]: onChannelMsg,
  [TYPES.PRIVATE_MSG]: onPrivateMsg,
  [TYPES.FILE_OFFER]: onFileOffer,
  [TYPES.FETCH_HISTORY]: onFetchHistory,
};

function dispatch(ctx, pdu) {
  const { type } = pdu.head;

  // Todo excepto AUTH_REGISTER requiere sesión
  if (type !== TYPES.AUTH_REGISTER && !ctx.userId) {
    logger.warn(ctx.addr, 'UNAUTHORIZED', `Intento de ${type} sin autenticar.`);
    return sendError(ctx, 'Debes autenticarte primero (AUTH_REGISTER)', type);
  }

  const handler = routes[type];
  if (!handler) return sendError(ctx, `Primitiva ${type} aún no implementada`, type);

  // Los handlers async devuelven una Promise: capturamos su rechazo para que
  // un error no quede como "unhandled rejection" y tire el proceso.
  const result = handler(ctx, pdu.body, pdu);
  if (result instanceof Promise) {
    result.catch((err) => logger.error(ctx.addr, 'HANDLER', err.stack || err.message));
  }
}

module.exports = { dispatch, onDisconnect, safeSend, broadcast, isValidToken };
