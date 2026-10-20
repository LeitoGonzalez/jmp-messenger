#  Chat Cliente/Servidor — Protocolo JMP sobre WebSockets

> **Proyecto grupal** desarrollado para la materia **Redes de Datos** — UTN Facultad Regional Mendoza, 2026.
>
> **Creado y diseñado por:**
> - Leonardo Gonzalez
> - Alexandra Fernandez
> - Daniela Illanes
> - Julieta Paoloni
> - Santiago Cucchiarell

Aplicación de mensajería instantánea con arquitectura **Cliente/Servidor en estrella** y **broker centralizado**. Los clientes mantienen una conexión **WebSocket (TCP) persistente y full-duplex** con el servidor, que enruta los mensajes usando un protocolo de aplicación propio: **JMP (JSON Message Protocol)**.

---

##  Funcionalidades

| Requisito de la cátedra | Implementación | Estado |
|---|---|---|
| Múltiples canales de chat | `JOIN_CHANNEL` / `CHANNEL_MSG` (pub/sub) | 🚧 Etapa 2 |
| Mensajes privados | `PRIVATE_MSG` (unicast, con entrega diferida offline) | 🚧 Etapa 2 |
| Protocolo de mensajería | **JMP** propio sobre WebSocket (inspirado en XMPP) | ✅ |
| Envío de archivos a un usuario | `FILE_OFFER` + upload HTTP | ⏳ |
| Perfil de usuario y foto | `AUTH_REGISTER` con avatar Base64 | 🚧 |
| Guardar conversaciones | SQLite + `FETCH_HISTORY` + exportar | 🚧 Etapa 2 |
| Registro de información (logging) | `server.log` con formato auditado | ✅ |

**Robustez de red:** heartbeat Ping/Pong (30 s), manejo de `ECONNRESET`/`EPIPE`, validación de esquema de cada PDU.

---

##  Arquitectura

```
  [Cliente A] <----+
                   |---> [Servidor Central / Broker] <---> [SQLite]
  [Cliente B] <----+          |
                              +---> [server.log]
  [Cliente C] <---------------+
```

- **Servidor:** Node.js — event loop asíncrono con E/S no bloqueante.
- **Transporte:** WebSocket (`ws`) sobre TCP, mismo puerto que HTTP (Express).
- **Persistencia:** SQLite.
- **Cliente:** Web (HTML + CSS + JavaScript).

### Protocolo JMP

```json
{
  "head": { "type": "CHANNEL_MSG", "messageId": "uuid-v4", "timestamp": "2026-10-20T14:50:00Z" },
  "body": { "channel": "Redes", "content": "Hola!" }
}
```

---

##  Cómo correrlo

Requisitos: **Node.js 20+**

```bash
npm install
npm start            # servidor en http://localhost:3000
```

Log en vivo:

```powershell
Get-Content server\server.log -Wait     # Windows
tail -f server/server.log               # Linux / macOS
```

Cliente de prueba por consola:

```bash
node scripts/test-client.js Carlos
```

---

##  Estructura

```
server/
  index.js      Arranque HTTP + WebSocket + heartbeat
  protocol.js   Protocolo JMP: tipos, build(), parse()
  handlers.js   Lógica de cada primitiva + router
  state.js      Estado en memoria (clientes y canales)
  logger.js     Logging auditado
scripts/        Clientes y pruebas
docs/           Documentación técnica por etapa
```

##  Documentación

- [Etapa 1 — Servidor base](docs/etapa-1-servidor-base.md)

---
