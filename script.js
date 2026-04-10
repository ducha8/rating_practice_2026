const API = 'http://localhost:5000';

// ── Auth ───────────────────────────────────────────────
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
var chats         = [];
var activeChatId  = null;
var activeHistory = [];
var lastTranscription = '';
var isFirstMessage = false;

// ── DOM ────────────────────────────────────────────────
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
//  PROTOCOLS MODAL
// ══════════════════════════════════════════════════════
var protocolsOverlay = document.getElementById('protocolsOverlay');
var protocolsList    = document.getElementById('protocolsList');

async function openProtocols() {
  protocolsOverlay.classList.add('visible');
  protocolsList.innerHTML = '<div class="protocols-empty">Загрузка...</div>';
  try {
    var res  = await apiFetch('/api/protocols');
    var data = await res.json();
    renderProtocolsList(Array.isArray(data) ? data : []);
  } catch (e) {
    protocolsList.innerHTML = '<div class="protocols-empty">Ошибка загрузки: ' + e.message + '</div>';
  }
}

function renderProtocolsList(items) {
  protocolsList.innerHTML = '';
  if (!items.length) {
    var empty = document.createElement('div');
    empty.className = 'protocols-empty';
    empty.innerHTML = 'Протоколов пока нет.<br>Загрузите аудио и нажмите<br>«Полное заполнение» или «Быстрое заполнение».';
    protocolsList.appendChild(empty);
    return;
  }
  items.forEach(function(p) {
    var item = document.createElement('div');
    item.className = 'protocol-item';

    var info = document.createElement('div');
    info.className = 'protocol-item-info';

    var name = document.createElement('div');
    name.className = 'protocol-item-name';
    name.textContent = p.filename;

    var meta = document.createElement('div');
    meta.className = 'protocol-item-meta';
    meta.textContent = (p.type === 'full' ? 'Полный' : 'Быстрый') + ' · ' + p.chat_name + ' · ' + p.created_at.substring(0, 16).replace('T', ' ');

    info.appendChild(name);
    info.appendChild(meta);

    var actions = document.createElement('div');
    actions.className = 'protocol-item-actions';

    var dlBtn = document.createElement('button');
    dlBtn.className = 'protocol-download-btn';
    dlBtn.textContent = '⬇ Скачать';
    dlBtn.addEventListener('click', function() { downloadProtocolById(p.id, p.filename); });

    var delBtn = document.createElement('button');
    delBtn.className = 'protocol-delete-btn';
    delBtn.textContent = '✕';
    delBtn.title = 'Удалить';
    delBtn.addEventListener('click', async function() {
      if (!confirm('Удалить протокол «' + p.filename + '»?')) return;
      await apiFetch('/api/protocols/' + p.id, { method: 'DELETE' }).catch(function() {});
      openProtocols();
    });

    actions.appendChild(dlBtn);
    actions.appendChild(delBtn);
    item.appendChild(info);
    item.appendChild(actions);
    protocolsList.appendChild(item);
  });
}

