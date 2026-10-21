/**
 * ===================================================================
 * JMP CHAT — CLIENTE JAVASCRIPT ES6+ (VANILLA)
 * Redes de Información — UTN FRM (2026)
 * ===================================================================
 */

(() => {
  'use strict';

  const STORAGE_KEY = 'jmp_chat_session';

  // ---------- ESTADO DE LA APLICACIÓN ----------
  const state = {
    currentUser: null,           // { userId, username, status, avatar, password }
    currentTarget: {             // Canal o chat privado actualmente abierto
      type: 'CHANNEL',           // 'CHANNEL' | 'PRIVATE'
      id: 'General',             // nombre de canal o username del destinatario
      title: '#General',
      subtitle: 'Canal público principal',
      avatar: null,
      online: true,
    },
    channels: [],                // [{ name, members }]
    joinedChannels: new Set(['General']), // Canales a los que el usuario se unió
    users: [],                   // [{ userId, username, status, avatar, online, lastSeen }]
    historyCache: new Map(),     // "CHANNEL:General" -> [mensajes]
    unreadCounts: new Map(),     // "CHANNEL:Redes" -> 2 | "PRIVATE:Carlos" -> 1
    lastActivity: new Map(),     // "CHANNEL:General" -> timestamp en ms
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
    btnBackToSidebar: document.getElementById('btn-back-to-sidebar'),
    chatTargetTitle: document.getElementById('chat-target-title'),
    chatTargetSubtitle: document.getElementById('chat-target-subtitle'),
    chatTargetAvatar: document.getElementById('chat-target-avatar'),
    chatTargetPlaceholder: document.getElementById('chat-target-placeholder'),
    chatTargetBadge: document.getElementById('chat-target-badge'),
    btnChatOptions: document.getElementById('btn-chat-options'),
    chatOptionsMenu: document.getElementById('chat-options-menu'),
    btnExportChat: document.getElementById('btn-export-chat'),
    btnClearChat: document.getElementById('btn-clear-chat'),
    btnLeaveChannel: document.getElementById('btn-leave-channel'),
    messagesContainer: document.getElementById('messages-container'),
    chatInputBar: document.getElementById('chat-input-bar'),
    inputMessage: document.getElementById('input-message'),
    btnSend: document.getElementById('btn-send'),
    btnAttach: document.getElementById('btn-attach'),
    fileInput: document.getElementById('file-input'),

    // Join Channel Bar
    chatJoinBar: document.getElementById('chat-join-bar'),
    joinBarChannelName: document.getElementById('join-bar-channel-name'),
    btnJoinChannel: document.getElementById('btn-join-channel'),

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
    console.warn('[JMP] Socket no abierto para enviar:', type);
    return false;
  }

  // ===================================================================
  // CONEXIÓN WEBSOCKET Y AUTO-RECONEXIÓN
  // ===================================================================

  function connectWebSocket(onOpenCallback) {
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
      if (state.ws.readyState === WebSocket.OPEN && onOpenCallback) {
        onOpenCallback();
      }
      return;
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}`;

    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
      console.log('[WS] Conexión abierta con el broker.');
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
      console.warn('[WS] Socket cerrado (code:', event.code, '). Intentando reconexión en 3s...');
      if (state.currentUser) {
        showSystemMessage('Aviso: Conexión interrumpida con el broker. Reconectando...');
      }
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(() => {
        connectWebSocket(() => {
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
      console.error('[WS] Error en socket:', err);
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

      case 'JOIN_CHANNEL':
        if (body.channel) {
          state.joinedChannels.add(body.channel);
          updateInputOrJoinBar();
          renderChannelsList();
        }
        break;

      case 'LEAVE_CHANNEL':
        if (body.channel) {
          state.joinedChannels.delete(body.channel);
          updateInputOrJoinBar();
          renderChannelsList();
        }
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

    const password = dom.authPassword.value || (JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}').password);

    state.currentUser = {
      userId: body.userId,
      username: body.username,
      status: 'Online',
      avatar: null,
      password,
    };

    // Guardar sesión persistente para recargas y multi-pestaña
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      username: body.username,
      password,
    }));

    // Solicitar permiso de notificaciones del navegador
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    renderMyProfile();

    // Cargar marcas de tiempo reales del último mensaje de cada chat enviadas por el servidor
    state.lastActivity = new Map();
    if (body.lastActivity && typeof body.lastActivity === 'object') {
      for (const [k, v] of Object.entries(body.lastActivity)) {
        if (v) state.lastActivity.set(k, new Date(v).getTime());
      }
    }

    if (body.channels) {
      state.channels = body.channels;
      renderChannelsList();
    }

    // Inicializar canales unidos reportados por el servidor
    const initialJoined = Array.isArray(body.joined) ? body.joined : ['General'];
    const prevJoined = state.joinedChannels || new Set();
    state.joinedChannels = new Set(initialJoined);

    // Re-unirse a canales previamente activos si nos reconectamos
    prevJoined.forEach((ch) => {
      if (!state.joinedChannels.has(ch) && ch !== 'General') {
        sendPdu('JOIN_CHANNEL', { channel: ch });
        state.joinedChannels.add(ch);
      }
    });
    if (body.users) {
      state.users = body.users.filter((u) => u.username !== state.currentUser.username);
      renderUsersList();
    }

    // Pre-cargar automáticamente el último mensaje de cada chat para ordenarlos de inmediato
    if (state.channels && state.channels.length > 0) {
      state.channels.forEach((ch) => {
        sendPdu('FETCH_HISTORY', { targetType: 'CHANNEL', targetId: ch.name, limit: 1 });
      });
    }
    if (state.users && state.users.length > 0) {
      state.users.forEach((u) => {
        sendPdu('FETCH_HISTORY', { targetType: 'PRIVATE', targetId: u.username, limit: 1 });
      });
    }

    // Seleccionar #General por defecto (sin forzar pantalla de chat en mobile)
    selectConversation('CHANNEL', 'General', '#General', 'Canal público principal', null, true, false);
  }

  function onUserPresence(body) {
    if (body.userId === state.currentUser?.userId) {
      if (body.status) state.currentUser.status = body.status;
      if (body.avatar) state.currentUser.avatar = body.avatar;
      renderMyProfile();
      return;
    }

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
    recordActivity(key, body.timestamp);
    appendMessageToCache(key, body);

    const isCurrentActive = state.currentTarget.type === 'CHANNEL' && state.currentTarget.id === body.channel;
    if (isCurrentActive) {
      renderSingleMessage(body);
      scrollToBottom();
    } else {
      // Incrementar contador de no leídos
      incrementUnread(key);
      notifyBackground(`Nuevo mensaje en #${body.channel}`, `${body.from.username}: ${body.content}`);
    }
    renderChannelsList();
  }

  function onPrivateMsg(body) {
    const isMine = body.from.username === state.currentUser.username;
    const otherUser = isMine ? body.to.username : body.from.username;
    const key = `PRIVATE:${otherUser}`;

    recordActivity(key, body.timestamp);
    appendMessageToCache(key, body);

    const isCurrentActive = state.currentTarget.type === 'PRIVATE' && state.currentTarget.id === otherUser;
    if (isCurrentActive) {
      renderSingleMessage(body);
      scrollToBottom();
    } else if (!isMine) {
      incrementUnread(key);
      notifyBackground(`Mensaje de ${body.from.username}`, body.content);
    }
    renderUsersList();
  }

  function onFileOffer(body) {
    const isChannel = body.targetType === 'CHANNEL';
    const otherUser = body.from.username === state.currentUser.username ? body.to?.username : body.from.username;
    const key = isChannel ? `CHANNEL:${body.targetId}` : `PRIVATE:${otherUser}`;

    recordActivity(key, body.timestamp);
    appendMessageToCache(key, body);

    const isCurrentActive = (isChannel && state.currentTarget.type === 'CHANNEL' && state.currentTarget.id === body.targetId) ||
      (!isChannel && state.currentTarget.type === 'PRIVATE' && state.currentTarget.id === otherUser);

    if (isCurrentActive) {
      renderSingleMessage(body);
      scrollToBottom();
    } else if (body.from.username !== state.currentUser.username) {
      incrementUnread(key);
      notifyBackground(`Archivo de ${body.from.username}`, `Envió: ${body.fileName || 'un archivo adjunto'}`);
    }
    if (isChannel) renderChannelsList();
    else renderUsersList();
  }

  function onHistoryResponse(body) {
    const key = `${body.targetType}:${body.targetId}`;
    const messages = body.messages || [];

    // Fusión indexada y ordenamiento cronológico ascendente estricto
    const merged = mergeIntoCache(key, messages);

    if (merged.length > 0) {
      const latest = merged[merged.length - 1];
      recordActivity(key, latest.timestamp);
      if (body.targetType === 'CHANNEL') renderChannelsList();
      else renderUsersList();
    }

    if (state.currentTarget.type === body.targetType && state.currentTarget.id === body.targetId) {
      dom.messagesContainer.innerHTML = '';
      if (merged.length === 0) {
        showSystemMessage('No hay mensajes previos en esta conversación.');
      } else {
        merged.forEach(renderSingleMessage);
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

    // Si ya somos miembro de un canal, registrarlo localmente sin interrumpir al usuario
    if (body.refType === 'JOIN_CHANNEL' && msg.includes('Ya sos miembro')) {
      if (state.currentTarget.type === 'CHANNEL') {
        state.joinedChannels.add(state.currentTarget.id);
      }
      return;
    }

    if (dom.authModal.classList.contains('hidden')) {
      alert(`Aviso: ${msg}`);
    } else {
      // Si falló el auto-login guardado, limpiar storage
      localStorage.removeItem(STORAGE_KEY);
      dom.authSubmitBtn.querySelector('.btn-text').textContent = 'Continuar';
      dom.authError.textContent = msg;
      dom.authError.classList.remove('hidden');
    }
  }

  // ===================================================================
  // NOTIFICACIONES, ACTIVIDAD Y CONTADORES DE NO LEÍDOS
  // ===================================================================

  function recordActivity(key, isoStringOrTs) {
    if (!key || !isoStringOrTs) return;
    const ts = typeof isoStringOrTs === 'number'
      ? isoStringOrTs
      : new Date(isoStringOrTs).getTime();
    if (isNaN(ts)) return;
    const prev = state.lastActivity.get(key) || 0;
    if (ts > prev) {
      state.lastActivity.set(key, ts);
    }
  }

  function formatTimeShort(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    if (isToday) {
      return `${h}:${m}`;
    }
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${day}/${month}`;
  }

  function mergeIntoCache(key, newMessages) {
    if (!state.historyCache.has(key)) {
      state.historyCache.set(key, []);
    }
    const current = state.historyCache.get(key);
    const map = new Map();

    for (const m of current) {
      if (m && m.id) map.set(m.id, m);
    }
    for (const m of newMessages) {
      if (m && m.id) map.set(m.id, m);
    }

    const merged = Array.from(map.values());
    merged.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    state.historyCache.set(key, merged);
    return merged;
  }

  function appendMessageToCache(key, msg) {
    if (!state.historyCache.has(key)) {
      state.historyCache.set(key, []);
    }
    const list = state.historyCache.get(key);
    if (!list.some((m) => m.id === msg.id)) {
      list.push(msg);
      list.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    }
  }

  function incrementUnread(key) {
    const current = state.unreadCounts.get(key) || 0;
    state.unreadCounts.set(key, current + 1);
    renderChannelsList();
    renderUsersList();
  }

  function clearUnread(key) {
    if (state.unreadCounts.has(key)) {
      state.unreadCounts.delete(key);
      renderChannelsList();
      renderUsersList();
    }
  }

  function notifyBackground(title, body) {
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      try {
        new Notification(title, {
          body,
          icon: '/favicon.ico',
        });
      } catch (e) {
        // Ignorar excepciones de políticas en móviles
      }
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

    // Ordenamiento inteligente de canales: no leídos primero, luego actividad más reciente, luego #General, luego alfabético
    const sortedChannels = [...state.channels].sort((a, b) => {
      const keyA = `CHANNEL:${a.name}`;
      const keyB = `CHANNEL:${b.name}`;
      const unreadA = state.unreadCounts.get(keyA) || 0;
      const unreadB = state.unreadCounts.get(keyB) || 0;
      const tsA = state.lastActivity.get(keyA) || 0;
      const tsB = state.lastActivity.get(keyB) || 0;

      if (unreadA !== unreadB) {
        return unreadB - unreadA;
      }
      if (tsA !== tsB) {
        return tsB - tsA;
      }
      if (a.name.toLowerCase() === 'general') return -1;
      if (b.name.toLowerCase() === 'general') return 1;
      return a.name.localeCompare(b.name);
    });

    sortedChannels.forEach((ch) => {
      const key = `CHANNEL:${ch.name}`;
      const unread = state.unreadCounts.get(key) || 0;
      const lastTs = state.lastActivity.get(key) || 0;
      const isActive = state.currentTarget.type === 'CHANNEL' && state.currentTarget.id === ch.name;

      const li = document.createElement('li');
      li.className = `item-row ${isActive ? 'active' : ''}`;

      const timeHtml = lastTs > 0 ? `<span class="item-time">${formatTimeShort(lastTs)}</span>` : '';
      const badgeHtml = unread > 0
        ? `<span class="unread-badge">${unread}</span>`
        : `<span class="item-badge-members">${ch.members}</span>`;

      li.innerHTML = `
        <span class="channel-hash">#</span>
        <span class="item-label">${escapeHtml(ch.name)}</span>
        <div class="item-meta-right">
          ${timeHtml}
          ${badgeHtml}
        </div>
      `;
      li.onclick = () => {
        selectConversation(
          'CHANNEL',
          ch.name,
          `#${ch.name}`,
          `${ch.members} miembro(s) conectado(s)`,
          null,
          true,
          true
        );
      };
      dom.channelsList.appendChild(li);
    });
  }

  function renderUsersList() {
    dom.usersList.innerHTML = '';
    const filter = dom.searchFilter.value.toLowerCase().trim();

    const filtered = state.users.filter((u) => u.username.toLowerCase().includes(filter));
    dom.usersCount.textContent = state.users.length;

    // Ordenamiento inteligente de mensajes directos: no leídos primero, luego actividad reciente descendente, luego online, luego alfabético
    const sortedUsers = [...filtered].sort((a, b) => {
      const keyA = `PRIVATE:${a.username}`;
      const keyB = `PRIVATE:${b.username}`;
      const unreadA = state.unreadCounts.get(keyA) || 0;
      const unreadB = state.unreadCounts.get(keyB) || 0;
      const tsA = state.lastActivity.get(keyA) || 0;
      const tsB = state.lastActivity.get(keyB) || 0;

      if (unreadA !== unreadB) {
        return unreadB - unreadA;
      }
      if (tsA > 0 || tsB > 0) {
        if (tsA !== tsB) {
          return tsB - tsA;
        }
      }
      if (Boolean(a.online) !== Boolean(b.online)) {
        return a.online ? -1 : 1;
      }
      return a.username.localeCompare(b.username);
    });

    sortedUsers.forEach((u) => {
      const key = `PRIVATE:${u.username}`;
      const unread = state.unreadCounts.get(key) || 0;
      const lastTs = state.lastActivity.get(key) || 0;
      const isActive = state.currentTarget.type === 'PRIVATE' && state.currentTarget.id === u.username;

      const li = document.createElement('li');
      li.className = `item-row ${isActive ? 'active' : ''}`;

      const avatarHtml = u.avatar
        ? `<img src="${u.avatar}" class="avatar-circle" style="width:28px;height:28px;">`
        : `<div class="avatar-circle avatar-placeholder" style="width:28px;height:28px;font-size:12px;">${u.username.charAt(0).toUpperCase()}</div>`;

      const timeHtml = lastTs > 0 ? `<span class="item-time">${formatTimeShort(lastTs)}</span>` : '';
      const badgeHtml = unread > 0 ? `<span class="unread-badge">${unread}</span>` : '';

      li.innerHTML = `
        <div style="position:relative;flex-shrink:0;">
          ${avatarHtml}
          <span class="presence-badge ${u.online ? 'online' : 'offline'}" style="width:8px;height:8px;border-width:1.5px;"></span>
        </div>
        <div style="flex:1;min-width:0;">
          <div class="item-label">${escapeHtml(u.username)}</div>
          <div style="font-size:11px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(u.status || (u.online ? 'En línea' : 'Desconectado'))}</div>
        </div>
        <div class="item-meta-right">
          ${timeHtml}
          ${badgeHtml}
        </div>
      `;

      li.onclick = () => {
        selectConversation(
          'PRIVATE',
          u.username,
          u.username,
          u.online ? (u.status || 'En línea') : 'Desconectado',
          u.avatar,
          u.online,
          true
        );
      };
      dom.usersList.appendChild(li);
    });
  }

  function selectConversation(type, id, title, subtitle, avatar = null, online = true, isUserInteraction = true) {
    state.currentTarget = { type, id, title, subtitle, avatar, online };

    if (isUserInteraction) {
      dom.appLayout.classList.add('mobile-chat-open');
    }

    // Limpiar badge de no leídos de esta conversación
    clearUnread(`${type}:${id}`);

    renderChatHeader();
    renderChannelsList();
    renderUsersList();
    updateInputOrJoinBar();

    // Limpiar contenedor de mensajes y solicitar historial indexado
    dom.messagesContainer.innerHTML = '';
    sendPdu('FETCH_HISTORY', { targetType: type, targetId: id, limit: 50 });
  }

  function updateInputOrJoinBar() {
    if (!dom.chatInputBar || !dom.chatJoinBar) return;

    if (state.currentTarget.type === 'CHANNEL') {
      const isMember = state.joinedChannels && state.joinedChannels.has(state.currentTarget.id);
      if (isMember) {
        dom.chatJoinBar.classList.add('hidden');
        dom.chatInputBar.classList.remove('hidden');
      } else {
        dom.chatInputBar.classList.add('hidden');
        dom.chatJoinBar.classList.remove('hidden');
        if (dom.joinBarChannelName) {
          dom.joinBarChannelName.textContent = `#${state.currentTarget.id}`;
        }
      }

      if (dom.btnLeaveChannel) {
        if (isMember && state.currentTarget.id.toLowerCase() !== 'general') {
          dom.btnLeaveChannel.classList.remove('hidden');
        } else {
          dom.btnLeaveChannel.classList.add('hidden');
        }
      }
    } else {
      dom.chatJoinBar.classList.add('hidden');
      dom.chatInputBar.classList.remove('hidden');
      if (dom.btnLeaveChannel) dom.btnLeaveChannel.classList.add('hidden');
    }
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

    // Detección robusta de archivo (por msgType, fileUrl o URL en content)
    const isFile = msg.msgType === 'FILE' || Boolean(msg.fileUrl) || (typeof msg.content === 'string' && msg.content.startsWith('/uploads/'));

    if (isFile) {
      const fileUrl = msg.fileUrl || msg.content;
      const rawName = msg.fileName || fileUrl.split('/').pop() || 'archivo_adjunto';
      const isImg = /\.(png|jpe?g|gif|webp|svg)$/i.test(fileUrl) || /\.(png|jpe?g|gif|webp|svg)$/i.test(rawName);

      if (isImg) {
        bodyHtml = `
          <div>
            <img src="${fileUrl}" alt="${escapeHtml(rawName)}" class="image-preview-bubble" onclick="window.open('${fileUrl}', '_blank')" title="Clic para abrir en tamaño completo">
          </div>
        `;
      } else {
        const sizeStr = msg.fileSize ? ` • ${(msg.fileSize / 1024).toFixed(1)} KB` : '';
        bodyHtml = `
          <div class="file-card-preview">
            <div class="file-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="16" y1="13" x2="8" y2="13"></line>
                <line x1="16" y1="17" x2="8" y2="17"></line>
              </svg>
            </div>
            <div class="file-card-info">
              <div class="file-card-title" title="${escapeHtml(rawName)}">${escapeHtml(rawName)}</div>
              <div class="file-card-size">Documento${sizeStr}</div>
            </div>
            <a href="${fileUrl}" target="_blank" download="${escapeHtml(rawName)}" class="file-download-btn">Descargar</a>
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
      ? (msg.delivered === false ? ' • <span title="Pendiente de entrega">Pendiente</span>' : '')
      : (msg.offline ? ' • <span title="Entregado offline">Diferido</span>' : '');

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
      if (!state.joinedChannels.has(state.currentTarget.id)) {
        updateInputOrJoinBar();
        return;
      }
      sendPdu('CHANNEL_MSG', { channel: state.currentTarget.id, content: text });
    } else {
      sendPdu('PRIVATE_MSG', { to: state.currentTarget.id, content: text });
    }

    dom.inputMessage.value = '';
    dom.inputMessage.focus();
  }

  async function handleFileUpload(file) {
    if (!file) return;

    if (state.currentTarget.type === 'CHANNEL' && !state.joinedChannels.has(state.currentTarget.id)) {
      alert('Debés unirte a este canal para poder enviar archivos.');
      updateInputOrJoinBar();
      return;
    }

    if (file.size > 9 * 1024 * 1024) {
      alert('Aviso: El archivo supera el límite de 9 MB.');
      return;
    }

    showSystemMessage(`Subiendo archivo '${file.name}' al servidor...`);

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const fileData = e.target.result;

        // 1. Carga fuera de banda vía HTTP POST /api/upload
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

        // 2. Señalización en tiempo real vía WebSocket con FILE_OFFER

        sendPdu('FILE_OFFER', {
          targetType: state.currentTarget.type,
          targetId: state.currentTarget.id,
          fileName: result.fileName,
          fileUrl: result.fileUrl,
          fileSize: result.fileSize,
        });

      } catch (err) {
        console.error('[Upload]', err);
        alert(`Error al transferir el archivo: ${err.message}`);
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
    output += `JMP CHAT — REGISTRO DE CONVERSACIÓN\n`;
    output += `Destino: ${state.currentTarget.title} (${state.currentTarget.type})\n`;
    output += `Fecha de exportación: ${new Date().toLocaleString()}\n`;
    output += `Total de mensajes: ${msgs.length}\n`;
    output += `=======================================================\n\n`;

    msgs.forEach((m) => {
      const ts = new Date(m.timestamp).toLocaleTimeString();
      const sender = m.from?.username || 'Sistema';
      const content = (m.msgType === 'FILE' || m.fileUrl) ? `[ARCHIVO ADJUNTO: ${m.fileName || m.fileUrl || m.content}]` : m.content;
      output += `[${ts}] ${sender}: ${content}\n`;
    });

    const blob = new Blob([output], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat_${state.currentTarget.id}_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    dom.chatOptionsMenu.classList.add('hidden');
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

  // Submit de Autenticación manual
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
        mode: isRegisterMode ? 'register' : 'login',
        status: isRegisterMode && status ? status : 'Online',
        avatar: isRegisterMode ? tempAuthAvatarBase64 : null,
      });
    });
  };

  // Botón volver a lista de chats en vista móvil
  if (dom.btnBackToSidebar) {
    dom.btnBackToSidebar.onclick = () => {
      dom.appLayout.classList.remove('mobile-chat-open');
    };
  }

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

  // Menú de opciones (3 puntos)
  dom.btnChatOptions.onclick = (e) => {
    e.stopPropagation();
    dom.chatOptionsMenu.classList.toggle('hidden');
  };

  document.addEventListener('click', (e) => {
    if (!dom.chatOptionsMenu.contains(e.target) && e.target !== dom.btnChatOptions) {
      dom.chatOptionsMenu.classList.add('hidden');
    }
  });

  dom.btnExportChat.onclick = exportCurrentConversation;

  dom.btnClearChat.onclick = () => {
    dom.messagesContainer.innerHTML = '';
    showSystemMessage('Vista local de la conversación limpiada.');
    dom.chatOptionsMenu.classList.add('hidden');
  };

  // Botón Unirse al Canal (cuando no se es miembro)
  if (dom.btnJoinChannel) {
    dom.btnJoinChannel.onclick = () => {
      const channel = state.currentTarget.id;
      sendPdu('JOIN_CHANNEL', { channel });
      state.joinedChannels.add(channel);
      updateInputOrJoinBar();
      dom.inputMessage.focus();
      renderChannelsList();
    };
  }

  // Opción Salir del Canal (menú de 3 puntos)
  if (dom.btnLeaveChannel) {
    dom.btnLeaveChannel.onclick = () => {
      const channel = state.currentTarget.id;
      sendPdu('LEAVE_CHANNEL', { channel });
      state.joinedChannels.delete(channel);
      dom.chatOptionsMenu.classList.add('hidden');
      updateInputOrJoinBar();
      renderChannelsList();
    };
  }

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
      state.joinedChannels.add(name);
      closeModal(dom.channelModal);
      dom.newChannelInput.value = '';
      selectConversation('CHANNEL', name, `#${name}`, 'Canal público', null, true, true);
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
    if (confirm('¿Deseas cerrar sesión en JMP Chat?')) {
      dom.appLayout.classList.remove('mobile-chat-open');
      localStorage.removeItem(STORAGE_KEY);
      if (state.ws) state.ws.close(1000);
      location.reload();
    }
  };

  // Helpers de modales
  function openModal(modalEl) { modalEl.classList.remove('hidden'); }
  function closeModal(modalEl) { modalEl.classList.add('hidden'); }

  // ===================================================================
  // AUTO-LOGIN POR LOCALSTORAGE AL RECARGAR PÁGINA
  // ===================================================================
  const savedSession = localStorage.getItem(STORAGE_KEY);
  if (savedSession) {
    try {
      const creds = JSON.parse(savedSession);
      if (creds && creds.username && creds.password) {
        dom.authUsername.value = creds.username;
        dom.authPassword.value = creds.password;
        dom.authSubmitBtn.querySelector('.btn-text').textContent = 'Reconectando sesión...';
        connectWebSocket(() => {
          sendPdu('AUTH_REGISTER', {
            username: creds.username,
            password: creds.password,
            mode: 'login',
          });
        });
      }
    } catch (e) {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

})();
