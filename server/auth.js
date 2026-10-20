/**
 * Hash y verificación de contraseñas con scrypt (función de derivación de claves
 * resistente a fuerza bruta: costosa en CPU y memoria a propósito).
 *
 * Formato guardado en la base:  scrypt$<salt hex>$<hash hex>
 *
 * crypto.scrypt (asíncrono) se ejecuta en el thread pool de libuv, NO en el
 * hilo del event loop: mientras se calcula el hash, el servidor sigue
 * atendiendo a los demás sockets.
 */
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const KEY_LEN = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);                 // salt aleatorio por usuario
  const hash = await scrypt(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [algo, saltHex, hashHex] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  // Comparación en tiempo constante: evita ataques de timing
  return crypto.timingSafeEqual(expected, actual);
}

module.exports = { hashPassword, verifyPassword };
