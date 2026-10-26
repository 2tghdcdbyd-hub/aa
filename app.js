const $ = selector => document.querySelector(selector);
let account = null, conversations = [], active = null, source = null;
let generation = 0, syncRunning = false, syncAgain = false, sending = false;
let selectionVersion = 0, searchVersion = 0, pendingSend = null;
const histories = new Map();
const current = () => conversations.find(c => c.id === active);
const clock = value => new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
function element(tag, className, text) {
  const node = document.createElement(tag); if (className) node.className = className;
  if (text !== undefined) node.textContent = text; return node;
}
function avatar(node, name) { node.textContent = name?.slice(0, 1) || '☺'; node.style.background = '#e7efff'; }
function chatError(message = '') { $('#chat-error').textContent = message; $('#chat-error').hidden = !message; }
function connection(text) { $('#connection-status').textContent = text; }
function expireAccount() {
  clearAccount(); $('.shell').hidden = true; $('#auth-screen').hidden = false;
  setMode('login'); $('#auth-error').textContent = '로그인이 만료되었습니다. 다시 로그인해 주세요.';
}
async function chatRequest(path, data) {
  const requestGeneration = generation;
  let response;
  try { response = await fetch('/api/' + path, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }); }
  catch { throw Error('서버에 연결할 수 없습니다. 연결 상태를 확인해 주세요.'); }
  const result = await response.json();
  if (response.status === 401) { if (requestGeneration === generation) expireAccount(); throw Error('다시 로그인해 주세요.'); }
  if (!response.ok) throw Error(result.error || '요청을 처리할 수 없습니다.');
  return result;
}
function renderList() {
  const list = $('#contacts'); list.replaceChildren();
  const query = $('#search').value.toLowerCase();
  for (const c of conversations.filter(c => c.peer_name.toLowerCase().includes(query))) {
    const button = element('button', 'contact' + (c.id === active ? ' active' : ''));
    button.setAttribute('aria-pressed', String(c.id === active));
    const face = element('span', 'avatar'); avatar(face, c.peer_name);
    const body = element('div', 'contact-body'), top = element('div', 'contact-top');
    top.append(element('strong', '', c.peer_name), element('time', '', clock(c.last_at || c.created_at)));
    body.append(top, element('p', '', c.last_text || '첫 인사를 건네보세요 👋'));
    button.append(face, body); button.onclick = () => selectConversation(c.id);
    list.append(button);
  }
  if (!list.childElementCount) list.append(element('p', 'empty', conversations.length ? '검색 결과가 없어요.' : '아직 대화가 없어요.\n＋ 버튼으로 친구를 찾아보세요.'));
  $('.count').textContent = conversations.length;
}
function renderMessages({ bottom = false } = {}) {
  const log = $('#messages'), c = current(), history = histories.get(active);
  const previousHeight = log.scrollHeight, previousTop = log.scrollTop;
  const nearBottom = previousHeight - previousTop - log.clientHeight < 90;
  log.replaceChildren();
  if (!c) { log.append(element('p', 'welcome', '친구를 찾아 첫 대화를 시작해 보세요 👋')); return; }
  if (!history) { log.append(element('p', 'welcome', '대화를 불러오는 중…')); return; }
  if (history.hasMore) {
    const more = element('button', 'load-more', history.loading ? '불러오는 중…' : '이전 메시지 보기');
    more.disabled = !!history.loading; more.onclick = loadEarlier; log.append(more);
  }
  if (!history.messages.length) log.append(element('p', 'welcome', c.peer_name + '님에게 첫 인사를 보내보세요 👋'));
  let lastDate = '';
  for (const message of history.messages) {
    const date = new Date(message.created_at).toLocaleDateString('ko-KR');
    if (date !== lastDate) { log.append(element('div', 'date', date)); lastDate = date; }
    const own = message.sender_id === account.id, row = element('div', 'message' + (own ? ' own' : ''));
    if (!own) { const face = element('span', 'avatar'); avatar(face, c.peer_name); row.append(face); }
    const content = element('div', 'message-content');
    if (!own) content.append(element('div', 'sender', c.peer_name));
    content.append(element('div', 'bubble', message.text), element('time', '', clock(message.created_at)));
    row.dataset.messageId = message.id; row.append(content); log.append(row);
  }
  log.scrollTop = bottom || nearBottom ? log.scrollHeight : previousTop;
}
function renderHeader() {
  const c = current();
  $('#contact-name').textContent = c?.peer_name || '새로운 대화';
  $('#profile-name').textContent = c?.peer_name || 'Pingo';
  $('#profile-handle').textContent = c ? '대화 참여자' : '가까워지는 대화';
  $('#profile-about').textContent = c ? '두 사람만 참여하는 대화입니다. 기록은 서버에 저장되어 다시 로그인해도 이어집니다.' : '가입한 친구를 검색하고 대화를 시작하세요.';
  $('#contact-status').textContent = c ? '1:1 채팅' : '친구를 찾아보세요';
  avatar($('#header-avatar'), c?.peer_name); avatar($('#profile-avatar'), c?.peer_name);
  $('#message-input').disabled = !c; $('#send').disabled = !c || sending;
}
function mergeHistory(id, data) {
  const previous = histories.get(id);
  const merged = new Map((previous?.messages || []).map(m => [m.id, m]));
  for (const message of data.messages) merged.set(message.id, message);
  // If more than one page arrived while offline, reload from the latest page so no unseen gap is hidden.
  const gap = previous?.messages.length && data.hasMore && data.messages.length && data.messages[0].id > previous.messages.at(-1).id;
  histories.set(id, { messages: gap ? data.messages : [...merged.values()].sort((a, b) => a.id - b.id), hasMore: gap || !previous?.messages.length ? data.hasMore : previous.hasMore, loading: false });
}
async function refreshConversation(id, epoch, { bottom = false } = {}) {
  const result = await chatRequest(`conversations/${id}/messages`);
  if (epoch !== generation || !account) return;
  mergeHistory(id, result);
  if (active === id) renderMessages({ bottom });
}
async function synchronize() {
  if (!account) return;
  if (syncRunning) { syncAgain = true; return; }
  const epoch = generation; syncRunning = true;
  try {
    do {
      syncAgain = false;
      const result = await chatRequest('conversations');
      if (epoch !== generation || !account) return;
      conversations = result.conversations;
      if (!conversations.some(c => c.id === active)) active = conversations[0]?.id || null;
      renderList(); renderHeader();
      if (active) await refreshConversation(active, epoch);
      else renderMessages();
      if (epoch !== generation) return;
      chatError(); $('#retry-sync').hidden = true;
    } while (syncAgain);
  } catch (error) {
    if (epoch === generation && account) { chatError(error.message); $('#retry-sync').hidden = false; }
  } finally { if (epoch === generation) syncRunning = false; }
}
async function selectConversation(id) {
  const version = ++selectionVersion, epoch = generation;
  if (active !== id) { $('#message-input').value = ''; pendingSend = null; }
  active = id; renderList(); renderHeader(); renderMessages({ bottom: true });
  $('.shell').classList.add('chat-open');
  try { await refreshConversation(id, epoch, { bottom: true }); if (version === selectionVersion) chatError(); }
  catch (error) { if (epoch === generation && version === selectionVersion) chatError(error.message); }
}
async function loadEarlier() {
  const id = active, epoch = generation, history = histories.get(id);
  if (!history?.hasMore || history.loading) return;
  history.loading = true; renderMessages();
  const top = $('#messages').scrollTop, height = $('#messages').scrollHeight;
  try {
    const result = await chatRequest(`conversations/${id}/messages?before=${history.messages[0].id}`);
    if (epoch !== generation) return;
    const merged = new Map(histories.get(id).messages.map(m => [m.id, m]));
    for (const m of result.messages) merged.set(m.id, m);
    histories.set(id, { messages: [...merged.values()].sort((a, b) => a.id - b.id), hasMore: result.hasMore, loading: false });
    if (active === id) { renderMessages(); $('#messages').scrollTop = top + $('#messages').scrollHeight - height; }
  } catch (error) { if (epoch === generation) { history.loading = false; chatError(error.message); if (active === id) renderMessages(); } }
}
function connectEvents() {
  source?.close(); const epoch = generation;
  source = new EventSource('/api/events');
  source.onopen = () => { if (epoch === generation) connection('실시간 연결됨'); };
  source.addEventListener('sync', () => { if (epoch === generation) synchronize(); });
  source.addEventListener('expired', () => { if (epoch === generation) expireAccount(); });
  source.onerror = async () => {
    if (epoch !== generation || !account) return;
    connection('재연결 중…');
    try { await chatRequest('me'); } catch { /* Expired sessions return to login; EventSource retries network errors. */ }
  };
}
function loadAccount(user) {
  clearAccount(); account = user;
  $('#my-avatar').textContent = user.name.slice(0, 1); $('#my-avatar').title = user.name + ' · ' + user.email;
  $('#search').value = ''; $('#friend-name').value = ''; $('#friend-results').replaceChildren();
  renderList(); renderHeader(); renderMessages(); connection('연결 중…');
  connectEvents(); synchronize();
}
function clearAccount() {
  generation++; selectionVersion++; searchVersion++; source?.close(); source = null;
  account = null; conversations = []; active = null; histories.clear();
  syncRunning = false; syncAgain = false; sending = false; pendingSend = null;
  $('#message-input').value = ''; $('#messages').replaceChildren(); $('#contacts').replaceChildren();
  $('#friend-results').replaceChildren(); $('#friend-error').textContent = ''; $('#emoji-picker').hidden = true;
  $('#retry-sync').hidden = true; chatError(); $('.shell').classList.remove('chat-open');
  if ($('#new-dialog').open) $('#new-dialog').close();
}
$('#composer').onsubmit = async event => {
  event.preventDefault(); if (!account || !active || sending) return;
  const input = $('#message-input'), text = input.value.trim(), id = active, epoch = generation;
  if (!text) return;
  if (!pendingSend || pendingSend.id !== id || pendingSend.text !== text) pendingSend = { id, text, clientId: crypto.randomUUID() };
  sending = true; renderHeader(); chatError();
  try {
    const { message } = await chatRequest(`conversations/${id}/messages`, { text, clientId: pendingSend.clientId });
    if (epoch !== generation) return;
    const history = histories.get(id);
    if (history) { const merged = new Map(history.messages.map(m => [m.id, m])); merged.set(message.id, message); history.messages = [...merged.values()].sort((a, b) => a.id - b.id); }
    if (active === id) { if (input.value.trim() === text) { input.value = ''; input.style.height = ''; } renderMessages({ bottom: true }); }
    pendingSend = null; synchronize();
  } catch (error) { if (epoch === generation) chatError(error.message + ' 입력한 메시지는 유지됩니다.'); }
  finally { if (epoch === generation) { sending = false; renderHeader(); } }
};
$('#message-input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#composer').requestSubmit(); } };
$('#message-input').oninput = event => { event.target.style.height = 'auto'; event.target.style.height = Math.min(event.target.scrollHeight, 140) + 'px'; };
$('#search').oninput = renderList;
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); $('#search').focus(); } });
document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => {
  if (button.dataset.tab === 'friends') { $('#new-dialog').showModal(); return; }
  $('#search').value = ''; renderList();
});
$('#back').onclick = () => $('.shell').classList.remove('chat-open');
$('.new-chat').onclick = () => { $('#new-dialog').showModal(); $('#friend-name').focus(); };
$('#retry-sync').onclick = () => { connectEvents(); synchronize(); };
$('#new-dialog').addEventListener('close', () => { searchVersion++; });
$('#add-friend').onsubmit = async event => {
  event.preventDefault(); const epoch = generation, version = ++searchVersion;
  $('#friend-results').replaceChildren(); $('#friend-error').textContent = '친구를 찾는 중…';
  try {
    const { users } = await chatRequest('users?q=' + encodeURIComponent($('#friend-name').value.trim()));
    if (epoch !== generation || version !== searchVersion) return;
    $('#friend-error').textContent = users.length ? '대화할 친구를 선택하세요.' : '가입한 친구를 찾지 못했어요. 이름 또는 정확한 이메일을 확인해 주세요.';
    for (const user of users) {
      const button = element('button', 'friend-result', user.name + ' · 대화 시작 ↗');
      button.onclick = async () => {
        button.disabled = true;
        try {
          const { conversation } = await chatRequest('conversations', { userId: user.id });
          if (epoch !== generation) return;
          const { conversations: list } = await chatRequest('conversations');
          if (epoch !== generation) return;
          conversations = list; $('#new-dialog').close(); selectConversation(conversation.id);
        } catch (error) { if (epoch === generation) { $('#friend-error').textContent = error.message; button.disabled = false; } }
      };
      $('#friend-results').append(button);
    }
  } catch (error) { if (epoch === generation && version === searchVersion) $('#friend-error').textContent = error.message; }
};
for (const emoji of ['😊', '💙', '✨', '👋', '😂', '☕', '🌿', '🎉']) {
  const button = element('button', '', emoji); button.type = 'button'; button.setAttribute('aria-label', emoji + ' 삽입');
  button.onclick = () => { const input = $('#message-input'); if (input.disabled || input.value.length + emoji.length > 2000) return; input.setRangeText(emoji, input.selectionStart, input.selectionEnd, 'end'); input.focus(); $('#emoji-picker').hidden = true; };
  $('#emoji-picker').append(button);
}
$('#emoji-button').onclick = () => { if (active) $('#emoji-picker').hidden = !$('#emoji-picker').hidden; };
window.addEventListener('online', () => { if (account) { connectEvents(); synchronize(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden && account) synchronize(); });
