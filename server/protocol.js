// Definición del protocolo de mensajes (JMP)
const { randomUUID } = require('crypto');

// Tipos de mensajes que maneja el servidor
const TYPES = Object.freeze({
  AUTH_REGISTER: 'AUTH_REGISTER',
  AUTH_OK: 'AUTH_OK',
  PROFILE_UPDATE: 'PROFILE_UPDATE',
  USER_PRESENCE: 'USER_PRESENCE',
  USER_LIST: 'USER_LIST',
  JOIN_CHANNEL: 'JOIN_CHANNEL',
  LEAVE_CHANNEL: 'LEAVE_CHANNEL',
  CHANNEL_LIST: 'CHANNEL_LIST',
  CHANNEL_EVENT: 'CHANNEL_EVENT',
  CHANNEL_MSG: 'CHANNEL_MSG',
  PRIVATE_MSG: 'PRIVATE_MSG',
  FILE_OFFER: 'FILE_OFFER',
  FILE_HTTP_URL: 'FILE_HTTP_URL',
  FETCH_HISTORY: 'FETCH_HISTORY',
  HISTORY_RESPONSE: 'HISTORY_RESPONSE',
  ERROR: 'ERROR',
});

// Campos esperados para cada tipo de mensaje
const SCHEMAS = {
  AUTH_REGISTER:  { username: 'string', password: 'string' },
  [TYPES.PROFILE_UPDATE]: {
    status: { type: 'string', optional: true },
    avatar: { type: 'string', optional: true },
  },
  JOIN_CHANNEL:   { channel: 'string' },
  LEAVE_CHANNEL:  { channel: 'string' },
  CHANNEL_MSG:    { channel: 'string', content: 'string' },
  PRIVATE_MSG:    { to: 'string', content: 'string' },
  [TYPES.FILE_OFFER]: {
    targetType: 'string',
    targetId: 'string',
    fileName: 'string',
    fileUrl: 'string',
    fileSize: 'number',
  },
  FETCH_HISTORY:  { targetType: 'string', targetId: 'string' },
};

const MAX_PDU_BYTES = 2 * 1024 * 1024; // Límite de 2MB por mensaje

// Arma el mensaje en formato JSON con su cabecera y cuerpo
function build(type, body = {}) {
  return JSON.stringify({
    head: { type, messageId: randomUUID(), timestamp: new Date().toISOString() },
    body,
  });
}

// Parsea y valida el paquete recibido
function parse(raw) {
  if (raw.length > MAX_PDU_BYTES) return { ok: false, error: 'PDU demasiado grande' };

  let pdu;
  try {
    pdu = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ok: false, error: 'JSON malformado' };
  }

  if (!pdu || typeof pdu !== 'object') return { ok: false, error: 'PDU no es un objeto' };
  const { head, body } = pdu;
  if (!head || typeof head !== 'object') return { ok: false, error: 'Falta "head"' };
  if (typeof head.type !== 'string') return { ok: false, error: 'Falta "head.type"' };
  if (body !== undefined && (typeof body !== 'object' || body === null)) {
    return { ok: false, error: '"body" debe ser un objeto' };
  }
  pdu.body = body || {};

  const schema = SCHEMAS[head.type];
  if (!schema) return { ok: false, error: `Tipo desconocido: ${head.type}` };

  for (const [field, rule] of Object.entries(schema)) {
    const isObj = typeof rule === 'object' && rule !== null;
    const expectedType = isObj ? rule.type : rule;
    const isOptional = isObj && Boolean(rule.optional);

    if (pdu.body[field] === undefined || pdu.body[field] === null) {
      if (!isOptional) {
        return { ok: false, error: `Campo "${field}" requerido` };
      }
      continue;
    }

    if (typeof pdu.body[field] !== expectedType) {
      return { ok: false, error: `Campo "${field}" inválido (se esperaba ${expectedType})` };
    }
  }
  return { ok: true, pdu };
}

module.exports = { TYPES, build, parse };
