const API = 'http://localhost:5000';

// ── Auth helpers ───────────────────────────────────────
function getToken() { return localStorage.getItem('access_token'); }

async function apiFetch(url, options) {
  options = options || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  let res;
  try {
    res = await fetch(API + url, Object.assign({}, options, { headers: headers }));
  } catch (e) { throw new Error('Сервер недоступен: ' + e.message); }
  if (res.status === 401) {
    const rt = localStorage.getItem('refresh_token');
    if (rt) {
      try {
        const r = await fetch(API + '/api/auth/refresh', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: rt })
        });
        if (r.ok) {
          const d = await r.json();
          localStorage.setItem('access_token', d.access_token);
          localStorage.setItem('refresh_token', d.refresh_token);
          headers['Authorization'] = 'Bearer ' + d.access_token;
          return fetch(API + url, Object.assign({}, options, { headers: headers }));
        }
      } catch (e) {}
    }
    localStorage.clear();
    window.location.replace('login.html');
    return res;
  }
  return res;
}

if (!getToken()) window.location.replace('login.html');

// ── State ──────────────────────────────────────────────
var chats        = [];
var activeChatId = null;
var activeHistory = [];
var lastTranscription = ''; // Последний транскрибированный текст

// ── DOM refs ───────────────────────────────────────────
var chatListEl     = document.getElementById('chatList');
var chatWindowEl   = document.getElementById('chatWindow');
var typingEl       = document.getElementById('typingIndicator');
var currentLabelEl = document.getElementById('currentChatLabel');
var messageInputEl = document.getElementById('messageInput');
var confirmOverlay = document.getElementById('confirmOverlay');
var confirmNameEl  = document.getElementById('confirmChatName');
var greetingEl     = document.getElementById('greetingEl');

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
  changePwMsg.className = 'inline-msg'; changePwMsg.textContent = '';
  document.getElementById('oldPassword').value = '';
  document.getElementById('newPassword').value = '';
  document.getElementById('newPassword2').value = '';
  changePwOverlay.classList.add('visible');
  setTimeout(function() { document.getElementById('oldPassword').focus(); }, 200);
}
function closeChangePw() { changePwOverlay.classList.remove('visible'); }
function showChangePwMsg(text, type) {
  changePwMsg.className = 'inline-msg ' + (type || 'error');
  changePwMsg.textContent = text;
}
function setChangePwLoading(loading) {
  if (loading) { changePwSubmitBtn.disabled = true; changePwSubmitBtn.innerHTML = '<span class="spinner"></span>Подождите...'; }
  else { changePwSubmitBtn.disabled = false; changePwSubmitBtn.textContent = 'Сменить пароль'; }
}
document.getElementById('changePwBtn').addEventListener('click', openChangePw);
document.getElementById('changePwCancelBtn').addEventListener('click', closeChangePw);
changePwOverlay.addEventListener('click', function(e) { if (e.target === changePwOverlay) closeChangePw(); });
changePwSubmitBtn.addEventListener('click', async function() {
  var oldPw = document.getElementById('oldPassword').value;
  var newPw = document.getElementById('newPassword').value;
  var newPw2 = document.getElementById('newPassword2').value;
  if (!oldPw || !newPw || !newPw2) { showChangePwMsg('Заполните все поля'); return; }
  if (newPw !== newPw2) { showChangePwMsg('Новые пароли не совпадают'); return; }
  if (newPw.length < 6) { showChangePwMsg('Пароль минимум 6 символов'); return; }
  setChangePwLoading(true);
  try {
    var res = await apiFetch('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ old_password: oldPw, new_password: newPw }) });
    var data = await res.json();
    if (!res.ok) { showChangePwMsg(data.error || 'Ошибка'); return; }
    showChangePwMsg('Пароль изменён! Войдите заново.', 'success');
    setTimeout(function() { localStorage.clear(); window.location.replace('login.html'); }, 1500);
  } catch (e) { showChangePwMsg('Ошибка: ' + e.message); }
  finally { setChangePwLoading(false); }
});
['oldPassword', 'newPassword', 'newPassword2'].forEach(function(id) {
  document.getElementById(id).addEventListener('keydown', function(e) { if (e.key === 'Enter') changePwSubmitBtn.click(); });
});

// ══════════════════════════════════════════════════════
//  CONTEXT MENU
// ══════════════════════════════════════════════════════
var ctxMenu = null, pendingDeleteId = null, renamingId = null;

function removeCtxMenu() { if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; } }
function showContextMenu(x, y, chatId, chatName) {
  removeCtxMenu();
  ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctx-menu';
  ctxMenu.innerHTML = '<button class="ctx-item" data-action="rename">✏️ Переименовать</button><button class="ctx-item danger" data-action="delete">🗑 Удалить</button>';
  ctxMenu.style.cssText = 'position:fixed;left:' + x + 'px;top:' + y + 'px;z-index:200;';
  document.body.appendChild(ctxMenu);
  var rect = ctxMenu.getBoundingClientRect();
  if (rect.right > window.innerWidth) ctxMenu.style.left = (x - rect.width) + 'px';
  if (rect.bottom > window.innerHeight) ctxMenu.style.top = (y - rect.height) + 'px';
  ctxMenu.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'rename') startRename(chatId);
    if (btn.dataset.action === 'delete') openConfirm(chatId, chatName);
    removeCtxMenu();
  });
}
document.addEventListener('click', removeCtxMenu);
document.addEventListener('contextmenu', function(e) { if (!e.target.closest('.chat-item')) removeCtxMenu(); });

