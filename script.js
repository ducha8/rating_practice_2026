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
    res = await fetch(API + url, Object.assign({}, options, { headers }));
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
          return fetch(API + url, Object.assign({}, options, { headers }));
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
var chats = [], activeChatId = null, activeHistory = [];
var lastTranscription = '', isFirstMessage = false;

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
//  PROTOCOLS MODAL
// ══════════════════════════════════════════════════════
var protocolsOverlay = document.getElementById('protocolsOverlay');
var protocolsList    = document.getElementById('protocolsList');

async function openProtocols() {
  protocolsOverlay.classList.add('visible');
  protocolsList.innerHTML = '<div class="protocols-empty">Загрузка...</div>';
  try {
    var res = await apiFetch('/api/protocols');
    var data = await res.json();
    renderProtocolsList(Array.isArray(data) ? data : []);
  } catch (e) {
    protocolsList.innerHTML = '<div class="protocols-empty">Ошибка: ' + e.message + '</div>';
  }
}

function renderProtocolsList(items) {
  protocolsList.innerHTML = '';
  if (!items.length) {
    var empty = document.createElement('div');
    empty.className = 'protocols-empty';
    empty.innerHTML = 'Протоколов пока нет.<br>Загрузите аудио и нажмите «Полное» или «Быстрое заполнение».';
    protocolsList.appendChild(empty); return;
  }
  items.forEach(function(p) {
    var item = document.createElement('div'); item.className = 'protocol-item';
    var info = document.createElement('div'); info.className = 'protocol-item-info';
    var name = document.createElement('div'); name.className = 'protocol-item-name'; name.textContent = p.filename;
    var meta = document.createElement('div'); meta.className = 'protocol-item-meta';
    meta.textContent = (p.type === 'full' ? 'Полный' : 'Быстрый') + ' · ' + p.chat_name + ' · ' + p.created_at.substring(0,16).replace('T',' ');
    info.appendChild(name); info.appendChild(meta);
    var actions = document.createElement('div'); actions.className = 'protocol-item-actions';
    var dlBtn = document.createElement('button'); dlBtn.className = 'protocol-download-btn'; dlBtn.textContent = '⬇ Скачать';
    dlBtn.addEventListener('click', function() { downloadProtocolById(p.id, p.filename); });
    var delBtn = document.createElement('button'); delBtn.className = 'protocol-delete-btn'; delBtn.textContent = '✕';
    delBtn.addEventListener('click', async function() {
      if (!confirm('Удалить «' + p.filename + '»?')) return;
      await apiFetch('/api/protocols/' + p.id, { method: 'DELETE' }).catch(function(){});
      openProtocols();
    });
    actions.appendChild(dlBtn); actions.appendChild(delBtn);
    item.appendChild(info); item.appendChild(actions);
    protocolsList.appendChild(item);
  });
}

