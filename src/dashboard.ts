export const DASHBOARD_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>WA-API Dashboard</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, Segoe UI, Roboto, sans-serif; background: #111b21; color: #e9edef; }
  #keyBar { display: flex; gap: 8px; padding: 10px; background: #202c33; align-items: center; }
  #keyBar input { flex: 1; padding: 8px; border-radius: 6px; border: none; background: #2a3942; color: #e9edef; }
  #keyBar button { padding: 8px 14px; border-radius: 6px; border: none; background: #00a884; color: white; cursor: pointer; }
  #layout { display: flex; height: calc(100vh - 52px); }
  #sidebar { width: 320px; background: #111b21; border-right: 1px solid #2a3942; overflow-y: auto; }
  .chatItem { padding: 12px 16px; border-bottom: 1px solid #202c33; cursor: pointer; }
  .chatItem:hover { background: #202c33; }
  .chatItem .jid { font-size: 13px; color: #8696a0; }
  .chatItem .preview { font-size: 14px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #tabs { display: flex; }
  #tabs button { flex: 1; padding: 10px; background: #202c33; color: #8696a0; border: none; cursor: pointer; }
  #tabs button.active { color: #00a884; border-bottom: 2px solid #00a884; }
  #main { flex: 1; display: flex; flex-direction: column; }
  #messages { flex: 1; overflow-y: auto; padding: 16px; }
  .msg { max-width: 60%; padding: 8px 12px; border-radius: 8px; margin-bottom: 8px; font-size: 14px; }
  .msg.in { background: #202c33; align-self: flex-start; }
  .msg.out { background: #005c4b; align-self: flex-end; margin-left: auto; }
  .msgWrap { display: flex; }
  .msgTime { font-size: 10px; color: #8696a0; margin-top: 4px; }
  #composer { display: flex; gap: 8px; padding: 12px; background: #202c33; }
  #composer input { flex: 1; padding: 10px; border-radius: 6px; border: none; background: #2a3942; color: #e9edef; }
  #composer button { padding: 10px 18px; border-radius: 6px; border: none; background: #00a884; color: white; cursor: pointer; }
  #currentJid { padding: 10px 16px; background: #202c33; font-weight: bold; border-bottom: 1px solid #111b21; }
  .empty { padding: 40px; text-align: center; color: #8696a0; }
</style>
</head>
<body>

<div id="keyBar">
  <input id="apiKeyInput" type="password" placeholder="Enter your API_KEY" />
  <button onclick="saveKey()">Save</button>
  <span id="keyStatus" style="font-size:12px;color:#8696a0;"></span>
</div>

<div id="layout">
  <div id="sidebar">
    <div id="tabs">
      <button id="chatsTab" class="active" onclick="switchTab('chats')">Chats</button>
      <button id="groupsTab" onclick="switchTab('groups')">Groups</button>
    </div>
    <div id="list"></div>
  </div>
  <div id="main">
    <div id="currentJid">Select a chat or group</div>
    <div id="messages"><div class="empty">No chat selected</div></div>
    <div id="composer">
      <input id="msgInput" placeholder="Type a message..." onkeydown="if(event.key==='Enter')sendMsg()" />
      <button onclick="sendMsg()">Send</button>
    </div>
  </div>
</div>

<script>
let apiKey = localStorage.getItem('wa_api_key') || '';
let currentTab = 'chats';
let currentJid = null;
document.getElementById('apiKeyInput').value = apiKey;
updateKeyStatus();

function updateKeyStatus() {
  document.getElementById('keyStatus').textContent = apiKey ? 'Key saved' : 'No key set';
}

function saveKey() {
  apiKey = document.getElementById('apiKeyInput').value.trim();
  localStorage.setItem('wa_api_key', apiKey);
  updateKeyStatus();
  loadList();
}

async function api(path, opts = {}) {
  opts.headers = Object.assign({}, opts.headers, { 'x-api-key': apiKey, 'Content-Type': 'application/json' });
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

function switchTab(tab) {
  currentTab = tab;
  document.getElementById('chatsTab').classList.toggle('active', tab === 'chats');
  document.getElementById('groupsTab').classList.toggle('active', tab === 'groups');
  loadList();
}

async function loadList() {
  const list = document.getElementById('list');
  if (!apiKey) { list.innerHTML = '<div class="empty">Enter your API key above first</div>'; return; }
  list.innerHTML = '<div class="empty">Loading...</div>';
  try {
    if (currentTab === 'chats') {
      const { chats } = await api('/chats');
      if (!chats.length) { list.innerHTML = '<div class="empty">No chats yet - send or receive a message first</div>'; return; }
      list.innerHTML = chats.map(c => \`
        <div class="chatItem" onclick="openChat('\${c._id}')">
          <div class="jid">\${c._id}</div>
          <div class="preview">\${(c.lastText || '[' + (c.lastType || 'media') + ']').slice(0,60)}</div>
        </div>\`).join('');
    } else {
      const { groups } = await api('/groups');
      if (!groups.length) { list.innerHTML = '<div class="empty">No groups found</div>'; return; }
      list.innerHTML = groups.map(g => \`
        <div class="chatItem" onclick="openChat('\${g.id}')">
          <div class="preview">\${g.subject}</div>
          <div class="jid">\${g.participants} participants</div>
        </div>\`).join('');
    }
  } catch (e) {
    list.innerHTML = '<div class="empty">Error: ' + e.message + '</div>';
  }
}

async function openChat(jid) {
  currentJid = jid;
  document.getElementById('currentJid').textContent = jid;
  await loadMessages();
}

async function loadMessages() {
  if (!currentJid) return;
  const box = document.getElementById('messages');
  box.innerHTML = '<div class="empty">Loading...</div>';
  try {
    const { messages } = await api('/messages?jid=' + encodeURIComponent(currentJid) + '&limit=50');
    if (!messages.length) { box.innerHTML = '<div class="empty">No messages yet</div>'; return; }
    box.innerHTML = messages.slice().reverse().map(m => \`
      <div class="msgWrap">
        <div class="msg \${m.fromMe ? 'out' : 'in'}">
          \${m.text ? m.text : '[' + m.type + ']' + (m.mediaBase64 ? ' (media stored)' : '')}
          <div class="msgTime">\${new Date(m.timestamp).toLocaleString()}</div>
        </div>
      </div>\`).join('');
    box.scrollTop = box.scrollHeight;
  } catch (e) {
    box.innerHTML = '<div class="empty">Error: ' + e.message + '</div>';
  }
}

async function sendMsg() {
  const input = document.getElementById('msgInput');
  const text = input.value.trim();
  if (!text || !currentJid) return;
  input.value = '';
  try {
    await api('/send', { method: 'POST', body: JSON.stringify({ jid: currentJid, text }) });
    setTimeout(loadMessages, 1500); // give the queue a moment before refreshing
  } catch (e) {
    alert('Send failed: ' + e.message);
  }
}

loadList();
setInterval(() => { if (currentJid) loadMessages(); }, 8000); // light auto-refresh
</script>
</body>
</html>`;