function startRename(chatId) { renamingId = chatId; renderChatList(); }
async function commitRename(chatId, newName) {
  newName = (newName || '').trim(); renamingId = null;
  if (!newName) { renderChatList(); return; }
  try {
    var res = await apiFetch('/api/chats/' + chatId, { method: 'PATCH', body: JSON.stringify({ name: newName }) });
    if (res.ok) {
      var chat = chats.find(function(c) { return c.id === chatId; });
      if (chat) chat.name = newName;
      if (activeChatId === chatId) currentLabelEl.innerHTML = 'Текущий чат:<br><span>' + newName + '</span>';
    }
  } catch (e) {}
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
      inp.type = 'text'; inp.className = 'rename-input'; inp.value = chat.name;
      inp.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') commitRename(chat.id, inp.value);
        if (e.key === 'Escape') { renamingId = null; renderChatList(); }
        e.stopPropagation();
      });
      inp.addEventListener('blur', function() { commitRename(chat.id, inp.value); });
      item.appendChild(inp); chatListEl.appendChild(item);
      setTimeout(function() { inp.focus(); inp.select(); }, 0);
    } else {
      var nameEl = document.createElement('span');
      nameEl.className = 'chat-item-name'; nameEl.textContent = chat.name;
      item.appendChild(nameEl);
      item.addEventListener('click', function() { switchChat(chat.id); });
      item.addEventListener('contextmenu', function(e) {
        e.preventDefault(); e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, chat.id, chat.name);
      });
      chatListEl.appendChild(item);
    }
  });
}

function renderMessages(messages) {
  messages = messages || [];
  Array.from(chatWindowEl.children).forEach(function(ch) { if (ch.id !== 'typingIndicator') ch.remove(); });
  activeHistory = [];
  messages.forEach(function(msg) {
    var role = msg.role === 'assistant' ? 'assistant' : 'user';
    var content = msg.content || msg.text || '';
    var time = msg.created_at ? msg.created_at.substring(11, 16) : nowTime();
    activeHistory.push({ role: role, content: content });
    chatWindowEl.insertBefore(buildMessageEl(content, role === 'assistant' ? 'bot' : 'user', time), typingEl);
  });
  chatWindowEl.scrollTop = chatWindowEl.scrollHeight;
}

function buildMessageEl(text, roleClass, time) {
  var wrap = document.createElement('div'); wrap.className = 'message ' + roleClass;
  var bubble = document.createElement('div'); bubble.className = 'msg-bubble'; bubble.textContent = text;
  var t = document.createElement('div'); t.className = 'msg-time'; t.textContent = time || nowTime();
  wrap.appendChild(bubble); wrap.appendChild(t); return wrap;
}

function addMessageEl(text, roleClass) {
  chatWindowEl.insertBefore(buildMessageEl(text, roleClass, nowTime()), typingEl);
  chatWindowEl.scrollTop = chatWindowEl.scrollHeight;
}

