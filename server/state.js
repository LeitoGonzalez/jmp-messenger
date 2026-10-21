/**
 * Estado interno del servidor (en memoria).
 * Node.js ejecuta el código JS en un único hilo (event loop), por lo que
 * estas estructuras son "synchronization-safe" sin necesidad de locks:
 * ningún handler se interrumpe a mitad de una modificación.
 *
 * Memoria  = quién está conectado AHORA y en qué canales (volátil).
 * SQLite   = usuarios registrados, canales existentes y mensajes (persistente).
 */
const storage = require('./storage');

/** ClientsMap: userId -> { socket, username, status, avatar, ip, port } (solo conectados) */
const clients = new Map();

/** ChannelsMap: channelName -> Set(userId) (miembros conectados) */
const channels = new Map(storage.listChannels().map((name) => [name, new Set()]));

function addClient(userId, info) {
  clients.set(userId, info);
}

/** Saca al usuario de clients y de todos los canales. Devuelve los canales que dejó. */
function removeClient(userId) {
  clients.delete(userId);
  const left = [];
  for (const [name, members] of channels) {
    if (members.delete(userId)) left.push(name);
  }
  return left;
}

function isOnline(userId) {
  return clients.has(userId);
}

/** Busca el nombre "canónico" de un canal sin distinguir mayúsculas, validando existencia en SQLite. */
function resolveChannel(name) {
  const lower = name.toLowerCase();
  const dbChannels = storage.listChannels();
  for (const dbName of dbChannels) {
    if (dbName.toLowerCase() === lower) {
      if (!channels.has(dbName)) channels.set(dbName, new Set());
      return dbName;
    }
  }
  return null;
}

function createChannel(name) {
  if (!channels.has(name)) channels.set(name, new Set());
  return name;
}

function joinChannel(channel, userId) {
  if (!channels.has(channel)) channels.set(channel, new Set());
  channels.get(channel).add(userId);
}

function leaveChannel(channel, userId) {
  return channels.get(channel)?.delete(userId) ?? false;
}

function isMember(channel, userId) {
  return channels.get(channel)?.has(userId) ?? false;
}

function channelMembers(channel) {
  return channels.get(channel) || new Set();
}

/**
 * Lista pública de usuarios: todos los registrados (SQLite) con su estado de
 * conexión real (memoria). Nunca expone el socket ni el hash de contraseña.
 */
function publicUsers() {
  return storage.listUsers().map((u) => {
    const live = clients.get(u.id);
    return {
      userId: u.id,
      username: u.username,
      status: live ? live.status : 'Offline',
      avatar: u.avatar,
      online: Boolean(live),
      lastSeen: u.last_seen,
    };
  });
}

function channelList() {
  const dbChannels = new Set(storage.listChannels().map((n) => n.toLowerCase()));
  // Purgar de memoria cualquier canal que haya sido eliminado de SQLite
  for (const name of channels.keys()) {
    if (!dbChannels.has(name.toLowerCase())) {
      channels.delete(name);
    }
  }
  // Asegurar que los canales de SQLite estén presentes
  for (const dbName of storage.listChannels()) {
    if (!channels.has(dbName)) channels.set(dbName, new Set());
  }
  return [...channels].map(([name, members]) => ({ name, members: members.size }));
}

module.exports = {
  clients, channels,
  addClient, removeClient, isOnline,
  resolveChannel, createChannel, joinChannel, leaveChannel, isMember, channelMembers,
  publicUsers, channelList,
};