async function downloadProtocolById(id, filename) {
  try {
    var res = await apiFetch('/api/protocols/' + id);
    var data = await res.json();
    if (!res.ok) { alert('Ошибка: ' + data.error); return; }
    var blob = new Blob([data.content], { type: 'text/markdown;charset=utf-8' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { alert('Ошибка: ' + e.message); }
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
  audioMsg.className = 'inline-msg'; audioMsg.textContent = '';
  audioResult.style.display = 'none'; audioTextResult.value = '';
  audioOverlay.classList.add('visible');
}
function closeAudioModal() { audioOverlay.classList.remove('visible'); }

document.getElementById('audioToTextBtn').addEventListener('click', openAudioModal);
document.getElementById('audioCloseBtn').addEventListener('click', closeAudioModal);
audioOverlay.addEventListener('click', function(e) { if (e.target === audioOverlay) closeAudioModal(); });

document.getElementById('audioUploadBtn').addEventListener('click', function() {
  var fi = document.createElement('input'); fi.type = 'file'; fi.accept = 'audio/*'; fi.click();
  fi.onchange = async function() {
    var file = fi.files[0]; if (!file) return;
    audioMsg.className = 'inline-msg success';
    audioMsg.textContent = '⏳ Распознаю: ' + file.name + '...';
    audioResult.style.display = 'none';
    document.getElementById('audioUploadBtn').disabled = true;
    try {
      var fd = new FormData(); fd.append('file', file);
      var res = await fetch(API + '/api/transcribe', { method: 'POST', headers: { 'Authorization': 'Bearer ' + getToken() }, body: fd });
      var data = await res.json();
      if (data.text) {
        lastTranscription = data.text;
        audioMsg.className = 'inline-msg success';
        audioMsg.textContent = '✅ Готово! ' + data.text.length + ' символов.';
        audioTextResult.value = data.text;
        audioResult.style.display = 'block';
      } else {
        audioMsg.className = 'inline-msg error';
        audioMsg.textContent = 'Ошибка: ' + (data.error || 'не удалось распознать');
      }
    } catch (e) {
      audioMsg.className = 'inline-msg error'; audioMsg.textContent = 'Ошибка: ' + e.message;
    } finally { document.getElementById('audioUploadBtn').disabled = false; }
  };
});

// ══════════════════════════════════════════════════════
//  IMAGE RECOGNITION MODAL
// ══════════════════════════════════════════════════════
var imageOverlay     = document.getElementById('imageOverlay');
var imageMsg         = document.getElementById('imageMsg');
var imagePreview     = document.getElementById('imagePreview');
var imagePreviewImg  = document.getElementById('imagePreviewImg');
var imageResult      = document.getElementById('imageResult');
var imageTextResult  = document.getElementById('imageTextResult');
var imageQuestionInp = document.getElementById('imageQuestion');
var imageUploadBtn   = document.getElementById('imageUploadBtn');
var imageAnalyzeBtn  = document.getElementById('imageAnalyzeBtn');
var pendingImageFile = null;

function openImageModal() {
  imageMsg.className = 'inline-msg'; imageMsg.textContent = '';
  imagePreview.style.display = 'none'; imagePreviewImg.src = '';
  imageResult.style.display = 'none'; imageTextResult.value = '';
  imageQuestionInp.value = ''; imageAnalyzeBtn.disabled = true; pendingImageFile = null;
  imageOverlay.classList.add('visible');
}
function closeImageModal() { imageOverlay.classList.remove('visible'); }

document.getElementById('imageRecognizeBtn').addEventListener('click', openImageModal);
document.getElementById('imageCloseBtn').addEventListener('click', closeImageModal);
imageOverlay.addEventListener('click', function(e) { if (e.target === imageOverlay) closeImageModal(); });

imageUploadBtn.addEventListener('click', function() {
  var fi = document.createElement('input'); fi.type = 'file'; fi.accept = 'image/*'; fi.click();
  fi.onchange = function() {
    var file = fi.files[0]; if (!file) return;
    pendingImageFile = file;
    var reader = new FileReader();
    reader.onload = function(e) { imagePreviewImg.src = e.target.result; imagePreview.style.display = 'block'; };
    reader.readAsDataURL(file);
    imageMsg.className = 'inline-msg success'; imageMsg.textContent = '✅ ' + file.name;
    imageResult.style.display = 'none'; imageTextResult.value = '';
    imageAnalyzeBtn.disabled = false;
  };
});

imageAnalyzeBtn.addEventListener('click', async function() {
  if (!pendingImageFile) return;
  imageMsg.className = 'inline-msg success'; imageMsg.textContent = '🔍 Анализирую...';
  imageResult.style.display = 'none'; imageAnalyzeBtn.disabled = true; imageUploadBtn.disabled = true;
  try {
    var fd = new FormData(); fd.append('file', pendingImageFile);
    var q = imageQuestionInp.value.trim(); if (q) fd.append('question', q);
    var res = await fetch(API + '/api/recognize-image', { method: 'POST', headers: { 'Authorization': 'Bearer ' + getToken() }, body: fd });
    var data = await res.json();
    if (res.ok && data.text) {
      imageMsg.className = 'inline-msg success'; imageMsg.textContent = '✅ Готово!';
      imageTextResult.value = data.text; imageResult.style.display = 'block';
      document.getElementById('imageSendToChatBtn').style.display = 'block';
    } else {
      imageMsg.className = 'inline-msg error'; imageMsg.textContent = 'Ошибка: ' + (data.error || 'нет ответа');
    }
  } catch (e) { imageMsg.className = 'inline-msg error'; imageMsg.textContent = 'Ошибка: ' + e.message; }
  finally { imageAnalyzeBtn.disabled = false; imageUploadBtn.disabled = false; }
});

document.getElementById('imageSendToChatBtn').addEventListener('click', function() {
  var text = imageTextResult.value.trim(); if (!text) return;
  var fn = pendingImageFile ? pendingImageFile.name : 'изображение';
  closeImageModal();
  messageInputEl.value = '🖼️ Анализ «' + fn + '»:\n\n' + text;
  messageInputEl.focus();
});

// ══════════════════════════════════════════════════════
//  CHANGE PASSWORD MODAL
// ══════════════════════════════════════════════════════
var changePwOverlay   = document.getElementById('changePwOverlay');
var changePwSubmitBtn = document.getElementById('changePwSubmitBtn');
var changePwMsg       = document.getElementById('changePwMsg');

function openChangePw() {
  document.getElementById('changePwUserLabel').textContent = 'Аккаунт: ' + userEmail;
  changePwMsg.className = 'inline-msg'; changePwMsg.textContent = '';
  ['oldPassword','newPassword','newPassword2'].forEach(function(id){ document.getElementById(id).value=''; });
  changePwOverlay.classList.add('visible');
  setTimeout(function(){ document.getElementById('oldPassword').focus(); }, 200);
}
function closeChangePw() { changePwOverlay.classList.remove('visible'); }
document.getElementById('changePwBtn').addEventListener('click', openChangePw);
document.getElementById('changePwCancelBtn').addEventListener('click', closeChangePw);
changePwOverlay.addEventListener('click', function(e){ if(e.target===changePwOverlay) closeChangePw(); });

changePwSubmitBtn.addEventListener('click', async function() {
  var oldPw = document.getElementById('oldPassword').value;
  var newPw = document.getElementById('newPassword').value;
  var newPw2 = document.getElementById('newPassword2').value;
  if (!oldPw||!newPw||!newPw2) { showMsg(changePwMsg,'Заполните все поля','error'); return; }
  if (newPw!==newPw2) { showMsg(changePwMsg,'Пароли не совпадают','error'); return; }
  if (newPw.length<6) { showMsg(changePwMsg,'Минимум 6 символов','error'); return; }
  changePwSubmitBtn.disabled = true; changePwSubmitBtn.innerHTML = '<span class="spinner"></span>Подождите...';
  try {
    var res = await apiFetch('/api/auth/change-password', { method:'POST', body: JSON.stringify({old_password:oldPw,new_password:newPw}) });
    var data = await res.json();
    if (!res.ok) { showMsg(changePwMsg, data.error||'Ошибка','error'); return; }
    showMsg(changePwMsg,'Пароль изменён!','success');
    setTimeout(function(){ localStorage.clear(); window.location.replace('login.html'); }, 1500);
  } catch(e){ showMsg(changePwMsg,'Ошибка: '+e.message,'error'); }
  finally { changePwSubmitBtn.disabled=false; changePwSubmitBtn.textContent='Сменить пароль'; }
});
['oldPassword','newPassword','newPassword2'].forEach(function(id){
  document.getElementById(id).addEventListener('keydown',function(e){ if(e.key==='Enter') changePwSubmitBtn.click(); });
});

function showMsg(el, text, type) { el.className='inline-msg '+(type||'error'); el.textContent=text; }

// ══════════════════════════════════════════════════════
//  CONTEXT MENU
// ══════════════════════════════════════════════════════
var ctxMenu = null, pendingDeleteId = null, renamingId = null;

function removeCtxMenu() { if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; } }
function showContextMenu(x, y, chatId, chatName) {
  removeCtxMenu();
  ctxMenu = document.createElement('div'); ctxMenu.className = 'ctx-menu';
  ctxMenu.innerHTML = '<button class="ctx-item" data-action="rename">✏️ Переименовать</button><button class="ctx-item danger" data-action="delete">🗑 Удалить</button>';
  ctxMenu.style.cssText = 'position:fixed;left:'+x+'px;top:'+y+'px;z-index:200;';
  document.body.appendChild(ctxMenu);
  var rect = ctxMenu.getBoundingClientRect();
  if (rect.right > window.innerWidth) ctxMenu.style.left = (x - rect.width) + 'px';
  if (rect.bottom > window.innerHeight) ctxMenu.style.top = (y - rect.height) + 'px';
  ctxMenu.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]'); if (!btn) return;
    if (btn.dataset.action==='rename') startRename(chatId);
    if (btn.dataset.action==='delete') openConfirm(chatId, chatName);
    removeCtxMenu();
  });
}
document.addEventListener('click', removeCtxMenu);
document.addEventListener('contextmenu', function(e){ if(!e.target.closest('.chat-item')) removeCtxMenu(); });

function startRename(chatId) { renamingId = chatId; renderChatList(); }
async function commitRename(chatId, newName) {
  newName = (newName||'').trim(); renamingId = null;
  if (!newName) { renderChatList(); return; }
  try {
    var res = await apiFetch('/api/chats/'+chatId, { method:'PATCH', body: JSON.stringify({name:newName}) });
    if (res.ok) {
      var chat = chats.find(function(c){ return c.id===chatId; });
      if (chat) chat.name = newName;
      if (activeChatId===chatId) currentLabelEl.innerHTML = 'Текущий чат:<br><span>'+newName+'</span>';
    }
  } catch(e){}
  renderChatList();
}