async function downloadProtocolById(id, filename) {
  try {
    var res  = await apiFetch('/api/protocols/' + id);
    var data = await res.json();
    if (!res.ok) { alert('Ошибка: ' + data.error); return; }
    var blob = new Blob([data.content], { type: 'text/markdown;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { alert('Ошибка скачивания: ' + e.message); }
}

function closeProtocols() { protocolsOverlay.classList.remove('visible'); }
document.getElementById('protocolsBtn').addEventListener('click', openProtocols);
document.getElementById('protocolsCloseBtn').addEventListener('click', closeProtocols);
protocolsOverlay.addEventListener('click', function(e) { if (e.target === protocolsOverlay) closeProtocols(); });

// ══════════════════════════════════════════════════════
//  AUDIO → TEXT MODAL
// ══════════════════════════════════════════════════════
var audioOverlay    = document.getElementById('audioOverlay');
var audioMsg        = document.getElementById('audioMsg');
var audioResult     = document.getElementById('audioResult');
var audioTextResult = document.getElementById('audioTextResult');

function openAudioModal() {
  audioMsg.className = 'inline-msg';
  audioMsg.textContent = '';
  audioResult.style.display = 'none';
  audioTextResult.value = '';
  audioOverlay.classList.add('visible');
}
function closeAudioModal() { audioOverlay.classList.remove('visible'); }

document.getElementById('audioToTextBtn').addEventListener('click', openAudioModal);
document.getElementById('audioCloseBtn').addEventListener('click', closeAudioModal);
audioOverlay.addEventListener('click', function(e) { if (e.target === audioOverlay) closeAudioModal(); });

document.getElementById('audioUploadBtn').addEventListener('click', function() {
  var fi = document.createElement('input');
  fi.type = 'file'; fi.accept = 'audio/*'; fi.click();
  fi.onchange = async function() {
    var file = fi.files[0]; if (!file) return;
    audioMsg.className = 'inline-msg success';
    audioMsg.textContent = '⏳ Распознаю: ' + file.name + '... Это может занять несколько минут.';
    audioResult.style.display = 'none';
    document.getElementById('audioUploadBtn').disabled = true;

    try {
      var fd = new FormData(); fd.append('file', file);
      var res  = await fetch(API + '/api/transcribe', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + getToken() }, body: fd
      });
      var data = await res.json();
      if (data.text) {
        audioMsg.className = 'inline-msg success';
        audioMsg.textContent = '✅ Готово! ' + data.text.length + ' символов.';
        audioTextResult.value = data.text;
        audioResult.style.display = 'block';
        lastTranscription = data.text;
      } else {
        audioMsg.className = 'inline-msg error';
        audioMsg.textContent = 'Ошибка: ' + (data.error || 'не удалось распознать');
      }
    } catch (e) {
      audioMsg.className = 'inline-msg error';
      audioMsg.textContent = 'Ошибка: ' + e.message;
    } finally {
      document.getElementById('audioUploadBtn').disabled = false;
    }
  };
});

// ══════════════════════════════════════════════════════
//  IMAGE RECOGNITION MODAL
// ══════════════════════════════════════════════════════
var imageOverlay      = document.getElementById('imageOverlay');
var imageMsg          = document.getElementById('imageMsg');
var imagePreview      = document.getElementById('imagePreview');
var imagePreviewImg   = document.getElementById('imagePreviewImg');
var imageResult       = document.getElementById('imageResult');
var imageTextResult   = document.getElementById('imageTextResult');
var imageQuestionInp  = document.getElementById('imageQuestion');
var imageUploadBtn    = document.getElementById('imageUploadBtn');
var imageAnalyzeBtn   = document.getElementById('imageAnalyzeBtn');
var imageCloseBtn     = document.getElementById('imageCloseBtn');

var pendingImageFile = null;

function openImageModal() {
  imageMsg.className = 'inline-msg';
  imageMsg.textContent = '';
  imagePreview.style.display = 'none';
  imagePreviewImg.src = '';
  imageResult.style.display = 'none';
  imageTextResult.value = '';
  imageQuestionInp.value = '';
  imageAnalyzeBtn.disabled = true;
  pendingImageFile = null;
  imageOverlay.classList.add('visible');
}
function closeImageModal() { imageOverlay.classList.remove('visible'); }

document.getElementById('imageRecognizeBtn').addEventListener('click', openImageModal);
imageCloseBtn.addEventListener('click', closeImageModal);
imageOverlay.addEventListener('click', function(e) { if (e.target === imageOverlay) closeImageModal(); });

// Выбор файла изображения
imageUploadBtn.addEventListener('click', function() {
  var fi = document.createElement('input');
  fi.type = 'file';
  fi.accept = 'image/jpeg,image/png,image/gif,image/webp,image/bmp';
  fi.click();
  fi.onchange = function() {
    var file = fi.files[0];
    if (!file) return;
    pendingImageFile = file;

    // Показываем превью
    var reader = new FileReader();
    reader.onload = function(e) {
      imagePreviewImg.src = e.target.result;
      imagePreview.style.display = 'block';
    };
    reader.readAsDataURL(file);

    imageMsg.className = 'inline-msg success';
    imageMsg.textContent = '✅ Файл выбран: ' + file.name + ' (' + Math.round(file.size / 1024) + ' КБ)';
    imageResult.style.display = 'none';
    imageTextResult.value = '';
    imageAnalyzeBtn.disabled = false;
  };
});

// Анализ изображения
imageAnalyzeBtn.addEventListener('click', async function() {
  if (!pendingImageFile) { return; }

  var question = imageQuestionInp.value.trim();
  imageMsg.className = 'inline-msg success';
  imageMsg.textContent = '🔍 Анализирую изображение... Это может занять 15–60 секунд.';
  imageResult.style.display = 'none';
  imageAnalyzeBtn.disabled = true;
  imageUploadBtn.disabled = true;

  try {
    var fd = new FormData();
    fd.append('file', pendingImageFile);
    if (question) fd.append('question', question);

    var res = await fetch(API + '/api/recognize-image', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + getToken() },
      body: fd
    });
    var data = await res.json();

    if (res.ok && data.text) {
      imageMsg.className = 'inline-msg success';
      imageMsg.textContent = '✅ Готово! Модель: ' + (data.model || 'vision') + '.';
      imageTextResult.value = data.text;
      imageResult.style.display = 'block';
    } else {
      imageMsg.className = 'inline-msg error';
      imageMsg.textContent = 'Ошибка: ' + (data.error || 'нет ответа от модели');
    }
  } catch (e) {
    imageMsg.className = 'inline-msg error';
    imageMsg.textContent = 'Ошибка: ' + e.message;
  } finally {
    imageAnalyzeBtn.disabled = false;
    imageUploadBtn.disabled = false;
  }
});

