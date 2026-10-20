/**
 * Estado interno del servidor (en memoria).
 * Node.js ejecuta el código JS en un único hilo (event loop), por lo que
 * estas estructuras son "synchronization-safe" sin necesidad de locks:
 * ningún handler se interrumpe a mitad de una modificación.
 */

/** ClientsMap: userId -> { socket, username, status, avatar, ip, port } */
const clients = new Map();

/** ChannelsMap: channelName -> Set(userId) */
const channels = new Map([
  ['General', new Set()],
  ['Redes', new Set()],
  ['Random', new Set()],
]);

function addClient(userId, info) {
  clients.set(userId, info);
}

function removeClient(userId) {
  clients.delete(userId);
  for (const members of channels.values()) members.delete(userId);
}

function findByUsername(username) {
  for (const [id, c] of clients) if (c.username === username) return id;
  return null;
}

function joinChannel(channel, userId) {
  if (!channels.has(channel)) channels.set(channel, new Set());
  channels.get(channel).add(userId);
}

function leaveChannel(channel, userId) {
  channels.get(channel)?.delete(userId);
}

/** Lista pública de usuarios (sin el objeto socket). */
function publicUsers() {
  return [...clients].map(([userId, c]) => ({
    userId, username: c.username, status: c.status, avatar: c.avatar,
  }));
}

function channelList() {
  return [...channels].map(([name, members]) => ({ name, members: members.size }));
}

module.exports = {
  clients, channels,
  addClient, removeClient, findByUsername,
  joinChannel, leaveChannel, publicUsers, channelList,
};