// ══════════════════════════════════════════════════════
//  RENDER
// ══════════════════════════════════════════════════════
function renderChatList() {
  chatListEl.innerHTML = '';
  chats.forEach(function(chat) {
    var item = document.createElement('div');
    item.className = 'chat-item' + (chat.id===activeChatId ? ' active' : '');
    if (renamingId===chat.id) {
      var inp = document.createElement('input'); inp.type='text'; inp.className='rename-input'; inp.value=chat.name;
      inp.addEventListener('keydown', function(e){
        if(e.key==='Enter') commitRename(chat.id,inp.value);
        if(e.key==='Escape'){ renamingId=null; renderChatList(); }
        e.stopPropagation();
      });
      inp.addEventListener('blur', function(){ commitRename(chat.id,inp.value); });
      item.appendChild(inp); chatListEl.appendChild(item);
      setTimeout(function(){ inp.focus(); inp.select(); }, 0);
    } else {
      var nameEl = document.createElement('span'); nameEl.className='chat-item-name'; nameEl.textContent=chat.name;
      item.appendChild(nameEl);
      item.addEventListener('click', function(){ switchChat(chat.id); });
      item.addEventListener('contextmenu', function(e){
        e.preventDefault(); e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, chat.id, chat.name);
      });
      chatListEl.appendChild(item);
    }
  });
}

function renderMessages(messages) {
  messages = messages || [];
  Array.from(chatWindowEl.children).forEach(function(ch){ if(ch.id!=='typingIndicator') ch.remove(); });
  activeHistory = []; lastTranscription = '';
  messages.forEach(function(msg) {
    var role = msg.role==='assistant'?'assistant':'user';
    var content = msg.content||msg.text||'';
    var time = msg.created_at ? msg.created_at.substring(11,16) : nowTime();
    activeHistory.push({role:role,content:content});
    if (role==='user'&&content.startsWith('📝 Транскрипция:'))
      lastTranscription = content.replace('📝 Транскрипция:','').trim();
    chatWindowEl.insertBefore(buildMessageEl(content, role==='assistant'?'bot':'user', time), typingEl);
  });
  chatWindowEl.scrollTop = chatWindowEl.scrollHeight;
  isFirstMessage = (messages.length===0);
}

function buildMessageEl(text, roleClass, time) {
  var wrap = document.createElement('div'); wrap.className='message '+roleClass;
  var bubble = document.createElement('div'); bubble.className='msg-bubble'; bubble.textContent=text;
  var t = document.createElement('div'); t.className='msg-time'; t.textContent=time||nowTime();
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
  var chat = chats.find(function(c){ return c.id===id; });
  currentLabelEl.innerHTML = 'Текущий чат:<br><span>'+(chat?chat.name:'—')+'</span>';
  renderChatList();
  Array.from(chatWindowEl.children).forEach(function(ch){ if(ch.id!=='typingIndicator') ch.remove(); });
  typingEl.classList.add('visible');
  try {
    var res = await apiFetch('/api/chats/'+id+'/messages');
    var msgs = await res.json();
    typingEl.classList.remove('visible');
    renderMessages(Array.isArray(msgs)?msgs:[]);
  } catch(e) {
    typingEl.classList.remove('visible');
    addMessageEl('Не удалось загрузить историю: '+e.message,'bot');
  }
}

async function loadChats() {
  try {
    var res = await apiFetch('/api/chats');
    if (!res.ok) { currentLabelEl.innerHTML='Ошибка загрузки'; return; }
    chats = await res.json();
    renderChatList();
    if (chats.length) switchChat(chats[0].id);
    else { currentLabelEl.innerHTML='Текущий чат:<br><span>—</span>'; isFirstMessage=true; }
  } catch(e) { currentLabelEl.innerHTML='Ошибка: '+e.message; }
}

async function createNewChat() {
  try {
    var res = await apiFetch('/api/chats', { method:'POST', body: JSON.stringify({}) });
    if (!res.ok) return null;
    var chat = await res.json();
    chats.unshift(chat);
    await switchChat(chat.id);
    isFirstMessage = true;
    return chat.id;
  } catch(e) { return null; }
}

function openConfirm(id, name) { pendingDeleteId=id; confirmNameEl.textContent=name; confirmOverlay.classList.add('visible'); }
function closeConfirm() { confirmOverlay.classList.remove('visible'); pendingDeleteId=null; }
async function confirmDelete() {
  if (!pendingDeleteId) return;
  var id = pendingDeleteId; closeConfirm();
  try { await apiFetch('/api/chats/'+id, { method:'DELETE' }); } catch(e){}
  chats = chats.filter(function(c){ return c.id!==id; });
  if (activeChatId===id) { activeChatId=null; activeHistory=[]; lastTranscription=''; }
  if (!activeChatId&&chats.length) activeChatId=chats[0].id;
  renderChatList();
  if (activeChatId) switchChat(activeChatId);
  else {
    currentLabelEl.innerHTML='Текущий чат:<br><span>—</span>';
    Array.from(chatWindowEl.children).forEach(function(ch){ if(ch.id!=='typingIndicator') ch.remove(); });
    isFirstMessage=true;
  }
}

// ══════════════════════════════════════════════════════
//  SEND MESSAGE
// ══════════════════════════════════════════════════════
async function sendMessage() {
  var text = messageInputEl.value.trim(); if (!text) return;
  if (!activeChatId) { var newId = await createNewChat(); if (!newId) return; }
  var sendingFirst = isFirstMessage;
  activeHistory.push({role:'user',content:text});
  addMessageEl(text,'user');
  messageInputEl.value = ''; isFirstMessage=false;
  typingEl.classList.add('visible'); chatWindowEl.scrollTop=chatWindowEl.scrollHeight;
  try {
    var res = await apiFetch('/api/chat', { method:'POST', body: JSON.stringify({messages:activeHistory,chat_id:activeChatId,is_first_message:sendingFirst}) });
    var data = await res.json();
    typingEl.classList.remove('visible');
    if (res.ok&&data.text) {
      activeHistory.push({role:'assistant',content:data.text});
      addMessageEl(data.text,'bot');
      if (data.new_name) {
        var chat=chats.find(function(c){return c.id===activeChatId;});
        if(chat){ chat.name=data.new_name; currentLabelEl.innerHTML='Текущий чат:<br><span>'+data.new_name+'</span>'; renderChatList(); }
      }
    } else { activeHistory.pop(); addMessageEl('Ошибка: '+(data.error||res.status),'bot'); }
  } catch(e) { typingEl.classList.remove('visible'); activeHistory.pop(); addMessageEl('Ошибка: '+e.message,'bot'); }
}

