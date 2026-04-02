const API = 'http://localhost:5000';

// ── Auth helpers ───────────────────────────────────────
function getToken() {
  return localStorage.getItem('access_token');
}

async function apiFetch(url, options) {
  options = options || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  let res;
  try {
    res = await fetch(API + url, Object.assign({}, options, { headers: headers }));
  } catch (e) {
    throw new Error('Сервер недоступен: ' + e.message);
  }

  // Токен истёк — пробуем refresh
  if (res.status === 401) {
    const refreshToken = localStorage.getItem('refresh_token');
    if (refreshToken) {
      try {
        const r = await fetch(API + '/api/auth/refresh', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ refresh_token: refreshToken })
        });
        if (r.ok) {
          const d = await r.json();
          localStorage.setItem('access_token',  d.access_token);
          localStorage.setItem('refresh_token', d.refresh_token);
          headers['Authorization'] = 'Bearer ' + d.access_token;
          return fetch(API + url, Object.assign({}, options, { headers: headers }));
        }
      } catch (e) { /* не удалось обновить */ }
    }
    localStorage.clear();
    window.location.replace('login.html');
    return res;
  }
  return res;
}

// ── Проверка авторизации ───────────────────────────────
if (!getToken()) {
  window.location.replace('login.html');
}

// ── State ──────────────────────────────────────────────
var chats        = [];
var activeChatId = null;

// ── DOM refs ───────────────────────────────────────────
var chatListEl     = document.getElementById('chatList');
var chatWindowEl   = document.getElementById('chatWindow');
var typingEl       = document.getElementById('typingIndicator');
var currentLabelEl = document.getElementById('currentChatLabel');
var messageInputEl = document.getElementById('messageInput');
var confirmOverlay = document.getElementById('confirmOverlay');
var confirmNameEl  = document.getElementById('confirmChatName');
var greetingEl     = document.getElementById('greetingEl');

// ── Greeting ───────────────────────────────────────────
var userEmail = localStorage.getItem('user_email') || '';
if (greetingEl && userEmail) greetingEl.textContent = '👋 ' + userEmail;

// ══════════════════════════════════════════════════════
//  CHANGE PASSWORD MODAL
// ══════════════════════════════════════════════════════
var changePwOverlay   = document.getElementById('changePwOverlay');
var changePwUserLabel = document.getElementById('changePwUserLabel');
var changePwMsg       = document.getElementById('changePwMsg');
var changePwSubmitBtn = document.getElementById('changePwSubmitBtn');

function openChangePw() {
  changePwUserLabel.textContent = 'Аккаунт: ' + userEmail;
  changePwMsg.className = 'inline-msg';
  changePwMsg.textContent = '';
  document.getElementById('oldPassword').value  = '';
  document.getElementById('newPassword').value  = '';
  document.getElementById('newPassword2').value = '';
  changePwOverlay.classList.add('visible');
  setTimeout(function() { document.getElementById('oldPassword').focus(); }, 200);
}

function closeChangePw() {
  changePwOverlay.classList.remove('visible');
}

function showChangePwMsg(text, type) {
  changePwMsg.className = 'inline-msg ' + (type || 'error');
  changePwMsg.textContent = text;
}

function setChangePwLoading(loading) {
  if (loading) {
    changePwSubmitBtn.disabled = true;
    changePwSubmitBtn.innerHTML = '<span class="spinner"></span>Подождите...';
  } else {
    changePwSubmitBtn.disabled = false;
    changePwSubmitBtn.textContent = 'Сменить пароль';
  }
}

document.getElementById('changePwBtn').addEventListener('click', openChangePw);
document.getElementById('changePwCancelBtn').addEventListener('click', closeChangePw);
changePwOverlay.addEventListener('click', function(e) {
  if (e.target === changePwOverlay) closeChangePw();
});

changePwSubmitBtn.addEventListener('click', async function() {
  var oldPw  = document.getElementById('oldPassword').value;
  var newPw  = document.getElementById('newPassword').value;
  var newPw2 = document.getElementById('newPassword2').value;

  if (!oldPw || !newPw || !newPw2) { showChangePwMsg('Заполните все поля'); return; }
  if (newPw !== newPw2)            { showChangePwMsg('Новые пароли не совпадают'); return; }
  if (newPw.length < 6)           { showChangePwMsg('Пароль минимум 6 символов'); return; }

  setChangePwLoading(true);
  try {
    var res  = await apiFetch('/api/auth/change-password', {
      method: 'POST',
      body:   JSON.stringify({ old_password: oldPw, new_password: newPw })
    });
    var data = await res.json();
    if (!res.ok) { showChangePwMsg(data.error || 'Ошибка'); return; }
    showChangePwMsg('Пароль изменён! Войдите заново.', 'success');
    setTimeout(function() {
      localStorage.clear();
      window.location.replace('login.html');
    }, 1500);
  } catch (e) {
    showChangePwMsg('Ошибка: ' + e.message);
  } finally {
    setChangePwLoading(false);
  }
});

