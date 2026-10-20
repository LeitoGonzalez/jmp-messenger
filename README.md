# 💬 Chat Cliente/Servidor — Protocolo JMP sobre WebSockets

> **Proyecto grupal** desarrollado para la materia **Redes de Información** — UTN Facultad Regional Mendoza, 2026.
>
> **Creadores y Desarrolladores:**
> - Leonardo Gonzalez
> - Alexandra Fernandez
> - Daniela Illanes
> - Julieta Paoloni
> - Santiago Cucchiarelli

Aplicación de mensajería instantánea con arquitectura **Cliente/Servidor en estrella** y **broker centralizado**. Los clientes mantienen una conexión **WebSocket (TCP) persistente y full-duplex** con el servidor, que enruta los mensajes usando un protocolo de aplicación propio: **JMP (JSON Message Protocol)**, complementado con una interfaz gráfica web moderna inspirada en el ecosistema **Apple (macOS / iOS / iMessage)**.

---

## 🚀 Funcionalidades y Estado de Cumplimiento

| Requisito de la cátedra | Implementación Técnica | Estado |
|---|---|---|
| **Múltiples canales de chat** | `JOIN_CHANNEL` / `LEAVE_CHANNEL` / `CHANNEL_MSG` (Pub/Sub) | ✅ Etapa 2 |
| **Mensajes privados** | `PRIVATE_MSG` (Unicast con entrega diferida *offline*) | ✅ Etapa 2 |
| **Protocolo de mensajería** | **JMP** propio sobre WebSocket (inspirado en XMPP) | ✅ Etapa 1 |
| **Guardar conversaciones** | SQLite (`better-sqlite3`) + `FETCH_HISTORY` + Exportación TXT | ✅ Etapa 2 & 5 |
| **Registro de información (logging)** | Auditado en `server.log` con formato estandarizado | ✅ Etapa 1 |
| **Perfil de usuario y foto** | `AUTH_REGISTER` / `PROFILE_UPDATE` con avatar en Base64 | ✅ Etapa 3 |
| **Envío de archivos a un usuario** | `FILE_OFFER` + servidor de archivos HTTP (Express) | ✅ Etapa 4 |
| **Interfaz Gráfica de Usuario (GUI)** | Frontend Web Vanilla (HTML5, CSS3 Glassmorphism, JS ES6+) | ✅ Etapa 5 |

**Robustez de red:** Heartbeat activo Ping/Pong (30 s), manejo defensivo de `ECONNRESET`/`EPIPE`, auto-reconexión en clientes, captura de excepciones sin caídas del proceso y validación estricta del esquema de cada PDU.

---

## 📐 Arquitectura del Sistema

```text
  [Cliente Web A] <----+
                        |---> [Servidor Central / Broker] <---> [SQLite (chat.db)]
  [Cliente Web B] <----+          |          |
                                  |          +---> [server/uploads/ (Archivos)]
  [Cliente Web C] <---------------+          |
                                             +---> [server.log (Auditoría)]
```

- **Servidor:** Node.js — Event Loop asíncrono con E/S no bloqueante.
- **Transporte de Control:** WebSocket (`ws`) persistente sobre TCP.
- **Transporte de Datos:** HTTP (Express) para subida (`POST /api/upload`) y descarga directa de archivos binarios.
- **Persistencia:** Base de datos relacional SQLite con transacciones ACID y modo WAL.
- **Cliente:** Interfaz Web Nativa estilo macOS / iOS (HTML5, CSS3, JavaScript ES6+ sin librerías externas).

### Protocolo JMP (Capa de Aplicación, L7)

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

### 1. Iniciar el Servidor
```bash
npm install
npm start            # Servidor en http://localhost:3000
```
*(Para desarrollo con reinicio automático de cambios: `npm run dev`)*.

### 2. Abrir la Interfaz Gráfica Web
- **En tu computadora:** Abrí tu navegador y entrá a [http://localhost:3000](http://localhost:3000).
- **Desde otra computadora o celular en la misma red Wi-Fi:**
  1. Averiguá tu IP local ejecutando `ipconfig` (ej: `192.168.1.45`).
  2. En el navegador del otro dispositivo entrá a `http://192.168.1.45:3000`.

### 3. Log de Auditoría en Tiempo Real
Para la defensa frente a los docentes, abrí una terminal paralela:

```powershell
# En Windows (PowerShell):
Get-Content server\server.log -Wait -Encoding UTF8

# En Linux / macOS:
tail -f server/server.log
```

### 4. Tests Automatizados
Para verificar la integridad del backend en cualquier momento:

```bash
npm test             # Ejecuta los 17 tests automáticos end-to-end
```

---

## 📂 Estructura del Proyecto

```text
chat-proy/
├── package.json            ← Dependencias (express, ws, better-sqlite3)
├── data/
│   └── chat.db             ← Base de datos SQLite relacional (auto-generada)
├── server/
│   ├── index.js            ← Arranque HTTP + WebSocket + Heartbeat + API Upload
│   ├── protocol.js         ← Protocolo JMP: catálogo de primitivas y validación
│   ├── handlers.js         ← Router de primitivas (Pub/Sub, Unicast, Auth, Archivos)
│   ├── state.js            ← Estado en memoria (ClientsMap y ChannelsMap)
│   ├── storage.js          ← Motor de persistencia (SQLite Prepared Statements)
│   ├── auth.js             ← Hash y verificación de contraseñas (scrypt)
│   ├── logger.js           ← Módulo de logging auditado
│   └── uploads/            ← Almacenamiento físico de archivos transferidos
├── client/                 ← Interfaz gráfica web (Vanilla Web Stack)
│   ├── index.html          ← Estructura semántica (Apple ID modal, Split View)
│   ├── styles.css          ← Estilos Apple Minimalista (macOS Dark, iMessage)
│   └── app.js              ← Lógica cliente, WebSocket JMP, Canvas y Uploads
├── scripts/
│   ├── test-client.js      ← Cliente de consola interactivo para pruebas
│   └── test-etapa2.js      ← Suite de 17 tests automáticos end-to-end
└── docs/                   ← Documentación técnica académica para la defensa
    ├── etapa-1-servidor-base.md
    ├── etapa-2-canales-privados.md
    ├── etapa-3-perfil-avatar.md
    ├── etapa-4-transferencia-archivos.md
    └── etapa-5-cliente-web.md
```

---

## 📚 Documentación Técnica por Etapas

* 📄 [Etapa 1 — Servidor Base, Protocolo JMP, Logging y Heartbeat](docs/etapa-1-servidor-base.md)
* 📄 [Etapa 2 — Canales, Mensajes Privados, Persistencia SQLite y Autenticación](docs/etapa-2-canales-privados.md)
* 📄 [Etapa 3 — Perfil de Usuario, Estado Personalizado y Avatar en Base64](docs/etapa-3-perfil-avatar.md)
* 📄 [Etapa 4 — Transferencia de Archivos Híbrida (HTTP + Señalización WebSockets)](docs/etapa-4-transferencia-archivos.md)
* 📄 [Etapa 5 — Interfaz Gráfica Web, Estética Apple Minimalista y Canvas Client-Side](docs/etapa-5-cliente-web.md)