// ══════════════════════════════════════════════════════
//  SAVE PROTOCOL TO DB
// ══════════════════════════════════════════════════════
async function saveProtocolToDB(text, type) {
  var chat = chats.find(function(c){ return c.id===activeChatId; });
  var chatName = chat?chat.name:'Чат';
  var date = new Date();
  var dateStr = date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');
  var filename = (type==='full'?'Протокол_полный':'Протокол_быстрый')+'_'+dateStr+'.md';
  try {
    await apiFetch('/api/protocols', { method:'POST', body: JSON.stringify({chat_id:activeChatId,chat_name:chatName,type:type,filename:filename,content:text}) });
  } catch(e){}
  var blob = new Blob([text],{type:'text/markdown;charset=utf-8'});
  var url = URL.createObjectURL(blob);
  var wrap=document.createElement('div'); wrap.className='message bot';
  var bubble=document.createElement('div'); bubble.className='msg-bubble'; bubble.style.cssText='display:flex;flex-direction:column;gap:8px;';
  var label=document.createElement('span'); label.textContent='📄 Протокол сохранён:';
  var link=document.createElement('a'); link.href=url; link.download=filename; link.textContent='⬇ '+filename;
  link.style.cssText='color:#3b82f6;text-decoration:underline;cursor:pointer;font-weight:600;';
  var hint=document.createElement('span'); hint.style.cssText='font-size:10px;color:var(--muted);'; hint.textContent='Все протоколы — в разделе «Протоколы»';
  bubble.appendChild(label); bubble.appendChild(link); bubble.appendChild(hint);
  var t=document.createElement('div'); t.className='msg-time'; t.textContent=nowTime();
  wrap.appendChild(bubble); wrap.appendChild(t);
  chatWindowEl.insertBefore(wrap,typingEl); chatWindowEl.scrollTop=chatWindowEl.scrollHeight;
}

// ══════════════════════════════════════════════════════
//  ПОЛНОЕ ЗАПОЛНЕНИЕ
// ══════════════════════════════════════════════════════
document.getElementById('fullFill').addEventListener('click', async function() {
  if (!lastTranscription) { addMessageEl('⚠️ Сначала загрузите аудио через «Аудио → Текст».','bot'); return; }
  if (!activeChatId) { var newId=await createNewChat(); if(!newId) return; }
  addMessageEl('🔄 Выполняю полное заполнение...','bot'); typingEl.classList.add('visible');
  var prompt = 'Ты — секретарь совещания. Составь подробный протокол поручений.\n\nТекст совещания:\n"""\n'+lastTranscription+'\n"""\n\n'+
    'Формат Markdown:\n# ПРОТОКОЛ ПОРУЧЕНИЙ\n**Дата:** ...\n**Председатель:** ...\n**Присутствовали:** ...\n\n## ПОРУЧЕНИЯ\n### Поручение №[N]\n**Текст:** ...\n**Ответственный:** ...\n**Срок:** ...\n\n## РЕШЕНИЕ\n...';
  try {
    var res=await apiFetch('/api/chat',{method:'POST',body:JSON.stringify({messages:[{role:'user',content:prompt}],chat_id:activeChatId})});
    var data=await res.json(); typingEl.classList.remove('visible');
    if(res.ok&&data.text){ activeHistory.push({role:'assistant',content:data.text}); addMessageEl(data.text,'bot'); await saveProtocolToDB(data.text,'full'); }
    else addMessageEl('Ошибка: '+(data.error||'нет ответа'),'bot');
  } catch(e){ typingEl.classList.remove('visible'); addMessageEl('Ошибка: '+e.message,'bot'); }
});

// ══════════════════════════════════════════════════════
//  БЫСТРОЕ ЗАПОЛНЕНИЕ
// ══════════════════════════════════════════════════════
document.getElementById('fastFill').addEventListener('click', async function() {
  if (!lastTranscription) { addMessageEl('⚠️ Сначала загрузите аудио через «Аудио → Текст».','bot'); return; }
  if (!activeChatId) { var newId=await createNewChat(); if(!newId) return; }
  addMessageEl('⚡ Быстрое заполнение...','bot'); typingEl.classList.add('visible');
  var prompt='Выдели поручения СТРОГО в формате:\nПоручение: [текст].\n- Ответственный: [имя].\n- Срок: [дата].\n\nБез вводных фраз.\n\nТекст:\n"""\n'+lastTranscription+'\n"""';
  try {
    var res=await apiFetch('/api/chat',{method:'POST',body:JSON.stringify({messages:[{role:'user',content:prompt}],chat_id:activeChatId})});
    var data=await res.json(); typingEl.classList.remove('visible');
    if(res.ok&&data.text){ activeHistory.push({role:'assistant',content:data.text}); addMessageEl(data.text,'bot'); await saveProtocolToDB(data.text,'fast'); }
    else addMessageEl('Ошибка: '+(data.error||'нет ответа'),'bot');
  } catch(e){ typingEl.classList.remove('visible'); addMessageEl('Ошибка: '+e.message,'bot'); }
});

// ══════════════════════════════════════════════════════
//  POTHOLE DETECTION (фото)
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
var pendingPotholeFile  = null;
var lastPotholeDetections = [];

potholeConfSlider.addEventListener('input', function(){ potholeConfLabel.textContent = potholeConfSlider.value+'%'; });

async function fetchPotholeModelStatus() {
  try {
    var res=await apiFetch('/api/pothole-model-status');
    var data=await res.json();
    if(data.loaded) potholeModelStatus.innerHTML='<span style="color:var(--'+(data.is_custom?'success':'accent')+')">'+(data.is_custom?'✅ Дообученная':'⚠️ Базовая YOLOv8n-seg')+'</span> · '+(data.device==='cpu'?'CPU':'GPU');
    else potholeModelStatus.textContent='❌ Модель не загружена';
  } catch(e){ potholeModelStatus.textContent='⚠️ Нет связи'; }
}

function openPotholeModal() {
  potholeMsg.className='inline-msg'; potholeMsg.textContent='';
  potholePreviewWrap.style.display='none'; potholeOrigImg.src=''; potholeResultImg.src='';
  potholeResultImg.style.display='none'; potholeResultPH.style.display='flex';
  potholeList.style.display='none'; potholeListItems.innerHTML='';
  document.getElementById('potholeAnalyzeBtn').disabled=true;
  document.getElementById('potholeSendToChatBtn').style.display='none';
  pendingPotholeFile=null; lastPotholeDetections=[];
  potholeOverlay.classList.add('visible'); fetchPotholeModelStatus();
}
function closePotholeModal(){ potholeOverlay.classList.remove('visible'); }

document.getElementById('potholeDetectBtn').addEventListener('click', openPotholeModal);
document.getElementById('potholeCloseBtn').addEventListener('click', closePotholeModal);
potholeOverlay.addEventListener('click', function(e){ if(e.target===potholeOverlay) closePotholeModal(); });

document.getElementById('potholeUploadBtn').addEventListener('click', function(){
  var fi=document.createElement('input'); fi.type='file'; fi.accept='image/jpeg,image/png,image/webp,image/bmp'; fi.click();
  fi.onchange=function(){
    var file=fi.files[0]; if(!file) return;
    pendingPotholeFile=file;
    var reader=new FileReader();
    reader.onload=function(e){ potholeOrigImg.src=e.target.result; potholePreviewWrap.style.display='block'; potholeResultImg.style.display='none'; potholeResultPH.style.display='flex'; potholeList.style.display='none'; };
    reader.readAsDataURL(file);
    potholeMsg.className='inline-msg success'; potholeMsg.textContent='✅ '+file.name;
    document.getElementById('potholeAnalyzeBtn').disabled=false;
  };
});