// Кнопка «Отправить в чат»
document.getElementById('imageSendToChatBtn').addEventListener('click', function() {
  var text = imageTextResult.value.trim();
  if (!text) return;
  var filename = pendingImageFile ? pendingImageFile.name : 'изображение';
  var msgText = '🖼️ Анализ изображения «' + filename + '»:\n\n' + text;
  closeImageModal();
  // Вставляем в поле ввода, чтобы пользователь мог отправить или отредактировать
  messageInputEl.value = msgText;
  messageInputEl.focus();
});

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
function showChangePwMsg(text, type) { changePwMsg.className = 'inline-msg ' + (type || 'error'); changePwMsg.textContent = text; }
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
    var btn = e.target.closest('[data-action]'); if (!btn) return;
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
  lastTranscription = '';
  messages.forEach(function(msg) {
    var role = msg.role === 'assistant' ? 'assistant' : 'user';
    var content = msg.content || msg.text || '';
    var time = msg.created_at ? msg.created_at.substring(11, 16) : nowTime();
    activeHistory.push({ role: role, content: content });
    if (role === 'user' && content.startsWith('📝 Транскрипция:'))
      lastTranscription = content.replace('📝 Транскрипция:', '').trim();
    chatWindowEl.insertBefore(buildMessageEl(content, role === 'assistant' ? 'bot' : 'user', time), typingEl);
  });
  chatWindowEl.scrollTop = chatWindowEl.scrollHeight;
  isFirstMessage = (messages.length === 0);
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
  activeChatId = id; activeHistory = []; lastTranscription = '';
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
    else { currentLabelEl.innerHTML = 'Текущий чат:<br><span>—</span>'; isFirstMessage = true; }
  } catch (e) { currentLabelEl.innerHTML = 'Ошибка: ' + e.message; }
}

async function createNewChat() {
  try {
    var res = await apiFetch('/api/chats', { method: 'POST', body: JSON.stringify({}) });
    if (!res.ok) { console.error('Ошибка создания чата'); return null; }
    var chat = await res.json();
    chats.unshift(chat);
    await switchChat(chat.id);
    isFirstMessage = true;
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
    isFirstMessage = true;
  }
}

