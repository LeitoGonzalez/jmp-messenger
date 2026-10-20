/**
 * Módulo de Logging Auditado.
 * Formato: [TIMESTAMP] [NIVEL] [ORIGEN] [EVENTO] Detalle
 *   ORIGEN puede ser "IP:PUERTO", un username o "Emisor -> Receptor".
 * Escribe en consola (con colores) y en server.log (texto plano, append).
 */
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'server.log');
const isNew = !fs.existsSync(LOG_FILE) || fs.statSync(LOG_FILE).size === 0;
const stream = fs.createWriteStream(LOG_FILE, { flags: 'a', encoding: 'utf8' });
if (isNew) stream.write('\uFEFF'); // BOM: PowerShell detecta UTF-8 y muestra bien las tildes

const COLORS = {
  INFO: '\x1b[36m',     // cian
  ACTION: '\x1b[32m',   // verde
  TRANSFER: '\x1b[35m', // magenta
  WARN: '\x1b[33m',     // amarillo
  ERROR: '\x1b[31m',    // rojo
  DEBUG: '\x1b[90m',    // gris
};
const RESET = '\x1b[0m';

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(level, origin, event, detail = '') {
  const line = `[${timestamp()}] [${level}] [${origin}] [${event}] ${detail}`;
  stream.write(line + '\n');
  const color = COLORS[level] || '';
  console.log(color + line + RESET);
}

module.exports = {
  info:     (o, e, d) => log('INFO', o, e, d),
  action:   (o, e, d) => log('ACTION', o, e, d),
  transfer: (o, e, d) => log('TRANSFER', o, e, d),
  warn:     (o, e, d) => log('WARN', o, e, d),
  error:    (o, e, d) => log('ERROR', o, e, d),
  debug:    (o, e, d) => log('DEBUG', o, e, d),
  LOG_FILE,
};