document.getElementById('potholeAnalyzeBtn').addEventListener('click', async function(){
  if(!pendingPotholeFile) return;
  var conf=parseInt(potholeConfSlider.value)/100;
  potholeMsg.className='inline-msg success'; potholeMsg.textContent='🔍 Анализирую...';
  potholeResultImg.style.display='none'; potholeResultPH.style.display='flex'; potholeResultPH.textContent='⏳ Обработка...';
  potholeList.style.display='none'; document.getElementById('potholeAnalyzeBtn').disabled=true; document.getElementById('potholeUploadBtn').disabled=true;
  try {
    var fd=new FormData(); fd.append('file',pendingPotholeFile); fd.append('conf',conf.toString());
    var res=await fetch(API+'/api/detect-potholes',{method:'POST',headers:{'Authorization':'Bearer '+getToken()},body:fd});
    var data=await res.json();
    if(res.ok){
      potholeResultImg.src='data:image/jpeg;base64,'+data.annotated_image; potholeResultImg.style.display='block'; potholeResultPH.style.display='none';
      lastPotholeDetections=data.detections||[];
      if(data.count===0){ potholeMsg.textContent='✅ Дефектов не найдено! ('+data.processing_ms+' мс)'; }
      else {
        potholeMsg.textContent='⚠️ Найдено: '+data.count+' · '+data.processing_ms+' мс';
        renderDetectList(potholeListItems, data.detections, 'pothole');
        potholeList.style.display='block'; document.getElementById('potholeSendToChatBtn').style.display='inline-block';
      }
    } else { potholeMsg.className='inline-msg error'; potholeMsg.textContent='Ошибка: '+(data.error||'нет ответа'); potholeResultPH.textContent='Ошибка'; }
  } catch(e){ potholeMsg.className='inline-msg error'; potholeMsg.textContent='Ошибка: '+e.message; }
  finally { document.getElementById('potholeAnalyzeBtn').disabled=false; document.getElementById('potholeUploadBtn').disabled=false; }
});

document.getElementById('potholeSendToChatBtn').addEventListener('click', function(){
  if(!lastPotholeDetections.length) return;
  var fn=pendingPotholeFile?pendingPotholeFile.name:'изображение';
  var lines=['🕳️ Анализ дороги «'+fn+'»:\nНайдено дефектов: '+lastPotholeDetections.length+'\n'];
  lastPotholeDetections.forEach(function(d){ lines.push('#'+d.id+' '+d.severity+' | '+Math.round(d.confidence*100)+'% | ~'+d.area_m2_est+' м²'); });
  closePotholeModal(); messageInputEl.value=lines.join('\n'); messageInputEl.focus();
});

// ══════════════════════════════════════════════════════
//  TRASH DETECTION (фото)
// ══════════════════════════════════════════════════════
var trashOverlay      = document.getElementById('trashOverlay');
var trashMsg          = document.getElementById('trashMsg');
var trashModelStatus  = document.getElementById('trashModelStatus');
var trashPreviewWrap  = document.getElementById('trashPreviewWrap');
var trashOrigImg      = document.getElementById('trashOrigImg');
var trashResultImg    = document.getElementById('trashResultImg');
var trashResultPH     = document.getElementById('trashResultPlaceholder');
var trashList         = document.getElementById('trashList');
var trashListItems    = document.getElementById('trashListItems');
var trashConfSlider   = document.getElementById('trashConf');
var trashConfLabel    = document.getElementById('trashConfLabel');
var pendingTrashFile  = null;
var lastTrashDetections = [];

trashConfSlider.addEventListener('input', function(){ trashConfLabel.textContent = trashConfSlider.value+'%'; });

async function fetchTrashModelStatus() {
  try {
    var res=await apiFetch('/api/trash-model-status');
    var data=await res.json();
    if(data.loaded) trashModelStatus.innerHTML='<span style="color:var(--'+(data.is_custom?'success':'accent')+')">'+(data.is_custom?'✅ Дообученная модель мусора':'⚠️ Базовая YOLOv8n-seg')+'</span> · '+(data.device==='cpu'?'CPU':'GPU');
    else trashModelStatus.textContent='❌ Модель не загружена';
  } catch(e){ trashModelStatus.textContent='⚠️ Нет связи'; }
}

function openTrashModal() {
  trashMsg.className='inline-msg'; trashMsg.textContent='';
  trashPreviewWrap.style.display='none'; trashOrigImg.src=''; trashResultImg.src='';
  trashResultImg.style.display='none'; trashResultPH.style.display='flex';
  trashList.style.display='none'; trashListItems.innerHTML='';
  document.getElementById('trashAnalyzeBtn').disabled=true;
  document.getElementById('trashSendToChatBtn').style.display='none';
  pendingTrashFile=null; lastTrashDetections=[];
  trashOverlay.classList.add('visible'); fetchTrashModelStatus();
}
function closeTrashModal(){ trashOverlay.classList.remove('visible'); }

document.getElementById('trashDetectBtn').addEventListener('click', openTrashModal);
document.getElementById('trashCloseBtn').addEventListener('click', closeTrashModal);
trashOverlay.addEventListener('click', function(e){ if(e.target===trashOverlay) closeTrashModal(); });

document.getElementById('trashUploadBtn').addEventListener('click', function(){
  var fi=document.createElement('input'); fi.type='file'; fi.accept='image/jpeg,image/png,image/webp,image/bmp'; fi.click();
  fi.onchange=function(){
    var file=fi.files[0]; if(!file) return;
    pendingTrashFile=file;
    var reader=new FileReader();
    reader.onload=function(e){ trashOrigImg.src=e.target.result; trashPreviewWrap.style.display='block'; trashResultImg.style.display='none'; trashResultPH.style.display='flex'; trashList.style.display='none'; };
    reader.readAsDataURL(file);
    trashMsg.className='inline-msg success'; trashMsg.textContent='✅ '+file.name;
    document.getElementById('trashAnalyzeBtn').disabled=false;
  };
});

document.getElementById('trashAnalyzeBtn').addEventListener('click', async function(){
  if(!pendingTrashFile) return;
  var conf=parseInt(trashConfSlider.value)/100;
  trashMsg.className='inline-msg success'; trashMsg.textContent='🔍 Анализирую мусор...';
  trashResultImg.style.display='none'; trashResultPH.style.display='flex'; trashResultPH.textContent='⏳ Обработка...';
  trashList.style.display='none'; document.getElementById('trashAnalyzeBtn').disabled=true; document.getElementById('trashUploadBtn').disabled=true;
  try {
    var fd=new FormData(); fd.append('file',pendingTrashFile); fd.append('conf',conf.toString());
    var res=await fetch(API+'/api/detect-trash',{method:'POST',headers:{'Authorization':'Bearer '+getToken()},body:fd});
    var data=await res.json();
    if(res.ok){
      trashResultImg.src='data:image/jpeg;base64,'+data.annotated_image; trashResultImg.style.display='block'; trashResultPH.style.display='none';
      lastTrashDetections=data.detections||[];
      var pollClass = 'poll-'+(data.pollution_level||'Чисто');
      if(data.count===0){ trashMsg.textContent='✅ Мусора не обнаружено! ('+data.processing_ms+' мс)'; }
      else {
        trashMsg.innerHTML='🗑️ Найдено: '+data.count+' · <span class="sev-badge '+pollClass+'">'+(data.pollution_level||'')+'</span> · '+data.processing_ms+' мс';
        trashMsg.className='inline-msg success';
        renderDetectList(trashListItems, data.detections, 'trash');
        trashList.style.display='block'; document.getElementById('trashSendToChatBtn').style.display='inline-block';
      }
    } else { trashMsg.className='inline-msg error'; trashMsg.textContent='Ошибка: '+(data.error||'нет ответа'); trashResultPH.textContent='Ошибка'; }
  } catch(e){ trashMsg.className='inline-msg error'; trashMsg.textContent='Ошибка: '+e.message; }
  finally { document.getElementById('trashAnalyzeBtn').disabled=false; document.getElementById('trashUploadBtn').disabled=false; }
});