// ══════════════════════════════════════════════════════
//  CHAT OPERATIONS
// ══════════════════════════════════════════════════════
async function switchChat(id) {
  activeChatId = id; activeHistory = [];
  var chat = chats.find(function(c) { return c.id === id; });
  currentLabelEl.innerHTML = 'Текущий чат:<br><span>' + (chat ? chat.name : '—') + '</span>';
  renderChatList();
  Array.from(chatWindowEl.children).forEach(function(ch) { if (ch.id !== 'typingIndicator') ch.remove(); });
  typingEl.classList.add('visible');
  try {
    var res = await apiFetch('/api/chats/' + id + '/messages');
    var msgs = await res.json();
    typingEl.classList.remove('visible');
    renderMessages(Array.isArray(msgs) ? msgs : []);
    // Восстанавливаем транскрипцию из истории если она есть
    lastTranscription = '';
    activeHistory.forEach(function(m) {
      if (m.role === 'user' && m.content.startsWith('📝 Транскрипция:')) {
        lastTranscription = m.content.replace('📝 Транскрипция:', '').trim();
      }
    });
  } catch (e) {
    typingEl.classList.remove('visible');
    addMessageEl('Не удалось загрузить историю: ' + e.message, 'bot');
  }
}

async function loadChats() {
  try {
    var res = await apiFetch('/api/chats');
    if (!res.ok) { currentLabelEl.innerHTML = 'Ошибка загрузки'; return; }
    chats = await res.json();
    renderChatList();
    if (chats.length) switchChat(chats[0].id);
    else currentLabelEl.innerHTML = 'Текущий чат:<br><span>—</span>';
  } catch (e) { currentLabelEl.innerHTML = 'Ошибка: ' + e.message; }
}

async function createNewChat() {
  try {
    var res = await apiFetch('/api/chats', { method: 'POST', body: JSON.stringify({}) });
    if (!res.ok) { console.error('Ошибка создания чата'); return null; }
    var chat = await res.json();
    chats.unshift(chat);
    await switchChat(chat.id);
    return chat.id;
  } catch (e) { console.error('createNewChat:', e.message); return null; }
}

function openConfirm(id, name) { pendingDeleteId = id; confirmNameEl.textContent = name; confirmOverlay.classList.add('visible'); }
function closeConfirm() { confirmOverlay.classList.remove('visible'); pendingDeleteId = null; }
async function confirmDelete() {
  if (!pendingDeleteId) return;
  var id = pendingDeleteId; closeConfirm();
  try { await apiFetch('/api/chats/' + id, { method: 'DELETE' }); } catch (e) {}
  chats = chats.filter(function(c) { return c.id !== id; });
  if (activeChatId === id) { activeChatId = null; activeHistory = []; lastTranscription = ''; }
  if (!activeChatId && chats.length) activeChatId = chats[0].id;
  renderChatList();
  if (activeChatId) switchChat(activeChatId);
  else {
    currentLabelEl.innerHTML = 'Текущий чат:<br><span>—</span>';
    Array.from(chatWindowEl.children).forEach(function(ch) { if (ch.id !== 'typingIndicator') ch.remove(); });
  }
}

// ══════════════════════════════════════════════════════
//  SEND MESSAGE → GPT-4o
// ══════════════════════════════════════════════════════
async function sendMessage() {
  var text = messageInputEl.value.trim();
  if (!text) return;
  if (!activeChatId) { var newId = await createNewChat(); if (!newId) return; }
  activeHistory.push({ role: 'user', content: text });
  addMessageEl(text, 'user');
  messageInputEl.value = '';
  typingEl.classList.add('visible');
  chatWindowEl.scrollTop = chatWindowEl.scrollHeight;
  try {
    var res = await apiFetch('/api/chat', { method: 'POST', body: JSON.stringify({ messages: activeHistory, chat_id: activeChatId }) });
    var data = await res.json();
    typingEl.classList.remove('visible');
    if (res.ok && data.text) {
      activeHistory.push({ role: 'assistant', content: data.text });
      addMessageEl(data.text, 'bot');
    } else {
      activeHistory.pop();
      addMessageEl('Ошибка GPT: ' + (data.error || res.status), 'bot');
    }
  } catch (e) {
    typingEl.classList.remove('visible'); activeHistory.pop();
    addMessageEl('Ошибка: ' + e.message, 'bot');
  }
}