['oldPassword', 'newPassword', 'newPassword2'].forEach(function(id) {
  document.getElementById(id).addEventListener('keydown', function(e) {
    if (e.key === 'Enter') changePwSubmitBtn.click();
  });
});

// ══════════════════════════════════════════════════════
//  CONTEXT MENU
// ══════════════════════════════════════════════════════
var ctxMenu         = null;
var pendingDeleteId = null;
var renamingId      = null;

function removeCtxMenu() {
  if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
}

function showContextMenu(x, y, chatId, chatName) {
  removeCtxMenu();
  ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctx-menu';
  ctxMenu.innerHTML =
    '<button class="ctx-item" data-action="rename">✏️ Переименовать</button>' +
    '<button class="ctx-item danger" data-action="delete">🗑 Удалить</button>';
  ctxMenu.style.cssText = 'position:fixed;left:' + x + 'px;top:' + y + 'px;z-index:200;';
  document.body.appendChild(ctxMenu);

  var rect = ctxMenu.getBoundingClientRect();
  if (rect.right  > window.innerWidth)  ctxMenu.style.left = (x - rect.width)  + 'px';
  if (rect.bottom > window.innerHeight) ctxMenu.style.top  = (y - rect.height) + 'px';

  ctxMenu.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'rename') startRename(chatId);
    if (btn.dataset.action === 'delete') openConfirm(chatId, chatName);
    removeCtxMenu();
  });
}

document.addEventListener('click', removeCtxMenu);
document.addEventListener('contextmenu', function(e) {
  if (!e.target.closest('.chat-item')) removeCtxMenu();
});

// ══════════════════════════════════════════════════════
//  RENAME
// ══════════════════════════════════════════════════════
function startRename(chatId) {
  renamingId = chatId;
  renderChatList();
}

async function commitRename(chatId, newName) {
  newName = (newName || '').trim();
  renamingId = null;
  if (!newName) { renderChatList(); return; }
  try {
    var res = await apiFetch('/api/chats/' + chatId, {
      method: 'PATCH',
      body:   JSON.stringify({ name: newName })
    });
    if (res.ok) {
      var chat = chats.find(function(c) { return c.id === chatId; });
      if (chat) chat.name = newName;
      if (activeChatId === chatId)
        currentLabelEl.innerHTML = 'Текущий чат:<br><span>' + newName + '</span>';
    }
  } catch (e) { /* silent */ }
  renderChatList();
}

// ══════════════════════════════════════════════════════
//  RENDER
// ══════════════════════════════════════════════════════
function renderChatList() {
  chatListEl.innerHTML = '';
  chats.forEach(function(chat) {
    var item = document.createElement('div');
    item.className = 'chat-item' + (chat.id === activeChatId ? ' active' : '');
    item.dataset.chatId = chat.id;

    if (renamingId === chat.id) {
      var inp = document.createElement('input');
      inp.type      = 'text';
      inp.className = 'rename-input';
      inp.value     = chat.name;
      inp.addEventListener('keydown', function(e) {
        if (e.key === 'Enter')  commitRename(chat.id, inp.value);
        if (e.key === 'Escape') { renamingId = null; renderChatList(); }
        e.stopPropagation();
      });
      inp.addEventListener('blur', function() { commitRename(chat.id, inp.value); });
      item.appendChild(inp);
      chatListEl.appendChild(item);
      setTimeout(function() { inp.focus(); inp.select(); }, 0);
    } else {
      var nameEl = document.createElement('span');
      nameEl.className   = 'chat-item-name';
      nameEl.textContent = chat.name;
      item.appendChild(nameEl);
      item.addEventListener('click', function() { switchChat(chat.id); });
      item.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, chat.id, chat.name);
      });
      chatListEl.appendChild(item);
    }
  });
}