document.getElementById('trashSendToChatBtn').addEventListener('click', function(){
  if(!lastTrashDetections.length) return;
  var fn=pendingTrashFile?pendingTrashFile.name:'изображение';
  var lines=['🗑️ Анализ мусора «'+fn+'»:\nНайдено объектов: '+lastTrashDetections.length+'\n'];
  lastTrashDetections.forEach(function(d){ lines.push('#'+d.id+' '+d.class_name+' | '+Math.round(d.confidence*100)+'% | '+d.area_pct+'% кадра'); });
  closeTrashModal(); messageInputEl.value=lines.join('\n'); messageInputEl.focus();
});

// Общая функция рендера списка детекций
function renderDetectList(container, detections, type) {
  container.innerHTML='';
  detections.forEach(function(d){
    var item=document.createElement('div'); item.className='detect-item';
    var num=document.createElement('div'); num.className='detect-num'; num.textContent=d.id;
    var info=document.createElement('div'); info.className='detect-info';
    var badge=document.createElement('span');
    if(type==='pothole'){ badge.className='sev-badge sev-'+d.severity; badge.textContent=d.severity; }
    else { badge.className='sev-badge poll-'+(d.class_name||'trash'); badge.textContent=d.class_name||'мусор'; }
    var conf=document.createElement('div'); conf.className='detect-conf'; conf.textContent='Уверенность: '+Math.round(d.confidence*100)+'%';
    var area=document.createElement('div'); area.className='detect-area';
    if(type==='pothole') area.textContent='Площадь: ~'+d.area_m2_est+' м² · '+Math.round(d.area_ratio*100*10)/10+'%';
    else area.textContent='Площадь: '+d.area_pct+'% кадра · центр ('+d.center.x+', '+d.center.y+')';
    info.appendChild(badge); info.appendChild(conf); info.appendChild(area);
    item.appendChild(num); item.appendChild(info);
    container.appendChild(item);
  });
}

// ══════════════════════════════════════════════════════
//  VIDEO POTHOLE (SSE стрим)
// ══════════════════════════════════════════════════════
(function(){
  var overlay      = document.getElementById('videoOverlay');
  var closeBtn     = document.getElementById('videoCloseBtn');
  var uploadBtn    = document.getElementById('videoUploadBtn');
  var analyzeBtn   = document.getElementById('videoAnalyzeBtn');
  var cancelBtn    = document.getElementById('videoCancelBtn');
  var sendBtn      = document.getElementById('videoSendToChatBtn');
  var msgEl        = document.getElementById('videoMsg');
  var progressWrap = document.getElementById('videoProgressWrap');
  var progressBar  = document.getElementById('videoProgressBar');
  var progressLbl  = document.getElementById('videoProgressLabel');
  var streamWrap   = document.getElementById('videoStreamWrap');
  var streamCanvas = document.getElementById('videoStreamCanvas');
  var streamTs     = document.getElementById('videoStreamTs');
  var timelineEl   = document.getElementById('videoTimeline');
  var summaryEl    = document.getElementById('videoSummary');
  var summaryText  = document.getElementById('videoSummaryText');
  var confSlider   = document.getElementById('videoConf');
  var confLabel    = document.getElementById('videoConfLabel');
  var stepSlider   = document.getElementById('videoStep');
  var stepLabel    = document.getElementById('videoStepLabel');
  var pendingFile=null, activeXHR=null, videoEvents=[], videoSummary=null;

  document.getElementById('potholeVideoBtn').addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', function(e){ if(e.target===overlay) closeModal(); });
  function openModal(){ resetUI(); overlay.classList.add('visible'); }
  function closeModal(){ cancelStream(); overlay.classList.remove('visible'); }

  confSlider.addEventListener('input', function(){ confLabel.textContent=confSlider.value+'%'; });
  stepSlider.addEventListener('input', function(){ stepLabel.textContent=stepSlider.value+' кадр.'; });

  uploadBtn.addEventListener('click', function(){
    var fi=document.createElement('input'); fi.type='file'; fi.accept='video/*'; fi.click();
    fi.onchange=function(){
      var f=fi.files[0]; if(!f) return;
      pendingFile=f; setMsg('success','✅ '+f.name+' ('+(f.size/1024/1024).toFixed(1)+' МБ)');
      analyzeBtn.disabled=false; resetResults();
    };
  });

  analyzeBtn.addEventListener('click', startAnalysis);
  cancelBtn.addEventListener('click', cancelStream);

  function startAnalysis(){
    if(!pendingFile) return; resetResults();
    var conf=parseInt(confSlider.value)/100, step=parseInt(stepSlider.value);
    setMsg('success','🔍 Загружаю видео...');
    analyzeBtn.disabled=true; uploadBtn.disabled=true; cancelBtn.style.display='inline-block';
    progressWrap.style.display='flex'; streamWrap.style.display='flex';
    var fd=new FormData(); fd.append('file',pendingFile); fd.append('conf',conf.toString()); fd.append('frame_step',step.toString());
    var xhr=new XMLHttpRequest(); xhr.open('POST',API+'/api/detect-potholes-video');
    xhr.setRequestHeader('Authorization','Bearer '+getToken());
    var buffer='';
    xhr.onprogress=function(){ var newData=xhr.responseText.slice(buffer.length); buffer=xhr.responseText; newData.split('\n').forEach(function(line){ line=line.trim(); if(line.startsWith('data:')){ try{ handleEvent(JSON.parse(line.slice(5).trim())); }catch(e){} } }); };
    xhr.onload=xhr.onerror=finishUI; activeXHR=xhr; xhr.send(fd);
  }
  function cancelStream(){ if(activeXHR){ try{activeXHR.abort();}catch(e){} activeXHR=null; } finishUI(); setMsg('','⛔ Отменено.'); }

  function handleEvent(ev){
    if(ev.type==='start') setMsg('success','▶️ '+fmtDur(ev.duration)+' · '+ev.fps+' fps');
    else if(ev.type==='frame'){ renderFrame(ev.image,ev.ts_label,ev.count); videoEvents.push(ev); appendTlItem(ev,timelineEl); }
    else if(ev.type==='progress'){ setProgress(ev.pct,'Анализирую... '+ev.pct+'%'); }
    else if(ev.type==='done'){ videoSummary=ev.summary; renderSummary(ev.summary,summaryText); finishUI(); setMsg('success','✅ Готово! Событий: '+ev.summary.events_count); if(ev.summary.events_count>0) sendBtn.style.display='inline-block'; }
    else if(ev.type==='error'){ setMsg('error','❌ '+ev.message); finishUI(); }
  }
  var _img=new Image();
  function renderFrame(b64,tsLabel,count){ _img.onload=function(){ var ctx=streamCanvas.getContext('2d'); streamCanvas.width=_img.naturalWidth||640; streamCanvas.height=_img.naturalHeight||360; ctx.drawImage(_img,0,0); }; _img.src='data:image/jpeg;base64,'+b64; streamTs.textContent=tsLabel+' · ям: '+count; }

  sendBtn.addEventListener('click', function(){
    if(!videoSummary) return;
    var s=videoSummary, fn=pendingFile?pendingFile.name:'видео';
    var lines=['🎥 Анализ дорог «'+fn+'»','Длительность: '+fmtDur(s.duration_s),'Кадров: '+s.total_frames_analyzed,'Обнаружений: '+s.total_detections,''];
    if(s.events.length){ lines.push('ХРОНОЛОГИЯ:'); s.events.forEach(function(e){ lines.push(e.ts_label+' — '+e.count+' ям'); }); }
    closeModal(); messageInputEl.value=lines.join('\n'); messageInputEl.focus();
  });
  document.getElementById('videoDownloadReportBtn').addEventListener('click', function(){
    var t=summaryText.value; if(!t) return;
    var b=new Blob([t],{type:'text/plain;charset=utf-8'}); var a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download='pothole_report.txt'; a.click(); URL.revokeObjectURL(a.href);
  });

  function setMsg(type,text){ msgEl.className=type?'inline-msg '+type:'inline-msg'; msgEl.textContent=text; }
  function setProgress(pct,lbl){ progressBar.style.width=pct+'%'; progressLbl.textContent=lbl; }
  function finishUI(){ analyzeBtn.disabled=false; uploadBtn.disabled=false; cancelBtn.style.display='none'; setProgress(100,'Готово'); activeXHR=null; }
  function resetResults(){ videoEvents=[]; videoSummary=null; timelineEl.innerHTML=''; timelineEl.style.display='none'; summaryEl.style.display='none'; summaryText.value=''; streamWrap.style.display='none'; progressWrap.style.display='none'; setProgress(0,''); sendBtn.style.display='none'; cancelBtn.style.display='none'; }
  function resetUI(){ pendingFile=null; analyzeBtn.disabled=true; uploadBtn.disabled=false; msgEl.className='inline-msg'; msgEl.textContent=''; resetResults(); }
})();

