// Estado en memoria del servidor
const storage = require('./storage');

// Mapa de usuarios conectados actualmente
const clients = new Map();

// Canales activos y sus usuarios conectados
const channels = new Map(storage.listChannels().map((name) => [name, new Set()]));

function addClient(userId, info) {
  clients.set(userId, info);
}

// Desconecta al usuario y lo saca de los canales en los que estaba
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

// Busca el canal en la base sin importar mayúsculas o minúsculas
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

// Devuelve los usuarios registrados combinados con su estado online en memoria
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
  // Limpiamos de memoria canales que ya no existen en la base
  for (const name of channels.keys()) {
    if (!dbChannels.has(name.toLowerCase())) {
      channels.delete(name);
    }
  }
  // Sincronizamos con los canales que hay en SQLite
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
