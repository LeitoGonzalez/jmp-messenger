/**
 * ===================================================================
 * JMP MESSENGER — CLIENTE JAVASCRIPT ES6+ (VANILLA)
 * Redes de Información — UTN FRM (2026)
 * ===================================================================
 */

(() => {
  'use strict';

  // ---------- ESTADO DE LA APLICACIÓN ----------
  const state = {
    currentUser: null,           // { userId, username, status, avatar }
    currentTarget: {             // Canal o chat privado actualmente abierto
      type: 'CHANNEL',           // 'CHANNEL' | 'PRIVATE'
      id: 'General',             // nombre de canal o username del destinatario
      title: '#General',
      status: 'Canal público',
      avatar: null,
      online: true,
    },
    channels: [],                // [{ name, members }]
    users: [],                   // [{ userId, username, status, avatar, online, lastSeen }]
    historyCache: new Map(),     // "CHANNEL:General" -> [mensajes]
    ws: null,
    reconnectTimer: null,
  };

  // ---------- REFERENCIAS AL DOM ----------
  const dom = {
    // Auth Modal
    authModal: document.getElementById('auth-modal'),
    authForm: document.getElementById('auth-form'),
    authUsername: document.getElementById('auth-username'),
    authPassword: document.getElementById('auth-password'),
    authStatus: document.getElementById('auth-status'),
    authError: document.getElementById('auth-error'),
    authSubmitBtn: document.getElementById('auth-submit-btn'),
    tabLogin: document.getElementById('tab-login'),
    tabRegister: document.getElementById('tab-register'),
    registerFields: document.getElementById('register-fields'),
    btnPickAuthAvatar: document.getElementById('btn-pick-auth-avatar'),
    authAvatarInput: document.getElementById('auth-avatar-input'),
    authAvatarPreview: document.getElementById('auth-avatar-preview'),
    authAvatarPlaceholder: document.getElementById('auth-avatar-placeholder'),

    // App Layout
    appLayout: document.getElementById('app-layout'),
    myAvatar: document.getElementById('my-avatar'),
    myAvatarPlaceholder: document.getElementById('my-avatar-placeholder'),
    myUsername: document.getElementById('my-username'),
    myStatus: document.getElementById('my-status'),
    btnLogout: document.getElementById('btn-logout'),
    btnEditProfile: document.getElementById('btn-edit-profile'),
    profileTextClickable: document.getElementById('profile-text-clickable'),
    searchFilter: document.getElementById('search-filter'),
    channelsList: document.getElementById('channels-list'),
    usersList: document.getElementById('users-list'),
    usersCount: document.getElementById('users-count'),
    btnOpenCreateChannel: document.getElementById('btn-open-create-channel'),

    // Chat Area
    chatTargetTitle: document.getElementById('chat-target-title'),
    chatTargetSubtitle: document.getElementById('chat-target-subtitle'),
    chatTargetAvatar: document.getElementById('chat-target-avatar'),
    chatTargetPlaceholder: document.getElementById('chat-target-placeholder'),
    chatTargetBadge: document.getElementById('chat-target-badge'),
    btnExportChat: document.getElementById('btn-export-chat'),
    messagesContainer: document.getElementById('messages-container'),
    inputMessage: document.getElementById('input-message'),
    btnSend: document.getElementById('btn-send'),
    btnAttach: document.getElementById('btn-attach'),
    fileInput: document.getElementById('file-input'),

    // Profile Edit Modal
    profileModal: document.getElementById('profile-modal'),
    editAvatarPreview: document.getElementById('edit-avatar-preview'),
    editAvatarPlaceholder: document.getElementById('edit-avatar-placeholder'),
    editAvatarInput: document.getElementById('edit-avatar-input'),
    editStatusInput: document.getElementById('edit-status-input'),
    profileError: document.getElementById('profile-error'),
    btnCloseProfile: document.getElementById('btn-close-profile'),
    btnCancelProfile: document.getElementById('btn-cancel-profile'),
    btnSaveProfile: document.getElementById('btn-save-profile'),

    // Channel Create Modal
    channelModal: document.getElementById('channel-modal'),
    newChannelInput: document.getElementById('new-channel-input'),
    channelError: document.getElementById('channel-error'),
    btnCloseChannelModal: document.getElementById('btn-close-channel-modal'),
    btnCancelChannel: document.getElementById('btn-cancel-channel'),
    btnConfirmChannel: document.getElementById('btn-confirm-channel'),

    // Canvas oculto para resize de avatar
    avatarCanvas: document.getElementById('avatar-canvas'),
  };

  // Variables temporales para avatares seleccionados en Base64
  let tempAuthAvatarBase64 = null;
  let tempEditAvatarBase64 = null;
  let isRegisterMode = false;

  // ===================================================================
  // PROTOCOLO JMP (CAPA 7)
  // ===================================================================

  function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'u_' + Math.random().toString(36).substring(2, 10);
  }

  function buildPdu(type, body = {}) {
    return JSON.stringify({
      head: {
        type,
        messageId: generateUUID(),
        timestamp: new Date().toISOString(),
      },
      body,
    });
  }

  function sendPdu(type, body = {}) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(buildPdu(type, body));
      return true;
    }
    console.warn('[JMP] No se pudo enviar paquete. Socket cerrado:', type);
    return false;
  }

  // ===================================================================
  // CONEXIÓN WEBSOCKET Y RECONEXIÓN
  // ===================================================================

  function connectWebSocket(onOpenCallback) {
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}`;

    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
      console.log('[WS] Conexión establecida con el servidor broker.');
      if (onOpenCallback) onOpenCallback();
    };

    state.ws.onmessage = (event) => {
      try {
        const pdu = JSON.parse(event.data);
        handleIncomingPdu(pdu);
      } catch (err) {
        console.error('[WS] Error al parsear PDU entrante:', err, event.data);
      }
    };

    state.ws.onclose = (event) => {
      console.warn('[WS] Conexión cerrada (code:', event.code, '). Reconectando en 3s...');
      if (state.currentUser) {
        showSystemMessage('⚠️ Conexión perdida con el servidor. Reconectando...');
      }
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(() => {
        connectWebSocket(() => {
          // Re-autenticar automáticamente con las credenciales activas
          if (state.currentUser && state.currentUser.password) {
            sendPdu('AUTH_REGISTER', {
              username: state.currentUser.username,
              password: state.currentUser.password,
              status: state.currentUser.status,
            });
          }
        });
      }, 3000);
    };

    state.ws.onerror = (err) => {
      console.error('[WS] Error en socket de transporte:', err);
    };
  }

  // ===================================================================
  // DISPATCHER DE PDUs ENTRANTES (L7)
  // ===================================================================

  function handleIncomingPdu(pdu) {
    const { type } = pdu.head;
    const body = pdu.body || {};

    switch (type) {
      case 'AUTH_OK':
        onAuthOk(body);
        break;

      case 'USER_PRESENCE':
        onUserPresence(body);
        break;

      case 'CHANNEL_LIST':
        onChannelList(body);
        break;

      case 'CHANNEL_EVENT':
        onChannelEvent(body);
        break;

      case 'CHANNEL_MSG':
        onChannelMsg(body);
        break;

      case 'PRIVATE_MSG':
        onPrivateMsg(body);
        break;

      case 'FILE_OFFER':
        onFileOffer(body);
        break;

      case 'HISTORY_RESPONSE':
        onHistoryResponse(body);
        break;

      case 'PROFILE_UPDATE':
        onProfileUpdateConfirm(body);
        break;

      case 'ERROR':
        onErrorPdu(body);
        break;

      default:
        console.log('[JMP] PDU no controlada:', type, body);
    }
  }

  // ===================================================================
  // MANEJADORES ESPECÍFICOS DE EVENTOS
  // ===================================================================

  function onAuthOk(body) {
    dom.authModal.classList.add('hidden');
    dom.appLayout.classList.remove('hidden');

    state.currentUser = {
      userId: body.userId,
      username: body.username,
      status: 'Online',
      avatar: null,
      password: dom.authPassword.value, // almacenada en memoria para auto-reconexión
    };

    // Actualizar perfil propio en la UI
    renderMyProfile();

    // Actualizar listas
    if (body.channels) {
      state.channels = body.channels;
      renderChannelsList();
    }
    if (body.users) {
      state.users = body.users.filter((u) => u.username !== state.currentUser.username);
      renderUsersList();
    }

    // Unirse a #General por defecto
    selectConversation('CHANNEL', 'General', '#General', 'Canal público principal');
  }

  function onUserPresence(body) {
    if (body.userId === state.currentUser?.userId) {
      // Actualización de mi propio perfil propagada
      if (body.status) state.currentUser.status = body.status;
      if (body.avatar) state.currentUser.avatar = body.avatar;
      renderMyProfile();
      return;
    }

    // Buscar o agregar usuario a la lista local
    const existingIndex = state.users.findIndex((u) => u.userId === body.userId);
    const updatedUser = {
      userId: body.userId,
      username: body.username,
      status: body.status || 'Offline',
      avatar: body.avatar || null,
      online: body.event !== 'DISCONNECTED',
    };

    if (existingIndex >= 0) {
      state.users[existingIndex] = { ...state.users[existingIndex], ...updatedUser };
    } else if (body.username !== state.currentUser?.username) {
      state.users.push(updatedUser);
    }

    renderUsersList();

    // Si tenemos abierto el chat privado con este usuario, actualizar header
    if (state.currentTarget.type === 'PRIVATE' && state.currentTarget.id === body.username) {
      state.currentTarget.status = updatedUser.online ? (updatedUser.status || 'En línea') : 'Desconectado';
      state.currentTarget.avatar = updatedUser.avatar;
      state.currentTarget.online = updatedUser.online;
      renderChatHeader();
    }
  }

  function onChannelList(body) {
    if (body.channels) {
      state.channels = body.channels;
      renderChannelsList();
    }
  }

  function onChannelEvent(body) {
    const text = body.event === 'JOINED'
      ? `${body.username} se unió a #${body.channel}`
      : `${body.username} salió de #${body.channel}`;

    if (state.currentTarget.type === 'CHANNEL' && state.currentTarget.id === body.channel) {
      showSystemMessage(text);
    }
  }

  function onChannelMsg(body) {
    const key = `CHANNEL:${body.channel}`;
    appendMessageToCache(key, body);

    if (state.currentTarget.type === 'CHANNEL' && state.currentTarget.id === body.channel) {
      renderSingleMessage(body);
      scrollToBottom();
    }
  }

  function onPrivateMsg(body) {
    // Si viene de alguien, la clave es ese usuario. Si es copia de mi envío, la clave es 'to'
    const otherUser = body.from.username === state.currentUser.username
      ? body.to.username
      : body.from.username;

    const key = `PRIVATE:${otherUser}`;
    appendMessageToCache(key, body);

    if (state.currentTarget.type === 'PRIVATE' && state.currentTarget.id === otherUser) {
      renderSingleMessage(body);
      scrollToBottom();
    }
  }

  function onFileOffer(body) {
    const isChannel = body.targetType === 'CHANNEL';
    const key = isChannel ? `CHANNEL:${body.targetId}` : `PRIVATE:${body.from.username === state.currentUser.username ? body.to?.username : body.from.username}`;
    
    appendMessageToCache(key, body);

    if ((isChannel && state.currentTarget.type === 'CHANNEL' && state.currentTarget.id === body.targetId) ||
        (!isChannel && state.currentTarget.type === 'PRIVATE' && (state.currentTarget.id === body.from.username || body.from.username === state.currentUser.username))) {
      renderSingleMessage(body);
      scrollToBottom();
    }
  }

  function onHistoryResponse(body) {
    const key = `${body.targetType}:${body.targetId}`;
    state.historyCache.set(key, body.messages || []);

    if (state.currentTarget.type === body.targetType && state.currentTarget.id === body.targetId) {
      dom.messagesContainer.innerHTML = '';
      if (!body.messages || body.messages.length === 0) {
        showSystemMessage('No hay mensajes previos en esta conversación.');
      } else {
        body.messages.forEach(renderSingleMessage);
      }
      scrollToBottom();
    }
  }

  function onProfileUpdateConfirm(body) {
    if (body.ok) {
      if (body.status) state.currentUser.status = body.status;
      if (body.avatar) state.currentUser.avatar = body.avatar;
      renderMyProfile();
      closeModal(dom.profileModal);
    }
  }

  function onErrorPdu(body) {
    const msg = body.error || 'Ocurrió un error en el servidor';
    console.warn('[JMP ERROR]', msg);

    if (dom.authModal.classList.contains('hidden')) {
      alert(`⚠️ ${msg}`);
    } else {
      dom.authError.textContent = msg;
      dom.authError.classList.remove('hidden');
    }
  }

  // ===================================================================
  // RENDERIZADO DE INTERFAZ (DOM)
  // ===================================================================

  function renderMyProfile() {
    dom.myUsername.textContent = state.currentUser.username;
    dom.myStatus.textContent = state.currentUser.status || 'En línea';

    if (state.currentUser.avatar) {
      dom.myAvatar.src = state.currentUser.avatar;
      dom.myAvatar.classList.remove('hidden');
      dom.myAvatarPlaceholder.classList.add('hidden');
    } else {
      dom.myAvatar.classList.add('hidden');
      dom.myAvatarPlaceholder.classList.remove('hidden');
      dom.myAvatarPlaceholder.textContent = state.currentUser.username.charAt(0).toUpperCase();
    }
  }

  function renderChannelsList() {
    dom.channelsList.innerHTML = '';
    state.channels.forEach((ch) => {
      const li = document.createElement('li');
      li.className = `item-row ${state.currentTarget.type === 'CHANNEL' && state.currentTarget.id === ch.name ? 'active' : ''}`;
      li.innerHTML = `
        <span class="channel-hash">#</span>
        <span class="item-label">${escapeHtml(ch.name)}</span>
        <span class="item-badge-members">${ch.members}</span>
      `;
      li.onclick = () => selectConversation('CHANNEL', ch.name, `#${ch.name}`, `${ch.members} miembro(s) conectado(s)`);
      dom.channelsList.appendChild(li);
    });
  }

  function renderUsersList() {
    dom.usersList.innerHTML = '';
    const filter = dom.searchFilter.value.toLowerCase().trim();

    const filtered = state.users.filter((u) => u.username.toLowerCase().includes(filter));
    dom.usersCount.textContent = state.users.length;

    filtered.forEach((u) => {
      const li = document.createElement('li');
      const isActive = state.currentTarget.type === 'PRIVATE' && state.currentTarget.id === u.username;
      li.className = `item-row ${isActive ? 'active' : ''}`;

      const avatarHtml = u.avatar
        ? `<img src="${u.avatar}" class="avatar-circle" style="width:28px;height:28px;">`
        : `<div class="avatar-circle avatar-placeholder" style="width:28px;height:28px;font-size:12px;">${u.username.charAt(0).toUpperCase()}</div>`;

      li.innerHTML = `
        <div style="position:relative;">
          ${avatarHtml}
          <span class="presence-badge ${u.online ? 'online' : 'offline'}" style="width:8px;height:8px;border-width:1.5px;"></span>
        </div>
        <div style="flex:1;min-width:0;">
          <div class="item-label">${escapeHtml(u.username)}</div>
          <div style="font-size:11px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(u.status || (u.online ? 'En línea' : 'Desconectado'))}</div>
        </div>
      `;

      li.onclick = () => selectConversation(
        'PRIVATE',
        u.username,
        u.username,
        u.online ? (u.status || 'En línea') : 'Desconectado',
        u.avatar,
        u.online
      );
      dom.usersList.appendChild(li);
    });
  }

  function selectConversation(type, id, title, subtitle, avatar = null, online = true) {
    state.currentTarget = { type, id, title, subtitle, avatar, online };
    renderChatHeader();
    renderChannelsList();
    renderUsersList();

    // Limpiar contenedor y solicitar historial indexado
    dom.messagesContainer.innerHTML = '';
    sendPdu('FETCH_HISTORY', { targetType: type, targetId: id, limit: 50 });
  }

  function renderChatHeader() {
    dom.chatTargetTitle.textContent = state.currentTarget.title;
    dom.chatTargetSubtitle.textContent = state.currentTarget.subtitle;

    if (state.currentTarget.type === 'CHANNEL') {
      dom.chatTargetAvatar.classList.add('hidden');
      dom.chatTargetPlaceholder.classList.remove('hidden');
      dom.chatTargetPlaceholder.textContent = '#';
      dom.chatTargetBadge.classList.add('hidden');
    } else {
      if (state.currentTarget.avatar) {
        dom.chatTargetAvatar.src = state.currentTarget.avatar;
        dom.chatTargetAvatar.classList.remove('hidden');
        dom.chatTargetPlaceholder.classList.add('hidden');
      } else {
        dom.chatTargetAvatar.classList.add('hidden');
        dom.chatTargetPlaceholder.classList.remove('hidden');
        dom.chatTargetPlaceholder.textContent = state.currentTarget.title.charAt(0).toUpperCase();
      }
      dom.chatTargetBadge.classList.remove('hidden');
      dom.chatTargetBadge.className = `presence-badge ${state.currentTarget.online ? 'online' : 'offline'}`;
    }
  }

  function renderSingleMessage(msg) {
    const isMine = msg.from.username === state.currentUser.username;
    const timeStr = formatTimestamp(msg.timestamp);

    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper ${isMine ? 'mine' : 'theirs'}`;

    let bodyHtml = '';

    // Detección de tipo de mensaje: FILE o TEXT
    if (msg.msgType === 'FILE' || msg.fileUrl) {
      const fileName = msg.fileName || 'archivo_adjunto';
      const fileUrl = msg.fileUrl || msg.content;
      const isImg = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(fileName) || (msg.fileData && msg.fileData.startsWith('data:image'));

      if (isImg) {
        bodyHtml = `
          <div>
            <img src="${fileUrl}" alt="${escapeHtml(fileName)}" class="image-preview-bubble" onclick="window.open('${fileUrl}', '_blank')">
          </div>
        `;
      } else {
        const sizeStr = msg.fileSize ? ` • ${(msg.fileSize / 1024).toFixed(1)} KB` : '';
        bodyHtml = `
          <div class="file-card-preview">
            <div class="file-icon">📄</div>
            <div class="file-card-info">
              <div class="file-card-title">${escapeHtml(fileName)}</div>
              <div class="file-card-size">Documento${sizeStr}</div>
            </div>
            <a href="${fileUrl}" target="_blank" download="${escapeHtml(fileName)}" class="file-download-btn">Descargar</a>
          </div>
        `;
      }
    } else {
      bodyHtml = `<div>${escapeHtml(msg.content)}</div>`;
    }

    const senderHeader = (!isMine && state.currentTarget.type === 'CHANNEL')
      ? `<div class="msg-sender-name">${escapeHtml(msg.from.username)}</div>`
      : '';

    const statusCheck = isMine
      ? (msg.delivered === false ? ' • <span title="Pendiente de entrega">🕒</span>' : '')
      : (msg.offline ? ' • <span title="Entregado offline">📩</span>' : '');

    wrapper.innerHTML = `
      <div style="display:flex;flex-direction:column;${isMine ? 'align-items:flex-end;' : 'align-items:flex-start;'}">
        ${senderHeader}
        <div class="message-bubble">
          ${bodyHtml}
          <div class="msg-meta">
            <span>${timeStr}</span>${statusCheck}
          </div>
        </div>
      </div>
    `;

    dom.messagesContainer.appendChild(wrapper);
  }

  function showSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'system-event-message';
    div.textContent = text;
    dom.messagesContainer.appendChild(div);
  }

  function appendMessageToCache(key, msg) {
    if (!state.historyCache.has(key)) {
      state.historyCache.set(key, []);
    }
    state.historyCache.get(key).push(msg);
  }

  function scrollToBottom() {
    dom.messagesContainer.scrollTop = dom.messagesContainer.scrollHeight;
  }

  function formatTimestamp(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ===================================================================
  // REDIMENSIONAMIENTO DE AVATAR EN CLIENTE (CANVAS 200x200)
  // ===================================================================

  function resizeImageToCanvas(file, callback) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = dom.avatarCanvas;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, 200, 200);

        // Escalado y recorte centrado (Cover)
        const size = Math.min(img.width, img.height);
        const x = (img.width - size) / 2;
        const y = (img.height - size) / 2;
        ctx.drawImage(img, x, y, size, size, 0, 0, 200, 200);

        const base64 = canvas.toDataURL('image/jpeg', 0.85);
        callback(base64);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // ===================================================================
  // GESTIÓN DE ENVÍO DE MENSAJES Y ARCHIVOS
  // ===================================================================

  function handleSendMessage() {
    const text = dom.inputMessage.value.trim();
    if (!text) return;

    if (state.currentTarget.type === 'CHANNEL') {
      sendPdu('CHANNEL_MSG', { channel: state.currentTarget.id, content: text });
    } else {
      sendPdu('PRIVATE_MSG', { to: state.currentTarget.id, content: text });
    }

    dom.inputMessage.value = '';
    dom.inputMessage.focus();
  }

  async function handleFileUpload(file) {
    if (!file) return;

    if (file.size > 9 * 1024 * 1024) {
      alert('⚠️ El archivo supera el límite permitido de 9 MB.');
      return;
    }

    showSystemMessage(`Subiendo archivo '${file.name}' al servidor...`);

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const fileData = e.target.result; // Data URL Base64

        // 1. Carga fuera de banda mediante HTTP POST /api/upload
        const response = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: file.name,
            fileData,
          }),
        });

        const result = await response.json();
        if (!result.ok) {
          throw new Error(result.error || 'Fallo en la subida HTTP');
        }

        // 2. Señalización en tiempo real vía WebSocket con la PDU FILE_OFFER
        sendPdu('FILE_OFFER', {
          targetType: state.currentTarget.type,
          targetId: state.currentTarget.id,
          fileName: result.fileName,
          fileUrl: result.fileUrl,
          fileSize: result.fileSize,
        });

      } catch (err) {
        console.error('[Upload]', err);
        alert(`Error al subir el archivo: ${err.message}`);
      }
    };
    reader.readAsDataURL(file);
  }

  function exportCurrentConversation() {
    const key = `${state.currentTarget.type}:${state.currentTarget.id}`;
    const msgs = state.historyCache.get(key) || [];

    if (msgs.length === 0) {
      alert('No hay mensajes para exportar en esta conversación.');
      return;
    }

    let output = `=======================================================\n`;
    output += `JMP MESSENGER — REGISTRO DE CONVERSACIÓN\n`;
    output += `Destino: ${state.currentTarget.title} (${state.currentTarget.type})\n`;
    output += `Fecha de exportación: ${new Date().toLocaleString()}\n`;
    output += `Total de mensajes: ${msgs.length}\n`;
    output += `=======================================================\n\n`;

    msgs.forEach((m) => {
      const ts = new Date(m.timestamp).toLocaleTimeString();
      const sender = m.from?.username || 'Sistema';
      const content = m.msgType === 'FILE' ? `[ARCHIVO ADJUNTO: ${m.fileName || m.content}]` : m.content;
      output += `[${ts}] ${sender}: ${content}\n`;
    });

    const blob = new Blob([output], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat_${state.currentTarget.id}_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ===================================================================
  // LISTENERS Y EVENTOS DE INTERFAZ
  // ===================================================================

  // Alternar Tabs Login / Register
  dom.tabLogin.onclick = () => {
    isRegisterMode = false;
    dom.tabLogin.classList.add('active');
    dom.tabRegister.classList.remove('active');
    dom.registerFields.classList.add('hidden');
    dom.authSubmitBtn.querySelector('.btn-text').textContent = 'Continuar';
    dom.authError.classList.add('hidden');
  };

  dom.tabRegister.onclick = () => {
    isRegisterMode = true;
    dom.tabRegister.classList.add('active');
    dom.tabLogin.classList.remove('active');
    dom.registerFields.classList.remove('hidden');
    dom.authSubmitBtn.querySelector('.btn-text').textContent = 'Crear Cuenta';
    dom.authError.classList.add('hidden');
  };

  // Selector de foto en registro
  dom.btnPickAuthAvatar.onclick = () => dom.authAvatarInput.click();
  dom.authAvatarInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      resizeImageToCanvas(file, (base64) => {
        tempAuthAvatarBase64 = base64;
        dom.authAvatarPreview.src = base64;
        dom.authAvatarPreview.classList.remove('hidden');
        dom.authAvatarPlaceholder.classList.add('hidden');
      });
    }
  };

  // Submit de Autenticación
  dom.authForm.onsubmit = (e) => {
    e.preventDefault();
    dom.authError.classList.add('hidden');

    const username = dom.authUsername.value.trim();
    const password = dom.authPassword.value;
    const status = dom.authStatus.value.trim();

    connectWebSocket(() => {
      sendPdu('AUTH_REGISTER', {
        username,
        password,
        status: isRegisterMode && status ? status : 'Online',
        avatar: isRegisterMode ? tempAuthAvatarBase64 : null,
      });
    });
  };

  // Envío de mensajes con Enter o botón
  dom.btnSend.onclick = handleSendMessage;
  dom.inputMessage.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Adjuntar archivos
  dom.btnAttach.onclick = () => dom.fileInput.click();
  dom.fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      handleFileUpload(file);
      dom.fileInput.value = '';
    }
  };

  // Exportar chat
  dom.btnExportChat.onclick = exportCurrentConversation;

  // Filtrado en búsqueda rápida del sidebar
  dom.searchFilter.oninput = () => {
    renderChannelsList();
    renderUsersList();
  };

  // Modal Crear Canal
  dom.btnOpenCreateChannel.onclick = () => openModal(dom.channelModal);
  dom.btnCloseChannelModal.onclick = () => closeModal(dom.channelModal);
  dom.btnCancelChannel.onclick = () => closeModal(dom.channelModal);
  dom.btnConfirmChannel.onclick = () => {
    const name = dom.newChannelInput.value.trim().replace(/^#/, '');
    if (name) {
      sendPdu('JOIN_CHANNEL', { channel: name });
      closeModal(dom.channelModal);
      dom.newChannelInput.value = '';
      selectConversation('CHANNEL', name, `#${name}`, 'Canal público');
    }
  };

  // Modal Editar Perfil
  function openProfileModal() {
    dom.editStatusInput.value = state.currentUser.status || '';
    if (state.currentUser.avatar) {
      dom.editAvatarPreview.src = state.currentUser.avatar;
      dom.editAvatarPreview.classList.remove('hidden');
      dom.editAvatarPlaceholder.classList.add('hidden');
    } else {
      dom.editAvatarPreview.classList.add('hidden');
      dom.editAvatarPlaceholder.classList.remove('hidden');
      dom.editAvatarPlaceholder.textContent = state.currentUser.username.charAt(0).toUpperCase();
    }
    openModal(dom.profileModal);
  }

  dom.btnEditProfile.onclick = openProfileModal;
  dom.profileTextClickable.onclick = openProfileModal;
  dom.btnCloseProfile.onclick = () => closeModal(dom.profileModal);
  dom.btnCancelProfile.onclick = () => closeModal(dom.profileModal);

  dom.editAvatarInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      resizeImageToCanvas(file, (base64) => {
        tempEditAvatarBase64 = base64;
        dom.editAvatarPreview.src = base64;
        dom.editAvatarPreview.classList.remove('hidden');
        dom.editAvatarPlaceholder.classList.add('hidden');
      });
    }
  };

  dom.btnSaveProfile.onclick = () => {
    const newStatus = dom.editStatusInput.value.trim();
    sendPdu('PROFILE_UPDATE', {
      status: newStatus || undefined,
      avatar: tempEditAvatarBase64 || undefined,
    });
  };

  // Logout
  dom.btnLogout.onclick = () => {
    if (confirm('¿Deseas cerrar sesión en JMP Messenger?')) {
      if (state.ws) state.ws.close(1000);
      location.reload();
    }
  };

  // Helpers de modales
  function openModal(modalEl) { modalEl.classList.remove('hidden'); }
  function closeModal(modalEl) { modalEl.classList.add('hidden'); }

})();