// ══════════════════════════════════════════════════════
//  VIDEO TRASH (SSE стрим)
// ══════════════════════════════════════════════════════
(function(){
  var overlay      = document.getElementById('trashVideoOverlay');
  var closeBtn     = document.getElementById('trashVideoCloseBtn');
  var uploadBtn    = document.getElementById('trashVideoUploadBtn');
  var analyzeBtn   = document.getElementById('trashVideoAnalyzeBtn');
  var cancelBtn    = document.getElementById('trashVideoCancelBtn');
  var sendBtn      = document.getElementById('trashVideoSendBtn');
  var msgEl        = document.getElementById('trashVideoMsg');
  var progressWrap = document.getElementById('trashVideoProgressWrap');
  var progressBar  = document.getElementById('trashVideoProgressBar');
  var progressLbl  = document.getElementById('trashVideoProgressLabel');
  var streamWrap   = document.getElementById('trashVideoStreamWrap');
  var streamCanvas = document.getElementById('trashVideoCanvas');
  var streamTs     = document.getElementById('trashVideoStreamTs');
  var timelineEl   = document.getElementById('trashVideoTimeline');
  var summaryEl    = document.getElementById('trashVideoSummary');
  var summaryText  = document.getElementById('trashVideoSummaryText');
  var confSlider   = document.getElementById('trashVideoConf');
  var confLabel    = document.getElementById('trashVideoConfLabel');
  var stepSlider   = document.getElementById('trashVideoStep');
  var stepLabel    = document.getElementById('trashVideoStepLabel');
  var pendingFile=null, activeXHR=null, trashEvents=[], trashSummary=null;

  document.getElementById('trashVideoBtn').addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', function(e){ if(e.target===overlay) closeModal(); });
  function openModal(){ resetUI(); overlay.classList.add('visible'); }
  function closeModal(){ cancelStream(); overlay.classList.remove('visible'); }

  confSlider.addEventListener('input', function(){ confLabel.textContent=confSlider.value+'%'; });
  stepSlider.addEventListener('input', function(){ stepLabel.textContent=stepSlider.value+' кадр.'; });

  uploadBtn.addEventListener('click', function(){
    var fi=document.createElement('input'); fi.type='file'; fi.accept='video/*'; fi.click();
    fi.onchange=function(){
      var f=fi.files[0]; if(!f) return;
      pendingFile=f; setMsg('success','✅ '+f.name+' ('+(f.size/1024/1024).toFixed(1)+' МБ)');
      analyzeBtn.disabled=false; resetResults();
    };
  });

  analyzeBtn.addEventListener('click', startAnalysis);
  cancelBtn.addEventListener('click', cancelStream);

  function startAnalysis(){
    if(!pendingFile) return; resetResults();
    var conf=parseInt(confSlider.value)/100, step=parseInt(stepSlider.value);
    setMsg('success','🔍 Загружаю видео...');
    analyzeBtn.disabled=true; uploadBtn.disabled=true; cancelBtn.style.display='inline-block';
    progressWrap.style.display='flex'; streamWrap.style.display='flex';
    var fd=new FormData(); fd.append('file',pendingFile); fd.append('conf',conf.toString()); fd.append('frame_step',step.toString());
    var xhr=new XMLHttpRequest(); xhr.open('POST',API+'/api/detect-trash-video');
    xhr.setRequestHeader('Authorization','Bearer '+getToken());
    var buffer='';
    xhr.onprogress=function(){ var newData=xhr.responseText.slice(buffer.length); buffer=xhr.responseText; newData.split('\n').forEach(function(line){ line=line.trim(); if(line.startsWith('data:')){ try{ handleEvent(JSON.parse(line.slice(5).trim())); }catch(e){} } }); };
    xhr.onload=xhr.onerror=finishUI; activeXHR=xhr; xhr.send(fd);
  }
  function cancelStream(){ if(activeXHR){ try{activeXHR.abort();}catch(e){} activeXHR=null; } finishUI(); setMsg('','⛔ Отменено.'); }

  function handleEvent(ev){
    if(ev.type==='start') setMsg('success','▶️ '+fmtDur(ev.duration)+' · '+ev.fps+' fps');
    else if(ev.type==='frame'){
      renderFrame(ev.image,ev.ts_label,ev.count,ev.pollution_level);
      trashEvents.push(ev); appendTlItem(ev,timelineEl,true);
    }
    else if(ev.type==='progress'){ setProgress(ev.pct,'Анализирую... '+ev.pct+'%'); }
    else if(ev.type==='done'){
      trashSummary=ev.summary; renderTrashSummary(ev.summary); finishUI();
      setMsg('success','✅ Готово! Событий: '+ev.summary.events_count);
      if(ev.summary.events_count>0) sendBtn.style.display='inline-block';
    }
    else if(ev.type==='error'){ setMsg('error','❌ '+ev.message); finishUI(); }
  }
  var _img=new Image();
  function renderFrame(b64,tsLabel,count,pollution){
    _img.onload=function(){ var ctx=streamCanvas.getContext('2d'); streamCanvas.width=_img.naturalWidth||640; streamCanvas.height=_img.naturalHeight||360; ctx.drawImage(_img,0,0); };
    _img.src='data:image/jpeg;base64,'+b64;
    streamTs.textContent=tsLabel+' · мусора: '+count+' · '+(pollution||'');
  }

  function renderTrashSummary(s){
    var lines=['📹 Длительность: '+fmtDur(s.duration_s),'🔍 Кадров: '+s.total_frames_analyzed,'🗑️ Всего объектов: '+s.total_detections,'📍 Событий: '+s.events_count,'Макс. загрязнение: '+(s.max_pollution||'—'),'','─── ХРОНОЛОГИЯ ───'];
    s.events.forEach(function(e){ var cls=e.detections.map(function(d){return d.class_name||'мусор';}).join(', '); lines.push(e.ts_label+' │ '+e.count+' объектов │ '+cls); });
    summaryText.value=lines.join('\n'); summaryEl.style.display='block';
  }

  sendBtn.addEventListener('click', function(){
    if(!trashSummary) return;
    var s=trashSummary, fn=pendingFile?pendingFile.name:'видео';
    var lines=['🗑️ Анализ мусора «'+fn+'»','Длительность: '+fmtDur(s.duration_s),'Объектов: '+s.total_detections,'Макс. загрязнение: '+(s.max_pollution||'—'),''];
    if(s.events.length){ lines.push('ХРОНОЛОГИЯ:'); s.events.forEach(function(e){ lines.push(e.ts_label+' — '+e.count+' объектов'); }); }
    closeModal(); messageInputEl.value=lines.join('\n'); messageInputEl.focus();
  });
  document.getElementById('trashVideoDownloadBtn').addEventListener('click', function(){
    var t=summaryText.value; if(!t) return;
    var b=new Blob([t],{type:'text/plain;charset=utf-8'}); var a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download='trash_report.txt'; a.click(); URL.revokeObjectURL(a.href);
  });

  function setMsg(type,text){ msgEl.className=type?'inline-msg '+type:'inline-msg'; msgEl.textContent=text; }
  function setProgress(pct,lbl){ progressBar.style.width=pct+'%'; progressLbl.textContent=lbl; }
  function finishUI(){ analyzeBtn.disabled=false; uploadBtn.disabled=false; cancelBtn.style.display='none'; setProgress(100,'Готово'); activeXHR=null; }
  function resetResults(){ trashEvents=[]; trashSummary=null; timelineEl.innerHTML=''; timelineEl.style.display='none'; summaryEl.style.display='none'; summaryText.value=''; streamWrap.style.display='none'; progressWrap.style.display='none'; setProgress(0,''); sendBtn.style.display='none'; cancelBtn.style.display='none'; }
  function resetUI(){ pendingFile=null; analyzeBtn.disabled=true; uploadBtn.disabled=false; msgEl.className='inline-msg'; msgEl.textContent=''; resetResults(); }
})();