function renderMessages(messages) {
  messages = messages || [];
  Array.from(chatWindowEl.children).forEach(function(ch) {
    if (ch.id !== 'typingIndicator') ch.remove();
  });
  messages.forEach(function(msg) {
    var role = msg.role === 'assistant' ? 'bot' : 'user';
    var time = msg.created_at ? msg.created_at.substring(11, 16) : nowTime();
    chatWindowEl.insertBefore(buildMessageEl(msg.content || msg.text || '', role, time), typingEl);
  });
  chatWindowEl.scrollTop = chatWindowEl.scrollHeight;
}

function buildMessageEl(text, role, time) {
  var wrap   = document.createElement('div');
  wrap.className = 'message ' + role;
  var bubble = document.createElement('div');
  bubble.className   = 'msg-bubble';
  bubble.textContent = text;
  var t = document.createElement('div');
  t.className   = 'msg-time';
  t.textContent = time || nowTime();
  wrap.appendChild(bubble);
  wrap.appendChild(t);
  return wrap;
}

function addMessageEl(text, role) {
  chatWindowEl.insertBefore(buildMessageEl(text, role, nowTime()), typingEl);
  chatWindowEl.scrollTop = chatWindowEl.scrollHeight;
}

// ══════════════════════════════════════════════════════
//  CHAT OPERATIONS
// ══════════════════════════════════════════════════════
async function switchChat(id) {
  activeChatId = id;
  var chat = chats.find(function(c) { return c.id === id; });
  currentLabelEl.innerHTML = 'Текущий чат:<br><span>' + (chat ? chat.name : '—') + '</span>';
  renderChatList();

  Array.from(chatWindowEl.children).forEach(function(ch) {
    if (ch.id !== 'typingIndicator') ch.remove();
  });
  typingEl.classList.add('visible');

  try {
    var res  = await apiFetch('/api/chats/' + id + '/messages');
    var msgs = await res.json();
    typingEl.classList.remove('visible');
    renderMessages(Array.isArray(msgs) ? msgs : []);
  } catch (e) {
    typingEl.classList.remove('visible');
    addMessageEl('Не удалось загрузить историю: ' + e.message, 'bot');
  }
}

async function loadChats() {
  try {
    var res = await apiFetch('/api/chats');
    if (!res.ok) {
      var err = await res.json().catch(function() { return {}; });
      currentLabelEl.innerHTML = 'Ошибка загрузки: ' + (err.error || res.status);
      return;
    }
    chats = await res.json();
    renderChatList();
    if (chats.length) {
      switchChat(chats[0].id);
    } else {
      currentLabelEl.innerHTML = 'Текущий чат:<br><span>—</span>';
    }
  } catch (e) {
    currentLabelEl.innerHTML = 'Ошибка: ' + e.message;
  }
}

async function createNewChat() {
  try {
    // Всегда передаём JSON body чтобы Content-Type был правильным
    var res  = await apiFetch('/api/chats', {
      method: 'POST',
      body:   JSON.stringify({})
    });
    if (!res.ok) {
      var err = await res.json().catch(function() { return {}; });
      console.error('Ошибка создания чата:', err.error || res.status);
      return null;
    }
    var chat = await res.json();
    chats.unshift(chat);
    await switchChat(chat.id);
    return chat.id;
  } catch (e) {
    console.error('createNewChat error:', e.message);
    return null;
  }
}

function openConfirm(id, name) {
  pendingDeleteId = id;
  confirmNameEl.textContent = name;
  confirmOverlay.classList.add('visible');
}
function closeConfirm() {
  confirmOverlay.classList.remove('visible');
  pendingDeleteId = null;
}
async function confirmDelete() {
  if (!pendingDeleteId) return;
  var id = pendingDeleteId;
  closeConfirm();
  try { await apiFetch('/api/chats/' + id, { method: 'DELETE' }); } catch (e) { /* silent */ }
  chats = chats.filter(function(c) { return c.id !== id; });
  if (activeChatId === id) activeChatId = chats.length ? chats[0].id : null;
  renderChatList();
  if (activeChatId) {
    switchChat(activeChatId);
  } else {
    currentLabelEl.innerHTML = 'Текущий чат:<br><span>—</span>';
    Array.from(chatWindowEl.children).forEach(function(ch) {
      if (ch.id !== 'typingIndicator') ch.remove();
    });
  }
}