// ══════════════════════════════════════════════════════
//  SEND MESSAGE
// ══════════════════════════════════════════════════════
async function sendMessage() {
  var text = messageInputEl.value.trim();
  if (!text) return;
  if (!activeChatId) { var newId = await createNewChat(); if (!newId) return; }

  var sendingFirst = isFirstMessage;
  activeHistory.push({ role: 'user', content: text });
  addMessageEl(text, 'user');
  messageInputEl.value = '';
  isFirstMessage = false;
  typingEl.classList.add('visible');
  chatWindowEl.scrollTop = chatWindowEl.scrollHeight;

  try {
    var res = await apiFetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: activeHistory, chat_id: activeChatId, is_first_message: sendingFirst })
    });
    var data = await res.json();
    typingEl.classList.remove('visible');
    if (res.ok && data.text) {
      activeHistory.push({ role: 'assistant', content: data.text });
      addMessageEl(data.text, 'bot');
      if (data.new_name) {
        var chat = chats.find(function(c) { return c.id === activeChatId; });
        if (chat) {
          chat.name = data.new_name;
          currentLabelEl.innerHTML = 'Текущий чат:<br><span>' + data.new_name + '</span>';
          renderChatList();
        }
      }
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
//  СОХРАНИТЬ ПРОТОКОЛ В БД
// ══════════════════════════════════════════════════════
async function saveProtocolToDB(text, type) {
  var chat = chats.find(function(c) { return c.id === activeChatId; });
  var chatName = chat ? chat.name : 'Чат';
  var date = new Date();
  var dateStr = date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
  var filename = (type === 'full' ? 'Протокол_полный' : 'Протокол_быстрый') + '_' + dateStr + '.md';

  try {
    await apiFetch('/api/protocols', {
      method: 'POST',
      body: JSON.stringify({ chat_id: activeChatId, chat_name: chatName, type: type, filename: filename, content: text })
    });
  } catch (e) { console.error('Ошибка сохранения протокола:', e.message); }

  var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  var url  = URL.createObjectURL(blob);
  var wrap = document.createElement('div'); wrap.className = 'message bot';
  var bubble = document.createElement('div'); bubble.className = 'msg-bubble';
  bubble.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
  var label = document.createElement('span'); label.textContent = '📄 Протокол сохранён:';
  var link = document.createElement('a');
  link.href = url; link.download = filename; link.textContent = '⬇ ' + filename;
  link.style.cssText = 'color:#3b82f6;text-decoration:underline;cursor:pointer;font-weight:600;';
  var hint = document.createElement('span');
  hint.style.cssText = 'font-size:10px;color:var(--muted);';
  hint.textContent = 'Все протоколы — в разделе «Протоколы» в сайдбаре';
  bubble.appendChild(label); bubble.appendChild(link); bubble.appendChild(hint);
  var t = document.createElement('div'); t.className = 'msg-time'; t.textContent = nowTime();
  wrap.appendChild(bubble); wrap.appendChild(t);
  chatWindowEl.insertBefore(wrap, typingEl);
  chatWindowEl.scrollTop = chatWindowEl.scrollHeight;
}

// ══════════════════════════════════════════════════════
//  ПОЛНОЕ ЗАПОЛНЕНИЕ
// ══════════════════════════════════════════════════════
document.getElementById('fullFill').addEventListener('click', async function() {
  if (!lastTranscription) { addMessageEl('⚠️ Сначала загрузите аудиофайл через «Аудио → Текст».', 'bot'); return; }
  if (!activeChatId) { var newId = await createNewChat(); if (!newId) return; }
  addMessageEl('🔄 Выполняю полное заполнение протокола...', 'bot');
  typingEl.classList.add('visible');

  var prompt =
    'Ты — секретарь совещания. На основе текста совещания составь подробный протокол поручений.\n\n' +
    'Текст совещания:\n"""\n' + lastTranscription + '\n"""\n\n' +
    'Составь протокол СТРОГО в следующем формате Markdown:\n\n' +
    '# ПРОТОКОЛ ПОРУЧЕНИЙ\n\n' +
    '**Дата:** [дата совещания или "не указана"]\n' +
    '**Место:** [место проведения или "не указано"]\n' +
    '**Председатель:** [ФИО председателя или "не указан"]\n' +
    '**Присутствовали:** [список участников]\n\n---\n\n' +
    '## ПОРУЧЕНИЯ\n\n' +
    'Для каждого поручения используй ТОЧНО такой формат:\n\n' +
    '### Поручение №[номер]\n\n' +
    '**Текст поручения:** [полный текст]\n\n' +
    '**Ответственный:** [ФИО и должность]\n\n' +
    '**Соисполнители:** [ФИО или "не указаны"]\n\n' +
    '**Срок исполнения:** [дата]\n\n' +
    '**Периодичность:** [периодичность или "единовременно"]\n\n' +
    '**Примечание:** [доп. информация или "—"]\n\n---\n\n' +
    '## РЕШЕНИЕ\n\n[краткое общее решение совещания]\n\n' +
    'Выдели ВСЕ поручения. Не пропускай ни одного.';

  try {
    var res = await apiFetch('/api/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], chat_id: activeChatId }) });
    var data = await res.json();
    typingEl.classList.remove('visible');
    if (res.ok && data.text) {
      activeHistory.push({ role: 'assistant', content: data.text });
      addMessageEl(data.text, 'bot');
      await saveProtocolToDB(data.text, 'full');
    } else { addMessageEl('Ошибка GPT: ' + (data.error || 'нет ответа'), 'bot'); }
  } catch (e) { typingEl.classList.remove('visible'); addMessageEl('Ошибка: ' + e.message, 'bot'); }
});

// ══════════════════════════════════════════════════════
//  БЫСТРОЕ ЗАПОЛНЕНИЕ
// ══════════════════════════════════════════════════════
document.getElementById('fastFill').addEventListener('click', async function() {
  if (!lastTranscription) { addMessageEl('⚠️ Сначала загрузите аудиофайл через «Аудио → Текст».', 'bot'); return; }
  if (!activeChatId) { var newId = await createNewChat(); if (!newId) return; }
  addMessageEl('⚡ Выполняю быстрое заполнение...', 'bot');
  typingEl.classList.add('visible');

  var prompt =
    'Выдели поручения из текста совещания СТРОГО в формате:\n\n' +
    'Поручение: [текст].\n- Ответственный: [имя].\n- Срок: [дата].\n\n' +
    'Без вводных фраз и заключений. Только список поручений.\n\n' +
    'Текст совещания:\n"""\n' + lastTranscription + '\n"""';

  try {
    var res = await apiFetch('/api/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], chat_id: activeChatId }) });
    var data = await res.json();
    typingEl.classList.remove('visible');
    if (res.ok && data.text) {
      activeHistory.push({ role: 'assistant', content: data.text });
      addMessageEl(data.text, 'bot');
      await saveProtocolToDB(data.text, 'fast');
    } else { addMessageEl('Ошибка GPT: ' + (data.error || 'нет ответа'), 'bot'); }
  } catch (e) { typingEl.classList.remove('visible'); addMessageEl('Ошибка: ' + e.message, 'bot'); }
});

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

function nowTime() { return new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }); }

// ══════════════════════════════════════════════════════
//  EVENTS
// ══════════════════════════════════════════════════════
document.getElementById('sendBtn').addEventListener('click', sendMessage);
messageInputEl.addEventListener('keydown', function(e) { if (e.key === 'Enter') sendMessage(); });
document.getElementById('newChatBtn').addEventListener('click', createNewChat);
document.getElementById('downloadBtn').addEventListener('click', downloadHistory);
document.getElementById('confirmCancelBtn').addEventListener('click', closeConfirm);
document.getElementById('confirmDeleteBtn').addEventListener('click', confirmDelete);
confirmOverlay.addEventListener('click', function(e) { if (e.target === confirmOverlay) closeConfirm(); });
document.getElementById('logoutBtn').addEventListener('click', function() { localStorage.clear(); window.location.replace('login.html'); });

loadChats();

// ══════════════════════════════════════════════════════
//  POTHOLE DETECTION MODAL
// ══════════════════════════════════════════════════════
var potholeOverlay      = document.getElementById('potholeOverlay');
var potholeMsg          = document.getElementById('potholeMsg');
var potholeModelStatus  = document.getElementById('potholeModelStatus');
var potholePreviewWrap  = document.getElementById('potholePreviewWrap');
var potholeOrigImg      = document.getElementById('potholeOrigImg');
var potholeResultImg    = document.getElementById('potholeResultImg');
var potholeResultPH     = document.getElementById('potholeResultPlaceholder');
var potholeList         = document.getElementById('potholeList');
var potholeListItems    = document.getElementById('potholeListItems');
var potholeConfSlider   = document.getElementById('potholeConf');
var potholeConfLabel    = document.getElementById('confValueLabel');
var potholeUploadBtn    = document.getElementById('potholeUploadBtn');
var potholeAnalyzeBtn   = document.getElementById('potholeAnalyzeBtn');
var potholeCloseBtn     = document.getElementById('potholeCloseBtn');
var potholeSendBtn      = document.getElementById('potholeSendToChatBtn');

var pendingPotholeFile    = null;
var lastPotholeDetections = [];

// Слайдер уверенности
potholeConfSlider.addEventListener('input', function() {
  potholeConfLabel.textContent = potholeConfSlider.value + '%';
});

// Статус модели
async function fetchPotholeModelStatus() {
  try {
    var res  = await apiFetch('/api/pothole-model-status');
    var data = await res.json();
    if (data.loaded) {
      potholeModelStatus.innerHTML =
        '<span style="color:var(--' + (data.is_custom ? 'success' : 'accent') + ')">' +
        (data.is_custom ? '✅ Дообученная модель (ямы)' : '⚠️ Базовая YOLOv8n-seg') +
        '</span> · устройство: ' + (data.device === 'cpu' ? 'CPU' : 'GPU');
    } else {
      potholeModelStatus.textContent = '❌ Модель не загружена';
    }
  } catch (e) {
    potholeModelStatus.textContent = '⚠️ Нет связи с сервером';
  }
}

function openPotholeModal() {
  // Сброс
  potholeMsg.className        = 'inline-msg';
  potholeMsg.textContent      = '';
  potholePreviewWrap.style.display = 'none';
  potholeOrigImg.src          = '';
  potholeResultImg.src        = '';
  potholeResultImg.style.display = 'none';
  potholeResultPH.style.display  = 'flex';
  potholeList.style.display   = 'none';
  potholeListItems.innerHTML  = '';
  potholeAnalyzeBtn.disabled  = true;
  potholeSendBtn.style.display = 'none';
  pendingPotholeFile           = null;
  lastPotholeDetections        = [];

  potholeOverlay.classList.add('visible');
  fetchPotholeModelStatus();
}

function closePotholeModal() {
  potholeOverlay.classList.remove('visible');
}

document.getElementById('potholeDetectBtn').addEventListener('click', openPotholeModal);
potholeCloseBtn.addEventListener('click', closePotholeModal);
potholeOverlay.addEventListener('click', function(e) {
  if (e.target === potholeOverlay) closePotholeModal();
});

// Выбор файла
potholeUploadBtn.addEventListener('click', function() {
  var fi = document.createElement('input');
  fi.type   = 'file';
  fi.accept = 'image/jpeg,image/png,image/webp,image/bmp';
  fi.click();
  fi.onchange = function() {
    var file = fi.files[0];
    if (!file) return;
    pendingPotholeFile = file;

    // Превью оригинала
    var reader = new FileReader();
    reader.onload = function(e) {
      potholeOrigImg.src             = e.target.result;
      potholePreviewWrap.style.display = 'block';
      potholeResultImg.style.display = 'none';
      potholeResultPH.style.display  = 'flex';
      potholeList.style.display      = 'none';
      potholeSendBtn.style.display   = 'none';
    };
    reader.readAsDataURL(file);

    potholeMsg.className    = 'inline-msg success';
    potholeMsg.textContent  = '✅ Файл выбран: ' + file.name + ' (' + Math.round(file.size / 1024) + ' КБ)';
    potholeAnalyzeBtn.disabled = false;
  };
});

// Анализ
potholeAnalyzeBtn.addEventListener('click', async function() {
  if (!pendingPotholeFile) return;

  var conf = parseInt(potholeConfSlider.value, 10) / 100;

  potholeMsg.className   = 'inline-msg success';
  potholeMsg.textContent = '🔍 Анализирую дорожное полотно... Это займёт 5–20 секунд.';
  potholeResultImg.style.display = 'none';
  potholeResultPH.style.display  = 'flex';
  potholeResultPH.textContent    = '⏳ Обработка...';
  potholeList.style.display      = 'none';
  potholeAnalyzeBtn.disabled     = true;
  potholeUploadBtn.disabled      = true;
  potholeSendBtn.style.display   = 'none';

  try {
    var fd = new FormData();
    fd.append('file', pendingPotholeFile);
    fd.append('conf', conf.toString());

    var res = await fetch(API + '/api/detect-potholes', {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + getToken() },
      body:    fd
    });
    var data = await res.json();

    if (res.ok) {
      // Показываем результирующее изображение
      potholeResultImg.src           = 'data:image/jpeg;base64,' + data.annotated_image;
      potholeResultImg.style.display = 'block';
      potholeResultPH.style.display  = 'none';

      lastPotholeDetections = data.detections || [];

      if (data.count === 0) {
        potholeMsg.className   = 'inline-msg success';
        potholeMsg.textContent = '✅ Дефектов не обнаружено! (время: ' + data.processing_ms + ' мс)';
      } else {
        potholeMsg.className   = 'inline-msg success';
        potholeMsg.textContent = '⚠️ Найдено дефектов: ' + data.count + ' · время: ' + data.processing_ms + ' мс';

        // Рендерим список
        renderPotholeList(data.detections);
        potholeList.style.display    = 'block';
        potholeSendBtn.style.display = 'inline-block';
      }

      if (!data.model_type || data.model_type === 'base') {
        potholeMsg.textContent += ' · ⚠️ Базовая модель (обучите на ямах для точных результатов)';
      }
    } else {
      potholeMsg.className   = 'inline-msg error';
      potholeMsg.textContent = 'Ошибка: ' + (data.error || 'нет ответа');
      potholeResultPH.textContent = 'Ошибка';
    }
  } catch (e) {
    potholeMsg.className   = 'inline-msg error';
    potholeMsg.textContent = 'Ошибка: ' + e.message;
  } finally {
    potholeAnalyzeBtn.disabled = false;
    potholeUploadBtn.disabled  = false;
  }
});