// ══════════════════════════════════════════════════════
//  SHARED UTILS
// ══════════════════════════════════════════════════════
function appendTlItem(ev, container, isTrash) {
  var ph = container.nextElementSibling;
  if (ph && ph.classList.contains('vm-timeline-ph')) ph.style.display='none';
  var item=document.createElement('div'); item.className='vtl-item';
  var ts=document.createElement('div'); ts.className='vtl-ts'; ts.textContent=ev.ts_label;
  var cnt=document.createElement('div'); cnt.className='vtl-cnt'; cnt.textContent=(isTrash?ev.count+' мусора':ev.count+' ям');
  var sevs=document.createElement('div'); sevs.className='vtl-sevs';
  (ev.detections||[]).forEach(function(d){
    var b=document.createElement('span');
    if(isTrash){ b.className='sev-badge poll-'+(d.class_name||'trash'); b.textContent=(d.class_name||'мусор')+' '+Math.round(d.confidence*100)+'%'; }
    else { b.className='sev-badge sev-'+d.severity; b.textContent=d.severity+' '+Math.round(d.confidence*100)+'%'; }
    sevs.appendChild(b);
  });
  item.appendChild(ts); item.appendChild(cnt); item.appendChild(sevs);
  container.appendChild(item); container.scrollTop=container.scrollHeight;
  container.style.display='flex';
}

function renderSummary(s, textarea) {
  var lines=['📹 Длительность: '+fmtDur(s.duration_s),'🔍 Кадров: '+s.total_frames_analyzed,'🕳️ Всего: '+s.total_detections,'📍 Событий: '+s.events_count,'','─── ХРОНОЛОГИЯ ───'];
  s.events.forEach(function(e){ var sevs=e.detections.map(function(d){return d.severity+' '+Math.round(d.confidence*100)+'%';}).join(', '); lines.push(e.ts_label+' │ '+e.count+' ям │ '+sevs); });
  textarea.value=lines.join('\n'); textarea.closest('.vm-summary').style.display='block';
}

function fmtDur(sec){ var s=Math.round(sec),m=Math.floor(s/60); s=s%60; var h=Math.floor(m/60); m=m%60; return h?(h+'ч '+m+'м '+s+'с'):(m?(m+'м '+s+'с'):s+'с'); }
function nowTime(){ return new Date().toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'}); }
function downloadHistory(){
  var chat=chats.find(function(c){return c.id===activeChatId;}); if(!chat||!activeHistory.length){addMessageEl('История пуста.','bot');return;}
  var lines=activeHistory.map(function(m){return m.role+': '+m.content;});
  var blob=new Blob([lines.join('\n\n')],{type:'text/plain;charset=utf-8'});
  var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=chat.name+'.txt'; a.click(); URL.revokeObjectURL(a.href);
}

// ══════════════════════════════════════════════════════
//  EVENTS
// ══════════════════════════════════════════════════════
document.getElementById('sendBtn').addEventListener('click', sendMessage);
messageInputEl.addEventListener('keydown', function(e){ if(e.key==='Enter') sendMessage(); });
document.getElementById('newChatBtn').addEventListener('click', createNewChat);
document.getElementById('downloadBtn').addEventListener('click', downloadHistory);
document.getElementById('confirmCancelBtn').addEventListener('click', closeConfirm);
document.getElementById('confirmDeleteBtn').addEventListener('click', confirmDelete);
confirmOverlay.addEventListener('click', function(e){ if(e.target===confirmOverlay) closeConfirm(); });
document.getElementById('logoutBtn').addEventListener('click', function(){ localStorage.clear(); window.location.replace('login.html'); });

loadChats();