// ══════════════════════════════════════════════════════
//  UPLOAD AUDIO → WHISPER
// ══════════════════════════════════════════════════════
function uploadFile() {
  var fi = document.createElement('input');
  fi.type = 'file'; fi.accept = 'audio/*'; fi.click();
  fi.onchange = async function() {
    var file = fi.files[0]; if (!file) return;
    if (!activeChatId) { var newId = await createNewChat(); if (!newId) return; }
    addMessageEl('🎵 Распознаю аудио: ' + file.name + '...', 'user');
    typingEl.classList.add('visible');
    chatWindowEl.scrollTop = chatWindowEl.scrollHeight;
    try {
      var fd = new FormData(); fd.append('file', file);
      var res = await fetch(API + '/api/transcribe', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + getToken() }, body: fd
      });
      var data = await res.json();
      typingEl.classList.remove('visible');
      if (data.text) {
        lastTranscription = data.text;
        // Сохраняем транскрипцию в историю и показываем в чате
        var msg = '📝 Транскрипция:\n' + data.text;
        activeHistory.push({ role: 'user', content: msg });
        addMessageEl(msg, 'user');
        // Сохраняем в БД
        await apiFetch('/api/chat/save-message', {
          method: 'POST',
          body: JSON.stringify({ chat_id: activeChatId, role: 'user', content: msg })
        }).catch(function() {});
        addMessageEl('✅ Аудио распознано. Нажмите "Полное заполнение" или "Быстрое заполнение" для создания протокола.', 'bot');
      } else {
        addMessageEl('Ошибка распознавания: ' + (data.error || 'неизвестная ошибка'), 'bot');
      }
    } catch (e) {
      typingEl.classList.remove('visible');
      addMessageEl('Ошибка: ' + e.message, 'bot');
    }
  };
}

// ══════════════════════════════════════════════════════
//  ПОЛНОЕ ЗАПОЛНЕНИЕ
// ══════════════════════════════════════════════════════
document.getElementById('fullFill').addEventListener('click', async function() {
  if (!lastTranscription) {
    addMessageEl('⚠️ Сначала загрузите аудиофайл для распознавания.', 'bot');
    return;
  }
  if (!activeChatId) { var newId = await createNewChat(); if (!newId) return; }

  addMessageEl('🔄 Выполняю полное заполнение протокола...', 'bot');
  typingEl.classList.add('visible');

  var prompt = 'Ты — секретарь совещания. На основе текста совещания составь подробный протокол поручений.\n\n' +
    'Текст совещания:\n"""\n' + lastTranscription + '\n"""\n\n' +
    'Составь протокол СТРОГО в следующем формате Markdown:\n\n' +
    '# ПРОТОКОЛ ПОРУЧЕНИЙ\n\n' +
    '**Дата:** [дата совещания или "не указана"]\n' +
    '**Место:** [место проведения или "не указано"]\n' +
    '**Председатель:** [ФИО председателя или "не указан"]\n' +
    '**Присутствовали:** [список участников]\n\n' +
    '---\n\n' +
    '## ПОРУЧЕНИЯ\n\n' +
    'Для каждого поручения используй ТОЧНО такой формат:\n\n' +
    '### Поручение №[номер]\n\n' +
    '**Текст поручения:** [полный текст поручения]\n\n' +
    '**Ответственный:** [ФИО и должность]\n\n' +
    '**Соисполнители:** [ФИО или "не указаны"]\n\n' +
    '**Срок исполнения:** [дата]\n\n' +
    '**Периодичность:** [периодичность или "единовременно"]\n\n' +
    '**Примечание:** [дополнительная информация или "—"]\n\n' +
    '---\n\n' +
    'После всех поручений добавь:\n\n' +
    '## РЕШЕНИЕ\n\n' +
    '[краткое общее решение совещания]\n\n' +
    'Выдели ВСЕ поручения которые есть в тексте. Не пропускай ни одного.';

  var messages = [{ role: 'user', content: prompt }];

  try {
    var res = await apiFetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: messages, chat_id: activeChatId })
    });
    var data = await res.json();
    typingEl.classList.remove('visible');
    if (res.ok && data.text) {
      activeHistory.push({ role: 'assistant', content: data.text });
      addMessageEl(data.text, 'bot');
      // Создаём файл для скачивания
      offerDownload(data.text, 'Протокол_полный');
    } else {
      addMessageEl('Ошибка GPT: ' + (data.error || 'нет ответа'), 'bot');
    }
  } catch (e) {
    typingEl.classList.remove('visible');
    addMessageEl('Ошибка: ' + e.message, 'bot');
  }
});

