# 💬 Chat Cliente/Servidor — Protocolo JMP sobre WebSockets

> **Proyecto grupal** desarrollado para la materia **Redes de Información** — UTN Facultad Regional Mendoza, 2026.
>
> **Creadores y Desarrolladores:**
> - Leonardo Gonzalez
> - Alexandra Fernandez
> - Daniela Illanes
> - Julieta Paoloni
> - Santiago Cucchiarelli

Aplicación de mensajería instantánea con arquitectura **Cliente/Servidor en estrella** y **broker centralizado**. Los clientes mantienen una conexión **WebSocket (TCP) persistente y full-duplex** con el servidor, que enruta los mensajes usando un protocolo de aplicación propio: **JMP (JSON Message Protocol)**.

---

## 🚀 Funcionalidades y Estado de Cumplimiento

| Requisito de la cátedra | Implementación Técnica | Estado |
|---|---|---|
| **Múltiples canales de chat** | `JOIN_CHANNEL` / `LEAVE_CHANNEL` / `CHANNEL_MSG` (Pub/Sub) | ✅ Etapa 2 |
| **Mensajes privados** | `PRIVATE_MSG` (Unicast con entrega diferida *offline*) | ✅ Etapa 2 |
| **Protocolo de mensajería** | **JMP** propio sobre WebSocket (inspirado en XMPP) | ✅ Etapa 1 |
| **Guardar conversaciones** | SQLite (`better-sqlite3`) + `FETCH_HISTORY` indexado | ✅ Etapa 2 |
| **Registro de información (logging)** | Auditado en `server.log` con formato estandarizado | ✅ Etapa 1 |
| **Perfil de usuario y foto** | `AUTH_REGISTER` / `PROFILE_UPDATE` con avatar Base64 | ⏳ Etapa 3 |
| **Envío de archivos a un usuario** | `FILE_OFFER` + servidor de archivos HTTP (Express) | ⏳ Etapa 4 |

**Robustez de red:** Heartbeat activo Ping/Pong (30 s), manejo defensivo de `ECONNRESET`/`EPIPE`, captura de excepciones sin caídas del proceso y validación estricta del esquema de cada PDU.

---

## 📐 Arquitectura

```text
  [Cliente A] <----+
                   |---> [Servidor Central / Broker] <---> [SQLite (chat.db)]
  [Cliente B] <----+          |
                              +---> [server.log]
  [Cliente C] <---------------+
```

- **Servidor:** Node.js — Event Loop asíncrono con E/S no bloqueante.
- **Transporte:** WebSocket (`ws`) sobre TCP, mismo puerto que HTTP (Express).
- **Persistencia:** Base de datos relacional SQLite con transacciones ACID y modo WAL.
- **Cliente:** Interfaz Web (HTML5, CSS3, JavaScript ES6+).

### Protocolo JMP

Toda PDU (*Protocol Data Unit*) es un objeto JSON codificado en UTF-8:

```json
{
  "head": { 
    "type": "CHANNEL_MSG", 
    "messageId": "u_e6ac1c81", 
    "timestamp": "2026-10-20T14:50:00Z" 
  },
  "body": { 
    "channel": "Redes", 
    "content": "¡Hola a todos!" 
  }
}
```

---

## 🛠️ Cómo correrlo

Requisitos: **Node.js 20+**

```bash
npm install
npm start            # Servidor en http://localhost:3000
npm run dev          # Modo desarrollo (reinicia al guardar cambios)
```

Log en vivo:

```powershell
# En Windows (PowerShell):
Get-Content server\server.log -Wait

# En Linux / macOS:
tail -f server/server.log
```

Cliente de prueba por consola / Tests:

```bash
node scripts/test-client.js Carlos    # Cliente interactivo
npm test                              # Suite de 17 tests automatizados (Etapa 2)
```

---

## 📂 Estructura del Proyecto

```text
chat-proy/
├── package.json            ← Dependencias (express, ws, better-sqlite3)
├── data/
│   └── chat.db             ← Base de datos SQLite (auto-generada)
├── server/
│   ├── index.js            ← Arranque HTTP + WebSocket + Heartbeat
│   ├── protocol.js         ← Protocolo JMP: tipos, build(), parse()
│   ├── handlers.js         ← Lógica de primitivas (Pub/Sub, Unicast, Auth)
│   ├── state.js            ← Estado en memoria (ClientsMap y ChannelsMap)
│   ├── storage.js          ← Motor de persistencia (SQLite Engine)
│   ├── auth.js             ← Hash y verificación de contraseñas (scrypt)
│   ├── logger.js           ← Logging auditado
│   └── uploads/            ← Carpeta para archivos transferidos
├── client/                 ← Interfaz gráfica web (HTML / CSS / JS)
├── scripts/
│   ├── test-client.js      ← Cliente de consola para pruebas
│   └── test-etapa2.js      ← 17 tests automáticos end-to-end
└── docs/
    ├── etapa-1-servidor-base.md
    └── etapa-2-canales-privados.md
```

---

## 📚 Documentación

* 📄 [Etapa 1 — Servidor Base, Protocolo JMP, Logging y Heartbeat](docs/etapa-1-servidor-base.md)
* 📄 [Etapa 2 — Canales, Mensajes Privados, Persistencia SQLite y Autenticación](docs/etapa-2-canales-privados.md)
