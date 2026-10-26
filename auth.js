let authMode = 'login';
let authBusy = true;
function setMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  $('#name-field').hidden = !signup;
  $('#confirm-field').hidden = !signup;
  $('#auth-name').required = signup;
  $('#auth-confirm').required = signup;
  $('#auth-password').autocomplete = signup ? 'new-password' : 'current-password';
  $('#login-tab').setAttribute('aria-pressed', String(!signup));
  $('#signup-tab').setAttribute('aria-pressed', String(signup));
  $('#auth-title').textContent = signup ? '우리, 여기서 시작해요' : '다시 만나서 반가워요';
  $('#auth-description').textContent = signup ? '나만의 계정을 만들고 첫 인사를 나눠보세요.' : '로그인하고 이야기를 이어가세요.';
  $('#auth-submit').textContent = signup ? '가입하고 시작하기 ↗' : '로그인 ↗';
  $('#auth-error').textContent = '';
  $('#auth-password').value = '';
  $('#auth-confirm').value = '';
}
function busy(value) {
  authBusy = value;
  for (const el of document.querySelectorAll('#auth-form input, #auth-form button, .auth-tabs button')) el.disabled = value;
}
async function api(path, data) {
  let response;
  try { response = await fetch('/api/' + path, { method: data ? 'POST' : 'GET', headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined, credentials: 'same-origin' }); }
  catch { throw Error('서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.'); }
  const result = await response.json();
  if (!response.ok) throw Error(result.error || '요청을 처리할 수 없습니다.');
  return result;
}
function showUser(user) {
  loadAccount(user);
  $('#auth-form').reset();
  $('#auth-screen').hidden = true;
  $('.shell').hidden = false;
}
$('#login-tab').onclick = () => { if (!authBusy) setMode('login'); };
$('#signup-tab').onclick = () => { if (!authBusy) setMode('signup'); };
$('#toggle-password').onclick = () => {
  const visible = $('#auth-password').type === 'password';
  $('#auth-password').type = visible ? 'text' : 'password';
  $('#toggle-password').textContent = visible ? '숨기기' : '보기';
  $('#toggle-password').setAttribute('aria-pressed', String(visible));
  $('#toggle-password').setAttribute('aria-label', visible ? '비밀번호 숨기기' : '비밀번호 표시');
};
$('#auth-form').onsubmit = async event => {
  event.preventDefault(); if (authBusy) return;
  $('#auth-error').textContent = '';
  if (authMode === 'signup' && $('#auth-password').value !== $('#auth-confirm').value) { $('#auth-error').textContent = '비밀번호가 일치하지 않습니다.'; return; }
  const data = { email: $('#auth-email').value, password: $('#auth-password').value, name: $('#auth-name').value };
  busy(true); $('#auth-submit').textContent = '잠시만 기다려 주세요…';
  try { const result = await api(authMode, data); showUser(result.user); if(result.recoveryCode) showRecoveryCode(result.recoveryCode); }
  catch (error) { $('#auth-error').textContent = error.message; }
  finally { busy(false); $('#auth-submit').textContent = authMode === 'signup' ? '가입하고 시작하기 ↗' : '로그인 ↗'; }
};
$('#logout').onclick = async () => {
  $('#logout').disabled = true;
  try {
    await api('logout', {});
    clearAccount(); $('.shell').hidden = true; $('#auth-screen').hidden = false;
    setMode('login'); $('#auth-form').reset(); $('#auth-email').focus();
  } catch (error) { alert(error.message); }
  finally { $('#logout').disabled = false; }
};
(async () => {
  busy(true);
  try { const response = await fetch('/api/me', { credentials: 'same-origin' }); if (response.ok) showUser((await response.json()).user); else if (response.status !== 401) throw Error(); }
  catch { $('#auth-error').textContent = '로그인 상태를 확인하지 못했습니다. 다시 로그인해 주세요.'; }
  finally { busy(false); $('#auth-submit').textContent = '로그인 ↗'; }
})();

function showRecoveryCode(code){
  $('#recovery-code-value').textContent=code; $('#recovery-copy-status').textContent='';
  $('#recovery-code-dialog').showModal();
}
$('#close-recovery-code').onclick=()=>$('#recovery-code-dialog').close();
$('#recovery-code-dialog').addEventListener('close',()=>{$('#recovery-code-value').textContent='';});
$('#copy-recovery-code').onclick=async()=>{try{await navigator.clipboard.writeText($('#recovery-code-value').textContent);$('#recovery-copy-status').textContent='복사했습니다. 안전한 곳에 저장하세요.';}catch{$('#recovery-copy-status').textContent='자동 복사가 불가능합니다. 코드를 선택해서 직접 복사해 주세요.';}};
$('#forgot-password').onclick=()=>{if(authBusy)return;$('#recover-form').reset();$('#recover-error').textContent='';$('#recover-dialog').showModal();};
$('#recover-form').onsubmit=async event=>{
  event.preventDefault();const form=event.currentTarget,button=form.querySelector('button'),data=Object.fromEntries(new FormData(form));
  if(data.password!==data.confirm){$('#recover-error').textContent='비밀번호가 일치하지 않습니다.';return;}
  button.disabled=true;$('#recover-error').textContent='';
  try{await api('recover',data);$('#recover-dialog').close();form.reset();setMode('login');$('#auth-email').value=data.email;$('#auth-error').textContent='비밀번호를 변경했습니다. 모든 기기에서 로그아웃되었습니다. 새 비밀번호로 로그인하고 복구 코드를 다시 발급하세요.';}
  catch(error){$('#recover-error').textContent=error.message;}finally{button.disabled=false;}
};

$('#recover-dialog').addEventListener('close',()=>$('#recover-form').reset());