// ══════════════════════════════════════════════════════
//  SEND MESSAGE → GPT-4o
// ══════════════════════════════════════════════════════
async function sendMessage() {
  var text = messageInputEl.value.trim();
  if (!text) return;

  // Создаём чат если нет активного
  if (!activeChatId) {
    var newId = await createNewChat();
    if (!newId) {
      addMessageEl('Ошибка: не удалось создать чат', 'bot');
      return;
    }
  }

  addMessageEl(text, 'user');
  messageInputEl.value = '';
  typingEl.classList.add('visible');
  chatWindowEl.scrollTop = chatWindowEl.scrollHeight;

  // Собираем историю из DOM
  var history = [];
  Array.from(chatWindowEl.children).forEach(function(ch) {
    if (ch.id === 'typingIndicator') return;
    var role    = ch.classList.contains('user') ? 'user' : 'assistant';
    var bubble  = ch.querySelector('.msg-bubble');
    var content = bubble ? bubble.textContent : '';
    if (content) history.push({ role: role, content: content });
  });

  try {
    var res  = await apiFetch('/api/chat', {
      method: 'POST',
      body:   JSON.stringify({ messages: history, chat_id: activeChatId })
    });
    var data = await res.json();
    typingEl.classList.remove('visible');
    if (res.ok) {
      addMessageEl(data.text || 'Пустой ответ', 'bot');
    } else {
      addMessageEl('Ошибка GPT: ' + (data.error || res.status), 'bot');
    }
    var chat = chats.find(function(c) { return c.id === activeChatId; });
    if (chat) chat.updated_at = new Date().toISOString();
  } catch (e) {
    typingEl.classList.remove('visible');
    addMessageEl('Ошибка соединения: ' + e.message, 'bot');
  }
}

// ══════════════════════════════════════════════════════
//  UPLOAD AUDIO → WHISPER
// ══════════════════════════════════════════════════════
function uploadFile() {
  var fi = document.createElement('input');
  fi.type   = 'file';
  fi.accept = 'audio/*';
  fi.click();
  fi.onchange = async function() {
    var file = fi.files[0];
    if (!file) return;
    if (!activeChatId) {
      var newId = await createNewChat();
      if (!newId) return;
    }
    addMessageEl('🎵 Аудио: ' + file.name, 'user');
    typingEl.classList.add('visible');
    chatWindowEl.scrollTop = chatWindowEl.scrollHeight;
    try {
      var token = getToken();
      var fd = new FormData();
      fd.append('file', file);
      var res  = await fetch(API + '/api/transcribe', {
        method:  'POST',
        headers: token ? { 'Authorization': 'Bearer ' + token } : {},
        body:    fd
      });
      var data = await res.json();
      typingEl.classList.remove('visible');
      addMessageEl(data.text || ('Ошибка: ' + (data.error || 'не удалось распознать')), 'bot');
    } catch (e) {
      typingEl.classList.remove('visible');
      addMessageEl('Ошибка: ' + e.message, 'bot');
    }
  };
}

// ══════════════════════════════════════════════════════
//  DOWNLOAD HISTORY
// ══════════════════════════════════════════════════════
function downloadHistory() {
  var chat = chats.find(function(c) { return c.id === activeChatId; });
  if (!chat) return;
  var lines = [];
  Array.from(chatWindowEl.children).forEach(function(ch) {
    if (ch.id === 'typingIndicator') return;
    var timeEl  = ch.querySelector('.msg-time');
    var bubbleEl = ch.querySelector('.msg-bubble');
    var time  = timeEl   ? timeEl.textContent   : '';
    var text  = bubbleEl ? bubbleEl.textContent : '';
    var who   = ch.classList.contains('user') ? 'Пользователь' : 'Бот';
    if (text) lines.push('[' + time + '] ' + who + ': ' + text);
  });
  if (!lines.length) return;
  var a = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
  a.download = chat.name + '.txt';
  a.click();
}

function nowTime() {
  return new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}

// ══════════════════════════════════════════════════════
//  EVENTS
// ══════════════════════════════════════════════════════
document.getElementById('sendBtn').addEventListener('click', sendMessage);
messageInputEl.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') sendMessage();
});
document.getElementById('newChatBtn').addEventListener('click', createNewChat);
document.getElementById('downloadBtn').addEventListener('click', downloadHistory);
document.getElementById('uploadBtn').addEventListener('click', uploadFile);
document.getElementById('confirmCancelBtn').addEventListener('click', closeConfirm);
document.getElementById('confirmDeleteBtn').addEventListener('click', confirmDelete);
confirmOverlay.addEventListener('click', function(e) {
  if (e.target === confirmOverlay) closeConfirm();
});
document.getElementById('logoutBtn').addEventListener('click', function() {
  localStorage.clear();
  window.location.replace('login.html');
});

// ══════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════
loadChats();