// ══════════════════════════════════════════════════════
//  БЫСТРОЕ ЗАПОЛНЕНИЕ
// ══════════════════════════════════════════════════════
document.getElementById('fastFill').addEventListener('click', async function() {
  if (!lastTranscription) {
    addMessageEl('⚠️ Сначала загрузите аудиофайл для распознавания.', 'bot');
    return;
  }
  if (!activeChatId) { var newId = await createNewChat(); if (!newId) return; }

  addMessageEl('⚡ Выполняю быстрое заполнение...', 'bot');
  typingEl.classList.add('visible');

  var prompt = 'Выдели поручения из текста совещания СТРОГО в формате:\n\n' +
    'Поручение: [текст].\n' +
    '- Ответственный: [имя].\n' +
    '- Срок: [дата].\n\n' +
    'Без вводных фраз и заключений. Только список поручений.\n\n' +
    'Текст совещания:\n"""\n' + lastTranscription + '\n"""';

  var messages = [{ role: 'user', content: prompt }];

  try {
    var res = await apiFetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: messages, chat_id: activeChatId })
    });
    var data = await res.json();
    typingEl.classList.remove('visible');
    if (res.ok && data.text) {
      activeHistory.push({ role: 'assistant', content: data.text });
      addMessageEl(data.text, 'bot');
      // Создаём файл для скачивания
      offerDownload(data.text, 'Протокол_быстрый');
    } else {
      addMessageEl('Ошибка GPT: ' + (data.error || 'нет ответа'), 'bot');
    }
  } catch (e) {
    typingEl.classList.remove('visible');
    addMessageEl('Ошибка: ' + e.message, 'bot');
  }
});

// ══════════════════════════════════════════════════════
//  СКАЧАТЬ ПРОТОКОЛ (Markdown файл)
// ══════════════════════════════════════════════════════
function offerDownload(markdownText, filename) {
  var date = new Date();
  var dateStr = date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
  var fullFilename = filename + '_' + dateStr + '.md';

  var blob = new Blob([markdownText], { type: 'text/markdown;charset=utf-8' });
  var url  = URL.createObjectURL(blob);

  // Показываем кнопку скачивания в чате
  var wrap = document.createElement('div');
  wrap.className = 'message bot';
  var bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.style.display = 'flex';
  bubble.style.flexDirection = 'column';
  bubble.style.gap = '8px';

  var label = document.createElement('span');
  label.textContent = '📄 Протокол готов к скачиванию:';

  var link = document.createElement('a');
  link.href     = url;
  link.download = fullFilename;
  link.textContent = '⬇ Скачать ' + fullFilename;
  link.style.cssText = 'color:#3b82f6;text-decoration:underline;cursor:pointer;font-weight:600;';

  bubble.appendChild(label);
  bubble.appendChild(link);

  var t = document.createElement('div');
  t.className = 'msg-time'; t.textContent = nowTime();
  wrap.appendChild(bubble); wrap.appendChild(t);
  chatWindowEl.insertBefore(wrap, typingEl);
  chatWindowEl.scrollTop = chatWindowEl.scrollHeight;
}

// ══════════════════════════════════════════════════════
//  DOWNLOAD HISTORY
// ══════════════════════════════════════════════════════
function downloadHistory() {
  var chat = chats.find(function(c) { return c.id === activeChatId; });
  if (!chat || !activeHistory.length) { addMessageEl('История пуста.', 'bot'); return; }
  var lines = activeHistory.map(function(msg) { return msg.role + ': ' + msg.content; });
  var blob = new Blob([lines.join('\n\n')], { type: 'text/plain;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = chat.name + '.txt'; a.click();
  URL.revokeObjectURL(a.href);
}

function nowTime() {
  return new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}

// ══════════════════════════════════════════════════════
//  EVENTS
// ══════════════════════════════════════════════════════
document.getElementById('sendBtn').addEventListener('click', sendMessage);
messageInputEl.addEventListener('keydown', function(e) { if (e.key === 'Enter') sendMessage(); });
document.getElementById('newChatBtn').addEventListener('click', createNewChat);
document.getElementById('downloadBtn').addEventListener('click', downloadHistory);
document.getElementById('uploadBtn').addEventListener('click', uploadFile);
document.getElementById('confirmCancelBtn').addEventListener('click', closeConfirm);
document.getElementById('confirmDeleteBtn').addEventListener('click', confirmDelete);
confirmOverlay.addEventListener('click', function(e) { if (e.target === confirmOverlay) closeConfirm(); });
document.getElementById('logoutBtn').addEventListener('click', function() {
  localStorage.clear(); window.location.replace('login.html');
});

loadChats();