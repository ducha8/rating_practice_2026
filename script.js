let chats = [
  { id: 'chat_1', name: '20250516_083700', messages: [] },
  {
    id: 'chat_2',
    name: 'Новый чат: 2025.05.22',
    messages: [
      { role: 'user', text: 'Привет', time: '10:41' },
      { role: 'bot',  text: 'Привет! Как я могу помочь тебе сегодня?', time: '10:41' },
      { role: 'user', text: 'Как дела?', time: '10:42' },
      { role: 'bot',  text: 'Всё отлично, готов помогать! Что нужно сделать?', time: '10:42' },
    ]
  },
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `chat_${i + 3}`,
    name: `Новый чат: 2025.05.${i < 7 ? '22' : '23'}`,
    messages: []
  }))
];

let activeChatId = 'chat_2';
let pendingDeleteId = null;

// ── DOM refs ─────────────────────────────────────────
const chatListEl     = document.getElementById('chatList');
const chatWindowEl   = document.getElementById('chatWindow');
const typingEl       = document.getElementById('typingIndicator');
const currentLabelEl = document.getElementById('currentChatLabel');
const messageInputEl = document.getElementById('messageInput');
const confirmOverlay = document.getElementById('confirmOverlay');
const confirmNameEl  = document.getElementById('confirmChatName');

// ── Helpers ──────────────────────────────────────────
function now() {
  return new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}
function getChat(id) { return chats.find(c => c.id === id); }

// ── Render chat list ─────────────────────────────────
function renderChatList() {
  chatListEl.innerHTML = '';
  chats.forEach(chat => {
    const item = document.createElement('div');
    item.className = 'chat-item' + (chat.id === activeChatId ? ' active' : '');

    const name = document.createElement('span');
    name.className = 'chat-item-name';
    name.textContent = chat.name;

    const delBtn = document.createElement('button');
    delBtn.className = 'chat-delete-btn';
    delBtn.title = 'Удалить чат';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', e => { e.stopPropagation(); openConfirm(chat.id, chat.name); });

    item.appendChild(name);
    item.appendChild(delBtn);
    item.addEventListener('click', () => switchChat(chat.id));
    chatListEl.appendChild(item);
  });
}

// ── Render messages ──────────────────────────────────
function renderMessages() {
  [...chatWindowEl.children].forEach(ch => { if (ch.id !== 'typingIndicator') ch.remove(); });
  const chat = getChat(activeChatId);
  if (!chat) return;
  chat.messages.forEach(msg => {
    chatWindowEl.insertBefore(buildMessageEl(msg.text, msg.role, msg.time), typingEl);
  });
  chatWindowEl.scrollTop = chatWindowEl.scrollHeight;
}

function buildMessageEl(text, role, time) {
  const wrap = document.createElement('div');
  wrap.className = `message ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;
  const t = document.createElement('div');
  t.className = 'msg-time';
  t.textContent = time || now();
  wrap.appendChild(bubble);
  wrap.appendChild(t);
  return wrap;
}

// ── Switch chat ──────────────────────────────────────
function switchChat(id) {
  activeChatId = id;
  const chat = getChat(id);
  currentLabelEl.textContent = chat ? chat.name : '—';
  renderChatList();
  renderMessages();
}

// ── Add message ──────────────────────────────────────
function addMessage(text, role) {
  const chat = getChat(activeChatId);
  if (!chat) return;
  const msg = { role, text, time: now() };
  chat.messages.push(msg);
  chatWindowEl.insertBefore(buildMessageEl(msg.text, msg.role, msg.time), typingEl);
  chatWindowEl.scrollTop = chatWindowEl.scrollHeight;
}

// ── Send message → GPT-4o ────────────────────────────
async function sendMessage() {
  const text = messageInputEl.value.trim();
  if (!text) return;

  addMessage(text, 'user');
  messageInputEl.value = '';

  typingEl.classList.add('visible');
  chatWindowEl.scrollTop = chatWindowEl.scrollHeight;

  // Собираем историю текущего чата для контекста
  const chat = getChat(activeChatId);
  const history = (chat?.messages || []).map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.text
  }));

  try {
    const response = await fetch('http://localhost:5000/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history })
    });

    const data = await response.json();
    typingEl.classList.remove('visible');

    if (data.text) {
      addMessage(data.text, 'bot');
    } else {
      addMessage('Ошибка: ' + (data.error || 'нет ответа'), 'bot');
    }
  } catch (err) {
    typingEl.classList.remove('visible');
    addMessage('Ошибка: сервер не запущен. Запусти: python server.py', 'bot');
  }
}

// ── New chat ─────────────────────────────────────────
function createNewChat() {
  const d = new Date();
  const date = `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')}`;
  const id = `chat_${Date.now()}`;
  chats.unshift({ id, name: `Новый чат: ${date}`, messages: [] });
  switchChat(id);
}