function renderPotholeList(detections) {
  potholeListItems.innerHTML = '';
  detections.forEach(function(d) {
    var item = document.createElement('div');
    item.className = 'pothole-item';

    var num = document.createElement('div');
    num.className   = 'pothole-num';
    num.textContent = d.id;

    var info = document.createElement('div');
    info.className = 'pothole-info';

    var badge = document.createElement('span');
    badge.className = 'sev-badge sev-' + d.severity;
    badge.textContent = d.severity;

    var confEl = document.createElement('div');
    confEl.className   = 'pothole-conf';
    confEl.textContent = 'Уверенность: ' + Math.round(d.confidence * 100) + '%';

    var areaEl = document.createElement('div');
    areaEl.className   = 'pothole-area';
    areaEl.textContent = 'Площадь: ~' + d.area_m2_est + ' м² · ' +
                         Math.round(d.area_ratio * 100 * 10) / 10 + '% кадра' +
                         ' · центр (' + d.center.x + ', ' + d.center.y + ')';

    info.appendChild(badge);
    info.appendChild(confEl);
    info.appendChild(areaEl);
    item.appendChild(num);
    item.appendChild(info);
    potholeListItems.appendChild(item);
  });
}

// Отправить в чат
potholeSendBtn.addEventListener('click', function() {
  if (!lastPotholeDetections.length) return;
  var filename = pendingPotholeFile ? pendingPotholeFile.name : 'изображение';

  var lines = ['🕳️ Анализ дорожного полотна «' + filename + '»:\n'];
  lines.push('Обнаружено дефектов: ' + lastPotholeDetections.length + '\n');

  lastPotholeDetections.forEach(function(d) {
    lines.push(
      '#' + d.id + ' ' + d.severity +
      ' | уверенность: ' + Math.round(d.confidence * 100) + '%' +
      ' | площадь: ~' + d.area_m2_est + ' м²'
    );
  });

  var totalArea = lastPotholeDetections.reduce(function(s, d) { return s + d.area_m2_est; }, 0);
  lines.push('\nОбщая площадь дефектов: ~' + Math.round(totalArea * 10) / 10 + ' м²');

  closePotholeModal();
  messageInputEl.value = lines.join('\n');
  messageInputEl.focus();
});