// ── Delete chat ──────────────────────────────────────
function openConfirm(id, name) {
  pendingDeleteId = id;
  confirmNameEl.textContent = name;
  confirmOverlay.classList.add('visible');
}
function closeConfirm() {
  confirmOverlay.classList.remove('visible');
  pendingDeleteId = null;
}
function confirmDelete() {
  if (!pendingDeleteId) return;
  chats = chats.filter(c => c.id !== pendingDeleteId);
  if (activeChatId === pendingDeleteId) activeChatId = chats.length ? chats[0].id : null;
  closeConfirm();
  if (activeChatId) { switchChat(activeChatId); }
  else { currentLabelEl.textContent = '—'; renderChatList(); renderMessages(); }
}

// ── Download history ─────────────────────────────────
function downloadHistory() {
  const chat = getChat(activeChatId);
  if (!chat || !chat.messages.length) return;
  const text = chat.messages
    .map(m => `[${m.time}] ${m.role === 'user' ? 'Пользователь' : 'Бот'}: ${m.text}`)
    .join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = `${chat.name}.txt`;
  a.click();
}

// ── Upload audio → Whisper → чат ─────────────────────
function uploadFile() {
  const fi = document.createElement('input');
  fi.type = 'file';
  fi.accept = 'audio/*';
  fi.click();

  fi.onchange = async () => {
    const file = fi.files[0];
    if (!file) return;

    addMessage(`🎵 Аудио: ${file.name}`, 'user');
    typingEl.classList.add('visible');
    chatWindowEl.scrollTop = chatWindowEl.scrollHeight;

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('http://localhost:5000/api/transcribe', {
        method: 'POST',
        body: formData
      });

      const data = await response.json();
      typingEl.classList.remove('visible');

      if (data.text) {
        addMessage(data.text, 'bot');
      } else {
        addMessage('Ошибка: ' + (data.error || 'не удалось распознать аудио'), 'bot');
      }
    } catch (err) {
      typingEl.classList.remove('visible');
      addMessage('Ошибка: сервер не запущен. Запусти: python server.py', 'bot');
    }
  };
}

// ── Events ───────────────────────────────────────────
document.getElementById('sendBtn').addEventListener('click', sendMessage);
messageInputEl.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });
document.getElementById('newChatBtn').addEventListener('click', createNewChat);
document.getElementById('downloadBtn').addEventListener('click', downloadHistory);
document.getElementById('uploadBtn').addEventListener('click', uploadFile);
document.getElementById('confirmCancelBtn').addEventListener('click', closeConfirm);
document.getElementById('confirmDeleteBtn').addEventListener('click', confirmDelete);
confirmOverlay.addEventListener('click', e => { if (e.target === confirmOverlay) closeConfirm(); });

// ── Init ─────────────────────────────────────────────
renderChatList();
renderMessages();
currentLabelEl.textContent = getChat(activeChatId)?.name || '—';